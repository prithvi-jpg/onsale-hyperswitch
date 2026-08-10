# C2 seat inhabitation work packet

Status: implementation-ready; C1 Next.js parity is the entry gate and the
runtime-schema foundation below is the first C2 sub-gate

Scope: one independently reviewable event/seat/hold slice

Visual authority: Figma baseline `8dede8f296f2d74359e8d1e95734687e18c5a8e5`

Release authority: none; this packet does not authorize deployment or provider I/O

## Outcome

A buyer can enter the prototype-open general sale, immediately select and reset
one to four **real** seats in the existing six-by-ten ONSALE grid, receive a
server-priced quote, claim the complete bundle atomically, refresh without
losing the hold, watch a visual countdown based on the database expiry, and
release or expire the hold so every seat it owned becomes selectable again.

The slice inhabits the Figma experience; it does not redesign it. The stage,
72/28 shell, seat density, cobalt language, authored motion, and right-hand
Mechanism Rail remain recognizable. A hold is never displayed as active until a
hold row and every allocation have committed.

## Smallest honest boundary

C2 starts only after the byte-identical Next.js parity slice is green. It ends
at a durable active or terminal hold.

- The general `prototype_open` sale window is functional.
- The presale card and `VERIFY ACCESS` hierarchy remain visible, but the current
  session is shown as `UNPROVEN` and cannot claim in that window.
- The existing eligibility footprint loses fake last-four/network inputs and
  explains that the merchant proof adapter is not part of C2. Its general-sale
  fallback remains functional.
- The existing order-summary region displays a server quote before claim and
  immutable hold-allocation price snapshots after claim. It is not called an
  order in data or evidence.
- The existing rail keeps its topology, five-panel DOM, and authored motion, but
  receives a minimal C2 truth projection. It may explain merchant-owned
  inventory and hold state; payment, routing, processor, webhook, and
  fulfillment remain `UNPROVEN` and inactive.
- `CheckoutScreen` is unreachable in C2. No hold is converted to an order.

This access boundary is deliberate. The repository can issue a
`local_prototype` access grant, but that issuance is not an idempotent command
and `idempotency_operation.command_kind` has no access-grant operation. Adding a
buyer-facing presale command now would create a second architectural unit. A
later access packet must add durable replay/conflict semantics, then prove
buyer + event + exact-window + database-expiry binding. C2 must never imply Citi,
Visa, issuer, or bank verification.

## Non-goals

- Payment persistence, payment attempts, observations, reconciliation, or
  Hyperswitch provider calls.
- Unified Checkout, payment-method presentation, 3DS/Klarna actions, return
  handling, or client-secret delivery.
- Order creation, fulfillment, tickets, QR codes, or success/decline outcomes.
- Full payment Mechanism Rail expansion. C2 changes only the minimum values and
  activation needed to remove false hosted/payment claims; graph geometry,
  panel order/DOM, and motion remain unchanged.
- A production queue, queue fairness, bot defense, authentication, renewal, or
  cross-device hold recovery.
- Dataset reset/reseed as a buyer route.
- Schema changes solely for friendly public IDs. V1 treats existing random
  UUIDs as opaque `publicRef` values and the client never parses them.
- Deployment, public release, Cloudflare, webhooks, routing, or failover.

## Authority and session ownership

There is no user account in V1. The server creates an anonymous browser session
on the first snapshot request.

| Property | Contract |
| --- | --- |
| Cookie | `onsale_session_v1`, 32 random bytes encoded base64url |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` outside local development, `Max-Age=86400` |
| Buyer reference | `sess_` plus SHA-256 of `"onsale-session-v1\0" + rawToken`; only the digest reaches Postgres |
| Response/cache | Raw token and `buyerRef` never appear in JSON or logs; every response is `private, no-store` and varies on `Cookie` |
| Mutation guard | JSON-only POST, exact configured-origin allowlist, bounded body, strict unknown-key rejection |
| Multi-tab behavior | Tabs sharing the cookie share one buyer and one current hold |

The browser may submit opaque event, sale-window, seat, and hold selectors. It
never submits `buyerRef`, `accessGrantId`, `holdForMs`, price components, totals,
or an inventory state. Selectors identify a candidate; the session and database
decide authority.

The server supplies the fixed C2 hold policy of 600,000 ms. A client cannot
renew or extend it. Under the existing per-event advisory lock, claim must also
reject a second effective active hold for the same buyer/event with
`ACTIVE_HOLD_EXISTS`. This makes refresh and multi-tab recovery unambiguous
without a new schema migration.

While the returned snapshot contains an active or
`expired_pending_reconcile` hold, Home and Back must not clear local state, hide
the hold, or release inventory. They keep the buyer in the hold composition.
`RELEASE HOLD` is the only buyer exit and navigation advances only after its
committed response. The browser breadcrumb timer is absent before a committed
hold and derives only from `serverTime` plus `expiresAt` afterward.

## Persistent runtime schema boundary

The current migration harness and cleanup authority remain test-only:

- `onsale_test_<16 hex>` is the only namespace accepted by the ephemeral
  create/drop helpers;
- drop still requires exact name, current-role ownership, the per-run cleanup
  capability, and the exact migration manifest;
- neither a route nor the runtime repository receives that cleanup capability.

C2 adds a separate apply-only path for the fixed application namespace
`onsale_app_v1`. It must not relax, reuse, or parameterize the ephemeral-name
guard. A server-only namespace factory accepts that one literal and returns a
branded SQL namespace; the repository accepts the brand rather than an
unvalidated string. The application migration command:

1. runs only in the Node runtime and reads `DATABASE_URL` from `process.env`;
2. applies the existing `0001_inventory_v1` template transactionally to
   `onsale_app_v1`, records and verifies its checksum, and refuses drift;
3. creates schema control without issuing or persisting a usable cleanup
   capability;
4. runs the stable, idempotent seed operation and verifies exactly one active
   six-by-ten dataset;
5. has no down/drop action and is never reachable from an HTTP route.

No `0002` DDL change is expected if the current-hold and quote rules can be
enforced under the existing event lock. Applying `0001` to the persistent
namespace is nevertheless a required migration step. Runtime routes import a
`server-only` repository singleton, explicitly use `runtime = "nodejs"`, and
reuse a bounded pool per server isolate. They never read the sibling test `.env`
file or send database configuration to a client bundle.

## Public data contract

All money is integer USD minor units. All timestamps are UTC ISO-8601 strings.
`revision` is `sha256:` plus the canonical hash of the snapshot excluding its
`revision` and `serverTime` fields; it changes when visible inventory/hold facts
change.

```ts
type PublicRef = string
type SeatRefs =
  | readonly [PublicRef]
  | readonly [PublicRef, PublicRef]
  | readonly [PublicRef, PublicRef, PublicRef]
  | readonly [PublicRef, PublicRef, PublicRef, PublicRef]

interface MoneyBreakdownV1 {
  currency: "USD"
  faceValueMinor: number
  feeMinor: number
  taxMinor: number
  totalMinor: number
}

interface PublicSaleWindowV1 {
  publicRef: PublicRef
  kind: "presale" | "general"
  state: "scheduled" | "open" | "paused" | "closed"
  opensAt: string
  closesAt: string
  seatLimit: number // 1..4; UI uses min(4, seatLimit)
  access: {
    policy: "prototype_open" | "local_prototype_cardmember"
    state:
      | "not_required"
      | "unproven"
      | "verified_local_prototype"
      | "expired"
      | "revoked"
    evidenceClass: "merchant_rule" | "unproven"
    expiresAt: string | null
  }
  canEnter: boolean
}

interface PublicSeatV1 {
  publicRef: PublicRef
  sectionLabel: string
  rowLabel: string
  seatLabel: string
  rowOrdinal: number
  seatOrdinal: number
  lifecycle: "sellable" | "blocked" | "removed"
  availability:
    | "available"
    | "held_by_session"
    | "held_by_other"
    | "reserved"
  selectable: boolean
  priceTier: string
  price: MoneyBreakdownV1
}

interface PublicHoldItemV1 {
  seatRef: PublicRef
  sectionLabel: string
  rowLabel: string
  seatLabel: string
  priceTier: string
  price: MoneyBreakdownV1
}

interface PublicHoldV1 {
  publicRef: PublicRef
  state: "active" | "expired_pending_reconcile"
  saleWindowRef: PublicRef
  expiresAt: string
  items: readonly PublicHoldItemV1[]
  totals: MoneyBreakdownV1
}

interface OnsaleInventorySnapshotV1 {
  schema: "onsale.inventory.v1"
  revision: string
  serverTime: string
  inventoryState: "ready" | "held" | "expiry_check_required"
  session: {
    kind: "anonymous_browser"
    ownsActiveHold: boolean
  }
  event: {
    publicRef: PublicRef
    slug: string
    name: string
    tourName: string
    venueName: string
    cityLabel: string
    venueTimezone: string
    startsAt: string
    heroAssetRef: string
    evidenceClass: "simulation"
    currency: "USD"
    seatingMode: "assigned"
    maximumSeatCount: 4
    allInPriceRange: {
      minimumMinor: number
      maximumMinor: number
    }
    saleWindows: readonly PublicSaleWindowV1[]
  }
  seatMap: {
    sectionLabel: string
    rowCount: 6
    seatsPerRow: 10
    rows: readonly {
      label: string
      ordinal: number
      seats: readonly PublicSeatV1[]
    }[]
  }
  currentHold: PublicHoldV1 | null
  capabilities: {
    quote: boolean
    claim: boolean
    release: boolean
    reconcileExpiry: boolean
    checkout: false
  }
}
```

Snapshot rules:

1. Read the one active dataset/event in a read-only, repeatable-read transaction.
   Capture database time once and use it for every effective-expiry comparison
   and the effective scheduled/open/closed sale-window projection.
2. Return exactly six ordered rows and ten unique ordered seats per row. Any
   structural mismatch is a typed integrity failure, not a partially rendered
   grid. A contiguous selectable run of four is required when seeding/resetting
   a fresh dataset, not after legitimate holds deplete live availability.
3. `held_by_session` is derived only from this session's effective active hold;
   no other buyer or hold identifier is exposed.
4. An allocation whose hold expiry is at or before captured database time does
   not make a seat unavailable. For its owner, expose
   `expired_pending_reconcile` until the expiry command commits.
5. Price comes from the effective tier before claim and from immutable
   allocation snapshots after claim. Every sum uses checked integer addition.
   `allInPriceRange` is the checked minimum/maximum effective sellable-seat
   total, so the event page never retains the baseline's unrelated `$90`.
6. Versioned `display_metadata` supplies the Figma hero, tour, and city strings;
   operational dates, venue, seating mode, and money still come from typed
   columns/queries. The UI says `ASSIGNED SEATING`, never `GENERAL ADMISSION
   STANDING` or `3,000 standing`.
7. Do not include provider, connector, payment, ticket, raw evidence, or secret
   fields. Both panes may eventually consume this snapshot, but C2 changes only
   the customer canvas plus the minimum evidence-safe rail projection.

One shared pure canonical-JSON implementation sorts object keys, preserves
array order, encodes UTF-8, and rejects non-finite numbers/unsupported values.
`revision` is `sha256:` plus that encoding of the visible snapshot without its
`revision` and `serverTime`. `quoteRevision` is also `sha256:` and uses the same
implementation over the schema version, dataset/event/window identity,
effective window/access state, and server-display-ordered seat lifecycle and
money facts. Browser click order is never part of a semantic hash.

## Quote and command contracts

```ts
interface QuoteSeatsRequestV1 {
  requestId: string       // crypto.randomUUID; response-correlation only
  saleWindowRef: PublicRef
  seatRefs: SeatRefs
}

interface QuoteSeatsResponseV1 {
  ok: true
  requestId: string
  basisRevision: string
  quoteRevision: string   // canonical hash of window + ordered seats + money
  saleWindowRef: PublicRef
  seatRefs: SeatRefs
  items: readonly PublicHoldItemV1[]
  totals: MoneyBreakdownV1
}

interface ClaimSeatsRequestV1 {
  commandId: string       // crypto.randomUUID; durable idempotency identity
  saleWindowRef: PublicRef
  seatRefs: SeatRefs
  quoteRevision: string
}

interface HoldSelectorCommandV1 {
  commandId: string
}

type HoldCommandResultV1 =
  | { kind: "hold_claimed"; holdRef: PublicRef; seatRefs: SeatRefs }
  | { kind: "hold_released"; holdRef: PublicRef; seatRefs: SeatRefs }
  | { kind: "hold_expired"; holdRef: PublicRef; seatRefs: readonly PublicRef[] }
  | { kind: "hold_not_yet_expired"; holdRef: PublicRef }

interface HoldCommandSuccessV1 {
  ok: true
  command: {
    commandId: string
    replayed: boolean
    result: HoldCommandResultV1
  }
  snapshot: OnsaleInventorySnapshotV1
}

type PublicInventoryErrorCodeV1 =
  | "INVALID_REQUEST"
  | "REQUEST_ORIGIN_DENIED"
  | "INVENTORY_INTEGRITY_ERROR"
  | "SALE_WINDOW_NOT_OPEN"
  | "ACCESS_REQUIRED"
  | "SEAT_NOT_AVAILABLE"
  | "QUOTE_STALE"
  | "ACTIVE_HOLD_EXISTS"
  | "HOLD_NOT_FOUND"
  | "HOLD_NOT_ACTIVE"
  | "IDEMPOTENCY_CONFLICT"
  | "INVENTORY_TEMPORARILY_UNAVAILABLE"

interface InventoryFailureV1 {
  ok: false
  commandId?: string
  error: {
    code: PublicInventoryErrorCodeV1
    message: string
    retryable: boolean
    seatRefs?: readonly PublicRef[]
  }
  snapshot?: OnsaleInventorySnapshotV1
}
```

`quoteRevision` is a compare-before-claim guard, not client authority. Inside the
claim transaction, after locking the exact window and seats, recompute the
canonical quote. A mismatch fails with `QUOTE_STALE` and creates no hold. A
successful claim returns the committed allocation snapshots; the quote cannot
override them.

## Exact App Router surface

| Method and route | Input | Server behavior | Success |
| --- | --- | --- | --- |
| `GET /api/onsale/session` | none | Ensure anonymous cookie; read one sanitized snapshot | `200 OnsaleInventorySnapshotV1` |
| `POST /api/onsale/quotes` | `QuoteSeatsRequestV1` | Validate exact open window, access, one-to-four distinct sellable/currently available seats; checked server quote; no durable operation | `200 QuoteSeatsResponseV1` |
| `POST /api/onsale/holds` | `ClaimSeatsRequestV1` | Derive buyer and 10-minute policy; bind current quote; invoke atomic claim | `200 HoldCommandSuccessV1` |
| `POST /api/onsale/holds/[holdRef]/release` | `HoldSelectorCommandV1` | Validate session ownership; release hold and every held allocation atomically | `200 HoldCommandSuccessV1` |
| `POST /api/onsale/holds/[holdRef]/expire` | `HoldSelectorCommandV1` | Validate session ownership; database decides whether expiry is due | `200 HoldCommandSuccessV1` |

Status and error mapping is exhaustive:

| Internal condition | Public code | HTTP |
| --- | --- | ---: |
| malformed/oversized JSON, unknown keys, invalid UUID/ref | `INVALID_REQUEST` | 400 |
| origin outside the configured allowlist | `REQUEST_ORIGIN_DENIED` | 403 |
| unsupported/access-gated window or grant | `ACCESS_REQUIRED` | 403 |
| unknown/foreign hold, including ownership mismatch | `HOLD_NOT_FOUND` | 404 |
| closed/not-yet-open exact window | `SALE_WINDOW_NOT_OPEN` | 409 |
| missing/cross-event/blocked/owned seat | `SEAT_NOT_AVAILABLE` | 409 |
| stale quote | `QUOTE_STALE` | 409 |
| second effective current hold | `ACTIVE_HOLD_EXISTS` | 409 |
| inactive hold | `HOLD_NOT_ACTIVE` | 409 |
| reused key with different semantics | `IDEMPOTENCY_CONFLICT` | 409 |
| money, shape, or durable-state invariant | `INVENTORY_INTEGRITY_ERROR` (`retryable: false`) | 503 |
| lock/statement timeout, connection, or unknown infrastructure error | `INVENTORY_TEMPORARILY_UNAVAILABLE` (`retryable: true`) | 503 |

No repository/driver message is forwarded by default. Raw SQL, private
identifiers, stacks, operation keys, and database messages never cross the
route boundary. Every response is `private, no-store` and `Vary: Cookie`.

Mutation helpers reject a non-JSON content type, reject declared bodies over
16 KiB, and stop a bounded stream at 16 KiB before parsing. They compare the
normalized `Origin` to a server-configured exact allowlist; they do not trust a
request `Host` or `X-Forwarded-Host` as the allowlist source.

There is intentionally no C2 access-grant, order, payment, reset, or generic
`/commands` route.

## Idempotency, concurrency, and expiry

### Idempotency

- The route maps `commandId` to
  `c2:<buyerRefDigest>:<commandId>` before calling the repository. The browser
  never sees that operation key.
- Claim request identity includes exact event, exact sale window, sorted seat
  set, quote revision, buyer reference, and the server-owned duration.
- Release/expiry request identity includes the selected hold and buyer reference.
- Same operation key + same semantic request returns the stored result with
  `replayed: true`. Same key + changed payload returns
  `IDEMPOTENCY_CONFLICT`.
- Deterministic business failures remain durable and replay even after inventory
  changes. Unknown driver, timeout, or infrastructure failures are never stored
  as deterministic business failures.
- `requestId` on quote is not an idempotency key. The controller applies only the
  response matching its latest request and draft seat set.

### Concurrency

- Sort and lock requested seats in stable ID order inside one transaction.
- Reclaim only allocations whose hold is expired at database time.
- Validate the complete one-to-four-seat set, price, currency, exact window, and
  access under lock; then insert one hold and every allocation once.
- The active-allocation unique index is the final one-owner barrier. A conflict
  rolls back the entire bundle.
- Under the same event lock, reject a second effective active hold for one
  buyer/event. First transition that buyer's database-expired hold and every
  held allocation to expired; if a current hold remains, durably fail with
  `ACTIVE_HOLD_EXISTS`. Two tabs may replay one command; they may not create
  parallel current holds.
- Recompute the quote from the locked window and exact locked seats before
  inserting a hold. A stale revision is a durable business failure and leaves
  zero new hold/allocation rows.
- Release and expiry both take the session-derived `buyerRef`, include it in
  their semantic request hash, and verify it while the hold and allocations are
  locked. A route-level pre-read is never the ownership authority.
- A snapshot is advisory. The claim response replaces local draft state on any
  conflict.

### Expiry

- `expiresAt` comes from Postgres. The browser calculates only a visual remaining
  duration using the `serverTime` offset.
- Reaching visual zero changes the controller to `checking_expiry`; it does not
  free a seat or claim that the hold expired.
- The controller posts the expiry command, then renders only the returned
  snapshot. If database time says the hold is still active, keep it and schedule
  the next check from the returned times.
- Refresh, page visibility regain, and network recovery fetch a new snapshot.
  Active holds return with the same seats, allocation money, and expiry.
- C2 has no silent renewal.

## Existing DOM inhabitation map

| Baseline pointer | C2 change | Preservation rule |
| --- | --- | --- |
| `src/App.tsx:243-310` (`Shell`) | Pass event/session-safe display facts only. Replace unconditional hosted/payment badges with `LOCAL PROTOTYPE` and database-backed inventory truth. | Keep the 72/28 grid, divider, header, strip, DOM order, and rail render location. |
| `src/App.tsx:316-437` (`EventScreen`) | Replace fixed event/times and all-in range with snapshot fields. General card selects the exact `prototype_open` window. Preserve the `JOIN QUEUE` action slot, with nearby copy stating immediate prototype admission rather than a production queue. | Keep hero, PHANTOM CIRCUIT hierarchy, cards, entrance order, and button treatment. |
| `src/App.tsx:443-545` (`EligibilityScreen`) | Remove fake last-four/network/timers. Show `UNPROVEN · merchant access adapter not connected in C2`; presale cannot advance. General-sale fallback still selects its exact window. | Keep the screen footprint, typography, restrained transition, `VERIFY ACCESS` entry, and fallback position. |
| `src/App.tsx:548-709` (`StageProscenium`) | None. | Byte-identical geometry, paths, labels, colors, and styling. |
| `src/App.tsx:714-855` (`HoldScreen`) | Replace `ROWS_DEF`, `TAKEN`, local price arithmetic, and fake timer with snapshot rows, a local draft set, quote, real claim/release, and `expiresAt`; replace standing copy with assigned-seating truth. | Keep six rows × ten seats, seat button order, stage placement, hover/selection motion, summary hierarchy, and four-seat cap. |
| `src/App.tsx:729-752` (hold banner/progress) | Before commit, same region reads `SELECT UP TO 4 SEATS` and makes no active-hold claim. After commit it reads `INVENTORY HOLD ACTIVE` and animates from server times. | Keep dimensions, urgency treatment, and continuous authored motion. |
| `src/App.tsx:769-803` (seat buttons) | `available` is interactive; draft or `held_by_session` uses selected treatment; every other state uses taken/disabled treatment. Draft toggles immediately, and a fifth seat is rejected without replacing the grid. | Preserve spatial DOM and immediate micro-interaction. Add honest `aria-pressed`, disabled state, and seat/status/price names. |
| `src/App.tsx:806-851` (summary/actions) | Empty: existing prompt. Draft: latest server quote and `HOLD N SEATS`. Active hold: immutable allocation totals, disabled checkout handoff, and `RELEASE HOLD`. Before claim the secondary slot is `RESET SELECTION`. | No client money arithmetic. Reset clears all draft seats and quote immediately; release waits for server response. |
| `src/App.tsx:858-1290` (checkout/results) | Unreachable. | No C2 edits. |
| `src/App.tsx:1293-1440` (coordinator) | Replace inventory timers/random transition for the reachable event/access/hold path with `useOnsaleSession`; keep only reversible local view/draft/focus state. Home/Back cannot hide an effective current hold. | Do not let a callback invent access, hold, price, expiry, order, or payment state. |
| `src/MechanismRail.tsx` | Add a C2 presentation projection from the shared snapshot. Payment/routing/webhook/processor/ticket values and edges remain dim and `UNPROVEN`; inventory draft/claim/release/expiry may animate only from returned server facts. | Keep graph geometry/topology, node/edge DOM order, Policy → Decision → Attempts → State → Evidence panel DOM/order, open defaults, and authored motion hooks. |

The controller's local state is limited to `view`, `selectedSaleWindowRef`,
`draftSeatRefs`, focused seat, latest quote request, and request status. On
bootstrap, an active hold opens the existing hold composition; otherwise the
event composition opens. Eligibility and pre-claim seat selection are reversible
presentation navigation, not server business facts.

## Planned implementation boundary

After C1 approval, C2 may add only:

1. the fixed, apply-only runtime namespace/migration/seed boundary above,
   without changing the ephemeral create/drop guard;
2. a sanitized inventory projection and checked quote reader above the existing
   raw-SQL repository;
3. transaction-local current-hold, quote-revision, and release/expiry ownership
   checks in the mutation path;
4. the five App Router handlers above plus anonymous-session/validation helpers;
5. one client controller and the minimum prop/state replacement inside the
   existing event/access/hold seams;
6. the minimum evidence-safe rail projection without changing its architecture;
7. contract, route, repository-integration, and browser tests for this packet.

No new C2 DDL migration is expected beyond applying existing `0001` to the fixed
runtime namespace. If implementation proves that the current schema cannot
enforce the declared hold/access boundary under the repository's event lock,
stop and revise this packet; do not smuggle a `0002` into the frontend slice.

## Red-to-green proof

The previously passed **17-case inventory/order suite** is lower-layer evidence:
one local migration assertion plus 16 hosted transaction cases. It does not
prove sessions, public projection, quote binding, same-buyer current-hold
policy, foreign expiry, routes, DOM, or rail truth. Preserve that receipt and
rerun all 17 after repository changes. Write and preserve the following **new
C2 tests** before implementation; they are additive, not a renaming of the old
17.

| ID | Red assertion | Green/durable assertion |
| --- | --- | --- |
| `C2-SES-01` | Session snapshot leaks identity or changes owner on refresh. | Cookie persists ownership; raw token and `buyerRef` are absent from JSON/log capture. |
| `C2-DB-01` | Runtime accepts an arbitrary/test/public schema or exposes drop. | Only fixed `onsale_app_v1` is accepted; `0001` apply/seed replays; no runtime drop/capability exists. |
| `C2-SNAP-01` | Hard-coded or malformed map reaches the UI. | Snapshot has rows A-F in order, ten seats each, and 60 unique refs; the fresh-seed fixture alone proves an adjacent selectable four. |
| `C2-SNAP-02` | Both buyers see the same ownership label. | Owner sees `held_by_session`; the other sees `held_by_other`; neither sees the other's IDs. |
| `C2-ACL-01` | Presale proceeds without a durable proof. | Presale is `unproven`/blocked; exact general `prototype_open` window can proceed. |
| `C2-QTE-01` | Browser arithmetic, click order, or a stale quote controls claim. | One-to-four totals are checked server sums; the same seat set has one canonical revision; stale quote creates no hold. |
| `C2-INV-01` | Two sessions can claim the same real seat. | Concurrent commands produce one committed hold and one typed conflict; one active allocation exists. |
| `C2-INV-02` | Overlapping four-seat requests partially commit. | One complete bundle wins; loser owns zero requested allocations. |
| `C2-INV-03` | Zero, five, duplicate, blocked, cross-event, or wrong-window seats mutate inventory. | Each rejects with zero new holds/allocations. |
| `C2-IDEM-01` | Duplicate claim creates another hold. | Same command/payload replays the exact hold; changed payload conflicts. |
| `C2-IDEM-02` | Failed claim succeeds after availability changes under the same key. | The typed failure durably replays; a new key may succeed. |
| `C2-HOLD-01` | Refresh or a second tab loses/duplicates the hold. | Same session receives the exact seats, price snapshots, and expiry; a different command cannot create a second current hold. |
| `C2-HOLD-02` | Client clock frees inventory. | Before DB-time barrier, competing claim fails; after barrier and server transition/reclaim, the full bundle changes owner atomically. |
| `C2-HOLD-03` | Release frees a subset or duplicate release mutates again. | First release frees every allocation; same command replays with no new row/change. |
| `C2-OWN-01` | A second session can inspect, release, or expire another hold by ref. | Every foreign operation returns safe `404`; original hold and allocations are byte-for-byte unchanged. |
| `C2-MNY-01` | Event/seat copy retains `$90`, standing, or browser totals. | Event range and every quote/hold amount match server minor units; assigned-seating copy is consistent. |
| `C2-HTTP-01` | Oversized/non-JSON/cross-origin input reaches the repository or raw errors escape. | Bounded parsing/origin guard stops it; exhaustive sanitized mapping and cache headers pass. |
| `C2-DOM-01` | Data cutover changes authored composition. | Shell and stage structural snapshots match C1; rail topology/panel DOM/motion hooks match C1; hold grid remains 6×10 in identical DOM order. |
| `C2-DOM-02` | Only one seat works or reset is cosmetic. | Pointer and keyboard select at least four distinct real seats; reset clears all; fifth selection is blocked; quote/claim remain coherent. |
| `C2-DOM-03` | UI claims an active hold before commit or keeps ghost selections after conflict. | Active copy appears only with returned hold; conflict snapshot replaces draft/availability. |
| `C2-TRUTH-01` | C2 shows LIVE HOSTED, payment/routing/webhook activity, or an order before those facts exist. | Rail and shell show only local merchant inventory truth; every payment path is dim and `UNPROVEN`. |
| `C2-NAV-01` | Home/Back hides or releases an effective current hold. | Hold remains visible and owned until an explicit committed release/expiry response. |

Proof order:

1. Save the focused red receipt and confirm failures are caused by missing C2
   behavior, not C1 parity drift.
2. Make pure DTO/validation/quote tests green.
3. Make route tests green with a repository boundary double; assert status,
   cache, cookie, error-sanitization, and command-key mapping.
4. Run repository tests locally, then the new integration cases against one
   exact fresh isolated Neon schema only after local gates pass. Always drop it
   with the existing capability/manifest guard and prove zero orphan/public
   tables.
5. Run two isolated browser contexts through select-four → reset → select-four →
   quote → concurrent claim → refresh → release and the bounded expiry barrier.
6. Compare 1440×1000 event/access/selection/held captures with C1 and inspect
   motion, focus, keyboard, narrow layout, console, and network errors.
7. Produce a HANDOFF receipt before any HCI-driven fix; then run the applicable
   HCI Agent Test Lab profile. Synthetic findings do not waive Prithvi's visible
   Gate 2 review.

C2 is green only when the original 17 lower-layer regressions and every new C2
test pass, C1 structural/motion parity remains green, the rail topology/panel
DOM/motion contract remains intact, no false hosted/payment evidence or provider
request occurred, and the reviewer can visibly select/reset multiple seats and
recover the same real hold after refresh.

## Typed decision trace

Pointers below were resolved against the current clean-baseline worktree while
preparing this packet.

| Trace ID | Evidence type | Validated pointer | Observed constraint | Packet consequence |
| --- | --- | --- | --- | --- |
| `TRACE-C2-01` | edited user approach | `ONSALE_SANDBOX_FIRST_REBUILD_APPROACH_v1.0.md:369-392` | Multiple seats must be real/selectable/resettable; Next parity precedes inhabitation; payment, checkout, results, and full rail expansion are later. | C2 is event/seat/hold only; minimum rail truth sanitation prevents baseline fiction. |
| `TRACE-C2-02` | binding experience contract | `docs/FIGMA-EXPERIENCE-CONTRACT.md:7-12,14-48,66-88` | Backend inhabits the authored shell/motion while fake access, inventory, pricing, and timer authority must go. | Preserve composition; replace only business-state seams. |
| `TRACE-C2-03` | accepted port sequence | `docs/VERIFIED-BACKEND-PORT-MAP.md:190-227` | Unit 3 is session/snapshot/command routes and event/seat/hold inhabitation; payment and full rail projection follow separately. | C2 changes no payment behavior; it removes false rail claims while preserving the mechanism architecture. |
| `TRACE-C2-04` | accepted public projection | `docs/VERIFIED-BACKEND-PORT-MAP.md:119-168` | Canvas and rail ultimately share one sanitized snapshot; secrets are never durable/public. | Versioned sanitized C2 subset, extensible later without parallel truth. |
| `TRACE-C2-05` | source observation | `src/App.tsx:714-851` | Six hard-coded rows, hard-coded taken seats, local selection/money, and active-hold copy exist before server commit. | Snapshot rows, local draft only, server quote/claim, honest pre-hold copy. |
| `TRACE-C2-06` | durable model | `docs/DURABLE-DOMAIN-MODEL.md:40-52,121-200,383-400,447-468` | Postgres owns availability/time/money; exact access/window; one-to-four atomic seats; immutable hold snapshots; DB-time release/expiry. | Session-derived commands, quote binding, atomic claim, and server expiry. |
| `TRACE-C2-07` | verified repository seam | `src/server/inventory-neon.ts:1205-1668` | Claim/release/expiry already lock the event/seats, replay operations, snapshot prices, and use DB time. | Extend with public read/quote, current-hold guard, and atomic expiry ownership; do not replace repository. |
| `TRACE-C2-08` | schema fact | `db/migrations/0001_inventory_v1.sql:73-128,228-263,307-361,470-494` | Sale/access/hold/allocation/operation tables exist; access issue is not an operation kind; one active owner per seat is indexed. | General window ships; presale issue is deferred; apply `0001` to the fixed runtime namespace without inventing `0002`. |
| `TRACE-C2-09` | verified lower-layer proof | `tests/integration/inventory-neon.test.ts` cases `INV-01`, `INV-02`, `INV-04`, `INV-05`, `INV-06`, `ACL-01`, `PRC-01` | Transaction invariants passed below HTTP/UI, but public projection/session/DOM behavior is unproven. | Reuse invariants and add the C2 port/browser matrix rather than claiming completion. |
| `TRACE-C2-10` | open boundary | C1 App Router parity is concurrently prepared and not accepted by this packet. | Route file placement may not be frozen, and C2 has not run. | Do not implement until C1 receipt/review; keep this document as the gate contract. |

## Review decision

Approve C2 only if this is the desired next visible increment: a faithful Figma
general-sale seat experience backed by real server inventory and holds, with an
honestly blocked presale, no checkout, and only the minimum truth-safe rail
projection. If live presale is
required in the same increment, reject this packet and create a separate access
grant/idempotency schema unit first.
