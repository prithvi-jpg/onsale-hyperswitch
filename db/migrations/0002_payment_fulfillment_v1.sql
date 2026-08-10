-- ONSALE durable payment and fulfillment V1.
--
-- This is an additive, schema-qualified migration. It stores normalized facts
-- only. Provider checkout mount material and provider response documents stay
-- outside durable storage.

do $preflight_no_legacy_fulfilled_orders$
begin
  lock table __ONSALE_SCHEMA__.orders in share row exclusive mode;

  if exists (
    select 1
    from __ONSALE_SCHEMA__.orders
    where state = 'fulfilled'
  ) then
    raise exception 'cannot establish payment proof for a pre-existing fulfilled order'
      using errcode = '55000';
  end if;
end;
$preflight_no_legacy_fulfilled_orders$;

alter table __ONSALE_SCHEMA__.order_item
  add constraint order_item_identity_order_seat_unique
  unique (id, order_id, seat_id);

create table __ONSALE_SCHEMA__.provider_payment (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  order_id uuid not null,
  provider text not null check (provider = 'hyperswitch'),
  environment text not null check (environment = 'sandbox'),
  api_version text not null check (api_version = 'v1'),
  provider_payment_ref text not null
    check (provider_payment_ref ~ '^pay_[0-9a-f]{26}$'),
  create_state text not null check (
    create_state in ('allocated', 'reconcile_required', 'created', 'rejected')
  ),
  canonical_state text not null check (
    canonical_state in (
      'not_created', 'requires_payment_method', 'requires_customer_action',
      'processing', 'unknown', 'failed', 'succeeded'
    )
  ),
  integrity_state text not null default 'clear' check (
    integrity_state in ('clear', 'review_required')
  ),
  amount_minor bigint not null
    check (amount_minor between 1 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  successful_attempt_id uuid,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  failed_at timestamptz,
  succeeded_at timestamptz,
  constraint provider_payment_order_unique unique (order_id),
  constraint provider_payment_provider_ref_unique
    unique (provider, environment, provider_payment_ref),
  constraint provider_payment_identity_order_unique unique (id, order_id),
  foreign key (order_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.orders (id, event_id, dataset_id),
  check (updated_at >= created_at),
  check (
    (
      canonical_state = 'succeeded'
      and successful_attempt_id is not null
      and succeeded_at is not null
      and failed_at is null
    )
    or (
      canonical_state = 'failed'
      and successful_attempt_id is null
      and failed_at is not null
      and succeeded_at is null
    )
    or (
      canonical_state not in ('failed', 'succeeded')
      and successful_attempt_id is null
      and failed_at is null
      and succeeded_at is null
    )
  )
);

create index provider_payment_dataset_id_idx
  on __ONSALE_SCHEMA__.provider_payment (dataset_id);
create index provider_payment_event_state_idx
  on __ONSALE_SCHEMA__.provider_payment (event_id, canonical_state);

create or replace function __ONSALE_SCHEMA__.validate_provider_payment_insert()
returns trigger
language plpgsql
as $$
declare
  locked_order __ONSALE_SCHEMA__.orders%rowtype;
begin
  select * into locked_order
  from __ONSALE_SCHEMA__.orders
  where id = new.order_id
  for update;

  if not found then
    raise exception 'provider payment order does not exist'
      using errcode = '23503';
  end if;

  if locked_order.state <> 'awaiting_payment' then
    raise exception 'provider payment requires an awaiting-payment order'
      using errcode = '55000';
  end if;

  if new.dataset_id is distinct from locked_order.dataset_id
     or new.event_id is distinct from locked_order.event_id
     or new.amount_minor is distinct from locked_order.total_minor
     or new.currency is distinct from locked_order.currency then
    raise exception 'provider payment must match the immutable order header'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger provider_payment_validate_before_insert
before insert on __ONSALE_SCHEMA__.provider_payment
for each row execute function __ONSALE_SCHEMA__.validate_provider_payment_insert();

create or replace function __ONSALE_SCHEMA__.guard_order_payment_transition()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.dataset_id is distinct from old.dataset_id
     or new.event_id is distinct from old.event_id
     or new.hold_id is distinct from old.hold_id
     or new.sale_window_id is distinct from old.sale_window_id
     or new.buyer_ref is distinct from old.buyer_ref
     or new.currency is distinct from old.currency
     or new.subtotal_minor is distinct from old.subtotal_minor
     or new.fee_minor is distinct from old.fee_minor
     or new.tax_minor is distinct from old.tax_minor
     or new.total_minor is distinct from old.total_minor
     or new.payment_deadline_at is distinct from old.payment_deadline_at
     or new.created_at is distinct from old.created_at then
    raise exception 'order identity and immutable header cannot change'
      using errcode = '55000';
  end if;

  if new.version < old.version then
    raise exception 'order version cannot decrease'
      using errcode = '55000';
  end if;

  if new.state is distinct from old.state
     and new.version <= old.version then
    raise exception 'an order state transition must advance its version'
      using errcode = '55000';
  end if;

  if new.canceled_at is distinct from old.canceled_at
     and not (
       old.state = 'awaiting_payment'
       and new.state = 'canceled'
       and old.canceled_at is null
       and new.canceled_at is not null
     ) then
    raise exception 'order cancellation proof is immutable'
      using errcode = '55000';
  end if;

  if old.state in ('canceled', 'fulfilled')
     and new is distinct from old then
    raise exception 'terminal order fulfillment is immutable'
      using errcode = '55000';
  end if;

  if new.state is distinct from old.state
     and not (
       (old.state = 'awaiting_payment' and new.state = 'payment_pending')
       or (old.state = 'awaiting_payment' and new.state = 'canceled')
       or (old.state = 'payment_pending' and new.state = 'paid')
       or (old.state = 'paid' and new.state = 'fulfilled')
     ) then
    raise exception 'order state transition is not a permitted forward edge'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger order_payment_transition_guard
before update on __ONSALE_SCHEMA__.orders
for each row execute function __ONSALE_SCHEMA__.guard_order_payment_transition();

create or replace function __ONSALE_SCHEMA__.guard_order_cancellation_after_payment()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'canceled'
     and old.state <> 'canceled'
     and exists (
       select 1
       from __ONSALE_SCHEMA__.provider_payment
       where order_id = old.id
     ) then
    raise exception 'an order with a payment identity cannot be canceled'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger order_cancellation_after_payment_guard
before update on __ONSALE_SCHEMA__.orders
for each row execute function __ONSALE_SCHEMA__.guard_order_cancellation_after_payment();

create table __ONSALE_SCHEMA__.checkout_operation (
  id uuid primary key,
  operation_key uuid not null unique,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  command_kind text not null check (
    command_kind in ('ensure_checkout', 'reconcile_payment')
  ),
  order_id uuid not null,
  payment_id uuid not null,
  state text not null check (state in ('started', 'completed', 'rejected')),
  outcome_code text check (
    outcome_code is null
    or outcome_code ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint checkout_operation_identity_payment_unique unique (id, payment_id),
  foreign key (payment_id, order_id)
    references __ONSALE_SCHEMA__.provider_payment (id, order_id),
  check (
    (state = 'started' and outcome_code is null and completed_at is null)
    or (
      state in ('completed', 'rejected')
      and outcome_code is not null
      and completed_at is not null
      and completed_at >= created_at
    )
  )
);

create index checkout_operation_order_created_idx
  on __ONSALE_SCHEMA__.checkout_operation (order_id, created_at);
create index checkout_operation_payment_state_idx
  on __ONSALE_SCHEMA__.checkout_operation (payment_id, state);

create table __ONSALE_SCHEMA__.payment_observation (
  id uuid primary key,
  public_ref uuid not null unique,
  payment_id uuid not null,
  checkout_operation_id uuid,
  source text not null check (
    source in ('create_response', 'retrieve_response', 'verified_webhook')
  ),
  source_event_ref_digest text check (
    source_event_ref_digest is null
    or source_event_ref_digest ~ '^[0-9a-f]{64}$'
  ),
  provider_status text not null check (
    char_length(provider_status) between 1 and 80
    and provider_status !~ '[[:cntrl:]]'
  ),
  canonical_state text not null check (
    canonical_state in (
      'requires_payment_method', 'requires_customer_action', 'processing',
      'unknown', 'failed', 'succeeded'
    )
  ),
  selected_payment_method text check (
    selected_payment_method is null
    or selected_payment_method ~ '^[a-z0-9_:-]{1,80}$'
  ),
  observed_connector text check (
    observed_connector is null
    or observed_connector ~ '^[a-z0-9_:-]{1,80}$'
  ),
  observed_amount_minor bigint check (
    observed_amount_minor is null
    or observed_amount_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()
  ),
  observed_currency text check (
    observed_currency is null or observed_currency ~ '^[A-Z]{3}$'
  ),
  charged_attempt_count integer not null check (charged_attempt_count >= 0),
  error_kind text check (
    error_kind is null
    or error_kind in (
      'payment_method', 'technical', 'configuration', 'integration', 'unknown'
    )
  ),
  error_code text check (
    error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  unified_error_code text check (
    unified_error_code is null
    or unified_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  evidence_class text not null check (
    evidence_class in ('live_sandbox', 'runtime_observation')
  ),
  observed_at timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  constraint payment_observation_identity_payment_unique unique (id, payment_id),
  foreign key (payment_id) references __ONSALE_SCHEMA__.provider_payment (id),
  foreign key (checkout_operation_id, payment_id)
    references __ONSALE_SCHEMA__.checkout_operation (id, payment_id),
  check (
    (
      source in ('create_response', 'retrieve_response')
      and checkout_operation_id is not null
      and source_event_ref_digest is null
    )
    or (
      source = 'verified_webhook'
      and checkout_operation_id is null
      and source_event_ref_digest is not null
    )
  )
);

create unique index payment_observation_operation_unique
  on __ONSALE_SCHEMA__.payment_observation (checkout_operation_id)
  where checkout_operation_id is not null;
create unique index payment_observation_verified_event_unique
  on __ONSALE_SCHEMA__.payment_observation (source, source_event_ref_digest)
  where source_event_ref_digest is not null;
create index payment_observation_payment_received_idx
  on __ONSALE_SCHEMA__.payment_observation (payment_id, received_at, id);

create table __ONSALE_SCHEMA__.payment_attempt (
  id uuid primary key,
  payment_id uuid not null,
  provider_attempt_ref_digest text not null
    check (provider_attempt_ref_digest ~ '^[0-9a-f]{64}$'),
  canonical_state text not null check (
    canonical_state in (
      'requires_payment_method', 'requires_action', 'processing',
      'hard_decline', 'technical_failure', 'unknown', 'succeeded'
    )
  ),
  observed_connector text check (
    observed_connector is null
    or observed_connector ~ '^[a-z0-9_:-]{1,80}$'
  ),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  terminal_at timestamptz,
  constraint payment_attempt_identity_payment_unique unique (id, payment_id),
  unique (payment_id, provider_attempt_ref_digest),
  foreign key (payment_id) references __ONSALE_SCHEMA__.provider_payment (id),
  check (last_observed_at >= first_observed_at),
  check (
    (
      canonical_state in ('hard_decline', 'technical_failure', 'succeeded')
      and terminal_at is not null
    )
    or (
      canonical_state not in ('hard_decline', 'technical_failure', 'succeeded')
      and terminal_at is null
    )
  )
);

create index payment_attempt_payment_state_idx
  on __ONSALE_SCHEMA__.payment_attempt (payment_id, canonical_state);

alter table __ONSALE_SCHEMA__.provider_payment
  add constraint provider_payment_successful_attempt_fk
  foreign key (successful_attempt_id, id)
    references __ONSALE_SCHEMA__.payment_attempt (id, payment_id)
  deferrable initially deferred;

create table __ONSALE_SCHEMA__.payment_attempt_observation (
  payment_observation_id uuid not null,
  payment_attempt_id uuid not null,
  payment_id uuid not null,
  attempt_ordinal integer not null check (attempt_ordinal > 0),
  canonical_state text not null check (
    canonical_state in (
      'requires_payment_method', 'requires_action', 'processing',
      'hard_decline', 'technical_failure', 'unknown', 'succeeded'
    )
  ),
  observed_connector text check (
    observed_connector is null
    or observed_connector ~ '^[a-z0-9_:-]{1,80}$'
  ),
  error_kind text check (
    error_kind is null
    or error_kind in (
      'payment_method', 'technical', 'configuration', 'integration', 'unknown'
    )
  ),
  error_code text check (
    error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  unified_error_code text check (
    unified_error_code is null
    or unified_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'
  ),
  primary key (payment_observation_id, payment_attempt_id),
  unique (payment_observation_id, attempt_ordinal),
  foreign key (payment_observation_id, payment_id)
    references __ONSALE_SCHEMA__.payment_observation (id, payment_id),
  foreign key (payment_attempt_id, payment_id)
    references __ONSALE_SCHEMA__.payment_attempt (id, payment_id)
);

create index payment_attempt_observation_attempt_idx
  on __ONSALE_SCHEMA__.payment_attempt_observation (payment_attempt_id);

create table __ONSALE_SCHEMA__.fulfillment_bundle (
  id uuid primary key,
  order_id uuid not null,
  payment_id uuid not null,
  state text not null check (state = 'issued'),
  issued_at timestamptz not null default clock_timestamp(),
  constraint fulfillment_bundle_order_unique unique (order_id),
  constraint fulfillment_bundle_payment_unique unique (payment_id),
  constraint fulfillment_bundle_identity_order_unique unique (id, order_id),
  foreign key (order_id) references __ONSALE_SCHEMA__.orders (id),
  foreign key (payment_id, order_id)
    references __ONSALE_SCHEMA__.provider_payment (id, order_id)
);

create table __ONSALE_SCHEMA__.ticket (
  id uuid primary key,
  fulfillment_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  seat_id uuid not null,
  state text not null check (state = 'issued'),
  issued_at timestamptz not null default clock_timestamp(),
  constraint ticket_order_item_unique unique (order_item_id),
  constraint ticket_order_seat_unique unique (order_id, seat_id),
  foreign key (fulfillment_id, order_id)
    references __ONSALE_SCHEMA__.fulfillment_bundle (id, order_id),
  foreign key (order_item_id, order_id, seat_id)
    references __ONSALE_SCHEMA__.order_item (id, order_id, seat_id)
);

create index ticket_fulfillment_id_idx
  on __ONSALE_SCHEMA__.ticket (fulfillment_id);

create or replace function __ONSALE_SCHEMA__.guard_provider_payment_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.dataset_id is distinct from old.dataset_id
     or new.event_id is distinct from old.event_id
     or new.order_id is distinct from old.order_id
     or new.provider is distinct from old.provider
     or new.environment is distinct from old.environment
     or new.api_version is distinct from old.api_version
     or new.provider_payment_ref is distinct from old.provider_payment_ref
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.created_at is distinct from old.created_at then
    raise exception 'provider payment identity and money are immutable'
      using errcode = '55000';
  end if;

  if old.canonical_state in ('failed', 'succeeded')
     and new.canonical_state <> old.canonical_state then
    raise exception 'terminal provider payment state cannot regress'
      using errcode = '55000';
  end if;

  if old.canonical_state in ('failed', 'succeeded')
     and (
       new.successful_attempt_id is distinct from old.successful_attempt_id
       or new.failed_at is distinct from old.failed_at
       or new.succeeded_at is distinct from old.succeeded_at
     ) then
    raise exception 'terminal provider payment proof is immutable'
      using errcode = '55000';
  end if;

  if old.create_state in ('created', 'rejected')
     and new.create_state <> old.create_state then
    raise exception 'terminal provider create state cannot regress'
      using errcode = '55000';
  end if;

  if old.integrity_state = 'review_required'
     and new.integrity_state <> 'review_required' then
    raise exception 'payment integrity review is monotonic'
      using errcode = '55000';
  end if;

  if new.updated_at < old.updated_at then
    raise exception 'provider payment update time cannot decrease'
      using errcode = '55000';
  end if;

  if new is distinct from old
     and new.version <= old.version then
    raise exception 'provider payment mutation must advance its version'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger provider_payment_guard_before_update
before update on __ONSALE_SCHEMA__.provider_payment
for each row execute function __ONSALE_SCHEMA__.guard_provider_payment_mutation();

create or replace function __ONSALE_SCHEMA__.guard_checkout_operation_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.operation_key is distinct from old.operation_key
     or new.request_hash is distinct from old.request_hash
     or new.command_kind is distinct from old.command_kind
     or new.order_id is distinct from old.order_id
     or new.payment_id is distinct from old.payment_id
     or new.created_at is distinct from old.created_at then
    raise exception 'checkout operation identity is immutable'
      using errcode = '55000';
  end if;

  if old.state in ('completed', 'rejected') and new is distinct from old then
    raise exception 'terminal checkout operation is immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger checkout_operation_guard_before_update
before update on __ONSALE_SCHEMA__.checkout_operation
for each row execute function __ONSALE_SCHEMA__.guard_checkout_operation_mutation();

create or replace function __ONSALE_SCHEMA__.reject_payment_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'normalized payment observations are append-only'
    using errcode = '55000';
end;
$$;

create trigger payment_observation_append_only_before_update_or_delete
before update or delete on __ONSALE_SCHEMA__.payment_observation
for each row execute function __ONSALE_SCHEMA__.reject_payment_append_only_mutation();

create trigger payment_attempt_observation_append_only_before_update_or_delete
before update or delete on __ONSALE_SCHEMA__.payment_attempt_observation
for each row execute function __ONSALE_SCHEMA__.reject_payment_append_only_mutation();

create or replace function __ONSALE_SCHEMA__.guard_payment_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.payment_id is distinct from old.payment_id
     or new.provider_attempt_ref_digest is distinct from old.provider_attempt_ref_digest
     or new.first_observed_at is distinct from old.first_observed_at then
    raise exception 'payment attempt identity is immutable'
      using errcode = '55000';
  end if;

  if old.canonical_state in ('hard_decline', 'technical_failure', 'succeeded')
     and new.canonical_state <> old.canonical_state then
    raise exception 'terminal payment attempt state cannot regress'
      using errcode = '55000';
  end if;

  if new.last_observed_at < old.last_observed_at then
    raise exception 'payment attempt observation time cannot decrease'
      using errcode = '55000';
  end if;

  if old.canonical_state in ('hard_decline', 'technical_failure', 'succeeded')
     and (
       new.observed_connector is distinct from old.observed_connector
       or new.terminal_at is distinct from old.terminal_at
     ) then
    raise exception 'terminal payment attempt proof is immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger payment_attempt_guard_before_update
before update on __ONSALE_SCHEMA__.payment_attempt
for each row execute function __ONSALE_SCHEMA__.guard_payment_attempt_mutation();

create or replace function __ONSALE_SCHEMA__.reject_payment_core_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'payment identities, operations, and attempts cannot be deleted'
    using errcode = '55000';
end;
$$;

create trigger provider_payment_delete_guard
before delete on __ONSALE_SCHEMA__.provider_payment
for each row execute function __ONSALE_SCHEMA__.reject_payment_core_delete();

create trigger checkout_operation_delete_guard
before delete on __ONSALE_SCHEMA__.checkout_operation
for each row execute function __ONSALE_SCHEMA__.reject_payment_core_delete();

create trigger payment_attempt_delete_guard
before delete on __ONSALE_SCHEMA__.payment_attempt
for each row execute function __ONSALE_SCHEMA__.reject_payment_core_delete();

create or replace function __ONSALE_SCHEMA__.reject_issued_artifact_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'issued fulfillment artifacts are immutable'
    using errcode = '55000';
end;
$$;

create trigger fulfillment_bundle_immutable_before_update_or_delete
before update or delete on __ONSALE_SCHEMA__.fulfillment_bundle
for each row execute function __ONSALE_SCHEMA__.reject_issued_artifact_mutation();

create trigger ticket_immutable_before_update_or_delete
before update or delete on __ONSALE_SCHEMA__.ticket
for each row execute function __ONSALE_SCHEMA__.reject_issued_artifact_mutation();

create or replace function __ONSALE_SCHEMA__.guard_issued_seat_allocation_mutation()
returns trigger
language plpgsql
as $$
declare
  old_order_id uuid;
  new_order_id uuid;
  checked_order_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_order_id := old.order_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    new_order_id := new.order_id;
  end if;

  for checked_order_id in
    select distinct candidate_order_id
    from unnest(array[old_order_id, new_order_id])
      as candidate_orders(candidate_order_id)
    where candidate_order_id is not null
    order by candidate_order_id
  loop
    perform 1
    from __ONSALE_SCHEMA__.orders
    where id = checked_order_id
    for update;

    if not found then
      raise exception 'seat allocation order does not exist'
        using errcode = '23503';
    end if;
  end loop;

  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;

  if exists (
    select 1
    from __ONSALE_SCHEMA__.fulfillment_bundle
    where order_id = old_order_id or order_id = new_order_id
  ) then
    raise exception 'issued fulfillment seat allocations are immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger issued_seat_allocation_mutation_guard
before insert or update or delete on __ONSALE_SCHEMA__.seat_allocation
for each row execute function __ONSALE_SCHEMA__.guard_issued_seat_allocation_mutation();

create or replace function __ONSALE_SCHEMA__.assert_fulfillment_bundle_complete(
  checked_fulfillment_id uuid
) returns void
language plpgsql
as $$
declare
  checked_order_id uuid;
  checked_payment_id uuid;
  order_state text;
  order_total bigint;
  order_currency text;
  payment_state text;
  payment_integrity_state text;
  payment_total bigint;
  payment_currency text;
  successful_attempt_id uuid;
  item_count bigint;
  reserved_allocation_count bigint;
  covered_allocation_count bigint;
  ticket_count bigint;
  succeeded_attempt_count bigint;
begin
  select order_id, payment_id
  into checked_order_id, checked_payment_id
  from __ONSALE_SCHEMA__.fulfillment_bundle
  where id = checked_fulfillment_id;

  if not found then
    return;
  end if;

  select state, total_minor, currency
  into strict order_state, order_total, order_currency
  from __ONSALE_SCHEMA__.orders
  where id = checked_order_id;

  select pp.canonical_state, pp.integrity_state, pp.amount_minor, pp.currency,
         pp.successful_attempt_id
  into strict payment_state, payment_integrity_state, payment_total,
              payment_currency, successful_attempt_id
  from __ONSALE_SCHEMA__.provider_payment as pp
  where pp.id = checked_payment_id and pp.order_id = checked_order_id;

  select count(*) into item_count
  from __ONSALE_SCHEMA__.order_item
  where order_id = checked_order_id;

  select count(*) into reserved_allocation_count
  from __ONSALE_SCHEMA__.seat_allocation
  where order_id = checked_order_id
    and state = 'reserved';

  select count(*) into covered_allocation_count
  from __ONSALE_SCHEMA__.order_item as oi
  join __ONSALE_SCHEMA__.seat_allocation as sa
    on sa.id = oi.seat_allocation_id
   and sa.order_id = oi.order_id
   and sa.seat_id = oi.seat_id
   and sa.event_id = oi.event_id
   and sa.dataset_id = oi.dataset_id
  where oi.order_id = checked_order_id
    and sa.state = 'reserved';

  select count(*) into ticket_count
  from __ONSALE_SCHEMA__.ticket
  where fulfillment_id = checked_fulfillment_id
    and order_id = checked_order_id;

  select count(*) into succeeded_attempt_count
  from __ONSALE_SCHEMA__.payment_attempt
  where payment_id = checked_payment_id
    and canonical_state = 'succeeded';

  if order_state <> 'fulfilled'
     or payment_state <> 'succeeded'
     or payment_integrity_state <> 'clear'
     or successful_attempt_id is null
     or order_total <> payment_total
     or order_currency <> payment_currency
     or item_count not between 1 and 4
     or reserved_allocation_count <> item_count
     or covered_allocation_count <> item_count
     or ticket_count <> item_count
     or succeeded_attempt_count <> 1
     or not exists (
       select 1
       from __ONSALE_SCHEMA__.payment_attempt
       where id = successful_attempt_id
         and payment_id = checked_payment_id
         and canonical_state = 'succeeded'
     )
     or not exists (
       select 1
       from __ONSALE_SCHEMA__.payment_observation as po
       join __ONSALE_SCHEMA__.payment_attempt_observation as pao
         on pao.payment_observation_id = po.id
        and pao.payment_id = po.payment_id
       where po.payment_id = checked_payment_id
         and po.source in ('retrieve_response', 'verified_webhook')
         and po.canonical_state = 'succeeded'
         and po.observed_amount_minor = payment_total
         and po.observed_currency = payment_currency
         and po.charged_attempt_count = 1
         and pao.payment_attempt_id = successful_attempt_id
         and pao.canonical_state = 'succeeded'
     ) then
    raise exception 'fulfillment bundle is not an exact paid order-item set'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function __ONSALE_SCHEMA__.validate_fulfillment_bundle_row()
returns trigger
language plpgsql
as $$
declare
  checked_id uuid;
begin
  if tg_op = 'DELETE' then
    checked_id := old.id;
  else
    checked_id := new.id;
  end if;
  perform __ONSALE_SCHEMA__.assert_fulfillment_bundle_complete(checked_id);
  return null;
end;
$$;

create or replace function __ONSALE_SCHEMA__.validate_fulfillment_ticket_row()
returns trigger
language plpgsql
as $$
declare
  checked_id uuid;
begin
  if tg_op = 'DELETE' then
    checked_id := old.fulfillment_id;
  else
    checked_id := new.fulfillment_id;
  end if;
  perform __ONSALE_SCHEMA__.assert_fulfillment_bundle_complete(checked_id);
  return null;
end;
$$;

create or replace function __ONSALE_SCHEMA__.validate_fulfillment_order_row()
returns trigger
language plpgsql
as $$
declare
  checked_id uuid;
begin
  if new.state <> 'fulfilled' then
    return null;
  end if;

  select id into checked_id
  from __ONSALE_SCHEMA__.fulfillment_bundle
  where order_id = new.id;

  if not found then
    raise exception 'fulfilled order has no fulfillment bundle'
      using errcode = '23514';
  end if;

  perform __ONSALE_SCHEMA__.assert_fulfillment_bundle_complete(checked_id);
  return null;
end;
$$;

create constraint trigger fulfillment_bundle_complete_after_bundle
after insert or update or delete on __ONSALE_SCHEMA__.fulfillment_bundle
deferrable initially deferred
for each row execute function __ONSALE_SCHEMA__.validate_fulfillment_bundle_row();

create constraint trigger fulfillment_bundle_complete_after_ticket
after insert or update or delete on __ONSALE_SCHEMA__.ticket
deferrable initially deferred
for each row execute function __ONSALE_SCHEMA__.validate_fulfillment_ticket_row();

create constraint trigger fulfillment_bundle_complete_after_order
after insert or update on __ONSALE_SCHEMA__.orders
deferrable initially deferred
for each row execute function __ONSALE_SCHEMA__.validate_fulfillment_order_row();
