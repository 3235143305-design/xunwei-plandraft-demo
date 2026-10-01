'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { createPlanDraftStore } = require('./services/plan-draft-store');

const HOST = '127.0.0.1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_PATTERN = /^\/api\/plan-drafts\/([^/]+)$/;
const CONFIRM_PATTERN = /^\/api\/plan-drafts\/([^/]+)\/confirm$/;
const WRITE_METHODS = new Set(['POST', 'PATCH']);
const STATIC_FILES = new Map([
  ['/', ['app/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['app/index.html', 'text/html; charset=utf-8']],
  ['/api.js', ['app/api.js', 'text/javascript; charset=utf-8']],
  ['/plan-draft.js', ['app/plan-draft.js', 'text/javascript; charset=utf-8']],
  ['/plan-draft-demo.js', ['app/plan-draft-demo.js', 'text/javascript; charset=utf-8']]
]);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message });
}

function hasExactKeys(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    request.setEncoding?.('utf8');
    request.on('data', (chunk) => {
      if (settled) return;
      body += String(chunk);
      if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
        settled = true;
        body = '';
        reject(new Error('body-too-large'));
      }
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      if (!body) return reject(new Error('empty-body'));
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error('invalid-json'));
      }
    });
    request.on('error', reject);
  });
}

function isSafeHost(host) {
  if (typeof host !== 'string') return false;
  const match = /^127\.0\.0\.1(?::(\d+))?$/.exec(host);
  if (!match) return false;
  return match[1] === undefined || Number(match[1]) <= 65535;
}

function hasSafeHttpBoundary(request) {
  const host = request.headers?.host;
  if (request.socket?.remoteAddress !== HOST || !isSafeHost(host)) return false;
  if (!WRITE_METHODS.has(request.method) || !request.headers?.origin) return true;
  return request.headers.origin === `http://${host}`;
}

function isJsonWrite(request) {
  if (!WRITE_METHODS.has(request.method)) return true;
  return /^application\/json(?:\s*;|$)/i.test(request.headers?.['content-type'] || '');
}

function mapStoreError(response, error) {
  if ([400, 404, 409].includes(error?.status)) {
    sendError(response, error.status, error.message);
    return;
  }
  sendError(response, 500, '草稿存储暂不可用');
}

function createApi({
  env = process.env,
  planDraftStore,
  planDraftStoreFactory
} = {}) {
  let store = planDraftStore;
  const createStore = planDraftStoreFactory || (() => {
    const configuredPath = env.PLAN_DRAFT_DB_PATH;
    const dbPath = configuredPath
      ? path.resolve(configuredPath)
      : path.join(__dirname, 'data', 'runtime', 'plan-drafts.sqlite');
    return createPlanDraftStore({ dbPath });
  });

  function getStore() {
    if (!store) store = createStore();
    return store;
  }

  return function api(request, response, pathname, _url, context = {}) {
    const method = request.method || 'GET';
    if (pathname === '/api/health') {
      if (method !== 'GET') {
        sendError(response, 405, '请求方法不支持');
        return Promise.resolve(true);
      }
      sendJson(response, 200, { ok: true, data: { status: 'ok' } });
      return Promise.resolve(true);
    }

    if (!pathname.startsWith('/api/')) return Promise.resolve(false);
    if (!pathname.startsWith('/api/plan-drafts')) {
      sendError(response, 404, '接口不存在');
      return Promise.resolve(true);
    }

    const enforceHttpBoundary = context.enforceHttpBoundary === true
      || Boolean(request.socket || request.headers?.host);
    if (enforceHttpBoundary && /%/i.test(pathname)) {
      sendError(response, 400, '草稿路径无效');
      return Promise.resolve(true);
    }

    const itemMatch = ITEM_PATTERN.exec(pathname);
    const confirmMatch = CONFIRM_PATTERN.exec(pathname);
    const isCollection = pathname === '/api/plan-drafts';
    const exactMethod = (isCollection && method === 'POST')
      || (itemMatch && (method === 'GET' || method === 'PATCH'))
      || (confirmMatch && method === 'POST');

    if (!exactMethod) {
      if (enforceHttpBoundary) {
        const exactRoute = isCollection || itemMatch || confirmMatch;
        sendError(response, exactRoute ? 405 : 404, exactRoute ? '请求方法不支持' : '接口不存在');
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }

    const draftId = itemMatch?.[1] || confirmMatch?.[1];
    if (draftId && !UUID_PATTERN.test(draftId)) {
      sendError(response, 400, '草稿标识无效');
      return Promise.resolve(true);
    }
    if (enforceHttpBoundary && !hasSafeHttpBoundary(request)) {
      sendError(response, 403, '仅允许本机同源访问');
      return Promise.resolve(true);
    }
    if (!isJsonWrite(request)) {
      sendError(response, 400, '草稿请求必须使用 JSON');
      return Promise.resolve(true);
    }

    const run = async () => {
      try {
        if (method === 'GET') {
          sendJson(response, 200, { ok: true, data: getStore().get(draftId) });
          return true;
        }

        let body;
        try {
          body = await readJson(request);
        } catch (_) {
          sendError(response, 400, '草稿请求无效');
          return true;
        }

        if (isCollection) {
          if (!hasExactKeys(body, ['destination', 'missingInputs', 'plan'], ['destination'])) {
            sendError(response, 400, '草稿请求无效');
            return true;
          }
          sendJson(response, 201, { ok: true, data: getStore().create(body) });
          return true;
        }

        if (itemMatch) {
          const allowed = ['expectedDraftRevision', 'expectedStatus', 'missingInputs', 'plan'];
          const required = ['expectedDraftRevision', 'expectedStatus'];
          if (!hasExactKeys(body, allowed, required)) {
            sendError(response, 400, '草稿请求无效');
            return true;
          }
          const hasPatch = Object.prototype.hasOwnProperty.call(body, 'missingInputs')
            || Object.prototype.hasOwnProperty.call(body, 'plan');
          if (!hasPatch) {
            sendError(response, 400, '草稿请求无效');
            return true;
          }
          const snapshot = {
            draftRevision: body.expectedDraftRevision,
            status: body.expectedStatus
          };
          const patch = {};
          if (Object.prototype.hasOwnProperty.call(body, 'missingInputs')) patch.missingInputs = body.missingInputs;
          if (Object.prototype.hasOwnProperty.call(body, 'plan')) patch.plan = body.plan;
          sendJson(response, 200, { ok: true, data: getStore().edit(draftId, snapshot, patch) });
          return true;
        }

        if (!hasExactKeys(body, ['expectedDraftRevision', 'expectedStatus'], [
          'expectedDraftRevision', 'expectedStatus'
        ])) {
          sendError(response, 400, '草稿请求无效');
          return true;
        }
        const snapshot = {
          draftRevision: body.expectedDraftRevision,
          status: body.expectedStatus
        };
        sendJson(response, 200, { ok: true, data: getStore().confirm(draftId, snapshot) });
        return true;
      } catch (error) {
        mapStoreError(response, error);
        return true;
      }
    };

    return run();
  };
}

function resolveListenOptions(env = process.env) {
  const host = env.HOST === undefined || env.HOST === '' ? HOST : env.HOST;
  if (host !== HOST) throw new Error('HOST 仅允许 127.0.0.1 监听');
  const rawPort = env.PORT === undefined || env.PORT === '' ? '0' : String(env.PORT);
  if (!/^\d+$/.test(rawPort)) throw new Error('PORT 必须是 0 到 65535 的整数');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT 必须是 0 到 65535 的整数');
  }
  return { host, port };
}

function serveStatic(request, response, pathname, fsModule = fs) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [relativePath, contentType] = entry;
  const filePath = path.join(__dirname, relativePath);
  try {
    const content = fsModule.readFileSync(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (_) {
    sendError(response, 404, '页面不存在');
  }
  return true;
}

async function startServer({
  env = process.env,
  fsModule = fs,
  httpModule = http,
  planDraftStore,
  planDraftStoreFactory
} = {}) {
  const listenOptions = resolveListenOptions(env);
  const api = createApi({ env, planDraftStore, planDraftStoreFactory });
  const server = httpModule.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers?.host || HOST}`);
    } catch (_) {
      sendError(response, 400, '请求地址无效');
      return;
    }
    if (await api(request, response, url.pathname, url, { enforceHttpBoundary: true })) return;
    if (serveStatic(request, response, url.pathname, fsModule)) return;
    sendError(response, 404, '页面不存在');
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenOptions);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : listenOptions.port;
  return { server, host: listenOptions.host, port };
}

module.exports = { createApi, resolveListenOptions, startServer };

if (require.main === module) {
  startServer().then(({ host, port }) => {
    console.log(`寻味公开演示：http://${host}:${port}`);
  }).catch((error) => {
    console.error('寻味公开演示启动失败：', error.message);
    process.exitCode = 1;
  });
}
