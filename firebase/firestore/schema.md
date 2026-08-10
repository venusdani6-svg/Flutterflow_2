# icoccha Firestore Schema Definition
# Version: 1.0 (MVP)
# Last updated: 2026-03-27

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
| referred_by_uid | string | 紹介者のUID (登録時のみ設定、変更不可) |
| affiliate_rate | number | アフィリエイト料率 (0.05 ~ 0.30) |
| consent_at | timestamp | 規約同意日時 |
| created_at | timestamp | アカウント作成日時 |
| updated_at | timestamp | 最終更新日時 |
| is_active | boolean | アカウント有効フラグ |
| is_frozen | boolean | アカウント凍結フラグ |
| blocked_users | array<string> | ブロックしたユーザーUIDs |
| admin_role | string | "super_admin" / "prefecture_admin" (管理者のみ) |
| admin_permissions | map | 機能別権限フラグ (管理者のみ) |
| managed_prefectures | array<string> | 管轄都道府県 (都道府県別管理者のみ) |

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

**Status values:**
- `request_pending` - リクエスト中 (与信確保待ち)
- `authorized` - 与信確保済み (requires_capture)
- `cast_pending` - キャスト承諾待ち
- `confirmed` - 確定決済済 (キャスト承諾)
- `waiting` - 合流待ち
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
| status | string | "authorized" / "captured" / "cancelled" |
| created_at | timestamp | 作成日時 |

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
Path: `/users/{uid}/favorites/{fav_id}`

| Field | Type | Description |
|-------|------|-------------|
| cast_id | string | キャストUID |
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
| created_at | timestamp | 作成日時 |

### 19. CocotenShops (ココ店)
Path: `/cocoten_shops/{shop_id}`

| Field | Type | Description |
|-------|------|-------------|
| name | string | 店舗名 |
| genre | string | ジャンル |
| tags | array<string> | タグ |
| address | string | 住所 |
| location | geopoint | 座標 |
| photos | array<string> | 写真URLs |
| menu | string | メニュー情報 |
| guest_benefits | string | ゲスト用特典 |
| active | boolean | 有効フラグ |
| created_at | timestamp | 作成日時 |

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
