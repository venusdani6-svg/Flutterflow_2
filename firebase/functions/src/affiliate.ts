/**
 * Affiliate System Cloud Functions
 * アフィリエイトシステム
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, stripe, Timestamp, getSystemConfig } from "./config";

/**
 * Scheduled: Monthly affiliate payment processing
 * 毎月5日 3:00 AM JST
 */
export const processMonthlyAffiliatePayments = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Asia/Tokyo" },
  async () => {
    const config = await getSystemConfig();

    // Cloud Scheduler cron strings are static at deploy time and can't read
    // Firestore, so this runs daily and no-ops on every day except the
    // admin-configured payment day (system_config/settings.affiliate_payment_day,
    // default 5) — the only way to make "pay out on the Nth" genuinely
    // admin-editable instead of a hardcoded literal in the cron string.
    //
    // MUST compute "today" in JST explicitly, not via bare `new Date()`:
    // the `timeZone: "Asia/Tokyo"` option below only controls when Cloud
    // Scheduler FIRES the trigger (wall-clock JST) — it does not change
    // what the function's own runtime clock reports. Cloud Functions run
    // in UTC, and JST is UTC+9, so a 3:00 AM JST firing happens at 18:00
    // UTC the PREVIOUS day — `new Date().getDate()` would read that
    // previous UTC day and never match `paymentDay`, silently preventing
    // this function from ever actually processing a payment.
    const paymentDay = config.affiliate_payment_day || 5;
    const jstDay = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", day: "numeric" }).format(new Date())
    );
    if (jstDay !== paymentDay) {
      return;
    }

    // Query ALL pending rewards, not just "last calendar month" — a reward
    // deferred earlier (workDays < minDays in its own accrual month) must
    // stay pending and be genuinely re-evaluable on a later run, not tied to
    // a single fixed target month. Group by (affiliator, accrual month) so
    // each month's own work-day eligibility is evaluated independently.
    const pendingRewards = await db
      .collection("affiliate_rewards")
      .where("status", "==", "pending")
      .get();

    if (pendingRewards.empty) {
      console.log("No pending affiliate rewards.");
      return;
    }

    const grouped: Record<string, Record<string, FirebaseFirestore.QueryDocumentSnapshot[]>> = {};
    for (const doc of pendingRewards.docs) {
      const data = doc.data();
      const affiliatorUid = data.affiliator_uid;
      const month = data.month;
      // FIX (comprehensive project-wide review round 2, SUSPECTED risk):
      // a doc with a missing/malformed `month` (e.g. a stray placeholder
      // doc of the same class already documented elsewhere in this
      // codebase) used to group under the literal string "undefined".
      // `countUniqueWorkDays("undefined")` then does `"undefined".split(
      // "-")` -> NaN -> `Timestamp.fromDate(new Date(NaN))`, which throws —
      // caught only by the per-(affiliator,month) try/catch below, so it
      // aborts just that group but reruns and fails identically every day,
      // permanently wedging that reward as "pending" with no way to
      // recover. Skip and log instead so one malformed doc can't do that
      // while every other affiliator's payment keeps processing normally.
      if (!affiliatorUid || typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
        console.error(
          `Skipping malformed affiliate_rewards doc ${doc.id}: affiliator_uid=${affiliatorUid}, month=${month}`
        );
        continue;
      }
      grouped[affiliatorUid] = grouped[affiliatorUid] || {};
      grouped[affiliatorUid][month] = grouped[affiliatorUid][month] || [];
      grouped[affiliatorUid][month].push(doc);
    }

    for (const [affiliatorUid, byMonth] of Object.entries(grouped)) {
      for (const [monthStr, rewards] of Object.entries(byMonth)) {
        try {
          await processAffiliatorPayment(affiliatorUid, rewards, monthStr, config);
        } catch (err) {
          console.error(`Failed to process affiliate payment for ${affiliatorUid} (${monthStr}):`, err);
        }
      }
    }
  }
);

async function processAffiliatorPayment(
  affiliatorUid: string,
  rewards: FirebaseFirestore.QueryDocumentSnapshot[],
  monthStr: string,
  config: Record<string, any>
): Promise<void> {
  const affiliatorDoc = await db.collection("users").doc(affiliatorUid).get();
  const affiliatorData = affiliatorDoc.data();

  if (!affiliatorData || !affiliatorData.is_active || affiliatorData.is_frozen) {
    console.log(`Affiliator ${affiliatorUid} is inactive/frozen. Forfeiting rewards.`);
    await forfeitRewards(rewards, "アフィリエイターが退会/凍結済み");
    return;
  }

  if (affiliatorData.approval_status !== "approved") {
    console.log(`Affiliator ${affiliatorUid} is not approved. Forfeiting rewards.`);
    await forfeitRewards(rewards, "アフィリエイターが未承認");
    return;
  }

  // FIX (confirmed live bug, found during comprehensive review): `|| 3`
  // silently coerced a legitimate admin-set `0` (no minimum working days
  // required) back to the default 3 — unlike `affiliate_payment_day`,
  // `affiliate_min_days` had zero write-side validation, so an admin
  // setting exactly this value would have it silently ignored. Explicit
  // `typeof` check preserves a real 0.
  const minDays = typeof config.affiliate_min_days === "number" ? config.affiliate_min_days : 3;
  const workDays = await countUniqueWorkDays(affiliatorUid, monthStr);

  if (workDays < minDays) {
    // Active-earner rule (IMPLEMENTATION_PLAN.md §3.7.12): missing the
    // threshold DEFERS this month's Transfer — rewards stay `pending` and
    // are re-evaluated on a later run once countUniqueWorkDays no longer
    // falls short. This is explicitly NOT a forfeiture event; do not call
    // forfeitRewards here — forfeiture is the separate, narrower leave rule
    // below.
    console.log(
      `Affiliator ${affiliatorUid} has only ${workDays} work days for ${monthStr} (need ${minDays}). Deferring.`
    );
    return;
  }

  const validRewards: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let totalRewardAmount = 0;

  for (const reward of rewards) {
    // FIX (confirmed live bug, found during audit): the entire per-reward
    // body below was unguarded - `db.collection("users").doc(X)` throws
    // SYNCHRONOUSLY (before any network call) if X is not a non-empty
    // string, which happens if `rewardData.referred_uid` is missing on a
    // malformed doc (admin.ts's own comments confirm at least one such
    // `_seed` placeholder doc already exists in `affiliate_rewards`). That
    // throw was never caught locally - it propagated out of this whole
    // function, and the only catch is the OUTER per-(affiliator,month)
    // try/catch in processMonthlyAffiliatePayments, which aborts the
    // ENTIRE batch for this affiliator+month. Result: every other
    // legitimately-valid pending reward for the same affiliator+month
    // never gets paid OR forfeited - stuck "pending" forever, re-failing
    // at the same bad doc every single day the cron fires. Wrapped so one
    // bad reward doc can no longer take down every other reward alongside
    // it; the bad one is logged and left "pending" (not silently
    // forfeited - an admin should investigate a malformed reward doc, not
    // have it quietly disappear) while the rest of the batch proceeds
    // normally.
    try {
    const rewardData = reward.data();
    const referredDoc = await db.collection("users").doc(rewardData.referred_uid).get();
    const referredData = referredDoc.data();

    if (!referredData) {
      await reward.ref.update({ status: "forfeited" });
      console.log(`Referred cast ${rewardData.referred_uid} not found. Forfeiting reward ${reward.id}.`);
      continue;
    }

    if (!referredData.is_active) {
      // §3.7.12's asymmetric leave rule: a referred cast's own voluntary
      // withdrawal (requestWithdrawal stamps left_at) forfeits only the
      // reward accrued in the departure month itself; reward earned in
      // prior months while still active is still paid normally. Any other
      // is_active:false path with no left_at (e.g. an admin force-ban) has
      // no client-confirmed equivalence to a leave (plan's own caveat) —
      // keep the conservative forfeit-everything behavior for that case.
      const leftMonthStr = referredData.left_at
        ? monthStrFromDate(referredData.left_at.toDate())
        : null;
      if (leftMonthStr === null || leftMonthStr === rewardData.month) {
        await reward.ref.update({ status: "forfeited" });
        console.log(
          `Referred cast ${rewardData.referred_uid} inactive (left ${leftMonthStr ?? "unknown"}). Forfeiting reward ${reward.id} for ${rewardData.month}.`
        );
        continue;
      }
    }

    // Client-confirmed decision (audit follow-up, 2026-08-12): freezing a
    // referred cast counts the same as that cast leaving, month-scoped
    // identically to the voluntary-withdrawal path above (only the
    // reward accrued in the SAME month the freeze happened is forfeited -
    // reward already earned in prior months, while still active and
    // unfrozen, is unaffected). `frozen_at` (admin.ts's adminToggleFreeze)
    // gives the same month-scoping precision `left_at` gives the
    // voluntary-departure case.
    if (referredData.is_frozen) {
      const frozenMonthStr = referredData.frozen_at
        ? monthStrFromDate(referredData.frozen_at.toDate())
        : null;
      if (frozenMonthStr === null || frozenMonthStr === rewardData.month) {
        await reward.ref.update({ status: "forfeited" });
        console.log(
          `Referred cast ${rewardData.referred_uid} frozen (${frozenMonthStr ?? "unknown"}). Forfeiting reward ${reward.id} for ${rewardData.month}.`
        );
        continue;
      }
    }

    // FIX (confirmed live bug, found during audit): the mutual-approval
    // rule (IMPLEMENTATION_PLAN.md §3.7.12/§4.2, "both parties remained
    // approved throughout") was only re-checked for the REFERRER above
    // (line ~92) at payment time - the REFERRED cast's own
    // `approval_status` was never re-checked here at all, only `is_active`/
    // `is_frozen`. A referred cast whose KYC gets revoked (re-review,
    // fraud flag, expired license) after their referral reward already
    // accrued but before the monthly batch would still be paid in full,
    // violating the rule. No `left_at`-equivalent timestamp exists for an
    // approval_status change to month-scope this precisely, so mirrors the
    // REFERRER-side precedent exactly (line ~92-96): forfeit outright
    // rather than defer, matching how "not approved" is already treated
    // for the other party in this exact function.
    if (referredData.approval_status !== "approved") {
      await reward.ref.update({ status: "forfeited" });
      console.log(
        `Referred cast ${rewardData.referred_uid} not approved (${referredData.approval_status}). Forfeiting reward ${reward.id} for ${rewardData.month}.`
      );
      continue;
    }

    validRewards.push(reward);
    totalRewardAmount += rewardData.reward_amount;
    } catch (err) {
      console.error(
        `Skipping malformed/unprocessable reward ${reward.id} for affiliator ${affiliatorUid} (left pending, not forfeited):`,
        err
      );
      continue;
    }
  }

  if (validRewards.length === 0 || totalRewardAmount <= 0) {
    console.log(`No valid rewards for affiliator ${affiliatorUid}.`);
    return;
  }

  if (!affiliatorData.stripe_account_id) {
    console.error(`Affiliator ${affiliatorUid} has no Stripe account.`);
    return;
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, CRITICAL — comprehensive project-wide
  // review): the original single try/catch below spanned well past the
  // point where real money had already moved (the transfer) and the
  // rewards had already been marked "paid" — if the LEDGER write or the
  // NOTIFICATION write threw for any transient reason, the catch block
  // unconditionally reverted every reward back to "pending", with no check
  // of whether the transfer itself had actually succeeded. The next
  // scheduled run's `status=="pending"` query would then pick up the SAME
  // rewards again and pay this affiliator a second time — a real,
  // demonstrated double-transfer path, not a theoretical one.
  //
  // Two independent layers of defense now:
  // 1. An `idempotencyKey` on the Stripe call itself, stable per
  //    (affiliator, month) — confirmed via processMonthlyAffiliatePayments'
  //    own grouping (line ~65) that this function is called at most once
  //    per (affiliatorUid, monthStr) pair within a single run. If this
  //    function is EVER invoked again for the same pair (a later run after
  //    a bookkeeping failure, a manual re-trigger, anything) Stripe itself
  //    returns the SAME transfer object instead of creating a second one —
  //    this is what actually prevents the double-payment, independent of
  //    whatever Firestore bookkeeping does afterward.
  // 2. The try/catch boundary now only wraps the transfer call itself.
  //    Once the transfer succeeds, marking rewards "paid" is retried
  //    in-place rather than silently reverted (reverting here would be the
  //    same bug again — a batch-commit failure right after a successful
  //    transfer must never make these rewards look untouched to the next
  //    run's query), and the ledger/notification writes are separately
  //    best-effort: their failure is logged loudly but never un-marks a
  //    reward or touches the transfer.
  let transfer: import("stripe").Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: totalRewardAmount,
        currency: "jpy",
        destination: affiliatorData.stripe_account_id,
        metadata: {
          type: "affiliate",
          affiliator_uid: affiliatorUid,
          month: monthStr,
          reward_count: validRewards.length.toString(),
        },
      },
      { idempotencyKey: `affiliate_${affiliatorUid}_${monthStr}` }
    );
  } catch (err: any) {
    console.error(`Affiliate transfer failed for ${affiliatorUid}:`, err);
    // The transfer itself never succeeded — nothing was marked "paid" yet,
    // so leaving every reward "pending" for the next run to retry is
    // correct here (this is the one failure mode where the original
    // revert-to-pending logic was actually right).
    return;
  }

  // Money has now genuinely moved (or, if this is a retried call for the
  // same affiliator+month, the idempotency key resolved to the SAME
  // already-completed transfer). From this point on, nothing may revert
  // these rewards to "pending" — that would risk a second real transfer on
  // the next run despite the idempotency key already having prevented the
  // Stripe-side duplicate; the bookkeeping must independently stay
  // consistent with "this money has already moved."
  try {
    const batch = db.batch();
    for (const reward of validRewards) {
      batch.update(reward.ref, {
        status: "paid",
        paid_at: Timestamp.now(),
      });
    }
    await batch.commit();
  } catch (err) {
    console.error(
      `CRITICAL: Stripe transfer ${transfer.id} succeeded for affiliator ${affiliatorUid} (${monthStr}, ¥${totalRewardAmount}) but marking ${validRewards.length} reward(s) "paid" failed — they remain "pending" and WILL be re-evaluated (and, absent the idempotencyKey fix above, re-paid) on the next run. Manual reconciliation required.`,
      err
    );
    return;
  }

  try {
    await db.collection("ledger").add({
      ledger_id: "",
      res_id: "",
      user_id: affiliatorUid,
      type: "affiliate",
      gross_amount: totalRewardAmount,
      cast_reward: 0,
      staff_fee: 0,
      stripe_fee: 0,
      platform_profit: 0,
      tax_amount: 0,
      net_transfer: totalRewardAmount,
      amount: totalRewardAmount,
      stripe_event_id: "",
      stripe_object_id: transfer.id,
      status: "confirmed",
      processed: true,
      created_at: Timestamp.now(),
    });
  } catch (err) {
    console.error(
      `Failed to write ledger entry for affiliate transfer ${transfer.id} (affiliator ${affiliatorUid}, ${monthStr}) — transfer succeeded and rewards are already marked "paid"; this is a reporting gap only, not a payment issue:`,
      err
    );
  }

  try {
    await db
      .collection("users")
      .doc(affiliatorUid)
      .collection("notifications")
      .add({
        type: "stripe",
        title: "アフィリエイト報酬が送金されました",
        body: `${monthStr}分のアフィリエイト報酬 ¥${totalRewardAmount.toLocaleString()} が送金されました。`,
        data: {
          month: monthStr,
          amount: totalRewardAmount,
          transfer_id: transfer.id,
        },
        read: false,
        created_at: Timestamp.now(),
      });
  } catch (err) {
    console.error(
      `Failed to write notification for affiliate transfer ${transfer.id} (affiliator ${affiliatorUid}):`,
      err
    );
  }

  console.log(
    `Affiliate payment completed: ${affiliatorUid}, ¥${totalRewardAmount}, ${validRewards.length} rewards`
  );
}

// FIX (confirmed live bug, found during audit): every date-bucketing
// function in this file used to read `Date.getFullYear()`/`getMonth()`/
// `getDate()` directly, which report the SERVER's local time (UTC in Cloud
// Functions), not Japan's. A reservation completed between 00:00-08:59 JST
// landed in the PREVIOUS UTC calendar day, so it could be counted toward
// the wrong month's work-day total (affecting the minDays eligibility
// threshold in processAffiliatorPayment) or the wrong day in
// getAffiliateDashboard's today/week stats, for roughly a 9-hour window
// every single day. Mirrors the identical, already-correct
// JST_OFFSET_MS-shift pattern used in admin.ts's adminGetDashboardStats.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(date: Date): { year: number; month: number; date: number } {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
  };
}

// The UTC instant for JST midnight on the given JST calendar date (month is
// 0-indexed, matching `Date.UTC`) - the correct lower bound for a Firestore
// range query scoped to "this JST day/month". `Date.UTC` normalizes
// out-of-range month/date indices itself (e.g. month 12 rolls into January
// of the next year), so callers don't need to pre-normalize.
function jstMidnightUtc(year: number, month: number, date: number): Date {
  return new Date(Date.UTC(year, month, date) - JST_OFFSET_MS);
}

function jstDateKey(date: Date): string {
  const { year, month, date: d } = jstParts(date);
  return `${year}-${month}-${d}`;
}

function monthStrFromDate(date: Date): string {
  const { year, month } = jstParts(date);
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

async function countUniqueWorkDays(castUid: string, monthStr: string): Promise<number> {
  const [year, month] = monthStr.split("-").map(Number);
  const startDate = jstMidnightUtc(year, month - 1, 1);
  // Exclusive upper bound (one ms before JST midnight of the FOLLOWING
  // month) rather than "day 0 of month+1 at 23:59:59 local" - sidesteps
  // both the timezone bug and any last-day-of-month edge cases.
  const endDate = new Date(jstMidnightUtc(year, month, 1).getTime() - 1);

  const completedReservations = await db
    .collection("reservations")
    .where("cast_ids", "array-contains", castUid)
    .where("status", "==", "completed")
    .where("updated_at", ">=", Timestamp.fromDate(startDate))
    .where("updated_at", "<=", Timestamp.fromDate(endDate))
    .get();

  const uniqueDates = new Set<string>();
  for (const doc of completedReservations.docs) {
    const completedDate = doc.data().updated_at?.toDate();
    if (completedDate) {
      uniqueDates.add(jstDateKey(completedDate));
    }
  }

  return uniqueDates.size;
}

async function forfeitRewards(
  rewards: FirebaseFirestore.QueryDocumentSnapshot[],
  reason: string
): Promise<void> {
  const batch = db.batch();
  for (const reward of rewards) {
    batch.update(reward.ref, { status: "forfeited" });
  }
  await batch.commit();
  console.log(`Forfeited ${rewards.length} rewards. Reason: ${reason}`);
}

/**
 * Callable: Get affiliate dashboard data for a cast
 */
export const getAffiliateDashboard = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();

  if (!userData || userData.account_type !== "cast") {
    throw new HttpsError("permission-denied", "キャストのみ利用可能です。");
  }

  const config = await getSystemConfig();
  // FIX (confirmed live bug, found during comprehensive review): `|| 3`
  // silently coerced a legitimate admin-set `0` back to the default 3 —
  // same fix as processAffiliatorPayment above.
  const minDaysDisplay = typeof config.affiliate_min_days === "number" ? config.affiliate_min_days : 3;

  const referredCasts = await db
    .collection("users")
    .where("referred_by_uid", "==", uid)
    .get();

  let activeReferredCount = 0;
  let inactiveReferredCount = 0;
  for (const doc of referredCasts.docs) {
    if (doc.data().is_active) activeReferredCount++;
    else inactiveReferredCount++;
  }

  const now = new Date();
  const currentMonth = monthStrFromDate(now);

  const currentRewards = await db
    .collection("affiliate_rewards")
    .where("affiliator_uid", "==", uid)
    .where("month", "==", currentMonth)
    .get();

  const paidRewards = await db
    .collection("affiliate_rewards")
    .where("affiliator_uid", "==", uid)
    .where("status", "==", "paid")
    .get();

  const workDays = await countUniqueWorkDays(uid, currentMonth);

  // Affiliator's own work-time stats (they are a cast themselves) - today /
  // this week / this month / all-time, from their own completed
  // reservations' duration_minutes and distinct completion dates. One
  // unbounded fetch, bucketed client-side by boundary, rather than four
  // separate range queries against the same composite index. Boundaries
  // computed against JST (see jstParts/jstMidnightUtc above), not the
  // server's own local time, for the same reason as countUniqueWorkDays.
  const { year: tYear, month: tMonth, date: tDate } = jstParts(now);
  const startOfToday = jstMidnightUtc(tYear, tMonth, tDate);
  // Weekday doesn't depend on time-of-day, so the weekday of the JST
  // calendar date equals the UTC weekday of a UTC-midnight instant built
  // from the same year/month/date.
  const jstWeekday = new Date(Date.UTC(tYear, tMonth, tDate)).getUTCDay();
  const startOfWeek = jstMidnightUtc(tYear, tMonth, tDate - jstWeekday);
  const startOfMonth = jstMidnightUtc(tYear, tMonth, 1);

  const ownCompleted = await db
    .collection("reservations")
    .where("cast_ids", "array-contains", uid)
    .where("status", "==", "completed")
    .get();

  let minutesToday = 0;
  let minutesWeek = 0;
  let minutesMonth = 0;
  let minutesCumulative = 0;
  const daysWeek = new Set<string>();
  const daysCumulative = new Set<string>();
  for (const doc of ownCompleted.docs) {
    const d = doc.data();
    const completedAt = d.updated_at?.toDate();
    if (!completedAt) continue;
    const minutes = d.duration_minutes || 0;
    const dateKey = jstDateKey(completedAt);

    minutesCumulative += minutes;
    daysCumulative.add(dateKey);
    if (completedAt >= startOfMonth) minutesMonth += minutes;
    if (completedAt >= startOfWeek) {
      minutesWeek += minutes;
      daysWeek.add(dateKey);
    }
    if (completedAt >= startOfToday) minutesToday += minutes;
  }

  let rewardToday = 0;
  let rewardWeek = 0;
  let rewardMonth = 0;
  for (const doc of currentRewards.docs) {
    const d = doc.data();
    const createdAt = d.created_at?.toDate();
    rewardMonth += d.reward_amount || 0;
    if (createdAt && createdAt >= startOfWeek) rewardWeek += d.reward_amount || 0;
    if (createdAt && createdAt >= startOfToday) rewardToday += d.reward_amount || 0;
  }

  let currentMonthPending = 0;
  let currentMonthCount = 0;
  for (const doc of currentRewards.docs) {
    if (doc.data().status === "pending") {
      currentMonthPending += doc.data().reward_amount;
      currentMonthCount++;
    }
  }

  let allTimePaid = 0;
  for (const doc of paidRewards.docs) {
    allTimePaid += doc.data().reward_amount;
  }

  return {
    success: true,
    referral_code: uid,
    affiliate_rate: userData.affiliate_rate || 0.05,
    referred_cast_count: referredCasts.size,
    active_referred_count: activeReferredCount,
    inactive_referred_count: inactiveReferredCount,
    current_month: currentMonth,
    current_month_work_days: workDays,
    current_month_min_days: minDaysDisplay,
    current_month_pending_amount: currentMonthPending,
    current_month_reward_count: currentMonthCount,
    all_time_paid: allTimePaid,
    // Reflects the FULL payment-time gate, not just the work-day count:
    // an affiliator who is frozen/inactive/unapproved would have their
    // reward forfeited by processAffiliatorPayment regardless of work
    // days (§3.7.12's mutual-approval + continued-contribution rules), so
    // "eligible" would be misleading if it only checked work days.
    eligible_for_payment:
      workDays >= minDaysDisplay &&
      !!userData.is_active &&
      !userData.is_frozen &&
      userData.approval_status === "approved",
    work_hours_today: Math.floor((minutesToday / 60) * 10) / 10,
    work_hours_week: Math.floor((minutesWeek / 60) * 10) / 10,
    work_hours_month: Math.floor((minutesMonth / 60) * 10) / 10,
    work_hours_cumulative: Math.floor((minutesCumulative / 60) * 10) / 10,
    work_days_week: daysWeek.size,
    work_days_month: workDays,
    work_days_cumulative: daysCumulative.size,
    reward_today: rewardToday,
    reward_week: rewardWeek,
    reward_month: rewardMonth,
    reward_cumulative: allTimePaid,
    affiliate_payment_day: config.affiliate_payment_day || 5,
  };
});
