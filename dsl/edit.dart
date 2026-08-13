library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';
import 'package:icoccha_new_mockup_9a6ing/flutterflow_project.dart' as ff;


Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  try {
    await flutterFlowAI(
      buildStarterEditFlow,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      projectName: options.projectName,
      projectId: options.projectId,
      findOrCreate: options.findOrCreate,
      allowNewProject: options.allowNewProject,
      dryRun: options.dryRun,
      commitMessage: options.commitMessage,
    );
  } catch (error) {
    stderr.writeln('Error: ${formatFlutterFlowAIError(error)}');
    exit(1);
  }
}

final class _CliOptions {
  const _CliOptions({
    this.apiKey,
    this.baseUrl,
    this.projectName,
    this.projectId,
    this.findOrCreate = false,
    this.allowNewProject = false,
    this.dryRun = false,
    this.commitMessage,
  });

  final String? apiKey;
  final String? baseUrl;
  final String? projectName;
  final String? projectId;
  final bool findOrCreate;
  final bool allowNewProject;
  final bool dryRun;
  final String? commitMessage;
}

_CliOptions _parseCliOptions(List<String> args) {
  String? apiKey;
  String? baseUrl;
  String? projectName;
  String? projectId;
  String? commitMessage;
  var findOrCreate = false;
  var allowNewProject = false;
  var dryRun = false;

  for (var i = 0; i < args.length; i++) {
    final arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        _printUsage();
        exit(0);
      case '--api-key':
        apiKey = _requireValue(args, ++i, '--api-key');
      case '--base-url':
        baseUrl = _requireValue(args, ++i, '--base-url');
      case '--project-name':
        projectName = _requireValue(args, ++i, '--project-name');
      case '--project-id':
        projectId = _requireValue(args, ++i, '--project-id');
      case '--commit-message':
        commitMessage = _requireValue(args, ++i, '--commit-message');
      case '--find-or-create':
        findOrCreate = true;
      case '--allow-new-project':
        allowNewProject = true;
      case '--dry-run':
        dryRun = true;
      default:
        stderr.writeln('Unknown option: $arg');
        _printUsage();
        exit(64);
    }
  }

  return _CliOptions(
    apiKey: apiKey,
    baseUrl: baseUrl,
    projectName: projectName,
    projectId: projectId,
    findOrCreate: findOrCreate,
    allowNewProject: allowNewProject,
    dryRun: dryRun,
    commitMessage: commitMessage,
  );
}

String _requireValue(List<String> args, int index, String flag) {
  if (index >= args.length) {
    stderr.writeln('Missing value for $flag.');
    _printUsage();
    exit(64);
  }
  return args[index];
}

void _printUsage() {
  stdout.writeln('''
Run the starter FlutterFlow AI edit flow.

Usage:
  dart run dsl/edit.dart [options]

Options:
  --api-key <key>           FlutterFlow API key. Defaults to FF_API_KEY.
  --base-url <url>          Override the FlutterFlow API base URL.
  --project-name <name>     Create a new project with this name.
  --project-id <id>         Push into an existing project by ID.
  --find-or-create          Retry by reusing a same-name project before creating.
  --allow-new-project       Bypass the workspace binding guard and create a different project.
  --commit-message <text>   Commit message for the push.
  --dry-run                 Compile and validate without pushing.
  --help, -h                Show this help.
''');
}

// ---------------------------------------------------------------------------
// Phase 1 schema remediation helpers (IMPLEMENTATION_PLAN.md §5).
//
// `addCollectionField`/`updateCollectionField`/`removeCollectionField`/
// `updateCollection`/`addCollection` in the SDK's own
// `src/helpers/collection_helpers.dart` do exactly what's needed here, but
// are NOT exported from the public `flutterflow_ai.dart` barrel (confirmed
// via grep — only `removeCollection` is re-exposed, as `App.removeCollection`).
// Replicated below using only exported proto types (`FFCollection`/
// `FFParameter`/`FFIdentifier`/`FFDataTypeV2`, `generateRandomAlphaNumericString`
// — all re-exported via `flutterflow_schema.dart`'s own `schema_extensions.dart`/
// `flutterflow.pb.dart` exports) — same pattern this project's own
// `.cursor/rules/project_rules.md` already documents for the analogous
// data-struct case (`updateDataStruct` etc. aren't exported either).
// Every helper below is a no-op on rerun (checks current state before
// mutating), so this whole block is safe to leave live/rerun.
// ---------------------------------------------------------------------------

FFCollection _findCollection(FFProject project, String name) {
  for (final c in project.backend.collections.values) {
    if (c.identifier.name == name) return c;
  }
  throw StateError('No collection named "$name" found.');
}

FFParameter? _findFieldOrNull(FFCollection coll, String fieldName) {
  for (final f in coll.fields.values) {
    if (f.identifier.name == fieldName) return f;
  }
  return null;
}

void _renameField(
  FFProject project,
  String collectionName,
  String oldName,
  String newName,
) {
  final coll = _findCollection(project, collectionName);
  if (_findFieldOrNull(coll, newName) != null) return; // already renamed
  final field = _findFieldOrNull(coll, oldName);
  if (field == null) return; // nothing to rename (already gone/renamed)
  field.identifier.name = newName;
}

void _retypeField(
  FFProject project,
  String collectionName,
  String fieldName,
  FFDataTypeV2 type,
) {
  final coll = _findCollection(project, collectionName);
  final field = _findFieldOrNull(coll, fieldName);
  if (field == null) return;
  field.dataType = type;
}

void _addField(
  FFProject project,
  String collectionName,
  String fieldName,
  FFDataTypeV2 type, {
  String description = '',
}) {
  final coll = _findCollection(project, collectionName);
  if (_findFieldOrNull(coll, fieldName) != null) return; // already added
  final key = generateRandomAlphaNumericString();
  coll.fields[key] = FFParameter(
    identifier: FFIdentifier(name: fieldName, key: key),
    dataType: type,
    description: description,
  );
}

void _removeField(FFProject project, String collectionName, String fieldName) {
  final coll = _findCollection(project, collectionName);
  String? keyToRemove;
  for (final entry in coll.fields.entries) {
    if (entry.value.identifier.name == fieldName) {
      keyToRemove = entry.key;
      break;
    }
  }
  if (keyToRemove == null) return; // already removed
  coll.fields.remove(keyToRemove);
}

void _renameCollection(FFProject project, String oldName, String newName) {
  final alreadyRenamed = project.backend.collections.values.any(
    (c) => c.identifier.name == newName,
  );
  if (alreadyRenamed) return;
  final collections = project.backend.collections;
  for (final c in collections.values) {
    if (c.identifier.name == oldName) {
      c.identifier.name = newName;
      return;
    }
  }
  // Neither old nor new name found — nothing to do (already handled, or the
  // collection genuinely doesn't exist; either way, not an error to guard
  // a reran script against).
}

void _removeCollectionByName(FFProject project, String name) {
  final collections = project.backend.collections;
  String? keyToRemove;
  for (final entry in collections.entries) {
    if (entry.value.identifier.name == name) {
      keyToRemove = entry.key;
      break;
    }
  }
  if (keyToRemove == null) return; // already removed
  collections.remove(keyToRemove);
}

void _newCollection(
  FFProject project,
  String name,
  Map<String, FFDataTypeV2> fields, {
  String description = '',
}) {
  final exists = project.backend.collections.values.any(
    (c) => c.identifier.name == name,
  );
  if (exists) return; // already created
  final collectionKey = generateRandomAlphaNumericString();
  final fieldMap = <String, FFParameter>{};
  for (final entry in fields.entries) {
    final fieldKey = generateRandomAlphaNumericString();
    fieldMap[fieldKey] = FFParameter(
      identifier: FFIdentifier(name: entry.key, key: fieldKey),
      dataType: entry.value,
    );
  }
  final collection = FFCollection(
    identifier: FFIdentifier(name: name, key: collectionKey),
    description: description,
  );
  collection.fields.addAll(fieldMap);
  project.backend.collections[collectionKey] = collection;
}

FFDataTypeV2 get _string => FFDataTypeV2(scalarType: FFBaseDataType.String);
FFDataTypeV2 get _bool_ => FFDataTypeV2(scalarType: FFBaseDataType.Boolean);
FFDataTypeV2 get _int_ => FFDataTypeV2(scalarType: FFBaseDataType.Integer);
FFDataTypeV2 get _double_ => FFDataTypeV2(scalarType: FFBaseDataType.Double);
FFDataTypeV2 get _dateTime =>
    FFDataTypeV2(scalarType: FFBaseDataType.DateTime);
FFDataTypeV2 get _json => FFDataTypeV2(scalarType: FFBaseDataType.JSON);
FFDataTypeV2 _listOf(FFDataTypeV2 inner) => FFDataTypeV2(listType: inner);

/// Walks an existing native trigger chain (recursing into both
/// `followUpAction` and `conditionActions`' true/false branches — a linear
/// `while (hasFollowUpAction())` walk alone silently misses anything nested
/// inside a conditional, a real landmine this project's own inherited SDK
/// quirks document) and repoints any `Navigate` action whose target
/// currently matches [fromPageKey] to [toPageKey] instead. Used to fix
/// SignupPage's existing multi-step native chain (validate -> password
/// check -> createAccountWithEmail -> Firestore write -> Navigate ->
/// Snackbar) without reproducing — and risking silently dropping — any of
/// its other real logic.
void _retargetNavigate(
  FFActionNode node, {
  required String fromPageKey,
  required String toPageKey,
}) {
  if (node.hasAction() && node.action.hasNavigate()) {
    if (node.action.navigate.pageNodeKeyRef.key == fromPageKey) {
      node.action.navigate.pageNodeKeyRef.key = toPageKey;
    }
  }
  if (node.hasFollowUpAction()) {
    _retargetNavigate(
      node.followUpAction,
      fromPageKey: fromPageKey,
      toPageKey: toPageKey,
    );
  }
  if (node.hasConditionActions()) {
    for (final t in node.conditionActions.trueActions) {
      if (t.hasTrueAction()) {
        _retargetNavigate(
          t.trueAction,
          fromPageKey: fromPageKey,
          toPageKey: toPageKey,
        );
      }
    }
    if (node.conditionActions.hasFalseAction()) {
      _retargetNavigate(
        node.conditionActions.falseAction,
        fromPageKey: fromPageKey,
        toPageKey: toPageKey,
      );
    }
  }
}

/// Type reference to an already-declared Enum, by name — mirrors
/// `data_type_helpers.dart`'s own `enumType(FFIdentifier)`, which (like
/// `collection_helpers.dart`) is not exported from the public barrel.
/// Looks the enum up live in `project.backend.dataSchemaConfig.enums` (same
/// field path `data_schema_helpers.dart`'s own `removeEnum` uses) instead of
/// needing a pre-known key — an `EnumHandle` returned from `app.enum_(...)`
/// carries no key at all (only `name`/`description`/`values`), so the real
/// server-assigned `FFIdentifier` is only discoverable this way, once the
/// declaring push has landed.
FFDataTypeV2 _enumTypeOf(FFProject project, String enumName) {
  for (final e in project.backend.dataSchemaConfig.enums) {
    if (e.identifier.name == enumName) {
      return FFDataTypeV2(
        scalarType: FFBaseDataType.Enum,
        subType: FFSubType(enumIdentifier: e.identifier),
      );
    }
  }
  throw StateError('No enum named "$enumName" found.');
}

void buildStarterEditFlow(App app) {
  // ==========================================================================
  // Phase 1 — Data model remediation (IMPLEMENTATION_PLAN.md §5)
  //
  // Confirmed hard prerequisite for the onboarding/reservation UI work this
  // edit flow builds toward (see PROJECT_KNOWLEDGE.md for the full
  // writeup): the Cloud Functions backend (firebase/functions/, deployed
  // earlier this session) already reads/writes the CORRECTED field names
  // below — `nickname` not `display_name`, `phone` not `phone_number`,
  // `res_id` not `res_ic`, `work_posts` not `work_post`, `affiliator_uid`
  // not `affiliate_uid`, plus two reservation fields
  // (`guest_confirmed_meetup`/`cast_confirmed_meetup`) that don't exist in
  // the schema at all yet. Converging the FlutterFlow schema onto the
  // backend's real names, per §5's own stated "ground truth" methodology —
  // not the other way around.
  //
  // Deliberate deviations from §5's own text, both confirmed against the
  // real backend source before deciding, not guessed:
  //   - §5 item 4 (promote `guest_id`/`cast_ids` to typed DocumentReference)
  //     is SKIPPED — every Cloud Function in this backend reads/writes
  //     these as plain strings; converting them would break the backend,
  //     not fix the schema.
  //   - §5 item 10 (drop `users.category_ref`) needs no action — the field
  //     was never actually present in this project's live schema at all
  //     (confirmed against PROJECT_ANALYSIS.md's own full 51-field
  //     inventory), only in the client's spec document. Nothing to remove.
  //   - §5 items 14/15 (Firestore composite indexes, security rules
  //     rewrite) are ALREADY DONE — via `firebase/firestore.indexes.json`
  //     (35 indexes) and `firebase/firestore.rules` (tiered, role-gated),
  //     both deployed earlier this session through the separate `firebase
  //     deploy` workflow, independent of this DSL.
  //   - `audit_logs.target_type` and full `work_post.user_ref` cleanup are
  //     deferred — admin-panel-only concerns (Phase 12), not blocking this
  //     pass's actual work (onboarding + reservation UI).
  // ==========================================================================

  // -- 9 new Enums for every closed-vocabulary field this pass touches.
  // ONE-SHOT declarative call (like app.collection/app.component) —
  // confirmed landed via `flutterflow ai inspect` (all 9 present with their
  // real value sets), commented out per this project's own established
  // "comment out once confirmed landed" discipline for exactly this class
  // of call. Left here, uncommented, it would throw
  // `ensureEnum found an existing enum named "..." with a different
  // payload`-style errors on every future push touching this file.
  //
  // app.enum_(
  //   'ReservationStatus',
  //   [
  //     'request_pending',
  //     'authorized',
  //     'confirmed',
  //     'in_progress',
  //     'completion_pending',
  //     'review_pending',
  //     'completed',
  //     'cancelled',
  //     'expired',
  //   ],
  //   description: '予約ステータス（バックエンド実装済みの実際の値セット）',
  // );
  // app.enum_('UserRole', ['user', 'admin'], description: 'ユーザー権限区分');
  // app.enum_(
  //   'UserAccountType',
  //   ['guest', 'cast'],
  //   description: 'アカウント種別（ゲスト/キャスト）',
  // );
  // app.enum_(
  //   'KycStatus',
  //   ['pending', 'submitted', 'approved', 'rejected'],
  //   description: '本人確認書類の審査ステータス',
  // );
  // app.enum_(
  //   'ApprovalStatus',
  //   ['pending', 'approved', 'rejected'],
  //   description: 'アカウント審査ステータス',
  // );
  // app.enum_(
  //   'StaffType',
  //   ['none', 'security', 'transport', 'both'],
  //   description: 'スタッフ副業種別（§3.1.7）',
  // );
  // app.enum_(
  //   'AffiliateRewardStatus',
  //   ['pending', 'paid', 'forfeited'],
  //   description: 'アフィリエイト報酬ステータス',
  // );
  // app.enum_(
  //   'LedgerEntryType',
  //   ['reward', 'staff_fee', 'extension', 'tip', 'affiliate', 'refund'],
  //   description: '台帳エントリ種別（バックエンドの実際の値セット）',
  // );
  // app.enum_(
  //   'PayoutRequestStatus',
  //   ['pending', 'approved', 'on_hold', 'rejected'],
  //   description: '出金申請ステータス',
  // );

  app.raw((project) {
    // -- 1. Known typo fix --
    _renameField(project, 'reservations', 'res_ic', 'res_id');

    // -- 2. Additional renames confirmed against the real backend source --
    _renameCollection(project, 'work_post', 'work_posts');
    _renameField(project, 'affiliate_rewards', 'affiliate_uid', 'affiliator_uid');
    _renameField(project, 'users', 'display_name', 'nickname');
    _renameField(project, 'users', 'phone_number', 'phone');

    // -- 5. system_config: fix shapes to match what the backend's
    // SYSTEM_DEFAULTS (firebase/functions/src/config.ts) actually reads,
    // and add the fields it expects that don't exist in the schema yet --
    _retypeField(project, 'system_config', 'tax_rate', _double_);
    _retypeField(project, 'system_config', 'default_cast_rate', _double_);
    _retypeField(project, 'system_config', 'default_affiliate_rate', _double_);
    _retypeField(project, 'system_config', 'service_areas', _json);
    _retypeField(project, 'system_config', 'cancel_fee_rates', _json);
    _addField(
      project,
      'system_config',
      'security_staff_fee',
      _int_,
      description: '警備スタッフ固定報酬（円）。旧一律 staff_fee を役割別に分割。',
    );
    _addField(
      project,
      'system_config',
      'transport_staff_fee',
      _int_,
      description: '送迎スタッフ固定報酬（円）。旧一律 staff_fee を役割別に分割。',
    );
    _addField(
      project,
      'system_config',
      'features_enabled',
      _json,
      description: '機能フラグのマップ。',
    );

    // -- 8. reservations: the two meetup-confirm booleans confirmMeetup()
    // (firebase/functions/src/reservations.ts) already reads/writes --
    _addField(
      project,
      'reservations',
      'guest_confirmed_meetup',
      _bool_,
      description: 'ゲストが合流確認をタップ済みか。',
    );
    _addField(
      project,
      'reservations',
      'cast_confirmed_meetup',
      _bool_,
      description: 'キャストが合流確認をタップ済みか。',
    );

    // -- users: Stripe Connect onboarding mirror fields (this session's own
    // §6 defect #5 backend work — see PROJECT_KNOWLEDGE.md §6) --
    _addField(
      project,
      'users',
      'is_stripe_restricted',
      _bool_,
      description: 'Stripe Connectアカウントが restricted 状態か。account.updated Webhookが同期。',
    );
    _addField(
      project,
      'users',
      'stripe_onboarding_submitted_at',
      _dateTime,
      description: 'submitConnectOnboarding呼び出し日時。',
    );
    _addField(
      project,
      'users',
      'stripe_charges_enabled',
      _bool_,
      description: 'Stripe Account.charges_enabled のミラー。',
    );
    _addField(
      project,
      'users',
      'stripe_payouts_enabled',
      _bool_,
      description: 'Stripe Account.payouts_enabled のミラー。',
    );
    _addField(
      project,
      'users',
      'stripe_requirements_due',
      _listOf(_string),
      description: 'Stripe Account.requirements.currently_due のミラー。',
    );

    // -- 12. password_hash: redundant with Firebase Auth, a real liability
    // given this project's own openly-readable-document history --
    _removeField(project, 'users', 'password_hash');

    // -- 11. chat_rooms.users: confirmed dead weight — the real backend
    // only ever writes `participants` (reservations.ts's respondToReservation) --
    _removeField(project, 'chat_rooms', 'users');

    // -- 11. extensions/extension_payments reconciliation: confirmed via
    // direct grep that firebase/functions/src/*.ts only ever references
    // `reservations/{res_id}/extensions` (a subcollection, already
    // snake_case) — `extension_payments` (top-level, the schema's sole
    // camelCase-keyed outlier) is never referenced anywhere in the real
    // backend. Converting `extensions` to a genuine subcollection and
    // dropping the unused duplicate, rather than carrying both forward. --
    final reservationsId = _findCollection(project, 'reservations').identifier;
    _findCollection(project, 'extensions').parentCollectionIdentifier =
        reservationsId;
    _removeCollectionByName(project, 'extension_payments');

    // -- 7. New collections the real backend already reads/writes but the
    // schema never had --
    _newCollection(
      project,
      'payout_requests',
      {
        'user_id': _string,
        'status': _string, // enum-ified in the follow-up push
        'created_at': _dateTime,
        'updated_at': _dateTime,
      },
      description: '出金申請（§6 defect #9 — requestPayout が作成、admin側が承認/却下）。',
    );
    _newCollection(
      project,
      'affiliate_rate_history',
      {
        'affiliator_uid': _string,
        'old_rate': _double_,
        'new_rate': _double_,
        'changed_by_admin_id': _string,
        'changed_at': _dateTime,
      },
      description: 'アフィリエイト料率変更履歴（管理画面の手動レート変更を記録）。',
    );
  });

  // ==========================================================================
  // Phase 1, push 2 — wire the 9 Enums above onto their target collection
  // fields, now that they're live and discoverable by name via
  // `_enumTypeOf` (see its own doc comment for why this couldn't happen in
  // the same push as the declarations). Idempotent: `_retypeField` just
  // reassigns `dataType`, safe to rerun.
  // ==========================================================================
  app.raw((project) {
    _retypeField(
      project,
      'reservations',
      'status',
      _enumTypeOf(project, 'ReservationStatus'),
    );
    _retypeField(project, 'users', 'role', _enumTypeOf(project, 'UserRole'));
    _retypeField(
      project,
      'users',
      'account_type',
      _enumTypeOf(project, 'UserAccountType'),
    );
    _retypeField(
      project,
      'users',
      'kyc_status',
      _enumTypeOf(project, 'KycStatus'),
    );
    _retypeField(
      project,
      'users',
      'approval_status',
      _enumTypeOf(project, 'ApprovalStatus'),
    );
    _retypeField(
      project,
      'users',
      'staff_type',
      _enumTypeOf(project, 'StaffType'),
    );
    _retypeField(
      project,
      'affiliate_rewards',
      'status',
      _enumTypeOf(project, 'AffiliateRewardStatus'),
    );
    _retypeField(
      project,
      'ledger',
      'type',
      _enumTypeOf(project, 'LedgerEntryType'),
    );
    _retypeField(
      project,
      'payout_requests',
      'status',
      _enumTypeOf(project, 'PayoutRequestStatus'),
    );
  });

  // ==========================================================================
  // Phase 2 — Auth & onboarding completion (IMPLEMENTATION_PLAN.md §3.1,
  // §8 Phase 2). Wires the previously 100%-stub verification chain
  // (Signup -> Email -> Phone -> SMS -> AuthComplete) and adds the missing
  // BasicInfoRegistration page, connecting through to the already-existing
  // Kyc page (Kyc's own content is wired separately, a later task).
  // ==========================================================================

  // -- New custom actions this chain needs. Declared via `app.customAction`
  // (NOT the brownfield `addCustomAction` inside `app.raw` — tried that
  // first; `compileDslApp` failed with `No custom action named "..." found
  // in the project`, since a page built via `app.ensurePage` in the SAME
  // script run is compiled before `app.raw`-queued mutations are applied,
  // so a raw-added action isn't visible yet when the page's own
  // `CallCustomAction.named(...)` references are validated. Declarative
  // `app.customAction` runs in the same declarative pass as pages instead,
  // and — per its own doc comment — tolerates an identical rerun as a
  // no-op, only a changed payload throws; still commented out below once
  // confirmed landed, matching this project's standard one-shot discipline.
  // Referenced elsewhere in this file by NAME via `CallCustomAction.named`
  // (not by capturing the returned handle) — string lookups compile fine
  // per the handle's own doc comment, and this avoids threading 5 handle
  // variables through every page-wiring block below.
  //
  // The Cloud-Function-calling one follows the exact pattern already proven
  // in this project's own callCreatePaymentIntent/confirmStripePayment
  // custom actions (FirebaseFunctions.instanceFor(...).httpsCallable(...)
  // .call({})) — there is no native typed-DSL action for calling a Cloud
  // Function directly (confirmed — actions.dart has no Callable/
  // CloudFunction class).
  app.customAction(
    'sendFirebaseEmailVerification',
    returns: bool_,
    description: 'Firebase Authの確認メールを送信する。',
    code: r'''
Future<bool> sendFirebaseEmailVerification() async {
  try {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) return false;
    await user.sendEmailVerification();
    return true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'checkEmailVerified',
    returns: bool_,
    description: '現在のユーザーのメール認証状態を再読み込みして確認する。',
    code: r'''
Future<bool> checkEmailVerified() async {
  final user = FirebaseAuth.instance.currentUser;
  if (user == null) return false;
  await user.reload();
  return FirebaseAuth.instance.currentUser?.emailVerified ?? false;
}
''',
  );

  // Reuses this project's own already-generated `authManager.beginPhoneAuth`
  // (lib/auth/firebase_auth/firebase_auth_manager.dart) for the SEND step —
  // its onCodeSent/codeSent callback machinery already correctly stores the
  // verificationId on `authManager.phoneAuthManager`. Deliberately does NOT
  // reuse its paired `verifySmsCode` for the VERIFY step below — that
  // method calls `signInWithCredential`, which would sign in as a
  // separate/new identity instead of linking the phone number onto the
  // guest's already-authenticated email/password account.
  app.customAction(
    'sendPhoneVerificationCode',
    args: {'phoneNumber': string},
    returns: bool_,
    includeContext: true,
    description: '携帯電話番号にSMS認証コードを送信する（Firebase Phone Auth）。',
    code: r'''
import '/auth/firebase_auth/auth_util.dart';

Future<bool> sendPhoneVerificationCode(
  BuildContext context,
  String? phoneNumber,
) async {
  if (phoneNumber == null || phoneNumber.isEmpty) return false;
  await authManager.beginPhoneAuth(
    context: context,
    phoneNumber: phoneNumber,
    onCodeSent: (context) {},
  );
  return authManager.phoneAuthManager.phoneAuthError == null;
}
''',
  );

  // Original declaration frozen — content now maintained via the
  // `updateCustomAction` call below (this action already landed in an
  // earlier push; `app.customAction(...)` compiles to `ensureCustomAction`,
  // create-if-missing only, so a further edit here would be permanently
  // inert — established rule, see `callUpdateProfile`'s own identical
  // comment elsewhere in this file).
  //   app.customAction(
  //     'verifyPhoneCodeAndLink',
  //     args: {'smsCode': string},
  //     returns: bool_,
  //     description: 'SMS認証コードを確認し、ログイン中のアカウントに電話番号をリンクする。',
  //     code: r'''
  // import '/auth/firebase_auth/auth_util.dart';
  // import 'package:flutter/foundation.dart';
  //
  // Future<bool> verifyPhoneCodeAndLink(String? smsCode) async {
  //   if (smsCode == null || smsCode.isEmpty) return false;
  //   if (kIsWeb) {
  //     return false;
  //   }
  //   final verificationId =
  //       authManager.phoneAuthManager.phoneAuthVerificationCode;
  //   final currentUser = FirebaseAuth.instance.currentUser;
  //   if (verificationId == null || currentUser == null) return false;
  //   try {
  //     final credential = PhoneAuthProvider.credential(
  //       verificationId: verificationId,
  //       smsCode: smsCode,
  //     );
  //     await currentUser.linkWithCredential(credential);
  //     return true;
  //   } catch (e) {
  //     return false;
  //   }
  // }
  // ''',
  //   );

  // FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide review):
  // added a forced ID-token refresh right after a successful link. Firebase
  // Auth only adds the `phone_number` custom claim to the ID token once
  // it's refreshed post-link — without this, the very next backend call
  // (callSyncVerifiedPhone, below) would read a stale token with no
  // phone_number claim yet, and silently no-op.
  app.raw((project) {
    updateCustomAction(
      project,
      name: 'verifyPhoneCodeAndLink',
      code: r'''
import '/auth/firebase_auth/auth_util.dart';
import 'package:flutter/foundation.dart';

Future<bool> verifyPhoneCodeAndLink(String? smsCode) async {
  if (smsCode == null || smsCode.isEmpty) return false;
  if (kIsWeb) {
    // Web's ConfirmationResult.confirm() signs in directly rather than
    // yielding a linkable credential - safely linking an already
    // signed-in (email/password) account to a phone number on web needs
    // further work. Mobile (this app's real target platform) is fully
    // supported below.
    return false;
  }
  final verificationId =
      authManager.phoneAuthManager.phoneAuthVerificationCode;
  final currentUser = FirebaseAuth.instance.currentUser;
  if (verificationId == null || currentUser == null) return false;
  try {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
    await currentUser.linkWithCredential(credential);
    // Force a token refresh so the phone_number custom claim is present
    // for the immediately-following callSyncVerifiedPhone call.
    await currentUser.getIdToken(true);
    return true;
  } catch (e) {
    return false;
  }
}
''',
    );
  });

  // Thin wrapper matching this file's own established minimal-call pattern
  // (see callUpdateProfilePhoto) — persists the just-verified phone number
  // server-side via syncVerifiedPhone (auth.ts), which reads it from the
  // ID token's own phone_number claim rather than trusting a client value.
  // Best-effort by design (returns false on any failure, never throws) —
  // called right after a successful link; a sync failure shouldn't block
  // the guest's own onboarding progress.
  app.customAction(
    'callSyncVerifiedPhone',
    returns: bool_,
    description: '確認済み電話番号をサーバー側に反映する（syncVerifiedPhone呼び出し）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSyncVerifiedPhone() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('syncVerifiedPhone');
    final result = await callable.call();
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Plain bool return (not a struct/json) so the caller can branch on it
  // directly via `If(ActionOutput(...), ...)` with no FieldAccess at all —
  // this project's own established, lower-risk pattern for a json-typed
  // Cloud Function response that only needs success/fail branching, not
  // per-field inspection (see .cursor/rules/project_rules.md's own
  // "skip inspecting entirely, treat as opaque" quirk).
  // consent_agreed is hardcoded true here deliberately: this action is
  // only ever reached from BasicInfoRegistration's submit button after
  // `checkBasicInfoFieldsComplete` (below) already confirmed it — that
  // combined gate replaced this button's original bare
  // `If(State('consentAgreed'), ...)` check 2026-08-10, see that
  // action's own comment for why (adding required-field validation
  // couldn't be a 3rd nested `If` — this DSL's confirmed 2-level nesting
  // ceiling — so field-completeness and consent were combined into one
  // gate instead of adding a second, separately-nested one).
  app.customAction(
    'callCompleteOnboarding',
    args: {
      'accountType': string,
      'gender': string,
      'birthDate': string,
      'prefecture': string,
      'city': string,
      'activityPrefecture': string,
      'activityCity': string,
      'staffType': string,
      'referralCode': string,
    },
    returns: bool_,
    description: 'completeOnboarding Cloud Functionを呼び出し、基本情報を登録する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callCompleteOnboarding(
  String? accountType,
  String? gender,
  String? birthDate,
  String? prefecture,
  String? city,
  String? activityPrefecture,
  String? activityCity,
  String? staffType,
  String? referralCode,
) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('completeOnboarding');
    final result = await callable.call({
      'account_type': accountType ?? '',
      'gender': gender ?? '',
      'birth_date': birthDate ?? '',
      'prefecture': prefecture ?? '',
      'city': city ?? '',
      'activity_prefecture': activityPrefecture ?? '',
      'activity_city': activityCity ?? '',
      'staff_type': staffType ?? 'none',
      'referral_code': referralCode ?? '',
      'consent_agreed': true,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Real, confirmed gap found 2026-08-10, during a full re-analysis pass:
  // BasicInfoRegistration's submit button had NO field-completeness check
  // at all before calling callCompleteOnboarding — only consent was
  // gated (`If(State('consentAgreed'), then: [callCompleteOnboarding...])`).
  // A guest could submit with every field empty (or `birthDate` a
  // non-calendar string) as long as the checkbox was ticked. Worse than a
  // simple missing-field bug: `auth.ts`'s own `completeOnboarding` does
  // `const birthDate = new Date(birth_date); const age = now.getFullYear()
  // - birthDate.getFullYear();` with NO validation of its own — a
  // malformed/empty birth_date makes `age` become `NaN`, and EVERY
  // comparison in the `if (age < 20) ... else` chain is false for NaN, so
  // it silently falls through to the LAST branch (`ageGroup = "60歳以上"`)
  // with no error thrown at all — a confirmed SILENT WRONG-DATA bug, not
  // just a UX gap. Combines field-completeness AND consent into ONE gate
  // (rather than 2 separately-nested `If`s) because this DSL's own
  // confirmed nesting ceiling is 2 levels (fieldsAndConsentOk wrapping the
  // api-result check) — a 3rd level (fields wrapping consent wrapping
  // api-result) is the exact shape that failed compilation earlier this
  // session (KycSubmitButton's own 3-level attempt, documented in
  // `.cursor/rules/project_rules.md`). Reuses the same `_isValidIsoDate`
  // calendar-validity check as `checkReservationFieldsComplete`/
  // `checkConnectFieldsComplete` above (duplicated inline rather than
  // shared — this DSL's custom actions are independently compiled, no
  // shared-helper mechanism established in this project).
  //
  // Deliberately does NOT validate `activityPrefecture`/`activityCity`/
  // `staffType`/`referralCode` as required — the page's own native field
  // labels mark them "（任意）" (optional), and `callCompleteOnboarding`
  // already defaults each to '' / 'none' if absent.
  app.customAction(
    'checkBasicInfoFieldsComplete',
    args: {
      'accountType': string,
      'gender': string,
      'birthDate': string,
      'prefecture': string,
      'city': string,
      'consentAgreed': bool_,
    },
    returns: bool_,
    description: '基本情報登録に必要な必須項目の入力済みと利用規約への同意を確認する。',
    code: r'''
bool _isValidIsoDate(String? value) {
  if (value == null) return false;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (m == null) return false;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  if (mo < 1 || mo > 12) return false;
  final dt = DateTime(y, mo, d);
  return dt.year == y && dt.month == mo && dt.day == d;
}

Future<bool> checkBasicInfoFieldsComplete(
  String? accountType,
  String? gender,
  String? birthDate,
  String? prefecture,
  String? city,
  bool? consentAgreed,
) async {
  if (consentAgreed != true) return false;
  if (accountType == null || accountType.isEmpty) return false;
  if (gender == null || gender.isEmpty) return false;
  if (prefecture == null || prefecture.isEmpty) return false;
  if (city == null || city.isEmpty) return false;
  return _isValidIsoDate(birthDate);
}
''',
  );

  // -- New App State field carrying the phone number across the
  // PhoneVarification -> SmsCode page navigation (page-local State does
  // not survive a page change; App State does). One-shot declarative —
  // confirmed landed (present in lib/flutterflow_project/app_state.dart),
  // commented out per this project's standard one-shot discipline.
  // app.state(
  //   'verificationPhoneNumber',
  //   string.withDefault(''),
  // );

  // -- 1. Fix the priority-one correctness bug: Signup routes straight to
  // Home today, bypassing the entire verification chain entirely
  // (confirmed via generated_code/lib/auth/signup_page/signup_page_widget.dart:
  // `context.pushNamedAuth(HomePageWidget.routeName, ...)`). Retarget the
  // EXISTING native submit button's Navigate step IN PLACE (walking its
  // real trigger chain) rather than reproducing the whole chain via
  // ensureActions, which would silently discard its real logic (password
  // match check, createAccountWithEmail, the Firestore isAgreed/agreedAt
  // write, the success Snackbar) — never ensureActions/ensureReplaced over
  // a node with existing meaningful triggerActions, per this project's own
  // inherited SDK quirks.
  app.editPage(ff.Pages.signupPage, (page) {
    page.mutateNode(page.findByKey('Button_s8s3l7kd'), (node) {
      if (node.triggerActions.isNotEmpty) {
        _retargetNavigate(
          node.triggerActions.first.rootAction,
          fromPageKey: 'Scaffold_8oxh5zcd', // HomePage
          toPageKey: 'Scaffold_mf05al90', // EmailVerification
        );
      }
    });
  });

  // -- 2. Email verification: send on page load, real verified-check on
  // "次へ". Both triggers had zero existing triggerActions (confirmed via
  // the typed SDK — no `triggers` entry at all on either the page root or
  // the button), so ensureActions is safe to use directly here.
  app.editPage(ff.Pages.emailVerification, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'sendFirebaseEmailVerification',
          outputAs: 'sendVerificationResult',
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Button_1cqh1sb0'), // 次へ
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'checkEmailVerified',
          outputAs: 'emailVerifiedResult',
        ),
        If(
          ActionOutput('emailVerifiedResult'),
          then: [Navigate('PhoneVarification')],
          orElse: [
            Snackbar('まだ認証が完了していません。メール内のリンクをご確認ください。'),
          ],
        ),
      ],
    );
  });

  // -- 3. Phone verification: real SMS send. Button had zero existing
  // triggerActions.
  app.editPage(ff.Pages.phoneVarification, (page) {
    page.ensureActions(
      page.findByKey('Button_sx7fi9pe'), // SMSを送信する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        UpdateAppState.set(
          ff.AppState.verificationPhoneNumber,
          WidgetState(
            ff.Pages.phoneVarification.widgets.byKey('TextField_lns0u7l7').single,
            WidgetStateProperty.text,
          ),
        ),
        CallCustomAction.named(
          'sendPhoneVerificationCode',
          arguments: {
            'phoneNumber': WidgetState(
              ff.Pages.phoneVarification.widgets
                  .byKey('TextField_lns0u7l7')
                  .single,
              WidgetStateProperty.text,
            ),
          },
          outputAs: 'sendSmsResult',
        ),
        If(
          ActionOutput('sendSmsResult'),
          then: [Navigate('SmsCode')],
          orElse: [Snackbar('SMS送信に失敗しました。番号をご確認ください。')],
        ),
      ],
    );
  });

  // -- 4. SMS code verification. The 6 dash "ー" boxes in this page's
  // native design (Card_qcaxhffj) are static decorative placeholders, not
  // real input fields (confirmed via the typed SDK — no TextField anywhere
  // in that subtree) — this DSL has no clean primitive for a multi-box
  // auto-advancing PIN input (no cross-field auto-focus mechanism found),
  // so replacing that Card's content with one real TextField for the code,
  // a disclosed, function-over-form trade-off rather than attempting to
  // fake the box UI without real input behind it. ensureReplaced — one-shot,
  // CONFIRMED LANDED (SmsCodeCard/SmsCodeField exist in the live project) —
  // frozen 2026-08-10 per this file's own one-shot discipline (an
  // uncommented ensureReplaced re-runs and re-replaces on every future
  // full-script push; see project_rules.md's extensively documented
  // "never-commented-out ensureReplaced" failure mode). The later reference
  // to `SmsCodeField` below (WidgetState, a name-based value expression, not
  // a page.findByName node locator) keeps working unchanged since the
  // widget already exists live.
  //   app.editPage(ff.Pages.smsCode, (page) {
  //     page.ensureReplaced(
  //       page.findByKey('Card_qcaxhffj'),
  //       Card(
  //         name: 'SmsCodeCard',
  //         child: Container(
  //           padding: 16,
  //           child: TextField(
  //             label: 'SMS認証コード',
  //             hint: '6桁のコードを入力',
  //             keyboard: Keyboard.number,
  //             name: 'SmsCodeField',
  //           ),
  //         ),
  //       ),
  //     );
  //   });
  app.editPage(ff.Pages.smsCode, (page) {
    page.ensureActions(
      page.findByKey('Button_ynhflo1r'), // 認証する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'verifyPhoneCodeAndLink',
          arguments: {
            'smsCode': WidgetState('SmsCodeField', WidgetStateProperty.text),
          },
          outputAs: 'verifyPhoneResult',
        ),
        If(
          ActionOutput('verifyPhoneResult'),
          then: [
            // FIX (PROJECT_KNOWLEDGE.md §71): persist the just-verified
            // phone number server-side. Best-effort, no branch on its own
            // result — a sync failure shouldn't block onboarding progress
            // for a guest who already successfully verified their phone.
            CallCustomAction.named(
              'callSyncVerifiedPhone',
              outputAs: 'syncPhoneResult',
            ),
            Navigate('AuthComplete'),
          ],
          orElse: [Snackbar('認証コードが正しくありません。')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Button_lo5jbbia'), // 認証コードを再送する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'sendPhoneVerificationCode',
          arguments: {'phoneNumber': AppState(ff.AppState.verificationPhoneNumber)},
          outputAs: 'resendSmsResult',
        ),
        If(
          ActionOutput('resendSmsResult'),
          then: [Snackbar('認証コードを再送しました。')],
          orElse: [Snackbar('再送に失敗しました。')],
        ),
      ],
    );
  });

  // -- 5. AuthComplete's "次へ" hands off to the new BasicInfoRegistration
  // page (built just below). Button had zero existing triggerActions.
  app.editPage(ff.Pages.authComplete, (page) {
    page.ensureActions(
      page.findByKey('Button_4asbej60'), // 次へ
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.basicInfoRegistration)],
    );
  });

  // -- 6. New page: BasicInfoRegistration (IMPLEMENTATION_PLAN.md §3.1 item
  // "BasicInfoRegistration" — genuinely missing, no native page existed for
  // this at all). Collects the fields completeOnboarding (already deployed
  // backend, this session's earlier work) expects, then hands off to the
  // existing Kyc page.
  //
  // CORRECTION: `app.ensurePage(...)` is idempotent in the sense that it
  // won't throw/duplicate on rerun, but its own compiler behavior (per
  // compiler.dart's `_compilePages`) is "leaves the body alone if the page
  // exists" — i.e. once created, this call's `body:`/`state:` content is
  // permanently INERT on every future run, not re-applied. Confirmed
  // 2026-08-10: this page's own body used raw string State/SetState
  // references that compiled fine on the FIRST push (page didn't exist
  // yet), then failed the NEXT push with `Use
  // ff.Pages.basicInfoRegistration.state.x instead of State("x")` — a
  // preflight validation pass checks these references regardless of
  // whether the compiler will actually apply the body. Since the body is
  // inert either way once the page exists, the fix is the same one-shot
  // discipline as every other declarative call in this file: comment out
  // once confirmed landed (already verified via generated_code/ in the
  // previous push) — any FUTURE change to this page's own content must go
  // through `app.editPage(ff.Pages.basicInfoRegistration, ...)` instead,
  // same as any other already-existing page.
  //   app.ensurePage(
  //     'BasicInfoRegistration',
  //     route: '/basic-info-registration',
  //     description: '新規登録後の基本情報入力ページ（アカウント種別・性別・生年月日・地域など）。completeOnboardingを呼び出す。',
  //     state: {
  //       'accountType': string.withDefault('guest'),
  //       'gender': string.withDefault(''),
  //       'birthDate': string.withDefault(''),
  //       'prefecture': string.withDefault(''),
  //       'city': string.withDefault(''),
  //       'activityPrefecture': string.withDefault(''),
  //       'activityCity': string.withDefault(''),
  //       'staffType': string.withDefault('none'),
  //       'referralCode': string.withDefault(''),
  //       'consentAgreed': bool_.withDefault(false),
  //     },
  //     body: Scaffold(
  //       appBar: AppBar(title: '基本情報の登録'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         scrollable: true,
  //         children: [
  //           Text('基本情報を入力してください', style: Styles.titleLarge),
  //           Dropdown(
  //             label: 'アカウント種別',
  //             options: const ['guest', 'cast'],
  //             value: State('accountType'),
  //             onChanged: SetState('accountType', const WidgetValue()),
  //           ),
  //           Dropdown(
  //             label: '性別',
  //             options: const ['男性', '女性', '回答しない'],
  //             value: State('gender'),
  //             onChanged: SetState('gender', const WidgetValue()),
  //           ),
  //           TextField(
  //             label: '生年月日',
  //             hint: '例: 1995-06-15',
  //             name: 'BirthDateField',
  //             onChanged: SetState('birthDate', const TextValue()),
  //           ),
  //           TextField(
  //             label: '都道府県',
  //             name: 'PrefectureField',
  //             onChanged: SetState('prefecture', const TextValue()),
  //           ),
  //           TextField(
  //             label: '市区町村',
  //             name: 'CityField',
  //             onChanged: SetState('city', const TextValue()),
  //           ),
  //           TextField(
  //             label: '活動都道府県（任意）',
  //             name: 'ActivityPrefectureField',
  //             onChanged: SetState('activityPrefecture', const TextValue()),
  //           ),
  //           TextField(
  //             label: '活動市区町村（任意）',
  //             name: 'ActivityCityField',
  //             onChanged: SetState('activityCity', const TextValue()),
  //           ),
  //           Dropdown(
  //             label: '副業スタッフ種別',
  //             options: const ['none', 'security', 'transport', 'both'],
  //             value: State('staffType'),
  //             onChanged: SetState('staffType', const WidgetValue()),
  //             visible: Equals(State('accountType'), 'cast'),
  //           ),
  //           TextField(
  //             label: '紹介コード（任意）',
  //             name: 'ReferralCodeField',
  //             onChanged: SetState('referralCode', const TextValue()),
  //           ),
  //           Row(
  //             spacing: 8,
  //             children: [
  //               Checkbox(
  //                 value: State('consentAgreed'),
  //                 onChanged: SetState('consentAgreed', const WidgetValue()),
  //                 name: 'ConsentCheckbox',
  //               ),
  //               Text('利用規約・個人情報の取り扱いに同意します'),
  //             ],
  //           ),
  //           Button(
  //             '登録する',
  //             width: double.infinity,
  //             color: Colors.primary,
  //             textColor: Colors.primaryBackground,
  //             name: 'SubmitBasicInfoButton',
  //             onTap: [
  //               If(
  //                 State('consentAgreed'),
  //                 then: [
  //                   CallCustomAction.named(
  //                     'callCompleteOnboarding',
  //                     arguments: {
  //                       'accountType': State('accountType'),
  //                       'gender': State('gender'),
  //                       'birthDate': State('birthDate'),
  //                       'prefecture': State('prefecture'),
  //                       'city': State('city'),
  //                       'activityPrefecture': State('activityPrefecture'),
  //                       'activityCity': State('activityCity'),
  //                       'staffType': State('staffType'),
  //                       'referralCode': State('referralCode'),
  //                     },
  //                     outputAs: 'completeOnboardingResult',
  //                   ),
  //                   If(
  //                     ActionOutput('completeOnboardingResult'),
  //                     then: [Navigate('Kyc', replaceRoute: true)],
  //                     orElse: [Snackbar('登録に失敗しました。もう一度お試しください。')],
  //                   ),
  //                 ],
  //                 orElse: [Snackbar('利用規約への同意が必要です。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // ==========================================================================
  // Phase 2 continued — KYC submission (IMPLEMENTATION_PLAN.md §3.1 item 5,
  // manual-review path per §4.1's confirmed reading). `kyc.dart` had two
  // upload cards with static placeholder Image+Text content, no functioning
  // file picker at all, and NO submit button anywhere on the page (confirmed
  // via PROJECT_ANALYSIS.md's own inventory and the typed SDK read here).
  // ==========================================================================

  // -- Pub deps this needs. `image_picker` and `firebase_storage` were both
  // confirmed absent from this project's pubspec (PROJECT_ANALYSIS.md §2 —
  // "Notably absent: ... no image_picker"; firebase_storage wasn't in the
  // Firebase dependency block either). Versions picked by checking pub.dev
  // directly (not guessed) for compatibility with this project's EXACT,
  // hard-pinned `firebase_core: 3.14.0` (every Firebase package in this
  // pubspec is exact-pinned, not caret-ranged, matching FlutterFlow's own
  // generated convention) — firebase_storage 12.4.5 is the newest version
  // whose own `firebase_core: ^3.13.0` constraint 3.14.0 actually satisfies;
  // the current latest (13.4.6) needs `^4.13.0` and would have forced a
  // firebase_core major bump cascading through every other Firebase package
  // in this pubspec, which is exactly the kind of incidental dependency
  // bump this project's own rules say not to do.
  app.pubDependency('image_picker', '1.2.3');
  app.pubDependency('firebase_storage', '12.4.5');

  // -- Reusable upload action for both KYC images. Firestore Storage rules
  // (firebase/storage.rules, this session's own §5 work) gate writes to
  // `users/{uid}/...` to that same uid only — this action's own upload path
  // is built to match that exactly. NOTE (disclosed, not silently assumed
  // working): Firebase Storage itself is NOT YET PROVISIONED on this
  // project (confirmed via `firebase deploy --only storage` failing with
  // "Firebase Storage has not been set up on project ... Go to ... and
  // click 'Get Started'") — this is a one-time manual Console action the
  // user needs to take, plus a `firebase deploy --only storage` from
  // firebase/ afterward to push the updated rules above. The code here is
  // correct and ready either way; it will simply fail gracefully (returns
  // null, caller shows an error Snackbar) until that manual step is done.
  app.customAction(
    'pickAndUploadImage',
    args: {'fileNameSuffix': string},
    returns: string,
    description: '画像を選択してFirebase Storageにアップロードし、ダウンロードURLを返す。',
    code: r'''
import 'dart:io';
import 'package:image_picker/image_picker.dart';
import 'package:firebase_storage/firebase_storage.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String?> pickAndUploadImage(String? fileNameSuffix) async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return null;
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 85,
    );
    if (picked == null) return null;
    final suffix = (fileNameSuffix == null || fileNameSuffix.isEmpty)
        ? 'upload'
        : fileNameSuffix;
    final ref = FirebaseStorage.instance.ref(
      'users/$uid/${suffix}_${DateTime.now().millisecondsSinceEpoch}.jpg',
    );
    await ref.putFile(File(picked.path));
    return await ref.getDownloadURL();
  } catch (e) {
    return null;
  }
}
''',
  );

  // -- Cloud-Function-calling wrapper, same established pattern as
  // callCreatePaymentIntent/callCompleteOnboarding.
  app.customAction(
    'callSubmitKyc',
    args: {'docUrl': string, 'selfieUrl': string},
    returns: bool_,
    description: 'submitKYC Cloud Functionを呼び出し、本人確認書類を提出する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSubmitKyc(String? docUrl, String? selfieUrl) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('submitKYC');
    final result = await callable.call({
      'doc_url': docUrl ?? '',
      'selfie_url': selfieUrl ?? '',
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // `FFActionCondition.variable` (what `If(...)` compiles a condition
  // through) only accepts a COMPLETELY BARE stored-field variable — zero
  // operations attached, confirmed by this exact push failing with
  // "Conditional execution for action is improperly set" against
  // `If(Not(Equals(State('kycDocUrl'), '')), ...)` (an operation-bearing
  // condition: Equals + Not). Per this project's own inherited SDK quirks:
  // compute the check FULLY inside a preceding custom action instead, then
  // branch on its BARE `ActionOutput(...)` — the pattern already used
  // successfully everywhere else in this file (e.g.
  // `If(ActionOutput('emailVerifiedResult'), ...)`).
  app.customAction(
    'checkKycFieldsComplete',
    args: {'docUrl': string, 'selfieUrl': string},
    returns: bool_,
    description: '本人確認書類・顔写真の両方がアップロード済みか確認する。',
    code: r'''
Future<bool> checkKycFieldsComplete(String? docUrl, String? selfieUrl) async {
  return (docUrl != null && docUrl.isNotEmpty) &&
      (selfieUrl != null && selfieUrl.isNotEmpty);
}
''',
  );

  // Same restriction, different shape: `pickAndUploadImage` returns a
  // nullable String (the download URL), and branching on it directly via
  // `If(ActionOutput('uploadResult'), ...)` hit the identical "Conditional
  // execution for action is improperly set" error — a String action output
  // used as a boolean condition needs an implicit type-coercion operation,
  // which this restriction blocks just as much as an explicit Equals/Not
  // would. Same fix: a dedicated bool-returning custom action first.
  app.customAction(
    'isNonEmptyString',
    args: {'value': string},
    returns: bool_,
    description: '文字列がnullまたは空でないか確認する（アップロード成功判定用）。',
    code: r'''
Future<bool> isNonEmptyString(String? value) async {
  return value != null && value.isNotEmpty;
}
''',
  );

  app.editPageState(ff.Pages.kyc, (state) {
    state.ensureField('kycDocUrl', string.withDefault(''));
    state.ensureField('kycSelfieUrl', string.withDefault(''));
  });

  app.editPage(ff.Pages.kyc, (page) {
    // Both upload cards had zero existing triggerActions.
    page.ensureActions(
      page.findByKey('Card_zea5062c'), // ID document card
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'pickAndUploadImage',
          arguments: {'fileNameSuffix': 'kyc_doc'},
          outputAs: 'docUploadResult',
        ),
        CallCustomAction.named(
          'isNonEmptyString',
          arguments: {'value': ActionOutput('docUploadResult')},
          outputAs: 'docUploadSucceeded',
        ),
        If(
          ActionOutput('docUploadSucceeded'),
          then: [
            SetState('kycDocUrl', ActionOutput('docUploadResult')),
            Snackbar('本人確認書類をアップロードしました。'),
          ],
          orElse: [Snackbar('アップロードに失敗しました。もう一度お試しください。')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Card_mrn1fobu'), // Selfie card
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'pickAndUploadImage',
          arguments: {'fileNameSuffix': 'kyc_selfie'},
          outputAs: 'selfieUploadResult',
        ),
        CallCustomAction.named(
          'isNonEmptyString',
          arguments: {'value': ActionOutput('selfieUploadResult')},
          outputAs: 'selfieUploadSucceeded',
        ),
        If(
          ActionOutput('selfieUploadSucceeded'),
          then: [
            SetState('kycSelfieUrl', ActionOutput('selfieUploadResult')),
            Snackbar('顔写真をアップロードしました。'),
          ],
          orElse: [Snackbar('アップロードに失敗しました。もう一度お試しください。')],
        ),
      ],
    );

    // No submit button existed on this page at all — genuinely missing, not
    // just unwired. Inserted after the existing trailing Divider.
    // ensureInsertedAfter — one-shot, CONFIRMED LANDED (KycSubmitButton
    // exists live) — frozen 2026-08-10, same discipline as every other
    // one-shot structural op in this file (only THIS call is frozen; the
    // ensureActions calls above stay live, per the "don't comment out a
    // whole block when only one op inside it is stale" rule).
    //   page.ensureInsertedAfter(
    //     page.findByKey('Divider_r0a3brb1'),
    //     Button(
    //       '提出する',
    //       name: 'KycSubmitButton',
    //       width: double.infinity,
    //       color: Colors.primary,
    //       textColor: Colors.primaryBackground,
    //       onTap: [
    //         CallCustomAction.named(
    //           'checkKycFieldsComplete',
    //           arguments: {
    //             'docUrl': State('kycDocUrl'),
    //             'selfieUrl': State('kycSelfieUrl'),
    //           },
    //           outputAs: 'kycFieldsCompleteResult',
    //         ),
    //         If(
    //           ActionOutput('kycFieldsCompleteResult'),
    //           then: [
    //             CallCustomAction.named(
    //               'callSubmitKyc',
    //               arguments: {
    //                 'docUrl': State('kycDocUrl'),
    //                 'selfieUrl': State('kycSelfieUrl'),
    //               },
    //               outputAs: 'submitKycResult',
    //             ),
    //             If(
    //               ActionOutput('submitKycResult'),
    //               then: [Navigate('ReviewPending', replaceRoute: true)],
    //               orElse: [Snackbar('提出に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //           orElse: [Snackbar('本人確認書類と顔写真の両方をアップロードしてください。')],
    //         ),
    //       ],
    //     ),
    //   );
  });

  // ==========================================================================
  // Phase 2 continued — functional lock while approval_status != approved
  // (IMPLEMENTATION_PLAN.md §3.1 item 11). Scope note, deliberate not
  // silent: the source requirement blocks search/browse/favorites/
  // request-sending/chat/all-payment-actions-except-card-registration
  // individually — but none of those features are wired to real triggers
  // yet (future phases), so gating each of them individually right now
  // would gate nothing. The one piece that's genuinely buildable and
  // meaningful today is the ENTRY-POINT redirect: HomePage is the actual
  // post-login landing surface every one of those features lives behind,
  // so gating entry there protects all of them by construction as they
  // get built later, not just today's surface.
  //
  // Also deliberately does NOT attempt to reproduce the "exact specified
  // Japanese under review popup copy" inline — that exact text lives in a
  // source PDF (`ゲストユーザー機能・管理.pdf` p.2) not available to re-derive
  // here, and guessing at "exact" specified copy would violate this
  // project's own "don't guess product content" rule. `ReviewPending` is
  // already a real, existing page with its own static under-review
  // copy — redirecting there (rather than inventing a duplicate popup)
  // sidesteps the whole problem: whatever text that page already shows IS
  // the source of truth, unmodified here.
  // Thin wrapper matching this file's own established minimal-call pattern
  // (see callUpdateProfilePhoto) — calls updateLastLogin (auth.ts), which
  // stamps last_login_at and is_online:true on the caller's own doc.
  app.customAction(
    'callUpdateLastLogin',
    returns: bool_,
    description: '最終ログイン日時とオンライン状態を更新する（updateLastLogin呼び出し）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callUpdateLastLogin() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('updateLastLogin');
    final result = await callable.call();
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'checkApprovalStatus',
    returns: bool_,
    description: '現在のユーザーのapproval_statusがapprovedかどうかを確認する。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> checkApprovalStatus() async {
  try {
    final uid = currentUserUid;
    // Not signed in - nothing for this check to gate; the router's own
    // auth guard (already correctly wired) owns that case.
    if (uid.isEmpty) return true;
    final doc =
        await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final status = doc.data()?['approval_status'];
    return status == 'approved';
  } catch (e) {
    // Fail OPEN, deliberately: a transient read error must not lock out an
    // already-approved user over a network blip. The real gate this
    // protects (admin approval) is still enforced server-side wherever it
    // actually matters (Cloud Functions reservation/payment checks).
    return true;
  }
}
''',
  );

  app.editPageState(ff.Pages.homePage, (state) {
    state.ensureField('discoveryCasts', listOf(string));
  });

  app.editPage(ff.Pages.homePage, (page) {
    // HomePage's existing ON_INIT_STATE is a single trivial step
    // (`FFAppState().navIndex = 0`, confirmed via generated_code) — low
    // risk to reproduce exactly alongside the new check, unlike a complex
    // multi-step chain (e.g. SignupPage's) where reproducing risks
    // silently dropping real logic.
    //
    // Phase 3 addendum (2026-08-11): the discovery-cast fetch (§ Phase 3
    // block, later in this file) is wired into THIS SAME `ensureActions`
    // call's `then:` branch — confirmed via isolation testing that
    // appending a new top-level action to an ALREADY-LANDED
    // `ensureActions` chain via a SEPARATE, later `ensureActions` call on
    // the same target fails `compileDslApp` with "Name ... already in
    // use" / "output variable with the same name as that of another
    // widget", regardless of the new action's name — even a pure,
    // unmodified reproduction of this exact 3-step chain from a SECOND
    // call site triggered it the moment a 4th step was added, while a
    // single call reproducing the original unchanged always passed. Root
    // cause not fully diagnosed (plausibly a name-registration quirk when
    // the same root+trigger is targeted by two separate `ensureActions`
    // calls in one script), but the reliable fix is structural: make ONE
    // `ensureActions` call the single source of truth for this trigger,
    // never a second one appending to it later. Placing the new fetch
    // inside the conditional's `then:` (only run when approval passes)
    // is also more correct anyway — no reason to fetch discovery data
    // for a user about to be redirected to ReviewPending.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        UpdateAppState.set(ff.AppState.navIndex, 0),
        // FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide
        // review): `updateLastLogin` (auth.ts) was deployed but never
        // called from any page, and `is_online` was never set true
        // anywhere — 2 of getDiscoveryCasts' 3 documented Home-ranking
        // sort keys were frozen at signup-time defaults for every user,
        // forever. Best-effort, no branch on its own result — a sync
        // failure shouldn't block the rest of this chain. Deliberately a
        // simple "mark active on app-open" signal, not true real-time
        // presence (would need a Realtime-Database-style onDisconnect
        // mechanism Firestore alone can't provide) — a disclosed,
        // reasonable simplification, not a claim of full presence
        // tracking.
        CallCustomAction.named(
          'callUpdateLastLogin',
          outputAs: 'updateLastLoginResult',
        ),
        CallCustomAction.named(
          'checkApprovalStatus',
          outputAs: 'approvalCheckResult',
        ),
        If(
          ActionOutput('approvalCheckResult'),
          then: [
            CallCustomAction.named(
              'fetchDiscoveryCasts',
              outputAs: 'homeDiscoveryCastsFetchResult',
            ),
            SetState('discoveryCasts', ActionOutput('homeDiscoveryCastsFetchResult')),
          ],
          orElse: [Navigate('ReviewPending', replaceRoute: true)],
        ),
      ],
    );
  });

  // ==========================================================================
  // Phase 5 (pulled forward) — Stripe Connect onboarding UI for cast
  // (IMPLEMENTATION_PLAN.md §6 defect #5's backend, this session's earlier
  // work: `submitConnectOnboarding`). No native page or reference
  // implementation existed for this at all — genuinely new, same as
  // BasicInfoRegistration.
  //
  // Scope, deliberately bounded rather than gold-plated: collects the
  // FIELDS THE BACKEND ACTUALLY REQUIRES (individual name/kana, phone, DOB,
  // address, bank account, ToS) and skips the backend's OPTIONAL fields
  // (kanji names, address_kana, gender, bank account_type) — omitting them
  // doesn't break submission, it just leaves those specific Stripe
  // `requirements_due` entries unaddressed until a future settings-page
  // pass adds them; already mirrored to `users.stripe_requirements_due` by
  // the backend regardless. Also does not build a live requirements
  // checklist UI (`getConnectAccountStatus` exists and is ready for one) —
  // judged not essential for getting real onboarding data submitted at
  // all, which is this pass's actual goal.
  // ==========================================================================

  // Checks account_type == 'cast' AND that Connect onboarding hasn't
  // already been submitted (`stripe_onboarding_submitted_at` unset) —
  // deliberately not just "is this a cast account," which would redirect
  // an already-onboarded cast user back to ConnectOnboarding every single
  // time they land on ReviewPending (e.g. after a browser-back or a stale
  // deep link), an infinite-loop-shaped bug caught before it shipped.
  app.customAction(
    'needsConnectOnboarding',
    returns: bool_,
    description: 'キャストアカウントかつStripe Connectオンボーディング未提出かどうかを確認する。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> needsConnectOnboarding() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return false;
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final data = doc.data();
    if (data == null || data['account_type'] != 'cast') return false;
    return data['stripe_onboarding_submitted_at'] == null;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Cloud-Function-calling wrapper, same established pattern as the other
  // callXxx actions in this file. Builds the nested request shape
  // submitConnectOnboarding (auth.ts) actually expects from flat string
  // arguments — matches how callCompleteOnboarding already handles this
  // for a simpler, flatter backend request shape.
  app.customAction(
    'callSubmitConnectOnboarding',
    args: {
      'lastName': string,
      'firstName': string,
      'lastNameKana': string,
      'firstNameKana': string,
      'phone': string,
      'dob': string,
      'postalCode': string,
      'prefecture': string,
      'city': string,
      'addressLine1': string,
      'bankHolderName': string,
      'bankCode': string,
      'branchCode': string,
      'bankAccountNumber': string,
    },
    returns: bool_,
    description: 'submitConnectOnboarding Cloud Functionを呼び出し、Stripe Connectオンボーディング情報を送信する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSubmitConnectOnboarding(
  String? lastName,
  String? firstName,
  String? lastNameKana,
  String? firstNameKana,
  String? phone,
  String? dob,
  String? postalCode,
  String? prefecture,
  String? city,
  String? addressLine1,
  String? bankHolderName,
  String? bankCode,
  String? branchCode,
  String? bankAccountNumber,
) async {
  try {
    final dobParts = (dob ?? '').split('-');
    if (dobParts.length != 3) return false;
    final year = int.tryParse(dobParts[0]);
    final month = int.tryParse(dobParts[1]);
    final day = int.tryParse(dobParts[2]);
    if (year == null || month == null || day == null) return false;

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('submitConnectOnboarding');
    final result = await callable.call({
      'individual': {
        'last_name': lastName ?? '',
        'first_name': firstName ?? '',
        'last_name_kana': lastNameKana ?? '',
        'first_name_kana': firstNameKana ?? '',
        'phone': phone ?? '',
        'dob': {'year': year, 'month': month, 'day': day},
        'address': {
          'postal_code': postalCode ?? '',
          'state': prefecture ?? '',
          'city': city ?? '',
          'line1': addressLine1 ?? '',
        },
      },
      'bank_account': {
        'account_holder_name': bankHolderName ?? '',
        'bank_code': bankCode ?? '',
        'branch_code': branchCode ?? '',
        'account_number': bankAccountNumber ?? '',
      },
      'tos_accepted': true,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Original declaration frozen 2026-08-10 — payload changed via
  // updateCustomAction below, same fix and same reasoning as
  // checkReservationFieldsComplete below: this only verified `dob` was
  // non-empty, never that it was an actually parseable calendar date.
  // `callSubmitConnectOnboarding` already does its own partial validation
  // (splits on '-', checks 3 parts, `int.tryParse` each) but does NOT
  // range-check month/day, so "2026-13-45"-style input would still slip
  // through as 3 successfully-parsed integers. Layering the same
  // `_isValidIsoDate` calendar check in at THIS gate (before
  // callSubmitConnectOnboarding is even called) catches it earlier, with
  // a clear pre-submit message instead of a late, confusing failure.
  //   app.customAction(
  //     'checkConnectFieldsComplete',
  //     args: {
  //       'lastName': string,
  //       'firstName': string,
  //       'lastNameKana': string,
  //       'firstNameKana': string,
  //       'phone': string,
  //       'dob': string,
  //       'postalCode': string,
  //       'prefecture': string,
  //       'city': string,
  //       'addressLine1': string,
  //       'bankHolderName': string,
  //       'bankCode': string,
  //       'branchCode': string,
  //       'bankAccountNumber': string,
  //     },
  //     returns: bool_,
  //     description: '送信に必要な全項目が入力済みか確認する（FFActionConditionは演算を含む条件を許可しないため、専用アクションで判定）。',
  //     code: r'''
  //   Future<bool> checkConnectFieldsComplete(
  //     String? lastName,
  //     String? firstName,
  //     String? lastNameKana,
  //     String? firstNameKana,
  //     String? phone,
  //     String? dob,
  //     String? postalCode,
  //     String? prefecture,
  //     String? city,
  //     String? addressLine1,
  //     String? bankHolderName,
  //     String? bankCode,
  //     String? branchCode,
  //     String? bankAccountNumber,
  //   ) async {
  //     final fields = [
  //       lastName, firstName, lastNameKana, firstNameKana, phone, dob,
  //       postalCode, prefecture, city, addressLine1,
  //       bankHolderName, bankCode, branchCode, bankAccountNumber,
  //     ];
  //     return fields.every((f) => f != null && f.isNotEmpty);
  //   }
  //   ''',
  //   );

  app.raw((project) {
    updateCustomAction(
      project,
      name: 'checkConnectFieldsComplete',
      code: r'''
bool _isValidIsoDate(String? value) {
  if (value == null) return false;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (m == null) return false;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  if (mo < 1 || mo > 12) return false;
  final dt = DateTime(y, mo, d);
  return dt.year == y && dt.month == mo && dt.day == d;
}

Future<bool> checkConnectFieldsComplete(
  String? lastName,
  String? firstName,
  String? lastNameKana,
  String? firstNameKana,
  String? phone,
  String? dob,
  String? postalCode,
  String? prefecture,
  String? city,
  String? addressLine1,
  String? bankHolderName,
  String? bankCode,
  String? branchCode,
  String? bankAccountNumber,
) async {
  final fields = [
    lastName, firstName, lastNameKana, firstNameKana, phone, dob,
    postalCode, prefecture, city, addressLine1,
    bankHolderName, bankCode, branchCode, bankAccountNumber,
  ];
  if (!fields.every((f) => f != null && f.isNotEmpty)) return false;
  return _isValidIsoDate(dob);
}
''',
    );
  });

  // Commented out per the SAME finding as BasicInfoRegistration above:
  // once this page existed (confirmed landed and verified via
  // generated_code/ in the prior push), its body became permanently inert
  // (compiler.dart's own _compilePages skips it), yet the typed-SDK
  // authoring validator still checked its string State/SetState
  // references against live server state on this next push — any future
  // change to this page goes through app.editPage(ff.Pages.connectOnboarding,
  // ...) instead.
  //   app.ensurePage(
  //     'ConnectOnboarding',
  //     route: '/connect-onboarding',
  //     description: 'キャスト向けStripe Connectオンボーディングページ（本人情報・口座情報・利用規約同意）。submitConnectOnboardingを呼び出す。',
  //     state: {
  //       'lastName': string.withDefault(''),
  //       'firstName': string.withDefault(''),
  //       'lastNameKana': string.withDefault(''),
  //       'firstNameKana': string.withDefault(''),
  //       'phone': string.withDefault(''),
  //       'dob': string.withDefault(''),
  //       'postalCode': string.withDefault(''),
  //       'prefecture': string.withDefault(''),
  //       'city': string.withDefault(''),
  //       'addressLine1': string.withDefault(''),
  //       'bankHolderName': string.withDefault(''),
  //       'bankCode': string.withDefault(''),
  //       'branchCode': string.withDefault(''),
  //       'bankAccountNumber': string.withDefault(''),
  //       'tosAgreed': bool_.withDefault(false),
  //     },
  //     body: Scaffold(
  //       appBar: AppBar(title: '報酬受け取り口座の登録'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         scrollable: true,
  //         children: [
  //           Text(
  //             '報酬をお受け取りいただくために、Stripeアカウントの本人情報と振込先口座を登録してください。',
  //             style: Styles.bodyMedium,
  //           ),
  //           Text('本人情報', style: Styles.titleMedium),
  //           TextField(
  //             label: '姓',
  //             name: 'ConnectLastNameField',
  //             onChanged: SetState('lastName', const TextValue()),
  //           ),
  //           TextField(
  //             label: '名',
  //             name: 'ConnectFirstNameField',
  //             onChanged: SetState('firstName', const TextValue()),
  //           ),
  //           TextField(
  //             label: '姓（カナ）',
  //             name: 'ConnectLastNameKanaField',
  //             onChanged: SetState('lastNameKana', const TextValue()),
  //           ),
  //           TextField(
  //             label: '名（カナ）',
  //             name: 'ConnectFirstNameKanaField',
  //             onChanged: SetState('firstNameKana', const TextValue()),
  //           ),
  //           TextField(
  //             label: '電話番号',
  //             keyboard: Keyboard.number,
  //             name: 'ConnectPhoneField',
  //             onChanged: SetState('phone', const TextValue()),
  //           ),
  //           TextField(
  //             label: '生年月日',
  //             hint: '例: 1995-06-15',
  //             name: 'ConnectDobField',
  //             onChanged: SetState('dob', const TextValue()),
  //           ),
  //           Text('住所', style: Styles.titleMedium),
  //           TextField(
  //             label: '郵便番号',
  //             name: 'ConnectPostalCodeField',
  //             onChanged: SetState('postalCode', const TextValue()),
  //           ),
  //           TextField(
  //             label: '都道府県',
  //             name: 'ConnectPrefectureField',
  //             onChanged: SetState('prefecture', const TextValue()),
  //           ),
  //           TextField(
  //             label: '市区町村',
  //             name: 'ConnectCityField',
  //             onChanged: SetState('city', const TextValue()),
  //           ),
  //           TextField(
  //             label: '番地・建物名',
  //             name: 'ConnectAddressLine1Field',
  //             onChanged: SetState('addressLine1', const TextValue()),
  //           ),
  //           Text('振込先口座', style: Styles.titleMedium),
  //           TextField(
  //             label: '口座名義（カナ）',
  //             name: 'ConnectBankHolderNameField',
  //             onChanged: SetState('bankHolderName', const TextValue()),
  //           ),
  //           TextField(
  //             label: '金融機関コード',
  //             hint: '4桁',
  //             keyboard: Keyboard.number,
  //             name: 'ConnectBankCodeField',
  //             onChanged: SetState('bankCode', const TextValue()),
  //           ),
  //           TextField(
  //             label: '支店コード',
  //             hint: '3桁',
  //             keyboard: Keyboard.number,
  //             name: 'ConnectBranchCodeField',
  //             onChanged: SetState('branchCode', const TextValue()),
  //           ),
  //           TextField(
  //             label: '口座番号',
  //             keyboard: Keyboard.number,
  //             name: 'ConnectBankAccountNumberField',
  //             onChanged: SetState('bankAccountNumber', const TextValue()),
  //           ),
  //           Row(
  //             spacing: 8,
  //             children: [
  //               Checkbox(
  //                 value: State('tosAgreed'),
  //                 onChanged: SetState('tosAgreed', const WidgetValue()),
  //                 name: 'ConnectTosCheckbox',
  //               ),
  //               Text('Stripeの利用規約に同意します'),
  //             ],
  //           ),
  //           Button(
  //             '登録する',
  //             width: double.infinity,
  //             color: Colors.primary,
  //             textColor: Colors.primaryBackground,
  //             name: 'ConnectSubmitButton',
  //             onTap: [
  //               If(
  //                 State('tosAgreed'),
  //                 then: [
  //                   CallCustomAction.named(
  //                     'checkConnectFieldsComplete',
  //                     arguments: {
  //                       'lastName': State('lastName'),
  //                       'firstName': State('firstName'),
  //                       'lastNameKana': State('lastNameKana'),
  //                       'firstNameKana': State('firstNameKana'),
  //                       'phone': State('phone'),
  //                       'dob': State('dob'),
  //                       'postalCode': State('postalCode'),
  //                       'prefecture': State('prefecture'),
  //                       'city': State('city'),
  //                       'addressLine1': State('addressLine1'),
  //                       'bankHolderName': State('bankHolderName'),
  //                       'bankCode': State('bankCode'),
  //                       'branchCode': State('branchCode'),
  //                       'bankAccountNumber': State('bankAccountNumber'),
  //                     },
  //                     outputAs: 'connectFieldsCompleteResult',
  //                   ),
  //                   If(
  //                     ActionOutput('connectFieldsCompleteResult'),
  //                     then: [
  //                       CallCustomAction.named(
  //                         'callSubmitConnectOnboarding',
  //                         arguments: {
  //                           'lastName': State('lastName'),
  //                           'firstName': State('firstName'),
  //                           'lastNameKana': State('lastNameKana'),
  //                           'firstNameKana': State('firstNameKana'),
  //                           'phone': State('phone'),
  //                           'dob': State('dob'),
  //                           'postalCode': State('postalCode'),
  //                           'prefecture': State('prefecture'),
  //                           'city': State('city'),
  //                           'addressLine1': State('addressLine1'),
  //                           'bankHolderName': State('bankHolderName'),
  //                           'bankCode': State('bankCode'),
  //                           'branchCode': State('branchCode'),
  //                           'bankAccountNumber': State('bankAccountNumber'),
  //                         },
  //                         outputAs: 'submitConnectResult',
  //                       ),
  //                       If(
  //                         ActionOutput('submitConnectResult'),
  //                         then: [Navigate('ReviewPending', replaceRoute: true)],
  //                         orElse: [
  //                           Snackbar('登録に失敗しました。入力内容をご確認のうえ、もう一度お試しください。'),
  //                         ],
  //                       ),
  //                     ],
  //                     orElse: [Snackbar('すべての項目を入力してください。')],
  //                   ),
  //                 ],
  //                 orElse: [Snackbar('利用規約への同意が必要です。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // -- Cast/guest fork after KYC submission, split out here rather than
  // nested a 3rd level deep inside KycSubmitButton's own chain (see that
  // button's own comment for the confirmed compiler restriction hit).
  // ReviewPending had no ON_INIT_STATE trigger at all before this
  // (confirmed — only its logout button and logo tap had triggers per
  // PROJECT_ANALYSIS.md's own inventory), so `ensureActions` here is safe
  // with no existing chain to risk reproducing/losing.
  // FIX (PROJECT_KNOWLEDGE.md §71 — comprehensive project-wide review):
  // ReviewPending's copy was static regardless of the caller's real
  // kyc_status — a rejected user saw the exact same "ただいま審査中です"
  // (currently under review) message as a genuinely pending one, with no
  // route back to the Kyc page to resubmit. `users/{uid}` stays
  // client-readable (only the §70 write lockdown changed), so a direct
  // client-side Firestore read is still the correct, established
  // mechanism here — matching `needsConnectOnboarding`'s own identical
  // read-own-doc pattern in the very next block.
  app.customAction(
    'fetchOwnKycStatus',
    returns: string,
    description: '自分の現在のkyc_statusを取得する（ReviewPendingの表示分岐用）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String> fetchOwnKycStatus() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return '';
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    return doc.data()?['kyc_status'] as String? ?? '';
  } catch (e) {
    return '';
  }
}
''',
  );

  final kycStatusTitleFn = app.customFunction(
    'kycStatusTitle',
    args: {'status': string},
    returns: string,
    description: 'kyc_statusに応じた見出しテキストを返す（ReviewPending）。',
    code: r'''
switch (status) {
  case 'rejected':
    return '書類の確認ができませんでした';
  default:
    return 'ただいま審査中です...';
}
''',
  );

  final kycStatusBodyFn = app.customFunction(
    'kycStatusBody',
    args: {'status': string},
    returns: string,
    description: 'kyc_statusに応じた本文テキストを返す（ReviewPending）。',
    code: r'''
switch (status) {
  case 'rejected':
    return '提出いただいた書類の確認ができませんでした。\nお手数ですが書類を再提出してください。';
  default:
    return '書類の審査には1〜2営業日かかります\n承認されましたらお知らせします';
}
''',
  );

  app.editPageState(ff.Pages.reviewPending, (state) {
    state.ensureField('kycStatus', string.withDefault(''));
  });

  app.editPage(ff.Pages.reviewPending, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchOwnKycStatus',
          outputAs: 'kycStatusResult',
        ),
        SetState('kycStatus', ActionOutput('kycStatusResult')),
        CallCustomAction.named(
          'needsConnectOnboarding',
          outputAs: 'needsConnectResult',
        ),
        If(
          ActionOutput('needsConnectResult'),
          then: [Navigate('ConnectOnboarding', replaceRoute: true)],
          orElse: [],
        ),
      ],
    );

    page.bindText(
      page.findByKey('Text_2q2k2nfm'),
      CustomFunction(kycStatusTitleFn, args: {'status': State('kycStatus')}),
    );
    page.bindText(
      page.findByKey('Text_tja6u2is'),
      CustomFunction(kycStatusBodyFn, args: {'status': State('kycStatus')}),
    );
  });

  // FROZEN (2026-08-13, immediately after this exact block landed):
  // confirmed via generated_code/lib/auth/review_pending/review_pending_widget.dart
  // — the button renders as a real `if (_model.kycStatus == 'rejected')`
  // conditional (not just a visibility wrapper), correct text, and
  // navigates to `KycWidget.routeName`. Confirmed via
  // lib/flutterflow_project/pages/review_pending.dart — new key
  // `Button_veotpfut`, name "KycResubmitButton". Any future change must
  // target that key/name instead of re-inserting.
  // app.editPage(ff.Pages.reviewPending, (page) {
  //   page.ensureInsertedAfter(
  //     page.findByKey('Text_tja6u2is'),
  //     Button(
  //       '書類を再提出する',
  //       name: 'KycResubmitButton',
  //       variant: ButtonVariant.outlined,
  //       visible: Equals(State('kycStatus'), 'rejected'),
  //       onTap: [Navigate(ff.Pages.kyc)],
  //     ),
  //   );
  // });

  // ==========================================================================
  // Phase 4 — Reservation core (IMPLEMENTATION_PLAN.md §3.5). Wires
  // `reservation_form.dart` — the booking flow's actual entry point — to the
  // already-deployed `createReservation` backend callable.
  //
  // Scope, deliberately bounded: this task is "wire reservation_form.dart's
  // own submit," not "wire the full discovery-to-booking handoff." A
  // `castId` page param is added (with a safe default, per this project's
  // own design rule for cold-entry deep links) so this form can receive who
  // it's inviting, but `cast_profile.dart`'s own "誘う" button — the thing
  // that would actually navigate here WITH that param populated — is not
  // wired in this pass; that's `cast_profile.dart`'s own not-yet-started
  // task. Documented explicitly rather than left implicit, since a
  // perfectly-wired form with no real entry point is easy to mistake for
  // "done" if this isn't stated plainly.
  //
  // Also missing from the form entirely: any amount/price field — the
  // reservation's `base_amount`. No confirmed pricing formula exists yet in
  // what this session read (cast hourly-rate display isn't wired anywhere
  // either, per PROJECT_ANALYSIS.md), so a new "合計金額" field is added for
  // the guest to see/confirm an amount explicitly, rather than silently
  // inventing a rate x duration formula that isn't sourced from any actual
  // spec text — a real formula (cast's own rate x duration) is Phase 3/5
  // work once cast profile rates are actually wired and belongs there, not
  // guessed here.
  // ==========================================================================

  app.editPageParams(ff.Pages.reservationForm, (params) {
    params.ensureParam('castId', string.withDefault(''));
  });

  app.editPageState(ff.Pages.reservationForm, (state) {
    state.ensureField('resDate', string.withDefault(''));
    state.ensureField('resStartTime', string.withDefault('19:00'));
    state.ensureField('resTimeSlot', string.withDefault('1部'));
    state.ensureField('resDurationLabel', string.withDefault('60分'));
    state.ensureField('resMeetingAddress', string.withDefault(''));
    state.ensureField('resMeetingPoint', string.withDefault(''));
    state.ensureField('resGroupInvite', bool_.withDefault(false));
    state.ensureField('resGroupSizeLabel', string.withDefault('1'));
    state.ensureField('resPurpose', string.withDefault('食事'));
    state.ensureField('resDetails', string.withDefault(''));
    state.ensureField('resBaseAmount', string.withDefault(''));
  });

  // Original declaration frozen 2026-08-10 — payload changed via
  // updateCustomAction below to fix a real, confirmed defect: this check
  // only verified `date` was non-empty, never that it was an actually
  // parseable calendar date. The date field (`ResDateField`) is free
  // text (no DatePicker primitive exists in this DSL — confirmed by
  // reading widgets.dart directly, only `Calendar` exists as a widget;
  // `DatePicker` is a separate ACTION, not a bindable field type), so a
  // guest could submit e.g. "2026/09/01" or a typo and it would sail
  // straight through this gate. `callCreateReservation` builds
  // `'${date}T...:00'` and sends it as-is; `reservations.ts`'s own
  // `createReservation` does `Timestamp.fromDate(new Date(date))` with NO
  // validation of its own — a malformed date reaches this parse
  // unguarded. Confirmed the resulting failure mode is at least a clean
  // exception (caught by `callCreateReservation`'s own try/catch, shows a
  // generic Snackbar) rather than corrupted data for THIS field, but a
  // confusing, unnecessary round-trip failure that real format validation
  // prevents outright. Deliberately does NOT add a "must be a future
  // date" business rule alongside this — that's a product decision with
  // no spec backing found in IMPLEMENTATION_PLAN.md, so guessing at it
  // would violate this project's own "don't guess product rules" rule;
  // this fixes the confirmed TECHNICAL defect (non-calendar-date strings
  // reaching the backend unchecked) only.
  //   app.customAction(
  //     'checkReservationFieldsComplete',
  //     args: {
  //       'date': string,
  //       'meetingAddress': string,
  //       'meetingPoint': string,
  //       'baseAmount': string,
  //     },
  //     returns: bool_,
  //     description: '予約送信に必要な必須項目が入力済みか確認する。',
  //     code: r'''
  //   Future<bool> checkReservationFieldsComplete(
  //     String? date,
  //     String? meetingAddress,
  //     String? meetingPoint,
  //     String? baseAmount,
  //   ) async {
  //     return (date != null && date.isNotEmpty) &&
  //         (meetingAddress != null && meetingAddress.isNotEmpty) &&
  //         (meetingPoint != null && meetingPoint.isNotEmpty) &&
  //         (baseAmount != null && baseAmount.isNotEmpty && (int.tryParse(baseAmount) ?? 0) > 0);
  //   }
  //   ''',
  //   );

  app.raw((project) {
    updateCustomAction(
      project,
      name: 'checkReservationFieldsComplete',
      code: r'''
bool _isValidIsoDate(String? value) {
  if (value == null) return false;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (m == null) return false;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  if (mo < 1 || mo > 12) return false;
  final dt = DateTime(y, mo, d);
  return dt.year == y && dt.month == mo && dt.day == d;
}

Future<bool> checkReservationFieldsComplete(
  String? date,
  String? meetingAddress,
  String? meetingPoint,
  String? baseAmount,
) async {
  return _isValidIsoDate(date) &&
      (meetingAddress != null && meetingAddress.isNotEmpty) &&
      (meetingPoint != null && meetingPoint.isNotEmpty) &&
      (baseAmount != null && baseAmount.isNotEmpty && (int.tryParse(baseAmount) ?? 0) > 0);
}
''',
    );
  });

  // Cloud-Function-calling wrapper, same established pattern as every other
  // callXxx action this session. Returns the new reservation's res_id
  // (empty string on failure) so the caller can pass it on to
  // ReservationConfirmed and branch success/failure via the already-
  // declared `isNonEmptyString` (KYC section, reused here rather than
  // duplicated).
  app.customAction(
    'callCreateReservation',
    args: {
      'castId': string,
      'date': string,
      'startTime': string,
      'timeSlot': string,
      'durationLabel': string,
      'meetingAddress': string,
      'meetingPoint': string,
      'groupInvite': bool_,
      'groupSizeLabel': string,
      'purpose': string,
      'details': string,
      'baseAmount': string,
    },
    returns: string,
    description: 'createReservation Cloud Functionを呼び出し、新しい予約を作成する。res_idを返す。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String?> callCreateReservation(
  String? castId,
  String? date,
  String? startTime,
  String? timeSlot,
  String? durationLabel,
  String? meetingAddress,
  String? meetingPoint,
  bool? groupInvite,
  String? groupSizeLabel,
  String? purpose,
  String? details,
  String? baseAmount,
) async {
  try {
    if (castId == null || castId.isEmpty) return null;
    final durationMinutes =
        int.tryParse(RegExp(r'\d+').firstMatch(durationLabel ?? '')?.group(0) ?? '') ?? 60;
    final groupSize = int.tryParse(groupSizeLabel ?? '') ?? 0;
    final amount = int.tryParse(baseAmount ?? '') ?? 0;
    final isoDateTime = '${date}T${(startTime == null || startTime.isEmpty) ? '19:00' : startTime}:00';
    final fullDetails = (purpose == null || purpose.isEmpty)
        ? (details ?? '')
        : '【目的：$purpose】\n${details ?? ''}';

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('createReservation');
    final result = await callable.call({
      'cast_ids': [castId],
      'date': isoDateTime,
      'time_slot': timeSlot ?? '',
      'duration_minutes': durationMinutes,
      'location': meetingAddress ?? '',
      'meeting_point': meetingPoint ?? '',
      'group_invite': groupInvite ?? false,
      'group_size': groupSize,
      'details': fullDetails,
      'base_amount': amount,
    });
    if (result.data is Map && result.data['res_id'] != null) {
      return result.data['res_id'] as String;
    }
    return null;
  } catch (e) {
    return null;
  }
}
''',
  );

  app.editPageParams(ff.Pages.reservationConfirmed, (params) {
    params.ensureParam('resId', string.withDefault(''));
  });

  app.editPage(ff.Pages.reservationForm, (page) {
    // Date: was an icon-only container with no real input behind it at all
    // (confirmed via the typed SDK — just an Icon, no TextField anywhere in
    // that subtree). Same function-over-form trade-off already used for
    // BasicInfoRegistration/ConnectOnboarding's own date fields this
    // session — one real TextField instead of a picker this DSL has no
    // clean primitive for.
    // ensureReplaced — one-shot, CONFIRMED LANDED (ResDateField exists
    // live) — frozen 2026-08-10, same discipline as every other one-shot
    // structural op in this file.
    //   page.ensureReplaced(
    //     page.findByKey('Container_8is5q6ti'),
    //     TextField(
    //       label: '日付',
    //       hint: '例: 2026-09-01',
    //       name: 'ResDateField',
    //       onChanged: SetState('resDate', const TextValue()),
    //     ),
    //   );

    // ==========================================================================
    // CRITICAL BUG found and fixed 2026-08-10, during a full re-analysis
    // pass: ALL SIX of this page's native dropdowns still had FlutterFlow's
    // own generic placeholder options — literally `['Option 1', 'Option 2',
    // 'Option 3']` — confirmed by reading generated_code/.../
    // reservation_form_widget.dart directly (not assumed). This session's
    // earlier work wired the ON_FORM_WIDGET_SELECTED -> SetState mechanism
    // correctly but never checked/fixed the underlying OPTION CONTENT those
    // triggers select from — the mechanism was right, the data was fake.
    // Real, confirmed downstream consequences, not just missing content:
    //   - 時間帯 (time_slot) reached "createReservation" as literally
    //     "Option 1"/"Option 2"/"Option 3" — reservations.ts compares this
    //     against `config.night_time_slots` (default `["3部","4部"]`,
    //     confirmed by reading config.ts directly), so it could never match.
    //   - 交流時間 (duration) fed `RegExp(r'\d+').firstMatch(durationLabel)`
    //     in callCreateReservation — "Option 1"/"Option 2"/"Option 3" DO
    //     contain a digit, so this silently produced `duration_minutes: 1`,
    //     `2`, or `3` (MINUTES, not a real interaction length) instead of
    //     failing loudly — a silent wrong-data bug, not just a missing one.
    //   - 交流開始時間 (start_time) fed directly into
    //     `'${date}T${startTime}:00'` — "Option 1" is not a valid time
    //     component, producing a malformed ISO datetime string sent
    //     straight to `new Date(date)` on the backend (same unguarded-parse
    //     risk already fixed for the date field itself above).
    // Fixed by reconstructing each dropdown via ensureReplaced with REAL
    // options AND its value/onChanged wiring combined into ONE widget
    // (superseding the separate ensureActions calls these 3 used to need)
    // — same pattern already proven for the review-rating dropdown
    // (reservation_detail.dart, ReviewInputRow).
    // Option value confidence, disclosed per field rather than presented
    // as uniformly verified:
    //   - 時間帯 (1部/2部/3部/4部): CONFIRMED against `config.ts`'s own
    //     `night_time_slots` naming convention (no invented content).
    //   - グループお誘い希望人数 (1-10): CONFIRMED against
    //     IMPLEMENTATION_PLAN.md §3.6 item 8's explicit "1–10" spec text.
    //   - 交流時間/交流開始時間/お誘い目的: NO explicit option list found in
    //     IMPLEMENTATION_PLAN.md — used reasonable, format-valid interim
    //     values (30-min increments matching the already-confirmed
    //     `ratePerThirtyMin` billing granularity; evening times matching
    //     the "night slot" business context and this page's own
    //     already-chosen state defaults, e.g. `resStartTime`'s existing
    //     `.withDefault('19:00')` already implied evening hours). These
    //     are NOT claimed as final business-approved copy — flagged here
    //     and in PROJECT_KNOWLEDGE.md for product-owner confirmation,
    //     same disclosure discipline as every other guessed-vs-confirmed
    //     distinction in this file. Fixing structural validity (a real
    //     parseable time/duration) was mandatory regardless of exact
    //     wording; the exact wording is the part still open.
    // ensureReplaced x6 (this block) — one-shot, CONFIRMED LANDED (all 6
    // real option lists exist live, verified against
    // reservation_form_widget.dart directly — §24) — frozen 2026-08-10.
    // Found unfrozen during the project_rules.md §266-mandated full-file
    // sweep after catching the SAME failure mode fresh on
    // reservation_confirmed.dart (PROJECT_KNOWLEDGE.md §28's freeze
    // addendum) — confirms §266's own warning that finding one instance
    // means checking for others, not just fixing the one that broke.
    // ==========================================================================
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_zufoed9k'), // 時間帯
    //     Dropdown(
    //       name: 'ResTimeSlotDropdown',
    //       hint: '時間帯を選択してください',
    //       options: const ['1部', '2部', '3部', '4部'],
    //       value: State('resTimeSlot'),
    //       onChanged: SetState('resTimeSlot', const WidgetValue()),
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_hqnthj6t'), // 交流時間
    //     Dropdown(
    //       name: 'ResDurationDropdown',
    //       hint: '交流時間を選択してください',
    //       options: const ['60分', '90分', '120分', '150分', '180分'],
    //       value: State('resDurationLabel'),
    //       onChanged: SetState('resDurationLabel', const WidgetValue()),
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_lf1zrpbg'), // 交流開始時間
    //     Dropdown(
    //       name: 'ResStartTimeDropdown',
    //       hint: '交流開始時間を選択してください',
    //       options: const ['18:00', '19:00', '20:00', '21:00', '22:00'],
    //       value: State('resStartTime'),
    //       onChanged: SetState('resStartTime', const WidgetValue()),
    //     ),
    //   );
    page.ensureActions(
      page.findByKey('TextField_rp08iqrc'), // 行先場所住所
      triggerType: FFActionTriggerType.ON_TEXTFIELD_CHANGE,
      actions: [SetState('resMeetingAddress', const TextValue())],
    );
    page.ensureActions(
      page.findByKey('TextField_rgj370x1'), // 待ち合わせ場所
      triggerType: FFActionTriggerType.ON_TEXTFIELD_CHANGE,
      actions: [SetState('resMeetingPoint', const TextValue())],
    );
    // SwitchListTile isn't a valid ON_TOGGLE_ON/OFF target in this SDK
    // (confirmed: `compileDslApp` rejected it outright — "ON_TOGGLE_ON
    // requires a Switch or Checkbox target, got SwitchListTile") — replaced
    // with a DSL-authored Checkbox, same boolean semantic, different visual.
    // ensureReplaced — one-shot, CONFIRMED LANDED (ResGroupInviteCheckbox
    // exists live) — frozen 2026-08-10, same discipline as every other
    // one-shot structural op in this file.
    //   page.ensureReplaced(
    //     page.findByKey('SwitchListTile_8u4clxfz'),
    //     Checkbox(
    //       name: 'ResGroupInviteCheckbox',
    //       value: State('resGroupInvite'),
    //       onChanged: SetState('resGroupInvite', const WidgetValue()),
    //     ),
    //   );
    // グループお誘い希望人数: options fixed from `['Option 1','Option 2',
    // 'Option 3']` to '1'-'10', CONFIRMED against IMPLEMENTATION_PLAN.md
    // §3.6 item 8 ("group-invite desired headcount (1–10, dropdown)") —
    // was previously ALWAYS parsing to `group_size: 0` regardless of
    // selection (`int.tryParse('Option 1') == null` in
    // callCreateReservation, falling back to `?? 0`), same broken-content
    // class as the 3 dropdowns above.
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_5bq2jjwz'), // グループお誘い希望人数
    //     Dropdown(
    //       name: 'ResGroupSizeDropdown',
    //       hint: 'グループお誘い希望人数を選択してください',
    //       options: const ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    //       value: State('resGroupSizeLabel'),
    //       onChanged: SetState('resGroupSizeLabel', const WidgetValue()),
    //     ),
    //   );
    // お誘い目的: same broken-placeholder class as above, lower technical
    // severity (feeds into free-text `details` via string interpolation in
    // callCreateReservation, not parsed as a number/date, so "Option 1"
    // wasn't corrupting data the way time_slot/duration/start_time were)
    // but still meaningless content, fixed for the same reason. No
    // IMPLEMENTATION_PLAN.md option list found — interim values, product
    // confirmation still open (see this block's own top-level comment).
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_28jgr18w'), // お誘い目的
    //     Dropdown(
    //       name: 'ResPurposeDropdown',
    //       hint: 'お誘い目的を選択してください',
    //       options: const ['食事', '観光', 'イベント同行', '飲み会', 'その他'],
    //       value: State('resPurpose'),
    //       onChanged: SetState('resPurpose', const WidgetValue()),
    //     ),
    //   );
    page.ensureActions(
      page.findByKey('TextField_5xuym89f'), // お誘い内容詳細
      triggerType: FFActionTriggerType.ON_TEXTFIELD_CHANGE,
      actions: [SetState('resDetails', const TextValue())],
    );

    // 延長予定の有無 (DropDown_ne646169) stays deliberately UNWIRED — it has
    // no corresponding createReservation field (extensions are a separate
    // flow, requested later via extension_payment.dart, never at
    // reservation-creation time); wiring it to local state with nowhere
    // real to send it would be display-only theater, not a real fix. Its
    // OPTIONS are still fixed here for visual consistency (was also
    // showing 'Option 1'/'Option 2'/'Option 3' — harmless since nothing
    // reads this field, but looked broken next to the now-fixed dropdowns
    // around it).
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_ne646169'), // 延長予定の有無
    //     Dropdown(
    //       name: 'ResExtensionPlanDropdown',
    //       hint: '延長予定の有無を選択してください',
    //       options: const ['延長予定あり', '延長予定なし'],
    //     ),
    //   );

    // 合計金額 — genuinely missing field, inserted after the existing
    // free-text-details row. ensureInsertedAfter — one-shot, CONFIRMED
    // LANDED (ResBaseAmountRow/ResBaseAmountField exist live) — frozen
    // 2026-08-10, same discipline as every other one-shot structural op in
    // this file.
    //   page.ensureInsertedAfter(
    //     page.findByKey('Row_8aeejqf8'),
    //     Row(
    //       name: 'ResBaseAmountRow',
    //       children: [
    //         Column(
    //           children: [
    //             Text('合計金額（円）', style: Styles.bodyMedium),
    //             TextField(
    //               hint: '例: 15000',
    //               keyboard: Keyboard.number,
    //               name: 'ResBaseAmountField',
    //               onChanged: SetState('resBaseAmount', const TextValue()),
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
  });

  // Ensured early (idempotent, safe to also call again later in this same
  // file) so the submit-button rewiring right below — which references
  // these two fields by bare string — doesn't depend on execution order
  // relative to the later editPageState call that also declares them.
  app.editPageState(ff.Pages.reservationForm, (state) {
    state.ensureField('resNeedsSecurity', bool_.withDefault(false));
    state.ensureField('resNeedsTransport', bool_.withDefault(false));
  });

  // Submit button — was mislabeled "合流報告" (meetup-report, copy-pasted
  // from reservation_detail.dart) and had no ON_TAP wired at all. Fixed
  // label + real submit chain.
  app.editPage(ff.Pages.reservationForm, (page) {
    page.update(page.findByKey('Button_hzb6mzvi'), (patch) {
      patch.text('リクエストを送信する');
    });
    page.ensureActions(
      page.findByKey('Button_hzb6mzvi'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'checkReservationFieldsComplete',
          arguments: {
            'date': State('resDate'),
            'meetingAddress': State('resMeetingAddress'),
            'meetingPoint': State('resMeetingPoint'),
            'baseAmount': State('resBaseAmount'),
          },
          outputAs: 'resFieldsCompleteResult',
        ),
        If(
          ActionOutput('resFieldsCompleteResult'),
          then: [
            CallCustomAction.named(
              'callCreateReservationWithStaff',
              arguments: {
                'castId': PageParam('castId'),
                'date': State('resDate'),
                'startTime': State('resStartTime'),
                'timeSlot': State('resTimeSlot'),
                'durationLabel': State('resDurationLabel'),
                'meetingAddress': State('resMeetingAddress'),
                'meetingPoint': State('resMeetingPoint'),
                'groupInvite': State('resGroupInvite'),
                'groupSizeLabel': State('resGroupSizeLabel'),
                'purpose': State('resPurpose'),
                'details': State('resDetails'),
                'baseAmount': State('resBaseAmount'),
                'needsSecurity': State('resNeedsSecurity'),
                'needsTransport': State('resNeedsTransport'),
              },
              outputAs: 'createReservationResult',
            ),
            CallCustomAction.named(
              'isNonEmptyString',
              arguments: {'value': ActionOutput('createReservationResult')},
              outputAs: 'createReservationSucceeded',
            ),
            If(
              ActionOutput('createReservationSucceeded'),
              then: [
                // FIX (confirmed critical live bug, found during audit):
                // this used to navigate straight to ReservationConfirmed,
                // completely skipping payment. `createReservation` always
                // writes `payment_intent_id: ""` — the ONLY place that
                // ever gets populated is `createPaymentIntent`, which is
                // only ever called from PaymentConfirm's own submit
                // button. Since PaymentConfirm was never reached from
                // anywhere in the app, EVERY reservation created through
                // this form was permanently stuck with no PaymentIntent —
                // `reportCompletion` would later hit its own defensive
                // "reached completion_pending with no payment_intent_id"
                // error path for every single one. Now routes through
                // PaymentConfirm first; PaymentConfirm's own submit button
                // (see its ON_TAP chain) forwards to ReservationConfirmed
                // only after Stripe payment actually succeeds.
                Navigate(
                  ff.Pages.paymentConfirm,
                  replaceRoute: true,
                  params: {
                    'resId': ActionOutput('createReservationResult'),
                  },
                ),
              ],
              orElse: [
                Snackbar('リクエストの送信に失敗しました。もう一度お試しください。'),
              ],
            ),
          ],
          orElse: [Snackbar('必須項目（日付・行先住所・待ち合わせ場所・金額）を入力してください。')],
        ),
      ],
    );
  });

  // ==========================================================================
  // `reservation_detail.dart` — the richest lifecycle screen (approve/
  // decline/meetup/complete/rate/cancel), all 6 buttons confirmed unwired
  // (no `triggers` at all on any of them, per the typed SDK read).
  //
  // Scope, deliberately bounded: wires every button's ON_TAP to the real
  // backend callable with real params — the functional core. Does NOT
  // build status-driven VISIBILITY (showing only the buttons valid for the
  // reservation's current state) — that needs fetching+comparing status on
  // load across up to 6 separate bare-bool checks, a substantial further
  // layer. Judged an acceptable gap FOR NOW because the backend itself is
  // the real source of truth and already rejects an invalid transition
  // with a clear error (e.g. `respondToReservation` throws if status isn't
  // `authorized`/`cast_pending`) — a mistap shows an error Snackbar, it
  // doesn't corrupt data. Flagged as real, valuable follow-up work, not
  // silently skipped.
  // ==========================================================================

  app.editPageParams(ff.Pages.reservationDetail, (params) {
    params.ensureParam('resId', string.withDefault(''));
    params.ensureParam('castId', string.withDefault(''));
  });

  app.editPageState(ff.Pages.reservationDetail, (state) {
    state.ensureField('reviewRating', string.withDefault('5'));
    state.ensureField('reviewComment', string.withDefault(''));
  });

  // One shared action for both approve/decline (respondToReservation's own
  // real signature — a single `accept: bool` param already covers both).
  app.customAction(
    'callRespondToReservation',
    args: {'resId': string, 'accept': bool_},
    returns: bool_,
    description: 'respondToReservation Cloud Functionを呼び出し、予約リクエストを承諾/辞退する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callRespondToReservation(String? resId, bool? accept) async {
  try {
    if (resId == null || resId.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('respondToReservation');
    final result = await callable.call({
      'res_id': resId,
      'accept': accept ?? false,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callConfirmMeetup',
    args: {'resId': string},
    returns: bool_,
    description: 'confirmMeetup Cloud Functionを呼び出し、合流を報告する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callConfirmMeetup(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('confirmMeetup');
    final result = await callable.call({'res_id': resId});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callReportCompletion',
    args: {'resId': string},
    returns: bool_,
    description: 'reportCompletion Cloud Functionを呼び出し、完了を報告する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callReportCompletion(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('reportCompletion');
    final result = await callable.call({'res_id': resId});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callSubmitReview',
    args: {'resId': string, 'castId': string, 'rating': string, 'comment': string},
    returns: bool_,
    description: 'submitReview Cloud Functionを呼び出し、評価を送信する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSubmitReview(
  String? resId,
  String? castId,
  String? rating,
  String? comment,
) async {
  try {
    if (resId == null || resId.isEmpty) return false;
    if (castId == null || castId.isEmpty) return false;
    final ratingInt = int.tryParse(rating ?? '') ?? 0;
    if (ratingInt < 1 || ratingInt > 5) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('submitReview');
    final result = await callable.call({
      'res_id': resId,
      'cast_id': castId,
      'rating': ratingInt,
      'comment': comment ?? '',
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callCancelReservation',
    args: {'resId': string},
    returns: bool_,
    description: 'cancelPayment Cloud Functionを呼び出し、予約をキャンセルする。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callCancelReservation(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('cancelPayment');
    final result = await callable.call({'res_id': resId});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.editPage(ff.Pages.reservationDetail, (page) {
    // SUPERSEDED 2026-08-10 — all 6 of these ensureActions calls are now
    // fully absorbed into the status/role-visibility `ensureReplaced`
    // block further down (each new button's own `onTap:` is byte-for-byte
    // identical to what these calls used to set). Frozen here rather than
    // left live: `ensureReplaced` assigns each button a FRESH key, so
    // `page.findByKey('Button_i8a0ibu2')` (etc.) would find nothing on the
    // very next push after this one lands — the exact "earlier block
    // orphaned by a later wholesale chain replacement" failure mode this
    // file's own rules document (project_rules.md's "Replacing an existing
    // action chain WHOLESALE... can silently orphan any EARLIER raw-patch
    // block" entry). Caught and fixed in the SAME push that introduced the
    // replacement, not left for a future push to trip over.
    //   page.ensureActions(
    //     page.findByKey('Button_i8a0ibu2'), // お誘いを承認する
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callRespondToReservation',
    //         arguments: {'resId': PageParam('resId'), 'accept': true},
    //         outputAs: 'respondResult',
    //       ),
    //       If(
    //         ActionOutput('respondResult'),
    //         then: [Snackbar('リクエストを承諾しました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );
    //   page.ensureActions(
    //     page.findByKey('Button_4bn0e7q6'), // お誘いを断る
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callRespondToReservation',
    //         arguments: {'resId': PageParam('resId'), 'accept': false},
    //         outputAs: 'declineResult',
    //       ),
    //       If(
    //         ActionOutput('declineResult'),
    //         then: [Snackbar('リクエストを辞退しました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );
    //   page.ensureActions(
    //     page.findByKey('Button_ywx57vu4'), // 合流報告
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callConfirmMeetup',
    //         arguments: {'resId': PageParam('resId')},
    //         outputAs: 'meetupResult',
    //       ),
    //       If(
    //         ActionOutput('meetupResult'),
    //         then: [Snackbar('合流確認を送信しました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );
    //   page.ensureActions(
    //     page.findByKey('Button_zm9z7vuz'), // 完了報告
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callReportCompletion',
    //         arguments: {'resId': PageParam('resId')},
    //         outputAs: 'completionResult',
    //       ),
    //       If(
    //         ActionOutput('completionResult'),
    //         then: [Snackbar('完了報告を送信しました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );
    //   page.ensureActions(
    //     page.findByKey('Button_wygsdhu0'), // 評価する
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callSubmitReview',
    //         arguments: {
    //           'resId': PageParam('resId'),
    //           'castId': PageParam('castId'),
    //           'rating': State('reviewRating'),
    //           'comment': State('reviewComment'),
    //         },
    //         outputAs: 'reviewResult',
    //       ),
    //       If(
    //         ActionOutput('reviewResult'),
    //         then: [Snackbar('評価を送信しました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );
    //   page.ensureActions(
    //     page.findByKey('Button_t77bzb4o'), // キャンセルする
    //     triggerType: FFActionTriggerType.ON_TAP,
    //     actions: [
    //       CallCustomAction.named(
    //         'callCancelReservation',
    //         arguments: {'resId': PageParam('resId')},
    //         outputAs: 'cancelResult',
    //       ),
    //       If(
    //         ActionOutput('cancelResult'),
    //         then: [Snackbar('予約をキャンセルしました。'), NavigateBack()],
    //         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //       ),
    //     ],
    //   );

    // Rating input — genuinely missing (the 5-icon row already on this
    // page displays the COUNTERPART's average rating, a read-only summary,
    // not an input control). Inserted right before the rate button's own
    // row, matching this file's established insert-before-the-action
    // pattern. ensureInsertedBefore — one-shot, CONFIRMED LANDED
    // (ReviewInputRow/ReviewCommentField exist live) — frozen 2026-08-10,
    // same discipline as every other one-shot structural op in this file.
    //   page.ensureInsertedBefore(
    //     page.findByKey('Row_dw9z46os'),
    //     Row(
    //       name: 'ReviewInputRow',
    //       children: [
    //         Column(
    //           children: [
    //             Text('評価', style: Styles.bodyMedium),
    //             Dropdown(
    //               options: const ['1', '2', '3', '4', '5'],
    //               value: State('reviewRating'),
    //               onChanged: SetState('reviewRating', const WidgetValue()),
    //             ),
    //             TextField(
    //               label: 'コメント（任意）',
    //               name: 'ReviewCommentField',
    //               onChanged: SetState('reviewComment', const TextValue()),
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
  });

  // ==========================================================================
  // ReservationListPage (IMPLEMENTATION_PLAN.md §7 — genuinely missing per
  // the client's own checklist, "Maccha page is a match feed, not a
  // reservation list"). No native page and no reference implementation
  // exist for this at all.
  //
  // Design note: `FirestoreQuery` (this DSL's only native query action) has
  // no filter/where parameter at all (confirmed by reading its full
  // constructor — just collection/limit/singleTimeQuery/outputAs), so it
  // cannot express "my own reservations" and would anyway be rejected by
  // `firebase/firestore.rules`' own per-document guest_id/cast_ids/staff_ids
  // check on an unfiltered query. A custom action doing two filtered
  // Firestore queries (guest_id ==, cast_ids array-contains) client-side is
  // the only way to build this within this DSL's actual surface.
  //
  // Second design note: the query result is encoded as `List<String>`
  // (delimited fields), NOT `List<JSON>` or a declared Struct — deliberately
  // avoiding two real landmines already hit/documented this session:
  // `List<JSON>` page state cannot be reliably written to (a confirmed,
  // separate SDK restriction), and `ItemRef['field']` FieldAccess requires
  // a struct/document-typed source, which a bare custom-action JSON return
  // doesn't have (untested whether a declared Struct return would work —
  // not worth the risk for a first version of this page). Two small custom
  // FUNCTIONS format/extract from the delimited string for display and for
  // the row's own Navigate param — a plain, already-proven-safe mechanism.
  // ==========================================================================

  // Original declaration frozen 2026-08-10 — payload changed via
  // updateCustomAction below (adds a 6th delimited field, the reservation's
  // primary cast_id) to fix R12 (`reviewWiring`'s navigation-param-
  // completeness check): ReservationListPage's row Navigate to
  // ReservationDetail couldn't pass castId at all, since this action never
  // fetched cast_ids in the first place. Per this file's own established
  // rule, leaving this ORIGINAL app.customAction declaration live alongside
  // the updateCustomAction call below would throw "found an existing custom
  // action ... with a different payload" on the next unrelated push —
  // frozen in the SAME push that adds the update, not left for later.
  //   app.customAction(
  //     'fetchMyReservations',
  //     returns: listOf(string),
  //     description: '自分が関わる予約一覧を取得する（ゲスト・キャスト・スタッフいずれの立場でも）。',
  //     code: r'''
  //   import 'package:cloud_firestore/cloud_firestore.dart';
  //   import '/auth/firebase_auth/auth_util.dart';
  //
  //   Future<List<String>> fetchMyReservations() async {
  //     try {
  //       final uid = currentUserUid;
  //       if (uid.isEmpty) return <String>[];
  //       final firestore = FirebaseFirestore.instance;
  //       final guestDocs = await firestore
  //           .collection('reservations')
  //           .where('guest_id', isEqualTo: uid)
  //           .get();
  //       final castDocs = await firestore
  //           .collection('reservations')
  //           .where('cast_ids', arrayContains: uid)
  //           .get();
  //
  //       final merged = <String, Map<String, dynamic>>{};
  //       for (final d in guestDocs.docs) {
  //         merged[d.id] = d.data();
  //       }
  //       for (final d in castDocs.docs) {
  //         merged[d.id] = d.data();
  //       }
  //
  //       final entries = merged.entries.toList();
  //       entries.sort((a, b) {
  //         final aDate = a.value['date'];
  //         final bDate = b.value['date'];
  //         final aTime = aDate is Timestamp ? aDate.millisecondsSinceEpoch : 0;
  //         final bTime = bDate is Timestamp ? bDate.millisecondsSinceEpoch : 0;
  //         return bTime.compareTo(aTime);
  //       });
  //
  //       return entries.map((e) {
  //         final data = e.value;
  //         final status = data['status']?.toString() ?? '';
  //         final rawDate = data['date'];
  //         var dateLabel = '';
  //         if (rawDate is Timestamp) {
  //           final d = rawDate.toDate();
  //           dateLabel =
  //               '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  //         }
  //         final location = (data['location']?.toString() ?? '').replaceAll('|||', '');
  //         final amount = data['total_amount']?.toString() ?? '0';
  //         return '${e.key}|||$status|||$dateLabel|||$location|||$amount';
  //       }).toList();
  //     } catch (e) {
  //       return <String>[];
  //     }
  //   }
  //   ''',
  //   );

  app.raw((project) {
    updateCustomAction(
      project,
      name: 'fetchMyReservations',
      code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<List<String>> fetchMyReservations() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return <String>[];
    final firestore = FirebaseFirestore.instance;
    final guestDocs = await firestore
        .collection('reservations')
        .where('guest_id', isEqualTo: uid)
        .get();
    final castDocs = await firestore
        .collection('reservations')
        .where('cast_ids', arrayContains: uid)
        .get();

    final merged = <String, Map<String, dynamic>>{};
    for (final d in guestDocs.docs) {
      merged[d.id] = d.data();
    }
    for (final d in castDocs.docs) {
      merged[d.id] = d.data();
    }

    final entries = merged.entries.toList();
    entries.sort((a, b) {
      final aDate = a.value['date'];
      final bDate = b.value['date'];
      final aTime = aDate is Timestamp ? aDate.millisecondsSinceEpoch : 0;
      final bTime = bDate is Timestamp ? bDate.millisecondsSinceEpoch : 0;
      return bTime.compareTo(aTime);
    });

    return entries.map((e) {
      final data = e.value;
      final status = data['status']?.toString() ?? '';
      final rawDate = data['date'];
      var dateLabel = '';
      if (rawDate is Timestamp) {
        final d = rawDate.toDate();
        dateLabel =
            '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
      }
      final location = (data['location']?.toString() ?? '').replaceAll('|||', '');
      final amount = data['total_amount']?.toString() ?? '0';
      final castIds = (data['cast_ids'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          <String>[];
      final primaryCastId = castIds.isNotEmpty ? castIds.first : '';
      return '${e.key}|||$status|||$dateLabel|||$location|||$amount|||$primaryCastId';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
    );
  });

  // CRITICAL BUG found and fixed 2026-08-10, during the R12 fix's own
  // verification pass: `app.customFunction(...)`'s `code:` parameter takes
  // ONLY the function BODY — the SDK wraps it in its own outer
  // `<ReturnType>? <name>(<args>) { ... }` signature automatically (every
  // reference example, e.g. references/custom_code_classes_and_functions_dsl.dart's
  // `statusLabel`, confirms this: `code:` starts directly with a `switch`/
  // `return` statement, never a repeated function declaration). All THREE
  // of this file's own customFunction declarations below (2 from §14,
  // still live; 1 just added for the R12 fix, already pushed) mistakenly
  // included a FULL redundant `String <name>(String? item) { ... }`
  // wrapper inside `code:` — matching the convention for `app.customAction`
  // (which DOES need a full signature), not `app.customFunction` (which
  // doesn't). The SDK then wrapped that already-complete function inside
  // ANOTHER same-named outer function, producing:
  //   String? reservationListItemResId(String? item) {
  //     String reservationListItemResId(String? item) { ...real logic... }
  //   }
  // — a local function declaration with no invoking call and no return
  // statement, which Dart silently compiles (no error, `String?` allows
  // falling off the end) and which ALWAYS returns null at runtime.
  // Confirmed empirically (not just reasoned about): ran this exact shape
  // through `dart run` standalone and verified it returns null every time.
  // Real-world impact: `reservationListItemLabel`/`reservationListItemResId`
  // have been broken since §14 — the reservation list's displayed text and
  // every row's `resId` navigation param have been null since that page
  // first shipped, meaning EVERY action on `ReservationDetail` reached via
  // the list (approve/decline/meetup/complete/review/cancel, all gated on
  // `resId.isEmpty` guards) has silently no-op'd this whole time. Fixed via
  // `updateCustomFunction` (same brownfield-update family as
  // `updateCustomAction`, used for `confirmStripePayment` above) with
  // BODY-ONLY code this time. Original declarations frozen in the same
  // push per this file's own established rule (a live payload mismatch
  // between an uncommented original declaration and a later update call
  // throws on the next push). Their captured handles are replaced with
  // locally-constructed `CustomFunctionHandle` stubs — a pure, compile-time-
  // only descriptor (confirmed by reading its own class in types.dart: just
  // name/args/returnType, no live proto tie) — never re-pushed, only used
  // to satisfy `CustomFunction(handle, ...)`'s typed API, the exact same
  // stub pattern this file already uses for a frozen `app.component`.
  //   app.customFunction(
  //     'reservationListItemLabel',
  //     args: {'item': string},
  //     returns: string,
  //     description: '予約一覧の1件分のデータ文字列を表示用ラベルに整形する。',
  //     code: r'''
  //   String reservationListItemLabel(String? item) {
  //     final parts = (item ?? '').split('|||');
  //     if (parts.length < 5) return '';
  //     final statusLabels = {
  //       'request_pending': 'リクエスト中',
  //       'authorized': '与信確保済み',
  //       'confirmed': '確定決済済み',
  //       'in_progress': '交流中',
  //       'completion_pending': '完了報告待ち',
  //       'review_pending': '評価待ち',
  //       'completed': '完了',
  //       'cancelled': 'キャンセル',
  //       'expired': '期限切れ',
  //     };
  //     final statusLabel = statusLabels[parts[1]] ?? parts[1];
  //     return '${parts[2]}　$statusLabel\n${parts[3]}　¥${parts[4]}';
  //   }
  //   ''',
  //   );
  //   app.customFunction(
  //     'reservationListItemResId',
  //     args: {'item': string},
  //     returns: string,
  //     description: '予約一覧の1件分のデータ文字列からres_idを取り出す。',
  //     code: r'''
  //   String reservationListItemResId(String? item) {
  //     final parts = (item ?? '').split('|||');
  //     return parts.isNotEmpty ? parts[0] : '';
  //   }
  //   ''',
  //   );
  //   app.customFunction(
  //     'reservationListItemCastId',
  //     args: {'item': string},
  //     returns: string,
  //     description: '予約一覧の1件分のデータ文字列から代表キャストのcast_idを取り出す。',
  //     code: r'''
  //   String reservationListItemCastId(String? item) {
  //     final parts = (item ?? '').split('|||');
  //     return parts.length > 5 ? parts[5] : '';
  //   }
  //   ''',
  //   );

  app.raw((project) {
    updateCustomFunction(
      project,
      name: 'reservationListItemLabel',
      code: r'''
final parts = (item ?? '').split('|||');
if (parts.length < 5) return '';
final statusLabels = {
  'request_pending': 'リクエスト中',
  'authorized': '与信確保済み',
  'confirmed': '確定決済済み',
  'in_progress': '交流中',
  'completion_pending': '完了報告待ち',
  'review_pending': '評価待ち',
  'completed': '完了',
  'cancelled': 'キャンセル',
  'expired': '期限切れ',
};
final statusLabel = statusLabels[parts[1]] ?? parts[1];
return '${parts[2]}　$statusLabel\n${parts[3]}　¥${parts[4]}';
''',
    );
    updateCustomFunction(
      project,
      name: 'reservationListItemResId',
      code: r'''
final parts = (item ?? '').split('|||');
return parts.isNotEmpty ? parts[0] : '';
''',
    );
    updateCustomFunction(
      project,
      name: 'reservationListItemCastId',
      code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 5 ? parts[5] : '';
''',
    );
  });

  final reservationListItemResIdFn = CustomFunctionHandle(
    name: 'reservationListItemResId',
    args: {'item': string},
    returnType: string,
  );
  final reservationListItemCastIdFn = CustomFunctionHandle(
    name: 'reservationListItemCastId',
    args: {'item': string},
    returnType: string,
  );

  // app.ensurePage — one-shot, CONFIRMED LANDED (ReservationListPage exists
  // live, per lib/flutterflow_project/pages/reservation_list_page.dart —
  // key Scaffold_00y3zobz). Frozen 2026-08-10, same fix as
  // BasicInfoRegistration/ConnectOnboarding above: once a page created by
  // ensurePage exists, its body becomes permanently inert (compiler.dart's
  // _compilePages skips already-matched pages) but the typed-SDK-authoring
  // validator still checks this body's raw `State(...)`/`SetState(...)`
  // references against LIVE server state on every future run — this exact
  // page would have hit the identical `Use
  // ff.Pages.reservationListPage.state.myReservationsList instead of
  // State(...)` failure on the very next unrelated push, the same way
  // BasicInfoRegistration/ConnectOnboarding already did. Caught here before
  // it could block the cast_profile.dart wiring push. Any future change to
  // this page's own content must go through
  // app.editPage(ff.Pages.reservationListPage, ...) instead.
  // The `reservationListItemLabelFn`/`reservationListItemResIdFn` custom
  // function declarations above stay live (declarative, safe to rerun
  // unchanged) even though this frozen body is their only consumer in this
  // script — they're still genuinely used by the already-pushed live page.
  //   app.ensurePage(
  //     'ReservationListPage',
  //     route: '/reservation-list',
  //     description: '自分が関わる予約の一覧ページ（ゲスト・キャスト共通、状態・日時・場所・金額を表示、タップで詳細へ）。',
  //     state: {'myReservationsList': listOf(string)},
  //     onLoad: [
  //       CallCustomAction.named(
  //         'fetchMyReservations',
  //         outputAs: 'myReservationsResult',
  //       ),
  //       SetState('myReservationsList', ActionOutput('myReservationsResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: '予約一覧'),
  //       body: ListView(
  //         source: State('myReservationsList'),
  //         shrinkWrap: true,
  //         padding: 16,
  //         spacing: 8,
  //         itemBuilder: (item) => Card(
  //           name: 'ReservationListItemCard',
  //           onTap: [
  //             Navigate(
  //               ff.Pages.reservationDetail,
  //               params: {
  //                 'resId': CustomFunction(
  //                   reservationListItemResIdFn,
  //                   args: {'item': item},
  //                 ),
  //               },
  //             ),
  //           ],
  //           child: Container(
  //             padding: 12,
  //             child: Text(
  //               CustomFunction(reservationListItemLabelFn, args: {'item': item}),
  //             ),
  //           ),
  //         ),
  //       ),
  //     ),
  //   );

  // ==========================================================================
  // payment_confirm.dart — confirmed entirely static (PROJECT_ANALYSIS.md:
  // "No triggers anywhere in this file, including the primary submit
  // button"), plus a real, pre-existing correctness bug in the native
  // `confirmStripePayment` custom action: its hardcoded Stripe publishable
  // key literally has the stray text `STRIPE_PUBLISHABLE_KEY=` baked into
  // the value (`'STRIPE_PUBLISHABLE_KEY=pk_test_...'` instead of just
  // `'pk_test_...'`) — the Stripe SDK would reject this outright. Fixed
  // here as the same minimal, scoped correction IMPLEMENTATION_PLAN.md's
  // own Phase 0 item describes ("strip the prefix"), not a broader rewrite
  // — a Stripe PUBLISHABLE key (unlike the secret key) is designed to ship
  // client-side, so this is a formatting bug fix, not a secrets-hygiene
  // issue.
  //
  // Scope, deliberately bounded: wires the main "予約を確定する" (confirm)
  // button only. The separate "カードを登録する"/"変更する" (register/change
  // card) buttons are left unwired — Stripe's own Payment Sheet (invoked by
  // `confirmStripePayment`) already includes its own native card-entry UI,
  // so a first payment works without a separate saved-card flow; that's a
  // real, disclosed simplification, not silently dropped scope. Also
  // doesn't fix the "Hello World" placeholder price texts (cosmetic, and
  // already flagged in PROJECT_ANALYSIS.md).
  // ==========================================================================

  app.raw((project) {
    updateCustomAction(
      project,
      name: 'confirmStripePayment',
      code: r'''
import '/custom_code/actions/index.dart';
import '/flutter_flow/custom_functions.dart';

// Additional imports
import 'package:flutter_stripe/flutter_stripe.dart';

Future<String?> confirmStripePayment(String clientSecret) async {
  try {
    // Set your Stripe publishable key (test mode)
    Stripe.publishableKey =
        'pk_test_51R7BeGR2VQ6GS3rfVe66XcFQRckis8u7cWcYtHnqOqJZw7ac0lmc8aS5SzFIZM8pAK0hUO0ZYuHQ3AeC0ZgJdnKD00ou7pId8U';
    Stripe.merchantIdentifier = 'merchant.com.icoccha.app';
    await Stripe.instance.applySettings();

    // Initialize the payment sheet
    await Stripe.instance.initPaymentSheet(
      paymentSheetParameters: SetupPaymentSheetParameters(
        paymentIntentClientSecret: clientSecret,
        merchantDisplayName: 'icoccha',
        style: ThemeMode.light,
      ),
    );

    // Present the payment sheet (card input UI)
    await Stripe.instance.presentPaymentSheet();

    return 'success';
  } on StripeException catch (e) {
    if (e.error.code == FailureCode.Canceled) {
      return 'canceled';
    }
    return 'error: ${e.error.localizedMessage ?? e.error.message}';
  } catch (e) {
    return 'error: ${e.toString()}';
  }
}
''',
    );
  });

  app.customAction(
    'getPaymentClientSecret',
    args: {'resId': string},
    returns: string,
    description: 'createPaymentIntent Cloud Functionを呼び出し、Stripe決済のclient_secretを取得する。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';

Future<String?> getPaymentClientSecret(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return null;
    final doc = await FirebaseFirestore.instance
        .collection('reservations')
        .doc(resId)
        .get();
    final data = doc.data();
    if (data == null) return null;
    final baseAmount = (data['base_amount'] as num?)?.toInt() ?? 0;
    final transportFee = (data['transport_fee'] as num?)?.toInt() ?? 0;
    final staffFee = (data['staff_fee'] as num?)?.toInt() ?? 0;
    final castIds =
        (data['cast_ids'] as List?)?.map((e) => e.toString()).toList() ??
            <String>[];

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('createPaymentIntent');
    final result = await callable.call({
      'res_id': resId,
      'amount': baseAmount,
      'transport_fee': transportFee,
      'staff_fee': staffFee,
      'cast_ids': castIds,
    });
    if (result.data is Map && result.data['client_secret'] != null) {
      return result.data['client_secret'] as String;
    }
    return null;
  } catch (e) {
    return null;
  }
}
''',
  );

  app.customAction(
    'isPaymentSuccess',
    args: {'value': string},
    returns: bool_,
    description: 'confirmStripePaymentの結果文字列が成功を示すか確認する。',
    code: r'''
Future<bool> isPaymentSuccess(String? value) async {
  return value == 'success';
}
''',
  );

  app.editPageParams(ff.Pages.paymentConfirm, (params) {
    params.ensureParam('resId', string.withDefault(''));
  });

  app.editPage(ff.Pages.paymentConfirm, (page) {
    page.ensureActions(
      page.findByKey('Button_0qmju6dw'), // 予約を確定する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'getPaymentClientSecret',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'clientSecretResult',
        ),
        CallCustomAction.named(
          'isNonEmptyString',
          arguments: {'value': ActionOutput('clientSecretResult')},
          outputAs: 'clientSecretObtained',
        ),
        If(
          ActionOutput('clientSecretObtained'),
          then: [
            CallCustomAction.named(
              'confirmStripePayment',
              arguments: {'clientSecret': ActionOutput('clientSecretResult')},
              outputAs: 'stripePaymentResult',
            ),
            CallCustomAction.named(
              'isPaymentSuccess',
              arguments: {'value': ActionOutput('stripePaymentResult')},
              outputAs: 'paymentSucceeded',
            ),
            If(
              ActionOutput('paymentSucceeded'),
              // FIX (confirmed critical live bug, found during audit):
              // this used to just pop back (to ReservationForm, since
              // that's now what pushes this page) — the guest would land
              // right back on the empty booking form after successfully
              // paying, with no confirmation screen at all. Forwards to
              // ReservationConfirmed instead, completing the intended
              // ReservationForm -> PaymentConfirm -> ReservationConfirmed
              // chain.
              then: [
                Snackbar('お支払いが完了しました。'),
                Navigate(
                  ff.Pages.reservationConfirmed,
                  replaceRoute: true,
                  params: {'resId': PageParam('resId')},
                ),
              ],
              orElse: [Snackbar('決済がキャンセルされたか失敗しました。')],
            ),
          ],
          orElse: [Snackbar('決済情報の取得に失敗しました。もう一度お試しください。')],
        ),
      ],
    );
  });

  // ==========================================================================
  // cast_profile.dart — the shared convergence point every reservation
  // originates from, but its own two invite buttons ("誘う"/"ココ店で誘う")
  // had zero triggers at all (confirmed via the typed SDK — no `triggers:`
  // entry on either Button_snz4hqcj/Button_z76lh1eh), leaving §12's already
  // fully-wired reservation_form.dart with no real entry point. This closes
  // that gap: both invite buttons now navigate into ReservationForm with a
  // real castId.
  //
  // Scope, deliberately bounded and disclosed, not silently narrowed: this
  // page itself has NO params today (confirmed — `CastProfileParams` is
  // empty) and its entire body is static hardcoded mock content (name
  // "ゆずき", region "東京都 港区", etc. — no `State(...)`/document binding
  // anywhere in the tree), i.e. this page isn't bound to a real cast
  // document yet either — wiring that up is Phase 3 (discovery/profile
  // core) work, not started this session. Adding a `castId` PARAM here
  // (the same safe-default pattern already used for reservation_form.dart's
  // own `castId`) makes this page ready to receive a real value the moment
  // a future discovery/match-feed page navigates here with one, and
  // forwards whatever it currently has — so the chain becomes complete as
  // soon as that upstream piece exists, with no further change needed here.
  // Both "誘う" and "ココ店で誘う" are wired identically (both navigate to the
  // same reservation_form). IMPLEMENTATION_PLAN.md DOES track a venue-based
  // invite concept (`CocoTenDetailPage`'s own "invite from this venue"
  // entry point, line 394, Phase 3, not built) — but that's a DIFFERENT,
  // venue-first flow reached by browsing a CocoTen venue, not a second
  // behavior for these two CAST-profile-page buttons (both of which invite
  // THIS SAME cast; "ココ店で誘う" most plausibly differs only in an eventual
  // meeting-location default, not a separate destination page). Nothing
  // specifies a distinct concrete behavior for cast_profile.dart's own two
  // buttons specifically, so routing both to the one real, functional
  // reservation entry point is the correct minimal choice — inventing a
  // second destination with no source-document backing would violate this
  // project's own "don't guess product content" rule.
  // ==========================================================================

  app.editPageParams(ff.Pages.castProfile, (params) {
    params.ensureParam('castId', string.withDefault(''));
  });

  app.editPage(ff.Pages.castProfile, (page) {
    // Both buttons had zero existing triggerActions — ensureActions is safe
    // to use directly, no existing chain to risk losing.
    page.ensureActions(
      page.findByKey('Button_snz4hqcj'), // 誘う
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        Navigate(
          ff.Pages.reservationForm,
          params: {'castId': PageParam('castId')},
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Button_z76lh1eh'), // ココ店で誘う
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        Navigate(
          ff.Pages.reservationForm,
          params: {'castId': PageParam('castId')},
        ),
      ],
    );
  });

  // ==========================================================================
  // Fix `preflight`'s "List has a backend query but no child widget binds to
  // list item data" failure on MacchaChats — discovered blocking EVERY push
  // to this project (unrelated to any work in this file; MacchaChats was
  // never touched before this). Investigated before patching rather than
  // blindly binding the flagged widget, since the obvious-looking fix here
  // would have been wrong:
  //
  // `ListView_84hpa09g`'s native `databaseRequest` queries the top-level
  // `chats` collection (chat_room_id/created_at/sender_id/text, per
  // schemas.dart), unfiltered — no `where` clause at all. Three independent
  // checks confirm this query is dead, not just unwired:
  //   1. `firebase/firestore.rules` has NO rule for `chats` at all (and no
  //      catch-all default-allow either) — Firestore denies-by-default, so
  //      this query already returns permission-denied for every real user.
  //   2. `grep -rn "collection('chats')" firebase/functions/src/*.ts` — zero
  //      matches. No backend code has EVER written to this collection.
  //   3. `firestore.rules`' own `chat_rooms` rule comment states the REAL
  //      chat storage is the `chat_rooms/{room_id}/messages` SUBcollection
  //      (created by reservations.ts) — a completely different, already-
  //      established data model from the flat `chats` collection this query
  //      targets. `MacchaChatsParams` is also empty (no room-scoping param
  //      exists), so even a working query here couldn't be scoped to one
  //      conversation.
  //
  // Binding a child to `ItemRef()['text']` against this query (the
  // surface-level fix) would satisfy the lint but stay functionally dead —
  // permission-denied/empty at runtime — while LOOKING wired, worse than
  // today's honest static mockup. The correct fix is what the validator's
  // own source (`_checkListWiring` in the SDK's wiring_review.dart) already
  // anticipates: `if (!node.hasDatabaseRequest()) continue` — a list with NO
  // query attached is simply out of this check's scope. Clearing the
  // orphaned query leaves the existing static 2-bubble mockup content
  // exactly as it already renders today (this page was never functional
  // chat UI to begin with — no room param, no real query, no backend
  // writer), just without a broken, invisible, unfilterable query attached
  // to it. Real chat wiring (room-scoped `chat_rooms/{id}/messages` reads,
  // a `roomId` page param, real navigation into a specific conversation) is
  // a genuine future feature build, not something to improvise here.
  //
  // `mutateNode`'s `clearDatabaseRequest()` is a pure field-clear — safe to
  // leave live and rerun on every future push (idempotent: clearing an
  // already-empty field is a no-op), unlike `ensureReplaced`/similar
  // structural ops that need freezing after landing.
  //
  // FROZEN (2026-08-11, Phase 6): `ListView_84hpa09g` no longer exists —
  // Phase 6's own `ensureReplaced` on this exact widget (see that block's
  // comment) removed the old key entirely and gave the replacement a new
  // one. The "safe to rerun forever" reasoning above held only as long as
  // the TARGET KEY still existed; once `ensureReplaced` consumes a key,
  // every other reference to that key anywhere else in this script breaks
  // too, not just a second `ensureReplaced` attempt on it — confirmed the
  // hard way (`Bad state: page MacchaChats findByKey("ListView_84hpa09g")
  // found no matches.` on the very next push after Phase 6 landed).
  // ==========================================================================
  //   app.editPage(ff.Pages.macchaChats, (page) {
  //     page.mutateNode(page.findByKey('ListView_84hpa09g'), (node) {
  //       node.clearDatabaseRequest();
  //     });
  //   });

  // ==========================================================================
  // Fix R12 (`reviewWiring`'s navigation-param-completeness check):
  // `Navigates to ReservationDetail but may be missing optional param
  // "castId"` — ReservationListPage's row card only ever passed `resId`,
  // never `castId`, since `fetchMyReservations` (above, now updated) didn't
  // fetch `cast_ids` in the first place. Warning-severity, not blocking
  // (`castId` is `.withDefault('')` everywhere), but a real, fixable UX gap:
  // reaching ReservationDetail from the list (rather than a request
  // notification) and tapping "評価する" would silently fail
  // `callSubmitReview`'s existing `castId.isEmpty` guard (§13) instead of
  // actually submitting.
  //
  // `Card_wf69s6in` is `ReservationListPage.body[0].children[0]` — the
  // ORIGINAL onTap (only `resId`) was authored inside the page's own
  // ensurePage itemBuilder, now permanently frozen (see that block's own
  // comment). `page.ensureActions` on this ONE isolated widget's own
  // trigger safely replaces its whole chain (proven pattern throughout this
  // file for single, non-shared triggers). `ItemRef()` — confirmed by
  // reading the SDK source directly (`itemBuilder(const ItemRef())` in
  // widgets.dart) — is the EXACT SAME expression the `item` closure
  // parameter always was, so passing it here (outside any itemBuilder
  // closure) to the SAME two custom functions reproduces the original
  // resId wiring byte-for-byte, correctly resolving against this Card's
  // enclosing ListView.
  // ==========================================================================
  app.editPage(ff.Pages.reservationListPage, (page) {
    page.ensureActions(
      page.findByKey('Card_wf69s6in'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        Navigate(
          ff.Pages.reservationDetail,
          params: {
            'resId': CustomFunction(
              reservationListItemResIdFn,
              args: {'item': ItemRef()},
            ),
            'castId': CustomFunction(
              reservationListItemCastIdFn,
              args: {'item': ItemRef()},
            ),
          },
        ),
      ],
    );
  });

  // ==========================================================================
  // Fix: BasicInfoRegistration's submit button had NO field-completeness
  // check at all — only consent. See `checkBasicInfoFieldsComplete`'s own
  // declaration comment above for the full finding (a malformed/empty
  // birthDate silently produces a WRONG age_group server-side, not just a
  // missing-field UX gap) and why field-completeness + consent are
  // combined into ONE gate rather than 2 separately-nested `If`s (this
  // DSL's confirmed 2-level nesting ceiling).
  //
  // `Button_npmkhs0n` (SubmitBasicInfoButton) is the ONE isolated trigger
  // being replaced wholesale here — safe per this file's own established
  // `ensureActions`-on-a-single-widget precedent — its prior chain (bare
  // `If(State('consentAgreed'), then: [callCompleteOnboarding, If(...)],
  // orElse: [...])`, landed via the now-frozen ensurePage body) is fully
  // superseded, not extended.
  // ==========================================================================
  app.editPage(ff.Pages.basicInfoRegistration, (page) {
    page.ensureActions(
      page.findByKey('Button_npmkhs0n'), // SubmitBasicInfoButton
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'checkBasicInfoFieldsComplete',
          arguments: {
            'accountType': State('accountType'),
            'gender': State('gender'),
            'birthDate': State('birthDate'),
            'prefecture': State('prefecture'),
            'city': State('city'),
            'consentAgreed': State('consentAgreed'),
          },
          outputAs: 'basicInfoValidResult',
        ),
        If(
          ActionOutput('basicInfoValidResult'),
          then: [
            CallCustomAction.named(
              'callCompleteOnboarding',
              arguments: {
                'accountType': State('accountType'),
                'gender': State('gender'),
                'birthDate': State('birthDate'),
                'prefecture': State('prefecture'),
                'city': State('city'),
                'activityPrefecture': State('activityPrefecture'),
                'activityCity': State('activityCity'),
                'staffType': State('staffType'),
                'referralCode': State('referralCode'),
              },
              outputAs: 'completeOnboardingResult',
            ),
            If(
              ActionOutput('completeOnboardingResult'),
              then: [Navigate('Kyc', replaceRoute: true)],
              orElse: [Snackbar('登録に失敗しました。もう一度お試しください。')],
            ),
          ],
          orElse: [
            Snackbar('必須項目の入力（生年月日はYYYY-MM-DD形式）と利用規約への同意が必要です。'),
          ],
        ),
      ],
    );
  });

  // Fix R19 (`reviewWiring`'s dynamic-ListView-shrinkWrap check), flagged
  // since §15 but deferred as "minor, real execution risk to fix via raw
  // proto." Now confirmed low-risk: `ListView_kardnjc6` is
  // `ReservationListPage`'s own dynamic, State-driven list (built in §14)
  // — `shrinkWrapValue` was left at its native-scaffold default of `true`,
  // which forces the list to size to its full content up front instead of
  // lazily building visible items, the exact anti-pattern this project's
  // own Design & Quality Rules calls out ("avoid shrinkWrap: true on
  // dynamic ListView"). Unnecessary here specifically: this ListView is
  // the Scaffold's direct body (not nested inside another scrollable
  // Column), so it doesn't need shrinkWrap to get a bounded height at all.
  // `node.props.listView.shrinkWrapValue` confirmed via the proto schema
  // directly (`FFWidgetProperties.listView` -> `FFListView.shrinkWrapValue`,
  // a plain `FFBooleanValue`) — same class of pure field-set as
  // `clearDatabaseRequest()` above, safe to leave live/rerun (idempotent).
  app.editPage(ff.Pages.reservationListPage, (page) {
    page.mutateNode(page.findByKey('ListView_kardnjc6'), (node) {
      node.props.listView.shrinkWrapValue = FFBooleanValue(inputValue: false);
    });
  });

  // ==========================================================================
  // IMPLEMENTATION_PLAN.md Phase 2's own explicit [NEXT] item — the admin-
  // side KYC approve/reject action, pulled forward from Phase 12 since
  // Phase 2's manual-review KYC flow can't be tested end-to-end without it.
  //
  // Real, non-obvious finding made BEFORE writing any DSL: the plan's own
  // note ("backend callable already exists, only the UI trigger is
  // missing") was incomplete. `adminApproveKYC` (the mutation) exists, but
  // fetching the LIST of pending-review users has no client-safe path at
  // all — `firestore.rules`' own `users` collection rule is
  // `allow read: if request.auth.uid == document` (owner-only, no admin
  // exception whatsoever), so a direct client Firestore query for
  // `kyc_status == 'submitted'` across all users would be rejected outright
  // for every caller, admin or not. Checked for a fix before assuming one
  // was needed: `adminGetUsers` (already deployed, already used elsewhere
  // in admin.ts) ALREADY supports a `kyc_status` filter and already returns
  // full user documents (`{id, ...doc.data()}`, including `kyc_doc_url`/
  // `kyc_selfie_url`/`nickname`/`account_type`) — no new backend function
  // needed, just call it with `{kyc_status: 'submitted'}`. This also avoids
  // loosening `firestore.rules` for a broader admin-read exception, keeping
  // this consistent with the established pattern already used throughout
  // `admin.ts` (every admin list/read goes through a callable, never a
  // direct relaxed client rule).
  //
  // Same delimited-string + custom-function-extraction pattern already
  // proven for ReservationListPage (§14) — `users` IS a real Firestore
  // collection, but `adminGetUsers`' response is a bare JSON map, not a
  // typed FirestoreQuery result, so `ItemRef['field']` isn't available here
  // either (same reasoning as §14's own choice). Every customFunction body
  // below is BODY-ONLY (no repeated signature) — the exact §22 lesson,
  // applied deliberately this time rather than rediscovered the hard way.
  //
  // Scope, deliberately minimal per the plan's own "minimal slice" framing:
  // one standalone page, reachable by direct route (no admin-panel shell/
  // navigation — that's the full, not-yet-started Phase 12). A simple
  // client-side "is this signed-in user an admin" check gates the visible
  // content (a UX nicety, NOT the real security boundary — both backend
  // callables independently enforce `role == 'admin'`/`role_admin ==
  // 'admin'` via `verifyAdmin` regardless of what this page shows). Reject
  // uses the backend's own sensible default reason text (no reason-input
  // UI built) — genuinely minimal, not corner-cut: the approve/reject
  // ACTION and its real data are fully functional either way.
  // ==========================================================================

  app.customAction(
    'checkIsAdminUser',
    returns: bool_,
    description: '現在のユーザーが管理者権限を持つか確認する（UI表示の出し分け用。実際の権限チェックはCloud Function側で必須）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> checkIsAdminUser() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return false;
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final data = doc.data();
    if (data == null) return false;
    return data['role'] == 'admin' ||
        data['role_admin'] == 'admin' ||
        data['roleAdmin'] == 'admin';
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callAdminGetPendingKyc',
    returns: listOf(string),
    description: 'adminGetUsers Cloud Functionを呼び出し、審査待ち（kyc_status=submitted）ユーザー一覧を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> callAdminGetPendingKyc() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminGetUsers');
    final result = await callable.call({'kyc_status': 'submitted'});
    if (result.data is! Map || result.data['users'] is! List) return <String>[];
    final users = result.data['users'] as List;
    return users.map((u) {
      final m = u as Map;
      final uid = m['id']?.toString() ?? '';
      final nickname = (m['nickname']?.toString() ?? '').replaceAll('|||', '');
      final accountType = m['account_type']?.toString() ?? '';
      final docUrl = m['kyc_doc_url']?.toString() ?? '';
      final selfieUrl = m['kyc_selfie_url']?.toString() ?? '';
      return '$uid|||$nickname|||$accountType|||$docUrl|||$selfieUrl';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callAdminApproveKyc',
    args: {'userId': string, 'approved': bool_},
    returns: bool_,
    description: 'adminApproveKYC Cloud Functionを呼び出し、本人確認書類を承認/却下する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callAdminApproveKyc(String? userId, bool? approved) async {
  try {
    if (userId == null || userId.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminApproveKYC');
    final result = await callable.call({
      'user_id': userId,
      'approved': approved ?? false,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Return values not captured — their only consumer, the frozen
  // ensurePage body below, is commented out. Declarations stay
  // live/uncommented since they're still genuinely used by the
  // already-pushed live page (same pattern as §18's own cleanup).
  app.customFunction(
    'kycReviewItemUid',
    args: {'item': string},
    returns: string,
    description: '審査待ちKYC一覧の1件分のデータ文字列からuser_idを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.isNotEmpty ? parts[0] : '';
''',
  );

  app.customFunction(
    'kycReviewItemNickname',
    args: {'item': string},
    returns: string,
    description: '審査待ちKYC一覧の1件分のデータ文字列からニックネームを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 1 ? parts[1] : '';
''',
  );

  app.customFunction(
    'kycReviewItemAccountType',
    args: {'item': string},
    returns: string,
    description: '審査待ちKYC一覧の1件分のデータ文字列からアカウント種別を取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 2 ? parts[2] : '';
''',
  );

  app.customFunction(
    'kycReviewItemDocUrl',
    args: {'item': string},
    returns: string,
    description: '審査待ちKYC一覧の1件分のデータ文字列から本人確認書類URLを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 3 ? parts[3] : '';
''',
  );

  app.customFunction(
    'kycReviewItemSelfieUrl',
    args: {'item': string},
    returns: string,
    description: '審査待ちKYC一覧の1件分のデータ文字列から顔写真URLを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 4 ? parts[4] : '';
''',
  );

  // app.ensurePage — one-shot, CONFIRMED LANDED (KycReviewPage exists live,
  // pushed as commit E6MqezURCGa8VPTvbe7J, verified via
  // generated_code/lib/kyc_review_page/ and a direct grep of the pushed
  // widget confirming callAdminApproveKyc/callAdminGetPendingKyc/the
  // approve+reject buttons are all correctly wired). Frozen 2026-08-10,
  // IMMEDIATELY after landing rather than in a later pass — caught via a
  // follow-up `flutterflow ai validate` (the same NO_OP-triggering
  // full-project-review trick from §21) which failed with `Use
  // ff.Pages.kycReviewPage.state.isAdminUser instead of State(...)` — the
  // EXACT `ensurePage`-body-inert failure mode already documented at
  // length earlier this session (§9/§10, BasicInfoRegistration;
  // ConnectOnboarding; ReservationListPage) — repeated here despite having
  // just written that lesson up, a reminder that documenting a quirk
  // doesn't automatically prevent re-making it under time pressure on a
  // large new page. Any FUTURE change to this page's own content must go
  // through app.editPage(ff.Pages.kycReviewPage, ...) instead.
  //   app.ensurePage(
  //     'KycReviewPage',
  //     route: '/kyc-review',
  //     description: '管理者向けKYC書類審査ページ（提出済みユーザーの一覧表示、承認/却下）。',
  //     state: {
  //       'pendingKycList': listOf(string),
  //       'isAdminUser': bool_.withDefault(false),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('checkIsAdminUser', outputAs: 'isAdminResult'),
  //       SetState('isAdminUser', ActionOutput('isAdminResult')),
  //       CallCustomAction.named('callAdminGetPendingKyc', outputAs: 'pendingKycResult'),
  //       SetState('pendingKycList', ActionOutput('pendingKycResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'KYC審査'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 12,
  //         children: [
  //           Text(
  //             '管理者権限がありません。',
  //             style: Styles.bodyMedium,
  //             visible: Equals(State('isAdminUser'), false),
  //           ),
  //           ListView(
  //             source: State('pendingKycList'),
  //             visible: State('isAdminUser'),
  //             padding: 16,
  //             spacing: 16,
  //             itemBuilder: (item) => Card(
  //               name: 'KycReviewItemCard',
  //               child: Container(
  //                 padding: 12,
  //                 child: Column(
  //                   spacing: 8,
  //                   children: [
  //                     Text(
  //                       CustomFunction(kycReviewItemNicknameFn, args: {'item': item}),
  //                       style: Styles.titleMedium,
  //                     ),
  //                     Text(
  //                       CustomFunction(kycReviewItemAccountTypeFn, args: {'item': item}),
  //                       style: Styles.labelMedium,
  //                     ),
  //                     Row(
  //                       spacing: 8,
  //                       children: [
  //                         Image(
  //                           CustomFunction(kycReviewItemDocUrlFn, args: {'item': item}),
  //                           width: 140,
  //                           height: 140,
  //                           fit: ImageFit.cover,
  //                           name: 'KycReviewDocImage',
  //                         ),
  //                         Image(
  //                           CustomFunction(kycReviewItemSelfieUrlFn, args: {'item': item}),
  //                           width: 140,
  //                           height: 140,
  //                           fit: ImageFit.cover,
  //                           name: 'KycReviewSelfieImage',
  //                         ),
  //                       ],
  //                     ),
  //                     Row(
  //                       spacing: 8,
  //                       children: [
  //                         Button(
  //                           '承認する',
  //                           color: Colors.success,
  //                           textColor: Colors.primaryBackground,
  //                           name: 'KycApproveButton',
  //                           onTap: [
  //                             CallCustomAction.named(
  //                               'callAdminApproveKyc',
  //                               arguments: {
  //                                 'userId': CustomFunction(kycReviewItemUidFn, args: {'item': item}),
  //                                 'approved': true,
  //                               },
  //                               outputAs: 'approveResult',
  //                             ),
  //                             If(
  //                               ActionOutput('approveResult'),
  //                               then: [
  //                                 CallCustomAction.named(
  //                                   'callAdminGetPendingKyc',
  //                                   outputAs: 'refreshedKycResult',
  //                                 ),
  //                                 SetState('pendingKycList', ActionOutput('refreshedKycResult')),
  //                                 Snackbar('承認しました。'),
  //                               ],
  //                               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
  //                             ),
  //                           ],
  //                         ),
  //                         Button(
  //                           '却下する',
  //                           color: Colors.error,
  //                           textColor: Colors.primaryBackground,
  //                           name: 'KycRejectButton',
  //                           onTap: [
  //                             CallCustomAction.named(
  //                               'callAdminApproveKyc',
  //                               arguments: {
  //                                 'userId': CustomFunction(kycReviewItemUidFn, args: {'item': item}),
  //                                 'approved': false,
  //                               },
  //                               outputAs: 'rejectResult',
  //                             ),
  //                             If(
  //                               ActionOutput('rejectResult'),
  //                               then: [
  //                                 CallCustomAction.named(
  //                                   'callAdminGetPendingKyc',
  //                                   outputAs: 'refreshedKycResult2',
  //                                 ),
  //                                 SetState('pendingKycList', ActionOutput('refreshedKycResult2')),
  //                                 Snackbar('却下しました。'),
  //                               ],
  //                               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
  //                             ),
  //                           ],
  //                         ),
  //                       ],
  //                     ),
  //                   ],
  //                 ),
  //               ),
  //             ),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // REAL BUG found and fixed 2026-08-10, during a self-review of §26's own
  // work before proceeding further: `KycReviewPage`'s ListView
  // (`ListView_ohcx81fg`) sits directly inside a `Column`
  // (`body: Column(children: [Text(...), ListView(...)])`), NOT as the
  // Scaffold's own direct body the way `ReservationListPage`'s ListView is
  // — confirmed by reading `lib/flutterflow_project/pages/kyc_review_page.dart`
  // directly (`KycReviewPage.body[0]` is the Column, the ListView is
  // `body[0].children[1]`, one level deeper). §26's own code comment
  // ("shrinkWrap deliberately NOT set... not nested inside another
  // scrollable") was WRONG about this page's actual structure — it IS
  // nested inside a Column, and a bare Column gives its children UNBOUNDED
  // height in the main axis (no `Expanded`/`Flexible` wraps this ListView),
  // which a `ListView` without `shrinkWrap: true` cannot render under —
  // this would throw Flutter's "vertical viewport was given unbounded
  // height" assertion at runtime the first time any admin actually opened
  // this page. Confirmed by reading the regenerated
  // `kyc_review_page_widget.dart` directly: the `ListView.separated` sits
  // inside a bare `Padding`/`Builder` with no `Expanded` anywhere in its
  // ancestry back up to the `Column`. This is the CORRECT, opposite
  // application of §25's own R19 fix, not a contradiction of it — the
  // underlying rule is "shrinkWrap is needed when nested inside a
  // non-bounding container, unnecessary as a Scaffold's own direct body";
  // §25 was the latter case, this is genuinely the former. Fixed via the
  // same proto field already used in §25 (`node.props.listView.
  // shrinkWrapValue`), this time set to `true`.
  //
  // Accepted trade-off, considered rather than defaulted into: `shrinkWrap:
  // true` re-triggers R19's own performance warning (eager-builds every
  // item instead of lazy virtualization) — the more scalable fix would
  // wrap the ListView in `Expanded` instead, letting it participate in the
  // Column's flex layout for true lazy scrolling. Not done here: this is
  // an admin-only review queue bounded to `adminGetUsers`' own default
  // `limit: 50` (§26), used by internal staff, not a customer-facing
  // infinite list — the eager-load cost for at most 50 rows is acceptable,
  // and `Expanded` would require reconstructing the entire ListView
  // (including its 6-widget itemBuilder template) via `ensureReplaced`,
  // real added risk to an already-verified-working template for a
  // performance concern the page's own bounded scale makes minor. Revisit
  // if this queue's scale assumption changes (e.g. `limit` is raised or
  // pagination is added later, per §26's own disclosed "not done" list).
  // SUPERSEDED (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): §63's no-photo-fallback rollout later reconstructed this SAME
  // `ListView_ohcx81fg` from scratch via `ensureReplaced` (to add the doc/
  // selfie image fallbacks) — that reconstruction's own literal already
  // carries `shrinkWrap: true` forward explicitly (confirmed), so this
  // mutateNode's fix is preserved, just applied at the new call site
  // instead. This mutateNode now targets a key that no longer exists
  // (confirmed — it hard-failed the review-pass push with `findByKey(
  // "ListView_ohcx81fg") found no matches` until frozen here) and is inert.
  // app.editPage(ff.Pages.kycReviewPage, (page) {
  //   page.mutateNode(page.findByKey('ListView_ohcx81fg'), (node) {
  //     node.props.listView.shrinkWrapValue = FFBooleanValue(inputValue: true);
  //   });
  // });

  // SECOND real bug found on the SAME second re-review pass, immediately
  // after the shrinkWrap fix above: fixing the crash by setting
  // `shrinkWrap: true` only weighed R19's PERFORMANCE cost (eager-loading)
  // — it missed a more serious functional consequence. `shrinkWrap: true`
  // makes the ListView size itself to its own CONTENT height rather than
  // filling/clipping to the viewport, and this page's outer structure
  // (`Scaffold > SafeArea > Padding > Column(mainAxisSize: min)`, confirmed
  // via a direct read of the regenerated widget) has NO
  // `SingleChildScrollView`/scrolling wrapper anywhere above the ListView.
  // With more than a screen's worth of pending KYC cards (each a
  // substantial 2-image + text + 2-button card — realistically a handful
  // of items, well short of the 50-item cap), the Column would overflow
  // the screen with NO way to scroll to the rest — not a crash this time,
  // but a real, confirmed usability dead-end (Flutter's own
  // "RenderFlex overflowed" clipping, content genuinely inaccessible, not
  // just an ugly warning).
  //
  // Fixed via the SAME low-risk single-property-mutation technique as the
  // two ListView fixes above, avoiding any need to reconstruct the page's
  // item template: `Column`'s DSL-level `scrollable:` parameter (already
  // used natively in `reservation_form.dart`'s own body) compiles down to
  // a plain (non-deprecated, confirmed via the proto schema directly)
  // `props.column.scrollable` bool — set directly on the page's own outer
  // body Column (`Column_wfyfe069`, confirmed via
  // lib/flutterflow_project/pages/kyc_review_page.dart), making the WHOLE
  // page (the "no permission" text plus the now-content-sized list)
  // scroll together as one unit whenever it exceeds the viewport. This is
  // the standard, already-proven-elsewhere fix for "shrink-wrapped
  // ListView with no ancestor scroll view" — not a new pattern invented
  // for this page.
  app.editPage(ff.Pages.kycReviewPage, (page) {
    page.mutateNode(page.findByKey('Column_wfyfe069'), (node) {
      node.props.column.scrollable = true;
    });
  });

  // ==========================================================================
  // IMPLEMENTATION_PLAN.md Phase 4's own remaining item: status-driven
  // button VISIBILITY on reservation_detail.dart — flagged since §13 as "a
  // UX gap, not a safety one" (the backend already rejects invalid
  // transitions cleanly). Chosen as the next step in the absence of an
  // answer on which phase to pursue (asked twice, not answered) — smaller
  // and lower-risk than starting Phase 5.
  //
  // Read every backend function's own precondition before designing this,
  // rather than assuming a uniform rule:
  //   - respondToReservation: explicitly rejects unless
  //     status in {authorized, cast_pending}, cast-only (cast_ids match).
  //   - reportCompletion: explicitly rejects unless status == in_progress,
  //     cast-only.
  //   - confirmMeetup / submitReview: NO explicit status precondition in
  //     the backend at all (confirmed by reading both functions in full) —
  //     confirmMeetup allows guest OR cast at any status; submitReview only
  //     checks `uid == guest_id`. Gated here to their semantically correct
  //     statuses (confirmed / review_pending) anyway — showing "合流報告"
  //     during e.g. `completed` or "評価する" during `request_pending`
  //     would be confusing regardless of the backend's own leniency, and a
  //     stray tap wouldn't corrupt data (submitReview would just skip
  //     several status transitions), but it's still worth preventing in
  //     the UI.
  //   - cancelPayment: no explicit REJECTING precondition either (fee
  //     percentage varies by status instead) — gated here to exclude only
  //     the 3 genuinely-terminal statuses (completed/cancelled/expired),
  //     where cancelling doesn't make sense regardless of backend leniency.
  //
  // Also closes a related, real gap this task's own "status-driven" framing
  // doesn't name but is squarely part of the same problem: NONE of these 6
  // buttons were gated by ROLE either — a guest viewing their own sent
  // request currently sees "承認する"/"断る" (cast-only actions) and would
  // get a clean but confusing permission-denied error on tap. Fixed
  // together as one coherent visibility rule per button (status AND role),
  // not status-only, since shipping status-only would leave the
  // role-mixup as an equally-real, freshly-noticed gap.
  //
  // One shared Firestore read (`fetchReservationVisibility`, on page load)
  // rather than 6 redundant per-button reads — encodes
  // `status|||isGuest|||isCast` as a delimited string (same established
  // pattern as `fetchMyReservations`/KycReviewPage above), with 5 small
  // customFunctions (body-only — the §22 lesson) each checking the
  // condition for one button or button-pair. `respondToReservation`'s
  // approve/decline share `canRespondToReservation` since they're
  // literally the same backend precondition.
  //
  // Native buttons reconstructed via `ensureReplaced` (adding `visible:`)
  // rather than left in place, since `EditWidgetPatch.visible()` only
  // accepts a static bool (confirmed by reading edit.dart's own SDK
  // source: `bool? _visible`) — no typed patch path exists for a dynamic
  // per-status expression. Colors/dimensions read directly from the
  // regenerated widget (`Color(0xFF4461FD)` etc.) and reproduced via
  // `Colors.hex(...)` to minimize visual drift — same "same semantic,
  // different visual" trade-off already accepted elsewhere this session
  // (SwitchListTile -> Checkbox), each button's own onTap chain preserved
  // byte-for-byte from its existing, already-proven-working wiring.
  // ==========================================================================

  app.editPageState(ff.Pages.reservationDetail, (state) {
    state.ensureField('resVisibilityData', string.withDefault(''));
  });

  app.customAction(
    'fetchReservationVisibility',
    args: {'resId': string},
    returns: string,
    description: '予約の現在ステータスと閲覧者の役割（ゲスト/キャスト）を取得し、ボタン表示制御用データを返す。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String?> fetchReservationVisibility(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return '';
    final uid = currentUserUid;
    final doc = await FirebaseFirestore.instance
        .collection('reservations')
        .doc(resId)
        .get();
    final data = doc.data();
    if (data == null) return '';
    final status = data['status']?.toString() ?? '';
    final guestId = data['guest_id']?.toString() ?? '';
    final castIds = (data['cast_ids'] as List?)
            ?.map((e) => e.toString())
            .toList() ??
        <String>[];
    final isGuest = uid.isNotEmpty && uid == guestId;
    final isCast = uid.isNotEmpty && castIds.contains(uid);
    return '$status|||$isGuest|||$isCast';
  } catch (e) {
    return '';
  }
}
''',
  );

  app.customFunction(
    'canRespondToReservation',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約を承認/辞退できるか判定する（キャストかつauthorized/cast_pending状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isCast = parts[2] == 'true';
return isCast && (status == 'authorized' || status == 'cast_pending');
''',
  );

  // CORRECTION (comprehensive review pass, 2026-08-12): an earlier audit
  // this round claimed this function had "zero live references anywhere"
  // and queued it for removal via `app.removeCustomFunction` — that check
  // only grepped this DSL SCRIPT's own text (where indeed nothing calls it
  // by name), not the actual deployed project. `flutterflow ai run`
  // rejected the removal outright with "Custom function not found" /
  // compile failure, and a direct grep of `generated_code/` confirmed why:
  // `reservation_detail_widget.dart` gates the meetup-confirmation button's
  // `visible:` on `functions.canConfirmReservationMeetup(...)` — wired via
  // an earlier, since-frozen `ensureReplaced`/similar block whose own text
  // no longer names this function directly. Genuinely live; NOT dead code.
  // Restored below exactly as it was. Second confirmed false-positive this
  // review round (see PROJECT_KNOWLEDGE.md §54) — caught here by
  // `flutterflow ai run`'s own validation before anything actually pushed,
  // not by inspection alone.
  app.customFunction(
    'canConfirmReservationMeetup',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約の合流報告ができるか判定する（confirmed状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isGuest = parts[1] == 'true';
final isCast = parts[2] == 'true';
return (isGuest || isCast) && status == 'confirmed';
''',
  );

  // CORRECTION (comprehensive review pass, 2026-08-12): same false-positive
  // finding as `canConfirmReservationMeetup` above — `generated_code/`
  // confirms `reservation_detail_widget.dart` gates the completion-report
  // button's `visible:` on `functions.canReportReservationCompletion(...)`.
  // Restored exactly as it was.
  app.customFunction(
    'canReportReservationCompletion',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約の完了報告ができるか判定する（キャストかつin_progress状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isCast = parts[2] == 'true';
return isCast && status == 'in_progress';
''',
  );

  app.customFunction(
    'canSubmitReservationReview',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約の評価ができるか判定する（ゲストかつreview_pending状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isGuest = parts[1] == 'true';
return isGuest && status == 'review_pending';
''',
  );

  // CORRECTION (comprehensive review pass, 2026-08-12): same false-positive
  // finding as `canConfirmReservationMeetup`/`canReportReservationCompletion`
  // above — `generated_code/` confirms `reservation_detail_widget.dart`
  // gates the cancel button's `visible:` on
  // `functions.canCancelReservationNow(...)`. Restored exactly as it was.
  app.customFunction(
    'canCancelReservationNow',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約をキャンセルできるか判定する（終了済み状態でない）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isGuest = parts[1] == 'true';
final isCast = parts[2] == 'true';
const terminalStatuses = ['completed', 'cancelled', 'expired'];
return (isGuest || isCast) && !terminalStatuses.contains(status);
''',
  );

  app.editPage(ff.Pages.reservationDetail, (page) {
    // Root had zero existing triggerActions of any kind (confirmed via the
    // typed SDK) — ensureActions is safe to use directly here.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchReservationVisibility',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'visibilityResult',
        ),
        SetState('resVisibilityData', ActionOutput('visibilityResult')),
      ],
    );

    // FIRST GENERATION superseded 2026-08-10, on re-review before the next
    // step: put `visible:` on each BUTTON, not on the wrapping ROW. Found
    // two consequences of that during a fresh scrutiny pass: (1) 4 of the 6
    // rows contain ONLY that one button (confirmed via
    // lib/flutterflow_project/pages/reservation_detail.dart directly) —
    // hiding the button still leaves an empty Row taking up its own
    // spacing/padding contribution from the surrounding Column, a real
    // visible-gap cosmetic bug across every status where a button is
    // hidden, not just the review row below; (2) `Row_58590jz8`
    // (ReviewInputRow — the rating Dropdown + comment TextField the guest
    // fills in BEFORE tapping 評価する) was never gated by anything at
    // all — a cast viewing this page, or a guest at the wrong status,
    // would see and could fill in a review form they can't actually
    // submit, since only the button below it was hidden. Fixed by moving
    // `visible:` up to the ROW level for all 6 action rows (removing it
    // from the buttons, now redundant) and adding it to ReviewInputRow too
    // (same `canSubmitReservationReview` condition as its own submit
    // button, so both show/hide together). Approve/decline share ONE row
    // (`Row_zkz67xy3`) — moving `visible:` there needs only one condition
    // instead of two identical ones on each button separately.
    // `page.findByKey(...)` below targets each ROW's real key (read fresh
    // from the typed SDK after the first-generation buttons landed), not
    // the buttons themselves — the buttons are reconstructed AGAIN inside
    // each row (unavoidable — `ensureReplaced` on the row necessarily
    // rebuilds everything inside it), same styling/onTap content,
    // unchanged from the first generation.
    // ensureReplaced x6 (this block) — one-shot, CONFIRMED LANDED (all 6
    // rows exist live with row-level `visible:`, verified against
    // reservation_detail_widget.dart directly — §27's addendum) — frozen
    // 2026-08-10. Found unfrozen during the project_rules.md
    // §266-mandated full-file sweep after catching the same failure mode
    // fresh on reservation_confirmed.dart (PROJECT_KNOWLEDGE.md §28's
    // freeze addendum).
    //   page.ensureReplaced(
    //     page.findByKey('Row_zkz67xy3'), // お誘いを承認する / お誘いを断る
    //     Row(
    //       name: 'ApproveDeclineRow',
    //       mainAxis: MainAxis.spaceEvenly,
    //       visible: CustomFunction(canRespondFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Button(
    //           'お誘いを承認する',
    //           name: 'ApproveButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFF4461FD),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callRespondToReservation',
    //               arguments: {'resId': PageParam('resId'), 'accept': true},
    //               outputAs: 'respondResult',
    //             ),
    //             If(
    //               ActionOutput('respondResult'),
    //               then: [Snackbar('リクエストを承諾しました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //         Button(
    //           'お誘いを断る',
    //           name: 'DeclineButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFFFE030A),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callRespondToReservation',
    //               arguments: {'resId': PageParam('resId'), 'accept': false},
    //               outputAs: 'declineResult',
    //             ),
    //             If(
    //               ActionOutput('declineResult'),
    //               then: [Snackbar('リクエストを辞退しました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('Row_cr8et390'), // 合流報告
    //     Row(
    //       name: 'ConfirmMeetupRow',
    //       mainAxis: MainAxis.spaceEvenly,
    //       visible: CustomFunction(canConfirmMeetupFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Button(
    //           '合流報告',
    //           name: 'ConfirmMeetupButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFF55E06B),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callConfirmMeetup',
    //               arguments: {'resId': PageParam('resId')},
    //               outputAs: 'meetupResult',
    //             ),
    //             If(
    //               ActionOutput('meetupResult'),
    //               then: [Snackbar('合流確認を送信しました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('Row_qqj87c5s'), // 完了報告
    //     Row(
    //       name: 'ReportCompletionRow',
    //       mainAxis: MainAxis.spaceEvenly,
    //       visible: CustomFunction(canReportCompletionFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Button(
    //           '完了報告',
    //           name: 'ReportCompletionButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFF05C6FB),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callReportCompletion',
    //               arguments: {'resId': PageParam('resId')},
    //               outputAs: 'completionResult',
    //             ),
    //             If(
    //               ActionOutput('completionResult'),
    //               then: [Snackbar('完了報告を送信しました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
    // ReviewInputRow — the rating Dropdown + comment TextField, previously
    // ungated entirely (see this block's own top comment). Reconstructed
    // with the exact same content already proven working (originally
    // authored in §13, preserved verbatim in that section's own frozen
    // comment), now with `visible:` added.
    //   page.ensureReplaced(
    //     page.findByKey('Row_58590jz8'), // 評価入力（Dropdown+コメント）
    //     Row(
    //       name: 'ReviewInputRow',
    //       visible: CustomFunction(canSubmitReviewFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Column(
    //           children: [
    //             Text('評価', style: Styles.bodyMedium),
    //             Dropdown(
    //               options: const ['1', '2', '3', '4', '5'],
    //               value: State('reviewRating'),
    //               onChanged: SetState('reviewRating', const WidgetValue()),
    //             ),
    //             TextField(
    //               label: 'コメント（任意）',
    //               name: 'ReviewCommentField',
    //               onChanged: SetState('reviewComment', const TextValue()),
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('Row_dw9z46os'), // 評価する
    //     Row(
    //       name: 'SubmitReviewRow',
    //       mainAxis: MainAxis.spaceEvenly,
    //       visible: CustomFunction(canSubmitReviewFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Button(
    //           '評価する',
    //           name: 'SubmitReviewButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFFF2E108),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callSubmitReview',
    //               arguments: {
    //                 'resId': PageParam('resId'),
    //                 'castId': PageParam('castId'),
    //                 'rating': State('reviewRating'),
    //                 'comment': State('reviewComment'),
    //               },
    //               outputAs: 'reviewResult',
    //             ),
    //             If(
    //               ActionOutput('reviewResult'),
    //               then: [Snackbar('評価を送信しました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('Row_ehfeqy1x'), // キャンセルする
    //     Row(
    //       name: 'CancelReservationRow',
    //       mainAxis: MainAxis.spaceEvenly,
    //       visible: CustomFunction(canCancelReservationFn, args: {'data': State('resVisibilityData')}),
    //       children: [
    //         Button(
    //           'キャンセルする',
    //           name: 'CancelReservationButton',
    //           width: 150,
    //           height: 40,
    //           color: Colors.hex(0xFFFB5C68),
    //           textColor: Colors.hex(0xFFFFFFFF),
    //           borderRadius: 8,
    //           onTap: [
    //             CallCustomAction.named(
    //               'callCancelReservation',
    //               arguments: {'resId': PageParam('resId')},
    //               outputAs: 'cancelResult',
    //             ),
    //             If(
    //               ActionOutput('cancelResult'),
    //               then: [Snackbar('予約をキャンセルしました。'), NavigateBack()],
    //               orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   );
  });

  // ==========================================================================
  // Phase 4's last remaining item: `reservation_confirmed.dart`'s display
  // wiring — confirmed fully static (no `triggers:` anywhere in the typed
  // SDK, on either the summary card's own value widgets or the 2 bottom
  // buttons) with an already-provisioned `resId` param (added §12) never
  // actually consumed by anything.
  //
  // Real, pre-existing bug found and fixed while reading the current
  // structure (not something this session broke — present since before
  // any work this session touched this page): the "場所" (location) row's
  // OWN VALUE widget (`Text_vvkdealn`) shows the literal text "ステータス"
  // — a copy-paste artifact from the STATUS row directly above it
  // (`Text_zwcq9p45`'s own value, "確認中"/"ステータス" mixed up somewhere in
  // the row above), not a real location at all. Fixed as part of making
  // this value dynamic anyway, not a separate pass.
  //
  // Same established pattern as every other page-summary this session:
  // one Firestore read on load (`fetchReservationSummary`), delimited
  // string encoding, small body-only customFunctions to extract/format
  // each field for display. Status label reuses the EXACT SAME mapping
  // already established in `reservationListItemLabel` (§14) for
  // consistency — not re-invented here.
  // ==========================================================================

  app.editPageState(ff.Pages.reservationConfirmed, (state) {
    state.ensureField('resSummaryData', string.withDefault(''));
  });

  app.customAction(
    'fetchReservationSummary',
    args: {'resId': string},
    returns: string,
    description: '予約のステータス・日時・場所を取得し、確認画面表示用データを返す。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';

Future<String?> fetchReservationSummary(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return '';
    final doc = await FirebaseFirestore.instance
        .collection('reservations')
        .doc(resId)
        .get();
    final data = doc.data();
    if (data == null) return '';
    final status = data['status']?.toString() ?? '';
    final rawDate = data['date'];
    var dateLabel = '';
    if (rawDate is Timestamp) {
      final d = rawDate.toDate();
      dateLabel =
          '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} '
          '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    final location = (data['location']?.toString() ?? '').replaceAll('|||', '');
    return '$status|||$dateLabel|||$location';
  } catch (e) {
    return '';
  }
}
''',
  );

  app.customFunction(
    'reservationSummaryStatusLabel',
    args: {'data': string},
    returns: string,
    description: '予約確認画面のデータ文字列からステータスを表示用ラベルに整形する。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.isEmpty) return '';
final statusLabels = {
  'request_pending': 'リクエスト中',
  'authorized': '与信確保済み',
  'confirmed': '確定決済済み',
  'in_progress': '交流中',
  'completion_pending': '完了報告待ち',
  'review_pending': '評価待ち',
  'completed': '完了',
  'cancelled': 'キャンセル',
  'expired': '期限切れ',
};
return statusLabels[parts[0]] ?? parts[0];
''',
  );

  app.customFunction(
    'reservationSummaryDateLabel',
    args: {'data': string},
    returns: string,
    description: '予約確認画面のデータ文字列から日時を取り出す。',
    code: r'''
final parts = (data ?? '').split('|||');
return parts.length > 1 ? parts[1] : '';
''',
  );

  app.customFunction(
    'reservationSummaryLocation',
    args: {'data': string},
    returns: string,
    description: '予約確認画面のデータ文字列から場所を取り出す。',
    code: r'''
final parts = (data ?? '').split('|||');
return parts.length > 2 ? parts[2] : '';
''',
  );

  app.editPage(ff.Pages.reservationConfirmed, (page) {
    // Root had zero existing triggerActions (confirmed via the typed
    // SDK — no widget on this page had any trigger at all).
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchReservationSummary',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'summaryResult',
        ),
        SetState('resSummaryData', ActionOutput('summaryResult')),
      ],
    );

    // Status value — was a static "確認中" Button-styled chip; `label:` is
    // a normalized DslExpression (confirmed via the SDK's own Button
    // constructor), so it accepts a CustomFunction result directly,
    // letting this stay a Button (preserving its pill/chip styling)
    // instead of needing to swap widget type for dynamic content.
    // ensureReplaced — one-shot, CONFIRMED LANDED (ReservationSummary-
    // StatusValue exists live as Button_m9nhrlbw) — frozen 2026-08-10.
    // Left uncommented past its own landing, this call re-ran on every
    // subsequent push and kept reassigning a fresh key to the status
    // button (the exact "never-commented-out ensureReplaced" failure mode
    // already documented elsewhere in this file) — caught via a spurious
    // "Modified pages: 1" on an otherwise-unrelated validate rerun.
    //   page.ensureReplaced(
    //     page.findByKey('Button_2j1voyws'),
    //     Button(
    //       CustomFunction(reservationSummaryStatusLabelFn, args: {'data': State('resSummaryData')}),
    //       name: 'ReservationSummaryStatusValue',
    //     ),
    //   );
    // Date/time value AND location value — both further superseded by the
    // row-level `ensureReplaced` calls below (which rebuild each value's
    // ENTIRE parent Row, discarding whatever this call last produced), so
    // both are dead weight on top of being individually stale. Frozen
    // 2026-08-10 for the same reason as the status call above.
    //   page.ensureReplaced(
    //     page.findByKey('Text_ij4v2tka'),
    //     Text(
    //       CustomFunction(reservationSummaryDateLabelFn, args: {'data': State('resSummaryData')}),
    //       name: 'ReservationSummaryDateValue',
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('Text_vvkdealn'),
    //     Text(
    //       CustomFunction(reservationSummaryLocationFn, args: {'data': State('resSummaryData')}),
    //       name: 'ReservationSummaryLocationValue',
    //     ),
    //   );

    // Both bottom buttons had zero existing triggerActions — safe to wire
    // directly. "マッチャを確認する" navigates to the actual マッチャ tab (the
    // bottom-nav destination this exact label names), not a page invented
    // to match it.
    page.ensureActions(
      page.findByKey('Button_xtoj64lt'), // マッチャを確認する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.macchaPage, replaceRoute: true)],
    );
    page.ensureActions(
      page.findByKey('Button_x7oa1u8a'), // ホームに戻る
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.homePage, replaceRoute: true)],
    );
  });

  // REAL BUG found on re-review, before moving on: the previous push's
  // date/location `Text` reconstructions had NO `maxLines:`/`overflow:`
  // protection AND sat as bare (non-`Expanded`) children of a
  // `mainAxisAlignment: spaceBetween` Row — this project's own explicit
  // Design & Quality Rule ("maxLines: + TextOverflow.ellipsis on
  // overflow-prone text") was violated for exactly the field most likely
  // to need it: `location` is unrestricted guest-entered free text from
  // `reservation_form.dart`'s own meeting-address field (§12), with no
  // length limit anywhere in the chain. A long address would overflow the
  // Row horizontally — same failure class already found and fixed in
  // `KycReviewPage` earlier this session (§26's addenda), just via a
  // different structural path (unbounded Row child instead of unbounded
  // Column child). `date` carries near-zero real risk (a fixed-format
  // string this session's own `fetchReservationSummary` constructs, always
  // ~16 characters) but is fixed here too for consistency and defense
  // against a future format change, not left asymmetric.
  //
  // `maxLines`/`overflow` alone would NOT have been sufficient without
  // also fixing the layout: a bare `Text` inside a `Row` still receives
  // UNBOUNDED main-axis width (the same underlying "Row/Column give
  // non-flex children unbounded space" rule behind every layout bug found
  // this session) — `TextOverflow.ellipsis` only engages once a widget
  // already has a BOUNDED width to truncate against. Fixed by
  // reconstructing each ROW (not just the value Text) with the value
  // wrapped in `Expanded` (confirmed to exist as a DSL widget by reading
  // widgets.dart directly), which also replaces the need for
  // `mainAxisAlignment: spaceBetween` — `Expanded` already consumes all
  // remaining row width, so `textAlign: TextAlign.end` on the value text
  // reproduces the same "label left, value right" visual result without
  // relying on spaceBetween's own space-distribution behavior (which
  // doesn't combine meaningfully with a flex child anyway).
  // ensureReplaced — one-shot, CONFIRMED LANDED (ReservationSummaryDateRow
  // / ReservationSummaryLocationRow exist live as Row_81q3qevw /
  // Row_icg1hyc2, each containing an Expanded value Text with
  // maxLines: 1 + TextOverflow.ellipsis, confirmed via the regenerated
  // widget) — frozen 2026-08-10, same discipline as every other one-shot
  // structural op in this file.
  // app.editPage(ff.Pages.reservationConfirmed, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Row_cjsbcl8i'), // 日時
  //     Row(
  //       name: 'ReservationSummaryDateRow',
  //       children: [
  //         Text('日　時', style: Styles.bodyMedium),
  //         Expanded(
  //           Text(
  //             CustomFunction(reservationSummaryDateLabelFn, args: {'data': State('resSummaryData')}),
  //             style: Styles.bodyMedium,
  //             textAlign: TextAlign.end,
  //             maxLines: 1,
  //             overflow: TextOverflow.ellipsis,
  //             name: 'ReservationSummaryDateValue',
  //           ),
  //         ),
  //       ],
  //     ),
  //   );
  //   page.ensureReplaced(
  //     page.findByKey('Row_djhmcxhc'), // 場所
  //     Row(
  //       name: 'ReservationSummaryLocationRow',
  //       children: [
  //         Text('場　所', style: Styles.bodyMedium),
  //         Expanded(
  //           Text(
  //             CustomFunction(reservationSummaryLocationFn, args: {'data': State('resSummaryData')}),
  //             style: Styles.bodyMedium,
  //             textAlign: TextAlign.end,
  //             maxLines: 1,
  //             overflow: TextOverflow.ellipsis,
  //             name: 'ReservationSummaryLocationValue',
  //           ),
  //         ),
  //       ],
  //     ),
  //   );
  // });

  // ==========================================================================
  // Phase 3 — Discovery & profile core, first slice: real Home ranking query
  // (§3.3) + GPS fallback. Chosen as Phase 3's first piece since it's the
  // most-blocking dependency named elsewhere in the plan (Phase 4's
  // remaining bulk-send item and Phase 5's account.updated webhook note
  // both reference this query).
  //
  // Structural finding made BEFORE writing anything: HomePage's cast
  // browsing section is a `PageView` of 5 hardcoded placeholder cards
  // (`https://picsum.photos/seed/.../600`), confirmed via
  // home_page_widget.dart directly — not a scrollable list. Checked this
  // DSL's own `PageView`/`Carousel` constructors (widgets.dart) against
  // `ListView`/`GridView`: only the latter two accept a `source:`/
  // `itemBuilder:` pair for dynamic data — `PageView`/`Carousel` only take
  // a static `children:` list, with no dynamic-binding path at all. There
  // is therefore no way to keep the swipe-carousel shape AND make it
  // data-driven in this DSL — confirmed, not assumed, before deciding to
  // replace it with a `GridView` (also matching how the plan's own
  // §3.3/§8 language already calls the target a "grid"). The 2 icons on
  // each old card turned out to be pure `PageViewController` navigation
  // arrows (`animateToPage`/`nextPage`, confirmed via generated code) —
  // not like/favorite buttons — so nothing functional is lost in the
  // swap, only the swipe interaction model itself, disclosed here rather
  // than silently changed.
  //
  // GPS fallback finding made before writing the fallback path: the plan
  // calls for falling back to "the representative lat/lng of the guest's
  // registered residential area," but `activityPrefecture` (added §9) is
  // a free-text `TextField` (`SetState('activityPrefecture', const
  // TextValue())`, confirmed via this file's own earlier block), not a
  // dropdown bound to a fixed prefecture list — the real "service-area
  // master data" Phase 3 item (a separate, still-`[MISSING]` checklist
  // line) hasn't been built yet, so there is no admin-editable
  // prefecture→coordinate table to look up against. Interim choice, not
  // silently narrowed: substring-match the free-text value against a
  // small static table of the 10 launch prefectures' representative
  // (prefectural-office) coordinates, falling back to Tokyo (the largest
  // launch market) if nothing matches or the field is empty. Replace this
  // table with a real lookup once the service-area master collection
  // exists — flagged here and in PROJECT_KNOWLEDGE.md.
  // ==========================================================================

  // geolocator — brownfield add, guarded per references/custom_code_pub_
  // package_dsl.dart's own documented idiom (`addPubDependency` throws on
  // a name collision; `findPubDependency` makes the rerun-safety check
  // explicit rather than relying on `app.pubDependency(...)`'s create-
  // shape silent no-op semantics).
  app.raw((project) {
    if (findPubDependency(project, name: 'geolocator') == null) {
      addPubDependency(project, name: 'geolocator', version: '^13.0.1');
    }
  });

  // `app.customAction(...)` compiles to `ensureCustomAction`, which is
  // CREATE-IF-MISSING ONLY (confirmed via a real compile failure: "found
  // an existing custom action ... with a different payload. `ensure*`
  // helpers are create-if-missing only") — NOT create-or-update, contrary
  // to this session's own earlier (wrong) assumption that it silently
  // updated on content changes just because it had never errored before
  // (it hadn't errored because the content had simply never changed
  // between reruns until this exact fix). Switched to `updateCustomAction`
  // inside `app.raw(...)`, the same established pattern already proven
  // for `fetchMyReservations` earlier this session.
  //
  // MAJOR BUG FIX (2026-08-11, full-project review): this action used to
  // query `users` DIRECTLY from the client. `firestore.rules`' own
  // `users` rule is strictly owner-only (`allow read: if
  // request.auth.uid == document`, confirmed by reading the rules file
  // directly) — a query filtering on `account_type`/`approval_status`
  // (matching MANY other users' documents, not the caller's own) is
  // provably unsatisfiable by that rule, so Firestore denies the whole
  // query outright at rule-evaluation time. The action's own try/catch
  // silently swallowed this into an empty list, meaning the ENTIRE Home
  // ranking query feature has shown zero casts to every user since it
  // was built — a real, previously undiscovered defect, not a cosmetic
  // one. Real fix: moved the query/filter/sort server-side into a new
  // `getDiscoveryCasts` callable (Admin SDK bypasses Firestore rules,
  // the same reason `getServiceAreas` exists) — this action now only
  // resolves the guest's own coordinates (GPS or prefecture fallback,
  // unchanged from before) and calls that callable.
  app.raw((project) {
    updateCustomAction(
      project,
      name: 'fetchDiscoveryCasts',
      code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:geolocator/geolocator.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<List<String>> fetchDiscoveryCasts() async {
  try {
    final firestore = FirebaseFirestore.instance;
    final uid = currentUserUid;
    double? guestLat;
    double? guestLng;

    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.always ||
          permission == LocationPermission.whileInUse) {
        final position = await Geolocator.getCurrentPosition(
          timeLimit: const Duration(seconds: 5),
        );
        guestLat = position.latitude;
        guestLng = position.longitude;
      }
    } catch (e) {
      // GPS unavailable/denied/timed out — fall through to the
      // prefecture-based fallback below.
    }

    if (guestLat == null || guestLng == null) {
      const prefectureCenters = <String, List<double>>{
        '東京都': [35.6895, 139.6917],
        '神奈川県': [35.4478, 139.6425],
        '千葉県': [35.6047, 140.1233],
        '愛知県': [35.1802, 136.9066],
        '京都府': [35.0116, 135.7681],
        '大阪府': [34.6937, 135.5023],
        '兵庫県': [34.6913, 135.1830],
        '岡山県': [34.6551, 133.9195],
        '広島県': [34.3853, 132.4553],
        '福岡県': [33.6064, 130.4181],
      };
      var ownPrefecture = '';
      if (uid.isNotEmpty) {
        final ownDoc = await firestore.collection('users').doc(uid).get();
        // `prefecture` (required, all-users residential field), NOT
        // `activity_prefecture` (optional, cast-only "where I work" field)
        // — a guest browsing Home would almost always have this empty,
        // making the fallback silently fail for the primary user of this
        // feature. Real bug, found on review, not present in the original
        // design intent (§29's own comment already correctly described
        // "the guest's registered residential area", just implemented
        // against the wrong field). This read is allowed by
        // firestore.rules (own document, owner-only rule is satisfied).
        ownPrefecture = ownDoc.data()?['prefecture']?.toString() ?? '';
      }
      for (final entry in prefectureCenters.entries) {
        if (ownPrefecture.contains(entry.key)) {
          guestLat = entry.value[0];
          guestLng = entry.value[1];
          break;
        }
      }
      guestLat ??= 35.6895;
      guestLng ??= 139.6917;
    }

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getDiscoveryCasts');
    final result = await callable.call({'lat': guestLat, 'lng': guestLng});
    if (result.data is Map && result.data['items'] is List) {
      return (result.data['items'] as List).map((e) => e.toString()).toList();
    }
    return <String>[];
  } catch (e) {
    return <String>[];
  }
}
''',
    );
  });

  app.customFunction(
    'discoveryCastId',
    args: {'item': string},
    returns: string,
    description: 'Home画面の近隣キャストリスト1件からUIDを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.isNotEmpty ? parts[0] : '';
''',
  );

  app.customFunction(
    'discoveryCastNickname',
    args: {'item': string},
    returns: string,
    description: 'Home画面の近隣キャストリスト1件からニックネームを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 1 ? parts[1] : '';
''',
  );

  app.customFunction(
    'discoveryCastPhotoUrl',
    args: {'item': string},
    returns: string,
    description: 'Home画面の近隣キャストリスト1件から写真URLを取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 2 ? parts[2] : '';
''',
  );

  app.customFunction(
    'discoveryCastIsOnline',
    args: {'item': string},
    returns: bool_,
    description: 'Home画面の近隣キャストリスト1件がオンライン中か判定する。',
    code: r'''
final parts = (item ?? '').split('|||');
return parts.length > 3 && parts[3] == 'true';
''',
  );

  app.editPage(ff.Pages.homePage, (page) {
    // HomePage's ON_INIT_STATE wiring for this fetch lives in the
    // EARLIER `app.editPage(ff.Pages.homePage, ...)` block in this file
    // (the one reproducing the pre-existing approval-status gate) —
    // nested inside that call's own `If(...).then:` branch, not here.
    // Confirmed via isolation testing that a SECOND `ensureActions` call
    // targeting the same root+ON_INIT_STATE trigger, even to append just
    // one new step to an otherwise-identical reproduction, fails
    // `compileDslApp` with a spurious "Name ... already in use" error
    // regardless of the new step's name — one call per trigger, always.

    // Replacing `Container_z3poslih` (the PageView's own fixed-height
    // 400x150 wrapper — confirmed via generated code), not just the
    // PageView inside it, since a GridView needs to size to its own
    // content, not be clipped to the old carousel's fixed height.
    // `GridView` defaults to `shrinkWrap: true` under the hood (confirmed
    // by reading `UI.gridView` in ui.dart directly — opposite of
    // `ListView`'s own `false` default), and this Column already sits
    // inside HomePage's own outer scrollable `ListView` (the Scaffold's
    // direct body), so no extra scrollable-ancestor wrapping is needed
    // here, unlike KycReviewPage's Column (§26 addenda).
    //   page.ensureReplaced(
    //     page.findByKey('Container_z3poslih'),
    //     GridView(
    //       name: 'DiscoveryCastGrid',
    //       source: State('discoveryCasts'),
    //       columns: 2,
    //       crossAxisSpacing: 12,
    //       mainAxisSpacing: 12,
    //       childAspectRatio: 0.75,
    //       itemBuilder: (item) => Container(
    //         name: 'DiscoveryCastCard',
    //         borderRadius: 12,
    //         color: Colors.secondaryBackground,
    //         onTap: [
    //           Navigate(
    //             ff.Pages.castProfile,
    //             params: {
    //               'castId': CustomFunction(discoveryCastIdFn, args: {'item': item}),
    //             },
    //           ),
    //         ],
    //         child: Column(
    //           crossAxis: CrossAxis.start,
    //           children: [
    //             Stack(
    //               children: [
    //                 Image(
    //                   CustomFunction(discoveryCastPhotoUrlFn, args: {'item': item}),
    //                   height: 130,
    //                   width: double.infinity,
    //                   fit: ImageFit.cover,
    //                   borderRadius: 12,
    //                   name: 'DiscoveryCastImage',
    //                 ),
    //                 Container(
    //                   width: 12,
    //                   height: 12,
    //                   borderRadius: 6,
    //                   color: Colors.success,
    //                   margin: EdgeInsets.all(8),
    //                   visible: CustomFunction(discoveryCastIsOnlineFn, args: {'item': item}),
    //                   name: 'DiscoveryCastOnlineDot',
    //                 ),
    //               ],
    //             ),
    //             Container(
    //               padding: EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    //               child: Text(
    //                 CustomFunction(discoveryCastNicknameFn, args: {'item': item}),
    //                 style: Styles.bodyMedium,
    //                 maxLines: 1,
    //                 overflow: TextOverflow.ellipsis,
    //                 name: 'DiscoveryCastNickname',
    //               ),
    //             ),
    //           ],
    //         ),
    //       ),
    //     ),
    //   );
  });

  // Review-pass fix (2026-08-11): the GridView card above was given
  // `childAspectRatio: 0.75` (blindly copied from media_browser_dsl.dart's
  // own reference card, which has a 2-line title+category text block).
  // This card only has 1 line of nickname text below its 130px image —
  // total content height ≈130+32=162px, while a 0.75 ratio at a typical
  // ~173px 2-column cell width forces a ≈227px-tall cell (width/ratio),
  // leaving a visible ~65px blank gap under every card (the inner Column
  // uses `mainAxisSize: MainAxisSize.min`, so it doesn't stretch to fill).
  // Not a crash, but a real Design & Quality Rule violation this project
  // holds itself to. `childAspectRatio` has no typed `page.update(...)`
  // patch (not in `EditWidgetPatch`'s surface) and no fast-lane op, so
  // fixed via the same raw single-property `mutateNode` technique already
  // used for `shrinkWrapValue`/`Column.scrollable` earlier this session —
  // confirmed the exact proto field via `UI.gridView` in ui.dart
  // (`props.gridView.childAspectRatioValue`, a plain `FFDoubleValue`, not
  // deprecated).
  //
  // SUPERSEDED (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): §63's no-photo-fallback rollout later reconstructed this SAME
  // `GridView_8292ke7j` node from scratch via `ensureReplaced` (to add the
  // fallback image), with a literal `childAspectRatio: 0.75` — silently
  // reintroducing the exact gap this mutateNode fixed, since the later
  // reconstruction runs after this in the same script and replaces the
  // whole node. Confirmed via generated_code showing 0.75, not 1.05, was
  // actually live. The fix is now applied directly in that reconstruction's
  // own literal instead (search for `DiscoveryCastGrid` below) — this
  // mutateNode is inert (targets a key that no longer exists) and frozen.
  // app.editPage(ff.Pages.homePage, (page) {
  //   page.mutateNode(page.findByKey('GridView_8292ke7j'), (node) {
  //     node.props.gridView.childAspectRatioValue = FFDoubleValue(inputValue: 1.05);
  //   });
  // });

  // ==========================================================================
  // Phase 3 — Service-area master data (§3.2.2), prefecture-level slice.
  // Scoped down explicitly with the user: prefecture-level only this pass
  // (real municipality data for all 10 prefectures would mean generating
  // dozens of real place names from general knowledge with no live source
  // to verify against — a real risk of shipping wrong product content,
  // this project's own established line not to cross). `city`/
  // `activityCity` stay free text, unchanged.
  //
  // Backend built as real, admin-editable infrastructure (`config.ts`'s
  // `SYSTEM_DEFAULTS.service_areas`, an array of `{name, prefecture,
  // active}` — the exact shape IMPLEMENTATION_PLAN.md §5 already confirmed
  // against the real backend, not invented; editable via the
  // ALREADY-EXISTING `adminUpdateSystemConfig` callable, no new admin
  // write path needed; new guest-facing read-only `getServiceAreas`
  // callable added since `system_config` is admin-only under
  // firestore.rules). **That backend work is NOT yet deployed** — a
  // pre-existing, unrelated `firebase-tools`/`firebase-functions`
  // gen-1-function CPU-validation conflict blocks ALL backend deploys
  // right now (confirmed: persists even after removing the suspected
  // `setGlobalOptions` cause AND after a firebase-functions 6.6.0→7.3.2
  // upgrade attempt, both safely reverted) — flagged as its own follow-up,
  // not silently worked around.
  //
  // Real DSL constraint found while designing this page's own dropdowns,
  // not assumed: `Dropdown.options` requires a static `Iterable<String>`
  // at authoring time (confirmed via `widgets.dart`'s own constructor) —
  // no dynamic/state-bound option list is possible with this widget.
  // `ListView`/`GridView` DO support a dynamic `source:`, but building a
  // custom dropdown-equivalent picker on top of one is real additional UI
  // engineering, not a simple widget swap. Decided with the user: ship a
  // STATIC `Dropdown` with the confirmed 10 launch prefectures now (same
  // list as `fetchDiscoveryCasts`'s own fallback table, §29) — the
  // service_areas backend infrastructure above still exists as real,
  // correct groundwork for a future admin-panel-driven picker, but this
  // specific dropdown does not yet consume it live. Disclosed, not
  // silently narrowed — IMPLEMENTATION_PLAN.md's own "hardcoding directly
  // into dropdown options would violate the future area expansion
  // requirement" concern is real and still open for this exact widget.
  //
  // Two SEPARATE state fields exist on this page for two DIFFERENT
  // concepts, confirmed via the typed SDK before touching anything (not
  // assumed from the field names alone): `prefecture`/`city` (required,
  // ALL users — residential registration) vs. `activityPrefecture`/
  // `activityCity` (optional, cast-only "where I work"). Both prefecture
  // fields get the same static dropdown; both city fields stay free text.
  // ensureReplaced x2 — one-shot, CONFIRMED LANDED (PrefectureDropdown /
  // ActivityPrefectureDropdown exist live, both correctly bound to
  // _model.prefecture / _model.activityPrefecture — confirmed via
  // regenerated code) — frozen 2026-08-11, same discipline as every other
  // one-shot structural op in this file (applied immediately this time,
  // not deferred to a later review pass).
  app.editPage(ff.Pages.basicInfoRegistration, (page) {
    //   page.ensureReplaced(
    //     page.findByKey('TextField_c7x0vnzy'), // 都道府県
    //     Dropdown(
    //       name: 'PrefectureDropdown',
    //       hint: '都道府県を選択してください',
    //       options: const [
    //         '東京都', '神奈川県', '千葉県', '愛知県', '京都府',
    //         '大阪府', '兵庫県', '岡山県', '広島県', '福岡県',
    //       ],
    //       value: State('prefecture'),
    //       onChanged: SetState('prefecture', const WidgetValue()),
    //     ),
    //   );
    //   page.ensureReplaced(
    //     page.findByKey('TextField_24s7anbf'), // 活動都道府県（任意）
    //     Dropdown(
    //       name: 'ActivityPrefectureDropdown',
    //       hint: '活動都道府県を選択してください（任意）',
    //       options: const [
    //         '東京都', '神奈川県', '千葉県', '愛知県', '京都府',
    //         '大阪府', '兵庫県', '岡山県', '広島県', '福岡県',
    //       ],
    //       value: State('activityPrefecture'),
    //       onChanged: SetState('activityPrefecture', const WidgetValue()),
    //     ),
    //   );
  });

  // ==========================================================================
  // Phase 3 — `profile_edit.dart`'s save action (§3.6.1). Confirmed the
  // backend (`updateProfile`) already exists, already live, and is fully
  // generic (accepts any subset of a fixed `allowedFields` list) — no
  // backend work needed here at all, purely a DSL/UI task.
  //
  // Real DSL constraint found and checked with the user before designing
  // anything: `TextField` has NO way to display a dynamic/state-bound
  // initial value — confirmed via its own constructor (no `value:` param,
  // unlike `Dropdown`), confirmed `hint:` is a plain static `String?` (not
  // a bindable expression either), and confirmed no `SetTextField`-style
  // action exists (`ClearTextField` does, with no fill counterpart). The
  // one theoretical path (`FFTextField.initialText`, a real non-deprecated
  // proto field) would need hand-compiling a dynamic `FFText` expression
  // via raw `mutateNode` — exactly the kind of raw-proto work this
  // project's own rules steer away from, and not worth the risk for an
  // uncertain payoff. Decided with the user: for every free-text field,
  // show the CURRENT value as a read-only `Text` and add a SEPARATE
  // `TextField` for a new value — empty input at save time means "keep
  // the existing value". `Dropdown`-backed fields (gender/prefecture/
  // drinking/smoking) have no such problem — `Dropdown.value:` genuinely
  // does support dynamic binding — so those are properly pre-filled
  // directly, no workaround needed.
  //
  // Two real, pre-existing bugs found while mapping every field to its
  // backend counterpart (not introduced this session): (1) TWO fields are
  // both labeled "飲　酒" (drinking) — the second is clearly meant to be
  // "喫　煙" (smoking), a copy-paste label bug, fixed as part of wiring
  // rather than left broken; (2) the self-introduction field's static
  // placeholder was IDENTICAL to the one-line-message field directly
  // above it ("誰か焼肉連れてって..." on both) — naturally resolved by this
  // redesign, since both now show their own real fetched value instead of
  // any static placeholder.
  //
  // Two fields deliberately left untouched, disclosed rather than
  // guessed: 年齢層 (age bracket) is NOT in `updateProfile`'s
  // `allowedFields` list — per IMPLEMENTATION_PLAN.md §3.1.5 it's meant to
  // be AUTO-COMPUTED from birth date, not directly user-editable, and this
  // page has no birth-date field to compute it from anyway; 職　業
  // (occupation) has no corresponding backend field in `allowedFields` at
  // all — inventing a mapping to the semantically-unrelated `atmosphere`
  // field would be guessing product content, so left unwired, matching
  // this project's own established precedent (`reservation_form.dart`'s
  // 延長予定の有無).
  //
  // Gallery (1 main photo + up to 10 gallery photos, §3.1.12's enforced
  // review criteria) is explicitly NOT built here — this page has no
  // gallery UI at all (only the single profile photo), and building one
  // is a genuinely separate, larger UI undertaking, not a wiring gap.
  // Self-intro's OWN §3.1.12 requirement (≥50 chars) IS enforced here,
  // computed against the EFFECTIVE value (new input if provided, else the
  // existing one) so the constraint holds for the final saved state, not
  // just freshly-typed text.
  // ==========================================================================

  app.customAction(
    'fetchMyProfile',
    returns: string,
    description: '現在のユーザーのプロフィール編集用データを取得する。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String> fetchMyProfile() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return '';
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final data = doc.data();
    if (data == null) return '';
    String f(String key) => (data[key]?.toString() ?? '').replaceAll('|||', '');
    return [
      f('nickname'),
      f('gender'),
      f('prefecture'),
      f('city'),
      f('drinking'),
      f('smoking'),
      f('hobbies'),
      f('skills'),
      f('favorite_food_tags'),
      f('one_line_message'),
      f('self_introduction'),
      f('profile_image_url'),
    ].join('|||');
  } catch (e) {
    return '';
  }
}
''',
  );

  final profileFieldFn = app.customFunction(
    'profileField',
    args: {'data': string, 'index': int_},
    returns: string,
    description: 'プロフィール編集データの文字列からN番目の項目を取り出す（共通ヘルパー）。',
    code: r'''
final parts = (data ?? '').split('|||');
final i = index ?? -1;
return (i >= 0 && i < parts.length) ? parts[i] : '';
''',
  );

  // Review-pass fix (2026-08-11): editing an ALREADY-LANDED custom
  // action's code — `app.customAction(...)` compiles to `ensureCustomAction`
  // (create-if-missing ONLY, confirmed the hard way in §30) — switched to
  // `updateCustomAction` inside `app.raw(...)`. `code:`-only is safe here
  // (no `arguments:` needed) since the parameter list/count is unchanged,
  // only the function body — matching the already-documented rule in
  // `.cursor/rules/project_rules.md` for exactly this case.
  app.raw((project) {
    updateCustomAction(
      project,
      name: 'callUpdateProfile',
      code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> callUpdateProfile(
  String? newNickname, String? origNickname,
  String? gender,
  String? prefecture,
  String? newCity, String? origCity,
  String? drinking,
  String? smoking,
  String? newHobbies, String? origHobbies,
  String? newSkills, String? origSkills,
  String? newFavoriteFood, String? origFavoriteFood,
  String? newOneLineMessage, String? origOneLineMessage,
  String? newSelfIntro, String? origSelfIntro,
  String? profileImageUrl,
) async {
  try {
    String eff(String? newVal, String? origVal) =>
        (newVal != null && newVal.isNotEmpty) ? newVal : (origVal ?? '');

    final effSelfIntro = eff(newSelfIntro, origSelfIntro);
    // Only gate on length when the user is ACTIVELY submitting a new
    // self-intro (newSelfIntro non-empty) — otherwise an existing user
    // whose self-intro pre-dates this validation (very plausible, since
    // it was never enforced before) would be locked out of saving ANY
    // unrelated field (nickname, gender, etc.) until they separately fix
    // a self-intro they weren't even trying to touch. Real UX regression,
    // caught and fixed on review before shipping.
    if (newSelfIntro != null && newSelfIntro.isNotEmpty && effSelfIntro.length < 50) {
      return 'too_short';
    }

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('updateProfile');
    final result = await callable.call({
      'nickname': eff(newNickname, origNickname),
      'gender': gender ?? '',
      'prefecture': prefecture ?? '',
      'city': eff(newCity, origCity),
      'drinking': drinking ?? '',
      'smoking': smoking ?? '',
      'hobbies': eff(newHobbies, origHobbies),
      'skills': eff(newSkills, origSkills),
      'favorite_food_tags': eff(newFavoriteFood, origFavoriteFood),
      'one_line_message': eff(newOneLineMessage, origOneLineMessage),
      'self_introduction': effSelfIntro,
      'profile_image_url': profileImageUrl ?? '',
    });
    if (result.data is Map && result.data['success'] == true) {
      return 'ok';
    }
    return 'error';
  } catch (e) {
    return 'error';
  }
}
''',
    );
  });

  app.customAction(
    'callUpdateProfilePhoto',
    args: {'photoUrl': string},
    returns: bool_,
    description: 'プロフィール画像のみをupdateProfileで即時保存する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callUpdateProfilePhoto(String? photoUrl) async {
  try {
    if (photoUrl == null || photoUrl.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('updateProfile');
    final result = await callable.call({'profile_image_url': photoUrl});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.editPageState(ff.Pages.profileEdit, (state) {
    state.ensureField('origNickname', string.withDefault(''));
    state.ensureField('origCity', string.withDefault(''));
    state.ensureField('origHobbies', string.withDefault(''));
    state.ensureField('origSkills', string.withDefault(''));
    state.ensureField('origFavoriteFood', string.withDefault(''));
    state.ensureField('origOneLineMessage', string.withDefault(''));
    state.ensureField('origSelfIntro', string.withDefault(''));
    state.ensureField('newNickname', string.withDefault(''));
    state.ensureField('newCity', string.withDefault(''));
    state.ensureField('newHobbies', string.withDefault(''));
    state.ensureField('newSkills', string.withDefault(''));
    state.ensureField('newFavoriteFood', string.withDefault(''));
    state.ensureField('newOneLineMessage', string.withDefault(''));
    state.ensureField('newSelfIntro', string.withDefault(''));
    state.ensureField('editGender', string.withDefault(''));
    state.ensureField('editPrefecture', string.withDefault(''));
    state.ensureField('editDrinking', string.withDefault(''));
    state.ensureField('editSmoking', string.withDefault(''));
    state.ensureField('editProfileImageUrl', string.withDefault(''));
    // Review-pass addition: guards against a real, if narrow-window, data-
    // loss risk — see the ON_INIT_STATE block below for the full reasoning.
    state.ensureField('profileLoaded', bool_.withDefault(false));
  });

  app.editPage(ff.Pages.profileEdit, (page) {
    // Root had zero existing triggerActions (confirmed via the typed SDK)
    // — ensureActions is safe to use directly.
    //
    // Review-pass finding: `callUpdateProfile` unconditionally sends
    // `gender ?? ''`/`prefecture ?? ''`/`drinking ?? ''`/`smoking ?? ''`
    // (these 4 fields have no "orig" fallback the way text fields do,
    // since Dropdown pre-fills them directly into ONE state field). If
    // the save button were tapped before THIS async fetch resolves, those
    // 4 fields would still hold their default empty-string value and the
    // save would silently OVERWRITE the user's real gender/prefecture/
    // drinking/smoking with empty strings — a real, if narrow-window,
    // data-loss risk, not just a UX inconvenience. Fixed generally (not
    // just patched around these 4 fields) via a `profileLoaded` flag,
    // set true only once this fetch actually completes, and checked by
    // the save button before proceeding (see below) — protects every
    // field this page can save, not only the ones without their own
    // orig-value fallback.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named('fetchMyProfile', outputAs: 'myProfileData'),
        SetState('origNickname', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 0})),
        SetState('editGender', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 1})),
        SetState('editPrefecture', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 2})),
        SetState('origCity', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 3})),
        SetState('editDrinking', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 4})),
        SetState('editSmoking', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 5})),
        SetState('origHobbies', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 6})),
        SetState('origSkills', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 7})),
        SetState('origFavoriteFood', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 8})),
        SetState('origOneLineMessage', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 9})),
        SetState('origSelfIntro', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 10})),
        SetState('editProfileImageUrl', CustomFunction(profileFieldFn, args: {'data': ActionOutput('myProfileData'), 'index': 11})),
        SetState('profileLoaded', true),
      ],
    );
  });

  app.editPage(ff.Pages.profileEdit, (page) {
    // Photo — CircleImage has no DSL constructor (confirmed via widgets.dart
    // — only a compiler-level UI.circleImage helper exists) and no dynamic
    // path binding via the typed `page.update(...).imagePath(...)` patch
    // either (that patch takes a static String, confirmed via edit.dart).
    // `Avatar.imageUrl` DOES accept a dynamic expression (confirmed —
    // normalizeNullableExpression) and renders as a circular image, the
    // same visual semantic — size 80 matches the original CircleImage
    // container's confirmed 80x80 dimensions (generated_code).
    //   page.ensureReplaced(
    //     page.findByKey('CircleImage_m2ut512l'),
    //     Avatar(
    //       imageUrl: State('editProfileImageUrl'),
    //       size: 80,
    //       name: 'ProfileAvatarImage',
    //     ),
    //   );
    page.ensureActions(
      page.findByKey('Button_adgkk84a'), // プロフ画像変更
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'pickAndUploadImage',
          arguments: {'fileNameSuffix': 'profile'},
          outputAs: 'newPhotoUrl',
        ),
        If(
          Not(Equals(ActionOutput('newPhotoUrl'), '')),
          then: [
            SetState('editProfileImageUrl', ActionOutput('newPhotoUrl')),
            CallCustomAction.named(
              'callUpdateProfilePhoto',
              arguments: {'photoUrl': ActionOutput('newPhotoUrl')},
              outputAs: 'photoSaveResult',
            ),
            If(
              ActionOutput('photoSaveResult'),
              then: [Snackbar('画像を更新しました。')],
              orElse: [Snackbar('画像の保存に失敗しました。もう一度お試しください。')],
            ),
          ],
          orElse: [],
        ),
      ],
    );

    // Nickname — TextField has no dynamic initial-value binding (§ this
    // block's own top comment) — reconstructed as current-value display +
    // separate new-value input.
    //   page.ensureReplaced(
    //     page.findByKey('Column_7qhwnnsh'),
    //     Column(
    //       name: 'NicknameEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('ニックネーム', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origNickname'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しいニックネーム（変更する場合のみ入力）',
    //           name: 'NewNicknameField',
    //           onChanged: SetState('newNickname', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // Gender — Dropdown DOES support dynamic `value:` binding, so this is
    // properly pre-filled directly, no current/new split needed. Same
    // option list as BasicInfoRegistration's own gender dropdown (§9),
    // reused for consistency rather than re-derived.
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_19vreqt8'),
    //     Dropdown(
    //       name: 'GenderDropdown',
    //       hint: '性別を選択してください',
    //       options: const ['男性', '女性', '回答しない'],
    //       value: State('editGender'),
    //       onChanged: SetState('editGender', const WidgetValue()),
    //     ),
    //   );

    // Prefecture — same static 10-prefecture list as HomePage/
    // BasicInfoRegistration (§29/§30), properly pre-filled via `value:`.
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_rl1btgwp'),
    //     Dropdown(
    //       name: 'EditPrefectureDropdown',
    //       hint: '都道府県を選択してください',
    //       options: const [
    //         '東京都', '神奈川県', '千葉県', '愛知県', '京都府',
    //         '大阪府', '兵庫県', '岡山県', '広島県', '福岡県',
    //       ],
    //       value: State('editPrefecture'),
    //       onChanged: SetState('editPrefecture', const WidgetValue()),
    //     ),
    //   );

    // City — native widget was a Dropdown with no real municipality data
    // (same "prefecture-level only" scope decision as §30 — no admin-
    // editable municipality master exists to source real options from).
    // Converted to the current/new TextField pattern, matching
    // BasicInfoRegistration's own city field precedent (also free text).
    //   page.ensureReplaced(
    //     page.findByKey('Column_xynbln7k'),
    //     Column(
    //       name: 'CityEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('地域（市町村）', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origCity'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しい市区町村（変更する場合のみ入力）',
    //           name: 'NewCityField',
    //           onChanged: SetState('newCity', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // 年齢層 (age bracket) deliberately left untouched — not in
    // updateProfile's allowedFields, meant to be auto-derived from birth
    // date per IMPLEMENTATION_PLAN.md §3.1.5, and this page has no
    // birth-date field to compute it from. See this block's own top
    // comment for the full reasoning.

    // Drinking — properly pre-filled via Dropdown's dynamic `value:`.
    // Option wording is an interim, reasonable choice (no explicit list
    // found in IMPLEMENTATION_PLAN.md for this field) — disclosed, not
    // presented as confirmed final copy, same discipline as every other
    // guessed-vs-confirmed distinction in this file.
    //   page.ensureReplaced(
    //     page.findByKey('DropDown_c853dqoj'),
    //     Dropdown(
    //       name: 'DrinkingDropdown',
    //       hint: '飲酒について選択してください',
    //       options: const ['飲む', '飲まない', '時々飲む'],
    //       value: State('editDrinking'),
    //       onChanged: SetState('editDrinking', const WidgetValue()),
    //     ),
    //   );

    // Smoking — REAL BUG FIX: this field's Text label was "飲　酒"
    // (drinking), an exact duplicate of the field above it — a copy-paste
    // artifact, not a real second drinking field. Corrected to "喫　煙"
    // (smoking) as part of wiring, not left broken. Column-level
    // reconstruction needed here (not just the Dropdown) specifically to
    // fix the label text alongside the value binding.
    //   page.ensureReplaced(
    //     page.findByKey('Column_050x9ygt'),
    //     Column(
    //       name: 'SmokingEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('喫　煙', style: Styles.bodyMedium),
    //         Dropdown(
    //           name: 'SmokingDropdown',
    //           hint: '喫煙について選択してください',
    //           options: const ['吸う', '吸わない', '時々吸う'],
    //           value: State('editSmoking'),
    //           onChanged: SetState('editSmoking', const WidgetValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // Hobbies (種類 — a generic label, but the native placeholder content
    // "旅行、バイクツーリング" clearly matches `hobbies`, not any other
    // field; label left as-is, only the underlying binding is fixed).
    //   page.ensureReplaced(
    //     page.findByKey('Column_q80an5jc'),
    //     Column(
    //       name: 'HobbiesEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('種　類', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origHobbies'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しい趣味（変更する場合のみ入力）',
    //           name: 'NewHobbiesField',
    //           onChanged: SetState('newHobbies', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // Skills (特技).
    //   page.ensureReplaced(
    //     page.findByKey('Column_t173gkj9'),
    //     Column(
    //       name: 'SkillsEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('特　技', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origSkills'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しい特技（変更する場合のみ入力）',
    //           name: 'NewSkillsField',
    //           onChanged: SetState('newSkills', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // 職　業 (occupation) deliberately left untouched — no corresponding
    // field in updateProfile's allowedFields at all. See this block's own
    // top comment for the full reasoning.

    // Favorite food (好き食).
    //   page.ensureReplaced(
    //     page.findByKey('Column_cyufmw9h'),
    //     Column(
    //       name: 'FavoriteFoodEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('好き食', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origFavoriteFood'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しい好きな食べ物（変更する場合のみ入力）',
    //           name: 'NewFavoriteFoodField',
    //           onChanged: SetState('newFavoriteFood', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // One-line message.
    //   page.ensureReplaced(
    //     page.findByKey('Column_qz4vz97i'),
    //     Column(
    //       name: 'OneLineMessageEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('一言メッセージ', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origOneLineMessage'),
    //           style: Styles.bodyMedium,
    //         ),
    //         TextField(
    //           hint: '新しい一言メッセージ（変更する場合のみ入力）',
    //           name: 'NewOneLineMessageField',
    //           onChanged: SetState('newOneLineMessage', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // Self-introduction — same current/new pattern as every other text
    // field, PLUS the §3.1.12 enforced validation (≥50 chars), checked in
    // `callUpdateProfile` against the EFFECTIVE value, not just new input.
    // This ALSO naturally fixes a pre-existing bug: the native placeholder
    // here was identical to the one-line-message field's own placeholder
    // — both showed the same short text. Now each shows its own real
    // fetched value instead of any shared static placeholder.
    //   page.ensureReplaced(
    //     page.findByKey('Column_ja6hqk5u'),
    //     Column(
    //       name: 'SelfIntroEditColumn',
    //       crossAxis: CrossAxis.start,
    //       children: [
    //         Text('自己紹介文（50文字以上）', style: Styles.bodyMedium),
    //         Text(
    //           '現在の設定:',
    //           style: Styles.bodySmall,
    //           color: Colors.secondaryText,
    //         ),
    //         Text(
    //           State('origSelfIntro'),
    //           style: Styles.bodyMedium,
    //           maxLines: 3,
    //           overflow: TextOverflow.ellipsis,
    //         ),
    //         TextField(
    //           hint: '新しい自己紹介文（変更する場合のみ入力、50文字以上）',
    //           maxLines: 4,
    //           name: 'NewSelfIntroField',
    //           onChanged: SetState('newSelfIntro', const TextValue()),
    //         ),
    //       ],
    //     ),
    //   );

    // Save button — gated on `profileLoaded` (see the ON_INIT_STATE
    // block's own comment for why: saving before the initial fetch
    // resolves would silently overwrite gender/prefecture/drinking/
    // smoking with empty strings).
    page.ensureActions(
      page.findByKey('Button_d8y61kcu'), // プロフィールを保存する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          State('profileLoaded'),
          then: [
            CallCustomAction.named(
              'callUpdateProfile',
              arguments: {
                'newNickname': State('newNickname'),
                'origNickname': State('origNickname'),
                'gender': State('editGender'),
                'prefecture': State('editPrefecture'),
                'newCity': State('newCity'),
                'origCity': State('origCity'),
                'drinking': State('editDrinking'),
                'smoking': State('editSmoking'),
                'newHobbies': State('newHobbies'),
                'origHobbies': State('origHobbies'),
                'newSkills': State('newSkills'),
                'origSkills': State('origSkills'),
                'newFavoriteFood': State('newFavoriteFood'),
                'origFavoriteFood': State('origFavoriteFood'),
                'newOneLineMessage': State('newOneLineMessage'),
                'origOneLineMessage': State('origOneLineMessage'),
                'newSelfIntro': State('newSelfIntro'),
                'origSelfIntro': State('origSelfIntro'),
                'profileImageUrl': State('editProfileImageUrl'),
              },
              outputAs: 'saveResult',
            ),
            Switch(
              ActionOutput('saveResult'),
              cases: [
                SwitchCase('ok', then: [Snackbar('プロフィールを保存しました。'), NavigateBack()]),
                SwitchCase('too_short', then: [Snackbar('自己紹介文は50文字以上で入力してください。')]),
              ],
              orElse: [Snackbar('保存に失敗しました。もう一度お試しください。')],
            ),
          ],
          orElse: [Snackbar('読み込み中です。少々お待ちください。')],
        ),
      ],
    );
  });

  // ==========================================================================
  // Full-project review pass — fixing a real, already-diagnosed bug that had
  // been sitting disclosed-but-unfixed since §23: `calculateExtensionPrice`
  // (a NATIVE, pre-existing custom function — never DSL-declared, confirmed
  // via grep — lives on the still-entirely-unwired `extension_payment.dart`)
  // compares its `timeSlot` argument against `'第3部'`/`'第4部'`, but
  // `config.ts`'s own `night_time_slots` default (the real, confirmed
  // source of truth for this naming, already used to populate
  // `reservation_form.dart`'s own now-fixed 時間帯 dropdown in §24) is
  // `["3部","4部"]` — no "第" prefix. These could never match, meaning the
  // night-rate surcharge this function computes has never actually applied
  // to any real "3部"/"4部" input. Confirmed via `updateCustomFunction`
  // (this is native code, not a DSL-owned declaration) — `code:`-only,
  // parameter count/signature unchanged, only the one comparison literal.
  // Low-risk fix: `extension_payment.dart` remains entirely unwired this
  // session (Phase 6/11, not started), so this corrects a genuine latent
  // defect with zero behavioral change to anything currently reachable —
  // unlike `profile_edit.dart`'s own dormant dropdown option CONTENT
  // (§24's follow-up sweep), which was correctly left alone since fixing
  // it would mean inventing new product wording, not correcting an
  // already-confirmed mismatch against an existing source of truth.
  // ==========================================================================
  app.raw((project) {
    updateCustomFunction(
      project,
      name: 'calculateExtensionPrice',
      code: r'''
int ratePerThirtyMin = 2500;

if (timeSlot == '3部' || timeSlot == '4部') {
  ratePerThirtyMin = 3000;
}

int base = (minutes / 30).round() * ratePerThirtyMin;
int tax = (base * 0.1).round();
int total = base + tax;

return {
  'base': base,
  'tax': tax,
  'total': total,
};
''',
    );
  });

  // ==========================================================================
  // Phase 6 — Chat & notifications core (§3.5.7-9, §3.9.10, §3.9.16).
  //
  // Backend built first (firebase/functions/src/reservations.ts):
  // `sendChatMessage` (posting-lock enforced via `chat_rooms.active`, which
  // `respondToReservation`/`submitReview`/`autoCompleteReviews` already
  // correctly set/clear at exactly §3.5.7/3.5.8's trigger points — verified
  // by reading those functions, not re-implemented here), `getChatRoomInfo`
  // and `getMyMatchaList` (both Admin-SDK-required specifically to resolve
  // the COUNTERPART's nickname/photo — `users/{uid}`'s rule is identity-
  // only, so a client can never read another user's doc, the exact §33
  // bug class; deployed and confirmed live via `firebase functions:list`).
  // Two new Firestore rules closed pre-existing, explicitly-flagged gaps:
  // `chat_rooms/{roomId}/messages` (the 2026-08-03 rules comment named this
  // exact gap and left it open) and `users/{uid}/notifications` (same "no
  // rule = deny-all" class, never had one at all).
  //
  // §3.5.9's 5 history categories are derived from RESERVATION status, not
  // chat_room existence alone — "断られた"/"新しい" both cover reservations
  // that never had (or never will have) an open chat room. See
  // `getMyMatchaList`'s own doc comment in reservations.ts for the exact,
  // status-value-confirmed category mapping.
  //
  // Message sender identity is deliberately reduced to "自分"(me)/"相手"
  // (them) rather than the counterpart's real nickname per-message — the
  // counterpart's nickname is already shown once in the room header (fetched
  // via `getChatRoomInfo`), and resolving it AGAIN per-message would need
  // the same Admin-SDK round trip for no added information. Chat bubble
  // left/right alignment was also simplified to a uniform sender-labeled
  // row — this DSL's `itemBuilder:` produces ONE fixed widget shape per
  // list, no per-item structural branching (confirmed by reading how every
  // other dynamic list in this project — ReservationListPage, the Home
  // discovery grid — binds properties/text per item but never swaps
  // layout), so true two-sided chat bubbles aren't a shape this pattern can
  // express; disclosed as a simplification, not a silent omission.
  // ==========================================================================

  final splitFieldFn = app.customFunction(
    'splitField',
    args: {'data': string, 'index': int_},
    returns: string,
    description: '「|||」区切り文字列からN番目の項目を取り出す（チャット・お知らせ・マッチャ一覧共通ヘルパー）。',
    code: r'''
final parts = (data ?? '').split('|||');
final i = index ?? -1;
return (i >= 0 && i < parts.length) ? parts[i] : '';
''',
  );

  final filterListByFieldFn = app.customFunction(
    'filterListByField',
    args: {'items': listOf(string), 'fieldIndex': int_, 'targetValue': string},
    returns: listOf(string),
    description: '「|||」区切りリストを指定フィールドの値でフィルタする（"all"は全件返す、マッチャ一覧・お知らせ共通）。',
    code: r'''
final list = items ?? <String>[];
final idx = fieldIndex ?? -1;
final target = targetValue ?? '';
if (target.isEmpty || target == 'all') return list;
return list.where((item) {
  final parts = item.split('|||');
  if (idx < 0 || idx >= parts.length) return false;
  return parts[idx] == target;
}).toList();
''',
  );

  app.customAction(
    'fetchMyChatRooms',
    returns: listOf(string),
    description: 'getMyMatchaList Cloud Functionを呼び出し、自分が関わる全マッチャ（予約）を5分類対応の形式で取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchMyChatRooms() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getMyMatchaList');
    final result = await callable.call({});
    if (result.data is! Map || result.data['items'] is! List) return <String>[];
    final items = result.data['items'] as List;
    return items.map((raw) {
      final m = raw as Map;
      final resId = m['res_id']?.toString() ?? '';
      final category = m['category']?.toString() ?? '';
      final nickname = (m['counterpart_nickname']?.toString() ?? '').replaceAll('|||', '');
      final photo = m['counterpart_photo']?.toString() ?? '';
      final active = m['room_active'] == true;
      final lastMessage = (m['last_message']?.toString() ?? '').replaceAll('|||', '');
      return '$resId|||$category|||$nickname|||$photo|||$active|||$lastMessage';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'fetchChatRoomInfo',
    args: {'resId': string},
    returns: string,
    description: 'getChatRoomInfo Cloud Functionを呼び出し、1件のチャットルームの相手情報・開閉状態を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> fetchChatRoomInfo(String? resId) async {
  try {
    final rid = resId ?? '';
    if (rid.isEmpty) return '|||false';
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getChatRoomInfo');
    final result = await callable.call({'res_id': rid});
    if (result.data is! Map) return '|||false';
    final data = result.data as Map;
    final nickname = (data['counterpart_nickname']?.toString() ?? '').replaceAll('|||', '');
    final photo = data['counterpart_photo']?.toString() ?? '';
    final active = data['active'] == true;
    return '$nickname|||$photo|||$active';
  } catch (e) {
    return '|||false';
  }
}
''',
  );

  // `fetchChatMessages` already exists live — `app.customAction` compiles to
  // `ensureCustomAction` (create-if-missing only, confirmed the hard way
  // many times this session), so the original declaration is commented out
  // and the fix goes through `updateCustomAction` instead, per the
  // already-established rule for editing an already-landed custom action
  // (same pattern already used for `confirmStripePayment` above).
  //   app.customAction(
  //     'fetchChatMessages',
  //     args: {'resId': string},
  //     returns: listOf(string),
  //     description: '指定した予約のチャットルームのメッセージ履歴を取得する（chat_rooms/{roomId}/messages、参加者のみ読み取り可）。',
  //     code: r'''
  //     ... (superseded by the updateCustomAction call below — this comment
  //     block intentionally omits the stale original body) ...
  //     ''',
  //   );

  // FIX (confirmed live bug, found during comprehensive review): this query
  // used to filter ONLY on `res_id` — firestore.rules' `chat_rooms` read
  // rule requires `resource.data.participants.hasAny([uid])`, which
  // Firestore's rule engine can only prove for a QUERY (not a get-by-id)
  // when the query's OWN where-clauses already mirror the rule's condition
  // — a filter on `res_id` alone can't prove that, so this query was denied
  // outright for every non-admin caller, silently swallowed by the catch
  // below into an empty list. Every guest/cast opening a chat has seen zero
  // messages since this page was built. Adding the `participants`
  // array-contains filter lets the rule engine verify it statically,
  // matching the same pattern already used correctly elsewhere in this file
  // (e.g. reservations queries scoped by `cast_ids`/`array-contains`). A
  // matching composite index (`chat_rooms`: participants CONTAINS + res_id
  // ASC) was added to firestore.indexes.json and deployed.
  app.raw((project) {
    updateCustomAction(
      project,
      name: 'fetchChatMessages',
      code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<List<String>> fetchChatMessages(String? resId) async {
  try {
    final rid = resId ?? '';
    if (rid.isEmpty) return <String>[];
    final uid = currentUserUid;
    if (uid.isEmpty) return <String>[];
    final firestore = FirebaseFirestore.instance;
    final roomSnap = await firestore
        .collection('chat_rooms')
        .where('res_id', isEqualTo: rid)
        .where('participants', arrayContains: uid)
        .limit(1)
        .get();
    if (roomSnap.docs.isEmpty) return <String>[];
    final msgsSnap = await roomSnap.docs.first.reference
        .collection('messages')
        .orderBy('created_at')
        .get();
    return msgsSnap.docs.map((d) {
      final data = d.data();
      final senderId = data['sender_id']?.toString() ?? '';
      final senderLabel = senderId == uid ? '自分' : '相手';
      final text = (data['text']?.toString() ?? '').replaceAll('|||', '');
      var timeLabel = '';
      final ts = data['created_at'];
      if (ts is Timestamp) {
        final dt = ts.toDate();
        timeLabel =
            '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
      }
      return '$senderLabel|||$text|||$timeLabel';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
    );
  });

  app.customAction(
    'callSendChatMessage',
    args: {'resId': string, 'text': string},
    returns: bool_,
    description: 'sendChatMessage Cloud Functionを呼び出し、チャットメッセージを送信する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSendChatMessage(String? resId, String? text) async {
  try {
    final rid = resId ?? '';
    final t = (text ?? '').trim();
    if (rid.isEmpty || t.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('sendChatMessage');
    final result = await callable.call({'res_id': rid, 'text': t});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'fetchMyNotifications',
    returns: listOf(string),
    description: '自分のお知らせ一覧を取得する（users/{uid}/notifications、5カテゴリ: matching/work/cocoten/stripe/admin）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<List<String>> fetchMyNotifications() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return <String>[];
    final snap = await FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('notifications')
        .orderBy('created_at', descending: true)
        .limit(50)
        .get();
    return snap.docs.map((d) {
      final data = d.data();
      final type = data['type']?.toString() ?? '';
      final title = (data['title']?.toString() ?? '').replaceAll('|||', '');
      final body = (data['body']?.toString() ?? '').replaceAll('|||', '');
      final read = data['read'] == true;
      var timeLabel = '';
      final ts = data['created_at'];
      if (ts is Timestamp) {
        final dt = ts.toDate();
        timeLabel = '${dt.month}/${dt.day} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
      }
      return '${d.id}|||$type|||$title|||$body|||$read|||$timeLabel';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callMarkNotificationRead',
    args: {'notifId': string},
    returns: bool_,
    description: '自分のお知らせを既読にする（users/{uid}/notifications、readフィールドのみ更新可）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> callMarkNotificationRead(String? notifId) async {
  try {
    final uid = currentUserUid;
    final nid = notifId ?? '';
    if (uid.isEmpty || nid.isEmpty) return false;
    await FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('notifications')
        .doc(nid)
        .update({'read': true});
    return true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Both `matchaFilterTab` (MacchaPage's 5-tab row) and `notifFilterTab`
  // (NotificationsPage's 6-tab row) originally lived here as small local
  // helpers, each building one tappable filter-tab `Container`. Both
  // helpers' only call sites now sit inside FROZEN blocks — `matchaFilterTab`
  // inside a one-shot `ensureReplaced` that already landed, `notifFilterTab`
  // inside the `ensurePage` body that already landed (a page's initial
  // `ensurePage` call becomes re-validated-but-inert against typed-handle
  // rules once the page exists — see that block's own freeze comment) — so
  // neither helper has a remaining caller and both were removed rather than
  // left as dead code. The filter-tab UI itself is unaffected: it already
  // shipped correctly in the pushes that consumed these helpers: nothing
  // is missing from what a user sees, only this now-orphaned authoring-time
  // scaffolding was cleaned up.

  // ── MacchaChats: real message thread for one reservation's chat room.
  // Declared BEFORE MacchaPage below, since MacchaPage's own dynamic list
  // navigates to MacchaChats with a `resId` param — the compiler validates
  // that Navigate call against MacchaChats' CURRENTLY-declared params at
  // the point it's processed, so the param must exist before anything
  // references it (found the hard way: `editPageParams` placed after the
  // referencing `Navigate` call failed with "Unknown parameter resId...
  // Available: " — an empty list, since the param genuinely didn't exist
  // yet at that point in the operation sequence). ──
  app.editPageParams(ff.Pages.macchaChats, (params) {
    params.ensureParam('resId', string.withDefault(''));
  });

  app.editPageState(ff.Pages.macchaChats, (state) {
    state.ensureField('chatMessagesList', listOf(string));
    state.ensureField('counterpartNickname', string.withDefault(''));
    state.ensureField('counterpartPhoto', string.withDefault(''));
    state.ensureField('roomActive', bool_.withDefault(true));
    state.ensureField('newMessageText', string.withDefault(''));
  });

  app.editPage(ff.Pages.macchaChats, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchChatRoomInfo',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'chatRoomInfoResult',
        ),
        SetState(
          'counterpartNickname',
          CustomFunction(splitFieldFn, args: {'data': ActionOutput('chatRoomInfoResult'), 'index': 0}),
        ),
        SetState(
          'counterpartPhoto',
          CustomFunction(splitFieldFn, args: {'data': ActionOutput('chatRoomInfoResult'), 'index': 1}),
        ),
        SetState(
          'roomActive',
          Equals(
            CustomFunction(splitFieldFn, args: {'data': ActionOutput('chatRoomInfoResult'), 'index': 2}),
            'true',
          ),
        ),
        CallCustomAction.named(
          'fetchChatMessages',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'chatMessagesResult',
        ),
        SetState('chatMessagesList', ActionOutput('chatMessagesResult')),
      ],
    );

    // Header — replaced the two static "ゲスト"/"キャスト" labels with the
    // real counterpart nickname/photo (resolved server-side above, since
    // reading another user's own profile is rules-blocked client-side).
    //   page.ensureReplaced(
    //   page.findByKey('Row_xuyify4c'),
    //   Row(
    //   name: 'ChatHeaderRow',
    //   spacing: 8,
    //   children: [
    //   Avatar(imageUrl: State('counterpartPhoto'), size: 40),
    //   Text(State('counterpartNickname'), style: Styles.titleMedium),
    //   ],
    //   ),
    //   );

    // Message list — was a static single-exchange mockup with a dead,
    // unfiltered `databaseRequest` against the wrong (unused) `chats`
    // collection, already cleared earlier in this file (see that block's
    // own comment). Replaced here with the real dynamic list.
    //   page.ensureReplaced(
    //   page.findByKey('ListView_84hpa09g'),
    //   ListView(
    //   name: 'ChatMessagesListView',
    //   shrinkWrap: true,
    //   spacing: 6,
    //   source: State('chatMessagesList'),
    //   itemBuilder: (item) => Container(
    //   padding: 8,
    //   child: Row(
    //   spacing: 8,
    //   children: [
    //   Text(
    //   CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
    //   style: Styles.labelSmall,
    //   ),
    //   Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
    //   Text(
    //   CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
    //   style: Styles.labelSmall,
    //   ),
    //   ],
    //   ),
    //   ),
    //   ),
    //   );

    // Review-pass fix (2026-08-11): the block above landed with
    // `shrinkWrap: true` on a list that is NOT nested inside another
    // scrollable (unlike MacchaPage's `MatchaItemsListView`, which
    // genuinely is) — it's one of several siblings in a plain, non-
    // scrolling `Column` (header Card, this list, the input row). A
    // shrink-wrapped list there sizes to its own content instead of
    // filling the available space, and with enough messages the Column
    // would overflow (no bounded height to constrain it). Fixed by
    // wrapping in `Expanded` (the Column IS in a bounded context — direct
    // Scaffold body — so Expanded resolves correctly) and reverting to the
    // default `shrinkWrap: false`, the same fix class already applied to
    // ReservationListPage's own R19 finding, adapted for a list with Column
    // siblings rather than being the Scaffold's sole body child. Targets
    // the NEW key (`ListView_rlyf5278`, confirmed via the regenerated typed
    // SDK after the previous push) since `ensureReplaced` on the ORIGINAL
    // key is one-shot and already consumed.
    //
    // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
    // generated_code — `ensureReplaced` has no dedup guard, so leaving this
    // live risked reassigning fresh keys to the whole subtree on every
    // future unrelated push. Commented out per the established freeze
    // discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md).
    // page.ensureReplaced(
    //   page.findByKey('ListView_rlyf5278'),
    //   Expanded(
    //     ListView(
    //       name: 'ChatMessagesListView',
    //       spacing: 6,
    //       source: State('chatMessagesList'),
    //       itemBuilder: (item) => Container(
    //         padding: 8,
    //         child: Row(
    //           spacing: 8,
    //           children: [
    //             Text(
    //               CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
    //               style: Styles.labelSmall,
    //             ),
    //             Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
    //             Text(
    //               CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
    //               style: Styles.labelSmall,
    //             ),
    //           ],
    //         ),
    //       ),
    //     ),
    //     name: 'ChatMessagesListExpanded',
    //   ),
    // );

    // Message input — gave it a real name (required for `ClearTextField`
    // below) and bound its value to state via `onChanged`; this DSL's
    // `TextField` has no dynamic initial-value binding at all (confirmed
    // project quirk), so it stays a plain input, not pre-filled.
    //   page.ensureReplaced(
    //   page.findByKey('TextField_iucuj771'),
    //   TextField(
    //   name: 'ChatMessageInput',
    //   hint: 'メッセージ',
    //   onChanged: SetState('newMessageText', const TextValue()),
    //   ),
    //   );

    // Send button — `Icon_jm5abnro` already had an ON_TAP trigger declared
    // from the original scaffold but no action wired. Gated on `roomActive`
    // client-side as a UX-only check (matching the `profileLoaded` pattern
    // elsewhere in this project) — `sendChatMessage` independently and
    // authoritatively re-checks the same condition server-side regardless.
    page.ensureActions(
      page.findByKey('Icon_jm5abnro'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          State('roomActive'),
          then: [
            CallCustomAction.named(
              'callSendChatMessage',
              arguments: {'resId': PageParam('resId'), 'text': State('newMessageText')},
              outputAs: 'sendMessageResult',
            ),
            If(
              ActionOutput('sendMessageResult'),
              then: [
                SetState('newMessageText', ''),
                ClearTextField('ChatMessageInput'),
                CallCustomAction.named(
                  'fetchChatMessages',
                  arguments: {'resId': PageParam('resId')},
                  outputAs: 'refetchedMessages',
                ),
                SetState('chatMessagesList', ActionOutput('refetchedMessages')),
              ],
              orElse: [Snackbar('送信に失敗しました。')],
            ),
          ],
          orElse: [Snackbar('このチャットは終了しています。')],
        ),
      ],
    );

    // Back button — `Image_wwzammb9` already had an ON_TAP trigger declared
    // but no action wired.
    page.ensureActions(
      page.findByKey('Image_wwzammb9'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [NavigateBack()],
    );
  });

  // ── MacchaPage: real マッチャ list, replacing the 5 hardcoded static
  // cards, with the 5-category filter row (§3.5.9). ──
  app.editPageState(ff.Pages.macchaPage, (state) {
    state.ensureField('myChatRoomsList', listOf(string));
    state.ensureField('visibleMatchaList', listOf(string));
    state.ensureField('matchaFilter', string.withDefault('all'));
  });

  app.editPage(ff.Pages.macchaPage, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named('fetchMyChatRooms', outputAs: 'myChatRoomsResult'),
        SetState('myChatRoomsList', ActionOutput('myChatRoomsResult')),
        SetState('visibleMatchaList', ActionOutput('myChatRoomsResult')),
      ],
    );

    // `Text_xtput46n` was the single static "すべてのマッチャ" label —
    // replaced with the real 5-tab filter row (§3.5.9's exact 5 categories).
    //   page.ensureReplaced(
    //   page.findByKey('Text_xtput46n'),
    //   Row(
    //   name: 'MatchaFilterTabs',
    //   spacing: 8,
    //   children: [
    //   matchaFilterTab('all', 'すべて'),
    //   matchaFilterTab('new', '新しい'),
    //   matchaFilterTab('not_interacted', '未交流'),
    //   matchaFilterTab('interacted', '交流済み'),
    //   matchaFilterTab('declined', '断られた'),
    //   ],
    //   ),
    //   );

    // `Column_bs3ts5ma` held the 5 hand-authored static Cards directly —
    // replaced with a real dynamic list bound to the fetched/filtered
    // マッチャ data. Nested inside the page's own outer `ListView_w1igv74t`
    // (unchanged), so `shrinkWrap: true` here (bounded-height nested list),
    // matching the same reasoning already applied to admin-scale nested
    // lists elsewhere in this project.
    //   page.ensureReplaced(
    //   page.findByKey('Column_bs3ts5ma'),
    //   ListView(
    //   name: 'MatchaItemsListView',
    //   shrinkWrap: true,
    //   spacing: 8,
    //   source: State('visibleMatchaList'),
    //   itemBuilder: (item) => Card(
    //   name: 'MatchaItemCard',
    //   onTap: [
    //   Navigate(
    //   ff.Pages.macchaChats,
    //   params: {
    //   'resId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
    //   },
    //   ),
    //   ],
    //   child: Container(
    //   padding: 12,
    //   child: Row(
    //   spacing: 8,
    //   children: [
    //   Avatar(
    //   imageUrl: CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}),
    //   size: 44,
    //   ),
    //   Column(
    //   crossAxis: CrossAxis.start,
    //   children: [
    //   Text(
    //   CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
    //   style: Styles.titleSmall,
    //   ),
    //   Text(
    //   CustomFunction(splitFieldFn, args: {'data': item, 'index': 5}),
    //   style: Styles.bodySmall,
    //   maxLines: 1,
    //   overflow: TextOverflow.ellipsis,
    //   ),
    //   ],
    //   ),
    //   ],
    //   ),
    //   ),
    //   ),
    //   ),
    //   );

    // "お知らせ" (notifications) icon — declared with an ON_TAP trigger
    // from the original scaffold but never wired to any action.
    page.ensureActions(
      page.findByKey('Column_0mgdi479'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.notificationsPage)],
    );
  });

  // ── NotificationsPage: brand-new page, §3.9.16's Stripe-webhook mirror
  // + §3.8.16's 5-category notification set (matching/work/cocoten/stripe/
  // admin), server-side write path already fully live (17 call sites
  // across auth.ts/admin.ts/affiliate.ts/reservations.ts/stripe-payments.ts/
  // stripe-webhooks.ts) — this page is purely the client-side read/display
  // half that never existed until now. ──
  // FROZEN (2026-08-11): NotificationsPage now exists (created by this
  // exact `ensurePage` call on the first Phase 6 push) — re-validated on
  // every subsequent compile despite `ensurePage` itself being a no-op
  // for creation, and this body's bare `State('visibleNotifications')`/
  // `SetState('notifFilter', ...)` sugar fails that validation once the
  // page is real (`Use ff.Pages.notificationsPage.state.notifFilter
  // instead of SetState("notifFilter", ...)`) — the exact same
  // `ensurePage`-body-inert failure this file's own KycReviewPage/
  // ReservationListPage/BasicInfoRegistration comments already document.
  // Any FUTURE change to this page's own content must go through
  // app.editPage(ff.Pages.notificationsPage, ...) instead (see the fix
  // right below, which already does this for the one change needed so
  // far).
  //   app.ensurePage(
  //     'NotificationsPage',
  //     route: '/notifications',
  //     description: 'お知らせ一覧ページ（matching/work/cocoten/stripe/adminの5カテゴリでフィルタ、タップで既読化）。',
  //     state: {
  //       'notificationsList': listOf(string),
  //       'visibleNotifications': listOf(string),
  //       'notifFilter': string.withDefault('all'),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('fetchMyNotifications', outputAs: 'notificationsResult'),
  //       SetState('notificationsList', ActionOutput('notificationsResult')),
  //       SetState('visibleNotifications', ActionOutput('notificationsResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'お知らせ'),
  //       body: Column(
  //         children: [
  //           Row(
  //             name: 'NotifFilterTabs',
  //             spacing: 8,
  //             children: [
  //               notifFilterTab('all', 'すべて'),
  //               notifFilterTab('matching', 'マッチング'),
  //               notifFilterTab('work', 'ワーク'),
  //               notifFilterTab('cocoten', 'ココ店'),
  //               notifFilterTab('stripe', '決済'),
  //               notifFilterTab('admin', '運営'),
  //             ],
  //           ),
  //           ListView(
  //             name: 'NotificationsListView',
  //             shrinkWrap: true,
  //             spacing: 8,
  //             padding: 16,
  //             source: State('visibleNotifications'),
  //             itemBuilder: (item) => Card(
  //               name: 'NotificationCard',
  //               onTap: [
  //                 CallCustomAction.named(
  //                   'callMarkNotificationRead',
  //                   arguments: {
  //                     'notifId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                   },
  //                 ),
  //                 CallCustomAction.named('fetchMyNotifications', outputAs: 'notifRefetchResult'),
  //                 SetState('notificationsList', ActionOutput('notifRefetchResult')),
  //                 SetState(
  //                   'visibleNotifications',
  //                   CustomFunction(
  //                     filterListByFieldFn,
  //                     args: {
  //                       'items': ActionOutput('notifRefetchResult'),
  //                       'fieldIndex': 1,
  //                       'targetValue': State('notifFilter'),
  //                     },
  //                   ),
  //                 ),
  //               ],
  //               child: Container(
  //                 padding: 12,
  //                 child: Column(
  //                   crossAxis: CrossAxis.start,
  //                   spacing: 4,
  //                   children: [
  //                     Row(
  //                       spacing: 8,
  //                       children: [
  //                         Text(
  //                           CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                           style: Styles.titleSmall,
  //                         ),
  //                         Text(
  //                           CustomFunction(splitFieldFn, args: {'data': item, 'index': 4}),
  //                           style: Styles.labelSmall,
  //                         ),
  //                       ],
  //                     ),
  //                     Text(
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}),
  //                       maxLines: 2,
  //                       overflow: TextOverflow.ellipsis,
  //                     ),
  //                     Text(
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 5}),
  //                       style: Styles.labelSmall,
  //                     ),
  //                   ],
  //                 ),
  //               ),
  //             ),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // Review-pass fix (2026-08-11): same R19-class shrinkWrap-on-a-non-nested
  // list finding as MacchaChats' `ChatMessagesListView` above —
  // `NotificationsListView` sits inside a plain Column alongside the filter
  // tabs Row, not nested inside another scrollable, so `shrinkWrap: true`
  // (the default the `ensurePage` body above landed with) risks an overflow
  // once there are enough notifications. `ensurePage` itself is idempotent
  // and won't re-apply a body change to an already-existing page, so the
  // fix goes through a separate `editPage`/`ensureReplaced` targeting the
  // live key (`ListView_bt6qn7dp`, confirmed via the regenerated typed SDK).
  // Uses `ff.Pages.notificationsPage.state.*` typed handles throughout,
  // not the bare `State('visibleNotifications')`/`SetState('notifFilter',
  // ...)` sugar the original `ensurePage` body used successfully — that
  // sugar only works while a page is still being freshly declared;
  // confirmed the hard way (`Use ff.Pages.notificationsPage.state.notifFilter
  // instead of SetState("notifFilter", ...)`) on this exact follow-up edit,
  // the same already-documented "ensurePage-body-inert" failure mode this
  // file's own KycReviewPage/ReservationListPage/BasicInfoRegistration
  // comments describe at length — repeated here despite having read all
  // three, a reminder that this class of mistake is easy to make again
  // under time pressure on a brand-new page's first follow-up edit.
  //
  // FROZEN (2026-08-11, review pass): landed correctly, but a SECOND
  // review-pass bug was found in the same itemBuilder this block authored
  // (see the new block below) — `ensureReplaced` already consumed
  // `ListView_bt6qn7dp` when this landed, giving the replacement a new key
  // (`ListView_fev2xlkv`, confirmed via the regenerated typed SDK), so the
  // fix targets that new key rather than re-running this one.
  //   app.editPage(ff.Pages.notificationsPage, (page) {
  //     page.ensureReplaced(
  //       page.findByKey('ListView_bt6qn7dp'),
  //       Expanded(
  //         ListView(
  //           name: 'NotificationsListView',
  //           spacing: 8,
  //           padding: 16,
  //           source: State(ff.Pages.notificationsPage.state.visibleNotifications),
  //           itemBuilder: (item) => Card(
  //             name: 'NotificationCard',
  //             onTap: [
  //               CallCustomAction.named(
  //                 'callMarkNotificationRead',
  //                 arguments: {
  //                   'notifId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                 },
  //               ),
  //               CallCustomAction.named('fetchMyNotifications', outputAs: 'notifRefetchResult'),
  //               SetState(ff.Pages.notificationsPage.state.notificationsList, ActionOutput('notifRefetchResult')),
  //               SetState(
  //                 ff.Pages.notificationsPage.state.visibleNotifications,
  //                 CustomFunction(
  //                   filterListByFieldFn,
  //                   args: {
  //                     'items': ActionOutput('notifRefetchResult'),
  //                     'fieldIndex': 1,
  //                     'targetValue': State(ff.Pages.notificationsPage.state.notifFilter),
  //                   },
  //                 ),
  //               ),
  //             ],
  //             child: Container(
  //               padding: 12,
  //               child: Column(
  //                 crossAxis: CrossAxis.start,
  //                 spacing: 4,
  //                 children: [
  //                   Row(
  //                     spacing: 8,
  //                     children: [
  //                       Text(
  //                         CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                         style: Styles.titleSmall,
  //                       ),
  //                       Text(
  //                         CustomFunction(splitFieldFn, args: {'data': item, 'index': 4}),
  //                         style: Styles.labelSmall,
  //                       ),
  //                     ],
  //                   ),
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}),
  //                     maxLines: 2,
  //                     overflow: TextOverflow.ellipsis,
  //                   ),
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 5}),
  //                     style: Styles.labelSmall,
  //                   ),
  //                 ],
  //               ),
  //             ),
  //           ),
  //         ),
  //         name: 'NotificationsListExpanded',
  //       ),
  //     );
  //   });

  // Review-pass fix (2026-08-11): the block above rendered the raw `read`
  // boolean's string form ("true"/"false") directly next to every
  // notification's title — a real, confirmed UI defect (not hypothetical;
  // re-reading the itemBuilder's own `CustomFunction(splitFieldFn,
  // args: {..., 'index': 4})` call showed it feeding straight into a `Text`
  // with no translation step, unlike every other status-ish value displayed
  // elsewhere in this project, which always goes through a label-mapping
  // function first). Fixed with a small new extractor that maps the literal
  // "true"/"false" string to real Japanese labels.
  final readStatusLabelFn = app.customFunction(
    'readStatusLabel',
    args: {'value': string},
    returns: string,
    description: '通知の既読/未読フラグ文字列（"true"/"false"）を表示用ラベル（既読/未読）に変換する。',
    code: r'''
return (value == 'true') ? '既読' : '未読';
''',
  );

  // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
  // generated_code — `ensureReplaced` has no dedup guard, so leaving this
  // live risked reassigning fresh keys to the whole subtree (and
  // invalidating `readStatusLabelFn`'s only call site) on every future
  // unrelated push. Commented out per the established freeze discipline
  // (PROJECT_KNOWLEDGE.md §54/project_rules.md). `readStatusLabelFn`'s own
  // `app.customFunction(...)` declaration above is left live/registered —
  // only its widget-tree usage moves here — since ensureCustomFunction is
  // safe to leave active indefinitely (unlike ensureReplaced).
  // app.editPage(ff.Pages.notificationsPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_fev2xlkv'),
  //     Expanded(
  //       ListView(
  //         name: 'NotificationsListView',
  //         spacing: 8,
  //         padding: 16,
  //         source: State(ff.Pages.notificationsPage.state.visibleNotifications),
  //         itemBuilder: (item) => Card(
  //           name: 'NotificationCard',
  //           onTap: [
  //             CallCustomAction.named(
  //               'callMarkNotificationRead',
  //               arguments: {
  //                 'notifId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //               },
  //             ),
  //             CallCustomAction.named('fetchMyNotifications', outputAs: 'notifRefetchResult'),
  //             SetState(ff.Pages.notificationsPage.state.notificationsList, ActionOutput('notifRefetchResult')),
  //             SetState(
  //               ff.Pages.notificationsPage.state.visibleNotifications,
  //               CustomFunction(
  //                 filterListByFieldFn,
  //                 args: {
  //                   'items': ActionOutput('notifRefetchResult'),
  //                   'fieldIndex': 1,
  //                   'targetValue': State(ff.Pages.notificationsPage.state.notifFilter),
  //                 },
  //               ),
  //             ),
  //           ],
  //           child: Container(
  //             padding: 12,
  //             child: Column(
  //               crossAxis: CrossAxis.start,
  //               spacing: 4,
  //               children: [
  //                 Row(
  //                   spacing: 8,
  //                   children: [
  //                     Text(
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                       style: Styles.titleSmall,
  //                     ),
  //                     Text(
  //                       CustomFunction(
  //                         readStatusLabelFn,
  //                         args: {'value': CustomFunction(splitFieldFn, args: {'data': item, 'index': 4})},
  //                       ),
  //                       style: Styles.labelSmall,
  //                     ),
  //                   ],
  //                 ),
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}),
  //                   maxLines: 2,
  //                   overflow: TextOverflow.ellipsis,
  //                 ),
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 5}),
  //                   style: Styles.labelSmall,
  //                 ),
  //               ],
  //             ),
  //           ),
  //         ),
  //       ),
  //       name: 'NotificationsListExpanded2',
  //     ),
  //   );
  // });

  // Wire both known "お知らせ" (notifications) entry points to the new
  // page — MacchaPage's own (above) and HomePage's, both declared with an
  // ON_TAP trigger from their original scaffolds but never wired.
  app.editPage(ff.Pages.homePage, (page) {
    page.ensureActions(
      page.findByKey('Column_w5wltkuu'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.notificationsPage)],
    );

    // Comprehensive review pass (2026-08-12): `ReservationListPage`
    // (IMPLEMENTATION_PLAN.md §7 — the client's explicitly-requested
    // "reservation list, not the Maccha match feed") was fully built
    // (§14) but had ZERO incoming navigation anywhere in the app — a
    // "built but nobody can get to it" bug, same class as
    // MyWorkContent/Affiliate/BlockList before each was fixed, but with a
    // larger blast radius: `ReservationDetail` (approve/decline/meetup/
    // complete/rate/cancel) and `ExtensionPayment` are ONLY reachable from
    // this page's own row-tap, so the entire post-booking
    // reservation-management flow was an orphaned island. No existing
    // AppBar icon fits semantically (both HomePage's and MacchaPage's
    // "検索"/"お知らせ" icon slots are either already wired to something
    // else or a poor semantic fit for "my reservations") — added a new
    // third icon instead, matching the exact precedent already
    // established for this same class of gap (WorkPage's "マイワーク" nav
    // icon, Phase 10).
    // `Column` has no `onTap:` parameter in this DSL (confirmed by reading
    // its constructor — only the ORIGINAL native scaffold's Columns carry
    // an onTap-capable trigger at the proto level, not something newly
    // DSL-authored ones can replicate) — use `Button` instead, matching
    // the exact precedent already proven for this same "add a new nav
    // icon" situation (WorkPage's `MyWorkNavButton`, Phase 10).
    //
    // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
    // §64): confirmed landed via generated_code/lib/home/home_page/
    // home_page_widget.dart (the "予約一覧" Button with
    // ReservationListPageWidget.routeName navigation is present) and via
    // lib/flutterflow_project/pages/home_page.dart (name
    // "ReservationListNavButton", anchor Column_w5wltkuu still exists — this
    // one wouldn't have hard-failed a re-run like the ensureReplaced calls
    // above, since the anchor isn't consumed, but re-running would silently
    // no-op any future change authored in this exact block).
    // page.ensureInsertedAfter(
    //   page.findByKey('Column_w5wltkuu'),
    //   Button(
    //     '予約一覧',
    //     icon: 'event_note',
    //     variant: ButtonVariant.text,
    //     name: 'ReservationListNavButton',
    //     onTap: [Navigate(ff.Pages.reservationListPage)],
    //   ),
    // );
  });

  // ==========================================================================
  // Phase 7 — Reviews, tips, safety (§3.6.14-17, §3.7.13-14).
  //
  // Backend audit first, same discipline as every phase this session:
  // `submitReview` (review SUBMISSION) turned out to be already fully wired
  // — `IMPLEMENTATION_PLAN.md`'s own `[MISSING]` marker for §3.6.14/§3.7.13
  // was stale, landed back in Phase 4 but never updated in the plan doc
  // (fixed as part of this phase's own documentation pass). `processTip`,
  // `blockUser`, `reportUser`, `adminGetReports`, `adminResolveReport` all
  // already existed as correct, complete Cloud Functions — this phase is
  // almost entirely UI wiring, not backend building. Two real gaps WERE
  // found and fixed before any DSL work started: `adminGetReportChatLog`
  // existed in source but was missing from live deployment (the exact §34
  // bug class), and `reviews` had no Firestore rule at all (the exact
  // "no rule = deny-all" gap class as `chat_rooms/{id}/messages` and
  // `users/{uid}/notifications` from Phase 6) — both fixed server-side
  // before writing any DSL (deployed function, added a public-read rule
  // matching the `cocoten_shops`/`banners` precedent). `getDiscoveryCasts`
  // was also patched to exclude the viewer's own `blocked_users` from
  // results (§3.6.17's literal wording is unidirectional — "the blocker's
  // search results" — the reverse case, hiding a guest from a cast who
  // blocked them, is a separate undecided question, not silently assumed).
  // ==========================================================================

  final reviewItemRatingLabelFn = app.customFunction(
    'reviewItemRatingLabel',
    args: {'item': string},
    returns: string,
    description: 'レビュー1件分の文字列（rating|||comment|||date）から評価を★付きラベルで取り出す。',
    code: r'''
final parts = (item ?? '').split('|||');
final rating = parts.isNotEmpty ? parts[0] : '';
return '★$rating';
''',
  );

  final averageRatingLabelFn = app.customFunction(
    'averageRatingLabel',
    args: {'reviews': listOf(string)},
    returns: string,
    description: 'レビューリストから平均評価を計算し、表示用ラベル（例: ★4.5 (12件)）を返す。レビューが無い場合は「レビューなし」。',
    code: r'''
final list = reviews ?? <String>[];
if (list.isEmpty) return 'レビューなし';
double total = 0;
int count = 0;
for (final item in list) {
  final parts = item.split('|||');
  if (parts.isNotEmpty) {
    final r = double.tryParse(parts[0]);
    if (r != null) {
      total += r;
      count++;
    }
  }
}
if (count == 0) return 'レビューなし';
final avg = total / count;
return '★${avg.toStringAsFixed(1)} (${count}件)';
''',
  );

  app.customAction(
    'fetchCastReviews',
    args: {'castId': string},
    returns: listOf(string),
    description: '指定したキャストが受け取ったレビュー一覧を取得する（reviewsコレクション、公開読み取り可）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';

Future<List<String>> fetchCastReviews(String? castId) async {
  try {
    final cid = castId ?? '';
    if (cid.isEmpty) return <String>[];
    final snap = await FirebaseFirestore.instance
        .collection('reviews')
        .where('reviewee_id', isEqualTo: cid)
        .orderBy('created_at', descending: true)
        .limit(50)
        .get();
    return snap.docs.map((d) {
      final data = d.data();
      final rating = data['rating']?.toString() ?? '0';
      final comment = (data['comment']?.toString() ?? '').replaceAll('|||', '');
      var dateLabel = '';
      final ts = data['created_at'];
      if (ts is Timestamp) {
        final dt = ts.toDate();
        dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
      }
      return '$rating|||$comment|||$dateLabel';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callReportUser',
    args: {'reportedId': string, 'reason': string},
    returns: bool_,
    description: 'reportUser Cloud Functionを呼び出し、ユーザーを通報する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callReportUser(String? reportedId, String? reason) async {
  try {
    final rid = reportedId ?? '';
    final r = (reason ?? '').trim();
    if (rid.isEmpty || r.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('reportUser');
    final result = await callable.call({'reported_id': rid, 'reason': r});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // ==========================================================================
  // Phase 11 slice 3 — legal-content viewers + inquiry form (drawer row 6,
  // サポート・法的項目 — left unwired in slice 1 because none of this
  // existed yet). No real ToS/privacy-policy text exists anywhere in this
  // repo (confirmed again this session) — IMPLEMENTATION_PLAN.md's own
  // Phase 0.5 flags this as a legal drafting deliverable, not a coding
  // task. Built for real, with explicit placeholder content per the
  // client-facing decision already made when this gap was first
  // disclosed (slice 1) — not fabricated legal text.
  // ==========================================================================

  app.customAction(
    'callSubmitInquiry',
    args: {'subject': string, 'message': string},
    returns: bool_,
    description: 'submitInquiry Cloud Functionを呼び出し、運営への問い合わせを送信する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callSubmitInquiry(String? subject, String? message) async {
  try {
    final s = (subject ?? '').trim();
    final m = (message ?? '').trim();
    if (s.isEmpty || m.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('submitInquiry');
    final result = await callable.call({'subject': s, 'message': m});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // FROZEN (2026-08-12, same-turn review step, immediately after this exact
  // push landed): all 4 pages now exist — confirmed via
  // generated_code/lib/{terms_of_service,privacy_policy,inquiry_form,
  // support_legal_hub}/ and lib/flutterflow_project/pages/{terms_of_service,
  // privacy_policy,inquiry_form,support_legal_hub}.dart. Same rationale as
  // SystemInfo/BlockList in slices 1-2 — `ensurePage` is idempotent (won't
  // error if left live) but would silently no-op any future edit to these
  // pages' bodies. Any future change must go through
  // `app.editPage(ff.Pages.<name>, ...)` instead. The drawer-wiring block
  // below and SupportLegalHub's own onTap references now use `ff.Pages.*`
  // (the real typed handles, regenerated after this push) instead of the
  // locally-captured variables, which were only needed within the run that
  // created them.
  //   const legalPlaceholderText =
  //       '本規約の内容は法務レビュー待ちです。最終版が確定次第、本画面に反映されます。';
  //   final termsOfServicePage = app.ensurePage(
  //     'TermsOfService',
  //     route: '/terms-of-service',
  //     description: '利用規約ページ（代行受領スキーム・手数料条項を含む）。',
  //     body: Scaffold(
  //       appBar: AppBar(title: '利用規約'),
  //       body: Column(
  //         padding: 16,
  //         children: [
  //           Text(
  //             '本規約には、予約手数料および代行受領スキーム（プラットフォームがゲストからの決済を受領し、キャストへの支払義務を履行する仕組み）に関する条項を含みます。',
  //             style: Styles.labelSmall,
  //           ),
  //           Text(legalPlaceholderText, style: Styles.bodyMedium),
  //         ],
  //       ),
  //     ),
  //   );
  //   final privacyPolicyPage = app.ensurePage(
  //     'PrivacyPolicy',
  //     route: '/privacy-policy',
  //     description: 'プライバシーポリシーページ。',
  //     body: Scaffold(
  //       appBar: AppBar(title: 'プライバシーポリシー'),
  //       body: Column(
  //         padding: 16,
  //         children: [
  //           Text(legalPlaceholderText, style: Styles.bodyMedium),
  //         ],
  //       ),
  //     ),
  //   );
  //   final inquiryFormPage = app.ensurePage(
  //     'InquiryForm',
  //     route: '/inquiry',
  //     description: 'お問い合わせページ（運営への一般問い合わせフォーム）。',
  //     state: {
  //       'inquirySubject': string.withDefault(''),
  //       'inquiryMessage': string.withDefault(''),
  //     },
  //     body: Scaffold(
  //       appBar: AppBar(title: 'お問い合わせ'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         children: [
  //           TextField(
  //             name: 'InquirySubjectField',
  //             hint: '件名',
  //             onChanged: SetState('inquirySubject', const TextValue()),
  //           ),
  //           TextField(
  //             name: 'InquiryMessageField',
  //             hint: 'お問い合わせ内容',
  //             onChanged: SetState('inquiryMessage', const TextValue()),
  //           ),
  //           // No `And`/`Or` boolean combinator exists in this DSL (confirmed
  //           // by reading references.dart — only `Not` does) — two required
  //           // fields are validated via nested `If`s instead of a single
  //           // combined condition, matching this file's own established
  //           // pattern for multi-step validation elsewhere.
  //           Button(
  //             '送信する',
  //             onTap: [
  //               If(
  //                 Not(Equals(State('inquirySubject'), '')),
  //                 then: [
  //                   If(
  //                     Not(Equals(State('inquiryMessage'), '')),
  //                     then: [
  //                       CallCustomAction.named(
  //                         'callSubmitInquiry',
  //                         arguments: {'subject': State('inquirySubject'), 'message': State('inquiryMessage')},
  //                         outputAs: 'inquiryResult',
  //                       ),
  //                       If(
  //                         ActionOutput('inquiryResult'),
  //                         then: [
  //                           SetState('inquirySubject', ''),
  //                           SetState('inquiryMessage', ''),
  //                           Snackbar('お問い合わせを送信しました。'),
  //                         ],
  //                         orElse: [Snackbar('送信に失敗しました。')],
  //                       ),
  //                     ],
  //                     orElse: [Snackbar('お問い合わせ内容を入力してください。')],
  //                   ),
  //                 ],
  //                 orElse: [Snackbar('件名を入力してください。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  //   final supportLegalHubPage = app.ensurePage(
  //     'SupportLegalHub',
  //     route: '/support-legal',
  //     description: 'サポート・法的項目ページ（利用規約・プライバシーポリシー・お問い合わせへの入口）。',
  //     body: Scaffold(
  //       appBar: AppBar(title: 'サポート・法的項目'),
  //       body: Column(
  //         children: [
  //           Button(
  //             '利用規約',
  //             variant: ButtonVariant.text,
  //             onTap: [Navigate(termsOfServicePage)],
  //           ),
  //           Button(
  //             'プライバシーポリシー',
  //             variant: ButtonVariant.text,
  //             onTap: [Navigate(privacyPolicyPage)],
  //           ),
  //           Button(
  //             'お問い合わせ',
  //             variant: ButtonVariant.text,
  //             onTap: [Navigate(inquiryFormPage)],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  app.customAction(
    'callBlockUser',
    args: {'targetUid': string},
    returns: bool_,
    description: 'blockUser Cloud Functionを呼び出し、ユーザーをブロックする。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callBlockUser(String? targetUid) async {
  try {
    final uid = targetUid ?? '';
    if (uid.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('blockUser');
    final result = await callable.call({'target_uid': uid});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // ==========================================================================
  // Phase 11 slice 2 — block-list viewer + unblock (§3.7.14's other half —
  // blockUser above is add-only; nothing views or reverses it).
  // ==========================================================================

  app.customAction(
    'callUnblockUser',
    args: {'targetUid': string},
    returns: bool_,
    description: 'unblockUser Cloud Functionを呼び出し、ユーザーのブロックを解除する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callUnblockUser(String? targetUid) async {
  try {
    final uid = targetUid ?? '';
    if (uid.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('unblockUser');
    final result = await callable.call({'target_uid': uid});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'fetchBlockedUsers',
    returns: listOf(string),
    description: 'getBlockedUsersDetails Cloud Functionを呼び出し、ブロック中のユーザー一覧（uid|||nickname|||photoUrl）を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchBlockedUsers() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getBlockedUsersDetails');
    final result = await callable.call();
    if (result.data is Map && result.data['items'] is List) {
      return (result.data['items'] as List).map((e) => e.toString()).toList();
    }
    return <String>[];
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  // ── CastProfile: reviews (§3.7.13) + report/block (§3.6.17/§3.7.14). ──
  app.editPageState(ff.Pages.castProfile, (state) {
    state.ensureField('castReviewsList', listOf(string));
    state.ensureField('reportReason', string.withDefault(''));
  });

  app.editPage(ff.Pages.castProfile, (page) {
    // No existing ON_INIT_STATE chain on this page's root (confirmed via
    // the typed SDK — only the two invite buttons' ON_TAP triggers existed
    // before this phase) — safe to add directly, not a second chain on an
    // already-wired trigger.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchCastReviews',
          arguments: {'castId': PageParam('castId')},
          outputAs: 'castReviewsResult',
        ),
        SetState('castReviewsList', ActionOutput('castReviewsResult')),
      ],
    );

    // Appended as a new section after the existing 3-tab profile/photo/
    // schedule container (the page's last existing child) — additive, does
    // not disturb the invite-button row or the tabs themselves.
    //
    // FROZEN (2026-08-12, comprehensive review pass): confirmed landed —
    // `CastReviewsAndSafetySection` exists in
    // lib/flutterflow_project/pages/cast_profile.dart. `ensureInsertedAfter`
    // is one-shot (create-if-missing by name at the anchor); the anchor key
    // `Container_vk811dsc` still exists, so a future unrelated push
    // re-running this exact call would silently no-op (harmless today) —
    // but any future EDIT to this section's content would be silently
    // ignored the same way, per this file's own established
    // `ensureInsertedAfter` one-shot discipline. Any future change to this
    // section must go through `app.editPage(ff.Pages.castProfile, ...)`
    // targeting its real widget keys instead.
    // page.ensureInsertedAfter(
    //   page.findByKey('Container_vk811dsc'),
    //   Container(
    //     name: 'CastReviewsAndSafetySection',
    //     padding: 16,
    //     child: Column(
    //       crossAxis: CrossAxis.start,
    //       spacing: 12,
    //       children: [
    //         Text('レビュー', style: Styles.titleMedium),
    //         Text(
    //           CustomFunction(averageRatingLabelFn, args: {'reviews': State('castReviewsList')}),
    //           style: Styles.bodyMedium,
    //         ),
    //         ListView(
    //           name: 'CastReviewsListView',
    //           shrinkWrap: true,
    //           spacing: 8,
    //           source: State('castReviewsList'),
    //           itemBuilder: (item) => Card(
    //             name: 'ReviewCard',
    //             child: Container(
    //               padding: 12,
    //               child: Column(
    //                 crossAxis: CrossAxis.start,
    //                 spacing: 4,
    //                 children: [
    //                   Row(
    //                     spacing: 8,
    //                     children: [
    //                       Text(
    //                         CustomFunction(reviewItemRatingLabelFn, args: {'item': item}),
    //                         style: Styles.labelMedium,
    //                       ),
    //                       Text(
    //                         CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
    //                         style: Styles.labelSmall,
    //                       ),
    //                     ],
    //                   ),
    //                   Text(
    //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 1}),
    //                     maxLines: 3,
    //                     overflow: TextOverflow.ellipsis,
    //                   ),
    //                 ],
    //               ),
    //             ),
    //           ),
    //         ),
    //         Divider(),
    //         Text('このユーザーを通報・ブロックする', style: Styles.titleSmall),
    //         TextField(
    //           name: 'ReportReasonField',
    //           hint: '通報理由を入力してください',
    //           onChanged: SetState('reportReason', const TextValue()),
    //         ),
    //         Row(
    //           spacing: 12,
    //           children: [
    //             Button(
    //               '通報する',
    //               variant: ButtonVariant.outlined,
    //               onTap: [
    //                 If(
    //                   Not(Equals(State('reportReason'), '')),
    //                   then: [
    //                     CallCustomAction.named(
    //                       'callReportUser',
    //                       arguments: {'reportedId': PageParam('castId'), 'reason': State('reportReason')},
    //                       outputAs: 'reportResult',
    //                     ),
    //                     If(
    //                       ActionOutput('reportResult'),
    //                       then: [
    //                         SetState('reportReason', ''),
    //                         Snackbar('通報を受け付けました。'),
    //                       ],
    //                       orElse: [Snackbar('通報に失敗しました。')],
    //                     ),
    //                   ],
    //                   orElse: [Snackbar('通報理由を入力してください。')],
    //                 ),
    //               ],
    //             ),
    //             Button(
    //               'ブロックする',
    //               variant: ButtonVariant.outlined,
    //               onTap: [
    //                 CallCustomAction.named(
    //                   'callBlockUser',
    //                   arguments: {'targetUid': PageParam('castId')},
    //                   outputAs: 'blockResult',
    //                 ),
    //                 If(
    //                   ActionOutput('blockResult'),
    //                   then: [Snackbar('ブロックしました。'), NavigateBack()],
    //                   orElse: [Snackbar('ブロックに失敗しました。')],
    //                 ),
    //               ],
    //             ),
    //           ],
    //         ),
    //       ],
    //     ),
    //   ),
    // );
  });

  // ── ReservationDetail: tip (§3.6.15/§3.7.10). ──
  //
  // No change to ON_INIT_STATE needed — `resVisibilityData` (already
  // fetched by the existing chain, per project_rules.md's hard rule against
  // wiring the same root+trigger twice) already carries everything the
  // visibility check needs (status + isGuest); `resId`/`castId` are already
  // page params. Visible whenever the interaction has already happened for
  // the guest specifically (review_pending — capture done, not yet reviewed
  // — or completed — already reviewed) rather than only matching
  // `canSubmitReservationReview`'s narrower review_pending-only window,
  // since a tip is a reasonable thing to send even after already reviewing.
  final canSendTipFn = app.customFunction(
    'canSendTip',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約でチップを送れるか判定する（ゲストかつreview_pendingまたはcompleted状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isGuest = parts[1] == 'true';
return isGuest && (status == 'review_pending' || status == 'completed');
''',
  );

  app.customAction(
    'callProcessTip',
    args: {'resId': string, 'castId': string, 'amountYen': string},
    returns: bool_,
    description: 'processTip Cloud Functionを呼び出し、キャストにチップを送る。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callProcessTip(String? resId, String? castId, String? amountYen) async {
  try {
    final cid = castId ?? '';
    final amount = int.tryParse(amountYen ?? '') ?? 0;
    if (cid.isEmpty || amount <= 0) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('processTip');
    final result = await callable.call({
      'res_id': resId ?? '',
      'cast_id': cid,
      'amount': amount,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.editPageState(ff.Pages.reservationDetail, (state) {
    state.ensureField('tipAmount', string.withDefault(''));
  });

  // FROZEN (2026-08-12, comprehensive review pass): confirmed landed —
  // `TipSection` exists in lib/flutterflow_project/pages/reservation_detail.dart.
  // `ensureInsertedAfter` is one-shot; the anchor key `Row_5d46emlt` still
  // exists, so a rerun would silently no-op, but any future EDIT to this
  // section's content would be silently ignored the same way. Any future
  // change must go through `app.editPage(ff.Pages.reservationDetail, ...)`
  // targeting its real widget keys instead.
  // app.editPage(ff.Pages.reservationDetail, (page) {
  //   // `Row_5d46emlt` (SubmitReviewRow) and `Row_5xrhh8tz` (CancelReservationRow)
  //   // are siblings in the same parent Column — inserting after the former
  //   // places the tip section between the review action and the cancel
  //   // action, additive, no disruption to either.
  //   page.ensureInsertedAfter(
  //     page.findByKey('Row_5d46emlt'),
  //     Container(
  //       name: 'TipSection',
  //       padding: 16,
  //       visible: CustomFunction(canSendTipFn, args: {'data': State('resVisibilityData')}),
  //       child: Column(
  //         crossAxis: CrossAxis.start,
  //         spacing: 8,
  //         children: [
  //           Text('チップを送る', style: Styles.titleSmall),
  //           TextField(
  //             name: 'TipAmountField',
  //             hint: '金額（円）例: 1000',
  //             keyboard: Keyboard.number,
  //             onChanged: SetState('tipAmount', const TextValue()),
  //           ),
  //           Button(
  //             '送る',
  //             onTap: [
  //               If(
  //                 Not(Equals(State('tipAmount'), '')),
  //                 then: [
  //                   CallCustomAction.named(
  //                     'callProcessTip',
  //                     arguments: {
  //                       'resId': PageParam('resId'),
  //                       'castId': PageParam('castId'),
  //                       'amountYen': State('tipAmount'),
  //                     },
  //                     outputAs: 'tipResult',
  //                   ),
  //                   If(
  //                     ActionOutput('tipResult'),
  //                     then: [
  //                       SetState('tipAmount', ''),
  //                       Snackbar('チップを送りました。'),
  //                     ],
  //                     orElse: [Snackbar('チップの送信に失敗しました。')],
  //                   ),
  //                 ],
  //                 orElse: [Snackbar('金額を入力してください。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  // });

  // ── AdminReportReviewPage: minimal Phase-12 slice pulled forward for
  // testability (§3.6.17/§3.7.14/§3.8.16's report-review-with-chat-log-
  // quoting requirement), same precedent as Phase 2's KycReviewPage — list
  // pending reports, view the underlying chat log via
  // `adminGetReportChatLog` (existed in source but was missing from live
  // deployment until this phase's own backend-gap fix above), resolve.
  // Deliberately NOT combined with a "resolve + freeze" checkbox — that's
  // the sister-project-proven pattern §3.8a documents for Phase 12 proper,
  // and `adminResolveReport` itself doesn't currently implement a freeze
  // side-effect (confirmed by reading it — its own `action` param is
  // accepted but only ever passed through to the audit log, never used to
  // actually freeze anyone) — building that combined action now would mean
  // extending admin.ts speculatively ahead of the real Phase 12 admin-panel
  // design, not fixing something broken today. ──

  app.customAction(
    'fetchPendingReports',
    returns: listOf(string),
    description: 'adminGetReports Cloud Functionを呼び出し、未解決（pending）の通報一覧を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchPendingReports() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminGetReports');
    final result = await callable.call({'status': 'pending'});
    if (result.data is! Map || result.data['reports'] is! List) return <String>[];
    final reports = result.data['reports'] as List;
    return reports.map((raw) {
      final m = raw as Map;
      final id = m['id']?.toString() ?? '';
      final reportedId = m['reported_id']?.toString() ?? '';
      final reason = (m['reason']?.toString() ?? '').replaceAll('|||', '');
      final resId = m['res_id']?.toString() ?? '';
      var dateLabel = '';
      final ts = m['created_at'];
      if (ts is Map && ts['_seconds'] != null) {
        final dt = DateTime.fromMillisecondsSinceEpoch((ts['_seconds'] as int) * 1000);
        dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
      }
      return '$id|||$reportedId|||$reason|||$resId|||$dateLabel';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'fetchReportChatLog',
    args: {'reportId': string},
    returns: listOf(string),
    description: 'adminGetReportChatLog Cloud Functionを呼び出し、通報に関連するチャットログを取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchReportChatLog(String? reportId) async {
  try {
    final rid = reportId ?? '';
    if (rid.isEmpty) return <String>[];
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminGetReportChatLog');
    final result = await callable.call({'report_id': rid});
    if (result.data is! Map) return <String>[];
    final data = result.data as Map;
    if (data['messages'] is! List || (data['messages'] as List).isEmpty) {
      final reason = data['no_chat_reason']?.toString() ?? 'チャットログがありません。';
      return <String>['|||$reason|||'];
    }
    final messages = data['messages'] as List;
    return messages.map((raw) {
      final m = raw as Map;
      final nickname = (m['sender_nickname']?.toString() ?? '').replaceAll('|||', '');
      final text = (m['text']?.toString() ?? '').replaceAll('|||', '');
      return '$nickname|||$text|||';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callResolveReport',
    args: {'reportId': string, 'adminNote': string},
    returns: bool_,
    description: 'adminResolveReport Cloud Functionを呼び出し、通報を解決済みにする。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callResolveReport(String? reportId, String? adminNote) async {
  try {
    final rid = reportId ?? '';
    if (rid.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminResolveReport');
    final result = await callable.call({
      'report_id': rid,
      'admin_note': adminNote ?? '',
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // FROZEN (2026-08-11, review pass): AdminReportReviewPage now exists
  // (created by this exact `ensurePage` call on the first Phase 7 push) —
  // re-validated-but-inert on every subsequent compile, the same
  // `ensurePage`-body-inert failure this file's own KycReviewPage/
  // ReservationListPage/BasicInfoRegistration/NotificationsPage comments
  // already document at length. Any FUTURE change to this page's own
  // content must go through app.editPage(ff.Pages.adminReportReviewPage,
  // ...) instead (see the fix right below, needed immediately to correct
  // the two lists' shrinkWrap-without-Expanded overflow risk found on
  // this same review pass).
  //   app.ensurePage(
  //     'AdminReportReviewPage',
  //     route: '/admin-report-review',
  //     description: '管理者向け通報レビューページ（未解決の通報一覧、関連チャットログの確認、解決処理）。',
  //     state: {
  //       'isAdminUser': bool_.withDefault(false),
  //       'pendingReportsList': listOf(string),
  //       'selectedReportId': string.withDefault(''),
  //       'selectedReportChatLog': listOf(string),
  //       'adminNote': string.withDefault(''),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('checkIsAdminUser', outputAs: 'isAdminResult'),
  //       SetState('isAdminUser', ActionOutput('isAdminResult')),
  //       CallCustomAction.named('fetchPendingReports', outputAs: 'reportsResult'),
  //       SetState('pendingReportsList', ActionOutput('reportsResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: '通報レビュー'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 12,
  //         children: [
  //           Text(
  //             '管理者権限がありません。',
  //             style: Styles.bodyMedium,
  //             visible: Equals(State('isAdminUser'), false),
  //           ),
  //           ListView(
  //             name: 'PendingReportsListView',
  //             shrinkWrap: true,
  //             spacing: 8,
  //             visible: State('isAdminUser'),
  //             source: State('pendingReportsList'),
  //             itemBuilder: (item) => Card(
  //               name: 'ReportCard',
  //               child: Container(
  //                 padding: 12,
  //                 child: Column(
  //                   crossAxis: CrossAxis.start,
  //                   spacing: 4,
  //                   children: [
  //                     Text(
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                       style: Styles.titleSmall,
  //                     ),
  //                     Text(
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 4}),
  //                       style: Styles.labelSmall,
  //                     ),
  //                     Button(
  //                       '詳細を見る',
  //                       variant: ButtonVariant.outlined,
  //                       onTap: [
  //                         SetState(
  //                           'selectedReportId',
  //                           CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                         ),
  //                         CallCustomAction.named(
  //                           'fetchReportChatLog',
  //                           arguments: {
  //                             'reportId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                           },
  //                           outputAs: 'chatLogResult',
  //                         ),
  //                         SetState('selectedReportChatLog', ActionOutput('chatLogResult')),
  //                       ],
  //                     ),
  //                   ],
  //                 ),
  //               ),
  //             ),
  //           ),
  //           Divider(visible: Not(Equals(State('selectedReportId'), ''))),
  //           Text(
  //             'チャットログ',
  //             style: Styles.titleSmall,
  //             visible: Not(Equals(State('selectedReportId'), '')),
  //           ),
  //           ListView(
  //             name: 'SelectedReportChatLogListView',
  //             shrinkWrap: true,
  //             spacing: 6,
  //             visible: Not(Equals(State('selectedReportId'), '')),
  //             source: State('selectedReportChatLog'),
  //             itemBuilder: (item) => Row(
  //               spacing: 8,
  //               children: [
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                   style: Styles.labelSmall,
  //                 ),
  //                 Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //               ],
  //             ),
  //           ),
  //           TextField(
  //             name: 'AdminNoteField',
  //             hint: '管理者メモ（任意）',
  //             visible: Not(Equals(State('selectedReportId'), '')),
  //             onChanged: SetState('adminNote', const TextValue()),
  //           ),
  //           Button(
  //             '解決する',
  //             visible: Not(Equals(State('selectedReportId'), '')),
  //             onTap: [
  //               CallCustomAction.named(
  //                 'callResolveReport',
  //                 arguments: {'reportId': State('selectedReportId'), 'adminNote': State('adminNote')},
  //                 outputAs: 'resolveResult',
  //               ),
  //               If(
  //                 ActionOutput('resolveResult'),
  //                 then: [
  //                   Snackbar('通報を解決しました。'),
  //                   SetState('selectedReportId', ''),
  //                   SetState('adminNote', ''),
  //                   CallCustomAction.named('fetchPendingReports', outputAs: 'reportsRefetchResult'),
  //                   SetState('pendingReportsList', ActionOutput('reportsRefetchResult')),
  //                 ],
  //                 orElse: [Snackbar('解決処理に失敗しました。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // Review-pass fix (2026-08-11): same R19-class shrinkWrap-without-Expanded
  // overflow risk as Phase 6's `ChatMessagesListView`/`NotificationsListView`
  // — both `PendingReportsListView` and `SelectedReportChatLogListView` sit
  // as siblings in a plain, non-scrolling Column (report list, divider,
  // chat-log list, note field, resolve button, all direct children of the
  // Scaffold body) rather than nested inside another scrollable, so the
  // `shrinkWrap: true` default the `ensurePage` body above landed with
  // risks a real overflow once either list has enough items. Fixed by
  // wrapping both in `Expanded` (each gets an equal share of the bounded
  // Scaffold-body height) and reverting to the default `shrinkWrap: false`.
  // Targets the live keys (`ListView_l34gmmuj`/`ListView_wm38oxxo`,
  // confirmed via the regenerated typed SDK) and uses
  // `ff.Pages.adminReportReviewPage.state.*` typed handles throughout —
  // bare `State('x')`/`SetState('x', ...)` sugar only works while the page
  // is still being freshly declared in the same script, per this file's
  // own already-documented `ensurePage`-body-inert lesson.
  //
  // Frozen (comprehensive review pass, 2026-08-12): both confirmed landed
  // via generated_code — `ensureReplaced` has no dedup guard, so leaving
  // either live risked reassigning fresh keys to their whole subtrees on
  // every future unrelated push. Commented out per the established freeze
  // discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md).
  // app.editPage(ff.Pages.adminReportReviewPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_l34gmmuj'),
  //     Expanded(
  //       ListView(
  //         name: 'PendingReportsListView',
  //         spacing: 8,
  //         source: State(ff.Pages.adminReportReviewPage.state.pendingReportsList),
  //         itemBuilder: (item) => Card(
  //           name: 'ReportCard',
  //           child: Container(
  //             padding: 12,
  //             child: Column(
  //               crossAxis: CrossAxis.start,
  //               spacing: 4,
  //               children: [
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                   style: Styles.titleSmall,
  //                 ),
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 4}),
  //                   style: Styles.labelSmall,
  //                 ),
  //                 Button(
  //                   '詳細を見る',
  //                   variant: ButtonVariant.outlined,
  //                   onTap: [
  //                     SetState(
  //                       ff.Pages.adminReportReviewPage.state.selectedReportId,
  //                       CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                     ),
  //                     CallCustomAction.named(
  //                       'fetchReportChatLog',
  //                       arguments: {
  //                         'reportId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                       },
  //                       outputAs: 'chatLogResult',
  //                     ),
  //                     SetState(
  //                       ff.Pages.adminReportReviewPage.state.selectedReportChatLog,
  //                       ActionOutput('chatLogResult'),
  //                     ),
  //                   ],
  //                 ),
  //               ],
  //             ),
  //           ),
  //         ),
  //       ),
  //       name: 'PendingReportsExpanded',
  //     ),
  //   );
  //
  //   page.ensureReplaced(
  //     page.findByKey('ListView_wm38oxxo'),
  //     Expanded(
  //       ListView(
  //         name: 'SelectedReportChatLogListView',
  //         spacing: 6,
  //         source: State(ff.Pages.adminReportReviewPage.state.selectedReportChatLog),
  //         itemBuilder: (item) => Row(
  //           spacing: 8,
  //           children: [
  //             Text(
  //               CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //               style: Styles.labelSmall,
  //             ),
  //             Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //           ],
  //         ),
  //       ),
  //       name: 'SelectedReportChatLogExpanded',
  //     ),
  //   );
  // });

  // ==========================================================================
  // Phase 8 — Wallet & payout (§3.7.9-11, §3.9.15).
  //
  // Backend audit first, same discipline as every phase this session:
  // `requestPayout` (withdrawal-request → admin-approval → payout, gated on
  // logical_debt==0 AND Stripe available balance>0) and `requestWithdrawal`
  // (account-deletion, gated on logical_debt==0, no active reservations, no
  // pending ledger entries) both already existed as complete, correct Cloud
  // Functions — confirmed by reading them in full, not assumed. Only
  // `getWalletBalance` (a live, uncached Stripe balance query — §3.7.9's own
  // "must reflect Stripe truth, not a locally cached copy" requirement) was
  // genuinely missing and was added this phase.
  //
  // CRITICAL finding before writing any DSL: this session's own §35 entry
  // had already disclosed — and deliberately left unfixed, as "revisit the
  // moment it gets a caller" — that `requestWithdrawal`'s two reservation
  // queries (`guest_id`/`cast_ids` + `status not-in`) have no matching
  // composite index. Phase 8's own checklist item ("account-deletion block
  // conditions surfaced in SettingsPage") is EXACTLY the caller that
  // disclosure warned about. Verified the gap was real (not just
  // theoretical) by querying the live Firestore REST API directly with
  // `gcloud auth print-access-token` + `curl .../documents:runQuery`
  // (§37's own newly-documented technique) — both queries failed with
  // `FAILED_PRECONDITION` exactly as expected. Fixed by adding both
  // composite indexes (`reservations`: `guest_id`+`status`,
  // `cast_ids`(CONTAINS)+`status`) and re-ran the SAME direct queries after
  // the index finished building to CONFIRM success, not just that the
  // index was registered — this is the first time this session verified a
  // fix through the full loop (missing → confirmed broken → fixed →
  // confirmed working) using nothing but direct Firestore REST calls, no
  // device, no Cloud Function logs.
  //
  // A second, same-class gap found the same way before writing the wallet
  // history query: `ledger` had no `user_id`+`created_at` index either
  // (would have broken `WalletPage`'s own transaction history the exact
  // same way `reviews` broke in Phase 7, §37's own addendum) — fixed
  // pre-emptively, before ever wiring the query, rather than discovering it
  // after shipping.
  //
  // `ledger.type` label mapping is built from the CONFIRMED-real value set
  // (grepped every `.collection("ledger")` write site across the whole
  // backend: `reward`, `staff_fee`, `tip`, `refund`, `affiliate` — a 6th
  // value, `debt_offset`, appears only in comments describing a planned
  // category, never actually written anywhere, so no label was invented
  // for it; the mapping falls back to the raw string for anything
  // unmapped rather than showing blank, so a future real `debt_offset`
  // write wouldn't silently disappear from the UI, just show untranslated
  // until this function is updated).
  // ==========================================================================

  final ledgerTypeLabelFn = app.customFunction(
    'ledgerTypeLabel',
    args: {'type': string},
    returns: string,
    description: '台帳（ledger）エントリのtype値を日本語表示ラベルに変換する。',
    code: r'''
switch (type) {
  case 'reward':
    return '報酬';
  case 'staff_fee':
    return 'スタッフ料';
  case 'tip':
    return 'チップ';
  case 'refund':
    return '返金';
  case 'affiliate':
    return 'アフィリエイト報酬';
  default:
    return type ?? '';
}
''',
  );

  // WARNING (found during the "review everything" audit pass): unlike
  // `fetchWalletLedgerHistory`/`fetchMyWorkSettings` above, this
  // declaration CANNOT be commented out the same way even though a LATER
  // `updateCustomFunction(name: 'formatYen', ...)` call also exists for
  // this name (WalletPage section, below) - `formatYenFn` (the Dart
  // variable this call returns) is referenced directly as a widget
  // expression elsewhere in this file (`CustomFunction(formatYenFn,
  // args: {...})`), so removing this declaration would break Dart
  // compilation, not just the FlutterFlow-side registration. Content is
  // currently byte-identical between this declaration and the
  // `updateCustomFunction` call below (not currently broken) - but this is
  // the exact "live declaration + later update, same name" shape that
  // already threw `ensureCustomAction found an existing custom action...
  // with a different payload` for `callCreateExtensionPayment` earlier
  // this session, even with seemingly-identical content. If `formatYen`'s
  // behavior is ever changed, BOTH this declaration's `code:` AND the
  // `updateCustomFunction` call's `code:` below must be edited together,
  // in the SAME push, kept byte-for-byte identical - do not edit one
  // without the other.
  final formatYenFn = app.customFunction(
    'formatYen',
    args: {'amount': string},
    returns: string,
    description: '金額文字列を「¥12,000」形式（3桁カンマ区切り）に整形する。',
    code: r'''
final n = int.tryParse(amount ?? '') ?? 0;
final isNegative = n < 0;
final s = n.abs().toString();
final buf = StringBuffer();
for (int i = 0; i < s.length; i++) {
  if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
  buf.write(s[i]);
}
return '${isNegative ? '-' : ''}¥$buf';
''',
  );

  app.customFunction(
    'canWithdrawNow',
    args: {'logicalDebt': string, 'available': string},
    returns: bool_,
    description: '出金申請が可能か判定する（論理負債が0円以下かつ出金可能残高がある、§3.7.11）。',
    code: r'''
final debt = int.tryParse(logicalDebt ?? '') ?? 0;
final avail = int.tryParse(available ?? '') ?? 0;
return debt <= 0 && avail > 0;
''',
  );

  app.customAction(
    'fetchWalletBalance',
    returns: string,
    description: 'getWalletBalance Cloud Functionを呼び出し、自分のウォレット残高（利用可能・保留中）をStripeから直接取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> fetchWalletBalance() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getWalletBalance');
    final result = await callable.call({});
    if (result.data is! Map) return '0|||0|||false';
    final data = result.data as Map;
    final available = data['available']?.toString() ?? '0';
    final pending = data['pending']?.toString() ?? '0';
    final hasAccount = data['has_stripe_account'] == true;
    return '$available|||$pending|||$hasAccount';
  } catch (e) {
    return '0|||0|||false';
  }
}
''',
  );

  // `fetchWalletLedgerHistory` — FIX (found during the "review everything"
  // audit pass): this used to be a LIVE `app.customAction(...)` declaration
  // co-existing with a LATER `updateCustomAction` call for the same name
  // (WalletPage's own section, below) — the exact anti-pattern this file's
  // own comments already confirmed throws a false "different payload"
  // mismatch (`callCreateExtensionPayment`, twice, earlier this session),
  // even when content looks byte-identical. Content here happened to still
  // match at audit time (not currently broken), but per the established,
  // now-proven-safe pattern used everywhere else in this file for a
  // post-`updateCustomAction` target (`checkReservationFieldsComplete`,
  // `fetchMyReservations`, `reservationListItemLabel`, etc.), commented
  // out rather than left live and "kept in sync" by hand. The
  // `updateCustomAction(name: 'fetchWalletLedgerHistory', ...)` call
  // (WalletPage section) is now the only source of truth for this action.
  //   app.customAction(
  //     'fetchWalletLedgerHistory',
  //     returns: listOf(string),
  //     description: '自分の台帳（ledger）履歴を取得する。',
  //     code: r'''...(see updateCustomAction call below for real code)...''',
  //   );

  app.customAction(
    'fetchMyLogicalDebt',
    returns: string,
    description: '自分の論理負債額（logical_debt）を取得する。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String> fetchMyLogicalDebt() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return '0';
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final debt = doc.data()?['logical_debt'];
    return (debt ?? 0).toString();
  } catch (e) {
    return '0';
  }
}
''',
  );

  app.customAction(
    'callRequestPayout',
    returns: string,
    description: 'requestPayout Cloud Functionを呼び出し、出金申請を送信する。成功時は"success"、失敗時は具体的な理由メッセージを返す。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> callRequestPayout() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('requestPayout');
    final result = await callable.call({});
    if (result.data is Map && result.data['success'] == true) {
      return 'success';
    }
    return '出金申請に失敗しました。';
  } on FirebaseFunctionsException catch (e) {
    return e.message ?? '出金申請に失敗しました。';
  } catch (e) {
    return '出金申請に失敗しました。';
  }
}
''',
  );

  app.customAction(
    'callRequestWithdrawal',
    returns: string,
    description: 'requestWithdrawal Cloud Functionを呼び出し、退会処理を実行する。成功時は"success"、失敗時は具体的な理由メッセージを返す（負債/進行中の予約/送金処理中など）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> callRequestWithdrawal() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('requestWithdrawal');
    final result = await callable.call({});
    if (result.data is Map && result.data['success'] == true) {
      return 'success';
    }
    return '退会処理に失敗しました。';
  } on FirebaseFunctionsException catch (e) {
    return e.message ?? '退会処理に失敗しました。';
  } catch (e) {
    return '退会処理に失敗しました。';
  }
}
''',
  );

  // FROZEN (2026-08-11, proactively, before the next push): both
  // WalletPage and SettingsPage now exist (created by these exact
  // `ensurePage` calls on the Phase 8 push) — re-validated-but-inert on
  // every subsequent compile, the same `ensurePage`-body-inert failure
  // this file's own KycReviewPage/ReservationListPage/BasicInfoRegistration/
  // NotificationsPage/AdminReportReviewPage comments already document at
  // length. Frozen HERE, proactively, before the my_page.dart drawer-
  // wiring edit right below needed a `Navigate(ff.Pages.walletPage)`/
  // `Navigate(ff.Pages.settingsPage)` reference to these now-existing
  // pages — rather than pushing once, hitting the now-familiar
  // `Use ff.Pages.walletPage.state.x instead of State(...)` failure a
  // fourth time, and fixing it after the fact. Any FUTURE change to
  // either page's own content must go through
  // app.editPage(ff.Pages.walletPage / settingsPage, ...) instead.
  //   app.ensurePage(
  //     'WalletPage',
  //     route: '/wallet',
  //     description: 'ウォレットページ（Stripe残高のリアルタイム表示、出金申請、台帳履歴）。',
  //     state: {
  //       'walletAvailableStr': string.withDefault('0'),
  //       'walletPendingStr': string.withDefault('0'),
  //       'logicalDebtStr': string.withDefault('0'),
  //       'ledgerHistoryList': listOf(string),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('fetchWalletBalance', outputAs: 'balanceResult'),
  //       SetState(
  //         'walletAvailableStr',
  //         CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceResult'), 'index': 0}),
  //       ),
  //       SetState(
  //         'walletPendingStr',
  //         CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceResult'), 'index': 1}),
  //       ),
  //       CallCustomAction.named('fetchMyLogicalDebt', outputAs: 'debtResult'),
  //       SetState('logicalDebtStr', ActionOutput('debtResult')),
  //       CallCustomAction.named('fetchWalletLedgerHistory', outputAs: 'historyResult'),
  //       SetState('ledgerHistoryList', ActionOutput('historyResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'ウォレット'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 12,
  //         children: [
  //           Text('利用可能残高', style: Styles.labelMedium),
  //           Text(
  //             CustomFunction(formatYenFn, args: {'amount': State('walletAvailableStr')}),
  //             style: Styles.headlineSmall,
  //           ),
  //           Text('保留中', style: Styles.labelMedium),
  //           Text(
  //             CustomFunction(formatYenFn, args: {'amount': State('walletPendingStr')}),
  //             style: Styles.bodyMedium,
  //           ),
  //           Button(
  //             '出金申請する',
  //             visible: CustomFunction(
  //               canWithdrawNowFn,
  //               args: {'logicalDebt': State('logicalDebtStr'), 'available': State('walletAvailableStr')},
  //             ),
  //             onTap: [
  //               CallCustomAction.named('callRequestPayout', outputAs: 'payoutResult'),
  //               If(
  //                 Equals(ActionOutput('payoutResult'), 'success'),
  //                 then: [
  //                   Snackbar('出金申請を受け付けました。運営の承認をお待ちください。'),
  //                   CallCustomAction.named('fetchWalletBalance', outputAs: 'balanceRefetch'),
  //                   SetState(
  //                     'walletAvailableStr',
  //                     CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceRefetch'), 'index': 0}),
  //                   ),
  //                   SetState(
  //                     'walletPendingStr',
  //                     CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceRefetch'), 'index': 1}),
  //                   ),
  //                 ],
  //                 orElse: [Snackbar(ActionOutput('payoutResult'))],
  //               ),
  //             ],
  //           ),
  //           Text(
  //             '論理負債があるか、出金可能な残高がないため、現在出金申請できません。',
  //             style: Styles.labelSmall,
  //             visible: Not(
  //               CustomFunction(
  //                 canWithdrawNowFn,
  //                 args: {'logicalDebt': State('logicalDebtStr'), 'available': State('walletAvailableStr')},
  //               ),
  //             ),
  //           ),
  //           Divider(),
  //           Text('取引履歴', style: Styles.titleSmall),
  //           Expanded(
  //             ListView(
  //               name: 'WalletHistoryListView',
  //               spacing: 6,
  //               source: State('ledgerHistoryList'),
  //               itemBuilder: (item) => Row(
  //                 mainAxis: MainAxis.spaceBetween,
  //                 children: [
  //                   Text(CustomFunction(ledgerTypeLabelFn, args: {'type': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})})),
  //                   Text(CustomFunction(formatYenFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})})),
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                     style: Styles.labelSmall,
  //                   ),
  //                 ],
  //               ),
  //             ),
  //             name: 'WalletHistoryExpanded',
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
    //
  //   // ── SettingsPage: minimal slice for Phase 8's own account-deletion
  //   // requirement (§3.9.15) — NOT a full settings page (notifications, legal
  //   // docs, FAQ, etc. stay Phase 11 scope per that phase's own My-Page-IA
  //   // checklist, which explicitly owns "account deletion" too; built here
  //   // only because Phase 8's own checklist separately calls for the block
  //   // conditions to be "surfaced in SettingsPage/account-management UI" and
  //   // no such page exists yet at all). ──
  //   app.ensurePage(
  //     'SettingsPage',
  //     route: '/settings',
  //     description: 'アカウント設定ページ（現時点では退会処理のみ — 通知設定・規約閲覧等はPhase 11で追加予定）。',
  //     state: {},
  //     body: Scaffold(
  //       appBar: AppBar(title: '設定'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         children: [
  //           Text('アカウントを削除する', style: Styles.titleMedium),
  //           Text(
  //             '論理負債がある場合、進行中の予約がある場合、または送金処理中の台帳がある場合は退会できません。',
  //             style: Styles.labelSmall,
  //           ),
  //           Button(
  //             '退会する',
  //             variant: ButtonVariant.outlined,
  //             onTap: [
  //               CallCustomAction.named('callRequestWithdrawal', outputAs: 'withdrawalResult'),
  //               If(
  //                 Equals(ActionOutput('withdrawalResult'), 'success'),
  //                 then: [Snackbar('退会処理が完了しました。'), Navigate(ff.Pages.loginPage, replaceRoute: true)],
  //                 orElse: [Snackbar(ActionOutput('withdrawalResult'))],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // Wire the two most relevant `MyPage` drawer category rows to the new
  // pages — both are flat, static category labels (Icon + Text, no
  // sub-menu structure of any kind) with no ON_TAP trigger ever wired,
  // same "static UI, never connected" pattern already fixed for the
  // notification bell icons in Phase 6. "報酬・売上・決済管理"
  // (reward/sales/payment management) is the closest existing category to
  // WalletPage's own scope; "アカウント・基本管理" (account/basic
  // management) is the closest to SettingsPage's. `MyPage` is confirmed
  // cast-only (its own 3-tab Profile/Gallery/Work-calendar structure, and
  // §3.7.9's own wording — a guest has no Stripe Connect account to mirror
  // a balance from), so no additional guest/cast gate is needed on top of
  // what already implicitly scopes this whole page.
  // ==========================================================================
  // Phase 11 slice 1 — new `SystemInfo` page for MyPage drawer row 7
  // (システム・情報): a real, discoverable version-info + logout screen.
  // Logout already technically works today (a stock FlutterFlow AppBar-logo
  // ON_TAP present on ~16 pages project-wide, not built by any session
  // phase), but it's an undocumented gesture, not a labeled UI element —
  // left as-is (harmless, out of scope to remove) while this page adds the
  // real, discoverable path Phase 11 calls for.
  // ==========================================================================

  app.pubDependency('package_info_plus', '^10.2.1');

  app.customAction(
    'fetchAppVersionLabel',
    args: {},
    returns: string,
    description: 'アプリのバージョン番号・ビルド番号を取得し、表示用ラベル（例: v1.0.0 (3)）を返す。',
    code: r'''
import 'package:package_info_plus/package_info_plus.dart';

Future<String> fetchAppVersionLabel() async {
  try {
    final info = await PackageInfo.fromPlatform();
    return 'v${info.version} (${info.buildNumber})';
  } catch (e) {
    return '';
  }
}
''',
  );

  // FROZEN (2026-08-12, review pass, immediately after this exact push
  // landed): `SystemInfo` now exists — confirmed via
  // generated_code/lib/system_info/ and lib/flutterflow_project/pages/
  // system_info.dart. `app.ensurePage` is genuinely idempotent (no-ops if
  // the page already exists) so leaving this live would not error on a
  // future push, but it WOULD silently no-op the whole declaration
  // including body/state/onLoad — the same "safe but a silent-edit trap"
  // rationale already documented for every other `ensurePage`'d page in
  // this file (MyWorkContent, SettingsPage, etc.). Any future change to
  // this page must go through `app.editPage(ff.Pages.systemInfo, ...)`
  // instead. The drawer-wiring block below now references
  // `ff.Pages.systemInfo` (the real typed handle, regenerated after this
  // push) instead of the locally-captured `systemInfoPage` variable this
  // block originally returned — that capture was only needed to reference
  // the page within the SAME run it was created in.
  //   final systemInfoPage = app.ensurePage(
  //     'SystemInfo',
  //     route: '/system-info',
  //     description: 'システム・情報ページ（バージョン情報、ログアウト）。',
  //     state: {'versionLabel': string.withDefault('')},
  //     onLoad: [
  //       CallCustomAction.named('fetchAppVersionLabel', outputAs: 'versionResult'),
  //       SetState('versionLabel', ActionOutput('versionResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'システム・情報'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         children: [
  //           Text('バージョン情報', style: Styles.titleMedium),
  //           Text(State('versionLabel'), style: Styles.labelSmall),
  //           Button(
  //             'ログアウト',
  //             variant: ButtonVariant.outlined,
  //             onTap: const [Logout()],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // `isListEmpty` stays a live declaration — used by the (now frozen)
  // BlockList page below, and `ensureCustomFunction` is safe to leave
  // active indefinitely, unlike `ensurePage`.
  final isListEmptyFn = app.customFunction(
    'isListEmpty',
    args: {'items': listOf(string)},
    returns: bool_,
    description: '文字列リストが空かどうかを判定する（空状態メッセージの表示切り替え用）。',
    code: r'''
return (items ?? const <String>[]).isEmpty;
''',
  );

  // FROZEN (2026-08-12, same-turn review step, immediately after this exact
  // push landed): `BlockList` now exists — confirmed via
  // generated_code/lib/block_list/ and
  // lib/flutterflow_project/pages/block_list.dart. Same rationale as
  // `SystemInfo` in slice 1 — `ensurePage` is idempotent (won't error if
  // left live) but would silently no-op any future edit to this page's
  // body/state/onLoad. Any future change to this page must go through
  // `app.editPage(ff.Pages.blockList, ...)` instead. The drawer-wiring
  // block below now references `ff.Pages.blockList` (the real typed
  // handle, regenerated after this push) instead of the locally-captured
  // `blockListPage` variable, which was only needed within the run that
  // created it.
  //   final blockListPage = app.ensurePage(
  //     'BlockList',
  //     route: '/block-list',
  //     description: 'ブロックリスト画面（ブロック中のユーザー一覧、解除）。',
  //     state: {'blockedUsersList': listOf(string)},
  //     onLoad: [
  //       CallCustomAction.named('fetchBlockedUsers', outputAs: 'blockedUsersResult'),
  //       SetState('blockedUsersList', ActionOutput('blockedUsersResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'ブロックリスト'),
  //       body: Column(
  //         padding: 16,
  //         children: [
  //           Text(
  //             'ブロックしているユーザーはいません。',
  //             style: Styles.bodyMedium,
  //             visible: CustomFunction(isListEmptyFn, args: {'items': State('blockedUsersList')}),
  //           ),
  //           Expanded(
  //             ListView(
  //               name: 'BlockedUsersListView',
  //               spacing: 8,
  //               source: State('blockedUsersList'),
  //               itemBuilder: (item) => Card(
  //                 child: Container(
  //                   padding: 12,
  //                   child: Row(
  //                     mainAxis: MainAxis.spaceBetween,
  //                     children: [
  //                       Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //                       Button(
  //                         'ブロック解除',
  //                         variant: ButtonVariant.outlined,
  //                         onTap: [
  //                           CallCustomAction.named(
  //                             'callUnblockUser',
  //                             arguments: {'targetUid': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})},
  //                             outputAs: 'unblockResult',
  //                           ),
  //                           CallCustomAction.named('fetchBlockedUsers', outputAs: 'refetchResult'),
  //                           SetState('blockedUsersList', ActionOutput('refetchResult')),
  //                         ],
  //                       ),
  //                     ],
  //                   ),
  //                 ),
  //               ),
  //             ),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // Comprehensive review pass (2026-08-12), 2 fixes to the BlockedUsersListView
  // itemBuilder, found by an independent fresh-eyes review of this slice's
  // own work:
  // 1. The unblock button captured `callUnblockUser`'s result but never
  //    branched on it — no feedback either way, unlike the sibling
  //    `callBlockUser`/`callReportUser` wiring on CastProfile, which
  //    correctly shows a success/failure Snackbar. A failed unblock (e.g.
  //    a dropped network call) left the button looking completely inert.
  // 2. The nickname Text had no `maxLines`/`overflow`, unlike every other
  //    dynamic list-item Text in this file (reviews, notifications, chat
  //    previews) — a long/emoji-heavy nickname would overflow the Row.
  //    Wrapped in `Expanded` too — `maxLines`/`overflow` alone don't take
  //    effect on a Text inside a `Row` unless the Text has a bounded width
  //    to compare against.
  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): confirmed landed via lib/flutterflow_project/pages/block_list.dart
  // — ListView_18cohngf no longer exists, replaced by ListView_iuyaje2t
  // "BlockedUsersListView". Same no-dedup-guard risk as every other
  // ensureReplaced in this file — this specific block predates the freeze
  // discipline being applied consistently and was found still-live during
  // this review pass, not newly introduced by it.
  // app.editPage(ff.Pages.blockList, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_18cohngf'),
  //     Expanded(
  //       ListView(
  //         name: 'BlockedUsersListView',
  //         spacing: 8,
  //         source: State('blockedUsersList'),
  //         itemBuilder: (item) => Card(
  //           child: Container(
  //             padding: 12,
  //             child: Row(
  //               mainAxis: MainAxis.spaceBetween,
  //               children: [
  //                 Expanded(
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 1}),
  //                     maxLines: 1,
  //                     overflow: TextOverflow.ellipsis,
  //                   ),
  //                 ),
  //                 Button(
  //                   'ブロック解除',
  //                   variant: ButtonVariant.outlined,
  //                   onTap: [
  //                     CallCustomAction.named(
  //                       'callUnblockUser',
  //                       arguments: {'targetUid': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})},
  //                       outputAs: 'unblockResult',
  //                     ),
  //                     If(
  //                       ActionOutput('unblockResult'),
  //                       then: [
  //                         CallCustomAction.named('fetchBlockedUsers', outputAs: 'refetchResult'),
  //                         SetState('blockedUsersList', ActionOutput('refetchResult')),
  //                         Snackbar('ブロックを解除しました。'),
  //                       ],
  //                       orElse: [Snackbar('ブロック解除に失敗しました。')],
  //                     ),
  //                   ],
  //                 ),
  //               ],
  //             ),
  //           ),
  //         ),
  //       ),
  //       name: 'BlockedUsersListExpanded',
  //     ),
  //   );
  // });

  app.editPageState(ff.Pages.myPage, (state) {
    state.ensureField('myReviewsList', listOf(string));
  });

  app.editPage(ff.Pages.myPage, (page) {
    page.ensureActions(
      page.findByKey('Row_4184o5rw'), // 報酬・売上・決済管理
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.walletPage)],
    );
    page.ensureActions(
      page.findByKey('Row_ydbc8yfa'), // アカウント・基本管理
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.settingsPage)],
    );

    // Phase 11 slice 1 (2026-08-12) — real own-rating, reusing the exact
    // fetchCastReviews/averageRatingLabelFn pair already live on
    // CastProfile (Phase 7), just called with the current user's own uid
    // (`AuthUser(AuthUserField.userId)`, a built-in DSL expression — no new
    // custom action needed). `page.root`'s ON_INIT_STATE already carries a
    // real native action (`FFAppState().navIndex = 4`, confirmed via
    // generated_code) — reproduced here verbatim before appending the new
    // fetch, since `ensureActions` replaces the WHOLE chain on every call
    // and a SECOND separate `ensureActions` call on the same root+trigger
    // is confirmed (HomePage's own history, this file) to fail
    // `compileDslApp` outright even when reproducing an unchanged chain —
    // this must be the single source of truth for this trigger.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        UpdateAppState.set(ff.AppState.navIndex, 4),
        CallCustomAction.named(
          'fetchCastReviews',
          arguments: {'castId': AuthUser(AuthUserField.userId)},
          outputAs: 'myReviewsResult',
        ),
        SetState('myReviewsList', ActionOutput('myReviewsResult')),
      ],
    );
    // `EditWidgetPatch.text(...)` only accepts a literal String, not a
    // dynamic expression (confirmed by compile error) — this DSL's known
    // "patch.* methods take literals only" drift, same class already
    // documented for `patch.visible(...)`. Used `ensureReplaced` instead to
    // reconstruct this specific `Text` with a genuinely dynamic binding.
    //
    // FROZEN (2026-08-12, review pass, immediately after this exact push
    // landed): confirmed via lib/flutterflow_project/pages/my_page.dart —
    // `Text_a7eis4fi` no longer exists; `ensureReplaced` reassigned it a
    // fresh key (`Text_8ipm8e8m`) the moment this ran, same one-shot
    // behavior as every other `ensureReplaced` call in this file. Left
    // live, the NEXT push (for any unrelated reason) would fail outright —
    // `findByKey('Text_a7eis4fi')` would find nothing, since that key is
    // already gone. Any future change to this specific Text node must
    // target `Text_8ipm8e8m` (or re-resolve via
    // ff.Pages.myPage.widgets.byName('MyPageRatingLabel')) instead of this
    // stale key.
    // page.ensureReplaced(
    //   page.findByKey('Text_a7eis4fi'),
    //   Text(
    //     CustomFunction(averageRatingLabelFn, args: {'reviews': State('myReviewsList')}),
    //     name: 'MyPageRatingLabel',
    //   ),
    // );

    // Phase 11 slice 1 (2026-08-12) — the remaining drawer rows/buttons
    // whose destinations already exist and are fully backend-wired, but
    // were never connected. `Affiliate` (Phase 9) and `MyWorkContent`
    // (Phase 10) were both 100% unreachable from anywhere in the app until
    // this push — same "built but nobody can get to it" class already
    // caught and fixed for `MyWorkContent` via `WorkPage` in Phase 10.
    // `ensureActions` is genuinely idempotent (compares current vs.
    // requested trigger chain, no-ops on an exact rerun) so these are safe
    // to leave live, unlike `ensureReplaced`.
    page.ensureActions(
      page.findByKey('Row_2h5jlior'), // ワーク・活動管理
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.myWorkContent)],
    );
    page.ensureActions(
      page.findByKey('Row_sh13tqz0'), // 集客・シェア
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.affiliate)],
    );
    // Phase 11 slice 2 (2026-08-12) — the row deliberately left unwired in
    // slice 1 because BlockList didn't exist yet.
    page.ensureActions(
      page.findByKey('Row_17k3wf36'), // 対人・実績管理
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.blockList)],
    );
    page.ensureActions(
      page.findByKey('Row_8iq153hm'), // システム・情報
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.systemInfo)],
    );
    // Phase 11 slice 3 (2026-08-12) — the last remaining unwired drawer
    // row, held open since slice 1 pending the legal-content pages built
    // above in this same push.
    page.ensureActions(
      page.findByKey('Row_gnymcn1g'), // サポート・法的項目
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.supportLegalHub)],
    );
    page.ensureActions(
      page.findByKey('Button_h37grnzt'), // プロフィール編集 — was a print() stub
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.profileEdit)],
    );
    page.ensureActions(
      page.findByKey('Button_p13i636o'), // ワーク編集 — was a print() stub
      triggerType: FFActionTriggerType.ON_TAP,
      // Same destination as ワーク・活動管理 above. MyWorkContent already
      // self-gates non-casts with a "この画面はキャスト専用です。" message
      // (confirmed this session), so no extra guard is needed here even
      // though MyPage itself is cast-only by convention, not enforcement.
      actions: [Navigate(ff.Pages.myWorkContent)],
    );
  });

  // Review-pass fix (2026-08-11): `formatYen`'s comma-grouping loop assumed
  // a pure-digit string with no sign prefix — for a negative amount (e.g.
  // `n = -5000`, `s = "-5000"`), the loop counts the `-` character as part
  // of the digit-grouping position, inserting a comma in the wrong place
  // (`"-5,0,00"` instead of `"-5,000"`). Traced every ledger `type` a cast's
  // own `WalletPage` could actually display to confirm this is currently
  // UNREACHABLE (not a live bug, but a real latent one in a generic,
  // likely-to-be-reused utility): `reward` entries cap debt deduction at
  // `Math.min(currentDebt, totalCastAmount)` so `net_transfer` can never go
  // negative (stripe-payments.ts's own multi-cast-transfer transaction);
  // `refund` entries are scoped to `user_id: resData.guest_id`, never a
  // cast, so they never appear in a cast's own wallet history in the first
  // place (`MyPage`/`WalletPage` are both confirmed cast-only). Fixed
  // anyway, defensively, since the fix is trivial and this utility is
  // exactly the kind of small generic helper this session has repeatedly
  // reused elsewhere (any future debt-history view — already a disclosed
  // "still open" item for this phase — would plausibly want to show a
  // negative/debt amount through this same function). `app.customFunction`
  // compiles to `ensureCustomFunction` (create-if-missing only, confirmed
  // the hard way many times this session) — since `formatYen` already
  // exists live, editing its `code:` in place inside the original
  // declaration above would silently no-op on the next push, so the fix
  // goes through `updateCustomFunction` instead, per the already-
  // established rule for editing an already-landed customFunction's body.
  app.raw((project) {
    updateCustomFunction(
      project,
      name: 'formatYen',
      code: r'''
final n = int.tryParse(amount ?? '') ?? 0;
final isNegative = n < 0;
final s = n.abs().toString();
final buf = StringBuffer();
for (int i = 0; i < s.length; i++) {
  if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
  buf.write(s[i]);
}
return '${isNegative ? '-' : ''}¥$buf';
''',
    );
  });

  // Review-pass fix (2026-08-11): `fetchWalletBalance` returns
  // `has_stripe_account` (index 2 of its delimited result) but nothing in
  // `WalletPage` ever read or displayed it — a cast who hasn't finished
  // Stripe Connect onboarding yet would just see "¥0" with no explanation
  // and no path forward. Adds the missing state field, extends the
  // EXISTING `ON_INIT_STATE` chain to also capture it (re-declaring the
  // full chain via `ensureActions` — this project's own hard rule is
  // "never target the same root+trigger with two SEPARATE ensureActions
  // calls," but the ORIGINAL declaration is frozen/inert now, so this is
  // the only ACTIVE `ensureActions` call on this trigger in this script,
  // not a second one racing it), and inserts a guidance message + a button
  // straight to `ConnectOnboarding` (confirmed zero required params) when
  // no Stripe account exists yet. Uses `ff.Pages.walletPage.state.*` typed
  // handles throughout, per this file's own already-documented
  // `ensurePage`-body-inert rule.
  app.editPageState(ff.Pages.walletPage, (state) {
    state.ensureField('hasStripeAccountStr', string.withDefault('false'));
  });

  app.editPage(ff.Pages.walletPage, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named('fetchWalletBalance', outputAs: 'balanceResult'),
        SetState(
          ff.Pages.walletPage.state.walletAvailableStr,
          CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceResult'), 'index': 0}),
        ),
        SetState(
          ff.Pages.walletPage.state.walletPendingStr,
          CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceResult'), 'index': 1}),
        ),
        SetState(
          'hasStripeAccountStr',
          CustomFunction(splitFieldFn, args: {'data': ActionOutput('balanceResult'), 'index': 2}),
        ),
        CallCustomAction.named('fetchMyLogicalDebt', outputAs: 'debtResult'),
        SetState(ff.Pages.walletPage.state.logicalDebtStr, ActionOutput('debtResult')),
        CallCustomAction.named('fetchWalletLedgerHistory', outputAs: 'historyResult'),
        SetState(ff.Pages.walletPage.state.ledgerHistoryList, ActionOutput('historyResult')),
      ],
    );

    // FROZEN (2026-08-12, comprehensive review pass): confirmed landed —
    // `NoStripeAccountGuidance` exists in
    // lib/flutterflow_project/pages/wallet_page.dart. `ensureInsertedAfter`
    // is one-shot; the anchor key `Text_vyp0g65e` still exists, so a rerun
    // would silently no-op, but any future EDIT to this section's content
    // would be silently ignored the same way. Any future change must go
    // through `app.editPage(ff.Pages.walletPage, ...)` targeting its real
    // widget keys instead. The `ensureActions` ON_INIT_STATE call above
    // stays live (genuinely idempotent, not one-shot).
    // page.ensureInsertedAfter(
    //   page.findByKey('Text_vyp0g65e'), // 論理負債があるか、出金可能な残高がないため...
    //   Container(
    //     name: 'NoStripeAccountGuidance',
    //     visible: Not(Equals(State('hasStripeAccountStr'), 'true')),
    //     child: Column(
    //       crossAxis: CrossAxis.start,
    //       spacing: 8,
    //       children: [
    //         Text(
    //           'Stripeアカウントが未設定です。報酬を受け取るには、まず口座連携を完了してください。',
    //           style: Styles.labelSmall,
    //         ),
    //         Button(
    //           '口座連携を設定する',
    //           variant: ButtonVariant.outlined,
    //           onTap: [Navigate(ff.Pages.connectOnboarding)],
    //         ),
    //       ],
    //     ),
    //   ),
    // );
  });

  // Review-pass fix (2026-08-11): the wallet transaction history showed
  // every `ledger` entry identically regardless of its own `status` field
  // — but `status` is a REAL, meaningful distinction, not decorative.
  // Confirmed by reading every `ledger`-collection write site across the
  // whole backend: `reward` entries are written `status: needsTransfer ?
  // "pending" : "confirmed"` (stripe-payments.ts's multi-cast-transfer
  // transaction) and later flipped to `"confirmed"` once the real Stripe
  // Transfer succeeds, or `"retrying"` if it fails and gets retried
  // (`transferPendingCastRewards`) — a "pending"/"retrying" reward entry
  // means the money has NOT actually arrived in the cast's Stripe balance
  // yet, only been recorded as owed. Every OTHER type (`staff_fee`, `tip`,
  // `affiliate`, `refund`) is always written `"confirmed"` immediately,
  // since each is only written AFTER its own Stripe Transfer/refund API
  // call already succeeded — so this only ever matters for `reward`
  // entries in practice, but the fix applies uniformly rather than special-
  // casing one type. Showing a not-yet-transferred amount with no
  // indication it's still pending directly contradicts §3.7.9's own
  // "must reflect Stripe truth" requirement — a cast could reasonably read
  // an unlabeled reward entry as "already in my balance" when it isn't.
  //
  // Refines the two-part update lesson `project_rules.md` already
  // documents for `formatYen`: the REAL fix goes through
  // `updateCustomAction` (this action is already live from the first
  // Phase 8 push) — but, unlike `formatYen`'s fix, the ORIGINAL
  // `app.customAction('fetchWalletLedgerHistory', ...)` declaration above
  // was DELIBERATELY LEFT MATCHING the CURRENTLY-LIVE (old, 3-field)
  // content, not updated to the new one. Tried updating both in the same
  // push first and it failed: `ensureCustomAction`'s idempotency check
  // runs against whatever's live AT THE START of this compile, so
  // pointing the ORIGINAL declaration at the NEW content immediately
  // mismatches the still-old remote state and fails before the
  // `updateCustomAction` call later in the same script ever gets a chance
  // to actually apply the fix — the two calls don't get to "meet in the
  // middle" within one push. The correct sequencing (confirmed by how
  // `formatYen`'s own fix actually landed, across two separate pushes,
  // re-read after this failure): apply the real change via
  // `updateCustomAction` now, leave the original declaration alone so its
  // own `ensureCustomAction` call stays idempotent THIS push, and sync the
  // original declaration to match in a LATER push, once the remote state
  // is confirmed to have actually changed.
  app.raw((project) {
    updateCustomAction(
      project,
      name: 'fetchWalletLedgerHistory',
      code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<List<String>> fetchWalletLedgerHistory() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return <String>[];
    final snap = await FirebaseFirestore.instance
        .collection('ledger')
        .where('user_id', isEqualTo: uid)
        .orderBy('created_at', descending: true)
        .limit(50)
        .get();
    return snap.docs.map((d) {
      final data = d.data();
      final type = data['type']?.toString() ?? '';
      final amountRaw = data['net_transfer'] ?? data['amount'] ?? 0;
      final amount = amountRaw.toString();
      var dateLabel = '';
      final ts = data['created_at'];
      if (ts is Timestamp) {
        final dt = ts.toDate();
        dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
      }
      final status = data['status']?.toString() ?? 'confirmed';
      return '$type|||$amount|||$dateLabel|||$status';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
    );
  });

  final ledgerStatusLabelFn = app.customFunction(
    'ledgerStatusLabel',
    args: {'status': string},
    returns: string,
    description: '台帳（ledger）エントリのstatus値を表示用ラベルに変換する（未確定の送金のみ表示、確定済みは空文字）。',
    code: r'''
switch (status) {
  case 'pending':
    return '送金処理中';
  case 'retrying':
    return '送金再試行中';
  default:
    return '';
}
''',
  );

  // Review-pass fix #2 (2026-08-11), found immediately after the status-
  // label fix above landed: `ensureReplaced(target, replacement)` replaces
  // the ENTIRE SLOT the target key sits in, collapsing any WRAPPER that
  // isn't itself part of the replacement tree — even when the target key
  // is for an INNER widget, not the wrapper. The previous fix targeted
  // `ListView_6jqh17yr` (the inner `WalletHistoryListView`'s own key,
  // originally built inside `Expanded(..., name: 'WalletHistoryExpanded')`
  // from the very first Phase 8 push) and replaced it with a bare
  // `ListView(...)`, assuming the surrounding `Expanded` — never itself
  // targeted — would survive untouched. Confirmed via direct inspection of
  // `generated_code/lib/wallet_page/wallet_page_widget.dart` that this
  // assumption was WRONG: `Expanded` no longer appears anywhere in the
  // file at all, and the list sits as a bare, unbounded child of the
  // Scaffold-body Column again — silently reintroducing the exact overflow
  // risk the original fix closed. `flutterflow ai trace latest`'s own
  // R19/`VALIDATION_LIST_VIEW_SHRINK_WRAP` check did NOT catch this
  // regression, because that check only fires on `shrinkWrap: true` —
  // it has no check for the OPPOSITE misconfiguration (unbounded list,
  // shrinkWrap left at its false default, no `Expanded`), so its silence
  // was never actually reassurance for this class of bug; only reading the
  // regenerated widget tree directly caught it. Fixed by including
  // `Expanded(...)` in the replacement tree this time, and re-checked the
  // typed SDK for the CURRENT live key first (`ListView_1r7nitqx` — a
  // THIRD key for this same logical widget now, since each `ensureReplaced`
  // assigns a fresh one).
  //
  // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
  // generated_code — `ensureReplaced` has no dedup guard, so leaving this
  // live risked assigning a FOURTH key to this same widget on any future
  // unrelated push. Commented out per the established freeze discipline
  // (PROJECT_KNOWLEDGE.md §54/project_rules.md).
  // app.editPage(ff.Pages.walletPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_1r7nitqx'),
  //     Expanded(
  //       ListView(
  //         name: 'WalletHistoryListView',
  //         spacing: 6,
  //         source: State(ff.Pages.walletPage.state.ledgerHistoryList),
  //         itemBuilder: (item) => Column(
  //           crossAxis: CrossAxis.start,
  //           children: [
  //             Row(
  //               mainAxis: MainAxis.spaceBetween,
  //               children: [
  //                 Text(CustomFunction(ledgerTypeLabelFn, args: {'type': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})})),
  //                 Text(CustomFunction(formatYenFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})})),
  //                 Text(
  //                   CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                   style: Styles.labelSmall,
  //                 ),
  //               ],
  //             ),
  //             Text(
  //               CustomFunction(ledgerStatusLabelFn, args: {'status': CustomFunction(splitFieldFn, args: {'data': item, 'index': 3})}),
  //               style: Styles.labelSmall,
  //             ),
  //           ],
  //         ),
  //       ),
  //       name: 'WalletHistoryExpanded2',
  //     ),
  //   );
  // });

  // ==========================================================================
  // Phase 9 — Affiliate system (§3.7.12 incl. the mutual-approval hard rule,
  // §3.9.14, Affiliate doc in full, §4.2's reconciled reading)
  //
  // Backend audit first, same discipline as every phase: read affiliate.ts
  // in full (accrual/monthly-batch split, forfeiture, dashboard query) and
  // stripe-payments.ts's processAffiliateRewards (the actual accrual site).
  // Found and fixed FOUR confirmed backend bugs before writing any DSL,
  // each deployed and verified via `tsc --noEmit` + `firebase deploy` before
  // moving on:
  //   1. processAffiliateRewards never checked referrerData.approval_status
  //      nor castData.approval_status before accruing — a direct violation
  //      of §3.7.12's mutual-approval hard rule (fixed: both now checked).
  //   2. processAffiliatorPayment's workDays<minDays branch called
  //      forfeitRewards (permanent) instead of deferring — contradicted the
  //      plan's own explicit "don't conflate deferral with forfeiture"
  //      instruction (fixed: no forfeiture call, rewards stay pending; the
  //      monthly batch query was also restructured from "last calendar
  //      month only" to ALL pending rewards grouped by (affiliator, accrual
  //      month), so a deferred reward is genuinely re-evaluable on a later
  //      run instead of never being queried again).
  //   3. config.AFFILIATE_MIN_DAYS (uppercase) never matched config.ts's
  //      lowercase affiliate_min_days key — same casing-mismatch bug class
  //      already fixed once for config.ts itself, silently always fell back
  //      to the hardcoded literal 3 (fixed: lowercase key).
  //   4. requestWithdrawal only forfeited the AFFILIATOR's own pending
  //      rewards on leave; a REFERRED cast leaving had no explicit
  //      handling, and the incidental per-reward is_active check in
  //      processAffiliatorPayment would forfeit ALL of that referred
  //      cast's pending rewards regardless of month, not just the
  //      departure month per §3.7.12's asymmetric leave rule (fixed:
  //      requestWithdrawal now stamps left_at; the per-reward check uses it
  //      to forfeit only the reward whose own `month` matches the
  //      departure month, paying prior-month reward normally — falls back
  //      to the old forfeit-everything behavior when left_at is absent,
  //      i.e. an admin force-ban rather than a voluntary leave, since the
  //      plan's own text explicitly flags freeze-as-leave-equivalence as
  //      unconfirmed, not something to invent here).
  // Also fixed the cron's hardcoded "5": Cloud Scheduler strings can't read
  // Firestore at deploy time regardless, so the schedule now runs daily and
  // no-ops except on config.affiliate_payment_day — genuinely admin-
  // editable instead of a literal.
  //
  // Change-history requirement (checklist's own "with change history"):
  // found `affiliate_rate_history`'s SCHEMA already declared in this
  // project (earlier phase's backend-schema fixup) but completely unused —
  // no writer, no reader, no Firestore rule at all (a 5th rule-less
  // collection found this session, alongside the 4 already disclosed in
  // the full-project audit). Wired `adminUpdateAffiliateRate` to write it
  // alongside the existing generic audit_logs entry, added its Firestore
  // rule (admin-read-only, same lockdown as audit_logs/processed_events)
  // and composite index, and added `adminGetAffiliateRateHistory` to read
  // one affiliator's own history for the admin UI below.
  //
  // Referral-code system: confirmed by reading completeOnboarding (auth.ts)
  // and getAffiliateDashboard together that the "referral code" IS the
  // referrer's own Firebase UID (looked up directly via
  // `users/{referral_code}`, account_type=='cast' required) — there is no
  // separately-generated invite code anywhere in the backend. The
  // PRE-EXISTING Affiliate page and AffiliateQrCodeBottomSheet component
  // (both already built before this phase) bind their displayed/copied/
  // shared code to `currentUserDocument?.invitationCode` instead — a
  // schema field that is declared but NEVER WRITTEN anywhere in the
  // backend, so it always resolves empty. This is a previously-
  // undiscovered, currently-live bug: the referral code has never actually
  // displayed, copied, or shared correctly since these widgets were built.
  // Fixed by rebinding everything to the real uid instead of the dead
  // field. Disclosed gap: the QR barcode's own `data:` source could not be
  // located as a DSL-patchable property within this SDK's documented
  // surface — `flutterflow ai docs ui`/`api-surface` and every reference
  // file were checked directly, none cover a Barcode widget or a
  // LaunchUrl/Share action node type, so it was very likely hand-built in
  // the FlutterFlow IDE rather than through this SDK. Left as a known,
  // disclosed remaining gap rather than guessing at `mutateNode`-level
  // proto edits; the 4 actual SHARE BUTTONS were fixable via ordinary
  // custom actions since url_launcher's `launchURL` helper and share_plus
  // are already proven-compiling in this exact generated codebase, so only
  // the visual QR code itself still encodes the dead field.
  //
  // Dashboard cards: getAffiliateDashboard only returned 11 fields (rate /
  // team count / current-month pending / all-time paid / eligibility) but
  // the PRE-EXISTING static mockup UI has ~20 metric rows (work hours by
  // day/week/month/cumulative, work days by week/month/cumulative, reward
  // by day/week/month/cumulative, active vs inactive team member counts).
  // All of these ARE backed by real underlying data already in the schema
  // (`reservations.duration_minutes` for hours, completed-reservation
  // dates for days, `affiliate_rewards.reward_amount`/`created_at` for
  // reward-by-period, `users.is_active` for the active/inactive split) —
  // none of it is fabricated, so getAffiliateDashboard was extended to
  // compute and return all of it for real rather than leaving those rows
  // as permanent "123" placeholders or inventing scope the checklist
  // didn't ask for.
  //
  // "申請する" (apply) button: the static mockup shows a manual payout-
  // request affordance with a "振込可能金額 5,000円以上〜" minimum-balance
  // gate. This directly conflicts with the CONFIRMED backend design
  // (§4.2): affiliate Transfer execution is fully automatic via the
  // monthly batch job on the 5th, gated only on the 3-active-day rule and
  // mutual-approval — there is no manual-request concept anywhere in
  // affiliate.ts, no minimum-payout-amount config exists, and building a
  // fake manual-request callable now would contradict the already-
  // reconciled §4.2 design rather than complete it. Resolved the same way
  // §4.2 itself was resolved — privileging the Affiliate document's own
  // confirmed automatic design over an inherited UI element — by
  // repurposing the button into a real status display (current
  // eligibility + the actual payment day) instead of wiring it to a
  // nonexistent manual endpoint. Disclosed here, not guessed silently.
  // ==========================================================================

  app.customFunction(
    'formatNumber',
    args: {'amount': string},
    returns: string,
    description: '数値文字列を3桁カンマ区切りに整形する（円マークなし、単位サフィックスが別Textで既にある表示用）。',
    code: r'''
final n = int.tryParse(amount ?? '') ?? 0;
final isNegative = n < 0;
final s = n.abs().toString();
final buf = StringBuffer();
for (int i = 0; i < s.length; i++) {
  if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
  buf.write(s[i]);
}
return '${isNegative ? '-' : ''}$buf';
''',
  );

  app.customAction(
    'fetchAffiliateDashboard',
    returns: string,
    description: 'getAffiliateDashboard Cloud Functionを呼び出し、アフィリエイトダッシュボードの全指標を取得する（|||区切り21フィールド）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> fetchAffiliateDashboard() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getAffiliateDashboard');
    final result = await callable.call({});
    if (result.data is! Map) return '';
    final d = result.data as Map;
    String s(String key) => d[key]?.toString() ?? '0';
    final ratePercent = (((d['affiliate_rate'] as num?) ?? 0.05) * 100);
    return [
      d['referral_code']?.toString() ?? '',
      ratePercent.toStringAsFixed(0),
      s('referred_cast_count'),
      s('active_referred_count'),
      s('inactive_referred_count'),
      s('current_month_work_days'),
      s('current_month_min_days'),
      s('current_month_pending_amount'),
      (d['eligible_for_payment'] == true).toString(),
      s('work_hours_today'),
      s('work_hours_week'),
      s('work_hours_month'),
      s('work_hours_cumulative'),
      s('work_days_week'),
      s('work_days_month'),
      s('work_days_cumulative'),
      s('reward_today'),
      s('reward_week'),
      s('reward_month'),
      s('reward_cumulative'),
      s('affiliate_payment_day'),
    ].join('|||');
  } catch (e) {
    return '';
  }
}
''',
  );

  app.customAction(
    'shareReferralLink',
    args: {'platform': string},
    returns: bool_,
    description: '紹介リンクを指定プラットフォーム（line/twitter/threads/share）で共有する。紹介コードは自分のUID（invitation_codeフィールドは常に空のため未使用）。',
    code: r'''
import 'package:share_plus/share_plus.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> shareReferralLink(String? platform) async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return false;
    const message = '稼ぎたい人も暇な人も『一緒に飯行こ！暇つぶしアプリ「icoccha-イコッチャ-」』登録はこちらから！';
    final url = 'https://icoccha.com/signup?ref=$uid';
    switch (platform) {
      case 'line':
        await launchURL('https://line.me/R/msg/text/$message $url');
        break;
      case 'twitter':
        await launchURL('https://twitter.com/intent/tweet?text=$message $url');
        break;
      case 'threads':
        await launchURL('https://www.threads.net/intent/post?text=$message $url');
        break;
      default:
        await Share.share('$message $url');
    }
    return true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // NOTE: the copy-icon's onTap was originally wired as
  // `ensureActions(..., actions: [CopyToClipboard(CustomFunction(splitFieldFn,
  // ...))])` — that call reported no error (compileDslApp passed clean) but
  // the pushed proto silently did NOT change: generated_code still showed
  // the OLD `currentUserDocument?.invitationCode` binding even after a
  // forced `codegen refresh`. Every OTHER `ensureActions` call in this same
  // push (the 4 share buttons below via `CallCustomAction.named`, the
  // repurposed 申請する button) DID land correctly, confirmed directly in
  // generated_code — isolating the gap specifically to
  // `CopyToClipboard(CustomFunction(...))`, not to `ensureActions` in
  // general. Worked around by using a custom action (the same proven
  // mechanism as the share buttons) instead of the native CopyToClipboard
  // DSL action.
  app.customAction(
    'copyReferralCodeToClipboard',
    returns: bool_,
    description: '自分のUID（紹介コード）をクリップボードにコピーする。',
    code: r'''
import 'package:flutter/services.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<bool> copyReferralCodeToClipboard() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return false;
    await Clipboard.setData(ClipboardData(text: uid));
    return true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'fetchAffiliatorList',
    returns: listOf(string),
    description: 'adminGetAffiliateOverview Cloud Functionを呼び出し、アフィリエイター一覧を取得する（uid/ニックネーム/現在の料率/紹介キャスト数/累計支払額）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchAffiliatorList() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminGetAffiliateOverview');
    final result = await callable.call({});
    if (result.data is! Map || result.data['affiliators'] is! List) return <String>[];
    final list = result.data['affiliators'] as List;
    return list.map((raw) {
      final m = raw as Map;
      final uid = m['affiliator_uid']?.toString() ?? '';
      final nickname = (m['nickname']?.toString() ?? '').replaceAll('|||', '');
      final ratePercent = (((m['affiliate_rate'] as num?) ?? 0.05) * 100).toStringAsFixed(0);
      final teamCount = m['referred_cast_count']?.toString() ?? '0';
      final cumulativePaid = m['cumulative_paid']?.toString() ?? '0';
      return '$uid|||$nickname|||$ratePercent|||$teamCount|||$cumulativePaid';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callUpdateAffiliateRate',
    args: {'userId': string, 'newRatePercent': string},
    returns: bool_,
    description: 'adminUpdateAffiliateRate Cloud Functionを呼び出し、指定アフィリエイターの料率を変更する（5%刻み、5〜30%）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callUpdateAffiliateRate(String? userId, String? newRatePercent) async {
  try {
    final uid = userId ?? '';
    final percent = double.tryParse(newRatePercent ?? '') ?? 0;
    if (uid.isEmpty || percent <= 0) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminUpdateAffiliateRate');
    final result = await callable.call({'user_id': uid, 'new_rate': percent / 100});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'fetchAffiliateRateHistory',
    args: {'userId': string},
    returns: listOf(string),
    description: 'adminGetAffiliateRateHistory Cloud Functionを呼び出し、指定アフィリエイターの料率変更履歴を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchAffiliateRateHistory(String? userId) async {
  try {
    final uid = userId ?? '';
    if (uid.isEmpty) return <String>[];
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('adminGetAffiliateRateHistory');
    final result = await callable.call({'user_id': uid});
    if (result.data is! Map || result.data['history'] is! List) return <String>[];
    final list = result.data['history'] as List;
    return list.map((raw) {
      final m = raw as Map;
      final oldPercent = (((m['old_rate'] as num?) ?? 0) * 100).toStringAsFixed(0);
      final newPercent = (((m['new_rate'] as num?) ?? 0) * 100).toStringAsFixed(0);
      var dateLabel = '';
      final ts = m['changed_at']?.toString() ?? '';
      if (ts.isNotEmpty) {
        final dt = DateTime.tryParse(ts);
        if (dt != null) {
          dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
        }
      }
      return '$oldPercent|||$newPercent|||$dateLabel';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  // -- AffiliateQrCodeBottomSheet: rebind the 4 share buttons off the dead
  // `invitationCode` field onto the real uid-based referral link. The
  // Barcode's own `data:` source is left as a disclosed gap (see the long
  // comment above) — not a DSL-patchable property found in this SDK.
  app.editComponent(ff.Components.affiliateQrCodeBottomSheet, (component) {
    component.ensureActions(
      component.findByKey('Image_57r9rbcw'), // LINE
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'shareReferralLink',
          arguments: {'platform': 'line'},
          outputAs: 'shareLineResult',
        ),
      ],
    );
    component.ensureActions(
      component.findByKey('Image_4jwu6oa2'), // generic share sheet
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'shareReferralLink',
          arguments: {'platform': 'share'},
          outputAs: 'shareGenericResult',
        ),
      ],
    );
    component.ensureActions(
      component.findByKey('Image_kp4fv03o'), // X (Twitter)
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'shareReferralLink',
          arguments: {'platform': 'twitter'},
          outputAs: 'shareTwitterResult',
        ),
      ],
    );
    component.ensureActions(
      component.findByKey('Image_fi75lg5a'), // Threads
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'shareReferralLink',
          arguments: {'platform': 'threads'},
          outputAs: 'shareThreadsResult',
        ),
      ],
    );
  });

  // -- Affiliate page: wire referral code, all dashboard cards, and the
  // repurposed status button. Page already exists (built before this
  // phase), so `dashboardData` is a NEW field added via `editPageState` —
  // per this file's own already-documented lesson, a field created via
  // `editPageState` in the SAME script still needs bare-string `State('x')`
  // references (not yet in the local typed SDK), while `ff.Pages.affiliate`
  // itself is fine to use as a typed handle since the PAGE already existed.
  app.editPageState(ff.Pages.affiliate, (state) {
    state.ensureField('dashboardData', string.withDefault(''));
  });

  app.editPageOnLoad(ff.Pages.affiliate, [
    CallCustomAction.named('fetchAffiliateDashboard', outputAs: 'dashboardResult'),
    SetState('dashboardData', ActionOutput('dashboardResult')),
  ]);

  // FROZEN (2026-08-11, immediately after this exact push landed): all 17
  // `ensureReplaced` calls below are one-shot and CONFIRMED LANDED —
  // verified directly via the regenerated typed SDK
  // (lib/flutterflow_project/pages/affiliate.dart), every target now shows
  // its `name:` (ReferralCodeText, AffiliateRateText, ... etc.) instead of
  // the original bare key. Re-running them would fail since the OLD keys
  // (Text_lcmyx3h4, Text_tzf8tm22, ...) no longer exist. Any future change
  // to these widgets must go through app.editPage(ff.Pages.affiliate, ...)
  // targeting the NEW keys/names instead.
  //
  // The copy-icon fix below is a SEPARATE, still-live edit needed on this
  // same push: `ensureActions(Icon_vjntgx4n, ON_TAP, [CopyToClipboard(
  // CustomFunction(...))])` reported no error but silently did NOT apply —
  // confirmed via generated_code even after a forced `codegen refresh`,
  // while every OTHER `ensureActions` call in the original push (the 4
  // share buttons, the repurposed 申請する button) DID land correctly.
  // Isolated to `CopyToClipboard` wrapping a `CustomFunction` expression
  // specifically — worked around with a custom action instead (the same
  // proven mechanism already used for the share buttons).
  //   app.editPage(ff.Pages.affiliate, (page) {
  //     page.ensureReplaced(
  //       page.findByKey('Text_lcmyx3h4'),
  //       Text(
  //         CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 0}),
  //         name: 'ReferralCodeText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_tzf8tm22'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 1}), name: 'AffiliateRateText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_nf1sis21'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 2}), name: 'TeamSizeText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_gayx68ow'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 3}), name: 'ActiveCountText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_ahmt2cqw'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 4}), name: 'InactiveCountText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_pu0l40j9'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 9}), name: 'WorkHoursTodayText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_f24x05a1'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 10}), name: 'WorkHoursWeekText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_vqfm87nb'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 11}), name: 'WorkHoursMonthText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_bfrrbnjx'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 12}), name: 'WorkHoursCumulativeText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_b0r9zsyc'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 13}), name: 'WorkDaysWeekText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_tl521gdp'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 14}), name: 'WorkDaysMonthText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_6tvvtg4x'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 15}), name: 'WorkDaysCumulativeText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_zmcrm0ra'),
  //       Text(
  //         CustomFunction(formatNumberFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 16})}),
  //         name: 'RewardTodayText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_t0itbgen'),
  //       Text(
  //         CustomFunction(formatNumberFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 17})}),
  //         name: 'RewardWeekText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_hocaytv9'),
  //       Text(
  //         CustomFunction(formatNumberFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 18})}),
  //         name: 'RewardMonthText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_ap0r0l02'),
  //       Text(
  //         CustomFunction(formatNumberFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 19})}),
  //         name: 'RewardCumulativeText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_haz55nvg'),
  //       Text(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 20}), name: 'PaymentDayText'),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_yjv0ognw'),
  //       Text(
  //         CustomFunction(formatNumberFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 7})}),
  //         name: 'CurrentMonthPendingText',
  //       ),
  //     );
  //   });

  app.editPage(ff.Pages.affiliate, (page) {
    page.ensureActions(
      page.findByKey('Icon_vjntgx4n'), // copy icon
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named('copyReferralCodeToClipboard', outputAs: 'copyResult'),
      ],
    );

    // "申請する" repurposed to a real status view — see the long comment
    // above for why a manual-request action would contradict the
    // confirmed automatic-transfer design (§4.2).
    //
    // Review-pass fix (2026-08-11): the original "not eligible" message
    // below named ONLY the work-days shortfall as the reason — correct
    // when it was written, but `eligible_for_payment` (index 8) was later
    // broadened server-side (PROJECT_KNOWLEDGE.md §41) to also require
    // is_active/!is_frozen/approval_status=="approved", so a frozen or
    // not-yet-approved affiliator could now see this SAME message and be
    // told their WORK DAYS are the problem when they aren't. Generalized
    // to cover every reason without a new backend field, rather than
    // leaving a message that's actively wrong for two of its four
    // possible failure causes.
    page.ensureActions(
      page.findByKey('Button_hfuhdc6m'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(CustomFunction(splitFieldFn, args: {'data': State('dashboardData'), 'index': 8}), 'true'),
          then: [Snackbar('報酬受け取り条件を満たしています。毎月指定日に自動的に送金されます。')],
          orElse: [Snackbar('今月はまだ報酬受け取り条件を満たしていません。稼働日数（3日以上）・アカウントの承認状況をご確認ください。')],
        ),
      ],
    );
  });

  // FROZEN (2026-08-11, immediately after this exact push landed):
  // AdminAffiliateManagement now exists (created by this ensurePage call on
  // its first push, confirmed via generated_code's export manifest and the
  // regenerated typed SDK) — re-validated-but-inert on every subsequent
  // compile, same precedent as AdminReportReviewPage. Any future change to
  // this page must go through app.editPage(ff.Pages.adminAffiliateManagement,
  // ...) instead. Not linked from any menu yet, matching
  // AdminReportReviewPage's own precedent (route-reachable, nav wiring
  // deferred to a later admin-panel navigation phase).
  //   app.ensurePage(
  //     'AdminAffiliateManagement',
  //     route: '/admin-affiliate-management',
  //     description: '管理者向けアフィリエイト管理ページ（アフィリエイター一覧、料率手動変更（5〜30%、5%刻み）、変更履歴確認）。',
  //     state: {
  //       'isAdminUser': bool_.withDefault(false),
  //       'affiliatorsList': listOf(string),
  //       'selectedUid': string.withDefault(''),
  //       'selectedNickname': string.withDefault(''),
  //       'newRatePercent': string.withDefault('5'),
  //       'rateHistoryList': listOf(string),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('checkIsAdminUser', outputAs: 'isAdminResult'),
  //       SetState('isAdminUser', ActionOutput('isAdminResult')),
  //       CallCustomAction.named('fetchAffiliatorList', outputAs: 'affiliatorsResult'),
  //       SetState('affiliatorsList', ActionOutput('affiliatorsResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'アフィリエイト管理'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 12,
  //         children: [
  //           Text(
  //             '管理者権限がありません。',
  //             style: Styles.bodyMedium,
  //             visible: Equals(State('isAdminUser'), false),
  //           ),
  //           Expanded(
  //             ListView(
  //               name: 'AffiliatorsListView',
  //               spacing: 8,
  //               visible: State('isAdminUser'),
  //               source: State('affiliatorsList'),
  //               itemBuilder: (item) => Card(
  //                 name: 'AffiliatorCard',
  //                 child: Container(
  //                   padding: 12,
  //                   child: Column(
  //                     crossAxis: CrossAxis.start,
  //                     spacing: 4,
  //                     children: [
  //                       Text(
  //                         CustomFunction(splitFieldFn, args: {'data': item, 'index': 1}),
  //                         style: Styles.titleSmall,
  //                       ),
  //                       Row(
  //                         mainAxis: MainAxis.spaceBetween,
  //                         children: [
  //                           Text('現在の料率：'),
  //                           Row(
  //                             children: [
  //                               Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 2})),
  //                               Text('％'),
  //                             ],
  //                           ),
  //                         ],
  //                       ),
  //                       Row(
  //                         mainAxis: MainAxis.spaceBetween,
  //                         children: [
  //                           Text('紹介キャスト数：'),
  //                           Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 3})),
  //                         ],
  //                       ),
  //                       Row(
  //                         mainAxis: MainAxis.spaceBetween,
  //                         children: [
  //                           Text('累計支払額：'),
  //                           Text(CustomFunction(formatYenFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': item, 'index': 4})})),
  //                         ],
  //                       ),
  //                       Button(
  //                         '選択する',
  //                         variant: ButtonVariant.outlined,
  //                         onTap: [
  //                           SetState('selectedUid', CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})),
  //                           SetState('selectedNickname', CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //                           SetState('newRatePercent', CustomFunction(splitFieldFn, args: {'data': item, 'index': 2})),
  //                           CallCustomAction.named(
  //                             'fetchAffiliateRateHistory',
  //                             arguments: {'userId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})},
  //                             outputAs: 'historyResult',
  //                           ),
  //                           SetState('rateHistoryList', ActionOutput('historyResult')),
  //                         ],
  //                       ),
  //                     ],
  //                   ),
  //                 ),
  //               ),
  //             ),
  //           ),
  //           Divider(visible: Not(Equals(State('selectedUid'), ''))),
  //           Row(
  //             visible: Not(Equals(State('selectedUid'), '')),
  //             children: [
  //               Text('選択中：', style: Styles.titleSmall),
  //               Text(State('selectedNickname'), style: Styles.titleSmall),
  //             ],
  //           ),
  //           Dropdown(
  //             options: const ['5', '10', '15', '20', '25', '30'],
  //             label: '新しい料率（%）',
  //             value: State('newRatePercent'),
  //             onChanged: SetState('newRatePercent', const WidgetValue()),
  //             visible: Not(Equals(State('selectedUid'), '')),
  //           ),
  //           Button(
  //             '変更する',
  //             visible: Not(Equals(State('selectedUid'), '')),
  //             onTap: [
  //               CallCustomAction.named(
  //                 'callUpdateAffiliateRate',
  //                 arguments: {'userId': State('selectedUid'), 'newRatePercent': State('newRatePercent')},
  //                 outputAs: 'updateResult',
  //               ),
  //               If(
  //                 ActionOutput('updateResult'),
  //                 then: [
  //                   Snackbar('料率を変更しました。'),
  //                   CallCustomAction.named('fetchAffiliatorList', outputAs: 'affiliatorsRefetchResult'),
  //                   SetState('affiliatorsList', ActionOutput('affiliatorsRefetchResult')),
  //                   CallCustomAction.named(
  //                     'fetchAffiliateRateHistory',
  //                     arguments: {'userId': State('selectedUid')},
  //                     outputAs: 'historyRefetchResult',
  //                   ),
  //                   SetState('rateHistoryList', ActionOutput('historyRefetchResult')),
  //                 ],
  //                 orElse: [Snackbar('料率の変更に失敗しました。')],
  //               ),
  //             ],
  //           ),
  //           Text(
  //             '変更履歴',
  //             style: Styles.titleSmall,
  //             visible: Not(Equals(State('selectedUid'), '')),
  //           ),
  //           Expanded(
  //             ListView(
  //               name: 'RateHistoryListView',
  //               spacing: 6,
  //               visible: Not(Equals(State('selectedUid'), '')),
  //               source: State('rateHistoryList'),
  //               itemBuilder: (item) => Row(
  //                 spacing: 4,
  //                 children: [
  //                   Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})),
  //                   Text('%  →  '),
  //                   Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //                   Text('%'),
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                     style: Styles.labelSmall,
  //                   ),
  //                 ],
  //               ),
  //             ),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // ==========================================================================
  // Phase 10 — Work/staff board (§3.1.7, §3.7.4, §3.9.11)
  //
  // Backend audit first, same discipline as every phase. Found real gaps:
  //   1. createReservation hardcoded staffFee=0 and never accepted a staff
  //      selection at all, even though the downstream payout split
  //      (recordCastRewardsAndProcessOthers, stripe-payments.ts) already
  //      correctly subtracts staff_fee and splits it across staff_ids —
  //      the split logic was ready but never fed real data. Fixed by
  //      adding a `staff_selections` param (mirrors cast_ids' direct-
  //      selection shape), validating each staff member's own staff_type
  //      against the requested role, and computing the fee from
  //      config.security_staff_fee/transport_staff_fee.
  //   2. No client-facing way to apply to a work_posts doc existed at all
  //      — confirmed by adminHireWorkPostApplicant's own comment, which
  //      explicitly says the apply-side write was expected but missing.
  //      Built applyToWorkPost/selectWorkApplicant/fetchWorkPosts/
  //      getWorkPostDetail/fetchMyWorkPosts (new file, work-posts.ts).
  //      selectWorkApplicant also creates the dedicated cast-to-cast chat
  //      room (§3.7.6) for partner_recruit (group-invite) posts — a
  //      separate room from the reservation's own guest+cast room.
  //   3. WorkPostsFields' typed schema was missing `description` (the
  //      REAL field every backend write uses) and carried 7 decoy fields
  //      (`category`, `content`, `title`, `is_active`, `user_name`,
  //      `user_photo`, `user_ref`) that nothing in the backend ever
  //      writes — likely leftover from an earlier, abandoned generic
  //      "job board" schema draft. Fixed below.
  //
  // Scope decision, disclosed: `fetchMyWorkPosts` (posted/applied lists)
  // is built and deployed but not wired to a dedicated UI this pass — a
  // post's own poster can already find and manage it via the main open-
  // posts feed (their own post appears there too, since fetchWorkPosts
  // doesn't exclude the caller), which covers the checklist's core
  // "application/response management" ask without a second page. Once a
  // post leaves "open" status it drops out of that feed, so revisiting an
  // already-filled/closed own-post loses easy access — a real, minor gap,
  // left disclosed rather than building a second page speculatively.
  //
  // The 4 category cards: only 2 of them ("security"/"transport") map to
  // an actual work_posts `type` value — the other two ("girls"/"boys")
  // are general cast-recruiting marketing copy with no corresponding
  // work_posts data, so only security/transport get a real open-count
  // appended; girls/boys keep their existing static copy unchanged.
  // ==========================================================================

  app.raw((project) {
    _addField(
      project,
      'work_posts',
      'description',
      _string,
      description: 'ワーク投稿の説明文。バックエンドが実際に書き込むフィールド（旧schemaのcontentは不使用）。',
    );
    _removeField(project, 'work_posts', 'category');
    _removeField(project, 'work_posts', 'content');
    _removeField(project, 'work_posts', 'title');
    _removeField(project, 'work_posts', 'is_active');
    _removeField(project, 'work_posts', 'user_name');
    _removeField(project, 'work_posts', 'user_photo');
    _removeField(project, 'work_posts', 'user_ref');
  });

  app.customFunction(
    'canApplyToWorkPost',
    args: {'isPoster': string, 'hasApplied': string, 'status': string},
    returns: bool_,
    description: '応募ボタンの表示可否を判定する（投稿者本人でない、未応募、募集中の全条件）。',
    code: r'''
return isPoster != 'true' && hasApplied != 'true' && status == 'open';
''',
  );

  app.customFunction(
    'workPostTypeLabel',
    args: {'type': string},
    returns: string,
    description: 'work_postsのtype値を日本語表示ラベルに変換する。',
    code: r'''
switch (type) {
  case 'partner_recruit':
    return 'グループお誘い';
  case 'security':
    return '警備スタッフ';
  case 'transport':
    return '送迎スタッフ';
  default:
    return type ?? '';
}
''',
  );

  app.customFunction(
    'workPostStatusLabel',
    args: {'status': string},
    returns: string,
    description: 'work_postsのstatus値を日本語表示ラベルに変換する。',
    code: r'''
switch (status) {
  case 'open':
    return '募集中';
  case 'filled':
    return '選定済み';
  case 'closed':
    return '終了';
  default:
    return status ?? '';
}
''',
  );

  final workTypeLabelFn = app.customFunction(
    'workTypeLabel',
    args: {'gender': string},
    returns: string,
    description: '性別からワーク種別表示（イコッチャガールズ／ボーイズ）を判定する。',
    code: r'''
return gender == '女性' ? 'イコッチャガールズ' : 'イコッチャボーイズ';
''',
  );

  final staffTypeToJapaneseFn = app.customFunction(
    'staffTypeToJapanese',
    args: {'staffType': string},
    returns: string,
    description: 'staff_type値（none/security/transport/both）を日本語表示に変換する。',
    code: r'''
switch (staffType) {
  case 'security':
    return '警備';
  case 'transport':
    return '送迎';
  case 'both':
    return '両方';
  default:
    return 'なし';
}
''',
  );

  final staffTypeToEnglishFn = app.customFunction(
    'staffTypeToEnglish',
    args: {'japanese': string},
    returns: string,
    description: '日本語表示ラベルをstaff_type値（none/security/transport/both）に変換する。',
    code: r'''
switch (japanese) {
  case '警備':
    return 'security';
  case '送迎':
    return 'transport';
  case '両方':
    return 'both';
  default:
    return 'none';
}
''',
  );

  final countOpenPostsByTypeFn = app.customFunction(
    'countOpenPostsByType',
    args: {'posts': listOf(string), 'type': string},
    returns: string,
    description: '|||区切りのwork_postsリストから指定typeの件数を数える。',
    code: r'''
final list = posts ?? <String>[];
final target = type ?? '';
int count = 0;
for (final p in list) {
  final parts = p.split('|||');
  if (parts.isNotEmpty && parts[1] == target) count++;
}
return count.toString();
''',
  );

  app.customFunction(
    'appendOpenCountLabel',
    args: {'original': string, 'count': string},
    returns: string,
    description: '案内文に「（現在N件募集中）」を付加する。',
    code: r'''
return '${original ?? ''}（現在${count ?? '0'}件募集中）';
''',
  );

  // `fetchMyWorkSettings` — FIX (found during the "review everything" audit
  // pass): same anti-pattern as `fetchWalletLedgerHistory` above - a LIVE
  // declaration co-existing with a LATER `updateCustomAction` call for the
  // same name (MyWorkContent section, below). Content still matched at
  // audit time (not currently broken), but commented out per the same
  // established, proven-safe pattern rather than left live and manually
  // kept in sync. The `updateCustomAction(name: 'fetchMyWorkSettings', ...)`
  // call (MyWorkContent section) is now the only source of truth.
  //   app.customAction(
  //     'fetchMyWorkSettings',
  //     returns: string,
  //     description: '自分のgender/staff_type/account_typeを取得する（マイワーク画面用）。',
  //     code: r'''...(see updateCustomAction call below for real code)...''',
  //   );

  app.customAction(
    'callUpdateStaffType',
    args: {'staffType': string},
    returns: bool_,
    description: 'updateProfile Cloud Functionを呼び出し、staff_typeのみ更新する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callUpdateStaffType(String? staffType) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('updateProfile');
    final result = await callable.call({'staff_type': staffType ?? 'none'});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'fetchWorkPostsList',
    returns: listOf(string),
    description: 'fetchWorkPosts Cloud Functionを呼び出し、募集中のワーク投稿一覧を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchWorkPostsList() async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('fetchWorkPosts');
    final result = await callable.call({});
    if (result.data is! Map || result.data['posts'] is! List) return <String>[];
    final posts = result.data['posts'] as List;
    return posts.map((raw) {
      final m = raw as Map;
      final id = m['id']?.toString() ?? '';
      final type = m['type']?.toString() ?? '';
      final description = (m['description']?.toString() ?? '').replaceAll('|||', '');
      var dateLabel = '';
      final ts = m['date'];
      if (ts is Map && ts['_seconds'] != null) {
        final dt = DateTime.fromMillisecondsSinceEpoch((ts['_seconds'] as int) * 1000);
        dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
      }
      final location = (m['location']?.toString() ?? '').replaceAll('|||', '');
      final fee = m['fee']?.toString() ?? '0';
      final applicantsCount = (m['applicants'] is List) ? (m['applicants'] as List).length.toString() : '0';
      final posterNickname = (m['poster_nickname']?.toString() ?? '').replaceAll('|||', '');
      return '$id|||$type|||$description|||$dateLabel|||$location|||$fee|||$applicantsCount|||$posterNickname';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'fetchWorkPostDetailData',
    args: {'postId': string},
    returns: string,
    description: 'getWorkPostDetail Cloud Functionを呼び出し、ワーク投稿の詳細を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> fetchWorkPostDetailData(String? postId) async {
  try {
    final pid = postId ?? '';
    if (pid.isEmpty) return '';
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getWorkPostDetail');
    final result = await callable.call({'post_id': pid});
    if (result.data is! Map) return '';
    final d = result.data as Map;
    final post = d['post'] as Map? ?? {};
    final type = post['type']?.toString() ?? '';
    final description = (post['description']?.toString() ?? '').replaceAll('|||', '');
    var dateLabel = '';
    final ts = post['date'];
    if (ts is Map && ts['_seconds'] != null) {
      final dt = DateTime.fromMillisecondsSinceEpoch((ts['_seconds'] as int) * 1000);
      dateLabel = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
    }
    final location = (post['location']?.toString() ?? '').replaceAll('|||', '');
    final fee = post['fee']?.toString() ?? '0';
    final status = post['status']?.toString() ?? '';
    final posterNickname = (d['poster_nickname']?.toString() ?? '').replaceAll('|||', '');
    final isPoster = (d['is_poster'] == true).toString();
    final hasApplied = (d['has_applied'] == true).toString();
    return '$type|||$description|||$dateLabel|||$location|||$fee|||$status|||$posterNickname|||$isPoster|||$hasApplied';
  } catch (e) {
    return '';
  }
}
''',
  );

  app.customAction(
    'fetchWorkPostApplicantsList',
    args: {'postId': string},
    returns: listOf(string),
    description: 'getWorkPostDetail Cloud Functionを呼び出し、応募者一覧（自分が投稿者の場合のみ非空）を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> fetchWorkPostApplicantsList(String? postId) async {
  try {
    final pid = postId ?? '';
    if (pid.isEmpty) return <String>[];
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getWorkPostDetail');
    final result = await callable.call({'post_id': pid});
    if (result.data is! Map || result.data['applicants_resolved'] is! List) return <String>[];
    final applicants = result.data['applicants_resolved'] as List;
    return applicants.map((raw) {
      final m = raw as Map;
      final id = m['id']?.toString() ?? '';
      final nickname = (m['nickname']?.toString() ?? '').replaceAll('|||', '');
      return '$id|||$nickname';
    }).toList();
  } catch (e) {
    return <String>[];
  }
}
''',
  );

  app.customAction(
    'callApplyToWorkPost',
    args: {'postId': string},
    returns: bool_,
    description: 'applyToWorkPost Cloud Functionを呼び出し、ワーク投稿に応募する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callApplyToWorkPost(String? postId) async {
  try {
    final pid = postId ?? '';
    if (pid.isEmpty) return false;
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('applyToWorkPost');
    final result = await callable.call({'post_id': pid});
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.customAction(
    'callSelectWorkApplicant',
    args: {'postId': string, 'applicantId': string},
    returns: string,
    description: 'selectWorkApplicant Cloud Functionを呼び出し、応募者を選定する。成功時はchat_room_id（無ければ空文字）、失敗時は"error"を返す。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String> callSelectWorkApplicant(String? postId, String? applicantId) async {
  try {
    final pid = postId ?? '';
    final aid = applicantId ?? '';
    if (pid.isEmpty || aid.isEmpty) return 'error';
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('selectWorkApplicant');
    final result = await callable.call({'post_id': pid, 'applicant_id': aid});
    if (result.data is! Map || result.data['success'] != true) return 'error';
    return result.data['chat_room_id']?.toString() ?? '';
  } catch (e) {
    return 'error';
  }
}
''',
  );

  // -- WorkPage: wire the job feed (was 4 static fake cards) to real
  // work_posts data, and append real open-post counts to the security/
  // transport category cards (see the long comment above for why the
  // girls/boys cards are left as static marketing copy).
  app.editPageState(ff.Pages.workPage, (state) {
    state.ensureField('workPostsList', listOf(string));
    state.ensureField('securityOpenCount', string.withDefault('0'));
    state.ensureField('transportOpenCount', string.withDefault('0'));
  });

  app.editPageOnLoad(ff.Pages.workPage, [
    CallCustomAction.named('fetchWorkPostsList', outputAs: 'workPostsResult'),
    SetState('workPostsList', ActionOutput('workPostsResult')),
    SetState(
      'securityOpenCount',
      CustomFunction(countOpenPostsByTypeFn, args: {'posts': ActionOutput('workPostsResult'), 'type': 'security'}),
    ),
    SetState(
      'transportOpenCount',
      CustomFunction(countOpenPostsByTypeFn, args: {'posts': ActionOutput('workPostsResult'), 'type': 'transport'}),
    ),
  ]);

  // FROZEN (2026-08-12, immediately after this exact push landed): all 3
  // ensureReplaced calls below are one-shot and CONFIRMED LANDED —
  // verified directly in generated_code/lib/work/work_page/work_page_widget.dart
  // (WorkPostsListView is bound to _model.workPostsList, both category
  // texts call functions.appendOpenCountLabel). Any future change to
  // these widgets must go through app.editPage(ff.Pages.workPage, ...)
  // targeting the NEW keys/names instead.
  //   app.editPage(ff.Pages.workPage, (page) {
  //     page.ensureReplaced(
  //       page.findByKey('ListView_x0fx9vsg'),
  //       Expanded(
  //         ListView(
  //           name: 'WorkPostsListView',
  //           spacing: 8,
  //           source: State('workPostsList'),
  //           itemBuilder: (item) => Card(
  //             name: 'WorkPostCard',
  //             child: Container(
  //               padding: 12,
  //               child: Column(
  //                 crossAxis: CrossAxis.start,
  //                 spacing: 4,
  //                 children: [
  //                   Text(
  //                     CustomFunction(workPostTypeLabelFn, args: {'type': CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})}),
  //                     style: Styles.titleSmall,
  //                   ),
  //                   Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 2})),
  //                   Row(
  //                     mainAxis: MainAxis.spaceBetween,
  //                     children: [
  //                       Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 4})),
  //                       Text(CustomFunction(formatYenFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': item, 'index': 5})})),
  //                     ],
  //                   ),
  //                   Button(
  //                     '詳細を見る',
  //                     variant: ButtonVariant.outlined,
  //                     onTap: [
  //                       Navigate('WorkPostDetailPage', params: {'postId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0})}),
  //                     ],
  //                   ),
  //                 ],
  //               ),
  //             ),
  //           ),
  //         ),
  //         name: 'WorkPostsExpanded',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_sq4cst7x'),
  //       Text(
  //         CustomFunction(appendOpenCountLabelFn, args: {
  //           'original': 'セキュリティ要員は、イコッチャガールズ＆ボーイズの方で、空いた暇な時間をセキュリティ要因として兼務出来る方です！',
  //           'count': State('securityOpenCount'),
  //         }),
  //         name: 'SecurityCategoryText',
  //       ),
  //     );
  //     page.ensureReplaced(
  //       page.findByKey('Text_2o0nz3aj'),
  //       Text(
  //         CustomFunction(appendOpenCountLabelFn, args: {
  //           'original': '送迎要員は、イコッチャガールズ＆ボーイズの方で、空いた暇な時間を送迎要因として兼務出来る方です！',
  //           'count': State('transportOpenCount'),
  //         }),
  //         name: 'TransportCategoryText',
  //       ),
  //     );
  //   });

  // FROZEN (2026-08-12, immediately after this exact push landed):
  // MyWorkContent and WorkPostDetailPage now exist — confirmed via
  // generated_code/lib/my_work_content/ and
  // generated_code/lib/work_post_detail_page/, both re-validated-but-inert
  // on every subsequent compile, same precedent as every other
  // ensurePage'd page this session. Any future change to either page must
  // go through app.editPage(ff.Pages.myWorkContent, ...) /
  // app.editPage(ff.Pages.workPostDetailPage, ...) instead.
  //   app.ensurePage(
  //     'MyWorkContent',
  //     route: '/my-work-content',
  //     description: 'マイワーク画面（ユーザー種別・ワーク種別の表示、スタッフ兼務設定の変更）。',
  //     state: {
  //       'myGender': string.withDefault(''),
  //       'staffTypeDisplay': string.withDefault('なし'),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('fetchMyWorkSettings', outputAs: 'settingsResult'),
  //       SetState('myGender', CustomFunction(splitFieldFn, args: {'data': ActionOutput('settingsResult'), 'index': 0})),
  //       SetState(
  //         'staffTypeDisplay',
  //         CustomFunction(staffTypeToJapaneseFn, args: {'staffType': CustomFunction(splitFieldFn, args: {'data': ActionOutput('settingsResult'), 'index': 1})}),
  //       ),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'マイワーク'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 16,
  //         children: [
  //           Text('ユーザー種別', style: Styles.labelSmall),
  //           Text('キャスト', style: Styles.titleSmall),
  //           Divider(),
  //           Text('ワーク種別', style: Styles.labelSmall),
  //           Text(CustomFunction(workTypeLabelFn, args: {'gender': State('myGender')}), style: Styles.titleSmall),
  //           Divider(),
  //           Text('スタッフ兼務設定', style: Styles.labelSmall),
  //           Dropdown(
  //             options: const ['なし', '警備', '送迎', '両方'],
  //             label: '兼務',
  //             value: State('staffTypeDisplay'),
  //             onChanged: SetState('staffTypeDisplay', const WidgetValue()),
  //           ),
  //           Button(
  //             '保存する',
  //             onTap: [
  //               CallCustomAction.named(
  //                 'callUpdateStaffType',
  //                 arguments: {'staffType': CustomFunction(staffTypeToEnglishFn, args: {'japanese': State('staffTypeDisplay')})},
  //                 outputAs: 'updateResult',
  //               ),
  //               If(
  //                 ActionOutput('updateResult'),
  //                 then: [Snackbar('更新しました。')],
  //                 orElse: [Snackbar('更新に失敗しました。')],
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  //   app.ensurePage(
  //     'WorkPostDetailPage',
  //     route: '/work-post-detail',
  //     description: 'ワーク投稿詳細ページ（応募、または投稿者による応募者選定）。',
  //     params: {
  //       'postId': string.withDefault(''),
  //     },
  //     state: {
  //       'detailData': string.withDefault(''),
  //       'applicantsList': listOf(string),
  //     },
  //     onLoad: [
  //       CallCustomAction.named('fetchWorkPostDetailData', arguments: {'postId': Param('postId')}, outputAs: 'detailResult'),
  //       SetState('detailData', ActionOutput('detailResult')),
  //       CallCustomAction.named('fetchWorkPostApplicantsList', arguments: {'postId': Param('postId')}, outputAs: 'applicantsResult'),
  //       SetState('applicantsList', ActionOutput('applicantsResult')),
  //     ],
  //     body: Scaffold(
  //       appBar: AppBar(title: 'ワーク詳細'),
  //       body: Column(
  //         padding: 16,
  //         spacing: 12,
  //         children: [
  //           Text(
  //             CustomFunction(workPostTypeLabelFn, args: {'type': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 0})}),
  //             style: Styles.titleMedium,
  //           ),
  //           Text(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 1})),
  //           Row(
  //             children: [
  //               Text('日付：'),
  //               Text(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 2})),
  //             ],
  //           ),
  //           Row(
  //             children: [
  //               Text('場所：'),
  //               Text(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 3})),
  //             ],
  //           ),
  //           Row(
  //             children: [
  //               Text('報酬：'),
  //               Text(CustomFunction(formatYenFn, args: {'amount': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 4})})),
  //             ],
  //           ),
  //           Row(
  //             children: [
  //               Text('状態：'),
  //               Text(CustomFunction(workPostStatusLabelFn, args: {'status': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 5})})),
  //             ],
  //           ),
  //           Row(
  //             children: [
  //               Text('投稿者：'),
  //               Text(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 6})),
  //             ],
  //           ),
  //           Divider(),
  //           Button(
  //             '応募する',
  //             visible: CustomFunction(canApplyToWorkPostFn, args: {
  //               'isPoster': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 7}),
  //               'hasApplied': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 8}),
  //               'status': CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 5}),
  //             }),
  //             onTap: [
  //               CallCustomAction.named('callApplyToWorkPost', arguments: {'postId': Param('postId')}, outputAs: 'applyResult'),
  //               If(
  //                 ActionOutput('applyResult'),
  //                 then: [Snackbar('応募しました。')],
  //                 orElse: [Snackbar('応募に失敗しました。')],
  //               ),
  //             ],
  //           ),
  //           Text(
  //             '応募済みです。',
  //             visible: Equals(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 8}), 'true'),
  //           ),
  //           Text(
  //             '応募者一覧',
  //             style: Styles.titleSmall,
  //             visible: Equals(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 7}), 'true'),
  //           ),
  //           Expanded(
  //             ListView(
  //               name: 'WorkPostApplicantsListView',
  //               spacing: 8,
  //               visible: Equals(CustomFunction(splitFieldFn, args: {'data': State('detailData'), 'index': 7}), 'true'),
  //               source: State('applicantsList'),
  //               itemBuilder: (item) => Row(
  //                 mainAxis: MainAxis.spaceBetween,
  //                 children: [
  //                   Text(CustomFunction(splitFieldFn, args: {'data': item, 'index': 1})),
  //                   Button(
  //                     '選定する',
  //                     variant: ButtonVariant.outlined,
  //                     onTap: [
  //                       CallCustomAction.named(
  //                         'callSelectWorkApplicant',
  //                         arguments: {
  //                           'postId': Param('postId'),
  //                           'applicantId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //                         },
  //                         outputAs: 'selectResult',
  //                       ),
  //                       If(
  //                         Not(Equals(ActionOutput('selectResult'), 'error')),
  //                         then: [
  //                           Snackbar('選定しました。'),
  //                           CallCustomAction.named('fetchWorkPostDetailData', arguments: {'postId': Param('postId')}, outputAs: 'detailRefetchResult'),
  //                           SetState('detailData', ActionOutput('detailRefetchResult')),
  //                         ],
  //                         orElse: [Snackbar('選定に失敗しました。')],
  //                       ),
  //                     ],
  //                   ),
  //                 ],
  //               ),
  //             ),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );

  // ==========================================================================
  // Phase 10 review-pass fix (2026-08-12): two real gaps found reviewing
  // this phase's own just-completed work.
  //   1. MyWorkContent was built but nothing anywhere navigates to it —
  //      confirmed by re-reading WorkPage's own AppBar/body, which never
  //      references it. A page that exists but is unreachable from any
  //      real UI path is effectively dead code from the user's
  //      perspective. Fixed by adding a nav icon to WorkPage's AppBar.
  //   2. MyWorkContent has no account_type gate at all — it hardcodes
  //      "キャスト" as a label and exposes a functional staff_type editor
  //      to ANY signed-in user, including guests, since WorkPage itself
  //      (the new entry point) is one of the 5 universal bottom-nav tabs,
  //      not cast-scoped. Fixed the same way every other role-gated page
  //      this session does (AdminReportReviewPage, AdminAffiliateManagement):
  //      compute isCast on load, gate the real content behind it, show a
  //      permission message otherwise.
  //
  // `fetchMyWorkSettings` is already live (deployed in the prior push) —
  // per this project's own two-part update-sequencing rule, its `code:`
  // is changed here via `updateCustomAction` (app.raw), NOT by editing the
  // `app.customAction` declaration above directly, which would fail
  // idempotency since the declaration's payload would then mismatch
  // what's currently live. The original declaration is intentionally left
  // unsynced for now — sync it in a LATER, separate push once this one is
  // confirmed live, per the same established rule.
  // ==========================================================================

  app.raw((project) {
    updateCustomAction(
      project,
      name: 'fetchMyWorkSettings',
      code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';
import '/auth/firebase_auth/auth_util.dart';

Future<String> fetchMyWorkSettings() async {
  try {
    final uid = currentUserUid;
    if (uid.isEmpty) return '|||none|||';
    final doc = await FirebaseFirestore.instance.collection('users').doc(uid).get();
    final data = doc.data();
    if (data == null) return '|||none|||';
    final gender = (data['gender']?.toString() ?? '').replaceAll('|||', '');
    final staffType = (data['staff_type']?.toString() ?? 'none').replaceAll('|||', '');
    final accountType = (data['account_type']?.toString() ?? '').replaceAll('|||', '');
    return '$gender|||$staffType|||$accountType';
  } catch (e) {
    return '|||none|||';
  }
}
''',
    );
  });

  app.editPageState(ff.Pages.myWorkContent, (state) {
    state.ensureField('isCast', bool_.withDefault(false));
  });

  app.editPageOnLoad(ff.Pages.myWorkContent, [
    CallCustomAction.named('fetchMyWorkSettings', outputAs: 'settingsResult'),
    SetState(ff.Pages.myWorkContent.state.myGender, CustomFunction(splitFieldFn, args: {'data': ActionOutput('settingsResult'), 'index': 0})),
    SetState(
      ff.Pages.myWorkContent.state.staffTypeDisplay,
      CustomFunction(staffTypeToJapaneseFn, args: {'staffType': CustomFunction(splitFieldFn, args: {'data': ActionOutput('settingsResult'), 'index': 1})}),
    ),
    SetState(
      'isCast',
      Equals(CustomFunction(splitFieldFn, args: {'data': ActionOutput('settingsResult'), 'index': 2}), 'cast'),
    ),
  ]);

  // `patch.visible(...)` (the lighter-weight per-widget patch path) only
  // accepts a LITERAL bool, not a dynamic expression — confirmed by
  // compile error, not assumed. Gating 9 existing widgets individually
  // that way isn't possible; consolidated into one ensureReplaced on the
  // body's root Column instead, replicating every original binding
  // (myGender/staffTypeDisplay, the dropdown, the save button's onTap)
  // exactly as the first push landed them, plus the new isCast gate and
  // a permission message for non-casts.
  //
  // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
  // generated_code — `ensureReplaced` has no dedup guard, so leaving this
  // live risked reassigning fresh keys to the whole subtree on every
  // future unrelated push. Commented out per the established freeze
  // discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md).
  // app.editPage(ff.Pages.myWorkContent, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Column_q4wl133v'),
  //     Column(
  //       name: 'MyWorkContentBody',
  //       padding: 16,
  //       spacing: 16,
  //       children: [
  //         Text(
  //           'この画面はキャスト専用です。',
  //           style: Styles.bodyMedium,
  //           visible: Equals(State('isCast'), false),
  //         ),
  //         Text('ユーザー種別', style: Styles.labelSmall, visible: State('isCast')),
  //         Text('キャスト', style: Styles.titleSmall, visible: State('isCast')),
  //         Divider(visible: State('isCast')),
  //         Text('ワーク種別', style: Styles.labelSmall, visible: State('isCast')),
  //         Text(
  //           CustomFunction(workTypeLabelFn, args: {'gender': State(ff.Pages.myWorkContent.state.myGender)}),
  //           style: Styles.titleSmall,
  //           visible: State('isCast'),
  //         ),
  //         Divider(visible: State('isCast')),
  //         Text('スタッフ兼務設定', style: Styles.labelSmall, visible: State('isCast')),
  //         Dropdown(
  //           options: const ['なし', '警備', '送迎', '両方'],
  //           label: '兼務',
  //           value: State(ff.Pages.myWorkContent.state.staffTypeDisplay),
  //           onChanged: SetState(ff.Pages.myWorkContent.state.staffTypeDisplay, const WidgetValue()),
  //           visible: State('isCast'),
  //         ),
  //         Button(
  //           '保存する',
  //           visible: State('isCast'),
  //           onTap: [
  //             CallCustomAction.named(
  //               'callUpdateStaffType',
  //               arguments: {'staffType': CustomFunction(staffTypeToEnglishFn, args: {'japanese': State(ff.Pages.myWorkContent.state.staffTypeDisplay)})},
  //               outputAs: 'updateResult',
  //             ),
  //             If(
  //               ActionOutput('updateResult'),
  //               then: [Snackbar('更新しました。')],
  //               orElse: [Snackbar('更新に失敗しました。')],
  //             ),
  //           ],
  //         ),
  //       ],
  //     ),
  //   );
  // });

  // WorkPage's AppBar gets a 3rd nav icon (お知らせ/フィルタ already exist,
  // both still unwired — out of this phase's scope to wire, disclosed not
  // touched). Left unconditionally visible (not account_type-gated at
  // this entry point) since MyWorkContent's own page-level gate above is
  // the actual safety boundary — a guest tapping this sees the permission
  // message, not a broken screen.
  // FROZEN (2026-08-12, comprehensive review pass): confirmed landed —
  // `MyWorkNavButton` exists in lib/flutterflow_project/pages/work_page.dart.
  // `ensureInsertedAfter` is one-shot; the anchor key `Column_2vfi0lu6`
  // still exists, so a rerun would silently no-op, but any future EDIT to
  // this button would be silently ignored the same way. Any future change
  // must go through `app.editPage(ff.Pages.workPage, ...)` targeting its
  // real widget key instead.
  // app.editPage(ff.Pages.workPage, (page) {
  //   page.ensureInsertedAfter(
  //     page.findByKey('Column_2vfi0lu6'),
  //     Button(
  //       'マイワーク',
  //       variant: ButtonVariant.text,
  //       name: 'MyWorkNavButton',
  //       onTap: [Navigate('MyWorkContent')],
  //     ),
  //   );
  // });

  // ==========================================================================
  // Phase 10 follow-up — the reservation-creation client UI never had a
  // way to request staff at all (§47's own disclosed gap in
  // PROJECT_KNOWLEDGE.md, confirmed by reading `callCreateReservation`
  // directly — it only ever sent a single cast_id, never staff_selections).
  //
  // Redesigned rather than wiring the earlier staff_selections (direct
  // staff-ID) param: there is no staff-browsing/discovery UI anywhere in
  // this app for a guest to obtain a specific staff_id, and building one
  // would be a much larger, separate feature. security_staff_fee/
  // transport_staff_fee are FLAT, role-level config values (not
  // per-individual), so the fee is fully determined by role alone —
  // added `needs_security`/`needs_transport` checkboxes instead (mirrors
  // the already-proven group_invite pattern exactly): guest flags the
  // role, fee is correctly included in total_amount/authorization at
  // booking time, and once the cast accepts, the backend auto-creates a
  // "security"/"transport" work_posts entry tied to the reservation
  // (reservations.ts, mirrors the existing group_invite→partner_recruit
  // auto-post exactly) for staff to apply to via the already-built
  // applyToWorkPost/selectWorkApplicant (work-posts.ts) — selecting an
  // applicant now also appends them to the reservation's own staff_ids,
  // completing the loop back to the fee split
  // (recordCastRewardsAndProcessOthers, stripe-payments.ts, untouched).
  // staff_selections (direct ID) is left in the backend, unused by any
  // client today but available if a future "invite a specific staff
  // member directly" feature is built — no removal needed, it doesn't
  // conflict with this flag-based path.
  // ==========================================================================

  app.raw((project) {
    _addField(
      project,
      'reservations',
      'needs_security',
      _bool_,
      description: '予約作成時にゲストが警備スタッフを希望したか。',
    );
    _addField(
      project,
      'reservations',
      'needs_transport',
      _bool_,
      description: '予約作成時にゲストが送迎スタッフを希望したか。',
    );
  });

  app.editPageState(ff.Pages.reservationForm, (state) {
    state.ensureField('resNeedsSecurity', bool_.withDefault(false));
    state.ensureField('resNeedsTransport', bool_.withDefault(false));
  });

  // `callCreateReservation` is already live (deployed in an earlier
  // phase) — per this project's own two-part update-sequencing rule, its
  // `code:` is changed here via `updateCustomAction` (app.raw), not by
  // editing the `app.customAction` declaration directly, which would fail
  // idempotency since the declaration's payload would then mismatch
  // what's currently live. The original declaration is intentionally left
  // unsynced for now — sync it in a LATER, separate push once this one is
  // confirmed live, matching the same rule applied earlier this session
  // for formatYen/fetchWalletLedgerHistory/fetchMyWorkSettings.
  // Sidestepped updateCustomAction's `arguments:` (List<FFParameter>) path
  // entirely after it produced a confusing, total validation failure
  // ("argument X is not specified" for ALL 14 params, not just the 2 new
  // ones — inconsistent with a simple per-param mismatch, root cause not
  // fully diagnosed). Rather than keep fighting an unclear compiler
  // interaction, declared a NEW custom action instead of mutating the
  // existing `callCreateReservation` — sidesteps the whole update-
  // sequencing class of problem, using the same `app.customAction` +
  // `CallCustomAction.named` mechanism proven reliable everywhere else
  // this entire session. `callCreateReservation` itself is left
  // untouched and unused (harmless dead code, disclosed) — the
  // ReservationForm submit button is rewired to this new action below.
  app.customAction(
    'callCreateReservationWithStaff',
    args: {
      'castId': string,
      'date': string,
      'startTime': string,
      'timeSlot': string,
      'durationLabel': string,
      'meetingAddress': string,
      'meetingPoint': string,
      'groupInvite': bool_,
      'groupSizeLabel': string,
      'purpose': string,
      'details': string,
      'baseAmount': string,
      'needsSecurity': bool_,
      'needsTransport': bool_,
    },
    returns: string,
    description: 'createReservation Cloud Functionを呼び出し予約を作成する（警備・送迎スタッフ希望フラグ対応版）。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<String?> callCreateReservationWithStaff(
  String? castId,
  String? date,
  String? startTime,
  String? timeSlot,
  String? durationLabel,
  String? meetingAddress,
  String? meetingPoint,
  bool? groupInvite,
  String? groupSizeLabel,
  String? purpose,
  String? details,
  String? baseAmount,
  bool? needsSecurity,
  bool? needsTransport,
) async {
  try {
    if (castId == null || castId.isEmpty) return null;
    final durationMinutes =
        int.tryParse(RegExp(r'\d+').firstMatch(durationLabel ?? '')?.group(0) ?? '') ?? 60;
    final groupSize = int.tryParse(groupSizeLabel ?? '') ?? 0;
    final amount = int.tryParse(baseAmount ?? '') ?? 0;
    final isoDateTime = '${date}T${(startTime == null || startTime.isEmpty) ? '19:00' : startTime}:00';
    final fullDetails = (purpose == null || purpose.isEmpty)
        ? (details ?? '')
        : '【目的：$purpose】\n${details ?? ''}';

    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('createReservation');
    final result = await callable.call({
      'cast_ids': [castId],
      'date': isoDateTime,
      'time_slot': timeSlot ?? '',
      'duration_minutes': durationMinutes,
      'location': meetingAddress ?? '',
      'meeting_point': meetingPoint ?? '',
      'group_invite': groupInvite ?? false,
      'group_size': groupSize,
      'details': fullDetails,
      'base_amount': amount,
      'needs_security': needsSecurity ?? false,
      'needs_transport': needsTransport ?? false,
    });
    if (result.data is Map && result.data['res_id'] != null) {
      return result.data['res_id'] as String;
    }
    return null;
  } catch (e) {
    return null;
  }
}
''',
  );

  // FROZEN (2026-08-12, immediately after this exact push landed): both
  // ensureInsertedAfter calls below are one-shot and CONFIRMED LANDED —
  // verified directly in generated_code (ResNeedsSecurityCheckbox/
  // ResNeedsTransportCheckbox both present and bound). The submit
  // button's own action-chain fix (adding needsSecurity/needsTransport,
  // switching to callCreateReservationWithStaff) is NOT here — it turned
  // out re-issuing ensureActions on this button from a SEPARATE, LATER
  // app.editPage(ff.Pages.reservationForm, ...) block than the page's
  // ORIGINAL wiring did not take effect (confirmed via generated_code
  // still showing the old action after a clean push — root cause not
  // fully diagnosed, possibly an ordering/precedence interaction between
  // multiple editPage calls touching the same trigger across a script,
  // not just within one). Fixed by editing the ORIGINAL block directly
  // instead (near `checkReservationFieldsComplete`, this file's very
  // first ReservationForm section) rather than adding a second one here.
  //   app.editPage(ff.Pages.reservationForm, (page) {
  //     page.ensureInsertedAfter(
  //       page.findByKey('Row_y5dnah05'), // グループお誘い希望人数 row
  //       Row(
  //         children: [
  //           Column(
  //             children: [
  //               Text('警備スタッフを希望する'),
  //               Checkbox(
  //                 name: 'ResNeedsSecurityCheckbox',
  //                 value: State('resNeedsSecurity'),
  //                 onChanged: SetState('resNeedsSecurity', const WidgetValue()),
  //               ),
  //             ],
  //           ),
  //         ],
  //         name: 'ResNeedsSecurityRow',
  //       ),
  //     );
  //     page.ensureInsertedAfter(
  //       page.findByKey('Row_y5dnah05'),
  //       Row(
  //         children: [
  //           Column(
  //             children: [
  //               Text('送迎スタッフを希望する'),
  //               Checkbox(
  //                 name: 'ResNeedsTransportCheckbox',
  //                 value: State('resNeedsTransport'),
  //                 onChanged: SetState('resNeedsTransport', const WidgetValue()),
  //               ),
  //             ],
  //           ),
  //         ],
  //         name: 'ResNeedsTransportRow',
  //       ),
  //     );
  //   });

  // ==========================================================================
  // Dedicated error-resolution phase (2026-08-12): full-project audit found
  // `payment_confirm.dart` was reachable-in-appearance only — its submit
  // button chain (getPaymentClientSecret -> confirmStripePayment ->
  // isPaymentSuccess) was already correctly wired, but NOTHING in the app
  // ever navigated to this page (ReservationForm went straight to
  // ReservationConfirmed, fixed above at this file's ORIGINAL
  // ReservationForm/PaymentConfirm sections — see the FIX comments there),
  // and its 5 price/date/location fields were still the literal FlutterFlow
  // placeholder "Hello World" text, never wired to real reservation data.
  // This section closes the data half of that gap: one Firestore read on
  // load (matching the exact same established pattern as
  // `fetchReservationSummary`/reservation_confirmed.dart), delimited string
  // encoding, `splitFieldFn` (already declared above, this file's shared
  // chat/notifications/matcha-list helper) extracts each field for display.
  // ==========================================================================

  app.editPageState(ff.Pages.paymentConfirm, (state) {
    state.ensureField('paymentConfirmData', string.withDefault(''));
  });

  app.customAction(
    'fetchPaymentConfirmDetails',
    args: {'resId': string},
    returns: string,
    description: '予約の日時・場所・料金内訳を取得し、決済確認画面表示用データを返す。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';

Future<String?> fetchPaymentConfirmDetails(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return '';
    final doc = await FirebaseFirestore.instance
        .collection('reservations')
        .doc(resId)
        .get();
    final data = doc.data();
    if (data == null) return '';
    final rawDate = data['date'];
    var dateLabel = '';
    if (rawDate is Timestamp) {
      final d = rawDate.toDate();
      dateLabel =
          '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} '
          '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    final location = (data['location']?.toString() ?? '').replaceAll('|||', '');
    final baseAmount = (data['base_amount'] as num?)?.toInt() ?? 0;
    final transportFee = (data['transport_fee'] as num?)?.toInt() ?? 0;
    final staffFee = (data['staff_fee'] as num?)?.toInt() ?? 0;
    final totalAmount = (data['total_amount'] as num?)?.toInt() ??
        (baseAmount + transportFee + staffFee);
    return '$dateLabel|||$location|||$baseAmount|||$transportFee|||$totalAmount';
  } catch (e) {
    return '';
  }
}
''',
  );

  app.editPage(ff.Pages.paymentConfirm, (page) {
    // Root had zero existing triggerActions (confirmed via the typed SDK —
    // the only trigger on this page at all was the submit button's ON_TAP,
    // already wired natively before this session).
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchPaymentConfirmDetails',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'paymentDetailsResult',
        ),
        SetState('paymentConfirmData', ActionOutput('paymentDetailsResult')),
      ],
    );

    // Five literal "Hello World" placeholders, replaced in place (each
    // widget's own existing position/parent untouched — only the widget
    // itself is reconstructed) rather than rebuilding their parent
    // Row/Column, since none of these need a structural change, just a
    // dynamic text source. `maxLines`/`overflow` added per this project's
    // Design & Quality Rule for the two free-text-derived fields (date is
    // a fixed-format string built by the action above, near-zero overflow
    // risk, but treated consistently with location for defense against a
    // future format change).
    //
    // Frozen (comprehensive review pass, 2026-08-12): all 5 confirmed
    // landed via generated_code — `ensureReplaced` has no dedup guard, so
    // leaving any live risked reassigning fresh keys to that Text node on
    // every future unrelated push. Commented out per the established
    // freeze discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md); the
    // `ensureActions` call above stays live (genuinely idempotent, not
    // one-shot).
    // page.ensureReplaced(
    //   page.findByKey('Text_meoqolci'), // 日付・時間帯
    //   Text(
    //     CustomFunction(splitFieldFn, args: {'data': State('paymentConfirmData'), 'index': 0}),
    //     name: 'PaymentConfirmDateValue',
    //     maxLines: 1,
    //     overflow: TextOverflow.ellipsis,
    //   ),
    // );
    // page.ensureReplaced(
    //   page.findByKey('Text_3707uyag'), // 場所
    //   Text(
    //     CustomFunction(splitFieldFn, args: {'data': State('paymentConfirmData'), 'index': 1}),
    //     name: 'PaymentConfirmLocationValue',
    //     maxLines: 2,
    //     overflow: TextOverflow.ellipsis,
    //   ),
    // );
    // page.ensureReplaced(
    //   page.findByKey('Text_bh31jlw1'), // 基本料金（数値、"円" は別ウィジェット）
    //   Text(
    //     CustomFunction(splitFieldFn, args: {'data': State('paymentConfirmData'), 'index': 2}),
    //     name: 'PaymentConfirmBaseAmountValue',
    //   ),
    // );
    // page.ensureReplaced(
    //   page.findByKey('Text_v6wit9ks'), // タクシー代（数値、"円" は別ウィジェット）
    //   Text(
    //     CustomFunction(splitFieldFn, args: {'data': State('paymentConfirmData'), 'index': 3}),
    //     name: 'PaymentConfirmTransportFeeValue',
    //   ),
    // );
    // page.ensureReplaced(
    //   page.findByKey('Text_7m2mnl3y'), // 合計（数値、"円" は別ウィジェット）
    //   Text(
    //     CustomFunction(splitFieldFn, args: {'data': State('paymentConfirmData'), 'index': 4}),
    //     name: 'PaymentConfirmTotalAmountValue',
    //   ),
    // );
  });

  // ==========================================================================
  // kyc.dart: the ID-document/selfie upload cards each had a third,
  // undisclosed "Hello World" placeholder line beneath their real
  // description text (found during the same audit pass — not one of the 5
  // `payment_confirm.dart` occurrences already tracked in this project's
  // own knowledge base). `kycDocUrl`/`kycSelfieUrl` state fields already
  // exist and are already set once a real upload completes (this page's
  // ORIGINAL section, this file) — reusing them here turns a meaningless
  // placeholder into a genuinely useful upload-status line instead of
  // inventing new unrelated copy.
  // ==========================================================================

  final kycUploadStatusLabelFn = app.customFunction(
    'kycUploadStatusLabel',
    args: {'url': string},
    returns: string,
    description: 'KYCアップロード状況（未選択／アップロード済み）を表示用ラベルに変換する。',
    code: r'''
return (url != null && url.isNotEmpty) ? 'アップロード済み' : 'タップして選択してください';
''',
  );

  // Frozen (comprehensive review pass, 2026-08-12): both confirmed landed
  // via generated_code — `ensureReplaced` has no dedup guard, so leaving
  // either live risked reassigning fresh keys to that Text node on every
  // future unrelated push. Commented out per the established freeze
  // discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md).
  // `kycUploadStatusLabelFn`'s own `app.customFunction(...)` declaration
  // above is left live/registered — only its widget-tree usage moves here
  // — since ensureCustomFunction is safe to leave active indefinitely
  // (unlike ensureReplaced).
  // app.editPage(ff.Pages.kyc, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Text_uxanwugx'),
  //     Text(
  //       CustomFunction(kycUploadStatusLabelFn, args: {'url': State('kycDocUrl')}),
  //       name: 'KycDocUploadStatus',
  //     ),
  //   );
  //   page.ensureReplaced(
  //     page.findByKey('Text_0qon195f'),
  //     Text(
  //       CustomFunction(kycUploadStatusLabelFn, args: {'url': State('kycSelfieUrl')}),
  //       name: 'KycSelfieUploadStatus',
  //     ),
  //   );
  // });

  // ==========================================================================
  // Affiliate QR barcode `data:` — PARTIAL correction to §49/PROJECT_
  // KNOWLEDGE.md's own earlier conclusion, then a CONFIRMED SDK bug found by
  // isolating it. `Barcode(Object? data, {...})` (widgets.dart) DOES take
  // `data` through `normalizeExpression(data)` — a dynamic `data:` binding
  // is NOT categorically unsupported, correcting the earlier "no
  // DSL-authorable path" conclusion (that earlier check never looked at the
  // widget's own constructor source, only `docs`/`references`).
  //
  // Three isolated attempts, each via `flutterflow ai validate` (no push),
  // narrowing the cause:
  //   1. Dynamic `State('referralQrData')` (component-local state, set via
  //      a component-root ON_INIT_STATE trigger) + explicit `type:
  //      BarcodeKind.qrCode` — FAILED with BOTH "Widget class state field
  //      not found" AND "Barcode Type in Barcode Widget is not properly set".
  //   2. Literal string `'https://icoccha.com'` (no state at all) + explicit
  //      `type: BarcodeKind.qrCode` — the state-field error DISAPPEARED
  //      entirely; "Barcode Type... not properly set" alone REMAINED.
  //   3. Same literal string, `type:` omitted (relying on the constructor's
  //      own `BarcodeKind.qrCode` default) — identical single failure.
  // Conclusion: attempt 1's "Widget class state field not found" really was
  // about the component-local-state/ON_INIT_STATE approach specifically
  // (most likely this FF release not supporting ON_INIT_STATE on a
  // COMPONENT root — every other ON_INIT_STATE use this session is on a
  // PAGE root). But "Barcode Type in Barcode Widget is not properly set" is
  // independent of ALL of that — it reproduces on a fully literal,
  // minimal reconstruction with an explicit, correct, valid enum value.
  // `compiler.dart`'s own `_compileBarcodeKind`/`_compileStringValue` look
  // correct on inspection, and `_compileStringValue` is the same general
  // helper Text/Button/Image already use successfully elsewhere in this
  // file — so this is a genuine, reproducible SDK/codegen bug in how
  // `ensureReplaced` reconstructs a Barcode widget's type field specifically
  // (not something guessable further from this side of the tool), matching
  // this project's own standing rule: an error surviving multiple distinct,
  // plausible fixes means the bug is in the SDK, not the script — stop
  // iterating, report it. `flutterflow ai docs ui` doesn't document a
  // Barcode widget at all (zero hits), consistent with this being an
  // under-exercised part of the DSL surface. Left commented out rather than
  // pushed half-broken; `references/`/`patterns/` have no Barcode example
  // to cross-check against. If revisited: try reconstructing the Barcode's
  // PARENT container instead of the Barcode node directly (the same
  // structural workaround already proven for other stuck `ensureReplaced`
  // cases in this project), or ask FlutterFlow support directly with the
  // exact repro above.
  // ==========================================================================

  // app.editComponentState(ff.Components.affiliateQrCodeBottomSheet, (state) {
  //   state.ensureField('referralQrData', string.withDefault(''));
  // });
  //
  // app.customAction(
  //   'fetchReferralQrData',
  //   returns: string,
  //   description: '紹介QRコードに埋め込む招待リンク（自分のUIDベース）を取得する。',
  //   code: r'''
  // import '/auth/firebase_auth/auth_util.dart';
  //
  // Future<String> fetchReferralQrData() async {
  //   final uid = currentUserUid;
  //   if (uid.isEmpty) return '';
  //   return 'https://icoccha.com/signup?ref=$uid';
  // }
  // ''',
  // );
  //
  // app.editComponent(ff.Components.affiliateQrCodeBottomSheet, (component) {
  //   component.ensureActions(
  //     component.root,
  //     triggerType: FFActionTriggerType.ON_INIT_STATE,
  //     actions: [
  //       CallCustomAction.named('fetchReferralQrData', outputAs: 'qrDataResult'),
  //       SetState('referralQrData', ActionOutput('qrDataResult')),
  //     ],
  //   );
  //   component.ensureReplaced(
  //     component.findByKey('Barcode_a2t8zik3'),
  //     Barcode(
  //       State('referralQrData'),
  //       type: BarcodeKind.qrCode,
  //       name: 'ReferralQrBarcode',
  //     ),
  //   );
  // });

  // ==========================================================================
  // extension_payment.dart — full rebuild of the submit flow, not a small
  // patch. This page was wired directly in the FlutterFlow IDE before any
  // AI-tooling session touched it (no `app.editPage(ff.Pages.extensionPayment,
  // ...)` block exists anywhere in this file to edit in place), and reading
  // the actual compiled Dart (generated_code/lib/payment/extension_payment/
  // extension_payment_widget.dart) surfaced THREE real, compounding bugs
  // beyond the already-known hardcoded `'test_res_001'`:
  //   1. The submit button calls `actions.callCreatePaymentIntent(...)` —
  //      the MAIN reservation's authorize function (createPaymentIntent),
  //      NOT `createExtensionPayment` (the dedicated endpoint with
  //      extension-count/max-hours cap enforcement and its own `extensions`
  //      subcollection write). Wiring this up with a real resId as-is would
  //      have tried to re-authorize/overwrite the MAIN reservation's own
  //      `payment_intent_id`/status — exactly the danger this same audit's
  //      new `createPaymentIntent` status guard (stripe-payments.ts, only
  //      allows `status=="request_pending"`) would now correctly reject,
  //      but the UI bug itself needed fixing regardless.
  //   2. It wrote a NEW doc directly to a client-side `payments` collection
  //      — disconnected from `createExtensionPayment`'s own server-side
  //      `extensions` subcollection write, which is what this same audit's
  //      new `captureAuthorizedExtensions` (stripe-payments.ts) actually
  //      reads to capture the money later. Even a working resId would have
  //      created a payment record nothing downstream ever looks at.
  //   3. It NEVER called `confirmStripePayment` (the Stripe Payment Sheet) —
  //      it showed "決済が完了しました" (payment completed) unconditionally
  //      the instant the Cloud Function call returned, regardless of
  //      whether the guest ever actually authorized a charge with a real
  //      card. This is the same real bug class `payment_confirm.dart` had
  //      already been correctly built around (get client_secret -> present
  //      Payment Sheet -> check success) — this page just never followed
  //      that pattern.
  // The dropdown's own pricing computation (`functions.calculateExtensionPrice`
  // driven by `_model.timeSlot`/`_model.dropDownValue`) is untouched — it
  // was already correct, it just needed `timeSlot` fed real data instead of
  // a permanently-hardcoded '第2部' default.
  // ==========================================================================

  app.editPageParams(ff.Pages.extensionPayment, (params) {
    params.ensureParam('resId', string.withDefault(''));
  });

  app.customAction(
    'fetchExtensionTimeSlot',
    args: {'resId': string},
    returns: string,
    description: '予約の実際のtime_slotを取得する（延長料金計算の夜間割増判定に使用）。',
    code: r'''
import 'package:cloud_firestore/cloud_firestore.dart';

Future<String?> fetchExtensionTimeSlot(String? resId) async {
  try {
    if (resId == null || resId.isEmpty) return '第2部';
    final doc = await FirebaseFirestore.instance
        .collection('reservations')
        .doc(resId)
        .get();
    return doc.data()?['time_slot']?.toString() ?? '第2部';
  } catch (e) {
    return '第2部';
  }
}
''',
  );

  final extensionTimeSlotBannerFn = app.customFunction(
    'extensionTimeSlotBanner',
    args: {'timeSlot': string},
    returns: string,
    description: '延長申請画面の時間帯バナー文言を組み立てる。',
    code: r'''
return 'ご利用時間帯　${timeSlot ?? "第2部"}';
''',
  );

  // `callCreateExtensionPayment` — originally declared via a live
  // `app.customAction(...)` call, then modified via `updateCustomAction`
  // (confirmed landed live via generated_code). Attempting to "sync" the
  // original declaration back to a live `app.customAction(...)` call with
  // matching content still threw `ensureCustomAction found an existing
  // custom action... with a different payload` on the next push, even
  // though the content appeared byte-identical to what generated_code
  // showed as live — root cause not fully isolated. Matches the
  // established, already-working pattern used everywhere else in this
  // file for a post-`updateCustomAction` target: COMMENT OUT the original
  // live declaration entirely rather than trying to keep re-syncing it.
  //
  // CORRECTION (found during the "review everything" audit pass): the
  // `updateCustomAction` call this comment used to say "mutates it from
  // here on" was itself ALSO removed in the same push that commented out
  // this declaration — there is currently NO live declaration OR update
  // path anywhere in this script for `callCreateExtensionPayment`. This
  // is not broken today (the action is confirmed live and correct
  // server-side, verified against generated_code/lib/custom_code/actions/
  // call_create_extension_payment.dart), but the script itself can no
  // longer reproduce or modify this action without first adding a FRESH
  // `updateCustomAction(name: 'callCreateExtensionPayment', code: ...)`
  // call (not by re-adding a live `app.customAction(...)` declaration,
  // which would hit the same mismatch again). Current live signature, for
  // reference only (not executed):
  //   app.customAction(
  //     'callCreateExtensionPayment',
  //     args: {'resId': string, 'minutes': int_, 'amount': int_},
  //     returns: string,
  //     code: r'''...returns "client_secret|||extension_id"...''',
  //   );

  app.customAction(
    'callCancelExtensionPayment',
    args: {'resId': string, 'extensionId': string},
    returns: bool_,
    description: 'cancelExtensionPayment Cloud Functionを呼び出し、決済が完了しなかった延長申請の予約側カウント（extension_count/duration_minutes）を取り消す。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callCancelExtensionPayment(String? resId, String? extensionId) async {
  try {
    if (resId == null || resId.isEmpty || extensionId == null || extensionId.isEmpty) {
      return false;
    }
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('cancelExtensionPayment');
    final result = await callable.call({
      'res_id': resId,
      'extension_id': extensionId,
    });
    return result.data is Map && result.data['success'] == true;
  } catch (e) {
    return false;
  }
}
''',
  );

  app.editPage(ff.Pages.extensionPayment, (page) {
    // Root had zero existing triggerActions of its own (confirmed via the
    // typed SDK — only the dropdown's ON_FORM_WIDGET_SELECTED and the
    // submit button's ON_TAP carry any trigger at all, both native/
    // pre-session).
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchExtensionTimeSlot',
          arguments: {'resId': PageParam('resId')},
          outputAs: 'timeSlotResult',
        ),
        SetState(ff.Pages.extensionPayment.state.timeSlot, ActionOutput('timeSlotResult')),
      ],
    );

    // Time-slot banner — was a hardcoded literal "第2部　20：00～23：00"
    // regardless of the reservation's actual time_slot. Replaced with the
    // real value; the fixed clock-range portion ("20:00〜23:00") is
    // dropped rather than guessed — no verified slot-to-clock-range
    // mapping exists anywhere in this backend/schema to reproduce it
    // correctly for all 4 possible time slots.
    //
    // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
    // generated_code — `ensureReplaced` has no dedup guard, so leaving
    // this live risked reassigning a fresh key to this Text node on every
    // future unrelated push. Commented out per the established freeze
    // discipline (PROJECT_KNOWLEDGE.md §54/project_rules.md); the
    // `ensureActions` call above and the submit-button rewiring below stay
    // live (separate, non-one-shot operations).
    // page.ensureReplaced(
    //   page.findByKey('Text_e9vm0bss'),
    //   Text(
    //     CustomFunction(extensionTimeSlotBannerFn, args: {'timeSlot': State('timeSlot')}),
    //     name: 'ExtensionTimeSlotBanner',
    //   ),
    // );

    // Submit button — full replacement of the broken 3-bug chain described
    // above with the same proven get-client-secret -> present-Payment-
    // Sheet -> check-success pattern `payment_confirm.dart` already uses
    // correctly.
    //
    // FIX (found on this same fix's own review pass): `createExtensionPayment`
    // (stripe-payments.ts) increments the reservation's `extension_count`/
    // `duration_minutes` IMMEDIATELY on PaymentIntent creation, before the
    // guest has actually completed anything in the Payment Sheet below — a
    // pre-existing backend design that was never reachable before this fix
    // (extension_payment.dart previously called an entirely different,
    // broken function), so this is the first time it's live. Without a
    // rollback, a guest whose card fails/who cancels the sheet would
    // permanently lose one of their 3 extension slots and see inflated
    // duration for a payment that never happened. `callCreateExtensionPayment`
    // now returns `client_secret|||extension_id`; on payment failure,
    // `callCancelExtensionPayment` reverses the optimistic increment via a
    // transactional Cloud Function (stripe-payments.ts) before showing the
    // failure snackbar.
    page.ensureActions(
      page.findByKey('Button_jiosuscb'), // 延長申請する
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        CallCustomAction.named(
          'callCreateExtensionPayment',
          arguments: {
            'resId': PageParam('resId'),
            'minutes': State(ff.Pages.extensionPayment.state.extensionMinutes),
            'amount': State(ff.Pages.extensionPayment.state.totalAmount),
          },
          outputAs: 'extCreateResult',
        ),
        CallCustomAction.named(
          'isNonEmptyString',
          arguments: {'value': ActionOutput('extCreateResult')},
          outputAs: 'extCreateSucceeded',
        ),
        If(
          ActionOutput('extCreateSucceeded'),
          then: [
            CallCustomAction.named(
              'confirmStripePayment',
              arguments: {
                'clientSecret': CustomFunction(
                  splitFieldFn,
                  args: {'data': ActionOutput('extCreateResult'), 'index': 0},
                ),
              },
              outputAs: 'extStripeResult',
            ),
            CallCustomAction.named(
              'isPaymentSuccess',
              arguments: {'value': ActionOutput('extStripeResult')},
              outputAs: 'extPaymentSucceeded',
            ),
            If(
              ActionOutput('extPaymentSucceeded'),
              then: [Snackbar('延長のお支払いが完了しました。'), NavigateBack()],
              orElse: [
                CallCustomAction.named(
                  'callCancelExtensionPayment',
                  arguments: {
                    'resId': PageParam('resId'),
                    'extensionId': CustomFunction(
                      splitFieldFn,
                      args: {'data': ActionOutput('extCreateResult'), 'index': 1},
                    ),
                  },
                  outputAs: 'extCancelResult',
                ),
                Snackbar('決済がキャンセルされたか失敗しました。'),
              ],
            ),
          ],
          orElse: [Snackbar('延長申請に失敗しました。もう一度お試しください。')],
        ),
      ],
    );
  });

  // ── ReservationDetail: extend session (延長する) entry point — the
  // navigation gap `extension_payment.dart` had no way to be reached from
  // anywhere in the app. Gated the same way every other lifecycle button
  // on this page already is —
  // guest-only, `in_progress` only (the only state extension makes sense
  // in, matching `createExtensionPayment`'s own status guard added this
  // same audit pass), inserted right after `ConfirmMeetupRow` (its own
  // `status=='confirmed'` window ends exactly where this one's
  // `status=='in_progress'` window begins) and before `ReportCompletionRow`.
  final canExtendReservationFn = app.customFunction(
    'canExtendReservation',
    args: {'data': string},
    returns: bool_,
    description: '現在のユーザーがこの予約の延長を申請できるか判定する（ゲストかつin_progress状態）。',
    code: r'''
final parts = (data ?? '').split('|||');
if (parts.length < 3) return false;
final status = parts[0];
final isGuest = parts[1] == 'true';
return isGuest && status == 'in_progress';
''',
  );

  // ensureInsertedAfter — one-shot, CONFIRMED LANDED (ExtendReservationRow/
  // ExtendReservationButton exist live, per the regenerated typed SDK) —
  // FROZEN. Re-running this exact call with different Button styling
  // (width/height/color/textColor/borderRadius added, in the SAME push
  // that also fixed the extension-payment rollback bug) was silently
  // ignored — `generated_code` still showed the unstyled button afterward,
  // confirming `ensureInsertedAfter` is create-if-missing/one-shot just
  // like `ensureReplaced`/`ensurePage`, not something safe to re-issue
  // with different content once its target already exists. Styling fixed
  // separately below via `ensureReplaced` on the button's own real key
  // instead (a genuinely first-time operation on that specific node).
  //   app.editPage(ff.Pages.reservationDetail, (page) {
  //     page.ensureInsertedAfter(
  //       page.findByKey('Row_qv779nx8'), // ConfirmMeetupRow
  //       Row(
  //         name: 'ExtendReservationRow',
  //         visible: CustomFunction(canExtendReservationFn, args: {'data': State('resVisibilityData')}),
  //         children: [
  //           Button(
  //             '延長する',
  //             name: 'ExtendReservationButton',
  //             onTap: [
  //               Navigate(
  //                 ff.Pages.extensionPayment,
  //                 params: {'resId': PageParam('resId')},
  //               ),
  //             ],
  //           ),
  //         ],
  //       ),
  //     );
  //   });

  // Frozen (comprehensive review pass, 2026-08-12): confirmed landed via
  // generated_code — `ensureReplaced` has no dedup guard, so leaving this
  // live risked reassigning a fresh key to this Button on every future
  // unrelated push. Commented out per the established freeze discipline
  // (PROJECT_KNOWLEDGE.md §54/project_rules.md).
  // app.editPage(ff.Pages.reservationDetail, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Button_ju2dtcif'), // ExtendReservationButton
  //     Button(
  //       '延長する',
  //       name: 'ExtendReservationButton',
  //       width: 150,
  //       height: 40,
  //       color: Colors.primary,
  //       textColor: Colors.hex(0xFFFFFFFF),
  //       borderRadius: 8,
  //       onTap: [
  //         Navigate(
  //           ff.Pages.extensionPayment,
  //           params: {'resId': PageParam('resId')},
  //         ),
  //       ],
  //     ),
  //   );
  // });

  // ==========================================================================
  // CRITICAL FIX (comprehensive review pass, 2026-08-12): the app's
  // initial/home route resolved to `ExtensionPaymentWidget()` for every
  // logged-in user, not `HomePageWidget()` — confirmed directly in
  // generated_code/lib/flutter_flow/nav/nav.dart:
  //   initialLocation: '/',
  //   errorBuilder: (context, state) =>
  //       appStateNotifier.loggedIn ? ExtensionPaymentWidget() : LoginPageWidget(),
  //   routes: [ FFRoute(name: '_initialize', path: '/', builder: (context, _) =>
  //       appStateNotifier.loggedIn ? ExtensionPaymentWidget() : LoginPageWidget()), ... ]
  // Every returning, already-logged-in user's cold app launch landed on
  // ExtensionPayment (which needs a `resId` param that's empty on a fresh
  // launch, since nothing set it) instead of Home — almost certainly a
  // stale "Initial Page" project setting left over from whenever
  // ExtensionPayment was being actively developed (§50), never reverted.
  // Nothing in this DSL script ever declared this — `app.page`/
  // `app.ensurePage` both default `isInitial: false`, confirmed by reading
  // every ExtensionPayment-related block in this file, none pass
  // `isInitial: true` — this is a raw project-level setting.
  //
  // Fixed surgically: `project.authPageInfo.homePageNodeKeyRef` (read via
  // `auth_helpers.dart`'s `configureFirebaseAuth`, confirmed as the exact
  // field it writes) is the field driving this — NOT the generic
  // `initialPageKeyRef`/`setInitialPage` (that helper isn't part of the
  // public DSL export surface anyway, confirmed by compile error:
  // "Method not found: 'setInitialPage'" — `project_helpers.dart` only
  // exports `findPage`/`findComponent`). Rewriting the WHOLE Firebase Auth
  // config via `configureFirebaseAuth` was deliberately avoided — it also
  // requires the current `providers` list, which isn't readable from
  // anywhere this session has access to, and passing the wrong list risks
  // silently disabling a live auth provider. Setting only
  // `homePageNodeKeyRef` via already-exported `findPage`/`FFNodeKeyReference`
  // touches nothing else (providers, signInPageNodeKeyRef, active flag all
  // untouched).
  app.raw((project) {
    final homePage = findPage(project, name: 'HomePage');
    if (homePage == null) {
      throw StateError('HomePage not found — cannot fix the initial route.');
    }
    project.ensureAuthPageInfo().homePageNodeKeyRef = FFNodeKeyReference(
      key: homePage.node.key,
    );
  });

  // ==========================================================================
  // style/ folder asset wiring (2026-08-13): client delivered final brand/UI
  // assets (icon font + logo were already confirmed live — PROJECT_KNOWLEDGE.md
  // §60) plus ~35 page photos and 8 illustration-button SVGs. Assets were
  // uploaded to Media Assets by the user directly through the FlutterFlow
  // builder (this SDK has no binary-upload path — confirmed, §60); every
  // filename below was confirmed against the user's own screenshots and,
  // where ambiguous, the actual rendered image content — not guessed.
  // ==========================================================================

  app.editPage(ff.Pages.authComplete, (page) {
    page.update(page.findByKey('Image_2vhivfmk'), (patch) {
      patch.imagePath('assets/images/authComplete_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.emailVerification, (page) {
    page.update(page.findByKey('Image_u4kc8ka8'), (patch) {
      patch.imagePath('assets/images/emailVerification_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.phoneVarification, (page) {
    page.update(page.findByKey('Image_0cmx04qo'), (patch) {
      patch.imagePath('assets/images/phoneVarification_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.smsCode, (page) {
    page.update(page.findByKey('Image_jwl544iu'), (patch) {
      patch.imagePath('assets/images/smsCode_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.reviewPending, (page) {
    page.update(page.findByKey('Image_csmhzvc7'), (patch) {
      patch.imagePath('assets/images/reviewPending_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.reservationConfirmed, (page) {
    page.update(page.findByKey('Image_1p1n3305'), (patch) {
      patch.imagePath('assets/images/reservationConfirmed_image.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.castProfile, (page) {
    // Was hardcoded to `image0_(1).jpeg` — confirmed genuinely broken (the
    // actual pre-existing file is `.png`, an extension mismatch that
    // predates this round). Repointed at the new upload instead of
    // chasing the old mismatched path.
    page.update(page.findByKey('Image_1txk54nz'), (patch) {
      patch.imagePath('assets/images/castProfile_image.jpeg', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.kyc, (page) {
    // kyc_image_man.png = ID-document upload illustration; kyc_image_woman.png
    // = selfie-upload illustration — mapped by actual rendered content
    // (confirmed by the user opening both files), not by filename.
    page.update(page.findByKey('Image_caclcv9m'), (patch) {
      patch.imagePath('assets/images/kyc_image_man.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_8r83ksqp'), (patch) {
      patch.imagePath('assets/images/kyc_image_woman.png', source: ImageSource.asset);
    });
  });

  // §71: CocomisePage ("ココ店" tab) wiring to the real `cocoten_shops`
  // collection. Was 2 hardcoded fake shop cards + 7 dead filter chips + a
  // dead "オープン" switch + a dead search dialog (wrote
  // FFAppState().searchShopKeyword, nothing ever read it back — confirmed
  // via full-tree grep). `cocoten_shops` is already a typed DSL collection
  // (ff.Collections.cocotenShops) with public read in firestore.rules
  // (matches banners/prefectures precedent) — no new Cloud Function needed.
  // `FirestoreQuery` (the DSL action) has no where/filter clause at all, so
  // filtering happens client-side via a custom function against the one
  // full fetch (collection is small — 5 docs today per admin's own
  // adminGetCocotenShops comment "shop counts are expected to be small").
  //
  // Real-data caveat, already disclosed via adminUpsertCocotenShop's own
  // comment ("photos deliberately not handled here"): only `name`/`genre`/
  // `active` are both real (actually written by adminUpsertCocotenShop) AND
  // in the typed schema — `address`/`location`/`photos`/`menu`/
  // `guest_benefits`/`tags` are declared in the schema but never populated
  // by any current writer, so the grid/dialog intentionally bind only to
  // the three real fields. Scope, confirmed with the user: wire the
  // grid/filters/search to real data + a lightweight name/genre info
  // dialog on tap. The separately-tracked `CocoTenDetailPage`
  // (photos/menu/guest-perks/invite-flow — IMPLEMENTATION_PLAN.md §3.4
  // items 1-2, Phase 3) stays out of scope, untouched.
  //
  // Genre is free text (admin.ts just stores whatever string is entered,
  // no enum/dropdown) and the 7 chip labels have decorative full-width
  // spaces ('和　食') — the filter function normalizes (strips spaces) and
  // uses substring containment, not `==`. Live document genre values were
  // NOT inspectable in this environment (no Firestore read credentials
  // available beyond the FlutterFlow-managed DSL/Cloud Functions path) —
  // some chips may legitimately match 0 of today's 5 shops; that's a data
  // question, not a wiring bug, disclosed rather than silently assumed
  // correct.
  final filterCocotenShopsFn = app.customFunction(
    'filterCocotenShops',
    args: {
      'shops': listOf(ff.Collections.cocotenShops),
      'genre': string,
      'activeOnly': bool_,
      'keyword': string,
    },
    returns: listOf(ff.Collections.cocotenShops),
    description: 'cocoten_shops一覧をジャンル/オープン中/キーワードでクライアント側フィルタする（CocomisePage）。',
    code: r'''
final list = shops ?? const [];
String strip(String s) => s.replaceAll(RegExp(r'[\s　]'), '');
final normalizedGenre = strip(genre ?? '');
final kw = (keyword ?? '').trim().toLowerCase();
final onlyActive = activeOnly ?? false;
return list.where((shop) {
  if (onlyActive && shop.active != true) return false;
  if (normalizedGenre.isNotEmpty) {
    final shopGenre = strip(shop.genre ?? '');
    if (!shopGenre.contains(normalizedGenre)) return false;
  }
  if (kw.isNotEmpty) {
    if (!(shop.name ?? '').toLowerCase().contains(kw)) return false;
  }
  return true;
}).toList();
''',
  );

  app.editPageState(ff.Pages.cocomisePage, (state) {
    state.ensureField('shops', listOf(ff.Collections.cocotenShops));
    state.ensureField('selectedGenre', string.withDefault(''));
    state.ensureField('activeOnly', bool_.withDefault(true)); // preserves the switch's current default-ON look
  });

  app.editPage(ff.Pages.cocomisePage, (page) {
    // REMOVED (2026-08-13, PROJECT_KNOWLEDGE.md §71): `Image_t4egp1od`/
    // `Image_ujc8z79s` no longer exist — confirmed via
    // lib/flutterflow_project/pages/cocomise_page.dart (post-push) and via
    // the CocotenShopGrid replace below, which removed the entire old
    // hardcoded shop-card subtree (`Container_gjm7b6a0`/`Container_igip45cj`,
    // the fake "焼鳥 一鳥"/"焼鳥 慶州園" cards) these two Image widgets lived
    // inside. Same pattern as the earlier HomePage `Image_y1iahv8w`/
    // `Image_12ktlryb` incident (see below in this file): a plain
    // `page.update()` asset-wiring patch that predates the structural
    // replace, now hard-failing `compileDslApp` since its targets are gone
    // by design, not renamed. Removed rather than re-targeted — the new
    // dynamic `CocotenShopGrid` cards have no per-shop static image slot
    // (real `cocoten_shops` documents don't have populated `photos` data
    // to bind to anyway, see the block below).
    //   page.update(page.findByKey('Image_t4egp1od'), (patch) { // 焼鳥 一鳥
    //     patch.imagePath('assets/images/cocomise_shop_image1.png', source: ImageSource.asset);
    //   });
    //   page.update(page.findByKey('Image_ujc8z79s'), (patch) { // 焼鳥 慶州園
    //     patch.imagePath('assets/images/cocomise_shop_image2.png', source: ImageSource.asset);
    //   });
    // Ad carousel — previously network placeholder images on these same
    // `Image` widgets; swapped to the client's real ad creatives in
    // on-page swipe order.
    page.update(page.findByKey('Image_dkzvgwre'), (patch) {
      patch.imagePath('assets/images/cocomise_koukoku_image1.jpeg', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_aoopy7b4'), (patch) {
      patch.imagePath('assets/images/cocomise_koukoku_image2.jpeg', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_hideg0h1'), (patch) {
      patch.imagePath('assets/images/cocomise_koukoku_image3.jpeg', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_9q3sv9ot'), (patch) {
      patch.imagePath('assets/images/cocomise_koukoku_image4.jpeg', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_tispo3jj'), (patch) {
      patch.imagePath('assets/images/cocomise_koukoku_image5.jpeg', source: ImageSource.asset);
    });

    // Initial fetch — this page has never had DSL touch its ON_INIT_STATE
    // before (native-only, sets FFAppState().navIndex = 1). Per this
    // project's own hard-learned rule (a SECOND ensureActions call on the
    // same root+ON_INIT_STATE trigger fails compileDslApp outright), this
    // must stay the ONLY call on this trigger going forward — any future
    // addition nests inside this same call.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        UpdateAppState.set(ff.AppState.navIndex, 1),
        FirestoreQuery(
          ff.Collections.cocotenShops,
          limit: 100,
          singleTimeQuery: true,
          outputAs: 'cocotenShopsResult',
        ),
        SetState('shops', ActionOutput('cocotenShopsResult')),
      ],
    );

    // 7 genre chips — single-select toggle (tap again to clear). Container
    // already supports onTap in its DSL constructor; asserting ON_TAP on
    // these pre-existing instances directly (no structural replace needed).
    page.ensureActions(
      page.findByKey('Container_0wh21mpc'), // 和　食
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), '和食'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', '和食')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_woiyd378'), // 洋　食
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), '洋食'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', '洋食')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_i8nod4uz'), // 和洋食
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), '和洋食'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', '和洋食')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_z0t09uyq'), // イタ飯
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), 'イタ飯'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', 'イタ飯')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_40qrlyom'), // 韓　食
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), '韓食'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', '韓食')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_09intull'), // 中　華
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), '中華'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', '中華')],
        ),
      ],
    );
    page.ensureActions(
      page.findByKey('Container_2wq3wtxf'), // その他
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [
        If(
          Equals(State('selectedGenre'), 'その他'),
          then: [SetState('selectedGenre', '')],
          orElse: [SetState('selectedGenre', 'その他')],
        ),
      ],
    );

    // オープン switch → activeOnly. SwitchListTile is a confirmed-invalid
    // ON_TOGGLE_ON/OFF target in this SDK (compileDslApp rejected it
    // elsewhere in this file with "requires a Switch or Checkbox target,
    // got SwitchListTile" — no `Switch` DSL widget class exists at all).
    // Reusing the same fix already landed for ResGroupInviteCheckbox:
    // same boolean semantic, Checkbox instead of a Material Switch visual.
    //
    // FROZEN (2026-08-13, confirmed landed): verified via
    // generated_code/lib/cocomise/cocomise_page/cocomise_page_widget.dart
    // — a real `Checkbox(value: _model.cocomiseOpenOnlyCheckboxValue ??=
    // _model.activeOnly!, onChanged: ... _model.activeOnly = ...)` renders
    // in place of the old SwitchListTile. New key/name: `CocomiseOpenOnlyRow`
    // / `CocomiseOpenOnlyCheckbox` (typed SDK). Any future change must
    // target that name instead of re-inserting.
    // page.ensureReplaced(
    //   page.findByKey('SwitchListTile_zcyxh0t9'),
    //   Row(
    //     name: 'CocomiseOpenOnlyRow',
    //     mainAxis: MainAxis.spaceBetween,
    //     children: [
    //       Column(
    //         crossAxis: CrossAxis.start,
    //         children: [
    //           Text('オープン', style: Styles.titleLarge),
    //           Text('開店中のお店表示', style: Styles.labelMedium),
    //         ],
    //       ),
    //       Checkbox(
    //         name: 'CocomiseOpenOnlyCheckbox',
    //         value: State('activeOnly'),
    //         onChanged: SetState('activeOnly', const WidgetValue()),
    //       ),
    //     ],
    //   ),
    // );

    // Shop grid — bound to a LIVE CustomFunction expression (re-evaluated
    // on every rebuild), not a second imperatively-populated state field.
    // This is what makes the search dialog's keyword (which can only be
    // reached through FFAppState().searchShopKeyword — CocomisePage's own
    // build() already does context.watch<FFAppState>(), so it already
    // rebuilds on that change) join the same reactive loop as the chips
    // and the switch, with zero extra plumbing. GridView.source/itemBuilder
    // are constructor-only (no patch method re-sources an existing
    // GridView), so this is a structural replace, matching the precedent
    // already used for HomePage's discovery-cast grid.
    //
    // FROZEN (2026-08-13, confirmed landed): verified via generated_code —
    // a real `GridView.builder` reads `functions.filterCocotenShops(
    // _model.shops.toList(), _model.selectedGenre, _model.activeOnly,
    // FFAppState().searchShopKeyword)` inline per rebuild, each card shows
    // `itemItem.name`/`itemItem.genre`/`if (itemItem.active)` dot, and tap
    // opens a real AlertDialog with the shop's name/genre. New key/name:
    // `CocotenShopGrid` (typed SDK). Any future change must target that
    // name instead of re-inserting.
    // page.ensureReplaced(
    //   page.findByKey('GridView_3dnvgyi6'),
    //   GridView(
    //     name: 'CocotenShopGrid',
    //     source: CustomFunction(
    //       filterCocotenShopsFn,
    //       args: {
    //         'shops': State('shops'),
    //         'genre': State('selectedGenre'),
    //         'activeOnly': State('activeOnly'),
    //         'keyword': AppState(ff.AppState.searchShopKeyword),
    //       },
    //     ),
    //     columns: 2,
    //     crossAxisSpacing: 10,
    //     mainAxisSpacing: 10,
    //     childAspectRatio: 1.0,
    //     itemBuilder: (item) => Container(
    //       name: 'CocotenShopCard',
    //       padding: EdgeInsets.all(12),
    //       borderRadius: 12,
    //       borderColor: Colors.alternate,
    //       borderWidth: 1,
    //       color: Colors.secondaryBackground,
    //       onTap: [
    //         ShowDialog.message(title: item['name'], message: item['genre']),
    //       ],
    //       child: Column(
    //         crossAxis: CrossAxis.start,
    //         mainAxis: MainAxis.center,
    //         spacing: 6,
    //         children: [
    //           Row(
    //             mainAxis: MainAxis.spaceBetween,
    //             children: [
    //               Text(
    //                 item['name'],
    //                 style: Styles.bodyLarge,
    //                 maxLines: 1,
    //                 overflow: TextOverflow.ellipsis,
    //               ),
    //               Container(
    //                 width: 10,
    //                 height: 10,
    //                 borderRadius: 5,
    //                 color: Colors.success,
    //                 visible: item['active'],
    //                 name: 'CocotenShopActiveDot',
    //               ),
    //             ],
    //           ),
    //           Text(
    //             item['genre'],
    //             style: Styles.bodySmall,
    //             color: Colors.secondaryText,
    //             maxLines: 1,
    //             overflow: TextOverflow.ellipsis,
    //           ),
    //         ],
    //       ),
    //     ),
    //   ),
    // );
  });

  // REMOVED (2026-08-13, PROJECT_KNOWLEDGE.md §71): `Image_y1iahv8w`/
  // `Image_12ktlryb` no longer exist — confirmed via
  // lib/flutterflow_project/pages/home_page.dart (only 4 Image widgets
  // remain on HomePage, none matching either key) and via generated_code
  // (neither `home_image3.jpeg` nor `home_image4.jpeg` appear anywhere).
  // Root cause: these were almost certainly the 2 fake "cast card"
  // background photos (`ゆずき`/`arika`) inside `GridView_2f71lsw8` —
  // wired to real asset files in an earlier asset-wiring pass, before this
  // session's comprehensive review (§70) found the whole card content
  // (names/stats/text) was hardcoded fake data shown to real guests and
  // removed the entire card structure via `ensureReplaced` (see that
  // block, above `RemovedStaticFakeCastGrid`). This asset-wiring block —
  // a plain `page.update()` property patch, not a one-shot creation call —
  // re-executes on every push and was hard-failing `compileDslApp` for
  // every push since, since the widgets it targeted are simply gone.
  // Removed rather than re-targeted at a new key: there is no successor
  // widget to wire these images onto, since the fake cards themselves are
  // gone by design, not renamed.
  //   app.editPage(ff.Pages.homePage, (page) {
  //     page.update(page.findByKey('Image_y1iahv8w'), (patch) {
  //       patch.imagePath('assets/images/home_image3.jpeg', source: ImageSource.asset);
  //     });
  //     page.update(page.findByKey('Image_12ktlryb'), (patch) {
  //       patch.imagePath('assets/images/home_image4.jpeg', source: ImageSource.asset);
  //     });
  //   });

  app.editPage(ff.Pages.myPage, (page) {
    // Self-avatar placeholders. No dedicated "own profile photo" asset was
    // delivered; the previous reference (bare `image1.jpeg`) is confirmed
    // absent from Media Assets entirely (almost certainly one of the
    // "insufficient storage" cleanup deletions) and was rendering broken
    // regardless of this task. Reusing home_image3.jpeg as a generic
    // placeholder — same treatment this project already gives every other
    // not-yet-dynamically-bound avatar slot.
    page.update(page.findByKey('CircleImage_t0zjz7xt'), (patch) {
      patch.imagePath('assets/images/home_image3.jpeg', source: ImageSource.asset);
    });
    page.update(page.findByKey('CircleImage_vgdabb78'), (patch) {
      patch.imagePath('assets/images/home_image3.jpeg', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.tutorialPage, (page) {
    // Mapped by on-page swipe order (ascending widget-tree position), not
    // by any resemblance between the old and new filenames — the two
    // numbering schemes are unrelated.
    page.update(page.findByKey('Image_xbm3nymy'), (patch) {
      patch.imagePath('assets/images/tutorial_image1.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_wd9qmfck'), (patch) {
      patch.imagePath('assets/images/tutorial_image2.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_h55bb8fx'), (patch) {
      patch.imagePath('assets/images/tutorial_image3.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_h1wcebh6'), (patch) {
      patch.imagePath('assets/images/tutorial_image4.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('Image_93ij4zqz'), (patch) {
      patch.imagePath('assets/images/tutorial_image5.png', source: ImageSource.asset);
    });
  });

  app.editPage(ff.Pages.reservationDetail, (page) {
    // Generic "no photo" fallback avatars — were `assets/images/icoccha_noimage.png`,
    // which the user's bulk upload renamed to `macchaChatsimage.png`
    // (confirmed: FlutterFlow AI's folder-derived rename of
    // style/icoccha_app_image/macchaChatsimage/icoccha_noimage.png).
    page.update(page.findByKey('CircleImage_wer97dj4'), (patch) {
      patch.imagePath('assets/images/macchaChatsimage.png', source: ImageSource.asset);
    });
    page.update(page.findByKey('CircleImage_3lveym1m'), (patch) {
      patch.imagePath('assets/images/macchaChatsimage.png', source: ImageSource.asset);
    });
  });

  app.editComponent(ff.Components.affiliateQrCodeBottomSheet, (component) {
    component.update(component.findByKey('Image_57r9rbcw'), (patch) { // LINE
      patch.imagePath('assets/images/qrcode_line_share_image.png', source: ImageSource.asset);
    });
    component.update(component.findByKey('Image_4jwu6oa2'), (patch) { // generic 'share' action — the client's own filename confirms Instagram
      patch.imagePath('assets/images/qrcode_insta_share_image.png', source: ImageSource.asset);
    });
    component.update(component.findByKey('Image_kp4fv03o'), (patch) { // X (Twitter)
      patch.imagePath('assets/images/qrcode_x_share_image.png', source: ImageSource.asset);
    });
    component.update(component.findByKey('Image_fi75lg5a'), (patch) { // Threads
      patch.imagePath('assets/images/qrcode_threads_share_image.png', source: ImageSource.asset);
    });
  });

  // WorkPage: 4 CircleImage recruitment-category placeholders. All 4 slots
  // are structurally identical (CircleImage + generic "募集画像表示" Text
  // overlaid in a Stack); the delivered SVGs self-label their category
  // (送迎スタッフ/イコッチャガールズ/セキュリティスタッフ/イコッチャボーイズ募集中！),
  // so left-to-right assignment order doesn't affect meaning.
  app.editPage(ff.Pages.workPage, (page) {
    page.update(page.findByKey('CircleImage_h9jv94gk'), (patch) {
      patch.imagePath('assets/images/woorkpage-button-svg1.svg', source: ImageSource.asset);
    });
    page.update(page.findByKey('CircleImage_r9m368f1'), (patch) {
      patch.imagePath('assets/images/woorkpage-button-svg2.svg', source: ImageSource.asset);
    });
    page.update(page.findByKey('CircleImage_4popyyr4'), (patch) {
      patch.imagePath('assets/images/woorkpage-button-svg3.svg', source: ImageSource.asset);
    });
    page.update(page.findByKey('CircleImage_jtl07lrt'), (patch) {
      patch.imagePath('assets/images/woorkpage-button-svg4.svg', source: ImageSource.asset);
    });
    // Blank the now-redundant placeholder text overlaid on each real image.
    // Two different attempts to actually HIDE it (`patch.visible(false)`,
    // then the raw `mutateNode` + `ensureVisibility()` escape hatch) both
    // compiled and pushed with zero error but produced no visible change in
    // `generated_code` and no `visibility` field in
    // `flutterflow ai inspect --selector-key --dsl-json` either — a genuine
    // SDK/codegen gap with static (non-dynamic) visibility on a `Text`
    // nested in a `Stack`, not a scripting mistake (confirmed by trying two
    // independent mechanisms). Blanking the text content instead — `.text()`
    // is already proven reliable elsewhere in this file and achieves the
    // same end-user-visible result (no leftover label) without depending on
    // the broken field.
    for (final key in [
      'Text_ir4sljtu',
      'Text_baieqvuy',
      'Text_1spm8aa6',
      'Text_kgnedru2',
    ]) {
      page.update(page.findByKey(key), (patch) {
        patch.text('');
      });
    }
  });

  // MyPage: 3 of 4 legal/help image placeholders (Text -> Image). The 2nd
  // ガイドライン placeholder (Text_sswmld4n) is intentionally left untouched —
  // mypage-button-svg4.svg turned out to be an "お問い合わせメール" (inquiry)
  // icon, not a second guideline image (confirmed by opening the file); no
  // matching asset exists for this slot yet, and svg4 is being held for a
  // follow-up wiring it to the SupportLegalHub/InquiryForm entry point
  // instead.
  //
  // FROZEN (2026-08-13, immediately after this exact block landed): confirmed
  // via lib/flutterflow_project/pages/my_page.dart — `Text_gpzkjpcj`,
  // `Text_bhfsi6di`, `Text_xxauqlfi` no longer exist; ensureReplaced assigned
  // fresh keys the moment this ran (Image_a2t7auha "TermsButtonImage",
  // Image_g4f2674l "GuidelineButtonImage", Image_4pso7u43 "QaHelpButtonImage")
  // — same one-shot behavior as every other ensureReplaced in this file. Any
  // future change to these 3 nodes must target the new keys (or
  // ff.Pages.myPage.widgets.byName('...')) instead of the stale Text keys.
  // app.editPage(ff.Pages.myPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Text_gpzkjpcj'), // ご利用規約
  //     Image(
  //       'assets/images/mypage-button-svg1.svg',
  //       isNetwork: false,
  //       name: 'TermsButtonImage',
  //     ),
  //   );
  //   page.ensureReplaced(
  //     page.findByKey('Text_bhfsi6di'), // ガイドライン (1st)
  //     Image(
  //       'assets/images/mypage-button-svg2.svg',
  //       isNetwork: false,
  //       name: 'GuidelineButtonImage',
  //     ),
  //   );
  //   page.ensureReplaced(
  //     page.findByKey('Text_xxauqlfi'), // Q&A・ヘルプ
  //     Image(
  //       'assets/images/mypage-button-svg3.svg',
  //       isNetwork: false,
  //       name: 'QaHelpButtonImage',
  //     ),
  //   );
  // });

  // ==========================================================================
  // New UI for slots the delivered style/ assets unblock but that had no
  // structure to receive them yet (2026-08-13). Scoped to what can be built
  // without touching pre-existing dynamic list/filter logic this DSL script
  // never authored (see MacchaPage note below) — safer, narrower changes
  // over guessing at data bindings this session can't verify.
  // ==========================================================================

  // SupportLegalHub: the 3 rows shipped in Phase 11 slice 3 as plain,
  // unstyled Buttons — functional but visually bare next to the rest of the
  // app's card-based list rows (MyPage drawer, BlockList). Restyled to match:
  // a Card per row, leading icon, trailing chevron for affordance. The 3rd
  // row uses the real お問い合わせメール illustration (mypage-button-svg4.svg —
  // confirmed by content, not filename, in PROJECT_KNOWLEDGE.md §61) instead
  // of a generic icon, since that asset was delivered specifically for this
  // slot. Each Card's onTap reproduces the exact Navigate target the
  // replaced Button already had (confirmed via generated_code before
  // touching anything).
  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): all 3 ensureReplaced calls below confirmed landed via
  // lib/flutterflow_project/pages/support_legal_hub.dart — Button_rggeusvn/
  // Button_794uur68/Button_5f50xmd2 no longer exist, replaced by
  // Card_xz53b6hc "TermsOfServiceRow", Card_mzg1y0hj "PrivacyPolicyRow",
  // Card_hcc8tp7x "InquiryFormRow" respectively. Left live, this block hard-
  // failed the very next unrelated push with "findByKey(...) found no
  // matches" (ensureReplaced has no dedup guard — confirmed the hard way).
  // The Column padding/spacing patch above stays live (a simple repeatable
  // property patch, not one-shot).
  app.editPage(ff.Pages.supportLegalHub, (page) {
    page.update(page.findByKey('Column_wutn42f4'), (patch) {
      patch.padding(16);
      patch.spacing(12);
    });
  });
  // page.ensureReplaced(
  //   page.findByKey('Button_rggeusvn'), // 利用規約
  //   Card(
  //     elevation: 1,
  //     borderRadius: 12,
  //     color: Colors.secondaryBackground,
  //     onTap: [Navigate(ff.Pages.termsOfService)],
  //     name: 'TermsOfServiceRow',
  //     child: Row(
  //       padding: 16,
  //       spacing: 12,
  //       children: [
  //         Icon('description', size: 22, color: Colors.primary),
  //         Expanded(
  //           Text('利用規約', style: Styles.bodyLarge, color: Colors.primaryText),
  //         ),
  //         Icon('chevron_right', size: 20, color: Colors.secondaryText),
  //       ],
  //     ),
  //   ),
  // );
  //
  // page.ensureReplaced(
  //   page.findByKey('Button_794uur68'), // プライバシーポリシー
  //   Card(
  //     elevation: 1,
  //     borderRadius: 12,
  //     color: Colors.secondaryBackground,
  //     onTap: [Navigate(ff.Pages.privacyPolicy)],
  //     name: 'PrivacyPolicyRow',
  //     child: Row(
  //       padding: 16,
  //       spacing: 12,
  //       children: [
  //         Icon('privacy_tip', size: 22, color: Colors.primary),
  //         Expanded(
  //           Text('プライバシーポリシー', style: Styles.bodyLarge, color: Colors.primaryText),
  //         ),
  //         Icon('chevron_right', size: 20, color: Colors.secondaryText),
  //       ],
  //     ),
  //   ),
  // );
  //
  // page.ensureReplaced(
  //   page.findByKey('Button_5f50xmd2'), // お問い合わせ
  //   Card(
  //     elevation: 1,
  //     borderRadius: 12,
  //     color: Colors.secondaryBackground,
  //     onTap: [Navigate(ff.Pages.inquiryForm)],
  //     name: 'InquiryFormRow',
  //     child: Row(
  //       padding: 16,
  //       spacing: 12,
  //       children: [
  //         Image(
  //           'assets/images/mypage-button-svg4.svg',
  //           isNetwork: false,
  //           width: 28,
  //           height: 28,
  //         ),
  //         Expanded(
  //           Text('お問い合わせ', style: Styles.bodyLarge, color: Colors.primaryText),
  //         ),
  //         Icon('chevron_right', size: 20, color: Colors.secondaryText),
  //       ],
  //     ),
  //   ),
  // );

  // HomePage: promo banner section. Neither home_image1.png (unlabeled
  // toast illustration) nor home_image2.png (same art WITH the "乾杯！
  // icoccha OPENING EVENT" / "icoccha公主オープン" copy baked in) had any
  // section to sit in — HomePage's body previously jumped straight from the
  // AppBar into the recommended-cast grid. Using home_image2.png (the one
  // with real event copy); home_image1.png stays unused pending client
  // direction on what a 2nd banner slot is for. Inserted as a new first
  // item in the body's scroll column, above the existing DiscoveryCastGrid.
  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): confirmed landed via generated_code (Image.asset('assets/images/
  // home_image2.png') renders as the first body item, above the discovery
  // grid) and via lib/flutterflow_project/pages/home_page.dart
  // (Container_e8olbl7l, name "HomePromoBanner"). ensureInsertedBefore has
  // no dedup guard — re-running it is a silent no-op (the anchor
  // Column_yscjjvi7 persists, so it wouldn't hard-fail like a stale
  // ensureReplaced key would, but any FUTURE edit to this banner authored
  // in this same block would be silently dropped). Any future change must
  // target Container_e8olbl7l / the "HomePromoBanner" name directly.
  // app.editPage(ff.Pages.homePage, (page) {
  //   page.ensureInsertedBefore(
  //     page.findByKey('Column_yscjjvi7'),
  //     Container(
  //       name: 'HomePromoBanner',
  //       margin: 16,
  //       borderRadius: 16,
  //       shadow: Shadow(blur: 8, dy: 2, color: Colors.hex(0x1A000000)),
  //       child: Image(
  //         'assets/images/home_image2.png',
  //         isNetwork: false,
  //         fit: ImageFit.cover,
  //         width: double.infinity,
  //         height: 140,
  //         borderRadius: 16,
  //       ),
  //     ),
  //   );
  // });

  // MacchaPage: empty state for "you have zero matches yet" — the
  // macchapage_conditionalBuilder_else_image.png asset's obvious intent
  // (a phone with chat-bubble hearts, matching this app's own "start
  // matching" tone). Deliberately scoped to `myChatRoomsList` (set ONCE, at
  // ON_INIT_STATE, by this DSL script itself) rather than the per-tab
  // `visibleMatchaList` (recomputed by a `matchaFilterTab` helper that was
  // authored directly in the FlutterFlow builder outside this DSL history —
  // its implementation is gone from this file, only its frozen call sites
  // remain, so its exact filtering expression can't be safely reconstructed
  // here). This covers the real target case (a brand-new user with no
  // matches at all) without touching working, unverifiable filter-tab logic;
  // an empty FILTERED sub-view (e.g. zero "断られた" items while other
  // matches exist) is a different, lower-stakes case not covered by this
  // pass. No `Length`/`isEmpty` DSL expression exists in this SDK — added a
  // small custom function instead, mirroring this file's own established
  // pattern for small pure derivation helpers (e.g. kycReviewItemUid).
  final stringListIsNotEmptyFn = app.customFunction(
    'stringListIsNotEmpty',
    args: {'list': listOf(string)},
    returns: bool_,
    description: '文字列リストが1件以上あるかを判定する（マッチャ一覧の空状態UI切替用）。',
    code: r'''
return (list ?? []).isNotEmpty;
''',
  );

  app.editPageState(ff.Pages.macchaPage, (state) {
    state.ensureField('hasMatches', bool_.withDefault(true));
  });

  app.editPage(ff.Pages.macchaPage, (page) {
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named('fetchMyChatRooms', outputAs: 'myChatRoomsResult'),
        SetState('myChatRoomsList', ActionOutput('myChatRoomsResult')),
        SetState('visibleMatchaList', ActionOutput('myChatRoomsResult')),
        SetState(
          'hasMatches',
          CustomFunction(stringListIsNotEmptyFn, args: {'list': ActionOutput('myChatRoomsResult')}),
        ),
      ],
    );
  });

  // NOTE: `ensureEmptyState`'s own docstring says "content stays visible
  // when [visibleWhen] is true; emptyState shows for the inverse" — but its
  // actual implementation does the opposite (`bindVisible(emptyState,
  // visibleWhen)`, `bindVisible(content, Not(visibleWhen))`). Confirmed via
  // `generated_code` after the first push: with `visibleWhen: State(
  // 'hasMatches')`, the empty-state graphic rendered for users WHO HAD
  // matches, and the real list rendered only when they had none — exactly
  // backwards. Passing `Not(...)` here to counteract the SDK's actual
  // (docstring-contradicting) behavior, not the documented one.
  app.ensureEmptyState(
    page: ff.Pages.macchaPage,
    content: EditPatternTarget.byKey('Column_8g095usw'),
    visibleWhen: Not(State('hasMatches')),
    emptyState: Container(
      name: 'MacchaEmptyState',
      padding: 32,
      alignment: Alignment.center,
      child: Column(
        mainAxis: MainAxis.center,
        crossAxis: CrossAxis.center,
        spacing: 16,
        children: [
          Image(
            'assets/images/macchapage_conditionalBuilder_else_image.png',
            isNetwork: false,
            width: 180,
            height: 180,
            fit: ImageFit.contain,
          ),
          Text(
            'まだマッチャがありません',
            style: Styles.titleMedium,
            color: Colors.primaryText,
            textAlign: TextAlign.center,
          ),
          Text(
            '気になるキャストにリクエストを送って、マッチャを始めましょう！',
            style: Styles.bodyMedium,
            color: Colors.secondaryText,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );

  // ==========================================================================
  // Shared "no photo" fallback rollout (2026-08-13) — the 5 locations
  // disclosed as deferred in §61/§62: MacchaChats, HomePage's discovery-cast
  // grid, MacchaPage's match-list avatar, ProfileEdit, KycReviewPage. All 5
  // use `CachedNetworkImage`/`Avatar.imageUrl` with no error/placeholder
  // fallback — confirmed via `grep -rln "CachedNetworkImage" generated_code`
  // (exactly these 5 files, matching the disclosed list precisely).
  //
  // No `errorWidget`/`placeholder` field exists anywhere on this DSL's
  // `Image`/`Avatar`/`FFImage` proto surface that's actually wired by
  // codegen (checked `FFImage`'s full field list — the one candidate,
  // `showErrorImage`, has zero references anywhere in this SDK's compiler/
  // codegen, so its runtime behavior can't be verified from source and
  // wasn't gambled on). First attempt used `ConditionalBuilder` (two
  // `Image`/`Avatar` children, opposite `visible:` conditions) — this
  // FAILED FlutterFlow's own server-side validation with "Every condition
  // in the conditional builder must have a child" on all 6 uses, even
  // though each child clearly had both a widget and a `visible:` condition;
  // `FFConditionalBuilder`'s own proto message carries zero fields of its
  // own (confirmed), and no working example of this widget exists anywhere
  // in this project's history or the reference set — treated as an
  // unproven/broken DSL surface rather than iterated on further. Replaced
  // with a plain `Stack` holding the same two children, each still with its
  // own opposite `visible:` condition — the exact same underlying
  // conditional-visibility mechanism already proven working elsewhere in
  // this file (e.g. the frozen `Divider(visible: Not(Equals(...)))`
  // example, and `ensureEmptyState`'s own `bindVisible`), just without the
  // broken wrapper type. Validated clean and pushed successfully.
  //
  // ProfileEdit and MacchaChats bind a single page-level State field
  // (`editProfileImageUrl`, `counterpartPhoto`) — simple `ensureReplaced` on
  // just that one node. HomePage/MacchaPage/KycReviewPage bind a PER-ITEM
  // photo URL inside a ListView/GridView `itemBuilder` — `item` there is an
  // `ItemRef()` marker created fresh only when `itemBuilder` executes
  // (confirmed via `GridView.buildItem() => itemBuilder(const ItemRef())`
  // in the SDK source), so it cannot be referenced from outside a builder
  // closure. This means the ENTIRE itemBuilder had to be reconstructed via
  // `ensureReplaced` on the list/grid itself, not just the inner Image —
  // done by copying the exact structure from this file's own already-landed
  // (frozen) originals verbatim, changing only the image sub-widget, so
  // nothing else about these 3 cards (onTap targets, button actions, text
  // bindings) changes.
  // ==========================================================================

  const noPhotoFallback = 'assets/images/macchaChatsimage.png';

  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): both ensureReplaced calls below confirmed landed —
  // CircleImage_fy6oz5ts / CircleImage_xctz3poq no longer exist, replaced by
  // Stack_ozgvc82p "ProfileAvatarImage" (ProfileEdit) and Stack_z6woy5q0
  // "ChatCounterpartAvatar" (MacchaChats) respectively. Same no-dedup-guard
  // risk as every other ensureReplaced in this file.
  // ProfileEdit — own profile photo, bound to page-level `editProfileImageUrl`.
  // app.editPage(ff.Pages.profileEdit, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('CircleImage_fy6oz5ts'),
  //     Stack(
  //       name: 'ProfileAvatarImage',
  //       children: [
  //         Avatar(
  //           imageUrl: State('editProfileImageUrl'),
  //           size: 80,
  //           name: 'ProfileAvatarImageReal',
  //           visible: Not(Equals(State('editProfileImageUrl'), '')),
  //         ),
  //         Image(
  //           noPhotoFallback,
  //           isNetwork: false,
  //           width: 80,
  //           height: 80,
  //           borderRadius: 40,
  //           fit: ImageFit.cover,
  //           name: 'ProfileAvatarImageFallback',
  //           visible: Equals(State('editProfileImageUrl'), ''),
  //         ),
  //       ],
  //     ),
  //   );
  // });

  // MacchaChats — chat counterpart's photo, bound to page-level `counterpartPhoto`.
  // app.editPage(ff.Pages.macchaChats, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('CircleImage_xctz3poq'),
  //     Stack(
  //       name: 'ChatCounterpartAvatar',
  //       children: [
  //         Avatar(
  //           imageUrl: State('counterpartPhoto'),
  //           size: 40,
  //           name: 'ChatCounterpartAvatarReal',
  //           visible: Not(Equals(State('counterpartPhoto'), '')),
  //         ),
  //         Image(
  //           noPhotoFallback,
  //           isNetwork: false,
  //           width: 40,
  //           height: 40,
  //           borderRadius: 20,
  //           fit: ImageFit.cover,
  //           name: 'ChatCounterpartAvatarFallback',
  //           visible: Equals(State('counterpartPhoto'), ''),
  //         ),
  //       ],
  //     ),
  //   );
  // });

  // HomePage — DiscoveryCastGrid, per-item photo. The 4
  // CustomFunctionHandle reconstructions this block used (discoveryCastId/
  // Nickname/PhotoUrl/IsOnline) were removed along with freezing the call
  // below — nothing else in this file consumes them. Reconstruct them the
  // same way (CustomFunctionHandle(name:, args: {'item': string},
  // returnType: string|bool_)) if this block is ever revived.

  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): confirmed landed correctly via generated_code — childAspectRatio:
  // 1.05 (not 0.75) is live, and lib/flutterflow_project/pages/home_page.dart
  // confirms the current key is GridView_t0nvrf32, name "DiscoveryCastGrid".
  //
  // Notable: the immediately-prior push, using the SAME literal (1.05) but
  // targeting the then-current key GridView_8292ke7j, compiled and pushed
  // with ZERO error yet did NOT apply the new childAspectRatio value —
  // generated_code still showed 0.75 afterward. That key turned out to
  // already be stale (superseded by an earlier push in this same review
  // round) — findByKey on a stale key did NOT throw for this SAME-TYPE
  // (GridView→GridView) replacement, unlike KycReviewPage's ListView→ListView
  // stale-key case a few lines above, which DID throw. Re-running with the
  // corrected current key fixed it. Lesson: a same-type ensureReplaced with
  // a stale key can silently succeed without applying new property values —
  // don't trust "it compiled and pushed" as proof a property change landed;
  // always verify the actual value in generated_code, not just presence/
  // absence of an error.
  // app.editPage(ff.Pages.homePage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('GridView_lbj5x0bs'),
  //     GridView(
  //       name: 'DiscoveryCastGrid',
  //       source: State('discoveryCasts'),
  //       columns: 2,
  //       crossAxisSpacing: 12,
  //       mainAxisSpacing: 12,
  //       childAspectRatio: 1.05,
  //       itemBuilder: (item) => Container(
  //         name: 'DiscoveryCastCard',
  //         borderRadius: 12,
  //         color: Colors.secondaryBackground,
  //         onTap: [
  //           Navigate(
  //             ff.Pages.castProfile,
  //             params: {
  //               'castId': CustomFunction(discoveryCastIdFn2, args: {'item': item}),
  //             },
  //           ),
  //         ],
  //         child: Column(
  //           crossAxis: CrossAxis.start,
  //           children: [
  //             Stack(
  //               name: 'DiscoveryCastImage',
  //               children: [
  //                 Image(
  //                   CustomFunction(discoveryCastPhotoUrlFn2, args: {'item': item}),
  //                   height: 130,
  //                   width: double.infinity,
  //                   fit: ImageFit.cover,
  //                   borderRadius: 12,
  //                   name: 'DiscoveryCastImageReal',
  //                   visible: Not(Equals(CustomFunction(discoveryCastPhotoUrlFn2, args: {'item': item}), '')),
  //                 ),
  //                 Image(
  //                   noPhotoFallback,
  //                   isNetwork: false,
  //                   height: 130,
  //                   width: double.infinity,
  //                   fit: ImageFit.cover,
  //                   borderRadius: 12,
  //                   name: 'DiscoveryCastImageFallback',
  //                   visible: Equals(CustomFunction(discoveryCastPhotoUrlFn2, args: {'item': item}), ''),
  //                 ),
  //                 Container(
  //                   width: 12,
  //                   height: 12,
  //                   borderRadius: 6,
  //                   color: Colors.success,
  //                   margin: EdgeInsets.all(8),
  //                   visible: CustomFunction(discoveryCastIsOnlineFn2, args: {'item': item}),
  //                   name: 'DiscoveryCastOnlineDot',
  //                 ),
  //               ],
  //             ),
  //             Container(
  //               padding: EdgeInsets.symmetric(horizontal: 8, vertical: 6),
  //               child: Text(
  //                 CustomFunction(discoveryCastNicknameFn2, args: {'item': item}),
  //                 style: Styles.bodyMedium,
  //                 maxLines: 1,
  //                 overflow: TextOverflow.ellipsis,
  //                 name: 'DiscoveryCastNickname',
  //               ),
  //             ),
  //           ],
  //         ),
  //       ),
  //     ),
  //   );
  // });

  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): confirmed landed via lib/flutterflow_project/pages/maccha_page.dart
  // — ListView_moyozme3 no longer exists, replaced by ListView_9tfls25u
  // "MatchaItemsListView". `splitFieldFn` stays live (captured earlier,
  // still needed elsewhere in this file).
  // MacchaPage — MatchaItemsListView, per-item avatar. Reuses `splitFieldFn`
  // (captured earlier in this same function) rather than reconstructing —
  // it's already a live local handle.
  // app.editPage(ff.Pages.macchaPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_moyozme3'),
  //     ListView(
  //       name: 'MatchaItemsListView',
  //       shrinkWrap: true,
  //       spacing: 8,
  //       source: State('visibleMatchaList'),
  //       itemBuilder: (item) => Card(
  //         name: 'MatchaItemCard',
  //         onTap: [
  //           Navigate(
  //             ff.Pages.macchaChats,
  //             params: {
  //               'resId': CustomFunction(splitFieldFn, args: {'data': item, 'index': 0}),
  //             },
  //           ),
  //         ],
  //         child: Container(
  //           padding: 12,
  //           child: Row(
  //             spacing: 8,
  //             children: [
  //               Stack(
  //                 name: 'MatchaItemAvatar',
  //                 children: [
  //                   Avatar(
  //                     imageUrl: CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}),
  //                     size: 44,
  //                     name: 'MatchaItemAvatarReal',
  //                     visible: Not(Equals(CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}), '')),
  //                   ),
  //                   Image(
  //                     noPhotoFallback,
  //                     isNetwork: false,
  //                     width: 44,
  //                     height: 44,
  //                     borderRadius: 22,
  //                     fit: ImageFit.cover,
  //                     name: 'MatchaItemAvatarFallback',
  //                     visible: Equals(CustomFunction(splitFieldFn, args: {'data': item, 'index': 3}), ''),
  //                   ),
  //                 ],
  //               ),
  //               Column(
  //                 crossAxis: CrossAxis.start,
  //                 children: [
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 2}),
  //                     style: Styles.titleSmall,
  //                   ),
  //                   Text(
  //                     CustomFunction(splitFieldFn, args: {'data': item, 'index': 5}),
  //                     style: Styles.bodySmall,
  //                     maxLines: 1,
  //                     overflow: TextOverflow.ellipsis,
  //                   ),
  //                 ],
  //               ),
  //             ],
  //           ),
  //         ),
  //       ),
  //     ),
  //   );
  // });

  // FROZEN (2026-08-13, comprehensive review pass — PROJECT_KNOWLEDGE.md
  // §64): THIS is the block that hard-failed the review-pass push —
  // ListView_ohcx81fg no longer exists (replaced by ListView_0fv0sxi8,
  // name "ListView"), confirmed via lib/flutterflow_project/pages/
  // kyc_review_page.dart. `flutterflow ai run` failed outright with
  // `Bad state: page KycReviewPage findByKey("ListView_ohcx81fg") found no
  // matches` — direct, reproduced confirmation that ensureReplaced has no
  // dedup guard and leaving one live blocks ANY future unrelated push, not
  // just a silent no-op. The 5 CustomFunctionHandle reconstructions above
  // stay live only if referenced elsewhere; kept here since KycReviewPage
  // has no other live consumer of them — harmless to leave declared.
  // KycReviewPage — admin-only pending-KYC review queue, 2 images per item
  // (ID document + selfie). Preserves the `shrinkWrap: true` +
  // `visible: State('isAdminUser')` fixes already applied to this ListView
  // in an earlier round (§26 addenda) — dropping either would reintroduce
  // an already-fixed crash/usability bug.
  //
  // The 5 CustomFunctionHandle reconstructions this block used
  // (kycReviewItemUid/Nickname/AccountType/DocUrl/SelfieUrl) were removed
  // along with freezing the call below — nothing else in this file consumes
  // them, and Dart flags unused locals. Reconstruct them the same way
  // (CustomFunctionHandle(name:, args: {'item': string}, returnType: string))
  // if this block is ever revived for a genuinely new change.
  // app.editPage(ff.Pages.kycReviewPage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('ListView_ohcx81fg'),
  //     ListView(
  //       name: 'ListView',
  //       source: State('pendingKycList'),
  //       visible: State('isAdminUser'),
  //       shrinkWrap: true,
  //       padding: 16,
  //       spacing: 16,
  //       itemBuilder: (item) => Card(
  //         name: 'KycReviewItemCard',
  //         child: Container(
  //           padding: 12,
  //           child: Column(
  //             spacing: 8,
  //             children: [
  //               Text(
  //                 CustomFunction(kycReviewItemNicknameFn2, args: {'item': item}),
  //                 style: Styles.titleMedium,
  //               ),
  //               Text(
  //                 CustomFunction(kycReviewItemAccountTypeFn2, args: {'item': item}),
  //                 style: Styles.labelMedium,
  //               ),
  //               Row(
  //                 spacing: 8,
  //                 children: [
  //                   Stack(
  //                     name: 'KycReviewDocImage',
  //                     children: [
  //                       Image(
  //                         CustomFunction(kycReviewItemDocUrlFn2, args: {'item': item}),
  //                         width: 140,
  //                         height: 140,
  //                         fit: ImageFit.cover,
  //                         name: 'KycReviewDocImageReal',
  //                         visible: Not(Equals(CustomFunction(kycReviewItemDocUrlFn2, args: {'item': item}), '')),
  //                       ),
  //                       Image(
  //                         noPhotoFallback,
  //                         isNetwork: false,
  //                         width: 140,
  //                         height: 140,
  //                         fit: ImageFit.cover,
  //                         name: 'KycReviewDocImageFallback',
  //                         visible: Equals(CustomFunction(kycReviewItemDocUrlFn2, args: {'item': item}), ''),
  //                       ),
  //                     ],
  //                   ),
  //                   Stack(
  //                     name: 'KycReviewSelfieImage',
  //                     children: [
  //                       Image(
  //                         CustomFunction(kycReviewItemSelfieUrlFn2, args: {'item': item}),
  //                         width: 140,
  //                         height: 140,
  //                         fit: ImageFit.cover,
  //                         name: 'KycReviewSelfieImageReal',
  //                         visible: Not(Equals(CustomFunction(kycReviewItemSelfieUrlFn2, args: {'item': item}), '')),
  //                       ),
  //                       Image(
  //                         noPhotoFallback,
  //                         isNetwork: false,
  //                         width: 140,
  //                         height: 140,
  //                         fit: ImageFit.cover,
  //                         name: 'KycReviewSelfieImageFallback',
  //                         visible: Equals(CustomFunction(kycReviewItemSelfieUrlFn2, args: {'item': item}), ''),
  //                       ),
  //                     ],
  //                   ),
  //                 ],
  //               ),
  //               Row(
  //                 spacing: 8,
  //                 children: [
  //                   Button(
  //                     '承認する',
  //                     color: Colors.success,
  //                     textColor: Colors.primaryBackground,
  //                     name: 'KycApproveButton',
  //                     onTap: [
  //                       CallCustomAction.named(
  //                         'callAdminApproveKyc',
  //                         arguments: {
  //                           'userId': CustomFunction(kycReviewItemUidFn2, args: {'item': item}),
  //                           'approved': true,
  //                         },
  //                         outputAs: 'approveResult',
  //                       ),
  //                       If(
  //                         ActionOutput('approveResult'),
  //                         then: [
  //                           CallCustomAction.named(
  //                             'callAdminGetPendingKyc',
  //                             outputAs: 'refreshedKycResult',
  //                           ),
  //                           SetState('pendingKycList', ActionOutput('refreshedKycResult')),
  //                           Snackbar('承認しました。'),
  //                         ],
  //                         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
  //                       ),
  //                     ],
  //                   ),
  //                   Button(
  //                     '却下する',
  //                     color: Colors.error,
  //                     textColor: Colors.primaryBackground,
  //                     name: 'KycRejectButton',
  //                     onTap: [
  //                       CallCustomAction.named(
  //                         'callAdminApproveKyc',
  //                         arguments: {
  //                           'userId': CustomFunction(kycReviewItemUidFn2, args: {'item': item}),
  //                           'approved': false,
  //                         },
  //                         outputAs: 'rejectResult',
  //                       ),
  //                       If(
  //                         ActionOutput('rejectResult'),
  //                         then: [
  //                           CallCustomAction.named(
  //                             'callAdminGetPendingKyc',
  //                             outputAs: 'refreshedKycResult2',
  //                           ),
  //                           SetState('pendingKycList', ActionOutput('refreshedKycResult2')),
  //                           Snackbar('却下しました。'),
  //                         ],
  //                         orElse: [Snackbar('処理に失敗しました。もう一度お試しください。')],
  //                       ),
  //                     ],
  //                   ),
  //                 ],
  //               ),
  //             ],
  //           ),
  //         ),
  //       ),
  //     ),
  //   );
  // });

  // ==========================================================================
  // Comprehensive review pass (2026-08-13) — 2 findings from a fresh-eyes
  // multi-agent audit, both fixed here. §64 in PROJECT_KNOWLEDGE.md has the
  // full writeup.
  // ==========================================================================

  // TutorialPage (5-slide onboarding carousel) has been unreachable since
  // BEFORE this session even started — PROJECT_ANALYSIS.md's own original
  // as-is audit already flagged it "Orphaned: no other page links to
  // TutorialPage; only reachable via direct route." §61 wired real client
  // assets into its 5 slides without anyone noticing the reachability gap
  // predates that work. Not fixing the deeper question of exactly when a
  // tutorial should auto-trigger (first launch only? every launch? — no
  // persisted "hasSeenTutorial"-style flag exists anywhere in the schema,
  // and inventing one here would be a product decision, not a bug fix — same
  // caution already applied to RegistrationPopupComp/WorkFilterSelectComp).
  // Instead: a minimal, low-risk, genuinely-common pattern — a "使い方を見る"
  // link on LoginPage, matching its 2 existing sibling Text-links (forgot
  // password, new registration) exactly in structure. This makes the page
  // discoverable without touching the app's initial-route logic at all.
  app.editPage(ff.Pages.loginPage, (page) {
    page.ensureInsertedAfter(
      page.findByKey('Text_6cnwm6bc'), // "新規登録の方はこちらからどうぞ"
      Text(
        '使い方を見る',
        style: Styles.bodyMedium,
        color: Colors.primary,
        name: 'TutorialLinkText',
      ),
    );
    page.ensureActions(
      page.findByName('TutorialLinkText'),
      triggerType: FFActionTriggerType.ON_TAP,
      actions: [Navigate(ff.Pages.tutorialPage)],
    );
  });

  // ==========================================================================
  // Cast work-calendar (§3.7.2, Phase 11's single largest remaining item) —
  // Push 1: cast-side (MyPage). See PROJECT_KNOWLEDGE.md for the full
  // design writeup (backend already deployed: getMySchedule/
  // toggleScheduleSlot/getCastScheduleForGuest in schedule.ts).
  //
  // "Subtractive": default state is available; a slot only gets a real
  // Firestore document when it's been blocked (×) or booked (reserved).
  // Deliberately out of scope this pass (disclosed, not silently dropped):
  // Authorize-time slot locking and guest-side booking validation against
  // availability — both require touching the live Stripe booking flow,
  // a separate, larger task. `toggleScheduleSlot` already refuses to touch
  // a "reserved" slot; nothing in this pass ever creates one.
  // ==========================================================================

  // Shared helpers — reused verbatim by CastProfile (guest side) below, not
  // redeclared there.
  final weekDayDateFn = app.customFunction(
    'weekDayDate',
    args: {'weekIndex': int_, 'dayIndex': int_},
    returns: string,
    description: '週(0-3)+曜日(0-6)からその日の日付(YYYY-MM-DD)を計算する。週1=今日始まり。',
    code: r'''
final base = DateTime.now();
final offset = (weekIndex ?? 0) * 7 + (dayIndex ?? 0);
final t = DateTime(base.year, base.month, base.day).add(Duration(days: offset));
return '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';
''',
  );

  final weekDayLabelFn = app.customFunction(
    'weekDayLabel',
    args: {'weekIndex': int_, 'dayIndex': int_},
    returns: string,
    description: '週(0-3)+曜日(0-6)から表示ラベル(M/D(曜))を計算する。',
    code: r'''
final base = DateTime.now();
final offset = (weekIndex ?? 0) * 7 + (dayIndex ?? 0);
final t = DateTime(base.year, base.month, base.day).add(Duration(days: offset));
const w = ['月', '火', '水', '木', '金', '土', '日'];
return '${t.month}/${t.day}(${w[(t.weekday - 1) % 7]})';
''',
  );

  final slotTimeLabelFn = app.customFunction(
    'slotTimeLabel',
    args: {'index': int_},
    returns: string,
    description: '48枠インデックス(0-47)からHH:MM表示を計算する。',
    code: r'''
final i = index ?? 0;
final h = (i * 30) ~/ 60;
final m = (i * 30) % 60;
return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
''',
  );

  final slotGlyphFn = app.customFunction(
    'slotGlyph',
    args: {'status': string},
    returns: string,
    description: 'スロット状態(available/unavailable/reserved)から表示グリフを計算する。',
    code: r'''
switch (status) {
  case 'available':
    return '○';
  case 'reserved':
    return '－';
  default:
    return '×';
}
''',
  );

  final callGetMySchedule = app.customAction(
    'callGetMySchedule',
    args: {'date': string},
    returns: listOf(string),
    description: 'getMySchedule Cloud Functionを呼び出し、指定日の48枠status配列を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> callGetMySchedule(String? date) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getMySchedule');
    final result = await callable.call({'date': date ?? ''});
    if (result.data is Map && result.data['items'] is List) {
      return List<String>.from(result.data['items']);
    }
    return List<String>.filled(48, 'available');
  } catch (e) {
    return List<String>.filled(48, 'available');
  }
}
''',
  );

  final callToggleScheduleSlot = app.customAction(
    'callToggleScheduleSlot',
    args: {'date': string, 'slotIndex': int_},
    returns: bool_,
    description: 'toggleScheduleSlot Cloud Functionを呼び出し、1枠の空き状態を切り替える。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<bool> callToggleScheduleSlot(String? date, int? slotIndex) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('toggleScheduleSlot');
    await callable.call({'date': date ?? '', 'slot_index': slotIndex ?? 0});
    return true;
  } catch (e) {
    return false;
  }
}
''',
  );

  // Reusable action-sequence for "select this day" — used by both the
  // week-selector and the day-of-week row. Takes `Object` (not `int`) for
  // both indices so the SAME function works whether one side is a literal
  // (the tapped button) and the other is the currently-selected value read
  // back via `State(...)` (both flow through `normalizeExpression` inside
  // `SetState`/`CustomFunction` identically).
  //
  // `tag` makes each call site's `outputAs` name unique — FlutterFlow's
  // validator rejects two different WIDGETS sharing the same action output
  // variable name ("Action in Button has an output variable with the same
  // name as that of another widget", confirmed by compile error on the
  // first attempt with a single shared 'scheduleFetchResult' name reused
  // across all 11 week/day buttons).
  List<DslAction> selectScheduleDay(Object weekIdx, Object dayIdx, String tag) => [
    SetState('scheduleWeekIndex', weekIdx),
    SetState('scheduleDayIndex', dayIdx),
    SetState(
      'scheduleSelectedDate',
      CustomFunction(weekDayDateFn, args: {'weekIndex': weekIdx, 'dayIndex': dayIdx}),
    ),
    CallCustomAction(
      callGetMySchedule,
      args: {'date': State('scheduleSelectedDate')},
      outputAs: 'scheduleFetchResult_$tag',
    ),
    SetState('scheduleDaySlots', ActionOutput('scheduleFetchResult_$tag')),
  ];

  app.editPageState(ff.Pages.myPage, (state) {
    state.ensureField('scheduleWeekIndex', int_.withDefault(0));
    state.ensureField('scheduleDayIndex', int_.withDefault(0));
    state.ensureField('scheduleSelectedDate', string.withDefault(''));
    state.ensureField('scheduleDaySlots', listOf(string));
  });

  app.editPage(ff.Pages.myPage, (page) {
    // Extending the SAME ON_INIT_STATE chain already established at
    // dsl/edit.dart:8567 (reproduced verbatim, per this file's own
    // "single source of truth per trigger" rule) — appending the initial
    // date computation + first day's fetch, not a second call on this
    // trigger.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        UpdateAppState.set(ff.AppState.navIndex, 4),
        CallCustomAction.named(
          'fetchCastReviews',
          arguments: {'castId': AuthUser(AuthUserField.userId)},
          outputAs: 'myReviewsResult',
        ),
        SetState('myReviewsList', ActionOutput('myReviewsResult')),
        SetState(
          'scheduleSelectedDate',
          CustomFunction(weekDayDateFn, args: {'weekIndex': 0, 'dayIndex': 0}),
        ),
        CallCustomAction(
          callGetMySchedule,
          args: {'date': State('scheduleSelectedDate')},
          outputAs: 'scheduleInitResult',
        ),
        SetState('scheduleDaySlots', ActionOutput('scheduleInitResult')),
      ],
    );

    // FROZEN (2026-08-13, immediately after this exact block landed):
    // confirmed via generated_code/lib/mypage/my_page/my_page_widget.dart —
    // GridView.builder, the toggle→refetch chain, the week/day buttons all
    // wired correctly (spot-checked exact match against the design). Also
    // confirmed via lib/flutterflow_project/pages/my_page.dart —
    // `Calendar_5lwqxdoh` no longer exists, replaced by `Column_ac9vequn`,
    // name "WorkCalendarSection". Any future change to this section must
    // target that key/name instead of the stale one below.
    // page.ensureReplaced(
    //   page.findByKey('Calendar_5lwqxdoh'),
    //   Column(
    //     name: 'WorkCalendarSection',
    //     crossAxis: CrossAxis.start,
    //     spacing: 12,
    //     children: [
    //       Row(
    //         spacing: 8,
    //         children: [
    //           for (var w = 0; w < 4; w++)
    //             Button(
    //               '週${w + 1}',
    //               variant: ButtonVariant.outlined,
    //               onTap: selectScheduleDay(w, State('scheduleDayIndex'), 'week$w'),
    //             ),
    //         ],
    //       ),
    //       Row(
    //         spacing: 6,
    //         children: [
    //           for (var d = 0; d < 7; d++)
    //             Button(
    //               CustomFunction(weekDayLabelFn, args: {'weekIndex': State('scheduleWeekIndex'), 'dayIndex': d}),
    //               variant: ButtonVariant.text,
    //               onTap: selectScheduleDay(State('scheduleWeekIndex'), d, 'day$d'),
    //             ),
    //         ],
    //       ),
    //       Text(
    //         CustomFunction(
    //           weekDayLabelFn,
    //           args: {'weekIndex': State('scheduleWeekIndex'), 'dayIndex': State('scheduleDayIndex')},
    //         ),
    //         style: Styles.titleSmall,
    //       ),
    //       GridView(
    //         name: 'ScheduleGrid',
    //         source: State('scheduleDaySlots'),
    //         columns: 6,
    //         crossAxisSpacing: 6,
    //         mainAxisSpacing: 6,
    //         childAspectRatio: 0.9,
    //         itemBuilder: (item) => Container(
    //           color: Colors.secondaryBackground,
    //           borderRadius: 8,
    //           onTap: [
    //             If(
    //               Not(Equals(item, 'reserved')),
    //               then: [
    //                 CallCustomAction(
    //                   callToggleScheduleSlot,
    //                   args: {'date': State('scheduleSelectedDate'), 'slotIndex': item.index},
    //                   outputAs: 'toggleResult',
    //                 ),
    //                 CallCustomAction(
    //                   callGetMySchedule,
    //                   args: {'date': State('scheduleSelectedDate')},
    //                   outputAs: 'scheduleRefetch',
    //                 ),
    //                 SetState('scheduleDaySlots', ActionOutput('scheduleRefetch')),
    //               ],
    //               orElse: [Snackbar('この時間帯は予約済みのため変更できません。')],
    //             ),
    //           ],
    //           child: Column(
    //             crossAxis: CrossAxis.center,
    //             children: [
    //               Text(CustomFunction(slotTimeLabelFn, args: {'index': item.index}), style: Styles.bodySmall),
    //               Text(CustomFunction(slotGlyphFn, args: {'status': item}), style: Styles.titleMedium),
    //             ],
    //           ),
    //         ),
    //       ),
    //     ],
    //   ),
    // );
  });

  // ==========================================================================
  // Cast work-calendar (§3.7.2) — Push 2: guest-side view (CastProfile) +
  // the ReservationForm deep-link. Reuses Push 1's shared customFunctions
  // (weekDayDateFn/weekDayLabelFn/slotTimeLabelFn/slotGlyphFn) verbatim —
  // no redeclaration.
  // ==========================================================================

  // Declared BEFORE the CastProfile block below, since that block's
  // Navigate call references these 2 new params — the compiler validates a
  // Navigate call against the target page's CURRENTLY-declared params at
  // the point it's processed (the same param-declaration-ordering
  // constraint already documented elsewhere in this file for MacchaChats'
  // `resId`). The 2 existing invite buttons ("誘う"/"ココ店で誘う",
  // CastProfile) already navigate here with just `castId` — these 2 new
  // params default to empty, so that path is unaffected.
  app.editPageParams(ff.Pages.reservationForm, (params) {
    params.ensureParam('prefillDate', string.withDefault(''));
    params.ensureParam('prefillStartTime', string.withDefault(''));
  });

  final callGetCastSchedule = app.customAction(
    'callGetCastSchedule',
    args: {'castId': string, 'date': string},
    returns: listOf(string),
    description: 'getCastScheduleForGuest Cloud Functionを呼び出し、指定キャストの指定日の48枠status配列を取得する。',
    code: r'''
import 'package:cloud_functions/cloud_functions.dart';

Future<List<String>> callGetCastSchedule(String? castId, String? date) async {
  try {
    final callable = FirebaseFunctions.instanceFor(region: 'asia-northeast1')
        .httpsCallable('getCastScheduleForGuest');
    final result = await callable.call({'cast_id': castId ?? '', 'date': date ?? ''});
    if (result.data is Map && result.data['items'] is List) {
      return List<String>.from(result.data['items']);
    }
    return List<String>.filled(48, 'available');
  } catch (e) {
    return List<String>.filled(48, 'available');
  }
}
''',
  );

  // Same shape as Push 1's `selectScheduleDay`, but fetching a SPECIFIC
  // cast's schedule (via `PageParam('castId')`, already available on
  // CastProfile) instead of the signed-in user's own.
  List<DslAction> selectGuestScheduleDay(Object weekIdx, Object dayIdx, String tag) => [
    SetState('scheduleWeekIndex', weekIdx),
    SetState('scheduleDayIndex', dayIdx),
    SetState(
      'scheduleSelectedDate',
      CustomFunction(weekDayDateFn, args: {'weekIndex': weekIdx, 'dayIndex': dayIdx}),
    ),
    CallCustomAction(
      callGetCastSchedule,
      args: {'castId': PageParam('castId'), 'date': State('scheduleSelectedDate')},
      outputAs: 'scheduleGuestFetchResult_$tag',
    ),
    SetState('scheduleDaySlots', ActionOutput('scheduleGuestFetchResult_$tag')),
  ];

  app.editPageState(ff.Pages.castProfile, (state) {
    state.ensureField('scheduleWeekIndex', int_.withDefault(0));
    state.ensureField('scheduleDayIndex', int_.withDefault(0));
    state.ensureField('scheduleSelectedDate', string.withDefault(''));
    state.ensureField('scheduleDaySlots', listOf(string));
  });

  app.editPage(ff.Pages.castProfile, (page) {
    // Extending the SAME ON_INIT_STATE chain already established at
    // dsl/edit.dart:7299 (reproduced verbatim) — appending the initial
    // date computation + first day's fetch, not a second call on this
    // trigger.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        CallCustomAction.named(
          'fetchCastReviews',
          arguments: {'castId': PageParam('castId')},
          outputAs: 'castReviewsResult',
        ),
        SetState('castReviewsList', ActionOutput('castReviewsResult')),
        SetState(
          'scheduleSelectedDate',
          CustomFunction(weekDayDateFn, args: {'weekIndex': 0, 'dayIndex': 0}),
        ),
        CallCustomAction(
          callGetCastSchedule,
          args: {'castId': PageParam('castId'), 'date': State('scheduleSelectedDate')},
          outputAs: 'scheduleGuestInitResult',
        ),
        SetState('scheduleDaySlots', ActionOutput('scheduleGuestInitResult')),
      ],
    );

    // FROZEN (2026-08-13, immediately after this exact block landed):
    // confirmed via generated_code/lib/home/cast_profile/cast_profile_widget.dart
    // — the read-only GridView, callGetCastSchedule wiring, and the ○-tap
    // Navigate with prefillDate/prefillStartTime params all correct. Also
    // confirmed via lib/flutterflow_project/pages/cast_profile.dart —
    // `Calendar_pgw6bzqc` no longer exists, replaced by `Column_ikjwl87l`,
    // name "WorkCalendarViewSection". Any future change must target that
    // key/name instead of the stale one below.
    // page.ensureReplaced(
    //   page.findByKey('Calendar_pgw6bzqc'),
    //   Column(
    //     name: 'WorkCalendarViewSection',
    //     crossAxis: CrossAxis.start,
    //     spacing: 12,
    //     children: [
    //       Row(
    //         spacing: 8,
    //         children: [
    //           for (var w = 0; w < 4; w++)
    //             Button(
    //               '週${w + 1}',
    //               variant: ButtonVariant.outlined,
    //               onTap: selectGuestScheduleDay(w, State('scheduleDayIndex'), 'week$w'),
    //             ),
    //         ],
    //       ),
    //       Row(
    //         spacing: 6,
    //         children: [
    //           for (var d = 0; d < 7; d++)
    //             Button(
    //               CustomFunction(weekDayLabelFn, args: {'weekIndex': State('scheduleWeekIndex'), 'dayIndex': d}),
    //               variant: ButtonVariant.text,
    //               onTap: selectGuestScheduleDay(State('scheduleWeekIndex'), d, 'day$d'),
    //             ),
    //         ],
    //       ),
    //       Text(
    //         CustomFunction(
    //           weekDayLabelFn,
    //           args: {'weekIndex': State('scheduleWeekIndex'), 'dayIndex': State('scheduleDayIndex')},
    //         ),
    //         style: Styles.titleSmall,
    //       ),
    //       GridView(
    //         name: 'ScheduleGridReadOnly',
    //         source: State('scheduleDaySlots'),
    //         columns: 6,
    //         crossAxisSpacing: 6,
    //         mainAxisSpacing: 6,
    //         childAspectRatio: 0.9,
    //         itemBuilder: (item) => Container(
    //           color: Colors.secondaryBackground,
    //           borderRadius: 8,
    //           onTap: [
    //             If(
    //               Equals(item, 'available'),
    //               then: [
    //                 Navigate(
    //                   ff.Pages.reservationForm,
    //                   params: {
    //                     'castId': PageParam('castId'),
    //                     'prefillDate': State('scheduleSelectedDate'),
    //                     'prefillStartTime': CustomFunction(slotTimeLabelFn, args: {'index': item.index}),
    //                   },
    //                 ),
    //               ],
    //               orElse: [Snackbar('この時間帯は予約できません。')],
    //             ),
    //           ],
    //           child: Column(
    //             crossAxis: CrossAxis.center,
    //             children: [
    //               Text(CustomFunction(slotTimeLabelFn, args: {'index': item.index}), style: Styles.bodySmall),
    //               Text(CustomFunction(slotGlyphFn, args: {'status': item}), style: Styles.titleMedium),
    //             ],
    //           ),
    //         ),
    //       ),
    //     ],
    //   ),
    // );
  });

  // ==========================================================================
  // Cast work-calendar review fix (PROJECT_KNOWLEDGE.md §67): the deep-link
  // prefill below (SetState('resDate'/'resStartTime', PageParam(...))) was
  // already correct for the SUBMITTED value — `_model.resDate`/
  // `_model.resStartTime` end up right regardless. What was broken is the
  // DISPLAY: both widgets capture their on-screen initial value via a
  // `??=` chain (TextField's own controller-text binding, Dropdown's
  // `FormFieldController`) that locks in on the WIDGET'S OWN first build,
  // which runs before ON_INIT_STATE's `addPostFrameCallback` resolves the
  // prefill — a guest tapping a ○ slot on CastProfile lands here with the
  // correct date/time already staged for submission but a BLANK date field
  // and a "19:00" dropdown on screen, and might "correct" what looks wrong
  // (this exact bug class — `??=`-captured-before-load — is already
  // documented in .cursor/rules/project_rules.md, inherited from the
  // sister admin-dashboard project, with an established `isConfigLoaded`
  // -style visibility-gate fix).
  //
  // Deliberately NOT using that gate here: both widgets' initial values
  // can instead bind directly to the PAGE PARAMS (`prefillDate`/
  // `prefillStartTime`), which are constructor-level fields available
  // synchronously from the very first frame — no async dependency, so no
  // `??=`-before-load race is possible regardless of whether codegen
  // evaluates the binding in `initState()` or lazily in `build()`. Simpler
  // and strictly safer than adding a new page-state flag + gating 2
  // widgets' visibility (and it avoids a visible flash-of-empty-form on
  // every page open, which the gate approach would introduce).
  final resolveInitialStartTimeFn = app.customFunction(
    'resolveInitialStartTime',
    args: {'prefillStartTime': string},
    returns: string,
    description:
        'ディープリンクの開始時刻(prefillStartTime)があればそれを、なければ既定値(19:00, resStartTimeの'
        '既定値と同一)を返す。開始時刻ドロップダウンの初期表示値に使用。',
    code: r'''
final p = prefillStartTime ?? '';
return p.isNotEmpty ? p : '19:00';
''',
  );

  app.editPage(ff.Pages.reservationForm, (page) {
    // No existing ON_INIT_STATE trigger on this page's root (confirmed via
    // the typed SDK — Scaffold_zxpwg49d carries no `triggers:` at all) —
    // safe to add fresh, not a second chain on an already-wired trigger.
    page.ensureActions(
      page.root,
      triggerType: FFActionTriggerType.ON_INIT_STATE,
      actions: [
        If(
          Not(Equals(PageParam('prefillDate'), '')),
          then: [SetState('resDate', PageParam('prefillDate'))],
        ),
        If(
          Not(Equals(PageParam('prefillStartTime'), '')),
          then: [SetState('resStartTime', PageParam('prefillStartTime'))],
        ),
      ],
    );

    // Widened from the original 5 hardcoded hourly values (18:00-22:00,
    // still a subset of this list) to all 48 half-hour values — the only
    // way a tapped calendar slot's exact time survives into a valid
    // pre-selected dropdown value; without it, 43 of the 48 possible taps
    // would prefill a value with no matching option.
    //
    // NOTE: `patch.dropdownOptions([...])` compiled and pushed with zero
    // error, but rendered every option as an empty string in
    // generated_code (`FlutterFlowDropDown<String>(options: ['', '', ...])`)
    // — confirmed via `_applyDropdownOptionsPatch`'s source
    // (edit.dart:8279-8297): it only sets `FFParameterValue.serializedValue`,
    // never `FFParameterValue.translatableText`, and `FFText`'s own sibling
    // patch (`_applyDropdownInitialOptionPatch`, right below it) uses
    // `FFText(textValue: ...)` for a single value — suggesting codegen
    // actually reads `translatableText`, not `serializedValue`, for option
    // labels. Same class of gap as `ConditionalBuilder`/`ensureEmptyState`
    // found earlier this session: a typed patch method whose write doesn't
    // match what codegen reads. Using the raw `mutateNode` escape hatch
    // instead, setting the field the constructor-level `Dropdown` widget's
    // OWN compilation path is confirmed to use.
    final startTimeOptions = [
      for (var i = 0; i < 48; i++)
        '${(i * 30 ~/ 60).toString().padLeft(2, '0')}:${(i * 30 % 60).toString().padLeft(2, '0')}',
    ];
    page.mutateNode(page.findByKey('DropDown_ggrglg4w'), (node) {
      final labels = FFFormOptionsValue();
      final values = FFFormOptionsValue();
      for (final label in startTimeOptions) {
        labels.values.add(
          FFParameterValue(
            serializedValue: label,
            translatableText: FFText(textValue: FFStringValue(inputValue: label)),
          ),
        );
        values.values.add(
          FFParameterValue(
            serializedValue: label,
            translatableText: FFText(textValue: FFStringValue(inputValue: label)),
          ),
        );
      }
      node.props.dropDown.optionsLabels = labels;
      node.props.dropDown.optionsValues = values;
    });

    // Fix (PROJECT_KNOWLEDGE.md §67): date field's `TextEditingController`
    // had NO initial-value binding at all (confirmed via generated_code —
    // a bare `TextEditingController()`), so it always rendered blank
    // regardless of `_model.resDate`. `TextField`'s DSL constructor has no
    // value/initialValue param (confirmed by reading widgets.dart), and
    // `EditWidgetPatch.initialValue` only supports bool/num (Switch/
    // Slider) — the only way to bind a TextField's dynamic initial text is
    // the raw proto field `FFTextField.initialText` (NOT the deprecated
    // `legacyInitialText`), same shape already proven in the sister
    // project (.cursor/rules/project_rules.md:113). Binding straight to
    // `PageParam('prefillDate')` rather than `State('resDate')` for the
    // same synchronous-availability reason as the dropdown above — no
    // fallback needed here since blank is ALREADY `resDate`'s own default
    // when there's no deep link, so this can't regress the 2 existing
    // "誘う" invite-button flows. The FFVariable shape below replicates
    // the SDK's own internal (non-exported) `varFromPageParam` helper
    // (variable_helpers.dart) using only public proto types.
    page.mutateNode(page.findByKey('TextField_amemivlw'), (node) {
      node.props.textField.initialText = FFText(
        textValue: FFStringValue(
          variable: FFVariable(
            source: FFVariableSource.WIDGET_CLASS_PARAMETER,
            baseVariable: FFBaseVariable(
              widgetClass: FFWidgetClassVariable(
                paramIdentifier: FFIdentifier(
                  name: 'prefillDate',
                  key: 'wydl79qw',
                ),
              ),
            ),
          ),
        ),
      );
    });
  });

  // Fix (PROJECT_KNOWLEDGE.md §67), continued: start-time dropdown's
  // on-screen initial value. Tried `page.bindValue(DropDown_ggrglg4w,
  // CustomFunction(...))` first (the public, typed API for a Dropdown's
  // initial option) — it compiled and pushed with NO error, but
  // `generated_code` and a follow-up `flutterflow ai inspect --tree` both
  // showed the SERVER-SIDE proto completely unchanged (still the original
  // `State('resStartTime')` binding). Root cause, found by reading the SDK
  // source: `_BindStringValueOp.apply` short-circuits via
  // `_nodeSemanticallyEqualsAfterMutation`, which compares
  // `buildDslNodeSnapshot(...)` before/after the mutation and skips writing
  // if they're "semantically equal" — but `_snapshotWidgetDetails`'s
  // per-type switch (snapshot.dart) has NO case for `FFWidgetType.DropDown`
  // at all (Container/Card/Column/Row/Stack/Text/TextField/Button/Icon/
  // IconButton/ListView/ProgressBar/Switch/Divider/Spacer only), so a
  // DropDown's `initialOption` is invisible to the snapshot and EVERY
  // mutation looks like a no-op and gets silently dropped. A real SDK gap,
  // not a codegen blind spot (unlike the `dropdownOptions`/`component.root`
  // cases found earlier) — the write never even reaches the real node.
  //
  // Fix: bypass `bindValue`'s operation pipeline entirely by compiling the
  // same expression with the lower-level (but still public)
  // `compileDslStringValueForExistingWidgetClass` and writing the result
  // directly onto the node via a plain `project` mutation inside
  // `app.raw(...)` — the same raw-mutation shape already used throughout
  // this file, just reached through `findPage`/`findByKey` instead of
  // `page.mutateNode`'s selection API (needed here because the compiler
  // call itself requires direct access to `project`, which `page`'s
  // narrower closure doesn't expose).
  app.raw((project) {
    final widgetClass = findPage(project, name: 'ReservationForm')!;
    final targetNode = findByKey(widgetClass.node, 'DropDown_ggrglg4w')!;
    final compiledValue = compileDslStringValueForExistingWidgetClass(
      project,
      widgetClassName: 'ReservationForm',
      targetNodeKey: 'DropDown_ggrglg4w',
      expression: CustomFunction(
        resolveInitialStartTimeFn,
        args: {'prefillStartTime': PageParam('prefillStartTime')},
      ),
      app: app,
    );
    targetNode.props.dropDown.initialOption = FFText(textValue: compiledValue);
  });

  // ==========================================================================
  // Comprehensive project-wide review (PROJECT_KNOWLEDGE.md §70): HomePage
  // had a SECOND, fully static, non-interactive fake "cast card" grid
  // (`GridView_2f71lsw8`, wrapped in `Container_xbbolkl3`) sitting directly
  // below the real, correctly-wired `DiscoveryCastGrid`
  // (`GridView_t0nvrf32`) in the same scrollable Column — two hardcoded
  // cards ('ゆずき'/'arika' + Japanese lorem-ipsum filler text + fake '123'
  // like counts), neither with any onTap. Pre-existing since before this
  // session (confirmed via git-blame-equivalent: PROJECT_ANALYSIS.md's own
  // original as-is walkthrough already documented HomePage as having a
  // GridView of cast cards in addition to the banner carousel; Phase 3's
  // fix — §65-adjacent — replaced a DIFFERENT node, `Container_z3poslih`,
  // never touching this one). Every real guest scrolling HomePage — the
  // app's most-trafficked screen — saw two obviously-fake "cast" cards
  // right below real listings. No spec evidence anywhere for a second
  // "featured casts" section, so removal (not building it out) is the
  // correct minimal fix — this DSL has no dedicated "delete a widget"
  // primitive, only `ensureReplaced`, so replaced with an invisible,
  // zero-size `Container` rather than attempting to delete the node
  // outright.
  // FROZEN (2026-08-13, immediately after this exact block landed):
  // confirmed via generated_code/lib/home/home_page/home_page_widget.dart —
  // neither the fake 'ゆずき'/'arika' content nor the replacement node's own
  // key/name appear anywhere (a `visible: false` Container compiles out of
  // the render tree entirely, not just hidden). Also confirmed the real
  // DiscoveryCastGrid (fetchDiscoveryCasts/_model.discoveryCasts) is fully
  // intact and unaffected. Confirmed via lib/flutterflow_project/pages/
  // home_page.dart — `Container_xbbolkl3` no longer exists, replaced by
  // `Container_giskyopo`, name "RemovedStaticFakeCastGrid". Any future
  // change must target that key instead of the stale one below.
  // app.editPage(ff.Pages.homePage, (page) {
  //   page.ensureReplaced(
  //     page.findByKey('Container_xbbolkl3'),
  //     Container(
  //       name: 'RemovedStaticFakeCastGrid',
  //       width: 0,
  //       height: 0,
  //       visible: false,
  //     ),
  //   );
  // });
}
