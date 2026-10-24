# 会话删除按钮 — 验收证据

日期：2026-10-24（Asia/Shanghai）

## 结论

`dsh-session-delete` 已安装到 desktop profile。会话行 `...` 菜单新增「删除会话」，
普通行和官方「显示已归档」的归档行都出现；点击后先把日志目录与投影缓存移入
Windows 回收站，再清 `workspaceRegistry` / `workspace.json`，最后刷新页面。

证据等级：**实测**（菜单、单测、回收站、接口 404/409）；搜索/未分组两项为
**按代码推导**（本机会话搜索由日志驱动，没有单独 SQLite 索引；删日志即不参与搜索）。

## 实测证据

1. 普通会话行菜单：`normal-row-menu.png` —— 「删除会话」位于「复制 Session ID」之后。
2. 归档会话行菜单：`archived-row-menu.png` —— 归档行同样有「删除会话」。
3. 合成删除单测：`synthetic-delete.log` —— 8 项文件路径检查 + 6 项 live
   workspaceRegistry 检查 + 5 项强制删除检查全部 PASS；临时会话的日志/缓存消失，
   其他会话保留，`sessionIds` / `archivedSessionIds` / `pinnedSessionIds` 都清理，
   header 缓存删除；fake live 会话触发 stop/flush、`forced: true`、日志移动。
4. Windows 回收站：`C:\$Recycle.Bin\S-1-5-21-...\$R4ARSRL`（目录）与
   `...\$RTOT19P.json`（投影缓存），名字为 `session-test-delete-0001`。
5. 接口：未知 id → HTTP 404；强制删除路径由合成 live 会话单测覆盖：
   `stopSessionActivity` 被调用、persistence 已 flush、返回 `forced: true`、日志已移动。
   没有对真实当前会话执行强制删除。
6. 真实会话未被删除。为了验证归档行，临时归档了「读取交接文档继续任务」，
   验证后已取消归档；`workspace.json` 的 `archivedSessionIds` 现在为 `[]`。

## 未做/边界

- 没有拿真实会话点「删除会话」；所有删除数据都是临时合成 DSH_HOME 或已移入回收站的
  临时目录。真实当前会话若被强制删除，会停止本会话并刷新页面。
- Windows 之外没有系统回收站；运行中会话会先 stopSessionActivity + flush 再移动。
- 若未来 profile 引入独立的会话搜索索引，需要在该索引里同步删除会话 id。

## 2026-10-24 19:xx 修复：删除后侧栏出现「未分组」分组

- **现象**：删除后侧栏多出一个「未分组」分组，被删会话就挂在下面；reload 无效，重启
  DSH 才消失。
- **根因（live host 实测 + 代码路径）**：`session/list` = 磁盘扫描 ∪ **Host 进程内活会话**
  （`dsh-session-query` 的 `listSessions` 无条件把 `ctx.sessions.list()` 覆盖进结果）。
  活会话没有删除接缝，插件只摘 `workspace.sessionIds` 成员 ⇒ 行还在、归属没了
  ⇒ 客户端 `groupByWorkspace` 的 `stray` 桶 = 「未分组」。
- **实测证据**：本机 `session-78666c25…`（「红果短剧视频流反编译重测」）日志与 projcache
  已无、`.dsh` 下无任何痕迹，但 live `session/list` 仍返回该行（`agentAvailable:true`），
  侧栏渲染出 `未分组 → 该会话`。
- **修复**：活会话改走官方 `workspaceRegistry.archiveSession(id,{stopActivity:true})`
  （归档行默认过滤隐藏，且保留 `sessionIds` 槽位，不再是 stray），再 flush + 移文件；
  冷会话只移文件；不再写 `workspace.json` / registry 私有表。启动时清理悬空
  archive/pin 标记。客户端改为 `ctx.sessions.refresh()` 就地刷新（仅删除当前打开会话时
  reload）。
- **验证**：`test-delete.mjs` 25 项全过（含"访问 registry 私有成员即测试失败"的守卫）；
  对 live host 调用同一 archive Remote 后 `archivedSessionIds` 收录该 id，
  按客户端规则重算侧栏 → 无「未分组」。
