import { describe, expect, it } from "vitest"

import { POST } from "../../app/api/onsale/demo/reset/route"

function request(origin: string): Request {
  return new Request("http://localhost:3102/api/onsale/demo/reset", {
    method: "POST",
    headers: { Origin: origin },
  })
}

describe("ONSALE demo reset boundary", () => {
  it("expires only the current-order pointer and preserves browser history identity", async () => {
    const response = await POST(request("http://onsale-v01.localhost:4310"))

    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    )
    expect(response.headers.get("vary")).toBe("Cookie, Origin")
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^onsale_current_order_v1=;/u)
    expect(cookies[0]).not.toContain("onsale_session_v1")
    expect(cookies.every((cookie) => cookie.includes("HttpOnly"))).toBe(true)
    expect(cookies.every((cookie) => cookie.includes("SameSite=Lax"))).toBe(true)
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true)
    expect(cookies.every((cookie) => !cookie.includes("Secure"))).toBe(true)
  })

  it("rejects an attacker origin without changing either cookie", async () => {
    const response = await POST(request("https://attacker.example"))

    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "REQUEST_ORIGIN_DENIED",
        message: "This request is not allowed.",
      },
    })
  })
})
