import { expect, test, type Page, type Route } from "@playwright/test"

import {
  parseRecordedRunTraceV1,
  recordedRunLimitationV1,
  summarizeRecordedRunV1,
  type RecordedRunTraceV1,
  type RecordedRunsPageV1,
} from "../../src/onsale/contracts/recorded-run-v1"

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }
const RUN_OLDER = "run_111111111111111111111111"
const RUN_COMPLETED = "run_222222222222222222222222"

function retainedRun(
  runRef: typeof RUN_OLDER | typeof RUN_COMPLETED,
  seed: "1" | "2",
): RecordedRunTraceV1 {
  const succeeded = seed === "2"
  const event = (sequence: number, kind: string, edge: string | null) => ({
    eventRef: `evt_${seed.repeat(23)}${sequence}`,
    sequence,
    occurredAt: `2026-08-09T12:0${sequence}:0${seed}.000Z`,
    kind,
    edge,
    replayable: edge !== null,
    attemptOrdinal: null,
    authority:
      kind === "tickets_issued" ? "merchant_database" : "merchant_server",
    evidenceRef: `ev_${seed.repeat(23)}${sequence}`,
  })
  return parseRecordedRunTraceV1({
    schema: "onsale.recorded-run.v1",
    runRef,
    population: "local_browser",
    integrityRevision: `sha256:${seed.repeat(64)}`,
    order: {
      state: succeeded ? "fulfilled" : "awaiting_payment",
      itemCount: 1,
    },
    payment: {
      state: succeeded ? "succeeded" : "requires_method",
      selectedMethod: succeeded ? { family: "card", type: "credit" } : null,
    },
    money: {
      currency: "USD",
      amountDueMinor: 18_460,
      amountReceivedMinor: succeeded ? 18_460 : null,
    },
    attempts: succeeded
      ? [
          {
            ordinal: 1,
            method: { family: "card", type: "credit" },
            connector: "stripe_test",
            outcome: "succeeded",
            charged: true,
            failureClass: null,
            evidenceRef: `ev_${seed.repeat(24)}`,
          },
        ]
      : [],
    events: succeeded
      ? [
          event(1, "create_requested", "merchant_hyperswitch"),
          event(2, "retrieve_requested", "hyperswitch_retrieve"),
          event(3, "tickets_issued", null),
        ]
      : [event(1, "create_requested", "merchant_hyperswitch")],
    consequence: {
      chargeCount: succeeded ? 1 : 0,
      ticketCount: succeeded ? 1 : 0,
      ticketState: succeeded ? "issued" : "not_issued",
    },
    replay: { eligible: true, basis: "retained_operation_order" },
    limitations: [
      ...(succeeded ? [] : [recordedRunLimitationV1("METHOD_NOT_RETAINED")]),
      ...(succeeded
        ? [recordedRunLimitationV1("STATIC_FACTS_NOT_CAUSAL")]
        : []),
    ],
  })
}

function pageFor(
  traces: readonly RecordedRunTraceV1[],
): RecordedRunsPageV1 {
  return {
    schema: "onsale.recorded-runs.v1",
    items: traces.map((trace, index) =>
      summarizeRecordedRunV1(
        trace,
        `2026-08-09T12:${String(20 - index).padStart(2, "0")}:00.000Z`,
      ),
    ),
    page: { limit: 20, nextCursor: null },
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

async function installRecordedRuns(
  page: Page,
  initial: RecordedRunTraceV1,
  completed: RecordedRunTraceV1,
) {
  let completedVisible = false
  const requests: Array<{ method: string; pathname: string }> = []

  await page.route("**/api/onsale/ops/current-run", async (route) => {
    requests.push({
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
    })
    await fulfillJson(
      route,
      {
        schema: "onsale.recorded-runs-error.v1",
        ok: false,
        error: {
          code: "RUN_NOT_FOUND",
          message: "The retained run was not found.",
        },
      },
      404,
    )
  })
  await page.route(/\/api\/onsale\/ops\/runs\/run_[0-9a-f]{24}$/u, async (route) => {
    const runRef = new URL(route.request().url()).pathname.split("/").at(-1)
    requests.push({
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
    })
    await fulfillJson(route, runRef === completed.runRef ? completed : initial)
  })
  await page.route(/\/api\/onsale\/ops\/runs\?limit=20/u, async (route) => {
    requests.push({
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
    })
    await fulfillJson(
      route,
      pageFor(completedVisible ? [completed, initial] : [initial]),
    )
  })

  return {
    revealCompleted() {
      completedVisible = true
    },
    requests,
  }
}

test("Recorded Runs stays static on selection, replays explicitly, and merges the just-completed run", async ({
  page,
}) => {
  const older = retainedRun(RUN_OLDER, "1")
  const completed = retainedRun(RUN_COMPLETED, "2")
  const api = await installRecordedRuns(page, older, completed)

  await page.goto("/flows")
  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_OLDER)
  await expect(page.locator(".payment-trace-token")).toHaveCount(0)

  await page.getByTestId("replay-play").click()
  await expect(page.locator(".payment-trace-token")).toHaveCount(1)

  api.revealCompleted()
  await page.evaluate((runRef) => {
    window.dispatchEvent(
      new CustomEvent("onsale:completed-run:v1", {
        detail: {
          schema: "onsale.completed-run.v1",
          runRef,
          signalId: "browser-completion-proof",
        },
      }),
    )
  }, RUN_COMPLETED)

  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_COMPLETED)
  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_OLDER)
  await expect(page.locator(".payment-trace-token")).toHaveCount(0)
  expect(api.requests.every((request) => request.method === "GET")).toBe(true)
})

test("Recorded Runs uses a quiet skeleton while the durable read is pending", async ({
  page,
}) => {
  const older = retainedRun(RUN_OLDER, "1")
  let releaseList: (() => void) | undefined
  const listGate = new Promise<void>((resolve) => { releaseList = resolve })
  await page.route("**/api/onsale/ops/current-run", async (route) => {
    await fulfillJson(route, {
      schema: "onsale.current-recorded-run.v1",
      runRef: null,
      integrityRevision: null,
      terminal: false,
    })
  })
  await page.route(/\/api\/onsale\/ops\/runs\?limit=20/u, async (route) => {
    await listGate
    await fulfillJson(route, pageFor([older]))
  })
  await page.route(`**/api/onsale/ops/runs/${RUN_OLDER}`, async (route) => {
    await fulfillJson(route, older)
  })

  await page.goto("/flows")
  await expect(page.getByTestId("flows-run-skeleton")).toHaveCount(3)
  await expect(page.getByTestId("flows-ledger")).toContainText("Loading runs")
  await expect(page.getByTestId("flows-ledger")).toContainText(
    "Awaiting retained payment evidence",
  )
  await expect(page.getByTestId("flows-ledger")).not.toContainText(
    "Loading durable runs",
  )
  await expect(page.getByTestId("flows-ledger")).not.toContainText(
    "The recorded ledger has not been loaded",
  )
  await expect(
    page.getByRole("button", { name: "RETRY DURABLE LEDGER" }),
  ).toHaveCount(0)
  releaseList?.()
  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_OLDER)
})

test("Story Lab restores six business cases and keeps the method-versus-connector lab explicit", async ({
  page,
}) => {
  const older = retainedRun(RUN_OLDER, "1")
  await installRecordedRuns(page, older, older)
  await page.goto("/flows")
  await page.getByRole("button", { name: /STORY LAB Curated demos/iu }).click()

  for (const id of [
    "confirmed-payment",
    "action-required",
    "terminal-decline",
    "lost-response-recovery",
    "fixture-label-counterexample",
    "checkout-configuration-boundary",
  ]) {
    await expect(page.getByTestId(`flow-option-${id}`)).toBeVisible()
  }

  await page.getByTestId("flow-option-fixture-label-counterexample").click()
  await expect(page.getByRole("heading", { name: "Method versus connector lab" })).toBeVisible()
  await expect(page.getByTestId("flows-replay")).toContainText("THE PROBLEM")
  await expect(page.getByTestId("flows-replay")).toContainText("HYPERSWITCH ROLE")
  await expect(page.getByTestId("flows-replay")).toContainText("WHY IT MATTERS")
  await expect(page.getByTestId("flows-replay")).toContainText("FAUXPAY")
  await expect(page.getByTestId("flows-replay")).toContainText("STRIPE_TEST")
  await expect(page.getByTestId("flows-proof")).toContainText("LOCAL SIMULATION")
  await expect(page.locator(".payment-trace-token")).toHaveCount(0)
})

test("an exact later-page run target selects that run without hiding the durable ledger", async ({
  page,
}) => {
  const older = retainedRun(RUN_OLDER, "1")
  const completed = retainedRun(RUN_COMPLETED, "2")
  let releaseDetail: (() => void) | undefined
  const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve })

  await page.route(`**/api/onsale/ops/runs/${RUN_COMPLETED}`, async (route) => {
    await detailGate
    await fulfillJson(route, completed)
  })
  await page.route(/\/api\/onsale\/ops\/runs\?limit=20/u, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    await fulfillJson(
      route,
      cursor === null
        ? {
            ...pageFor([older]),
            page: { limit: 20, nextCursor: older.runRef },
          }
        : pageFor([completed]),
    )
  })

  await page.goto(`/flows?run=${RUN_COMPLETED}`)
  await expect(page.getByRole("heading", {
    name: "Resolving the requested retained run",
  })).toBeVisible()
  await expect(page.getByTestId("flows-ledger")).not.toContainText(RUN_OLDER)

  releaseDetail?.()
  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_COMPLETED)
  await expect(page.getByTestId("flows-ledger")).toContainText(RUN_OLDER)
  await expect(page.getByRole("heading", {
    name: `Run ${RUN_COMPLETED.slice(-6).toUpperCase()}`,
  })).toBeVisible()
})

test("a cross-buyer exact target renders not-found and never walks or substitutes the visible ledger", async ({
  page,
}) => {
  let listReads = 0
  await page.route(`**/api/onsale/ops/runs/${RUN_COMPLETED}`, async (route) => {
    await fulfillJson(route, {
      schema: "onsale.recorded-runs-error.v1",
      ok: false,
      error: {
        code: "RUN_NOT_FOUND",
        message: "The retained run was not found.",
      },
    }, 404)
  })
  await page.route(/\/api\/onsale\/ops\/runs\?limit=20/u, async (route) => {
    listReads += 1
    await fulfillJson(route, pageFor([retainedRun(RUN_OLDER, "1")]))
  })

  await page.goto(`/flows?run=${RUN_COMPLETED}`)
  await expect(page.getByRole("heading", {
    name: "Requested run is not available",
  })).toBeVisible()
  await expect(page.getByTestId("flows-ledger")).not.toContainText(RUN_OLDER)
  expect(listReads).toBe(0)
})
