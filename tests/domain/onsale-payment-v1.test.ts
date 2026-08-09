import { describe, expect, it } from "vitest"

import {
  PaymentNormalizationError,
  decidePaymentTransitionV1,
  evaluatePaymentIntegrityV1,
  normalizeHyperswitchPaymentObservationV1,
  type ImmutableOrderPaymentTermsV1,
} from "../../src/domain/onsale-payment-v1"

const ORDER: ImmutableOrderPaymentTermsV1 = {
  amountMinor: 46_860,
  currency: "USD",
  itemCount: 4,
}

function createFixture(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: "pay_onsale_create_01",
    status: "requires_payment_method",
    amount: ORDER.amountMinor,
    currency: ORDER.currency,
    client_secret: "pay_onsale_create_01_secret_do_not_retain",
    ...overrides,
  }
}

function retrievedSuccessFixture(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: "pay_onsale_success_01",
    status: "succeeded",
    amount: ORDER.amountMinor,
    currency: ORDER.currency,
    payment_method: "card",
    payment_method_type: "credit",
    attempts: [
      {
        attempt_id: "attempt_onsale_success_01",
        status: "charged",
        connector: "stripe_test",
        amount: ORDER.amountMinor,
        currency: ORDER.currency,
      },
    ],
    ...overrides,
  }
}

describe("C3 Hyperswitch payment observation normalization", () => {
  it("normalizes create as requires_method without retaining the client secret", () => {
    const observation = normalizeHyperswitchPaymentObservationV1(
      createFixture(),
      "create",
    )

    expect(observation).toMatchObject({
      schema: "onsale.payment-observation.v1",
      source: "create",
      providerStatus: "requires_payment_method",
      canonicalState: "requires_method",
      amountMinor: ORDER.amountMinor,
      currency: ORDER.currency,
      selectedPaymentMethod: null,
      observedConnector: null,
      nextAction: { present: false, kind: null },
      attempts: [],
      successfulChargedAttemptCount: 0,
      hardDeclineObserved: false,
      error: null,
    })
    expect(observation.providerPaymentRef).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(observation.observationHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(observation)).not.toContain("secret_do_not_retain")
  })

  it("keeps selected Klarna and the observed stripe_test connector as separate facts", () => {
    const observation = normalizeHyperswitchPaymentObservationV1(
      createFixture({
        payment_id: "pay_onsale_klarna_01",
        status: "requires_customer_action",
        payment_method: "pay_later",
        payment_method_type: "klarna",
        connector: null,
        next_action: {
          type: "redirect_to_url",
          redirect_to_url:
            "https://sandbox.example.test/authorize?token=action-secret",
          body: { authorization_token: "body-secret" },
        },
        attempts: [
          {
            attempt_id: "attempt_onsale_klarna_01",
            status: "requires_action",
            connector: "stripe_test",
          },
        ],
      }),
      "retrieve",
    )

    expect(observation.canonicalState).toBe("action_required")
    expect(observation.selectedPaymentMethod).toEqual({
      family: "pay_later",
      type: "klarna",
    })
    expect(observation.observedConnector).toBe("stripe_test")
    expect(observation.nextAction).toEqual({
      present: true,
      kind: "redirect_to_url",
    })
    expect(observation.attempts[0]).toMatchObject({
      providerStatus: "requires_action",
      canonicalState: "action_required",
      observedConnector: "stripe_test",
      charged: false,
    })

    const serialized = JSON.stringify(observation)
    expect(serialized).not.toContain("sandbox.example.test")
    expect(serialized).not.toContain("action-secret")
    expect(serialized).not.toContain("body-secret")
    expect(serialized).not.toContain("attempt_onsale_klarna_01")
  })

  it("classifies DC_08 as a hard decline with zero charges without treating every failure as hard", () => {
    const hardDecline = normalizeHyperswitchPaymentObservationV1(
      createFixture({
        payment_id: "pay_onsale_decline_01",
        status: "failed",
        error_code: "DC_08",
        unified_code: "UE_9000",
        error_message: "The issuer declined the payment",
        attempts: [
          {
            attempt_id: "attempt_onsale_decline_01",
            status: "failure",
            connector: "stripe_test",
            error_code: "DC_08",
          },
        ],
      }),
      "retrieve",
    )
    const ordinaryFailure = normalizeHyperswitchPaymentObservationV1(
      createFixture({
        payment_id: "pay_onsale_technical_01",
        status: "failed",
        error_code: "TE_01",
        error_message: "connector temporarily unavailable",
        attempts: [
          {
            attempt_id: "attempt_onsale_technical_01",
            status: "failed",
            connector: "stripe_test",
            error_code: "TE_01",
          },
        ],
      }),
      "retrieve",
    )

    expect(hardDecline).toMatchObject({
      canonicalState: "exhausted",
      hardDeclineObserved: true,
      successfulChargedAttemptCount: 0,
      error: { class: "hard_decline", code: "DC_08" },
    })
    expect(hardDecline.attempts[0]).toMatchObject({
      hardDecline: true,
      charged: false,
    })
    expect(ordinaryFailure.canonicalState).toBe("exhausted")
    expect(ordinaryFailure.hardDeclineObserved).toBe(false)
    expect(ordinaryFailure.error?.class).not.toBe("hard_decline")

    const integrity = evaluatePaymentIntegrityV1(hardDecline, ORDER)
    expect(integrity.fulfillmentEligible).toBe(false)
    expect(integrity.successfulChargedAttemptCount).toBe(0)
    expect(integrity.integrityReviewRequired).toBe(false)
  })

  it.each([1, 2, 3, 4])(
    "permits fulfillment for a retrieved exact-money success with %i order item(s)",
    (itemCount) => {
      const observation = normalizeHyperswitchPaymentObservationV1(
        retrievedSuccessFixture(),
        "retrieve",
      )
      const integrity = evaluatePaymentIntegrityV1(observation, {
        ...ORDER,
        itemCount,
      })

      expect(integrity).toMatchObject({
        sourceIsRetrieved: true,
        exactMoney: true,
        canonicalSuccess: true,
        successfulChargedAttemptCount: 1,
        exactlyOneSuccessfulChargedAttempt: true,
        integrityReviewRequired: false,
        fulfillmentEligible: true,
        issues: [],
      })
    },
  )

  it("blocks wrong money and more than one successful logical charge", () => {
    const wrongAmount = normalizeHyperswitchPaymentObservationV1(
      retrievedSuccessFixture({ amount: ORDER.amountMinor + 1 }),
      "retrieve",
    )
    const multipleCharges = normalizeHyperswitchPaymentObservationV1(
      retrievedSuccessFixture({
        attempts: [
          {
            attempt_id: "attempt_onsale_success_01",
            status: "charged",
            connector: "stripe_test",
          },
          {
            attempt_id: "attempt_onsale_success_02",
            status: "succeeded",
            connector: "adyen_test",
          },
        ],
      }),
      "retrieve",
    )

    const wrongAmountIntegrity = evaluatePaymentIntegrityV1(wrongAmount, ORDER)
    const multipleChargeIntegrity = evaluatePaymentIntegrityV1(
      multipleCharges,
      ORDER,
    )

    expect(wrongAmountIntegrity.fulfillmentEligible).toBe(false)
    expect(wrongAmountIntegrity.integrityReviewRequired).toBe(true)
    expect(wrongAmountIntegrity.issues.map((issue) => issue.code)).toContain(
      "ORDER_AMOUNT_MISMATCH",
    )
    expect(multipleChargeIntegrity.fulfillmentEligible).toBe(false)
    expect(multipleChargeIntegrity.integrityReviewRequired).toBe(true)
    expect(multipleChargeIntegrity.successfulChargedAttemptCount).toBe(2)
    expect(multipleChargeIntegrity.issues.map((issue) => issue.code)).toContain(
      "MULTIPLE_SUCCESSFUL_CHARGES",
    )
  })

  it("retains terminal success and opens integrity review for a later stale failure", () => {
    const current = normalizeHyperswitchPaymentObservationV1(
      retrievedSuccessFixture(),
      "retrieve",
    )
    const incoming = normalizeHyperswitchPaymentObservationV1(
      {
        payment_id: "pay_onsale_success_01",
        status: "failed",
        amount: ORDER.amountMinor,
        currency: ORDER.currency,
        error_code: "TE_01",
        attempts: [
          {
            attempt_id: "attempt_onsale_success_01",
            status: "failed",
            connector: "stripe_test",
            error_code: "TE_01",
          },
        ],
      },
      "retrieve",
    )

    const decision = decidePaymentTransitionV1(current, incoming)

    expect(decision).toMatchObject({
      accepted: false,
      resultingCanonicalState: "succeeded",
      retainedTerminalSuccess: true,
      integrityReviewRequired: true,
    })
    expect(decision.reasons).toContain("TERMINAL_SUCCESS_REGRESSION")
  })

  it("retains terminal failure and opens integrity review for a later success", () => {
    const current = normalizeHyperswitchPaymentObservationV1(
      {
        payment_id: "pay_onsale_terminal_failure_01",
        status: "failed",
        amount: ORDER.amountMinor,
        currency: ORDER.currency,
        error_code: "DC_08",
        attempts: [
          {
            attempt_id: "attempt_onsale_terminal_failure_01",
            status: "failed",
            connector: "stripe_test",
            error_code: "DC_08",
          },
        ],
      },
      "retrieve",
    )
    const incoming = normalizeHyperswitchPaymentObservationV1(
      {
        payment_id: "pay_onsale_terminal_failure_01",
        status: "succeeded",
        amount: ORDER.amountMinor,
        currency: ORDER.currency,
        attempts: [
          {
            attempt_id: "attempt_onsale_terminal_failure_01",
            status: "charged",
            connector: "stripe_test",
            amount: ORDER.amountMinor,
            currency: ORDER.currency,
          },
        ],
      },
      "retrieve",
    )

    const decision = decidePaymentTransitionV1(current, incoming)

    expect(decision).toMatchObject({
      accepted: false,
      resultingCanonicalState: "exhausted",
      retainedTerminalSuccess: false,
      integrityReviewRequired: true,
    })
    expect(decision.reasons).toContain("TERMINAL_FAILURE_REGRESSION")
  })

  it("emits only sanitized projections and stable hashes", () => {
    const payload = retrievedSuccessFixture({
      client_secret: "client-secret-shaped-value",
      return_url:
        "https://merchant.example.test/return?payment_id=raw-payment&token=query-secret",
      next_action: {
        type: "redirect_to_url",
        redirect_to_url:
          "https://provider.example.test/action?client_secret=redirect-secret",
        body: { cvc: "123", pan: "4242424242424242" },
      },
      error_message:
        "card 4242 4242 4242 4242 cvc=123 https://provider.example.test/error?token=oops",
    })
    const first = normalizeHyperswitchPaymentObservationV1(payload, "retrieve")
    const reordered = normalizeHyperswitchPaymentObservationV1(
      {
        currency: ORDER.currency,
        attempts: payload.attempts,
        amount: ORDER.amountMinor,
        status: "succeeded",
        payment_id: "pay_onsale_success_01",
        payment_method_type: "credit",
        payment_method: "card",
      },
      "retrieve",
    )

    expect(first.providerPaymentRef).toBe(reordered.providerPaymentRef)
    expect(first.attempts[0]?.providerAttemptRef).toBe(
      reordered.attempts[0]?.providerAttemptRef,
    )
    expect(first.observationHash).not.toBe(reordered.observationHash)

    const serialized = JSON.stringify(first)
    for (const forbidden of [
      "client-secret-shaped-value",
      "query-secret",
      "redirect-secret",
      "4242424242424242",
      "4242 4242 4242 4242",
      "cvc=123",
      "provider.example.test",
      "pay_onsale_success_01",
      "attempt_onsale_success_01",
      "return_url",
      "client_secret",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(first.error?.message).toBe(
      "The payment provider returned an error.",
    )
  })

  it.each([
    [
      "top-level error_message",
      { error_message: "unlabelled_api_canary_4f91c2a7" },
      "unlabelled_api_canary_4f91c2a7",
    ],
    [
      "top-level unified_message",
      { unified_message: "Bearer eyJhbGciOiJub25lIn0.secret-canary" },
      "eyJhbGciOiJub25lIn0.secret-canary",
    ],
    [
      "nested error.message",
      { error: { message: "private_customer_reference_canary_7b2d" } },
      "private_customer_reference_canary_7b2d",
    ],
  ])(
    "replaces provider prose from %s with fixed class-derived copy",
    (_label, override, canary) => {
      const observation = normalizeHyperswitchPaymentObservationV1(
        createFixture({
          payment_id: "pay_onsale_error_copy_01",
          status: "failed",
          ...override,
        }),
        "retrieve",
      )

      expect(observation.error).toEqual({
        class: "unknown",
        code: null,
        unifiedCode: null,
        message: "The payment provider returned an error.",
      })
      expect(JSON.stringify(observation)).not.toContain(canary)
    },
  )

  it("maps unrecognized categorical provider values to fixed safe labels", () => {
    const canaries = [
      "sk_sandbox_statuscanary123456",
      "Bearer_method_canary_123456",
      "4242424242424242",
      "client_secret_connector_canary_123456",
      "https://provider.example.test/action?token=canary",
      "SK_SECRET_CANARY",
      "pk_snd_attemptstatuscanary123456",
    ]
    const observation = normalizeHyperswitchPaymentObservationV1(
      createFixture({
        payment_id: "pay_onsale_categorical_safety_01",
        status: canaries[0],
        payment_method: canaries[1],
        payment_method_type: canaries[2],
        connector: canaries[3],
        next_action: { type: canaries[4] },
        error_code: canaries[5],
        attempts: [
          {
            attempt_id: "attempt_onsale_categorical_safety_01",
            status: canaries[6],
            connector: canaries[2],
            error_code: canaries[5],
          },
        ],
      }),
      "retrieve",
    )

    expect(observation).toMatchObject({
      providerStatus: "unrecognized",
      canonicalState: "uncertain",
      selectedPaymentMethod: { family: "other", type: "other" },
      observedConnector: "other",
      nextAction: { present: true, kind: "other" },
      error: { code: "UNRECOGNIZED" },
      attempts: [
        {
          providerStatus: "unrecognized",
          canonicalState: "uncertain",
          observedConnector: "other",
          error: { code: "UNRECOGNIZED" },
        },
      ],
    })
    const serialized = JSON.stringify(observation)
    for (const canary of canaries) expect(serialized).not.toContain(canary)
  })

  it("reduces unknown known-prefix error codes to fixed family labels", () => {
    const canary = "TE_SECRETCANARY123"
    const observation = normalizeHyperswitchPaymentObservationV1(
      createFixture({
        payment_id: "pay_onsale_error_family_safety_01",
        status: "failed",
        error_code: canary,
        unified_code: "UE_PRIVATECANARY456",
      }),
      "retrieve",
    )

    expect(observation.error).toMatchObject({
      class: "technical",
      code: "TE_OTHER",
      unifiedCode: "UE_OTHER",
    })
    expect(JSON.stringify(observation)).not.toContain(canary)
    expect(JSON.stringify(observation)).not.toContain("PRIVATECANARY456")
  })

  it("fails closed for malformed provider payloads", () => {
    const malformedPayloads: unknown[] = [
      null,
      [],
      {},
      createFixture({ payment_id: "" }),
      createFixture({ status: "" }),
      createFixture({ amount: -1 }),
      createFixture({ amount: 1.5 }),
      createFixture({ currency: "US" }),
      createFixture({ attempts: {} }),
      createFixture({ attempts: [{ status: "charged" }] }),
    ]

    for (const payload of malformedPayloads) {
      expect(() =>
        normalizeHyperswitchPaymentObservationV1(payload, "retrieve"),
      ).toThrow(PaymentNormalizationError)
    }
    expect(() =>
      normalizeHyperswitchPaymentObservationV1(
        createFixture(),
        "webhook" as never,
      ),
    ).toThrow(PaymentNormalizationError)
  })
})
