# dsh-session-delete 安装说明（Windows）

这是一个 DSH（DeepSeek Harness）桌面版插件：在会话行 `...` 菜单里增加
**删除会话**，普通会话行和官方「显示已归档」的归档行都有。

## 前置条件

- Windows 10/11（删除依赖 Windows 回收站）；
- 已安装 DSH 桌面版，能正常打开 `desktop` profile；
- 当前测试版本：DSH `0.2.1-rc.3`（相近版本一般可用）。

## 安装（推荐：让 DSH 的插件管理器安装）

1. 把整个 `dsh-session-delete` 文件夹解压到一个**长期保留**的位置，例如：
   `C:\Users\<你的用户名>\Documents\dsh-session-delete`
   不要放在临时目录或压缩包里直接运行。
2. 在 DSH 里新建/打开一个会话，对 Agent 说：

   ```text
   请用 plugin_manager install_bundle 安装这个本地插件：
   C:\Users\<你的用户名>\Documents\dsh-session-delete
   ```

   也可以使用你平时安装本地 bundle 的入口，选择这个文件夹。
3. 等待返回 `application: applied`，然后**重启 DSH**。
4. 打开任意会话，悬停会话行 → 点 `...`，应看到「删除会话」。

## 验证

- 普通会话行菜单：`置顶 / 重命名 / 分叉 / 归档 / 复制 Session ID / 删除会话`
- 归档会话行菜单：`重命名 / 分叉 / 取消归档 / 复制 Session ID / 删除会话`
- 点「删除会话」会先弹确认；确认后：
  - 运行中的会话会被**强制停止**；
  - 日志和投影缓存移入 Windows 回收站；
  - 该会话立即从侧栏隐藏，列表、搜索里都不再出现（不会再冒出「未分组」分组）；
  - 只有删的是当前正在看的会话时才会刷新页面，其余情况侧栏就地更新。
- 本次 DSH 运行中打开过的会话：侧栏立即隐藏，重启 DSH 后彻底消失（它的日志已在回收站）。

> 第一次测试请用一个**不重要的会话**，不要拿唯一副本试。

## 恢复

- 会话日志和投影缓存在 Windows 回收站，可手动还原；
- 插件**没有应用内恢复位**。

## 卸载

在 DSH 里对 Agent 说：

```text
请用 plugin_manager remove_bundle 卸载 dsh-session-delete
```

然后重启 DSH。已经删除的会话仍在 Windows 回收站，不受卸载影响。

## 注意

- 删除是强制操作：如果删的是当前正在看的会话，该会话会立即停止并刷新页面。
- 本次 DSH 运行中打开过的会话只能「归档式隐藏」——DSH 没有把活会话从内存里摘掉的接口；重启后它才会真正消失。
- 只支持 Windows；其他系统没有系统回收站路径。
- 若 DSH 升级后插件不可用，先查看插件状态和启动日志；不要直接改 profile 的
  `package.json`。

## 从 GitHub 拉取安装（另一台电脑）

仓库（私有）：https://github.com/migao666/dsh-session-delete

`powershell
git clone https://github.com/migao666/dsh-session-delete.git C:\Users\<用户名>\Documents\dsh-session-delete
`

如果这台电脑没有 git，也可以直接在 GitHub 网页上「Code → Download ZIP」解压。

然后在 DSH 会话里：

`	ext
请用 plugin_manager install_bundle 安装这个本地插件：
C:\Users\<用户名>\Documents\dsh-session-delete
`

等 pplication: applied 后重启 DSH。私有仓库需要先登录（gh auth login，或用带 repo 权限的 token）。
本机已配置自动同步：~/.dsh/plugins/dsh-session-delete 有改动时，计划任务每 5 分钟镜像并推送到该仓库。

