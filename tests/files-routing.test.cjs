const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(context, file, names) {
  const source = fs.readFileSync(path.join(__dirname, '../mods', file), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export default class /g, 'class ').replace(/export /g, '');
  vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${names} }); })()`, context);
}

function harness() {
  const state = new Map(), commands = [];
  const panes = [{ pane: 'terminal', tab: 'one', terminal: 't', cwd: '/workspace/repo' }, { pane: 'diff', tab: 'one', mod: 'git-file-preview' }];
  let focus = 'terminal';
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }) };
  const context = vm.createContext({ View: class {}, Map, Set, Date, JSON,
    spaces: () => [{ id: 's', active: true, folder: '/workspace', machine: null }],
    panes: () => panes, focused: () => ({ pane: focus, tab: 'one' }),
    shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    run: (name, args) => commands.push({ name, args }), InputState: { new: () => ({ on() {} }) },
  });
  load(context, 'files-browser/gitState.js', 'gitState, fileState');
  load(context, 'files-browser/main.js', 'Files, location, key');
  load(context, 'files-browser/tools.js', 'FileTools');
  load(context, 'changes-graph/main.js', 'Changes, sourceLocation');
  const files = new context.Files();
  Object.assign(files, { root: '/workspace/repo', on: null, git: context.gitState('/workspace/repo'), context: { key: context.key() } });
  return { files, context, state, commands, panes, cx, focus(pane) { focus = pane; } };
}

test('Files opens and reuses its editor without replacing or focusing the Changes diff', () => {
  const h = harness(), diff = { root: '/workspace/repo', file: { path: 'old.ts' }, hash: 'commit' };
  h.state.set('git-file-preview.one', diff);
  h.files.show('one.ts', h.cx);
  assert.equal(h.commands.at(-1).name, 'pane.split');
  assert.equal(h.commands.at(-1).args.mod, 'file-editor');
  assert.equal(h.commands.at(-1).args.props.selectionKey, 'file-editor.one');
  assert.equal(h.state.get('file-editor.one').file.path, 'one.ts');
  assert.equal(h.state.get('git-file-preview.one'), diff);
  h.panes.push({ pane: 'editor', tab: 'one', mod: 'file-editor' }); h.focus('editor');
  assert.equal(h.context.location().cwd, '/workspace/repo');
  assert.equal(h.context.sourceLocation().cwd, '/workspace/repo');
  h.files.show('two.py', h.cx, { line: 7 });
  assert.equal(h.commands.at(-1).name, 'pane.focus');
  assert.equal(h.commands.at(-1).args.pane, 'editor');
  assert.equal(h.state.get('file-editor.one').file.path, 'two.py');
  assert.equal(h.state.get('git-file-preview.one'), diff);
});

test('file search results use the same editor route', () => {
  const h = harness(), tools = new h.context.FileTools(h.files, h.cx);
  tools.select({ path: 'found.ts', line: 4, column: 2 }, h.cx);
  assert.equal(h.commands.at(-1).args.mod, 'file-editor');
  assert.equal(h.state.get('file-editor.one').file.path, 'found.ts');
});

test('View History selects Changes history without opening a file or touching either selection', () => {
  const h = harness(), tools = new h.context.FileTools(h.files, h.cx);
  tools.target = 'file.ts'; tools.history(h.cx);
  assert.equal(h.state.get('git-file-preview.one.history').path, 'file.ts');
  assert.equal(h.commands.length, 1); assert.equal(h.commands[0].name, 'layout.select');
  assert.equal(h.commands[0].args.child, 'changes');
  assert.equal(h.state.get('git-file-preview.one'), undefined); assert.equal(h.state.get('file-editor.one'), undefined);
});
