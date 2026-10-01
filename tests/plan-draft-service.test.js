const assert = require('assert/strict');
const test = require('node:test');

const destination = { poiId: 'demo-poi-001', name: '演示目的地' };
const plan = { days: [{ number: 1, poiIds: ['demo-poi-001'] }] };

test('creates needs-input and draft-ready states from explicit inputs', () => {
  const { createPlanDraft } = require('../services/plan-draft-service');
  const needsInput = createPlanDraft({
    draftId: 'draft-1',
    destination,
    missingInputs: [{ code: 'date-window-required', question: '请补充出行日期。' }]
  });
  const ready = createPlanDraft({ draftId: 'draft-2', destination, plan });

  assert.deepEqual(needsInput, {
    draftId: 'draft-1',
    draftRevision: 1,
    status: 'needs-input',
    destination,
    missingInputs: [{ code: 'date-window-required', question: '请补充出行日期。' }],
    plan: null,
    confirmedRevision: null
  });
  assert.equal(ready.status, 'draft-ready');
  assert.equal(ready.draftRevision, 1);
  assert.deepEqual(ready.plan, plan);
});

test('confirms only when the expected revision matches the supplied latest draft', () => {
  const { createPlanDraft, editPlanDraft, confirmPlanDraft } = require('../services/plan-draft-service');
  const ready = createPlanDraft({ draftId: 'draft-1', destination, plan });
  const latest = editPlanDraft(ready, {
    plan: { days: [{ number: 1, poiIds: ['demo-poi-001'], note: '上午参观' }] }
  });

  assert.throws(() => confirmPlanDraft(latest, 1), /草稿版本已变化/);
  const confirmed = confirmPlanDraft(latest, 2);

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmedRevision, 2);
  assert.equal(latest.status, 'draft-ready');
  assert.equal(latest.confirmedRevision, null);
});

test('editing increments the draft revision and invalidates confirmation', () => {
  const { createPlanDraft, confirmPlanDraft, editPlanDraft } = require('../services/plan-draft-service');
  const confirmed = confirmPlanDraft(createPlanDraft({ draftId: 'draft-1', destination, plan }), 1);
  const edited = editPlanDraft(confirmed, {
    missingInputs: [{ code: 'route-unavailable', question: '请选择无路线时的处理方式。' }],
    plan: null
  });

  assert.equal(edited.status, 'needs-input');
  assert.equal(edited.draftRevision, 2);
  assert.equal(edited.confirmedRevision, null);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.draftRevision, 1);
  assert.deepEqual(confirmed.plan, plan);
});

test('rejects incomplete ready drafts and confirmation with missing input', () => {
  const { createPlanDraft, confirmPlanDraft } = require('../services/plan-draft-service');

  assert.throws(
    () => createPlanDraft({ draftId: 'draft-1', destination }),
    /完整草稿需要 plan/
  );
  const needsInput = createPlanDraft({
    draftId: 'draft-2',
    destination,
    missingInputs: [{ code: 'date-window-required', question: '请补充出行日期。' }]
  });
  assert.throws(() => confirmPlanDraft(needsInput, 1), /草稿尚未就绪/);
});

test('rejects malformed and inconsistent existing drafts before editing or confirmation', () => {
  const { createPlanDraft, editPlanDraft, confirmPlanDraft } = require('../services/plan-draft-service');
  const ready = createPlanDraft({ draftId: 'draft-1', destination, plan });
  const malformedDrafts = [
    { ...ready, draftId: '' },
    { ...ready, destination: null },
    { ...ready, destination: { name: destination.name } },
    { ...ready, missingInputs: {} },
    { ...ready, status: 'needs-input' },
    { ...ready, status: 'draft-ready', confirmedRevision: 1 },
    { ...ready, status: 'confirmed', confirmedRevision: 2 }
  ];

  for (const malformed of malformedDrafts) {
    assert.throws(
      () => editPlanDraft(malformed, { plan }),
      /无效的 PlanDraft/
    );
    assert.throws(
      () => confirmPlanDraft(malformed, malformed.draftRevision),
      /无效的 PlanDraft/
    );
  }
});

test('keeps created and edited nested state isolated from caller mutations', () => {
  const { createPlanDraft, editPlanDraft } = require('../services/plan-draft-service');
  const inputDestination = {
    ...destination,
    metadata: { tags: ['museum'] }
  };
  const inputPlan = { days: [{ number: 1, poiIds: ['demo-poi-001'] }] };
  const created = createPlanDraft({
    draftId: 'draft-1',
    destination: inputDestination,
    plan: inputPlan
  });

  inputDestination.metadata.tags.push('mutated');
  inputPlan.days[0].poiIds.push('mutated');
  assert.deepEqual(created.destination.metadata.tags, ['museum']);
  assert.deepEqual(created.plan.days[0].poiIds, ['demo-poi-001']);

  const patch = {
    missingInputs: [{ code: 'route-unavailable', question: '请选择无路线时的处理方式。' }],
    plan: null
  };
  const edited = editPlanDraft(created, patch);
  patch.missingInputs[0].question = '已被调用方修改';

  assert.equal(edited.missingInputs[0].question, '请选择无路线时的处理方式。');
  assert.deepEqual(created.missingInputs, []);
});
