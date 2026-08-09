import { handleOnsaleCheckoutPreparePostV1 } from "@/server/onsale-checkout-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  return handleOnsaleCheckoutPreparePostV1(request)
}
