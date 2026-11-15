const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function prototype() {
  class Element {
    constructor() { this.value = ''; this.innerHTML = ''; this.textContent = ''; this.listeners = {}; this.open = false; this.attrs = {}; this.classList = { add() {}, remove() {}, contains: () => false, toggle: () => true }; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    setAttribute(name, value) { this.attrs[name] = value; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {} select() {}
  }
  const elements = new Map(), events = {}, clipboard = [];
  const element = selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  const context = vm.createContext({ document: { querySelector: element, querySelectorAll: () => [], body: new Element(), documentElement: { style: { setProperty() {} } }, addEventListener(name, fn) { (events[name] ??= []).push(fn); } },
    history: { replaceState() {} }, location: { hash: '' }, navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } }, setTimeout() {}, clearTimeout() {} });
  const html = fs.readFileSync(__dirname + '/github-options.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { element, clipboard, run: source => vm.runInContext(source, context), async click(action, extra = {}) {
    const button = { dataset: { act: action, ...extra }, disabled: false };
    await events.click[0]({ target: { closest: () => button } });
  } };
}

test('three structural options render, with workflows discoverable and the queue initially scannable', () => {
  const h = prototype();
  assert.match(h.element('#stage').innerHTML, /Current branch/); assert.match(h.element('#stage').innerHTML, /data-value="workflows"/);
  h.run("selectOption('split')");
  assert.match(h.element('#stage').innerHTML, /class="preview"/); assert.match(h.element('#stage').innerHTML, /Filter pull requests/); assert.match(h.element('#stage').innerHTML, /Copy unresolved/);
  h.run("selectOption('queue')");
  assert.match(h.element('#stage').innerHTML, /3 unresolved review threads/); assert.match(h.element('#stage').innerHTML, /Waiting for Ana/);
  assert.doesNotMatch(h.element('#stage').innerHTML, /FAIL githubPanel/);
});

test('queue navigation stays in its option and returns from PR and workflow details', async () => {
  const h = prototype(); h.run("selectOption('queue')");
  await h.click('all-runs'); assert.equal(h.run('option'), 'queue'); assert.match(h.element('#stage').innerHTML, /Back to queue/);
  await h.click('queue-home'); assert.match(h.element('#stage').innerHTML, /Needs attention/);
  await h.click('other-pr', { id: '179' }); assert.equal(h.run('option'), 'queue'); assert.match(h.element('#stage').innerHTML, /PR #179/);
  await h.click('queue-home'); await h.click('all-reviews');
  assert.equal(h.run('option'), 'queue'); assert.match(h.element('#stage').innerHTML, /Marco/);
});

test('empty and connection failure states keep branch identity and provide recovery', async () => {
  const h = prototype();
  for (const option of ['branch', 'split', 'queue']) {
    h.run(`scenario='empty';selectOption('${option}')`);
    assert.match(h.element('#stage').innerHTML, /No PR/); assert.match(h.element('#stage').innerHTML, /feat\/new-improvement/);
    h.run("scenario='offline';render()"); assert.match(h.element('#stage').innerHTML, /Showing the last available data/);
    assert.match(h.element('#stage').innerHTML, /Reconnect to create a PR/);
  }
  await h.click('retry'); assert.equal(h.run('scenario'), 'attention');
});

test('review and failure extraction include actionable context', async () => {
  const h = prototype(); await h.click('copy-reviews');
  assert.match(h.clipboard[0], /Reviewer: Ana/); assert.match(h.clipboard[0], /githubPanel.js:84/); assert.match(h.clipboard[0], /PR: https:/);
  h.run("state().section='checks';render()"); await h.click('logs', { job: 'linux' });
  assert.equal(h.run('state().logJob'), 'linux'); assert.equal(h.run('state().logs'), true);
  await h.click('copy-failure'); assert.match(h.clipboard[1], /CI #624 · PR #184/); assert.match(h.clipboard[1], /Expected: 184/); assert.match(h.clipboard[1], /Tests \/ Linux/);
});

test('PR composer and instruction settings work without publishing or calling a provider', async () => {
  const h = prototype(); await h.click('new'); assert.equal(h.element('#composer').open, true);
  await h.click('instructions'); assert.equal(h.element('#instructions').open, true);
  h.element('#instructions-text').value = 'Use Conventional Commits.'; h.element('#template-path').value = '.github/template.md';
  await h.click('save-instructions'); assert.equal(h.run('savedInstructions.template'), '.github/template.md');
  assert.equal(h.element('#composer').open, true);
  await h.click('generate'); assert.match(h.element('#pr-title').value, /^feat\(github\):/);
  await h.click('create'); assert.equal(h.element('#composer').open, false); assert.match(h.element('#toast').textContent, /Nothing was published/);
});

test('rendered demo content escapes markup', () => {
  const h = prototype(); h.run("prs[0].title='<img src=x onerror=alert(1)>';render()");
  assert.doesNotMatch(h.element('#stage').innerHTML, /<img src=x/); assert.match(h.element('#stage').innerHTML, /&lt;img/);
});
