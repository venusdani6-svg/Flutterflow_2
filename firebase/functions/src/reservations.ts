/**
 * Reservation Management Cloud Functions
 * 予約管理
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, stripe, Timestamp, getSystemConfig, sendPushNotification } from "./config";
import { transferPendingCastRewards, captureAuthorizedExtensions } from "./stripe-payments";
import { findUnavailableCastId, reservedSlotsQuery } from "./schedule";

// DoS-prevention bound only, not a product rule (PROJECT_KNOWLEDGE.md §68):
// the DSL only ever sends a single cast_id today, but this callable accepts
// an arbitrary array — cast_ids.length × (duration_minutes/30) becomes the
// number of writes in the Authorize-time slot-lock transaction
// (stripe-webhooks.ts), and Firestore hard-caps a transaction at 500
// writes. Generously above any real group-invite scenario, far below that
// ceiling even at the max allowed duration.
const MAX_CAST_IDS_PER_RESERVATION = 10;

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
  if (cast_ids.length > MAX_CAST_IDS_PER_RESERVATION) {
    throw new HttpsError("invalid-argument", "選択できるキャストの人数が上限を超えています。");
  }
  // FIX (PROJECT_KNOWLEDGE.md §68, found in self-review): duplicate entries
  // in cast_ids were never rejected or deduped — beyond the pre-existing
  // cosmetic issue (a duplicated cast gets the "new request" notification
  // twice, below), this became a real crash risk once Authorize-time
  // locking (stripe-webhooks.ts) started building one schedule_slots doc
  // ref per {cast_id × slot}: a duplicate cast_id produces a duplicate ref,
  // and writing to the same document twice within one Firestore
  // transaction is unsafe territory this codebase has no reason to
  // exercise. Deduping here — not just defensively inside
  // buildReservationSlotRefs (schedule.ts also dedupes, for callers that
  // don't go through this validation) — closes it at the source, so
  // `cast_ids` never contains a duplicate anywhere downstream in this
  // function either (the per-cast validation loop, notifications, the
  // reservation doc itself).
  const castIds: string[] = [...new Set(cast_ids as string[])];

  // FIX (confirmed live bug, found during audit): none of these required
  // fields were validated for presence/type before use. `Timestamp.
  // fromDate(new Date(date))` a few lines below throws SYNCHRONOUSLY
  // (before any Firestore write) if `date` is missing/unparseable (`new
  // Date(undefined)` -> Invalid Date -> NaN), and Firestore's Admin SDK
  // rejects literal `undefined` values in document writes by default -
  // both cases surfaced as an opaque `HttpsError('internal', 'INTERNAL')`
  // (onCall's default wrapper for non-HttpsError throws) instead of a
  // clean validation message, for the single most important function in
  // this file. `time_slot`/`base_amount` specifically also feed
  // downstream calculations (`nightTimeSlots.includes(time_slot)`,
  // `total_amount = base_amount + ...`) that don't throw on bad input
  // (`.includes(undefined)` just returns false; `undefined + number` is
  // `NaN`) but would silently write a corrupted/incorrect reservation
  // rather than reject the request - validated explicitly here instead.
  if (typeof date !== "string" && typeof date !== "number") {
    throw new HttpsError("invalid-argument", "日付が必要です。");
  }
  const requestedStart = new Date(date);
  if (isNaN(requestedStart.getTime())) {
    throw new HttpsError("invalid-argument", "日付の形式が不正です。");
  }
  // FIX (PROJECT_KNOWLEDGE.md §68): the client always sends a 30-min-
  // aligned start (resStartTime's dropdown only ever offers :00/:30
  // values), but nothing server-side enforced it — a direct-callable
  // caller could send an unaligned instant, which the slot-locking math in
  // stripe-webhooks.ts would silently floor into the wrong leading slot.
  // Checked in UTC, matching this codebase's own established "Cloud
  // Functions run in UTC" fact (affiliate.ts) and parseDayStart's own
  // convention (schedule.ts).
  if (
    requestedStart.getUTCMinutes() % 30 !== 0 ||
    requestedStart.getUTCSeconds() !== 0 ||
    requestedStart.getUTCMilliseconds() !== 0
  ) {
    throw new HttpsError("invalid-argument", "予約時刻は30分単位で指定してください。");
  }
  if (typeof time_slot !== "string" || !time_slot) {
    throw new HttpsError("invalid-argument", "時間帯が必要です。");
  }
  if (typeof duration_minutes !== "number" || duration_minutes <= 0) {
    throw new HttpsError("invalid-argument", "利用時間が必要です。");
  }
  // FIX (PROJECT_KNOWLEDGE.md §68): an unbounded duration_minutes could,
  // combined with cast_ids.length, exceed Firestore's 500-writes-per-
  // transaction cap at Authorize-time slot-locking (stripe-webhooks.ts).
  // Reuses the existing max_total_hours config already used by the
  // extension-payment flow (config.ts) rather than inventing a separate
  // limit for the same real-world constraint.
  if (duration_minutes % 30 !== 0) {
    throw new HttpsError("invalid-argument", "利用時間は30分単位で指定してください。");
  }
  if (typeof base_amount !== "number" || isNaN(base_amount) || base_amount <= 0) {
    throw new HttpsError("invalid-argument", "金額が必要です。");
  }

  for (const castId of castIds) {
    if (typeof castId !== "string" || !castId) {
      throw new HttpsError("invalid-argument", "キャストIDが不正です。");
    }
    const castDoc = await db.collection("users").doc(castId).get();
    // FIX (confirmed live bug, found during audit): this loop checked
    // existence/approval_status/is_frozen/blocked_users but never
    // `account_type === "cast"` - `approval_status` is a shared field
    // present on every user doc regardless of type (confirmed by the
    // guest check a few lines above, which reads the exact same field on
    // the CALLER's own guest doc), so any approved, non-frozen, non-
    // blocking user - including another GUEST - passed every check here.
    // A guest could create a reservation naming another guest as the
    // "cast", triggering spurious notifications and letting that guest's
    // account drive the reservation through respondToReservation/
    // confirmMeetup/reportCompletion (all of which authorize purely via
    // `cast_ids.includes(uid)`, with no account_type check of their own)
    // entirely outside the guest<->cast business model.
    if (
      !castDoc.exists ||
      castDoc.data()?.account_type !== "cast" ||
      castDoc.data()?.approval_status !== "approved"
    ) {
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

  if (duration_minutes > config.max_total_hours * 60) {
    throw new HttpsError(
      "invalid-argument",
      `利用時間は最大${config.max_total_hours}時間までです。`
    );
  }

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

  // Guest-side booking validation against availability (PROJECT_KNOWLEDGE.md
  // §68) — advisory, not the authoritative enforcement (that's the
  // transactional lock in stripe-webhooks.ts's handleAmountCapturableUpdated,
  // which runs at the moment funds are actually held). This exists purely
  // to give a guest fast, friendly feedback before they ever reach the
  // payment sheet, for the common case where a cast has already blocked or
  // is already booked for the requested window. Runs after all cast/staff
  // validation above so every cast_id here is confirmed real.
  const unavailableCastId = await findUnavailableCastId(castIds, requestedStart, duration_minutes);
  if (unavailableCastId) {
    throw new HttpsError(
      "failed-precondition",
      "選択した時間帯はご利用いただけません。別の日時をお選びください。"
    );
  }

  const resRef = db.collection("reservations").doc();
  const resId = resRef.id;

  // FIX (§3.5.9/§3.6.7 — per-cast independent accept/decline, PROJECT_KNOWLEDGE.md
  // §71/§72): every cast_id starts "pending". Used by respondToReservation
  // below to require ALL invited casts to accept before a multi-cast
  // reservation (bulk-invite from Favorites, or a direct multi-cast invite)
  // finalizes as confirmed — degenerates to today's exact single-cast
  // behavior when cast_ids.length === 1 (one accept already satisfies
  // "every cast_id has accepted").
  const castResponses: Record<string, "pending" | "accepted" | "declined"> = {};
  for (const id of castIds) {
    castResponses[id] = "pending";
  }

  await resRef.set({
    res_id: resId,
    guest_id: uid,
    cast_ids: castIds,
    staff_ids: staffIds,
    status: "request_pending",
    cast_responses: castResponses,
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
  for (const castId of castIds) {
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
  // Real device push, alongside the in-app notification batch above (see
  // sendPushNotification's own doc comment, config.ts) — best-effort,
  // never blocks the reservation-creation response.
  await Promise.all(
    castIds.map((castId) =>
      sendPushNotification(
        castId,
        "新しいリクエストが届きました",
        `${userData.nickname} さんからリクエストが届きました。`,
        { res_id: resId, type: "matching" }
      )
    )
  );

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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }
  // FIX (confirmed live bug, found during audit): `accept` was only ever
  // checked with bare JS truthiness (`if (accept)` below) - Cloud
  // Functions are directly callable with arbitrary JSON, so a non-boolean
  // payload like `accept: "false"` (a non-empty, and therefore truthy,
  // string) would silently take the ACCEPT branch despite its content
  // saying otherwise, flipping a cast's intended decline into an accept.
  if (typeof accept !== "boolean") {
    throw new HttpsError("invalid-argument", "acceptはtrue/falseで指定してください。");
  }

  // FIX (confirmed live bug, comprehensive review): the status guard
  // (below) and the status-transition write were two separate,
  // non-transactional operations — two near-simultaneous `respondToReservation`
  // calls for the same reservation (double-tap, or a client retry) could
  // both read the same pre-transition status and both pass the guard
  // before either write landed, then both proceed to create a fresh
  // `chat_rooms` doc (auto-ID, not idempotent) and duplicate `work_posts`
  // entries. Wrapped the read-check-write in a transaction so only ONE
  // caller can ever win the status transition; the loser sees the
  // already-updated status and fails the guard, exactly as if it had
  // arrived after the first call actually finished.
  //
  // FIX (§3.5.9/§3.6.7 — per-cast independent accept/decline,
  // PROJECT_KNOWLEDGE.md §71/§72): this used to let WHICHEVER cast_id
  // responded FIRST decide the fate of the entire reservation, immediately
  // — a real bug for any multi-cast reservation (bulk-invite from
  // Favorites, or a direct multi-cast invite): one cast tapping "accept"
  // instantly confirmed the booking (creating the chat room / work-post
  // side effects) before the OTHER invited casts had any chance to
  // respond, and one cast tapping "decline" cancelled it out from under
  // everyone else. Now tracks each cast's own response in
  // `cast_responses` (initialized to all-"pending" at creation,
  // createReservation above) and only finalizes once the group's fate is
  // actually decided: ANY decline still cancels immediately (matches
  // today's behavior exactly — a "group" session can't proceed without
  // every invited cast), but an accept only finalizes to "confirmed" once
  // EVERY invited cast has accepted. For the overwhelming common case
  // (`cast_ids.length === 1`), this is a no-op change: one cast's own
  // accept already satisfies "every cast_id has accepted," so a
  // single-cast reservation confirms exactly as immediately as before.
  // "Can change the decision later" (§3.6.7's own wording) falls out for
  // free: the status guard below only blocks calls once the GROUP has
  // finalized (confirmed/cancelled) — while still "authorized"/
  // "cast_pending", any cast can call this again to overwrite their own
  // prior entry in `cast_responses`.
  const { data: resData, outcome } = await db.runTransaction(async (tx) => {
    const resRef = db.collection("reservations").doc(res_id);
    const resSnap = await tx.get(resRef);
    if (!resSnap.exists) {
      throw new HttpsError("not-found", "予約が見つかりません。");
    }

    const data = resSnap.data()!;

    if (!data.cast_ids?.includes(uid)) {
      throw new HttpsError("permission-denied", "この予約の対象キャストではありません。");
    }

    if (!["authorized", "cast_pending"].includes(data.status)) {
      throw new HttpsError(
        "failed-precondition",
        "この予約はすでに処理されています。"
      );
    }

    const castIds: string[] = data.cast_ids || [];
    // Defensive fallback to `{}` for any reservation created before this
    // field existed — degenerates correctly (this cast's own entry is all
    // that ends up populated, and for the single-cast case that alone
    // already satisfies "every cast_id has accepted" below).
    const castResponses: Record<string, string> = {
      ...(data.cast_responses || {}),
      [uid]: accept ? "accepted" : "declined",
    };
    const anyDeclined = Object.values(castResponses).includes("declined");
    const allAccepted =
      castIds.length > 0 && castIds.every((id) => castResponses[id] === "accepted");

    const groupOutcome: "confirmed" | "cancelled" | "waiting" = anyDeclined
      ? "cancelled"
      : allAccepted
        ? "confirmed"
        : "waiting";

    // Slot-lock release (PROJECT_KNOWLEDGE.md §68), folded into this SAME
    // transaction rather than called after it commits — an orphaned
    // "reserved" schedule_slots doc has no self-healing path, unlike the
    // Stripe hold this branch also releases below (a stale hold there just
    // self-expires in ~7 days). Read before the write (reads-before-writes
    // is a hard Firestore transaction requirement) but only actually
    // deleted when the GROUP resolves to cancelled — an accepted (or
    // still-waiting-on-others) reservation must keep its slots reserved.
    const slotsSnap =
      groupOutcome === "cancelled" ? await tx.get(reservedSlotsQuery(res_id)) : null;

    tx.update(resRef, {
      cast_responses: castResponses,
      ...(groupOutcome === "waiting"
        ? {}
        : {
            status: groupOutcome === "confirmed" ? "confirmed" : "cancelled",
            ...(groupOutcome === "cancelled"
              ? { cancel_reason: "キャストが辞退しました", cancelled_by: "cast" }
              : {}),
          }),
      updated_at: Timestamp.now(),
    });
    if (slotsSnap) {
      slotsSnap.forEach((doc) => tx.delete(doc.ref));
    }

    return { data, outcome: groupOutcome };
  });

  if (outcome === "waiting") {
    // Not yet finalized — some invited casts (or this one, having just
    // accepted) are still pending. No chat room / work-post side effects
    // yet; those only fire once the group actually resolves to confirmed.
    await db
      .collection("users")
      .doc(resData.guest_id)
      .collection("notifications")
      .add({
        type: "matching",
        title: "キャストが承諾しました",
        body: "一部のキャストがリクエストを承諾しました。他のキャストの返答をお待ちください。",
        data: { res_id },
        read: false,
        created_at: Timestamp.now(),
      });
    await sendPushNotification(
      resData.guest_id,
      "キャストが承諾しました",
      "一部のキャストがリクエストを承諾しました。他のキャストの返答をお待ちください。",
      { res_id, type: "matching" }
    );
    return { success: true, message: "承諾しました。他のキャストの返答をお待ちください。" };
  }

  if (outcome === "confirmed") {
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
    await sendPushNotification(
      resData.guest_id,
      "リクエストが承諾されました！",
      "キャストがリクエストを承諾しました。チャットが利用可能になりました。",
      { res_id, chat_room_id: chatRef.id, type: "matching" }
    );

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
    // outcome === "cancelled" — the only remaining possibility here, since
    // "waiting" already returned above. Status transition (status:
    // "cancelled", cancel_reason, cancelled_by) already written atomically
    // inside the transaction above.
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
    await sendPushNotification(
      resData.guest_id,
      "リクエストが辞退されました",
      "キャストがリクエストを辞退しました。他のキャストをお探しください。",
      { res_id, type: "matching" }
    );

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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, LOW-MEDIUM — comprehensive project-wide
  // review): this used to be a plain read, a status guard against that
  // stale snapshot, an unconditional field update, then a SECOND plain
  // read + conditional status write — none of it transactional. If a
  // cancellation (cancelPayment/adminForceCancel/autoCancelExpiredAuth)
  // landed in the window between the first read and the writes, this
  // could still flip an already-cancelled reservation's status to
  // "in_progress" over a PaymentIntent that's already been
  // released/cancelled at Stripe. Money itself stays protected (Stripe
  // rejects capturing an already-canceled PaymentIntent, so
  // reportCompletion's later capture attempt fails loudly rather than
  // silently succeeding) but the reservation is left in a confusing,
  // stuck state needing manual admin cleanup. Wrapped the whole
  // read-check-write-reread-write sequence in one transaction, with a
  // fresh read, matching the fix already applied to respondToReservation
  // for the identical race shape.
  const result = await db.runTransaction(async (tx) => {
    const resRef = db.collection("reservations").doc(res_id);
    const resSnap = await tx.get(resRef);
    if (!resSnap.exists) {
      throw new HttpsError("not-found", "予約が見つかりません。");
    }

    const resData = resSnap.data()!;
    const isGuest = uid === resData.guest_id;
    const isCast = resData.cast_ids?.includes(uid);

    if (!isGuest && !isCast) {
      throw new HttpsError("permission-denied", "権限がありません。");
    }

    // §3.5 state 3→4 only makes sense from `confirmed` (合流待ち) —
    // calling this on an already-cancelled/completed reservation would
    // otherwise effectively reopen a closed reservation.
    if (resData.status !== "confirmed") {
      throw new HttpsError(
        "failed-precondition",
        "この予約は合流確認できる状態ではありません。"
      );
    }

    const confirmField = isGuest ? "guest_confirmed_meetup" : "cast_confirmed_meetup";
    const otherConfirmed = isGuest ? resData.cast_confirmed_meetup : resData.guest_confirmed_meetup;
    const bothConfirmed = otherConfirmed === true;

    tx.update(resRef, {
      [confirmField]: true,
      ...(bothConfirmed ? { status: "in_progress" } : {}),
      updated_at: Timestamp.now(),
    });

    return bothConfirmed;
  });

  if (result) {
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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }

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

  // FIX: any extension PaymentIntents authorized during this session were
  // never captured anywhere before (confirmed live bug, see
  // captureAuthorizedExtensions's own doc comment in stripe-payments.ts) -
  // capture them at the same natural moment as the main payment. Best-
  // effort, same reasoning as the main capture above: must not fail the
  // cast's completion report over a downstream Stripe issue.
  try {
    await captureAuthorizedExtensions(res_id, resData);
  } catch (err) {
    console.error(`Extension capture sweep failed for ${res_id}:`, err);
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
  await sendPushNotification(
    resData.guest_id,
    "交流が完了しました",
    "キャストが完了報告をしました。評価をお願いします。",
    { res_id, type: "matching" }
  );

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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }
  // FIX (confirmed live bug, found during audit): `!rating || rating < 1 ||
  // rating > 5` used bare comparisons, so a boolean `true` (coerces to 1)
  // or a numeric-looking STRING like "3" (coerces via `<`/`>`) both passed
  // this check and were stored verbatim as a non-number in the `reviews`
  // doc - a type nothing that averages/sums ratings elsewhere could
  // reconcile. Requires an actual number now.
  if (typeof rating !== "number" || !rating || rating < 1 || rating > 5) {
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

  // FIX (confirmed live bugs, found during audit): this callable had none
  // of the three checks below - a guest could review an arbitrary cast
  // never actually on this reservation (cast_id came straight from client
  // input, never checked against resData.cast_ids), could jump straight to
  // `completed` before any meetup/capture ever happened (no status guard),
  // and could call this repeatedly to spam/inflate a cast's rating (no
  // duplicate check).
  if (!resData.cast_ids?.includes(cast_id)) {
    throw new HttpsError("invalid-argument", "この予約に該当するキャストではありません。");
  }

  if (!["completion_pending", "review_pending"].includes(resData.status)) {
    throw new HttpsError(
      "failed-precondition",
      "この予約は評価できる状態ではありません。"
    );
  }

  // FIX (confirmed live bug, found during audit): this used to be scoped
  // to `res_id + reviewer_id` only - NOT `reviewee_id`/`cast_id`. Multi-
  // cast reservations are a real, supported feature (validated in
  // createReservation's cast_ids loop, and reportCompletion/confirmMeetup
  // both accept a call from ANY cast in the array) - but that meant the
  // guest's FIRST review call for ANY ONE cast on a multi-cast reservation
  // both (a) created a doc matching this exact-match check, permanently
  // blocking a second review call for a DIFFERENT cast on the SAME
  // reservation, and (b) flipped `reservations.status` to "completed"
  // unconditionally (below), which independently failed the status guard
  // above for any subsequent call regardless. Net effect: on a
  // reservation with 2+ casts, the guest could rate exactly one of them -
  // the others silently never received a review. Scoped to `reviewee_id`
  // too now, so each cast on the reservation gets its own independent
  // duplicate check.
  // FIX (confirmed live bug, comprehensive review): the duplicate check
  // (query) and the review write (`.add()`) were two separate,
  // non-transactional operations — two near-simultaneous submissions for
  // the same (res_id, reviewer_id, reviewee_id) could both pass the query
  // check before either write committed. Switched from an auto-ID `.add()`
  // to a deterministic doc ID + `.create()`, which Firestore rejects
  // atomically (ALREADY_EXISTS) if the doc already exists — a single-
  // document atomic operation, race-safe without needing a transaction.
  const reviewId = `${res_id}_${uid}_${cast_id}`;
  try {
    await db.collection("reviews").doc(reviewId).create({
      res_id,
      reviewer_id: uid,
      reviewee_id: cast_id,
      rating,
      comment: comment || "",
      created_at: Timestamp.now(),
    });
  } catch (err: any) {
    if (err?.code === 6 /* ALREADY_EXISTS */) {
      throw new HttpsError("already-exists", "このキャストはすでに評価済みです。");
    }
    throw err;
  }

  // Only flip the reservation itself to "completed" once every cast on it
  // has actually been reviewed - otherwise a single-cast reservation
  // (the overwhelming common case) would never see this branch skipped,
  // but a multi-cast one would prematurely fail the status guard above
  // for whichever cast(s) the guest hasn't rated yet.
  const allReviewsForRes = await db
    .collection("reviews")
    .where("res_id", "==", res_id)
    .where("reviewer_id", "==", uid)
    .get();
  const reviewedCastIds = new Set(allReviewsForRes.docs.map((d) => d.data().reviewee_id));
  const allCastsReviewed = (resData.cast_ids || []).every((id: string) => reviewedCastIds.has(id));

  if (allCastsReviewed) {
    await db.collection("reservations").doc(res_id).update({
      status: "completed",
      updated_at: Timestamp.now(),
    });
  }

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
  await sendPushNotification(
    cast_id,
    "評価が届きました",
    `★${rating} の評価が届きました。`,
    { res_id, rating: String(rating), type: "matching" }
  );

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

  // FIX (confirmed live bug, found during audit): `cast_pending` is a dead
  // status value - `schema.md` documents it, but nothing anywhere in this
  // codebase ever WRITES it (confirmed via grep; the real implemented
  // state machine only ever produces the 7 states this plan's own §5 item
  // 9 lists). Replaced with `request_pending` - a reservation the guest
  // submitted but never went on to pay for (no PaymentIntent ever
  // authorized) previously had NO expiry path at all: `authorized` is the
  // only status `respondToReservation` will accept, so a `request_pending`
  // reservation can never be approved/declined by the cast either, and
  // just lingered forever with nothing to clean it up. `payment_intent_id`
  // may legitimately be empty for these - the cancel call below is
  // already guarded for that.
  const expired = await db
    .collection("reservations")
    .where("status", "in", ["request_pending", "authorized"])
    .where("created_at", "<", Timestamp.fromDate(cutoff))
    .get();

  for (const doc of expired.docs) {
    const resData = doc.data();
    console.log(`Auto-cancelling expired reservation: ${doc.id}`);

    try {
      if (resData.payment_intent_id) {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }

      // Slot-lock release (PROJECT_KNOWLEDGE.md §68), folded into the same
      // transaction as the status write — this is the highest-value site
      // for this: an "authorized" reservation stuck here for 24h is
      // exactly the case most likely to actually hold a lock. An orphaned
      // "reserved" slot has no self-healing path, unlike the Stripe hold
      // above.
      await db.runTransaction(async (tx) => {
        const slotsSnap = await tx.get(reservedSlotsQuery(doc.id));
        tx.update(doc.ref, {
          status: "expired",
          cancel_reason: "24時間以内に承諾されなかったため自動キャンセル",
          updated_at: Timestamp.now(),
        });
        slotsSnap.forEach((slotDoc) => tx.delete(slotDoc.ref));
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
    // Defensive safety net: an extension authorized very late (close to
    // the cast's completion report) could in principle still be sitting
    // at `status: "authorized"` if `reportCompletion`'s own inline
    // capture attempt (see reportCompletion above) failed or never ran.
    // Idempotent - captureAuthorizedExtensions only ever touches docs
    // still `status == "authorized"`, so this is a no-op once they're
    // already captured.
    try {
      await captureAuthorizedExtensions(doc.id, doc.data());
    } catch (err) {
      console.error(`Extension capture sweep failed for ${doc.id}:`, err);
    }
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

    // Retry safety net for captureAuthorizedExtensions, mirroring the main
    // payment_intent_id retry immediately above it.
    try {
      await captureAuthorizedExtensions(doc.id, resData);
    } catch (err) {
      console.error(`Extension capture retry failed for stalled reservation ${doc.id}:`, err);
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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new HttpsError("invalid-argument", "メッセージを入力してください。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, CRITICAL — comprehensive project-wide
  // review): this used to query chat_rooms by res_id alone (`.limit(1)`)
  // and only check participants AFTER fetching whichever room the query
  // happened to return. Once a group-invite reservation gets a SECOND
  // chat_rooms doc for the same res_id (the cast-to-cast coordination room
  // work-posts.ts's selectWorkApplicant creates for partner_recruit posts,
  // same res_id, DIFFERENT participants), a cast who's a participant in
  // BOTH rooms could have this resolve to the WRONG one — the participant
  // check would still pass (they're in both), silently delivering a
  // private coordination message into the guest-facing room or vice versa.
  // Filtering by participants IN the query (matching the DSL's own
  // already-correct fetch_chat_messages.dart pattern) resolves to the
  // SPECIFIC room this caller actually belongs to, not just any room
  // sharing this res_id. Composite index already exists
  // (firestore.indexes.json: chat_rooms participants-array-contains +
  // res_id).
  const roomSnap = await db
    .collection("chat_rooms")
    .where("res_id", "==", res_id)
    .where("participants", "array-contains", uid)
    .limit(1)
    .get();
  if (roomSnap.empty) {
    throw new HttpsError("not-found", "チャットルームが見つかりません。");
  }

  const roomDoc = roomSnap.docs[0];
  const roomData = roomDoc.data();

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

  // FIX (feature build, unimplemented-features pass): sending a message
  // never notified the OTHER participant(s) at all — no in-app alert, no
  // way to know a new message arrived short of reopening the chat. Notify
  // every OTHER participant (a group-invite room can have more than 2),
  // matching the same `users/{uid}/notifications` broadcast shape every
  // other notification in this backend already uses. Best-effort (doesn't
  // block or fail the send itself if a notification write hiccups) —
  // matches `adminApproveKYC`'s own established "best-effort side effect"
  // precedent for exactly this reasoning.
  const otherParticipants: string[] = (roomData.participants || []).filter(
    (id: string) => id !== uid
  );
  const senderDoc = await db.collection("users").doc(uid).get();
  const senderNickname = senderDoc.data()?.nickname || "";
  await Promise.all(
    otherParticipants.map((participantId) =>
      db
        .collection("users")
        .doc(participantId)
        .collection("notifications")
        .add({
          type: "matching",
          title: `${senderNickname || "相手"}さんからメッセージ`,
          body: trimmed,
          data: { res_id, room_id: roomDoc.id },
          read: false,
          created_at: now,
        })
        .catch((err) => {
          console.error(`Failed to notify ${participantId} of new chat message:`, err);
        })
    )
  );
  // Real device push, alongside the in-app notification fan-out above —
  // sendPushNotification is already best-effort/non-throwing on its own,
  // matching the same per-recipient `.catch()` shape as the loop above.
  await Promise.all(
    otherParticipants.map((participantId) =>
      sendPushNotification(
        participantId,
        `${senderNickname || "相手"}さんからメッセージ`,
        trimmed,
        { res_id, room_id: roomDoc.id, type: "matching" }
      )
    )
  );

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

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }

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

  // FIX (PROJECT_KNOWLEDGE.md §70): same res_id-only-lookup ambiguity as
  // sendChatMessage above — filter by participants too so this resolves
  // the SPECIFIC room this caller belongs to, not just any room sharing
  // this res_id (a group-invite reservation can have a second, different-
  // participants chat_rooms doc for the same res_id).
  const roomSnap = await db
    .collection("chat_rooms")
    .where("res_id", "==", res_id)
    .where("participants", "array-contains", uid)
    .limit(1)
    .get();
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

// FIX (comprehensive project-wide review round 2, CRITICAL): ReservationDetail
// (the DSL page) had NO real data-fetching action at all beyond a status/
// role check (`fetchReservationVisibility`) — every date/time/location/
// reward/counterpart-name value on the page was a static placeholder string
// baked into the generated widget tree at authoring time, shown identically
// for every single reservation regardless of what was actually booked. This
// callable is the real data source for that page, added rather than reading
// Firestore directly from the client for two reasons: (1) `total_amount`/
// `location`/`date` live on `reservations/{res_id}`, which the caller CAN
// read directly under firestore.rules' guest/cast/staff-or-admin scoping,
// but (2) the counterpart's `nickname`/`profile_image_url` live on
// `users/{other_uid}`, which firestore.rules locks to STRICTLY owner-only
// read (`allow read: if request.auth.uid == document`) — a guest can never
// read their cast's own user doc directly, and vice versa. Same constraint
// `getChatRoomInfo` above already solves the same way: Admin SDK read,
// server-side, one round trip returning both.
export const getReservationDetailInfo = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { res_id } = request.data;
  const uid = request.auth.uid;

  if (typeof res_id !== "string" || !res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  const resData = resDoc.data()!;
  const isGuest = resData.guest_id === uid;
  const isCast = resData.cast_ids?.includes(uid);
  const isStaff = resData.staff_ids?.includes(uid);
  if (!isGuest && !isCast && !isStaff) {
    throw new HttpsError("permission-denied", "権限がありません。");
  }

  // Only `nickname` is resolved here (not `profile_image_url`) — the
  // ReservationDetail page's counterpart photo is a deliberate static
  // fallback avatar (see dsl/edit.dart's CircleImage_wer97dj4 patch), not a
  // dynamic binding, so a photo URL here would be dead data.
  const counterpartId = isGuest ? resData.cast_ids?.[0] || "" : resData.guest_id;
  let counterpartNickname = "";
  if (counterpartId) {
    const counterpartDoc = await db.collection("users").doc(counterpartId).get();
    if (counterpartDoc.exists) {
      counterpartNickname = counterpartDoc.data()?.nickname || "";
    }
  }

  // FIX (feature build, unimplemented-features pass): the cast-facing
  // approve/decline UI had zero visibility into whether this was a group
  // invite or how many of the OTHER invited casts had already responded —
  // `respondToReservation` (above) already correctly tracks this per-cast
  // in `cast_responses` and only finalizes once every invited cast has
  // accepted, but nothing surfaced that state to the cast deciding whether
  // to accept. `accepted_cast_count`/`total_cast_count` let the client show
  // "X/Y accepted" without duplicating this reservation's own response-
  // tallying logic client-side.
  const castIds: string[] = resData.cast_ids || [];
  const castResponses: Record<string, string> = resData.cast_responses || {};
  const acceptedCastCount = castIds.filter((id) => castResponses[id] === "accepted").length;

  return {
    success: true,
    date_ms: resData.date?.toMillis?.() ?? null,
    duration_minutes: resData.duration_minutes || 0,
    location: resData.location || "",
    total_amount: resData.total_amount || 0,
    counterpart_nickname: counterpartNickname,
    // FIX (comprehensive project-wide review round 2, follow-up finding):
    // the page also has a separate "リクエストメッセージ" card whose message
    // body was a static filler placeholder, never bound to the reservation's
    // real `details` field.
    details: resData.details || "",
    group_invite: resData.group_invite === true,
    group_size: resData.group_size || 0,
    accepted_cast_count: acceptedCastCount,
    total_cast_count: castIds.length,
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

      // FIX (PROJECT_KNOWLEDGE.md §70): same res_id-only-lookup ambiguity
      // as sendChatMessage/getChatRoomInfo above — without a participants
      // filter, this could pull the WRONG room's last_message/active state
      // into this caller's match-list preview once a group-invite
      // reservation has a second chat_rooms doc (same res_id, different
      // participants) for the cast-to-cast coordination room.
      const roomSnap = await db
        .collection("chat_rooms")
        .where("res_id", "==", resId)
        .where("participants", "array-contains", uid)
        .limit(1)
        .get();
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
