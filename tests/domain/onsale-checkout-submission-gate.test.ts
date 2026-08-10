import { describe, expect, it } from "vitest"

import { createCheckoutSubmissionGateV1 } from "../../src/onsale-checkout-submission-gate"

describe("C3 official checkout submission gate", () => {
  it("acquires synchronously so Enter and pointer activation can confirm at most once", () => {
    const gate = createCheckoutSubmissionGateV1()

    const lease = gate.tryAcquire("revision-1")
    expect(lease).toEqual({ token: 1, evidenceRevision: "revision-1" })
    expect(gate.tryAcquire("revision-1")).toBeNull()
    expect(gate.current()).toEqual(lease)
  })

  it("does not unlock from an SDK result or throw before server reconciliation", () => {
    const gate = createCheckoutSubmissionGateV1()
    const lease = gate.tryAcquire("revision-1")
    if (!lease) throw new Error("expected a lease")

    expect(gate.releaseAfterConfirmationReconcile(lease.token, "revision-1", false)).toBe(false)
    expect(gate.tryAcquire("revision-1")).toBeNull()
  })

  it("unlocks only for its confirmation lease after a fresh checkout-ready projection", () => {
    const gate = createCheckoutSubmissionGateV1()
    const lease = gate.tryAcquire("revision-1")
    if (!lease) throw new Error("expected a lease")

    expect(gate.releaseAfterConfirmationReconcile(lease.token + 1, "revision-2", true)).toBe(false)
    expect(gate.releaseAfterConfirmationReconcile(lease.token, "revision-2", true)).toBe(true)
    expect(gate.current()).toBeNull()
    expect(gate.tryAcquire("revision-2")).toEqual({
      token: 2,
      evidenceRevision: "revision-2",
    })
  })

  it("revokes a lease when the cookie pointer no longer resolves", () => {
    const gate = createCheckoutSubmissionGateV1()
    expect(gate.tryAcquire("revision-1")).not.toBeNull()

    gate.revoke()

    expect(gate.current()).toBeNull()
  })
})
