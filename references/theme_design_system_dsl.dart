/// Reference: full theme & design-system DSL surface.
///
/// Demonstrates the typed App DSL methods that replace `app.raw(...)` for
/// theming work. Use this as the canonical setup-block for any greenfield
/// app — every other reference assumes a project that's already themed.
///
/// Demonstrates:
/// - `app.themeColor(slot, argb, dark:)` — color-scheme slots
///   (primary/secondary/tertiary/alternate/primary|secondaryBackground/
///    primary|secondaryText/accent1..4/success/warning/error/info)
/// - `app.customPaletteColor(argb, dark:)` — extra brand colors not in the slot list
/// - `app.darkMode(enabled:)`, `app.primaryFont(family)`,
///   `app.secondaryFont(family)`, `app.breakpoints(small:, medium:, large:)`
/// - `app.typography(slot, fontFamily:, fontSize:, fontWeight:, color:,
///   italic:, letterSpacing:, lineHeight:)` — display/headline/title/body/label scale
/// - `app.spacingToken(name, value)`, `app.radiusToken(name, value)`,
///   `app.shadowToken(name, blurRadius:, dx:, dy:, spreadRadius:, color:)`
/// - `app.customFont(family, files:)` + `CustomFontFile`
/// - `app.customIconFamily(name, iconFilePath:, icons:)` + `CustomIcon`
/// - `app.scrollbar(...)` and `app.pullToRefresh(...)`
library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  await flutterFlowAI(
    buildThemeDesignSystemApp,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    projectName: options.projectName,
    projectId: options.projectId,
    findOrCreate: options.findOrCreate,
    dryRun: options.dryRun,
    commitMessage: options.commitMessage,
  );
}

void buildThemeDesignSystemApp(App app) {
  // ---------------------------------------------------------------------------
  // 1. Color scheme — the 16 named slots
  // ---------------------------------------------------------------------------
  // KEY PATTERN: pass `dark:` for paired light/dark values. Widgets reference
  // these via `Colors.primary`, `Colors.secondaryText`, etc., and FlutterFlow
  // swaps in the dark variant automatically when dark mode is active.
  //
  // SCOPE WARNING: every `app.themeColor(slot, ...)` call below changes a
  // PROJECT-WIDE token. Every widget bound to that slot — across every page
  // and every component — picks up the new value. Use these calls to define
  // the design system, or when the user explicitly asks for a brand/theme
  // change. For "make this one widget a specific color", set the color on
  // the node with `Colors.hex(0xFF...)` in a `patch.color(...)` (edit mode)
  // or `color: Colors.hex(0xFF...)` (greenfield) — do NOT rewrite the slot.
  app.themeColor('primary', 0xFF4B39EF, dark: 0xFF6F61EF);
  app.themeColor('secondary', 0xFF39D2C0);
  app.themeColor('tertiary', 0xFFEE8B60);
  app.themeColor('alternate', 0xFFE0E3E7);
  app.themeColor('primaryBackground', 0xFFF1F4F8, dark: 0xFF14181B);
  app.themeColor('secondaryBackground', 0xFFFFFFFF, dark: 0xFF1D2428);
  app.themeColor('primaryText', 0xFF14181B, dark: 0xFFFFFFFF);
  app.themeColor('secondaryText', 0xFF57636C, dark: 0xFF95A1AC);

  // Accent colors — typically translucent overlays.
  app.themeColor('accent1', 0x4C4B39EF);
  app.themeColor('accent2', 0x4D39D2C0);
  app.themeColor('accent3', 0x4DEE8B60);
  app.themeColor('accent4', 0xCCFFFFFF);

  // Status colors — semantic feedback (snackbars, banners, validation).
  app.themeColor('success', 0xFF249689);
  app.themeColor('warning', 0xFFF9CF58);
  app.themeColor('error', 0xFFFF5963);
  app.themeColor('info', 0xFF1AAB5F);

  // Brand colors that don't fit a slot go on the custom palette.
  app.customPaletteColor(0xFFFF6B35, dark: 0xFFFF8B5C); // brand orange
  app.customPaletteColor(0xFF1FB8CD); // brand teal

  // ---------------------------------------------------------------------------
  // 2. Dark mode + responsive breakpoints
  // ---------------------------------------------------------------------------
  app.darkMode(enabled: true);
  app.breakpoints(small: 479, medium: 991, large: 1200);

  // ---------------------------------------------------------------------------
  // 3. Typography — full Material text scale
  // ---------------------------------------------------------------------------
  // KEY PATTERN: the typography scale is fontSize + fontWeight + optional
  // letterSpacing and lineHeight. fontWeight is an int (100..900); only
  // 100-step values are accepted.
  app.primaryFont('Inter');
  app.secondaryFont('JetBrains Mono');

  // Display: largest hero text (e.g. landing-page hero headers).
  app.typography(
    'displayLarge',
    fontSize: 57,
    fontWeight: 400,
    lineHeight: 1.12,
  );
  app.typography(
    'displayMedium',
    fontSize: 45,
    fontWeight: 400,
    lineHeight: 1.15,
  );
  app.typography(
    'displaySmall',
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.22,
  );

  // Headline: page-level headers.
  app.typography('headlineLarge', fontSize: 32, fontWeight: 700);
  app.typography('headlineMedium', fontSize: 28, fontWeight: 700);
  app.typography('headlineSmall', fontSize: 24, fontWeight: 700);

  // Title: card / section headers.
  app.typography('titleLarge', fontSize: 22, fontWeight: 600);
  app.typography(
    'titleMedium',
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: 0.15,
  );
  app.typography(
    'titleSmall',
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: 0.1,
  );

  // Body: paragraph text.
  app.typography('bodyLarge', fontSize: 16, fontWeight: 400, lineHeight: 1.5);
  app.typography('bodyMedium', fontSize: 14, fontWeight: 400, lineHeight: 1.43);
  app.typography('bodySmall', fontSize: 12, fontWeight: 400, lineHeight: 1.33);

  // Label: buttons, captions, form labels.
  app.typography(
    'labelLarge',
    fontSize: 14,
    fontWeight: 500,
    letterSpacing: 0.1,
  );
  app.typography(
    'labelMedium',
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: 0.5,
  );
  app.typography(
    'labelSmall',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: 0.5,
  );

  // ---------------------------------------------------------------------------
  // 4. Design tokens — spacing, radius, shadow
  // ---------------------------------------------------------------------------
  // KEY PATTERN: prefer named tokens over magic numbers. Tokens become
  // user-selectable in the FlutterFlow editor and stay consistent across
  // the app.
  app.spacingToken('xs', 4);
  app.spacingToken('sm', 8);
  app.spacingToken('md', 16);
  app.spacingToken('lg', 24);
  app.spacingToken('xl', 32);

  app.radiusToken('sm', 6);
  app.radiusToken('md', 12);
  app.radiusToken('lg', 20);
  app.radiusToken('pill', 999);

  app.shadowToken(
    'card',
    blurRadius: 8,
    dy: 4,
    spreadRadius: 0,
    color: 0x14000000, // ~8% black
  );
  app.shadowToken(
    'modal',
    blurRadius: 24,
    dy: 12,
    spreadRadius: -2,
    color: 0x29000000, // ~16% black
  );

  // ---------------------------------------------------------------------------
  // 5. Custom font asset — bundled TTFs
  // ---------------------------------------------------------------------------
  // KEY PATTERN: declare every weight/italic variant you ship. Codegen wires
  // these into pubspec.yaml's `fonts:` section. Default weight is w400 / italic
  // is false.
  app.customFont(
    'Inter',
    files: [
      const CustomFontFile(fontFilePath: 'assets/fonts/Inter-Regular.ttf'),
      CustomFontFile(
        fontFilePath: 'assets/fonts/Inter-Medium.ttf',
        weight: FFFontWeight.w500,
      ),
      CustomFontFile(
        fontFilePath: 'assets/fonts/Inter-Bold.ttf',
        weight: FFFontWeight.w700,
      ),
      const CustomFontFile(
        fontFilePath: 'assets/fonts/Inter-Italic.ttf',
        italic: true,
      ),
    ],
  );

  // ---------------------------------------------------------------------------
  // 6. Custom icon family — bundled icon font
  // ---------------------------------------------------------------------------
  // Codepoints come from the icon font's metadata (e.g. selection.json from
  // Fontello/IcoMoon). Pass them directly as ints.
  app.customIconFamily(
    'BrandIcons',
    iconFilePath: 'assets/icons/brand_icons.ttf',
    icons: const [
      CustomIcon(name: 'logo', codePoint: 0xE001),
      CustomIcon(name: 'sparkle', codePoint: 0xE002),
      CustomIcon(name: 'rocket', codePoint: 0xE003),
    ],
  ); // CustomIcon's ctor is const-evaluable (only String + int), so this list
  // literal can stay const.

  // ---------------------------------------------------------------------------
  // 7. Scrollbar theme — desktop / web polish
  // ---------------------------------------------------------------------------
  // KEY PATTERN: only set the overrides you care about; everything you skip
  // stays at the FlutterFlow default. Color overrides take ARGB ints.
  app.scrollbar(
    thumbVisible: true,
    trackVisible: false,
    thickness: 6,
    radius: 3,
    interactive: true,
    thumbColor: 0x99000000, // 60% black
    thumbHoverColor: 0xCC000000, // 80% black
  );

  // ---------------------------------------------------------------------------
  // 8. Pull-to-refresh indicator
  // ---------------------------------------------------------------------------
  app.pullToRefresh(
    indicatorColor: 0xFF4B39EF, // matches `primary`
    backgroundColor: 0xFFFFFFFF,
    strokeWidth: 3,
  );

  // ---------------------------------------------------------------------------
  // 9. A demo page that uses everything above
  // ---------------------------------------------------------------------------
  app.page(
    'StyleguidePage',
    route: '/',
    isInitial: true,
    description: 'Live preview of the configured theme + design tokens.',
    body: Scaffold(
      appBar: AppBar(title: 'Style Guide'),
      body: Column(
        scrollable: true,
        padding: 16,
        spacing: 16,
        crossAxis: CrossAxis.start,
        children: [
          Text('Headline Medium', style: Styles.headlineMedium),
          Text('Title Large', style: Styles.titleLarge),
          Text(
            'Body large — this is the default reading text. '
            'It should be comfortable to read at long line lengths.',
            style: Styles.bodyLarge,
          ),
          Text('Label small', style: Styles.labelSmall),
          Divider(),

          // Status colors as chips.
          Row(
            spacing: 8,
            children: [
              _statusChip('Success', Colors.success),
              _statusChip('Warning', Colors.warning),
              _statusChip('Error', Colors.error),
              _statusChip('Info', Colors.info),
            ],
          ),

          // Card using the `card` shadow token via direct color reference.
          // KEY PATTERN: the spacing/radius/shadow tokens are project-level —
          // codegen surfaces them in the editor's Design Library, and widget
          // properties pick them up via the IDE rather than through the DSL.
          Container(
            padding: 16,
            borderRadius: 12,
            color: Colors.secondaryBackground,
            child: Column(
              crossAxis: CrossAxis.start,
              spacing: 8,
              children: [
                Text('Card title', style: Styles.titleMedium),
                Text(
                  'Cards inherit `secondaryBackground` so they stay legible '
                  'in light and dark mode without per-mode color logic.',
                  style: Styles.bodyMedium,
                  color: Colors.secondaryText,
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

DslWidget _statusChip(String label, ColorToken color) => Container(
  padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
  borderRadius: 999,
  color: color,
  child: Text(label, style: Styles.labelSmall, color: Colors.primaryBackground),
);

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
