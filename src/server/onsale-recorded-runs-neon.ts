import { createHash } from "node:crypto"

import { Pool, type PoolClient, type QueryResultRow } from "@neondatabase/serverless"

import {
  parseRecordedRunRefV1,
  parseRecordedRunTraceV1,
  recordedRunLimitationV1,
  summarizeRecordedRunV1,
  type CurrentRecordedRunV1,
  type RecordedRunAttemptV1,
  type RecordedRunEventV1,
  type RecordedRunLimitationCodeV1,
  type RecordedRunPopulationV1,
  type RecordedRunRefV1,
  type RecordedRunTraceV1,
  type RecordedRunsPageV1,
} from "../onsale/contracts/recorded-run-v1"
import { canonicalSha256V1 } from "./onsale-canonical-hash"
import {
  ONSALE_CURRENT_ORDER_COOKIE_NAME_V1,
  createOnsaleOrderPointerV1,
} from "./onsale-checkout-route-runtime"
import {
  INVENTORY_APP_SCHEMA,
  createInventoryAppSchema,
  quoteInventoryAppSchema,
  requireInventoryAppDatabaseUrl,
} from "./inventory-app-schema"
import {
  OnsaleHttpGuardError,
  assertConfiguredOriginV1,
  parseConfiguredOriginsV1,
} from "./onsale-http-guards"
import {
  ONSALE_ALLOWED_ORIGINS_ENV_V1,
  ONSALE_LOCAL_PREVIEW_ORIGIN_V1,
} from "./onsale-route-runtime"
import { classifyOnsaleLocalOriginV1 } from "./onsale-local-origin"
import {
  ONSALE_SESSION_COOKIE_NAME_V1,
  resolveExistingAnonymousSessionV1,
} from "./onsale-session"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const RUN_NAMESPACE = "onsale-recorded-run-v1:"
const EVENT_NAMESPACE = "onsale-recorded-event-v1:"
const EVIDENCE_NAMESPACE = "onsale-recorded-evidence-v1:"
const PAGE_LIMIT = 20
const ONSALE_RECORDED_RUN_SCOPE_ENV_V1 = "ONSALE_RECORDED_RUN_SCOPE"

type QueryClient = Pick<PoolClient, "query">

interface SelectorRow extends QueryResultRow {
  payment_id: string
  recorded_at: string | Date
}

interface HeaderRow extends QueryResultRow {
  payment_id: string
  order_state: string
  item_count: number | string
  amount_minor: number | string
  currency: string
  canonical_state: string
  integrity_state: string
  updated_at: string | Date
  recorded_at: string | Date
  selected_payment_method: string | null
  observed_amount_minor: number | string | null
  observed_currency: string | null
  observed_charged_attempt_count: number | string | null
  ticket_count: number | string
  ticket_issued_at: string | Date | null
}

interface OperationRow extends QueryResultRow {
  payment_id?: string
  id: string
  command_kind: "ensure_checkout" | "reconcile_payment"
  created_at: string | Date
}

interface ObservationRow extends QueryResultRow {
  payment_id?: string
  id: string
  public_ref: string
  source: "create_response" | "retrieve_response" | "verified_webhook"
  received_at: string | Date
}

interface AttemptRow extends QueryResultRow {
  payment_id?: string
  id: string
  canonical_state: string
  observed_connector: string | null
  first_observed_at: string | Date
  attempt_ordinal: number | string | null
  selected_payment_method: string | null
  error_kind: string | null
}

interface LoadedRunV1 {
  readonly trace: RecordedRunTraceV1
  readonly recordedAt: string
}

export class RecordedRunsRepositoryErrorV1 extends Error {
  readonly code: "CURSOR_NOT_FOUND" | "RUN_NOT_FOUND" | "RUN_INTEGRITY"

  constructor(code: RecordedRunsRepositoryErrorV1["code"], message: string) {
    super(message)
    this.name = "RecordedRunsRepositoryErrorV1"
    this.code = code
  }
}

function opaqueAlias(prefix: "run" | "evt" | "ev", namespace: string, value: string): string {
  return `${prefix}_${createHash("sha256")
    .update(namespace, "utf8")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 24)}`
}

export function recordedRunRefFromPaymentIdV1(paymentId: string): RecordedRunRefV1 {
  if (!UUID.test(paymentId)) throw new TypeError("A payment UUID is required")
  return parseRecordedRunRefV1(opaqueAlias("run", RUN_NAMESPACE, paymentId))
}

export function recordedEventRefFromSourceV1(value: string): `evt_${string}` {
  return opaqueAlias("evt", EVENT_NAMESPACE, value) as `evt_${string}`
}

export function recordedEvidenceRefFromSourceV1(value: string): `ev_${string}` {
  return opaqueAlias("ev", EVIDENCE_NAMESPACE, value) as `ev_${string}`
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid retained instant")
  return date.toISOString()
}

function integer(value: number | string | null, label: string): number {
  if (value === null) throw new TypeError(`${label} is missing`)
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${label} is invalid`)
  }
  return parsed
}

function paymentState(value: string): RecordedRunTraceV1["payment"]["state"] {
  switch (value) {
    case "not_created": return "not_created"
    case "requires_payment_method": return "requires_method"
    case "requires_customer_action": return "action_required"
    case "processing": return "processing"
    case "unknown": return "uncertain"
    case "failed": return "exhausted"
    case "succeeded": return "succeeded"
    default: throw new TypeError("Invalid retained payment state")
  }
}

function orderState(value: string): RecordedRunTraceV1["order"]["state"] {
  switch (value) {
    case "awaiting_payment": return "awaiting_payment"
    case "payment_pending": return "payment_pending"
    case "paid": return "paid"
    case "fulfilled": return "fulfilled"
    case "canceled": return "canceled"
    default: throw new TypeError("Invalid retained order state")
  }
}

function attemptOutcome(value: string): RecordedRunAttemptV1["outcome"] {
  switch (value) {
    case "requires_payment_method": return "requires_method"
    case "requires_action": return "action_required"
    case "processing": return "processing"
    case "hard_decline": return "hard_decline"
    case "technical_failure": return "technical_failure"
    case "unknown": return "uncertain"
    case "succeeded": return "succeeded"
    default: throw new TypeError("Invalid retained attempt state")
  }
}

function failureClass(row: AttemptRow): RecordedRunAttemptV1["failureClass"] {
  if (row.canonical_state === "hard_decline") return "hard_decline"
  if (row.canonical_state === "technical_failure") return "technical"
  if (row.error_kind === null) return null
  if (["payment_method", "technical", "configuration", "integration", "unknown"].includes(row.error_kind)) {
    return row.error_kind as NonNullable<RecordedRunAttemptV1["failureClass"]>
  }
  return "unknown"
}

export function selectedRecordedPaymentMethodV1(
  value: string | null,
): RecordedRunTraceV1["payment"]["selectedMethod"] {
  if (value === null) return null
  if (value === "card") return { family: "card", type: null }
  if (value === "credit" || value === "debit") {
    return { family: "card", type: value }
  }
  if (value === "klarna" || value === "affirm" || value === "afterpay_clearpay") {
    return { family: "pay_later", type: value }
  }
  if (value === "paypal" || value === "google_pay" || value === "apple_pay") {
    return { family: "wallet", type: value }
  }
  return { family: null, type: value }
}

export function projectRecordedRunRowsV1(input: {
  readonly header: HeaderRow
  readonly operations: readonly OperationRow[]
  readonly observations: readonly ObservationRow[]
  readonly attempts: readonly AttemptRow[]
  readonly population?: RecordedRunPopulationV1
}): LoadedRunV1 {
  const { header } = input
  const amountDueMinor = integer(header.amount_minor, "amount due")
  const itemCount = integer(header.item_count, "item count")
  const ticketCount = integer(header.ticket_count, "ticket count")
  const attempts = [...input.attempts]
    .sort((left, right) => {
      const leftOrdinal = left.attempt_ordinal === null ? Number.MAX_SAFE_INTEGER : integer(left.attempt_ordinal, "attempt ordinal")
      const rightOrdinal = right.attempt_ordinal === null ? Number.MAX_SAFE_INTEGER : integer(right.attempt_ordinal, "attempt ordinal")
      return leftOrdinal - rightOrdinal || iso(left.first_observed_at).localeCompare(iso(right.first_observed_at)) || left.id.localeCompare(right.id)
    })
    .map((row, index): RecordedRunAttemptV1 => ({
      ordinal: index + 1,
      method: selectedRecordedPaymentMethodV1(row.selected_payment_method ?? header.selected_payment_method),
      connector: row.observed_connector,
      outcome: attemptOutcome(row.canonical_state),
      charged: row.canonical_state === "succeeded",
      failureClass: failureClass(row),
      evidenceRef: recordedEvidenceRefFromSourceV1(`attempt:${row.id}`),
    }))
  const chargeCount = attempts.filter((attempt) => attempt.charged).length
  const observedChargeCount = header.observed_charged_attempt_count === null
    ? chargeCount
    : integer(header.observed_charged_attempt_count, "observed charge count")
  const retainedPaymentState = paymentState(header.canonical_state)
  const observedAmount = header.observed_amount_minor === null
    ? null
    : integer(header.observed_amount_minor, "observed amount")
  const moneyMatches =
    retainedPaymentState !== "succeeded" ||
    (chargeCount === 1 &&
      observedChargeCount === 1 &&
      observedAmount === amountDueMinor &&
      header.observed_currency === header.currency)
  const ticketsMatch =
    (header.order_state === "fulfilled" && ticketCount === itemCount) ||
    (header.order_state !== "fulfilled" && ticketCount === 0)
  const integrityReview =
    header.integrity_state === "review_required" ||
    observedChargeCount !== chargeCount ||
    !moneyMatches ||
    !ticketsMatch
  const mappedPaymentState = integrityReview ? "integrity_review" as const : retainedPaymentState
  const mappedOrderState = integrityReview ? "integrity_review" as const : orderState(header.order_state)
  const amountReceivedMinor = !integrityReview && retainedPaymentState === "succeeded"
    ? amountDueMinor
    : null

  const unsortedEvents: Array<Omit<RecordedRunEventV1, "sequence">> = []
  for (const operation of input.operations) {
    const create = operation.command_kind === "ensure_checkout"
    unsortedEvents.push({
      eventRef: recordedEventRefFromSourceV1(`operation:${operation.id}`),
      occurredAt: iso(operation.created_at),
      kind: create ? "create_requested" : "retrieve_requested",
      edge: create ? "merchant_hyperswitch" : "hyperswitch_retrieve",
      replayable: true,
      attemptOrdinal: null,
      authority: "merchant_server",
      evidenceRef: recordedEvidenceRefFromSourceV1(`operation:${operation.id}`),
    })
  }
  for (const observation of input.observations) {
    unsortedEvents.push({
      eventRef: recordedEventRefFromSourceV1(`observation:${observation.public_ref}`),
      occurredAt: iso(observation.received_at),
      kind: observation.source === "create_response"
        ? "create_observed"
        : observation.source === "retrieve_response"
          ? "retrieve_observed"
          : "webhook_observed",
      edge: null,
      replayable: false,
      attemptOrdinal: null,
      authority: "hyperswitch_observation",
      evidenceRef: recordedEvidenceRefFromSourceV1(`observation:${observation.public_ref}`),
    })
  }
  if (ticketCount > 0 && header.ticket_issued_at !== null) {
    unsortedEvents.push({
      eventRef: recordedEventRefFromSourceV1(`tickets:${header.payment_id}`),
      occurredAt: iso(header.ticket_issued_at),
      kind: "tickets_issued",
      edge: null,
      replayable: false,
      attemptOrdinal: null,
      authority: "merchant_database",
      evidenceRef: recordedEvidenceRefFromSourceV1(`tickets:${header.payment_id}`),
    })
  }
  unsortedEvents.push({
    eventRef: recordedEventRefFromSourceV1(`state:${header.payment_id}`),
    occurredAt: iso(header.updated_at),
    kind: "state_recorded",
    edge: null,
    replayable: false,
    attemptOrdinal: null,
    authority: "merchant_database",
    evidenceRef: recordedEvidenceRefFromSourceV1(`state:${header.payment_id}`),
  })
  const events: RecordedRunEventV1[] = unsortedEvents
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventRef.localeCompare(right.eventRef))
    .map((event, index) => ({ ...event, sequence: index + 1 }))

  const limitationCodes = new Set<RecordedRunLimitationCodeV1>([
    "PRODUCTION_RELIABILITY_NOT_ESTABLISHED",
    "RECORDED_SAMPLE_ONLY",
    "STATIC_FACTS_NOT_CAUSAL",
  ])
  const method = selectedRecordedPaymentMethodV1(header.selected_payment_method)
  if (method === null) limitationCodes.add("METHOD_NOT_RETAINED")
  else if (method.type === null) limitationCodes.add("METHOD_TYPE_NOT_RETAINED")
  if (attempts.some((attempt) => attempt.connector === null)) limitationCodes.add("CONNECTOR_NOT_OBSERVED")
  if (!events.some((event) => event.kind === "webhook_observed")) limitationCodes.add("WEBHOOK_NOT_OBSERVED")
  if (!events.some((event) => event.replayable)) limitationCodes.add("NO_REPLAYABLE_OPERATION")
  if (integrityReview) limitationCodes.add("INTEGRITY_REVIEW")

  const traceWithoutRevision = {
    schema: "onsale.recorded-run.v1" as const,
    runRef: recordedRunRefFromPaymentIdV1(header.payment_id),
    population: input.population ?? "local_browser" as const,
    order: { state: mappedOrderState, itemCount },
    payment: { state: mappedPaymentState, selectedMethod: method },
    money: { currency: header.currency, amountDueMinor, amountReceivedMinor },
    attempts,
    events,
    consequence: {
      chargeCount,
      ticketCount,
      ticketState: integrityReview
        ? "integrity_review" as const
        : ticketCount === itemCount
          ? "issued" as const
          : "not_issued" as const,
    },
    replay: events.some((event) => event.replayable)
      ? { eligible: true as const, basis: "retained_operation_order" as const }
      : { eligible: false as const, basis: "static_only" as const },
    limitations: [...limitationCodes]
      .sort()
      .map(recordedRunLimitationV1),
  }
  const integrityRevision = canonicalSha256V1(traceWithoutRevision)
  const trace = parseRecordedRunTraceV1({ ...traceWithoutRevision, integrityRevision })
  return { trace, recordedAt: iso(header.recorded_at) }
}

export interface RecordedRunsRepositoryV1 {
  list(buyerRef: string | null, cursor?: RecordedRunRefV1 | null): Promise<RecordedRunsPageV1>
  get(buyerRef: string | null, runRef: RecordedRunRefV1): Promise<LoadedRunV1 | undefined>
  current(buyerRef: string, orderId: string): Promise<LoadedRunV1 | undefined>
  close(): Promise<void>
}

export class NeonRecordedRunsRepositoryV1 implements RecordedRunsRepositoryV1 {
  readonly #pool: Pool
  readonly #ownsPool: boolean
  readonly #schema: string

  constructor(options: { readonly databaseUrl: string; readonly pool?: Pool }) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.databaseUrl, max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 })
    this.#ownsPool = options.pool === undefined
    this.#schema = quoteInventoryAppSchema(createInventoryAppSchema(INVENTORY_APP_SCHEMA))
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end() }
  #table(name: string): string {
    if (!/^[a-z_]+$/u.test(name)) throw new TypeError("Unsafe table name")
    return `${this.#schema}."${name}"`
  }

  async #read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query("begin isolation level repeatable read read only")
      await client.query("select set_config('statement_timeout', '8000ms', true)")
      const value = await work(client)
      await client.query("commit")
      return value
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async #loadMany(
    client: QueryClient,
    buyerRef: string | null,
    paymentIds: readonly string[],
  ): Promise<ReadonlyMap<string, LoadedRunV1>> {
    if (paymentIds.length === 0) return new Map()
    const buyerPredicate = buyerRef === null ? "" : "and o.buyer_ref = $2"
    const headerResult = await client.query<HeaderRow>(
      `select pp.id as payment_id, o.state as order_state,
              (select count(*) from ${this.#table("order_item")} oi where oi.order_id = o.id) as item_count,
              pp.amount_minor, pp.currency, pp.canonical_state, pp.integrity_state,
              pp.updated_at,
              greatest(
                pp.updated_at,
                coalesce(fb.issued_at, pp.updated_at),
                coalesce((select max(co.created_at) from ${this.#table("checkout_operation")} co where co.payment_id = pp.id), pp.updated_at),
                coalesce((select max(po2.received_at) from ${this.#table("payment_observation")} po2 where po2.payment_id = pp.id), pp.updated_at)
              ) as recorded_at,
              latest.selected_payment_method, latest.observed_amount_minor,
              latest.observed_currency,
              latest.charged_attempt_count as observed_charged_attempt_count,
              (select count(*) from ${this.#table("ticket")} t where t.order_id = o.id) as ticket_count,
              fb.issued_at as ticket_issued_at
       from ${this.#table("provider_payment")} pp
       join ${this.#table("orders")} o on o.id = pp.order_id
       left join ${this.#table("fulfillment_bundle")} fb on fb.payment_id = pp.id
       left join lateral (
         select po.selected_payment_method, po.observed_amount_minor,
                po.observed_currency, po.charged_attempt_count
         from ${this.#table("payment_observation")} po
         where po.payment_id = pp.id
         order by po.received_at desc, po.id desc limit 1
       ) latest on true
       where pp.id = any($1::uuid[]) ${buyerPredicate}`,
      buyerRef === null ? [paymentIds] : [paymentIds, buyerRef],
    )
    const [operationResult, observationResult, attemptResult] = await Promise.all([
      client.query<OperationRow>(
        `select id, command_kind, created_at, payment_id from ${this.#table("checkout_operation")} where payment_id = any($1::uuid[]) order by payment_id, created_at, id`,
        [paymentIds],
      ),
      client.query<ObservationRow>(
        `select id, public_ref, source, received_at, payment_id from ${this.#table("payment_observation")} where payment_id = any($1::uuid[]) order by payment_id, received_at, id`,
        [paymentIds],
      ),
      client.query<AttemptRow>(
        `select distinct on (pa.id) pa.id, pa.canonical_state, pa.observed_connector,
                pa.first_observed_at, pao.attempt_ordinal,
                po.selected_payment_method, pao.error_kind, pa.payment_id
         from ${this.#table("payment_attempt")} pa
         left join ${this.#table("payment_attempt_observation")} pao on pao.payment_attempt_id = pa.id
         left join ${this.#table("payment_observation")} po on po.id = pao.payment_observation_id
         where pa.payment_id = any($1::uuid[])
         order by pa.id, po.received_at desc nulls last`,
        [paymentIds],
      ),
    ])
    const owner = (row: { readonly payment_id?: string }): string | undefined =>
      row.payment_id ?? (paymentIds.length === 1 ? paymentIds[0] : undefined)
    const loaded = new Map<string, LoadedRunV1>()
    for (const header of headerResult.rows) {
      loaded.set(
        header.payment_id,
        projectRecordedRunRowsV1({
          header,
          operations: operationResult.rows.filter(
            (row) => owner(row) === header.payment_id,
          ),
          observations: observationResult.rows.filter(
            (row) => owner(row) === header.payment_id,
          ),
          attempts: attemptResult.rows.filter(
            (row) => owner(row) === header.payment_id,
          ),
        }),
      )
    }
    return loaded
  }

  async #load(client: QueryClient, buyerRef: string | null, paymentId: string): Promise<LoadedRunV1 | undefined> {
    return (await this.#loadMany(client, buyerRef, [paymentId])).get(paymentId)
  }

  async get(buyerRef: string | null, runRef: RecordedRunRefV1): Promise<LoadedRunV1 | undefined> {
    return this.#read(async (client) => {
      const buyerPredicate = buyerRef === null ? "" : "where o.buyer_ref = $1"
      const candidates = await client.query<{ payment_id: string }>(
        `select pp.id as payment_id from ${this.#table("provider_payment")} pp
         join ${this.#table("orders")} o on o.id = pp.order_id
         ${buyerPredicate}`,
        buyerRef === null ? [] : [buyerRef],
      )
      const paymentId = candidates.rows.find(
        (row) => recordedRunRefFromPaymentIdV1(row.payment_id) === runRef,
      )?.payment_id
      return paymentId ? this.#load(client, buyerRef, paymentId) : undefined
    })
  }

  async current(buyerRef: string, orderId: string): Promise<LoadedRunV1 | undefined> {
    if (!UUID.test(orderId)) return undefined
    return this.#read(async (client) => {
      const result = await client.query<{ payment_id: string }>(
        `select pp.id as payment_id from ${this.#table("provider_payment")} pp
         join ${this.#table("orders")} o on o.id = pp.order_id
         where o.buyer_ref = $1 and o.id = $2`,
        [buyerRef, orderId],
      )
      const paymentId = result.rows[0]?.payment_id
      return paymentId ? this.#load(client, buyerRef, paymentId) : undefined
    })
  }

  async list(buyerRef: string | null, cursor: RecordedRunRefV1 | null = null): Promise<RecordedRunsPageV1> {
    return this.#read(async (client) => {
      const buyerPredicate = buyerRef === null ? "" : "where o.buyer_ref = $1"
      const selectors = await client.query<SelectorRow>(
        `select pp.id as payment_id,
                greatest(
                  pp.updated_at,
                  coalesce(fb.issued_at, pp.updated_at),
                  coalesce((select max(co.created_at) from ${this.#table("checkout_operation")} co where co.payment_id = pp.id), pp.updated_at),
                  coalesce((select max(po.received_at) from ${this.#table("payment_observation")} po where po.payment_id = pp.id), pp.updated_at)
                ) as recorded_at
         from ${this.#table("provider_payment")} pp
         join ${this.#table("orders")} o on o.id = pp.order_id
         left join ${this.#table("fulfillment_bundle")} fb on fb.payment_id = pp.id
         ${buyerPredicate}
         order by recorded_at desc, pp.id desc`,
        buyerRef === null ? [] : [buyerRef],
      )
      const cursorIndex = cursor === null
        ? -1
        : selectors.rows.findIndex(
            (row) => recordedRunRefFromPaymentIdV1(row.payment_id) === cursor,
          )
      if (cursor !== null && cursorIndex < 0) {
        throw new RecordedRunsRepositoryErrorV1("CURSOR_NOT_FOUND", "The run cursor was not found")
      }
      const pageRows = selectors.rows.slice(cursorIndex + 1, cursorIndex + 1 + PAGE_LIMIT + 1)
      const visible = pageRows.slice(0, PAGE_LIMIT)
      const loaded = await this.#loadMany(
        client,
        buyerRef,
        visible.map((row) => row.payment_id),
      )
      if (loaded.size !== visible.length) throw new RecordedRunsRepositoryErrorV1("RUN_INTEGRITY", "A retained run disappeared during a read snapshot")
      const items = visible.map((row) => {
        const item = loaded.get(row.payment_id)!
        return summarizeRecordedRunV1(item.trace, item.recordedAt)
      })
      return {
        schema: "onsale.recorded-runs.v1",
        items,
        page: {
          limit: PAGE_LIMIT,
          nextCursor: pageRows.length > PAGE_LIMIT
            ? recordedRunRefFromPaymentIdV1(visible.at(-1)!.payment_id)
            : null,
        },
      }
    })
  }
}

let productionRepository: NeonRecordedRunsRepositoryV1 | undefined
function repositoryFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): NeonRecordedRunsRepositoryV1 {
  productionRepository ??= new NeonRecordedRunsRepositoryV1({ databaseUrl: requireInventoryAppDatabaseUrl(environment) })
  return productionRepository
}

function cookieValue(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1))
  return values.length === 1 ? values[0] : undefined
}

function requestAuthority(request: Request): {
  readonly ledgerBuyerRef: string | null
  readonly sessionBuyerRef: string | null
  readonly localOrigin: string
} {
  const source = process.env[ONSALE_ALLOWED_ORIGINS_ENV_V1]
  const configured = parseConfiguredOriginsV1(source === undefined ? [ONSALE_LOCAL_PREVIEW_ORIGIN_V1] : source.split(","))
  if (configured.size !== 1) throw new OnsaleHttpGuardError("request_origin_denied")
  const localOrigin = [...configured][0]
  if (!localOrigin || classifyOnsaleLocalOriginV1(localOrigin) === null) {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  const suppliedOrigin = request.headers.get("origin")
  if (suppliedOrigin !== null) assertConfiguredOriginV1(suppliedOrigin, configured)
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") throw new OnsaleHttpGuardError("request_origin_denied")
  const session = resolveExistingAnonymousSessionV1(cookieValue(request, ONSALE_SESSION_COOKIE_NAME_V1))
  const sessionBuyerRef = session?.session.buyerRef() ?? null
  const scope = process.env[ONSALE_RECORDED_RUN_SCOPE_ENV_V1]?.trim()
  if (scope !== undefined && scope !== "" && scope !== "local_review") {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  if (scope !== "local_review" && sessionBuyerRef === null) {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  return {
    ledgerBuyerRef: scope === "local_review" ? null : sessionBuyerRef,
    sessionBuyerRef,
    localOrigin,
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      Vary: "Cookie, Origin",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}

function errorResponse(error: unknown): Response {
  let status = 503
  let code = "RUNS_UNAVAILABLE"
  let message = "The recorded ledger is unavailable."
  if (error instanceof OnsaleHttpGuardError) {
    status = 403; code = "REQUEST_ORIGIN_DENIED"; message = "The request origin is not allowed."
  } else if (
    error instanceof RecordedRunsRepositoryErrorV1 &&
    (error.code === "CURSOR_NOT_FOUND" || error.code === "RUN_NOT_FOUND")
  ) {
    status = 404; code = "RUN_NOT_FOUND"; message = "The retained run was not found."
  } else if (error instanceof RecordedRunsRepositoryErrorV1 && error.code === "RUN_INTEGRITY") {
    status = 500; code = "RUN_INTEGRITY_ERROR"; message = "The retained run failed its integrity check."
  } else if (error instanceof TypeError) {
    status = 400; code = "INVALID_REQUEST"; message = "The recorded-run request is invalid."
  }
  return response({ schema: "onsale.recorded-runs-error.v1", ok: false, error: { code, message } }, status)
}

export async function handleRecordedRunsListGetV1(
  request: Request,
  repository?: RecordedRunsRepositoryV1,
): Promise<Response> {
  try {
    const { ledgerBuyerRef } = requestAuthority(request)
    const url = new URL(request.url)
    const limits = url.searchParams.getAll("limit")
    const cursors = url.searchParams.getAll("cursor")
    if (
      [...url.searchParams.keys()].some((key) => key !== "limit" && key !== "cursor") ||
      limits.length > 1 ||
      cursors.length > 1 ||
      (limits[0] ?? "20") !== "20"
    ) throw new TypeError("Invalid query")
    const cursorValue = cursors[0] ?? null
    const cursor = cursorValue === null ? null : parseRecordedRunRefV1(cursorValue, "$.cursor")
    return response(await (repository ?? repositoryFromEnvironment()).list(ledgerBuyerRef, cursor))
  } catch (error) { return errorResponse(error) }
}

export async function handleRecordedRunDetailGetV1(
  request: Request,
  runRefCandidate: string,
  repository?: RecordedRunsRepositoryV1,
): Promise<Response> {
  try {
    const { ledgerBuyerRef } = requestAuthority(request)
    if (new URL(request.url).search !== "") throw new TypeError("Invalid query")
    const runRef = parseRecordedRunRefV1(runRefCandidate)
    const run = await (repository ?? repositoryFromEnvironment()).get(ledgerBuyerRef, runRef)
    return run ? response(run.trace) : errorResponse(new RecordedRunsRepositoryErrorV1("RUN_NOT_FOUND", "Run not found"))
  } catch (error) { return errorResponse(error) }
}

export async function handleCurrentRecordedRunGetV1(
  request: Request,
  repository?: RecordedRunsRepositoryV1,
): Promise<Response> {
  try {
    const { sessionBuyerRef } = requestAuthority(request)
    if (new URL(request.url).search !== "") throw new TypeError("Invalid query")
    const orderCandidate = cookieValue(request, ONSALE_CURRENT_ORDER_COOKIE_NAME_V1)
    const emptyCurrent: CurrentRecordedRunV1 = {
      schema: "onsale.current-recorded-run.v1",
      runRef: null,
      integrityRevision: null,
      terminal: false,
    }
    if (sessionBuyerRef === null) return response(emptyCurrent)
    if (!orderCandidate) return response(emptyCurrent)
    const orderRef = createOnsaleOrderPointerV1(orderCandidate).orderRef()
    const run = await (repository ?? repositoryFromEnvironment()).current(sessionBuyerRef, orderRef)
    if (!run) return response(emptyCurrent)
    const terminal = ["fulfilled", "canceled", "integrity_review"].includes(run.trace.order.state) || ["succeeded", "exhausted", "integrity_review"].includes(run.trace.payment.state)
    const current: CurrentRecordedRunV1 = {
      schema: "onsale.current-recorded-run.v1",
      runRef: run.trace.runRef,
      integrityRevision: run.trace.integrityRevision,
      terminal,
    }
    return response(current)
  } catch (error) { return errorResponse(error) }
}
