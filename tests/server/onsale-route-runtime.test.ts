import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  parseHoldCommandSuccessV1,
  parseOnsaleInventorySnapshotV1,
  parsePublicRefV1,
  parseQuoteSeatsResponseV1,
} from "../../src/domain/onsale-public-contract"
import { InventoryRepositoryError } from "../../src/server/inventory-neon"
import {
  OnsaleHttpGuardError,
  parseConfiguredOriginsV1,
} from "../../src/server/onsale-http-guards"
import {
  classifyOnsaleRouteThrowableV1,
  createProductionOnsaleRouteDependenciesV1,
  handleOnsaleHoldExpirePostV1,
  handleOnsaleHoldPostV1,
  handleOnsaleHoldReleasePostV1,
  handleOnsaleQuotePostV1,
  handleOnsaleSessionGetV1,
  resolveOnsaleSecureCookieV1,
  type OnsaleRouteDependenciesV1,
  type OnsaleRouteServiceV1,
} from "../../src/server/onsale-route-runtime"
import { money, snapshotFixtureV1, uuidV4 } from "../fixtures/onsale-public-v1"
import * as expireRoute from "../../app/api/onsale/holds/[holdRef]/expire/route"
import * as releaseRoute from "../../app/api/onsale/holds/[holdRef]/release/route"
import * as holdRoute from "../../app/api/onsale/holds/route"
import * as quoteRoute from "../../app/api/onsale/quotes/route"
import * as sessionRoute from "../../app/api/onsale/session/route"

const SESSION_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)
const ALLOWED_ORIGIN = "https://onsale.example"

function expectedBuyerRef(): string {
  return `sess_${createHash("sha256")
    .update("onsale-session-v1\0", "utf8")
    .update(SESSION_BYTES)
    .digest("hex")}`
}

function publicSnapshot() {
  return parseOnsaleInventorySnapshotV1(snapshotFixtureV1())
}

function serviceDouble() {
  const snapshot = publicSnapshot()
  const snapshotCall = vi.fn(async (_buyerRef: string) => snapshot)
  const quoteCall = vi.fn(
    async (
      _buyerRef: string,
      request: Parameters<OnsaleRouteServiceV1["quote"]>[1],
    ) =>
      parseQuoteSeatsResponseV1({
        ok: true,
        requestId: request.requestId,
        basisRevision: snapshot.revision,
        quoteRevision: `sha256:${"1".repeat(64)}`,
        saleWindowRef: request.saleWindowRef,
        seatRefs: request.seatRefs,
        items: request.seatRefs.map((seatRef) => ({
          seatRef,
          sectionLabel: "Section A",
          rowLabel: "A",
          seatLabel: "1",
          priceTier: "Standard",
          price: money(),
        })),
        totals: money(
          18_000 * request.seatRefs.length,
          2_000 * request.seatRefs.length,
          500 * request.seatRefs.length,
        ),
      }),
  )
  const commandResult = (
    commandId: string,
    kind: "hold_claimed" | "hold_released" | "hold_expired",
  ) =>
    parseHoldCommandSuccessV1({
      ok: true,
      command: {
        commandId,
        replayed: false,
        result: {
          kind,
          holdRef: uuidV4(500),
          seatRefs: [uuidV4(101)],
        },
      },
      snapshot,
    })
  const claimCall = vi.fn(
    async (
      _buyerRef: string,
      _operationKey: string,
      request: Parameters<OnsaleRouteServiceV1["claim"]>[2],
    ) => commandResult(request.commandId, "hold_claimed"),
  )
  const releaseCall = vi.fn(
    async (
      _buyerRef: string,
      _operationKey: string,
      commandId: Parameters<OnsaleRouteServiceV1["release"]>[2],
      _holdRef: Parameters<OnsaleRouteServiceV1["release"]>[3],
    ) => commandResult(commandId, "hold_released"),
  )
  const expireCall = vi.fn(
    async (
      _buyerRef: string,
      _operationKey: string,
      commandId: Parameters<OnsaleRouteServiceV1["expire"]>[2],
      _holdRef: Parameters<OnsaleRouteServiceV1["expire"]>[3],
    ) => commandResult(commandId, "hold_expired"),
  )
  const service: OnsaleRouteServiceV1 = {
    snapshot: snapshotCall,
    quote: quoteCall,
    claim: claimCall,
    release: releaseCall,
    expire: expireCall,
  }
  return {
    service,
    snapshotCall,
    quoteCall,
    claimCall,
    releaseCall,
    expireCall,
  }
}

function dependencies(
  service: OnsaleRouteServiceV1,
): OnsaleRouteDependenciesV1 {
  return {
    service,
    configuredOrigins: parseConfiguredOriginsV1([ALLOWED_ORIGIN]),
    secureCookie: true,
    randomBytes: () => SESSION_BYTES,
  }
}

function postRequest(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`https://internal.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ALLOWED_ORIGIN,
      host: "untrusted-forwarded-host.invalid",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function tokenFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")
  const match = cookie?.match(/^onsale_session_v1=([^;]+);/u)
  if (!match) throw new Error("Expected the response to set a session cookie")
  return match[1]
}

describe("C2 App Router HTTP runtime", () => {
  it("exposes only the five dynamic Node.js App Router handlers", () => {
    for (const route of [
      sessionRoute,
      quoteRoute,
      holdRoute,
      releaseRoute,
      expireRoute,
    ]) {
      expect(route.runtime).toBe("nodejs")
      expect(route.dynamic).toBe("force-dynamic")
    }
    expect(sessionRoute.GET).toBeTypeOf("function")
    for (const route of [quoteRoute, holdRoute, releaseRoute, expireRoute]) {
      expect(route.POST).toBeTypeOf("function")
    }
  })

  it("uses non-Secure cookies only for an approved local HTTP allowlist or a safe explicit override", () => {
    const local = parseConfiguredOriginsV1([
      "http://localhost:3000",
      "http://127.0.0.1:3001",
      "http://[::1]:3002",
    ])
    const hosted = parseConfiguredOriginsV1(["https://onsale.example"])

    expect(resolveOnsaleSecureCookieV1({}, local)).toBe(false)
    expect(resolveOnsaleSecureCookieV1({}, hosted)).toBe(true)
    expect(
      resolveOnsaleSecureCookieV1({ ONSALE_COOKIE_SECURE: "true" }, local),
    ).toBe(true)
    expect(() =>
      resolveOnsaleSecureCookieV1({ ONSALE_COOKIE_SECURE: "false" }, hosted),
    ).toThrow(/approved local HTTP origin allowlist/u)
    expect(() =>
      resolveOnsaleSecureCookieV1({ ONSALE_COOKIE_SECURE: "sometimes" }, local),
    ).toThrow(/ONSALE_COOKIE_SECURE/u)
  })

  it("classifies only allowlisted throwable families and never forwards raw messages", () => {
    let parserFailure: unknown
    try {
      parsePublicRefV1("private-invalid-selector")
    } catch (error) {
      parserFailure = error
    }
    const cases: readonly [unknown, string, number][] = [
      [
        new OnsaleHttpGuardError("request_origin_denied"),
        "REQUEST_ORIGIN_DENIED",
        403,
      ],
      [parserFailure, "INVALID_REQUEST", 400],
      [
        new InventoryRepositoryError(
          "HOLD_OWNERSHIP_MISMATCH",
          "private buyerRef and SQL row",
        ),
        "HOLD_NOT_FOUND",
        404,
      ],
      [
        new InventoryRepositoryError("QUOTE_STALE", "private quote details"),
        "QUOTE_STALE",
        409,
      ],
      [
        new InventoryRepositoryError(
          "ACTIVE_HOLD_EXISTS",
          "private active hold",
        ),
        "ACTIVE_HOLD_EXISTS",
        409,
      ],
      [
        new InventoryRepositoryError("HOLD_NOT_ACTIVE", "private hold state"),
        "HOLD_NOT_ACTIVE",
        409,
      ],
      [
        new InventoryRepositoryError(
          "INVENTORY_INTEGRITY",
          "private invariant and SQL",
        ),
        "INVENTORY_INTEGRITY_ERROR",
        503,
      ],
      [
        new InventoryRepositoryError(
          "UNRECOGNIZED_PRIVATE_CODE",
          "postgres password private",
        ),
        "INVENTORY_TEMPORARILY_UNAVAILABLE",
        503,
      ],
      [
        new Error("postgres://user:password@example.test/private"),
        "INVENTORY_TEMPORARILY_UNAVAILABLE",
        503,
      ],
    ]

    for (const [throwable, code, status] of cases) {
      const classified = classifyOnsaleRouteThrowableV1(throwable)
      const serialized = JSON.stringify(classified)
      expect(classified.status).toBe(status)
      expect(classified.body.error.code).toBe(code)
      expect(serialized).not.toMatch(
        /buyerRef|password|postgres|SQL row|private invariant/iu,
      )
    }
  })

  it("GET mints and then reuses an HttpOnly session without exposing identity", async () => {
    const doubled = serviceDouble()
    const runtime = dependencies(doubled.service)
    const first = await handleOnsaleSessionGetV1(
      new Request("https://internal.invalid/api/onsale/session"),
      runtime,
    )
    const token = tokenFrom(first)
    const refresh = await handleOnsaleSessionGetV1(
      new Request("https://internal.invalid/api/onsale/session", {
        headers: { cookie: `other=v; onsale_session_v1=${token}` },
      }),
      runtime,
    )

    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    expect(first.headers.get("vary")).toBe("Cookie")
    expect(first.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )
    expect(first.headers.get("set-cookie")).toContain(
      "Max-Age=86400; Path=/; HttpOnly; SameSite=Lax; Secure",
    )
    expect(refresh.headers.get("set-cookie")).toBeNull()
    expect(doubled.snapshotCall).toHaveBeenNthCalledWith(1, expectedBuyerRef())
    expect(doubled.snapshotCall).toHaveBeenNthCalledWith(2, expectedBuyerRef())
    for (const response of [first, refresh]) {
      const serialized = JSON.stringify(await response.json())
      expect(serialized).not.toContain(token)
      expect(serialized).not.toContain(expectedBuyerRef())
    }
  })

  it("omits Secure on the actual localhost cookie response only when the resolver allows it", async () => {
    const doubled = serviceDouble()
    const configuredOrigins = parseConfiguredOriginsV1([
      "http://localhost:3000",
    ])
    const response = await handleOnsaleSessionGetV1(
      new Request("http://localhost:3000/api/onsale/session"),
      {
        service: doubled.service,
        configuredOrigins,
        secureCookie: resolveOnsaleSecureCookieV1({}, configuredOrigins),
        randomBytes: () => SESSION_BYTES,
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain(
      "Max-Age=86400; Path=/; HttpOnly; SameSite=Lax",
    )
    expect(response.headers.get("set-cookie")).not.toContain("; Secure")
  })

  it("quotes through the strict public parser while ignoring Host as authority", async () => {
    const doubled = serviceDouble()
    const requestId = uuidV4(900)
    const response = await handleOnsaleQuotePostV1(
      postRequest("/api/onsale/quotes", {
        requestId,
        saleWindowRef: uuidV4(3),
        seatRefs: [uuidV4(101), uuidV4(102)],
      }),
      dependencies(doubled.service),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, requestId })
    expect(doubled.quoteCall).toHaveBeenCalledWith(
      expectedBuyerRef(),
      expect.objectContaining({
        requestId,
        seatRefs: [uuidV4(101), uuidV4(102)],
      }),
    )
  })

  it("accepts only the canonical named local preview origin when configuration is omitted", async () => {
    const doubled = serviceDouble()
    const production = createProductionOnsaleRouteDependenciesV1({
      DATABASE_URL: "postgresql://sandbox.invalid/onsale",
    })
    const runtime: OnsaleRouteDependenciesV1 = {
      service: doubled.service,
      configuredOrigins: production.configuredOrigins,
      secureCookie: production.secureCookie,
      randomBytes: () => SESSION_BYTES,
    }
    const body = {
      requestId: uuidV4(904),
      saleWindowRef: uuidV4(3),
      seatRefs: [uuidV4(101)],
    }

    const local = await handleOnsaleQuotePostV1(
      postRequest("/api/onsale/quotes", body, {
        origin: "http://onsale-v01.localhost:4310",
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      }),
      runtime,
    )
    const attacker = await handleOnsaleQuotePostV1(
      postRequest("/api/onsale/quotes", body, {
        origin: "https://attacker.example",
        host: "localhost:3102",
        "x-forwarded-host": "localhost:3102",
        "x-forwarded-proto": "http",
      }),
      runtime,
    )

    expect(local.status).toBe(200)
    expect(production.configuredOrigins).toEqual(
      new Set(["http://onsale-v01.localhost:4310"]),
    )
    expect(production.secureCookie).toBe(false)
    expect(attacker.status).toBe(403)
    expect(await attacker.json()).toMatchObject({
      error: { code: "REQUEST_ORIGIN_DENIED" },
    })
    expect(doubled.quoteCall).toHaveBeenCalledOnce()
  })

  it("derives the claim operation key from the private session and command", async () => {
    const doubled = serviceDouble()
    const commandId = uuidV4(901)
    const response = await handleOnsaleHoldPostV1(
      postRequest("/api/onsale/holds", {
        commandId,
        saleWindowRef: uuidV4(3),
        seatRefs: [uuidV4(101)],
        quoteRevision: `sha256:${"1".repeat(64)}`,
      }),
      dependencies(doubled.service),
    )
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(200)
    expect(doubled.claimCall).toHaveBeenCalledWith(
      expectedBuyerRef(),
      `c2:${expectedBuyerRef()}:${commandId}`,
      expect.objectContaining({ commandId }),
    )
    expect(serialized).not.toContain(expectedBuyerRef())
    expect(serialized).not.toContain("operationKey")
  })

  it("binds release and expiry to the path hold and session operation key", async () => {
    const doubled = serviceDouble()
    const runtime = dependencies(doubled.service)
    const holdRef = uuidV4(500)
    const releaseCommand = uuidV4(902)
    const expireCommand = uuidV4(903)

    const released = await handleOnsaleHoldReleasePostV1(
      postRequest(`/api/onsale/holds/${holdRef}/release`, {
        commandId: releaseCommand,
      }),
      holdRef,
      runtime,
    )
    const expired = await handleOnsaleHoldExpirePostV1(
      postRequest(`/api/onsale/holds/${holdRef}/expire`, {
        commandId: expireCommand,
      }),
      holdRef,
      runtime,
    )

    expect(released.status).toBe(200)
    expect(expired.status).toBe(200)
    expect(doubled.releaseCall).toHaveBeenCalledWith(
      expectedBuyerRef(),
      `c2:${expectedBuyerRef()}:${releaseCommand}`,
      releaseCommand,
      holdRef,
    )
    expect(doubled.expireCall).toHaveBeenCalledWith(
      expectedBuyerRef(),
      `c2:${expectedBuyerRef()}:${expireCommand}`,
      expireCommand,
      holdRef,
    )
  })

  it("rejects cross-origin, unknown-key, oversized, and malformed hold requests before service", async () => {
    const doubled = serviceDouble()
    const runtime = dependencies(doubled.service)
    const commandId = uuidV4(901)
    const crossOrigin = await handleOnsaleHoldPostV1(
      postRequest(
        "/api/onsale/holds",
        {
          commandId,
          saleWindowRef: uuidV4(3),
          seatRefs: [uuidV4(101)],
          quoteRevision: `sha256:${"1".repeat(64)}`,
        },
        { origin: "https://evil.example" },
      ),
      runtime,
    )
    const unknownKey = await handleOnsaleHoldPostV1(
      postRequest("/api/onsale/holds", {
        commandId,
        saleWindowRef: uuidV4(3),
        seatRefs: [uuidV4(101)],
        quoteRevision: `sha256:${"1".repeat(64)}`,
        buyerRef: "private",
      }),
      runtime,
    )
    const oversized = await handleOnsaleHoldPostV1(
      postRequest("/api/onsale/holds", { commandId }, {
        "content-length": String(16 * 1024 + 1),
      }),
      runtime,
    )
    const badHold = await handleOnsaleHoldReleasePostV1(
      postRequest("/api/onsale/holds/not-a-ref/release", { commandId }),
      "not-a-ref",
      runtime,
    )

    expect(await crossOrigin.json()).toMatchObject({
      error: { code: "REQUEST_ORIGIN_DENIED" },
    })
    for (const response of [unknownKey, oversized, badHold]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      })
      expect(response.headers.get("cache-control")).toBe("private, no-store")
    }
    expect(doubled.claimCall).not.toHaveBeenCalled()
    expect(doubled.releaseCall).not.toHaveBeenCalled()
  })

  it("maps foreign holds and unknown driver failures without leaking private messages", async () => {
    const doubled = serviceDouble()
    const holdRef = uuidV4(500)
    doubled.releaseCall.mockRejectedValueOnce(
      new InventoryRepositoryError(
        "HOLD_OWNERSHIP_MISMATCH",
        "buyerRef sess_private does not own SQL row",
      ),
    )
    doubled.expireCall.mockRejectedValueOnce(
      new Error("postgres://user:password@example.test/private"),
    )
    const runtime = dependencies(doubled.service)
    const foreign = await handleOnsaleHoldReleasePostV1(
      postRequest(`/api/onsale/holds/${holdRef}/release`, {
        commandId: uuidV4(902),
      }),
      holdRef,
      runtime,
    )
    const unavailable = await handleOnsaleHoldExpirePostV1(
      postRequest(`/api/onsale/holds/${holdRef}/expire`, {
        commandId: uuidV4(903),
      }),
      holdRef,
      runtime,
    )
    const foreignText = JSON.stringify(await foreign.json())
    const unavailableText = JSON.stringify(await unavailable.json())

    expect(foreign.status).toBe(404)
    expect(foreignText).toContain("HOLD_NOT_FOUND")
    expect(unavailable.status).toBe(503)
    expect(unavailableText).toContain("INVENTORY_TEMPORARILY_UNAVAILABLE")
    for (const text of [foreignText, unavailableText]) {
      expect(text).not.toMatch(/buyerRef|password|postgres|SQL|sess_private/iu)
    }
  })

  it("rejects a tainted service result as integrity failure", async () => {
    const doubled = serviceDouble()
    doubled.snapshotCall.mockResolvedValueOnce({
      ...publicSnapshot(),
      buyerRef: "sess_private",
    } as never)
    const response = await handleOnsaleSessionGetV1(
      new Request("https://internal.invalid/api/onsale/session"),
      dependencies(doubled.service),
    )
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(503)
    expect(serialized).toContain("INVENTORY_INTEGRITY_ERROR")
    expect(serialized).not.toContain("sess_private")
  })
})
