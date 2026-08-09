# FlutterFlow AI Workspace

FlutterFlow AI is a local workspace for creating and editing FlutterFlow apps with a coding agent.

## Before every task (project-specific — read this first)

This workspace (`icoccha-new-mockup-9a6ing`) is the guest/cast-facing Icoccha mobile app — a sister project to the `icoccha-admin-dashboard` admin panel, worked with the same knowledge-accumulation discipline established there. Before starting any task:

1. Read `PROJECT_ANALYSIS.md` in full — the as-is state of this workspace and the live FlutterFlow project (tooling, data model, every page/component, known bugs).
2. Read `IMPLEMENTATION_PLAN.md` — the phased build plan and full requirements catalog derived from the client's own spec documents; the authoritative source for product/business requirements.
3. Read `PROJECT_KNOWLEDGE.md` in full — the running change log: what's been done so far, why, and how it was verified.
4. Read `.cursor/rules/project_rules.md` in full — the operating rules, plus a large inherited section of FlutterFlow AI SDK/DSL/codegen quirks carried over from `icoccha-admin-dashboard` (that project's own hard-won lessons about proto behavior, codegen gotchas, CLI mechanics — directly applicable here since it's the same tool).
5. If any of these files' content changes or new project knowledge is surfaced, update `PROJECT_KNOWLEDGE.md` (its own change-log convention) and `.cursor/rules/project_rules.md` afterward — and `PROJECT_ANALYSIS.md`/`IMPLEMENTATION_PLAN.md` too if the task changed something they document as current/planned state — and briefly report what was updated and why. Do not let this workspace's knowledge drift apart silently across sessions or across the tools that read it (`CLAUDE.md` mirrors this same section for Claude Code — keep both in sync).

## Files

- `dsl/create.dart`
- `dsl/edit.dart`
- `test/app_test.dart`
- `references/`
- `patterns/`
- `lib/flutterflow_project.dart` — generated typed project SDK barrel. Import it as `ff` in edit flows. The actual content is split across per-entity files under `lib/flutterflow_project/` (one file per page in `pages/`, one per component in `components/`, plus `schemas.dart`, `app_state.dart`, `apis.dart`, `theme.dart`). The barrel re-exports everything, so user code keeps `import '.../flutterflow_project.dart' as ff;` — to read a specific page's tree, jump directly into its file.
- `PROJECT_CONTEXT.md` — tiny onboarding pointer to the typed SDK for project-bound workspaces.
- `generated_code/` — read-only snapshot of the Flutter code FlutterFlow generates from the project. Manifest at `generated_code/.flutterflow/export_manifest.json` maps each entity (page, component, action block, etc.) to its `primary_files`. Use this when debugging visual or runtime bugs the DSL alone cannot explain (overflow, layout, render errors, build failures).
- `.flutterflow/` (SDK-managed: run history, traces, workspace state, plus router config)

## Keep the SDK up to date

Once per session, before starting on the user's task, run:

```
flutterflow ai upgrade --check
```

This is non-mutating — it reads `latest.json` from the SDK release channel and prints one `key: value` line per fact (no header, no indentation), ending with `newer_available: true|false`.

- `newer_available: false` (or `pinned_local_sdk: true`): proceed with the user's task.
- `newer_available: true`: tell the user there is a newer FlutterFlow AI SDK build (`<current_version>` → `<latest_version>`) and ask whether to upgrade. On consent, run `flutterflow ai upgrade`. On decline, continue with the current build and do not ask again this session.
- If the check fails (network error, etc.): mention it once, then proceed with the user's task. Do not retry in a loop.

Don't run the check on every command — once at the start of the session is enough.

## Workflow

### Selector-first edit workflow

If the user pasted a `FlutterFlow AI Selector v1` block, use it before any broad page/component inspection:

**Widget references (`[#N]`).** Context attached from the IDE ("Add Widget to Context") arrives as inline references like `[#1]`, `[#2]` in the prose, with the full selector blocks collected in a trailing `Context:` footer — each headed by `[#N] Name (Type)`. Resolve every `[#N]` to its block in that footer and treat it as the widget the user means. A message that carries these references (or a raw selector block) **together with any instruction is an actionable request about those widgets** — act on it; do not reply "No response requested".

1. Parse the pasted block for `project_id`, `scope_kind`, `scope_name`, `selector_path`, `node_key`, `node_name`, and `node_type`.
2. Run `flutterflow ai inspect <project_id> --page|--component <scope_name> --selector-path <selector_path> --dsl-json` to resolve the target widget.
3. Verify the returned `node_type` and `node_name` match expectations from the pasted block.
4. **If the user is reporting a visual or runtime bug** (overflow, layout, render error, exception, "looks wrong" / "doesn't fit"): before authoring the patch, read the generated Dart for the selector's scope.
   - Look up the entity in `generated_code/.flutterflow/export_manifest.json` by `name == scope_name` (or `key == node_key`).
   - Read its `primary_files` to see the actual widget tree, constraints, and styling Flutter is rendering.
   - The DSL is intent; the generated code is what is actually running. Overflow, an unbounded `Column` inside a `Row`, fixed sizes vs. `Expanded`, etc. are only visible there.
   - If `generated_code/` is missing or stale (`flutterflow ai codegen status` reports `stale`/`missing`), run `flutterflow ai codegen refresh` first.
5. Author the patch in `dsl/edit.dart` through the generated typed widget tree:
   ```dart
   import 'package:<workspace>/flutterflow_project.dart' as ff;

   app.editPage(ff.Pages.homePage, (page) {
     page.find(
       ff.Pages.homePage.widgets.byPath('PageName.body[0].children[1]').single,
     ).update((patch) {
       // ...
     });
   });
   ```
6. Run `flutterflow ai test`, then `flutterflow ai run`. The `flutterflow ai test` wrapper runs `dart test` and additionally records compile/test outcomes for the FlutterFlow AI dashboard. Plain `dart test` still works but won't be tracked. **Do not run `flutterflow ai validate` as a dry-run before `run`** — `run` validates internally and only pushes if validation passes, so a failing `run` is identical to a failing `validate`: same errors, no remote mutation, no half-pushed state. Validate-first is pure overhead; iterate directly on `run`.
7. If `--selector-path` fails, fall back to `--selector-key` with the `node_key` from the block.
8. Only do a broad `flutterflow ai inspect --page/--component` pass when the selector is stale or missing.

### General workflow

1. Start from the closest working examples in `references/`. Do not read the full API surface first unless the references are insufficient or you are blocked.
2. For edit work, start from `lib/flutterflow_project.dart` (the barrel) — it is the generated typed map of pages, components, state, params, collections, tables, widgets, selectors, and metadata. For surgical reads, jump directly into the per-entity files under `lib/flutterflow_project/` (`pages/<slug>.dart`, `components/<slug>.dart`, `schemas.dart`, etc.) instead of reading the barrel. Use `flutterflow ai inspect <project-id>` for explicit debug/export views.
3. Edit `dsl/create.dart` or `dsl/edit.dart`. The CLI argument-parser boilerplate in these files is stable — only the body of `buildEditFlow` (or `buildCreateFlow`) changes. Prefer the `Edit` tool on that function over a full-file `Write`.
4. Update `test/app_test.dart` to match your changes (page names, component names, expected structure). The starter test references `StarterPage` — change it to match whatever you built.
5. Run `flutterflow ai test` (a `dart test` wrapper that also records compile/test outcomes for the dashboard). Plain `dart test` still works but won't be tracked.
6. **Execute the push** — this is NOT optional, always run this as the final step. `flutterflow ai run` validates internally and only pushes if validation passes, so a failing `run` is identical to a failing `validate`: same errors, no remote mutation, no half-pushed state. **Do not run `flutterflow ai validate` first as a dry-run "for safety" — it adds zero safety over `run` and just doubles iteration time.** Iterate directly on `run` until it passes. Always include `--commit-message` with a short description of what changed:
   - **Create:** `flutterflow ai run dsl/create.dart --project-name "<name>" --commit-message "<what the app does>"`
   - **Edit:** `flutterflow ai run dsl/edit.dart --project-id "<id>" --commit-message "<what changed>"`
   - Use `--find-or-create` only as a retry/recovery option when a previous create run may already have created the remote project but the local workspace is not bound yet.
   - If the workspace is already bound to a project in `.flutterflow/workspace.json`, FlutterFlow AI will refuse plain create mode by default. Use `--allow-new-project` only when you intentionally want a second project from the same workspace.
7. Successful `flutterflow ai run` pushes refresh `lib/flutterflow_project.dart` automatically. Run `flutterflow ai refresh-context <project-id>` after remote changes made outside this workspace.

### When to use `flutterflow ai validate`

`flutterflow ai validate <file>` runs the same pipeline as `flutterflow ai run` but skips the final push. It is **not** part of the normal edit loop — `run` already validates before pushing, so running validate first just doubles the validation work. Reach for `validate` only when you want validation output *without* a network push: CI pre-flight checks, offline previews of a create/edit that you do not yet intend to commit, or sanity-checking a heavily refactored DSL before exposing it to the server.

### Fast-lane patch (`flutterflow_ai__patch` MCP tool) — MANDATORY for property edits

**REQUIRED FIRST ATTEMPT**: If the user's request can be expressed as "set property P on existing widget W to literal value V", you MUST call the `flutterflow_ai__patch` MCP tool **before** considering `flutterflow ai run`. This is not optional — the fast lane lands the edit on the FF backend in ~30s versus 2+ minutes for the slow path. Going to slow-path-first burns ~90 extra seconds of the user's time on every trivial edit.

**Full reference**: `flutterflow ai docs fast-lane` — auto-generated from the live `kFastPatchOps` table. Always current with the SDK. Read this when you're unsure whether an op exists or what its value shape is.

The decision rule:
- "change this text", "make this color X", "set fontSize to N", "hide this widget", "fade this to 50% opacity" on an EXISTING widget → **fast lane (`flutterflow_ai__patch`)**, no exceptions.
- Anything that requires writing or reading Dart, mutating the tree shape, or wiring action chains → slow path (`flutterflow ai run`).

**Mandatory first-attempt criteria** (use fast lane if ALL apply):
- The target already exists (you have its handle in `lib/flutterflow_project/`, or you're tweaking a project-level setting like dark mode / fonts)
- The change is one of the ~100 ops in the fast-patch table (see "Op surface" below) — when in doubt, try it; the tool returns a structured `invalid_request` error listing valid ops if you guessed wrong, which is still cheaper than the slow path
- The value is a literal (a string, a number, a bool, a theme-token name, or an ARGB int) — NOT a variable/state/API/conditional binding

**When to fall back to `flutterflow ai run`** (slow path):
- The fast lane returned `error_kind: invalid_request` and the error message says the op isn't supported. Don't retry — switch to `run` immediately.
- The change is structural (insert/remove/move widgets, wrap/unwrap, change widget type)
- Custom code (functions, actions, widgets, classes, enums)
- Action wiring (onTap → Navigate, action chains, triggers)
- Binding a property to a variable / state / API response / conditional
- App-state field declarations, custom constants, API config, pub dependencies (use slow path)

**Disallowed pattern**: editing `dsl/edit.dart` with `page.update(widget, (patch) { patch.color(...); patch.fontSize(...); })` and running `flutterflow ai run` for a request that matches the fast-lane criteria above. Doing this slows the user down by ~90 seconds for no gain. If the fast lane fits, use the fast lane.

**How to invoke (call shape):**
```
flutterflow_ai__patch({
  project_id: <id>,
  commit_message: '<op summary>',
  node_key: ff.pages.Home.widgets.welcomeTitle.key,
  widget_type: ff.pages.Home.widgets.welcomeTitle.type,
  patches: [
    { op: 'text', value: 'Hello, World' },
    { op: 'color', value: { token: 'primary' } },
  ],
})
```

`node_key` and `widget_type` are both available on every typed SDK widget handle (no discovery query needed). The `ProjectWidgetHandle.fastPatch(...)` helper returns the right `{node_key, widget_type, patches}` shape ready to pass to the tool.

**CAS / `parent_updated_at_ms` is automatic** — the SDK client caches the project's updated_at_ms after every patch and re-fetches transparently on a 409. Agents do NOT pass it. The tool's input schema lists it as optional only for the rare case where you want to force a specific CAS check.

**Context auto-refreshes after every fast-patch** — both `lib/flutterflow_project/` (typed SDK, completes in seconds) AND `generated_code/` (full Flutter snapshot, can take 10–30s) are regenerated in the background. The patch response returns to you in ~30s; by the time you make the next prompt, the typed SDK is fresh and `generated_code/` is either fresh or refreshing. Don't call `flutterflow ai refresh-context` / `flutterflow ai codegen refresh` manually for fast-patch flows — they'd duplicate the background work.

**Color ops — two flavors:**
- `color` (theme tokens): `{ op: 'color', value: { token: 'primary' } }`. Valid slots: `primary`, `secondary`, `tertiary`, `alternate`, `primaryBackground`, `secondaryBackground`, `primaryText`, `secondaryText`, `accent1`–`accent4`, `success`, `warning`, `error`, `info`.
- `colorArgb` (raw ARGB int): `{ op: 'colorArgb', value: 0xFFE91E63 }`. Use this when the user asks for a specific hex/RGB color that doesn't map to a theme slot. Both ops target the same widgets (Text, Button, Icon, IconButton, Container, Card, Divider, TextField); they write to different proto leaves.

**Op surface (~100 ops):** the complete, always-current list is `flutterflow ai docs fast-lane` (generated from the live `kFastPatchOps` table). It covers text/typography, `color`/`colorArgb`/`visible`/`opacity`, sizing (`width`/`height`/`borderRadius`/`spacing`), container styling, AppBar, Button, ~14 TextField ops, Slider/Switch/Checkbox/Progress per-side colors, Dropdown, Divider, Card, Charts, Map, Image `imageFit`, `htmlContent`, Shader, and app-scoped ops (`darkMode`, `primaryFont`, `secondaryFont` — no `node_key` needed). Don't enumerate from memory; check the doc when unsure whether an op exists.

**When in doubt, try the fast lane first.** A wrong op name returns `invalid_request` in <500ms with a list of valid ops; the slow path takes 2+ minutes whether the op exists or not. The cost of a wrong fast-lane guess is one extra round-trip; the cost of defaulting to slow path is the full 2+ minutes.

**Failure modes** — the tool returns a structured `error_kind`:
- `invalid_request`: malformed op, unknown widget type, or op not valid for this widget type. Fix the args and retry.
- `cas_conflict`: the project changed underneath you AND the client's transparent retry also lost the race. Rare. Just re-run the tool — the SDK client refreshes its CAS cache on every 409, so a fresh call picks up the new server state.
- `fast_lane_disabled`: server kill switch is on. Use `flutterflow ai run` instead.
- `server_error`: anything else. Fall back to slow path.

After a successful fast-patch, the backend proto is updated and the workspace's `lib/flutterflow_project/` (typed SDK) plus `generated_code/` (full Flutter snapshot) are refreshed in the background. The patch tool returns immediately; by your next prompt the typed SDK is fresh and `generated_code/` is fresh-or-soon. Only run `flutterflow ai refresh-context` manually if you made a structural change via `flutterflow ai run` and need fresh handles right now.

## Design & Quality Rules

These rules are **mandatory for every create and edit script**. Quick summary; read `flutterflow ai docs design-quality` for the full reference.

- **Theme first** — set up `app.themeColor(...)`, `app.typography(...)`, and design tokens before building UI; bind widgets to `Colors.primary` / `Colors.secondaryText` / etc. for cohesion. **Scope colors correctly:** widget-specific color requests → `Colors.hex(...)` on the node; brand/app-wide requests → `app.themeColor(...)`.
- **Components for reuse** — extract any repeated subtree into `app.component()` with typed `params:`.
- **Default values on params** — give every `app.page`/`app.component` param a `.withDefault(...)` unless every call site provably supplies a non-null value. Required page params crash on cold-entry deep links.
- **Descriptions everywhere** — pass `description:` on `app.page/component/actionBlock/collection/table/event/customFunction`. Short, clear text — it shows up in the FF editor.
- **Visual quality** — size buttons with `width`/`padding`/`borderRadius`/`color`; use `Container` for cards; `spacing:` on `Column`/`Row`; `Styles.titleLarge` etc. for text hierarchy; `maxLines:` + `TextOverflow.ellipsis` on overflow-prone text; explicit size on `ProgressBar.circular`; avoid `shrinkWrap: true` on dynamic `ListView`.
- **Action outputs** — when a page/component has >1 backend action with output, set `outputAs:` explicitly on each.
- **DSL ↔ Flutter drift** — a handful of widgets/props differ from Flutter (no `Center`, no `GestureDetector`, `Shadow(dx:, dy:)` not `Offset`, `Param(...)` not `ComponentParam(...)`, etc.). See the docs for the full drift table; check `references/` when a Flutter-shaped symbol fails to compile.

## Create → Edit Transition

**IMPORTANT:** Create scripts (`dsl/create.dart`) are one-shot — they create pages and components from scratch. You **cannot** re-run a create script against the same project; it will fail with duplicate-name errors.

After the first successful create push:
1. The project now exists. Read `projectId` from `.flutterflow/workspace.json`.
2. If `flutterflow` CLI is available, FlutterFlow AI also exports a local Flutter snapshot into `generated_code/`.
3. `flutterflow ai init --project <id>` and successful `flutterflow ai run` pushes keep `lib/flutterflow_project.dart` current for work done in this workspace.
4. For all subsequent edits, use **edit flows** in `dsl/edit.dart` with `--project-id "<id>"`.
5. Use `lib/flutterflow_project.dart` (the barrel) to understand the current page/component structure before editing — or jump straight into `lib/flutterflow_project/pages/<slug>.dart` for a specific page's typed tree. Use `flutterflow ai inspect <project-id> --page <PageName>` when you need an explicit debug/export view.
6. Read `references/taskboard_dsl.dart` or other edit references for patterns.
7. After later pushes, `lib/flutterflow_project.dart` is regenerated and `generated_code/` is re-exported when refresh is enabled. If a push leaves the snapshot stale (codegen skipped or the export failed), run `flutterflow ai codegen refresh`.

Do NOT modify and re-run `dsl/create.dart` to make changes to an existing project.
Do NOT switch back to `--project-name` in a bound workspace unless you intentionally want a separate project and pass `--allow-new-project`.

## Edit Context

- `flutterflow ai init --project <id>` creates a project-bound workspace and writes `lib/flutterflow_project.dart` when credentials are available.
- When available, `flutterflow ai init --project <id>` also exports a local Flutter snapshot into `generated_code/`.
- `lib/flutterflow_project.dart` is the **authoring and inspection map** (a thin barrel; the content lives in per-entity files under `lib/flutterflow_project/`). Import the barrel as `ff` and prefer `ff.Pages.*`, `ff.Components.*`, `ff.Collections.*`, `ff.Tables.*`, `ff.AppState.*`, and widget handles over raw strings. For a single page or component, navigate into its per-entity file (`lib/flutterflow_project/pages/<slug>.dart`, `lib/flutterflow_project/components/<slug>.dart`) rather than scrolling the barrel.
- `generated_code/` is the **runtime truth**. The DSL describes intent; the generated Dart is what Flutter actually builds and renders. Read it whenever you need to reason about layout, sizing, overflow, render exceptions, build errors, or any "why does the rendered app look or behave like this" question — these are not answerable from the DSL alone.
- Use the manifest at `generated_code/.flutterflow/export_manifest.json` to jump directly from an entity (page, component, action block) to its `primary_files`. Look up by `name` (matches the selector's `scope_name`) or `key` (matches `node_key`). Do not grep for files when the manifest exists.
- Treat `generated_code/` as read-only. Do NOT edit files there directly — make changes in `dsl/edit.dart` or other FlutterFlow AI-managed source, then push through `flutterflow ai run`.
- If a task starts from a generated Dart file, identify the corresponding page, component, or resource from that file and apply the change through FlutterFlow AI rather than patching the generated output.
- Successful `flutterflow ai run` pushes refresh `lib/flutterflow_project.dart` automatically and refresh `generated_code/` by default. If codegen is skipped or the export fails, the generated-code snapshot is marked stale and `flutterflow ai codegen status` / `codegen refresh` apply.
- `flutterflow ai refresh-context <project-id>` rewrites `lib/flutterflow_project.dart` **and** re-exports `generated_code/` after meaningful remote changes made outside this workspace.
- Run `flutterflow ai context-check` to verify whether generated typed SDK metadata is still fresh.
- **Do NOT use `flutterflow ai inspect <id> --dsl-json` for general discovery.** Read `lib/flutterflow_project.dart` (or, for surgical reads of a single entity, `lib/flutterflow_project/pages/<slug>.dart` / `components/<slug>.dart`) instead — every page, component, collection, table, app-state field, and widget selector lives there as a typed handle. `inspect --dsl-json` is reserved for two narrow cases: (1) resolving a pasted FlutterFlow AI Selector v1 block via `--selector-path` (see the selector workflow above), and (2) explicit debug/export when the typed SDK genuinely doesn't carry what you need (e.g. raw FFNode shape). For human-readable summaries reach for plain `flutterflow ai inspect <id>` or `flutterflow ai resources <id>`, not the JSON variant.

## Edit APIs for Existing Resources

Quick summary; read `flutterflow ai docs edit-apis` for the full reference with code samples.

- **Typed handles** — use `ff.Collections.*`, `ff.Components.*`, `ff.Pages.*`, `ff.AppState.*` from `lib/flutterflow_project.dart` everywhere. Raw `app.existing*` helpers were removed.
- **Component instances** — `ff.Components.tripCard(title: ...)`. `name:` and `visible:` are reserved on every component call (don't declare params with those names).
- **Component param binding** — `page.setComponentParam(selection, 'paramName', expr)`.
- **Page-load actions** — `app.editPageOnLoad(ff.Pages.myPage, [...])`.
- **Idempotent creation** — `app.ensurePage(...)`, `app.ensureFirebaseAuth(...)` no-op if already present.
- **Page metadata** — use brownfield helpers: `setPageRoute`, `setPageRequiresAuth`, `updatePage`. Do NOT touch `routePath` on `ensurePageRouteSettings()` directly (skips normalization).
- **Removing entities** — `app.removePage/Component/Collection/Table/DataStruct/Enum/ActionBlock/AppEvent/CustomFunction/CustomAction/CustomWidget/SpacingToken/RadiusToken/ShadowToken`. Fails loudly if the name is also declared in the same App. There is no `app.removeProject(...)`.
- **Edit property patches** — `page.update(selection, (patch) { ... })` exposes typed methods on `EditWidgetPatch` (`text`, `color`, `visible`, `spacing`, `padding`, `borderRadius`, `size`, `icon`, `margin`, `alignment`, `border`, `shadow`, `opacity`, etc.). Escape hatch: `page.mutateNode(selection, (node) { ... })`.

## Branches & merges

FlutterFlow projects have branches — each branch is its own FFProject linked back to the trunk; `commit()` / `flutterflow ai run` write to whichever branch `.flutterflow/config.yaml` marks active. Read `flutterflow ai docs branches` for the full reference (every branch command, the 8-step merge loop, reading a `ConflictSpec`, anti-patterns).

- **Switch first**: run `flutterflow ai branch current` if unsure; `branch checkout <name>` regenerates context against the new branch. The active branch's project_id is what every `run`/`commit` writes to.
- **Merge loop** (in order, not free-form): `merge start --from <branch>` → `merge auto` (clears trivial cases) → `merge status` → `merge explain <file> --json` → edit `working/<path>` (remove `<<<<<<<`/`=======`/`>>>>>>>` markers) → `merge resolve <file>` → `merge verify` (the no-loss verifier — never bypass with `--accept-drops` unsilenced) → `merge commit -m "<msg>"`. `merge abort` to bail.
- **Never** edit the `initial/` / `base/` / `head/` three-way reference dirs, and never run two merges at once in one workspace.

## Runtime Artifacts

- `.flutterflow/runs.jsonl`: local run history
- `.flutterflow/history/<run-id>/`: archived source files and plan
- `.flutterflow/traces/<run-id>.json`: canonical run trace
- Use `flutterflow ai history`, `flutterflow ai trace latest`, and `flutterflow ai support inspect <run-id>` to debug what happened.

## FlutterFlow Desktop Live Session

If FlutterFlow Desktop is running on this machine, the workspace's MCP server auto-pairs with it. Read `flutterflow ai docs live-session` for the full reference (tool list, worked examples, push-handling rules).

Minimum you need to know:

- Call `live.status` once per interactive session. If `paired: true`, the Desktop tools (`ide.*`, `workspace.*`, `local_run.*`, `events.*`, `live.*`) are usable; otherwise fall back to the DSL-only workflow.
- **Drain `live.pending_pushes` at the start of every user turn** — IDE "Send to FF AI" actions and runtime errors arrive here. Acknowledge each push with one visible line so the user knows it landed. Pushes override `ide.get_user_selection`.
- Persistent project changes still go through the DSL workflow (`flutterflow ai run`). Live tools are observe + push-receive only; Desktop hot-reloads automatically when the proto changes.
- Control calls (`local_run.start/stop/hot_reload/hot_restart`) require the `local_run:<project_id>` lease. Don't manually hot-reload after a DSL push — the IDE does it.

## Source Tracking

- FlutterFlow AI keeps the source that produced each run for auditability and replay.
- By default, `flutterflow ai run dsl/create.dart` or `flutterflow ai run dsl/edit.dart` tracks the executed DSL script.
- Support tooling can turn a traced run into a bundle or replay workspace with `flutterflow ai support bundle`, `flutterflow ai support replay`, or `flutterflow ai support case`.

## References

- Start from the closest working examples in `references/` before inventing new DSL structure.
- **If a widget or property fails to compile and the symbol isn't in the drift table above, check `references/` for the nearest working example before iterating.** The DSL surface is curated; when it diverges from Flutter, the right form is documented in a reference.
- If a `validate` error survives two plausible fixes (renaming the colliding name, restructuring the chain) and the error tracks whatever you renamed, run `flutterflow ai validate references/<closest-match>.dart` on the closest reference — if that fails too, the bug is in the SDK / codegen, not your script. Stop iterating and report it.
- Only use `flutterflow ai docs api-surface` or `flutterflow ai docs ui` when the references do not cover what you need or you are blocked on a specific API detail.
- `flutterflow ai docs api-surface` covers the lower-level helper contract. `flutterflow ai docs ui` covers the broader widget and action authoring surface.
- CRUD: `references/shopflow_dsl.dart`
- Task board: `references/taskboard_dsl.dart`
- Auth: `references/auth_shell_dsl.dart`
- Supabase: `references/supabase_crud_auth_shell_dsl.dart`
- Firestore: `references/social_feed_data_dsl.dart`
- Forms: `references/workflow_forms_dsl.dart`
- Shell/navigation: `references/commerce_shell_dsl.dart`
- Content generation: `references/content_companion_dsl.dart`
- Resource/library usage: `references/resource_library_dsl.dart`
- Postgres compile-only: `references/postgres_compile_only_dsl.dart`
- Action blocks: `references/action_block_showcase_dsl.dart`
- App events: `references/app_event_showcase_dsl.dart`
- GenUI: `references/genui_catalog_assistant_dsl.dart`
- Action reuse/composability: `references/taskboard_dsl.dart`
- Local state CRUD (lists, forms, per-item actions): `references/local_state_crud_dsl.dart`
- Theming, styling, layout (colors, fonts, sizing, borders, password fields): `references/styled_profile_dsl.dart`
- Media/content (horizontal lists, grids, images, text truncation, scrollable rows): `references/media_browser_dsl.dart`
- Asset/reference types (`imagePath`, `videoPath`, `audioPath`, `docRef(...)`, typed media/reference state): `references/asset_and_reference_surface_dsl.dart`
- Edit: search + filter on existing page: `references/edit_add_search_filter_dsl.dart`
- Edit: add form + detail page + navigation: `references/edit_form_and_detail_dsl.dart`
- Edit: restyle, enhance, empty states, refresh: `references/edit_restyle_and_enhance_dsl.dart`
- Edit: existing collections, components, data binding, idempotent ops: `references/edit_data_binding_dsl.dart`
- Multiple API calls with explicit `outputAs:` naming: `references/multi_api_call_dsl.dart`
- REST + GraphQL APIs (`app.api(...)`, all five HTTP methods, `Endpoint.graphql`, headers, body types, `EndpointSettings` for cache/auth/private/streaming): `references/rest_graphql_api_dsl.dart`
- Theme & design system (color slots, typography scale, spacing/radius/shadow tokens, custom fonts/icons, scrollbar, pull-to-refresh): `references/theme_design_system_dsl.dart`
- Animations + page transitions (`Lottie` / `Rive` widgets; `StartAnimation` / `StopAnimation` / `ResetAnimation` / `ReverseAnimation` / `ToggleLottie` / `ToggleRive` actions; `NavigateTransition` for page-to-page transitions): `references/triggers_and_animations_dsl.dart`
- Custom code + pub.dev packages — greenfield: pair a custom action with `http` and a custom widget with `intl` in a fresh project (`buildPubPackageShowcase`). Brownfield: add the same artifacts to an **existing** project using the `find* → add* → editPage` shape with structural inserts (`buildPubPackageEdit`, run with `--mode brownfield`). Read this when adding any pub-dep-backed feature, especially in edit flows. `references/custom_code_pub_package_dsl.dart`
- Custom Dart classes + enums used as typed args/returns via `classRef` / `customEnumRef`: `references/custom_code_classes_and_functions_dsl.dart`

## Custom code authoring

The SDK is the canonical way to add, update, and remove user-authored Dart inside a FlutterFlow project. Read `flutterflow ai docs custom-code` for the full reference (typing, validation, staging sandbox, non-goals).

Quick map:

| Artifact | DSL (greenfield) | Helper (brownfield) |
| --- | --- | --- |
| Custom function | `app.customFunction` | `addCustomFunction` |
| Custom action | `app.customAction` | `addCustomAction` |
| Custom widget | `app.customWidget` | `addCustomWidget` |
| Custom class | `app.customClass` | `addCustomClass` |
| Custom enum | `app.customEnum` | `addCustomEnum` |
| Pub dep | `app.pubDependency` / `pubDevDependency` / `pubDependencyOverride` | `addPubDependency` / `addDevDependency` / `addDependencyOverride` |

- **Greenfield vs brownfield** — DSL inside `buildApp`, helpers when editing a pulled project. Don't mix in one script.
- **Validation runs automatically** — format + identifier + shape. Catch `CustomCodeDuplicateError` / `CustomCodeValidationError`. **Not** caught: type correctness against the rest of the project — use the staging sandbox (`.ffai_staging/` + `dart analyze`) for non-trivial code that references `FFAppState` / structs / generated types.
- **Pub deps** — pub.dev discovery is your job; the SDK only records the resolution. Declare the dep next to the artifact that imports it.
- **Param typing** — `DslType` covers scalars, `listOf(T)`, `classRef(handle)`, `customEnumRef(handle)`, `app.enum_/struct` handles, Firestore/Postgres handles, `action`. For uncovered types (`Document`, `SQLiteRow`, RevenueCat, etc.) drop into `app.raw(...)` and set `FFParameter.dataType` directly.
- **Folder organization** — only relevant when the target project has `useFolderOrganizedCustomCode` on (an IDE-owned opt-in the SDK reads but never flips). On the standard layout the SDK auto-files new artifacts into the synthetic `CustomCode/Functions|Widgets|Actions` tree; pass `folderKey:` to override (`kCustomCodeFolderKey` = synthetic root; `''` falls back to legacy paths, NOT the root). On adopted layouts (rare brownfield) you must pass `folderKey:` explicitly. Full rules — standard vs adopted layout, fallbacks, flag-off behavior: `flutterflow ai docs custom-code` → "Folder organization".

## Test Pilot (AI e2e testing)

Author natural-language e2e tests that a vision agent runs against your app. Tests live OUTSIDE the project proto, so they have their own rules:
- Declare with `app.testGroup('Auth', tests: [app.qaTest('login', instructions: ..., expectedOutcome: ...)])`. `flutterflow ai run` applies them after the push.
- **No `id:` = create; `id:` = update in place.** Re-running a create file duplicates the group — to edit a test later, discover its id with the `testpilot.list` MCP tool and pass it back via `app.qaTest(id:)`. Nothing is ever deleted implicitly.
- Run/read results via MCP: `testpilot.run` (starts a run; costs credits, takes minutes) then poll `testpilot.get_run`. Run `flutterflow ai docs test-pilot` for the full guide.

## AI Agents

Project-level AI agents in five modalities. Declared on `app.*` (greenfield) or via the matching helper (brownfield), invoked from an action chain through the kind-specific node. Read `flutterflow ai docs ai-agents` for the full reference (sub-config value objects, required fields, multimodal inputs, validation, code samples).

| Kind | DSL (greenfield) | Helper (brownfield) | Action chain entry |
| --- | --- | --- | --- |
| CHAT | `app.chatAgent` | `addChatAgent` | `CallAiAgent`, `ClearAiAgentMessages` |
| TTS | `app.ttsAgent` | `addTtsAgent` | `GenerateSpeech` |
| STT | `app.sttAgent` | `addSttAgent` | `TranscribeAudio` |
| IMAGE_GEN | `app.imageGenAgent` | `addImageGenAgent` | `GenerateImage` |
| VIDEO_GEN | `app.videoGenAgent` | `addVideoGenAgent` | `GenerateVideo` |

- Provider/kind support is restricted: CHAT → google/openai/anthropic, TTS/STT → elevenlabs, IMAGE_GEN → openai/google, VIDEO_GEN → google. Unsupported pairs throw `AiAgentValidationError` at the SDK boundary.
- Every agent needs a non-empty `description` + `model.model`, and an `apiKey` EXCEPT `google + chat` (runs client-side via `firebase_vertexai`). CHAT also needs ≥1 `AiMessage.system(...)`, a non-empty `requestInputs`, and a non-null `response`.
- `CallAiAgent` / `ClearAiAgentMessages` both require a stable `conversationId:` (codegen pairs send/clear by matching it).
- Shared CRUD: `removeAiAgent`, `updateAiAgent` (kind-preserving), `findAiAgent`, `listAiAgents`. Validation throws typed `AiAgentError` subclasses — catch the subtype, don't regex messages.

## Integrations

First-class enable + actions for third-party integrations. Enable via `app.*` (greenfield) or the matching `configure*` helper (brownfield); wire actions from an action chain.

### RevenueCat

Enable billing and wire platform SDK keys. Each key may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one of `appStoreKey` / `playStoreKey` / `webBillingKey` is required.

```dart
// Enable (greenfield)
app.revenueCat(
  appStoreKey: secretRef('REVENUECAT_APP_STORE_KEY'),
  playStoreKey: secretRef('REVENUECAT_PLAY_STORE_KEY'),
  debugLogging: false,          // default
  loadDataAfterAppLaunch: true, // default
);

// Idempotent enable — no-ops if already active on the project
app.ensureRevenueCat(appStoreKey: secretRef('REVENUECAT_APP_STORE_KEY'));

// Brownfield: configureRevenueCat(project, appStoreKey: ...); isRevenueCatActive(project)
```

Actions (require RevenueCat enabled on the project):

```dart
Actions.revenueCatPurchase(packageId: 'pkg_pro');
Actions.revenueCatPaywall(entitlementId: 'premium');
Actions.revenueCatRestore();
```

### Stripe

Enable payments and wire the test/production credential pairs. Each credential key (and `appleMerchantId`) may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one publishable/secret key across `testCredentials` / `prodCredentials` is required.

```dart
// Enable (greenfield)
app.stripe(
  testCredentials: StripeCredentials(
    publishableKey: secretRef('STRIPE_TEST_PUBLISHABLE_KEY'),
    secretKey: secretRef('STRIPE_TEST_SECRET_KEY'),
  ),
  prodCredentials: StripeCredentials(
    publishableKey: secretRef('STRIPE_PROD_PUBLISHABLE_KEY'),
    secretKey: secretRef('STRIPE_PROD_SECRET_KEY'),
  ),
  merchantName: 'Acme Inc',
  merchantCountryCode: 'US',
  production: false, // default: test mode
);

// Idempotent enable — no-ops if already active on the project
app.ensureStripe(
  testCredentials: StripeCredentials(
    publishableKey: secretRef('STRIPE_TEST_PUBLISHABLE_KEY'),
  ),
);

// Brownfield: configureStripe(project, testPublishableKey: ...); isStripeActive(project)
```

Actions (require Stripe enabled on the project). `amount` and `currencyCode` are required; `currencyCode` is a plain string, `email` is an `FFVariable` resolving to the customer's email:

```dart
Actions.stripeSinglePayment(amount: '1999', currencyCode: 'usd', email: emailVar, description: 'Pro plan');
```

### Braintree

Enable payments and wire the test/sandbox and production credential sets. Each credential field may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one credential field across `testCredentials` / `prodCredentials` is required.

```dart
// Enable (greenfield)
app.braintree(
  testCredentials: BraintreeCredentials(
    merchantId: secretRef('BRAINTREE_TEST_MERCHANT_ID'),
    tokenizationKey: secretRef('BRAINTREE_TEST_TOKENIZATION_KEY'),
    publicKey: secretRef('BRAINTREE_TEST_PUBLIC_KEY'),
    privateKey: secretRef('BRAINTREE_TEST_PRIVATE_KEY'),
  ),
  prodCredentials: BraintreeCredentials(
    merchantId: secretRef('BRAINTREE_PROD_MERCHANT_ID'),
    tokenizationKey: secretRef('BRAINTREE_PROD_TOKENIZATION_KEY'),
    publicKey: secretRef('BRAINTREE_PROD_PUBLIC_KEY'),
    privateKey: secretRef('BRAINTREE_PROD_PRIVATE_KEY'),
  ),
  production: false, // default: sandbox mode
);

// Idempotent enable — no-ops if already active on the project
app.ensureBraintree(
  testCredentials: BraintreeCredentials(
    tokenizationKey: secretRef('BRAINTREE_TEST_TOKENIZATION_KEY'),
  ),
);

// Brownfield: configureBraintree(project, testMerchantId: ...); isBraintreeActive(project)
```

Actions (require Braintree enabled on the project). `amount` is required and `FFValue`-wrapped; `currencyCode` / `countryCode` are plain strings, `taxRate` / `shippingCost` are plain doubles:

```dart
Actions.braintreeSinglePayment(amount: '19.99', currencyCode: 'USD', transactionName: 'Pro plan');
```

### Razorpay

Enable payments and wire the test and production credential sets. Each credential field may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one credential field across `testCredentials` / `prodCredentials` is required.

```dart
app.razorpay(
  testCredentials: RazorpayCredentials(
    keyId: secretRef('RAZORPAY_TEST_KEY_ID'),
    keySecret: secretRef('RAZORPAY_TEST_KEY_SECRET'),
  ),
  prodCredentials: RazorpayCredentials(
    keyId: secretRef('RAZORPAY_PROD_KEY_ID'),
    keySecret: secretRef('RAZORPAY_PROD_KEY_SECRET'),
  ),
  businessName: 'Acme Inc.',
);

// Idempotent variant — no-op if Razorpay is already active on the project:
app.ensureRazorpay(
  testCredentials: RazorpayCredentials(
    keyId: secretRef('RAZORPAY_TEST_KEY_ID'),
    keySecret: secretRef('RAZORPAY_TEST_KEY_SECRET'),
  ),
);
// Brownfield: configureRazorpay(project, testKeyId: ...); isRazorpayActive(project)
```

Actions (require Razorpay enabled on the project). `amount`, `currencyCode`, and `receiptNumber` are required and `FFValue`-wrapped; `description` / `userName` / `userEmail` / `userContact` are optional:

```dart
Actions.razorpaySinglePayment(amount: '50000', currencyCode: 'INR', receiptNumber: 'rcpt_001', description: 'Pro plan');
```

### AdMob

Enable AdMob and wire the platform app keys. Prefer `secretRef(...)` for the app keys so the literal never lands in DSL source. At least one of `iosAppKey` / `androidAppKey` is required.

```dart
app.adMob(
  iosAppKey: secretRef('ADMOB_IOS_APP_KEY'),
  androidAppKey: secretRef('ADMOB_ANDROID_APP_KEY'),
  showTestAds: true,
  maxAdContentRating: AdMobContentRating.pg,
);

// Idempotent variant — no-op if AdMob is already active on the project:
app.ensureAdMob(androidAppKey: secretRef('ADMOB_ANDROID_APP_KEY'));

// Brownfield: configureAdMob(project, iosAppKey: ...); isAdMobActive(project)
```

Actions (require AdMob enabled on the project). Ad unit IDs are public identifiers (plain strings, not secrets):

```dart
Actions.adMobLoadInterstitial(iosAdUnitId: 'ca-app-pub-.../ios', androidAdUnitId: 'ca-app-pub-.../android');
Actions.adMobShowInterstitial();
Actions.adMobRequestConsent();
Actions.adMobCheckConsentNotRequired();
```

### Gemini

Enable Gemini and wire the API key. The config lives on `project.appSettings.geminiSettings`. `apiKey` may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. `apiKey` is required.

```dart
app.gemini(apiKey: secretRef('GEMINI_API_KEY'));

// Idempotent variant — no-op if Gemini is already active on the project:
app.ensureGemini(apiKey: secretRef('GEMINI_API_KEY'));

// Brownfield: configureGemini(project, apiKey: ...); isGeminiActive(project)
```

Actions (require Gemini enabled on the project). `prompt` is `FFValue`-wrapped; the image action takes exactly one of `imageNetworkUrl` / `uploadedImageFile` (both `FFVariable`s):

```dart
Actions.geminiGenerateText(prompt: 'Summarize the following text');
Actions.geminiCountTokens(prompt: 'How many tokens is this?');
Actions.geminiGenerateTextFromImage(prompt: 'Describe this image', imageNetworkUrl: someVariable);
```

### Mux

Wire the Mux broadcast API access tokens (enable-only — no action). The config lives on `project.appSettings.muxBroadcastApiAccessTokens` (not `backend`). There is no separate enabled flag; Mux is active once a non-empty token is present. Each token may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal secret never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one of `tokenId` / `tokenSecret` is required.

```dart
app.mux(
  tokenId: secretRef('MUX_TOKEN_ID'),
  tokenSecret: secretRef('MUX_TOKEN_SECRET'),
);

// Idempotent variant — no-op if Mux is already active on the project:
app.ensureMux(tokenId: secretRef('MUX_TOKEN_ID'));

// Brownfield: configureMux(project, tokenId: ...); isMuxActive(project)
```

### Firebase Analytics

Enable Firebase Analytics and configure its automatic-event settings. The config lives on `project.backend.firebaseAnalyticsConfig` (not `appSettings`). No SDK keys are required here. All flags are optional; omitted ones preserve any existing value.

```dart
app.firebaseAnalytics(
  onPageLoad: true,
  onActionsStart: true,
  onIndividualActions: false,
  onAuth: true,
);

// Idempotent variant — no-op if Firebase Analytics is already active on the project:
app.ensureFirebaseAnalytics(onPageLoad: true);

// Brownfield: configureFirebaseAnalytics(project, onPageLoad: true); isFirebaseAnalyticsActive(project)
```

Action (requires Firebase Analytics enabled on the project). `eventName` and each parameter key/value are `FFValue`-wrapped:

```dart
Actions.logFirebaseEvent(eventName: 'purchase', parameters: {'item': 'pro_plan', 'value': '49.99'});
```

### Firebase Crashlytics

Enable Firebase Crashlytics (enable-only — no inputs, no action). The config lives on `project.backend.firebaseCrashlyticsConfig` (not `appSettings`).

```dart
app.firebaseCrashlytics();

// Idempotent variant — no-op if Firebase Crashlytics is already active on the project:
app.ensureFirebaseCrashlytics();

// Brownfield: configureFirebaseCrashlytics(project); isFirebaseCrashlyticsActive(project)
```

### Firebase Remote Config

Enable Firebase Remote Config (no action). The config lives on `project.backend.firebaseRemoteConfigConfig` (not `appSettings`). Optionally author `fields` — one `RemoteConfigField` per remote-config parameter. Each field has a `name`, a `type` (any `DslType`, e.g. `string`, `int_`, `bool_`; the parameter's data type is built via the shared type machinery), and a serialized `defaultValue`.

```dart
app.firebaseRemoteConfig(fields: [
  RemoteConfigField(name: 'welcome_message', type: string, defaultValue: 'Hi'),
  RemoteConfigField(name: 'max_items', type: int_, defaultValue: '10'),
]);

// Enable-only (no fields):
app.firebaseRemoteConfig();

// Idempotent variant — no-op if Firebase Remote Config is already active on the project:
app.ensureFirebaseRemoteConfig(fields: [...]);

// Brownfield: configureFirebaseRemoteConfig(project); isFirebaseRemoteConfigActive(project)
```

### Firebase Performance Monitoring

Enable Firebase Performance Monitoring (enable-only — no inputs, no action). The config lives on `project.backend.firebasePerformanceMonitoringConfig` (not `appSettings`).

```dart
app.firebasePerformanceMonitoring();

// Idempotent variant — no-op if it is already active on the project:
app.ensureFirebasePerformanceMonitoring();

// Brownfield: configureFirebasePerformanceMonitoring(project); isFirebasePerformanceMonitoringActive(project)
```

### Firebase App Check

Enable Firebase App Check (enable-only — no action). The config lives on `project.backend.firebaseAppCheckConfig` (not `appSettings`). Enabling requires no keys; all arguments are optional. Prefer `secretRef(...)` for the site keys and debug token so literals never appear in source.

```dart
app.firebaseAppCheck(
  webRecaptchaV3SiteKey: secretRef('RECAPTCHA_V3_SITE_KEY'),
  webRecaptchaEnterpriseSiteKey: secretRef('RECAPTCHA_ENTERPRISE_SITE_KEY'),
  runTestModeDebugToken: secretRef('APP_CHECK_DEBUG_TOKEN'),
  apkAndroidProvider: AppCheckAndroidProvider.playIntegrity, // or .debug
  appleProvider: AppCheckAppleProvider.appAttest,
  // AppCheckAppleProvider: .debug | .deviceCheck | .appAttest | .appAttestWithDeviceCheckFallback
);

// Idempotent variant — no-op if App Check is already active on the project:
app.ensureFirebaseAppCheck(apkAndroidProvider: AppCheckAndroidProvider.playIntegrity);

// Brownfield: configureFirebaseAppCheck(project, apkAndroidProvider: ...); isFirebaseAppCheckActive(project)
```

### Google Maps

Wire the Google Maps API keys that power the Map widget (enable-only — there is no Google Maps action). Prefer `secretRef(...)`. At least one of `androidKey` / `iosKey` / `webKey` is required.

```dart
app.googleMaps(
  androidKey: secretRef('GMAPS_ANDROID_KEY'),
  iosKey: secretRef('GMAPS_IOS_KEY'),
  webKey: secretRef('GMAPS_WEB_KEY'),
);

// Idempotent variant — no-op if keys are already configured on the project:
app.ensureGoogleMaps(webKey: secretRef('GMAPS_WEB_KEY'));

// Brownfield: configureGoogleMaps(project, androidKey: ...); isGoogleMapsActive(project)
```

### Algolia

Enable Algolia search and wire the application ID, search API key, and the collections to index. The config lives on `project.backend.algoliaConfig` (not `appSettings`). Prefer `secretRef(...)` for the keys so the literal never lands in DSL source. At least one of `applicationId` / `searchApiKey` is required.

```dart
app.algolia(
  applicationId: secretRef('ALGOLIA_APP_ID'),
  searchApiKey: secretRef('ALGOLIA_SEARCH_API_KEY'),
  indexedCollections: ['products', 'articles'],
);

// Idempotent variant — no-op if Algolia is already active on the project:
app.ensureAlgolia(applicationId: secretRef('ALGOLIA_APP_ID'), searchApiKey: secretRef('ALGOLIA_SEARCH_API_KEY'));

// Brownfield: configureAlgolia(project, applicationId: ...); isAlgoliaActive(project)
```

Action (requires Algolia enabled on the project). `collection` names an indexed collection, `searchTerm` is `FFValue`-wrapped, `maxResults` is a plain int:

```dart
Actions.algoliaSearch(collection: 'products', searchTerm: 'sneakers', maxResults: 20);
```

### Push notifications

Enable FlutterFlow's built-in push notification delivery. No external SDK keys are required here. All arguments are optional; omitted ones preserve any existing value.

```dart
// Enable (greenfield)
app.pushNotifications(
  allowScheduledNotifications: true,
  autoPromptUsersForNotificationsPermission: true,
);

// Idempotent enable — no-ops if already active on the project
app.ensurePushNotifications(allowScheduledNotifications: true);

// Brownfield: configurePushNotifications(project, ...); isPushNotificationsActive(project)
```

Actions (require push notifications enabled on the project). Recipients are `FFVariable`s resolving to a user document (or list of documents):

```dart
Actions.triggerPushNotificationToUser(user: userVar, title: 'Hi', body: 'Welcome');
Actions.triggerPushNotificationToUsers(users: usersVar, title: 'Sale', body: 'Ends soon', imageUrl: 'https://...');
```

### OneSignal

Wire the OneSignal credential keys. Each key may be a `String` literal or a `secretRef(name)` — **prefer `secretRef` so the literal key never lands in DSL source**. Set the secret out-of-band first (`integrations.set_secret`); the compiler resolves it against the project's environment values. At least one of `appId` / `apiKey` / `userKey` is required.

```dart
// Enable (greenfield)
app.oneSignal(
  appId: secretRef('ONESIGNAL_APP_ID'),
  apiKey: secretRef('ONESIGNAL_API_KEY'),
);

// Idempotent enable — no-ops if already active on the project
app.ensureOneSignal(appId: secretRef('ONESIGNAL_APP_ID'));

// Brownfield: configureOneSignal(project, appId: ...); isOneSignalActive(project)
```

Actions (require OneSignal enabled on the project):

```dart
Actions.oneSignalAddUser(tags: {'plan': 'pro'}, enableEmail: true, email: 'a@b.com');
Actions.oneSignalDeleteUser();
```

### SQLite

Enable the on-device SQLite database and optionally author read/update queries. The config lives on `project.backend.sqliteConfig` (not `appSettings`). `databaseName` / `versionNumber` are optional; omitted ones preserve any existing value.

Pass `queries` — a list of `SqliteQuery` — to author queries. Each query has a `name` (identifier), raw `sql` (stored verbatim, not parsed/validated), `inputs` (`SqliteQueryInput{name, type: DslType}` bind variables), `outputs` (`SqliteQueryColumn{name, type: DslType}` result columns, read queries only), and `isUpdate` (route into `update_queries` vs `read_queries`). Variable/column types are built via the shared type machinery, identical to custom-function args. When `queries` is non-empty the read/update lists are replaced wholesale; when empty they are preserved.

The database initialization config (seed file / script paths that reference uploaded assets) is not authored via the SDK yet (deferred).

```dart
app.sqlite(databaseName: 'app.db', versionNumber: 1, queries: [
  SqliteQuery(
    name: 'getUser',
    sql: 'SELECT id, name FROM users WHERE id = :id',
    inputs: [SqliteQueryInput(name: 'id', type: int_)],
    outputs: [
      SqliteQueryColumn(name: 'id', type: int_),
      SqliteQueryColumn(name: 'name', type: string),
    ],
  ),
  SqliteQuery(
    name: 'renameUser',
    sql: 'UPDATE users SET name = :name WHERE id = :id',
    inputs: [
      SqliteQueryInput(name: 'name', type: string),
      SqliteQueryInput(name: 'id', type: int_),
    ],
    isUpdate: true,
  ),
]);

// Idempotent variant — no-op if SQLite is already active on the project:
app.ensureSqlite(databaseName: 'app.db');

// Brownfield: configureSqlite(project, databaseName: 'app.db'); isSqliteActive(project)
```

### Supabase per-environment OAuth config

Author per-environment Supabase OAuth (FlutterFlow-managed) connections. Call `app.supabaseEnvironment(...)` once per environment key (e.g. `PROD`, `DEV`); each writes into `project.backend.supabaseOauthConfig.oauthConfigs[environmentKey]`. Because `supabase_oauth_config` and `supabase_self_hosted_config` share a protobuf `oneof`, this is **mutually exclusive** with the self-hosted `app.supabase(...)` path and with `app.postgres(...)` — mixing them throws.

```dart
app.supabaseEnvironment(
  environmentKey: 'PROD',
  url: 'https://prod.supabase.co',
  anonKey: 'prod-anon-key',
);
app.supabaseEnvironment(
  environmentKey: 'DEV',
  url: 'https://dev.supabase.co',
  anonKey: 'dev-anon-key',
  googleAuth: SupabaseGoogleAuthConfig(iosClientId: '...', webClientId: '...'),
);
```

### Supabase Edge Functions

Declare a Supabase Edge Function on `project.backend.supabaseEdgeFunctionsConfig.edgeFunctions`. `code` is the raw Deno/TypeScript source — stored verbatim, never parsed or validated. `parameters` (`SupabaseEdgeFunctionParam{name, type: DslType}`) and `returnType` (a `DslType`) are built via the shared type machinery. `verifyJwt` defaults to `true`, `enableCors` to `false`; `denoJson` is the optional dependency config. Multiple functions are allowed — each `name` must be unique in one app; the compiler upserts by `identifier.name` (preserving the identifier key on update).

IMPORTANT: authoring an Edge Function does NOT by itself enable Supabase. The Edge-Function CALL action (below) is gated on `isSupabaseActive`, so the user still needs `app.supabase(...)` / `app.supabaseEnvironment(...)` for a call to pass gating. Declaring the function only writes the definition.

```dart
app.supabaseEdgeFunction(
  name: 'send-welcome-email',
  code: 'Deno.serve((req) => new Response("ok"));',
  parameters: [SupabaseEdgeFunctionParam(name: 'name', type: string)],
  returnType: string,
);

// Idempotent variant — no-op if a function with this name is already declared:
app.ensureSupabaseEdgeFunction(name: 'send-welcome-email', code: '...');

// Brownfield: configureSupabaseEdgeFunction(project, name: '...', code: '...');
// isSupabaseEdgeFunctionDeclared(project, 'send-welcome-email')
```

Call a declared Edge Function by name. Requires Supabase to be enabled on the project. Pass `parameters` (a `Map<String, String>`) to supply named arguments; each value is wrapped as an `FFArgument` value inside the call's `parameterValues.arguments`. Omit `parameters` to call with no arguments.

```dart
Actions.callSupabaseEdgeFunction(functionName: 'send-welcome-email');
Actions.callSupabaseEdgeFunction(
  functionName: 'send-welcome-email',
  parameters: {'name': 'Ada', 'plan': 'pro'},
);
```

### Custom Auth

Enable Custom Authentication (enable-only). Custom auth sets the project's auth backend using your own auth implementation, wiring `project.authentication.custom`. `userDataType` names the data type identifier that holds the authenticated user's data (required); `persistAuthData` controls whether auth data is persisted locally. Custom auth is **mutually exclusive** with Firebase and Supabase auth — declaring more than one auth backend in a single app, or enabling custom auth on a project that already has Firebase/Supabase auth active, throws.

```dart
app.customAuth(userDataType: 'AppUser', persistAuthData: true);

// Idempotent variant — no-op if Custom auth is already active on the project:
app.ensureCustomAuth(userDataType: 'AppUser');

// Brownfield: configureCustomAuth(project, userDataType: 'AppUser'); isCustomAuthActive(project)
```

## Deprecated proto fields are OFF LIMITS

When you drop into `app.raw((project) { ... })` (or any helper that hands you a raw proto message), **never read or write any field annotated `[deprecated = true]` in `flutterflow.proto`** — and never write a field named `legacy_*`. Codegen reads only the modern fields; data written to the deprecated pair is invisible to codegen and can crash it.

The canonical landmine is `FFConditionActions`:

```proto
message FFConditionActions {
  FFActionCondition legacy_condition   = 1 [deprecated = true]; //  do NOT use
  FFActionNode      legacy_true_action = 2 [deprecated = true]; //  do NOT use
  repeated FFTrueConditionAction true_actions = 4;              //   modern shape
  FFActionNode      false_action       = 3;
}
```

Walking the schema and picking the two scalar fields that look like "condition + true action" lands you in the deprecated pair. Codegen (`generateConditionActionsCode`) then reads `trueActions.first` and crashes with `Bad state: No element` — the SDK now rejects this shape at compile time with `MalformedConditionActionsError` so you'll see the failure before the push lands.

**Always build conditional action chains with the typed builders** — they emit the modern `true_actions[0]` shape and the SDK validators pass them by construction. There is no legitimate reason to reach for `app.raw` to construct a conditional:

```dart
// if/else
Actions.conditional(
  condition: someBoolVariable,
  trueActions: Actions.chain([Actions.snackBar('Yes')]),
  falseActions: Actions.chain([Actions.snackBar('No')]),
);

// if/else-if/else
Actions.conditionalMulti(
  branches: [
    (condition: isPremium, actions: premiumChain),
    (condition: isTrial,   actions: trialChain),
  ],
  fallback: Actions.chain([Actions.snackBar('Free tier')]),
);
```

The general rule: any field with `[deprecated = true]` or a name starting with `legacy_` is for backwards-compatible reads by other consumers — never write to them. If you're not sure, use the typed DSL/helper surface. If the typed surface really doesn't cover what you need, ask first; don't poke deprecated proto fields.
