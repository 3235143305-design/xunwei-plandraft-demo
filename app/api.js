'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XunweiApi = api;
}(typeof window === 'undefined' ? globalThis : window, function (root) {
  function publicError(message, status) {
    const error = new Error(message);
    if (Number.isInteger(status)) error.status = status;
    return error;
  }

  function assertApiPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) {
      throw new TypeError('仅支持同源 /api/ 相对路径');
    }
  }

  function createSameOriginRequest({ fetchImpl } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('缺少可用的 fetch 实现');

    return async function request(path, options = {}) {
      assertApiPath(path);

      let response;
      try {
        response = await fetchImpl(path, options);
      } catch (_) {
        throw publicError('网络请求失败');
      }

      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        throw publicError(
          '服务响应格式无效',
          response && response.ok === false ? response.status : undefined
        );
      }

      if (!response || response.ok !== true) {
        throw publicError('服务暂不可用', response && response.status);
      }
      if (!payload || typeof payload !== 'object' || payload.ok !== true
        || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
        throw publicError(payload && payload.ok === false ? '请求失败' : '服务响应格式无效');
      }
      return payload.data;
    };
  }

  async function apiFetch(path, options) {
    if (!root || typeof root.fetch !== 'function') throw publicError('当前环境不支持网络请求');
    const request = createSameOriginRequest({ fetchImpl: root.fetch.bind(root) });
    return request(path, options);
  }

  return { createSameOriginRequest, apiFetch };
}));
