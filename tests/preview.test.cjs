const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const git = (root, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8' });
function load(c, name, exports) {
  const source = fs.readFileSync(path.join(__dirname, '../mods/git-file-preview', name), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class', 'class').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, {${exports.join(',')}}); })()`, c);
}
function element(id) {
  const node = { id, nodes: [], attrs: {}, handlers: {} }; let proxy;
  proxy = new Proxy(node, { get(n, key) {
    if (key === 'id' && n.id == null) return value => (n.id = value, proxy);
    if (key in n) return n[key];
    if (['child', 'content', 'trigger'].includes(key)) return value => (n.nodes.push(value), proxy);
    if (key === 'children') return values => (n.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...values) => { n.attrs[key] = values; if (key.startsWith('on_')) n.handlers[key.slice(3)] = values.at(-1); return proxy; };
  } }); return proxy;
}
const find = (n, id) => n?.id === id ? n : n?.nodes?.map(child => find(child, id)).find(Boolean);
const texts = n => typeof n === 'string' ? n : (n?.nodes || []).map(texts).join(' ');
function harness(selection) {
  const state = new Map([['selection', selection]]), jobs = [], calls = [];
  const cx = { notify() {}, timer: { every() {} }, spawn(fn) { jobs.push(fn(cx)); } };
  const host = {
    exec: async (command, args, options) => { calls.push([command, args]); try { return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, stderr: e.stderr.toString() }; } },
    readTextFile: async file => fs.promises.readFile(file, 'utf8'),
  };
  const c = vm.createContext({ View: class {}, div: element, svg: () => element(), v_flex: element, h_flex: element,
    Button: { new: element }, Popover: { new: element }, Scrollbar: { vertical: element }, TextView: { markdown: element }, v_virtual_list: element,
    props: () => ({ selectionKey: 'selection' }), shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    theme: () => new Proxy({}, { get: (_, key) => key }), settings: () => ({}), focused: () => ({ tab: 'tab' }), panes: () => [], run() {},
    ...host, highlightRows: async () => {},
  });
  load(c, 'gutter.js', ['lineChanges']); load(c, 'content.js', ['isMarkdown', 'splitRows', 'diffRows', 'readFile', 'readDiff', 'readSource', 'readMarkdown', 'git']);
  load(c, 'main.js', ['FilePreview']);
  const view = new c.FilePreview(); view.watch = () => {}; view.init({}, cx);
  return { c, view, state, cx, host, calls, async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'a.md'), 'before\n'); fs.writeFileSync(path.join(root, 'b.txt'), 'second\n'); git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Baseline');
  return root;
}

test('unified line numbers and split pairs preserve hunk positions and unequal replacements', () => {
  const h = harness(null), rows = h.c.diffRows(['@@ -8,3 +20,4 @@', ' keep', '-old1', '-old2', '+new1', '+new2', '+new3', '@@ -30 +40 @@', ' tail']);
  assert.deepEqual(Array.from(rows, r => [r.oldNumber ?? null, r.newNumber ?? null]), [[null,null],[8,20],[9,null],[10,null],[null,21],[null,22],[null,23],[null,null],[30,40]]);
  const pairs = h.c.splitRows(rows);
  assert.equal(pairs[2].before.text, 'old1'); assert.equal(pairs[2].after.text, 'new1');
  assert.equal(pairs[4].before, undefined); assert.equal(pairs[4].after.text, 'new3');
  assert.equal(pairs[5].before.kind, '@'); assert.equal(pairs[6].after.newNumber, 40);
});

test('Source and Markdown read index or selected commit rather than current working content', async t => {
  const root = fixture(t), hash = git(root, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'a.md'), 'staged\r\n'); git(root, 'add', 'a.md'); fs.writeFileSync(path.join(root, 'a.md'), 'working\n');
  const s = { root, on: null, hasHead: true, file: { path: 'a.md', status: 'M', indexStatus: 'M' }, diffMode: 'staged' };
  const h = harness(s); await h.flush();
  const staged = await h.c.readSource(s, h.host); assert.equal(staged.text, 'staged\r\n'); assert.equal(staged.lineEnding, 'CRLF');
  h.view.selectMode('source', h.cx); await h.flush(); assert.equal(h.view.source.rows[0].text.trim(), 'staged');
  h.view.selectMode('markdown', h.cx); await h.flush(); assert.equal(h.view.markdown.text, 'staged\r\n');
  const commit = { ...s, hash, parent: null }; assert.equal((await h.c.readSource(commit, h.host)).text, 'before\n');
  assert.equal((await h.c.readFile(commit, h.host)).rows[0].text, 'before');
  const unstaged = { ...s, diffMode: 'unstaged' }; assert.equal((await h.c.readSource(unstaged, h.host)).text, 'working\n');
  const stagedDiff = await h.c.readDiff(s, h.host), workingDiff = await h.c.readDiff(unstaged, h.host);
  assert.equal(stagedDiff.stats.add, 1); assert.ok(stagedDiff.rows.some(r => r.text.trim() === 'staged'));
  assert.ok(workingDiff.rows.some(r => r.kind === '-' && r.text.trim() === 'staged'));
  fs.unlinkSync(path.join(root, 'a.md'));
  assert.equal((await h.c.readSource({ ...unstaged, file: { ...s.file, status: 'D' } }, h.host)).text, 'staged\r\n');
  git(root, 'add', 'a.md');
  assert.equal((await h.c.readSource({ ...s, file: { path: 'a.md', status: 'D', indexStatus: 'D' } }, h.host)).text, 'before\n');
});

test('commit preview has metadata, file chips, pinned source, layouts and read-only actions', async t => {
  const root = fixture(t), hash = git(root, 'rev-parse', 'HEAD').trim();
  const files = [{ path: 'a.md', status: 'A', add: 1 }, { path: 'b.txt', status: 'A', add: 1 }];
  const s = { root, on: null, hash, parent: null, hasHead: true, file: files[0], commit: { hash, parents: [], author: 'Fixture User', email: 'fixture@example.invalid', date: '2026-11-13T12:00:00Z', message: 'Baseline\n\nFull commit body', files, fileCount: 2 } };
  const h = harness(s); await h.flush(); let tree = h.view.render(h.cx);
  assert.match(texts(find(tree, 'preview-commit')), /Baseline.*Full commit body.*Fixture User.*Root commit/);
  assert.ok(find(tree, 'file-mode-source')); assert.ok(find(tree, 'file-mode-markdown')); assert.ok(find(tree, 'diff-layout-split'));
  assert.equal(find(tree, 'preview-stage'), undefined); assert.equal(find(tree, 'preview-discard'), undefined);
  find(tree, 'preview-commit-file-b.txt').handlers.click({}, h.cx); await h.flush();
  assert.equal(h.state.get('selection').hash, hash); assert.equal(h.state.get('selection').file.path, 'b.txt');
  fs.writeFileSync(path.join(root, 'b.txt'), 'changed after commit\n');
  h.view.selectMode('source', h.cx); await h.flush(); assert.equal(h.view.source.rows[0].text, 'second');
  tree = h.view.render(h.cx); find(tree, 'preview-menu-history').handlers.click({}, h.cx);
  assert.equal(h.state.get('selection.history').path, 'b.txt');
  const calls = h.calls.length; h.view.render(h.cx); h.view.render(h.cx); assert.equal(h.calls.length, calls);
});

test('preview mutation menu requires confirmation and dispatches the exact displayed selection', async t => {
  const root = fixture(t), head = git(root, 'rev-parse', 'HEAD').trim(); fs.writeFileSync(path.join(root, 'a.md'), 'working\n');
  const s = { root, on: null, head, branch: 'main', hasHead: true, file: { path: 'a.md', status: 'M', unstaged: true } };
  const h = harness(s); await h.flush(); let tree = h.view.render(h.cx);
  find(tree, 'preview-discard').handlers.click({}, h.cx); assert.equal(h.state.get('selection.action'), undefined);
  tree = h.view.render(h.cx); assert.match(texts(tree), /Restore working content from the index/);
  find(tree, 'preview-confirm-action').handlers.click({}, h.cx);
  const request = h.state.get('selection.action'); assert.equal(request.action, 'discard'); assert.equal(request.selection.head, head);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'working\n');
  h.state.set('selection.result', { id: request.id, error: 'Repository changed' }); h.view.render(h.cx); await h.flush();
  assert.match(texts(h.view.render(h.cx)), /Repository changed/); assert.equal(h.view.pending, null);
});

test('empty commits show their metadata, and Source failures do not show an older file', async t => {
  const root = fixture(t), h = harness({ root, file: null, hash: git(root, 'rev-parse', 'HEAD').trim(), commit: { hash: 'a'.repeat(40), parents: [], author: 'Fixture', email: '', date: '2026-11-13', message: 'Empty commit', files: [], fileCount: 0 } });
  await h.flush(); assert.match(texts(h.view.render(h.cx)), /Empty commit.*This commit has no changed files/);
  h.state.set('selection', { root, file: { path: 'missing.txt', status: 'M' } }); h.view.refresh(h.cx); await h.flush();
  h.view.selectMode('source', h.cx); await h.flush(); assert.equal(h.view.source, null); assert.ok(h.view.sourceError);
});
