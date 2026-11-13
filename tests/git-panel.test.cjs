const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, execFileSync } = require('node:child_process');

const git = (root, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-panel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'a.txt'), 'baseline\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Baseline');
  return root;
}
function element(id) {
  const node = { id, nodes: [], attrs: {}, handlers: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key === 'id' && target.id === undefined) return value => (target.id = value, proxy);
    if (key in target) return target[key];
    if (['child', 'trigger', 'content'].includes(key)) return value => (target.nodes.push(value), proxy);
    if (key === 'children') return values => (target.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...values) => { target.attrs[key] = values; if (key.startsWith('on_')) target.handlers[key.slice(3)] = values.at(-1); return proxy; };
  } }); return proxy;
}
const find = (node, id) => node?.id === id ? node : node?.nodes?.map(child => find(child, id)).find(Boolean);
const texts = node => typeof node === 'string' ? node : (node?.nodes || []).map(texts).join(' ');
function load(c, file, names) {
  const source = fs.readFileSync(path.join(__dirname, '../mods/changes-graph', file), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class Changes', 'class Changes').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, {${names.join(',')}}); })()`, c);
}
function harness(root) {
  const jobs = [], state = new Map(), errors = [];
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, write_to_clipboard() {}, timer: { every() {} }, spawn(fn) { jobs.push(fn(cx)); } };
  const input = () => { let value = ''; return { on() {}, value: () => value, set_value(next) { value = next; }, focus() {} }; };
  const t = new Proxy({}, { get: (_, key) => key });
  const c = vm.createContext({ Map, Set, View: class {}, div: element, svg: () => element(), image: () => element(), h_flex: element, v_flex: element,
    Button: { new: element }, Checkbox: { new: element }, Popover: { new: element }, Tabs: { new: element }, Tab: { new: element },
    TextareaState: { new: input }, Textarea: { new: element }, InputState: { new: input }, Input: { new: element },
    Scrollbar: { vertical: element, horizontal: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    settings: () => ({}), theme: () => t, spaces: () => [{ id: 's', active: true, folder: root, machine: null }],
    focused: () => ({ pane: 'terminal', tab: 'tab', cwd: root }), panes: () => [{ pane: 'terminal', terminal: 't', tab: 'tab', cwd: root }],
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value), run() {},
    Repositories: class { constructor(_, workspace) { this.rows = []; this.workspace = workspace; } refresh() {} update() {} },
    exec: (command, args, options) => new Promise(resolve => execFile(command, args, { cwd: options.cwd, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))),
    showGitError: (_, error) => errors.push(error.message), notify() {},
  });
  load(c, 'graph.js', ['GRAPH_ARGS', 'HISTORY_ARGS', 'GRAPH_LIMIT', 'GRAPH_ROW_HEIGHT', 'graphRows', 'COMMIT_FORMAT', 'commitDetail', 'refLabels', 'shortAge']);
  load(c, 'fileOps.js', ['git', 'verify', 'stage', 'stashes', 'popStash', 'trash', 'addIgnore', 'changeStash']);
  load(c, 'gitToolbar.js', ['GitToolbar']); load(c, 'fileActions.js', ['FileActions']); load(c, 'commitGenerator.js', ['CommitGenerator']);
  load(c, 'stashPanel.js', ['StashPanel']); load(c, 'main.js', ['Changes', 'upstreamState']);
  const view = new c.Changes(); view.watch = () => {}; view.init({}, cx); view.generator.machine = null;
  return { c, cx, view, state, t, errors, async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}

test('partially staged files have separate previews and stage controls with the same real index', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'staged\n'); git(root, 'add', 'a.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), 'working\n');
  const h = harness(root); await h.flush();
  let tree = h.view.render(h.cx);
  for (const id of ['git-view-changes', 'git-view-history', 'git-view-graph', 'git-view-stashes']) assert.ok(find(tree, id));
  find(tree, 'change-staged-a.txt:tracked').handlers.click({}, h.cx);
  assert.equal(h.state.get('git-file-preview.tab').diffMode, 'staged');
  find(tree, 'change-unstaged-a.txt:tracked').handlers.click({}, h.cx);
  assert.equal(h.state.get('git-file-preview.tab').diffMode, 'unstaged');
  assert.equal(git(root, 'show', ':a.txt'), 'staged\n');
  find(tree, 'toggle-staged').handlers.click({}, h.cx);
  assert.equal(find(h.view.render(h.cx), 'change-staged-a.txt:tracked'), undefined);
  find(tree, 'toggle-staged').handlers.click({}, h.cx);
  find(tree, 'select-file-unstaged-a.txt:tracked').handlers.change(true, h.cx); await h.flush();
  assert.equal(git(root, 'show', ':a.txt'), 'working\n');
  tree = h.view.render(h.cx);
  assert.equal(find(tree, 'change-unstaged-a.txt:tracked'), undefined);
  assert.match(texts(find(tree, 'commit')), /Commit 1 file/);
  find(tree, 'select-file-staged-a.txt:tracked').handlers.change(false, h.cx); await h.flush();
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'working\n');
  assert.match(texts(find(h.view.render(h.cx), 'commit')), /Commit all/);
  assert.deepEqual(h.errors, []);
});

test('Stash view reads real entries and previews, and cancels an action after a repository change', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'saved work\n'); git(root, 'stash', 'push', '-qm', 'Saved work');
  const h = harness(root); await h.flush(); h.view.selectView('stashes', h.cx); await h.flush();
  assert.equal(h.view.stash.entries.length, 1);
  const entry = h.view.stash.entries[0];
  h.view.stash.show(entry, h.cx); await h.flush();
  assert.match(h.view.stash.patch, /saved work/);
  assert.match(texts(h.view.render(h.cx)), /View diff.*Apply.*Pop.*Drop/);
  h.view.stash.confirm(entry, 'drop', h.cx);
  h.view.context = 'changed'; h.view.stash.perform(h.cx); await h.flush();
  assert.equal(git(root, 'stash', 'list', '--format=%H').trim(), entry.hash);
});

test('selecting a Graph commit opens its real file diff in the shared preview', async t => {
  const root = fixture(t), h = harness(root); await h.flush();
  const hash = git(root, 'rev-parse', 'HEAD').trim();
  h.view.selectView('history', h.cx); await h.flush();
  const history = h.view.render(h.cx);
  assert.equal(find(history, `commit-${hash}`).attrs.h[0], 24);
  assert.doesNotMatch(texts(history), /\d+ commits\b|All changed files in/);
  h.view.view = 'graph'; h.view.pickCommit({ fullHash: hash }, h.cx); await h.flush();
  const selection = h.state.get('git-file-preview.tab');
  assert.equal(selection.hash, hash); assert.equal(selection.file.path, 'a.txt');
  assert.equal(selection.root, h.view.root);
  assert.deepEqual(h.errors, []);
});

test('apply keeps a stash; pop removes only the selected stash; stale refs cannot drop another stash', async t => {
  const root = fixture(t);
  for (const subject of ['first', 'second']) {
    fs.writeFileSync(path.join(root, 'a.txt'), subject + '\n'); git(root, 'stash', 'push', '-qm', subject);
  }
  const h = harness(root); await h.flush();
  const snapshot = h.view.fileActions.snapshot(), entries = await h.c.stashes(snapshot);
  await h.c.changeStash(entries[1], 'apply', snapshot);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'first\n');
  assert.equal((await h.c.stashes(snapshot)).length, 2);
  git(root, 'restore', '--staged', '--worktree', '--', 'a.txt');
  await h.c.changeStash(entries[0], 'pop', snapshot);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'second\n');
  await assert.rejects(h.c.changeStash(entries[1], 'drop', snapshot), /stash list changed/);
  const remaining = await h.c.stashes(snapshot); assert.equal(remaining.length, 1); assert.equal(remaining[0].hash, entries[1].hash);
  await h.c.changeStash(remaining[0], 'drop', snapshot); assert.equal((await h.c.stashes(snapshot)).length, 0);
});

test('pop keeps the stash when applying causes a conflict', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'stashed edit\n'); git(root, 'stash', 'push', '-qm', 'Conflict fixture');
  fs.writeFileSync(path.join(root, 'a.txt'), 'committed edit\n'); git(root, 'commit', '-qam', 'Different edit');
  const h = harness(root); await h.flush();
  const snapshot = h.view.fileActions.snapshot(), entries = await h.c.stashes(snapshot);
  await assert.rejects(h.c.changeStash(entries[0], 'pop', snapshot));
  assert.equal((await h.c.stashes(snapshot))[0].hash, entries[0].hash);
  h.view.refresh(h.cx); await h.flush();
  h.view.message = 'Resolve';
  assert.equal(find(h.view.render(h.cx), 'commit').attrs.disabled[0], true);
  assert.equal(h.view.generator.enabled(), false);
});

test('primary Git action follows real upstream counts without fetching', async t => {
  const root = fixture(t);
  git(root, 'remote', 'add', 'origin', root);
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'branch', '--set-upstream-to=origin/main');
  const baseline = git(root, 'rev-parse', 'HEAD').trim(), h = harness(root); await h.flush();
  assert.equal(h.view.sync.upstream, 'origin/main');
  assert.equal(texts(find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch')).trim(), 'Fetch');
  git(root, 'commit', '--allow-empty', '-qm', 'Outgoing');
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.sync.ahead, 1);
  assert.equal(texts(find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch')).trim(), 'Push (1)');
  const run = h.view.gitToolbar.run;
  let push;
  h.view.gitToolbar.run = (...args) => { push = args; };
  find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch').handlers.click({}, h.cx);
  assert.deepEqual(Array.from(push[1]), ['push']);
  assert.equal(push[4], h.view.head);
  h.view.gitToolbar.run = run;
  const outgoing = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'update-ref', 'refs/remotes/origin/main', outgoing);
  git(root, 'reset', '--hard', baseline);
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.sync.behind, 1);
  assert.equal(texts(find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch')).trim(), 'Pull (1)');
  git(root, 'commit', '--allow-empty', '-qm', 'Diverged');
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.sync.ahead, 1); assert.equal(h.view.sync.behind, 1);
  let button = find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch');
  assert.equal(texts(button).trim(), 'Pull (1)');
  // Inspect the click's command without invoking a remote or changing the worktree.
  let action;
  h.view.gitToolbar.run = (...args) => { action = args; };
  button.handlers.click({}, h.cx);
  assert.deepEqual(Array.from(action[1]), ['pull', '--ff-only']);
  assert.equal(action[4], h.view.head);
  git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.sync, null);
  button = find(h.view.gitToolbar.render(h.t, h.cx), 'git-fetch');
  assert.equal(texts(button).trim(), 'Fetch');
});
