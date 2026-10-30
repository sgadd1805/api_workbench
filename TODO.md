# TODO

## Done (added along the way)

- [x] **Token sources:** named requests that fetch an access token (e.g. OAuth2 client credentials), a
  "token source" auth type for requests / folders / projects (fetched before sending, cached in
  memory until expiry, refetched after a 401), and import from a file (a bare request object, or the
  first request of any export).
- [x] **Login URLs per environment:** listed on the Environments page; the Session toolbar's Login
  picker offers the active environment's URLs, and Creds shows the accounts tagged for it.
- [x] **Git repository panel:** current branch, ahead/behind, uncommitted changes, switch / create
  branches, fetch (side panel → Git; also from the status bar's branch).
- [x] **Notes panel:** Markdown notes in the side panel, per project or global, with insert-request /
  response helpers.

Ideas for making this a better debugging tool, roughly in priority order within each section.

## Big wins

- [x] **Server-log correlation.** Stamp each send with a unique `X-Request-Id` / `traceparent`
  header. Let a project point at its logs (a file to tail, `docker logs`, `kubectl logs`) and show
  the lines, including stack traces, that carry the id next to the response. Optionally link to the
  trace in Jaeger/Zipkin.
  _Touches: `renderer/app/http.js` (header), new `main/logs.js`, a Logs response tab._
- [x] **Task runner for local Java apps.** Per project, define tasks that start the services under
  test locally (e.g. `./mvnw spring-boot:run`, `./gradlew bootRun`, `java -jar target/app.jar`),
  with working folder, JDK (`JAVA_HOME`), Spring profile, JVM options and env vars. Start, stop
  and restart them from the app, show running/stopped state and port, and wait until the app is
  ready (a health URL such as `/actuator/health`, or a log line like `Started …Application`) before
  sending requests. Each task gets a live log view with search, level filtering (ERROR/WARN),
  folded stack traces and "jump to the lines for this request", which pairs with server-log
  correlation above.
  _Touches: builds on `main/terminal.js` (process spawning and kill), a new `main/tasks.js`, tasks in
  the project data, a Tasks panel/page._
- [x] **One-click "Why did this fail?"** Extend Trace to send Claude everything at once: the request
  and response, spec issues, the endpoint's recent commits and diffs, the timing, matching server log
  lines, and the last successful run of the same request.
  _Touches: `main/claude.js` (`tracePrompt`), `renderer/app/actions/response.js`._
- [x] **TLS and network options per environment:** custom CA file / ignore certificate errors,
  client certificates (mTLS), HTTP proxy, HTTP/2 toggle. Needed for internal environments with
  self-signed or company certificates.
  _Touches: `main/http.js` (agents), environment settings UI._
- [x] **Intercepting proxy.** A local HTTP(S) proxy that records other apps' traffic (a frontend, a
  mobile app, another service) into History, with breakpoints to pause, edit and forward requests.
  HTTPS needs a generated local CA certificate.
- [x] **Scripts and a collection runner.** Pre-request and post-response JS (signing, timestamps,
  multi-step flows), going beyond Extract rules. Run a folder of requests, optionally once per CSV
  row, with assertions and a pass/fail report for post-deploy checks.

## Very useful

- [x] **Environment A/B comparison:** send the same request to two environments and diff the
  responses, headers and timing. (Compare mode currently pairs two saved requests.)
- [x] **Better response viewer:** collapsible JSON tree, JSONPath/jq filter, search within the body,
  virtualised rendering for huge responses, image/PDF/HTML preview, save to file.
- [x] **Spec drift and breaking changes:** validate every request in a project against its spec in
  one run, and diff two versions of a spec from git, flagging removed fields, newly required
  parameters and changed types.
- [x] **Token inspector:** decode bearer tokens automatically, show an expiry countdown, warn
  before sending an expired token, re-run the login flow to refresh it.
- [x] **Mock server from the spec:** serve the spec's examples on localhost, with chosen error
  responses for testing failure handling.

- [x] **Configuration guide for AI assistants.** A single doc (e.g. `docs/CONFIGURING.md`, linked
  from an `AGENTS.md` / `CLAUDE.md`) that you can point an AI at to set the app up for a project. It
  would cover:
  - where each data file lives (`db.json`, `history.json`, `accounts.json`, `specs/`) and that the app
    must be closed before editing them;
  - the exact shape of projects, folders, requests, environments, extract rules, assertions, feature
    groups and (later) tasks, with a complete worked example;
  - a JSON Schema for `db.json` so edits can be validated;
  - what must not be written by hand: account secrets, spec documents (attach via
    Specs), ids that other entries reference;
  - recipes such as "add an environment", "create requests for these endpoints", "group them
    under a feature".

  Better still, an importable config file (e.g. `api-client.json` in the code repo) that the app
  reads and merges, so the AI never edits app data directly.

## Rounding it out

- [x] **Load testing:** N requests at a chosen concurrency, with p50/p95/p99 from the existing
  timing data.
- [x] **More protocols:** WebSocket, Server-Sent Events, GraphQL (with schema), gRPC.
- [x] **Collections as files in the repo:** store requests as JSON/YAML in the project's code folder
  so the team versions and reviews them in git.
- [x] **Secret hygiene:** mask tokens in History and exports, and encrypt secrets on disk with the OS's
  protection (Windows DPAPI, macOS Keychain, Linux keyring; Settings → Privacy, on by default).

## UI

Biggest payoff first.

- [x] **Split view with a draggable divider:** request and response side by side, or stacked, with
  a toggle, replacing the fixed stack and the 340 px editor cap.
- [x] **Fewer editor tabs:** keep Params / Headers / Body / Auth; move Spec, Git and docs into a
  collapsible right-hand panel; put Extract / Assertions / Options under "More". Keep the badges.
- [x] **One toolbar:** group Import cURL / Import / Export into one menu, move Envs and Specs into
  project settings, and turn the dev toolbar (Login / Creds / Capture) into a Session drawer or
  part of the status bar.
- [x] **Real code editor** (e.g. CodeMirror, bundled) for bodies and responses: syntax
  highlighting, line numbers, bracket matching, `{{variable}}` autocomplete, collapsible JSON tree,
  wrap toggle. In the URL box, highlight variables, show their value on hover, and mark undefined
  ones red.
- [x] **Direct actions instead of dialogs:** right-click menus in the sidebar, double-click to
  rename, drag-and-drop requests between folders, projects and feature groups; an Undo toast
  instead of typing DELETE.
- [x] **Tools in a side panel, with pop-out:** open Tools (JWT, Base64, JSON, Diff, …) in a
  resizable panel beside the request instead of a separate window, with a button to pop it out into
  its own window and back. Handy extras: send the selected response text or a header value straight
  to a tool (e.g. a bearer token → JWT).
  _Touches: `main/windows.js` (`openToolsWindow`), `renderer/tools/` (runs in a panel as well as
  `tools.html`), main window layout._
- [x] **Status bar:** project, active environment, git branch, running tasks, last response status
  and time.
- [x] **Errors that stay visible:** a notifications list alongside the disappearing toasts.
- [x] **Command palette:** extend ⌘K to actions ("toggle terminal", "new request", "switch
  environment"), plus a `?` shortcut cheat sheet.
- [x] **Welcome screen with quick actions:** new project, import a collection, find specs in a
  folder, recent requests.
- [x] **Light and system themes, and zoom:** colours are already CSS variables.
- [x] **Consistency:** move inline `style="…"` attributes into CSS classes, one SVG icon set
  instead of emoji and text glyphs, minimum 12 px text.
- [x] **Accessibility:** visible focus outlines, arrow-key navigation in the sidebar tree,
  screen-reader labels on icon-only buttons.
