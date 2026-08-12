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

  const minDays = config.affiliate_min_days || 3;
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

    validRewards.push(reward);
    totalRewardAmount += rewardData.reward_amount;
  }

  if (validRewards.length === 0 || totalRewardAmount <= 0) {
    console.log(`No valid rewards for affiliator ${affiliatorUid}.`);
    return;
  }

  if (!affiliatorData.stripe_account_id) {
    console.error(`Affiliator ${affiliatorUid} has no Stripe account.`);
    return;
  }

  try {
    const transfer = await stripe.transfers.create({
      amount: totalRewardAmount,
      currency: "jpy",
      destination: affiliatorData.stripe_account_id,
      metadata: {
        type: "affiliate",
        affiliator_uid: affiliatorUid,
        month: monthStr,
        reward_count: validRewards.length.toString(),
      },
    });

    const batch = db.batch();
    for (const reward of validRewards) {
      batch.update(reward.ref, {
        status: "paid",
        paid_at: Timestamp.now(),
      });
    }
    await batch.commit();

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

    console.log(
      `Affiliate payment completed: ${affiliatorUid}, ¥${totalRewardAmount}, ${validRewards.length} rewards`
    );
  } catch (err: any) {
    console.error(`Affiliate transfer failed for ${affiliatorUid}:`, err);

    for (const reward of validRewards) {
      await reward.ref.update({ status: "pending" });
    }
  }
}

function monthStrFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function countUniqueWorkDays(castUid: string, monthStr: string): Promise<number> {
  const [year, month] = monthStr.split("-").map(Number);
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

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
      const dateStr = `${completedDate.getFullYear()}-${completedDate.getMonth()}-${completedDate.getDate()}`;
      uniqueDates.add(dateStr);
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
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

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
  // separate range queries against the same composite index.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
    const dateKey = `${completedAt.getFullYear()}-${completedAt.getMonth()}-${completedAt.getDate()}`;

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
    current_month_min_days: config.affiliate_min_days || 3,
    current_month_pending_amount: currentMonthPending,
    current_month_reward_count: currentMonthCount,
    all_time_paid: allTimePaid,
    // Reflects the FULL payment-time gate, not just the work-day count:
    // an affiliator who is frozen/inactive/unapproved would have their
    // reward forfeited by processAffiliatorPayment regardless of work
    // days (§3.7.12's mutual-approval + continued-contribution rules), so
    // "eligible" would be misleading if it only checked work days.
    eligible_for_payment:
      workDays >= (config.affiliate_min_days || 3) &&
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
