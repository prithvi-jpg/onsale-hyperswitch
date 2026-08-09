import { createHash, randomBytes } from "node:crypto"

import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless"

import type { Sha256RevisionV1 } from "../domain/onsale-public-contract"
import {
  quoteInventoryAppSchema,
  type InventoryAppSchema,
} from "./inventory-app-schema"
import { quoteEphemeralSchema } from "./inventory-neon-schema"
import { createQuoteRevisionV1 } from "./onsale-canonical-hash"

const OPERATION_SCOPE = "onsale-inventory-v1"
const MAX_SEATS_PER_HOLD = 4
export const MAX_SAFE_MONEY_MINOR = 9_000_000_000_000
export const MIN_HOLD_DURATION_MS = 250
export const MAX_HOLD_DURATION_MS = 15 * 60 * 1_000

export const ONSALE_FIGMA_SEED_V1 = {
  eventName: "PHANTOM CIRCUIT",
  tourName: "Liminal Frequencies Tour 2026",
  venueName: "Terminal 5",
  venueTimezone: "America/New_York",
  cityLabel: "New York, NY",
  startsAt: "2026-08-10T00:00:00.000Z",
  seatingMode: "assigned",
  sectionName: "SECTION A",
  heroAssetRef:
    "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1400&h=560&fit=crop&auto=format&q=80",
  allInPriceRangeMinor: {
    minimum: 18_460,
    maximum: 22_000,
  },
} as const

interface NeonInventoryRepositoryBaseOptions {
  readonly databaseUrl: string
  readonly pool?: Pool
}

export interface NeonInventoryEphemeralRepositoryOptions
  extends NeonInventoryRepositoryBaseOptions {
  readonly schema: string
  readonly appSchema?: never
}

export interface NeonInventoryAppRepositoryOptions
  extends NeonInventoryRepositoryBaseOptions {
  readonly schema?: never
  readonly appSchema: InventoryAppSchema
}

export type NeonInventoryRepositoryOptions = NeonInventoryEphemeralRepositoryOptions | NeonInventoryAppRepositoryOptions

export interface MoneySnapshot {
  readonly currency: string
  readonly subtotalMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
}

export interface SeedRow {
  readonly id: string
  readonly label: string
  readonly seatIds: readonly string[]
}

export interface SeededInventory {
  readonly replayed: boolean
  readonly generation: number
  readonly datasetId: string
  readonly eventId: string
  readonly saleWindowId: string
  readonly presaleWindowId: string
  readonly priceTierIds: {
    readonly standard: string
    readonly premium: string
  }
  readonly rows: readonly SeedRow[]
  readonly adjacentSeatIds: readonly string[]
}

export interface ClaimSeatsInput {
  readonly operationKey: string
  readonly eventId: string
  readonly saleWindowId: string
  readonly accessGrantId?: string
  readonly buyerRef: string
  readonly seatIds: readonly string[]
  readonly holdForMs: number
}

export interface QuoteSeatsInput {
  readonly eventId: string
  readonly saleWindowId: string
  readonly accessGrantId?: string
  readonly buyerRef: string
  readonly seatIds: readonly string[]
}

export interface QuoteSeatSnapshot {
  readonly seatId: string
  readonly sectionName: string
  readonly rowLabel: string
  readonly seatLabel: string
  readonly priceTierName: string
  readonly price: MoneySnapshot
}

export interface QuoteSeatsResult {
  readonly quoteRevision: Sha256RevisionV1
  readonly eventId: string
  readonly saleWindowId: string
  readonly seatIds: readonly string[]
  readonly items: readonly QuoteSeatSnapshot[]
  readonly totals: MoneySnapshot
}

export interface ClaimQuotedSeatsInput extends ClaimSeatsInput {
  readonly quoteRevision: Sha256RevisionV1
}

export interface ClaimSeatsResult {
  readonly replayed: boolean
  readonly holdId: string
  readonly eventId: string
  readonly seatIds: readonly string[]
  readonly expiresAt: string
  readonly totals: MoneySnapshot
}

export interface ReleaseHoldInput {
  readonly operationKey: string
  readonly holdId: string
  readonly buyerRef: string
}

export interface ReleaseHoldResult {
  readonly replayed: boolean
  readonly terminalReplay: boolean
  readonly holdId: string
  readonly state: "released"
  readonly releasedSeatIds: readonly string[]
}

export interface ExpireHoldInput {
  readonly operationKey: string
  readonly holdId: string
  readonly buyerRef: string
}

export interface ExpireHoldResult {
  readonly replayed: boolean
  readonly holdId: string
  readonly state: "active" | "expired" | "released" | "converted"
  readonly releasedSeatIds: readonly string[]
}

export interface CreateOrderInput {
  readonly operationKey: string
  readonly holdId: string
  readonly buyerRef: string
}

export interface OrderItemSnapshot {
  readonly id: string
  readonly seatId: string
  readonly sectionName: string
  readonly rowLabel: string
  readonly seatLabel: string
  readonly priceTierName: string
  readonly faceValueMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
  readonly currency: string
}

export interface CreateOrderResult {
  readonly replayed: boolean
  readonly orderId: string
  readonly holdId: string
  readonly eventId: string
  readonly state: "awaiting_payment"
  readonly seatIds: readonly string[]
  readonly totals: MoneySnapshot
  readonly items: readonly OrderItemSnapshot[]
}

export interface CancelOrderInput {
  readonly operationKey: string
  readonly orderId: string
  readonly buyerRef: string
}

export interface CancelOrderResult {
  readonly replayed: boolean
  readonly terminalReplay: boolean
  readonly orderId: string
  readonly holdId: string
  readonly eventId: string
  readonly state: "canceled"
  readonly releasedSeatIds: readonly string[]
}

export interface HoldSnapshot {
  readonly id: string
  readonly eventId: string
  readonly buyerRef: string
  readonly state: "active" | "released" | "expired" | "converted"
  readonly expiresAt: string
}

export interface AccessGrantSnapshot {
  readonly id: string
  readonly eventId: string
  readonly saleWindowId: string
  readonly buyerRef: string
  readonly proofKind: "local_prototype"
  readonly state: "verified" | "expired" | "revoked"
  readonly expiresAt: string
}

export interface IssueAccessGrantInput {
  readonly eventId: string
  readonly saleWindowId: string
  readonly buyerRef: string
  readonly validForMs: number
}

export interface DurableOperationSnapshot {
  readonly commandKind: string
  readonly state: "started" | "completed" | "failed"
  readonly errorCode?: string
}

export interface DurableAllocationSnapshot {
  readonly id: string
  readonly seatId: string
  readonly holdId: string
  readonly orderId?: string
  readonly state: "held" | "reserved" | "reservation_released" | "released" | "expired"
  readonly reservedAt?: string
  readonly releasedAt?: string
  readonly totals: MoneySnapshot
}

export interface DurableOrderSnapshot {
  readonly id: string
  readonly holdId: string
  readonly eventId: string
  readonly state: "awaiting_payment" | "payment_pending" | "paid" | "fulfilled" | "canceled"
  readonly totals: MoneySnapshot
  readonly items: readonly OrderItemSnapshot[]
}

/**
 * Server-private checkout facts for one buyer-owned immutable order. The
 * browser never supplies these values and the public checkout projection must
 * reconstruct a narrower DTO from them.
 */
export interface OwnedCheckoutOrderSnapshot extends DurableOrderSnapshot {
  readonly paymentDeadlineAt: string
  /** Database clock captured by the same owner-bound repeatable-read query. */
  readonly serverObservedAt: string
}

export interface PriceTierSnapshot {
  readonly id: string
  readonly currency: string
  readonly faceValueMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
}

export interface EventInspection {
  readonly activeAllocationCount: number
  readonly reservedAllocationCount: number
  readonly partialHoldCount: number
  readonly orderCount: number
  readonly activeOwnerCountBySeat: Readonly<Record<string, number>>
}

export interface DatasetGenerationInspection {
  readonly datasetId: string
  readonly generation: number
  readonly state: "preparing" | "active" | "retired"
  readonly rowCount: number
  readonly seatCount: number
  readonly rowsWithTenSeats: number
  readonly hasAdjacentFourAvailable: boolean
  readonly activeDatasetCount: number
}

export class InventoryRepositoryError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "InventoryRepositoryError"
    this.code = code
    this.details = details
  }
}

export class IdempotencyConflictError extends InventoryRepositoryError {
  constructor() {
    super(
      "IDEMPOTENCY_CONFLICT",
      "The operation key was already used for a different inventory command.",
    )
    this.name = "IdempotencyConflictError"
  }
}

export class SeatUnavailableError extends InventoryRepositoryError {
  readonly seatIds: readonly string[]

  constructor(seatIds: readonly string[]) {
    super(
      "SEAT_NOT_AVAILABLE",
      `The requested seat set is unavailable: ${seatIds.join(", ")}.`,
      { seatIds },
    )
    this.name = "SeatUnavailableError"
    this.seatIds = seatIds
  }
}

export class QuoteStaleError extends InventoryRepositoryError {
  constructor() {
    super(
      "QUOTE_STALE",
      "The server price or sale facts changed after this quote was issued.",
    )
    this.name = "QuoteStaleError"
  }
}

export class ActiveHoldExistsError extends InventoryRepositoryError {
  constructor() {
    super(
      "ACTIVE_HOLD_EXISTS",
      "This buyer already has a current hold for the event.",
    )
    this.name = "ActiveHoldExistsError"
  }
}

export class HoldNotActiveError extends InventoryRepositoryError {
  constructor(state: string) {
    super("HOLD_NOT_ACTIVE", `The hold is ${state}, not active.`, { state })
    this.name = "HoldNotActiveError"
  }
}

export class SaleWindowDeniedError extends InventoryRepositoryError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = "SaleWindowDeniedError"
  }
}

export class AccessGrantDeniedError extends InventoryRepositoryError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = "AccessGrantDeniedError"
  }
}

export class MoneyInvariantError extends InventoryRepositoryError {
  constructor(message: string) {
    super("MONEY_INVARIANT", message)
    this.name = "MoneyInvariantError"
  }
}

export class OrderAlreadyExistsError extends InventoryRepositoryError {
  constructor() {
    super("ORDER_ALREADY_EXISTS", "The hold already belongs to an order.")
    this.name = "OrderAlreadyExistsError"
  }
}

export class OrderCancellationBlockedError extends InventoryRepositoryError {
  constructor(state: string) {
    super(
      "ORDER_CANCELLATION_BLOCKED",
      `The order cannot release inventory from state ${state}.`,
      { state },
    )
    this.name = "OrderCancellationBlockedError"
  }
}

export class SeedInvariantError extends InventoryRepositoryError {
  constructor(message: string) {
    super("SEED_INVARIANT", message)
    this.name = "SeedInvariantError"
  }
}

interface OperationReservation<T> {
  readonly id: string
  readonly replay?: T
  readonly failure?: StoredBusinessFailure
}

interface StoredBusinessFailure {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

interface CommandWorkResult<T extends object> {
  readonly result: T
  readonly targets?: OperationTargets
}

interface CommittedCommandFailure {
  readonly committedFailure: InventoryRepositoryError
}

type CommandWorkOutcome<T extends object,> = CommandWorkResult<T> | CommittedCommandFailure

interface OperationTargets {
  readonly holdId?: string
  readonly orderId?: string
}

interface SuccessfulCommand<T> {
  readonly ok: true
  readonly value: T
}

interface FailedCommand {
  readonly ok: false
  readonly failure: StoredBusinessFailure
}

type CommandOutcome<T> = SuccessfulCommand<T> | FailedCommand

interface TransactionTimings {
  readonly statementTimeoutMs?: number
  readonly lockTimeoutMs?: number
}

interface HoldRow extends QueryResultRow {
  id: string
  dataset_id: string
  event_id: string
  sale_window_id: string
  buyer_ref: string
  state: HoldSnapshot["state"]
  expires_at: Date | string
}

interface OrderRow extends QueryResultRow {
  id: string
  dataset_id: string
  event_id: string
  hold_id: string
  buyer_ref: string
  state: DurableOrderSnapshot["state"]
  canceled_at: Date | string | null
}

interface AccessGrantRow extends QueryResultRow {
  id: string
  event_id: string
  sale_window_id: string
  buyer_ref: string
  proof_kind: "local_prototype"
  state: AccessGrantSnapshot["state"]
  expires_at: Date | string
}

interface AllocationRow extends QueryResultRow {
  id: string
  dataset_id: string
  event_id: string
  seat_id: string
  hold_id: string
  order_id: string | null
  state: DurableAllocationSnapshot["state"]
  price_tier_name: string
  face_value_minor: string | number
  fee_minor: string | number
  tax_minor: string | number
  total_minor: string | number
  currency: string
  reserved_at?: Date | string | null
  released_at?: Date | string | null
}

interface SeatPriceRow extends QueryResultRow {
  id: string
  dataset_id: string
  event_id: string
  section_id: string
  row_id: string
  label: string
  lifecycle_state: "sellable" | "blocked" | "removed"
  price_tier_id: string
  price_tier_name: string
  face_value_minor: string | number
  fee_minor: string | number
  tax_minor: string | number
  total_minor: string | number
  currency: string
  section_name: string
  row_label: string
  section_ordinal: number
  row_ordinal: number
  seat_ordinal: number
  price_effective: boolean
}

interface LockedSaleWindowRow extends QueryResultRow {
  dataset_id: string
  currency: string
  sale_window_id: string
  kind: "general" | "presale"
  access_policy_kind: "prototype_open" | "local_prototype_cardmember"
  seat_limit: number
  is_open: boolean
}

interface LockedSaleWindow extends LockedSaleWindowRow {
  access_state: "not_required" | "verified_local_prototype"
}

interface OperationRow extends QueryResultRow {
  id: string
  command_kind: string
  request_hash: string
  state: "started" | "completed" | "failed"
  result: unknown
  error_code: string | null
}

function assertCommandText(value: string, label: string): void {
  if (!value || value.length > 200 || /[\u0000-\u001f]/u.test(value)) {
    throw new InventoryRepositoryError(
      "INVALID_COMMAND",
      `${label} must be a non-empty bounded string.`,
    )
  }
}

function assertCommandUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new InventoryRepositoryError(
      "INVALID_COMMAND",
      `${label} must be a UUID.`,
    )
  }
}

function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "Database integer exceeds the JavaScript safe-integer range.",
    )
  }
  return parsed
}

function assertMoneyComponent(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_MONEY_MINOR
  ) {
    throw new MoneyInvariantError(
      `${label} must be a non-negative safe integer at or below ${MAX_SAFE_MONEY_MINOR}.`,
    )
  }
}

function checkedMoneySum(values: readonly number[], label: string): number {
  let total = 0
  for (const value of values) {
    assertMoneyComponent(value, label)
    if (total > MAX_SAFE_MONEY_MINOR - value) {
      throw new MoneyInvariantError(
        `${label} exceeds the safe minor-unit ceiling ${MAX_SAFE_MONEY_MINOR}.`,
      )
    }
    total += value
  }
  return total
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function deterministicUuid(key: string): string {
  const chars = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .split("")
  chars[12] = "7"
  chars[16] = (8 + (Number.parseInt(chars[16], 16) % 4)).toString(16)
  const value = chars.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function uuidV7(): string {
  const timestamp = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12)
  const chars = `${timestamp}${randomBytes(10).toString("hex")}`.split("")
  chars[12] = "7"
  chars[16] = (8 + (Number.parseInt(chars[16], 16) % 4)).toString(16)
  const value = chars.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function sumMoney(rows: readonly AllocationRow[]): MoneySnapshot {
  if (rows.length === 0) {
    throw new InventoryRepositoryError(
      "INVALID_HOLD",
      "A hold has no allocations.",
    )
  }
  const currencies = new Set(rows.map((row) => row.currency))
  if (currencies.size !== 1) {
    throw new InventoryRepositoryError(
      "PRICE_INVARIANT",
      "All hold allocations must use one currency.",
    )
  }
  const subtotalMinor = checkedMoneySum(
    rows.map((row) => integer(row.face_value_minor)),
    "Order subtotal",
  )
  const feeMinor = checkedMoneySum(
    rows.map((row) => integer(row.fee_minor)),
    "Order fees",
  )
  const taxMinor = checkedMoneySum(
    rows.map((row) => integer(row.tax_minor)),
    "Order tax",
  )
  const totalMinor = checkedMoneySum(
    rows.map((row) => integer(row.total_minor)),
    "Order total",
  )
  if (
    checkedMoneySum([subtotalMinor, feeMinor, taxMinor], "Order header") !==
    totalMinor
  ) {
    throw new MoneyInvariantError(
      "Order header components do not equal the item total.",
    )
  }
  return {
    currency: rows[0].currency,
    subtotalMinor,
    feeMinor,
    taxMinor,
    totalMinor,
  }
}

function storeBusinessFailure(
  error: InventoryRepositoryError,
): StoredBusinessFailure {
  return {
    code: error.code,
    message: error.message,
    details: error.details,
  }
}

function restoreBusinessFailure(
  failure: StoredBusinessFailure,
): InventoryRepositoryError {
  switch (failure.code) {
    case "SEAT_NOT_AVAILABLE":
      return new SeatUnavailableError(
        Array.isArray(failure.details.seatIds)
          ? failure.details.seatIds.filter(
              (seatId): seatId is string => typeof seatId === "string",
            )
          : [],
      )
    case "QUOTE_STALE":
      return new QuoteStaleError()
    case "ACTIVE_HOLD_EXISTS":
      return new ActiveHoldExistsError()
    case "HOLD_NOT_ACTIVE":
      return new HoldNotActiveError(
        typeof failure.details.state === "string"
          ? failure.details.state
          : "not_active",
      )
    case "ORDER_ALREADY_EXISTS":
      return new OrderAlreadyExistsError()
    case "ORDER_CANCELLATION_BLOCKED":
      return new OrderCancellationBlockedError(
        typeof failure.details.state === "string"
          ? failure.details.state
          : "unknown",
      )
    case "MONEY_INVARIANT":
      return new MoneyInvariantError(failure.message)
    case "SEED_INVARIANT":
      return new SeedInvariantError(failure.message)
    case "SALE_WINDOW_NOT_FOUND":
    case "SALE_WINDOW_NOT_OPEN":
    case "SALE_WINDOW_POLICY_DENIED":
      return new SaleWindowDeniedError(failure.code, failure.message)
    case "ACCESS_GRANT_REQUIRED":
    case "ACCESS_GRANT_DENIED":
    case "ACCESS_GRANT_EXPIRED":
      return new AccessGrantDeniedError(failure.code, failure.message)
    default:
      return new InventoryRepositoryError(
        failure.code,
        failure.message,
        failure.details,
      )
  }
}

export class NeonInventoryRepository {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly rawSchema: string
  private readonly quotedSchema: string

  constructor(options: NeonInventoryRepositoryOptions) {
    if (!options.databaseUrl || !options.databaseUrl.startsWith("postgres")) {
      throw new Error("A private Postgres DATABASE_URL is required.")
    }
    const hasEphemeralSchema = typeof options.schema === "string"
    const hasAppSchema = typeof options.appSchema === "string"
    if (hasEphemeralSchema === hasAppSchema) {
      throw new Error(
        "Exactly one validated inventory namespace must be supplied.",
      )
    }
    if (hasEphemeralSchema) {
      this.quotedSchema = quoteEphemeralSchema(options.schema)
      this.rawSchema = options.schema
    } else {
      this.quotedSchema = quoteInventoryAppSchema(options.appSchema)
      this.rawSchema = options.appSchema
    }
    this.ownsPool = options.pool === undefined
    this.pool =
      options.pool ??
      new Pool({
        connectionString: options.databaseUrl,
        max: 8,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 5_000,
      })
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  private table(name: string): string {
    if (!/^[a-z_]+$/u.test(name)) throw new Error("Unsafe table identifier.")
    return `${this.quotedSchema}."${name}"`
  }

  private async transaction<T,>(
    work: (client: PoolClient) => Promise<T>,
    timings: TransactionTimings = {},
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("begin")
      await client.query("select set_config('statement_timeout', $1, true)", [
        `${timings.statementTimeoutMs ?? 15_000}ms`,
      ])
      await client.query("select set_config('lock_timeout', $1, true)", [
        `${timings.lockTimeoutMs ?? 5_000}ms`,
      ])
      const result = await work(client)
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async lockEvent(client: PoolClient, eventId: string): Promise<void> {
    // V1 serializes inventory mutations per event, then locks concrete seats in
    // stable UUID order. This is correctness-first and intentionally bounded.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 71801))",
      [eventId],
    )
  }

  private async lockDatasetRotation(client: PoolClient): Promise<void> {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 71802))",
      [`${this.rawSchema}:prototype-dataset-rotation:v1`],
    )
  }

  private async lockSeats(
    client: PoolClient,
    eventId: string,
    seatIds: readonly string[],
  ): Promise<SeatPriceRow[]> {
    const result = await client.query<SeatPriceRow>(
      `select
         s.id,
         s.dataset_id,
         s.event_id,
         s.section_id,
         s.row_id,
         s.label,
         s.lifecycle_state,
         s.price_tier_id,
         pt.name as price_tier_name,
         pt.face_value_minor,
         pt.fee_minor,
         pt.tax_minor,
         pt.all_in_minor as total_minor,
         pt.currency,
         sec.name as section_name,
         sr.label as row_label,
         sec.ordinal as section_ordinal,
         sr.ordinal as row_ordinal,
         s.ordinal as seat_ordinal,
         pt.effective_from <= statement_timestamp()
           and (pt.effective_until is null or pt.effective_until > statement_timestamp())
           as price_effective
       from ${this.table("seat")} s
       join ${this.table("price_tier")} pt on pt.id = s.price_tier_id
       join ${this.table("section")} sec on sec.id = s.section_id
       join ${this.table("seat_row")} sr on sr.id = s.row_id
       where s.event_id = $1 and s.id = any($2::uuid[])
       order by s.id
       for update of s`,
      [eventId, seatIds],
    )
    return result.rows
  }

  private async beginOperation<T,>(
    client: PoolClient,
    input: {
      readonly operationKey: string
      readonly commandKind: string
      readonly requestHash: string
    },
  ): Promise<OperationReservation<T>> {
    assertCommandText(input.operationKey, "operationKey")
    const id = uuidV7()
    await client.query(
      `insert into ${this.table("idempotency_operation")} (
         id, scope, operation_key, command_kind, request_hash, state
       ) values ($1, $2, $3, $4, $5, 'started')
       on conflict (scope, operation_key) do nothing`,
      [
        id,
        OPERATION_SCOPE,
        input.operationKey,
        input.commandKind,
        input.requestHash,
      ],
    )
    const existing = await client.query<OperationRow>(
      `select id, command_kind, request_hash, state, result, error_code
       from ${this.table("idempotency_operation")}
       where scope = $1 and operation_key = $2
       for update`,
      [OPERATION_SCOPE, input.operationKey],
    )
    const row = existing.rows[0]
    if (!row) throw new Error("Unable to reserve the idempotency operation.")
    if (
      row.command_kind !== input.commandKind ||
      row.request_hash !== input.requestHash
    ) {
      throw new IdempotencyConflictError()
    }
    if (row.state === "completed") {
      return { id: row.id, replay: { ...row.result as T, replayed: true } }
    }
    if (row.state === "failed") {
      const failure = row.result as Partial<StoredBusinessFailure>
      if (
        typeof failure.code !== "string" ||
        typeof failure.message !== "string" ||
        typeof failure.details !== "object" ||
        failure.details === null ||
        row.error_code !== failure.code
      ) {
        throw new Error("Recorded business failure is malformed.")
      }
      return {
        id: row.id,
        failure: failure as StoredBusinessFailure,
      }
    }
    return { id: row.id }
  }

  private async seatIdsInDisplayOrder(
    client: PoolClient,
    holdId: string,
  ): Promise<string[]> {
    const result = await client.query<{ seat_id: string }>(
      `select a.seat_id
       from ${this.table("seat_allocation")} a
       join ${this.table("seat")} s on s.id = a.seat_id
       join ${this.table("seat_row")} sr on sr.id = s.row_id
       join ${this.table("section")} sec on sec.id = s.section_id
       where a.hold_id = $1
       order by sec.ordinal, sr.ordinal, s.ordinal`,
      [holdId],
    )
    return result.rows.map((row) => row.seat_id)
  }

  private async completeOperation<T extends object,>(
    client: PoolClient,
    id: string,
    result: T,
    targets: {
      readonly holdId?: string
      readonly orderId?: string
    } = {},
  ): Promise<void> {
    await client.query(
      `update ${this.table("idempotency_operation")}
       set state = 'completed',
           target_hold_id = $2,
           target_order_id = $3,
           result = $4::jsonb,
           completed_at = clock_timestamp()
       where id = $1`,
      [
        id,
        targets.holdId ?? null,
        targets.orderId ?? null,
        JSON.stringify(result),
      ],
    )
  }

  private async failOperation(
    client: PoolClient,
    id: string,
    failure: StoredBusinessFailure,
  ): Promise<void> {
    await client.query(
      `update ${this.table("idempotency_operation")}
       set state = 'failed',
           result = $2::jsonb,
           error_code = $3,
           completed_at = clock_timestamp()
       where id = $1`,
      [id, JSON.stringify(failure), failure.code],
    )
  }

  private async executeIdempotentCommand<T extends object,>(
    input: {
      readonly operationKey: string
      readonly commandKind: string
      readonly requestHash: string
    },
    work: (client: PoolClient) => Promise<CommandWorkOutcome<T>>,
    timings: TransactionTimings = {},
  ): Promise<T> {
    const outcome = await this.transaction<CommandOutcome<T>>(
      async (client) => {
        const operation = await this.beginOperation<T>(client, input)
        if (operation.replay) return { ok: true, value: operation.replay }
        if (operation.failure) {
          return { ok: false, failure: operation.failure }
        }

        await client.query("savepoint command_work")
        try {
          const completed = await work(client)
          if ("committedFailure" in completed) {
            const failure = storeBusinessFailure(completed.committedFailure)
            await this.failOperation(client, operation.id, failure)
            await client.query("release savepoint command_work")
            return { ok: false, failure }
          }
          await this.completeOperation(
            client,
            operation.id,
            completed.result,
            completed.targets,
          )
          await client.query("release savepoint command_work")
          return { ok: true, value: completed.result }
        } catch (error) {
          if (!(error instanceof InventoryRepositoryError)) throw error
          await client.query("rollback to savepoint command_work")
          const failure = storeBusinessFailure(error)
          await this.failOperation(client, operation.id, failure)
          return { ok: false, failure }
        }
      },
      timings,
    )
    if (!outcome.ok) throw restoreBusinessFailure(outcome.failure)
    return outcome.value
  }

  async seedDeterministicInventory(input: {
    readonly seedKey: string
    readonly operationKey?: string
  }): Promise<SeededInventory> {
    const operationKey = input.operationKey ?? input.seedKey
    const identityKey = `${operationKey}:${input.seedKey}:v3`
    const datasetId = deterministicUuid(`${identityKey}:dataset`)
    const eventId = deterministicUuid(`${identityKey}:event`)
    const saleWindowId = deterministicUuid(`${identityKey}:sale-window`)
    const presaleWindowId = deterministicUuid(
      `${identityKey}:sale-window:presale`,
    )
    const sectionId = deterministicUuid(`${identityKey}:section`)
    const standardTierId = deterministicUuid(`${identityKey}:tier:standard`)
    const premiumTierId = deterministicUuid(`${identityKey}:tier:premium`)
    const rowLabels = ["A", "B", "C", "D", "E", "F"] as const
    const rows = rowLabels.map((label, rowIndex) => ({
      id: deterministicUuid(`${identityKey}:row:${label}`),
      label,
      seatIds: Array.from({ length: 10 }, (_, seatIndex) =>
        deterministicUuid(`${identityKey}:seat:${label}:${seatIndex + 1}`),
      ),
      ordinal: rowIndex + 1,
    }))
    const requestHash = canonicalHash({
      seedKey: input.seedKey,
      seedVersion: 3,
      rowLabels,
      seatsPerRow: 10,
      presentation: ONSALE_FIGMA_SEED_V1,
    })

    return this.executeIdempotentCommand(
      {
        operationKey,
        commandKind: "reset_dataset",
        requestHash,
      },
      async (client) => {
        assertCommandText(input.seedKey, "seedKey")
        await this.lockDatasetRotation(client)
        const insertedDataset = await client.query<{
          generation: string | number
        }>(
          `insert into ${this.table("prototype_dataset")} (
             id, generation, label, state, seed_version
           )
             select $1, coalesce(max(generation), 0) + 1, $2, 'preparing', 3
           from ${this.table("prototype_dataset")}
           returning generation`,
          [datasetId, `ONSALE ${input.seedKey}`],
        )
        const generation = integer(insertedDataset.rows[0].generation)
        await client.query(
          `insert into ${this.table("event")} (
             id, dataset_id, slug, name, venue_name, venue_timezone, starts_at,
             currency, seating_mode, state, display_metadata
           ) values (
             $1, $2, $3, $4, $5, $6, $7::timestamptz,
             'USD', $8, 'on_sale', $9::jsonb
           )`,
          [
            eventId,
            datasetId,
            `phantom-circuit-${operationKey}`,
            ONSALE_FIGMA_SEED_V1.eventName,
            ONSALE_FIGMA_SEED_V1.venueName,
            ONSALE_FIGMA_SEED_V1.venueTimezone,
            ONSALE_FIGMA_SEED_V1.startsAt,
            ONSALE_FIGMA_SEED_V1.seatingMode,
            JSON.stringify({
              seed: "deterministic",
              seed_version: 3,
              evidence_class: "simulation",
              tour_name: ONSALE_FIGMA_SEED_V1.tourName,
              city_label: ONSALE_FIGMA_SEED_V1.cityLabel,
              hero_asset_ref: ONSALE_FIGMA_SEED_V1.heroAssetRef,
            }),
          ],
        )
        await client.query(
          `insert into ${this.table("sale_window")} (
             id, dataset_id, event_id, kind, opens_at, closes_at,
             access_policy_kind, seat_limit, state
           ) values
           (
             $1, $2, $3, 'general', clock_timestamp() - interval '1 day',
             clock_timestamp() + interval '7 days', 'prototype_open', 4, 'open'
           ),
           (
             $4, $2, $3, 'presale', clock_timestamp() - interval '1 day',
             clock_timestamp() + interval '7 days',
             'local_prototype_cardmember', 4, 'open'
           )`,
          [saleWindowId, datasetId, eventId, presaleWindowId],
        )
        await client.query(
          `insert into ${this.table("section")} (
             id, dataset_id, event_id, name, ordinal, display_metadata
           ) values ($1, $2, $3, $4, 1, $5::jsonb)`,
          [
            sectionId,
            datasetId,
            eventId,
            ONSALE_FIGMA_SEED_V1.sectionName,
            JSON.stringify({ kind: "assigned_section" }),
          ],
        )
        await client.query(
          `insert into ${this.table("price_tier")} (
             id, dataset_id, event_id, name, face_value_minor, fee_minor,
             tax_minor, all_in_minor, currency, effective_from
           ) values
             ($1, $3, $4, 'STANDARD', 15000, 1500, 1960, 18460, 'USD', clock_timestamp() - interval '1 day'),
             ($2, $3, $4, 'PREMIUM', 18000, 1600, 2400, 22000, 'USD', clock_timestamp() - interval '1 day')`,
          [standardTierId, premiumTierId, datasetId, eventId],
        )

        for (const row of rows) {
          await client.query(
            `insert into ${this.table("seat_row")} (
               id, dataset_id, event_id, section_id, label, ordinal
             ) values ($1, $2, $3, $4, $5, $6)`,
            [row.id, datasetId, eventId, sectionId, row.label, row.ordinal],
          )
          for (let index = 0; index < row.seatIds.length; index += 1) {
            const seatNumber = index + 1
            const blocked =
              row.label === "F" && (seatNumber === 3 || seatNumber === 8)
            const tierId = row.ordinal <= 2 ? standardTierId : premiumTierId
            await client.query(
              `insert into ${this.table("seat")} (
                 id, dataset_id, event_id, section_id, row_id, label, ordinal,
                 price_tier_id, lifecycle_state
               ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                row.seatIds[index],
                datasetId,
                eventId,
                sectionId,
                row.id,
                String(seatNumber),
                seatNumber,
                tierId,
                blocked ? "blocked" : "sellable",
              ],
            )
          }
        }

        const validation = await client.query<{
          event_count: string | number
          section_count: string | number
          row_count: string | number
          rows_with_ten_seats: string | number
          seat_count: string | number
          sale_window_count: string | number
          price_tier_count: string | number
          has_adjacent_four: boolean
        }>(
          `with row_shape as (
             select
               sr.id,
               sr.ordinal,
               count(s.id) as seat_count,
               count(distinct s.ordinal) as distinct_seat_ordinals,
               min(s.ordinal) as min_seat_ordinal,
               max(s.ordinal) as max_seat_ordinal
             from ${this.table("seat_row")} sr
             left join ${this.table("seat")} s on s.row_id = sr.id
             where sr.dataset_id = $1
             group by sr.id, sr.ordinal
           ), sellable_seats as (
             select
               s.row_id,
               s.ordinal,
               s.ordinal - row_number() over (
                 partition by s.row_id order by s.ordinal
               ) as run_key
             from ${this.table("seat")} s
             where s.dataset_id = $1 and s.lifecycle_state = 'sellable'
           ), sellable_runs as (
             select row_id, run_key, count(*) as run_length
             from sellable_seats
             group by row_id, run_key
           )
           select
             (select count(*) from ${this.table("event")} where dataset_id = $1)
               as event_count,
             (select count(*) from ${this.table("section")} where dataset_id = $1)
               as section_count,
             (select count(*) from row_shape) as row_count,
             (select count(*) from row_shape
              where seat_count = 10
                and distinct_seat_ordinals = 10
                and min_seat_ordinal = 1
                and max_seat_ordinal = 10)
               as rows_with_ten_seats,
             (select count(*) from ${this.table("seat")} where dataset_id = $1)
               as seat_count,
             (select count(*) from ${this.table("sale_window")}
              where dataset_id = $1 and state = 'open')
               as sale_window_count,
             (select count(*) from ${this.table("price_tier")}
              where dataset_id = $1 and currency = 'USD')
               as price_tier_count,
             exists (select 1 from sellable_runs where run_length >= 4)
               as has_adjacent_four`,
          [datasetId],
        )
        const shape = validation.rows[0]
        if (
          integer(shape.event_count) !== 1 ||
          integer(shape.section_count) !== 1 ||
          integer(shape.row_count) !== 6 ||
          integer(shape.rows_with_ten_seats) !== 6 ||
          integer(shape.seat_count) !== 60 ||
          integer(shape.sale_window_count) !== 2 ||
          integer(shape.price_tier_count) !== 2 ||
          !shape.has_adjacent_four
        ) {
          throw new SeedInvariantError(
            "The preparing reset generation failed its 6x10, pricing, sale-window, or adjacent-four contract.",
          )
        }

        const retired = await client.query(
          `update ${this.table("prototype_dataset")}
           set state = 'retired', retired_at = clock_timestamp()
           where state = 'active'`,
        )
        if (retired.rowCount !== null && retired.rowCount > 1) {
          throw new SeedInvariantError(
            "Dataset rotation found more than one active generation.",
          )
        }
        const activated = await client.query(
          `update ${this.table("prototype_dataset")}
           set state = 'active', activated_at = clock_timestamp()
           where id = $1 and state = 'preparing'`,
          [datasetId],
        )
        if (activated.rowCount !== 1) {
          throw new SeedInvariantError(
            "Dataset rotation did not activate exactly one preparing generation.",
          )
        }

        const result: SeededInventory = {
          replayed: false,
          generation,
          datasetId,
          eventId,
          saleWindowId,
          presaleWindowId,
          priceTierIds: { standard: standardTierId, premium: premiumTierId },
          rows: rows.map(({ id, label, seatIds }) => ({ id, label, seatIds })),
          adjacentSeatIds: rows[0].seatIds.slice(0, 4),
        }
        return { result }
      },
      { statementTimeoutMs: 45_000, lockTimeoutMs: 30_000 },
    )
  }

  async issueLocalPrototypeAccessGrant(
    input: IssueAccessGrantInput,
  ): Promise<AccessGrantSnapshot> {
    assertCommandText(input.buyerRef, "buyerRef")
    assertCommandUuid(input.eventId, "eventId")
    assertCommandUuid(input.saleWindowId, "saleWindowId")
    if (
      !Number.isSafeInteger(input.validForMs) ||
      input.validForMs < MIN_HOLD_DURATION_MS ||
      input.validForMs > 24 * 60 * 60 * 1_000
    ) {
      throw new InventoryRepositoryError(
        "INVALID_COMMAND",
        "Access-grant duration must be between 250ms and 24 hours.",
      )
    }
    return this.transaction(async (client) => {
      await this.lockEvent(client, input.eventId)
      const window = await client.query<{ dataset_id: string }>(
        `select sw.dataset_id
         from ${this.table("sale_window")} sw
         join ${this.table("prototype_dataset")} d
           on d.id = sw.dataset_id and d.state = 'active'
         where sw.id = $1 and sw.event_id = $2
         for update of sw`,
        [input.saleWindowId, input.eventId],
      )
      const row = window.rows[0]
      if (!row) {
        throw new SaleWindowDeniedError(
          "SALE_WINDOW_NOT_FOUND",
          "The exact sale window is not active for this event.",
        )
      }
      const id = uuidV7()
      const inserted = await client.query<{ expires_at: Date | string }>(
        `insert into ${this.table("access_grant")} (
           id, dataset_id, event_id, sale_window_id, buyer_ref, proof_kind,
           state, policy_version, expires_at, created_at, verified_at
         ) select
           $1, $2, $3, $4, $5, 'local_prototype', 'verified', 1,
           captured_at + ($6::bigint * interval '1 millisecond'),
           captured_at, captured_at
         from (select clock_timestamp() as captured_at) clock
         returning expires_at`,
        [
          id,
          row.dataset_id,
          input.eventId,
          input.saleWindowId,
          input.buyerRef,
          input.validForMs,
        ],
      )
      return {
        id,
        eventId: input.eventId,
        saleWindowId: input.saleWindowId,
        buyerRef: input.buyerRef,
        proofKind: "local_prototype",
        state: "verified",
        expiresAt: iso(inserted.rows[0].expires_at),
      }
    })
  }

  private assertSeatSelection(input: QuoteSeatsInput): string[] {
    assertCommandText(input.buyerRef, "buyerRef")
    assertCommandUuid(input.eventId, "eventId")
    assertCommandUuid(input.saleWindowId, "saleWindowId")
    if (input.accessGrantId) {
      assertCommandUuid(input.accessGrantId, "accessGrantId")
    }
    if (
      input.seatIds.length < 1 ||
      input.seatIds.length > MAX_SEATS_PER_HOLD ||
      new Set(input.seatIds).size !== input.seatIds.length
    ) {
      throw new InventoryRepositoryError(
        "INVALID_COMMAND",
        "A seat request requires one to four distinct seats.",
      )
    }
    const seatIds = [...input.seatIds].sort()
    for (const seatId of seatIds) assertCommandUuid(seatId, "seatId")
    return seatIds
  }

  private async lockSaleWindowAndAccess(
    client: PoolClient,
    input: QuoteSeatsInput,
    seatCount: number,
  ): Promise<LockedSaleWindow> {
    const windowResult = await client.query<LockedSaleWindowRow>(
      `select
         e.dataset_id,
         e.currency,
         sw.id as sale_window_id,
         sw.kind,
         sw.access_policy_kind,
         sw.seat_limit,
         sw.state = 'open'
           and sw.opens_at <= statement_timestamp()
           and sw.closes_at > statement_timestamp() as is_open
       from ${this.table("event")} e
       join ${this.table("prototype_dataset")} d
         on d.id = e.dataset_id and d.state = 'active'
       join ${this.table("sale_window")} sw
         on sw.event_id = e.id and sw.id = $2
       where e.id = $1 and e.state = 'on_sale'
       for update of e, sw`,
      [input.eventId, input.saleWindowId],
    )
    const sale = windowResult.rows[0]
    if (!sale) {
      throw new SaleWindowDeniedError(
        "SALE_WINDOW_NOT_FOUND",
        "The exact sale window is not active for this event.",
      )
    }
    if (!sale.is_open) {
      throw new SaleWindowDeniedError(
        "SALE_WINDOW_NOT_OPEN",
        "The exact sale window is not open in database time.",
      )
    }
    if (seatCount > sale.seat_limit) {
      throw new InventoryRepositoryError(
        "INVALID_COMMAND",
        "The request exceeds the exact sale-window seat limit.",
      )
    }

    const isOpenGeneralWindow =
      sale.kind === "general" && sale.access_policy_kind === "prototype_open"
    if (isOpenGeneralWindow) {
      return { ...sale, access_state: "not_required" }
    }
    if (sale.access_policy_kind !== "local_prototype_cardmember") {
      throw new SaleWindowDeniedError(
        "SALE_WINDOW_POLICY_DENIED",
        "This sale-window policy is not supported by the V1 merchant adapter.",
      )
    }
    if (!input.accessGrantId) {
      throw new AccessGrantDeniedError(
        "ACCESS_GRANT_REQUIRED",
        "This presale requires a buyer-bound local prototype access grant.",
      )
    }
    const grantResult = await client.query<AccessGrantRow & {
      is_current: boolean
    }>(
      `select
         id, event_id, sale_window_id, buyer_ref, proof_kind, state,
         expires_at,
         expires_at > statement_timestamp() as is_current
       from ${this.table("access_grant")}
       where id = $1
       for update`,
      [input.accessGrantId],
    )
    const grant = grantResult.rows[0]
    if (
      !grant ||
      grant.event_id !== input.eventId ||
      grant.sale_window_id !== input.saleWindowId ||
      grant.buyer_ref !== input.buyerRef ||
      grant.proof_kind !== "local_prototype" ||
      grant.state === "revoked"
    ) {
      throw new AccessGrantDeniedError(
        "ACCESS_GRANT_DENIED",
        "The access grant is not bound to this buyer, event, and sale window.",
      )
    }
    if (grant.state === "expired" || !grant.is_current) {
      throw new AccessGrantDeniedError(
        "ACCESS_GRANT_EXPIRED",
        "The access grant is expired in database time.",
      )
    }
    return { ...sale, access_state: "verified_local_prototype" }
  }

  private buildLockedQuote(
    input: QuoteSeatsInput,
    sale: LockedSaleWindow,
    seats: readonly SeatPriceRow[],
  ): QuoteSeatsResult {
    if (seats.length !== input.seatIds.length) {
      throw new InventoryRepositoryError(
        "SEAT_NOT_FOUND",
        "At least one requested seat does not belong to the event.",
      )
    }
    if (seats.some((seat) => !seat.price_effective)) {
      throw new MoneyInvariantError(
        "At least one requested seat has no price effective in database time.",
      )
    }
    if (seats.some((seat) => seat.currency !== sale.currency)) {
      throw new MoneyInvariantError(
        "Seat price currency does not match the event currency.",
      )
    }
    if (sale.currency !== "USD") {
      throw new MoneyInvariantError(
        "The ONSALE V1 public quote contract supports USD only.",
      )
    }
    const blocked = seats
      .filter((seat) => seat.lifecycle_state !== "sellable")
      .map((seat) => seat.id)
    if (blocked.length) throw new SeatUnavailableError(blocked)

    const displaySeats = [...seats].sort(
      (left, right) =>
        left.section_ordinal - right.section_ordinal ||
        left.row_ordinal - right.row_ordinal ||
        left.seat_ordinal - right.seat_ordinal,
    )
    const allocationRows: AllocationRow[] = displaySeats.map((seat) => ({
      id: "",
      dataset_id: seat.dataset_id,
      event_id: seat.event_id,
      seat_id: seat.id,
      hold_id: "",
      order_id: null,
      state: "held",
      price_tier_name: seat.price_tier_name,
      face_value_minor: seat.face_value_minor,
      fee_minor: seat.fee_minor,
      tax_minor: seat.tax_minor,
      total_minor: seat.total_minor,
      currency: seat.currency,
    }))
    const items: QuoteSeatSnapshot[] = displaySeats.map((seat) => ({
      seatId: seat.id,
      sectionName: seat.section_name,
      rowLabel: seat.row_label,
      seatLabel: seat.label,
      priceTierName: seat.price_tier_name,
      price: {
        currency: seat.currency,
        subtotalMinor: integer(seat.face_value_minor),
        feeMinor: integer(seat.fee_minor),
        taxMinor: integer(seat.tax_minor),
        totalMinor: integer(seat.total_minor),
      },
    }))
    const revision = createQuoteRevisionV1({
      schema: "onsale.quote.v1",
      datasetRef: sale.dataset_id,
      eventRef: input.eventId,
      saleWindowRef: sale.sale_window_id,
      saleWindowState: "open",
      accessState: sale.access_state,
      seats: displaySeats.map((seat) => ({
        publicRef: seat.id,
        rowOrdinal: seat.row_ordinal,
        seatOrdinal: seat.seat_ordinal,
        lifecycle: seat.lifecycle_state,
        price: {
          currency: "USD",
          faceValueMinor: integer(seat.face_value_minor),
          feeMinor: integer(seat.fee_minor),
          taxMinor: integer(seat.tax_minor),
          totalMinor: integer(seat.total_minor),
        },
      })),
    })
    return {
      quoteRevision: revision,
      eventId: input.eventId,
      saleWindowId: sale.sale_window_id,
      seatIds: items.map((item) => item.seatId),
      items,
      totals: sumMoney(allocationRows),
    }
  }

  async quoteSeats(input: QuoteSeatsInput): Promise<QuoteSeatsResult> {
    const seatIds = this.assertSeatSelection(input)
    return this.transaction(async (client) => {
      await this.lockEvent(client, input.eventId)
      const sale = await this.lockSaleWindowAndAccess(
        client,
        input,
        seatIds.length,
      )
      const seats = await this.lockSeats(client, input.eventId, seatIds)
      const quote = this.buildLockedQuote(input, sale, seats)
      const conflicts = await client.query<{ seat_id: string }>(
        `select a.seat_id
         from ${this.table("seat_allocation")} a
         join ${this.table("hold")} h on h.id = a.hold_id
         where a.seat_id = any($1::uuid[])
           and (
             a.state = 'reserved'
             or (
               a.state = 'held'
               and h.state = 'active'
               and h.expires_at > statement_timestamp()
             )
           )
         order by a.seat_id
         for update of a, h`,
        [seatIds],
      )
      if (conflicts.rowCount) {
        throw new SeatUnavailableError(conflicts.rows.map((row) => row.seat_id))
      }
      return quote
    })
  }

  private async reconcileBuyerCurrentHold(
    client: PoolClient,
    eventId: string,
    buyerRef: string,
  ): Promise<boolean> {
    const holds = await client.query<{
      id: string
      expires_at: Date | string
      is_expired: boolean
    }>(
      `select
         id,
         expires_at,
         expires_at <= statement_timestamp() as is_expired
       from ${this.table("hold")}
       where event_id = $1 and buyer_ref = $2 and state = 'active'
       order by id
       for update`,
      [eventId, buyerRef],
    )
    const expiredIds = holds.rows
      .filter((hold) => hold.is_expired)
      .map((hold) => hold.id)
    if (expiredIds.length) {
      await client.query(
        `update ${this.table("hold")}
         set state = 'expired', expired_at = clock_timestamp(),
             terminal_reason = 'database_time_expiry', version = version + 1
         where id = any($1::uuid[]) and state = 'active'`,
        [expiredIds],
      )
      await client.query(
        `update ${this.table("seat_allocation")}
         set state = 'expired', expired_at = clock_timestamp()
         where hold_id = any($1::uuid[]) and state = 'held'`,
        [expiredIds],
      )
    }
    return holds.rows.some((hold) => !hold.is_expired)
  }

  async claimSeats(input: ClaimSeatsInput): Promise<ClaimSeatsResult> {
    return this.claimSeatsInternal(input)
  }

  async claimQuotedSeats(
    input: ClaimQuotedSeatsInput,
  ): Promise<ClaimSeatsResult> {
    return this.claimSeatsInternal(input, input.quoteRevision)
  }

  private async claimSeatsInternal(
    input: ClaimSeatsInput,
    expectedQuoteRevision?: Sha256RevisionV1,
  ): Promise<ClaimSeatsResult> {
    assertCommandText(input.operationKey, "operationKey")
    const seatIds = [...input.seatIds].sort()
    const requestHash = canonicalHash({
      eventId: input.eventId,
      saleWindowId: input.saleWindowId,
      accessGrantId: input.accessGrantId ?? null,
      buyerRef: input.buyerRef,
      seatIds,
      holdForMs: input.holdForMs,
      quoteRevision: expectedQuoteRevision ?? null,
    })

    return this.executeIdempotentCommand<ClaimSeatsResult>(
      {
        operationKey: input.operationKey,
        commandKind: "claim_seats",
        requestHash,
      },
      async (client) => {
        this.assertSeatSelection(input)
        if (
          !Number.isSafeInteger(input.holdForMs) ||
          input.holdForMs < MIN_HOLD_DURATION_MS ||
          input.holdForMs > MAX_HOLD_DURATION_MS
        ) {
          throw new InventoryRepositoryError(
            "INVALID_COMMAND",
            "A claim requires one to four distinct seats and a hold duration between 250ms and 15 minutes.",
          )
        }
        if (
          expectedQuoteRevision !== undefined &&
          !/^sha256:[0-9a-f]{64}$/u.test(expectedQuoteRevision)
        ) {
          throw new InventoryRepositoryError(
            "INVALID_COMMAND",
            "quoteRevision must be a canonical SHA-256 revision.",
          )
        }
        await this.lockEvent(client, input.eventId)
        const sale = await this.lockSaleWindowAndAccess(
          client,
          input,
          seatIds.length,
        )
        const hasCurrentHold = await this.reconcileBuyerCurrentHold(
          client,
          input.eventId,
          input.buyerRef,
        )
        if (hasCurrentHold) {
          return { committedFailure: new ActiveHoldExistsError() }
        }

        const seats = await this.lockSeats(client, input.eventId, seatIds)
        const lockedQuote = this.buildLockedQuote(input, sale, seats)

        const activeAllocations = await client.query<AllocationRow & {
          hold_state: HoldSnapshot["state"]
          expires_at: Date | string
        }>(
          `select a.*, h.state as hold_state, h.expires_at
           from ${this.table("seat_allocation")} a
           join ${this.table("hold")} h on h.id = a.hold_id
           where a.seat_id = any($1::uuid[]) and a.state in ('held', 'reserved')
           order by a.seat_id
           for update of a, h`,
          [seatIds],
        )
        const possiblyExpiredHoldIds = [
          ...new Set(
            activeAllocations.rows
              .filter(
                (row) => row.state === "held" && row.hold_state === "active",
              )
              .map((row) => row.hold_id),
          ),
        ]
        if (possiblyExpiredHoldIds.length) {
          const expired = await client.query<{ id: string }>(
            `update ${this.table("hold")}
             set state = 'expired', expired_at = clock_timestamp(),
                 terminal_reason = 'database_time_expiry', version = version + 1
             where id = any($1::uuid[])
               and state = 'active'
               and expires_at <= statement_timestamp()
             returning id`,
            [possiblyExpiredHoldIds],
          )
          const expiredIds = expired.rows.map((row) => row.id)
          if (expiredIds.length) {
            await client.query(
              `update ${this.table("seat_allocation")}
               set state = 'expired', expired_at = clock_timestamp()
               where hold_id = any($1::uuid[]) and state = 'held'`,
              [expiredIds],
            )
          }
        }

        const conflicts = await client.query<{ seat_id: string }>(
          `select seat_id
           from ${this.table("seat_allocation")}
           where seat_id = any($1::uuid[]) and state in ('held', 'reserved')
           order by seat_id`,
          [seatIds],
        )
        if (conflicts.rowCount) {
          throw new SeatUnavailableError(
            conflicts.rows.map((row) => row.seat_id),
          )
        }
        if (
          expectedQuoteRevision !== undefined &&
          lockedQuote.quoteRevision !== expectedQuoteRevision
        ) {
          throw new QuoteStaleError()
        }

        const holdId = uuidV7()
        const expires = await client.query<{ expires_at: Date | string }>(
          `insert into ${this.table("hold")} (
             id, dataset_id, event_id, sale_window_id, buyer_ref, state,
             expires_at, created_at
           ) select
             $1, $2, $3, $4, $5, 'active',
             captured_at + ($6::bigint * interval '1 millisecond'), captured_at
           from (select clock_timestamp() as captured_at) clock
           returning expires_at`,
          [
            holdId,
            sale.dataset_id,
            input.eventId,
            input.saleWindowId,
            input.buyerRef,
            input.holdForMs,
          ],
        )
        for (const seat of seats) {
          await client.query(
            `insert into ${this.table("seat_allocation")} (
               id, dataset_id, event_id, seat_id, hold_id, state,
               price_tier_name, face_value_minor, fee_minor, tax_minor,
               total_minor, currency
             ) values ($1, $2, $3, $4, $5, 'held', $6, $7, $8, $9, $10, $11)`,
            [
              uuidV7(),
              seat.dataset_id,
              seat.event_id,
              seat.id,
              holdId,
              seat.price_tier_name,
              seat.face_value_minor,
              seat.fee_minor,
              seat.tax_minor,
              seat.total_minor,
              seat.currency,
            ],
          )
        }
        const result: ClaimSeatsResult = {
          replayed: false,
          holdId,
          eventId: input.eventId,
          seatIds: lockedQuote.seatIds,
          expiresAt: iso(expires.rows[0].expires_at),
          totals: lockedQuote.totals,
        }
        return { result, targets: { holdId } }
      },
    )
  }

  private async findHoldEvent(
    client: PoolClient,
    holdId: string,
  ): Promise<string> {
    const result = await client.query<{ event_id: string }>(
      `select event_id from ${this.table("hold")} where id = $1`,
      [holdId],
    )
    const eventId = result.rows[0]?.event_id
    if (!eventId) {
      throw new InventoryRepositoryError(
        "HOLD_NOT_FOUND",
        "The hold does not exist.",
      )
    }
    return eventId
  }

  private async findOrderEvent(
    client: PoolClient,
    orderId: string,
  ): Promise<string> {
    const result = await client.query<{ event_id: string }>(
      `select event_id from ${this.table("orders")} where id = $1`,
      [orderId],
    )
    const eventId = result.rows[0]?.event_id
    if (!eventId) {
      throw new InventoryRepositoryError(
        "ORDER_NOT_FOUND",
        "The order does not exist.",
      )
    }
    return eventId
  }

  private async lockHoldAndAllocations(
    client: PoolClient,
    holdId: string,
  ): Promise<{
    readonly hold: HoldRow
    readonly allocations: AllocationRow[]
  }> {
    const holdResult = await client.query<HoldRow>(
      `select id, dataset_id, event_id, sale_window_id, buyer_ref, state, expires_at
       from ${this.table("hold")}
       where id = $1
       for update`,
      [holdId],
    )
    const hold = holdResult.rows[0]
    if (!hold) {
      throw new InventoryRepositoryError(
        "HOLD_NOT_FOUND",
        "The hold does not exist.",
      )
    }
    const allocations = await client.query<AllocationRow>(
      `select * from ${this.table("seat_allocation")}
       where hold_id = $1
       order by seat_id
       for update`,
      [holdId],
    )
    await this.lockSeats(
      client,
      hold.event_id,
      allocations.rows.map((row) => row.seat_id).sort(),
    )
    return { hold, allocations: allocations.rows }
  }

  async releaseHold(input: ReleaseHoldInput): Promise<ReleaseHoldResult> {
    const requestHash = canonicalHash({
      holdId: input.holdId,
      buyerRef: input.buyerRef,
    })
    return this.executeIdempotentCommand(
      {
        operationKey: input.operationKey,
        commandKind: "release_hold",
        requestHash,
      },
      async (client) => {
        assertCommandText(input.buyerRef, "buyerRef")
        assertCommandUuid(input.holdId, "holdId")
        const eventId = await this.findHoldEvent(client, input.holdId)
        await this.lockEvent(client, eventId)
        const { hold } = await this.lockHoldAndAllocations(client, input.holdId)
        if (hold.buyer_ref !== input.buyerRef) {
          throw new InventoryRepositoryError(
            "HOLD_OWNERSHIP_MISMATCH",
            "The buyer does not own the hold.",
          )
        }
        if (hold.state === "converted") throw new HoldNotActiveError(hold.state)
        if (hold.state === "expired") throw new HoldNotActiveError(hold.state)

        const releasedSeatIds = await this.seatIdsInDisplayOrder(
          client,
          hold.id,
        )
        const terminalReplay = hold.state === "released"
        if (!terminalReplay) {
          await client.query(
            `update ${this.table("seat_allocation")}
             set state = 'released', released_at = clock_timestamp()
             where hold_id = $1 and state = 'held'`,
            [hold.id],
          )
          await client.query(
            `update ${this.table("hold")}
             set state = 'released', released_at = clock_timestamp(),
                 terminal_reason = 'buyer_released', version = version + 1
             where id = $1 and state = 'active'`,
            [hold.id],
          )
        }
        const result: ReleaseHoldResult = {
          replayed: false,
          terminalReplay,
          holdId: hold.id,
          state: "released",
          releasedSeatIds,
        }
        return { result, targets: { holdId: hold.id } }
      },
    )
  }

  async expireHold(input: ExpireHoldInput): Promise<ExpireHoldResult> {
    const requestHash = canonicalHash({
      holdId: input.holdId,
      buyerRef: input.buyerRef,
    })
    return this.executeIdempotentCommand(
      {
        operationKey: input.operationKey,
        commandKind: "expire_hold",
        requestHash,
      },
      async (client) => {
        assertCommandText(input.buyerRef, "buyerRef")
        assertCommandUuid(input.holdId, "holdId")
        const eventId = await this.findHoldEvent(client, input.holdId)
        await this.lockEvent(client, eventId)
        const { hold } = await this.lockHoldAndAllocations(client, input.holdId)
        if (hold.buyer_ref !== input.buyerRef) {
          throw new InventoryRepositoryError(
            "HOLD_OWNERSHIP_MISMATCH",
            "The buyer does not own the hold.",
          )
        }
        if (hold.state === "released" || hold.state === "converted") {
          throw new HoldNotActiveError(hold.state)
        }
        let state = hold.state
        let releasedSeatIds =
          hold.state === "expired"
            ? await this.seatIdsInDisplayOrder(client, hold.id)
            : []
        if (hold.state === "active") {
          const expired = await client.query<{ id: string }>(
            `update ${this.table("hold")}
             set state = 'expired', expired_at = clock_timestamp(),
                 terminal_reason = 'database_time_expiry', version = version + 1
             where id = $1 and state = 'active'
               and expires_at <= statement_timestamp()
             returning id`,
            [hold.id],
          )
          if (expired.rowCount) {
            state = "expired"
            releasedSeatIds = await this.seatIdsInDisplayOrder(client, hold.id)
            await client.query(
              `update ${this.table("seat_allocation")}
               set state = 'expired', expired_at = clock_timestamp()
               where hold_id = $1 and state = 'held'`,
              [hold.id],
            )
          }
        }
        const result: ExpireHoldResult = {
          replayed: false,
          holdId: hold.id,
          state,
          releasedSeatIds,
        }
        return { result, targets: { holdId: hold.id } }
      },
    )
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const requestHash = canonicalHash({
      holdId: input.holdId,
      buyerRef: input.buyerRef,
    })
    return this.executeIdempotentCommand(
      {
        operationKey: input.operationKey,
        commandKind: "create_order",
        requestHash,
      },
      async (client) => {
        assertCommandText(input.buyerRef, "buyerRef")
        assertCommandUuid(input.holdId, "holdId")
        const eventId = await this.findHoldEvent(client, input.holdId)
        await this.lockEvent(client, eventId)
        const { hold, allocations } = await this.lockHoldAndAllocations(
          client,
          input.holdId,
        )
        if (hold.buyer_ref !== input.buyerRef) {
          throw new InventoryRepositoryError(
            "HOLD_OWNERSHIP_MISMATCH",
            "The buyer does not own the hold.",
          )
        }
        if (hold.state === "converted") throw new OrderAlreadyExistsError()
        if (hold.state !== "active") throw new HoldNotActiveError(hold.state)
        const notExpired = await client.query<{ available: boolean }>(
          "select statement_timestamp() < $1::timestamptz as available",
          [hold.expires_at],
        )
        if (!notExpired.rows[0]?.available)
          throw new HoldNotActiveError("expired")
        if (
          allocations.length < 1 ||
          allocations.length > MAX_SEATS_PER_HOLD ||
          allocations.some((allocation) => allocation.state !== "held")
        ) {
          throw new InventoryRepositoryError(
            "HOLD_INVARIANT",
            "The active hold does not own one to four held allocations.",
          )
        }

        const totals = sumMoney(allocations)
        const orderId = uuidV7()
        await client.query(
          `insert into ${this.table("orders")} (
           id, dataset_id, event_id, hold_id, sale_window_id, buyer_ref, state,
           currency, subtotal_minor, fee_minor, tax_minor, total_minor,
           payment_deadline_at
         ) values (
           $1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $8, $9, $10, $11,
           statement_timestamp() + interval '15 minutes'
         )`,
          [
            orderId,
            hold.dataset_id,
            hold.event_id,
            hold.id,
            hold.sale_window_id,
            hold.buyer_ref,
            totals.currency,
            totals.subtotalMinor,
            totals.feeMinor,
            totals.taxMinor,
            totals.totalMinor,
          ],
        )

        await client.query(
          `update ${this.table("seat_allocation")}
         set state = 'reserved', order_id = $2, reserved_at = clock_timestamp()
         where hold_id = $1 and state = 'held'`,
          [hold.id, orderId],
        )

        const itemRows = await client.query<AllocationRow & {
          section_name: string
          row_label: string
          seat_label: string
          price_tier_name: string
        }>(
          `select
           a.*,
           sec.name as section_name,
           sr.label as row_label,
           s.label as seat_label,
           a.price_tier_name
         from ${this.table("seat_allocation")} a
         join ${this.table("seat")} s on s.id = a.seat_id
         join ${this.table("section")} sec on sec.id = s.section_id
         join ${this.table("seat_row")} sr on sr.id = s.row_id
         where a.hold_id = $1
         order by sec.ordinal, sr.ordinal, s.ordinal`,
          [hold.id],
        )
        const items: OrderItemSnapshot[] = []
        for (const row of itemRows.rows) {
          const item: OrderItemSnapshot = {
            id: uuidV7(),
            seatId: row.seat_id,
            sectionName: row.section_name,
            rowLabel: row.row_label,
            seatLabel: row.seat_label,
            priceTierName: row.price_tier_name,
            faceValueMinor: integer(row.face_value_minor),
            feeMinor: integer(row.fee_minor),
            taxMinor: integer(row.tax_minor),
            totalMinor: integer(row.total_minor),
            currency: row.currency,
          }
          await client.query(
            `insert into ${this.table("order_item")} (
             id, dataset_id, event_id, order_id, seat_id, seat_allocation_id,
             section_name, row_label, seat_label, price_tier_name,
             face_value_minor, fee_minor, tax_minor, total_minor, currency
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
           )`,
            [
              item.id,
              row.dataset_id,
              row.event_id,
              orderId,
              row.seat_id,
              row.id,
              item.sectionName,
              item.rowLabel,
              item.seatLabel,
              item.priceTierName,
              item.faceValueMinor,
              item.feeMinor,
              item.taxMinor,
              item.totalMinor,
              item.currency,
            ],
          )
          items.push(item)
        }
        await client.query(
          `select ${this.quotedSchema}.assert_order_item_totals($1::uuid)`,
          [orderId],
        )
        await client.query(
          `update ${this.table("hold")}
         set state = 'converted', converted_at = clock_timestamp(),
             terminal_reason = 'converted_to_order', version = version + 1
         where id = $1 and state = 'active'`,
          [hold.id],
        )

        const result: CreateOrderResult = {
          replayed: false,
          orderId,
          holdId: hold.id,
          eventId: hold.event_id,
          state: "awaiting_payment",
          seatIds: items.map((item) => item.seatId),
          totals,
          items,
        }
        return {
          result,
          targets: { holdId: hold.id, orderId },
        }
      },
    )
  }

  async cancelOrder(input: CancelOrderInput): Promise<CancelOrderResult> {
    const requestHash = canonicalHash({
      orderId: input.orderId,
      buyerRef: input.buyerRef,
    })
    return this.executeIdempotentCommand(
      {
        operationKey: input.operationKey,
        commandKind: "cancel_order",
        requestHash,
      },
      async (client) => {
        assertCommandText(input.buyerRef, "buyerRef")
        assertCommandUuid(input.orderId, "orderId")
        const eventId = await this.findOrderEvent(client, input.orderId)
        await this.lockEvent(client, eventId)
        const orderResult = await client.query<OrderRow>(
          `select
             id, dataset_id, event_id, hold_id, buyer_ref, state, canceled_at
           from ${this.table("orders")}
           where id = $1
           for update`,
          [input.orderId],
        )
        const order = orderResult.rows[0]
        if (!order) {
          throw new InventoryRepositoryError(
            "ORDER_NOT_FOUND",
            "The order does not exist.",
          )
        }
        if (order.buyer_ref !== input.buyerRef) {
          throw new InventoryRepositoryError(
            "ORDER_OWNERSHIP_MISMATCH",
            "The buyer does not own the order.",
          )
        }

        const allocationResult = await client.query<AllocationRow>(
          `select *
           from ${this.table("seat_allocation")}
           where order_id = $1
           order by seat_id
           for update`,
          [order.id],
        )
        const allocations = allocationResult.rows
        await this.lockSeats(
          client,
          order.event_id,
          allocations.map((allocation) => allocation.seat_id).sort(),
        )
        const releasedSeatIds = await this.seatIdsInDisplayOrder(
          client,
          order.hold_id,
        )

        if (order.state === "canceled") {
          if (
            allocations.length < 1 ||
            allocations.length > MAX_SEATS_PER_HOLD ||
            allocations.some(
              (allocation) => allocation.state !== "reservation_released",
            )
          ) {
            throw new InventoryRepositoryError(
              "ORDER_INVARIANT",
              "A canceled order must retain one to four released reservations.",
            )
          }
          const result: CancelOrderResult = {
            replayed: false,
            terminalReplay: true,
            orderId: order.id,
            holdId: order.hold_id,
            eventId: order.event_id,
            state: "canceled",
            releasedSeatIds,
          }
          return {
            result,
            targets: { holdId: order.hold_id, orderId: order.id },
          }
        }
        if (order.state !== "awaiting_payment") {
          throw new OrderCancellationBlockedError(order.state)
        }
        if (
          allocations.length < 1 ||
          allocations.length > MAX_SEATS_PER_HOLD ||
          allocations.some((allocation) => allocation.state !== "reserved")
        ) {
          throw new InventoryRepositoryError(
            "ORDER_INVARIANT",
            "An unpaid order must own one to four active reservations.",
          )
        }

        const released = await client.query(
          `update ${this.table("seat_allocation")}
           set state = 'reservation_released', released_at = clock_timestamp()
           where order_id = $1 and state = 'reserved'`,
          [order.id],
        )
        if (released.rowCount !== allocations.length) {
          throw new InventoryRepositoryError(
            "ORDER_INVARIANT",
            "Cancellation did not release the complete reservation set.",
          )
        }
        const canceled = await client.query(
          `update ${this.table("orders")}
           set state = 'canceled', canceled_at = clock_timestamp(),
               version = version + 1
           where id = $1 and state = 'awaiting_payment'`,
          [order.id],
        )
        if (canceled.rowCount !== 1) {
          throw new InventoryRepositoryError(
            "ORDER_INVARIANT",
            "Cancellation did not transition the unpaid order.",
          )
        }

        const result: CancelOrderResult = {
          replayed: false,
          terminalReplay: false,
          orderId: order.id,
          holdId: order.hold_id,
          eventId: order.event_id,
          state: "canceled",
          releasedSeatIds,
        }
        return {
          result,
          targets: { holdId: order.hold_id, orderId: order.id },
        }
      },
    )
  }

  async updatePriceTier(input: {
    readonly priceTierId: string
    readonly faceValueMinor: number
    readonly feeMinor: number
    readonly taxMinor: number
  }): Promise<void> {
    const allInMinor = checkedMoneySum(
      [input.faceValueMinor, input.feeMinor, input.taxMinor],
      "Price tier total",
    )
    if (allInMinor < 1) {
      throw new MoneyInvariantError("A sellable price tier must be positive.")
    }
    const event = await this.pool.query<{ event_id: string }>(
      `select event_id from ${this.table("price_tier")} where id = $1`,
      [input.priceTierId],
    )
    const eventId = event.rows[0]?.event_id
    if (!eventId) {
      throw new InventoryRepositoryError(
        "PRICE_TIER_NOT_FOUND",
        "Price tier not found.",
      )
    }
    await this.transaction(async (client) => {
      await this.lockEvent(client, eventId)
      const updated = await client.query(
        `update ${this.table("price_tier")}
         set face_value_minor = $2,
             fee_minor = $3,
             tax_minor = $4,
             all_in_minor = $5
         where id = $1`,
        [
          input.priceTierId,
          input.faceValueMinor,
          input.feeMinor,
          input.taxMinor,
          allInMinor,
        ],
      )
      if (updated.rowCount !== 1) {
        throw new InventoryRepositoryError(
          "PRICE_TIER_NOT_FOUND",
          "Price tier not found.",
        )
      }
    })
  }

  async getHold(holdId: string): Promise<HoldSnapshot | undefined> {
    const result = await this.pool.query<HoldRow>(
      `select id, event_id, buyer_ref, state, expires_at
       from ${this.table("hold")}
       where id = $1`,
      [holdId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      eventId: row.event_id,
      buyerRef: row.buyer_ref,
      state: row.state,
      expiresAt: iso(row.expires_at),
    }
  }

  async getAccessGrant(
    accessGrantId: string,
  ): Promise<AccessGrantSnapshot | undefined> {
    const result = await this.pool.query<AccessGrantRow & {
      effective_state: AccessGrantSnapshot["state"]
    }>(
      `select
         id, event_id, sale_window_id, buyer_ref, proof_kind, expires_at,
         case
           when state = 'verified' and expires_at <= statement_timestamp()
             then 'expired'
           else state
         end as effective_state
       from ${this.table("access_grant")}
       where id = $1`,
      [accessGrantId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      eventId: row.event_id,
      saleWindowId: row.sale_window_id,
      buyerRef: row.buyer_ref,
      proofKind: row.proof_kind,
      state: row.effective_state,
      expiresAt: iso(row.expires_at),
    }
  }

  async getOperation(
    operationKey: string,
  ): Promise<DurableOperationSnapshot | undefined> {
    const result = await this.pool.query<OperationRow>(
      `select id, command_kind, request_hash, state, result, error_code
       from ${this.table("idempotency_operation")}
       where scope = $1 and operation_key = $2`,
      [OPERATION_SCOPE, operationKey],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      commandKind: row.command_kind,
      state: row.state,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    }
  }

  async getAllocationsForEvent(
    eventId: string,
  ): Promise<DurableAllocationSnapshot[]> {
    const result = await this.pool.query<AllocationRow>(
      `select * from ${this.table("seat_allocation")}
       where event_id = $1
       order by seat_id, created_at`,
      [eventId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      seatId: row.seat_id,
      holdId: row.hold_id,
      ...(row.order_id ? { orderId: row.order_id } : {}),
      state: row.state,
      ...(row.reserved_at ? { reservedAt: iso(row.reserved_at) } : {}),
      ...(row.released_at ? { releasedAt: iso(row.released_at) } : {}),
      totals: {
        currency: row.currency,
        subtotalMinor: integer(row.face_value_minor),
        feeMinor: integer(row.fee_minor),
        taxMinor: integer(row.tax_minor),
        totalMinor: integer(row.total_minor),
      },
    }))
  }

  async getOrder(orderId: string): Promise<DurableOrderSnapshot | undefined> {
    const order = await this.pool.query<{
      id: string
      hold_id: string
      event_id: string
      state: DurableOrderSnapshot["state"]
      currency: string
      subtotal_minor: string | number
      fee_minor: string | number
      tax_minor: string | number
      total_minor: string | number
    }>(
      `select id, hold_id, event_id, state, currency, subtotal_minor,
              fee_minor, tax_minor, total_minor
       from ${this.table("orders")}
       where id = $1`,
      [orderId],
    )
    const header = order.rows[0]
    if (!header) return undefined
    const items = await this.pool.query<{
      id: string
      seat_id: string
      section_name: string
      row_label: string
      seat_label: string
      price_tier_name: string
      face_value_minor: string | number
      fee_minor: string | number
      tax_minor: string | number
      total_minor: string | number
      currency: string
    }>(
      `select
         oi.id, oi.seat_id, oi.section_name, oi.row_label, oi.seat_label,
         oi.price_tier_name, oi.face_value_minor, oi.fee_minor, oi.tax_minor,
         oi.total_minor, oi.currency
       from ${this.table("order_item")} oi
       join ${this.table("seat")} s on s.id = oi.seat_id
       join ${this.table("seat_row")} sr on sr.id = s.row_id
       join ${this.table("section")} sec on sec.id = s.section_id
       where oi.order_id = $1
       order by sec.ordinal, sr.ordinal, s.ordinal`,
      [orderId],
    )
    return {
      id: header.id,
      holdId: header.hold_id,
      eventId: header.event_id,
      state: header.state,
      totals: {
        currency: header.currency,
        subtotalMinor: integer(header.subtotal_minor),
        feeMinor: integer(header.fee_minor),
        taxMinor: integer(header.tax_minor),
        totalMinor: integer(header.total_minor),
      },
      items: items.rows.map((row) => ({
        id: row.id,
        seatId: row.seat_id,
        sectionName: row.section_name,
        rowLabel: row.row_label,
        seatLabel: row.seat_label,
        priceTierName: row.price_tier_name,
        faceValueMinor: integer(row.face_value_minor),
        feeMinor: integer(row.fee_minor),
        taxMinor: integer(row.tax_minor),
        totalMinor: integer(row.total_minor),
        currency: row.currency,
      })),
    }
  }

  async getOwnedCheckoutOrder(
    orderId: string,
    buyerRef: string,
  ): Promise<OwnedCheckoutOrderSnapshot | undefined> {
    assertCommandUuid(orderId, "orderId")
    assertCommandText(buyerRef, "buyerRef")
    const client = await this.pool.connect()
    try {
      await client.query("begin isolation level repeatable read read only")
      await client.query("select set_config('statement_timeout', $1, true)", [
        "5000ms",
      ])
      await client.query("select set_config('lock_timeout', $1, true)", [
        "1000ms",
      ])
      const order = await client.query<{
        id: string
        hold_id: string
        event_id: string
        state: DurableOrderSnapshot["state"]
        payment_deadline_at: Date | string
        server_observed_at: Date | string
        currency: string
        subtotal_minor: string | number
        fee_minor: string | number
        tax_minor: string | number
        total_minor: string | number
      }>(
        `select id, hold_id, event_id, state, payment_deadline_at,
                statement_timestamp() as server_observed_at, currency,
                subtotal_minor, fee_minor, tax_minor, total_minor
         from ${this.table("orders")}
         where id = $1 and buyer_ref = $2`,
        [orderId, buyerRef],
      )
      const header = order.rows[0]
      if (!header) {
        await client.query("commit")
        return undefined
      }
      const items = await client.query<{
        id: string
        seat_id: string
        section_name: string
        row_label: string
        seat_label: string
        price_tier_name: string
        face_value_minor: string | number
        fee_minor: string | number
        tax_minor: string | number
        total_minor: string | number
        currency: string
      }>(
        `select
           oi.id, oi.seat_id, oi.section_name, oi.row_label, oi.seat_label,
           oi.price_tier_name, oi.face_value_minor, oi.fee_minor, oi.tax_minor,
           oi.total_minor, oi.currency
         from ${this.table("order_item")} oi
         where oi.order_id = $1
         order by oi.created_at, oi.id`,
        [orderId],
      )
      if (items.rows.length < 1 || items.rows.length > MAX_SEATS_PER_HOLD) {
        throw new InventoryRepositoryError(
          "ORDER_INVARIANT",
          "Checkout requires one to four immutable order items.",
        )
      }
      const projectedItems = items.rows.map((row) => ({
        id: row.id,
        seatId: row.seat_id,
        sectionName: row.section_name,
        rowLabel: row.row_label,
        seatLabel: row.seat_label,
        priceTierName: row.price_tier_name,
        faceValueMinor: integer(row.face_value_minor),
        feeMinor: integer(row.fee_minor),
        taxMinor: integer(row.tax_minor),
        totalMinor: integer(row.total_minor),
        currency: row.currency,
      }))
      const totals: MoneySnapshot = {
        currency: header.currency,
        subtotalMinor: integer(header.subtotal_minor),
        feeMinor: integer(header.fee_minor),
        taxMinor: integer(header.tax_minor),
        totalMinor: integer(header.total_minor),
      }
      if (
        projectedItems.some((item) => item.currency !== totals.currency) ||
        checkedMoneySum(
          projectedItems.map((item) => item.faceValueMinor),
          "checkout order subtotal",
        ) !== totals.subtotalMinor ||
        checkedMoneySum(
          projectedItems.map((item) => item.feeMinor),
          "checkout order fee",
        ) !== totals.feeMinor ||
        checkedMoneySum(
          projectedItems.map((item) => item.taxMinor),
          "checkout order tax",
        ) !== totals.taxMinor ||
        checkedMoneySum(
          projectedItems.map((item) => item.totalMinor),
          "checkout order total",
        ) !== totals.totalMinor ||
        checkedMoneySum(
          [totals.subtotalMinor, totals.feeMinor, totals.taxMinor],
          "checkout order total",
        ) !== totals.totalMinor
      ) {
        throw new InventoryRepositoryError(
          "ORDER_INVARIANT",
          "Immutable checkout order items and header money do not match.",
        )
      }
      const result: OwnedCheckoutOrderSnapshot = {
        id: header.id,
        holdId: header.hold_id,
        eventId: header.event_id,
        state: header.state,
        paymentDeadlineAt: iso(header.payment_deadline_at),
        serverObservedAt: iso(header.server_observed_at),
        totals,
        items: projectedItems,
      }
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async getPriceTier(
    priceTierId: string,
  ): Promise<PriceTierSnapshot | undefined> {
    const result = await this.pool.query<{
      id: string
      currency: string
      face_value_minor: string | number
      fee_minor: string | number
      tax_minor: string | number
      all_in_minor: string | number
    }>(
      `select id, currency, face_value_minor, fee_minor, tax_minor, all_in_minor
       from ${this.table("price_tier")}
       where id = $1`,
      [priceTierId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      currency: row.currency,
      faceValueMinor: integer(row.face_value_minor),
      feeMinor: integer(row.fee_minor),
      taxMinor: integer(row.tax_minor),
      totalMinor: integer(row.all_in_minor),
    }
  }

  async inspectDatasetGeneration(
    datasetId: string,
  ): Promise<DatasetGenerationInspection | undefined> {
    assertCommandUuid(datasetId, "datasetId")
    const result = await this.pool.query<{
      dataset_id: string
      generation: string | number
      state: DatasetGenerationInspection["state"]
      row_count: string | number
      seat_count: string | number
      rows_with_ten_seats: string | number
      has_adjacent_four_available: boolean
      active_dataset_count: string | number
    }>(
      `with row_shape as (
         select sr.id, count(s.id) as seat_count
         from ${this.table("seat_row")} sr
         left join ${this.table("seat")} s on s.row_id = sr.id
         where sr.dataset_id = $1
         group by sr.id
       ), available_seats as (
         select
           s.row_id,
           s.ordinal,
           s.ordinal - row_number() over (
             partition by s.row_id order by s.ordinal
           ) as run_key
         from ${this.table("seat")} s
         where s.dataset_id = $1
           and s.lifecycle_state = 'sellable'
           and not exists (
             select 1
             from ${this.table("seat_allocation")} a
             where a.seat_id = s.id and a.state in ('held', 'reserved')
           )
       ), available_runs as (
         select row_id, run_key, count(*) as run_length
         from available_seats
         group by row_id, run_key
       )
       select
         d.id as dataset_id,
         d.generation,
         d.state,
         (select count(*) from ${this.table("seat_row")} where dataset_id = d.id)
           as row_count,
         (select count(*) from ${this.table("seat")} where dataset_id = d.id)
           as seat_count,
         (select count(*) from row_shape where seat_count = 10)
           as rows_with_ten_seats,
         exists (select 1 from available_runs where run_length >= 4)
           as has_adjacent_four_available,
         (select count(*) from ${this.table("prototype_dataset")} where state = 'active')
           as active_dataset_count
       from ${this.table("prototype_dataset")} d
       where d.id = $1`,
      [datasetId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      datasetId: row.dataset_id,
      generation: integer(row.generation),
      state: row.state,
      rowCount: integer(row.row_count),
      seatCount: integer(row.seat_count),
      rowsWithTenSeats: integer(row.rows_with_ten_seats),
      hasAdjacentFourAvailable: row.has_adjacent_four_available,
      activeDatasetCount: integer(row.active_dataset_count),
    }
  }

  async databaseTimeRelation(target: string): Promise<"before" | "after"> {
    const result = await this.pool.query<{ relation: "before" | "after" }>(
      `select case
         when statement_timestamp() < $1::timestamptz then 'before'
         else 'after'
       end as relation`,
      [target],
    )
    return result.rows[0].relation
  }

  async waitForDatabaseTimeAfter(
    target: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this.pool.query<{ passed: boolean }>(
        "select clock_timestamp() > $1::timestamptz as passed",
        [target],
      )
      if (result.rows[0]?.passed) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      "Database clock did not pass the hold expiry before timeout.",
    )
  }

  async inspectEvent(eventId: string): Promise<EventInspection> {
    const counts = await this.pool.query<{
      active_allocation_count: string | number
      reserved_allocation_count: string | number
      order_count: string | number
    }>(
      `select
         (select count(*) from ${this.table("seat_allocation")}
          where event_id = $1 and state in ('held', 'reserved')) as active_allocation_count,
         (select count(*) from ${this.table("seat_allocation")}
          where event_id = $1 and state = 'reserved') as reserved_allocation_count,
         (select count(*) from ${this.table("orders")}
          where event_id = $1) as order_count`,
      [eventId],
    )
    const partial = await this.pool.query<{ count: string | number }>(
      `select count(*) as count
       from (
         select
           h.id,
           h.state,
           o.state as order_state,
           count(a.id) as allocation_count,
           count(a.id) filter (where a.state = 'held') as held_count,
           count(a.id) filter (where a.state = 'reserved') as reserved_count,
           count(a.id) filter (
             where a.state in ('reservation_released', 'released', 'expired')
           ) as terminal_count
         from ${this.table("hold")} h
         left join ${this.table("seat_allocation")} a on a.hold_id = h.id
         left join ${this.table("orders")} o on o.hold_id = h.id
         where h.event_id = $1
         group by h.id, h.state, o.state
         having count(a.id) not between 1 and 4
            or (h.state = 'active' and count(a.id) filter (where a.state = 'held') <> count(a.id))
            or (
              h.state = 'converted'
              and (
                o.state is null
                or (o.state <> 'canceled' and count(a.id) filter (where a.state = 'reserved') <> count(a.id))
                or (o.state = 'canceled' and count(a.id) filter (where a.state = 'reservation_released') <> count(a.id))
              )
            )
            or (h.state in ('released', 'expired') and count(a.id) filter (where a.state in ('released', 'expired')) <> count(a.id))
       ) inconsistent`,
      [eventId],
    )
    const owners = await this.pool.query<{
      seat_id: string
      owner_count: string | number
    }>(
      `select seat_id, count(*) as owner_count
       from ${this.table("seat_allocation")}
       where event_id = $1 and state in ('held', 'reserved')
       group by seat_id
       order by seat_id`,
      [eventId],
    )
    return {
      activeAllocationCount: integer(counts.rows[0].active_allocation_count),
      reservedAllocationCount: integer(
        counts.rows[0].reserved_allocation_count,
      ),
      partialHoldCount: integer(partial.rows[0].count),
      orderCount: integer(counts.rows[0].order_count),
      activeOwnerCountBySeat: Object.fromEntries(
        owners.rows.map((row) => [row.seat_id, integer(row.owner_count)]),
      ),
    }
  }
}
