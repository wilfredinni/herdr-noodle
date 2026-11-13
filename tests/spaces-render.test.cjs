const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  const node = { nodes: [], attrs: {} };
  const proxy = new Proxy(node, { get(n, key) {
    if (key in n) return n[key];
    if (key === 'child') return value => (n.nodes.push(value), proxy);
    if (key === 'when') return (condition, fn) => (condition && fn(proxy), proxy);
    return (...args) => (n.attrs[key] = args, proxy);
  } });
  return proxy;
}
const find = (node, id) => node?.attrs?.id?.[0] === id ? node
  : node?.nodes?.map(child => find(child, id)).find(Boolean);

test('space rows count only their own open agents across states and update on render', () => {
  let list = ['working', 'blocked', 'done', 'idle'].map(status => ({ space: 'local', status }));
  list.push({ space: 'remote', status: 'working' });
  const context = vm.createContext({
    View: class {}, div: element, svg: path => Object.assign(element(), { path }),
    h_flex: element, v_flex: element, agents: () => list,
    shared: () => ({}), spaces: () => [],
  });
  const source = fs.readFileSync(__dirname + '/../mods/spaces-paths/main.js', 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ')
    .replace('export default class Spaces', 'globalThis.Spaces = class Spaces');
  vm.runInContext(source, context);
  const view = new context.Spaces();
  view.pressed = null;
  const countRow = id => find(view.row({ w: { id, name: id }, i: 0 }, {}), `space-agents-${id}`);
  const local = countRow('local');
  assert.equal(local.nodes[0].path, 'icons/agent.svg');
  assert.equal(local.nodes[1], '4');
  assert.equal(local.attrs.accessibility_label[0], '4 open agents');
  assert.equal(countRow('remote').nodes[1], '1');
  assert.equal(countRow('empty').nodes[1], '0');
  list = list.filter(agent => agent.space !== 'local');
  assert.equal(countRow('local').nodes[1], '0');
});
