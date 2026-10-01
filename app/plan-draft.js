'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PlanDraftClient = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  const ACTIVE_DRAFT_KEY = 'xunwei.planDraft.active.v1';
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const QUESTION_TEXT = {
    'travel-context-required': '请填写这次准备玩几天。',
    'date-window-required': '请选择适合的出行时间；若暂不设置，请填写出发和返程日期。',
    'requested-days-invalid': '天数需要是 1 至 8 之间的整数。',
    'days-outside-current-range': '当前测试阶段支持 1 至 8 天，请调整后重试。',
    'date-window-invalid': '请检查出发和返程日期。',
    'date-window-conflicts-with-requested-days': '日期范围与天数不一致，请保留其中一种填写方式。'
  };
  const DESTINATION_FIELDS = ['poiId', 'name', 'shortName', 'province', 'city', 'district', 'adcode'];
  const PLAN_FIELDS = [
    'schemaVersion', 'origin', 'request', 'itinerary', 'dayPreferences', 'planner', 'excludedCandidateKeys'
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function exactKeys(value, expected) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join('|') === [...expected].sort().join('|');
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function placeSummary(place, required, strict = false) {
    if (place == null && !required) return null;
    if (!place || typeof place !== 'object' || !text(place.poiId) || !text(place.name)) {
      throw new TypeError('无效的草稿数据');
    }
    if (strict && Object.keys(place).some(field => !DESTINATION_FIELDS.includes(field))) {
      throw new TypeError('无效的草稿数据');
    }
    return Object.fromEntries(DESTINATION_FIELDS.map(field => [field, text(place[field])]).filter(([, value]) => value));
  }

  function dateWindow(value, statusField, strict = false) {
    if (value == null) return null;
    if (strict && !exactKeys(value, ['start', 'end', statusField])) throw new TypeError('无效的草稿数据');
    const status = value[statusField];
    if (!validDate(value.start) || !validDate(value.end) || value.start > value.end) {
      throw new TypeError('无效的草稿数据');
    }
    const result = { start: value.start, end: value.end };
    if (statusField === 'confirmed') {
      if (typeof status !== 'boolean') throw new TypeError('无效的草稿数据');
      result.confirmed = status;
    } else {
      if (!text(status)) throw new TypeError('无效的草稿数据');
      result.status = text(status);
    }
    return result;
  }

  function projectedPreferences(value, strict = false) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('无效的草稿数据');
    const result = {};
    for (const [date, preference] of Object.entries(value)) {
      if (!validDate(date) || !preference || typeof preference !== 'object'
        || (strict && !exactKeys(preference, ['departurePeriod', 'departureTime', 'pace', 'indoorPreferred']))) {
        throw new TypeError('无效的草稿数据');
      }
      result[date] = {
        departurePeriod: text(preference.departurePeriod) || 'unset',
        departureTime: text(preference.departureTime),
        pace: preference.pace === 'easy' ? 'easy' : 'normal',
        indoorPreferred: Boolean(preference.indoorPreferred)
      };
    }
    return result;
  }

  function uniqueText(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
  }

  function placeCity(place) {
    return text(place && (place.city || place.district || place.name)).replace(/市$/, '');
  }

  function isCrossCity(itinerary) {
    const originCity = placeCity(itinerary && itinerary.origin);
    const destinationCity = placeCity(itinerary && itinerary.destination);
    return Boolean(originCity && destinationCity && originCity !== destinationCity);
  }

  function projectedQuestions(plan) {
    return (Array.isArray(plan && plan.questions) ? plan.questions : []).map(item => {
      const code = text(item && item.code);
      return {
        code,
        question: code ? QUESTION_TEXT[code] || '请补充这次出行的必要信息。' : ''
      };
    }).filter(item => item.code);
  }

  function hasConfirmedTicketConflict(itinerary, planDates) {
    const confirmed = itinerary && itinerary.ticketImport && itinerary.ticketImport.confirmed;
    return Object.values(confirmed || {}).some(journey => journey && Array.isArray(journey.travelDates)
      && journey.travelDates.some(date => !planDates.has(date)));
  }

  function projectPlanDraft(itinerary) {
    if (!itinerary || typeof itinerary !== 'object') throw new TypeError('无效的草稿数据');
    const sourcePlan = itinerary.plan;
    if (!sourcePlan || typeof sourcePlan !== 'object' || !Array.isArray(sourcePlan.days)) {
      throw new TypeError('无效的草稿数据');
    }
    const days = sourcePlan.days.map(day => {
      if (!Number.isInteger(day && day.number) || day.number < 1 || !validDate(day.date)) {
        throw new TypeError('无效的草稿数据');
      }
      return { number: day.number, date: day.date };
    });
    const request = itinerary.request || {};
    const missingInputs = projectedQuestions(sourcePlan);
    if (request.tripScope === 'unset' && isCrossCity(itinerary)) missingInputs.push({
      code: 'trip-scope-required', question: '请选择这些天是否包含去返程。'
    });
    if (hasConfirmedTicketConflict(itinerary, new Set(days.map(day => day.date)))) missingInputs.push({
      code: 'ticket-date-conflict', question: '票据日期与当前行程不一致，请按票据日期重新计算行程。'
    });

    return clone({
      destination: placeSummary(itinerary.destination, true),
      missingInputs,
      plan: {
        schemaVersion: 1,
        origin: placeSummary(itinerary.origin, false),
        request: {
          dateWindow: dateWindow(request.dateWindow, 'confirmed'),
          requestedDays: request.requestedDays == null ? null : request.requestedDays,
          availabilityMode: text(request.availabilityMode) || 'unset',
          tripScope: text(request.tripScope) || 'unset'
        },
        itinerary: {
          status: text(sourcePlan.status),
          dateWindow: dateWindow(sourcePlan.dateWindow, 'status'),
          days
        },
        dayPreferences: projectedPreferences(itinerary.datePreferences),
        planner: {
          source: text(itinerary.aiSource) || 'none',
          preferredPoiIds: uniqueText(itinerary.preferredPoiIds)
        },
        excludedCandidateKeys: uniqueText(itinerary.excludedKeys)
      }
    });
  }

  function validateDto(dto) {
    if (!exactKeys(dto, ['destination', 'missingInputs', 'plan'])) throw new TypeError('无效的草稿数据');
    placeSummary(dto.destination, true, true);
    if (!Array.isArray(dto.missingInputs) || dto.missingInputs.some(item => !exactKeys(item, ['code', 'question'])
      || !text(item.code) || !text(item.question))) throw new TypeError('无效的草稿数据');
    if (!dto.plan || dto.plan.schemaVersion !== 1) {
      if (dto.plan && Object.prototype.hasOwnProperty.call(dto.plan, 'schemaVersion')) {
        throw new TypeError('不支持的草稿版本');
      }
      throw new TypeError('无效的草稿数据');
    }
    if (!exactKeys(dto.plan, PLAN_FIELDS)) throw new TypeError('无效的草稿数据');
    placeSummary(dto.plan.origin, false, true);
    const request = dto.plan.request;
    if (!exactKeys(request, ['dateWindow', 'requestedDays', 'availabilityMode', 'tripScope'])
      || (request.requestedDays != null && (!Number.isInteger(request.requestedDays) || request.requestedDays < 1))
      || !text(request.availabilityMode) || !text(request.tripScope)) throw new TypeError('无效的草稿数据');
    dateWindow(request.dateWindow, 'confirmed', true);
    const itinerary = dto.plan.itinerary;
    if (!exactKeys(itinerary, ['status', 'dateWindow', 'days']) || !text(itinerary.status)
      || !Array.isArray(itinerary.days) || itinerary.days.some(day => !exactKeys(day, ['number', 'date'])
        || !Number.isInteger(day.number) || day.number < 1 || !validDate(day.date))) {
      throw new TypeError('无效的草稿数据');
    }
    dateWindow(itinerary.dateWindow, 'status', true);
    projectedPreferences(dto.plan.dayPreferences, true);
    if (!exactKeys(dto.plan.planner, ['source', 'preferredPoiIds']) || !text(dto.plan.planner.source)
      || !Array.isArray(dto.plan.planner.preferredPoiIds)
      || dto.plan.planner.preferredPoiIds.some(value => !text(value))
      || !Array.isArray(dto.plan.excludedCandidateKeys)
      || dto.plan.excludedCandidateKeys.some(value => !text(value))) throw new TypeError('无效的草稿数据');
    return clone(dto);
  }

  function validateServerDraft(draft) {
    if (!draft || !UUID_PATTERN.test(draft.draftId) || !Number.isInteger(draft.draftRevision)
      || draft.draftRevision < 1 || !['needs-input', 'draft-ready', 'confirmed'].includes(draft.status)) {
      throw new TypeError('无效的草稿数据');
    }
    validateDto({ destination: draft.destination, missingInputs: draft.missingInputs, plan: draft.plan });
    return clone(draft);
  }

  function restorePlanDraft(input) {
    const draft = validateServerDraft(input);
    const dto = validateDto({ destination: draft.destination, missingInputs: draft.missingInputs, plan: draft.plan });
    return {
      draft,
      itinerarySeed: clone({
        destination: dto.destination,
        origin: dto.plan.origin,
        request: { ...dto.plan.request, travel: { durationSeconds: null, distanceMeters: null } },
        plan: dto.plan.itinerary,
        datePreferences: dto.plan.dayPreferences,
        aiSource: dto.plan.planner.source,
        destinationPoiId: dto.destination.poiId,
        preferredPoiIds: dto.plan.planner.preferredPoiIds,
        excludedKeys: dto.plan.excludedCandidateKeys
      }),
      dynamicFactsStale: true
    };
  }

  function createPlanDraftClient(options = {}) {
    const { request, storage } = options;
    if (Object.prototype.hasOwnProperty.call(options, 'baseUrl')) {
      throw new TypeError('PlanDraft 仅支持本机同源相对路径');
    }
    if (typeof request !== 'function' || !storage || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throw new TypeError('PlanDraft 客户端依赖无效');
    }
    let activeDraft = null;
    let activeDraftGeneration = 0;
    let saveInProgress = false;

    function useDraft(draft) {
      activeDraft = validateServerDraft(draft);
      activeDraftGeneration += 1;
      return clone(activeDraft);
    }

    function currentDraft() {
      return activeDraft ? clone(activeDraft) : null;
    }

    function writePointer() {
      if (!activeDraft) return { outcome: 'pointer-unavailable' };
      try {
        storage.setItem(ACTIVE_DRAFT_KEY, activeDraft.draftId);
        return { outcome: 'pointer-saved', draft: clone(activeDraft) };
      } catch (_) {
        return { outcome: 'saved-pointer-failed', draft: clone(activeDraft) };
      }
    }

    async function save(input) {
      const pendingDto = validateDto(input);
      if (saveInProgress) return { outcome: 'save-in-progress', pendingDto: clone(pendingDto) };
      saveInProgress = true;
      const snapshot = activeDraft ? clone(activeDraft) : null;
      const path = snapshot ? `/api/plan-drafts/${snapshot.draftId}` : '/api/plan-drafts';
      const body = snapshot ? {
        expectedDraftRevision: snapshot.draftRevision,
        expectedStatus: snapshot.status,
        missingInputs: pendingDto.missingInputs,
        plan: pendingDto.plan
      } : pendingDto;
      try {
        const response = await request(path, {
          method: snapshot ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const saved = validateServerDraft(response);
        activeDraft = saved;
        activeDraftGeneration += 1;
        if (!snapshot) {
          const pointer = writePointer();
          if (pointer.outcome !== 'pointer-saved') return pointer;
        }
        return { outcome: 'saved', draft: clone(saved) };
      } catch (error) {
        if (snapshot && error && error.status === 409) {
          let remoteDraft = null;
          try {
            remoteDraft = validateServerDraft(
              await request(`/api/plan-drafts/${snapshot.draftId}`, { method: 'GET' })
            );
          } catch (_) {}
          activeDraft = snapshot;
          return { outcome: 'conflict', pendingDto: clone(pendingDto), remoteDraft: clone(remoteDraft) };
        }
        activeDraft = snapshot;
        return { outcome: 'save-failed', pendingDto: clone(pendingDto) };
      } finally {
        saveInProgress = false;
      }
    }

    async function restore() {
      let draftId;
      try {
        draftId = storage.getItem(ACTIVE_DRAFT_KEY);
      } catch (_) {
        return { outcome: 'pointer-unavailable' };
      }
      if (draftId == null || draftId === '') return { outcome: 'no-pointer' };
      if (!UUID_PATTERN.test(draftId)) {
        try { storage.removeItem(ACTIVE_DRAFT_KEY); } catch (_) {}
        return { outcome: 'invalid-pointer' };
      }
      const restoreGeneration = activeDraftGeneration;
      let response;
      try {
        response = await request(`/api/plan-drafts/${draftId}`, { method: 'GET' });
      } catch (error) {
        if (error && error.status === 404) {
          if (activeDraftGeneration !== restoreGeneration) {
            return { outcome: 'restore-superseded' };
          }
          try { storage.removeItem(ACTIVE_DRAFT_KEY); } catch (_) {}
          return { outcome: 'stale-pointer' };
        }
        return { outcome: 'restore-failed' };
      }
      try {
        const restored = restorePlanDraft(response);
        if (activeDraftGeneration !== restoreGeneration) {
          return { outcome: 'restore-superseded' };
        }
        activeDraft = clone(restored.draft);
        activeDraftGeneration += 1;
        return { outcome: 'restored', ...restored };
      } catch (_) {
        return { outcome: 'invalid-draft' };
      }
    }

    return { save, restore, retryPointer: writePointer, useDraft, currentDraft };
  }

  return { ACTIVE_DRAFT_KEY, createPlanDraftClient, projectPlanDraft, restorePlanDraft };
}));
