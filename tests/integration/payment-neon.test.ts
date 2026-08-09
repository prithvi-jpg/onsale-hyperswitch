import { createHash } from "node:crypto"

import { Pool } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  normalizeHyperswitchPaymentObservationV1,
  type NormalizedPaymentObservationV1,
} from "../../src/domain/onsale-payment-v1"
import {
  createEphemeralSchemaRun,
  createInventoryNeonSchema,
  dropInventoryNeonSchema,
  quoteEphemeralSchema,
} from "../../src/server/inventory-neon-schema"
import { NeonInventoryRepository } from "../../src/server/inventory-neon"
import {
  bindHyperswitchV1Evidence,
  type HyperswitchV1AdapterPort,
  type HyperswitchV1CreateResult,
  type HyperswitchV1NotFoundReceipt,
  type HyperswitchV1ObservationReceipt,
  type HyperswitchV1RetrieveResult,
} from "../../src/server/hyperswitch-v1"
import {
  NeonPaymentRepository,
  PaymentRepositoryError,
} from "../../src/server/payment-neon"
import { loadPrivateDatabaseUrl } from "../../scripts/db/private-neon-env"

const TEST_TIMEOUT_MS = 120_000
const BARRIER_TIMEOUT_MS = 20_000
const runNeonIntegration = process.env.ONSALE_RUN_NEON_INTEGRATION === "1"
const neonDescribe = runNeonIntegration ? describe.sequential : describe.skip
const EVIDENCE_OBSERVED_AT = "2026-08-08T00:00:00.000Z"

const createEvidenceQueue: HyperswitchV1CreateResult[] = []
const retrieveEvidenceQueue: HyperswitchV1RetrieveResult[] = []
const evidenceDelegate: HyperswitchV1AdapterPort = {
  configuration: () => ({
    kind: "ready",
    provider: "hyperswitch",
    apiVersion: "v1",
    environment: "sandbox",
    publishableKeyScope: "explicit_v1_env_only",
  }),
  async createPayment() {
    const result = createEvidenceQueue.shift()
    if (!result) throw new Error("Missing fake create evidence result.")
    return result
  },
  async retrievePayment() {
    const result = retrieveEvidenceQueue.shift()
    if (!result) throw new Error("Missing fake retrieve evidence result.")
    return result
  },
}
const evidenceBinding = bindHyperswitchV1Evidence(evidenceDelegate)

let uuidCounter = 1

function nextUuid(): string {
  const suffix = (uuidCounter++).toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${suffix}`
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

interface OperationHandleExpectation {
  readonly operationId: string
  readonly operationKey: string
}

interface DeadlineRemainingRow {
  remaining_seconds: string
}

function requireServerOperation(result: {
  readonly operation: OperationHandleExpectation | null
}): OperationHandleExpectation {
  if (!result.operation) {
    throw new Error("Expected one active server checkout operation.")
  }
  return result.operation
}

function expectSameServerOperation(
  actual: OperationHandleExpectation,
  expected: OperationHandleExpectation,
): void {
  expect(actual.operationId).toBe(expected.operationId)
  expect(actual.operationKey).toBe(expected.operationKey)
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the operation to reject.")
}

async function waitForDatabaseBlock(
  pool: Pool,
  waitingBackendPid: number,
  expectedBlockerBackendPid: number,
): Promise<void> {
  const deadline = Date.now() + 10_000
  let lastBlockers: readonly number[] = []

  while (Date.now() < deadline) {
    const result = await pool.query<{ blockers: number[] }>(
      "select pg_blocking_pids($1::integer) as blockers",
      [waitingBackendPid],
    )
    lastBlockers = result.rows[0]?.blockers ?? []
    if (lastBlockers.includes(expectedBlockerBackendPid)) {
      return
    }
  }

  throw new Error(
    `Backend ${waitingBackendPid} was not observed waiting on ${expectedBlockerBackendPid}; last blockers: ${lastBlockers.join(",") || "none"}.`,
  )
}

async function waitForBarrierOrEarlyTask<T>(
  barrier: Promise<T>,
  tasks: readonly Promise<unknown>[],
  label: string,
): Promise<T> {
  const earlyTasks = tasks.map((task, index) =>
    task.then(
      () => {
        throw new Error(
          `${label}: task ${index + 1} completed before the required barrier.`,
        )
      },
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${label}: task ${index + 1} failed before the required barrier: ${detail}`,
        )
      },
    ),
  )
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `${label}: barrier did not resolve within ${BARRIER_TIMEOUT_MS}ms.`,
        ),
      )
    }, BARRIER_TIMEOUT_MS)
  })
  try {
    return await Promise.race([barrier, ...earlyTasks, timeout])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

interface OrderFixture {
  readonly orderId: string
  readonly buyerRef: string
  readonly itemCount: number
  readonly amountMinor: number
  readonly currency: string
}

interface PreparedFixture extends OrderFixture {
  readonly operationKey: string
  readonly operationRequestHash: string
  readonly providerPaymentRef: string
}

neonDescribe("C3 Neon payment and fulfillment transaction contract", () => {
  let databaseUrl: string
  const schemaRun = createEphemeralSchemaRun()
  let schemaCreated = false
  let sharedPool: Pool
  let inventory: NeonInventoryRepository
  let payments: NeonPaymentRepository
  let fixtureCounter = 0

  async function createOrderFixture(
    label: string,
    itemCount = 4,
  ): Promise<OrderFixture> {
    fixtureCounter += 1
    const unique = `${label}-${fixtureCounter}`
    const buyerRef = `buyer-${unique}`
    const seed = await inventory.seedDeterministicInventory({ seedKey: unique })
    const claim = await inventory.claimSeats({
      operationKey: `${unique}-claim`,
      eventId: seed.eventId,
      saleWindowId: seed.saleWindowId,
      buyerRef,
      seatIds: seed.adjacentSeatIds.slice(0, itemCount),
      holdForMs: 60_000,
    })
    const order = await inventory.createOrder({
      operationKey: `${unique}-order`,
      holdId: claim.holdId,
      buyerRef,
    })
    return {
      orderId: order.orderId,
      buyerRef,
      itemCount,
      amountMinor: order.totals.totalMinor,
      currency: order.totals.currency,
    }
  }

  async function setOrderDeadlineOffsetForTest(
    orderId: string,
    offsetMilliseconds: number,
  ): Promise<void> {
    const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
    const client = await sharedPool.connect()
    let triggerDisabled = false
    try {
      await client.query(
        `alter table ${quotedSchema}.orders
         disable trigger order_payment_transition_guard`,
      )
      triggerDisabled = true
      await client.query(
        `update ${quotedSchema}.orders
         set payment_deadline_at =
           clock_timestamp() + ($2::integer * interval '1 millisecond')
         where id = $1`,
        [orderId, offsetMilliseconds],
      )
    } finally {
      if (triggerDisabled) {
        await client.query(
          `alter table ${quotedSchema}.orders
           enable trigger order_payment_transition_guard`,
        )
      }
      client.release()
    }
  }

  async function prepareFixture(
    label: string,
    itemCount = 4,
  ): Promise<PreparedFixture> {
    const order = await createOrderFixture(label, itemCount)
    const operationKey = nextUuid()
    const operationRequestHash = requestHash({
      command: "ensure_checkout",
      orderId: order.orderId,
      buyerRef: order.buyerRef,
    })
    const prepared = await payments.prepareCheckout({
      operationKey,
      requestHash: operationRequestHash,
      orderId: order.orderId,
      buyerRef: order.buyerRef,
    })
    return {
      ...order,
      operationKey,
      operationRequestHash,
      providerPaymentRef: prepared.providerPaymentRef,
    }
  }

  function paymentPayload(
    prepared: PreparedFixture,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      payment_id: prepared.providerPaymentRef,
      status: "requires_payment_method",
      amount: prepared.amountMinor,
      currency: prepared.currency,
      ...overrides,
    }
  }

  function paymentTerms(prepared: OrderFixture) {
    return {
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
      itemCount: prepared.itemCount,
    }
  }

  async function attestObservation(
    prepared: PreparedFixture,
    observation: NormalizedPaymentObservationV1,
  ): Promise<HyperswitchV1ObservationReceipt> {
    if (observation.source === "create") {
      createEvidenceQueue.push({
        kind: "reconcile_required",
        observedAt: EVIDENCE_OBSERVED_AT,
        observation,
      })
      const result = await evidenceBinding.adapter.createPayment({
        merchantPaymentId: prepared.providerPaymentRef,
        terms: paymentTerms(prepared),
        returnUrl: "https://onsale.invalid/return",
        sessionExpirySeconds: 60,
        description: "ONSALE checkout",
        metadata: {},
        items: [],
      })
      if (result.kind === "uncertain") {
        throw new Error("Fake create evidence became uncertain.")
      }
      return result.evidence
    }
    retrieveEvidenceQueue.push({
      kind: "found",
      observedAt: EVIDENCE_OBSERVED_AT,
      observation,
    })
    const result = await evidenceBinding.adapter.retrievePayment({
      merchantPaymentId: prepared.providerPaymentRef,
      terms: paymentTerms(prepared),
    })
    if (result.kind !== "found") {
      throw new Error("Fake retrieve evidence was not found.")
    }
    return result.evidence
  }

  async function attestNotFound(
    prepared: PreparedFixture,
  ): Promise<HyperswitchV1NotFoundReceipt> {
    retrieveEvidenceQueue.push({
      kind: "not_found",
      observedAt: EVIDENCE_OBSERVED_AT,
    })
    const result = await evidenceBinding.adapter.retrievePayment({
      merchantPaymentId: prepared.providerPaymentRef,
      terms: paymentTerms(prepared),
    })
    if (result.kind !== "not_found") {
      throw new Error("Fake retrieve evidence was not a 404.")
    }
    return result.evidence
  }

  async function retrievedSuccess(
    prepared: PreparedFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<HyperswitchV1ObservationReceipt> {
    return attestObservation(
      prepared,
      normalizeHyperswitchPaymentObservationV1(
        paymentPayload(prepared, {
          status: "succeeded",
          payment_method: "card",
          payment_method_type: "credit",
          attempts: [
            {
              attempt_id: `attempt-${prepared.orderId}-1`,
              status: "charged",
              connector: "stripe_test",
              amount: prepared.amountMinor,
              currency: prepared.currency,
            },
          ],
          ...overrides,
        }),
        "retrieve",
      ),
    )
  }

  async function beginReconcile(
    prepared: PreparedFixture,
    label: string,
  ): Promise<string> {
    const operationKey = nextUuid()
    await payments.beginReconciliation({
      operationKey,
      requestHash: requestHash({
        command: "reconcile_payment",
        orderId: prepared.orderId,
        label,
      }),
      orderId: prepared.orderId,
      buyerRef: prepared.buyerRef,
    })
    return operationKey
  }

  async function expectSqlState55000(
    sql: string,
    values: readonly unknown[],
  ): Promise<void> {
    const client = await sharedPool.connect()
    try {
      await client.query("begin")
      const error = await rejectedValue(client.query(sql, [...values]))
      expect(error).toMatchObject({ code: "55000" })
    } finally {
      await client.query("rollback").catch(() => undefined)
      client.release()
    }
  }

  beforeAll(async () => {
    databaseUrl = loadPrivateDatabaseUrl()
    await createInventoryNeonSchema({
      databaseUrl,
      schema: schemaRun.schema,
      cleanupCapability: schemaRun.cleanupCapability,
    })
    schemaCreated = true
    sharedPool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 5_000,
    })
    inventory = new NeonInventoryRepository({
      databaseUrl,
      schema: schemaRun.schema,
      pool: sharedPool,
    })
    payments = new NeonPaymentRepository({
      databaseUrl,
      schema: schemaRun.schema,
      pool: sharedPool,
      evidenceVerifier: evidenceBinding.verifier,
    })
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    try {
      await payments?.close()
      await inventory?.close()
      if (sharedPool) {
        await expect(
          sharedPool.query("select 1 as alive"),
        ).resolves.toMatchObject({ rows: [{ alive: 1 }] })
        await sharedPool.end()
      }
    } finally {
      if (schemaCreated) {
        await dropInventoryNeonSchema({
          databaseUrl,
          schema: schemaRun.schema,
          cleanupCapability: schemaRun.cleanupCapability,
        })
      }
    }
  }, TEST_TIMEOUT_MS)

  it(
    "C3-PAY-01 prepares immutable one-to-four-item orders without returning credentials",
    async () => {
      for (const itemCount of [1, 4]) {
        const order = await createOrderFixture(`pay-01-${itemCount}`, itemCount)
        const result = await payments.prepareCheckout({
          operationKey: nextUuid(),
          requestHash: requestHash(order),
          orderId: order.orderId,
          buyerRef: order.buyerRef,
        })

        expect(result).toMatchObject({
          replayed: false,
          directive: "retrieve_same_identity",
          createState: "reconcile_required",
          orderId: order.orderId,
          amountMinor: order.amountMinor,
          currency: order.currency,
          itemCount,
        })
        expect(result.providerPaymentRef).toMatch(/^pay_[0-9a-f]{26}$/u)
        expect(JSON.stringify(result)).not.toMatch(
          /client_secret|publishable_key|api_key|authorization/iu,
        )
        expect(JSON.stringify(result)).not.toContain(
          requireServerOperation(result).operationKey,
        )
        expect(Object.keys(requireServerOperation(result))).toEqual([])
        expect((await inventory.getOrder(order.orderId))?.state).toBe(
          "payment_pending",
        )
      }

      const expired = await createOrderFixture("pay-01-expired", 2)
      await setOrderDeadlineOffsetForTest(expired.orderId, -1_000)
      await expect(
        payments.prepareCheckout({
          operationKey: nextUuid(),
          requestHash: requestHash(expired),
          orderId: expired.orderId,
          buyerRef: expired.buyerRef,
        }),
      ).rejects.toMatchObject({ code: "PAYMENT_DEADLINE_EXPIRED" })
      expect(await payments.inspectPaymentAggregate(expired.orderId)).toBe(
        undefined,
      )
      expect((await inventory.getOrder(expired.orderId))?.state).toBe(
        "awaiting_payment",
      )
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const expiredCounts = await sharedPool.query<{
        payment_count: string
        operation_count: string
      }>(
        `select
           (select count(*)::text from ${quotedSchema}.provider_payment
            where order_id = $1) as payment_count,
           (select count(*)::text from ${quotedSchema}.checkout_operation
            where order_id = $1) as operation_count`,
        [expired.orderId],
      )
      expect(expiredCounts.rows[0]).toEqual({
        payment_count: "0",
        operation_count: "0",
      })

      const tooClose = await createOrderFixture("pay-01-too-close", 2)
      await setOrderDeadlineOffsetForTest(tooClose.orderId, 30_000)
      await expect(
        payments.prepareCheckout({
          operationKey: nextUuid(),
          requestHash: requestHash(tooClose),
          orderId: tooClose.orderId,
          buyerRef: tooClose.buyerRef,
        }),
      ).rejects.toMatchObject({ code: "PAYMENT_DEADLINE_EXPIRED" })
      expect(await payments.inspectPaymentAggregate(tooClose.orderId)).toBe(
        undefined,
      )
      expect((await inventory.getOrder(tooClose.orderId))?.state).toBe(
        "awaiting_payment",
      )

      const brokenAllocation = await createOrderFixture(
        "pay-01-broken-allocation",
        2,
      )
      await sharedPool.query(
        `update ${quotedSchema}.seat_allocation
         set state = 'reservation_released', released_at = clock_timestamp()
         where order_id = $1 and state = 'reserved'`,
        [brokenAllocation.orderId],
      )
      await expect(
        payments.prepareCheckout({
          operationKey: nextUuid(),
          requestHash: requestHash(brokenAllocation),
          orderId: brokenAllocation.orderId,
          buyerRef: brokenAllocation.buyerRef,
        }),
      ).rejects.toMatchObject({ code: "ORDER_INVARIANT" })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-PAY-02 serializes concurrent preparation to one stable payment identity",
    async () => {
      const order = await createOrderFixture("pay-02")
      const commands = [1, 2].map((ordinal) => ({
        operationKey: nextUuid(),
        requestHash: requestHash({ orderId: order.orderId, ordinal }),
        orderId: order.orderId,
        buyerRef: order.buyerRef,
      }))
      let signalFirstBackend: (backendPid: number) => void
      const firstBackend = new Promise<number>((resolve) => {
        signalFirstBackend = resolve
      })
      let signalAllocated: () => void
      const allocated = new Promise<void>((resolve) => {
        signalAllocated = resolve
      })
      let releaseFirst: () => void
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            signalFirstBackend(backendPid)
          },
          async afterPaymentAllocated() {
            signalAllocated()
            await release
          },
        },
      })
      let signalSecondBackend: (backendPid: number) => void
      const secondBackend = new Promise<number>((resolve) => {
        signalSecondBackend = resolve
      })
      const secondRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            signalSecondBackend(backendPid)
          },
        },
      })
      const firstPromise = firstRepository.prepareCheckout(commands[0])
      await allocated
      const firstBackendPid = await firstBackend
      const secondPromise = secondRepository.prepareCheckout(commands[1])
      try {
        const secondBackendPid = await secondBackend
        await waitForDatabaseBlock(
          sharedPool,
          secondBackendPid,
          firstBackendPid,
        )
        releaseFirst()
        const results = await Promise.all([firstPromise, secondPromise])

        expect(new Set(results.map((result) => result.paymentId)).size).toBe(1)
        expect(
          new Set(results.map((result) => result.providerPaymentRef)).size,
        ).toBe(1)
        expect(results.map((result) => result.directive).sort()).toEqual([
          "retrieve_same_identity",
          "retrieve_same_identity",
        ])
        expect(
          new Set(
            results.map(
              (result) => requireServerOperation(result).operationKey,
            ),
          ).size,
        ).toBe(1)
        expect(results.map((result) => result.onNotFound)).toEqual([
          "authorize_create_once",
          "authorize_create_once",
        ])
        expect(results.map((result) => result.replayed).sort()).toEqual([
          false,
          true,
        ])
      } finally {
        releaseFirst()
        await firstPromise.catch(() => undefined)
        await secondPromise.catch(() => undefined)
        await firstRepository.close()
        await secondRepository.close()
      }
      const aggregate = await payments.inspectPaymentAggregate(order.orderId)
      expect(aggregate?.paymentCount).toBe(1)
      expect(aggregate?.operations).toHaveLength(1)
      expect(aggregate?.operations[0]?.operationKey).toBe(
        commands[0].operationKey,
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-PAY-03 replays one UUID operation and rejects a changed request hash",
    async () => {
      const order = await createOrderFixture("pay-03")
      const command = {
        operationKey: nextUuid(),
        requestHash: requestHash(order),
        orderId: order.orderId,
        buyerRef: order.buyerRef,
      }
      const first = await payments.prepareCheckout(command)
      const replay = await payments.prepareCheckout(command)

      expect(replay).toMatchObject({
        replayed: true,
        directive: "retrieve_same_identity",
        paymentId: first.paymentId,
        providerPaymentRef: first.providerPaymentRef,
      })
      expect(replay.operation?.operationKey).toBe(command.operationKey)
      expect(replay.onNotFound).toBe("authorize_create_once")
      const conflict = await rejectedValue(
        payments.prepareCheckout({
          ...command,
          requestHash: requestHash({ changed: true }),
        }),
      )
      expect(conflict).toBeInstanceOf(PaymentRepositoryError)
      expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })

      const reconcileOperationKey = nextUuid()
      const reconcileCommand = {
        operationKey: reconcileOperationKey,
        requestHash: requestHash({
          command: "reconcile_payment",
          orderId: order.orderId,
          version: 1,
        }),
        orderId: order.orderId,
        buyerRef: order.buyerRef,
      }
      const firstReconcile =
        await payments.beginReconciliation(reconcileCommand)
      const replayedReconcile =
        await payments.beginReconciliation(reconcileCommand)
      expect(replayedReconcile).toMatchObject({
        replayed: true,
        providerPaymentRef: first.providerPaymentRef,
      })
      expect(requireServerOperation(replayedReconcile).operationId).toBe(
        requireServerOperation(firstReconcile).operationId,
      )
      expect(firstReconcile.onNotFound).toBe("block_recreate")
      const reconcileFixture: PreparedFixture = {
        ...order,
        operationKey: command.operationKey,
        operationRequestHash: command.requestHash,
        providerPaymentRef: first.providerPaymentRef,
      }
      await payments.applyObservation({
        operationKey: requireServerOperation(firstReconcile).operationKey,
        orderId: order.orderId,
        buyerRef: order.buyerRef,
        observation: await attestObservation(
          reconcileFixture,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(reconcileFixture, { status: "processing" }),
            "retrieve",
          ),
        ),
      })
      const terminalReconcileReplay =
        await payments.beginReconciliation(reconcileCommand)
      expect(terminalReconcileReplay).toMatchObject({
        replayed: true,
        directive: "replay_terminal",
        operation: null,
        onNotFound: null,
      })
      await expect(
        payments.beginReconciliation({
          ...reconcileCommand,
          requestHash: requestHash({
            command: "reconcile_payment",
            orderId: order.orderId,
            version: 2,
          }),
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-PAY-04 authorizes one create after attested 404 and recovers conservatively",
    async () => {
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const prepared = await prepareFixture("pay-04")
      const forgedNotFound = {
        kind: "retrieve_not_found",
      } as unknown as HyperswitchV1NotFoundReceipt
      await expect(
        payments.recordPreCreateNotFound({
          operationKey: prepared.operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          evidence: forgedNotFound,
        }),
      ).rejects.toBeInstanceOf(TypeError)

      const notFoundEvidence = await attestNotFound(prepared)
      const remainingBeforeAuthorization = await sharedPool.query<DeadlineRemainingRow>(
        `select floor(extract(epoch from (
           payment_deadline_at - clock_timestamp()
         )))::bigint::text as remaining_seconds
         from ${quotedSchema}.orders
         where id = $1`,
        [prepared.orderId],
      )
      const reset = await payments.recordPreCreateNotFound({
        operationKey: prepared.operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        evidence: notFoundEvidence,
      })
      expect(reset).toMatchObject({
        replayed: false,
        directive: "create_same_identity",
        createState: "reconcile_required",
        providerPaymentRef: prepared.providerPaymentRef,
      })
      expect(reset.onNotFound).toBe("block_recreate")
      if (reset.directive !== "create_same_identity") {
        throw new Error("Expected one fresh provider create authorization.")
      }
      expect(reset.providerSessionExpirySeconds).toBeGreaterThanOrEqual(1)
      expect(reset.providerSessionExpirySeconds).toBeLessThanOrEqual(900)
      expect(reset.providerSessionExpirySeconds).toBeLessThanOrEqual(
        Number(
          remainingBeforeAuthorization.rows[0]?.remaining_seconds ?? -1,
        ) - 31,
      )
      const resetOperation = requireServerOperation(reset)
      const replay = await payments.recordPreCreateNotFound({
        operationKey: prepared.operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        evidence: notFoundEvidence,
      })
      expect(replay).toMatchObject({
        replayed: true,
        directive: "retrieve_same_identity",
        createState: "reconcile_required",
      })
      expectSameServerOperation(requireServerOperation(replay), resetOperation)
      expect(replay.onNotFound).toBe("block_recreate")

      const createObservation = await attestObservation(
        prepared,
        normalizeHyperswitchPaymentObservationV1(
          paymentPayload(prepared),
          "create",
        ),
      )
      await expect(
        payments.applyObservation({
          operationKey: prepared.operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          observation: createObservation,
        }),
      ).rejects.toMatchObject({ code: "OBSERVATION_SOURCE_MISMATCH" })
      await payments.applyObservation({
        operationKey: resetOperation.operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: createObservation,
      })
      const reconcileOperationKey = await beginReconcile(
        prepared,
        "pay-04-after-observation",
      )
      const refused = await payments.recordPreCreateNotFound({
        operationKey: reconcileOperationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        evidence: await attestNotFound(prepared),
      })
      expect(refused).toMatchObject({
        directive: "replay_terminal",
        operation: null,
        reason: null,
      })

      const crashBeforePost = await prepareFixture("pay-04-crash-before-post")
      const crashBeforeEvidence = await attestNotFound(crashBeforePost)
      const beforeFirst = await payments.recordPreCreateNotFound({
        operationKey: crashBeforePost.operationKey,
        orderId: crashBeforePost.orderId,
        buyerRef: crashBeforePost.buyerRef,
        evidence: crashBeforeEvidence,
      })
      const beforeReplay = await payments.recordPreCreateNotFound({
        operationKey: crashBeforePost.operationKey,
        orderId: crashBeforePost.orderId,
        buyerRef: crashBeforePost.buyerRef,
        evidence: crashBeforeEvidence,
      })
      expect(beforeFirst.directive).toBe("create_same_identity")
      const beforeSuccessor = requireServerOperation(beforeFirst)
      expect(beforeReplay).toMatchObject({
        directive: "retrieve_same_identity",
        onNotFound: "block_recreate",
      })
      expectSameServerOperation(
        requireServerOperation(beforeReplay),
        beforeSuccessor,
      )
      const beforePrepareReplay = await payments.prepareCheckout({
        operationKey: crashBeforePost.operationKey,
        requestHash: crashBeforePost.operationRequestHash,
        orderId: crashBeforePost.orderId,
        buyerRef: crashBeforePost.buyerRef,
      })
      expect(beforePrepareReplay).toMatchObject({
        directive: "retrieve_same_identity",
        onNotFound: "block_recreate",
      })
      expectSameServerOperation(
        requireServerOperation(beforePrepareReplay),
        beforeSuccessor,
      )
      const beforeSecond = await payments.recordPreCreateNotFound({
        operationKey: beforeSuccessor.operationKey,
        orderId: crashBeforePost.orderId,
        buyerRef: crashBeforePost.buyerRef,
        evidence: await attestNotFound(crashBeforePost),
      })
      expect(beforeSecond).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "provider_create_reauthorization_blocked",
        createState: "reconcile_required",
      })
      const beforeAggregate = await payments.inspectPaymentAggregate(
        crashBeforePost.orderId,
      )
      expect(beforeAggregate?.paymentCount).toBe(1)
      expect(beforeAggregate?.operations).toHaveLength(2)

      const concurrentNotFound = await prepareFixture(
        "pay-04-concurrent-not-found",
      )
      const concurrentEvidence = await Promise.all([
        attestNotFound(concurrentNotFound),
        attestNotFound(concurrentNotFound),
      ])
      let markFirstBackend = (_backendPid: number): void => undefined
      const firstBackend = new Promise<number>((resolve) => {
        markFirstBackend = resolve
      })
      let markFirstLocked = (): void => undefined
      const firstLocked = new Promise<void>((resolve) => {
        markFirstLocked = resolve
      })
      let releaseFirst = (): void => undefined
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstNotFoundRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            markFirstBackend(backendPid)
          },
          async afterPreCreateNotFoundLocked() {
            markFirstLocked()
            await firstRelease
          },
        },
      })
      let markSecondBackend = (_backendPid: number): void => undefined
      const secondBackend = new Promise<number>((resolve) => {
        markSecondBackend = resolve
      })
      const secondNotFoundRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            markSecondBackend(backendPid)
          },
        },
      })
      const concurrentInput = {
        operationKey: concurrentNotFound.operationKey,
        orderId: concurrentNotFound.orderId,
        buyerRef: concurrentNotFound.buyerRef,
      }
      let firstNotFoundPromise:
        | ReturnType<
            NeonPaymentRepository["recordPreCreateNotFound"]
          >
        | undefined
      let secondNotFoundPromise:
        | ReturnType<
            NeonPaymentRepository["recordPreCreateNotFound"]
          >
        | undefined
      let authorizedSuccessor: OperationHandleExpectation | undefined
      try {
        firstNotFoundPromise =
          firstNotFoundRepository.recordPreCreateNotFound({
            ...concurrentInput,
            evidence: concurrentEvidence[0],
          })
        await waitForBarrierOrEarlyTask(
          firstLocked,
          [firstNotFoundPromise],
          "First not-found lock barrier",
        )
        const firstBackendPid = await waitForBarrierOrEarlyTask(
          firstBackend,
          [firstNotFoundPromise],
          "First not-found backend barrier",
        )
        secondNotFoundPromise =
          secondNotFoundRepository.recordPreCreateNotFound({
            ...concurrentInput,
            evidence: concurrentEvidence[1],
          })
        const secondBackendPid = await waitForBarrierOrEarlyTask(
          secondBackend,
          [secondNotFoundPromise],
          "Second not-found backend barrier",
        )
        await waitForBarrierOrEarlyTask(
          waitForDatabaseBlock(
            sharedPool,
            secondBackendPid,
            firstBackendPid,
          ),
          [firstNotFoundPromise, secondNotFoundPromise],
          "Concurrent not-found database-block barrier",
        )
        releaseFirst()
        const [winner, loser] = await Promise.all([
          firstNotFoundPromise,
          secondNotFoundPromise,
        ])
        expect(winner).toMatchObject({
          replayed: false,
          directive: "create_same_identity",
          onNotFound: "block_recreate",
        })
        expect(loser).toMatchObject({
          replayed: true,
          directive: "retrieve_same_identity",
          onNotFound: "block_recreate",
        })
        authorizedSuccessor = requireServerOperation(winner)
        expectSameServerOperation(
          requireServerOperation(loser),
          authorizedSuccessor,
        )
      } finally {
        releaseFirst()
        const tasks = [firstNotFoundPromise, secondNotFoundPromise].filter(
          (task): task is NonNullable<typeof task> => task !== undefined,
        )
        await Promise.allSettled(tasks)
        await Promise.allSettled([
          firstNotFoundRepository.close(),
          secondNotFoundRepository.close(),
        ])
      }
      if (!authorizedSuccessor) {
        throw new Error("Expected one authorized concurrent successor.")
      }
      const blockedThirdAuthorization =
        await payments.recordPreCreateNotFound({
          ...concurrentInput,
          operationKey: authorizedSuccessor.operationKey,
          evidence: await attestNotFound(concurrentNotFound),
        })
      expect(blockedThirdAuthorization).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "provider_create_reauthorization_blocked",
      })
      const concurrentAggregate = await payments.inspectPaymentAggregate(
        concurrentNotFound.orderId,
      )
      expect(concurrentAggregate?.paymentCount).toBe(1)
      expect(concurrentAggregate?.operations).toHaveLength(2)
      expect(
        concurrentAggregate?.operations.every(
          (operation) => operation.commandKind === "ensure_checkout",
        ),
      ).toBe(true)
      expect(
        concurrentAggregate?.operations.filter(
          (operation) => operation.outcomeCode === "provider_not_found",
        ),
      ).toHaveLength(1)

      const expiredAfterPrepareOrder = await createOrderFixture(
        "pay-04-expired-after-prepare",
      )
      const expiredAfterPrepareCommand = {
        operationKey: nextUuid(),
        requestHash: requestHash({
          command: "ensure_checkout",
          orderId: expiredAfterPrepareOrder.orderId,
          reason: "deadline-recovery",
        }),
        orderId: expiredAfterPrepareOrder.orderId,
        buyerRef: expiredAfterPrepareOrder.buyerRef,
      }
      const expiredAfterPrepareResult = await payments.prepareCheckout(
        expiredAfterPrepareCommand,
      )
      const expiredAfterPrepare: PreparedFixture = {
        ...expiredAfterPrepareOrder,
        operationKey: expiredAfterPrepareCommand.operationKey,
        operationRequestHash: expiredAfterPrepareCommand.requestHash,
        providerPaymentRef: expiredAfterPrepareResult.providerPaymentRef,
      }
      await setOrderDeadlineOffsetForTest(
        expiredAfterPrepare.orderId,
        1_000,
      )
      await sharedPool.query("select pg_sleep(1.2)")
      const lateNotFound = await payments.recordPreCreateNotFound({
        operationKey: expiredAfterPrepare.operationKey,
        orderId: expiredAfterPrepare.orderId,
        buyerRef: expiredAfterPrepare.buyerRef,
        evidence: await attestNotFound(expiredAfterPrepare),
      })
      expect(lateNotFound).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "payment_deadline_expired",
      })
      const latePrepareReplay = await payments.prepareCheckout(
        expiredAfterPrepareCommand,
      )
      expect(latePrepareReplay).toMatchObject({
        replayed: true,
        directive: "retrieve_same_identity",
        onNotFound: "block_recreate",
      })
      expect(requireServerOperation(latePrepareReplay).operationKey).toBe(
        expiredAfterPrepare.operationKey,
      )
      const lateAggregate = await payments.inspectPaymentAggregate(
        expiredAfterPrepare.orderId,
      )
      expect(lateAggregate?.paymentCount).toBe(1)
      expect(lateAggregate?.operations).toHaveLength(1)
      expect((await inventory.getOrder(expiredAfterPrepare.orderId))?.state).toBe(
        "payment_pending",
      )

      const crashAfterPost = await prepareFixture("pay-04-crash-after-post")
      const crashAfterEvidence = await attestNotFound(crashAfterPost)
      const afterFirst = await payments.recordPreCreateNotFound({
        operationKey: crashAfterPost.operationKey,
        orderId: crashAfterPost.orderId,
        buyerRef: crashAfterPost.buyerRef,
        evidence: crashAfterEvidence,
      })
      const afterReplay = await payments.prepareCheckout({
        operationKey: crashAfterPost.operationKey,
        requestHash: crashAfterPost.operationRequestHash,
        orderId: crashAfterPost.orderId,
        buyerRef: crashAfterPost.buyerRef,
      })
      expect(afterReplay).toMatchObject({
        directive: "retrieve_same_identity",
        onNotFound: "block_recreate",
      })
      expectSameServerOperation(
        requireServerOperation(afterReplay),
        requireServerOperation(afterFirst),
      )
      const recovered = await payments.applyObservation({
        operationKey: requireServerOperation(afterReplay).operationKey,
        orderId: crashAfterPost.orderId,
        buyerRef: crashAfterPost.buyerRef,
        observation: await retrievedSuccess(crashAfterPost),
      })
      expect(recovered).toMatchObject({
        canonicalState: "succeeded",
        orderState: "fulfilled",
        ticketCount: crashAfterPost.itemCount,
      })
      const terminalReplay = await payments.prepareCheckout({
        operationKey: crashAfterPost.operationKey,
        requestHash: crashAfterPost.operationRequestHash,
        orderId: crashAfterPost.orderId,
        buyerRef: crashAfterPost.buyerRef,
      })
      expect(terminalReplay).toMatchObject({
        replayed: true,
        directive: "replay_terminal",
        operation: null,
        onNotFound: null,
      })

      const missingLineage = await prepareFixture("pay-04-missing-lineage")
      await sharedPool.query(
        `update ${quotedSchema}.checkout_operation
         set state = 'completed', outcome_code = 'provider_not_found',
             completed_at = clock_timestamp()
         where operation_key = $1 and state = 'started'`,
        [missingLineage.operationKey],
      )
      const missingLineageReplay = await payments.prepareCheckout({
        operationKey: missingLineage.operationKey,
        requestHash: missingLineage.operationRequestHash,
        orderId: missingLineage.orderId,
        buyerRef: missingLineage.buyerRef,
      })
      expect(missingLineageReplay).toMatchObject({
        directive: "blocked_integrity",
        operation: null,
        reason: "operation_lineage_invalid",
      })

      const reviewAfterReconcile = await prepareFixture(
        "pay-04-review-after-reconcile-start",
      )
      const startedReconcileCommand = {
        operationKey: nextUuid(),
        requestHash: requestHash({
          command: "reconcile_payment",
          orderId: reviewAfterReconcile.orderId,
          reason: "started-before-review",
        }),
        orderId: reviewAfterReconcile.orderId,
        buyerRef: reviewAfterReconcile.buyerRef,
      }
      const startedReconcile = await payments.beginReconciliation(
        startedReconcileCommand,
      )
      expect(startedReconcile).toMatchObject({
        replayed: false,
        directive: "retrieve_same_identity",
        onNotFound: "block_recreate",
      })
      await payments.applyObservation({
        operationKey: reviewAfterReconcile.operationKey,
        orderId: reviewAfterReconcile.orderId,
        buyerRef: reviewAfterReconcile.buyerRef,
        observation: await retrievedSuccess(reviewAfterReconcile, {
          amount: reviewAfterReconcile.amountMinor + 1,
        }),
      })
      const terminalizedReconcile = await payments.beginReconciliation(
        startedReconcileCommand,
      )
      const stableTerminalizedReconcile = await payments.beginReconciliation(
        startedReconcileCommand,
      )
      expect(terminalizedReconcile).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "integrity_review_required",
      })
      expect(stableTerminalizedReconcile).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "integrity_review_required",
      })
      await expect(
        payments.beginReconciliation({
          ...startedReconcileCommand,
          requestHash: requestHash({ changed: "after-review" }),
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
      const reviewAfterReconcileAggregate =
        await payments.inspectPaymentAggregate(reviewAfterReconcile.orderId)
      expect(reviewAfterReconcileAggregate?.operations).toContainEqual({
        operationKey: startedReconcileCommand.operationKey,
        commandKind: "reconcile_payment",
        state: "rejected",
        outcomeCode: "integrity_review_required",
      })

      const reviewBlocked = await prepareFixture("pay-04-review-blocked")
      await payments.applyObservation({
        operationKey: reviewBlocked.operationKey,
        orderId: reviewBlocked.orderId,
        buyerRef: reviewBlocked.buyerRef,
        observation: await retrievedSuccess(reviewBlocked, {
          amount: reviewBlocked.amountMinor + 1,
        }),
      })
      const blockedPrepare = await payments.prepareCheckout({
        operationKey: reviewBlocked.operationKey,
        requestHash: reviewBlocked.operationRequestHash,
        orderId: reviewBlocked.orderId,
        buyerRef: reviewBlocked.buyerRef,
      })
      expect(blockedPrepare).toMatchObject({
        directive: "blocked_integrity",
        operation: null,
        reason: "integrity_review_required",
      })

      const reviewReconcileCommand = {
        operationKey: nextUuid(),
        requestHash: requestHash({
          command: "reconcile_payment",
          orderId: reviewBlocked.orderId,
          reason: "review-gate",
        }),
        orderId: reviewBlocked.orderId,
        buyerRef: reviewBlocked.buyerRef,
      }
      const blockedReconcile = await payments.beginReconciliation(
        reviewReconcileCommand,
      )
      const blockedReconcileReplay = await payments.beginReconciliation(
        reviewReconcileCommand,
      )
      expect(blockedReconcile).toMatchObject({
        replayed: false,
        directive: "blocked_integrity",
        operation: null,
        reason: "integrity_review_required",
      })
      expect(blockedReconcileReplay).toMatchObject({
        replayed: true,
        directive: "blocked_integrity",
        operation: null,
        reason: "integrity_review_required",
      })
      await expect(
        payments.beginReconciliation({
          ...reviewReconcileCommand,
          requestHash: requestHash({ changed: true }),
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
      const reviewAggregate = await payments.inspectPaymentAggregate(
        reviewBlocked.orderId,
      )
      expect(reviewAggregate?.operations).toContainEqual({
        operationKey: reviewReconcileCommand.operationKey,
        commandKind: "reconcile_payment",
        state: "rejected",
        outcomeCode: "integrity_review_required",
      })
    },
    TEST_TIMEOUT_MS * 2,
  )

  it(
    "C3-PAY-05 serializes cancel-first and payment-first races without a canceled paid identity",
    async () => {
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)

      const cancelFirst = await createOrderFixture("pay-05-cancel-first")
      const cancelFirstClient = await sharedPool.connect()
      let cancelFirstPrepare: Promise<unknown> | undefined
      let cancelFirstRepository: NeonPaymentRepository | undefined
      try {
        await cancelFirstClient.query("begin")
        const cancelBackend = await cancelFirstClient.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        )
        const cancelBackendPid = cancelBackend.rows[0]?.pid
        if (!Number.isInteger(cancelBackendPid)) {
          throw new Error("Could not resolve cancel-first backend PID.")
        }
        await cancelFirstClient.query(
          `select id from ${quotedSchema}.orders where id = $1 for update`,
          [cancelFirst.orderId],
        )
        const canceled = await cancelFirstClient.query(
          `update ${quotedSchema}.orders
           set state = 'canceled', canceled_at = clock_timestamp(),
               version = version + 1
           where id = $1 and state = 'awaiting_payment'`,
          [cancelFirst.orderId],
        )
        expect(canceled.rowCount).toBe(1)
        let resolvePrepareBackend: (backendPid: number) => void
        const prepareBackend = new Promise<number>((resolve) => {
          resolvePrepareBackend = resolve
        })
        cancelFirstRepository = new NeonPaymentRepository({
          databaseUrl,
          schema: schemaRun.schema,
          pool: sharedPool,
          evidenceVerifier: evidenceBinding.verifier,
          faultInjector: {
            onTransactionBackend(backendPid) {
              resolvePrepareBackend(backendPid)
            },
          },
        })
        cancelFirstPrepare = rejectedValue(
          cancelFirstRepository.prepareCheckout({
            operationKey: nextUuid(),
            requestHash: requestHash({ orderId: cancelFirst.orderId }),
            orderId: cancelFirst.orderId,
            buyerRef: cancelFirst.buyerRef,
          }),
        )
        const prepareBackendPid = await prepareBackend
        await waitForDatabaseBlock(
          sharedPool,
          prepareBackendPid,
          cancelBackendPid,
        )
        await cancelFirstClient.query("commit")
        expect(await cancelFirstPrepare).toMatchObject({
          code: "ORDER_NOT_PAYABLE",
        })
      } finally {
        await cancelFirstClient.query("rollback").catch(() => undefined)
        cancelFirstClient.release()
        await cancelFirstPrepare?.catch(() => undefined)
        await cancelFirstRepository?.close()
      }
      expect((await inventory.getOrder(cancelFirst.orderId))?.state).toBe(
        "canceled",
      )
      expect(
        await payments.inspectPaymentAggregate(cancelFirst.orderId),
      ).toBeUndefined()

      const paymentFirst = await createOrderFixture("pay-05-payment-first")
      let signalAllocated: () => void
      let releasePayment: () => void
      const allocated = new Promise<void>((resolve) => {
        signalAllocated = resolve
      })
      const release = new Promise<void>((resolve) => {
        releasePayment = resolve
      })
      let signalPaymentBackend: (backendPid: number) => void
      const paymentBackend = new Promise<number>((resolve) => {
        signalPaymentBackend = resolve
      })
      const barrierRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            signalPaymentBackend(backendPid)
          },
          async afterPaymentAllocated() {
            signalAllocated()
            await release
          },
        },
      })
      const paymentPromise = barrierRepository.prepareCheckout({
        operationKey: nextUuid(),
        requestHash: requestHash({ orderId: paymentFirst.orderId }),
        orderId: paymentFirst.orderId,
        buyerRef: paymentFirst.buyerRef,
      })
      await allocated
      const paymentBackendPid = await paymentBackend
      const cancelSecondClient = await sharedPool.connect()
      let blockedCancel: Promise<unknown> | undefined
      try {
        await cancelSecondClient.query("begin")
        const cancelBackend = await cancelSecondClient.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        )
        const cancelBackendPid = cancelBackend.rows[0]?.pid
        if (!Number.isInteger(cancelBackendPid)) {
          throw new Error("Could not resolve payment-first cancel backend PID.")
        }
        blockedCancel = rejectedValue(
          cancelSecondClient.query(
            `update ${quotedSchema}.orders
             set state = 'canceled', canceled_at = clock_timestamp(),
                 version = version + 1
             where id = $1`,
            [paymentFirst.orderId],
          ),
        )
        await waitForDatabaseBlock(
          sharedPool,
          cancelBackendPid,
          paymentBackendPid,
        )
        releasePayment()
        await expect(paymentPromise).resolves.toMatchObject({
          directive: "retrieve_same_identity",
        })
        expect(await blockedCancel).toMatchObject({ code: "55000" })
      } finally {
        releasePayment()
        await cancelSecondClient.query("rollback").catch(() => undefined)
        cancelSecondClient.release()
        await blockedCancel?.catch(() => undefined)
        await paymentPromise.catch(() => undefined)
        await barrierRepository.close()
      }
      expect((await inventory.getOrder(paymentFirst.orderId))?.state).toBe(
        "payment_pending",
      )
      expect(
        (await payments.inspectPaymentAggregate(paymentFirst.orderId))
          ?.paymentCount,
      ).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-01 records create evidence but never trusts create-response success for fulfillment",
    async () => {
      const prepared = await prepareFixture("obs-01")
      const createAuthorization = await payments.recordPreCreateNotFound({
        operationKey: prepared.operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        evidence: await attestNotFound(prepared),
      })
      const result = await payments.applyObservation({
        operationKey: requireServerOperation(createAuthorization).operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared),
            "create",
          ),
        ),
      })

      expect(result).toMatchObject({
        replayed: false,
        canonicalState: "requires_method",
        integrityState: "clear",
        orderState: "payment_pending",
        ticketCount: 0,
      })
      expect(
        (await payments.inspectPaymentAggregate(prepared.orderId))?.operations,
      ).toContainEqual(
        expect.objectContaining({
          operationKey:
            requireServerOperation(createAuthorization).operationKey,
          state: "completed",
        }),
      )

      const createSuccess = await prepareFixture("obs-01-create-success")
      const createSuccessAuthorization = await payments.recordPreCreateNotFound(
        {
          operationKey: createSuccess.operationKey,
          orderId: createSuccess.orderId,
          buyerRef: createSuccess.buyerRef,
          evidence: await attestNotFound(createSuccess),
        },
      )
      const createSuccessResult = await payments.applyObservation({
        operationKey: requireServerOperation(createSuccessAuthorization)
          .operationKey,
        orderId: createSuccess.orderId,
        buyerRef: createSuccess.buyerRef,
        observation: await attestObservation(
          createSuccess,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(createSuccess, {
              status: "succeeded",
              attempts: [
                {
                  attempt_id: `attempt-${createSuccess.orderId}-create-success`,
                  status: "charged",
                  connector: "stripe_test",
                  amount: createSuccess.amountMinor,
                  currency: createSuccess.currency,
                },
              ],
            }),
            "create",
          ),
        ),
      })
      expect(createSuccessResult).toMatchObject({
        canonicalState: "uncertain",
        integrityState: "review_required",
        orderState: "payment_pending",
        ticketCount: 0,
      })
      expect(createSuccessResult.integrityIssues).toContain(
        "NON_AUTHORITATIVE_SUCCESS_SOURCE",
      )
      expect(
        (await payments.inspectPaymentAggregate(createSuccess.orderId))
          ?.tickets,
      ).toHaveLength(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-02 persists selected Klarna and observed stripe_test as separate facts",
    async () => {
      const prepared = await prepareFixture("obs-02")
      const operationKey = await beginReconcile(prepared, "obs-02")
      await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "requires_customer_action",
              payment_method: "pay_later",
              payment_method_type: "klarna",
              next_action: {
                type: "redirect_to_url",
                redirect_to_url: "https://provider.invalid/action?token=secret",
              },
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-klarna`,
                  status: "requires_action",
                  connector: "stripe_test",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })

      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      expect(aggregate?.observations.at(-1)).toMatchObject({
        canonicalState: "action_required",
        selectedPaymentMethod: "klarna",
        observedConnector: "stripe_test",
      })
      expect(aggregate?.attempts[0]).toMatchObject({
        canonicalState: "action_required",
        observedConnector: "stripe_test",
      })

      const conflictingOperationKey = await beginReconcile(
        prepared,
        "obs-02-conflicting-connector",
      )
      const conflict = await payments.applyObservation({
        operationKey: conflictingOperationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "processing",
              payment_method: "pay_later",
              payment_method_type: "klarna",
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-klarna`,
                  status: "processing",
                  connector: "adyen_test",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })
      expect(conflict).toMatchObject({
        integrityState: "review_required",
        ticketCount: 0,
      })
      expect(conflict.integrityIssues).toContain("ATTEMPT_PROOF_CONTRADICTION")
      const conflictedAggregate = await payments.inspectPaymentAggregate(
        prepared.orderId,
      )
      expect(conflictedAggregate?.attempts[0]?.observedConnector).toBe(
        "stripe_test",
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-03 records DC_08 hard decline with zero charges, tickets, or cascade",
    async () => {
      const prepared = await prepareFixture("obs-03")
      const operationKey = await beginReconcile(prepared, "obs-03")
      const result = await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "failed",
              error_code: "DC_08",
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-decline`,
                  status: "failure",
                  connector: "stripe_test",
                  error_code: "DC_08",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })

      expect(result).toMatchObject({
        canonicalState: "exhausted",
        successfulChargedAttemptCount: 0,
        ticketCount: 0,
        cascadeObserved: false,
      })
      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      expect(aggregate?.attempts).toHaveLength(1)
      expect(aggregate?.attempts[0]?.canonicalState).toBe("hard_decline")
      expect(aggregate?.tickets).toHaveLength(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-04 maps an ordinary failed attempt without inventing a hard decline",
    async () => {
      const prepared = await prepareFixture("obs-04")
      const operationKey = await beginReconcile(prepared, "obs-04")
      await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "failed",
              error_code: "TE_01",
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-technical`,
                  status: "failed",
                  connector: "stripe_test",
                  error_code: "TE_01",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })

      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      expect(aggregate?.attempts[0]?.canonicalState).toBe("technical_failure")
      expect(aggregate?.attempts[0]?.canonicalState).not.toBe("hard_decline")
      expect(aggregate?.tickets).toHaveLength(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-05 rejects raw or malformed observations before any durable append",
    async () => {
      const prepared = await prepareFixture("obs-05")
      const malformed = paymentPayload(prepared, {
        client_secret: "must-not-cross",
      }) as unknown as NormalizedPaymentObservationV1
      const forgedReceipt = {
        kind: "retrieve_observation",
      } as unknown as HyperswitchV1ObservationReceipt
      const untrustedFailure = await rejectedValue(
        payments.applyObservation({
          operationKey: prepared.operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          observation: forgedReceipt,
        }),
      )
      expect(untrustedFailure).toBeInstanceOf(TypeError)

      const malformedEvidence = await attestObservation(prepared, malformed)
      const failure = await rejectedValue(
        payments.applyObservation({
          operationKey: prepared.operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          observation: malformedEvidence,
        }),
      )

      expect(failure).toMatchObject({ code: "INVALID_NORMALIZED_OBSERVATION" })
      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      expect(aggregate?.observations).toHaveLength(0)
      expect(aggregate?.attempts).toHaveLength(0)

      const conflictPrepared = await prepareFixture("obs-05-replay-conflict")
      const conflictOperationKey = await beginReconcile(
        conflictPrepared,
        "obs-05-replay-conflict",
      )
      const firstObservation = await attestObservation(
        conflictPrepared,
        normalizeHyperswitchPaymentObservationV1(
          paymentPayload(conflictPrepared, { status: "processing" }),
          "retrieve",
        ),
      )
      await payments.applyObservation({
        operationKey: conflictOperationKey,
        orderId: conflictPrepared.orderId,
        buyerRef: conflictPrepared.buyerRef,
        observation: firstObservation,
      })
      const changedObservation = await attestObservation(
        conflictPrepared,
        normalizeHyperswitchPaymentObservationV1(
          paymentPayload(conflictPrepared, {
            status: "requires_customer_action",
            next_action: { type: "redirect_to_url" },
          }),
          "retrieve",
        ),
      )
      await expect(
        payments.applyObservation({
          operationKey: conflictOperationKey,
          orderId: conflictPrepared.orderId,
          buyerRef: conflictPrepared.buyerRef,
          observation: changedObservation,
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-OBS-06 retains terminal success and flags review for a stale later failure",
    async () => {
      const prepared = await prepareFixture("obs-06")
      const successOperationKey = await beginReconcile(
        prepared,
        "obs-06-success",
      )
      await payments.applyObservation({
        operationKey: successOperationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await retrievedSuccess(prepared),
      })
      const staleOperationKey = await beginReconcile(prepared, "obs-06-stale")
      const stale = await payments.applyObservation({
        operationKey: staleOperationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "failed",
              error_code: "TE_01",
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-1`,
                  status: "failed",
                  connector: "stripe_test",
                  error_code: "TE_01",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })

      expect(stale).toMatchObject({
        canonicalState: "succeeded",
        retainedTerminalSuccess: true,
        integrityState: "review_required",
        orderState: "fulfilled",
      })
      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      expect(aggregate?.payment.canonicalState).toBe("succeeded")
      expect(aggregate?.payment.integrityState).toBe("review_required")
      expect(aggregate?.attempts[0]?.canonicalState).toBe("succeeded")
      expect(aggregate?.tickets).toHaveLength(prepared.itemCount)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-FUL-01 atomically issues exactly one ticket per item for retrieved exact success",
    async () => {
      for (const itemCount of [1, 2, 3, 4]) {
        const prepared = await prepareFixture(`ful-01-${itemCount}`, itemCount)
        const operationKey = await beginReconcile(
          prepared,
          `ful-01-${itemCount}`,
        )
        const result = await payments.applyObservation({
          operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          observation: await retrievedSuccess(prepared),
        })
        const replay = await payments.applyObservation({
          operationKey,
          orderId: prepared.orderId,
          buyerRef: prepared.buyerRef,
          observation: await retrievedSuccess(prepared),
        })

        expect(result).toMatchObject({
          orderState: "fulfilled",
          canonicalState: "succeeded",
          ticketCount: itemCount,
          integrityState: "clear",
        })
        expect(replay).toMatchObject({ replayed: true, ticketCount: itemCount })
        const aggregate = await payments.inspectPaymentAggregate(
          prepared.orderId,
        )
        expect(aggregate?.fulfillment?.state).toBe("issued")
        expect(aggregate?.tickets).toHaveLength(itemCount)
        expect(
          new Set(aggregate?.tickets.map((ticket) => ticket.orderItemId)).size,
        ).toBe(itemCount)

        if (itemCount === 4) {
          const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
          const beforeOrder = await sharedPool.query<{
            version: string | number
          }>(`select version from ${quotedSchema}.orders where id = $1`, [
            prepared.orderId,
          ])
          const beforeObservationCount = aggregate?.observations.length ?? 0
          const beforeTicketIds =
            aggregate?.tickets.map((ticket) => ticket.id).sort() ?? []
          const beforeFulfillmentId = aggregate?.fulfillment?.id
          const repeatOperationKey = await beginReconcile(
            prepared,
            "ful-01-repeat-success",
          )
          const repeatedSuccess = await payments.applyObservation({
            operationKey: repeatOperationKey,
            orderId: prepared.orderId,
            buyerRef: prepared.buyerRef,
            observation: await retrievedSuccess(prepared),
          })
          const afterOrder = await sharedPool.query<{
            version: string | number
          }>(`select version from ${quotedSchema}.orders where id = $1`, [
            prepared.orderId,
          ])
          const repeatedAggregate = await payments.inspectPaymentAggregate(
            prepared.orderId,
          )

          expect(repeatedSuccess).toMatchObject({
            replayed: false,
            orderState: "fulfilled",
            canonicalState: "succeeded",
            ticketCount: itemCount,
            fulfillmentId: beforeFulfillmentId,
          })
          expect(String(afterOrder.rows[0]?.version)).toBe(
            String(beforeOrder.rows[0]?.version),
          )
          expect(repeatedAggregate?.observations).toHaveLength(
            beforeObservationCount + 1,
          )
          expect(
            repeatedAggregate?.tickets.map((ticket) => ticket.id).sort(),
          ).toEqual(beforeTicketIds)

          if (!repeatedAggregate?.attempts[0]) {
            throw new Error("Expected one terminal payment attempt.")
          }
          await expectSqlState55000(
            `update ${quotedSchema}.orders
             set state = 'paid', version = version + 1
             where id = $1`,
            [prepared.orderId],
          )
          await expectSqlState55000(
            `update ${quotedSchema}.orders
             set total_minor = total_minor + 1, version = version + 1
             where id = $1`,
            [prepared.orderId],
          )
          await expectSqlState55000(
            `delete from ${quotedSchema}.provider_payment where id = $1`,
            [repeatedAggregate.payment.id],
          )
          await expectSqlState55000(
            `delete from ${quotedSchema}.checkout_operation
             where order_id = $1`,
            [prepared.orderId],
          )
          await expectSqlState55000(
            `delete from ${quotedSchema}.payment_attempt where id = $1`,
            [repeatedAggregate.attempts[0].id],
          )
          await expectSqlState55000(
            `update ${quotedSchema}.provider_payment
             set successful_attempt_id = null,
                 succeeded_at = succeeded_at + interval '1 second',
                 version = version + 1,
                 updated_at = clock_timestamp()
             where id = $1`,
            [repeatedAggregate.payment.id],
          )
          await expectSqlState55000(
            `update ${quotedSchema}.payment_attempt
             set observed_connector = 'adyen_test',
                 terminal_at = terminal_at + interval '1 second',
                 last_observed_at = clock_timestamp()
             where id = $1`,
            [repeatedAggregate.attempts[0].id],
          )
          await expectSqlState55000(
            `update ${quotedSchema}.seat_allocation
             set state = 'reservation_released',
                 released_at = clock_timestamp()
             where order_id = $1`,
            [prepared.orderId],
          )
        }
      }

      const concurrent = await prepareFixture("ful-01-concurrent", 4)
      const firstOperationKey = await beginReconcile(
        concurrent,
        "ful-01-concurrent-first",
      )
      const secondOperationKey = await beginReconcile(
        concurrent,
        "ful-01-concurrent-second",
      )
      let releaseFirst: () => void
      let markFirstStaged: () => void
      let markFirstBackend: (backendPid: number) => void
      let markSecondBackend: (backendPid: number) => void
      const releaseFirstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstStaged = new Promise<void>((resolve) => {
        markFirstStaged = resolve
      })
      const firstBackend = new Promise<number>((resolve) => {
        markFirstBackend = resolve
      })
      const secondBackend = new Promise<number>((resolve) => {
        markSecondBackend = resolve
      })
      const firstRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend: markFirstBackend,
          async afterFulfillmentStaged() {
            markFirstStaged()
            await releaseFirstGate
          },
        },
      })
      const secondRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: { onTransactionBackend: markSecondBackend },
      })
      let firstApply: ReturnType<NeonPaymentRepository["applyObservation"]> | undefined
      let secondApply: ReturnType<NeonPaymentRepository["applyObservation"]> | undefined
      try {
        firstApply = firstRepository.applyObservation({
          operationKey: firstOperationKey,
          orderId: concurrent.orderId,
          buyerRef: concurrent.buyerRef,
          observation: await retrievedSuccess(concurrent),
        })
        const firstBackendPid = await firstBackend
        await Promise.race([
          firstStaged,
          firstApply.then(() => {
            throw new Error(
              "The first successful reconciliation committed before its deterministic barrier.",
            )
          }),
        ])

        secondApply = secondRepository.applyObservation({
          operationKey: secondOperationKey,
          orderId: concurrent.orderId,
          buyerRef: concurrent.buyerRef,
          observation: await retrievedSuccess(concurrent),
        })
        const secondBackendPid = await Promise.race([
          secondBackend,
          secondApply.then(() => {
            throw new Error(
              "The second successful reconciliation committed before exposing its backend.",
            )
          }),
        ])
        await waitForDatabaseBlock(
          sharedPool,
          secondBackendPid,
          firstBackendPid,
        )
        releaseFirst()

        const [firstResult, secondResult] = await Promise.all([
          firstApply,
          secondApply,
        ])
        expect(firstResult).toMatchObject({
          canonicalState: "succeeded",
          orderState: "fulfilled",
          ticketCount: concurrent.itemCount,
        })
        expect(secondResult).toMatchObject({
          canonicalState: "succeeded",
          orderState: "fulfilled",
          fulfillmentId: firstResult.fulfillmentId,
          ticketCount: concurrent.itemCount,
        })
        const concurrentAggregate = await payments.inspectPaymentAggregate(
          concurrent.orderId,
        )
        expect(concurrentAggregate?.paymentCount).toBe(1)
        expect(concurrentAggregate?.fulfillment?.id).toBe(
          firstResult.fulfillmentId,
        )
        expect(concurrentAggregate?.tickets).toHaveLength(concurrent.itemCount)
        expect(
          new Set(
            concurrentAggregate?.tickets.map((ticket) => ticket.orderItemId),
          ).size,
        ).toBe(concurrent.itemCount)
        expect(concurrentAggregate?.attempts).toHaveLength(1)
      } finally {
        releaseFirst()
        await Promise.allSettled(
          [firstApply, secondApply].filter(
            (task): task is NonNullable<typeof task> => task !== undefined,
          ),
        )
        await firstRepository.close()
        await secondRepository.close()
      }

      const coherent = await prepareFixture("ful-01-coherent-inspection", 4)
      const coherentOperationKey = await beginReconcile(
        coherent,
        "ful-01-coherent-inspection",
      )
      const coherentObservation = await retrievedSuccess(coherent)
      let markAggregateOrderRead = (): void => undefined
      const aggregateOrderRead = new Promise<void>((resolve) => {
        markAggregateOrderRead = resolve
      })
      let releaseAggregateRead = (): void => undefined
      const aggregateReadRelease = new Promise<void>((resolve) => {
        releaseAggregateRead = resolve
      })
      const coherentInspectionRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          async afterAggregateOrderRead() {
            markAggregateOrderRead()
            await aggregateReadRelease
          },
        },
      })
      let aggregateInspection:
        | ReturnType<
            NeonPaymentRepository["inspectPaymentAggregate"]
          >
        | undefined
      let fulfillmentCommit:
        | ReturnType<NeonPaymentRepository["applyObservation"]>
        | undefined
      try {
        aggregateInspection =
          coherentInspectionRepository.inspectPaymentAggregate(
            coherent.orderId,
          )
        await waitForBarrierOrEarlyTask(
          aggregateOrderRead,
          [aggregateInspection],
          "Aggregate first-row snapshot barrier",
        )
        fulfillmentCommit = payments.applyObservation({
          operationKey: coherentOperationKey,
          orderId: coherent.orderId,
          buyerRef: coherent.buyerRef,
          observation: coherentObservation,
        })
        await fulfillmentCommit
        releaseAggregateRead()
        const observedAggregate = await aggregateInspection
        if (!observedAggregate) {
          throw new Error("Expected one coherent aggregate inspection.")
        }
        const whollyBeforeCommit =
          observedAggregate.order.state === "payment_pending" &&
          observedAggregate.payment.canonicalState === "uncertain" &&
          observedAggregate.fulfillment === null &&
          observedAggregate.observations.length === 0 &&
          observedAggregate.tickets.length === 0
        const whollyAfterCommit =
          observedAggregate.order.state === "fulfilled" &&
          observedAggregate.payment.canonicalState === "succeeded" &&
          observedAggregate.fulfillment?.state === "issued" &&
          observedAggregate.observations.length === 1 &&
          observedAggregate.tickets.length === coherent.itemCount
        expect(whollyBeforeCommit || whollyAfterCommit).toBe(true)
        expect(whollyBeforeCommit).toBe(true)

        const committedAggregate = await payments.inspectPaymentAggregate(
          coherent.orderId,
        )
        expect(committedAggregate).toMatchObject({
          order: { state: "fulfilled" },
          payment: { canonicalState: "succeeded" },
          fulfillment: { state: "issued" },
        })
        expect(committedAggregate?.tickets).toHaveLength(coherent.itemCount)
      } finally {
        releaseAggregateRead()
        const tasks = [aggregateInspection, fulfillmentCommit].filter(
          (task): task is NonNullable<typeof task> => task !== undefined,
        )
        await Promise.allSettled(tasks)
        await coherentInspectionRepository.close()
      }
    },
    TEST_TIMEOUT_MS * 2,
  )

  it(
    "C3-FUL-02 blocks fulfillment and requires review on wrong provider money",
    async () => {
      const prepared = await prepareFixture("ful-02")
      const operationKey = await beginReconcile(prepared, "ful-02")
      const result = await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await retrievedSuccess(prepared, {
          amount: prepared.amountMinor + 1,
        }),
      })

      expect(result).toMatchObject({
        integrityState: "review_required",
        ticketCount: 0,
        orderState: "payment_pending",
      })
      expect(result.integrityIssues).toContain("ORDER_AMOUNT_MISMATCH")
      expect(
        (await payments.inspectPaymentAggregate(prepared.orderId))?.tickets,
      ).toHaveLength(0)

      const releasedAllocation = await prepareFixture(
        "ful-02-released-allocation",
      )
      const releasedOperationKey = await beginReconcile(
        releasedAllocation,
        "ful-02-released-allocation",
      )
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const released = await sharedPool.query(
        `update ${quotedSchema}.seat_allocation
         set state = 'reservation_released', released_at = clock_timestamp()
         where id = (
           select id from ${quotedSchema}.seat_allocation
           where order_id = $1 and state = 'reserved'
           order by id limit 1
         )`,
        [releasedAllocation.orderId],
      )
      expect(released.rowCount).toBe(1)
      const releasedFailure = await rejectedValue(
        payments.applyObservation({
          operationKey: releasedOperationKey,
          orderId: releasedAllocation.orderId,
          buyerRef: releasedAllocation.buyerRef,
          observation: await retrievedSuccess(releasedAllocation),
        }),
      )
      expect(releasedFailure).toMatchObject({ code: "ORDER_INVARIANT" })
      const releasedAggregate = await payments.inspectPaymentAggregate(
        releasedAllocation.orderId,
      )
      expect(releasedAggregate).toMatchObject({
        observations: [],
        tickets: [],
        fulfillment: null,
      })

      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      if (!aggregate) throw new Error("Expected payment aggregate.")
      const directClient = await sharedPool.connect()
      try {
        await directClient.query("begin")
        await directClient.query(
          `insert into ${quotedSchema}.fulfillment_bundle (
             id, order_id, payment_id, state
           ) values ($1, $2, $3, 'issued')`,
          [nextUuid(), prepared.orderId, aggregate.payment.id],
        )
        await expect(
          directClient.query("set constraints all immediate"),
        ).rejects.toBeTruthy()
      } finally {
        await directClient.query("rollback").catch(() => undefined)
        directClient.release()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-FUL-03 blocks fulfillment when two distinct logical attempts charged",
    async () => {
      const prepared = await prepareFixture("ful-03")
      const operationKey = await beginReconcile(prepared, "ful-03")
      const observation = await retrievedSuccess(prepared, {
        attempts: [
          {
            attempt_id: `attempt-${prepared.orderId}-1`,
            status: "charged",
            connector: "stripe_test",
          },
          {
            attempt_id: `attempt-${prepared.orderId}-2`,
            status: "succeeded",
            connector: "adyen_test",
          },
        ],
      })
      const result = await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation,
      })

      expect(result).toMatchObject({
        successfulChargedAttemptCount: 2,
        integrityState: "review_required",
        ticketCount: 0,
      })
      expect(result.integrityIssues).toContain("MULTIPLE_SUCCESSFUL_CHARGES")

      const zeroCharge = await prepareFixture("ful-03-zero-charge")
      const zeroChargeOperation = await beginReconcile(
        zeroCharge,
        "ful-03-zero-charge",
      )
      const zeroChargeResult = await payments.applyObservation({
        operationKey: zeroChargeOperation,
        orderId: zeroCharge.orderId,
        buyerRef: zeroCharge.buyerRef,
        observation: await retrievedSuccess(zeroCharge, { attempts: [] }),
      })
      expect(zeroChargeResult).toMatchObject({
        canonicalState: "uncertain",
        integrityState: "review_required",
        successfulChargedAttemptCount: 0,
        ticketCount: 0,
        orderState: "payment_pending",
      })
      expect(zeroChargeResult.integrityIssues).toContain(
        "SUCCEEDED_WITHOUT_CHARGED_ATTEMPT",
      )
      expect(
        (await payments.inspectPaymentAggregate(zeroCharge.orderId))?.tickets,
      ).toHaveLength(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-FUL-04 rolls back ticket-two failure and serializes allocation versus fulfillment",
    async () => {
      const prepared = await prepareFixture("ful-04", 4)
      const operationKey = await beginReconcile(prepared, "ful-04")
      const faulted = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          afterTicketInsert(count) {
            if (count === 2) throw new Error("INJECTED_AFTER_TICKET_2")
          },
        },
      })
      try {
        await expect(
          faulted.applyObservation({
            operationKey,
            orderId: prepared.orderId,
            buyerRef: prepared.buyerRef,
            observation: await retrievedSuccess(prepared),
          }),
        ).rejects.toThrow("INJECTED_AFTER_TICKET_2")
      } finally {
        await faulted.close()
      }

      const rolledBack = await payments.inspectPaymentAggregate(
        prepared.orderId,
      )
      expect(rolledBack).toMatchObject({
        payment: {
          canonicalState: "uncertain",
          integrityState: "clear",
        },
        fulfillment: null,
        observations: [],
        tickets: [],
      })
      expect(rolledBack?.operations).toContainEqual(
        expect.objectContaining({
          operationKey,
          state: "started",
        }),
      )
      expect((await inventory.getOrder(prepared.orderId))?.state).toBe(
        "payment_pending",
      )

      const repaired = await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await retrievedSuccess(prepared),
      })
      expect(repaired.ticketCount).toBe(4)
      expect(repaired.orderState).toBe("fulfilled")

      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const allocationFirst = await prepareFixture("ful-04-allocation-first")
      const allocationFirstOperation = await beginReconcile(
        allocationFirst,
        "ful-04-allocation-first",
      )
      const allocationFirstClient = await sharedPool.connect()
      let allocationFirstApply: Promise<unknown> | undefined
      let allocationFirstRepository: NeonPaymentRepository | undefined
      try {
        await allocationFirstClient.query("begin")
        const allocationBackend = await allocationFirstClient.query<{
          pid: number
        }>("select pg_backend_pid() as pid")
        const allocationBackendPid = allocationBackend.rows[0]?.pid
        if (!Number.isInteger(allocationBackendPid)) {
          throw new Error("Could not resolve allocation-first backend PID.")
        }
        const released = await allocationFirstClient.query(
          `update ${quotedSchema}.seat_allocation
           set state = 'reservation_released',
               released_at = clock_timestamp()
           where id = (
             select id from ${quotedSchema}.seat_allocation
             where order_id = $1 and state = 'reserved'
             order by id limit 1
           )`,
          [allocationFirst.orderId],
        )
        expect(released.rowCount).toBe(1)

        let signalApplyBackend: (backendPid: number) => void
        const applyBackend = new Promise<number>((resolve) => {
          signalApplyBackend = resolve
        })
        allocationFirstRepository = new NeonPaymentRepository({
          databaseUrl,
          schema: schemaRun.schema,
          pool: sharedPool,
          evidenceVerifier: evidenceBinding.verifier,
          faultInjector: {
            onTransactionBackend(backendPid) {
              signalApplyBackend(backendPid)
            },
          },
        })
        allocationFirstApply = rejectedValue(
          allocationFirstRepository.applyObservation({
            operationKey: allocationFirstOperation,
            orderId: allocationFirst.orderId,
            buyerRef: allocationFirst.buyerRef,
            observation: await retrievedSuccess(allocationFirst),
          }),
        )
        const applyBackendPid = await applyBackend
        await waitForDatabaseBlock(
          sharedPool,
          applyBackendPid,
          allocationBackendPid,
        )
        await allocationFirstClient.query("commit")
        expect(await allocationFirstApply).toMatchObject({
          code: "ORDER_INVARIANT",
        })
      } finally {
        await allocationFirstClient.query("rollback").catch(() => undefined)
        allocationFirstClient.release()
        await allocationFirstApply?.catch(() => undefined)
        await allocationFirstRepository?.close()
      }
      expect(
        await payments.inspectPaymentAggregate(allocationFirst.orderId),
      ).toMatchObject({ fulfillment: null, observations: [], tickets: [] })

      const fulfillmentFirst = await prepareFixture("ful-04-fulfillment-first")
      const fulfillmentFirstOperation = await beginReconcile(
        fulfillmentFirst,
        "ful-04-fulfillment-first",
      )
      let signalFulfillmentBackend: (backendPid: number) => void
      const fulfillmentBackend = new Promise<number>((resolve) => {
        signalFulfillmentBackend = resolve
      })
      let signalStaged: () => void
      const staged = new Promise<void>((resolve) => {
        signalStaged = resolve
      })
      let releaseFulfillment: () => void
      const releaseStagedFulfillment = new Promise<void>((resolve) => {
        releaseFulfillment = resolve
      })
      const fulfillmentFirstRepository = new NeonPaymentRepository({
        databaseUrl,
        schema: schemaRun.schema,
        pool: sharedPool,
        evidenceVerifier: evidenceBinding.verifier,
        faultInjector: {
          onTransactionBackend(backendPid) {
            signalFulfillmentBackend(backendPid)
          },
          async afterFulfillmentStaged() {
            signalStaged()
            await releaseStagedFulfillment
          },
        },
      })
      const fulfillmentFirstApply = fulfillmentFirstRepository.applyObservation(
        {
          operationKey: fulfillmentFirstOperation,
          orderId: fulfillmentFirst.orderId,
          buyerRef: fulfillmentFirst.buyerRef,
          observation: await retrievedSuccess(fulfillmentFirst),
        },
      )
      await staged
      const fulfillmentBackendPid = await fulfillmentBackend
      const fulfillmentFirstAllocation = await sharedPool.connect()
      let blockedAllocation: Promise<unknown> | undefined
      try {
        await fulfillmentFirstAllocation.query("begin")
        const allocationBackend = await fulfillmentFirstAllocation.query<{
          pid: number
        }>("select pg_backend_pid() as pid")
        const allocationBackendPid = allocationBackend.rows[0]?.pid
        if (!Number.isInteger(allocationBackendPid)) {
          throw new Error("Could not resolve fulfillment-first backend PID.")
        }
        blockedAllocation = rejectedValue(
          fulfillmentFirstAllocation.query(
            `update ${quotedSchema}.seat_allocation
             set state = 'reservation_released',
                 released_at = clock_timestamp()
             where id = (
               select id from ${quotedSchema}.seat_allocation
               where order_id = $1 and state = 'reserved'
               order by id limit 1
             )`,
            [fulfillmentFirst.orderId],
          ),
        )
        await waitForDatabaseBlock(
          sharedPool,
          allocationBackendPid,
          fulfillmentBackendPid,
        )
        releaseFulfillment()
        await expect(fulfillmentFirstApply).resolves.toMatchObject({
          orderState: "fulfilled",
          ticketCount: fulfillmentFirst.itemCount,
        })
        expect(await blockedAllocation).toMatchObject({ code: "55000" })
      } finally {
        releaseFulfillment()
        await fulfillmentFirstAllocation
          .query("rollback")
          .catch(() => undefined)
        fulfillmentFirstAllocation.release()
        await blockedAllocation?.catch(() => undefined)
        await fulfillmentFirstApply.catch(() => undefined)
        await fulfillmentFirstRepository.close()
      }
      const fulfillmentFirstAggregate = await payments.inspectPaymentAggregate(
        fulfillmentFirst.orderId,
      )
      expect(fulfillmentFirstAggregate).toMatchObject({
        order: { state: "fulfilled" },
        fulfillment: { state: "issued" },
      })
      expect(fulfillmentFirstAggregate?.tickets).toHaveLength(
        fulfillmentFirst.itemCount,
      )
      const retainedAllocations = await sharedPool.query<{
        state: string
      }>(
        `select state from ${quotedSchema}.seat_allocation
         where order_id = $1 order by id`,
        [fulfillmentFirst.orderId],
      )
      expect(retainedAllocations.rows).toHaveLength(fulfillmentFirst.itemCount)
      expect(
        retainedAllocations.rows.every((row) => row.state === "reserved"),
      ).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C3-SEC-02 persists and exposes no client secret, raw payload, action URL/body, PAN, CVC, or return query",
    async () => {
      const prepared = await prepareFixture("sec-02")
      const operationKey = await beginReconcile(prepared, "sec-02")
      await payments.applyObservation({
        operationKey,
        orderId: prepared.orderId,
        buyerRef: prepared.buyerRef,
        observation: await attestObservation(
          prepared,
          normalizeHyperswitchPaymentObservationV1(
            paymentPayload(prepared, {
              status: "requires_customer_action",
              client_secret: "secret-client-material",
              return_url: "https://merchant.invalid/return?token=secret-query",
              next_action: {
                type: "redirect_to_url",
                redirect_to_url: "https://provider.invalid/action?secret=1",
                body: { pan: "4242424242424242", cvc: "123" },
              },
              attempts: [
                {
                  attempt_id: `attempt-${prepared.orderId}-secure`,
                  status: "requires_action",
                  connector: "stripe_test",
                },
              ],
            }),
            "retrieve",
          ),
        ),
      })

      const aggregate = await payments.inspectPaymentAggregate(prepared.orderId)
      const serialized = JSON.stringify(aggregate)
      for (const forbidden of [
        "secret-client-material",
        "secret-query",
        "provider.invalid",
        "4242424242424242",
        "client_secret",
        "return_url",
        "redirect_to_url",
        "raw_payload",
        "cvc",
      ]) {
        expect(serialized).not.toContain(forbidden)
      }

      const categoricalCanaries = [
        "client_secret_status_CANARY",
        "api_key_method_CANARY",
        "authorization_bearer_CANARY",
        "https://evil.invalid/token_CANARY",
        "4242424242424242",
        "client_secret_code_CANARY",
        "api_key_unified_CANARY",
        "provider.invalid/raw_CANARY",
      ]
      const canaryPrepared = await prepareFixture("sec-02-categorical-canaries")
      const canaryOperation = await beginReconcile(
        canaryPrepared,
        "sec-02-categorical-canaries",
      )
      const normalizedCanaries = normalizeHyperswitchPaymentObservationV1(
        paymentPayload(canaryPrepared, {
          status: categoricalCanaries[0],
          payment_method: categoricalCanaries[1],
          payment_method_type: categoricalCanaries[2],
          connector: categoricalCanaries[4],
          error_code: categoricalCanaries[5],
          unified_code: categoricalCanaries[6],
          error_message: categoricalCanaries[7],
          next_action: { type: categoricalCanaries[3] },
          attempts: [
            {
              attempt_id: categoricalCanaries[4],
              status: categoricalCanaries[2],
              connector: categoricalCanaries[0],
              error_code: categoricalCanaries[5],
              unified_code: categoricalCanaries[6],
              error_message: categoricalCanaries[3],
            },
          ],
        }),
        "retrieve",
      )
      expect(normalizedCanaries).toMatchObject({
        providerStatus: "unrecognized",
        selectedPaymentMethod: { family: "other", type: "other" },
        observedConnector: "other",
        nextAction: { present: true, kind: "other" },
        error: {
          class: "unknown",
          code: "UNRECOGNIZED",
          unifiedCode: "UNRECOGNIZED",
        },
        attempts: [
          {
            providerStatus: "unrecognized",
            observedConnector: "other",
            error: {
              class: "unknown",
              code: "UNRECOGNIZED",
              unifiedCode: "UNRECOGNIZED",
            },
          },
        ],
      })
      await payments.applyObservation({
        operationKey: canaryOperation,
        orderId: canaryPrepared.orderId,
        buyerRef: canaryPrepared.buyerRef,
        observation: await attestObservation(
          canaryPrepared,
          normalizedCanaries,
        ),
      })
      const canaryAggregate = await payments.inspectPaymentAggregate(
        canaryPrepared.orderId,
      )
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const storedCanaries = await sharedPool.query<{
        provider_status: string
        selected_payment_method: string | null
        observed_connector: string | null
        error_kind: string | null
        error_code: string | null
        unified_error_code: string | null
      }>(
        `select provider_status, selected_payment_method, observed_connector,
                error_kind, error_code, unified_error_code
         from ${quotedSchema}.payment_observation
         where payment_id = $1`,
        [canaryAggregate?.payment.id],
      )
      expect(storedCanaries.rows).toEqual([
        {
          provider_status: "unrecognized",
          selected_payment_method: "other",
          observed_connector: "other",
          error_kind: "unknown",
          error_code: "UNRECOGNIZED",
          unified_error_code: "UNRECOGNIZED",
        },
      ])
      const storedAttemptCanaries = await sharedPool.query<{
        canonical_state: string
        observed_connector: string | null
        error_kind: string | null
        error_code: string | null
        unified_error_code: string | null
      }>(
        `select pao.canonical_state, pao.observed_connector, pao.error_kind,
                pao.error_code, pao.unified_error_code
         from ${quotedSchema}.payment_attempt_observation pao
         where pao.payment_id = $1`,
        [canaryAggregate?.payment.id],
      )
      expect(storedAttemptCanaries.rows).toEqual([
        {
          canonical_state: "unknown",
          observed_connector: "other",
          error_kind: "unknown",
          error_code: "UNRECOGNIZED",
          unified_error_code: "UNRECOGNIZED",
        },
      ])
      const canarySerialization = JSON.stringify({
        normalizedCanaries,
        canaryAggregate,
      })
      for (const canary of categoricalCanaries) {
        expect(canarySerialization).not.toContain(canary)
      }

      const prefixedCodeCanary = await prepareFixture(
        "sec-02-prefixed-code-canary",
      )
      const prefixedCodeOperation = await beginReconcile(
        prefixedCodeCanary,
        "sec-02-prefixed-code-canary",
      )
      const prefixedCodeObservation = normalizeHyperswitchPaymentObservationV1(
        paymentPayload(prefixedCodeCanary, {
          status: "processing",
          error_code: "TE_SECRETCANARY123",
          attempts: [
            {
              attempt_id: `attempt-${prefixedCodeCanary.orderId}-canary`,
              status: "processing",
              connector: "stripe_test",
              error_code: "TE_SK_LIVE_SUPERSECRET123",
            },
          ],
        }),
        "retrieve",
      )
      expect(prefixedCodeObservation.error?.code).toBe("TE_OTHER")
      expect(prefixedCodeObservation.attempts[0]?.error?.code).toBe("TE_OTHER")
      await payments.applyObservation({
        operationKey: prefixedCodeOperation,
        orderId: prefixedCodeCanary.orderId,
        buyerRef: prefixedCodeCanary.buyerRef,
        observation: await attestObservation(
          prefixedCodeCanary,
          prefixedCodeObservation,
        ),
      })
      const prefixedCodeAggregate = await payments.inspectPaymentAggregate(
        prefixedCodeCanary.orderId,
      )
      expect(prefixedCodeAggregate?.observations).toHaveLength(1)
      expect(JSON.stringify(prefixedCodeAggregate)).not.toMatch(
        /SECRETCANARY|SK_LIVE|SUPERSECRET/iu,
      )

      const columns = await sharedPool.query<{ column_name: string }>(
        `select column_name
         from information_schema.columns
         where table_schema = $1
           and table_name in (
             'provider_payment', 'checkout_operation', 'payment_observation',
             'payment_attempt', 'payment_attempt_observation',
             'fulfillment_bundle', 'ticket'
           )`,
        [schemaRun.schema],
      )
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining([
          "client_secret",
          "publishable_key",
          "pan",
          "cvc",
          "redirect_url",
          "redirect_body",
          "raw_payload",
        ]),
      )
      expect(quoteEphemeralSchema(schemaRun.schema)).toBe(
        `"${schemaRun.schema}"`,
      )
    },
    TEST_TIMEOUT_MS,
  )
})
