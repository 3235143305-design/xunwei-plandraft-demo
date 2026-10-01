'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const { createSameOriginRequest } = require('../app/api');
const { ACTIVE_DRAFT_KEY, createPlanDraftClient } = require('../app/plan-draft');

const DRAFT_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_DRAFT_ID = '00000000-0000-4000-8000-000000000002';

const dto = {
  destination: { poiId: 'demo-poi-001', name: '演示目的地' },
  missingInputs: [],
  plan: {
    schemaVersion: 1,
    origin: null,
    request: {
      dateWindow: { start: '2026-10-01', end: '2026-10-01', confirmed: true },
      requestedDays: 1,
      availabilityMode: 'fixed-dates',
      tripScope: 'destination-only'
    },
    itinerary: {
      status: 'draft-ready',
      dateWindow: { start: '2026-10-01', end: '2026-10-01', status: 'confirmed' },
      days: [{ number: 1, date: '2026-10-01' }]
    },
    dayPreferences: {},
    planner: { source: 'synthetic-demo', preferredPoiIds: [] },
    excludedCandidateKeys: []
  }
};

function draft(draftId = DRAFT_ID, revision = 1, input = dto) {
  return {
    draftId,
    draftRevision: revision,
    status: 'draft-ready',
    destination: input.destination,
    missingInputs: input.missingInputs,
    plan: input.plan,
    confirmedRevision: null
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) { return key === ACTIVE_DRAFT_KEY ? value : null; },
    setItem(key, next) { if (key === ACTIVE_DRAFT_KEY) value = next; },
    removeItem(key) { if (key === ACTIVE_DRAFT_KEY) value = null; },
    value() { return value; }
  };
}

test('same-origin request accepts only relative /api/ paths and unwraps successful data', async () => {
  const calls = [];
  const request = createSameOriginRequest({
    fetchImpl: async (path, options) => {
      calls.push([path, options]);
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, data: { status: 'ok' } }; }
      };
    }
  });

  assert.deepEqual(await request('/api/health', { method: 'GET' }), { status: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/health');

  for (const path of [
    'https://example.test/api/health',
    'http://example.test/api/health',
    '//example.test/api/health',
    '\\api\\health',
    '/plan-drafts',
    'api/plan-drafts'
  ]) {
    await assert.rejects(() => request(path, { method: 'GET' }), /同源|\/api\//, path);
  }
  assert.equal(calls.length, 1);
});

async function captureRequestError(action) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /\/secret\/path/);
    return error;
  }
  assert.fail('expected request to fail');
}

test('same-origin request converts transport and malformed responses into public errors', async (t) => {
  await t.test('network failure', async () => {
    const request = createSameOriginRequest({
      fetchImpl: async () => { throw new Error('socket failed at /secret/path'); }
    });
    const error = await captureRequestError(() => request('/api/health', { method: 'GET' }));
    assert.match(error.message, /网络|请求失败/);
  });

  await t.test('non-JSON response', async () => {
    const request = createSameOriginRequest({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { throw new SyntaxError('unexpected /secret/path'); }
      })
    });
    const error = await captureRequestError(() => request('/api/health', { method: 'GET' }));
    assert.match(error.message, /响应|格式/);
  });

  await t.test('HTTP non-2xx response', async () => {
    const request = createSameOriginRequest({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        async json() { return { ok: true, data: null, detail: '/secret/path' }; }
      })
    });
    const error = await captureRequestError(() => request('/api/health', { method: 'GET' }));
    assert.equal(error.status, 503);
    assert.match(error.message, /请求失败|服务暂不可用/);
  });

  await t.test('API ok:false response', async () => {
    const request = createSameOriginRequest({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return { ok: false, error: 'internal failure /secret/path' }; }
      })
    });
    const error = await captureRequestError(() => request('/api/health', { method: 'GET' }));
    assert.match(error.message, /请求失败|服务暂不可用/);
  });
});

test('plan draft client uses only the injected request and storage dependencies', async () => {
  const calls = [];
  const storage = memoryStorage();
  const client = createPlanDraftClient({
    request: async (path, options) => {
      calls.push([path, options]);
      return draft();
    },
    storage
  });

  const result = await client.save(dto);

  assert.equal(result.outcome, 'saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/plan-drafts');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(storage.value(), DRAFT_ID);
});

test('a delayed restore response cannot overwrite a newer active draft', async () => {
  const delayed = deferred();
  const client = createPlanDraftClient({
    request: () => delayed.promise,
    storage: memoryStorage(DRAFT_ID)
  });
  const restorePromise = client.restore();
  const newer = draft(SECOND_DRAFT_ID, 4);

  client.useDraft(newer);
  delayed.resolve(draft(DRAFT_ID, 1));
  await restorePromise;

  assert.deepEqual(client.currentDraft(), newer);
});

test('an old restore 404 cannot clear the pointer written by a newer successful save', async () => {
  const delayedGet = deferred();
  const storage = memoryStorage(DRAFT_ID);
  const calls = [];
  const newer = draft(SECOND_DRAFT_ID, 1);
  const client = createPlanDraftClient({
    request: (path, options) => {
      calls.push({ path, method: options.method });
      if (options.method === 'GET') return delayedGet.promise;
      if (options.method === 'POST') return Promise.resolve(newer);
      throw new Error('unexpected request');
    },
    storage
  });

  const restorePromise = client.restore();
  assert.deepEqual(calls, [{
    path: `/api/plan-drafts/${DRAFT_ID}`,
    method: 'GET'
  }]);

  const saveResult = await client.save(dto);
  assert.equal(saveResult.outcome, 'saved');
  assert.equal(storage.value(), SECOND_DRAFT_ID);
  assert.deepEqual(client.currentDraft(), newer);
  assert.deepEqual(calls, [
    { path: `/api/plan-drafts/${DRAFT_ID}`, method: 'GET' },
    { path: '/api/plan-drafts', method: 'POST' }
  ]);

  const notFound = new Error('not found');
  notFound.status = 404;
  delayedGet.reject(notFound);
  const restoreResult = await restorePromise;

  assert.notEqual(restoreResult.outcome, 'restored');
  assert.equal(storage.value(), SECOND_DRAFT_ID);
  assert.deepEqual(client.currentDraft(), newer);
  assert.deepEqual(calls, [
    { path: `/api/plan-drafts/${DRAFT_ID}`, method: 'GET' },
    { path: '/api/plan-drafts', method: 'POST' }
  ]);
});

test('a save already in progress rejects a second save without sending a second request', async () => {
  const delayed = deferred();
  let requestCount = 0;
  const client = createPlanDraftClient({
    request: () => {
      requestCount += 1;
      return delayed.promise;
    },
    storage: memoryStorage()
  });
  const firstSave = client.save(dto);
  const secondDto = JSON.parse(JSON.stringify(dto));
  secondDto.plan.request.dateWindow.end = '2026-10-02';
  secondDto.plan.request.requestedDays = 2;
  secondDto.plan.itinerary.dateWindow.end = '2026-10-02';
  secondDto.plan.itinerary.days.push({ number: 2, date: '2026-10-02' });

  const secondSave = await client.save(secondDto);

  assert.equal(secondSave.outcome, 'save-in-progress');
  assert.deepEqual(secondSave.pendingDto, secondDto);
  assert.equal(requestCount, 1);

  const saved = draft(DRAFT_ID, 1, dto);
  delayed.resolve(saved);
  assert.equal((await firstSave).outcome, 'saved');
  assert.deepEqual(client.currentDraft(), saved);
  assert.equal(requestCount, 1);
});

test('an unavailable storage pointer returns pointer-unavailable without making a request', async () => {
  let requestCount = 0;
  const storage = memoryStorage();
  storage.getItem = () => { throw new Error('storage unavailable'); };
  const client = createPlanDraftClient({
    request: async () => { requestCount += 1; return draft(); },
    storage
  });

  const result = await client.restore();

  assert.equal(result.outcome, 'pointer-unavailable');
  assert.equal(requestCount, 0);
});

test('pointer retry after a successful POST never creates a second server draft', async () => {
  let requestCount = 0;
  let setCount = 0;
  const storage = memoryStorage();
  storage.setItem = (key, value) => {
    setCount += 1;
    if (setCount === 1) throw new Error('storage unavailable');
    if (key === ACTIVE_DRAFT_KEY) storage._saved = value;
  };
  const client = createPlanDraftClient({
    request: async () => { requestCount += 1; return draft(); },
    storage
  });

  const first = await client.save(dto);
  assert.equal(first.outcome, 'saved-pointer-failed');
  assert.equal(requestCount, 1);

  const retried = client.retryPointer();
  assert.equal(retried.outcome, 'pointer-saved');
  assert.equal(storage._saved, DRAFT_ID);
  assert.equal(requestCount, 1);
});

test('a 409 conflict preserves the pending local edit and the pre-conflict active snapshot', async () => {
  const original = draft(DRAFT_ID, 1);
  const remote = draft(DRAFT_ID, 2);
  const local = JSON.parse(JSON.stringify(dto));
  local.plan.request.dateWindow.end = '2026-10-02';
  local.plan.request.requestedDays = 2;
  local.plan.itinerary.dateWindow.end = '2026-10-02';
  local.plan.itinerary.days.push({ number: 2, date: '2026-10-02' });
  const calls = [];
  const client = createPlanDraftClient({
    request: async (path, options) => {
      calls.push([path, options]);
      if (options.method === 'PATCH') {
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      return remote;
    },
    storage: memoryStorage(DRAFT_ID)
  });
  client.useDraft(original);

  const result = await client.save(local);

  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(result.pendingDto, local);
  assert.deepEqual(result.remoteDraft, remote);
  assert.deepEqual(client.currentDraft(), original);
  assert.deepEqual(calls.map(([, options]) => options.method), ['PATCH', 'GET']);
});
