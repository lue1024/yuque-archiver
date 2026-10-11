/**
 * 以用户选定的目录为根目录，按相对路径创建目录、检查文件并写入内容。
 * 仅把成功 close 的写入视为完成；同一 store 的写入按顺序执行，避免副本重名。
 */
(() => {
  'use strict';

  function pathParts(path) {
    if (typeof path !== 'string' || !path || /[\\\u0000]/.test(path)
      || /^[a-zA-Z]:/.test(path)) {
      throw new TypeError('文件路径必须是相对所选目录的有效路径');
    }
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new TypeError('文件路径不能包含空路径段、. 或 ..');
    }
    return parts;
  }

  function isMissing(error) {
    return error?.name === 'NotFoundError';
  }

  function copyName(name, index) {
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${index})${name.slice(dot)}`
      : `${name} (${index})`;
  }

  function createStore(rootHandle) {
    if (!rootHandle || typeof rootHandle.getDirectoryHandle !== 'function'
      || typeof rootHandle.getFileHandle !== 'function') {
      throw new TypeError('请先选择本地保存目录');
    }

    const pendingDirectories = new Map();
    let writes = Promise.resolve();

    async function directory(parts, create) {
      let handle = rootHandle;
      for (let index = 0; index < parts.length; index++) {
        const name = parts[index];
        if (!create) {
          handle = await handle.getDirectoryHandle(name);
          continue;
        }
        const key = parts.slice(0, index + 1).join('/');
        let pending = pendingDirectories.get(key);
        if (!pending) {
          const parent = handle;
          pending = (async () => {
            try {
              return await parent.getDirectoryHandle(name);
            } catch (error) {
              if (!isMissing(error)) throw error;
              return parent.getDirectoryHandle(name, { create: true });
            }
          })();
          pendingDirectories.set(key, pending);
        }
        try {
          handle = await pending;
        } finally {
          if (pendingDirectories.get(key) === pending) pendingDirectories.delete(key);
        }
      }
      return handle;
    }

    async function fileIfPresent(parent, name) {
      try {
        const handle = await parent.getFileHandle(name);
        const file = await handle.getFile();
        return { handle, size: file.size };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }

    async function ensureDirectory(path) {
      await directory(pathParts(path), true);
    }

    async function exists(path) {
      const parts = pathParts(path);
      const name = parts.pop();
      let parent;
      try {
        parent = await directory(parts, false);
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      const file = await fileIfPresent(parent, name);
      return !!file && file.size > 0;
    }

    async function readText(path) {
      const parts = pathParts(path);
      const name = parts.pop();
      const parent = await directory(parts, false);
      const handle = await parent.getFileHandle(name);
      return (await handle.getFile()).text();
    }

    async function writeContents(handle, contents) {
      let writable;
      try {
        writable = await handle.createWritable({ keepExistingData: false });
        await writable.write(contents);
        await writable.close();
      } catch (error) {
        if (writable) {
          try { await writable.abort(); } catch (_) { /* 保留原始写入错误。 */ }
        }
        throw error;
      }
    }

    function enqueueWrite(write) {
      // 写入失败不阻塞后续重试；串行化也避免副本命名与原文件修复竞争。
      const result = writes.then(write);
      writes = result.catch(() => {});
      return result;
    }

    async function replaceTextIfUnchanged(path, expectedText, replacementText) {
      const parts = pathParts(path);
      const name = parts.pop();
      if (typeof expectedText !== 'string' || typeof replacementText !== 'string') {
        throw new TypeError('待比较和替换的文件内容必须是文本');
      }
      return enqueueWrite(async () => {
        // 仅修复已有文件；缺失或访问失败时保留原始错误，不创建目录或文件。
        const parent = await directory(parts, false);
        const handle = await parent.getFileHandle(name);
        const currentText = await (await handle.getFile()).text();
        if (currentText !== expectedText) {
          throw new Error(`文件已被其他程序修改，未更新：${path}`);
        }
        if (replacementText === expectedText) return { written: false, path };
        await writeContents(handle, replacementText);
        return { written: true, path };
      });
    }

    async function writeBlob(path, blob, { skipExisting = true } = {}) {
      const parts = pathParts(path);
      const requestedName = parts.pop();
      const write = async () => {
        const parent = await directory(parts, true);
        let name = requestedName;
        let file = await fileIfPresent(parent, name);
        if (file?.size > 0 && skipExisting) return { written: false, path };

        // 不覆盖已有内容；取消去重时使用浏览器下载相同的副本命名习惯。
        for (let index = 1; file?.size > 0; index++) {
          name = copyName(requestedName, index);
          file = await fileIfPresent(parent, name);
        }
        const handle = file?.handle || await parent.getFileHandle(name, { create: true });
        await writeContents(handle, blob);
        return { written: true, path: [...parts, name].join('/') };
      };

      return enqueueWrite(write);
    }

    return { ensureDirectory, exists, readText, replaceTextIfUnchanged, writeBlob };
  }

  globalThis.YQLocalFiles = { createStore };
})();
