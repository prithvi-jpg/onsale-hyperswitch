# Verified backend port map

Status: implementation review gate, not UI or deployment authorization

Prepared: 2026-08-08

Figma baseline: `8dede8f296f2d74359e8d1e95734687e18c5a8e5`

Target runtime: Next.js App Router on Vercel, with Neon Postgres as the durable authority

## Decision

The Figma export remains the presentation source of truth. The current
`src/App.tsx`, `src/MechanismRail.tsx`, and `src/index.css` have no diff from the
baseline commit. The superseded `v01` implementation is therefore a behavioral
donor only. No `v01` customer canvas, rail, CSS, mock checkout shell, file store,
or single-seat fulfillment implementation should be copied into this branch.

The safe unit of reuse is a tested contract:

- one stable Hyperswitch payment identity per order;
- create with `confirm=false` and confirm only through official Unified Checkout;
- classify an indeterminate provider response as unknown;
- retrieve that same identity before any new provider mutation;
- accept success only after server retrieval verifies amount, currency, and
  charged attempts;
- never issue fulfillment from a browser return, SDK callback, or local timer;
- expose only a sanitized server projection to the Figma UI.

Everything that owns seats, prices, orders, attempts, operations, evidence, or
tickets must be re-authored against the multi-seat Neon model.

## Dated sandbox evidence boundary

| Case | What is established | What remains outside the claim | Data-model blocker | Frontend blocker |
| --- | --- | --- | --- | --- |
| Card success | One official card confirmation opened a top-level hosted 3DS page, returned to the same order, and reconciled to `succeeded`; one `stripe_test` attempt, one charged attempt, one logical charge, and one ticket were observed. Replaying the return changed none of those counts. | Physical pointer/keyboard activation in the rebuilt UI, production behavior, uplift, wallets, routing, and webhooks. An in-panel 3DS overlay was not observed. | Supplies the positive adapter fixture only. Live result projection still requires durable payment, attempt, observation, fulfillment, and per-item ticket records. | Success may be implemented only after Neon reconciliation and atomic per-seat fulfillment exist. Do not recreate the hosted challenge in an ONSALE modal. |
| Card hard decline | One official generic-decline confirmation reconciled to canonical `failed`; one `stripe_test` attempt classified `hard_decline`, zero charged attempts, zero logical charges, zero tickets, and no cascade. | A second method, failover, automatic retry safety for other failures, pointer/keyboard activation, or production issuer behavior. | Supplies the negative adapter fixture only. Durable payment/attempt/observation records remain required. | The decline composition may be inhabited once the server supplies attempt, charge, ticket, hold, and retry facts. No automatic second attempt is permitted. |
| PayPal visibility | Card, Klarna, Affirm, Google Pay, and PayPal were visible in official Unified Checkout for one fresh intent with zero confirmations. PayPal was identified from the official SVG; its browser accessibility control was unlabeled in that run. | PayPal activation, accessible naming across configurations, eligibility after selection, popup/redirect, login, authorization, capture, or return. | Preserve method family/type fields in the later payment schema; visibility is not a payment outcome fixture. | Blocks PayPal-specific copy, choreography, success, and replay. ONSALE must not draw a merchant-owned PayPal control; the official widget owns method selection. |
| Klarna action | Klarna was selected in official Unified Checkout. One SDK confirm opened a top-level Hyperswitch sandbox authorization page; same-payment retrieval returned `requires_customer_action`, one `requires_action` attempt on `stripe_test`, zero charged attempts, no fulfillment, and zero tickets. | Complete/Reject activation, terminal return/retrieve, production Klarna behavior, direct Klarna processing, and overlay presentation. | Supplies an action fixture only. Preserve selected method, observed connector, and action observations independently in the later payment schema. | The buyer may preserve continuity across the observed top-level action and render action-required after retrieve. It must not force an overlay or claim completion/direct Klarna routing. |
| Unknown outcome | The retrieve-before-retry rule is implemented and unit-tested in `v01`; no bounded browser interruption receipt has yet established a real unknown outcome. | Exact browser/provider presentation and recovery timing. | Yes for the payment aggregate and operation ledger. A live provider confirm cannot ship without an `uncertain` state and same-identity recovery. It does not block Next.js parity or inventory work. | Blocks live checkout release, not the Figma/Next.js migration or seat flow. |
| Webhook and routing | No active webhook or routing algorithm was returned for the supplied profile. The successful and declined browser cases were established by server retrieve. | Signed webhook handling, policy activation, failover, least-cost routing, or multi-processor cascades. | No for card create/retrieve. Separate schemas may be additive. | Blocks unconditional `LIVE HOSTED`, signed-webhook, policy-match, fallback, and failover claims. The rail must show Retrieve for the observed cases and label Webhook unobserved. |

Evidence sources are the sanitized receipts under
`v01/artifacts/sandbox/20260808-hyperswitch-browser-3ds-completion/`,
`20260808-hyperswitch-browser-hard-decline/`,
`20260808-hyperswitch-browser-paypal-visibility/`,
`20260808-hyperswitch-browser-klarna-action/`, and
`20260808-hyperswitch-v1-env-pairing/`.

## Backend unit disposition

“Port” below means transplant the behavior behind a new interface and preserve
its focused tests. It never means copying the whole file or its UI.

| `v01` unit | Independently reusable contract | Required main-prototype rewrite | Disposition |
| --- | --- | --- | --- |
| `lib/server/hyperswitch-v1.ts:20-83` | Explicit V1 secret/profile/publishable-key pairing, fail-closed configuration result, no V2/generic-key fallback. | Read private values only in the Node server runtime. Report a capability state without echoing names or values to the customer snapshot. Pairing status should reference a dated receipt, not `operator_configured_unverified`. | Port behavior and tests. |
| `lib/server/hyperswitch-v1.ts:91-143` | Bounded transport, `no-store`, typed `transport_unknown`, typed rejection/invalid response, and no blind retry. | Inject transport and timeout for tests; attach a sanitized operation reference. Never log response bodies, client secrets, raw URLs, or credentials. | Port behind a server-only adapter. |
| `lib/server/hyperswitch-v1.ts:151-258` | Create one V1 payment with `confirm=false`; retrieve with `force_sync=true&expand_attempts=true`; require the echoed stable identity. | Replace fixed USD 184.60 constants and fixture metadata with immutable Neon order totals/items. Mint and persist the merchant payment reference before provider I/O. Return client secret and publishable key only in the ephemeral checkout response. Add an adapter-proven idempotency mapping before relying on retries. | Port protocol; rewrite inputs, output DTO, and persistence boundary. |
| `lib/server/buyer-checkout.ts:6-107` | Strict operation ID, discriminated ready/configuration/unknown/provider-block results, and a provider adapter interface. | Replace `BuyerSnapshot` with the multi-aggregate public snapshot. Separate ephemeral checkout material from durable/public state. Extend error/result codes for expired/canceled order and uncertain payment. | Port the result algebra; rewrite domain names. |
| `lib/domain/buyer-payment.ts:47-193` | Defensive string/error sanitization, provider-to-canonical status mapping, attempt normalization, hard-decline classification, and charged-attempt count. | Normalize provider attempt ID, connector account reference, processor, method family/type/experience, provider code/category, amount/currency, next-action presence, and observation source. A failed attempt must not automatically terminally fail the logical payment. | Port as pure normalizer with expanded fixtures. |
| `lib/domain/buyer-payment.ts:230-470` | Amount/currency integrity checks, exactly-one charged-attempt guard, server-retrieve authority, terminal-state monotonicity, and duplicate-reconcile idempotency. | Remove global amount constants, single-seat hold assumptions, and `ticketCount === 1`. Reduce into the Neon payment/order aggregate, persist observations/attempts, then atomically create one ticket per order item. A browser return is a trigger to retrieve, not success evidence. | Port invariants; rewrite reducer and fulfillment side effects. |
| `lib/server/buyer-store.ts` | Stable identity, operation replay, retrieve-before-create after ambiguity, and no mutation after terminal fulfillment are valuable behaviors. | Reject the implementation: process-local locks, JSON files, `/tmp`, one session/seat, and durable `clientSecret`/`publishableKey` fields are incompatible with Vercel, Neon, multi-seat contention, and the privacy contract. Use database transactions, unique constraints, and an operation ledger. | Do not port code. Re-implement the four behaviors in Neon. |
| `src/HyperswitchCheckout.tsx:420-575` | One official SDK `confirmPayment`, a submit lock, `redirect: "if_required"`, immediate server reconciliation whether the SDK returns or throws, and an authoritative/non-authoritative status distinction. | Extract a headless checkout controller plus the minimum official `HyperElements`/`UnifiedCheckout` mount. Do not port its card-shaped visual wrapper, inline styles, reduced-motion default, or status composition. The baseline checkout slot supplies the visual frame. Add pointer and keyboard submit regressions; the receipts used `form.requestSubmit()`. | Port behavior, not markup. |
| `src/HyperswitchCheckout.tsx:577-end` | Fail-closed create, SDK-load, status-check, and reconciliation transitions. | Preserve top-level navigation/return continuity. Rehydrate by session/order reference on return and retrieve before rendering a terminal state. Do not force provider action into an overlay. | Port controller logic with return-path tests. |
| `app/api/buyer/**` | App Router route separation, strict JSON validation, `no-store`, and the `200`/`202`/`409`/`503` result mapping are useful. | Back every mutation with Neon transactions and the multi-seat aggregate. Return the same public snapshot shape from session, command, create, and reconcile routes. Do not leak provider payloads or make a route-level local store authoritative. | Recreate routes around the new repository. |
| `app/api/webhooks/hyperswitch/route.ts` | Its fail-closed `501` correctly avoids pretending the webhook is implemented. | Do not install a mutating webhook route until signature verification, deduplication, quarantine, and out-of-order tests pass with a dated provider receipt. | Retain the boundary decision; no live port now. |

## Main-prototype units already native to the new model

- `src/domain/inventory.ts` is the current pure oracle for atomic one-to-four-seat
  claims, all-or-nothing failure, hold release/expiry, order conversion, stable
  payment placeholders, and semantic idempotency. Keep it independent of React,
  HTTP, provider I/O, and wall-clock access.
- `db/migrations/0001_inventory_v1.sql` currently defines dataset, event, sale
  window, assigned-seat inventory, immutable price snapshots, holds, allocations,
  orders/items, and the first operation ledger. It does not yet define the
  payment, attempt, observation, fulfillment, ticket, or evidence aggregates.
- `src/server/inventory-neon-schema.ts` is a capability-guarded isolated-schema
  migration harness; `src/server/inventory-neon.ts` is the raw-SQL application
  repository for this slice.
- The final suite passed 17/17 tests: one local migration contract plus 16
  hosted transaction cases. It covers contention, durable failure replay,
  database-time expiry, release/conversion, unpaid cancellation, pricing,
  access grants, operation conflict/replay, order-item immutability, concurrent
  reset rotation, and cleanup. Teardown left zero matching ephemeral schemas
  and zero ONSALE tables in `public`.

The pure inventory state and SQL schema are complementary, not dual authorities.
Use the pure reducer as a contract/oracle in tests. Neon transaction time, locks,
constraints, and committed rows are authoritative at runtime.

## Required Neon payment extension

Before provider-backed frontend work, add the durable records already specified
in `docs/DURABLE-DOMAIN-MODEL.md`:

1. one `payment` per order, containing the stable merchant/provider identity,
   immutable amount/currency, normalized state, canonical status, version, and
   last observation time;
2. append-mostly `payment_attempt` rows with unique provider/logical attempt
   identity and method/processor details;
3. append-only `payment_observation` rows for create response, retrieve, browser
   return marker, and later verified webhook inputs;
4. `idempotency_operation` support for `external_pending`, provider operation
   reference, and crash recovery;
5. one `fulfillment` per paid order plus exactly one `ticket` per `order_item`,
   committed atomically;
6. sanitized `evidence_record` rows that distinguish `observed_live`,
   `merchant_rule`, `recorded_replay`, `simulation`, and `unproven`.

Provider I/O must use the T4 split transaction: reserve the stable operation in
Neon, release the database lock, call Hyperswitch, then persist the observation
in a second transaction. Unknown transport leaves `external_pending`/`uncertain`
and permits retrieve only. No client secret, hosted-action URL, raw redirect,
PAN/CVC, raw webhook, or provider credential is durable.

## Public projection shared by canvas and rail

Both panes must render one sanitized response rather than maintain parallel
state machines. The exact names may change during type review, but the shape
must preserve these independent facts:

```ts
interface OnsalePublicSnapshot {
  revision: number
  customerState:
    | "event" | "eligibility" | "hold" | "checkout" | "action"
    | "success" | "hard_decline" | "recoverable"
  event: { publicRef: string; saleWindow: string; seats: PublicSeat[] }
  hold: { publicRef: string; status: string; expiresAt: string | null }
  order: {
    publicRef: string
    status: string
    currency: string
    subtotalMinor: number
    feeMinor: number
    taxMinor: number
    totalMinor: number
    items: PublicOrderItem[]
  } | null
  payment: {
    status: string
    canonicalStatus: string
    nextActionPresent: boolean
    methodFamily: string | null
    connector: string | null
    attempts: PublicAttempt[]
    chargedAttemptCount: number
    retry: { permitted: boolean; reason: string | null }
  } | null
  fulfillment: {
    status: string
    ticketCount: number
    tickets: PublicTicket[]
  } | null
  evidence: SanitizedEvidenceEvent[]
}
```

Provider `unknown`/`uncertain` state projects to the buyer-facing
`recoverable` composition with a retrieve-only action; it is not a ninth
customer-state selector or permission to create/confirm again.

The checkout-create response may additionally contain a short-lived
`clientSecret` and the public, V1-scoped publishable key for the official SDK.
Neither value is part of this snapshot, the rail, logs, evidence, or Neon.

## Exact Figma frontend seams

| Baseline seam | Backend inhabitation | Preservation rule |
| --- | --- | --- |
| `src/App.tsx:16-50` | Keep `AppState` only as a presentation projection. Replace fixed event/order/payment values with snapshot props/public refs. | Do not change tokens or screen vocabulary. Customer state is derived from the server snapshot, never selected by a timer. |
| `src/App.tsx:243-310` (`Shell`) | Supply sanitized order reference and evidence classification. Render hosted/sandbox badges only when the current state has that evidence. | Preserve the 72/28 grid, one-pixel cobalt divider, header, bottom strip, canvas/rail relationship, and DOM order. |
| `src/App.tsx:315-545` (event/access) | Read event and sale-window state; send explicit server access/queue commands. Until access proof exists, label the state merchant rule or unproven. | Preserve hero, PHANTOM CIRCUIT hierarchy, sale cards, VERIFY ACCESS, JOIN QUEUE, and entrance choreography. |
| `src/App.tsx:548-709` (`StageProscenium`) | None. It is a visual constant. | Leave geometry, paths, view box, labels, and styling untouched. |
| `src/App.tsx:714-855` (`HoldScreen`) | Replace `TAKEN`, local selection ownership, arithmetic, and countdown authority with public seats, server-computed totals, claim/release operations, and `expiresAt`. Local selection may be optimistic only before submit; conflicts replace it from the returned snapshot. | Keep six-by-ten spatial DOM, selected/taken treatments, proscenium placement, summary hierarchy, four-seat cap, immediate hover/selection, and continuous visual countdown. Expiry is a server transition followed by refresh, not a client assertion. |
| `src/App.tsx:858-993` (`CheckoutScreen`) | Replace only the fake tabs/card fields/simulate control at `874-936` with the official Unified Checkout mount and merchant submit controller. Replace the generated webhook JSON at `963-988` with sanitized current-order evidence from create/retrieve. Populate the existing order summary from immutable order items. | Preserve the checkout heading, two-column grid, Hyperswitch label/frame, order-card DOM, assurance language position, and authored styling. The official widget owns payment-method fields and method selection. |
| `src/App.tsx:995-1056` (`ActionRequiredOverlay`) | Remove the fake bank, OTP input, and merchant authentication buttons. The observed card and Klarna cases both left the page for a top-level Hyperswitch sandbox action; on return this visual seam may show only merchant-owned `Verifying payment` continuity while same-payment retrieval runs. Future in-widget actions remain inside the official SDK. | Preserve state continuity and restrained entrance motion, but never clone or frame the provider challenge. The Klarna receipt authorizes action-required continuity only, not a merchant-owned Klarna overlay or terminal result. |
| `src/App.tsx:1059-1160` (decline/recoverable) | Populate canonical status, attempt count/state, charged count, ticket count, hold state, and retry permission from the snapshot. Use `unknown` to offer `Check same payment`, not another confirm. | Preserve the respectful compositions and motion. Do not infer `bank`, released/preserved hold, retry allowance, failover, or `$0 attempted`; say what retrieval actually observed. |
| `src/App.tsx:1163-1290` (`SuccessScreen`) | Populate order items/totals, observed connector, and issued tickets. The authored large ticket may remain a bundle cover, with one durable ticket/reference per selected seat. QR/download/email stay unavailable until their real boundary exists. | Preserve ticket art, receipt hierarchy, ticket entrance, dark/cobalt language, and no-premature-celebration rule. Never render success from an SDK return alone. |
| `src/App.tsx:1293-1440` (root coordinator) | Replace local timers, random processors/outcomes, nested `setTimeout`, and client `total` with a `useOnsaleSession` controller that fetches one snapshot and sends idempotent commands. Use snapshot revision/evidence ID as the replay key. | Preserve the existing conditional screen slots and their DOM. No client callback may advance payment or fulfillment beyond the server response. |
| `src/MechanismRail.tsx:18-22` | Replace scalar `flowState/processor/animKey` inputs with a presentation projection of the shared snapshot, or add that projection immediately above the component. | Keep the component visual boundary and stable render location. |
| `src/MechanismRail.tsx:42-230` | Activate the existing Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Webhook/Retrieve → Merchant → Ticket topology from sanitized evidence. Use Retrieve for the observed card cases; keep Webhook dim/unobserved. | Preserve SVG geometry, line-before-signal timing, current-actor glow, terminal glyphs, and two-dimensional treatment. No decorative 3D or new topology. |
| `src/MechanismRail.tsx:269-420` | Replace all hard-coded policy, selection, attempts, money, hold, ticket, timestamp, IDs, and payload values with the public projection. | Preserve Policy → Decision → Attempts → State → Evidence order, panel DOM, open-by-default behavior, typography, and transitions. Missing evidence renders `UNPROVEN`/`NOT OBSERVED`, not invented data. |
| `src/MechanismRail.tsx:425-488` | Build sequence labels and state narrative from the observation source and canonical state. A retrieve must not be described as a signed webhook. | Preserve sequence layout, active-edge motion, dot pulse, and narrative placement. |
| `src/MechanismRail.tsx:491-542` | Make badges, ticket state, and `animKey` evidence-driven. | Preserve export wrapper, graph position, five-panel order, and motion-contract block. Unconditional `LIVE HOSTED` must disappear. |

## Smallest reviewable Next.js migration sequence

Each slice has one architectural purpose, a reversible commit, and a proof
receipt. Do not combine the runtime migration, data cutover, checkout mutation,
and rail rewrite into one review.

1. **Runtime parity only.** Add a thin `"use client"` Next.js wrapper that imports
   the existing `App`; load `src/index.css` from the App Router layout. Keep
   `src/App.tsx`, `src/MechanismRail.tsx`, and `src/index.css` byte-identical and
   keep Vite as a temporary comparison runner. Pass Next production build, DOM
   snapshots, and the nine 1440x1000 baseline comparisons. No API, Neon, SDK, or
   copy change enters this slice.
2. **Neon inventory repository only — complete.** The repository behind the
   current domain and `0001` schema passed isolated-schema contention,
   all-or-nothing four-seat claims, database-time expiry, release/conversion,
   cancellation, immutable pricing/items, operation replay/conflict, reset
   rotation, and cleanup tests. No React component changed.
3. **Event/seat/hold inhabitation.** Add session/snapshot/command routes and a
   client controller. Feed the existing event, access, seat, hold, and order
   components while preserving their DOM and motion. Prove two buyers cannot own
   one seat, one-to-four-seat totals are server-owned, refresh retains the hold,
   and expiry/release updates all seats.
4. **Payment persistence and adapter.** Add payment/attempt/observation/
   fulfillment/ticket/evidence migrations and reducers; re-author the V1 adapter
   and checkout routes around the stable order payment. Run create idempotency,
   unknown/retrieve, monotonicity, concurrent reconcile, and atomic four-ticket
   tests. No checkout widget or rail change yet.
5. **Official checkout slot.** Install the official SDK boundary only inside
   `CheckoutScreen:874-936`. Wire create, one confirm, redirect return, and
   reconcile to the new routes. Re-run the dated card success and hard-decline
   cases with fresh identities plus pointer and keyboard activation. Preserve
   the rest of checkout DOM. PayPal and Klarna may remain widget-visible, but no
   merchant-specific outcome is claimed.
6. **Results and rail projection.** Drive checkout evidence, decline/recovery,
   success/tickets, and all five rail panels from the same public snapshot.
   Replay only recorded evidence; distinguish observed retrieve, merchant rule,
   recorded replay, and unproven webhook/routing. Pass baseline visual/motion
   regression plus no-premature-ticket and no-fake-live-claim assertions.
7. **Method-specific follow-ons.** Klarna action initiation is now observed;
   terminal Klarna completion/rejection and PayPal activation remain separate
   bounded browser units. A passed receipt may add method-specific explanation
   to the shared projection; it does not authorize a redesigned checkout or
   copied provider UI. Routing and signed webhooks remain later, independent
   gates.

Deployment, routing mutation, webhook configuration, refunds, ticket revocation,
and the ops console remain outside this port. Release stays closed until human
visual review, production build, browser/HCI regressions, secret scan, and an
explicit deployment decision.
