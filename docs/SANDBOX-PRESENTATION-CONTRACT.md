# ONSALE sandbox presentation contract

Status: binding integration and regression contract; no UI-change authorization

Prepared: 2026-08-08

Figma baseline: `8dede8f296f2d74359e8d1e95734687e18c5a8e5`

Evidence cut: the secret-clean receipts dated 2026-08-08

## Decision

Hyperswitch inhabits the untouched Figma checkout and Mechanism Rail; it does
not replace their design language.

- The official Unified Checkout SDK exclusively owns payment-method discovery,
  selection, fields, validation, and any action it can render in-widget.
- The Figma checkout seam owns the surrounding heading, order summary,
  all-in amount, assurance copy position, merchant submit, and continuity.
- The card and Klarna browser receipts both observed a **top-level**
  Hyperswitch sandbox authorization page. ONSALE must allow that navigation. It
  must not force, frame, or imitate the provider action as an overlay.
- The Figma action composition becomes a merchant-owned continuity and
  reconciliation state. It never contains a bank, OTP, hosted Complete/Reject
  controls, or a copy of the provider page.
- A browser return is only a prompt to retrieve the same payment. Canonical
  money, attempt, order, and ticket state comes from the server projection.
- The customer canvas and Mechanism Rail consume one sanitized snapshot. They
  cannot run independent timers, outcomes, processor selection, or fulfillment
  state machines.
- Motion remains authored and causal by default. It visualizes a recorded state
  transition; it does not create or imply one.

This contract deliberately leaves `src/App.tsx`, `src/MechanismRail.tsx`, and
`src/index.css` untouched. It specifies the later reviewed integration seam.

## Evidence precedence

When sources disagree, the presentation uses this order:

1. same-payment server retrieval or a future verified webhook for canonical
   provider state;
2. a dated browser observation using the official SDK for presentation and
   navigation behavior;
3. current-order official widget visibility for the methods shown now;
4. secret-clean API discovery or configuration reads for capability context;
5. merchant-owned policy and product decisions;
6. recorded replay or deterministic simulation, visibly labelled as such;
7. source comments, fixture names, mockup copy, and visual references.

Consequences:

- The later browser receipts supersede the early same-page-action assumption.
- A fixture called insufficient funds cannot override a returned success.
- API eligibility cannot force a method into the buyer UI when the official
  widget does not render it for that order.
- A selected payment method and an observed connector are different facts.
- A profile setting such as automatic retry does not prove that a retry or
  failover occurred for an order.

## Proof classes and exact labels

| Class | Buyer/rail label | When permitted | What it never means |
| --- | --- | --- | --- |
| Current-order observation | `LIVE SANDBOX · CURRENT ORDER` | A fact returned for this current sandbox order by the official widget, command response, or server retrieve | Production behavior, a population metric, or an unobserved later step |
| Canonical retrieval | `SERVER RETRIEVE` | The server retrieved this same payment and the public snapshot contains the result | Signed webhook delivery or provider reliability |
| Merchant-owned rule | `MERCHANT RULE` | ONSALE owns the rule, such as sale window, four-seat limit, hold policy, or retrieve-before-retry | A Hyperswitch routing rule or provider decision |
| Recorded observation | `RECORDED SANDBOX · 2026-08-08` | A read-only `/flows` replay or capability note cites a dated sanitized receipt | Activity occurring for the current buyer |
| Simulation | `SIMULATION · NO LIVE REQUEST` | A deterministic reviewer-only fixture is running on `/flows` | Provider evidence, a customer outcome, or a sandbox mutation |
| Missing proof | `UNPROVEN` or `NOT OBSERVED` | A path is configured, possible, deferred, or absent from the current evidence | Failure, unsupported capability, or permission to invent a result |

`LIVE HOSTED` is not a global badge. If retained at all, it must be replaced by
the narrower `LIVE SANDBOX · CURRENT ORDER` label and appear only beside the
specific current-order fact it describes. A recorded receipt never causes a
current-order edge to animate.

## What the evidence establishes

| Case | Observed fact | Presentation authorized | Still unproven |
| --- | --- | --- | --- |
| Official mount | Card, Klarna, and Affirm rendered in the initial official widget. A later fresh inspection also exposed Google Pay and PayPal. | Mount the official widget in the existing checkout slot and report only its current visible methods. | Google Pay usability; method persistence across profiles and browsers |
| PayPal visibility | PayPal was visibly present for one fresh intent; its inspected control was unlabeled; there were zero attempts and tickets. | Let the official widget show PayPal and preserve the accessibility finding as a dated note. | Activation, naming across configurations, popup/redirect, login, authorization, capture, or return |
| Card success | One SDK confirmation opened a top-level hosted authorization page; Complete returned to the same order; retrieve observed one succeeded `stripe_test` attempt, one charged attempt, one logical charge, and one ticket. Repeat return changed no counts. | Top-level action continuity, same-payment return/retrieve, and a dated card-success rail replay. | Rebuilt pointer/keyboard submit, multi-seat fulfillment, webhooks, routing, production reliability, or an overlay |
| Card hard decline | One SDK confirmation plus retrieve produced `failed`, one `stripe_test` hard-decline attempt, zero charged attempts, zero logical charges, zero tickets, and no cascade. | Populate the respectful decline composition and one-attempt rail from server state. | Automatic retry/failover, another method, other decline families, or production issuer behavior |
| Klarna action | The official Klarna tab was selected. One confirm opened a top-level Hyperswitch sandbox action. Retrieve returned `requires_customer_action`, one `requires_action` attempt on `stripe_test`, zero charges, and zero tickets. | Show official method selection, leave for top-level action, and restore merchant continuity with the action-required state after retrieve. | Complete/Reject, terminal Klarna return, direct Klarna processing, an overlay, or production Klarna behavior |
| Unknown outcome | Retrieve-before-retry is a merchant safety rule with source and harness tests; no bounded browser interruption receipt exists. | Implement the real current-order `unknown` state as retrieve-only when the server produces it; replay the dated source case only as recorded evidence. | The exact browser interruption presentation and timing |
| Webhook/routing | No active webhook or payment-routing algorithm was returned for the supplied profile. Observed terminal browser cases reconciled by retrieve. | Keep Retrieve active for these traces; keep Webhook and routing/fallback dim and `UNPROVEN`. | Signed webhooks, rule matches, connector switching, failover, least-cost, volume split, or payout routing |

The one-ticket success receipt is adapter evidence from the superseded one-seat
harness. The Figma success state remains blocked until the main prototype proves
atomic one-ticket-per-order-item fulfillment for a multi-seat order.

## Interpretation of the supplied screenshots

The two supplied images are `design_reference`, not payment evidence.

### Provider authorization reference

The wide screenshot shows a top-level Hyperswitch **Test Payment Page** with a
method mark, a test processor mark, an amount, Complete/Reject actions, and an
integration-testing disclaimer. Browser chrome and a raw dummy-attempt URL are
visible.

Contract:

- It reinforces the observed top-level ownership boundary.
- ONSALE must not embed, redraw, restyle, screenshot-clone, or intercept this
  page.
- Complete and Reject remain provider-owned controls.
- Its method, amount, processor mark, and URL do not describe the ONSALE order.
- If the image is ever used in a report, browser identifiers must be fully
  redacted. It is not a runtime asset.

### Checkout playground reference

The narrow screenshot shows a compact payment hierarchy: sandbox context,
official-looking wallet/method controls, card fields, and a single pay action.

Contract:

- Its hierarchy can inform how much surrounding space the Figma checkout slot
  reserves for the official widget.
- Its colors, fields, sample values, fixed methods, amount, and buttons must not
  be copied into merchant JSX.
- The official widget decides which controls appear. ONSALE may use only the
  SDK-supported appearance configuration to align typography, cobalt, sharp
  corners, and focus treatment.
- A method logo is a presentation aid, never evidence that its connector was
  selected or attempted.

## Typed presentation projection

The adapter from the public server snapshot to the untouched Figma components
must be pure and secret-free. The exact field names may change in type review,
but it must preserve these distinctions:

```ts
type ProofClass =
  | "observed_current_order"
  | "server_retrieve"
  | "merchant_rule"
  | "recorded_sandbox"
  | "simulation"
  | "unproven"

type PresentationOwner =
  | "merchant_canvas"
  | "official_unified_checkout"
  | "provider_top_level"

type CheckoutStage =
  | "not_mounted"
  | "mounting"
  | "ready"
  | "submitting"
  | "left_for_action"
  | "returned"
  | "reconciling"
  | "locked"

type RailActor =
  | "buyer"
  | "merchant"
  | "hyperswitch"
  | "processor"
  | "reconcile"
  | "ticket"

type RailEdge =
  | "buyer_to_merchant"
  | "merchant_to_hyperswitch"
  | "hyperswitch_to_processor"
  | "processor_to_hyperswitch"
  | "hyperswitch_to_reconcile"
  | "reconcile_to_merchant"
  | "merchant_to_ticket"

interface SandboxPresentationProjection {
  revision: number
  canvasState:
    | "event" | "eligibility" | "hold" | "checkout" | "action"
    | "success" | "hard_decline" | "recoverable"
  checkout: {
    stage: CheckoutStage
    owner: PresentationOwner
    confirmLocked: boolean
    selectedMethod: { family: string; label: string } | null
    visibleMethods: Array<{ family: string; label: string }>
    topLevelActionObserved: boolean
  }
  order: {
    status: string
    itemCount: number
    currency: string
    totalMinor: number
    holdExpiresAt: string | null
  } | null
  payment: {
    canonicalStatus: string
    nextActionPresent: boolean
    connector: string | null
    attempts: Array<{
      ordinal: number
      status: string
      methodFamily: string | null
      connector: string | null
      charged: boolean | null
    }>
    chargedAttemptCount: number
    retryPermitted: boolean
    retryReason: string | null
  } | null
  fulfillment: {
    status: string
    ticketCount: number
    requiredTicketCount: number
  } | null
  rail: {
    currentActor: RailActor | null
    observedEdges: RailEdge[]
    possibleUnobservedEdges: RailEdge[]
    sequenceLabel: string
  }
  proof: Array<{
    class: ProofClass
    label: string
    observedAt: string | null
    sanitizedRef: string | null
  }>
}
```

This projection contains no payment/session/provider identifier, client secret,
publishable key, hosted-action URL, redirect payload, PAN/CVC, billing identity,
raw webhook, or provider response.

## Checkout seam contract

Target: the left side of the existing `CheckoutScreen` two-column grid.

### Preserve

- `Secure checkout` heading and explanatory-copy position;
- `HYPERSWITCH UNIFIED CHECKOUT` label and bordered frame;
- two-column checkout/order-summary relationship;
- cobalt, white, sharp corners, hairlines, Inter/JetBrains Mono hierarchy;
- all-in order summary populated from immutable server order items;
- authored entrance and state-continuity motion.

### Replace inside the existing frame

- Delete the merchant-drawn Card/G Pay/Klarna tabs, card inputs, masked test
  values, customer name, and fake TLS/orchestrated header.
- Mount only `HyperElements` plus `UnifiedCheckout` after one stable order and
  one `confirm=false` payment intent exist.
- Show only the methods the current widget renders. Method visibility may
  change without changing merchant JSX.
- Use the supported SDK appearance interface to request baseline-compatible
  fonts, cobalt, square corners, focus, and error colors. Do not reach into a
  cross-origin frame or clone its markup to achieve visual parity.
- Keep one merchant submit immediately below the official widget in the same
  frame. It displays the server total, is disabled until the SDK is ready and
  complete, locks synchronously on activation, and can call `confirmPayment`
  at most once for that operation.
- Remove `SIMULATE PAYMENT FLOW` from the buyer route. Deterministic replay
  belongs on `/flows` with zero live requests.

The existing right-side fake `LIVE WEBHOOK FEED` becomes a sanitized current
order evidence surface without changing the column or typographic hierarchy.
It may show canonical status, selected method, observed connector, attempt
count, charged count, reconciliation source, and proof label. It may not show
raw JSON, hard-coded IDs, invented timestamps, or a signed-webhook claim.

## Provider action and merchant continuity

### Before navigation

1. Persist the stable order/payment operation on the server.
2. Lock the submit control before invoking the SDK.
3. Keep the rail on the currently observed actor/edge; do not pre-animate a
   processor, action, return, or result.
4. Let the SDK choose in-widget handling or top-level navigation.

### Top-level action

For the observed card and Klarna cases, the provider top-level page owns the
entire viewport. The ONSALE canvas and rail are not simultaneously visible.
This is expected continuity, not a layout failure.

ONSALE must not:

- open the page in a merchant modal or iframe;
- copy its branding, method/processor marks, amount card, or test explanation;
- reproduce Complete/Reject/Authenticate/Cancel controls;
- inject a bank name, OTP field, phone suffix, or buyer identity;
- claim the hold is extended merely because the provider page is open.

### Return and retrieval

1. Rehydrate the same order from an opaque merchant reference.
2. Treat the return marker as non-authoritative evidence.
3. Render the Figma action seam as merchant continuity: `RETURN RECEIVED` and
   `CHECKING THIS SAME PAYMENT` with the held-order summary still recognizable.
4. Issue one idempotent server retrieve of the same payment.
5. Project only the returned canonical state:
   - `succeeded` plus valid amount/charged-attempt invariants proceeds to atomic
     fulfillment, then success;
   - terminal non-retryable failure proceeds to hard decline;
   - `requires_customer_action` stays in action continuity without another
     confirm;
   - `processing` stays locked and checkable;
   - `unknown` proceeds to recoverable with `CHECK SAME PAYMENT`, never create
     or confirm;
   - retryable failure exposes another method only when the server returns an
     explicit merchant-approved retry decision.
6. Replaying a return performs retrieve only. A terminal payment never remounts
   a confirmable widget.

The current Klarna receipt stops at `requires_customer_action`. It does not
authorize a terminal Klarna return composition.

## Action composition contract

The Figma modal geometry, cobalt header, restrained fade/translate motion, and
continuity role may remain. Its simulated provider contents must not.

Permitted merchant content:

- `PAYMENT ACTION IN PROGRESS` before the page leaves, if it renders at all;
- `RETURN RECEIVED` after the merchant route rehydrates;
- `CHECKING THIS SAME PAYMENT` while retrieve is in flight;
- server-owned order total, item count, and hold status;
- `DO NOT RESUBMIT` when payment is action-required, processing, or unknown;
- a single retrieve-only status action after a recoverable transport failure.

Forbidden content:

- `CHASE BANK`, another invented issuer, or a provider logo not supplied by the
  current official surface;
- OTP input, masked phone, fake authentication copy, or local Authenticate;
- merchant Complete/Reject/Cancel actions that imitate the provider page;
- a promise that abandonment creates no charge;
- an assertion that the hold remains active without a fresh server snapshot.

If a future official SDK renders an action inside Unified Checkout, it stays in
the SDK frame. That future observation does not reactivate the fake merchant
modal.

## Mechanism Rail projection

The existing two-dimensional geometry, actor positions, line-before-signal
timing, current-node glow, message-sequence area, and five panels remain. The
rail is made more truthful through data and labels, not a new 3D diagram.

### Stable topology

`Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Reconcile → Merchant → Ticket`

The existing Webhook position becomes the reconciliation position without
moving its rectangle:

- show `RETRIEVE` as the active subpath for the dated card, decline, and Klarna
  traces;
- show `WEBHOOK · UNPROVEN` as a dim alternative;
- never merge them into `signed_webhook · server_retrieve`;
- activate Webhook only after signature verification, deduplication, and a
  dated live receipt pass their separate gate.

### Edge and actor rules

- A possible edge is dim/dashed. An edge becomes solid only when the current
  order has a corresponding sanitized observation.
- Draw the edge before its signal travels. The signal runs once per new
  snapshot revision/evidence event, not on a timer loop.
- Glow only the current actor. Ambient pulsing may indicate an unresolved
  current transition, not background activity.
- Do not show a processor before an attempt observation supplies it.
- Keep method and connector separate. For the Klarna action receipt, the rail
  says `METHOD · KLARNA` and `CONNECTOR · STRIPE TEST`; it does not place a
  Klarna processor node or animate failover.
- A recognizable processor mark may accompany an observed test connector only
  when its adjacent text says `TEST`. The text field remains authoritative;
  the logo is never proof.
- Ticket activates only after server reconciliation and the main-prototype
  fulfillment transaction has issued exactly one ticket per order item.

### Current observed case projections

| Current state | Solid path | Current actor / terminal glyph | Ticket |
| --- | --- | --- | --- |
| Widget mounted; no submit | Buyer → Merchant → Hyperswitch | Hyperswitch; awaiting method | Dim, not issued |
| Klarna action receipt | Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Retrieve → Merchant | Merchant/action warning after retrieve; method Klarna, connector `stripe_test`, attempt `requires_action` | Dim, zero |
| Card hard decline | Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Retrieve → Merchant | Processor/merchant failure glyph; one hard-decline attempt, zero charged | Dim, zero |
| Card reconciled success | Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Retrieve → Merchant | Merchant success only after canonical retrieve | Ticket edge remains blocked until durable main-prototype fulfillment; recorded one-seat replay may show its dated historical ticket |
| Current unknown | Only edges already observed for this order plus the Retrieve loop | Reconcile warning; `RETRIEVE ONLY` | Dim, zero unless prior durable fulfillment already exists |
| PayPal visibility | Buyer → Merchant → Hyperswitch | Hyperswitch; visible method only, attempts zero | Dim, zero |

### Five stable panels

1. **Policy** — sale window, access rule, seat limit, hold policy, and
   retrieve-before-retry carry `MERCHANT RULE`. Payment routing, fallback, and
   automatic retry remain `UNPROVEN` for the current order.
2. **Decision** — current visible/selected method comes from the widget;
   connector comes from an observed attempt; routing rule match is blank or
   `NOT OBSERVED`. Do not invent `connector_a`, `connector_b`, or fallback.
3. **Attempts** — one row per returned attempt: ordinal, method family,
   connector, normalized state, charged fact, and retry decision. No hard-coded
   timestamps or `$0 not charged` unless retrieval supplied the charged count.
4. **State** — order, hold, payment, money, fulfillment, and ticket counts come
   from one snapshot. `requires_customer_action` is not authorized money;
   `succeeded` is not issued fulfillment.
5. **Evidence** — proof class, source (`OFFICIAL WIDGET`, `SERVER RETRIEVE`,
   `MERCHANT RULE`, or dated recording), sanitized reference, observed time,
   and redaction version. No raw payload, provider code dump, or identifier.

The panels stay in Policy, Decision, Attempts, State, Evidence order and remain
open by default on desktop.

## State copy grammar

| Canonical situation | Permitted primary copy | Forbidden implication |
| --- | --- | --- |
| Widget ready | `CHOOSE A PAYMENT METHOD` | A method was attempted |
| Submit locked | `STARTING SECURE PAYMENT` | A processor accepted it |
| Top-level action | `CONTINUE IN THE HYPERSWITCH SANDBOX` | In-panel completion or a named bank |
| Merchant return | `RETURN RECEIVED` | Payment succeeded |
| Retrieve in flight | `CHECKING THIS SAME PAYMENT` | Creating or confirming another payment |
| Action still required | `CUSTOMER ACTION STILL REQUIRED` | A charge or terminal failure |
| Processing | `PAYMENT IS STILL PROCESSING` | Safe retry or ticket issuance |
| Unknown | `OUTCOME UNKNOWN · CHECK SAME PAYMENT` | Decline, no charge, or permission to resubmit |
| Retrieved hard decline | `PAYMENT NOT APPROVED` and `NO TICKET ISSUED` | Automatic fallback or issuer diagnosis |
| Retrieved success before fulfillment | `PAYMENT CONFIRMED · ISSUING TICKETS` | Tickets already exist |
| Fulfilled success | `PAYMENT CONFIRMED` plus exact issued ticket count | One visual ticket equals several durable tickets |

## Never copy, synthesize, or claim

- The superseded `v01` checkout wrapper, inline styling, one-seat layout, or
  reduced-motion default.
- Merchant-drawn Card, Google Pay, Klarna, Affirm, or PayPal selectors.
- Static card fields, masked card values, names, billing details, fake TLS, or
  fake SDK headers.
- The dummy authorization page, its browser URL, raw attempt reference,
  Complete/Reject controls, test amount, processor mark, or explanatory copy.
- The fake 3DS/issuer modal, OTP, phone suffix, Authenticate/Cancel controls, or
  bank identity.
- `SIMULATE PAYMENT FLOW` on the buyer route.
- Generated webhook JSON, `signed event`, `LIVE WEBHOOK FEED`, or unconditional
  `LIVE HOSTED`.
- Hard-coded payment/order/ticket IDs, timestamps, totals, connector names,
  policy versions, or payload snippets.
- Random processor selection, timer-driven outcomes, automatic connector
  cascade, fallback animation, or multiple attempts without a dated trace.
- Google Pay, PayPal, Klarna, or Affirm completion from visibility alone.
- A Klarna connector from Klarna method selection; the observed action attempt
  reported `stripe_test`.
- Success, money received, release, preserved hold, retry eligibility, or
  ticket issuance from an SDK callback, return marker, fixture label, or client
  timer.
- Provider secrets, raw URLs/payloads, customer identity, PAN/CVC, redirect
  tokens, or raw webhook material in snapshots, rail panels, captures, logs, or
  evidence.

## Review and regression gate

The checkout/rail frontend slice remains blocked until its review packet proves:

1. the baseline state captures remain visually recognizable outside the exact
   checkout/action data seams;
2. official Unified Checkout is the only rendered method/field surface;
3. current visible methods are discovered from that mounted widget;
4. pointer and keyboard activation each call the merchant submit handler once;
5. double activation cannot create a second SDK confirm or provider identity;
6. the observed provider top-level navigation is allowed without a forced
   iframe or overlay;
7. return rehydrates the same order and performs same-payment retrieve before a
   terminal canvas state;
8. repeat return performs retrieve only and leaves attempt, charge,
   fulfillment, and ticket counts unchanged;
9. hard decline renders one attempt, zero charged attempts, no cascade, and no
   ticket;
10. Klarna action renders method and connector as separate facts and stops at
    `requires_customer_action` for the current receipt;
11. Webhook, routing, failover, PayPal activation, wallet completion, and
    unknown-browser behavior remain visibly `UNPROVEN`;
12. the rail and canvas match the same snapshot revision and evidence IDs;
13. the ticket edge cannot activate before atomic one-ticket-per-item
    fulfillment succeeds;
14. desktop and narrow browser captures preserve the Figma hierarchy and do
    not crop the official widget or continuity state;
15. no secret, raw identifier/URL, provider payload, fake payment field,
    unconditional live claim, or copied dummy-page content enters source or
    evidence.

No deployment, routing mutation, webhook configuration, source edit, or live
provider action is authorized by this contract.

## Evidence references

Secret-clean receipts used:

- `../v01/artifacts/sandbox/20260808-hyperswitch-browser-mount-preflight/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-browser-paypal-visibility/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-browser-3ds-completion/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-browser-hard-decline/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-browser-klarna-action/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-v1-env-pairing/RECEIPT.md`
- `../v01/artifacts/sandbox/20260808-hyperswitch-v1-recon/RECEIPT.md`

The two supplied screenshots were inspected as visual references only. Their
raw browser chrome, sample values, and identifiers were not transcribed into
this contract.
