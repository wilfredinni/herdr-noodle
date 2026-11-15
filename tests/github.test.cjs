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
    type(next, cx) { value = next; events.change?.({}, cx); }, blur(cx) { events.blur?.({}, cx); }, submit(cx) { events.submit?.({}, cx); } };
}
const find = (node, id) => node?.id === id ? node : node?.nodes?.map(child => find(child, id)).find(Boolean);
function load(c, file, names) {
  const source = fs.readFileSync(`${__dirname}/../mods/changes-graph/${file}`, 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, {${names.join(',')}}); })()`, c);
}
function harness() {
  const state = new Map(), jobs = [], timers = [], requests = [], overlays = [], closed = [], clipboard = [], urls = [], files = new Map(), commands = [];
  const paneList = [{pane:"terminal",terminal:"t",tab:"tab",cwd:"/repo"}];
  let response = action => action === 'ready' ? { ready: true, head: 'a'.repeat(40), branch: 'feature' } : action === 'info' ? { repo: { name: 'example/repo' }, templates: [] } : action === 'prs' || action === 'runs' ? { items: [], more: false } : {};
  let notifications = 0;
  const cx = { notify() { notifications++; }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every(ms, fn) { timers.push({ ms, fn }); } },
    spawn(fn) { jobs.push(fn(cx)); }, write_to_clipboard(value) { clipboard.push(value); }, open_url(value) { urls.push(value); } };
  const c = vm.createContext({ Map, Set, Date, JSON, div: element, svg: () => element(), image: element, v_flex: element, h_flex: element,
    Button: { new: element }, v_virtual_list: (id,count,size,key,render)=>{const node=element(id);node.attrs.virtual={count,size,key,render};return node;}, Tabs: { new: element }, Tab: { new: element }, InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element }, Checkbox: { new: element },
    Popover: { new: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: element }, TextView: { markdown: (id, text) => element(id).child(text) },
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value), appHome: () => '/app', notify() {},
    focused: () => ({pane:'terminal',tab:'tab'}), panes: () => paneList, run: (name,args) => commands.push({name,args}),
    openOverlay: value => overlays.push(value), closeOverlay: value => closed.push(value), shortAge: () => '1m',
    writeTextFile: async (path, value, expected) => { assert.equal(expected, '{}'); files.set(path, JSON.parse(value)); },
    exec: async (_program, args) => { const action = args[1].replace('github_', ''), request = JSON.parse(args[2]); requests.push({ action, request }); return { code: 0, stdout: JSON.stringify(await response(action, request)) }; },
  });
  load(c, 'commitGenerator.js', ['CommitGenerator']);
  load(c, 'reviewMarkdown.js', ['reviewSegments', 'diffColor', 'reviewMarkdown']);
  load(c, 'githubPanel.js', ['GithubPanel', 'githubCall', 'githubButton', 'githubOpen', 'threadMarkdown', 'prCounts']);
  load(c, 'githubPreview.js', ['GithubPreview']);
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
  return { c, cx, t, panel, owner, options, state, requests, overlays, closed, clipboard, urls, timers, files, composer, commands, paneList,
    preview(selection) { state.set("github.preview.tab", selection || {...owner,tab:"tab",sourcePane:"terminal",mode:"pr",number:1,title:"Example PR"}); return new c.GithubPreview({selectionKey:"github.preview.tab"},cx); },
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

test('sidebar keeps its list and selecting a row opens a separate preview with extractable reviews', async () => {
  const h = harness(), value = pr();
  h.setResponse(action => action === 'info' ? { repo: { name: 'example/repo' }, templates: [] } : action === 'prs' ? { items: [value], more: false } : value);
  h.panel.refresh(h.cx); await h.flush();
  let tree = h.panel.render(h.t, h.cx);
  assert.ok(find(tree, 'github-row-1')); assert.equal(find(tree, 'github-pr-detail'), undefined);
  assert.equal(h.requests.some(r=>r.action==='pr'), false);
  find(tree, 'github-row-1').handlers.click({},h.cx);
  assert.equal(h.commands[0].name,'pane.split'); assert.equal(h.commands[0].args.props.githubPreview,true);
  const preview = h.preview(h.state.get('github.preview.tab')); await h.flush();
  preview.detailSection='reviews'; tree=preview.render(h.t,h.cx);
  assert.ok(find(tree, 'github-pr-header')); assert.ok(find(tree, 'github-detail-overview')); assert.ok(find(tree, 'github-location-0'));
  assert.equal(find(tree, 'github-location-1'), undefined);
  find(tree, 'github-copy-unresolved').handlers.click({}, h.cx);
  assert.match(h.clipboard[0], /a.js:4.*Unresolved/); assert.match(h.clipboard[0], /reviewer/); assert.match(h.clipboard[0], /https:\/\/github.com\/comment/);
  assert.doesNotMatch(h.clipboard[0], /b.js/);
  preview.folded['thread-2'] = false; assert.ok(find(preview.render(h.t,h.cx), 'github-location-1'));
  assert.ok(find(h.panel.render(h.t,h.cx),'github-row-1'));
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
  const h = harness(); h.panel.prs = [pr()];
  const before = h.requests.length, start = performance.now();
  for (let i = 0; i < 100; i++) h.panel.render(h.t, h.cx);
  assert.equal(h.requests.length, before); assert.ok(performance.now() - start < 1500);
});

test('branch changes reset selection and the current PR is selected beyond the first list page', async () => {
  const h = harness(), value = pr();
  h.setResponse(action => action === 'info' ? { repo: { name: 'example/repo' }, current: value } : action === 'prs' ? { items: [], more: true } : value);
  h.panel.enter(h.cx); await h.flush(); assert.equal(h.panel.prNumber, 1);
  assert.ok(find(h.panel.render(h.t,h.cx), 'github-row-1'));
  assert.equal(find(h.panel.render(h.t,h.cx), 'github-back'), undefined);
  assert.equal(h.commands.length,0);
  h.owner.branch = 'other'; h.panel.enter(h.cx); await h.flush();
  assert.equal(h.panel.loadedBranch, 'other');
});

test('workflow preview copies failure logs while the run remains in the sidebar', async () => {
  const h=harness(), run={id:42,display_title:'Tests',html_url:'https://github.com/example/repo/actions/runs/42',head_branch:'feature',head_sha:'a'.repeat(40),jobs:[{id:1,name:'Test',status:'completed',conclusion:'failure',steps:[{name:'Run tests',conclusion:'failure'}]}]};
  h.panel.mode='workflows';h.panel.runs=[run];
  h.setResponse(action=>action==='run'?run:{text:'AssertionError: example',head:'a'.repeat(40),truncated:true});
  const preview=h.preview({...h.owner,tab:'tab',sourcePane:'terminal',mode:'run',number:42});await h.flush();
  const tree=preview.render(h.t,h.cx);assert.ok(find(tree,'github-job-log-1'));
  find(tree,'github-failed-logs').handlers.click({},h.cx);await h.flush();
  assert.match(h.clipboard[0],/AssertionError/);assert.match(h.clipboard[0],/Truncated/);assert.match(h.clipboard[0],/runs\/42/);
  assert.ok(find(h.panel.render(h.t,h.cx),'github-row-42'));
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

test('selecting another item reuses only the GitHub preview in that tab', () => {
  const h=harness();
  h.panel.openPreview(pr(),'pr',h.cx);
  h.paneList.push({pane:'github',mod:'changes-graph',tab:'tab'},{pane:'diff',mod:'git-file-preview',tab:'tab'});
  h.c.focused=()=>({pane:'github',tab:'tab'});
  h.panel.openPreview({id:42,name:'Tests'},'run',h.cx);
  assert.equal(h.commands.at(-1).name,'pane.focus');assert.equal(h.commands.at(-1).args.pane,'github');
  assert.equal(h.state.get('github.preview.tab').mode,'run');assert.equal(h.state.get('github.preview.tab').sourcePane,'terminal');
  h.paneList.push({pane:'other-terminal',terminal:'other',tab:'other',cwd:'/repo'});
  h.c.focused=()=>({pane:'other-terminal',tab:'other'});
  h.panel.openPreview(pr(),'pr',h.cx);
  assert.equal(h.commands.at(-1).name,'pane.split');assert.equal(h.state.get('github.preview.other').sourcePane,'other-terminal');
  assert.equal(h.state.get('github.preview.tab').mode,'run');
});

test('preview refresh keeps its detail tab and rejects a late selection', async () => {
  const h=harness();h.setResponse(()=>pr());const preview=h.preview();await h.flush();
  preview.detailSection='reviews';preview.folded['thread-1']=true;preview.refresh(h.cx);await h.flush();
  assert.equal(preview.detailSection,'reviews');assert.equal(preview.folded['thread-1'],true);
  let complete;
  h.setResponse((_action,r)=>r.number===1?new Promise(resolve=>{complete=resolve;}):({...pr(),number:2,title:'Second PR'}));
  preview.refresh(h.cx);
  const loadingTree=preview.render(h.t,h.cx), text=node=>typeof node==='string'?node:(node?.nodes||[]).map(text).join(' ');
  assert.ok(find(loadingTree,'github-pr-header'));assert.doesNotMatch(text(loadingTree),/Loading details/);
  h.state.set('github.preview.tab',{...h.state.get('github.preview.tab'),number:2});
  preview.render(h.t,h.cx);complete(pr());await h.flush();
  assert.equal(preview.pr.number,2);assert.equal(preview.detailSection,'overview');
});

test('filter input is retained and selected PR remains visible after a list refresh', async () => {
  const h=harness(),value=pr(),input=h.panel.search;
  h.panel.info=h.options.info;h.panel.prs=[value,{...value,number:2,title:'Other change'}];
  h.panel.openPreview(value,'pr',h.cx);
  input.type('other',h.cx);let tree=h.panel.render(h.t,h.cx);
  assert.ok(find(tree,'github-row-2'));assert.equal(find(tree,'github-row-1'),undefined);assert.equal(h.panel.search,input);
  input.type('',h.cx);h.setResponse(()=>({items:[],more:true}));h.panel.refresh(h.cx);await h.flush();
  tree=h.panel.render(h.t,h.cx);assert.ok(find(tree,'github-row-1'));assert.equal(h.panel.prNumber,1);
});

test('GitHub review locations keep their own root and open a pinned read-only source', async () => {
  const h=harness();h.setResponse(action=>action==='pr'?pr():{local:true,head:'b'.repeat(40)});
  const preview=h.preview();await h.flush();
  preview.openThread(preview.pr.threads[0],h.cx);await h.flush();
  const selection=h.state.get('git-file-preview.tab');
  assert.equal(selection.root,'/repo');assert.equal(selection.hash,'b'.repeat(40));assert.equal(selection.kind,'file');assert.equal(selection.navigation.line,4);
  assert.equal(h.commands.at(-1).args.mod,'git-file-preview');
});

test('base picker lazily loads remote branches, filters and saves a keyboard selection', async () => {
  const h = harness(), view = h.composer(); await h.flush();
  assert.equal(view.base.value(), 'main');
  assert.equal(h.requests.some(r => r.action === 'branches'), false);
  h.setResponse(() => ({items: ['release/next', 'main', 'develop']}));
  find(view.render(h.t,h.cx),'pr-base-picker').handlers.open_change(true,h.cx); await h.flush();
  assert.deepEqual(Array.from(view.baseChoices()), ['main','develop','release/next']);
  const search = view.baseSearch;
  find(view.render(h.t,h.cx),'pr-base-menu').handlers.key_down({key:'down'},h.cx);
  view.baseSearch.submit(h.cx);
  assert.equal(view.base.value(), 'develop'); assert.equal(view.baseOpen, false);
  assert.equal(h.state.get(view.key).base, 'develop');
  view.openBases(true,h.cx);const height=find(view.render(h.t,h.cx),'pr-base-branches').attrs.h[0];view.baseSearch.type('release',h.cx);
  assert.equal(find(view.render(h.t,h.cx),'pr-base-branches').attrs.h[0],height);
  assert.equal(view.baseSearch, search);
  assert.ok(find(view.render(h.t,h.cx),'pr-base-option-release/next'));
  assert.equal(find(view.render(h.t,h.cx),'pr-base-option-main'), undefined);
  view.baseSearch.submit(h.cx);assert.equal(view.base.value(), 'release/next');
  assert.equal(h.requests.filter(r => r.action === 'branches').length, 1);
  let submitted;view.submit=async (action,data)=>{submitted={action,data};return {title:'Generated',body:'Body'};};
  view.generate(h.cx);await h.flush();assert.equal(submitted.data.base,'release/next');
});

test('base picker retries load failures without changing the draft and Escape keeps the composer', async () => {
  const h=harness(),view=h.composer();await h.flush();view.title.type('Keep this title',h.cx);
  h.setResponse(()=>{throw Error('Authentication required');});view.openBases(true,h.cx);await h.flush();
  assert.equal(view.basesError,'Authentication required');assert.equal(view.base.value(),'main');
  h.setResponse(()=>({items:['main','develop']}));find(view.render(h.t,h.cx),'pr-base-retry').handlers.click({},h.cx);await h.flush();
  assert.ok(find(view.render(h.t,h.cx),'pr-base-option-develop'));assert.equal(view.title.value(),'Keep this title');
  find(view.render(h.t,h.cx),'pr-base-menu').handlers.key_down({key:'escape'},h.cx);
  assert.equal(view.baseOpen,false);assert.equal(h.closed.length,0);
  view.chooseBase('not-a-repository-branch',h.cx);assert.equal(view.base.value(),'main');
});

test('base picker ignores stale repository responses and cannot select while generating', async () => {
  const h=harness(),view=h.composer();await h.flush();let complete;
  h.setResponse(()=>new Promise(resolve=>{complete=resolve;}));view.openBases(true,h.cx);
  h.state.set('github.active',{...h.owner,context:'another repository'});
  complete({items:['main','develop']});await h.flush();assert.equal(view.branches,null);
  view.branches=['main','develop'];view.chooseBase('develop',h.cx);assert.equal(view.base.value(),'main');
  h.state.set('github.active',{...h.owner});view.busy=true;
  view.chooseBase('develop',h.cx);assert.equal(view.base.value(),'main');
});

test('review diff fences get colors while prose, other languages and copied code remain intact', () => {
  const h=harness(),body='Please fix this.\n\n```diff\n--- original\n+++ suggested\n@@ -1 +1 @@\n-old()\n+new()\n```\n\nKeep this explanation.';
  const parts=h.c.reviewSegments(body);assert.equal(parts.length,3);assert.equal(parts[1].kind,'diff');
  assert.equal(parts[1].text,'--- original\n+++ suggested\n@@ -1 +1 @@\n-old()\n+new()\n');
  assert.equal(h.c.diffColor('-old()'),'ansi1');assert.equal(h.c.diffColor('+new()'),'ansi2');assert.equal(h.c.diffColor('@@ -1 +1 @@'),'ansi4');assert.equal(h.c.diffColor('--- old'),'muted');
  assert.equal(h.c.diffColor('+++counter'),'ansi2');
  const tree=h.c.reviewMarkdown('review',body,h.t),list=find(tree,'review-1-lines').attrs.virtual;
  const rows=list.render({start:0,end:5});assert.equal(rows[3].attrs.text_color[0],'ansi1');assert.equal(rows[4].attrs.text_color[0],'ansi2');
  find(tree,'review-1-copy').handlers.click({},h.cx);assert.equal(h.clipboard[0],parts[1].text);
  const python='```python\nprint("hello")\n```';assert.equal(h.c.reviewSegments(python)[0].text,python);
});

test('review fence parsing respects longer fences, CRLF, tilde fences and incomplete diffs', () => {
  const h=harness();
  const literal='````text\n```diff\n+literal\n```\n````';assert.equal(h.c.reviewSegments(literal)[0].text,literal);
  assert.equal(h.c.reviewSegments('~~~patch\r\n+new\r\n~~~')[0].text,'+new\r\n');
  assert.equal(h.c.reviewSegments('```diff\n-unfinished')[0].text,'-unfinished');
  const tree=h.c.reviewMarkdown('long','```diff\n'+Array.from({length:1000},(_,i)=>'+'+i).join('\n')+'\n```',h.t);
  const list=find(tree,'long-0-lines').attrs.virtual;assert.equal(list.count,1000);assert.equal(list.render({start:900,end:920}).length,20);
});
