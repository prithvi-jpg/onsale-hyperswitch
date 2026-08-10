import { handleOnsaleHoldExpirePostV1 } from "@/server/onsale-route-runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface HoldRouteContextV1 {
  readonly params: Promise<{ readonly holdRef: string }>
}

export async function POST(
  request: Request,
  context: HoldRouteContextV1,
): Promise<Response> {
  const { holdRef } = await context.params
  return handleOnsaleHoldExpirePostV1(request, holdRef)
}
