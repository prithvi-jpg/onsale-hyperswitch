import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Pool, type PoolClient } from "@neondatabase/serverless"

import {
  INVENTORY_APP_MIGRATION_VERSIONS,
  type InventoryAppMigrationVersion,
} from "./inventory-app-schema"

const EPHEMERAL_SCHEMA_PATTERN = /^onsale_test_[0-9a-f]{16}$/
const SCHEMA_TOKEN = "__ONSALE_SCHEMA__"
const migrationUrls: Readonly<Record<InventoryAppMigrationVersion, URL>> = {
  "0001_inventory_v1": new URL(
    "../../db/migrations/0001_inventory_v1.sql",
    import.meta.url,
  ),
  "0002_payment_fulfillment_v1": new URL(
    "../../db/migrations/0002_payment_fulfillment_v1.sql",
    import.meta.url,
  ),
}

export interface InventorySchemaOptions {
  readonly databaseUrl: string
  readonly schema: string
  readonly cleanupCapability: string
}

export interface EphemeralSchemaRun {
  readonly schema: string
  readonly cleanupCapability: string
}

export function createEphemeralSchemaName(): string {
  return `onsale_test_${randomBytes(8).toString("hex")}`
}

export function createEphemeralSchemaRun(): EphemeralSchemaRun {
  return {
    schema: createEphemeralSchemaName(),
    cleanupCapability: randomBytes(32).toString("hex"),
  }
}

export function assertEphemeralSchemaName(schema: string): void {
  if (!EPHEMERAL_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      "Refusing Neon mutation: schema must match ^onsale_test_[0-9a-f]{16}$ exactly.",
    )
  }
}

export function quoteEphemeralSchema(schema: string): string {
  assertEphemeralSchemaName(schema)
  return `"${schema}"`
}

function createPool(databaseUrl: string): Pool {
  if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
    throw new Error("A private Postgres DATABASE_URL is required.")
  }
  return new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 5_000,
  })
}

function cleanupCapabilityDigest(cleanupCapability: string): string {
  if (!/^[0-9a-f]{64}$/u.test(cleanupCapability)) {
    throw new Error(
      "Refusing Neon mutation: cleanup capability must be a 32-byte hex nonce.",
    )
  }
  return createHash("sha256").update(cleanupCapability).digest("hex")
}

interface RenderedMigration {
  readonly version: InventoryAppMigrationVersion
  readonly sql: string
  readonly checksum: string
}

interface SchemaOwnershipRow {
  readonly exists: boolean
  readonly owned_by_current_role: boolean
}

interface SchemaControlRow {
  readonly schema_name: string
  readonly cleanup_capability_digest: string
}

interface RecordedMigrationRow {
  readonly version: string
  readonly checksum: string
}

async function renderMigrations(
  schema: string,
): Promise<readonly RenderedMigration[]> {
  const quotedSchema = quoteEphemeralSchema(schema)
  return Promise.all(
    INVENTORY_APP_MIGRATION_VERSIONS.map(async (version) => {
      const template = await readFile(
        fileURLToPath(migrationUrls[version]),
        "utf8",
      )
      if (!template.includes(SCHEMA_TOKEN)) {
        throw new Error(`Migration ${version} is missing its schema token.`)
      }
      const sql = template.split(SCHEMA_TOKEN).join(quotedSchema)
      if (sql.includes(SCHEMA_TOKEN)) {
        throw new Error(`Migration ${version} retained its schema token.`)
      }
      return {
        version,
        sql,
        checksum: createHash("sha256").update(template).digest("hex"),
      }
    }),
  )
}

async function acquireEphemeralManifestLock(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1::text, 71803))",
    [`${schema}:ephemeral-schema:ordered-manifest`],
  )
}

async function readSchemaOwnership(
  client: PoolClient,
  schema: string,
): Promise<SchemaOwnershipRow> {
  const ownership = await client.query<SchemaOwnershipRow>(
    `select
       exists (select 1 from pg_namespace where nspname = $1) as exists,
       coalesce((
         select nspowner = (select usesysid from pg_user where usename = current_user)
         from pg_namespace
         where nspname = $1
       ), false) as owned_by_current_role`,
    [schema],
  )
  return (
    ownership.rows[0] ?? {
      exists: false,
      owned_by_current_role: false,
    }
  )
}

async function verifySchemaControl(
  client: PoolClient,
  quotedSchema: string,
  schema: string,
  capabilityDigest: string,
  operation: "cleanup" | "upgrade",
): Promise<void> {
  let control: { readonly rows: SchemaControlRow[] }
  try {
    control = await client.query<SchemaControlRow>(
      `select schema_name, cleanup_capability_digest
       from ${quotedSchema}.schema_control
       order by schema_name
       for update`,
    )
  } catch {
    throw new Error(
      `Refusing Neon ${operation}: schema control is missing or unreadable.`,
    )
  }

  if (
    control.rows.length !== 1 ||
    control.rows[0]?.schema_name !== schema ||
    control.rows[0]?.cleanup_capability_digest !== capabilityDigest
  ) {
    throw new Error(
      `Refusing Neon ${operation}: cleanup capability or schema control does not match.`,
    )
  }
}

async function readRecordedManifest(
  client: PoolClient,
  quotedSchema: string,
  operation: "cleanup" | "upgrade",
): Promise<readonly RecordedMigrationRow[]> {
  try {
    const manifest = await client.query<RecordedMigrationRow>(
      `select version, checksum
       from ${quotedSchema}.schema_migration
       order by applied_at, version
       for update`,
    )
    return manifest.rows
  } catch {
    throw new Error(
      `Refusing Neon ${operation}: migration manifest is missing or unreadable.`,
    )
  }
}

function assertExactNonemptyManifestPrefix(
  recorded: readonly RecordedMigrationRow[],
  expected: readonly RenderedMigration[],
  operation: "cleanup" | "upgrade",
): number {
  if (
    recorded.length === 0 ||
    recorded.length > expected.length ||
    recorded.some(
      (row, index) =>
        row.version !== expected[index]?.version ||
        row.checksum !== expected[index]?.checksum,
    )
  ) {
    throw new Error(
      `Refusing Neon ${operation}: exact nonempty migration manifest prefix does not match.`,
    )
  }
  return recorded.length
}

async function recordMigration(
  client: PoolClient,
  quotedSchema: string,
  migration: RenderedMigration,
): Promise<void> {
  await client.query(
    `insert into ${quotedSchema}.schema_migration (version, checksum)
     values ($1, $2)`,
    [migration.version, migration.checksum],
  )
}

export async function createInventoryNeonSchema(
  options: InventorySchemaOptions,
): Promise<void> {
  const quotedSchema = quoteEphemeralSchema(options.schema)
  const migrations = await renderMigrations(options.schema)
  const capabilityDigest = cleanupCapabilityDigest(options.cleanupCapability)
  const pool = createPool(options.databaseUrl)
  const client = await pool.connect()

  try {
    await client.query("begin")
    await client.query("set local statement_timeout = '30s'")
    await client.query("set local lock_timeout = '5s'")
    const existing = await client.query<{ exists: boolean }>(
      "select exists (select 1 from pg_namespace where nspname = $1) as exists",
      [options.schema],
    )
    if (existing.rows[0]?.exists) {
      throw new Error(
        `Refusing Neon mutation: isolated schema ${options.schema} already exists.`,
      )
    }

    await client.query(`create schema ${quotedSchema}`)
    for (const migration of migrations) {
      await client.query(migration.sql)
      await recordMigration(client, quotedSchema, migration)
    }
    await client.query(
      `insert into ${quotedSchema}.schema_control (
         schema_name, cleanup_capability_digest
       ) values ($1, $2)`,
      [options.schema, capabilityDigest],
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

/**
 * Upgrade-only boundary for one capability-owned ephemeral test namespace.
 * The recorded migrations must be an exact nonempty prefix of the immutable
 * current manifest; only the missing suffix can be applied.
 */
export async function upgradeInventoryNeonSchema(
  options: InventorySchemaOptions,
): Promise<void> {
  const quotedSchema = quoteEphemeralSchema(options.schema)
  const migrations = await renderMigrations(options.schema)
  const capabilityDigest = cleanupCapabilityDigest(options.cleanupCapability)
  const pool = createPool(options.databaseUrl)
  const client = await pool.connect()

  try {
    await client.query("begin")
    await client.query("set local statement_timeout = '30s'")
    await client.query("set local lock_timeout = '5s'")
    await acquireEphemeralManifestLock(client, options.schema)

    const ownership = await readSchemaOwnership(client, options.schema)
    if (!ownership.exists) {
      throw new Error(
        `Refusing Neon upgrade: isolated schema ${options.schema} does not exist.`,
      )
    }
    if (!ownership.owned_by_current_role) {
      throw new Error(
        `Refusing Neon upgrade: current role does not own ${options.schema}.`,
      )
    }

    await verifySchemaControl(
      client,
      quotedSchema,
      options.schema,
      capabilityDigest,
      "upgrade",
    )
    const recorded = await readRecordedManifest(client, quotedSchema, "upgrade")
    const appliedCount = assertExactNonemptyManifestPrefix(
      recorded,
      migrations,
      "upgrade",
    )

    for (const migration of migrations.slice(appliedCount)) {
      await client.query(migration.sql)
      await recordMigration(client, quotedSchema, migration)
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function dropInventoryNeonSchema(
  options: InventorySchemaOptions,
): Promise<void> {
  const quotedSchema = quoteEphemeralSchema(options.schema)
  const migrations = await renderMigrations(options.schema)
  const capabilityDigest = cleanupCapabilityDigest(options.cleanupCapability)
  const pool = createPool(options.databaseUrl)
  const client = await pool.connect()

  try {
    await client.query("begin")
    await client.query("set local statement_timeout = '30s'")
    await client.query("set local lock_timeout = '5s'")
    await acquireEphemeralManifestLock(client, options.schema)

    const ownership = await readSchemaOwnership(client, options.schema)
    if (!ownership.exists) {
      await client.query("commit")
      return
    }
    if (!ownership.owned_by_current_role) {
      throw new Error(
        `Refusing Neon cleanup: current role does not own ${options.schema}.`,
      )
    }

    await verifySchemaControl(
      client,
      quotedSchema,
      options.schema,
      capabilityDigest,
      "cleanup",
    )
    const recorded = await readRecordedManifest(client, quotedSchema, "cleanup")
    assertExactNonemptyManifestPrefix(recorded, migrations, "cleanup")
    await client.query(`drop schema ${quotedSchema} cascade`)
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
