import * as admin from "firebase-admin";
import Stripe from "stripe";

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export const storage = admin.storage();
export const messaging = admin.messaging();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

// Stripe initialization using environment variables
// Create functions/.env with STRIPE_SECRET_KEY=sk_test_xxx
// Or set with: firebase functions:secrets:set STRIPE_SECRET_KEY
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";

// Exported (not just inlined below) so any caller that needs to mint its own
// Stripe API object pinned to the SAME version this client uses — e.g.
// `stripe.ephemeralKeys.create(...)` in stripe-payments.ts, which Stripe's
// API requires be told an explicit version — reads it from one place rather
// than duplicating the literal and risking silent drift if this ever
// changes.
export const STRIPE_API_VERSION = "2023-10-16";

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: STRIPE_API_VERSION,
});

// Webhook secret
export const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

// CORS configuration
export const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// System defaults.
//
// FIX (was a real bug): these keys previously used UPPER_SNAKE_CASE
// (e.g. TRANSPORT_FEE_THRESHOLD_SEC) while the real `system_config/settings`
// Firestore document uses lower_snake_case (transport_fee_threshold_sec).
// getSystemConfig()'s `{ ...SYSTEM_DEFAULTS, ...doc.data() }` spread never
// collided on those mismatched keys, so every caller silently got the
// hardcoded default forever, regardless of what an admin actually configured.
// Keys below now match Firestore's real field names exactly (confirmed
// against firestore/schema.md) so the spread actually overrides correctly.
export const SYSTEM_DEFAULTS = {
  chat_close_sec: 86400,
  transport_fee_threshold_sec: 1800,
  transport_fee_amount: 5000,
  extension_limit_count: 3,
  max_total_hours: 6,
  tax_rate: 0.10,
  default_cast_rate: 0.5,
  // Split per schema.md — a single flat STAFF_FEE conflated two distinct
  // staff roles (users.staff_type already distinguishes security/transport).
  security_staff_fee: 2500,
  transport_staff_fee: 2500,
  default_affiliate_rate: 0.05,
  affiliate_min_days: 3,
  affiliate_payment_day: 5,
  // Launch set per IMPLEMENTATION_PLAN.md §3.2.2/§8 Phase 3 — the 10
  // prefectures confirmed for initial launch. `name`/`prefecture` are the
  // same string (no separate display-vs-key distinction established
  // anywhere in the backend; adminGetSystemConfig's own areaActive() only
  // ever matches on `prefecture`). Admin-editable via the already-existing
  // `adminUpdateSystemConfig` callable (accepts any `settings` object,
  // merges into this same document) — no new admin write path needed.
  // `lat`/`lng` (unimplemented-features pass, IMPLEMENTATION_PLAN.md §3.8
  // item 5): each prefecture's representative (prefectural-office)
  // coordinate — copied verbatim from the ALREADY-LIVE, already-proven
  // static `prefectureCenters` table in dsl/edit.dart's own
  // `fetchDiscoveryCasts` (a manually-verified-good source, not a fresh
  // guess), since that table is what this data is replacing. `municipalities`
  // starts empty for every entry; admin-populated via
  // `adminAddServiceAreaMunicipality`/`ServiceAreaMunicipalitiesPage`.
  service_areas: [
    { name: "東京都", prefecture: "東京都", active: true, lat: 35.6895, lng: 139.6917, municipalities: [] },
    { name: "神奈川県", prefecture: "神奈川県", active: true, lat: 35.4478, lng: 139.6425, municipalities: [] },
    { name: "千葉県", prefecture: "千葉県", active: true, lat: 35.6047, lng: 140.1233, municipalities: [] },
    { name: "愛知県", prefecture: "愛知県", active: true, lat: 35.1802, lng: 136.9066, municipalities: [] },
    { name: "京都府", prefecture: "京都府", active: true, lat: 35.0116, lng: 135.7681, municipalities: [] },
    { name: "大阪府", prefecture: "大阪府", active: true, lat: 34.6937, lng: 135.5023, municipalities: [] },
    { name: "兵庫県", prefecture: "兵庫県", active: true, lat: 34.6913, lng: 135.1830, municipalities: [] },
    { name: "岡山県", prefecture: "岡山県", active: true, lat: 34.6551, lng: 133.9195, municipalities: [] },
    { name: "広島県", prefecture: "広島県", active: true, lat: 34.3853, lng: 132.4553, municipalities: [] },
    { name: "福岡県", prefecture: "福岡県", active: true, lat: 33.6064, lng: 130.4181, municipalities: [] },
  ] as Array<{
    name: string;
    prefecture: string;
    active: boolean;
    lat: number;
    lng: number;
    municipalities: Array<{ name: string; lat: number; lng: number }>;
  }>,
  night_time_slots: ["3部", "4部"],
  cancel_fee_rates: {} as Record<string, number>,
  features_enabled: {} as Record<string, boolean>,
  // IMPLEMENTATION_PLAN.md §3.8 item 7's "genre/tag master (a structured
  // taxonomy replacing free-text genre)" — same "living config in
  // system_config/settings, admin-editable, guest-readable" shape as
  // service_areas above. Seeded with the 7 values CocomisePage's own guest-
  // facing filter chips already hardcode (dsl/edit.dart, CocomisePage) —
  // this makes those chip labels finally correspond to a REAL admin-
  // maintained list instead of guessed/unverified free text (see
  // PROJECT_KNOWLEDGE.md's own note that those chips were "never verified
  // against real Firestore documents"). `adminUpsertCocotenShop` validates
  // any admin-submitted `genre` against this list (see admin.ts).
  cocoten_genres: ["和食", "洋食", "和洋食", "イタ飯", "韓食", "中華", "その他"],
};

export type SystemConfig = typeof SYSTEM_DEFAULTS;

// `service_areas` needs a per-ENTRY backfill, not the plain shallow
// `{...SYSTEM_DEFAULTS, ...doc.data()}` spread every other config field
// gets. That spread replaces the WHOLE `service_areas` array the instant
// the stored document has its own `service_areas` key at all (true for
// every project that has ever saved `ServiceAreaPage` even once, since
// `active` predates `lat`/`lng`/`municipalities`) — a stored array saved
// before this task added `lat`/`lng`/`municipalities` would otherwise
// silently present as missing those fields forever, even though
// SYSTEM_DEFAULTS has them, because the shallow spread never looks inside
// the array. Backfills each stored entry (matched by `prefecture`) with
// the matching SYSTEM_DEFAULTS entry's `lat`/`lng`/empty `municipalities`
// ONLY for fields the stored entry doesn't already have — `...stored`
// spreads last, so any real, already-saved value (an admin-edited
// coordinate, or municipalities added via `adminAddServiceAreaMunicipality`)
// always wins over the default.
export function backfillServiceAreas(rawAreas: unknown): SystemConfig["service_areas"] {
  if (!Array.isArray(rawAreas)) return SYSTEM_DEFAULTS.service_areas;
  return rawAreas.map((stored) => {
    const s = (stored || {}) as Record<string, unknown>;
    const defaultEntry = SYSTEM_DEFAULTS.service_areas.find(
      (d) => d.prefecture === s.prefecture
    );
    return {
      lat: defaultEntry?.lat ?? 35.6895,
      lng: defaultEntry?.lng ?? 139.6917,
      municipalities: [] as Array<{ name: string; lat: number; lng: number }>,
      ...s,
    } as SystemConfig["service_areas"][number];
  });
}

// Helper: Get system config from Firestore (with fallback to defaults)
export async function getSystemConfig(): Promise<SystemConfig> {
  try {
    const doc = await db.collection("system_config").doc("settings").get();
    if (doc.exists) {
      const data = doc.data() || {};
      const merged = { ...SYSTEM_DEFAULTS, ...data } as SystemConfig;
      if (data.service_areas !== undefined) {
        merged.service_areas = backfillServiceAreas(data.service_areas);
      }
      return merged;
    }
  } catch (e) {
    console.error("Failed to load system config, using defaults:", e);
  }
  return SYSTEM_DEFAULTS;
}

/**
 * Sends a real OS-level push notification via FCM — the "native push
 * notifications (FCM) infrastructure" unimplemented-features item.
 * Genuinely separate from this app's existing `users/{uid}/notifications`
 * writes, which are IN-APP only (a Firestore doc the app itself reads and
 * displays, never a real device notification banner) — this sits
 * ALONGSIDE those writes at each call site, not a replacement for them.
 *
 * `Actions.triggerPushNotificationToUser` (the FlutterFlow-AI-SDK-native
 * DSL action documented in CLAUDE.md) was investigated first and found
 * NOT reachable from this project's `dsl/edit.dart` as currently
 * structured — it lives behind the SDK package's internal-only barrel
 * (`src/ui/actions.dart`, exported solely via `internal_sdk.dart`, whose
 * own doc comment reads "Internal FlutterFlow AI surface for package
 * tests and maintainer tooling"), never re-exported through the public
 * barrel this project actually imports. Confirmed via direct source read
 * of the SDK's own export graph before choosing this alternative — not
 * assumed. This ALSO would only ever have covered the few notification
 * events that happen to fire from a live, authenticated client action
 * chain (chat send, reservation respond) — every server-only/webhook/
 * scheduled path (Stripe webhooks, `retryFailedCastTransfers`) could
 * never be reached that way regardless. A server-side send via
 * `admin.messaging()` (already an available `firebase-admin` capability,
 * zero new dependency) works uniformly for both cases, so it's the
 * architecturally correct choice here, not just a workaround.
 *
 * Reads the recipient's `users/{uid}.fcm_token`, written client-side by
 * the new `registerFcmToken` custom action (dsl/edit.dart) once
 * notification permission is granted. A user who never granted
 * permission (or hasn't opened the app since this feature shipped)
 * simply has no token — this silently no-ops for them, the SAME
 * best-effort shape as every other notification path in this codebase.
 * Never throws: a push failure must never break the caller's actual
 * operation (reservation response, chat send, KYC approval, etc.) —
 * mirrors `sendChatMessage`'s own established per-write `.catch()`
 * best-effort pattern for its in-app notification fan-out.
 */
export async function sendPushNotification(
  uid: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  if (!uid) return;
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    const token = userDoc.data()?.fcm_token;
    if (!token || typeof token !== "string") return;

    await messaging.send({
      token,
      notification: { title, body },
      ...(data ? { data } : {}),
    });
  } catch (e: any) {
    const code = e?.code || e?.errorInfo?.code;
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      // Stale token confirmed dead — clear it so future calls stop
      // repeatedly retrying against it.
      await db
        .collection("users")
        .doc(uid)
        .update({ fcm_token: FieldValue.delete() })
        .catch(() => {});
    }
    // Any other failure (network, malformed payload, etc.) — swallow.
    // Push delivery is best-effort and must never break the caller.
  }
}

// Shared with admin.ts (forwardKycDocumentToStripe) and auth.ts (submitKYC).
// Originally defined only in admin.ts to close a confirmed SSRF
// vulnerability (an arbitrary docUrl reaching a server-side `fetch()`) —
// moved here (2026-08-13, PROJECT_KNOWLEDGE.md §71) so the PRODUCER of
// `kyc_doc_url`/`kyc_selfie_url` (submitKYC) can validate at write time
// too, not just the one downstream consumer that happened to fetch it.
// This project's KYC uploads only ever go through Firebase Storage, so
// nothing legitimate is excluded by this allowlist.
export const ALLOWED_KYC_DOC_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];

export function isAllowedKycDocUrl(docUrl: string): boolean {
  try {
    const parsed = new URL(docUrl);
    return parsed.protocol === "https:" && ALLOWED_KYC_DOC_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}
