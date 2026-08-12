/**
 * Admin Panel API Cloud Functions
 * 管理機能ページ
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
// v1 SDK, used only by adminGetDashboardStats — see the comment on that
// function for why it stays on v1 instead of v2 like everything else here.
import * as functionsV1 from "firebase-functions/v1";
import { db, auth, stripe, Timestamp } from "./config";

/**
 * Helper: Verify admin role
 */
async function verifyAdmin(request: CallableRequest): Promise<void> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const data = userDoc.data() || {};
  // Accept either field: schema.md uses role=="admin"; Flutter admin login uses role_admin=="admin"
  const isAdmin =
    data.role === "admin" ||
    data.role_admin === "admin" ||
    data.roleAdmin === "admin";
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "管理者権限が必要です。");
  }
}

/**
 * Helper: Verify admin role — v1-SDK equivalent of verifyAdmin() above.
 * Not just reused as-is because v1's callable wrapper expects a v1
 * `functionsV1.https.HttpsError` to serialize errors correctly back to the
 * client; throwing the v2 HttpsError from inside a v1-registered function
 * risks it being unwrapped as a generic "internal" error instead of the
 * specific unauthenticated/permission-denied code.
 */
async function verifyAdminV1(
  context: functionsV1.https.CallableContext
): Promise<void> {
  if (!context.auth) {
    throw new functionsV1.https.HttpsError("unauthenticated", "認証が必要です。");
  }
  const userDoc = await db.collection("users").doc(context.auth.uid).get();
  const data = userDoc.data() || {};
  const isAdmin =
    data.role === "admin" ||
    data.role_admin === "admin" ||
    data.roleAdmin === "admin";
  if (!isAdmin) {
    throw new functionsV1.https.HttpsError("permission-denied", "管理者権限が必要です。");
  }
}

/**
 * Helper: Create audit log
 */
async function createAuditLog(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, any>,
  reason: string
): Promise<void> {
  await db.collection("audit_logs").add({
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
    reason,
    created_at: Timestamp.now(),
  });
}

// ============================================
// User Management
// ============================================

// v1 SDK for the same reason as adminGetDashboardStats below: this function
// is still deployed as 1st-gen, and Firebase disallows an in-place 1st->2nd
// gen upgrade. Writing it against firebase-functions/v1 lets `firebase
// deploy` update the existing function instead of requiring delete+redeploy.
export const adminGetUsers = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
  await verifyAdminV1(context);

  const {
    user_id,
    account_type,
    approval_status,
    is_frozen,
    kyc_status,
    prefecture,
    created_after,
    created_before,
    nickname_prefix,
    limit: queryLimit,
    offset,
  } = data;

  // Single-record lookup by id, used by user detail pages. Firestore rules
  // only let a user read their own `users/{uid}` doc, so an admin viewing
  // someone else's detail page can't fetch it with a direct client-side
  // Firestore read — it has to go through this callable instead. Short-
  // circuits before the list-query path below since none of those filters
  // apply to a single-doc fetch.
  if (user_id) {
    const doc = await db.collection("users").doc(user_id).get();
    if (!doc.exists) {
      return { success: false, error: "ユーザーが見つかりません。", users: [], count: 0 };
    }
    const user = { id: doc.id, ...doc.data() };
    return { success: true, user, users: [user], count: 1 };
  }

  let query: FirebaseFirestore.Query = db.collection("users");

  if (account_type) query = query.where("account_type", "==", account_type);
  if (approval_status) query = query.where("approval_status", "==", approval_status);
  if (is_frozen !== undefined) query = query.where("is_frozen", "==", is_frozen);
  if (kyc_status) query = query.where("kyc_status", "==", kyc_status);
  if (prefecture) query = query.where("prefecture", "==", prefecture);

  if (nickname_prefix) {
    // Firestore has no "contains" search; this is the standard prefix-range
    // trick. A range filter on nickname forces the first orderBy to also be
    // on nickname (Firestore requirement), so search results sort by name
    // instead of registration date. Firestore also only allows one
    // range-type filter per query, so nickname search and registration-
    // period filtering (created_after/created_before) can't be combined —
    // if both are sent, nickname search wins and the date range below is
    // skipped entirely.
    query = query
      .where("nickname", ">=", nickname_prefix)
      .where("nickname", "<=", nickname_prefix + "")
      .orderBy("nickname");
  } else {
    if (created_after) {
      query = query.where("created_at", ">=", new Date(created_after));
    }
    if (created_before) {
      query = query.where("created_at", "<=", new Date(created_before));
    }
    query = query.orderBy("created_at", "desc");
  }

  query = query.limit(queryLimit || 50);

  if (offset) {
    const lastDoc = await db.collection("users").doc(offset).get();
    if (lastDoc.exists) {
      query = query.startAfter(lastDoc);
    }
  }

  const snapshot = await query.get();
  const users = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  return { success: true, users, count: users.length };
});

/**
 * Forwards an already-uploaded KYC document (our own manual-review upload,
 * not Stripe Identity — §6 defect #6) to Stripe as the connected account's
 * identity_document, so admin approval also feeds Stripe's own Custom
 * Connect verification instead of leaving it with no document at all.
 * Without this, a JP individual Custom account can submit every other
 * onboarding field (§6 defect #5's `submitConnectOnboarding`) and still
 * never reach `payouts_enabled` — Stripe's own verification requires a
 * document, unrelated to our internal `kyc_status`/`approval_status`.
 * Best-effort: failures are logged, not thrown — admin approval of the
 * user account must not fail because of a downstream Stripe hiccup, and
 * `requirements_due` (already mirrored via `account.updated`/
 * `submitConnectOnboarding`) will keep showing the document as missing so
 * it's visible, not silently lost.
 */
async function forwardKycDocumentToStripe(stripeAccountId: string, docUrl: string): Promise<void> {
  const response = await fetch(docUrl);
  if (!response.ok) {
    throw new Error(`Failed to download KYC document (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const file = await stripe.files.create(
    {
      purpose: "identity_document",
      file: {
        data: buffer,
        name: "kyc_document",
        type: "application/octet-stream",
      },
    },
    { stripeAccount: stripeAccountId }
  );

  await stripe.accounts.update(stripeAccountId, {
    individual: {
      verification: {
        document: { front: file.id },
      },
    },
  });
}

export const adminApproveKYC = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, approved, reason } = request.data;

  if (!user_id) {
    throw new HttpsError("invalid-argument", "ユーザーIDが必要です。");
  }

  const newStatus = approved ? "approved" : "rejected";
  const newKycStatus = approved ? "approved" : "rejected";

  await db.collection("users").doc(user_id).update({
    approval_status: newStatus,
    kyc_status: newKycStatus,
    is_verified: approved,
    updated_at: Timestamp.now(),
  });

  if (approved) {
    const userData = (await db.collection("users").doc(user_id).get()).data();
    if (userData?.account_type === "cast" && userData?.stripe_account_id && userData?.kyc_doc_url) {
      try {
        await forwardKycDocumentToStripe(userData.stripe_account_id, userData.kyc_doc_url);
      } catch (err) {
        console.error(`Failed to forward KYC document to Stripe for ${user_id}:`, err);
      }
    }
  }

  await db.collection("users").doc(user_id).collection("notifications").add({
    type: "admin",
    title: approved ? "本人確認が承認されました" : "本人確認が却下されました",
    body: approved
      ? "全ての機能をご利用いただけます。"
      : `却下理由: ${reason || "書類に不備があります。"}`,
    data: { approved },
    read: false,
    created_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    approved ? "approve_kyc" : "reject_kyc",
    "user",
    user_id,
    { reason },
    reason || ""
  );

  return { success: true, message: approved ? "承認しました。" : "却下しました。" };
});

export const adminToggleFreeze = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, freeze, reason } = request.data;

  await db.collection("users").doc(user_id).update({
    is_frozen: freeze,
    updated_at: Timestamp.now(),
  });

  await db.collection("users").doc(user_id).collection("notifications").add({
    type: "admin",
    title: freeze ? "アカウントが凍結されました" : "アカウントの凍結が解除されました",
    body: freeze ? `理由: ${reason || "利用規約違反"}` : "全ての機能が再び利用可能です。",
    data: { freeze },
    read: false,
    created_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    freeze ? "freeze_account" : "unfreeze_account",
    "user",
    user_id,
    { reason },
    reason || ""
  );

  return { success: true };
});

export const adminForceDeleteUser = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, reason } = request.data;

  await db.collection("users").doc(user_id).update({
    is_active: false,
    is_frozen: true,
    updated_at: Timestamp.now(),
  });

  try {
    await auth.updateUser(user_id, { disabled: true });
  } catch (err) {
    console.error("Failed to disable auth user:", err);
  }

  const pendingRewards = await db
    .collection("affiliate_rewards")
    .where("affiliator_uid", "==", user_id)
    .where("status", "==", "pending")
    .get();

  const batch = db.batch();
  pendingRewards.forEach((doc) => {
    batch.update(doc.ref, { status: "forfeited" });
  });
  await batch.commit();

  await createAuditLog(
    request.auth!.uid,
    "force_delete",
    "user",
    user_id,
    { reason },
    reason || "管理者による強制退会"
  );

  return { success: true };
});

// Client Checklist Implementation Plan.md P1 item 14: profile image/bio
// viewing and moderation. Only self_introduction is writable here —
// profile_image_url is view-only per the plan's own scope (an admin can
// see it and freeze/force-delete the account if it's inappropriate, but
// there's no separate "replace this user's photo" product requirement).
export const adminUpdateUserProfile = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, self_introduction, reason } = request.data;

  if (!user_id) {
    throw new HttpsError("invalid-argument", "ユーザーIDが必要です。");
  }

  await db.collection("users").doc(user_id).update({
    self_introduction: self_introduction ?? "",
    updated_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    "update_profile",
    "user",
    user_id,
    { self_introduction },
    reason || "管理者によるプロフィール編集"
  );

  return { success: true };
});

// ============================================
// Reservation Management
// ============================================

// v1 SDK: this function is already live as a 1st-gen deployment (confirmed
// via `firebase functions:list`), and Firebase doesn't support an in-place
// 1st-gen -> 2nd-gen upgrade under the same name (same constraint already
// hit and documented for adminGetDashboardStats/adminGetUsers). Declaring
// this with the v2 `onCall` used elsewhere in this file would make the next
// deploy attempt a 2nd-gen deployment and fail/conflict.
//
// Sorts/filters by `scheduled_at` (the actual reservation date/time), not
// `created_at` (record-creation time) — the live Firestore indexes for this
// collection (`status+scheduled_at`, `cast_id+scheduled_at`,
// `guest_id+scheduled_at`, checked via `firebase firestore:indexes`) are
// all built around scheduled_at, and this function had zero existing
// callers before this change, so there's no prior behavior to preserve.
// Using scheduled_at reuses the existing `status+scheduled_at` composite
// index directly instead of needing a new one deployed.
export const adminGetReservations = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    await verifyAdminV1(context);

    // NOTE: only one of `status` / `guest_id` should be supplied per call -
    // combining both would need a `status+guest_id+scheduled_at` composite
    // index that doesn't exist. `status` alone reuses `status+scheduled_at`;
    // `guest_id` alone (added for GuestUserdetailsPage's 予約履歴 tab) reuses
    // the existing `guest_id+scheduled_at` index - both already confirmed
    // live per PROJECT_KNOWLEDGE.md §18.20.
    const { status, guest_id, scheduled_after, scheduled_before, limit: queryLimit, offset } = data;
    let query: FirebaseFirestore.Query = db.collection("reservations");

    if (status) query = query.where("status", "==", status);
    if (guest_id) query = query.where("guest_id", "==", guest_id);
    if (scheduled_after) {
      query = query.where("scheduled_at", ">=", new Date(scheduled_after));
    }
    if (scheduled_before) {
      query = query.where("scheduled_at", "<=", new Date(scheduled_before));
    }

    query = query.orderBy("scheduled_at", "desc").limit(queryLimit || 50);

    if (offset) {
      const lastDoc = await db.collection("reservations").doc(offset).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const reservations = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Cast-nickname join, added for the guest detail page's 予約履歴 tab
    // (raw cast_ids UIDs aren't useful in a UI) and reused by the
    // reservations list's own nickname display. Same N+1-per-unique-id
    // tradeoff already accepted for adminGetPayoutRequests' Stripe/debt
    // join below - deduped first since the same cast can appear across
    // many reservations in one page.
    const uniqueCastIds = Array.from(
      new Set(
        reservations.flatMap((r: any) =>
          Array.isArray(r.cast_ids)
            ? r.cast_ids.filter((id: unknown) => typeof id === "string")
            : []
        )
      )
    ) as string[];

    const castNicknames: Record<string, string> = {};
    await Promise.all(
      uniqueCastIds.map(async (castId) => {
        try {
          const castDoc = await db.collection("users").doc(castId).get();
          castNicknames[castId] = castDoc.data()?.nickname || "";
        } catch (err) {
          console.error(`Failed to fetch cast nickname for ${castId}:`, err);
        }
      })
    );

    const reservationsWithNicknames = reservations.map((r: any) => {
      const castIds: string[] = Array.isArray(r.cast_ids) ? r.cast_ids : [];
      return {
        ...r,
        cast_nicknames: castIds.map((id) => castNicknames[id] || ""),
      };
    });

    return {
      success: true,
      reservations: reservationsWithNicknames,
      count: reservationsWithNicknames.length,
    };
  });

export const adminForceCancel = onCall(async (request) => {
  await verifyAdmin(request);

  const { res_id, reason, refund_amount } = request.data;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const resData = resDoc.data()!;

  if (resData.payment_intent_id) {
    try {
      if (refund_amount && refund_amount > 0) {
        await stripe.paymentIntents.capture(resData.payment_intent_id, {
          amount_to_capture: refund_amount,
        });
      } else {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }
    } catch (err) {
      console.error("Stripe cancel failed:", err);
    }
  }

  await db.collection("reservations").doc(res_id).update({
    status: "cancelled",
    cancel_reason: reason || "管理者による強制キャンセル",
    cancelled_by: "admin",
    updated_at: Timestamp.now(),
  });

  const chatRooms = await db.collection("chat_rooms").where("res_id", "==", res_id).get();
  for (const room of chatRooms.docs) {
    await room.ref.update({ active: false, closed_at: Timestamp.now() });
  }

  await createAuditLog(
    request.auth!.uid,
    "force_cancel",
    "reservation",
    res_id,
    { reason, refund_amount },
    reason || ""
  );

  return { success: true };
});

// Client Checklist Implementation Plan.md P1 item 5: manual refund for an
// already-captured payment. Distinct from adminForceCancel above, which
// only cancels/releases a hold (requires_capture) or does a partial
// capture BEFORE the charge is finalized — this is for reversing a charge
// AFTER it's already been captured (status review_pending or completed,
// per schema.md's own note that review_pending means "capture実行済み").
// `amount` omitted means a full refund (Stripe's own default); a positive
// integer (JPY has no subunits, same convention as adminForceCancel's own
// amount_to_capture) does a partial refund.
export const adminManualRefund = onCall(async (request) => {
  await verifyAdmin(request);

  const { res_id, amount, reason } = request.data;

  if (!res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }
  if (!reason) {
    throw new HttpsError("invalid-argument", "返金理由を入力してください。");
  }

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }
  const resData = resDoc.data()!;

  if (!["review_pending", "completed"].includes(resData.status)) {
    throw new HttpsError(
      "failed-precondition",
      "決済が確定していない予約は返金できません。"
    );
  }
  if (!resData.payment_intent_id) {
    throw new HttpsError("failed-precondition", "決済情報が見つかりません。");
  }

  const refund = await stripe.refunds.create({
    payment_intent: resData.payment_intent_id,
    ...(amount && amount > 0 ? { amount } : {}),
  });

  const ledgerRef = db.collection("ledger").doc();
  await ledgerRef.set({
    ledger_id: ledgerRef.id,
    res_id,
    user_id: resData.guest_id || "",
    type: "refund",
    gross_amount: resData.total_amount || 0,
    cast_reward: 0,
    staff_fee: 0,
    stripe_fee: 0,
    platform_profit: 0,
    tax_amount: 0,
    net_transfer: 0,
    amount: refund.amount,
    stripe_event_id: "",
    stripe_object_id: refund.id,
    status: "confirmed",
    processed: true,
    created_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    "manual_refund",
    "reservation",
    res_id,
    { amount: refund.amount, stripe_refund_id: refund.id },
    reason
  );

  return { success: true, refund_id: refund.id, amount: refund.amount };
});

// Client Checklist Implementation Plan.md P1 item 6: exposes two things the
// detail page's aggregate counts (extension_count/extension_minutes) don't
// show - each individual extension payment, and each cast's own reward
// amount on a multi-cast reservation. Both read via a single call rather
// than two, since a detail page opening both sections at once is the only
// real caller.
//
// Investigated (not assumed) before writing this: `createExtensionPayment`
// (stripe-payments.ts) is the ONLY writer of `/reservations/{res_id}/
// extensions/{ext_id}` docs, always with `status: "authorized"` - grepped
// every .ts file in this directory for "extensions" and found no capture/
// cancel/webhook path that ever advances that status afterward. This is a
// genuine, pre-existing gap (extension payments never visibly resolve to
// captured/cancelled anywhere in this codebase today), not something this
// item's own scope covers fixing - flagged here and in the delivery notes
// rather than silently building a UI that implies a success/fail signal
// this data doesn't actually carry yet.
//
// Per-cast reward amounts, by contrast, DO reliably update:
// `processTransfers` (stripe-payments.ts, called from `capturePayment`)
// writes one `ledger` doc per cast with `type: "reward"`, `user_id` (the
// cast's own uid), `cast_reward`/`net_transfer`/`amount`, and a `status`
// that does advance ("pending" -> "confirmed"/"retrying" once the Stripe
// transfer itself resolves) - confirmed by reading that function directly,
// not assumed from schema.md alone.
//
// `res_id == X AND type == "reward"` needs no new composite index - an
// exact `(res_id ASC, type ASC, created_at DESC)` index already exists in
// firestore.indexes.json (added for a different query), which this one
// reuses by also ordering on created_at.
export const adminGetReservationExtras = onCall(async (request) => {
  await verifyAdmin(request);

  const { res_id } = request.data;
  if (!res_id) {
    throw new HttpsError("invalid-argument", "予約IDが必要です。");
  }

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const [extensionsSnap, rewardsSnap] = await Promise.all([
    db
      .collection("reservations")
      .doc(res_id)
      .collection("extensions")
      .orderBy("created_at", "asc")
      .get(),
    db
      .collection("ledger")
      .where("res_id", "==", res_id)
      .where("type", "==", "reward")
      .orderBy("created_at", "asc")
      .get(),
  ]);

  const extensions = extensionsSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  const rewards = rewardsSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  // Cast-nickname join, same pattern already established for
  // adminGetReservations' own cast_ids join above.
  const uniqueCastIds = Array.from(
    new Set(
      rewards
        .map((r: any) => r.user_id)
        .filter((id: unknown) => typeof id === "string")
    )
  ) as string[];

  const castNicknames: Record<string, string> = {};
  await Promise.all(
    uniqueCastIds.map(async (castId) => {
      try {
        const castDoc = await db.collection("users").doc(castId).get();
        castNicknames[castId] = castDoc.data()?.nickname || "";
      } catch (err) {
        console.error(`Failed to fetch cast nickname for ${castId}:`, err);
      }
    })
  );

  const rewardsWithNicknames = rewards.map((r: any) => ({
    ...r,
    cast_nickname: castNicknames[r.user_id] || "",
  }));

  return {
    success: true,
    extensions,
    rewards: rewardsWithNicknames,
  };
});

// Manual admin entry for meeting-point/interaction-location addresses.
// There's no guest-facing input for these today (schema.md's Reservations
// section only has `location`/`meeting_point` as plain descriptive
// strings, no separate address field) - this lets staff record one from
// the admin dashboard directly, e.g. after confirming details by phone/chat
// with the guest. Both args optional so either can be updated independently.
export const adminUpdateReservationLocation = onCall(async (request) => {
  await verifyAdmin(request);

  const { res_id, meeting_point_address, location_address } = request.data;

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  const updates: Record<string, unknown> = { updated_at: Timestamp.now() };
  if (meeting_point_address !== undefined) {
    updates.meeting_point_address = meeting_point_address;
  }
  if (location_address !== undefined) {
    updates.location_address = location_address;
  }

  await db.collection("reservations").doc(res_id).update(updates);

  await createAuditLog(
    request.auth!.uid,
    "update_reservation_location",
    "reservation",
    res_id,
    { meeting_point_address, location_address },
    ""
  );

  return { success: true };
});

// ============================================
// Affiliate Management
// ============================================

export const adminUpdateAffiliateRate = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, new_rate } = request.data;

  if (new_rate < 0.05 || new_rate > 0.30) {
    throw new HttpsError(
      "invalid-argument",
      "アフィリエイト料率は5%〜30%の範囲で設定してください。"
    );
  }

  if ((new_rate * 100) % 5 !== 0) {
    throw new HttpsError(
      "invalid-argument",
      "料率は5%刻みで設定してください。"
    );
  }

  const userDoc = await db.collection("users").doc(user_id).get();
  const oldRate = userDoc.data()?.affiliate_rate || 0.05;

  await db.collection("users").doc(user_id).update({
    affiliate_rate: new_rate,
    updated_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    "update_affiliate_rate",
    "user",
    user_id,
    { old_rate: oldRate, new_rate },
    `料率変更: ${oldRate * 100}% → ${new_rate * 100}%`
  );

  // Purpose-built change-history record (schema pre-existed in the FF
  // project, previously unused) - the admin rate-override UI reads this
  // directly instead of parsing audit_logs' generic `details` blob.
  await db.collection("affiliate_rate_history").add({
    affiliator_uid: user_id,
    old_rate: oldRate,
    new_rate,
    changed_by_admin_id: request.auth!.uid,
    changed_at: Timestamp.now(),
  });

  return { success: true };
});

// Per-affiliator rate change history for the admin rate-override UI's
// history panel.
export const adminGetAffiliateRateHistory = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id } = request.data;
  if (!user_id) {
    throw new HttpsError("invalid-argument", "user_id is required.");
  }

  const snap = await db
    .collection("affiliate_rate_history")
    .where("affiliator_uid", "==", user_id)
    .orderBy("changed_at", "desc")
    .get();

  return {
    success: true,
    history: snap.docs.map((doc) => {
      const d = doc.data();
      return {
        old_rate: d.old_rate,
        new_rate: d.new_rate,
        changed_by_admin_id: d.changed_by_admin_id,
        changed_at: d.changed_at ? d.changed_at.toDate().toISOString() : null,
      };
    }),
  };
});

function affiliateRewardStatusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "支払済み";
    case "forfeited":
      return "失効";
    case "approved":
      return "承認済み";
    case "pending":
    default:
      return "支払前";
  }
}

// Returns the distinct set of cast UIDs that appear as `referred_by_uid` on
// at least one other user doc - i.e. every cast who has successfully
// referred at least one other cast under the affiliate program, regardless
// of whether they have earned (or been paid) any reward yet. This is the
// canonical "who is a registered affiliator" definition for the admin
// dashboard's "アフィリエイト登録者数" card AND the Affiliate Management
// page's "アフィリエイター一覧" tab - both previously read from unrelated,
// inconsistent sources (the dashboard counted a separate, otherwise-unused
// `affiliates` collection; the management page derived its list only from
// this MONTH's `affiliate_rewards`, silently hiding any affiliator with no
// reward activity yet). `referred_by_uid` defaults to `""` on signup
// (auth.ts), never `null`, so the inequality filter is against `""`, not
// null - a single-field inequality needs no composite index.
async function getDistinctAffiliatorUids(): Promise<string[]> {
  const snap = await db
    .collection("users")
    .where("referred_by_uid", "!=", "")
    .select("referred_by_uid")
    .get();
  const uids = new Set<string>();
  for (const doc of snap.docs) {
    const uid = doc.data().referred_by_uid;
    if (uid) uids.add(uid);
  }
  return Array.from(uids);
}

// 1st-gen deployed function - must stay on functionsV1 (see adminGetReservations'
// comment above for why mixing v1/v2 on an existing deployed function fails).
export const adminGetAffiliateOverview = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
  await verifyAdminV1(context);

  const { month } = data;
  const now = new Date();
  const targetMonth =
    month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const rewardsSnap = await db
    .collection("affiliate_rewards")
    .where("month", "==", targetMonth)
    .get();

  // Per-affiliator current-month aggregates (kept for the summary map, also
  // used as the seed for the affiliators[] list below).
  const summary: Record<
    string,
    { total: number; pending: number; paid: number; forfeited: number; count: number }
  > = {};
  for (const doc of rewardsSnap.docs) {
    const d = doc.data();
    const uid = d.affiliator_uid;
    if (!uid) continue; // skip reward docs with no affiliator (e.g. seed placeholders)
    if (!summary[uid]) {
      summary[uid] = { total: 0, pending: 0, paid: 0, forfeited: 0, count: 0 };
    }
    summary[uid].total += d.reward_amount;
    summary[uid].count++;
    if (d.status === "pending") summary[uid].pending += d.reward_amount;
    if (d.status === "paid") summary[uid].paid += d.reward_amount;
    if (d.status === "forfeited") summary[uid].forfeited += d.reward_amount;
  }

  // Full affiliator roster (§ fix: previously the アフィリエイター一覧 tab
  // only ever showed affiliators with a reward record for THIS month,
  // silently hiding anyone who has referred a cast but not yet earned
  // anything this month - see `getDistinctAffiliatorUids` above).
  const affiliatorUids = await getDistinctAffiliatorUids();

  // Fetch every user doc referenced as an affiliator (this month's rewards
  // OR the full roster) or a referred cast in this month's rewards, once
  // each, for nickname/rate/created_at. Seed/incomplete reward docs can be
  // missing either uid (confirmed live: the `_seed` placeholder doc has
  // affiliator_uid but no referred_uid at all) — skip falsy values rather
  // than let `.doc(undefined)` throw.
  const neededUids = new Set<string>(affiliatorUids);
  for (const doc of rewardsSnap.docs) {
    const d = doc.data();
    if (d.affiliator_uid) neededUids.add(d.affiliator_uid);
    if (d.referred_uid) neededUids.add(d.referred_uid);
  }
  const userCache: Record<string, FirebaseFirestore.DocumentData | undefined> = {};
  await Promise.all(
    Array.from(neededUids).map(async (uid) => {
      const snap = await db.collection("users").doc(uid).get();
      userCache[uid] = snap.exists ? snap.data() : undefined;
    })
  );

  // 月次報酬一覧 tab: one row per individual reward record for the month.
  const rewards = rewardsSnap.docs.map((doc) => {
    const d = doc.data();
    const affiliator = d.affiliator_uid ? userCache[d.affiliator_uid] : undefined;
    const referred = d.referred_uid ? userCache[d.referred_uid] : undefined;
    return {
      reward_id: doc.id,
      month: d.month,
      affiliator_uid: d.affiliator_uid || null,
      affiliator_nickname: affiliator?.nickname || d.affiliator_uid || "―",
      referred_uid: d.referred_uid || null,
      referred_nickname: referred?.nickname || d.referred_uid || "―",
      reward_amount: d.reward_amount || 0,
      status: d.status,
      status_label: affiliateRewardStatusLabel(d.status),
      paid_at: d.paid_at ? d.paid_at.toDate().toISOString() : null,
    };
  });

  // アフィリエイター一覧 tab: one row per REGISTERED affiliator (the full
  // roster from `affiliatorUids` above, not just ones active this month -
  // `current_month_reward` below correctly falls back to 0 for anyone with
  // no reward record yet this month), with referred-cast count,
  // current-month total, and all-time paid cumulative (same "paid, all
  // months" definition getAffiliateDashboard uses for casts).
  const affiliators = await Promise.all(
    affiliatorUids.map(async (uid) => {
      const user = userCache[uid];
      const [referredSnap, allTimePaidSnap] = await Promise.all([
        db.collection("users").where("referred_by_uid", "==", uid).get(),
        db
          .collection("affiliate_rewards")
          .where("affiliator_uid", "==", uid)
          .where("status", "==", "paid")
          .get(),
      ]);
      let cumulativePaid = 0;
      for (const doc of allTimePaidSnap.docs) {
        cumulativePaid += doc.data().reward_amount;
      }
      return {
        affiliator_uid: uid,
        nickname: user?.nickname || uid,
        affiliate_rate: user?.affiliate_rate ?? 0.05,
        referred_cast_count: referredSnap.size,
        current_month_reward: summary[uid]?.total ?? 0,
        cumulative_paid: cumulativePaid,
        created_at: user?.created_at ? user.created_at.toDate().toISOString() : null,
      };
    })
  );

  return { success: true, month: targetMonth, rewards, affiliators, summary };
});

// ============================================
// Ledger & Payment Monitoring
// ============================================

// 1st-gen deployed function - must stay on functionsV1 (see adminGetReservations'
// comment above for why mixing v1/v2 on an existing deployed function fails).
//
// NOTE (2026-08-11, full-project composite-index audit; corrected same day
// after an inaccuracy was found reviewing this very comment): `user_id`,
// `res_id`, `type`, and `status` are all independently optional filters
// below, all combinable with each other and always finished with
// `orderBy("created_at")` - unlike `adminGetReservations` above (which
// deliberately restricts callers to supplying only ONE of its two optional
// equality filters, documented there), NOTHING here prevents a caller from
// combining several of these 4 at once. Covered today (verified directly
// against firestore.indexes.json, not from memory): `user_id` alone,
// `status` alone, `type` alone, `res_id`+`type` together, `type`+`status`
// together (all + the trailing `created_at` order). NOT covered: `res_id`
// alone (no matching single-field-plus-order index), and any combination
// that mixes `user_id` with any of the other three, or `status`/`res_id`
// together, or three-or-more filters at once - most of the 2^4-1 possible
// combinations, in other words, even though a few of the single-filter and
// one two-filter case happen to already be fine. Not fixed by pre-building
// every remaining combination (a genuine Firestore anti-pattern for dynamic
// multi-optional-filter queries - see `.cursor/rules/project_rules.md`'s
// own entry on this), and not currently reachable from this project's own
// DSL (confirmed via a full `httpsCallable(...)` sweep - nothing calls
// `adminGetLedger` at all yet). If a future Phase 12 admin-panel ledger-
// view UI wires this up, either restrict it to the same "one optional
// filter at a time" contract `adminGetReservations` already uses, or add
// the specific composite indexes the UI's OWN actual filter combinations
// need - don't guess ahead of what that UI will actually send, and don't
// trust this comment's own list without re-checking firestore.indexes.json
// directly first, since it can drift out of date the same way the
// original version of this very comment already did once.
export const adminGetLedger = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    await verifyAdminV1(context);

    const {
      user_id,
      res_id,
      type,
      status,
      created_after,
      created_before,
      limit: queryLimit,
    } = data;
    let query: FirebaseFirestore.Query = db.collection("ledger");

    if (user_id) query = query.where("user_id", "==", user_id);
    if (res_id) query = query.where("res_id", "==", res_id);
    if (type) query = query.where("type", "==", type);
    if (status) query = query.where("status", "==", status);
    if (created_after) {
      query = query.where("created_at", ">=", new Date(created_after));
    }
    if (created_before) {
      query = query.where("created_at", "<=", new Date(created_before));
    }

    const [snapshot, summary] = await Promise.all([
      query.orderBy("created_at", "desc").limit(queryLimit || 100).get(),
      computeLedgerSummary(query),
    ]);
    const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    return { success: true, entries, ...summary };
  });

// Client Checklist Implementation Plan.md P1 item 7: the 3 client-required
// figures (決済総額/送金実額/運営利益) computed over the SAME filters as the
// row list above, but from an unlimited pass over the filtered set - not a
// reduce over `entries`, which is capped at `queryLimit || 100` and would
// silently under-report any filtered range wider than that.
//
// Naively summing `gross_amount`/`platform_profit` across every returned
// row would overcount both, confirmed by reading `processTransfers`
// directly (stripe-payments.ts): both fields are computed ONCE per
// reservation but written into a SEPARATE `type: "reward"` ledger doc for
// EACH cast on that reservation - a 2-cast reservation has the identical
// gross_amount/platform_profit value duplicated across 2 rows. Fixed by
// deduping to one row per `res_id` among `reward`-type entries before
// summing either figure. `tip`-type entries are added into 決済総額
// separately (a tip is a genuinely distinct additional captured payment,
// not a duplicate of the reservation's own total_amount - confirmed by
// reading how `sendTip` writes it). `affiliate`-type entries are
// deliberately excluded from 決済総額 - their gross_amount is a monthly
// payout total to an affiliate, not incoming guest payment revenue,
// confirmed by reading `processMonthlyAffiliatePayments`.
//
// 送金実額, by contrast, needs no dedup - every type's `net_transfer` is
// already a genuinely distinct per-recipient amount (confirmed the same
// way, reading every ledger-writing call site: reward/staff_fee/tip/
// affiliate each write their own real transfer amount; refund/debt_offset
// don't carry a nonzero net_transfer at all) - straight summed across the
// whole filtered set.
//
// Deliberate cap, not a true unlimited query: 5000 rows is far more than
// any realistic admin-chosen filter window should return; guards against
// an accidentally-unbounded query (e.g. no date filter at all) reading the
// entire collection on every dashboard load.
async function computeLedgerSummary(
  filteredQuery: FirebaseFirestore.Query
): Promise<{
  gross_total: number;
  net_transfer_total: number;
  platform_profit_total: number;
}> {
  const snapshot = await filteredQuery.limit(5000).get();
  const rows = snapshot.docs.map((doc) => doc.data());

  let netTransferTotal = 0;
  for (const row of rows) {
    netTransferTotal += row.net_transfer || 0;
  }

  const seenResIdsForGrossProfit = new Set<string>();
  let grossTotal = 0;
  let platformProfitTotal = 0;
  for (const row of rows) {
    if (row.type === "reward" && row.res_id) {
      if (!seenResIdsForGrossProfit.has(row.res_id)) {
        seenResIdsForGrossProfit.add(row.res_id);
        grossTotal += row.gross_amount || 0;
        platformProfitTotal += row.platform_profit || 0;
      }
    } else if (row.type === "tip") {
      grossTotal += row.gross_amount || 0;
    }
  }

  return {
    gross_total: grossTotal,
    net_transfer_total: netTransferTotal,
    platform_profit_total: platformProfitTotal,
  };
}

// 1st-gen deployed function - must stay on functionsV1 (see adminGetReservations'
// comment above for why mixing v1/v2 on an existing deployed function fails).
export const adminGetStripeLogs = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    await verifyAdminV1(context);

    const { res_id, event_type, start_date, end_date, limit: queryLimit } = data;
    let query: FirebaseFirestore.Query = db.collection("stripe_logs");

    if (res_id) query = query.where("res_id", "==", res_id);
    if (event_type) query = query.where("event_type", "==", event_type);
    if (start_date) query = query.where("created_at", ">=", new Date(start_date));
    if (end_date) query = query.where("created_at", "<=", new Date(end_date));

    query = query.orderBy("created_at", "desc").limit(queryLimit || 50);

    const snapshot = await query.get();
    const logs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    return { success: true, logs };
  });

// ============================================
// Banner Management
// ============================================

// v1 SDK for the same reason as adminGetDashboardStats/adminGetUsers above:
// this function is still deployed as 1st-gen live, and Firebase disallows
// an in-place 1st->2nd gen upgrade (confirmed by a direct failed deploy
// attempt when this function was first extended with 3 new fields,
// 2026-07-29 — see PROJECT_KNOWLEDGE.md §18.36).
export const adminUpsertBanner = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
  await verifyAdminV1(context);

  const {
    banner_id,
    title,
    image_url,
    link_url,
    page,
    display_order,
    active,
    advertiser,
    display_days,
    start_date,
  } = data;

  const bannerData = {
    title,
    image_url,
    link_url: link_url || "",
    page: page || "home",
    display_order: display_order || 0,
    active: active !== undefined ? active : true,
    advertiser: advertiser || "",
    display_days: display_days || 0,
    start_date: start_date ? new Date(start_date) : Timestamp.now(),
    updated_at: Timestamp.now(),
  };

  let resolvedBannerId = banner_id;
  if (banner_id) {
    await db.collection("banners").doc(banner_id).update(bannerData);
  } else {
    const ref = await db.collection("banners").add({
      ...bannerData,
      created_at: Timestamp.now(),
    });
    resolvedBannerId = ref.id;
  }

  // Fixed 2026-08-07: this function wrote to `banners` (create AND update)
  // with no `createAuditLog` call at all - confirmed by grepping every
  // `createAuditLog(...)` call site in this file against every function
  // that performs a Firestore write, the only mutation found with no
  // audit trail. Its own sibling `adminDeleteBanner` right below already
  // logs correctly - this closes the same gap for create/update, mirroring
  // `adminUpsertCocotenShop`'s identical `shop_id ? "update_..." :
  // "create_..."` branching for the action string.
  await createAuditLog(
    context.auth!.uid,
    banner_id ? "update_banner" : "create_banner",
    "banner",
    resolvedBannerId,
    { title, page: page || "home", active: active !== undefined ? active : true },
    ""
  );

  return { success: true };
});

// New function, never previously deployed, so the standard v2 onCall SDK
// is safe here (no 1st-gen-live conflict like adminUpsertBanner above).
export const adminDeleteBanner = onCall(async (request) => {
  await verifyAdmin(request);

  const { banner_id } = request.data;

  if (!banner_id) {
    throw new HttpsError("invalid-argument", "banner_idが必要です。");
  }

  await db.collection("banners").doc(banner_id).delete();

  await createAuditLog(
    request.auth!.uid,
    "delete_banner",
    "banner",
    banner_id,
    {},
    ""
  );

  return { success: true };
});

// ============================================
// System Config
// ============================================

// Fixed 2026-08-06: SystemSettingsListPage crashed with a blank/red error
// screen on every visit. Root cause traced through two cascading Flutter
// exceptions (client console): (1) `TypeError: null: type 'Null' is not a
// subtype of type 'bool'` at the page's own initState, assigning a missing
// JSON field into a non-nullable `bool` page-state field
// (`areaTokyoActive` etc.); (2) once that first exception aborted the rest
// of the load sequence, a later `CheckboxListTile(tristate: false, value:
// null)` build-time assertion failure for the night-slot checkboxes, whose
// backing fields were left permanently null. Both traced to the SAME root
// cause: `adminGetSystemConfig` (the Dart custom action) read
// `system_config/settings` directly from the CLIENT via
// `FirebaseFirestore.instance` - the ONLY admin data path in this entire
// backend that bypasses Cloud Functions and goes straight through
// Firestore security rules (`match /system_config/{document} { allow
// read, write: if isAdmin(); }`), whose `isAdmin()` only accepts
// `role_admin == 'admin'` - narrower than `verifyAdmin()` above, which
// accepts `role`, `role_admin`, OR `roleAdmin`. Confirmed the live
// document and current admin accounts are well-formed (direct Firestore
// reads via IAM, and a query across `users` for `role`/`role_admin`
// matches), so this is most likely a client-side auth-token-propagation
// timing gap specific to fresh Firestore-rules evaluation, not a
// permanently-misconfigured account - but rather than chase an
// intermittent client-side race, the robust fix is to bring this ONE
// read path in line with every other admin data-fetch in this codebase:
// a Cloud Function gated by the same `verifyAdmin()` used everywhere
// else, which bypasses Firestore rules entirely via the Admin SDK and
// has no equivalent timing dependency. Mirrors the Dart custom action's
// own transform logic exactly (moved server-side), so the ~50
// `getJsonField($.xxx)` bindings already configured on the native
// FlutterFlow page require no changes - only the custom action's own
// `code:` (still client-side Dart) changes, to call this instead of
// reading Firestore directly.
export const adminGetSystemConfig = onCall(async (request) => {
  await verifyAdmin(request);

  const snap = await db.collection("system_config").doc("settings").get();
  if (!snap.exists) {
    throw new HttpsError(
      "not-found",
      "system_config/settings が見つかりません。"
    );
  }

  const data = snap.data() || {};
  const nightSlots: string[] = Array.isArray(data.night_time_slots)
    ? (data.night_time_slots as unknown[]).filter(
        (v): v is string => typeof v === "string"
      )
    : [];
  const serviceAreas: Record<string, unknown>[] = Array.isArray(
    data.service_areas
  )
    ? (data.service_areas as unknown[]).filter(
        (v): v is Record<string, unknown> =>
          !!v && typeof v === "object" && !Array.isArray(v)
      )
    : [];
  const cancelFeeRates: Record<string, unknown> =
    data.cancel_fee_rates && typeof data.cancel_fee_rates === "object"
      ? (data.cancel_fee_rates as Record<string, unknown>)
      : {};

  const areaActive = (prefecture: string): boolean => {
    const match = serviceAreas.find((a) => a.prefecture === prefecture);
    return match ? match.active === true : false;
  };
  const fmtPct = (raw: unknown): string | null =>
    typeof raw === "number" ? `${Math.round(raw * 100)} %` : null;
  const fmtDay = (raw: unknown): string | null =>
    typeof raw === "number" ? `${Math.round(raw)} 日` : null;
  const fmtYen = (raw: unknown): string | null =>
    typeof raw === "number"
      ? `${Math.round(raw).toLocaleString("ja-JP")}円`
      : null;

  return {
    success: true,
    ...data,
    night_slot_1: nightSlots.includes("1部"),
    night_slot_2: nightSlots.includes("2部"),
    night_slot_3: nightSlots.includes("3部"),
    night_slot_4: nightSlots.includes("4部"),
    default_cast_rate_display: fmtPct(data.default_cast_rate),
    security_staff_fee_display: fmtYen(data.security_staff_fee),
    transport_staff_fee_display: fmtYen(data.transport_staff_fee),
    cancel_general_rate_display: fmtPct(cancelFeeRates.cast_reward_rate),
    default_affiliate_rate_display: fmtPct(data.default_affiliate_rate),
    affiliate_min_days_display: fmtDay(data.affiliate_min_days),
    affiliate_payment_day_display: fmtDay(data.affiliate_payment_day),
    area_tokyo_active: areaActive("東京都"),
    area_chiba_active: areaActive("千葉県"),
    area_kanagawa_active: areaActive("神奈川県"),
    area_gifu_active: areaActive("岐阜県"),
    area_aichi_active: areaActive("愛知県"),
    area_kyoto_active: areaActive("京都府"),
    area_osaka_active: areaActive("大阪府"),
    area_hyogo_active: areaActive("兵庫県"),
    area_okayama_active: areaActive("岡山県"),
    area_hiroshima_active: areaActive("広島県"),
    area_fukuoka_active: areaActive("福岡県"),
    // Remaining 36 of the full 47 prefectures - the client-side Dart
    // action this Cloud Function replaces was independently extended to
    // all 47 (for PrefecturesDialogComp's own 47-switch picker, a second
    // consumer of this same action/function beyond SystemSettingsListPage's
    // original 11-prefecture tab) - matched here so BOTH callers keep
    // getting a complete response once the Dart action is repointed at
    // this function instead of reading Firestore directly.
    area_hokkaido_active: areaActive("北海道"),
    area_aomori_active: areaActive("青森県"),
    area_iwate_active: areaActive("岩手県"),
    area_miyagi_active: areaActive("宮城県"),
    area_akita_active: areaActive("秋田県"),
    area_yamagata_active: areaActive("山形県"),
    area_fukushima_active: areaActive("福島県"),
    area_ibaraki_active: areaActive("茨城県"),
    area_tochigi_active: areaActive("栃木県"),
    area_gunma_active: areaActive("群馬県"),
    area_saitama_active: areaActive("埼玉県"),
    area_niigata_active: areaActive("新潟県"),
    area_toyama_active: areaActive("富山県"),
    area_ishikawa_active: areaActive("石川県"),
    area_fukui_active: areaActive("福井県"),
    area_yamanashi_active: areaActive("山梨県"),
    area_nagano_active: areaActive("長野県"),
    area_shizuoka_active: areaActive("静岡県"),
    area_mie_active: areaActive("三重県"),
    area_shiga_active: areaActive("滋賀県"),
    area_nara_active: areaActive("奈良県"),
    area_wakayama_active: areaActive("和歌山県"),
    area_tottori_active: areaActive("鳥取県"),
    area_shimane_active: areaActive("島根県"),
    area_yamaguchi_active: areaActive("山口県"),
    area_tokushima_active: areaActive("徳島県"),
    area_kagawa_active: areaActive("香川県"),
    area_ehime_active: areaActive("愛媛県"),
    area_kochi_active: areaActive("高知県"),
    area_saga_active: areaActive("佐賀県"),
    area_nagasaki_active: areaActive("長崎県"),
    area_kumamoto_active: areaActive("熊本県"),
    area_oita_active: areaActive("大分県"),
    area_miyazaki_active: areaActive("宮崎県"),
    area_kagoshima_active: areaActive("鹿児島県"),
    area_okinawa_active: areaActive("沖縄県"),
  };
});

export const adminUpdateSystemConfig = onCall(async (request) => {
  await verifyAdmin(request);

  const { settings } = request.data;

  await db.collection("system_config").doc("settings").set(settings, { merge: true });

  await createAuditLog(
    request.auth!.uid,
    "update_system_config",
    "system",
    "settings",
    settings,
    "システム設定の更新"
  );

  return { success: true };
});

// ============================================
// Reports Management
// ============================================

export const adminGetReports = onCall(async (request) => {
  await verifyAdmin(request);

  const { status, limit: queryLimit } = request.data;
  let query: FirebaseFirestore.Query = db.collection("reports");

  if (status) query = query.where("status", "==", status);
  query = query.orderBy("created_at", "desc").limit(queryLimit || 50);

  const snapshot = await query.get();
  const reports = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  return { success: true, reports };
});

export const adminResolveReport = onCall(async (request) => {
  await verifyAdmin(request);

  const { report_id, admin_note, action } = request.data;

  await db.collection("reports").doc(report_id).update({
    status: "resolved",
    admin_note: admin_note || "",
  });

  await createAuditLog(
    request.auth!.uid,
    "resolve_report",
    "report",
    report_id,
    { admin_note, action },
    admin_note || ""
  );

  return { success: true };
});

// Client Checklist Implementation Plan.md P1 item 12: chat-log visibility
// for report review. Joins via `res_id`, not `chat_log_ref` - `res_id` is
// the field consistently used everywhere else in this codebase to look up
// a `chat_rooms` doc (`adminGetLedger`, `reservations.ts` x3,
// `stripe-payments.ts`), backend-written and reliable; `chat_log_ref` is
// purely client-supplied by `reportUser` (auth.ts) with no guarantee it's
// ever actually populated by the mobile app. Could not verify the live
// data shape directly against Firestore to settle this with certainty -
// this environment has no Application Default Credentials for a
// standalone Admin SDK script, and `firebase functions:shell` has no
// mechanism to simulate `request.auth` for an HTTPS `onCall` function at
// all (confirmed by reading firebase-tools' own `localFunction.js` -
// `constructCallableFunc` posts `data` directly with no auth injection;
// that machinery only exists for background/event-triggered functions).
// Decided with the user to proceed on `res_id` given the strength of the
// existing-code precedent, rather than block on a live check this
// environment cannot perform safely.
//
// A chat room's `participants` can be more than 2 users (guest + multiple
// cast_ids on a group reservation, confirmed by reading
// `reservations.ts`'s own chat-room-creation code) - message senders are
// looked up from the messages actually present, not assumed to be just
// `reporter_id`/`reported_id`.
export const adminGetReportChatLog = onCall(async (request) => {
  await verifyAdmin(request);

  const { report_id } = request.data;
  if (!report_id) {
    throw new HttpsError("invalid-argument", "report_idが必要です。");
  }

  const reportDoc = await db.collection("reports").doc(report_id).get();
  if (!reportDoc.exists) {
    return { success: false, error: "通報が見つかりません。" };
  }
  const resId = reportDoc.data()?.res_id;
  if (!resId) {
    return { success: true, messages: [], message_count: 0, no_chat_reason: "この通報には関連する予約がありません。" };
  }

  const chatRoomsSnap = await db.collection("chat_rooms").where("res_id", "==", resId).limit(1).get();
  if (chatRoomsSnap.empty) {
    return { success: true, messages: [], message_count: 0, no_chat_reason: "チャットルームが見つかりません。" };
  }

  const messagesSnap = await chatRoomsSnap.docs[0].ref
    .collection("messages")
    .orderBy("created_at", "asc")
    .get();

  const senderIds = Array.from(
    new Set(messagesSnap.docs.map((d) => d.data().sender_id).filter((v): v is string => !!v))
  );
  const senderNicknames: Record<string, string> = {};
  await Promise.all(
    senderIds.map(async (uid) => {
      const userDoc = await db.collection("users").doc(uid).get();
      senderNicknames[uid] = userDoc.exists ? userDoc.data()?.nickname || uid : uid;
    })
  );

  const messages = messagesSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      sender_id: data.sender_id || "",
      sender_nickname: senderNicknames[data.sender_id] || data.sender_id || "",
      text: data.text || "",
      created_at: data.created_at || null,
    };
  });

  return { success: true, messages, message_count: messages.length };
});

// ============================================
// Payout Approval
// ============================================

// 1st-gen deployed function - must stay on functionsV1 (see adminGetReservations'
// comment above for why mixing v1/v2 on an existing deployed function fails).
//
// Rewritten 2026-07-23 to actually target a specific payout_requests
// document instead of just paying out a user's live Stripe balance
// unconditionally. The previous version accepted an `action` param
// ("approve"/"on_hold"/"rejected") in its Dart wrapper's own doc comment
// but never read it - every call did the same immediate-payout flow
// regardless. Now `requestId` identifies which payout_requests doc this
// call is for, and `action` genuinely branches: on_hold/rejected just
// update that doc's status (no money moves); approve is the original
// Stripe payout flow, now also marking the source request as approved
// so the list (adminGetPayoutRequests) reflects it.
export const adminApprovePayout = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    await verifyAdminV1(context);

    const { requestId, action } = data;

    const requestDoc = await db.collection("payout_requests").doc(requestId).get();
    if (!requestDoc.exists) {
      throw new functionsV1.https.HttpsError("not-found", "出金申請が見つかりません。");
    }
    const requestData = requestDoc.data()!;
    const userId = requestData.user_id;

    if (action === "on_hold" || action === "rejected") {
      await db.collection("payout_requests").doc(requestId).update({
        status: action,
        updated_at: Timestamp.now(),
      });
      await createAuditLog(
        context.auth!.uid,
        action === "on_hold" ? "payout_on_hold" : "payout_rejected",
        "payout_request",
        requestId,
        { user_id: userId },
        action === "on_hold" ? "出金保留" : "出金否認"
      );
      return { success: true };
    }

    // Default/explicit "approve": original immediate-payout flow, now also
    // updating the source request's status.
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.stripe_account_id) {
      throw new functionsV1.https.HttpsError("failed-precondition", "Stripeアカウントが未設定です。");
    }

    try {
      const balance = await stripe.balance.retrieve({
        stripeAccount: userData.stripe_account_id,
      });

      const available = balance.available.find((b: any) => b.currency === "jpy");
      if (!available || available.amount <= 0) {
        throw new functionsV1.https.HttpsError("failed-precondition", "出金可能な残高がありません。");
      }

      const payout = await stripe.payouts.create(
        {
          amount: available.amount,
          currency: "jpy",
        },
        { stripeAccount: userData.stripe_account_id }
      );

      await db.collection("payout_requests").doc(requestId).update({
        status: "approved",
        updated_at: Timestamp.now(),
      });

      await db.collection("users").doc(userId).collection("notifications").add({
        type: "stripe",
        title: "出金が承認されました",
        body: `¥${available.amount.toLocaleString()} の出金処理を開始しました。`,
        data: { payout_id: payout.id, amount: available.amount },
        read: false,
        created_at: Timestamp.now(),
      });

      await createAuditLog(
        context.auth!.uid,
        "approve_payout",
        "user",
        userId,
        { amount: available.amount, payout_id: payout.id, request_id: requestId },
        "出金承認"
      );

      return { success: true, payout_id: payout.id, amount: available.amount };
    } catch (err: any) {
      throw new functionsV1.https.HttpsError("internal", `出金処理に失敗しました: ${err.message}`);
    }
  });

// New: list payout_requests for the admin dashboard's 出金申請一覧, joining
// in each user's live Stripe balance (ストリップ口座残高) and summed
// debt_history (論理負債) - neither is stored on the request doc itself.
// N+1 queries per row (Stripe balance + debt sum), same tradeoff already
// accepted for adminGetTipsByReservation-style joins elsewhere in this
// file; acceptable here since this is a bounded admin review queue, not a
// large user-facing list.
export const adminGetPayoutRequests = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    await verifyAdminV1(context);

    const { status, limit: queryLimit } = data;
    let query: FirebaseFirestore.Query = db.collection("payout_requests");
    if (status) query = query.where("status", "==", status);
    query = query.orderBy("created_at", "desc").limit(queryLimit || 50);

    const snapshot = await query.get();
    const requests = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const requestData = doc.data();
        const userId = requestData.user_id;
        let stripeBalance = 0;
        let debtTotal = 0;

        try {
          const userDoc = await db.collection("users").doc(userId).get();
          const stripeAccountId = userDoc.data()?.stripe_account_id;
          if (stripeAccountId) {
            const balance = await stripe.balance.retrieve({
              stripeAccount: stripeAccountId,
            });
            const available = balance.available.find((b: any) => b.currency === "jpy");
            stripeBalance = available?.amount || 0;
          }
        } catch (err) {
          console.error(`Failed to fetch Stripe balance for ${userId}:`, err);
        }

        try {
          const debtSnap = await db
            .collection("debt_history")
            .where("user_id", "==", userId)
            .get();
          debtTotal = debtSnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        } catch (err) {
          console.error(`Failed to fetch debt history for ${userId}:`, err);
        }

        return {
          id: doc.id,
          ...requestData,
          stripe_balance: stripeBalance,
          debt_total: debtTotal,
        };
      })
    );

    return { success: true, requests };
  });

// ============================================
// Dashboard Stats
// ============================================

// Deliberately v1 SDK, unlike every other function in this file. The live
// production version of this function is 1st-gen; Firebase does not support
// an in-place Gen1->Gen2 upgrade of an existing callable under the same
// name (would require functions:delete + redeploy, with a real downtime
// gap in between). Writing this one function with the v1 SDK lets it
// deploy as a normal update to the existing v1 function instead — no
// deletion, no downtime. Decided 2026-07-16; see PROJECT_KNOWLEDGE.md
// §18.15/§18.16 for the full reasoning and the (rejected) delete+redeploy
// alternative.
export const adminGetDashboardStats = functionsV1
  .region("asia-northeast1")
  .https.onCall(async (_data, context) => {
    await verifyAdminV1(context);

  // Cloud Functions default to UTC regardless of the deployed region
  // (asia-northeast1 is about where the code runs, not what timezone
  // `Date` defaults to) — but this business operates in Japan Standard
  // Time (UTC+9, no DST). Computing "today"/month boundaries from the
  // server's raw local time would skew every "today" figure (new
  // registrations, today's reservations, today's revenue) by up to 9
  // hours relative to the real Japan business day. Compute explicitly in
  // JST instead. Found and fixed 2026-07-16 alongside the `users` fix
  // below.
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const jstYear = nowJst.getUTCFullYear();
  const jstMonth = nowJst.getUTCMonth();
  const jstDate = nowJst.getUTCDate();

  const todayStart = Timestamp.fromDate(
    new Date(Date.UTC(jstYear, jstMonth, jstDate) - JST_OFFSET_MS)
  );

  // Rolling 5-month window ending this month — matches the shape already
  // live in production (confirmed via raw response capture 2026-07-16).
  // NOTE: this also fixes a confirmed bug where monthLabels/salesAmounts
  // used to have mismatched lengths (5 vs 4) — both are now always length 5.
  const monthRanges = Array.from({ length: 5 }, (_, idx) => {
    const offset = 4 - idx;
    const monthIndex = jstMonth - offset;
    const start = new Date(Date.UTC(jstYear, monthIndex, 1) - JST_OFFSET_MS);
    const end = new Date(Date.UTC(jstYear, monthIndex + 1, 1) - JST_OFFSET_MS);
    // Date.UTC normalizes out-of-range month indices (e.g. -2 correctly
    // becomes Nov of the previous year) — read the label back out the
    // same way rather than assuming monthIndex is already 0-11.
    const labelMonth = new Date(Date.UTC(jstYear, monthIndex, 1)).getUTCMonth();
    return { label: `${labelMonth + 1}月`, start, end };
  });

  const [
    totalUsers,
    pendingKYC,
    activeReservations,
    pendingReports,
    todayReservations,
    todayCapturedSnap,
    guestCount,
    castUsersSnap,
    // Confirmed 2026-07-16 via Firebase Console: both `payout_requests` and
    // `withdrawal_applications` currently hold only a single `_seed` doc
    // each, so data volume can't disambiguate them — but this admin
    // project's own FlutterFlow schema only defines
    // `payout_requests_record.dart` (no withdrawal_applications
    // equivalent), confirming `payout_requests` is the collection this app
    // actually reads.
    pendingWithdrawals,
    // CORRECTED (superseding the 2026-07-16 note below, kept for context):
    // `affiliates` turned out to be a separate, otherwise-unused collection
    // (a distinct code/commission_rate/contact_email/name/total_referrals
    // marketing-partner schema) - nothing else in this codebase reads or
    // writes it, and it has no relationship to the actual affiliate feature
    // (`affiliate_rewards` + `users.affiliate_rate`, the cast-referral
    // "現役優先型" system `adminGetAffiliateOverview`/`adminUpdateAffiliateRate`
    // are built around). This card was silently counting the wrong system,
    // which is why it disagreed with the Affiliate Management page's own
    // アフィリエイター一覧 tab. Now uses `getDistinctAffiliatorUids()` (the
    // SAME canonical roster `adminGetAffiliateOverview` uses), so both
    // agree by construction. Original 2026-07-16 note, no longer current:
    // "Confirmed: `affiliates` (distinct from `affiliate_rewards`, which is
    // reward transactions) has a purpose-built registrant schema (code,
    // commission_rate, contact_email, is_active, name, total_referrals) —
    // this is the right collection. Filtered by `is_active` to match the
    // same convention as the `users` count above."
    affiliateCount,
    cocotenShopCount,
    jobBoardPostCount,
    bannerCount,
    monthlyCapturedSnaps,
  ] = await Promise.all([
    // Fixed 2026-07-16: this card is labeled "本日の新規登録者数" (today's
    // NEW registrations), but this query — inherited unchanged from the
    // stale handoff file found earlier — was actually counting *all*
    // active users ever, with no date filter at all. That mismatch is why
    // this figure didn't behave like a "today" metric. Filtering by
    // `created_at` (registration date) against the JST-correct
    // `todayStart` now makes it actually match its label.
    db.collection("users").where("created_at", ">=", todayStart).count().get(),
    db.collection("users").where("kyc_status", "==", "submitted").count().get(),
    db
      .collection("reservations")
      .where("status", "not-in", ["completed", "cancelled", "expired"])
      .count()
      .get(),
    db.collection("reports").where("status", "==", "pending").count().get(),
    db
      .collection("reservations")
      .where("created_at", ">=", todayStart)
      .count()
      .get(),
    // "本日の総決済額": schema.md documents `ledger.type` as only
    // reward/staff_fee/refund/affiliate/debt_offset/tip line items — no
    // "payment" value — so summing `ledger.amount` would have wrongly mixed
    // in refunds/rewards. `reservations.total_amount` ("決済総額") + `
    // last_capture_at` ("最終売上確定日時") is the correct source: sum of
    // what was actually captured by Stripe today.
    db
      .collection("reservations")
      .where("last_capture_at", ">=", todayStart)
      .get(),
    db.collection("users").where("account_type", "==", "guest").count().get(),
    // Deliberately a plain single-field query + local filtering, not
    // `.where("account_type","==","cast").where("staff_type","!=","none")`.
    // That combination (equality + inequality on different fields) needs a
    // Firestore composite index that doesn't exist — hit this live on
    // 2026-07-16 (FAILED_PRECONDITION, HTTP 500) and it took down the
    // *entire* function, not just this query, since everything shares one
    // Promise.all. Fetching once and splitting in JS avoids needing any
    // composite index at all.
    db.collection("users").where("account_type", "==", "cast").get(),
    db.collection("payout_requests").where("status", "==", "pending").count().get(),
    getDistinctAffiliatorUids().then((uids) => uids.length),
    // Fixed 2026-08-06: this card is labeled "ココ店掲載店舗数" (number of
    // shops LISTED on Coco), but the query counted every document in
    // `cocoten_shops` regardless of `active` - confirmed live via direct
    // Firestore read that the collection has 5 docs, only 3 of which are
    // actually active (`_seed` is an inactive placeholder, and
    // `sample_shop_04` is literally named "旧店舗（閉店）" = "old shop
    // (closed)" and marked inactive). A closed/placeholder shop is not
    // "掲載" (listed/published) by any reading of that word - same "match
    // the query to what the label says" class of bug already fixed once
    // for the 本日の新規登録者数 card above. `adminGetCocotenShops` (the
    // admin management list) deliberately does NOT filter by `active` -
    // that's correct and unrelated, since admins need to see and manage
    // inactive shops too; this dashboard count is a different, narrower
    // question ("how many are actually live right now").
    db.collection("cocoten_shops").where("active", "==", true).count().get(),
    // Fixed 2026-08-06: this card is labeled "お仕事掲示板投稿件数" (number of
    // job board POSTINGS), but the query counted `job_board_posts` - a
    // stale/decoy collection confirmed (via direct Firestore read) to hold
    // only a single manually-seeded `_seed` placeholder doc. The REAL
    // feature (group-invite job posts, created when a cast accepts a
    // reservation with `group_invite`/`group_size` set - see
    // `adminGetWorkPosts` below, and its own long-standing comment flagging
    // this exact mismatch) writes to `work_posts`, which a direct Firestore
    // read confirms holds 4 real documents matching schema.md §20
    // field-for-field. Same "match the query to what the label/collection
    // actually is" class of bug already fixed twice above (本日の新規登録者数,
    // ココ店掲載店舗数). No status filter applied - "投稿件数" (number of
    // postings) reads as a total submission count, not "currently open"
    // specifically, unlike ココ店's "掲載" (listed/live) wording.
    db.collection("work_posts").count().get(),
    db.collection("banners").count().get(),
    Promise.all(
      monthRanges.map((r) =>
        db
          .collection("reservations")
          .where("last_capture_at", ">=", Timestamp.fromDate(r.start))
          .where("last_capture_at", "<", Timestamp.fromDate(r.end))
          .get()
      )
    ),
  ]);

  // Resolved 2026-08-07 per C5 (project_rules.md §17.9, "staff dual-role
  // count"): staff_type is a confirmed 4-value enum (none/security/
  // transport/both — schema.md, auth.ts's onboarding write, and this same
  // function's own prior binary split all already agreed on this set; the
  // source PDF's "5 patterns" header just didn't match its own 4 bullets,
  // there's no evidence anywhere in the codebase of a real 5th value).
  // Previously this only split cast vs. staff as a binary
  // (`staff_type !== "none"`), leaving the "スタッフ" pie slice a single
  // lumped bucket, flagged Provisional in §18.15 pending this exact
  // resolution. Now split by the actual value for a real by-role
  // breakdown. Still a single pass over the same already-fetched
  // castUsersSnap — no new query, so the 2026-07-16 composite-index
  // incident this snapshot's own fetch comment documents doesn't recur.
  let castCount = 0;
  let securityCount = 0;
  let transportCount = 0;
  let bothCount = 0;
  for (const doc of castUsersSnap.docs) {
    const staffType = doc.data().staff_type;
    if (staffType === "security") securityCount++;
    else if (staffType === "transport") transportCount++;
    else if (staffType === "both") bothCount++;
    else castCount++; // "none", missing, or any unrecognized value
  }

  const todayRevenue = todayCapturedSnap.docs.reduce(
    (sum, doc) => sum + (doc.data().total_amount || 0),
    0
  );
  const monthLabels = monthRanges.map((r) => r.label);
  const salesAmounts = monthlyCapturedSnaps.map((snap) =>
    snap.docs.reduce((sum, doc) => sum + (doc.data().total_amount || 0), 0)
  );

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    totals: {
      users: totalUsers.data().count,
      reservations: todayReservations.data().count,
      pendingKyc: pendingKYC.data().count,
      openReports: pendingReports.data().count,
      revenue: todayRevenue,
      pendingWithdrawals: pendingWithdrawals.data().count,
      affiliateCount: affiliateCount,
      cocotenShopCount: cocotenShopCount.data().count,
      jobBoardPostCount: jobBoardPostCount.data().count,
      bannerCount: bannerCount.data().count,
    },
    stats: {
      total_users: totalUsers.data().count,
      pending_kyc: pendingKYC.data().count,
      active_reservations: activeReservations.data().count,
      pending_reports: pendingReports.data().count,
      today_reservations: todayReservations.data().count,
    },
    userTypeLabels: ["ゲスト", "キャスト", "警備スタッフ", "送迎スタッフ", "警備・送迎スタッフ"],
    userTypeValues: [
      guestCount.data().count,
      castCount,
      securityCount,
      transportCount,
      bothCount,
    ],
    monthLabels,
    salesAmounts,
  };
});

// 監査ログ管理 (Tier 3). `audit_logs` is already written to by createAuditLog
// (KYC approve/reject, freeze/unfreeze, force-delete, force-cancel, banner
// delete, system-config update, report resolve, payout approve/hold/reject,
// affiliate-rate update) - this is the first read of that collection.
// Single equality filter (`action`) kept deliberately alone, not combined
// with `target_type`, to avoid needing a 3-field composite index on top of
// the date-range one - same one-filter-at-a-time caution already
// documented on adminGetDashboardStats's account_type/staff_type incident.
export const adminGetAuditLogs = onCall(async (request) => {
  await verifyAdmin(request);

  const {
    action,
    target_id,
    created_after,
    created_before,
    limit: queryLimit,
  } = request.data;

  let query: FirebaseFirestore.Query = db.collection("audit_logs");

  if (action) query = query.where("action", "==", action);
  // Lets the admin affiliate-rate UI pull just one affiliator's own rate
  // change history (action=="update_affiliate_rate" + target_id==uid) instead
  // of scanning the global action-filtered list by eye.
  if (target_id) query = query.where("target_id", "==", target_id);
  if (created_after) {
    query = query.where("created_at", ">=", new Date(created_after));
  }
  if (created_before) {
    query = query.where("created_at", "<=", new Date(created_before));
  }

  query = query.orderBy("created_at", "desc").limit(queryLimit || 100);

  const snapshot = await query.get();
  const logs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // admin_id is a Firebase Auth uid (request.auth.uid at write time), not a
  // display name - resolve to nickname via users/{uid}, deduped so a page
  // full of the same admin's actions only costs one extra read, not N.
  const adminIds = Array.from(
    new Set(
      logs
        .map((l) => (l as { admin_id?: string }).admin_id)
        .filter((id): id is string => !!id)
    )
  );
  const adminDocs = await Promise.all(
    adminIds.map((id) => db.collection("users").doc(id).get())
  );
  // Checked all 3 real admin accounts directly in Firestore: none of them
  // have a `nickname` set (that field is populated for guest/cast profiles,
  // not admin accounts) - every one does have `email`, so fall back to
  // that rather than showing a permanently-blank 管理者名 column.
  const adminNicknames: Record<string, string> = {};
  adminDocs.forEach((doc, i) => {
    const data = doc.data();
    adminNicknames[adminIds[i]] = doc.exists
      ? (data?.nickname as string) || (data?.email as string) || ""
      : "";
  });

  const withNicknames = logs.map((l) => ({
    ...l,
    admin_nickname: adminNicknames[(l as { admin_id?: string }).admin_id || ""] || "",
  }));

  return { success: true, logs: withNicknames, count: withNicknames.length };
});

// ============================================
// Processed Events (Stripe webhook idempotency - §17.4 ⑮)
// ============================================
//
// `processed_events` is written exclusively by stripe-webhooks.ts, keyed
// by the Stripe event id itself (`db.collection("processed_events").doc
// (eventId)`), and checked BEFORE processing any webhook - a genuine
// idempotency guard (confirmed by reading that file directly: the
// existence check happens first, the record is only written AFTER
// successful handling, and no TTL field is ever set on it, unlike
// `stripe_logs`' own 90-day TTL - so this collection is permanent by
// construction, matching what §17.4 ⑮ actually needs it for). This is
// the FIRST read of that collection anywhere in this backend - no admin-
// facing view existed before this.
export const adminGetProcessedEvents = onCall(async (request) => {
  await verifyAdmin(request);

  const { eventType, limit: queryLimit } = request.data;

  let query: FirebaseFirestore.Query = db.collection("processed_events");
  if (eventType) query = query.where("event_type", "==", eventType);
  query = query.orderBy("processed_at", "desc").limit(queryLimit || 100);

  const snapshot = await query.get();
  const events = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  return { success: true, events, count: events.length };
});

// ============================================
// ココ店管理 (Tier 3) - schema.md §19 CocotenShops, confirmed against the
// live `cocoten_shops` collection directly (only doc there is a `_seed`
// placeholder carrying `prefecture`/`name`/`active`/`updated_at` - not the
// full schema.md field set, and missing `created_at` entirely). No
// existing read/write functions for this collection before this - only a
// `.count()` used by adminGetDashboardStats. No equality-filter query here
// (shop counts are expected to be small, unlike the guest/cast lists) -
// fetches all, ordered by name, and leaves keyword search to the client
// wrapper, which needs no composite index at all.
export const adminGetCocotenShops = onCall(async (request) => {
  await verifyAdmin(request);

  const snapshot = await db
    .collection("cocoten_shops")
    .orderBy("name")
    .limit(200)
    .get();
  const shops = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  return { success: true, shops, count: shops.length };
});

// Upsert, same shape as adminUpsertBanner (shop_id present -> update,
// absent -> create) but as a fresh v2 onCall function (never previously
// deployed, no Gen1/Gen2 constraint). Address is split into the 4 fields
// the CocomiseListPage mockup actually shows (都道府県/市/町村番地/建物名)
// rather than schema.md's single `address` string - closer to what the UI
// needs; `photos` (schema.md) deliberately not handled here, see
// PROJECT_KNOWLEDGE.md for why.
// `name`/`genre`/`prefecture`/`city`/`town_block`/`building` are treated
// as "leave unchanged if blank" ONLY when updating an existing shop
// (shop_id set) - the DSL's edit dialog can't prefill a TextField with
// the shop's current value (no supported binding for that widget type in
// this SDK version - `bindText`/`bindValue` both explicitly reject
// TextField), so its 6 text fields start blank on every open, and the
// admin only needs to type into the ones they actually want to change.
// Mirrors this project's own established "nullable params mean leave
// unchanged" convention (see admin_update_system_config.dart / §18.25),
// just decided per-field from blank-string rather than from a JS
// `undefined`, since these arguments are typed String, not optional.
export const adminUpsertCocotenShop = onCall(async (request) => {
  await verifyAdmin(request);

  const {
    shop_id,
    name,
    genre,
    prefecture,
    city,
    town_block,
    building,
    active,
  } = request.data;

  let shopId: string = shop_id || "";
  const existing = shopId
    ? await db.collection("cocoten_shops").doc(shopId).get()
    : null;
  const existingData = existing?.data() || {};

  const resolvedName = name || (shopId ? existingData.name : "") || "";
  if (!resolvedName) {
    throw new HttpsError("invalid-argument", "店舗名が必要です。");
  }

  const shopData = {
    name: resolvedName,
    genre: genre || (shopId ? existingData.genre : "") || "",
    prefecture: prefecture || (shopId ? existingData.prefecture : "") || "",
    city: city || (shopId ? existingData.city : "") || "",
    town_block: town_block || (shopId ? existingData.town_block : "") || "",
    building: building || (shopId ? existingData.building : "") || "",
    active: active !== undefined ? active : true,
    updated_at: Timestamp.now(),
  };

  if (shopId) {
    await db.collection("cocoten_shops").doc(shopId).update(shopData);
  } else {
    const ref = await db.collection("cocoten_shops").add({
      ...shopData,
      created_at: Timestamp.now(),
    });
    shopId = ref.id;
  }

  await createAuditLog(
    request.auth!.uid,
    shop_id ? "update_cocomise" : "create_cocomise",
    "cocomise",
    shopId,
    { name },
    ""
  );

  return { success: true, shop_id: shopId };
});

export const adminDeleteCocotenShop = onCall(async (request) => {
  await verifyAdmin(request);

  const { shop_id } = request.data;
  if (!shop_id) {
    throw new HttpsError("invalid-argument", "shop_idが必要です。");
  }

  await db.collection("cocoten_shops").doc(shop_id).delete();

  await createAuditLog(
    request.auth!.uid,
    "delete_cocomise",
    "cocomise",
    shop_id,
    {},
    ""
  );

  return { success: true };
});

// ============================================
// お仕事掲示板管理 (Tier 3)
// ============================================
//
// IMPORTANT: this reads `work_posts`, NOT `job_board_posts`.
// `job_board_posts` only ever contained a single manually-seeded `_seed`
// placeholder doc (confirmed directly in Firestore) - the REAL feature
// (group-invite job posts created when a cast accepts a reservation with
// `group_invite`/`group_size` set) writes to `work_posts`, matching
// schema.md §20 exactly field-for-field (confirmed by reading
// reservations.ts's actual write, not guessed: `poster_id`, `res_id`,
// `type`, `description`, `date`, `location`, `fee`, `status`,
// `applicants`, `selected_id`, `created_at`). `job_board_posts` was a
// stale/decoy collection from before this was finalized. `adminGetDashboardStats`
// above used to count `job_board_posts` too (same mismatch) - fixed
// 2026-08-06 to count `work_posts` as well, so both this endpoint and the
// dashboard card now agree on the same real collection.
export const adminGetWorkPosts = onCall(async (request) => {
  await verifyAdmin(request);

  const { status, limit: queryLimit } = request.data;

  let query: FirebaseFirestore.Query = db.collection("work_posts");
  if (status) query = query.where("status", "==", status);
  query = query.orderBy("created_at", "desc").limit(queryLimit || 100);

  const snapshot = await query.get();
  const posts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // One batched nickname lookup covering BOTH posters and applicants -
  // `applicants` is added here (was previously ignored beyond its own
  // `.length` on the Flutter side) so the admin hire-picker UI can show
  // applicant nicknames, not just a bare count. Collect every id first,
  // dedupe, fetch once - same shape as the poster-only version this
  // replaces, just widened to cover both id sources in one round trip.
  const applicantIdsByPost = posts.map((p) => {
    const raw = (p as { applicants?: unknown }).applicants;
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string" && !!id)
      : [];
  });
  const allIds = Array.from(
    new Set(
      posts
        .map((p) => (p as { poster_id?: string }).poster_id)
        .filter((id): id is string => !!id)
        .concat(...applicantIdsByPost)
    )
  );
  const userDocs = await Promise.all(
    allIds.map((id) => db.collection("users").doc(id).get())
  );
  const nicknames: Record<string, string> = {};
  userDocs.forEach((doc, i) => {
    nicknames[allIds[i]] = doc.exists
      ? (doc.data()?.nickname as string) || ""
      : "";
  });

  const withNicknames = posts.map((p, i) => ({
    ...p,
    poster_nickname: nicknames[(p as { poster_id?: string }).poster_id || ""] || "",
    applicants_resolved: applicantIdsByPost[i].map((id) => ({
      id,
      nickname: nicknames[id] || "",
    })),
  }));

  return { success: true, posts: withNicknames, count: withNicknames.length };
});

// Closes ANY work_posts doc regardless of type - both the system-generated
// "partner_recruit" (group-invite) posts and the admin-authored "security"/
// "transport" (staff job) posts below share this one status machine
// (open -> filled -> closed), so one close endpoint covers both.
export const adminCloseWorkPost = onCall(async (request) => {
  await verifyAdmin(request);

  const { post_id } = request.data;
  if (!post_id) {
    throw new HttpsError("invalid-argument", "post_idが必要です。");
  }

  await db.collection("work_posts").doc(post_id).update({
    status: "closed",
  });

  await createAuditLog(
    request.auth!.uid,
    "close_work_post",
    "work_post",
    post_id,
    {},
    ""
  );

  return { success: true };
});

// Admin-authored staff job posting ("警備"/"送迎" - security/transport
// staff, per 管理機能仕様書.pdf §17.4 ⑨ "Staff jobs: create / hire
// applicants / stop"). Deliberately restricted to these 2 types -
// "partner_recruit" (group-invite) posts stay exclusively system-generated
// from reservations.ts's own group_invite/group_size write, matching this
// file's existing "moderation-only" comment for that type; admins should
// never be able to author one directly on a guest's behalf. Confirmed
// before writing this that NOTHING currently creates a "security"/
// "transport" work_posts doc anywhere in this backend (grepped reservations.
// ts and this whole file) - `admin_get_work_posts.dart`'s own
// `_workPostTypeLabel` already had defensive labels for both, written ahead
// of any real data existing, so this is filling an already-anticipated gap,
// not inventing a new shape.
export const adminCreateWorkPost = onCall(async (request) => {
  await verifyAdmin(request);

  const { type, description, date, location, fee } = request.data;
  if (type !== "security" && type !== "transport") {
    throw new HttpsError(
      "invalid-argument",
      'typeは"security"または"transport"である必要があります。'
    );
  }
  if (!description) {
    throw new HttpsError("invalid-argument", "descriptionが必要です。");
  }

  const parsedDate = date ? new Date(date) : null;
  if (date && (!parsedDate || isNaN(parsedDate.getTime()))) {
    throw new HttpsError("invalid-argument", "dateの形式が不正です。");
  }

  const docRef = await db.collection("work_posts").add({
    poster_id: request.auth!.uid,
    type,
    description,
    date: parsedDate ? Timestamp.fromDate(parsedDate) : null,
    location: location || "",
    fee: typeof fee === "number" ? fee : 0,
    status: "open",
    applicants: [],
    selected_id: "",
    created_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    "create_work_post",
    "work_post",
    docRef.id,
    { type, description },
    ""
  );

  return { success: true, post_id: docRef.id };
});

// Hires one applicant off a staff job post - sets status to "filled" and
// records selected_id. Validates the applicant actually appears in the
// post's own `applicants` array (populated by the cast/staff-side apply
// flow, which lives in the separate mobile-app project, not this backend)
// rather than trusting an arbitrary uid from the client. No type check
// against "partner_recruit" here (unlike adminCreateWorkPost) - group-
// invite posts fill themselves via the guest/cast app's own accept flow,
// never through this admin callable, so `applicants` on that type should
// always be empty in practice; if it somehow isn't, hiring from it isn't
// destructive (same status/selected_id fields either type uses) and isn't
// worth a special-cased rejection.
export const adminHireWorkPostApplicant = onCall(async (request) => {
  await verifyAdmin(request);

  const { post_id, applicant_id } = request.data;
  if (!post_id || !applicant_id) {
    throw new HttpsError(
      "invalid-argument",
      "post_idとapplicant_idが必要です。"
    );
  }

  const postRef = db.collection("work_posts").doc(post_id);
  const postSnap = await postRef.get();
  if (!postSnap.exists) {
    throw new HttpsError("not-found", "投稿が見つかりません。");
  }
  const applicants: string[] = postSnap.data()?.applicants || [];
  if (!applicants.includes(applicant_id)) {
    throw new HttpsError(
      "failed-precondition",
      "指定された応募者はこの投稿に応募していません。"
    );
  }

  await postRef.update({ status: "filled", selected_id: applicant_id });

  await createAuditLog(
    request.auth!.uid,
    "hire_work_post_applicant",
    "work_post",
    post_id,
    { applicant_id },
    ""
  );

  return { success: true };
});

