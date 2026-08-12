# Project Analysis: icoccha-new-mockup-9a6ing

Comprehensive analysis of this FlutterFlow AI workspace, generated 2026-08-09. This document consolidates findings from a full pass over the workspace tooling/state, the generated typed SDK (`lib/flutterflow_project/`), the read-only generated Flutter snapshot (`generated_code/`), and every page/component in the project.

---

## 1. Workspace State & Tooling

**This is a brownfield workspace bound to a pre-existing, already-built FlutterFlow project** — not a fresh scaffold that was built up locally.

- `.flutterflow/config.yaml`: `project_id: icoccha-new-mockup-9a6ing`, `env: prod`, `main_project_id` = same, `branch_info_ref: branch_infos/54ErrVSQwfERGyzezDgk`, `head_commit_id: 037qMEwXUkM5leqapCDP`, `flutterflow_ai_version: 0.0.40` (build `b5c8a09d`), `api_base_url: https://api.flutterflow.io/v2`. The project uses FlutterFlow's branching system and this workspace tracks a specific branch/commit.
- **`dsl/create.dart` and `dsl/edit.dart` are both unmodified starter templates.** `buildStarterCreateFlow` builds a single `StarterPage` with a heading, body text, and a "Show Snackbar" button; `buildStarterEditFlow` is an empty function body (just a comment). `test/app_test.dart` still asserts against `StarterPage`, not any real page in the project. Neither file has been touched since scaffolding.
- **No run history exists**: `.flutterflow/runs.jsonl`, `.flutterflow/history/`, and `.flutterflow/traces/` are all absent. `flutterflow ai run` has never been executed from this workspace.
- Everything under `lib/flutterflow_project/` (24 pages, 8 components, a 3,030-line schema file, app state, theme) was pulled in via `flutterflow ai init --project <id>` reading the **existing remote project** — not authored locally via the DSL. `.flutterflow/project_sdk_meta.json` shows `status: "fresh"`, generated `2026-08-09T09:22:45Z`. `.flutterflow/generated_code_state.json` confirms `generated_code/` was exported successfully at `2026-08-09T09:23:00Z`.
- **Git is not actually scoped to this project.** `git rev-parse --show-toplevel` resolves to `/home/ari` (the entire home directory), there are no commits, and `git status` lists unrelated home-directory files (`.bashrc`, `Downloads/`, `.android/`, `.gnupg/`, etc.) as untracked. There is no dedicated repository for this project directory — this should be fixed (a proper `git init` scoped to the project root) before any real commit workflow begins.
- `.gitignore` at the project root is FlutterFlow-AI-managed and correctly excludes `.env`, `.flutterflow/.env`, `.flutterflow/sdk/`, run artifacts, `generated_code/`, `.ffai_staging/`, `.dart_tool/`, etc.
- **Multi-agent tooling parity**: `.mcp.json`, `.kiro/settings/mcp.json`, and `.codex/config.toml` all wire up the identical `flutterflow_ai` MCP stdio server (`dart run .flutterflow/sdk/flutterflow_ai/mcp/server.dart --dir <workspace>`). `CLAUDE.md` and `AGENTS.md` are near-duplicate copies of the same instruction set — this workspace is set up to be driven interchangeably by Claude Code, Kiro, or Codex.
- `pubspec.yaml` (workspace-level, not the app's): package name `icoccha_new_mockup_9a6ing`, depends on `flutterflow_ai` via local path (`./.flutterflow/sdk/flutterflow_ai`), dev dependency `test: ^1.25.8`.
- `.flutterflow/.env.example` shows the only expected env var is `FF_API_KEY` (plus an optional `FF_BASE_URL` override for local testing). Actual `.flutterflow/.env` was not read (contains secrets, gitignored).

---

## 2. App Domain & Purpose

This is a Japanese-market **paid-companion / concierge "hang-out booking" app**, internally branded **イコッチャ (Icoccha)**. `work_page.dart`'s own recruiting copy confirms it directly:

> "イコッチャガールズ/ボーイズ…空いた暇な時間をゲストと共有し、食事を中心に交友しながら…"
> ("Icoccha Girls/Boys — share your free time with guests, socializing mainly over meals…")

Guests browse and book time with "cast" companions (or ancillary staff — security/transport), pay via Stripe, chat, and rate the experience; cast members manage a profile, availability calendar, and an affiliate/referral payout system.

Three separate identifiers exist for the same app, worth keeping straight:
- FlutterFlow project id: `icoccha-new-mockup-9a6ing`
- Generated app pubspec name: `icoccha_new_mockup`
- Firebase project id: `icoccha` (confirmed in both `google-services.json` and `GoogleService-Info.plist`)

---

## 3. Data Model — `lib/flutterflow_project/schemas.dart` (3,030 lines)

**STALE as of 2026-08-10 — this section documents the schema as it stood before `IMPLEMENTATION_PLAN.md` §5's Phase 1 remediation was executed (see `PROJECT_KNOWLEDGE.md` §8 for the full writeup).** All items flagged below as typos/gaps/missing Enums (`res_ic`, `display_name`, `phone_number`, `work_post`, `affiliate_uid`, zero Enums, missing `guest_confirmed_meetup`/`cast_confirmed_meetup`, `password_hash` present, `extension_payments` present) have since been fixed — the collection is now 26 (was 25: `extension_payments` removed, `payout_requests` + `affiliate_rate_history` added), and 9 Enums now exist covering every closed-vocabulary field this section calls out. Left as-is below for historical context (what a from-scratch read of the pre-remediation project found), not as current truth — do not act on field names in this section without cross-checking `lib/flutterflow_project/schemas.dart` or `flutterflow ai inspect` directly.

### 3.0 Top-level shape

- **`Enums`** → `static const all = []` — **empty**. No enums defined anywhere.
- **`Structs`** → `static const all = []` — **empty**. No custom struct/data-class types; zero nesting anywhere in the schema — every collection is a flat map of scalar fields.
- **`Collections`** — **25 Firestore collections**, each backed by a generated `XxxFields extends MapBase<String, ffai.DslType>` class.
- **`Tables`** → `static const all = []` — **empty**. This is the SDK's relational/Supabase abstraction; empty confirms **no relational backend** — Firestore only.
- **`CustomCode`** — 1 function (`calculateExtensionPrice`), 2 actions (`callCreatePaymentIntent`, `confirmStripePayment`), 0 widgets. All three are Stripe/payment-related.

**Global stats**: 252 total fields across 25 collections. Every single `description` string (277 occurrences across collections+fields) is empty — zero inline documentation anywhere in the schema.

Field-type distribution (252 fields): String 132, Integer 40, DateTime 40, Boolean 15, `List<String>` 12, ImagePath 7, DocumentReference 3, LatLng 2, `List<DocumentReference>` 1.

### 3.1 Every collection (fields & types)

**`affiliate_rewards`** (10 fields) — `affiliate_uid`:String, `base_amount`:Integer, `created_at`:DateTime, `month`:String, `paid_at`:DateTime, `rate`:Integer, `referred_uid`:String, `res_id`:String, `reward_amount`:Integer, `status`:String

**`audit_logs`** (7 fields) — `action`:String, `admin_id`:String, `created_at`:DateTime, `details`:List\<String\>, `reason`:String, `target_id`:String, `target_type`:String

**`banners`** (7 fields) — `active`:Boolean, `created_at`:DateTime, `display_order`:Integer, `image_url`:ImagePath, `link_url`:String, `page`:String, `title`:String

**`chat_rooms`** (9 fields) — `active`:Boolean, `closed_at`:DateTime, `created_at`:DateTime, `last_message`:String, `last_message_time`:DateTime, `participants`:List\<String\>, `res_id`:String, `room_id`:String, `users`:List\<DocumentReference\> → `Collections.users`

**`chats`** (4 fields) — `chat_room_id`:DocumentReference → `Collections.chatRooms`, `created_at`:DateTime, `sender_id`:DocumentReference → `Collections.users`, `text`:String

**`cocoten_shops`** (10 fields) — `active`:Boolean, `address`:String, `created_at`:DateTime, `genre`:String, `guest_benefits`:String, `location`:LatLng (geopoint), `menu`:String, `name`:String, `photos`:ImagePath, `tags`:List\<String\>

**`debt_history`** (5 fields) — `amount`:Integer, `created_at`:DateTime, `reason`:String, `res_id`:String, `user_id`:String

**`extension_payments`** (7 fields) — `amount`:Integer, `createdAt`:DateTime, `minutes`:Integer, `paymentID`:String, `reservationld`:String, `status`:String, `userld`:String *(the only collection using camelCase document-field keys — see §3.4)*

**`extensions`** (6 fields) — `amount`:Integer, `created_at`:DateTime, `duration_minutes`:Integer, `ext_id`:String, `payment_intent_id`:String, `status`:String *(no reservation-linking field at all — see §3.4)*

**`favorites`** (2 fields) — `cast_id`:String, `created_at`:DateTime *(no owner/user field — implies Firestore subcollection, e.g. `users/{uid}/favorites`)*

**`ledger`** (17 fields) — `amount`:Integer, `cast_reward`:Integer, `created_at`:DateTime, `gross_amount`:Integer, `ledger_id`:String, `net_transfer`:Integer, `platform_profit`:Integer, `processed`:Boolean, `res_id`:String, `staff_fee`:Integer, `status`:String, `stripe_event_id`:String, `stripe_fee`:Integer, `stripe_object_id`:String, `tax_amount`:Integer, `type`:String, `user_id`:String

**`macchas`** (11 fields) — `age`:Integer, `bio`:String, `created_time`:DateTime, `display_name`:String, `is_active`:Boolean, `location`:String, `participants`:List\<String\>, `photo_url`:ImagePath, `status`:String, `uid`:String, `user_role`:String

**`messages`** (5 fields) — `created_at`:DateTime, `read`:Boolean, `read_at`:DateTime, `sender_id`:String, `text`:String *(no parent/room reference — implies Firestore subcollection, e.g. `chat_rooms/{roomId}/messages`)*

**`notifications`** (6 fields) — `body`:String, `created_at`:DateTime, `data`:List\<String\>, `read`:Boolean, `title`:String, `type`:String *(no recipient field — implies subcollection under `users`)*

**`pair_history`** (5 fields) — `cast_id`:String, `guest_id`:String, `interaction_count`:Integer, `last_capture_at`:DateTime, `pair_key`:String

**`payments`** (7 fields) — `client_secret`:String, `created_at`:DateTime, `payment_intent_id`:String, `res_id`:String, `status`:String, `total_amount`:Integer, `user_id`:String

**`processed_events`** (2 fields) — `event_type`:String, `processed_at`:DateTime *(webhook idempotency marker; document ID is presumably the event ID)*

**`reports`** (8 fields) — `admin_note`:String, `chat_log_ref`:String, `created_at`:DateTime, `reason`:String, `reported_id`:String, `reporter_id`:String, `res_id`:String, `status`:String

**`reservations`** (27 fields — largest collection after `users`) — `base_amount`:Integer, `cancel_reason`:String, `cancelled_by`:String, `cast_ids`:List\<String\>, `created_at`:DateTime, `date`:DateTime, `details`:String, `duration_minutes`:Integer, `extension_count`:Integer, `group_invite`:Boolean, `group_size`:Integer, `guest_id`:String, `last_capture_at`:DateTime, `location`:String, `meeting_point`:String, `payment_intent_id`:String, `res_ic`:String *(typo, see §3.4)*, `staff_fee`:Integer, `staff_ids`:List\<String\>, `status`:String, `thirty_min_rule_applied`:Boolean, `time_slot`:String, `total_amount`:Integer, `total_hours`:Integer, `transfer_group`:String, `transport_fee`:Integer, `updated_at`:DateTime

**`reviews`** (6 fields) — `comment`:String, `created_at`:DateTime, `rating`:Integer, `res_id`:String, `reviewee_id`:String, `reviewer_id`:String

**`schedule_slots`** (5 fields) — `cast_id`:String, `date`:DateTime, `end_at`:DateTime, `start_at`:DateTime, `status`:String

**`stripe_logs`** (6 fields) — `created_at`:DateTime, `event_type`:String, `raw_data`:List\<String\>, `res_id`:String, `stripe_event_id`:String, `ttl`:DateTime *(likely a Firestore TTL-policy field)*

**`system_config`** (12 fields, singleton platform-config document) — `affiliate_min_days`:Integer, `affiliate_payment_day`:Integer, `cancel_fee_rates`:String, `chat_close_sec`:Integer, `default_affiliate_rate`:Integer, `default_cast_rate`:Integer, `max_total_hours`:Integer, `night_time_slots`:List\<String\>, `service_areas`:List\<String\>, `tax_rate`:Integer, `transport_fee_amount`:Integer, `transport_fee_threshold_sec`:Integer

**`users`** (51 fields — largest collection by far) — `account_type`, `activity_city`, `activity_prefecture`, `affiliate_rate`, `age_group`, `agreed_at`(DateTime), `approval_status`, `atmosphere`, `birth_date`(DateTime), `blocked_users`(List\<String\>), `city`, `consent_at`(DateTime), `created_time`(DateTime), `desired_interaction`, `display_name`, `drinking`, `email`, `favorite_food_tags`, `gallery_images`(ImagePath), `gender`, `hobbies`, `individual_rate`, `invitation_code`, `is_active`(Boolean), `is_agreed`(Boolean), `is_frozen`(Boolean), `is_online`(Boolean), `is_verified`(Boolean), `kyc_doc_url`, `kyc_selfie_url`, `kyc_status`, `last_login_at`(DateTime), `location`(LatLng), `logical_debt`(Integer), `offered_interaction`, `one_line_message`, `password_hash`, `phone_number`, `photo_url`(ImagePath), `prefecture`, `profile_image_url`(ImagePath), `referred_by_uid`, `role`, `self_introduction`, `skills`, `smoking`, `staff_type`, `stripe_account_id`, `stripe_customer_id`, `uid`, `updated_at`(DateTime) — all untyped fields are String unless noted.

**`work_post`** (17 fields) — `applicants`:List\<String\>, `category`:String, `content`:String, `created_at`:DateTime, `date`:DateTime, `fee`:Integer, `is_active`:Boolean, `location`:String, `poster_id`:String, `res_id`:String, `selected_id`:String, `status`:String, `title`:String, `type`:String, `user_name`:String, `user_photo`:ImagePath, `user_ref`:DocumentReference → `Collections.users`

### 3.2 Grouping by domain

- **User identity/profile**: `users` (mega-entity), `macchas` (denormalized "matching card" read-model for swipe/browse-style matching).
- **Cast/staff & venues**: `cocoten_shops` (venue directory), `schedule_slots` (per-cast availability), `work_post` (gig/job-board).
- **Reservations/bookings**: `reservations`, `extensions`, `extension_payments`, `pair_history` (repeat cast↔guest "capture"/check-in tracking — suggests a QR/NFC physical check-in mechanic).
- **Payments/finance**: `payments`, `extension_payments`, `ledger` (full revenue-split accounting), `debt_history`, `stripe_logs`, `processed_events`, `affiliate_rewards`, `system_config`.
- **Chat/messaging**: `chat_rooms`, `chats`, `messages`, `notifications`.
- **Trust & safety/moderation**: `reviews`, `reports`, `audit_logs`.
- **Marketing/content**: `banners`.

### 3.3 Inferred relationships

Only **4 of 252 fields** are real typed `DocumentReference`s: `chat_rooms.users` (→ users), `chats.chat_room_id` (→ chatRooms), `chats.sender_id` (→ users), `work_post.user_ref` (→ users). Every other relationship is an informal string-ID convention inferred from naming:

- `reservations.guest_id` ↔ `users.uid`; `reservations.cast_ids`/`staff_ids` ↔ `users.uid` (two separate list fields, unclear distinction).
- `reservations.res_ic` (typo for `res_id`) is the join key referenced by: `payments.res_id`, `ledger.res_id`, `reports.res_id`, `debt_history.res_id`, `stripe_logs.res_id`, `affiliate_rewards.res_id`, `work_post.res_id`, `chat_rooms.res_id`, `reviews.res_id`, and `extension_payments.reservationld` (also typo'd).
- `payments.user_id`, `ledger.user_id`, `debt_history.user_id` ↔ `users.uid`.
- `reviews.reviewer_id`/`reviewee_id` ↔ `users.uid`.
- `pair_history.cast_id`/`guest_id` ↔ `users.uid`.
- `favorites.cast_id` ↔ `users.uid` (owner implied by subcollection path).
- `schedule_slots.cast_id` ↔ `users.uid`.
- `work_post.poster_id`, `selected_id`, `applicants[]` ↔ `users.uid` (and separately, `user_ref` also ↔ `users` — two parallel representations).
- `affiliate_rewards.affiliate_uid`/`referred_uid` ↔ `users.uid`; ties to `users.referred_by_uid` and `users.invitation_code` (referral chain: invite → signup → reservation → monthly reward).
- `audit_logs.admin_id` ↔ `users.uid`; `audit_logs.target_id` is polymorphic, disambiguated by `target_type`.
- `reports.reporter_id`/`reported_id` ↔ `users.uid`; `reports.chat_log_ref` ↔ likely `chats`/`chat_rooms`; `reports.res_id` ↔ `reservations`.

**End-to-end domain flow**: a guest books a `reservation` with cast/staff (optionally at a `cocoten_shops` venue) → `payments`/`extension_payments` capture Stripe charges → `ledger` records the financial split → `chat_rooms`/`chats`/`messages` support communication → `reviews`/`reports` capture post-reservation trust signals → `affiliate_rewards` pays referral commissions monthly → `pair_history` tracks repeat-customer pairing → `audit_logs` records admin moderation.

### 3.4 Backend type & notable/unusual findings

**Backend is Firestore, not Supabase/Postgres.** Evidence: `Collections` uses `ffai.ProjectCollectionHandle` with snake_case Firestore-style names; reference fields use `ffai.docRef(...)` (Firestore-specific `DocumentReference`); `ffai.latLng` (GeoPoint) and `ffai.imagePath` (Firebase Storage path) are Firestore/Firebase-native types; `Tables` (the dedicated relational abstraction) is completely empty; several collections lacking owner fields (`favorites`, `messages`, `notifications`) imply Firestore subcollection nesting; `stripe_logs.ttl` matches Firestore's native TTL-policy mechanism.

**Structurally unusual / notable items:**
1. **No Enums or Structs at all** — every closed-vocabulary field (`status` in 9+ collections, `role`, `account_type`, `kyc_status`, `approval_status`, `gender`, `type`, `staff_type`, `target_type`) is a bare `String` with zero type-level enforcement.
2. **`users` is a 51-field "god document"** conflating auth/credentials (including a directly-stored `password_hash` — unusual/risky alongside Firebase Auth, which normally handles this out-of-band), KYC/verification, dating/matching preferences, cast/staff business data, Stripe identity, moderation flags, and referral data.
3. **`reservations` hardcodes a business rule as a field name**: `thirty_min_rule_applied` — brittle if the underlying policy threshold changes.
4. **Field-name typos baked into the live schema**: `reservations.res_ic` (should be `res_id`, breaking the convention used by 8+ other collections); `extension_payments.reservationld` and `userld` (should be `reservationId`/`userId`).
5. **`extension_payments` is the sole camelCase outlier** — every other collection uses snake_case document keys.
6. **Likely duplicate/overlapping entities**: `extensions` vs `extension_payments` both model "extend an active reservation" but `extensions` has no reservation-linking field at all, while `extension_payments` links via the typo'd `reservationld`.
7. **Redundant reference pairs**: `work_post.poster_id` (String) + `user_ref` (DocumentReference) point at the same user two ways; `chat_rooms.participants` (List\<String\>) + `users` (List\<DocumentReference\>) are apparently redundant; `reservations.cast_ids` + `staff_ids` (both List\<String\>) have no field distinguishing their semantics.
8. **Only 4 of 252 fields are real typed relations** — referential integrity is essentially unenforced at the schema level project-wide.
9. **Polymorphic reference without a type union**: `audit_logs.target_id` + `target_type` uses two plain strings instead of a discriminated/typed reference.
10. **Type inconsistency for the same concept**: `location` is `LatLng` in `cocoten_shops`/`users` but plain `String` in `reservations`/`work_post`/`macchas`.
11. **Thinnest collections**: `favorites` and `processed_events` have only 2 fields each.
12. **Zero documentation**: all 277 `description` fields across every collection and field are empty strings.

---

## 4. Backend Infrastructure — `generated_code/`

This is the read-only exported Flutter snapshot — the runtime truth behind the DSL's intent.

### 4.1 Export manifest (`generated_code/.flutterflow/export_manifest.json`)

`schema_version: 1`, `project: {id: icoccha-new-mockup-9a6ing, name: icoccha-new-mockup, directory: icoccha_new_mockup}`, `build: {mode: export, format: true}`, `exported_at: 2026-08-09T09:22:49Z`. `files`: 231 exported file paths. `entities`: 66 entries —
- **25 pages** (`Scaffold_*` keys)
- **25 firestore_collection** entities (matches the schema exactly)
- **8 component** entities (`Container_*` keys)
- **5 global** entities — `app_state`, `index`, `main`, `routing` (nav.dart + serialization_util.dart), `theme` (flutter_flow_theme.dart)
- **2 custom_action** entities — `callCreatePaymentIntent`, `confirmStripePayment`
- **1 custom_function** entity — `calculateExtensionPrice`

### 4.2 `pubspec.yaml` (generated app)

Package `icoccha_new_mockup`, version `1.0.0+1`, SDK `>=3.0.0 <4.0.0`.

- **Firebase**: `firebase_core 3.14.0`, `firebase_auth 5.6.0`, `cloud_firestore 5.6.9` (+platform/web variants), `cloud_functions ^5.1.3`, `firebase_performance 0.10.1+7`.
- **Payments**: `flutter_stripe ^11.0.0` — the sole payment SDK.
- **Auth providers**: `google_sign_in 6.3.0`, `sign_in_with_apple 7.0.1` (+platform/web variants).
- **UI/UX**: `auto_size_text`, `barcode_widget 2.0.3` (QR — matches AffiliateQrCodeBottomSheet), `cached_network_image 3.4.1`, `flutter_animate 4.5.0`, `flutter_rating_bar 4.0.1`, `font_awesome_flutter 10.7.0`, `google_fonts 6.3.3`, `smooth_page_indicator 1.1.0`, `table_calendar 3.2.0`, `infinite_scroll_pagination 4.0.0`, `page_transition 2.1.0`, `timeago 3.7.1`.
- **Custom fork**: `dropdown_button2` from a FlutterFlow-maintained git repo (pinned commit).
- **Navigation/state**: `go_router 12.1.3`, `provider 6.1.5`, `rxdart 0.27.7`.
- **Storage/util**: `shared_preferences`, `path_provider`, `sqflite 2.3.3+1`, `share_plus 10.0.2`, `url_launcher`, `easy_debounce`, `json_path`, `from_css_color`, `cross_file`, `stream_transform`, `collection`, `intl 0.20.2`.
- `dependency_overrides`: `http: 1.4.0`, `uuid: ^4.0.0`.
- Dev: `flutter_lints 4.0.0`, `lints 4.0.0`, `flutter_test`.

**Notably absent**: no Google Maps package (despite `LatLng` fields and a `place.dart` primitive), no Rive package (despite an `assets/rive_animations` placeholder folder), no push-notification/FCM messaging package (despite a full iOS `ImageNotification` extension being wired at the platform level), no `image_picker`.

### 4.3 Firebase wiring

- **`firebase.json`**: standard layout — firestore (rules + indexes), functions (source `functions`), storage rules, hosting.
- **Firebase project id**: `icoccha` (confirmed in both `android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist`).
- **`firestore.rules`** (rules_version 2): broad, largely un-role-gated. Most collections (`users`, `chats`, `chat_rooms`, `work_post`, `macchas`, `reservations`, `reviews`, `schedule_slots`, `banners`, `cocoten_shops`, `ledger`, `debt_history`, `pair_history`, `system_config`, `reports`, `stripe_logs`, `processed_events`, `audit_logs`, `affiliate_rewards`, `extension_payments`, `payments`) share the same template: `allow create: if true; allow read: if true; allow write: if false; allow delete: if false`. `chats/{document}` is the one exception with `allow write: if true` (fully open). The only genuinely auth-gated rules are the `users/{parent}/notifications/{document}` and `users/{parent}/favorites/{document}` subcollections, gated by `request.auth.uid == parent`. Subcollections `reservations/{parent}/extensions/{document}` and `chat_rooms/{parent}/messages/{document}` follow the open create/read pattern, plus wildcard read-only rules for any nested `extensions`/`messages` path. No role/claim-based checks (e.g. `request.auth.token.admin`) exist anywhere — this is an MVP/mockup-style ruleset, not a hardened production one.
- **`firestore.indexes.json`**: `{"indexes": []}` — **no composite indexes defined**.
- **`storage.rules`**: default-deny for everything, with `users/{userId}/{allPaths=**}` allowing public read and owner-only write.

### 4.4 `lib/` top-level folders (generated app)

| Folder | Contents | Purpose |
|---|---|---|
| `auth/` | `auth_manager.dart`, `base_auth_user_provider.dart`, plus `auth_complete/`, `email_verification/`, `firebase_auth/` (anonymous/apple/email/github/google/jwt + `auth_util.dart`), `kyc/`, `login_page/`, `phone_varification/`, `review_pending/`, `signup_page/`, `sms_code/`, `tutorial_page/` | Full auth flow — signup/login, phone/SMS verification, email verification, KYC step, review-pending (admin approval gate), tutorial/onboarding, low-level Firebase auth provider wiring. |
| `backend/` | `backend.dart` (68KB CRUD/query helpers), `firebase/firebase_config.dart`, `schema/` (25 record files + `index.dart`), `util/firestore_util.dart`, `util/schema_util.dart` | The Firestore data layer: typed record classes for all 25 collections plus query/stream helpers. |
| `basic/` | `home_page_basic/`, `outside_page_basic/` | Fallback/simplified or logged-out variants of the home page. |
| `cocomise/` | `cocomise_page/` | A single feature page ("Cocomise" shop/venue browsing), tied to `cocoten_shops`. |
| `component/` | 8 subfolders | Shared/reusable UI components matching the 8 manifest `component` entities. |
| `custom_code/` | `actions/` only (no `widgets/` or `classes/`) | Custom Dart logic beyond the visual builder — see §4.5. |
| `flutter_flow/` | 14 files + `nav/` | FlutterFlow's internal runtime support: theme, custom functions/icons, reusable widget wrappers, `lat_lng.dart`, `place.dart` (geolocation primitives, though no maps package is wired), `uploaded_file.dart`, `nav/nav.dart` + `nav/serialization_util.dart` (go_router routing). |
| `home/` | `cast_profile/`, `home_page/` | Main authenticated home screen + cast (staff/talent) profile page. |
| `maccha/` | `maccha_chats/`, `maccha_page/` | "Maccha" match/chat feature area, tied to the `macchas` collection. |
| `mypage/` | `my_page/`, `profile_edit/` | Account/profile section. |
| `payment/` | `affiliate/`, `extension_payment/`, `payment_confirm/` | Payment flows: affiliate/referral rewards, extension payment, payment confirmation. |
| `reservation/` | `reservation_confirmed/`, `reservation_detail/`, `reservation_form/` | Full booking flow: form, detail view, confirmation. |
| `work/` | `work_page/` | Job-posting/booking board for cast/staff — matches `work_post`. |

### 4.5 Custom code (`lib/custom_code/`)

Only an `actions/` subfolder exists — no custom widgets, no custom classes.

- **`call_create_payment_intent.dart`** — calls a Firebase Cloud Function named `createPaymentIntent` in region `asia-northeast1` via `FirebaseFunctions.instanceFor(...).httpsCallable(...)`, passing `res_id`, `amount`, `transport_fee`, `staff_fee`, `cast_ids`. Returns the result or a structured error map on `FirebaseFunctionsException`.
- **`confirm_stripe_payment.dart`** — uses `flutter_stripe`'s `Stripe.instance`, sets a **hardcoded test-mode publishable key** (`pk_test_51R7BeGR2VQ6GS3rfVe66XcFQRckis8u7cWcYtHnqOqJZw7ac0lmc8aS5SzFIZM8pAK0hUO0ZYuHQ3AeC0ZgJdnKD00ou7pId8U`) and merchant identifier `merchant.com.icoccha.app`, initializes and presents the Stripe Payment Sheet, returning `'success'`, `'canceled'`, or an `'error: ...'` string.
- **`index.dart`** — standard barrel exporting both actions.

**Key finding**: despite `callCreatePaymentIntent` calling a Cloud Function `createPaymentIntent` (region `asia-northeast1`), **no such function exists anywhere in `firebase/functions`** (see §4.7) — the server-side Stripe payment-intent creation logic is missing from this exported snapshot.

### 4.6 `main.dart` / `index.dart`

**`main.dart`**: initializes Flutter bindings, enables `GoRouter.optionURLReflectsImperativeAPIs`, sets the web path URL strategy, calls `initFirebase()`, initializes `FlutterFlowTheme`, creates/persists `FFAppState()`, wraps the app in `ChangeNotifierProvider<FFAppState>` running `MyApp`. `MyApp` builds a `GoRouter` via `createRouter(_appStateNotifier)`, listens to `icocchaNewMockupFirebaseUserStream()` to sync auth state, listens to a `jwtTokenStream`, shows a splash screen for 1000ms. `build()` returns `MaterialApp.router` with light/dark `ThemeData` (Material 2, `useMaterial3: false`), English locale only.

**`index.dart`**: pure barrel re-exporting all 25 page widgets, consumed by `nav.dart`'s route table.

### 4.7 Cloud Functions (`firebase/functions`)

Real but minimal — not a placeholder, but also not what the client expects:

- `package.json`: Node 20, project alias `icoccha`. Dependencies include `firebase-admin`, `firebase-functions`, `braintree`, `@mux/mux-node`, `stripe`, `axios`, `razorpay`, `qs`, `@onesignal/node-onesignal`, plus a full LangChain/LangGraph stack (`@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, `@langchain/google-genai`, `@langchain/anthropic`) — this looks like FlutterFlow's generic boilerplate functions template (covering many possible integrations) rather than dependencies this app actually exercises.
- `index.js` (8 lines): defines exactly **one** function, `onUserDeleted` — a Firebase Auth `onDelete` trigger that fetches a Firestore doc ref at `users/{uid}` but the handler body is empty (never used/deleted) — effectively a stub/no-op.
- `api_manager.js`: generic FlutterFlow boilerplate helper (`makeApiCall`/`makeApiRequest`/`createBody`) with an empty `callMap` — unused scaffolding.

### 4.8 Platform config

Real, populated platform projects, not placeholders:

- **Android**: `build.gradle` sets `namespace`/`applicationId` = `com.mycompany.icoccha`. Real `google-services.json` present (`project_id: icoccha`). Standard Gradle wrapper, manifests, Kotlin `MainActivity.kt` under `com/example/my_project/` (package path doesn't match the `com.mycompany.icoccha` namespace — a common uncorrected FlutterFlow leftover), launcher icons for all densities.
- **iOS**: `Info.plist` sets `CFBundleDisplayName`/`CFBundleName` to `"icoccha-new-mockup"`, `CFBundleIdentifier` templated via Xcode build settings. Real `GoogleService-Info.plist` present (`PROJECT_ID: icoccha`). Full Xcode project structure, entitlements, Podfile, full `AppIcon.appiconset`, launch images/storyboards, and an `ImageNotification` app extension (`NotificationService.swift`) — indicating rich push-notification image support is wired at the platform level (despite no FCM package in `pubspec.yaml` — see §4.2).
- **Web**: minimal but standard Flutter web scaffold (`index.html`, `flutter_bootstrap.js`, favicon, PWA icons).

Both mobile platforms consistently point at Firebase project `icoccha`.

### 4.9 Assets

`generated_code/assets/{images,audios,fonts,jsons,pdfs,rive_animations,videos}/` each contain **only a placeholder `favicon.png`** — no real media has been uploaded to any asset category yet.

---

## 5. Pages (24 total)

**Methodology caveat**: The typed SDK (`lib/flutterflow_project/pages/*.dart`) exposes widget-tree structure and *which* nodes carry a trigger marker (`ON_TAP`, `ON_INIT_STATE`, `ON_FORM_WIDGET_SELECTED`, `ON_TOGGLE_ON/OFF`, etc.) but **not resolved action-chain bodies, `Collections.*`/`Tables.*` bindings, or explicit navigation targets** — those were cross-referenced from the real generated Dart in `generated_code/` where noted below. Grepping the typed SDK pages/components for `Collections.`, `Tables.`, `actionChain`, `NavigateTo`, `AppState` returns nothing — bindings are inferred from naming/schema alignment except where explicitly marked "real code."

### 5.1 Auth / Onboarding

**`login_page.dart` (LoginPage)** — Default unauthenticated landing route (`/`, root when `!loggedIn`). Fields: `LoginEmailField`, `LoginPasswordField` (both validated — email regex, password ≥8 chars). Button "ログイン" → validate → `authManager.signInWithEmail(...)` → SnackBar; navigation to the authenticated area happens via the router's implicit redirect mechanism, not an explicit push. "パスワードを忘れた方はこちらからどうぞ" opens `ResetPasswordBottomSheetWidget` (modal, no page nav). "新規登録の方はこちらからどうぞ" → `SignupPage`. Fully functional — real Firebase Auth call.

**`signup_page.dart` (SignupPage)** — Registration form: nickname, email, password, confirm-password, terms checkbox. Checkbox toggle writes `FFAppState().checkBox`; submit button is disabled (`onPressed: null`) while `checkBox == false`. Submit → validate → password/confirm match check → `authManager.createAccountWithEmail(...)` → Firestore `UsersRecord.update(isAgreed, agreedAt, displayName)` → **`context.pushNamedAuth(HomePageWidget.routeName)`** directly — **bypasses the entire phone/SMS/email/KYC verification chain**. Fully functional.

**`sms_code.dart` (SmsCode)** — 6-digit OTP entry (rendered as static placeholder dashes "ー", not real input fields). AppBar logo → sign out → LoginPage. "認証する"/"認証コードを再送する" buttons are **stubs** (`print('Button pressed ...')`). No real SMS verification wired. Not linked to by any other page.

**`phone_varification.dart` (PhoneVarification)** — Mobile-number entry to trigger SMS send (`MobileNnmberField` — typo in field name). "SMSを送信する" button is a **stub**. AppBar logo → sign out → LoginPage. No wired edge to SmsCode despite the obvious intended sequence.

**`email_verification.dart` (EmailVerification)** — "Check your email" screen with a **hard-coded placeholder email** ("example@email.comに認証メールを送信しました") not bound to the actual user's address. "次へ" button is a **stub**. No `sendEmailVerification()` call.

**`auth_complete.dart` (AuthComplete)** — Confirmation screen for phone verification ("電話番号認証が完了しました"). "次へ" button is a **stub**.

**`kyc.dart` (Kyc)** — "本人確認書類の提出" (submit ID documents) — ID-document upload card + selfie upload card, both static placeholder image+text (no functioning file picker), plus upload requirement notes (JPG/PNG, max 10MB, review takes 1–3 business days). **No submit/upload/next button exists at all** — the least complete page in the set beyond the logout logo.

**`tutorial_page.dart` (TutorialPage)** — 5-slide onboarding carousel (`PageView`). AppBar logo → `LoginPage` (fade transition). Final slide's "とりあえず見てみる" (skip) button → sets `FFAppState().navIndex = 0` → pushes into the app. **Orphaned**: no other page links to TutorialPage; only reachable via direct route.

**`outside_page_basic.dart` (OutsidePageBasic)** — Completely empty scaffold (`Container` → empty `Column`). No triggers, no content. Unbuilt placeholder.

**`home_page_basic.dart` (HomePageBasic)** — Simplified Home skeleton: real chrome (logo, search icon, notifications icon) + `ButtomNaviComp` slot, but empty body content. `ON_INIT_STATE` → `FFAppState().navIndex = 0`. Logo → sign out → LoginPage. Superseded by the real `home_page.dart`; not referenced as a push/go target from any other page.

**Cross-cutting pattern**: SmsCode, PhoneVarification, EmailVerification, AuthComplete, Kyc, and HomePageBasic all wire their AppBar logo tap to the identical sequence `authManager.signOut()` → `context.goNamedAuth(LoginPageWidget.routeName)` — a de-facto "cancel" control on every screen in this branch.

**Reconstructed flow — working edges only:**
```
LoginPage ⇄ SignupPage
SignupPage --(submit, success)--> HomePage (real)
LoginPage --(submit, success)--> [implicit auth-redirect] --> protected route
LoginPage --(forgot password)--> ResetPassword modal
```
**Implied but not wired (every forward action is a stub):**
```
TutorialPage --(logo)--> LoginPage; --(skip)--> Home area
PhoneVarification --(stub)--> SmsCode
SmsCode --(stub)--> AuthComplete or EmailVerification
EmailVerification --(stub)--> AuthComplete or PhoneVarification
AuthComplete --(stub)--> Kyc
Kyc --(no button)--> ReviewPending
```
The customer path (Login/Signup → Home) is fully working. The cast/staff verification path (Phone → SMS → Email/AuthComplete → KYC → ReviewPending → Home) is a visual mockup only — every forward action chain in it is currently a no-op.

### 5.2 Discovery / Social Core

**`home_page.dart` (HomePage)** — Root route (`route: ""`). Main cast-discovery/browse tab. AppBar: logo + "検索"(search)/"お知らせ"(notifications) icons. Body: 5-slide banner `PageView` carousel (each with like/share icon overlay), a `SwitchListTile` toggle, a row of 7 filter chips (年齢層/地域/飲酒/喫煙/趣味/特技/好き食 — age group, region, drinking, smoking, hobby, skill, favorite food — mapping 1:1 onto `users` fields), then a `GridView` of cast cards (name, verified icon, bio, like count). Embeds `ButtomNaviComp`. Strong schema alignment: `Collections.users` (listing+filters), `Collections.favorites`, `Collections.banners` (carousel). AppState candidates: `currentFilter`, `currentFilterName`, `searchCastKeyword`, `currentNotificationFilter`, `navIndex`.

**`cocomise_page.dart` (CocomisePage)** — Structural near-twin of HomePage, re-themed for browsing "ココ店" (Coco-ten) affiliated shops/venues. Sample grid data shows real restaurant names ("焼鳥 一鳥", "焼鳥 慶州園"). 7 cuisine-genre filter chips (和食/洋食/和洋食/イタ飯/韓食/中華/その他) map to `CocotenShopsFields.genre`/`tags`. Strong candidates: `Collections.cocotenShops`, `Collections.banners`, `Collections.favorites`. Also embeds `ButtomNaviComp`.

**`maccha_page.dart` (MacchaPage)** — Social "match/pairing" feed, header "すべてのマッチャ" (All Matcha/Matches). 5 sample `Card` items (avatar, name, relative timestamp "5 分前", title placeholder). No `ON_TAP` on individual cards in this snapshot, but tap-to-open into `MacchaChats` is the clear intended action. Binds conceptually to `Collections.macchas` joined with `Collections.users`.

**`maccha_chats.dart` (MacchaChats)** — 1:1 Guest↔Cast chat thread, drill-down from MacchaPage. AppBar: back chevron + tappable header image (no search/notification icons — a detail page, not a top-level tab). Body: two-party header ("ゲスト"/"キャスト" avatars), message list (alternating sender layout), bottom composer with send icon (`ON_TAP` — the concrete chat-send action). Binds conceptually to `Collections.chats`/`messages`/`chatRooms`. No bottom-nav embedded (confirms it's a stacked detail screen).

**`cast_profile.dart` (CastProfile)** — Detailed Cast profile page — the clearest booking-flow evidence, ending in two invite CTAs. AppBar: back + header image, "お知らせ" icon (no search — detail page). Body: 5-slide photo-gallery carousel (per-photo like/bookmark), self-introduction section, then **"誘う" (Invite) / "ココ店で誘う" (Invite at a Coco-ten shop)** CTA row, then a 3-tab `TabBar`: **プロフ** (Profile — attribute grid: nickname/gender/drinking/hobby/occupation/region/age-group/smoking/skill/favorite-food, matching `Collections.users` fields), **フォト** (Photo — 8-image grid, likely `users.gallery_images`), **予定表** (Schedule — a `Calendar` widget, plausibly `Collections.scheduleSlots`). No triggers are populated on the invite buttons in this snapshot, but by cross-reference with `reservation_form.dart`'s "お誘いフォーム" (Invitation Form) title/fields, these CTAs are the entry point into the booking flow.

**Synthesis**: HomePage and CocomisePage are parallel discovery surfaces (Cast vs. Shop) sharing an identical layout skeleton. MacchaPage/MacchaChats form a lightweight social matching + messaging subsystem (list → drill-down chat). CastProfile is the shared convergence point that both discovery and chat plausibly lead into, terminating in the two invite buttons that hand off to `reservation_form.dart`.

### 5.3 Booking / Payment / Staff Management

**`work_page.dart` (WorkPage)** — Staff/gig job-board and social feed. AppBar: "お知らせ"/"フィルタ" icons. Body: "すべてのワーク" job-post feed (4 sample cards, avatar+name+timestamp+title), then a promo/recruit section listing 4 staff categories: **イコッチャガールズ** (Icoccha Girls), **イコッチャボーイズ** (Icoccha Boys), **セキュリティ要員** (Security staff), **送迎要員** (Transport/pickup staff) — each described as a way to earn money in free time. Only `ON_INIT_STATE` is wired at the root; no card/button `ON_TAP` in this snapshot. Categories map conceptually to `reservations.staff_ids`/`staff_fee`/`transport_fee`.

**`affiliate.dart` (Affiliate)** — Referral/affiliate-earnings dashboard. Cards: **紹介コード** (referral code, with copy icon `ON_TAP`), **アフィリエイト詳細** (personal reward rate, team size, active/inactive member counts), **アフィリエイト実績** (worked hours/days by period), **アフィリエイト報酬** (rewards by day/week/month/cumulative, plus a **報酬管理**/payout-eligibility sub-section and an "申請する"/Apply button — unwired). `FloatingActionButton` "マイQR" (`ON_TAP`, opens QR/share sheet). Field set matches `Collections.affiliateRewards` precisely (rate %, reward-by-period, payout status). Reached from `my_page.dart`'s drawer item "集客・シェア".

**`my_page.dart` (MyPage)** — Cast/staff account hub. AppBar: logo, "お知らせ", "メニュー" (opens Drawer, `ON_TAP`). Body: profile card (avatar, name, last-login, demographics, verification/phone/likes status chips, rating), a "プロフィール編集"/"ワーク編集" button row (unwired), an info-tile row (Terms/Guidelines/Q&A), a 3-tab `TabBar` (details table / 5×3 photo grid / availability calendar — same attribute vocabulary as CastProfile), and `ButtomNaviComp`. `Drawer`: avatar/name/email header + 7 menu rows forming the app's IA map — **アカウント・基本管理**, **ワーク・活動管理**, **報酬・売上・決済管理**, **集客・シェア** (→ Affiliate), **対人・実績管理**, **サポート・法的項目**, **システム・情報**. FAB "マイQR" (same as Affiliate). `ON_INIT_STATE` loads profile data.

**`profile_edit.dart` (ProfileEdit)** — Profile-editing form (nickname, gender dropdown, region dropdowns, age bracket, drinking, hobby-type, skill, occupation, favorite food, one-line message, self-introduction, "プロフィールを保存する" save button). **Zero triggers anywhere in this file** — fully static mockup. Entered from MyPage's "プロフィール編集" button.

**`reservation_form.dart` (ReservationForm)** — "お誘いフォーム" (Invitation Form), the entry point of the booking flow. Fields: date (icon-only picker), time-slot dropdown, interaction-duration dropdown, interaction-start-time dropdown, extension-planned dropdown, destination-address field, meeting-point field, group-invite toggle + desired-group-size dropdown, purpose dropdown (e.g. meal), detailed-content text field. Field set maps closely onto `Collections.reservations` (`date`, `time_slot`, `duration_minutes`, `location`, `meeting_point`, `group_invite`, `group_size`, `details`, `guest_id`). Bottom button is oddly labeled **"合流報告"** ("meetup report") — inconsistent with a fresh-booking submit action, likely a reused/mis-set label carried over from `reservation_detail.dart`. Only the back-icon is wired; the submit button and all fields are unwired.

**`reservation_detail.dart` (ReservationDetail)** — The richest lifecycle-management screen: status pill ("承認待ち"/pending approval), **予約の情報** card (date/time/location/reward), **相手の情報** card (counterpart's profile + rating), **リクエストメッセージ** card (purpose + free-text message), then action-button rows: **お誘いを承認する/お誘いを断る** (approve/decline), **合流報告** (meetup check-in), **完了報告** (completion check-out), **評価する** (rate), **キャンセルする** (cancel). None of the lifecycle buttons are wired in this snapshot — only the header back/logo tap. Maps onto `reservations.status`, `cancel_reason`/`cancelled_by`, `guest_id`, `staff_fee`, etc.

**`reservation_confirmed.dart` (ReservationConfirmed)** — Interstitial success screen post-submission: "予約が確定しました" (reservation confirmed) / "キャストの承認をお待ちください" (awaiting cast approval). Summary card shows status pill "確認中" (under confirmation). Footer buttons "マッチャを確認する" (check Maccha — likely deep-links into the chat/matching feature) and "ホームに戻る" (return home). **No triggers anywhere in this file** — completely static, including both footer buttons.

**`payment_confirm.dart` (PaymentConfirm)** — Payment/checkout screen. **予約詳細** card (date/time, location, price breakdown: base fee, taxi fee, "30分ルール適用"/30-minute rule applied, total). **お支払方法** card (register-card button, or a registered-card summary with masked number/CVC and a "変更する"/change button). Footer "予約を確定する" (confirm reservation) submit CTA. Trust badge: **"Stripe社決済による安全な決済"** (secure payment via Stripe — explicit Stripe branding). Maps onto `Collections.payments` (`client_secret`, `payment_intent_id` — confirms a Stripe PaymentIntent-based checkout flow). **No triggers anywhere in this file** — entirely static, including the primary submit button.

**`extension_payment.dart` (ExtensionPayment)** — The in-session time-extension upsell — **the single most fully-wired page in the app**. **延長時間を選択** card (extension-minutes dropdown, `ON_FORM_WIDGET_SELECTED`). **延長利用料金** card (usage-time-slot context line, bound extension-time/fee values, tax/total breakdown). Footer "延長申請する" submit button — **has `ON_TAP` wired**. This is the only page with a non-empty `State` class: `ExtensionPaymentState` declares `baseAmount`(Integer), `extensionMinutes`(Integer), `priceResult`(**JSON**), `taxAmount`(Integer), `timeSlot`(String), `totalAmount`(Integer) — the `priceResult: JSON` field strongly implies a backend/cloud-function call fires on dropdown selection and returns a structured pricing payload. Maps onto `Collections.extensionPayments`/`extensions`.

**`review_pending.dart` (ReviewPending)** — **Not a customer-review screen** — a **KYC/identity-document review waiting gate** shown to a newly-signed-up cast/staff applicant post-KYC-submission. "ただいま審査中です..." (currently under review), "書類の審査には1〜2営業日かかります" (document review takes 1–2 business days). Only action: **"ログアウト"** (log out, `ON_TAP` wired) plus logo tap (`ON_TAP`). The most fully-interactive page in this group relative to its size (2/2 interactive elements wired).

**Synthesis**: The booking+payment core runs `reservation_form` (guest fills details) → `reservation_confirmed` (awaiting-approval interstitial, links toward Maccha chat) → `reservation_detail` (approve/decline/check-in/check-out/rate/cancel) → `payment_confirm` (Stripe PaymentIntent checkout) → `extension_payment` (in-session upsell, settled via Stripe/`payment_intent_id`, the only page with real computed state and a working action chain). Surrounding this: `work_page` (staff-recruitment feed across 4 categories), `affiliate` (referral dashboard, matches `affiliate_rewards` schema precisely), `my_page` (account hub + drawer IA map) with `profile_edit` as its edit counterpart, and `review_pending` (KYC-gate screen). Structurally this is an early/mockup build stage: most transactional buttons (submit reservation, confirm payment, approve/decline, save profile, register card) carry no wired action-chain triggers — only `extension_payment`'s dropdown+submit, a handful of navigation icons/FABs, and `review_pending`'s logout button are actually interactive. Several screens contain placeholder/duplicated label artifacts ("Hello World" prices in `payment_confirm`, a "場所" field showing a date/status string in `reservation_confirmed`, a reused "合流報告" button label on `reservation_form`).

---

## 6. Components (8)

All 8 share the same generated shape (`ComponentHandle` subclass: params, state, widgets tree, `paramTypes` map) and **all have empty `paramTypes`** — none expose typed input parameters; they're purely visual/logic reuse at this stage, taking only the universal `name`/`visible` instance params.

- **`affiliate_qr_code_bottom_sheet`** (root `Container_g1dwsqxg`) — bottom sheet for inviting friends via QR code ("友人＆知人を招待する"); contains a `Barcode` widget and a row of 4 tappable share-channel images. Inner container/form is named `ResetPassword`/`ResetPasswordForm` — an apparent copy-paste naming remnant.
- **`buttom_navi_comp`** (root `Container_drmhamut`) — the 5-tab bottom nav bar: ホーム/ココ店/マッチャ/ワーク/マイペ. Each tab is a `ConditionalBuilder` with selected/unselected `PlaceholderWidget` branches wrapping an `Icon`+`Text` `Column` (`ON_TAP`).
- **`registration_popup_comp`** (root `Container_upfy08ih`) — guest-signup nag popup ("新規登録に進む"/Proceed to registration, `ON_TAP`; "キャンセル"/Cancel, `ON_TAP`).
- **`reset_password_bottom_sheet`** (root `Container_2vowomff`) — password-reset-via-email bottom sheet (`ResetPasswordEmailField` + "送信する"/Send button, `ON_TAP`).
- **`work_filter_select_comp`** (root `Container_lpg8ixuw`, name `Work_filter_selectComp`) — filter-selection dropdown for the Work listing (`ON_FORM_WIDGET_SELECTED`).
- **`nottification_filter_dialog_comp`** (root `Container_vuda36v0`) — notification filter dropdown + a preview list of filtered notification items below it.
- **`search_cast_dialog_comp`** (root `Container_hbxgol8e`) — keyword search dialog for cast, with a text field + "検 索"(Search) button (`ON_TAP`).
- **`search_shop_dialog_comp`** (root `Container_6qutcmle`) — near-identical twin of the cast search dialog, for shops.

---

## 7. Workspace Edit Patterns (`patterns/`, 7 files)

Small standalone `App`-mutating snippets demonstrating one DSL editing idiom each:

- **`edit_add_trigger.dart`** — attaches a new `ON_LONG_PRESS` handler (showing a snackbar) to an existing `Button` via `page.ensureActions(...)`.
- **`edit_bind_button_text.dart`** — ensures a string state field, then binds a button's text to it via `page.bindText(...)`.
- **`edit_bind_button_visibility.dart`** — ensures a boolean state field, then binds a button's visibility via `page.bindVisible(...)`.
- **`edit_execute_action_block.dart`** — wires a button's `ON_TAP` to `ExecuteActionBlock(ActionBlock.named(...))` with params and `outputAs:` output capture.
- **`edit_single_existing_button.dart`** — combines state-field creation with the convenience helper `app.ensureButtonBindings(...)` to bind both text and visibility in one call.
- **`edit_textfield_onchange.dart`** — attaches `ON_TEXTFIELD_CHANGE` → `SetState(..., TextValue())` to live-sync a text field's value into state on every keystroke.
- **`edit_trigger_event.dart`** — the most elaborate: registers a local event handler (`AddLocalEventHandler`), fires a custom `TriggerEvent` with a struct payload, then tears the handler down (`CancelLocalEventHandler`) — the full lifecycle of a named custom App Event.

---

## 8. Cross-Cutting Risks & Inconsistencies

1. **Git is unscoped** — no repository dedicated to this project directory; `git status` reflects the entire home directory. Needs a proper `git init` at the project root before any commit workflow.
2. **Server-side payment logic is missing** — `callCreatePaymentIntent` calls a Cloud Function (`createPaymentIntent`, region `asia-northeast1`) that does not exist in the exported `firebase/functions/index.js` (which only defines a no-op `onUserDeleted` stub).
3. **Hardcoded Stripe test publishable key** committed directly in `confirm_stripe_payment.dart` custom-action source.
4. **`password_hash` stored directly on the `users` Firestore document** alongside Firebase Auth — redundant and a potential security liability if ever exposed via the (currently very open) Firestore read rules.
5. **Firestore rules are broadly open** — nearly every top-level collection allows `create`/`read` unconditionally with no role/claim gating; `chats` additionally allows open `write`. No composite indexes are defined at all.
6. **Schema typos live in production field names**: `reservations.res_ic` (should be `res_id`), `extension_payments.reservationld`/`userld` (should be `...Id`).
7. **`extension_payments` is a lone camelCase outlier** against an otherwise snake_case field-naming convention.
8. **Likely duplicate modeling**: `extensions` vs. `extension_payments` overlap in purpose but are structured inconsistently (one has no reservation link at all).
9. **Redundant reference pairs**: `work_post.poster_id`+`user_ref`; `chat_rooms.participants`+`users`; `reservations.cast_ids`+`staff_ids` (no distinguishing semantics documented).
10. **Zero schema documentation** — all 277 `description` fields across the entire schema are empty strings.
11. **Android package-path mismatch** — `MainActivity.kt` lives under `com/example/my_project/` while the actual `applicationId`/namespace is `com.mycompany.icoccha` (uncorrected FlutterFlow default leftover).
12. **Feature/dependency mismatches**: `LatLng` geopoint fields and a `place.dart` primitive exist with no maps SDK in `pubspec.yaml`; a full iOS push-notification image extension is wired with no FCM/push package present; a `rive_animations` asset folder exists with no Rive package installed.
13. **The auth/onboarding verification sub-flow (Phone → SMS → Email → AuthComplete → KYC → ReviewPending) is entirely non-functional** — every forward CTA in that chain is an unwired stub (`print('Button pressed ...')`), and Signup currently routes new users straight to HomePage, bypassing this chain entirely.
14. **Most transactional buttons across the booking/payment/profile pages are unwired** in this snapshot (submit reservation, confirm payment, approve/decline invitation, save profile, register card) — only `extension_payment.dart`'s dropdown+submit chain, a handful of nav icons/FABs, and `review_pending.dart`'s logout button are fully interactive.
15. **Placeholder/artifact content survives in several screens**: literal "Hello World" price values in `payment_confirm.dart`; a "場所" (location) field showing a date/status string instead of an address in `reservation_confirmed.dart`; a reused "合流報告" button label on `reservation_form.dart`'s submit button (copied from `reservation_detail.dart`); a hardcoded placeholder email address in `email_verification.dart`.
16. **Three separate identifiers for the same app** (FlutterFlow project id `icoccha-new-mockup-9a6ing`, generated pubspec name `icoccha_new_mockup`, Firebase project id `icoccha`) — not itself a bug, but worth keeping straight when cross-referencing configs.
