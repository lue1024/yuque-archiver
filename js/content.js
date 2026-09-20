/**
 * content script：只在需要时被调用，不主动做任何事。
 * 提供两件事：
 *   1. 当前页面的基本信息（URL / 标题 / 登录态线索）
 *   2. 从知识库侧边栏 DOM 里刮出目录树（HTML 解析路线失效时的兜底）
 */

function parsePath(href) {
  try {
    const u = new URL(href, location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    return { origin: u.origin, host: u.host, parts };
  } catch {
    return null;
  }
}

function getPageState() {
  const p = parsePath(location.href);
  let loggedIn = false;
  try {
    // 语雀在页面上挂了 appData，隔离世界里读不到，只能靠 cookie 线索判断
    loggedIn = /(^|;\s*)_yuque_session=/.test(document.cookie) ||
      !!document.querySelector('a[href*="/logout"], [class*="avatar"], [class*="user-menu"]');
  } catch { /* ignore */ }
  return {
    href: location.href,
    origin: p ? p.origin : '',
    host: p ? p.host : '',
    parts: p ? p.parts : [],
    title: document.title,
    loggedIn,
  };
}

/**
 * 从侧边栏刮目录。只在"抓页面 HTML 提 JSON"那条路失败时用。
 * 返回扁平列表，depth 用左偏移粗略估算。
 */
function scrapeSidebarToc() {
  const state = getPageState();
  if (state.parts.length < 2) return { ok: false, error: '当前页不是知识库页面' };
  const prefix = `/${state.parts[0]}/${state.parts[1]}/`;

  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
    try {
      const u = new URL(a.href, location.href);
      return u.host === state.host && u.pathname.startsWith(prefix) &&
        u.pathname.split('/').filter(Boolean).length >= 3;
    } catch { return false; }
  });
  if (!anchors.length) return { ok: false, error: '侧边栏里没找到文档链接，请先在页面上展开知识库目录' };

  const lefts = anchors.map((a) => a.getBoundingClientRect().left);
  const minLeft = Math.min(...lefts.filter((n) => n > 0).concat([0]));
  const seen = new Set();
  const nodes = [];

  for (const a of anchors) {
    const u = new URL(a.href, location.href);
    const key = u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const left = a.getBoundingClientRect().left;
    nodes.push({
      title: (a.textContent || '').trim() || decodeURIComponent(u.pathname.split('/').pop()),
      url: u.pathname + u.search,
      depth: Math.max(0, Math.round((left - minLeft) / 16)),
      type: 'doc',
    });
  }
  return { ok: true, nodes, host: state.host, origin: state.origin };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    switch (msg && msg.type) {
      case 'GET_PAGE_STATE':
        sendResponse({ ok: true, state: getPageState() });
        break;
      case 'SCRAPE_TOC':
        sendResponse(scrapeSidebarToc());
        break;
      default:
        sendResponse({ ok: false, error: '未知消息: ' + (msg && msg.type) });
    }
  } catch (e) {
    sendResponse({ ok: false, error: e.message || String(e) });
  }
  return true;
});
