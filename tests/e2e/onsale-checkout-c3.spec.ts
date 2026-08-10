import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test"

import {
  allSeats,
  InventoryApiHarness,
  makeHold,
  makeSnapshot,
  shaRevision,
  snapshotWithHold,
} from "./fixtures/inventory-api"

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }

function readyCheckout(
  index: number,
  paymentDeadlineAt = new Date(Date.now() + 5 * 60_000).toISOString(),
) {
  return {
    schema: "onsale.checkout-private.v1",
    ok: true,
    stage: "checkout_ready",
    order: {
      state: "payment_pending",
      paymentDeadlineAt,
      currency: "USD",
      subtotalMinor: 36_000,
      feeMinor: 4_000,
      taxMinor: 1_000,
      totalMinor: 41_000,
      itemCount: 2,
      items: [1, 2].map((seat) => ({
        sectionLabel: "Orchestra",
        rowLabel: "A",
        seatLabel: String(seat),
        priceTier: "Standard",
        faceValueMinor: 18_000,
        feeMinor: 2_000,
        taxMinor: 500,
        totalMinor: 20_500,
        currency: "USD",
      })),
      ticketCount: 0,
    },
    payment: {
      canonicalState: "requires_method",
      integrityState: "clear",
      observationSource: index === 1 ? "create" : "retrieve",
      selectedMethod: null,
      observedConnector: null,
      attempts: [
        {
          ordinal: 1,
          state: "requires_method",
          charged: false,
          hardDecline: false,
          connector: null,
        },
      ],
      chargedAttemptCount: 0,
      evidenceGeneration: index,
      retryPermitted: true,
      retryReason: "official_checkout_submission_available",
      evidenceRevision: shaRevision(900 + index),
    },
    checkout: {
      clientSecret: `secret_client_mock_${index}_123456`,
      publishableKey: `pk_snd_mock_${index}_123456`,
    },
    message: "SECURE CHECKOUT READY",
  }
}

function expiredCheckout(index: number, paymentDeadlineAt: string) {
  const ready = readyCheckout(index, paymentDeadlineAt)
  return {
    ...ready,
    stage: "expired",
    payment: {
      ...ready.payment,
      observationSource: "retrieve",
      retryPermitted: false,
      retryReason: "checkout_deadline_elapsed",
    },
    checkout: null,
    message: "CHECKOUT TIME EXPIRED",
  }
}

const completedOrderItems = [
  { sectionLabel: "Orchestra", rowLabel: "A", seatLabel: "1" },
  { sectionLabel: "Orchestra", rowLabel: "A", seatLabel: "2" },
  { sectionLabel: "Mezzanine", rowLabel: "B", seatLabel: "7" },
  { sectionLabel: "Balcony", rowLabel: "C", seatLabel: "12" },
] as const

function fulfilledCheckout(index: number) {
  const items = completedOrderItems.map((item) => ({
    ...item,
    priceTier: "Standard",
    faceValueMinor: 18_000,
    feeMinor: 2_000,
    taxMinor: 500,
    totalMinor: 20_500,
    currency: "USD",
  }))
  return {
    schema: "onsale.checkout-private.v1",
    ok: true,
    stage: "fulfilled",
    order: {
      state: "fulfilled",
      paymentDeadlineAt: "2030-08-09T03:00:00.000Z",
      currency: "USD",
      subtotalMinor: 72_000,
      feeMinor: 8_000,
      taxMinor: 2_000,
      totalMinor: 82_000,
      itemCount: items.length,
      items,
      ticketCount: items.length,
    },
    payment: {
      canonicalState: "succeeded",
      integrityState: "clear",
      observationSource: "retrieve",
      selectedMethod: { family: "card", type: "credit" },
      observedConnector: "stripe_test",
      attempts: [
        {
          ordinal: 1,
          state: "succeeded",
          charged: true,
          hardDecline: false,
          connector: "stripe_test",
        },
      ],
      chargedAttemptCount: 1,
      evidenceGeneration: index,
      retryPermitted: false,
      retryReason: "payment_already_fulfilled",
      evidenceRevision: shaRevision(1_000 + index),
    },
    checkout: null,
    message: "TICKETS ISSUED",
  }
}

function reviewRequiredCheckout(index: number) {
  const ready = readyCheckout(index)
  return {
    ...ready,
    stage: "review_required",
    payment: {
      ...ready.payment,
      canonicalState: "uncertain",
      integrityState: "review_required",
      observationSource: "retrieve",
      selectedMethod: { family: "card", type: "credit" },
      observedConnector: "stripe_test",
      attempts: [
        {
          ordinal: 1,
          state: "uncertain",
          charged: false,
          hardDecline: false,
          connector: "stripe_test",
        },
      ],
      evidenceGeneration: index,
      retryPermitted: false,
      retryReason: "integrity_review_required",
      evidenceRevision: shaRevision(1_100 + index),
    },
    checkout: null,
    message: "PAYMENT REVIEW REQUIRED",
  }
}

const missingOrder = {
  schema: "onsale.checkout-private.v1",
  ok: false,
  error: {
    code: "ORDER_NOT_FOUND",
    message: "The checkout pointer no longer resolves.",
    retryable: false,
  },
}

const officialSdkMock = String.raw`
(() => {
  window.__onsaleConfirmCount = 0;
  window.__onsaleConfirmPending = [];
  window.__onsaleConfirmCalls = [];
  window.__onsaleHyperLoads = [];
  window.__settleOfficialConfirm = (mode) => {
    const pending = window.__onsaleConfirmPending.shift();
    if (!pending) throw new Error("No official confirmation is pending");
    if (mode === "throw") pending.reject(new Error("mock provider throw"));
    else pending.resolve({ ignoredSdkResult: true });
  };
  window.Hyper = function (publishableKey, options) {
    window.__onsaleHyperLoads.push({ publishableKey, options });
    const listeners = new Map();
    const widget = {
      on(name, callback) {
        listeners.set(name, callback);
      },
      mount(selector) {
        const target = document.querySelector(selector);
        if (target) target.textContent = "OFFICIAL HYPERSWITCH MOCK";
        setTimeout(() => {
          const ready = listeners.get("ready");
          const change = listeners.get("change");
          if (typeof ready === "function") ready();
          if (typeof change === "function") change({ complete: true });
        }, 0);
      },
      unmount() {}, destroy() {}, update() {}, collapse() {}, blur() {},
      focus() {}, clear() {}, onSDKHandleClick() {},
    };
    const elements = {
      options: {}, update() {}, getElement() { return widget; },
      fetchUpdates() { return Promise.resolve({}); },
      create() { return widget; },
    };
    return {
      elements() { return elements; },
      initPaymentSession() { return Promise.resolve({}); },
      confirmPayment(payload) {
        window.__onsaleConfirmCount += 1;
        window.__onsaleConfirmCalls.push({
          returnUrl: payload && payload.confirmParams && payload.confirmParams.return_url,
          redirect: payload && payload.redirect,
          hasOfficialElements: Boolean(payload && payload.elements),
        });
        return new Promise((resolve, reject) => {
          window.__onsaleConfirmPending.push({ resolve, reject });
        });
      },
      confirmCardPayment() { return Promise.resolve({}); },
      retrievePaymentIntent() { return Promise.resolve({}); },
      paymentRequest() { return {}; },
      completeUpdateIntent() { return Promise.resolve({}); },
      initiateUpdateIntent() { return Promise.resolve({}); },
    };
  };
})();
`

async function installOfficialSdkMock(page: Page): Promise<void> {
  await page.route("https://beta.hyperswitch.io/v1/HyperLoader.js", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/javascript" },
      body: officialSdkMock,
    }),
  )
}

async function installActiveHold(page: Page, seatCount = 2): Promise<void> {
  const inventory = makeSnapshot(800)
  const hold = makeHold(
    inventory,
    allSeats(inventory)
      .slice(0, seatCount)
      .map((seat) => seat.publicRef),
  )
  const api = new InventoryApiHarness(snapshotWithHold(inventory, hold, 801))
  await api.install(page)
}

async function installTerminalCheckout(
  page: Page,
  snapshot: (index: number) => unknown,
  seatCount = 2,
) {
  await installActiveHold(page, seatCount)
  const providerRequests: string[] = []
  const reconcileBodies: Record<string, unknown>[] = []
  let reconcileCount = 0

  await page.route(
    /^https:\/\/(?:[^/]+\.)?(?:hyperswitch\.io|juspay\.io)\//u,
    async (route) => {
      providerRequests.push(route.request().url())
      await route.abort()
    },
  )
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    reconcileBodies.push(JSON.parse(route.request().postData() ?? "{}"))
    await fulfillJson(route, snapshot(reconcileCount))
  })

  return {
    providerRequests,
    reconcileBodies,
    reconcileCount: () => reconcileCount,
  }
}

async function installCheckoutReady(page: Page): Promise<void> {
  await installActiveHold(page)
  await installOfficialSdkMock(page)
  let reconcileCount = 0
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    await fulfillJson(route, readyCheckout(reconcileCount))
  })
}

async function expectNoCheckoutSecretsExposed(page: Page): Promise<void> {
  const exposed = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    location: window.location.href,
    localStorage: Object.entries(window.localStorage),
    sessionStorage: Object.entries(window.sessionStorage),
    readableCookies: document.cookie,
  }))
  const serialized = JSON.stringify(exposed)

  for (const forbidden of [
    "secret_client_mock_1_123456",
    "pk_snd_mock_1_123456",
    "orderId",
    "paymentId",
    "paymentAttemptId",
    "merchantId",
    "profileId",
  ]) {
    expect(
      serialized,
      `${forbidden} must remain outside browser surfaces`,
    ).not.toContain(forbidden)
  }
}

async function seedCheckoutCookies(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "onsale_session_v1",
      value: "mock_session_cookie",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "onsale_current_order_v1",
      value: "mock_order_pointer",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

test("ORDER_NOT_FOUND after checkout-ready revokes the mounted grant", async ({
  page,
}) => {
  await installActiveHold(page)
  await installOfficialSdkMock(page)
  let reconcileCount = 0
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    await fulfillJson(
      route,
      reconcileCount === 1 ? readyCheckout(1) : missingOrder,
      reconcileCount === 1 ? 200 : 404,
    )
  })

  await page.goto("/")
  const pay = page.getByTestId("official-checkout-submit")
  await expect(pay).toBeEnabled()
  await expect(page.getByTestId("official-checkout-widget")).toContainText(
    "OFFICIAL HYPERSWITCH MOCK",
  )

  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  )

  await expect.poll(() => reconcileCount).toBe(2)
  await expect(page.getByTestId("official-checkout-widget")).toHaveCount(0)
  await expect(pay).toHaveCount(0)
  await expect(page.getByTestId("inventory-failure-status")).toContainText(
    "The checkout pointer no longer resolves.",
  )
})

test("checkout-pointer loss on reload discards checkout memory and returns to the held order", async ({
  context,
  page,
}) => {
  await installActiveHold(page)
  await installOfficialSdkMock(page)
  await seedCheckoutCookies(context)
  let reconcileCount = 0
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    const hasOrderPointer = (
      await route.request().allHeaders()
    ).cookie?.includes("onsale_current_order_v1=")
    await fulfillJson(
      route,
      hasOrderPointer ? readyCheckout(1) : missingOrder,
      hasOrderPointer ? 200 : 404,
    )
  })

  await page.goto("/")
  await expect(page.getByTestId("official-checkout-submit")).toBeEnabled()
  await expect(page.getByTestId("official-checkout-widget")).toContainText(
    "OFFICIAL HYPERSWITCH MOCK",
  )

  await context.clearCookies({ name: "onsale_current_order_v1" })
  expect((await context.cookies()).map((cookie) => cookie.name)).toEqual([
    "onsale_session_v1",
  ])
  await page.reload()

  await expect.poll(() => reconcileCount).toBe(2)
  await expect(page.getByTestId("official-checkout-widget")).toHaveCount(0)
  await expect(page.getByTestId("official-checkout-submit")).toHaveCount(0)
  await expect(page.getByTestId("inventory-hold-screen")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "CONTINUE TO SECURE CHECKOUT →" }),
  ).toBeEnabled()
  await expect(page.getByTestId("inventory-failure-status")).toHaveCount(0)
  await expectNoCheckoutSecretsExposed(page)
})

test("ONSALE home returns to the event without discarding the current checkout", async ({
  page,
}) => {
  await installCheckoutReady(page)
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Secure checkout" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "ONSALE home" }).click()

  await expect(
    page.getByRole("heading", { name: "PHANTOM CIRCUIT" }),
  ).toBeVisible()
  await expect(page.getByTestId("official-checkout-widget")).toHaveCount(0)
  const resume = page.getByRole("button", {
    name: "RESUME SECURE CHECKOUT →",
  })
  await expect(resume).toBeVisible()
  await expect(page.getByTestId("inventory-checkout-resume")).toContainText(
    "YOUR ORDER IS SAVED",
  )

  await resume.click()
  await expect(
    page.getByRole("heading", { name: "Secure checkout" }),
  ).toBeVisible()
  await expect(page.getByTestId("official-checkout-widget")).toContainText(
    "OFFICIAL HYPERSWITCH MOCK",
  )
})

test("fulfilled checkout renders a four-item buyer ticket wallet without engineering payment facts", async ({
  page,
}) => {
  const completedRunRef = "run_0123456789abcdef01234567"
  await page.addInitScript(() => {
    const state = window as unknown as { __onsalePrintCount: number }
    state.__onsalePrintCount = 0
    window.print = () => {
      state.__onsalePrintCount += 1
    }
  })
  const terminal = await installTerminalCheckout(page, fulfilledCheckout, 4)
  await page.route("**/api/onsale/ops/current-run", async (route) => {
    await fulfillJson(route, {
      schema: "onsale.current-recorded-run.v1",
      runRef: completedRunRef,
      integrityRevision: shaRevision(9_001),
      terminal: true,
    })
  })

  await page.goto("/")

  const terminalHeading = page.getByRole("heading", {
    name: "Your tickets are ready.",
  })
  await expect(terminalHeading).toBeFocused()
  await expect(terminalHeading).toHaveCSS("outline-style", "none")
  const flowsLink = page.getByRole("link", { name: "FLOWS" })
  await expect(flowsLink).toHaveCSS("background-color", "rgb(0, 109, 249)")
  await expect(flowsLink).toHaveCSS("color", "rgb(255, 255, 255)")
  expect((await flowsLink.boundingBox())?.height).toBeGreaterThanOrEqual(32)
  await expect(
    page.getByText("4 tickets confirmed for PHANTOM CIRCUIT."),
  ).toBeVisible()
  await expect(page.locator(".production-ticket-wallet-header")).toContainText(
    "4 of 4 tickets issued",
  )

  const passes = page.locator(".production-ticket-pass")
  await expect(passes).toHaveCount(completedOrderItems.length)
  for (const [index, item] of completedOrderItems.entries()) {
    const pass = passes.nth(index)
    await expect(pass).toContainText(
      `TICKET ${String(index + 1).padStart(2, "0")} OF 04`,
    )
    await expect(
      pass.getByText(item.sectionLabel, { exact: true }),
    ).toBeVisible()
    await expect(
      pass.getByText(`ROW ${item.rowLabel} · SEAT ${item.seatLabel}`, {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      pass.getByLabel(
        `Presentation QR placeholder for row ${item.rowLabel}, seat ${item.seatLabel}`,
      ),
    ).toBeVisible()
  }
  await expect(page.locator(".production-ticket-qr")).toHaveCount(4)
  await expect(page.locator(".production-ticket-disclaimer")).toContainText(
    "Presentation ticket visuals only · not valid for venue entry",
  )
  await expect(page.locator(".production-ticket-disclaimer")).toContainText(
    "no entry credential is exposed by this prototype",
  )

  await expect(
    page.getByRole("button", { name: "BUY ANOTHER TICKET →" }),
  ).toBeVisible()
  const print = page.getByRole("button", { name: "PRINT / SAVE SUMMARY" })
  await expect(print).toBeVisible()
  await print.click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __onsalePrintCount?: number })
            .__onsalePrintCount ?? 0,
      ),
    )
    .toBe(1)
  await expect(
    page.getByRole("link", {
      name: "OPEN THIS RECORDED PAYMENT",
      exact: true,
    }),
  ).toHaveAttribute("href", `/flows?run=${completedRunRef}`)
  await expect(
    page
      .locator(".onsale-breadcrumb-steps")
      .getByRole("button", { name: "RESULT", exact: true }),
  ).toBeVisible()

  const buyerCanvas = page.locator(".onsale-canvas")
  await expect(buyerCanvas.locator(".production-payment-facts")).toHaveCount(0)
  await expect(buyerCanvas).not.toContainText(/selected method/iu)
  await expect(buyerCanvas).not.toContainText(/observed connector/iu)
  await expect(buyerCanvas).not.toContainText(/charged attempts/iu)
  await expect(buyerCanvas).not.toContainText(/evidence revision/iu)
  await expect(page.getByTestId("official-checkout-submit")).toHaveCount(0)
  await expect(page.getByTestId("official-checkout-widget")).toHaveCount(0)
  expect(terminal.providerRequests).toEqual([])
})

test("review-required checkout keeps the same payment recoverable without a stale grant or ticket", async ({
  page,
}) => {
  const terminal = await installTerminalCheckout(page, reviewRequiredCheckout)

  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "We need to review this order." }),
  ).toBeFocused()
  await expect(
    page.locator('[data-checkout-stage="review_required"]'),
  ).toContainText(
    "Payment is blocked until the order status can be confirmed safely.",
  )
  const statusCheck = page.getByRole("button", {
    name: "CHECK SAME PAYMENT STATUS →",
  })
  await expect(statusCheck).toBeEnabled()
  await statusCheck.click()
  await expect.poll(terminal.reconcileCount).toBe(2)
  await expect(statusCheck).toBeEnabled()
  expect(terminal.reconcileBodies.map((body) => body.trigger)).toEqual([
    "resume",
    "refresh",
  ])

  await expect(page.locator(".production-ticket-wallet")).toHaveCount(0)
  await expect(page.locator(".production-ticket-pass")).toHaveCount(0)
  await expect(page.getByTestId("official-checkout-submit")).toHaveCount(0)
  await expect(page.getByTestId("official-checkout-widget")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /BUY ANOTHER|START (?:A )?NEW/iu }),
  ).toHaveCount(0)
  expect(terminal.providerRequests).toEqual([])

  await page.getByRole("button", { name: "ONSALE home" }).click()
  await expect(
    page.getByRole("heading", { name: "PHANTOM CIRCUIT" }),
  ).toBeVisible()
  await expect(page.getByTestId("inventory-event-notice")).toContainText(
    "CHECKOUT SAVED · RETURN TO THIS SAME PAYMENT WHEN YOU ARE READY",
  )
  const resume = page.getByRole("button", {
    name: "RESUME SECURE CHECKOUT →",
  })
  await expect(resume).toBeVisible()
  await resume.click()
  await expect(
    page.getByRole("heading", { name: "We need to review this order." }),
  ).toBeFocused()
  await expect(page.locator(".production-ticket-wallet")).toHaveCount(0)
  await expect(page.getByTestId("official-checkout-submit")).toHaveCount(0)
  expect(terminal.providerRequests).toEqual([])
})

test("Figma production entry prepares the held order and StrictMode keeps focus on Secure checkout", async ({
  page,
}) => {
  const inventory = new InventoryApiHarness()
  await inventory.install(page)
  await installOfficialSdkMock(page)
  const prepareRequests: Record<string, unknown>[] = []
  let releasePrepare: () => void
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve
  })

  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    await fulfillJson(route, missingOrder, 404)
  })
  await page.route("**/api/onsale/checkout/prepare", async (route) => {
    prepareRequests.push(JSON.parse(route.request().postData() ?? "{}"))
    await prepareGate
    await fulfillJson(route, readyCheckout(1))
  })

  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "PHANTOM CIRCUIT" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "VIEW LIVE SEATS →" }).click()

  const seats = page.locator("[data-inventory-seat]")
  await seats.nth(0).click()
  await seats.nth(1).click()
  const hold = page.getByRole("button", { name: "HOLD 2 SEATS — $410 →" })
  await expect(hold).toBeEnabled()
  await hold.click()
  await expect(
    page.getByText("INVENTORY HOLD ACTIVE", { exact: true }),
  ).toBeVisible()

  await page
    .getByRole("button", { name: "CONTINUE TO SECURE CHECKOUT →" })
    .click()

  const preparingRail = page.getByTestId("production-payment-rail")
  try {
    await expect(preparingRail).toContainText(
      "Buyer asked ONSALE to secure the held order",
    )
    await expect(
      preparingRail.locator(".payment-trace-map"),
    ).toHaveAttribute("data-playback", "live")
    await expect(
      preparingRail.locator(".payment-trace-token"),
    ).toHaveCount(1)
    await expect(preparingRail).toContainText("Outcome remains unknown")
    await expect(preparingRail).not.toContainText("tickets issued")
  } finally {
    releasePrepare!()
  }

  const heading = page.getByRole("heading", { name: "Secure checkout" })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  await expect(page.getByTestId("official-checkout-widget")).toContainText(
    "OFFICIAL HYPERSWITCH MOCK",
  )
  await expect(page.getByTestId("official-checkout-submit")).toBeEnabled()
  await expect(page.locator("body")).toContainText(
    "hyperswitch · unified checkout",
  )
  await expect(page.locator("body")).not.toContainText("SIMULATE PAYMENT")
  await expect(page.locator("body")).not.toContainText("tls")

  expect(prepareRequests).toHaveLength(1)
  expect(prepareRequests[0].holdRef).toBe(
    inventory.snapshot.currentHold?.publicRef,
  )
  expect(prepareRequests[0].commandId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  await expectNoCheckoutSecretsExposed(page)
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
] as const) {
  test(`official checkout has no horizontal overflow at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await installCheckoutReady(page)
    await page.goto("/")
    await expect(
      page.getByRole("heading", { name: "Secure checkout" }),
    ).toBeVisible()
    await expect(page.getByTestId("official-checkout-widget")).toContainText(
      "OFFICIAL HYPERSWITCH MOCK",
    )

    const layout = await page.evaluate(() => {
      const shellBody =
        document.querySelector<HTMLElement>(".onsale-shell-body")
      const buyer = document.querySelector<HTMLElement>(".onsale-buyer-pane")
      const canvas = document.querySelector<HTMLElement>(".onsale-canvas")
      const rail = document.querySelector<HTMLElement>(".onsale-rail")
      const submit = document.querySelector<HTMLElement>(
        '[data-testid="official-checkout-submit"]',
      )
      if (!shellBody || !buyer || !canvas || !rail || !submit) {
        throw new Error("Responsive shell fixture did not render")
      }

      const directTextElements = [
        rail,
        ...Array.from(rail.querySelectorAll("*")),
      ]
        .filter((element) =>
          Array.from(element.childNodes).some(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          ),
        )
        .filter((element) => {
          const style = getComputedStyle(element)
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            element.getClientRects().length > 0
          )
        })
      const railFontSizes = directTextElements.map((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      )

      const shellRect = shellBody.getBoundingClientRect()
      const buyerRect = buyer.getBoundingClientRect()
      const railRect = rail.getBoundingClientRect()
      const visibleRailControls = Array.from(
        rail.querySelectorAll<HTMLElement>(
          "button.payment-trace-node, summary, a.production-rail-replay",
        ),
      ).filter((control) => control.getClientRects().length > 0)
      const lastRailControl = visibleRailControls.at(-1)
      if (!lastRailControl)
        throw new Error("Mechanism rail has no reachable control")
      lastRailControl.scrollIntoView({ block: "center" })
      lastRailControl.focus()
      const controlRect = lastRailControl.getBoundingClientRect()

      submit.scrollIntoView({ block: "nearest" })
      submit.focus()
      const submitRect = submit.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()

      return {
        viewportWidth: document.documentElement.clientWidth,
        rootWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        railOverflow: rail.scrollWidth - rail.clientWidth,
        buyerOverflowMode: getComputedStyle(buyer).overflowX,
        canvasOverflowMode: getComputedStyle(canvas).overflowX,
        buyerWidthRatio: buyerRect.width / shellRect.width,
        railWidthRatio: railRect.width / shellRect.width,
        buyerHeightRatio: buyerRect.height / shellRect.height,
        railHeightRatio: railRect.height / shellRect.height,
        railBelowBuyer: railRect.top >= buyerRect.bottom,
        minimumRailFontSize: Math.min(...railFontSizes),
        railTextElementCount: railFontSizes.length,
        lastRailControlReachable:
          controlRect.top >= railRect.top - 1 &&
          controlRect.bottom <= railRect.bottom + 1,
        submitReachable:
          submitRect.top >= canvasRect.top - 1 &&
          submitRect.bottom <= canvasRect.bottom + 1,
      }
    })

    expect(layout.rootWidth).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.railOverflow).toBeLessThanOrEqual(0)
    expect(layout.buyerOverflowMode).toBe("hidden")
    expect(layout.canvasOverflowMode).toBe("hidden")
    expect(layout.railTextElementCount).toBeGreaterThan(20)
    expect(layout.submitReachable).toBe(true)

    if (viewport.width === 1440) {
      expect(layout.buyerWidthRatio).toBeCloseTo(0.72, 2)
      expect(layout.railWidthRatio).toBeCloseTo(0.28, 2)
      expect(layout.railBelowBuyer).toBe(false)
    } else {
      expect(layout.minimumRailFontSize).toBeGreaterThanOrEqual(10)
      expect(layout.lastRailControlReachable).toBe(true)
      if (viewport.width === 768) {
        expect(layout.buyerWidthRatio).toBeCloseTo(0.6, 2)
        expect(layout.railWidthRatio).toBeCloseTo(0.4, 2)
        expect(layout.railBelowBuyer).toBe(false)
      } else {
        expect(layout.buyerHeightRatio).toBeCloseTo(0.68, 2)
        expect(layout.railHeightRatio).toBeCloseTo(0.32, 2)
        expect(layout.railBelowBuyer).toBe(true)
      }
    }
    await expectNoCheckoutSecretsExposed(page)
  })
}

for (const activation of ["Enter", "requestSubmit"] as const) {
  test(`${activation} plus an immediate click authorizes one official confirm`, async ({
    page,
  }) => {
    await installCheckoutReady(page)
    await page.goto("/")
    const pay = page.getByTestId("official-checkout-submit")
    const form = page.locator("form.official-checkout-form")
    await expect(pay).toBeEnabled()
    await pay.focus()
    const box = await pay.boundingBox()
    expect(box).not.toBeNull()

    const firstActivation =
      activation === "Enter"
        ? page.keyboard.press("Enter")
        : form.evaluate((node) => (node as HTMLFormElement).requestSubmit())
    await Promise.all([
      firstActivation,
      page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2),
    ])

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __onsaleConfirmCount?: number })
              .__onsaleConfirmCount ?? 0,
        ),
      )
      .toBe(1)
    await expect(pay).toBeDisabled()
    const rail = page.getByTestId("production-payment-rail")
    const map = rail.locator(".payment-trace-map")
    await expect(map).toHaveAttribute("data-playback", "live")
    await expect(map.locator(".payment-trace-token")).toHaveCount(1)
    await expect(map.locator('[data-edge="buyer_merchant"]')).toHaveAttribute(
      "data-proof",
      "browser_handoff",
    )
    await expect(rail).toContainText("Buyer activated official checkout")
    await expect(rail).toContainText("Payment outcome remains unknown")
    await expect(rail).not.toContainText("tickets issued")

    const calls = await page.evaluate(
      () =>
        (window as unknown as {
          __onsaleConfirmCalls?: Array<{
            returnUrl: string
            redirect: string
            hasOfficialElements: boolean
          }>
        }).__onsaleConfirmCalls ?? [],
    )
    expect(calls).toEqual([
      {
        returnUrl: "http://127.0.0.1:4179/api/onsale/return",
        redirect: "if_required",
        hasOfficialElements: true,
      },
    ])
    expect(calls[0].returnUrl).not.toContain("secret_client")
    expect(calls[0].returnUrl).not.toContain("pk_snd")

    await page.evaluate(() => {
      ;(window as unknown as {
        __settleOfficialConfirm: (value: "resolve" | "throw") => void
      }).__settleOfficialConfirm("resolve")
    })
    await expect(pay).toBeEnabled()
  })
}

test("reconcile in flight disables checkout and rejects a programmatic submit", async ({
  page,
}) => {
  await installActiveHold(page)
  await installOfficialSdkMock(page)
  let reconcileCount = 0
  let releaseReconcile: () => void
  const reconcileGate = new Promise<void>((resolve) => {
    releaseReconcile = resolve
  })
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    if (reconcileCount === 2) await reconcileGate
    await fulfillJson(route, readyCheckout(reconcileCount))
  })

  await page.goto("/")
  const pay = page.getByTestId("official-checkout-submit")
  await expect(pay).toBeEnabled()
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  )
  try {
    await expect.poll(() => reconcileCount).toBe(2)
    await expect(pay).toBeDisabled()

    await page
      .locator("form.official-checkout-form")
      .evaluate((node) => (node as HTMLFormElement).requestSubmit())
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __onsaleConfirmCount?: number })
            .__onsaleConfirmCount ?? 0,
      ),
    ).toBe(0)
  } finally {
    releaseReconcile()
  }
  await expect(pay).toBeEnabled()
})

test("payment deadline locks submit and reconciles the same payment", async ({
  page,
}) => {
  await installActiveHold(page)
  await installOfficialSdkMock(page)
  let paymentDeadlineAt: string | null = null
  let reconcileCount = 0
  const requestBodies: Record<string, unknown>[] = []
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    requestBodies.push(JSON.parse(route.request().postData() ?? "{}"))
    if (reconcileCount === 1) {
      paymentDeadlineAt = new Date(Date.now() + 8_000).toISOString()
    }
    if (paymentDeadlineAt === null) {
      throw new Error("deadline fixture was not initialized")
    }
    await fulfillJson(
      route,
      reconcileCount === 1
        ? readyCheckout(1, paymentDeadlineAt)
        : expiredCheckout(2, paymentDeadlineAt),
    )
  })

  await page.goto("/")
  const pay = page.getByTestId("official-checkout-submit")
  await expect(pay).toBeEnabled()
  await expect.poll(() => reconcileCount, { timeout: 15_000 }).toBe(2)
  await expect(pay).toHaveCount(0)
  await expect(page.locator('[data-checkout-stage="expired"]')).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Checkout time expired." }),
  ).toBeFocused()
  expect(requestBodies.map((body) => body.trigger)).toEqual([
    "resume",
    "refresh",
  ])
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __onsaleConfirmCount?: number })
          .__onsaleConfirmCount ?? 0,
    ),
  ).toBe(0)
})

for (const settlement of ["resolve", "throw"] as const) {
  test(`a ${settlement} SDK settlement waits for a fresh post-confirm reconcile`, async ({
    page,
  }) => {
    await installActiveHold(page)
    await installOfficialSdkMock(page)
    let reconcileCount = 0
    const requestBodies: Record<string, unknown>[] = []
    await page.route("**/api/onsale/checkout/reconcile", async (route) => {
      reconcileCount += 1
      requestBodies.push(JSON.parse(route.request().postData() ?? "{}"))
      await fulfillJson(route, readyCheckout(reconcileCount))
    })

    await page.goto("/")
    const pay = page.getByTestId("official-checkout-submit")
    await expect(pay).toBeEnabled()
    await pay.click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(
            (window as unknown as { __onsaleConfirmCount?: number })
              .__onsaleConfirmCount ?? 0,
          ),
        ),
      )
      .toBe(1)

    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    )
    await expect.poll(() => reconcileCount).toBe(2)
    await expect(pay).toBeDisabled()

    await page.evaluate((mode) => {
      ;(window as unknown as {
        __settleOfficialConfirm: (value: "resolve" | "throw") => void
      }).__settleOfficialConfirm(mode)
    }, settlement)

    await expect.poll(() => reconcileCount).toBe(3)
    await expect(pay).toBeEnabled()
    expect(requestBodies.map((body) => body.trigger)).toEqual([
      "resume",
      "refresh",
      "refresh",
    ])
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __onsaleConfirmCount?: number })
            .__onsaleConfirmCount,
      ),
    ).toBe(1)
  })
}

test("authoritative post-confirm fulfillment moves one amber handoff to verified tickets", async ({
  page,
}) => {
  await installActiveHold(page, 4)
  await installOfficialSdkMock(page)
  let reconcileCount = 0
  await page.route("**/api/onsale/checkout/reconcile", async (route) => {
    reconcileCount += 1
    await fulfillJson(
      route,
      reconcileCount === 1
        ? readyCheckout(reconcileCount)
        : fulfilledCheckout(reconcileCount),
    )
  })

  await page.goto("/")
  const pay = page.getByTestId("official-checkout-submit")
  await expect(pay).toBeEnabled()
  await pay.click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __onsaleConfirmCount?: number })
            .__onsaleConfirmCount ?? 0,
      ),
    )
    .toBe(1)

  await page.evaluate(() => {
    ;(window as unknown as {
      __settleOfficialConfirm: (value: "resolve" | "throw") => void
    }).__settleOfficialConfirm("resolve")
  })

  await expect.poll(() => reconcileCount).toBe(2)
  const rail = page.getByTestId("production-payment-rail")
  const map = rail.locator(".payment-trace-map")
  await expect(map).toHaveAttribute("data-playback", "live")
  await expect(map.locator(".payment-trace-token")).toHaveCount(1)
  await expect(map.locator('[data-edge="merchant_tickets"]')).toHaveAttribute(
    "data-proof",
    "merchant_db",
  )
  await expect(rail).toContainText("ONSALE issued the verified tickets")
  await expect(page.locator(".production-ticket-wallet")).toContainText(
    "4 of 4 tickets issued",
  )
})
