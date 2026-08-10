import { createHash } from "node:crypto"
import { inspect } from "node:util"

import {
  parseCommandIdV1,
  parsePublicRefV1,
  type CommandIdV1,
  type PublicRef,
} from "../domain/onsale-public-contract"
import { classifyOnsaleRouteThrowableV1 } from "./onsale-route-runtime"
import {
  OnsaleHttpGuardError,
  assertConfiguredOriginV1,
  readBoundedJsonV1,
  type ConfiguredOriginsV1,
} from "./onsale-http-guards"
import {
  ONSALE_SESSION_COOKIE_NAME_V1,
  resolveExistingAnonymousSessionV1,
  resolveAnonymousSessionV1,
  serializeOnsaleSessionCookieV1,
  type ResolvedAnonymousSessionV1,
} from "./onsale-session"

export const ONSALE_CURRENT_ORDER_COOKIE_NAME_V1 =
  "onsale_current_order_v1" as const
export const ONSALE_CURRENT_ORDER_MAX_AGE_SECONDS_V1 = 30 * 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const CURRENCY = /^[A-Z]{3}$/u
const EVIDENCE_TOKEN = /^[a-z0-9_.:-]{1,80}$/u
const MAX_MONEY_MINOR = 9_000_000_000_000
const PAYMENT_CANONICAL_STATES = new Set<unknown>([
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

export type CheckoutPrivateStageV1 = "checkout_ready" | "checking_same_payment" | "action_required" | "processing" | "declined" | "recoverable_failure" | "fulfilled" | "expired" | "review_required"

export type CheckoutPrivateCanonicalStateV1 = "requires_method" | "action_required" | "processing" | "succeeded" | "exhausted" | "uncertain"

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

export interface CheckoutCoordinatorProjectionV1 {
  readonly stage: CheckoutPrivateStageV1
  readonly order: CheckoutOrderProjectionV1
  readonly payment: {
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
      readonly state: "requires_method" | "action_required" | "processing" | "hard_decline" | "technical_failure" | "uncertain" | "succeeded"
      readonly charged: boolean
      readonly hardDecline: boolean
      readonly connector: string | null
    }[]
    readonly chargedAttemptCount: number
    readonly evidenceGeneration: number
  }
  /** Ephemeral only. The HTTP boundary drops this outside checkout_ready. */
  readonly grant: {
    readonly clientSecret: string
    readonly publishableKey: string
  } | null
}

export class OnsaleOrderPointerV1 {
  readonly kind = "onsale_order_pointer" as const
  readonly #orderRef: PublicRef

  constructor(orderRef: PublicRef) {
    this.#orderRef = orderRef
  }

  orderRef(): PublicRef {
    return this.#orderRef
  }

  toJSON(): { readonly kind: "onsale_order_pointer" } {
    return { kind: "onsale_order_pointer" }
  }

  toString(): string {
    return "OnsaleOrderPointerV1 { redacted }"
  }

  [inspect.custom](): string {
    return this.toString()
  }
}

export function createOnsaleOrderPointerV1(
  orderRefCandidate: string,
): OnsaleOrderPointerV1 {
  return new OnsaleOrderPointerV1(
    parsePublicRefV1(orderRefCandidate, "$orderRef"),
  )
}

export interface PrepareCheckoutBoundaryInputV1 {
  readonly buyerRef: string
  readonly commandId: CommandIdV1
  readonly holdRef: PublicRef
}

export type CheckoutReconcileTriggerV1 = "return" | "resume" | "refresh"

export interface ReconcileCheckoutBoundaryInputV1 {
  readonly buyerRef: string
  readonly commandId: CommandIdV1
  readonly orderPointer: OnsaleOrderPointerV1
  readonly trigger: CheckoutReconcileTriggerV1
}

export interface PreparedCheckoutBoundaryResultV1 {
  readonly orderPointer: OnsaleOrderPointerV1
  readonly projection: CheckoutCoordinatorProjectionV1
}

export interface OnsaleCheckoutRouteDependenciesV1 {
  readonly configuredOrigins: ConfiguredOriginsV1
  readonly secureCookie: boolean
  readonly cleanReturnLocation: string
  readonly randomBytes?: (size: number) => Uint8Array
  readonly prepare: (
    input: PrepareCheckoutBoundaryInputV1,
  ) => Promise<PreparedCheckoutBoundaryResultV1>
  /** This port is intentionally separate and structurally retrieve-only. */
  readonly reconcile: (
    input: ReconcileCheckoutBoundaryInputV1,
  ) => Promise<CheckoutCoordinatorProjectionV1>
}

export type CheckoutRouteBoundaryErrorKindV1 = "order_not_found" | "checkout_configuration_blocked" | "checkout_integrity_error"

export class CheckoutRouteBoundaryErrorV1 extends Error {
  readonly kind: CheckoutRouteBoundaryErrorKindV1

  constructor(kind: CheckoutRouteBoundaryErrorKindV1) {
    super("The checkout request could not be completed.")
    this.name = "CheckoutRouteBoundaryErrorV1"
    this.kind = kind
  }
}

interface CheckoutPrivateSuccessBodyV1 {
  readonly schema: "onsale.checkout-private.v1"
  readonly ok: true
  readonly stage: CheckoutPrivateStageV1
  readonly order: CheckoutOrderProjectionV1
  readonly payment: CheckoutCoordinatorProjectionV1["payment"] & {
    readonly retryPermitted: boolean
    readonly retryReason: string
    readonly evidenceRevision: `sha256:${string}`
  }
  readonly checkout: CheckoutCoordinatorProjectionV1["grant"]
  readonly message: string
}

interface CheckoutPrivateFailureBodyV1 {
  readonly schema: "onsale.checkout-private.v1"
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}

interface CheckoutErrorMappingV1 {
  readonly status: 400 | 403 | 404 | 409 | 503
  readonly body: CheckoutPrivateFailureBodyV1 | ReturnType<typeof classifyOnsaleRouteThrowableV1>["body"]
}

function invalidRequestV1(): never {
  throw new OnsaleHttpGuardError("invalid_request")
}

function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactRecordV1(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecordV1(value)) return invalidRequestV1()
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return invalidRequestV1()
  }
  return value
}

async function parsePrepareRequestV1(
  request: Request,
): Promise<{
  readonly commandId: CommandIdV1
  readonly holdRef: PublicRef
}> {
  const source = exactRecordV1(await readBoundedJsonV1(request), [
    "commandId",
    "holdRef",
  ])
  try {
    return {
      commandId: parseCommandIdV1(source.commandId),
      holdRef: parsePublicRefV1(source.holdRef, "$holdRef"),
    }
  } catch {
    return invalidRequestV1()
  }
}

async function parseReconcileRequestV1(
  request: Request,
): Promise<{
  readonly commandId: CommandIdV1
  readonly trigger: CheckoutReconcileTriggerV1
}> {
  const source = exactRecordV1(await readBoundedJsonV1(request), [
    "commandId",
    "trigger",
  ])
  if (
    source.trigger !== "return" &&
    source.trigger !== "resume" &&
    source.trigger !== "refresh"
  ) {
    return invalidRequestV1()
  }
  try {
    return {
      commandId: parseCommandIdV1(source.commandId),
      trigger: source.trigger,
    }
  } catch {
    return invalidRequestV1()
  }
}

type CookieCandidateV1 = { readonly kind: "missing" } | {
  readonly kind: "duplicate"
} | { readonly kind: "one"; readonly value: string }

function cookieCandidateV1(
  request: Request,
  cookieName: string,
): CookieCandidateV1 {
  const source = request.headers.get("cookie")
  if (source === null) return { kind: "missing" }
  const matches: string[] = []
  for (const segment of source.split(";")) {
    const normalized = segment.trim()
    const separator = normalized.indexOf("=")
    if (separator < 1) continue
    if (normalized.slice(0, separator) !== cookieName) continue
    matches.push(normalized.slice(separator + 1))
  }
  if (matches.length === 0) return { kind: "missing" }
  if (matches.length > 1) return { kind: "duplicate" }
  return { kind: "one", value: matches[0] ?? "" }
}

function orderPointerFromRequestV1(
  request: Request,
): OnsaleOrderPointerV1 | undefined {
  const candidate = cookieCandidateV1(
    request,
    ONSALE_CURRENT_ORDER_COOKIE_NAME_V1,
  )
  if (candidate.kind !== "one") return undefined
  try {
    return createOnsaleOrderPointerV1(candidate.value)
  } catch {
    return undefined
  }
}

function resolveSessionFromRequestV1(
  request: Request,
  runtime: OnsaleCheckoutRouteDependenciesV1,
): ResolvedAnonymousSessionV1 {
  const candidate = cookieCandidateV1(request, ONSALE_SESSION_COOKIE_NAME_V1)
  if (candidate.kind === "duplicate") return invalidRequestV1()
  return resolveAnonymousSessionV1({
    candidateToken: candidate.kind === "one" ? candidate.value : undefined,
    randomBytes: runtime.randomBytes,
  })
}

function resolveExistingSessionFromRequestV1(
  request: Request,
): ResolvedAnonymousSessionV1 {
  const candidate = cookieCandidateV1(request, ONSALE_SESSION_COOKIE_NAME_V1)
  if (candidate.kind !== "one") {
    throw new CheckoutRouteBoundaryErrorV1("order_not_found")
  }
  const resolved = resolveExistingAnonymousSessionV1(candidate.value)
  if (resolved === undefined) {
    throw new CheckoutRouteBoundaryErrorV1("order_not_found")
  }
  return resolved
}

function privateHeadersV1(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie, Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  })
}

function appendSessionCookieV1(
  headers: Headers,
  resolved: ResolvedAnonymousSessionV1 | undefined,
  secureCookie: boolean,
): void {
  if (!resolved?.shouldSetCookie) return
  headers.append(
    "Set-Cookie",
    serializeOnsaleSessionCookieV1(resolved.session.cookieToken(), {
      secure: secureCookie,
    }),
  )
}

function serializeOrderPointerCookieV1(
  pointer: OnsaleOrderPointerV1,
  secure: boolean,
): string {
  return [
    `${ONSALE_CURRENT_ORDER_COOKIE_NAME_V1}=${pointer.orderRef()}`,
    `Max-Age=${ONSALE_CURRENT_ORDER_MAX_AGE_SECONDS_V1}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

function checkoutErrorV1(error: unknown): CheckoutErrorMappingV1 {
  if (error instanceof CheckoutRouteBoundaryErrorV1) {
    switch (error.kind) {
      case "order_not_found":
        return {
          status: 404,
          body: {
            schema: "onsale.checkout-private.v1",
            ok: false,
            error: {
              code: "ORDER_NOT_FOUND",
              message: "The order was not found.",
              retryable: false,
            },
          },
        }
      case "checkout_configuration_blocked":
        return {
          status: 503,
          body: {
            schema: "onsale.checkout-private.v1",
            ok: false,
            error: {
              code: "CHECKOUT_SETUP_REQUIRED",
              message: "Secure checkout needs operator setup.",
              retryable: false,
            },
          },
        }
      case "checkout_integrity_error":
        return {
          status: 503,
          body: {
            schema: "onsale.checkout-private.v1",
            ok: false,
            error: {
              code: "CHECKOUT_INTEGRITY_ERROR",
              message:
                "Checkout is unavailable because its state could not be verified.",
              retryable: false,
            },
          },
        }
      default: {
        const exhaustive: never = error.kind
        return exhaustive
      }
    }
  }
  const inventory = classifyOnsaleRouteThrowableV1(error)
  if (inventory.body.error.code !== "INVENTORY_TEMPORARILY_UNAVAILABLE") {
    return inventory
  }
  return {
    status: 503,
    body: {
      schema: "onsale.checkout-private.v1",
      ok: false,
      error: {
        code: "CHECKOUT_TEMPORARILY_UNAVAILABLE",
        message: "Secure checkout is temporarily unavailable. Try again.",
        retryable: true,
      },
    },
  }
}

function jsonResponseV1(
  body: CheckoutPrivateSuccessBodyV1 | CheckoutErrorMappingV1["body"],
  status: number,
  options: {
    readonly resolved?: ResolvedAnonymousSessionV1
    readonly secureCookie: boolean
    readonly orderPointer?: OnsaleOrderPointerV1
  },
): Response {
  const headers = privateHeadersV1()
  headers.set("Content-Type", "application/json; charset=utf-8")
  appendSessionCookieV1(headers, options.resolved, options.secureCookie)
  if (options.orderPointer) {
    headers.append(
      "Set-Cookie",
      serializeOrderPointerCookieV1(options.orderPointer, options.secureCookie),
    )
  }
  return new Response(JSON.stringify(body), { status, headers })
}

function boundedTextV1(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 120 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return value
}

function moneyV1(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_MINOR) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return value
}

function safeGrantValueV1(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 512 ||
    CONTROL_CHARACTER.test(value) ||
    /\s/u.test(value)
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return value
}

function safeEvidenceTokenV1(value: string | null): string | null {
  if (value === null) return null
  if (!EVIDENCE_TOKEN.test(value)) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return value
}

function sanitizedPaymentV1(
  payment: CheckoutCoordinatorProjectionV1["payment"],
): CheckoutCoordinatorProjectionV1["payment"] {
  if (
    !PAYMENT_CANONICAL_STATES.has(payment.canonicalState) ||
    !["clear", "review_required"].includes(payment.integrityState) ||
    ![null, "create", "retrieve"].includes(payment.observationSource) ||
    !Number.isSafeInteger(payment.evidenceGeneration) ||
    payment.evidenceGeneration < 0 ||
    payment.evidenceGeneration > 1_000_000 ||
    !Number.isSafeInteger(payment.chargedAttemptCount) ||
    payment.chargedAttemptCount < 0 ||
    payment.chargedAttemptCount > 32 ||
    payment.attempts.length > 32
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  const selectedMethod = payment.selectedMethod
    ? {
        family: safeEvidenceTokenV1(payment.selectedMethod.family),
        type: safeEvidenceTokenV1(payment.selectedMethod.type),
      }
    : null
  if (
    selectedMethod &&
    selectedMethod.family === null &&
    selectedMethod.type === null
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  const attempts = payment.attempts.map((attempt, index) => {
    if (
      attempt.ordinal !== index + 1 ||
      !ATTEMPT_STATES.has(attempt.state) ||
      (attempt.charged && attempt.state !== "succeeded") ||
      attempt.hardDecline !== (attempt.state === "hard_decline")
    ) {
      throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
    }
    return {
      ordinal: attempt.ordinal,
      state: attempt.state,
      charged: attempt.charged,
      hardDecline: attempt.hardDecline,
      connector: safeEvidenceTokenV1(attempt.connector),
    }
  })
  if (
    attempts.filter((attempt) => attempt.charged).length !==
      payment.chargedAttemptCount ||
    (payment.observationSource === null &&
      (payment.evidenceGeneration !== 0 || attempts.length !== 0)) ||
    (payment.observationSource !== null && payment.evidenceGeneration < 1)
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return {
    canonicalState: payment.canonicalState,
    integrityState: payment.integrityState,
    observationSource: payment.observationSource,
    selectedMethod,
    observedConnector: safeEvidenceTokenV1(payment.observedConnector),
    attempts,
    chargedAttemptCount: payment.chargedAttemptCount,
    evidenceGeneration: payment.evidenceGeneration,
  }
}

function sanitizedProjectionV1(
  projection: CheckoutCoordinatorProjectionV1,
): CheckoutPrivateSuccessBodyV1 {
  if (
    !CURRENCY.test(projection.order.currency) ||
    projection.order.items.length < 1 ||
    projection.order.items.length > 4 ||
    projection.order.itemCount !== projection.order.items.length ||
    !Number.isSafeInteger(projection.order.ticketCount) ||
    projection.order.ticketCount < 0 ||
    projection.order.ticketCount > projection.order.itemCount
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  const items = projection.order.items.map((item) => {
    if (
      item.currency !== projection.order.currency ||
      moneyV1(item.faceValueMinor) +
        moneyV1(item.feeMinor) +
        moneyV1(item.taxMinor) !==
        moneyV1(item.totalMinor)
    ) {
      throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
    }
    return {
      sectionLabel: boundedTextV1(item.sectionLabel, "sectionLabel"),
      rowLabel: boundedTextV1(item.rowLabel, "rowLabel"),
      seatLabel: boundedTextV1(item.seatLabel, "seatLabel"),
      priceTier: boundedTextV1(item.priceTier, "priceTier"),
      faceValueMinor: item.faceValueMinor,
      feeMinor: item.feeMinor,
      taxMinor: item.taxMinor,
      totalMinor: item.totalMinor,
      currency: item.currency,
    }
  })
  const subtotalMinor = moneyV1(projection.order.subtotalMinor)
  const feeMinor = moneyV1(projection.order.feeMinor)
  const taxMinor = moneyV1(projection.order.taxMinor)
  const totalMinor = moneyV1(projection.order.totalMinor)
  const paymentDeadline = new Date(projection.order.paymentDeadlineAt)
  if (
    !Number.isFinite(paymentDeadline.getTime()) ||
    paymentDeadline.toISOString() !== projection.order.paymentDeadlineAt
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  if (
    subtotalMinor + feeMinor + taxMinor !== totalMinor ||
    items.reduce((sum, item) => sum + item.faceValueMinor, 0) !==
      subtotalMinor ||
    items.reduce((sum, item) => sum + item.feeMinor, 0) !== feeMinor ||
    items.reduce((sum, item) => sum + item.taxMinor, 0) !== taxMinor ||
    items.reduce((sum, item) => sum + item.totalMinor, 0) !== totalMinor
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }

  const payment = sanitizedPaymentV1(projection.payment)
  const sanitized = { ...projection, payment }
  assertProjectionTupleV1(sanitized)

  const grantAllowed =
    projection.stage === "checkout_ready" &&
    payment.canonicalState === "requires_method" &&
    payment.integrityState === "clear"
  const checkout =
    grantAllowed && projection.grant
      ? {
          clientSecret: safeGrantValueV1(projection.grant.clientSecret),
          publishableKey: safeGrantValueV1(projection.grant.publishableKey),
        }
      : null
  if (grantAllowed && checkout === null) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }

  return {
    schema: "onsale.checkout-private.v1",
    ok: true,
    stage: projection.stage,
    order: {
      state: projection.order.state,
      paymentDeadlineAt: projection.order.paymentDeadlineAt,
      currency: projection.order.currency,
      subtotalMinor,
      feeMinor,
      taxMinor,
      totalMinor,
      itemCount: projection.order.itemCount,
      items,
      ticketCount: projection.order.ticketCount,
    },
    payment: {
      ...payment,
      ...retryPolicyV1(projection.stage),
      evidenceRevision: evidenceRevisionV1({
        stage: projection.stage,
        order: {
          state: projection.order.state,
          paymentDeadlineAt: projection.order.paymentDeadlineAt,
          currency: projection.order.currency,
          subtotalMinor,
          feeMinor,
          taxMinor,
          totalMinor,
          itemCount: projection.order.itemCount,
          items,
          ticketCount: projection.order.ticketCount,
        },
        payment,
      }),
    },
    checkout,
    message: fixedMessageV1(projection.stage),
  }
}

function evidenceRevisionV1(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`
}

function retryPolicyV1(
  stage: CheckoutPrivateStageV1,
): {
  readonly retryPermitted: boolean
  readonly retryReason: string
} {
  switch (stage) {
    case "checkout_ready":
      return {
        retryPermitted: true,
        retryReason: "official_checkout_submission_available",
      }
    case "checking_same_payment":
    case "action_required":
    case "processing":
      return {
        retryPermitted: false,
        retryReason: "same_payment_status_check_only",
      }
    case "declined":
      return {
        retryPermitted: false,
        retryReason: "hard_decline_no_automatic_retry",
      }
    case "recoverable_failure":
      return {
        retryPermitted: false,
        retryReason: "terminal_failure_requires_new_checkout",
      }
    case "fulfilled":
      return {
        retryPermitted: false,
        retryReason: "payment_already_fulfilled",
      }
    case "expired":
      return {
        retryPermitted: false,
        retryReason: "checkout_deadline_elapsed",
      }
    case "review_required":
      return {
        retryPermitted: false,
        retryReason: "integrity_review_required",
      }
    default: {
      const exhaustive: never = stage
      return exhaustive
    }
  }
}

function assertProjectionTupleV1(
  projection: CheckoutCoordinatorProjectionV1,
): void {
  const noGrant = projection.grant === null
  const noTickets = projection.order.ticketCount === 0
  const paymentPending = projection.order.state === "payment_pending"
  const clear = projection.payment.integrityState === "clear"
  const noCharge = projection.payment.chargedAttemptCount === 0
  const hasHardDecline = projection.payment.attempts.some(
    (attempt) => attempt.hardDecline,
  )
  let valid = false

  switch (projection.stage) {
    case "checkout_ready":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        clear &&
        projection.payment.canonicalState === "requires_method" &&
        projection.payment.observationSource !== null &&
        projection.payment.evidenceGeneration >= 1 &&
        projection.grant !== null
      break
    case "action_required":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        projection.payment.canonicalState === "action_required"
      break
    case "processing":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        projection.payment.canonicalState === "processing"
      break
    case "declined":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        hasHardDecline &&
        clear &&
        noGrant &&
        projection.payment.canonicalState === "exhausted"
      break
    case "recoverable_failure":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        !hasHardDecline &&
        clear &&
        noGrant &&
        projection.payment.canonicalState === "exhausted"
      break
    case "fulfilled":
      valid =
        projection.order.state === "fulfilled" &&
        projection.order.ticketCount === projection.order.itemCount &&
        projection.payment.chargedAttemptCount === 1 &&
        projection.payment.observationSource === "retrieve" &&
        clear &&
        noGrant &&
        projection.payment.canonicalState === "succeeded"
      break
    case "review_required":
      valid = projection.payment.integrityState === "review_required" && noGrant
      break
    case "expired":
      valid =
        (projection.order.state === "awaiting_payment" || paymentPending) &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        (projection.payment.canonicalState === "uncertain" ||
          projection.payment.canonicalState === "requires_method" ||
          projection.payment.canonicalState === "action_required" ||
          projection.payment.canonicalState === "processing")
      break
    case "checking_same_payment":
      valid =
        paymentPending &&
        noTickets &&
        noCharge &&
        clear &&
        noGrant &&
        (projection.payment.canonicalState === "uncertain" ||
          projection.payment.canonicalState === "processing" ||
          projection.payment.canonicalState === "requires_method")
      break
    default: {
      const exhaustive: never = projection.stage
      return exhaustive
    }
  }

  if (!valid) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
}

function fixedMessageV1(stage: CheckoutPrivateStageV1): string {
  switch (stage) {
    case "checkout_ready":
      return "SECURE CHECKOUT READY"
    case "checking_same_payment":
      return "CHECKING THIS SAME PAYMENT"
    case "action_required":
      return "CUSTOMER ACTION REQUIRED"
    case "processing":
      return "PAYMENT PROCESSING"
    case "declined":
      return "PAYMENT NOT COMPLETED"
    case "recoverable_failure":
      return "PAYMENT NEEDS A NEW CHECKOUT"
    case "fulfilled":
      return "TICKETS ISSUED"
    case "expired":
      return "CHECKOUT TIME EXPIRED"
    case "review_required":
      return "PAYMENT REVIEW REQUIRED"
    default: {
      const exhaustive: never = stage
      return exhaustive
    }
  }
}

function statusForStageV1(stage: CheckoutPrivateStageV1): 200 | 202 {
  return ["checking_same_payment", "action_required", "processing"].includes(
    stage,
  )
    ? 202
    : 200
}

async function productionDependenciesV1(): Promise<OnsaleCheckoutRouteDependenciesV1> {
  const runtime = await import("./onsale-checkout-runtime")
  return runtime.getOnsaleCheckoutRouteDependenciesV1(process.env)
}

async function productionReturnConfigurationV1(): Promise<Pick<OnsaleCheckoutRouteDependenciesV1, "configuredOrigins" | "cleanReturnLocation">> {
  const runtime = await import("./onsale-checkout-runtime")
  return runtime.getOnsaleCheckoutReturnRouteConfigurationV1(process.env)
}

export async function handleOnsaleCheckoutPreparePostV1(
  request: Request,
  dependencies?: OnsaleCheckoutRouteDependenciesV1,
): Promise<Response> {
  let resolved: ResolvedAnonymousSessionV1 | undefined
  let secureCookie = true
  try {
    const runtime = dependencies ?? (await productionDependenciesV1())
    secureCookie = runtime.secureCookie
    assertConfiguredOriginV1(
      request.headers.get("origin"),
      runtime.configuredOrigins,
    )
    resolved = resolveSessionFromRequestV1(request, runtime)
    const input = await parsePrepareRequestV1(request)
    const result = await runtime.prepare({
      buyerRef: resolved.session.buyerRef(),
      commandId: input.commandId,
      holdRef: input.holdRef,
    })
    const body = sanitizedProjectionV1(result.projection)
    return jsonResponseV1(body, statusForStageV1(body.stage), {
      resolved,
      secureCookie,
      orderPointer: result.orderPointer,
    })
  } catch (error) {
    const mapped = checkoutErrorV1(error)
    return jsonResponseV1(mapped.body, mapped.status, {
      resolved,
      secureCookie,
    })
  }
}

export async function handleOnsaleCheckoutReconcilePostV1(
  request: Request,
  dependencies?: OnsaleCheckoutRouteDependenciesV1,
): Promise<Response> {
  let resolved: ResolvedAnonymousSessionV1 | undefined
  let secureCookie = true
  try {
    const runtime = dependencies ?? (await productionDependenciesV1())
    secureCookie = runtime.secureCookie
    assertConfiguredOriginV1(
      request.headers.get("origin"),
      runtime.configuredOrigins,
    )
    resolved = resolveExistingSessionFromRequestV1(request)
    const input = await parseReconcileRequestV1(request)
    const orderPointer = orderPointerFromRequestV1(request)
    if (!orderPointer) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    const body = sanitizedProjectionV1(
      await runtime.reconcile({
        buyerRef: resolved.session.buyerRef(),
        commandId: input.commandId,
        orderPointer,
        trigger: input.trigger,
      }),
    )
    return jsonResponseV1(body, statusForStageV1(body.stage), {
      resolved,
      secureCookie,
    })
  } catch (error) {
    const mapped = checkoutErrorV1(error)
    return jsonResponseV1(mapped.body, mapped.status, {
      resolved,
      secureCookie,
    })
  }
}

export async function handleOnsaleCheckoutReturnGetV1(
  _request: Request,
  dependencies?: OnsaleCheckoutRouteDependenciesV1,
): Promise<Response> {
  let cleanReturnLocation = "/checkout"
  try {
    const runtime = dependencies ?? (await productionReturnConfigurationV1())
    cleanReturnLocation = validatedCleanReturnLocationV1(runtime)
  } catch {
    // Configuration failures never reflect provider query material.
  }
  const headers = privateHeadersV1()
  headers.set("Location", cleanReturnLocation)
  return new Response(null, { status: 303, headers })
}

function validatedCleanReturnLocationV1(
  runtime: Pick<OnsaleCheckoutRouteDependenciesV1, "configuredOrigins" | "cleanReturnLocation">,
): string {
  let parsed: URL
  try {
    parsed = new URL(runtime.cleanReturnLocation)
  } catch {
    throw new CheckoutRouteBoundaryErrorV1("checkout_configuration_blocked")
  }
  if (
    !runtime.configuredOrigins.has(parsed.origin) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/checkout" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_configuration_blocked")
  }
  return `${parsed.origin}/checkout`
}
