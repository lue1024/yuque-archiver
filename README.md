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
3. 点「选择保存位置」，选择用于存放知识库的父目录，并允许浏览器读写该目录（也可点击开始导出时再选）
4. 勾选要导的文档、选择格式，保留默认的「只下载缺失文件」，点「开始导出」
5. 插件先在 `<所选位置>/<知识库名>/` 中检查并补齐语雀文件夹，再逐个核对文档；图片进入 `_assets/`

导出格式下方可设置下载限速，单位 KB/s，`0` 表示不限速。开启限速后导出改为单请求处理，对语雀正文、lake 与图片的读取按字节控制平均速度。

「只下载缺失文件」默认开启。检查与实际写入使用同一个本地目录，不依赖 Chrome 下载记录。文件夹缺失就创建；对应的非空文件已存在就跳过正文下载，缺失或零字节文件才下载。Markdown 已有但 HTML 缺失时，只补 HTML。以完整的文件夹路径和文件名去重，不会把不同分组的同名文章混为一篇。

勾选图片本地化时，也会检查所选格式的已有 Markdown / HTML：之前图片失败留下的远程图片链接会重新尝试下载，成功后只替换这些链接，不重新获取正文。写回前会核对原文未被其他程序修改；失败的图片保持远程链接，下一次导出可重试。

例如选择 `D:\语雀备份`，语雀中有 `知识库/安全研究/文章一`，插件就准备 `D:\语雀备份\知识库\安全研究`，然后检查并补齐 `文章一.md`。之前的文件位于 `下载/<知识库名>/` 时，应选择“下载”这一父目录，避免多套一层知识库名。

所选目录只在当前侧栏会话有效，重新打开侧栏需要重新选择同一个保存位置。去重不比较正文内容或远程版本；取消勾选会另存 `标题 (1).md` 等副本，已有非空文件不覆盖。空文件夹也会保留；勾选决定哪些文档需要补下载。

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

先**抓知识库首页的 HTML，把服务端内联的 appData 提取出来**。没有可用目录时，会继续读取当前语雀标签页的运行态数据，再自动尝试 DOM 兜底。

```js
// sidepanel.js
function fromDecodeUriComponent(html) {
  // 收集 decodeURIComponent("...") 或 decodeURIComponent('...') 中的 JSON
  // 不执行页面脚本；仅解码字符串和解析 JSON
}
```

`findTocArray` 优先识别 `toc` / `tocs` 字段下的完整目录，兼容 JSON 字符串、单篇文档、含大量分组及嵌套节点的目录。其他位置的数组需要包含文档字段或文档路径证据，避免把普通导航菜单识别为知识库目录。

DOM 兜底遇到 `Could not establish connection. Receiving end does not exist.` 时，会补注入 `js/content.js` 并重试一次。重复注入会替换原有监听器。此路径只读取页面已加载的文档链接；折叠或尚未加载的目录可能缺失，页面中展开目录后可重新读取。

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
├── manifest.json      MV3 清单；主机权限：语雀与 cdn.nlark.com
├── sidepanel.html/.css
├── sidepanel.js       主逻辑（目录解析、导出编排、落盘、lake 渲染）
├── js/
│   ├── config.js      ★ 所有接口模板，改版只改这里
│   ├── background.js  页面上下文 fetch + 消息路由
│   ├── content.js     页面信息 + 侧边栏 DOM 兜底
│   ├── html2md.js     HTML → Markdown
│   ├── md2html.js     Markdown → 独立 HTML
│   └── local-files.js  所选本地目录的创建、去重与写入
└── icons/
```

### 6.1 目录结构

```
<所选位置>/<知识库名>/
├── _assets/                      图片与附件（全库共用）
│   └── 1789394368063-xxx.png
└── <分组>/<子分组>/               跟着语雀完整目录层级走
    └── 标题.md
```

保留完整目录层级，不再截取最后三层。操作系统若拒绝过长路径，会记录实际失败路径，便于改用较短的保存位置。
同一目录内重名的文档会加稳定的 URL 哈希后缀，按整个已读取知识库目录确定，分批勾选不会改变名字。若同时选 HTML 与 lake，lake 的可读版本保存为 `标题.lake.html`。

### 6.2 本地写入与文件扩展名

正常导出通过 File System Access API 直接保存到所选目录。只有文件内容写入并成功关闭写入流后，才计为成功。写入失败会中止写入流；下次重新导出时，缺失或空文件可重试。

兼容的 Chrome 下载接口代码仍使用 `application/octet-stream`，避免浏览器按 MIME 将 `.lake` 改成 `.txt`。

所以 `saveText()` 一律用 `application/octet-stream`（没有 MIME→扩展名映射，文件名才作数）：

```js
function saveText(filename, text) {
  return saveBlob(new Blob([text], { type: 'application/octet-stream' }), filename);
}
```

### 6.3 图片下载

图片内容取回后统一写入所选目录：

1. `yuque.com` 及其子域下的资源先借语雀页面读取，失败后尝试后台读取
2. `cdn.nlark.com` 等外站图片直接由扩展后台读取，不要求打开图片域名的标签页。清单已声明 `https://cdn.nlark.com/*` 主机权限；其他图片域名需要允许跨域读取或另行配置主机权限

所有图片读取路径保留相同限速。失败时记录图片错误，正文保留远程图片链接，不改写成不存在的本地路径；同一次导出按图片 URL 合并重复失败日志。图片地址返回 HTML / JSON 错误页时不会保存成图片。图片文件名包含 URL 哈希，不依赖文档的下载顺序。

升级到 0.3.1 后，在扩展管理页重新加载扩展，并确认允许访问 `cdn.nlark.com`。此前出现图片失败时，重新选同一个保存位置，保持图片本地化与只下载缺失文件勾选，再导出对应文档即可补图，无需删除已有正文或关闭去重。日志会显示「已补全图片链接」。

正文里的链接统一改写成相对路径 `../_assets/xxx.png`，前缀按文档所在深度算。

---

## 七、限速与并发

```js
// js/config.js
concurrency: 3,     // 不限速时的并发文档数；限速时固定为 1
delayMs: 220,       // 每篇之间的间隔
timeoutMs: 60000,   // 网络等待超时
```

5301 篇的库一次导完会持续打语雀几十秒，**不建议把并发调到 6 以上**。KB/s 限速通过读取响应流实现，适合控制整个导出的平均处理速度；浏览器网络栈仍可能预取或短时缓冲，不能保证操作系统层面的瞬时带宽上限。

---

## 八、测试

当前目录内的回归测试可在 Node 下直接运行，不需要语雀登录态：

```bash
node test-download.js   # 本地去重、同名图片和 KB/s 读取节流
node test-toc.js        # appData 提取和目录结构兼容
node test-scan.js       # 接收端缺失自动恢复及目录读取兜底
node test-local-files.js # 创建目录、磁盘去重、写入失败与并发
node test-incremental.js # 先建目录、补齐缺失文件的离线集成验证
node test-cdn.js        # CDN 权限、请求路径、HTTP 错误和限速
```

`sidepanel.js` 的测试方式：拿假的 `document` / `chrome` 建 VM 沙箱，把整个文件 load 进去再取里面的纯函数。

---

## 九、已知限制

- **必须有已登录的语雀标签页**。没有就直接报错，不会静默失败。
- **只支持 Markdown / HTML / lake 原始文件**。PDF 和 Word 没有实现 —— `/docx` 接口在普通文档上返回 404。
- **lake 表格里是 POC 的会被转成代码块**，这是有意为之（见 5.3），不是纯原样保存。
- **依赖 `<!doctype lake>` 这个标记**判断 lake 格式。语雀如果换掉，`classifyExportText()` 一处就能改。
- 本地去重按文件路径和非空状态判断；同路径的不同版本会被视为已有文件。不会校验已有正文完整性；补图仅处理正文中仍是远程地址的图片，不检测已改成本地链接但后来被手动删除的图片，也不自动刷新失效的签名链接。

---

## 十、出问题时

1. 侧栏「运行日志」里**红色的行**是关键信息，失败信息会带上实际请求的地址
2. 「读取知识库目录」时会打两行诊断：
   ```
   目录节点字段：type, title, uuid, url, ...
   样例：{"type":"TITLE","title":"...","url":"",...}
   ```
   这两行能直接看出语雀的字段有没有变
3. 目录读取失败时会自动尝试页面数据和 DOM，并记录页面标题及数据顶层字段。若页面是登录页或无权限提示，请先在语雀页面完成登录并确认能看到知识库目录。
4. 更新扩展后，先在 `chrome://extensions/` 重新加载扩展，再回到语雀页面重新打开侧栏。若自动补注入仍失败，请刷新语雀页面，并检查扩展是否获准访问该语雀站点。
