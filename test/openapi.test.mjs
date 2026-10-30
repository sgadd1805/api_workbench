// OpenAPI/Swagger: normalising, URL matching, schema + request/response validation, generation, file bundling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSpec, matchOperation, deref, urlPath } from '../renderer/app/openapi/spec.js';
import { validateSchema } from '../renderer/app/openapi/schema.js';
import { validateRequest, validateResponse, pickMedia, responseFor } from '../renderer/app/openapi/validate.js';
import { exampleFor, requestFieldsFor, variablesFor, bodyFor } from '../renderer/app/openapi/generate.js';

const require = createRequire(import.meta.url);
const { parseText, bundle, readSpec, findSpecs } = require('../main/specs.js');

const OAS3 = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.2' },
  servers: [{ url: 'https://api.example.com/{ver}', variables: { ver: { default: 'v1' } } }],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } } },
    schemas: {
      Pet: {
        type: 'object', required: ['id', 'name', 'kind'], additionalProperties: false,
        properties: {
          id: { type: 'integer', format: 'int64', readOnly: true },
          name: { type: 'string', minLength: 1, example: 'Rex' },
          kind: { type: 'string', enum: ['dog', 'cat'] },
          born: { type: 'string', format: 'date' },
          tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          owner: { $ref: '#/components/schemas/Owner' },
          secret: { type: 'string', writeOnly: true },
          nick: { type: 'string', nullable: true },
        },
      },
      Owner: { type: 'object', properties: { email: { type: 'string', format: 'email' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
      Shape: { oneOf: [{ $ref: '#/components/schemas/Circle' }, { $ref: '#/components/schemas/Square' }], discriminator: { propertyName: 'kind' } },
      Circle: { type: 'object', required: ['kind', 'r'], properties: { kind: { const: 'Circle' }, r: { type: 'number', exclusiveMinimum: true, minimum: 0 } } },
      Square: { type: 'object', required: ['kind', 'side'], properties: { kind: { const: 'Square' }, side: { type: 'number' } } },
    },
  },
  paths: {
    '/pets': {
      get: { summary: 'List pets', tags: ['pets'], parameters: [{ $ref: '#/components/parameters/Limit' }, { name: 'kind', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['dog', 'cat'] } }, explode: false }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } },
      post: { summary: 'Add pet', tags: ['pets'], parameters: [{ name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, '4XX': { description: 'bad' } } },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { operationId: 'getPet', security: [{ key: [] }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, default: { description: 'error' } } },
    },
    '/pets/mine': { get: { summary: 'Mine', security: [], responses: { 200: { description: 'ok' } } } },
    '/shapes': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Shape' } } } }, responses: { 204: { description: 'ok' } } } },
  },
};

const SWAGGER2 = {
  swagger: '2.0', info: { title: 'Legacy', version: '0.9' }, host: 'legacy.test', basePath: '/api', schemes: ['http'],
  consumes: ['application/json'], produces: ['application/json'],
  definitions: { Item: { type: 'object', required: ['sku'], properties: { sku: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' }, qty: { type: 'integer', minimum: 1 } } } },
  paths: {
    '/items': {
      post: { parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Item' } }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Item' } } } },
      get: { parameters: [{ in: 'query', name: 'ids', type: 'array', items: { type: 'integer' }, collectionFormat: 'csv', required: true }], responses: { 200: { description: 'ok' } } },
    },
    '/login': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ in: 'formData', name: 'user', type: 'string', required: true }, { in: 'formData', name: 'age', type: 'integer' }], responses: { 200: { description: 'ok' } } } },
  },
};

const pets = analyzeSpec(OAS3), legacy = analyzeSpec(SWAGGER2);
const wire = (method, url, { headers = {}, body = '' } = {}) => ({ method, url, headers: { Authorization: 'Bearer t', ...headers }, body });
const run = (a, method, url, opts) => { const m = matchOperation(a, method, url); return { m, issues: m ? validateRequest(a, m.op, wire(method, url, opts), m.pathParams) : null }; };
const msgs = (issues) => issues.map((i) => `${i.where} ${i.message}`);

test('analyzeSpec: OpenAPI 3 servers, params, operations', () => {
  assert.deepEqual(pets.serverUrls, ['https://api.example.com/v1']);
  assert.deepEqual(pets.basePaths, ['/v1', '']);
  assert.equal(pets.operations.length, 5);
  const get = pets.byKey.get('GET /pets/{petId}');
  assert.deepEqual(get.parameters.map((p) => [p.name, p.in, p.required]), [['petId', 'path', true]]);
  assert.equal(pets.byKey.get('GET /pets').parameters[0].name, 'limit'); // $ref parameter resolved
});

test('analyzeSpec: Swagger 2 body/formData → requestBody, host/basePath → server', () => {
  assert.deepEqual(legacy.serverUrls, ['http://legacy.test/api']);
  const post = legacy.byKey.get('POST /items');
  assert.deepEqual(Object.keys(post.requestBody.content), ['application/json']);
  assert.equal(post.requestBody.required, true);
  assert.ok(post.responses['200'].content['application/json'].schema);
  const login = legacy.byKey.get('POST /login');
  assert.deepEqual(Object.keys(login.requestBody.content), ['application/x-www-form-urlencoded']);
  assert.deepEqual(deref(legacy.doc, login.requestBody.content['application/x-www-form-urlencoded'].schema).required, ['user']);
  assert.deepEqual(legacy.byKey.get('GET /items').parameters[0].schema, { type: 'array', items: { type: 'integer' } });
});

test('matchOperation: base paths, literal beats template, relative URLs', () => {
  assert.equal(matchOperation(pets, 'GET', 'https://api.example.com/v1/pets/mine').op.key, 'GET /pets/mine');
  assert.deepEqual(matchOperation(pets, 'GET', 'https://other.host/v1/pets/42?x=1').pathParams, { petId: '42' });
  assert.equal(matchOperation(pets, 'GET', '/pets/7').op.key, 'GET /pets/{petId}');
  assert.equal(matchOperation(pets, 'DELETE', '/v1/pets/7'), null);
  assert.equal(matchOperation(legacy, 'POST', 'http://legacy.test/api/items/').op.key, 'POST /items');
  assert.equal(urlPath('{{baseUrl}}/pets?x'), '{{baseUrl}}/pets');
});

test('validateSchema: types, formats, enums, required, additionalProperties, readOnly/writeOnly, nullable, refs', () => {
  const pet = { $ref: '#/components/schemas/Pet' };
  const v = (value, mode = 'request') => validateSchema(pet, value, { root: OAS3, mode, path: 'body' }).map((e) => `${e.path} ${e.message}`);
  assert.deepEqual(v({ name: 'Rex', kind: 'dog' }), []); // id is readOnly → not required in requests
  assert.deepEqual(v({ id: 1, name: 'Rex', kind: 'dog' }), ['body.id is read-only and should not be sent']);
  assert.deepEqual(v({ id: 1, name: 'Rex', kind: 'dog', secret: 's' }, 'response'), ['body.secret is write-only and should not be returned']);
  assert.deepEqual(v({ name: 'Rex', kind: 'dog' }, 'response'), ['body.id is required']);
  assert.deepEqual(v({ name: '', kind: 'cow', born: '2024-02-30', tags: ['a', 'a'], extra: 1, nick: null, owner: { email: 'nope', pets: [{ name: 'x', kind: 'cat', born: 5 }] } }), [
    'body.name must be at least 1 characters (got 0)',
    'body.kind must be one of "dog", "cat"',
    'body.born is not a valid date',
    'body.tags must not contain duplicate items',
    'body.extra is not a known property', // errors follow the value's key order
    'body.owner.email is not a valid email',
    'body.owner.pets[0].born expected string, got 5',
  ]);
  assert.deepEqual(validateSchema({ type: 'integer', format: 'int32' }, 2 ** 31, { root: {} }).map((e) => e.message), ['is out of range for int32']);
  assert.deepEqual(validateSchema({ type: ['string', 'null'] }, null, { root: {} }), []);
  assert.deepEqual(validateSchema({ type: 'string' }, null, { root: {} }).map((e) => e.message), ['must not be null (expected string)']);
  assert.deepEqual(validateSchema({ type: 'number', exclusiveMinimum: 5 }, 5, { root: {} }).map((e) => e.message), ['must be > 5']);
});

test('validateSchema: oneOf with discriminator, anyOf hints, recursive refs terminate', () => {
  const shape = (value) => validateSchema({ $ref: '#/components/schemas/Shape' }, value, { root: OAS3 }).map((e) => `${e.path} ${e.message}`);
  assert.deepEqual(shape({ kind: 'Circle', r: 2 }), []);
  assert.deepEqual(shape({ kind: 'Circle', r: 0 }), ['r must be > 0']); // only the discriminated branch is checked
  assert.match(validateSchema({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true, { root: {} })[0].message, /does not match any of the 2 allowed schemas \(closest: expected string/);
  const deep = { owner: { pets: [{ name: 'a', kind: 'dog', owner: { pets: [{ name: 'b', kind: 'dog' }] } }] } };
  assert.deepEqual(validateSchema({ $ref: '#/components/schemas/Owner' }, deep.owner, { root: OAS3 }), []);
});

test('validateRequest: params, body, content type, security, unknown query', () => {
  assert.deepEqual(msgs(run(pets, 'GET', '/v1/pets?limit=10&kind=dog,cat').issues), []);
  assert.deepEqual(msgs(run(pets, 'GET', '/v1/pets?limit=0&kind=dog,cow&foo=1').issues), [
    'query.limit must be ≥ 1', 'query.kind[1] must be one of "dog", "cat"', 'query.foo is not a documented parameter']);
  assert.deepEqual(msgs(run(pets, 'GET', '/v1/pets/abc').issues), ['path.petId expected integer, got "abc"', 'auth no credentials for key']);
  assert.deepEqual(msgs(run(pets, 'GET', '/v1/pets/5', { headers: { 'x-key': 'k' } }).issues), []);
  assert.deepEqual(msgs(run(pets, 'POST', '/v1/pets').issues), ['header.X-Request-Id is required', 'body is required']);
  const okBody = { headers: { 'X-Request-Id': '00000000-0000-4000-8000-000000000000', 'Content-Type': 'application/json; charset=utf-8' }, body: '{"name":"Rex","kind":"dog"}' };
  assert.deepEqual(msgs(run(pets, 'POST', '/v1/pets', okBody).issues), []);
  assert.deepEqual(msgs(run(pets, 'POST', '/v1/pets', { ...okBody, body: '{"name":' }).issues).map((m) => m.split(' (')[0]), ['body is not valid JSON']);
  assert.deepEqual(msgs(run(pets, 'POST', '/v1/pets', { ...okBody, headers: { ...okBody.headers, 'Content-Type': 'text/plain' } }).issues), ['header.Content-Type "text/plain" is not accepted; expected application/json']);
  const noAuth = validateRequest(pets, pets.byKey.get('GET /pets'), { method: 'GET', url: '/v1/pets', headers: {}, body: '' }, {});
  assert.deepEqual(msgs(noAuth), ['auth no credentials for bearer']);
  assert.deepEqual(msgs(validateRequest(pets, pets.byKey.get('GET /pets/mine'), { method: 'GET', url: '/v1/pets/mine', headers: {}, body: '' }, {})), []); // security: [] = public
});

test('validateRequest: Swagger 2 csv arrays and form bodies; unresolved path variables', () => {
  assert.deepEqual(msgs(run(legacy, 'GET', '/api/items?ids=1,2,x').issues), ['query.ids[2] expected integer, got "x"']);
  assert.deepEqual(msgs(run(legacy, 'GET', '/api/items').issues), ['query.ids is required']);
  const form = (body) => msgs(run(legacy, 'POST', '/api/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).issues);
  assert.deepEqual(form('user=me&age=3'), []);
  assert.deepEqual(form('age=x'), ['body.user is required', 'body.age expected integer, got "x"']);
  assert.deepEqual(msgs(run(legacy, 'POST', '/api/items', { headers: { 'Content-Type': 'application/json' }, body: '{"sku":"abc"}' }).issues), ['body.sku must match pattern ^[A-Z]{3}-\\d+$']);
  assert.deepEqual(msgs(run(pets, 'GET', '/v1/pets/{{petId}}', { headers: { 'X-Key': 'k' } }).issues), ['path.petId is the unresolved variable {{petId}}']);
});

test('validateResponse: documented status, ranges/default, content type, schema', () => {
  const op = pets.byKey.get('POST /pets');
  const res = (status, body, ct = 'application/json') => msgs(validateResponse(pets, op, { status, headers: { 'content-type': ct }, body }));
  assert.deepEqual(res(201, '{"id":1,"name":"Rex","kind":"dog"}'), []);
  assert.deepEqual(res(201, '{"name":"Rex","kind":"dog","secret":"x"}'), ['body.id is required', 'body.secret is write-only and should not be returned']);
  assert.deepEqual(res(404, 'not json at all', 'text/plain'), []); // 4XX documented without content
  assert.deepEqual(res(500, ''), ['status 500 is not documented (documented: 201, 4XX)']);
  assert.deepEqual(res(201, '<pet/>', 'application/xml'), ['header.Content-Type "application/xml" is not documented for 201; expected application/json']);
  assert.equal(responseFor(pets.byKey.get('GET /pets/{petId}'), 503).description, 'error');
  assert.equal(pickMedia({ 'application/*': { schema: 1 } }, 'application/problem+json').mediaType, 'application/*');
});

test('generation: examples skip readOnly, requests use variables, form bodies', () => {
  assert.deepEqual(exampleFor({ $ref: '#/components/schemas/Pet' }, OAS3), { name: 'Rex', kind: 'dog', born: new Date().toISOString().slice(0, 10), tags: ['string'], owner: { email: 'user@example.com', pets: [] }, secret: 'string', nick: 'string' });
  const post = requestFieldsFor(pets, pets.byKey.get('POST /pets'), 's1');
  assert.equal(post.url, '{{baseUrl}}/pets');
  assert.deepEqual(post.headers, [{ k: 'X-Request-Id', v: '00000000-0000-4000-8000-000000000000', on: true }]);
  assert.equal(post.body.type, 'json');
  assert.deepEqual(post.spec, { specId: 's1', opKey: 'POST /pets' });
  const get = requestFieldsFor(pets, pets.byKey.get('GET /pets/{petId}'), 's1');
  assert.equal(get.url, '{{baseUrl}}/pets/{{petId}}');
  assert.equal(get.name, 'getPet');
  assert.equal(requestFieldsFor(legacy, legacy.byKey.get('GET /items'), 's2').url, '{{baseUrl}}/items?ids=0');
  assert.deepEqual(bodyFor(legacy.byKey.get('POST /login'), SWAGGER2).body.form, [{ k: 'user', v: 'string', on: true }, { k: 'age', v: '0', on: true }]);
  assert.deepEqual(variablesFor(pets, pets.operations), [{ k: 'baseUrl', v: 'https://api.example.com/v1' }, { k: 'petId', v: '0' }]);
});

test('generated requests validate cleanly against their own spec', () => {
  for (const op of pets.operations) {
    const f = requestFieldsFor(pets, op, 's');
    const url = f.url.replace('{{baseUrl}}', pets.serverUrls[0]).replace(/\{\{(\w+)\}\}/g, '1');
    const headers = Object.fromEntries(f.headers.filter((h) => h.on).map((h) => [h.k, h.v]));
    if (f.body.type === 'json') headers['Content-Type'] = 'application/json';
    const body = f.body.type === 'json' ? f.body.text : '';
    const issues = validateRequest(pets, op, { method: op.method, url, headers: { Authorization: 'Bearer t', 'X-Key': 'k', ...headers }, body }, matchOperation(pets, op.method, url)?.pathParams || {});
    assert.deepEqual(msgs(issues.filter((i) => i.level === 'error')), [], op.key);
  }
});

test('main/specs: YAML parsing, external $ref bundling, folder search', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-'));
  fs.mkdirSync(path.join(dir, 'api/schemas'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), `openapi: 3.0.0
info: { title: Files, version: '1' }
paths:
  /a:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: './schemas/thing.yaml' }
components:
  schemas:
    Local: { type: string }
`);
  fs.writeFileSync(path.join(dir, 'api/schemas/thing.yaml'), `type: object
properties:
  child: { $ref: '#/definitions/Child' }
  again: { $ref: './thing.yaml' }
definitions:
  Child: { type: integer }
`);
  fs.writeFileSync(path.join(dir, 'swagger.json'), JSON.stringify(SWAGGER2));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, 'node_modules/x/openapi.json'), JSON.stringify(OAS3));
  fs.writeFileSync(path.join(dir, 'broken-openapi.yaml'), 'openapi: 3.0.0\n  bad: [');
  const found = (await findSpecs(dir)).map((s) => [s.rel, s.title || null, !!s.error]);
  assert.deepEqual(found.sort(), [['api/openapi.yaml', 'Files', false], ['broken-openapi.yaml', null, true], ['swagger.json', 'Legacy', false]]);
  const { doc, title, operationCount, specVersion } = await readSpec(path.join(dir, 'api/openapi.yaml'));
  assert.deepEqual([title, operationCount, specVersion], ['Files', 1, 'OpenAPI 3.0.0']);
  const schema = doc.paths['/a'].get.responses['200'].content['application/json'].schema;
  assert.deepEqual(schema.properties.child, { type: 'integer' }); // the external file's own local ref resolved
  assert.deepEqual(schema.properties.again, {}); // a cycle back into a file being inlined
  assert.deepEqual(parseText('{"a":1}'), { a: 1 });
  await assert.rejects(readSpec(path.join(dir, 'package.json')), /Not an OpenAPI/);
  assert.ok(bundle);
});
