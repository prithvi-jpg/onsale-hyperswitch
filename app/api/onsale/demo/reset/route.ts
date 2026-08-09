import { ONSALE_CURRENT_ORDER_COOKIE_NAME_V1 } from "@/server/onsale-checkout-route-runtime"
import { resolveOnsaleCheckoutHttpConfigurationV1 } from "@/server/onsale-checkout-runtime"
import {
  OnsaleHttpGuardError,
  assertConfiguredOriginV1,
} from "@/server/onsale-http-guards"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function expireCookie(name: string, secure: boolean): string {
  const parts = [
    `${name}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    Vary: "Cookie, Origin",
    "X-Content-Type-Options": "nosniff",
  })
}

export async function POST(request: Request): Promise<Response> {
  let configuration: ReturnType<
    typeof resolveOnsaleCheckoutHttpConfigurationV1
  >
  try {
    configuration = resolveOnsaleCheckoutHttpConfigurationV1(process.env)
    assertConfiguredOriginV1(
      request.headers.get("origin"),
      configuration.configuredOrigins,
    )
  } catch (error) {
    const headers = responseHeaders()
    headers.set("Content-Type", "application/json; charset=utf-8")
    const denied = error instanceof OnsaleHttpGuardError
    return Response.json(
      {
        ok: false,
        error: {
          code: denied ? "REQUEST_ORIGIN_DENIED" : "RESET_UNAVAILABLE",
          message: denied
            ? "This request is not allowed."
            : "A new demo session could not be started.",
        },
      },
      { status: denied ? 403 : 503, headers },
    )
  }

  const headers = responseHeaders()
  headers.append(
    "Set-Cookie",
    expireCookie(
      ONSALE_CURRENT_ORDER_COOKIE_NAME_V1,
      configuration.secureCookie,
    ),
  )
  return new Response(null, { status: 204, headers })
}
