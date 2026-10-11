const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync('js/local-files.js', 'utf8'), context);
const { createStore } = context.YQLocalFiles;

function fsError(name) {
  return Object.assign(new Error(name), { name });
}

function mockDirectory(name = 'root', audit = []) {
  const children = new Map();
  return {
    name, children, audit,
    async getDirectoryHandle(child, options = {}) {
      audit.push(['directory', name, child, !!options.create]);
      if (this.directoryError) throw fsError(this.directoryError);
      let handle = children.get(child);
      if (handle && !handle.getDirectoryHandle) throw fsError('TypeMismatchError');
      if (!handle) {
        if (!options.create) throw fsError('NotFoundError');
        handle = mockDirectory(child, audit);
        children.set(child, handle);
      }
      return handle;
    },
    async getFileHandle(child, options = {}) {
      audit.push(['file', name, child, !!options.create]);
      if (this.fileError) throw fsError(this.fileError);
      let handle = children.get(child);
      if (handle && !handle.getFile) throw fsError('TypeMismatchError');
      if (!handle) {
        if (!options.create) throw fsError('NotFoundError');
        handle = mockFile('', audit, child);
        children.set(child, handle);
      }
      return handle;
    },
  };
}

function mockFile(contents, audit, name) {
  return {
    contents,
    async getFile() {
      if (this.readError) throw fsError(this.readError);
      return new Blob([this.contents]);
    },
    async createWritable(options) {
      audit.push(['writable', name, options.keepExistingData]);
      if (this.openError) throw fsError(this.openError);
      const handle = this;
      let staged = '';
      return {
        async write(blob) {
          audit.push(['write', name]);
          staged = typeof blob === 'string' ? blob : await blob.text();
          if (handle.writeError) throw fsError(handle.writeError);
        },
        async close() {
          audit.push(['close', name]);
          if (handle.closeGate) await handle.closeGate;
          if (handle.closeError) throw fsError(handle.closeError);
          handle.contents = staged;
        },
        async abort() {
          audit.push(['abort', name]);
          if (handle.abortError) throw fsError(handle.abortError);
        },
      };
    },
  };
}

const blob = (text) => new Blob([text]);
const named = (name) => (error) => error.name === name;
let cases = 0;
async function test(name, run) {
  await run();
  cases++;
  console.log(`ok ${cases} - ${name}`);
}

async function main() {
  await test('nested directories are created once, including empty folders', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    await store.ensureDirectory('知识库/第一组/空文件夹');
    await store.ensureDirectory('知识库/第一组/空文件夹');
    await Promise.all([store.ensureDirectory('知识库/第二组'), store.ensureDirectory('知识库/第二组')]);
    assert.equal(root.audit.filter(([kind, , , create]) => kind === 'directory' && create).length, 4);
    assert.equal(root.children.get('知识库').children.get('第一组').children.get('空文件夹').children.size, 0);
  });

  await test('exists only accepts nonempty files and does not create missing paths', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    assert.equal(await store.exists('missing/folder/document.md'), false);
    assert.equal(root.children.size, 0);
    root.children.set('empty.md', mockFile('', root.audit, 'empty.md'));
    root.children.set('full.md', mockFile('original', root.audit, 'full.md'));
    assert.equal(await store.exists('missing.md'), false);
    assert.equal(await store.exists('empty.md'), false);
    assert.equal(await store.exists('full.md'), true);
    assert.equal(root.audit.some(([kind, , , create]) => create), false);
  });

  await test('missing files are written; repeated writes skip unchanged existing content', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const first = await store.writeBlob('知识库/组/正文.md', blob('正文'));
    assert.equal(first.written, true);
    assert.equal(first.path, '知识库/组/正文.md');
    const second = await store.writeBlob(first.path, blob('different'));
    assert.equal(second.written, false);
    assert.equal(await store.exists(first.path), true);
    assert.equal(root.children.get('知识库').children.get('组').children.get('正文.md').contents, '正文');
    assert.equal(root.audit.filter(([kind]) => kind === 'write').length, 1);
  });

  await test('zero-byte files can be filled at their original path', async () => {
    const root = mockDirectory();
    root.children.set('empty.md', mockFile('', root.audit, 'empty.md'));
    const result = await createStore(root).writeBlob('empty.md', blob('filled'));
    assert.equal(result.path, 'empty.md');
    assert.equal(root.children.get('empty.md').contents, 'filled');
    assert.equal(root.children.size, 1);
  });

  await test('readText returns original text and propagates missing paths without creating them', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const folder = mockDirectory('知识库', root.audit);
    root.children.set('知识库', folder);
    folder.children.set('正文.md', mockFile('原文\n![图片](https://example.com/image.png)', root.audit, '正文.md'));
    assert.equal(await store.readText('知识库/正文.md'), '原文\n![图片](https://example.com/image.png)');
    await assert.rejects(store.readText('知识库/缺失.md'), named('NotFoundError'));
    await assert.rejects(store.readText('缺失/正文.md'), named('NotFoundError'));
    assert.equal(root.audit.some(([kind, , , create]) => create), false);
  });

  await test('replaceTextIfUnchanged repairs the exact file without creating a copy', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const original = '正文\n![图片](https://example.com/image.png)';
    const replacement = '正文\n![图片](_assets/image.png)';
    root.children.set('正文.md', mockFile(original, root.audit, '正文.md'));
    const result = await store.replaceTextIfUnchanged('正文.md', original, replacement);
    assert.equal(result.written, true);
    assert.equal(result.path, '正文.md');
    assert.equal(await store.readText('正文.md'), replacement);
    assert.equal(root.children.size, 1);
    assert.equal(root.audit.filter(([kind]) => kind === 'write').length, 1);
    assert.equal(root.audit.some(([kind, , , create]) => create), false);
  });

  await test('a changed file rejects repair without opening a writable and the queue recovers', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    root.children.set('正文.md', mockFile('用户编辑的正文', root.audit, '正文.md'));
    await assert.rejects(store.replaceTextIfUnchanged('正文.md', '导出原文', '图片修复后的原文'), /文件已被其他程序修改/);
    assert.equal(await store.readText('正文.md'), '用户编辑的正文');
    assert.equal(root.audit.some(([kind]) => kind === 'writable'), false);
    const result = await store.writeBlob('other.md', blob('队列恢复'));
    assert.equal(result.written, true);
    assert.equal(await store.readText('other.md'), '队列恢复');
  });

  await test('text repair does not create a missing file or directory, even for a no-op', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    await assert.rejects(store.replaceTextIfUnchanged('missing.md', '', 'new'), named('NotFoundError'));
    await assert.rejects(store.replaceTextIfUnchanged('missing/folder.md', '', ''), named('NotFoundError'));
    assert.equal(root.children.size, 0);
    assert.equal(root.audit.some(([kind, , , create]) => create), false);
  });

  await test('identical text verifies the original but does not open a writable', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    root.children.set('same.md', mockFile('original', root.audit, 'same.md'));
    const result = await store.replaceTextIfUnchanged('same.md', 'original', 'original');
    assert.equal(result.written, false);
    assert.equal(result.path, 'same.md');
    await assert.rejects(store.replaceTextIfUnchanged('same.md', 'old', 'old'), /文件已被其他程序修改/);
    assert.equal(root.audit.some(([kind]) => kind === 'writable'), false);
  });

  for (const failure of ['writeError', 'closeError']) {
    await test(`text repair ${failure} aborts and preserves the old text until a successful retry`, async () => {
      const root = mockDirectory();
      const store = createStore(root);
      const file = mockFile('保留原文', root.audit, '正文.md');
      root.children.set('正文.md', file);
      file[failure] = 'QuotaExceededError';
      file.abortError = 'InvalidStateError';
      await assert.rejects(store.replaceTextIfUnchanged('正文.md', '保留原文', '未完成的新文'), named('QuotaExceededError'));
      assert.equal(file.contents, '保留原文');
      assert.equal(root.audit.filter(([kind]) => kind === 'abort').length, 1);
      file[failure] = null;
      assert.equal((await store.replaceTextIfUnchanged('正文.md', '保留原文', '完整的新文')).written, true);
      assert.equal(file.contents, '完整的新文');
    });
  }

  await test('text repairs share the write queue and compare the current text after previous writes close', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const file = mockFile('', root.audit, 'queued.md');
    let release;
    file.closeGate = new Promise((resolve) => { release = resolve; });
    root.children.set('queued.md', file);
    const first = store.writeBlob('queued.md', blob('downloaded'));
    const repair = store.replaceTextIfUnchanged('queued.md', 'downloaded', 'localized');
    const stale = store.replaceTextIfUnchanged('queued.md', 'downloaded', 'stale');
    const staleRejected = assert.rejects(stale, /文件已被其他程序修改/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(root.audit.filter(([kind]) => kind === 'writable').length, 1);
    assert.equal(file.contents, '');
    release();
    await first;
    await repair;
    await staleRejected;
    assert.equal(file.contents, 'localized');
    assert.equal(root.audit.filter(([kind]) => kind === 'writable').length, 2);
  });

  await test('disabling skip creates numbered copies and can fill an empty copy', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    root.children.set('document.md', mockFile('original', root.audit, 'document.md'));
    root.children.set('document (1).md', mockFile('first', root.audit, 'document (1).md'));
    root.children.set('document (2).md', mockFile('', root.audit, 'document (2).md'));
    const result = await store.writeBlob('document.md', blob('second'), { skipExisting: false });
    assert.equal(result.path, 'document (2).md');
    assert.equal(root.children.get('document.md').contents, 'original');
    assert.equal(root.children.get('document (1).md').contents, 'first');
    assert.equal(root.children.get('document (2).md').contents, 'second');
    assert.equal((await store.writeBlob('document.md', blob('third'), { skipExisting: false })).path, 'document (3).md');
    await store.writeBlob('README', blob('a'));
    assert.equal((await store.writeBlob('README', blob('b'), { skipExisting: false })).path, 'README (1)');
    await store.writeBlob('.env', blob('a'));
    assert.equal((await store.writeBlob('.env', blob('b'), { skipExisting: false })).path, '.env (1)');
  });

  await test('concurrent writes to the same path write once and then skip', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const results = await Promise.all([
      store.writeBlob('same.md', blob('first')),
      store.writeBlob('same.md', blob('second')),
      store.writeBlob('same.md', blob('third')),
    ]);
    assert.equal(results.filter((result) => result.written).length, 1);
    assert.equal(root.children.get('same.md').contents, 'first');
  });

  await test('concurrent numbered copies do not overwrite or select the same filename', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    await store.writeBlob('same.md', blob('original'));
    const results = await Promise.all([
      store.writeBlob('same.md', blob('first'), { skipExisting: false }),
      store.writeBlob('same.md', blob('second'), { skipExisting: false }),
      store.writeBlob('same (1).md', blob('third'), { skipExisting: false }),
    ]);
    assert.deepEqual(results.map((result) => result.path), ['same (1).md', 'same (2).md', 'same (1) (1).md']);
    assert.equal(root.children.get('same (1).md').contents, 'first');
    assert.equal(root.children.get('same.md').contents, 'original');
  });

  for (const failure of ['writeError', 'closeError']) {
    await test(`${failure} aborts, rejects and permits retry without touching existing content`, async () => {
      const root = mockDirectory();
      const store = createStore(root);
      root.children.set('original.md', mockFile('keep me', root.audit, 'original.md'));
      const failed = mockFile('', root.audit, 'original (1).md');
      failed[failure] = 'QuotaExceededError';
      failed.abortError = 'InvalidStateError';
      root.children.set('original (1).md', failed);
      await assert.rejects(store.writeBlob('original.md', blob('partial'), { skipExisting: false }), named('QuotaExceededError'));
      assert.equal(root.children.get('original.md').contents, 'keep me');
      assert.equal(failed.contents, '');
      assert.equal(root.audit.filter(([kind]) => kind === 'abort').length, 1);
      failed[failure] = null;
      assert.equal((await store.writeBlob('original.md', blob('complete'), { skipExisting: false })).path, 'original (1).md');
      assert.equal(failed.contents, 'complete');
    });
  }

  await test('completion is reported only after close resolves', async () => {
    const root = mockDirectory();
    const file = mockFile('', root.audit, 'pending.md');
    let release;
    file.closeGate = new Promise((resolve) => { release = resolve; });
    root.children.set('pending.md', file);
    let finished = false;
    const result = createStore(root).writeBlob('pending.md', blob('complete')).then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(file.contents, '');
    release();
    await result;
    assert.equal(finished, true);
    assert.equal(file.contents, 'complete');
  });

  await test('permissions and type mismatches propagate instead of being treated as missing', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    root.directoryError = 'NotAllowedError';
    await assert.rejects(store.ensureDirectory('denied'), named('NotAllowedError'));
    await assert.rejects(store.exists('denied/doc.md'), named('NotAllowedError'));
    root.directoryError = null;
    root.children.set('occupied', mockFile('content', root.audit, 'occupied'));
    await assert.rejects(store.ensureDirectory('occupied/nested'), named('TypeMismatchError'));
    root.children.set('folder', mockDirectory('folder', root.audit));
    await assert.rejects(store.exists('folder'), named('TypeMismatchError'));
    await assert.rejects(store.writeBlob('folder', blob('x')), named('TypeMismatchError'));
    root.fileError = 'SecurityError';
    await assert.rejects(store.exists('anything.md'), named('SecurityError'));
    await assert.rejects(store.writeBlob('anything.md', blob('x')), named('SecurityError'));
    root.fileError = null;
    await store.writeBlob('recovered.md', blob('x'));
    assert.equal(await store.exists('recovered.md'), true);
  });

  await test('getFile and createWritable failures also propagate and remain retryable', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const file = mockFile('', root.audit, 'file.md');
    root.children.set('file.md', file);
    file.readError = 'NotAllowedError';
    await assert.rejects(store.exists('file.md'), named('NotAllowedError'));
    await assert.rejects(store.writeBlob('file.md', blob('x')), named('NotAllowedError'));
    file.readError = null;
    file.openError = 'NotAllowedError';
    await assert.rejects(store.writeBlob('file.md', blob('x')), named('NotAllowedError'));
    assert.equal(root.audit.some(([kind]) => kind === 'abort'), false);
    file.openError = null;
    await store.writeBlob('file.md', blob('recovered'));
    assert.equal(file.contents, 'recovered');
  });

  await test('parallel failures are handled and do not poison directory or write queues', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      root.directoryError = 'NotAllowedError';
      const results = await Promise.allSettled([
        store.ensureDirectory('denied/nested'),
        store.ensureDirectory('denied/nested'),
        store.writeBlob('denied/file.md', blob('first')),
        store.writeBlob('denied/file.md', blob('second')),
      ]);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 4);
      root.directoryError = null;
      await store.ensureDirectory('denied/nested');
      await store.writeBlob('denied/file.md', blob('recovered'));
      assert.equal(await store.exists('denied/file.md'), true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  await test('unsafe, absolute and empty paths are rejected before accessing the filesystem', async () => {
    const root = mockDirectory();
    const store = createStore(root);
    const badPaths = ['', '/', '/absolute.md', 'C:/absolute.md', 'C:relative.md', '\\\\server\\file',
      'one\\two', '.', '..', 'a/../b', './a', 'a/./b', 'a//b', 'a/', 'a\u0000b', null, 1];
    for (const path of badPaths) {
      await assert.rejects(store.ensureDirectory(path), named('TypeError'));
      await assert.rejects(store.exists(path), named('TypeError'));
      await assert.rejects(store.readText(path), named('TypeError'));
      await assert.rejects(store.replaceTextIfUnchanged(path, 'old', 'new'), named('TypeError'));
      await assert.rejects(store.writeBlob(path, blob('x')), named('TypeError'));
    }
    assert.equal(root.audit.length, 0);
    assert.throws(() => createStore(null), named('TypeError'));
  });

  console.log(`${cases} local filesystem tests passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
