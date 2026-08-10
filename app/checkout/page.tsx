import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { ONSALE_CURRENT_ORDER_COOKIE_NAME_V1 } from "../../src/server/onsale-checkout-route-runtime"
import { ONSALE_SESSION_COOKIE_NAME_V1 } from "../../src/server/onsale-session"
import FigmaApp from "../figma-app"

export default async function CheckoutRecoveryPage() {
  const cookieStore = await cookies()
  if (
    !cookieStore.has(ONSALE_CURRENT_ORDER_COOKIE_NAME_V1) ||
    !cookieStore.has(ONSALE_SESSION_COOKIE_NAME_V1)
  ) {
    redirect("/")
  }

  return <FigmaApp resumeCheckout />
}
