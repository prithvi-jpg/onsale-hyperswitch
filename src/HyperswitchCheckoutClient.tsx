"use client"

/** React StrictMode may remount effects; one memory-only SDK load survives it. */

/** The upstream 2.1.0 declaration omits `elements`; keep that one cast here. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  loadHyper,
  type Element as HyperElement,
  type ElementsOptions,
  type HyperInstance,
  type confirmPaymentInputPayload,
} from "@juspay-tech/hyper-js"
import {
  HyperElements,
  UnifiedCheckout,
  useHyper,
  useWidgets,
  type UnifiedCheckoutChangeEvent,
} from "@juspay-tech/react-hyper-js"

import type { CheckoutEphemeralGrantV1 } from "./domain/onsale-checkout-private-v1"
import type { CheckoutWidgetReadinessV1 } from "./use-onsale-checkout"

const OFFICIAL_RETURN_PATH = "/api/onsale/return"
const OFFICIAL_CHECKOUT_LOAD_TIMEOUT_MS_V1 = 15_000

let officialHyperLoadV1: {
  readonly publishableKey: string
  readonly promise: Promise<HyperInstance>
} | null = null
function loadOfficialHyperV1(publishableKey: string): Promise<HyperInstance> {
  if (officialHyperLoadV1?.publishableKey === publishableKey) {
    return officialHyperLoadV1.promise
  }
  const promise = loadHyper(publishableKey, { env: "SANDBOX" })
  officialHyperLoadV1 = { publishableKey, promise }
  void promise.catch(() => {
    if (officialHyperLoadV1?.promise === promise) officialHyperLoadV1 = null
  })
  return promise
}

type ConfirmPaymentWithElementsV1 = (
  payload: confirmPaymentInputPayload & { readonly elements: HyperElement },
) => Promise<unknown>
export function confirmWithOfficialCheckoutV1(
  hyper: HyperInstance,
  elements: HyperElement,
  returnUrl: string,
): Promise<unknown> {
  const confirmPayment = hyper.confirmPayment as ConfirmPaymentWithElementsV1
  return confirmPayment.call(hyper, {
    elements,
    confirmParams: { return_url: returnUrl },
    redirect: "if_required",
  })
}

export interface HyperswitchCheckoutClientProps {
  readonly grant: CheckoutEphemeralGrantV1
  readonly amountLabel: string
  readonly canSubmit: boolean
  readonly submitting: boolean
  readonly onReadiness: (value: CheckoutWidgetReadinessV1) => void
  readonly onConfirm: (confirm: () => Promise<unknown>) => Promise<boolean>
  readonly onRetry?: () => void
}

function OfficialCheckoutFormV1({
  amountLabel,
  canSubmit,
  submitting,
  onReadiness,
  onConfirm,
}: Omit<HyperswitchCheckoutClientProps, "grant">) {
  const hyper = useHyper()
  const elements = useWidgets()
  const readiness = useRef<CheckoutWidgetReadinessV1>({
    ready: false,
    complete: false,
  })

  const publishReadiness = useCallback(
    (next: Partial<CheckoutWidgetReadinessV1>) => {
      const value = { ...readiness.current, ...next }
      readiness.current = value
      onReadiness(value)
    },
    [onReadiness],
  )

  useEffect(
    () => () => onReadiness({ ready: false, complete: false }),
    [onReadiness],
  )

  const handleChange = useCallback(
    (event: UnifiedCheckoutChangeEvent) => {
      publishReadiness({ complete: event.complete === true })
    },
    [publishReadiness],
  )

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!canSubmit || submitting) return
      const returnUrl = new URL(
        OFFICIAL_RETURN_PATH,
        window.location.origin,
      ).toString()
      await onConfirm(() =>
        confirmWithOfficialCheckoutV1(hyper, elements, returnUrl),
      )
    },
    [canSubmit, elements, hyper, onConfirm, submitting],
  )

  return (
    <form className="official-checkout-form" onSubmit={submit}>
      <div
        className="official-checkout-widget"
        data-testid="official-checkout-widget"
      >
        <UnifiedCheckout
          id="onsale-unified-checkout"
          onReady={() => publishReadiness({ ready: true })}
          onChange={handleChange}
        />
      </div>
      <button
        className="official-checkout-submit"
        data-testid="official-checkout-submit"
        type="submit"
        disabled={!canSubmit || submitting}
      >
        {submitting ? "CHECKING THIS PAYMENT…" : `PAY ${amountLabel} ALL-IN`}
      </button>
      <div className="official-checkout-boundary-note">
        <span aria-hidden="true" className="official-checkout-info-mark">
          i
        </span>
        <span>
          Payment details stay inside the official Hyperswitch fields. ONSALE
          receives only server-verified payment state.
        </span>
      </div>
    </form>
  )
}

export default function HyperswitchCheckoutClient({
  grant,
  amountLabel,
  canSubmit,
  submitting,
  onReadiness,
  onConfirm,
  onRetry,
}: HyperswitchCheckoutClientProps) {
  const [hyper, setHyper] = useState<Promise<HyperInstance> | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const readinessCallback = useRef(onReadiness)
  readinessCallback.current = onReadiness

  const options = useMemo<ElementsOptions>(
    () => ({
      clientSecret: grant.clientSecret,
      loader: "auto",
      locale: "en",
      appearance: {
        theme: "none",
        labels: "Above",
        variables: {
          fontFamily: "Inter, sans-serif",
          fontSizeBase: "14px",
          colorPrimary: "#006DF9",
          colorBackground: "#F5F8FF",
          colorText: "#0A0A0A",
          colorDanger: "#EF4444",
          borderRadius: "8px",
          spacingUnit: "5px",
          buttonBackgroundColor: "#006DF9",
          buttonBorderRadius: "8px",
          buttonTextColor: "#FFFFFF",
        },
        rules: {
          ".Input": {
            background: "#FFFFFF",
            border: "1px solid rgba(0,109,249,0.28)",
            boxShadow: "none",
            minHeight: "46px",
          },
          ".Input:focus": {
            border: "1px solid #006DF9",
            boxShadow: "0 0 0 2px rgba(0,109,249,0.10)",
          },
          ".Label": {
            color: "#4D5C70",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "9px",
            letterSpacing: "0.08em",
          },
          ".Tab": {
            background: "#FFFFFF",
            border: "1px solid rgba(0,109,249,0.22)",
            boxShadow: "none",
            color: "#18202B",
          },
          ".Tab:hover": {
            border: "1px solid #006DF9",
          },
          ".Tab--selected": {
            background: "rgba(0,109,249,0.08)",
            border: "2px solid #006DF9",
            color: "#006DF9",
          },
          ".AccordionItem": {
            background: "#FFFFFF",
            border: "1px solid rgba(0,109,249,0.18)",
          },
          ".Block": {
            background: "#FFFFFF",
            border: "1px solid rgba(0,109,249,0.16)",
          },
        },
      },
    }),
    [grant.clientSecret],
  )

  useEffect(() => {
    let active = true
    let timedOut = false
    setHyper(null)
    setLoadFailed(false)
    readinessCallback.current({ ready: false, complete: false })
    const timeout = window.setTimeout(() => {
      if (!active) return
      timedOut = true
      setLoadFailed(true)
      readinessCallback.current({ ready: false, complete: false })
    }, OFFICIAL_CHECKOUT_LOAD_TIMEOUT_MS_V1)
    void loadOfficialHyperV1(grant.publishableKey).then(
      (instance) => {
        if (!active || timedOut) return
        window.clearTimeout(timeout)
        setHyper(Promise.resolve(instance))
      },
      () => {
        if (!active || timedOut) return
        window.clearTimeout(timeout)
        setLoadFailed(true)
        readinessCallback.current({ ready: false, complete: false })
      },
    )
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [grant.clientSecret, grant.publishableKey])

  if (loadFailed) {
    return (
      <div className="official-checkout-loader" role="alert">
        <span className="official-checkout-loader-kicker">
          OFFICIAL CHECKOUT UNAVAILABLE
        </span>
        <span>
          No payment was submitted. Reload these protected fields after
          connectivity is restored.
        </span>
        {onRetry && (
          <button type="button" className="btn-outline-blue" onClick={onRetry}>
            RETRY SECURE CHECKOUT →
          </button>
        )}
      </div>
    )
  }

  if (hyper === null) {
    return (
      <div
        className="official-checkout-loader"
        role="status"
        aria-live="polite"
      >
        <span className="official-checkout-loader-kicker">
          LOADING OFFICIAL CHECKOUT
        </span>
        <span>Connecting the protected payment fields…</span>
      </div>
    )
  }

  return (
    <HyperElements hyper={hyper} options={options}>
      <OfficialCheckoutFormV1
        amountLabel={amountLabel}
        canSubmit={canSubmit}
        submitting={submitting}
        onReadiness={onReadiness}
        onConfirm={onConfirm}
      />
    </HyperElements>
  )
}
