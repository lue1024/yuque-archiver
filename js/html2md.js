/**
 * HTML → Markdown。零依赖、不依赖 DOMParser。
 *
 * 用在兜底路径上：Markdown 导出接口拿不到、或语雀返回的是 HTML 时，
 * 把 body_html / 页面 DOM 转成 Markdown。
 * 目标是语雀富文本编辑器产出的那类规整 HTML，不是通用容错解析器。
 */
(function (global) {
  'use strict';

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const DROP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'object']);
  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
    'dd', 'dt', 'main', 'aside', 'nav', 'address', 'center',
  ]);

  function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s;
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
      laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
      middot: '·', times: '×', divide: '÷', deg: '°', bull: '•', shy: '',
    };
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return Object.prototype.hasOwnProperty.call(named, e) ? named[e] : m;
    });
  }

  function parseAttrs(raw) {
    const attrs = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(raw))) {
      const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
      attrs[m[1].toLowerCase()] = decodeEntities(val);
    }
    return attrs;
  }

  function tokenize(html) {
    const s = String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
      .replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt === -1) { tokens.push({ t: 'text', v: s.slice(i) }); break; }
      if (lt > i) tokens.push({ t: 'text', v: s.slice(i, lt) });
      const gt = s.indexOf('>', lt);
      if (gt === -1) { tokens.push({ t: 'text', v: s.slice(lt) }); break; }
      let inner = s.slice(lt + 1, gt);
      if (inner[0] === '/') {
        tokens.push({ t: 'close', name: inner.slice(1).trim().toLowerCase() });
      } else {
        const selfClose = inner.endsWith('/');
        if (selfClose) inner = inner.slice(0, -1);
        const sp = inner.search(/\s/);
        const name = (sp === -1 ? inner : inner.slice(0, sp)).trim().toLowerCase();
        tokens.push({ t: 'open', name, attrs: parseAttrs(sp === -1 ? '' : inner.slice(sp)), selfClose });
      }
      i = gt + 1;
    }
    return tokens;
  }

  /** 判断一段文本是不是"代码/POC/请求包"，是的话该进围栏代码块而不是表格 */
  function looksLikeCode(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (/\bHTTP\/1\.[01]/.test(t)) return true;
    if (/^\s*(?:Host|Content-Type|Content-Length|User-Agent|Referer|Cookie|Authorization|Accept|Origin|X-Forwarded-For)\s*:/m.test(t)) return true;
    if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|UNION\s+SELECT)\b/i.test(t)) return true;
    if (/(^|\n)\s*(?:curl|wget|nmap|sqlmap|python3?|bash|sh|powershell|nc)\s/.test(t)) return true;
    if (/<\?php|<%@|\bimport\s+[\w.]+|\bfrom\s+[\w.]+\s+import\b|\bdef\s+\w+\s*\(/.test(t)) return true;
    return false;
  }

  function convert(html) {
    const tokens = tokenize(html);

    const out = [];
    let cur = '';
    let bqDepth = 0;
    const listStack = [];
    let dropDepth = 0;
    let preDepth = 0;
    let preBuf = '';
    let table = null;
    let cellBuf = null;        // 非 null 表示正在采集某个单元格
    const linkStack = [];

    const prefix = () => '> '.repeat(bqDepth);
    function flushLine() {
      const t = cur.replace(/[ \t]+$/, '');
      if (t.trim() !== '') out.push(prefix() + t);
      cur = '';
    }
    function blank() {
      flushLine();
      // 引用块里的空行也要带 > 前缀，否则后面几行会掉出引用
      const filler = bqDepth > 0 ? '>'.repeat(bqDepth) : '';
      if (out.length && out[out.length - 1] !== filler && out[out.length - 1] !== '') out.push(filler);
    }
    function rawLine(text) { flushLine(); out.push(text === '' ? prefix() + '' : prefix() + text); }
    // 表格单元格用独立缓冲：逐个 push 到 cur 再按长度切片会被 <br> 之类的换行打乱
    function emit(s) { if (cellBuf !== null) cellBuf += s; else cur += s; }
    function indentFor() { return '  '.repeat(Math.max(0, listStack.length - 1)); }


    function emitCodeBlock(text) {
      const body = String(text).replace(/^\n+/, '').replace(/\s+$/, '');
      if (!body) return;
      let fence = '```';
      while (body.includes(fence)) fence += '`';
      rawLine(fence);
      for (const l of body.split('\n')) rawLine(l);
      rawLine(fence);
      out.push('');
    }

    function renderTable(t) {
      const rows = t.rows.filter((r) => r && r.length);
      if (!rows.length) return;
      const width = Math.max(...rows.map((r) => r.length));

      // 单列表格基本都是语雀拿来做版式的；多列表格里只要有单元格装着
      // POC / 请求包这类内容，也一起降级。当表格渲染的话，单元格里的换行
      // 只能塞成 <br>，再往下走一层渲染器一转义就变成字面量文本了。
      const anyCode = rows.some((r) => r.some((c) => looksLikeCode(c)));
      if (width <= 1 || anyCode) {
        for (const r of rows) {
          for (const c of r) {
            const cell = String(c || '');
            if (!cell.trim()) continue;
            if (looksLikeCode(cell)) {
              blank();
              emitCodeBlock(cell);
            } else {
              for (const para of cell.split(/\n{2,}/)) {
                const p = para.replace(/\s*\n\s*/g, ' ').trim();
                if (p) rawLine(p);
              }
            }
          }
        }
        return;
      }

      const clean = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim();
      const pad = (r) => { const c = r.map(clean); while (c.length < width) c.push(''); return c; };
      rawLine('| ' + pad(rows[0]).join(' | ') + ' |');
      rawLine('| ' + new Array(width).fill('---').join(' | ') + ' |');
      for (let i = 1; i < rows.length; i++) rawLine('| ' + pad(rows[i]).join(' | ') + ' |');
    }

    for (const tk of tokens) {
      if (tk.t === 'text') {
        if (dropDepth) continue;
        const v = decodeEntities(tk.v);
        if (preDepth) { preBuf += v; continue; }
        emit(v.replace(/\s+/g, ' '));
        continue;
      }

      if (tk.name === 'script' || tk.name === 'style' || tk.name === 'noscript' ||
        tk.name === 'iframe' || tk.name === 'svg' || tk.name === 'canvas' || tk.name === 'object') {
        if (tk.t === 'open' && !tk.selfClose) dropDepth++;
        else if (tk.t === 'close') dropDepth = Math.max(0, dropDepth - 1);
        continue;
      }
      if (dropDepth) continue;

      const a = tk.attrs || {};
      const isOpen = tk.t === 'open';

      // 单元格里碰到块级标签只能记一个换行：走 blank() 是往 out 里写，
      // 那样内容会跑到单元格外面，而且 `<p>a</p><p>b</p>` 会粘成 "ab"
      if (isOpen && !VOID_TAGS.has(tk.name)) {
        if (BLOCK_TAGS.has(tk.name) && cellBuf === null) blank();
      } else if (tk.t === 'close' && BLOCK_TAGS.has(tk.name)) {
        if (cellBuf !== null) cellBuf += '\n';
        else blank();
        continue;
      }

      switch (tk.name) {
        case 'br':
          if (!isOpen) break;
          if (cellBuf !== null) cellBuf += '\n';   // 单元格里换行不能走 flushLine，会打乱缓冲
          else flushLine();
          break;

        case 'hr':
          if (isOpen) { blank(); rawLine('---'); out.push(''); }
          break;

        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          if (isOpen) { blank(); emit('#'.repeat(Number(tk.name[1])) + ' '); }
          else blank();
          break;

        case 'strong': case 'b':
          if (!preDepth) emit('**');
          break;
        case 'em': case 'i':
          if (!preDepth) emit('*');
          break;
        case 'del': case 's': case 'strike':
          if (!preDepth) emit('~~');
          break;
        case 'u':
          if (!preDepth) emit(isOpen ? '<u>' : '</u>');
          break;
        case 'sub': case 'sup':
          emit(isOpen ? `<${tk.name}>` : `</${tk.name}>`);
          break;

        case 'code':
          if (!preDepth) emit('`');
          break;

        case 'pre':
          if (isOpen) {
            blank();
            preDepth++;
            preBuf = '';
          } else {
            preDepth = Math.max(0, preDepth - 1);
            const lang = String(a['data-lang'] || a.lang || '').replace(/[^\w+#-]/g, '');
            rawLine('```' + lang);
            for (const l of preBuf.replace(/\n+$/, '').split('\n')) rawLine(l);
            rawLine('```');
            out.push('');
            preBuf = '';
          }
          break;

        case 'a':
          if (isOpen) {
            const href = a.href || '';
            const usable = !/^javascript:/i.test(href);
            linkStack.push(usable ? href : '');
            if (usable && href) emit('[');
          } else {
            const href = linkStack.pop();
            if (href) emit(`](${href})`);
          }
          break;

        case 'img': {
          if (!isOpen && !tk.selfClose) break;
          const src = a.src || a['data-src'] || '';
          const alt = String(a.alt || '').replace(/[[\]]/g, '');
          if (src && !/^data:/.test(src)) emit(`![${alt}](${src})`);
          break;
        }

        case 'ul': case 'ol':
          if (isOpen) {
            if (!listStack.length) blank();
            listStack.push({ ordered: tk.name === 'ol', index: 0 });
          } else {
            listStack.pop();
            if (!listStack.length) blank();
          }
          break;

        case 'li': {
          if (isOpen) {
            flushLine();
            const top = listStack[listStack.length - 1];
            if (top) {
              top.index += 1;
              emit(indentFor() + (top.ordered ? `${top.index}. ` : '- '));
            }
          } else {
            flushLine();
          }
          break;
        }

        case 'blockquote':
          if (isOpen) { blank(); bqDepth++; }
          else {
            flushLine();
            const closingFiller = '>'.repeat(bqDepth);
            bqDepth = Math.max(0, bqDepth - 1);
            while (out.length && out[out.length - 1] === closingFiller) out.pop();
            blank();
          }
          break;

        case 'table':
          if (isOpen) { blank(); table = { rows: [], row: null }; }
          else if (table) { renderTable(table); table = null; out.push(''); }
          break;

        case 'tr':
          if (!table) break;
          if (isOpen) { flushLine(); table.row = []; }
          else { if (table.row && table.row.length) table.rows.push(table.row); table.row = null; }
          break;

        case 'td': case 'th': {
          if (!table) break;
          if (isOpen) {
            flushLine();
            cellBuf = '';
          } else if (cellBuf !== null) {
            if (table.row) table.row.push(cellBuf);
            cellBuf = null;
          }
          break;
        }

        default:
          break;
      }
    }

    if (preDepth && preBuf) {
      rawLine('```');
      for (const l of preBuf.split('\n')) rawLine(l);
      rawLine('```');
    }
    flushLine();

    return postProcess(out);
  }

  /**
   * 收尾清理。必须绕开围栏代码块：
   * 代码里的行尾空格和连续空行都是有意义的，全局去空格会改坏 POC / 配置片段。
   */
  function postProcess(lines) {
    const out = [];
    let inFence = false, fChar = '', fLen = 0, blankRun = 0;

    for (const l of lines) {
      const m = l.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m) {
        if (!inFence) { inFence = true; fChar = m[1][0]; fLen = m[1].length; }
        else if (m[1][0] === fChar && m[1].length >= fLen) { inFence = false; }
        blankRun = 0;
        out.push(l);
        continue;
      }
      if (inFence) { out.push(l); continue; }

      const t = l.replace(/[ \t]+$/, '');
      if (t === '') {
        blankRun++;
        if (blankRun > 1) continue;   // 围栏外连续空行折叠成一个
      } else {
        blankRun = 0;
      }
      out.push(t);
    }

    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  global.YQHtmlToMd = convert;
  global.YQLooksLikeCode = looksLikeCode;
  if (typeof module !== 'undefined' && module.exports) module.exports = convert;
})(typeof globalThis !== 'undefined' ? globalThis : this);
