// The Tools page runs either in its own window (with the preload's electronAPI) or embedded in the
// main window's side panel as an iframe, where it borrows the parent page's electronAPI.
export const api = window.electronAPI || window.parent?.electronAPI;
export const embedded = window.parent !== window;
