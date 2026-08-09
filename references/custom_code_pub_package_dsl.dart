/// Pairing pub.dev packages with custom actions and custom widgets.
///
/// This file pairs **two** runnable builders so the agent can read both halves
/// of the create/edit shape side-by-side:
///
///   * [buildPubPackageShowcase]   — greenfield. Builds a fresh project from
///                                    scratch using `app.pubDependency(...)`,
///                                    `app.customAction(...)`, and
///                                    `app.customWidget(...)`. These DSL
///                                    methods are intended for create scripts.
///                                    Re-running an identical declaration is a
///                                    no-op; a duplicate name with a different
///                                    payload throws.
///
///   * [buildPubPackageEdit]       — brownfield. Adds the same artifacts to an
///                                    **already-existing** project using the
///                                    `find* → add* → editPage` shape. This is
///                                    the recommended way to extend a project
///                                    once it exists: don't reach for
///                                    `app.pubDependency(...)` / `app.customX`
///                                    in edit flows — they're create-shaped
///                                    and force the script to reason about
///                                    rerun semantics. Use `find*` first to
///                                    guard against duplicates, then `add*`
///                                    (which throws on duplicate); for tree
///                                    insertion use `app.editPage(...)` with
///                                    `findByKey`/`findByName`/`findByPath`
///                                    selectors and the structural ensure*
///                                    family (`ensureInsertedInto`,
///                                    `ensureInsertedBefore`, etc. —
///                                    documented in the API surface doc).
///
/// Pick the entry point via `--mode greenfield` (default) or `--mode
/// brownfield` on the CLI.
///
/// Two pub packages are used here on purpose:
///   * `http` — consumed by a custom action (network call).
///   * `intl` — consumed by a custom widget (currency formatting).
library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  final builder = switch (options.mode) {
    _RunMode.greenfield => buildPubPackageShowcase,
    _RunMode.brownfield => buildPubPackageEdit,
  };
  await flutterFlowAI(
    builder,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    projectName: options.projectName,
    projectId: options.projectId,
    findOrCreate: options.findOrCreate,
    dryRun: options.dryRun,
    commitMessage: options.commitMessage,
  );
}

void buildPubPackageShowcase(App app) {
  // ---------- pub dependencies ----------
  //
  // Declare both deps up front so the pairing with the consumer code below
  // is obvious. Versions chosen to match what FlutterFlow projects typically
  // pin — override elsewhere if your target project has stricter bounds.
  app.pubDependency('http', '^1.2.0');
  app.pubDependency('intl', '^0.19.0');

  // ---------- app state the page binds to ----------
  app.state('latestAmountUsd', double_.withDefault(1234.56));
  app.state('latestLabel', string.withDefault('Fetching...'));

  // ---------- custom action that consumes `http` ----------
  //
  // FlutterFlow-style custom actions ship as a full function definition
  // inside `code`. The codegen pipeline wires the generated signature to
  // the runtime based on the declared `args` and `returns`; the body here
  // just has to compile.
  app.customAction(
    'FetchQuoteLabel',
    args: {'endpoint': string},
    returns: string,
    code: r'''
import 'package:http/http.dart' as http;

Future<String> fetchQuoteLabel(String endpoint) async {
  final response = await http.get(Uri.parse(endpoint));
  if (response.statusCode != 200) {
    return 'Unavailable';
  }
  return response.body.trim();
}
''',
    description: 'Fetches a plain-text label from the supplied endpoint.',
  );

  // ---------- custom widget that consumes `intl` ----------
  //
  // Custom widgets ship as a full Dart compilation unit: imports plus the
  // widget class. The parameters map declares each of the class's typed
  // constructor arguments to FlutterFlow so they show up in the widget's
  // properties panel after codegen.
  app.customWidget(
    'FormattedMoney',
    parameters: {'amount': double_, 'currencyCode': string, 'locale': string},
    code: r'''
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

class FormattedMoney extends StatelessWidget {
  const FormattedMoney({
    super.key,
    required this.amount,
    required this.currencyCode,
    required this.locale,
  });

  final double amount;
  final String currencyCode;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final formatter = NumberFormat.simpleCurrency(
      locale: locale,
      name: currencyCode,
    );
    return Text(
      formatter.format(amount),
      style: Theme.of(context).textTheme.headlineMedium,
    );
  }
}
''',
    description: 'Formats a numeric amount as a locale-aware currency.',
  );

  // ---------- page that ties both together ----------
  //
  // The page doesn't need to actually invoke the custom action or embed the
  // custom widget to demonstrate the pattern — codegen places both into the
  // generated project regardless. In a real app, you'd reference the
  // widget via `CustomWidget('FormattedMoney', ...)` inside the page body
  // and trigger the action from a button's `onTap`.
  app.page(
    'RatesPage',
    route: '/',
    isInitial: true,
    body: Scaffold(
      appBar: AppBar(title: 'Rates'),
      body: Container(
        padding: 16,
        child: Column(
          children: [
            Text(AppState('latestLabel'), name: 'LabelText'),
            // Placeholder for where the custom widget would be mounted. The
            // real invocation is `CustomWidget('FormattedMoney', params: ...)`
            // once you're passing the state-bound amount and a locale.
            Text(AppState('latestAmountUsd'), name: 'AmountText'),
          ],
        ),
      ),
    ),
  );
}

// ===========================================================================
// Brownfield (edit) builder
// ===========================================================================
//
// Runs against an already-existing project. The pattern an edit-mode agent
// should internalize:
//
//   1. `find*` → check whether the artifact already exists.
//   2. If absent, call the corresponding `add*` helper (throws on duplicate,
//      which is exactly what you want: a duplicate-name collision is a real
//      bug to surface, not a silent overwrite).
//   3. For tree changes, use `app.editPage(...)` / `app.editComponent(...)`
//      with selector-driven structural primitives (`findByKey`, `findByName`,
//      `ensureInsertedInto`, `ensureInsertedBefore`, etc.). Never redeclare
//      the page body with `app.page(...)` / `ensurePage(...)` in an edit
//      script — that conflates create and edit modes and forces the script
//      to reason about rerun semantics on every line.
//
// What this script assumes already exists in the target project:
//   * A page named `RatesPage` containing a `Container` named `RatesBody`
//     (built by the greenfield builder above, or by a prior edit).
//
// Run with:
//   dart run references/custom_code_pub_package_dsl.dart \
//     --mode brownfield --project-id <existing-id>

void buildPubPackageEdit(App app) {
  // ---------- pub dependencies: find-first idempotency ----------
  //
  // `addPubDependency` throws on a name collision. Guarding with
  // `findPubDependency` makes the rerun-safety check explicit in the script
  // — readers can see at a glance what idempotency means here, vs. relying
  // on the `app.pubDependency(...)` create-shape helper's silent no-op
  // semantics.
  app.raw((project) {
    if (findPubDependency(project, name: 'http') == null) {
      addPubDependency(project, name: 'http', version: '^1.2.0');
    }
    if (findPubDependency(project, name: 'intl') == null) {
      addPubDependency(project, name: 'intl', version: '^0.19.0');
    }
  });

  // ---------- custom code: find-first idempotency ----------
  //
  // Same shape as the pub-dep guard above. If you wanted to *update* an
  // existing artifact instead of skip it, swap the `add*` for `update*` in
  // the missing-branch's `else` — the find/add/update trio gives you the
  // three honest outcomes ("create new", "leave alone", "mutate in place")
  // explicitly, instead of asking `ensure*` to guess your intent.
  app.raw((project) {
    if (findCustomAction(project, name: 'FetchQuoteLabel') == null) {
      addCustomAction(
        project,
        name: 'FetchQuoteLabel',
        code: r'''
import 'package:http/http.dart' as http;

Future<String> fetchQuoteLabel(String endpoint) async {
  final response = await http.get(Uri.parse(endpoint));
  if (response.statusCode != 200) {
    return 'Unavailable';
  }
  return response.body.trim();
}
''',
        description: 'Fetches a plain-text label from the supplied endpoint.',
      );
    }
  });

  // ---------- custom widget: rerun-safe declaration ----------
  //
  // For widgets with user-facing parameters, `app.customWidget(...)` is
  // the right entry — it accepts DslType (`double_`, `string`, etc.) and
  // is rerun-safe (the compiler delegates to `ensureCustomWidget`, which
  // no-ops on identical reruns and throws on mismatched payload). The
  // find-first pattern used above for actions doesn't fit widgets
  // cleanly because `addCustomWidget` takes raw `FFParameter` rather
  // than DslType. The returned handle is callable — calling it produces
  // a placement node we can drop into a tree below.
  final dynamic formattedMoney = app.customWidget(
    'FormattedMoney',
    parameters: {'amount': double_, 'currencyCode': string, 'locale': string},
    description: 'Formats a numeric amount as a locale-aware currency.',
    code: r'''
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

class FormattedMoney extends StatelessWidget {
  const FormattedMoney({
    super.key,
    this.width,
    this.height,
    required this.amount,
    required this.currencyCode,
    required this.locale,
  });

  final double? width;
  final double? height;
  final double amount;
  final String currencyCode;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final formatter = NumberFormat.simpleCurrency(
      locale: locale,
      name: currencyCode,
    );
    return SizedBox(
      width: width,
      height: height,
      child: Text(
        formatter.format(amount),
        style: Theme.of(context).textTheme.headlineMedium,
      ),
    );
  }
}
''',
  );

  // If you're writing a *pure-edit* script that places an existing custom
  // widget without redeclaring it, place `CustomWidget(widgetName: ...)`
  // directly and use generated typed SDK handles for the surrounding page and
  // widget targets:
  //
  //   CustomWidget(widgetName: 'ReceiptCard', arguments: {'total': 42.0});
  //
  // The compiler resolves parameters against `findCustomWidget(project, ...)`
  // at compile time.

  // ---------- tree edit: mount the custom widget in an existing page ----
  //
  // `editPage` is the brownfield entry — it scopes structural changes to a
  // specific widget class without redeclaring its body. Run an `inspect`
  // first to learn the keys and names of nodes in `RatesPage`:
  // `flutterflow ai inspect --page RatesPage --outline` now emits
  // `# selector: findByKey('...')` hints next to each line.
  //
  // `ensureInsertedInto` is rerun-safe — the inserted widget's `name:` is
  // its idempotency marker. Re-running this script against the same
  // project no-ops the insert.
  app.editPage('RatesPage', (page) {
    final ratesBody = page.findByName('RatesBody');
    page.ensureInsertedInto(
      ratesBody,
      formattedMoney(
        name: 'FormattedAmount',
        amount: AppState('latestAmountUsd'),
        currencyCode: 'USD',
        locale: 'en_US',
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

enum _RunMode { greenfield, brownfield }

final class _CliOptions {
  const _CliOptions({
    this.mode = _RunMode.greenfield,
    this.apiKey,
    this.baseUrl,
    this.projectName,
    this.projectId,
    this.findOrCreate = false,
    this.dryRun = false,
    this.commitMessage,
  });

  final _RunMode mode;
  final String? apiKey;
  final String? baseUrl;
  final String? projectName;
  final String? projectId;
  final bool findOrCreate;
  final bool dryRun;
  final String? commitMessage;
}

_CliOptions _parseCliOptions(List<String> args) {
  var mode = _RunMode.greenfield;
  String? apiKey;
  String? baseUrl;
  String? projectName;
  String? projectId;
  String? commitMessage;
  var findOrCreate = false;
  var dryRun = false;
  for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode':
        final value = args[++i];
        mode = switch (value) {
          'greenfield' => _RunMode.greenfield,
          'brownfield' => _RunMode.brownfield,
          _ =>
            throw ArgumentError(
              'Invalid --mode "$value". Expected "greenfield" or "brownfield".',
            ),
        };
      case '--api-key':
        apiKey = args[++i];
      case '--base-url':
        baseUrl = args[++i];
      case '--project-name':
        projectName = args[++i];
      case '--project-id':
        projectId = args[++i];
      case '--find-or-create':
        findOrCreate = true;
      case '--dry-run':
        dryRun = true;
      case '--commit-message':
        commitMessage = args[++i];
      case '--help' || '-h':
        stdout.writeln(
          'Usage: dart run references/custom_code_pub_package_dsl.dart '
          '[--mode greenfield|brownfield] '
          '[--api-key KEY] [--base-url URL] [--project-name NAME] '
          '[--project-id ID] [--find-or-create] [--dry-run] '
          '[--commit-message MSG]',
        );
        exit(0);
    }
  }
  return _CliOptions(
    mode: mode,
    apiKey: apiKey,
    baseUrl: baseUrl,
    projectName: projectName,
    projectId: projectId,
    findOrCreate: findOrCreate,
    dryRun: dryRun,
    commitMessage: commitMessage,
  );
}
