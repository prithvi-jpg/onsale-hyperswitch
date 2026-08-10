import { handleRecordedRunsListGetV1 } from "@/server/onsale-recorded-runs-neon"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return handleRecordedRunsListGetV1(request)
}
