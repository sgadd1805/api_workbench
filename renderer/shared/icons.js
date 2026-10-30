// The app's one icon set: small stroke icons drawn in currentColor, so they follow the text colour
// and theme. icon(name, { label }) → inline SVG markup; with a label it's announced to screen readers,
// otherwise it's decorative (aria-hidden) and the surrounding button should carry a title / label.
const P = {
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14C6.2 12.3 5.3 10.3 5.3 8S6.2 3.7 8 2z"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11z"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  back: '<path d="M13 8H3M7 4 3 8l4 4"/>',
  'chevron-right': '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  'chevron-down': '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  warning: '<path d="M8 2 1.5 13.5h13z"/><path d="M8 6.5v3.5M8 12v.01"/>',
};

export function icon(name, { label = '', size = 14 } = {}) {
  const body = P[name];
  if (!body) return '';
  const a11y = label ? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
  return `<svg class="icon icon-${name}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${a11y} focusable="false">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(P);
