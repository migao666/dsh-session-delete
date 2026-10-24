/**
 * Synthetic test for dsh-session-delete's client half.
 *
 * Loads the module-loader bundle with a fake `window`, React, `fetch` and
 * service context, then drives the menu entry's click handler:
 *
 * - a successful delete of a row that is NOT the open conversation refreshes
 *   the Session list in place (no reload),
 * - a successful delete of the open conversation clears the stored pointers and
 *   reloads,
 * - a failed delete alerts and changes nothing.
 *
 * Run: node test-client.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** Boot the bundle against a fresh fake browser and return its exports. */
function boot({ storedCurrent = null, response = { ok: true, status: 200, body: { ok: true } } } = {}) {
  const storage = new Map();
  if (storedCurrent !== null) storage.set('dsh.sessions.current', JSON.stringify({ sessionId: storedCurrent }));
  storage.set('dsh.conversation.old-id', 'draft');
  storage.set('dsh.sidebar-right.v1.old-id', 'panes');

  const calls = { fetch: [], reloads: 0, alerts: [], refreshed: 0 };
  let bundleExports = null;
  let slotEntry = null;

  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    location: { protocol: 'http:', port: '8080', reload: () => { calls.reloads += 1; } },
    confirm: () => true,
    alert: (message) => calls.alerts.push(message),
  };
  window.__ModuleLoader__ = {
    load: ({ factory }) => { bundleExports = factory((name) => {
      assert.equal(name, 'react');
      return { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    }); },
  };

  const document = {
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
    addEventListener() {},
    dispatchEvent() {},
  };

  const sessionsService = { refresh: async () => { calls.refreshed += 1; } };
  const ctx = {
    effect: (fn) => { fn(); },
    get: (name) => (name === 'sessions' ? sessionsService : undefined),
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => { slotEntry = { spec, component }; },
    },
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = window.localStorage;
  globalThis.KeyboardEvent = class {};
  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };

  // Evaluate the module-loader bundle in this fake browser.
  new Function(source).call(globalThis);
  bundleExports.apply(ctx);
  return { exports: bundleExports, module: slotEntry, calls, storage, window };
}

const entryProps = (model, overrides = {}) => ({
  sessionId: 'old-id',
  displayTitle: '待删会话',
  refreshSessions: () => {
    model.calls.refreshed += 1;
    return Promise.resolve();
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
console.log('1. delete a row that is not the open conversation: refresh in place');
{
  const model = boot({ storedCurrent: 'other-id', response: { ok: true, status: 200, body: { ok: true, sessionId: 'old-id' } } });
  const props = entryProps(model);
  const element = model.module.component(props);
  const label = [].concat(element?.props?.children ?? []).join('');
  check('menu entry renders a menuitem button', element?.props?.role === 'menuitem' && label === '删除会话');
  element.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('posted the delete request', model.calls.fetch.length === 1
    && model.calls.fetch[0].body.sessionId === 'old-id'
    && model.calls.fetch[0].url.includes('/dsh-session-delete/api/delete'));
  check('refreshed the session list', model.calls.refreshed === 1);
  check('did not reload the page', model.calls.reloads === 0);
  check('no alert', model.calls.alerts.length === 0);
}

// ---------------------------------------------------------------------------
console.log('2. delete the open conversation: clear pointers and reload');
{
  const model = boot({ storedCurrent: 'old-id', response: { ok: true, status: 200, body: { ok: true, sessionId: 'old-id' } } });
  const element = model.module.component(entryProps(model));
  element.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('reloaded the page', model.calls.reloads === 1);
  check('cleared the open-session pointer', !model.storage.has('dsh.sessions.current'));
  check('cleared the conversation UI state', !model.storage.has('dsh.conversation.old-id'));
  check('cleared the right-sidebar state', !model.storage.has('dsh.sidebar-right.v1.old-id'));
  check('did not refresh first', model.calls.refreshed === 0);
}

// ---------------------------------------------------------------------------
console.log('3. server refusal surfaces the Host message and keeps the row');
{
  const model = boot({
    storedCurrent: 'other-id',
    response: { ok: false, status: 409, body: { error: { code: 'session-archive-failed', message: '无法先隐藏' } } },
  });
  const element = model.module.component(entryProps(model));
  element.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('alerted with the Host message', model.calls.alerts.length === 1
    && model.calls.alerts[0].includes('无法先隐藏'));
  check('no reload', model.calls.reloads === 0);
  check('no list refresh', model.calls.refreshed === 0);
  check('open-session pointer kept', model.storage.get('dsh.sessions.current') === JSON.stringify({ sessionId: 'other-id' }));
}

// ---------------------------------------------------------------------------
console.log('4. cancel keeps everything untouched');
{
  const model = boot({ storedCurrent: 'other-id' });
  model.window.confirm = () => false;
  const element = model.module.component(entryProps(model));
  element.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('no request when the user cancels', model.calls.fetch.length === 0);
  check('no reload', model.calls.reloads === 0);
}

// ---------------------------------------------------------------------------
console.log('5. the bundle declares the slots dependency it uses');
{
  const model = boot({});
  check('exports apply + inject', typeof model.exports.apply === 'function'
    && Array.isArray(model.exports.inject)
    && model.exports.inject.includes('slots'));
  check('entry has a stable order and id', model.module.spec.id === 'dsh-session-delete'
    && typeof model.module.spec.order === 'number');
}

console.log(`\nall ${passed} checks passed`);
