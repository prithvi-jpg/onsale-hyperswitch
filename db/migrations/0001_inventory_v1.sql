-- ONSALE inventory/order V1.
--
-- This file is a schema-qualified template. The guarded migration runner must
-- replace __ONSALE_SCHEMA__ with one validated identifier. Executing the file
-- directly is intentionally invalid, so it cannot silently land in public.

create table if not exists __ONSALE_SCHEMA__.schema_migration (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default clock_timestamp()
);

create table if not exists __ONSALE_SCHEMA__.schema_control (
  schema_name text primary key,
  cleanup_capability_digest text not null
    check (cleanup_capability_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);

create or replace function __ONSALE_SCHEMA__.max_safe_money_minor()
returns bigint
language sql
immutable
parallel safe
as $$
  select 9000000000000::bigint
$$;

create table if not exists __ONSALE_SCHEMA__.prototype_dataset (
  id uuid primary key,
  generation bigint not null unique check (generation > 0),
  label text not null,
  state text not null check (state in ('preparing', 'active', 'retired')),
  seed_version integer not null check (seed_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  retired_at timestamptz,
  check (
    (state = 'preparing' and activated_at is null and retired_at is null)
    or (state = 'active' and activated_at is not null and retired_at is null)
    or (state = 'retired' and activated_at is not null and retired_at is not null)
  )
);

create unique index if not exists prototype_dataset_one_active_idx
  on __ONSALE_SCHEMA__.prototype_dataset ((state))
  where state = 'active';

create table if not exists __ONSALE_SCHEMA__.event (
  id uuid primary key,
  dataset_id uuid not null references __ONSALE_SCHEMA__.prototype_dataset(id),
  slug text not null,
  name text not null,
  venue_name text not null,
  venue_timezone text not null,
  starts_at timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  seating_mode text not null check (seating_mode = 'assigned'),
  state text not null check (
    state in ('draft', 'on_sale', 'sales_paused', 'sold_out', 'ended', 'canceled')
  ),
  inventory_version integer not null default 1 check (inventory_version > 0),
  display_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (dataset_id, slug),
  unique (id, dataset_id),
  unique (id, currency, dataset_id)
);

create index if not exists event_dataset_id_idx
  on __ONSALE_SCHEMA__.event (dataset_id);

create table if not exists __ONSALE_SCHEMA__.sale_window (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  kind text not null check (kind in ('presale', 'general')),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  access_policy_kind text not null check (
    access_policy_kind in ('prototype_open', 'local_prototype_cardmember')
  ),
  seat_limit integer not null check (seat_limit between 1 and 4),
  state text not null check (state in ('scheduled', 'open', 'paused', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  check (closes_at > opens_at),
  unique (event_id, kind),
  unique (id, event_id, dataset_id),
  foreign key (event_id, dataset_id)
    references __ONSALE_SCHEMA__.event (id, dataset_id)
);

create index if not exists sale_window_dataset_id_idx
  on __ONSALE_SCHEMA__.sale_window (dataset_id);
create index if not exists sale_window_event_state_time_idx
  on __ONSALE_SCHEMA__.sale_window (event_id, state, opens_at, closes_at);

create table if not exists __ONSALE_SCHEMA__.access_grant (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  sale_window_id uuid not null,
  buyer_ref text not null,
  proof_kind text not null check (proof_kind = 'local_prototype'),
  state text not null check (state in ('verified', 'expired', 'revoked')),
  policy_version integer not null check (policy_version > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz not null default clock_timestamp(),
  expired_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (
    (state = 'verified' and expired_at is null and revoked_at is null)
    or (state = 'expired' and expired_at is not null and revoked_at is null)
    or (state = 'revoked' and revoked_at is not null and expired_at is null)
  ),
  unique (id, event_id, sale_window_id, dataset_id),
  foreign key (sale_window_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.sale_window (id, event_id, dataset_id)
);

create index if not exists access_grant_dataset_id_idx
  on __ONSALE_SCHEMA__.access_grant (dataset_id);
create index if not exists access_grant_lookup_idx
  on __ONSALE_SCHEMA__.access_grant (
    event_id, sale_window_id, buyer_ref, state, expires_at
  );

create table if not exists __ONSALE_SCHEMA__.section (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  name text not null,
  ordinal integer not null check (ordinal > 0),
  display_metadata jsonb not null default '{}'::jsonb,
  unique (event_id, ordinal),
  unique (id, event_id, dataset_id),
  foreign key (event_id, dataset_id)
    references __ONSALE_SCHEMA__.event (id, dataset_id)
);

create index if not exists section_dataset_id_idx
  on __ONSALE_SCHEMA__.section (dataset_id);
create index if not exists section_event_id_idx
  on __ONSALE_SCHEMA__.section (event_id);

create table if not exists __ONSALE_SCHEMA__.seat_row (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  section_id uuid not null,
  label text not null,
  ordinal integer not null check (ordinal > 0),
  unique (section_id, ordinal),
  unique (section_id, label),
  unique (id, section_id, event_id, dataset_id),
  foreign key (section_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.section (id, event_id, dataset_id)
);

create index if not exists seat_row_dataset_id_idx
  on __ONSALE_SCHEMA__.seat_row (dataset_id);
create index if not exists seat_row_event_id_idx
  on __ONSALE_SCHEMA__.seat_row (event_id);
create index if not exists seat_row_section_id_idx
  on __ONSALE_SCHEMA__.seat_row (section_id);

create table if not exists __ONSALE_SCHEMA__.price_tier (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  name text not null,
  face_value_minor bigint not null
    check (face_value_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  fee_minor bigint not null
    check (fee_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  tax_minor bigint not null
    check (tax_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  all_in_minor bigint not null
    check (all_in_minor between 1 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz not null,
  effective_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (all_in_minor = face_value_minor + fee_minor + tax_minor),
  check (effective_until is null or effective_until > effective_from),
  unique (event_id, name),
  unique (id, event_id, dataset_id),
  foreign key (event_id, currency, dataset_id)
    references __ONSALE_SCHEMA__.event (id, currency, dataset_id)
);

create index if not exists price_tier_dataset_id_idx
  on __ONSALE_SCHEMA__.price_tier (dataset_id);
create index if not exists price_tier_event_id_idx
  on __ONSALE_SCHEMA__.price_tier (event_id);

create table if not exists __ONSALE_SCHEMA__.seat (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  section_id uuid not null,
  row_id uuid not null,
  label text not null,
  ordinal integer not null check (ordinal > 0),
  price_tier_id uuid not null,
  lifecycle_state text not null check (lifecycle_state in ('sellable', 'blocked', 'removed')),
  created_at timestamptz not null default clock_timestamp(),
  unique (row_id, ordinal),
  unique (row_id, label),
  unique (id, event_id, dataset_id),
  foreign key (row_id, section_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.seat_row (id, section_id, event_id, dataset_id),
  foreign key (price_tier_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.price_tier (id, event_id, dataset_id)
);

create index if not exists seat_dataset_id_idx
  on __ONSALE_SCHEMA__.seat (dataset_id);
create index if not exists seat_event_row_idx
  on __ONSALE_SCHEMA__.seat (event_id, row_id, ordinal);
create index if not exists seat_section_id_idx
  on __ONSALE_SCHEMA__.seat (section_id);
create index if not exists seat_price_tier_id_idx
  on __ONSALE_SCHEMA__.seat (price_tier_id);

create table if not exists __ONSALE_SCHEMA__.hold (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  sale_window_id uuid not null,
  buyer_ref text not null,
  state text not null check (state in ('active', 'released', 'expired', 'converted')),
  expires_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  expired_at timestamptz,
  converted_at timestamptz,
  terminal_reason text,
  unique (id, event_id, dataset_id),
  foreign key (event_id, dataset_id)
    references __ONSALE_SCHEMA__.event (id, dataset_id),
  foreign key (sale_window_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.sale_window (id, event_id, dataset_id),
  check (
    (state = 'active' and released_at is null and expired_at is null and converted_at is null)
    or (state = 'released' and released_at is not null and expired_at is null and converted_at is null)
    or (state = 'expired' and expired_at is not null and released_at is null and converted_at is null)
    or (state = 'converted' and converted_at is not null and released_at is null and expired_at is null)
  ),
  check (expires_at >= created_at + interval '250 milliseconds'),
  check (expires_at <= created_at + interval '15 minutes')
);

create index if not exists hold_dataset_id_idx
  on __ONSALE_SCHEMA__.hold (dataset_id);
create index if not exists hold_event_state_expiry_idx
  on __ONSALE_SCHEMA__.hold (event_id, state, expires_at);
create index if not exists hold_sale_window_id_idx
  on __ONSALE_SCHEMA__.hold (sale_window_id);

create table if not exists __ONSALE_SCHEMA__.orders (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  hold_id uuid not null unique,
  sale_window_id uuid not null,
  buyer_ref text not null,
  state text not null check (
    state in ('awaiting_payment', 'payment_pending', 'paid', 'fulfilled', 'canceled')
  ),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null
    check (subtotal_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  fee_minor bigint not null
    check (fee_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  tax_minor bigint not null
    check (tax_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  total_minor bigint not null
    check (total_minor between 1 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  payment_deadline_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  canceled_at timestamptz,
  check (total_minor = subtotal_minor + fee_minor + tax_minor),
  check (
    (state = 'canceled' and canceled_at is not null)
    or (state <> 'canceled' and canceled_at is null)
  ),
  unique (id, event_id, dataset_id),
  unique (id, hold_id, event_id, dataset_id),
  foreign key (hold_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.hold (id, event_id, dataset_id),
  foreign key (sale_window_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.sale_window (id, event_id, dataset_id)
);

create index if not exists orders_dataset_id_idx
  on __ONSALE_SCHEMA__.orders (dataset_id);
create index if not exists orders_event_state_created_idx
  on __ONSALE_SCHEMA__.orders (event_id, state, created_at);
create index if not exists orders_sale_window_id_idx
  on __ONSALE_SCHEMA__.orders (sale_window_id);

create table if not exists __ONSALE_SCHEMA__.seat_allocation (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  seat_id uuid not null,
  hold_id uuid not null,
  order_id uuid,
  state text not null check (
    state in ('held', 'reserved', 'reservation_released', 'released', 'expired')
  ),
  price_tier_name text not null,
  face_value_minor bigint not null
    check (face_value_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  fee_minor bigint not null
    check (fee_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  tax_minor bigint not null
    check (tax_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  total_minor bigint not null
    check (total_minor between 1 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  expired_at timestamptz,
  reserved_at timestamptz,
  check (total_minor = face_value_minor + fee_minor + tax_minor),
  check (
    (state = 'held' and order_id is null and released_at is null and expired_at is null and reserved_at is null)
    or (state = 'reserved' and order_id is not null and reserved_at is not null and released_at is null and expired_at is null)
    or (state = 'reservation_released' and order_id is not null and reserved_at is not null and released_at is not null and expired_at is null)
    or (state = 'released' and order_id is null and released_at is not null and expired_at is null and reserved_at is null)
    or (state = 'expired' and order_id is null and expired_at is not null and released_at is null and reserved_at is null)
  ),
  check (released_at is null or reserved_at is null or released_at >= reserved_at),
  unique (id, event_id, dataset_id),
  unique (id, seat_id, order_id, event_id, dataset_id),
  foreign key (seat_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.seat (id, event_id, dataset_id),
  foreign key (hold_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.hold (id, event_id, dataset_id),
  foreign key (order_id, hold_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.orders (id, hold_id, event_id, dataset_id)
);

create unique index if not exists seat_allocation_one_active_owner_idx
  on __ONSALE_SCHEMA__.seat_allocation (seat_id)
  where state in ('held', 'reserved');
create index if not exists seat_allocation_dataset_id_idx
  on __ONSALE_SCHEMA__.seat_allocation (dataset_id);
create index if not exists seat_allocation_event_state_idx
  on __ONSALE_SCHEMA__.seat_allocation (event_id, state);
create index if not exists seat_allocation_hold_state_idx
  on __ONSALE_SCHEMA__.seat_allocation (hold_id, state);
create index if not exists seat_allocation_order_id_idx
  on __ONSALE_SCHEMA__.seat_allocation (order_id)
  where order_id is not null;

create table if not exists __ONSALE_SCHEMA__.order_item (
  id uuid primary key,
  dataset_id uuid not null,
  event_id uuid not null,
  order_id uuid not null,
  seat_id uuid not null,
  seat_allocation_id uuid not null unique,
  section_name text not null,
  row_label text not null,
  seat_label text not null,
  price_tier_name text not null,
  face_value_minor bigint not null
    check (face_value_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  fee_minor bigint not null
    check (fee_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  tax_minor bigint not null
    check (tax_minor between 0 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  total_minor bigint not null
    check (total_minor between 1 and __ONSALE_SCHEMA__.max_safe_money_minor()),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default clock_timestamp(),
  check (total_minor = face_value_minor + fee_minor + tax_minor),
  unique (order_id, seat_id),
  foreign key (order_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.orders (id, event_id, dataset_id),
  foreign key (seat_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.seat (id, event_id, dataset_id),
  foreign key (seat_allocation_id, seat_id, order_id, event_id, dataset_id)
    references __ONSALE_SCHEMA__.seat_allocation (
      id, seat_id, order_id, event_id, dataset_id
    )
);

create index if not exists order_item_dataset_id_idx
  on __ONSALE_SCHEMA__.order_item (dataset_id);
create index if not exists order_item_event_id_idx
  on __ONSALE_SCHEMA__.order_item (event_id);
create index if not exists order_item_order_id_idx
  on __ONSALE_SCHEMA__.order_item (order_id);
create index if not exists order_item_seat_id_idx
  on __ONSALE_SCHEMA__.order_item (seat_id);

create or replace function __ONSALE_SCHEMA__.reject_order_item_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'order items are immutable after creation'
    using errcode = '55000';
end;
$$;

create trigger order_item_immutable_before_update_or_delete
before update or delete on __ONSALE_SCHEMA__.order_item
for each row execute function __ONSALE_SCHEMA__.reject_order_item_mutation();

create or replace function __ONSALE_SCHEMA__.assert_order_item_totals(
  checked_order_id uuid
) returns void
language plpgsql
as $$
declare
  header __ONSALE_SCHEMA__.orders%rowtype;
  item_count bigint;
  item_subtotal bigint;
  item_fee bigint;
  item_tax bigint;
  item_total bigint;
  currency_count bigint;
begin
  select * into strict header
  from __ONSALE_SCHEMA__.orders
  where id = checked_order_id;

  select
    count(*),
    coalesce(sum(face_value_minor), 0),
    coalesce(sum(fee_minor), 0),
    coalesce(sum(tax_minor), 0),
    coalesce(sum(total_minor), 0),
    count(distinct currency)
  into
    item_count,
    item_subtotal,
    item_fee,
    item_tax,
    item_total,
    currency_count
  from __ONSALE_SCHEMA__.order_item
  where order_id = checked_order_id;

  if item_count not between 1 and 4
     or currency_count <> 1
     or not exists (
       select 1 from __ONSALE_SCHEMA__.order_item
       where order_id = checked_order_id and currency = header.currency
     )
     or item_subtotal <> header.subtotal_minor
     or item_fee <> header.fee_minor
     or item_tax <> header.tax_minor
     or item_total <> header.total_minor then
    raise exception 'order item/header money invariant failed'
      using errcode = '23514';
  end if;
end;
$$;

create table if not exists __ONSALE_SCHEMA__.idempotency_operation (
  id uuid primary key,
  scope text not null,
  operation_key text not null,
  command_kind text not null check (
    command_kind in (
      'claim_seats', 'release_hold', 'expire_hold', 'create_order',
      'cancel_order', 'reset_dataset'
    )
  ),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('started', 'completed', 'failed')),
  target_hold_id uuid,
  target_order_id uuid,
  result jsonb,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (scope, operation_key),
  check (
    (state = 'started' and completed_at is null and result is null and error_code is null)
    or (state = 'completed' and completed_at is not null and result is not null and error_code is null)
    or (state = 'failed' and completed_at is not null and result is not null and error_code is not null)
  )
);

create index if not exists idempotency_operation_hold_id_idx
  on __ONSALE_SCHEMA__.idempotency_operation (target_hold_id)
  where target_hold_id is not null;
create index if not exists idempotency_operation_order_id_idx
  on __ONSALE_SCHEMA__.idempotency_operation (target_order_id)
  where target_order_id is not null;
