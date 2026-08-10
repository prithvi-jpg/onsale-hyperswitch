import { handleOnsaleSessionGetV1 } from "@/server/onsale-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return handleOnsaleSessionGetV1(request)
}
