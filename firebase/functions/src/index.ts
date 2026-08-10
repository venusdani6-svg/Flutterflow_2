/**
 * icoccha Cloud Functions - Main Entry Point
 * All Cloud Functions are exported from this file
 */

import { setGlobalOptions } from "firebase-functions/v2";

// cpu/maxInstances lowered from the implicit defaults (1 vCPU, effectively
// uncapped scale-out) to fit this project's small Cloud Run CPU-per-region
// quota (20 vCPU on a fresh project, self-service increase unavailable yet
// pending usage history) — deploying ~55 functions at the implicit 1 vCPU
// default exceeded it well before all functions were even deployed. These
// are low-traffic admin/CRUD/webhook functions with no heavy compute need,
// so 0.5 vCPU / 10 max instances per function is a safe fit, not just a
// workaround — revisit upward once real traffic and/or an approved quota
// increase justify it. Note: only applies to v2 functions (onCall/onRequest/
// onSchedule from firebase-functions/v2/*) — the few 1st-gen functions
// (onUserCreated, adminApprovePayout, adminGetPayoutRequests) configure
// their own resources separately and aren't affected by this.
setGlobalOptions({ region: "asia-northeast1", cpu: 0.5, maxInstances: 10 });

// ============================================
// Auth & User Management
// ============================================
export {
  onUserCreated,
  completeOnboarding,
  submitConnectOnboarding,
  getConnectAccountStatus,
  submitKYC,
  updateProfile,
  updateLastLogin,
  blockUser,
  reportUser,
  requestWithdrawal,
} from "./auth";

// ============================================
// Stripe Payments
// ============================================
export {
  createPaymentIntent,
  confirmPaymentIntent,
  capturePayment,
  cancelPayment,
  createExtensionPayment,
  processTip,
  createSetupIntent,
  requestPayout,
} from "./stripe-payments";

// ============================================
// Stripe Webhooks
// ============================================
export { stripeWebhook } from "./stripe-webhooks";

// ============================================
// Reservations
// ============================================
export {
  createReservation,
  respondToReservation,
  confirmMeetup,
  reportCompletion,
  submitReview,
  autoCancelExpiredAuth,
  autoCompleteReviews,
} from "./reservations";

// ============================================
// Affiliate System
// ============================================
export {
  processMonthlyAffiliatePayments,
  getAffiliateDashboard,
} from "./affiliate";

// ============================================
// Admin Panel
// ============================================
export {
  adminGetUsers,
  adminApproveKYC,
  adminToggleFreeze,
  adminForceDeleteUser,
  adminUpdateUserProfile,
  adminGetReservations,
  adminForceCancel,
  adminManualRefund,
  adminGetReservationExtras,
  adminUpdateReservationLocation,
  adminUpdateAffiliateRate,
  adminGetAffiliateOverview,
  adminGetLedger,
  adminGetStripeLogs,
  adminUpsertBanner,
  adminDeleteBanner,
  adminGetSystemConfig,
  adminUpdateSystemConfig,
  adminGetReports,
  adminResolveReport,
  adminGetReportChatLog,
  adminApprovePayout,
  adminGetPayoutRequests,
  adminGetDashboardStats,
  adminGetAuditLogs,
  adminGetProcessedEvents,
  adminGetCocotenShops,
  adminUpsertCocotenShop,
  adminDeleteCocotenShop,
  adminGetWorkPosts,
  adminCloseWorkPost,
  adminCreateWorkPost,
  adminHireWorkPostApplicant,
} from "./admin";
