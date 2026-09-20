/**
 * Markdown → 独立 HTML 文件。零依赖。
 * 用于「导出 HTML」：把导出的 Markdown 渲染成一个双击就能看的页面。
 */
(function (global) {
  'use strict';
  const SENT = String.fromCharCode(0);  // 占位符，用来把已生成的 HTML 从强调规则里隔离出来

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 只在纯文本上做强调，别碰已经生成的标签
  function emphasis(t) {
    let s = t;
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  function inline(text, opts) {
    const store = [];
    const keep = (html) => { store.push(html); return SENT + (store.length - 1) + SENT; };

    let s = String(text);

    // 先把行内代码、图片、链接整段摘出来换成占位符。
    // 否则后面做 *斜体* / _斜体_ 时会把生成好的标签属性也一起改掉
    // （线上就出过 target="_blank" 被吃成 target="<em>blank" 这种事）。
    s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + escapeHtml(c) + '</code>'));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (m, alt, src) => keep('<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" loading="lazy">'));
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (m, label, href) => keep('<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' +
        emphasis(escapeHtml(label)) + '</a>'));

    // 剩下的才是真正的正文
    s = escapeHtml(s);
    if (opts && opts.allowBr) s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    s = emphasis(s);

    return s.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), (m, i) => store[Number(i)]);
  }

  const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/;
  const RE = {
    heading: /^(#{1,6})\s+(.*)$/,
    hr: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
    quote: /^\s*>\s?(.*)$/,
    item: /^(\s*)([-*+]|\d+\.)\s+(.*)$/,
    tableRow: /^\s*\|(.+)\|\s*$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };

  function render(md, title) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    const listStack = [];   // { tag, indent }
    let liOpen = false;
    let para = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let fenceLang = '';
    let fenceBuf = [];
    let quoteBuf = null;
    let tableBuf = null;

    const flushPara = () => {
      if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    };
    const closeAllLists = () => {
      while (listStack.length) {
        if (liOpen) { html.push('</li>'); liOpen = false; }
        html.push(`</${listStack.pop().tag}>`);
        // 关掉子列表后，父级的 <li> 重新变成"打开"状态
        liOpen = listStack.length > 0;
      }
      liOpen = false;
    };
    // 嵌套列表要嵌在父 <li> 里面，所以开子列表时不关父 li
    const openItem = (indent, tag, text) => {
      while (listStack.length && indent < listStack[listStack.length - 1].indent) {
        if (liOpen) { html.push('</li>'); liOpen = false; }
        html.push(`</${listStack.pop().tag}>`);
        liOpen = listStack.length > 0;
      }
      let top = listStack[listStack.length - 1];
      if (top && indent === top.indent && top.tag !== tag) {
        if (liOpen) { html.push('</li>'); liOpen = false; }
        html.push(`</${listStack.pop().tag}>`);
        top = listStack[listStack.length - 1];
      }
      if (!top || indent > top.indent) {
        html.push(`<${tag}>`);
        listStack.push({ tag, indent });
      } else if (liOpen) {
        html.push('</li>');
        liOpen = false;
      }
      html.push('<li>' + inline(text));
      liOpen = true;
    };
    const flushQuote = () => {
      if (quoteBuf !== null) {
        html.push('<blockquote>' + render(quoteBuf.join('\n')).body + '</blockquote>');
        quoteBuf = null;
      }
    };
    const flushTable = () => {
      if (!tableBuf) return;
      const rows = tableBuf.filter((r) => !RE.tableSep.test(r));
      if (rows.length) {
        const cells = (r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim());
        const out = ['<table><thead><tr>'];
        out.push(cells(rows[0]).map((c) => `<th>${inline(c, { allowBr: true })}</th>`).join(''));
        out.push('</tr></thead><tbody>');
        for (let i = 1; i < rows.length; i++) {
          out.push('<tr>' + cells(rows[i]).map((c) => `<td>${inline(c, { allowBr: true })}</td>`).join('') + '</tr>');
        }
        out.push('</tbody></table>');
        html.push(out.join(''));
      }
      tableBuf = null;
    };

    for (const line of lines) {
      // 围栏要按 CommonMark 的规则配对：同一字符、且不短于开栏，
      // 否则内容里出现 ``` 时（html2md 会自动加长围栏）会提前截断
      if (inFence) {
        const cm = line.match(FENCE_RE);
        if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) {
          html.push(`<pre><code${fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : ''}>` +
            escapeHtml(fenceBuf.join('\n')) + '</code></pre>');
          inFence = false; fenceBuf = []; fenceLang = ''; fenceChar = ''; fenceLen = 0;
        } else {
          fenceBuf.push(line);
        }
        continue;
      }

      const om = line.match(FENCE_RE);
      if (om) {
        flushPara(); flushQuote(); flushTable(); closeAllLists();
        inFence = true; fenceChar = om[1][0]; fenceLen = om[1].length; fenceLang = om[2] || '';
        continue;
      }

      const qm = line.match(RE.quote);
      if (qm) {
        flushPara(); flushTable();
        if (quoteBuf === null) quoteBuf = [];
        quoteBuf.push(qm[1]);
        continue;
      }
      if (quoteBuf !== null && line.trim() === '') { quoteBuf.push(''); continue; }
      flushQuote();

      if (RE.tableRow.test(line)) {
        flushPara(); closeAllLists();
        if (!tableBuf) tableBuf = [];
        tableBuf.push(line.match(RE.tableRow)[1]);
        continue;
      }
      if (tableBuf) flushTable();

      if (line.trim() === '') { flushPara(); closeAllLists(); continue; }

      const hm = line.match(RE.heading);
      if (hm) {
        flushPara(); closeAllLists();
        const lv = hm[1].length;
        html.push(`<h${lv}>${inline(hm[2])}</h${lv}>`);
        continue;
      }

      if (RE.hr.test(line)) { flushPara(); closeAllLists(); html.push('<hr>'); continue; }

      const im = line.match(RE.item);
      if (im) {
        flushPara();
        const indent = im[1].replace(/\t/g, '  ').length;
        const tag = /\d/.test(im[2]) ? 'ol' : 'ul';
        openItem(indent, tag, im[3]);
        continue;
      }

      closeAllLists();
      para.push(line.trim());
    }

    if (inFence && fenceBuf.length) {
      html.push('<pre><code>' + escapeHtml(fenceBuf.join('\n')) + '</code></pre>');
    }
    flushPara(); flushQuote(); flushTable(); closeAllLists();

    const body = html.join('\n');
    return { body, html: page(title, body) };
  }

  function page(title, body) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || '文档')}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 820px; margin: 40px auto; padding: 0 20px;
         font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         color: #24292f; background: #fff; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.6em 0 .6em; }
  h1 { border-bottom: 1px solid #e5e7eb; padding-bottom: .3em; }
  code { background: #f3f4f6; border-radius: 4px; padding: .15em .35em; font-size: .9em;
         font-family: ui-monospace, Consolas, "Courier New", monospace; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 14px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding: .2em 1em; border-left: 4px solid #d0d7de; color: #57606a; }
  table { border-collapse: collapse; margin: 1em 0; display: block; overflow: auto; }
  th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
  th { background: #f6f8fa; }
  img { max-width: 100%; height: auto; }
  a { color: #0969da; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    code, pre, th { background: #161b22; }
    h1, th, td, hr { border-color: #30363d; }
    blockquote { border-color: #30363d; color: #8b949e; }
    a { color: #58a6ff; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  global.YQMdToHtml = { render, inline, escapeHtml, page };
  if (typeof module !== 'undefined' && module.exports) module.exports = { render, inline, escapeHtml, page };
})(typeof globalThis !== 'undefined' ? globalThis : this);
