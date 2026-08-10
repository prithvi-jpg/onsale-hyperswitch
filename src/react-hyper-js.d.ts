declare module "@juspay-tech/react-hyper-js" {
  import type {
    Element as HyperElement,
    ElementsOptions,
    HyperInstance,
  } from "@juspay-tech/hyper-js"

  export interface HyperElementsProps {
    readonly hyper: Promise<HyperInstance>
    readonly options: ElementsOptions
    readonly children?: import("react").ReactNode
  }

  export interface UnifiedCheckoutChangeEvent {
    readonly complete?: boolean
  }

  export interface UnifiedCheckoutProps {
    readonly id?: string
    readonly options?: Record<string, unknown>
    readonly onReady?: (event?: unknown) => void
    readonly onChange?: (event: UnifiedCheckoutChangeEvent) => void
    readonly onFocus?: (event?: unknown) => void
    readonly onBlur?: (event?: unknown) => void
    readonly onClick?: (event?: unknown) => void
  }

  export function HyperElements(
    props: HyperElementsProps,
  ): import("react").ReactElement
  export function UnifiedCheckout(
    props: UnifiedCheckoutProps,
  ): import("react").ReactElement
  export function useHyper(): HyperInstance
  export function useWidgets(): HyperElement
}
