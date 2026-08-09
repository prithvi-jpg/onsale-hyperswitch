import type { Metadata } from "next"

import { parseRecordedRunRefV1 } from "../../src/onsale/contracts/recorded-run-v1"
import FlowsGallery from "./FlowsGallery"

export const metadata: Metadata = {
  title: "ONSALE Flows — Recorded Payment Replays",
  description:
    "Read-only, evidence-backed replays of dated Juspay Hyperswitch sandbox payment outcomes.",
}

interface FlowsPagePropsV1 {
  readonly searchParams: Promise<
    Readonly<Record<string, string | readonly string[] | undefined>>
  >
}

export default async function FlowsPage({
  searchParams,
}: FlowsPagePropsV1) {
  const requested = (await searchParams).run
  let requestedRun: string | null = null
  if (typeof requested === "string") {
    try {
      requestedRun = parseRecordedRunRefV1(requested, "$.run")
    } catch {
      requestedRun = requested
    }
  } else if (Array.isArray(requested)) {
    requestedRun = requested.join(",")
  }
  return <FlowsGallery requestedRun={requestedRun} />
}
