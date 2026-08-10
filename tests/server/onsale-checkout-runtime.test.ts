import type { Pool } from "@neondatabase/serverless"
import { describe, expect, it, vi } from "vitest"

import {
  createOnsaleCheckoutRouteDependenciesV1,
  getOnsaleCheckoutReturnRouteConfigurationV1,
  resolveOnsaleCheckoutHttpConfigurationV1,
} from "../../src/server/onsale-checkout-runtime"
import { assertConfiguredOriginV1 } from "../../src/server/onsale-http-guards"

const LOOPBACK_ORIGIN = "http://127.0.0.1:3000"
const NAMED_HTTP_ORIGIN = "http://onsale-v01.localhost:4310"
const NAMED_HTTPS_ORIGIN = "https://onsale-v01.localhost"
const PUBLIC_ORIGIN = "https://onsale.example"

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    DATABASE_URL: "postgresql://sandbox.invalid/onsale",
    ONSALE_ALLOWED_ORIGINS: LOOPBACK_ORIGIN,
    ONSALE_COOKIE_SECURE: "false",
    ...overrides,
  }
}

describe("C3 checkout production runtime configuration", () => {
  it("uses the exact named preview origin when local configuration is omitted", () => {
    const result = resolveOnsaleCheckoutHttpConfigurationV1({})

    expect(result).toEqual({
      configuredOrigins: new Set([NAMED_HTTP_ORIGIN]),
      canonicalOrigin: NAMED_HTTP_ORIGIN,
      cleanReturnLocation: `${NAMED_HTTP_ORIGIN}/checkout`,
      providerReturnUrl: `${NAMED_HTTP_ORIGIN}/api/onsale/return`,
      secureCookie: false,
    })
  })

  it("derives the provider callback and clean browser location from one exact server origin", () => {
    const result = resolveOnsaleCheckoutHttpConfigurationV1(environment())

    expect(result).toEqual({
      configuredOrigins: new Set([LOOPBACK_ORIGIN]),
      canonicalOrigin: LOOPBACK_ORIGIN,
      cleanReturnLocation: `${LOOPBACK_ORIGIN}/checkout`,
      providerReturnUrl: `${LOOPBACK_ORIGIN}/api/onsale/return`,
      secureCookie: false,
    })
  })

  it.each([
    [NAMED_HTTP_ORIGIN, false],
    [NAMED_HTTPS_ORIGIN, true],
  ] as const)(
    "accepts only the exact named local origin %s with its matching cookie mode",
    (canonicalOrigin, secureCookie) => {
      expect(
        resolveOnsaleCheckoutHttpConfigurationV1({
          ONSALE_ALLOWED_ORIGINS: canonicalOrigin,
          ONSALE_CANONICAL_ORIGIN: canonicalOrigin,
        }),
      ).toMatchObject({
        configuredOrigins: new Set([canonicalOrigin]),
        canonicalOrigin,
        cleanReturnLocation: `${canonicalOrigin}/checkout`,
        secureCookie,
      })
    },
  )

  it.each([
    "http://onsale-v01.localhost",
    "http://onsale-v01.localhost:4311",
    "http://preview.onsale-v01.localhost:4310",
  ])("rejects the non-authoritative named HTTP lookalike %s", (origin) => {
    expect(() =>
      resolveOnsaleCheckoutHttpConfigurationV1({
        ONSALE_ALLOWED_ORIGINS: origin,
        ONSALE_CANONICAL_ORIGIN: origin,
      }),
    ).toThrow(/loopback/iu)
  })

  it("requires an explicit exact allowlist member when multiple origins are configured", () => {
    const multiOrigin = environment({
      ONSALE_ALLOWED_ORIGINS: `${LOOPBACK_ORIGIN},${PUBLIC_ORIGIN}`,
      ONSALE_COOKIE_SECURE: "true",
    })

    expect(() => resolveOnsaleCheckoutHttpConfigurationV1(multiOrigin)).toThrow(
      /canonical_origin/iu,
    )
    expect(() =>
      resolveOnsaleCheckoutHttpConfigurationV1({
        ...multiOrigin,
        ONSALE_CANONICAL_ORIGIN: "https://outside.example",
      }),
    ).toThrow(/exact member/iu)
    expect(() =>
      resolveOnsaleCheckoutHttpConfigurationV1({
        ...multiOrigin,
        ONSALE_CANONICAL_ORIGIN: `${PUBLIC_ORIGIN}/return?status=ok`,
      }),
    ).toThrow()

    const canonical = resolveOnsaleCheckoutHttpConfigurationV1({
      ...multiOrigin,
      ONSALE_CANONICAL_ORIGIN: PUBLIC_ORIGIN,
    })
    expect(canonical.providerReturnUrl).toBe(
      `${PUBLIC_ORIGIN}/api/onsale/return`,
    )
    expect(canonical.configuredOrigins).toEqual(new Set([PUBLIC_ORIGIN]))
    expect(() =>
      assertConfiguredOriginV1(LOOPBACK_ORIGIN, canonical.configuredOrigins),
    ).toThrow()
  })

  it("rejects non-loopback HTTP origins because secure cookies cannot round-trip", () => {
    expect(() =>
      resolveOnsaleCheckoutHttpConfigurationV1(
        environment({
          ONSALE_ALLOWED_ORIGINS: "http://192.0.2.10:3000",
          ONSALE_COOKIE_SECURE: "true",
        }),
      ),
    ).toThrow(/loopback/iu)
  })

  it("resolves the GET return redirect without allocating a pool, repository, or adapter", () => {
    const result = getOnsaleCheckoutReturnRouteConfigurationV1({
      ONSALE_ALLOWED_ORIGINS: LOOPBACK_ORIGIN,
      ONSALE_COOKIE_SECURE: "false",
    })

    expect(result).toEqual({
      configuredOrigins: new Set([LOOPBACK_ORIGIN]),
      cleanReturnLocation: `${LOOPBACK_ORIGIN}/checkout`,
    })
    expect(result).not.toHaveProperty("prepare")
    expect(result).not.toHaveProperty("reconcile")
  })

  it("allocates one shared lazy pool and performs no provider or database I/O during construction", () => {
    const connect = vi.fn()
    const end = vi.fn()
    const pool = { connect, end } as unknown as Pool
    const createPool = vi.fn(() => pool)
    const fetch = vi.fn<typeof globalThis.fetch>()

    const runtime = createOnsaleCheckoutRouteDependenciesV1(environment(), {
      fetch,
      now: () => new Date("2026-08-08T20:00:00.000Z"),
      createPool,
    })

    expect(createPool).toHaveBeenCalledOnce()
    expect(createPool).toHaveBeenCalledWith(
      "postgresql://sandbox.invalid/onsale",
    )
    expect(connect).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(runtime.cleanReturnLocation).toBe(`${LOOPBACK_ORIGIN}/checkout`)
  })
})
