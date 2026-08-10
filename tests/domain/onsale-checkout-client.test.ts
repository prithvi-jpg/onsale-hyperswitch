import { describe, expect, it, vi } from "vitest"

import {
  createOnsaleCheckoutHttpClientV1,
  settleOfficialCheckoutSubmissionV1,
} from "../../src/use-onsale-checkout"

const COMMAND_ID = "00000000-0000-4000-8000-000000000901"
const HOLD_REF = "00000000-0000-4000-8000-000000000501"

function failureBody(code = "ORDER_NOT_FOUND") {
  return {
    schema: "onsale.checkout-private.v1",
    ok: false,
    error: {
      code,
      message: "The order was not found.",
      retryable: false,
    },
  }
}

describe("C3 browser checkout client", () => {
  it("prepares with only one command and the active public hold reference", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(failureBody()), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    )
    const client = createOnsaleCheckoutHttpClientV1(fetcher)

    await client.prepare(COMMAND_ID, HOLD_REF)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [path, init] = fetcher.mock.calls[0] ?? []
    expect(path).toBe("/api/onsale/checkout/prepare")
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toEqual({
      commandId: COMMAND_ID,
      holdRef: HOLD_REF,
    })
  })

  it("reconciles through the HttpOnly pointer using no browser-visible order identity", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(failureBody()), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    )
    const client = createOnsaleCheckoutHttpClientV1(fetcher)

    await client.reconcile(COMMAND_ID, "resume")

    const [path, init] = fetcher.mock.calls[0] ?? []
    expect(path).toBe("/api/onsale/checkout/reconcile")
    expect(JSON.parse(String(init?.body))).toEqual({
      commandId: COMMAND_ID,
      trigger: "resume",
    })
    expect(String(init?.body)).not.toMatch(/order|payment|provider|query|url/iu)
  })

  it.each(["resolve", "throw"] as const)(
    "treats an SDK %s as unknown and performs one same-payment reconcile",
    async (settlement) => {
      const confirm =
        settlement === "resolve"
          ? vi.fn(async () => ({ arbitrarySdkResult: "ignored" }))
          : vi.fn(async () => {
              throw new Error("sdk failed after submission")
            })
      const reconcile = vi.fn(async () => undefined)

      await settleOfficialCheckoutSubmissionV1(confirm, reconcile)

      expect(confirm).toHaveBeenCalledTimes(1)
      expect(reconcile).toHaveBeenCalledTimes(1)
    },
  )
})
