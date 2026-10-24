/**
 * dsh-session-delete — host half.
 *
 * Provides one HTTP action used by the session row's "删除会话" menu item: move
 * the persisted session log and projection cache to the Windows Recycle Bin and
 * remove the conversation from the sidebar.
 *
 * Why this shape (see README "为什么不是简单摘成员"):
 *
 * `session/list` is a union of the durable scan and the Host's *live* session
 * store. A session that was opened in this Host process stays live until the
 * process ends, and no Host API can un-register a live session. Deleting only
 * the files (and stripping workspace accounting) therefore leaves a live row
 * with no owner, which the sidebar renders in the "未分组" bucket — the exact
 * bug this plugin used to produce.
 *
 * So the action uses the supported seams instead:
 *
 * - live session  → `workspaceRegistry.archiveSession(id, { stopActivity: true })`
 *   (archived rows are hidden by the default sidebar filter; the archive also
 *   stops the running turn through the official stop providers), then move the
 *   files. Accounting is left untouched: an archived session keeps its slot, so
 *   the row never becomes a stray. The live row itself disappears when the Host
 *   restarts, and the plugin prunes the dangling archive marker at startup.
 * - cold session  → move the files only. The row is gone from the next
 *   `session/list`; workspace accounting keeps the id (harmless, filtered by the
 *   header index and pruned by the registry on its next write) so that a
 *   Recycle-Bin restore still re-attaches the conversation to its workspace.
 *
 * There is deliberately no in-app restore row. Recovery is the system Recycle
 * Bin.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const ROUTE_PREFIX = '/dsh-session-delete/api';
const SESSION_ID = /^[A-Za-z0-9._-]+$/;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Both id spellings the Host may use on disk and in its registries. */
function variantsOf(sessionId) {
  const out = [sessionId];
  if (sessionId.startsWith('session-')) out.push(sessionId.slice('session-'.length));
  else out.push(`session-${sessionId}`);
  return [...new Set(out)];
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findSessionDirs(sessionId) {
  const root = join(dshHome(), 'sessions');
  if (!existsSync(root)) return [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const variant of variantsOf(sessionId)) {
    const direct = join(root, variant);
    if (await isDirectory(direct)) found.push(direct);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, variant);
      if (await isDirectory(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)];
}

function cacheCandidates(sessionId) {
  const root = join(dshHome(), 'storages', 'session_projcache', 'sessions');
  return variantsOf(sessionId).map((variant) => join(root, `${variant}.json`));
}

async function recyclePath(target, directory) {
  if (process.platform !== 'win32') {
    throw new Error('system recycle station is only available on Windows');
  }
  const escaped = target.replace(/'/g, "''");
  const method = directory ? 'DeleteDirectory' : 'DeleteFile';
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 30000,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recycleWithRetry(target, directory) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await recyclePath(target, directory);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(300);
    }
  }
  throw lastError;
}

/** Resolve one Host service without letting a missing peer abort the action. */
function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function liveSessionOf(ctx, sessionId) {
  const sessions = service(ctx, 'sessions');
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined;
  for (const id of variantsOf(sessionId)) {
    try {
      const session = sessions.get(id);
      if (session !== undefined) return session;
    } catch {
      /* a store lookup failure means "not live" for our purposes */
    }
  }
  return undefined;
}

/**
 * Hide a live row through the registry's supported archive seam and stop its
 * running work. Resolves to the id that was archived, or undefined when the row
 * is not live.
 *
 * Throws when the row is live but cannot be archived: continuing would leave a
 * ghost row behind, so the caller must abort instead of deleting the files.
 */
async function archiveLiveSession(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    throw new Error('无法隐藏仍在运行的会话：workspaceRegistry.archiveSession 不可用');
  }
  const alreadyArchived = Array.isArray(registry.archivedSessionIds)
    ? registry.archivedSessionIds.includes(sessionId)
    : false;
  if (!alreadyArchived) await registry.archiveSession(sessionId, { stopActivity: true });
  return { alreadyArchived };
}

/** Let queued writes drain before their files are moved out from under them. */
async function flushPersistence(ctx) {
  const persistence = service(ctx, 'sessionPersistence');
  if (persistence === undefined || typeof persistence.flush !== 'function') return;
  try {
    await persistence.flush();
  } catch {
    /* a failed flush must not hide the delete action */
  }
  await delay(300);
}

async function readJsonBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Delete one conversation.
 *
 * Order matters: a live row is archived first (which hides it through the
 * workspace stream and stops its work), the writers are drained, and only then
 * are the files moved. A cold row has no live counterpart, so moving the files
 * is enough and the row disappears from the next `session/list`.
 */
export async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { status: 400, body: { error: { code: 'invalid-session-id', message: '无效的会话 ID' } } };
  }

  const live = liveSessionOf(ctx, sessionId);
  const moved = [];
  const warnings = [];
  let archived = false;
  let archivedByUs = false;

  if (live !== undefined) {
    try {
      const result = await archiveLiveSession(ctx, sessionId);
      archived = true;
      archivedByUs = !result.alreadyArchived;
    } catch (error) {
      return {
        status: 409,
        body: {
          error: {
            code: 'session-archive-failed',
            message: `该会话仍在本次 DSH 运行中打开，无法先隐藏；已取消删除以免侧栏留下“未分组”幽灵行：${String(error)}`,
          },
        },
      };
    }
    await flushPersistence(ctx);
  }

  for (const sessionDir of await findSessionDirs(sessionId)) {
    try {
      await recycleWithRetry(sessionDir, true);
      moved.push(sessionDir);
    } catch (error) {
      warnings.push(`session log: ${String(error)}`);
    }
  }

  for (const cache of cacheCandidates(sessionId)) {
    if (!existsSync(cache)) continue;
    try {
      await recycleWithRetry(cache, false);
      moved.push(cache);
    } catch (error) {
      warnings.push(`projection cache: ${String(error)}`);
    }
  }

  if (!archived && moved.length === 0) {
    return {
      status: 404,
      body: { error: { code: 'session-not-found', message: '未找到该会话的日志或列表记录。' } },
    };
  }
  if (warnings.length > 0) {
    // Put a row we just hid back where it was: a half-done delete must not look
    // like a finished one, and the user needs the row to retry from.
    if (archivedByUs) {
      const registry = service(ctx, 'workspaceRegistry');
      try {
        await registry?.unarchiveSession?.(sessionId);
        archived = false;
      } catch {
        /* leave it archived; the log is still there and the restart cleans up */
      }
    }
    return {
      status: 500,
      body: {
        error: {
          code: 'delete-incomplete',
          message: `部分文件未能移入回收站：${warnings.join('；')}`,
        },
        sessionId,
        live: live !== undefined,
        archived,
        moved,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      sessionId,
      live: live !== undefined,
      archived,
      moved,
      note: live !== undefined
        ? '该会话已在本次运行中打开过：已停止并归档（侧栏默认隐藏），日志与投影缓存已移入系统回收站；DSH 重启后它会彻底从列表消失。'
        : '日志与投影缓存已移入系统回收站；该会话已从列表、归档视图和搜索中移除。',
    },
  };
}

/**
 * Drop archive/pin markers whose session no longer exists anywhere.
 *
 * A live row can only be hidden by archiving it, so the archive marker outlives
 * the files until the Host restarts; this startup pass removes that leftover
 * (and any marker left by an earlier delete). Ids that are live or still stored
 * are never touched.
 */
export async function pruneDanglingRegistrations(ctx) {
  const registry = service(ctx, 'workspaceRegistry');
  const persistence = service(ctx, 'sessionPersistence');
  if (registry === undefined || persistence === undefined) return;
  if (typeof persistence.list !== 'function') return;

  let stored;
  try {
    stored = await persistence.list();
  } catch {
    return;
  }
  const storedIds = new Set(
    (Array.isArray(stored) ? stored : [])
      .map((snapshot) => snapshot?.id ?? snapshot?.header?.id)
      .filter((id) => typeof id === 'string'),
  );
  // An empty listing says nothing about which markers are dangling; stay put.
  if (storedIds.size === 0) return;

  const isGone = (id) => !storedIds.has(id) && liveSessionOf(ctx, id) === undefined;

  const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : [];
  for (const id of archived) {
    if (!isGone(id)) continue;
    try {
      await registry.unarchiveSession(id);
    } catch {
      /* a leftover marker is harmless; never block startup on it */
    }
  }

  const pinned = Array.isArray(registry.pinnedSessionIds) ? [...registry.pinnedSessionIds] : [];
  for (const id of pinned) {
    if (!isGone(id)) continue;
    try {
      await registry.unpinSession(id);
    } catch {
      /* see above */
    }
  }
}

export const name = 'dsh-session-delete';

export function apply(ctx) {
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (ready) => {
    ready.effect(() => {
      pruneDanglingRegistrations(ready).catch(() => {
        /* startup cleanup is best-effort */
      });
      return () => {};
    }, 'dsh-session-delete: prune dangling markers');
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefixes',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const send = (status, value) => {
          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(value));
        };
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          if (req.method !== 'POST' || url.pathname !== `${ROUTE_PREFIX}/delete`) {
            send(404, { error: { code: 'not-found', message: 'not found' } });
            return;
          }
          const body = await readJsonBody(req);
          const result = await deleteSession(ctx, body?.sessionId);
          send(result.status, result.body);
        } catch (error) {
          send(500, { error: { code: 'delete-failed', message: String(error) } });
        }
      },
    }), 'dsh-session-delete: route');
  });
}

export default { name, apply };
