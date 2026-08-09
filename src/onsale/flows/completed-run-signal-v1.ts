import {
  parseRecordedRunRefV1,
  type RecordedRunRefV1,
} from "../contracts/recorded-run-v1"

export const COMPLETED_RUN_SIGNAL_SCHEMA_V1 =
  "onsale.completed-run.v1" as const
export const COMPLETED_RUN_CHANNEL_V1 = "onsale-completed-run-v1" as const
export const COMPLETED_RUN_STORAGE_KEY_V1 = "onsale:completed-run:v1" as const
export const COMPLETED_RUN_EVENT_V1 = "onsale:completed-run:v1" as const

export interface CompletedRunSignalV1 {
  readonly schema: typeof COMPLETED_RUN_SIGNAL_SCHEMA_V1
  readonly runRef: RecordedRunRefV1
  readonly signalId: string
}

function nextSignalId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `signal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createCompletedRunSignalV1(
  runRef: string,
  signalId = nextSignalId(),
): CompletedRunSignalV1 {
  if (
    typeof signalId !== "string" ||
    signalId.length < 1 ||
    signalId.length > 128
  ) {
    throw new TypeError("A bounded completion signal identifier is required.")
  }
  return Object.freeze({
    schema: COMPLETED_RUN_SIGNAL_SCHEMA_V1,
    runRef: parseRecordedRunRefV1(runRef),
    signalId,
  })
}

export function completedRunRefFromSignalV1(
  value: unknown,
): RecordedRunRefV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const source = value as Record<string, unknown>
  if (
    Object.keys(source).sort().join(",") !== "runRef,schema,signalId" ||
    source.schema !== COMPLETED_RUN_SIGNAL_SCHEMA_V1 ||
    typeof source.signalId !== "string" ||
    source.signalId.length < 1 ||
    source.signalId.length > 128
  ) {
    return null
  }
  try {
    return parseRecordedRunRefV1(source.runRef)
  } catch {
    return null
  }
}

export function announceCompletedRunV1(runRef: string): void {
  if (typeof window === "undefined") return
  const signal = createCompletedRunSignalV1(runRef)
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(COMPLETED_RUN_CHANNEL_V1)
      channel.postMessage(signal)
      channel.close()
    } catch {
      // Same-document and storage fallbacks remain below.
    }
  }
  try {
    window.localStorage.setItem(
      COMPLETED_RUN_STORAGE_KEY_V1,
      JSON.stringify(signal),
    )
  } catch {
    // Privacy modes may disable storage.
  }
  window.dispatchEvent(
    new CustomEvent(COMPLETED_RUN_EVENT_V1, { detail: signal }),
  )
}

export function subscribeCompletedRunsV1(
  listener: (runRef: RecordedRunRefV1) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined
  const emit = (value: unknown) => {
    const runRef = completedRunRefFromSignalV1(value)
    if (runRef !== null) listener(runRef)
  }
  const onCustom = (event: Event) => emit("detail" in event ? event.detail : null)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COMPLETED_RUN_STORAGE_KEY_V1 || event.newValue === null) {
      return
    }
    try {
      emit(JSON.parse(event.newValue) as unknown)
    } catch {
      // Ignore malformed same-origin storage.
    }
  }
  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(COMPLETED_RUN_CHANNEL_V1)
      channel.addEventListener("message", (event) => emit(event.data))
    } catch {
      channel = null
    }
  }
  window.addEventListener(COMPLETED_RUN_EVENT_V1, onCustom)
  window.addEventListener("storage", onStorage)
  return () => {
    channel?.close()
    window.removeEventListener(COMPLETED_RUN_EVENT_V1, onCustom)
    window.removeEventListener("storage", onStorage)
  }
}
