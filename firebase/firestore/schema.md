# icoccha Firestore Schema Definition
# Version: 1.0 (MVP)
# Last updated: 2026-08-13 (drift reconciliation — see PROJECT_KNOWLEDGE.md §69/§77 for the audit trail; every addition below is confirmed against an actual writer in firebase/functions/src, not inferred)

## Collections Overview

### 1. Users (ユーザー)
Path: `/users/{uid}`

| Field | Type | Description |
|-------|------|-------------|
| uid | string | Firebase Auth UID |
| nickname | string | ニックネーム (2文字以上) |
| email | string | メールアドレス (重複不可) |
| phone | string | 電話番号 (SMS認証済み) |
| password_hash | string | (managed by Firebase Auth) |
| account_type | string | "guest" / "cast" |
| role | string | "user" / "admin" |
| role_admin | string | Alternate admin-gate field, "admin" — `verifyAdmin`/`verifyAdminV1` accept `role`, `role_admin`, OR `roleAdmin` interchangeably (drift confirmed 2026-08, no single canonical field) |
| roleAdmin | string | Same as `role_admin` above — third accepted spelling, not a typo, both checked in code |
| staff_type | string | "none" / "security" / "transport" / "both" |
| gender | string | 性別 |
| occupation | string | 職業 |
| birth_date | timestamp | 生年月日 |
| age_group | string | 年齢層 (自動算出) |
| prefecture | string | 居住地域・都道府県 |
| city | string | 居住地域・市区町村 |
| activity_prefecture | string | 活動エリア・都道府県 |
| activity_city | string | 活動エリア・市区町村 |
| drinking | string | "飲む" / "少し飲む" / "乾杯程度" / "全く飲めない" |
| smoking | string | "吸う" / "電子タバコ" / "全く吸わない" |
| hobbies | string | 趣味 |
| skills | string | 特技 |
| favorite_food_tags | array<string> | 好きな食べ物タグ |
| atmosphere | string | 雰囲気 (キャストのみ) |
| one_line_message | string | 一言メッセージ (15文字) |
| self_introduction | string | 自己紹介文 (500文字) |
| profile_image_url | string | プロフィール写真URL |
| gallery_images | array<string> | ギャラリー写真URLs (最大10枚) |
| desired_interaction | string | 希望する交流内容 (ゲスト) |
| offered_interaction | string | 提供可能な交流内容 (キャスト) |
| is_online | boolean | オンラインフラグ |
| last_login_at | timestamp | 最終ログイン日時 |
| location | geopoint | 現在地/代表点座標 |
| is_verified | boolean | 本人確認済みフラグ |
| kyc_status | string | "pending" / "submitted" / "approved" / "rejected" |
| kyc_doc_url | string | 本人確認書類URL |
| kyc_selfie_url | string | 顔写真URL |
| approval_status | string | "pending" / "approved" / "rejected" |
| individual_rate | number | 個別報酬率 (0.5 ~ 0.7) |
| logical_debt | number | 論理負債 (円単位, integer) |
| stripe_account_id | string | Stripe Connected Account ID |
| stripe_customer_id | string | Stripe Customer ID (ゲスト用) |
| is_stripe_restricted | boolean | Stripe Connectアカウントが `Restricted` 状態かどうか。`account.updated` Webhookが同期 (§6 defect #4) |
| fcm_token | string | ネイティブプッシュ通知用FCMデバイストークン。2026-08-14実装、クライアント側`registerFcmToken`（dsl/edit.dart）が権限許可時に書き込み、サーバー側`sendPushNotification`（config.ts）が読み取ってプッシュ送信。無効化されたトークンは自動的にクリアされる |
| stripe_onboarding_submitted_at | timestamp | `submitConnectOnboarding` 呼び出し日時 (§6 defect #5) |
| stripe_charges_enabled | boolean | Stripe `Account.charges_enabled` のミラー |
| stripe_payouts_enabled | boolean | Stripe `Account.payouts_enabled` のミラー |
| stripe_requirements_due | array\<string\> | Stripe `Account.requirements.currently_due` のミラー (アプリ内オンボーディングUIの進捗チェックリスト用) |
| referred_by_uid | string | 紹介者のUID (登録時のみ設定、変更不可) |
| affiliate_rate | number | アフィリエイト料率 (0.05 ~ 0.30) |
| consent_at | timestamp | 規約同意日時 |
| created_at | timestamp | アカウント作成日時 |
| updated_at | timestamp | 最終更新日時 |
| is_active | boolean | アカウント有効フラグ |
| is_frozen | boolean | アカウント凍結フラグ |
| left_at | timestamp | 退会日時 (`requestWithdrawal`/`adminForceDeleteUser`が設定) |
| frozen_at | timestamp | 凍結日時 (`adminToggleFreeze`が設定) |
| blocked_users | array<string> | ブロックしたユーザーUIDs |
| admin_role | string | "super_admin" / "prefecture_admin" (管理者のみ・未使用、将来拡張用に予約) |
| admin_permissions | map | 機能別権限フラグ (管理者のみ・未使用、将来拡張用に予約) |
| managed_prefectures | array<string> | 管轄都道府県 (都道府県別管理者のみ・未使用、将来拡張用に予約) |
| is_agreed | boolean | クライアント側 (`signup_page_widget.dart`) が直接書き込む同意フラグ。**Cloud Functionからは一切読まれない** — 実際の同意ゲートは`completeOnboarding`の`consent_agreed`引数由来の`consent_at`のみ。混同注意 (vestigial, 2026-08確認) |
| agreed_at | timestamp | 上記`is_agreed`と同様、クライアント側のみが書き込み、バックエンドは未使用 |

### 2. Reservations (予約)
Path: `/reservations/{res_id}`

| Field | Type | Description |
|-------|------|-------------|
| res_id | string | 予約ID (auto-generated) |
| guest_id | string | ゲストUID |
| cast_ids | array<string> | キャストUIDs |
| staff_ids | array<string> | スタッフUIDs |
| status | string | see Status values below |
| date | timestamp | 予約日時 |
| time_slot | string | 時間帯 (1部/2部/3部/4部) |
| duration_minutes | number | 予定時間 (分) |
| location | string | 交流場所 |
| meeting_point | string | 待ち合わせ場所 |
| location_address | string | 交流場所住所 (no guest-facing input yet; admin-dashboard-editable via `adminUpdateReservationLocation`) |
| meeting_point_address | string | 待ち合わせ場所住所 (no guest-facing input yet; admin-dashboard-editable via `adminUpdateReservationLocation`) |
| group_invite | boolean | グループお誘い希望 |
| group_size | number | グループ希望人数 |
| cast_responses | map<string,string> | キャストUIDごとの応答状況 ("pending"/"accepted"/"declined")。全員が"accepted"になって初めてグループ予約が"confirmed"になる (2026-08追加、複数キャスト予約の個別承諾トラッキング用) |
| needs_security | boolean | 警備スタッフを希望（未手配の場合のみtrue） |
| needs_transport | boolean | 送迎スタッフを希望（未手配の場合のみtrue） |
| guest_confirmed_meetup | boolean | ゲスト側の合流確認フラグ (`confirmMeetup`が両者一致で書き込み) |
| cast_confirmed_meetup | boolean | キャスト側の合流確認フラグ (`confirmMeetup`が両者一致で書き込み) |
| details | string | 内容詳細 (300文字) |
| base_amount | number | 基本料金 |
| transport_fee | number | タクシー代 (0 or 5000) |
| staff_fee | number | スタッフ費用 |
| total_amount | number | 決済総額 |
| extension_count | number | 延長回数 (max 3) |
| total_hours | number | 総時間 (max 6h) |
| payment_intent_id | string | Stripe PaymentIntent ID |
| transfer_group | string | Stripe transfer_group |
| last_capture_at | timestamp | 最終売上確定日時 |
| thirty_min_rule_applied | boolean | 30分ルール適用済み |
| cancel_reason | string | キャンセル理由 |
| cancelled_by | string | "guest" / "cast" / "admin" |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

**Status values (re-verified 2026-08 by grepping every literal `status: "..."` write across the whole backend — only these 9 are ever actually written; `cast_pending`/`waiting` documented below were never real and are removed):**
- `request_pending` - リクエスト中 (与信確保待ち)
- `authorized` - 与信確保済み (requires_capture)
- `confirmed` - 確定決済済 (キャスト承諾)
- `in_progress` - 交流中
- `completion_pending` - 完了報告待ち
- `review_pending` - 評価待ち (capture実行済み)
- `completed` - 完了
- `cancelled` - キャンセル
- `expired` - 期限切れ

### 3. ExtensionPayments (延長決済)
Path: `/reservations/{res_id}/extensions/{ext_id}`

| Field | Type | Description |
|-------|------|-------------|
| ext_id | string | 延長ID |
| payment_intent_id | string | Stripe PaymentIntent ID |
| amount | number | 延長料金 |
| duration_minutes | number | 延長時間 |
| slot_start | timestamp | この延長分の予約枠開始時刻（元予約開始 + それまでの延長分）。`schedule_slots`ロックの起点として使用 (2026-08追加) |
| status | string | "authorized" / "captured" / "cancelled" |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 (`captureAuthorizedExtensions`/`cancelExtensionPayment`が書き込み) |

### 4. Ledger (台帳)
Path: `/ledger/{ledger_id}`

| Field | Type | Description |
|-------|------|-------------|
| ledger_id | string | 台帳ID |
| res_id | string | 予約参照ID |
| user_id | string | 対象ユーザーID |
| type | string | "reward" / "staff_fee" / "refund" / "affiliate" / "debt_offset" / "tip" |
| gross_amount | number | 決済総額 |
| cast_reward | number | キャスト報酬 |
| staff_fee | number | スタッフ費用 |
| stripe_fee | number | Stripe手数料 |
| platform_profit | number | 運営利益 |
| tax_amount | number | 消費税額 |
| net_transfer | number | 送金実額 |
| amount | number | 金額 |
| stripe_event_id | string | Stripe Event ID |
| stripe_object_id | string | Stripe Object ID |
| status | string | "pending" / "confirmed" / "failed" / "retrying" |
| processed | boolean | 処理済みフラグ |
| created_at | timestamp | 作成日時 |

### 5. DebtHistory (負債履歴)
Path: `/debt_history/{id}`

`firestore.rules`: `allow read: if isAdmin() || (isSignedIn() && resource.data.user_id == request.auth.uid)` — 管理者は全ユーザー分を直接クライアントクエリで読み取り可能 (`LedgerOversightPage`)。本人は自分の分のみ (`WalletPage`)。

| Field | Type | Description |
|-------|------|-------------|
| user_id | string | 対象ユーザーID |
| amount | number | 金額 |
| reason | string | 理由 |
| res_id | string | 関連予約ID |
| created_at | timestamp | 作成日時 |

### 6. ScheduleSlots (スケジュール枠)
Path: `/schedule_slots/{slot_id}`

| Field | Type | Description |
|-------|------|-------------|
| cast_id | string | キャストUID |
| date | timestamp | 日付 |
| start_at | timestamp | 開始時刻 |
| end_at | timestamp | 終了時刻 |
| status | string | "available" / "unavailable" / "reserved" |
| res_id | string | ロックの原因となった予約ID (`reserved`時のみ設定、`autoReleaseOrphanedSlots`が参照) |

### 7. PairHistory (ペア履歴)
Path: `/pair_history/{pair_key}`

| Field | Type | Description |
|-------|------|-------------|
| pair_key | string | ゲストID_キャストID |
| guest_id | string | ゲストUID |
| cast_id | string | キャストUID |
| last_capture_at | timestamp | 最終確定日時 |
| interaction_count | number | 交流回数 |

### 8. SystemConfig (システム設定)
Path: `/system_config/settings`

| Field | Type | Description |
|-------|------|-------------|
| chat_close_sec | number | チャット閉鎖秒数 |
| transport_fee_threshold_sec | number | 30分ルール閾値 (1800) |
| transport_fee_amount | number | タクシー代 (5000) |
| extension_limit_count | number | 延長上限回数 (3) |
| max_total_hours | number | 最大総時間 (6) |
| tax_rate | number | 消費税率 |
| default_cast_rate | number | デフォルト報酬率 |
| security_staff_fee | number | セキュリティスタッフ報酬額（デフォルト） |
| transport_staff_fee | number | 送迎スタッフ報酬額（デフォルト） |
| default_affiliate_rate | number | デフォルトアフィリエイト料率 (0.05) |
| affiliate_min_days | number | アフィリエイト最低稼働日数 (3) |
| affiliate_payment_day | number | アフィリエイト支払日 (5) |
| service_areas | array<map> | サービスエリア一覧 (name, prefecture, active) |
| night_time_slots | array<string> | 深夜帯 (3部/4部) |
| cancel_fee_rates | map | キャンセル料率設定 |
| features_enabled | map | 機能ON/OFFフラグ (affiliate, staff, cocoten, work_board, gps) |

### 9. ChatRooms (チャットルーム)
Path: `/chat_rooms/{room_id}`

| Field | Type | Description |
|-------|------|-------------|
| room_id | string | ルームID |
| res_id | string | 予約ID |
| participants | array<string> | 参加者UIDs |
| active | boolean | アクティブフラグ |
| last_message | string | 最新メッセージ本文 (`sendChatMessage`が書き込み、`getMyMatchaList`のプレビュー表示に使用) |
| last_message_time | timestamp | 最新メッセージ送信日時 |
| created_at | timestamp | 作成日時 |
| closed_at | timestamp | 閉鎖日時 |

### 10. ChatMessages (チャットメッセージ)
Path: `/chat_rooms/{room_id}/messages/{msg_id}`

| Field | Type | Description |
|-------|------|-------------|
| sender_id | string | 送信者UID |
| text | string | メッセージ本文 |
| read | boolean | 既読フラグ |
| read_at | timestamp | 既読日時 |
| created_at | timestamp | 送信日時 |

### 11. Reviews (評価・レビュー)
Path: `/reviews/{review_id}`

| Field | Type | Description |
|-------|------|-------------|
| res_id | string | 予約ID |
| reviewer_id | string | 評価者UID (ゲスト) |
| reviewee_id | string | 被評価者UID (キャスト) |
| rating | number | 星評価 (1-5) |
| comment | string | レビューコメント |
| created_at | timestamp | 作成日時 |

### 12. Favorites (お気に入り)
Path: `/users/{uid}/favorites/{cast_id}` (ドキュメントIDはキャストUID自体、`fav_id`という別IDは存在しない)

`firestore.rules`: `allow read, write: if false` — 直接クライアントアクセスは禁止、`addFavorite`/`removeFavorite`/`getFavoriteCasts`/`isCastFavorited` (auth.ts, Admin SDK) 経由のみ。

| Field | Type | Description |
|-------|------|-------------|
| cast_id | string | キャストUID (ドキュメントIDと同一) |
| created_at | timestamp | 登録日時 |

### 13. Notifications (通知)
Path: `/users/{uid}/notifications/{notif_id}`

| Field | Type | Description |
|-------|------|-------------|
| type | string | "matching" / "work" / "cocoten" / "stripe" / "admin" |
| title | string | 通知タイトル |
| body | string | 通知本文 |
| data | map | 追加データ (stripe raw data等) |
| read | boolean | 既読フラグ |
| created_at | timestamp | 作成日時 |

### 14. Reports (通報)
Path: `/reports/{report_id}`

| Field | Type | Description |
|-------|------|-------------|
| reporter_id | string | 通報者UID |
| reported_id | string | 被通報者UID |
| res_id | string | 関連予約ID |
| reason | string | 通報理由 |
| chat_log_ref | string | チャットログ参照 |
| status | string | "pending" / "reviewed" / "resolved" |
| admin_note | string | 管理者メモ |
| created_at | timestamp | 作成日時 |

### 15. StripeLogs (Stripeログ)
Path: `/stripe_logs/{log_id}`

| Field | Type | Description |
|-------|------|-------------|
| stripe_event_id | string | Stripe Event ID |
| event_type | string | イベントタイプ |
| res_id | string | 関連予約ID |
| raw_data | map | 生データ |
| created_at | timestamp | 作成日時 |
| ttl | timestamp | TTL (90日後に自動削除) |

### 16. ProcessedEvents (処理済みイベント)
Path: `/processed_events/{stripe_event_id}`

| Field | Type | Description |
|-------|------|-------------|
| event_type | string | イベントタイプ |
| processed_at | timestamp | 処理日時 |

### 17. AuditLogs (監査ログ)
Path: `/audit_logs/{log_id}`

| Field | Type | Description |
|-------|------|-------------|
| admin_id | string | 管理者UID |
| action | string | 操作内容 |
| target_type | string | 対象タイプ |
| target_id | string | 対象ID |
| details | map | 詳細 |
| reason | string | 理由 |
| created_at | timestamp | 作成日時 |

### 18. Banners (広告バナー)
Path: `/banners/{banner_id}`

| Field | Type | Description |
|-------|------|-------------|
| title | string | タイトル |
| image_url | string | 画像URL |
| link_url | string | リンク先URL |
| page | string | 表示ページ ("home" / "cocoten") |
| display_order | number | 表示順 |
| active | boolean | 有効フラグ |
| advertiser | string | 広告主名 |
| display_days | number | 表示日数 (0=無期限) |
| start_date | timestamp | 表示開始日時 |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 19. CocotenShops (ココ店)
Path: `/cocoten_shops/{shop_id}`

| Field | Type | Description |
|-------|------|-------------|
| name | string | 店舗名 |
| genre | string | ジャンル (`system_config/settings.cocoten_genres`マスタリストに対しサーバー側で検証、2026-08-14実装 — 実際のFlutterFlow側スキーマはこの1フィールドのみ) |
| prefecture | string | 都道府県 (実際の入力元フィールド。`address`はこれら4項目から自動生成) |
| city | string | 市区町村 |
| town_block | string | 町名番地 |
| building | string | 建物名 |
| address | string | 住所 (prefecture+city+town_block+buildingを結合して自動生成、2026-08修正 — 以前は常に空文字だった) |
| tags | array<string> | タグ — **未実装、書き込まれることはない** (disclosed gap) |
| location | geopoint | 座標 — **未実装、書き込まれることはない** (地図/ジオコーディング機能が存在しないため) |
| photos | string | 写真URL — 実際のFlutterFlow側スキーマは単一`ImagePath`型（このドキュメント旧版のarray<string>は誤り）。2026-08-14実装、Firebase Storage経由でアップロード、`cocoten_shops/{allPaths}`にadmin書き込み限定 |
| menu | string | メニュー情報 |
| guest_benefits | string | ゲスト用特典 |
| active | boolean | 有効フラグ |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 20. WorkPosts (お仕事掲示板)
Path: `/work_posts/{post_id}`

| Field | Type | Description |
|-------|------|-------------|
| poster_id | string | 投稿者UID |
| res_id | string | 関連予約ID |
| type | string | "partner_recruit" / "security" / "transport" |
| description | string | 詳細 |
| date | timestamp | 日時 |
| location | string | 場所 |
| fee | number | 報酬 |
| status | string | "open" / "filled" / "closed" |
| applicants | array<string> | 応募者UIDs |
| selected_id | string | 採用者UID |
| created_at | timestamp | 作成日時 |

### 21. AffiliateRewards (アフィリエイト報酬)
Path: `/affiliate_rewards/{id}`

| Field | Type | Description |
|-------|------|-------------|
| affiliator_uid | string | アフィリエイターUID |
| referred_uid | string | 紹介キャストUID |
| res_id | string | 関連予約ID |
| base_amount | number | 計算母数 (タクシー代除外後) |
| rate | number | 適用料率 |
| reward_amount | number | 報酬額 |
| month | string | 対象月 (YYYY-MM) |
| status | string | "pending" / "approved" / "paid" / "forfeited" |
| paid_at | timestamp | 支払日時 |
| created_at | timestamp | 作成日時 |
