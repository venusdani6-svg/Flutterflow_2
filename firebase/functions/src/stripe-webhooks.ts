/**
 * Stripe Webhook Handlers (冪等性管理)
 * stripe_event_id + event_type で二重処理を完全に防止
 */
import { onRequest } from "firebase-functions/v2/https";
import { db, stripe, FieldValue, Timestamp, stripeWebhookSecret, sendPushNotification } from "./config";
import { recordCastRewardsAndProcessOthers } from "./stripe-payments";
import { buildReservationSlotRefs, releaseReservationSlots } from "./schedule";

/** Sentinel thrown inside the idempotency transaction to signal "already processed" without treating it as a real error. */
class AlreadyProcessedError extends Error {}

/**
 * HTTP Endpoint: Stripe Webhook receiver
 */
export const stripeWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  let event: any;

  // FIX (confirmed live bug, found during comprehensive review): this used
  // to fail OPEN — if `stripeWebhookSecret` were ever unset (env rotation
  // gap, fresh environment, accidental `.env` loss), it silently skipped
  // signature verification entirely and trusted `req.body` as-is, meaning
  // this public HTTPS endpoint would accept a completely unsigned,
  // forgeable POST as a genuine Stripe event (arbitrary
  // `payment_intent.succeeded`/`account.updated`/etc. with attacker-chosen
  // `metadata.res_id`, `amount_received`, etc.). Currently mitigated in
  // practice (the secret is confirmed set — PROJECT_KNOWLEDGE.md §49), but
  // the code itself had no guard against this ever regressing. Now fails
  // CLOSED: a missing secret rejects every request outright instead of
  // silently degrading to "accepts anything anyone POSTs."
  if (!stripeWebhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured — refusing to process any webhook.");
    res.status(500).send("Webhook not configured");
    return;
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).send("Missing stripe-signature header");
    return;
  }
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret);
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const eventId = event.id;
  const eventType = event.type;

  console.log(`Webhook received: ${eventType} (${eventId})`);

  // Idempotency: atomically reserve this event ID BEFORE any side effects.
  //
  // FIX (was a real bug): this used to be a bare `get()` here, with the
  // actual `processed_events` write only happening at the very end, after
  // stripe_logs/notifications/event-specific handling had already run. That
  // left a wide race window open the entire time a webhook was processing -
  // two near-simultaneous deliveries of the SAME event (Stripe's own
  // at-least-once delivery model makes this a real, not just theoretical,
  // case) could both pass the early `exists` check before either one
  // reached the write at the end, and both would then run every side effect
  // a second time (double stripe_logs rows, double notifications, double
  // ledger/Transfer-triggering event handling).
  //
  // `transaction.create()` throws if the doc already exists, so wrapping
  // the check-and-write in one transaction makes two concurrent invocations
  // for the same event ID mutually exclusive: only one can ever succeed in
  // creating the doc, and Firestore's optimistic-concurrency retry ensures
  // the other sees it as already-existing rather than racing past it.
  //
  // Trade-off, accepted deliberately: this reserves the ID before, not
  // after, processing succeeds - so if the event-specific handler below
  // throws partway through, Stripe's retry of the same event will see this
  // doc already exists and be treated as a duplicate (skipped), rather than
  // retried. A genuine mid-processing crash is a much rarer failure mode
  // than concurrent duplicate delivery, and every side effect in this file
  // is itself either idempotent-by-construction (Firestore `update`s to the
  // same fields) or already flows through `ledger`/reservation-status
  // fields an admin can audit - so this trade favors closing the common,
  // confirmed race over guaranteeing retry of the rare crash case.
  const processedRef = db.collection("processed_events").doc(eventId);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(processedRef);
      if (existing.exists) {
        throw new AlreadyProcessedError();
      }
      tx.create(processedRef, {
        event_type: eventType,
        processed_at: Timestamp.now(),
      });
    });
  } catch (err) {
    if (err instanceof AlreadyProcessedError) {
      console.log(`Event ${eventId} already processed, skipping.`);
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    throw err;
  }

  // Log raw event
  const ttlDate = new Date();
  ttlDate.setDate(ttlDate.getDate() + 90);

  await db.collection("stripe_logs").add({
    stripe_event_id: eventId,
    event_type: eventType,
    res_id: event.data?.object?.metadata?.res_id || "",
    raw_data: event.data?.object || {},
    created_at: Timestamp.now(),
    ttl: Timestamp.fromDate(ttlDate),
  });

  // FIX (comprehensive project-wide review, 2026-08-17): removed the
  // unconditional `mirrorStripeNotification(event)` call that used to run
  // here for EVERY event, before dispatch. Every event type actually
  // handled below already writes its OWN purpose-built, localized
  // notification (see each `handle*` function) — this ran in ADDITION to
  // that, meaning a guest whose payment succeeded got TWO notifications:
  // the real one ("決済が完了しました" with a clean amount) and this one
  // (literally "Stripe: payment_intent.succeeded" with a truncated raw
  // JSON dump as the body — a leftover debug/dev-visibility mechanism
  // never gated out once the real per-event notifications were built, not
  // an intentional design). Worse, `data.raw` embedded the full raw Stripe
  // object (customer IDs, internal metadata) into a USER-visible
  // notification document. Any event type NOT specifically handled below
  // (the `default:` case) is already fully captured, unconditionally, in
  // `stripe_logs` just above — admin-visible, no separate user-facing
  // fallback needed for those either.

  // Event-specific handling
  try {
    switch (eventType) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event.data.object);
        break;
      case "payment_intent.canceled":
        await handlePaymentIntentCanceled(event.data.object);
        break;
      case "payment_intent.amount_capturable_updated":
        await handleAmountCapturableUpdated(event.data.object);
        break;
      case "transfer.created":
        await handleTransferCreated(event.data.object);
        break;
      case "transfer.failed":
        await handleTransferFailed(event.data.object);
        break;
      case "identity.verification_session.verified":
        await handleIdentityVerified(event.data.object);
        break;
      case "identity.verification_session.requires_input":
        await handleIdentityRequiresInput(event.data.object);
        break;
      case "account.updated":
        await handleAccountUpdated(event.data.object);
        break;
      case "payout.paid":
        await handlePayoutPaid(event.data.object);
        break;
      case "payout.failed":
        await handlePayoutFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${eventType}`);
    }

    // `processed_events` was already created upfront by the idempotency
    // transaction at the top of this handler — no write needed here.
    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`Error processing webhook ${eventType}:`, err);
    res.status(500).json({ error: err.message });
  }
});

async function handlePaymentIntentSucceeded(paymentIntent: any): Promise<void> {
  const resId = paymentIntent.metadata?.res_id;
  if (!resId) return;

  const resDoc = await db.collection("reservations").doc(resId).get();
  if (!resDoc.exists) return;

  const resData = resDoc.data()!;

  if (paymentIntent.amount_received > 0 && paymentIntent.capture_method === "manual") {
    console.log(`Payment captured for reservation ${resId}: ¥${paymentIntent.amount_received}`);

    // FIX (found alongside the cancellation-metadata fix above, same
    // review): the notification text used to always say "決済が完了しま
    // した" (payment completed) regardless of `metadata.type` — genuinely
    // misleading for a `type: "cancellation"` capture, which is a
    // cancellation FEE charge, not a normal service payment.
    const isCancellationCapture = paymentIntent.metadata?.type === "cancellation";
    const paymentSucceededTitle = isCancellationCapture ? "キャンセル料が確定しました" : "決済が完了しました";
    const paymentSucceededBody = isCancellationCapture
      ? `キャンセル料 ¥${paymentIntent.amount_received.toLocaleString()} が確定しました。`
      : `¥${paymentIntent.amount_received.toLocaleString()} の決済が確定しました。`;
    await db
      .collection("users")
      .doc(resData.guest_id)
      .collection("notifications")
      .add({
        type: "stripe",
        title: paymentSucceededTitle,
        body: paymentSucceededBody,
        data: { res_id: resId, amount: paymentIntent.amount_received },
        read: false,
        created_at: Timestamp.now(),
      });
    // FIX (comprehensive project-wide review, 2026-08-17): every
    // notification write in this file used to be in-app only — every
    // OTHER money-adjacent notification path in this codebase
    // (reservations.ts/work-posts.ts/admin.ts) also pushes to the
    // device via `sendPushNotification`, this file never did. Real gap:
    // these are exactly the events a guest/cast most needs to see in
    // real time. `sendPushNotification` itself already enforces the
    // `notify_*` category preference (PROJECT_KNOWLEDGE.md §126) keyed
    // off `data.type` — passing the SAME `type: "stripe"` this
    // notification doc already carries.
    await sendPushNotification(resData.guest_id, paymentSucceededTitle, paymentSucceededBody, {
      res_id: resId,
      type: "stripe",
    });

    // FIX (IMPLEMENTATION_PLAN.md §6 defect #7): the reservation-status
    // transition, pair_history (30-min-rule) update, and cast-reward
    // bookkeeping now happen HERE — driven by Stripe's own confirmation
    // that the capture succeeded — instead of optimistically inside the
    // `capturePayment` callable right after calling `.capture()`. Gated on
    // `metadata.type` being absent because extension (`type: "extension"`)
    // and tip (`type: "tip"`) PaymentIntents share this same webhook
    // endpoint and the same `res_id` metadata key, but must NOT re-trigger
    // the parent reservation's own capture side effects — only the main
    // reservation PaymentIntent (created with no `type` metadata) should.
    if (!paymentIntent.metadata?.type) {
      await db.collection("reservations").doc(resId).update({
        status: "review_pending",
        last_capture_at: Timestamp.now(),
        updated_at: Timestamp.now(),
      });

      if (resData.cast_ids) {
        for (const castId of resData.cast_ids) {
          const pairKey = `${resData.guest_id}_${castId}`;
          await db.collection("pair_history").doc(pairKey).set(
            {
              pair_key: pairKey,
              guest_id: resData.guest_id,
              cast_id: castId,
              last_capture_at: Timestamp.now(),
              interaction_count: FieldValue.increment(1),
            },
            { merge: true }
          );
        }
      }

      await recordCastRewardsAndProcessOthers(resId, resData);
    }
  }
}

async function handlePaymentIntentFailed(paymentIntent: any): Promise<void> {
  const resId = paymentIntent.metadata?.res_id;
  if (!resId) return;

  const resDoc = await db.collection("reservations").doc(resId).get();
  if (!resDoc.exists) return;

  const resData = resDoc.data()!;

  // FIX: same bug class as handleAmountCapturableUpdated below - extension
  // (`type: "extension"`) and tip (`type: "tip"`) PaymentIntents share this
  // reservation's `res_id` metadata, but a FAILED extension/tip charge must
  // not cancel the whole reservation the guest already has going. Only the
  // main reservation PaymentIntent (no `type` metadata) is allowed to flip
  // the parent reservation to `cancelled` here.
  if (!paymentIntent.metadata?.type) {
    await db.collection("reservations").doc(resId).update({
      status: "cancelled",
      cancel_reason: "決済に失敗しました",
      updated_at: Timestamp.now(),
    });

    // Slot-lock release (PROJECT_KNOWLEDGE.md §68). Stays non-transactional
    // and best-effort here specifically (unlike the other cancel/expire
    // paths, which fold this into their own status-change transaction) —
    // `payment_intent.payment_failed` fires pre-authorization in the
    // overwhelming common case, so there is normally nothing to release;
    // `autoReleaseOrphanedSlots` (schedule.ts) is the backstop for the rare
    // case a lock somehow existed anyway.
    try {
      await releaseReservationSlots(resId);
    } catch (err) {
      console.error(`Failed to release schedule_slots for ${resId} after payment failure:`, err);
    }
  }

  await db
    .collection("users")
    .doc(resData.guest_id)
    .collection("notifications")
    .add({
      type: "stripe",
      title: "決済に失敗しました",
      body: "お支払いに問題が発生しました。支払い方法をご確認ください。",
      data: { res_id: resId },
      read: false,
      created_at: Timestamp.now(),
    });
  // FIX (comprehensive project-wide review, 2026-08-17): see the identical
  // fix note on `handlePaymentIntentSucceeded` above — a declined card is
  // exactly the kind of event a guest needs to see immediately, not just
  // the next time they happen to open the app.
  await sendPushNotification(resData.guest_id, "決済に失敗しました", "お支払いに問題が発生しました。支払い方法をご確認ください。", {
    res_id: resId,
    type: "stripe",
  });
}

async function handlePaymentIntentCanceled(paymentIntent: any): Promise<void> {
  const resId = paymentIntent.metadata?.res_id;
  if (!resId) return;
  console.log(`Payment canceled for reservation ${resId}`);
}

/**
 * Authorize-time slot locking (PROJECT_KNOWLEDGE.md §68). This is the ONE
 * point in the whole backend with server-confirmed, Stripe-verified proof
 * that funds are actually held — so it's the only correct place to
 * transactionally claim the booked `schedule_slots` window, racing safely
 * against any other reservation trying to authorize the same slot.
 */
async function handleAmountCapturableUpdated(paymentIntent: any): Promise<void> {
  const resId = paymentIntent.metadata?.res_id;
  if (!resId) return;

  // FIX (confirmed live bug): extension (`type: "extension"`) and tip
  // (`type: "tip"`) PaymentIntents share the parent reservation's `res_id`
  // metadata. Without this guard, authorizing an extension mid-session
  // (reservation already `in_progress`/`completion_pending`/etc.) would
  // silently stamp the PARENT reservation back to `status: "authorized"` -
  // which would then make `reportCompletion` reject the cast's completion
  // report (`status !== "in_progress"`) and make the reservation eligible
  // for `autoCancelExpiredAuth`'s 24h-stale sweep again, risking an
  // auto-cancel of an active, already-in-progress paid booking. Mirrors the
  // same guard `handlePaymentIntentSucceeded`/`handlePaymentIntentFailed`
  // already use.
  //
  // FIX (PROJECT_KNOWLEDGE.md §71/§72 — closes the extension schedule_slots
  // locking gap, the one item the project's own last comprehensive review
  // named as still open): extensions now get their OWN slot-locking path,
  // `handleExtensionAmountCapturableUpdated` below, scoped to just the
  // extension's own window and reservation-preserving on conflict (unlike
  // the base flow, a conflicting extension must never cancel an already
  // in-progress reservation — only the extension itself is rolled back).
  // `type: "tip"` (and any other future type) still has no slot-locking
  // concept and correctly falls through to the plain `return` below.
  if (paymentIntent.metadata?.type === "extension") {
    await handleExtensionAmountCapturableUpdated(paymentIntent);
    return;
  }
  if (paymentIntent.metadata?.type) return;

  if (paymentIntent.amount_capturable <= 0) return;

  console.log(`Authorization succeeded for ${resId}: ¥${paymentIntent.amount_capturable} — attempting slot lock.`);

  // Everything — the request_pending guard, the slot reads, the conflict
  // decision, and both possible outcomes' writes — runs inside ONE
  // transaction. The guard is re-checked HERE, not from a pre-read outside
  // the transaction: cancelPayment/adminForceCancel/autoCancelExpiredAuth
  // can all move a request_pending reservation to cancelled/expired at any
  // time, and reading status outside the transaction would leave a real
  // TOCTOU window where this handler could resurrect an already-cancelled
  // reservation by locking slots and stamping "authorized" back onto it.
  const outcome = await db.runTransaction(async (tx) => {
    const resRef = db.collection("reservations").doc(resId);
    const resSnap = await tx.get(resRef);
    if (!resSnap.exists) {
      return { result: "not_found" as const };
    }
    const resData = resSnap.data()!;
    if (resData.status !== "request_pending") {
      // Covers webhook redelivery (already handled by the outer
      // processed_events idempotency guard, but cheap defense-in-depth)
      // and the cancelled-in-flight race this guard exists to close.
      return { result: "skip" as const };
    }

    const castIds: string[] = resData.cast_ids || [];
    const startAt: Date = resData.date.toDate();
    const durationMinutes: number = resData.duration_minutes || 60;
    const slots = buildReservationSlotRefs(castIds, startAt, durationMinutes);

    // Reads before writes — a hard Firestore transaction requirement.
    const slotSnaps = await tx.getAll(...slots.map((s) => s.ref));

    const hasConflict = slotSnaps.some((snap) => {
      const status = snap.exists ? snap.data()?.status || "available" : "available";
      return status !== "available";
    });

    if (hasConflict) {
      tx.update(resRef, {
        status: "cancelled",
        cancel_reason: "選択した時間帯が他の予約により埋まりました。",
        cancelled_by: "system",
        updated_at: Timestamp.now(),
      });
      return { result: "conflict" as const, guestId: resData.guest_id as string };
    }

    slots.forEach((slot) => {
      tx.set(slot.ref, { ...slot.baseFields, status: "reserved", res_id: resId }, { merge: true });
    });
    tx.update(resRef, { status: "authorized", updated_at: Timestamp.now() });
    return { result: "locked" as const };
  });

  if (outcome.result === "not_found") {
    // Genuinely anomalous — a real reservation should always exist for a
    // res_id present in Stripe metadata (nothing in this codebase ever
    // deletes a reservation doc). Worth surfacing, not silently swallowing.
    console.error(`handleAmountCapturableUpdated: reservation ${resId} not found — no slot lock attempted.`);
    return;
  }
  if (outcome.result === "skip") {
    console.log(`handleAmountCapturableUpdated: reservation ${resId} was not request_pending — skipped (redelivery or already resolved).`);
    return;
  }
  if (outcome.result === "locked") {
    console.log(`Slot lock succeeded for reservation ${resId} — status now "authorized".`);
    return;
  }

  console.log(`Reservation ${resId} lost the slot-lock race — releasing the authorization hold.`);
  try {
    await stripe.paymentIntents.cancel(paymentIntent.id);
  } catch (err) {
    // Unlike this file's other best-effort paymentIntents.cancel() calls —
    // where a stale hold there just self-expires in ~7 days — a failure
    // HERE is worse: the reservation is already marked cancelled and the
    // guest already told to pick another time, but their card may still be
    // holding a real authorization for up to ~7 days. Surface this to
    // admins rather than log-and-forget, mirroring handleTransferFailed's
    // own admin-alert pattern below.
    console.error(`Failed to cancel PaymentIntent ${paymentIntent.id} after slot conflict on ${resId}:`, err);
    const admins = await db.collection("users").where("role", "==", "admin").get();
    const batch = db.batch();
    admins.forEach((adminDoc) => {
      const notifRef = db.collection("users").doc(adminDoc.id).collection("notifications").doc();
      batch.set(notifRef, {
        type: "admin",
        title: "決済保留の解放に失敗しました",
        body: `予約 ${resId} は満室のためキャンセルされましたが、PaymentIntent ${paymentIntent.id} の解放に失敗しました。手動確認が必要です。`,
        data: { res_id: resId, payment_intent_id: paymentIntent.id },
        read: false,
        created_at: Timestamp.now(),
      });
    });
    await batch.commit();
    // FIX (comprehensive project-wide review, 2026-08-17): same push gap
    // as every other notification write in this file — a stuck
    // PaymentIntent needing manual admin intervention is exactly the
    // kind of alert that should push, not wait for an admin to happen to
    // check their notification list.
    await Promise.all(
      admins.docs.map((adminDoc) =>
        sendPushNotification(
          adminDoc.id,
          "決済保留の解放に失敗しました",
          `予約 ${resId} は満室のためキャンセルされましたが、PaymentIntent ${paymentIntent.id} の解放に失敗しました。手動確認が必要です。`,
          { res_id: resId, payment_intent_id: paymentIntent.id, type: "admin" }
        )
      )
    );
  }

  await db
    .collection("users")
    .doc(outcome.guestId)
    .collection("notifications")
    .add({
      type: "matching",
      title: "ご予約を確定できませんでした",
      body: "選択した時間帯は他のご予約で埋まってしまいました。お手数ですが別の日時をお選びください。",
      data: { res_id: resId },
      read: false,
      created_at: Timestamp.now(),
    });
  // FIX (comprehensive project-wide review, 2026-08-17): same push gap as
  // the payment-succeeded/failed fixes above — a guest whose booking just
  // got bumped by a slot conflict needs to know immediately.
  await sendPushNotification(
    outcome.guestId,
    "ご予約を確定できませんでした",
    "選択した時間帯は他のご予約で埋まってしまいました。お手数ですが別の日時をお選びください。",
    { res_id: resId, type: "matching" }
  );
}

/**
 * Extension-window slot locking (PROJECT_KNOWLEDGE.md §71/§72). The sibling
 * to `handleAmountCapturableUpdated` above, applied to just the newly
 * extended time range instead of the whole booking — split into its own
 * function rather than folded into the base flow because a conflict here
 * must NOT cancel the parent reservation (which is, by construction, always
 * already `in_progress` — an active, already-paid booking) the way a
 * conflict on the base window correctly cancels a still-`request_pending`
 * one. Only this specific extension is rolled back on conflict: its
 * capacity claim (`extension_count`/`duration_minutes`, claimed optimistically
 * in `createExtensionPayment`) is reverted, its own PaymentIntent hold is
 * released, and the reservation itself is left completely untouched.
 *
 * Reads `slot_start`/`duration_minutes` back from the extension doc
 * (`reservations/{res_id}/extensions/{extension_id}`, found via
 * `metadata.extension_id` — allocated before the Stripe call specifically so
 * it could ride along in the PaymentIntent's metadata for this lookup)
 * rather than recomputing the window from the reservation's CURRENT
 * `duration_minutes`, which by the time this webhook fires may already
 * reflect additional, later extensions stacked on top.
 */
async function handleExtensionAmountCapturableUpdated(paymentIntent: any): Promise<void> {
  const resId = paymentIntent.metadata?.res_id;
  const extId = paymentIntent.metadata?.extension_id;
  if (!resId || !extId) {
    console.error(
      `Extension amount_capturable_updated missing res_id/extension_id in metadata (PaymentIntent ${paymentIntent.id}) — no slot lock attempted.`
    );
    return;
  }
  if (paymentIntent.amount_capturable <= 0) return;

  const resRef = db.collection("reservations").doc(resId);
  const extRef = resRef.collection("extensions").doc(extId);

  const outcome = await db.runTransaction(async (tx) => {
    const [resSnap, extSnap] = await Promise.all([tx.get(resRef), tx.get(extRef)]);
    if (!resSnap.exists || !extSnap.exists) {
      return { result: "not_found" as const };
    }
    const extData = extSnap.data()!;
    if (extData.status !== "authorized") {
      // Already resolved by the time this webhook landed — either
      // `cancelExtensionPayment` already flipped it to "cancelled" (guest's
      // Payment Sheet failed/was dismissed client-side), or
      // `captureAuthorizedExtensions` already captured it. Covers webhook
      // redelivery too (defense-in-depth on top of the outer
      // processed_events idempotency guard).
      return { result: "skip" as const };
    }
    if (!extData.slot_start) {
      // Defensive only: every extension created after this fix ships always
      // sets `slot_start` in the same write that sets `status: "authorized"`
      // — this branch exists purely so a malformed/pre-fix doc can't crash
      // this handler.
      console.error(`Extension ${extId} on ${resId} has status "authorized" but no slot_start — skipping lock.`);
      return { result: "skip" as const };
    }

    const resData = resSnap.data()!;
    const castIds: string[] = resData.cast_ids || [];
    const windowStart: Date = extData.slot_start.toDate();
    const durationMinutes: number = extData.duration_minutes || 0;
    const slots = buildReservationSlotRefs(castIds, windowStart, durationMinutes);

    // Reads before writes — a hard Firestore transaction requirement.
    const slotSnaps = await tx.getAll(...slots.map((s) => s.ref));

    const hasConflict = slotSnaps.some((snap) => {
      const status = snap.exists ? snap.data()?.status || "available" : "available";
      return status !== "available";
    });

    if (hasConflict) {
      const currentDuration = resData.duration_minutes || 0;
      const currentCount = resData.extension_count || 0;
      tx.update(resRef, {
        duration_minutes: Math.max(0, currentDuration - durationMinutes),
        extension_count: Math.max(0, currentCount - 1),
        updated_at: Timestamp.now(),
      });
      tx.update(extRef, { status: "cancelled", updated_at: Timestamp.now() });
      return { result: "conflict" as const, guestId: resData.guest_id as string };
    }

    slots.forEach((slot) => {
      tx.set(slot.ref, { ...slot.baseFields, status: "reserved", res_id: resId, ext_id: extId }, { merge: true });
    });
    return { result: "locked" as const };
  });

  if (outcome.result === "not_found" || outcome.result === "skip") {
    return;
  }
  if (outcome.result === "locked") {
    console.log(`Extension slot lock succeeded for extension ${extId} on reservation ${resId}.`);
    return;
  }

  console.log(`Extension ${extId} on reservation ${resId} lost the slot-lock race — releasing its authorization hold.`);
  try {
    await stripe.paymentIntents.cancel(paymentIntent.id);
  } catch (err) {
    // Same reasoning as handleAmountCapturableUpdated's own equivalent
    // catch above: a failure here leaves the extension marked cancelled
    // while the guest's card may still hold a real authorization for up to
    // ~7 days. Surface to admins rather than log-and-forget.
    console.error(`Failed to cancel extension PaymentIntent ${paymentIntent.id} after slot conflict on ${resId}:`, err);
    const admins = await db.collection("users").where("role", "==", "admin").get();
    const batch = db.batch();
    admins.forEach((adminDoc) => {
      const notifRef = db.collection("users").doc(adminDoc.id).collection("notifications").doc();
      batch.set(notifRef, {
        type: "admin",
        title: "延長決済保留の解放に失敗しました",
        body: `予約 ${resId} の延長 ${extId} は時間帯の競合によりキャンセルされましたが、PaymentIntent ${paymentIntent.id} の解放に失敗しました。手動確認が必要です。`,
        data: { res_id: resId, extension_id: extId, payment_intent_id: paymentIntent.id },
        read: false,
        created_at: Timestamp.now(),
      });
    });
    await batch.commit();
    // FIX (comprehensive project-wide review, 2026-08-17): same push gap
    // as the base-flow equivalent above.
    await Promise.all(
      admins.docs.map((adminDoc) =>
        sendPushNotification(
          adminDoc.id,
          "延長決済保留の解放に失敗しました",
          `予約 ${resId} の延長 ${extId} は時間帯の競合によりキャンセルされましたが、PaymentIntent ${paymentIntent.id} の解放に失敗しました。手動確認が必要です。`,
          { res_id: resId, extension_id: extId, payment_intent_id: paymentIntent.id, type: "admin" }
        )
      )
    );
  }

  await db
    .collection("users")
    .doc(outcome.guestId)
    .collection("notifications")
    .add({
      type: "matching",
      title: "延長をご利用いただけませんでした",
      body: "選択した延長時間は他のご予約で埋まってしまったため、延長を確定できませんでした。決済は行われません。",
      data: { res_id: resId, extension_id: extId },
      read: false,
      created_at: Timestamp.now(),
    });
  // FIX (comprehensive project-wide review, 2026-08-17): same push gap as
  // the base-flow slot-conflict fix above.
  await sendPushNotification(
    outcome.guestId,
    "延長をご利用いただけませんでした",
    "選択した延長時間は他のご予約で埋まってしまったため、延長を確定できませんでした。決済は行われません。",
    { res_id: resId, extension_id: extId, type: "matching" }
  );
}

async function handleTransferCreated(transfer: any): Promise<void> {
  const castUid = transfer.metadata?.cast_uid || transfer.metadata?.staff_uid;
  const resId = transfer.metadata?.res_id;
  const ledgerId = transfer.metadata?.ledger_id;

  if (ledgerId) {
    await db.collection("ledger").doc(ledgerId).update({
      stripe_object_id: transfer.id,
      stripe_event_id: transfer.id,
      status: "confirmed",
      processed: true,
    });
  }

  console.log(`Transfer created: ${transfer.id} for ${castUid}, res ${resId}`);
}

async function handleTransferFailed(transfer: any): Promise<void> {
  const ledgerId = transfer.metadata?.ledger_id;
  const castUid = transfer.metadata?.cast_uid;

  if (ledgerId) {
    await db.collection("ledger").doc(ledgerId).update({
      status: "failed",
    });
  }

  console.error(`Transfer FAILED: ${transfer.id} for cast ${castUid}`);

  const admins = await db.collection("users").where("role", "==", "admin").get();
  const batch = db.batch();
  admins.forEach((adminDoc) => {
    const notifRef = db.collection("users").doc(adminDoc.id).collection("notifications").doc();
    batch.set(notifRef, {
      type: "admin",
      title: "送金失敗アラート",
      body: `Transfer ${transfer.id} が失敗しました。手動確認が必要です。`,
      data: { transfer_id: transfer.id, cast_uid: castUid },
      read: false,
      created_at: Timestamp.now(),
    });
  });
  await batch.commit();
  // FIX (comprehensive project-wide review, 2026-08-17): same push gap as
  // every other admin-alert batch in this file.
  await Promise.all(
    admins.docs.map((adminDoc) =>
      sendPushNotification(adminDoc.id, "送金失敗アラート", `Transfer ${transfer.id} が失敗しました。手動確認が必要です。`, {
        transfer_id: transfer.id,
        cast_uid: castUid || "",
        type: "admin",
      })
    )
  );
}

async function handleIdentityVerified(session: any): Promise<void> {
  const uid = session.metadata?.firebase_uid;
  if (!uid) return;

  await db.collection("users").doc(uid).update({
    is_verified: true,
    kyc_status: "approved",
    updated_at: Timestamp.now(),
  });

  await db.collection("users").doc(uid).collection("notifications").add({
    type: "stripe",
    title: "本人確認が完了しました",
    body: "本人確認が承認されました。すべての機能をご利用いただけます。",
    data: {},
    read: false,
    created_at: Timestamp.now(),
  });
  // FIX (comprehensive project-wide review, 2026-08-17): same push gap
  // as every other notification write in this file.
  await sendPushNotification(uid, "本人確認が完了しました", "本人確認が承認されました。すべての機能をご利用いただけます。", {
    type: "stripe",
  });
}

async function handleIdentityRequiresInput(session: any): Promise<void> {
  const uid = session.metadata?.firebase_uid;
  if (!uid) return;

  await db.collection("users").doc(uid).update({
    kyc_status: "rejected",
    updated_at: Timestamp.now(),
  });

  await db.collection("users").doc(uid).collection("notifications").add({
    type: "stripe",
    title: "本人確認に追加情報が必要です",
    body: "本人確認書類に不備があります。再度ご提出ください。",
    data: {},
    read: false,
    created_at: Timestamp.now(),
  });
  await sendPushNotification(uid, "本人確認に追加情報が必要です", "本人確認書類に不備があります。再度ご提出ください。", {
    type: "stripe",
  });
}

async function handleAccountUpdated(account: any): Promise<void> {
  const uid = account.metadata?.firebase_uid;
  if (!uid) return;

  const isRestricted = account.requirements?.disabled_reason != null;

  // FIX (was a real gap): this handler previously only ever sent a
  // notification when restricted, with no field written back to `users` at
  // all — meaning nothing was queryable, so the Home-ranking query (App
  // Spec: an unverified/Restricted cast must be excluded from search
  // results in real time) had no field to filter on. `is_stripe_restricted`
  // is that field now, kept in sync on every account.updated delivery
  // (including the transition back to false once requirements clear).
  //
  // Also mirrors charges_enabled/payouts_enabled/requirements_due — the
  // same fields `submitConnectOnboarding` (auth.ts, §6 defect #5) writes
  // right after a submission, kept current here too since Stripe's own
  // review of submitted data (and any newly-due requirement) happens
  // asynchronously, not only in direct response to our own API calls.
  await db.collection("users").doc(uid).update({
    is_stripe_restricted: isRestricted,
    stripe_charges_enabled: account.charges_enabled ?? false,
    stripe_payouts_enabled: account.payouts_enabled ?? false,
    stripe_requirements_due: account.requirements?.currently_due || [],
    updated_at: Timestamp.now(),
  });

  if (isRestricted) {
    await db.collection("users").doc(uid).collection("notifications").add({
      type: "stripe",
      title: "Stripeアカウントに要対応事項があります",
      body: "本人確認またはアカウント情報の更新が必要です。",
      data: { disabled_reason: account.requirements?.disabled_reason },
      read: false,
      created_at: Timestamp.now(),
    });
    // FIX (comprehensive project-wide review, 2026-08-17): same push gap
    // as every other notification write in this file — a restricted
    // Stripe account blocks future bookings, this is worth an immediate
    // push, not just an in-app entry the cast might not see for days.
    await sendPushNotification(uid, "Stripeアカウントに要対応事項があります", "本人確認またはアカウント情報の更新が必要です。", {
      type: "stripe",
    });
  }
}

/**
 * FIX (confirmed live bug, found during final precision audit): both of
 * these handlers used to be pure log-only no-ops. `adminApprovePayout`
 * (admin.ts) flips `payout_requests.status` to "approved" the instant it
 * calls `stripe.payouts.create()` — before Stripe has actually moved any
 * money — and nothing anywhere ever revisited that status afterward. A
 * payout that later bounced (closed bank account, Stripe Connect
 * restriction newly applied, etc.) left the admin's withdrawal queue
 * permanently showing "approved" with no visibility that the cast never
 * actually got paid. Now finds the originating `payout_requests` doc via
 * `stripe_payout_id` (persisted at creation time, admin.ts's own fix) and
 * reacts to the real outcome. `payout.paid` intentionally does NOT flip
 * status away from "approved" — that's still the correct terminal label
 * for "admin approved, money sent"; it just stamps a completion timestamp
 * so the real Stripe-confirmed landing time is visible in the raw doc,
 * without requiring any DSL/badge-vocabulary change on the admin panel
 * side. `payout.failed` moves status to "on_hold" (an existing, already
 * DSL-badged status meaning "needs admin attention") rather than inventing
 * a new status value that would need a frontend change too — this is
 * exactly the situation "needs admin attention" already means.
 */
async function handlePayoutPaid(payout: any): Promise<void> {
  console.log(`Payout paid: ${payout.id}, amount: ${payout.amount}`);
  const matches = await db
    .collection("payout_requests")
    .where("stripe_payout_id", "==", payout.id)
    .limit(1)
    .get();
  if (matches.empty) {
    console.log(`No payout_requests doc found for stripe_payout_id ${payout.id} (payout.paid) — nothing to update.`);
    return;
  }
  await matches.docs[0].ref.update({
    payout_completed_at: Timestamp.now(),
    updated_at: Timestamp.now(),
  });
}

async function handlePayoutFailed(payout: any): Promise<void> {
  console.error(`Payout FAILED: ${payout.id}, reason: ${payout.failure_message || payout.failure_code || "unknown"}`);
  const matches = await db
    .collection("payout_requests")
    .where("stripe_payout_id", "==", payout.id)
    .limit(1)
    .get();
  if (matches.empty) {
    console.error(`No payout_requests doc found for stripe_payout_id ${payout.id} (payout.failed) — cannot flag for admin review.`);
    return;
  }
  const reqDoc = matches.docs[0];
  const reqData = reqDoc.data();
  await reqDoc.ref.update({
    status: "on_hold",
    payout_failure_reason: payout.failure_message || payout.failure_code || "Stripe側で出金が失敗しました。",
    updated_at: Timestamp.now(),
  });

  if (reqData.user_id) {
    await db.collection("users").doc(reqData.user_id).collection("notifications").add({
      type: "stripe",
      title: "出金処理に失敗しました",
      body: "出金処理中に問題が発生しました。サポートまでお問い合わせください。",
      data: { stripe_payout_id: payout.id },
      read: false,
      created_at: Timestamp.now(),
    });
    // FIX (comprehensive project-wide review, 2026-08-17): same push gap
    // as every other notification write in this file — a failed payout
    // is exactly the kind of event a cast needs to see immediately.
    await sendPushNotification(reqData.user_id, "出金処理に失敗しました", "出金処理中に問題が発生しました。サポートまでお問い合わせください。", {
      stripe_payout_id: payout.id,
      type: "stripe",
    });
  }

  const admins = await db.collection("users").where("role", "==", "admin").get();
  const batch = db.batch();
  admins.forEach((adminDoc) => {
    const ref = db.collection("users").doc(adminDoc.id).collection("notifications").doc();
    batch.set(ref, {
      type: "stripe",
      title: "【要対応】出金失敗",
      body: `出金 (payout_requests/${reqDoc.id}) がStripe側で失敗しました。確認してください。`,
      data: { stripe_payout_id: payout.id, payout_request_id: reqDoc.id },
      read: false,
      created_at: Timestamp.now(),
    });
  });
  await batch.commit();
  await Promise.all(
    admins.docs.map((adminDoc) =>
      sendPushNotification(
        adminDoc.id,
        "【要対応】出金失敗",
        `出金 (payout_requests/${reqDoc.id}) がStripe側で失敗しました。確認してください。`,
        { stripe_payout_id: payout.id, payout_request_id: reqDoc.id, type: "stripe" }
      )
    )
  );
}

