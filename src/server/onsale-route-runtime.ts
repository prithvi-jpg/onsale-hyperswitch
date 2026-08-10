import {
  PublicContractParseError,
  parseClaimSeatsRequestV1,
  parseHoldCommandSuccessV1,
  parseHoldSelectorCommandV1,
  parseOnsaleInventorySnapshotV1,
  parsePublicRefV1,
  parseQuoteSeatsRequestV1,
  parseQuoteSeatsResponseV1,
  type ClaimSeatsRequestV1,
  type CommandIdV1,
  type HoldCommandSuccessV1,
  type OnsaleInventorySnapshotV1,
  type PublicRef,
  type QuoteSeatsRequestV1,
  type QuoteSeatsResponseV1,
} from "../domain/onsale-public-contract"
import { InventoryRepositoryError } from "./inventory-neon"
import {
  mapInventoryConditionV1,
  mapUnknownInventoryFailureV1,
  type InventoryBoundaryConditionV1,
  type InventoryErrorMappingV1,
} from "./onsale-error-mapper"
import {
  OnsaleHttpGuardError,
  assertConfiguredOriginV1,
  inventoryPrivateResponseHeadersV1,
  parseBoundedJsonRequestV1,
  parseConfiguredOriginsV1,
  type ConfiguredOriginsV1,
} from "./onsale-http-guards"
import { getOnsaleInventoryServiceV1 } from "./onsale-inventory-runtime"
import {
  ONSALE_PORTLESS_HTTP_ORIGIN_V1,
  classifyOnsaleLocalOriginV1,
} from "./onsale-local-origin"
import {
  ONSALE_SESSION_COOKIE_NAME_V1,
  createSessionOperationKeyV1,
  resolveAnonymousSessionV1,
  serializeOnsaleSessionCookieV1,
  type AnonymousBrowserSessionV1,
  type ResolvedAnonymousSessionV1,
} from "./onsale-session"

export const ONSALE_ALLOWED_ORIGINS_ENV_V1 = "ONSALE_ALLOWED_ORIGINS" as const
export const ONSALE_COOKIE_SECURE_ENV_V1 = "ONSALE_COOKIE_SECURE" as const
export const ONSALE_LOCAL_PREVIEW_ORIGIN_V1 =
  ONSALE_PORTLESS_HTTP_ORIGIN_V1

export interface OnsaleRouteServiceV1 {
  snapshot(buyerRef: string): Promise<OnsaleInventorySnapshotV1>
  quote(
    buyerRef: string,
    request: QuoteSeatsRequestV1,
  ): Promise<QuoteSeatsResponseV1>
  claim(
    buyerRef: string,
    operationKey: string,
    request: ClaimSeatsRequestV1,
  ): Promise<HoldCommandSuccessV1>
  release(
    buyerRef: string,
    operationKey: string,
    commandId: CommandIdV1,
    holdRef: PublicRef,
  ): Promise<HoldCommandSuccessV1>
  expire(
    buyerRef: string,
    operationKey: string,
    commandId: CommandIdV1,
    holdRef: PublicRef,
  ): Promise<HoldCommandSuccessV1>
}

export interface OnsaleRouteDependenciesV1 {
  readonly service: OnsaleRouteServiceV1
  readonly configuredOrigins: ConfiguredOriginsV1
  readonly secureCookie: boolean
  readonly randomBytes?: (size: number) => Uint8Array
}

export interface OnsaleRouteErrorContextV1 {
  commandId?: CommandIdV1
  seatRefs?: readonly PublicRef[]
}

type PublicSuccessV1 = OnsaleInventorySnapshotV1 | QuoteSeatsResponseV1 | HoldCommandSuccessV1

function configuredOriginsFromEnvironmentV1(
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredOriginsV1 {
  const source = environment[ONSALE_ALLOWED_ORIGINS_ENV_V1]
  if (source === undefined) {
    return parseConfiguredOriginsV1([ONSALE_LOCAL_PREVIEW_ORIGIN_V1])
  }
  return parseConfiguredOriginsV1(source.split(","))
}

export function resolveOnsaleSecureCookieV1(
  environment: Readonly<Record<string, string | undefined>>,
  configuredOrigins: ConfiguredOriginsV1,
): boolean {
  const allOriginsPermitInsecureCookies =
    configuredOrigins.size > 0 &&
    [...configuredOrigins].every(
      (origin) =>
        new URL(origin).protocol === "http:" &&
        classifyOnsaleLocalOriginV1(origin) !== null,
    )
  const override = environment[ONSALE_COOKIE_SECURE_ENV_V1]
  if (override === undefined) return !allOriginsPermitInsecureCookies
  if (override === "true") return true
  if (override === "false" && allOriginsPermitInsecureCookies) return false
  throw new Error(
    "ONSALE_COOKIE_SECURE must be true, or false with an approved local HTTP origin allowlist.",
  )
}

export function createProductionOnsaleRouteDependenciesV1(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OnsaleRouteDependenciesV1 {
  const configuredOrigins = configuredOriginsFromEnvironmentV1(environment)
  return {
    service: getOnsaleInventoryServiceV1(environment),
    configuredOrigins,
    secureCookie: resolveOnsaleSecureCookieV1(environment, configuredOrigins),
  }
}

function cookieCandidateV1(request: Request): string | undefined {
  const source = request.headers.get("cookie")
  if (source === null) return undefined
  const matches: string[] = []
  for (const segment of source.split(";")) {
    const normalized = segment.trim()
    const separator = normalized.indexOf("=")
    if (separator < 1) continue
    if (normalized.slice(0, separator) !== ONSALE_SESSION_COOKIE_NAME_V1) {
      continue
    }
    matches.push(normalized.slice(separator + 1))
  }
  return matches.length === 1 ? matches[0] : undefined
}

function jsonResponseV1(
  body: PublicSuccessV1 | InventoryErrorMappingV1["body"],
  status: number,
  resolved: ResolvedAnonymousSessionV1 | undefined,
  secureCookie: boolean,
): Response {
  const headers = new Headers(inventoryPrivateResponseHeadersV1())
  headers.set("Content-Type", "application/json; charset=utf-8")
  if (resolved?.shouldSetCookie) {
    headers.set(
      "Set-Cookie",
      serializeOnsaleSessionCookieV1(resolved.session.cookieToken(), {
        secure: secureCookie,
      }),
    )
  }
  return new Response(JSON.stringify(body), { status, headers })
}

function integrityFromOutputV1<T>(
  value: unknown,
  parser: (candidate: unknown) => T,
): T {
  try {
    return parser(value)
  } catch (error) {
    if (error instanceof PublicContractParseError) {
      throw new InventoryRepositoryError(
        "INVENTORY_INTEGRITY",
        "The inventory service returned a malformed public projection.",
      )
    }
    throw error
  }
}

function verifiedQuoteOutputV1(
  value: unknown,
  request: QuoteSeatsRequestV1,
): QuoteSeatsResponseV1 {
  const parsed = integrityFromOutputV1(value, parseQuoteSeatsResponseV1)
  if (
    parsed.requestId !== request.requestId ||
    parsed.saleWindowRef !== request.saleWindowRef ||
    parsed.seatRefs.length !== request.seatRefs.length ||
    parsed.seatRefs.some(
      (seatRef, index) => seatRef !== request.seatRefs[index],
    )
  ) {
    throw new InventoryRepositoryError(
      "INVENTORY_INTEGRITY",
      "The inventory quote response does not match its request selectors.",
    )
  }
  return parsed
}

function verifiedCommandOutputV1(
  value: unknown,
  input: {
    readonly commandId: CommandIdV1
    readonly allowedKinds: ReadonlySet<HoldCommandSuccessV1["command"]["result"]["kind"]>
    readonly holdRef?: PublicRef
  },
): HoldCommandSuccessV1 {
  const parsed = integrityFromOutputV1(value, parseHoldCommandSuccessV1)
  if (
    parsed.command.commandId !== input.commandId ||
    !input.allowedKinds.has(parsed.command.result.kind) ||
    (input.holdRef !== undefined &&
      parsed.command.result.holdRef !== input.holdRef)
  ) {
    throw new InventoryRepositoryError(
      "INVENTORY_INTEGRITY",
      "The inventory command response does not match its request selectors.",
    )
  }
  return parsed
}

function seatRefsFromErrorV1(
  error: InventoryRepositoryError,
  context: OnsaleRouteErrorContextV1,
): readonly PublicRef[] | undefined {
  if (context.seatRefs && context.seatRefs.length > 0) return context.seatRefs
  const candidates = error.details.seatIds
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined
  try {
    return candidates.map((candidate, index) =>
      parsePublicRefV1(candidate, `$seatRefs[${index}]`),
    )
  } catch {
    return undefined
  }
}

function repositoryConditionV1(
  error: InventoryRepositoryError,
  context: OnsaleRouteErrorContextV1,
): InventoryBoundaryConditionV1 | undefined {
  const commandId = context.commandId
  switch (error.code) {
    case "INVALID_COMMAND":
      return { kind: "invalid_request", commandId }
    case "SALE_WINDOW_POLICY_DENIED":
    case "ACCESS_GRANT_REQUIRED":
    case "ACCESS_GRANT_DENIED":
    case "ACCESS_GRANT_EXPIRED":
      return { kind: "access_required", commandId }
    case "SALE_WINDOW_NOT_FOUND":
    case "SALE_WINDOW_NOT_OPEN":
      return { kind: "sale_window_not_open", commandId }
    case "SEAT_NOT_FOUND":
    case "SEAT_NOT_AVAILABLE": {
      const seatRefs = seatRefsFromErrorV1(error, context)
      return seatRefs
        ? { kind: "seat_not_available", commandId, seatRefs }
        : { kind: "inventory_integrity_error", commandId }
    }
    case "QUOTE_STALE":
      return { kind: "quote_stale", commandId }
    case "ACTIVE_HOLD_EXISTS":
      return { kind: "active_hold_exists", commandId }
    case "HOLD_NOT_FOUND":
    case "HOLD_OWNERSHIP_MISMATCH":
      return { kind: "hold_not_found", commandId }
    case "HOLD_NOT_ACTIVE":
      return { kind: "hold_not_active", commandId }
    case "IDEMPOTENCY_CONFLICT":
      return { kind: "idempotency_conflict", commandId }
    case "INVENTORY_INTEGRITY":
    case "INVALID_HOLD":
    case "HOLD_INVARIANT":
    case "MONEY_INVARIANT":
    case "PRICE_INVARIANT":
    case "PRICE_TIER_NOT_FOUND":
    case "SEED_INVARIANT":
      return { kind: "inventory_integrity_error", commandId }
    default:
      return undefined
  }
}

export function classifyOnsaleRouteThrowableV1(
  error: unknown,
  context: OnsaleRouteErrorContextV1 = {},
): InventoryErrorMappingV1 {
  if (error instanceof OnsaleHttpGuardError) {
    return mapInventoryConditionV1({
      kind: error.kind,
      commandId: context.commandId,
    })
  }
  if (error instanceof PublicContractParseError) {
    return mapInventoryConditionV1({
      kind: "invalid_request",
      commandId: context.commandId,
    })
  }
  if (error instanceof InventoryRepositoryError) {
    const condition = repositoryConditionV1(error, context)
    if (condition) return mapInventoryConditionV1(condition)
  }
  return mapUnknownInventoryFailureV1(error, context.commandId)
}

async function executeRouteV1(
  request: Request,
  dependencies: OnsaleRouteDependenciesV1 | undefined,
  context: OnsaleRouteErrorContextV1,
  work: (
    runtime: OnsaleRouteDependenciesV1,
    session: AnonymousBrowserSessionV1,
    context: OnsaleRouteErrorContextV1,
  ) => Promise<PublicSuccessV1>,
): Promise<Response> {
  let resolved: ResolvedAnonymousSessionV1 | undefined
  let secureCookie = true
  try {
    const runtime =
      dependencies ?? createProductionOnsaleRouteDependenciesV1(process.env)
    secureCookie = runtime.secureCookie
    resolved = resolveAnonymousSessionV1({
      candidateToken: cookieCandidateV1(request),
      randomBytes: runtime.randomBytes,
    })
    const body = await work(runtime, resolved.session, context)
    return jsonResponseV1(body, 200, resolved, secureCookie)
  } catch (error) {
    const mapped = classifyOnsaleRouteThrowableV1(error, context)
    return jsonResponseV1(mapped.body, mapped.status, resolved, secureCookie)
  }
}

function assertMutationOriginV1(
  request: Request,
  runtime: OnsaleRouteDependenciesV1,
): void {
  assertConfiguredOriginV1(
    request.headers.get("origin"),
    runtime.configuredOrigins,
  )
}

export async function handleOnsaleSessionGetV1(
  request: Request,
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  return executeRouteV1(request, dependencies, {}, async (runtime, session) =>
    integrityFromOutputV1(
      await runtime.service.snapshot(session.buyerRef()),
      parseOnsaleInventorySnapshotV1,
    ),
  )
}

export async function handleOnsaleQuotePostV1(
  request: Request,
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  const context: OnsaleRouteErrorContextV1 = {}
  return executeRouteV1(
    request,
    dependencies,
    context,
    async (runtime, session, errorContext) => {
      assertMutationOriginV1(request, runtime)
      const input = await parseBoundedJsonRequestV1(
        request,
        parseQuoteSeatsRequestV1,
      )
      errorContext.seatRefs = input.seatRefs
      return verifiedQuoteOutputV1(
        await runtime.service.quote(session.buyerRef(), input),
        input,
      )
    },
  )
}

export async function handleOnsaleHoldPostV1(
  request: Request,
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  const context: OnsaleRouteErrorContextV1 = {}
  return executeRouteV1(
    request,
    dependencies,
    context,
    async (runtime, session, errorContext) => {
      assertMutationOriginV1(request, runtime)
      const input = await parseBoundedJsonRequestV1(
        request,
        parseClaimSeatsRequestV1,
      )
      errorContext.commandId = input.commandId
      errorContext.seatRefs = input.seatRefs
      const operationKey = createSessionOperationKeyV1(session, input.commandId)
      return verifiedCommandOutputV1(
        await runtime.service.claim(session.buyerRef(), operationKey, input),
        {
          commandId: input.commandId,
          allowedKinds: new Set(["hold_claimed"]),
        },
      )
    },
  )
}

async function handleHoldSelectorPostV1(
  request: Request,
  holdRefCandidate: string,
  action: "release" | "expire",
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  const context: OnsaleRouteErrorContextV1 = {}
  return executeRouteV1(
    request,
    dependencies,
    context,
    async (runtime, session, errorContext) => {
      assertMutationOriginV1(request, runtime)
      const input = await parseBoundedJsonRequestV1(
        request,
        parseHoldSelectorCommandV1,
      )
      errorContext.commandId = input.commandId
      const holdRef = parsePublicRefV1(holdRefCandidate, "$holdRef")
      const operationKey = createSessionOperationKeyV1(session, input.commandId)
      const result = await runtime.service[action](
        session.buyerRef(),
        operationKey,
        input.commandId,
        holdRef,
      )
      return verifiedCommandOutputV1(result, {
        commandId: input.commandId,
        allowedKinds:
          action === "release"
            ? new Set(["hold_released"])
            : new Set(["hold_expired", "hold_not_yet_expired"]),
        holdRef,
      })
    },
  )
}

export async function handleOnsaleHoldReleasePostV1(
  request: Request,
  holdRef: string,
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  return handleHoldSelectorPostV1(request, holdRef, "release", dependencies)
}

export async function handleOnsaleHoldExpirePostV1(
  request: Request,
  holdRef: string,
  dependencies?: OnsaleRouteDependenciesV1,
): Promise<Response> {
  return handleHoldSelectorPostV1(request, holdRef, "expire", dependencies)
}
