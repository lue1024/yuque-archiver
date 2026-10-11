importScripts('config.js');

/**
 * 正文借已登录的语雀标签页取数；CDN 图片由有主机权限的扩展后台读取。
 *
 * 为什么不在 service worker 里直接 fetch：
 *  1. 语雀的导出接口校验 Referer / 同源，worker 里 fetch 会被拒；
 * CDN 不是语雀文档站点，不要求打开同域标签页。
 * 扩展后台跨域读取 CDN 需要 manifest 中声明对应 host_permissions。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

async function waitForComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch {
      throw new Error('标签页已关闭');
    }
    await sleep(300);
  }
  throw new Error('等待页面加载超时');
}

/**
 * 找一个目标 host 下已打开的语雀标签页；没有就后台开一个。
 * 必须同 host，否则注入进去 fetch 仍是跨域，读不到响应体。
 */
async function ensureYuqueTab(host, openUrl) {
  const pattern = `https://${host}/*`;
  let tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
  if (tabs.length) {
    const active = tabs.find((t) => t.active);
    return active || tabs[0];
  }

  // 退一步：任何语雀标签页都可能被浏览器当作同站，但跨子域仍会拦，所以只在同 host 时用
  const anyYuque = await chrome.tabs.query({
    url: ['https://*.yuque.com/*', 'https://yuque.com/*'],
  }).catch(() => []);
  const sameHost = anyYuque.find((t) => hostOf(t.url || '') === host);
  if (sameHost) return sameHost;

  if (!openUrl) throw new Error(`没有打开 ${host} 的语雀页面，请先打开一个该站点的语雀文档页`);

  const tab = await chrome.tabs.create({ url: openUrl, active: false });
  await waitForComplete(tab.id);
  return tab;
}

/** 注入到页面主世界的取数函数。必须是自包含的，不能引用外部变量。 */
async function pageFetch(url, asBinary, timeoutMs, limitBytesPerSec) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      return { ok: false, status: res.status, mime: contentType, error: `HTTP ${res.status}` };
    }
    let buf;
    if (limitBytesPerSec > 0 && res.body) {
      // 按读取的字节数节流；导出时只开一个 worker，限额作用于整个导出。
      clearTimeout(timer);
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      const started = performance.now();
      while (true) {
        timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let part;
        try { part = await reader.read(); } finally { clearTimeout(timer); }
        if (part.done) break;
        chunks.push(part.value);
        total += part.value.byteLength;
        const wait = started + total * 1000 / limitBytesPerSec - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      buf = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
    } else {
      buf = new Uint8Array(await res.arrayBuffer());
    }
    if (asBinary) {
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      return { ok: true, status: res.status, mime: contentType, b64: btoa(bin) };
    }
    return { ok: true, status: res.status, mime: contentType, text: new TextDecoder().decode(buf) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '请求超时' : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaPage(url, asBinary = false, limitKbps = 0) {
  const host = hostOf(url);
  if (!host) throw new Error('无效的 URL: ' + url);

  const tab = await ensureYuqueTab(host, asBinary ? null : url);
  let result;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageFetch,
      args: [url, asBinary, YQ_CFG.timeoutMs, Math.max(0, Math.min(10240, Number(limitKbps) || 0)) * 1024],
    });
    result = injected && injected[0] && injected[0].result;
  } catch (e) {
    throw new Error(`注入语雀页面失败：${e.message}。请刷新该语雀标签页后重试`);
  }

  if (!result) throw new Error('页面没有返回结果，请刷新语雀标签页后重试');
  if (!result.ok) throw new Error(result.error || '请求失败');
  return result;
}

async function fetchBinary(url, limitKbps = 0) {
  let target;
  try { target = new URL(url); } catch { throw new Error('图片或附件 URL 无效'); }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('图片或附件仅支持 HTTP(S) 地址');

  let pageError = '';
  if (/(^|\.)yuque\.com$/i.test(target.hostname)) {
    try { return await fetchViaPage(url, true, limitKbps); }
    catch (e) { pageError = `页面读取：${e.message}；`; }
  }

  const result = await pageFetch(url, true, YQ_CFG.timeoutMs,
    Math.max(0, Math.min(10240, Number(limitKbps) || 0)) * 1024);
  if (result.ok) return result;
  if (result.status) throw new Error(`${pageError}${target.host} 返回 HTTP ${result.status}`);

  let permitted = null;
  try { permitted = await chrome.permissions.contains({ origins: [`${target.origin}/*`] }); }
  catch { /* 权限查询失败时仍保留网络错误 */ }
  if (permitted === false) {
    const hint = target.hostname === 'cdn.nlark.com'
      ? '请重新加载 0.3.1 或更新版本的扩展，并在扩展详情中允许访问 cdn.nlark.com'
      : '该图片域名未获扩展访问权限，且当前跨域请求失败';
    throw new Error(`${pageError}${target.host} 读取失败：${hint}（${result.error}）`);
  }
  throw new Error(`${pageError}${target.host} 读取失败：${result.error}；请检查网络、代理或图片链接是否仍有效`);
}

/** 通过 content script 读当前标签页的 DOM（Markdown 接口失效时的兜底） */
async function scrapeDocFromTab(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const SELECTORS = [
        '.ne-viewer-body',
        '[data-slate-viewer]',
        '.lake-content',
        '.ne-doc-major-editor',
        'main',
      ];
      let el = null;
      for (const sel of SELECTORS) {
        el = document.querySelector(sel);
        if (el) break;
      }
      if (!el) return { ok: false, error: '没找到正文容器，请确认当前页是语雀文档页' };
      const titleEl = document.querySelector('.doc-title, .ne-doc-title, h1');
      return {
        ok: true,
        title: titleEl ? titleEl.textContent.trim() : document.title,
        html: el.innerHTML,
      };
    },
  });
  const r = injected && injected[0] && injected[0].result;
  if (!r || !r.ok) throw new Error((r && r.error) || '读取页面失败');
  return r;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'PAGE_FETCH': {
          const r = await fetchViaPage(msg.url, false, msg.limitKbps);
          sendResponse({ ok: true, text: r.text, mime: r.mime, status: r.status });
          break;
        }
        case 'PAGE_FETCH_BIN': {
          const r = await fetchBinary(msg.url, msg.limitKbps);
          sendResponse({ ok: true, b64: r.b64, mime: r.mime, status: r.status });
          break;
        }
        case 'SCRAPE_TAB': {
          const r = await scrapeDocFromTab(msg.tabId);
          sendResponse({ ok: true, title: r.title, html: r.html });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // 异步响应
});

// 点图标直接开侧栏（SW 重启后这个设置会丢，所以顶层也设一次）
function enableActionOpensPanel() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
enableActionOpensPanel();
chrome.runtime.onInstalled.addListener(enableActionOpensPanel);
