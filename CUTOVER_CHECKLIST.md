# Production Cutover Checklist

Status as of 2026-08-13, tracking `IMPLEMENTATION_PLAN.md` §11 ("Production cutover checklist, Phase 15"). Each item below is marked with what's actually been done from this workspace versus what genuinely requires access this environment does not have (live Stripe credentials, the client's own domain registrar/Play Store/App Store accounts, a live device).

## 1. Stripe: swap test keys for live keys; migrate to Secret Manager

**`[BLOCKED — needs client-provided live Stripe credentials]`**

Cannot be done from this workspace: live Stripe API keys are the client's own credential, not something this session has or should fabricate. What's ready for when they're available:

- The migration PATH is already fully documented in `IMPLEMENTATION_PLAN.md` §11 item 1 (both the `defineSecret`/`.runWith({secrets:...})` v1 shape and the `onCall({secrets:...})` v2 shape this mixed-generation backend needs — confirmed against the installed SDK's own type definitions, not assumed).
- Confirmed still true today: `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` live in `firebase/functions/.env.icoccha-new-mockup-9a6ing` (plain environment variables), not Secret Manager. Low risk today (test-mode keys only) — becomes a real production concern the moment live keys land here. **Do the Secret Manager migration as part of the live-key swap, not after.**
- Webhook endpoint re-registration (pointing Stripe's webhook config at the production URL, re-enabling every event type `stripeWebhook` handles) still needs to happen at cutover time — not something to pre-stage without a live endpoint to point at.

## 2. FlutterFlow: swap Stripe publishable key to live

**`[BLOCKED — needs client-provided live Stripe credentials]`** Same dependency as item 1. Confirm at the same time that no live key gets hardcoded into DSL source (this project's own established rule — see `secretRef(...)` usage throughout `dsl/edit.dart`'s Stripe integration).

## 3. Firebase: final `firestore.rules`/`storage.rules` read-through

**`[DONE, 2026-08-13]`** — full re-read of both files, specifically hunting for debug-era open rules (the literal ask). Method: grepped every `allow ... if true` and every `allow (write|create|update|delete) ... if true` across both files, then read the surrounding comment/context for each hit to confirm it's an intentional public-read collection versus a leftover.

**Findings:**
- `firestore.rules`: 6 total `allow read: if true` rules — `cocoten_shops`, `banners`, `reviews`, `prefectures` (×2 similar), all guest-facing browsable content with writes correctly gated to `isAdmin()` or Cloud-Functions-only. All intentional, all already documented inline. No catch-all `match /{document=**}` exists at the bottom of the file — anything not explicitly listed defaults to Firestore's own implicit deny-all, confirmed by reading to the literal end of the file.
- **RESOLVED 2026-08-14 (PROJECT_KNOWLEDGE.md §81):** `firestore.rules` `invitions/{document}`'s open `allow create/read: if true` (flagged below as an action item when this checklist was first written) has been tightened to deny-all — a second, independent audit re-confirmed zero backend/client references anywhere, closing the "confirm it's dead" question this item was waiting on. No further action needed here before launch.
- **RESOLVED 2026-08-14 (PROJECT_KNOWLEDGE.md §81):** `storage.rules` `banners/**` write was gated only on `request.auth != null` (any signed-in user, not just admins) — a real, live vulnerability, not just disclosed debt as originally framed. Fixed to require real admin status via a cross-service `firestore.get(...)` check on `users/{uid}.role`, mirroring `firestore.rules`' own `isAdmin()`. `users/{userId}/**` (strict owner-only) remains unchanged and correct.

## 4. Configure the custom domain for Firebase Hosting

**`[BLOCKED — needs the client's own domain registrar access]`** Per the 2026-02-22 chat exchange referenced in `IMPLEMENTATION_PLAN.md` §12, the domain is already registered by the client — this workspace has no access to that registrar or to Firebase Hosting's domain-configuration UI. Nothing to do from here until that access is available at cutover time.

## 5. Re-run the full §9 scenario list against live-mode Stripe with real small transactions

**`[NOT STARTED — genuinely requires live-mode credentials + a live device, both unavailable here]`** `TEST_COMPLETION_REPORT.md` (produced this session) covers everything achievable without live execution — a full code-level trace of all 22 scenarios, finding and fixing 2 real bugs along the way. That report explicitly states its own limitation: it is necessary evidence toward passing this step, not a substitute for it. This step cannot be pulled forward — it requires real Stripe Connect/live-mode account behavior (which differs from test-mode, especially around `Restricted` account status) and real money movement, neither available in this environment.

## 6. Re-run App Store/Play Store compliance pass

**`[NOT STARTED — needs a live submission/review context]`** Per `IMPLEMENTATION_PLAN.md` §3.10.3, this should happen immediately before submission since guideline text changes over time — deliberately not pulled forward, since doing it now would just mean redoing it again closer to the actual submission date.

---

## Summary for the client

Of the 6 cutover steps: **1 is fully done, with no outstanding action items** (the rules read-through — both findings it originally surfaced, `invitions` and the `banners/**` Storage write, are now fixed as of 2026-08-14), and **5 are blocked on inputs only the client can provide** (live Stripe credentials, domain/store access, live execution). Nothing in this checklist was skipped or silently deferred — each blocked item states exactly what's needed to unblock it. This workspace has taken every step that's actually reachable without those inputs; the remaining work is a coordination/access problem, not an engineering one.
