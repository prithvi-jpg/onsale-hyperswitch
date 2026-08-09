import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Pool } from "@neondatabase/serverless"

const SCHEMA_TOKEN = "__ONSALE_SCHEMA__"

export const INVENTORY_APP_SCHEMA = "onsale_app_v1" as const
export const INVENTORY_APP_MIGRATION_VERSIONS = [
  "0001_inventory_v1",
  "0002_payment_fulfillment_v1",
] as const
export const INVENTORY_APP_MIGRATION_VERSION =
  "0002_payment_fulfillment_v1" as const
export const INVENTORY_APP_SEED_KEY = "onsale-app-v1" as const
export const INVENTORY_APP_SEED_OPERATION_KEY = "onsale-app-v1-seed-v3" as const

export type InventoryAppMigrationVersion = typeof INVENTORY_APP_MIGRATION_VERSIONS[number]

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

/**
 * A random digest whose preimage was discarded. It satisfies the existing
 * schema-control row shape without creating, exporting, or retaining a cleanup
 * capability. The fixed application namespace is also rejected by the separate
 * ephemeral cleanup guard.
 */
const NO_CLEANUP_CAPABILITY_DIGEST =
  "a1a470f7810fa50fce0000b9ba13337b1ad228ee62004777231a93a07e306cfe"

declare const inventoryAppSchemaBrand: unique symbol

export type InventoryAppSchema = typeof INVENTORY_APP_SCHEMA & {
  readonly [inventoryAppSchemaBrand]: "InventoryAppSchema"
}

export interface InventoryAppQueryResult<Row extends Record<string, unknown>> {
  readonly rows: Row[]
  readonly rowCount: number | null
}

export interface InventoryAppSqlClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<InventoryAppQueryResult<Row>>
  release(): void
}

export interface InventoryAppSqlPool {
  connect(): Promise<InventoryAppSqlClient>
  end(): Promise<void>
}

export interface InventoryAppMigrationTemplate {
  readonly version: InventoryAppMigrationVersion
  readonly template: string
}

export interface InventoryAppSchemaDependencies {
  readonly createPool?: (databaseUrl: string) => InventoryAppSqlPool
  readonly loadMigrationTemplates?: () => Promise<readonly InventoryAppMigrationTemplate[]>
  /** Compatibility seam for the historical 0001-only test loader. */
  readonly loadMigrationTemplate?: () => Promise<string>
}

export interface InventoryAppSeedInput {
  readonly schema: InventoryAppSchema
  readonly seedKey: typeof INVENTORY_APP_SEED_KEY
  readonly operationKey: typeof INVENTORY_APP_SEED_OPERATION_KEY
}

export interface InventoryAppSeedResult {
  readonly replayed: boolean
  readonly datasetId: string
}

export interface InventoryAppDatasetInspection {
  readonly datasetId: string
  readonly generation: number
  readonly state: "preparing" | "active" | "retired"
  readonly rowCount: number
  readonly seatCount: number
  readonly rowsWithTenSeats: number
  readonly hasAdjacentFourAvailable: boolean
  readonly activeDatasetCount: number
}

export interface InventoryAppDatasetSeedBoundary {
  ensureSeeded(input: InventoryAppSeedInput): Promise<InventoryAppSeedResult>
  inspectDataset(
    datasetId: string,
  ): Promise<InventoryAppDatasetInspection | undefined>
}

export interface ApplyInventoryAppSchemaOptions {
  readonly databaseUrl: string
  readonly dataset: InventoryAppDatasetSeedBoundary
}

export interface AppliedInventoryAppMigration {
  readonly version: InventoryAppMigrationVersion
  readonly checksum: string
  readonly outcome: "applied" | "verified"
}

export interface ApplyInventoryAppSchemaResult {
  readonly schema: InventoryAppSchema
  /** Latest migration compatibility fields. */
  readonly migrationVersion: typeof INVENTORY_APP_MIGRATION_VERSION
  readonly checksum: string
  readonly migration: "applied" | "verified"
  readonly migrations: readonly AppliedInventoryAppMigration[]
  readonly seedReplayed: boolean
  readonly dataset: InventoryAppDatasetInspection
}

export class InventoryAppSchemaDriftError extends Error {
  constructor(
    message = "The persistent inventory schema manifest has drifted.",
  ) {
    super(message)
    this.name = "InventoryAppSchemaDriftError"
  }
}

export class InventoryAppSeedInvariantError extends Error {
  constructor(
    message = "The persistent inventory dataset failed its active six-by-ten invariant.",
  ) {
    super(message)
    this.name = "InventoryAppSeedInvariantError"
  }
}

/**
 * The literal parameter is intentional: no route or generic caller chooses an
 * application namespace. Runtime validation still fails closed against casts.
 */
export function createInventoryAppSchema(
  schema: typeof INVENTORY_APP_SCHEMA,
): InventoryAppSchema {
  if (schema !== INVENTORY_APP_SCHEMA) {
    throw new Error(
      `Refusing persistent inventory namespace: only ${INVENTORY_APP_SCHEMA} is allowed.`,
    )
  }
  return schema as InventoryAppSchema
}

export function isInventoryAppSchema(
  schema: unknown,
): schema is InventoryAppSchema {
  return schema === INVENTORY_APP_SCHEMA
}

export function quoteInventoryAppSchema(
  schema: InventoryAppSchema,
): `"${typeof INVENTORY_APP_SCHEMA}"` {
  if (!isInventoryAppSchema(schema)) {
    throw new Error(
      `Refusing persistent inventory namespace: only ${INVENTORY_APP_SCHEMA} is allowed.`,
    )
  }
  return `"${INVENTORY_APP_SCHEMA}"`
}

/** Reads only the server process value supplied by the CLI/runtime boundary. */
export function requireInventoryAppDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("A private Postgres DATABASE_URL is required.")
  }
  try {
    const parsed = new URL(databaseUrl)
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      !parsed.hostname
    ) {
      throw new Error("invalid Postgres URL")
    }
  } catch {
    throw new Error("A private Postgres DATABASE_URL is required.")
  }
  return databaseUrl
}

async function loadMigrationTemplateFromDisk(
  version: InventoryAppMigrationVersion,
): Promise<string> {
  return readFile(fileURLToPath(migrationUrls[version]), "utf8")
}

async function loadMigrationTemplates(
  dependencies: InventoryAppSchemaDependencies,
): Promise<readonly InventoryAppMigrationTemplate[]> {
  if (dependencies.loadMigrationTemplates) {
    return dependencies.loadMigrationTemplates()
  }

  const legacyBootstrap = dependencies.loadMigrationTemplate
    ? await dependencies.loadMigrationTemplate()
    : await loadMigrationTemplateFromDisk("0001_inventory_v1")
  return [
    { version: "0001_inventory_v1", template: legacyBootstrap },
    {
      version: "0002_payment_fulfillment_v1",
      template: await loadMigrationTemplateFromDisk(
        "0002_payment_fulfillment_v1",
      ),
    },
  ]
}

interface RenderedMigration {
  readonly version: InventoryAppMigrationVersion
  readonly sql: string
  readonly checksum: string
}

function renderMigration(
  input: InventoryAppMigrationTemplate,
  schema: InventoryAppSchema,
): RenderedMigration {
  if (!input.template.includes(SCHEMA_TOKEN)) {
    throw new Error(`Migration ${input.version} is missing its schema token.`)
  }
  const sql = input.template
    .split(SCHEMA_TOKEN)
    .join(quoteInventoryAppSchema(schema))
  if (sql.includes(SCHEMA_TOKEN)) {
    throw new Error(
      `Migration ${input.version} retained an unresolved schema token.`,
    )
  }
  return {
    version: input.version,
    sql,
    checksum: createHash("sha256").update(input.template).digest("hex"),
  }
}

async function renderOrderedManifest(
  schema: InventoryAppSchema,
  dependencies: InventoryAppSchemaDependencies,
): Promise<readonly RenderedMigration[]> {
  const templates = await loadMigrationTemplates(dependencies)
  if (
    templates.length !== INVENTORY_APP_MIGRATION_VERSIONS.length ||
    templates.some(
      (template, index) =>
        template.version !== INVENTORY_APP_MIGRATION_VERSIONS[index],
    )
  ) {
    throw new InventoryAppSchemaDriftError(
      "The application migration source is missing, unknown, duplicated, or out of order.",
    )
  }
  return templates.map((template) => renderMigration(template, schema))
}

function createNeonPool(databaseUrl: string): InventoryAppSqlPool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 5_000,
  })
  return {
    async connect() {
      const client = await pool.connect()
      return {
        async query<Row extends Record<string, unknown>,>(
          text: string,
          values?: readonly unknown[],
        ): Promise<InventoryAppQueryResult<Row>> {
          const result = await client.query<Row>(
            text,
            values ? [...values] : undefined,
          )
          return { rows: result.rows, rowCount: result.rowCount }
        },
        release() {
          client.release()
        },
      }
    },
    async end() {
      await pool.end()
    },
  }
}

interface ExistingControlVerificationRow extends Record<string, unknown> {
  readonly control_valid: boolean
  readonly control_exact: boolean
}

interface ExistingMigrationRow extends Record<string, unknown> {
  readonly version: string
  readonly checksum: string
}

async function verifyExistingControl(
  client: InventoryAppSqlClient,
  quotedSchema: string,
): Promise<void> {
  let verification: InventoryAppQueryResult<ExistingControlVerificationRow>
  try {
    verification = await client.query<ExistingControlVerificationRow>(
      `select
         (select count(*) = 1
            and bool_and(schema_name = $1 and cleanup_capability_digest = $2)
          from ${quotedSchema}.schema_control) as control_valid,
         (select count(*) = 1
          from ${quotedSchema}.schema_control) as control_exact`,
      [INVENTORY_APP_SCHEMA, NO_CLEANUP_CAPABILITY_DIGEST],
    )
  } catch {
    throw new InventoryAppSchemaDriftError(
      "The persistent application schema exists without readable schema control.",
    )
  }
  const row = verification.rows[0]
  if (!row?.control_valid || !row.control_exact) {
    throw new InventoryAppSchemaDriftError(
      "The persistent application schema control has drifted.",
    )
  }
}

async function readExistingManifest(
  client: InventoryAppSqlClient,
  quotedSchema: string,
): Promise<readonly ExistingMigrationRow[]> {
  try {
    const result = await client.query<ExistingMigrationRow>(
      `select version, checksum
       from ${quotedSchema}.schema_migration
       order by applied_at, version`,
    )
    return result.rows
  } catch {
    throw new InventoryAppSchemaDriftError(
      "The persistent application schema exists without a readable migration manifest.",
    )
  }
}

function assertExactRecordedPrefix(
  recorded: readonly ExistingMigrationRow[],
  expected: readonly RenderedMigration[],
): void {
  if (recorded.length === 0 || recorded.length > expected.length) {
    throw new InventoryAppSchemaDriftError()
  }
  for (const [index, row] of recorded.entries()) {
    const migration = expected[index]
    if (
      !migration ||
      row.version !== migration.version ||
      row.checksum !== migration.checksum
    ) {
      throw new InventoryAppSchemaDriftError()
    }
  }
}

async function recordMigration(
  client: InventoryAppSqlClient,
  quotedSchema: string,
  migration: RenderedMigration,
): Promise<void> {
  await client.query(
    `insert into ${quotedSchema}.schema_migration (version, checksum)
     values ($1, $2)`,
    [migration.version, migration.checksum],
  )
}

function assertActiveDataset(
  seeded: InventoryAppSeedResult,
  inspection: InventoryAppDatasetInspection | undefined,
): asserts inspection is InventoryAppDatasetInspection {
  if (
    typeof seeded.replayed !== "boolean" ||
    !seeded.datasetId ||
    !inspection ||
    inspection.datasetId !== seeded.datasetId ||
    inspection.state !== "active" ||
    !Number.isSafeInteger(inspection.generation) ||
    inspection.generation < 1 ||
    inspection.rowCount !== 6 ||
    inspection.seatCount !== 60 ||
    inspection.rowsWithTenSeats !== 6 ||
    !inspection.hasAdjacentFourAvailable ||
    inspection.activeDatasetCount !== 1
  ) {
    throw new InventoryAppSeedInvariantError()
  }
}

/**
 * Apply-only bootstrap and ordered upgrade runner. It has no schema parameter,
 * down path, drop path, or cleanup capability. Historical migrations are an
 * immutable prefix; only the next fixed migration may be applied.
 */
export async function applyInventoryAppSchema(
  options: ApplyInventoryAppSchemaOptions,
  dependencies: InventoryAppSchemaDependencies = {},
): Promise<ApplyInventoryAppSchemaResult> {
  const databaseUrl = requireInventoryAppDatabaseUrl({
    DATABASE_URL: options.databaseUrl,
  })
  const schema = createInventoryAppSchema(INVENTORY_APP_SCHEMA)
  const quotedSchema = quoteInventoryAppSchema(schema)
  const manifest = await renderOrderedManifest(schema, dependencies)
  const pool = (dependencies.createPool ?? createNeonPool)(databaseUrl)
  let client: InventoryAppSqlClient | undefined
  let appliedFromIndex = 0

  try {
    client = await pool.connect()
    await client.query("begin")
    await client.query("select set_config('statement_timeout', $1, true)", [
      "30s",
    ])
    await client.query("select set_config('lock_timeout', $1, true)", ["5s"])
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 71803))",
      [`${INVENTORY_APP_SCHEMA}:apply:ordered-manifest`],
    )
    const namespace = await client.query<{ exists: boolean }>(
      "select exists (select 1 from pg_namespace where nspname = $1) as exists",
      [INVENTORY_APP_SCHEMA],
    )

    if (namespace.rows[0]?.exists) {
      await verifyExistingControl(client, quotedSchema)
      const recorded = await readExistingManifest(client, quotedSchema)
      assertExactRecordedPrefix(recorded, manifest)
      appliedFromIndex = recorded.length
    } else {
      await client.query(`create schema ${quotedSchema}`)
      appliedFromIndex = 0
    }

    for (const migration of manifest.slice(appliedFromIndex)) {
      await client.query(migration.sql)
      await recordMigration(client, quotedSchema, migration)
    }

    if (!namespace.rows[0]?.exists) {
      await client.query(
        `insert into ${quotedSchema}.schema_control (
           schema_name, cleanup_capability_digest
         ) values ($1, $2)`,
        [INVENTORY_APP_SCHEMA, NO_CLEANUP_CAPABILITY_DIGEST],
      )
    }
    await client.query("commit")
  } catch (error) {
    await client?.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client?.release()
    await pool.end()
  }

  const seeded = await options.dataset.ensureSeeded({
    schema,
    seedKey: INVENTORY_APP_SEED_KEY,
    operationKey: INVENTORY_APP_SEED_OPERATION_KEY,
  })
  const inspection = await options.dataset.inspectDataset(seeded.datasetId)
  assertActiveDataset(seeded, inspection)

  const migrations: readonly AppliedInventoryAppMigration[] = manifest.map(
    ({ version, checksum }, index) => ({
      version,
      checksum,
      outcome: index < appliedFromIndex ? "verified" : "applied",
    }),
  )
  const latest = migrations.at(-1)
  if (!latest || latest.version !== INVENTORY_APP_MIGRATION_VERSION) {
    throw new InventoryAppSchemaDriftError(
      "The latest application migration is missing from the result manifest.",
    )
  }

  return {
    schema,
    migrationVersion: INVENTORY_APP_MIGRATION_VERSION,
    checksum: latest.checksum,
    migration: migrations.some(({ outcome }) => outcome === "applied")
      ? "applied"
      : "verified",
    migrations,
    seedReplayed: seeded.replayed,
    dataset: inspection,
  }
}
