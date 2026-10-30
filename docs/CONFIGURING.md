# Configuring API Workbench for a project

This guide is for people and AI assistants setting the app up for a codebase. **The short version:
write an `api-client.json` in the project's code folder and let the app apply it.** Don't edit the
app's own data files.

Every feature that has saved settings can be set up from `api-client.json`. The
[feature map](#2-feature-map-where-each-feature-is-configured) shows which key covers which feature,
and names the few things that are entered in the app on purpose (secrets, and switches that send
data off this computer).

Contents:

1. [`api-client.json`: applying it](#1-api-clientjson-applying-it)
2. [Feature map: where each feature is configured](#2-feature-map-where-each-feature-is-configured)
3. [Reference](#3-reference)
4. [Recipes](#4-recipes)
5. [Export a project as `api-client.json`](#5-export-a-project-as-api-clientjson)
6. [Import just some requests](#6-import-just-some-requests)
7. [Back up and restore everything](#7-back-up-and-restore-everything)
8. [Sharing requests through git: request files](#8-sharing-requests-through-git-request-files)
9. [The app's data files (don't edit by hand)](#9-the-apps-data-files-dont-edit-by-hand)
10. [Checking your work](#10-checking-your-work)
11. [Running the checks in CI](#11-running-the-checks-in-ci)

## 1. `api-client.json`: applying it

Put `api-client.json` at the root of the project's code (the folder you'd set as the project's
*code folder*). The app offers **Apply**:

- when a project whose code folder contains the file is selected or the app starts, and the file
  is new or changed since it was last applied;
- from **Project → Apply api-client.json**, or the command palette (⌘K / Ctrl+K → "api-client");
- from **Import → api-client.json (project setup file)…** for a file anywhere. Its folder becomes
  the code folder for relative paths.

The format is defined by [`api-client.schema.json`](api-client.schema.json). Point your editor at it
with `"$schema"` for completion and validation. [`examples/api-client.json`](examples/api-client.json)
is a complete example that uses every section.

### How applying works

- Everything is **matched by name**:
  - the project: the one selected, else `project.name`, else a new one;
  - environments, folders, features, tasks, log sources and token sources by name;
  - requests by name within their folder;
  - notes by title; test accounts by label and environment.
- What the file says **wins** for the fields it sets. Fields it leaves out are kept.
- **Nothing is deleted.** Remove things in the app.
- Relative paths are relative to the code folder. That covers specs, `.proto` files and include
  folders, certificates, log files and task working folders. Write them with `/`; they work on
  Windows too (`certs/ca.pem` becomes `C:\code\orders\certs\ca.pem`). Exports write them the same way.
- Order doesn't matter in the file. The app applies token sources first, so requests can refer to
  them by name.
- After applying, the app:
  - attaches the specs listed under `specs` (URL specs need the service running);
  - links requests that name an `operation` to it in those specs;
  - adds new test accounts.

  Then it reports what changed and any warnings.

### What never goes in the file

**Never put real tokens, passwords or keys in `api-client.json`.** It is meant to be committed.

- Use `{{variables}}` in auth, headers, bodies and token sources. Mark the variable
  `{ "secret": true }` and each person enters their own value in **Environments**.
- Certificate passphrases, test-account passwords and TOTP secrets are entered in the app. The file
  has no field for them, and a `passphrase` in `network` is ignored.
- Two switches can only be turned on in the app:
  - **AI assistance**, which sends data to Anthropic;
  - **letting other devices use the proxy**, which opens a port to your network.

  A file can't turn on either one.

## 2. Feature map: where each feature is configured

| Feature (see the README) | In `api-client.json` | Entered in the app only |
|---|---|---|
| Projects, folders, requests | `project`, `folders[]`, `requests[]` | |
| Environments and variables | `environments[].variables` (secret, disabled) | Secret values |
| Login URLs (Session toolbar) | `environments[].loginUrls` | |
| Per-environment TLS, client certificates, proxy, HTTP/2 | `environments[].network` | Certificate passphrase |
| Auth: bearer, basic, inherit, none | `auth` on project, folder or request | Literal tokens and passwords |
| Token sources (OAuth client credentials, password grant, login request) | `tokenSources[]`, used with `auth: { "type": "token", "source": … }` | Client secrets (use `{{variables}}`) |
| Session test accounts (Creds) | `accounts[]` | Passwords, TOTP secrets |
| Cookie jar | `project.cookies` (no secrets: usually left to *Use session*) | |
| Scripts: pre-request and post-response, project-wide | `scripts` on request and project | |
| Assertions, extract rules, timeout, redirects | request `assertions`, `extract`, `timeoutSec`, `followRedirects` | |
| GraphQL, gRPC, WebSocket, Server-Sent Events | request `kind` + `graphql` / `grpc` / `ws` | |
| Snapshot tests | request `snapshot` (`status`, `json` or `body`, `ignore`) | |
| OpenAPI specs | `specs[]` | |
| Request ↔ spec operation link | request `operation` | |
| Feature groups (sidebar → Current) | `features[]` | |
| Server-log correlation (`X-Request-Id`, `traceparent`) | `project.correlation`, `project.traceUrl` | |
| Tasks (local services) | `tasks[]` | |
| Log sources: file, command, SSH, Kubernetes, Docker | `logSources[]` | |
| Log watch (flagged lines) | `project.logWatch` | |
| Spring Boot Actuator | `project.actuatorBase` | |
| Requests as files in the repo | `project.repoDir`, `project.repoSync` | |
| Notes | `notes[]` | |
| OpenTelemetry receiver | `settings.otel` | |
| Intercepting proxy | `settings.proxy` | Allowing other devices; the local CA |
| AI prompt contents (Settings → Privacy) | `settings.aiPrompt` | Turning AI assistance on |
| MCP server (Claude Code, Claude Desktop …) | — | Switching it on, its token, allowing changes |
| Theme, zoom, layout, editor wrap | `settings` | |
| Collection runner, load test, mock server, compare | Nothing to save: chosen when you run them | |

Live state isn't configuration and isn't in the file: History, open tabs, running tasks, proxy
traffic and cached tokens. A [full backup](#7-back-up-and-restore-everything) can carry History.

## 3. Reference

### Shape at a glance

```jsonc
{
  "version": 1,
  "project": { "name": "Orders", "auth": { "type": "bearer", "token": "{{token}}" } },
  "tokenSources": [ { "name": "Orders client", "url": "{{authUrl}}/oauth/token",
    "body": { "type": "form", "fields": { "grant_type": "client_credentials", "client_id": "{{clientId}}", "client_secret": "{{clientSecret}}" } } } ],
  "environments": [
    { "name": "local", "active": true, "variables": { "baseUrl": "http://localhost:8080", "token": { "secret": true } } },
    { "name": "staging", "variables": { "baseUrl": "https://staging.example.com", "clientSecret": { "secret": true } } }
  ],
  "folders": [
    { "name": "Orders", "requests": [
      { "name": "List orders", "url": "{{baseUrl}}/orders", "query": { "status": "OPEN" }, "operation": "GET /orders", "assertions": ["status === 200"] },
      { "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders",
        "json": { "sku": "ABC-1", "qty": 1 }, "extract": { "id": "orderId" }, "assertions": ["status === 201"] }
    ] }
  ],
  "features": [ { "name": "ORD-42 partial refunds", "branch": "feature/ORD-42", "requests": ["Orders/Create order"] } ],
  "specs": ["src/main/resources/openapi.yaml"],
  "tasks": [ { "name": "orders-service", "command": "./mvnw spring-boot:run", "readyLog": "Started .*Application" } ],
  "logSources": [ { "name": "access log", "type": "file", "path": "logs/access.log" } ],
  "notes": [ { "title": "How to run", "body": "Start **orders-service** first." } ],
  "accounts": [ { "label": "Admin", "user": "admin@example.com", "env": "local" } ],
  "settings": { "otel": { "autoStart": true } }
}
```

Top-level keys: `version` (always `1`), `project`, `tokenSources`, `environments`, `folders`,
`requests` (at the project root), `features`, `specs`, `tasks`, `logSources`, `notes`, `accounts`
and `settings`. All are optional.

### `project`

| Field | Meaning |
|---|---|
| `name` | Matches an existing project, or names the new one. |
| `auth` | Inherited by folders and requests whose auth is `"inherit"`. See [auth](#auth). |
| `correlation` | Add `X-Request-Id` and W3C `traceparent` to every send (default `true`). |
| `traceUrl` | Trace viewer link, with `{traceId}` and `{requestId}`, e.g. `http://localhost:16686/trace/{traceId}`. |
| `cookies` | Cookie jar `"a=1; b=2"`. Usually left out: *Use session* fills it. |
| `scripts` | `{ "pre": "…", "post": "…" }`, run before every request's own scripts. |
| `repoDir`, `repoSync` | Folder for request files (default `api-requests`), and whether to keep them in sync. |
| `actuatorBase` | Spring Boot Actuator base URL, e.g. `{{baseUrl}}/actuator` or `http://localhost:8081/manage`. |
| `logWatch` | `{ "levels": true, "patterns": ["Timeout", "/payment .* failed/i"], "notify": true }`. `levels` flags ERROR / FATAL; patterns are text or `/regex/flags`. |

### `environments[]`

| Field | Meaning |
|---|---|
| `name` | Required; the match key. |
| `active` | Make this the active environment. |
| `variables` | `name → value`. `{ "secret": true }` creates the variable empty, or keeps the value already typed in. `{ "value": "…", "enabled": false }` keeps it switched off. |
| `loginUrls` | `label → URL` for the Session toolbar's Login picker. |
| `network` | `caFile`, `insecure` (skip verification), `certFile` + `keyFile` or `pfxFile` (client certificate), `proxy` (`http://[user:pass@]host:port`), `http2`. Paths may be relative. |

### Auth

Auth goes on the project, a folder or a request:

- `"inherit"`: the default. Takes the folder's auth, then the project's.
- `"none"`.
- `{ "type": "bearer", "token": "{{token}}" }`.
- `{ "type": "basic", "user": "…", "pass": "{{password}}" }`.
- `{ "type": "token", "source": "<token source name>" }`: fetched before sending, cached until it
  expires, and fetched again after a 401.

### `tokenSources[]`

These are global to the app and matched by name.

| Field | Meaning |
|---|---|
| `name` | Required; what `auth.source` refers to. |
| `method`, `url`, `headers` | The token request. |
| `body` / `json` | As for requests. E.g. `{ "type": "form", "fields": { "grant_type": "client_credentials", "client_id": "{{clientId}}", "client_secret": "{{clientSecret}}" } }`. |
| `tokenPath` | Where the token is in the response (default `access_token`), e.g. `data.token`. |

Their `{{variables}}` come from the active environment of the project that uses them.

### Requests (`folders[].requests[]` and `requests[]`)

| Field | Meaning |
|---|---|
| `name` | Required; unique within its folder (it's the match key). |
| `kind` | `http` (default), `ws` (WebSocket), `sse` (Server-Sent Events), `graphql`, `grpc`. |
| `method` | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. |
| `url` | With `{{variables}}`. gRPC uses `grpc://host:port` (plaintext) or `grpcs://host:port` (TLS). |
| `query` | An object appended to the URL's query string. |
| `headers` | `name → value`, or `{ "value": "…", "enabled": false }` for a header that's kept but switched off. |
| `json` / `body` | `json`: any JSON value. `body`: a raw string, or `{ "type": "form", "fields": {…} }`. |
| `auth` | See [auth](#auth). |
| `assertions` | JS expressions over `status` and `body` (parsed JSON), e.g. `"body.items.length > 0"`. |
| `extract` | After a successful send, copy a value: `{ "data.token": "bearer", "items.0.id": "itemId", "header.x-trace": "traceId" }`. |
| `scripts` | `{ "pre": "…", "post": "…" }`. JavaScript; see *Scripts* in the README. |
| `timeoutSec`, `followRedirects` | Per-request options (defaults 60 and `true`). |
| `operation` | The spec operation to check against: `"GET /pets/{petId}"` (as written in the spec) or an `operationId`. It is linked once the project's specs are attached. |
| `snapshot` | The expected response for snapshot tests: `{ "status": 200, "json": {…}, "ignore": ["updatedAt", "$.items[*].id"] }`. Use `body` instead of `json` for text. `ignore` on its own updates a snapshot saved in the app. |
| `graphql` | `{ "query": "query { … }", "variables": { … } }` (with `kind: "graphql"`). |
| `ws` | `{ "message": … }`, the message to send after connecting (with `kind: "ws"`). |
| `grpc` | `{ "proto": "proto/orders.proto", "includeDirs": ["proto"], "service": "orders.v1.OrderService", "method": "GetOrder", "message": { … } }` (with `kind: "grpc"`). Use an array message for client streaming. |

`folders[]` entries take `name`, `auth` and `requests`.

### `features[]`

Fields: `name`, `branch`, `notes`, `done` and `requests`. `requests` lists `"Folder/Request"` or
`"Request"` names, which may be requests already in the project. Feature groups show in the
sidebar's **Current** view.

### `specs[]`

Paths relative to the code folder, or `http(s)` URLs such as a running app's `/v3/api-docs`. Each
is read and stored when the file is applied.

### `tasks[]`

| Field | Meaning |
|---|---|
| `name`, `command` | e.g. `./mvnw spring-boot:run`, `./gradlew bootRun`, `java -jar target/app.jar`. On Windows, `./mvnw` and `./gradlew` run `mvnw.cmd` / `gradlew.bat`, so one file works for everyone. |
| `cwd` | Working folder, relative to the code folder. |
| `javaHome`, `profile`, `jvmOpts` | JDK, Spring profile(s), JVM options. |
| `env` | Environment variables. |
| `readyLog` / `readyUrl` | Ready when a log line matches the regex, or the URL answers below 400. |
| `waitForReady` | Hold sends until the task is ready (default `true`). |

### `logSources[]`

| `type` | Fields |
|---|---|
| `file` (default) | `path`: a log file on this computer, relative to the code folder. `*` patterns and `.gz` files are searched. |
| `command` | `command`: any command whose output is the log. Live filter only; it can't be searched. |
| `ssh` | `ssh: { host, user, port, identityFile, paths }`. Uses your ssh keys, agent and `~/.ssh/config`, never a password. `paths` is comma separated, e.g. `/var/log/app/*.log`. |
| `kubernetes` | `kubernetes: { context, namespace, target, selector, container }`. `target` is e.g. `deployment/orders`; `selector` is e.g. `app=orders`. |
| `docker` | `docker: { container }`. |

### `notes[]`

Fields: `title` (the match key), `body` (Markdown), `tags` and `global`. A note belongs to this
project unless `"global": true`.

### `accounts[]`

Session toolbar test accounts: `label`, `user` and `env` (the environment name; empty means every
environment). They are matched by label and environment, and only new ones are added. Each person
enters the password and TOTP secret in **Session → Creds**.

### `settings`

These are app-wide and apply to every project.

| Field | Meaning |
|---|---|
| `theme`, `zoom`, `editorWrap` | `system` / `dark` / `light`; 0.7 to 1.6; wrap long lines in editors. |
| `layout` | `{ "split": "row" \| "column", "sideOpen": true, "session": true }`. |
| `otel` | `{ "autoStart": true, "httpPort": 4318, "grpcPort": 4317 }`: the local OpenTelemetry receiver. |
| `proxy` | `{ "port": 8899, "decryptHttps": true, "insecureUpstream": false, "toHistory": true, "breakpoints": ["POST /api/orders"] }`. |
| `aiPrompt` | Which sections Ask Claude and Investigate prompts include, and extra `instructions`. See Settings → Privacy. It doesn't turn AI assistance on. |

## 4. Recipes

- **Add an environment.** Append to `environments` with a `name` and `variables`. Add
  `"active": true` to switch to it.
- **Create requests for these endpoints.** Add one entry per endpoint under a folder, with URLs
  built from `{{baseUrl}}`. If the service has an OpenAPI spec, list it under `specs` and give each
  request an `operation`, so it's checked against the spec. Or let the user run *Create requests…*
  on the spec.
- **Group them under a feature.** Add `features: [{ "name": "<ticket> <title>", "requests":
  ["Folder/Request", …] }]`.
- **Log in once, then use the token.** Add a login request with `"auth": "none"` and
  `"extract": { "access_token": "token" }`, and give the project
  `"auth": { "type": "bearer", "token": "{{token}}" }`.
- **OAuth client credentials or a password grant.** Add a `tokenSources` entry whose secrets are
  `{{variables}}` marked `{ "secret": true }` in each environment. Then set
  `"auth": { "type": "token", "source": "<name>" }` on the project or a folder.
- **Run the service locally.** Add a `tasks` entry with the start command and a `readyLog` regex or
  `readyUrl`. Add `logSources` for its log files. Sends wait for the task to be ready, and each
  response's **Logs** tab shows the lines that carry its `X-Request-Id` / `traceparent`.
- **Follow logs where they live.** Add `ssh`, `kubernetes` or `docker` log sources, and
  `project.logWatch` patterns for the failures you care about.
- **Guard a response shape.** Add a `snapshot` with the expected `json` and `ignore` volatile fields.
  The runner then fails on any other difference.
- **Internal environments with company certificates.** Set `environments[].network.caFile` (and a
  client certificate for mTLS) with paths relative to the code folder.
- **Give an AI assistant the setup task.** Point it at this file and the schema, and ask it to write
  `api-client.json`. Then use **Project → Apply api-client.json**. It never has to touch `db.json`.

## 5. Export a project as `api-client.json`

**Project → Export as api-client.json…** writes the selected project's current setup in this
format. Commit it so others can apply it, or use it as a starting point. The export:

- **contains no secret values.** Secret variables become `{ "secret": true }`. Literal bearer tokens
  and basic-auth passwords are blanked, with a note asking you to use a `{{variable}}`. The cookie
  jar and certificate passphrases are left out;
- writes paths inside the code folder as relative paths;
- includes the token sources the project uses, its feature groups, notes, tasks and log sources;
- includes Session test accounts (label, user, environment), and optionally app settings.

Applying an export reproduces the project. Exporting again gives the same file.

## 6. Import just some requests

**Import → Requests from an api-client.json…** reads any `api-client.json` and lists its requests
as `Folder/Request`. Tick the ones you want and they're merged into the selected project by folder
and name. Token sources those requests use come with them. Nothing else is changed: no
environments, settings or code folder.

## 7. Back up and restore everything

**Project → Back up everything…** saves one JSON file with:

- all projects: environments, folders, requests, tasks, log sources, specs linked to requests;
- feature groups, notes, token sources and app settings;
- the attached spec documents;
- Session test accounts;
- if ticked, **the files requests use**: gRPC `.proto` files with every `.proto` they import, and
  CA / client certificates and keys. Each file can be up to 10 MB, 25 MB in all;
- if ticked, **History**;
- if ticked, **secrets**: tokens, passwords, secret variables, cookie jars and test-account
  passwords. Without secrets, those values are blank in the backup and the shape is otherwise
  complete. A backup with secrets is as sensitive as the app's own data, so keep it private.

**Import → Restore from backup…** shows what the file holds and lets you pick:

- **which projects** to restore. Restored projects get new ids, and every reference follows them:
  active environment, spec links, token sources, feature groups and notes.
- **when a project with the same name exists**: keep both (the restored one is named
  "… (restored)"), or replace it (its notes are kept);
- **what else**: token sources (same name: replaced), feature groups, notes, test accounts (same
  label: updated), files, History and app settings.

Restoring never overwrites a file on disk. A file whose original path doesn't exist on this
computer is written under the app's data folder in `restored-files/`, and the restored requests
point at that copy. Files that already exist at their original path are left alone and used as
they are.

Which to use:

- **Backup:** everything, for moving to a new computer or keeping a copy.
- **`api-client.json`:** a project's setup, without secrets, to commit and share.
- **Export… (collection):** one project's requests, for this app or Postman.

## 8. Sharing requests through git: request files

Separately from `api-client.json`, the app can store a project's requests as YAML files in the code
folder. The default folder is `api-requests/`; change it in **Project settings** or with
`project.repoDir`.

- Use **Project → Save requests to repo** / **Load requests from repo…**, or turn on *Keep request
  files in sync* (`project.repoSync`). With sync on, every change is written, and a change from
  outside (e.g. `git pull`) offers **Reload**.
- The layout is `api-requests/project.yaml` (folders and environments, without secret values) plus
  `api-requests/<folder>/<request>.request.yaml`, one file per request.
- Each file has an `id`. Keep it when editing by hand, because it is how the app matches the file
  to the request.
- Literal bearer tokens and passwords are left out of the files. `{{variables}}` are kept.

`api-client.json` is a hand-written *setup* description. The request files are the app's own
output, kept in step with the app. Use either or both.

## 9. The app's data files (don't edit by hand)

The app keeps its data in its user-data folder:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/api-workbench/` |
| Windows | `%APPDATA%\api-workbench\` |
| Linux | `~/.config/api-workbench/` |

| File | Contents |
|---|---|
| `db.json` | Projects, folders, requests, environments, features, notes, token sources and settings, including secrets (auth tokens, passwords, cookies, secret variables, certificate passphrases), stored as `{ "$secret": … }` encrypted with the operating system's protection (Windows DPAPI, macOS Keychain, Linux keyring; Settings → Privacy). Readable by your user account only. |
| `history.json` | The last 200 sends. Credentials are removed from headers, URLs and bodies (passwords, tokens, API keys, JWTs, and values the app holds as secrets), and bodies over 100 KB are truncated. |
| `timings.json` | Each request's last 300 response times (time, status, environment id), for its response-time trend. |
| `accounts.json` | Saved logins for the Session toolbar; passwords and TOTP secrets encrypted like `db.json`'s. Readable by your user account only. |
| `specs/<id>.json` | Attached OpenAPI documents, bundled. `db.json` refers to them by id. |
| `proxy-ca/` | The intercepting proxy's local CA and its key. Readable by your user account only. |
| `restored-files/` | Files a backup restore copied here because their original path was missing. |
| `mcp.json` | While the MCP server is on (Settings → MCP server): its address and token, for the stdio bridge `bin/api-workbench-mcp.js`. Readable by your user account only; removed when the server stops. |

To move to another computer, use [Back up everything](#7-back-up-and-restore-everything) rather
than copying these files. If you do have to edit them:

- **Close the app first.** It rewrites `db.json` on every change.
- Don't commit or share these files. Their secrets are encrypted for your user account on this computer, so
  they're useless elsewhere anyway (unless encryption is off, when they're plain text). Encrypted values
  (`{ "$secret": … }`) can't be edited by hand: change secrets in the app.
- Ids link entries together:
  - `features[].requestIds`;
  - `settings.openTabs`;
  - `request.spec.specId`;
  - `auth.sourceId`;
  - `project.activeEnv`.

  Keep ids unique, and update the references when you change them.
- Don't create or edit `specs/` files. Attach specs in the app (Specs page) or through
  `api-client.json`.

The full shape of `db.json` is documented at the top of `renderer/app/store.js`. Prefer
`api-client.json`, which the app validates and merges safely.

## 10. Checking your work

- The JSON Schema catches typos. Unknown fields aren't allowed, so `"assertion"` instead of
  `"assertions"` is rejected. The app checks the file against the schema before applying, and lists
  any problems.
- After applying, the app reports what changed and any warnings. For example: a feature that
  refers to a missing request, an unknown token source, or an `operation` no attached spec has.
- **Project → API specs → Check all requests** validates every request against the attached specs
  without sending anything.
- **Project → Run collection** sends them all, checks assertions and snapshots, and exports JUnit
  XML for CI. The command-line runner does the same without the app (next section).

## 11. Running the checks in CI

The same `api-client.json` drives a headless run, with the checks the collection runner makes
(assertions, script tests, snapshots, spec errors, HTTP status):

```bash
node bin/api-workbench.js run --config api-client.json --env staging --junit api-results.xml
```

- The file is applied in memory, specs included; the app's own data isn't needed or changed.
- Secret variables (`{ "secret": true }`) are blank in the file, so give them values from CI
  secrets as `AW_VAR_<name>` environment variables (or `--var name=value`). A secret still blank
  when the run starts gets a warning. Secret values are printed and written as `[REDACTED]`.
- Relative paths (specs, certificates, `.proto` files) resolve against the file's folder, as in the
  app.
- `--folder <name>` or `--feature <name>` runs part of it; `--data-file rows.csv` runs once per row.
- Exit code: 0 all passed, 1 something failed, 2 bad arguments or setup.

A GitHub Actions job:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci --omit=dev            # in your copy of API Workbench; Electron isn't needed
  working-directory: .api-workbench
- run: node .api-workbench/bin/api-workbench.js run --config api-client.json --env staging --junit api-results.xml
  env:
    AW_VAR_clientSecret: ${{ secrets.STAGING_CLIENT_SECRET }}
```

All options, the output, and a complete workflow: [README → Running in CI](../README.md#running-in-ci).
