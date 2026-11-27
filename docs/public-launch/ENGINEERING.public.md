# 工程维护导航

本文件给维护者定位入口。源码项目是唯一可维护、可复现构建的主场；Windows 交付物由源码构建，不能直接修改 EXE。当前候选 {{VERSION}} / {{CHANNEL}} 的实际验证在公共 PROGRESS 与 CHANGELOG 更新，不引用维护者私有任务栏、画布或原机器验收。

| 层 | 入口与职责 |
| --- | --- |
| 画布 | `src/web/App.tsx`，相邻交互 helper 保留选择、视口和世界坐标 |
| 富文本与媒体 | `src/web/NoteRichEditor.tsx`、`src/server/mediaStore.ts`，图文恢复与本机原图 |
| 本地服务 | `src/server/app.ts`、`database.ts`，loopback、事务、修订与语义撤销 |
| Codex 整理 | `src/server/codex/summaryRuntime.ts` 与 `summaryJobs.ts`，有界来源、串行作业、无工具安全门禁 |
| 桌面 | `src-tauri/`、`scripts/build-desktop-sidecar.mjs`、`desktop-runtime.ts`，托盘、单实例、owned sidecar和全量runtime清单 |
| 公测反馈 | 主动预览的桌面反馈与独立 `cloudbase/` 后端；不得上传本地画布或带出开发凭据 |
| 发布 | `scripts/export-public-source.mjs` 和 `package-public-release.mjs`，独立源码白名单、对应源码包、第三方材料和明确门禁 |

先运行改动附近的合成回归，再 `pnpm check` 与 `pnpm smoke:windows`。桌面改动追加构建和 inspection-only 的 `desktop:smoke`；原生 IME、触屏/笔与外部剪贴板仍需人工检查。

日常开发入口是 `pnpm desktop:dev`；形成桌面候选使用 `pnpm desktop:build`，随后 `pnpm desktop:smoke`。本机受控激活（仅适用于拥有该本机安装权限的维护者）使用 `pnpm setup:windows -- -Build -Deploy`，可追加 `-Start`；`-Status` 检查配置/程序/运行时/health 一致性，`-Rollback` 只恢复程序与配套资源，不能作为迁移后数据回退。构建或冒烟通过只证明相应检查，不替代首次启动、升级、恢复或公开发布验收。维护者应在每次可见改动后更新对应版本的 README/CHANGELOG/公共进度证据，再从同一源码项目继续。

桌面程序只连接 loopback 服务。数据目录由其本机 binding 或显式环境配置决定；公共文档不猜测或记录私人绝对路径。完整恢复需要同一次关闭后的数据库、`media/`、皮肤和 `dataDir/webview` profile；快照不代替完整数据备份。不要从公开构建脚本推导、上传或扫描使用者的本机数据。

生成runtime只清理确认过的派生目录，拒绝junction/符号链接；保留 `.gitkeep`、兄弟目标、旧版完整包和任何本地数据。manifest验证集合/大小/SHA256，是构建一致性校验，不是代码签名。

维护入口与结构化契约一致。不要为文件较大而整仓改框架，也不要因为有界扫描没见根文件就重建 README。`docs/agent/` 只能由安装的 agent-ready 工具针对公共契约生成；用户级安装及全局配置不是项目构建依赖。
