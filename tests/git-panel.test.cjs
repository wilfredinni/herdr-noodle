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
  assert.equal(find(history, `commit-${hash}`).attrs.h[0], 28);
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

test('History marks only commits absent from the tracked remote, including file history', async t => {
  const root = fixture(t), baseline = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'remote', 'add', 'origin', root); git(root, 'update-ref', 'refs/remotes/origin/main', baseline);
  git(root, 'branch', '--set-upstream-to=origin/main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'outgoing change\n');
  git(root, 'add', 'a.txt'); git(root, 'commit', '-qm', 'Outgoing file change');
  const outgoing = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'commit', '--allow-empty', '-qm', 'Another outgoing commit');
  const latest = git(root, 'rev-parse', 'HEAD').trim(), h = harness(root); await h.flush();
  h.view.selectView('history', h.cx); await h.flush();
  let rows = new Map(h.view.history.map(row => [row.fullHash, row]));
  assert.equal(rows.get(latest).unpushed, true); assert.equal(rows.get(outgoing).unpushed, true); assert.equal(rows.get(baseline).unpushed, false);
  let tree = h.view.render(h.cx);
  assert.ok(find(tree, `unpushed-commit-${outgoing}`)); assert.equal(find(tree, `unpushed-commit-${baseline}`), undefined);
  assert.match(find(tree, `commit-${baseline}`).attrs.tooltip[0], /On origin\/main/);
  assert.match(find(tree, `unpushed-commit-${outgoing}`).attrs.tooltip[0], /Unpushed to origin\/main/);
  h.view.showFileHistory('a.txt', h.cx); await h.flush();
  rows = new Map(h.view.history.map(row => [row.fullHash, row]));
  assert.equal(rows.has(latest), false); assert.equal(rows.get(outgoing).unpushed, true);
  // Advance only the disposable tracking ref, simulating a later fetch.
  git(root, 'update-ref', 'refs/remotes/origin/main', outgoing); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.view.history.find(row => row.fullHash === outgoing).unpushed, false);
  assert.equal(find(h.view.render(h.cx), `unpushed-commit-${outgoing}`), undefined);
  git(root, 'update-ref', '-d', 'refs/remotes/origin/main'); h.view.refresh(h.cx); await h.flush();
  assert.ok(h.view.history.every(row => row.upstream === undefined && row.unpushed === undefined));
  git(root, 'branch', 'local-base', baseline); git(root, 'config', 'branch.main.remote', '.'); git(root, 'config', 'branch.main.merge', 'refs/heads/local-base');
  h.view.refresh(h.cx); await h.flush();
  assert.ok(h.view.history.every(row => row.upstream === undefined && row.unpushed === undefined));
});

function openUndo(h) {
  find(h.view.render(h.cx), 'undo-last-commit').handlers.open_change(true, h.cx);
  return find(h.view.render(h.cx), 'undo-last-confirm');
}

test('last-commit undo preserves the index and working files and restores an empty draft', async t => {
  const root = fixture(t), parent = git(root, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'committed change\n'); git(root, 'add', 'a.txt'); git(root, 'commit', '-qm', 'Latest subject\n\nCommit body');
  const last = git(root, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'later unstaged change\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'separately staged addition\n'); git(root, 'add', 'b.txt');
  const h = harness(root); await h.flush();
  assert.equal(h.view.lastCommit.hash, last); assert.equal(h.view.lastCommit.subject, 'Latest subject');
  assert.match(texts(find(h.view.render(h.cx), 'last-commit-row')), /Latest subject/);
  const index = fs.readFileSync(path.join(root, '.git/index'));
  openUndo(h).handlers.click({}, h.cx); await h.flush();
  assert.deepEqual(h.errors, []); assert.equal(git(root, 'rev-parse', 'HEAD').trim(), parent);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.equal(git(root, 'show', ':a.txt'), 'committed change\n');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'later unstaged change\n');
  assert.equal(git(root, 'show', ':b.txt'), 'separately staged addition\n');
  assert.equal(h.view.message, 'Latest subject\n\nCommit body');
  assert.equal(h.view.lastCommit.hash, parent);
});

test('last-commit undo refuses a HEAD that changed after the displayed commit', async t => {
  const root = fixture(t); git(root, 'commit', '--allow-empty', '-qm', 'Displayed commit');
  const h = harness(root); await h.flush(); const confirm = openUndo(h);
  git(root, 'commit', '--allow-empty', '-qm', 'External commit');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  confirm.handlers.click({}, h.cx); await h.flush();
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head);
  assert.match(h.errors[0], /branch changed/);
});

test('last-commit undo keeps an existing commit-message draft', async t => {
  const root = fixture(t); git(root, 'commit', '--allow-empty', '-qm', 'Undo this subject');
  const h = harness(root); await h.flush(); h.view.message = 'Keep my draft'; h.view.messageRevision++;
  openUndo(h).handlers.click({}, h.cx); await h.flush();
  assert.deepEqual(h.errors, []); assert.equal(h.view.message, 'Keep my draft');
});

test('initial commits are displayed but cannot be undone with a soft reset', async t => {
  const root = fixture(t), h = harness(root); await h.flush();
  assert.equal(h.view.lastCommit.parents.length, 0);
  assert.equal(find(h.view.render(h.cx), 'undo-last-commit-button').attrs.disabled[0], true);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  h.view.undoSnapshot = { ...h.view.fileActions.snapshot(), commit: h.view.lastCommit };
  h.view.undoLastCommit(h.cx); await h.flush();
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head);
});

test('undoing a merge returns to its first parent and keeps the merged content staged', async t => {
  const root = fixture(t);
  git(root, 'switch', '-qc', 'topic'); fs.writeFileSync(path.join(root, 'topic.txt'), 'topic\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Topic change');
  git(root, 'switch', '-q', 'main'); git(root, 'commit', '--allow-empty', '-qm', 'Main change');
  const parent = git(root, 'rev-parse', 'HEAD').trim(); git(root, 'merge', '--no-ff', '-qm', 'Merge topic', 'topic');
  const h = harness(root); await h.flush(); assert.equal(h.view.lastCommit.parents.length, 2);
  openUndo(h).handlers.click({}, h.cx); await h.flush();
  assert.deepEqual(h.errors, []); assert.equal(git(root, 'rev-parse', 'HEAD').trim(), parent);
  assert.equal(git(root, 'show', ':topic.txt'), 'topic\n');
  assert.equal(fs.readFileSync(path.join(root, 'topic.txt'), 'utf8'), 'topic\n');
});

test('preview action bridge uses the existing Git guards and opens file history', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'a.txt'), 'preview work\n');
  const h = harness(root); await h.flush(); h.view.openFile(h.view.files[0], null, h.cx, { diffMode: 'unstaged' });
  const selectionKey = 'git-file-preview.tab'; let selection = h.state.get(selectionKey), id = 0;
  const request = async action => {
    h.state.set(`${selectionKey}.action`, { id: ++id, action, selection });
    h.view.render(h.cx); await h.flush();
    assert.equal(h.state.get(`${selectionKey}.result`).id, id);
  };
  await request('stage'); assert.equal(git(root, 'show', ':a.txt'), 'preview work\n');
  await request('unstage'); assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  h.state.set(`${selectionKey}.history`, { root: selection.root, on: selection.on, path: 'a.txt', sequence: 1 });
  h.view.render(h.cx); await h.flush(); assert.equal(h.view.view, 'history'); assert.equal(h.view.historyPath, 'a.txt');
  // Opening history updates the preview, so reselect the working file before sending another action.
  h.view.openFile(h.view.files[0], null, h.cx); selection = h.state.get(selectionKey);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'External commit');
  fs.writeFileSync(path.join(root, 'a.txt'), 'preserve this newer work\n');
  await request('discard'); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'preserve this newer work\n');
  assert.match(h.errors.at(-1), /branch changed/);
});

test('preview requests cannot mutate another selection or a historical commit', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'a.txt'), 'working\n');
  const h = harness(root); await h.flush(); h.view.openFile(h.view.files[0], null, h.cx);
  const key = 'git-file-preview.tab', selection = h.state.get(key);
  h.state.set(`${key}.action`, { id: 'old', action: 'discard', selection: { ...selection, hash: h.view.head } });
  h.view.render(h.cx); await h.flush(); assert.ok(h.state.get(`${key}.result`).error);
  h.state.set(`${key}.action`, { id: 'changed', action: 'discard', selection }); h.state.set(key, { ...selection, diffMode: 'staged' });
  h.view.render(h.cx); await h.flush(); assert.ok(h.state.get(`${key}.result`).error);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'working\n');
});
