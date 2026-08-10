import { handleOnsaleHoldPostV1 } from "@/server/onsale-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  return handleOnsaleHoldPostV1(request)
}
