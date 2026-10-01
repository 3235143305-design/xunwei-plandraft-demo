'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const { createPlanDraftDemo } = require('../app/plan-draft-demo');

const DRAFT_ID = '00000000-0000-4000-8000-000000000001';
const destination = { poiId: 'demo-poi-001', name: '演示目的地' };

const ONE_DAY_DTO = {
  destination,
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

const EIGHT_DAY_DTO = {
  destination,
  missingInputs: [],
  plan: {
    schemaVersion: 1,
    origin: null,
    request: {
      dateWindow: { start: '2026-10-01', end: '2026-10-08', confirmed: true },
      requestedDays: 8,
      availabilityMode: 'fixed-dates',
      tripScope: 'destination-only'
    },
    itinerary: {
      status: 'draft-ready',
      dateWindow: { start: '2026-10-01', end: '2026-10-08', status: 'confirmed' },
      days: [
        { number: 1, date: '2026-10-01' },
        { number: 2, date: '2026-10-02' },
        { number: 3, date: '2026-10-03' },
        { number: 4, date: '2026-10-04' },
        { number: 5, date: '2026-10-05' },
        { number: 6, date: '2026-10-06' },
        { number: 7, date: '2026-10-07' },
        { number: 8, date: '2026-10-08' }
      ]
    },
    dayPreferences: {},
    planner: { source: 'synthetic-demo', preferredPoiIds: [] },
    excludedCandidateKeys: []
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serverDraft(dto, revision = 1, overrides = {}) {
  return {
    draftId: DRAFT_ID,
    draftRevision: revision,
    status: 'draft-ready',
    destination: clone(dto.destination),
    missingInputs: clone(dto.missingInputs),
    plan: clone(dto.plan),
    confirmedRevision: null,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function element(value = '') {
  const listeners = new Map();
  return {
    value,
    textContent: '',
    hidden: true,
    disabled: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type) {
      const listener = listeners.get(type);
      return listener ? listener({ preventDefault() {}, target: this }) : undefined;
    }
  };
}

function createView() {
  const elements = {
    form: element(),
    destinationName: element(destination.name),
    startDate: element('2026-10-01'),
    endDate: element('2026-10-01'),
    saveButton: element(),
    restoreButton: element(),
    retryPointerButton: element(),
    status: element(),
    staleNotice: element(),
    destinationLockNotice: element()
  };
  const selectors = {
    '#plan-draft-form': elements.form,
    '#destination-name': elements.destinationName,
    '#start-date': elements.startDate,
    '#end-date': elements.endDate,
    '#save-draft': elements.saveButton,
    '#restore-draft': elements.restoreButton,
    '#retry-pointer': elements.retryPointerButton,
    '#demo-status': elements.status,
    '#dynamic-facts-stale': elements.staleNotice,
    '#destination-lock-notice': elements.destinationLockNotice
  };
  return {
    elements,
    root: {
      querySelector(selector) {
        if (!selectors[selector]) throw new Error('unexpected selector: ' + selector);
        return selectors[selector];
      }
    }
  };
}

function createStorage({ pointer = null, failSet = false } = {}) {
  const calls = [];
  let value = pointer;
  return {
    calls,
    failSet,
    getItem(key) { calls.push(['getItem', key]); return value; },
    setItem(key, next) {
      calls.push(['setItem', key, next]);
      if (this.failSet) throw new Error('storage unavailable');
      value = next;
    },
    removeItem(key) { calls.push(['removeItem', key]); value = null; },
    value() { return value; }
  };
}

function createHarness({ request, storage = createStorage(), confirmRestore = async () => true } = {}) {
  const { root, elements } = createView();
  const requestCalls = [];
  const injectedRequest = async (path, options) => {
    requestCalls.push([path, options]);
    if (!request) throw new Error('unexpected request');
    return request(path, options);
  };
  const demo = createPlanDraftDemo({ root, request: injectedRequest, storage, confirmRestore });
  return { demo, elements, requestCalls, storage };
}

function viewSnapshot(elements) {
  return Object.fromEntries(Object.entries(elements).map(([name, node]) => [name, {
    value: node.value,
    textContent: node.textContent,
    hidden: node.hidden,
    disabled: node.disabled
  }]));
}

function editableValues(elements) {
  return {
    destinationName: elements.destinationName.value,
    startDate: elements.startDate.value,
    endDate: elements.endDate.value
  };
}

function formState(elements) {
  return {
    ...editableValues(elements),
    destinationLocked: elements.destinationName.disabled
  };
}

function assertDestinationLockNotice(elements) {
  assert.equal(elements.destinationLockNotice.hidden, false);
  assert.match(elements.destinationLockNotice.textContent, /目的地在首次保存后锁定/);
  assert.match(elements.destinationLockNotice.textContent, /更换目的地需新建草稿/);
  assert.match(elements.destinationLockNotice.textContent, /v1 暂不提供/i);
}

test('loading performs no request and every invalid date form performs no request', async () => {
  const { demo, elements, requestCalls, storage } = createHarness();

  assert.equal(requestCalls.length, 0);
  assert.equal(storage.calls.length, 0);

  const invalidForms = [
    { destinationName: '', startDate: '2026-10-01', endDate: '2026-10-01' },
    { destinationName: '演'.repeat(81), startDate: '2026-10-01', endDate: '2026-10-01' },
    { destinationName: destination.name, startDate: 'not-a-date', endDate: '2026-10-01' },
    { destinationName: destination.name, startDate: '2026-02-30', endDate: '2026-03-01' },
    { destinationName: destination.name, startDate: '2026-10-02', endDate: '2026-10-01' },
    { destinationName: destination.name, startDate: '2026-10-01', endDate: '2026-10-09' }
  ];
  for (const input of invalidForms) {
    elements.destinationName.value = input.destinationName;
    elements.startDate.value = input.startDate;
    elements.endDate.value = input.endDate;
    await demo.submit();
    assert.equal(requestCalls.length, 0, JSON.stringify(input));
  }
  assert.notEqual(elements.status.textContent, '');
});

test('the demo derives and submits complete synthetic DTOs at the 1-day and 8-day boundaries', async () => {
  const oneDay = createHarness({
    request: async (_path, options) => serverDraft(JSON.parse(options.body))
  });
  await oneDay.demo.submit();
  assert.equal(oneDay.requestCalls[0][0], '/api/plan-drafts');
  assert.equal(oneDay.requestCalls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(oneDay.requestCalls[0][1].body), ONE_DAY_DTO);

  const eightDays = createHarness({
    request: async (_path, options) => serverDraft(JSON.parse(options.body))
  });
  eightDays.elements.endDate.value = '2026-10-08';
  await eightDays.demo.submit();
  assert.deepEqual(JSON.parse(eightDays.requestCalls[0][1].body), EIGHT_DAY_DTO);
});

test('the first save uses POST, later saves use PATCH, and destination locks only after server success', async () => {
  const firstResponse = deferred();
  let latestDto = clone(ONE_DAY_DTO);
  const harness = createHarness({
    request: async (_path, options) => {
      if (options.method === 'POST') return firstResponse.promise;
      const patch = JSON.parse(options.body);
      latestDto = { ...latestDto, missingInputs: patch.missingInputs, plan: patch.plan };
      return serverDraft(latestDto, 2);
    }
  });

  const firstSave = harness.demo.submit();
  assert.equal(harness.elements.destinationName.disabled, false);
  firstResponse.resolve(serverDraft(ONE_DAY_DTO));
  await firstSave;
  assert.equal(harness.elements.destinationName.disabled, true);
  assertDestinationLockNotice(harness.elements);

  harness.elements.endDate.value = '2026-10-08';
  await harness.demo.submit();
  assert.deepEqual(harness.requestCalls.map(([, options]) => options.method), ['POST', 'PATCH']);
  assert.equal(harness.requestCalls[1][0], `/api/plan-drafts/${DRAFT_ID}`);
  assert.deepEqual(JSON.parse(harness.requestCalls[1][1].body), {
    expectedDraftRevision: 1,
    expectedStatus: 'draft-ready',
    missingInputs: [],
    plan: EIGHT_DAY_DTO.plan
  });
});

test('saved-pointer-failed locks destination, keeps draft id, and retryPointer never repeats POST', async () => {
  const storage = createStorage({ failSet: true });
  const harness = createHarness({
    storage,
    request: async (_path, options) => serverDraft(JSON.parse(options.body))
  });

  const first = await harness.demo.submit();
  assert.equal(first.outcome, 'saved-pointer-failed');
  assert.equal(first.draft.draftId, DRAFT_ID);
  assert.equal(harness.elements.destinationName.disabled, true);
  assert.match(harness.elements.status.textContent, /已保存/);
  assert.match(harness.elements.status.textContent, /浏览器/);
  assert.match(harness.elements.status.textContent, /未记住|没有记住/);
  assert.match(harness.elements.status.textContent, /不要刷新/);
  assert.equal(harness.elements.retryPointerButton.hidden, false);
  assertDestinationLockNotice(harness.elements);

  storage.failSet = false;
  const retried = harness.demo.retryPointer();
  assert.equal(retried.outcome, 'pointer-saved');
  assert.equal(retried.draft.draftId, DRAFT_ID);
  assert.equal(harness.requestCalls.filter(([, options]) => options.method === 'POST').length, 1);
  assert.equal(storage.value(), DRAFT_ID);
});

test('restore is explicit and cancelling a dirty restore changes no storage, request, or DOM state', async () => {
  let confirmCalls = 0;
  const harness = createHarness({
    storage: createStorage({ pointer: DRAFT_ID }),
    confirmRestore: async () => { confirmCalls += 1; return false; }
  });
  assert.equal(harness.requestCalls.length, 0);
  assert.equal(harness.storage.calls.length, 0);

  harness.elements.destinationName.value = '本地未保存的演示目的地';
  harness.elements.destinationName.dispatch('input');
  const before = viewSnapshot(harness.elements);
  const result = await harness.demo.restore();

  assert.equal(result.outcome, 'restore-cancelled');
  assert.equal(confirmCalls, 1);
  assert.equal(harness.requestCalls.length, 0);
  assert.equal(harness.storage.calls.length, 0);
  assert.deepEqual(viewSnapshot(harness.elements), before);
});

test('confirmed dirty restore waits for confirmation then atomically replaces every field and clears dirty state', async () => {
  const confirmation = deferred();
  const response = deferred();
  let confirmCalls = 0;
  let restoreRequestCount = 0;
  const restoredDto = clone(ONE_DAY_DTO);
  restoredDto.destination = { poiId: 'demo-poi-002', name: '恢复演示目的地' };
  restoredDto.plan.request.dateWindow = { start: '2026-11-03', end: '2026-11-05', confirmed: true };
  restoredDto.plan.request.requestedDays = 3;
  restoredDto.plan.itinerary.dateWindow = { start: '2026-11-03', end: '2026-11-05', status: 'confirmed' };
  restoredDto.plan.itinerary.days = [
    { number: 1, date: '2026-11-03' },
    { number: 2, date: '2026-11-04' },
    { number: 3, date: '2026-11-05' }
  ];
  const restoredDraft = serverDraft(restoredDto, 3);
  const harness = createHarness({
    storage: createStorage({ pointer: DRAFT_ID }),
    confirmRestore: () => { confirmCalls += 1; return confirmation.promise; },
    request: () => {
      restoreRequestCount += 1;
      return restoreRequestCount === 1 ? response.promise : restoredDraft;
    }
  });
  harness.elements.destinationName.value = '本地未保存的演示目的地';
  harness.elements.startDate.value = '2026-12-01';
  harness.elements.endDate.value = '2026-12-02';
  harness.elements.destinationName.dispatch('input');
  const before = viewSnapshot(harness.elements);

  const restoring = harness.demo.restore();
  assert.equal(confirmCalls, 1);
  assert.equal(harness.requestCalls.length, 0);
  assert.equal(harness.storage.calls.length, 0);
  assert.deepEqual(viewSnapshot(harness.elements), before);

  confirmation.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.requestCalls.length, 1);
  assert.equal(harness.requestCalls[0][0], `/api/plan-drafts/${DRAFT_ID}`);
  assert.equal(harness.requestCalls[0][1].method, 'GET');
  assert.deepEqual(viewSnapshot(harness.elements), before);

  response.resolve(restoredDraft);
  const result = await restoring;
  assert.equal(result.outcome, 'restored');
  assert.equal(harness.elements.destinationName.value, '恢复演示目的地');
  assert.equal(harness.elements.startDate.value, '2026-11-03');
  assert.equal(harness.elements.endDate.value, '2026-11-05');
  assert.equal(harness.elements.destinationName.disabled, true);
  assert.equal(harness.elements.staleNotice.hidden, false);
  assert.match(harness.elements.staleNotice.textContent, /动态事实/);
  assert.match(harness.elements.staleNotice.textContent, /未随草稿恢复/);
  assert.match(harness.elements.staleNotice.textContent, /(?:不|不会)请求天气或路线/);
  assertDestinationLockNotice(harness.elements);

  const secondRestore = await harness.demo.restore();
  assert.equal(secondRestore.outcome, 'restored');
  assert.equal(confirmCalls, 1);
  assert.equal(restoreRequestCount, 2);
});

test('a failed restore leaves the complete form and destination lock unchanged', async () => {
  let confirmCalls = 0;
  let requestCalls = 0;
  const harness = createHarness({
    storage: createStorage({ pointer: DRAFT_ID }),
    confirmRestore: async () => { confirmCalls += 1; return true; },
    request: async () => { requestCalls += 1; throw new Error('offline'); }
  });
  harness.elements.destinationName.value = '恢复失败时保留的演示目的地';
  harness.elements.startDate.value = '2026-12-03';
  harness.elements.endDate.value = '2026-12-05';
  harness.elements.destinationName.dispatch('input');
  const before = formState(harness.elements);

  const result = await harness.demo.restore();

  assert.equal(result.outcome, 'restore-failed');
  assert.equal(confirmCalls, 1);
  assert.equal(requestCalls, 1);
  assert.deepEqual(formState(harness.elements), before);

  const secondResult = await harness.demo.restore();
  assert.equal(secondResult.outcome, 'restore-failed');
  assert.equal(confirmCalls, 2);
  assert.equal(requestCalls, 2);
  assert.deepEqual(formState(harness.elements), before);
});

test('409, network, and pointer-storage failures preserve every editable form value', async (t) => {
  await t.test('409 conflict', async () => {
    let created = false;
    const harness = createHarness({
      request: async (_path, options) => {
        if (!created) { created = true; return serverDraft(ONE_DAY_DTO); }
        if (options.method === 'GET') return serverDraft(ONE_DAY_DTO, 2);
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
    });
    await harness.demo.submit();
    harness.elements.startDate.value = '2026-10-02';
    harness.elements.endDate.value = '2026-10-08';
    const before = editableValues(harness.elements);
    const result = await harness.demo.submit();
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(editableValues(harness.elements), before);
  });

  await t.test('network failure', async () => {
    const harness = createHarness({ request: async () => { throw new Error('offline'); } });
    harness.elements.destinationName.value = '网络失败时保留的演示目的地';
    harness.elements.startDate.value = '2026-10-02';
    harness.elements.endDate.value = '2026-10-08';
    const before = editableValues(harness.elements);
    const result = await harness.demo.submit();
    assert.equal(result.outcome, 'save-failed');
    assert.deepEqual(editableValues(harness.elements), before);
  });

  await t.test('pointer storage failure', async () => {
    const harness = createHarness({
      storage: createStorage({ failSet: true }),
      request: async (_path, options) => serverDraft(JSON.parse(options.body))
    });
    harness.elements.destinationName.value = '指针失败时保留的演示目的地';
    harness.elements.startDate.value = '2026-10-02';
    harness.elements.endDate.value = '2026-10-08';
    const before = editableValues(harness.elements);
    const result = await harness.demo.submit();
    assert.equal(result.outcome, 'saved-pointer-failed');
    assert.deepEqual(editableValues(harness.elements), before);
  });
});
