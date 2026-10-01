'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');

const { createApi } = require('../server');

async function invoke(api, pathname) {
  const request = new EventEmitter();
  request.method = 'GET';
  request.headers = {};
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.body = value ? JSON.parse(String(value)) : null; }
  };
  const url = new URL(pathname, 'http://127.0.0.1');
  const handled = await api(request, response, url.pathname, url);
  return { handled, status: response.status, headers: response.headers || {}, body: response.body };
}

test('health runs in-process and never constructs the PlanDraft database', async () => {
  let storeFactoryCalls = 0;
  let envAccesses = 0;
  let fileSystemAccesses = 0;
  const env = new Proxy({}, {
    get() { envAccesses += 1; throw new Error('health must not read environment values'); },
    has() { envAccesses += 1; throw new Error('health must not inspect environment values'); },
    ownKeys() { envAccesses += 1; throw new Error('health must not enumerate environment values'); }
  });
  const fsModule = new Proxy({}, {
    get() { fileSystemAccesses += 1; throw new Error('health must not read key files'); },
    has() { fileSystemAccesses += 1; throw new Error('health must not inspect key files'); },
    ownKeys() { fileSystemAccesses += 1; throw new Error('health must not enumerate key files'); }
  });
  const api = createApi({
    env,
    fsModule,
    planDraftStoreFactory() {
      storeFactoryCalls += 1;
      throw new Error('health must not create a database');
    }
  });

  const response = await invoke(api, '/api/health');

  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, data: { status: 'ok' } });
  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(storeFactoryCalls, 0);
  assert.equal(envAccesses, 0);
  assert.equal(fileSystemAccesses, 0);
});
