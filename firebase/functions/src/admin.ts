/**
 * Admin Panel API Cloud Functions
 * 管理機能ページ
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
// v1 SDK, used only by adminGetDashboardStats — see the comment on that
// function for why it stays on v1 instead of v2 like everything else here.
import * as functionsV1 from "firebase-functions/v1";
import { db, auth, stripe, Timestamp, FieldValue, isAllowedKycDocUrl, getSystemConfig, backfillServiceAreas, sendPushNotification, messaging } from "./config";
import { reservedSlotsQuery } from "./schedule";
import { MAX_CAST_IDS_PER_RESERVATION } from "./reservations";

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

  // NOTE (PROJECT_KNOWLEDGE.md §70 — comprehensive project-wide review):
  // this freely combines up to 5 optional equality filters with either a
  // nickname-prefix range search or a created_at range, each combination
  // needing its own composite index — Firestore throws
  // FAILED_PRECONDITION at runtime for any combination that isn't
  // indexed. firestore.indexes.json covers the combinations already known
  // to be exercised plus the most likely nickname-search combos
  // (approval_status/kyc_status/prefecture/account_type+approval_status,
  // each + nickname) — NOT every possible combination of all 5 filters
  // (32+ combinations, impractical to pre-index exhaustively for an admin
  // UI whose actual filter usage isn't built/known yet). If the admin
  // panel starts using a combination not listed there, add the matching
  // composite index rather than assuming this function is broken.
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
// FIX (confirmed live SSRF vulnerability, found during audit): `docUrl`
// (users.kyc_doc_url) used to be set by `submitKYC` (auth.ts) with NO URL
// validation, and (at the time this was first fixed) firestore.rules let a
// user write ANY field on their own `users/{uid}` doc directly from the
// client SDK, bypassing submitKYC entirely — so a malicious cast could set
// kyc_doc_url to an arbitrary URL (e.g. GCP's internal metadata endpoint,
// 169.254.169.254) via a direct Firestore write, then simply wait for an
// admin to do their normal job and approve the KYC submission, at which
// point the server did `fetch(docUrl)` with no restriction at all. Fixed
// then by allowlisting the URL to Firebase Storage's own download-URL
// hosts before ever fetching it (this project's KYC uploads only ever go
// through Firebase Storage, so nothing legitimate is excluded).
// `isAllowedKycDocUrl`/`ALLOWED_KYC_DOC_HOSTS` moved to config.ts
// (PROJECT_KNOWLEDGE.md §71) so `submitKYC` itself can validate at write
// time too, not just this one downstream consumer — defense in depth,
// independent of the firestore.rules fix (§70) that already closed the
// direct-write path this comment originally described.

async function forwardKycDocumentToStripe(stripeAccountId: string, docUrl: string): Promise<void> {
  if (!isAllowedKycDocUrl(docUrl)) {
    throw new Error(`Refusing to fetch KYC document from disallowed URL host: ${docUrl}`);
  }
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
  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): `approved` was written straight to `is_verified` with no
  // typeof check — the exact bug class already fixed elsewhere in this
  // file for adminToggleFreeze's `freeze` and adminUpdateAffiliateRate's
  // `new_rate`, missed here. generated_code's UsersRecord does a raw
  // `as bool?` cast when deserializing `is_verified` — a non-boolean value
  // here would throw a TypeError on every future read of that user's own
  // document anywhere in the app, not just KYC screens.
  if (typeof approved !== "boolean") {
    throw new HttpsError("invalid-argument", "approvedはtrue/falseで指定してください。");
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

  // FIX (confirmed live bug, found during audit): the audit log's own
  // `reason` used to default to bare "" even on rejection, while the
  // guest-facing notification right above it already had a real fallback
  // message ("書類に不備があります。") - the audit trail was silently less
  // informative than what the user themselves was told. Both now share the
  // same resolved reason.
  const resolvedReason = approved ? reason || "" : reason || "書類に不備があります。";

  await db.collection("users").doc(user_id).collection("notifications").add({
    type: "admin",
    title: approved ? "本人確認が承認されました" : "本人確認が却下されました",
    body: approved
      ? "全ての機能をご利用いただけます。"
      : `却下理由: ${resolvedReason}`,
    data: { approved },
    read: false,
    created_at: Timestamp.now(),
  });
  await sendPushNotification(
    user_id,
    approved ? "本人確認が承認されました" : "本人確認が却下されました",
    approved ? "全ての機能をご利用いただけます。" : `却下理由: ${resolvedReason}`,
    { type: "admin" }
  );

  await createAuditLog(
    request.auth!.uid,
    approved ? "approve_kyc" : "reject_kyc",
    "user",
    user_id,
    { reason: resolvedReason },
    resolvedReason
  );

  return { success: true, message: approved ? "承認しました。" : "却下しました。" };
});

export const adminToggleFreeze = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, freeze, reason } = request.data;

  // FIX (confirmed live bug, comprehensive review): `freeze` was written
  // to `is_frozen` with no type check, unlike this session's own established
  // discipline for boolean-typed inputs (respondToReservation's `accept`,
  // submitReview's `rating`). A non-boolean truthy value would be stored
  // verbatim and silently fail strict `!== true`/`=== true` checks
  // elsewhere (e.g. getDiscoveryCasts). Currently only admin-reachable, but
  // worth closing before any admin UI wires it up.
  if (typeof freeze !== "boolean") {
    throw new HttpsError("invalid-argument", "freezeはtrue/falseで指定してください。");
  }

  // `frozen_at` added per the client-confirmed decision (audit follow-up,
  // 2026-08-12) that freezing a REFERRED cast counts the same as that cast
  // leaving for that month's affiliate-forfeiture rule (§3.7.12) - only
  // written when freezing (not cleared on unfreeze, since the forfeiture
  // check this feeds is a one-way "was frozen during month X" test, same
  // month-scoping precision `left_at` already gives the voluntary-
  // withdrawal path). See affiliate.ts's `processAffiliatorPayment`.
  await db.collection("users").doc(user_id).update({
    is_frozen: freeze,
    ...(freeze ? { frozen_at: Timestamp.now() } : {}),
    updated_at: Timestamp.now(),
  });

  // FIX (confirmed live bug, found during audit): same "audit log less
  // informative than the user-facing notification" gap as adminApproveKYC
  // above - the notification's own fallback ("利用規約違反") wasn't reused
  // for the audit trail, which defaulted to bare "".
  const resolvedReason = freeze ? reason || "利用規約違反" : reason || "";

  await db.collection("users").doc(user_id).collection("notifications").add({
    type: "admin",
    title: freeze ? "アカウントが凍結されました" : "アカウントの凍結が解除されました",
    body: freeze ? `理由: ${resolvedReason}` : "全ての機能が再び利用可能です。",
    data: { freeze },
    read: false,
    created_at: Timestamp.now(),
  });
  await sendPushNotification(
    user_id,
    freeze ? "アカウントが凍結されました" : "アカウントの凍結が解除されました",
    freeze ? `理由: ${resolvedReason}` : "全ての機能が再び利用可能です。",
    { type: "admin" }
  );

  await createAuditLog(
    request.auth!.uid,
    freeze ? "freeze_account" : "unfreeze_account",
    "user",
    user_id,
    { reason: resolvedReason },
    resolvedReason
  );

  return { success: true };
});

export const adminForceDeleteUser = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, reason } = request.data;
  if (!user_id) {
    throw new HttpsError("invalid-argument", "user_idが必要です。");
  }

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

  const { user_id, self_introduction, clear_photo, reason } = request.data;

  if (!user_id) {
    throw new HttpsError("invalid-argument", "ユーザーIDが必要です。");
  }

  // FIX (§3.8.13, admin content moderation — PROJECT_KNOWLEDGE.md §71/§72):
  // this only ever handled `self_introduction`, missing the "profile-image"
  // half of §3.8.13's own "profile-image/self-intro content moderation
  // with edit power" wording. Added `clear_photo` (reset, not replace —
  // an admin removing an inappropriate photo, not uploading a new one; no
  // asset-upload capability exists in this toolset for the admin side
  // either, same standing limitation as everywhere else this session) as
  // an explicit boolean rather than overloading `self_introduction`'s own
  // "always write, empty-string default" behavior onto a second field.
  //
  // FIX: `self_introduction` only updates when a real, non-empty value is
  // sent — "blank means leave unchanged," the SAME convention
  // `adminUpsertCocotenShop`/`adminUpdateSystemConfig` already established
  // for exactly the same underlying reason: this DSL's TextField has no
  // supported way to pre-fill with the record's CURRENT value at authoring
  // time (`bindText`/`bindValue` both explicitly reject TextField,
  // confirmed elsewhere this session), so the admin UI's field starts
  // blank on every open — treating blank as "no change" avoids an
  // accidental full wipe of a real self-introduction just because the
  // admin only meant to clear the photo, or opened the form without typing
  // anything.
  const updateData: Record<string, any> = { updated_at: Timestamp.now() };
  if (self_introduction) {
    updateData.self_introduction = self_introduction;
  }
  if (clear_photo === true) {
    updateData.profile_image_url = "";
  }

  await db.collection("users").doc(user_id).update(updateData);

  await createAuditLog(
    request.auth!.uid,
    "update_profile",
    "user",
    user_id,
    { self_introduction, clear_photo },
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
// FIX (confirmed live bug, found during audit): this used to filter/sort on
// `scheduled_at` — a field that `createReservation` (reservations.ts) never
// writes; the real reservation date/time field, confirmed against the
// actual write site, is `date`. Firestore range/orderBy clauses only match
// documents that actually have the ordered field, so every call to this
// function returned an EMPTY list regardless of filters — this had never
// been exercised end-to-end (no admin UI exists yet), so the bug shipped
// silently. The `status+scheduled_at`/`cast_id+scheduled_at`/
// `guest_id+scheduled_at` indexes this comment used to cite as
// justification were themselves built for the same wrong field name (and
// `cast_id`, singular, was never a real field either — the real one is the
// `cast_ids` array) — replaced with `status+date`/`guest_id+date` in
// firestore.indexes.json to match what this function actually queries now.
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
      query = query.where("date", ">=", new Date(scheduled_after));
    }
    if (scheduled_before) {
      query = query.where("date", "<=", new Date(scheduled_before));
    }

    query = query.orderBy("date", "desc").limit(queryLimit || 50);

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

  // FIX (confirmed live bug, found during audit): previously no status
  // guard at all - could be called on an already-`completed`/`cancelled`
  // reservation, which is exactly the case most likely to hit the Stripe
  // failure this fix's other half addresses below.
  if (["completed", "cancelled", "expired"].includes(resData.status)) {
    throw new HttpsError(
      "failed-precondition",
      "この予約はすでに終了しているため、強制キャンセルできません。"
    );
  }

  if (resData.payment_intent_id) {
    // FIX (confirmed live bug, found during audit): the Stripe call used
    // to be wrapped in a try/catch that only logged the error and let
    // execution fall through to mark the reservation `cancelled`
    // regardless of whether Stripe actually released/captured anything -
    // an admin could end up with a reservation record that says
    // "cancelled" while the guest's card was never actually touched (or
    // was already captured/transferred and this call's attempt to touch
    // it again failed). Now rethrown as an HttpsError so the admin sees a
    // real failure instead of a false "success", and the reservation is
    // NOT marked cancelled unless the Stripe operation actually succeeded.
    try {
      if (refund_amount && refund_amount > 0) {
        // FIX (confirmed live bug, found during final precision audit):
        // this capture carried no `metadata.type` tag — unlike the
        // identical partial-capture-as-cancellation-fee pattern in
        // `cancelPayment` (stripe-payments.ts), which tags its own capture
        // with `metadata: { type: "cancellation" }` specifically so
        // `handlePaymentIntentSucceeded` (stripe-webhooks.ts)'s
        // `!paymentIntent.metadata?.type` gate skips its normal-completion
        // side effects for it. Left untagged, every admin partial-capture
        // force-cancel would: (1) race this function's own
        // `status: "cancelled"` write below with the webhook's
        // `status: "review_pending"`, whichever lands last winning; (2) call
        // `recordCastRewardsAndProcessOthers` using `resData.total_amount`
        // (the FULL original booking amount, not the admin-chosen
        // `refund_amount` actually captured), paying the cast(s) and
        // accruing an affiliate reward for a full-service completion funded
        // by a partial capture — a genuine platform-funded overpayment with
        // no corresponding revenue. Tagging `metadata.type` makes the
        // webhook treat this exactly like `cancelPayment`'s own
        // cancellation-fee capture, matching how `resolvedReason`/the
        // `ledger` entry below already frame this as a cancellation, not a
        // completion.
        const capturedPi = await stripe.paymentIntents.capture(resData.payment_intent_id, {
          amount_to_capture: refund_amount,
          metadata: { type: "cancellation" },
        });
        // FIX (confirmed live bug, found during audit): this partial-
        // capture path is real money movement (captures `refund_amount`
        // from the guest) but, unlike every other capture path in this
        // codebase, created no `ledger` entry for it at all - that amount
        // was captured but never split/accounted for anywhere. Recorded
        // here as a `cancellation_capture`-type entry (net_transfer 0 -
        // this captures FROM the guest, it doesn't transfer anything TO
        // anyone; a human admin decided the amount, not the cancellation-
        // fee matrix) so `adminGetLedger`'s ledger view at least surfaces
        // it.
        //
        // FIX (final precision audit second pass): originally typed
        // "refund" — confirmed via a repo-wide grep to be the only write
        // site using that exact type value other than `adminManualRefund`'s
        // OWN entry (this file, below), which is a GENUINE refund (money
        // back to the guest, `platform_profit: 0`) — the opposite meaning
        // of this row (a capture, `platform_profit: refund_amount`).
        // `computeLedgerSummary` summing "gross revenue captured" by type
        // would have had to either double-count real refunds as revenue or
        // ignore this real capture — renamed to disambiguate rather than
        // leaving two opposite-meaning rows sharing one type value.
        await db.collection("ledger").add({
          ledger_id: "",
          res_id,
          user_id: resData.guest_id,
          type: "cancellation_capture",
          gross_amount: refund_amount,
          cast_reward: 0,
          staff_fee: 0,
          stripe_fee: 0,
          platform_profit: refund_amount,
          tax_amount: 0,
          net_transfer: 0,
          amount: refund_amount,
          stripe_event_id: "",
          stripe_object_id: capturedPi.id,
          status: "confirmed",
          processed: true,
          created_at: Timestamp.now(),
        });
      } else {
        await stripe.paymentIntents.cancel(resData.payment_intent_id);
      }
    } catch (err: any) {
      console.error("Stripe cancel failed:", err);
      throw new HttpsError(
        "internal",
        `Stripe側の処理に失敗したため、強制キャンセルを中止しました: ${err.message}`
      );
    }
  }

  // FIX (confirmed live bug, found during audit): the audit log's own
  // `reason` used to default to bare "" while `cancel_reason` (the field
  // actually written to the reservation) already had a real fallback
  // message - the audit trail was silently less informative than the
  // reservation record itself. Both now share the same resolved reason.
  const resolvedReason = reason || "管理者による強制キャンセル";

  // Slot-lock release (PROJECT_KNOWLEDGE.md §68), folded into the same
  // transaction as the status write, added after the Stripe try/catch
  // above (which must still be allowed to throw and abort before any
  // Firestore write, unchanged) — an orphaned "reserved" schedule_slots
  // doc has no self-healing path, unlike the Stripe hold already released.
  await db.runTransaction(async (tx) => {
    const slotsSnap = await tx.get(reservedSlotsQuery(res_id));
    tx.update(db.collection("reservations").doc(res_id), {
      status: "cancelled",
      cancel_reason: resolvedReason,
      cancelled_by: "admin",
      updated_at: Timestamp.now(),
    });
    slotsSnap.forEach((slot) => tx.delete(slot.ref));
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
    { reason: resolvedReason, refund_amount },
    resolvedReason
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
  // FIX (PROJECT_KNOWLEDGE.md §70 — comprehensive project-wide review): a
  // non-numeric truthy `amount` (e.g. a string) used to silently fail the
  // coercive `amount > 0` check and fall through to a FULL refund instead
  // of the admin's intended partial amount — a real "admin asked for ¥1000
  // back, guest got everything" risk, not just a validation nicety.
  if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
    throw new HttpsError("invalid-argument", "amountは正の数値で指定してください。");
  }

  // FIX (comprehensive project-wide review round 2): no idempotencyKey was
  // passed here — an admin double-clicking "refund" (or a callable-function
  // client retry after a timed-out-but-actually-succeeded request) could
  // trigger two real refunds. Keyed on the reservation + amount so an
  // accidental duplicate request within Stripe's ~24h idempotency window is
  // deduped; a genuinely separate refund for the same reservation/amount
  // issued later still goes through once the key expires.
  const refund = await stripe.refunds.create(
    {
      payment_intent: resData.payment_intent_id,
      ...(amount ? { amount } : {}),
    },
    { idempotencyKey: `refund_${res_id}_${amount || "full"}` }
  );

  const ledgerRef = db.collection("ledger").doc();
  await ledgerRef.set({
    ledger_id: ledgerRef.id,
    res_id,
    user_id: resData.guest_id || "",
    type: "refund",
    // FIX (PROJECT_KNOWLEDGE.md §70): used to always log the reservation's
    // FULL original total here, even for a partial refund — misleading
    // next to `amount: refund.amount` (the actual amount that moved) in
    // the same ledger row. Use the real refunded amount for both fields,
    // matching the sibling adminForceCancel partial-capture write's own
    // correct convention (`gross_amount: refund_amount`).
    gross_amount: refund.amount,
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

  // FIX (confirmed live bug, final precision audit second pass): a refund
  // on a `"completed"` reservation happens AFTER `submitReview` has already
  // called `transferPendingCastRewards` (reservations.ts) — the cast(s) on
  // this reservation have already received a real Stripe transfer for it.
  // This used to have no clawback at all: the platform would be out both
  // the refunded amount AND the reward already paid out, with no recovery
  // mechanism and no audit trail connecting the two. `"review_pending"`
  // reservations are unaffected — reward transfer only happens once a
  // review is actually submitted, so no clawback is needed there. Recovered
  // via the same `logical_debt`/`debt_history` mechanism already used
  // elsewhere in this file for platform-absorbed costs (e.g. the
  // cancellation Stripe-fee split above), split evenly across the casts
  // actually on this reservation — not a Stripe transfer reversal (higher-
  // risk, can fail on insufficient destination balance, and this codebase
  // has no precedent for reversing a Connect transfer already treated as
  // final).
  if (resData.status === "completed") {
    const castIdsForClawback: string[] = resData.cast_ids || [];
    const perCastClawback =
      castIdsForClawback.length > 0 ? Math.floor(refund.amount / castIdsForClawback.length) : 0;

    for (const castId of castIdsForClawback) {
      await db.runTransaction(async (tx) => {
        const castRef = db.collection("users").doc(castId);
        const castDoc = await tx.get(castRef);
        const currentDebt = castDoc.data()?.logical_debt || 0;

        tx.update(castRef, {
          logical_debt: currentDebt + perCastClawback,
          updated_at: Timestamp.now(),
        });
      });

      await db.collection("debt_history").add({
        user_id: castId,
        amount: perCastClawback,
        reason: "管理者による返金（完了済み予約・報酬支払い済み）",
        res_id,
        created_at: Timestamp.now(),
      });
    }
  }

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

  const { res_id, meeting_point_address, location_address, reason } = request.data;
  if (!res_id) {
    throw new HttpsError("invalid-argument", "res_idが必要です。");
  }

  const resDoc = await db.collection("reservations").doc(res_id).get();
  if (!resDoc.exists) {
    throw new HttpsError("not-found", "予約が見つかりません。");
  }

  // FIX (comprehensive project-wide review round 2): this used to always
  // stamp `updated_at: Timestamp.now()`, with no status guard at all — a
  // routine "fix a typo in the address" edit on an already-`completed`
  // reservation silently shifted `affiliate.ts`'s `countUniqueWorkDays` and
  // `getAffiliateDashboard`, both of which range-query `status ==
  // "completed"` reservations by `updated_at` as a completion-date proxy.
  // The reservation would vanish from the JST month/day it actually
  // completed in (risking an affiliator missing `minDays` for a payout
  // already earned) and reappear as "completed today" in whatever month the
  // edit happens. This field isn't completion-relevant, so it's simply not
  // touched by this function at all anymore.
  const updates: Record<string, unknown> = {};
  if (meeting_point_address !== undefined) {
    updates.meeting_point_address = meeting_point_address;
  }
  if (location_address !== undefined) {
    updates.location_address = location_address;
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "meeting_point_addressかlocation_addressのいずれかを指定してください。"
    );
  }

  await db.collection("reservations").doc(res_id).update(updates);

  await createAuditLog(
    request.auth!.uid,
    "update_reservation_location",
    "reservation",
    res_id,
    { meeting_point_address, location_address, reason },
    reason || ""
  );

  return { success: true };
});

// ============================================
// Affiliate Management
// ============================================

export const adminUpdateAffiliateRate = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id, new_rate } = request.data;

  // FIX (confirmed live bug, comprehensive review): the range/step checks
  // below use `<`/`>`/`%`, which all auto-coerce a numeric STRING (e.g.
  // "0.10") — it would pass every check here and get written to Firestore
  // as a string, a real type-integrity gap in a monetary config field.
  // Downstream `*` multiplication in `processAffiliateRewards` happens to
  // also auto-coerce, so this was latent rather than actively broken, but
  // worth closing at the boundary rather than relying on that.
  if (typeof new_rate !== "number") {
    throw new HttpsError("invalid-argument", "new_rateは数値で指定してください。");
  }

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

  // FIX (confirmed live bug, final precision audit second pass): the dedup
  // key used to be `res_id` alone — correct for the ORIGINAL case this
  // logic was written for (one capture event fanned out across multiple
  // casts, identical gross_amount/platform_profit per row), but WRONG once
  // a reservation can have MULTIPLE, genuinely-different reward-fanout
  // events over its lifetime (a base capture, plus a LATER extension
  // capture via `captureAuthorizedExtensions`, plus a cancellation-arrival
  // tier via `recordCancellationCastRewards` — both confirmed real
  // `type:"reward"` writers for the same `res_id` with their OWN distinct
  // amounts). Deduping by `res_id` alone silently dropped every later
  // event's contribution, undercounting real captured revenue with no
  // error. Keyed on `(res_id, gross_amount, platform_profit)` instead —
  // still collapses the true N-casts-one-event duplicate case (identical
  // triple), while treating genuinely different capture events (different
  // amounts) as the separate revenue they are.
  const seenRewardKeys = new Set<string>();
  let grossTotal = 0;
  let platformProfitTotal = 0;
  for (const row of rows) {
    if (row.type === "reward" && row.res_id) {
      const key = `${row.res_id}|${row.gross_amount || 0}|${row.platform_profit || 0}`;
      if (!seenRewardKeys.has(key)) {
        seenRewardKeys.add(key);
        grossTotal += row.gross_amount || 0;
        platformProfitTotal += row.platform_profit || 0;
      }
    } else if (row.type === "tip") {
      grossTotal += row.gross_amount || 0;
    } else if (row.type === "cancellation_fee" || row.type === "cancellation_capture") {
      // FIX (confirmed live bug, final precision audit second pass): both
      // types represent real Stripe captures with no corresponding
      // `type:"reward"` row (no cast reward on these — see their own write
      // sites), so they were invisible to this summary entirely despite
      // being real captured revenue. Each is a single row per event
      // (never fanned out per-cast), so no dedup is needed here.
      grossTotal += row.gross_amount || 0;
      platformProfitTotal += row.platform_profit || 0;
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
    reason,
  } = data;

  // FIX (PROJECT_KNOWLEDGE.md §70, MEDIUM-HIGH — comprehensive project-wide
  // review): `active` was written straight through with no typeof check —
  // same bug class as adminApproveKYC's `approved` above.
  // generated_code's BannersRecord does a raw `as bool?` cast when
  // deserializing `active` — a non-boolean value crashes that read on the
  // home page, for every guest, not just admins. Also added presence
  // checks on `title`/`image_url`, which were previously used with no
  // fallback at all — creating a banner without them threw Firestore's raw
  // "Cannot use undefined as a Firestore value" instead of a clean message.
  if (active !== undefined && typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "activeはtrue/falseで指定してください。");
  }

  // FIX (Task #23, admin banner-management UI): this function used to
  // build `bannerData` from ONLY the fields passed in this call, defaulting
  // every omitted field (`link_url`, `page`, `display_order`, `advertiser`,
  // `display_days`, `start_date`) to a hardcoded fallback and writing that
  // over the EXISTING document via `.update()` — meaning a caller that only
  // wants to flip `active` (a per-row toggle, the obvious admin-UI shape)
  // would silently wipe every other field back to its default on every
  // toggle, including resetting `start_date` to "now" — a real correctness
  // bug for any banner using a display-day-limited window. Fixed to
  // partial-update semantics on the update path: read the existing doc
  // first, and any field not explicitly provided in this call falls back to
  // the EXISTING value, not a hardcoded default. `title`/`image_url` remain
  // required on CREATE (no existing doc to fall back to) but are now
  // optional on UPDATE. Callers that already pass every field (the original
  // full-form admin UI, if one exists elsewhere) see zero behavior change.
  let existingData: FirebaseFirestore.DocumentData = {};
  if (banner_id) {
    const existingSnap = await db.collection("banners").doc(banner_id).get();
    if (!existingSnap.exists) {
      throw new HttpsError("not-found", "バナーが見つかりません。");
    }
    existingData = existingSnap.data() || {};
  }

  const resolvedTitle = title ?? existingData.title;
  const resolvedImageUrl = image_url ?? existingData.image_url;
  if (!resolvedTitle || !resolvedImageUrl) {
    throw new HttpsError("invalid-argument", "titleとimage_urlが必要です。");
  }

  const bannerData = {
    title: resolvedTitle,
    image_url: resolvedImageUrl,
    link_url: link_url ?? existingData.link_url ?? "",
    page: page ?? existingData.page ?? "home",
    display_order: display_order ?? existingData.display_order ?? 0,
    active: active !== undefined ? active : (existingData.active ?? true),
    advertiser: advertiser ?? existingData.advertiser ?? "",
    display_days: display_days ?? existingData.display_days ?? 0,
    start_date: start_date
      ? new Date(start_date)
      : existingData.start_date ?? Timestamp.now(),
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
    { title: resolvedTitle, page: bannerData.page, active: bannerData.active, reason },
    reason || ""
  );

  return { success: true };
});

// New function, never previously deployed, so the standard v2 onCall SDK
// is safe here (no 1st-gen-live conflict like adminUpsertBanner above).
export const adminDeleteBanner = onCall(async (request) => {
  await verifyAdmin(request);

  const { banner_id, reason } = request.data;

  if (!banner_id) {
    throw new HttpsError("invalid-argument", "banner_idが必要です。");
  }

  await db.collection("banners").doc(banner_id).delete();

  await createAuditLog(
    request.auth!.uid,
    "delete_banner",
    "banner",
    banner_id,
    { reason },
    reason || ""
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
  // Backfilled in place (see config.ts's `backfillServiceAreas` for the
  // full reasoning) so BOTH `areaActive()` below AND the `...data` spread
  // in this function's own return statement see `lat`/`lng`/
  // `municipalities` even for a document saved before those fields
  // existed — this is the admin-facing read path
  // (`fetchAdminServiceAreaMunicipalities`/`callAdminUpdateServiceAreas`
  // both consume this response), a separate code path from
  // `getSystemConfig()` (guest-facing `getServiceAreaCoordinates`), which
  // has its own identical backfill.
  data.service_areas = backfillServiceAreas(data.service_areas);
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

  // FIX (confirmed live bug, found during audit): this never destructured
  // `reason` from `request.data` at all — unlike every sibling mutation in
  // this file (adminAddServiceAreaMunicipality, adminUpsertCocotenShop,
  // adminUpdateCocotenGenres, etc.), the audit log below wrote a bare
  // hardcoded string with no way for a caller to ever supply a real reason,
  // even though this endpoint can change monetary config (rates, fees,
  // day-of-month thresholds). Now accepted and threaded the same way as
  // every other admin mutation in this file.
  const { settings, reason } = request.data;

  // FIX (confirmed live bug, found during audit): `affiliate_payment_day`
  // drove processMonthlyAffiliatePayments' `jstDay !== paymentDay` gate
  // (affiliate.ts) with zero validation here - a value of 29/30/31 would
  // never match in any month that day doesn't exist in (e.g. 31 matches
  // nowhere in Feb/Apr/Jun/Sep/Nov), silently delaying that month's
  // payment run until the day recurs. Clamped to 1-28 so it's guaranteed to
  // fire in every calendar month, matching the standard fix for a
  // day-of-month config field.
  if (settings && settings.affiliate_payment_day !== undefined) {
    const day = settings.affiliate_payment_day;
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new HttpsError(
        "invalid-argument",
        "affiliate_payment_dayは1〜28の整数で指定してください。"
      );
    }
  }

  // FIX (comprehensive project-wide review round 2, SUSPECTED-turned-
  // confirmed-real-risk): every other numeric field here used to be
  // written verbatim with zero bounds checking. This is an admin-trust-
  // boundary issue (requires a careless/compromised admin, not a public
  // attacker), but the failure modes are severe and easy to trigger by
  // accident — e.g. `max_total_hours: 0` would make every reservation's
  // `duration_minutes > config.max_total_hours * 60` check reject every
  // booking outright (reservations.ts), a negative `tax_rate` would
  // produce a negative `tax_amount`, and `default_cast_rate` outside
  // [0, 1] would push `platform_profit` deeply negative in every payment
  // (stripe-payments.ts). Bounds chosen from each field's own real usage:
  // rates are fractions of 1, fees/thresholds are non-negative amounts,
  // `max_total_hours`/`extension_limit_count` must be positive integers a
  // real reservation could plausibly hit.
  const rateFields: Array<[string, number, number]> = [
    ["default_cast_rate", 0, 1],
    ["tax_rate", 0, 1],
    ["default_affiliate_rate", 0, 1],
  ];
  for (const [key, min, max] of rateFields) {
    if (settings && settings[key] !== undefined) {
      const v = settings[key];
      if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
        throw new HttpsError("invalid-argument", `${key}は${min}〜${max}の数値で指定してください。`);
      }
    }
  }
  const nonNegativeFields = [
    "security_staff_fee",
    "transport_staff_fee",
    "transport_fee_amount",
    "transport_fee_threshold_sec",
    "chat_close_sec",
  ];
  for (const key of nonNegativeFields) {
    if (settings && settings[key] !== undefined) {
      const v = settings[key];
      if (typeof v !== "number" || Number.isNaN(v) || v < 0) {
        throw new HttpsError("invalid-argument", `${key}は0以上の数値で指定してください。`);
      }
    }
  }
  const positiveIntFields: Array<[string, number]> = [
    ["max_total_hours", 24],
    ["extension_limit_count", 20],
    ["affiliate_min_days", 31],
  ];
  for (const [key, max] of positiveIntFields) {
    if (settings && settings[key] !== undefined) {
      const v = settings[key];
      if (!Number.isInteger(v) || v < 1 || v > max) {
        throw new HttpsError("invalid-argument", `${key}は1〜${max}の整数で指定してください。`);
      }
    }
  }

  await db.collection("system_config").doc("settings").set(settings, { merge: true });

  await createAuditLog(
    request.auth!.uid,
    "update_system_config",
    "system",
    "settings",
    settings,
    reason || "システム設定の更新"
  );

  return { success: true };
});

// Municipality-level service areas (unimplemented-features pass,
// IMPLEMENTATION_PLAN.md §3.8 item 5's remaining "add/edit municipalities
// and their representative GPS coordinates" half — the prefecture-level
// activate/deactivate half already goes through `adminUpdateSystemConfig`
// above via `ServiceAreaPage`'s own `callAdminUpdateServiceAreas`).
//
// Deliberately DEDICATED, validated functions rather than routing this
// through `adminUpdateSystemConfig`'s own generic `{settings: {...}}`
// path (which technically COULD write `service_areas` directly, since
// that function does zero shape validation on it) — same reasoning
// already applied to `adminUpdateCocotenGenres` earlier this session:
// this data feeds directly into the Home-ranking GPS-fallback distance
// calculation every guest sees (`getServiceAreaCoordinates`,
// `fetchDiscoveryCasts` in dsl/edit.dart), so a typo'd/garbage
// coordinate here has real guest-facing impact, worth real validation
// rather than accepting whatever shape the generic updater is handed.
function findServiceAreaByPrefecture(
  areas: Array<Record<string, unknown>>,
  prefecture: string
): Record<string, unknown> | undefined {
  return areas.find((a) => a.prefecture === prefecture);
}

export const adminAddServiceAreaMunicipality = onCall(async (request) => {
  await verifyAdmin(request);

  const { prefecture, name, lat, lng, reason } = request.data;
  if (typeof prefecture !== "string" || !prefecture) {
    throw new HttpsError("invalid-argument", "prefectureが必要です。");
  }
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    throw new HttpsError("invalid-argument", "市区町村名が必要です。");
  }
  if (typeof lat !== "number" || Number.isNaN(lat) || lat < 20 || lat > 46) {
    throw new HttpsError("invalid-argument", "緯度は20〜46の数値で指定してください（日本国内の範囲）。");
  }
  if (typeof lng !== "number" || Number.isNaN(lng) || lng < 122 || lng > 154) {
    throw new HttpsError("invalid-argument", "経度は122〜154の数値で指定してください（日本国内の範囲）。");
  }

  const config = await getSystemConfig();
  const areas = (config.service_areas || []) as Array<Record<string, unknown>>;
  const target = findServiceAreaByPrefecture(areas, prefecture);
  if (!target) {
    throw new HttpsError(
      "invalid-argument",
      `prefecture "${prefecture}" はサービス提供エリアに存在しません。`
    );
  }

  const existing = Array.isArray(target.municipalities)
    ? (target.municipalities as Array<Record<string, unknown>>)
    : [];
  if (existing.some((m) => m.name === trimmedName)) {
    throw new HttpsError("already-exists", `"${trimmedName}" は既に登録されています。`);
  }
  target.municipalities = [...existing, { name: trimmedName, lat, lng }];

  await db.collection("system_config").doc("settings").set({ service_areas: areas }, { merge: true });

  await createAuditLog(
    request.auth!.uid,
    "add_service_area_municipality",
    "system_config",
    "settings",
    { prefecture, name: trimmedName, lat, lng },
    reason || ""
  );

  return { success: true, municipalities: target.municipalities };
});

export const adminRemoveServiceAreaMunicipality = onCall(async (request) => {
  await verifyAdmin(request);

  const { prefecture, municipality_name, reason } = request.data;
  if (typeof prefecture !== "string" || !prefecture) {
    throw new HttpsError("invalid-argument", "prefectureが必要です。");
  }
  if (typeof municipality_name !== "string" || !municipality_name) {
    throw new HttpsError("invalid-argument", "municipality_nameが必要です。");
  }

  const config = await getSystemConfig();
  const areas = (config.service_areas || []) as Array<Record<string, unknown>>;
  const target = findServiceAreaByPrefecture(areas, prefecture);
  if (!target) {
    throw new HttpsError(
      "invalid-argument",
      `prefecture "${prefecture}" はサービス提供エリアに存在しません。`
    );
  }

  const existing = Array.isArray(target.municipalities)
    ? (target.municipalities as Array<Record<string, unknown>>)
    : [];
  target.municipalities = existing.filter((m) => m.name !== municipality_name);

  await db.collection("system_config").doc("settings").set({ service_areas: areas }, { merge: true });

  await createAuditLog(
    request.auth!.uid,
    "remove_service_area_municipality",
    "system_config",
    "settings",
    { prefecture, municipality_name },
    reason || ""
  );

  return { success: true, municipalities: target.municipalities };
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
  if (!report_id) {
    throw new HttpsError("invalid-argument", "report_idが必要です。");
  }

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
  const reportData = reportDoc.data()!;
  const resId = reportData.res_id;
  if (!resId) {
    return { success: true, messages: [], message_count: 0, no_chat_reason: "この通報には関連する予約がありません。" };
  }

  // FIX (PROJECT_KNOWLEDGE.md §70): this used to fetch a single room via
  // `.where("res_id","==",resId).limit(1)` — ambiguous once a group-invite
  // reservation has a second chat_rooms doc for the same res_id (the
  // cast-to-cast coordination room work-posts.ts creates), and unlike the
  // guest/cast-facing lookups (sendChatMessage etc.), an admin isn't a
  // participant of either room, so filtering by `participants array-
  // contains uid` isn't available here. Instead: fetch EVERY room for this
  // res_id, and prefer the one whose participants include BOTH the
  // reporter and the reported user (the actually-relevant room for this
  // report) — falling back to merging messages from every matching room,
  // labeled by room, so a report tied to an ambiguous case never silently
  // loses evidence instead of just picking the wrong room.
  const chatRoomsSnap = await db.collection("chat_rooms").where("res_id", "==", resId).get();
  if (chatRoomsSnap.empty) {
    return { success: true, messages: [], message_count: 0, no_chat_reason: "チャットルームが見つかりません。" };
  }

  const reporterId = reportData.reporter_id;
  const reportedId = reportData.reported_id;
  const relevantRoom = chatRoomsSnap.docs.find((d) => {
    const participants: string[] = d.data().participants || [];
    return participants.includes(reporterId) && participants.includes(reportedId);
  });
  const roomsToRead = relevantRoom ? [relevantRoom] : chatRoomsSnap.docs;

  const messagesByRoom = await Promise.all(
    roomsToRead.map(async (roomDoc) => {
      const snap = await roomDoc.ref.collection("messages").orderBy("created_at", "asc").get();
      return snap.docs.map((d) => ({ roomId: roomDoc.id, doc: d }));
    })
  );
  const flatMessages = messagesByRoom.flat();

  const senderIds = Array.from(
    new Set(flatMessages.map((m) => m.doc.data().sender_id).filter((v): v is string => !!v))
  );
  const senderNicknames: Record<string, string> = {};
  await Promise.all(
    senderIds.map(async (uid) => {
      const userDoc = await db.collection("users").doc(uid).get();
      senderNicknames[uid] = userDoc.exists ? userDoc.data()?.nickname || uid : uid;
    })
  );

  const messages = flatMessages.map(({ roomId, doc: d }) => {
    const data = d.data();
    return {
      id: d.id,
      room_id: roomId,
      sender_id: data.sender_id || "",
      sender_nickname: senderNicknames[data.sender_id] || data.sender_id || "",
      text: data.text || "",
      created_at: data.created_at || null,
    };
  });

  return { success: true, messages, message_count: messages.length };
});

// FIX (feature build, unimplemented-features pass — IMPLEMENTATION_PLAN.md
// §3.8.12): admin moderation had a report/chat-log path for RESERVATION-
// scoped chat (`adminGetReportChatLog` above) but nothing scoped to the
// separate cast-to-cast recruitment-board chat (`work_posts` type
// "partner_recruit", created by `selectWorkApplicant` — see that
// function's own comment, work-posts.ts). Mirrors `adminGetReportChatLog`'s
// shape (message list + resolved sender nicknames) but looks up the chat
// room via the work_post's own `chat_room_id` (also newly persisted by
// this same pass — it used to only be returned to the caller, never
// saved) instead of a report's `res_id`.
export const adminGetRecruitmentChatLog = onCall(async (request) => {
  await verifyAdmin(request);

  const { post_id } = request.data;
  if (!post_id) {
    throw new HttpsError("invalid-argument", "post_idが必要です。");
  }

  const postDoc = await db.collection("work_posts").doc(post_id).get();
  if (!postDoc.exists) {
    return { success: false, error: "投稿が見つかりません。" };
  }
  const postData = postDoc.data()!;
  const chatRoomId = postData.chat_room_id;
  if (!chatRoomId) {
    return {
      success: true,
      messages: [],
      message_count: 0,
      no_chat_reason: "この投稿にはまだチャットルームがありません（応募者が選定されていない可能性があります）。",
    };
  }

  const messagesSnap = await db
    .collection("chat_rooms")
    .doc(chatRoomId)
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

    // FIX (confirmed live bug, found during audit): `reason` was never
    // destructured from `data` at all — unlike every other admin mutation in
    // this file, none of the 3 audit-log call sites below (on_hold/rejected/
    // approve) had any way to receive a caller-supplied reason; each wrote a
    // bare hardcoded placeholder string instead. This is real-money oversight
    // (withdrawal-queue approve/hold/reject) — the same "hardcoded reason,
    // not threaded from caller input" gap already fixed elsewhere in this
    // file (adminApproveKYC, adminToggleFreeze, adminForceCancel). Now
    // accepted and threaded, falling back to the same default text as
    // before when omitted.
    const { requestId, action, reason } = data;
    if (!requestId) {
      throw new functionsV1.https.HttpsError("invalid-argument", "requestIdが必要です。");
    }

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
        { user_id: userId, reason },
        reason || (action === "on_hold" ? "出金保留" : "出金否認")
      );
      return { success: true };
    }

    // FIX (confirmed live bug, found during audit): this used to fall
    // through to the real-money "approve" branch below for ANY value of
    // `action` other than the two explicitly checked above - undefined,
    // null, a typo like "aprove", or garbage all silently triggered a real
    // `stripe.payouts.create()` call. Currently unreachable (no caller
    // exists anywhere in this app's DSL - the admin panel UI, Phase 12,
    // isn't built yet), but this callable is still deployed and directly
    // callable by any admin account regardless, so a client-side bug/typo
    // in a future admin UI must not be able to silently trigger a real
    // payout. Require the exact value instead of treating everything else
    // as an implicit approve.
    if (action !== "approve") {
      throw new functionsV1.https.HttpsError(
        "invalid-argument",
        `不正なactionです: ${action}`
      );
    }

    // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
    // review): this "approve" branch used to go straight from the initial
    // `requestDoc.get()` at the top of the function into a real
    // `stripe.payouts.create()` call with NO re-check of `requestData.status`
    // immediately before it — two calls with `action:"approve"` on the SAME
    // `requestId` (double-click, a client retry, or two admins racing) could
    // both pass through, each retrieving the live Stripe balance and each
    // creating a separate real payout, potentially paying out MORE than the
    // cast's actual available balance across the two calls. Same bug class
    // already fixed elsewhere in this file for adminForceCancel ("previously
    // no status guard at all") — that fix was never applied here. Fixed with
    // a transactional claim (pending -> processing) that only one concurrent
    // caller can win, mirroring transferPendingCastRewards' identical fix
    // (stripe-payments.ts) for the same race shape.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection("payout_requests").doc(requestId));
      if (!snap.exists || snap.data()?.status !== "pending") {
        return false;
      }
      tx.update(snap.ref, { status: "processing", updated_at: Timestamp.now() });
      return true;
    });
    if (!claimed) {
      throw new functionsV1.https.HttpsError(
        "failed-precondition",
        "この出金申請はすでに処理されています。"
      );
    }

    // Explicit "approve": original immediate-payout flow, now also
    // updating the source request's status.
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // FIX (confirmed live bug, final precision audit second pass): this
    // branch went straight from the claim to a real `stripe.payouts.create()`
    // with no re-check of the requesting user's frozen state — an admin
    // freezing an account for fraud/ToS violation AFTER that account already
    // had a pending payout request (the exact scenario freezing exists to
    // stop) would not block this approval at all; the admin queue view
    // itself also had no way to surface that the requester was frozen. Same
    // revert-and-reject pattern as the missing-stripe_account_id guard right
    // below, so the request isn't left stuck in "processing" forever.
    if (userData?.is_frozen) {
      await db.collection("payout_requests").doc(requestId).update({ status: "pending" });
      throw new functionsV1.https.HttpsError(
        "failed-precondition",
        "このユーザーは凍結されているため出金を承認できません。"
      );
    }

    // FIX (comprehensive review, confirmed bug — same class as the
    // is_frozen fix immediately above, just not generalized to this field):
    // `requestPayout` (stripe-payments.ts) blocks creating a payout request
    // at all while `logical_debt > 0`, but `payout_requests`'s own create
    // rule lets a client write a request doc directly (a separate,
    // already-disclosed low-severity gap — PROJECT_KNOWLEDGE.md), bypassing
    // that check. Without a re-check here, an admin approving such a
    // request pays out the cast's full live Stripe balance while their debt
    // stays uncollected — and since debt is only ever recouped by deducting
    // from FUTURE reward transfers, a cast who stops taking bookings after
    // this makes it permanently uncollectable. Same revert-and-reject
    // pattern as the two guards above/below, so the request isn't left
    // stuck in "processing".
    if ((userData?.logical_debt || 0) > 0) {
      await db.collection("payout_requests").doc(requestId).update({ status: "pending" });
      throw new functionsV1.https.HttpsError(
        "failed-precondition",
        "このユーザーには未精算の債務があるため出金を承認できません。"
      );
    }

    if (!userData?.stripe_account_id) {
      // Claimed above but can't proceed — revert the claim so the request
      // isn't stuck "processing" forever with no payout ever attempted.
      await db.collection("payout_requests").doc(requestId).update({ status: "pending" });
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

      // FIX (confirmed live bug, found during final precision audit):
      // `stripe_payout_id` was never persisted onto this doc (only ever
      // returned to the caller and buried in a notification payload) —
      // `handlePayoutPaid`/`handlePayoutFailed` (stripe-webhooks.ts) had no
      // way to look up which payout_requests doc a given Stripe `payout.id`
      // corresponds to, so those handlers were dead-end no-op stubs by
      // construction: status stayed "approved" forever regardless of
      // whether the payout actually landed or bounced (bad bank details,
      // account restricted, etc.) on Stripe's side days later. Persisting
      // it here is what makes the webhook-side fix (see that file) able to
      // find this doc at all.
      await db.collection("payout_requests").doc(requestId).update({
        status: "approved",
        stripe_payout_id: payout.id,
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
      await sendPushNotification(
        userId,
        "出金が承認されました",
        `¥${available.amount.toLocaleString()} の出金処理を開始しました。`,
        { payout_id: payout.id, type: "stripe" }
      );

      await createAuditLog(
        context.auth!.uid,
        "approve_payout",
        "user",
        userId,
        { amount: available.amount, payout_id: payout.id, request_id: requestId, reason },
        reason || "出金承認"
      );

      return { success: true, payout_id: payout.id, amount: available.amount };
    } catch (err: any) {
      // Revert the "processing" claim from above — `stripe.payouts.create`
      // either succeeds fully or throws (no partial state), so if we're
      // here the payout genuinely never happened and this request must be
      // retryable, not stuck forever in a status nothing can ever claim
      // again.
      await db.collection("payout_requests").doc(requestId).update({ status: "pending" });
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
        // FIX (confirmed live bug, final precision audit second pass): this
        // queue view had no way to show a reviewing admin that the
        // requester is frozen — the approve action itself is now also
        // gated (see adminApprovePayout above), but surfacing it here too
        // means a frozen request is visibly flagged before an admin ever
        // clicks approve, not just silently rejected after the fact.
        let isFrozen = false;

        try {
          const userDoc = await db.collection("users").doc(userId).get();
          const userData = userDoc.data();
          isFrozen = userData?.is_frozen === true;
          const stripeAccountId = userData?.stripe_account_id;
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
          is_frozen: isFrozen,
        };
      })
    );

    return { success: true, requests };
  });

// Account-deletion block-status monitor (§3.9.15 / IMPLEMENTATION_PLAN.md
// item 15's "no precedent" half). Read-only mirror of requestWithdrawal's
// (auth.ts) own three block checks — debt / active reservation (guest or
// cast side) / pending ledger entry — so an admin can see WHY a specific
// user is currently blocked from self-service deletion before deciding
// whether to use adminForceDeleteUser's existing bypass. Deliberately
// duplicates the three queries rather than extracting a shared helper:
// requestWithdrawal's version throws on the FIRST failing check (early
// exit, correct for its own gating purpose), whereas this needs all three
// results simultaneously to render a full status breakdown.
export const adminGetAccountDeletionStatus = onCall(async (request) => {
  await verifyAdmin(request);

  const { user_id } = request.data;
  if (!user_id) {
    throw new HttpsError("invalid-argument", "user_idが必要です。");
  }

  const userDoc = await db.collection("users").doc(user_id).get();
  const userData = userDoc.data();
  if (!userData) {
    throw new HttpsError("not-found", "ユーザーが見つかりません。");
  }

  const logicalDebt = userData.logical_debt || 0;
  const blockedByDebt = logicalDebt > 0;

  const [activeGuestRes, activeCastRes, pendingLedger] = await Promise.all([
    db
      .collection("reservations")
      .where("guest_id", "==", user_id)
      .where("status", "not-in", ["completed", "cancelled", "expired"])
      .limit(1)
      .get(),
    db
      .collection("reservations")
      .where("cast_ids", "array-contains", user_id)
      .where("status", "not-in", ["completed", "cancelled", "expired"])
      .limit(1)
      .get(),
    db
      .collection("ledger")
      .where("user_id", "==", user_id)
      .where("status", "==", "pending")
      .limit(1)
      .get(),
  ]);

  const blockedByReservation = !activeGuestRes.empty || !activeCastRes.empty;
  const blockedByLedger = !pendingLedger.empty;

  return {
    success: true,
    blocked: blockedByDebt || blockedByReservation || blockedByLedger,
    blocked_by_debt: blockedByDebt,
    logical_debt: logicalDebt,
    blocked_by_reservation: blockedByReservation,
    blocked_by_ledger: blockedByLedger,
    is_active: userData.is_active !== false,
  };
});

// Admin notification/moderation center — push-send half (§3.8.16).
// `firestore.rules` locks `/users/{document}` reads to
// `request.auth.uid == document` (PROJECT_KNOWLEDGE.md §70's critical
// privilege-escalation fix), so a client-side bulk broadcast to "all
// users" is not possible from the admin's own client — this MUST be
// Admin-SDK/server-side, same reasoning already established for every
// other cross-user bulk operation in this file.
//
// Architecture decision (no prior precedent for "push" in this app —
// confirmed by reading the whole DSL: no `app.pushNotifications()`/FCM
// token capture exists anywhere): this app's actual, already-live
// "notification" system IS the `users/{uid}/notifications` subcollection
// (5-category `matching`/`work`/`cocoten`/`stripe`/`admin`, read by
// NotificationsPage's own "お知らせ" list, written by numerous existing
// Cloud Functions for individual events). Building brand-new native-push
// (FCM token registration, `app.pushNotifications()` enablement, an
// entirely separate delivery pipeline) to satisfy one admin composer
// feature would be new infrastructure far beyond this task's scope and
// without a clear product requirement for a SECOND parallel notification
// channel. "Push-send" is implemented here as an admin-composed broadcast
// into that SAME, already-established 5-category system — consistent
// with every existing consumer of `users/{uid}/notifications`, requiring
// no new client infrastructure.
export const adminSendNotification = onCall(async (request) => {
  await verifyAdmin(request);

  const { category, title, body, target } = request.data;
  const allowedCategories = ["matching", "work", "cocoten", "stripe", "admin"];
  if (!allowedCategories.includes(category)) {
    throw new HttpsError(
      "invalid-argument",
      `categoryはmatching/work/cocoten/stripe/adminのいずれかである必要があります。`
    );
  }
  if (!title || !body) {
    throw new HttpsError("invalid-argument", "titleとbodyが必要です。");
  }
  const allowedTargets = ["all", "guest", "cast"];
  const resolvedTarget = allowedTargets.includes(target) ? target : "all";

  // FIX (found during a fresh-eyes re-review of this whole admin panel):
  // this used to push `is_active != false` into the Firestore QUERY itself.
  // Firestore's documented behavior for `!=`/`not-in` is to exclude any
  // document where the field doesn't exist at all, not just documents
  // where it's explicitly `true` — so any legacy/manually-seeded user doc
  // missing `is_active` (not created through the normal signup path, which
  // always sets it) was silently dropped from every "send to all users"
  // broadcast, contradicting "all". Every other consumer of this exact
  // field in this codebase (`getFavorites`/`getDiscoveryCasts`, auth.ts)
  // already filters `is_active !== false` IN-MEMORY specifically so a
  // missing field counts as active — this now matches that established
  // convention instead of re-introducing the bug via the query layer. No
  // `.limit()` here deliberately: this is a genuine bulk broadcast, not a
  // paginated list view, so silently capping it would defeat the point.
  let usersQuery: FirebaseFirestore.Query = db.collection("users");
  if (resolvedTarget !== "all") {
    usersQuery = usersQuery.where("account_type", "==", resolvedTarget);
  }
  const usersSnap = await usersQuery.get();

  const now = Timestamp.now();
  const docs = usersSnap.docs.filter((d) => d.data().is_active !== false);
  const CHUNK_SIZE = 400; // Firestore batch cap is 500 - leave headroom.
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const userDoc of docs.slice(i, i + CHUNK_SIZE)) {
      const notifRef = userDoc.ref.collection("notifications").doc();
      batch.set(notifRef, {
        type: category,
        title,
        body,
        read: false,
        created_at: now,
      });
    }
    await batch.commit();
  }

  // Real device push, alongside the in-app broadcast above. A genuine bulk
  // send (potentially every user) - uses `sendEachForMulticast` directly
  // over tokens already in hand from `docs` (already fetched above),
  // rather than calling `sendPushNotification` per user (which would
  // redundantly re-read each user's doc one at a time). Chunked to FCM's
  // own 500-token-per-call cap. Best-effort per chunk - one chunk failing
  // must not abort the notification send this function has already
  // committed to Firestore.
  //
  // FIX (feature build, notification implementation follow-up): this is a
  // SECOND, architecturally separate push-dispatch path from
  // `sendPushNotification` (config.ts) - it never calls that helper, so
  // the `notify_*` preference enforcement added there (PROJECT_KNOWLEDGE.md
  // §126) structurally could not reach this one. Confirmed real, not
  // theoretical: an admin broadcasting to "all users" in any of the 5
  // categories previously pushed to every device regardless of that
  // user's own toggle - the ONE push path §126 didn't (and couldn't)
  // cover. `category` is already validated above to be exactly one of the
  // 5 `notify_*` suffixes, so no lookup table is needed here (unlike
  // `sendPushNotification`'s `type`, which isn't always one of the 5).
  // Same "explicit false skips, everything else sends" default as §126,
  // for the same reason (mirrors `fetchNotificationPreferences`'s own
  // default) - filters `docs` (not the in-app write above, which stays
  // unconditional per that same established design: muting a category
  // only skips the push nudge, never hides the in-app record).
  const notifyField = `notify_${category}`;
  const tokens = docs
    .filter((d) => d.data()[notifyField] !== false)
    .map((d) => d.data().fcm_token)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const PUSH_CHUNK_SIZE = 500; // FCM sendEachForMulticast cap.
  for (let i = 0; i < tokens.length; i += PUSH_CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + PUSH_CHUNK_SIZE);
    try {
      await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { type: category },
      });
    } catch (e) {
      console.error("Bulk push send failed for a chunk:", e);
    }
  }

  await createAuditLog(
    request.auth!.uid,
    "send_notification",
    "system",
    category,
    { target: resolvedTarget, title, sent_count: docs.length },
    `お知らせ配信（${category}／${resolvedTarget}）`
  );

  return { success: true, sent_count: docs.length };
});

// Home-ranking monitoring (IMPLEMENTATION_PLAN.md §3.8 item 6 — "verify the
// online/distance/login-recency sort and the GPS-fallback path are
// actually behaving as specified, an observability requirement, not just
// a feature"). Deliberately NOT a thin wrapper around `getDiscoveryCasts`
// (auth.ts) — that function's own response only ever returns
// `id|||nickname|||photoUrl|||isOnline`, discarding the raw `dist`/
// `lastLoginMs` values it computes internally, so a caller can see the
// FINAL sorted order but never verify WHY a given cast landed where it
// did. This mirrors the exact same filter + distance formula + sort
// comparator (kept in lockstep with auth.ts by inspection — if that
// function's logic ever changes, this one needs the same update) but
// returns every raw computed value so an admin can actually confirm the
// three-tier sort (online → distance → recency) is behaving correctly,
// not just trust that some order came out.
export const adminGetHomeRankingDiagnostics = onCall(async (request) => {
  await verifyAdmin(request);

  const { lat, lng } = request.data || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new HttpsError("invalid-argument", "lat/lngが必要です。");
  }

  const snapshot = await db
    .collection("users")
    .where("account_type", "==", "cast")
    .where("approval_status", "==", "approved")
    .limit(100)
    .get();

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const distanceKm = (loc: FirebaseFirestore.GeoPoint | undefined): number => {
    if (!loc) return Infinity;
    const r = 6371.0;
    const dLat = toRad(loc.latitude - lat);
    const dLng = toRad(loc.longitude - lng);
    const lat1 = toRad(lat);
    const lat2 = toRad(loc.latitude);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return r * c;
  };

  const rows = snapshot.docs
    .filter(
      (d) =>
        d.data().is_frozen !== true &&
        d.data().is_active !== false &&
        d.data().is_stripe_restricted !== true
    )
    .map((d) => {
      const data = d.data();
      const isOnline = data.is_online === true;
      const dist = distanceKm(data.location);
      const lastLogin = data.last_login_at;
      const lastLoginMs =
        lastLogin && typeof lastLogin.toMillis === "function" ? lastLogin.toMillis() : 0;
      const hasLocation = !!data.location;
      return {
        id: d.id,
        nickname: (data.nickname?.toString() || "").replace(/\|\|\|/g, ""),
        isOnline,
        dist,
        hasLocation,
        lastLoginMs,
      };
    });

  rows.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return b.lastLoginMs - a.lastLoginMs;
  });

  const items = rows.map((r, idx) => {
    const lastLoginLabel = r.lastLoginMs > 0 ? new Date(r.lastLoginMs).toISOString() : "";
    const distLabel = r.hasLocation ? r.dist.toFixed(2) : "fallback";
    return `${idx + 1}|||${r.nickname}|||${r.isOnline}|||${distLabel}|||${lastLoginLabel}`;
  });

  return { success: true, items, count: items.length };
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

// IMPLEMENTATION_PLAN.md §3.8 item 19, "activity-count aggregation
// reporting" — the one remaining unresolved sub-item of that spec line
// after rank/tier ([WON'T BUILD], superseded by §4.3) and CSV export
// ([PARTIAL], LedgerOversightPage) were already closed out. Distinct from
// adminGetDashboardStats above: that function only ever answers "what does
// today/this month look like" (fixed `todayStart` + a hardcoded rolling
// 5-month revenue chart) - there is no way to ask "how did daily signups
// trend over the last 30 days" from it. This function buckets by an
// admin-chosen granularity (daily or monthly) over an admin-chosen number
// of periods and returns one row per bucket.
//
// Query-shape choices are deliberately copied from already-proven,
// already-indexed patterns elsewhere in this file rather than invented
// fresh (every combo below is confirmed present in firestore.indexes.json
// or is a single-field range needing no composite index at all):
// - `account_type` (equality) + `created_at` (range): same combo
//   `adminGetUsers` already issues when both filters are supplied
//   (firestore.indexes.json's `users` composite: account_type, created_at).
// - `status` (equality) + `updated_at` (range): same combo used as the
//   completion-date proxy in affiliate.ts's countUniqueWorkDays /
//   getAffiliateDashboard (firestore.indexes.json's `reservations`
//   composite: status, updated_at) - reused here for the identical reason
//   (there is no separate "completed_at" field on a reservation).
// - `created_at` alone and `last_capture_at` alone: single-field ranges,
//   Firestore indexes these automatically, no composite needed (same as
//   adminGetDashboardStats's own todayReservations/monthlyCapturedSnaps
//   queries above).
//
// Bucket count is capped (31 daily / 24 monthly) to bound the fan-out: each
// bucket issues 6 concurrent queries, so an uncapped request could balloon
// into hundreds of simultaneous reads. The cap is disclosed back to the
// caller via `bucketCount` in the response rather than silently truncated.
export const adminGetActivityReport = onCall(async (request) => {
  await verifyAdmin(request);

  const { granularity, periods } = request.data as {
    granularity?: string;
    periods?: number;
  };
  const isMonthly = granularity === "monthly";
  const maxPeriods = isMonthly ? 24 : 31;
  const defaultPeriods = isMonthly ? 12 : 30;
  const requestedPeriods =
    Number.isInteger(periods) && (periods as number) > 0
      ? (periods as number)
      : defaultPeriods;
  const bucketCount = Math.min(requestedPeriods, maxPeriods);

  // Same JST-correctness reasoning as adminGetDashboardStats above - this
  // business operates in Japan Standard Time, and Cloud Functions default
  // to UTC regardless of deployed region.
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const jstYear = nowJst.getUTCFullYear();
  const jstMonth = nowJst.getUTCMonth();
  const jstDate = nowJst.getUTCDate();

  const buckets = Array.from({ length: bucketCount }, (_, idx) => {
    const offset = bucketCount - 1 - idx;
    if (isMonthly) {
      const monthIndex = jstMonth - offset;
      const start = new Date(Date.UTC(jstYear, monthIndex, 1) - JST_OFFSET_MS);
      const end = new Date(Date.UTC(jstYear, monthIndex + 1, 1) - JST_OFFSET_MS);
      const labelDate = new Date(Date.UTC(jstYear, monthIndex, 1));
      return {
        label: `${labelDate.getUTCFullYear()}/${labelDate.getUTCMonth() + 1}`,
        start,
        end,
      };
    }
    const dayIndex = jstDate - offset;
    const start = new Date(Date.UTC(jstYear, jstMonth, dayIndex) - JST_OFFSET_MS);
    const end = new Date(Date.UTC(jstYear, jstMonth, dayIndex + 1) - JST_OFFSET_MS);
    const labelDate = new Date(Date.UTC(jstYear, jstMonth, dayIndex));
    return {
      label: `${labelDate.getUTCMonth() + 1}/${labelDate.getUTCDate()}`,
      start,
      end,
    };
  });

  const rows = await Promise.all(
    buckets.map(async (b) => {
      const startTs = Timestamp.fromDate(b.start);
      const endTs = Timestamp.fromDate(b.end);
      const [
        newGuests,
        newCasts,
        reservationsCreated,
        reservationsCompleted,
        reservationsCancelled,
        capturedSnap,
      ] = await Promise.all([
        db
          .collection("users")
          .where("account_type", "==", "guest")
          .where("created_at", ">=", startTs)
          .where("created_at", "<", endTs)
          .count()
          .get(),
        db
          .collection("users")
          .where("account_type", "==", "cast")
          .where("created_at", ">=", startTs)
          .where("created_at", "<", endTs)
          .count()
          .get(),
        db
          .collection("reservations")
          .where("created_at", ">=", startTs)
          .where("created_at", "<", endTs)
          .count()
          .get(),
        db
          .collection("reservations")
          .where("status", "==", "completed")
          .where("updated_at", ">=", startTs)
          .where("updated_at", "<", endTs)
          .count()
          .get(),
        db
          .collection("reservations")
          .where("status", "==", "cancelled")
          .where("updated_at", ">=", startTs)
          .where("updated_at", "<", endTs)
          .count()
          .get(),
        db
          .collection("reservations")
          .where("last_capture_at", ">=", startTs)
          .where("last_capture_at", "<", endTs)
          .get(),
      ]);

      const revenue = capturedSnap.docs.reduce(
        (sum, doc) => sum + (doc.data().total_amount || 0),
        0
      );

      return {
        label: b.label,
        newGuests: newGuests.data().count,
        newCasts: newCasts.data().count,
        reservationsCreated: reservationsCreated.data().count,
        reservationsCompleted: reservationsCompleted.data().count,
        reservationsCancelled: reservationsCancelled.data().count,
        revenue,
      };
    })
  );

  return {
    success: true,
    granularity: isMonthly ? "monthly" : "daily",
    bucketCount,
    rows,
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
// needs.
// `photo_url` (unimplemented-features pass, IMPLEMENTATION_PLAN.md §3.8
// item 7): schema.md documents `photos` as `array<string>`, but the real
// FlutterFlow-side schema (schemas.dart) only ever declared it as a single
// `ImagePath` field - there is no array-of-URLs field anywhere in the
// live schema. Rather than fight that drift, this accepts ONE photo URL
// (uploaded client-side via Firebase Storage - see `pickAndUploadShopPhoto`
// in dsl/edit.dart) and writes it to the existing single-value `photos`
// field, matching what the live schema actually supports. A genuine
// multi-photo gallery would need a new schema field + a new admin UI, out
// of proportion for closing this specific gap.
// `genre` is now validated against `system_config/settings.cocoten_genres`
// (config.ts's `SYSTEM_DEFAULTS.cocoten_genres`) - the "genre/tag master"
// half of item 7. A structured taxonomy is enforced here (server-side,
// reject unknown values) rather than via a picker WIDGET, deliberately -
// this project's own project_rules.md documents 3 separate confirmed
// FlutterFlow `DropDown` binding bugs (silent no-op `bindValue`, empty-
// string `dropdownOptions`, `Switch`-class initState capture issues on
// related widgets), and task #30's own prefecture picker already had to
// abandon `DropDown` for a bottom-sheet component for the same reason.
// Enforcing the taxonomy server-side (reject any `genre` not in the
// master list) gives the same "structured, not free text" guarantee
// without touching that same risky widget surface again.
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
    menu,
    guest_benefits,
    photo_url,
    active,
    reason,
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

  if (genre) {
    const config = await getSystemConfig();
    const validGenres = Array.isArray(config.cocoten_genres)
      ? config.cocoten_genres
      : [];
    if (!validGenres.includes(genre)) {
      throw new HttpsError(
        "invalid-argument",
        `ジャンルは次のいずれかを指定してください: ${validGenres.join("、")}`
      );
    }
  }
  // FIX (PROJECT_KNOWLEDGE.md §70, MEDIUM-HIGH — comprehensive project-wide
  // review): same unvalidated-boolean bug class as adminApproveKYC/
  // adminUpsertBanner above. generated_code's CocotenShopsRecord does a
  // raw `as bool?` cast on `active` — a non-boolean value crashes that
  // read wherever a shop card renders.
  if (active !== undefined && typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "activeはtrue/falseで指定してください。");
  }

  const resolvedPrefecture = prefecture || (shopId ? existingData.prefecture : "") || "";
  const resolvedCity = city || (shopId ? existingData.city : "") || "";
  const resolvedTownBlock = town_block || (shopId ? existingData.town_block : "") || "";
  const resolvedBuilding = building || (shopId ? existingData.building : "") || "";

  const shopData = {
    name: resolvedName,
    genre: genre || (shopId ? existingData.genre : "") || "",
    // FIX (§3.4.1, CocoTenDetailPage — real schema drift, found while
    // building the detail page and confirmed against
    // lib/flutterflow_project/schemas.dart directly, not schema.md): this
    // function has only ever written `prefecture`/`city`/`town_block`/
    // `building` — none of which the FlutterFlow-side schema declares at
    // all (it only ever declared a single `address` string field, matching
    // the original client spec's own collection definition). Every real
    // `cocoten_shops` document's `address` field has therefore been empty
    // since this function was first built. Safe to fix now — confirmed via
    // a direct grep of this session's own DSL work that
    // `adminUpsertCocotenShop`/`adminGetCocotenShops` have zero admin-UI
    // call sites yet (Phase 12/Admin CocoTen CRUD, not built), so there is
    // no live consumer whose expectations this could break. Keeps
    // accepting the 4 separate admin-form inputs (closer to what an eventual
    // admin edit UI actually wants to collect) but now ALSO computes and
    // writes the schema-correct combined `address` string, which is what
    // CocoTenDetailPage (and any other future DSL reader) can actually bind
    // to. The 4 separate fields are still written too (harmless extra keys,
    // not schema-tracked) so a later edit's own "leave unchanged if blank"
    // merge logic (this function's own established convention, see below)
    // keeps working per-component.
    prefecture: resolvedPrefecture,
    city: resolvedCity,
    town_block: resolvedTownBlock,
    building: resolvedBuilding,
    address: [resolvedPrefecture, resolvedCity, resolvedTownBlock, resolvedBuilding]
      .filter((s) => s.trim().length > 0)
      .join(" "),
    // FIX (§3.4.1, CocoTenDetailPage): menu/guest_benefits were never
    // written by this function at all (confirmed schema drift, disclosed
    // in an earlier pass) despite both existing in the real schema and
    // being exactly what the venue detail page needs to show.
    menu: menu || (shopId ? existingData.menu : "") || "",
    guest_benefits: guest_benefits || (shopId ? existingData.guest_benefits : "") || "",
    // `photos` (ImagePath, single value — see the function-level comment
    // above for why this isn't a real array). `location` (LatLng) remains
    // deliberately unhandled — no map/geocoding widget exists anywhere in
    // this app, a real, disclosed, standing limitation, not new to this
    // change.
    photos: photo_url || (shopId ? existingData.photos : "") || "",
    // FIX (confirmed live bug, found during audit): unlike every other
    // field in this object, `active` used to hardcode `true` whenever the
    // caller omitted it — on UPDATE that ignored the shop's current
    // `active` value instead of preserving it like the rest of this
    // function's own "blank means unchanged" convention (and like
    // `adminUpsertBanner`'s identical `active` handling above). Live
    // impact: `callAdminUpdateCocotenShopDetails` (dsl/edit.dart) calls
    // this same function with only `shop_id`/`menu`/`guest_benefits`/
    // `photo_url` — never `active` — so every "詳細を更新" (update details)
    // call on a shop an admin had deliberately deactivated silently
    // reactivated it. Now falls back to the existing value (defaulting to
    // `true` only when there is no existing doc, i.e. on create).
    active: active !== undefined ? active : (existingData.active ?? true),
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
    { name, reason },
    reason || ""
  );

  return { success: true, shop_id: shopId };
});

export const adminDeleteCocotenShop = onCall(async (request) => {
  await verifyAdmin(request);

  const { shop_id, reason } = request.data;
  if (!shop_id) {
    throw new HttpsError("invalid-argument", "shop_idが必要です。");
  }

  await db.collection("cocoten_shops").doc(shop_id).delete();

  await createAuditLog(
    request.auth!.uid,
    "delete_cocomise",
    "cocomise",
    shop_id,
    { reason },
    reason || ""
  );

  return { success: true };
});

// ジャンル/タグマスタ (IMPLEMENTATION_PLAN.md §3.8 item 7's "genre/tag
// master" half). Own dedicated small surface rather than folded into the
// generic `adminGetSystemConfig`/`adminUpdateSystemConfig` constant editor
// — same reasoning as `getServiceAreas`/`ServiceAreaPage` staying separate
// from that page's own 12-scalar-constant scope: an array-of-strings
// add/remove list doesn't fit that page's "one save action per settings
// tab" scalar-field shape. Admin-only for now (no guest-facing wiring in
// this pass — CocomisePage's own filter chips stay hardcoded, a
// deliberate, disclosed scope reduction; that page's relevant block is
// itself flagged elsewhere as too fragile to touch outside a dedicated
// pass). Reads/writes the same `system_config/settings.cocoten_genres`
// field `adminUpsertCocotenShop` validates new shop genres against.
export const adminGetCocotenGenres = onCall(async (request) => {
  await verifyAdmin(request);
  const config = await getSystemConfig();
  return { success: true, genres: config.cocoten_genres };
});

export const adminUpdateCocotenGenres = onCall(async (request) => {
  await verifyAdmin(request);

  const { genres, reason } = request.data;
  if (!Array.isArray(genres)) {
    throw new HttpsError("invalid-argument", "genresは配列で指定してください。");
  }
  const cleaned = Array.from(
    new Set(
      genres
        .filter((g): g is string => typeof g === "string")
        .map((g) => g.trim())
        .filter((g) => g.length > 0)
    )
  );
  if (cleaned.length === 0) {
    throw new HttpsError("invalid-argument", "ジャンルを1件以上指定してください。");
  }

  await db
    .collection("system_config")
    .doc("settings")
    .set({ cocoten_genres: cleaned }, { merge: true });

  await createAuditLog(
    request.auth!.uid,
    "update_cocoten_genres",
    "system_config",
    "settings",
    { genres: cleaned },
    reason || ""
  );

  return { success: true, genres: cleaned };
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

  const { status, limit: queryLimit } = request.data ?? {};

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

  const { post_id, reason } = request.data;
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
    { reason },
    reason || ""
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

  const { type, description, date, location, fee, reason } = request.data;
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
    { type, description, reason },
    reason || ""
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

  const { post_id, applicant_id, reason } = request.data;
  if (!post_id || !applicant_id) {
    throw new HttpsError(
      "invalid-argument",
      "post_idとapplicant_idが必要です。"
    );
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): same non-transactional race + plain-array lost-update bug as
  // work-posts.ts's selectWorkApplicant, fixed with the identical pattern
  // — a transaction so only one caller can win the status transition, plus
  // `arrayUnion` for the staff_ids append instead of a read-modify-write.
  const postRef = db.collection("work_posts").doc(post_id);
  await db.runTransaction(async (tx) => {
    const postSnap = await tx.get(postRef);
    if (!postSnap.exists) {
      throw new HttpsError("not-found", "投稿が見つかりません。");
    }
    const data = postSnap.data()!;
    const applicants: string[] = data.applicants || [];
    if (!applicants.includes(applicant_id)) {
      throw new HttpsError(
        "failed-precondition",
        "指定された応募者はこの投稿に応募していません。"
      );
    }
    if (data.status !== "open") {
      throw new HttpsError("failed-precondition", "この投稿はすでに処理済みです。");
    }

    // Reads before writes — the reservation existence check must happen
    // here, not interleaved with the tx.update() calls below.
    let resRef: FirebaseFirestore.DocumentReference | null = null;
    let resSnapData: FirebaseFirestore.DocumentData | null = null;
    // FIX (comprehensive review, confirmed bug): this omitted
    // "partner_recruit" — work-posts.ts's selectWorkApplicant (the
    // client-facing sibling) already includes it, fixed for the exact same
    // "recruited cast never wired into the reservation" bug class
    // (PROJECT_KNOWLEDGE.md §105 item 1). The admin-facing hire path never
    // got the matching fix: an admin hiring a group-invite (partner_recruit)
    // applicant marked the post filled but never added the applicant to
    // `cast_ids`, so they could never confirm meetup, report completion, or
    // get paid for a reservation they were visibly selected for.
    if ((data.type === "security" || data.type === "transport" || data.type === "partner_recruit") && data.res_id) {
      const candidateRef = db.collection("reservations").doc(data.res_id);
      const resSnap = await tx.get(candidateRef);
      if (resSnap.exists) {
        resRef = candidateRef;
        resSnapData = resSnap.data()!;
      }
    }

    // Same MAX_CAST_IDS_PER_RESERVATION safety cap selectWorkApplicant
    // enforces before adding a partner_recruit hire to cast_ids.
    if (resRef && data.type === "partner_recruit") {
      const existingCastIds: string[] = resSnapData?.cast_ids || [];
      if (!existingCastIds.includes(applicant_id) && existingCastIds.length >= MAX_CAST_IDS_PER_RESERVATION) {
        throw new HttpsError(
          "failed-precondition",
          "この予約はすでに参加キャスト数の上限に達しています。"
        );
      }
    }

    tx.update(postRef, { status: "filled", selected_id: applicant_id });
    // FIX (confirmed live bug, found during audit): the client-facing
    // `selectWorkApplicant` (work-posts.ts) appends the hired applicant
    // into the linked reservation's `staff_ids` for security/transport
    // posts, so `recordCastRewardsAndProcessOthers` actually pays them
    // their share of the already-authorized `staff_fee` — this
    // admin-facing equivalent did not, so a staff member hired via the
    // admin panel instead of the client-facing flow was never wired to
    // receive their fee. Mirrors selectWorkApplicant's logic exactly.
    if (resRef) {
      if (data.type === "partner_recruit") {
        tx.update(resRef, { cast_ids: FieldValue.arrayUnion(applicant_id) });
      } else {
        // FIX (confirmed live bug, found during audit — same gap as
        // work-posts.ts's selectWorkApplicant, mirrored here for the
        // admin-facing hire path): `security_staff_fee`/`transport_staff_fee`
        // are independently admin-configurable and not guaranteed equal, but
        // `recordCastRewardsAndProcessOthers` (stripe-payments.ts) used to
        // pay every staff_id on a reservation an EVEN split of the aggregate
        // `staff_fee` — misallocating pay between a security and a transport
        // staffer whenever those two config values differ. This work_post's
        // own `fee` is the authoritative amount THIS hire should be paid;
        // recorded into `staff_fee_map` (dot-path update) so payout can pay
        // the right amount to the right person instead of guessing via an
        // even split.
        tx.update(resRef, {
          staff_ids: FieldValue.arrayUnion(applicant_id),
          [`staff_fee_map.${applicant_id}`]: data.fee || 0,
        });
      }
    }

  });

  await createAuditLog(
    request.auth!.uid,
    "hire_work_post_applicant",
    "work_post",
    post_id,
    { applicant_id, reason },
    reason || ""
  );

  return { success: true };
});

// ============================================
// Chat oversight (Tier 3, §3.8.10) — no precedent in the sister
// admin-dashboard project ("no dedicated page monitors room-open status or
// the chat_close_sec auto-hide timer at all") and no admin-side backend
// existed for `chat_rooms` at all before this. Read-only monitoring +ONE
// manual override (force-close a stuck-open room) — this project's own
// established minimal-admin-slice scope, matching KycReviewPage/
// AdminReportReviewPage's own precedent of "list + one or two direct
// actions," not a full CRUD surface.
// ============================================

/**
 * Recent chat rooms, newest first. `active`/`closed_at` are exactly the two
 * fields §3.5.8's two-part close mechanic writes (the instant post-lock via
 * reservations.ts's own status-driven check, and the chat_close_sec
 * scheduled sweep) — this view exists so an admin can actually SEE that
 * mechanic working, per §3.8.6's "observability, not just a feature"
 * framing applied to the analogous home-ranking requirement.
 */
export const adminGetChatRooms = onCall(async (request) => {
  await verifyAdmin(request);

  const snapshot = await db
    .collection("chat_rooms")
    .orderBy("created_at", "desc")
    .limit(50)
    .get();

  const rooms = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return { success: true, rooms, count: rooms.length };
});

/**
 * Manual override: force-close a room that should have closed (via either
 * half of §3.5.8's mechanic) but didn't — same "admin can unstick a state
 * the automated mechanic failed to reach" shape as adminForceCancel for
 * reservations.
 */
export const adminCloseChat = onCall(async (request) => {
  await verifyAdmin(request);

  const { room_id, reason } = request.data;
  if (!room_id) {
    throw new HttpsError("invalid-argument", "room_idが必要です。");
  }

  await db.collection("chat_rooms").doc(room_id).update({
    active: false,
    closed_at: Timestamp.now(),
  });

  await createAuditLog(
    request.auth!.uid,
    "admin_close_chat",
    "chat_room",
    room_id,
    { reason },
    reason || ""
  );

  return { success: true };
});

