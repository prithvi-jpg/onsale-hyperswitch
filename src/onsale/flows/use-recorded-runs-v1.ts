"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type {
  RecordedRunRefV1,
  RecordedRunSummaryV1,
} from "../contracts/recorded-run-v1"
import {
  RecordedRunsClientErrorV1,
  assertRecordedRunMatchesSummaryV1,
  fetchExactRecordedRunV1,
  fetchExactRecordedRunWithLedgerV1,
  fetchRecordedRunV1,
  fetchRecordedRunsPageV1,
  isRecordedRunsAbortErrorV1,
  type RecordedRunsFetchV1,
  type RecordedRunsSeedV1,
  type SelectedRecordedRunV1,
} from "./recorded-runs-client-v1"

export type RecordedRunsStatusV1 =
  | "loading"
  | "ready"
  | "empty"
  | "not_found"
  | "unavailable"
  | "integrity_error"
  | "error"

export interface RecordedRunsStateV1 {
  readonly status: RecordedRunsStatusV1
  readonly items: readonly RecordedRunSummaryV1[]
  readonly nextCursor: RecordedRunRefV1 | null
  readonly selected: SelectedRecordedRunV1 | null
  readonly pendingRunRef: RecordedRunRefV1 | null
  readonly loadingMore: boolean
  readonly message: string | null
}

export function exactRunResolvingStateV1(
  runRef: RecordedRunRefV1,
): RecordedRunsStateV1 {
  return {
    status: "loading",
    items: [],
    nextCursor: null,
    selected: null,
    pendingRunRef: runRef,
    loadingMore: false,
    message: `Resolving requested run ${runRef}.`,
  }
}

export function mergeCompletedRunV1(
  previous: RecordedRunsStateV1,
  completed: SelectedRecordedRunV1,
): RecordedRunsStateV1 {
  const existing = previous.items.findIndex(
    (item) => item.runRef === completed.summary.runRef,
  )
  const items =
    existing === -1
      ? [completed.summary, ...previous.items]
      : previous.items.map((item, index) =>
          index === existing ? completed.summary : item,
        )
  return {
    ...previous,
    status: "ready",
    items,
    selected: completed,
    pendingRunRef: null,
    message: null,
  }
}

export function recordedRunsStateFromSeedV1(
  seed: RecordedRunsSeedV1,
): RecordedRunsStateV1 {
  if (seed.kind === "ready") {
    const summary = seed.page.items.find(
      (item) => item.runRef === seed.trace.runRef,
    )
    if (!summary) {
      return {
        status: "integrity_error",
        items: seed.page.items,
        nextCursor: seed.page.page.nextCursor,
        selected: null,
        pendingRunRef: null,
        loadingMore: false,
        message:
          "The preloaded run does not belong to the retained page and was withheld.",
      }
    }
    try {
      assertRecordedRunMatchesSummaryV1(summary, seed.trace)
    } catch {
      return {
        status: "integrity_error",
        items: seed.page.items,
        nextCursor: seed.page.page.nextCursor,
        selected: null,
        pendingRunRef: null,
        loadingMore: false,
        message:
          "The preloaded run does not match its retained summary and was withheld.",
      }
    }
    return {
      status: "ready",
      items: seed.page.items,
      nextCursor: seed.page.page.nextCursor,
      selected: { summary, trace: seed.trace },
      pendingRunRef: null,
      loadingMore: false,
      message: null,
    }
  }
  if (seed.kind === "empty") {
    return {
      status: "empty",
      items: [],
      nextCursor: null,
      selected: null,
      pendingRunRef: null,
      loadingMore: false,
      message: "No durable payment runs are retained for this review set.",
    }
  }
  return {
    status: seed.kind,
    items: [],
    nextCursor: null,
    selected: null,
    pendingRunRef: null,
    loadingMore: false,
    message: seed.message,
  }
}

function clientFailure(
  error: unknown,
  previous: RecordedRunsStateV1,
): RecordedRunsStateV1 {
  const typed =
    error instanceof RecordedRunsClientErrorV1
      ? error
      : new RecordedRunsClientErrorV1("network")
  const status: RecordedRunsStatusV1 =
    typed.kind === "integrity"
      ? "integrity_error"
      : typed.kind === "not_found"
        ? "not_found"
        : typed.kind === "network" ||
            typed.kind === "unavailable" ||
            typed.kind === "denied"
          ? "unavailable"
          : "error"
  return {
    ...previous,
    status: previous.selected === null ? status : previous.status,
    pendingRunRef: null,
    loadingMore: false,
    message: typed.userMessage,
  }
}

function requestGate() {
  let generation = 0
  let controller: AbortController | null = null
  return {
    begin() {
      controller?.abort()
      controller = new AbortController()
      generation += 1
      const ownGeneration = generation
      const ownController = controller
      return {
        signal: ownController.signal,
        isCurrent: () =>
          generation === ownGeneration &&
          controller === ownController &&
          !ownController.signal.aborted,
      }
    },
    cancel() {
      controller?.abort()
      controller = null
      generation += 1
    },
  }
}

export function useRecordedRunsV1({
  initialSeed,
  initialExactRunRef = null,
  fetchImpl,
}: {
  readonly initialSeed: RecordedRunsSeedV1
  readonly initialExactRunRef?: RecordedRunRefV1 | null
  readonly fetchImpl?: RecordedRunsFetchV1
}) {
  const [state, setState] = useState(() =>
    initialExactRunRef === null
      ? recordedRunsStateFromSeedV1(initialSeed)
      : exactRunResolvingStateV1(initialExactRunRef),
  )
  const listGate = useRef(requestGate())
  const detailGate = useRef(requestGate())
  const pageGate = useRef(requestGate())
  const completedGate = useRef(requestGate())

  useEffect(
    () => () => {
      listGate.current.cancel()
      detailGate.current.cancel()
      pageGate.current.cancel()
      completedGate.current.cancel()
    },
    [],
  )

  const reload = useCallback(async () => {
    detailGate.current.cancel()
    pageGate.current.cancel()
    const ticket = listGate.current.begin()
    setState({
      status: "loading",
      items: [],
      nextCursor: null,
      selected: null,
      pendingRunRef: null,
      loadingMore: false,
      message: null,
    })
    try {
      const page = await fetchRecordedRunsPageV1({
        fetchImpl,
        signal: ticket.signal,
      })
      if (!ticket.isCurrent()) return
      const summary = page.items[0]
      if (!summary) {
        setState(recordedRunsStateFromSeedV1({ kind: "empty" }))
        return
      }
      const trace = await fetchRecordedRunV1({
        runRef: summary.runRef,
        fetchImpl,
        signal: ticket.signal,
      })
      if (!ticket.isCurrent()) return
      setState(
        recordedRunsStateFromSeedV1({ kind: "ready", page, trace }),
      )
    } catch (error) {
      if (ticket.signal.aborted || isRecordedRunsAbortErrorV1(error)) return
      setState((previous) => clientFailure(error, previous))
    }
  }, [fetchImpl])

  const selectRun = useCallback(
    async (runRef: RecordedRunRefV1) => {
      const summary = state.items.find((item) => item.runRef === runRef)
      if (!summary || state.selected?.summary.runRef === runRef) return
      const ticket = detailGate.current.begin()
      setState((previous) => ({
        ...previous,
        pendingRunRef: runRef,
        message: null,
      }))
      try {
        const trace = await fetchRecordedRunV1({
          runRef,
          fetchImpl,
          signal: ticket.signal,
        })
        if (!ticket.isCurrent()) return
        assertRecordedRunMatchesSummaryV1(summary, trace)
        setState((previous) => ({
          ...previous,
          status: "ready",
          selected: { summary, trace },
          pendingRunRef: null,
          message: null,
        }))
      } catch (error) {
        if (ticket.signal.aborted || isRecordedRunsAbortErrorV1(error)) return
        setState((previous) => clientFailure(error, previous))
      }
    },
    [fetchImpl, state.items, state.selected?.summary.runRef],
  )

  const loadMore = useCallback(async () => {
    if (state.nextCursor === null || state.loadingMore) return
    const ticket = pageGate.current.begin()
    setState((previous) => ({
      ...previous,
      loadingMore: true,
      message: null,
    }))
    try {
      const page = await fetchRecordedRunsPageV1({
        cursor: state.nextCursor,
        fetchImpl,
        signal: ticket.signal,
      })
      if (!ticket.isCurrent()) return
      setState((previous) => {
        const known = new Set(previous.items.map((item) => item.runRef))
        return {
          ...previous,
          items: [
            ...previous.items,
            ...page.items.filter((item) => !known.has(item.runRef)),
          ],
          nextCursor: page.page.nextCursor,
          loadingMore: false,
          message: null,
        }
      })
    } catch (error) {
      if (ticket.signal.aborted || isRecordedRunsAbortErrorV1(error)) return
      setState((previous) => clientFailure(error, previous))
    }
  }, [fetchImpl, state.loadingMore, state.nextCursor])

  const refreshCompletedRun = useCallback(
    async (runRef: RecordedRunRefV1): Promise<boolean> => {
      const ticket = completedGate.current.begin()
      setState((previous) => ({
        ...previous,
        pendingRunRef: runRef,
        message: null,
      }))
      try {
        const completed = await fetchExactRecordedRunV1({
          runRef,
          fetchImpl,
          signal: ticket.signal,
        })
        if (!ticket.isCurrent()) return false
        detailGate.current.cancel()
        setState((previous) => mergeCompletedRunV1(previous, completed))
        return true
      } catch (error) {
        if (ticket.signal.aborted || isRecordedRunsAbortErrorV1(error)) {
          return false
        }
        setState((previous) => clientFailure(error, previous))
        return false
      }
    },
    [fetchImpl],
  )

  const resolveExactRun = useCallback(
    async (runRef: RecordedRunRefV1): Promise<boolean> => {
      listGate.current.cancel()
      detailGate.current.cancel()
      pageGate.current.cancel()
      const ticket = completedGate.current.begin()
      setState(exactRunResolvingStateV1(runRef))
      try {
        const exactRun = await fetchExactRecordedRunWithLedgerV1({
          runRef,
          fetchImpl,
          signal: ticket.signal,
        })
        if (!ticket.isCurrent()) return false
        setState({
          status: "ready",
          items: exactRun.items,
          nextCursor: exactRun.nextCursor,
          selected: { summary: exactRun.summary, trace: exactRun.trace },
          pendingRunRef: null,
          loadingMore: false,
          message: null,
        })
        return true
      } catch (error) {
        if (ticket.signal.aborted || isRecordedRunsAbortErrorV1(error)) {
          return false
        }
        setState((previous) => clientFailure(error, previous))
        return false
      }
    },
    [fetchImpl],
  )

  return {
    state,
    reload,
    selectRun,
    loadMore,
    refreshCompletedRun,
    resolveExactRun,
  }
}
