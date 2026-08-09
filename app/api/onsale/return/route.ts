import { handleOnsaleCheckoutReturnGetV1 } from "@/server/onsale-checkout-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return handleOnsaleCheckoutReturnGetV1(request)
}
