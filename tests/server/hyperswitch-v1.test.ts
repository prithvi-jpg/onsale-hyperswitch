import { describe, expect, it, vi } from "vitest"

import {
  normalizeHyperswitchPaymentObservationV1,
  type ImmutableOrderPaymentTermsV1,
} from "../../src/domain/onsale-payment-v1"
import {
  HYPERSWITCH_V1_MAX_SESSION_EXPIRY_SECONDS,
  HYPERSWITCH_V1_SANDBOX_ORIGIN,
  HyperswitchV1Adapter,
  HyperswitchV1AdapterError,
  bindHyperswitchV1Evidence,
  isOfficialIframeReturnEligibleV1,
  type HyperswitchV1AdapterDependencies,
  type HyperswitchV1AdapterPort,
  type HyperswitchV1CreateInput,
  type HyperswitchV1EvidenceReceipt,
} from "../../src/server/hyperswitch-v1"

const FIXED_NOW = new Date("2026-08-08T20:00:00.000Z")
const PAYMENT_ID = "pay_0123456789abcdef0123456789"
const API_KEY_CANARY = "api_secret_canary_123456"
const PUBLISHABLE_KEY_CANARY = "pk_snd_publishablecanary123"
const CLIENT_SECRET_CANARY = "client_secret_canary_123456789"
const RAW_BODY_CANARY = "raw_provider_body_must_not_escape"
const PROFILE_ID = "pro_test_profile"

const ENV = {
  HYPERSWITCH_API_KEY: API_KEY_CANARY,
  HYPERSWITCH_PROFILE_ID: PROFILE_ID,
  HYPERSWITCH_PUBLISHABLE_KEY_V1: PUBLISHABLE_KEY_CANARY,
} as const

const TERMS: ImmutableOrderPaymentTermsV1 = {
  amountMinor: 82_000,
  currency: "USD",
  itemCount: 4,
}

const CREATE_INPUT: HyperswitchV1CreateInput = {
  merchantPaymentId: PAYMENT_ID,
  terms: TERMS,
  returnUrl: "https://onsale.example/checkout/return?order=ord_01",
  sessionExpirySeconds: 900,
  description: "PHANTOM CIRCUIT tickets",
  metadata: {
    event_id: "evt_phantom_circuit_01",
    prototype: "onsale_buyer_v1",
  },
  items: [
    { name: "PHANTOM CIRCUIT · A1", quantity: 1, amountMinor: 20_500 },
    { name: "PHANTOM CIRCUIT · A2", quantity: 1, amountMinor: 20_500 },
    { name: "PHANTOM CIRCUIT · A3", quantity: 1, amountMinor: 20_500 },
    { name: "PHANTOM CIRCUIT · A4", quantity: 1, amountMinor: 20_500 },
  ],
}

type RecordedFetchCall = {
  readonly input: RequestInfo | URL
  readonly init: RequestInit | undefined
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function createResponse(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: PAYMENT_ID,
    status: "requires_payment_method",
    amount: TERMS.amountMinor,
    currency: TERMS.currency,
    profile_id: PROFILE_ID,
    client_secret: CLIENT_SECRET_CANARY,
    raw_debug_value: RAW_BODY_CANARY,
    ...overrides,
  }
}

function retrieveResponse(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: PAYMENT_ID,
    status: "succeeded",
    amount: TERMS.amountMinor,
    currency: TERMS.currency,
    profile_id: PROFILE_ID,
    payment_method: "card",
    payment_method_type: "credit",
    connector: "stripe_test",
    attempts: [
      {
        attempt_id: "attempt_raw_reference_canary",
        status: "charged",
        connector: "stripe_test",
        amount: TERMS.amountMinor,
        currency: TERMS.currency,
      },
    ],
    raw_debug_value: RAW_BODY_CANARY,
    ...overrides,
  }
}

function recordingFetch(
  implementation: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ) => Promise<Response>,
) {
  const calls: RecordedFetchCall[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return implementation(input, init)
  }) as unknown as typeof globalThis.fetch

  return { calls, fetch }
}

function adapterWith(
  fetch: typeof globalThis.fetch,
  overrides: Partial<HyperswitchV1AdapterDependencies> = {},
) {
  return new HyperswitchV1Adapter({
    env: ENV,
    fetch,
    now: () => FIXED_NOW,
    allowedReturnOrigins: ["https://onsale.example"],
    ...overrides,
  })
}

function safeSerializedError(error: unknown) {
  if (!(error instanceof Error)) return JSON.stringify(error)
  return JSON.stringify({
    name: error.name,
    message: error.message,
    ...("code" in error ? { code: error.code } : {}),
    ...("httpStatus" in error ? { httpStatus: error.httpStatus } : {}),
  })
}

describe("pinned server-only Hyperswitch V1 adapter", () => {
  it("requests official SDK iframe handling only for the exact named local return endpoint", async () => {
    for (const eligible of [
      "http://onsale-v01.localhost:4310/api/onsale/return",
      "https://onsale-v01.localhost/api/onsale/return",
      "https://onsale-review.localhost/api/onsale/return",
    ]) {
      expect(isOfficialIframeReturnEligibleV1(eligible)).toBe(true)
    }
    for (const ineligible of [
      "http://onsale-v01.localhost/api/onsale/return",
      "http://onsale-v01.localhost:4311/api/onsale/return",
      "https://preview.onsale-v01.localhost/api/onsale/return",
      "https://onsale-v01.localhost.example/api/onsale/return",
      "https://onsale-v01.localhost/not-the-return-route",
      "https://onsale-v01.localhost/api/onsale/return?token=private",
      "https://onsale.example/api/onsale/return",
    ]) {
      expect(isOfficialIframeReturnEligibleV1(ineligible)).toBe(false)
    }

    const recorded = recordingFetch(async () => jsonResponse(createResponse()))
    const adapter = adapterWith(recorded.fetch, {
      allowedReturnOrigins: ["https://onsale-v01.localhost"],
    })
    await adapter.createPayment({
      ...CREATE_INPUT,
      returnUrl: "https://onsale-v01.localhost/api/onsale/return",
    })

    expect(JSON.parse(String(recorded.calls[0]?.init?.body))).toMatchObject({
      return_url: "https://onsale-v01.localhost/api/onsale/return",
      is_iframe_redirection_enabled: true,
    })
  })

  it("fails closed unless the three exact V1 environment names are valid", () => {
    const unused = recordingFetch(async () => jsonResponse({}))
    const genericOnly = new HyperswitchV1Adapter({
      env: {
        HYPERSWITCH_API_KEY: API_KEY_CANARY,
        HYPERSWITCH_PROFILE_ID: PROFILE_ID,
        HYPERSWITCH_PUBLISHABLE_KEY: PUBLISHABLE_KEY_CANARY,
        HYPERSWITCH_PUBLISHABLE_KEY_V2: PUBLISHABLE_KEY_CANARY,
      },
      fetch: unused.fetch,
      now: () => FIXED_NOW,
      allowedReturnOrigins: ["https://onsale.example"],
    })

    expect(genericOnly.configuration()).toEqual({
      kind: "blocked",
      code: "hyperswitch_v1_configuration_missing",
      message:
        "Hosted V1 checkout requires a server key, profile ID, and explicitly V1-scoped sandbox publishable key.",
      missing: ["HYPERSWITCH_PUBLISHABLE_KEY_V1"],
      invalid: [],
    })
    expect(unused.calls).toHaveLength(0)

    for (const [name, value] of [
      ["HYPERSWITCH_API_KEY", "invalid-api-canary!"],
      ["HYPERSWITCH_PROFILE_ID", "invalid-profile-canary!"],
      ["HYPERSWITCH_PUBLISHABLE_KEY_V1", "pk_live_invalid_scope_canary"],
    ] as const) {
      const configured = adapterWith(unused.fetch, {
        env: { ...ENV, [name]: value },
      }).configuration()
      expect(configured).toMatchObject({
        kind: "blocked",
        code: "hyperswitch_v1_configuration_invalid",
        missing: [],
        invalid: [name],
      })
      const serialized = JSON.stringify(configured)
      expect(serialized).not.toContain(value)
      expect(serialized).not.toContain(API_KEY_CANARY)
      expect(serialized).not.toContain(PUBLISHABLE_KEY_CANARY)
    }
  })

  it("sends the exact immutable V1 create request once and returns only an ephemeral grant plus normalized observation", async () => {
    const recorded = recordingFetch(async () => jsonResponse(createResponse()))
    const adapter = adapterWith(recorded.fetch)

    expect(adapter.configuration()).toEqual({
      kind: "ready",
      provider: "hyperswitch",
      apiVersion: "v1",
      environment: "sandbox",
      publishableKeyScope: "explicit_v1_env_only",
    })

    const result = await adapter.createPayment(CREATE_INPUT)

    expect(recorded.calls).toHaveLength(1)
    const call = recorded.calls[0]
    expect(String(call.input)).toBe(`${HYPERSWITCH_V1_SANDBOX_ORIGIN}/payments`)
    expect(call.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    })
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    expect(
      Object.fromEntries(new Headers(call.init?.headers).entries()),
    ).toEqual({
      accept: "application/json",
      "api-key": API_KEY_CANARY,
      "content-type": "application/json",
    })
    expect(JSON.parse(String(call.init?.body))).toEqual({
      payment_id: PAYMENT_ID,
      amount: TERMS.amountMinor,
      currency: TERMS.currency,
      profile_id: PROFILE_ID,
      confirm: false,
      capture_method: "automatic",
      session_expiry: CREATE_INPUT.sessionExpirySeconds,
      return_url: CREATE_INPUT.returnUrl,
      description: CREATE_INPUT.description,
      metadata: CREATE_INPUT.metadata,
      order_details: CREATE_INPUT.items.map((item) => ({
        product_name: item.name,
        quantity: item.quantity,
        amount: item.amountMinor,
      })),
    })

    expect(result).toMatchObject({
      kind: "ready",
      observedAt: FIXED_NOW.toISOString(),
      checkoutGrant: {
        clientSecret: CLIENT_SECRET_CANARY,
        publishableKey: PUBLISHABLE_KEY_CANARY,
      },
      observation: {
        schema: "onsale.payment-observation.v1",
        source: "create",
        canonicalState: "requires_method",
        amountMinor: TERMS.amountMinor,
        currency: TERMS.currency,
      },
    })
    expect(Object.keys(result).sort()).toEqual([
      "checkoutGrant",
      "kind",
      "observation",
      "observedAt",
    ])
    const normalized = JSON.stringify(result.observation)
    expect(normalized).not.toContain(PAYMENT_ID)
    expect(normalized).not.toContain(CLIENT_SECRET_CANARY)
    expect(normalized).not.toContain(PUBLISHABLE_KEY_CANARY)
    expect(normalized).not.toContain(API_KEY_CANARY)
    expect(normalized).not.toContain(RAW_BODY_CANARY)
  })

  it("snapshots create identity and money before provider I/O", async () => {
    const mutatedPaymentId = "pay_aaaaaaaaaaaaaaaaaaaaaaaaaa"
    const mutatedAmount = TERMS.amountMinor + 1

    let resolveOriginal!: (response: Response) => void
    const originalResponse = new Promise<Response>((resolve) => {
      resolveOriginal = resolve
    })
    const originalFetch = recordingFetch(async () => originalResponse)
    const originalInput = {
      ...CREATE_INPUT,
      terms: { ...TERMS },
      items: CREATE_INPUT.items.map((item) => ({ ...item })),
    }
    const originalPending = adapterWith(originalFetch.fetch).createPayment(
      originalInput,
    )

    expect(originalFetch.calls).toHaveLength(1)
    originalInput.merchantPaymentId = mutatedPaymentId
    originalInput.terms.amountMinor = mutatedAmount
    resolveOriginal(jsonResponse(createResponse()))

    await expect(originalPending).resolves.toMatchObject({ kind: "ready" })
    expect(JSON.parse(String(originalFetch.calls[0]?.init?.body))).toMatchObject({
      payment_id: PAYMENT_ID,
      amount: TERMS.amountMinor,
    })

    let resolveMutated!: (response: Response) => void
    const mutatedResponse = new Promise<Response>((resolve) => {
      resolveMutated = resolve
    })
    const mutatedFetch = recordingFetch(async () => mutatedResponse)
    const secondInput = {
      ...CREATE_INPUT,
      terms: { ...TERMS },
      items: CREATE_INPUT.items.map((item) => ({ ...item })),
    }
    const mutatedPending = adapterWith(mutatedFetch.fetch).createPayment(
      secondInput,
    )

    expect(mutatedFetch.calls).toHaveLength(1)
    secondInput.merchantPaymentId = mutatedPaymentId
    secondInput.terms.amountMinor = mutatedAmount
    resolveMutated(
      jsonResponse(
        createResponse({
          payment_id: mutatedPaymentId,
          amount: mutatedAmount,
        }),
      ),
    )

    await expect(mutatedPending).rejects.toMatchObject({
      code: "invalid_response",
    })
    expect(mutatedFetch.calls).toHaveLength(1)
  })

  it.each([
    ["requires_customer_action", "action_required"],
    ["processing", "processing"],
    ["succeeded", "succeeded"],
    ["failed", "exhausted"],
    ["invented_future_state", "uncertain"],
  ] as const)(
    "requires reconciliation instead of mounting checkout for create status %s",
    async (providerStatus, canonicalState) => {
      const recorded = recordingFetch(async () =>
        jsonResponse(createResponse({ status: providerStatus })),
      )

      const result = await adapterWith(recorded.fetch).createPayment(
        CREATE_INPUT,
      )

      expect(recorded.calls).toHaveLength(1)
      expect(result).toMatchObject({
        kind: "reconcile_required",
        observedAt: FIXED_NOW.toISOString(),
        observation: {
          providerStatus:
            providerStatus === "invented_future_state"
              ? "unrecognized"
              : providerStatus,
          canonicalState,
        },
      })
      expect(Object.keys(result).sort()).toEqual([
        "kind",
        "observation",
        "observedAt",
      ])
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET_CANARY)
      expect(JSON.stringify(result)).not.toContain(PUBLISHABLE_KEY_CANARY)
    },
  )

  it.each([
    ["merchant payment ID", { merchantPaymentId: "pay_too_short" }],
    ["return origin", { returnUrl: "https://attacker.example/collect" }],
    ["return credentials", { returnUrl: "https://u:p@onsale.example/return" }],
    ["return fragment", { returnUrl: "https://onsale.example/return#secret" }],
    ["metadata secret", { metadata: { api_key: "must-not-pass" } }],
    ["zero session expiry", { sessionExpirySeconds: 0 }],
    ["fractional session expiry", { sessionExpirySeconds: 1.5 }],
    [
      "session expiry above provider bound",
      {
        sessionExpirySeconds: HYPERSWITCH_V1_MAX_SESSION_EXPIRY_SECONDS + 1,
      },
    ],
    ["item count", { items: CREATE_INPUT.items.slice(0, 3) }],
    [
      "item sum",
      {
        items: CREATE_INPUT.items.map((item, index) =>
          index === 0 ? { ...item, amountMinor: item.amountMinor + 1 } : item,
        ),
      },
    ],
  ])("rejects invalid %s before fetch", async (_label, override) => {
    const unused = recordingFetch(async () => jsonResponse(createResponse()))
    const adapter = adapterWith(unused.fetch)

    await expect(
      adapter.createPayment({ ...CREATE_INPUT, ...override }),
    ).rejects.toBeInstanceOf(HyperswitchV1AdapterError)
    expect(unused.calls).toHaveLength(0)
  })

  it.each([408, 425, 429, 500, 503])(
    "returns typed uncertainty after one create request on HTTP %i",
    async (status) => {
      const recorded = recordingFetch(async () =>
        jsonResponse({ error: RAW_BODY_CANARY }, status),
      )
      const result = await adapterWith(recorded.fetch).createPayment(
        CREATE_INPUT,
      )

      expect(recorded.calls).toHaveLength(1)
      expect(result).toEqual({
        kind: "uncertain",
        observedAt: FIXED_NOW.toISOString(),
        error: {
          code: "hyperswitch_outcome_uncertain",
          message:
            "Hyperswitch did not return a definitive outcome. Retrieve the same payment before any retry.",
          httpStatus: status,
        },
      })
      expect(JSON.stringify(result)).not.toContain(RAW_BODY_CANARY)
    },
  )

  it.each([
    new TypeError("network failed with " + API_KEY_CANARY),
    new DOMException("aborted with " + CLIENT_SECRET_CANARY, "AbortError"),
  ])("returns typed uncertainty after one rejected fetch", async (failure) => {
    const recorded = recordingFetch(async () => {
      throw failure
    })
    const result = await adapterWith(recorded.fetch).createPayment(CREATE_INPUT)

    expect(recorded.calls).toHaveLength(1)
    expect(result).toMatchObject({
      kind: "uncertain",
      error: { code: "hyperswitch_outcome_uncertain", httpStatus: null },
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(API_KEY_CANARY)
    expect(serialized).not.toContain(CLIENT_SECRET_CANARY)
  })

  it("throws a fixed secret-free rejection after one definitive 4xx response", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse(
        {
          error: RAW_BODY_CANARY,
          api_key: API_KEY_CANARY,
          client_secret: CLIENT_SECRET_CANARY,
        },
        400,
      ),
    )

    let caught: unknown
    try {
      await adapterWith(recorded.fetch).createPayment(CREATE_INPUT)
    } catch (error) {
      caught = error
    }

    expect(recorded.calls).toHaveLength(1)
    expect(caught).toMatchObject({
      name: "HyperswitchV1AdapterError",
      code: "request_rejected",
      httpStatus: 400,
      message:
        "Hyperswitch rejected the request. No automatic retry was performed.",
    })
    const serialized = safeSerializedError(caught)
    expect(serialized).not.toContain(RAW_BODY_CANARY)
    expect(serialized).not.toContain(API_KEY_CANARY)
    expect(serialized).not.toContain(CLIENT_SECRET_CANARY)
  })

  it.each([
    ["non-object JSON", [], 200],
    [
      "mismatched payment",
      createResponse({ payment_id: "pay_ffffffffffffffffffffffffff" }),
      200,
    ],
    [
      "mismatched amount",
      createResponse({ amount: TERMS.amountMinor + 1 }),
      200,
    ],
    ["mismatched currency", createResponse({ currency: "EUR" }), 200],
    [
      "mismatched profile",
      createResponse({ profile_id: "pro_other_profile" }),
      200,
    ],
    ["missing status", createResponse({ status: null }), 200],
    ["missing client secret", createResponse({ client_secret: null }), 200],
    [
      "short client secret",
      createResponse({ client_secret: "too-short" }),
      200,
    ],
  ])(
    "rejects a %s create response without exposing its raw payload",
    async (_label, payload, status) => {
      const recorded = recordingFetch(async () => jsonResponse(payload, status))
      let caught: unknown
      try {
        await adapterWith(recorded.fetch).createPayment(CREATE_INPUT)
      } catch (error) {
        caught = error
      }

      expect(recorded.calls).toHaveLength(1)
      expect(caught).toMatchObject({
        name: "HyperswitchV1AdapterError",
        code: "invalid_response",
      })
      const serialized = safeSerializedError(caught)
      expect(serialized).not.toContain(RAW_BODY_CANARY)
      expect(serialized).not.toContain(API_KEY_CANARY)
      expect(serialized).not.toContain(CLIENT_SECRET_CANARY)
    },
  )

  it("keeps a structurally valid future create status fail-safe behind reconciliation", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse(createResponse({ status: "invented_future_state" })),
    )

    const result = await adapterWith(recorded.fetch).createPayment(CREATE_INPUT)

    expect(recorded.calls).toHaveLength(1)
    expect(result).toMatchObject({
      kind: "reconcile_required",
      observation: {
        providerStatus: "unrecognized",
        canonicalState: "uncertain",
      },
    })
  })

  it("rejects malformed successful JSON without retrying or retaining response text", async () => {
    const recorded = recordingFetch(
      async () =>
        new Response(`{\"secret\":\"${RAW_BODY_CANARY}\"`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )

    let caught: unknown
    try {
      await adapterWith(recorded.fetch).createPayment(CREATE_INPUT)
    } catch (error) {
      caught = error
    }

    expect(recorded.calls).toHaveLength(1)
    expect(caught).toMatchObject({ code: "invalid_response" })
    expect(safeSerializedError(caught)).not.toContain(RAW_BODY_CANARY)
  })

  it("retrieves the same payment with exact force-sync query and returns no checkout secret", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse(retrieveResponse()),
    )
    const result = await adapterWith(recorded.fetch).retrievePayment({
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    })

    expect(recorded.calls).toHaveLength(1)
    const call = recorded.calls[0]
    expect(String(call.input)).toBe(
      `${HYPERSWITCH_V1_SANDBOX_ORIGIN}/payments/${PAYMENT_ID}?force_sync=true&expand_attempts=true`,
    )
    expect(call.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    })
    expect(call.init?.body).toBeUndefined()
    expect(
      Object.fromEntries(new Headers(call.init?.headers).entries()),
    ).toEqual({
      accept: "application/json",
      "api-key": API_KEY_CANARY,
    })
    expect(result).toMatchObject({
      kind: "found",
      observedAt: FIXED_NOW.toISOString(),
      observation: {
        source: "retrieve",
        canonicalState: "succeeded",
        amountMinor: TERMS.amountMinor,
        currency: TERMS.currency,
        successfulChargedAttemptCount: 1,
      },
    })
    expect(Object.keys(result).sort()).toEqual([
      "kind",
      "observation",
      "observedAt",
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(PAYMENT_ID)
    expect(serialized).not.toContain(CLIENT_SECRET_CANARY)
    expect(serialized).not.toContain(PUBLISHABLE_KEY_CANARY)
    expect(serialized).not.toContain(API_KEY_CANARY)
    expect(serialized).not.toContain(RAW_BODY_CANARY)
    expect(serialized).not.toContain("attempt_raw_reference_canary")
  })

  it("returns an ephemeral remount grant only for requires_method with a usable retrieved client secret", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse(
        retrieveResponse({
          status: "requires_payment_method",
          attempts: [],
          client_secret: CLIENT_SECRET_CANARY,
        }),
      ),
    )
    const result = await adapterWith(recorded.fetch).retrievePayment({
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    })

    expect(recorded.calls).toHaveLength(1)
    expect(result).toMatchObject({
      kind: "found",
      checkoutGrant: {
        clientSecret: CLIENT_SECRET_CANARY,
        publishableKey: PUBLISHABLE_KEY_CANARY,
      },
      observation: { canonicalState: "requires_method" },
    })
  })

  it("does not invent a remount grant when a requires_method retrieve omits the client secret", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse(
        retrieveResponse({
          status: "requires_payment_method",
          attempts: [],
          client_secret: undefined,
        }),
      ),
    )
    const result = await adapterWith(recorded.fetch).retrievePayment({
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    })

    expect(result).toMatchObject({
      kind: "found",
      observation: { canonicalState: "requires_method" },
    })
    expect(Object.keys(result).sort()).toEqual([
      "kind",
      "observation",
      "observedAt",
    ])
  })

  it.each([
    ["requires_customer_action", "action_required"],
    ["processing", "processing"],
    ["invented_future_state", "uncertain"],
    ["failed", "exhausted"],
    ["succeeded", "succeeded"],
  ] as const)(
    "suppresses a retrieved client secret for %s",
    async (providerStatus, canonicalState) => {
      const recorded = recordingFetch(async () =>
        jsonResponse(
          retrieveResponse({
            status: providerStatus,
            client_secret: CLIENT_SECRET_CANARY,
            attempts:
              providerStatus === "succeeded" ? retrieveResponse().attempts : [],
          }),
        ),
      )
      const result = await adapterWith(recorded.fetch).retrievePayment({
        merchantPaymentId: PAYMENT_ID,
        terms: TERMS,
      })

      expect(result).toMatchObject({
        kind: "found",
        observation: { canonicalState },
      })
      expect(Object.keys(result).sort()).toEqual([
        "kind",
        "observation",
        "observedAt",
      ])
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET_CANARY)
      expect(JSON.stringify(result)).not.toContain(PUBLISHABLE_KEY_CANARY)
    },
  )

  it("returns typed not_found for an exact retrieve 404", async () => {
    const recorded = recordingFetch(async () =>
      jsonResponse({ error: RAW_BODY_CANARY }, 404),
    )
    const result = await adapterWith(recorded.fetch).retrievePayment({
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    })

    expect(recorded.calls).toHaveLength(1)
    expect(result).toEqual({
      kind: "not_found",
      observedAt: FIXED_NOW.toISOString(),
    })
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_CANARY)
  })

  it.each([408, 425, 429, 500, 503])(
    "returns typed uncertainty after one retrieve request on HTTP %i",
    async (status) => {
      const recorded = recordingFetch(async () =>
        jsonResponse({ error: RAW_BODY_CANARY }, status),
      )
      const result = await adapterWith(recorded.fetch).retrievePayment({
        merchantPaymentId: PAYMENT_ID,
        terms: TERMS,
      })

      expect(recorded.calls).toHaveLength(1)
      expect(result).toMatchObject({
        kind: "uncertain",
        observedAt: FIXED_NOW.toISOString(),
        error: {
          code: "hyperswitch_outcome_uncertain",
          httpStatus: status,
        },
      })
      expect(JSON.stringify(result)).not.toContain(RAW_BODY_CANARY)
    },
  )

  it("returns typed uncertainty after one rejected retrieve fetch", async () => {
    const recorded = recordingFetch(async () => {
      throw new Error(`network ${API_KEY_CANARY}`)
    })
    const result = await adapterWith(recorded.fetch).retrievePayment({
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    })

    expect(recorded.calls).toHaveLength(1)
    expect(result).toMatchObject({
      kind: "uncertain",
      error: { code: "hyperswitch_outcome_uncertain", httpStatus: null },
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY_CANARY)
  })

  it.each([
    [
      "payment",
      retrieveResponse({ payment_id: "pay_ffffffffffffffffffffffffff" }),
    ],
    ["amount", retrieveResponse({ amount: TERMS.amountMinor + 1 })],
    ["currency", retrieveResponse({ currency: "EUR" })],
    ["profile", retrieveResponse({ profile_id: "pro_other_profile" })],
    ["status", retrieveResponse({ status: null })],
  ])(
    "rejects a retrieve response with mismatched %s",
    async (_label, payload) => {
      const recorded = recordingFetch(async () => jsonResponse(payload))

      await expect(
        adapterWith(recorded.fetch).retrievePayment({
          merchantPaymentId: PAYMENT_ID,
          terms: TERMS,
        }),
      ).rejects.toMatchObject({
        name: "HyperswitchV1AdapterError",
        code: "invalid_response",
      })
      expect(recorded.calls).toHaveLength(1)
    },
  )

  it("binds method-owned evidence to one verifier without exporting a minting capability", async () => {
    const mutableObservation = normalizeHyperswitchPaymentObservationV1(
      retrieveResponse(),
      "retrieve",
    )
    const fakeAdapter: HyperswitchV1AdapterPort = {
      configuration: () => ({
        kind: "ready",
        provider: "hyperswitch",
        apiVersion: "v1",
        environment: "sandbox",
        publishableKeyScope: "explicit_v1_env_only",
      }),
      createPayment: async () => ({
        kind: "reconcile_required",
        observedAt: FIXED_NOW.toISOString(),
        // A caller-supplied source label cannot change the method-owned kind.
        observation: mutableObservation,
      }),
      retrievePayment: async () => ({
        kind: "not_found",
        observedAt: FIXED_NOW.toISOString(),
      }),
    }
    const first = bindHyperswitchV1Evidence(fakeAdapter)
    const second = bindHyperswitchV1Evidence(fakeAdapter)

    const created = await first.adapter.createPayment(CREATE_INPUT)
    expect(created.kind).toBe("reconcile_required")
    if (created.kind !== "reconcile_required") {
      throw new Error("Expected attested create evidence.")
    }
    expect(created.evidence).toEqual({ kind: "create_observation" })
    const verifiedCreate = first.verifier.require(created.evidence)
    expect(verifiedCreate).toMatchObject({
      kind: "create_observation",
      observation: { source: "retrieve", providerStatus: "succeeded" },
    })
    expect(Object.isFrozen(verifiedCreate)).toBe(true)
    if (verifiedCreate.kind !== "retrieve_not_found") {
      expect(Object.isFrozen(verifiedCreate.observation)).toBe(true)
      expect(Object.isFrozen(verifiedCreate.observation.attempts)).toBe(true)
    }

    ;(mutableObservation as { providerStatus: string }).providerStatus =
      "failed"
    expect(first.verifier.require(created.evidence)).toMatchObject({
      kind: "create_observation",
      observation: { providerStatus: "succeeded" },
    })
    expect(() => second.verifier.require(created.evidence)).toThrow(
      "Unrecognized Hyperswitch V1 evidence receipt.",
    )
    expect(() =>
      first.verifier.require({
        kind: "create_observation",
      } as HyperswitchV1EvidenceReceipt),
    ).toThrow("Unrecognized Hyperswitch V1 evidence receipt.")

    const retrieveInput = {
      merchantPaymentId: PAYMENT_ID,
      terms: TERMS,
    }
    const notFound = await first.adapter.retrievePayment(retrieveInput)
    expect(notFound.kind).toBe("not_found")
    if (notFound.kind !== "not_found") {
      throw new Error("Expected attested not-found evidence.")
    }
    const verifiedNotFound = first.verifier.require(notFound.evidence)
    expect(verifiedNotFound).toMatchObject({ kind: "retrieve_not_found" })
    expect(JSON.stringify(verifiedNotFound)).not.toContain(PAYMENT_ID)
    expect(Object.keys(first)).toEqual(["adapter", "verifier"])
    expect(Object.keys(first.verifier)).toEqual(["require"])
  })
})
