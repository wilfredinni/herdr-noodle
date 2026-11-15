const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function prototype() {
  class Element {
    constructor() {
      this.innerHTML = ''; this.textContent = ''; this.value = ''; this.attrs = {};
      this.style = {}; this.listeners = {}; this.classes = new Set();
      this.classList = { toggle: name => this.classes.has(name) ? (this.classes.delete(name), false) : (this.classes.add(name), true) };
    }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    focus() {} setSelectionRange() {}
  }
  const elements = new Map(), events = {};
  const element = selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], body: new Element(), addEventListener: (name, fn) => { events[name] = fn; } },
    setTimeout() {}, clearTimeout() {},
  });
  const html = fs.readFileSync(__dirname + '/sidebar-options.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { element, run: source => vm.runInContext(source, context),
    click: dataset => events.click({ target: { closest: () => ({ dataset }) } }),
    input(value) { events.input({ target: { id: 'filter', value, selectionStart: value.length } }); },
    key(key) { events.keydown({ key }); },
  };
}

test('three concepts keep the same space and terminal context with different navigation structures', () => {
  const h = prototype();
  assert.match(h.element('#app').innerHTML, /class="nested"/);
  h.click({ concept: 'rail' });
  assert.match(h.element('#app').innerHTML, /class="space-rail"/);
  assert.match(h.element('#app').innerHTML, /All spaces/);
  h.click({ concept: 'focus' });
  assert.match(h.element('#app').innerHTML, /class="focus-picker"/);
  assert.match(h.element('#app').innerHTML, /Refine the sidebar/);
  assert.equal(h.run('selectedSpace'), 'herdr');
});

test('space switching, attention navigation, and all-space agent scope keep selection coherent', () => {
  const h = prototype();
  h.click({ space: 'site' });
  assert.equal(h.run('selectedAgent'), '');
  assert.match(h.element('#app').innerHTML, /Your workspace is ready/);
  h.click({ agent: 'hooks' });
  assert.equal(h.run('selectedSpace'), 'noodle');
  assert.match(h.element('#app').innerHTML, /Waiting for your input/);
  h.click({ concept: 'rail' }); h.click({ scope: 'all' });
  for (const title of ['Refine the sidebar', 'Review file previews', 'Collection hooks', 'Review status fix']) {
    assert.ok(h.element('#app').innerHTML.includes(title));
  }
});

test('filter has an empty state, Escape clears it, theme and preview width respond', () => {
  const h = prototype();
  h.input('Collection hooks'); assert.match(h.element('#app').innerHTML, /class="agent-name">Collection hooks/);
  h.input('no-such-space'); assert.match(h.element('#app').innerHTML, /No matching spaces/);
  h.key('Escape'); assert.equal(h.run('query'), '');
  h.click({ concept: 'focus' }); h.input('no-such-agent');
  assert.match(h.element('#app').innerHTML, /No matching agents/);
  h.element('#theme').listeners.click(); assert.equal(h.element('#theme').attrs['aria-pressed'], true);
  h.element('#width').listeners.change({ target: { value: '1024px' } });
  assert.equal(h.element('#app').style.width, '1024px');
});

test('demo mutations stay local and filter input is escaped', () => {
  const h = prototype();
  h.click({ demo: 'Commit staged file' });
  assert.match(h.element('#toast').textContent, /preview only, no Herdr action was run/);
  h.input('\"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(h.element('#app').innerHTML, /<img src=x/);
  assert.match(h.element('#app').innerHTML, /&lt;img/);
});
