import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Pool } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  INVENTORY_APP_MIGRATION_VERSIONS,
  type InventoryAppMigrationVersion,
} from "../../src/server/inventory-app-schema"
import {
  createEphemeralSchemaRun,
  createInventoryNeonSchema,
  dropInventoryNeonSchema,
  quoteEphemeralSchema,
  upgradeInventoryNeonSchema,
  type EphemeralSchemaRun,
} from "../../src/server/inventory-neon-schema"
import { loadPrivateDatabaseUrl } from "../../scripts/db/private-neon-env"

const TEST_TIMEOUT_MS = 120_000
const SCHEMA_TOKEN = "__ONSALE_SCHEMA__"
const runNeonIntegration = process.env.ONSALE_RUN_NEON_INTEGRATION === "1"
const neonDescribe = runNeonIntegration ? describe.sequential : describe.skip
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

interface MigrationReceipt {
  readonly version: InventoryAppMigrationVersion
  readonly checksum: string
  readonly sql: string
}

interface ManifestRow {
  readonly version: string
  readonly checksum: string
}

async function renderMigration(
  version: InventoryAppMigrationVersion,
  schema: string,
): Promise<MigrationReceipt> {
  const template = await readFile(fileURLToPath(migrationUrls[version]), "utf8")
  expect(template).toContain(SCHEMA_TOKEN)
  const sql = template.split(SCHEMA_TOKEN).join(quoteEphemeralSchema(schema))
  expect(sql).not.toContain(SCHEMA_TOKEN)
  return {
    version,
    checksum: createHash("sha256").update(template).digest("hex"),
    sql,
  }
}

function capabilityDigest(cleanupCapability: string): string {
  return createHash("sha256").update(cleanupCapability).digest("hex")
}

function wrongCapability(cleanupCapability: string): string {
  const replacement = cleanupCapability[0] === "0" ? "1" : "0"
  return `${replacement}${cleanupCapability.slice(1)}`
}

describe("C3 ephemeral schema local mutation boundary", () => {
  it.each(["onsale_app_v1", "public", "onsale_test_000000000000000g"])(
    "rejects non-ephemeral namespace %s before opening a pool",
    async (schema) => {
      await expect(
        upgradeInventoryNeonSchema({
          databaseUrl: "postgresql://not-used.invalid/onsale",
          schema,
          cleanupCapability: "0".repeat(64),
        }),
      ).rejects.toThrow(/schema must match/u)
    },
  )

  it("rejects a malformed cleanup capability before opening a pool", async () => {
    await expect(
      upgradeInventoryNeonSchema({
        databaseUrl: "postgresql://not-used.invalid/onsale",
        schema: "onsale_test_0000000000000000",
        cleanupCapability: "0".repeat(63),
      }),
    ).rejects.toThrow(/32-byte hex nonce/u)
  })
})

neonDescribe("C3 ephemeral payment-schema migration and cleanup proof", () => {
  let databaseUrl: string
  let pool: Pool
  const pendingCleanup = new Map<string, string>()

  async function namespaceExists(schema: string): Promise<boolean> {
    const result = await pool.query<{ exists: boolean }>(
      "select exists (select 1 from pg_namespace where nspname = $1) as exists",
      [schema],
    )
    return result.rows[0]?.exists ?? false
  }

  async function readManifest(schema: string): Promise<readonly ManifestRow[]> {
    const quotedSchema = quoteEphemeralSchema(schema)
    const result = await pool.query<ManifestRow>(
      `select version, checksum
       from ${quotedSchema}.schema_migration
       order by applied_at, version`,
    )
    return result.rows
  }

  async function tableExists(schema: string, table: string): Promise<boolean> {
    const result = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1
         from information_schema.tables
         where table_schema = $1 and table_name = $2
       ) as exists`,
      [schema, table],
    )
    return result.rows[0]?.exists ?? false
  }

  async function constraintExists(
    schema: string,
    constraint: string,
  ): Promise<boolean> {
    const result = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1
         from pg_constraint as c
         join pg_namespace as n on n.oid = c.connamespace
         where n.nspname = $1 and c.conname = $2
       ) as exists`,
      [schema, constraint],
    )
    return result.rows[0]?.exists ?? false
  }

  async function createLegacy0001Schema(
    run: EphemeralSchemaRun,
  ): Promise<MigrationReceipt> {
    const migration = await renderMigration("0001_inventory_v1", run.schema)
    const quotedSchema = quoteEphemeralSchema(run.schema)
    const client = await pool.connect()
    try {
      await client.query("begin")
      await client.query("set local statement_timeout = '30s'")
      await client.query("set local lock_timeout = '5s'")
      await client.query(`create schema ${quotedSchema}`)
      await client.query(migration.sql)
      await client.query(
        `insert into ${quotedSchema}.schema_migration (version, checksum)
         values ($1, $2)`,
        [migration.version, migration.checksum],
      )
      await client.query(
        `insert into ${quotedSchema}.schema_control (
           schema_name, cleanup_capability_digest
         ) values ($1, $2)`,
        [run.schema, capabilityDigest(run.cleanupCapability)],
      )
      await client.query("commit")
      pendingCleanup.set(run.schema, run.cleanupCapability)
      return migration
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function guardedCleanup(run: EphemeralSchemaRun): Promise<void> {
    await dropInventoryNeonSchema({
      databaseUrl,
      schema: run.schema,
      cleanupCapability: run.cleanupCapability,
    })
    pendingCleanup.delete(run.schema)
    expect(await namespaceExists(run.schema)).toBe(false)
  }

  beforeAll(() => {
    databaseUrl = loadPrivateDatabaseUrl()
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 5_000,
    })
  })

  afterAll(async () => {
    try {
      for (const [schema, cleanupCapability] of pendingCleanup) {
        await dropInventoryNeonSchema({
          databaseUrl,
          schema,
          cleanupCapability,
        })
        pendingCleanup.delete(schema)
      }
      expect(pendingCleanup.size).toBe(0)
    } finally {
      await pool?.end()
    }
  }, TEST_TIMEOUT_MS)

  it(
    "C3-MIG-NEON-01 creates the complete ordered catalog and constraints",
    async () => {
      const run = createEphemeralSchemaRun()
      const expected = await Promise.all(
        INVENTORY_APP_MIGRATION_VERSIONS.map((version) =>
          renderMigration(version, run.schema),
        ),
      )
      try {
        await createInventoryNeonSchema({
          databaseUrl,
          schema: run.schema,
          cleanupCapability: run.cleanupCapability,
        })
        pendingCleanup.set(run.schema, run.cleanupCapability)

        expect(await readManifest(run.schema)).toEqual(
          expected.map(({ version, checksum }) => ({ version, checksum })),
        )
        for (const table of [
          "provider_payment",
          "checkout_operation",
          "payment_observation",
          "payment_attempt",
          "payment_attempt_observation",
          "fulfillment_bundle",
          "ticket",
        ]) {
          expect(await tableExists(run.schema, table), table).toBe(true)
        }
        for (const constraint of [
          "order_item_identity_order_seat_unique",
          "provider_payment_order_unique",
          "provider_payment_successful_attempt_fk",
          "ticket_order_item_unique",
        ]) {
          expect(
            await constraintExists(run.schema, constraint),
            constraint,
          ).toBe(true)
        }
      } finally {
        if (pendingCleanup.has(run.schema)) await guardedCleanup(run)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-MIG-NEON-02 upgrades an exact capability-owned 0001 prefix once",
    async () => {
      const run = createEphemeralSchemaRun()
      const bootstrap = await createLegacy0001Schema(run)
      const payment = await renderMigration(
        "0002_payment_fulfillment_v1",
        run.schema,
      )
      try {
        expect(await tableExists(run.schema, "provider_payment")).toBe(false)

        await upgradeInventoryNeonSchema({
          databaseUrl,
          schema: run.schema,
          cleanupCapability: run.cleanupCapability,
        })
        await upgradeInventoryNeonSchema({
          databaseUrl,
          schema: run.schema,
          cleanupCapability: run.cleanupCapability,
        })

        expect(await readManifest(run.schema)).toEqual([
          { version: bootstrap.version, checksum: bootstrap.checksum },
          { version: payment.version, checksum: payment.checksum },
        ])
        expect(await tableExists(run.schema, "provider_payment")).toBe(true)
        expect(
          await constraintExists(
            run.schema,
            "order_item_identity_order_seat_unique",
          ),
        ).toBe(true)
      } finally {
        await guardedCleanup(run)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-MIG-NEON-03 refuses capability and manifest drift before DDL",
    async () => {
      const run = createEphemeralSchemaRun()
      const bootstrap = await createLegacy0001Schema(run)
      const quotedSchema = quoteEphemeralSchema(run.schema)
      try {
        await expect(
          upgradeInventoryNeonSchema({
            databaseUrl,
            schema: run.schema,
            cleanupCapability: wrongCapability(run.cleanupCapability),
          }),
        ).rejects.toThrow(/cleanup capability or schema control/u)
        expect(await tableExists(run.schema, "provider_payment")).toBe(false)

        await pool.query(
          `update ${quotedSchema}.schema_migration
           set checksum = $1
           where version = $2`,
          ["0".repeat(64), bootstrap.version],
        )
        await expect(
          upgradeInventoryNeonSchema({
            databaseUrl,
            schema: run.schema,
            cleanupCapability: run.cleanupCapability,
          }),
        ).rejects.toThrow(/exact nonempty migration manifest prefix/u)
        await expect(
          dropInventoryNeonSchema({
            databaseUrl,
            schema: run.schema,
            cleanupCapability: run.cleanupCapability,
          }),
        ).rejects.toThrow(/exact nonempty migration manifest prefix/u)
        expect(await namespaceExists(run.schema)).toBe(true)
        expect(await tableExists(run.schema, "provider_payment")).toBe(false)
      } finally {
        await pool.query(
          `update ${quotedSchema}.schema_migration
           set checksum = $1
           where version = $2`,
          [bootstrap.checksum, bootstrap.version],
        )
        await guardedCleanup(run)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-MIG-NEON-04 rolls back a failed suffix and cleans the intact 0001 prefix",
    async () => {
      const run = createEphemeralSchemaRun()
      const bootstrap = await createLegacy0001Schema(run)
      const quotedSchema = quoteEphemeralSchema(run.schema)
      try {
        await pool.query(
          `create table ${quotedSchema}.provider_payment (id uuid primary key)`,
        )

        await expect(
          upgradeInventoryNeonSchema({
            databaseUrl,
            schema: run.schema,
            cleanupCapability: run.cleanupCapability,
          }),
        ).rejects.toBeTruthy()

        expect(await readManifest(run.schema)).toEqual([
          { version: bootstrap.version, checksum: bootstrap.checksum },
        ])
        expect(
          await constraintExists(
            run.schema,
            "order_item_identity_order_seat_unique",
          ),
        ).toBe(false)
      } finally {
        await guardedCleanup(run)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-MIG-NEON-05 cleans an exact capability-owned 0001 prefix",
    async () => {
      const run = createEphemeralSchemaRun()
      await createLegacy0001Schema(run)

      await guardedCleanup(run)
    },
    TEST_TIMEOUT_MS,
  )
})
