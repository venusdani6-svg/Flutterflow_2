/**
 * Stripe Connect Payment Cloud Functions
 * Stripe決済管理 (Authorize → Capture → Transfer)
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, stripe, FieldValue, Timestamp, getSystemConfig } from "./config";

/**
 * Callable: Create PaymentIntent with manual capture (与信確保)
 * 予約時に与信を確保する
 */
export const createPaymentIntent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const {
    res_id,
    amount,
    transport_fee,
    staff_fee,
    cast_ids,
  } = request.data;

  if (!res_id || !amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "予約IDと金額が必要です。");
  }

  // Ownership check - this callable had none at all: it never fetched the
  // reservation to confirm it exists or belongs to the caller before
  // creating a real Stripe PaymentIntent and overwriting that reservation's
  // payment fields (below). Every sibling payment callable in this file
  // (capturePayment, cancelPayment) fetches the reservation and verifies
  // the caller first - this one is guest-only (not admin/cast, unlike
  // those two) because the PaymentIntent is created against the CALLER's
  // own `stripe_customer_id` a few lines below; only the reservation's own
  // guest has a `stripe_customer_id` that's meaningful here.
  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  if (resDoc.data()?.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();
  if (!userData?.stripe_customer_id) {
    throw new HttpsError(
      "failed-precondition",
      "支払い方法が登録されていません。"
    );
  }

  // Phase 5 of implementing the 5 unresolved §17.9 conflicts (C7): "taxi-fee
  // scaling for group bookings", flat-total policy confirmed directly by the
  // user. Real gap found before this fix: this function fully TRUSTED the
  // client-supplied `transport_fee` number for both "does a surcharge apply"
  // AND "how much" - no server-side computation from `transport_fee_amount`
  // existed at all, so group size never scaled anything (nothing here even
  // looked at `cast_ids.length` for the fee amount) and a client could send
  // any number it wanted for a real money field. Per the confirmed flat-total
  // policy, the guest-facing charge stays ONE flat `transport_fee_amount`
  // (e.g. ¥5,000) no matter how many casts are on the reservation - group
  // size only affects how the cast-side half of that flat total is later
  // SPLIT (fixed in `recordCastRewardsAndProcessOthers` below), never the
  // guest charge itself. `transport_fee` from the client is now only a
  // boolean-shaped SIGNAL ("does this booking carry a taxi surcharge at
  // all?", >0 = yes) - preserves the existing caller contract (no request-
  // shape change needed) while the actual AMOUNT is always server-computed
  // and never taken from the client.
  // `getSystemConfig()`'s SYSTEM_DEFAULTS key-casing bug (see config.ts) is
  // now fixed, so this reads through the helper directly rather than the
  // raw-document workaround this block used to need.
  const config = await getSystemConfig();
  const transportFeeAmount = config.transport_fee_amount;

  let finalTransportFee = (transport_fee || 0) > 0 ? transportFeeAmount : 0;

  // Phase 2 of implementing the 5 unresolved §17.9 conflicts (C3): "30分
  // ルール clock" resolved as-is with the client - the App/Stripe spec's
  // definition (same guest+cast PAIR, measured from that pair's last
  // Capture, `pair_history`) is already correctly implemented below and
  // was confirmed as the definition to keep, not the competing キャスト
  // spec wording (same guest, previous reservation's end vs next
  // reservation's start) - see PROJECT_KNOWLEDGE.md §17.9 C3 / §18.11x.
  if (finalTransportFee > 0 && cast_ids && cast_ids.length > 0) {
    const thresholdSec = config.transport_fee_threshold_sec;

    for (const castId of cast_ids) {
      const pairKey = `${request.auth.uid}_${castId}`;
      const pairDoc = await db.collection("pair_history").doc(pairKey).get();

      if (pairDoc.exists) {
        const lastCapture = pairDoc.data()?.last_capture_at?.toDate();
        if (lastCapture) {
          const diffSec = (Date.now() - lastCapture.getTime()) / 1000;
          if (diffSec <= thresholdSec) {
            finalTransportFee = 0;
            break;
          }
        }
      }
    }
  }

  const totalAmount = amount + finalTransportFee + (staff_fee || 0);
  const transferGroup = `res_${res_id}`;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: "jpy",
      customer: userData.stripe_customer_id,
      capture_method: "manual",
      transfer_group: transferGroup,
      metadata: {
        res_id,
        guest_uid: request.auth.uid,
        transport_fee: finalTransportFee.toString(),
        staff_fee: (staff_fee || 0).toString(),
        base_amount: amount.toString(),
        cast_ids: JSON.stringify(cast_ids || []),
      },
    });

    await db.collection("reservations").doc(res_id).update({
      payment_intent_id: paymentIntent.id,
      transfer_group: transferGroup,
      transport_fee: finalTransportFee,
      total_amount: totalAmount,
      thirty_min_rule_applied: finalTransportFee === 0 && (transport_fee || 0) > 0,
      status: "authorized",
      updated_at: Timestamp.now(),
    });

    return {
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      total_amount: totalAmount,
      transport_fee: finalTransportFee,
      thirty_min_rule_applied: finalTransportFee === 0 && (transport_fee || 0) > 0,
    };
  } catch (err: any) {
    console.error("PaymentIntent creation failed:", err);
    throw new HttpsError("internal", `決済の作成に失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Confirm PaymentIntent (ゲストがカード情報を確認して与信を確定)
 */
export const confirmPaymentIntent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { payment_intent_id, payment_method_id } = request.data;

  try {
    const paymentIntent = await stripe.paymentIntents.confirm(payment_intent_id, {
      payment_method: payment_method_id,
    });

    return {
      success: true,
      status: paymentIntent.status,
    };
  } catch (err: any) {
    console.error("PaymentIntent confirmation failed:", err);
    throw new HttpsError("internal", `決済の確認に失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Capture payment (売上確定)
 * 交流完了後に実行
 */
export const capturePayment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const isAdmin = userDoc.data()?.role === "admin";
  if (
    !isAdmin &&
    request.auth.uid !== resData.guest_id &&
    !resData.cast_ids?.includes(request.auth.uid)
  ) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  if (!resData.payment_intent_id) {
    throw new HttpsError("failed-precondition", "決済情報がありません。");
  }

  try {
    await stripe.paymentIntents.capture(resData.payment_intent_id);

    // FIX (was a real gap, IMPLEMENTATION_PLAN.md §6 defect #7): the
    // reservation-status transition, pair_history update, and cast-reward
    // bookkeeping used to happen HERE, optimistically, immediately after
    // `stripe.paymentIntents.capture()` returned — before Stripe's own
    // `payment_intent.succeeded` webhook ever confirmed it. If the Stripe
    // API call above succeeded but this function then crashed or threw
    // before finishing its Firestore writes, the reservation would be
    // stuck at its pre-capture status forever even though the money was
    // genuinely captured (and the client can't safely retry — a second
    // `capture()` on an already-captured PaymentIntent fails outright).
    // All of that now happens in `handlePaymentIntentSucceeded`
    // (stripe-webhooks.ts) instead, driven by Stripe's own confirmation of
    // the capture rather than assumed by this callable. This callable's
    // only remaining job is telling Stripe to capture and reporting
    // whether THAT specific API call succeeded.
    return { success: true, message: "売上確定処理を開始しました。" };
  } catch (err: any) {
    console.error("Payment capture failed:", err);
    throw new HttpsError("internal", `売上確定に失敗しました: ${err.message}`);
  }
});

/**
 * Internal: record cast reward ledger entries + offset debt, plus staff
 * transfers and affiliate reward accrual. Called at CAPTURE time
 * (`capturePayment`, unchanged trigger point).
 *
 * Phase 3 of implementing the 5 unresolved §17.9 conflicts (C4):
 * "capture-vs-transfer moment" - the App spec defines Capture as
 * happening right after 完了報告; the キャスト spec's wallet section says
 * the reward is transferred to the cast's Connect account "after guest
 * review, immediately." The original version of this function conflated
 * both into one operation at Capture time - confirmed with the user this
 * is a real gap to close, not a genuine two-document disagreement to
 * pick a side on: it already had its own "2-Phase Transfer: Firestore
 * Transaction → Stripe Transfer" structure in its own doc comment, so
 * the fix is to split those two phases across the two moments the specs
 * actually describe, not invent a new structure. This function now does
 * ONLY the bookkeeping (Phase 1) - it computes the reward, writes a
 * `ledger` entry, and offsets debt, but does NOT call
 * `stripe.transfers.create` for the cast reward itself. A ledger entry
 * that doesn't need a real transfer (fully debt-offset, `net_transfer <=
 * 0`) is marked `confirmed` immediately here, same as before - there's
 * nothing to defer for those. Entries that DO need a real transfer are
 * left `status: "pending"` for `transferPendingCastRewards` (below) to
 * execute later, at guest-review time or the 24h auto-timeout fallback -
 * see `reservations.ts`'s `submitReview`/`autoCompleteReviews`, and
 * PROJECT_KNOWLEDGE.md §18.111 for the full account.
 *
 * Staff transfers and affiliate reward accrual are UNCHANGED and still
 * happen here, at Capture time - §17.9 C4 is specifically about the
 * CAST's own reward timing, not staff pay, and affiliate accrual timing
 * was already separately resolved to stay at Capture (§17.9 C1: "treat
 * 'on Capture success' as accrual event, not bank Transfer" - the
 * monthly batch Transfer, not this accrual step, is what C1 deferred).
 */
export async function recordCastRewardsAndProcessOthers(
  resId: string,
  resData: FirebaseFirestore.DocumentData
): Promise<void> {
  // `getSystemConfig()`'s SYSTEM_DEFAULTS key-casing bug (see config.ts) is
  // now fixed, so both `tax_rate` and `default_cast_rate` (used a few
  // lines below as a per-cast fallback) correctly reflect 基本設定/キャスト
  // 報酬設定 as actually configured, via this one already-fetched `config`.
  const config = await getSystemConfig();
  const taxRate = config.tax_rate;

  const totalAmount = resData.total_amount;
  const staffFee = resData.staff_fee || 0;
  const transportFee = resData.transport_fee || 0;

  const stripeFee = Math.ceil(totalAmount * 0.036);

  // Phase 5 (§17.9 C7, "flat total, split among casts" policy confirmed
  // directly by the user): the guest-facing `transport_fee` stays a flat
  // total regardless of group size (fixed at the charge side in
  // `createPaymentIntent`) - group size only affects how the CAST-SIDE
  // half of that flat total is divided here. Real bug found and fixed as
  // part of this task: this pool used to be computed as
  // `Math.floor(transportFee / 2)` INSIDE the per-cast loop below, so on a
  // 2+ cast reservation EVERY cast received a full, undivided half of the
  // fee - `cast_ids.length` casts collectively receiving `cast_ids.length
  // ×` half the fee, while the guest was only ever charged it once. Now
  // computed ONCE here instead: split the existing 50/50 cast/ops pool
  // (キャストユーザー機能・管理.pdf §5.1's single-cast ¥5,000 → ¥2,500 cast /
  // ¥2,500 ops, generalized to N casts) evenly across however many casts
  // are actually on this reservation.
  const castIds: string[] = resData.cast_ids || [];
  const castTransportPool = transportFee > 0 ? Math.floor(transportFee / 2) : 0;
  const castTransportShareEach =
    castIds.length > 0 ? Math.floor(castTransportPool / castIds.length) : 0;

  for (const castId of castIds) {
    const castDoc = await db.collection("users").doc(castId).get();
    const castData = castDoc.data();
    if (!castData?.stripe_account_id) {
      console.error(`Cast ${castId} has no Stripe account`);
      continue;
    }

    const castRate = castData.individual_rate || config.default_cast_rate;

    try {
      await db.runTransaction(async (tx) => {
        const freshCastDoc = await tx.get(db.collection("users").doc(castId));
        const currentDebt = freshCastDoc.data()?.logical_debt || 0;

        const rewardBase = totalAmount - staffFee - transportFee;
        const castReward = Math.floor(rewardBase * castRate);

        const castTransportShare = castTransportShareEach;
        const totalCastAmount = castReward + castTransportShare;

        const debtDeduction = Math.min(currentDebt, totalCastAmount);
        const netTransfer = totalCastAmount - debtDeduction;
        const newDebt = currentDebt - debtDeduction;

        const platformProfit =
          totalAmount - castReward - castTransportShare - staffFee - stripeFee;

        const ledgerRef = db.collection("ledger").doc();
        // No real Transfer will ever be needed for this entry (fully
        // debt-offset) - nothing to defer, so mark it confirmed right
        // away instead of leaving it "pending" forever.
        const needsTransfer = netTransfer > 0;

        tx.set(ledgerRef, {
          ledger_id: ledgerRef.id,
          res_id: resId,
          user_id: castId,
          type: "reward",
          gross_amount: totalAmount,
          cast_reward: castReward,
          staff_fee: staffFee,
          stripe_fee: stripeFee,
          platform_profit: platformProfit,
          tax_amount: Math.floor(platformProfit * taxRate),
          net_transfer: netTransfer,
          amount: totalCastAmount,
          stripe_event_id: "",
          stripe_object_id: "",
          status: needsTransfer ? "pending" : "confirmed",
          processed: !needsTransfer,
          created_at: Timestamp.now(),
        });

        tx.update(db.collection("users").doc(castId), {
          logical_debt: newDebt,
          updated_at: Timestamp.now(),
        });

        if (debtDeduction > 0) {
          const debtRef = db.collection("debt_history").doc();
          tx.set(debtRef, {
            user_id: castId,
            amount: -debtDeduction,
            reason: "報酬からの自動相殺",
            res_id: resId,
            created_at: Timestamp.now(),
          });
        }
      });
    } catch (err) {
      console.error(`Cast reward ledger recording failed for ${castId}:`, err);
      continue;
    }
  }

  if (staffFee > 0 && resData.staff_ids) {
    for (const staffId of resData.staff_ids) {
      const staffDoc = await db.collection("users").doc(staffId).get();
      const staffData = staffDoc.data();
      if (!staffData?.stripe_account_id) continue;

      const perStaffFee = Math.floor(staffFee / resData.staff_ids.length);

      try {
        const transfer = await stripe.transfers.create({
          amount: perStaffFee,
          currency: "jpy",
          destination: staffData.stripe_account_id,
          transfer_group: resData.transfer_group,
          metadata: {
            res_id: resId,
            staff_uid: staffId,
            type: "staff_fee",
          },
        });

        await db.collection("ledger").add({
          ledger_id: "",
          res_id: resId,
          user_id: staffId,
          type: "staff_fee",
          gross_amount: staffFee,
          cast_reward: 0,
          staff_fee: perStaffFee,
          stripe_fee: 0,
          platform_profit: 0,
          tax_amount: 0,
          net_transfer: perStaffFee,
          amount: perStaffFee,
          stripe_event_id: "",
          stripe_object_id: transfer.id,
          status: "confirmed",
          processed: true,
          created_at: Timestamp.now(),
        });
      } catch (err) {
        console.error(`Staff transfer failed for ${staffId}:`, err);
      }
    }
  }

  await processAffiliateRewards(resId, resData);
}

/**
 * Phase 2 of cast reward processing (§17.9 C4 / §18.111): executes the
 * real `stripe.transfers.create` for any ledger entries
 * `recordCastRewardsAndProcessOthers` above left `status: "pending"` for
 * this reservation - called at guest-review time (`submitReview`) or the 24h
 * auto-timeout fallback (`autoCompleteReviews`), never at Capture time
 * anymore. Exported so `reservations.ts` can call it from both places.
 *
 * Idempotent by construction: only ever queries entries still `status ==
 * "pending"`; an entry this function has already processed (`confirmed`
 * or `retrying`) is naturally excluded from that query on any later
 * call, so calling this twice for the same reservation (e.g. a
 * hypothetical race between an explicit review and the timeout sweep) is
 * safe - the second call simply finds nothing left to do.
 *
 * Deliberately does NOT throw on a transfer failure - preserves the
 * original code's own resilience pattern (log, mark `retrying`, move on)
 * so a Stripe error for one cast's transfer can never prevent the
 * calling function (recording the guest's review, closing the chat,
 * completing the reservation) from finishing successfully for everyone
 * else.
 */
export async function transferPendingCastRewards(resId: string): Promise<void> {
  const pendingSnap = await db
    .collection("ledger")
    .where("res_id", "==", resId)
    .where("type", "==", "reward")
    .where("status", "==", "pending")
    .get();

  if (pendingSnap.empty) return;

  const resDoc = await db.collection("reservations").doc(resId).get();
  const transferGroup = resDoc.data()?.transfer_group;

  for (const entryDoc of pendingSnap.docs) {
    const entry = entryDoc.data();
    const castId = entry.user_id;
    const netTransfer = entry.net_transfer || 0;

    if (netTransfer <= 0) {
      // Shouldn't happen - Phase 1 marks a zero/negative-transfer entry
      // "confirmed" directly and never leaves it "pending" - but guard
      // defensively against attempting a zero/negative Stripe transfer
      // rather than assume this invariant always holds.
      await entryDoc.ref.update({ status: "confirmed", processed: true });
      continue;
    }

    const castDoc = await db.collection("users").doc(castId).get();
    const castData = castDoc.data();
    if (!castData?.stripe_account_id) {
      console.error(`Cast ${castId} has no Stripe account (deferred transfer, res ${resId})`);
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: netTransfer,
        currency: "jpy",
        destination: castData.stripe_account_id,
        transfer_group: transferGroup,
        metadata: {
          res_id: resId,
          cast_uid: castId,
          ledger_id: entryDoc.id,
        },
      });

      await entryDoc.ref.update({
        stripe_object_id: transfer.id,
        status: "confirmed",
        processed: true,
      });

      await db
        .collection("users")
        .doc(castId)
        .collection("notifications")
        .add({
          type: "stripe",
          title: "報酬が確定しました",
          body: `¥${netTransfer.toLocaleString()} が送金されました。`,
          data: { res_id: resId, amount: netTransfer },
          read: false,
          created_at: Timestamp.now(),
        });
    } catch (err: any) {
      console.error(`Deferred cast reward transfer failed for ${castId} (res ${resId}):`, err);

      await entryDoc.ref.update({ status: "retrying" });
    }
  }
}

/**
 * Internal: Process affiliate rewards for this reservation
 */
async function processAffiliateRewards(
  resId: string,
  resData: FirebaseFirestore.DocumentData
): Promise<void> {
  const config = await getSystemConfig();
  const transportFee = resData.transport_fee || 0;

  for (const castId of resData.cast_ids || []) {
    const castDoc = await db.collection("users").doc(castId).get();
    const castData = castDoc.data();

    if (!castData?.referred_by_uid) continue;

    const referrerDoc = await db.collection("users").doc(castData.referred_by_uid).get();
    const referrerData = referrerDoc.data();

    if (!referrerData || !referrerData.is_active || referrerData.is_frozen) continue;

    // Mutual-approval hard rule (IMPLEMENTATION_PLAN.md §3.7.12): reward only
    // accrues for periods where BOTH the referrer and the referred cast are
    // simultaneously approval_status == "approved". A frozen/not-yet-approved
    // referrer, or a not-yet-approved referred cast, must not accrue reward
    // for this reservation.
    if (referrerData.approval_status !== "approved") continue;
    if (castData.approval_status !== "approved") continue;

    const baseForAffiliate = resData.total_amount - transportFee;
    const affiliateRate = referrerData.affiliate_rate || config.default_affiliate_rate;
    const rewardAmount = Math.floor(baseForAffiliate * affiliateRate);

    if (rewardAmount <= 0) continue;

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await db.collection("affiliate_rewards").add({
      affiliator_uid: castData.referred_by_uid,
      referred_uid: castId,
      res_id: resId,
      base_amount: baseForAffiliate,
      rate: affiliateRate,
      reward_amount: rewardAmount,
      month,
      status: "pending",
      paid_at: null,
      created_at: Timestamp.now(),
    });
  }
}

/**
 * Internal: record & pay out the cast's share of a guest-caused
 * cancellation charge (the "arrival"-tier 25% split — the "≥1h before"
 * tier passes castRewardPercent=0 and this is a no-op). Reuses the same
 * debt-offset-transaction shape as `recordCastRewardsAndProcessOthers`
 * (Firestore transaction first, deferred Stripe Transfer second via
 * `transferPendingCastRewards`, called directly at the end since a
 * cancelled reservation has no later 交流完了/review event to defer to).
 */
async function recordCancellationCastRewards(
  resId: string,
  resData: FirebaseFirestore.DocumentData,
  chargedAmount: number,
  castRewardPercent: number
): Promise<void> {
  const castIds: string[] = resData.cast_ids || [];
  if (castIds.length === 0 || castRewardPercent <= 0) return;

  const castRewardPool = Math.round(chargedAmount * castRewardPercent);
  const stripeFee = Math.ceil(chargedAmount * 0.036);
  const rewardShareEach = Math.floor(castRewardPool / castIds.length);
  if (rewardShareEach <= 0) return;

  for (const castId of castIds) {
    const castDoc = await db.collection("users").doc(castId).get();
    if (!castDoc.data()?.stripe_account_id) continue;

    try {
      await db.runTransaction(async (tx) => {
        const castRef = db.collection("users").doc(castId);
        const freshCastDoc = await tx.get(castRef);
        const currentDebt = freshCastDoc.data()?.logical_debt || 0;

        const debtDeduction = Math.min(currentDebt, rewardShareEach);
        const netTransfer = rewardShareEach - debtDeduction;
        const newDebt = currentDebt - debtDeduction;
        const platformProfit = chargedAmount - castRewardPool - stripeFee;
        const needsTransfer = netTransfer > 0;

        const ledgerRef = db.collection("ledger").doc();
        tx.set(ledgerRef, {
          ledger_id: ledgerRef.id,
          res_id: resId,
          user_id: castId,
          type: "reward",
          gross_amount: chargedAmount,
          cast_reward: rewardShareEach,
          staff_fee: 0,
          stripe_fee: stripeFee,
          platform_profit: platformProfit,
          tax_amount: 0,
          net_transfer: netTransfer,
          amount: rewardShareEach,
          stripe_event_id: "",
          stripe_object_id: "",
          status: needsTransfer ? "pending" : "confirmed",
          processed: !needsTransfer,
          created_at: Timestamp.now(),
        });

        tx.update(castRef, { logical_debt: newDebt, updated_at: Timestamp.now() });

        if (debtDeduction > 0) {
          const debtRef = db.collection("debt_history").doc();
          tx.set(debtRef, {
            user_id: castId,
            amount: -debtDeduction,
            reason: "報酬からの自動相殺",
            res_id: resId,
            created_at: Timestamp.now(),
          });
        }
      });
    } catch (err) {
      console.error(`Cancellation cast reward ledger recording failed for ${castId}:`, err);
    }
  }

  await transferPendingCastRewards(resId);
}

/**
 * Callable: Cancel payment (キャンセル - 与信解放)
 *
 * FIX (IMPLEMENTATION_PLAN.md §6 defect #10): this used to accept a
 * `partial_amount` directly from the CLIENT and capture exactly that with
 * no server-side validation at all — a real money-correctness bug, not
 * just a missing feature (a buggy or malicious client could specify any
 * amount for a real Stripe capture). The confirmed cancellation-fee
 * policy (キャストユーザー機能・管理.pdf §9, independently re-confirmed
 * against the sister project's own client correspondence) is now computed
 * entirely server-side from `cancelledBy` and how much notice was given:
 *   - Guest-caused, cast already arrived (status already `in_progress` or
 *     later) OR under 1 hour's notice: guest charged 100%, cast receives
 *     25% of that, platform keeps the rest.
 *   - Guest-caused, ≥1 hour's notice: guest charged 50%, cast receives 0%,
 *     platform keeps the full 50%.
 *   - Cast-caused: unchanged from before — 100% release/refund to guest,
 *     Stripe's processing fee debited from the cast via `logical_debt`
 *     (which already correctly models "platform advances the shortfall,
 *     recouped from the cast's future earnings" — no separate advance/loan
 *     mechanism needed, the existing debt field already reduces to that).
 *   - Admin-triggered (via this shared callable, not `admin.ts`'s own
 *     `adminForceCancel` override): treated as a neutral full release, no
 *     fee either side — a deliberate scope call, not an oversight; a
 *     business-reasoned partial capture from an admin goes through
 *     `adminForceCancel`, which already accepts an explicit amount from a
 *     trusted, role-gated caller rather than an arbitrary guest/cast client.
 */
export const cancelPayment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, cancel_reason } = request.data;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const isAdmin = userDoc.data()?.role === "admin";
  const isGuestCancel = request.auth.uid === resData.guest_id;
  const isCastCancel = resData.cast_ids?.includes(request.auth.uid);

  if (!isAdmin && !isGuestCancel && !isCastCancel) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  const cancelledBy = isAdmin ? "admin" : isGuestCancel ? "guest" : "cast";

  try {
    if (cancelledBy === "guest") {
      const arrivedStatuses = ["in_progress", "completion_pending", "review_pending", "completed"];
      const scheduledStart: Date = resData.date?.toDate ? resData.date.toDate() : new Date(resData.date);
      const hoursUntilStart = (scheduledStart.getTime() - Date.now()) / (1000 * 60 * 60);
      const castHasArrived = arrivedStatuses.includes(resData.status);

      const guestChargePercent = castHasArrived || hoursUntilStart < 1 ? 1.0 : 0.5;
      const castRewardPercent = castHasArrived || hoursUntilStart < 1 ? 0.25 : 0;
      const chargedAmount = Math.round(resData.total_amount * guestChargePercent);

      if (chargedAmount > 0) {
        await stripe.paymentIntents.capture(resData.payment_intent_id, {
          amount_to_capture: chargedAmount,
        });
        await recordCancellationCastRewards(res_id, resData, chargedAmount, castRewardPercent);
      } else {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }
    } else {
      // cast- or admin-caused: full release/refund, no guest charge.
      await stripe.paymentIntents.cancel(resData.payment_intent_id);
    }

    if (cancelledBy === "cast") {
      const stripeFeeEstimate = Math.ceil(resData.total_amount * 0.036);

      for (const castId of resData.cast_ids || []) {
        await db.runTransaction(async (tx) => {
          const castRef = db.collection("users").doc(castId);
          const castDoc = await tx.get(castRef);
          const currentDebt = castDoc.data()?.logical_debt || 0;

          tx.update(castRef, {
            logical_debt: currentDebt + stripeFeeEstimate,
            updated_at: Timestamp.now(),
          });
        });

        await db.collection("debt_history").add({
          user_id: castId,
          amount: stripeFeeEstimate,
          reason: "キャスト都合キャンセルによる決済手数料負担",
          res_id,
          created_at: Timestamp.now(),
        });
      }
    }

    await db.collection("reservations").doc(res_id).update({
      status: "cancelled",
      cancel_reason: cancel_reason || "",
      cancelled_by: cancelledBy,
      updated_at: Timestamp.now(),
    });

    const slots = await db
      .collection("schedule_slots")
      .where("status", "==", "reserved")
      .get();
    const batch = db.batch();
    slots.forEach((slot) => {
      if (resData.cast_ids?.includes(slot.data().cast_id)) {
        batch.update(slot.ref, { status: "available" });
      }
    });
    await batch.commit();

    const chatRooms = await db
      .collection("chat_rooms")
      .where("res_id", "==", res_id)
      .get();
    for (const room of chatRooms.docs) {
      await room.ref.update({ active: false, closed_at: Timestamp.now() });
    }

    return { success: true, message: "予約がキャンセルされました。" };
  } catch (err: any) {
    console.error("Payment cancellation failed:", err);
    throw new HttpsError("internal", `キャンセルに失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Create extension payment (延長決済)
 */
export const createExtensionPayment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, amount, duration_minutes } = request.data;

  if (!res_id || !amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "予約IDと金額が必要です。");
  }

  // `getSystemConfig()`'s SYSTEM_DEFAULTS key-casing bug (see config.ts) is
  // now fixed, so 延長上限回数設定/最大総時間設定 correctly reflect what's
  // actually configured on 基本設定 via the helper directly.
  const config = await getSystemConfig();
  const extensionLimit = config.extension_limit_count;
  const maxTotalHours = config.max_total_hours;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  // Ownership check - this callable had none at all: it fetched the
  // reservation (above, for the extension-limit checks) but never verified
  // the caller actually owns it before mutating extension_count/
  // duration_minutes and creating a real Stripe PaymentIntent. Guest-only,
  // same reasoning as createPaymentIntent above - the PaymentIntent is
  // created against the caller's own stripe_customer_id a few lines below.
  if (resData.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  if ((resData.extension_count || 0) >= extensionLimit) {
    throw new HttpsError(
      "failed-precondition",
      `延長は最大${extensionLimit}回までです。`
    );
  }

  const newTotalMinutes = (resData.duration_minutes || 0) + duration_minutes;
  if (newTotalMinutes > maxTotalHours * 60) {
    throw new HttpsError(
      "failed-precondition",
      `総時間は最大${maxTotalHours}時間までです。`
    );
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "jpy",
      customer: userData?.stripe_customer_id,
      capture_method: "manual",
      transfer_group: resData.transfer_group,
      metadata: {
        res_id,
        type: "extension",
        extension_number: ((resData.extension_count || 0) + 1).toString(),
        guest_uid: request.auth.uid,
      },
    });

    const extRef = db
      .collection("reservations")
      .doc(res_id)
      .collection("extensions")
      .doc();

    await extRef.set({
      ext_id: extRef.id,
      payment_intent_id: paymentIntent.id,
      amount,
      duration_minutes,
      status: "authorized",
      created_at: Timestamp.now(),
    });

    await db.collection("reservations").doc(res_id).update({
      extension_count: FieldValue.increment(1),
      duration_minutes: newTotalMinutes,
      updated_at: Timestamp.now(),
    });

    return {
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      extension_id: extRef.id,
    };
  } catch (err: any) {
    console.error("Extension payment creation failed:", err);
    throw new HttpsError("internal", `延長決済の作成に失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Process tip payment (チップ)
 */
export const processTip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, cast_id, amount } = request.data;

  if (!cast_id || !amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "キャストIDと金額が必要です。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const castDoc = await db.collection("users").doc(cast_id).get();

  if (!castDoc.exists || !castDoc.data()?.stripe_account_id) {
    throw new HttpsError("not-found", "キャストが見つかりません。");
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "jpy",
      customer: userDoc.data()?.stripe_customer_id,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: {
        res_id: res_id || "",
        type: "tip",
        guest_uid: request.auth.uid,
        cast_uid: cast_id,
      },
    });

    if (paymentIntent.status === "succeeded") {
      const transfer = await stripe.transfers.create({
        amount,
        currency: "jpy",
        destination: castDoc.data()!.stripe_account_id,
        metadata: {
          res_id: res_id || "",
          type: "tip",
          cast_uid: cast_id,
        },
      });

      await db.collection("ledger").add({
        ledger_id: "",
        res_id: res_id || "",
        user_id: cast_id,
        type: "tip",
        gross_amount: amount,
        cast_reward: amount,
        staff_fee: 0,
        stripe_fee: 0,
        platform_profit: 0,
        tax_amount: 0,
        net_transfer: amount,
        amount,
        stripe_event_id: "",
        stripe_object_id: transfer.id,
        status: "confirmed",
        processed: true,
        created_at: Timestamp.now(),
      });
    }

    return { success: true, message: "チップが送られました。" };
  } catch (err: any) {
    console.error("Tip payment failed:", err);
    throw new HttpsError("internal", `チップの送信に失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Add payment method (支払い方法の登録)
 */
export const createSetupIntent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const customerId = userDoc.data()?.stripe_customer_id;

  if (!customerId) {
    throw new HttpsError("failed-precondition", "Stripeカスタマーが未作成です。");
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });

  return {
    success: true,
    client_secret: setupIntent.client_secret,
  };
});

/**
 * Callable: Request payout (出金申請)
 */
export const requestPayout = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();

  if (!userData) {
    throw new HttpsError("not-found", "ユーザーが見つかりません。");
  }

  if (userData.logical_debt > 0) {
    throw new HttpsError(
      "failed-precondition",
      "論理負債が0円の場合のみ出金申請が可能です。"
    );
  }

  if (!userData.stripe_account_id) {
    throw new HttpsError("failed-precondition", "Stripeアカウントが未設定です。");
  }

  const balance = await stripe.balance.retrieve({
    stripeAccount: userData.stripe_account_id,
  });

  const available = balance.available.find((b) => b.currency === "jpy");
  if (!available || available.amount <= 0) {
    throw new HttpsError(
      "failed-precondition",
      "出金可能な残高がありません。"
    );
  }

  // FIX (IMPLEMENTATION_PLAN.md §6 defect #9): this used to only notify
  // admins and never actually create a `payout_requests` document — but
  // `adminApprovePayout`/`adminGetPayoutRequests` (admin.ts) both read from
  // that exact collection (`user_id`, `status`, `created_at`, `updated_at`)
  // expecting the request side to have written it. Without this, the admin
  // approval queue would always be empty regardless of how many withdrawal
  // requests guests/casts actually submitted.
  const existingPending = await db
    .collection("payout_requests")
    .where("user_id", "==", request.auth.uid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!existingPending.empty) {
    throw new HttpsError(
      "failed-precondition",
      "既に出金申請が処理待ちです。承認をお待ちください。"
    );
  }

  const payoutRequestRef = db.collection("payout_requests").doc();
  await payoutRequestRef.set({
    user_id: request.auth.uid,
    status: "pending",
    created_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });

  const admins = await db.collection("users").where("role", "==", "admin").get();
  const batch = db.batch();
  admins.forEach((adminDoc) => {
    const notifRef = db
      .collection("users")
      .doc(adminDoc.id)
      .collection("notifications")
      .doc();
    batch.set(notifRef, {
      type: "admin",
      title: "出金申請",
      body: `ユーザー ${userData.nickname} (${request.auth!.uid}) が出金を申請しました。残高: ¥${available.amount}`,
      data: { user_id: request.auth!.uid, amount: available.amount, request_id: payoutRequestRef.id },
      read: false,
      created_at: Timestamp.now(),
    });
  });
  await batch.commit();

  return { success: true, message: "出金申請を受け付けました。運営の承認をお待ちください。" };
});

/**
 * Callable: Get my Stripe Connect wallet balance (ウォレット残高取得)
 * §3.7.9 - "no separate ledger UI drift allowed - must reflect Stripe truth,
 * not a locally cached copy." Live `stripe.balance.retrieve` every call,
 * same scoping (`stripeAccount: userData.stripe_account_id`) already proven
 * correct in `requestPayout` above - never cached/stored in Firestore.
 * Transaction HISTORY is deliberately NOT duplicated here - the `ledger`
 * collection is this project's own authoritative record of what happened
 * (not a cache of Stripe's own data, a separately-written record with
 * readable `type`/`res_id` context Stripe's raw balance-transaction objects
 * don't have), and its Firestore rule (`user_id == request.auth.uid`) is
 * already content-based and provably satisfiable client-side - querying it
 * directly from `WalletPage` avoids a redundant server round-trip for data
 * a direct client read can already serve safely.
 */
export const getWalletBalance = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();

  if (!userData) {
    throw new HttpsError("not-found", "ユーザーが見つかりません。");
  }

  if (!userData.stripe_account_id) {
    return { success: true, available: 0, pending: 0, has_stripe_account: false };
  }

  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: userData.stripe_account_id,
    });

    const available = balance.available.find((b) => b.currency === "jpy")?.amount || 0;
    const pending = balance.pending.find((b) => b.currency === "jpy")?.amount || 0;

    return { success: true, available, pending, has_stripe_account: true };
  } catch (err: any) {
    console.error(`getWalletBalance failed for ${request.auth.uid}:`, err);
    throw new HttpsError("internal", `残高の取得に失敗しました: ${err.message}`);
  }
});
