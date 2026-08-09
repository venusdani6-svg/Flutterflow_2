/// Reference: REST + GraphQL API DSL surface.
///
/// Demonstrates standalone endpoints, all five HTTP methods, GraphQL,
/// per-endpoint headers, body-type variants, and `EndpointSettings`.
///
/// Demonstrates:
/// - `app.api(Endpoint(...))` — standalone (non-grouped) endpoints
/// - `app.apiGroup(...)` — shared base URL + headers + variables
/// - `Endpoint.get / post / put / patch / delete`
/// - `Endpoint.graphql(name, path, query:, variables:, response:)`
/// - per-endpoint `headers:` (the group's `headers:` apply on top)
/// - `HttpBodyType` (`json` default, `text`, `xWwwFormUrlencoded`, `multipart`)
/// - `bodyText:` for non-JSON payloads
/// - `EndpointSettings` (cached, requireAuthentication, private, decodeUtf8,
///   encodeBodyUtf8, alwaysAllowBody, withCredentials, escapeVariablesInRequestBody,
///   streaming, proxyPrefixUrl, noProxyForTest, noProxyForWeb)
/// - calling endpoints from page `onLoad` and from button `onTap` with
///   distinct `outputAs` outputs
library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  await flutterFlowAI(
    buildRestGraphqlApp,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    projectName: options.projectName,
    projectId: options.projectId,
    findOrCreate: options.findOrCreate,
    dryRun: options.dryRun,
    commitMessage: options.commitMessage,
  );
}

void buildRestGraphqlApp(App app) {
  // Minimal theme so the page renders cleanly.
  app.themeColor('primary', 0xFF4B39EF);
  app.themeColor('primaryBackground', 0xFFF1F4F8);
  app.themeColor('secondaryBackground', 0xFFFFFFFF);
  app.themeColor('primaryText', 0xFF14181B);
  app.themeColor('secondaryText', 0xFF57636C);
  app.primaryFont('Inter');

  // ---------------------------------------------------------------------------
  // Data structs (response shapes)
  // ---------------------------------------------------------------------------
  final post = app.struct('Post', {
    'id': int_,
    'userId': int_,
    'title': string,
    'body': string,
  });

  final user = app.struct('User', {
    'id': int_,
    'name': string,
    'email': string,
  });

  final repo = app.struct('Repo', {
    'id': int_,
    'fullName': string,
    'stars': int_,
  });

  // ---------------------------------------------------------------------------
  // 1. Standalone GET — no group needed for one-off endpoints
  // ---------------------------------------------------------------------------
  // KEY PATTERN: `app.api(Endpoint.get(...))` declares a standalone endpoint
  // that compiles to `FFProject.backend.apiConfig.endpoints`. Use this when
  // the call doesn't share a base URL or headers with anything else.
  final ipInfo = app.struct('IPInfo', {
    'ip': string,
    'city': string,
    'country_name': string,
  });
  final getIp = Endpoint.get(
    'GetIPInfo',
    'https://ipapi.co/json/',
    response: ipInfo,
  );
  app.api(getIp);

  // ---------------------------------------------------------------------------
  // 2. Grouped endpoints — shared base URL, shared + per-endpoint headers
  // ---------------------------------------------------------------------------
  // KEY PATTERN: when 2+ endpoints share a base URL, use `app.apiGroup(...)`.
  // Headers compose: group `headers:` apply to every endpoint, and each
  // endpoint can layer additional `headers:` on top.
  final listPosts = Endpoint.get('ListPosts', '/posts', response: listOf(post));
  final getPost = Endpoint.get(
    'GetPost',
    '/posts/[id]',
    variables: {'id': int_},
    response: post,
  );
  // POST with a JSON body. Variables in `<angle>` brackets are substituted
  // at call time. Body type defaults to `json` when `body:` is non-empty.
  final createPost = Endpoint.post(
    'CreatePost',
    '/posts',
    variables: {'title': string, 'body': string, 'userId': int_},
    body: const {'title': '<title>', 'body': '<body>', 'userId': '<userId>'},
    response: post,
  );
  // PATCH = partial update.
  final updatePostTitle = Endpoint.patch(
    'UpdatePostTitle',
    '/posts/[id]',
    variables: {'id': int_, 'title': string},
    body: const {'title': '<title>'},
    response: post,
  );
  // DELETE — no body, but typed all the same.
  final deletePost = Endpoint.delete(
    'DeletePost',
    '/posts/[id]',
    variables: {'id': int_},
  );

  app.apiGroup(
    'JsonPlaceholder',
    baseUrl: 'https://jsonplaceholder.typicode.com',
    headers: {'Accept': 'application/json'},
    endpoints: [listPosts, getPost, createPost, updatePostTitle, deletePost],
  );

  // ---------------------------------------------------------------------------
  // 3. GitHub group — per-endpoint header + endpoint-level cache
  // ---------------------------------------------------------------------------
  // KEY PATTERN: `EndpointSettings(cached: true)` enables in-app caching for
  // the duration of a single run — repeated identical calls won't re-hit the
  // network. Use sparingly: it's a footgun for endpoints whose data must be
  // fresh after a write.
  final getRepo = Endpoint.get(
    'GetRepo',
    '/repos/[owner]/[name]',
    variables: {'owner': string, 'name': string},
    // Per-endpoint header — pinned API version.
    headers: const {'X-GitHub-Api-Version': '2022-11-28'},
    settings: const EndpointSettings(cached: true),
    response: repo,
  );
  // KEY PATTERN: bearer-token auth + `requireAuthentication: true` causes
  // codegen to defer the call until the user is signed in.
  final getCurrentUser = Endpoint.get(
    'GetCurrentUser',
    '/user',
    variables: {'token': string},
    headers: const {'Authorization': 'Bearer <token>'},
    settings: const EndpointSettings(requireAuthentication: true),
  );
  app.apiGroup(
    'GitHub',
    baseUrl: 'https://api.github.com',
    headers: const {'Accept': 'application/vnd.github+json'},
    endpoints: [getRepo, getCurrentUser],
  );

  // ---------------------------------------------------------------------------
  // 4. GraphQL — single factory for query/mutation, lowered to POST + JSON
  // ---------------------------------------------------------------------------
  // KEY PATTERN: `Endpoint.graphql` writes a body of
  //   {"query": "<your query>", "variables": {"id": "<id>", ...}}
  // and adds `Content-Type: application/json`. `variables:` declares the
  // GraphQL variable types — the agent passes their values via `params:` on
  // the `ApiCall(...)` action.
  final getGithubUser = Endpoint.graphql(
    'GetGitHubUser',
    'https://api.github.com/graphql',
    query: r'''
query ($login: String!) {
  user(login: $login) {
    id
    name
    avatarUrl
  }
}
''',
    variables: {'login': string},
    // Bearer is required for GitHub's GraphQL API.
    headers: const {'Authorization': 'Bearer <token>'},
    response: user,
  );
  app.api(getGithubUser);

  // ---------------------------------------------------------------------------
  // 5. Body-type variants — text, x-www-form-urlencoded, multipart
  // ---------------------------------------------------------------------------
  // Form-urlencoded — common for OAuth token exchange.
  app.api(
    Endpoint.post(
      'OAuthTokenExchange',
      'https://example.com/oauth/token',
      variables: {'code': string, 'clientId': string, 'clientSecret': string},
      body: const {
        'grant_type': 'authorization_code',
        'code': '<code>',
        'client_id': '<clientId>',
        'client_secret': '<clientSecret>',
      },
      bodyType: HttpBodyType.xWwwFormUrlencoded,
    ),
  );

  // Plain text body — webhooks / metrics endpoints.
  app.api(
    Endpoint.post(
      'PingMetrics',
      'https://example.com/metrics',
      bodyText: 'metric:ping count:1',
      bodyType: HttpBodyType.text,
      settings: const EndpointSettings(escapeVariablesInRequestBody: true),
    ),
  );

  // Multipart — file upload. The actual file part is wired up at call site
  // with an `UploadDataAction` followed by `ApiCall`.
  app.api(
    Endpoint.post(
      'UploadAvatar',
      'https://api.example.com/avatar',
      bodyType: HttpBodyType.multipart,
      settings: const EndpointSettings(requireAuthentication: true),
    ),
  );

  // ---------------------------------------------------------------------------
  // 6. Streaming + private API — advanced settings
  // ---------------------------------------------------------------------------
  // Server-sent events. Pair with the streaming-response action (out of scope
  // for this reference).
  app.api(
    Endpoint.get(
      'StreamCompletions',
      'https://api.example.com/v1/stream',
      variables: {'token': string},
      headers: const {'Authorization': 'Bearer <token>'},
      settings: const EndpointSettings(streaming: true, decodeUtf8: true),
    ),
  );

  // Private API → deployed as a Firebase Cloud Function so secrets stay off
  // the client.
  app.api(
    Endpoint.post(
      'ChargeCustomer',
      'https://api.stripe.com/v1/charges',
      variables: {'amount': int_, 'currency': string, 'source': string},
      body: const {
        'amount': '<amount>',
        'currency': '<currency>',
        'source': '<source>',
      },
      bodyType: HttpBodyType.xWwwFormUrlencoded,
      settings: const EndpointSettings(
        private: true,
        requireAuthentication: true,
      ),
    ),
  );

  // ---------------------------------------------------------------------------
  // 7. Demo page that calls a few of the endpoints above
  // ---------------------------------------------------------------------------
  // KEY PATTERN: every API call needs a distinct `outputAs:` so its result
  // is addressable as `ActionOutput('<name>')`. Repeating outputs across
  // the same page-scope is rejected by the validator.
  app.page(
    'ApiPlaygroundPage',
    route: '/',
    isInitial: true,
    description: 'Demonstrates REST + GraphQL endpoints.',
    state: {'currentIp': string, 'posts': listOf(post), 'githubUser': user},
    onLoad: [
      ApiCall(
        getIp,
        outputAs: 'ipResult',
        onSuccess: (res) => [SetState('currentIp', res['ip'])],
      ),
      ApiCall(
        listPosts,
        outputAs: 'postsResult',
        onSuccess: (res) => [SetState('posts', res)],
      ),
    ],
    body: Scaffold(
      appBar: AppBar(title: 'API Playground'),
      body: Column(
        scrollable: true,
        padding: 16,
        spacing: 16,
        crossAxis: CrossAxis.start,
        children: [
          Text('Your IP', style: Styles.titleMedium),
          Text(State('currentIp'), style: Styles.bodyLarge),

          Divider(),

          // Lazy GraphQL fetch on tap. The user supplies a literal handle
          // here for brevity; in a real app the token would come from secure
          // storage or app state.
          Button(
            'Look up github.com/octocat',
            onTap: ApiCall(
              getGithubUser,
              outputAs: 'githubUserResult',
              params: {'login': 'octocat', 'token': State('currentIp')},
              onSuccess: (res) => [SetState('githubUser', res)],
              onFailure: [Snackbar('Lookup failed')],
            ),
          ),
          Text(State('githubUser')['name'], style: Styles.titleMedium),

          Divider(),

          Text('First 5 posts', style: Styles.titleMedium),
          ListView(
            source: State('posts'),
            shrinkWrap: true,
            spacing: 8,
            itemBuilder:
                (item) => Container(
                  padding: 12,
                  borderRadius: 8,
                  color: Colors.secondaryBackground,
                  child: Column(
                    crossAxis: CrossAxis.start,
                    spacing: 4,
                    children: [
                      Text(item['title'], style: Styles.labelMedium),
                      Text(
                        item['body'],
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        color: Colors.secondaryText,
                      ),
                    ],
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
