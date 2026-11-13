const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(repositoryCount = 2) {
  let space = { id: 's', active: true, folder: '/workspace', machine: null };
  let cwd = '/workspace', focus = { pane: 'terminal', tab: 'tab' }, discoveryRuns = 0;
  const state = new Map(), jobs = [], commands = [], timers = [];
  const cx = { notify() {}, focus_handle: () => ({}), spawn(fn) { jobs.push(fn(cx)); }, timer: { every(ms, fn) { timers.push({ ms, fn }); } } };
  const input = { text: '', on() {}, set_value(text) { this.text = text; }, value() { return this.text; } };
  const root = () => cwd === '/workspace' ? null : cwd;
  const context = vm.createContext({ View: class {}, Map, JSON, Date,
    spaces: () => [space], focused: () => ({ ...focus, cwd }),
    panes: () => [{ pane: 'terminal', tab: 'tab', terminal: 't', cwd }, { pane: 'preview', tab: 'tab', mod: 'git-file-preview' }],
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    appHome: () => '/app', readTextFile: async () => 'discovery script',
    TextareaState: { new: () => input },
    GitToolbar: class { reset() {} }, FileActions: class { reset() {} }, CommitGenerator: class {},
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
