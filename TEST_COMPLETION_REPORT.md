# Test Completion Report

**Date:** 2026-08-13
**Scope:** All 22 scenarios in `IMPLEMENTATION_PLAN.md` §9 ("Testing plan, expanded from the deployment guide's 10 scenarios").
**Deliverable:** matches `IMPLEMENTATION_PLAN.md` §10's "Test completion report — a written summary of every scenario in §9, pass/fail, tied to the actual test run."

## Method, stated plainly

This environment has no live device, no paired FlutterFlow Desktop session, and no Stripe test-mode execution path available (confirmed: no `testpilot.*` or `live.*` MCP tools are connected in this session). §9's own scenarios are multi-actor, real-money, and often time-boundary-dependent (a real calendar month rollover, a real 5th-of-month cron firing) — genuinely not executable as a live run from here.

What **was** done instead: a rigorous, adversarial, file:line-cited **code trace** of every scenario against the actual implementation — every Cloud Function body in `firebase/functions/src/*.ts`, every DSL wiring path in `dsl/edit.dart`, and the actual rendered/compiled output in `generated_code/lib/**/*_widget.dart` (not just DSL intent — what genuinely landed). Five independent passes were run in parallel, each scoped to a batch of scenarios, each explicitly instructed to read real function bodies and real generated widget code rather than infer behavior from function/action names.

**This is necessary, not sufficient.** A code trace can confirm the wiring is real and internally consistent, and can catch genuine logic bugs (two were found and fixed — see below). It cannot confirm: real Firebase email/SMS delivery, real Stripe API behavior under live network conditions, exact UI timing/races only observable at runtime, or anything spanning a real calendar boundary. Every scenario below is marked with which kind of confidence it has.

**Verdict key:**
- **TRACED-CORRECT** — full chain confirmed via code; would very likely pass a live run.
- **TRACED-PARTIAL** — some steps confirmed correct, specific gaps found (listed, not hedged).
- **TRACED-BROKEN** — a real bug found that would fail this scenario live. *(Both bugs found this way were fixed in this same pass — see "Bugs found and fixed" below; none remain open.)*
- **UNTESTABLE-BY-TRACE** — genuinely requires live execution; static reading cannot confirm this one way or the other.

---

## Results, scenario by scenario

| # | Scenario | Verdict | Notes |
|---|---|---|---|
| 1 | Guest signup → verify chain → KYC → admin approval → unlock | **TRACED-CORRECT** | Full chain confirmed in `generated_code`, not just DSL. Email/SMS delivery itself is UNTESTABLE-BY-TRACE. |
| 2 | Cast signup → staff-type persists + editable from Work page | **TRACED-CORRECT** | — |
| 3 | Search/filter → profile → request → Authorize → confirmed | **TRACED-PARTIAL** | Reservation chain fully correct. "Search/filter" itself is a dead text field — no query wired (already tracked `[PARTIAL]` in IMPLEMENTATION_PLAN.md §3.3, not a new finding). Unfiltered browse works, so the scenario's *later* steps are reachable via that path. |
| 4 | Bulk-invite ≤5 favorites, `group_invite` auto-hide | **TRACED-CORRECT** (2026-08-16) | Bulk-send chain fully correct (cap enforced, multi-cast reservation created correctly). The auto-hide gap noted here was fixed in the comprehensive review pass (`PROJECT_KNOWLEDGE.md` §111): `ReservationForm`'s group-invite checkbox + headcount dropdown now auto-hide via `isSingleCastId`/`shouldShowGroupSize` whenever `castId` arrives as a bulk-invite comma-joined multi-ID list. |
| 5 | Cast approves → chat unlocks instantly | **TRACED-CORRECT** | Server-side gate (`sendChatMessage` requires an existing `active` room, which only exists post-confirm) — structurally unreachable pre-confirm, not just hidden. |
| 6 | Group-invite accept → affiliate pull vs Work-board; cancel just the group-invite portion | **TRACED-PARTIAL** | Work-board path is real and complete. "Affiliate-network pull" as an alternate mechanism is **not implemented at all** — only Work-board ever fires (already tracked `[MISSING]` in IMPLEMENTATION_PLAN.md, not a new finding). Cast/poster self-service cancel of just the group-invite portion does not exist — only an admin-only close action does. |
| 7 | Meetup confirm → in_progress → Capture → review_pending → review → completed | **TRACED-PARTIAL** | Instant chat-lock on review-completion: correct. Real Stripe Transfer to the cast's connected account: correct, though deliberately deferred to review-submission time (or a timer fallback), not simultaneous with Capture — an intentional, already-documented design choice testers should know going in. The "`active` flips only after the timer, separately from the instant lock" framing doesn't hold literally — both are the same field/write in the normal flow, by an already-documented design decision (not a bug). |
| 8 | 30-minute rule (same guest↔cast pair, dedupe within 1800s) | **TRACED-CORRECT** | — |
| 9 | Night-slot ¥5,000 fee: disclosure+consent, ¥2,500/¥2,500 split, affiliate-base exclusion | **TRACED-PARTIAL** | Money split (¥2,500/¥2,500) and affiliate-base exclusion (fee subtracted before the affiliate % is applied) both confirmed correct in code. A *dedicated* consent/disclosure step for the night fee specifically does not exist — the fee is shown as a normal line item in the general cost breakdown, and the general "confirm booking" button is the only consent gesture. Minor UX gap, not a money-correctness bug. |
| 10 | Extensions: independent PI/Capture/Transfer, 6h cap, 4th rejected | **TRACED-CORRECT** | 4th-extension rejection confirmed enforced server-side inside a transaction — not bypassable by a direct callable client. |
| 11 | Cancellation matrix (4 cases) | **TRACED-PARTIAL → bug found and fixed** | Guest-cancellation percentages (100/25/75 at-arrival, 50/0/100 ≤1h) both confirmed correct against actual code. Cast-cancellation "sufficient vs. insufficient Stripe balance" is not literally two branches in code — both cases go through one, always-deferred `logical_debt` path (functionally safer than the literal spec wording, not a bug, but different from what's described). **A real bug WAS found and is now fixed**: a cast cancelling an `in_progress` reservation left any already-captured extension PaymentIntent untouched, so "100% refund to guest" did not hold once an extension had been captured. See "Bugs found and fixed" below. |
| 12 | Staff-fee-first split | **TRACED-CORRECT** | `staff_fee` confirmed subtracted from the reward base before cast(s) are paid, not split differently. |
| 13 | Multi-cast fan-out, one `transfer_group` | **TRACED-CORRECT** | One Capture, N independent Transfers, all sharing one `transfer_group` — confirmed exactly. |
| 14 | Debt offset: two-phase transaction-then-Transfer, no "reduced but not transferred" state | **TRACED-PARTIAL → bug found and fixed** | The debt-vs-transfer *ordering* is correct — no inconsistent state is ever observable. **A real bug WAS found and is now fixed**: on a failed Stripe Transfer, the ledger entry was marked `status: "retrying"` but nothing anywhere ever queried that status back out — money was never lost, but a failed transfer was permanently stranded with no retry path. See "Bugs found and fixed" below. |
| 15 | Withdrawal: blocked on debt, admin-approval gates real payout | **TRACED-CORRECT** | Server AND UI both gate correctly; admin approval uses a transactional claim so double-approval can't double-pay. |
| 16 | Account deletion: blocked on active reservation or pending ledger | **TRACED-CORRECT** | Function is literally named `requestWithdrawal` despite being account-deletion, not money-withdrawal — a real naming quirk, not a bug (confirmed intentional, distinct from the actual money-withdrawal function `requestPayout`). |
| 17 | Affiliate: <3-day deferral (not forfeiture), ≥3-day payout, mutual-approval accrual gate, asymmetric leave rules | **TRACED-CORRECT** | All four sub-behaviors confirmed in code exactly as specified, including the asymmetry between referrer-leaves (forfeits all pending months) and referred-cast-leaves (forfeits only the departure month). A real month-boundary/cron firing is UNTESTABLE-BY-TRACE. |
| 18 | Webhook idempotency (duplicate event delivery) | **TRACED-CORRECT** | Dedupe check happens transactionally, before any side-effecting work — confirmed a duplicate delivery is a genuine no-op. |
| 19 | Report/block: viewer-only block scope, admin chat-log + freeze | **TRACED-CORRECT** | The admin "freeze from report review" button (built this session) confirmed live in `generated_code`, not just DSL intent. |
| 20 | Home ranking (3 tiers) + GPS fallback | **TRACED-CORRECT** | All three sort tiers confirmed in order; real 10-prefecture centroid fallback confirmed, not a silent failure. |
| 21 | Admin: every manual-override action writes an audit log | **TRACED-PARTIAL** | Every write-capable `admin*` Cloud Function confirmed to call `createAuditLog` — the "near-universal accountability guarantee" holds with zero exceptions found. One UI-coverage gap (not an audit-log gap): `adminHireWorkPostApplicant` exists and IS audited, but has no admin-panel button — an already-documented, deliberate scope decision (admin work-post management was explicitly scoped to create/stop only, per the DSL's own comment), not an oversight. |
| 22 | Firestore rules: reject non-admin `ledger` writes, non-owner `users` writes, non-participant chat reads | **TRACED-CORRECT** | Independently re-confirmed the §70 CRITICAL security fix (blanket `users/{uid}` write denial) is byte-for-byte unchanged from `HEAD` — not regressed by anything built this session. |

---

## Bugs found and fixed during this pass

Two genuine, previously-undiscovered bugs surfaced only by tracing these scenarios against real code (not from a prior review round). Both are fixed as part of this same pass, not just reported:

1. **Extension PaymentIntents not refunded on whole-reservation cancel** (`cancelPayment`, `stripe-payments.ts`). A cast (or admin) cancelling a reservation only ever touched the reservation's own base PaymentIntent — any extension PaymentIntents were silently left untouched, so a guest could be left charged for extension time on a reservation that was otherwise fully cancelled/refunded. Fixed: `cancelPayment` now sweeps every non-cancelled extension, releasing (`paymentIntents.cancel`) any not-yet-captured extension and refunding (`refunds.create`) any already-captured one, and releases each extension's own locked `schedule_slots` row.
2. **Failed cast-reward transfers had no retry path** (`transferPendingCastRewards`, `stripe-payments.ts`). A failed Stripe Transfer correctly marked its ledger entry `status: "retrying"` but nothing anywhere ever queried that status back out — the money was never lost (the ledger entry is an accurate record), but the payout was permanently stranded. Fixed: new scheduled function `retryFailedCastTransfers` (hourly, bounded to 50/run, mirroring this backend's existing `autoCancelExpiredAuth`/`autoCompleteReviews` sweep pattern) re-attempts every `retrying` reward entry.

Both fixes: `npm run build` clean. **Not yet deployed** — see the standing undeployed-functions list; `retryFailedCastTransfers` in particular needs a real deploy to ever actually run (it's a new `onSchedule` function, inert until live).

## Already-known gaps re-confirmed (not new findings)

Several scenarios surfaced gaps that were already disclosed elsewhere in this project's own documentation before this pass — re-confirmed as still-true, not newly discovered: search/filter (§3.3, `[PARTIAL]`; the HomePage discovery-cast keyword search half was fixed 2026-08-16, `PROJECT_KNOWLEDGE.md` §111 — the general list-filter/sort gap this line originally tracked is otherwise unchanged), affiliate-network-pull as an alternate group-invite mechanism (`[MISSING]`), bulk-invite's `group_invite` auto-hide (fixed 2026-08-16, see row 4 above and `PROJECT_KNOWLEDGE.md` §111), admin work-post hire-UI (a deliberate scope decision). None of these were silently re-discovered and left unmentioned — each is cited by name above.

## Standing limitation, same as every prior verification round this session

No live Stripe test-mode run, no live-device testing, and no real calendar-boundary/cron execution was possible in this environment. Every **TRACED-CORRECT** verdict above means "the code is real, wired, and internally consistent with what the scenario expects" — it is necessary evidence toward a passing live test, not a substitute for actually running one. Before production cutover, §11 of `IMPLEMENTATION_PLAN.md` already calls for re-running this full scenario list against live-mode Stripe with real (small) transactions — that step remains required and is not satisfied by this report.
