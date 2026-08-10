import { handleRecordedRunDetailGetV1 } from "@/server/onsale-recorded-runs-neon"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly runRef: string }> },
): Promise<Response> {
  const { runRef } = await context.params
  return handleRecordedRunDetailGetV1(request, runRef)
}
