/** Browser-only parser for the private C3 checkout projection. */

export type CheckoutPrivateStageV1 = "checkout_ready" | "checking_same_payment" | "action_required" | "processing" | "declined" | "recoverable_failure" | "fulfilled" | "expired" | "review_required"

export type CheckoutPrivateCanonicalStateV1 = "requires_method" | "action_required" | "processing" | "succeeded" | "exhausted" | "uncertain"

export type CheckoutAttemptStateV1 = "requires_method" | "action_required" | "processing" | "hard_decline" | "technical_failure" | "uncertain" | "succeeded"

export interface CheckoutOrderLineV1 {
  readonly sectionLabel: string
  readonly rowLabel: string
  readonly seatLabel: string
  readonly priceTier: string
  readonly faceValueMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
  readonly currency: string
}

export interface CheckoutOrderProjectionV1 {
  readonly state: "awaiting_payment" | "payment_pending" | "paid" | "fulfilled" | "canceled"
  readonly paymentDeadlineAt: string
  readonly currency: string
  readonly subtotalMinor: number
  readonly feeMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
  readonly itemCount: number
  readonly items: readonly CheckoutOrderLineV1[]
  readonly ticketCount: number
}

export interface CheckoutPaymentProjectionV1 {
  readonly canonicalState: CheckoutPrivateCanonicalStateV1
  readonly integrityState: "clear" | "review_required"
  readonly observationSource: "create" | "retrieve" | null
  readonly selectedMethod: {
    readonly family: string | null
    readonly type: string | null
  } | null
  readonly observedConnector: string | null
  readonly attempts: readonly {
    readonly ordinal: number
    readonly state: CheckoutAttemptStateV1
    readonly charged: boolean
    readonly hardDecline: boolean
    readonly connector: string | null
  }[]
  readonly chargedAttemptCount: number
  readonly evidenceGeneration: number
  readonly retryPermitted: boolean
  readonly retryReason: string
  readonly evidenceRevision: `sha256:${string}`
}

export interface CheckoutEphemeralGrantV1 {
  readonly clientSecret: string
  readonly publishableKey: string
}

export interface CheckoutPrivateSuccessV1 {
  readonly schema: "onsale.checkout-private.v1"
  readonly ok: true
  readonly stage: CheckoutPrivateStageV1
  readonly order: CheckoutOrderProjectionV1
  readonly payment: CheckoutPaymentProjectionV1
  /** Memory-only. Never copy this object into storage, URLs, logs, or the DOM. */
  readonly checkout: CheckoutEphemeralGrantV1 | null
  readonly message: string
}

export interface CheckoutPrivateFailureV1 {
  readonly schema: "onsale.checkout-private.v1"
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}

export type CheckoutPrivateResponseV1 = CheckoutPrivateSuccessV1 | CheckoutPrivateFailureV1

export class CheckoutPrivateContractParseError extends TypeError {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`Invalid checkout contract at ${path}: ${reason}`)
    this.name = "CheckoutPrivateContractParseError"
    this.path = path
  }
}

type PlainRecord = Record<string, unknown>

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const EVIDENCE_TOKEN = /^[a-z0-9_.:-]{1,80}$/u
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u
const CURRENCY = /^[A-Z]{3}$/u
const MAX_MONEY_MINOR = 9_000_000_000_000
const MAX_EVIDENCE_GENERATION = 1_000_000

const STAGES = new Set<unknown>([
  "checkout_ready",
  "checking_same_payment",
  "action_required",
  "processing",
  "declined",
  "recoverable_failure",
  "fulfilled",
  "expired",
  "review_required",
])
const ORDER_STATES = new Set<unknown>([
  "awaiting_payment",
  "payment_pending",
  "paid",
  "fulfilled",
  "canceled",
])
const PAYMENT_STATES = new Set<unknown>([
  "requires_method",
  "action_required",
  "processing",
  "succeeded",
  "exhausted",
  "uncertain",
])
const ATTEMPT_STATES = new Set<unknown>([
  "requires_method",
  "action_required",
  "processing",
  "hard_decline",
  "technical_failure",
  "uncertain",
  "succeeded",
])

const STAGE_COPY: Record<CheckoutPrivateStageV1, string> = {
  checkout_ready: "SECURE CHECKOUT READY",
  checking_same_payment: "CHECKING THIS SAME PAYMENT",
  action_required: "CUSTOMER ACTION REQUIRED",
  processing: "PAYMENT PROCESSING",
  declined: "PAYMENT NOT COMPLETED",
  recoverable_failure: "PAYMENT NEEDS A NEW CHECKOUT",
  fulfilled: "TICKETS ISSUED",
  expired: "CHECKOUT TIME EXPIRED",
  review_required: "PAYMENT REVIEW REQUIRED",
}

const RETRY_POLICY: Record<CheckoutPrivateStageV1, {
  readonly permitted: boolean
  readonly reason: string
}> = {
  checkout_ready: {
    permitted: true,
    reason: "official_checkout_submission_available",
  },
  checking_same_payment: {
    permitted: false,
    reason: "same_payment_status_check_only",
  },
  action_required: {
    permitted: false,
    reason: "same_payment_status_check_only",
  },
  processing: {
    permitted: false,
    reason: "same_payment_status_check_only",
  },
  declined: {
    permitted: false,
    reason: "hard_decline_no_automatic_retry",
  },
  recoverable_failure: {
    permitted: false,
    reason: "terminal_failure_requires_new_checkout",
  },
  fulfilled: {
    permitted: false,
    reason: "payment_already_fulfilled",
  },
  expired: {
    permitted: false,
    reason: "checkout_deadline_elapsed",
  },
  review_required: {
    permitted: false,
    reason: "integrity_review_required",
  },
}

function fail(path: string, reason: string): never {
  throw new CheckoutPrivateContractParseError(path, reason)
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(path, "expected an object")
  }
  const source = value as PlainRecord
  const actual = Object.keys(source).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return fail(path, "unexpected or missing fields")
  }
  return source
}

interface CheckoutStringBoundsV1 {
  readonly min?: number
  readonly max?: number
}

function string(
  value: unknown,
  path: string,
  options: CheckoutStringBoundsV1 = {},
): string {
  const min = options.min ?? 1
  const max = options.max ?? 120
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    CONTROL_CHARACTER.test(value)
  ) {
    return fail(path, "invalid string")
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected a boolean")
  return value
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value as number < min ||
    value as number > max
  ) {
    return fail(path, "invalid integer")
  }
  return value as number
}

function money(value: unknown, path: string): number {
  return integer(value, path, 0, MAX_MONEY_MINOR)
}

function isoInstant(value: unknown, path: string): string {
  const candidate = string(value, path, { max: 40 })
  const parsed = new Date(candidate)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== candidate
  ) {
    return fail(path, "expected a canonical UTC instant")
  }
  return candidate
}

function evidenceToken(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== "string" || !EVIDENCE_TOKEN.test(value)) {
    return fail(path, "invalid evidence token")
  }
  return value
}

function parseLine(value: unknown, path: string): CheckoutOrderLineV1 {
  const source = record(value, path, [
    "sectionLabel",
    "rowLabel",
    "seatLabel",
    "priceTier",
    "faceValueMinor",
    "feeMinor",
    "taxMinor",
    "totalMinor",
    "currency",
  ])
  const faceValueMinor = money(source.faceValueMinor, `${path}.faceValueMinor`)
  const feeMinor = money(source.feeMinor, `${path}.feeMinor`)
  const taxMinor = money(source.taxMinor, `${path}.taxMinor`)
  const totalMinor = money(source.totalMinor, `${path}.totalMinor`)
  if (faceValueMinor + feeMinor + taxMinor !== totalMinor) {
    return fail(path, "line total does not reconcile")
  }
  const currency = string(source.currency, `${path}.currency`, { max: 3 })
  if (!CURRENCY.test(currency))
    return fail(`${path}.currency`, "invalid currency")
  return {
    sectionLabel: string(source.sectionLabel, `${path}.sectionLabel`),
    rowLabel: string(source.rowLabel, `${path}.rowLabel`),
    seatLabel: string(source.seatLabel, `${path}.seatLabel`),
    priceTier: string(source.priceTier, `${path}.priceTier`),
    faceValueMinor,
    feeMinor,
    taxMinor,
    totalMinor,
    currency,
  }
}

function parseOrder(value: unknown): CheckoutOrderProjectionV1 {
  const source = record(value, "$.order", [
    "state",
    "paymentDeadlineAt",
    "currency",
    "subtotalMinor",
    "feeMinor",
    "taxMinor",
    "totalMinor",
    "itemCount",
    "items",
    "ticketCount",
  ])
  if (!ORDER_STATES.has(source.state))
    return fail("$.order.state", "invalid state")
  if (
    !Array.isArray(source.items) ||
    source.items.length < 1 ||
    source.items.length > 4
  ) {
    return fail("$.order.items", "expected one to four lines")
  }
  const items = source.items.map((item, index) =>
    parseLine(item, `$.order.items[${index}]`),
  )
  const itemCount = integer(source.itemCount, "$.order.itemCount", 1, 4)
  const ticketCount = integer(
    source.ticketCount,
    "$.order.ticketCount",
    0,
    itemCount,
  )
  const currency = string(source.currency, "$.order.currency", { max: 3 })
  if (
    !CURRENCY.test(currency) ||
    items.some((item) => item.currency !== currency)
  ) {
    return fail("$.order.currency", "currency mismatch")
  }
  if (itemCount !== items.length)
    return fail("$.order.itemCount", "line count mismatch")
  const subtotalMinor = money(source.subtotalMinor, "$.order.subtotalMinor")
  const feeMinor = money(source.feeMinor, "$.order.feeMinor")
  const taxMinor = money(source.taxMinor, "$.order.taxMinor")
  const totalMinor = money(source.totalMinor, "$.order.totalMinor")
  if (
    subtotalMinor + feeMinor + taxMinor !== totalMinor ||
    items.reduce((sum, item) => sum + item.faceValueMinor, 0) !==
      subtotalMinor ||
    items.reduce((sum, item) => sum + item.feeMinor, 0) !== feeMinor ||
    items.reduce((sum, item) => sum + item.taxMinor, 0) !== taxMinor ||
    items.reduce((sum, item) => sum + item.totalMinor, 0) !== totalMinor
  ) {
    return fail("$.order", "order totals do not reconcile")
  }
  return {
    state: source.state as CheckoutOrderProjectionV1["state"],
    paymentDeadlineAt: isoInstant(
      source.paymentDeadlineAt,
      "$.order.paymentDeadlineAt",
    ),
    currency,
    subtotalMinor,
    feeMinor,
    taxMinor,
    totalMinor,
    itemCount,
    items,
    ticketCount,
  }
}

function parsePayment(value: unknown): CheckoutPaymentProjectionV1 {
  const source = record(value, "$.payment", [
    "canonicalState",
    "integrityState",
    "observationSource",
    "selectedMethod",
    "observedConnector",
    "attempts",
    "chargedAttemptCount",
    "evidenceGeneration",
    "retryPermitted",
    "retryReason",
    "evidenceRevision",
  ])
  if (!PAYMENT_STATES.has(source.canonicalState)) {
    return fail("$.payment.canonicalState", "invalid state")
  }
  if (
    source.integrityState !== "clear" &&
    source.integrityState !== "review_required"
  ) {
    return fail("$.payment.integrityState", "invalid integrity state")
  }
  if (
    source.observationSource !== null &&
    source.observationSource !== "create" &&
    source.observationSource !== "retrieve"
  ) {
    return fail("$.payment.observationSource", "invalid observation source")
  }
  let selectedMethod: CheckoutPaymentProjectionV1["selectedMethod"] = null
  if (source.selectedMethod !== null) {
    const method = record(source.selectedMethod, "$.payment.selectedMethod", [
      "family",
      "type",
    ])
    selectedMethod = {
      family: evidenceToken(method.family, "$.payment.selectedMethod.family"),
      type: evidenceToken(method.type, "$.payment.selectedMethod.type"),
    }
    if (selectedMethod.family === null && selectedMethod.type === null) {
      return fail("$.payment.selectedMethod", "empty selected method")
    }
  }
  if (!Array.isArray(source.attempts) || source.attempts.length > 32) {
    return fail("$.payment.attempts", "invalid attempts")
  }
  const attempts = source.attempts.map((value, index) => {
    const path = `$.payment.attempts[${index}]`
    const attempt = record(value, path, [
      "ordinal",
      "state",
      "charged",
      "hardDecline",
      "connector",
    ])
    const state = attempt.state
    if (!ATTEMPT_STATES.has(state))
      return fail(`${path}.state`, "invalid attempt state")
    const charged = boolean(attempt.charged, `${path}.charged`)
    const hardDecline = boolean(attempt.hardDecline, `${path}.hardDecline`)
    if (
      integer(attempt.ordinal, `${path}.ordinal`, 1, 32) !== index + 1 ||
      (charged && state !== "succeeded") ||
      hardDecline !== (state === "hard_decline")
    ) {
      return fail(path, "invalid attempt tuple")
    }
    return {
      ordinal: index + 1,
      state: state as CheckoutAttemptStateV1,
      charged,
      hardDecline,
      connector: evidenceToken(attempt.connector, `${path}.connector`),
    }
  })
  const chargedAttemptCount = integer(
    source.chargedAttemptCount,
    "$.payment.chargedAttemptCount",
    0,
    32,
  )
  const evidenceGeneration = integer(
    source.evidenceGeneration,
    "$.payment.evidenceGeneration",
    0,
    MAX_EVIDENCE_GENERATION,
  )
  if (
    attempts.filter((attempt) => attempt.charged).length !== chargedAttemptCount
  ) {
    return fail("$.payment.chargedAttemptCount", "charged count mismatch")
  }
  if (
    source.integrityState === "clear" &&
    attempts.filter((attempt) => attempt.state === "succeeded").length !==
      chargedAttemptCount
  ) {
    return fail("$.payment.attempts", "clear success evidence mismatch")
  }
  if (
    (source.observationSource === null &&
      (evidenceGeneration !== 0 || attempts.length !== 0)) ||
    (source.observationSource !== null && evidenceGeneration < 1)
  ) {
    return fail("$.payment", "observation evidence mismatch")
  }
  const evidenceRevision = string(
    source.evidenceRevision,
    "$.payment.evidenceRevision",
    { max: 71 },
  )
  if (!SHA256_REVISION.test(evidenceRevision)) {
    return fail("$.payment.evidenceRevision", "invalid evidence revision")
  }
  return {
    canonicalState: source.canonicalState as CheckoutPrivateCanonicalStateV1,
    integrityState: source.integrityState,
    observationSource: source.observationSource,
    selectedMethod,
    observedConnector: evidenceToken(
      source.observedConnector,
      "$.payment.observedConnector",
    ),
    attempts,
    chargedAttemptCount,
    evidenceGeneration,
    retryPermitted: boolean(source.retryPermitted, "$.payment.retryPermitted"),
    retryReason: string(source.retryReason, "$.payment.retryReason", {
      max: 80,
    }),
    evidenceRevision: evidenceRevision as `sha256:${string}`,
  }
}

function parseGrant(value: unknown): CheckoutEphemeralGrantV1 | null {
  if (value === null) return null
  const source = record(value, "$.checkout", ["clientSecret", "publishableKey"])
  const clientSecret = string(source.clientSecret, "$.checkout.clientSecret", {
    min: 12,
    max: 512,
  })
  const publishableKey = string(
    source.publishableKey,
    "$.checkout.publishableKey",
    { min: 12, max: 512 },
  )
  if (/\s/u.test(clientSecret) || /\s/u.test(publishableKey)) {
    return fail("$.checkout", "grant may not contain whitespace")
  }
  return { clientSecret, publishableKey }
}

function assertSuccessTuple(value: CheckoutPrivateSuccessV1): void {
  const { stage, order, payment, checkout } = value
  const noGrant = checkout === null
  const noTickets = order.ticketCount === 0
  const noCharge = payment.chargedAttemptCount === 0
  const clear = payment.integrityState === "clear"
  const pending = order.state === "payment_pending"
  const hardDecline = payment.attempts.some((attempt) => attempt.hardDecline)
  const observed =
    payment.observationSource !== null && payment.evidenceGeneration >= 1
  const onlyRequiresMethod = payment.attempts.every(
    (attempt) => attempt.state === "requires_method",
  )
  const hasActionAttempt = payment.attempts.some(
    (attempt) => attempt.state === "action_required",
  )
  const hasProcessingAttempt = payment.attempts.some(
    (attempt) => attempt.state === "processing",
  )
  const hasRecoverableAttempt = payment.attempts.some(
    (attempt) =>
      attempt.state === "technical_failure" || attempt.state === "uncertain",
  )
  const retry = RETRY_POLICY[stage]
  let valid =
    value.message === STAGE_COPY[stage] &&
    payment.retryPermitted === retry.permitted &&
    payment.retryReason === retry.reason

  switch (stage) {
    case "checkout_ready":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        payment.canonicalState === "requires_method" &&
        observed &&
        onlyRequiresMethod &&
        checkout !== null
      break
    case "checking_same_payment":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        ["uncertain", "processing", "requires_method"].includes(
          payment.canonicalState,
        ) &&
        (payment.canonicalState === "uncertain" ||
          (payment.canonicalState === "requires_method"
            ? observed && onlyRequiresMethod
            : observed && hasProcessingAttempt))
      break
    case "action_required":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        observed &&
        hasActionAttempt &&
        payment.canonicalState === "action_required"
      break
    case "processing":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        observed &&
        hasProcessingAttempt &&
        payment.canonicalState === "processing"
      break
    case "declined":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        observed &&
        hardDecline &&
        payment.canonicalState === "exhausted"
      break
    case "recoverable_failure":
      valid &&=
        pending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        observed &&
        !hardDecline &&
        hasRecoverableAttempt &&
        payment.canonicalState === "exhausted"
      break
    case "fulfilled":
      valid &&=
        order.state === "fulfilled" &&
        order.ticketCount === order.itemCount &&
        payment.chargedAttemptCount === 1 &&
        payment.observationSource === "retrieve" &&
        clear &&
        noGrant &&
        payment.canonicalState === "succeeded"
      break
    case "expired":
      valid &&=
        (order.state === "awaiting_payment" || pending) &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        [
          "uncertain",
          "requires_method",
          "action_required",
          "processing",
        ].includes(payment.canonicalState)
      break
    case "review_required":
      valid &&= payment.integrityState === "review_required" && noGrant
      break
  }

  if (!valid) fail("$", "invalid cross-state checkout tuple")
}

function parseFailure(source: PlainRecord): CheckoutPrivateFailureV1 {
  const error = record(source.error, "$.error", [
    "code",
    "message",
    "retryable",
  ])
  const code = string(error.code, "$.error.code", { max: 80 })
  if (!ERROR_CODE.test(code)) return fail("$.error.code", "invalid error code")
  return {
    schema: "onsale.checkout-private.v1",
    ok: false,
    error: {
      code,
      message: string(error.message, "$.error.message", { max: 240 }),
      retryable: boolean(error.retryable, "$.error.retryable"),
    },
  }
}

export function parseCheckoutPrivateResponseV1(
  value: unknown,
): CheckoutPrivateResponseV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("$", "expected an object")
  }
  const candidate = value as PlainRecord
  if (candidate.schema !== "onsale.checkout-private.v1") {
    return fail("$.schema", "unexpected schema")
  }
  if (candidate.ok === false) {
    return parseFailure(record(candidate, "$", ["schema", "ok", "error"]))
  }
  const source = record(candidate, "$", [
    "schema",
    "ok",
    "stage",
    "order",
    "payment",
    "checkout",
    "message",
  ])
  if (source.ok !== true || !STAGES.has(source.stage)) {
    return fail("$.ok", "invalid success envelope")
  }
  const parsed: CheckoutPrivateSuccessV1 = {
    schema: "onsale.checkout-private.v1",
    ok: true,
    stage: source.stage as CheckoutPrivateStageV1,
    order: parseOrder(source.order),
    payment: parsePayment(source.payment),
    checkout: parseGrant(source.checkout),
    message: string(source.message, "$.message", { max: 80 }),
  }
  assertSuccessTuple(parsed)
  return parsed
}
