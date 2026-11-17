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
  const state = new Map([['selection', selection]]), jobs = [], calls = [], bindings = [], scrolls = [];
  const cx = { bind_keys(keys) { bindings.push(...keys); }, notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every() {} }, spawn(fn) { jobs.push(fn(cx)); } };
  const host = {
    exec: async (command, args, options) => { calls.push([command, args]); try { return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, stderr: e.stderr.toString() }; } },
    readTextFile: async file => fs.promises.readFile(file, 'utf8'),
  };
  const c = vm.createContext({ View: class {}, div: element, svg: source => { const icon = element(); icon.attrs.src = [source]; return icon; }, v_flex: element, h_flex: element,
    Button: { new: element }, Popover: { new: element }, Scrollbar: { vertical: element }, TextView: { markdown: element }, v_virtual_list: element,
    Input: { new: element }, InputState: { new: () => { let value = ''; return { on() {}, focus() {}, set_selected_range() {}, set_value(next) { value = next; }, value: () => value }; } },
    ScrollHandle: { new: () => ({ scroll_to_item(index) { scrolls.push(index); } }) }, VirtualListScrollHandle: { new: () => ({ scroll_to_item(index) { scrolls.push(index); } }) }, appHome: () => '/fixture-app',
    props: () => ({ selectionKey: 'selection' }), shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    theme: () => new Proxy({}, { get: (_, key) => key }), settings: () => ({}), focused: () => ({ tab: 'tab' }), panes: () => [], run() {},
    ...host, highlightRows: async () => {},
  });
  load(c, 'gutter.js', ['lineChanges']); load(c, 'content.js', ['isMarkdown', 'splitRows', 'diffRows', 'readFile', 'readDiff', 'readSource', 'readMarkdown', 'git']);
  load(c, 'review.js', ['Review']); load(c, 'search.js', ['PreviewSearch']);
  load(c, 'fileIcons.js', ['fileIcon']);
  load(c, 'main.js', ['FilePreview']);
  const view = new c.FilePreview(); view.watch = () => {}; view.init({}, cx);
  return { c, view, state, cx, host, calls, bindings, scrolls, async flush() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'a.md'), 'before\n'); fs.writeFileSync(path.join(root, 'b.txt'), 'second\n'); git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Baseline');
  return root;
}

test('preview header matches file-type icons for nested paths and unknown extensions', () => {
  const h = harness(null);
  for (const [file, icon, color] of [
    ['docs/README.md', 'mods/files-browser/icons/markdown.svg', 'ansi4'],
    ['web/package.json', 'icons/npm.svg', 'ansi1'],
    ['src/script.py', 'icons/python.svg', 'ansi3'],
    ['data.unknown', 'mods/files-browser/file.svg', 'muted'],
  ]) {
    const selection = { root: '/repo', file: { path: file }, on: null };
    h.state.set('selection', selection); h.view.selection = selection; h.view.root = selection.root;
    h.view.context = JSON.stringify(selection);
    const rendered = find(h.view.render(h.cx), 'preview-file-icon');
    assert.equal(rendered.attrs.src[0], icon);
    assert.equal(rendered.attrs.text_color[0], color);
  }
});

test('comparison branch filtering keeps its popup list height', () => {
  const h = harness(null), review = h.view.review, theme = h.c.theme();
  review.branches = [{ name: 'main', ref: 'refs/heads/main' }, { name: 'topic', ref: 'refs/heads/topic' }];
  const button = (id, label) => element(id).child(label);
  const height = find(review.branchPicker(theme, h.cx, button), 'review-branch-list').attrs.h[0];
  review.search.set_value('no-match');
  const tree = review.branchPicker(theme, h.cx, button);
  assert.equal(find(tree, 'review-branch-list').attrs.h[0], height);
  assert.match(texts(tree), /No matching branches/);
});

test('unified line numbers and split pairs preserve hunk positions and unequal replacements', () => {
  const h = harness(null), rows = h.c.diffRows(['@@ -8,3 +20,4 @@', ' keep', '-old1', '-old2', '+new1', '+new2', '+new3', '@@ -30 +40 @@', ' tail']);
  assert.deepEqual(Array.from(rows, r => [r.oldNumber ?? null, r.newNumber ?? null]), [[null,null],[8,20],[9,null],[10,null],[null,21],[null,22],[null,23],[null,null],[30,40]]);
  const pairs = h.c.splitRows(rows);
  assert.equal(pairs[2].before.text, 'old1'); assert.equal(pairs[2].after.text, 'new1');
  assert.equal(pairs[4].before, undefined); assert.equal(pairs[4].after.text, 'new3');
  assert.equal(pairs[5].before.kind, '@'); assert.equal(pairs[6].after.newNumber, 40);
});

test('Review uses shared segmented selectors and compares a branch picked with the keyboard', async t => {
  const h = harness({ root: fixture(t), on: null, file: { path: 'a.md', status: 'M' } }); await h.flush();
  const requests = [];
  h.c.exec = async (_command, args) => {
    const action = args[1], request = JSON.parse(args[2]); requests.push({ action, request });
    const result = action === 'review_branches' ? { branches: [{ name: 'main', ref: 'refs/heads/main' }, { name: 'origin/topic', ref: 'refs/remotes/origin/topic' }] }
      : action === 'review_compare' ? { base: 'a'.repeat(40), head: 'b'.repeat(40), files: [] } : { hunks: [], mode: 'unstaged' };
    return { code: 0, stdout: JSON.stringify(result) };
  };
  let tree = h.view.render(h.cx);
  assert.ok(find(tree, 'file-mode-review')); assert.equal(find(tree, 'open-review-tools'), undefined);
  find(tree, 'file-mode-review').handlers.click({}, h.cx); await h.flush();
  assert.equal(h.view.mode, 'review'); assert.equal(h.view.review.mode, 'hunks');
  tree = h.view.render(h.cx);
  for (const mode of ['hunks', 'compare', 'pr']) assert.ok(find(tree, `review-mode-${mode}`));
  assert.equal(find(tree, 'review-hunks'), undefined);
  find(tree, 'review-mode-compare').handlers.click({}, h.cx); await h.flush();
  tree = h.view.render(h.cx); assert.equal(find(tree, 'compare-ref').attrs.disabled[0], true);
  assert.ok(find(tree, 'review-branch-refs/remotes/origin/topic'));
  h.view.review.search.set_value('topic'); h.view.review.at = 0;
  tree = h.view.render(h.cx);
  const picker = find(tree, 'review-branch-picker');
  picker.nodes.at(-1).handlers.key_down({ key: 'enter' }, h.cx);
  tree = h.view.render(h.cx); find(tree, 'compare-ref').handlers.click({}, h.cx); await h.flush();
  assert.equal(requests.at(-1).request.ref, 'refs/remotes/origin/topic');
  assert.equal(h.view.review.busy, false);
});

test('file hunks reuse colored diff rows and keep staging tokens when syntax highlighting is unavailable', async t => {
  const h = harness({ root: fixture(t), on: null, hasHead: true, file: { path: 'a.md', status: 'M' } }); await h.flush();
  const highlighted = [];
  h.c.highlightRows = async (selection, rows) => { highlighted.push(selection.diffMode); rows.find(row => row.kind === '+').spans = [{ text: 'new', color: 5 }]; };
  h.c.exec = async () => ({ code: 0, stdout: JSON.stringify({ token: 'snapshot', mode: 'unstaged', hunks: ['@@ -1 +1 @@\n-old\n+new\n'] }) });
  h.view.selectMode('review', h.cx); await h.flush();
  assert.deepEqual(highlighted, ['unstaged']); assert.equal(h.view.review.hunks.token, 'snapshot');
  let tree = h.view.render(h.cx);
  assert.equal(find(tree, 'review-hunk-0-row-1').nodes[0].attrs.bg[0], 'ansi118'); assert.equal(find(tree, 'review-hunk-0-row-2').nodes[0].attrs.bg[0], 'ansi218');
  assert.equal(h.view.review.hunks.rows[0][2].spans[0].color, 5);
  h.view.result = { rows: h.view.review.hunks.rows.flat() };
  h.c.highlightRows = async () => { throw new Error('bat unavailable'); };
  h.view.review.load(h.cx); await h.flush(); tree = h.view.render(h.cx);
  assert.match(texts(tree), /bat unavailable/); assert.ok(find(tree, 'stage-hunk-0'));
  assert.equal(h.view.review.hunks.rows[0][2].spans[0].color, 5, 'reuse matching syntax colors from the diff');
});

test('Edit opens or focuses the separate editor and keeps the preview open', async t => {
  const root = fixture(t), hash = git(root, 'rev-parse', 'HEAD').trim();
  for (const existing of [false, true]) {
    const h = harness({ root, on: null, sourcePane: 'terminal', hash, diffMode: 'staged', file: { path: 'a.md', status: 'D' } });
    await h.flush();
    const commands = [];
    h.c.panes = () => [{ pane: 'preview', tab: 'tab', mod: 'git-file-preview' }, ...(existing ? [{ pane: 'editor', tab: 'tab', mod: 'file-editor' }] : [])];
    h.c.run = (name, args) => commands.push({ name, args });
    const button = find(h.view.render(h.cx), 'edit-working-file');
    assert.equal(button.attrs.bg[0], 'raised'); assert.ok(button.attrs.border_1);
    button.handlers.click({}, h.cx);
    const selection = h.state.get('file-editor.tab');
    assert.equal(selection.file.path, 'a.md'); assert.equal(selection.hash, null);
    assert.equal(selection.diffMode, undefined); assert.equal(selection.file.status, undefined);
    assert.equal(commands[0].name, existing ? 'pane.focus' : 'pane.split');
    assert.equal(commands[0].args[existing ? 'pane' : 'mod'], existing ? 'editor' : 'file-editor');
    assert.equal(commands.length, 1); assert.ok(commands.every(command => command.name !== 'pane.close'));
    assert.equal(h.state.get('selection').hash, hash);
    assert.equal(h.view.documents, undefined);
  }
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


function searchFixture(rows) {
 const h=harness(null),s={root:'/fixture',kind:'diff',file:{path:'file.md',status:'M'}};
 h.state.set('selection',s);Object.assign(h.view,{selection:s,root:s.root,context:JSON.stringify(s),rows,result:{rows},split:h.c.splitRows(rows),mode:'diff'});
 return h;
}
function backgrounds(node) {return [...(node?.attrs?.bg?[node.attrs.bg[0]]:[]),...(node?.nodes||[]).flatMap(backgrounds)];}
test('preview find highlights across syntax spans and navigates unified and split rows without changing content',()=>{
 const rows=[{kind:'-',oldNumber:1,number:1,text:'😀 match before',spans:[{text:'😀 ma',color:4},{text:'tch before',color:2}]},{kind:'+',newNumber:1,number:1,text:'match after'}];
 const h=searchFixture(rows),s=h.view.search;s.query.set_value('match');s.show(h.cx);
 assert.equal(s.matches.length,2);assert.equal(s.matches[0].start,3);assert.equal(h.scrolls.at(-1),0);
 const painted=h.view.code(rows[0],h.c.theme());assert.equal(texts(painted).replaceAll(' ',''),'😀matchbefore');
 assert.ok(backgrounds(painted).includes('#ff6b0066'));
 const colors=[];const walk=n=>{if(n?.attrs?.text_color)colors.push(n.attrs.text_color[0]);for(const c of n?.nodes||[])walk(c);};walk(painted);
 assert.ok(colors.includes('ansi4'));assert.ok(colors.includes('ansi2'));
 s.find(h.cx,1);assert.equal(s.at,1);assert.equal(h.scrolls.at(-1),1);assert.ok(backgrounds(h.view.code(rows[0],h.c.theme())).includes('#ffb80038'));
 s.find(h.cx,1);assert.equal(s.at,0);s.find(h.cx,-1);assert.equal(s.at,1);
 h.view.layout='split';s.find(h.cx);assert.equal(h.scrolls.at(-1),0);
 assert.equal(rows[0].text,'😀 match before');assert.equal(h.calls.length,0);
 s.close(h.cx);assert.equal(backgrounds(h.view.code(rows[0],h.c.theme())).length,0);
 assert.ok(h.bindings.some(b=>b.keystroke==='cmd-f'&&b.context==='NoodlePreview > Input'));
});
test('find refreshes for Source and Review, and reveals the containing hunk',()=>{
 const h=searchFixture([{kind:'+',text:'diff match'}]),s=h.view.search;s.query.set_value('match');s.show(h.cx);
 const old=s.matches;s.sync();assert.equal(s.matches,old,'rendering must reuse the search index');
 h.view.mode='source';h.view.source={rows:[{text:'source match',number:1}]};s.find(h.cx);assert.equal(s.matches[0].text,'source match');
 h.view.mode='review';h.view.review.mode='hunks';h.view.review.hunks={hunks:['one','two'],rows:[[{text:'no hit'}],[{text:'review match'}]]};
 s.find(h.cx);assert.equal(s.matches.length,1);assert.equal(h.scrolls.at(-1),4);assert.ok(backgrounds(h.view.review.render(h.c.theme(),h.cx)).includes('#ff6b0066'));
 h.view.review.hunks={hunks:[],rows:[]};s.find(h.cx);assert.equal(s.matches.length,0);
 h.view.mode='source';h.view.source={rows:[{text:'MATCH'}]};s.find(h.cx);assert.equal(s.matches.length,0,'literal search is case sensitive');
});
test('Review search includes comparison files, PR reviews, check names and failure logs',()=>{
 const h=searchFixture([]),r=h.view.review,s=h.view.search;h.view.mode='review';r.mode='compare';
 r.comparison={base:'a'.repeat(40),head:'b'.repeat(40),files:[{status:'M',path:'match.js'}]};s.query.set_value('match');s.show(h.cx);assert.equal(s.matches[0].block,2);
 r.mode='pr';r.pr={number:1,title:'match title',headRefName:'branch',baseRefName:'main',headRefOid:'a'.repeat(40),localHead:'a'.repeat(40),reviews:[{author:{login:'person'},state:'COMMENTED',body:'match body'}],statusCheckRollup:[{name:'match check',status:'FAILURE'}]};r.log={text:'match log',head:'a'.repeat(40)};
 s.find(h.cx);assert.equal(s.matches.length,5);assert.ok(backgrounds(r.render(h.c.theme(),h.cx)).includes('#ff6b0066'));
 s.find(h.cx,-1);assert.equal(h.scrolls.at(-1),7);
});
test('formatted Preview delegates find and clearing to the retained Markdown view',()=>{
 const h=searchFixture([]),s=h.view.search,calls=[];h.view.mode='markdown';h.view.markdownView={search:(...a)=>(calls.push(a),'2/3'),close_search:()=>calls.push('close')};
 s.query.set_value('match');s.show(h.cx);s.find(h.cx,1);s.find(h.cx,-1);assert.deepEqual(calls,[['match',0],['match',1],['match',-1]]);
 assert.match(texts(s.render(h.c.theme())),/2\/3/);h.view.markdownView.status=()=>"3/7";assert.match(texts(s.render(h.c.theme())),/3\/7/);s.close(h.cx);assert.equal(calls.at(-1),'close');
});


test('Review search reveals the actual row inside a hunk taller than the viewport',()=>{
 const h=searchFixture([]),s=h.view.search;h.view.mode='review';h.view.review.mode='hunks';
 const rows=Array.from({length:1000},(_,i)=>({kind:'+',number:i+1,newNumber:i+1,text:i===900?'target':'ordinary'}));
 h.view.review.hunks={hunks:['large hunk'],rows:[rows],mode:'unstaged'};s.query.set_value('target');s.show(h.cx);
 assert.equal(h.scrolls.at(-1),901);
 let content=find(h.view.review.render(h.c.theme(),h.cx),'review-content');assert.match(texts(content.nodes[901]),/target/);
 h.view.review.confirm=0;s.find(h.cx);assert.equal(h.scrolls.at(-1),902);
 content=find(h.view.review.render(h.c.theme(),h.cx),'review-content');assert.match(texts(content.nodes[902]),/target/);
});


test('Review action bars use the measured pane width at the current app zoom',()=>{
 const h=searchFixture([]),r=h.view.review;h.view.mode='review';r.mode='hunks';r.hunks={hunks:['one'],rows:[[{text:'long'.repeat(200)}]],mode:'unstaged'};
 h.c.settings=()=>({zoom:1.25});const tree=r.render(h.c.theme(),h.cx);tree.handlers.size_change({width:640},h.cx);
 const content=find(r.render(h.c.theme(),h.cx),'review-content');assert.equal(content.nodes[0].attrs.w[0],480);
 assert.ok(find(content,'stage-hunk-0'));assert.ok(find(content,'discard-hunk-0'));
});
test('an unchanged preview refresh does not move an active find result',async t=>{
 const root=fixture(t),h=harness({kind:'file',root,gitRoot:root,file:{path:'a.md'}});await h.flush();
 h.view.search.query.set_value('before');h.view.search.show(h.cx);const scrolls=h.scrolls.length;
 h.view.refresh(h.cx,true);await h.flush();assert.equal(h.scrolls.length,scrolls);
});
