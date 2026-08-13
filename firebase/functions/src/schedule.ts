/**
 * Cast Work-Calendar Cloud Functions (§3.7.2)
 * キャストの空き時間カレンダー（週1〜4選択→日付タップ→24時間・30分刻みグリッドで○×切替）
 *
 * `schedule_slots` (cast_id/date/start_at/end_at/status) already existed in
 * the schema with a correct, already-deployed firestore.rules entry
 * (cast can only read/write their own docs), but had exactly one backend
 * reference anywhere before this file — `cancelPayment` (stripe-payments.ts),
 * which reverts a cancelled reservation's slot back to "available". This
 * file is the client-facing half: the cast's own toggle mechanic, a
 * guest-facing read (the firestore rule forbids a guest from reading
 * another cast's slots directly, so that view must go through a callable),
 * and — as of PROJECT_KNOWLEDGE.md §68 — the shared slot-locking helpers
 * used by `reservations.ts`/`stripe-webhooks.ts`/`stripe-payments.ts`/
 * `admin.ts` to actually lock a slot to "reserved" at Authorize-time and
 * release it on every cancel/expire path. This file owns the `schedule_slots`
 * document shape and every read/write of it; the reservation lifecycle
 * files import the pure/query helpers below rather than constructing slot
 * doc IDs or queries themselves, so the shape can't drift between files.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, Timestamp } from "./config";

const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = 48;
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC-midnight day bucket a given instant falls in — the exact value
 * `readDaySlots`/the calendar UI match on (`schedule_slots.date`). Extracted
 * from `parseDayStart`'s own inline construction (PROJECT_KNOWLEDGE.md §68)
 * so every writer of a slot's `date` field — `toggleScheduleSlot` here, and
 * the new Authorize-time locking code in `stripe-webhooks.ts` — computes it
 * identically and can't drift into two subtly different day-bucketing
 * rules. This must be computed PER SLOT, never once for a whole multi-slot
 * booking: a reservation that spans midnight needs its slots split across
 * two different day buckets, or the ones past midnight silently never
 * match any `readDaySlots` query and never appear on the calendar.
 */
function dayStartOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Parses a "YYYY-MM-DD" string into that day's UTC midnight — the same
 * parsing convention `createReservation` already uses for its own `date`
 * field (`new Date(date)`, which the ECMAScript spec parses a date-only
 * string as UTC midnight), reused here for consistency rather than
 * inventing a different day-bucketing rule for the same kind of field.
 *
 * FIX (found during a comprehensive review re-check, PROJECT_KNOWLEDGE.md
 * §67): the original `isNaN(new Date(dateStr).getTime())` check alone lets
 * a calendar-invalid day silently roll over instead of being rejected —
 * confirmed `new Date("2026-02-30").getTime()` is a valid, non-NaN
 * timestamp for 2026-03-02, so `"2026-02-30"` passed straight through with
 * no error and quietly operated on the wrong day. `createReservation`
 * (reservations.ts) has this exact same gap — pre-existing, not unique to
 * this file, not fixed here (out of scope for this feature). Added a
 * strict `YYYY-MM-DD` shape check plus a round-trip re-format comparison,
 * which rejects any day/month that Date() would otherwise silently
 * normalize.
 */
function parseDayStart(dateStr: unknown): Date {
  if (typeof dateStr !== "string" || !DATE_FORMAT.test(dateStr)) {
    throw new HttpsError("invalid-argument", "日付の形式が不正です。");
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    throw new HttpsError("invalid-argument", "日付の形式が不正です。");
  }
  const dayStart = dayStartOf(d);
  const roundTrip = `${dayStart.getUTCFullYear().toString().padStart(4, "0")}-${(dayStart.getUTCMonth() + 1).toString().padStart(2, "0")}-${dayStart.getUTCDate().toString().padStart(2, "0")}`;
  if (roundTrip !== dateStr) {
    throw new HttpsError("invalid-argument", "存在しない日付です。");
  }
  return dayStart;
}

/**
 * Every 30-min-aligned slot start covering `[startAt, startAt+durationMinutes)`.
 * Floors `startAt` to the last 30-min boundary at or before it (defensive —
 * every real caller already sends 30-min-aligned starts, but this can't
 * under-cover a misaligned input, only conservatively over-cover by one
 * leading slot). Pure, no I/O.
 */
function computeSlotStartTimes(startAt: Date, durationMinutes: number): Date[] {
  const slotMs = SLOT_MINUTES * 60_000;
  const firstSlotMs = Math.floor(startAt.getTime() / slotMs) * slotMs;
  const endMs = startAt.getTime() + durationMinutes * 60_000;
  const starts: Date[] = [];
  for (let t = firstSlotMs; t < endMs; t += slotMs) {
    starts.push(new Date(t));
  }
  return starts;
}

/**
 * Deterministic `schedule_slots` doc ID for one cast's one 30-min slot —
 * the single source of truth for this convention, used by every writer
 * (`toggleScheduleSlot` here, plus the Authorize-time locking code in
 * `stripe-webhooks.ts`) so a lock and a manual toggle always resolve to the
 * exact same document instead of two different IDs for the same slot.
 */
function slotDocId(castId: string, slotStart: Date): string {
  return `${castId}_${slotStart.getTime()}`;
}

/**
 * Read-only, non-transactional check: does ANY of the given casts have a
 * non-available slot anywhere in `[startAt, startAt+durationMinutes)`?
 * Returns the first conflicting cast_id, or `null` if every slot for every
 * cast is available. Used by `createReservation` (reservations.ts) as an
 * ADVISORY guest-side check, deliberately not transactional — this can
 * still race against another guest's concurrent request for the same slot
 * (both could pass this before either authorizes). That's an accepted,
 * intentional gap: the authoritative enforcement is the transactional lock
 * in `stripe-webhooks.ts`'s `handleAmountCapturableUpdated`, which runs at
 * the moment real money is actually held. This check exists purely to give
 * a guest fast, friendly feedback before they ever reach the payment sheet.
 */
export async function findUnavailableCastId(
  castIds: string[],
  startAt: Date,
  durationMinutes: number
): Promise<string | null> {
  const uniqueCastIds = [...new Set(castIds)];
  const slotStarts = computeSlotStartTimes(startAt, durationMinutes);
  const refs = uniqueCastIds.flatMap((castId) =>
    slotStarts.map((slotStart) => ({
      castId,
      ref: db.collection("schedule_slots").doc(slotDocId(castId, slotStart)),
    }))
  );
  if (refs.length === 0) {
    return null;
  }
  const snaps = await db.getAll(...refs.map((r) => r.ref));
  for (let i = 0; i < refs.length; i++) {
    const status = snaps[i].exists ? snaps[i].data()?.status || "available" : "available";
    if (status !== "available") {
      return refs[i].castId;
    }
  }
  return null;
}

/**
 * Builds the `{cast_id × 30-min slot}` doc refs for a reservation's booked
 * window, alongside the base fields each slot doc needs (everything except
 * `status`/`res_id`, which the caller supplies depending on lock vs.
 * conflict outcome). Exported so `stripe-webhooks.ts`'s Authorize-time
 * locking transaction can build refs and fields without duplicating the
 * `dayStartOf`/`slotDocId`/`computeSlotStartTimes` composition itself.
 *
 * Dedupes `castIds` internally (PROJECT_KNOWLEDGE.md §68, found in
 * self-review) — this function's own correctness can't depend on every
 * caller having already deduped. A duplicate cast_id would otherwise
 * produce a duplicate doc ref, and the Authorize-time locking transaction
 * (stripe-webhooks.ts) would attempt two writes to the same document in
 * one transaction — territory this codebase has no reason to exercise.
 * `createReservation` (reservations.ts) already dedupes its own cast_ids
 * before this is ever called; this is defense-in-depth for any other
 * caller, present or future.
 */
export function buildReservationSlotRefs(
  castIds: string[],
  startAt: Date,
  durationMinutes: number
): {
  castId: string;
  slotStart: Date;
  ref: FirebaseFirestore.DocumentReference;
  baseFields: { cast_id: string; date: FirebaseFirestore.Timestamp; start_at: FirebaseFirestore.Timestamp; end_at: FirebaseFirestore.Timestamp };
}[] {
  const uniqueCastIds = [...new Set(castIds)];
  const slotStarts = computeSlotStartTimes(startAt, durationMinutes);
  return uniqueCastIds.flatMap((castId) =>
    slotStarts.map((slotStart) => {
      const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60_000);
      return {
        castId,
        slotStart,
        ref: db.collection("schedule_slots").doc(slotDocId(castId, slotStart)),
        baseFields: {
          cast_id: castId,
          date: Timestamp.fromDate(dayStartOf(slotStart)),
          start_at: Timestamp.fromDate(slotStart),
          end_at: Timestamp.fromDate(slotEnd),
        },
      };
    })
  );
}

/**
 * Every `schedule_slots` doc locked by one reservation. `res_id` is ONLY
 * ever written by the Authorize-time locking transaction (`stripe-webhooks.ts`),
 * which only ever sets `status:"reserved"` alongside it — so every match
 * here is safe to delete unconditionally, no separate status filter
 * needed. Single-field equality query, auto-indexed, no composite index
 * required.
 */
export function reservedSlotsQuery(resId: string): FirebaseFirestore.Query {
  return db.collection("schedule_slots").where("res_id", "==", resId);
}

/**
 * Non-transactional release for the one low-stakes call site that doesn't
 * need transactional atomicity with a reservation-status write
 * (`handlePaymentIntentFailed`, which fires pre-authorization in the
 * overwhelming common case — normally nothing to release). Every OTHER
 * cancel/expire path folds this same query+delete directly into its own
 * transaction instead (see `reservedSlotsQuery` usage in reservations.ts/
 * stripe-payments.ts/admin.ts) so a release can never be observed as
 * separate from the status change that caused it.
 *
 * Deletes rather than reverting to `status:"available"` — matches this
 * session's own established subtractive-model convention
 * (`toggleScheduleSlot`'s own fix, above) and is safe specifically because
 * a `"reserved"` doc's only legitimate origin is the lock transaction,
 * which never locks over an existing non-available doc. If anything else
 * ever writes `status:"reserved"` without going through that lock, this
 * delete would incorrectly destroy it instead of restoring it — there is
 * no such writer today, but this is why the invariant matters.
 */
export async function releaseReservationSlots(resId: string): Promise<void> {
  const snap = await reservedSlotsQuery(resId).get();
  if (snap.empty) {
    return;
  }
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

/**
 * Defense-in-depth hourly backstop (PROJECT_KNOWLEDGE.md §68), same cadence
 * as `autoCancelExpiredAuth`. Unlike this codebase's existing best-effort
 * `stripe.paymentIntents.cancel()` calls — where a failure just leaves a
 * stale Stripe hold that self-expires in ~7 days — an orphaned
 * `"reserved"` schedule_slots doc has NO self-healing path and would
 * otherwise block that cast's calendar forever if a release step ever
 * fails partway (process crash between two writes, transient error in a
 * best-effort path, a future bug). Scans every currently-`"reserved"` slot,
 * looks up its `res_id`'s reservation, and deletes the slot if that
 * reservation is missing or already terminal (`cancelled`/`expired`/
 * `completed`) — i.e. any slot that SHOULD have been released already, by
 * some other path, but wasn't.
 */
export const autoReleaseOrphanedSlots = onSchedule("every 1 hours", async () => {
  const reservedSnap = await db.collection("schedule_slots").where("status", "==", "reserved").get();
  if (reservedSnap.empty) {
    return;
  }

  const TERMINAL_STATUSES = ["cancelled", "expired", "completed"];

  for (const slotDoc of reservedSnap.docs) {
    const resId: string | undefined = slotDoc.data().res_id;
    if (!resId) {
      // A "reserved" slot with no res_id can't have come from the lock
      // transaction (which always writes res_id alongside status:"reserved")
      // — leave it alone rather than guessing; this shouldn't happen.
      continue;
    }
    try {
      const resSnap = await db.collection("reservations").doc(resId).get();
      const shouldRelease = !resSnap.exists || TERMINAL_STATUSES.includes(resSnap.data()?.status);
      if (shouldRelease) {
        console.log(`Releasing orphaned reserved slot ${slotDoc.id} (res_id=${resId})`);
        await slotDoc.ref.delete();
      }
    } catch (err) {
      console.error(`Failed to check/release orphaned slot ${slotDoc.id}:`, err);
    }
  }
});

/**
 * Confirms `uid` is a cast account. FIX (comprehensive review re-check,
 * §67): the original version of this file had no such check at all on
 * `getMySchedule`/`toggleScheduleSlot` — any authenticated user, including
 * a guest account, could create `schedule_slots` documents under their own
 * uid. Not previously exploitable for concrete harm (the firestore rule is
 * equally permissive, and no other reader treats every doc as belonging to
 * a real cast), but a real inconsistency against this codebase's own
 * established convention for "cast-only" actions (see `applyToWorkPost`,
 * work-posts.ts).
 *
 * Deliberately checks `account_type` only, NOT `approval_status` — unlike
 * `applyToWorkPost` (an active marketplace action, correctly gated on full
 * approval), setting up one's own availability calendar is closer to
 * profile setup than a marketplace action; requiring full approval here
 * would block a legitimate not-yet-approved cast from preparing their
 * calendar before review completes, trading one real gap for a worse one.
 */
async function requireCastAccount(uid: string): Promise<void> {
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();
  if (!userData || userData.account_type !== "cast") {
    throw new HttpsError("permission-denied", "キャストアカウントのみ利用できます。");
  }
}

/**
 * Returns exactly 48 status strings for one cast's one day, index === slot
 * position (0 = 00:00-00:30 ... 47 = 23:30-00:00). A slot with no matching
 * document is implicitly "available" (the "subtractive" model — the cast's
 * baseline is available, and only non-default slots — cast-blocked or
 * booked — exist as real documents).
 */
async function readDaySlots(castId: string, dateStr: string): Promise<string[]> {
  const dayStart = parseDayStart(dateStr);
  const dayStartTs = Timestamp.fromDate(dayStart);
  const snap = await db
    .collection("schedule_slots")
    .where("cast_id", "==", castId)
    .where("date", "==", dayStartTs)
    .get();

  const byMillis = new Map<number, string>();
  snap.forEach((doc) => {
    const startAt = doc.data().start_at;
    if (startAt?.toMillis) {
      byMillis.set(startAt.toMillis(), doc.data().status || "available");
    }
  });

  const items: string[] = [];
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const slotStartMillis = dayStart.getTime() + i * SLOT_MINUTES * 60_000;
    items.push(byMillis.get(slotStartMillis) || "available");
  }
  return items;
}

/**
 * Callable: get the signed-in cast's own schedule for one day.
 * 自分の空き時間（1日分・48枠）を取得する。
 */
export const getMySchedule = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  await requireCastAccount(request.auth.uid);
  const { date } = request.data;
  const items = await readDaySlots(request.auth.uid, date);
  return { success: true, items };
});

/**
 * Callable: toggle one 30-minute slot between available/unavailable.
 * 1枠（30分）の空き状態を切り替える（予約済みの枠は変更不可）。
 *
 * Deterministic doc ID (cast_id + slot start time in millis) makes
 * create-or-update a single atomic `.set(..., {merge:true})` inside a
 * transaction — the same deterministic-ID-for-atomicity approach already
 * used by `submitReview` (reservations.ts) for its own duplicate-safety
 * requirement, reused here for the same reason: two rapid taps on the same
 * cell must not race.
 */
export const toggleScheduleSlot = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  const uid = request.auth.uid;
  await requireCastAccount(uid);
  const { date, slot_index } = request.data;

  if (
    typeof slot_index !== "number" ||
    !Number.isInteger(slot_index) ||
    slot_index < 0 ||
    slot_index >= SLOTS_PER_DAY
  ) {
    throw new HttpsError("invalid-argument", "slot_indexが不正です。");
  }

  const dayStart = parseDayStart(date);
  const startAt = new Date(dayStart.getTime() + slot_index * SLOT_MINUTES * 60_000);
  const endAt = new Date(startAt.getTime() + SLOT_MINUTES * 60_000);
  const slotRef = db.collection("schedule_slots").doc(slotDocId(uid, startAt));

  const newStatus = await db.runTransaction(async (tx) => {
    const snap = await tx.get(slotRef);
    const current = snap.exists ? snap.data()?.status || "available" : "available";

    if (current === "reserved") {
      throw new HttpsError(
        "failed-precondition",
        "この時間帯は予約済みのため変更できません。"
      );
    }

    const next = current === "available" ? "unavailable" : "available";
    if (next === "available") {
      // FIX (comprehensive review re-check, §67): toggling back to the
      // default state used to `.set(..., {merge:true})` a literal
      // `status: "available"` doc, contradicting this file's own stated
      // "subtractive" model (a slot only gets a real document once it's
      // non-default). Delete instead — restores the true "no document ==
      // available" baseline rather than leaving a permanent, never-cleaned
      // "available" doc behind for every slot any cast has ever toggled.
      tx.delete(slotRef);
    } else {
      tx.set(slotRef, {
        cast_id: uid,
        date: Timestamp.fromDate(dayStart),
        start_at: Timestamp.fromDate(startAt),
        end_at: Timestamp.fromDate(endAt),
        status: next,
      });
    }
    return next;
  });

  return { success: true, status: newStatus };
});

/**
 * Callable: read-only view of a SPECIFIC cast's schedule for one day, for
 * the guest-facing calendar. firestore.rules restricts direct client reads
 * of `schedule_slots` to the owning cast (or admin) — this callable is the
 * only way a guest can see another cast's availability at all.
 * 指定キャストの空き時間（1日分・48枠）を取得する（ゲスト側閲覧用）。
 */
export const getCastScheduleForGuest = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "認証が必要です。");
  }
  const { cast_id, date } = request.data;
  if (typeof cast_id !== "string" || !cast_id) {
    throw new HttpsError("invalid-argument", "cast_idが必要です。");
  }

  const castDoc = await db.collection("users").doc(cast_id).get();
  // FIX (comprehensive review re-check, §67): only checked the target
  // document existed, not that it's actually a cast account — a guest
  // could query another guest's (always-empty) "schedule" as a weak
  // existence oracle. Folded into the same not-found response as a
  // genuinely missing doc, rather than a distinct error, so this doesn't
  // leak account-type information either.
  if (!castDoc.exists || castDoc.data()?.account_type !== "cast") {
    throw new HttpsError("not-found", "キャストが見つかりません。");
  }

  const items = await readDaySlots(cast_id, date);
  return { success: true, items };
});
