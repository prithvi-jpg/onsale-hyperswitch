import {
  INVENTORY_APP_SCHEMA,
  applyInventoryAppSchema,
  createInventoryAppSchema,
  requireInventoryAppDatabaseUrl,
} from "../../src/server/inventory-app-schema"
import { NeonInventoryRepository } from "../../src/server/inventory-neon"

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown failure."
  return message.replace(
    /postgres(?:ql)?:\/\/[^@\s]+@/giu,
    "postgresql://[redacted]@",
  )
}

async function main(): Promise<void> {
  // Deliberately do not read the sibling test .env file. The operator must
  // provide DATABASE_URL to this Node process for this one bounded command.
  const databaseUrl = requireInventoryAppDatabaseUrl(process.env)
  const appSchema = createInventoryAppSchema(INVENTORY_APP_SCHEMA)
  const repository = new NeonInventoryRepository({ databaseUrl, appSchema })

  try {
    const result = await applyInventoryAppSchema({
      databaseUrl,
      dataset: {
        async ensureSeeded(input) {
          if (input.schema !== appSchema) {
            throw new Error(
              "The seed boundary received an untrusted namespace.",
            )
          }
          return repository.seedDeterministicInventory({
            seedKey: input.seedKey,
            operationKey: input.operationKey,
          })
        },
        async inspectDataset(datasetId) {
          return repository.inspectDatasetGeneration(datasetId)
        },
      },
    })

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          schema: result.schema,
          migrationVersion: result.migrationVersion,
          migration: result.migration,
          checksum: result.checksum,
          migrations: result.migrations,
          seedReplayed: result.seedReplayed,
          dataset: result.dataset,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await repository.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Inventory application schema apply failed: ${safeErrorMessage(error)}\n`,
  )
  process.exitCode = 1
})
