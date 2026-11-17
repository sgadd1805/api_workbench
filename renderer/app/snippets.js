// A request as code for another program: cURL, JavaScript fetch / axios, Python requests, Java (Spring
// RestClient, java.net.http) and C# HttpClient. wire: what http.js buildRequest() sends —
// { method, url, headers: { name: value }, body, redirect?, timeoutMs? }.
import { toCurl } from './curl.js';

export const SNIPPETS = [
  ['curl', 'cURL'], ['fetch', 'JavaScript (fetch)'], ['axios', 'JavaScript (axios)'], ['python', 'Python (requests)'],
  ['java-restclient', 'Java (Spring RestClient)'], ['java-httpclient', 'Java (java.net.http)'], ['csharp', 'C# (HttpClient)'],
];

const parsed = (body) => { try { return body ? JSON.parse(body) : undefined; } catch { return undefined; } };
const indent = (s, n) => s.split('\n').map((l, i) => (i ? ' '.repeat(n) + l : l)).join('\n');
const contentTypeOf = (headers) => Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
const js = (v) => JSON.stringify(v);
// File bodies (http.js buildRequest): multipart parts or one file. Their Content-Type comes from the library.
const parts = (w) => (w.bodyParts?.length ? w.bodyParts : null);
const withoutMultipartType = (w) => (parts(w) ? Object.fromEntries(Object.entries(w.headers).filter(([k, v]) => !(k.toLowerCase() === 'content-type' && /^multipart\//i.test(v)))) : w.headers);
const hasBody = (w) => !!(w.body || parts(w) || w.bodyFile);

// A JSON value as a Python literal (True / False / None).
function py(v, depth = 0) {
  const pad = '    '.repeat(depth + 1), end = '    '.repeat(depth);
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + py(x, depth + 1)).join(',\n')},\n${end}]` : '[]';
  const e = Object.entries(v);
  return e.length ? `{\n${e.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${py(x, depth + 1)}`).join(',\n')},\n${end}}` : '{}';
}
// Java: a "string" literal, or a text block for a multi-line body.
const javaStr = (s) => (s.includes('\n') ? `"""\n${s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}"""` : JSON.stringify(s));
// C#: a verbatim @"…" string (quotes doubled).
const csStr = (s) => `@"${String(s).replace(/"/g, '""')}"`;

const GEN = {
  curl: (w) => toCurl(w),

  fetch(w) {
    const opts = [`method: ${js(w.method)}`], pre = [];
    const headers = withoutMultipartType(w);
    if (Object.keys(headers).length) opts.push(`headers: ${indent(JSON.stringify(headers, null, 2), 2)}`);
    if (parts(w)) {
      pre.push("import fs from 'node:fs';", '', 'const form = new FormData();', ...parts(w).map((p) => (p.file != null
        ? `form.append(${js(p.name)}, new Blob([fs.readFileSync(${js(p.file)})], { type: ${js(p.contentType || 'application/octet-stream')} }), ${js(p.filename || p.file.split(/[\\/]/).pop())});`
        : `form.append(${js(p.name)}, ${js(p.value ?? '')});`)), '');
      opts.push('body: form');
    } else if (w.bodyFile) { pre.push("import fs from 'node:fs';", ''); opts.push(`body: fs.readFileSync(${js(w.bodyFile)})`); }
    else if (w.body) opts.push(`body: ${parsed(w.body) !== undefined ? `JSON.stringify(${indent(JSON.stringify(parsed(w.body), null, 2), 2)})` : js(w.body)}`);
    if (w.redirect === 'manual') opts.push("redirect: 'manual'");
    if (w.timeoutMs) opts.push(`signal: AbortSignal.timeout(${w.timeoutMs})`);
    return `${pre.join('\n')}${pre.length ? '\n' : ''}const res = await fetch(${js(w.url)}, {\n  ${opts.join(',\n  ')},\n});\nconsole.log(res.status, await res.text());`;
  },

  axios(w) {
    const opts = [`method: ${js(w.method.toLowerCase())}`, `url: ${js(w.url)}`], pre = [];
    const headers = withoutMultipartType(w);
    if (Object.keys(headers).length) opts.push(`headers: ${indent(JSON.stringify(headers, null, 2), 2)}`);
    if (parts(w)) {
      pre.push("import fs from 'node:fs';", '', 'const form = new FormData();', ...parts(w).map((p) => (p.file != null
        ? `form.append(${js(p.name)}, new Blob([fs.readFileSync(${js(p.file)})], { type: ${js(p.contentType || 'application/octet-stream')} }), ${js(p.filename || p.file.split(/[\\/]/).pop())});`
        : `form.append(${js(p.name)}, ${js(p.value ?? '')});`)));
      opts.push('data: form');
    } else if (w.bodyFile) { pre.push("import fs from 'node:fs';"); opts.push(`data: fs.createReadStream(${js(w.bodyFile)})`); }
    else if (w.body) opts.push(`data: ${parsed(w.body) !== undefined ? indent(JSON.stringify(parsed(w.body), null, 2), 2) : js(w.body)}`);
    if (w.redirect === 'manual') opts.push('maxRedirects: 0');
    if (w.timeoutMs) opts.push(`timeout: ${w.timeoutMs}`);
    opts.push('validateStatus: () => true');
    return `import axios from 'axios';\n${pre.length ? pre.join('\n') + '\n' : ''}\nconst res = await axios({\n  ${opts.join(',\n  ')},\n});\nconsole.log(res.status, res.data);`;
  },

  python(w) {
    const json = parsed(w.body), isJsonBody = json !== undefined && /json/i.test(contentTypeOf(w.headers) || 'json');
    const headers = Object.fromEntries(Object.entries(withoutMultipartType(w)).filter(([k]) => !(isJsonBody && k.toLowerCase() === 'content-type')));
    const args = [js(w.method), 'url'];
    if (Object.keys(headers).length) args.push('headers=headers');
    const fileLines = [];
    if (parts(w)) {
      const text = parts(w).filter((p) => p.file == null), files = parts(w).filter((p) => p.file != null);
      if (text.length) { fileLines.push(`data = ${py(Object.fromEntries(text.map((p) => [p.name, p.value ?? ''])))}`); args.push('data=data'); }
      if (files.length) {
        fileLines.push(`files = [\n${files.map((p) => `    (${js(p.name)}, (${js(p.filename || p.file.split(/[\\/]/).pop())}, open(${js(p.file)}, "rb"), ${js(p.contentType || 'application/octet-stream')})),`).join('\n')}\n]`);
        args.push('files=files');
      }
    } else if (w.bodyFile) { fileLines.push(`payload = open(${js(w.bodyFile)}, "rb")`); args.push('data=payload'); }
    else if (w.body) args.push(isJsonBody ? 'json=payload' : 'data=payload');
    if (w.redirect === 'manual') args.push('allow_redirects=False');
    args.push(`timeout=${w.timeoutMs ? w.timeoutMs / 1000 : 30}`);
    return ['import requests', '', `url = ${js(w.url)}`,
      ...(Object.keys(headers).length ? [`headers = ${py(headers)}`] : []),
      ...fileLines,
      ...(w.body && !fileLines.length ? [`payload = ${isJsonBody ? py(json) : js(w.body)}`] : []),
      '', `response = requests.request(${args.join(', ')})`, 'print(response.status_code, response.text)'].join('\n');
  },

  'java-restclient'(w) {
    const lines = ['RestClient client = RestClient.create();', '', 'ResponseEntity<String> response = client', `    .method(HttpMethod.valueOf(${js(w.method)}))`, `    .uri(${js(w.url)})`];
    for (const [k, v] of Object.entries(withoutMultipartType(w))) lines.push(`    .header(${js(k)}, ${js(v)})`);
    if (parts(w)) {
      lines.unshift('MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();', ...parts(w).map((p) => `form.add(${js(p.name)}, ${p.file != null ? `new FileSystemResource(${js(p.file)})` : js(p.value ?? '')});`), '');
      lines.push('    .contentType(MediaType.MULTIPART_FORM_DATA)', '    .body(form)');
    } else if (w.bodyFile) lines.push(`    .body(new FileSystemResource(${js(w.bodyFile)}))`);
    else if (w.body) lines.push(`    .body(${indent(javaStr(w.body), 4)})`);
    lines.push('    .retrieve()', '    .onStatus(status -> true, (req, res) -> {}) // keep 4xx / 5xx responses instead of throwing', '    .toEntity(String.class);', 'System.out.println(response.getStatusCode() + " " + response.getBody());');
    return lines.join('\n');
  },

  'java-httpclient'(w) {
    const lines = ['HttpClient client = HttpClient.newBuilder()', `    .followRedirects(HttpClient.Redirect.${w.redirect === 'manual' ? 'NEVER' : 'NORMAL'})`, '    .build();', '',
      'HttpRequest request = HttpRequest.newBuilder()', `    .uri(URI.create(${js(w.url)}))`];
    for (const [k, v] of Object.entries(w.headers)) if (!/^(host|content-length|connection)$/i.test(k)) lines.push(`    .header(${js(k)}, ${js(v)})`);
    if (w.timeoutMs) lines.push(`    .timeout(Duration.ofMillis(${w.timeoutMs}))`);
    const publisher = w.bodyFile ? `HttpRequest.BodyPublishers.ofFile(Path.of(${js(w.bodyFile)}))`
      : parts(w) ? 'HttpRequest.BodyPublishers.noBody() /* multipart: java.net.http has no form-data builder; assemble the parts with a library such as Apache HttpClient MultipartEntityBuilder */'
      : w.body ? `HttpRequest.BodyPublishers.ofString(${indent(javaStr(w.body), 4)})` : 'HttpRequest.BodyPublishers.noBody()';
    lines.push(`    .method(${js(w.method)}, ${publisher})`, '    .build();', '',
      'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());', 'System.out.println(response.statusCode() + " " + response.body());');
    return lines.join('\n');
  },

  csharp(w) {
    const type = contentTypeOf(w.headers);
    const lines = [`using var client = new HttpClient(${w.redirect === 'manual' ? 'new HttpClientHandler { AllowAutoRedirect = false }' : ''});`];
    if (w.timeoutMs) lines.push(`client.Timeout = TimeSpan.FromMilliseconds(${w.timeoutMs});`);
    const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(w.method) ? `HttpMethod.${w.method[0] + w.method.slice(1).toLowerCase()}` : `new HttpMethod(${js(w.method)})`;
    lines.push(`var request = new HttpRequestMessage(${method}, ${js(w.url)});`);
    // Content-Type belongs to the content in .NET, not the request headers.
    for (const [k, v] of Object.entries(w.headers)) if (k.toLowerCase() !== 'content-type') lines.push(`request.Headers.TryAddWithoutValidation(${js(k)}, ${js(v)});`);
    if (parts(w)) {
      lines.push('var form = new MultipartFormDataContent();', ...parts(w).map((p) => (p.file != null
        ? `form.Add(new StreamContent(File.OpenRead(${csStr(p.file)})) { Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(${js(p.contentType || 'application/octet-stream')}) } }, ${js(p.name)}, ${js(p.filename || p.file.split(/[\\/]/).pop())});`
        : `form.Add(new StringContent(${csStr(p.value ?? '')}), ${js(p.name)});`)), 'request.Content = form;');
    } else if (w.bodyFile) {
      lines.push(`request.Content = new StreamContent(File.OpenRead(${csStr(w.bodyFile)}));`, `request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(${js((type || 'application/octet-stream').split(';')[0].trim())});`);
    } else if (w.body) lines.push(`request.Content = new StringContent(${csStr(w.body)}, System.Text.Encoding.UTF8, ${js((type || 'text/plain').split(';')[0].trim())});`);
    lines.push('', 'var response = await client.SendAsync(request);', 'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");');
    return lines.join('\n');
  },
};

// → the request as `id`'s code
export const snippet = (id, wire) => (GEN[id] || GEN.curl)({ ...wire, headers: wire.headers || {} });
