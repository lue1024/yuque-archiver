# 语雀知识库批量导出

Chrome MV3 扩展。把语雀知识库批量导出为 **Markdown / HTML / lake 原始文件**，图片和附件下载到本地并改写链接。

零运行时依赖 —— 没有打包进任何第三方库，两个格式转换器都是手写的。

---

## 一、安装

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本目录
4. **改了任何文件之后必须点插件卡片上的 ⟳ 重新加载**，否则跑的还是旧代码

要求 Chrome 116+（用到 `chrome.sidePanel.setPanelBehavior`）。

## 二、使用

1. 在 Chrome 里登录语雀，切到任意一个知识库页面（`yuque.com/用户名/知识库名`）
2. 点插件图标 → 右侧栏打开 → 点「读取知识库目录」
3. 勾选要导的文档，选格式，点「开始导出」
4. 文件落在 `下载/<知识库名>/`，按目录层级分文件夹，图片进 `_assets/`

| 格式 | 产出 |
|---|---|
| Markdown | `标题.md` |
| HTML | `标题.html`（由 Markdown 渲染的独立单文件，双击可看） |
| 原始 lake 导出 | `标题.lake`（lake 原文）+ `标题.html`（展开后的可读版本） |
| 图片本地化 | `_assets/` 下的图片文件，正文里的链接改成相对路径 |

**前提**：必须有一个已登录的语雀标签页开着。所有请求都借这个页面发出去。

---

## 三、架构

```
┌──────────────────────┐
│  sidepanel.js        │  UI + 目录解析 + 导出编排 + 落盘
│  (扩展页面)           │
└───────┬──────────────┘
        │ chrome.runtime.sendMessage
        ▼
┌──────────────────────┐
│  background.js       │  只做一件事：借语雀标签页发请求
│  (service worker)    │
└───────┬──────────────┘
        │ chrome.scripting.executeScript({ world: 'MAIN' })
        ▼
┌──────────────────────┐
│  语雀页面主世界        │  fetch(url, { credentials: 'include' })
│  (用户已登录)         │
└──────────────────────┘
```

### 3.1 为什么要把 fetch 注入到页面主世界

语雀的导出接口校验同源和 Referer，在 service worker 里直接 fetch 会被拒；图片等资源还会撞 CORS。

把请求放进 `yuque.com` 页面自己的 JS 上下文里发，cookies、Referer、CORS 三件事**同时**天然满足，不需要手动伪造任何请求头。

```js
// background.js
const injected = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  world: 'MAIN',                      // 关键：页面主世界，不是隔离世界
  func: pageFetch,                    // 必须自包含，不能引用外部变量
  args: [url, asBinary, timeoutMs],
});
```

注入的函数拿不到闭包，所以 `pageFetch` 是一个独立完整的函数。

### 3.2 标签页要求

`chrome.scripting.executeScript` 只能注入到**同 host** 的标签页。跨子域注入进去 fetch 仍是跨域，读不到响应体。所以 `ensureYuqueTab(host)` 会：

1. 找一个 `https://<host>/*` 的已打开标签页（优先激活的）
2. 找不到就退而求其次找同 host 的任意语雀页
3. 再找不到才后台新开一个（`active: false`），等它加载完

### 3.3 目录怎么来的

不调 API，是**抓知识库首页的 HTML，把服务端内联的 appData 抠出来**：

```js
// sidepanel.js
function fromDecodeUriComponent(html) {
  // 语雀把整个 appData 塞在 decodeURIComponent("...") 里
  const marker = 'decodeURIComponent("';
  // 找到 " 之间的内容 → decodeURIComponent → JSON.parse
}
```

抠出 JSON 后不写死路径，而是**递归搜索最像目录的那个数组**（`findTocArray`）：数组里 ≥70% 的元素同时有 `title` 和 `url`/`slug` 才算数。这样语雀改了 JSON 结构也不会立刻失效。

### 3.4 目录节点的真实字段

2026-09 实测：

```
type, title, uuid, url, prev_uuid, sibling_uuid, child_uuid,
parent_uuid, doc_id, level, id, open_window, visible
```

还原成树时按这个优先级尝试四种形态：

| 形态 | 判据 |
|---|---|
| 嵌套 | 元素自带 `children` 数组 |
| 关系 | 有 `uuid` + `parent_uuid` |
| 层级 | 有 `level` 或 `depth`（**语雀实际用的是 `level`**） |
| 扁平 | 以上都没有，当作同级 |

### 3.5 文档地址要靠页面 URL 补前缀

**这是最容易踩的坑。** 目录节点的 `url` 字段经常**只有一个 slug**，不带 `/用户/知识库` 前缀。

```js
new URL('cewoprvcbpo7dtuo', 'https://www.yuque.com')
// → https://www.yuque.com/cewoprvcbpo7dtuo   ← 不存在的地址，后面全 404
```

`buildDocUrl()` 的做法：路径段数不够就说明是裸 slug，用当前页面的 `/用户/知识库` 补上。

---

## 四、语雀接口（实测结论）

全部集中在 `js/config.js`，改版时只需要动这一个文件。

| 接口 | 用途 | 实测状态 |
|---|---|---|
| `{docUrl}/markdown?attachment=true&latexcode=false&anchor=false&linebreak=false` | 单篇 Markdown | ✅ 通 |
| `{docUrl}/lake?attachment=true&latexcode=false&anchor=false&linebreak=false` | lake 原文 | ✅ 通，但**不返回 JSON** |
| `{origin}/api/docs/{slug}?book_id={id}` | 文档详情，兜底 | 返回 JSON，字段 `data.body` / `data.body_html` |
| `{origin}/api.json` 厂商配置 | — | 本插件不用 |
| `{docUrl}/docx?attachment=true` | — | ❌ **普通文档 404，别用** |

### 4.1 `/lake` 返回的是 lake 格式，不是 JSON

```html
<!doctype lake><title>文档标题</title>
<meta name="paragraphSpacing" content="relax"/>
<meta name="doc-version" content="1" />
<h2 data-lake-id="e9090a0e...">标题</h2>
<card type="block" name="table" value="data:%7B%22html%22%3A%22...%22%7D"></card>
```

判断必须按 `<!doctype lake>` 来，拿 `JSON.parse` 去试会一直失败：

```js
function classifyExportText(text) {
  if (t.startsWith('{') || t.startsWith('[')) return 'lake';   // 少数情况是真 JSON
  if (/^<!doctype\s+lake/i.test(t)) return 'lake';             // 实际见到的形态
  if (t.startsWith('<')) return 'html';
  return '';
}
```

### 4.2 lake 用 `<card>` 承载复杂内容

浏览器不认识 `<card>`，**原样保存打开就是"没图、表格也不见"**。图片和表格都塞在 URL 编码的 `value` 属性里：

```html
<!-- 图片 -->
<card type="inline" name="image"
      value="data:%7B%22src%22%3A%22https%3A%2F%2Fcdn.nlark.com%2F...png%22%7D"></card>

<!-- 表格：value 里带了渲染好的 html -->
<card type="block" name="table"
      value="data:%7B%22html%22%3A%22%3Ctable%20class%3D...%22%7D"></card>
```

`expandLakeCard()` 负责解码并展开成真正的 `<img>` / `<table>` / `<a>`。因为 value 是 URL 编码的，里面不会出现字面量的 `>` 或 `"`，所以用 `[^>]*` 匹配属性是安全的。

---

## 五、格式转换

两个转换器都是手写、零依赖、**不依赖 DOMParser**（这样能在 Node 里直接跑单测）。

### 5.1 `js/html2md.js` — HTML → Markdown

自写的词法分析器 + 行缓冲写出器。支持标题、段落、列表（嵌套/有序）、表格、代码块、引用、行内格式、实体解码。

**几个关键设计：**

- **表格单元格用独立缓冲**（`cellBuf`）。早期版本用「记住 `cur` 的长度再切片」来采集单元格，遇到 `<br>` 之类的换行切片就错位了。
- **块级标签在单元格里只记一个换行**。`<p>a</p><p>b</p>` 如果走 `blank()` 会往文档流里写，结果是内容跑到单元格外面、而且 `a` 和 `b` 粘成 `ab`。
- **收尾清理绕开围栏代码块**。全局去行尾空格会吃掉代码里的空格、折叠代码里的空行。

### 5.2 `js/md2html.js` — Markdown → 独立 HTML

**核心机制：先把易碎内容摘成占位符。**

```js
function inline(text, opts) {
  const store = [];
  const keep = (html) => { store.push(html); return SENT + (store.length - 1) + SENT; };

  // 1. 行内代码 / 图片 / 链接整段摘出来换成占位符
  // 2. 转义剩下的纯文本
  // 3. 强调规则只作用于文本
  // 4. 最后还原占位符
}
```

不这么做的话，`*斜体*` 和 `_斜体_` 会把**生成的标签属性**也改掉 —— 线上真实出过这个 bug：

```html
target="_blank"   →   target="<em>blank"
```

围栏按 CommonMark 规则配对（同字符、不短于开栏），因为 `html2md` 在代码内容本身含三个反引号时会自动加长围栏。

### 5.3 表格 → 代码块

语雀把 **POC / 请求包**这类内容存在**表格**里（单列、两列都有）。按表格渲染有两个后果：

1. 渲染成一个奇怪的大块
2. 单元格换行只能塞 `<br>`，再往下走一层渲染器一转义就变成字面量文本

所以 `looksLikeCode()` 识别出代码特征（`HTTP/1.1`、`Host:`、`SELECT...FROM`、`curl`、`<?php` 等）的表格，整体降级成围栏代码块。**普通参数表不受影响。**

````markdown
<!-- 改前 -->
| POST /login.aspx/Login HTTP/1.1<br>Host: <br>Accept: */*<br>... |
| --- |

<!-- 改后 -->
```
POST /login.aspx/Login HTTP/1.1
Host:
Accept: */*
```
````

注意 `Accept: */*` —— 留在表格里会被 Markdown 当成强调语法吃成 `Accept: <em>/</em>`。降级成代码块顺带解决了这个数据损坏。

---

## 六、文件结构与落盘

```
yuque-kb-exporter/
├── manifest.json      MV3 清单，权限：storage tabs scripting downloads sidePanel
├── sidepanel.html/.css
├── sidepanel.js       主逻辑（目录解析、导出编排、落盘、lake 渲染）
├── js/
│   ├── config.js      ★ 所有接口模板，改版只改这里
│   ├── background.js  页面上下文 fetch + 消息路由
│   ├── content.js     页面信息 + 侧边栏 DOM 兜底
│   ├── html2md.js     HTML → Markdown
│   └── md2html.js     Markdown → 独立 HTML
└── icons/
```

### 6.1 目录结构

```
下载/<知识库名>/
├── _assets/                      图片与附件（全库共用）
│   └── 1789394368063-xxx.png
└── <分组>/<子分组>/               跟着语雀目录层级走，最多 3 层
    └── 标题.md
```

超过 3 层的嵌套会被截断（`capDepth`），避免 Windows 260 字符路径上限。

### 6.2 ⚠️ Chrome 会按 MIME 改写扩展名

**踩过的坑**：`Blob` 的 type 给 `text/plain` 时，Chrome 的下载接口会把 `文档.lake` 存成 `文档.txt`，**无视 `filename` 参数**。

所以 `saveText()` 一律用 `application/octet-stream`（没有 MIME→扩展名映射，文件名才作数）：

```js
function saveText(filename, text) {
  return saveBlob(new Blob([text], { type: 'application/octet-stream' }), filename);
}
```

### 6.3 图片下载

两条路：

1. 先走页面上下文取二进制（能带 cookie，且能拿到真实的成功/失败）
2. 失败退到 `chrome.downloads.download({ url })` 直下（浏览器层面下载，绕过 CORS）

正文里的链接统一改写成相对路径 `../_assets/xxx.png`，前缀按文档所在深度算。

---

## 七、限速与并发

```js
// js/config.js
concurrency: 3,     // 并发文档数
delayMs: 220,       // 每篇之间的间隔
timeoutMs: 60000,   // 单请求超时
```

5301 篇的库一次导完会持续打语雀几十秒，**不建议把并发调到 6 以上**。

---

## 八、测试

转换器和纯逻辑都在 Node 下直接跑，不需要浏览器：

```bash
node test-h2m.js        # HTML → Markdown，10 个用例
node test-m2h.js        # Markdown → HTML，16 项断言
node test-sidepanel.js  # 目录解析 / URL 拼接 / 下载文件名，43 项断言
node test-poc.js        # 单列表格里的 POC
node test-br.js         # 两列表格 + 请求包、真表格不被误伤
node test-yuque-md.js   # 语雀 /markdown 产出的原始 Markdown 端到端
node test-lake.js       # lake 文档展开（样本是真实导出文件）
```

`sidepanel.js` 的测试方式：拿假的 `document` / `chrome` 建 VM 沙箱，把整个文件 load 进去再取里面的纯函数。

---

## 九、已知限制

- **必须有已登录的语雀标签页**。没有就直接报错，不会静默失败。
- **只支持 Markdown / HTML / lake 原始文件**。PDF 和 Word 没有实现 —— `/docx` 接口在普通文档上返回 404。
- **lake 表格里是 POC 的会被转成代码块**，这是有意为之（见 5.3），不是纯原样保存。
- **依赖 `<!doctype lake>` 这个标记**判断 lake 格式。语雀如果换掉，`classifyExportText()` 一处就能改。
- 导出的文件**不做去重**，同一篇导两次会得到 `标题(1).md`。

---

## 十、出问题时

1. 侧栏「运行日志」里**红色的行**是关键信息，失败信息会带上实际请求的地址
2. 「读取知识库目录」时会打两行诊断：
   ```
   目录节点字段：type, title, uuid, url, ...
   样例：{"type":"TITLE","title":"...","url":"",...}
   ```
   这两行能直接看出语雀的字段有没有变
3. 接口挂了先怀疑 `js/config.js` 里的 URL 模板，不是逻辑
