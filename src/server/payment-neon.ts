import { createHash, randomBytes } from "node:crypto"

import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless"

import {
  evaluatePaymentIntegrityV1,
  type NormalizedPaymentAttemptV1,
  type NormalizedPaymentObservationV1,
  type OnsalePaymentCanonicalStateV1,
  type PaymentIntegrityIssueCodeV1,
} from "../domain/onsale-payment-v1"
import {
  quoteInventoryAppSchema,
  type InventoryAppSchema,
} from "./inventory-app-schema"
import { quoteEphemeralSchema } from "./inventory-neon-schema"
import type {
  HyperswitchV1EvidenceVerifier,
  HyperswitchV1NotFoundReceipt,
  HyperswitchV1ObservationReceipt,
} from "./hyperswitch-v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SHA256_HEX = /^[0-9a-f]{64}$/u
const SHA256_REF = /^sha256:[0-9a-f]{64}$/u
const PROVIDER_PAYMENT_REF = /^pay_[0-9a-f]{26}$/u
const SAFE_TOKEN = /^[a-z0-9_.:-]{1,80}$/u
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/u
const ISO_CURRENCY = /^[A-Z]{3}$/u
const MAX_SAFE_MONEY_MINOR = 9_000_000_000_000
// Covers the adapter's bounded 30-second transport timeout plus one second of
// scheduling/serialization slack so the provider session cannot outlive the
// immutable order deadline.
const PROVIDER_SESSION_SAFETY_MARGIN_SECONDS = 31
const TERMINAL_ATTEMPT_STATES = new Set([
  "hard_decline",
  "technical_failure",
  "succeeded",
])
const SECRET_SHAPED_VALUE =
  /https?:\/\/|(?:^|[^a-z0-9])(?:client[_ -]?secret|api[_ -]?key|authorization|bearer|cvc|cvv|pan|token|return[_ -]?url|redirect[_ -]?url)(?:$|[^a-z0-9])|secret[a-z0-9_-]{4,}|(?:sk|pk|rk)[_-](?:live|test)[_-][a-z0-9_-]{4,}|(?:\d[ -]?){13,19}/iu

interface NeonPaymentRepositoryBaseOptions {
  readonly databaseUrl: string
  readonly pool?: Pool
  readonly faultInjector?: PaymentRepositoryFaultInjector
  readonly evidenceVerifier: HyperswitchV1EvidenceVerifier
}

export interface NeonPaymentEphemeralRepositoryOptions
  extends NeonPaymentRepositoryBaseOptions {
  readonly schema: string
  readonly appSchema?: never
}

export interface NeonPaymentAppRepositoryOptions
  extends NeonPaymentRepositoryBaseOptions {
  readonly schema?: never
  readonly appSchema: InventoryAppSchema
}

export type NeonPaymentRepositoryOptions = NeonPaymentEphemeralRepositoryOptions | NeonPaymentAppRepositoryOptions

export interface PaymentRepositoryFaultInjector {
  readonly onTransactionBackend?: (backendPid: number) => void
  readonly afterPaymentAllocated?: () => void | Promise<void>
  readonly afterPreCreateNotFoundLocked?: () => void | Promise<void>
  readonly afterAggregateOrderRead?: () => void | Promise<void>
  readonly afterTicketInsert?: (insertCount: number) => void
  readonly afterFulfillmentStaged?: () => void | Promise<void>
}

export interface PrepareCheckoutInput {
  readonly operationKey: string
  readonly requestHash: string
  readonly orderId: string
  readonly buyerRef: string
}

declare const serverCheckoutOperationHandleBrandV1: unique symbol

/**
 * Repository-only capability for binding provider evidence to one durable,
 * started checkout operation. The runtime fields are intentionally
 * non-enumerable so an accidental JSON serialization cannot disclose them.
 */
export interface ServerCheckoutOperationHandleV1 {
  readonly operationId: string
  readonly operationKey: string
  readonly [serverCheckoutOperationHandleBrandV1]: true
}

export type CheckoutDirectiveV1 =
  | "create_same_identity"
  | "retrieve_same_identity"
  | "replay_terminal"
  | "blocked_integrity"

export type CheckoutNotFoundPolicyV1 = "authorize_create_once" | "block_recreate"

export type CheckoutBlockedReasonV1 =
  | "integrity_review_required"
  | "operation_lineage_invalid"
  | "payment_deadline_expired"
  | "provider_create_reauthorization_blocked"
  | "terminal_operation_rejected"

export interface CheckoutRetrieveDirectiveV1 {
  readonly directive: "retrieve_same_identity"
  readonly operation: ServerCheckoutOperationHandleV1
  readonly onNotFound: CheckoutNotFoundPolicyV1
  readonly reason: null
}

export interface CheckoutCreateDirectiveV1 {
  readonly directive: "create_same_identity"
  readonly operation: ServerCheckoutOperationHandleV1
  readonly onNotFound: "block_recreate"
  readonly reason: null
  readonly providerSessionExpirySeconds: number
}

export interface CheckoutTerminalDirectiveV1 {
  readonly directive: "replay_terminal"
  readonly operation: null
  readonly onNotFound: null
  readonly reason: null
}

export interface CheckoutBlockedDirectiveV1 {
  readonly directive: "blocked_integrity"
  readonly operation: null
  readonly onNotFound: null
  readonly reason: CheckoutBlockedReasonV1
}

export type CheckoutExecutionDirectiveV1 =
  | CheckoutRetrieveDirectiveV1
  | CheckoutCreateDirectiveV1
  | CheckoutTerminalDirectiveV1
  | CheckoutBlockedDirectiveV1

interface PrepareCheckoutResultBase {
  readonly replayed: boolean
  readonly paymentId: string
  readonly orderId: string
  readonly providerPaymentRef: string
  readonly createState: "allocated" | "reconcile_required" | "created" | "rejected"
  readonly amountMinor: number
  readonly currency: string
  readonly itemCount: number
}

export type PrepareCheckoutResult = PrepareCheckoutResultBase & CheckoutExecutionDirectiveV1

export interface RecordPreCreateNotFoundInput {
  readonly operationKey: string
  readonly orderId: string
  readonly buyerRef: string
  readonly evidence: HyperswitchV1NotFoundReceipt
}

interface RecordPreCreateNotFoundResultBase {
  readonly replayed: boolean
  readonly paymentId: string
  readonly orderId: string
  readonly providerPaymentRef: string
  readonly createState: "allocated" | "reconcile_required" | "created" | "rejected"
}

export type RecordPreCreateNotFoundResult = RecordPreCreateNotFoundResultBase & CheckoutExecutionDirectiveV1

export interface BeginReconciliationInput {
  readonly operationKey: string
  readonly requestHash: string
  readonly orderId: string
  readonly buyerRef: string
}

interface BeginReconciliationResultBase {
  readonly replayed: boolean
  readonly paymentId: string
  readonly orderId: string
  readonly providerPaymentRef: string
}

export type BeginReconciliationResult = BeginReconciliationResultBase &
  (
    | CheckoutRetrieveDirectiveV1
    | CheckoutTerminalDirectiveV1
    | CheckoutBlockedDirectiveV1
  )

export interface ApplyPaymentObservationInput {
  readonly operationKey: string
  readonly orderId: string
  readonly buyerRef: string
  readonly observation: HyperswitchV1ObservationReceipt
}

export interface ApplyPaymentObservationResult {
  readonly replayed: boolean
  readonly paymentId: string
  readonly orderId: string
  readonly canonicalState: OnsalePaymentCanonicalStateV1
  readonly integrityState: "clear" | "review_required"
  readonly orderState: "awaiting_payment" | "payment_pending" | "paid" | "fulfilled" | "canceled"
  readonly observationPublicRef: string
  readonly successfulChargedAttemptCount: number
  readonly retainedTerminalSuccess: boolean
  readonly cascadeObserved: boolean
  readonly integrityIssues: readonly string[]
  readonly fulfillmentId: string | null
  readonly ticketCount: number
}

export type StoredPaymentAttemptStateV1 = "requires_method" | "action_required" | "processing" | "hard_decline" | "technical_failure" | "uncertain" | "succeeded"

export interface PaymentAggregateInspection {
  readonly order: {
    readonly id: string
    readonly state: "awaiting_payment" | "payment_pending" | "paid" | "fulfilled" | "canceled"
    readonly amountMinor: number
    readonly currency: string
    readonly itemCount: number
  }
  readonly paymentCount: number
  readonly payment: {
    readonly id: string
    readonly providerPaymentRef: string
    readonly createState: "allocated" | "reconcile_required" | "created" | "rejected"
    readonly canonicalState: OnsalePaymentCanonicalStateV1
    readonly integrityState: "clear" | "review_required"
    readonly amountMinor: number
    readonly currency: string
    readonly successfulAttemptId: string | null
  }
  readonly operations: readonly {
    readonly operationKey: string
    readonly commandKind: "ensure_checkout" | "reconcile_payment"
    readonly state: "started" | "completed" | "rejected"
    readonly outcomeCode: string | null
  }[]
  readonly observations: readonly {
    readonly publicRef: string
    readonly source: "create" | "retrieve"
    readonly providerStatus: string
    readonly canonicalState: OnsalePaymentCanonicalStateV1
    readonly selectedPaymentMethod: string | null
    readonly observedConnector: string | null
    readonly amountMinor: number | null
    readonly currency: string | null
    readonly successfulChargedAttemptCount: number
  }[]
  readonly attempts: readonly {
    readonly id: string
    readonly providerAttemptRef: `sha256:${string}`
    readonly canonicalState: StoredPaymentAttemptStateV1
    readonly observedConnector: string | null
  }[]
  readonly fulfillment: {
    readonly id: string
    readonly state: "issued"
  } | null
  readonly tickets: readonly {
    readonly id: string
    readonly orderItemId: string
    readonly seatId: string
    readonly state: "issued"
  }[]
}

export class PaymentRepositoryError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "PaymentRepositoryError"
    this.code = code
    this.details = details
  }
}

export class PaymentIdempotencyConflictError extends PaymentRepositoryError {
  constructor() {
    super(
      "IDEMPOTENCY_CONFLICT",
      "The checkout operation key is bound to a different request.",
    )
    this.name = "PaymentIdempotencyConflictError"
  }
}

interface OrderRow extends QueryResultRow {
  id: string
  dataset_id: string
  event_id: string
  buyer_ref: string
  state: PaymentAggregateInspection["order"]["state"]
  currency: string
  subtotal_minor: string | number
  fee_minor: string | number
  tax_minor: string | number
  total_minor: string | number
  payment_deadline_at: Date | string
}

interface OrderItemRow extends QueryResultRow {
  id: string
  seat_id: string
  total_minor: string | number
  face_value_minor: string | number
  fee_minor: string | number
  tax_minor: string | number
  currency: string
  allocation_state: string
  allocation_order_id: string | null
}

interface LockedOrder {
  readonly row: OrderRow
  readonly items: readonly OrderItemRow[]
  readonly amountMinor: number
  readonly currency: string
}

interface PaymentRow extends QueryResultRow {
  id: string
  order_id: string
  provider_payment_ref: string
  create_state: PaymentAggregateInspection["payment"]["createState"]
  canonical_state: "not_created" | "requires_payment_method" | "requires_customer_action" | "processing" | "unknown" | "failed" | "succeeded"
  integrity_state: "clear" | "review_required"
  amount_minor: string | number
  currency: string
  successful_attempt_id: string | null
  failed_at: Date | string | null
  succeeded_at: Date | string | null
}

interface CheckoutOperationRow extends QueryResultRow {
  id: string
  operation_key: string
  request_hash: string
  command_kind: "ensure_checkout" | "reconcile_payment"
  order_id: string
  payment_id: string
  state: "started" | "completed" | "rejected"
  outcome_code: string | null
}

interface AttemptRow extends QueryResultRow {
  id: string
  payment_id: string
  provider_attempt_ref_digest: string
  canonical_state: "requires_payment_method" | "requires_action" | "processing" | "hard_decline" | "technical_failure" | "unknown" | "succeeded"
  observed_connector: string | null
}

interface UpsertAttemptResult {
  readonly row: AttemptRow
  readonly contradiction: boolean
}

interface IssuedFulfillmentResult {
  readonly fulfillmentId: string
  readonly ticketCount: number
}

interface FulfillmentBundlePaymentRow extends QueryResultRow {
  id: string
  payment_id: string
}

interface IssuedFulfillmentRow extends QueryResultRow {
  id: string
  state: "issued"
}

interface PaymentDeadlineStateRow extends QueryResultRow {
  deadline_open: boolean
  remaining_seconds: string | number
}

interface TransactionTimings {
  readonly statementTimeoutMs?: number
  readonly lockTimeoutMs?: number
}

function integer(value: string | number, path: string): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new PaymentRepositoryError(
      "MONEY_INVARIANT",
      `${path} exceeds the JavaScript safe integer range.`,
    )
  }
  return parsed
}

function boundedProviderSessionExpirySeconds(
  deadline: PaymentDeadlineStateRow,
): number | null {
  const usableSeconds =
    integer(deadline.remaining_seconds, "payment deadline") -
    PROVIDER_SESSION_SAFETY_MARGIN_SECONDS
  return deadline.deadline_open && usableSeconds >= 1
    ? Math.min(900, usableSeconds)
    : null
}

function checkedSum(values: readonly number[], path: string): number {
  let total = 0
  for (const value of values) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_SAFE_MONEY_MINOR ||
      total > MAX_SAFE_MONEY_MINOR - value
    ) {
      throw new PaymentRepositoryError(
        "MONEY_INVARIANT",
        `${path} is outside the safe minor-unit range.`,
      )
    }
    total += value
  }
  return total
}

function assertUuid(value: string, path: string): void {
  if (!UUID.test(value)) {
    throw new PaymentRepositoryError(
      "INVALID_COMMAND",
      `${path} must be a UUID.`,
    )
  }
}

function assertRequestHash(value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new PaymentRepositoryError(
      "INVALID_COMMAND",
      "requestHash must be a lowercase SHA-256 digest.",
    )
  }
}

function assertBuyerRef(value: string): void {
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PaymentRepositoryError(
      "INVALID_COMMAND",
      "buyerRef must be a non-empty bounded string.",
    )
  }
}

function uuidV7(): string {
  const timestamp = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12)
  const chars = `${timestamp}${randomBytes(10).toString("hex")}`.split("")
  chars[12] = "7"
  chars[16] = (8 + (Number.parseInt(chars[16], 16) % 4)).toString(16)
  const value = chars.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function deterministicUuid(value: string): string {
  const chars = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("")
  chars[12] = "7"
  chars[16] = (8 + (Number.parseInt(chars[16], 16) % 4)).toString(16)
  const joined = chars.join("")
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

function providerPaymentRef(): string {
  return `pay_${randomBytes(13).toString("hex")}`
}

function domainHash(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex")
}

interface PostNotFoundSuccessorIdentity {
  readonly id: string
  readonly operationKey: string
  readonly requestHash: string
}

function postNotFoundSuccessorIdentity(
  predecessorOperationId: string,
  paymentId: string,
): PostNotFoundSuccessorIdentity {
  const binding = `${predecessorOperationId}:${paymentId}`
  return {
    id: deterministicUuid(`post-not-found-successor-id:${binding}`),
    operationKey: deterministicUuid(`post-not-found-successor-key:${binding}`),
    requestHash: domainHash("post-not-found-successor-request-v1", binding),
  }
}

function serverOperationHandle(
  operation: CheckoutOperationRow,
): ServerCheckoutOperationHandleV1 {
  if (operation.state !== "started") {
    throw new PaymentRepositoryError(
      "PAYMENT_INVARIANT",
      "Only a started checkout operation can become a provider evidence handle.",
    )
  }
  const handle = Object.create(null) as Record<PropertyKey, unknown>
  Object.defineProperties(handle, {
    operationId: {
      value: operation.id,
      enumerable: false,
      configurable: false,
      writable: false,
    },
    operationKey: {
      value: operation.operation_key,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  })
  return Object.freeze(handle) as unknown as ServerCheckoutOperationHandleV1
}

function retrieveDirective(
  operation: CheckoutOperationRow,
  onNotFound: CheckoutNotFoundPolicyV1,
): CheckoutRetrieveDirectiveV1 {
  return {
    directive: "retrieve_same_identity",
    operation: serverOperationHandle(operation),
    onNotFound,
    reason: null,
  }
}

function createDirective(
  operation: CheckoutOperationRow,
  providerSessionExpirySeconds: number,
): CheckoutCreateDirectiveV1 {
  if (
    !Number.isInteger(providerSessionExpirySeconds) ||
    providerSessionExpirySeconds < 1 ||
    providerSessionExpirySeconds > 900
  ) {
    throw new PaymentRepositoryError(
      "PAYMENT_INVARIANT",
      "Provider session expiry must be an integer from one to 900 seconds.",
    )
  }
  return {
    directive: "create_same_identity",
    operation: serverOperationHandle(operation),
    onNotFound: "block_recreate",
    reason: null,
    providerSessionExpirySeconds,
  }
}

function terminalDirective(): CheckoutTerminalDirectiveV1 {
  return {
    directive: "replay_terminal",
    operation: null,
    onNotFound: null,
    reason: null,
  }
}

function blockedDirective(
  reason: CheckoutBlockedReasonV1,
): CheckoutBlockedDirectiveV1 {
  return {
    directive: "blocked_integrity",
    operation: null,
    onNotFound: null,
    reason,
  }
}

function reconciliationDirective(
  payment: PaymentRow,
  operation: CheckoutOperationRow,
):
  | CheckoutRetrieveDirectiveV1
  | CheckoutTerminalDirectiveV1
  | CheckoutBlockedDirectiveV1 {
  if (payment.integrity_state === "review_required") {
    return blockedDirective("integrity_review_required")
  }
  if (payment.create_state === "rejected") {
    return blockedDirective("terminal_operation_rejected")
  }
  if (operation.state === "started") {
    return retrieveDirective(operation, "block_recreate")
  }
  if (operation.state === "rejected") {
    return blockedDirective("terminal_operation_rejected")
  }
  return operation.outcome_code === "observation_applied"
    ? terminalDirective()
    : blockedDirective("operation_lineage_invalid")
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Non-finite canonical JSON")
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

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function normalizedCanonicalForStatus(
  status: string,
): OnsalePaymentCanonicalStateV1 {
  if (
    [
      "requires_payment_method",
      "payment_method_awaited",
      "requires_confirmation",
    ].includes(status)
  ) {
    return "requires_method"
  }
  if (
    [
      "requires_customer_action",
      "requires_action",
      "authentication_pending",
    ].includes(status)
  ) {
    return "action_required"
  }
  if (
    [
      "processing",
      "pending",
      "started",
      "authorized",
      "authorizing",
      "confirmation_awaited",
      "requires_capture",
      "partially_captured",
    ].includes(status)
  ) {
    return "processing"
  }
  if (["succeeded", "charged", "captured"].includes(status)) {
    return "succeeded"
  }
  if (
    [
      "failed",
      "failure",
      "cancelled",
      "canceled",
      "voided",
      "declined",
      "hard_decline",
    ].includes(status)
  ) {
    return "exhausted"
  }
  return "uncertain"
}

function secretClean(value: string): boolean {
  return (
    !/[\u0000-\u001f\u007f]/u.test(value) && !SECRET_SHAPED_VALUE.test(value)
  )
}

function safeRetainedToken(value: unknown): value is string {
  return (
    typeof value === "string" && SAFE_TOKEN.test(value) && secretClean(value)
  )
}

function safeTokenOrNull(value: unknown): boolean {
  return value === null || safeRetainedToken(value)
}

function safeErrorOrNull(value: unknown): boolean {
  if (value === null) return true
  if (!plainRecord(value)) return false
  if (!exactKeys(value, ["class", "code", "unifiedCode", "message"])) {
    return false
  }
  if (
    ![
      "hard_decline",
      "payment_method",
      "technical",
      "configuration",
      "integration",
      "unknown",
    ].includes(String(value.class)) ||
    !(
      value.code === null ||
      (typeof value.code === "string" &&
        SAFE_ERROR_CODE.test(value.code) &&
        secretClean(value.code))
    ) ||
    !(
      value.unifiedCode === null ||
      (typeof value.unifiedCode === "string" &&
        SAFE_ERROR_CODE.test(value.unifiedCode) &&
        secretClean(value.unifiedCode))
    ) ||
    typeof value.message !== "string" ||
    !value.message ||
    value.message.length > 240 ||
    !secretClean(value.message)
  ) {
    return false
  }
  return true
}

function validAttempt(value: unknown, expectedIndex: number): boolean {
  if (!plainRecord(value)) return false
  if (
    !exactKeys(value as unknown as Record<string, unknown>, [
      "index",
      "providerAttemptRef",
      "providerStatus",
      "canonicalState",
      "charged",
      "hardDecline",
      "observedConnector",
      "amountMinor",
      "currency",
      "error",
    ])
  ) {
    return false
  }
  const canonicalStates = [
    "requires_method",
    "action_required",
    "processing",
    "succeeded",
    "exhausted",
    "uncertain",
  ]
  return (
    value.index === expectedIndex &&
    typeof value.providerAttemptRef === "string" &&
    SHA256_REF.test(value.providerAttemptRef) &&
    typeof value.providerStatus === "string" &&
    safeRetainedToken(value.providerStatus) &&
    canonicalStates.includes(String(value.canonicalState)) &&
    value.canonicalState ===
      normalizedCanonicalForStatus(value.providerStatus) &&
    typeof value.charged === "boolean" &&
    value.charged === (value.canonicalState === "succeeded") &&
    typeof value.hardDecline === "boolean" &&
    safeTokenOrNull(value.observedConnector) &&
    (value.amountMinor === null ||
      (typeof value.amountMinor === "number" &&
        Number.isSafeInteger(value.amountMinor) &&
        value.amountMinor >= 0 &&
        value.amountMinor <= MAX_SAFE_MONEY_MINOR)) &&
    (value.currency === null ||
      (typeof value.currency === "string" &&
        ISO_CURRENCY.test(value.currency))) &&
    safeErrorOrNull(value.error) &&
    value.hardDecline ===
      (value.providerStatus === "hard_decline" ||
        (plainRecord(value.error) && value.error.class === "hard_decline"))
  )
}

function assertNormalizedObservation(
  value: NormalizedPaymentObservationV1,
): void {
  const invalid = (): never => {
    throw new PaymentRepositoryError(
      "INVALID_NORMALIZED_OBSERVATION",
      "Only one strict, secret-clean normalized payment observation is accepted.",
    )
  }
  if (!plainRecord(value)) invalid()
  if (
    !exactKeys(value as unknown as Record<string, unknown>, [
      "schema",
      "source",
      "providerPaymentRef",
      "providerStatus",
      "canonicalState",
      "amountMinor",
      "currency",
      "selectedPaymentMethod",
      "observedConnector",
      "nextAction",
      "attempts",
      "successfulChargedAttemptCount",
      "hardDeclineObserved",
      "error",
      "observationHash",
    ]) ||
    value.schema !== "onsale.payment-observation.v1" ||
    !["create", "retrieve"].includes(value.source) ||
    !SHA256_REF.test(value.providerPaymentRef) ||
    !safeRetainedToken(value.providerStatus) ||
    value.canonicalState !==
      normalizedCanonicalForStatus(value.providerStatus) ||
    !Number.isSafeInteger(value.amountMinor) ||
    value.amountMinor < 0 ||
    value.amountMinor > MAX_SAFE_MONEY_MINOR ||
    !ISO_CURRENCY.test(value.currency) ||
    !safeTokenOrNull(value.observedConnector) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 32 ||
    typeof value.successfulChargedAttemptCount !== "number" ||
    typeof value.hardDeclineObserved !== "boolean" ||
    !safeErrorOrNull(value.error) ||
    !SHA256_REF.test(value.observationHash)
  ) {
    invalid()
  }
  if (
    value.selectedPaymentMethod !== null &&
    (!plainRecord(value.selectedPaymentMethod) ||
      !exactKeys(value.selectedPaymentMethod, ["family", "type"]) ||
      !safeTokenOrNull(value.selectedPaymentMethod.family) ||
      !safeTokenOrNull(value.selectedPaymentMethod.type) ||
      (!value.selectedPaymentMethod.family &&
        !value.selectedPaymentMethod.type))
  ) {
    invalid()
  }
  if (
    !plainRecord(value.nextAction) ||
    !exactKeys(value.nextAction, ["present", "kind"]) ||
    typeof value.nextAction.present !== "boolean" ||
    !safeTokenOrNull(value.nextAction.kind) ||
    (!value.nextAction.present && value.nextAction.kind !== null)
  ) {
    invalid()
  }
  if (
    value.attempts.some((attempt, index) => !validAttempt(attempt, index + 1))
  ) {
    invalid()
  }
  if (
    new Set(value.attempts.map((attempt) => attempt.providerAttemptRef))
      .size !== value.attempts.length ||
    value.successfulChargedAttemptCount !==
      value.attempts.filter((attempt) => attempt.charged).length ||
    value.hardDeclineObserved !==
      (value.providerStatus === "hard_decline" ||
        value.error?.class === "hard_decline" ||
        value.attempts.some((attempt) => attempt.hardDecline))
  ) {
    invalid()
  }
  const { observationHash, ...sanitized } = value
  const expected = `sha256:${domainHash(
    "onsale-payment-observation-v1",
    canonicalJson(sanitized),
  )}`
  if (observationHash !== expected) invalid()
}

function paymentStateToDomain(
  value: PaymentRow["canonical_state"],
): OnsalePaymentCanonicalStateV1 {
  switch (value) {
    case "requires_payment_method":
      return "requires_method"
    case "requires_customer_action":
      return "action_required"
    case "processing":
      return "processing"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "exhausted"
    case "not_created":
    case "unknown":
      return "uncertain"
  }
}

function domainStateToPayment(
  value: OnsalePaymentCanonicalStateV1,
): PaymentRow["canonical_state"] {
  switch (value) {
    case "requires_method":
      return "requires_payment_method"
    case "action_required":
      return "requires_customer_action"
    case "processing":
      return "processing"
    case "succeeded":
      return "succeeded"
    case "exhausted":
      return "failed"
    case "uncertain":
      return "unknown"
  }
}

function attemptStateToDatabase(
  attempt: NormalizedPaymentAttemptV1,
): AttemptRow["canonical_state"] {
  switch (attempt.canonicalState) {
    case "requires_method":
      return "requires_payment_method"
    case "action_required":
      return "requires_action"
    case "processing":
      return "processing"
    case "succeeded":
      return "succeeded"
    case "exhausted":
      return attempt.hardDecline ? "hard_decline" : "technical_failure"
    case "uncertain":
      return "unknown"
  }
}

function attemptStateToPublic(
  state: AttemptRow["canonical_state"],
): StoredPaymentAttemptStateV1 {
  switch (state) {
    case "requires_payment_method":
      return "requires_method"
    case "requires_action":
      return "action_required"
    case "processing":
      return "processing"
    case "hard_decline":
      return "hard_decline"
    case "technical_failure":
      return "technical_failure"
    case "unknown":
      return "uncertain"
    case "succeeded":
      return "succeeded"
  }
}

function observationErrorKind(
  observation: NormalizedPaymentObservationV1,
): string | null {
  if (!observation.error) return null
  return observation.error.class === "hard_decline"
    ? "payment_method"
    : observation.error.class
}

function attemptErrorKind(attempt: NormalizedPaymentAttemptV1): string | null {
  if (!attempt.error) return null
  return attempt.error.class === "hard_decline"
    ? "payment_method"
    : attempt.error.class
}

function selectedMethod(
  observation: NormalizedPaymentObservationV1,
): string | null {
  return (
    observation.selectedPaymentMethod?.type ??
    observation.selectedPaymentMethod?.family ??
    null
  )
}

function cascadeObserved(observation: NormalizedPaymentObservationV1): boolean {
  const connectors = new Set(
    observation.attempts
      .map((attempt) => attempt.observedConnector)
      .filter((connector): connector is string => connector !== null),
  )
  return observation.attempts.length > 1 && connectors.size > 1
}

function validateOperation(
  row: CheckoutOperationRow,
  input: {
    readonly operationKey: string
    readonly requestHash: string
    readonly commandKind: CheckoutOperationRow["command_kind"]
    readonly orderId: string
  },
): void {
  if (
    row.operation_key !== input.operationKey ||
    row.request_hash !== input.requestHash ||
    row.command_kind !== input.commandKind ||
    row.order_id !== input.orderId
  ) {
    throw new PaymentIdempotencyConflictError()
  }
}

export class NeonPaymentRepository {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly quotedSchema: string
  private readonly faultInjector: PaymentRepositoryFaultInjector
  private readonly evidenceVerifier: HyperswitchV1EvidenceVerifier

  constructor(options: NeonPaymentRepositoryOptions) {
    if (!options.databaseUrl || !options.databaseUrl.startsWith("postgres")) {
      throw new Error("A private Postgres DATABASE_URL is required.")
    }
    const hasEphemeralSchema = typeof options.schema === "string"
    const hasAppSchema = typeof options.appSchema === "string"
    if (hasEphemeralSchema === hasAppSchema) {
      throw new Error(
        "Exactly one validated payment namespace must be supplied.",
      )
    }
    this.quotedSchema = hasEphemeralSchema
      ? quoteEphemeralSchema(options.schema)
      : quoteInventoryAppSchema(options.appSchema)
    this.ownsPool = options.pool === undefined
    this.pool =
      options.pool ??
      new Pool({
        connectionString: options.databaseUrl,
        max: 8,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 5_000,
      })
    this.faultInjector = options.faultInjector ?? {}
    this.evidenceVerifier = options.evidenceVerifier
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
      const backend = await client.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      )
      const backendPid = backend.rows[0]?.pid
      if (typeof backendPid === "number") {
        this.faultInjector.onTransactionBackend?.(backendPid)
      }
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

  private async lockOrder(
    client: PoolClient,
    orderId: string,
    buyerRef: string,
  ): Promise<LockedOrder> {
    const orderResult = await client.query<OrderRow>(
      `select id, dataset_id, event_id, buyer_ref, state, currency,
              subtotal_minor, fee_minor, tax_minor, total_minor,
              payment_deadline_at
       from ${this.table("orders")}
       where id = $1
       for update`,
      [orderId],
    )
    const row = orderResult.rows[0]
    if (!row) {
      throw new PaymentRepositoryError(
        "ORDER_NOT_FOUND",
        "The order was not found.",
      )
    }
    if (row.buyer_ref !== buyerRef) {
      throw new PaymentRepositoryError(
        "ORDER_OWNERSHIP_MISMATCH",
        "The buyer does not own this order.",
      )
    }
    if (row.state === "canceled") {
      throw new PaymentRepositoryError(
        "ORDER_NOT_PAYABLE",
        "A canceled order cannot enter checkout.",
      )
    }
    const items = await client.query<OrderItemRow>(
      `select oi.id, oi.seat_id, oi.face_value_minor, oi.fee_minor,
              oi.tax_minor, oi.total_minor, oi.currency,
              a.state as allocation_state, a.order_id as allocation_order_id
       from ${this.table("order_item")} oi
       join ${this.table("seat_allocation")} a
         on a.id = oi.seat_allocation_id
       where oi.order_id = $1
       order by oi.id
       for share of oi, a`,
      [orderId],
    )
    if (items.rows.length < 1 || items.rows.length > 4) {
      throw new PaymentRepositoryError(
        "ORDER_INVARIANT",
        "Checkout requires one to four immutable order items.",
      )
    }
    if (
      items.rows.some(
        (item) =>
          item.allocation_state !== "reserved" ||
          item.allocation_order_id !== orderId,
      )
    ) {
      throw new PaymentRepositoryError(
        "ORDER_INVARIANT",
        "Every order item must retain its reserved allocation.",
      )
    }
    const currencies = new Set(items.rows.map((item) => item.currency))
    const subtotal = checkedSum(
      items.rows.map((item) => integer(item.face_value_minor, "item subtotal")),
      "item subtotal",
    )
    const fee = checkedSum(
      items.rows.map((item) => integer(item.fee_minor, "item fee")),
      "item fee",
    )
    const tax = checkedSum(
      items.rows.map((item) => integer(item.tax_minor, "item tax")),
      "item tax",
    )
    const total = checkedSum(
      items.rows.map((item) => integer(item.total_minor, "item total")),
      "item total",
    )
    if (
      currencies.size !== 1 ||
      !currencies.has(row.currency) ||
      subtotal !== integer(row.subtotal_minor, "order subtotal") ||
      fee !== integer(row.fee_minor, "order fee") ||
      tax !== integer(row.tax_minor, "order tax") ||
      total !== integer(row.total_minor, "order total") ||
      checkedSum([subtotal, fee, tax], "order total") !== total
    ) {
      throw new PaymentRepositoryError(
        "ORDER_INVARIANT",
        "Immutable order items and header money do not match.",
      )
    }
    return {
      row,
      items: items.rows,
      amountMinor: total,
      currency: row.currency,
    }
  }

  private async paymentDeadlineState(
    client: PoolClient,
    orderId: string,
  ): Promise<PaymentDeadlineStateRow> {
    const result = await client.query<PaymentDeadlineStateRow>(
      `with observed as materialized (
         select clock_timestamp() as observed_at
       )
       select observed.observed_at < orders.payment_deadline_at
                as deadline_open,
              floor(extract(epoch from (
                orders.payment_deadline_at - observed.observed_at
              )))::bigint as remaining_seconds
       from ${this.table("orders")} orders
       cross join observed
       where orders.id = $1`,
      [orderId],
    )
    const state = result.rows[0]
    if (!state) {
      throw new PaymentRepositoryError(
        "ORDER_NOT_FOUND",
        "The locked checkout order no longer exists.",
      )
    }
    return state
  }

  private async constrainCreateAuthorizationByDeadline(
    client: PoolClient,
    orderId: string,
    execution: CheckoutExecutionDirectiveV1,
  ): Promise<CheckoutExecutionDirectiveV1> {
    if (
      execution.directive !== "retrieve_same_identity" ||
      execution.onNotFound !== "authorize_create_once"
    ) {
      return execution
    }
    const deadline = await this.paymentDeadlineState(client, orderId)
    return boundedProviderSessionExpirySeconds(deadline) !== null
      ? execution
      : {
          ...execution,
          onNotFound: "block_recreate",
        }
  }

  private async getPaymentForOrder(
    client: PoolClient,
    orderId: string,
    lock = false,
  ): Promise<PaymentRow | undefined> {
    const result = await client.query<PaymentRow>(
      `select id, order_id, provider_payment_ref, create_state,
              canonical_state, integrity_state, amount_minor, currency,
              successful_attempt_id, failed_at, succeeded_at
       from ${this.table("provider_payment")}
       where order_id = $1
       ${lock ? "for update" : ""}`,
      [orderId],
    )
    return result.rows[0]
  }

  private async getOperation(
    client: PoolClient,
    operationKey: string,
    lock = false,
  ): Promise<CheckoutOperationRow | undefined> {
    const result = await client.query<CheckoutOperationRow>(
      `select id, operation_key, request_hash, command_kind, order_id,
              payment_id, state, outcome_code
       from ${this.table("checkout_operation")}
       where operation_key = $1
       ${lock ? "for update" : ""}`,
      [operationKey],
    )
    return result.rows[0]
  }

  private async getEnsureOperationsForPayment(
    client: PoolClient,
    paymentId: string,
  ): Promise<readonly CheckoutOperationRow[]> {
    const result = await client.query<CheckoutOperationRow>(
      `select id, operation_key, request_hash, command_kind, order_id,
              payment_id, state, outcome_code
       from ${this.table("checkout_operation")}
       where payment_id = $1 and command_kind = 'ensure_checkout'
       order by created_at, id
       for update`,
      [paymentId],
    )
    return result.rows
  }

  private async resolveFixedEnsureDirective(
    client: PoolClient,
    payment: PaymentRow,
  ): Promise<CheckoutExecutionDirectiveV1> {
    if (payment.integrity_state === "review_required") {
      return blockedDirective("integrity_review_required")
    }
    if (payment.create_state === "rejected") {
      return blockedDirective("terminal_operation_rejected")
    }

    const operations = await this.getEnsureOperationsForPayment(
      client,
      payment.id,
    )
    const fixedPredecessor = operations[0]
    if (!fixedPredecessor) {
      return blockedDirective("operation_lineage_invalid")
    }
    const notFoundPredecessors = operations.filter(
      (operation) => operation.outcome_code === "provider_not_found",
    )
    if (
      notFoundPredecessors.length > 1 ||
      (notFoundPredecessors.length === 1 &&
        notFoundPredecessors[0]?.id !== fixedPredecessor.id)
    ) {
      return blockedDirective("operation_lineage_invalid")
    }

    if (fixedPredecessor.state === "started") {
      if (operations.length !== 1) {
        return blockedDirective("operation_lineage_invalid")
      }
      if (["succeeded", "failed"].includes(payment.canonical_state)) {
        return terminalDirective()
      }
      return retrieveDirective(
        fixedPredecessor,
        ["allocated", "reconcile_required"].includes(payment.create_state)
          ? "authorize_create_once"
          : "block_recreate",
      )
    }
    if (fixedPredecessor.state === "rejected") {
      return blockedDirective("terminal_operation_rejected")
    }
    if (fixedPredecessor.outcome_code !== "provider_not_found") {
      if (operations.length !== 1) {
        return blockedDirective("operation_lineage_invalid")
      }
      return fixedPredecessor.outcome_code === "observation_applied"
        ? terminalDirective()
        : blockedDirective("operation_lineage_invalid")
    }

    const expectedSuccessor = postNotFoundSuccessorIdentity(
      fixedPredecessor.id,
      payment.id,
    )
    if (operations.length !== 2) {
      return blockedDirective("operation_lineage_invalid")
    }
    const successor = operations.find(
      (operation) =>
        operation.id === expectedSuccessor.id ||
        operation.operation_key === expectedSuccessor.operationKey,
    )
    if (
      !successor ||
      successor.id !== expectedSuccessor.id ||
      successor.operation_key !== expectedSuccessor.operationKey ||
      successor.request_hash !== expectedSuccessor.requestHash ||
      successor.command_kind !== "ensure_checkout" ||
      successor.order_id !== fixedPredecessor.order_id ||
      successor.payment_id !== payment.id
    ) {
      return blockedDirective("operation_lineage_invalid")
    }
    if (successor.state === "started") {
      return retrieveDirective(successor, "block_recreate")
    }
    if (successor.state === "rejected") {
      return blockedDirective("terminal_operation_rejected")
    }
    return successor.outcome_code === "observation_applied"
      ? terminalDirective()
      : blockedDirective("operation_lineage_invalid")
  }

  async prepareCheckout(
    input: PrepareCheckoutInput,
  ): Promise<PrepareCheckoutResult> {
    assertUuid(input.operationKey, "operationKey")
    assertUuid(input.orderId, "orderId")
    assertRequestHash(input.requestHash)
    assertBuyerRef(input.buyerRef)

    return this.transaction(async (client) => {
      const order = await this.lockOrder(client, input.orderId, input.buyerRef)
      const existingOperation = await this.getOperation(
        client,
        input.operationKey,
        true,
      )
      if (existingOperation) {
        validateOperation(existingOperation, {
          ...input,
          commandKind: "ensure_checkout",
        })
        const payment = await this.getPaymentForOrder(
          client,
          input.orderId,
          true,
        )
        if (!payment || payment.id !== existingOperation.payment_id) {
          throw new PaymentRepositoryError(
            "PAYMENT_INVARIANT",
            "The checkout operation lost its stable payment identity.",
          )
        }
        const resolvedExecution = await this.resolveFixedEnsureDirective(
          client,
          payment,
        )
        const execution = await this.constrainCreateAuthorizationByDeadline(
          client,
          input.orderId,
          resolvedExecution,
        )
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: order.row.id,
          providerPaymentRef: payment.provider_payment_ref,
          createState: payment.create_state,
          amountMinor: order.amountMinor,
          currency: order.currency,
          itemCount: order.items.length,
          ...execution,
        }
      }

      let payment = await this.getPaymentForOrder(client, input.orderId, true)
      let allocatedPaymentNow = false
      if (!payment) {
        const deadline = await this.paymentDeadlineState(client, input.orderId)
        if (boundedProviderSessionExpirySeconds(deadline) === null) {
          throw new PaymentRepositoryError(
            "PAYMENT_DEADLINE_EXPIRED",
            "The order payment deadline passed before payment preparation.",
          )
        }
        if (order.row.state !== "awaiting_payment") {
          throw new PaymentRepositoryError(
            "ORDER_NOT_PAYABLE",
            "A new payment identity may be allocated only from awaiting_payment.",
          )
        }
        const paymentId = uuidV7()
        const providerRef = providerPaymentRef()
        const inserted = await client.query<PaymentRow>(
          `insert into ${this.table("provider_payment")} (
             id, dataset_id, event_id, order_id, provider, environment,
             api_version, provider_payment_ref, create_state, canonical_state,
             amount_minor, currency
           ) values (
             $1, $2, $3, $4, 'hyperswitch', 'sandbox', 'v1', $5,
             'reconcile_required', 'not_created', $6, $7
           )
           returning id, order_id, provider_payment_ref, create_state,
                     canonical_state, integrity_state, amount_minor, currency,
                     successful_attempt_id, failed_at, succeeded_at`,
          [
            paymentId,
            order.row.dataset_id,
            order.row.event_id,
            order.row.id,
            providerRef,
            order.amountMinor,
            order.currency,
          ],
        )
        payment = inserted.rows[0]
        allocatedPaymentNow = true
        await this.faultInjector.afterPaymentAllocated?.()
      } else {
        if (
          integer(payment.amount_minor, "payment amount") !==
            order.amountMinor ||
          payment.currency !== order.currency
        ) {
          throw new PaymentRepositoryError(
            "PAYMENT_INVARIANT",
            "Stable payment money differs from immutable order money.",
          )
        }
        if (payment.create_state === "rejected") {
          throw new PaymentRepositoryError(
            "CREATE_STATE_CONFLICT",
            "The stable provider identity was rejected.",
          )
        }
      }
      if (!payment) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "Stable payment allocation failed.",
        )
      }
      if (!allocatedPaymentNow) {
        const ensureOperations = await this.getEnsureOperationsForPayment(
          client,
          payment.id,
        )
        if (ensureOperations.length > 0) {
          const resolvedExecution = await this.resolveFixedEnsureDirective(
            client,
            payment,
          )
          const execution = await this.constrainCreateAuthorizationByDeadline(
            client,
            input.orderId,
            resolvedExecution,
          )
          return {
            replayed: true,
            paymentId: payment.id,
            orderId: order.row.id,
            providerPaymentRef: payment.provider_payment_ref,
            createState: payment.create_state,
            amountMinor: order.amountMinor,
            currency: order.currency,
            itemCount: order.items.length,
            ...execution,
          }
        }
        const deadline = await this.paymentDeadlineState(client, input.orderId)
        if (boundedProviderSessionExpirySeconds(deadline) === null) {
          return {
            replayed: true,
            paymentId: payment.id,
            orderId: order.row.id,
            providerPaymentRef: payment.provider_payment_ref,
            createState: payment.create_state,
            amountMinor: order.amountMinor,
            currency: order.currency,
            itemCount: order.items.length,
            ...blockedDirective("payment_deadline_expired"),
          }
        }
      }
      if (order.row.state === "awaiting_payment") {
        await client.query(
          `update ${this.table("orders")}
           set state = 'payment_pending', version = version + 1
           where id = $1 and state = 'awaiting_payment'`,
          [order.row.id],
        )
      }
      const operationId = uuidV7()
      await client.query(
        `insert into ${this.table("checkout_operation")} (
           id, operation_key, request_hash, command_kind, order_id, payment_id,
           state
         ) values ($1, $2, $3, 'ensure_checkout', $4, $5, 'started')`,
        [
          operationId,
          input.operationKey,
          input.requestHash,
          order.row.id,
          payment.id,
        ],
      )
      const resolvedExecution = await this.resolveFixedEnsureDirective(
        client,
        payment,
      )
      const execution = await this.constrainCreateAuthorizationByDeadline(
        client,
        input.orderId,
        resolvedExecution,
      )
      return {
        replayed: false,
        paymentId: payment.id,
        orderId: order.row.id,
        providerPaymentRef: payment.provider_payment_ref,
        createState: payment.create_state,
        amountMinor: order.amountMinor,
        currency: order.currency,
        itemCount: order.items.length,
        ...execution,
      }
    })
  }

  async recordPreCreateNotFound(
    input: RecordPreCreateNotFoundInput,
  ): Promise<RecordPreCreateNotFoundResult> {
    assertUuid(input.operationKey, "operationKey")
    assertUuid(input.orderId, "orderId")
    assertBuyerRef(input.buyerRef)
    const notFoundEvidence = this.evidenceVerifier.require(input.evidence)
    if (notFoundEvidence.kind !== "retrieve_not_found") {
      throw new PaymentRepositoryError(
        "PROVIDER_EVIDENCE_SOURCE_MISMATCH",
        "Provider not-found recovery requires an attested retrieve 404.",
      )
    }
    return this.transaction(async (client) => {
      await this.lockOrder(client, input.orderId, input.buyerRef)
      const operation = await this.getOperation(
        client,
        input.operationKey,
        true,
      )
      if (!operation || operation.order_id !== input.orderId) {
        throw new PaymentRepositoryError(
          "OPERATION_NOT_FOUND",
          "The bound checkout operation was not found.",
        )
      }
      const payment = await this.getPaymentForOrder(client, input.orderId, true)
      if (!payment || payment.id !== operation.payment_id) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "The operation is not bound to the stable payment identity.",
        )
      }
      const expectedPaymentHash = `sha256:${domainHash(
        "onsale-provider-payment-v1",
        payment.provider_payment_ref,
      )}`
      if (notFoundEvidence.providerPaymentRef !== expectedPaymentHash) {
        throw new PaymentRepositoryError(
          "PAYMENT_IDENTITY_MISMATCH",
          "The provider not-found receipt belongs to a different payment identity.",
        )
      }

      const currentExecution = await this.resolveFixedEnsureDirective(
        client,
        payment,
      )
      if (
        currentExecution.directive === "replay_terminal" ||
        currentExecution.directive === "blocked_integrity"
      ) {
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: input.orderId,
          providerPaymentRef: payment.provider_payment_ref,
          createState: payment.create_state,
          ...currentExecution,
        }
      }
      if (
        operation.state === "completed" &&
        operation.outcome_code === "provider_not_found"
      ) {
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: input.orderId,
          providerPaymentRef: payment.provider_payment_ref,
          createState: payment.create_state,
          ...currentExecution,
        }
      }
      if (
        currentExecution.directive !== "retrieve_same_identity" ||
        currentExecution.onNotFound !== "authorize_create_once" ||
        currentExecution.operation.operationId !== operation.id ||
        operation.state !== "started" ||
        operation.command_kind !== "ensure_checkout" ||
        !["allocated", "reconcile_required"].includes(payment.create_state)
      ) {
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: input.orderId,
          providerPaymentRef: payment.provider_payment_ref,
          createState: payment.create_state,
          ...blockedDirective("provider_create_reauthorization_blocked"),
        }
      }

      await this.faultInjector.afterPreCreateNotFoundLocked?.()

      const deadline = await this.paymentDeadlineState(client, input.orderId)
      const providerSessionExpirySeconds =
        boundedProviderSessionExpirySeconds(deadline)
      if (providerSessionExpirySeconds === null) {
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: input.orderId,
          providerPaymentRef: payment.provider_payment_ref,
          createState: payment.create_state,
          ...blockedDirective("payment_deadline_expired"),
        }
      }

      const storedEvidence = await client.query<{
        observation_count: string
        attempt_count: string
      }>(
        `select
           (select count(*) from ${this.table("payment_observation")}
            where payment_id = $1)::text as observation_count,
           (select count(*) from ${this.table("payment_attempt")}
            where payment_id = $1)::text as attempt_count`,
        [payment.id],
      )
      const counts = storedEvidence.rows[0]
      if (
        !counts ||
        Number(counts.observation_count) > 0 ||
        Number(counts.attempt_count) > 0
      ) {
        throw new PaymentRepositoryError(
          "CREATE_STATE_CONFLICT",
          "Provider not-found cannot erase an observed payment or attempt.",
        )
      }
      if (payment.create_state === "allocated") {
        await client.query(
          `update ${this.table("provider_payment")}
           set create_state = 'reconcile_required', version = version + 1,
               updated_at = clock_timestamp()
           where id = $1`,
          [payment.id],
        )
      }
      const successorIdentity = postNotFoundSuccessorIdentity(
        operation.id,
        payment.id,
      )
      const completed = await client.query(
        `update ${this.table("checkout_operation")}
         set state = 'completed', outcome_code = 'provider_not_found',
             completed_at = clock_timestamp()
         where id = $1 and state = 'started'`,
        [operation.id],
      )
      if (completed.rowCount !== 1) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "The not-found predecessor did not become terminal.",
        )
      }
      await client.query(
        `insert into ${this.table("checkout_operation")} (
           id, operation_key, request_hash, command_kind, order_id, payment_id,
           state
         ) values ($1, $2, $3, 'ensure_checkout', $4, $5, 'started')`,
        [
          successorIdentity.id,
          successorIdentity.operationKey,
          successorIdentity.requestHash,
          input.orderId,
          payment.id,
        ],
      )
      const successor = await this.getOperation(
        client,
        successorIdentity.operationKey,
        true,
      )
      if (!successor) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "The provider create authorization was not durably bound.",
        )
      }
      return {
        replayed: false,
        paymentId: payment.id,
        orderId: input.orderId,
        providerPaymentRef: payment.provider_payment_ref,
        createState: "reconcile_required",
        ...createDirective(successor, providerSessionExpirySeconds),
      }
    })
  }

  async beginReconciliation(
    input: BeginReconciliationInput,
  ): Promise<BeginReconciliationResult> {
    assertUuid(input.operationKey, "operationKey")
    assertUuid(input.orderId, "orderId")
    assertRequestHash(input.requestHash)
    assertBuyerRef(input.buyerRef)
    return this.transaction(async (client) => {
      await this.lockOrder(client, input.orderId, input.buyerRef)
      const existing = await this.getOperation(client, input.operationKey, true)
      if (existing) {
        validateOperation(existing, {
          ...input,
          commandKind: "reconcile_payment",
        })
        const payment = await this.getPaymentForOrder(
          client,
          input.orderId,
          true,
        )
        if (!payment || payment.id !== existing.payment_id) {
          throw new PaymentRepositoryError(
            "PAYMENT_INVARIANT",
            "The reconciliation operation lost its payment identity.",
          )
        }
        let replayOperation = existing
        if (
          payment.integrity_state === "review_required" &&
          existing.state === "started"
        ) {
          const terminalized = await client.query<CheckoutOperationRow>(
            `update ${this.table("checkout_operation")}
             set state = 'rejected',
                 outcome_code = 'integrity_review_required',
                 completed_at = clock_timestamp()
             where id = $1 and state = 'started'
             returning id, operation_key, request_hash, command_kind,
                       order_id, payment_id, state, outcome_code`,
            [existing.id],
          )
          const terminalizedOperation = terminalized.rows[0]
          if (!terminalizedOperation) {
            throw new PaymentRepositoryError(
              "PAYMENT_INVARIANT",
              "The integrity-blocked reconciliation did not become terminal.",
            )
          }
          replayOperation = terminalizedOperation
        }
        const execution = reconciliationDirective(payment, replayOperation)
        return {
          replayed: true,
          paymentId: payment.id,
          orderId: input.orderId,
          providerPaymentRef: payment.provider_payment_ref,
          ...execution,
        }
      }
      const payment = await this.getPaymentForOrder(client, input.orderId, true)
      if (!payment) {
        throw new PaymentRepositoryError(
          "PAYMENT_NOT_PREPARED",
          "Checkout must allocate one stable payment before reconciliation.",
        )
      }
      const operationId = uuidV7()
      if (payment.integrity_state === "review_required") {
        await client.query(
          `insert into ${this.table("checkout_operation")} (
             id, operation_key, request_hash, command_kind, order_id,
             payment_id, state, outcome_code, completed_at
           ) values (
             $1, $2, $3, 'reconcile_payment', $4, $5, 'rejected',
             'integrity_review_required', clock_timestamp()
           )`,
          [
            operationId,
            input.operationKey,
            input.requestHash,
            input.orderId,
            payment.id,
          ],
        )
      } else {
        await client.query(
          `insert into ${this.table("checkout_operation")} (
             id, operation_key, request_hash, command_kind, order_id,
             payment_id, state
           ) values ($1, $2, $3, 'reconcile_payment', $4, $5, 'started')`,
          [
            operationId,
            input.operationKey,
            input.requestHash,
            input.orderId,
            payment.id,
          ],
        )
      }
      const operation = await this.getOperation(
        client,
        input.operationKey,
        true,
      )
      if (!operation) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "The reconciliation operation was not durably bound.",
        )
      }
      const execution = reconciliationDirective(payment, operation)
      return {
        replayed: false,
        paymentId: payment.id,
        orderId: input.orderId,
        providerPaymentRef: payment.provider_payment_ref,
        ...execution,
      }
    })
  }

  private async upsertAttempt(
    client: PoolClient,
    paymentId: string,
    attempt: NormalizedPaymentAttemptV1,
  ): Promise<UpsertAttemptResult> {
    const digest = attempt.providerAttemptRef.slice("sha256:".length)
    const incomingState = attemptStateToDatabase(attempt)
    const existing = await client.query<AttemptRow>(
      `select id, payment_id, provider_attempt_ref_digest, canonical_state,
              observed_connector
       from ${this.table("payment_attempt")}
       where payment_id = $1 and provider_attempt_ref_digest = $2
       for update`,
      [paymentId, digest],
    )
    const current = existing.rows[0]
    if (!current) {
      const id = deterministicUuid(`payment-attempt:${paymentId}:${digest}`)
      const inserted = await client.query<AttemptRow>(
        `insert into ${this.table("payment_attempt")} (
           id, payment_id, provider_attempt_ref_digest, canonical_state,
           observed_connector, first_observed_at, last_observed_at, terminal_at
         ) values (
           $1, $2, $3, $4, $5, statement_timestamp(), statement_timestamp(),
           case when $4 in ('hard_decline', 'technical_failure', 'succeeded')
                then statement_timestamp() else null end
         )
         returning id, payment_id, provider_attempt_ref_digest,
                   canonical_state, observed_connector`,
        [id, paymentId, digest, incomingState, attempt.observedConnector],
      )
      const row = inserted.rows[0]
      if (!row) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "Payment attempt insertion returned no row.",
        )
      }
      return { row, contradiction: false }
    }
    if (TERMINAL_ATTEMPT_STATES.has(current.canonical_state)) {
      const contradiction =
        current.canonical_state !== incomingState ||
        (current.observed_connector !== null &&
          attempt.observedConnector !== null &&
          current.observed_connector !== attempt.observedConnector)
      await client.query(
        `update ${this.table("payment_attempt")}
         set last_observed_at = clock_timestamp()
         where id = $1`,
        [current.id],
      )
      return { row: current, contradiction }
    }
    const connectorContradiction =
      current.observed_connector !== null &&
      attempt.observedConnector !== null &&
      current.observed_connector !== attempt.observedConnector
    const updated = await client.query<AttemptRow>(
      `update ${this.table("payment_attempt")}
       set canonical_state = $2,
           observed_connector = case
             when observed_connector is null then $3
             else observed_connector
           end,
           last_observed_at = clock_timestamp(),
           terminal_at = case
             when $2 in ('hard_decline', 'technical_failure', 'succeeded')
               then coalesce(terminal_at, clock_timestamp())
             else null
           end
       where id = $1
       returning id, payment_id, provider_attempt_ref_digest,
                 canonical_state, observed_connector`,
      [current.id, incomingState, attempt.observedConnector],
    )
    return {
      row: updated.rows[0] ?? current,
      contradiction: connectorContradiction,
    }
  }

  private async issueFulfillment(
    client: PoolClient,
    order: LockedOrder,
    paymentId: string,
  ): Promise<IssuedFulfillmentResult> {
    if (order.row.state === "fulfilled") {
      const existing = await client.query<{
        id: string
        payment_id: string
        ticket_count: string
      }>(
        `select fb.id, fb.payment_id,
                (select count(*)::text
                 from ${this.table("ticket")} t
                 where t.fulfillment_id = fb.id
                   and t.order_id = fb.order_id) as ticket_count
         from ${this.table("fulfillment_bundle")} fb
         where fb.order_id = $1`,
        [order.row.id],
      )
      const bundle = existing.rows[0]
      const ticketCount = Number(bundle?.ticket_count ?? -1)
      if (
        !bundle ||
        bundle.payment_id !== paymentId ||
        ticketCount !== order.items.length
      ) {
        throw new PaymentRepositoryError(
          "FULFILLMENT_INVARIANT",
          "The terminal order does not retain its exact fulfillment proof.",
        )
      }
      await client.query(
        `select ${this.quotedSchema}.assert_fulfillment_bundle_complete($1::uuid)`,
        [bundle.id],
      )
      return { fulfillmentId: bundle.id, ticketCount }
    }

    await client.query(
      `update ${this.table("orders")}
       set state = 'paid', version = version + 1
       where id = $1 and state in ('awaiting_payment', 'payment_pending')`,
      [order.row.id],
    )
    const fulfillmentId = deterministicUuid(
      `fulfillment:${order.row.id}:${paymentId}`,
    )
    await client.query(
      `insert into ${this.table("fulfillment_bundle")} (
         id, order_id, payment_id, state
       ) values ($1, $2, $3, 'issued')
       on conflict (order_id) do nothing`,
      [fulfillmentId, order.row.id, paymentId],
    )
    const bundle = await client.query<FulfillmentBundlePaymentRow>(
      `select id, payment_id
       from ${this.table("fulfillment_bundle")}
       where order_id = $1
       for update`,
      [order.row.id],
    )
    const bundleRow = bundle.rows[0]
    if (!bundleRow || bundleRow.payment_id !== paymentId) {
      throw new PaymentRepositoryError(
        "FULFILLMENT_INVARIANT",
        "The order is bound to a different fulfillment payment.",
      )
    }
    let insertedCount = 0
    for (const item of order.items) {
      const ticketId = deterministicUuid(`ticket:${bundleRow.id}:${item.id}`)
      const inserted = await client.query(
        `insert into ${this.table("ticket")} (
           id, fulfillment_id, order_id, order_item_id, seat_id, state
         ) values ($1, $2, $3, $4, $5, 'issued')
         on conflict (order_item_id) do nothing`,
        [ticketId, bundleRow.id, order.row.id, item.id, item.seat_id],
      )
      if ((inserted.rowCount ?? 0) > 0) {
        insertedCount += 1
        this.faultInjector.afterTicketInsert?.(insertedCount)
      }
    }
    await client.query(
      `update ${this.table("orders")}
       set state = 'fulfilled', version = version + 1
       where id = $1 and state = 'paid'`,
      [order.row.id],
    )
    const count = await client.query<{ count: string }>(
      `select count(*)::text as count
       from ${this.table("ticket")}
       where fulfillment_id = $1 and order_id = $2`,
      [bundleRow.id, order.row.id],
    )
    const ticketCount = Number(count.rows[0]?.count ?? -1)
    if (ticketCount !== order.items.length) {
      throw new PaymentRepositoryError(
        "FULFILLMENT_INVARIANT",
        "Ticket cardinality does not equal immutable order-item cardinality.",
      )
    }
    await client.query(
      `select ${this.quotedSchema}.assert_fulfillment_bundle_complete($1::uuid)`,
      [bundleRow.id],
    )
    await this.faultInjector.afterFulfillmentStaged?.()
    return { fulfillmentId: bundleRow.id, ticketCount }
  }

  private async isCreateAuthorizedOperation(
    client: PoolClient,
    operation: CheckoutOperationRow,
    paymentId: string,
  ): Promise<boolean> {
    if (operation.command_kind !== "ensure_checkout") return false
    const ensureOperations = await client.query<{
      id: string
      outcome_code: string | null
    }>(
      `select id, outcome_code
       from ${this.table("checkout_operation")}
       where payment_id = $1
         and command_kind = 'ensure_checkout'
       order by created_at, id`,
      [paymentId],
    )
    const fixedPredecessor = ensureOperations.rows[0]
    const notFoundPredecessors = ensureOperations.rows.filter(
      (candidate) => candidate.outcome_code === "provider_not_found",
    )
    if (
      !fixedPredecessor ||
      ensureOperations.rows.length !== 2 ||
      notFoundPredecessors.length !== 1 ||
      notFoundPredecessors[0]?.id !== fixedPredecessor.id
    ) {
      return false
    }
    const expected = postNotFoundSuccessorIdentity(
      fixedPredecessor.id,
      paymentId,
    )
    return (
      operation.id === expected.id &&
      operation.operation_key === expected.operationKey &&
      operation.request_hash === expected.requestHash
    )
  }

  async applyObservation(
    input: ApplyPaymentObservationInput,
  ): Promise<ApplyPaymentObservationResult> {
    assertUuid(input.operationKey, "operationKey")
    assertUuid(input.orderId, "orderId")
    assertBuyerRef(input.buyerRef)
    const verifiedEvidence = this.evidenceVerifier.require(input.observation)
    if (verifiedEvidence.kind === "retrieve_not_found") {
      throw new PaymentRepositoryError(
        "PROVIDER_EVIDENCE_SOURCE_MISMATCH",
        "A provider not-found receipt is not a payment observation.",
      )
    }
    const observation = verifiedEvidence.observation
    assertNormalizedObservation(observation)
    const evidenceSource =
      verifiedEvidence.kind === "create_observation" ? "create" : "retrieve"
    if (observation.source !== evidenceSource) {
      throw new PaymentRepositoryError(
        "PROVIDER_EVIDENCE_SOURCE_MISMATCH",
        "The attested transport method and normalized source disagree.",
      )
    }

    return this.transaction(async (client) => {
      const order = await this.lockOrder(client, input.orderId, input.buyerRef)
      const operation = await this.getOperation(
        client,
        input.operationKey,
        true,
      )
      if (!operation || operation.order_id !== input.orderId) {
        throw new PaymentRepositoryError(
          "OPERATION_NOT_FOUND",
          "The bound checkout operation was not found.",
        )
      }
      const payment = await this.getPaymentForOrder(client, input.orderId, true)
      if (!payment || payment.id !== operation.payment_id) {
        throw new PaymentRepositoryError(
          "PAYMENT_INVARIANT",
          "The operation is not bound to the stable payment identity.",
        )
      }
      const expectedPaymentHash = `sha256:${domainHash(
        "onsale-provider-payment-v1",
        payment.provider_payment_ref,
      )}`
      if (observation.providerPaymentRef !== expectedPaymentHash) {
        throw new PaymentRepositoryError(
          "PAYMENT_IDENTITY_MISMATCH",
          "The observation belongs to a different provider payment identity.",
        )
      }
      const createAuthorized =
        evidenceSource === "create" &&
        (await this.isCreateAuthorizedOperation(client, operation, payment.id))
      if (
        (evidenceSource === "create" && !createAuthorized) ||
        (evidenceSource === "retrieve" &&
          !["ensure_checkout", "reconcile_payment"].includes(
            operation.command_kind,
          ))
      ) {
        throw new PaymentRepositoryError(
          "OBSERVATION_SOURCE_MISMATCH",
          "The observation source does not match its bound operation.",
        )
      }
      if (operation.state !== "started") {
        const existingObservation = await client.query<{ public_ref: string }>(
          `select public_ref
           from ${this.table("payment_observation")}
           where checkout_operation_id = $1`,
          [operation.id],
        )
        if (!existingObservation.rows[0]) {
          throw new PaymentRepositoryError(
            "OPERATION_TERMINAL",
            "The terminal operation has no replayable observation.",
          )
        }
        const expectedPublicRef = deterministicUuid(
          `payment-observation-public:${payment.id}:${operation.id}:${observation.observationHash}`,
        )
        if (existingObservation.rows[0].public_ref !== expectedPublicRef) {
          throw new PaymentIdempotencyConflictError()
        }
        const aggregate = await this.inspectWithClient(client, input.orderId)
        if (!aggregate) {
          throw new PaymentRepositoryError(
            "PAYMENT_INVARIANT",
            "The replay aggregate was not found.",
          )
        }
        return this.resultFromAggregate(
          aggregate,
          existingObservation.rows[0].public_ref,
          true,
          [],
          false,
        )
      }

      const observationId = deterministicUuid(
        `payment-observation:${payment.id}:${operation.id}:${observation.observationHash}`,
      )
      const observationPublicRef = deterministicUuid(
        `payment-observation-public:${payment.id}:${operation.id}:${observation.observationHash}`,
      )
      await client.query(
        `insert into ${this.table("payment_observation")} (
           id, public_ref, payment_id, checkout_operation_id, source,
           provider_status, canonical_state, selected_payment_method,
           observed_connector, observed_amount_minor, observed_currency,
           charged_attempt_count, error_kind, error_code, unified_error_code,
           evidence_class
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, 'runtime_observation'
         )`,
        [
          observationId,
          observationPublicRef,
          payment.id,
          operation.id,
          evidenceSource === "create" ? "create_response" : "retrieve_response",
          observation.providerStatus,
          domainStateToPayment(observation.canonicalState),
          selectedMethod(observation),
          observation.observedConnector,
          observation.amountMinor,
          observation.currency,
          observation.successfulChargedAttemptCount,
          observationErrorKind(observation),
          observation.error?.code ?? null,
          observation.error?.unifiedCode ?? null,
        ],
      )

      let attemptContradiction = false
      for (const attempt of observation.attempts) {
        const upserted = await this.upsertAttempt(client, payment.id, attempt)
        attemptContradiction ||= upserted.contradiction
        await client.query(
          `insert into ${this.table("payment_attempt_observation")} (
             payment_observation_id, payment_attempt_id, payment_id,
             attempt_ordinal, canonical_state, observed_connector, error_kind,
             error_code, unified_error_code
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            observationId,
            upserted.row.id,
            payment.id,
            attempt.index,
            attemptStateToDatabase(attempt),
            attempt.observedConnector,
            attemptErrorKind(attempt),
            attempt.error?.code ?? null,
            attempt.error?.unifiedCode ?? null,
          ],
        )
      }

      const storedSucceeded = await client.query<{ id: string }>(
        `select id
         from ${this.table("payment_attempt")}
         where payment_id = $1 and canonical_state = 'succeeded'
         order by id`,
        [payment.id],
      )
      const succeededRetrieveEvidence = await client.query<{ count: string }>(
        `select count(distinct pa.id)::text as count
         from ${this.table("payment_attempt")} pa
         join ${this.table("payment_attempt_observation")} pao
           on pao.payment_attempt_id = pa.id
          and pao.payment_id = pa.payment_id
          and pao.canonical_state = 'succeeded'
         join ${this.table("payment_observation")} po
           on po.id = pao.payment_observation_id
          and po.payment_id = pa.payment_id
          and po.source in ('retrieve_response', 'verified_webhook')
         where pa.payment_id = $1 and pa.canonical_state = 'succeeded'`,
        [payment.id],
      )
      const succeededRetrieveEvidenceCount = Number(
        succeededRetrieveEvidence.rows[0]?.count ?? 0,
      )
      const integrity = evaluatePaymentIntegrityV1(observation, {
        amountMinor: order.amountMinor,
        currency: order.currency,
        itemCount: order.items.length,
      })
      const integrityIssues: string[] = integrity.issues.map(
        (item) => item.code,
      )
      if (
        evidenceSource === "create" &&
        observation.canonicalState === "succeeded"
      ) {
        integrityIssues.push("NON_AUTHORITATIVE_SUCCESS_SOURCE")
      }
      if (
        storedSucceeded.rows.length > 1 &&
        !integrityIssues.includes("MULTIPLE_SUCCESSFUL_CHARGES")
      ) {
        integrityIssues.push("MULTIPLE_SUCCESSFUL_CHARGES")
      }
      if (attemptContradiction) {
        integrityIssues.push("ATTEMPT_PROOF_CONTRADICTION")
      }
      if (
        evidenceSource === "retrieve" &&
        observation.canonicalState === "succeeded" &&
        succeededRetrieveEvidenceCount !== 1
      ) {
        integrityIssues.push("SUCCEEDED_RETRIEVE_LINK_MISSING")
      }
      const currentCanonical = paymentStateToDomain(payment.canonical_state)
      const currentTerminal = ["succeeded", "exhausted"].includes(
        currentCanonical,
      )
      const terminalContradiction =
        currentTerminal && currentCanonical !== observation.canonicalState
      if (terminalContradiction) {
        integrityIssues.push("TERMINAL_PAYMENT_CONTRADICTION")
      }
      const reviewRequired =
        payment.integrity_state === "review_required" ||
        integrityIssues.length > 0
      const incomingSuccessValid =
        observation.canonicalState === "succeeded" &&
        evidenceSource === "retrieve" &&
        integrity.exactMoney &&
        integrity.exactlyOneSuccessfulChargedAttempt &&
        storedSucceeded.rows.length === 1 &&
        succeededRetrieveEvidenceCount === 1 &&
        !attemptContradiction
      const mayApplyIncomingState =
        !terminalContradiction &&
        (observation.canonicalState !== "succeeded" || incomingSuccessValid)
      const nextCanonical = mayApplyIncomingState
        ? domainStateToPayment(observation.canonicalState)
        : payment.canonical_state
      const nextSuccessfulAttemptId =
        nextCanonical === "succeeded"
          ? (payment.successful_attempt_id ??
            storedSucceeded.rows[0]?.id ??
            null)
          : null
      const nextFailedAt =
        nextCanonical === "failed" ? (payment.failed_at ?? new Date()) : null
      const nextSucceededAt =
        nextCanonical === "succeeded"
          ? (payment.succeeded_at ?? new Date())
          : null
      await client.query(
        `update ${this.table("provider_payment")}
         set create_state = case
               when create_state in ('allocated', 'reconcile_required')
                 then 'created'
               else create_state
             end,
             canonical_state = $2,
             integrity_state = case
               when integrity_state = 'review_required' or $3::boolean
                 then 'review_required'
               else 'clear'
             end,
             successful_attempt_id = $4,
             failed_at = $5,
             succeeded_at = $6,
             version = version + 1,
             updated_at = clock_timestamp()
         where id = $1`,
        [
          payment.id,
          nextCanonical,
          reviewRequired,
          nextSuccessfulAttemptId,
          nextFailedAt,
          nextSucceededAt,
        ],
      )

      let fulfillmentId: string | null = null
      let ticketCount = 0
      const mayFulfill =
        evidenceSource === "retrieve" &&
        integrity.fulfillmentEligible &&
        storedSucceeded.rows.length === 1 &&
        succeededRetrieveEvidenceCount === 1 &&
        !reviewRequired &&
        nextCanonical === "succeeded"
      if (mayFulfill) {
        const fulfillment = await this.issueFulfillment(
          client,
          order,
          payment.id,
        )
        fulfillmentId = fulfillment.fulfillmentId
        ticketCount = fulfillment.ticketCount
      }

      await client.query(
        `update ${this.table("checkout_operation")}
         set state = $2,
             outcome_code = $3,
             completed_at = clock_timestamp()
         where id = $1 and state = 'started'`,
        [
          operation.id,
          reviewRequired ? "rejected" : "completed",
          reviewRequired ? "integrity_review_required" : "observation_applied",
        ],
      )
      const orderState = await client.query<{
        state: ApplyPaymentObservationResult["orderState"]
      }>(`select state from ${this.table("orders")} where id = $1`, [
        input.orderId,
      ])
      if (!mayFulfill) {
        const existingFulfillment = await client.query<{
          id: string
          count: string
        }>(
          `select fb.id,
                  (select count(*)::text from ${this.table("ticket")} t
                   where t.fulfillment_id = fb.id) as count
           from ${this.table("fulfillment_bundle")} fb
           where fb.order_id = $1`,
          [input.orderId],
        )
        fulfillmentId = existingFulfillment.rows[0]?.id ?? null
        ticketCount = Number(existingFulfillment.rows[0]?.count ?? 0)
      }
      return {
        replayed: false,
        paymentId: payment.id,
        orderId: input.orderId,
        canonicalState: paymentStateToDomain(nextCanonical),
        integrityState: reviewRequired ? "review_required" : "clear",
        orderState: orderState.rows[0]?.state ?? order.row.state,
        observationPublicRef,
        successfulChargedAttemptCount:
          observation.successfulChargedAttemptCount,
        retainedTerminalSuccess:
          currentCanonical === "succeeded" && terminalContradiction,
        cascadeObserved: cascadeObserved(observation),
        integrityIssues,
        fulfillmentId,
        ticketCount,
      }
    })
  }

  private resultFromAggregate(
    aggregate: PaymentAggregateInspection,
    observationPublicRef: string,
    replayed: boolean,
    integrityIssues: readonly string[],
    retainedTerminalSuccess: boolean,
  ): ApplyPaymentObservationResult {
    const successfulChargedAttemptCount = aggregate.attempts.filter(
      (attempt) => attempt.canonicalState === "succeeded",
    ).length
    const storedConnectors = new Set(
      aggregate.attempts
        .map((attempt) => attempt.observedConnector)
        .filter((connector): connector is string => connector !== null),
    )
    return {
      replayed,
      paymentId: aggregate.payment.id,
      orderId: aggregate.order.id,
      canonicalState: aggregate.payment.canonicalState,
      integrityState: aggregate.payment.integrityState,
      orderState: aggregate.order.state,
      observationPublicRef,
      successfulChargedAttemptCount,
      retainedTerminalSuccess,
      cascadeObserved:
        aggregate.attempts.length > 1 && storedConnectors.size > 1,
      integrityIssues,
      fulfillmentId: aggregate.fulfillment?.id ?? null,
      ticketCount: aggregate.tickets.length,
    }
  }

  private async inspectWithClient(
    client: Pick<PoolClient, "query"> | Pick<Pool, "query">,
    orderId: string,
    afterOrderRead?: () => void | Promise<void>,
  ): Promise<PaymentAggregateInspection | undefined> {
    const orderResult = await client.query<OrderRow & { item_count: string }>(
      `select o.id, o.dataset_id, o.event_id, o.buyer_ref, o.state, o.currency,
              o.subtotal_minor, o.fee_minor, o.tax_minor, o.total_minor,
              (select count(*)::text from ${this.table("order_item")} oi
               where oi.order_id = o.id) as item_count
       from ${this.table("orders")} o
       where o.id = $1`,
      [orderId],
    )
    const order = orderResult.rows[0]
    await afterOrderRead?.()
    if (!order) return undefined
    const payments = await client.query<PaymentRow>(
      `select id, order_id, provider_payment_ref, create_state,
              canonical_state, integrity_state, amount_minor, currency,
              successful_attempt_id, failed_at, succeeded_at
       from ${this.table("provider_payment")}
       where order_id = $1`,
      [orderId],
    )
    const payment = payments.rows[0]
    if (!payment) return undefined
    const operations = await client.query<CheckoutOperationRow>(
      `select id, operation_key, request_hash, command_kind, order_id,
              payment_id, state, outcome_code
       from ${this.table("checkout_operation")}
       where order_id = $1
       order by created_at, id`,
      [orderId],
    )
    const observations = await client.query<{
      public_ref: string
      source: "create_response" | "retrieve_response"
      provider_status: string
      canonical_state: PaymentRow["canonical_state"]
      selected_payment_method: string | null
      observed_connector: string | null
      observed_amount_minor: string | number | null
      observed_currency: string | null
      charged_attempt_count: number
    }>(
      `select public_ref, source, provider_status, canonical_state,
              selected_payment_method, observed_connector,
              observed_amount_minor, observed_currency, charged_attempt_count
       from ${this.table("payment_observation")}
       where payment_id = $1
       order by received_at, id`,
      [payment.id],
    )
    const attempts = await client.query<AttemptRow>(
      `select id, payment_id, provider_attempt_ref_digest, canonical_state,
              observed_connector
       from ${this.table("payment_attempt")}
       where payment_id = $1
       order by first_observed_at, id`,
      [payment.id],
    )
    const fulfillment = await client.query<IssuedFulfillmentRow>(
      `select id, state
       from ${this.table("fulfillment_bundle")}
       where order_id = $1`,
      [orderId],
    )
    const tickets = await client.query<{
      id: string
      order_item_id: string
      seat_id: string
      state: "issued"
    }>(
      `select id, order_item_id, seat_id, state
       from ${this.table("ticket")}
       where order_id = $1
       order by order_item_id`,
      [orderId],
    )
    return {
      order: {
        id: order.id,
        state: order.state,
        amountMinor: integer(order.total_minor, "order total"),
        currency: order.currency,
        itemCount: Number(order.item_count),
      },
      paymentCount: payments.rows.length,
      payment: {
        id: payment.id,
        providerPaymentRef: payment.provider_payment_ref,
        createState: payment.create_state,
        canonicalState: paymentStateToDomain(payment.canonical_state),
        integrityState: payment.integrity_state,
        amountMinor: integer(payment.amount_minor, "payment amount"),
        currency: payment.currency,
        successfulAttemptId: payment.successful_attempt_id,
      },
      operations: operations.rows.map((row) => ({
        operationKey: row.operation_key,
        commandKind: row.command_kind,
        state: row.state,
        outcomeCode: row.outcome_code,
      })),
      observations: observations.rows.map((row) => ({
        publicRef: row.public_ref,
        source: row.source === "create_response" ? "create" : "retrieve",
        providerStatus: row.provider_status,
        canonicalState: paymentStateToDomain(row.canonical_state),
        selectedPaymentMethod: row.selected_payment_method,
        observedConnector: row.observed_connector,
        amountMinor:
          row.observed_amount_minor === null
            ? null
            : integer(row.observed_amount_minor, "observed amount"),
        currency: row.observed_currency,
        successfulChargedAttemptCount: row.charged_attempt_count,
      })),
      attempts: attempts.rows.map((row) => ({
        id: row.id,
        providerAttemptRef:
          `sha256:${row.provider_attempt_ref_digest}` as `sha256:${string}`,
        canonicalState: attemptStateToPublic(row.canonical_state),
        observedConnector: row.observed_connector,
      })),
      fulfillment: fulfillment.rows[0]
        ? { id: fulfillment.rows[0].id, state: fulfillment.rows[0].state }
        : null,
      tickets: tickets.rows.map((row) => ({
        id: row.id,
        orderItemId: row.order_item_id,
        seatId: row.seat_id,
        state: row.state,
      })),
    }
  }

  async inspectPaymentAggregate(
    orderId: string,
  ): Promise<PaymentAggregateInspection | undefined> {
    assertUuid(orderId, "orderId")
    const client = await this.pool.connect()
    try {
      await client.query("begin isolation level repeatable read read only")
      await client.query("select set_config('statement_timeout', $1, true)", [
        "15000ms",
      ])
      await client.query("select set_config('lock_timeout', $1, true)", [
        "5000ms",
      ])
      const result = await this.inspectWithClient(
        client,
        orderId,
        this.faultInjector.afterAggregateOrderRead,
      )
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
