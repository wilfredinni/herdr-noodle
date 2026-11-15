const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
function input(options = {}) {
  let value = options.value || ''; const events = {};
  return { on(name, fn) { events[name] = fn; }, value: () => value, set_value(next) { value = next; }, focus() {},
    type(next, cx) { value = next; events.change?.({}, cx); }, blur(cx) { events.blur?.({}, cx); } };
}
const find = (node, id) => node?.id === id ? node : node?.nodes?.map(child => find(child, id)).find(Boolean);
function load(c, file, names) {
  const source = fs.readFileSync(`${__dirname}/../mods/changes-graph/${file}`, 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, {${names.join(',')}}); })()`, c);
}
function harness() {
  const state = new Map(), jobs = [], timers = [], requests = [], overlays = [], closed = [], clipboard = [], urls = [], files = new Map();
  let response = action => action === 'ready' ? { ready: true, head: 'a'.repeat(40), branch: 'feature' } : action === 'info' ? { repo: { name: 'example/repo' }, templates: [] } : action === 'prs' || action === 'runs' ? { items: [], more: false } : {};
  let notifications = 0;
  const cx = { notify() { notifications++; }, focus_handle: () => ({ focus() {} }), timer: { every(ms, fn) { timers.push({ ms, fn }); } },
    spawn(fn) { jobs.push(fn(cx)); }, write_to_clipboard(value) { clipboard.push(value); }, open_url(value) { urls.push(value); } };
  const c = vm.createContext({ Map, Set, Date, JSON, div: element, svg: () => element(), image: element, v_flex: element, h_flex: element,
    Button: { new: element }, InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element }, Checkbox: { new: element },
    Popover: { new: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: element }, TextView: { markdown: (id, text) => element(id).child(text) },
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value), appHome: () => '/app', notify() {},
    openOverlay: value => overlays.push(value), closeOverlay: value => closed.push(value), shortAge: () => '1m',
    writeTextFile: async (path, value, expected) => { assert.equal(expected, '{}'); files.set(path, JSON.parse(value)); },
    exec: async (_program, args) => { const action = args[1].replace('github_', ''), request = JSON.parse(args[2]); requests.push({ action, request }); return { code: 0, stdout: JSON.stringify(await response(action, request)) }; },
  });
  load(c, 'commitGenerator.js', ['CommitGenerator']);
  load(c, 'githubPanel.js', ['GithubPanel', 'githubCall', 'githubButton', 'githubOpen', 'threadMarkdown']);
  load(c, 'prComposer.js', ['PrComposer', 'PrSettings', 'prSettingsKey', 'prDraftKey']);
  const t = new Proxy({}, { get: (_, key) => key });
  const owner = { root: '/repo', on: null, context: 'context', branch: 'feature', head: 'a'.repeat(40), view: 'github', files: [], gitToolbar: { render: () => element(), enabled: () => true } };
  state.set('github.active', { ...owner });
  const panel = new c.GithubPanel(owner, () => owner.context, cx);
  const options = { ...owner, overlay: 'composer', info: { repo: { name: 'example/repo', defaultBranchRef: { name: 'main' } }, templates: [] } };
  const composer = () => {
    const view = new c.PrComposer(options, cx); view.generator.machine = null;
    view.generator.connections = [{ id: 'codex', name: 'Codex', models: [{ id: 'model', name: 'Model' }] }]; view.generator.selected = { connection: 'codex', model: 'model' };
    return view;
  };
  return { c, cx, t, panel, owner, options, state, requests, overlays, closed, clipboard, urls, timers, files, composer,
    setResponse(fn) { response = fn; }, notifications: () => notifications,
    async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}

const pr = () => ({ number: 1, title: 'Example PR', html_url: 'https://github.com/example/repo/pull/1', body: 'Description', state: 'open',
  head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } }, base: { ref: 'main' }, user: { login: 'author' },
  reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix', html_url: 'https://github.com/review' }],
  statusCheckRollup: [{ name: 'Tests', conclusion: 'FAILURE' }], threads: [
    { id: 'thread-1', path: 'a.js', line: 4, isResolved: false, comments: [{ id: 'comment-1', author: { login: 'reviewer' }, body: 'Check this', url: 'https://github.com/comment' }] },
    { id: 'thread-2', path: 'b.js', originalLine: 9, isResolved: true, isOutdated: true, comments: [] },
  ] });

test('GitHub displays PR details, threads and complete Markdown extraction', async () => {
  const h = harness(), value = pr();
  h.setResponse(action => action === 'info' ? { repo: { name: 'example/repo' }, templates: [] } : action === 'prs' ? { items: [value], more: false } : value);
  h.panel.refresh(h.cx); await h.flush();
  const tree = h.panel.render(h.t, h.cx);
  assert.ok(find(tree, 'github-pr-detail')); assert.ok(find(tree, 'github-location-0')); assert.equal(find(tree, 'github-location-1'), undefined);
  find(tree, 'github-copy-unresolved').handlers.click({}, h.cx);
  assert.match(h.clipboard[0], /a.js:4.*Unresolved/); assert.match(h.clipboard[0], /reviewer/); assert.match(h.clipboard[0], /https:\/\/github.com\/comment/);
  assert.doesNotMatch(h.clipboard[0], /b.js/);
  h.panel.folded['thread-2'] = false; assert.ok(find(h.panel.render(h.t, h.cx), 'github-location-1'));
});

test('stale PR responses cannot replace a different selection or repository', async () => {
  const h = harness(); let complete;
  h.setResponse(() => new Promise(resolve => { complete = resolve; }));
  h.panel.showPr(pr(), h.cx); h.owner.context = 'other'; complete(pr()); await h.flush();
  assert.equal(h.panel.pr, null);
});

test('GitHub refresh failure preserves previous data and allows retry', async () => {
  const h = harness(); h.panel.prs = [pr()];
  h.setResponse(() => { throw Error('Authentication required'); }); h.panel.refresh(h.cx); await h.flush();
  assert.equal(h.panel.prs.length, 1); assert.equal(h.panel.error, 'Authentication required'); assert.equal(h.panel.loading, false);
});

test('workflow polling happens only when visible and running', async () => {
  const h = harness(); h.panel.mode = 'workflows'; h.panel.info = h.options.info; h.panel.runs = [{ id: 1, status: 'in_progress' }];
  h.owner.view = 'changes'; h.timers[0].fn(h.cx); await h.flush(); assert.equal(h.requests.length, 0);
  h.owner.view = 'github'; h.timers[0].fn(h.cx); await h.flush(); assert.equal(h.requests[0].action, 'runs');
  h.requests.length = 0; h.panel.runs = [{ id: 1, status: 'completed' }]; h.timers[0].fn(h.cx); assert.equal(h.requests.length, 0);
});

test('composer keeps retained inputs, avoids per-keystroke notifications, and persists drafts', async () => {
  const h = harness(), view = h.composer(); await h.flush();
  const inputs = [view.title, view.body, view.base];
  view.title.type('Title', h.cx); const before = h.notifications();
  for (let i = 0; i < 100; i++) { view.body.type('Body ' + i, h.cx); view.render(h.t, h.cx); }
  assert.equal(h.notifications(), before); assert.deepEqual([view.title, view.body, view.base], inputs);
  view.close(); const reopened = h.composer(); await h.flush();
  assert.equal(reopened.title.value(), 'Title'); assert.equal(reopened.body.value(), 'Body 99'); assert.equal(reopened.base.value(), 'main');
});

test('generation preserves edits and ignores changed instructions', async () => {
  const h = harness(), view = h.composer(); await h.flush();
  let complete; view.submit = async () => new Promise(resolve => { complete = resolve; });
  view.generate(h.cx); view.body.type('My edit', h.cx); complete({ title: 'Generated', body: 'Generated body' }); await h.flush();
  assert.equal(view.body.value(), 'My edit'); assert.equal(view.busy, false);
  view.generate(h.cx); h.state.set(view.settingsKey, { instructions: 'New instructions', template: '' }); complete({ title: 'Generated', body: 'Generated body' }); await h.flush();
  assert.equal(view.body.value(), 'My edit');
});

test('settings icon precedes Generate and Create and uses the existing settings icon', async () => {
  const h = harness(), view = h.composer(); await h.flush();
  const tree = view.render(h.t, h.cx), ids = node => [node?.id, ...(node?.nodes || []).flatMap(ids)];
  const order = ids(tree); assert.ok(order.indexOf('pr-instructions') < order.indexOf('generate-pr')); assert.ok(order.indexOf('generate-pr') < order.indexOf('create-pr'));
  find(tree, 'pr-instructions').handlers.click({}, h.cx); assert.equal(h.overlays[0].props.prSettings, true);
});

test('creation is single flight and draft text is passed through a private file', async () => {
  const h = harness(), view = h.composer(); await h.flush();
  view.title.type('Title', h.cx); view.body.type('Private description', h.cx);
  h.setResponse(action => action === 'prepare' ? { token: 'token', path: '/private/request.json' } : { url: 'https://github.com/example/repo/pull/9' });
  view.create(h.cx); view.create(h.cx); await h.flush();
  assert.equal(h.requests.filter(request => request.action === 'create').length, 1);
  assert.equal(h.files.get('/private/request.json').body, 'Private description');
  assert.equal(h.requests.some(request => JSON.stringify(request).includes('Private description')), false);
  assert.equal(h.state.get(view.key), null);
});

test('unpublished branch uses a separate Publish action and preserves its composer draft', async () => {
  const h = harness(); h.setResponse(() => ({ ready: false, head: h.owner.head, branch: h.owner.branch }));
  const view = h.composer(); await h.flush(); view.title.type('Keep me', h.cx);
  view.create(h.cx); assert.equal(h.requests.some(request => request.action === 'create'), false);
  view.publish(h.cx); assert.equal(h.state.get('github.publish').action, 'publish'); assert.equal(h.state.get(view.key).title, 'Keep me');
});

test('PR render performs no network calls and stays bounded for a normal review', () => {
  const h = harness(); h.panel.pr = pr(); h.panel.prs = [h.panel.pr];
  const before = h.requests.length, start = performance.now();
  for (let i = 0; i < 100; i++) h.panel.render(h.t, h.cx);
  assert.equal(h.requests.length, before); assert.ok(performance.now() - start < 1500);
});

test('branch changes reset selection and the current PR is selected beyond the first list page', async () => {
  const h = harness(), value = pr();
  h.setResponse(action => action === 'info' ? { repo: { name: 'example/repo' }, current: value } : action === 'prs' ? { items: [], more: true } : value);
  h.panel.enter(h.cx); await h.flush(); assert.equal(h.panel.pr.number, 1);
  assert.ok(find(h.panel.render(h.t, h.cx), 'github-back'));
  h.panel.back(h.cx); assert.equal(h.panel.pr, null); assert.equal(h.panel.prNumber, null);
  h.panel.refresh(h.cx); await h.flush(); assert.equal(h.panel.pr, null);
  h.owner.branch = 'other'; h.panel.enter(h.cx); await h.flush();
  assert.equal(h.panel.loadedBranch, 'other');
});

test('workflow details copy failure logs with the run, commit and truncation context', async () => {
  const h = harness(); h.panel.mode = 'workflows';
  h.panel.run = { id: 42, display_title: 'Tests', html_url: 'https://github.com/example/repo/actions/runs/42', head_branch: 'feature', head_sha: 'a'.repeat(40), jobs: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] };
  h.panel.runId = 42;
  h.setResponse(() => ({ text: 'AssertionError: example', head: 'a'.repeat(40), truncated: true }));
  const tree = h.panel.render(h.t, h.cx); assert.ok(find(tree, 'github-job-log-1'));
  find(tree, 'github-failed-logs').handlers.click({}, h.cx); await h.flush();
  assert.match(h.clipboard[0], /AssertionError/); assert.match(h.clipboard[0], /Truncated/); assert.match(h.clipboard[0], /runs\/42/);
});

test('remote browsing resolves the helper home on the remote machine', async t => {
  const h = harness(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'github remote home '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'helpers/noodle'), { recursive: true });
  fs.writeFileSync(path.join(home, 'helpers/noodle/workspace.py'), 'import json,sys\nr=json.loads(sys.argv[2]); print(json.dumps({"home":r["home"],"root":r["root"]}))\n');
  h.c.exec = async (program, args, options) => {
    assert.equal(options.on, 'worker');
    return { code: 0, stdout: execFileSync(program, args, { encoding: 'utf8', env: { ...process.env, HERDR_APP_HOME: home } }) };
  };
  const result = await h.c.githubCall('prs', { root: '/remote/repo', on: 'worker' });
  assert.equal(result.home, home); assert.equal(result.root, '/remote/repo');
});
