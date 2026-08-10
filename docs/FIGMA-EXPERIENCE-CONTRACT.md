# Figma experience contract

Status: binding regression gate
Baseline: `8dede8f296f2d74359e8d1e95734687e18c5a8e5`
Source: `prithvi-jpg/LiveEventTicketingMockup`

## Product boundary

The Figma export owns presentation, interaction hierarchy, and motion. The
backend owns access policy, inventory, holds, price, payment identity, attempts,
reconciliation, and fulfillment. Backend integration inhabits the existing
experience; it does not redesign it by default.

## Must remain visually recognizable

- One-page 72/28 desktop composition with a one-pixel cobalt divider and a
  continuously visible Mechanism Rail (`src/App.tsx:243-310`).
- Cobalt `#006DF9`, white customer canvas, `#fafcff` rail, dark event/ticket
  surfaces, Inter prose, JetBrains Mono data labels, sharp corners, and hairline
  borders (`src/App.tsx:4-14`, `src/MechanismRail.tsx:24-35`,
  `src/index.css:1-11`, `design.md:8-29`).
- Photographic event hero, oversized PHANTOM CIRCUIT title, staged presale and
  general-sale cards, information rows, VERIFY ACCESS, and JOIN QUEUE
  (`src/App.tsx:315-437`).
- The 520×224 cobalt proscenium illustration with valance swags, pleated
  curtains, tie-backs, spotlights, and vanishing-point floor
  (`src/App.tsx:548-709`).
- Six rows by ten seats, spatial selection, available/selected/taken states,
  live summary, and hold progress (`src/App.tsx:714-853`). Inventory values may
  change; density, hierarchy, and interaction treatment may not.
- Respectful decline/recovery compositions and the authored digital ticket and
  receipt (`src/App.tsx:1059-1288`).

## Default motion contract

- Event entrance order: hero at `0ms`, sale region at `100ms`, presale at
  `150ms`, general sale at `200ms` (`src/App.tsx:330-391`).
- State changes use restrained translate-plus-opacity continuity; status fades;
  the ticket uses scale/translate continuity (`src/index.css:30-61`).
- Seat hover and selection respond immediately without replacing the grid
  (`src/App.tsx:769-803`).
- Hold time changes continuously and visibly, including urgency color
  (`src/App.tsx:729-752`).
- Live dots pulse; intermediate mechanism states glow amber; terminal states use
  explicit success, failure, or warning glyphs (`src/index.css:22-53`,
  `src/MechanismRail.tsx:219-229,458-486`).
- Accessibility preferences are a secondary equivalent. Full authored motion is
  the default and must not be globally suppressed.

## Mechanism Rail contract

The rail is a minimal two-dimensional causal system, not decorative 3D. Its
teaching sequence is:

`Buyer → Merchant → Hyperswitch → Processor → Hyperswitch → Webhook/Retrieve → Merchant → Ticket`

- Draw the relevant line before its travelling signal.
- Glow only the current actor.
- Reach Ticket only after server reconciliation permits fulfillment.
- Keep Policy, Decision, Attempts, State, and Evidence in that exact order and
  open by default (`src/MechanismRail.tsx:235-420,526-531`).
- Distinguish observed order evidence, merchant-owned rules, recorded sandbox
  capability, and unproven paths. Never label a path live from a fixture name or
  design intention.

## Must be replaced without changing the design language

- Any-four-digit fake eligibility and unreachable invalid state.
- Hard-coded inventory, client-only holds/pricing, and a timer without an expiry
  transition.
- Static card fields, fake OTP/3DS, fake Klarna, and client-generated webhook
  payloads.
- Random processor selection, timer-driven outcomes, static policy/timestamps,
  and unconditional LIVE HOSTED claims.
- Placeholder ticket IDs, QR codes, receipt actions, and fulfillment claims.
- Contradictions between general admission and assigned seats, all-in price and
  added fees, or one issued ticket representing multiple seats.

Visible buyer states stay familiar, but they must derive from a server snapshot
that represents access, inventory, hold, order, payment, attempts, evidence, and
fulfillment independently.

## Gate

Block a frontend slice if it changes the stage, sale hierarchy, seat density,
cobalt/sharp design language, same-page relationship, rail topology, five-panel
order, or causal motion without an observed constraint and review receipt.
Also block a slice that preserves appearance by retaining fake business state.
