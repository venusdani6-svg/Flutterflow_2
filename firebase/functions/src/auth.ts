/**
 * Auth & User Management Cloud Functions
 * 認証・ユーザー管理
 */
import * as functionsV1 from "firebase-functions/v1";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, auth, stripe, FieldValue, Timestamp } from "./config";

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

  const birthDate = new Date(birth_date);
  const now = new Date();
  const age = now.getFullYear() - birthDate.getFullYear();
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

  await db.collection("users").doc(uid).update({
    kyc_doc_url: doc_url,
    kyc_selfie_url: selfie_url,
    kyc_status: "submitted",
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
 * Callable: Report a user
 * ユーザー通報
 */
export const reportUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const { reported_id, reason, res_id, chat_log_ref } = request.data;

  if (!reported_id || !reason) {
    throw new HttpsError("invalid-argument", "通報対象と理由が必要です。");
  }

  await db.collection("reports").add({
    reporter_id: request.auth.uid,
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
    updated_at: Timestamp.now(),
  });

  await auth.updateUser(uid, { disabled: true });

  return { success: true, message: "退会処理が完了しました。" };
});
