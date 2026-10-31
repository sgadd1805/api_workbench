# API Workbench

An Electron app for building, sending and debugging HTTP, GraphQL, gRPC, WebSocket and
Server-Sent Events requests against your own services.

Requests are sent from the Node main process, not a browser page, so only the headers a request sets
go out. The exceptions are `Host`, `Content-Length`, `Connection`, and default `Accept` /
`Accept-Encoding` / `User-Agent: api-workbench/1.0` headers when the request doesn't set its own.
There is no `Origin`, `Sec-Fetch-*` or `Accept-Language`.

```bash
npm install
npm start      # run the app
npm test       # unit tests (Node's built-in runner)
```

Use Node 22 LTS. Under newer Node versions, Electron's postinstall step can stop partway through
unpacking its binary, and `npm start` then fails with "Electron failed to install correctly".
There is no build step: the main process is CommonJS and the pages load ES modules directly.

### Windows

The app runs on Windows 10 and 11 as well as macOS and Linux.

- **Starting it:** install Node 22 LTS, then double-click `start.bat`. It installs the dependencies
  the first time, then runs `npm start`. `npm install`, `npm start` and `npm test` also work from
  Command Prompt or PowerShell.
- **Terminal panel and tasks** run in Command Prompt by default. Windows PowerShell, PowerShell 7
  and Git Bash are offered when installed.
  - Commands written for macOS / Linux, such as `./mvnw spring-boot:run` or `./gradlew bootRun` in a
    shared `api-client.json`, run the Windows wrappers (`mvnw.cmd`, `gradlew.bat`) under Command
    Prompt and PowerShell.
  - Stopping a task stops everything it started.
- **Paths:**
  - `C:\…` paths work everywhere a file is asked for: code folder, `.proto` files, certificates,
    log files.
  - Paths inside the code folder are stored relative, with `/`, in request files and
    `api-client.json`, so they work for teammates on any OS.
  - Request file names avoid names Windows reserves (`con`, `nul`, `com1` …).
- **Log sources:**
  - **SSH** uses the OpenSSH client built into Windows 10 and 11 (Settings → Optional features →
    OpenSSH Client), with keys from `%USERPROFILE%\.ssh`.
  - **Kubernetes** and **Docker** need `kubectl` / `docker` on `PATH`.
  - **File** sources and log search need nothing extra.
- **Git panel** needs [Git for Windows](https://git-scm.com/download/win) on `PATH`.
- **Ask Claude** opens a Command Prompt window that runs the `claude` command-line tool.
- **Intercepting proxy:** the setup instructions show Command Prompt and PowerShell commands, plus
  `certutil` to trust the local CA for browsers and .NET.
- **Data** lives in `%APPDATA%\api-workbench\`, inside your user profile, which other users of the
  computer can't read. Secrets in it are encrypted with Windows DPAPI, so they only open for your
  Windows login on this PC.

**Setting the app up for a project (or asking an AI to):** see
[docs/CONFIGURING.md](docs/CONFIGURING.md). In short, write an `api-client.json` in the project's code
folder and the app offers to apply it. Every feature with saved settings can be set up this way; the
guide's feature map lists which key covers which feature.

## Features

### Organising requests
- **Projects → folders → requests**, with environments of `{{variables}}` per project.
  - **Right-click** any row for its menu: open, rename, duplicate, move to a folder or project, add
    to a feature, load test, delete. The same menu is on the `⋯` buttons.
  - **Double-click** (or F2) to rename in place. **Drag** requests between folders and projects, or
    onto a feature group.
  - Deleting happens at once, with **Undo** on the notification.
  - **Undo / redo any edit:** ⌘Z / Ctrl+Z and ⌘⇧Z / Ctrl+Y (outside text fields, where they're the
    field's own), or ⌘K "Undo". Covers renames, moves, deletes, request and environment changes,
    features, notes and token sources.
    - Only the items an edit changed go back, so a token or cookie a send stored meanwhile stays.
    - What sends store isn't an undo step.
    - Up to 100 steps.
- **Current** (sidebar → Current): feature groups for what you're working on. Each holds requests
  from any project, with notes and a git branch label. *Open all* opens a group as tabs, and ▶ runs
  it as a collection.
- **Request tabs:** each tab has its own response and send state.
  - Close with × or ⌘W / Ctrl+W, cycle with Ctrl+Tab, and drag to reorder.
  - Open tabs are restored on restart.
- **History** (sidebar → History): every send, searchable. Proxy-captured traffic appears here too.
  - An entry shows what was sent and what came back. You can reopen it, save it as a request, or
    copy it as cURL.
  - On disk, credentials are removed:
    - credential headers;
    - passwords, tokens and API keys in URLs and bodies (secret-named JSON, form and query fields,
      bearer tokens, JWTs, key formats);
    - any value the app holds as a secret.

    This session's own entries keep everything until restart.
- **Requests as files in the repo:** **Project → Save / Load requests**, or *Keep request files in
  sync* in Project settings.
  - Writes one YAML file per request under `api-requests/` in the code folder, for review in git.
  - Secrets are left out.
  - A `git pull` that changes the files offers **Reload**.
- **Setup as a file:** **Project → Export as api-client.json…** writes the project's setup (no
  secret values) to commit or share. **Import → Requests from an api-client.json…** adds the requests
  you tick from any such file.
- **Back up everything:** **Project → Back up everything…** saves one file with all projects,
  features, notes, token sources, settings, spec documents and test accounts. It can also hold the
  files requests use (`.proto` files with their imports, certificates), History, and secrets.
  - **Import → Restore from backup…** lets you pick which projects and parts to restore.
  - A same-named project can be kept beside the restored one or replaced.
  - Files missing on this computer are copied into the app's folder, and the restored requests point
    at the copies.
  - **Password protection:** give a password and the whole file is encrypted with AES-256-GCM, its key
    derived from the password with PBKDF2-SHA256 (600,000 rounds). That makes a backup with secrets
    safe to keep in cloud storage or email. Restoring asks for the password; a wrong one or a damaged
    file is refused before anything is restored.

### Editing
- **Code editor** for bodies, scripts and GraphQL:
  - syntax colouring, line numbers, bracket matching;
  - Tab / Shift+Tab indenting and auto-indent;
  - a wrap toggle;
  - **`{{` autocompletes variables** from the active environment.
- **Dynamic variables**, made when sending:
  - `{{$uuid}}`, `{{$timestamp}}`, `{{$isoNow+1d}}`, `{{$date-7d}}`;
  - `{{$randomInt:1:6}}`, `{{$randomEmail}}`, `{{$randomFullName}}`, `{{$randomAlphaNumeric:12}}` …

  Postman's `$guid` / `$isoTimestamp` names work too. The same expression gets the same value
  throughout one request. Type `{{$` for the list.
- **URL box:** variables are coloured, green when defined and red when not. Hovering shows the value
  (secrets masked) and what set it last.
- **Variable history:** every change to an environment variable, with when, the old → new value, and
  what made it:
  - *“3. POST /orders: extract order.id”*, a script's `vars.set()`, a capture, or an edit.
  - Shown under each environment (Environments page) and for all of them from ⌘K "Variable history".
  - Kept on this computer. Values of secret and credential-looking variables are never kept.
- **Code ▾** (next to cURL) copies the request as JavaScript fetch or axios, Python requests, Java
  (Spring RestClient or java.net.http) or C# HttpClient, with variables resolved.
- **Editor tabs:** Params, Headers, Body (raw / JSON / form), Auth (inherit / none / bearer / basic /
  token source), and More:
  - Extract rules;
  - Assertions;
  - Options (timeout, redirects);
  - Pre-request and post-response **scripts**.
- **Scripts** are JavaScript run in a sandboxed worker with a 5 s limit. They can use:
  - `request` (editable before sending) and `response`;
  - `vars.get/set` (saved to the environment);
  - `test()` / `expect()`;
  - `ctx.crypto.hmac/sha`, `ctx.uuid`;
  - `ctx.setNextRequest()` (in the runner).

  Project-wide scripts run first.

### Protocols
Choose the protocol in the method dropdown.
- **GraphQL:** Query and Variables editors.
  - *Fetch schema* introspects the endpoint and shows an explorer.
  - *Use* on a root field writes a query skeleton with its variables.
  - GraphQL `errors` in a 200 response are flagged, and they fail the runner.
- **gRPC:** load a `.proto` file (plus import paths) and pick the service and method. The message
  tab is a JSON editor with a template.
  - Unary, server-, client- and bidi-streaming calls are supported.
  - Metadata comes from the Metadata tab and auth.
  - The address is `grpc://host:port`, or `grpcs://` for TLS with the environment's network settings.
  - gRPC status codes map to HTTP ones (NOT_FOUND → 404 …), so assertions and the runner work.
- **WebSocket:** *Connect* with the request's headers and auth. Send messages ({{variables}}
  resolved) and see both directions in a live, filterable log.
- **Server-Sent Events:** *Listen* streams events (name, data, id) into the log until you stop it.

### Responses
- **Viewer:** Pretty / Tree (collapsible JSON) / Raw / Preview views.
  - A **JSONPath filter** (`$.items[*].id`, `$..price`, `[?(@.price < 10)]`).
  - **Search** with match stepping, and a wrap toggle.
  - Images, HTML (sandboxed) and PDFs preview.
  - *Save…* writes any body, binary included. *Open ↗* opens it in its default app.
  - Very long bodies render their first 5,000 lines until you ask for all.
- Headers, a per-phase **Timing** waterfall (DNS, TCP, TLS, TTFB, download, per redirect) and
  **History** (diff against earlier runs).
- **Response-time trend:** each request remembers its last 300 response times, per environment.
  - A sparkline next to the response time shows the recent runs.
  - **▲ 2.8× slower than usual** appears when a send is markedly slower than the request's usual
    runs in that environment. That means at least 5 earlier runs, at least twice the median, above
    the 95th percentile, and 100 ms or more slower.
  - The History tab charts the last 100 runs with p50 and p95 lines, slow runs marked, and switches
    for this environment or all of them, plus Reset.
  - The collection runner marks slow requests in its Time column.
- **Trace:** a local OpenTelemetry receiver (status bar ◉, or the Trace tab), accepting OTLP/HTTP on
  4318 and gRPC on 4317.
  - The app's spans for each request are drawn as a waterfall across services, with DB calls,
    outgoing HTTP, errors and slow spans marked. Click a span for its attributes and exception
    events.
  - Tasks started while the receiver runs get `OTEL_*` settings, so an OpenTelemetry agent exports
    here.
- **Snapshot:** save a response as the expected one. Later responses are compared field by field.
  - Ignore volatile fields by name (`createdAt`) or path (`$.items[*].id`, `$..traceId`), one click
    per difference.
  - A difference shows on the response and fails the collection runner. Snapshots travel with the
    repo request files.
- **Report:** a bug report as Markdown (copy, or save) or an HTML page. It holds:
  - the request and response, checks, timing;
  - matching server log lines and the trace;
  - a cURL to reproduce it.

  Credentials are redacted.
- **Logs:** each send carries `X-Request-Id` and W3C `traceparent`. The Logs tab shows the matching
  lines from the project's running tasks and log files, stack traces included.
- **Why did this fail? / Ask Claude** opens Claude with the request, response, spec check, timing,
  server logs, recent commits and the last good run. It is off until you turn on AI assistance in
  **Settings → Privacy**.
  - **What Claude is sent:** tick the sections each prompt includes (request and response heads and
    bodies, spec check, warnings, timing, log lines, last good run, commits, commit author names; for
    Investigate, the page HTML, console logs, network calls and their bodies). You can also add extra
    instructions to every prompt.
  - **Passwords, tokens, API keys and cookies are always removed** from the whole prompt:
    - credential headers;
    - secret-named fields in URLs, JSON, form bodies, YAML, log lines and HTML inputs (`password`,
      `token`, `api_key`, `client_secret` …);
    - bearer tokens, JWTs, private keys and well-known API key formats;
    - every value the app holds as a secret: auth, secret variables, cookies, test-account passwords
      and cached tokens. Values shorter than 4 characters are not matched this way.
- **Compare:** two requests side by side, or **the same request against two environments** (status,
  timing, changed headers, body diff).

### Specs (OpenAPI / Swagger)
- **Attaching specs:**
  - Find them in the code folder, pick a file, or fetch from a URL (e.g. `/v3/api-docs`).
  - *Create requests…* builds requests from the operations.
- **Checking requests:**
  - Each request's **Spec** panel shows the operation's docs and checks the request before you send.
  - After a send, the response is checked too.
- **Check all requests:** validates every request in the project against its spec without sending.
  It also lists operations no request covers.
- **Compare with git…:** diffs the spec against any earlier commit and lists **breaking changes**:
  - removed operations, fields or success responses;
  - new required parameters or fields;
  - narrowed request types or enums;
  - changed response types.
- **Mock server:** serves the spec's examples on localhost.
  - The base path is kept.
  - Choose a status per operation (any documented code, common errors, or *drop connection*), or force
    one per call with `X-Mock-Status` / `?__status=`.
  - Latency is adjustable.
  - *Use as "mock" environment* points `{{baseUrl}}` at it.

### Running and testing
- **Collection runner** (Project → Run collection, or ▶ on a folder or feature):
  - runs in order, with iterations or **CSV data rows** as variables;
  - delay between requests, and stop on first failure;
  - `setNextRequest` flows;
  - pass/fail from assertions, script tests, spec errors and HTTP status;
  - export as JSON or **JUnit XML**;
  - the same run from the command line, for CI: see [Running in CI](#running-in-ci).
- **Spring Boot Actuator** (Project → Spring Boot Actuator, or *Actuator* on a running task):
  - Health, with components.
  - Environment: every property with its source, overridden values marked.
  - Mappings: **Create requests**, a folder per controller with `{{baseUrl}}` and path variables.
  - Loggers: **change log levels live**, e.g. DEBUG on one package. **Reset all** puts back
    everything you changed.
- **Load test** (⌘K → "load test"): N requests, or run for a duration, at a chosen concurrency.
  Reports p50/p90/p95/p99, throughput, status codes, and a histogram and timeline.
- **Tasks & logs:** start local services (Maven / Gradle / `java -jar` detected) with profile, JVM
  options and environment variables.
  - A task is ready when a log regex matches or a health URL answers, and sends wait for it.
  - Logs are live, searchable and level-filtered, with stack traces folded into their entry.
  - **Log sources**, to follow live and search where the logs live:
    - **Server (SSH):** files on a server, using your ssh keys, agent and `~/.ssh/config`, never a
      password. Follow runs `tail -F`. Search runs `grep` on the server, including rotated `.gz` files.
    - **Kubernetes:** a deployment, pod or label selector. Search fetches a time window.
    - **Docker:** a container. Search fetches a time window.
    - **File on this computer:** search takes `*` patterns and `.gz` files.
    - **Command:** any command's output (live filter only).
  - **Search logs:** text or regex, ignore case, context lines, and the time window. Search one source
    or all of them at once. Matches are highlighted, with line numbers and the file or pod.
  - **⧉ Pop out** opens a task's or source's logs in their own window, one window per source, so you
    can watch several servers side by side.
    - The window has the live log (filter, level, follow), Search, and Start / Follow / Stop.
    - Open windows come back after a restart. *Dock to main window* returns to the Tasks & logs page.
  - **Log watch** (Flagged tab): ERROR / FATAL lines, plus your own text or `/regex/` patterns, are
    flagged as they arrive.
    - A status-bar count and notifications.
    - Each response shows "⚠ N flagged log lines" that appeared while it ran, listed in its Logs tab.
  - A response's **Logs** tab has **Search server logs**: finds that request's `X-Request-Id` /
    trace id in every source over the last hour.

### Network and auth
- **Per-environment network settings:** extra CA file, skip verification, client certificate (PEM
  or PFX), HTTP proxy, and HTTP/2.
- **Token sources:** OAuth client-credentials, password grant, or any login request.
  - The token is fetched before sending, cached until it expires, and refetched after a 401.
  - The token chip decodes JWTs and warns before sending an expired token.
- **Login URLs per environment** and a Session toolbar for logging in to the real site:
  - use its cookies and bearer token;
  - turn its captured calls into requests: **Capture → Network** lists every call the login window
    made (status, method, path, host, type, time, size), with a filter. Click a call (or Enter) to open
    it in the app: it's added to the project's *Captured* folder, or reopened if it's already there,
    and its tab shows the response the page got, marked *captured*. Send it to replay it from the
    app. *→ Requests* still adds several at once;
  - **a detail pane:** a single click on a call shows its request headers, payload, response headers
    and body beside the list. Double-click, Enter or *Open in app* opens it;
  - **Import HAR…** (or Import → HAR file) adds the calls from a `.har` saved in Chrome, Edge or
    Firefox DevTools (Network → Save all as HAR) to the same list, API calls only, for previewing,
    opening or saving as a flow;
  - **vs captured:** a request opened or saved from the capture keeps the response the page got.
    After you send it, or replay its flow, a *vs captured* tab shows the status and JSON field changes
    and a diff (key order ignored). The runner notes `≠ captured: 2 fields` beside such results;
  - captured requests work beyond the capture: the host becomes an environment variable
    (`{{baseUrl}}`, or an existing variable that matches), browser-only headers (cookies,
    `user-agent`, `sec-*` …) are dropped, and a captured bearer token becomes the request's auth with
    a secret `{{token}}` (or is dropped when the project already sends auth);
  - **Save as flow:** tick calls in the Network list (Shift for a range, or *Select all*) and save
    them, in order, as a folder that replays in the collection runner.
    - Values one response hands to a later request are linked: a token, a CSRF header, a user id, a
      new order's id. The earlier request gets an extract rule (`order.id → orderId`) and the later
      ones use `{{orderId}}` in their URL, headers, body or auth. Numbers stay numbers in JSON.
    - So a replay logs in again, creates new records and follows its own ids rather than the captured
      ones. Capturing the flow again reuses the same variable names;
    - Linked credentials (tokens, CSRF values) become secret variables: masked, and encrypted on disk.
    - **Checks** (on by default) are added per step from the captured responses: the status, the
      JSON shape, and fields that look stable compared exactly (`body.order.status === "OPEN"`).
      Ids, tokens, times and numbers are only checked by type, so a replay in the runner or the CLI is
      a regression test;
  - fill saved test accounts (passwords and TOTP secrets).
- **Intercepting proxy** (Project → Intercepting proxy): point an app, a phone or a JVM at it and
  every exchange is recorded (and added to History).
  - **Allow other devices** opens it to your network so phones can use it. It has no password, so anyone
    on the same network could use it and reach services listening only on this computer. The app
    warns while it's on (the status bar says *open to network*); use it only on networks you trust.
  - **Decrypt HTTPS** with a local CA. Export it, or download it on a device at
    `http://<address>:<port>/ca.crt`. The page shows the `keytool` / `NODE_EXTRA_CA_CERTS` steps.
  - **Breakpoints** pause matching requests to edit and forward, or drop.
  - Any exchange can be saved as a request or copied as cURL.
  - **Mock from traffic:** serve one host's recorded responses from a local mock, e.g. to stand in
    for a downstream service you can't run.
    - Ids in paths are generalised.
    - Each route answers with its latest response, or any other recorded status you pick.
- **Secrets:**
  - **What's encrypted:** tokens, passwords, cookies, secret variables, certificate passphrases,
    Session test-account passwords and TOTP secrets, and the proxy's CA key. They're encrypted on disk
    with the operating system's protection:
    - **Windows:** DPAPI, tied to your Windows login;
    - **macOS:** a key in the Keychain;
    - **Linux:** a key in the system keyring (GNOME Keyring / KWallet).
  - It's on by default (**Settings → Privacy → Secrets on disk**, or ⌘K "encrypt"). Turning it off
    or on rewrites the files at once. Data from older versions is encrypted the first time the app
    opens it.
  - Encrypted secrets only open for your user account on this computer. Copying the data folder to
    another computer or user doesn't carry them: they're cleared with a warning. Use **Back up
    everything** with secrets to move them.
  - Where no protection is available (Linux with no keyring running), secrets are stored as plain
    text, and Settings says so.
  - The data files are also readable by your user account only.
  - Secret values are masked on screen, redacted in History, and left out of exports unless you ask.
  - The command-line runner can't read encrypted secrets. Pass the ones a run needs with
    `--var name=value` or `AW_VAR_name`.

### MCP server (Claude Code, Claude Desktop …)

**Settings → MCP server** lets an MCP client use the app while it runs. It's off by default.

- **What a client can do:**
  - find projects, requests, environments and API operations (`list_projects`, `list_requests`,
    `get_request`, `list_environments`, `search`, `get_operation`);
  - send a saved request the way the app does: auth, token sources, variables, scripts, extract
    rules, assertions, spec check (`send_request`);
  - send an ad-hoc call in a project's context (`send_http`). It carries the project's auth, so it
    only goes to hosts the project's saved requests or URL variables already use (so does the URL
    of a request saved with `save_request`);
  - run a folder or feature (`run_collection`);
  - read History and the log lines of running tasks and log sources (`history`, `find_logs`).
- **Who can connect:** the server listens on `127.0.0.1` only, and every call needs the token shown
  in Settings. Calls from a web page are refused: the Host and Origin are checked.
- **Hide credentials** (on by default): credential headers, the app's secret values, and passwords,
  tokens and keys in URLs and bodies are removed from everything a client sees.
- **Allow changes** (off by default) adds `save_request`, which creates or updates saved requests.
  Those edits can be undone with ⌘Z.
- **Setting it up:** Settings shows what to paste.
  - **Claude Code:** `claude mcp add --transport http api-workbench http://127.0.0.1:3920/mcp --header
    "Authorization: Bearer <token>"`.
  - **Claude Desktop:** `node <app folder>/bin/api-workbench-mcp.js` as a local MCP server in
    `claude_desktop_config.json`. This small bridge relays stdio to the running app, reading the
    address and token from `mcp.json` in the app's data folder, so no token goes in the client's
    config.
- **Starting with it on:** `npm run start:mcp` (or `API_WORKBENCH_MCP=1 npm start`) switches it on
  as the Settings checkbox would, and it stays on.
- The token is encrypted with your other secrets, and **New token** cuts off clients set up with the
  old one. The server isn't something an `api-client.json` can switch on.

### Workspace
- **Layout:** side-by-side or stacked request and response.
  - A resizable side panel with Spec, Git, Notes and Tools. Tools (JWT, Base64, JSON, Diff, Hash,
    Timestamp, Regex, XML …) can pop out into their own window.
    Their history keeps no credentials: JWT, Base64 and Hash keep only a short label, and the others'
    text has passwords, tokens, keys and JWTs blanked.
  - **Diff** compares two texts (pasted, opened from files, or two responses sent with *Send to
    Diff*) or two folders.
    - Side by side or unified, with line numbers and the changed words marked.
    - Unchanged stretches fold away. ↑ / ↓ (or Alt+↑ / Alt+↓) jump between changes.
    - It can ignore whitespace, case, and JSON key order. JSON and XML are pretty-printed first.
    - JSON also gets a list of changed fields by path (`$.items[2].price: 10 → 12`).
    - *Copy patch* gives a `diff -u` patch.
    - Large inputs stay fast: 60,000 lines take milliseconds.
  - The other tools:
    - **JSON:** shows the line and column of a syntax error, sorts keys, and runs JSONPath queries.
    - **JWT:** says whether the token is valid or expired, with the time claims and key fields.
    - **URL:** splits a URL into its parts and query parameters.
    - **Hash:** HMAC with a key, and Base64 output.
    - **Regex:** a replace preview, and a table of every match with its groups.
    - **Base64:** a URL-safe (base64url) option.
  - A status bar shows the project, environment, tasks, proxy and notifications.
- **Git panel:** the current branch, switching and creating branches, and a request's history (the
  files that define the endpoint and the commits that changed them).
- **Notes:** Markdown notes per project or global.
  - **Tags:** add them in the Tags field, comma separated. Filter with the tag bar, or type `#tag` in
    the search box.
  - **⧉ Pop out** moves Notes into their own window. It reopens on restart if it was open when you
    quit. *Dock to main window* brings Notes back into the side panel.
- **Terminal** (Ctrl+\`): runs commands in the project's code folder with the environment's variables
  set.
  - **Tabs**, each with its own shell, folder, output and running command, so they run side by side.
  - Add a tab with + or Ctrl+Shift+T. Switch with Alt+1…9 or Ctrl+PageUp/PageDown. Double-click a tab
    to rename it.
  - A dot marks a running command, or new output in a background tab.
  - Tabs (name, shell, folder) are restored on restart.
- **⌘K / Ctrl+K palette:** requests, every spec operation, actions, and **every setting and page**, so
  the whole app can be driven from the keyboard.
  - Settings show their current state (on / off, current theme, zoom %). Enter flips a toggle and
    keeps the palette open, so you can change several in a row.
  - It covers:
    - theme, zoom, layout, side panel, Session toolbar, editor wrap;
    - AI assistance and each AI prompt section;
    - the trace receiver and proxy options;
    - the selected project's correlation headers and log watch;
    - the active environment's TLS verification and HTTP/2;
    - the open request's redirects.
  - Every page, sidebar view, side-panel tab and tool can be opened from it.
  - Type `>` first, or press ⌘⇧P / Ctrl+Shift+P, to see only actions, settings and pages. `>` alone
    lists them all.
- **Keyboard and screen readers:**
  - The sidebar is an ARIA tree: arrows move and expand, Enter opens, F2 renames, Delete deletes,
    and Shift+F10 opens the menu.
  - Focus outlines are always visible.
  - Icon-only buttons are labelled.
- **Settings:** theme (dark / light / system), zoom and layout.

## Running in CI

`bin/api-workbench.js` runs a project's requests without the app's window, with the same checks as
the collection runner: assertions, script tests, snapshots, spec errors and HTTP status.

```bash
node bin/api-workbench.js run "Pet Store" --env staging --junit results.xml
```

It exits with **0** when everything passed, **1** when anything failed, and **2** for bad arguments
or setup (unknown project, environment or folder; missing files). `npm run cli -- run …` does the
same, and `npm install -g .` (or `npm link`) in this folder puts an `api-workbench` command on your
`PATH`.

**Where the project comes from:**

- **`--config path/to/api-client.json`:** the file is applied in memory, as the app would apply
  it, including its specs. Nothing else is needed, which makes it the usual choice in CI. The
  project name may be left out.
- **A project name:** read from the app's data folder (`db.json` and `specs/`, see [Data](#data)).
  Use `--data <dir>` to point at another copy of that folder. The defaults are:
  - macOS: `~/Library/Application Support/api-workbench/`
  - Windows: `%APPDATA%\api-workbench\`
  - Linux: `~/.config/api-workbench/`

A run never writes to the app's data. Values set by extract rules and scripts last for the run only,
and nothing goes to History.

**Options** (`--help` lists them all):

| Option | |
|---|---|
| `-e, --env <name>` | Environment. Default: the project's active one. |
| `-f, --folder <name>`, `--feature <name>` | Only one folder, or one feature group's requests. |
| `-n, --iterations <n>`, `-d, --data-file <file>` | Run n times, or once per row of a CSV (first row = column names) or JSON array, with the columns as variables. |
| `--delay <ms>`, `--bail` | Pause between requests; stop at the first failure. |
| `--var name=value` | Set a variable (repeatable). |
| `-k, --insecure`, `--ca-file`, `--cert` + `--key`, `--pfx`, `--proxy`, `--http2` | Override the environment's Network settings. The certificate passphrase comes from `AW_PASSPHRASE`. |
| `--junit <file>`, `--json <file>` | Write JUnit XML (as the Runner page exports it) or the results as JSON. |
| `-v, --verbose` | Also show script `log()` output and warnings for passing requests. |
| `list` | `api-workbench list [--data <dir> \| --config <file>]` lists projects, environments and folders. |

**Secrets.** Secret variables are blank in `api-client.json`, so the run needs their values from CI:

- an environment variable `AW_VAR_<name>`, e.g. `AW_VAR_clientSecret` for `{{clientSecret}}`;
- or `--var name=value`, which wins over `AW_VAR_`. Command lines can show up in process lists, so
  prefer `AW_VAR_` for secrets.

A secret variable that is still blank gets a warning. Secret values are never printed, nor written to
the JUnit or JSON files: they show as `[REDACTED]`. That covers variables marked secret, variables
whose names look like credentials (`token`, `password`, `apiKey` …), auth tokens and passwords,
cookies, fetched tokens, and anything shaped like a JWT or a `Bearer` credential.

**Output.** Each request prints PASS or FAIL with its method, name, status and time. A failure also
shows its URL and every failed check. A summary and the list of failures come last. Under GitHub
Actions (`GITHUB_ACTIONS=true`), failures also become `::error` annotations. Colour is used on a
terminal; `NO_COLOR=1` or `--no-color` turns it off, and `FORCE_COLOR=1` turns it on for CI logs.

**What doesn't run:** WebSocket and SSE requests fail in a run, as they do in the app's runner, so
keep them out of the folders you run. Tasks (local services) aren't started: start the service
under test in an earlier CI step.

**Scripts** run in a worker thread with a fresh JavaScript context, as in the app: no `require`,
`process`, files or network, an empty environment, and the same 5 s limit. Node's `vm` is not as
strong a boundary as the app's Chromium sandbox, so run collections you trust, as with any test
code in CI.

**GitHub Actions example**, for a service repository with an `api-client.json` (replace
`your-org/api-workbench` with wherever your copy of this app lives):

```yaml
name: API checks
on: [push, pull_request]
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with: { repository: your-org/api-workbench, path: .api-workbench }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # The command-line runner doesn't need Electron, so skip the dev dependencies.
      - run: npm ci --omit=dev
        working-directory: .api-workbench
      # … start the service under test here …
      - run: node .api-workbench/bin/api-workbench.js run --config api-client.json --env staging --junit api-results.xml
        env:
          AW_VAR_clientSecret: ${{ secrets.STAGING_CLIENT_SECRET }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: api-results, path: api-results.xml }
```

**Windows:** the command works the same in Command Prompt and PowerShell. Set secrets with
`set AW_VAR_token=…` (Command Prompt) or `$env:AW_VAR_token = '…'` (PowerShell), and quote names
that contain spaces with double quotes.

## Data

The app's data lives in its user-data folder (macOS: `~/Library/Application Support/api-workbench/`):

| File | Contents |
|---|---|
| `db.json` | Projects, features, notes, token sources and settings, including secrets (encrypted with the OS's protection; file readable by your user only). |
| `history.json` | The last 200 sends, with credentials removed from headers, URLs and bodies. |
| `timings.json` | Each request's last 300 response times (time, status, environment), for its trend. |
| `accounts.json` | Session-toolbar test accounts, their passwords and TOTP secrets encrypted (readable by your user only). |
| `specs/` | Attached spec documents. |
| `proxy-ca/` | The proxy's local CA and its key, encrypted (readable by your user only). |
| `restored-files/` | Files a backup restore copied here because their original path was missing. |
| `mcp.json` | While the MCP server is on: its address and token, for `bin/api-workbench-mcp.js` (readable by your user only). |

Don't edit these by hand. To move to another computer, use **Back up everything** and **Restore from backup**. Use `api-client.json` instead ([docs/CONFIGURING.md](docs/CONFIGURING.md)).

## Layout

```
main.js                 App lifecycle; registers each main/*.js module's IPC handlers
main/
  windows.js            Main + Tools windows, navigation lock-down
  storage.js, secrets.js db.json in userData (mode 600); which values are secrets (redaction, exports)
  http.js, network.js   Request transport, phase timing, binary bodies; TLS / client certs / proxy / HTTP/2
  protocols.js          WebSocket (ws), Server-Sent Events, gRPC (@grpc/grpc-js + proto-loader)
  proxy.js, proxyca.js  Intercepting proxy; local CA + leaf certificates (node-forge)
  mock.js               Mock server from a spec's route table
  load.js               Load test runner and statistics
  specs.js              Find / read / bundle / store OpenAPI documents (YAML via js-yaml)
  repofiles.js          Requests as YAML files in the repo (write / read / watch)
  git.js                Endpoint history, branches, file versions
  tasks.js, logs.js     Local services; log stores, tailing, correlation search
  serverlogs.js         Server log sources (ssh / kubectl / docker / files): tail commands and search
  backup.js             Files a full backup carries (.proto files with imports, certificates); restoring missing ones
  otel.js               OpenTelemetry receiver (OTLP/HTTP + gRPC) and per-trace span store
  history.js            history.json (redacted)
  timings.js            timings.json: response times per request (trends)
  files.js, folders.js  Save / open dialogs, open in default app, folder compare
  terminal.js           Shell commands with streamed output
  login.js, har.js, accounts.js, totp.js   Session toolbar: login window, capture, test accounts
  claude.js             "Why did this fail?" → claude in a terminal (prompt sections from Settings, secrets removed)
preload.js              window.electronAPI: the only bridge from pages to main (channel names must match main/*.js)
bin/api-workbench.js    Command-line runner entry (Running in CI)
cli/
  main.mjs, args.mjs    Commands and options; exit codes
  load.mjs              db.json or api-client.json → in-memory DB; project / environment / scope, --var and AW_VAR_
  node-api.mjs          window.electronAPI for Node: calls main/http.js, protocols.js and specs.js directly
  sandbox.mjs, sandbox-thread.cjs   Script sandbox for Node (worker thread + vm context)
  report.mjs            Console progress, JUnit / JSON files, secrets redacted

renderer/
  shared/               html.js, json.js, highlight.js (syntax colouring), icons.js (SVG icon set), dynvars.js ({{$uuid}} …),
                        notesview.js, logview.js (shared by windows), diff.js, markdown.js, notify.js
  toolbar/              Session toolbar
  tools/                Tools (side panel / own window)
  app/
    store.js            DB + UI state (shapes documented at the top), lookups and mutations
    http.js             Stored request → wire request; send (scripts, token sources, extract rules, retries)
    protocols.js        Request kinds: GraphQL body + schema, gRPC proto, WebSocket / SSE streams
    editor.js           Code editor + URL field variable highlighting and autocomplete
    jsonpath.js         Response filter
    scripts.js, script-worker.js   Pre / post scripts in a worker
    runner.js           Collection runner, judging, JUnit
    verify.js           Assertions, snapshot and spec checks on a finished send (app and command line)
    tokens.js           Token sources, JWT inspection
    tasks.js            Task / log state in the renderer
    repo.js, config.js  Requests as repo files; api-client.json applying and export
    backup.js           Full backup and selective restore (ids remapped, files relinked)
    snapshot.js, report.js, recorded.js, actuator.js, logwatch.js   Snapshot tests, bug reports, proxy → mock routes,
                        Actuator parsing, log watch rules
    undo.js, a11y.js    Undo for deletes; keyboard tree and accessible names
    openapi/            spec analysis, schema checks, validation, examples, docs, drift, diff, mock routes
    events.js           Event delegation (click → actions, input/change → fields)
    views/              One render module per region or page
    actions/            data-action handlers grouped by area
assets/                 logo.svg (the app's mark) and icon.png (it rendered at 512 px: window and dock icon)
docs/                   CONFIGURING.md, api-client.schema.json, examples/
test/                   node:test suites (renderer modules imported directly with a stubbed window.electronAPI)
```

## Common changes

- **New main-window button:** render it with `data-action="name"` in a `renderer/app/views/`
  module and add a `name` handler to the matching group in `renderer/app/actions/`.
- **New editor tab:** add it to `REQUEST_TABS` / `TAB_BODIES` in `renderer/app/views/request.js`.
  For other request kinds, use `KIND_TABS` (protocols.js) and `KIND_TAB_BODIES` (views/kinds.js).
  Map its inputs in `ON_INPUT` / `ON_CHANGE` (events.js).
- **New per-request UI state:** add it to `newTab()` in `store.js` and read it via `activeTab()`.
- **New request field:** document it in `store.js`, give it a default in `normalizeRequest()`, and
  use it in `buildRequest()` (http.js). If it should be shared, also add it to repo.js (request files)
  and config.js plus `docs/api-client.schema.json`.
- **New main-process capability:** add an `ipcMain.handle` in the relevant `main/*.js` module's
  `register()`, then expose it in `preload.js`.
- **Icons:** add a path to `renderer/shared/icons.js` and use `icon('name')`.
- **Spacing:** use the utility classes at the end of `styles/app.css`, not `style="…"`.
