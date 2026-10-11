const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('sidepanel.js', 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function balancedObject('),
  source.indexOf('/** 给每个节点记上')), context);

function find(root) {
  context.sample = root;
  return vm.runInContext('findTocArray(sample)', context);
}
function extract(html) {
  context.html = html;
  return vm.runInContext('extractAppData(html)', context);
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const single = [{ title: '唯一文档', slug: 'doc-1' }];
assert.deepEqual(plain(find({ book: { toc: single } })), single,
  'single-document books must be recognized');
assert.deepEqual(plain(find({ book: { data: single } })), single,
  'a single node with a document slug remains supported without a toc key');

const grouped = [
  { title: '分组一', uuid: 'g1', parent_uuid: '' },
  { title: '分组二', uuid: 'g2', parent_uuid: '' },
  { title: '唯一文档', slug: 'doc-1', uuid: 'd1', parent_uuid: 'g1' },
];
assert.deepEqual(plain(find({ book: { toc: grouped } })), grouped,
  'groups without a URL must not invalidate the complete TOC');
assert.deepEqual(plain(find({ book: { data: grouped } })), grouped,
  'document fields should also identify an unfamiliar TOC property');

const nested = [
  { title: '分组一', children: [
    { title: '文档一', slug: 'doc-1' }, { title: '文档二', slug: 'doc-2' },
  ] },
  { title: '分组二', children: [{ title: '文档三', slug: 'doc-3' }] },
];
assert.deepEqual(plain(find({ book: { toc: nested } })), nested,
  'nested TOCs must preserve every root group, not select just one child array');
context.sample = find({ book: { toc: nested } });
const normalized = plain(vm.runInContext('pruneTree(normalizeToc(sample))', context));
assert.equal(normalized.length, 2);
assert.equal(normalized[0].children.length, 2);
assert.equal(normalized[1].children[0].url, 'doc-3');

const typedGroups = [
  { title: '分组', type: 'TITLE', slug: 'folder-slug', uuid: 'g1', parent_uuid: '' },
  { title: '文档', type: 'DOC', url: '', slug: 'real-doc', uuid: 'd1', parent_uuid: 'g1' },
];
assert.deepEqual(plain(find({ book: { toc: typedGroups } })), typedGroups);
context.sample = typedGroups;
const typedTree = plain(vm.runInContext('pruneTree(normalizeToc(sample))', context));
assert.equal(typedTree[0].url, '', 'TITLE nodes remain folders even when they have a slug');
assert.equal(typedTree[0]._slug, '');
assert.equal(typedTree[0].children[0].url, 'real-doc',
  'an empty URL must fall back to the document slug');
assert.equal(find({ toc: [typedGroups[0]] }), null, 'a TITLE slug is not a document');

for (const key of ['toc', 'tocs']) {
  assert.deepEqual(plain(find({ book: { [key]: JSON.stringify(grouped) } })), grouped,
    key + ' can be a serialized JSON array');
  assert.equal(find({ book: { [key]: 'malformed JSON' } }), null);
}

const menu = [{ title: '帮助', url: '/help' }, { title: '首页', url: '/' }];
assert.equal(find({ navigation: menu }), null, 'ordinary navigation is not a document TOC');
assert.deepEqual(plain(find({ navigation: menu, book: { toc: single } })), single);
const unrelatedDocs = Array.from({ length: 20 }, (_, i) => ({ title: '搜索结果 ' + i, slug: 'result-' + i }));
assert.deepEqual(plain(find({ searchResults: unrelatedDocs, book: { toc: single } })), single,
  'an explicit TOC takes precedence over a longer unrelated document array');
assert.equal(find({ toc: [] }), null);
assert.equal(find({ toc: [{ title: '空分组', children: [] }] }), null);

const encoded = encodeURIComponent(JSON.stringify({ book: { toc: single } }));
const encodedApostrophe = encodeURIComponent(JSON.stringify({
  book: { tocs: [{ title: "Jack's 文档", slug: 'jack-doc' }] },
})).replace(/'/g, "\\'");
const candidates = extract(
  '<script>const invalid=decodeURIComponent("%broken");' +
  'const settings=decodeURIComponent("%7B%22settings%22%3Atrue%7D");' +
  'window.appData=JSON.parse(decodeURIComponent(\n"' + encoded + '"\n));' +
  "window.__appData=JSON.parse(decodeURIComponent ( '" + encodedApostrophe + "' ));</script>"
);
assert.equal(candidates.length, 3, 'all valid encoded JSON candidates must be collected');
assert.deepEqual(plain(find(candidates[1])), single);
assert.equal(find(candidates[2])[0].title, "Jack's 文档",
  'escaped apostrophes in single-quoted JS strings must decode safely');
assert.deepEqual(plain(find([{ results: unrelatedDocs }, { book: { toc: single } }])), single,
  'explicit TOCs should win across multiple appData candidates');

const repeated = extract('<script>window.appData={};window.appData=' +
  JSON.stringify({ book: { toc: single } }) + ';</script>');
assert.equal(repeated.length, 2, 'later occurrences of direct appData assignments must be considered');
assert.deepEqual(plain(find(repeated[1])), single);
assert.equal(extract('<script>window.appData=missing;const irrelevant={"title":"not appData"};</script>').length, 0,
  'a missing appData object must not consume an unrelated object later in the script');

const cyclic = {};
cyclic.self = cyclic;
cyclic.book = { toc: single };
assert.deepEqual(plain(find(cyclic)), single);
console.log('TOC compatibility tests passed');
