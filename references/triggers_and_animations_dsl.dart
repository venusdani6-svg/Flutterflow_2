/// Reference: high-level animation widgets + actions + page transitions.
///
/// Covers the four authoring surfaces an agent reaches for when building
/// animated screens:
///   * `Lottie(path, ...)` and `Rive(path, ...)` widgets
///   * `StartAnimation` / `StopAnimation` / `ResetAnimation` /
///     `ReverseAnimation` actions targeting a widget by name
///   * `ToggleLottie(name)` / `ToggleRive(name)` for one-tap play/pause
///   * `NavigateTransition(NavigateTransitionType.fadeIn, durationMillis: 300)`
///     for page-to-page transitions
///
/// The lower-level `Trigger` enum + `Actions.on(node, Trigger.x, action)` is
/// used for brownfield edits (attaching swipe / drag / tab-change / focus
/// triggers to nodes the editor already created); see `references/
/// edit_data_binding_dsl.dart` for the brownfield idiom.
library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  await flutterFlowAI(
    buildAnimationsApp,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    projectName: options.projectName,
    projectId: options.projectId,
    findOrCreate: options.findOrCreate,
    dryRun: options.dryRun,
    commitMessage: options.commitMessage,
  );
}

void buildAnimationsApp(App app) {
  // -- Minimal theme so the demo pages render cleanly --
  app.themeColor('primary', 0xFF4B39EF);
  app.themeColor('secondary', 0xFF39D2C0);
  app.themeColor('primaryBackground', 0xFFF1F4F8);
  app.themeColor('secondaryBackground', 0xFFFFFFFF);
  app.themeColor('primaryText', 0xFF14181B);
  app.themeColor('secondaryText', 0xFF57636C);
  app.primaryFont('Inter');

  // ---------------------------------------------------------------------------
  // Page 1 — Lottie loader with toggle / reset
  // ---------------------------------------------------------------------------
  // KEY PATTERN: every animated widget gets a stable `name:` so animation
  // actions can resolve it at compile time. Without a name, codegen can't
  // wire the action's `animationNodeKeyRef` back to the right widget.
  app.page(
    'LoaderPage',
    route: '/',
    isInitial: true,
    description: 'Demo: Lottie + StartAnimation/StopAnimation/ToggleLottie.',
    body: Scaffold(
      appBar: AppBar(title: 'Lottie controls'),
      body: Column(
        scrollable: true,
        padding: 16,
        spacing: 16,
        crossAxis: CrossAxis.center,
        children: [
          // KEY PATTERN: Lottie() defaults to `playback: LottiePlayback.loop`
          // and `autoPlay: true`. Set `autoPlay: false` when you want the user
          // to drive playback via a button.
          Lottie(
            'https://assets10.lottiefiles.com/packages/lf20_p8bfn5to.json',
            source: AnimationSource.network,
            playback: LottiePlayback.loop,
            autoPlay: false,
            width: 160,
            height: 160,
            name: 'Loader',
          ),

          Row(
            spacing: 8,
            mainAxis: MainAxis.center,
            children: [
              // KEY PATTERN: ToggleLottie flips the play/pause state. Pass the
              // widget's `name:` — NOT the key, NOT the FFNode reference.
              Button('Toggle', onTap: ToggleLottie('Loader')),
              Button('Reset', onTap: ResetAnimation('Loader')),
            ],
          ),

          Divider(),

          // KEY PATTERN: cross-page navigation with a typed transition. This
          // is the single supported way to override the default page slide;
          // every transition variant lives on `NavigateTransitionType`.
          Button(
            'Open Rive demo',
            onTap: Navigate(
              'RiveDemo',
              transition: NavigateTransition(
                NavigateTransitionType.fadeIn,
                durationMillis: 300,
              ),
            ),
          ),
        ],
      ),
    ),
  );

  // ---------------------------------------------------------------------------
  // Page 2 — Rive with start/reverse/stop and an animated icon button
  // ---------------------------------------------------------------------------
  // KEY PATTERN: StartAnimation accepts `looping:` and `reverse:` flags. Use
  // `looping: true` for a Rive idle state; flip `reverse: true` when you want
  // a "press once" / "press again to undo" affordance.
  app.page(
    'RiveDemo',
    route: '/rive',
    description: 'Demo: Rive + StartAnimation/StopAnimation/ReverseAnimation.',
    body: Scaffold(
      appBar: AppBar(title: 'Rive controls'),
      body: Column(
        scrollable: true,
        padding: 16,
        spacing: 16,
        crossAxis: CrossAxis.center,
        children: [
          Rive(
            'assets/animations/hero.riv',
            source: AnimationSource.asset,
            playback: RivePlayback.continuous,
            artboard: 'Main',
            selectedAnimations: const ['idle'],
            autoPlay: false,
            width: 240,
            height: 240,
            name: 'Hero',
          ),

          Wrap(
            spacing: 8,
            children: [
              Button(
                'Start (loop)',
                onTap: StartAnimation('Hero', looping: true),
              ),
              Button('Reverse', onTap: ReverseAnimation('Hero')),
              Button('Stop', onTap: StopAnimation('Hero')),
              Button('Reset', onTap: ResetAnimation('Hero')),
            ],
          ),

          Divider(),

          Button(
            'Back home (slide right)',
            onTap: Navigate(
              'LoaderPage',
              transition: NavigateTransition(
                NavigateTransitionType.slideRight,
                durationMillis: 250,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

// -- CLI boilerplate --
final class _CliOptions {
  const _CliOptions({
    this.apiKey,
    this.baseUrl,
    this.projectName,
    this.projectId,
    this.findOrCreate = false,
    this.dryRun = false,
    this.commitMessage,
  });
  final String? apiKey;
  final String? baseUrl;
  final String? projectName;
  final String? projectId;
  final bool findOrCreate;
  final bool dryRun;
  final String? commitMessage;
}

_CliOptions _parseCliOptions(List<String> args) {
  String? apiKey, baseUrl, projectName, projectId, commitMessage;
  var findOrCreate = false, dryRun = false;
  for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--api-key':
        apiKey = args[++i];
      case '--base-url':
        baseUrl = args[++i];
      case '--project-name':
        projectName = args[++i];
      case '--project-id':
        projectId = args[++i];
      case '--commit-message':
        commitMessage = args[++i];
      case '--find-or-create':
        findOrCreate = true;
      case '--dry-run':
        dryRun = true;
      default:
        stderr.writeln('Unknown option: ${args[i]}');
        exit(64);
    }
  }
  return _CliOptions(
    apiKey: apiKey,
    baseUrl: baseUrl,
    projectName: projectName,
    projectId: projectId,
    findOrCreate: findOrCreate,
    dryRun: dryRun,
    commitMessage: commitMessage,
  );
}
