/**
 * Reservation Management Cloud Functions
 * 予約管理
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, stripe, Timestamp, getSystemConfig } from "./config";
import { transferPendingCastRewards } from "./stripe-payments";

/**
 * Callable: Create reservation request
 * 予約リクエストの作成
 */
export const createReservation = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();
  if (!userData || userData.account_type !== "guest" || userData.approval_status !== "approved") {
    throw new HttpsError("permission-denied", "承認済みゲストのみ予約可能です。");
  }

  const {
    cast_ids,
    date,
    time_slot,
    duration_minutes,
    location,
    meeting_point,
    group_invite,
    group_size,
    details,
    base_amount,
    staff_selections,
    needs_security,
    needs_transport,
  } = request.data;

  if (!cast_ids || cast_ids.length === 0) {
    throw new HttpsError("invalid-argument", "キャストを選択してください。");
  }

  for (const castId of cast_ids) {
    const castDoc = await db.collection("users").doc(castId).get();
    if (!castDoc.exists || castDoc.data()?.approval_status !== "approved") {
      throw new HttpsError("not-found", `キャスト ${castId} が見つかりません。`);
    }
    if (castDoc.data()?.is_frozen) {
      throw new HttpsError("failed-precondition", "選択されたキャストは利用できません。");
    }
    if (castDoc.data()?.blocked_users?.includes(uid)) {
      throw new HttpsError("permission-denied", "このキャストに予約を送れません。");
    }
  }

  const config = await getSystemConfig();

  // Staff-fee-first split (§3.9.11): `staff_selections` is an optional
  // array of {staff_id, role: "security"|"transport"}. Each staff member
  // must actually hold that role (staff_type matches the requested role,
  // or is "both") - this is a distinct check from cast_ids validation
  // above since staff aren't cast members being booked for the
  // interaction itself, just fee-earning support roles on the same
  // reservation. recordCastRewardsAndProcessOthers (stripe-payments.ts)
  // already correctly subtracts staff_fee before computing cast reward
  // and splits it evenly across staff_ids - this is the missing input
  // side that never fed it real data (staffFee was hardcoded to 0).
  const staffIds: string[] = [];
  let staffFeeTotal = 0;
  for (const sel of staff_selections || []) {
    const staffId = sel?.staff_id;
    const role = sel?.role;
    if (!staffId || (role !== "security" && role !== "transport")) {
      throw new HttpsError(
        "invalid-argument",
        "staff_selectionsの形式が不正です（staff_id, roleが必要）。"
      );
    }
    const staffDoc = await db.collection("users").doc(staffId).get();
    const staffData = staffDoc.data();
    if (!staffDoc.exists || staffData?.approval_status !== "approved") {
      throw new HttpsError("not-found", `スタッフ ${staffId} が見つかりません。`);
    }
    if (staffData?.is_frozen) {
      throw new HttpsError("failed-precondition", "選択されたスタッフは利用できません。");
    }
    if (staffData?.staff_type !== role && staffData?.staff_type !== "both") {
      throw new HttpsError(
        "failed-precondition",
        `スタッフ ${staffId} はこの役割（${role}）に対応していません。`
      );
    }
    staffIds.push(staffId);
    staffFeeTotal +=
      role === "security" ? config.security_staff_fee : config.transport_staff_fee;
  }

  // `needs_security`/`needs_transport`: the "I need this role but don't
  // have a specific person in mind" path — the realistic one, since there
  // is no staff-browsing/discovery UI anywhere in this app for a guest to
  // even obtain a staff_id to pass into staff_selections above.
  // security_staff_fee/transport_staff_fee are FLAT, role-level config
  // values (not per-individual), so the fee is fully determined by the
  // role alone — the specific staff member can be resolved later via the
  // work_posts apply/select flow (mirrors group_invite's own already-
  // proven pattern below) without ever needing to touch total_amount or
  // the Stripe authorization again. Skips the flat fee for a role already
  // covered by a direct staff_selections entry, to avoid double-charging.
  const alreadyStaffedRoles = new Set(
    (staff_selections || []).map((sel: { role?: string }) => sel?.role)
  );
  const wantsSecurity = needs_security === true && !alreadyStaffedRoles.has("security");
  const wantsTransport = needs_transport === true && !alreadyStaffedRoles.has("transport");
  if (wantsSecurity) staffFeeTotal += config.security_staff_fee;
  if (wantsTransport) staffFeeTotal += config.transport_staff_fee;

  // NOTE: `getSystemConfig()`'s key-casing bug (SYSTEM_DEFAULTS was
  // UPPER_SNAKE_CASE against Firestore's lower_snake_case fields, so the
  // `{ ...SYSTEM_DEFAULTS, ...doc.data() }` spread never actually applied
  // an admin's configured value) is fixed in config.ts — `config` below now
  // correctly reflects the real Firestore document. The raw second-read
  // workaround this comment used to describe is no longer needed.
  const nightTimeSlots = config.night_time_slots;

  let transportFee = 0;
  if (nightTimeSlots.includes(time_slot)) {
    transportFee = config.transport_fee_amount;
  }

  const totalAmount = base_amount + transportFee + staffFeeTotal;

  const resRef = db.collection("reservations").doc();
  const resId = resRef.id;

  await resRef.set({
    res_id: resId,
    guest_id: uid,
    cast_ids,
    staff_ids: staffIds,
    status: "request_pending",
    date: Timestamp.fromDate(new Date(date)),
    time_slot,
    duration_minutes,
    location: location || "",
    meeting_point: meeting_point || "",
    group_invite: group_invite || false,
    group_size: group_size || 0,
    needs_security: wantsSecurity,
    needs_transport: wantsTransport,
    details: details || "",
    base_amount,
    transport_fee: transportFee,
    staff_fee: staffFeeTotal,
    total_amount: totalAmount,
    extension_count: 0,
    total_hours: duration_minutes / 60,
    payment_intent_id: "",
    transfer_group: `res_${resId}`,
    last_capture_at: null,
    thirty_min_rule_applied: false,
    cancel_reason: "",
    cancelled_by: "",
    created_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });

  const batch = db.batch();
  for (const castId of cast_ids) {
    const notifRef = db.collection("users").doc(castId).collection("notifications").doc();
    batch.set(notifRef, {
      type: "matching",
      title: "新しいリクエストが届きました",
      body: `${userData.nickname} さんからリクエストが届きました。`,
      data: { res_id: resId, guest_id: uid },
      read: false,
      created_at: Timestamp.now(),
    });
  }
  await batch.commit();

  return {
    success: true,
    res_id: resId,
    total_amount: totalAmount,
    transport_fee: transportFee,
    staff_fee: staffFeeTotal,
  };
});

/**
 * Callable: Cast accepts/declines reservation
 * キャストによる予約承諾・辞退
 */
export const respondToReservation = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, accept } = request.data;
  const uid = request.auth.uid;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  if (!resData.cast_ids.includes(uid)) {
    throw new HttpsError("permission-denied", "この予約の対象キャストではありません。");
  }

  if (!["authorized", "cast_pending"].includes(resData.status)) {
    throw new HttpsError(
      "failed-precondition",
      "この予約はすでに処理されています。"
    );
  }

  if (accept) {
    await db.collection("reservations").doc(res_id).update({
      status: "confirmed",
      updated_at: Timestamp.now(),
    });

    const chatRef = db.collection("chat_rooms").doc();
    await chatRef.set({
      room_id: chatRef.id,
      res_id,
      participants: [resData.guest_id, ...resData.cast_ids],
      active: true,
      created_at: Timestamp.now(),
      closed_at: null,
    });

    await db
      .collection("users")
      .doc(resData.guest_id)
      .collection("notifications")
      .add({
        type: "matching",
        title: "リクエストが承諾されました！",
        body: "キャストがリクエストを承諾しました。チャットが利用可能になりました。",
        data: { res_id, chat_room_id: chatRef.id },
        read: false,
        created_at: Timestamp.now(),
      });

    if (resData.group_invite && resData.group_size > 0) {
      await db.collection("work_posts").add({
        poster_id: uid,
        res_id,
        type: "partner_recruit",
        description: `グループお誘い: ${resData.group_size}名募集`,
        date: resData.date,
        location: resData.location,
        fee: 0,
        status: "open",
        applicants: [],
        selected_id: "",
        created_at: Timestamp.now(),
      });
    }

    // Auto-create staff job posts for whichever roles the guest flagged as
    // needed at booking time (needs_security/needs_transport,
    // createReservation) — same auto-post pattern as group_invite above,
    // poster_id is the accepting cast (they're the one working this job
    // and best placed to pick who joins them). The fee shown here is
    // informational only — the reservation's own staff_fee was already
    // computed and authorized at booking time from the flat role-level
    // config, this post doesn't change or duplicate that.
    const config = await getSystemConfig();
    if (resData.needs_security) {
      await db.collection("work_posts").add({
        poster_id: uid,
        res_id,
        type: "security",
        description: "警備スタッフ募集",
        date: resData.date,
        location: resData.location,
        fee: config.security_staff_fee,
        status: "open",
        applicants: [],
        selected_id: "",
        created_at: Timestamp.now(),
      });
    }
    if (resData.needs_transport) {
      await db.collection("work_posts").add({
        poster_id: uid,
        res_id,
        type: "transport",
        description: "送迎スタッフ募集",
        date: resData.date,
        location: resData.location,
        fee: config.transport_staff_fee,
        status: "open",
        applicants: [],
        selected_id: "",
        created_at: Timestamp.now(),
      });
    }

    return { success: true, message: "リクエストを承諾しました。", chat_room_id: chatRef.id };
  } else {
    await db.collection("reservations").doc(res_id).update({
      status: "cancelled",
      cancel_reason: "キャストが辞退しました",
      cancelled_by: "cast",
      updated_at: Timestamp.now(),
    });

    if (resData.payment_intent_id) {
      try {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      } catch (err) {
        console.error("Failed to cancel PaymentIntent:", err);
      }
    }

    await db
      .collection("users")
      .doc(resData.guest_id)
      .collection("notifications")
      .add({
        type: "matching",
        title: "リクエストが辞退されました",
        body: "キャストがリクエストを辞退しました。他のキャストをお探しください。",
        data: { res_id },
        read: false,
        created_at: Timestamp.now(),
      });

    return { success: true, message: "リクエストを辞退しました。" };
  }
});

/**
 * Callable: Confirm meetup (合流確認)
 */
export const confirmMeetup = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;
  const uid = request.auth.uid;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;
  const isGuest = uid === resData.guest_id;
  const isCast = resData.cast_ids?.includes(uid);

  if (!isGuest && !isCast) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  const confirmField = isGuest ? "guest_confirmed_meetup" : "cast_confirmed_meetup";

  await db.collection("reservations").doc(res_id).update({
    [confirmField]: true,
    updated_at: Timestamp.now(),
  });

  const updatedDoc = await db.collection("reservations").doc(res_id).get();
  const updatedData = updatedDoc.data()!;

  if (updatedData.guest_confirmed_meetup && updatedData.cast_confirmed_meetup) {
    await db.collection("reservations").doc(res_id).update({
      status: "in_progress",
      updated_at: Timestamp.now(),
    });
    return { success: true, message: "交流が開始されました。", both_confirmed: true };
  }

  return { success: true, message: "合流確認を送信しました。", both_confirmed: false };
});

/**
 * Callable: Cast reports completion (完了報告)
 */
export const reportCompletion = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;
  const uid = request.auth.uid;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  if (!resData.cast_ids?.includes(uid)) {
    throw new HttpsError("permission-denied", "キャストのみ完了報告が可能です。");
  }

  if (resData.status !== "in_progress") {
    throw new HttpsError(
      "failed-precondition",
      "この予約は完了報告できる状態ではありません。"
    );
  }

  await db.collection("reservations").doc(res_id).update({
    status: "completion_pending",
    updated_at: Timestamp.now(),
  });

  // FIX (IMPLEMENTATION_PLAN.md §6 defect #8): §3.5's own state-6 entry
  // trigger is literally "cast completion report triggers Capture" - the
  // reference tree set `completion_pending` above and then never called
  // Capture at all, so a reservation could sit here forever with nothing
  // to retry it. Trigger Capture right here, in the same flow, instead of
  // leaving it to chance. This does NOT flip status to `review_pending`
  // itself - that transition stays webhook-driven (§6 defect #7's
  // `handlePaymentIntentSucceeded`), so a Capture that succeeds here only
  // takes effect once Stripe confirms it. If the Capture call itself
  // fails (network error, PI already in a bad state), it's caught and
  // logged, not thrown - the cast's completion report must not fail
  // because of a downstream Stripe issue, and the reservation stays
  // visible at `completion_pending` for `autoCompleteReviews`'s
  // safety-net retry below to pick up.
  if (resData.payment_intent_id) {
    try {
      await stripe.paymentIntents.capture(resData.payment_intent_id);
    } catch (err) {
      console.error(`Capture-on-completion-report failed for ${res_id}:`, err);
    }
  } else {
    console.error(`Reservation ${res_id} reached completion_pending with no payment_intent_id.`);
  }

  await db
    .collection("users")
    .doc(resData.guest_id)
    .collection("notifications")
    .add({
      type: "matching",
      title: "交流が完了しました",
      body: "キャストが完了報告をしました。評価をお願いします。",
      data: { res_id },
      read: false,
      created_at: Timestamp.now(),
    });

  return { success: true, message: "完了報告を送信しました。" };
});

/**
 * Callable: Submit review (評価送信)
 */
export const submitReview = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, cast_id, rating, comment } = request.data;
  const uid = request.auth.uid;

  if (!rating || rating < 1 || rating > 5) {
    throw new HttpsError("invalid-argument", "評価は1-5の範囲で入力してください。");
  }

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  if (uid !== resData.guest_id) {
    throw new HttpsError("permission-denied", "ゲストのみ評価可能です。");
  }

  await db.collection("reviews").add({
    res_id,
    reviewer_id: uid,
    reviewee_id: cast_id,
    rating,
    comment: comment || "",
    created_at: Timestamp.now(),
  });

  await db.collection("reservations").doc(res_id).update({
    status: "completed",
    updated_at: Timestamp.now(),
  });

  const chatRooms = await db.collection("chat_rooms").where("res_id", "==", res_id).get();
  for (const room of chatRooms.docs) {
    await room.ref.update({
      active: false,
      closed_at: Timestamp.now(),
    });
  }

  await db.collection("users").doc(cast_id).collection("notifications").add({
    type: "matching",
    title: "評価が届きました",
    body: `★${rating} の評価が届きました。`,
    data: { res_id, rating },
    read: false,
    created_at: Timestamp.now(),
  });

  // Phase 3 of implementing the 5 unresolved §17.9 conflicts (C4):
  // "capture-vs-transfer moment" - the cast's own reward Transfer (not
  // the ledger bookkeeping, which already happened at Capture time in
  // `capturePayment`) now executes HERE, at guest-review time, matching
  // the キャストユーザー機能・管理.pdf wallet section ("after guest review,
  // cast reward ... to Connected Account immediately"). See
  // `transferPendingCastRewards`'s own doc comment (stripe-payments.ts)
  // and PROJECT_KNOWLEDGE.md §18.111 for the full account. Deliberately
  // does not throw on failure (see that function's own doc comment) - a
  // Stripe transfer problem must never prevent the review itself from
  // being recorded, which has already fully happened by this point.
  await transferPendingCastRewards(res_id);

  return { success: true, message: "評価を送信しました。" };
});

/**
 * Scheduled: Auto-cancel expired authorizations
 * 24時間経過後の自動キャンセル
 */
export const autoCancelExpiredAuth = onSchedule("every 1 hours", async () => {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 24);

  const expired = await db
    .collection("reservations")
    .where("status", "in", ["authorized", "cast_pending"])
    .where("created_at", "<", Timestamp.fromDate(cutoff))
    .get();

  for (const doc of expired.docs) {
    const resData = doc.data();
    console.log(`Auto-cancelling expired reservation: ${doc.id}`);

    try {
      if (resData.payment_intent_id) {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }

      await doc.ref.update({
        status: "expired",
        cancel_reason: "24時間以内に承諾されなかったため自動キャンセル",
        updated_at: Timestamp.now(),
      });
    } catch (err) {
      console.error(`Failed to auto-cancel ${doc.id}:`, err);
    }
  }
});

/**
 * Scheduled: chat-close timing enforcement (Phase 1 feature, resolves
 * PROJECT_KNOWLEDGE.md §17.9 C2 — the client's own spec docs disagreed:
 * アプリ仕様書 says chat closes after a configurable `chat_close_sec` timer;
 * キャストユーザー機能・管理.pdf says chat closes IMMEDIATELY once both
 * 完了報告 and the guest's review are submitted. Resolved as a hybrid,
 * confirmed with the client: immediate-on-both-done is the primary path
 * (already correct — `submitReview` above closes `chat_rooms` the instant
 * a review lands, right after 完了報告 already moved the reservation past
 * `in_progress`), and this scheduled sweep is the timer as a SAFETY NET
 * for whichever half of "both" never happens.
 *
 * `chat_close_sec` is read via `getSystemConfig()`. (Previously this read
 * the raw `system_config/settings` document directly, working around a
 * `SYSTEM_DEFAULTS` key-casing bug in `getSystemConfig()` that silently
 * discarded every admin-configured value project-wide — see config.ts.
 * That bug is now fixed, so the direct-read workaround is no longer
 * needed here or at the other call sites that had it.)
 *
 * Covers two stalled states, both timed from `updated_at` (the timestamp
 * of the transition into that status — nothing else touches a
 * reservation while it sits in either state under the normal flow):
 * - `review_pending` (capture done, guest never reviewed): original
 *   behavior preserved — marks the reservation `completed` in addition
 *   to closing chat, just with the timeout now admin-configurable
 *   instead of a hardcoded 24h.
 * - `completion_pending` (cast reported completion; Capture should have
 *   already fired inline from `reportCompletion` — see that function's
 *   own comment on §6 defect #8). FIX (§6 defect #8): this block used to
 *   close chat only and explicitly leave the missing-Capture gap
 *   unaddressed ("out of scope here"). It's no longer out of scope: a
 *   reservation still sitting here past the timeout means the inline
 *   attempt either never ran (a crash between the status write and the
 *   Capture call) or failed (a transient Stripe error) — this is the
 *   retry safety net for exactly that case, reusing `chat_close_sec` as
 *   the stall timeout since no dedicated config value exists for this.
 *   Still doesn't touch reservation status itself either way — that stays
 *   webhook-driven per §6 defect #7, same as the inline attempt.
 */
export const autoCompleteReviews = onSchedule("every 1 hours", async () => {
  const config = await getSystemConfig();
  const chatCloseSec = config.chat_close_sec;

  const cutoff = Timestamp.fromDate(new Date(Date.now() - chatCloseSec * 1000));

  const closeChatRoomsFor = async (resId: string) => {
    const chatRooms = await db.collection("chat_rooms").where("res_id", "==", resId).get();
    for (const room of chatRooms.docs) {
      await room.ref.update({ active: false, closed_at: Timestamp.now() });
    }
  };

  const reviewPending = await db
    .collection("reservations")
    .where("status", "==", "review_pending")
    .where("updated_at", "<", cutoff)
    .get();

  for (const doc of reviewPending.docs) {
    console.log(`Auto-completing reservation (chat_close_sec=${chatCloseSec}): ${doc.id}`);
    await doc.ref.update({
      status: "completed",
      updated_at: Timestamp.now(),
    });
    await closeChatRoomsFor(doc.id);
    // Phase 3 (§17.9 C4, PROJECT_KNOWLEDGE.md §18.111): this is the
    // timeout-fallback path to "完了" (the app's own state machine:
    // "guest review OR 24h auto batch") - the cast reward Transfer that
    // normally executes in `submitReview` on an explicit review must
    // ALSO execute here for a guest who never reviews, or a cast whose
    // reward would otherwise stay "pending" (ledger-recorded at Capture
    // time, per `capturePayment`) forever. Only reachable for
    // `review_pending` (capture already happened) - never for
    // `completion_pending` below, which never went through Capture at
    // all, so there is nothing pending in `ledger` to transfer yet.
    await transferPendingCastRewards(doc.id);
  }

  const completionPending = await db
    .collection("reservations")
    .where("status", "==", "completion_pending")
    .where("updated_at", "<", cutoff)
    .get();

  for (const doc of completionPending.docs) {
    const resData = doc.data();
    console.log(
      `Stalled completion_pending reservation (chat_close_sec=${chatCloseSec}): ${doc.id}`
    );

    if (resData.payment_intent_id) {
      try {
        await stripe.paymentIntents.capture(resData.payment_intent_id);
        console.log(`Retry-captured stalled reservation: ${doc.id}`);
      } catch (err) {
        console.error(`Retry capture failed for stalled reservation ${doc.id}:`, err);
      }
    } else {
      console.error(
        `Stalled completion_pending reservation ${doc.id} has no payment_intent_id — cannot capture, needs manual admin review.`
      );
    }

    await closeChatRoomsFor(doc.id);
  }
});

/**
 * Callable: Send a chat message (マッチャチャット送信)
 * Posting-lock (§3.5.8a) is enforced here via `chat_rooms.active`, which
 * `respondToReservation` sets true at room creation (§3.5.7's open trigger)
 * and `submitReview`/`autoCompleteReviews` both flip false (§3.5.8's two
 * distinct close triggers - instant-on-both-done and timer-based). No
 * separate posting-lock field needed: every path that should block new
 * messages already flips this same flag, and no code path flips it false
 * without also intending "no further activity in this room."
 */
export const sendChatMessage = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id, text } = request.data;
  const uid = request.auth.uid;

  if (typeof text !== "string" || !text.trim()) {
    throw new HttpsError("invalid-argument", "メッセージを入力してください。");
  }

  const roomSnap = await db.collection("chat_rooms").where("res_id", "==", res_id).limit(1).get();
  if (roomSnap.empty) {
    throw new HttpsError("not-found", "チャットルームが見つかりません。");
  }

  const roomDoc = roomSnap.docs[0];
  const roomData = roomDoc.data();

  if (!roomData.participants?.includes(uid)) {
    throw new HttpsError("permission-denied", "このチャットの参加者ではありません。");
  }

  if (!roomData.active) {
    throw new HttpsError("failed-precondition", "このチャットはすでに終了しています。");
  }

  const trimmed = text.trim().substring(0, 1000);
  const now = Timestamp.now();

  await roomDoc.ref.collection("messages").add({
    sender_id: uid,
    text: trimmed,
    created_at: now,
  });

  await roomDoc.ref.update({
    last_message: trimmed,
    last_message_time: now,
  });

  return { success: true };
});

/**
 * Callable: Get a single chat room's display info for the given reservation
 * (counterpart nickname/photo + open/closed state) - resolving the OTHER
 * participant's profile requires the Admin SDK, since `users/{uid}`'s own
 * security rule is identity-only (§33's own lesson: a client can only ever
 * read its own user doc, never another user's, regardless of query shape).
 */
export const getChatRoomInfo = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;
  const uid = request.auth.uid;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  const resData = resDoc.data()!;
  const isGuest = resData.guest_id === uid;
  const isCast = resData.cast_ids?.includes(uid);
  if (!isGuest && !isCast) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  const counterpartId = isGuest ? resData.cast_ids?.[0] || "" : resData.guest_id;
  let counterpartNickname = "";
  let counterpartPhoto = "";
  if (counterpartId) {
    const counterpartDoc = await db.collection("users").doc(counterpartId).get();
    if (counterpartDoc.exists) {
      counterpartNickname = counterpartDoc.data()?.nickname || "";
      counterpartPhoto = counterpartDoc.data()?.profile_image_url || "";
    }
  }

  const roomSnap = await db.collection("chat_rooms").where("res_id", "==", res_id).limit(1).get();
  const roomExists = !roomSnap.empty;
  const active = roomExists ? roomSnap.docs[0].data().active === true : false;

  return {
    success: true,
    room_exists: roomExists,
    active,
    counterpart_nickname: counterpartNickname,
    counterpart_photo: counterpartPhoto,
  };
});

/**
 * Callable: Get my full マッチャ (match/chat) list across all 5 history
 * categories (§3.5.9) - すべて/新しい/未交流/交流済み/断られた. Category is
 * derived from reservation status (not chat_room state alone), since
 * "断られたマッチャ" (declined) and "新しいマッチャ" (newly requested) both
 * cover reservations that never had - or never will have - an open chat
 * room at all. Mapping, confirmed against the real status values this
 * backend actually writes (`respondToReservation`/`confirmMeetup`/
 * `reportCompletion`/webhook/`submitReview`), not invented:
 *   new          - request_pending, authorized, cast_pending (sent, awaiting
 *                  Stripe auth or cast response)
 *   not_interacted - confirmed (chat open, meetup not yet started)
 *   interacted   - in_progress, completion_pending, review_pending, completed
 *   declined     - cancelled (any `cancelled_by` - cast/guest/admin, or none
 *                  at all for the payment-failed webhook path) OR expired.
 *                  REVIEW-PASS FIX (2026-08-11): originally scoped to
 *                  `cancelled_by == "cast"` only, on the assumption that was
 *                  the sole cancellation path - a broader sweep of every
 *                  `reservations.status` write site found 3 more
 *                  (`cancelPayment`'s guest/cast fee-matrix path,
 *                  `adminForceCancel`'s "admin", and
 *                  `handlePaymentIntentFailed`'s no-`cancelled_by`-at-all
 *                  webhook path) plus a separate `status: "expired"` write
 *                  (`autoCancelExpiredAuth`), none of which the original
 *                  condition matched - all fell through to the "new" default,
 *                  meaning a cancelled-by-guest, admin-force-cancelled,
 *                  payment-failed, or timed-out-expired reservation
 *                  incorrectly showed up under "新しい" (new) instead of
 *                  anywhere resembling "this didn't happen". §3.5.9 only
 *                  specifies 5 fixed categories with no dedicated
 *                  cancelled/expired bucket, so from the guest's own
 *                  perspective every terminal "didn't happen" outcome is
 *                  folded into "断られた" (declined) - the closest existing
 *                  category, not a literal "cast declined" reading. Confirmed
 *                  with the client is the one thing NOT done here (no
 *                  mechanism to ask this session), so this is disclosed as
 *                  an interpretation, not silently assumed correct forever.
 * Counterpart nickname/photo resolution is the same Admin-SDK-required need
 * as `getChatRoomInfo` above, just batched across every reservation instead
 * of one.
 */
export const getMyMatchaList = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  const uid = request.auth.uid;

  const guestDocs = await db.collection("reservations").where("guest_id", "==", uid).get();
  const castDocs = await db.collection("reservations").where("cast_ids", "array-contains", uid).get();

  const merged = new Map<string, FirebaseFirestore.DocumentData>();
  guestDocs.docs.forEach((d) => merged.set(d.id, d.data()));
  castDocs.docs.forEach((d) => merged.set(d.id, d.data()));

  const items = await Promise.all(
    Array.from(merged.entries()).map(async ([resId, data]) => {
      const isGuest = data.guest_id === uid;
      const counterpartId = isGuest ? data.cast_ids?.[0] || "" : data.guest_id;

      let counterpartNickname = "";
      let counterpartPhoto = "";
      if (counterpartId) {
        const counterpartDoc = await db.collection("users").doc(counterpartId).get();
        if (counterpartDoc.exists) {
          counterpartNickname = counterpartDoc.data()?.nickname || "";
          counterpartPhoto = counterpartDoc.data()?.profile_image_url || "";
        }
      }

      let category = "new";
      if (["request_pending", "authorized", "cast_pending"].includes(data.status)) {
        category = "new";
      } else if (data.status === "confirmed") {
        category = "not_interacted";
      } else if (
        ["in_progress", "completion_pending", "review_pending", "completed"].includes(data.status)
      ) {
        category = "interacted";
      } else if (data.status === "cancelled" || data.status === "expired") {
        category = "declined";
      }

      const roomSnap = await db.collection("chat_rooms").where("res_id", "==", resId).limit(1).get();
      let roomActive = false;
      let lastMessage = "";
      let sortTimeMs = data.updated_at?.toMillis?.() || data.created_at?.toMillis?.() || 0;
      if (!roomSnap.empty) {
        const roomData = roomSnap.docs[0].data();
        roomActive = roomData.active === true;
        lastMessage = roomData.last_message || "";
        const lastMsgMs = roomData.last_message_time?.toMillis?.() || 0;
        if (lastMsgMs > 0) sortTimeMs = lastMsgMs;
      }

      return {
        res_id: resId,
        category,
        counterpart_nickname: counterpartNickname,
        counterpart_photo: counterpartPhoto,
        room_active: roomActive,
        last_message: lastMessage,
        sort_time_ms: sortTimeMs,
      };
    })
  );

  items.sort((a, b) => b.sort_time_ms - a.sort_time_ms);

  return { success: true, items };
});
