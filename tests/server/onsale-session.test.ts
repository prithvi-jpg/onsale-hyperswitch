import { createHash } from "node:crypto"
import { inspect } from "node:util"

import { describe, expect, it } from "vitest"

import {
  ONSALE_SESSION_COOKIE_NAME_V1,
  createSessionOperationKeyV1,
  resolveExistingAnonymousSessionV1,
  resolveAnonymousSessionV1,
  serializeOnsaleSessionCookieV1,
} from "../../src/server/onsale-session"
import { uuidV4 } from "../fixtures/onsale-public-v1"

const FIRST_TOKEN_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)

describe("C2 anonymous session boundary", () => {
  it("mints exactly 32 base64url bytes and derives the namespaced buyer digest", () => {
    const resolved = resolveAnonymousSessionV1({
      candidateToken: undefined,
      randomBytes: () => FIRST_TOKEN_BYTES,
    })
    const token = resolved.session.cookieToken()
    const expectedDigest = createHash("sha256")
      .update("onsale-session-v1\0", "utf8")
      .update(FIRST_TOKEN_BYTES)
      .digest("hex")

    expect(resolved.shouldSetCookie).toBe(true)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(resolved.session.buyerRef()).toBe(`sess_${expectedDigest}`)
  })

  it("reuses one valid cookie across refresh and rotates malformed candidates", () => {
    const first = resolveAnonymousSessionV1({
      candidateToken: undefined,
      randomBytes: () => FIRST_TOKEN_BYTES,
    })
    const refresh = resolveAnonymousSessionV1({
      candidateToken: first.session.cookieToken(),
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 255),
    })
    const rotated = resolveAnonymousSessionV1({
      candidateToken: "not-a-valid-session-token",
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 255),
    })

    expect(refresh.shouldSetCookie).toBe(false)
    expect(refresh.session.buyerRef()).toBe(first.session.buyerRef())
    expect(rotated.shouldSetCookie).toBe(true)
    expect(rotated.session.buyerRef()).not.toBe(first.session.buyerRef())
  })

  it("resolves an existing session without minting replacement authority", () => {
    const first = resolveAnonymousSessionV1({
      candidateToken: undefined,
      randomBytes: () => FIRST_TOKEN_BYTES,
    })

    const existing = resolveExistingAnonymousSessionV1(
      first.session.cookieToken(),
    )
    expect(existing?.shouldSetCookie).toBe(false)
    expect(existing?.session.buyerRef()).toBe(first.session.buyerRef())
    expect(resolveExistingAnonymousSessionV1(undefined)).toBeUndefined()
    expect(
      resolveExistingAnonymousSessionV1("not-a-valid-session-token"),
    ).toBeUndefined()
  })

  it("redacts raw token and buyer identity from JSON, string, and inspection", () => {
    const { session } = resolveAnonymousSessionV1({
      candidateToken: undefined,
      randomBytes: () => FIRST_TOKEN_BYTES,
    })
    const token = session.cookieToken()
    const buyerRef = session.buyerRef()

    for (const rendered of [
      JSON.stringify(session),
      String(session),
      inspect(session),
    ]) {
      expect(rendered).not.toContain(token)
      expect(rendered).not.toContain(buyerRef)
    }
    expect(JSON.stringify(session)).toBe('{"kind":"anonymous_browser"}')
  })

  it("serializes the fixed cookie flags and a buyer-scoped operation key", () => {
    const { session } = resolveAnonymousSessionV1({
      candidateToken: undefined,
      randomBytes: () => FIRST_TOKEN_BYTES,
    })
    const commandId = uuidV4(901)

    expect(
      serializeOnsaleSessionCookieV1(session.cookieToken(), { secure: true }),
    ).toBe(
      `${ONSALE_SESSION_COOKIE_NAME_V1}=${session.cookieToken()}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax; Secure`,
    )
    expect(createSessionOperationKeyV1(session, commandId)).toBe(
      `c2:${session.buyerRef()}:${commandId}`,
    )
  })
})
