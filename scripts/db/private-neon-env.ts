import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const privateEnvUrl = new URL("../../../v01/.env", import.meta.url)

function decodeEnvValue(raw: string): string {
  const value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Reads only DATABASE_URL from the already-gitignored sibling V1 environment.
 * Callers must never log or serialize the returned value.
 */
export function loadPrivateDatabaseUrl(): string {
  const source = readFileSync(fileURLToPath(privateEnvUrl), "utf8")
  for (const line of source.split(/\r?\n/u)) {
    const normalized = line.trim().replace(/^export\s+/u, "")
    if (!normalized || normalized.startsWith("#")) continue
    const separator = normalized.indexOf("=")
    if (separator < 1) continue
    if (normalized.slice(0, separator).trim() !== "DATABASE_URL") continue
    const value = decodeEnvValue(normalized.slice(separator + 1))
    if (value.startsWith("postgres")) return value
    break
  }
  throw new Error("Private DATABASE_URL is missing or invalid in ../v01/.env.")
}
