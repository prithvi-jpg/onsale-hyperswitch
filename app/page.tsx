import { cookies } from "next/headers"

import {
  ONSALE_CURRENT_ORDER_COOKIE_NAME_V1,
} from "../src/server/onsale-checkout-route-runtime"
import FigmaApp from "./figma-app"

export default async function HomePage() {
  const cookieStore = await cookies()
  return (
    <FigmaApp
      resumeCheckout={cookieStore.has(ONSALE_CURRENT_ORDER_COOKIE_NAME_V1)}
    />
  )
}
