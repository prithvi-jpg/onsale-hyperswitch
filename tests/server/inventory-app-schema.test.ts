import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import * as inventoryAppSchemaModule from "../../src/server/inventory-app-schema"
import {
  INVENTORY_APP_MIGRATION_VERSION,
  INVENTORY_APP_MIGRATION_VERSIONS,
  INVENTORY_APP_SCHEMA,
  INVENTORY_APP_SEED_KEY,
  INVENTORY_APP_SEED_OPERATION_KEY,
  InventoryAppSchemaDriftError,
  InventoryAppSeedInvariantError,
  applyInventoryAppSchema,
  createInventoryAppSchema,
  quoteInventoryAppSchema,
  requireInventoryAppDatabaseUrl,
  type InventoryAppDatasetInspection,
  type InventoryAppDatasetSeedBoundary,
  type InventoryAppSchemaDependencies,
  type InventoryAppSqlClient,
} from "../../src/server/inventory-app-schema"

interface RecordedMigrationRow extends Record<string, unknown> {
  readonly version: string
  readonly checksum: string
}

interface RecordedQuery {
  readonly text: string
  readonly values?: readonly unknown[]
}

function queryResult<Row extends Record<string, unknown>>(
  rows: readonly Row[] = [],
  rowCount = rows.length,
) {
  return { rows: [...rows], rowCount }
}

function createDatabaseDouble(input: {
  readonly schemaExists: boolean
  readonly recordedMigrations?: readonly RecordedMigrationRow[]
  readonly controlValid?: boolean
}) {
  const queries: RecordedQuery[] = []
  let released = false
  let ended = false

  const client: InventoryAppSqlClient = {
    async query<Row extends Record<string, unknown>,>(
      text: string,
      values?: readonly unknown[],
    ) {
      queries.push({ text, values })
      if (text.includes("from pg_namespace")) {
        return queryResult([
          { exists: input.schemaExists },
        ]) as Awaited<ReturnType<InventoryAppSqlClient["query"]>> as {
          rows: Row[]
          rowCount: number | null
        }
      }
      if (text.includes("control_valid") && text.includes("schema_control")) {
        const valid = input.controlValid ?? true
        return queryResult([
          { control_valid: valid, control_exact: valid },
        ]) as Awaited<ReturnType<InventoryAppSqlClient["query"]>> as {
          rows: Row[]
          rowCount: number | null
        }
      }
      if (
        text.includes("select version, checksum") &&
        text.includes("schema_migration")
      ) {
        return queryResult(
          input.recordedMigrations ?? [],
        ) as Awaited<ReturnType<InventoryAppSqlClient["query"]>> as {
          rows: Row[]
          rowCount: number | null
        }
      }
      return queryResult() as Awaited<ReturnType<InventoryAppSqlClient["query"]>> as {
        rows: Row[]
        rowCount: number | null
      }
    },
    release() {
      released = true
    },
  }
  const dependencies: InventoryAppSchemaDependencies = {
    createPool: () => ({
      async connect() {
        return client
      },
      async end() {
        ended = true
      },
    }),
  }

  return {
    dependencies,
    queries,
    get released() {
      return released
    },
    get ended() {
      return ended
    },
  }
}

function validInspection(
  datasetId = "00000000-0000-7000-8000-000000000001",
): InventoryAppDatasetInspection {
  return {
    datasetId,
    generation: 1,
    state: "active",
    rowCount: 6,
    seatCount: 60,
    rowsWithTenSeats: 6,
    hasAdjacentFourAvailable: true,
    activeDatasetCount: 1,
  }
}

function createSeedBoundary(
  inspection: InventoryAppDatasetInspection | undefined = validInspection(),
) {
  const ensureSeeded = vi.fn(async () => ({
    replayed: false,
    datasetId: validInspection().datasetId,
  }))
  const inspectDataset = vi.fn(async () => inspection)
  const boundary: InventoryAppDatasetSeedBoundary = {
    ensureSeeded,
    inspectDataset,
  }
  return { boundary, ensureSeeded, inspectDataset }
}

async function expectedManifest(): Promise<readonly RecordedMigrationRow[]> {
  return Promise.all(
    INVENTORY_APP_MIGRATION_VERSIONS.map(async (version) => {
      const template = await readFile(
        new URL(`../../db/migrations/${version}.sql`, import.meta.url),
        "utf8",
      )
      return {
        version,
        checksum: createHash("sha256").update(template).digest("hex"),
      }
    }),
  )
}

describe("C3 persistent application schema", () => {
  it("C3-DB-APP-01 admits only the fixed literal and exposes no cleanup path", () => {
    const schema = createInventoryAppSchema(INVENTORY_APP_SCHEMA)

    expect(schema).toBe("onsale_app_v1")
    expect(quoteInventoryAppSchema(schema)).toBe('"onsale_app_v1"')
    expect(() =>
      createInventoryAppSchema("public" as typeof INVENTORY_APP_SCHEMA),
    ).toThrow(/only onsale_app_v1/u)
    expect(() =>
      quoteInventoryAppSchema("onsale_test_deadbeefdeadbeef" as never),
    ).toThrow(/only onsale_app_v1/u)
    expect(
      Object.keys(inventoryAppSchemaModule).filter((name) =>
        /drop|cleanup/iu.test(name),
      ),
    ).toEqual([])
  })

  it("C3-DB-APP-02 reads only the private server process boundary", () => {
    const databaseUrl = "postgresql://example.test/onsale"

    expect(requireInventoryAppDatabaseUrl({ DATABASE_URL: databaseUrl })).toBe(
      databaseUrl,
    )
    expect(() =>
      requireInventoryAppDatabaseUrl({
        NEXT_PUBLIC_DATABASE_URL: databaseUrl,
      }),
    ).toThrow(/DATABASE_URL/u)
    expect(() =>
      requireInventoryAppDatabaseUrl({ DATABASE_URL: "https://example.test" }),
    ).toThrow(/private Postgres DATABASE_URL/u)
  })

  it("C3-MIG-01 applies the immutable ordered manifest to a fresh namespace", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({ schemaExists: false })
    const seed = createSeedBoundary()
    const result = await applyInventoryAppSchema(
      {
        databaseUrl: "postgresql://example.test/onsale",
        dataset: seed.boundary,
      },
      database.dependencies,
    )
    const statements = database.queries.map(({ text }) => text)
    const manifestInserts = database.queries.filter(({ text }) =>
      text.includes('insert into "onsale_app_v1".schema_migration'),
    )

    expect(INVENTORY_APP_MIGRATION_VERSIONS).toEqual([
      "0001_inventory_v1",
      "0002_payment_fulfillment_v1",
    ])
    expect(INVENTORY_APP_MIGRATION_VERSION).toBe("0002_payment_fulfillment_v1")
    expect(statements).toContain('create schema "onsale_app_v1"')
    expect(
      statements.find((text) => text.includes("create table if not exists")),
    ).not.toContain("__ONSALE_SCHEMA__")
    expect(
      statements.some((text) =>
        text.includes('create table "onsale_app_v1".provider_payment'),
      ),
    ).toBe(true)
    expect(manifestInserts.map(({ values }) => values)).toEqual(
      manifest.map(({ version, checksum }) => [version, checksum]),
    )
    expect(result.migrations).toEqual(
      manifest.map((migration) => ({ ...migration, outcome: "applied" })),
    )
    expect(result).toMatchObject({
      migrationVersion: "0002_payment_fulfillment_v1",
      checksum: manifest[1]?.checksum,
      migration: "applied",
      dataset: validInspection(),
    })
    expect(seed.ensureSeeded).toHaveBeenCalledWith({
      schema: INVENTORY_APP_SCHEMA,
      seedKey: INVENTORY_APP_SEED_KEY,
      operationKey: INVENTORY_APP_SEED_OPERATION_KEY,
    })
    expect(database.released).toBe(true)
    expect(database.ended).toBe(true)
  })

  it("C3-MIG-02 upgrades an exact 0001 namespace by applying only 0002", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations: [manifest[0]!],
    })
    const seed = createSeedBoundary()
    const result = await applyInventoryAppSchema(
      {
        databaseUrl: "postgresql://example.test/onsale",
        dataset: seed.boundary,
      },
      database.dependencies,
    )
    const statements = database.queries.map(({ text }) => text)
    const manifestInserts = database.queries.filter(({ text }) =>
      text.includes('insert into "onsale_app_v1".schema_migration'),
    )

    expect(statements).not.toContain('create schema "onsale_app_v1"')
    expect(
      statements.some((text) =>
        text.includes(
          'create table if not exists "onsale_app_v1".schema_migration',
        ),
      ),
    ).toBe(false)
    expect(statements.some((text) => text.includes("provider_payment"))).toBe(
      true,
    )
    expect(manifestInserts).toHaveLength(1)
    expect(manifestInserts[0]?.values).toEqual([
      manifest[1]?.version,
      manifest[1]?.checksum,
    ])
    expect(result.migrations).toEqual([
      { ...manifest[0], outcome: "verified" },
      { ...manifest[1], outcome: "applied" },
    ])
  })

  it("C3-MIG-03 verifies the exact complete manifest without reapplying DDL", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations: manifest,
    })
    const seed = createSeedBoundary()
    const result = await applyInventoryAppSchema(
      {
        databaseUrl: "postgresql://example.test/onsale",
        dataset: seed.boundary,
      },
      database.dependencies,
    )
    const statements = database.queries.map(({ text }) => text)

    expect(result.migration).toBe("verified")
    expect(
      result.migrations.every(({ outcome }) => outcome === "verified"),
    ).toBe(true)
    expect(statements).not.toContain('create schema "onsale_app_v1"')
    expect(statements.some((text) => text.includes("create table"))).toBe(false)
  })

  it.each([
    "changed checksum",
    "missing bootstrap",
    "out of order",
    "unknown migration",
  ] as const)("C3-MIG-04 fails closed for %s", async (scenario) => {
    const manifest = await expectedManifest()
    const recordedMigrations: readonly RecordedMigrationRow[] =
      scenario === "changed checksum"
        ? [{ ...manifest[0]!, checksum: "0".repeat(64) }]
        : scenario === "missing bootstrap"
          ? [manifest[1]!]
          : scenario === "out of order"
            ? [manifest[1]!, manifest[0]!]
            : [
                ...manifest,
                { version: "9999_unknown", checksum: "f".repeat(64) },
              ]
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations,
    })
    const seed = createSeedBoundary()

    await expect(
      applyInventoryAppSchema(
        {
          databaseUrl: "postgresql://example.test/onsale",
          dataset: seed.boundary,
        },
        database.dependencies,
      ),
    ).rejects.toBeInstanceOf(InventoryAppSchemaDriftError)

    expect(database.queries.map(({ text }) => text)).toContain("rollback")
    expect(database.queries.map(({ text }) => text)).not.toContain("commit")
    expect(seed.ensureSeeded).not.toHaveBeenCalled()
  })

  it("C3-MIG-05 acquires one schema-global transaction lock before inspection", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations: manifest,
    })
    const seed = createSeedBoundary()

    await applyInventoryAppSchema(
      {
        databaseUrl: "postgresql://example.test/onsale",
        dataset: seed.boundary,
      },
      database.dependencies,
    )

    const lockIndex = database.queries.findIndex(({ text }) =>
      text.includes("pg_advisory_xact_lock"),
    )
    const namespaceIndex = database.queries.findIndex(({ text }) =>
      text.includes("from pg_namespace"),
    )
    expect(lockIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeLessThan(namespaceIndex)
    expect(database.queries[lockIndex]?.values).toEqual([
      "onsale_app_v1:apply:ordered-manifest",
    ])
  })

  it("C3-MIG-06 rejects schema-control drift before applying a pending migration", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations: [manifest[0]!],
      controlValid: false,
    })
    const seed = createSeedBoundary()

    await expect(
      applyInventoryAppSchema(
        {
          databaseUrl: "postgresql://example.test/onsale",
          dataset: seed.boundary,
        },
        database.dependencies,
      ),
    ).rejects.toBeInstanceOf(InventoryAppSchemaDriftError)

    expect(
      database.queries.some(({ text }) => text.includes("provider_payment")),
    ).toBe(false)
  })

  it("C3-SEED-01 refuses a malformed active dataset after migration", async () => {
    const manifest = await expectedManifest()
    const database = createDatabaseDouble({
      schemaExists: true,
      recordedMigrations: manifest,
    })
    const seed = createSeedBoundary({
      ...validInspection(),
      activeDatasetCount: 2,
    })

    await expect(
      applyInventoryAppSchema(
        {
          databaseUrl: "postgresql://example.test/onsale",
          dataset: seed.boundary,
        },
        database.dependencies,
      ),
    ).rejects.toBeInstanceOf(InventoryAppSeedInvariantError)
  })
})
