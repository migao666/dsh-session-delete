# dsh-session-delete

Adds **删除会话** to the official session row's `...` menu. It works for both
normal rows and rows in the official archived view (`显示已归档` / `仅显示已归档`).

The action really removes the conversation from the machine's DSH store: the
persisted session log and its projection-cache row go to the **Windows Recycle
Bin**, and the conversation leaves the sidebar. There is deliberately **no
in-app restore row** — recovery is the system Recycle Bin.


仓库（私有）：[https://github.com/migao666/dsh-session-delete](https://github.com/migao666/dsh-session-delete)
## Why the obvious implementation is wrong

DSH has no session-delete seam. `session/list` — the only source of sidebar rows
— is the union of the durable scan and the **live session store** of the running
Host:

- `sessionController.list` → `SessionCorpus.listSessions`
  (`dsh-session-query`), which scans persistence and then overlays
  `ctx.sessions.list()` with no disk-existence check;
- a session opened in this Host process stays live until the process ends, and
  neither `ctx.sessions` nor `sessionPersistence` exposes remove/delete;
- a row leaves the live list only on `session/disposed`, which a plugin cannot
  trigger for someone else's session.

So the previous version of this plugin moved the files to the Recycle Bin and
stripped the id from the workspace registry — and the still-live row, now owned
by nobody, was rendered by the client's `groupByWorkspace` in the **未分组**
bucket. That is the "删除后侧栏多出一个未分组分组" bug, and it survived a page
reload because the Host kept serving the row.

## What it does instead

| Session state | Action |
|---|---|
| **live** (opened in this DSH run) | 1. `workspaceRegistry.archiveSession(id, { stopActivity: true })` — the official "hide this conversation" seam: stops the running turn through the stop providers and hides the row in every group under the default sidebar filter. 2. Wait for the persistence flush. 3. Move the log + projection cache to the Recycle Bin. **Workspace accounting is left alone** — an archived session keeps its slot, so the row never becomes a stray and no 未分组 group appears. The in-memory row itself is dropped when DSH restarts, and the plugin prunes the leftover archive marker at its next start. |
| **cold** (not loaded in this run) | Move the log + projection cache to the Recycle Bin. The row is gone from the next `session/list`; the client Session list is refreshed in place. The workspace accounting keeps the id (filtered by the header index, invisible to the client) so that a Recycle-Bin restore re-attaches the conversation to its workspace. |
| **live but archive refused** | The action aborts with `409 session-archive-failed` and touches no file: deleting the files without hiding the live row is exactly what produces the ghost. |

Nothing writes `~/.dsh/storages/workspace.json` or the workspace registry's
private table/state/header maps any more.

## Files

- `client.js` — registers one `sidebar.workspaces.session.menu.item` entry
  (`id: dsh-session-delete`, `order: 900`) and renders a `role="menuitem"`
  button labelled 删除会话. After a successful delete it refreshes the client
  Session list in place (`ctx.sessions.refresh()`); it only reloads the page
  when the deleted conversation is the one currently open (the stored
  `dsh.sessions.current` pointer and that conversation's local UI state are
  cleared first).
- `index.js` — Host half: `POST /dsh-session-delete/api/delete` with body
  `{"sessionId":"session-..."}`; plus a startup pass that drops archive/pin
  markers whose session no longer exists anywhere.
- `test-delete.mjs` — synthetic test against a temporary `DSH_HOME` and fake
  Host services (`node test-delete.mjs`).
- `evidence/` — screenshots of the normal and archived row menus.

## Behaviour notes

- A session that was opened in the current DSH run is **hidden immediately** but
  only leaves the Host's memory when DSH restarts; until then it is listed in
  the archived views (its log is already in the Recycle Bin, so it cannot be
  opened). After the restart it is gone, and the plugin removes the dangling
  archive marker.
- Deleting the conversation you are currently viewing stops it, clears the
  stored "open session" pointer, and reloads the page.
- Just like the official Archive action, deleting drops the session's pin.
- Windows only for the Recycle Bin move.

## Test evidence

`test-delete.mjs` (30 checks) verifies:

- live delete archives with `{ stopActivity: true }`, flushes persistence
  before moving files, and never touches workspace accounting;
- the registry double throws on any private member (`table`, `state`,
  `setState`, `headers`, …), so a regression to the old poking fails the test;
- a refused archive aborts with 409 and leaves the log and cache in place;
- a failed file move rolls the fresh archive back (the row stays reachable and
  the retry can proceed) and reports `delete-incomplete`;
- a cold delete moves the files and does not archive or flush;
- an unknown session returns 404 without touching the registry;
- `workspace.json` is never rewritten;
- the startup prune removes only markers whose session is neither live nor
  stored, and stays put on an empty or failing listing.

`test-client.mjs` (18 checks) drives the menu entry against a fake browser:
a delete of a non-open row refreshes the Session list in place, a delete of the
open conversation clears the stored pointers and reloads, a refusal alerts with
the Host message, and cancelling sends nothing.

## Install / rollback

Installed into the `desktop` profile via `plugin_manager install_bundle`.
Profile backup before the first installation:
`C:\Users\Administrator\dsh-backups\20261024-180451-session-delete-plugin`.
See [INSTALL.md](INSTALL.md) for the install and uninstall steps.

Rollback: remove the bundle with `plugin_manager remove_bundle` (or remove the
`dsh-session-delete` row/package from the profile), then restart DSH. Sessions
already deleted remain in the Windows Recycle Bin for manual restoration.

## Limitations

- Windows only for the Recycle Bin move.
- A live session's row is hidden by archiving, not disposed: DSH offers no seam
  to un-register a live session, so the row survives in Host memory until the
  next start (hidden, and unopenable).
- Search on this machine is backed by session logs rather than a separate
  SQLite index; removing the log removes it from search. If a future profile
  adds an index that caches session ids, that index must also be invalidated.
