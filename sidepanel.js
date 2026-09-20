'use strict';

/* ============================ 小工具 ============================ */

const $ = (id) => document.getElementById(id);

function log(msg, isErr) {
  const el = $('log');
  const line = document.createElement('div');
  if (isErr) line.className = 'err';
  const t = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setStatus(msg) { $('statusText').textContent = msg; }

function setProgress(done, total) {
  $('barFill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把目录节点还原成完整的文档地址。
 * 语雀目录里通常只给一个 slug，不带 /用户/知识库 前缀，
 * 直接 new URL(slug, origin) 会拼出 yuque.com/{slug} 这种不存在的地址。
 */
function buildDocUrl(node) {
  const p = String((node && node.url) || (node && node._slug) || '').trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;

  const segs = p.split('/').filter(Boolean);
  const need = (treeState.bookSegments || []).length + 1;
  if (segs.length >= need && treeState.origin) {
    return treeState.origin + '/' + segs.join('/');
  }

  // 只给了 slug，用当前知识库的 /用户/知识库 补前缀
  const slug = segs[segs.length - 1] || '';
  if (!slug || !treeState.bookPath) return null;
  return treeState.origin + treeState.bookPath + '/' + slug;
}

/** 拼语雀接口地址前先清掉查询串/锚点/尾斜杠，否则会拼出 /slug?x=1/markdown 这种坏 URL */
function cleanDocUrl(raw) {
  let s = String(raw || '').split('#')[0].split('?')[0];
  return s.replace(/\/+$/, '');
}

function sanitizeSegment(name, fallback) {
  let s = String(name || '').replace(YQ_CFG.illegalPathChars, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s) s = fallback || 'untitled';
  return s.slice(0, 80);
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ============================ 与后台通信 ============================ */

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(r);
    });
  });
}

async function pageFetch(url) {
  const r = await sendBg({ type: 'PAGE_FETCH', url });
  if (!r || !r.ok) throw new Error((r && r.error) || '请求失败');
  return r.text;
}

/* ============================ 当前页面 ============================ */

let currentTab = null;

async function readCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const info = $('pageInfo');
  if (!tab || !tab.url) { info.textContent = '读不到当前标签页'; return null; }

  let u;
  try { u = new URL(tab.url); } catch { info.textContent = tab.url; return null; }
  if (!/(^|\.)yuque\.com$/i.test(u.hostname)) {
    info.textContent = `当前不是语雀页面（${u.hostname}）`;
    return null;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  info.textContent = `${u.host} · ${segs.length ? segs.join(' / ') : '首页'}`;
  return { origin: u.origin, host: u.host, segments: segs, href: tab.url };
}

/** 文档页 → 知识库首页；知识库页 → 自己 */
function toBookUrl(page) {
  if (!page) return null;
  const segs = page.segments.slice();
  // 语雀文档页是 /user/repo/slug，知识库页是 /user/repo
  while (segs.length > 2) segs.pop();
  if (!segs.length) return null;
  return page.origin + '/' + segs.join('/');
}

/* ============================ 从页面 HTML 里挖 appData ============================ */

/** 从 html 的某个位置开始，按括号配对抠出一个完整 JSON 对象 */
function balancedObject(html, from) {
  const start = html.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 语雀把整个 appData 塞在 decodeURIComponent("...") 里 */
function fromDecodeUriComponent(html) {
  const s = html.replace(/[\r\n\t]/g, '');
  const marker = 'decodeURIComponent("';
  let idx = s.indexOf(marker);
  while (idx !== -1) {
    const start = idx + marker.length;
    const end = s.indexOf('")', start);
    if (end !== -1) {
      try {
        return JSON.parse(decodeURIComponent(s.slice(start, end)));
      } catch { /* 试下一个 */ }
    }
    idx = s.indexOf(marker, start);
  }
  return null;
}

function extractAppData(html) {
  const candidates = [];
  const a = fromDecodeUriComponent(html);
  if (a) candidates.push(a);

  for (const marker of ['window.appData', 'window.__appData', '"appData"', '__INITIAL_STATE__']) {
    const i = html.indexOf(marker);
    if (i === -1) continue;
    const obj = balancedObject(html, i + marker.length);
    if (obj) candidates.push(obj);
  }
  return candidates;
}

/** 在一坨 JSON 里找最像目录的那个数组 */
function scoreTocArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  let hits = 0;
  for (const it of arr) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const title = it.title !== undefined ? it.title : it.name;
    const url = it.url !== undefined ? it.url : it.slug;
    if (typeof title === 'string' && title.trim() && typeof url === 'string' && url.trim()) hits++;
  }
  return hits / arr.length >= 0.7 ? hits : 0;
}

function findTocArray(root) {
  let best = null;
  const seen = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 10) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      const score = scoreTocArray(o);
      if (score > 0 && (!best || score > best.score)) best = { score, arr: o };
      for (const it of o) walk(it, depth + 1);
    } else {
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    }
  })(root, 0);
  return best ? best.arr : null;
}

/** 把各种形态的目录数组统一成 { title, url, children } 树 */
function normalizeToc(arr) {
  if (!arr || !arr.length) return [];

  const makeNode = (it) => ({
    title: String((it.title !== undefined ? it.title : it.name) || '').trim(),
    url: String(it.url !== undefined ? it.url : (it.slug || '')).trim(),
    _slug: String(it.slug || '').trim(),
    children: [],
  });

  // 形态一：本身就已经是嵌套的
  if (arr.some((it) => it && Array.isArray(it.children) && it.children.length)) {
    const conv = (list) => list
      .filter((it) => it && typeof it === 'object')
      .map((it) => {
        const n = makeNode(it);
        n.children = Array.isArray(it.children) ? conv(it.children) : [];
        return n;
      });
    return conv(arr);
  }

  // 形态二：靠 uuid / parent_uuid 关联
  if (arr.some((it) => it && it.uuid && it.parent_uuid !== undefined)) {
    const byId = new Map();
    const roots = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const n = makeNode(it);
      n._id = it.uuid;
      n._parent = it.parent_uuid;
      byId.set(n._id, n);
    }
    for (const n of byId.values()) {
      const p = n._parent ? byId.get(n._parent) : null;
      if (p) p.children.push(n); else roots.push(n);
    }
    return roots;
  }

  // 形态三：扁平 + depth / level（语雀实际用的是 level）
  if (arr.some((it) => it && (typeof it.depth === 'number' || typeof it.level === 'number'))) {
    const roots = [];
    const stack = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const n = makeNode(it);
      const raw = it.depth !== undefined ? it.depth : it.level;
      const d = Math.max(0, Number(raw) || 0);
      stack.length = Math.min(stack.length, d);
      if (d === 0 || !stack.length) roots.push(n);
      else stack[stack.length - 1].children.push(n);
      stack[d] = n;
    }
    return roots;
  }

  // 形态四：纯扁平
  return arr.filter((it) => it && typeof it === 'object').map(makeNode);
}

/** 去掉纯文件夹节点（没有 url 的都是分组） */
function pruneTree(nodes) {
  const out = [];
  for (const n of nodes) {
    n.children = pruneTree(n.children || []);
    if (!n.url && !n.children.length) continue;
    out.push(n);
  }
  return out;
}

/** 给每个节点记上它的父级文件夹链，导出时才知道该写到哪个子目录 */
function annotateParents(nodes, parents) {
  for (const n of nodes) {
    n._parents = parents;
    const child = n.title ? parents.concat(sanitizeSegment(n.title, '分组')) : parents;
    if (n.children && n.children.length) annotateParents(n.children, child);
  }
  return nodes;
}

/* ============================ 目录树渲染 ============================ */

let treeState = {
  nodes: [], bookName: '', origin: '', bookId: '', bookPath: '', bookSegments: [],
};
const collapsed = new Set();

// 侧栏 checkbox 上存父级路径用的分隔符，不可能出现在文件夹名里
const PARENT_SEP = String.fromCharCode(1);

function countDocs(nodes) {
  let n = 0;
  for (const x of nodes) { if (x.url) n++; n += countDocs(x.children || []); }
  return n;
}

function renderTree() {
  const box = $('tree');
  box.textContent = '';
  const frag = document.createDocumentFragment();

  const walk = (nodes, path, depth) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const myPath = path + '/' + i;
      const hasKids = node.children && node.children.length;
      const row = document.createElement('div');
      row.className = 'node';
      row.style.paddingLeft = `${depth * 12}px`;

      const caret = document.createElement('span');
      caret.className = 'caret' + (hasKids ? '' : ' leaf');
      caret.textContent = hasKids ? (collapsed.has(myPath) ? '▸' : '▾') : '';
      row.appendChild(caret);

      const label = document.createElement('label');
      if (node.url) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.url = node.url;
        cb.dataset.slug = node._slug || '';
        cb.dataset.title = node.title;
        cb.dataset.parents = (node._parents || []).join(PARENT_SEP);
        cb.checked = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + (node.title || node.url)));
      } else {
        label.appendChild(document.createTextNode('📁 ' + (node.title || '未命名')));
      }
      row.appendChild(label);
      frag.appendChild(row);

      if (hasKids) {
        caret.addEventListener('click', () => {
          if (collapsed.has(myPath)) collapsed.delete(myPath); else collapsed.add(myPath);
          renderTree();
        });
        if (!collapsed.has(myPath)) walk(node.children, myPath, depth + 1);
      }
    }
  };

  walk(treeState.nodes, '', 0);
  box.appendChild(frag);
  $('treeCount').textContent = `共 ${countDocs(treeState.nodes)} 篇文档`;
}

function collectChecked() {
  const out = [];
  for (const cb of $('tree').querySelectorAll('input[type=checkbox]:checked')) {
    const raw = cb.dataset.parents || '';
    out.push({
      url: cb.dataset.url,
      slug: cb.dataset.slug || '',
      title: cb.dataset.title,
      parents: raw ? raw.split(PARENT_SEP) : [],
    });
  }
  return out;
}

/* ============================ 抓目录 ============================ */

async function scan() {
  $('scanBtn').disabled = true;
  setStatus('正在读取知识库目录…');
  $('exportBtn').disabled = true;
  try {
    const page = await readCurrentTab();
    if (!page) throw new Error('请先把当前标签页切到语雀的知识库或文档页面');

    const bookUrl = toBookUrl(page);
    if (!bookUrl) throw new Error('解析不出知识库地址，请打开知识库首页再试');

    log(`读取 ${bookUrl}`);
    const html = await pageFetch(bookUrl);
    log(`页面 ${(html.length / 1024).toFixed(0)} KB，开始提取目录…`);

    const candidates = extractAppData(html);
    if (!candidates.length) throw new Error('页面里没找到 appData，点「DOM 兜底」试试');

    let toc = null;
    for (const c of candidates) { toc = findTocArray(c); if (toc) break; }
    if (!toc) throw new Error('找到了 appData 但里面没有目录数组，点「DOM 兜底」试试');

    // 打一条样本出来：目录节点里到底有哪些字段，出问题时靠这行定位
    log(`目录节点字段：${Object.keys(toc[0] || {}).join(', ')}`);
    log(`样例：${JSON.stringify(toc[0] || {}).slice(0, 400)}`);

    const nodes = annotateParents(pruneTree(normalizeToc(toc)), []);
    if (!nodes.length) throw new Error('目录是空的');

    let bookName = '';
    let bookId = '';
    for (const c of candidates) {
      const book = findBookObject(c);
      if (book) {
        bookName = book.name || '';
        if (book.id !== undefined && book.id !== null) bookId = String(book.id);
        break;
      }
    }
    if (!bookName) {
      const segs = page.segments;
      bookName = segs.length >= 2 ? segs[1] : (segs[0] || '语雀导出');
    }

    const bookSegs = page.segments.slice(0, 2);
    treeState = {
      nodes,
      bookName: sanitizeSegment(bookName, '语雀导出'),
      origin: page.origin,
      bookId,
      bookPath: '/' + bookSegs.join('/'),
      bookSegments: bookSegs,
    };
    $('bookTitle').textContent = treeState.bookName;
    $('treeCard').hidden = false;
    collapsed.clear();
    renderTree();
    $('exportBtn').disabled = false;
    setStatus(`目录就绪：${countDocs(nodes)} 篇文档`);
    log(`目录解析成功：${countDocs(nodes)} 篇文档`);
  } catch (e) {
    setStatus('读取目录失败');
    log(e.message, true);
  } finally {
    $('scanBtn').disabled = false;
  }
}

function findBookName(root) {
  const book = findBookObject(root);
  return book ? book.name : '';
}

/** 找一个像"知识库"的对象：有数字 id 且带 slug / toc */
function findBookObject(root) {
  const seen = new Set();
  let found = null;
  (function walk(o, depth) {
    if (found || !o || typeof o !== 'object' || depth > 8 || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && typeof o.name === 'string' && typeof o.slug === 'string' &&
        (o.toc || o.description !== undefined || o.items_count !== undefined)) {
      found = o;
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(root, 0);
  return found;
}

async function scanByDom() {
  $('scrapeBtn').disabled = true;
  setStatus('正在从侧边栏 DOM 读取…');
  try {
    const page = await readCurrentTab();
    if (!page || !currentTab) throw new Error('读不到当前标签页');
    const r = await new Promise((resolve) => {
      chrome.tabs.sendMessage(currentTab.id, { type: 'SCRAPE_TOC' }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp);
      });
    });
    if (!r || !r.ok) throw new Error((r && r.error) || 'DOM 读取失败');

    // 用栈按顺序还原层级，不能按 depth 分组（那会把子节点复制到每个父节点下）
    const roots = [];
    const stack = [];
    for (const n of r.nodes) {
      const node = { title: n.title, url: n.url, children: [] };
      while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ depth: n.depth, node });
    }

    const nodes = annotateParents(pruneTree(roots), []);
    if (!nodes.length) throw new Error('DOM 里没解析出文档');

    const bookSegs = page.segments.slice(0, 2);
    treeState = {
      nodes,
      bookName: sanitizeSegment(page.segments[1] || page.segments[0] || '语雀导出', '语雀导出'),
      origin: page.origin,
      bookId: '',
      bookPath: '/' + bookSegs.join('/'),
      bookSegments: bookSegs,
    };
    $('bookTitle').textContent = treeState.bookName;
    $('treeCard').hidden = false;
    collapsed.clear();
    renderTree();
    $('exportBtn').disabled = false;
    setStatus(`目录就绪（DOM 兜底）：${countDocs(nodes)} 篇文档`);
    log(`DOM 兜底成功：${countDocs(nodes)} 篇文档`);
  } catch (e) {
    setStatus('DOM 兜底失败');
    log(e.message, true);
  } finally {
    $('scrapeBtn').disabled = false;
  }
}

/* ============================ 落盘 ============================ */

function chromeDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || '下载失败'));
      } else resolve(id);
    });
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return chromeDownload({ url, filename, conflictAction: 'uniquify', saveAs: false })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}

/**
 * 存文本文件。
 *
 * Blob 的 type 一律用 application/octet-stream：Chrome 的下载接口会按 MIME
 * 改写扩展名，给 text/plain 就把 `文档.lake` 存成 `文档.txt`，无视 filename。
 * octet-stream 没有对应扩展名映射，才会老老实实用我们指定的名字。
 */
function saveText(filename, text) {
  return saveBlob(new Blob([text], { type: 'application/octet-stream' }), filename);
}

function saveBinary(filename, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return saveBlob(new Blob([bytes]), filename);
}

/* ============================ 取正文 ============================ */

function looksLikeHtml(t) {
  return /^\s*(<!doctype|<html|<\?xml)/i.test(t) || /class="ne-viewer-body"/.test(t);
}

function normalizeMarkdownResponse(text) {
  const t = String(text || '').replace(/^﻿/, '');
  if (!t.trim()) return '';
  if (looksLikeHtml(t)) {
    log('  返回的是 HTML，本地转成 Markdown');
    return YQHtmlToMd(t);
  }
  return t;
}

async function fetchMarkdown(docUrl, doc) {
  // 线路一：语雀官方的 Markdown 导出接口
  try {
    const text = await pageFetch(YQ_CFG.markdownUrl(docUrl));
    const md = normalizeMarkdownResponse(text);
    if (md.trim()) return md;
  } catch (e) {
    log(`  Markdown 接口失败：${e.message}`, true);
  }

  // 线路二：文档详情接口，取 body_html 自己转
  const slug = docUrl.split('/').filter(Boolean).pop();
  if (doc.bookId && slug) {
    try {
      const raw = await pageFetch(YQ_CFG.docApiUrl(treeState.origin, slug, doc.bookId));
      const parsed = JSON.parse(raw);
      const data = parsed.data || parsed;
      const html = data.body_html || data.body_draft_html || '';
      if (html) return YQHtmlToMd(html);
      // body 是 lake 源码，尽量从里面刮出纯文本
      const lake = data.body || data.body_draft || '';
      if (lake) {
        log('  只有 lake 源码，降级成纯文本');
        return lakeToPlainText(lake);
      }
    } catch (e) {
      log(`  详情接口也失败：${e.message}`, true);
    }
  } else if (!doc.bookId) {
    log('  没有 book_id，跳过详情接口兜底', true);
  }
  return '';
}

/** lake 源码是嵌套 JSON，兜底扒出其中所有 text 字段 */
function lakeToPlainText(lake) {
  const text = String(lake);
  let doc;
  try { doc = JSON.parse(text); } catch { return text; }
  const parts = [];
  const seen = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 30 || seen.has(o)) return;
    seen.add(o);
    if (typeof o.text === 'string' && o.text) parts.push(o.text);
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(doc, 0);
  return parts.join('\n\n');
}

/** base64 头部解码出前若干字节，用来嗅探真实类型（不能信后缀） */
function b64Head(b64, bytes) {
  const take = Math.ceil(Math.max(1, bytes) / 3) * 4;
  try { return atob(String(b64).slice(0, take)); } catch { return ''; }
}

/**
 * 取「原始导出文件」。
 *
 * 实测：语雀的 /lake 是通的，返回的不是 JSON，而是一份 lake 文档：
 *   <!doctype lake><title>...</title><meta .../><h2 data-lake-id="...">标题</h2>
 *   <card type="inline" name="image" value="data:%7B%22src%22%3A%22https...%22%7D"></card>
 * 所以按 `<!doctype lake>` 认它，别拿 JSON.parse 去试。
 * /docx 在普通文档上是 404，只当 /lake 完全失败时的兜底。
 */
/**
 * 判断 /lake 返回的到底是什么。
 * 返回 'lake' | 'html' | ''（认不出）。
 * 抽成纯函数是为了能单测——这里判错一次就白存一堆 .html。
 */
function classifyExportText(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('[')) return 'lake';      // 少数情况下是真的 JSON
  if (/^<!doctype\s+lake/i.test(t)) return 'lake';                // 实际见到的形态
  if (t.startsWith('<')) return 'html';
  return '';
}

async function fetchRawExport(docUrl, logFn) {
  try {
    const text = await pageFetch(YQ_CFG.lakeUrl(docUrl));
    const t = String(text).trim();
    const kind = classifyExportText(t);
    if (kind === 'lake') return { kind: 'lake', text: t, ext: '.lake', mime: 'text/plain' };
    if (kind === 'html') return { kind: 'html', text: t, ext: '.html', mime: 'text/html' };
    logFn(`  /lake 返回了认不出的内容：${t.slice(0, 60).replace(/\s+/g, ' ')}`);
  } catch (e) {
    logFn(`  /lake 失败：${e.message}`);
  }

  const r = await sendBg({ type: 'PAGE_FETCH_BIN', url: YQ_CFG.docxUrl(docUrl) });
  if (!r || !r.ok) throw new Error((r && r.error) || '/docx 请求失败');
  const head = b64Head(r.b64, 300);
  if (head.startsWith('PK')) return { kind: 'docx', b64: r.b64, ext: '.docx', mime: '' };
  if (/^\s*</.test(head)) return { kind: 'html', b64: r.b64, ext: '.html', mime: 'text/html' };
  return { kind: 'bin', b64: r.b64, ext: '.bin', mime: '' };
}

/* ============================ lake 文档 → 能看的 HTML ============================ */

/**
 * lake 用自定义 <card> 元素承载表格 / 图片 / 附件，浏览器不认识这些标签，
 * 所以把 lake 原文直接存成 .html 打开就是"没图、表格也不见了"。
 * 这里把 card 展开成真正的 HTML，图片仍然指向原地址，交给后续的图片本地化改写。
 */
function expandLakeCard(attrs) {
  const name = (attrs.match(/\bname="([^"]*)"/i) || [])[1] || '';
  const raw = (attrs.match(/\bvalue="([^"]*)"/i) || [])[1] || '';
  if (!raw) return '';
  let data;
  try {
    data = JSON.parse(decodeURIComponent(raw.replace(/^data:/i, '')));
  } catch {
    return '';
  }
  const esc = YQMdToHtml.escapeHtml;

  if (name === 'image') {
    const src = data.src || data.url || '';
    return src ? `<img src="${esc(src)}" alt="${esc(data.alt || data.name || '')}" loading="lazy">` : '';
  }
  if (name === 'file' || name === 'attachment') {
    const src = data.src || data.url || '';
    if (!src) return '';
    return `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(data.name || src)}</a>`;
  }
  if (name === 'codeblock' || name === 'code') {
    const code = data.code || data.text || '';
    return code ? `<pre><code>${esc(code)}</code></pre>` : '';
  }
  // 表格 / 画板 / 思维导图，value 里带了渲染好的 html
  if (data.html) {
    const html = String(data.html);
    // 装的是 POC / 请求包时，跟 Markdown 那条路保持一致，出代码块而不是表格。
    // 直接复用 html2md 里已经测过的判断，别在这里再写一套。
    try {
      const fence = YQHtmlToMd(html).match(/```[^\n]*\n([\s\S]*?)\n```/);
      if (fence) {
        // html2md 会把 <a> 转成 markdown 链接，但代码块里要的是纯文本
        const code = fence[1].replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '$1');
        return `<pre><code>${esc(code)}</code></pre>`;
      }
    } catch { /* 转换失败就退回原表格 */ }
    return html;
  }
  return '';
}

function renderLakeToHtmlFragment(lakeText) {
  let s = String(lakeText || '');
  s = s.replace(/^<!doctype\s+lake[^>]*>/i, '');
  s = s.replace(/<title>[\s\S]*?<\/title>/i, '');
  s = s.replace(/<meta\b[^>]*\/?>/gi, '');
  s = s.replace(/<cursor\s*\/?>/gi, '');
  s = s.replace(/<card\b([^>]*?)\s*\/?>(?:<\/card>)?/gi, (m, attrs) => expandLakeCard(attrs));
  // card 展开出来的 html 里自己也带 lake 标记，所以清两遍
  s = s.replace(/\s+data-lake-id="[^"]*"/gi, '');
  return s.trim();
}

/* ============================ 语雀 Markdown 的表格降级 ============================ */

const MD_TABLE_ROW = /^\s*\|.*\|\s*$/;
const MD_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

/** 按未转义的 | 切分一行表格 */
function splitMdRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 单元格里的换行在 GFM 表格里只能写成 <br>，还原成真换行 */
function mdCellText(cell) {
  return String(cell || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function mdFence(body) {
  let f = '```';
  while (body.includes(f)) f += '`';
  return f;
}

/**
 * 语雀的 /markdown 接口会把 POC / 请求包导成"单元格里塞一堆 <br>"的表格。
 * 直接留着有两个问题：
 *   1. 渲染出来是个奇怪的大块，跟正文不搭；
 *   2. 里面的 * / _ 会被 Markdown 当成强调语法吃掉（`Accept: * /*` 就中过招）。
 * 这里把"含代码单元格"的表格整体降级成围栏代码块。
 *
 * 注意：只降级含代码的表格，普通参数表原样保留。
 */
function normalizeExportMarkdown(md) {
  const isCode = typeof YQLooksLikeCode === 'function' ? YQLooksLikeCode : () => false;
  const lines = String(md || '').split('\n');
  const out = [];
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  let i = 0;

  while (i < lines.length) {
    if (!MD_TABLE_ROW.test(lines[i])) { out.push(lines[i]); i++; continue; }

    let j = i;
    while (j < lines.length && MD_TABLE_ROW.test(lines[j])) j++;
    const block = lines.slice(i, j);
    i = j;

    const rows = block
      .filter((l) => !MD_TABLE_SEP.test(l))
      .map(splitMdRow)
      .filter((r) => r.length);

    const anyCode = rows.some((r) => r.some((c) => isCode(mdCellText(c))));
    if (!anyCode) { for (const l of block) out.push(l); continue; }

    for (const r of rows) {
      for (const c of r) {
        const t = mdCellText(c);
        if (!t) continue;
        if (isCode(t)) {
          blank();
          const fence = mdFence(t);
          out.push(fence);
          for (const l of t.split('\n')) out.push(l);
          out.push(fence);
          blank();
        } else {
          out.push(t.replace(/\n+/g, ' ').trim());
          blank();
        }
      }
    }
  }

  return out.join('\n').trim();
}

/* ============================ 图片本地化 ============================ */

async function downloadAsset(url, filename) {
  const r = await sendBg({ type: 'PAGE_FETCH_BIN', url });
  if (r && r.ok && r.b64) {
    await saveBinary(filename, r.b64);
    return 'page';
  }
  await chromeDownload({ url, filename, conflictAction: 'uniquify', saveAs: false });
  return 'direct';
}

function assetFileName(url, used) {
  let base = 'image';
  let ext = '';
  try {
    const u = new URL(url);
    base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'image');
    const dot = base.lastIndexOf('.');
    if (dot > -1 && base.length - dot <= 6) { ext = base.slice(dot); base = base.slice(0, dot); }
  } catch { /* 用默认名 */ }
  base = sanitizeSegment(base, 'image').slice(0, 60);
  let name = base + ext;
  if (used.has(name)) name = `${base}-${hashStr(url).slice(0, 5)}${ext}`;
  used.set(name, true);
  return name;
}

async function localizeImages(md, folderDepth, used, stats) {
  const rel = '../'.repeat(folderDepth) + '_assets/';
  const jobs = [];

  let out = md.replace(/(!\[[^\]]*\]\()(https?:\/\/[^)\s]+)(\))/g, (m, a, url, c) => {
    const name = assetFileName(url, used);
    jobs.push({ url, name });
    return a + rel + name + c;
  });

  out = out.replace(/(<img\b[^>]*?\bsrc=)(["'])(https?:\/\/[^"']+)\2/gi, (m, a, q, url) => {
    const name = assetFileName(url, used);
    jobs.push({ url, name });
    return a + q + rel + name + q;
  });

  for (const job of jobs) {
    if (cancelFlag) break;
    try {
      await downloadAsset(job.url, `${exportCtx.root}/_assets/${job.name}`);
      stats.images++;
    } catch (e) {
      stats.imageErrors.push(`${job.name}: ${e.message}`);
      log(`  图片失败 ${job.name}：${e.message}`, true);
    }
    await sleep(60);
  }
  return out;
}

/* ============================ 导出主流程 ============================ */

let cancelFlag = false;
const exportCtx = { root: '' };

/** 嵌套太深会让 Windows 超过路径长度上限，只保留最后 3 层 */
function capDepth(parents) {
  const p = Array.isArray(parents) ? parents : [];
  return p.length > 3 ? p.slice(-3) : p;
}

async function exportOne(doc, opts, stats) {
  const resolved = buildDocUrl({ url: doc.url, _slug: doc.slug });
  if (!resolved) throw new Error('拼不出文档地址（目录节点里既没有 url 也没有 slug）');
  const docUrl = cleanDocUrl(resolved);
  try {
    await exportDoc(doc, docUrl, opts, stats);
  } catch (e) {
    // 把实际请求的地址带上，不然出问题只能靠猜
    throw new Error(`${e.message} — ${docUrl}`);
  }
}

async function exportDoc(doc, docUrl, opts, stats) {
  const parents = capDepth(doc.parents);
  const folder = parents.length ? parents.join('/') + '/' : '';
  const baseName = sanitizeSegment(doc.title, 'untitled');
  const depth = parents.length;

  if (opts.md || opts.html) {
    let md = await fetchMarkdown(docUrl, doc);
    if (!md.trim()) {
      throw new Error('Markdown 和详情接口都没拿到正文');
    }
    md = normalizeExportMarkdown(md);

    if (opts.images) {
      md = await localizeImages(md, depth, opts.used, stats);
    }
    if (opts.md) {
      await saveText(`${exportCtx.root}/${folder}${baseName}.md`, md);
      stats.docs++;
    }
    if (opts.html) {
      const { html } = YQMdToHtml.render(md, doc.title);
      await saveText(`${exportCtx.root}/${folder}${baseName}.html`, html);
      stats.docs++;
    }
  }

  if (opts.lake) {
    const raw = await fetchRawExport(docUrl, log);
    const target = `${exportCtx.root}/${folder}${baseName}${raw.ext}`;

    if (raw.kind === 'lake') {
      // 原始 lake 文档，原样存一份
      await saveText(target, raw.text);
      stats.docs++;

      // 再出一份能直接打开看的 HTML（card 展开 + 图片本地化）
      let frag = renderLakeToHtmlFragment(raw.text);
      if (opts.images) {
        frag = await localizeImages(frag, depth, opts.used, stats);
      }
      await saveText(`${exportCtx.root}/${folder}${baseName}.html`,
        YQMdToHtml.page(doc.title, frag), 'text/html');
      stats.docs++;
      log('  → 原始导出：.lake + 可读 .html');
    } else if (raw.kind === 'html') {
      await saveText(target, raw.text);
      stats.docs++;
      log(`  → 原始导出：${raw.kind}${raw.ext}`);
    } else {
      await saveBinary(target, raw.b64);
      stats.docs++;
      log(`  → 原始导出：${raw.kind}${raw.ext}`);
    }
  }
}

async function runExport() {
  const docs = collectChecked();
  if (!docs.length) { log('没有勾选任何文档', true); return; }

  const opts = {
    md: $('fmtMd').checked,
    html: $('fmtHtml').checked,
    lake: $('fmtLake').checked,
    images: $('localizeImg').checked,
  };
  if (!opts.md && !opts.html && !opts.lake) opts.images = false;
  if (!opts.md && !opts.html && !opts.lake) { log('至少选一种导出格式', true); return; }

  const bookId = treeState.bookId || '';
  for (const d of docs) d.bookId = bookId;

  cancelFlag = false;
  exportCtx.root = treeState.bookName;
  const stats = { docs: 0, images: 0, failed: [], imageErrors: [], used: new Map() };
  let done = 0;

  $('exportBtn').disabled = true;
  $('cancelBtn').disabled = false;
  $('scanBtn').disabled = true;
  setProgress(0, docs.length);
  setStatus(`开始导出 ${docs.length} 篇…`);
  log(`导出到「下载/${exportCtx.root}/」，共 ${docs.length} 篇`);

  const limit = Math.max(1, Math.min(6, Number(YQ_CFG.concurrency) || 3));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, docs.length) }, async () => {
    while (cursor < docs.length && !cancelFlag) {
      const doc = docs[cursor++];
      try {
        await exportOne(doc, { ...opts, used: stats.used }, stats);
        log(`✓ ${doc.title || doc.url}`);
      } catch (e) {
        stats.failed.push({ title: doc.title, error: e.message });
        log(`✗ ${doc.title || doc.url} — ${e.message}`, true);
      }
      done++;
      setProgress(done, docs.length);
      setStatus(`进度 ${done}/${docs.length}`);
      await sleep(YQ_CFG.delayMs);
    }
  });

  await Promise.all(workers);

  $('exportBtn').disabled = false;
  $('cancelBtn').disabled = true;
  $('scanBtn').disabled = false;

  const tail = [
    cancelFlag ? '已手动停止' : '导出完成',
    `成功 ${stats.docs} 个文件`,
    opts.images ? `图片 ${stats.images} 张` : null,
    stats.failed.length ? `失败 ${stats.failed.length} 篇` : null,
    stats.imageErrors.length ? `图片失败 ${stats.imageErrors.length} 张` : null,
  ].filter(Boolean).join(' · ');
  setStatus(tail);
  log(tail);
  if (stats.failed.length) {
    log('失败清单：', true);
    for (const f of stats.failed) log(`  ${f.title} — ${f.error}`, true);
  }
}

/* ============================ 事件绑定 ============================ */

$('scanBtn').addEventListener('click', scan);
$('scrapeBtn').addEventListener('click', scanByDom);
$('exportBtn').addEventListener('click', runExport);
$('cancelBtn').addEventListener('click', () => {
  cancelFlag = true;
  setStatus('正在停止…');
});
$('selectAllBtn').addEventListener('click', () => {
  for (const cb of $('tree').querySelectorAll('input[type=checkbox]')) cb.checked = true;
});
$('selectNoneBtn').addEventListener('click', () => {
  for (const cb of $('tree').querySelectorAll('input[type=checkbox]')) cb.checked = false;
});
$('clearLogBtn').addEventListener('click', () => { $('log').textContent = ''; });

readCurrentTab();
