const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceFiles = ['js/config.js', 'js/local-files.js', 'js/md2html.js', 'sidepanel.js'];
const sources = sourceFiles.map((file) => [file, fs.readFileSync(path.join(__dirname, file), 'utf8')]);
const bookUrl = 'https://www.yuque.com/test/book';

function fsError(name) {
  return Object.assign(new Error(name), { name });
}

function fileHandle(contents, audit, filename) {
  return {
    kind: 'file', contents,
    async getFile() {
      const blob = new Blob([this.contents]);
      const readText = blob.text.bind(blob);
      blob.text = async () => {
        audit.push({ type: 'readText', path: filename });
        return readText();
      };
      return blob;
    },
    async createWritable() {
      const file = this;
      let staged;
      return {
        async write(blob) { staged = typeof blob === 'string' ? blob : await blob.text(); },
        async close() {
          file.contents = staged;
          audit.push({ type: 'write', path: filename });
        },
        async abort() {},
      };
    },
  };
}

function directoryHandle(name = 'chosen-root', audit = [], relative = '') {
  const children = new Map();
  return {
    kind: 'directory', name, children, audit, relative,
    async queryPermission(options) {
      audit.push({ type: 'queryPermission', mode: options.mode });
      return this.permission || 'granted';
    },
    async requestPermission(options) {
      audit.push({ type: 'requestPermission', mode: options.mode });
      return this.requestedPermission || this.permission || 'granted';
    },
    async getDirectoryHandle(child, options = {}) {
      if (this.directoryError) throw fsError(this.directoryError);
      let handle = children.get(child);
      if (handle && handle.kind !== 'directory') throw fsError('TypeMismatchError');
      if (!handle) {
        if (!options.create) throw fsError('NotFoundError');
        const childPath = [relative, child].filter(Boolean).join('/');
        handle = directoryHandle(child, audit, childPath);
        children.set(child, handle);
        audit.push({ type: 'mkdir', path: childPath });
      }
      return handle;
    },
    async getFileHandle(child, options = {}) {
      let handle = children.get(child);
      if (handle && handle.kind !== 'file') throw fsError('TypeMismatchError');
      if (!handle) {
        if (!options.create) throw fsError('NotFoundError');
        handle = fileHandle('', audit, [relative, child].filter(Boolean).join('/'));
        children.set(child, handle);
      }
      return handle;
    },
  };
}

function lookup(root, relative) {
  let current = root;
  for (const part of relative.split('/')) current = current?.children?.get(part);
  return current;
}

async function seedFile(root, relative, contents) {
  const parts = relative.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
  const name = parts.at(-1);
  parent.children.set(name, fileHandle(contents, root.audit, relative));
}

function element() {
  return {
    value: '0', checked: false, disabled: false, textContent: '', style: {}, dataset: {},
    children: [], listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    appendChild(child) { this.children.push(child); return child; },
    querySelectorAll() { return this.selected || []; },
  };
}

function panelHarness(options = {}) {
  const nodes = new Map();
  const calls = { fetches: [], downloads: [], searches: [], pickers: [] };
  const storage = {};
  const root = options.root || directoryHandle();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createDocumentFragment: element,
    createTextNode(text) { return { textContent: text }; },
  };
  const chrome = {
    tabs: { query: async () => [] },
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter((key) => Object.hasOwn(storage, key)).map((key) => [key, storage[key]]));
      },
      async set(values) { Object.assign(storage, values); },
    } },
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.fetches.push(message);
        root.audit.push({ type: 'fetch', url: message.url });
        if (options.onFetch) options.onFetch(message, root);
        if (message.type === 'PAGE_FETCH_BIN') {
          callback(options.binaryError
            ? { ok: false, error: options.binaryError }
            : { ok: true, b64: Buffer.from('offline-image-bytes').toString('base64'),
              mime: options.binaryMime || 'image/png' });
          return;
        }
        callback({ ok: true, text: '# 服务器正文\n\n下载内容。' });
      },
    },
    downloads: {
      search(query, callback) { calls.searches.push(query); callback([]); },
      download(request) { calls.downloads.push(request); throw new Error('Unexpected Chrome download'); },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  const window = {
    async showDirectoryPicker(request) {
      calls.pickers.push(request);
      if (options.picker) return options.picker(request, root);
      return root;
    },
  };
  const context = vm.createContext({
    document, chrome, window, URL, Blob, Uint8Array, atob, console, setTimeout, clearTimeout,
    fetch() { throw new Error('Tests must not access the network'); },
  });
  for (const [filename, source] of sources) vm.runInContext(source, context, { filename });
  const run = (code) => vm.runInContext(code, context);
  run(`Object.assign(treeState, {
    bookName: '知识库', origin: 'https://www.yuque.com', bookPath: '/test/book',
    bookSegments: ['test', 'book'], nodes: []
  }); exportCtx.root = '知识库'; YQ_CFG.delayMs = 0;`);
  document.getElementById('fmtMd').checked = true;
  document.getElementById('skipExisting').checked = true;
  return {
    context, nodes, calls, root, run, storage,
    async choose() { await run('chooseExportDirectory()'); },
    tree(tree) { context.testTree = tree; run('treeState.nodes = testTree'); },
    select(docs) {
      document.getElementById('tree').selected = docs.map((doc) => ({
        dataset: { title: doc.title, url: doc.url, parents: doc.parents.join(String.fromCharCode(1)) },
      }));
    },
    async export(doc, options = {}, stats) {
      context.testDoc = doc;
      context.testOptions = { md: true, html: false, lake: false, images: false, used: new Map(), ...options };
      context.testStats = stats || {
        docs: 0, skipped: 0, images: 0, repaired: 0,
        skipExisting: true, failed: [], imageErrors: [],
      };
      await run(`exportDoc(testDoc, ${JSON.stringify(bookUrl)} + '/' + testDoc.url, testOptions, testStats)`);
      return context.testStats;
    },
  };
}

const doc = (title = '正文', parents = ['第一组'], url = 'one') => ({ title, parents, url });

function assertIdle(h) {
  for (const id of ['exportBtn', 'scanBtn', 'scrapeBtn', 'chooseDownloadDir', 'fmtMd', 'fmtHtml',
    'fmtLake', 'localizeImg', 'speedLimit', 'skipExisting', 'selectAllBtn', 'selectNoneBtn']) {
    assert.equal(h.nodes.get(id).disabled, false, `${id} should be usable after export`);
  }
  assert.equal(h.nodes.get('cancelBtn').disabled, true);
  assert.equal(h.run('exportRunning'), false);
  assert.equal(h.run('requestLimitKbps'), 0);
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('prepares every folder, including empty unselected groups and levels beyond three', async () => {
  const h = panelHarness();
  await h.choose();
  h.tree([
    { title: '第一层', children: [{ title: '第二层', children: [{ title: '第三层', children: [
      { title: '第四层', children: [{ title: '空第五层', children: [] }] },
    ] }] }] },
    { title: '未勾选的空分组', children: [] },
    { title: '有子篇的文档', url: 'parent', children: [{ title: '子篇', url: 'child', children: [] }] },
  ]);
  await h.run('prepareLocalDirectories([], { images: true })');
  assert.equal(lookup(h.root, '知识库/第一层/第二层/第三层/第四层/空第五层').kind, 'directory');
  assert.equal(lookup(h.root, '知识库/未勾选的空分组').children.size, 0);
  assert.equal(lookup(h.root, '知识库/有子篇的文档').kind, 'directory');
  assert.equal(lookup(h.root, '知识库/_assets').kind, 'directory');
  const created = h.root.audit.filter((entry) => entry.type === 'mkdir').length;
  await h.run('prepareLocalDirectories([], { images: true })');
  assert.equal(h.root.audit.filter((entry) => entry.type === 'mkdir').length, created);
  assert.equal(h.calls.fetches.length, 0);
});

test('an existing nonempty Markdown file skips all body requests', async () => {
  const h = panelHarness();
  await h.choose();
  await seedFile(h.root, '知识库/第一组/正文.md', '保留已有正文');
  const stats = await h.export(doc());
  assert.equal(stats.skipped, 1);
  assert.equal(stats.docs, 0);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(lookup(h.root, '知识库/第一组/正文.md').contents, '保留已有正文');
});

test('a missing file is fetched and written into the selected folder without Chrome downloads', async () => {
  const h = panelHarness();
  await h.choose();
  const stats = await h.export(doc('新正文', ['一', '二', '三', '四']));
  assert.equal(stats.docs, 1);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].type, 'PAGE_FETCH');
  assert.match(h.calls.fetches[0].url, /\/one\/markdown\?/);
  assert.match(lookup(h.root, '知识库/一/二/三/四/新正文.md').contents, /服务器正文/);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.searches.length, 0);
});

test('existing Markdown plus missing HTML fetches once and fills only HTML', async () => {
  const h = panelHarness();
  await h.choose();
  await seedFile(h.root, '知识库/第一组/正文.md', '保留本地编辑');
  const stats = await h.export(doc(), { html: true });
  assert.equal(stats.docs, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(lookup(h.root, '知识库/第一组/正文.md').contents, '保留本地编辑');
  assert.match(lookup(h.root, '知识库/第一组/正文.html').contents, /<h1[^>]*>服务器正文<\/h1>/);
  assert.deepEqual(h.root.audit.filter((entry) => entry.type === 'write').map((entry) => entry.path),
    ['知识库/第一组/正文.html']);
});

test('an empty file is filled at its original path instead of skipped or duplicated', async () => {
  const h = panelHarness();
  await h.choose();
  await seedFile(h.root, '知识库/第一组/正文.md', '');
  const stats = await h.export(doc());
  assert.equal(stats.docs, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(h.calls.fetches.length, 1);
  assert.match(lookup(h.root, '知识库/第一组/正文.md').contents, /下载内容/);
  assert.equal(lookup(h.root, '知识库/第一组').children.size, 1);
});

test('the same filename in another folder cannot incorrectly suppress a download', async () => {
  const h = panelHarness();
  await h.choose();
  await seedFile(h.root, '知识库/第一组/正文.md', '原正文');
  await h.export(doc());
  const stats = await h.export(doc('正文', ['第二组'], 'second'));
  assert.equal(stats.docs, 1);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(lookup(h.root, '知识库/第一组/正文.md').contents, '原正文');
  assert.match(lookup(h.root, '知识库/第二组/正文.md').contents, /下载内容/);
});

test('duplicate titles get stable names across different selections from the same full tree', async () => {
  const h = panelHarness();
  h.tree([
    { title: '组', children: [
      { title: '同名', url: 'one', children: [] },
      { title: '同名', url: 'two', children: [] },
    ] },
    { title: '其他组', children: [{ title: '同名', url: 'three', children: [] }] },
  ]);
  const assign = (docs) => {
    h.context.testDocs = docs;
    h.run('assignDocumentNames(testDocs)');
    return docs.map((item) => item.fileBase);
  };
  const all = assign([doc('同名', ['组'], 'one'), doc('同名', ['组'], 'two'), doc('同名', ['其他组'], 'three')]);
  assert.notEqual(all[0], all[1]);
  assert.equal(all[2], '同名');
  assert.equal(assign([doc('同名', ['组'], 'one')])[0], all[0]);
  assert.equal(assign([doc('同名', ['组'], 'two')])[0], all[1]);
  assert.deepEqual(assign([doc('同名', ['组'], 'two'), doc('同名', ['组'], 'one')]), [all[1], all[0]]);
});

test('folder selection requests readwrite access and displays the actual selected root', async () => {
  const h = panelHarness();
  await h.choose();
  assert.equal(h.calls.pickers.length, 1);
  assert.equal(h.calls.pickers[0].mode, 'readwrite');
  assert.equal(h.calls.pickers[0].startIn, 'downloads');
  assert.match(h.nodes.get('downloadDirStatus').textContent, /chosen-root/);
  assert.equal(h.run('downloadDir.name'), h.root.name);
});

test('an image download failure preserves remote links and never switches to Chrome downloads', async () => {
  const h = panelHarness({ binaryError: 'Image fetch denied' });
  await h.choose();
  const original = '![示例](https://example.com/picture.png)\n<img src="https://example.com/picture.png">';
  h.context.testMarkdown = original;
  h.context.testStats = { images: 0, skipped: 0, skipExisting: true, imageErrors: [] };
  const result = await h.run('localizeImages(testMarkdown, 1, new Map(), testStats)');
  assert.equal(result, original);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.context.testStats.imageErrors.length, 1);
  assert.match(h.context.testStats.imageErrors[0], /Image fetch denied/);
  assert.equal(h.context.testStats.images, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.root.audit.some((entry) => entry.type === 'write'), false);
});

test('repeated image URLs share one local asset and subsequent localization reuses that file', async () => {
  const h = panelHarness();
  await h.choose();
  h.context.testMarkdown = '![第一处](https://example.com/picture.png)\n![第二处](https://example.com/picture.png)';
  h.context.testStats = { images: 0, skipped: 0, skipExisting: true, imageErrors: [] };
  const first = await h.run('localizeImages(testMarkdown, 1, new Map(), testStats)');
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].type, 'PAGE_FETCH_BIN');
  const assetPaths = [...first.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.equal(assetPaths.length, 2);
  assert.equal(assetPaths[0], assetPaths[1]);
  assert.match(assetPaths[0], /^\.\.\/_assets\/picture-.*\.png$/);
  const assetFilename = assetPaths[0].slice('../'.length);
  assert.equal(lookup(h.root, `知识库/${assetFilename}`).contents, 'offline-image-bytes');
  const second = await h.run('localizeImages(testMarkdown, 1, new Map(), testStats)');
  assert.equal(second, first);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.context.testStats.images, 1);
  assert.equal(h.context.testStats.skipped, 1);
  assert.equal(h.calls.downloads.length, 0);
});

const cdnImage = 'https://cdn.nlark.com/yuque/0/2026/png/123/1789394284133-6c154883-3c3c-4ea9-a4e1-b8a4627fd7a4.png';

test('an existing Markdown file repairs remote images without fetching or replacing its body', async () => {
  const h = panelHarness();
  await h.choose();
  const filename = '知识库/第一组/正文.md';
  const original = `# 本地修改的标题\r\n\r\n保留 **格式** 与中文。\r\n![截图](${cdnImage})\r\n[原图地址](${cdnImage})\r\n`;
  await seedFile(h.root, filename, original);
  const stats = await h.export(doc(), { images: true });
  const repaired = lookup(h.root, filename).contents;
  const localLink = repaired.match(/!\[截图\]\(([^)]+)\)/)?.[1];
  assert.match(localLink, /^\.\.\/_assets\/[^/]+\.png$/);
  assert.equal(repaired, original.replace(`![截图](${cdnImage})`, `![截图](${localLink})`));
  assert.equal(lookup(h.root, `知识库/${localLink.slice(3)}`).contents, 'offline-image-bytes');
  assert.equal(stats.docs, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.images, 1);
  assert.equal(stats.repaired, 1);
  assert.equal(stats.imageErrors.length, 0);
  assert.deepEqual(h.calls.fetches.map((entry) => [entry.type, entry.url]), [['PAGE_FETCH_BIN', cdnImage]]);
  assert.equal(h.calls.downloads.length, 0);

  h.run('savedThisRun.clear()');
  const writes = h.root.audit.filter((entry) => entry.type === 'write').length;
  const second = await h.export(doc(), { images: true });
  assert.equal(second.docs, 0);
  assert.equal(second.repaired, 0);
  assert.equal(second.images, 0);
  assert.equal(h.calls.fetches.length, 1, 'a repeat export must not refetch the repaired image');
  assert.equal(h.root.audit.filter((entry) => entry.type === 'write').length, writes);
  assert.equal(lookup(h.root, filename).contents, repaired);
});

test('existing Markdown and HTML share one repaired asset and preserve each original document', async () => {
  const h = panelHarness();
  await h.choose();
  const folder = '知识库/第一层/第二层';
  const markdown = `本地正文\n![示例](${cdnImage})\n`;
  const html = `<!doctype html>\n<html><body class="custom"><p>手工排版</p><img alt='示例' src='${cdnImage}' width='640'></body></html>`;
  await seedFile(h.root, `${folder}/正文.md`, markdown);
  await seedFile(h.root, `${folder}/正文.html`, html);
  const stats = await h.export(doc('正文', ['第一层', '第二层']), { html: true, images: true });
  const repairedMd = lookup(h.root, `${folder}/正文.md`).contents;
  const repairedHtml = lookup(h.root, `${folder}/正文.html`).contents;
  const localLink = repairedMd.match(/!\[示例\]\(([^)]+)\)/)?.[1];
  assert.match(localLink, /^\.\.\/\.\.\/_assets\/[^/]+\.png$/);
  assert.equal(repairedMd, markdown.replace(cdnImage, localLink));
  assert.equal(repairedHtml, html.replace(cdnImage, localLink));
  assert.equal(lookup(h.root, `知识库/${localLink.slice(6)}`).contents, 'offline-image-bytes');
  assert.equal(stats.repaired, 2);
  assert.equal(stats.docs, 0);
  assert.equal(stats.images, 1);
  assert.deepEqual(h.calls.fetches.map((entry) => entry.type), ['PAGE_FETCH_BIN']);
  assert.equal(lookup(h.root, '知识库/_assets').children.size, 1);
});

test('a failed existing-document image repair retains its remote link and succeeds in a later run', async () => {
  const options = { binaryError: 'Temporary CDN failure' };
  const h = panelHarness(options);
  await h.choose();
  const filename = '知识库/第一组/正文.md';
  const original = `保留本地内容\n![图片](${cdnImage})`;
  await seedFile(h.root, filename, original);
  const failed = await h.export(doc(), { images: true });
  assert.equal(lookup(h.root, filename).contents, original);
  assert.equal(failed.repaired, 0);
  assert.equal(failed.images, 0);
  assert.equal(failed.imageErrors.length, 1);
  assert.match(failed.imageErrors[0], /Temporary CDN failure/);
  assert.equal(h.root.audit.some((entry) => entry.type === 'write'), false);

  options.binaryError = null;
  h.run('savedThisRun.clear()');
  const retried = await h.export(doc(), { images: true });
  assert.equal(retried.repaired, 1);
  assert.equal(retried.images, 1);
  assert.equal(retried.imageErrors.length, 0);
  assert.match(lookup(h.root, filename).contents, /!\[图片\]\(\.\.\/_assets\//);
  assert.deepEqual(h.calls.fetches.map((entry) => entry.type), ['PAGE_FETCH_BIN', 'PAGE_FETCH_BIN']);
});

test('one failed image shared across documents is requested and reported only once per run', async () => {
  const h = panelHarness({ binaryError: 'Shared image unavailable' });
  await h.choose();
  const first = `![图片](${cdnImage})\n<img src="${cdnImage}">`;
  const second = `<p>第二篇本地内容</p><img src="${cdnImage}">`;
  await seedFile(h.root, '知识库/第一组/正文.md', first);
  await seedFile(h.root, '知识库/第二组/第二篇.html', second);
  const sharedOptions = { images: true, used: new Map() };
  const stats = await h.export(doc(), sharedOptions);
  await h.export(doc('第二篇', ['第二组'], 'two'), { ...sharedOptions, md: false, html: true }, stats);
  assert.equal(stats.imageErrors.length, 1);
  assert.equal(stats.failedAssets.size, 1);
  assert.equal(stats.repaired, 0);
  assert.equal(stats.docs, 0);
  assert.deepEqual(h.calls.fetches.map((entry) => [entry.type, entry.url]), [['PAGE_FETCH_BIN', cdnImage]]);
  assert.equal(lookup(h.root, '知识库/第一组/正文.md').contents, first);
  assert.equal(lookup(h.root, '知识库/第二组/第二篇.html').contents, second);
  assert.equal(h.root.audit.some((entry) => entry.type === 'write'), false);
});

test('disabling image localization skips existing documents without reading or modifying their text', async () => {
  const h = panelHarness();
  await h.choose();
  const markdown = `![图片](${cdnImage})`;
  const html = `<img src="${cdnImage}">`;
  await seedFile(h.root, '知识库/第一组/正文.md', markdown);
  await seedFile(h.root, '知识库/第一组/正文.html', html);
  const stats = await h.export(doc(), { html: true, images: false });
  assert.equal(stats.skipped, 2);
  assert.equal(stats.docs, 0);
  assert.equal(stats.repaired, 0);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.root.audit.some((entry) => entry.type === 'readText' || entry.type === 'write'), false);
  assert.equal(lookup(h.root, '知识库/第一组/正文.md').contents, markdown);
  assert.equal(lookup(h.root, '知识库/第一组/正文.html').contents, html);
});

test('an HTML response for an image cannot be saved as an asset or replace its remote link', async () => {
  const h = panelHarness({ binaryMime: 'text/html; charset=utf-8' });
  await h.choose();
  const filename = '知识库/第一组/正文.md';
  const original = `![图片](${cdnImage})`;
  await seedFile(h.root, filename, original);
  const stats = await h.export(doc(), { images: true });
  assert.equal(stats.images, 0);
  assert.equal(stats.repaired, 0);
  assert.equal(stats.imageErrors.length, 1);
  assert.match(stats.imageErrors[0], /图片地址返回了网页或错误信息/);
  assert.equal(lookup(h.root, filename).contents, original);
  assert.equal(h.root.audit.some((entry) => entry.type === 'write'), false);
  assert.deepEqual(h.calls.fetches.map((entry) => entry.type), ['PAGE_FETCH_BIN']);
});

test('editing an existing document during image download prevents the repair from overwriting it', async () => {
  const filename = '知识库/第一组/正文.md';
  const userEdit = '用户刚刚保存的新内容';
  const h = panelHarness({
    onFetch(message, root) {
      if (message.type === 'PAGE_FETCH_BIN') lookup(root, filename).contents = userEdit;
    },
  });
  await h.choose();
  await seedFile(h.root, filename, `![图片](${cdnImage})`);
  await assert.rejects(h.export(doc(), { images: true }), /文件已被其他程序修改，未更新/);
  assert.equal(lookup(h.root, filename).contents, userEdit);
  assert.equal(h.context.testStats.repaired, 0);
  assert.equal(h.root.audit.some((entry) => entry.type === 'write' && entry.path === filename), false);
  assert.deepEqual(h.calls.fetches.map((entry) => entry.type), ['PAGE_FETCH_BIN']);
});

test('raw HTML supplied only as base64 preserves its content and is skipped on the next export', async () => {
  const h = panelHarness();
  await h.choose();
  const html = '<!doctype html><html><body>原始导出内容。</body></html>';
  h.context.rawHtml = { kind: 'html', ext: '.html', b64: Buffer.from(html).toString('base64') };
  h.context.rawCalls = 0;
  h.run('fetchRawExport = async () => { rawCalls++; return rawHtml; }');
  const first = await h.export(doc(), { md: false, lake: true });
  assert.equal(first.docs, 1);
  assert.equal(h.context.rawCalls, 1);
  assert.equal(lookup(h.root, '知识库/第一组/正文.html').contents, html);
  assert.ok(Object.entries(h.storage).some(([key, value]) => key.startsWith('raw-format:') && value === 'html'));
  h.run('savedThisRun.clear()');
  const second = await h.export(doc(), { md: false, lake: true });
  assert.equal(second.docs, 0);
  assert.equal(second.skipped, 1);
  assert.equal(h.context.rawCalls, 1);
  assert.equal(h.root.audit.filter((entry) => entry.type === 'write').length, 1);
  assert.equal(h.calls.downloads.length, 0);
});

test('disabling dedup links the newly written image copy instead of an earlier file', async () => {
  const h = panelHarness();
  await h.choose();
  const imageUrl = 'https://example.com/picture.png';
  h.context.testMarkdown = `![图](${imageUrl})\n<img src="${imageUrl}">`;
  h.context.testStats = { images: 0, skipped: 0, skipExisting: false, imageErrors: [] };
  const filename = h.run(`assetFileName(${JSON.stringify(imageUrl)}, new Map())`);
  await seedFile(h.root, `知识库/_assets/${filename}`, 'original-image-bytes');
  h.run('exportCtx.skipExisting = false');
  const rewritten = await h.run('localizeImages(testMarkdown, 2, new Map(), testStats)');
  const copyFilename = filename.replace(/\.png$/, ' (1).png');
  assert.equal(lookup(h.root, `知识库/_assets/${filename}`).contents, 'original-image-bytes');
  assert.equal(lookup(h.root, `知识库/_assets/${copyFilename}`).contents, 'offline-image-bytes');
  const markdownLink = rewritten.match(/!\[图\]\(([^)]+)\)/)?.[1];
  const htmlLink = rewritten.match(/<img src="([^"]+)">/)?.[1];
  assert.equal(decodeURIComponent(markdownLink), `../../_assets/${copyFilename}`);
  assert.equal(decodeURIComponent(htmlLink), `../../_assets/${copyFilename}`);
  assert.equal(/[\s()]/.test(markdownLink), false, 'Markdown image paths must escape spaces and parentheses');
  h.context.rewrittenMarkdown = rewritten;
  const rendered = h.run('YQMdToHtml.render(rewrittenMarkdown, "副本正文").html');
  assert.ok(rendered.includes(`<img src="${markdownLink}" alt="图"`));
  assert.equal(h.context.testStats.images, 1);
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.downloads.length, 0);
});

test('runExport prepares unselected empty folders before the first content request', async () => {
  const h = panelHarness({
    onFetch(_message, root) {
      assert.equal(lookup(root, '知识库/空分组').kind, 'directory');
      assert.equal(lookup(root, '知识库/第一组').kind, 'directory');
    },
  });
  h.tree([
    { title: '第一组', children: [{ title: '正文', url: 'one', children: [] }] },
    { title: '空分组', children: [] },
  ]);
  h.select([doc()]);
  await h.run('runExport()');
  assert.match(h.nodes.get('statusText').textContent, /导出完成.*成功 1 个文件/);
  assert.match(lookup(h.root, '知识库/第一组/正文.md').contents, /服务器正文/);
  assert.equal(h.calls.downloads.length, 0);
  assertIdle(h);
});

test('cancelling the folder picker restores all controls without fetching or creating folders', async () => {
  const h = panelHarness({ picker: async () => { throw fsError('AbortError'); } });
  h.select([doc()]);
  await h.run('runExport()');
  assert.match(h.nodes.get('statusText').textContent, /已取消选择目录/);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.root.children.size, 0);
  assertIdle(h);
});

test('denied directory permission restores all controls and never attempts a body request', async () => {
  const h = panelHarness();
  await h.choose();
  h.root.permission = 'prompt';
  h.root.requestedPermission = 'denied';
  h.select([doc()]);
  await h.run('runExport()');
  assert.match(h.nodes.get('statusText').textContent, /没有所选目录的写入权限/);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.root.children.size, 0);
  assert.deepEqual(h.root.audit.map((entry) => [entry.type, entry.mode]),
    [['queryPermission', 'readwrite'], ['requestPermission', 'readwrite']]);
  assertIdle(h);
});

test('a directory creation failure reports its path and restores all controls', async () => {
  const h = panelHarness();
  h.root.directoryError = 'NotAllowedError';
  h.select([doc()]);
  await h.run('runExport()');
  assert.match(h.nodes.get('statusText').textContent, /准备文件夹失败 知识库.*NotAllowedError/);
  assert.equal(h.calls.fetches.length, 0);
  assertIdle(h);
});

test('stopping while the picker is pending prevents the export and restores all controls', async () => {
  let release;
  const h = panelHarness({ picker: () => new Promise((resolve) => { release = resolve; }) });
  h.select([doc()]);
  const pending = h.run('runExport()');
  assert.equal(h.nodes.get('exportBtn').disabled, true);
  assert.equal(h.nodes.get('cancelBtn').disabled, false);
  h.nodes.get('cancelBtn').listeners.get('click')();
  release(h.root);
  await pending;
  assert.match(h.nodes.get('statusText').textContent, /已手动停止/);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.root.children.size, 0);
  assertIdle(h);
});

(async () => {
  for (const [index, entry] of tests.entries()) {
    await entry.run();
    console.log(`ok ${index + 1} - ${entry.name}`);
  }
  console.log(`${tests.length} incremental export integration tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
