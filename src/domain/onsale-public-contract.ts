/**
 * Browser-safe public contracts for the C2 ONSALE inventory slice.
 *
 * This module deliberately has no server, database, or provider imports. Every
 * value crossing the HTTP boundary is parsed here exactly once before callers
 * may treat it as trusted application data.
 */

declare const publicRefBrand: unique symbol
declare const requestIdBrand: unique symbol
declare const commandIdBrand: unique symbol
declare const sha256RevisionBrand: unique symbol

export type PublicRef = string & { readonly [publicRefBrand]: "PublicRef" }
export type RequestIdV1 = string & { readonly [requestIdBrand]: "RequestIdV1" }
export type CommandIdV1 = string & { readonly [commandIdBrand]: "CommandIdV1" }
export type Sha256RevisionV1 = string & {
  readonly [sha256RevisionBrand]: "Sha256RevisionV1"
}

export type SeatRefs = readonly [PublicRef] | readonly [PublicRef, PublicRef] | readonly [PublicRef, PublicRef, PublicRef] | readonly [PublicRef, PublicRef, PublicRef, PublicRef]

export interface MoneyBreakdownV1 {
  readonly currency: "USD"
  readonly faceValueMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
}

export interface PublicSaleWindowV1 {
  readonly publicRef: PublicRef
  readonly kind: "presale" | "general"
  readonly state: "scheduled" | "open" | "paused" | "closed"
  readonly opensAt: string
  readonly closesAt: string
  readonly seatLimit: number
  readonly access: {
    readonly policy: "prototype_open" | "local_prototype_cardmember"
    readonly state: "not_required" | "unproven" | "verified_local_prototype" | "expired" | "revoked"
    readonly evidenceClass: "merchant_rule" | "unproven"
    readonly expiresAt: string | null
  }
  readonly canEnter: boolean
}

export interface PublicSeatV1 {
  readonly publicRef: PublicRef
  readonly sectionLabel: string
  readonly rowLabel: string
  readonly seatLabel: string
  readonly rowOrdinal: number
  readonly seatOrdinal: number
  readonly lifecycle: "sellable" | "blocked" | "removed"
  readonly availability: "available" | "held_by_session" | "held_by_other" | "reserved"
  readonly selectable: boolean
  readonly priceTier: string
  readonly price: MoneyBreakdownV1
}

export interface PublicHoldItemV1 {
  readonly seatRef: PublicRef
  readonly sectionLabel: string
  readonly rowLabel: string
  readonly seatLabel: string
  readonly priceTier: string
  readonly price: MoneyBreakdownV1
}

export interface PublicHoldV1 {
  readonly publicRef: PublicRef
  readonly state: "active" | "expired_pending_reconcile"
  readonly saleWindowRef: PublicRef
  readonly expiresAt: string
  readonly items: readonly PublicHoldItemV1[]
  readonly totals: MoneyBreakdownV1
}

export interface OnsaleInventorySnapshotV1 {
  readonly schema: "onsale.inventory.v1"
  readonly revision: Sha256RevisionV1
  readonly serverTime: string
  readonly inventoryState: "ready" | "held" | "expiry_check_required"
  readonly session: {
    readonly kind: "anonymous_browser"
    readonly ownsActiveHold: boolean
  }
  readonly event: {
    readonly publicRef: PublicRef
    readonly slug: string
    readonly name: string
    readonly tourName: string
    readonly venueName: string
    readonly cityLabel: string
    readonly venueTimezone: string
    readonly startsAt: string
    readonly heroAssetRef: string
    readonly evidenceClass: "simulation"
    readonly currency: "USD"
    readonly seatingMode: "assigned"
    readonly maximumSeatCount: 4
    readonly allInPriceRange: {
      readonly minimumMinor: number
      readonly maximumMinor: number
    }
    readonly saleWindows: readonly PublicSaleWindowV1[]
  }
  readonly seatMap: {
    readonly sectionLabel: string
    readonly rowCount: 6
    readonly seatsPerRow: 10
    readonly rows: readonly {
      readonly label: string
      readonly ordinal: number
      readonly seats: readonly PublicSeatV1[]
    }[]
  }
  readonly currentHold: PublicHoldV1 | null
  readonly capabilities: {
    readonly quote: boolean
    readonly claim: boolean
    readonly release: boolean
    readonly reconcileExpiry: boolean
    readonly checkout: false
  }
}

export interface QuoteSeatsRequestV1 {
  readonly requestId: RequestIdV1
  readonly saleWindowRef: PublicRef
  readonly seatRefs: SeatRefs
}

export interface QuoteSeatsResponseV1 {
  readonly ok: true
  readonly requestId: RequestIdV1
  readonly basisRevision: Sha256RevisionV1
  readonly quoteRevision: Sha256RevisionV1
  readonly saleWindowRef: PublicRef
  readonly seatRefs: SeatRefs
  readonly items: readonly PublicHoldItemV1[]
  readonly totals: MoneyBreakdownV1
}

export interface ClaimSeatsRequestV1 {
  readonly commandId: CommandIdV1
  readonly saleWindowRef: PublicRef
  readonly seatRefs: SeatRefs
  readonly quoteRevision: Sha256RevisionV1
}

export interface HoldSelectorCommandV1 {
  readonly commandId: CommandIdV1
}

export type HoldCommandResultV1 = {
  readonly kind: "hold_claimed"
  readonly holdRef: PublicRef
  readonly seatRefs: SeatRefs
} | {
  readonly kind: "hold_released"
  readonly holdRef: PublicRef
  readonly seatRefs: SeatRefs
} | {
  readonly kind: "hold_expired"
  readonly holdRef: PublicRef
  readonly seatRefs: readonly PublicRef[]
} | {
  readonly kind: "hold_not_yet_expired"
  readonly holdRef: PublicRef
}

export interface HoldCommandSuccessV1 {
  readonly ok: true
  readonly command: {
    readonly commandId: CommandIdV1
    readonly replayed: boolean
    readonly result: HoldCommandResultV1
  }
  readonly snapshot: OnsaleInventorySnapshotV1
}

export type PublicInventoryErrorCodeV1 = "INVALID_REQUEST" | "REQUEST_ORIGIN_DENIED" | "INVENTORY_INTEGRITY_ERROR" | "SALE_WINDOW_NOT_OPEN" | "ACCESS_REQUIRED" | "SEAT_NOT_AVAILABLE" | "QUOTE_STALE" | "ACTIVE_HOLD_EXISTS" | "HOLD_NOT_FOUND" | "HOLD_NOT_ACTIVE" | "IDEMPOTENCY_CONFLICT" | "INVENTORY_TEMPORARILY_UNAVAILABLE"

export interface InventoryFailureV1 {
  readonly ok: false
  readonly commandId?: CommandIdV1
  readonly error: {
    readonly code: PublicInventoryErrorCodeV1
    readonly message: string
    readonly retryable: boolean
    readonly seatRefs?: readonly PublicRef[]
  }
  readonly snapshot?: OnsaleInventorySnapshotV1
}

export class PublicContractParseError extends TypeError {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`Invalid public contract at ${path}: ${reason}`)
    this.name = "PublicContractParseError"
    this.path = path
  }
}

type PlainRecord = Record<string, unknown>

const PUBLIC_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/
const UTC_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function fail(path: string, reason: string): never {
  throw new PublicContractParseError(path, reason)
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(path, "expected an object")
  }
  const allowed = new Set([...keys, ...optionalKeys])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown key")
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key}`, "missing key")
    }
  }
  return value as PlainRecord
}

function literal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return fail(path, `expected ${allowed.join(" | ")}`)
  }
  return value as T
}

function text(value: unknown, path: string, maximumLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fail(path, "expected non-empty bounded text")
  }
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected a boolean")
  return value
}

function integer(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(path, `expected a safe integer from ${minimum} to ${maximum}`)
  }
  return value
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "expected an array")
  return value
}

function utcInstant(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !UTC_ISO_INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return fail(path, "expected a UTC ISO-8601 instant")
  }
  return value
}

export function parsePublicRefV1(
  value: unknown,
  path = "$publicRef",
): PublicRef {
  if (typeof value !== "string" || !PUBLIC_UUID.test(value)) {
    return fail(path, "expected an opaque UUID v4 or v7 reference")
  }
  return value.toLowerCase() as PublicRef
}

export function parseRequestIdV1(
  value: unknown,
  path = "$requestId",
): RequestIdV1 {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    return fail(path, "expected a crypto.randomUUID UUID v4 identifier")
  }
  return value.toLowerCase() as RequestIdV1
}

export function parseCommandIdV1(
  value: unknown,
  path = "$commandId",
): CommandIdV1 {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    return fail(path, "expected a crypto.randomUUID UUID v4 identifier")
  }
  return value.toLowerCase() as CommandIdV1
}

export function parseSha256RevisionV1(
  value: unknown,
  path = "$revision",
): Sha256RevisionV1 {
  if (typeof value !== "string" || !SHA256_REVISION.test(value)) {
    return fail(
      path,
      "expected sha256 plus 64 lowercase hexadecimal characters",
    )
  }
  return value as Sha256RevisionV1
}

export function checkedAddMinorV1(...values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "Money components must be non-negative safe integers",
      )
    }
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError("Money addition exceeds the safe integer range")
    }
    total += value
  }
  return total
}

/** Locale-independent UTF-16 code-unit order for semantic identifiers. */
export function compareCanonicalStringsV1(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseMoneyBreakdownV1(value: unknown, path: string): MoneyBreakdownV1 {
  const input = record(value, path, [
    "currency",
    "faceValueMinor",
    "feeMinor",
    "taxMinor",
    "totalMinor",
  ])
  const result: MoneyBreakdownV1 = {
    currency: literal(input.currency, ["USD"], `${path}.currency`),
    faceValueMinor: integer(input.faceValueMinor, `${path}.faceValueMinor`),
    feeMinor: integer(input.feeMinor, `${path}.feeMinor`),
    taxMinor: integer(input.taxMinor, `${path}.taxMinor`),
    totalMinor: integer(input.totalMinor, `${path}.totalMinor`),
  }
  let expected: number
  try {
    expected = checkedAddMinorV1(
      result.faceValueMinor,
      result.feeMinor,
      result.taxMinor,
    )
  } catch {
    return fail(path, "money components overflow")
  }
  if (result.totalMinor !== expected)
    return fail(path, "total does not match components")
  return result
}

export function sumMoneyBreakdownsV1(
  values: readonly MoneyBreakdownV1[],
): MoneyBreakdownV1 {
  let faceValueMinor = 0
  let feeMinor = 0
  let taxMinor = 0
  for (const value of values) {
    if (value.currency !== "USD")
      throw new RangeError("Mixed currency is not supported")
    const verifiedTotal = checkedAddMinorV1(
      value.faceValueMinor,
      value.feeMinor,
      value.taxMinor,
    )
    if (value.totalMinor !== verifiedTotal) {
      throw new RangeError("Money total does not match its components")
    }
    faceValueMinor = checkedAddMinorV1(faceValueMinor, value.faceValueMinor)
    feeMinor = checkedAddMinorV1(feeMinor, value.feeMinor)
    taxMinor = checkedAddMinorV1(taxMinor, value.taxMinor)
  }
  return {
    currency: "USD",
    faceValueMinor,
    feeMinor,
    taxMinor,
    totalMinor: checkedAddMinorV1(faceValueMinor, feeMinor, taxMinor),
  }
}

export function canonicalSeatRefsV1(values: readonly unknown[]): SeatRefs {
  if (values.length < 1 || values.length > 4) {
    return fail("$seatRefs", "expected one to four seat references")
  }
  const refs = values.map((value, index) =>
    parsePublicRefV1(value, `$seatRefs[${index}]`),
  )
  const sorted = [...refs].sort(compareCanonicalStringsV1)
  if (new Set(sorted).size !== sorted.length) {
    return fail("$seatRefs", "seat references must be distinct")
  }
  return sorted as unknown as SeatRefs
}

function parseSaleWindowV1(value: unknown, path: string): PublicSaleWindowV1 {
  const input = record(value, path, [
    "publicRef",
    "kind",
    "state",
    "opensAt",
    "closesAt",
    "seatLimit",
    "access",
    "canEnter",
  ])
  const accessPath = `${path}.access`
  const access = record(input.access, accessPath, [
    "policy",
    "state",
    "evidenceClass",
    "expiresAt",
  ])
  const parsedAccess: PublicSaleWindowV1["access"] = {
    policy: literal(
      access.policy,
      ["prototype_open", "local_prototype_cardmember"],
      `${accessPath}.policy`,
    ),
    state: literal(
      access.state,
      [
        "not_required",
        "unproven",
        "verified_local_prototype",
        "expired",
        "revoked",
      ],
      `${accessPath}.state`,
    ),
    evidenceClass: literal(
      access.evidenceClass,
      ["merchant_rule", "unproven"],
      `${accessPath}.evidenceClass`,
    ),
    expiresAt:
      access.expiresAt === null
        ? null
        : utcInstant(access.expiresAt, `${accessPath}.expiresAt`),
  }
  const parsed: PublicSaleWindowV1 = {
    publicRef: parsePublicRefV1(input.publicRef, `${path}.publicRef`),
    kind: literal(input.kind, ["presale", "general"], `${path}.kind`),
    state: literal(
      input.state,
      ["scheduled", "open", "paused", "closed"],
      `${path}.state`,
    ),
    opensAt: utcInstant(input.opensAt, `${path}.opensAt`),
    closesAt: utcInstant(input.closesAt, `${path}.closesAt`),
    seatLimit: integer(input.seatLimit, `${path}.seatLimit`, 1, 4),
    access: parsedAccess,
    canEnter: bool(input.canEnter, `${path}.canEnter`),
  }
  if (Date.parse(parsed.opensAt) >= Date.parse(parsed.closesAt)) {
    return fail(path, "sale window must close after it opens")
  }
  const accessAllowsEntry =
    parsed.access.state === "not_required" ||
    parsed.access.state === "verified_local_prototype"
  const expectedCanEnter = parsed.state === "open" && accessAllowsEntry
  if (parsed.canEnter !== expectedCanEnter) {
    return fail(path, "canEnter contradicts window/access state")
  }
  if (
    parsed.access.policy === "prototype_open" &&
    (parsed.access.state !== "not_required" ||
      parsed.access.evidenceClass !== "merchant_rule" ||
      parsed.access.expiresAt !== null)
  ) {
    return fail(
      accessPath,
      "prototype-open access must be a non-expiring merchant rule",
    )
  }
  if (
    parsed.access.state === "verified_local_prototype" &&
    (parsed.access.evidenceClass !== "merchant_rule" ||
      parsed.access.expiresAt === null)
  ) {
    return fail(
      accessPath,
      "verified local access needs merchant evidence and expiry",
    )
  }
  if (
    parsed.access.state === "unproven" &&
    parsed.access.evidenceClass !== "unproven"
  ) {
    return fail(accessPath, "unproven access needs unproven evidence")
  }
  return parsed
}

function parseSeatV1(value: unknown, path: string): PublicSeatV1 {
  const input = record(value, path, [
    "publicRef",
    "sectionLabel",
    "rowLabel",
    "seatLabel",
    "rowOrdinal",
    "seatOrdinal",
    "lifecycle",
    "availability",
    "selectable",
    "priceTier",
    "price",
  ])
  const parsed: PublicSeatV1 = {
    publicRef: parsePublicRefV1(input.publicRef, `${path}.publicRef`),
    sectionLabel: text(input.sectionLabel, `${path}.sectionLabel`, 120),
    rowLabel: text(input.rowLabel, `${path}.rowLabel`, 32),
    seatLabel: text(input.seatLabel, `${path}.seatLabel`, 32),
    rowOrdinal: integer(input.rowOrdinal, `${path}.rowOrdinal`, 1, 6),
    seatOrdinal: integer(input.seatOrdinal, `${path}.seatOrdinal`, 1, 10),
    lifecycle: literal(
      input.lifecycle,
      ["sellable", "blocked", "removed"],
      `${path}.lifecycle`,
    ),
    availability: literal(
      input.availability,
      ["available", "held_by_session", "held_by_other", "reserved"],
      `${path}.availability`,
    ),
    selectable: bool(input.selectable, `${path}.selectable`),
    priceTier: text(input.priceTier, `${path}.priceTier`, 120),
    price: parseMoneyBreakdownV1(input.price, `${path}.price`),
  }
  const expectedSelectable =
    parsed.lifecycle === "sellable" && parsed.availability === "available"
  if (parsed.selectable !== expectedSelectable) {
    return fail(path, "selectable contradicts lifecycle/availability")
  }
  return parsed
}

function parseHoldItemV1(value: unknown, path: string): PublicHoldItemV1 {
  const input = record(value, path, [
    "seatRef",
    "sectionLabel",
    "rowLabel",
    "seatLabel",
    "priceTier",
    "price",
  ])
  return {
    seatRef: parsePublicRefV1(input.seatRef, `${path}.seatRef`),
    sectionLabel: text(input.sectionLabel, `${path}.sectionLabel`, 120),
    rowLabel: text(input.rowLabel, `${path}.rowLabel`, 32),
    seatLabel: text(input.seatLabel, `${path}.seatLabel`, 32),
    priceTier: text(input.priceTier, `${path}.priceTier`, 120),
    price: parseMoneyBreakdownV1(input.price, `${path}.price`),
  }
}

function parseHoldV1(value: unknown, path: string): PublicHoldV1 {
  const input = record(value, path, [
    "publicRef",
    "state",
    "saleWindowRef",
    "expiresAt",
    "items",
    "totals",
  ])
  const items = array(input.items, `${path}.items`).map((item, index) =>
    parseHoldItemV1(item, `${path}.items[${index}]`),
  )
  if (items.length < 1 || items.length > 4) {
    return fail(`${path}.items`, "expected one to four hold items")
  }
  if (new Set(items.map((item) => item.seatRef)).size !== items.length) {
    return fail(`${path}.items`, "hold seat references must be distinct")
  }
  const totals = parseMoneyBreakdownV1(input.totals, `${path}.totals`)
  let expected: MoneyBreakdownV1
  try {
    expected = sumMoneyBreakdownsV1(items.map((item) => item.price))
  } catch {
    return fail(`${path}.totals`, "hold totals overflow")
  }
  if (canonicalJsonV1(totals) !== canonicalJsonV1(expected)) {
    return fail(`${path}.totals`, "hold totals do not match item prices")
  }
  return {
    publicRef: parsePublicRefV1(input.publicRef, `${path}.publicRef`),
    state: literal(
      input.state,
      ["active", "expired_pending_reconcile"],
      `${path}.state`,
    ),
    saleWindowRef: parsePublicRefV1(
      input.saleWindowRef,
      `${path}.saleWindowRef`,
    ),
    expiresAt: utcInstant(input.expiresAt, `${path}.expiresAt`),
    items,
    totals,
  }
}

export function parseOnsaleInventorySnapshotV1(
  value: unknown,
): OnsaleInventorySnapshotV1 {
  const root = record(value, "$", [
    "schema",
    "revision",
    "serverTime",
    "inventoryState",
    "session",
    "event",
    "seatMap",
    "currentHold",
    "capabilities",
  ])
  const sessionInput = record(root.session, "$.session", [
    "kind",
    "ownsActiveHold",
  ])
  const eventInput = record(root.event, "$.event", [
    "publicRef",
    "slug",
    "name",
    "tourName",
    "venueName",
    "cityLabel",
    "venueTimezone",
    "startsAt",
    "heroAssetRef",
    "evidenceClass",
    "currency",
    "seatingMode",
    "maximumSeatCount",
    "allInPriceRange",
    "saleWindows",
  ])
  const rangeInput = record(
    eventInput.allInPriceRange,
    "$.event.allInPriceRange",
    ["minimumMinor", "maximumMinor"],
  )
  const saleWindows = array(eventInput.saleWindows, "$.event.saleWindows").map(
    (window, index) =>
      parseSaleWindowV1(window, `$.event.saleWindows[${index}]`),
  )
  if (saleWindows.length < 1)
    return fail("$.event.saleWindows", "expected a sale window")
  if (
    new Set(saleWindows.map((window) => window.publicRef)).size !==
    saleWindows.length
  ) {
    return fail(
      "$.event.saleWindows",
      "sale-window references must be distinct",
    )
  }

  const seatMapInput = record(root.seatMap, "$.seatMap", [
    "sectionLabel",
    "rowCount",
    "seatsPerRow",
    "rows",
  ])
  const sectionLabel = text(
    seatMapInput.sectionLabel,
    "$.seatMap.sectionLabel",
    120,
  )
  const rowInputs = array(seatMapInput.rows, "$.seatMap.rows")
  if (rowInputs.length !== 6)
    return fail("$.seatMap.rows", "expected exactly six rows")
  const expectedLabels = ["A", "B", "C", "D", "E", "F"] as const
  const rows = rowInputs.map((rowValue, rowIndex) => {
    const path = `$.seatMap.rows[${rowIndex}]`
    const rowInput = record(rowValue, path, ["label", "ordinal", "seats"])
    const label = text(rowInput.label, `${path}.label`, 32)
    const ordinal = integer(rowInput.ordinal, `${path}.ordinal`, 1, 6)
    if (label !== expectedLabels[rowIndex] || ordinal !== rowIndex + 1) {
      return fail(path, "row label/ordinal must follow A through F")
    }
    const seatInputs = array(rowInput.seats, `${path}.seats`)
    if (seatInputs.length !== 10)
      return fail(`${path}.seats`, "expected ten seats")
    const seats = seatInputs.map((seatValue, seatIndex) => {
      const seat = parseSeatV1(seatValue, `${path}.seats[${seatIndex}]`)
      if (
        seat.sectionLabel !== sectionLabel ||
        seat.rowLabel !== label ||
        seat.rowOrdinal !== ordinal ||
        seat.seatOrdinal !== seatIndex + 1 ||
        seat.seatLabel !== String(seatIndex + 1)
      ) {
        return fail(
          `${path}.seats[${seatIndex}]`,
          "seat display position is incoherent",
        )
      }
      return seat
    })
    return { label, ordinal, seats }
  })
  const seats = rows.flatMap((row) => row.seats)
  if (new Set(seats.map((seat) => seat.publicRef)).size !== 60) {
    return fail("$.seatMap.rows", "expected sixty unique seat references")
  }

  const capabilitiesInput = record(root.capabilities, "$.capabilities", [
    "quote",
    "claim",
    "release",
    "reconcileExpiry",
    "checkout",
  ])
  const currentHold =
    root.currentHold === null
      ? null
      : parseHoldV1(root.currentHold, "$.currentHold")
  const parsed: OnsaleInventorySnapshotV1 = {
    schema: literal(root.schema, ["onsale.inventory.v1"], "$.schema"),
    revision: parseSha256RevisionV1(root.revision, "$.revision"),
    serverTime: utcInstant(root.serverTime, "$.serverTime"),
    inventoryState: literal(
      root.inventoryState,
      ["ready", "held", "expiry_check_required"],
      "$.inventoryState",
    ),
    session: {
      kind: literal(sessionInput.kind, ["anonymous_browser"], "$.session.kind"),
      ownsActiveHold: bool(
        sessionInput.ownsActiveHold,
        "$.session.ownsActiveHold",
      ),
    },
    event: {
      publicRef: parsePublicRefV1(eventInput.publicRef, "$.event.publicRef"),
      slug: text(eventInput.slug, "$.event.slug", 120),
      name: text(eventInput.name, "$.event.name", 240),
      tourName: text(eventInput.tourName, "$.event.tourName", 240),
      venueName: text(eventInput.venueName, "$.event.venueName", 240),
      cityLabel: text(eventInput.cityLabel, "$.event.cityLabel", 120),
      venueTimezone: text(
        eventInput.venueTimezone,
        "$.event.venueTimezone",
        120,
      ),
      startsAt: utcInstant(eventInput.startsAt, "$.event.startsAt"),
      heroAssetRef: text(eventInput.heroAssetRef, "$.event.heroAssetRef", 240),
      evidenceClass: literal(
        eventInput.evidenceClass,
        ["simulation"],
        "$.event.evidenceClass",
      ),
      currency: literal(eventInput.currency, ["USD"], "$.event.currency"),
      seatingMode: literal(
        eventInput.seatingMode,
        ["assigned"],
        "$.event.seatingMode",
      ),
      maximumSeatCount: integer(
        eventInput.maximumSeatCount,
        "$.event.maximumSeatCount",
        4,
        4,
      ) as 4,
      allInPriceRange: {
        minimumMinor: integer(
          rangeInput.minimumMinor,
          "$.event.allInPriceRange.minimumMinor",
        ),
        maximumMinor: integer(
          rangeInput.maximumMinor,
          "$.event.allInPriceRange.maximumMinor",
        ),
      },
      saleWindows,
    },
    seatMap: {
      sectionLabel,
      rowCount: integer(seatMapInput.rowCount, "$.seatMap.rowCount", 6, 6) as 6,
      seatsPerRow: integer(
        seatMapInput.seatsPerRow,
        "$.seatMap.seatsPerRow",
        10,
        10,
      ) as 10,
      rows,
    },
    currentHold,
    capabilities: {
      quote: bool(capabilitiesInput.quote, "$.capabilities.quote"),
      claim: bool(capabilitiesInput.claim, "$.capabilities.claim"),
      release: bool(capabilitiesInput.release, "$.capabilities.release"),
      reconcileExpiry: bool(
        capabilitiesInput.reconcileExpiry,
        "$.capabilities.reconcileExpiry",
      ),
      checkout:
        capabilitiesInput.checkout === false
          ? false
          : fail("$.capabilities.checkout", "expected false"),
    },
  }

  const sellableTotals = seats
    .filter((seat) => seat.lifecycle === "sellable")
    .map((seat) => seat.price.totalMinor)
  if (sellableTotals.length === 0) return fail("$.seatMap", "no sellable seats")
  const minimumMinor = Math.min(...sellableTotals)
  const maximumMinor = Math.max(...sellableTotals)
  if (
    parsed.event.allInPriceRange.minimumMinor !== minimumMinor ||
    parsed.event.allInPriceRange.maximumMinor !== maximumMinor
  ) {
    return fail(
      "$.event.allInPriceRange",
      "range does not match sellable seats",
    )
  }

  if (currentHold === null) {
    if (parsed.inventoryState !== "ready" || parsed.session.ownsActiveHold) {
      return fail("$", "empty hold contradicts ownership/inventory state")
    }
  } else {
    const saleWindowRefs = new Set(
      saleWindows.map((window) => window.publicRef),
    )
    if (!saleWindowRefs.has(currentHold.saleWindowRef)) {
      return fail(
        "$.currentHold.saleWindowRef",
        "hold window is not in the event",
      )
    }
    const seatsByRef = new Map(seats.map((seat) => [seat.publicRef, seat]))
    for (const item of currentHold.items) {
      const seat = seatsByRef.get(item.seatRef)
      if (!seat)
        return fail("$.currentHold.items", "hold references an unknown seat")
      if (
        seat.sectionLabel !== item.sectionLabel ||
        seat.rowLabel !== item.rowLabel ||
        seat.seatLabel !== item.seatLabel ||
        seat.priceTier !== item.priceTier
      ) {
        return fail(
          "$.currentHold.items",
          "hold display facts contradict seat facts",
        )
      }
      if (
        currentHold.state === "active" &&
        seat.availability !== "held_by_session"
      ) {
        return fail(
          "$.currentHold.items",
          "active hold seat is not session-owned",
        )
      }
    }
    if (
      currentHold.state === "active" &&
      (parsed.inventoryState !== "held" || !parsed.session.ownsActiveHold)
    ) {
      return fail("$", "active hold contradicts ownership/inventory state")
    }
    if (
      currentHold.state === "expired_pending_reconcile" &&
      (parsed.inventoryState !== "expiry_check_required" ||
        parsed.session.ownsActiveHold)
    ) {
      return fail("$", "expired hold contradicts ownership/inventory state")
    }
  }
  return parsed
}

export function parseQuoteSeatsRequestV1(value: unknown): QuoteSeatsRequestV1 {
  const input = record(value, "$", ["requestId", "saleWindowRef", "seatRefs"])
  return {
    requestId: parseRequestIdV1(input.requestId, "$.requestId"),
    saleWindowRef: parsePublicRefV1(input.saleWindowRef, "$.saleWindowRef"),
    seatRefs: canonicalSeatRefsV1(array(input.seatRefs, "$.seatRefs")),
  }
}

export function parseClaimSeatsRequestV1(value: unknown): ClaimSeatsRequestV1 {
  const input = record(value, "$", [
    "commandId",
    "saleWindowRef",
    "seatRefs",
    "quoteRevision",
  ])
  return {
    commandId: parseCommandIdV1(input.commandId, "$.commandId"),
    saleWindowRef: parsePublicRefV1(input.saleWindowRef, "$.saleWindowRef"),
    seatRefs: canonicalSeatRefsV1(array(input.seatRefs, "$.seatRefs")),
    quoteRevision: parseSha256RevisionV1(
      input.quoteRevision,
      "$.quoteRevision",
    ),
  }
}

export function parseHoldSelectorCommandV1(
  value: unknown,
): HoldSelectorCommandV1 {
  const input = record(value, "$", ["commandId"])
  return { commandId: parseCommandIdV1(input.commandId, "$.commandId") }
}

function parseItemsMatchingSeatRefs(
  input: unknown,
  path: string,
  seatRefs: SeatRefs,
): readonly PublicHoldItemV1[] {
  const items = array(input, path).map((item, index) =>
    parseHoldItemV1(item, `${path}[${index}]`),
  )
  if (items.length !== seatRefs.length)
    return fail(path, "items must match seat references")
  const itemRefs = items.map((item) => item.seatRef).sort()
  if (canonicalJsonV1(itemRefs) !== canonicalJsonV1([...seatRefs])) {
    return fail(path, "item seat references must match the selected set")
  }
  return items
}

export function parseQuoteSeatsResponseV1(
  value: unknown,
): QuoteSeatsResponseV1 {
  const input = record(value, "$", [
    "ok",
    "requestId",
    "basisRevision",
    "quoteRevision",
    "saleWindowRef",
    "seatRefs",
    "items",
    "totals",
  ])
  if (input.ok !== true) return fail("$.ok", "expected true")
  const seatRefs = canonicalSeatRefsV1(array(input.seatRefs, "$.seatRefs"))
  const items = parseItemsMatchingSeatRefs(input.items, "$.items", seatRefs)
  const totals = parseMoneyBreakdownV1(input.totals, "$.totals")
  let itemTotals: MoneyBreakdownV1
  try {
    itemTotals = sumMoneyBreakdownsV1(items.map((item) => item.price))
  } catch {
    return fail("$.totals", "quote item totals exceed the safe money range")
  }
  if (canonicalJsonV1(totals) !== canonicalJsonV1(itemTotals)) {
    return fail("$.totals", "quote totals do not match items")
  }
  return {
    ok: true,
    requestId: parseRequestIdV1(input.requestId, "$.requestId"),
    basisRevision: parseSha256RevisionV1(
      input.basisRevision,
      "$.basisRevision",
    ),
    quoteRevision: parseSha256RevisionV1(
      input.quoteRevision,
      "$.quoteRevision",
    ),
    saleWindowRef: parsePublicRefV1(input.saleWindowRef, "$.saleWindowRef"),
    seatRefs,
    items,
    totals,
  }
}

function parseHoldCommandResultV1(
  value: unknown,
  path: string,
): HoldCommandResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "expected a command result")
  }
  const kind = (value as PlainRecord).kind
  if (kind === "hold_not_yet_expired") {
    const input = record(value, path, ["kind", "holdRef"])
    return {
      kind,
      holdRef: parsePublicRefV1(input.holdRef, `${path}.holdRef`),
    }
  }
  if (kind === "hold_expired") {
    const input = record(value, path, ["kind", "holdRef", "seatRefs"])
    const rawRefs = array(input.seatRefs, `${path}.seatRefs`)
    const refs = rawRefs.map((ref, index) =>
      parsePublicRefV1(ref, `${path}.seatRefs[${index}]`),
    )
    if (new Set(refs).size !== refs.length)
      return fail(`${path}.seatRefs`, "duplicates")
    return {
      kind,
      holdRef: parsePublicRefV1(input.holdRef, `${path}.holdRef`),
      seatRefs: refs,
    }
  }
  if (kind === "hold_claimed" || kind === "hold_released") {
    const input = record(value, path, ["kind", "holdRef", "seatRefs"])
    return {
      kind,
      holdRef: parsePublicRefV1(input.holdRef, `${path}.holdRef`),
      seatRefs: canonicalSeatRefsV1(array(input.seatRefs, `${path}.seatRefs`)),
    }
  }
  return fail(`${path}.kind`, "unknown command result")
}

export function parseHoldCommandSuccessV1(
  value: unknown,
): HoldCommandSuccessV1 {
  const input = record(value, "$", ["ok", "command", "snapshot"])
  if (input.ok !== true) return fail("$.ok", "expected true")
  const command = record(input.command, "$.command", [
    "commandId",
    "replayed",
    "result",
  ])
  return {
    ok: true,
    command: {
      commandId: parseCommandIdV1(command.commandId, "$.command.commandId"),
      replayed: bool(command.replayed, "$.command.replayed"),
      result: parseHoldCommandResultV1(command.result, "$.command.result"),
    },
    snapshot: parseOnsaleInventorySnapshotV1(input.snapshot),
  }
}

const PUBLIC_ERROR_CODES: readonly PublicInventoryErrorCodeV1[] = [
  "INVALID_REQUEST",
  "REQUEST_ORIGIN_DENIED",
  "INVENTORY_INTEGRITY_ERROR",
  "SALE_WINDOW_NOT_OPEN",
  "ACCESS_REQUIRED",
  "SEAT_NOT_AVAILABLE",
  "QUOTE_STALE",
  "ACTIVE_HOLD_EXISTS",
  "HOLD_NOT_FOUND",
  "HOLD_NOT_ACTIVE",
  "IDEMPOTENCY_CONFLICT",
  "INVENTORY_TEMPORARILY_UNAVAILABLE",
]

export function parseInventoryFailureV1(value: unknown): InventoryFailureV1 {
  const input = record(value, "$", ["ok", "error"], ["commandId", "snapshot"])
  if (input.ok !== false) return fail("$.ok", "expected false")
  const errorInput = record(
    input.error,
    "$.error",
    ["code", "message", "retryable"],
    ["seatRefs"],
  )
  const code = literal(errorInput.code, PUBLIC_ERROR_CODES, "$.error.code")
  const seatRefs =
    errorInput.seatRefs === undefined
      ? undefined
      : array(errorInput.seatRefs, "$.error.seatRefs").map((ref, index) =>
          parsePublicRefV1(ref, `$.error.seatRefs[${index}]`),
        )
  if (seatRefs && new Set(seatRefs).size !== seatRefs.length) {
    return fail("$.error.seatRefs", "seat references must be distinct")
  }
  return {
    ok: false,
    ...(input.commandId === undefined
      ? {}
      : { commandId: parseCommandIdV1(input.commandId, "$.commandId") }),
    error: {
      code,
      message: text(errorInput.message, "$.error.message", 240),
      retryable: bool(errorInput.retryable, "$.error.retryable"),
      ...(seatRefs === undefined ? {} : { seatRefs }),
    },
    ...(input.snapshot === undefined
      ? {}
      : { snapshot: parseOnsaleInventorySnapshotV1(input.snapshot) }),
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON rejects unsupported values")
  }
  if (ancestors.has(value))
    throw new TypeError("Canonical JSON rejects cyclic values")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const values: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Canonical JSON rejects sparse arrays")
        }
        values.push(canonicalize(value[index], ancestors))
      }
      return `[${values.join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts plain objects only")
    }
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort(compareCanonicalStringsV1)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(object[key], ancestors)}`,
      )
      .join(",")}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJsonV1(value: unknown): string {
  return canonicalize(value, new Set())
}

export function canonicalJsonUtf8V1(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonV1(value))
}
