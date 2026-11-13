const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element(id) {
  const node = { id, nodes: [], attrs: {}, handlers: {} }; let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key === 'id' && target.id == null) return value => (target.id = value, proxy);
    if (key in target) return target[key];
    if (['child', 'trigger', 'content'].includes(key)) return value => (target.nodes.push(value), proxy);
    if (key === 'children') return values => (target.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...values) => { target.attrs[key] = values; if (key.startsWith('on_')) target.handlers[key.slice(3)] = values.at(-1); return proxy; };
  } }); return proxy;
}
const find = (node, id) => node?.id === id ? node : node?.nodes?.map(child => find(child, id)).find(Boolean);
const texts = node => typeof node === 'string' ? node : (node?.nodes || []).map(texts).join(' ');

function harness(repositoryCount = 2) {
  let space = { id: 's', active: true, folder: '/workspace', machine: null };
  let cwd = '/workspace', focus = { pane: 'terminal', tab: 'tab' }, discoveryRuns = 0;
  const state = new Map(), jobs = [], commands = [], timers = [];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({}), spawn(fn) { jobs.push(fn(cx)); }, timer: { every(ms, fn) { timers.push({ ms, fn }); } } };
  const input = { text: '', on() {}, set_value(text) { this.text = text; }, value() { return this.text; } };
  const root = () => cwd === '/workspace' ? null : cwd;
  const context = vm.createContext({ View: class {}, Map, JSON, Date,
    div: element, svg: () => element(), v_flex: element, h_flex: element, Button: { new: element }, Popover: { new: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    spaces: () => [space], focused: () => ({ ...focus, cwd }),
    panes: () => [{ pane: 'terminal', tab: 'tab', terminal: 't', cwd }, { pane: 'preview', tab: 'tab', mod: 'git-file-preview' }],
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    appHome: () => '/app', readTextFile: async () => 'discovery script',
    TextareaState: { new: () => input },
    GitToolbar: class { reset() {} }, FileActions: class { reset() {} }, CommitGenerator: class {}, StashPanel: class { reset() {} },
    exec: async (program, args, options) => {
      commands.push({ program, args: [...args], options });
      if (program === 'python3') { discoveryRuns++; return { code: 0, stdout: JSON.stringify({ repositories: [
        { root: '/workspace/a', name: 'a', branch: 'main', count: 1 },
        { root: '/workspace/b', name: 'b', branch: 'topic', count: 1 }].slice(0, repositoryCount), limited: false }) }; }
      if (args.includes('--show-toplevel')) {
        const path = options.cwd.startsWith('/workspace/') ? options.cwd.split('/').slice(0, 3).join('/') : root();
        return { code: path ? 0 : 1, stdout: path || '' };
      }
      return { code: 0, stdout: args.includes('status') ? ' M one.txt\0' : args.includes('symbolic-ref') ? 'refs/heads/main' : args.includes('--verify') ? 'a'.repeat(40) : '' };
    },
    run: (name, args) => commands.push({ name, args }), showGitError() {},
  });
  for (const [file, name] of [['repositories.js', 'Repositories'], ['main.js', 'Changes']]) {
    const source = fs.readFileSync(`${__dirname}/../mods/changes-graph/${file}`, 'utf8').replace(/^import .*;\n/gm, '')
      .replace('export default class Changes', 'class Changes').replace(/export /g, '');
    vm.runInContext(`${source}\nglobalThis.${name} = ${name}`, context);
  }
  const view = new context.Changes(); view.watch = () => {}; view.init({}, cx);
  return { view, cx, context, state, commands, timers, input,
    navigate(path) { cwd = path; }, focusPreview() { focus = { pane: 'preview', tab: 'tab' }; },
    setSpace(value) { space = { ...space, ...value }; }, discoveryRuns: () => discoveryRuns,
    async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}

test('workspace picker scopes Git, keeps drafts, and opens previews for the selected repository', async () => {
  const h = harness(), { view, cx } = h;
  await h.flush();
  assert.equal(view.root, null);
  view.repositories.choose(view.repositories.rows[0], cx); await h.flush();
  assert.equal(view.root, '/workspace/a');
  view.message = 'draft A';
  view.repositories.choose(view.repositories.rows[1], cx); await h.flush();
  assert.equal(view.root, '/workspace/b'); assert.equal(view.message, '');
  view.message = 'draft B';
  view.repositories.choose(view.repositories.rows[0], cx); await h.flush();
  assert.equal(view.message, 'draft A');
  view.openFile(view.files[0], null, cx);
  const selection = h.state.get('git-file-preview.tab');
  assert.equal(selection.root, '/workspace/a'); assert.equal(selection.sourcePane, 'terminal');
  h.focusPreview();
  assert.equal(h.context.location().cwd, '/workspace/a');
  view.busy = true; view.repositories.choose(view.repositories.rows[1], cx);
  assert.equal(h.context.location().cwd, '/workspace/a');
  view.busy = false;
  h.state.delete('git.repository.s'); h.navigate('/workspace/a/subfolder');
  view.refresh(cx); await h.flush();
  assert.equal(view.message, 'draft A');
  h.setSpace({ machine: 'remote', folder: '/remote' });
  assert.notEqual(h.context.location().cwd, '/workspace/a');
});

test('a stale Git action snapshot is invalid after choosing another repository', async () => {
  const h = harness(); await h.flush();
  const source = fs.readFileSync(`${__dirname}/../mods/changes-graph/gitToolbar.js`, 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nglobalThis.Toolbar = GitToolbar; })()`, h.context);
  const toolbar = Object.create(h.context.Toolbar.prototype);
  toolbar.owner = h.view; toolbar.key = () => JSON.stringify(h.context.location());
  h.view.repositories.choose(h.view.repositories.rows[0], h.cx); await h.flush();
  const snapshot = toolbar.snapshot(); assert.equal(toolbar.current(snapshot), true);
  h.view.repositories.choose(h.view.repositories.rows[1], h.cx); await h.flush();
  assert.equal(toolbar.current(snapshot), false);
});

test('discovery runs once per workspace and rejects stale rows on a space change', async () => {
  const h = harness(); await h.flush();
  const rows = h.view.repositories.rows;
  for (let i = 0; i < 100; i++) h.view.repositories.refresh(h.cx);
  await h.flush(); assert.equal(h.discoveryRuns(), 1);
  h.setSpace({ id: 'other', folder: '/other' }); h.navigate('/other');
  h.view.repositories.choose(rows[0], h.cx);
  assert.equal(h.state.get('git.repository.other'), undefined);
  h.view.repositories.refresh(h.cx); await h.flush();
  assert.equal(h.discoveryRuns(), 2);
});

test('discovery uses the live terminal folder rather than the space creation folder', async () => {
  const h = harness(); await h.flush();
  h.setSpace({ folder: '/old-workspace' });
  h.view.repositories.refresh(h.cx); await h.flush();
  assert.equal(h.discoveryRuns(), 1);
  assert.equal(h.context.workspace().folder, '/workspace');
});

test('a single child repository opens automatically', async () => {
  const h = harness(1); await h.flush();
  assert.equal(h.view.root, '/workspace/a');
  assert.equal(h.state.get('git.repository.s').root, '/workspace/a');
});

test('repository title picker shows status, switches with keys, closes, and preserves drafts', async () => {
  const h = harness(); await h.flush();
  const repos = h.view.repositories, t = new Proxy({}, { get: (_, key) => key });
  repos.choose(repos.rows[0], h.cx); await h.flush(); h.view.message = 'Keep my draft';
  Object.assign(repos.rows[1], { ahead: 2, behind: 1, count: 5, conflict: true });
  let picker = repos.selector('a', t, h.cx);
  assert.ok(find(picker, 'repository-select')); assert.equal(find(picker, 'repositories-toggle'), undefined);
  picker.handlers.open_change(true, h.cx); picker = repos.selector('a', t, h.cx);
  assert.equal(repos.open, true); assert.match(texts(picker), /workspace · 2 repositories.*b.*topic.*↑2 ↓1.*5/);
  assert.equal(find(picker, 'repository-/workspace/a').attrs.bg[0], 'selected');
  assert.equal(typeof find(picker, 'repository-/workspace/b').attrs.hover[0], 'function');
  assert.equal(typeof find(picker, 'repository-select').attrs.hover[0], 'function');
  picker.nodes[1].handlers.key_down({ key: 'down' }, h.cx);
  picker.nodes[1].handlers.key_down({ key: 'enter' }, h.cx); await h.flush();
  assert.equal(h.view.root, '/workspace/b'); assert.equal(repos.open, false);
  repos.choose(repos.rows[0], h.cx); await h.flush(); assert.equal(h.view.message, 'Keep my draft');
  picker = repos.selector('a', t, h.cx); picker.handlers.open_change(true, h.cx);
  picker.nodes[1].handlers.key_down({ key: 'escape' }, h.cx); assert.equal(repos.open, false);
  h.view.busy = true; picker.handlers.open_change(true, h.cx); assert.equal(repos.open, false);
});

test('zero or one repository keeps a plain title and a workspace change closes the picker', async () => {
  const h = harness(1); await h.flush();
  const repos = h.view.repositories, t = new Proxy({}, { get: (_, key) => key });
  assert.equal(find(repos.selector('a', t, h.cx), 'repository-select'), undefined);
  repos.rows = []; assert.match(texts(repos.selector('Repository', t, h.cx)), /Repository/);
  repos.open = true; h.navigate('/other'); repos.refresh(h.cx); assert.equal(repos.open, false); await h.flush();
});
