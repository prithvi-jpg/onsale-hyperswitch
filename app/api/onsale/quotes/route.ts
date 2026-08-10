import { handleOnsaleQuotePostV1 } from "@/server/onsale-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  return handleOnsaleQuotePostV1(request)
}
