# ONSALE C3 — payment and fulfillment work packet

Date: 2026-08-08

Status: implementation gate in progress; no checkout UI is authorized by this packet until the persistence and adapter proofs pass.

## Outcome

Convert one active multi-seat hold into one immutable order, bind that order to one stable Hyperswitch V1 payment identity, reconcile the same payment through uncertainty and top-level provider return, and issue exactly one ticket per immutable order item only after server-side payment integrity checks pass.

The Figma checkout composition is inhabited after this backend gate. It is not redesigned.

## Proof classes

- `merchant_database`: an atomic Neon transaction or sanitized read from the fixed ONSALE application schema.
- `live_sandbox`: a dated Hyperswitch sandbox create/retrieve/attempt observation.
- `merchant_rule`: an explicit ONSALE safety or retry decision.
- `unproven`: no dated observation for this order/profile.
- `recorded_replay`: a read-only dated flow; never current-order evidence.

An SDK callback, browser return query, fixture label, or rendered UI state is not payment authority.

## Non-negotiable invariants

1. One order has at most one stable provider payment identity.
2. The stable identity is committed before provider I/O.
3. No database transaction remains open across a Hyperswitch request.
4. A transport-unknown create outcome permits retrieve of the same identity only.
5. Client secret, API key, publishable-key cache, PAN, CVC, raw provider body, redirect URL/body, and return-query material are never durable.
6. Selected payment method and executed connector are separate evidence facts.
7. A terminal succeeded payment cannot regress; contradictory later observations are append-only integrity evidence.
8. Fulfillment requires a server retrieve or signature-verified webhook, exact immutable order amount/currency, and exactly one succeeded logical attempt.
9. One successful fulfillment transaction creates one bundle and exactly one ticket for every order item/seat.
10. An incomplete ticket set, duplicate ticket, half-issued transaction, or fulfillment without reserved inventory cannot commit.
11. Unknown payment state never releases inventory or starts a new payment automatically.
12. Webhook, routing, fallback, and unobserved processors stay `UNPROVEN`.

## Durable model

Add an immutable ordered migration, `0002_payment_fulfillment_v1`, without modifying the recorded `0001_inventory_v1` bytes or checksum.

The migration adds normalized, fixed-column tables only:

- `provider_payment`
- `checkout_operation`
- `payment_observation`
- `payment_attempt`
- `payment_attempt_observation`
- `fulfillment_bundle`
- `ticket`

No payment table accepts a generic raw provider JSON payload.

### Payment creation state

```text
allocated
  -> reconcile_required   committed before a possible POST
  -> created              definitive create/retrieve found
  -> rejected             definitive non-ambiguous rejection

reconcile_required
  -> reconcile_required   an attested same-ID 404 creates one successor
                          operation; the durable pre-POST state stays armed
                          for retrieve-first crash recovery
  -> created              definitive create/retrieve found
  -> rejected             definitive non-ambiguous rejection
```

### Canonical payment state

```text
not_created
  -> requires_payment_method
  -> requires_customer_action | processing | unknown
  -> failed | succeeded
```

`failed` and `succeeded` are terminal in C3. A later contradiction sets `integrity_review_required`; it never erases tickets or rewrites a terminal payment.

### Order and fulfillment

```text
awaiting_payment -> payment_pending
awaiting_payment -> canceled
payment_pending -> paid -> fulfilled

fulfillment absent -> issued
```

Payment success, bundle insertion, per-item ticket insertion, cardinality validation, and `order -> fulfilled` occur in one transaction.

## Transaction sequence

### TX-A — prepare checkout

1. Lock the buyer-owned order.
2. Bind or replay the checkout operation.
3. Create or read the one stable payment row and `pay_` identity.
4. Validate order header, items, totals, currency, and reserved allocations.
5. Move the order to `payment_pending`.
6. Commit `reconcile_required` before permitting provider create.

Initial TX-A returns `retrieve_same_identity`, never a credential. An
adapter-attested same-ID 404 may atomically terminalize that retrieve
operation, create one deterministic successor operation, and return
`create_same_identity` once. Replaying the predecessor returns retrieve via
the successor; it never repeats the provider POST authorization. The
repository returns a branded, non-enumerable server operation handle with the
retrieve/create directive and an `authorize_create_once` or `block_recreate`
404 policy. If the successor itself retrieves 404 after a possible POST,
checkout stays blocked for reconciliation: C3 never creates a
successor-of-successor and never authorizes a second unsafe POST.

The database clock owns the immutable order payment deadline. First payment
allocation and the one create authorization require at least 31 seconds of
safety runway, covering the adapter's bounded 30-second transport timeout.
The create directive carries a server-only expiry clamped to 1–900 seconds;
late retrieval may still reconcile an existing identity, but a late 404 can
never create or extend a provider session beyond the order deadline.

The directive vocabulary is:

- `create_same_identity`
- `retrieve_same_identity`
- `replay_terminal`
- `blocked_integrity`

Provider authority is pair-scoped. `bindHyperswitchV1Evidence` wraps the
actual adapter and retains method-owned evidence in a private WeakMap. The
repository receives only the paired verifier. Plain source labels, cast
objects, cross-pair receipts, browser callbacks, and primitive status/code
claims cannot authorize a retrieve, a definitive 404, or fulfillment.

### Provider I/O — outside Neon

Create uses server-owned immutable order facts:

- fixed sandbox origin;
- secret `api-key` header;
- stable 30-character payment ID;
- immutable amount and currency;
- configured profile;
- `confirm: false`;
- automatic capture;
- session expiry bounded by the order deadline;
- server-constructed allowlisted return URL.

Retrieve uses:

`GET /payments/{stablePaymentId}?force_sync=true&expand_attempts=true`

No implicit HTTP retry or redirect following is allowed.

### TX-B — project observation

1. Lock order, payment, and stable attempts.
2. Bind or replay the reconcile operation.
3. Append one sanitized observation.
4. Upsert attempts by digest of the stable provider attempt identity.
5. Apply monotonic payment and attempt transitions.
6. Run money and charged-attempt integrity checks.
7. On valid success, issue the complete per-item ticket set atomically.

## Browser boundary

Only an ephemeral, private, no-store checkout response may contain:

- client secret;
- V1 publishable key;
- canonical return URL;
- sanitized shared order snapshot.

These values never enter the shared snapshot, Mechanism Rail, URL, storage, analytics, logs, evidence artifacts, or service-worker cache.

The official widget owns payment methods and fields. The merchant owns one submit button and a synchronous one-submit lock.

Top-level provider action is expected for the dated card and Klarna sandbox flows. ONSALE must not force an iframe, modal, cloned provider surface, OTP form, or fake authorization controls.

## Return contract

1. The SameSite=Lax anonymous session recovers the buyer order.
2. A dedicated no-store return boundary ignores provider query values as truth.
3. Sensitive provider query material is stripped before a clean merchant URL renders.
4. The buyer sees `RETURN RECEIVED`, `CHECKING THIS SAME PAYMENT`, and `DO NOT RESUBMIT`.
5. The server retrieves the existing stable payment.
6. Repeat return, refresh, and Back perform retrieve only.

## Figma inhabitation seam

Keep the baseline checkout heading, two-column anatomy, bordered Unified Checkout frame, order summary, assurance position, cobalt/sharp tokens, 72/28 shell, and authored entrance motion.

Replace only the mock payment controls and fake webhook/provider content:

- no merchant payment-method tabs;
- no merchant card fields;
- no fake test values;
- no `SIMULATE PAYMENT FLOW`;
- no fake provider OTP/bank controls;
- no `LIVE WEBHOOK FEED` or raw JSON;
- no connector label until a dated attempt identifies one.

The active-hold CTA becomes `CONTINUE TO SECURE CHECKOUT ->` and may enter checkout only after order conversion plus stable payment preparation succeed.

## Gate tests

The backend gate is green only after it proves:

- ordered migration upgrade preserves the exact 0001 checksum;
- concurrent checkout preparation creates one payment identity;
- duplicate operation replay and payload conflict behavior;
- crash/unknown create recovery retrieves before any create;
- terminal state monotonicity and append-only contradictions;
- method/connector separation;
- wrong money, zero charges, or multiple charges block fulfillment;
- create-response success alone cannot issue tickets;
- concurrent successful reconciliation yields one bundle and N tickets for N items;
- injected failure after partial ticket insertion rolls back the whole transaction;
- direct incomplete fulfillment cannot commit;
- secret/raw-payload canaries cannot cross normalization, persistence, public projection, logs, or evidence.

Only after those pass may the official widget mount inside the Figma checkout composition. The visible gate then requires deterministic browser tests, one bounded sandbox card action/return/retrieve proof, responsive captures, and the focused HCI cohort defined in the accepted rebuild approach.

## Deferred

- routing or processor fallback mutation;
- webhook processing until signature verification exists;
- Klarna terminal Complete/Reject;
- PayPal activation/login/return;
- Google Pay usability claims;
- refunds, payouts, public deployment, and final video.
