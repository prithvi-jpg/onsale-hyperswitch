import {
  RecordedRunContractErrorV1,
  parseCurrentRecordedRunV1,
  parseRecordedRunRefV1,
  parseRecordedRunTraceV1,
  parseRecordedRunsPageV1,
  summarizeRecordedRunV1,
  type CurrentRecordedRunV1,
  type RecordedRunRefV1,
  type RecordedRunSummaryV1,
  type RecordedRunTraceV1,
  type RecordedRunsPageV1,
} from "../contracts/recorded-run-v1"

export type RecordedRunsClientErrorKindV1 =
  | "denied"
  | "integrity"
  | "invalid_request"
  | "network"
  | "not_found"
  | "unavailable"

const USER_MESSAGE: Readonly<Record<RecordedRunsClientErrorKindV1, string>> = {
  denied: "This browser is not authorized to read the recorded ledger.",
  integrity:
    "A retained response failed the evidence contract and was withheld.",
  invalid_request: "The recorded-run request was rejected.",
  network:
    "The recorded ledger could not be reached. No simulation has been substituted.",
  not_found: "That retained run is not available in this review set.",
  unavailable:
    "The recorded ledger is temporarily unavailable. No simulation has been substituted.",
}

export class RecordedRunsClientErrorV1 extends Error {
  readonly kind: RecordedRunsClientErrorKindV1
  readonly status: number | null
  readonly userMessage: string

  constructor(
    kind: RecordedRunsClientErrorKindV1,
    status: number | null = null,
  ) {
    super(USER_MESSAGE[kind])
    this.name = "RecordedRunsClientErrorV1"
    this.kind = kind
    this.status = status
    this.userMessage = USER_MESSAGE[kind]
  }
}

export interface RecordedRunsFetchV1 {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export type RecordedRunsSeedV1 =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready"
      readonly page: RecordedRunsPageV1
      readonly trace: RecordedRunTraceV1
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "not_found" | "unavailable" | "integrity_error" | "error"
      readonly message: string
    }

export interface SelectedRecordedRunV1 {
  readonly summary: RecordedRunSummaryV1
  readonly trace: RecordedRunTraceV1
}

export interface ExactRecordedRunLedgerV1 extends SelectedRecordedRunV1 {
  readonly items: readonly RecordedRunSummaryV1[]
  readonly nextCursor: RecordedRunRefV1 | null
}

interface ErrorEnvelopeV1 {
  readonly schema: "onsale.recorded-runs-error.v1"
  readonly ok: false
  readonly error: {
    readonly code:
      | "INVALID_REQUEST"
      | "REQUEST_ORIGIN_DENIED"
      | "RUN_NOT_FOUND"
      | "RUN_INTEGRITY_ERROR"
      | "RUNS_UNAVAILABLE"
    readonly message: string
  }
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, init)
}

function readInit(signal?: AbortSignal): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal,
  }
}

function errorKindFromCode(
  code: ErrorEnvelopeV1["error"]["code"],
): RecordedRunsClientErrorKindV1 {
  switch (code) {
    case "INVALID_REQUEST":
      return "invalid_request"
    case "REQUEST_ORIGIN_DENIED":
      return "denied"
    case "RUN_NOT_FOUND":
      return "not_found"
    case "RUN_INTEGRITY_ERROR":
      return "integrity"
    case "RUNS_UNAVAILABLE":
      return "unavailable"
    default: {
      const exhaustive: never = code
      return exhaustive
    }
  }
}

function errorCode(value: unknown): ErrorEnvelopeV1["error"]["code"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordedRunsClientErrorV1("unavailable")
  }
  const envelope = value as Record<string, unknown>
  if (
    Object.keys(envelope).sort().join(",") !== "error,ok,schema" ||
    envelope.schema !== "onsale.recorded-runs-error.v1" ||
    envelope.ok !== false ||
    typeof envelope.error !== "object" ||
    envelope.error === null ||
    Array.isArray(envelope.error)
  ) {
    throw new RecordedRunsClientErrorV1("unavailable")
  }
  const error = envelope.error as Record<string, unknown>
  if (
    Object.keys(error).sort().join(",") !== "code,message" ||
    typeof error.message !== "string" ||
    ![
      "INVALID_REQUEST",
      "REQUEST_ORIGIN_DENIED",
      "RUN_NOT_FOUND",
      "RUN_INTEGRITY_ERROR",
      "RUNS_UNAVAILABLE",
    ].includes(String(error.code))
  ) {
    throw new RecordedRunsClientErrorV1("unavailable")
  }
  return error.code as ErrorEnvelopeV1["error"]["code"]
}

export function isRecordedRunsAbortErrorV1(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
}

async function execute<T>(
  path: string,
  parse: (value: unknown) => T,
  fetchImpl: RecordedRunsFetchV1,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(path, readInit(signal))
  } catch (error) {
    if (signal?.aborted || isRecordedRunsAbortErrorV1(error)) throw error
    throw new RecordedRunsClientErrorV1("network")
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RecordedRunsClientErrorV1(
      response.ok ? "integrity" : "unavailable",
      response.status,
    )
  }
  if (!response.ok) {
    try {
      throw new RecordedRunsClientErrorV1(
        errorKindFromCode(errorCode(body)),
        response.status,
      )
    } catch (error) {
      if (error instanceof RecordedRunsClientErrorV1) throw error
      throw new RecordedRunsClientErrorV1("unavailable", response.status)
    }
  }
  try {
    return parse(body)
  } catch {
    throw new RecordedRunsClientErrorV1("integrity", response.status)
  }
}

export async function fetchRecordedRunsPageV1({
  cursor = null,
  fetchImpl = defaultFetch,
  signal,
}: {
  readonly cursor?: string | null
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
} = {}): Promise<RecordedRunsPageV1> {
  const params = new URLSearchParams({ limit: "20" })
  if (cursor !== null) {
    params.set("cursor", parseRecordedRunRefV1(cursor, "$.cursor"))
  }
  return execute(
    `/api/onsale/ops/runs?${params.toString()}`,
    parseRecordedRunsPageV1,
    fetchImpl,
    signal,
  )
}

export async function fetchRecordedRunV1({
  runRef,
  fetchImpl = defaultFetch,
  signal,
}: {
  readonly runRef: string
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
}): Promise<RecordedRunTraceV1> {
  const safeRunRef = parseRecordedRunRefV1(runRef)
  return execute(
    `/api/onsale/ops/runs/${safeRunRef}`,
    parseRecordedRunTraceV1,
    fetchImpl,
    signal,
  )
}

export async function fetchCurrentRecordedRunV1({
  fetchImpl = defaultFetch,
  signal,
}: {
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
} = {}): Promise<CurrentRecordedRunV1> {
  return execute(
    "/api/onsale/ops/current-run",
    parseCurrentRecordedRunV1,
    fetchImpl,
    signal,
  )
}

export function assertRecordedRunMatchesSummaryV1(
  summary: RecordedRunSummaryV1,
  trace: RecordedRunTraceV1,
): void {
  const derived = summarizeRecordedRunV1(trace, summary.recordedAt)
  if (JSON.stringify(derived) !== JSON.stringify(summary)) {
    throw new RecordedRunsClientErrorV1("integrity")
  }
}

export async function fetchExactRecordedRunV1({
  runRef,
  fetchImpl = defaultFetch,
  signal,
}: {
  readonly runRef: string
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
}): Promise<SelectedRecordedRunV1> {
  const resolved = await fetchExactRecordedRunWithLedgerV1({
    runRef,
    fetchImpl,
    signal,
  })
  return { summary: resolved.summary, trace: resolved.trace }
}

export async function fetchExactRecordedRunWithLedgerV1({
  runRef,
  fetchImpl = defaultFetch,
  signal,
}: {
  readonly runRef: string
  readonly fetchImpl?: RecordedRunsFetchV1
  readonly signal?: AbortSignal
}): Promise<ExactRecordedRunLedgerV1> {
  const safeRunRef = parseRecordedRunRefV1(runRef)
  const trace = await fetchRecordedRunV1({
    runRef: safeRunRef,
    fetchImpl,
    signal,
  })
  let cursor: RecordedRunRefV1 | null = null
  const visited = new Set<RecordedRunRefV1>()
  const items: RecordedRunSummaryV1[] = []
  const known = new Set<RecordedRunRefV1>()
  while (true) {
    const page = await fetchRecordedRunsPageV1({ cursor, fetchImpl, signal })
    for (const item of page.items) {
      if (!known.has(item.runRef)) {
        known.add(item.runRef)
        items.push(item)
      }
    }
    const summary = page.items.find((item) => item.runRef === safeRunRef)
    if (summary) {
      assertRecordedRunMatchesSummaryV1(summary, trace)
      return {
        summary,
        trace,
        items,
        nextCursor: page.page.nextCursor,
      }
    }
    if (page.page.nextCursor === null) {
      throw new RecordedRunsClientErrorV1("not_found", 404)
    }
    if (visited.has(page.page.nextCursor)) {
      throw new RecordedRunsClientErrorV1("integrity")
    }
    visited.add(page.page.nextCursor)
    cursor = page.page.nextCursor
  }
}

export function recordedRunsSeedFromErrorV1(
  error: unknown,
): RecordedRunsSeedV1 {
  if (!(error instanceof RecordedRunsClientErrorV1)) {
    return { kind: "unavailable", message: USER_MESSAGE.network }
  }
  if (error.kind === "not_found") {
    return { kind: "not_found", message: error.userMessage }
  }
  if (error.kind === "integrity") {
    return { kind: "integrity_error", message: error.userMessage }
  }
  if (
    error.kind === "unavailable" ||
    error.kind === "network" ||
    error.kind === "denied"
  ) {
    return { kind: "unavailable", message: error.userMessage }
  }
  return { kind: "error", message: error.userMessage }
}

export function isRecordedRunContractErrorV1(
  error: unknown,
): error is RecordedRunContractErrorV1 {
  return error instanceof RecordedRunContractErrorV1
}
