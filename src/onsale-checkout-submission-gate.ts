export interface CheckoutSubmissionLeaseV1 {
  readonly token: number
  readonly evidenceRevision: string
}

export interface CheckoutSubmissionGateV1 {
  readonly tryAcquire: (
    evidenceRevision: string,
  ) => CheckoutSubmissionLeaseV1 | null
  readonly releaseAfterConfirmationReconcile: (
    token: number,
    evidenceRevision: string,
    checkoutReady: boolean,
  ) => boolean
  readonly revoke: () => void
  readonly current: () => CheckoutSubmissionLeaseV1 | null
}

/**
 * A synchronous, memory-only gate around the one irreversible browser action.
 * SDK settlement is deliberately not an unlock signal. Only a fresh server
 * projection may make the same checkout interactive again.
 */
export function createCheckoutSubmissionGateV1(): CheckoutSubmissionGateV1 {
  let lease: CheckoutSubmissionLeaseV1 | null = null
  let nextToken = 1

  return {
    tryAcquire(evidenceRevision) {
      if (lease !== null || evidenceRevision.length === 0) return null
      lease = { token: nextToken, evidenceRevision }
      nextToken += 1
      return lease
    },
    releaseAfterConfirmationReconcile(token, evidenceRevision, checkoutReady) {
      if (
        lease === null ||
        lease.token !== token ||
        !checkoutReady ||
        evidenceRevision === lease.evidenceRevision
      ) {
        return false
      }
      lease = null
      return true
    },
    revoke() {
      lease = null
    },
    current() {
      return lease
    },
  }
}
