"use client"
// In-memory replay still works when browser storage is unavailable.
// Nothing else is required for a completed operation.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  parseCommandIdV1,
  parseHoldCommandSuccessV1,
  parseInventoryFailureV1,
  parseOnsaleInventorySnapshotV1,
  parseQuoteSeatsResponseV1,
  type InventoryFailureV1,
  type OnsaleInventorySnapshotV1,
  type PublicRef,
  type QuoteSeatsResponseV1,
  type SeatRefs,
} from "./domain/onsale-public-contract"

const COMMAND_STORAGE_PREFIX = "onsale.c2.command."
const INVENTORY_REQUEST_TIMEOUT_MS_V1 = 15_000

export type InventoryRequestStateV1 = "loading" | "ready" | "quoting" | "claiming" | "releasing" | "expiring" | "blocked"

export interface OnsaleInventoryControllerV1 {
  readonly snapshot: OnsaleInventorySnapshotV1 | null
  readonly quote: QuoteSeatsResponseV1 | null
  readonly requestState: InventoryRequestStateV1
  readonly failure: InventoryFailureV1 | null
  readonly refresh: () => Promise<OnsaleInventorySnapshotV1 | null>
  readonly quoteSeats: (
    saleWindowRef: PublicRef,
    seatRefs: SeatRefs,
  ) => Promise<QuoteSeatsResponseV1 | null>
  readonly claimSeats: (
    saleWindowRef: PublicRef,
    seatRefs: SeatRefs,
    quoteRevision: QuoteSeatsResponseV1["quoteRevision"],
  ) => Promise<boolean>
  readonly releaseHold: (holdRef: PublicRef) => Promise<boolean>
  readonly expireHold: (holdRef: PublicRef) => Promise<boolean>
  readonly clearQuote: () => void
  readonly clearFailure: () => void
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function localFailure(): InventoryFailureV1 {
  return {
    ok: false,
    error: {
      code: "INVENTORY_TEMPORARILY_UNAVAILABLE",
      message: "Inventory is temporarily unavailable. Try again.",
      retryable: true,
    },
  }
}

function parseFailureOrFallback(value: unknown): InventoryFailureV1 {
  try {
    return parseInventoryFailureV1(value)
  } catch {
    return localFailure()
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS_V1),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function storedCommandId(key: string): string | null {
  if (
    typeof window ===
    "undefined"
  )
    return null
  try {
    const value = window.sessionStorage.getItem(
      `${COMMAND_STORAGE_PREFIX}${key}`,
    )
    return value ===
      null
      ? null
      : parseCommandIdV1(value)
  } catch {
    return null
  }
}

function storeCommandId(key: string, commandId: string): void {
  if (
    typeof window ===
    "undefined"
  )
    return
  try {
    window.sessionStorage.setItem(`${COMMAND_STORAGE_PREFIX}${key}`, commandId)
  } catch {}
}

function removeStoredCommandId(key: string): void {
  if (
    typeof window ===
    "undefined"
  )
    return
  try {
    window.sessionStorage.removeItem(`${COMMAND_STORAGE_PREFIX}${key}`)
  } catch {}
}

function sameSeatRefs(
  left: readonly PublicRef[],
  right: readonly PublicRef[],
): boolean {
  return (
    left.length === right.length &&
    left.every((seatRef, index) => seatRef === right[index])
  )
}

export function useOnsaleInventoryV1(): OnsaleInventoryControllerV1 {
  const [snapshot, setSnapshot] = useState<OnsaleInventorySnapshotV1 | null>(
    null,
  )
  const [quote, setQuote] = useState<QuoteSeatsResponseV1 | null>(null)
  const [requestState, setRequestState] =
    useState<InventoryRequestStateV1>("loading")
  const [failure, setFailure] = useState<InventoryFailureV1 | null>(null)
  const mounted = useRef(true)
  const latestQuoteRequest = useRef<string | null>(null)
  const snapshotRef = useRef<OnsaleInventorySnapshotV1 | null>(null)
  const requestSequence = useRef(0)
  const appliedSnapshotSequence = useRef(0)
  const pendingCommandIds = useRef(new Map<string, string>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const nextRequestSequence = useCallback(() => {
    requestSequence.current += 1
    return requestSequence.current
  }, [])

  const applySnapshot = useCallback(
    (candidate: OnsaleInventorySnapshotV1, sequence: number): boolean => {
      if (!mounted.current || sequence < appliedSnapshotSequence.current) {
        return false
      }
      const current = snapshotRef.current
      if (
        current &&
        Date.parse(candidate.serverTime) < Date.parse(current.serverTime)
      ) {
        return false
      }
      appliedSnapshotSequence.current = sequence
      snapshotRef.current = candidate
      setSnapshot(candidate)
      return true
    },
    [],
  )

  const commandIdFor = useCallback((key: string): string => {
    const pending = pendingCommandIds.current.get(key) ?? storedCommandId(key)
    if (pending) {
      pendingCommandIds.current.set(key, pending)
      return pending
    }
    const commandId = parseCommandIdV1(crypto.randomUUID())
    pendingCommandIds.current.set(key, commandId)
    storeCommandId(key, commandId)
    return commandId
  }, [])

  const completeCommand = useCallback((key: string): void => {
    pendingCommandIds.current.delete(key)
    removeStoredCommandId(key)
  }, [])

  const refresh = useCallback(async () => {
    const sequence = nextRequestSequence()
    try {
      const response = await fetch("/api/onsale/session", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS_V1),
      })
      const body = await responseJson(response)
      if (!response.ok) {
        if (mounted.current && sequence >= appliedSnapshotSequence.current) {
          setFailure(parseFailureOrFallback(body))
          setRequestState("blocked")
        }
        return null
      }
      const parsed = parseOnsaleInventorySnapshotV1(body)
      if (applySnapshot(parsed, sequence)) {
        setFailure(null)
        setRequestState("ready")
      }
      return parsed
    } catch {
      if (mounted.current && sequence >= appliedSnapshotSequence.current) {
        setFailure(localFailure())
        setRequestState("blocked")
      }
      return null
    }
  }, [applySnapshot, nextRequestSequence])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", reconcile)
    window.addEventListener("pageshow", reconcile)
    window.addEventListener("online", reconcile)
    return () => {
      document.removeEventListener("visibilitychange", reconcile)
      window.removeEventListener("pageshow", reconcile)
      window.removeEventListener("online", reconcile)
    }
  }, [refresh])

  const quoteSeats = useCallback(
    async (saleWindowRef: PublicRef, seatRefs: SeatRefs) => {
      const requestId = crypto.randomUUID()
      const sequence = nextRequestSequence()
      const basisRevision = snapshotRef.current?.revision ?? null
      latestQuoteRequest.current = requestId
      setRequestState("quoting")
      setFailure(null)
      setQuote(null)
      try {
        const response = await postJson("/api/onsale/quotes", {
          requestId,
          saleWindowRef,
          seatRefs,
        })
        const body = await responseJson(response)
        if (!response.ok) {
          if (latestQuoteRequest.current === requestId && mounted.current) {
            const parsedFailure = parseFailureOrFallback(body)
            if (parsedFailure.snapshot) {
              applySnapshot(parsedFailure.snapshot, sequence)
            }
            setFailure(parsedFailure)
            setQuote(null)
            setRequestState("blocked")
          }
          return null
        }
        const parsed = parseQuoteSeatsResponseV1(body)
        if (
          parsed.requestId !== requestId ||
          parsed.saleWindowRef !== saleWindowRef ||
          parsed.basisRevision !== basisRevision ||
          snapshotRef.current?.revision !== basisRevision ||
          parsed.seatRefs.length !== seatRefs.length ||
          parsed.seatRefs.some((seatRef, index) => seatRef !== seatRefs[index])
        ) {
          throw new Error("Mismatched inventory quote response.")
        }
        if (latestQuoteRequest.current === requestId && mounted.current) {
          setQuote(parsed)
          setRequestState("ready")
        }
        return parsed
      } catch {
        if (latestQuoteRequest.current === requestId && mounted.current) {
          setFailure(localFailure())
          setQuote(null)
          setRequestState("blocked")
        }
        return null
      }
    },
    [applySnapshot, nextRequestSequence],
  )

  const claimSeats = useCallback(
    async (
      saleWindowRef: PublicRef,
      seatRefs: SeatRefs,
      quoteRevision: QuoteSeatsResponseV1["quoteRevision"],
    ) => {
      const commandKey = `claim:${saleWindowRef}:${seatRefs.join(",")}:${quoteRevision}`
      const commandId = commandIdFor(commandKey)
      const sequence = nextRequestSequence()
      setRequestState("claiming")
      setFailure(null)
      try {
        const response = await postJson("/api/onsale/holds", {
          commandId,
          saleWindowRef,
          seatRefs,
          quoteRevision,
        })
        const body = await responseJson(response)
        if (!response.ok) {
          const parsedFailure = parseFailureOrFallback(body)
          if (!parsedFailure.error.retryable) completeCommand(commandKey)
          const recovered = await refresh()
          const recoveredSeatRefs =
            recovered?.currentHold?.items.map((item) => item.seatRef) ?? []
          if (
            recovered?.currentHold &&
            sameSeatRefs(recoveredSeatRefs, seatRefs)
          ) {
            completeCommand(commandKey)
            return true
          }
          if (mounted.current) {
            setFailure(parsedFailure)
            if (!parsedFailure.error.retryable) {
              setQuote(null)
            }
            setRequestState("blocked")
          }
          return false
        }
        const parsed = parseHoldCommandSuccessV1(body)
        if (
          parsed.command.commandId !== commandId ||
          parsed.command.result.kind !== "hold_claimed"
        ) {
          throw new Error("Mismatched inventory command response.")
        }
        if (applySnapshot(parsed.snapshot, sequence)) {
          setQuote(null)
          setFailure(null)
          setRequestState("ready")
        }
        completeCommand(commandKey)
        return true
      } catch {
        const recovered = await refresh()
        const recoveredSeatRefs =
          recovered?.currentHold?.items.map((item) => item.seatRef) ?? []
        if (
          recovered?.currentHold &&
          sameSeatRefs(recoveredSeatRefs, seatRefs)
        ) {
          completeCommand(commandKey)
          return true
        }
        if (mounted.current) {
          setFailure(localFailure())
          setRequestState("blocked")
        }
        return false
      }
    },
    [
      applySnapshot,
      commandIdFor,
      completeCommand,
      nextRequestSequence,
      refresh,
    ],
  )

  const runHoldCommand = useCallback(
    async (
      action: "release" | "expire",
      holdRef: PublicRef,
    ): Promise<boolean> => {
      const commandKey = `${action}:${holdRef}`
      const commandId = commandIdFor(commandKey)
      const sequence = nextRequestSequence()
      setRequestState(action === "release" ? "releasing" : "expiring")
      setFailure(null)
      try {
        const response = await postJson(
          `/api/onsale/holds/${encodeURIComponent(holdRef)}/${action}`,
          { commandId },
        )
        const body = await responseJson(response)
        if (!response.ok) {
          const parsedFailure = parseFailureOrFallback(body)
          if (!parsedFailure.error.retryable) completeCommand(commandKey)
          const recovered = await refresh()
          if (recovered !== null && recovered.currentHold === null) {
            completeCommand(commandKey)
            return true
          }
          if (action === "expire") completeCommand(commandKey)
          if (mounted.current) {
            setFailure(parsedFailure)
            setRequestState("blocked")
          }
          return false
        }
        const parsed = parseHoldCommandSuccessV1(body)
        const resultKind = parsed.command.result.kind
        const validKind =
          action === "release"
            ? resultKind === "hold_released"
            : resultKind === "hold_expired" ||
              resultKind === "hold_not_yet_expired"
        if (parsed.command.commandId !== commandId || !validKind) {
          throw new Error("Mismatched inventory command response.")
        }
        if (applySnapshot(parsed.snapshot, sequence)) {
          setQuote(null)
          setFailure(null)
          setRequestState("ready")
        }
        completeCommand(commandKey)
        return true
      } catch {
        const recovered = await refresh()
        if (recovered !== null && recovered.currentHold === null) {
          completeCommand(commandKey)
          return true
        }
        if (action === "expire") completeCommand(commandKey)
        if (mounted.current) {
          setFailure(localFailure())
          setRequestState("blocked")
        }
        return false
      }
    },
    [
      applySnapshot,
      commandIdFor,
      completeCommand,
      nextRequestSequence,
      refresh,
    ],
  )

  const releaseHold = useCallback(
    (holdRef: PublicRef) => runHoldCommand("release", holdRef),
    [runHoldCommand],
  )
  const expireHold = useCallback(
    (holdRef: PublicRef) => runHoldCommand("expire", holdRef),
    [runHoldCommand],
  )
  const clearQuote = useCallback(() => {
    latestQuoteRequest.current = null
    setQuote(null)
  }, [])
  const clearFailure = useCallback(() => setFailure(null), [])

  return {
    snapshot,
    quote,
    requestState,
    failure,
    refresh,
    quoteSeats,
    claimSeats,
    releaseHold,
    expireHold,
    clearQuote,
    clearFailure,
  }
}
