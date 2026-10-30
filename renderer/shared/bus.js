// Page-level events between the toolbar and the app (separate modules that don't import each other).
//   'use-login-session'   toolbar → app: copy the login window's session into the current project
//   'import-capture'      toolbar → app: turn captured traffic into requests
//   'open-capture'        toolbar → app: open one captured call (its index) as a request, with its response
//   'capture-flow'        toolbar → app: save the chosen calls ([index]) as a flow with linked values
//   'import-har'          app → toolbar: add a HAR file's calls to the Network list (Import menu, ⌘K)
//   'open-accounts'       toolbar → app: show the accounts page
//   'accounts-changed'    app → toolbar: re-render the Creds buttons
//   'session-context'     app → toolbar: { envName, loginUrls: [{ label, url }] } for the active environment
export const emit = (name, detail) => window.dispatchEvent(new CustomEvent('app:' + name, { detail }));
export const on = (name, fn) => window.addEventListener('app:' + name, (e) => fn(e.detail));
