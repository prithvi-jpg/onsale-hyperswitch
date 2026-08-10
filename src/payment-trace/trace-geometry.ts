import type {
  PaymentTraceEdgeIdV1,
  PaymentTraceNodeIdV1,
} from "./model"

export interface PaymentTraceNodeGeometryV1 {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PaymentTraceEdgeGeometryV1 {
  readonly path: string
  readonly source: readonly [number, number]
  readonly target: readonly [number, number]
  readonly curve: PaymentTraceEdgeCurveV1
}

export type PaymentTraceEdgeCurveV1 =
  | {
      readonly kind: "line"
      readonly start: readonly [number, number]
      readonly end: readonly [number, number]
    }
  | {
      readonly kind: "cubic"
      readonly start: readonly [number, number]
      readonly control1: readonly [number, number]
      readonly control2: readonly [number, number]
      readonly end: readonly [number, number]
    }

export interface PaymentTraceGeometryV1 {
  readonly width: number
  readonly height: number
  readonly nodes: Record<PaymentTraceNodeIdV1, PaymentTraceNodeGeometryV1>
  readonly edges: Record<PaymentTraceEdgeIdV1, PaymentTraceEdgeGeometryV1>
}

export interface PaymentTraceProjectedNodeGeometryV1 {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PaymentTraceProjectedEdgeGeometryV1 {
  readonly source: readonly [number, number]
  readonly target: readonly [number, number]
}

export interface PaymentTraceProjectedGeometryV1 {
  readonly width: number
  readonly height: number
  readonly nodes: Record<PaymentTraceNodeIdV1, PaymentTraceProjectedNodeGeometryV1>
  readonly edges: Record<PaymentTraceEdgeIdV1, PaymentTraceProjectedEdgeGeometryV1>
}

type PointV1 = readonly [number, number]

function pointLabelV1(point: PointV1): string {
  return `${point[0]} ${point[1]}`
}

function lineV1(start: PointV1, end: PointV1): PaymentTraceEdgeGeometryV1 {
  return {
    path: `M${pointLabelV1(start)} L${pointLabelV1(end)}`,
    source: start,
    target: end,
    curve: { kind: "line", start, end },
  }
}

function cubicV1(
  start: PointV1,
  control1: PointV1,
  control2: PointV1,
  end: PointV1,
): PaymentTraceEdgeGeometryV1 {
  return {
    path: `M${pointLabelV1(start)} C${pointLabelV1(control1)} ${pointLabelV1(control2)} ${pointLabelV1(end)}`,
    source: start,
    target: end,
    curve: { kind: "cubic", start, control1, control2, end },
  }
}

const RAIL_GEOMETRY_V1 = {
  width: 320,
  height: 396,
  nodes: {
    buyer: { x: 18, y: 10, w: 116, h: 30 },
    merchant: { x: 18, y: 72, w: 116, h: 34 },
    hyperswitch: { x: 18, y: 142, w: 116, h: 44 },
    connector: { x: 146, y: 116, w: 166, h: 124 },
    reconcile: { x: 82, y: 276, w: 158, h: 34 },
    tickets: { x: 84, y: 350, w: 152, h: 34 },
  },
  edges: {
    buyer_merchant: cubicV1([76, 40], [76, 51], [76, 61], [76, 72]),
    merchant_hyperswitch: cubicV1([76, 106], [76, 118], [76, 130], [76, 142]),
    hyperswitch_connector: cubicV1([134, 157], [141, 157], [141, 147], [146, 147]),
    connector_hyperswitch: cubicV1([146, 206], [140, 206], [141, 184], [134, 184]),
    hyperswitch_retrieve: cubicV1([76, 186], [76, 238], [128, 248], [160, 276]),
    reconcile_merchant: cubicV1([82, 293], [8, 293], [8, 89], [18, 89]),
    merchant_tickets: cubicV1([134, 89], [304, 102], [306, 367], [236, 367]),
  },
} satisfies PaymentTraceGeometryV1

const WIDE_GEOMETRY_V1 = {
  width: 820,
  height: 300,
  nodes: {
    buyer: { x: 12, y: 28, w: 140, h: 52 },
    merchant: { x: 208, y: 28, w: 150, h: 52 },
    hyperswitch: { x: 408, y: 28, w: 150, h: 64 },
    connector: { x: 604, y: 12, w: 204, h: 128 },
    reconcile: { x: 408, y: 220, w: 150, h: 52 },
    tickets: { x: 12, y: 220, w: 140, h: 52 },
  },
  edges: {
    buyer_merchant: lineV1([152, 54], [208, 54]),
    merchant_hyperswitch: lineV1([358, 54], [408, 54]),
    hyperswitch_connector: cubicV1([558, 42], [580, 42], [584, 40], [604, 40]),
    connector_hyperswitch: cubicV1([604, 104], [584, 104], [580, 78], [558, 78]),
    hyperswitch_retrieve: cubicV1([483, 92], [483, 140], [483, 180], [483, 220]),
    reconcile_merchant: cubicV1([408, 246], [330, 246], [283, 150], [283, 80]),
    merchant_tickets: cubicV1([208, 68], [170, 100], [190, 246], [152, 246]),
  },
} satisfies PaymentTraceGeometryV1

export function paymentTraceGeometryV1(
  layout: "rail" | "wide",
): PaymentTraceGeometryV1 {
  return layout === "wide" ? WIDE_GEOMETRY_V1 : RAIL_GEOMETRY_V1
}

function clampUnitV1(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function linearCoordinateV1(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

function cubicCoordinateV1(
  start: number,
  control1: number,
  control2: number,
  end: number,
  progress: number,
): number {
  const inverse = 1 - progress
  return inverse * inverse * inverse * start +
    3 * inverse * inverse * progress * control1 +
    3 * inverse * progress * progress * control2 +
    progress * progress * progress * end
}

export function paymentTracePointOnEdgeV1(
  layout: "rail" | "wide",
  edgeId: PaymentTraceEdgeIdV1,
  progress: number,
): PointV1 {
  const curve = paymentTraceGeometryV1(layout).edges[edgeId].curve
  const unit = clampUnitV1(progress)
  switch (curve.kind) {
    case "line":
      return [
        linearCoordinateV1(curve.start[0], curve.end[0], unit),
        linearCoordinateV1(curve.start[1], curve.end[1], unit),
      ]
    case "cubic":
      return [
        cubicCoordinateV1(
          curve.start[0],
          curve.control1[0],
          curve.control2[0],
          curve.end[0],
          unit,
        ),
        cubicCoordinateV1(
          curve.start[1],
          curve.control1[1],
          curve.control2[1],
          curve.end[1],
          unit,
        ),
      ]
    default: {
      const exhaustive: never = curve
      return exhaustive
    }
  }
}

/** Strong ease-in-out curve used for explanatory on-screen movement. */
export function paymentTraceEasedTravelProgressV1(progress: number): number {
  const unit = clampUnitV1(progress)
  if (unit === 0 || unit === 1) return unit

  // Invert x(t) for cubic-bezier(0.77, 0, 0.175, 1), then return y(t).
  let lower = 0
  let upper = 1
  let parameter = unit
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const x = cubicCoordinateV1(0, 0.77, 0.175, 1, parameter)
    if (x < unit) lower = parameter
    else upper = parameter
    parameter = (lower + upper) / 2
  }
  return cubicCoordinateV1(0, 0, 1, 1, parameter)
}

function projectPointV1(point: PointV1, horizontalScale: number): PointV1 {
  return [point[0] * horizontalScale, point[1]]
}

export function paymentTraceProjectedGeometryV1(
  layout: "rail" | "wide",
  renderedWidth: number,
): PaymentTraceProjectedGeometryV1 {
  const geometry = paymentTraceGeometryV1(layout)
  const safeWidth = Number.isFinite(renderedWidth) && renderedWidth > 0
    ? renderedWidth
    : geometry.width
  const horizontalScale = safeWidth / geometry.width
  const projectNode = (id: PaymentTraceNodeIdV1): PaymentTraceProjectedNodeGeometryV1 => {
    const node = geometry.nodes[id]
    return {
      x: node.x * horizontalScale,
      y: node.y,
      w: node.w * horizontalScale,
      h: node.h,
    }
  }
  const projectEdge = (id: PaymentTraceEdgeIdV1): PaymentTraceProjectedEdgeGeometryV1 => {
    const edge = geometry.edges[id]
    return {
      source: projectPointV1(edge.source, horizontalScale),
      target: projectPointV1(edge.target, horizontalScale),
    }
  }

  return {
    width: safeWidth,
    height: geometry.height,
    nodes: {
      buyer: projectNode("buyer"),
      merchant: projectNode("merchant"),
      hyperswitch: projectNode("hyperswitch"),
      connector: projectNode("connector"),
      reconcile: projectNode("reconcile"),
      tickets: projectNode("tickets"),
    },
    edges: {
      buyer_merchant: projectEdge("buyer_merchant"),
      merchant_hyperswitch: projectEdge("merchant_hyperswitch"),
      hyperswitch_connector: projectEdge("hyperswitch_connector"),
      connector_hyperswitch: projectEdge("connector_hyperswitch"),
      hyperswitch_retrieve: projectEdge("hyperswitch_retrieve"),
      reconcile_merchant: projectEdge("reconcile_merchant"),
      merchant_tickets: projectEdge("merchant_tickets"),
    },
  }
}
