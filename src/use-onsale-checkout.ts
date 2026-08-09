"use client"

/** SDK settlement is never interpreted as payment truth. */
// A throw can happen after provider-side progress. Retrieval is mandatory.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  parseCheckoutPrivateResponseV1,
  type CheckoutPrivateFailureV1,
  type CheckoutPrivateResponseV1,
  type CheckoutPrivateSuccessV1,
} from "./domain/onsale-checkout-private-v1"
import {
  createCheckoutSubmissionGateV1,
  type CheckoutSubmissionGateV1,
} from "./onsale-checkout-submission-gate"

export type CheckoutReconcileTriggerV1 = "return" | "resume" | "refresh"
export type CheckoutClientRequestStateV1 = "idle" | "preparing" | "reconciling" | "confirming" | "blocked"

export interface CheckoutWidgetReadinessV1 {
  readonly ready: boolean
  readonly complete: boolean
}

export interface OnsaleCheckoutControllerV1 {
  readonly snapshot: CheckoutPrivateSuccessV1 | null
  readonly failure: CheckoutPrivateFailureV1 | null
  readonly requestState: CheckoutClientRequestStateV1
  readonly widget: CheckoutWidgetReadinessV1
  readonly mountRevision: number
  readonly canSubmit: boolean
  readonly prepare: (holdRef: string) => Promise<boolean>
  readonly reconcile: (
    trigger: CheckoutReconcileTriggerV1,
  ) => Promise<CheckoutPrivateSuccessV1 | null>
  readonly setWidgetReadiness: (
    mountRevision: number,
    value: CheckoutWidgetReadinessV1,
  ) => void
  readonly confirmOfficialPayment: (
    mountRevision: number,
    confirm: () => Promise<unknown>,
  ) => Promise<boolean>
}

export interface UseOnsaleCheckoutOptionsV1 {
  /**
   * Server-derived presence only. The HttpOnly order pointer itself never
   * enters browser state.
   */
  readonly resumeCheckout?: boolean
}

export type CheckoutFetchV1 = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

const CHECKOUT_REQUEST_TIMEOUT_MS_V1 = 15_000

export interface OnsaleCheckoutHttpClientV1 {
  readonly prepare: (
    commandId: string,
    holdRef: string,
  ) => Promise<CheckoutPrivateResponseV1>
  readonly reconcile: (
    commandId: string,
    trigger: CheckoutReconcileTriggerV1,
  ) => Promise<CheckoutPrivateResponseV1>
}

async function responseJsonV1(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function localFailureV1(): CheckoutPrivateFailureV1 {
  return {
    schema: "onsale.checkout-private.v1",
    ok: false,
    error: {
      code: "CHECKOUT_TEMPORARILY_UNAVAILABLE",
      message: "Secure checkout is temporarily unavailable. Try again.",
      retryable: true,
    },
  }
}

export function createOnsaleCheckoutHttpClientV1(
  fetcher: CheckoutFetchV1 = fetch,
): OnsaleCheckoutHttpClientV1 {
  const post = async (path: string, body: unknown) => {
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(CHECKOUT_REQUEST_TIMEOUT_MS_V1),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return parseCheckoutPrivateResponseV1(await responseJsonV1(response))
  }

  return {
    prepare(commandId, holdRef) {
      return post("/api/onsale/checkout/prepare", { commandId, holdRef })
    },
    reconcile(commandId, trigger) {
      return post("/api/onsale/checkout/reconcile", { commandId, trigger })
    },
  }
}
export async function settleOfficialCheckoutSubmissionV1(
  confirm: () => Promise<unknown>,
  reconcileSamePayment: () => Promise<unknown>,
): Promise<void> {
  try {
    await confirm()
  } catch {}
  await reconcileSamePayment()
}

function commandIdV1(): string {
  return crypto.randomUUID()
}

function checkoutReadyV1(snapshot: CheckoutPrivateSuccessV1 | null): boolean {
  return (
    snapshot?.stage === "checkout_ready" &&
    snapshot.checkout !== null &&
    snapshot.payment.retryPermitted
  )
}

function clientDeadlineOpenV1(
  snapshot: CheckoutPrivateSuccessV1 | null,
): boolean {
  if (!snapshot) return false
  const deadline = Date.parse(snapshot.order.paymentDeadlineAt)
  return Number.isFinite(deadline) && Date.now() < deadline
}

function sameGrantV1(
  left: CheckoutPrivateSuccessV1["checkout"],
  right: CheckoutPrivateSuccessV1["checkout"],
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.clientSecret === right.clientSecret &&
    left.publishableKey === right.publishableKey
  )
}

export function useOnsaleCheckoutV1(
  options: UseOnsaleCheckoutOptionsV1 = {},
): OnsaleCheckoutControllerV1 {
  const resumeCheckout = options.resumeCheckout ?? true
  const [snapshot, setSnapshot] = useState<CheckoutPrivateSuccessV1 | null>(
    null,
  )
  const [failure, setFailure] = useState<CheckoutPrivateFailureV1 | null>(null)
  const [requestState, setRequestState] =
    useState<CheckoutClientRequestStateV1>("idle")
  const [widget, setWidget] = useState<CheckoutWidgetReadinessV1>({
    ready: false,
    complete: false,
  })
  const [mountRevision, setMountRevision] = useState(0)
  const [deadlineLocked, setDeadlineLocked] = useState(false)
  const mounted = useRef(true)
  const snapshotRef = useRef<CheckoutPrivateSuccessV1 | null>(null)
  const widgetRef = useRef(widget)
  const mountRevisionRef = useRef(0)
  const prepareInFlight = useRef(false)
  const normalReconcileInFlight =
    useRef<Promise<CheckoutPrivateSuccessV1 | null> | null>(null)
  const operationTail = useRef<Promise<void>>(Promise.resolve())
  const initialResumeStarted = useRef(false)
  const checkoutAuthorityExpected = useRef(resumeCheckout)
  const gate = useRef<CheckoutSubmissionGateV1>(
    createCheckoutSubmissionGateV1(),
  )
  const client = useRef<OnsaleCheckoutHttpClientV1>(
    createOnsaleCheckoutHttpClientV1(),
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const resetWidget = useCallback(() => {
    const empty = { ready: false, complete: false }
    widgetRef.current = empty
    setWidget(empty)
  }, [])

  const advanceMountRevision = useCallback(() => {
    mountRevisionRef.current += 1
    setMountRevision(mountRevisionRef.current)
  }, [])

  const enqueueOperation = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> => {
      const result = operationTail.current.then(operation, operation)
      operationTail.current = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    [],
  )

  const applySuccess = useCallback(
    (next: CheckoutPrivateSuccessV1) => {
      if (!mounted.current) return
      checkoutAuthorityExpected.current = true
      const previous = snapshotRef.current
      const mountChanged =
        previous === null ||
        previous.payment.evidenceRevision !== next.payment.evidenceRevision ||
        !sameGrantV1(previous.checkout, next.checkout)
      snapshotRef.current = next
      setSnapshot(next)
      setFailure(null)
      if (mountChanged || !checkoutReadyV1(next)) resetWidget()
      if (mountChanged) advanceMountRevision()
    },
    [advanceMountRevision, resetWidget],
  )

  const applyFailure = useCallback(
    (next: CheckoutPrivateFailureV1, missingIsIdle: boolean) => {
      if (!mounted.current) return
      if (missingIsIdle && next.error.code === "ORDER_NOT_FOUND") {
        checkoutAuthorityExpected.current = false
        if (snapshotRef.current !== null) {
          snapshotRef.current = null
          setSnapshot(null)
          setDeadlineLocked(false)
          resetWidget()
          advanceMountRevision()
          gate.current.revoke()
          setFailure(next)
          setRequestState("blocked")
          return
        }
        setFailure(null)
        setRequestState("idle")
        return
      }
      if (next.error.code === "ORDER_NOT_FOUND") {
        checkoutAuthorityExpected.current = false
        snapshotRef.current = null
        setSnapshot(null)
        setDeadlineLocked(false)
        resetWidget()
        advanceMountRevision()
        gate.current.revoke()
      }
      setFailure(next)
      setRequestState("blocked")
    },
    [advanceMountRevision, resetWidget],
  )

  const prepare = useCallback(
    async (holdRef: string): Promise<boolean> => {
      if (prepareInFlight.current || holdRef.length === 0) return false
      prepareInFlight.current = true
      setRequestState("preparing")
      setFailure(null)
      try {
        return await enqueueOperation(async () => {
          try {
            const response = await client.current.prepare(
              commandIdV1(),
              holdRef,
            )
            if (!response.ok) {
              applyFailure(response, false)
              return false
            }
            applySuccess(response)
            if (mounted.current) setRequestState("idle")
            return true
          } catch {
            applyFailure(localFailureV1(), false)
            return false
          }
        })
      } finally {
        prepareInFlight.current = false
      }
    },
    [applyFailure, applySuccess, enqueueOperation],
  )

  const runReconcile = useCallback(
    (
      trigger: CheckoutReconcileTriggerV1,
      missingIsIdle: boolean,
      confirmationToken: number | null,
    ): Promise<CheckoutPrivateSuccessV1 | null> => {
      return enqueueOperation(async () => {
        if (mounted.current && confirmationToken !== null) {
          setRequestState("reconciling")
          setFailure(null)
        } else if (mounted.current && gate.current.current() === null) {
          setRequestState("reconciling")
          setFailure(null)
        }
        try {
          const response = await client.current.reconcile(
            commandIdV1(),
            trigger,
          )
          if (!response.ok) {
            applyFailure(response, missingIsIdle)
            return null
          }
          applySuccess(response)
          if (confirmationToken !== null) {
            gate.current.releaseAfterConfirmationReconcile(
              confirmationToken,
              response.payment.evidenceRevision,
              checkoutReadyV1(response),
            )
          }
          if (mounted.current) {
            setRequestState(
              confirmationToken === null && gate.current.current() !== null
                ? "confirming"
                : "idle",
            )
          }
          return response
        } catch {
          applyFailure(localFailureV1(), false)
          return null
        }
      })
    },
    [applyFailure, applySuccess, enqueueOperation],
  )

  const reconcileInternal = useCallback(
    (
      trigger: CheckoutReconcileTriggerV1,
      missingIsIdle: boolean,
    ): Promise<CheckoutPrivateSuccessV1 | null> => {
      if (normalReconcileInFlight.current) {
        return normalReconcileInFlight.current
      }
      const operation = runReconcile(trigger, missingIsIdle, null)
      normalReconcileInFlight.current = operation
      void operation.finally(() => {
        if (normalReconcileInFlight.current === operation) {
          normalReconcileInFlight.current = null
        }
      })
      return operation
    },
    [runReconcile],
  )

  const reconcile = useCallback(
    (trigger: CheckoutReconcileTriggerV1) => reconcileInternal(trigger, false),
    [reconcileInternal],
  )

  useEffect(() => {
    if (!snapshot || !checkoutReadyV1(snapshot)) {
      setDeadlineLocked(false)
      return
    }
    const deadline = Date.parse(snapshot.order.paymentDeadlineAt)
    const remaining = deadline - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setDeadlineLocked(true)
      resetWidget()
      void reconcileInternal("refresh", false)
      return
    }
    setDeadlineLocked(false)
    const revision = snapshot.payment.evidenceRevision
    const timer = window.setTimeout(() => {
      const current = snapshotRef.current
      if (
        current?.payment.evidenceRevision !== revision ||
        !checkoutReadyV1(current)
      ) {
        return
      }
      setDeadlineLocked(true)
      resetWidget()
      void reconcileInternal("refresh", false)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [reconcileInternal, resetWidget, snapshot])

  useEffect(() => {
    if (!resumeCheckout || initialResumeStarted.current) return
    initialResumeStarted.current = true
    void reconcileInternal("resume", true)
  }, [reconcileInternal, resumeCheckout])

  useEffect(() => {
    const refresh = () => {
      if (
        checkoutAuthorityExpected.current &&
        document.visibilityState === "visible"
      ) {
        void reconcileInternal("refresh", true)
      }
    }
    const returned = (event: PageTransitionEvent) => {
      if (checkoutAuthorityExpected.current && event.persisted) {
        void reconcileInternal("return", true)
      }
    }
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("online", refresh)
    window.addEventListener("pageshow", returned)
    return () => {
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("online", refresh)
      window.removeEventListener("pageshow", returned)
    }
  }, [reconcileInternal])

  const setWidgetReadiness = useCallback(
    (revision: number, next: CheckoutWidgetReadinessV1) => {
      if (
        revision !== mountRevisionRef.current ||
        !checkoutReadyV1(snapshotRef.current)
      ) {
        return
      }
      widgetRef.current = next
      setWidget(next)
    },
    [],
  )

  const confirmOfficialPayment = useCallback(
    async (
      revision: number,
      confirm: () => Promise<unknown>,
    ): Promise<boolean> => {
      const current = snapshotRef.current
      if (
        revision !== mountRevisionRef.current ||
        !checkoutReadyV1(current) ||
        !clientDeadlineOpenV1(current) ||
        deadlineLocked ||
        prepareInFlight.current ||
        normalReconcileInFlight.current !== null ||
        !widgetRef.current.ready ||
        !widgetRef.current.complete ||
        !current
      ) {
        return false
      }
      const lease = gate.current.tryAcquire(current.payment.evidenceRevision)
      if (lease === null) return false
      if (mounted.current) setRequestState("confirming")
      await settleOfficialCheckoutSubmissionV1(confirm, () =>
        runReconcile("refresh", false, lease.token),
      )
      return true
    },
    [deadlineLocked, runReconcile],
  )

  return {
    snapshot,
    failure,
    requestState,
    widget,
    mountRevision,
    canSubmit:
      checkoutReadyV1(snapshot) &&
      clientDeadlineOpenV1(snapshot) &&
      !deadlineLocked &&
      widget.ready &&
      widget.complete &&
      requestState === "idle" &&
      gate.current.current() === null,
    prepare,
    reconcile,
    setWidgetReadiness,
    confirmOfficialPayment,
  }
}
