/**
 * 所有语雀接口模板集中在这里。
 * 语雀改版时，正常情况下只需要改这个文件。
 * 不打包成模块，用 importScripts / <script> 直接加载。
 */
const YQ_CFG = {
  /** 单篇文档的 Markdown 导出地址（语雀 UI 里"下载为 Markdown"用的就是这个） */
  markdownUrl: (docUrl) =>
    `${docUrl}/markdown?attachment=true&latexcode=false&anchor=false&linebreak=false`,

  /**
   * 单篇文档的 Lake 源格式导出地址。
   * 注意：语雀不保证 /lake 返回 JSON，很多文档它会回一个 HTML 页面，
   * 所以 sidepanel 那边拿到之后会做内容嗅探，必要时退到 docxUrl。
   */
  lakeUrl: (docUrl) =>
    `${docUrl}/lake?attachment=true&latexcode=false&anchor=false&linebreak=false`,

  /**
   * 语雀的 /docx 接口。
   * 实测/反混淆结论：对普通文档它可能回真正的 .docx（ZIP），
   * 也可能回一个包着正文的 HTML 页面，所以按字节头判断，不能按后缀假定。
   */
  docxUrl: (docUrl) =>
    `${docUrl}/docx?attachment=true&latexcode=false&anchor=false&linebreak=false`,

  /** 文档详情接口，Markdown 拿不到时的兜底（返回 JSON，含 body / body_html） */
  docApiUrl: (origin, slug, bookId) =>
    `${origin}/api/docs/${encodeURIComponent(slug)}?book_id=${encodeURIComponent(bookId)}`,

  /** 批量导出的并发与节流，避免把语雀打限速 */
  concurrency: 3,
  delayMs: 220,

  /** 单次请求超时 */
  timeoutMs: 60000,

  /** 导出目录名里不允许出现的字符 */
  illegalPathChars: /[\\/:*?"<>|]/g,
};

if (typeof globalThis !== 'undefined') globalThis.YQ_CFG = YQ_CFG;
