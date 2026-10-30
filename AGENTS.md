# Notes for AI assistants

## Setting the app up for a user's project

Read [docs/CONFIGURING.md](docs/CONFIGURING.md). Write an `api-client.json` in that project's code
folder (schema: [docs/api-client.schema.json](docs/api-client.schema.json)) and let the app apply
it. Do not edit the app's data files (`db.json` etc.).

## Working on this codebase

- Electron app with no build step:
  - `main.js` and `main/*.js` are the main process (CommonJS). Each module registers its own IPC
    handlers.
  - `preload.js` exposes `window.electronAPI`.
  - `renderer/` is ES modules loaded from `file://`.
- Data shapes are documented at the top of `renderer/app/store.js`. The UI follows these patterns:
  - views build HTML strings, with every value passed through `esc()`;
  - clicks use `data-action`, handled in `renderer/app/actions/`;
  - edits are handled by element id in `renderer/app/events.js`.
- Tests: `npm test` (node:test, `test/*.test.mjs`). Renderer modules are imported directly, with a
  stubbed `window.electronAPI`.
- Run the app with `npm start`.
- The command-line runner (`bin/api-workbench.js`, `cli/`) imports renderer modules in plain Node, with
  `cli/node-api.mjs` standing in for `window.electronAPI`. Modules it uses (store, http, runner,
  verify, config, tokens, openapi) must not touch the DOM, and the `main/` modules it requires
  (http, network, protocols, specs, secrets) must not require Electron at load time.
