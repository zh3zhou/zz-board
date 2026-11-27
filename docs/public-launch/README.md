# 公测与公开源码准备包

当前准备版本为 **0.11.0 / alpha.1**。本目录包含公开文档模板、导出白名单、生成的公共 Agent 适配器、第三方许可材料和发布门槛；它不表示服务已经部署或 GitHub 已经发布。

计划公开仓库为 `zh3zhou/zz-board`，由当前文件生成干净的源码基线。李哲舟（Li Zhezhou）于 2026-11-28 确认项目权属、素材授权及 Source Available 1.0 许可。本次提供 Windows 桌面源码预览，并随源码开放 GitHub Issues。预览已验证源码构建和运行文件，原生首用及托盘等实测仍按正式首发记录完成。

## 先检查，再导出

在原工作区运行只读预检：

```powershell
node scripts/export-public-source.mjs
node scripts/package-public-release.mjs --audit-only
```

导出需要一个独立、空或尚不存在的绝对目标目录，以及放在原工作区和公开候选之外的私有审计文件。下面是合成路径示例，须换成自己的独立位置：

示例日期也须换成实际记录日期。导出与封包使用同一 `--date`；在已导出的候选中可省略该参数并沿用清单日期，显式冲突日期会被拒绝。

```powershell
node scripts/export-public-source.mjs --apply --output D:\review\zz-board-public --audit D:\review\private-audit\export.json --channel alpha.1 --date 2026-10-11
```

导出采用当前工作文件，模板替换原始 README、PROGRESS、CHANGELOG、AGENTS 与工程契约；不读取原私有项目记忆，也不加入 `.git`、真实数据、日志、数据库、绑定、缓存或生成桌面运行时。每个源文件和导出文件均记录哈希。默认允许生成带阻塞项的本地审阅候选；`--require-ready` 在任一发布门槛未通过时拒绝导出。失败保留已经创建的候选和审计，供检查，不覆盖已有目录。

## 从公开源码部署

在隔离导出的源码目录按 README 的「交给我的 Agent 部署」走一遍。运行 `pnpm setup:windows` 检查工具，`pnpm setup:windows -- -Status` 核对安装和数据位置，再执行部署指南的构建与启动步骤。验收须包含日常入口、原生窗口、中文输入和外部剪贴板、重开、升级与恢复。换一个全新的 Agent 对话测试项目文档能否带它找到当前看板并做出可预览的 Skin。

公开交付物是审核过的源码树。手动触发的 Windows CI 检查源码构建及运行文件，取消二进制附件上传。以前的独立 ZIP 和打包工具保留用于本地回归。二进制门槛单独记录在 `windowsBinaryDistributionApproved`；将来重启该渠道时，再确认具体二进制再分发权利、运行文件对应关系和配套源码。实际公开提交从 `--public-commit` 或 `ZZ_BOARD_SOURCE_COMMIT` 在验收时传入。

## 必须保留的阻塞项

`release-gates.json` 记录权利人确认及其余发布核验的状态。每项以对应证据为准。

- 依据本次实际分发文件复核第三方义务。
- 真实合成截图和第一次运行；Windows 中文输入、退出重开、更新与完整备份恢复验收。
- 首测渠道为 GitHub Issues。源码预览发布到选定的默认分支时启用 Issues，使用普通试用者身份分别打开问题和建议表单，确认隐私说明、必填项和提交入口。记录实际仓库、分支、时间及两条表单链接，再核对发布门槛。候选阶段可在本地复制或保存报告。
- 若选择归档的 CloudBase 渠道，再核验真实云端回执、重试、删除、清理与平台日志/备份；技术证据和复验条件见[云反馈技术归档](../../cloudbase/feedback/CLOUD_FEEDBACK_ARCHIVE.md)。
- 独立源码构建、选定的公开提交，以及实际源码树与导出清单的一致性。

2026-11-27 上午复查的 762 项依赖记录已补入 `abstract-logging@2.0.1` 作者公布的 MIT 原文与 `selectors@0.36.1` 的 MPL 原文。5 个 Rust MPL 组件的归档按 `Cargo.lock` 核对，并随源码提供。可选云函数增加 postgres 3.4.9 后，构建清单共 763 项。其 Unlicense 原文已按精确上游提交补入。历史缺口保留在进度记录。[当前审计](dependency-audit.json) · [来源与核验](third-party-source-evidence/README.md)

Sharp 的 C DLL 已与 Windows 官方构建逐字节比对，C++ DLL 已从精确版本源码重新编译；实际运行时副本能以兼容替换库读写同一张 PNG。当前源码树不携带该 DLL。二进制再分发的待办仍包括内嵌 LGPL 组件的完整对应源码与提供方式。Node `v24.18.0` 的许可原文与上游字节校验保存在 `licenses/`。依赖变化后重新核查。

可选私有收件实现只提交用户预览的文字、可选联系方式和可选诊断白名单，不上传画布、数据库、完整日志、截图或附件。云端主表计划保留 90 天并每日清理，物理清理可能延迟约 24 小时；平台日志和备份尚待实环境确认。实际云部署另行进行，不把本地 HTTP 服务暴露公网；CloudBase 提供的端点可以承担反馈 API，本轮不要求自有公开域名。

## 截图与 Agent 适配器

截图必须从真实运行的合成画布捕获，保存为 `assets/board-synthetic.png` 并检查没有个人历史、文件路径或账号信息；候选图经作者选定后再放入此路径。

`agent-adapters/` 由已安装的 agent-ready 0.5.0 在独立公共候选中生成，未复制原私有 `docs/agent/`。预检、生成与检查记录在 [provenance.json](agent-adapters/provenance.json)，公共 AGENTS 保持用户所有权且生成前后字节相同。导出器拒绝输入模板或生成内容哈希漂移。修改 `agent.project.public.yaml` 或 `AGENTS.public.md` 后需重新在独立候选调用本机 Skill resolver、检查生成结果，再更新本目录生成副本和 provenance；不要手工编辑生成适配器。Agent-ready 的 check 验证契约和命令计划，不替代 `pnpm check`，也不证明远程 CI 已经运行。

维护者最终应审阅许可、隐私及下载说明，并按选定反馈渠道和原生验收结果更新门槛。创建公共仓库、推送、部署和发布各自需要明确授权；这些操作不由本目录脚本或 CI 自动触发。
