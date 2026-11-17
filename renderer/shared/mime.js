// Content types for files sent as request bodies (multipart file parts, binary bodies), by extension.
// Anything not listed is application/octet-stream.
const TYPES = {
  json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  md: 'text/markdown', yaml: 'application/yaml', yml: 'application/yaml', js: 'text/javascript', css: 'text/css',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  proto: 'text/plain', bin: 'application/octet-stream',
};

export const fileName = (path) => String(path || '').split(/[\\/]/).pop();

export function mimeFor(path) {
  const ext = /\.([^.\\/]+)$/.exec(String(path || ''))?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) || 'application/octet-stream';
}
