import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { inspect } from "node:util"

import {
  parseCommandIdV1,
  type CommandIdV1,
} from "../domain/onsale-public-contract"

export const ONSALE_SESSION_COOKIE_NAME_V1 = "onsale_session_v1"
export const ONSALE_SESSION_MAX_AGE_SECONDS_V1 = 86_400

const SESSION_BYTE_LENGTH = 32
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/
const BUYER_DIGEST_NAMESPACE = "onsale-session-v1\0"

export class AnonymousBrowserSessionV1 {
  readonly kind = "anonymous_browser" as const
  readonly #token: string
  readonly #buyerDigest: string

  private constructor(token: string, tokenBytes: Uint8Array) {
    this.#token = token
    this.#buyerDigest = `sess_${createHash("sha256")
      .update(BUYER_DIGEST_NAMESPACE, "utf8")
      .update(tokenBytes)
      .digest("hex")}`
  }

  static fromValidatedToken(token: string, tokenBytes: Uint8Array) {
    return new AnonymousBrowserSessionV1(token, tokenBytes)
  }

  cookieToken(): string {
    return this.#token
  }

  buyerRef(): string {
    return this.#buyerDigest
  }

  toJSON(): { readonly kind: "anonymous_browser" } {
    return { kind: "anonymous_browser" }
  }

  toString(): string {
    return "AnonymousBrowserSessionV1 { redacted }"
  }

  [inspect.custom](): string {
    return this.toString()
  }
}

export interface ResolveAnonymousSessionOptionsV1 {
  readonly candidateToken?: string | null
  readonly randomBytes?: (size: number) => Uint8Array
}

export interface ResolvedAnonymousSessionV1 {
  readonly session: AnonymousBrowserSessionV1
  readonly shouldSetCookie: boolean
}

function decodeValidToken(token: string | null | undefined): Uint8Array | null {
  if (typeof token !== "string" || !BASE64URL_TOKEN.test(token)) return null
  try {
    const bytes = Buffer.from(token, "base64url")
    if (bytes.byteLength !== SESSION_BYTE_LENGTH) return null
    if (bytes.toString("base64url") !== token) return null
    return Uint8Array.from(bytes)
  } catch {
    return null
  }
}

export function resolveAnonymousSessionV1(
  options: ResolveAnonymousSessionOptionsV1 = {},
): ResolvedAnonymousSessionV1 {
  const existingBytes = decodeValidToken(options.candidateToken)
  if (existingBytes && options.candidateToken) {
    return {
      session: AnonymousBrowserSessionV1.fromValidatedToken(
        options.candidateToken,
        existingBytes,
      ),
      shouldSetCookie: false,
    }
  }

  const randomSource = options.randomBytes ?? nodeRandomBytes
  const generated = Uint8Array.from(randomSource(SESSION_BYTE_LENGTH))
  if (generated.byteLength !== SESSION_BYTE_LENGTH) {
    throw new RangeError("Session entropy source must return exactly 32 bytes")
  }
  const token = Buffer.from(generated).toString("base64url")
  return {
    session: AnonymousBrowserSessionV1.fromValidatedToken(token, generated),
    shouldSetCookie: true,
  }
}

/**
 * Restores existing browser authority without manufacturing a replacement.
 * Same-payment reconciliation must never silently change buyer identity.
 */
export function resolveExistingAnonymousSessionV1(
  candidateToken: string | null | undefined,
): ResolvedAnonymousSessionV1 | undefined {
  const tokenBytes = decodeValidToken(candidateToken)
  if (tokenBytes === null || typeof candidateToken !== "string") {
    return undefined
  }
  return {
    session: AnonymousBrowserSessionV1.fromValidatedToken(
      candidateToken,
      tokenBytes,
    ),
    shouldSetCookie: false,
  }
}

export function serializeOnsaleSessionCookieV1(
  token: string,
  options: { readonly secure: boolean },
): string {
  if (decodeValidToken(token) === null) {
    throw new TypeError("Cannot serialize an invalid ONSALE session token")
  }
  return [
    `${ONSALE_SESSION_COOKIE_NAME_V1}=${token}`,
    `Max-Age=${ONSALE_SESSION_MAX_AGE_SECONDS_V1}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ")
}

export function createSessionOperationKeyV1(
  session: AnonymousBrowserSessionV1,
  commandId: CommandIdV1 | string,
): string {
  const validatedCommandId = parseCommandIdV1(commandId)
  return `c2:${session.buyerRef()}:${validatedCommandId}`
}
