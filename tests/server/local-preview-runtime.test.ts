import { describe, expect, it } from "vitest"

import {
  buildLocalPreviewEnvironmentV1,
  localPreviewNextArgumentsV1,
} from "../../scripts/local-preview-runtime"

const PRIVATE_SOURCE = [
  "DATABASE_URL=postgresql://sandbox.invalid/onsale",
  "HYPERSWITCH_API_KEY=test_api_key_123456789",
  "HYPERSWITCH_PROFILE_ID=profile_sandbox_123",
  "HYPERSWITCH_PUBLISHABLE_KEY_V1=pk_snd_publishable_123456",
].join("\n")

describe("v0.1 exact local runtime environment", () => {
  it.each([
    ["http://onsale-v01.localhost:4310", "false"],
    ["https://onsale-v01.localhost", "true"],
  ] as const)(
    "atomically derives origin and cookie policy from Portless %s",
    (origin, secure) => {
      expect(
        buildLocalPreviewEnvironmentV1(PRIVATE_SOURCE, {
          PORTLESS_URL: origin,
          ONSALE_PORTLESS_NAME: "onsale-v01",
          ONSALE_ALLOWED_ORIGINS: "https://stale.example",
          ONSALE_COOKIE_SECURE: secure === "true" ? "false" : "true",
        }),
      ).toMatchObject({
        ONSALE_ALLOWED_ORIGINS: origin,
        ONSALE_CANONICAL_ORIGIN: origin,
        ONSALE_COOKIE_SECURE: secure,
        ONSALE_RECORDED_RUN_SCOPE: "local_review",
      })
    },
  )

  it.each([
    "http://onsale-v01.localhost",
    "http://onsale-v01.localhost:4311",
    "https://preview.onsale-v01.localhost",
    "https://onsale-v01.localhost/path",
  ])("rejects Portless origin drift %s before Next starts", (origin) => {
    expect(() =>
      buildLocalPreviewEnvironmentV1(PRIVATE_SOURCE, {
        PORTLESS_URL: origin,
        ONSALE_PORTLESS_NAME: "onsale-v01",
      }),
    ).toThrow(/Portless URL/iu)
  })

  it("accepts a different safe Portless name only when name and URL agree", () => {
    const environment = buildLocalPreviewEnvironmentV1(PRIVATE_SOURCE, {
      ONSALE_PORTLESS_NAME: "onsale-review",
      PORTLESS_URL: "http://onsale-review.localhost:4310",
    })
    expect(environment.ONSALE_CANONICAL_ORIGIN).toBe(
      "http://onsale-review.localhost:4310",
    )
    expect(() =>
      buildLocalPreviewEnvironmentV1(PRIVATE_SOURCE, {
        ONSALE_PORTLESS_NAME: "onsale-review",
        PORTLESS_URL: "http://onsale-v01.localhost:4310",
      }),
    ).toThrow(/Portless URL/iu)
  })

  it("binds Next to the private socket Portless assigned", () => {
    expect(
      localPreviewNextArgumentsV1("dev", {
        HOST: "127.0.0.1",
        PORT: "4567",
      }),
    ).toEqual([
      "node_modules/next/dist/bin/next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4567",
    ])
  })
})
