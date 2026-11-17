const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let renderingRows = false;
function element(id) {
  const node = { id, nodes: [], attrs: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key === 'id' && target.id === undefined) return value => (target.id = value, proxy);
    if (key in target) return target[key];
    if (['child', 'trigger', 'content'].includes(key)) return value => (target.nodes.push(value), proxy);
    if (key === 'children') return values => (target.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...args) => { if (renderingRows && key.startsWith("on_")) throw Error("Handler registered during native layout"); target.attrs[key] = args; return proxy; };
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
    spawn(fn) { jobs.push(fn(cx)); }, timer: { every(ms, fn) { timers.push({ ms, fn }); }, after(ms, fn) { timers.push({ ms, fn, once: true }); } } };
  const input = () => ({ on() {}, set_value() {}, value: () => '', focus() {} });
  const context = vm.createContext({ console, Date, Map, Set, View: class {}, div: element, svg: () => element(), image: () => element(),
    h_flex: element, v_flex: element, Button: { new: element }, Checkbox: { new: element }, Popover: { new: element },
    InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: element, horizontal: element }, Tabs: { new: element }, Tab: { new: element },
    v_virtual_list: (id,count,sizes,key,render) => { const node=element(id); node.attrs.virtual={count,sizes,key,render}; return node; }, TextView: { markdown: element }, splitRows: () => [], PathBuilder: {}, settings: () => ({}),
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
  load(c, 'changes-graph/gitToolbar.js', ['GitToolbar', 'worktreeRows']);
  load(c, 'changes-graph/fileActions.js', ['FileActions']);
  load(c, 'changes-graph/commitGenerator.js', ['CommitGenerator']);
  load(c, 'changes-graph/repositories.js', ['Repositories']);
  load(c, 'changes-graph/stashPanel.js', ['StashPanel']);
  load(c, 'changes-graph/githubPanel.js', ['GithubPanel']);
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
  c.shared = key => key === 'noodle.documents' ? null : selection;
  c.readFile = async () => { reads++; return { rows: [{ text: 'hello' }] }; };
  c.isMarkdown = () => false;
  c.watchFolder = () => new Promise(resolve => watchers.push(resolve));
  load(c, 'git-file-preview/fileIcons.js', ['fileIcon']);
  load(c, 'git-file-preview/search.js', ['PreviewSearch']);
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
  load(c, 'git-file-preview/fileIcons.js', ['fileIcon']);
  load(c, 'git-file-preview/search.js', ['PreviewSearch']);
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
  load(c, 'git-file-preview/fileIcons.js', ['fileIcon']);
  load(c, 'git-file-preview/search.js', ['PreviewSearch']);
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

function changes(h) {
  const c=h.context;
  for (const [file,names] of [
    ['graph',['GRAPH_ARGS','HISTORY_ARGS','GRAPH_LIMIT','GRAPH_ROW_HEIGHT','graphRows','COMMIT_FORMAT','commitDetail','refLabels','shortAge']],
    ['gitToolbar',['GitToolbar','worktreeRows']],['fileActions',['FileActions']],['commitGenerator',['CommitGenerator']],
    ['repositories',['Repositories']],['stashPanel',['StashPanel']],['githubPanel',['GithubPanel']],['main',['Changes']],
  ]) load(c,`changes-graph/${file}.js`,names);
  const spawn=h.cx.spawn;h.cx.spawn=()=>{};
  const view=new c.Changes();view.init({},h.cx);h.cx.spawn=spawn;
  view.loading=false;view.watch=()=>{};view.repositories.refresh=()=>{};view.generator.machine=null;
  return view;
}
const find = (node,id) => node?.id===id?node:node?.nodes?.map(child=>find(child,id)).find(Boolean);
const countNodes = node => !node || typeof node!=='object'?0:1+(node.nodes||[]).reduce((sum,child)=>sum+countNodes(child),0);

test('a new repository starts reading before the previous repository finishes', async () => {
  const h=harness(),c=h.context,view=changes(h),pending=new Map(),calls=[];let folder='/old';
  c.spaces=()=>[{id:'s',active:true,folder,machine:null}];c.panes=()=>[{pane:'p',tab:'tab',terminal:'t',cwd:folder}];
  c.exec=async(_program,args,options)=>{calls.push(options.cwd);return new Promise(resolve=>pending.set(options.cwd,resolve));};
  view.refresh(h.cx);folder='/new';view.refresh(h.cx);
  assert.deepEqual(calls,['/old','/new']);
  pending.get('/old')({code:1,stdout:''});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(view.loading,true);assert.match(view.context,/new/);
  pending.get('/new')({code:1,stdout:''});await h.flush();assert.equal(view.loading,false);
});

test('Changes coalesces folder bursts and preserves an event received during a read', async () => {
  const h=harness(),c=h.context,view=changes(h);let finish,reads=0;
  c.exec=async()=>{reads++;return new Promise(resolve=>{finish=resolve;});};
  view.scheduleRefresh(h.cx);view.scheduleRefresh(h.cx);view.scheduleRefresh(h.cx);
  for(const timer of h.timers.filter(t=>t.once))timer.fn(h.cx);
  assert.equal(reads,1);view.refresh(h.cx);assert.equal(view.refreshAgain,true);
  finish({code:1,stdout:''});await h.flush();
  const retry=h.timers.at(-1);assert.equal(retry.once,true);retry.fn(h.cx);assert.equal(reads,2);
  finish({code:1,stdout:''});await h.flush();
});

test('Files refreshes only event-related expanded folders and skips listing for Git-only changes', async () => {
  const h=harness(),c=h.context;
  load(c,'files-browser/gitState.js',['gitState','fileState']);load(c,'files-browser/main.js',['Files','key']);
  const view=new c.Files();const spawn=h.cx.spawn;h.cx.spawn=()=>{};view.init({},h.cx);h.cx.spawn=spawn;
  view.loading=false;view.watch=()=>{};view.folders=new Set(['one','two']);const loaded=[];
  view.loadFolder=async path=>loaded.push(path);c.exec=async()=>({code:1,stdout:''});
  view.refresh(h.cx,['/repo/one/new.js']);await h.flush();assert.deepEqual(loaded,['one']);
  loaded.length=0;view.refresh(h.cx,['/repo/.git/index']);await h.flush();assert.deepEqual(loaded,[]);
  view.scheduleRefresh(h.cx,['/repo/one/a']);view.scheduleRefresh(h.cx,['/repo/two/b']);
  for(const timer of h.timers.filter(t=>t.once))timer.fn(h.cx);await h.flush();assert.deepEqual(loaded,['one','two']);
});

test('large lists bound rendering while retaining Changes controls on every page', () => {
  const h=harness(),c=h.context;h.cx.spawn=()=>{};
  load(c,'files-browser/gitState.js',['gitState','fileState']);load(c,'files-browser/fileIcons.js',['fileIcon']);load(c,'files-browser/main.js',['Files','key']);
  const files=new c.Files();files.init({},h.cx);files.loading=false;
  files.entries=new Map([['',Array.from({length:5000},(_,i)=>({name:`file-${i}.js`,dir:false}))]]);
  const tree=files.render(h.cx), list=find(tree,'files-tree-rows').attrs.virtual;
  assert.equal(list.count,5000);assert.ok(countNodes(tree)<100);
  renderingRows=true;const visible=list.render({start:4200,end:4220});renderingRows=false;assert.equal(visible.length,20);assert.match(visible[0].id,/file-4200/);
  const view=changes(h);Object.assign(view,{root:'/repo',on:null,context:JSON.stringify({cwd:'/repo',on:null}),loading:false});
  view.files=Array.from({length:1000},(_,i)=>({path:`file-${i}.js`,status:'M',unstaged:true,add:1,del:0}));
  const changed=view.render(h.cx);
  assert.ok(countNodes(changed)<800);assert.ok(find(changed,'changes-next'));
  view.changePage=19;const lastPage=view.render(h.cx);
  assert.ok(find(lastPage,'change-unstaged-file-999.js:tracked'));assert.equal(find(lastPage,'change-unstaged-file-0.js:tracked'),undefined);
  assert.ok(find(lastPage,'select-file-unstaged-file-999.js:tracked'));
  let staged;view.fileActions.stageFiles=paths=>{staged=paths;};find(lastPage,'stage-group-unstaged').attrs.on_click[0]({},h.cx);assert.equal(staged.length,1000);
  view.history=Array.from({length:500},(_,i)=>({fullHash:String(i)}));view.graphRow=row=>element(row.fullHash);
  const history=find(view.graphView(c.theme(),true),'git-history-rows').attrs.virtual;
  assert.equal(history.render({start:400,end:410})[0].id,'400');
});

test('History reuses unchanged committed data but reloads when HEAD or upstream status changes', async () => {
  const h=harness(),c=h.context,view=changes(h);let reads=0;
  Object.assign(view,{root:'/repo',on:null,context:JSON.stringify({cwd:'/repo',on:null}),hasHead:true,head:'a'.repeat(40)});
  c.exec=async(_program,args)=>{if(args.includes('log'))reads++;return {code:0,stdout:''};};
  await view.loadHistory(view.context);await view.loadHistory(view.context);assert.equal(reads,1);
  view.head='b'.repeat(40);await view.loadHistory(view.context);assert.equal(reads,2);
  view.sync={upstream:'origin/main',ahead:1};await view.loadHistory(view.context);assert.equal(reads,3);
  c.exec=async(_program,args)=>{if(args.includes('log'))reads++;return {code:0,stdout:args.includes('@{upstream}')?'c'.repeat(40):''};};
  await view.loadHistory(view.context);assert.equal(reads,4);
});

test('large-tree inline input keeps handlers outside native layout and does not open a file on click', () => {
  const h=harness(),c=h.context;h.cx.spawn=()=>{};
  load(c,'files-browser/gitState.js',['gitState','fileState']);load(c,'files-browser/fileIcons.js',['fileIcon']);load(c,'files-browser/main.js',['Files']);
  const view=new c.Files();view.init({},h.cx);view.loading=false;
  view.entries=new Map([['',Array.from({length:5000},(_,i)=>({name:`file-${i}.js`,dir:false}))]]);
  view.tools={mode:'inline',operationName:'new_file',inlineParent:'',error:'Invalid name',inlineRow:()=>element('inline-field').on_click(()=>{}),context:el=>el,contextArea:el=>el};
  const tree=view.render(h.cx),list=find(tree,'files-tree-rows'),native=list.attrs.virtual;
  renderingRows=true;const visible=native.render({start:0,end:20});renderingRows=false;
  assert.equal(visible[0].id,'inline-field');assert.equal(native.sizes[0],64);assert.equal(visible.length,20);
  let opened=false;view.show=()=>{opened=true;};list.attrs.on_item_click[0](native.key(0),h.cx);assert.equal(opened,false);
});
