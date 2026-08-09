import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"

import {
  projectRecordedRunV1,
  recordedRunPopulationLabelV1,
} from "../../app/flows/recorded-run-adapter-v1"
import { storyLabFlowCatalog } from "../../app/flows/replay"
import {
  parseRecordedRunTraceV1,
  parseRecordedRunsPageV1,
  recordedRunLimitationV1,
  summarizeRecordedRunV1,
  type RecordedRunTraceV1,
  type RecordedRunsPageV1,
} from "../../src/onsale/contracts/recorded-run-v1"
import {
  fetchExactRecordedRunV1,
} from "../../src/onsale/flows/recorded-runs-client-v1"
import {
  mergeCompletedRunV1,
  type RecordedRunsStateV1,
} from "../../src/onsale/flows/use-recorded-runs-v1"
import {
  completedRunRefFromSignalV1,
  createCompletedRunSignalV1,
} from "../../src/onsale/flows/completed-run-signal-v1"
import { announceCurrentRecordedRunForRevisionV1 } from "../../src/onsale/flows/use-announce-current-recorded-run-v1"
import {
  handleCurrentRecordedRunGetV1,
  handleRecordedRunDetailGetV1,
  handleRecordedRunsListGetV1,
  NeonRecordedRunsRepositoryV1,
  recordedEventRefFromSourceV1,
  recordedEvidenceRefFromSourceV1,
  recordedRunRefFromPaymentIdV1,
  selectedRecordedPaymentMethodV1,
  type RecordedRunsRepositoryV1,
} from "../../src/server/onsale-recorded-runs-neon"

const RUN_ONE = "run_111111111111111111111111"
const RUN_TWO = "run_222222222222222222222222"

function retainedTrace(seed: "1" | "2"): RecordedRunTraceV1 {
  const runRef = seed === "1" ? RUN_ONE : RUN_TWO
  const eventRef = `evt_${seed.repeat(24)}`
  const evidenceRef = `ev_${seed.repeat(24)}`
  const digest = `sha256:${seed.repeat(64)}`
  return parseRecordedRunTraceV1({
    schema: "onsale.recorded-run.v1",
    runRef,
    population: "local_browser",
    integrityRevision: digest,
    order: { state: "awaiting_payment", itemCount: seed === "1" ? 2 : 1 },
    payment: { state: "requires_method", selectedMethod: null },
    money: {
      currency: "USD",
      amountDueMinor: seed === "1" ? 44_000 : 18_460,
      amountReceivedMinor: null,
    },
    attempts: [],
    events: [
      {
        eventRef,
        sequence: 1,
        occurredAt: `2026-08-09T12:00:0${seed}.000Z`,
        kind: "create_requested",
        edge: "buyer_merchant",
        replayable: true,
        attemptOrdinal: null,
        authority: "merchant_server",
        evidenceRef,
      },
    ],
    consequence: {
      chargeCount: 0,
      ticketCount: 0,
      ticketState: "not_issued",
    },
    replay: { eligible: true, basis: "retained_operation_order" },
    limitations: [recordedRunLimitationV1("METHOD_NOT_RETAINED")],
  })
}

function pageFor(
  trace: RecordedRunTraceV1,
  recordedAt: string,
  nextCursor: RecordedRunTraceV1["runRef"] | null,
): RecordedRunsPageV1 {
  return {
    schema: "onsale.recorded-runs.v1",
    items: [summarizeRecordedRunV1(trace, recordedAt)],
    page: { limit: 20, nextCursor },
  }
}

describe("ONSALE v0.1 durable Recorded Runs boundary", () => {
  it("keeps unproven received money unknown while retaining exact succeeded money", () => {
    const pending = retainedTrace("1")
    expect(pending.money.amountReceivedMinor).toBeNull()
    expect(summarizeRecordedRunV1(
      pending,
      "2026-08-09T12:01:00.000Z",
    ).amountReceivedMinor).toBeNull()
    expect(projectRecordedRunV1(
      summarizeRecordedRunV1(pending, "2026-08-09T12:01:00.000Z"),
      pending,
    ).flow.steps.at(-1)?.amountReceivedMinor).toBeNull()

    const pendingSummary = summarizeRecordedRunV1(
      pending,
      "2026-08-09T12:01:00.000Z",
    )
    expect(() => parseRecordedRunsPageV1({
      schema: "onsale.recorded-runs.v1",
      items: [{ ...pendingSummary, amountReceivedMinor: 0 }],
      page: { limit: 20, nextCursor: null },
    })).toThrow(/received money must be exact for success and unknown otherwise/iu)

    expect(() => parseRecordedRunTraceV1({
      ...pending,
      money: { ...pending.money, amountReceivedMinor: 0 },
    })).toThrow(/amountReceivedMinor|money and fulfillment/iu)

    const succeeded = parseRecordedRunTraceV1({
      ...pending,
      order: { state: "fulfilled", itemCount: 1 },
      payment: {
        state: "succeeded",
        selectedMethod: { family: "card", type: "credit" },
      },
      money: {
        currency: "USD",
        amountDueMinor: 18_460,
        amountReceivedMinor: 18_460,
      },
      attempts: [{
        ordinal: 1,
        method: { family: "card", type: "credit" },
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
        failureClass: null,
        evidenceRef: "ev_aaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      consequence: {
        chargeCount: 1,
        ticketCount: 1,
        ticketState: "issued",
      },
      limitations: [],
    })
    expect(succeeded.money.amountReceivedMinor).toBe(18_460)
  })

  it("rejects METHOD_TYPE_NOT_RETAINED when the retained subtype is known", () => {
    const pending = retainedTrace("1")
    expect(() => parseRecordedRunTraceV1({
      ...pending,
      payment: {
        ...pending.payment,
        selectedMethod: { family: "pay_later", type: "klarna" },
      },
      limitations: [recordedRunLimitationV1("METHOD_TYPE_NOT_RETAINED")],
    })).toThrow(/unexpected limitation METHOD_TYPE_NOT_RETAINED/iu)
  })

  it("keeps all six Story Lab subjects outside the durable ledger", () => {
    expect(storyLabFlowCatalog).toHaveLength(6)
    expect(new Set(storyLabFlowCatalog.map((story) => story.id)).size).toBe(6)
    expect(storyLabFlowCatalog.some((story) => story.proof === "local_simulation")).toBe(true)
  })

  it("projects one sanitized durable run into the v0.1 replay model", () => {
    const trace = retainedTrace("1")
    const summary = pageFor(
      trace,
      "2026-08-09T12:01:00.000Z",
      null,
    ).items[0]!
    const projection = projectRecordedRunV1(summary, trace)

    expect(projection.run).toMatchObject({
      id: RUN_ONE,
      flowId: RUN_ONE,
      amountMinor: 44_000,
      itemCount: 2,
      canonicalPaymentState: "requires_method",
    })
    expect(projection.flow.id).toBe(RUN_ONE)
    expect(projection.flow.steps).toHaveLength(1)
    expect(projection.flow.steps[0]).toMatchObject({
      actor: "merchant",
      evidenceClass: "live_sandbox_recorded",
      evidenceRef: "ev_111111111111111111111111",
      motion: {
        edgeId: "buyer_merchant",
        authorityProof: "server_create",
      },
    })
    expect(JSON.stringify(projection)).not.toMatch(
      /(?:order|payment|session|provider|client_secret)_[A-Za-z0-9]{8,}/iu,
    )
    expect(recordedRunPopulationLabelV1("local_browser")).toBe(
      "LOCAL BROWSER RECORD",
    )
  })

  it("rejects Story Lab simulation if it reaches the Recorded Runs adapter", () => {
    const trace = retainedTrace("1")
    const summary = pageFor(
      trace,
      "2026-08-09T12:01:00.000Z",
      null,
    ).items[0]!
    expect(() =>
      projectRecordedRunV1(
        { ...summary, population: "local_simulation" },
        { ...trace, population: "local_simulation" },
      ),
    ).toThrow(/simulation/i)
  })

  it("walks the sanitized cursor with GET-only reads to find an exact completed run", async () => {
    const older = retainedTrace("1")
    const completed = retainedTrace("2")
    const firstPage = pageFor(
      older,
      "2026-08-09T12:01:00.000Z",
      older.runRef,
    )
    const secondPage = pageFor(
      completed,
      "2026-08-09T12:02:00.000Z",
      null,
    )
    const calls: Array<{ path: string; method: string | undefined }> = []
    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = input.toString()
      calls.push({ path, method: init?.method })
      if (path === `/api/onsale/ops/runs/${completed.runRef}`) {
        return new Response(JSON.stringify(completed), { status: 200 })
      }
      if (path === "/api/onsale/ops/runs?limit=20") {
        return new Response(JSON.stringify(firstPage), { status: 200 })
      }
      return new Response(JSON.stringify(secondPage), { status: 200 })
    }

    await expect(
      fetchExactRecordedRunV1({ runRef: completed.runRef, fetchImpl }),
    ).resolves.toEqual({ summary: secondPage.items[0], trace: completed })
    expect(calls).toEqual([
      {
        path: `/api/onsale/ops/runs/${completed.runRef}`,
        method: "GET",
      },
      { path: "/api/onsale/ops/runs?limit=20", method: "GET" },
      {
        path: `/api/onsale/ops/runs?limit=20&cursor=${older.runRef}`,
        method: "GET",
      },
    ])
  })

  it("selects a completed exact run idempotently without losing older pages or cursor", () => {
    const older = retainedTrace("1")
    const completed = retainedTrace("2")
    const olderSummary = pageFor(
      older,
      "2026-08-09T12:01:00.000Z",
      older.runRef,
    ).items[0]!
    const completedSummary = pageFor(
      completed,
      "2026-08-09T12:02:00.000Z",
      null,
    ).items[0]!
    const prior: RecordedRunsStateV1 = {
      status: "ready",
      items: [olderSummary],
      nextCursor: older.runRef,
      selected: { summary: olderSummary, trace: older },
      pendingRunRef: null,
      loadingMore: false,
      message: "stale error",
    }

    const once = mergeCompletedRunV1(prior, {
      summary: completedSummary,
      trace: completed,
    })
    const twice = mergeCompletedRunV1(once, {
      summary: completedSummary,
      trace: completed,
    })

    expect(once.items.map((item) => item.runRef)).toEqual([
      completed.runRef,
      older.runRef,
    ])
    expect(once.selected?.summary.runRef).toBe(completed.runRef)
    expect(once.nextCursor).toBe(older.runRef)
    expect(once.message).toBeNull()
    expect(twice).toEqual(once)
  })

  it("accepts only an opaque runRef completion signal", () => {
    const signal = createCompletedRunSignalV1(RUN_ONE, "v01-test")
    expect(completedRunRefFromSignalV1(signal)).toBe(RUN_ONE)
    expect(
      completedRunRefFromSignalV1({
        ...signal,
        runRef: "pay_private-provider-id",
      }),
    ).toBeNull()
    expect(
      completedRunRefFromSignalV1({ ...signal, orderId: "order_private" }),
    ).toBeNull()
  })

  it("announces and returns one terminal current run from one GET", async () => {
    const calls: string[] = []
    const announced: string[] = []
    const runRef = await announceCurrentRecordedRunForRevisionV1({
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method}:${input.toString()}`)
        return new Response(JSON.stringify({
          schema: "onsale.current-recorded-run.v1",
          runRef: RUN_ONE,
          integrityRevision: `sha256:${"a".repeat(64)}`,
          terminal: true,
        }))
      },
      announce: (value) => announced.push(value),
    })
    expect(runRef).toBe(RUN_ONE)
    expect(calls).toEqual(["GET:/api/onsale/ops/current-run"])
    expect(announced).toEqual([RUN_ONE])
  })

  it("derives domain-separated SHA-256 aliases without exposing a payment UUID", () => {
    const paymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const runRef = recordedRunRefFromPaymentIdV1(paymentId)
    const eventRef = recordedEventRefFromSourceV1(paymentId)
    const evidenceRef = recordedEvidenceRefFromSourceV1(paymentId)
    const expected = createHash("sha256")
      .update(`onsale-recorded-run-v1:${paymentId}`, "utf8")
      .digest("hex")
      .slice(0, 24)

    expect(runRef).toBe(`run_${expected}`)
    expect(new Set([runRef.slice(4), eventRef.slice(4), evidenceRef.slice(3)]).size).toBe(3)
    expect(JSON.stringify({ runRef, eventRef, evidenceRef })).not.toContain(paymentId)
  })

  it("keeps retained Klarna and credit subtypes visible in the run adapter", () => {
    for (const [token, family, label] of [
      ["klarna", "pay_later", "Klarna"],
      ["credit", "card", "Credit"],
    ] as const) {
      const base = retainedTrace("1")
      const trace = parseRecordedRunTraceV1({
        ...base,
        payment: {
          ...base.payment,
          selectedMethod: selectedRecordedPaymentMethodV1(token),
        },
        limitations: [],
      })
      const summary = summarizeRecordedRunV1(
        trace,
        "2026-08-09T12:01:00.000Z",
      )
      expect(trace.payment.selectedMethod).toEqual({ family, type: token })
      expect(projectRecordedRunV1(summary, trace).run.method).toBe(label)
    }
  })

  it("returns RUN_NOT_FOUND for missing detail and an empty current-run read", async () => {
    const repository: RecordedRunsRepositoryV1 = {
      list: async () => ({
        schema: "onsale.recorded-runs.v1",
        items: [],
        page: { limit: 20, nextCursor: null },
      }),
      get: async () => undefined,
      current: async () => undefined,
      close: async () => undefined,
    }
    const session = Buffer.alloc(32).toString("base64url")
    const baseHeaders = {
      cookie: `onsale_session_v1=${session}`,
      "sec-fetch-site": "same-origin",
    }
    const detail = await handleRecordedRunDetailGetV1(
      new Request(`http://onsale-v01.localhost:4310/api/onsale/ops/runs/${RUN_ONE}`, {
        headers: baseHeaders,
      }),
      RUN_ONE,
      repository,
    )
    const current = await handleCurrentRecordedRunGetV1(
      new Request("http://onsale-v01.localhost:4310/api/onsale/ops/current-run", {
        headers: {
          ...baseHeaders,
          cookie: `${baseHeaders.cookie}; onsale_current_order_v1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        },
      }),
      repository,
    )

    expect(detail.status).toBe(404)
    expect((await detail.json()).error.code).toBe("RUN_NOT_FOUND")
    expect(current.status).toBe(200)
    expect(await current.json()).toEqual({
      schema: "onsale.current-recorded-run.v1",
      runRef: null,
      integrityRevision: null,
      terminal: false,
    })
  })

  it("uses the configured public origin across the private Portless socket", async () => {
    const repository: RecordedRunsRepositoryV1 = {
      list: async () => ({
        schema: "onsale.recorded-runs.v1",
        items: [],
        page: { limit: 20, nextCursor: null },
      }),
      get: async () => undefined,
      current: async () => undefined,
      close: async () => undefined,
    }
    const session = Buffer.alloc(32).toString("base64url")
    const request = (origin: string) =>
      new Request("http://127.0.0.1:4968/api/onsale/ops/runs", {
        headers: {
          cookie: `onsale_session_v1=${session}`,
          host: "attacker.example",
          origin,
          "sec-fetch-site": "same-origin",
        },
      })

    const throughPortless = await handleRecordedRunsListGetV1(
      request("http://onsale-v01.localhost:4310"),
      repository,
    )
    const attacker = await handleRecordedRunsListGetV1(
      request("https://attacker.example"),
      repository,
    )

    expect(throughPortless.status).toBe(200)
    expect(attacker.status).toBe(403)
    expect((await attacker.json()).error.code).toBe("REQUEST_ORIGIN_DENIED")
  })

  it("rejects duplicate list parameters before repository access", async () => {
    let listed = false
    const repository: RecordedRunsRepositoryV1 = {
      list: async () => {
        listed = true
        throw new Error("must not run")
      },
      get: async () => undefined,
      current: async () => undefined,
      close: async () => undefined,
    }
    const session = Buffer.alloc(32).toString("base64url")
    const response = await handleRecordedRunsListGetV1(
      new Request(
        "http://onsale-v01.localhost:4310/api/onsale/ops/runs?limit=20&limit=20",
        {
          headers: {
            cookie: `onsale_session_v1=${session}`,
            "sec-fetch-site": "same-origin",
          },
        },
      ),
      repository,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_REQUEST")
    expect(listed).toBe(false)
  })

  it("refreshes recordedAt from a later retained retrieve even without a new observation", async () => {
    const paymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const queries: string[] = []
    const client = {
      async query(text: string) {
        queries.push(text)
        if (
          text.startsWith("begin") ||
          text.startsWith("select set_config") ||
          text === "commit" ||
          text === "rollback"
        ) return { rows: [], rowCount: 0 }
        if (text.includes("order by recorded_at desc")) {
          return {
            rows: [{ payment_id: paymentId, recorded_at: "2026-08-09T12:05:00.000Z" }],
            rowCount: 1,
          }
        }
        if (text.includes("select pp.id as payment_id, o.state as order_state")) {
          return {
            rows: [{
              payment_id: paymentId,
              order_state: "awaiting_payment",
              item_count: "1",
              amount_minor: "18460",
              currency: "USD",
              canonical_state: "requires_payment_method",
              integrity_state: "clear",
              updated_at: "2026-08-09T12:00:00.000Z",
              recorded_at: "2026-08-09T12:05:00.000Z",
              selected_payment_method: null,
              observed_amount_minor: null,
              observed_currency: null,
              observed_charged_attempt_count: null,
              ticket_count: "0",
              ticket_issued_at: null,
            }],
            rowCount: 1,
          }
        }
        if (text.includes("select id, command_kind, created_at")) {
          return {
            rows: [
              { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", command_kind: "ensure_checkout", created_at: "2026-08-09T12:00:00.000Z" },
              { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", command_kind: "reconcile_payment", created_at: "2026-08-09T12:05:00.000Z" },
            ],
            rowCount: 2,
          }
        }
        if (text.includes("select id, public_ref, source, received_at")) {
          return { rows: [], rowCount: 0 }
        }
        if (text.includes("select distinct on (pa.id)")) {
          return { rows: [], rowCount: 0 }
        }
        if (text.includes("select pp.id as payment_id from")) {
          return { rows: [{ payment_id: paymentId }], rowCount: 1 }
        }
        throw new Error(`Unexpected query: ${text}`)
      },
      release() {},
    }
    const repository = new NeonRecordedRunsRepositoryV1({
      databaseUrl: "postgres://example.invalid/onsale",
      pool: { connect: async () => client, end: async () => undefined } as never,
    })

    const page = await repository.list("sess_test")
    const run = await repository.get(
      "sess_test",
      recordedRunRefFromPaymentIdV1(paymentId),
    )

    expect(page.items[0]?.recordedAt).toBe("2026-08-09T12:05:00.000Z")
    expect(page.items[0]?.amountReceivedMinor).toBeNull()
    expect(run?.trace.money.amountReceivedMinor).toBeNull()
    expect(run?.trace.events.some((event) => event.kind === "retrieve_requested")).toBe(true)
    expect(
      queries.some(
        (query) =>
          query.includes("max(co.created_at)") &&
          query.includes("max(po2.received_at)"),
      ),
    ).toBe(true)
    expect(
      queries.some(
        (query) =>
          query.includes("order by recorded_at desc") &&
          query.includes("max(co.created_at)") &&
          query.includes("max(po.received_at)"),
      ),
    ).toBe(true)
  })
})
