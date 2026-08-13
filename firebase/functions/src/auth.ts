/**
 * Auth & User Management Cloud Functions
 * 認証・ユーザー管理
 */
import * as functionsV1 from "firebase-functions/v1";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, auth, stripe, FieldValue, Timestamp, getSystemConfig, isAllowedKycDocUrl } from "./config";

/**
 * Trigger: When a new Firebase Auth user is created
 * Creates the initial Firestore user document
 * Note: Using v1 auth trigger as v2 beforeUserCreated requires Identity Platform (GCIP)
 */
export const onUserCreated = functionsV1.auth.user().onCreate(async (user: any) => {
  const { uid, email, displayName } = user;

  await db.collection("users").doc(uid).set({
    uid,
    nickname: displayName || "",
    email: email || "",
    phone: "",
    account_type: "",
    role: "user",
    staff_type: "none",
    gender: "",
    birth_date: null,
    age_group: "",
    prefecture: "",
    city: "",
    activity_prefecture: "",
    activity_city: "",
    drinking: "",
    smoking: "",
    hobbies: "",
    skills: "",
    favorite_food_tags: [],
    atmosphere: "",
    one_line_message: "",
    self_introduction: "",
    profile_image_url: "",
    gallery_images: [],
    desired_interaction: "",
    offered_interaction: "",
    is_online: false,
    last_login_at: Timestamp.now(),
    location: null,
    is_verified: false,
    kyc_status: "pending",
    kyc_doc_url: "",
    kyc_selfie_url: "",
    approval_status: "pending",
    individual_rate: 0.5,
    logical_debt: 0,
    stripe_account_id: "",
    stripe_customer_id: "",
    referred_by_uid: "",
    affiliate_rate: 0.05,
    consent_at: null,
    created_at: Timestamp.now(),
    updated_at: Timestamp.now(),
    is_active: true,
    is_frozen: false,
    blocked_users: [],
  });

  console.log(`User document created for ${uid}`);
});

/**
 * Callable: Complete user onboarding (set account type, consent, referral code)
 * ユーザーオンボーディング完了
 */
export const completeOnboarding = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const {
    account_type,
    gender,
    birth_date,
    prefecture,
    city,
    activity_prefecture,
    activity_city,
    staff_type,
    referral_code,
    consent_agreed,
  } = request.data;

  if (!["guest", "cast"].includes(account_type)) {
    throw new HttpsError("invalid-argument", "アカウント種別が無効です。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): this had no guard against being called more than once, and
  // never touched approval_status regardless of what it was before. An
  // already-onboarded-and-approved guest could call this again with
  // account_type:"cast" and instantly satisfy every
  // account_type==="cast" && approval_status==="approved" server check
  // (reservations.ts, work-posts.ts, getDiscoveryCasts) — becoming a
  // bookable, discoverable "cast" with zero cast-specific KYC review ever
  // submitted or approved. No spec text anywhere describes account-type
  // switching as a supported feature (checked IMPLEMENTATION_PLAN.md),
  // so onboarding is treated as one-time: once account_type is set,
  // calling this again is rejected outright rather than guessing at a
  // "re-review" flow this app doesn't otherwise have.
  const existingDoc = await db.collection("users").doc(uid).get();
  if (existingDoc.data()?.account_type) {
    throw new HttpsError(
      "failed-precondition",
      "オンボーディングはすでに完了しています。"
    );
  }

  const birthDate = new Date(birth_date);
  const now = new Date();
  // FIX (confirmed live bug, found during audit): age was computed as a
  // bare year subtraction with no month/day adjustment - overcounts age by
  // 1 for anyone whose birthday hasn't occurred yet this calendar year
  // relative to signup date (e.g. born 2000-12-25, signing up 2026-01-15 ->
  // this used to compute 26, the correct age is still 25). Not an edge
  // case - wrong for roughly half of all signups depending on birth-date
  // distribution, and directly feeds `age_group`, a real search/filter
  // field.
  let age = now.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear =
    now.getMonth() > birthDate.getMonth() ||
    (now.getMonth() === birthDate.getMonth() && now.getDate() >= birthDate.getDate());
  if (!hasHadBirthdayThisYear) age--;
  let ageGroup = "";
  if (age < 20) ageGroup = "20歳未満";
  else if (age < 25) ageGroup = "20代前半";
  else if (age < 30) ageGroup = "20代後半";
  else if (age < 35) ageGroup = "30代前半";
  else if (age < 40) ageGroup = "30代後半";
  else if (age < 45) ageGroup = "40代前半";
  else if (age < 50) ageGroup = "40代後半";
  else if (age < 55) ageGroup = "50代前半";
  else if (age < 60) ageGroup = "50代後半";
  else ageGroup = "60歳以上";

  if (!consent_agreed) {
    throw new HttpsError("invalid-argument", "利用規約への同意が必要です。");
  }

  const updateData: Record<string, any> = {
    account_type,
    gender,
    birth_date: Timestamp.fromDate(birthDate),
    age_group: ageGroup,
    prefecture,
    city,
    activity_prefecture: activity_prefecture || "",
    activity_city: activity_city || "",
    staff_type: staff_type || "none",
    consent_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  };

  if (referral_code && referral_code.trim() !== "") {
    const referrerDoc = await db.collection("users").doc(referral_code).get();
    if (referrerDoc.exists && referrerDoc.data()?.account_type === "cast") {
      updateData.referred_by_uid = referral_code;
    } else {
      throw new HttpsError("not-found", "紹介コードが無効です。");
    }
  }

  await db.collection("users").doc(uid).update(updateData);

  if (account_type === "guest") {
    try {
      const customer = await stripe.customers.create({
        email: request.auth.token.email || "",
        metadata: { firebase_uid: uid },
      });
      await db.collection("users").doc(uid).update({
        stripe_customer_id: customer.id,
      });
    } catch (err) {
      console.error("Stripe customer creation failed:", err);
    }
  }

  if (account_type === "cast") {
    try {
      const account = await stripe.accounts.create({
        type: "custom",
        country: "JP",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
        metadata: { firebase_uid: uid },
      });
      await db.collection("users").doc(uid).update({
        stripe_account_id: account.id,
      });
    } catch (err) {
      console.error("Stripe connected account creation failed:", err);
    }
  }

  return { success: true, message: "オンボーディングが完了しました。" };
});

/**
 * Callable: Submit Custom Connect onboarding data (individual info, ToS
 * acceptance, bank account).
 *
 * FIX (IMPLEMENTATION_PLAN.md §6 defect #5): `completeOnboarding` above
 * only ever called `stripe.accounts.create()` — an account created that
 * way sits permanently `restricted` with no way to ever receive a
 * Transfer, since Stripe never received the individual/ToS/bank data it
 * requires. This callable is the real onboarding entry point.
 *
 * Deliberately NOT a Stripe-hosted AccountLink redirect: the client
 * confirmed Connect account type Custom specifically so this data is
 * collected inside the app (IMPLEMENTATION_PLAN.md §3.9 item 3, "the full
 * Stripe mirroring UX... built inside the app rather than redirecting to
 * a Stripe-hosted dashboard"). The response mirrors Stripe's own live
 * `requirements` back to the caller so the UI can render a real-time
 * checklist instead of guessing what Stripe still needs.
 *
 * Stripeアカウント本人情報・口座情報の登録
 */
export const submitConnectOnboarding = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();

  if (!userData || userData.account_type !== "cast") {
    throw new HttpsError(
      "failed-precondition",
      "キャストアカウントのみ利用できます。"
    );
  }
  if (!userData.stripe_account_id) {
    throw new HttpsError(
      "failed-precondition",
      "Stripeアカウントが未作成です。オンボーディングを完了してください。"
    );
  }

  const { individual, bank_account, tos_accepted } = request.data;

  if (!tos_accepted) {
    throw new HttpsError("invalid-argument", "利用規約への同意が必要です。");
  }
  if (
    !individual?.first_name ||
    !individual?.last_name ||
    !individual?.first_name_kana ||
    !individual?.last_name_kana ||
    !individual?.dob?.day ||
    !individual?.dob?.month ||
    !individual?.dob?.year ||
    !individual?.phone ||
    !individual?.address?.postal_code ||
    !individual?.address?.line1 ||
    !individual?.address?.city ||
    !individual?.address?.state
  ) {
    throw new HttpsError("invalid-argument", "本人情報が不足しています。");
  }

  const accountId = userData.stripe_account_id;

  try {
    await stripe.accounts.update(accountId, {
      business_type: "individual",
      individual: {
        first_name: individual.first_name,
        last_name: individual.last_name,
        first_name_kana: individual.first_name_kana,
        last_name_kana: individual.last_name_kana,
        first_name_kanji: individual.first_name_kanji || undefined,
        last_name_kanji: individual.last_name_kanji || undefined,
        email: individual.email || request.auth.token.email || undefined,
        phone: individual.phone,
        gender: individual.gender || undefined,
        dob: {
          day: individual.dob.day,
          month: individual.dob.month,
          year: individual.dob.year,
        },
        address_kanji: {
          postal_code: individual.address.postal_code,
          state: individual.address.state,
          city: individual.address.city,
          town: individual.address.town || undefined,
          line1: individual.address.line1,
          line2: individual.address.line2 || undefined,
        },
        address_kana: individual.address_kana
          ? {
              postal_code: individual.address_kana.postal_code,
              state: individual.address_kana.state,
              city: individual.address_kana.city,
              town: individual.address_kana.town || undefined,
              line1: individual.address_kana.line1,
              line2: individual.address_kana.line2 || undefined,
            }
          : undefined,
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: request.rawRequest?.ip || "0.0.0.0",
      },
    });
  } catch (err: any) {
    console.error("Stripe individual/ToS update failed:", err);
    throw new HttpsError(
      "invalid-argument",
      `本人情報の登録に失敗しました: ${err.message || err}`
    );
  }

  // Bank attachment is a separate Stripe call (its own endpoint, its own
  // error surface) so a bad bank number doesn't block the personal-info
  // half that just succeeded above — partial progress is the point of the
  // requirements-mirroring design, not an error state.
  let bankAccountError: string | null = null;
  if (bank_account) {
    const { account_holder_name, bank_code, branch_code, account_number, account_type } = bank_account;
    if (!account_holder_name || !bank_code || !branch_code || !account_number) {
      bankAccountError = "口座情報が不足しています。";
    } else {
      try {
        await stripe.accounts.createExternalAccount(accountId, {
          external_account: {
            object: "bank_account",
            country: "JP",
            currency: "jpy",
            account_holder_name,
            account_number,
            // Japan has no separate routing-number field on the bank UI
            // side — Stripe's JP external accounts encode it as the
            // 4-digit bank code + 3-digit branch code concatenated.
            routing_number: `${bank_code}${branch_code}`,
            ...(account_type ? { account_type } : {}),
          },
        });
      } catch (err: any) {
        console.error("Stripe bank account attach failed:", err);
        bankAccountError = err.message || "口座情報の登録に失敗しました。";
      }
    }
  }

  // Re-fetch so the response reflects Stripe's own current view (its
  // `requirements` can change based on what the two calls above actually
  // satisfied), not just an optimistic assumption about what was sent.
  const account = await stripe.accounts.retrieve(accountId);
  const chargesEnabled = account.charges_enabled ?? false;
  const payoutsEnabled = account.payouts_enabled ?? false;
  const requirementsDue = account.requirements?.currently_due || [];
  const isRestricted = account.requirements?.disabled_reason != null;

  await db.collection("users").doc(uid).update({
    stripe_onboarding_submitted_at: Timestamp.now(),
    stripe_charges_enabled: chargesEnabled,
    stripe_payouts_enabled: payoutsEnabled,
    stripe_requirements_due: requirementsDue,
    is_stripe_restricted: isRestricted,
    updated_at: Timestamp.now(),
  });

  return {
    success: true,
    bank_account_error: bankAccountError,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    requirements_due: requirementsDue,
    requirements_eventually_due: account.requirements?.eventually_due || [],
    disabled_reason: account.requirements?.disabled_reason || null,
  };
});

/**
 * Callable: Read the connected account's live Stripe requirements — powers
 * an in-app onboarding checklist without redirecting to a Stripe-hosted
 * page. Read-only; `users.stripe_*` mirror fields are written by
 * `submitConnectOnboarding` and the `account.updated` webhook instead.
 * Stripeアカウント状況取得
 */
export const getConnectAccountStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const userData = userDoc.data();

  if (!userData?.stripe_account_id) {
    throw new HttpsError("failed-precondition", "Stripeアカウントが未作成です。");
  }

  const account = await stripe.accounts.retrieve(userData.stripe_account_id);

  return {
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    requirements_due: account.requirements?.currently_due || [],
    requirements_eventually_due: account.requirements?.eventually_due || [],
    disabled_reason: account.requirements?.disabled_reason || null,
  };
});

/**
 * Callable: Submit KYC documents
 * 本人確認書類の提出
 */
export const submitKYC = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const { doc_url, selfie_url } = request.data;

  if (!doc_url || !selfie_url) {
    throw new HttpsError("invalid-argument", "書類と顔写真が必要です。");
  }
  // FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide review):
  // this trusted doc_url/selfie_url with no validation at all — the exact
  // gap `adminApproveKYC`'s own downstream `fetch(docUrl)` was already
  // hardened against (a confirmed SSRF vulnerability). Validating here too,
  // at the point these URLs are actually WRITTEN, is defense in depth
  // beyond just the one function that happens to fetch them today — the
  // real flow already only ever uploads through Firebase Storage
  // (pickAndUploadImage, dsl/edit.dart), so nothing legitimate is
  // rejected.
  if (!isAllowedKycDocUrl(doc_url) || !isAllowedKycDocUrl(selfie_url)) {
    throw new HttpsError("invalid-argument", "書類のURLが不正です。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): this accepted a submission from ANY authenticated caller
  // regardless of account_type — including a brand-new signup that hasn't
  // even chosen guest/cast yet (account_type still ""). An admin approving
  // what looks like an ordinary pending KYC submission (adminApproveKYC)
  // has no signal in the data that the applicant hasn't completed
  // onboarding at all. Require account_type to already be set (via
  // completeOnboarding) first — matches the natural signup order
  // (onboard → KYC → review), not a new product rule.
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.data()?.account_type) {
    throw new HttpsError(
      "failed-precondition",
      "先にアカウント情報の登録を完了してください。"
    );
  }

  // FIX (PROJECT_KNOWLEDGE.md §71): this only ever set kyc_status, never
  // approval_status — a previously-approved user resubmitting KYC (rare
  // today, but exactly what task #132/#134's resubmission flow enables)
  // would stay approval_status:"approved" throughout, still passing every
  // approval_status==="approved" server check while nominally "back under
  // review." onUserCreated already defaults approval_status to "pending"
  // at signup, so this is a harmless no-op on a genuinely first-time
  // submission and the correct corrective action on a resubmission.
  await db.collection("users").doc(uid).update({
    kyc_doc_url: doc_url,
    kyc_selfie_url: selfie_url,
    kyc_status: "submitted",
    approval_status: "pending",
    updated_at: Timestamp.now(),
  });

  const admins = await db.collection("users").where("role", "==", "admin").get();
  const batch = db.batch();
  admins.forEach((adminDoc) => {
    const notifRef = db.collection("users").doc(adminDoc.id).collection("notifications").doc();
    batch.set(notifRef, {
      type: "admin",
      title: "新しいKYC申請",
      body: `ユーザー ${uid} がKYC書類を提出しました。`,
      data: { user_id: uid },
      read: false,
      created_at: Timestamp.now(),
    });
  });
  await batch.commit();

  return { success: true, message: "本人確認書類を提出しました。審査をお待ちください。" };
});

/**
 * Callable: Update user profile
 * プロフィール更新
 */
export const updateProfile = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;

  const allowedFields = [
    "nickname", "prefecture", "city", "activity_prefecture", "activity_city",
    "drinking", "smoking", "hobbies", "skills", "favorite_food_tags",
    "atmosphere", "one_line_message", "self_introduction",
    "profile_image_url", "gallery_images",
    "desired_interaction", "offered_interaction", "staff_type",
    "is_online", "location",
  ];

  const updateData: Record<string, any> = { updated_at: Timestamp.now() };

  for (const field of allowedFields) {
    if (request.data[field] !== undefined) {
      updateData[field] = request.data[field];
    }
  }

  await db.collection("users").doc(uid).update(updateData);

  return { success: true };
});

/**
 * Callable: persist the caller's Firebase-Auth-VERIFIED phone number.
 * 確認済み電話番号をFirestoreに反映する。
 *
 * FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide review):
 * phone verification (sendPhoneVerificationCode/verifyPhoneCodeAndLink,
 * dsl/edit.dart) is real Firebase Phone Auth, but the verified number was
 * never persisted to `users.phone` anywhere — functionally decorative from
 * the server's perspective, no queryable trace of it existed.
 *
 * Deliberately does NOT accept the phone number as a plain client
 * parameter (unlike `updateProfile`'s self-serve fields) — that would let
 * a caller claim an arbitrary, unverified number under the same field this
 * function's whole purpose is to record as VERIFIED. Instead reads
 * `request.auth.token.phone_number`, the custom claim Firebase Auth itself
 * adds to the ID token once `linkWithCredential` succeeds and the token is
 * refreshed — the same trust model `completeOnboarding` already uses for
 * `request.auth.token.email`. If the claim isn't present (client didn't
 * force a token refresh after linking, or the caller has no linked phone
 * at all), this is a clean no-op rather than an error — a stale/absent
 * claim isn't the caller's fault and shouldn't surface as a failure.
 */
export const syncVerifiedPhone = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const verifiedPhone = request.auth.token.phone_number;
  if (!verifiedPhone || typeof verifiedPhone !== "string") {
    return { success: true, synced: false };
  }

  await db.collection("users").doc(request.auth.uid).update({
    phone: verifiedPhone,
    updated_at: Timestamp.now(),
  });

  return { success: true, synced: true };
});

/**
 * Callable: Update last login timestamp
 * 最終ログイン日時更新
 */
export const updateLastLogin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  await db.collection("users").doc(request.auth.uid).update({
    last_login_at: Timestamp.now(),
    is_online: true,
    updated_at: Timestamp.now(),
  });

  return { success: true };
});

/**
 * Callable: Block a user
 * ユーザーブロック
 */
export const blockUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { target_uid } = request.data;
  if (!target_uid) {
    throw new HttpsError("invalid-argument", "ブロック対象のユーザーIDが必要です。");
  }

  await db.collection("users").doc(request.auth.uid).update({
    blocked_users: FieldValue.arrayUnion(target_uid),
    updated_at: Timestamp.now(),
  });

  return { success: true, message: "ユーザーをブロックしました。" };
});

/**
 * Callable: Unblock a user
 * ブロック解除
 */
export const unblockUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { target_uid } = request.data;
  if (!target_uid) {
    throw new HttpsError("invalid-argument", "対象のユーザーIDが必要です。");
  }

  await db.collection("users").doc(request.auth.uid).update({
    blocked_users: FieldValue.arrayRemove(target_uid),
    updated_at: Timestamp.now(),
  });

  return { success: true, message: "ブロックを解除しました。" };
});

/**
 * Callable: Get the caller's own blocked-users list with resolved details
 * ブロックリスト（ニックネーム・写真解決済み）
 *
 * `blocked_users` lives on the caller's own doc (self-readable directly by
 * the client per firestore.rules), but resolving each blocked uid's own
 * nickname/photo requires reading OTHER users' docs, which the same
 * owner-only rule blocks — hence a callable, using the Admin SDK to bypass
 * it. Returns the same `{items: [...]}` pipe-joined-string shape as
 * `getDiscoveryCasts`, for the same reason: this project's DSL client side
 * already has a generic `splitFieldFn` extractor built around that exact
 * convention.
 */
export const getBlockedUsersDetails = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const ownDoc = await db.collection("users").doc(request.auth.uid).get();
  const blockedIds: string[] = ownDoc.data()?.blocked_users || [];

  const docs = await Promise.all(
    blockedIds.map((id) => db.collection("users").doc(id).get())
  );

  const items = docs
    // A blocked account may since have been deleted — skip it rather than
    // crash the whole list.
    .filter((d) => d.exists)
    .map((d) => {
      const data = d.data()!;
      const nickname = (data.nickname || "").toString().replaceAll("|||", "");
      const photoUrl = (data.profile_image_url || "").toString().replaceAll("|||", "");
      return `${d.id}|||${nickname}|||${photoUrl}`;
    });

  return { success: true, items };
});

/**
 * Callable: Report a user
 * ユーザー通報
 */
export const reportUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { reported_id, reason, res_id, chat_log_ref } = request.data;
  const reporterId = request.auth.uid;

  if (!reported_id || !reason) {
    throw new HttpsError("invalid-argument", "通報対象と理由が必要です。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, MEDIUM — comprehensive project-wide
  // review): `res_id` used to be taken verbatim from client input with no
  // check that the reporter (or the reported user) was actually a
  // participant of that reservation. `adminGetReportChatLog` trusts this
  // `res_id` to pull up a chat log as "evidence" — a caller could attach
  // a res_id from a reservation they were never part of, surfacing an
  // unrelated (and potentially damaging) chat log as evidence against the
  // reported user during admin review.
  if (res_id) {
    const resDoc = await db.collection("reservations").doc(res_id).get();
    const resData = resDoc.data();
    const isReporterParticipant =
      !!resData && (resData.guest_id === reporterId || resData.cast_ids?.includes(reporterId));
    if (!isReporterParticipant) {
      throw new HttpsError("permission-denied", "この予約に関する通報は行えません。");
    }
  }

  // FIX (PROJECT_KNOWLEDGE.md §70): no dedupe/rate-limit existed at all —
  // unlike submitReview's deterministic-doc-id dedupe, this used a plain
  // `.add()` with no scoping, so a user could spam-file unlimited reports
  // against the same target, flooding adminGetReports' pending queue.
  const existingPending = await db
    .collection("reports")
    .where("reporter_id", "==", reporterId)
    .where("reported_id", "==", reported_id)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!existingPending.empty) {
    throw new HttpsError(
      "failed-precondition",
      "このユーザーへの通報はすでに受付済みです。管理者の対応をお待ちください。"
    );
  }

  await db.collection("reports").add({
    reporter_id: reporterId,
    reported_id,
    res_id: res_id || "",
    reason,
    chat_log_ref: chat_log_ref || "",
    status: "pending",
    admin_note: "",
    created_at: Timestamp.now(),
  });

  return { success: true, message: "通報を受け付けました。" };
});

/**
 * Callable: Submit a general inquiry to the operator
 * お問い合わせ（運営への一般問い合わせ、reportUserとは別 - 特定ユーザーの通報ではない）
 */
export const submitInquiry = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { subject, message } = request.data;

  if (!subject || !message) {
    throw new HttpsError("invalid-argument", "件名と内容が必要です。");
  }

  await db.collection("inquiries").add({
    uid: request.auth.uid,
    subject,
    message,
    status: "pending",
    admin_note: "",
    created_at: Timestamp.now(),
  });

  return { success: true, message: "お問い合わせを受け付けました。" };
});

/**
 * Callable: Request account withdrawal (退会申請)
 */
export const requestWithdrawal = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();

  if (!userData) {
    throw new HttpsError("not-found", "ユーザーが見つかりません。");
  }

  if (userData.logical_debt > 0) {
    throw new HttpsError(
      "failed-precondition",
      "論理負債が存在するため退会できません。"
    );
  }

  const activeRes = await db
    .collection("reservations")
    .where("guest_id", "==", uid)
    .where("status", "not-in", ["completed", "cancelled", "expired"])
    .limit(1)
    .get();

  const activeCastRes = await db
    .collection("reservations")
    .where("cast_ids", "array-contains", uid)
    .where("status", "not-in", ["completed", "cancelled", "expired"])
    .limit(1)
    .get();

  if (!activeRes.empty || !activeCastRes.empty) {
    throw new HttpsError(
      "failed-precondition",
      "進行中の予約が存在するため退会できません。"
    );
  }

  const pendingLedger = await db
    .collection("ledger")
    .where("user_id", "==", uid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!pendingLedger.empty) {
    throw new HttpsError(
      "failed-precondition",
      "送金処理中の台帳が存在するため退会できません。"
    );
  }

  if (userData.account_type === "cast") {
    const pendingRewards = await db
      .collection("affiliate_rewards")
      .where("affiliator_uid", "==", uid)
      .where("status", "==", "pending")
      .get();

    const batch = db.batch();
    pendingRewards.forEach((doc) => {
      batch.update(doc.ref, { status: "forfeited" });
    });
    await batch.commit();
  }

  await db.collection("users").doc(uid).update({
    is_active: false,
    is_online: false,
    left_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });

  await auth.updateUser(uid, { disabled: true });
  // FIX (PROJECT_KNOWLEDGE.md §70 — comprehensive project-wide review):
  // `disabled: true` only blocks NEW sign-ins — an already-issued ID token
  // is still accepted by every onCall function (none check revocation)
  // until it naturally expires, up to ~1 hour. A user who just withdrew
  // could keep calling authenticated endpoints for up to an hour
  // afterward. `revokeRefreshTokens` invalidates existing tokens
  // immediately (the client's next request with that token is rejected).
  await auth.revokeRefreshTokens(uid);

  return { success: true, message: "退会処理が完了しました。" };
});

/**
 * Callable: list active service areas (prefectures)
 * サービス提供エリア（都道府県）一覧 — region-picker用。
 *
 * `system_config` is admin-only under firestore.rules (tightened earlier
 * this project, no client-side read precedent existed), so any
 * authenticated user needing the active-prefecture list for the
 * registration region picker must go through a callable rather than a
 * direct Firestore read — this is that callable. Deliberately NOT
 * admin-gated (unlike adminGetSystemConfig) since every signed-in user,
 * guest or cast, needs this during BasicInfoRegistration; only exposes
 * the prefecture names, never the rest of system_config (fee rates,
 * thresholds, etc.).
 */
export const getServiceAreas = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const config = await getSystemConfig();
  const areas = (config.service_areas || [])
    .filter((a) => a.active === true)
    .map((a) => a.prefecture);

  return { success: true, areas };
});

/**
 * Callable: nearby-cast discovery list for Home
 * Home画面の近隣キャスト一覧 — オンライン→距離→最終ログイン順。
 *
 * BUG FIX (2026-08-11, found on a full-project review pass): the DSL-side
 * `fetchDiscoveryCasts` custom action originally ran this exact query
 * DIRECTLY from the client via `cloud_firestore`. `firestore.rules`' own
 * `users` rule is strictly owner-only (`allow read: if request.auth.uid
 * == document`, confirmed by reading the rules file directly — no admin
 * or role-based exception at all), so a query filtering on
 * `account_type`/`approval_status` (which can match many OTHER users'
 * documents, not just the caller's own) is provably unsatisfiable by that
 * rule for the general case — Firestore denies the ENTIRE query outright
 * at rule-evaluation time, before it ever runs against real data. The
 * client-side action's own try/catch swallowed this into a silent empty
 * list, so the whole Home ranking query feature has been non-functional
 * (always showing zero casts) since it was built, with no visible error
 * anywhere. Real fix, not a workaround: move the query server-side
 * (Admin SDK bypasses Firestore rules entirely, the same reason
 * `getServiceAreas` above exists), matching the established pattern for
 * every OTHER guest-facing read of restricted collections in this
 * backend. `lat`/`lng` are the CLIENT's own already-resolved coordinates
 * (device GPS or the prefecture-fallback table) — this function does not
 * resolve location itself, only the query/filter/sort that Firestore
 * rules block the client from doing directly.
 */
export const getDiscoveryCasts = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const { lat, lng } = request.data || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new HttpsError("invalid-argument", "lat/lngが必要です。");
  }

  // Phase 7 (2026-08-11): §3.6.17's own wording is specifically "blocked
  // users disappear from the BLOCKER's search results" - unidirectional,
  // scoped to the viewer's OWN `blocked_users` list, not the reverse case
  // (a cast who has blocked THIS guest still appearing is a separate,
  // undecided question - not silently assumed either way, left open).
  const viewerDoc = await db.collection("users").doc(uid).get();
  const blockedByViewer: string[] = viewerDoc.exists
    ? viewerDoc.data()?.blocked_users || []
    : [];

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

  // FIX (confirmed live bug, found during audit): `is_active` was never
  // checked - a cast who withdrew from the platform (`requestWithdrawal`,
  // this file) sets `is_active: false` but never touches `approval_status`
  // (still "approved"), so a departed cast remained fully visible and
  // bookable in Home discovery indefinitely. Excluded the same way
  // `is_frozen`/blocked-users already are, in-memory for consistency with
  // the existing pattern here.
  // FIX (PROJECT_KNOWLEDGE.md §70 — comprehensive project-wide review):
  // `is_stripe_restricted` was built specifically for this exclusion
  // (IMPLEMENTATION_PLAN.md §6 defect #4 / §3.9.4: "an unverified/Restricted
  // cast must be excluded from search results in real time") — written by
  // submitConnectOnboarding and kept live by stripe-webhooks.ts's
  // handleAccountUpdated — but was never actually wired into this filter.
  // A cast whose Stripe account later becomes restricted (failed
  // requirements, compliance hold) stayed fully visible and bookable.
  const rows = snapshot.docs
    .filter(
      (d) =>
        d.id !== uid &&
        d.data().is_frozen !== true &&
        d.data().is_active !== false &&
        d.data().is_stripe_restricted !== true &&
        !blockedByViewer.includes(d.id)
    )
    .map((d) => {
      const data = d.data();
      const isOnline = data.is_online === true;
      const dist = distanceKm(data.location);
      const lastLogin = data.last_login_at;
      const lastLoginMs =
        lastLogin && typeof lastLogin.toMillis === "function"
          ? lastLogin.toMillis()
          : 0;
      const nickname = (data.nickname?.toString() || "").replace(/\|\|\|/g, "");
      const photoUrl = (data.profile_image_url?.toString() || "").replace(
        /\|\|\|/g,
        ""
      );
      return { id: d.id, isOnline, dist, lastLoginMs, nickname, photoUrl };
    });

  rows.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return b.lastLoginMs - a.lastLoginMs;
  });

  const items = rows.map(
    (r) => `${r.id}|||${r.nickname}|||${r.photoUrl}|||${r.isOnline}`
  );

  return { success: true, items };
});
