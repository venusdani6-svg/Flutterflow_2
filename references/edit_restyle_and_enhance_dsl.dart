/// Edit reference: Restyle + enhance an existing page.
///
/// Demonstrates:
/// - app.themeColor() — change theme in edit context
/// - page.update() with property patching (color, padding, borderRadius,
///   size, icon, buttonVariant, text, textFieldHint)
/// - page.ensureReplaced() — swap a widget entirely
/// - app.ensureRefreshAction() — add refresh to app bar
/// - app.ensureEmptyState() — add empty state for a list
///
/// Assumes a base project with a page called 'DashboardPage' that has:
/// - A Container named 'HeroCard'
/// - A Button named 'ActionButton'
/// - A TextField named 'InputField'
/// - A ListView named 'ItemList'
library;

import 'package:flutterflow_ai/flutterflow_ai.dart';

// ---------------------------------------------------------------------------
// Base project
// ---------------------------------------------------------------------------

void buildBaseProject(App app) {
  final entry = app.struct('Entry', {'label': string});

  app.state('entries', listOf(entry), persisted: true);
  app.state('hasEntries', bool_);

  app.page(
    'DashboardPage',
    route: '/',
    isInitial: true,
    body: Scaffold(
      appBar: AppBar(title: 'Dashboard'),
      body: Column(
        padding: 16,
        spacing: 12,
        children: [
          Container(
            padding: 16,
            color: Colors.secondaryBackground,
            name: 'HeroCard',
            child: Column(
              spacing: 8,
              children: [
                Text('Welcome', style: Styles.titleLarge, name: 'HeroTitle'),
                Text(
                  'Get started by adding entries',
                  style: Styles.bodyMedium,
                  name: 'HeroSubtitle',
                ),
              ],
            ),
          ),
          TextField(label: 'Entry', hint: 'Type here', name: 'InputField'),
          Button('Submit', width: double.infinity, name: 'ActionButton'),
          Expanded(
            ListView(
              source: AppState('entries'),
              spacing: 8,
              name: 'ItemList',
              itemBuilder:
                  (item) => Container(
                    padding: 12,
                    color: Colors.secondaryBackground,
                    child: Text(item['label'], style: Styles.bodyLarge),
                  ),
            ),
          ),
        ],
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Edit flow — restyle and enhance
// ---------------------------------------------------------------------------

void applyRestylePatch(
  App app, {
  required ProjectPageHandle dashboardPage,
  required ProjectAppStateFieldHandle hasEntries,
}) {
  // KEY PATTERN: themeColor works in edit too — changes project theme.
  //
  // SCOPE WARNING: `app.themeColor('primary', ...)` rewrites the project's
  // primary slot. Every widget bound to `Colors.primary` — across every page
  // and component — picks up the new value (AppBars, buttons, text colors
  // that reference primary, etc.). Only use `app.themeColor(...)` when the
  // user is asking for a project-wide / brand / theme change (as in this
  // `applyRestylePatch` example, which is a full restyle).
  //
  // For "make this one widget a specific color" (e.g. "change this button
  // from blue to purple"), use the node-level pattern further down:
  // `patch.color(Colors.hex(0xFFA020F0))`. That mutates ONLY the targeted
  // node and leaves the theme — and every other widget bound to it —
  // untouched.
  app.themeColor('primary', 0xFF0B57D0);
  app.themeColor('primaryBackground', 0xFFF0F4FF);
  app.themeColor('error', 0xFFDC362E);
  app.primaryFont('Inter');

  app.editPage(dashboardPage, (page) {
    // KEY PATTERN: update() patches multiple properties on a widget in place.
    // The patch builder provides typed methods for each property type.
    page.update(dashboardPage.widgets.byText('HeroCard').single, (patch) {
      // Change the card to have primary color, rounded corners, and padding.
      // (Using the theme slot here because this is a full restyle that
      // *also* rewrote the primary slot above.)
      patch.color(NamedColor('primary'));
      patch.borderRadius(16);
      patch.padding(20);
    });

    // Restyle the button.
    page.update(dashboardPage.widgets.byText('ActionButton').single, (patch) {
      patch.text('Add Entry');
      patch.buttonVariant(ButtonVariant.filled);
      patch.icon('add', size: 20);
    });

    // KEY PATTERN: node-level color override. Use this when the user asks
    // to change a SPECIFIC widget to a SPECIFIC color and you don't want to
    // touch the theme. `Colors.hex(...)` writes a raw ARGB onto this node
    // only — sibling widgets bound to `Colors.primary` (or any other theme
    // slot) are unaffected.
    //
    // page.update(page.findByName('ActionButton'), (patch) {
    //   patch.color(Colors.hex(0xFFA020F0)); // purple, this node only
    // });

    // Update the text field hint.
    page.update(dashboardPage.widgets.byText('InputField').single, (patch) {
      patch.textFieldHint('What would you like to add?');
      patch.textFieldLabel('New Entry');
    });

    // Update hero text.
    page.update(dashboardPage.widgets.byText('HeroTitle').single, (patch) {
      patch.text('Your Dashboard');
    });
    page.update(dashboardPage.widgets.byText('HeroSubtitle').single, (patch) {
      patch.text('Track and manage your entries');
    });

    // KEY PATTERN: ensureReplaced swaps a widget entirely while keeping the
    // same position in the tree. Useful when property patching isn't enough
    // and you need a different widget structure.
    page.ensureReplaced(
      dashboardPage.widgets.byText('HeroSubtitle').single,
      Text(
        'Track and manage your entries below',
        style: Styles.bodyMedium,
        color: Colors.secondaryText,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        name: 'HeroSubtitle',
      ),
    );
  });

  // KEY PATTERN: ensureRefreshAction adds a refresh trigger. When
  // insertIntoAppBar is true, it adds an icon button to the app bar.
  app.ensureRefreshAction(
    page: dashboardPage,
    insertIntoAppBar: true,
    name: 'RefreshButton',
    icon: 'refresh',
    actions: [Snackbar('Dashboard refreshed')],
  );

  // KEY PATTERN: ensureEmptyState wraps a list with conditional visibility
  // and inserts an empty state widget when the list has no items.
  app.ensureEmptyState(
    page: dashboardPage,
    content: EditPatternTarget.byText('ItemList'),
    visibleWhen: AppState(hasEntries),
    emptyState: Container(
      padding: 32,
      alignment: Alignment.center,
      name: 'EmptyState',
      child: Column(
        spacing: 12,
        mainAxis: MainAxis.center,
        children: [
          Icon('inbox', size: 48, color: Colors.secondaryText),
          Text(
            'No entries yet',
            style: Styles.titleMedium,
            color: Colors.secondaryText,
            textAlign: TextAlign.center,
          ),
          Text(
            'Add your first entry above to get started',
            style: Styles.bodyMedium,
            color: Colors.secondaryText,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}
