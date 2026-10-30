// Spring Boot Actuator: parsing health, env, mappings and loggers; mappings → requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health, env, mappings, loggers } from './fixtures/actuator.mjs';

const A = await import('../renderer/app/actuator.js');

test('health: nested components with depth', () => {
  assert.deepEqual(A.healthRows(health).map((r) => [r.name, r.status, r.depth]), [['application', 'UP', 0], ['db', 'UP', 1], ['diskSpace', 'UP', 1], ['payments', 'DOWN', 1]]);
});

test('env: rows in precedence order, overridden values marked', () => {
  const rows = A.envRows(env);
  assert.deepEqual(rows.filter((r) => r.name === 'server.port').map((r) => [r.value, r.overridden]), [['8080', false], ['9090', true]]);
  assert.equal(rows.find((r) => r.name === 'app.secret').value, '******');
});

test('mappings: rows, internal endpoints, requests with {{variables}}', () => {
  const rows = A.mappingRows(mappings);
  assert.deepEqual(rows.map((r) => `${r.methods.join(',')} ${r.path}`), ['GET /actuator/health', 'GET /api/orders/{orderId:[0-9]+}', 'GET /api/pets', 'POST /api/pets', 'GET /api/pets/{id}', 'GET /error']);
  assert.deepEqual(rows.filter((r) => !A.isInternalMapping(r)).map((r) => r.path), ['/api/orders/{orderId:[0-9]+}', '/api/pets', '/api/pets', '/api/pets/{id}']);
  const orders = rows.find((r) => r.path.startsWith('/api/orders'));
  assert.equal(orders.anyMethod, true); assert.equal(orders.controller, 'OrderController');
  assert.deepEqual(A.requestForMapping(orders, 'GET'), { name: 'GET /api/orders/{orderId:[0-9]+}', method: 'GET', url: '{{baseUrl}}/api/orders/{{orderId}}', headers: [], body: { type: 'none', text: '', form: [] } });
  const create = rows.find((r) => r.methods[0] === 'POST');
  assert.deepEqual(A.requestForMapping(create, 'POST').body, { type: 'json', text: '{}', form: [] });
  assert.deepEqual(A.requestForMapping(rows.find((r) => r.path === '/api/pets' && r.methods[0] === 'GET'), 'GET').headers, [{ k: 'Accept', v: 'application/json', on: true }]);
  assert.deepEqual(A.pathVariables('/a/{id}/b/{x:\\d+}'), ['id', 'x']);
});

test('loggers and base URL', () => {
  const { levels, rows } = A.loggerRows(loggers);
  assert.equal(levels.length, 6);
  assert.deepEqual(rows.map((r) => [r.name, r.configured]), [['ROOT', 'INFO'], ['com', null], ['com.example', null], ['org.hibernate.SQL', 'WARN']]);
  assert.equal(A.actuatorBaseFor('http://localhost:8080/api/v1'), 'http://localhost:8080/actuator');
  assert.equal(A.actuatorBaseFor('nope'), '');
});
