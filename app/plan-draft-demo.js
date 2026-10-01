'use strict';

(function (root, factory) {
  const planDraftApi = typeof module === 'object' && module.exports
    ? require('./plan-draft')
    : root.PlanDraftClient;
  const api = factory(planDraftApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PlanDraftDemo = api;

  if (root?.document && root.XunweiApi && planDraftApi) {
    const start = () => api.createPlanDraftDemo({
      root: root.document,
      request: root.XunweiApi.apiFetch,
      storage: root.localStorage,
      confirmRestore: async () => root.confirm('恢复草稿会覆盖尚未保存的输入，是否继续？')
    });
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
}(typeof window === 'undefined' ? globalThis : window, function (planDraftApi) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SYNTHETIC_POI_ID = 'demo-poi-001';

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function buildDto(destinationName, start, end) {
    const name = typeof destinationName === 'string' ? destinationName.trim() : '';
    if (!name || name.length > 80 || !validDate(start) || !validDate(end) || start > end) {
      throw new TypeError('请检查演示目的地和日期。');
    }
    const requestedDays = Math.round((Date.parse(end + 'T00:00:00Z')
      - Date.parse(start + 'T00:00:00Z')) / DAY_MS) + 1;
    if (requestedDays < 1 || requestedDays > 8) {
      throw new TypeError('演示行程仅支持 1 至 8 天。');
    }
    const days = Array.from({ length: requestedDays }, (_, index) => ({
      number: index + 1,
      date: new Date(Date.parse(start + 'T00:00:00Z') + index * DAY_MS).toISOString().slice(0, 10)
    }));
    return {
      destination: { poiId: SYNTHETIC_POI_ID, name },
      missingInputs: [],
      plan: {
        schemaVersion: 1,
        origin: null,
        request: {
          dateWindow: { start, end, confirmed: true },
          requestedDays,
          availabilityMode: 'fixed-dates',
          tripScope: 'destination-only'
        },
        itinerary: {
          status: 'draft-ready',
          dateWindow: { start, end, status: 'confirmed' },
          days
        },
        dayPreferences: {},
        planner: { source: 'synthetic-demo', preferredPoiIds: [] },
        excludedCandidateKeys: []
      }
    };
  }

  function createPlanDraftDemo({ root, request, storage, confirmRestore = async () => true } = {}) {
    if (!root || typeof root.querySelector !== 'function' || !planDraftApi) {
      throw new TypeError('演示页面依赖无效');
    }
    const form = root.querySelector('#plan-draft-form');
    const destinationName = root.querySelector('#destination-name');
    const startDate = root.querySelector('#start-date');
    const endDate = root.querySelector('#end-date');
    const restoreButton = root.querySelector('#restore-draft');
    const retryPointerButton = root.querySelector('#retry-pointer');
    const status = root.querySelector('#demo-status');
    const staleNotice = root.querySelector('#dynamic-facts-stale');
    const destinationLockNotice = root.querySelector('#destination-lock-notice');
    const client = planDraftApi.createPlanDraftClient({ request, storage });
    let dirty = false;

    function setStatus(message) {
      status.textContent = message;
      status.hidden = false;
    }

    function lockDestination() {
      destinationName.disabled = true;
      destinationLockNotice.textContent = '目的地在首次保存后锁定；更换目的地需新建草稿，v1 暂不提供。';
      destinationLockNotice.hidden = false;
    }

    function markDirty() {
      dirty = true;
    }

    async function submit(event) {
      event?.preventDefault?.();
      let dto;
      try {
        dto = buildDto(destinationName.value, startDate.value, endDate.value);
      } catch (error) {
        setStatus(error.message);
        return { outcome: 'invalid-form' };
      }

      const result = await client.save(dto);
      if (result.outcome === 'saved') {
        lockDestination();
        retryPointerButton.hidden = true;
        dirty = false;
        setStatus('核心行程草稿已保存。');
      } else if (result.outcome === 'saved-pointer-failed') {
        lockDestination();
        retryPointerButton.hidden = false;
        dirty = false;
        setStatus('草稿已保存，但浏览器没有记住找回入口。请不要刷新，先重试记住入口。');
      } else if (result.outcome === 'conflict') {
        setStatus('草稿已在其他位置变化，本地输入仍保留。');
      } else if (result.outcome === 'save-in-progress') {
        setStatus('正在保存，请稍候。');
      } else {
        setStatus('保存失败，本地输入仍保留。');
      }
      return result;
    }

    function retryPointer(event) {
      event?.preventDefault?.();
      const result = client.retryPointer();
      if (result.outcome === 'pointer-saved') {
        retryPointerButton.hidden = true;
        setStatus('浏览器已记住草稿找回入口。');
      } else {
        retryPointerButton.hidden = false;
        setStatus('仍未记住找回入口，请保持页面打开后重试。');
      }
      return result;
    }

    async function restore(event) {
      event?.preventDefault?.();
      if (dirty && !await confirmRestore()) return { outcome: 'restore-cancelled' };

      const result = await client.restore();
      if (result.outcome === 'restored') {
        const seed = result.itinerarySeed;
        destinationName.value = seed.destination.name;
        startDate.value = seed.request.dateWindow.start;
        endDate.value = seed.request.dateWindow.end;
        lockDestination();
        retryPointerButton.hidden = true;
        staleNotice.textContent = '动态事实未随草稿恢复；本页不会请求天气或路线。';
        staleNotice.hidden = false;
        dirty = false;
        setStatus('核心行程草稿已恢复。');
      } else if (result.outcome === 'restore-superseded') {
        setStatus('恢复结果已过期，当前较新的草稿保持不变。');
      } else if (result.outcome === 'no-pointer') {
        setStatus('浏览器中没有可恢复的草稿入口。');
      } else if (result.outcome === 'stale-pointer' || result.outcome === 'invalid-pointer') {
        setStatus('原草稿入口已失效，请重新保存。');
      } else if (result.outcome === 'pointer-unavailable') {
        setStatus('浏览器存储不可用，暂时无法找回草稿。');
      } else if (result.outcome === 'invalid-draft') {
        setStatus('草稿格式无效，未覆盖当前输入。');
      } else {
        setStatus('恢复失败，当前输入保持不变。');
      }
      return result;
    }

    form.addEventListener('submit', submit);
    restoreButton.addEventListener('click', restore);
    retryPointerButton.addEventListener('click', retryPointer);
    destinationName.addEventListener('input', markDirty);
    startDate.addEventListener('input', markDirty);
    endDate.addEventListener('input', markDirty);

    return { submit, restore, retryPointer };
  }

  return { createPlanDraftDemo };
}));
