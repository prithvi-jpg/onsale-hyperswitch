import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  ONSALE_PORTLESS_NAME_ENV_V1,
  parseOnsalePortlessNameV1,
} from "../src/server/onsale-local-origin.ts"
import type { LocalPreviewModeV1 } from "./local-preview-runtime"

export type PortlessLocalTransportV1 = "http" | "https"

const ONSALE_PORTLESS_STATE_DIR_ENV_V1 =
  "ONSALE_PORTLESS_STATE_DIR" as const

function stablePortlessStateDirectoryV1(
  parentEnvironment: NodeJS.ProcessEnv,
  transport: PortlessLocalTransportV1,
): string {
  const configured = parentEnvironment[ONSALE_PORTLESS_STATE_DIR_ENV_V1]?.trim()
  if (configured) {
    const normalized = resolve(configured)
    if (normalized === "/") {
      throw new Error("ONSALE_PORTLESS_STATE_DIR cannot be the filesystem root.")
    }
    return normalized
  }
  return resolve(
    "/tmp",
    `onsale-v01-recovery-portless-v012-${transport}`,
  )
}

export function buildPortlessLocalPreviewEnvironmentV1(
  parentEnvironment: NodeJS.ProcessEnv,
  repositoryRoot: string,
  transport: PortlessLocalTransportV1 = "http",
): NodeJS.ProcessEnv {
  const portlessName = parseOnsalePortlessNameV1(
    parentEnvironment[ONSALE_PORTLESS_NAME_ENV_V1],
  )
  const stateDirectory = stablePortlessStateDirectoryV1(
    parentEnvironment,
    transport,
  )
  const environment = { ...parentEnvironment }
  for (const inheritedName of [
    "HOST",
    "PORT",
    "PORTLESS",
    "PORTLESS_APP_PORT",
    "PORTLESS_PORT",
    "PORTLESS_URL",
    "ONSALE_ALLOWED_ORIGINS",
    "ONSALE_CANONICAL_ORIGIN",
    "ONSALE_COOKIE_SECURE",
    ONSALE_PORTLESS_NAME_ENV_V1,
    ONSALE_PORTLESS_STATE_DIR_ENV_V1,
  ]) {
    delete environment[inheritedName]
  }
  return {
    ...environment,
    PORTLESS_HTTPS: transport === "https" ? "1" : "0",
    PORTLESS_LAN: "0",
    ...(transport === "http" ? { PORTLESS_PORT: "4310" } : {}),
    PORTLESS_STATE_DIR: stateDirectory,
    PORTLESS_SYNC_HOSTS: "0",
    PORTLESS_TLD: "localhost",
    [ONSALE_PORTLESS_NAME_ENV_V1]: portlessName,
  }
}

export function portlessLocalPreviewArgumentsV1(
  mode: LocalPreviewModeV1,
  _transport: PortlessLocalTransportV1 = "http",
  candidateName?: string,
): readonly string[] {
  const portlessName = parseOnsalePortlessNameV1(candidateName)
  return [
    "node_modules/portless/dist/cli.js",
    "--name",
    portlessName,
    "--",
    process.execPath,
    "scripts/local-preview-runtime.ts",
    mode,
  ]
}

export function runPortlessLocalPreviewV1(
  mode: LocalPreviewModeV1,
  transport: PortlessLocalTransportV1 = "http",
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): void {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const environment = buildPortlessLocalPreviewEnvironmentV1(
    parentEnvironment,
    repositoryRoot,
    transport,
  )
  const child = spawn(
    process.execPath,
    portlessLocalPreviewArgumentsV1(
      mode,
      transport,
      environment[ONSALE_PORTLESS_NAME_ENV_V1],
    ),
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    },
  )

  process.once("SIGINT", () => child.kill("SIGINT"))
  process.once("SIGTERM", () => child.kill("SIGTERM"))
  child.once("error", (error) => {
    console.error(`Unable to start the named ONSALE preview: ${error.message}`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1)
  })
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  const transport = process.argv[3] ?? "http"
  if (mode !== "dev" && mode !== "start") {
    throw new Error(
      "Usage: node scripts/portless-local-preview.ts {dev|start} {http|https}",
    )
  }
  if (transport !== "http" && transport !== "https") {
    throw new Error("Portless transport must be http or https.")
  }
  runPortlessLocalPreviewV1(mode, transport)
}
