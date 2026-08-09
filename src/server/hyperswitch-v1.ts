import { createHash } from "node:crypto"

import {
  normalizeHyperswitchPaymentObservationV1,
  type ImmutableOrderPaymentTermsV1,
  type NormalizedPaymentObservationV1,
  type Sha256PaymentRefV1,
} from "../domain/onsale-payment-v1"
import { classifyOnsaleLocalOriginV1 } from "./onsale-local-origin"

export const HYPERSWITCH_V1_SANDBOX_ORIGIN =
  "https://sandbox.hyperswitch.io" as const
export const HYPERSWITCH_V1_MAX_SESSION_EXPIRY_SECONDS = 900 as const

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_TIMEOUT_MS = 30_000
const PAYMENT_ID = /^pay_[a-f0-9]{26}$/
const ISO_CURRENCY = /^[A-Z]{3}$/
const SAFE_API_KEY = /^[A-Za-z0-9._~+/%=-]{12,512}$/
const SAFE_PROFILE_ID = /^[A-Za-z0-9_-]{4,128}$/
const SAFE_V1_PUBLISHABLE_KEY = /^pk_(?:snd|sandbox)_[A-Za-z0-9_-]{8,512}$/
const SAFE_PROVIDER_STATUS = /^[a-z0-9_.:-]{1,96}$/
const SAFE_METADATA_KEY = /^[a-z][a-z0-9_]{0,39}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const FORBIDDEN_METADATA_KEY =
  /(?:secret|token|api_?key|authorization|credential|password|pan|cvc|cvv|card|email|phone|return|redirect|url)/i
const SECRET_LIKE_VALUE =
  /(?:\b(?:bearer|basic)\s+|\b(?:client[_ -]?secret|api[_ -]?key|authorization|password|cvc|cvv|pan)\b|\b(?:pk|sk)_(?:snd|sandbox|test|live)_[A-Za-z0-9_-]{8,}|\b(?:\d[ -]?){13,19}\b)/i

const REQUIRED_ENVIRONMENT_NAMES = [
  "HYPERSWITCH_API_KEY",
  "HYPERSWITCH_PROFILE_ID",
  "HYPERSWITCH_PUBLISHABLE_KEY_V1",
] as const

type RequiredEnvironmentName = typeof REQUIRED_ENVIRONMENT_NAMES[number]

interface ConfiguredV1Environment {
  readonly apiKey: string
  readonly profileId: string
  readonly publishableKey: string
}

interface ReadyConfiguredEnvironment {
  readonly kind: "ready"
  readonly value: ConfiguredV1Environment
}

interface BlockedConfiguredEnvironment {
  readonly kind: "blocked"
  readonly value: HyperswitchV1Configuration
}

type ConfiguredEnvironmentResult =
  | ReadyConfiguredEnvironment
  | BlockedConfiguredEnvironment

export interface HyperswitchV1AdapterDependencies {
  /** Injected server environment. The module has no ambient environment read. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Injected fetch implementation. Tests never reach the network. */
  readonly fetch: typeof globalThis.fetch
  /** Injected wall clock for deterministic observations. */
  readonly now: () => Date
  /** Exact server-controlled origins permitted to receive a checkout return. */
  readonly allowedReturnOrigins: readonly string[]
  readonly timeoutMs?: number
}

export interface HyperswitchV1OrderItem {
  readonly name: string
  readonly quantity: number
  readonly amountMinor: number
}

export interface HyperswitchV1CreateInput {
  readonly merchantPaymentId: string
  readonly terms: ImmutableOrderPaymentTermsV1
  readonly returnUrl: string
  /** Server-derived seconds remaining before the order payment deadline. */
  readonly sessionExpirySeconds: number
  readonly description: string
  readonly metadata: Readonly<Record<string, string>>
  readonly items: readonly HyperswitchV1OrderItem[]
}

export interface HyperswitchV1RetrieveInput {
  readonly merchantPaymentId: string
  readonly terms: ImmutableOrderPaymentTermsV1
}

export type HyperswitchV1AdapterErrorCode = "configuration_blocked" | "invalid_input" | "request_rejected" | "invalid_response"

/** A fixed, secret-free error. Raw provider payloads and caught causes are omitted. */
export class HyperswitchV1AdapterError extends Error {
  readonly code: HyperswitchV1AdapterErrorCode
  readonly httpStatus: number | null

  constructor(
    code: HyperswitchV1AdapterErrorCode,
    message: string,
    httpStatus: number | null = null,
  ) {
    super(message)
    this.name = "HyperswitchV1AdapterError"
    this.code = code
    this.httpStatus = httpStatus
  }
}

export type HyperswitchV1Configuration = {
  readonly kind: "ready"
  readonly provider: "hyperswitch"
  readonly apiVersion: "v1"
  readonly environment: "sandbox"
  readonly publishableKeyScope: "explicit_v1_env_only"
} | {
  readonly kind: "blocked"
  readonly code: "hyperswitch_v1_configuration_missing" | "hyperswitch_v1_configuration_invalid"
  readonly message: string
  readonly missing: readonly RequiredEnvironmentName[]
  readonly invalid: readonly RequiredEnvironmentName[]
}

export interface HyperswitchV1UncertainError {
  readonly code: "hyperswitch_outcome_uncertain"
  readonly message: string
  readonly httpStatus: number | null
}

export interface HyperswitchV1CheckoutGrant {
  readonly clientSecret: string
  readonly publishableKey: string
}

interface HyperswitchV1UncertainResult {
  readonly kind: "uncertain"
  readonly observedAt: string
  readonly error: HyperswitchV1UncertainError
}

export type HyperswitchV1CreateResult = {
  readonly kind: "ready"
  readonly observedAt: string
  /** Ephemeral browser handoff only. It is not a persistence shape. */
  readonly checkoutGrant: HyperswitchV1CheckoutGrant
  readonly observation: NormalizedPaymentObservationV1
} | {
  readonly kind: "reconcile_required"
  readonly observedAt: string
  readonly observation: NormalizedPaymentObservationV1
} | HyperswitchV1UncertainResult

export type HyperswitchV1RetrieveResult = {
  readonly kind: "found"
  readonly observedAt: string
  readonly observation: NormalizedPaymentObservationV1
  /** Present only when the same requires_method payment can be remounted. */
  readonly checkoutGrant?: HyperswitchV1CheckoutGrant
} | {
  readonly kind: "not_found"
  readonly observedAt: string
} | HyperswitchV1UncertainResult

const HYPERSWITCH_V1_EVIDENCE_RECEIPT: unique symbol = Symbol(
  "onsale.hyperswitch-v1-evidence-receipt",
)

export type HyperswitchV1EvidenceKind =
  | "create_observation"
  | "retrieve_observation"
  | "retrieve_not_found"

/**
 * An opaque, pair-scoped receipt. Its evidence payload is retained only by the
 * verifier closure returned from `bindHyperswitchV1Evidence`.
 */
export type HyperswitchV1EvidenceReceipt<
  Kind extends HyperswitchV1EvidenceKind = HyperswitchV1EvidenceKind,
> = Readonly<{
  readonly kind: Kind
  readonly [HYPERSWITCH_V1_EVIDENCE_RECEIPT]: never
}>

export type HyperswitchV1ObservationReceipt = HyperswitchV1EvidenceReceipt<
  "create_observation" | "retrieve_observation"
>
export type HyperswitchV1NotFoundReceipt =
  HyperswitchV1EvidenceReceipt<"retrieve_not_found">

export type VerifiedHyperswitchV1Evidence =
  | Readonly<{
      readonly kind: "create_observation"
      readonly observation: NormalizedPaymentObservationV1
    }>
  | Readonly<{
      readonly kind: "retrieve_observation"
      readonly observation: NormalizedPaymentObservationV1
    }>
  | Readonly<{
      readonly kind: "retrieve_not_found"
      readonly providerPaymentRef: Sha256PaymentRefV1
    }>

export interface HyperswitchV1EvidenceVerifier {
  /** Rejects plain objects, casts, and receipts issued by another binder. */
  readonly require: (
    receipt: HyperswitchV1EvidenceReceipt,
  ) => VerifiedHyperswitchV1Evidence
}

export interface HyperswitchV1AdapterPort {
  readonly configuration: () => HyperswitchV1Configuration
  readonly createPayment: (
    input: HyperswitchV1CreateInput,
  ) => Promise<HyperswitchV1CreateResult>
  readonly retrievePayment: (
    input: HyperswitchV1RetrieveInput,
  ) => Promise<HyperswitchV1RetrieveResult>
}

export type AttestedHyperswitchV1CreateResult =
  | Readonly<{
      readonly kind: "ready"
      readonly observedAt: string
      readonly checkoutGrant: HyperswitchV1CheckoutGrant
      readonly evidence: HyperswitchV1EvidenceReceipt<"create_observation">
    }>
  | Readonly<{
      readonly kind: "reconcile_required"
      readonly observedAt: string
      readonly evidence: HyperswitchV1EvidenceReceipt<"create_observation">
    }>
  | HyperswitchV1UncertainResult

export type AttestedHyperswitchV1RetrieveResult =
  | Readonly<{
      readonly kind: "found"
      readonly observedAt: string
      readonly evidence: HyperswitchV1EvidenceReceipt<"retrieve_observation">
      readonly checkoutGrant?: HyperswitchV1CheckoutGrant
    }>
  | Readonly<{
      readonly kind: "not_found"
      readonly observedAt: string
      readonly evidence: HyperswitchV1NotFoundReceipt
    }>
  | HyperswitchV1UncertainResult

export interface AttestedHyperswitchV1AdapterPort {
  readonly configuration: () => HyperswitchV1Configuration
  readonly createPayment: (
    input: HyperswitchV1CreateInput,
  ) => Promise<AttestedHyperswitchV1CreateResult>
  readonly retrievePayment: (
    input: HyperswitchV1RetrieveInput,
  ) => Promise<AttestedHyperswitchV1RetrieveResult>
}

function deepFreezeEvidence<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeEvidence(child)
    }
    Object.freeze(value)
  }
  return value
}

function snapshotEvidence<Value>(value: Value): Value {
  return deepFreezeEvidence(structuredClone(value))
}

function providerPaymentRef(paymentId: string): Sha256PaymentRefV1 {
  return `sha256:${createHash("sha256")
    .update("onsale-provider-payment-v1", "utf8")
    .update("\0", "utf8")
    .update(paymentId, "utf8")
    .digest("hex")}` as Sha256PaymentRefV1
}

/**
 * Binds evidence authority to the adapter method that actually ran. No minting
 * capability escapes this closure; the paired verifier accepts only receipts
 * registered in this binder's private WeakMap.
 */
export function bindHyperswitchV1Evidence(
  delegate: HyperswitchV1AdapterPort,
): Readonly<{
  readonly adapter: AttestedHyperswitchV1AdapterPort
  readonly verifier: HyperswitchV1EvidenceVerifier
}> {
  const evidenceByReceipt = new WeakMap<object, VerifiedHyperswitchV1Evidence>()

  function seal<Kind extends HyperswitchV1EvidenceKind>(
    evidence: Extract<VerifiedHyperswitchV1Evidence, { readonly kind: Kind }>,
  ): HyperswitchV1EvidenceReceipt<Kind> {
    const receipt = Object.freeze({ kind: evidence.kind }) as unknown as
      HyperswitchV1EvidenceReceipt<Kind>
    evidenceByReceipt.set(receipt, snapshotEvidence(evidence))
    return receipt
  }

  const verifier: HyperswitchV1EvidenceVerifier = Object.freeze({
    require(receipt: HyperswitchV1EvidenceReceipt) {
      if (receipt === null || typeof receipt !== "object") {
        throw new TypeError("Unrecognized Hyperswitch V1 evidence receipt.")
      }
      const evidence = evidenceByReceipt.get(receipt)
      if (!evidence || evidence.kind !== receipt.kind) {
        throw new TypeError("Unrecognized Hyperswitch V1 evidence receipt.")
      }
      return evidence
    },
  })

  const adapter: AttestedHyperswitchV1AdapterPort = Object.freeze({
    configuration: () => delegate.configuration(),
    async createPayment(input: HyperswitchV1CreateInput) {
      const result = await delegate.createPayment(input)
      if (result.kind === "uncertain") return result
      const evidence = seal({
        kind: "create_observation",
        observation: result.observation,
      })
      if (result.kind === "ready") {
        return {
          kind: result.kind,
          observedAt: result.observedAt,
          checkoutGrant: result.checkoutGrant,
          evidence,
        }
      }
      return {
        kind: result.kind,
        observedAt: result.observedAt,
        evidence,
      }
    },
    async retrievePayment(input: HyperswitchV1RetrieveInput) {
      const requestedPaymentId = stablePaymentId(input.merchantPaymentId)
      const result = await delegate.retrievePayment(input)
      if (result.kind === "uncertain") return result
      if (result.kind === "not_found") {
        return {
          kind: result.kind,
          observedAt: result.observedAt,
          evidence: seal({
            kind: "retrieve_not_found",
            providerPaymentRef: providerPaymentRef(requestedPaymentId),
          }),
        }
      }
      return {
        kind: result.kind,
        observedAt: result.observedAt,
        evidence: seal({
          kind: "retrieve_observation",
          observation: result.observation,
        }),
        ...(result.checkoutGrant
          ? { checkoutGrant: result.checkoutGrant }
          : {}),
      }
    },
  })

  return Object.freeze({ adapter, verifier })
}

type RequestSpec = {
  readonly method: "POST"
  readonly path: "/payments"
  readonly body: Readonly<Record<string, unknown>>
} | {
  readonly method: "GET"
  readonly path: string
}

type RequestResult = {
  readonly kind: "response"
  readonly response: Response
} | {
  readonly kind: "uncertain"
  readonly error: HyperswitchV1UncertainError
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function blockedConfiguration(
  code: "hyperswitch_v1_configuration_missing" | "hyperswitch_v1_configuration_invalid",
  missing: readonly RequiredEnvironmentName[],
  invalid: readonly RequiredEnvironmentName[],
): Extract<HyperswitchV1Configuration, { kind: "blocked" }> {
  return {
    kind: "blocked",
    code,
    message:
      code === "hyperswitch_v1_configuration_missing"
        ? "Hosted V1 checkout requires a server key, profile ID, and explicitly V1-scoped sandbox publishable key."
        : "Hosted V1 checkout configuration is malformed or not sandbox-scoped.",
    missing,
    invalid,
  }
}

function configuredEnvironment(
  env: HyperswitchV1AdapterDependencies["env"],
): ConfiguredEnvironmentResult {
  const missing = REQUIRED_ENVIRONMENT_NAMES.filter(
    (name) => !env[name]?.trim(),
  )
  if (missing.length > 0) {
    return {
      kind: "blocked",
      value: blockedConfiguration(
        "hyperswitch_v1_configuration_missing",
        missing,
        [],
      ),
    }
  }

  const apiKey = env.HYPERSWITCH_API_KEY!.trim()
  const profileId = env.HYPERSWITCH_PROFILE_ID!.trim()
  const publishableKey = env.HYPERSWITCH_PUBLISHABLE_KEY_V1!.trim()
  const invalid: RequiredEnvironmentName[] = []
  if (!SAFE_API_KEY.test(apiKey)) invalid.push("HYPERSWITCH_API_KEY")
  if (!SAFE_PROFILE_ID.test(profileId)) invalid.push("HYPERSWITCH_PROFILE_ID")
  if (!SAFE_V1_PUBLISHABLE_KEY.test(publishableKey)) {
    invalid.push("HYPERSWITCH_PUBLISHABLE_KEY_V1")
  }
  if (invalid.length > 0) {
    return {
      kind: "blocked",
      value: blockedConfiguration(
        "hyperswitch_v1_configuration_invalid",
        [],
        invalid,
      ),
    }
  }

  return {
    kind: "ready",
    value: { apiKey, profileId, publishableKey },
  }
}

function invalidInput(message: string): never {
  throw new HyperswitchV1AdapterError("invalid_input", message)
}

function invalidResponse(): never {
  throw new HyperswitchV1AdapterError(
    "invalid_response",
    "Hyperswitch returned a response that failed the V1 payment contract.",
  )
}

function requiredEnvironment(
  env: HyperswitchV1AdapterDependencies["env"],
): ConfiguredV1Environment {
  const configured = configuredEnvironment(env)
  if (configured.kind === "ready") return configured.value
  throw new HyperswitchV1AdapterError(
    "configuration_blocked",
    "Hyperswitch V1 checkout is not configured.",
  )
}

function stablePaymentId(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_ID.test(value)) {
    return invalidInput(
      "The stable merchant payment ID must be a 30-character pay_ identifier.",
    )
  }
  return value
}

function immutableTerms(value: unknown): ImmutableOrderPaymentTermsV1 {
  if (!isPlainRecord(value)) {
    return invalidInput("Immutable payment terms are required.")
  }
  if (
    typeof value.amountMinor !== "number" ||
    !Number.isSafeInteger(value.amountMinor) ||
    value.amountMinor <= 0
  ) {
    return invalidInput(
      "The immutable order amount must be a positive safe integer.",
    )
  }
  if (
    typeof value.currency !== "string" ||
    !ISO_CURRENCY.test(value.currency)
  ) {
    return invalidInput(
      "The immutable order currency must be an uppercase ISO-3 code.",
    )
  }
  if (
    typeof value.itemCount !== "number" ||
    !Number.isSafeInteger(value.itemCount) ||
    value.itemCount < 1 ||
    value.itemCount > 4
  ) {
    return invalidInput("The immutable order must contain one to four items.")
  }
  return {
    amountMinor: value.amountMinor,
    currency: value.currency,
    itemCount: value.itemCount,
  }
}

function safeText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) {
    return invalidInput(`${label} must be printable text.`)
  }
  const normalized = value.trim().replace(/\s+/g, " ")
  if (normalized.length === 0 || normalized.length > maximumLength) {
    return invalidInput(`${label} is outside the permitted length.`)
  }
  if (SECRET_LIKE_VALUE.test(normalized)) {
    return invalidInput(
      `${label} must not contain payment credentials or personal data.`,
    )
  }
  return normalized
}

function sanitizedMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    return invalidInput("Payment metadata must be a plain object.")
  }
  const entries = Object.entries(value)
  if (entries.length > 8) {
    return invalidInput("Payment metadata is limited to eight fields.")
  }
  const sanitized: Record<string, string> = {}
  for (const [key, rawValue] of entries) {
    if (!SAFE_METADATA_KEY.test(key) || FORBIDDEN_METADATA_KEY.test(key)) {
      return invalidInput("Payment metadata contains a prohibited field name.")
    }
    sanitized[key] = safeText(rawValue, "Payment metadata value", 120)
  }
  return sanitized
}

function sanitizedItems(
  value: unknown,
  terms: ImmutableOrderPaymentTermsV1,
): readonly HyperswitchV1OrderItem[] {
  if (!Array.isArray(value) || value.length !== terms.itemCount) {
    return invalidInput(
      "Order details must match the immutable order item count.",
    )
  }
  if (value.length < 1 || value.length > 4) {
    return invalidInput("Order details are limited to one to four items.")
  }

  let total = 0
  const items = value.map((candidate): HyperswitchV1OrderItem => {
    if (!isPlainRecord(candidate)) {
      return invalidInput("Each order detail must be a plain object.")
    }
    if (candidate.quantity !== 1) {
      return invalidInput(
        "Each immutable ticket order detail must have quantity one.",
      )
    }
    if (
      typeof candidate.amountMinor !== "number" ||
      !Number.isSafeInteger(candidate.amountMinor) ||
      candidate.amountMinor <= 0
    ) {
      return invalidInput(
        "Each order detail amount must be a positive safe integer.",
      )
    }
    if (!Number.isSafeInteger(total + candidate.amountMinor)) {
      return invalidInput("Order detail amounts exceed the safe integer range.")
    }
    total += candidate.amountMinor
    return {
      name: safeText(candidate.name, "Order detail name", 96),
      quantity: 1,
      amountMinor: candidate.amountMinor,
    }
  })
  if (total !== terms.amountMinor) {
    return invalidInput(
      "Order detail amounts must equal the immutable order amount.",
    )
  }
  return items
}

function boundedSessionExpirySeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > HYPERSWITCH_V1_MAX_SESSION_EXPIRY_SECONDS
  ) {
    return invalidInput(
      "Checkout session expiry must be a positive integer no greater than 900 seconds.",
    )
  }
  return value
}

function canonicalAllowedOrigins(
  origins: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 8) {
    return invalidInput(
      "At least one bounded checkout return origin is required.",
    )
  }
  const canonical = new Set<string>()
  for (const raw of origins) {
    if (typeof raw !== "string" || raw.length > 255) {
      return invalidInput("A checkout return origin is invalid.")
    }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return invalidInput("A checkout return origin is invalid.")
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      raw.replace(/\/$/, "") !== parsed.origin
    ) {
      return invalidInput(
        "A checkout return origin must be an exact HTTP(S) origin.",
      )
    }
    canonical.add(parsed.origin)
  }
  return canonical
}

function allowlistedReturnUrl(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return invalidInput("The checkout return URL is invalid.")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalidInput("The checkout return URL is invalid.")
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !allowedOrigins.has(parsed.origin)
  ) {
    return invalidInput(
      "The checkout return URL is not on the server allowlist.",
    )
  }
  return parsed.toString()
}

function observedAt(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new HyperswitchV1AdapterError(
      "configuration_blocked",
      "The adapter clock returned an invalid instant.",
    )
  }
  return value.toISOString()
}

function uncertainty(httpStatus: number | null): HyperswitchV1UncertainError {
  return {
    code: "hyperswitch_outcome_uncertain",
    message:
      "Hyperswitch did not return a definitive outcome. Retrieve the same payment before any retry.",
    httpStatus,
  }
}

function echoedPayment(
  payload: unknown,
  merchantPaymentId: string,
  terms: ImmutableOrderPaymentTermsV1,
  profileId: string,
): Record<string, unknown> {
  if (!isPlainRecord(payload)) return invalidResponse()
  if (
    payload.payment_id !== merchantPaymentId ||
    payload.amount !== terms.amountMinor ||
    payload.currency !== terms.currency ||
    payload.profile_id !== profileId ||
    typeof payload.status !== "string" ||
    !SAFE_PROVIDER_STATUS.test(payload.status)
  ) {
    return invalidResponse()
  }
  return payload
}

function normalizedObservation(
  payload: unknown,
  source: "create" | "retrieve",
): NormalizedPaymentObservationV1 {
  try {
    return normalizeHyperswitchPaymentObservationV1(payload, source)
  } catch {
    return invalidResponse()
  }
}

function usableClientSecret(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 12 &&
    value.length <= 512 &&
    !CONTROL_CHARACTER.test(value) &&
    !/\s/.test(value)
    ? value
    : null
}

/**
 * Requests only the official Hyperswitch SDK's provider surface. The SDK owns
 * the actual provider URL and retains its top-level redirect fallback.
 */
export function isOfficialIframeReturnEligibleV1(returnUrl: string): boolean {
  try {
    const parsed = new URL(returnUrl)
    const localOriginKind = classifyOnsaleLocalOriginV1(parsed.origin)
    return (
      (localOriginKind === "portless_http" ||
        localOriginKind === "portless_https") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/api/onsale/return" &&
      parsed.search === "" &&
      parsed.hash === ""
    )
  } catch {
    return false
  }
}

function createBody(
  input: HyperswitchV1CreateInput,
  environment: ConfiguredV1Environment,
  allowedOrigins: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const merchantPaymentId = stablePaymentId(input.merchantPaymentId)
  const terms = immutableTerms(input.terms)
  const items = sanitizedItems(input.items, terms)
  const returnUrl = allowlistedReturnUrl(input.returnUrl, allowedOrigins)
  return {
    payment_id: merchantPaymentId,
    amount: terms.amountMinor,
    currency: terms.currency,
    profile_id: environment.profileId,
    confirm: false,
    capture_method: "automatic",
    session_expiry: boundedSessionExpirySeconds(input.sessionExpirySeconds),
    return_url: returnUrl,
    ...(isOfficialIframeReturnEligibleV1(returnUrl)
      ? { is_iframe_redirection_enabled: true }
      : {}),
    description: safeText(input.description, "Payment description", 128),
    metadata: sanitizedMetadata(input.metadata),
    order_details: items.map((item) => ({
      product_name: item.name,
      quantity: item.quantity,
      amount: item.amountMinor,
    })),
  }
}

/**
 * Pinned, server-only V1 transport boundary. It performs exactly one sandbox
 * request per method call and returns no provider payload or raw identifier.
 */
export class HyperswitchV1Adapter {
  private readonly environmentSource: HyperswitchV1AdapterDependencies["env"]
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly clock: () => Date
  private readonly allowedReturnOrigins: ReadonlySet<string>
  private readonly timeoutMs: number

  constructor(dependencies: HyperswitchV1AdapterDependencies) {
    if (!dependencies || typeof dependencies !== "object") {
      throw new HyperswitchV1AdapterError(
        "configuration_blocked",
        "Hyperswitch V1 adapter dependencies are required.",
      )
    }
    if (
      typeof dependencies.fetch !== "function" ||
      typeof dependencies.now !== "function"
    ) {
      throw new HyperswitchV1AdapterError(
        "configuration_blocked",
        "Hyperswitch V1 adapter transport and clock are required.",
      )
    }
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new HyperswitchV1AdapterError(
        "configuration_blocked",
        "Hyperswitch V1 adapter timeout is outside the permitted bound.",
      )
    }
    this.environmentSource = dependencies.env
    this.fetchImplementation = dependencies.fetch
    this.clock = dependencies.now
    this.allowedReturnOrigins = canonicalAllowedOrigins(
      dependencies.allowedReturnOrigins,
    )
    this.timeoutMs = timeoutMs
  }

  configuration(): HyperswitchV1Configuration {
    const configured = configuredEnvironment(this.environmentSource)
    if (configured.kind === "blocked") return configured.value
    return {
      kind: "ready",
      provider: "hyperswitch",
      apiVersion: "v1",
      environment: "sandbox",
      publishableKeyScope: "explicit_v1_env_only",
    }
  }

  private async request(
    environment: ConfiguredV1Environment,
    request: RequestSpec,
  ): Promise<RequestResult> {
    let response: Response
    try {
      response = await this.fetchImplementation(
        `${HYPERSWITCH_V1_SANDBOX_ORIGIN}${request.path}`,
        {
          method: request.method,
          headers: {
            Accept: "application/json",
            "api-key": environment.apiKey,
            ...(request.method === "POST"
              ? { "Content-Type": "application/json" }
              : {}),
          },
          body:
            request.method === "POST"
              ? JSON.stringify(request.body)
              : undefined,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      )
    } catch {
      return { kind: "uncertain", error: uncertainty(null) }
    }

    if (response.redirected) return invalidResponse()
    if (request.method === "GET" && response.status === 404) {
      return { kind: "response", response }
    }
    if (response.status >= 500 || [408, 425, 429].includes(response.status)) {
      return {
        kind: "uncertain",
        error: uncertainty(response.status),
      }
    }
    if (!response.ok) {
      throw new HyperswitchV1AdapterError(
        "request_rejected",
        "Hyperswitch rejected the request. No automatic retry was performed.",
        response.status,
      )
    }
    return { kind: "response", response }
  }

  async createPayment(
    input: HyperswitchV1CreateInput,
  ): Promise<HyperswitchV1CreateResult> {
    const environment = requiredEnvironment(this.environmentSource)
    // Snapshot every fact used again after provider I/O. Callers can supply a
    // structurally valid but mutable object; an in-flight mutation must never
    // change which payment identity or money the response is checked against.
    const merchantPaymentId = stablePaymentId(input.merchantPaymentId)
    const terms = immutableTerms(input.terms)
    const body = createBody(
      {
        merchantPaymentId,
        terms,
        returnUrl: input.returnUrl,
        sessionExpirySeconds: input.sessionExpirySeconds,
        description: input.description,
        metadata: input.metadata,
        items: input.items,
      },
      environment,
      this.allowedReturnOrigins,
    )
    const request = await this.request(environment, {
      method: "POST",
      path: "/payments",
      body,
    })
    const instant = observedAt(this.clock)
    if (request.kind === "uncertain") {
      return { kind: "uncertain", observedAt: instant, error: request.error }
    }

    let payload: unknown
    try {
      payload = await request.response.json()
    } catch {
      return invalidResponse()
    }
    const source = echoedPayment(
      payload,
      merchantPaymentId,
      terms,
      environment.profileId,
    )
    const observation = normalizedObservation(source, "create")
    if (observation.canonicalState !== "requires_method") {
      return {
        kind: "reconcile_required",
        observedAt: instant,
        observation,
      }
    }
    const clientSecret = usableClientSecret(source.client_secret)
    if (!clientSecret) {
      return invalidResponse()
    }
    return {
      kind: "ready",
      observedAt: instant,
      checkoutGrant: {
        clientSecret,
        publishableKey: environment.publishableKey,
      },
      observation,
    }
  }

  async retrievePayment(
    input: HyperswitchV1RetrieveInput,
  ): Promise<HyperswitchV1RetrieveResult> {
    const environment = requiredEnvironment(this.environmentSource)
    const merchantPaymentId = stablePaymentId(input.merchantPaymentId)
    const terms = immutableTerms(input.terms)
    const request = await this.request(environment, {
      method: "GET",
      path: `/payments/${merchantPaymentId}?force_sync=true&expand_attempts=true`,
    })
    const instant = observedAt(this.clock)
    if (request.kind === "uncertain") {
      return { kind: "uncertain", observedAt: instant, error: request.error }
    }
    if (request.response.status === 404) {
      return { kind: "not_found", observedAt: instant }
    }

    let payload: unknown
    try {
      payload = await request.response.json()
    } catch {
      return invalidResponse()
    }
    const source = echoedPayment(
      payload,
      merchantPaymentId,
      terms,
      environment.profileId,
    )
    const observation = normalizedObservation(source, "retrieve")
    const clientSecret = usableClientSecret(source.client_secret)
    const checkoutGrant =
      observation.canonicalState === "requires_method" && clientSecret
        ? {
            clientSecret,
            publishableKey: environment.publishableKey,
          }
        : null
    return {
      kind: "found",
      observedAt: instant,
      observation,
      ...(checkoutGrant ? { checkoutGrant } : {}),
    }
  }
}
