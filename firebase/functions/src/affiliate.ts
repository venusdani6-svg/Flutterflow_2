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
  { schedule: "0 3 5 * *", timeZone: "Asia/Tokyo" },
  async () => {
    const config = await getSystemConfig();

    const now = new Date();
    const targetYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const targetMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const monthStr = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;

    console.log(`Processing affiliate payments for month: ${monthStr}`);

    const pendingRewards = await db
      .collection("affiliate_rewards")
      .where("month", "==", monthStr)
      .where("status", "==", "pending")
      .get();

    if (pendingRewards.empty) {
      console.log("No pending affiliate rewards for this month.");
      return;
    }

    const rewardsByAffiliator: Record<string, FirebaseFirestore.QueryDocumentSnapshot[]> = {};
    for (const doc of pendingRewards.docs) {
      const data = doc.data();
      const affiliatorUid = data.affiliator_uid;
      if (!rewardsByAffiliator[affiliatorUid]) {
        rewardsByAffiliator[affiliatorUid] = [];
      }
      rewardsByAffiliator[affiliatorUid].push(doc);
    }

    for (const [affiliatorUid, rewards] of Object.entries(rewardsByAffiliator)) {
      try {
        await processAffiliatorPayment(affiliatorUid, rewards, monthStr, config);
      } catch (err) {
        console.error(`Failed to process affiliate payment for ${affiliatorUid}:`, err);
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

  const minDays = config.AFFILIATE_MIN_DAYS || 3;
  const workDays = await countUniqueWorkDays(affiliatorUid, monthStr);

  if (workDays < minDays) {
    console.log(
      `Affiliator ${affiliatorUid} has only ${workDays} work days (need ${minDays}). Forfeiting.`
    );
    await forfeitRewards(rewards, `稼働日数不足 (${workDays}/${minDays}日)`);
    return;
  }

  const validRewards: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let totalRewardAmount = 0;

  for (const reward of rewards) {
    const rewardData = reward.data();
    const referredDoc = await db.collection("users").doc(rewardData.referred_uid).get();
    const referredData = referredDoc.data();

    if (!referredData || !referredData.is_active) {
      await reward.ref.update({ status: "forfeited" });
      console.log(
        `Referred cast ${rewardData.referred_uid} is inactive. Forfeiting reward ${reward.id}.`
      );
      continue;
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

  const referredCasts = await db
    .collection("users")
    .where("referred_by_uid", "==", uid)
    .get();

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
    current_month: currentMonth,
    current_month_work_days: workDays,
    current_month_min_days: 3,
    current_month_pending_amount: currentMonthPending,
    current_month_reward_count: currentMonthCount,
    all_time_paid: allTimePaid,
    eligible_for_payment: workDays >= 3,
  };
});
