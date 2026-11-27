# 从源码部署 ZZ Board

这份源码文件夹也是以后维护看板的项目。在 Codex 或其他本地 Agent 中打开它。先确认这台机器有没有已有的安装和数据，再从源码构建。准备日常使用的桌面无需云账号。

## 从源码构建、安装到固定位置和启动

在准备长期保留的源码目录打开 PowerShell。需要 Windows x64、Node.js 24.18+、`package.json` 指定的 pnpm、Git 和 Rust/MSVC Build Tools。打开桌面窗口还需要 WebView2。Git 用于构建前的校验用例，可用 `git --version` 核对。首次构建需要下载尚未缓存的依赖。

```powershell
pnpm setup:windows                       # 检查编译工具版本
pnpm setup:windows -- -Status             # 先核对现有安装和数据位置
pnpm setup:windows -- -Build -Deploy -Start
```

`-Build` 顺序运行 frozen install、`pnpm check`、Windows smoke、桌面构建和资源校验，输出独立的 `src-tauri/target/setup-<UTC时间>/release/` 和该目录下的私有构建凭据 `zz-board-build.local.json`。`-Deploy` 把校验过的 EXE 及匹配资源装到稳定目录。`-Start` 明确打开桌面窗口，并分别核对进程、可见窗口和 HTTP 健康响应。如果从托盘「真正退出」之前升级被拦下，可复用同一次构建。

```powershell
pnpm setup:windows -- -Build
# 把上一条输出的 Executable 所在文件夹填入 $release
$release = Read-Host '此构建的 release 目录'
pnpm setup:windows -- -Deploy -FromBuild "$release"
pnpm setup:windows -- -Start
pnpm setup:windows -- -Status
```

默认复用已登记或已绑定的受支持便携目录，新安装默认位于 `%LOCALAPPDATA%\Programs\ZZ Board`。可在部署、查看状态、启动或回退命令末尾加 `-InstallDir "绝对目录"`。新用户可在稳定目录中右击 `zz-board.exe` 固定到任务栏，之后升级沿用相同入口。遇到旧 NSIS 安装时，先核对并保留原程序与数据备份，明确迁移位置后再部署。若绑定指向其他 EXE，先通过 `-Status` 对照旧入口和数据路径，保存旧程序与数据，再决定迁移；脚本会保留现有绑定并阻止直接从新位置接管。

交付给用户时给三项。第一项是已打开并核对的稳定 EXE 路径。第二项是本版本 README 的作者介绍；本地未发布的改动使用本地 README。官方远端确实包含当前提交时，可用该提交的 GitHub README 链接。第三项是以后回来做 Skin 和提问的源码项目文件夹。

### 下次 Codex 对话如何认出正在运行的版本

在源码目录运行 `pnpm setup:windows -- -Status`。状态会列出固定 EXE 路径和 SHA-256、版本、资源标识、实际配置的 `dataDir`、`webviewDir` 与 Codex 绑定。通过此流程交付的版本还会列出构建时的源码目录、构建输入摘要与可核对的 Git 状态。源码已编辑会显示 `changed`，移走则显示 `unavailable`。旧版和直接安装的 ZIP 可能只有程序与资源信息，源码显示 `unknown`。私有安装位置登记在 `%LOCALAPPDATA%\ZZ Board Portable\location.json`，构建来源与回退配对记录在安装目录 `.zz-board-install.sqlite`。

`processRunning` 表示当前会话有该路径的桌面进程。`visibleWindow` 表示该进程有可见原生窗口。`matchingHealth` 要求 4318 上的服务同时匹配该程序版本、数据目录标识、桌面 sidecar 类型和资源标识。三项同时成立才显示 `ready: true`。例如窗口收回托盘时可以继续有健康响应，较早包或独立 Web 服务也可能返回 HTTP 200。真正的中文输入、编辑和重开仍须实际操作验收。

如果换了 Windows 用户或 pnpm 缓存，pnpm 可能在运行脚本前要求重新安装依赖。只想找回已有看板时，可以直接在源码目录运行以下只读入口。它使用同一个状态检查，所需的 Node.js 版本见本页开头。

```powershell
node scripts/source-deployment.mjs status
```

## Agent 检查部署环境

Windows 上可以先直接运行只读预检。它会报告工具和版本、拟用入口、数据位置和端口，Node 尚未安装时也能执行。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -Preflight -Json
```

如使用私人试用包，先按包外层的 `START-HERE.md` 校验源码，再在预检命令末尾加 `-Trial`，检查拟用试用位置。条件齐备后执行 `pnpm setup:windows -- -Build -Trial -Deploy -Start`。试用默认安装在 `%LOCALAPPDATA%\Programs\ZZ Board Trial`，使用程序旁独立的 `.local-data/`。已有其他安装、绑定或 4318 端口冲突时，先核对预检结果并保留现有安装。

试用版记录部署、桌面、服务和界面的本机诊断事件。退出试用桌面后，可从同份源码运行 `pnpm trial:diagnostics -- preview`，查看日志文件状态、事件数和最近事件。确认分享范围后运行 `pnpm trial:diagnostics -- export "<绝对 ZIP 路径>"`，生成供你检查的本地 ZIP。若预检就卡住，可直接把缺项编号和你看到的现象告诉维护者。

## 连接 Codex 项目

普通画布打开后就能用。需要从 Codex 同步项目，或在 Codex 里读看板、写带来源的便签时，让 Agent 在已部署的源码目录运行以下命令。

```powershell
pnpm setup:windows -- -Status
pnpm setup:windows -- -BindCodex
```

保持这份桌面正在运行（可以收回托盘）。`-BindCodex` 核对运行中的程序、资源和数据目录标识，以及当前源码与构建回执，再把固定入口、实际数据目录和源码根写入本机 `%USERPROFILE%/.codex/zz-board.json`。已有相同绑定可重复执行。遇到不同绑定时，沿用现有看板或先核对配置，不要用 Skill 安装命令迁移绑定。绑定完成后可直接读取仓库内的 Skill。

1. 打开「项目 → 项目更新 → 来源授权」，分别选择本机读取和模型整理。要核对该机器的 Codex 登录和模型目录，可点「准备并检查 Codex」。
2. 空白看板从「项目更新 → 从 Codex 同步更多来源」复制全源同步指令。粘贴到 Codex Desktop 的对话里，可以在发送前明确本次只采集哪些项目。缺少绑定时，也可让 Codex 用仓库 Skill 导出 `zz-board-snapshot` JSON 代码块，再在「项目更新 → 导入快照」预览和确认。
3. 出现项目气泡后，从「概览」检查一个项目；点来源标题定位对话，从「便签」看关联手记。要让 Codex 保存当前决定，保持看板运行，并在对应项目对话中请它按仓库内 `skills/save-zz-board-note/SKILL.md` 先预览，确认后保存。

### 源码升级后的配套回退

升级已有固定位置的旧版时，`-Deploy` 要求桌面和 4318 服务已退出，将实际配置的数据目录完整复制到同磁盘相邻的 `.zz-board-before-update-…` 目录，并逐文件校验。快照包括 SQLite、媒体、WebView 本地草稿及空目录。安装记录将快照与旧 EXE 和资源绑定。备份及状态输出属于本机私人信息。

```powershell
pnpm setup:windows -- -Status     # recovery.backupDir 给出升级前的配对快照
pnpm setup:windows -- -Rollback
```

若新版已经写入数据，脚本会停止并打印两个路径。保持退出状态，将当前完整 `dataDir` 改名另存，然后把 `recovery.backupDir` 的完整副本复制回原 `dataDir`。若记录显示升级前还没有数据目录，只需另存当前目录。保留新数据与原始备份，再次运行 `-Rollback`。校验匹配才会原子恢复固定路径的上一版 EXE。核对 `-Status` 的实际版本与路径后，再用 `-Start` 打开。没有配对备份的旧 ZIP 或 NSIS 使用前述对应恢复方式。

## 首测反馈

首测在本机完成报告预览、复制或保存。源码正式发布时在官方仓库启用 Issues，并将两份 Issue Forms 放在默认分支。维护者和试用者的操作见 [反馈与贡献](../CONTRIBUTING.md)。有关备选私有收件方案、已验证内容、费用及重启条件，见 [云反馈技术归档](../cloudbase/feedback/CLOUD_FEEDBACK_ARCHIVE.md)。

## 可选 CloudBase 私有收件的历史部署材料

```powershell
pnpm cloudbase:package    # 独立函数 ZIP 与源码/包哈希
pnpm cloudbase:plan       # 只验证包并给审阅步骤，不写云端
pnpm cloudbase:smoke -- --help   # 临时函数测试参数说明，不写云端
pnpm cloudbase:smoke -- --env-id <环境ID>  # 本地计划，不写云端
```

实际合成部署测试显式执行：

```powershell
pnpm cloudbase:smoke -- --env-id <环境ID> --apply-smoke --entry <已安装的官方MCP的dist/cli.cjs绝对路径>
```

它仅尝试临时固定响应 HTTP 函数的创建、配置回读与清理，不接数据库、反馈正文或密钥，不修改环境授权规则和超额设置，不打开公网反馈入口。2026-10-11 实测管理调用被平台以 `FunctionType parameter is invalid` 拒绝；不能把配置创建成功当作实际 HTTP 运行或公网回执成功。官方 HTTP API 的 `webfn=true` 路径仍需公共 Key 和现行权限证据。测试会消耗环境既有资源额度；不能在 EnableOverrun 开启时保证绝不产生账单。若安全前置条件不满足，保持 no-op 并记录具体阶段。

实测 `manageFunctions` 在传入 `dryRun:true` 时仍返回创建成功，因此本工具的默认预演完全在本地进行，不调用写工具。不要用 MCP 的这个参数作为无变更保证。

正式反馈部署材料在 `cloudbase/feedback/`。当前 `cloudbase:plan` 不是可执行上线命令；权限、Key、安全日志、PG 备份与公网 `webfn=true` 回执仍须独立验收。只有这些证据、删除路径和保留说明都成立，才能构建带公共配置的桌面包。不要把临时函数通过当作整个反馈服务上线成功。

本地画布、SQLite 和 Codex 服务始终在本机 loopback；CloudBase 只承载独立反馈后端。不会为了测试增加网站、域名、登录方法、套餐、付费附加项、OPA 迁移或全环境放行。
