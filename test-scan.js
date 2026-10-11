const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelSource = fs.readFileSync(path.join(__dirname, 'sidepanel.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, 'js/config.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, 'js/content.js'), 'utf8');
const bookHref = 'https://www.yuque.com/hacktwo/dtdx2v';
const page = { origin: 'https://www.yuque.com', segments: ['hacktwo', 'dtdx2v'] };
const domResponse = {
  ok: true, href: bookHref,
  nodes: [
    { title: '第一篇', url: '/hacktwo/dtdx2v/one', depth: 0 },
    { title: '第二篇', url: '/hacktwo/dtdx2v/two', depth: 1 },
  ],
};

function element() {
  return {
    value: '0', checked: true, disabled: false, hidden: true, textContent: '',
    style: {}, dataset: {}, children: [], listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    appendChild(child) { this.children.push(child); return child; },
    querySelectorAll() { return []; },
  };
}

function panelHarness(options = {}) {
  const nodes = new Map();
  const calls = { messages: [], scripts: [], fetches: [] };
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createTextNode(text) { return { textContent: text }; },
    createDocumentFragment: element,
  };
  const responses = [...(options.responses || [{ response: domResponse }])];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.fetches.push(message);
        callback(options.fetchResponse || { ok: true, text: '<script>window.appData = {"book":{"name":"测试"}}</script>' });
      },
    },
    tabs: {
      query: async () => [{ id: 42, url: options.tabHref || bookHref }],
      sendMessage(tabId, message, callback) {
        calls.messages.push({ tabId, message });
        const result = responses.shift();
        assert.ok(result, 'unexpected extra tab message');
        chrome.runtime.lastError = result.error ? { message: result.error } : null;
        try { callback(result.response); }
        finally { chrome.runtime.lastError = null; }
      },
    },
    scripting: {
      async executeScript(request) {
        calls.scripts.push(request);
        if (request.files) {
          if (options.injectError) throw new Error(options.injectError);
          return [];
        }
        if (options.liveError) throw new Error(options.liveError);
        const mainContext = vm.createContext({
          window: options.liveWindow || {},
          location: { href: options.liveHref || options.tabHref || bookHref },
          document: { title: '测试知识库 · 语雀' },
        });
        return [{ result: vm.runInContext(`(${request.func.toString()})()`, mainContext) }];
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const context = vm.createContext({
    document, chrome, URL, console, setTimeout, clearTimeout,
    window: {}, fetch() { throw new Error('Tests must not access the network'); },
  });
  vm.runInContext(configSource, context, { filename: 'js/config.js' });
  vm.runInContext(panelSource, context, { filename: 'sidepanel.js' });
  return {
    context, calls, nodes,
    run(code) { return vm.runInContext(code, context); },
    logs() { return nodes.get('log')?.children.map((line) => line.textContent).join('\n') || ''; },
  };
}

function assertButtonsRestored(harness, exportEnabled) {
  assert.equal(harness.nodes.get('scanBtn').disabled, false);
  assert.equal(harness.nodes.get('scrapeBtn').disabled, false);
  assert.equal(harness.nodes.get('exportBtn').disabled, !exportEnabled);
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('missing receiver injects content.js exactly once and retries the original tab', async () => {
  const h = panelHarness({ responses: [
    { error: 'Could not establish connection. Receiving end does not exist.' },
    { response: domResponse },
  ] });
  const result = await h.run('readSidebarToc(42)');
  assert.equal(result, domResponse);
  assert.equal(h.calls.messages.length, 2);
  assert.equal(h.calls.scripts.length, 1);
  assert.deepEqual(Array.from(h.calls.scripts[0].files), ['js/content.js']);
  assert.equal(h.calls.scripts[0].target.tabId, 42);
  for (const request of h.calls.messages) {
    assert.equal(request.tabId, 42);
    assert.equal(request.message.type, 'SCRAPE_TOC');
  }
});

test('connected content script returns directly without injection', async () => {
  const h = panelHarness();
  assert.equal(await h.run('readSidebarToc(42)'), domResponse);
  assert.equal(h.calls.messages.length, 1);
  assert.equal(h.calls.scripts.length, 0);
});

test('a valid negative response does not trigger reinjection', async () => {
  const response = { ok: false, error: '请先展开知识库目录' };
  const h = panelHarness({ responses: [{ response }] });
  assert.equal(await h.run('readSidebarToc(42)'), response);
  assert.equal(h.calls.scripts.length, 0);
});

test('injection permission error gives a refresh and site permission hint', async () => {
  const h = panelHarness({
    responses: [{ error: 'Could not establish connection. Receiving end does not exist.' }],
    injectError: 'Cannot access contents of the page. Extension manifest must request permission.',
  });
  await assert.rejects(h.run('readSidebarToc(42)'), (error) => {
    assert.match(error.message, /Cannot access contents/);
    assert.match(error.message, /刷新当前语雀标签页/);
    assert.match(error.message, /站点访问权限/);
    return true;
  });
  assert.equal(h.calls.messages.length, 1);
  assert.equal(h.calls.scripts.length, 1);
});

test('non-connection messaging errors are preserved without injection', async () => {
  const error = 'No tab with id: 42.';
  const h = panelHarness({ responses: [{ error }] });
  await assert.rejects(h.run('readSidebarToc(42)'), { message: error });
  assert.equal(h.calls.messages.length, 1);
  assert.equal(h.calls.scripts.length, 0);
});

test('an unanswered message recovers once and a failed retry does not loop', async () => {
  const h = panelHarness({ responses: [
    {}, { error: 'Could not establish connection. Receiving end does not exist.' },
  ] });
  await assert.rejects(h.run('readSidebarToc(42)'), /无法连接页面读取脚本/);
  assert.equal(h.calls.messages.length, 2);
  assert.equal(h.calls.scripts.length, 1);
});

test('book validation accepts documents in the same book and rejects other origins or books', () => {
  const h = panelHarness();
  h.context.expectedPage = page;
  for (const href of [bookHref, `${bookHref}/one?x=1#heading`, `${bookHref}/`]) {
    h.context.checkedHref = href;
    assert.equal(h.run('sameBookPage(checkedHref, expectedPage)'), true, href);
  }
  for (const href of [
    'https://www.yuque.com/hacktwo/another/one',
    'https://www.yuque.com/another/dtdx2v/one',
    'https://evil.example/hacktwo/dtdx2v',
    'https://www.yuque.com.evil.example/hacktwo/dtdx2v',
    'not a URL',
  ]) {
    h.context.checkedHref = href;
    assert.equal(h.run('sameBookPage(checkedHref, expectedPage)'), false, href);
  }
});

test('live page extraction runs in MAIN and handles object, JSON string, and cyclic data', async () => {
  const cyclic = { book: { name: '测试知识库', id: 123, slug: 'dtdx2v' } };
  cyclic.self = cyclic;
  const toc = [{ title: '第一篇', slug: 'one' }, { title: '第二篇', slug: 'two' }];
  const h = panelHarness({ liveWindow: {
    appData: cyclic,
    __appData: JSON.stringify({ toc }),
    __INITIAL_STATE__: 'invalid JSON',
    __NEXT_DATA__: { other: 'data' },
  } });
  h.context.expectedPage = page;
  const result = await h.run('readLiveAppData(42, expectedPage)');
  assert.equal(h.calls.scripts[0].world, 'MAIN');
  assert.equal(h.calls.scripts[0].target.tabId, 42);
  assert.equal(result.href, bookHref);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].book.name, '测试知识库');
  assert.equal(result.candidates[0].self, undefined);
  assert.equal(result.candidates[1].toc[1].slug, 'two');
});

test('live data and DOM results from another book are rejected', async () => {
  const changedHref = 'https://www.yuque.com/hacktwo/another';
  const h = panelHarness({ liveHref: changedHref, responses: [
    { response: { ...domResponse, href: changedHref } },
  ] });
  h.context.expectedPage = page;
  await assert.rejects(h.run('readLiveAppData(42, expectedPage)'), /标签页已切换/);
  await h.run('scanByDom(expectedPage, 42)');
  assert.match(h.logs(), /标签页已切换/);
  assert.equal(h.run('treeState.nodes.length'), 0);
  assertButtonsRestored(h, false);
});

test('scan automatically falls back from empty HTML and live data to recovered DOM', async () => {
  const h = panelHarness({ responses: [
    { error: 'Could not establish connection. Receiving end does not exist.' },
    { response: domResponse },
  ] });
  await h.run('scan()');
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].url, bookHref);
  assert.equal(h.calls.scripts.length, 2);
  assert.equal(h.calls.scripts[0].world, 'MAIN');
  assert.deepEqual(Array.from(h.calls.scripts[1].files), ['js/content.js']);
  assert.equal(h.run('countDocs(treeState.nodes)'), 2);
  assert.equal(h.run('treeState.nodes[0].children[0].title'), '第二篇');
  assert.match(h.logs(), /自动尝试 DOM 兜底/);
  assert.match(h.logs(), /页面已加载的链接/);
  assert.match(h.nodes.get('statusText').textContent, /目录就绪.*DOM 兜底/);
  assertButtonsRestored(h, true);
});

test('scan uses live directory data before trying DOM', async () => {
  const h = panelHarness({ liveWindow: { appData: {
    book: { id: 123, name: '测试知识库', slug: 'dtdx2v' },
    toc: [{ title: '第一篇', slug: 'one' }, { title: '第二篇', slug: 'two' }],
  } } });
  await h.run('scan()');
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.run('countDocs(treeState.nodes)'), 2);
  assert.match(h.nodes.get('statusText').textContent, /目录就绪：2 篇文档/);
  assertButtonsRestored(h, true);
});

test('scan continues to DOM after HTML and MAIN execution failures and restores buttons', async () => {
  const h = panelHarness({
    fetchResponse: { ok: false, error: 'HTTP 403' },
    liveError: 'Cannot access the page',
    responses: [{ response: { ok: false, error: '侧边栏里没找到文档链接，请先展开目录' } }],
  });
  await h.run('scan()');
  assert.match(h.logs(), /HTTP 403/);
  assert.match(h.logs(), /Cannot access the page/);
  assert.match(h.logs(), /请先展开目录/);
  assert.equal(h.nodes.get('statusText').textContent, 'DOM 兜底失败');
  assert.equal(h.calls.messages.length, 1);
  assertButtonsRestored(h, false);
});

test('scan rejects a non-Yuque active page before reading or injecting', async () => {
  const h = panelHarness({ tabHref: 'https://example.com/hacktwo/dtdx2v' });
  await h.run('scan()');
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.calls.scripts.length, 0);
  assert.equal(h.calls.messages.length, 0);
  assert.match(h.logs(), /请先把当前标签页切到语雀/);
  assertButtonsRestored(h, false);
});

test('reinjecting content.js replaces its listener and still returns same-book unique links', () => {
  const listeners = new Set();
  let removed = 0;
  const anchor = (href, title, left = 16) => ({
    href, textContent: title, getBoundingClientRect: () => ({ left }),
  });
  const anchors = [
    anchor(`${bookHref}/one`, '第一篇'),
    anchor(`${bookHref}/one#section`, '重复链接'),
    anchor(`${bookHref}/two`, '第二篇', 32),
    anchor('https://www.yuque.com/hacktwo/another/three', '其他知识库'),
    anchor('https://evil.example/hacktwo/dtdx2v/four', '其他站点'),
  ];
  const context = vm.createContext({
    URL, location: { href: bookHref },
    document: { title: '测试知识库', cookie: '', querySelector: () => null, querySelectorAll: () => anchors },
    chrome: { runtime: { onMessage: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { removed++; listeners.delete(listener); },
    } } },
  });
  vm.runInContext(contentSource, context, { filename: 'js/content.js' });
  const original = [...listeners][0];
  vm.runInContext(contentSource, context, { filename: 'js/content.js' });
  assert.equal(listeners.size, 1);
  assert.equal(removed, 1);
  assert.equal(listeners.has(original), false);
  let responseCount = 0;
  for (const listener of listeners) listener({ type: 'SCRAPE_TOC' }, {}, (response) => {
    responseCount++;
    assert.equal(response.ok, true);
    assert.equal(response.href, bookHref);
    assert.equal(response.nodes.length, 2);
    assert.equal(response.nodes[1].depth, 1);
  });
  assert.equal(responseCount, 1);
});

async function main() {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`scan recovery tests passed (${tests.length} cases, no network access)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
