import { PublicContractParseError } from "../domain/onsale-public-contract"

export const MAX_ONSALE_JSON_BYTES_V1 = 16 * 1024

export type OnsaleHttpGuardErrorKindV1 = "invalid_request" | "request_origin_denied"

export class OnsaleHttpGuardError extends Error {
  readonly kind: OnsaleHttpGuardErrorKindV1

  constructor(kind: OnsaleHttpGuardErrorKindV1) {
    super(
      kind === "request_origin_denied"
        ? "The request origin is not allowed"
        : "The request body is invalid",
    )
    this.name = "OnsaleHttpGuardError"
    this.kind = kind
  }
}

export interface HeaderReaderV1 {
  get(name: string): string | null
}

export interface JsonRequestLikeV1 {
  readonly headers: HeaderReaderV1
  readonly body: ReadableStream<Uint8Array> | null
}

function invalidRequest(): never {
  throw new OnsaleHttpGuardError("invalid_request")
}

function validateJsonHeaders(headers: HeaderReaderV1): void {
  const rawContentType = headers.get("content-type")
  if (rawContentType === null) invalidRequest()
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") invalidRequest()

  const rawLength = headers.get("content-length")
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) invalidRequest()
    const length = Number(rawLength)
    if (!Number.isSafeInteger(length) || length > MAX_ONSALE_JSON_BYTES_V1) {
      invalidRequest()
    }
  }
}

export async function readBoundedJsonV1(
  request: JsonRequestLikeV1,
): Promise<unknown> {
  validateJsonHeaders(request.headers)
  if (request.body === null) invalidRequest()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) invalidRequest()
      if (next.value.byteLength > MAX_ONSALE_JSON_BYTES_V1 - length) {
        await reader.cancel().catch(() => undefined)
        invalidRequest()
      }
      length += next.value.byteLength
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (length === 0) invalidRequest()

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(source) as unknown
  } catch {
    return invalidRequest()
  }
}

export async function parseBoundedJsonRequestV1<T>(
  request: JsonRequestLikeV1,
  parser: (value: unknown) => T,
): Promise<T> {
  const value = await readBoundedJsonV1(request)
  try {
    return parser(value)
  } catch (error) {
    if (error instanceof PublicContractParseError) invalidRequest()
    throw error
  }
}

export type ConfiguredOriginsV1 = ReadonlySet<string>

function normalizeExactHttpOrigin(
  input: string,
  failureKind: OnsaleHttpGuardErrorKindV1,
): string {
  if (input === "*" || input === "null" || input.trim() !== input) {
    throw new OnsaleHttpGuardError(failureKind)
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new OnsaleHttpGuardError(failureKind)
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin === "null"
  ) {
    throw new OnsaleHttpGuardError(failureKind)
  }
  return url.origin
}

export function parseConfiguredOriginsV1(
  inputs: readonly string[],
): ConfiguredOriginsV1 {
  if (inputs.length === 0) {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  return new Set(
    inputs.map((input) =>
      normalizeExactHttpOrigin(input, "request_origin_denied"),
    ),
  )
}

export function assertConfiguredOriginV1(
  origin: string | null | undefined,
  configuredOrigins: ConfiguredOriginsV1,
): string {
  if (origin === undefined || origin === null) {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  const normalized = normalizeExactHttpOrigin(origin, "request_origin_denied")
  if (!configuredOrigins.has(normalized)) {
    throw new OnsaleHttpGuardError("request_origin_denied")
  }
  return normalized
}

export function inventoryPrivateResponseHeadersV1(): Readonly<Record<"Cache-Control" | "Vary", string>> {
  return {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  }
}
