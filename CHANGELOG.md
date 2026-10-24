# 更新记录

## 0.2.1 — 2026-10-24

- 仓库公开，新增 GitHub Actions：`ci`（Windows 上跑 30+18 项合成测试）与
  `release`（打 tag 自动构建 zip 并发 Release）。

## 0.2.0 — 2026-10-24

修复「删除会话后侧栏出现『未分组』分组」的问题，并保留原有删除语义（日志与投影缓存进回收站）。

- **根因**：`session/list` 是「磁盘扫描 ∪ Host 进程内存活会话」的并集，活会话没有删除接口。
  旧实现先移文件、再摘 `workspace.sessionIds` 成员，于是行还在、归属没了，客户端把它渲染成
  「未分组」；`location.reload()` 无效，只有重启 DSH 才消失。
- **活会话**改走官方 `workspaceRegistry.archiveSession(id, { stopActivity: true })`：先停止并归档
  （默认过滤器下所有分组都不显示，且保留归属槽位，不再产生游离行），再 flush、移文件；
  归档失败则整体中止（409），不留下幽灵行；文件移动失败会回滚归档，行恢复可见以便重试。
- **冷会话**只移文件，行在下一次 `session/list` 消失。
- 不再直写 `workspace.json`、不再碰 registry 的 `table/state/headers` 私有面；启动时清理
  悬空的归档/置顶标记。
- 客户端改为 `ctx.sessions.refresh()` 就地刷新（仅在删除「当前正在看的会话」时清本地指针并刷新页面）。
- 新增 `test-delete.mjs`（30 项）与 `test-client.mjs`（18 项）两套合成测试。
