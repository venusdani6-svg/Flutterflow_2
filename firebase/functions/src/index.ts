/**
 * icoccha Cloud Functions - Main Entry Point
 * All Cloud Functions are exported from this file
 */

import { setGlobalOptions } from "firebase-functions/v2";

// maxInstances lowered from the implicit uncapped default to fit this
// project's small Cloud Run CPU-per-region quota (20 vCPU on a fresh
// project, self-service increase unavailable yet pending usage history).
// FIX (2026-08-11): this block previously ALSO set `cpu: 0.5`, on the
// (wrong) assumption from its own earlier comment that setGlobalOptions'
// v2-only options only apply to v2 (onCall/onRequest/onSchedule from
// firebase-functions/v2/*) functions, leaving the "few" 1st-gen functions
// unaffected. That assumption was wrong on two counts, confirmed by
// tracing the actual failure into firebase-tools' own source
// (deploy/functions/validate.js's cpuConfigIsValid): (1) there are 10
// gen-1 functions affected, not the 3 named in the old comment, and not
// even the 8 this comment itself said until this correction (2026-08-12,
// comprehensive review — the list below undercounted by 2, confirmed via
// `firebase functions:list --json`'s own `platform: "gcfv1"` field):
// adminGetUsers, adminGetReservations, adminGetAffiliateOverview,
// adminGetLedger, adminGetStripeLogs, adminUpsertBanner,
// adminApprovePayout, adminGetDashboardStats, adminGetPayoutRequests (all
// in admin.ts) plus onUserCreated (auth.ts) — all genuinely written with
// the v1 SDK, confirmed via grep, not a declaration mistake); (2) despite
// being v1-declared with no `cpu` option of their own to override,
// firebase-tools' own endpoint-extraction step was applying
// setGlobalOptions' `cpu` value to their internal endpoint representation
// regardless of platform, which cpuConfigIsValid then correctly rejects
// ("Cannot set CPU on the functions ... because they are GCF gen 1") —
// blocking EVERY deploy, not just ones touching these functions. No safe
// per-function fix exists for this (v1 syntax has no cpu override point),
// so `cpu` is dropped here entirely rather than patched around. This
// re-risks the ORIGINAL vCPU-quota-exceeded failure this line was added
// to avoid — a known, already-diagnosed failure mode, not a mystery — if
// it resurfaces, revisit via `gcloud` quota increase or per-function
// (not global) `cpu` overrides scoped to genuinely v2-only declarations.
setGlobalOptions({ region: "asia-northeast1", maxInstances: 10 });

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
  syncVerifiedPhone,
  updateLastLogin,
  blockUser,
  unblockUser,
  getBlockedUsersDetails,
  addFavorite,
  removeFavorite,
  getFavoriteCasts,
  isCastFavorited,
  reportUser,
  submitInquiry,
  requestWithdrawal,
  getServiceAreas,
  getServiceAreaCoordinates,
  getDiscoveryCasts,
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
  cancelExtensionPayment,
  processTip,
  createSetupIntent,
  requestPayout,
  getWalletBalance,
  retryFailedCastTransfers,
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
  autoCompleteStalledInProgress,
  sendChatMessage,
  getChatRoomInfo,
  getReservationDetailInfo,
  getMyMatchaList,
} from "./reservations";

// ============================================
// Affiliate System
// ============================================
export {
  processMonthlyAffiliatePayments,
  getAffiliateDashboard,
} from "./affiliate";

// ============================================
// Work Board
// ============================================
export {
  applyToWorkPost,
  selectWorkApplicant,
  cancelMyWorkPost,
  fetchWorkPosts,
  getWorkPostDetail,
  fetchMyWorkPosts,
} from "./work-posts";

// ============================================
// Cast Work-Calendar (§3.7.2)
// ============================================
export {
  getMySchedule,
  toggleScheduleSlot,
  getCastScheduleForGuest,
  autoReleaseOrphanedSlots,
} from "./schedule";

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
  adminGetAffiliateRateHistory,
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
  adminGetRecruitmentChatLog,
  adminApprovePayout,
  adminGetPayoutRequests,
  adminGetDashboardStats,
  adminGetActivityReport,
  adminGetAuditLogs,
  adminGetProcessedEvents,
  adminGetCocotenShops,
  adminUpsertCocotenShop,
  adminDeleteCocotenShop,
  adminGetCocotenGenres,
  adminUpdateCocotenGenres,
  adminAddServiceAreaMunicipality,
  adminRemoveServiceAreaMunicipality,
  adminGetWorkPosts,
  adminCloseWorkPost,
  adminCreateWorkPost,
  adminHireWorkPostApplicant,
  adminGetChatRooms,
  adminCloseChat,
  adminGetAccountDeletionStatus,
  adminSendNotification,
  adminGetHomeRankingDiagnostics,
} from "./admin";
