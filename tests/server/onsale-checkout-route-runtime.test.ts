import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  CheckoutRouteBoundaryErrorV1,
  createOnsaleOrderPointerV1,
  handleOnsaleCheckoutPreparePostV1,
  handleOnsaleCheckoutReconcilePostV1,
  handleOnsaleCheckoutReturnGetV1,
  type CheckoutCoordinatorProjectionV1,
  type OnsaleCheckoutRouteDependenciesV1,
} from "../../src/server/onsale-checkout-route-runtime"
import { parseConfiguredOriginsV1 } from "../../src/server/onsale-http-guards"
import * as prepareRoute from "../../app/api/onsale/checkout/prepare/route"
import * as reconcileRoute from "../../app/api/onsale/checkout/reconcile/route"
import * as returnRoute from "../../app/api/onsale/return/route"

const ORIGIN = "https://onsale.example"
const ORDER_REF = "00000000-0000-4000-8000-000000000701"
const HOLD_REF = "00000000-0000-4000-8000-000000000501"
const COMMAND_REF = "00000000-0000-4000-8000-000000000901"
const SESSION_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)
const ORDER_COOKIE = `onsale_current_order_v1=${ORDER_REF}`
const SESSION_COOKIE = `onsale_session_v1=${Buffer.from(SESSION_BYTES).toString("base64url")}`
const RECONCILE_COOKIES = `${ORDER_COOKIE}; ${SESSION_COOKIE}`

function expectedBuyerRef(): string {
  return `sess_${createHash("sha256")
    .update("onsale-session-v1\0", "utf8")
    .update(SESSION_BYTES)
    .digest("hex")}`
}

function projection(
  overrides: Partial<CheckoutCoordinatorProjectionV1> = {},
): CheckoutCoordinatorProjectionV1 {
  return {
    stage: "checkout_ready",
    order: {
      state: "payment_pending",
      paymentDeadlineAt: "2026-08-08T20:05:00.000Z",
      currency: "USD",
      subtotalMinor: 18_000,
      feeMinor: 2_000,
      taxMinor: 500,
      totalMinor: 20_500,
      itemCount: 1,
      items: [
        {
          sectionLabel: "Orchestra",
          rowLabel: "A",
          seatLabel: "1",
          priceTier: "Standard",
          faceValueMinor: 18_000,
          feeMinor: 2_000,
          taxMinor: 500,
          totalMinor: 20_500,
          currency: "USD",
        },
      ],
      ticketCount: 0,
    },
    payment: {
      canonicalState: "requires_method",
      integrityState: "clear",
      observationSource: "create",
      selectedMethod: { family: "card", type: "credit" },
      observedConnector: null,
      attempts: [
        {
          ordinal: 1,
          state: "requires_method",
          charged: false,
          hardDecline: false,
          connector: null,
        },
      ],
      chargedAttemptCount: 0,
      evidenceGeneration: 1,
    },
    grant: {
      clientSecret: "secret_client_canary_123456",
      publishableKey: "pk_snd_publishable_canary_123456",
    },
    ...overrides,
  }
}

function dependencies(
  overrides: Partial<OnsaleCheckoutRouteDependenciesV1> = {},
): OnsaleCheckoutRouteDependenciesV1 {
  return {
    configuredOrigins: parseConfiguredOriginsV1([ORIGIN]),
    secureCookie: true,
    cleanReturnLocation: `${ORIGIN}/checkout`,
    randomBytes: (size) =>
      size === 32
        ? SESSION_BYTES
        : Uint8Array.from({ length: size }, (_, index) => index + 1),
    prepare: vi.fn(async () => ({
      orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
      projection: projection(),
    })),
    reconcile: vi.fn(async () =>
      projection({
        stage: "processing",
        payment: {
          ...projection().payment,
          canonicalState: "processing",
          integrityState: "clear",
          attempts: [
            {
              ordinal: 1,
              state: "processing",
              charged: false,
              hardDecline: false,
              connector: null,
            },
          ],
        },
        grant: null,
      }),
    ),
    ...overrides,
  }
}

function postRequest(
  path: string,
  body: unknown,
  cookie?: string,
  origin = ORIGIN,
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

function expectPrivateHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe(
    "private, no-store, max-age=0",
  )
  expect(response.headers.get("vary")).toBe("Cookie, Origin")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("cross-origin-resource-policy")).toBe(
    "same-origin",
  )
}

describe("C3 checkout App Router boundary", () => {
  it("exposes only the dynamic Node handlers for prepare, retrieve-only reconcile, and return", () => {
    for (const route of [prepareRoute, reconcileRoute, returnRoute]) {
      expect(route.runtime).toBe("nodejs")
      expect(route.dynamic).toBe("force-dynamic")
    }
    expect(prepareRoute.POST).toBeTypeOf("function")
    expect(reconcileRoute.POST).toBeTypeOf("function")
    expect(returnRoute.GET).toBeTypeOf("function")
  })

  it("returns the exact private schema, grants only checkout-ready, and sets both HttpOnly cookies", async () => {
    const runtime = dependencies()
    const response = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
      }),
      runtime,
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
    expect(body).toEqual({
      schema: "onsale.checkout-private.v1",
      ok: true,
      stage: "checkout_ready",
      order: projection().order,
      payment: {
        ...projection().payment,
        retryPermitted: true,
        retryReason: "official_checkout_submission_available",
        evidenceRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      checkout: projection().grant,
      message: "SECURE CHECKOUT READY",
    })
    const cookies = response.headers.get("set-cookie") ?? ""
    expect(cookies).toContain("onsale_session_v1=")
    expect(cookies).toContain("onsale_current_order_v1=")
    expect(cookies).toContain("HttpOnly")
    expect(cookies).toContain("SameSite=Lax")
    expect(cookies).toContain("Secure")
    expect(runtime.prepare).toHaveBeenCalledWith({
      buyerRef: expectedBuyerRef(),
      commandId: COMMAND_REF,
      holdRef: HOLD_REF,
    })
    expect(JSON.stringify(body)).not.toContain(ORDER_COOKIE)
    expect(JSON.stringify(body)).not.toMatch(/providerPayment|operationKey/iu)
  })

  it("carries the two discrete prepare cookies into a cookie-only reconcile reload", async () => {
    const runtime = dependencies()
    const prepared = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
      }),
      runtime,
    )
    const setCookies = (prepared.headers as Headers & {
      getSetCookie(): string[]
    }).getSetCookie()
    expect(setCookies).toHaveLength(2)
    expect(
      setCookies.filter((cookie) => cookie.includes("HttpOnly")),
    ).toHaveLength(2)
    const cookieJar = setCookies
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ")

    const returned = await handleOnsaleCheckoutReturnGetV1(
      new Request(
        `${ORIGIN}/api/onsale/return?payment_id=pay_canary&status=succeeded`,
        {
          headers: {
            cookie: cookieJar,
            host: "attacker.invalid",
            "x-forwarded-host": "attacker.invalid",
          },
        },
      ),
      runtime,
    )
    expect(returned.status).toBe(303)
    expect(returned.headers.get("location")).toBe(`${ORIGIN}/checkout`)

    const reconciled = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        { commandId: COMMAND_REF, trigger: "resume" },
        cookieJar,
      ),
      runtime,
    )

    expect(reconciled.status).toBe(202)
    expect(runtime.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ buyerRef: expectedBuyerRef() }),
    )
    expect(runtime.reconcile).toHaveBeenCalledWith({
      buyerRef: expectedBuyerRef(),
      commandId: COMMAND_REF,
      orderPointer: expect.objectContaining({ kind: "onsale_order_pointer" }),
      trigger: "resume",
    })
    expect(runtime.prepare).toHaveBeenCalledTimes(1)
  })

  it("rejects a contradictory grant outside the exact requires-method, clear, checkout-ready tuple", async () => {
    const tainted = projection({
      stage: "processing",
      payment: {
        ...projection().payment,
        canonicalState: "processing",
        integrityState: "clear",
        attempts: [
          {
            ordinal: 1,
            state: "processing",
            charged: false,
            hardDecline: false,
            connector: null,
          },
        ],
      },
    })
    const response = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
      }),
      dependencies({
        prepare: vi.fn(async () => ({
          orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
          projection: tainted,
        })),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      error: { code: "CHECKOUT_INTEGRITY_ERROR" },
    })
    expect(JSON.stringify(body)).not.toContain("secret_client_canary")
    expect(JSON.stringify(body)).not.toContain("pk_snd_publishable_canary")
  })

  it("accepts only exact prepare and reconcile bodies from an allowed Origin", async () => {
    const runtime = dependencies()
    const invalidBodies = [
      { commandId: COMMAND_REF },
      { commandId: COMMAND_REF, holdRef: HOLD_REF, paymentId: "pay_private" },
      { commandId: "not-a-uuid", holdRef: HOLD_REF },
    ]
    for (const body of invalidBodies) {
      const response = await handleOnsaleCheckoutPreparePostV1(
        postRequest("/api/onsale/checkout/prepare", body),
        runtime,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      })
      expectPrivateHeaders(response)
    }
    const denied = await handleOnsaleCheckoutPreparePostV1(
      postRequest(
        "/api/onsale/checkout/prepare",
        { commandId: COMMAND_REF, holdRef: HOLD_REF },
        undefined,
        "https://evil.example",
      ),
      runtime,
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      error: { code: "REQUEST_ORIGIN_DENIED" },
    })
    expect(runtime.prepare).not.toHaveBeenCalled()
  })

  it("fails closed on oversized JSON and duplicate session or order cookies", async () => {
    const runtime = dependencies()
    const oversized = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
        padding: "x".repeat(17 * 1024),
      }),
      runtime,
    )
    const duplicateSession = await handleOnsaleCheckoutPreparePostV1(
      new Request(`${ORIGIN}/api/onsale/checkout/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: "onsale_session_v1=first; onsale_session_v1=second",
        },
        body: JSON.stringify({
          commandId: COMMAND_REF,
          holdRef: HOLD_REF,
        }),
      }),
      runtime,
    )
    const duplicateOrder = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        { commandId: COMMAND_REF, trigger: "resume" },
        `${ORDER_COOKIE}; ${ORDER_COOKIE}`,
      ),
      runtime,
    )

    for (const response of [oversized, duplicateSession]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      })
      expectPrivateHeaders(response)
    }
    expect(duplicateOrder.status).toBe(404)
    expect(await duplicateOrder.json()).toMatchObject({
      error: { code: "ORDER_NOT_FOUND" },
    })
    expectPrivateHeaders(duplicateOrder)
    expect(runtime.prepare).not.toHaveBeenCalled()
    expect(runtime.reconcile).not.toHaveBeenCalled()
  })

  it("requires the existing HttpOnly session and order pointer for retrieve-only reconcile", async () => {
    const runtime = dependencies()
    const response = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        {
          commandId: COMMAND_REF,
          trigger: "refresh",
        },
        RECONCILE_COOKIES,
      ),
      runtime,
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      schema: "onsale.checkout-private.v1",
      stage: "processing",
      checkout: null,
    })
    expect(runtime.reconcile).toHaveBeenCalledWith({
      buyerRef: expectedBuyerRef(),
      commandId: COMMAND_REF,
      orderPointer: expect.objectContaining({ kind: "onsale_order_pointer" }),
      trigger: "refresh",
    })

    const missing = await handleOnsaleCheckoutReconcilePostV1(
      postRequest("/api/onsale/checkout/reconcile", {
        commandId: COMMAND_REF,
        trigger: "resume",
      }),
      runtime,
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({
      error: { code: "ORDER_NOT_FOUND" },
    })
    expect(runtime.reconcile).toHaveBeenCalledTimes(1)

    const missingSession = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        { commandId: COMMAND_REF, trigger: "resume" },
        ORDER_COOKIE,
      ),
      runtime,
    )
    expect(missingSession.status).toBe(404)
    expect(await missingSession.json()).toMatchObject({
      error: { code: "ORDER_NOT_FOUND" },
    })
    expect(missingSession.headers.get("set-cookie") ?? "").not.toContain(
      "onsale_session_v1=",
    )
    expect(runtime.reconcile).toHaveBeenCalledTimes(1)
  })

  it("ignores every provider query value and performs a pure 303 strip with no provider or database work", async () => {
    const runtime = dependencies()
    const request = new Request(
      `${ORIGIN}/api/onsale/return?payment_id=pay_private&client_secret=secret_private&status=succeeded`,
      {
        headers: {
          cookie: `${ORDER_COOKIE}; onsale_session_v1=${Buffer.from(SESSION_BYTES).toString("base64url")}`,
          host: "attacker.invalid",
          "x-forwarded-host": "attacker.invalid",
        },
      },
    )
    const response = await handleOnsaleCheckoutReturnGetV1(request, runtime)

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${ORIGIN}/checkout`)
    expectPrivateHeaders(response)
    expect(await response.text()).toBe("")
    expect(runtime.reconcile).not.toHaveBeenCalled()
    expect(runtime.prepare).not.toHaveBeenCalled()
    const serialized = [...response.headers.entries()].join("\n")
    expect(serialized).not.toMatch(/pay_private|secret_private|succeeded/iu)
  })

  it("reconstructs the DTO so private provider, operation, and return fields cannot escape", async () => {
    const tainted = Object.assign(projection(), {
      providerPaymentRef: "pay_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      paymentId: "00000000-0000-4000-8000-000000000888",
      operation: {
        operationId: "00000000-0000-4000-8000-000000000889",
        operationKey: "00000000-0000-4000-8000-000000000890",
      },
      returnUrl: `${ORIGIN}/api/onsale/return?client_secret=private`,
      payment: Object.assign(projection().payment, {
        providerPaymentRef: "pay_nestedaaaaaaaaaaaaaaaaaaaa",
        operation: {
          operationId: "00000000-0000-4000-8000-000000000891",
          operationKey: "00000000-0000-4000-8000-000000000892",
        },
        returnUrl: `${ORIGIN}/nested-private-return`,
      }),
      order: Object.assign(projection().order, {
        internalOrderId: "00000000-0000-4000-8000-000000000893",
      }),
    })
    const response = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
      }),
      dependencies({
        prepare: vi.fn(async () => ({
          orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
          projection: tainted,
        })),
      }),
    )
    const text = JSON.stringify(await response.json())

    expect(response.status).toBe(200)
    expect(text).not.toMatch(/pay_[a-f0-9]{26}/u)
    expect(text).not.toMatch(/providerPayment|paymentId|operation|returnUrl/iu)
    expect(text).not.toMatch(/internalOrderId|nested-private/iu)
    expect(text).not.toContain("/api/onsale/return")
  })

  it("maps a structurally valid cross-buyer pointer to a fixed 404 and performs no create path", async () => {
    const runtime = dependencies({
      reconcile: vi.fn(async () => {
        throw new CheckoutRouteBoundaryErrorV1("order_not_found")
      }),
    })
    const response = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        { commandId: COMMAND_REF, trigger: "resume" },
        `onsale_current_order_v1=00000000-0000-4000-8000-000000000799; ${SESSION_COOKIE}`,
      ),
      runtime,
    )
    const text = JSON.stringify(await response.json())

    expect(response.status).toBe(404)
    expect(text).toContain("ORDER_NOT_FOUND")
    expect(text).not.toMatch(/buyer|00000000-0000-4000-8000-000000000799/iu)
    expect(runtime.reconcile).toHaveBeenCalledTimes(1)
    expect(runtime.prepare).not.toHaveBeenCalled()
  })

  it("retains the bounded HttpOnly order pointer intentionally across unknown and terminal projections", async () => {
    const checking = projection({
      stage: "checking_same_payment",
      payment: {
        ...projection().payment,
        canonicalState: "uncertain",
        integrityState: "clear",
        observationSource: null,
        selectedMethod: null,
        attempts: [],
        evidenceGeneration: 0,
      },
      grant: null,
    })
    const fulfilled = projection({
      stage: "fulfilled",
      order: {
        ...projection().order,
        state: "fulfilled",
        ticketCount: 1,
      },
      payment: {
        ...projection().payment,
        canonicalState: "succeeded",
        integrityState: "clear",
        observationSource: "retrieve",
        observedConnector: "stripe_test",
        attempts: [
          {
            ordinal: 1,
            state: "succeeded",
            charged: true,
            hardDecline: false,
            connector: "stripe_test",
          },
        ],
        chargedAttemptCount: 1,
        evidenceGeneration: 2,
      },
      grant: null,
    })
    for (const result of [checking, fulfilled]) {
      const response = await handleOnsaleCheckoutReconcilePostV1(
        postRequest(
          "/api/onsale/checkout/reconcile",
          { commandId: COMMAND_REF, trigger: "refresh" },
          RECONCILE_COOKIES,
        ),
        dependencies({ reconcile: vi.fn(async () => result) }),
      )
      const setCookie = response.headers.get("set-cookie") ?? ""
      expect(setCookie).not.toContain("onsale_current_order_v1=")
      expect(setCookie).not.toContain("Max-Age=0")
      expectPrivateHeaders(response)
    }
  })

  it("returns only fixed errors and never forwards coordinator/provider/database prose", async () => {
    const runtime = dependencies({
      prepare: vi.fn(async () => {
        throw new CheckoutRouteBoundaryErrorV1("checkout_configuration_blocked")
      }),
      reconcile: vi.fn(async () => {
        throw new Error(
          "postgres://private:password@example.test pay_private secret_private",
        )
      }),
    })
    const setup = await handleOnsaleCheckoutPreparePostV1(
      postRequest("/api/onsale/checkout/prepare", {
        commandId: COMMAND_REF,
        holdRef: HOLD_REF,
      }),
      runtime,
    )
    const unavailable = await handleOnsaleCheckoutReconcilePostV1(
      postRequest(
        "/api/onsale/checkout/reconcile",
        {
          commandId: COMMAND_REF,
          trigger: "resume",
        },
        RECONCILE_COOKIES,
      ),
      runtime,
    )
    const setupText = JSON.stringify(await setup.json())
    const unavailableText = JSON.stringify(await unavailable.json())

    expect(setup.status).toBe(503)
    expect(setupText).toContain("CHECKOUT_SETUP_REQUIRED")
    expect(unavailable.status).toBe(503)
    expect(unavailableText).toContain("CHECKOUT_TEMPORARILY_UNAVAILABLE")
    for (const text of [setupText, unavailableText]) {
      expect(text).not.toMatch(/postgres|password|pay_private|secret_private/iu)
    }
  })
})
