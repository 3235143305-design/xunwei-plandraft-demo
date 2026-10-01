'use strict';

const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} 不能为空`);
  return value.trim();
};

const normalizeDestination = (value) => {
  if (!isObject(value)) throw new TypeError('需要已确认的 destination');
  return {
    ...copy(value),
    poiId: requiredText(value.poiId, 'destination.poiId'),
    name: requiredText(value.name, 'destination.name')
  };
};

const normalizeMissingInputs = (value = []) => {
  if (!Array.isArray(value)) throw new TypeError('missingInputs 必须是数组');
  return value.map((item) => {
    if (!isObject(item)) throw new TypeError('missingInputs 项必须是对象');
    return {
      code: requiredText(item.code, 'missingInputs.code'),
      question: requiredText(item.question, 'missingInputs.question')
    };
  });
};

const normalizePlan = (value) => {
  if (value == null) return null;
  if (!isObject(value)) throw new TypeError('plan 必须是对象或 null');
  return copy(value);
};

const draftStatus = (missingInputs, plan) => {
  if (missingInputs.length) return 'needs-input';
  if (!plan) throw new TypeError('完整草稿需要 plan');
  return 'draft-ready';
};

const assertPlanDraft = (draft) => {
  const hasText = (value) => typeof value === 'string' && Boolean(value.trim());
  const hasDestination = isObject(draft?.destination)
    && hasText(draft.destination.poiId)
    && hasText(draft.destination.name);
  const hasMissingInputs = Array.isArray(draft?.missingInputs)
    && draft.missingInputs.every((item) => isObject(item) && hasText(item.code) && hasText(item.question));
  const hasPlan = draft?.plan === null || isObject(draft?.plan);
  const hasBaseShape = isObject(draft)
    && hasText(draft.draftId)
    && Number.isInteger(draft.draftRevision)
    && draft.draftRevision >= 1
    && hasDestination
    && hasMissingInputs
    && hasPlan;
  const hasValidState = hasBaseShape && (
    (draft.status === 'needs-input' && draft.missingInputs.length > 0 && draft.confirmedRevision === null)
    || (draft.status === 'draft-ready' && draft.missingInputs.length === 0 && isObject(draft.plan) && draft.confirmedRevision === null)
    || (draft.status === 'confirmed' && draft.missingInputs.length === 0 && isObject(draft.plan)
      && draft.confirmedRevision === draft.draftRevision)
  );
  if (!hasValidState) throw new TypeError('无效的 PlanDraft');
};

function createPlanDraft({ draftId, destination, missingInputs = [], plan = null } = {}) {
  const normalizedMissingInputs = normalizeMissingInputs(missingInputs);
  const normalizedPlan = normalizePlan(plan);
  return {
    draftId: requiredText(draftId, 'draftId'),
    draftRevision: 1,
    status: draftStatus(normalizedMissingInputs, normalizedPlan),
    destination: normalizeDestination(destination),
    missingInputs: normalizedMissingInputs,
    plan: normalizedPlan,
    confirmedRevision: null
  };
}

function editPlanDraft(draft, patch) {
  assertPlanDraft(draft);
  if (!isObject(patch) || (!has(patch, 'missingInputs') && !has(patch, 'plan'))) {
    throw new TypeError('编辑必须包含 missingInputs 或 plan');
  }
  const missingInputs = has(patch, 'missingInputs')
    ? normalizeMissingInputs(patch.missingInputs)
    : normalizeMissingInputs(draft.missingInputs);
  const plan = has(patch, 'plan') ? normalizePlan(patch.plan) : normalizePlan(draft.plan);
  return {
    ...copy(draft),
    draftRevision: draft.draftRevision + 1,
    status: draftStatus(missingInputs, plan),
    missingInputs,
    plan,
    confirmedRevision: null
  };
}

function confirmPlanDraft(draft, expectedDraftRevision) {
  assertPlanDraft(draft);
  if (expectedDraftRevision !== draft.draftRevision) throw new Error('草稿版本已变化，请重新确认');
  if (draft.status !== 'draft-ready' || (draft.missingInputs || []).length || !draft.plan) {
    throw new Error('草稿尚未就绪，不能确认');
  }
  return { ...copy(draft), status: 'confirmed', confirmedRevision: draft.draftRevision };
}

module.exports = { createPlanDraft, editPlanDraft, confirmPlanDraft, assertPlanDraft };
