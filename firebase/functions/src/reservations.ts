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

  const staffFee = 0;
  const totalAmount = base_amount + transportFee + staffFee;

  const resRef = db.collection("reservations").doc();
  const resId = resRef.id;

  await resRef.set({
    res_id: resId,
    guest_id: uid,
    cast_ids,
    staff_ids: [],
    status: "request_pending",
    date: Timestamp.fromDate(new Date(date)),
    time_slot,
    duration_minutes,
    location: location || "",
    meeting_point: meeting_point || "",
    group_invite: group_invite || false,
    group_size: group_size || 0,
    details: details || "",
    base_amount,
    transport_fee: transportFee,
    staff_fee: staffFee,
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

  await db.collection("reservations").doc(res_id).update({
    status: "completion_pending",
    updated_at: Timestamp.now(),
  });

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
 * - `completion_pending` (cast reported completion, capture never
 *   happened): NEW coverage. Closes chat only — does NOT touch
 *   reservation/payment status. A capture that never happens is a
 *   separate, pre-existing gap (not covered by `autoCancelExpiredAuth`
 *   either, which only handles `authorized`/`cast_pending`) — out of
 *   scope here; only the chat's own "won't stay open forever" promise
 *   from the App Spec is being honored.
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
    console.log(
      `Auto-closing chat for stalled completion_pending reservation (chat_close_sec=${chatCloseSec}): ${doc.id}`
    );
    await closeChatRoomsFor(doc.id);
  }
});
