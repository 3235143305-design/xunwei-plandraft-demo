'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');

const { createApi, resolveListenOptions, startServer } = require('../server');

const injectedStore = Object.freeze({ kind: 'test-plan-draft-store' });
const DRAFT_ID = '00000000-0000-4000-8000-000000000001';
const storedDraft = {
  draftId: DRAFT_ID,
  draftRevision: 1,
  status: 'draft-ready',
  destination: { poiId: 'demo-poi-001', name: '演示目的地' },
  missingInputs: [],
  plan: {},
  confirmedRevision: null
};

async function invoke(api, pathname, {
  method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1'
} = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { host: '127.0.0.1:43123', ...headers };
  request.socket = { remoteAddress };
  const response = {
    writeHead(status, responseHeaders) {
      this.status = status;
      this.headers = responseHeaders;
    },
    end(value) {
      this.body = value ? JSON.parse(String(value)) : null;
    }
  };
  const url = new URL(pathname, 'http://127.0.0.1:43123');
  const handledPromise = api(request, response, url.pathname, url);
  if (body !== undefined) request.emit('data', JSON.stringify(body));
  request.emit('end');
  const handled = await handledPromise;
  return {
    handled,
    status: response.status,
    headers: response.headers || {},
    body: response.body,
    rawPathname: url.pathname
  };
}

test('listen options allow only loopback and normalize missing or zero ports', () => {
  assert.deepEqual(resolveListenOptions({}), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(resolveListenOptions({ PORT: '0' }), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(resolveListenOptions({ HOST: '127.0.0.1', PORT: '18765' }), {
    host: '127.0.0.1',
    port: 18765
  });

  for (const env of [
    { HOST: '0.0.0.0', PORT: '0' },
    { HOST: '192.0.2.10', PORT: '0' },
    { HOST: 'localhost', PORT: '0' },
    { HOST: '::1', PORT: '0' },
    { PORT: '-1' },
    { PORT: '65536' },
    { PORT: '1.5' },
    { PORT: 'not-a-port' }
  ]) {
    assert.throws(() => resolveListenOptions(env), /HOST|PORT|监听/);
  }
});

test('invalid listen configuration is rejected before a server is created', async () => {
  let createCalls = 0;
  let storeFactoryCalls = 0;
  const httpModule = {
    createServer() { createCalls += 1; throw new Error('must not create'); }
  };

  await assert.rejects(
    () => startServer({
      env: { HOST: '0.0.0.0', PORT: '18765' },
      httpModule,
      planDraftStore: injectedStore,
      planDraftStoreFactory() {
        storeFactoryCalls += 1;
        throw new Error('must not create a real store');
      }
    }),
    /HOST|监听/
  );
  assert.equal(createCalls, 0);
  assert.equal(storeFactoryCalls, 0);
});

test('a successful injected listen reports the actual OS-assigned port without creating a store', async () => {
  const server = new EventEmitter();
  const listenCalls = [];
  let storeFactoryCalls = 0;
  server.listen = (options) => {
    listenCalls.push(options);
    queueMicrotask(() => server.emit('listening'));
    return server;
  };
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 });
  const httpModule = {
    createServer(handler) {
      assert.equal(typeof handler, 'function');
      return server;
    }
  };

  const started = await startServer({
    env: { PORT: '0' },
    httpModule,
    planDraftStore: injectedStore,
    planDraftStoreFactory() {
      storeFactoryCalls += 1;
      throw new Error('must not create a real store');
    }
  });

  assert.equal(started.server, server);
  assert.equal(started.host, '127.0.0.1');
  assert.equal(started.port, 43123);
  assert.deepEqual(listenCalls, [{ host: '127.0.0.1', port: 0 }]);
  assert.equal(storeFactoryCalls, 0);
});

test('EADDRINUSE is observed through an injected server without opening a real socket or database', async () => {
  const server = new EventEmitter();
  const listenCalls = [];
  let storeFactoryCalls = 0;
  server.listen = (options) => {
    listenCalls.push(options);
    queueMicrotask(() => {
      const error = new Error('address in use');
      error.code = 'EADDRINUSE';
      server.emit('error', error);
    });
    return server;
  };
  const httpModule = {
    createServer(handler) {
      assert.equal(typeof handler, 'function');
      return server;
    }
  };

  await assert.rejects(
    () => startServer({
      env: { PORT: '0' },
      httpModule,
      planDraftStore: injectedStore,
      planDraftStoreFactory() {
        storeFactoryCalls += 1;
        throw new Error('must not create a real store');
      }
    }),
    (error) => error && error.code === 'EADDRINUSE'
  );
  assert.deepEqual(listenCalls, [{ host: '127.0.0.1', port: 0 }]);
  assert.equal(storeFactoryCalls, 0);
});

test('draft API entry rejects unsafe Host, peer, origin, content type, method, and encoded route before Store access', async () => {
  let storeFactoryCalls = 0;
  const api = createApi({
    planDraftStoreFactory() {
      storeFactoryCalls += 1;
      throw new Error('unsafe requests must not create a store');
    }
  });

  const unsafeHost = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`, {
    headers: { host: '192.0.2.10:43123' }
  });
  assert.equal(unsafeHost.status, 403);
  assert.equal(storeFactoryCalls, 0);

  const unsafePeer = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`, {
    headers: { host: '127.0.0.1:43123' },
    remoteAddress: '192.0.2.10'
  });
  assert.equal(unsafePeer.status, 403);
  assert.equal(storeFactoryCalls, 0);

  const crossOrigin = await invoke(api, '/api/plan-drafts', {
    method: 'POST',
    headers: {
      origin: 'http://example.test',
      'content-type': 'application/json'
    },
    body: {}
  });
  assert.equal(crossOrigin.status, 403);

  const nonJsonWrite = await invoke(api, '/api/plan-drafts', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: {}
  });
  assert.equal(nonJsonWrite.status, 400);

  const nullPatch = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: null
  });
  assert.equal(nullPatch.status, 400);
  assert.equal(storeFactoryCalls, 0);

  const preflight = await invoke(api, '/api/plan-drafts', {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:43123' }
  });
  assert.equal(preflight.status, 405);

  const encodedRoute = await invoke(api, `/api/plan-drafts/${DRAFT_ID}%2Fconfirm`);
  assert.match(encodedRoute.rawPathname, /%2Fconfirm$/i);
  assert.equal(encodedRoute.handled, true);
  assert.equal(encodedRoute.status, 400);
  assert.equal(storeFactoryCalls, 0);
});

test('unknown APIs do not create a Store and the first exact draft route creates only one lazy Store', async () => {
  let storeFactoryCalls = 0;
  let getCalls = 0;
  const store = {
    get(draftId) {
      getCalls += 1;
      assert.equal(draftId, DRAFT_ID);
      return storedDraft;
    }
  };
  const api = createApi({
    planDraftStoreFactory() {
      storeFactoryCalls += 1;
      return store;
    }
  });

  const unknown = await invoke(api, '/api/not-a-real-route');
  assert.equal(unknown.handled, true);
  assert.equal(unknown.status, 404);
  assert.equal(storeFactoryCalls, 0);

  const first = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`, {
    headers: { origin: 'http://127.0.0.1:43123' },
    remoteAddress: '127.0.0.1'
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, data: storedDraft });
  assert.equal(storeFactoryCalls, 1);
  assert.equal(getCalls, 1);

  const second = await invoke(api, `/api/plan-drafts/${DRAFT_ID}`);
  assert.equal(second.status, 200);
  assert.equal(storeFactoryCalls, 1);
  assert.equal(getCalls, 2);
});
