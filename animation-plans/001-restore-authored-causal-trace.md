# 001 — Restore the authored causal trace and amber signal

- **Status**: TODO
- **Commit**: 340e336
- **Severity**: HIGH
- **Category**: Purpose and frequency; easing and duration; accessibility; cohesion and tokens; missed opportunity
- **Estimated scope**: 8 files, approximately 450–650 changed lines

## Problem

The current production rail is evidence-safe, but it has flattened the binding
Figma motion contract into a generic node diagram. This is not a polish issue:
the motion was the explanation of payment causality.

The binding contract at `docs/FIGMA-EXPERIENCE-CONTRACT.md:34-64` requires the
relevant line to draw before a travelling signal, only the current actor to
glow, Ticket to activate only after server reconciliation, and Policy,
Decision, Attempts, State, and Evidence to remain in that order and open on
desktop. `docs/SANDBOX-PRESENTATION-CONTRACT.md:349-385` further requires one
signal run per new evidence event, separate Retrieve and unproven Webhook paths,
and no connector before an observed attempt.

Four implementation choices currently break that teaching sequence.

### 1. The signal is blue, short-lived, and absent from most meaningful states

```tsx
// src/PaymentTraceMap.tsx:191-203 — current
{activePath && frame.animateSignal !== false && (
  <circle
    className="payment-trace-signal"
    key={`${frame.activeEdge}:${frame.revision}`}
    r="4"
  >
    <animateMotion
      dur="720ms"
      fill="freeze"
      path={activePath}
      repeatCount="1"
    />
  </circle>
)}
```

```css
/* src/index.css:790-793 — current */
.payment-trace-signal {
  fill: #006df9;
  filter: drop-shadow(0 0 4px rgba(0, 109, 249, 0.8));
}
```

The preserved baseline used an amber `#F59E0B` signal with an amber glow, drew
the line first, and then moved the signal along the same path. The current
renderer instead presents a blue dot for 720 ms and parks it under the target
node. There is no persistent unresolved-state token.

### 2. The live projection supplies an active edge only while confirming or retrieving

```tsx
// src/MechanismRail.tsx:1710-1715 — current
const activeEdge: PaymentTraceEdgeIdV1 | null =
  checkout.requestState === "confirming" && hasConnector
    ? "hyperswitch_connector"
    : reconciling
      ? "hyperswitch_retrieve"
      : null
```

Checkout-ready, returned action, processing, terminal decline, review, and
fulfillment therefore have no causal handoff animation. The node inspector
also jumps to the derived target immediately, before the signal could arrive:

```tsx
// src/MechanismRail.tsx:1777-1782 — current
const [selectedNode, setSelectedNode] = useState<PaymentTraceNodeIdV1>(
  derived.activeNode,
)

useEffect(() => setSelectedNode(derived.activeNode), [derived.activeNode, revision])
```

### 3. The authored topology and explanatory rail anatomy were replaced

The current `PaymentTraceMapV1` defines nine same-weight boxes
(`buyer`, `onsale_order`, `seat_hold`, `hyperswitch`, `connector`,
`provider_action`, `retrieve`, `onsale_fulfillment`, `tickets`) at
`src/PaymentTraceMap.tsx:3-12,68-116`. It also adds marker arrows at
`src/PaymentTraceMap.tsx:169-187`. Those arrows were not in the baseline and
compete with crossing paths and node labels.

The baseline's six actor positions and curved return paths still exist in the
unused legacy graph at `src/MechanismRail.tsx:44-130,224-417`. Its topology is
recognizable at a glance: Buyer and Merchant on the left, Hyperswitch and the
observed Connector as a two-lane exchange, Reconcile at upper right, and Ticket
at the bottom. The current production branch bypasses that graph and renders
only the map, one transition card, and two details blocks at
`src/MechanismRail.tsx:1811-1866`; it does not render the already truth-safe
`InventorySequenceLegend` and `InventoryPanels` implementations at
`src/MechanismRail.tsx:732-1142`.

### 4. Replay timing is disconnected from the graphic

```tsx
// app/flows/FlowsGallery.tsx:319-323 — current
useEffect(() => {
  if (state.mode !== "playing") return
  const timer = window.setInterval(() => dispatch({ type: "tick" }), 1900)
  return () => window.clearInterval(timer)
}, [state.mode])
```

```tsx
// app/flows/FlowsGallery.tsx:245-251 — current
return {
  revision: `${flow.id}:${stepIndex}:${mode}`,
  nodes,
  edges,
  activeEdge,
  animateSignal: mode === "playing",
  ariaLabel: `${flow.label}, step ${stepIndex + 1} of ${flow.steps.length}`,
}
```

A 720 ms signal followed by roughly 1.18 seconds of nothing does not explain
the step. Previous Runs intentionally load in `complete` mode, so their map is
entirely static; there is no clear authored replay entry point inside the
graphic.

## Vetted findings

| # | Severity | Category | Location | Finding | Fix summary |
| --- | --- | --- | --- | --- | --- |
| 1 | HIGH | Purpose and cohesion | `src/PaymentTraceMap.tsx:68-203` | The shared trace replaced the binding six-actor causal composition with nine generic boxes and broken-looking arrowheads. | Restore the baseline geometry in the shared renderer and communicate direction through labels plus one amber signal. |
| 2 | HIGH | Purpose and timing | `src/MechanismRail.tsx:1710-1782` | Live evidence updates the inspector before causal arrival and emits no signal for most states. | Add one evidence-event motion descriptor and commit the target/inspector only after arrival. |
| 3 | HIGH | Easing and choreography | `src/PaymentTraceMap.tsx:191-203`, `src/index.css:766-793` | The edge and dot animate as unrelated blue effects rather than line-before-amber-signal causality. | Use explicit draw, 70 ms handoff, length-aware amber travel, then target arrival. |
| 4 | HIGH | Product contract | `src/MechanismRail.tsx:1811-1866` | Message sequence and the five inspection panels are absent from the production rail despite truth-safe implementations remaining in the file. | Reattach the sequence, current transition, and five panels in the authored order. |
| 5 | MEDIUM | Interruptibility | `app/flows/FlowsGallery.tsx:319-323` | A fixed 1900 ms interval can advance independently from the graphic. | Advance replay only after signal completion plus a fixed reading dwell. |
| 6 | MEDIUM | Accessibility | `src/index.css:1518-1526`, `app/flows/flows.module.css:969-978` | Blanket 0.01 ms overrides remove explanatory feedback rather than providing an equivalent. | Replace movement with explicit color, opacity, ordinal, and inspector-state changes. |

## Target

### Product personality

The result is a crisp technical demo with explanatory choreography. Motion
exists only to show where an observed payment fact came from, where it is going,
and when it becomes authoritative. Nothing loops decoratively. Selecting a node
or ledger row is immediate; only a new live evidence event or an explicit
forward replay moves the signal.

### Exact topology

Use six primary actor nodes. Seat hold, selected method, provider action, and
order result are facts attached to these actors, not equal-weight network
actors.

```text
BUYER
  │ submit held order
  ▼
ONSALE / MERCHANT ───────────────────────────────┐
  │ create one payment                           │ issue tickets
  ▼                                              ▼
HYPERSWITCH ⇄ OBSERVED CONNECTOR             TICKETS
      ╲
       ╲ retrieve observed (solid when observed)
        ╲ webhook unproven (parallel dashed alternative)
         ▼
      RECONCILE
         ╲ retrieved result
          └───────────────────────────────► ONSALE / MERCHANT
```

The primary sequence is:

`Buyer → ONSALE → Hyperswitch → observed Connector → Hyperswitch → Reconcile → ONSALE → Tickets`

- `SEAT HOLD · 4 HELD` is a sublabel/badge inside ONSALE, not a seventh node.
- `METHOD · KLARNA` is a Hyperswitch/attempt fact. `CONNECTOR · STRIPE_TEST`
  stays separate.
- `PROVIDER ACTION · TOP-LEVEL` is an amber callout anchored to the current
  Hyperswitch/Connector exchange only for an observed action-required state. It
  is not a traversable merchant-owned node.
- The Reconcile node has two subpaths: `RETRIEVE` and `WEBHOOK · UNPROVEN`.
  They must never be merged. Webhook remains dim/dashed until separate dated
  evidence exists.
- Connector is not rendered until `observedConnector` exists. Do not render a
  generic future connector box.
- Ticket becomes green only when the same server snapshot reports successful
  reconciliation and `ticketCount === itemCount`.

### Rail geometry: restore the baseline exactly

Use `viewBox="0 0 320 412"` and these rectangles from the preserved graph:

| Node | x | y | width | height | Primary label | Sublabel source |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| buyer | 8 | 8 | 147 | 30 | BUYER | `left pane` |
| merchant | 8 | 144 | 147 | 30 | ONSALE | order state plus seat-hold fact |
| hyperswitch | 8 | 252 | 147 | 30 | HYPERSWITCH | canonical payment state or `awaiting method` |
| connector | 163 | 252 | 147 | 30 | OBSERVED CONNECTOR | exact connector plus `TEST` when applicable |
| reconcile | 163 | 64 | 147 | 30 | RECONCILE | `retrieve · observed`, `retrieve · checking`, or `webhook · unproven` |
| tickets | 83 | 372 | 147 | 30 | TICKETS | exact `n of n issued` |

The six rectangles are byte-for-byte the baseline coordinates at commit
`8dede8f`.

Use these exact rail paths:

| Edge id | SVG path | Label | Draw | Handoff | Travel |
| --- | --- | --- | ---: | ---: | ---: |
| `buyer_merchant` | `M 81 38 L 81 144` | `submit held order` | 420 ms | 70 ms | 780 ms |
| `merchant_hyperswitch` | `M 81 174 L 81 252` | `create / retrieve` | 360 ms | 70 ms | 680 ms |
| `hyperswitch_connector` | `M 155 267 L 163 267` | `confirm` | 180 ms | 70 ms | 320 ms |
| `connector_hyperswitch` | `M 163 276 L 155 276` | `canonical response` | 180 ms | 70 ms | 320 ms |
| `hyperswitch_retrieve` | `M 155 262 C 236 262 236 196 236 94` | `retrieve same payment` | 540 ms | 70 ms | 920 ms |
| `hyperswitch_webhook` | `M 155 258 C 244 258 244 196 244 94` | `webhook · unproven` | no motion until observed | — | — |
| `reconcile_merchant` | `M 163 79 C 81 79 81 110 81 144` | `retrieved result` | 480 ms | 70 ms | 780 ms |
| `merchant_tickets` | `M 155 159 C 246 159 246 334 156 372` | `issue tickets` | 540 ms | 70 ms | 920 ms |

Do not render SVG marker arrowheads. The named edge label, message sequence, and
travelling token communicate direction; this restores the baseline grammar and
removes the current arrow collision.

### Wide `/flows` geometry

Keep the same topology rather than inventing a second information model. Use
`viewBox="0 0 820 300"`:

| Node | x | y | width | height |
| --- | ---: | ---: | ---: | ---: |
| buyer | 20 | 12 | 180 | 38 |
| merchant | 20 | 112 | 180 | 38 |
| hyperswitch | 235 | 210 | 180 | 38 |
| connector | 445 | 210 | 180 | 38 |
| reconcile | 620 | 62 | 180 | 38 |
| tickets | 20 | 244 | 180 | 38 |

Use these wide paths with the same timing table as their rail counterparts:

```ts
buyer_merchant: "M 110 50 L 110 112",
merchant_hyperswitch: "M 200 131 C 230 131 252 176 325 210",
hyperswitch_connector: "M 415 224 L 445 224",
connector_hyperswitch: "M 445 238 L 415 238",
hyperswitch_retrieve: "M 415 217 C 590 210 650 155 710 100",
hyperswitch_webhook: "M 415 212 C 600 202 660 150 720 100",
reconcile_merchant: "M 620 81 C 420 81 300 82 200 131",
merchant_tickets: "M 110 150 L 110 244",
```

At widths below 720 px, use the 320×412 rail topology. Do not scale the wide
layout down until its labels collide.

### Exact visual states

Define state on every node and edge in data attributes; do not infer it from a
CSS class name.

| State | Node | Edge | Token |
| --- | --- | --- | --- |
| `future` / `possible` | white fill, `opacity: 0.36`, `rgba(0,109,249,0.14)` 0.7 px border | `rgba(0,109,249,0.14)`, 1 px, `4 5` dash | none |
| `traversed` / `observed` | white/cobalt 5% fill, `opacity: 0.82`, `rgba(0,109,249,0.45)` 1.2 px border | cobalt at 0.68 opacity, 1.5 px solid | none |
| `current-source` | cobalt 6% fill, cobalt 1.5 px border, baseline corner marks, cobalt glow | current edge draws | amber token begins after draw + 70 ms |
| `current-target` | becomes current only after token arrival; amber border for action/unknown, cobalt otherwise | settles solid | token remains at endpoint for 180 ms, then disappears |
| `success` | green 7% fill, green 1.5 px border and `✓` | green only for the terminal fulfillment edge | none |
| `failure` | red 7% fill, red 1.5 px border and `✕` | red only on the returned failing edge | none |
| `warning` | amber 7% fill, amber 1.5 px border and `!` | amber only on the unresolved observed edge | amber dock pulses only while unresolved |

Only the current actor glows. Traversed nodes do not retain glow. Terminal
glyphs enter from `opacity: 0; transform: scale(0.9)` to
`opacity: 1; transform: scale(1)` in 220 ms with `var(--ease-out)`; never use
`scale(0)`.

### Amber token behavior

Render one SVG `<g data-trace-token>` containing:

- a core circle with radius `3.5`, fill `#F59E0B`;
- a halo circle with radius `7`, fill `rgba(245,158,11,0.16)`;
- `filter: url(#trace-glow-amber)` where the filter uses
  `feGaussianBlur stdDeviation="4"` and merges the blur with the source.

Movement uses CSS `offset-path`/`offset-distance`, as the baseline did. Use
`--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` because the token moves on
screen. Edge draw uses `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`. UI color,
border, inspector, and glyph entrances use the same `--ease-out`.

For each new evidence event:

1. At `0 ms`, keep the inspector on the source actor, set the source node to
   `current-source`, and begin drawing only the event's edge.
2. After the edge's exact draw duration, wait `70 ms`.
3. Move the amber token once along that edge for the exact travel duration in
   the timing table. Never loop a travelling token.
4. On `animationend`, set the source to traversed, set the target to current or
   terminal, leave the token at the endpoint for `180 ms`, and then remove it.
5. Update the current-transition copy and automatic inspector selection only at
   arrival. Crossfade/translate the inspector content from
   `opacity: 0; transform: translateY(6px)` to its resting state in `180 ms`
   with `var(--ease-out)`.
6. If the target remains unresolved (`processing`, `action_required`,
   `checking_same_payment`, or `review_required`), dock the amber core at the
   target node border and pulse opacity from `1` to `0.55` and back over
   `1.8 s` with `ease-in-out`. This is the only infinite rail animation.

Use a unique `motionEvent.id` derived from evidence revision plus edge id.
Hydrating or selecting a completed historical snapshot does not create a motion
event and therefore does not replay causality accidentally.

If a newer live revision arrives before the current animation ends, cancel the
old event, commit its target as traversed without reverse motion, and begin only
the newest event. Do not queue stale animation behind authoritative state.

### Data contract

Replace the ambiguous `activeEdge` plus `animateSignal` coupling with an
explicit optional motion event:

```ts
export interface PaymentTraceMotionEventV2 {
  readonly id: string
  readonly edgeId: PaymentTraceEdgeIdV2
  readonly sourceNode: PaymentTraceNodeIdV2
  readonly targetNode: PaymentTraceNodeIdV2
  readonly tone: "progress" | "action" | "unknown" | "success" | "failure"
  readonly label: string
}

export interface PaymentTraceFrameV2 {
  readonly revision: string | number
  readonly nodes: readonly PaymentTraceNodeV2[]
  readonly edges: readonly PaymentTraceEdgeV2[]
  readonly motionEvent: PaymentTraceMotionEventV2 | null
  readonly playback: "live" | "playing" | "paused" | "static"
  readonly ariaLabel: string
}
```

`motionEvent` represents a newly observed causal handoff, not the current page
screen. `playback="static"` renders a complete Previous Run without motion.
`playback="paused"` sets `animation-play-state: paused` on the token and current
edge; resuming continues from the same offset.

### Production live-event mapping

Create a pure function from consecutive snapshots/evidence revisions to at
most one motion event. The transition table is exact:

| Newly observed fact | Edge | Arrival actor | Tone |
| --- | --- | --- | --- |
| order/held bundle becomes checkout-ready | `buyer_merchant`, then hydrate `merchant_hyperswitch` as already traversed if payment identity already exists | ONSALE | progress |
| payment identity first appears | `merchant_hyperswitch` | Hyperswitch | progress |
| first observed attempt supplies connector | `hyperswitch_connector` | Connector | progress/action/failure from canonical state |
| connector result is normalized | `connector_hyperswitch` | Hyperswitch | action/failure/progress |
| request state becomes reconciling or observation source becomes retrieve | `hyperswitch_retrieve` | Reconcile | unknown or progress |
| retrieved canonical result becomes authoritative | `reconcile_merchant` | ONSALE | success/failure/action/unknown |
| durable ticket count reaches item count | `merchant_tickets` | Tickets | success |

Never synthesize connector, routing, failover, or webhook motion from page state.
If the server snapshot does not expose enough information to distinguish two
events, render the new state statically and label it `NOT OBSERVED`; do not
invent an animation.

### Inspector choreography and rail anatomy

The production rail order must be:

1. Header: `LIVE PAYMENT TRACE` plus current outcome.
2. Authored nonlinear causal graph.
3. `MESSAGE SEQUENCE`, with the exact event list and current amber dot.
4. `CURRENT TRANSITION`, pinned to the source during travel and changed to the
   target on arrival.
5. Policy, Decision, Attempts, State, Evidence panels, in that order and open
   by default on desktop.
6. Proof boundary and `REPLAY THIS OUTCOME` link.

The visible message-sequence rows are fixed in this order; state and evidence
determine whether each is current, observed, possible, or absent:

1. `B→M submit held order`
2. `M→H create one payment identity`
3. `H→C confirm with observed connector`
4. `C→H canonical response`
5. `H→R retrieve same payment`
6. `H⇢R webhook · UNPROVEN` (parallel dim alternative; never mark current from
   existing evidence)
7. `R→M return authoritative result`
8. `M→T issue n of n durable tickets`

Reuse the existing truth-safe `InventorySequenceLegend`, `CheckoutSequenceLegend`,
`InventoryPanels`, and `CheckoutPanels` from `src/MechanismRail.tsx:732-1142`.
Do not recreate hard-coded baseline payloads. Update only their active/current
visual state and automatic inspector choreography.

Manual node inspection never plays a token. Clicking a node changes the
inspector immediately with a 180 ms opacity/color response. When the next live
event starts, automatic inspection returns to that event's source, and then
moves to its target on arrival.

### `/flows` replay choreography

- Previous Runs remains the default view and selected completed runs remain
  static. Add the unambiguous primary label `REPLAY TRACE` above the existing
  `PLAY FROM START` control; do not autoplay a historical charge.
- Clicking a different ledger row swaps the completed trace with a 180 ms
  opacity-only transition. It must not pretend the historical transaction is
  happening now.
- Clicking `REPLAY TRACE` clears traversed presentation state and starts the
  first forward evidence event.
- Replace the fixed 1900 ms interval. After `onSignalComplete(eventId)`, wait
  exactly `620 ms` so the viewer can read the arrived node and inspector, then
  dispatch the next replay step.
- `PAUSE` freezes both the current line and amber token. `PLAY` continues them;
  it does not restart the edge.
- `NEXT` during motion commits the current target and starts the next event.
  `PREVIOUS` renders the prior frame statically; do not animate causality in
  reverse.
- `RESTART` returns to step 1 in stopped/static state. Motion begins only after
  Play.
- A terminal flow ends with an explicit green, red, or amber glyph and a static
  full path. It does not keep pulsing after the outcome is known.

### Reduced-motion equivalent

Reduced motion must retain the explanation:

- Do not move the amber token or animate stroke dash offsets.
- On a new evidence event, change the event edge from dashed to solid and the
  destination node from future to current over `180 ms` using opacity,
  border-color, background-color, and text color only.
- Render a stationary amber 3.5 px dot at the destination for unresolved
  states; do not pulse it.
- Update the visible message sequence ordinal and current-transition copy at the
  same time. The live region must announce `Step n of total: source to target,
  status`.
- Crossfade inspector content over `180 ms`; omit `translateY` and scale.
- Terminal glyphs fade in over `180 ms`; no scale.

Replace the trace-specific effects of the blanket 0.01 ms rules with targeted
selectors after those rules. Do not remove reduced-motion handling for seats,
checkout, or unrelated components in this plan.

### Viewport behavior

- **1186 px and wider:** keep the 72/28 shell. The rail uses the 320×412 graph,
  the message sequence immediately below it, and five open panels in an
  independently scrollable rail.
- **768–1185 px:** keep the same rail graph and topology. Scale only the SVG
  width to its container; maintain the 320×412 viewBox and a minimum readable
  node label size of 8.5 px.
- **641–767 px:** the active rail follows the buyer surface in the same route;
  use the rail graph at `width: min(100%, 360px)` centered. Never switch to the
  wide layout.
- **320–640 px:** the idle landing rail may remain hidden. Once checkout starts,
  show the graph, sequence, and Current Transition before the five panels. Keep
  a minimum 44 px tap target for node buttons and panel summaries. No horizontal
  scrolling.
- **`/flows` at 721 px and wider:** use the wide topology. At 720 px and below,
  use the rail topology. The same event id, state, labels, and timing must drive
  both; only geometry changes.

## Repo conventions to follow

- Cobalt is `#006DF9`, amber is `#F59E0B`, success is `#22C55E`, and failure is
  `#EF4444`; keep these tokens rather than introducing a parallel palette.
- The preserved causal renderer at git commit `8dede8f`,
  `src/MechanismRail.tsx:37-230`, is the geometry and glow exemplar. Port its
  paths, amber filter, corner marks, terminal glyphs, and message-sequence
  grammar; do not port its invented webhook/routing facts.
- Truth-safe panel projections already exist in the current working tree at
  `src/MechanismRail.tsx:732-1142`; reuse them.
- Add motion tokens once in `src/index.css`:

  ```css
  :root {
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
    --trace-amber: #f59e0b;
  }
  ```

- Use CSS transforms/opacity and SVG stroke properties only. Do not animate
  width, height, top, left, margin, or padding. Do not use `transition: all`.
- Do not add Framer Motion, GSAP, or another dependency. CSS plus the existing
  React state is sufficient and matches the baseline.

## Steps

1. **Restore the shared topology in `src/PaymentTraceMap.tsx`.**
   Replace the nine-node layout and marker arrows with the six-node rail and
   wide coordinate tables above. Add a separate optional action callout and
   parallel unproven webhook edge. Preserve one shared component for production
   and `/flows`.
2. **Make motion an evidence event in `src/PaymentTraceMap.tsx`.**
   Introduce `PaymentTraceMotionEventV2` and `playback`; remove
   `animateSignal`. Render the current edge, amber token group, arrival state,
   and terminal glyphs from the exact phase sequence above. Expose
   `onMotionPhaseChange(phase, eventId)` and `onSignalComplete(eventId)` props.
   Deduplicate events by `motionEvent.id` in a ref so rerenders never replay an
   already-consumed event.
3. **Restore the CSS motion language in `src/index.css`.**
   Add the shared easing/color tokens, amber filter styles, line-draw,
   offset-distance travel, node/current/traversed/future states, corner marks,
   arrival, docked unresolved pulse, and inspector transition. Remove the
   trace arrow-marker styling and blue signal styling. Scope everything below
   `.payment-trace-map` or `.production-mechanism-rail`.
4. **Drive live events from evidence in `src/MechanismRail.tsx`.**
   Refactor `deriveProductionTraceV1` into a pure six-node projection plus a
   consecutive-revision event derivation using the exact live mapping table.
   Keep connector absent until observed, keep webhook dashed/unproven, and keep
   method separate. Do not use screen names or timers as evidence.
5. **Restore the explanatory rail below the graph in `src/MechanismRail.tsx`.**
   Reattach `InventorySequenceLegend` and `InventoryPanels`/`CheckoutPanels` in
   the required order. Keep the automatic inspector on the source until the map
   reports arrival, then select the target. Retain manual node selection without
   token motion.
6. **Synchronize replay in `app/flows/FlowsGallery.tsx`.**
   Replace `setInterval(1900)` with signal-completion plus the 620 ms reading
   dwell. Map each flow step to a single evidence event. Keep completed Previous
   Runs static, add the explicit Replay Trace entry point, implement pause/resume
   through `playback`, and make Previous static rather than reverse-animated.
7. **Adjust only trace/replay presentation in `app/flows/flows.module.css`.**
   Keep the ledger and narrative layout. Add the 180 ms completed-trace swap,
   replay affordance, and responsive graph constraints. Do not animate run-row
   hover, metrics, or navigation.
8. **Update `tests/domain/mechanism-rail-c2.test.tsx`.**
   Assert exact node order/labels, six-node topology, connector conditionality,
   separate dim Webhook, amber event token, line-before-token data phases,
   terminal Ticket gate, message sequence, and five panels in exact order.
9. **Update `tests/domain/flows-v2.test.tsx` and
   `tests/e2e/onsale-checkout-c3.spec.ts`.**
   Assert completed runs do not autoplay; Replay starts at the first edge; Pause
   preserves the event id and offset; signal completion plus 620 ms advances;
   Previous is static; reduced motion retains destination, ordinal, inspector,
   and terminal state; 390/768/1186/1440 px have no graph clipping or horizontal
   overflow.

## Boundaries

- Do NOT restore fake connector selection, fallback, retry, webhook, payload,
  timestamp, access, or money claims from the Figma baseline.
- Do NOT render Webhook solid or animated without new dated evidence.
- Do NOT show a connector before an observed attempt supplies it.
- Do NOT turn seat hold, provider action, or ONSALE result into equal-weight
  actor nodes.
- Do NOT implement a linear stepper, Sankey diagram, 3D graph, particle field,
  marquee, or ambient looping path animation.
- Do NOT autoplay Previous Runs or replay when a ledger row is selected.
- Do NOT animate backwards when the user presses Previous.
- Do NOT add a motion dependency.
- Do NOT modify checkout form behavior, payment commands, API routes, database
  code, environment/runtime scripts, or the buyer pane in this plan.
- Do NOT redesign the `/flows` header or ledger here; another product/UI pass
  can address their density independently.
- If the event projection cannot name a source edge from retained evidence,
  render the authoritative state statically and say `NOT OBSERVED`. Do not
  improvise a path.
- If source locations have drifted since commit `340e336`, stop and reconcile
  this plan against the new code before implementing.

## Verification

- **Mechanical:** from the repository root with the pinned WSL Node runtime,
  run:

  ```bash
  pnpm typecheck
  pnpm test -- tests/domain/mechanism-rail-c2.test.tsx tests/domain/flows-v2.test.tsx
  pnpm test:e2e -- tests/e2e/onsale-checkout-c3.spec.ts
  pnpm build:next
  git diff --check
  ```

  Expected: all commands exit 0; no credential, payment, or database mutation is
  needed for the motion tests.

- **Feel check — production rail:** at 1186×746, trigger a mocked or retained
  checkout-ready → observed-attempt → retrieve → fulfilled sequence and confirm:
  - each edge becomes solid before the amber token enters it;
  - only one amber token exists;
  - the source actor glows while the token travels;
  - the inspector remains on the source until arrival, then changes once;
  - traversed actors lose glow but remain legible;
  - Webhook never illuminates;
  - Ticket remains dim until exact ticket fulfillment, then receives one green
    glyph and no continuing pulse.
- **Feel check — replay:** select a completed Previous Run and confirm it stays
  static. Click Replay Trace, pause halfway through the long Retrieve curve,
  resume, and confirm the token continues rather than restarting. Press Next
  during a later travel and confirm the current target settles before the next
  event begins. Press Previous and confirm the prior frame appears statically.
- **Slow-motion inspection:** in Chromium DevTools Animations, set playback to
  10%. Confirm the exact order is line draw → 70 ms gap → amber travel → target
  arrival → inspector change. Confirm no target glow or inspector content leads
  the token.
- **Reduced motion:** emulate `prefers-reduced-motion: reduce`. Confirm there is
  no moving token, stroke draw, translate, scale, or pulse, but edge color,
  destination state, step ordinal, live-region message, inspector, and terminal
  result all update.
- **Viewport check:** inspect 390×844, 768×1024, 1186×746, and 1440×1000.
  Confirm labels do not overlap paths, the graph has no horizontal overflow,
  the 390 px active trace appears below the buyer pane, and `/flows` switches
  geometry only at 720 px.
- **Performance:** record a six-step replay in the Performance panel. Confirm
  token movement is compositor-friendly, no continuously running `requestAnimationFrame`
  exists, and no layout property changes during travel.
- **Done when:** a viewer can narrate the current actor and observed handoff by
  watching the rail alone; the amber signal is visible and causal in both live
  and explicit replay modes; the inspector arrives with the token; all five
  evidence panels are restored; reduced motion conveys the identical state
  sequence; and no unobserved connector, routing, failover, or webhook claim is
  introduced.
