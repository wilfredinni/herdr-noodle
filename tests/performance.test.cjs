const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function element(id) {
  const node = { id, nodes: [], attrs: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key === 'id' && target.id === undefined) return value => (target.id = value, proxy);
    if (key in target) return target[key];
    if (['child', 'trigger', 'content'].includes(key)) return value => (target.nodes.push(value), proxy);
    if (key === 'children') return values => (target.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...args) => (target.attrs[key] = args, proxy);
  } });
  return proxy;
}

function load(context, file, names) {
  const source = fs.readFileSync(path.join(__dirname, '../mods', file), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export default class (\w+)/g, 'class $1').replace(/export /g, '');
  vm.runInContext(`(function() { ${source}\nObject.assign(globalThis, {${names.join(',')}}); })()`, context);
}

function harness() {
  const jobs = [], timers = [], calls = { spaces: 0, panes: 0, focused: 0 };
  let tab = 'tab', notifications = 0;
  const cx = { focus_handle: () => ({ focus() {} }), notify() { notifications++; },
    spawn(fn) { jobs.push(fn(cx)); }, timer: { every(ms, fn) { timers.push({ ms, fn }); } } };
  const input = () => ({ on() {}, set_value() {}, value: () => '', focus() {} });
  const context = vm.createContext({ console, Date, Map, Set, View: class {}, div: element, svg: () => element(), image: () => element(),
    h_flex: element, v_flex: element, Button: { new: element }, Checkbox: { new: element }, Popover: { new: element },
    InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: element }, Tabs: { new: element }, Tab: { new: element },
    v_virtual_list: element, TextView: { markdown: element }, splitRows: () => [], PathBuilder: {}, settings: () => ({}),
    theme: () => new Proxy({}, { get: (_, key) => String(key) }), props: () => ({}),
    spaces: () => { calls.spaces++; return [{ id: 's', active: true, machine: null, folder: '/repo' }]; },
    panes: () => { calls.panes++; return [{ pane: 'p', cwd: '/repo', terminal: 't', tab: 'tab' }]; },
    focused: () => { calls.focused++; return { pane: 'p', tab, cwd: '/repo' }; }, shared: () => null,
    exec: async () => ({ code: 0, stdout: '' }), readTextFile: async () => '', showGitError() {},
  });
  return { context, cx, calls, timers, setTab(value) { tab = value; }, notifications: () => notifications,
    async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}

test('Changes context reads stay constant as the changed-file list grows', () => {
  const h = harness(), c = h.context;
  h.cx.spawn = () => {};
  load(c, 'changes-graph/graph.js', ['GRAPH_ARGS', 'HISTORY_ARGS', 'GRAPH_LIMIT', 'GRAPH_ROW_HEIGHT', 'graphRows', 'COMMIT_FORMAT', 'commitDetail', 'refLabels', 'shortAge']);
  load(c, 'changes-graph/gitToolbar.js', ['GitToolbar']);
  load(c, 'changes-graph/fileActions.js', ['FileActions']);
  load(c, 'changes-graph/commitGenerator.js', ['CommitGenerator']);
  load(c, 'changes-graph/repositories.js', ['Repositories']);
  load(c, 'changes-graph/stashPanel.js', ['StashPanel']);
  load(c, 'changes-graph/main.js', ['Changes']);
  const view = new c.Changes(); view.init({}, h.cx);
  Object.assign(view, { context: JSON.stringify({ cwd: '/repo', on: null }), root: '/repo', on: null, loading: false, message: 'message' });
  view.generator.machine = null;
  const reads = [];
  for (const count of [10, 1000]) {
    view.files = Array.from({ length: count }, (_, i) => ({ path: `file-${i}`, status: 'M', add: 1, del: 1 }));
    for (const key of Object.keys(h.calls)) h.calls[key] = 0;
    view.render(h.cx);
    reads.push({ ...h.calls });
  }
  assert.deepEqual(reads[0], reads[1]);
  assert.ok(reads[1].panes < 10);
});

test('Files reuses tracked paths until the real worktree index changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noodle-index-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(directory, 'one.txt'), 'one'); git(directory, 'add', 'one.txt'); git(directory, 'commit', '-qm', 'fixture');
  const worktree = path.join(directory, 'checkout'); git(directory, 'worktree', 'add', '--detach', worktree);
  const h = harness(), c = h.context, calls = [];
  c.readFile = fs.promises.readFile;
  c.exec = async (_, args, options) => {
    calls.push(args);
    return { code: 0, stdout: git(options.cwd, ...args) };
  };
  load(c, 'files-browser/gitState.js', ['gitState', 'fileState']);
  load(c, 'files-browser/main.js', ['Files']);
  const view = new c.Files(), context = {};
  const first = await view.trackedFiles(worktree, null, context);
  assert.equal(await view.trackedFiles(worktree, null, context), first);
  assert.equal(calls.filter(args => args.includes('ls-files')).length, 1);
  assert.ok(first.has(`${worktree}/one.txt`));
  fs.writeFileSync(path.join(worktree, 'two.txt'), 'two'); git(worktree, 'add', 'two.txt');
  const next = await view.trackedFiles(worktree, null, context);
  assert.ok(next.has(`${worktree}/two.txt`));
  assert.equal(calls.filter(args => args.includes('ls-files')).length, 2);
  const state = c.gitState(worktree, ' M one.txt\0', next);
  assert.equal(state.tracked, next);
  assert.equal(c.fileState(state, `${worktree}/one.txt`), 'M');
  c.readFile = async () => { throw Error('unreadable'); };
  await view.trackedFiles(worktree, null, context);
  await view.trackedFiles(worktree, 'remote', context);
  assert.equal(calls.filter(args => args.includes('ls-files')).length, 4);
});

test('zero-checksum indexes never reuse tracked paths', async () => {
  const h = harness(), c = h.context;
  let lists = 0;
  c.readFile = async () => new Uint8Array(32);
  c.exec = async (_, args) => ({ code: 0, stdout: args.includes('ls-files') ? `file-${++lists}\0` : '/repo/.git/index\n' });
  load(c, 'files-browser/gitState.js', ['gitState', 'fileState']);
  load(c, 'files-browser/main.js', ['Files']);
  const view = new c.Files(), context = {};
  await view.trackedFiles('/repo', null, context);
  const paths = await view.trackedFiles('/repo', null, context);
  assert.equal(lists, 2); assert.ok(paths.has('/repo/file-2'));
});

test('preview filters unrelated events, defers hidden tabs, and refreshes on return', async () => {
  const h = harness(), c = h.context, watchers = [];
  let reads = 0;
  const selection = { kind: 'file', root: '/repo', on: null, sourcePane: 'p', file: { path: 'README.md' } };
  c.shared = () => selection;
  c.readFile = async () => { reads++; return { rows: [{ text: 'hello' }] }; };
  c.isMarkdown = () => false;
  c.watchFolder = () => new Promise(resolve => watchers.push(resolve));
  load(c, 'git-file-preview/main.js', ['FilePreview']);
  const view = new c.FilePreview();
  // Leave the long-lived watcher separate from finite refresh jobs.
  h.cx.spawn = fn => { const promise = fn(h.cx); promise.catch(() => {}); };
  view.init({}, h.cx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle(); assert.equal(reads, 1);
  watchers.shift()(['/repo/node_modules/cache.tmp']); await settle();
  assert.equal(reads, 1);
  h.setTab('other');
  watchers.shift()(['/repo/README.md']); await settle();
  h.timers[0].fn(h.cx); await settle();
  assert.equal(reads, 1);
  h.setTab('tab'); view.render(h.cx); await settle();
  assert.equal(reads, 2);
  watchers.shift()(['/repo/.git/index']); await settle();
  assert.equal(reads, 3);
  view.close(); watchers.shift()([]); await settle();
});

test('unchanged source and diffs skip syntax highlighting without hiding gutter changes', async () => {
  const h = harness(), c = h.context;
  let highlights = 0, patch = '', source = 'hello\n';
  c.highlightRows = async () => { highlights++; };
  load(c, 'git-file-preview/gutter.js', ['lineChanges']);
  load(c, 'git-file-preview/content.js', ['readFile', 'readDiff']);
  const host = { readTextFile: async () => source, exec: async () => ({ code: 0, stdout: patch }) };
  const selection = { kind: 'file', root: '/repo', on: null, hasHead: true, file: { path: 'one.txt', status: 'M' } };
  const first = await c.readFile(selection, host);
  assert.equal(await c.readFile(selection, host, first), first); assert.equal(highlights, 1);
  patch = '@@ -1 +1 @@\n-old\n+hello\n';
  const changed = await c.readFile(selection, host, first);
  assert.notEqual(changed, first); assert.equal(changed.rows[0].change, 'modified');
  const diff = await c.readDiff(selection, host);
  const before = highlights;
  assert.equal(await c.readDiff(selection, host, diff), diff); assert.equal(highlights, before);
  source = 'new source\n';
  assert.notEqual(await c.readFile(selection, host, changed), changed);
  patch = '@@ -1 +1 @@\n-' + 'x'.repeat(100000) + '\n+' + 'y'.repeat(100000) + '\n';
  const longLines = await c.readDiff(selection, host);
  assert.ok(longLines.signature.length < 10000);
});

test('a file event during an active preview read is processed afterward', async () => {
  const h = harness(), c = h.context, watchers = [];
  let reads = 0, finish;
  c.shared = () => ({ kind: 'file', root: '/repo', sourcePane: 'p', file: { path: 'one.txt' } });
  c.readFile = async () => {
    if (++reads === 2) await new Promise(resolve => { finish = resolve; });
    return { rows: [{ text: String(reads) }] };
  };
  c.watchFolder = () => new Promise(resolve => watchers.push(resolve));
  load(c, 'git-file-preview/main.js', ['FilePreview']);
  h.cx.spawn = fn => { fn(h.cx).catch(() => {}); };
  const view = new c.FilePreview(), settle = () => new Promise(resolve => setImmediate(resolve));
  view.init({}, h.cx); await settle();
  watchers.shift()(['/repo/one.txt']); await settle();
  assert.equal(reads, 2);
  watchers.shift()(['/repo/one.txt']); await settle();
  finish(); await settle();
  assert.equal(reads, 3); assert.equal(view.rows[0].text, '3');
  view.close(); watchers.shift()([]); await settle();
});

test('unchanged Markdown keeps its render identity while changes outside the diff still update', async () => {
  const h = harness(), c = h.context;
  const result = { rows: [{ text: 'visible diff' }] };
  let text = 'original document';
  c.shared = () => ({ kind: 'file', root: '/repo', sourcePane: 'p', file: { path: 'README.md' } });
  c.readFile = async () => result;
  c.readMarkdown = async () => ({ text, truncated: false, deleted: false });
  load(c, 'git-file-preview/main.js', ['FilePreview']);
  const view = new c.FilePreview(); view.watch = () => {};
  view.init({}, h.cx); await h.flush();
  view.selectMode('markdown', h.cx); await h.flush();
  const version = view.markdownVersion, notifications = h.notifications();
  view.refresh(h.cx, true); await h.flush();
  assert.equal(view.markdownVersion, version); assert.equal(h.notifications(), notifications);
  text = 'document changed beyond the visible diff';
  view.refresh(h.cx, true); await h.flush();
  assert.equal(view.markdown.text, text); assert.equal(view.markdownVersion, version + 1);
  c.readMarkdown = async () => { throw Error('file removed'); };
  view.refresh(h.cx, true); await h.flush();
  assert.equal(view.markdown, null); assert.match(view.markdownError, /file removed/);
  c.readMarkdown = async () => ({ text, truncated: false, deleted: false });
  view.refresh(h.cx, true); await h.flush();
  assert.equal(view.markdown.text, text); assert.equal(view.markdownError, null);
});
