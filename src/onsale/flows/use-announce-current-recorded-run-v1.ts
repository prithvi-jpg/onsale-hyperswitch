"use client"

import { useEffect, useRef, useState } from "react"

import type { RecordedRunRefV1 } from "../contracts/recorded-run-v1"
import { announceCompletedRunV1 } from "./completed-run-signal-v1"
import {
  fetchCurrentRecordedRunV1,
  isRecordedRunsAbortErrorV1,
  type RecordedRunsFetchV1,
} from "./recorded-runs-client-v1"

export async function announceCurrentRecordedRunForRevisionV1({
  fetchImpl,
  signal,
  announce = announceCompletedRunV1,
}: {
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
  readonly announce?: (runRef: RecordedRunRefV1) => void
} = {}): Promise<RecordedRunRefV1 | null> {
  const current = await fetchCurrentRecordedRunV1({ fetchImpl, signal })
  if (!current.terminal || current.runRef === null) return null
  announce(current.runRef)
  return current.runRef
}

/**
 * Announces a terminal, cookie-owned run once per checkout evidence revision.
 * The hook is event driven: it performs one GET when the caller's terminal
 * revision changes and never polls.
 */
export function useAnnounceCurrentRecordedRunV1(
  terminalEvidenceRevision: string | null,
): RecordedRunRefV1 | null {
  const announcedRevision = useRef<string | null>(null)
  const [resolved, setResolved] = useState<{
    readonly revision: string
    readonly runRef: RecordedRunRefV1
  } | null>(null)

  useEffect(() => {
    if (
      terminalEvidenceRevision === null ||
      terminalEvidenceRevision === announcedRevision.current
    ) return
    const controller = new AbortController()
    void announceCurrentRecordedRunForRevisionV1({
      signal: controller.signal,
    })
      .then((resolvedRunRef) => {
        if (resolvedRunRef === null || controller.signal.aborted) return
        announcedRevision.current = terminalEvidenceRevision
        setResolved({
          revision: terminalEvidenceRevision,
          runRef: resolvedRunRef,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isRecordedRunsAbortErrorV1(error)) {
          return
        }
        // Checkout remains authoritative; a reviewer refresh is best effort.
      })
    return () => controller.abort()
  }, [terminalEvidenceRevision])

  return resolved?.revision === terminalEvidenceRevision
    ? resolved.runRef
    : null
}
