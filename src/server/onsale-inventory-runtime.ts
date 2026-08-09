import { requireInventoryAppDatabaseUrl } from "./inventory-app-schema"
import { OnsaleInventoryServiceV1 } from "./onsale-inventory-service"

if (typeof window !== "undefined") {
  throw new Error("The ONSALE inventory runtime is server-only.")
}

let runtimeService: OnsaleInventoryServiceV1 | undefined

export function getOnsaleInventoryServiceV1(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OnsaleInventoryServiceV1 {
  if (!runtimeService) {
    runtimeService = new OnsaleInventoryServiceV1({
      databaseUrl: requireInventoryAppDatabaseUrl(environment),
    })
  }
  return runtimeService
}
