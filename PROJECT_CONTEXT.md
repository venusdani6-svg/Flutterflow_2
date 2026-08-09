# FlutterFlow Project Context

This workspace uses a generated typed project SDK split across per-entity
files under `lib/flutterflow_project/` with a barrel at `lib/flutterflow_project.dart`.

- Import `package:<workspace>/flutterflow_project.dart` as `ff` — the barrel
  re-exports `Project`, `Pages`, `Components`, schemas (`Structs`,
  `Collections`, `Tables`, `Enums`, `CustomCode`), `AppState`, `ApiGroups`,
  `ActionBlocks`, and `Theme`.
- Per-page files live at `lib/flutterflow_project/pages/<slug>.dart` and per-component
  files at `lib/flutterflow_project/components/<slug>.dart`. Edits to one page only
  rewrite that page's file.
- Successful `flutterflow ai run` pushes refresh the typed SDK automatically.
- Run `flutterflow ai refresh-context icoccha-new-mockup-9a6ing` after remote changes made
  outside this workspace.
- Use `generated_code/` only for runtime, layout, build, and render debugging.
