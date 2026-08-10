import * as admin from "firebase-admin";
import Stripe from "stripe";

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export const storage = admin.storage();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

// Stripe initialization using environment variables
// Create functions/.env with STRIPE_SECRET_KEY=sk_test_xxx
// Or set with: firebase functions:secrets:set STRIPE_SECRET_KEY
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2023-10-16",
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
  service_areas: [] as Array<{ name: string; prefecture: string; active: boolean }>,
  night_time_slots: ["3部", "4部"],
  cancel_fee_rates: {} as Record<string, number>,
  features_enabled: {} as Record<string, boolean>,
};

export type SystemConfig = typeof SYSTEM_DEFAULTS;

// Helper: Get system config from Firestore (with fallback to defaults)
export async function getSystemConfig(): Promise<SystemConfig> {
  try {
    const doc = await db.collection("system_config").doc("settings").get();
    if (doc.exists) {
      return { ...SYSTEM_DEFAULTS, ...doc.data() };
    }
  } catch (e) {
    console.error("Failed to load system config, using defaults:", e);
  }
  return SYSTEM_DEFAULTS;
}
