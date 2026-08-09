# FlutterFlow AI Workspace

This workspace is scaffolded for the FlutterFlow AI DSL.

## Quickstart

```bash
dart pub get
flutterflow ai test
flutterflow ai validate dsl/create.dart
flutterflow ai run dsl/create.dart --project-name "My App" --commit-message "Initial app"
```

Treat `flutterflow ai validate` as a real preflight check. If it reports wiring or validation failures, fix them before attempting `flutterflow ai run`.

If a new-project `flutterflow ai run` fails before a successful push, FlutterFlow AI will not bind that project into `.flutterflow/workspace.json`. It also does not delete remote projects automatically, so use `--find-or-create` on a retry when you want to reuse a project that may already exist.

For an existing project:

```bash
flutterflow ai inspect <project-id> --page HomePage
flutterflow ai validate dsl/edit.dart --project-id <project-id>
flutterflow ai run dsl/edit.dart --project-id <project-id> --commit-message "Update existing app"
```

## Files

- `dsl/create.dart`: starter create DSL file
- `dsl/edit.dart`: starter edit flow
- `test/app_test.dart`: starter compile test
- `references/`: working DSL examples copied locally into the workspace
- `patterns/`: edit helper patterns
- `lib/flutterflow_project.dart`: generated typed project SDK for authoring and inspection in bound edit workspaces
- `PROJECT_CONTEXT.md`: tiny onboarding pointer to the generated typed SDK
- `generated_code/`: local Flutter export snapshot when `flutterflow_cli` is available during `flutterflow ai init --project <id>`
- `.flutterflow/` (SDK-managed: run artifacts, plus router-managed config): local runtime artifacts such as history, traces, and support outputs

## Edit Context

- `flutterflow ai init --project <id>` writes `lib/flutterflow_project.dart` when credentials are available.
- Import the generated SDK as `package:<workspace>/flutterflow_project.dart` and prefer `ff.Pages.*`, `ff.Components.*`, `ff.Collections.*`, `ff.Tables.*`, `ff.AppState.*`, and widget handles over raw strings.
- Successful `flutterflow ai run` pushes refresh `lib/flutterflow_project.dart` automatically.
- Successful pushes also refresh `generated_code/` by default when `flutterflow` CLI is available. If codegen is skipped or the export fails, the snapshot is marked stale instead.
- Treat `generated_code/` as read-only reference context. Use it to inspect generated structure and map generated files back to FlutterFlow entities.
- Do not edit files in `generated_code/` directly. Apply changes in FlutterFlow AI-managed source such as `dsl/edit.dart`, then push with `flutterflow ai run`.
- If a task starts from a generated Dart file, use that file to identify the relevant page, component, or resource, then make the change through FlutterFlow AI instead of patching generated output.
- Run `flutterflow ai codegen status` to see whether the snapshot is fresh or stale and which entities/files are likely affected.
- Run `flutterflow ai codegen refresh` to regenerate `generated_code/` for the bound project when you need a fresh snapshot.
- Run `flutterflow ai refresh-context <project-id>` after meaningful remote changes made outside this workspace.
- Run `flutterflow ai context-check` if you are not sure whether the generated typed SDK is current.
- For general discovery — pages, components, collections, state, params, widget selectors — read `lib/flutterflow_project.dart`. Do NOT default to `flutterflow ai inspect <id> --dsl-json` for this; the typed SDK already carries it.
- Use plain `flutterflow ai inspect <id>` or `flutterflow ai resources <id>` for human-readable debug/export views when the typed SDK is insufficient.
- `flutterflow ai inspect --dsl-json` is reserved for two cases: (1) resolving a pasted FlutterFlow AI Selector v1 block via `--selector-path` (see workflow below), and (2) explicit machine-readable snapshots when you genuinely need raw FFNode shape. `--tree`, `--outline`, `--debug`, and `--deep` are similarly opt-in inspection modes.
- Use `flutterflow ai inspect --selector-path <path>` or `--selector-key <key>` (with `--page` or `--component`) to target a single widget directly.

## FlutterFlow AI Selector Workflow

When the user pastes a `FlutterFlow AI Selector v1` block:

```
FlutterFlow AI Selector v1
project_id: abc123
scope_kind: page
scope_name: HomePage
selector_path: HomePage.body[0].children[1]
node_key: xyz789
node_name: MyButton
node_type: Button
```

1. Run: `flutterflow ai inspect abc123 --page HomePage --selector-path "HomePage.body[0].children[1]" --dsl-json`
2. Verify the returned widget matches expectations.
3. Patch through the generated typed widget tree in `dsl/edit.dart`:
   ```dart
   import 'package:<workspace>/flutterflow_project.dart' as ff;

   app.editPage(ff.Pages.homePage, (page) {
     page.find(
       ff.Pages.homePage.widgets.byPath('HomePage.body[0].children[1]').single,
     ).update((patch) {
       // modify properties
     });
   });
   ```
4. Run `flutterflow ai test`, `flutterflow ai validate`, `flutterflow ai run`.

## Guardrails

- When a page or component contains multiple backend actions with outputs, set `outputAs:` explicitly on each one. This is especially important for multiple `ApiCall(...)` actions on the same page or trigger.
- Prefer updating an existing edit trigger chain instead of adding a second API call to the same trigger unless both outputs are deliberately named.
- Size loading indicators explicitly. Use `ProgressBar.circular(size: 40, thickness: 4)` rather than the unsized default.
- Avoid `shrinkWrap: true` on dynamic `ListView(...)` widgets unless the list truly must live inside another scrollable. Prefer giving the list bounded space and leaving shrink wrap off.

## Runtime Artifacts

- `.flutterflow/runs.jsonl`: local run history
- `.flutterflow/history/<run-id>/`: archived source files and plan
- `.flutterflow/traces/<run-id>.json`: canonical run trace
- `flutterflow ai history`, `flutterflow ai trace latest`, and `flutterflow ai support inspect <run-id>` are the main debugging entry points

## Source Tracking

FlutterFlow AI keeps the source that produced each run for auditability and replay.

- By default, `flutterflow ai run dsl/create.dart` or `flutterflow ai run dsl/edit.dart` tracks the executed DSL script.
- `flutterflow ai support bundle`, `flutterflow ai support replay`, and `flutterflow ai support case` build shareable or reproducible artifacts from traced runs.

## References

Start with a reference app before writing new DSL:

- For the broader DSL API surface, run `flutterflow ai docs api-surface`.
- For the widget/action authoring catalog, run `flutterflow ai docs ui`.
- `references/shopflow_dsl.dart`
- `references/taskboard_dsl.dart`
- `references/auth_shell_dsl.dart`
- `references/supabase_crud_auth_shell_dsl.dart`
- `references/social_feed_data_dsl.dart`
- `references/workflow_forms_dsl.dart`
- `references/commerce_shell_dsl.dart`
- `references/content_companion_dsl.dart`
- `references/resource_library_dsl.dart`
- `references/postgres_compile_only_dsl.dart`
- `references/action_block_showcase_dsl.dart`
- `references/app_event_showcase_dsl.dart`
- `references/genui_catalog_assistant_dsl.dart`
- `references/multi_api_call_dsl.dart`
- `references/local_state_crud_dsl.dart`
- `references/styled_profile_dsl.dart`
- `references/media_browser_dsl.dart`
- `references/asset_and_reference_surface_dsl.dart`
