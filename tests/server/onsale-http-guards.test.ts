import { describe, expect, it } from "vitest"

import { parseQuoteSeatsRequestV1 } from "../../src/domain/onsale-public-contract"
import {
  MAX_ONSALE_JSON_BYTES_V1,
  OnsaleHttpGuardError,
  assertConfiguredOriginV1,
  inventoryPrivateResponseHeadersV1,
  parseBoundedJsonRequestV1,
  parseConfiguredOriginsV1,
  readBoundedJsonV1,
  type JsonRequestLikeV1,
} from "../../src/server/onsale-http-guards"
import { uuidV4 } from "../fixtures/onsale-public-v1"

function requestFromChunks(
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>> = {
    "content-type": "application/json",
  },
): JsonRequestLikeV1 {
  return {
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  }
}

function jsonRequest(
  value: unknown,
  headers?: Readonly<Record<string, string>>,
): JsonRequestLikeV1 {
  return requestFromChunks(
    [new TextEncoder().encode(JSON.stringify(value))],
    headers,
  )
}

describe("C2 bounded JSON guard", () => {
  it("accepts JSON up to exactly 16 KiB and applies the strict schema parser", async () => {
    const exact = `{"v":"${"a".repeat(MAX_ONSALE_JSON_BYTES_V1 - 8)}"}`
    expect(new TextEncoder().encode(exact)).toHaveLength(
      MAX_ONSALE_JSON_BYTES_V1,
    )
    await expect(
      readBoundedJsonV1(
        requestFromChunks([new TextEncoder().encode(exact)], {
          "content-type": "application/json; charset=UTF-8",
        }),
      ),
    ).resolves.toEqual({ v: "a".repeat(MAX_ONSALE_JSON_BYTES_V1 - 8) })

    const parsed = await parseBoundedJsonRequestV1(
      jsonRequest({
        requestId: uuidV4(900),
        saleWindowRef: uuidV4(3),
        seatRefs: [uuidV4(101)],
      }),
      parseQuoteSeatsRequestV1,
    )
    expect(parsed.seatRefs).toEqual([uuidV4(101)])
  })

  it("rejects declared or streamed overflow before schema code can run", async () => {
    let parserCalled = false
    const declared = requestFromChunks([new TextEncoder().encode("{}")], {
      "content-type": "application/json",
      "content-length": String(MAX_ONSALE_JSON_BYTES_V1 + 1),
    })
    const streamed = requestFromChunks([
      new Uint8Array(10_000),
      new Uint8Array(7_000),
    ])

    await expect(
      parseBoundedJsonRequestV1(declared, (value) => {
        parserCalled = true
        return value
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" })
    await expect(readBoundedJsonV1(streamed)).rejects.toMatchObject({
      kind: "invalid_request",
    })
    expect(parserCalled).toBe(false)
  })

  it("rejects non-JSON, malformed JSON/UTF-8, empty bodies, and schema extras", async () => {
    const invalidUtf8 = requestFromChunks([Uint8Array.from([0xc3, 0x28])])
    const candidates = [
      requestFromChunks([new TextEncoder().encode("{}")], {
        "content-type": "text/plain",
      }),
      requestFromChunks([new TextEncoder().encode("{")]),
      invalidUtf8,
      requestFromChunks([]),
    ]
    for (const request of candidates) {
      await expect(readBoundedJsonV1(request)).rejects.toBeInstanceOf(
        OnsaleHttpGuardError,
      )
    }

    await expect(
      parseBoundedJsonRequestV1(
        jsonRequest({
          requestId: uuidV4(900),
          saleWindowRef: uuidV4(3),
          seatRefs: [uuidV4(101)],
          buyerRef: "private",
        }),
        parseQuoteSeatsRequestV1,
      ),
    ).rejects.toMatchObject({ kind: "invalid_request" })
  })
})

describe("C2 exact configured-origin guard", () => {
  it("normalizes configured/request origins but allows no subdomain, path, or port drift", () => {
    const configured = parseConfiguredOriginsV1([
      "https://ONSALE.example:443/",
      "http://localhost:3000",
    ])

    expect(assertConfiguredOriginV1("https://onsale.example", configured)).toBe(
      "https://onsale.example",
    )
    expect(assertConfiguredOriginV1("http://LOCALHOST:3000", configured)).toBe(
      "http://localhost:3000",
    )

    for (const denied of [
      undefined,
      "null",
      "https://evil.onsale.example",
      "https://onsale.example:444",
      "https://onsale.example.evil.test",
      "https://onsale.example/path",
    ]) {
      expect(() => assertConfiguredOriginV1(denied, configured)).toThrow(
        OnsaleHttpGuardError,
      )
    }
  })

  it("rejects wildcard, credentialed, non-http, and path-bearing configuration", () => {
    for (const configured of [
      "*",
      "https://user:pass@example.com",
      "file:///tmp/onsale",
      "https://example.com/path",
    ]) {
      expect(() => parseConfiguredOriginsV1([configured])).toThrow(
        OnsaleHttpGuardError,
      )
    }
  })

  it("supplies the non-cacheable private response policy", () => {
    expect(inventoryPrivateResponseHeadersV1()).toEqual({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    })
  })
})
