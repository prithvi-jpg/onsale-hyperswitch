const RUN_REF = /^run_[0-9a-f]{24}$/u
const EVENT_REF = /^evt_[0-9a-f]{24}$/u
const EVIDENCE_REF = /^ev_[0-9a-f]{24}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const CURRENCY = /^[A-Z]{3}$/u
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u
const MAX_MONEY_MINOR = 9_000_000_000_000

export const RECORDED_RUN_POPULATIONS_V1 = [
  "local_browser",
  "recorded_hosted",
] as const
export type RecordedRunPopulationV1 =
  (typeof RECORDED_RUN_POPULATIONS_V1)[number]

export const RECORDED_RUN_PAYMENT_STATES_V1 = [
  "not_created",
  "requires_method",
  "action_required",
  "processing",
  "uncertain",
  "exhausted",
  "succeeded",
  "integrity_review",
] as const
export type RecordedRunPaymentStateV1 =
  (typeof RECORDED_RUN_PAYMENT_STATES_V1)[number]

export const RECORDED_RUN_ORDER_STATES_V1 = [
  "awaiting_payment",
  "payment_pending",
  "paid",
  "fulfilled",
  "canceled",
  "integrity_review",
] as const
export type RecordedRunOrderStateV1 =
  (typeof RECORDED_RUN_ORDER_STATES_V1)[number]

export const RECORDED_RUN_ATTEMPT_OUTCOMES_V1 = [
  "requires_method",
  "action_required",
  "processing",
  "hard_decline",
  "technical_failure",
  "uncertain",
  "succeeded",
] as const
export type RecordedRunAttemptOutcomeV1 =
  (typeof RECORDED_RUN_ATTEMPT_OUTCOMES_V1)[number]

export const RECORDED_RUN_EDGES_V1 = [
  "buyer_merchant",
  "merchant_hyperswitch",
  "hyperswitch_connector",
  "connector_hyperswitch",
  "hyperswitch_retrieve",
  "reconcile_merchant",
  "merchant_tickets",
] as const
export type RecordedRunEdgeV1 = (typeof RECORDED_RUN_EDGES_V1)[number]

export const RECORDED_RUN_EVENT_KINDS_V1 = [
  "create_requested",
  "retrieve_requested",
  "create_observed",
  "retrieve_observed",
  "webhook_observed",
  "tickets_issued",
  "state_recorded",
] as const
export type RecordedRunEventKindV1 =
  (typeof RECORDED_RUN_EVENT_KINDS_V1)[number]

export const RECORDED_RUN_LIMITATION_CODES_V1 = [
  "CONNECTOR_NOT_OBSERVED",
  "INTEGRITY_REVIEW",
  "METHOD_NOT_RETAINED",
  "METHOD_TYPE_NOT_RETAINED",
  "NO_REPLAYABLE_OPERATION",
  "PRODUCTION_RELIABILITY_NOT_ESTABLISHED",
  "RECORDED_SAMPLE_ONLY",
  "STATIC_FACTS_NOT_CAUSAL",
  "WEBHOOK_NOT_OBSERVED",
] as const
export type RecordedRunLimitationCodeV1 =
  (typeof RECORDED_RUN_LIMITATION_CODES_V1)[number]

const LIMITATION_MESSAGES: Readonly<
  Record<RecordedRunLimitationCodeV1, string>
> = {
  CONNECTOR_NOT_OBSERVED:
    "At least one retained attempt has no observed connector.",
  INTEGRITY_REVIEW:
    "The retained money or fulfillment tuple requires integrity review.",
  METHOD_NOT_RETAINED: "The selected payment method was not retained.",
  METHOD_TYPE_NOT_RETAINED:
    "The payment-method family is known, but its subtype was not retained.",
  NO_REPLAYABLE_OPERATION:
    "No retained create or retrieve operation can authorize causal replay.",
  PRODUCTION_RELIABILITY_NOT_ESTABLISHED:
    "This retained run does not establish production reliability.",
  RECORDED_SAMPLE_ONLY:
    "This retained sample does not establish a population success rate.",
  STATIC_FACTS_NOT_CAUSAL:
    "Unlinked observations remain static facts rather than invented causal steps.",
  WEBHOOK_NOT_OBSERVED:
    "No verified webhook delivery is retained for this run.",
}

export type RecordedRunRefV1 = `run_${string}`
export type RecordedRunEventRefV1 = `evt_${string}`
export type RecordedRunEvidenceRefV1 = `ev_${string}`
export type RecordedRunIntegrityRevisionV1 = `sha256:${string}`

export interface RecordedRunPaymentMethodV1 {
  readonly family: string | null
  readonly type: string | null
}

export interface RecordedRunAttemptV1 {
  readonly ordinal: number
  readonly method: RecordedRunPaymentMethodV1 | null
  readonly connector: string | null
  readonly outcome: RecordedRunAttemptOutcomeV1
  readonly charged: boolean
  readonly failureClass:
    | "hard_decline"
    | "technical"
    | "payment_method"
    | "configuration"
    | "integration"
    | "unknown"
    | null
  readonly evidenceRef: RecordedRunEvidenceRefV1
}

export interface RecordedRunEventV1 {
  readonly eventRef: RecordedRunEventRefV1
  readonly sequence: number
  readonly occurredAt: string
  readonly kind: RecordedRunEventKindV1
  readonly edge: RecordedRunEdgeV1 | null
  readonly replayable: boolean
  readonly attemptOrdinal: number | null
  readonly authority:
    | "merchant_server"
    | "hyperswitch_observation"
    | "merchant_database"
  readonly evidenceRef: RecordedRunEvidenceRefV1
}

export interface RecordedRunLimitationV1 {
  readonly code: RecordedRunLimitationCodeV1
  readonly message: string
}

export interface RecordedRunTraceV1 {
  readonly schema: "onsale.recorded-run.v1"
  readonly runRef: RecordedRunRefV1
  readonly population: RecordedRunPopulationV1
  readonly integrityRevision: RecordedRunIntegrityRevisionV1
  readonly order: {
    readonly state: RecordedRunOrderStateV1
    readonly itemCount: number
  }
  readonly payment: {
    readonly state: RecordedRunPaymentStateV1
    readonly selectedMethod: RecordedRunPaymentMethodV1 | null
  }
  readonly money: {
    readonly currency: string
    readonly amountDueMinor: number
    readonly amountReceivedMinor: number | null
  }
  readonly attempts: readonly RecordedRunAttemptV1[]
  readonly events: readonly RecordedRunEventV1[]
  readonly consequence: {
    readonly chargeCount: number
    readonly ticketCount: number
    readonly ticketState: "not_issued" | "issued" | "integrity_review"
  }
  readonly replay:
    | { readonly eligible: true; readonly basis: "retained_operation_order" }
    | { readonly eligible: false; readonly basis: "static_only" }
  readonly limitations: readonly RecordedRunLimitationV1[]
}

export type RecordedRunOutcomeV1 =
  | "fulfilled"
  | "action_required"
  | "declined"
  | "recoverable_failure"
  | "processing"
  | "uncertain"
  | "integrity_review"

export interface RecordedRunSummaryV1 {
  readonly runRef: RecordedRunRefV1
  readonly population: RecordedRunPopulationV1
  readonly integrityRevision: RecordedRunIntegrityRevisionV1
  readonly recordedAt: string
  readonly orderState: RecordedRunOrderStateV1
  readonly paymentState: RecordedRunPaymentStateV1
  readonly outcome: RecordedRunOutcomeV1
  readonly itemCount: number
  readonly currency: string
  readonly amountDueMinor: number
  readonly amountReceivedMinor: number | null
  readonly selectedMethod: RecordedRunPaymentMethodV1 | null
  readonly observedConnectors: readonly string[]
  readonly attemptCount: number
  readonly chargeCount: number
  readonly ticketCount: number
  readonly ticketState: "not_issued" | "issued" | "integrity_review"
  readonly replayEligible: boolean
  readonly limitations: readonly RecordedRunLimitationCodeV1[]
}

export interface RecordedRunsPageV1 {
  readonly schema: "onsale.recorded-runs.v1"
  readonly items: readonly RecordedRunSummaryV1[]
  readonly page: {
    readonly limit: number
    readonly nextCursor: RecordedRunRefV1 | null
  }
}

export interface CurrentRecordedRunV1 {
  readonly schema: "onsale.current-recorded-run.v1"
  readonly runRef: RecordedRunRefV1 | null
  readonly integrityRevision: RecordedRunIntegrityRevisionV1 | null
  readonly terminal: boolean
}

export class RecordedRunContractErrorV1 extends TypeError {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "RecordedRunContractErrorV1"
    this.path = path
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordedRunContractErrorV1(path, "expected an object")
  }
  return value as Record<string, unknown>
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.join("\0") !== expected.join("\0")) {
    throw new RecordedRunContractErrorV1(path, "unexpected or missing field")
  }
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new RecordedRunContractErrorV1(path, "expected a bounded array")
  }
  return value
}

function string(value: unknown, path: string, max = 160): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RecordedRunContractErrorV1(path, "expected a bounded string")
  }
  return value
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RecordedRunContractErrorV1(path, "expected a bounded integer")
  }
  return value as number
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RecordedRunContractErrorV1(path, "unexpected enum value")
  }
  return value as T[number]
}

export function parseRecordedRunRefV1(
  value: unknown,
  path = "$.runRef",
): RecordedRunRefV1 {
  if (typeof value !== "string" || !RUN_REF.test(value)) {
    throw new RecordedRunContractErrorV1(path, "expected an opaque run alias")
  }
  return value as RecordedRunRefV1
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new RecordedRunContractErrorV1(path, "expected an ISO instant")
  }
  return value
}

function tokenOrNull(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new RecordedRunContractErrorV1(path, "expected a safe token or null")
  }
  return value
}

function paymentMethod(
  value: unknown,
  path: string,
): RecordedRunPaymentMethodV1 | null {
  if (value === null) return null
  const source = record(value, path)
  exact(source, ["family", "type"], path)
  const family = tokenOrNull(source.family, `${path}.family`)
  const type = tokenOrNull(source.type, `${path}.type`)
  if (family === null && type === null) {
    throw new RecordedRunContractErrorV1(path, "method family or type is required")
  }
  return { family, type }
}

export function recordedRunLimitationV1(
  code: RecordedRunLimitationCodeV1,
): RecordedRunLimitationV1 {
  return Object.freeze({ code, message: LIMITATION_MESSAGES[code] })
}

function limitation(value: unknown, path: string): RecordedRunLimitationV1 {
  const source = record(value, path)
  exact(source, ["code", "message"], path)
  const code = enumeration(
    source.code,
    RECORDED_RUN_LIMITATION_CODES_V1,
    `${path}.code`,
  )
  if (source.message !== LIMITATION_MESSAGES[code]) {
    throw new RecordedRunContractErrorV1(
      `${path}.message`,
      "limitation copy is contract-owned",
    )
  }
  return recordedRunLimitationV1(code)
}

function attempt(value: unknown, index: number): RecordedRunAttemptV1 {
  const path = `$.attempts[${index}]`
  const source = record(value, path)
  exact(
    source,
    [
      "ordinal",
      "method",
      "connector",
      "outcome",
      "charged",
      "failureClass",
      "evidenceRef",
    ],
    path,
  )
  const evidenceRef = string(source.evidenceRef, `${path}.evidenceRef`)
  if (!EVIDENCE_REF.test(evidenceRef)) {
    throw new RecordedRunContractErrorV1(
      `${path}.evidenceRef`,
      "expected a sanitized evidence alias",
    )
  }
  return {
    ordinal: integer(source.ordinal, `${path}.ordinal`, 1, 32),
    method: paymentMethod(source.method, `${path}.method`),
    connector: tokenOrNull(source.connector, `${path}.connector`),
    outcome: enumeration(
      source.outcome,
      RECORDED_RUN_ATTEMPT_OUTCOMES_V1,
      `${path}.outcome`,
    ),
    charged: source.charged === true,
    failureClass:
      source.failureClass === null
        ? null
        : enumeration(
            source.failureClass,
            [
              "hard_decline",
              "technical",
              "payment_method",
              "configuration",
              "integration",
              "unknown",
            ] as const,
            `${path}.failureClass`,
          ),
    evidenceRef: evidenceRef as RecordedRunEvidenceRefV1,
  }
}

function event(value: unknown, index: number): RecordedRunEventV1 {
  const path = `$.events[${index}]`
  const source = record(value, path)
  exact(
    source,
    [
      "eventRef",
      "sequence",
      "occurredAt",
      "kind",
      "edge",
      "replayable",
      "attemptOrdinal",
      "authority",
      "evidenceRef",
    ],
    path,
  )
  const eventRef = string(source.eventRef, `${path}.eventRef`)
  const evidenceRef = string(source.evidenceRef, `${path}.evidenceRef`)
  if (!EVENT_REF.test(eventRef) || !EVIDENCE_REF.test(evidenceRef)) {
    throw new RecordedRunContractErrorV1(path, "expected sanitized aliases")
  }
  if (typeof source.replayable !== "boolean") {
    throw new RecordedRunContractErrorV1(
      `${path}.replayable`,
      "expected a boolean",
    )
  }
  const kind = enumeration(
    source.kind,
    RECORDED_RUN_EVENT_KINDS_V1,
    `${path}.kind`,
  )
  const edge =
    source.edge === null
      ? null
      : enumeration(source.edge, RECORDED_RUN_EDGES_V1, `${path}.edge`)
  if (
    source.replayable &&
    !(
      (kind === "create_requested" &&
        (edge === "buyer_merchant" || edge === "merchant_hyperswitch")) ||
      (kind === "retrieve_requested" && edge === "hyperswitch_retrieve")
    )
  ) {
    throw new RecordedRunContractErrorV1(
      path,
      "only retained create or retrieve operations may authorize replay",
    )
  }
  if (!source.replayable && edge !== null) {
    throw new RecordedRunContractErrorV1(
      `${path}.edge`,
      "static facts cannot claim a causal edge",
    )
  }
  return {
    eventRef: eventRef as RecordedRunEventRefV1,
    sequence: integer(source.sequence, `${path}.sequence`, 1, 256),
    occurredAt: instant(source.occurredAt, `${path}.occurredAt`),
    kind,
    edge,
    replayable: source.replayable,
    attemptOrdinal:
      source.attemptOrdinal === null
        ? null
        : integer(source.attemptOrdinal, `${path}.attemptOrdinal`, 1, 32),
    authority: enumeration(
      source.authority,
      [
        "merchant_server",
        "hyperswitch_observation",
        "merchant_database",
      ] as const,
      `${path}.authority`,
    ),
    evidenceRef: evidenceRef as RecordedRunEvidenceRefV1,
  }
}

function expectedLimitations(trace: {
  readonly population: RecordedRunPopulationV1
  readonly payment: RecordedRunTraceV1["payment"]
  readonly attempts: readonly RecordedRunAttemptV1[]
  readonly events: readonly RecordedRunEventV1[]
  readonly integrityReview: boolean
}): ReadonlySet<RecordedRunLimitationCodeV1> {
  const result = new Set<RecordedRunLimitationCodeV1>()
  if (trace.payment.selectedMethod === null) result.add("METHOD_NOT_RETAINED")
  else if (trace.payment.selectedMethod.type === null) {
    result.add("METHOD_TYPE_NOT_RETAINED")
  }
  if (trace.attempts.some((item) => item.connector === null)) {
    result.add("CONNECTOR_NOT_OBSERVED")
  }
  if (trace.events.some((item) => !item.replayable)) {
    result.add("STATIC_FACTS_NOT_CAUSAL")
  }
  if (!trace.events.some((item) => item.replayable)) {
    result.add("NO_REPLAYABLE_OPERATION")
  }
  if (trace.integrityReview) result.add("INTEGRITY_REVIEW")
  if (trace.population === "recorded_hosted") {
    result.add("RECORDED_SAMPLE_ONLY")
  }
  return result
}

export function parseRecordedRunTraceV1(value: unknown): RecordedRunTraceV1 {
  const source = record(value, "$")
  exact(
    source,
    [
      "schema",
      "runRef",
      "population",
      "integrityRevision",
      "order",
      "payment",
      "money",
      "attempts",
      "events",
      "consequence",
      "replay",
      "limitations",
    ],
    "$",
  )
  if (source.schema !== "onsale.recorded-run.v1") {
    throw new RecordedRunContractErrorV1("$.schema", "unexpected schema")
  }
  const runRef = parseRecordedRunRefV1(source.runRef)
  const population = enumeration(
    source.population,
    RECORDED_RUN_POPULATIONS_V1,
    "$.population",
  )
  const revision = string(source.integrityRevision, "$.integrityRevision")
  if (!SHA256.test(revision)) {
    throw new RecordedRunContractErrorV1(
      "$.integrityRevision",
      "expected a SHA-256 revision",
    )
  }

  const orderSource = record(source.order, "$.order")
  exact(orderSource, ["state", "itemCount"], "$.order")
  const paymentSource = record(source.payment, "$.payment")
  exact(paymentSource, ["state", "selectedMethod"], "$.payment")
  const moneySource = record(source.money, "$.money")
  exact(
    moneySource,
    ["currency", "amountDueMinor", "amountReceivedMinor"],
    "$.money",
  )
  const consequenceSource = record(source.consequence, "$.consequence")
  exact(
    consequenceSource,
    ["chargeCount", "ticketCount", "ticketState"],
    "$.consequence",
  )
  const replaySource = record(source.replay, "$.replay")
  exact(replaySource, ["eligible", "basis"], "$.replay")

  const attempts = array(source.attempts, "$.attempts", 32).map(attempt)
  const events = array(source.events, "$.events", 256).map(event)
  attempts.forEach((item, index) => {
    if (item.ordinal !== index + 1) {
      throw new RecordedRunContractErrorV1(
        "$.attempts",
        "attempt ordinals must be gapless",
      )
    }
  })
  events.forEach((item, index) => {
    if (item.sequence !== index + 1) {
      throw new RecordedRunContractErrorV1(
        "$.events",
        "event sequence must be gapless",
      )
    }
  })

  const orderState = enumeration(
    orderSource.state,
    RECORDED_RUN_ORDER_STATES_V1,
    "$.order.state",
  )
  const paymentState = enumeration(
    paymentSource.state,
    RECORDED_RUN_PAYMENT_STATES_V1,
    "$.payment.state",
  )
  const currency = string(moneySource.currency, "$.money.currency")
  if (!CURRENCY.test(currency)) {
    throw new RecordedRunContractErrorV1(
      "$.money.currency",
      "expected an ISO currency",
    )
  }
  const amountDueMinor = integer(
    moneySource.amountDueMinor,
    "$.money.amountDueMinor",
    1,
    MAX_MONEY_MINOR,
  )
  const amountReceivedMinor = moneySource.amountReceivedMinor === null
    ? null
    : integer(
        moneySource.amountReceivedMinor,
        "$.money.amountReceivedMinor",
        0,
        MAX_MONEY_MINOR,
      )
  const chargeCount = integer(
    consequenceSource.chargeCount,
    "$.consequence.chargeCount",
    0,
    32,
  )
  const ticketCount = integer(
    consequenceSource.ticketCount,
    "$.consequence.ticketCount",
    0,
    4,
  )
  const itemCount = integer(orderSource.itemCount, "$.order.itemCount", 1, 4)
  const ticketState = enumeration(
    consequenceSource.ticketState,
    ["not_issued", "issued", "integrity_review"] as const,
    "$.consequence.ticketState",
  )
  const integrityReview =
    orderState === "integrity_review" ||
    paymentState === "integrity_review" ||
    ticketState === "integrity_review"

  if (
    !integrityReview &&
    ((paymentState === "succeeded" &&
      (chargeCount !== 1 || amountReceivedMinor !== amountDueMinor)) ||
      (paymentState !== "succeeded" &&
        (chargeCount !== 0 || amountReceivedMinor !== null)) ||
      (orderState === "fulfilled" &&
        (ticketState !== "issued" || ticketCount !== itemCount)) ||
      (orderState !== "fulfilled" &&
        (ticketState === "issued" || ticketCount !== 0)))
  ) {
    throw new RecordedRunContractErrorV1(
      "$.consequence",
      "money and fulfillment facts are inconsistent",
    )
  }
  if (attempts.filter((item) => item.charged).length !== chargeCount) {
    throw new RecordedRunContractErrorV1(
      "$.attempts",
      "charged attempts must match the consequence",
    )
  }

  const eligible = events.some((item) => item.replayable)
  if (
    replaySource.eligible !== eligible ||
    replaySource.basis !==
      (eligible ? "retained_operation_order" : "static_only")
  ) {
    throw new RecordedRunContractErrorV1(
      "$.replay",
      "replay must derive from retained operation ordering",
    )
  }

  const limitations = array(
    source.limitations,
    "$.limitations",
    RECORDED_RUN_LIMITATION_CODES_V1.length,
  )
    .map((item, index) => limitation(item, `$.limitations[${index}]`))
    .sort((left, right) => left.code.localeCompare(right.code))
  const expected = expectedLimitations({
    population,
    payment: {
      state: paymentState,
      selectedMethod: paymentMethod(
        paymentSource.selectedMethod,
        "$.payment.selectedMethod",
      ),
    },
    attempts,
    events,
    integrityReview,
  })
  const actual = new Set(limitations.map((item) => item.code))
  for (const code of expected) {
    if (!actual.has(code)) {
      throw new RecordedRunContractErrorV1(
        "$.limitations",
        `required limitation ${code} is missing`,
      )
    }
  }
  const permitted = new Set(expected)
  permitted.add("PRODUCTION_RELIABILITY_NOT_ESTABLISHED")
  permitted.add("RECORDED_SAMPLE_ONLY")
  if (!events.some((item) => item.kind === "webhook_observed")) {
    permitted.add("WEBHOOK_NOT_OBSERVED")
  }
  for (const code of actual) {
    if (!permitted.has(code)) {
      throw new RecordedRunContractErrorV1(
        "$.limitations",
        `unexpected limitation ${code}`,
      )
    }
  }

  return {
    schema: "onsale.recorded-run.v1",
    runRef,
    population,
    integrityRevision: revision as RecordedRunIntegrityRevisionV1,
    order: { state: orderState, itemCount },
    payment: {
      state: paymentState,
      selectedMethod: paymentMethod(
        paymentSource.selectedMethod,
        "$.payment.selectedMethod",
      ),
    },
    money: { currency, amountDueMinor, amountReceivedMinor },
    attempts,
    events,
    consequence: { chargeCount, ticketCount, ticketState },
    replay: eligible
      ? { eligible: true, basis: "retained_operation_order" }
      : { eligible: false, basis: "static_only" },
    limitations,
  }
}

function outcome(trace: RecordedRunTraceV1): RecordedRunOutcomeV1 {
  if (
    trace.order.state === "integrity_review" ||
    trace.payment.state === "integrity_review"
  ) return "integrity_review"
  if (trace.order.state === "fulfilled") return "fulfilled"
  if (trace.payment.state === "action_required") return "action_required"
  if (trace.payment.state === "exhausted") {
    return trace.attempts.some((item) => item.outcome === "hard_decline")
      ? "declined"
      : "recoverable_failure"
  }
  if (trace.payment.state === "uncertain") return "uncertain"
  return "processing"
}

export function summarizeRecordedRunV1(
  trace: RecordedRunTraceV1,
  recordedAt: string,
): RecordedRunSummaryV1 {
  return {
    runRef: trace.runRef,
    population: trace.population,
    integrityRevision: trace.integrityRevision,
    recordedAt: instant(recordedAt, "$.recordedAt"),
    orderState: trace.order.state,
    paymentState: trace.payment.state,
    outcome: outcome(trace),
    itemCount: trace.order.itemCount,
    currency: trace.money.currency,
    amountDueMinor: trace.money.amountDueMinor,
    amountReceivedMinor: trace.money.amountReceivedMinor,
    selectedMethod: trace.payment.selectedMethod,
    observedConnectors: [
      ...new Set(
        trace.attempts.flatMap((item) =>
          item.connector === null ? [] : [item.connector],
        ),
      ),
    ].sort(),
    attemptCount: trace.attempts.length,
    chargeCount: trace.consequence.chargeCount,
    ticketCount: trace.consequence.ticketCount,
    ticketState: trace.consequence.ticketState,
    replayEligible: trace.replay.eligible,
    limitations: trace.limitations.map((item) => item.code).sort(),
  }
}

function parseSummary(value: unknown, path: string): RecordedRunSummaryV1 {
  const source = record(value, path)
  exact(
    source,
    [
      "runRef",
      "population",
      "integrityRevision",
      "recordedAt",
      "orderState",
      "paymentState",
      "outcome",
      "itemCount",
      "currency",
      "amountDueMinor",
      "amountReceivedMinor",
      "selectedMethod",
      "observedConnectors",
      "attemptCount",
      "chargeCount",
      "ticketCount",
      "ticketState",
      "replayEligible",
      "limitations",
    ],
    path,
  )
  const revision = string(source.integrityRevision, `${path}.integrityRevision`)
  if (!SHA256.test(revision)) {
    throw new RecordedRunContractErrorV1(
      `${path}.integrityRevision`,
      "expected a SHA-256 revision",
    )
  }
  const currency = string(source.currency, `${path}.currency`)
  if (!CURRENCY.test(currency)) {
    throw new RecordedRunContractErrorV1(`${path}.currency`, "invalid currency")
  }
  const observedConnectors = array(
    source.observedConnectors,
    `${path}.observedConnectors`,
    32,
  ).map((item, index) => {
    const value = tokenOrNull(item, `${path}.observedConnectors[${index}]`)
    if (value === null) {
      throw new RecordedRunContractErrorV1(
        `${path}.observedConnectors[${index}]`,
        "connector cannot be null",
      )
    }
    return value
  })
  const limitations = array(
    source.limitations,
    `${path}.limitations`,
    RECORDED_RUN_LIMITATION_CODES_V1.length,
  ).map((item, index) =>
    enumeration(
      item,
      RECORDED_RUN_LIMITATION_CODES_V1,
      `${path}.limitations[${index}]`,
    ),
  )
  if (typeof source.replayEligible !== "boolean") {
    throw new RecordedRunContractErrorV1(
      `${path}.replayEligible`,
      "expected a boolean",
    )
  }
  const paymentState = enumeration(
    source.paymentState,
    RECORDED_RUN_PAYMENT_STATES_V1,
    `${path}.paymentState`,
  )
  const amountDueMinor = integer(
    source.amountDueMinor,
    `${path}.amountDueMinor`,
    1,
    MAX_MONEY_MINOR,
  )
  const amountReceivedMinor = source.amountReceivedMinor === null
    ? null
    : integer(
        source.amountReceivedMinor,
        `${path}.amountReceivedMinor`,
        0,
        MAX_MONEY_MINOR,
      )
  if (
    (paymentState === "succeeded" && amountReceivedMinor !== amountDueMinor) ||
    (paymentState !== "succeeded" && amountReceivedMinor !== null)
  ) {
    throw new RecordedRunContractErrorV1(
      `${path}.amountReceivedMinor`,
      "received money must be exact for success and unknown otherwise",
    )
  }
  return {
    runRef: parseRecordedRunRefV1(source.runRef, `${path}.runRef`),
    population: enumeration(
      source.population,
      RECORDED_RUN_POPULATIONS_V1,
      `${path}.population`,
    ),
    integrityRevision: revision as RecordedRunIntegrityRevisionV1,
    recordedAt: instant(source.recordedAt, `${path}.recordedAt`),
    orderState: enumeration(
      source.orderState,
      RECORDED_RUN_ORDER_STATES_V1,
      `${path}.orderState`,
    ),
    paymentState,
    outcome: enumeration(
      source.outcome,
      [
        "fulfilled",
        "action_required",
        "declined",
        "recoverable_failure",
        "processing",
        "uncertain",
        "integrity_review",
      ] as const,
      `${path}.outcome`,
    ),
    itemCount: integer(source.itemCount, `${path}.itemCount`, 1, 4),
    currency,
    amountDueMinor,
    amountReceivedMinor,
    selectedMethod: paymentMethod(
      source.selectedMethod,
      `${path}.selectedMethod`,
    ),
    observedConnectors,
    attemptCount: integer(source.attemptCount, `${path}.attemptCount`, 0, 32),
    chargeCount: integer(source.chargeCount, `${path}.chargeCount`, 0, 32),
    ticketCount: integer(source.ticketCount, `${path}.ticketCount`, 0, 4),
    ticketState: enumeration(
      source.ticketState,
      ["not_issued", "issued", "integrity_review"] as const,
      `${path}.ticketState`,
    ),
    replayEligible: source.replayEligible,
    limitations,
  }
}

export function parseRecordedRunsPageV1(value: unknown): RecordedRunsPageV1 {
  const source = record(value, "$")
  exact(source, ["schema", "items", "page"], "$")
  if (source.schema !== "onsale.recorded-runs.v1") {
    throw new RecordedRunContractErrorV1("$.schema", "unexpected schema")
  }
  const page = record(source.page, "$.page")
  exact(page, ["limit", "nextCursor"], "$.page")
  const limit = integer(page.limit, "$.page.limit", 1, 50)
  const items = array(source.items, "$.items", limit).map((item, index) =>
    parseSummary(item, `$.items[${index}]`),
  )
  if (new Set(items.map((item) => item.runRef)).size !== items.length) {
    throw new RecordedRunContractErrorV1("$.items", "duplicate run alias")
  }
  return {
    schema: "onsale.recorded-runs.v1",
    items,
    page: {
      limit,
      nextCursor:
        page.nextCursor === null
          ? null
          : parseRecordedRunRefV1(page.nextCursor, "$.page.nextCursor"),
    },
  }
}

export function parseCurrentRecordedRunV1(
  value: unknown,
): CurrentRecordedRunV1 {
  const source = record(value, "$")
  exact(source, ["schema", "runRef", "integrityRevision", "terminal"], "$")
  if (
    source.schema !== "onsale.current-recorded-run.v1" ||
    typeof source.terminal !== "boolean"
  ) {
    throw new RecordedRunContractErrorV1("$", "invalid current-run response")
  }
  if (source.runRef === null || source.integrityRevision === null) {
    if (
      source.runRef !== null ||
      source.integrityRevision !== null ||
      source.terminal
    ) {
      throw new RecordedRunContractErrorV1(
        "$",
        "empty current-run fields must be null and non-terminal",
      )
    }
    return {
      schema: "onsale.current-recorded-run.v1",
      runRef: null,
      integrityRevision: null,
      terminal: false,
    }
  }
  const revision = string(source.integrityRevision, "$.integrityRevision")
  if (!SHA256.test(revision)) {
    throw new RecordedRunContractErrorV1(
      "$.integrityRevision",
      "expected a SHA-256 revision",
    )
  }
  return {
    schema: "onsale.current-recorded-run.v1",
    runRef: parseRecordedRunRefV1(source.runRef),
    integrityRevision: revision as RecordedRunIntegrityRevisionV1,
    terminal: source.terminal,
  }
}
