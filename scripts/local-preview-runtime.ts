import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  ONSALE_PORTLESS_NAME_ENV_V1,
  onsalePortlessOriginsV1,
} from "../src/server/onsale-local-origin.ts"

const REQUIRED_PRIVATE_ENVIRONMENT_NAMES_V1 = [
  "DATABASE_URL",
  "HYPERSWITCH_API_KEY",
  "HYPERSWITCH_PROFILE_ID",
  "HYPERSWITCH_PUBLISHABLE_KEY_V1",
] as const

type RequiredPrivateEnvironmentNameV1 =
  (typeof REQUIRED_PRIVATE_ENVIRONMENT_NAMES_V1)[number]

export type LocalPreviewModeV1 = "dev" | "start"

const DIRECT_LOCAL_PREVIEW_ORIGIN_V1 = "http://localhost:3102"

function decodeEnvironmentValueV1(raw: string): string {
  const value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function requiredPrivateValuesV1(
  source: string,
): Readonly<Record<RequiredPrivateEnvironmentNameV1, string>> {
  const selected = new Map<RequiredPrivateEnvironmentNameV1, string>()
  for (const line of source.split(/\r?\n/u)) {
    const normalized = line.trim().replace(/^export\s+/u, "")
    if (!normalized || normalized.startsWith("#")) continue
    const separator = normalized.indexOf("=")
    if (separator < 1) continue
    const key = normalized.slice(0, separator).trim()
    if (
      !REQUIRED_PRIVATE_ENVIRONMENT_NAMES_V1.includes(
        key as RequiredPrivateEnvironmentNameV1,
      )
    ) {
      continue
    }
    selected.set(
      key as RequiredPrivateEnvironmentNameV1,
      decodeEnvironmentValueV1(normalized.slice(separator + 1)),
    )
  }

  const result = {} as Record<RequiredPrivateEnvironmentNameV1, string>
  for (const name of REQUIRED_PRIVATE_ENVIRONMENT_NAMES_V1) {
    const value = selected.get(name)?.trim()
    if (!value) {
      throw new Error(`Private local preview environment is missing ${name}.`)
    }
    result[name] = value
  }
  if (!result.DATABASE_URL.startsWith("postgres")) {
    throw new Error("Private local preview DATABASE_URL must be PostgreSQL.")
  }
  return Object.freeze(result)
}

function exactOriginV1(raw: string, label: string): URL {
  const value = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an exact HTTP origin.`)
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value !== parsed.origin
  ) {
    throw new Error(`${label} must be an exact HTTP origin.`)
  }
  return parsed
}

function canonicalLocalPreviewOriginV1(
  environment: Readonly<Record<string, string | undefined>>,
): URL {
  const portlessUrl = environment.PORTLESS_URL?.trim()
  if (portlessUrl) {
    const parsed = exactOriginV1(portlessUrl, "Portless URL")
    const portlessOrigins = onsalePortlessOriginsV1(
      environment[ONSALE_PORTLESS_NAME_ENV_V1],
    )
    if (
      ![portlessOrigins.http, portlessOrigins.https].includes(
        parsed.origin,
      )
    ) {
      throw new Error(
        `Portless URL must be exactly ${portlessOrigins.http} or ${portlessOrigins.https}.`,
      )
    }
    const configured = environment.ONSALE_CANONICAL_ORIGIN?.trim()
    if (
      configured &&
      exactOriginV1(configured, "Canonical origin").origin !== parsed.origin
    ) {
      throw new Error("Portless URL and canonical origin must match exactly.")
    }
    return parsed
  }

  return exactOriginV1(
    environment.ONSALE_CANONICAL_ORIGIN ?? DIRECT_LOCAL_PREVIEW_ORIGIN_V1,
    "Canonical origin",
  )
}

function nextSocketPortV1(value: string | undefined): string {
  const normalized = value?.trim() || "3102"
  const port = Number(normalized)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "Local preview PORT must be an integer from 1 through 65535.",
    )
  }
  return String(port)
}

export function buildLocalPreviewEnvironmentV1(
  privateSource: string,
  parentEnvironment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const canonicalOrigin = canonicalLocalPreviewOriginV1(parentEnvironment)
  return {
    ...parentEnvironment,
    ...requiredPrivateValuesV1(privateSource),
    ONSALE_ALLOWED_ORIGINS: canonicalOrigin.origin,
    ONSALE_CANONICAL_ORIGIN: canonicalOrigin.origin,
    ONSALE_COOKIE_SECURE:
      canonicalOrigin.protocol === "https:" ? "true" : "false",
  }
}

export function localPreviewNextArgumentsV1(
  mode: LocalPreviewModeV1,
  environment: Readonly<Record<string, string | undefined>> = {},
  explicitArguments: readonly string[] = [],
): readonly string[] {
  return [
    "node_modules/next/dist/bin/next",
    mode,
    ...(mode === "dev" ? ["--webpack"] : []),
    ...(explicitArguments.length > 0
      ? explicitArguments
      : [
          "--hostname",
          environment.HOST?.trim() || "127.0.0.1",
          "--port",
          nextSocketPortV1(environment.PORT),
        ]),
  ]
}

export function runLocalPreviewV1(
  mode: LocalPreviewModeV1,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  explicitArguments: readonly string[] = [],
): void {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const sourceRoot = parentEnvironment.ONSALE_SOURCE_ROOT ?? repositoryRoot
  const privateEnvironmentFile =
    parentEnvironment.ONSALE_PRIVATE_ENV_FILE ??
    resolve(sourceRoot, "../v01/.env")
  const privateSource = readFileSync(privateEnvironmentFile, "utf8")
  const environment = buildLocalPreviewEnvironmentV1(
    privateSource,
    parentEnvironment,
  )
  const child = spawn(
    process.execPath,
    localPreviewNextArgumentsV1(mode, environment, explicitArguments),
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    },
  )

  process.once("SIGINT", () => child.kill("SIGINT"))
  process.once("SIGTERM", () => child.kill("SIGTERM"))
  child.once("error", (error) => {
    console.error(`Unable to start the local ONSALE preview: ${error.message}`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1)
  })
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode !== "dev" && mode !== "start") {
    throw new Error("Usage: node scripts/local-preview-runtime.ts {dev|start}")
  }
  runLocalPreviewV1(mode, process.env, process.argv.slice(3))
}
