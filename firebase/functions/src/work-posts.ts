/**
 * Work Board Cloud Functions
 * ワーク（募集）掲示板
 *
 * `work_posts` is written by two producers: reservations.ts (system-
 * generated "partner_recruit" posts, created when a cast accepts a
 * group-invite reservation) and admin.ts (admin-authored "security"/
 * "transport" staff job posts). Both share one status machine
 * (open -> filled -> closed) and one `applicants`/`selected_id` shape.
 * Everything in admin.ts for this collection is admin-only
 * (adminGetWorkPosts/adminCloseWorkPost/adminCreateWorkPost/
 * adminHireWorkPostApplicant) - there was no client-facing way for a
 * cast/staff member to actually apply to a post, or for a post's own
 * poster (not an admin) to review and select an applicant, confirmed by
 * grepping this whole backend before writing this file. This file is
 * that missing client-facing half.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, Timestamp, FieldValue } from "./config";

/**
 * Callable: apply to an open work post
 * ワーク投稿への応募
 */
export const applyToWorkPost = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const { post_id } = request.data;
  if (!post_id) {
    throw new HttpsError("invalid-argument", "post_idが必要です。");
  }

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();
  if (!userData || userData.account_type !== "cast" || userData.approval_status !== "approved") {
    throw new HttpsError("permission-denied", "承認済みキャストのみ応募できます。");
  }

  const postRef = db.collection("work_posts").doc(post_id);
  const postSnap = await postRef.get();
  if (!postSnap.exists) {
    throw new HttpsError("not-found", "投稿が見つかりません。");
  }
  const postData = postSnap.data()!;

  if (postData.status !== "open") {
    throw new HttpsError("failed-precondition", "この投稿は募集を終了しています。");
  }
  if (postData.poster_id === uid) {
    throw new HttpsError("failed-precondition", "自分の投稿には応募できません。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, MEDIUM — comprehensive project-wide
  // review): `blocked_users` was checked at booking time
  // (createReservation, reservations.ts) but never anywhere in this file —
  // a cast/staff member who had blocked a specific poster (or been blocked
  // by them) could still apply to that poster's job, and the poster could
  // still select them, spinning up a coordination chat room pairing the
  // two together despite an active block. Checked both directions, same
  // as `getDiscoveryCasts`'s own convention.
  if (userData.blocked_users?.includes(postData.poster_id)) {
    throw new HttpsError("permission-denied", "この投稿には応募できません。");
  }
  const posterDoc = await db.collection("users").doc(postData.poster_id).get();
  if (posterDoc.data()?.blocked_users?.includes(uid)) {
    throw new HttpsError("permission-denied", "この投稿には応募できません。");
  }

  // Type-specific eligibility: "security"/"transport" job posts require
  // the applicant to actually hold that staff role; "partner_recruit"
  // (group-invite) posts are open to any approved cast, same as the
  // reservation itself would have been.
  if (postData.type === "security" || postData.type === "transport") {
    if (userData.staff_type !== postData.type && userData.staff_type !== "both") {
      throw new HttpsError(
        "failed-precondition",
        "このワークに対応する兼務設定（マイワーク画面）がありません。"
      );
    }
  } else if (postData.type !== "partner_recruit") {
    throw new HttpsError("failed-precondition", "この投稿タイプには応募できません。");
  }

  const applicants: string[] = postData.applicants || [];
  if (applicants.includes(uid)) {
    throw new HttpsError("already-exists", "すでに応募済みです。");
  }

  // FIX (confirmed live bug, comprehensive review): was a non-atomic
  // read-modify-write (`applicants: [...applicants, uid]`) — two casts
  // applying within the same read window both pass the not-already-applied
  // check above, then whichever `update()` lands second silently overwrites
  // the first's write, so one cast gets `{success:true}` but never actually
  // appears in `applicants`. `FieldValue.arrayUnion` is atomic server-side
  // and already the established pattern for this exact array-membership
  // shape elsewhere in this codebase (auth.ts's blockUser/unblockUser).
  await postRef.update({ applicants: FieldValue.arrayUnion(uid) });

  await db.collection("users").doc(postData.poster_id).collection("notifications").add({
    type: "work",
    title: "ワーク投稿に応募がありました",
    body: `${userData.nickname} さんが応募しました。`,
    data: { post_id },
    read: false,
    created_at: Timestamp.now(),
  });

  return { success: true };
});

/**
 * Callable: select an applicant off one's OWN work post (poster-facing,
 * not admin — distinct from adminHireWorkPostApplicant)
 * 自分のワーク投稿から応募者を選定
 */
export const selectWorkApplicant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const { post_id, applicant_id } = request.data;
  if (!post_id || !applicant_id) {
    throw new HttpsError("invalid-argument", "post_idとapplicant_idが必要です。");
  }

  // FIX (PROJECT_KNOWLEDGE.md §70, HIGH — comprehensive project-wide
  // review): this used to be a plain, non-transactional read-check-write —
  // two near-simultaneous selectWorkApplicant calls for the same post
  // (poster double-taps "select" for two different applicants) could both
  // pass the `status === "open"` guard before either write landed. Both
  // would then send the "あなたの応募が選定されました" (you're selected)
  // notification to their respective applicant — a false "you got the job"
  // notification for whichever one ISN'T the eventual (last-write-wins)
  // `selected_id`. Worse, for security/transport posts, the OLD
  // `[...existingStaffIds, applicant_id]` staff_ids mutation below was a
  // plain read-modify-write, not `arrayUnion` — a genuine lost-update: if
  // two concurrent calls both read staff_ids before either writes, the
  // second write can overwrite the first's addition, so a staff member can
  // be marked `selected_id` and notified "selected" yet never actually
  // land in `reservations.staff_ids` — meaning
  // `recordCastRewardsAndProcessOthers` never pays them their share of the
  // already-authorized `staff_fee`. Same bug class `applyToWorkPost` was
  // already fixed for via `arrayUnion` (above) — never carried into this
  // function. Fixed with a transaction (only one caller can win the
  // status transition, matching `respondToReservation`'s identical fix)
  // plus `arrayUnion` for the staff_ids append.
  const postRef = db.collection("work_posts").doc(post_id);
  const postData = await db.runTransaction(async (tx) => {
    const postSnap = await tx.get(postRef);
    if (!postSnap.exists) {
      throw new HttpsError("not-found", "投稿が見つかりません。");
    }
    const data = postSnap.data()!;

    if (data.poster_id !== uid) {
      throw new HttpsError("permission-denied", "自分の投稿のみ操作できます。");
    }
    if (data.status !== "open") {
      throw new HttpsError("failed-precondition", "この投稿はすでに処理済みです。");
    }
    const applicants: string[] = data.applicants || [];
    if (!applicants.includes(applicant_id)) {
      throw new HttpsError("failed-precondition", "指定された応募者はこの投稿に応募していません。");
    }

    // Firestore transactions require every read before every write — the
    // reservation existence check (mirroring the original code's own
    // `if (resSnap.exists)` guard) must happen here, before either
    // tx.update() below, not interleaved with them.
    let resRef: FirebaseFirestore.DocumentReference | null = null;
    if ((data.type === "security" || data.type === "transport") && data.res_id) {
      const candidateRef = db.collection("reservations").doc(data.res_id);
      const resSnap = await tx.get(candidateRef);
      if (resSnap.exists) {
        resRef = candidateRef;
      }
    }

    tx.update(postRef, { status: "filled", selected_id: applicant_id });
    if (resRef) {
      tx.update(resRef, { staff_ids: FieldValue.arrayUnion(applicant_id) });
    }

    return data;
  });

  await db.collection("users").doc(applicant_id).collection("notifications").add({
    type: "work",
    title: "ワーク応募が承認されました",
    body: "あなたの応募が選定されました。",
    data: { post_id },
    read: false,
    created_at: Timestamp.now(),
  });

  // Dedicated cast-to-cast coordination chat room for group-invite
  // recruitment (§3.7.6) — only for partner_recruit posts; the guest+cast
  // chat room the reservation itself already has (created in
  // respondToReservation) is a separate thing, this one is specifically
  // for the poster and the newly-joined cast to coordinate directly.
  // Reuses the same chat_rooms shape (participants/active/created_at/
  // closed_at) — res_id is set so this room is still traceable back to
  // the underlying reservation for moderation purposes (§3.8.12), even
  // though its participants differ from the reservation's own room.
  let chatRoomId: string | null = null;
  if (postData.type === "partner_recruit") {
    const chatRef = db.collection("chat_rooms").doc();
    await chatRef.set({
      room_id: chatRef.id,
      res_id: postData.res_id || "",
      participants: [postData.poster_id, applicant_id],
      active: true,
      created_at: Timestamp.now(),
      closed_at: null,
    });
    chatRoomId = chatRef.id;
  }

  return { success: true, chat_room_id: chatRoomId };
});

/**
 * Callable: list open work posts (client-facing browse, scoped to what a
 * cast is actually allowed to see/apply to — mirrors adminGetWorkPosts'
 * shape but without the admin gate, and only ever returns "open" posts
 * since a browsing cast has no legitimate reason to see filled/closed ones
 * other than their own history, which fetchMyWorkPosts covers separately).
 * ワーク投稿一覧の取得
 */
export const fetchWorkPosts = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  // `type` filtering is done in-memory below, not as a server-side
  // `.where()` — an optional third filter alongside status+orderBy would
  // need its own composite index per filter combination actually used
  // (the same combinatorial-index-explosion concern already documented
  // for adminGetLedger/adminGetReservations in this backend). Post volume
  // is expected to be low enough that filtering 100 already-fetched docs
  // in memory is cheap and avoids that entirely.
  const { type } = request.data;

  const snapshot = await db
    .collection("work_posts")
    .where("status", "==", "open")
    .orderBy("created_at", "desc")
    .limit(100)
    .get();
  let posts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  if (type) posts = posts.filter((p) => (p as { type?: string }).type === type);

  const posterIds = Array.from(
    new Set(posts.map((p) => (p as { poster_id?: string }).poster_id).filter((id): id is string => !!id))
  );
  const posterDocs = await Promise.all(posterIds.map((id) => db.collection("users").doc(id).get()));
  const nicknames: Record<string, string> = {};
  posterDocs.forEach((doc, i) => {
    nicknames[posterIds[i]] = doc.exists ? (doc.data()?.nickname as string) || "" : "";
  });

  return {
    success: true,
    posts: posts.map((p) => ({
      ...p,
      poster_nickname: nicknames[(p as { poster_id?: string }).poster_id || ""] || "",
    })),
  };
});

/**
 * Callable: get a single work post's detail, including applicant
 * nicknames if the caller is the post's own poster (applicants are
 * otherwise not exposed to other browsers, same visibility rule
 * adminGetWorkPosts already applies at the admin layer).
 * ワーク投稿の詳細取得
 */
export const getWorkPostDetail = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;
  const { post_id } = request.data;
  if (!post_id) {
    throw new HttpsError("invalid-argument", "post_idが必要です。");
  }

  const postSnap = await db.collection("work_posts").doc(post_id).get();
  if (!postSnap.exists) {
    throw new HttpsError("not-found", "投稿が見つかりません。");
  }
  const postData = postSnap.data()!;
  const isPoster = postData.poster_id === uid;

  const posterDoc = await db.collection("users").doc(postData.poster_id).get();
  const posterNickname = posterDoc.exists ? (posterDoc.data()?.nickname as string) || "" : "";

  const applicants: string[] = postData.applicants || [];
  let applicantsResolved: { id: string; nickname: string }[] = [];
  if (isPoster && applicants.length > 0) {
    const applicantDocs = await Promise.all(
      applicants.map((id) => db.collection("users").doc(id).get())
    );
    applicantsResolved = applicants.map((id, i) => ({
      id,
      nickname: applicantDocs[i].exists ? (applicantDocs[i].data()?.nickname as string) || "" : "",
    }));
  }

  return {
    success: true,
    post: { id: postSnap.id, ...postData },
    poster_nickname: posterNickname,
    is_poster: isPoster,
    has_applied: applicants.includes(uid),
    applicants_resolved: applicantsResolved,
  };
});

/**
 * Callable: the caller's own work-board activity — posts they authored
 * (to manage applications) and posts they've applied to (to track
 * status). Split into two lists rather than one merged/tagged list since
 * the UI needs for "manage my post" vs "check my application" are
 * different enough to warrant separate sections, not one mixed feed.
 * 自分のワーク投稿・応募状況の取得
 */
export const fetchMyWorkPosts = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }

  const uid = request.auth.uid;

  const [postedSnap, appliedSnap] = await Promise.all([
    db.collection("work_posts").where("poster_id", "==", uid).orderBy("created_at", "desc").get(),
    db.collection("work_posts").where("applicants", "array-contains", uid).orderBy("created_at", "desc").get(),
  ]);

  return {
    success: true,
    posted: postedSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    applied: appliedSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
});
