const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  const node = { nodes: [], attrs: {} };
  const proxy = new Proxy(node, { get(n, key) {
    if (key in n) return n[key];
    if (key === 'child') return value => (n.nodes.push(value), proxy);
    if (key === 'children') return values => (n.nodes.push(...values), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...args) => (n.attrs[key] = args, proxy);
  } });
  return proxy;
}
const find = (node, id) => node?.attrs?.id?.[0] === id ? node
  : node?.nodes?.map(child => find(child, id)).find(Boolean);
const text = node => typeof node === 'string' ? node : (node?.nodes ?? []).map(text).join(' ');

function harness() {
  const state = { list: [], terminals: [], query: '', reads: 0, commands: [], order: [],
    colors: {}, spaces: ['local', 'remote', 'empty'].map((id, i) => ({ id, name: id, active: i === 0, tabs: [] })) };
  const context = vm.createContext({
    View: class {}, div: element, svg: path => Object.assign(element(), { path }), image: element,
    h_flex: element, v_flex: element, agents: () => { state.reads++; return state.list; },
    panes: () => state.panes ?? [], spaces: () => state.spaces, machines: () => [], terminals: () => state.terminals, focused: () => null,
    setAgentOrder: order => { state.order = Array.from(order); },
    shared: key => key === 'space.colors' ? state.colors : null,
    run: (command, args) => state.commands.push({ command, args }), theme: () => ({ dim: '#aaa', muted: '#aaa' }),
    props: () => state.footer ? { footer: true } : {}, updates: () => ({ app: { ready: state.updateReady } }),
    layout: () => ({}), Input: { new: element },
  });
  vm.runInContext(fs.readFileSync(__dirname + '/../mods/spaces-paths/agentTree.js', 'utf8').replace(/export function /g, 'function '), context);
  vm.runInContext(fs.readFileSync(__dirname + '/../mods/spaces-paths/main.js', 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ')
    .replace('export default class Spaces', 'globalThis.Spaces = class Spaces'), context);
  const view = new context.Spaces();
  Object.assign(view, { pressed: null, machines: [], reconnecting: {}, expanded: {}, filter: { value: () => state.query }, folded: new Set(), shown: new Set(state.spaces.map(s => s.id)) });
  view.ordered = () => state.spaces.map((w, i) => ({ w, i }));
  const render = () => view.render();
  const grouped = (compact = false) => element().children(view.grouped({ dim: '#aaa' }, compact));
  return { state, view, grouped, render, context };
}
const agent = (address, space, status = 'idle') => ({ address, pane: address, space, status, title: address + ' task', program: { name: 'Codex' } });

test('space counts include all four native states and update from one agents snapshot', () => {
  const h = harness();
  h.state.list = ['working', 'blocked', 'done', 'idle'].map((status, i) => agent('a'+i, 'local', status));
  h.state.list.push(agent('b', 'remote', 'working'));
  let rows = h.grouped();
  assert.equal(text(find(rows, 'space-agents-local')), '4');
  assert.equal(find(rows, 'space-agents-local').attrs.accessibility_label[0], '4 open agents');
  assert.equal(text(find(rows, 'space-agents-remote')), '1');
  assert.equal(text(find(rows, 'space-agents-empty')), '0');
  assert.equal(h.state.reads, 1);
  assert.ok(find(rows, 'agent-a0')); assert.equal(find(rows, 'agent-b'), undefined);
  h.state.list = h.state.list.filter(a => a.space !== 'local');
  rows = h.grouped(); assert.equal(text(find(rows, 'space-agents-local')), '0');
  assert.equal(h.state.reads, 2);
});

test('search opens matching agents in inactive spaces, preserves parents, and offers an empty state', () => {
  const h = harness(); h.state.list = [agent('parent', 'remote'), { ...agent('child', 'remote'), title: 'Fix parser' }];
  h.state.terminals = [{ address: 'child', parent: 'parent', state: 'live' }];
  h.state.query = 'parser'; let tree = h.render();
  assert.ok(find(tree, 'agent-parent')); assert.ok(find(tree, 'agent-child'));
  assert.equal(find(tree, 'space-local'), undefined);
  h.state.query = 'no match'; tree = h.render();
  assert.match(text(tree), /No matching spaces or agents/);
  h.state.query = ''; tree = h.render(); assert.ok(find(tree, 'space-local'));
});

test('space folding, keyboard focus, pins, and attention use the exact target', () => {
  const h = harness(); h.state.list = [agent('waiting', 'remote', 'blocked'), agent('local-agent', 'local')];
  let tree = h.render();
  const cx = { stop_propagation() {}, notify() {} };
  find(tree, 'workspace-attention').attrs.on_click[0]();
  assert.equal(h.state.commands.at(-1).command, 'agent.focus');
  assert.equal(h.state.commands.at(-1).args.terminal, 'waiting');
  find(tree, 'pin-local-agent').attrs.on_click[0]({}, cx);
  assert.equal(h.state.commands.at(-1).command, 'terminal.pin');
  assert.equal(h.state.commands.at(-1).args.pinned, true);
  find(tree, 'space-local').attrs.on_key_down[0]({ key: 'enter' }, cx);
  tree = h.render(); assert.equal(find(tree, 'agent-local-agent'), undefined);
  assert.deepEqual(h.state.order, ['local-agent', 'waiting']);
  h.state.spaces[0].active = false; h.state.spaces[1].active = true;
  tree = h.render();
  find(tree, 'agent-waiting').attrs.on_key_down[0]({ key: 'enter' }, cx);
  assert.equal(h.state.commands.at(-1).args.terminal, 'waiting');
});

test('sub-agents are not duplicated, raw children peek, pins sort within a space, and cycles stay bounded', () => {
  const h = harness();
  h.state.list = [agent('parent', 'local'), agent('kept', 'local'), { ...agent('pinned', 'local'), pinned: true }];
  h.state.terminals = [
    { address: 'kept', parent: 'parent', state: 'live' },
    { address: 'raw', parent: 'kept', state: 'live', name: 'Worker', status: 'error' },
    { address: 'exited', parent: 'parent', state: 'exited' },
  ];
  let tree = h.render();
  assert.deepEqual(h.state.order, ['pinned', 'parent', 'kept']);
  assert.equal(h.view.agentEntries.filter(a => a.address === 'kept').length, 1);
  assert.equal(h.view.agentEntries.find(a => a.address === 'raw').status, 'blocked');
  assert.equal(find(tree, 'agent-exited'), undefined);
  find(tree, 'agent-raw').attrs.on_click[0]();
  assert.equal(h.state.commands.at(-1).command, 'terminal.peek');
  h.state.terminals.push({ address: 'parent', parent: 'kept', state: 'live' });
  tree = h.render(); assert.ok(find(tree, 'agent-parent')); assert.ok(find(tree, 'agent-kept'));
  assert.equal(h.view.agentEntries.length, 4);
});

test('compact sidebar still exposes current-space agents and their status', () => {
  const h = harness(); h.state.list = [agent('a', 'local', 'working'), agent('b', 'remote', 'blocked')];
  const tree = h.grouped(true); assert.ok(find(tree, 'agent-a')); assert.equal(find(tree, 'agent-b'), undefined);
  assert.match(find(tree, 'agent-a').attrs.accessibility_label[0], /Working/);
});


test('task labels use live pane titles when tabs are named after their provider', () => {
  const h = harness();
  h.state.spaces[0].tabs = [{ id: 'tab', name: 'Codex', named: true }];
  h.state.list = [{ ...agent('a', 'local'), tab: 'tab', title: 'Codex' }];
  h.state.panes = [{ pane: 'a', title: '✦ Implement sidebar' }];
  const tree = h.render();
  assert.match(text(find(tree, 'agent-a')), /Implement sidebar/);
  h.state.spaces[0].tabs[0].name = 'Named task';
  assert.match(text(find(h.render(), 'agent-a')), /Named task/);
});


test('multiple spaces stay expanded across selection and chevrons toggle without navigation', () => {
  const h = harness(); h.state.list = [agent('a', 'local'), agent('b', 'remote')];
  const cx = { stop_propagation() {}, notify() {} };
  let tree = h.render();
  find(tree, 'toggle-space-remote').attrs.on_click[0]({}, cx);
  tree = h.render();
  assert.ok(find(tree, 'agent-a')); assert.ok(find(tree, 'agent-b'));
  assert.equal(h.state.commands.length, 0);
  h.state.spaces[0].active = false; h.state.spaces[1].active = true;
  tree = h.render();
  assert.ok(find(tree, 'agent-a')); assert.ok(find(tree, 'agent-b'));
  find(tree, 'toggle-space-local').attrs.on_key_down[0]({ key: 'enter' }, cx);
  tree = h.render();
  assert.equal(find(tree, 'agent-a'), undefined); assert.ok(find(tree, 'agent-b'));
  assert.equal(h.state.commands.length, 0);
});


test('space colors remain stable across selection and order, and honor saved colors with readable initials', () => {
  const h = harness();
  let tree = h.render();
  const initial = find(tree, 'space-avatar-local').attrs.bg[0];
  h.state.spaces.reverse(); h.state.spaces.forEach(s => { s.active = s.id === 'remote'; });
  assert.equal(find(h.render(), 'space-avatar-local').attrs.bg[0], initial);
  h.state.colors.local = '#ffffff';
  let avatar = find(h.render(), 'space-avatar-local');
  assert.equal(avatar.attrs.bg[0], '#ffffff'); assert.equal(avatar.attrs.text_color[0], '#000000');
  h.state.colors.local = '#000000';
  avatar = find(h.render(), 'space-avatar-local');
  assert.equal(avatar.attrs.text_color[0], '#ffffff');
  h.state.colors.local = 'ansi6';
  assert.equal(find(h.render(), 'space-avatar-local').attrs.bg[0], '#22a99a');
});


test('footer keeps both icon actions in one row, with tooltips, update indicator and keyboard activation', () => {
  const h = harness(); h.state.footer = true; h.state.updateReady = true;
  const footer = h.render();
  assert.ok(find(footer, 'workspace-footer')); assert.equal(find(footer, 'workspace-tree'), undefined);
  const settings = find(footer, 'settings'), machine = find(footer, 'machine');
  assert.equal(settings.attrs.tooltip[0], 'Settings'); assert.equal(machine.attrs.tooltip[0], 'Add machine');
  assert.equal(text(footer).trim(), '');
  assert.equal(machine.nodes[0].path, 'mods/spaces-paths/monitor-plus.svg');
  assert.equal(settings.nodes.length, 2);
  settings.attrs.on_click[0](); assert.equal(h.state.commands.at(-1).command, 'app.settings');
  machine.attrs.on_key_down[0]({ key: 'enter' }, { stop_propagation() {} });
  assert.equal(h.state.commands.at(-1).command, 'mod.open');
  assert.equal(h.state.commands.at(-1).args.name, 'machine-add');
  h.view.init({}, {}); // Footer copies must not start the tree's watchers or timers.
});
