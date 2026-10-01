'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createPlanDraftStore } = require('../services/plan-draft-store');

const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const destination = { poiId: 'demo-poi-001', name: '演示目的地' };
const plan = { days: [{ number: 1, poiIds: ['demo-poi-001'] }] };
const stores = [];
const directories = [];

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwei-plan-draft-'));
  directories.push(directory);
  return path.join(directory, 'runtime', 'plan-drafts.sqlite');
}

function openStore(dbPath, ids = [FIRST_ID], options = {}) {
  let index = 0;
  const store = createPlanDraftStore({
    dbPath,
    idFactory: () => ids[index++],
    ...options
  });
  stores.push(store);
  return store;
}

test.afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('creates, reads, and reopens a draft with protected local files', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  const created = store.create({ destination, plan });

  assert.deepEqual(created, {
    draftId: FIRST_ID,
    draftRevision: 1,
    status: 'draft-ready',
    destination,
    missingInputs: [],
    plan,
    confirmedRevision: null
  });
  assert.deepEqual(store.get(FIRST_ID), created);
  assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);

  store.close();
  const reopened = openStore(dbPath);
  assert.deepEqual(reopened.get(FIRST_ID), created);
});

test('returns defensive copies and rejects invalid generated ids', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  const created = store.create({
    destination: { ...destination, metadata: { tags: ['museum'] } },
    plan
  });

  created.destination.metadata.tags.push('mutated');
  const firstRead = store.get(FIRST_ID);
  firstRead.plan.days[0].poiIds.push('mutated');
  assert.deepEqual(store.get(FIRST_ID).destination.metadata.tags, ['museum']);
  assert.deepEqual(store.get(FIRST_ID).plan.days[0].poiIds, ['demo-poi-001']);

  const invalidStore = openStore(tempDbPath(), ['not-a-uuid']);
  assert.throws(
    () => invalidStore.create({ destination, plan }),
    (error) => error.status === 500 && error.message === '草稿存储暂不可用'
  );
});

test('rejects corrupt persisted JSON without exposing its content', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  store.create({ destination, plan });
  const database = new DatabaseSync(dbPath);
  database.prepare('UPDATE plan_drafts SET payload_json = ? WHERE draft_id = ?')
    .run('{secret-corrupt-json', FIRST_ID);
  database.close();

  assert.throws(
    () => store.get(FIRST_ID),
    (error) => error.status === 500
      && error.message === '草稿存储暂不可用'
      && !error.message.includes('secret-corrupt-json')
  );
});

test('rejects inconsistent persisted rows as internal storage failures', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  const created = store.create({ destination, plan });
  const database = new DatabaseSync(dbPath);
  const update = database.prepare('UPDATE plan_drafts SET draft_revision = ?, payload_json = ? WHERE draft_id = ?');
  const corruptions = [
    [2, JSON.stringify(created)],
    [1, JSON.stringify({ ...created, draftId: SECOND_ID })],
    [1, JSON.stringify({ ...created, destination: null })]
  ];

  for (const [revision, payload] of corruptions) {
    update.run(revision, payload, FIRST_ID);
    for (const action of [
      () => store.get(FIRST_ID),
      () => store.edit(FIRST_ID, created, { plan }),
      () => store.confirm(FIRST_ID, created)
    ]) {
      assert.throws(
        action,
        (error) => error.status === 500 && error.message === '草稿存储暂不可用'
      );
    }
  }
  database.close();
});

test('does not alter existing parent permissions and rejects symlink directories', () => {
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwei-plan-existing-'));
  directories.push(existing);
  fs.chmodSync(existing, 0o755);
  assert.throws(
    () => openStore(path.join(existing, 'plan-drafts.sqlite')),
    (error) => error.status === 500 && error.message === '草稿存储暂不可用'
  );
  assert.equal(fs.statSync(existing).mode & 0o777, 0o755);

  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwei-plan-link-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwei-plan-target-'));
  directories.push(linkRoot, target);
  fs.symlinkSync(target, path.join(linkRoot, 'runtime'));
  assert.throws(
    () => openStore(path.join(linkRoot, 'runtime', 'plan-drafts.sqlite')),
    (error) => error.status === 500 && error.message === '草稿存储暂不可用'
  );
});

test('binds text as data and sanitizes a busy database failure', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath, [FIRST_ID, SECOND_ID], { busyTimeoutMs: 1 });
  const hostileName = "演示目的地'); DROP TABLE plan_drafts; --";
  const first = store.create({ destination: { ...destination, name: hostileName }, plan });
  assert.equal(store.get(FIRST_ID).destination.name, hostileName);

  const lock = new DatabaseSync(dbPath);
  lock.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(
      () => store.create({ destination, plan }),
      (error) => error.status === 500
        && error.message === '草稿存储暂不可用'
        && !error.message.includes('SQLITE_BUSY')
    );
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }
  assert.deepEqual(store.get(FIRST_ID), first);
});

test('rejects stale edits across two stores sharing one database', () => {
  const dbPath = tempDbPath();
  const firstStore = openStore(dbPath);
  const secondStore = openStore(dbPath);
  firstStore.create({ destination, plan });
  const firstSnapshot = firstStore.get(FIRST_ID);
  const secondSnapshot = secondStore.get(FIRST_ID);

  const winner = firstStore.edit(FIRST_ID, firstSnapshot, {
    plan: { days: [{ number: 1, poiIds: ['demo-poi-001'], note: '上午参观' }] }
  });
  assert.equal(winner.draftRevision, 2);
  assert.throws(
    () => secondStore.edit(FIRST_ID, secondSnapshot, { plan }),
    (error) => error.status === 409
  );
  assert.throws(
    () => secondStore.confirm(FIRST_ID, secondSnapshot),
    (error) => error.status === 409
  );
  assert.deepEqual(secondStore.get(FIRST_ID), winner);
});

test('allows only one winner when confirmation races with an edit', () => {
  const confirmFirstPath = tempDbPath();
  const confirmFirst = openStore(confirmFirstPath);
  const staleEditor = openStore(confirmFirstPath);
  const confirmSnapshot = confirmFirst.create({ destination, plan });

  const confirmed = confirmFirst.confirm(FIRST_ID, confirmSnapshot);
  assert.equal(confirmed.status, 'confirmed');
  assert.throws(
    () => staleEditor.edit(FIRST_ID, confirmSnapshot, { plan }),
    (error) => error.status === 409
  );
  assert.deepEqual(staleEditor.get(FIRST_ID), confirmed);

  const editFirstPath = tempDbPath();
  const editFirst = openStore(editFirstPath);
  const staleConfirmer = openStore(editFirstPath);
  const editSnapshot = editFirst.create({ destination, plan });

  const edited = editFirst.edit(FIRST_ID, editSnapshot, {
    plan: { days: [{ number: 1, poiIds: ['demo-poi-001'], note: '下午参观' }] }
  });
  assert.throws(
    () => staleConfirmer.confirm(FIRST_ID, editSnapshot),
    (error) => error.status === 409
  );
  assert.deepEqual(staleConfirmer.get(FIRST_ID), edited);
});

test('allows a fresh edit after confirmation and rejects repeated confirmation', () => {
  const store = openStore(tempDbPath());
  const ready = store.create({ destination, plan });
  const confirmed = store.confirm(FIRST_ID, ready);

  assert.throws(
    () => store.confirm(FIRST_ID, confirmed),
    (error) => error.status === 409
  );
  const edited = store.edit(FIRST_ID, confirmed, {
    plan: { days: [{ number: 1, poiIds: ['demo-poi-001'], note: '重新安排' }] }
  });
  assert.equal(edited.draftRevision, 2);
  assert.equal(edited.status, 'draft-ready');
  assert.equal(edited.confirmedRevision, null);
});

test('rejects malformed expected snapshots before reading or writing', () => {
  const store = openStore(tempDbPath());
  const created = store.create({ destination, plan });
  const malformedSnapshots = [
    undefined,
    {},
    { draftRevision: 0, status: 'draft-ready' },
    { draftRevision: 1.5, status: 'draft-ready' },
    { draftRevision: 1, status: 'unknown' }
  ];

  for (const snapshot of malformedSnapshots) {
    assert.throws(
      () => store.edit(FIRST_ID, snapshot, { plan }),
      (error) => error.status === 400
    );
    assert.throws(
      () => store.confirm(FIRST_ID, snapshot),
      (error) => error.status === 400
    );
  }
  assert.deepEqual(store.get(FIRST_ID), created);
});
