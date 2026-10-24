/**
 * Synthetic test for dsh-session-delete's host action.
 *
 * Runs against a temporary DSH_HOME and fake Host services: it proves the
 * action hides a live session through the archive seam (never by poking the
 * workspace registry's private table/state/header maps, which is what produced
 * the "未分组" ghost row), leaves a live session's workspace accounting alone,
 * deletes a cold session's files, aborts instead of leaving a ghost when
 * archiving fails, and prunes dangling archive/pin markers at startup.
 *
 * Run: node test-delete.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-test-'));
process.env.DSH_HOME = join(root, 'home');

const { deleteSession, pruneDanglingRegistrations } = await import('./index.js');

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function seedSession(project, sessionId) {
  const dir = join(process.env.DSH_HOME, 'sessions', project, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.jsonl'), '{"type":"session/header"}\n', 'utf8');
  const cache = join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  await mkdir(join(cache, '..'), { recursive: true });
  await writeFile(cache, '{"title":"cached"}\n', 'utf8');
  return { dir, cache };
}

/** Registry double: only the public seams the action may use are reachable. */
function fakeRegistry(options = {}) {
  const calls = [];
  const archived = new Set(options.archived ?? []);
  const pinned = new Set(options.pinned ?? []);
  const allowed = new Set([
    'archivedSessionIds',
    'pinnedSessionIds',
    'archiveSession',
    'unarchiveSession',
    'unpinSession',
  ]);
  const target = {
    calls,
    archiveSession(sessionId, opts) {
      calls.push(['archiveSession', sessionId, opts]);
      if (options.archiveThrows) throw new Error('registry unavailable');
      archived.add(sessionId);
    },
    unarchiveSession(sessionId) {
      calls.push(['unarchiveSession', sessionId]);
      archived.delete(sessionId);
    },
    unpinSession(sessionId) {
      calls.push(['unpinSession', sessionId]);
      pinned.delete(sessionId);
    },
  };
  Object.defineProperty(target, 'archivedSessionIds', { get: () => [...archived] });
  Object.defineProperty(target, 'pinnedSessionIds', { get: () => [...pinned] });
  // Anything else (table/state/setState/headers/...) is a private poke: fail loudly.
  return new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol') return object[key];
      if (!allowed.has(key) && !(key in object)) {
        throw new Error(`private workspace registry member accessed: ${String(key)}`);
      }
      return object[key];
    },
  });
}

function fakeCtx({ live = false, registry, stored = [] } = {}) {
  const state = { flushed: 0 };
  const services = new Map([
    ['sessions', { get: (id) => (live ? { id } : undefined) }],
    ['workspaceRegistry', registry ?? fakeRegistry()],
    ['sessionPersistence', {
      flush: async () => { state.flushed += 1; },
      list: async () => stored.map((id) => ({ id, header: { id } })),
    }],
  ]);
  return { ctx: { get: (name) => services.get(name) }, state };
}

/** The action's warnings-free success shape. */
function expectOk(result) {
  assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

// ---------------------------------------------------------------------------
console.log('1. live session: archive first, files recycled, accounting untouched');
{
  const id = 'session-live-0001';
  const { dir, cache } = await seedSession('--proj-a--', id);
  const registry = fakeRegistry();
  const { ctx, state } = fakeCtx({ live: true, registry });

  const body = expectOk(await deleteSession(ctx, id));
  check('reports live + archived', body.live === true && body.archived === true);
  check('archive called with stopActivity', registry.calls.some(
    (call) => call[0] === 'archiveSession' && call[1] === id && call[2]?.stopActivity === true,
  ));
  check('persistence flushed before the files moved', state.flushed === 1);
  check('session log moved out of the store', !existsSync(dir));
  check('projection cache moved out of the store', !existsSync(cache));
  check('no membership/table/state pokes', !registry.calls.some(
    (call) => call[0] === 'unarchiveSession' || call[0] === 'unpinSession',
  ));
}

// ---------------------------------------------------------------------------
console.log('2. live session that cannot be archived: abort, keep the files');
{
  const id = 'session-live-0002';
  const { dir, cache } = await seedSession('--proj-a--', id);
  const registry = fakeRegistry({ archiveThrows: true });
  const { ctx } = fakeCtx({ live: true, registry });

  const result = await deleteSession(ctx, id);
  check('rejected with 409', result.status === 409);
  check('error code names the archive failure', result.body?.error?.code === 'session-archive-failed');
  check('log kept so no ghost row is left behind', existsSync(dir));
  check('cache kept', existsSync(cache));
}

// ---------------------------------------------------------------------------
console.log('3. cold session: files recycled, no archive, row leaves the list');
{
  const id = 'session-cold-0001';
  const { dir, cache } = await seedSession('--proj-b--', id);
  const registry = fakeRegistry();
  const { ctx, state } = fakeCtx({ live: false, registry });

  const body = expectOk(await deleteSession(ctx, id));
  check('reports cold', body.live === false && body.archived === false);
  check('log moved', !existsSync(dir));
  check('cache moved', !existsSync(cache));
  check('no archive call', !registry.calls.some((call) => call[0] === 'archiveSession'));
  check('no persistence flush for a cold row', state.flushed === 0);
}

// ---------------------------------------------------------------------------
console.log('4. unknown session: 404 without touching the registry');
{
  const registry = fakeRegistry();
  const { ctx } = fakeCtx({ live: false, registry });
  const result = await deleteSession(ctx, 'session-missing-0001');
  check('404 for a session with no live row and no files', result.status === 404);
  check('registry untouched', registry.calls.length === 0);
}

// ---------------------------------------------------------------------------
console.log('5. invalid id is rejected before any work');
{
  const { ctx } = fakeCtx({ live: false });
  const result = await deleteSession(ctx, '../../etc/passwd');
  check('400 for a non-id', result.status === 400);
}

// ---------------------------------------------------------------------------
console.log('6. startup prune drops only dangling archive/pin markers');
{
  const gone = 'session-gone-0001';
  const kept = 'session-kept-0001';
  const pinnedGone = 'session-gone-0002';
  const registry = fakeRegistry({ archived: [gone, kept], pinned: [pinnedGone, kept] });

  await pruneDanglingRegistrations({
    get: (name) => ({
      workspaceRegistry: registry,
      sessionPersistence: { list: async () => [{ id: kept, header: { id: kept } }] },
      sessions: { get: () => undefined },
    })[name],
  });

  check('dangling archive marker removed', registry.calls.some((c) => c[0] === 'unarchiveSession' && c[1] === gone));
  check('live/stored archive marker kept', !registry.calls.some((c) => c[0] === 'unarchiveSession' && c[1] === kept));
  check('dangling pin marker removed', registry.calls.some((c) => c[0] === 'unpinSession' && c[1] === pinnedGone));
  check('stored pin marker kept', !registry.calls.some((c) => c[0] === 'unpinSession' && c[1] === kept));
}

// ---------------------------------------------------------------------------
console.log('7. prune is a no-op when the listing is empty or unavailable');
{
  const registry = fakeRegistry({ archived: ['session-x'] });
  await pruneDanglingRegistrations({
    get: (name) => ({
      workspaceRegistry: registry,
      sessionPersistence: { list: async () => [] },
      sessions: { get: () => undefined },
    })[name],
  });
  check('empty listing never unarchives', registry.calls.length === 0);

  const throwing = fakeRegistry({ archived: ['session-y'] });
  await pruneDanglingRegistrations({
    get: (name) => ({
      workspaceRegistry: throwing,
      sessionPersistence: { list: async () => { throw new Error('storage down'); } },
      sessions: { get: () => undefined },
    })[name],
  });
  check('storage failure leaves markers alone', throwing.calls.length === 0);
}

// ---------------------------------------------------------------------------
console.log('8. the plugin never rewrites workspace.json');
{
  const before = await readFile(join(process.env.DSH_HOME, 'storages', 'workspace.json'), 'utf8')
    .catch(() => 'absent');
  const id = 'session-cold-0002';
  await seedSession('--proj-c--', id);
  const { ctx } = fakeCtx({ live: false });
  expectOk(await deleteSession(ctx, id));
  const after = await readFile(join(process.env.DSH_HOME, 'storages', 'workspace.json'), 'utf8')
    .catch(() => 'absent');
  check('workspace.json untouched (or never created)', before === after);
}

// ---------------------------------------------------------------------------
console.log('9. an incomplete move puts a freshly hidden live row back');
{
  const id = 'session-live-0003';
  const { dir, cache } = await seedSession('--proj-d--', id);
  const registry = fakeRegistry();
  const { ctx } = fakeCtx({ live: true, registry });

  // Force the Recycle-Bin mover to fail without touching the filesystem.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  let result;
  try {
    result = await deleteSession(ctx, id);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }

  check('reported an incomplete delete', result.status === 500
    && result.body?.error?.code === 'delete-incomplete');
  check('archived first as designed', registry.calls.some((c) => c[0] === 'archiveSession'));
  check('archive rolled back so the row stays reachable', registry.calls.some(
    (call) => call[0] === 'unarchiveSession' && call[1] === id,
  ));
  check('files kept for the retry', existsSync(dir) && existsSync(cache));
  check('response does not claim the session is archived', result.body?.archived === false);
}

await rm(root, { recursive: true, force: true });
console.log(`\nall ${passed} checks passed`);
