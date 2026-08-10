import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless"

import {
  canonicalSeatRefsV1,
  parseOnsaleInventorySnapshotV1,
  parsePublicRefV1,
  sumMoneyBreakdownsV1,
  type ClaimSeatsRequestV1,
  type CommandIdV1,
  type HoldCommandSuccessV1,
  type MoneyBreakdownV1,
  type OnsaleInventorySnapshotV1,
  type PublicHoldItemV1,
  type PublicRef,
  type PublicSaleWindowV1,
  type PublicSeatV1,
  type QuoteSeatsRequestV1,
  type QuoteSeatsResponseV1,
} from "../domain/onsale-public-contract"
import {
  INVENTORY_APP_SCHEMA,
  createInventoryAppSchema,
  quoteInventoryAppSchema,
  requireInventoryAppDatabaseUrl,
  type InventoryAppSchema,
} from "./inventory-app-schema"
import {
  InventoryRepositoryError,
  NeonInventoryRepository,
  type ClaimSeatsResult,
  type ExpireHoldResult,
  type ReleaseHoldResult,
} from "./inventory-neon"
import { createSnapshotRevisionV1 } from "./onsale-canonical-hash"

const SNAPSHOT_PLACEHOLDER_REVISION = `sha256:${"0".repeat(64)}`
const DEFAULT_HOLD_DURATION_MS = 10 * 60 * 1_000

interface EventRow extends QueryResultRow {
  readonly dataset_id: string
  readonly event_id: string
  readonly slug: string
  readonly name: string
  readonly venue_name: string
  readonly venue_timezone: string
  readonly starts_at: Date | string
  readonly currency: string
  readonly seating_mode: string
  readonly display_metadata: unknown
}

interface SaleWindowRow extends QueryResultRow {
  readonly id: string
  readonly kind: "presale" | "general"
  readonly opens_at: Date | string
  readonly closes_at: Date | string
  readonly access_policy_kind: "prototype_open" | "local_prototype_cardmember"
  readonly seat_limit: string | number
  readonly configured_state: "scheduled" | "open" | "paused" | "closed"
}

interface SeatProjectionRow extends QueryResultRow {
  readonly seat_id: string
  readonly section_name: string
  readonly section_ordinal: string | number
  readonly row_label: string
  readonly row_ordinal: string | number
  readonly seat_label: string
  readonly seat_ordinal: string | number
  readonly lifecycle_state: "sellable" | "blocked" | "removed"
  readonly price_tier_name: string
  readonly face_value_minor: string | number
  readonly fee_minor: string | number
  readonly tax_minor: string | number
  readonly total_minor: string | number
  readonly currency: string
  readonly price_effective: boolean
  readonly allocation_state: "held" | "reserved" | null
  readonly allocation_buyer_ref: string | null
  readonly allocation_hold_state: "active" | "converted" | null
  readonly allocation_expires_at: Date | string | null
  readonly allocation_price_tier_name: string | null
  readonly allocation_face_value_minor: string | number | null
  readonly allocation_fee_minor: string | number | null
  readonly allocation_tax_minor: string | number | null
  readonly allocation_total_minor: string | number | null
  readonly allocation_currency: string | null
}

interface CurrentHoldRow extends QueryResultRow {
  readonly id: string
  readonly sale_window_id: string
  readonly expires_at: Date | string
}

interface HoldItemRow extends QueryResultRow {
  readonly seat_id: string
  readonly section_name: string
  readonly row_label: string
  readonly seat_label: string
  readonly row_ordinal: string | number
  readonly seat_ordinal: string | number
  readonly price_tier_name: string
  readonly face_value_minor: string | number
  readonly fee_minor: string | number
  readonly tax_minor: string | number
  readonly total_minor: string | number
  readonly currency: string
  readonly allocation_state: string
}

export interface OnsaleSnapshotReadV1 {
  readonly serverTime: string
  readonly event: EventRow
  readonly saleWindows: readonly SaleWindowRow[]
  readonly seats: readonly SeatProjectionRow[]
  readonly currentHold: CurrentHoldRow | null
  readonly holdItems: readonly HoldItemRow[]
}

export interface OnsaleInventoryServiceOptionsV1 {
  readonly databaseUrl: string
  readonly appSchema?: InventoryAppSchema
}

function integrity(message: string): never {
  throw new InventoryRepositoryError("INVENTORY_INTEGRITY", message)
}

function safeInteger(value: string | number, label: string): number {
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    return integrity(`Invalid ${label} in the inventory projection.`)
  }
  return result
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return integrity("Invalid timestamp in the inventory projection.")
  }
  return date.toISOString()
}

function plainMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return integrity("Event display metadata is malformed.")
  }
  return value as Readonly<Record<string, unknown>>
}

function metadataText(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = metadata[key]
  if (typeof value !== "string" || value.length === 0) {
    return integrity(`Event display metadata is missing ${key}.`)
  }
  return value
}

function moneyFromRow(row: {
  readonly currency: string
  readonly face_value_minor: string | number
  readonly fee_minor: string | number
  readonly tax_minor: string | number
  readonly total_minor: string | number
}): MoneyBreakdownV1 {
  if (row.currency !== "USD") {
    return integrity("The C2 inventory projection supports USD only.")
  }
  const money: MoneyBreakdownV1 = {
    currency: "USD",
    faceValueMinor: safeInteger(row.face_value_minor, "face value"),
    feeMinor: safeInteger(row.fee_minor, "fee"),
    taxMinor: safeInteger(row.tax_minor, "tax"),
    totalMinor: safeInteger(row.total_minor, "total"),
  }
  if (
    money.faceValueMinor + money.feeMinor + money.taxMinor !==
    money.totalMinor
  ) {
    return integrity(
      "Inventory money components do not match the all-in total.",
    )
  }
  return money
}

function effectiveWindowState(
  row: SaleWindowRow,
  serverTime: number,
): PublicSaleWindowV1["state"] {
  if (row.configured_state === "paused") return "paused"
  if (row.configured_state === "closed") return "closed"
  if (serverTime < Date.parse(iso(row.opens_at))) return "scheduled"
  if (serverTime >= Date.parse(iso(row.closes_at))) return "closed"
  return row.configured_state
}

function projectSaleWindow(
  row: SaleWindowRow,
  serverTime: number,
): PublicSaleWindowV1 {
  const state = effectiveWindowState(row, serverTime)
  const access =
    row.kind === "general" && row.access_policy_kind === "prototype_open"
      ? {
          policy: "prototype_open" as const,
          state: "not_required" as const,
          evidenceClass: "merchant_rule" as const,
          expiresAt: null,
        }
      : {
          policy: "local_prototype_cardmember" as const,
          state: "unproven" as const,
          evidenceClass: "unproven" as const,
          expiresAt: null,
        }

  return {
    publicRef: parsePublicRefV1(row.id),
    kind: row.kind,
    state,
    opensAt: iso(row.opens_at),
    closesAt: iso(row.closes_at),
    seatLimit: safeInteger(row.seat_limit, "sale-window seat limit"),
    access,
    canEnter: state === "open" && access.state === "not_required",
  }
}

function projectSeat(
  row: SeatProjectionRow,
  buyerRef: string,
  serverTime: number,
): PublicSeatV1 {
  if (!row.price_effective) {
    return integrity("A visible seat has no price effective in database time.")
  }
  const allocationCurrent =
    row.allocation_state === "reserved" ||
    (row.allocation_state === "held" &&
      row.allocation_hold_state === "active" &&
      row.allocation_expires_at !== null &&
      Date.parse(iso(row.allocation_expires_at)) > serverTime)
  const availability: PublicSeatV1["availability"] =
    row.allocation_state === "reserved"
      ? "reserved"
      : allocationCurrent && row.allocation_buyer_ref === buyerRef
        ? "held_by_session"
        : allocationCurrent
          ? "held_by_other"
          : "available"
  const lifecycle = row.lifecycle_state
  const useAllocationSnapshot =
    row.allocation_state === "held" &&
    row.allocation_hold_state === "active" &&
    row.allocation_buyer_ref === buyerRef
  const price = useAllocationSnapshot
    ? moneyFromRow({
        currency:
          row.allocation_currency ??
          integrity("A held seat is missing its currency snapshot."),
        face_value_minor:
          row.allocation_face_value_minor ??
          integrity("A held seat is missing its face-value snapshot."),
        fee_minor:
          row.allocation_fee_minor ??
          integrity("A held seat is missing its fee snapshot."),
        tax_minor:
          row.allocation_tax_minor ??
          integrity("A held seat is missing its tax snapshot."),
        total_minor:
          row.allocation_total_minor ??
          integrity("A held seat is missing its total snapshot."),
      })
    : moneyFromRow(row)
  return {
    publicRef: parsePublicRefV1(row.seat_id),
    sectionLabel: row.section_name,
    rowLabel: row.row_label,
    seatLabel: row.seat_label,
    rowOrdinal: safeInteger(row.row_ordinal, "row ordinal"),
    seatOrdinal: safeInteger(row.seat_ordinal, "seat ordinal"),
    lifecycle,
    availability,
    selectable: lifecycle === "sellable" && availability === "available",
    priceTier: useAllocationSnapshot
      ? (row.allocation_price_tier_name ??
        integrity("A held seat is missing its price-tier snapshot."))
      : row.price_tier_name,
    price,
  }
}

function projectHoldItems(
  rows: readonly HoldItemRow[],
): readonly PublicHoldItemV1[] {
  return [...rows]
    .sort(
      (left, right) =>
        safeInteger(left.row_ordinal, "row ordinal") -
          safeInteger(right.row_ordinal, "row ordinal") ||
        safeInteger(left.seat_ordinal, "seat ordinal") -
          safeInteger(right.seat_ordinal, "seat ordinal"),
    )
    .map((row) => {
      if (row.allocation_state !== "held") {
        return integrity("An active hold has a non-held allocation.")
      }
      return {
        seatRef: parsePublicRefV1(row.seat_id),
        sectionLabel: row.section_name,
        rowLabel: row.row_label,
        seatLabel: row.seat_label,
        priceTier: row.price_tier_name,
        price: moneyFromRow(row),
      }
    })
}

export class OnsaleInventoryServiceV1 {
  readonly #schema: InventoryAppSchema
  readonly #quotedSchema: string
  readonly #pool: Pool
  readonly #repository: NeonInventoryRepository

  constructor(options: OnsaleInventoryServiceOptionsV1) {
    const databaseUrl = requireInventoryAppDatabaseUrl({
      DATABASE_URL: options.databaseUrl,
    })
    this.#schema =
      options.appSchema ?? createInventoryAppSchema(INVENTORY_APP_SCHEMA)
    this.#quotedSchema = quoteInventoryAppSchema(this.#schema)
    this.#pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 5_000,
    })
    this.#repository = new NeonInventoryRepository({
      databaseUrl,
      appSchema: this.#schema,
      pool: this.#pool,
    })
  }

  async close(): Promise<void> {
    await Promise.all([this.#repository.close(), this.#pool.end()])
  }

  table(name: string): string {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
      return integrity("Invalid internal inventory table name.")
    }
    return `${this.#quotedSchema}.${name}`
  }

  private async readSnapshotRows(
    client: PoolClient,
    buyerRef: string,
  ): Promise<OnsaleSnapshotReadV1> {
    const captured = await client.query<{ server_time: Date | string }>(
      "select clock_timestamp() as server_time",
    )
    const serverTime = iso(captured.rows[0]?.server_time)
    const events = await client.query<EventRow>(
      `select
         d.id as dataset_id, e.id as event_id, e.slug, e.name, e.venue_name,
         e.venue_timezone, e.starts_at, e.currency, e.seating_mode,
         e.display_metadata
       from ${this.table("prototype_dataset")} d
       join ${this.table("event")} e on e.dataset_id = d.id
       where d.state = 'active' and e.state = 'on_sale'
       order by e.id
       limit 2`,
    )
    if (events.rowCount !== 1) {
      return integrity("Expected exactly one active ONSALE event.")
    }
    const event = events.rows[0]

    const saleWindows = await client.query<SaleWindowRow>(
      `select
         sw.id, sw.kind, sw.opens_at, sw.closes_at, sw.access_policy_kind,
         sw.seat_limit, sw.state as configured_state
       from ${this.table("sale_window")} sw
       where sw.dataset_id = $1 and sw.event_id = $2
       order by case sw.kind when 'presale' then 1 else 2 end`,
      [event.dataset_id, event.event_id],
    )

    const seats = await client.query<SeatProjectionRow>(
      `select
         s.id as seat_id, sec.name as section_name,
         sec.ordinal as section_ordinal, sr.label as row_label,
         sr.ordinal as row_ordinal, s.label as seat_label,
         s.ordinal as seat_ordinal, s.lifecycle_state,
         pt.name as price_tier_name, pt.face_value_minor, pt.fee_minor,
         pt.tax_minor, pt.all_in_minor as total_minor, pt.currency,
         pt.effective_from <= $3::timestamptz
           and (pt.effective_until is null or pt.effective_until > $3::timestamptz)
           as price_effective,
         owner.state as allocation_state,
         owner.buyer_ref as allocation_buyer_ref,
         owner.hold_state as allocation_hold_state,
         owner.expires_at as allocation_expires_at,
         owner.price_tier_name as allocation_price_tier_name,
         owner.face_value_minor as allocation_face_value_minor,
         owner.fee_minor as allocation_fee_minor,
         owner.tax_minor as allocation_tax_minor,
         owner.total_minor as allocation_total_minor,
         owner.currency as allocation_currency
       from ${this.table("seat")} s
       join ${this.table("section")} sec on sec.id = s.section_id
       join ${this.table("seat_row")} sr on sr.id = s.row_id
       join ${this.table("price_tier")} pt on pt.id = s.price_tier_id
       left join lateral (
         select a.state, h.buyer_ref, h.state as hold_state, h.expires_at,
                a.price_tier_name, a.face_value_minor, a.fee_minor,
                a.tax_minor, a.total_minor, a.currency
         from ${this.table("seat_allocation")} a
         join ${this.table("hold")} h on h.id = a.hold_id
         where a.seat_id = s.id and a.state in ('held', 'reserved')
         order by case a.state when 'reserved' then 1 else 2 end, a.created_at desc
         limit 1
       ) owner on true
       where s.dataset_id = $1 and s.event_id = $2
       order by sec.ordinal, sr.ordinal, s.ordinal`,
      [event.dataset_id, event.event_id, serverTime],
    )

    const holds = await client.query<CurrentHoldRow>(
      `select id, sale_window_id, expires_at
       from ${this.table("hold")}
       where dataset_id = $1 and event_id = $2 and buyer_ref = $3
         and state = 'active'
       order by created_at desc, id desc
       limit 2`,
      [event.dataset_id, event.event_id, buyerRef],
    )
    if (holds.rows.length > 1) {
      return integrity(
        "The session has more than one active hold for the event.",
      )
    }
    const currentHold = holds.rows[0] ?? null
    const holdItems = currentHold
      ? await client.query<HoldItemRow>(
          `select
             a.seat_id, sec.name as section_name, sr.label as row_label,
             s.label as seat_label, sr.ordinal as row_ordinal,
             s.ordinal as seat_ordinal, a.price_tier_name,
             a.face_value_minor, a.fee_minor, a.tax_minor,
             a.total_minor, a.currency, a.state as allocation_state
           from ${this.table("seat_allocation")} a
           join ${this.table("seat")} s on s.id = a.seat_id
           join ${this.table("section")} sec on sec.id = s.section_id
           join ${this.table("seat_row")} sr on sr.id = s.row_id
           where a.hold_id = $1
           order by sec.ordinal, sr.ordinal, s.ordinal`,
          [currentHold.id],
        )
      : { rows: [] as HoldItemRow[] }

    return {
      serverTime,
      event,
      saleWindows: saleWindows.rows,
      seats: seats.rows,
      currentHold,
      holdItems: holdItems.rows,
    }
  }

  async snapshot(buyerRef: string): Promise<OnsaleInventorySnapshotV1> {
    const client = await this.#pool.connect()
    try {
      await client.query("begin isolation level repeatable read read only")
      await client.query("select set_config('statement_timeout', $1, true)", [
        "15s",
      ])
      const read = await this.readSnapshotRows(client, buyerRef)
      const snapshot = OnsaleInventoryServiceV1.projectSnapshot(read, buyerRef)
      await client.query("commit")
      return snapshot
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  static projectSnapshot(
    read: OnsaleSnapshotReadV1,
    buyerRef: string,
  ): OnsaleInventorySnapshotV1 {
    const metadata = plainMetadata(read.event.display_metadata)
    const serverTimeMs = Date.parse(read.serverTime)
    const saleWindows = [...read.saleWindows]
      .sort((left, right) =>
        left.kind === right.kind ? 0 : left.kind === "presale" ? -1 : 1,
      )
      .map((row) => projectSaleWindow(row, serverTimeMs))
    if (
      saleWindows.length !== 2 ||
      saleWindows[0]?.kind !== "presale" ||
      saleWindows[1]?.kind !== "general"
    ) {
      return integrity(
        "The active event must expose exactly presale and general windows.",
      )
    }

    const seats = read.seats.map((row) =>
      projectSeat(row, buyerRef, serverTimeMs),
    )
    if (seats.length !== 60) {
      return integrity("The active seat map must contain exactly 60 seats.")
    }
    const rows = new Map<number, {
      label: string
      ordinal: number
      seats: PublicSeatV1[]
    }>()
    for (const seat of seats) {
      const existing = rows.get(seat.rowOrdinal)
      if (existing && existing.label !== seat.rowLabel) {
        return integrity("Seat rows have contradictory labels.")
      }
      const row = existing ?? {
        label: seat.rowLabel,
        ordinal: seat.rowOrdinal,
        seats: [],
      }
      row.seats.push(seat)
      rows.set(seat.rowOrdinal, row)
    }
    const orderedRows = [...rows.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    )
    if (
      orderedRows.length !== 6 ||
      orderedRows.some(
        (row, index) =>
          row.label !== String.fromCharCode(65 + index) ||
          row.ordinal !== index + 1 ||
          row.seats.length !== 10,
      )
    ) {
      return integrity(
        "The active seat map is not the required six-by-ten grid.",
      )
    }

    const holdItems = projectHoldItems(read.holdItems)
    if (read.currentHold && (holdItems.length < 1 || holdItems.length > 4)) {
      return integrity(
        "An active hold must own one to four complete allocations.",
      )
    }
    const holdCurrent =
      read.currentHold !== null &&
      Date.parse(iso(read.currentHold.expires_at)) > serverTimeMs
    const currentHold = read.currentHold
      ? {
          publicRef: parsePublicRefV1(read.currentHold.id),
          state: holdCurrent
            ? "active" as const
            : "expired_pending_reconcile" as const,
          saleWindowRef: parsePublicRefV1(read.currentHold.sale_window_id),
          expiresAt: iso(read.currentHold.expires_at),
          items: holdItems,
          totals: sumMoneyBreakdownsV1(holdItems.map((item) => item.price)),
        }
      : null
    const sellableTotals = seats
      .filter((seat) => seat.lifecycle === "sellable")
      .map((seat) => seat.price.totalMinor)
    if (sellableTotals.length === 0) {
      return integrity("The active seat map has no sellable prices.")
    }
    const generalWindow = saleWindows.find(
      (window) => window.kind === "general",
    )
    if (!generalWindow) {
      return integrity("The active event is missing its general sale window.")
    }

    const draft = parseOnsaleInventorySnapshotV1({
      schema: "onsale.inventory.v1",
      revision: SNAPSHOT_PLACEHOLDER_REVISION,
      serverTime: read.serverTime,
      inventoryState: read.currentHold
        ? holdCurrent
          ? "held"
          : "expiry_check_required"
        : "ready",
      session: {
        kind: "anonymous_browser",
        ownsActiveHold: holdCurrent,
      },
      event: {
        publicRef: parsePublicRefV1(read.event.event_id),
        slug: read.event.slug,
        name: read.event.name,
        tourName: metadataText(metadata, "tour_name"),
        venueName: read.event.venue_name,
        cityLabel: metadataText(metadata, "city_label"),
        venueTimezone: read.event.venue_timezone,
        startsAt: iso(read.event.starts_at),
        heroAssetRef: metadataText(metadata, "hero_asset_ref"),
        evidenceClass: "simulation",
        currency: "USD",
        seatingMode: "assigned",
        maximumSeatCount: 4,
        allInPriceRange: {
          minimumMinor: Math.min(...sellableTotals),
          maximumMinor: Math.max(...sellableTotals),
        },
        saleWindows,
      },
      seatMap: {
        sectionLabel: orderedRows[0]?.seats[0]?.sectionLabel,
        rowCount: 6,
        seatsPerRow: 10,
        rows: orderedRows,
      },
      currentHold,
      capabilities: {
        quote: generalWindow.canEnter && currentHold === null,
        claim: generalWindow.canEnter && currentHold === null,
        release: currentHold?.state === "active",
        reconcileExpiry: currentHold?.state === "expired_pending_reconcile",
        checkout: false,
      },
    })
    return parseOnsaleInventorySnapshotV1({
      ...draft,
      revision: createSnapshotRevisionV1(draft),
    })
  }

  async quote(
    buyerRef: string,
    request: QuoteSeatsRequestV1,
  ): Promise<QuoteSeatsResponseV1> {
    const basis = await this.snapshot(buyerRef)
    const quoted = await this.#repository.quoteSeats({
      eventId: basis.event.publicRef,
      saleWindowId: request.saleWindowRef,
      buyerRef,
      seatIds: request.seatRefs,
    })
    const items: readonly PublicHoldItemV1[] = quoted.items.map((item) => ({
      seatRef: parsePublicRefV1(item.seatId),
      sectionLabel: item.sectionName,
      rowLabel: item.rowLabel,
      seatLabel: item.seatLabel,
      priceTier: item.priceTierName,
      price: {
        currency: "USD",
        faceValueMinor: item.price.subtotalMinor,
        feeMinor: item.price.feeMinor,
        taxMinor: item.price.taxMinor,
        totalMinor: item.price.totalMinor,
      },
    }))
    return {
      ok: true,
      requestId: request.requestId,
      basisRevision: basis.revision,
      quoteRevision: quoted.quoteRevision,
      saleWindowRef: parsePublicRefV1(quoted.saleWindowId),
      seatRefs: canonicalSeatRefsV1(quoted.seatIds),
      items,
      totals: {
        currency: "USD",
        faceValueMinor: quoted.totals.subtotalMinor,
        feeMinor: quoted.totals.feeMinor,
        taxMinor: quoted.totals.taxMinor,
        totalMinor: quoted.totals.totalMinor,
      },
    }
  }

  async claim(
    buyerRef: string,
    operationKey: string,
    request: ClaimSeatsRequestV1,
  ): Promise<HoldCommandSuccessV1> {
    const before = await this.snapshot(buyerRef)
    const result = await this.#repository.claimQuotedSeats({
      operationKey,
      eventId: before.event.publicRef,
      saleWindowId: request.saleWindowRef,
      buyerRef,
      seatIds: request.seatRefs,
      holdForMs: DEFAULT_HOLD_DURATION_MS,
      quoteRevision: request.quoteRevision,
    })
    const snapshot = await this.snapshot(buyerRef)
    return this.holdClaimedResponse(request.commandId, result, snapshot)
  }

  private holdClaimedResponse(
    commandId: CommandIdV1,
    result: ClaimSeatsResult,
    snapshot: OnsaleInventorySnapshotV1,
  ): HoldCommandSuccessV1 {
    return {
      ok: true,
      command: {
        commandId,
        replayed: result.replayed,
        result: {
          kind: "hold_claimed",
          holdRef: parsePublicRefV1(result.holdId),
          seatRefs: canonicalSeatRefsV1(result.seatIds),
        },
      },
      snapshot,
    }
  }

  async release(
    buyerRef: string,
    operationKey: string,
    commandId: CommandIdV1,
    holdRef: PublicRef,
  ): Promise<HoldCommandSuccessV1> {
    const result = await this.#repository.releaseHold({
      operationKey,
      holdId: holdRef,
      buyerRef,
    })
    const snapshot = await this.snapshot(buyerRef)
    return this.holdReleasedResponse(commandId, result, snapshot)
  }

  private holdReleasedResponse(
    commandId: CommandIdV1,
    result: ReleaseHoldResult,
    snapshot: OnsaleInventorySnapshotV1,
  ): HoldCommandSuccessV1 {
    return {
      ok: true,
      command: {
        commandId,
        replayed: result.replayed,
        result: {
          kind: "hold_released",
          holdRef: parsePublicRefV1(result.holdId),
          seatRefs: canonicalSeatRefsV1(result.releasedSeatIds),
        },
      },
      snapshot,
    }
  }

  async expire(
    buyerRef: string,
    operationKey: string,
    commandId: CommandIdV1,
    holdRef: PublicRef,
  ): Promise<HoldCommandSuccessV1> {
    const result = await this.#repository.expireHold({
      operationKey,
      holdId: holdRef,
      buyerRef,
    })
    const snapshot = await this.snapshot(buyerRef)
    return this.holdExpiredResponse(commandId, result, snapshot)
  }

  private holdExpiredResponse(
    commandId: CommandIdV1,
    result: ExpireHoldResult,
    snapshot: OnsaleInventorySnapshotV1,
  ): HoldCommandSuccessV1 {
    const resultBody =
      result.state === "active"
        ? {
            kind: "hold_not_yet_expired" as const,
            holdRef: parsePublicRefV1(result.holdId),
          }
        : {
            kind: "hold_expired" as const,
            holdRef: parsePublicRefV1(result.holdId),
            seatRefs: result.releasedSeatIds.map((seatId) =>
              parsePublicRefV1(seatId),
            ),
          }
    return {
      ok: true,
      command: {
        commandId,
        replayed: result.replayed,
        result: resultBody,
      },
      snapshot,
    }
  }
}
