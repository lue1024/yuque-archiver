const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const nodes = new Map();
const document = {
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '0', checked: true, textContent: '',
      addEventListener() {}, appendChild() {},
    });
    return nodes.get(id);
  },
};
let downloadItems = [];
const chrome = {
  tabs: { query: async () => [] },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  downloads: { search: (_query, callback) => callback(downloadItems) },
  runtime: { lastError: null },
};
const context = vm.createContext({ document, chrome, URL, setTimeout, clearTimeout, console });
vm.runInContext(fs.readFileSync('js/config.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('sidepanel.js', 'utf8'), context);

async function main() {
  const path = '知识库/分组/文档.md';
  downloadItems = [{ filename: 'C:\\Users\\test\\Downloads\\知识库\\分组\\文档.md',
    state: 'complete', exists: true }];
  assert.equal(await vm.runInContext(`fileExists(${JSON.stringify(path)})`, context), true);
  downloadItems[0].exists = false;
  assert.equal(await vm.runInContext(`fileExists(${JSON.stringify(path)})`, context), false);

  context.localDir = {
    name: 'Downloads',
    async getDirectoryHandle(name) {
      assert.ok(['知识库', '分组'].includes(name));
      return this;
    },
    async getFileHandle(name) {
      assert.equal(name, '文档.md');
      return { getFile: async () => ({ size: 12 }) };
    },
  };
  vm.runInContext('downloadDir = localDir', context);
  assert.equal(await vm.runInContext(`fileExists(${JSON.stringify(path)})`, context), true);

  const same = vm.runInContext(`(() => {
    const used = new Map();
    return [assetFileName('https://example.com/a.png', used),
      assetFileName('https://example.com/a.png', used),
      assetFileName('https://another.example/a.png', used)];
  })()`, context);
  assert.equal(same[0], same[1]);
  assert.notEqual(same[0], same[2]);
  const reverse = vm.runInContext(`(() => {
    const used = new Map();
    return [assetFileName('https://another.example/a.png', used),
      assetFileName('https://example.com/a.png', used)];
  })()`, context);
  assert.equal(same[0], reverse[1], 'asset filenames must stay stable across batches');
  assert.equal(same[2], reverse[0]);

  vm.runInContext('downloadDir = null; savedThisRun.clear()', context);
  downloadItems = [];
  context.saveCount = 0;
  const stats = { skipped: 0, skipExisting: true };
  context.stats = stats;
  const first = vm.runInContext(`saveIfMissing('知识库/new.md', async () => { saveCount++ }, stats)`, context);
  const second = vm.runInContext(`saveIfMissing('知识库/new.md', async () => { saveCount++ }, stats)`, context);
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(context.saveCount, 1);
  assert.equal(stats.skipped, 1);

  let changeListener;
  chrome.downloads.onChanged = {
    addListener(listener) { changeListener = listener; },
    removeListener(listener) { if (changeListener === listener) changeListener = null; },
  };
  chrome.downloads.download = (_options, callback) => {
    callback(7);
    setTimeout(() => changeListener?.({ id: 7, state: { current: 'complete' } }), 30);
  };
  const downloadStarted = performance.now();
  await vm.runInContext("chromeDownload({ url: 'blob:test', filename: 'test.md' })", context);
  assert.ok(performance.now() - downloadStarted >= 20, 'wait for completed download event');

  const background = fs.readFileSync('js/background.js', 'utf8');
  const fetchCode = background.slice(background.indexOf('async function pageFetch('),
    background.indexOf('async function fetchViaPage('));
  const fetchContext = vm.createContext({
    fetch: async () => new Response('x'.repeat(1024)),
    Response, AbortController, TextDecoder, performance, setTimeout, clearTimeout,
    Uint8Array,
  });
  vm.runInContext(fetchCode, fetchContext);
  const started = performance.now();
  const result = await vm.runInContext("pageFetch('https://example.com/test', false, 60000, 1024)", fetchContext);
  assert.equal(result.ok, true);
  assert.equal(result.text.length, 1024);
  assert.ok(performance.now() - started >= 850, '1 KB at 1 KB/s should take about one second');
  const binaryCode = background.slice(background.indexOf('async function fetchBinary('),
    background.indexOf('/** 通过 content script'));
  const binaryContext = vm.createContext({
    URL,
    chrome: { permissions: { contains: async () => true } },
    YQ_CFG: { timeoutMs: 60000 },
    fetchViaPage: async () => { throw new Error('no same-host tab'); },
    pageFetch: async (...args) => { binaryContext.fetchArgs = args; return { ok: true, b64: 'eA==' }; },
  });
  vm.runInContext(binaryCode, binaryContext);
  const binary = await vm.runInContext("fetchBinary('https://cdn.example.com/a.png', 100)", binaryContext);
  assert.equal(binary.b64, 'eA==');
  assert.equal(binaryContext.fetchArgs[3], 100 * 1024, 'direct binary fetch keeps the speed limit');
  binaryContext.pageFetch = async () => ({ ok: false, error: 'CORS blocked' });
  await assert.rejects(vm.runInContext("fetchBinary('https://cdn.example.com/a.png', 100)", binaryContext), /CORS blocked/);
  console.log('download dedup tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
