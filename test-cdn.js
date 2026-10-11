const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(path.join(__dirname, 'js/background.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, 'js/config.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const cdnUrl = 'https://cdn.nlark.com/yuque/0/2026/png/123/example.png';
const tests = [];
function test(name, run) { tests.push({ name, run }); }

// Load the entire service worker so helper dependencies and message routing are
// exercised together. Network and Chrome APIs are the only boundaries replaced.
function harness(options = {}) {
  const calls = { fetches: [], scripts: [], queries: [], creates: [], permissions: [] };
  let onMessage;
  let context;
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { onMessage = listener; } },
      onInstalled: { addListener() {} },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: {
      async query(query) {
        calls.queries.push(query);
        return options.tabs || [{ id: 42, url: 'https://www.yuque.com/book/doc', active: true }];
      },
      async create(request) {
        calls.creates.push(request);
        throw new Error('Image fetching must not open tabs');
      },
    },
    scripting: {
      async executeScript(request) {
        calls.scripts.push(request);
        if (options.scriptError) throw new Error(options.scriptError);
        return [{ result: options.pageResult || { ok: true, status: 200, mime: 'image/png', b64: 'cGFnZQ==' } }];
      },
    },
    permissions: {
      async contains(request) {
        calls.permissions.push(request);
        if (options.permissionError) throw new Error(options.permissionError);
        return options.hasPermission !== false;
      },
    },
  };
  context = vm.createContext({
    chrome, URL, AbortController, TextDecoder, Uint8Array, performance,
    setTimeout, clearTimeout, console,
    btoa: (input) => Buffer.from(input, 'binary').toString('base64'),
    importScripts(file) {
      assert.equal(file, 'config.js');
      vm.runInContext(configSource, context, { filename: 'js/config.js' });
    },
    async fetch(url, request) {
      calls.fetches.push({ url, request });
      if (options.fetchError) throw new TypeError(options.fetchError);
      return new Response(options.body || 'image-bytes', {
        status: options.status || 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  vm.runInContext(backgroundSource, context, { filename: 'js/background.js' });
  return {
    calls,
    run(code) { return vm.runInContext(code, context); },
    message(url, limitKbps = 0, type = 'PAGE_FETCH_BIN') {
      return new Promise((resolve) => {
        assert.equal(onMessage({ type, url, limitKbps }, {}, resolve), true);
      });
    },
  };
}

function assertNoPageAccess(h) {
  assert.equal(h.calls.queries.length, 0, 'external images do not search Yuque tabs');
  assert.equal(h.calls.scripts.length, 0, 'external images do not inject page scripts');
  assert.equal(h.calls.creates.length, 0, 'external images do not open tabs');
}

test('manifest allows the exact Yuque CDN origin', () => {
  assert.ok(manifest.host_permissions.includes('https://cdn.nlark.com/*'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.host_permissions.includes('https://*.nlark.com/*'));
  assert.ok(manifest.content_scripts.every((script) => !script.matches.some((pattern) => pattern.includes('nlark.com'))));
});

test('CDN images download in the service worker without any Yuque tab', async () => {
  const h = harness({ tabs: [] });
  const result = await h.message(cdnUrl);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.mime, 'image/png');
  assert.equal(Buffer.from(result.b64, 'base64').toString(), 'image-bytes');
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].url, cdnUrl);
  assertNoPageAccess(h);
});

test('CORS-enabled external images may succeed without host permission', async () => {
  const h = harness({ hasPermission: false });
  assert.equal((await h.message('https://images.example.com/a.png')).ok, true);
  assert.equal(h.calls.fetches.length, 1);
  assertNoPageAccess(h);
});

test('HTTP external images also use the worker route', async () => {
  const h = harness();
  assert.equal((await h.message('http://images.example.com/a.png')).ok, true);
  assert.equal(h.calls.fetches.length, 1);
  assertNoPageAccess(h);
});

test('a hostname that merely contains yuque.com remains an external origin', async () => {
  const h = harness();
  assert.equal((await h.message('https://yuque.com.example.net/a.png')).ok, true);
  assertNoPageAccess(h);
});

test('Yuque images retain page-first fetching and the speed-limit argument', async () => {
  const h = harness();
  const result = await h.message('https://www.yuque.com/attachments/a.png', 125);
  assert.equal(result.b64, 'cGFnZQ==');
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.calls.scripts[0].world, 'MAIN');
  assert.equal(h.calls.scripts[0].args[1], true);
  assert.equal(h.calls.scripts[0].args[3], 125 * 1024);
  assert.equal(h.calls.fetches.length, 0);
});

test('the bare Yuque hostname retains page-first fetching', async () => {
  const h = harness({ tabs: [{ id: 10, url: 'https://yuque.com/book/doc' }] });
  assert.equal((await h.message('https://yuque.com/attachments/a.png')).b64, 'cGFnZQ==');
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.calls.fetches.length, 0);
});

test('a failed Yuque page fetch falls back to the service worker', async () => {
  const h = harness({ pageResult: { ok: false, status: 403, error: 'HTTP 403' } });
  const result = await h.message('https://www.yuque.com/attachments/a.png');
  assert.equal(result.ok, true);
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.calls.fetches.length, 1);
});

test('a missing Yuque tab can fall back without opening a new tab', async () => {
  const h = harness({ tabs: [] });
  assert.equal((await h.message('https://www.yuque.com/attachments/a.png')).ok, true);
  assert.equal(h.calls.creates.length, 0);
  assert.equal(h.calls.fetches.length, 1);
});

test('missing CDN permission names the host and extension reload action', async () => {
  const h = harness({ hasPermission: false, fetchError: 'Failed to fetch' });
  const result = await h.message(cdnUrl);
  assert.equal(result.ok, false);
  assert.match(result.error, /cdn\.nlark\.com/);
  assert.match(result.error, /权限|允许访问/);
  assert.match(result.error, /重新加载/);
  assert.doesNotMatch(result.error, /没有打开|语雀文档页/);
  assert.equal(h.calls.permissions.length, 1);
  assert.deepEqual(Array.from(h.calls.permissions[0].origins), ['https://cdn.nlark.com/*']);
  assertNoPageAccess(h);
});

test('network failure with permission gives network or resource diagnostics', async () => {
  const h = harness({ hasPermission: true, fetchError: 'Failed to fetch' });
  const result = await h.message(cdnUrl);
  assert.equal(result.ok, false);
  assert.match(result.error, /Failed to fetch/);
  assert.match(result.error, /网络|代理|资源/);
  assert.doesNotMatch(result.error, /没有打开|语雀文档页/);
  assertNoPageAccess(h);
});

test('an unsupported external host names its missing permission', async () => {
  const h = harness({ hasPermission: false, fetchError: 'Failed to fetch' });
  const result = await h.message('https://images.example.com/a.png');
  assert.equal(result.ok, false);
  assert.match(result.error, /images\.example\.com/);
  assert.match(result.error, /未获扩展访问权限/);
  assert.match(result.error, /Failed to fetch/);
  assertNoPageAccess(h);
});

test('invalid and non-HTTP URLs fail before fetching or looking for tabs', async () => {
  for (const url of ['not a URL', 'file:///tmp/image.png', 'data:image/png;base64,eA==']) {
    const h = harness();
    const result = await h.message(url);
    assert.equal(result.ok, false);
    assert.match(result.error, /URL 无效|HTTP\(S\)/);
    assert.equal(h.calls.fetches.length, 0);
    assertNoPageAccess(h);
  }
});

test('document text requests retain the page fetch route', async () => {
  const h = harness({ pageResult: { ok: true, status: 200, mime: 'text/markdown', text: '# Document' } });
  const result = await h.message('https://www.yuque.com/book/doc/markdown', 50, 'PAGE_FETCH');
  assert.equal(result.ok, true);
  assert.equal(result.text, '# Document');
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.calls.scripts[0].args[1], false);
  assert.equal(h.calls.scripts[0].args[3], 50 * 1024);
});

for (const status of [403, 404]) {
  test(`HTTP ${status} remains visible even without host permission`, async () => {
    const h = harness({ hasPermission: false, status });
    const result = await h.message(cdnUrl);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.error, /没有打开|语雀文档页/);
    assertNoPageAccess(h);
  });
}

test('worker image fetching still throttles one KiB at one KiB per second', async () => {
  const h = harness({ body: 'x'.repeat(1024) });
  const started = performance.now();
  const result = await h.message(cdnUrl, 1);
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.b64, 'base64').length, 1024);
  assert.ok(performance.now() - started >= 850, 'one KiB at one KiB/s should take about one second');
  assertNoPageAccess(h);
});

test('permission diagnostic failures preserve the original fetch failure', async () => {
  const h = harness({ permissionError: 'permission service unavailable', fetchError: 'Failed to fetch' });
  const result = await h.message(cdnUrl);
  assert.equal(result.ok, false);
  assert.match(result.error, /Failed to fetch/);
  assert.doesNotMatch(result.error, /没有打开|语雀文档页/);
});

async function main() {
  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
  console.log(`${tests.length} CDN fetch tests passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
