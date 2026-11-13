const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function prototype() {
  class Element {
    constructor() {
      this.value = ''; this.innerHTML = ''; this.listeners = {}; this.open = false;
      const classes = new Set();
      this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
        toggle: x => classes.has(x) ? classes.delete(x) : classes.add(x) };
    }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    setAttribute() {}
    matches() { return this.open; }
    showPopover() { this.open = true; }
    hidePopover() { this.open = false; }
    querySelector() { return null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30 }; }
  }
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const context = vm.createContext({ structuredClone, innerHeight: 900, innerWidth: 1440,
    document: { querySelector: element, body: new Element(), activeElement: null, addEventListener() {} },
    navigator: {}, setTimeout() {}, clearTimeout() {} });
  const html = fs.readFileSync(__dirname + '/git-workspace.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { element, run: source => vm.runInContext(source, context) };
}

test('repository switching preserves drafts and scopes staging, commits and stash actions', () => {
  const { element, run } = prototype();
  assert.equal(run('repos.length'), 4);
  element('#commitMessage').value = 'Keep this draft';
  element('#commitMessage').listeners.input[0]({ target: element('#commitMessage') });
  run("selectRepo('site'); selectRepo('noodle')");
  assert.equal(element('#commitMessage').value, 'Keep this draft');
  element('#commitButton').listeners.click[0]();
  assert.equal(run('repo().files.length'), 4);
  assert.equal(run('repo().history[0].title'), 'Keep this draft');
  assert.equal(run('repo().files.find(f => f.path.includes("git-file-preview")).unstaged'), true);
  run("selectRepo('mortis'); stageAll(true)");
  assert.equal(run('repo().files.find(f => f.status === "U").staged'), false);
  assert.equal(element('#commitButton').disabled, true);
  run("selectRepo('site'); changeView('history')");
  assert.match(element('#gitContent').innerHTML, /Update the collection runner/);
  run("changeView('graph')");
  assert.match(element('#gitContent').innerHTML, /graph-lanes/);
  run("actions['pop-stash'](); dialogAction()");
  assert.equal(run('repo().stashes.length'), 0);
  assert.equal(run('repo().files.length'), 1);
});

test('code highlighting escapes source and keeps keywords inside strings unchanged', () => {
  const { run } = prototype();
  assert.equal(run('syntax(\'const x = "class";\')'), '<span class="kw">const</span> x = <span class="str">&quot;class&quot;</span>;');
  assert.ok(!run("syntax('<img src=x>')").includes('<img'));
});
