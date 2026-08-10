import { createHash } from "node:crypto"

declare const sha256PaymentRefBrand: unique symbol

/** A one-way, domain-separated SHA-256 reference. Raw provider IDs stay out. */
export type Sha256PaymentRefV1 = `sha256:${string}` & {
  readonly [sha256PaymentRefBrand]: "Sha256PaymentRefV1"
}

export type OnsalePaymentCanonicalStateV1 =
  | "requires_method"
  | "action_required"
  | "processing"
  | "succeeded"
  | "exhausted"
  | "uncertain"

export type OnsalePaymentObservationSourceV1 = "create" | "retrieve"

export type OnsalePaymentErrorClassV1 =
  | "hard_decline"
  | "payment_method"
  | "technical"
  | "configuration"
  | "integration"
  | "unknown"

export interface SanitizedPaymentErrorV1 {
  readonly class: OnsalePaymentErrorClassV1
  readonly code: string | null
  readonly unifiedCode: string | null
  readonly message: string
}

export interface NormalizedPaymentAttemptV1 {
  readonly index: number
  readonly providerAttemptRef: Sha256PaymentRefV1
  readonly providerStatus: string
  readonly canonicalState: OnsalePaymentCanonicalStateV1
  readonly charged: boolean
  readonly hardDecline: boolean
  readonly observedConnector: string | null
  readonly amountMinor: number | null
  readonly currency: string | null
  readonly error: SanitizedPaymentErrorV1 | null
}

export interface NormalizedPaymentObservationV1 {
  readonly schema: "onsale.payment-observation.v1"
  readonly source: OnsalePaymentObservationSourceV1
  readonly providerPaymentRef: Sha256PaymentRefV1
  readonly providerStatus: string
  readonly canonicalState: OnsalePaymentCanonicalStateV1
  readonly amountMinor: number
  readonly currency: string
  readonly selectedPaymentMethod: {
    readonly family: string | null
    readonly type: string | null
  } | null
  readonly observedConnector: string | null
  readonly nextAction: {
    readonly present: boolean
    readonly kind: string | null
  }
  readonly attempts: readonly NormalizedPaymentAttemptV1[]
  readonly successfulChargedAttemptCount: number
  readonly hardDeclineObserved: boolean
  readonly error: SanitizedPaymentErrorV1 | null
  readonly observationHash: Sha256PaymentRefV1
}

export interface ImmutableOrderPaymentTermsV1 {
  readonly amountMinor: number
  readonly currency: string
  readonly itemCount: number
}

export type PaymentIntegrityIssueCodeV1 =
  | "ORDER_AMOUNT_MISMATCH"
  | "ORDER_CURRENCY_MISMATCH"
  | "ORDER_ITEM_COUNT_OUT_OF_RANGE"
  | "SUCCEEDED_WITHOUT_CHARGED_ATTEMPT"
  | "MULTIPLE_SUCCESSFUL_CHARGES"
  | "SUCCESSFUL_ATTEMPT_AMOUNT_MISMATCH"
  | "SUCCESSFUL_ATTEMPT_CURRENCY_MISMATCH"

export interface PaymentIntegrityIssueV1 {
  readonly code: PaymentIntegrityIssueCodeV1
  readonly message: string
}

export type PaymentFulfillmentBlockV1 =
  | "SOURCE_NOT_RETRIEVED"
  | "PAYMENT_NOT_SUCCEEDED"
  | "MONEY_NOT_EXACT"
  | "ORDER_ITEM_COUNT_INVALID"
  | "SUCCESSFUL_CHARGE_COUNT_NOT_ONE"
  | "INTEGRITY_REVIEW_REQUIRED"

export interface PaymentIntegrityEvaluationV1 {
  readonly sourceIsRetrieved: boolean
  readonly exactMoney: boolean
  readonly canonicalSuccess: boolean
  readonly successfulChargedAttemptCount: number
  readonly exactlyOneSuccessfulChargedAttempt: boolean
  readonly orderItemCountValid: boolean
  readonly integrityReviewRequired: boolean
  readonly fulfillmentEligible: boolean
  readonly issues: readonly PaymentIntegrityIssueV1[]
  readonly fulfillmentBlocks: readonly PaymentFulfillmentBlockV1[]
}

export type PaymentTransitionReviewReasonV1 =
  | "PROVIDER_PAYMENT_IDENTITY_CHANGED"
  | "TERMINAL_FAILURE_REGRESSION"
  | "TERMINAL_SUCCESS_REGRESSION"
  | "TERMINAL_SUCCESS_MONEY_CHANGED"
  | "TERMINAL_SUCCESS_CHARGE_COUNT_CHANGED"

export interface PaymentTransitionDecisionV1 {
  /** Whether the incoming observation may replace the aggregate's current state. */
  readonly accepted: boolean
  readonly resultingCanonicalState: OnsalePaymentCanonicalStateV1
  readonly retainedTerminalSuccess: boolean
  readonly integrityReviewRequired: boolean
  readonly reasons: readonly PaymentTransitionReviewReasonV1[]
}

export class PaymentNormalizationError extends TypeError {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`Invalid Hyperswitch payment observation at ${path}: ${reason}`)
    this.name = "PaymentNormalizationError"
    this.path = path
  }
}

type PlainRecord = Record<string, unknown>

const MAX_PROVIDER_ID_LENGTH = 512
const MAX_PROVIDER_TOKEN_LENGTH = 96
const MAX_ERROR_CODE_LENGTH = 80
const MAX_ATTEMPT_COUNT = 32
const ISO_CURRENCY = /^[A-Z]{3}$/
const SAFE_PROVIDER_TOKEN = /[^a-z0-9_.:-]+/g
const SAFE_ERROR_CODE = /[^A-Z0-9_.:-]+/g

const REQUIRES_METHOD_STATUSES = new Set([
  "requires_payment_method",
  "payment_method_awaited",
  "requires_confirmation",
])
const ACTION_REQUIRED_STATUSES = new Set([
  "requires_customer_action",
  "requires_action",
  "authentication_pending",
])
const PROCESSING_STATUSES = new Set([
  "processing",
  "pending",
  "started",
  "authorized",
  "authorizing",
  "confirmation_awaited",
  "requires_capture",
  "partially_captured",
])
const SUCCEEDED_STATUSES = new Set(["succeeded", "charged", "captured"])
const EXHAUSTED_STATUSES = new Set([
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "voided",
  "declined",
  "hard_decline",
])
const KNOWN_PROVIDER_STATUSES = new Set([
  ...REQUIRES_METHOD_STATUSES,
  ...ACTION_REQUIRED_STATUSES,
  ...PROCESSING_STATUSES,
  ...SUCCEEDED_STATUSES,
  ...EXHAUSTED_STATUSES,
])
const KNOWN_CONNECTORS = new Set([
  "aci",
  "adyen",
  "adyen_test",
  "airwallex",
  "bankofamerica",
  "dummy_connector",
  "dummyconnector",
  "fauxpay",
  "klarna",
  "paypal",
  "paypal_test",
  "stripe",
  "stripe_test",
])
const KNOWN_PAYMENT_METHOD_TOKENS = new Set([
  "affirm",
  "afterpay_clearpay",
  "apple_pay",
  "bank_debit",
  "bank_redirect",
  "bank_transfer",
  "card",
  "credit",
  "debit",
  "google_pay",
  "klarna",
  "pay_later",
  "paypal",
  "wallet",
])
const KNOWN_NEXT_ACTION_KINDS = new Set([
  "invoke_sdk_client",
  "redirect",
  "redirect_to_url",
  "three_ds",
  "wait_screen_information",
])
const KNOWN_ERROR_CODES = new Set([
  "DC_08",
  "TE_01",
  "UE_1000",
  "UE_2000",
  "UE_3000",
  "UE_4000",
  "UE_9000",
])
const KNOWN_ERROR_FAMILY = /^(CE|DC|HE|IR|PE|TE|UE)_/u

function fail(path: string, reason: string): never {
  throw new PaymentNormalizationError(path, reason)
}

function record(value: unknown, path: string): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(path, "expected a plain object")
  }
  return value as PlainRecord
}

function hasOwn(source: PlainRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

function requiredProviderId(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "expected a string")
  const normalized = value.trim()
  if (normalized.length === 0) return fail(path, "must not be empty")
  if (normalized.length > MAX_PROVIDER_ID_LENGTH) {
    return fail(path, `must be at most ${MAX_PROVIDER_ID_LENGTH} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return fail(path, "must not contain control characters")
  }
  return normalized
}

function sanitizeProviderToken(
  value: unknown,
  path: string,
  required: true,
): string
function sanitizeProviderToken(
  value: unknown,
  path: string,
  required?: false,
): string | null
function sanitizeProviderToken(
  value: unknown,
  path: string,
  required = false,
): string | null {
  if (value === undefined || value === null) {
    if (required) return fail(path, "expected a provider token")
    return null
  }
  if (typeof value !== "string") return fail(path, "expected a string or null")
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .toLowerCase()
    .replace(SAFE_PROVIDER_TOKEN, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_PROVIDER_TOKEN_LENGTH)
  if (normalized.length === 0) {
    if (required) return fail(path, "must contain a usable provider token")
    return null
  }
  return normalized
}

function allowlistedProviderToken(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  fallback: string,
  required = false,
): string | null {
  const normalized = required
    ? sanitizeProviderToken(value, path, true)
    : sanitizeProviderToken(value, path)
  if (normalized === null) return null
  return allowed.has(normalized) ? normalized : fallback
}

function sanitizeErrorCode(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") return fail(path, "expected a string or null")
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .toUpperCase()
    .replace(SAFE_ERROR_CODE, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_ERROR_CODE_LENGTH)
  if (!normalized) return null
  if (KNOWN_ERROR_CODES.has(normalized)) return normalized
  const family = KNOWN_ERROR_FAMILY.exec(normalized)?.[1]
  return family ? `${family}_OTHER` : "UNRECOGNIZED"
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return fail(path, "expected a non-negative safe integer")
  }
  return value
}

function optionalNonNegativeSafeInteger(
  value: unknown,
  path: string,
): number | null {
  if (value === undefined || value === null) return null
  return nonNegativeSafeInteger(value, path)
}

function currency(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "expected an ISO currency")
  const normalized = value.trim().toUpperCase()
  if (!ISO_CURRENCY.test(normalized)) {
    return fail(path, "expected a three-letter ISO currency")
  }
  return normalized
}

function optionalCurrency(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  return currency(value, path)
}

function canonicalState(
  providerStatus: string,
): OnsalePaymentCanonicalStateV1 {
  if (REQUIRES_METHOD_STATUSES.has(providerStatus)) return "requires_method"
  if (ACTION_REQUIRED_STATUSES.has(providerStatus)) return "action_required"
  if (PROCESSING_STATUSES.has(providerStatus)) return "processing"
  if (SUCCEEDED_STATUSES.has(providerStatus)) return "succeeded"
  if (EXHAUSTED_STATUSES.has(providerStatus)) return "exhausted"
  return "uncertain"
}

function nestedError(source: PlainRecord, path: string): PlainRecord | null {
  if (!hasOwn(source, "error") || source.error === null) return null
  return record(source.error, `${path}.error`)
}

function firstPresent(
  source: PlainRecord,
  nested: PlainRecord | null,
  sourceKeys: readonly string[],
  nestedKeys: readonly string[],
): { value: unknown; pathSuffix: string } {
  for (const key of sourceKeys) {
    if (hasOwn(source, key)) return { value: source[key], pathSuffix: key }
  }
  if (nested) {
    for (const key of nestedKeys) {
      if (hasOwn(nested, key)) {
        return { value: nested[key], pathSuffix: `error.${key}` }
      }
    }
  }
  return { value: undefined, pathSuffix: sourceKeys[0] ?? "error" }
}

function hardDeclineFrom(
  providerStatus: string,
  code: string | null,
  unifiedCode: string | null,
): boolean {
  return (
    providerStatus === "hard_decline" ||
    code === "DC_08" ||
    unifiedCode === "DC_08"
  )
}

function errorClass(
  hardDecline: boolean,
  code: string | null,
  unifiedCode: string | null,
): OnsalePaymentErrorClassV1 {
  if (hardDecline) return "hard_decline"
  const joined = `${code ?? ""} ${unifiedCode ?? ""}`
  if (/\bUE_1000/.test(joined)) return "payment_method"
  if (/\b(?:TE_|UE_3000)/.test(joined)) return "technical"
  if (/\bUE_2000/.test(joined)) return "configuration"
  if (/\bUE_4000/.test(joined)) return "integration"
  return "unknown"
}

function fixedErrorMessage(
  classification: OnsalePaymentErrorClassV1,
): string {
  switch (classification) {
    case "hard_decline":
      return "The payment method was declined."
    case "payment_method":
      return "The payment method could not be accepted."
    case "technical":
      return "The payment processor reported a technical failure."
    case "configuration":
      return "The payment configuration requires review."
    case "integration":
      return "The payment integration requires review."
    case "unknown":
      return "The payment provider returned an error."
  }
}

function normalizeError(
  source: PlainRecord,
  providerStatus: string,
  path: string,
): SanitizedPaymentErrorV1 | null {
  const nested = nestedError(source, path)
  const codeSource = firstPresent(
    source,
    nested,
    ["error_code"],
    ["code", "error_code"],
  )
  const unifiedCodeSource = firstPresent(
    source,
    nested,
    ["unified_code"],
    ["unified_code"],
  )
  const messageSource = firstPresent(
    source,
    nested,
    ["unified_message", "error_message"],
    ["unified_message", "message"],
  )
  const code = sanitizeErrorCode(
    codeSource.value,
    `${path}.${codeSource.pathSuffix}`,
  )
  const unifiedCode = sanitizeErrorCode(
    unifiedCodeSource.value,
    `${path}.${unifiedCodeSource.pathSuffix}`,
  )
  const hasMessage =
    messageSource.value !== undefined && messageSource.value !== null
  if (hasMessage && typeof messageSource.value !== "string") {
    return fail(
      `${path}.${messageSource.pathSuffix}`,
      "expected a string or null",
    )
  }
  if (!code && !unifiedCode && !hasMessage) return null

  const hardDecline = hardDeclineFrom(providerStatus, code, unifiedCode)
  const classification = errorClass(hardDecline, code, unifiedCode)
  return {
    class: classification,
    code,
    unifiedCode,
    // Provider prose is never an evidence fact. It can contain unlabeled
    // credentials, PII, URLs, or raw connector diagnostics that no blocklist
    // can reliably declassify.
    message: fixedErrorMessage(classification),
  }
}

function sha256(domain: string, value: string): Sha256PaymentRefV1 {
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex")
  return `sha256:${digest}` as Sha256PaymentRefV1
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite canonical JSON")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
      .join(",")}}`
  }
  throw new TypeError("Unsupported canonical JSON value")
}

function normalizeAttempt(
  value: unknown,
  index: number,
): NormalizedPaymentAttemptV1 {
  const path = `$.attempts[${index}]`
  const source = record(value, path)
  const providerAttemptId = requiredProviderId(
    source.attempt_id,
    `${path}.attempt_id`,
  )
  const providerStatus = allowlistedProviderToken(
    source.status,
    `${path}.status`,
    KNOWN_PROVIDER_STATUSES,
    "unrecognized",
    true,
  ) as string
  const normalizedState = canonicalState(providerStatus)
  const error = normalizeError(source, providerStatus, path)
  const hardDecline =
    providerStatus === "hard_decline" || error?.class === "hard_decline"

  return {
    index: index + 1,
    providerAttemptRef: sha256(
      "onsale-provider-attempt-v1",
      providerAttemptId,
    ),
    providerStatus,
    canonicalState: normalizedState,
    charged: normalizedState === "succeeded",
    hardDecline,
    observedConnector: allowlistedProviderToken(
      source.connector ?? source.connector_label,
      `${path}.connector`,
      KNOWN_CONNECTORS,
      "other",
    ),
    amountMinor: optionalNonNegativeSafeInteger(
      source.amount ?? source.amount_received,
      `${path}.amount`,
    ),
    currency: optionalCurrency(source.currency, `${path}.currency`),
    error,
  }
}

function normalizeAttempts(source: PlainRecord): readonly NormalizedPaymentAttemptV1[] {
  const raw = source.attempts ?? source.payment_attempts
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return fail("$.attempts", "expected an array")
  if (raw.length > MAX_ATTEMPT_COUNT) {
    return fail("$.attempts", `must contain at most ${MAX_ATTEMPT_COUNT} attempts`)
  }
  const attempts = raw.map((attempt, index) => normalizeAttempt(attempt, index))
  const seen = new Set<Sha256PaymentRefV1>()
  for (const attempt of attempts) {
    if (seen.has(attempt.providerAttemptRef)) {
      return fail("$.attempts", "duplicate provider attempt ID")
    }
    seen.add(attempt.providerAttemptRef)
  }
  return attempts
}

function normalizeSelectedPaymentMethod(
  source: PlainRecord,
): NormalizedPaymentObservationV1["selectedPaymentMethod"] {
  const family = allowlistedProviderToken(
    source.payment_method,
    "$.payment_method",
    KNOWN_PAYMENT_METHOD_TOKENS,
    "other",
  )
  const type = allowlistedProviderToken(
    source.payment_method_type,
    "$.payment_method_type",
    KNOWN_PAYMENT_METHOD_TOKENS,
    "other",
  )
  return family || type ? { family, type } : null
}

function normalizeNextAction(
  source: PlainRecord,
): NormalizedPaymentObservationV1["nextAction"] {
  if (!hasOwn(source, "next_action") || source.next_action === null) {
    return { present: false, kind: null }
  }
  if (typeof source.next_action === "string") {
    return {
      present: true,
      kind: allowlistedProviderToken(
        source.next_action,
        "$.next_action",
        KNOWN_NEXT_ACTION_KINDS,
        "other",
        true,
      ) as string,
    }
  }
  const action = record(source.next_action, "$.next_action")
  return {
    present: true,
    kind: allowlistedProviderToken(
      action.type,
      "$.next_action.type",
      KNOWN_NEXT_ACTION_KINDS,
      "other",
    ),
  }
}

function assertSource(
  value: OnsalePaymentObservationSourceV1,
): OnsalePaymentObservationSourceV1 {
  if (value !== "create" && value !== "retrieve") {
    return fail("$source", "expected create or retrieve")
  }
  return value
}

/**
 * Project one raw V1 create/retrieve response into the only payment evidence
 * shape the rest of ONSALE may persist or render. Unknown provider fields are
 * intentionally discarded; malformed safety-critical fields fail closed.
 */
export function normalizeHyperswitchPaymentObservationV1(
  payload: unknown,
  sourceValue: OnsalePaymentObservationSourceV1,
): NormalizedPaymentObservationV1 {
  const sourceKind = assertSource(sourceValue)
  const source = record(payload, "$")
  const providerPaymentId = requiredProviderId(
    source.payment_id,
    "$.payment_id",
  )
  const providerStatus = allowlistedProviderToken(
    source.status,
    "$.status",
    KNOWN_PROVIDER_STATUSES,
    "unrecognized",
    true,
  ) as string
  const normalizedState = canonicalState(providerStatus)
  const attempts = normalizeAttempts(source)
  const rootConnector = allowlistedProviderToken(
    source.connector ?? source.connector_label,
    "$.connector",
    KNOWN_CONNECTORS,
    "other",
  )
  const observedConnector =
    attempts.find((attempt) => attempt.charged)?.observedConnector ??
    [...attempts]
      .reverse()
      .find((attempt) => attempt.observedConnector !== null)
      ?.observedConnector ??
    rootConnector
  const error = normalizeError(source, providerStatus, "$")
  const successfulChargedAttemptCount = attempts.filter(
    (attempt) => attempt.charged,
  ).length
  const hardDeclineObserved =
    providerStatus === "hard_decline" ||
    error?.class === "hard_decline" ||
    attempts.some((attempt) => attempt.hardDecline)

  const sanitized = {
    schema: "onsale.payment-observation.v1" as const,
    source: sourceKind,
    providerPaymentRef: sha256(
      "onsale-provider-payment-v1",
      providerPaymentId,
    ),
    providerStatus,
    canonicalState: normalizedState,
    amountMinor: nonNegativeSafeInteger(source.amount, "$.amount"),
    currency: currency(source.currency, "$.currency"),
    selectedPaymentMethod: normalizeSelectedPaymentMethod(source),
    observedConnector,
    nextAction: normalizeNextAction(source),
    attempts,
    successfulChargedAttemptCount,
    hardDeclineObserved,
    error,
  }
  const observationHash = sha256(
    "onsale-payment-observation-v1",
    canonicalJson(sanitized),
  )

  return { ...sanitized, observationHash }
}

function issue(
  code: PaymentIntegrityIssueCodeV1,
  message: string,
): PaymentIntegrityIssueV1 {
  return { code, message }
}

function uniqueBlocks(
  blocks: readonly PaymentFulfillmentBlockV1[],
): readonly PaymentFulfillmentBlockV1[] {
  return [...new Set(blocks)]
}

/** Evaluate one sanitized observation against the order's immutable terms. */
export function evaluatePaymentIntegrityV1(
  observation: NormalizedPaymentObservationV1,
  order: ImmutableOrderPaymentTermsV1,
): PaymentIntegrityEvaluationV1 {
  const expectedAmount = nonNegativeSafeInteger(
    order.amountMinor,
    "$order.amountMinor",
  )
  const expectedCurrency = currency(order.currency, "$order.currency")
  const itemCount = nonNegativeSafeInteger(order.itemCount, "$order.itemCount")
  const sourceIsRetrieved = observation.source === "retrieve"
  const amountMatches = observation.amountMinor === expectedAmount
  const currencyMatches = observation.currency === expectedCurrency
  const exactMoney = amountMatches && currencyMatches
  const canonicalSuccess = observation.canonicalState === "succeeded"
  const successfulAttempts = observation.attempts.filter(
    (attempt) => attempt.charged && attempt.canonicalState === "succeeded",
  )
  const successfulChargedAttemptCount = successfulAttempts.length
  const exactlyOneSuccessfulChargedAttempt =
    successfulChargedAttemptCount === 1
  const orderItemCountValid = itemCount >= 1 && itemCount <= 4
  const issues: PaymentIntegrityIssueV1[] = []

  if (!amountMatches) {
    issues.push(
      issue(
        "ORDER_AMOUNT_MISMATCH",
        "The provider amount does not match the immutable order amount.",
      ),
    )
  }
  if (!currencyMatches) {
    issues.push(
      issue(
        "ORDER_CURRENCY_MISMATCH",
        "The provider currency does not match the immutable order currency.",
      ),
    )
  }
  if (!orderItemCountValid) {
    issues.push(
      issue(
        "ORDER_ITEM_COUNT_OUT_OF_RANGE",
        "Fulfillment requires one to four immutable order items.",
      ),
    )
  }
  if (canonicalSuccess && successfulChargedAttemptCount === 0) {
    issues.push(
      issue(
        "SUCCEEDED_WITHOUT_CHARGED_ATTEMPT",
        "Provider success was not supported by a charged logical attempt.",
      ),
    )
  }
  if (successfulChargedAttemptCount > 1) {
    issues.push(
      issue(
        "MULTIPLE_SUCCESSFUL_CHARGES",
        "More than one successful charged logical attempt was observed.",
      ),
    )
  }
  if (
    successfulAttempts.some(
      (attempt) =>
        attempt.amountMinor !== null && attempt.amountMinor !== expectedAmount,
    )
  ) {
    issues.push(
      issue(
        "SUCCESSFUL_ATTEMPT_AMOUNT_MISMATCH",
        "A successful attempt amount does not match the immutable order amount.",
      ),
    )
  }
  if (
    successfulAttempts.some(
      (attempt) =>
        attempt.currency !== null && attempt.currency !== expectedCurrency,
    )
  ) {
    issues.push(
      issue(
        "SUCCESSFUL_ATTEMPT_CURRENCY_MISMATCH",
        "A successful attempt currency does not match the immutable order currency.",
      ),
    )
  }

  const integrityReviewRequired = issues.length > 0
  const fulfillmentBlocks: PaymentFulfillmentBlockV1[] = []
  if (!sourceIsRetrieved) fulfillmentBlocks.push("SOURCE_NOT_RETRIEVED")
  if (!canonicalSuccess) fulfillmentBlocks.push("PAYMENT_NOT_SUCCEEDED")
  if (!exactMoney) fulfillmentBlocks.push("MONEY_NOT_EXACT")
  if (!orderItemCountValid) fulfillmentBlocks.push("ORDER_ITEM_COUNT_INVALID")
  if (!exactlyOneSuccessfulChargedAttempt) {
    fulfillmentBlocks.push("SUCCESSFUL_CHARGE_COUNT_NOT_ONE")
  }
  if (integrityReviewRequired) {
    fulfillmentBlocks.push("INTEGRITY_REVIEW_REQUIRED")
  }

  return {
    sourceIsRetrieved,
    exactMoney,
    canonicalSuccess,
    successfulChargedAttemptCount,
    exactlyOneSuccessfulChargedAttempt,
    orderItemCountValid,
    integrityReviewRequired,
    fulfillmentEligible: fulfillmentBlocks.length === 0,
    issues,
    fulfillmentBlocks: uniqueBlocks(fulfillmentBlocks),
  }
}

/**
 * Decide only whether the incoming observation may advance aggregate state.
 * Every observation can still be retained as evidence; terminal success and
 * provider identity are never overwritten by a contradictory later response.
 */
export function decidePaymentTransitionV1(
  current: NormalizedPaymentObservationV1 | null,
  incoming: NormalizedPaymentObservationV1,
): PaymentTransitionDecisionV1 {
  if (current === null) {
    return {
      accepted: true,
      resultingCanonicalState: incoming.canonicalState,
      retainedTerminalSuccess: false,
      integrityReviewRequired: false,
      reasons: [],
    }
  }

  const reasons: PaymentTransitionReviewReasonV1[] = []
  if (current.providerPaymentRef !== incoming.providerPaymentRef) {
    reasons.push("PROVIDER_PAYMENT_IDENTITY_CHANGED")
  }
  if (
    current.canonicalState === "exhausted" &&
    incoming.canonicalState !== "exhausted"
  ) {
    reasons.push("TERMINAL_FAILURE_REGRESSION")
  }
  if (
    current.canonicalState === "succeeded" &&
    incoming.canonicalState !== "succeeded"
  ) {
    reasons.push("TERMINAL_SUCCESS_REGRESSION")
  }
  if (
    current.canonicalState === "succeeded" &&
    (current.amountMinor !== incoming.amountMinor ||
      current.currency !== incoming.currency)
  ) {
    reasons.push("TERMINAL_SUCCESS_MONEY_CHANGED")
  }
  if (
    current.canonicalState === "succeeded" &&
    current.successfulChargedAttemptCount === 1 &&
    incoming.successfulChargedAttemptCount !== 1
  ) {
    reasons.push("TERMINAL_SUCCESS_CHARGE_COUNT_CHANGED")
  }

  const integrityReviewRequired = reasons.length > 0
  const retainedTerminalSuccess =
    current.canonicalState === "succeeded" && integrityReviewRequired
  const accepted = !integrityReviewRequired

  return {
    accepted,
    resultingCanonicalState: accepted
      ? incoming.canonicalState
      : current.canonicalState,
    retainedTerminalSuccess,
    integrityReviewRequired,
    reasons,
  }
}
