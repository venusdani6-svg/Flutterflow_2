/**
 * Stripe Connect Payment Cloud Functions
 * Stripe決済管理 (Authorize → Capture → Transfer)
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, stripe, FieldValue, Timestamp, getSystemConfig, STRIPE_API_VERSION } from "./config";
import { reservedSlotsQuery, extensionSlotsQuery, findUnavailableCastId } from "./schedule";

/**
 * Callable: Create PaymentIntent with manual capture (与信確保)
 * 予約時に与信を確保する
 */
export const createPaymentIntent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;

  if (!res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
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
  const resDataForGuard = resDoc.data()!;
  if (resDataForGuard.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  // FIX (confirmed live bug, found on the same review pass that caught the
  // identical issue in createExtensionPayment's own `amount` param):
  // `amount`/`staff_fee`/`cast_ids` used to come straight from
  // `request.data`, trusted with zero validation - `amount` only checked
  // ">0". Cloud Functions are callable directly by any authenticated
  // client with the right function name/region, regardless of what this
  // app's own UI/custom-action layer normally sends - a guest could call
  // this directly with `amount: 1` and pay almost nothing for a real
  // reservation. Unlike the extension case, there's no formula to
  // recompute a correct base amount from (guest self-reports it at
  // `createReservation` time, a disclosed, already-accepted simplification
  // - see PROJECT_KNOWLEDGE.md §12) - but that value is already durably
  // stored, server-side-written, on the reservation document the instant
  // it's created, and `resDataForGuard` is already fetched here for the
  // ownership check above. Reading `amount`/`staff_fee`/`cast_ids` from
  // THAT instead of trusting the client closes the gap with zero new
  // reads and no schema change - the client-supplied values are no longer
  // used for anything.
  const amount = resDataForGuard.base_amount;
  const staff_fee = resDataForGuard.staff_fee;
  const cast_ids = resDataForGuard.cast_ids;

  if (!amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "この予約には有効な金額が設定されていません。");
  }

  // FIX (confirmed live bug, found during audit): no status/idempotency
  // guard existed - calling this twice for the same reservation created
  // two separate Stripe PaymentIntents (the first silently orphaned,
  // never captured or canceled), and calling it again after the
  // reservation had already progressed past `request_pending` would
  // re-authorize and re-timestamp `status: "authorized"` on a reservation
  // that may already be `in_progress`/`completion_pending`/etc. This
  // callable is meant to run exactly once, right after the guest submits
  // the reservation request.
  if (resDataForGuard.status !== "request_pending") {
    throw new HttpsError(
      "failed-precondition",
      "この予約はすでに決済処理が開始されています。"
    );
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
  // guest charge itself. `transport_fee` used to come from the client as a
  // boolean-shaped SIGNAL ("does this booking carry a taxi surcharge at
  // all?", >0 = yes) - the actual AMOUNT was already server-computed and
  // never taken from the client, but the SIGNAL itself still was, which
  // is the same trust gap as `amount`/`staff_fee` above: a client could
  // send `transport_fee: 1` to force a surcharge that shouldn't apply, or
  // (more relevantly for undercharging) simply never gets exercised as an
  // attack because a client wouldn't want to ADD a fee to their own
  // charge - but it's still an unnecessary trust surface for something
  // that's already server-computed and stored. FIX (found on the same
  // review pass as the amount/staff_fee fix above): `createReservation`
  // (reservations.ts) already computes this exact eligibility correctly at
  // creation time from the reservation's own `time_slot`/
  // `night_time_slots` and stores it as `reservations.transport_fee` - use
  // THAT as the signal instead of trusting the client at all.
  // `getSystemConfig()`'s SYSTEM_DEFAULTS key-casing bug (see config.ts) is
  // now fixed, so this reads through the helper directly rather than the
  // raw-document workaround this block used to need.
  const config = await getSystemConfig();
  const transportFeeAmount = config.transport_fee_amount;

  let finalTransportFee = (resDataForGuard.transport_fee || 0) > 0 ? transportFeeAmount : 0;

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

    // FIX (confirmed live bug, found during audit): `status: "authorized"`
    // used to be written HERE, the instant `stripe.paymentIntents.create()`
    // returns - before the guest has even opened the Payment Sheet
    // (`confirmStripePayment`, called separately from the client right
    // after this) to enter card details, let alone before Stripe's own
    // `amount_capturable_updated` webhook (`handleAmountCapturableUpdated`,
    // stripe-webhooks.ts) confirms a real hold actually exists. Per
    // schema.md, "authorized" is documented to mean 与信確保済み
    // (requires_capture) - not yet true at PaymentIntent-creation time. If
    // the guest abandoned the Payment Sheet or their card failed, the
    // reservation was left sitting at `status: "authorized"` with no real
    // money on hold - and `respondToReservation`'s own status guard
    // (`["authorized","cast_pending"].includes(...)`) would let the cast
    // accept a "confirmed" booking with zero payment security behind it.
    // This mirrors the EXACT design principle already established and
    // deliberately chosen for the Capture step (§6 defect #7: webhook-
    // confirmed, not optimistic-on-button-tap) - `status` now stays
    // whatever it already was (`request_pending`) until
    // `handleAmountCapturableUpdated` genuinely confirms the hold.
    await db.collection("reservations").doc(res_id).update({
      payment_intent_id: paymentIntent.id,
      transfer_group: transferGroup,
      transport_fee: finalTransportFee,
      total_amount: totalAmount,
      thirty_min_rule_applied: finalTransportFee === 0 && (resDataForGuard.transport_fee || 0) > 0,
      updated_at: Timestamp.now(),
    });

    return {
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      total_amount: totalAmount,
      transport_fee: finalTransportFee,
      thirty_min_rule_applied: finalTransportFee === 0 && (resDataForGuard.transport_fee || 0) > 0,
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
  if (!payment_intent_id || !payment_method_id) {
    throw new HttpsError("invalid-argument", "PaymentIntent IDと支払い方法IDが必要です。");
  }

  // FIX (confirmed live bug, found on the same review-pass sweep for the
  // client-trust vulnerability class this session already fixed in
  // createPaymentIntent/createExtensionPayment): no ownership check
  // existed at all - any authenticated user could call this with an
  // arbitrary payment_intent_id and attempt to confirm it. This callable
  // is confirmed UNUSED by this app's real flow (grepped dsl/edit.dart and
  // generated_code/ - zero references anywhere; `confirm_stripe_payment.dart`
  // uses `Stripe.instance.presentPaymentSheet()`, which confirms internally
  // via the client SDK using the client_secret, never calling this
  // function) - but it's still deployed and directly callable regardless
  // of whether this app's own UI reaches it, so it gets the same ownership
  // check as every other payment callable in this file. `createPaymentIntent`
  // already stamps `guest_uid` into every PaymentIntent's metadata -
  // verify it matches the caller before confirming.
  const paymentIntentCheck = await stripe.paymentIntents.retrieve(payment_intent_id);
  if (paymentIntentCheck.metadata?.guest_uid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

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

  // FIX (confirmed live bug, found during audit): no status guard existed -
  // a guest or cast could call this directly right after `respondToReservation`
  // confirms (status `confirmed`, before any meetup), triggering a real
  // Stripe capture of the guest's card before service is rendered, contrary
  // to the documented "Capture only after the cast's completion report"
  // flow (§3.5 state 6). `reportCompletion` is the normal/intended trigger
  // for this - this callable is a manual/admin-recourse path, not a
  // guest/cast-initiated shortcut around the state machine.
  if (resData.status !== "completion_pending") {
    throw new HttpsError(
      "failed-precondition",
      "この予約は現在、売上確定できる状態ではありません。"
    );
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

  // FIX (confirmed live bug, found during audit): `platform_profit`/
  // `tax_amount` used to be computed INSIDE the per-cast loop as
  // `totalAmount - thisCast'sOwnReward - staffFee - stripeFee` - correct
  // for a single-cast reservation, but on a multi-cast reservation each
  // cast's row pretended to be the ONLY cast (never subtracting any OTHER
  // cast's reward), so every row overstated platform_profit by the sum of
  // every other cast's reward. `adminGetLedger`'s summary dedupes by
  // `res_id` assuming every cast's row reports the identical, correct
  // reservation-wide profit figure - true only when every cast shares the
  // same `individual_rate`, silently wrong otherwise. Fixed with a
  // two-pass approach: compute every cast's reward first, sum them, THEN
  // compute one shared, correct platform_profit/tax_amount that properly
  // accounts for every cast's cut, applied identically to every row (so
  // the existing res_id-dedup read side stays correct by construction).
  // NOTE: this fixes the REPORTED bookkeeping only. The underlying reward
  // FORMULA itself (`rewardBase * castRate`, applied independently and in
  // full to EACH cast rather than split across them, unlike the transport
  // fee pool a few lines above which correctly IS split) is unchanged -
  // for a multi-cast reservation where combined cast rates approach or
  // exceed 100%, the platform's true remaining margin can be thin, zero,
  // or negative. Whether multi-cast rewards should divide the shared pool
  // (matching the transport-fee pattern) instead of each cast independently
  // claiming their own percentage of the whole is a real product/business
  // question, not something to silently guess at here - disclosed as a
  // follow-up requiring confirmation, not fixed in this pass.
  const rewardBase = totalAmount - staffFee - transportFee;
  const castRewards = new Map<string, number>();
  for (const castId of castIds) {
    const castDoc = await db.collection("users").doc(castId).get();
    const castData = castDoc.data();
    if (!castData?.stripe_account_id) {
      console.error(`Cast ${castId} has no Stripe account`);
      continue;
    }
    const castRate = castData.individual_rate || config.default_cast_rate;
    castRewards.set(castId, Math.floor(rewardBase * castRate));
  }
  const totalCastRewardPaid = Array.from(castRewards.values()).reduce((a, b) => a + b, 0);
  // FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide review):
  // `castTransportShareEach` is computed by dividing the pool across EVERY
  // cast_id on the reservation, but only ever actually PAID to the casts
  // that made it into `castRewards` (a cast with no stripe_account_id is
  // `continue`d out of that map, above) — so when a cast is skipped,
  // `platform_profit` still subtracted that skipped cast's full transport
  // share even though nobody was ever actually paid it, understating the
  // platform's real (kept) profit by exactly that amount. Subtract what
  // was ACTUALLY distributed (share × number of casts really paid),
  // not the theoretical full pool.
  const actualTransportDistributed = castTransportShareEach * castRewards.size;
  const sharedPlatformProfit =
    totalAmount - totalCastRewardPaid - actualTransportDistributed - staffFee - stripeFee;
  const sharedTaxAmount = Math.floor(sharedPlatformProfit * taxRate);

  for (const [castId, castReward] of castRewards) {
    try {
      await db.runTransaction(async (tx) => {
        const freshCastDoc = await tx.get(db.collection("users").doc(castId));
        const currentDebt = freshCastDoc.data()?.logical_debt || 0;

        const castTransportShare = castTransportShareEach;
        const totalCastAmount = castReward + castTransportShare;

        const debtDeduction = Math.min(currentDebt, totalCastAmount);
        const netTransfer = totalCastAmount - debtDeduction;
        const newDebt = currentDebt - debtDeduction;

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
          platform_profit: sharedPlatformProfit,
          tax_amount: sharedTaxAmount,
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
    // FIX (confirmed live bug, found during audit): `security_staff_fee`/
    // `transport_staff_fee` are independently admin-configurable (§5 item
    // 5) and not guaranteed equal — this used to pay EVERY staff_id an
    // even split of the aggregate `staffFee` regardless of which role each
    // one actually filled, so a security staffer and a transport staffer
    // on the same reservation were paid identically even when their
    // configured role-fees differ (dormant only because both default to
    // ¥2,500). `staff_fee_map` (createReservation/selectWorkApplicant/
    // adminHireWorkPostApplicant, all three real write sites for
    // `staff_ids`) now records each staff member's OWN flat role-fee at
    // the moment they're attached to the reservation — use it when
    // present, falling back to the even split only for reservations
    // created before this field existed.
    const staffFeeMap: Record<string, number> = resData.staff_fee_map || {};
    for (const staffId of resData.staff_ids) {
      const staffDoc = await db.collection("users").doc(staffId).get();
      const staffData = staffDoc.data();
      if (!staffData?.stripe_account_id) continue;

      const perStaffFee =
        typeof staffFeeMap[staffId] === "number"
          ? staffFeeMap[staffId]
          : Math.floor(staffFee / resData.staff_ids.length);

      // FIX (comprehensive project-wide review round 2): the ledger entry
      // used to be written only AFTER a successful transfer, so a failed
      // transfer left no record at all and nothing ever retried it — the
      // same silent, untracked money loss shape as the tip-transfer bug
      // fixed above. Pre-allocate the ledger doc, write it "pending" before
      // calling Stripe, and fold this into the same retry queue via
      // `status: "retrying"` (retryFailedCastTransfers now also sweeps
      // type "staff_fee").
      const ledgerRef = db.collection("ledger").doc();
      await ledgerRef.set({
        ledger_id: ledgerRef.id,
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
        stripe_object_id: "",
        status: "pending",
        processed: false,
        created_at: Timestamp.now(),
      });

      try {
        const transfer = await stripe.transfers.create(
          {
            amount: perStaffFee,
            currency: "jpy",
            destination: staffData.stripe_account_id,
            transfer_group: resData.transfer_group,
            metadata: {
              res_id: resId,
              staff_uid: staffId,
              type: "staff_fee",
              ledger_id: ledgerRef.id,
            },
          },
          { idempotencyKey: `transfer_${ledgerRef.id}` }
        );

        await ledgerRef.update({
          stripe_object_id: transfer.id,
          status: "confirmed",
          processed: true,
        });
      } catch (err) {
        console.error(`Staff transfer failed for ${staffId}:`, err);
        await ledgerRef.update({ status: "retrying" });
      }
    }
  }

  await processAffiliateRewards(resId, resData);
}

/**
 * FIX (confirmed live bug, found during audit): `createExtensionPayment`
 * (this file, above) creates a `capture_method: "manual"` PaymentIntent per
 * extension and stores it under `reservations/{res_id}/extensions/{ext_id}`
 * with `status: "authorized"` - but no code path anywhere in this codebase
 * ever called `stripe.paymentIntents.capture()` on it. Every extension's
 * authorization hold simply expired unused (Stripe's ~7-day default),
 * meaning a guest who paid for extra time was never actually charged and
 * the cast/platform never received that revenue. §3.5.6 requires each
 * extension to run its own independent Authorize→Capture→Transfer - this
 * closes the missing Capture (and reward-ledger) step, called from the same
 * two places the main reservation payment is captured/finalized
 * (`reportCompletion` and `autoCompleteReviews`'s retry sweep), so an
 * extension's money resolves at the same natural moment as the base
 * reservation's.
 *
 * Reward split: reuses the SAME `individual_rate`-per-cast formula as
 * `recordCastRewardsAndProcessOthers` above (no staff fee/transport fee
 * component - extensions are pure additional cast time), written as
 * `type: "reward"` ledger entries against the SAME `res_id` so the
 * existing `transferPendingCastRewards(resId)` call (already invoked right
 * after this from both call sites) transfers them together with the base
 * reservation's own pending rewards - no separate transfer path needed.
 */
export async function captureAuthorizedExtensions(
  resId: string,
  resData: FirebaseFirestore.DocumentData
): Promise<void> {
  const extensionsSnap = await db
    .collection("reservations")
    .doc(resId)
    .collection("extensions")
    .where("status", "==", "authorized")
    .get();

  if (extensionsSnap.empty) return;

  const config = await getSystemConfig();
  const castIds: string[] = resData.cast_ids || [];

  for (const extDoc of extensionsSnap.docs) {
    const ext = extDoc.data();
    if (!ext.payment_intent_id) {
      console.error(`Extension ${extDoc.id} on ${resId} has no payment_intent_id.`);
      continue;
    }

    try {
      await stripe.paymentIntents.capture(ext.payment_intent_id);
    } catch (err) {
      console.error(`Extension capture failed for ${extDoc.id} on ${resId}:`, err);
      continue;
    }

    await extDoc.ref.update({ status: "captured", updated_at: Timestamp.now() });

    const extAmount: number = ext.amount || 0;
    for (const castId of castIds) {
      const castDoc = await db.collection("users").doc(castId).get();
      const castData = castDoc.data();
      if (!castData?.stripe_account_id) continue;

      const castRate = castData.individual_rate || config.default_cast_rate;
      const castReward = Math.floor(extAmount * castRate);
      if (castReward <= 0) continue;

      try {
        await db.runTransaction(async (tx) => {
          const freshCastDoc = await tx.get(db.collection("users").doc(castId));
          const currentDebt = freshCastDoc.data()?.logical_debt || 0;
          const debtDeduction = Math.min(currentDebt, castReward);
          const netTransfer = castReward - debtDeduction;
          const newDebt = currentDebt - debtDeduction;

          const ledgerRef = db.collection("ledger").doc();
          const needsTransfer = netTransfer > 0;

          tx.set(ledgerRef, {
            ledger_id: ledgerRef.id,
            res_id: resId,
            user_id: castId,
            type: "reward",
            gross_amount: extAmount,
            cast_reward: castReward,
            staff_fee: 0,
            stripe_fee: 0,
            platform_profit: extAmount - castReward,
            tax_amount: Math.floor((extAmount - castReward) * config.tax_rate),
            net_transfer: netTransfer,
            amount: castReward,
            stripe_event_id: "",
            stripe_object_id: ext.payment_intent_id,
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
              reason: "延長報酬からの自動相殺",
              res_id: resId,
              created_at: Timestamp.now(),
            });
          }
        });
      } catch (err) {
        console.error(`Extension reward ledger recording failed for ${castId}:`, err);
      }
    }
  }
}

/**
 * Phase 2 of cast reward processing (§17.9 C4 / §18.111): executes the
 * real `stripe.transfers.create` for any ledger entries
 * `recordCastRewardsAndProcessOthers` above left `status: "pending"` for
 * this reservation - called at guest-review time (`submitReview`) or the 24h
 * auto-timeout fallback (`autoCompleteReviews`), never at Capture time
 * anymore. Exported so `reservations.ts` can call it from both places.
 *
 * FIX (PROJECT_KNOWLEDGE.md §70, CRITICAL — comprehensive project-wide
 * review): this function's own doc comment used to claim it was "idempotent
 * by construction" because it only ever queries entries still `status ==
 * "pending"` — but that reasoning only holds if a second call starts AFTER
 * the first call's writes commit. Two calls whose *reads* race (both query
 * `status=="pending"` before either has written anything back) both see the
 * SAME pending entries and both proceed to call `stripe.transfers.create`
 * for the same cast/amount — a real double-payment, not a theoretical one.
 * Three call sites can genuinely race for the SAME `resId`: `submitReview`
 * (a multi-cast reservation reviewed twice in quick succession),
 * `autoCompleteReviews`'s hourly sweep landing mid-review, and
 * `recordCancellationCastRewards`. No `idempotencyKey` is passed to
 * `stripe.transfers.create` anywhere in this codebase, so Stripe itself
 * cannot deduplicate this either.
 *
 * Fixed by adding a transactional CLAIM step per entry — `pending` ->
 * `transferring` — before ever calling Stripe. Only the caller that wins
 * that transaction's optimistic-concurrency race proceeds; every other
 * concurrent caller sees the entry already claimed and skips it. This is
 * the same class of fix already applied to `respondToReservation`
 * (read-check-write in one transaction) for the identical race shape.
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

    // Transactional claim — the ONLY caller that wins this race gets past
    // this point for this specific entry. Reads the entry fresh (not the
    // outer query's snapshot, which can be stale by the time this runs).
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(entryDoc.ref);
      if (!snap.exists || snap.data()?.status !== "pending") {
        return false;
      }
      tx.update(entryDoc.ref, { status: "transferring" });
      return true;
    });
    if (!claimed) {
      continue;
    }

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
      // Already claimed as "transferring" above — revert to "pending" so a
      // later call (once the cast has a Stripe account) can still pick
      // this up, instead of leaving it stuck in a non-terminal, never-
      // re-queried state.
      await entryDoc.ref.update({ status: "pending" });
      continue;
    }

    try {
      // FIX (comprehensive project-wide review round 2): no idempotencyKey
      // was ever passed here, so a transfer that actually succeeded on
      // Stripe's side but timed out/errored on our side before the
      // `entryDoc.ref.update` below could commit would fall to `retrying`
      // and be retried by retryFailedCastTransfers with the same
      // amount/destination — a genuine double-transfer. Keyed on the
      // ledger doc's own stable id, which is identical across every retry
      // attempt for this same entry (see retryFailedCastTransfers below),
      // so Stripe itself now dedupes a duplicate call.
      const transfer = await stripe.transfers.create(
        {
          amount: netTransfer,
          currency: "jpy",
          destination: castData.stripe_account_id,
          transfer_group: transferGroup,
          metadata: {
            res_id: resId,
            cast_uid: castId,
            ledger_id: entryDoc.id,
          },
        },
        { idempotencyKey: `transfer_${entryDoc.id}` }
      );

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

// FIX (confirmed live bug, found while tracing IMPLEMENTATION_PLAN.md §9
// scenario 14 against actual code): `transferPendingCastRewards` flips a
// failed transfer's `ledger` entry to `status: "retrying"` — but nothing
// anywhere ever queried that status back out again. Grepped every
// `.where(` across this whole backend before writing this: only `pending`
// is ever read for a reward-transfer attempt. A cast whose Stripe Transfer
// failed once (a transient API error, a momentarily-restricted account,
// etc.) had their reward permanently stranded — the money was correctly
// NOT lost (the ledger entry stays as an accurate record, and any prior
// `logical_debt` offset already applied is real and correct), but nothing
// would ever re-attempt paying it out. This is the actual retry-queue
// mechanism the test scenario expected to already exist. Scoped to a
// bounded page per run (50) and a low hourly cadence, matching this
// backend's other `onSchedule` sweeps (`autoCancelExpiredAuth`,
// `autoCompleteReviews`) — retried transfers are rare by construction
// (only entries that already failed once), so this is not a hot path.
export const retryFailedCastTransfers = onSchedule("every 1 hours", async () => {
  // FIX (comprehensive project-wide review round 2): broadened from
  // `type == "reward"` to also cover "staff_fee" and "tip" — both now use
  // the identical pending -> transferring -> confirmed/retrying shape (see
  // the fixes in processTip and the staff-fee transfer loop above), and
  // both need this same recovery sweep. All three entry shapes carry the
  // same `user_id`/`net_transfer`/`res_id` fields the loop below reads, so
  // no other change to the retry body is needed.
  const retryingSnap = await db
    .collection("ledger")
    .where("type", "in", ["reward", "staff_fee", "tip"])
    .where("status", "==", "retrying")
    .limit(50)
    .get();

  for (const entryDoc of retryingSnap.docs) {
    const entry = entryDoc.data();
    const castId = entry.user_id;
    const resId = entry.res_id;
    const netTransfer = entry.net_transfer || 0;

    // Same transactional claim as transferPendingCastRewards above — only
    // one concurrent sweep (or an in-flight res-scoped call racing this
    // one) wins the right to retry this specific entry.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(entryDoc.ref);
      if (!snap.exists || snap.data()?.status !== "retrying") {
        return false;
      }
      tx.update(entryDoc.ref, { status: "transferring" });
      return true;
    });
    if (!claimed) continue;

    if (netTransfer <= 0) {
      await entryDoc.ref.update({ status: "confirmed", processed: true });
      continue;
    }

    const [castDoc, resDoc] = await Promise.all([
      db.collection("users").doc(castId).get(),
      db.collection("reservations").doc(resId).get(),
    ]);
    const castData = castDoc.data();
    if (!castData?.stripe_account_id) {
      console.error(`Cast ${castId} still has no Stripe account (retry, res ${resId})`);
      await entryDoc.ref.update({ status: "retrying" });
      continue;
    }

    try {
      // Same idempotencyKey basis as the original attempt (entryDoc.id is
      // the same ledger doc every time this entry is retried), so a Stripe
      // transfer that actually succeeded on a prior attempt but was
      // recorded as "retrying" due to a network error on our side cannot
      // be double-sent here.
      const transfer = await stripe.transfers.create(
        {
          amount: netTransfer,
          currency: "jpy",
          destination: castData.stripe_account_id,
          transfer_group: resDoc.data()?.transfer_group,
          metadata: { res_id: resId, cast_uid: castId, ledger_id: entryDoc.id },
        },
        { idempotencyKey: `transfer_${entryDoc.id}` }
      );

      await entryDoc.ref.update({
        stripe_object_id: transfer.id,
        status: "confirmed",
        processed: true,
      });

      const typeLabel =
        entry.type === "staff_fee" ? "スタッフ報酬" : entry.type === "tip" ? "チップ" : "報酬";
      await db
        .collection("users")
        .doc(castId)
        .collection("notifications")
        .add({
          type: "stripe",
          title: `${typeLabel}が確定しました`,
          body: `¥${netTransfer.toLocaleString()} が送金されました。`,
          data: { res_id: resId, amount: netTransfer },
          read: false,
          created_at: Timestamp.now(),
        });
    } catch (err: any) {
      console.error(`Retry transfer failed again for ${castId} (res ${resId}):`, err);
      await entryDoc.ref.update({ status: "retrying" });
    }
  }
});

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
    // FIX (confirmed live bug, found during comprehensive review): unlike
    // its sibling loops in this same file (the cast-reward loop above and
    // the staff-fee loop below), this loop had no per-iteration try/catch
    // — a transient Firestore error on any one cast's affiliate lookup
    // aborted every LATER cast in this same reservation's loop, uncaught,
    // propagating out through `recordCastRewardsAndProcessOthers` to the
    // webhook handler. Because `processed_events` is deliberately created
    // BEFORE dispatch (this project's own idempotency design), Stripe's
    // retry of the same event is treated as a duplicate and skipped — so
    // the missed affiliate rewards for the remaining casts were never
    // retried, silently lost rather than delayed.
    try {
      const castDoc = await db.collection("users").doc(castId).get();
      const castData = castDoc.data();

      if (!castData?.referred_by_uid) continue;

      const referrerDoc = await db.collection("users").doc(castData.referred_by_uid).get();
      const referrerData = referrerDoc.data();

      if (!referrerData || !referrerData.is_active || referrerData.is_frozen) continue;

      // Mutual-approval hard rule (IMPLEMENTATION_PLAN.md §3.7.12): reward
      // only accrues for periods where BOTH the referrer and the referred
      // cast are simultaneously approval_status == "approved". A
      // frozen/not-yet-approved referrer, or a not-yet-approved referred
      // cast, must not accrue reward for this reservation.
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
    } catch (err) {
      console.error(`Affiliate reward processing failed for cast ${castId} on reservation ${resId}:`, err);
      continue;
    }
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
  const stripeFee = Math.ceil(chargedAmount * 0.036);

  // FIX (confirmed live bug, found during audit): the "≥1h notice"
  // guest-cancellation tier passes castRewardPercent=0 (guest charged 50%,
  // cast gets nothing) — this function used to `return` immediately in
  // that case with NO ledger entry at all for `chargedAmount`, even though
  // `cancelPayment` (the only caller) had already run a real
  // `stripe.paymentIntents.capture()` for it moments earlier. Every other
  // capture path in this codebase writes a ledger row for what it
  // captures — see `adminForceCancel`'s own identical fix (admin.ts,
  // partial-capture path) for the same "every capture needs a ledger row"
  // rule. Left unfixed, this specific cancellation tier's revenue was
  // captured for real but invisible to `adminGetLedger`'s ledger view,
  // with no audit trail. Recorded as a single platform-only entry (no
  // cast, no transfer — a human didn't choose this amount, the
  // cancellation-fee matrix did) rather than one row per cast_id, since
  // no cast receives any share of it.
  if (castIds.length === 0 || castRewardPercent <= 0) {
    if (chargedAmount > 0) {
      const ledgerRef = db.collection("ledger").doc();
      await ledgerRef.set({
        ledger_id: ledgerRef.id,
        res_id: resId,
        user_id: resData.guest_id || "",
        type: "cancellation_fee",
        gross_amount: chargedAmount,
        cast_reward: 0,
        staff_fee: 0,
        stripe_fee: stripeFee,
        platform_profit: chargedAmount - stripeFee,
        tax_amount: 0,
        net_transfer: 0,
        amount: chargedAmount,
        stripe_event_id: "",
        stripe_object_id: "",
        status: "confirmed",
        processed: true,
        created_at: Timestamp.now(),
      });
    }
    return;
  }

  const castRewardPool = Math.round(chargedAmount * castRewardPercent);
  const rewardShareEach = Math.floor(castRewardPool / castIds.length);
  if (rewardShareEach <= 0) return;

  // FIX (confirmed live bug, found during audit, same class as the
  // already-fixed `actualTransportDistributed` gap in
  // recordCastRewardsAndProcessOthers above): `platformProfit` used to be
  // computed as `chargedAmount - castRewardPool - stripeFee` — the FULL
  // theoretical pool, not what was actually paid out. Two ways that
  // overstates the cast side (understating platform_profit) in the exact
  // same ledger row written for every cast: (1) `castRewardPool` doesn't
  // divide evenly by `castIds.length` — e.g. a ¥1,000 pool across 3 casts
  // pays 3×¥333=¥999, leaving ¥1 the theoretical pool never actually
  // distributed; (2) any cast without a `stripe_account_id` is skipped
  // entirely (`continue` below) and receives nothing. Fixed by first
  // determining which casts actually get paid, then computing
  // platform_profit from what was REALLY distributed
  // (`rewardShareEach × payable cast count`), applied identically to every
  // row exactly like `sharedPlatformProfit` above.
  const payableCastIds: string[] = [];
  for (const castId of castIds) {
    const castDoc = await db.collection("users").doc(castId).get();
    if (castDoc.data()?.stripe_account_id) payableCastIds.push(castId);
  }
  const actualCastRewardDistributed = rewardShareEach * payableCastIds.length;
  const sharedPlatformProfit = chargedAmount - actualCastRewardDistributed - stripeFee;

  for (const castId of payableCastIds) {
    try {
      await db.runTransaction(async (tx) => {
        const castRef = db.collection("users").doc(castId);
        const freshCastDoc = await tx.get(castRef);
        const currentDebt = freshCastDoc.data()?.logical_debt || 0;

        const debtDeduction = Math.min(currentDebt, rewardShareEach);
        const netTransfer = rewardShareEach - debtDeduction;
        const newDebt = currentDebt - debtDeduction;
        const platformProfit = sharedPlatformProfit;
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

  // FIX (confirmed live bug, found during audit): no status guard existed -
  // calling this on an already-`completed`/`cancelled`/`expired`
  // reservation attempted to capture/cancel an already-finalized
  // PaymentIntent. Stripe itself rejects that (caught below, rethrown as
  // an HttpsError, so it wasn't silently wrong) - but it should be
  // rejected up front with a clear reason rather than attempted and fail.
  if (["completed", "cancelled", "expired"].includes(resData.status)) {
    throw new HttpsError(
      "failed-precondition",
      "この予約はすでに終了しているため、キャンセルできません。"
    );
  }

  try {
    // FIX (confirmed live bug, found during comprehensive review): unlike
    // `capturePayment` (which guards this exact case), nothing here checked
    // whether a PaymentIntent was ever actually created before touching
    // Stripe. `reservations.ts` creates every reservation with
    // `payment_intent_id: ""` up front — a guest who cancels from
    // `ReservationDetail` before ever reaching `payment_confirm.dart`
    // (before any authorization exists) always has `chargedAmount > 0`
    // (guest cancellation charges 50-100% of `total_amount`, always >0), so
    // this unconditionally called `stripe.paymentIntents.capture("", ...)`
    // — Stripe rejects the empty ID, the catch below rethrows a generic
    // "internal" error, and the guest is stuck unable to cancel a
    // reservation they never even paid for. No Stripe interaction is
    // needed in that case — skip straight to the local cancellation
    // bookkeeping below.
    const hasPaymentIntent = !!resData.payment_intent_id;

    // FIX (confirmed live bug, found while tracing IMPLEMENTATION_PLAN.md
    // §9 scenario 11 against actual code, CORRECTED after a fresh-eyes
    // re-review found the first version of this fix was itself wrong):
    // this function has only ever touched the reservation's OWN
    // `payment_intent_id` — any still-`authorized` (not yet captured)
    // extension PaymentIntent was left dangling on a whole-reservation
    // cancel, an orphaned Stripe hold with no release path.
    //
    // The first version of this fix ALSO refunded already-`captured`
    // extensions, which is wrong: `reportCompletion` (reservations.ts)
    // writes `status: "completion_pending"` BEFORE it ever calls
    // `captureAuthorizedExtensions` — confirmed by reading that function's
    // actual write order, not assumed — so an extension can only ever
    // reach `captured` once the reservation has ALREADY progressed past
    // `in_progress`. A captured extension therefore always represents
    // genuinely delivered service, by construction, exactly the same
    // condition the base payment's own `castHasArrived` check below
    // already uses to decide "no refund, service was rendered." Blindly
    // refunding a captured extension here would refund real, already-paid-
    // for time with no ledger entry and no clawback of any reward already
    // transferred to the cast for it — a real money-safety regression the
    // first fix attempt introduced. A captured extension that genuinely
    // needs to be refunded (e.g. a service dispute) should go through
    // `adminManualRefund` — a deliberate, reasoned admin action — not an
    // automatic side effect of cancelling the parent reservation.
    //
    // Scope, corrected: only sweep `authorized` extensions (never-captured
    // holds), releasing each via `paymentIntents.cancel` — the same
    // release path the base PI itself uses. Each extension's own locked
    // `schedule_slots` row is released via the same `extensionSlotsQuery`
    // helper `cancelExtensionPayment` already uses, so no slot is left
    // orphaned either.
    const extensionsSnap = await db
      .collection("reservations")
      .doc(res_id)
      .collection("extensions")
      .where("status", "==", "authorized")
      .get();

    for (const extDoc of extensionsSnap.docs) {
      const extData = extDoc.data();
      const extPaymentIntentId: string | undefined = extData.payment_intent_id;
      if (extPaymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(extPaymentIntentId);
        } catch (err) {
          console.error(
            `Failed to release extension ${extDoc.id} during reservation cancel:`,
            err
          );
          // Don't let one extension's Stripe error abort the whole
          // reservation cancellation — surfaced via the console log above
          // for manual admin follow-up, same failure-isolation philosophy
          // already used elsewhere in this function for the staff-fee/chat
          // cleanup steps below.
        }
      }

      await db.runTransaction(async (tx) => {
        const slotsSnap = await tx.get(extensionSlotsQuery(extDoc.id));
        tx.update(extDoc.ref, { status: "cancelled", updated_at: Timestamp.now() });
        slotsSnap.forEach((slot) => tx.delete(slot.ref));
      });
    }

    // Nothing was ever authorized (payment_intent_id is empty) — cancel is
    // purely local, skip Stripe entirely rather than call it with an empty
    // ID (below).
    if (hasPaymentIntent && cancelledBy === "guest") {
      const arrivedStatuses = ["in_progress", "completion_pending", "review_pending", "completed"];
      const scheduledStart: Date = resData.date?.toDate ? resData.date.toDate() : new Date(resData.date);
      const hoursUntilStart = (scheduledStart.getTime() - Date.now()) / (1000 * 60 * 60);
      const castHasArrived = arrivedStatuses.includes(resData.status);

      const guestChargePercent = castHasArrived || hoursUntilStart < 1 ? 1.0 : 0.5;
      const castRewardPercent = castHasArrived || hoursUntilStart < 1 ? 0.25 : 0;
      const chargedAmount = Math.round(resData.total_amount * guestChargePercent);

      if (chargedAmount > 0) {
        // FIX (confirmed live bug, found during comprehensive review):
        // capturing this PaymentIntent with no `metadata.type` made
        // `handlePaymentIntentSucceeded` (stripe-webhooks.ts) treat this
        // cancellation-fee capture as if it were the MAIN reservation's
        // normal full-service completion — the exact same
        // "type"-less-metadata ambiguity already solved for extension/tip
        // PaymentIntents, just not applied here. Left unfixed, every
        // guest-charged cancellation would: (1) overwrite the
        // `status: "cancelled"` this function is about to write (below)
        // back to `"review_pending"`, letting a review be submitted for a
        // cancelled reservation; (2) call `recordCastRewardsAndProcessOthers`
        // using `total_amount` (the FULL original booking amount), paying
        // the cast a SECOND time on top of `recordCancellationCastRewards`
        // below — which already correctly pays the cast from `chargedAmount`
        // at the reduced cancellation-tier rate. Tagging `metadata.type`
        // makes the webhook's existing `!paymentIntent.metadata?.type`
        // guard skip that whole block for this capture, exactly like it
        // already does for extensions/tips. Stripe metadata updates merge
        // by key, so this does not disturb `res_id`/`guest_uid`/etc.
        await stripe.paymentIntents.capture(resData.payment_intent_id, {
          amount_to_capture: chargedAmount,
          metadata: { type: "cancellation" },
        });
        await recordCancellationCastRewards(res_id, resData, chargedAmount, castRewardPercent);
      } else {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }
    } else if (hasPaymentIntent) {
      // cast- or admin-caused: full release/refund, no guest charge.
      await stripe.paymentIntents.cancel(resData.payment_intent_id);
    }

    if (cancelledBy === "cast" && hasPaymentIntent) {
      // Same `hasPaymentIntent` guard as above — a reservation with no
      // PaymentIntent was never actually charged by Stripe, so there's no
      // real Stripe fee to pass on to the cast as debt.
      //
      // FIX (confirmed live bug, found during audit): the Stripe processing
      // fee belongs to the ONE shared PaymentIntent on this reservation, not
      // to each cast individually — but this used to add the FULL
      // `stripeFeeEstimate` to EVERY cast's `logical_debt` independently
      // inside the loop below. On a multi-cast reservation, N casts were
      // each debited the entire fee, so the platform recouped N× the real
      // Stripe fee in aggregate instead of splitting the one real cost
      // across them. Split evenly across the casts actually on this
      // reservation, matching the same equal-split pattern already used for
      // shared costs elsewhere in this file (`perStaffFee`,
      // `castTransportShareEach`, `rewardShareEach`).
      const castIdsForCancelDebt: string[] = resData.cast_ids || [];
      const stripeFeeEstimate = Math.ceil(resData.total_amount * 0.036);
      const perCastStripeFee =
        castIdsForCancelDebt.length > 0
          ? Math.floor(stripeFeeEstimate / castIdsForCancelDebt.length)
          : 0;

      for (const castId of castIdsForCancelDebt) {
        await db.runTransaction(async (tx) => {
          const castRef = db.collection("users").doc(castId);
          const castDoc = await tx.get(castRef);
          const currentDebt = castDoc.data()?.logical_debt || 0;

          tx.update(castRef, {
            logical_debt: currentDebt + perCastStripeFee,
            updated_at: Timestamp.now(),
          });
        });

        await db.collection("debt_history").add({
          user_id: castId,
          amount: perCastStripeFee,
          reason: "キャスト都合キャンセルによる決済手数料負担",
          res_id,
          created_at: Timestamp.now(),
        });
      }
    }

    // FIX (PROJECT_KNOWLEDGE.md §68): this used to query the ENTIRE
    // schedule_slots collection for status=="reserved" with no res_id/date
    // scoping at all, then filter client-side by cast_ids.includes(...) —
    // meaning cancelling ONE reservation would incorrectly release EVERY
    // reserved slot belonging to that cast, including ones from a
    // completely different, still-valid reservation. Dormant as long as
    // nothing ever set status:"reserved"; live and dangerous now that
    // Authorize-time locking (stripe-webhooks.ts) does. Replaced with a
    // single transaction, scoped precisely by res_id via
    // reservedSlotsQuery, combined with the reservation status write so a
    // release is never observed as separate from the cancellation that
    // caused it (an orphaned "reserved" slot has no self-healing path).
    await db.runTransaction(async (tx) => {
      const slotsSnap = await tx.get(reservedSlotsQuery(res_id));
      tx.update(db.collection("reservations").doc(res_id), {
        status: "cancelled",
        cancel_reason: cancel_reason || "",
        cancelled_by: cancelledBy,
        updated_at: Timestamp.now(),
      });
      slotsSnap.forEach((slot) => tx.delete(slot.ref));
    });

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

  const { res_id, duration_minutes } = request.data;

  if (!res_id || !duration_minutes || duration_minutes <= 0) {
    throw new HttpsError("invalid-argument", "予約IDと延長時間が必要です。");
  }
  // FIX (PROJECT_KNOWLEDGE.md §70): the pricing formula below rounds to the
  // nearest 30-min BLOCK for the charge, while the raw, unrounded
  // duration_minutes is what actually gets added to the reservation — a
  // misaligned value (e.g. 44) lets a direct-callable caller add real
  // extra minutes while only being charged for the rounded-down block.
  // Same validation already added to createReservation (§68).
  if (duration_minutes % 30 !== 0) {
    throw new HttpsError("invalid-argument", "延長時間は30分単位で指定してください。");
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

  // FIX (confirmed live bug, found on this same fix's own review pass -
  // the exact same vulnerability class `createPaymentIntent`'s own
  // `transport_fee` fix above already closed): `amount` used to come
  // straight from `request.data` with only an ">0" check - never validated
  // against `duration_minutes` at all. A client (malicious, or just a UI
  // bug feeding a stale/mismatched default - both real risks) could
  // request 5 hours of extension for literally ¥1. Server-computed here
  // instead, from `duration_minutes` and the RESERVATION's own real
  // `time_slot` (never trusted from the client either) - mirrors
  // `calculateExtensionPrice`'s exact client-side formula (same rate
  // constants) so what the guest sees in the app matches what they're
  // actually charged.
  const nightSlots: string[] = config.night_time_slots || ["3部", "4部"];
  const isNightSlot = nightSlots.includes(resData.time_slot);
  const ratePerThirtyMin = isNightSlot ? 3000 : 2500;
  const computedBase = Math.round(duration_minutes / 30) * ratePerThirtyMin;
  const computedTax = Math.round(computedBase * 0.1);
  const amount = computedBase + computedTax;

  // Ownership check - this callable had none at all: it fetched the
  // reservation (above, for the extension-limit checks) but never verified
  // the caller actually owns it before mutating extension_count/
  // duration_minutes and creating a real Stripe PaymentIntent. Guest-only,
  // same reasoning as createPaymentIntent above - the PaymentIntent is
  // created against the caller's own stripe_customer_id a few lines below.
  if (resData.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  // FIX (confirmed live bug, found during audit): no status guard existed -
  // a guest could purchase (and, until captureAuthorizedExtensions above,
  // never even be charged for) an extension on a reservation that's
  // `cancelled`/`completed`/not yet `in_progress`. Extensions only make
  // sense while the interaction is actively happening.
  if (resData.status !== "in_progress") {
    throw new HttpsError(
      "failed-precondition",
      "この予約は延長できる状態ではありません。"
    );
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): the extension_count/duration_minutes cap checks above read
  // `resData` from a plain, non-transactional `.get()` at the top of this
  // function, and the final write below was a PLAIN OVERWRITE
  // (`duration_minutes: newTotalMinutes`, computed from that same stale
  // read) rather than an atomic increment. Two concurrent extend calls
  // (double-tap, or a client retry) could both pass the cap check against
  // the same stale extension_count — bypassing extension_limit_count — and
  // whichever write landed LAST would silently overwrite the other's
  // duration_minutes contribution, even though BOTH extension PaymentIntents
  // were genuinely created and both get captured for real money later by
  // captureAuthorizedExtensions (which reads the extensions subcollection
  // independently of this field). Net effect: the guest could be charged
  // for more extension time than duration_minutes ever reflects.
  //
  // Fixed by claiming capacity — re-checking status/cap against a FRESH
  // read and atomically writing the increment — inside a transaction,
  // BEFORE ever touching Stripe (a Firestore transaction body can retry on
  // contention, so a non-idempotent external call like
  // stripe.paymentIntents.create must never live inside one). If Stripe
  // then fails, the claim is explicitly reverted below so a failed
  // extension attempt never leaves extension_count/duration_minutes
  // inflated with nothing behind it.
  const { newTotalMinutes, extensionNumber, priorDurationMinutes } = await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(db.collection("reservations").doc(res_id));
    if (!freshSnap.exists) {
      throw new HttpsError("not-found", "予約が見つかりません。");
    }
    const freshData = freshSnap.data()!;
    if (freshData.status !== "in_progress") {
      throw new HttpsError("failed-precondition", "この予約は延長できる状態ではありません。");
    }
    const currentExtensionCount = freshData.extension_count || 0;
    if (currentExtensionCount >= extensionLimit) {
      throw new HttpsError("failed-precondition", `延長は最大${extensionLimit}回までです。`);
    }
    const freshPriorDurationMinutes = freshData.duration_minutes || 0;
    const freshNewTotalMinutes = freshPriorDurationMinutes + duration_minutes;
    if (freshNewTotalMinutes > maxTotalHours * 60) {
      throw new HttpsError("failed-precondition", `総時間は最大${maxTotalHours}時間までです。`);
    }
    tx.update(freshSnap.ref, {
      extension_count: currentExtensionCount + 1,
      duration_minutes: freshNewTotalMinutes,
      updated_at: Timestamp.now(),
    });
    return {
      newTotalMinutes: freshNewTotalMinutes,
      extensionNumber: currentExtensionCount + 1,
      priorDurationMinutes: freshPriorDurationMinutes,
    };
  });

  // FIX (PROJECT_KNOWLEDGE.md §71/§72: extension schedule_slots locking —
  // the one gap the project's own last comprehensive review named as still
  // open). The base reservation's booked window is [resData.date,
  // +duration_minutes) and gets locked at Authorize-time in
  // stripe-webhooks.ts's handleAmountCapturableUpdated; an extension grows
  // that window by `duration_minutes` starting exactly where the
  // PRE-increment total left off, so `slot_start` here is computed from
  // `priorDurationMinutes` (captured inside the transaction above, before
  // the increment) — never from the now-already-incremented
  // `newTotalMinutes`, which would double-count and point the window past
  // where the extension actually starts.
  const reservationStart: Date = resData.date.toDate();
  const slotStart = new Date(reservationStart.getTime() + priorDurationMinutes * 60_000);

  // Advisory guest-side availability check (mirrors createReservation's own
  // use of findUnavailableCastId, reservations.ts) — not the authoritative
  // enforcement, that's the transactional lock in stripe-webhooks.ts's new
  // handleExtensionAmountCapturableUpdated, which runs once funds are
  // actually held. This exists purely to give a guest fast, friendly
  // feedback and avoid an unnecessary Stripe PaymentIntent for the common
  // case where the extended window is already known to conflict, instead of
  // letting the guest reach the payment sheet only to have the webhook
  // silently cancel the hold afterward. Runs AFTER the capacity claim above
  // (mirrors the existing Stripe-failure catch block's own revert), so a
  // rejection here reverts the same way a Stripe failure does.
  const unavailableCastId = await findUnavailableCastId(resData.cast_ids || [], slotStart, duration_minutes);
  if (unavailableCastId) {
    await db.collection("reservations").doc(res_id).update({
      extension_count: FieldValue.increment(-1),
      duration_minutes: FieldValue.increment(-duration_minutes),
      updated_at: Timestamp.now(),
    });
    throw new HttpsError(
      "failed-precondition",
      "選択した延長時間はご利用いただけません。別の時間をお選びください。"
    );
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();

  // Allocated before the Stripe call (rather than after, as this used to be)
  // so its ID can ride along in the PaymentIntent's own metadata —
  // `handleExtensionAmountCapturableUpdated` (stripe-webhooks.ts) needs a
  // way to find this exact extension doc from the webhook payload alone to
  // read back `slot_start`/`duration_minutes` and lock the right window.
  const extRef = db
    .collection("reservations")
    .doc(res_id)
    .collection("extensions")
    .doc();

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
        extension_id: extRef.id,
        extension_number: extensionNumber.toString(),
        guest_uid: request.auth.uid,
      },
    });

    await extRef.set({
      ext_id: extRef.id,
      payment_intent_id: paymentIntent.id,
      amount,
      duration_minutes,
      slot_start: Timestamp.fromDate(slotStart),
      status: "authorized",
      created_at: Timestamp.now(),
    });

    return {
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      extension_id: extRef.id,
    };
  } catch (err: any) {
    console.error("Extension payment creation failed:", err);
    // Revert the capacity claim made above — no PaymentIntent (and/or no
    // extension doc) actually exists for this attempt, so leaving
    // extension_count/duration_minutes incremented would overstate both
    // with nothing real behind them.
    await db.collection("reservations").doc(res_id).update({
      extension_count: FieldValue.increment(-1),
      duration_minutes: FieldValue.increment(-duration_minutes),
      updated_at: Timestamp.now(),
    });
    throw new HttpsError("internal", `延長決済の作成に失敗しました: ${err.message}`);
  }
});

/**
 * FIX (confirmed live bug, found during a review pass on the extension_payment.dart
 * rebuild): `createExtensionPayment` above writes `extension_count`/
 * `duration_minutes` onto the reservation and creates the `extensions`
 * subdoc as `status: "authorized"` IMMEDIATELY on PaymentIntent creation -
 * before the guest has actually completed anything in the Stripe Payment
 * Sheet (`confirmStripePayment`, called separately from the client right
 * after this). If the guest cancels that sheet or their card is declined,
 * nothing ever rolled this back: the reservation permanently shows extra
 * duration and one consumed extension slot (of the max-3 cap) for a
 * payment that never happened - a guest whose card fails 3 times would
 * permanently exhaust their extension cap without ever successfully
 * extending once. Called from the client's own payment-failure branch
 * (mirrors `confirmStripePayment`/`isPaymentSuccess`'s existing pattern -
 * the client already knows locally whether payment succeeded, this just
 * gives it a way to report "it didn't" back to the two pieces of state
 * that were optimistically written).
 *
 * Transactional and defensive: re-reads the extension doc's own
 * `duration_minutes` (not a guessed/recomputed value) and only decrements
 * if its status is STILL `"authorized"` - if a race means it was already
 * captured (`captureAuthorizedExtensions`) by the time this runs, this is a
 * no-op rather than incorrectly reversing a real, successful payment.
 * Cancels the abandoned Stripe PaymentIntent best-effort (not fatal if it
 * fails - the intent will simply expire on Stripe's side eventually
 * either way).
 */
export const cancelExtensionPayment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, extension_id } = request.data;
  if (!res_id || !extension_id) {
    throw new HttpsError("invalid-argument", "予約IDと延長IDが必要です。");
  }

  const resRef = db.collection("reservations").doc(res_id);
  const extRef = resRef.collection("extensions").doc(extension_id);

  const resDoc = await resRef.get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  if (resDoc.data()?.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  let paymentIntentToCancelId: string | null = null;

  await db.runTransaction(async (tx) => {
    const extDoc = await tx.get(extRef);
    if (!extDoc.exists) return;
    const extData = extDoc.data()!;
    if (extData.status !== "authorized") return;

    const freshResDoc = await tx.get(resRef);
    // FIX (PROJECT_KNOWLEDGE.md §71/§72): a real race exists between this
    // client-reported "payment failed" path and Stripe's own
    // `amount_capturable_updated` webhook, which can land the extension's
    // schedule_slots lock (stripe-webhooks.ts's
    // handleExtensionAmountCapturableUpdated) concurrently with — or even
    // before — this call runs. Reading extensionSlotsQuery here, inside the
    // SAME transaction as the status flip to "cancelled", means whichever of
    // the two writers commits last always sees a consistent picture: if the
    // lock already landed, it's released in the same atomic step as the
    // cancellation; if it hasn't landed yet, this is an empty read and a
    // no-op delete loop. Never a separate, observable "cancelled but still
    // locked" state.
    const slotsSnap = await tx.get(extensionSlotsQuery(extension_id));
    const currentDuration = freshResDoc.data()?.duration_minutes || 0;
    const currentCount = freshResDoc.data()?.extension_count || 0;

    tx.update(resRef, {
      duration_minutes: Math.max(0, currentDuration - (extData.duration_minutes || 0)),
      extension_count: Math.max(0, currentCount - 1),
      updated_at: Timestamp.now(),
    });
    tx.update(extRef, { status: "cancelled", updated_at: Timestamp.now() });
    slotsSnap.forEach((slot) => tx.delete(slot.ref));

    paymentIntentToCancelId = extData.payment_intent_id || null;
  });

  if (paymentIntentToCancelId) {
    try {
      await stripe.paymentIntents.cancel(paymentIntentToCancelId);
    } catch (err) {
      console.error(`Failed to cancel abandoned extension PaymentIntent ${paymentIntentToCancelId}:`, err);
    }
  }

  return { success: true };
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
  // FIX (PROJECT_KNOWLEDGE.md §70, CRITICAL — comprehensive project-wide
  // review): this used to call `stripe.paymentIntents.create({..., confirm:
  // true, automatic_payment_methods: {enabled: true}, ...})` with NO
  // `payment_method` ever supplied, and no `default_payment_method` is set
  // on any customer anywhere in this codebase (createSetupIntent, the only
  // "save a card" path, is itself confirmed unreachable from any UI). Per
  // Stripe's own API contract, confirming with no resolvable payment
  // method fails outright — this feature has never been able to charge
  // anyone; every real tip attempt failed at the Stripe API and was
  // swallowed by the client's own catch-and-return-false wrapper, with the
  // guest seeing only a generic failure Snackbar.
  //
  // Fixed by requiring `res_id` (already what the one real UI entry point,
  // ReservationDetail, always sends) and reusing the PAYMENT METHOD from
  // that reservation's own already-completed PaymentIntent — the guest
  // already went through a real Payment Sheet confirmation once for this
  // reservation, so charging the tip to that same card requires no new
  // client-side UI. `off_session: true` acknowledges to Stripe that the
  // customer isn't actively present in a payment flow right now (a
  // legitimate, documented pattern for "charge the same card used for the
  // original booking").
  if (!res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }
  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  const resData = resDoc.data()!;
  if (resData.guest_id !== request.auth.uid) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }
  if (!resData.payment_intent_id) {
    throw new HttpsError(
      "failed-precondition",
      "この予約の決済情報が見つからないため、チップを送れません。"
    );
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const castDoc = await db.collection("users").doc(cast_id).get();

  if (!castDoc.exists || !castDoc.data()?.stripe_account_id) {
    throw new HttpsError("not-found", "キャストが見つかりません。");
  }

  try {
    const sourcePaymentIntent = await stripe.paymentIntents.retrieve(resData.payment_intent_id);
    const paymentMethodId =
      typeof sourcePaymentIntent.payment_method === "string"
        ? sourcePaymentIntent.payment_method
        : sourcePaymentIntent.payment_method?.id;
    if (!paymentMethodId) {
      throw new HttpsError(
        "failed-precondition",
        "この予約の決済方法を取得できないため、チップを送れません。"
      );
    }

    // FIX (confirmed live bug, found during audit): neither this
    // PaymentIntent nor the Transfer below set `transfer_group` — every
    // other charge/transfer tied to this reservation (the base PaymentIntent,
    // extension PaymentIntents, staff/cast reward transfers) shares
    // `resData.transfer_group` so Stripe's own dashboard/reporting can
    // reconcile everything that belongs to one reservation together. A tip
    // silently fell outside that group.
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "jpy",
      customer: userDoc.data()?.stripe_customer_id,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      transfer_group: resData.transfer_group,
      metadata: {
        res_id: res_id || "",
        type: "tip",
        guest_uid: request.auth.uid,
        cast_uid: cast_id,
      },
    });

    if (paymentIntent.status === "succeeded") {
      // FIX (comprehensive project-wide review round 2): the transfer used
      // to run inline with no ledger record until AFTER it succeeded — a
      // transfer failure (restricted Connect account, transient network
      // error) fell into the outer catch below, which threw an error back
      // to the guest even though their card was already charged, with no
      // ledger entry and no way to ever recover or retry the payout. Fixed
      // by writing the ledger entry "pending" BEFORE calling Stripe (so the
      // charge is durably tracked no matter what happens next), and by
      // never letting a transfer failure surface as an error to the guest —
      // mirrors transferPendingCastRewards's pending -> transferring ->
      // confirmed/retrying pattern so retryFailedCastTransfers (broadened
      // below to also sweep type "tip") can recover it later.
      const ledgerRef = db.collection("ledger").doc();
      await ledgerRef.set({
        ledger_id: ledgerRef.id,
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
        stripe_object_id: "",
        status: "pending",
        processed: false,
        created_at: Timestamp.now(),
      });

      try {
        const transfer = await stripe.transfers.create(
          {
            amount,
            currency: "jpy",
            destination: castDoc.data()!.stripe_account_id,
            transfer_group: resData.transfer_group,
            metadata: {
              res_id: res_id || "",
              type: "tip",
              cast_uid: cast_id,
              ledger_id: ledgerRef.id,
            },
          },
          { idempotencyKey: `transfer_${ledgerRef.id}` }
        );

        await ledgerRef.update({
          stripe_object_id: transfer.id,
          status: "confirmed",
          processed: true,
        });
      } catch (transferErr) {
        console.error(`Tip transfer failed for ${cast_id} (res ${res_id}):`, transferErr);
        await ledgerRef.update({ status: "retrying" });
      }
    }

    return { success: true, message: "チップが送られました。" };
  } catch (err: any) {
    console.error("Tip payment failed:", err);
    // Preserve a deliberately-thrown HttpsError's own code (e.g. the
    // failed-precondition above) instead of collapsing every failure —
    // including our own precondition checks — into a generic "internal".
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError("internal", `チップの送信に失敗しました: ${err.message}`);
  }
});

/**
 * Callable: Add payment method (支払い方法の登録)
 *
 * FIX (PROJECT_KNOWLEDGE.md §71/§72): this used to return only the
 * SetupIntent's own `client_secret` — enough to CREATE a PaymentSheet, but
 * not enough to open it in the "returning customer" shape flutter_stripe
 * requires (`customerId` + `customerEphemeralKeySecret` alongside the
 * intent's client_secret; omitting them still opens a sheet, but as an
 * anonymous one-off card entry with no link back to this customer's Stripe
 * record, defeating the entire point of a saved-card registration flow).
 * Now also mints a matching ephemeral key, scoped to this customer, pinned
 * to the SAME Stripe API version this backend's own `stripe` client already
 * uses (`STRIPE_API_VERSION`, config.ts — not a second hardcoded literal
 * that could silently drift from it over time).
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

  const [setupIntent, ephemeralKey] = await Promise.all([
    stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    }),
    stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: STRIPE_API_VERSION }
    ),
  ]);

  return {
    success: true,
    client_secret: setupIntent.client_secret,
    customer_id: customerId,
    ephemeral_key_secret: ephemeralKey.secret,
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

  // FIX (confirmed live bug, final precision audit second pass): frozen
  // accounts (adminToggleFreeze, used for fraud/ToS violations) could still
  // call this directly — no check here trusted the account's frozen state
  // at all. Freezing already blocks new bookings/chat elsewhere in this
  // codebase; leaving payout requests reachable defeats the whole point of
  // freezing a suspect account. Checked before the debt/balance checks so
  // a frozen account can never even create a pending request.
  if (userData.is_frozen) {
    throw new HttpsError(
      "permission-denied",
      "アカウントが凍結されているため出金申請できません。"
    );
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
