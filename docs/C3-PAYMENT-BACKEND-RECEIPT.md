# ONSALE C3 — payment persistence and fulfillment backend receipt

Date: 2026-08-08

Branch: `codex/main-prototype`

Status: the C3 database and payment-repository gate is green after its final
guarded rerun. The offline checkout-coordinator boundary is also green. The
official checkout, live provider, browser return, and Figma UI gates remain
open and in progress.

## Outcome

C3 adds an ordered payment-and-fulfillment migration, a sanitized Hyperswitch
V1 adapter boundary, and a durable Neon repository to the Figma-baseline
prototype. The backend can reserve one stable provider-payment identity,
reconcile normalized observations without trusting a browser callback, and
issue exactly one ticket per immutable order item only after authoritative
success and payment-integrity checks pass.

This receipt does **not** claim a live Hyperswitch request, a mounted and
provider-connected Unified Checkout widget, provider-action completion,
browser return behavior, webhook processing, or a working checkout UI. No live
provider call was made by any verification recorded in this receipt. The fixed
application schema contains no orders or payment records after the migration
apply. UI inhabitation is the next gate, not evidence supplied by this one.

## Verification summary

| Gate | Result | What the result establishes |
| --- | ---: | --- |
| Strict TypeScript and focused diff check | passed | The current coordinator source and focused tests type-check; its focused diff check is clean. |
| Core backend offline snapshot before the coordinator landed | `176 passed`, `43 hosted-only skipped` | Pure normalization, adapter request/response rules, schema contract, fixed-manifest behavior, and repository boundaries passed without a provider or database call at that snapshot. |
| Offline checkout coordinator and HTTP runtime | `33/33 passed` | Retrieve-before-create, same-payment recovery, private DTO/cookie handling, deadline grant suppression, return-query stripping, and fixed-error boundaries pass with injected dependencies and no live provider call. |
| Guarded migration suite in Neon | `9/9 passed` | The ephemeral harness, fresh catalog, exact `0001 -> 0002` upgrade, replay, drift refusal, suffix rollback, and capability-bound cleanup execute in PostgreSQL. |
| Final guarded payment repository rerun in Neon | `16/16 passed` in `614.49 s` | Stable identity, operation replay, contention, normalized observations, integrity review, atomic fulfillment, lock races, rollback, deadline blocking, and data-minimization checks execute against Neon. |
| Affected fulfillment case | `C3-FUL-01 passed` in `115.545 s` | Exact one-to-four-seat issuance and repeat reconciliation passed in isolation after the final repository changes. |
| Expanded create-authorization recovery case | `C3-PAY-04 passed` in `135.729 s` | One create authorization, crash recovery, concurrent not-found serialization, and deadline-after-prepare blocking passed under a 240-second case bound and 20-second internal wait bounds. |
| Inventory conversion regression | `ORD-02 passed` in `12.874 s` | Multi-seat hold conversion still creates one immutable item per allocation with exact durable header sums. |
| Fixed application apply and readback | passed | `onsale_app_v1` records the exact two-migration manifest and exposes the expected empty payment surface over the existing active inventory dataset. |
| Cleanup and namespace audit | passed after every hosted run | Every post-run audit found zero exact ephemeral test schemas and zero ONSALE tables in `public`. |

The hosted suites and targeted reruns used capability-owned `onsale_test_*`
namespaces and serialized workers. They did not mutate `public`. The fixed
application apply was a separate, apply-only operation after the ephemeral
gates passed.

The first attempt to run the expanded `C3-PAY-04` case reached the old
120-second whole-case timeout. Teardown completed cleanly, and the subsequent
namespace audit was zero/zero. The case was rerun with a bounded 240-second
outer limit while retaining 20-second internal lock/barrier limits; it passed
in 135.729 seconds. The timeout is preserved here as harness history, not
reported as a product pass or hidden as noise.

## Immutable migration receipt

The application manifest is the exact ordered pair below:

1. `0001_inventory_v1`
   `622c17491da6aa4458d9a81ec19ce71b5421da7e3679f79ea5e1425f73453a1a`
2. `0002_payment_fulfillment_v1`
   `b1db792e4709935d8b3e2031a42e3c1e22c13b5f592e261a5a3aa7850d57146b`

The recorded `0001` bytes and checksum remain unchanged. `0002` adds exactly
seven normalized tables:

- `provider_payment`
- `checkout_operation`
- `payment_observation`
- `payment_attempt`
- `payment_attempt_observation`
- `fulfillment_bundle`
- `ticket`

The migration-contract test source reviewed with this receipt has SHA-256
`926f5b457bc10ba894ffe46fb17760a3d70e984df21e583c55d7178f3724554e`.
This third checksum is an evidence-file checksum; it is not a database
migration-manifest entry.

The final expanded hosted repository test source has SHA-256
`e10cddb08845881b28c92bc9180cd8ef516d42e3ad6226ca86c844a4c09d3e96`.
It is also an evidence-file checksum, not a migration-manifest entry.

The migration enforces the forward order graph, freezes order money and
terminal fulfillment proof, makes observations append-only, prevents deletion
of payment identities and attempts, and defers complete-bundle validation until
the enclosing transaction commits. Seat-allocation and fulfillment paths take
the same order lock, so the two operations cannot commit contradictory outcomes.

## Hosted repository proof

The 16-case hosted repository suite covers these executable boundaries:

- one-to-four immutable order items and exact order totals;
- concurrent checkout preparation resolving to one stable payment identity;
- same-operation replay and changed-request-hash refusal;
- retrieve-first recovery and one create authorization only after an attested
  same-payment not-found result;
- cancel-first and payment-first serialization;
- create-response success remaining non-authoritative for fulfillment;
- selected payment method and observed connector stored as separate facts;
- hard-decline and ordinary technical-failure classifications without an
  invented retry or processor cascade;
- malformed observation refusal before any durable append;
- terminal-success retention with a later contradiction recorded for review;
- exact-money, exactly-one-successful-charge, authoritative-retrieve, and
  reserved-allocation checks before ticket issue;
- exactly one ticket per order item for one-, two-, three-, and four-seat
  orders, including repeat reconciliation without duplicate tickets;
- full rollback after an injected partial-ticket failure;
- deterministic allocation-first and fulfillment-first lock races;
- direct SQL mutation guards after fulfillment; and
- absence of checkout credentials, raw provider payloads, provider action
  material, card data, and return-query material from the durable and
  repository projections.

These are repository and PostgreSQL proofs driven by normalized, test-attested
provider observations. They are not dated live-sandbox payment outcomes.

The final full rerun passed all 16 hosted cases in 614.49 seconds. The affected
`C3-FUL-01` case also passed alone in 115.545 seconds. The expanded
`C3-PAY-04` result and timeout history are recorded above. `ORD-02` then passed
alone in 12.874 seconds to confirm that the inventory-to-order seam still held.
Every one of those hosted executions was followed by zero orphan ephemeral
schemas and zero ONSALE tables in `public`.

## Fixed application readback

After the guarded fixed-schema apply, a sanitized read-only inspection found:

- migration-manifest rows: `2`, in the exact order and checksums above;
- normalized C3 payment/fulfillment tables: `7`;
- active datasets: `1`;
- assigned seats in the active dataset: `60`;
- orders: `0`;
- provider payments: `0`;
- fulfillment bundles: `0`;
- tickets: `0`;
- remaining exact ephemeral test schemas: `0`;
- ONSALE tables in `public`: `0`.

The empty order/payment counts are intentional. The fixed apply proves schema
upgrade and inventory preservation without inserting a synthetic purchase.

## Data-minimization receipt

The durable catalog has no column for a checkout client credential,
publishable key, PAN, CVC, provider redirect URL/body, raw provider payload, or
return-query material. Provider prose is reduced to fixed safe copy and
unrecognized categorical values are reduced to bounded labels before they
reach the repository.

The hosted security case injected representative sensitive and categorical
canaries, then checked the normalized observation, database rows, and
repository aggregate. Forbidden material had zero retained occurrences across
those checked surfaces. Information-schema inspection also found zero
forbidden credential/raw-payload columns in the seven new tables.

This proves the tested normalization and persistence boundary. It does not
replace production log redaction, infrastructure audit, browser storage
inspection, or a provider-side compliance review.

## Gate checklist

### Passed in C3

- [x] Preserve the exact `0001` migration bytes and checksum.
- [x] Apply only the ordered missing migration suffix.
- [x] Refuse capability, owner, checksum, prefix, and ordering drift.
- [x] Clean capability-owned ephemeral schemas after success and rollback.
- [x] Keep one stable payment identity per order.
- [x] Commit retrieve-first state before provider I/O.
- [x] Enforce in the adapter contract one outbound request with no implicit
  retry or redirect following.
- [x] Keep selected method and observed connector as separate evidence.
- [x] Prevent create-response success from issuing tickets.
- [x] Preserve terminal states and append contradictions for integrity review.
- [x] Require exact money, one successful logical charge, authoritative
  retrieve evidence, and complete reserved allocations before fulfillment.
- [x] Issue one complete, immutable ticket set atomically.
- [x] Prove cancel/payment and allocation/fulfillment lock races in hosted Neon.
- [x] Exclude credentials, raw payloads, provider-action material, card data,
  and return queries from the tested durable and repository surfaces.
- [x] Apply `0002` to the fixed application namespace and verify the sanitized
  catalog/count receipt.
- [x] Pass the focused offline checkout coordinator and HTTP runtime suite
  `33/33`, with strict TypeScript and focused diff checks green.

### Open release gates

- [ ] Durably terminalize a definitive provider create `4xx`. The current
  adapter returns a fixed rejection and performs no automatic retry, but that
  rejection is not yet recorded as a terminal checkout operation/payment fact.
- [ ] Resolve orders whose immutable payment deadline expires after payment
  preparation. The repository blocks new create authorization and keeps the
  one stable payment for retrieve-first safety, but the order remains
  operator-blocked and noncancelable.
- [ ] Add an explicit, audited recovery/release policy for the reserved seats in
  those definitive-create-rejection and deadline-after-prepare states. No
  automatic seat release exists for either case.
- [ ] Make one bounded live Hyperswitch sandbox create/retrieve round trip
  through the new server boundary.
- [ ] Mount official Unified Checkout inside the unchanged Figma checkout
  composition.
- [ ] Implement the no-store ephemeral checkout grant and return/reconcile
  route without leaking provider material into URL, storage, logs, or evidence.
- [ ] Prove the real top-level action and same-payment return behavior in the
  browser.
- [ ] Run deterministic browser, responsive, keyboard, motion, and focused HCI
  regression checks on the inhabited Figma UI.
- [ ] Implement and verify webhook signature handling before accepting webhook
  success as authority.
- [ ] Implement or claim routing, failover, refunds, payouts, production bank
  behavior, or provider compliance coverage.
- [ ] Deploy or publish the prototype.

## Proof boundary

The green C3 persistence gate means the backend invariants execute in
PostgreSQL and the server adapter/domain/coordinator contracts pass offline. It
does not mean that Hyperswitch, a processor, a bank, or a buyer completed a
payment in this build. No provider availability, payment-method eligibility,
issuer response, redirect return, webhook delivery, browser accessibility, or
visual fidelity claim should be inferred from this receipt.
