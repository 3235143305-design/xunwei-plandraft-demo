'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');

const { createApi } = require('../server');

const DRAFT_ID = '00000000-0000-4000-8000-000000000001';
const destination = { poiId: 'demo-poi-001', name: '演示目的地' };
const plan = { days: [{ number: 1, poiIds: ['demo-poi-001'] }] };
const draft = {
  draftId: DRAFT_ID,
  draftRevision: 1,
  status: 'draft-ready',
  destination,
  missingInputs: [],
  plan,
  confirmedRevision: null
};

async function invoke(api, pathname, { method = 'GET', body } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { 'content-type': 'application/json' };
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.body = value ? JSON.parse(String(value)) : null; }
  };
  const url = new URL(pathname, 'http://127.0.0.1');
  const handledPromise = api(request, response, decodeURIComponent(url.pathname), url);
  if (body !== undefined) request.emit('data', JSON.stringify(body));
  request.emit('end');
  const handled = await handledPromise;
  return { handled, status: response.status, headers: response.headers || {}, body: response.body };
}

function error(status, message) {
  const value = new Error(message);
  value.status = status;
  return value;
}

test('creates drafts with 201 and rejects client ids or unknown fields', async () => {
  const calls = [];
  const api = createApi({
    planDraftStore: {
      create(input) { calls.push(input); return draft; }
    }
  });

  const created = await invoke(api, '/api/plan-drafts', {
    method: 'POST', body: { destination, missingInputs: [], plan }
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { ok: true, data: draft });
  assert.equal(created.headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual(calls, [{ destination, missingInputs: [], plan }]);

  for (const body of [
    { draftId: DRAFT_ID, destination, plan },
    { destination, plan, unexpected: true }
  ]) {
    const rejected = await invoke(api, '/api/plan-drafts', { method: 'POST', body });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.body, { ok: false, error: '草稿请求无效' });
    assert.equal(rejected.headers['Access-Control-Allow-Origin'], undefined);
  }
  assert.equal(calls.length, 1);
});

test('separates the expected snapshot from an edit patch', async () => {
  const calls = [];
  const api = createApi({
    planDraftStore: {
      edit(...args) { calls.push(args); return { ...draft, draftRevision: 2 }; }
    }
  });
  const response = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`, {
    method: 'PATCH',
    body: {
      expectedDraftRevision: 1,
      expectedStatus: 'draft-ready',
      missingInputs: [],
      plan
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [[
    DRAFT_ID,
    { draftRevision: 1, status: 'draft-ready' },
    { missingInputs: [], plan }
  ]]);
});

test('maps known draft errors and sanitizes unknown store failures', async () => {
  const cases = [
    { status: 400, message: '草稿请求无效' },
    { status: 404, message: '草稿不存在' },
    { status: 409, message: '草稿已变化，请重新读取' },
    { status: undefined, message: 'SQLITE_BUSY /secret/path' }
  ];
  for (const item of cases) {
    const api = createApi({
      planDraftStore: { get() { throw error(item.status, item.message); } }
    });
    const response = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`);
    const expectedStatus = item.status || 500;
    const expectedMessage = item.status ? item.message : '草稿存储暂不可用';
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(response.body, { ok: false, error: expectedMessage });
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
    assert.doesNotMatch(response.body.error, /SQLITE_BUSY|secret/);
  }
});

test('rejects malformed draft routes before accessing the store', async () => {
  let calls = 0;
  const store = new Proxy({}, { get: () => () => { calls += 1; return draft; } });
  const api = createApi({ planDraftStore: store });
  const cases = [
    ['GET', '/api/plan-drafts/not-a-uuid', true, 400],
    ['GET', '/api/plan-drafts', false],
    ['DELETE', `/api/plan-drafts/${DRAFT_ID}`, false],
    ['GET', `/api/plan-drafts/${DRAFT_ID}/extra`, false],
    ['GET', `/api/plan-drafts//${DRAFT_ID}`, false],
    ['GET', `/api/plan-drafts/${DRAFT_ID}%2Fconfirm`, false]
  ];
  for (const [method, pathname, handled, status] of cases) {
    const response = await invoke(api, pathname, { method });
    assert.equal(response.handled, handled, method + ' ' + pathname);
    if (status) assert.equal(response.status, status, method + ' ' + pathname);
  }
  assert.equal(calls, 0);
});
