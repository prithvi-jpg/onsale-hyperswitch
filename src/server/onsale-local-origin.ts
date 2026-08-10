export const ONSALE_PORTLESS_DEFAULT_NAME_V1 = "onsale-v01" as const
export const ONSALE_PORTLESS_NAME_ENV_V1 = "ONSALE_PORTLESS_NAME" as const
export const ONSALE_PORTLESS_HTTP_PORT_V1 = "4310" as const
const PORTLESS_APP_NAME_V1 =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

export function parseOnsalePortlessNameV1(
  candidate: string | undefined,
): string {
  const name = candidate?.trim() || ONSALE_PORTLESS_DEFAULT_NAME_V1
  if (!PORTLESS_APP_NAME_V1.test(name)) {
    throw new Error(
      "ONSALE_PORTLESS_NAME must be one lowercase DNS label using letters, numbers, or interior hyphens.",
    )
  }
  return name
}

export function onsalePortlessOriginsV1(
  candidateName?: string,
): Readonly<{ http: string; https: string }> {
  const name = parseOnsalePortlessNameV1(candidateName)
  return Object.freeze({
    http: `http://${name}.localhost:${ONSALE_PORTLESS_HTTP_PORT_V1}`,
    https: `https://${name}.localhost`,
  })
}

const DEFAULT_PORTLESS_ORIGINS_V1 = onsalePortlessOriginsV1()
export const ONSALE_PORTLESS_HTTP_ORIGIN_V1 =
  DEFAULT_PORTLESS_ORIGINS_V1.http
export const ONSALE_PORTLESS_HTTPS_ORIGIN_V1 =
  DEFAULT_PORTLESS_ORIGINS_V1.https
export const ONSALE_DIRECT_HTTP_ORIGIN_V1 =
  "http://localhost:3102" as const

export type OnsaleLocalOriginKindV1 =
  | "portless_http"
  | "portless_https"
  | "direct_http"
  | "loopback_http"

export function classifyOnsaleLocalOriginV1(
  candidate: string,
): OnsaleLocalOriginKindV1 | null {
  if (candidate === ONSALE_DIRECT_HTTP_ORIGIN_V1) return "direct_http"

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  const hostname = parsed.hostname.toLowerCase()
  const hostnameParts = hostname.split(".")
  const portlessName = hostnameParts.length === 2 ? hostnameParts[0] : null
  const isNamedPortlessHost =
    portlessName !== null &&
    hostnameParts[1] === "localhost" &&
    PORTLESS_APP_NAME_V1.test(portlessName)
  if (
    parsed.origin === candidate &&
    isNamedPortlessHost &&
    parsed.protocol === "http:" &&
    parsed.port === ONSALE_PORTLESS_HTTP_PORT_V1
  ) {
    return "portless_http"
  }
  if (
    parsed.origin === candidate &&
    isNamedPortlessHost &&
    parsed.protocol === "https:" &&
    parsed.port === ""
  ) {
    return "portless_https"
  }
  if (
    parsed.protocol === "http:" &&
    parsed.origin === candidate &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1")
  ) {
    return "loopback_http"
  }
  return null
}
