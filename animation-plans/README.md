# Animation plans

Motion is part of the ONSALE product contract. These plans restore explanatory
causality without reintroducing simulated payment evidence.

| Number | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Restore the authored causal trace and amber signal](001-restore-authored-causal-trace.md) | HIGH | TODO |

## Recommended execution order

1. Execute plan 001 as one reviewable vertical slice. The shared renderer,
   production projection, replay controller, and verification depend on the
   same motion-event contract and should not be split across unrelated commits.
2. Review the live rail and `/flows` replay at 10% playback speed before any
   additional decorative motion is considered.
3. Keep the trace static on completed Previous Runs until the reviewer
   explicitly chooses Replay Trace.

## Dependency

Plan 001 assumes commit `340e336` plus the current uncommitted
`PaymentTraceMapV1`/production rail/operations workspace. If those files change,
reconcile the cited excerpts and data types before execution.
