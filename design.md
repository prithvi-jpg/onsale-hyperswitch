# SEAT NERD — Design Document

Live-event ticketing storefront with Juspay Hyperswitch payment orchestration.
Mid-fi mockup: reconciliation product, not a checkout product.

---

## Visual Language

| Token | Value | Usage |
|---|---|---|
| Primary blue | `#006DF9` | Buttons, active states, borders, logo |
| Blue 10% | `rgba(0,109,249,0.08)` | Panel fills, hover tints, info banners |
| Blue 20% | `rgba(0,109,249,0.18)` | Card borders, dividers, subtle lines |
| Background | `#ffffff` | Page canvas |
| Surface | `#fafcff` | Right sidebar |
| Foreground | `#0a0a0a` | Body text, node labels |
| Muted | `#888888` | Secondary text, captions |
| Success | `#22c55e` | Confirmed state, live indicator |
| Error | `#ef4444` | Failed state, lease expiry warning |

**Typography**
- Body / UI: `Inter` (Google Fonts, 300–700)
- Labels / data / code: `JetBrains Mono` (Google Fonts, 400–500)
- Rule: all status labels, event logs, moneys, IDs, and state strings use mono. Human-readable prose uses Inter.

**Border style**: 1px solid, no border-radius anywhere. Sharp corners throughout — engineering-wireframe aesthetic, not rounded SaaS.

**Dividers**: Blue hairline (`1px solid #006DF9`) separates the left content column from the right orchestration panel. Horizontal hairline under the header.

---

## Layout Shell

```
┌─────────────────────────────────────────────────────────┐
│ SEAT NERD                        JUSPAY HYPERSWITCH  ●  │  ← header, h=50px, border-bottom blue
├──────────────────────────────────────────┬──────────────┤
│                                          │              │
│   main content                    1px   │  right panel │
│   (flex: 1)                      blue   │  (380px)     │
│                                  line   │              │
│                                          │              │
└──────────────────────────────────────────┴──────────────┘
```

CSS: `display: grid; grid-template-columns: 1fr 1px 380px`
The `1px` column is a solid blue `<div>` — not a border — so it spans full height.

---

## Components

### `Shell`
Wraps every screen. Renders header + the 3-column grid.

Props: `children` (main content), `rightPanel` (orchestration sidebar)

The header contains:
- Left: `SEAT NERD` in JetBrains Mono, blue
- Right: `JUSPAY HYPERSWITCH` label + green pulse dot (live indicator)

---

### `StepBar`
3-step horizontal progress bar spanning the full content width.

Steps: `01 Browse` → `02 Select Seats` → `03 Payment`

States per step:
- **Active**: filled blue background, white text
- **Done**: blue-tinted background, blue text
- **Pending**: white background, grey text

Implemented as borderless adjacent buttons sharing a single 1px blue border outline. No gap between buttons — left button owns `border-left`, siblings suppress it with `border-left: none`.

---

### `OrchestrationPanel` (right sidebar)
Always visible. Shows the Juspay Hyperswitch orchestration state machine.

**Sub-sections:**

1. **State label** — pulse dot + current state string in mono
2. **Flow nodes** — vertical stack of 4 node cards connected by dashed/solid lines:
   - `Seat Lease` · ≈10 min TTL
   - `Route Handlers` · intent / confirm / status
   - `Hyperswitch` · Orchestration layer
   - `Processor` · Stripe · PayPal · fauxpay

   Each node card: white (idle) → blue-tinted (done) → solid blue (active). Connector lines are dashed when not yet reached, solid blue when passed.

3. **Processor grid** — 3 equal cells: Stripe / PayPal / fauxpay. Active processor fills solid blue.

4. **Reconciliation note** — explains seat lease TTL vs. payment state machine relationship.

5. **Event log** — 4 rows: `seat_lease_created`, `payment_intent_created`, `hyperswitch_routed`, `processor_confirmed`. Each row: timestamp (mono, grey) + event name (mono, color transitions from grey → blue → green/red as state progresses).

**Props:** `state: OrchestrState`, `processor: string`

**OrchestrState enum:** `idle | routing | hyperswitch | processor | confirmed | failed`

---

### Screen 1 — `BrowseScreen`

Event discovery page. Two-column card grid.

**EventCard anatomy:**
```
┌──────────────────────────────┐
│  [concert photo]    $180 ←── price badge (top-right, blue fill)
│  gradient overlay (bottom)   │
├──────────────────────────────┤
│  Sun · Aug 09 · 7:00 PM      │  ← muted, small
│  My Chemical Romance         │  ← 16px, semibold
│  The Black Parade 2026       │  ← 13px, muted
│  Citi Field · Queens, NY     │  ← 11px, muted
│  [SELECT TICKETS →]          │  ← CTA, blue fill on featured, blue outline on rest
└──────────────────────────────┘
```

Card border transitions from `#e8e8e8` → `#006DF9` on hover.

Placeholder card (4th slot): dashed grey border, `MORE EVENTS LOADING...` in mono.

Photos sourced from Unsplash (concert/performance photography).

---

### Screen 2 — `SeatScreen`

Two-column layout: seat map (left) + order summary (right).

**`SeatMap` component:**

Renders a top SVG stage element (curved curtain shape using SVG `<path>`) above a grid of clickable seat buttons.

Grid: 6 rows (A–F) × 10 columns. Row label in mono on the left.

Seat button states:
- **Available**: white fill, grey border
- **Selected**: blue fill, blue border, `✓` glyph
- **Taken**: light grey fill, disabled

Hard-coded `TAKEN` set for the mockup. Max 4 seats selectable (enforced client-side).

**Order summary panel:**
- Lists selected seats with per-seat price ($180)
- Running total in blue mono
- Seat lease info banner (clock icon + TTL copy)
- CTA button: disabled + grey when 0 seats, blue + active when ≥ 1 seat

---

### Screen 3 — `PaymentScreen`

Two-column layout: payment iframe (left) + Hyperswitch test console (right).

**Lease TTL banner** — spans full width at top. Shows countdown timer decrementing from 10:00. Turns red with red border when under 2 minutes.

**`PaymentIframe` component:**

Mimics the Hyperswitch unified checkout embed. Structure:
```
┌─ iframe header bar ──────────────────────────────────────┐
│  ● hyperswitch · payment iframe · sandbox    ORCHESTRATED │
├───────────────────────────────────────────────────────────┤
│  Card  │  G Pay  │  Klarna                                │ ← method tabs
├───────────────────────────────────────────────────────────┤
│  [card form / GPay button / Klarna installments UI]       │
│  [PAY $360.00]  ← state-driven: Processing... / Confirmed │
└───────────────────────────────────────────────────────────┘
```

Card form fields: Card Number, Expiry, CVC, Cardholder Name — all placeholder/static for mid-fi.

Pay button color transitions: blue (idle) → grey (processing) → green (confirmed) → red (failed).

**`HyperswitchTestPanel` component:**

Mirrors the real Hyperswitch sandbox test page UI. Contains:
- Payment amount + currency label
- `COMPLETE PAYMENT` (green) and `REJECT PAYMENT` (red outline) simulation buttons
- Explanatory copy about what the test page is
- Webhook payload preview (dark terminal panel): live JSON showing `payment_id`, `status`, `connector`, `seat_lease_id`, `lease_expires_at`. Updates reactively as orchestration state changes.

**↻ SIMULATE PAYMENT FLOW button:**

Triggers a scripted 3-second animation:
1. `t=0` → `routing` state
2. `t=900ms` → `hyperswitch` state
3. `t=1800ms` → `processor` state (random: Stripe / PayPal / fauxpay)
4. `t=3000ms` → `confirmed` (75%) or `failed` (25%)

All transitions propagate to `OrchestrationPanel` via lifted state.

---

## State Architecture

State lives in `App` and flows down:

```
App
├── step: Step                    'browse' | 'seats' | 'payment'
├── orchState: OrchestrState      drives OrchestrationPanel
├── processor: string             which rail was routed to
│
├── SeatScreen
│   └── selected: Set<string>     local — seat IDs e.g. 'A3', 'B7'
│
└── PaymentScreen
    ├── method: PayMethod         'card' | 'gpay' | 'klarna'
    ├── payState: PayState        'idle' | 'processing' | 'confirmed' | 'failed'
    └── leaseSeconds: number      counts down from 600, drives TTL banner
```

`orchState` and `processor` are lifted to `App` so `OrchestrationPanel` (in `Shell`, outside the screen components) can react to payment simulation.

---

## Screen Flow

```
BrowseScreen
  "SELECT TICKETS →" on any card
        │
        ▼
SeatScreen
  select ≥ 1 seat → "CONTINUE TO PAYMENT →"
        │
        ▼
PaymentScreen
  "↻ SIMULATE PAYMENT FLOW" → orchestration animation
```

Step bar also allows free navigation between any step.

---

## Key Product Constraints Reflected in UI

| Constraint | Where it appears |
|---|---|
| Seat lease is short-lived (~10 min) | TTL countdown banner on payment screen, lease info in seat summary, `lease_expires_at` in webhook payload |
| Payment state machine is external | Orchestration panel shows we don't own it — we observe via webhooks |
| No page navigation / iframe-in-page | Iframe header copy: "no browser jumping, no new page", 3DS notice |
| Reconciliation is the hard problem | Reconciliation note in right panel, event log timing, webhook payload |
| Multiple payment rails | Stripe / PayPal / fauxpay processor grid, random routing in simulation |
| Sandbox / test mode | "ORCHESTRATED · SANDBOX" badge, Hyperswitch test console with Complete/Reject |
