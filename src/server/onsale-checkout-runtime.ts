import { Pool } from "@neondatabase/serverless"

import {
  bindHyperswitchV1Evidence,
  HyperswitchV1Adapter,
} from "./hyperswitch-v1"
import {
  createInventoryAppSchema,
  INVENTORY_APP_SCHEMA,
  requireInventoryAppDatabaseUrl,
} from "./inventory-app-schema"
import { NeonInventoryRepository } from "./inventory-neon"
import {
  OnsaleCheckoutCoordinatorV1,
  OnsaleCheckoutRetrieveOnlyCoordinatorV1,
} from "./onsale-checkout-coordinator"
import type {
  OnsaleCheckoutRouteDependenciesV1,
  PrepareCheckoutBoundaryInputV1,
  ReconcileCheckoutBoundaryInputV1,
} from "./onsale-checkout-route-runtime"
import {
  parseConfiguredOriginsV1,
  type ConfiguredOriginsV1,
} from "./onsale-http-guards"
import {
  ONSALE_ALLOWED_ORIGINS_ENV_V1,
  ONSALE_LOCAL_PREVIEW_ORIGIN_V1,
  resolveOnsaleSecureCookieV1,
} from "./onsale-route-runtime"
import { classifyOnsaleLocalOriginV1 } from "./onsale-local-origin"
import { NeonPaymentRepository } from "./payment-neon"

export const ONSALE_CANONICAL_ORIGIN_ENV_V1 = "ONSALE_CANONICAL_ORIGIN" as const

export interface OnsaleCheckoutHttpConfigurationV1 {
  readonly configuredOrigins: ConfiguredOriginsV1
  readonly canonicalOrigin: string
  readonly cleanReturnLocation: string
  readonly providerReturnUrl: string
  readonly secureCookie: boolean
}

export type OnsaleCheckoutReturnRouteConfigurationV1 = Pick<OnsaleCheckoutHttpConfigurationV1, "configuredOrigins" | "cleanReturnLocation">

function configuredOriginsFromEnvironmentV1(
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredOriginsV1 {
  const source = environment[ONSALE_ALLOWED_ORIGINS_ENV_V1]
  if (source === undefined) {
    return parseConfiguredOriginsV1([ONSALE_LOCAL_PREVIEW_ORIGIN_V1])
  }
  return parseConfiguredOriginsV1(source.split(","))
}

/**
 * Resolves both browser and provider destinations exclusively from the server
 * environment. Request Host, forwarded headers, return queries, and browser
 * JSON never participate in either URL.
 */
export function resolveOnsaleCheckoutHttpConfigurationV1(
  environment: Readonly<Record<string, string | undefined>>,
): OnsaleCheckoutHttpConfigurationV1 {
  const configuredOrigins = configuredOriginsFromEnvironmentV1(environment)
  for (const origin of configuredOrigins) {
    const parsed = new URL(origin)
    if (
      parsed.protocol === "http:" &&
      classifyOnsaleLocalOriginV1(origin) === null
    ) {
      throw new Error(
        "Checkout HTTP origins are permitted only for loopback development.",
      )
    }
  }
  const configuredCanonical = environment[ONSALE_CANONICAL_ORIGIN_ENV_V1]
  const canonicalOrigin = (() => {
    if (configuredCanonical !== undefined && configuredCanonical !== "") {
      const normalized = [...parseConfiguredOriginsV1([configuredCanonical])][0]
      if (!normalized || !configuredOrigins.has(normalized)) {
        throw new Error(
          "ONSALE_CANONICAL_ORIGIN must be an exact member of ONSALE_ALLOWED_ORIGINS.",
        )
      }
      return normalized
    }
    if (configuredOrigins.size !== 1) {
      throw new Error(
        "ONSALE_CANONICAL_ORIGIN is required when multiple checkout origins are allowed.",
      )
    }
    const onlyOrigin = configuredOrigins.values().next().value
    if (!onlyOrigin) {
      throw new Error("A canonical checkout origin is required.")
    }
    return onlyOrigin
  })()

  const canonicalCheckoutOrigins = new Set([canonicalOrigin])
  return Object.freeze({
    configuredOrigins: canonicalCheckoutOrigins,
    canonicalOrigin,
    cleanReturnLocation: `${canonicalOrigin}/checkout`,
    providerReturnUrl: `${canonicalOrigin}/api/onsale/return`,
    secureCookie: resolveOnsaleSecureCookieV1(
      environment,
      canonicalCheckoutOrigins,
    ),
  })
}

/** Pure return-route configuration: it allocates no pool or repository. */
export function getOnsaleCheckoutReturnRouteConfigurationV1(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OnsaleCheckoutReturnRouteConfigurationV1 {
  const configuration = resolveOnsaleCheckoutHttpConfigurationV1(environment)
  return Object.freeze({
    configuredOrigins: configuration.configuredOrigins,
    cleanReturnLocation: configuration.cleanReturnLocation,
  })
}

export interface OnsaleCheckoutRuntimeInfrastructureV1 {
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
  readonly createPool: (databaseUrl: string) => Pool
}

function defaultInfrastructureV1(): OnsaleCheckoutRuntimeInfrastructureV1 {
  return {
    fetch: globalThis.fetch,
    now: () => new Date(),
    createPool: (databaseUrl) =>
      new Pool({
        connectionString: databaseUrl,
        max: 8,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 5_000,
      }),
  }
}

/**
 * Constructs one evidence-authority pair and gives its verifier only to the
 * payment repository. The attested adapter is the coordinator's sole provider
 * capability. Construction is side-effect free with respect to network/DB I/O.
 */
export function createOnsaleCheckoutRouteDependenciesV1(
  environment: Readonly<Record<string, string | undefined>>,
  infrastructure: OnsaleCheckoutRuntimeInfrastructureV1 = defaultInfrastructureV1(),
): OnsaleCheckoutRouteDependenciesV1 {
  const http = resolveOnsaleCheckoutHttpConfigurationV1(environment)
  const databaseUrl = requireInventoryAppDatabaseUrl(environment)
  const appSchema = createInventoryAppSchema(INVENTORY_APP_SCHEMA)
  const pool = infrastructure.createPool(databaseUrl)
  const inventory = new NeonInventoryRepository({
    databaseUrl,
    appSchema,
    pool,
  })
  const rawProvider = new HyperswitchV1Adapter({
    env: environment,
    fetch: infrastructure.fetch,
    now: infrastructure.now,
    allowedReturnOrigins: [...http.configuredOrigins],
  })
  const pair = bindHyperswitchV1Evidence(rawProvider)
  const payments = new NeonPaymentRepository({
    databaseUrl,
    appSchema,
    pool,
    evidenceVerifier: pair.verifier,
  })
  const prepareCoordinator = new OnsaleCheckoutCoordinatorV1({
    inventory,
    payments,
    provider: pair.adapter,
    returnUrl: http.providerReturnUrl,
  })
  const retrieveOnlyCoordinator = new OnsaleCheckoutRetrieveOnlyCoordinatorV1({
    inventory,
    payments,
    provider: pair.adapter,
  })

  return Object.freeze({
    configuredOrigins: http.configuredOrigins,
    secureCookie: http.secureCookie,
    cleanReturnLocation: http.cleanReturnLocation,
    prepare: (input: PrepareCheckoutBoundaryInputV1) =>
      prepareCoordinator.prepare(input),
    reconcile: (input: ReconcileCheckoutBoundaryInputV1) =>
      retrieveOnlyCoordinator.reconcile(input),
  })
}

let productionSingletonV1: OnsaleCheckoutRouteDependenciesV1 | undefined

export function getOnsaleCheckoutRouteDependenciesV1(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OnsaleCheckoutRouteDependenciesV1 {
  if (environment !== process.env) {
    return createOnsaleCheckoutRouteDependenciesV1(environment)
  }
  productionSingletonV1 ??= createOnsaleCheckoutRouteDependenciesV1(environment)
  return productionSingletonV1
}
