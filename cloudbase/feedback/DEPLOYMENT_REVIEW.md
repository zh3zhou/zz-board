# 部署审阅、授权差异与验收

2026-11-27 当前方案。仅在已有私网端点的环境试用收件、清理两个普通数据库登录。依次应用基础迁移、处理状态迁移和 `20261127070000_zzb_feedback_scoped.sql`。三份迁移在本地 PostgreSQL 17.10 通过，TLS 与独立 SCRAM 登录验证了并发重试、撤回后拒绝重放、最小权限和隔离清理。三份 SQL 均已在目标环境取得官方迁移预览，第三份返回可执行。私有运行配置及绑定步骤见 [反馈后端](README.md)。

状态（2026-10-11）：以下是提案与本地材料，**云端未应用**。用户已决定保留现有超额使用设置、暂不部署公网反馈。只读预检发现环境超额使用已开启、私有清理权限无法证实、实际 PG 备份/平台日志保留期未知；后续部署须重新验收。

## 2026-10-11 历史提案（服务端 API Key 路径已撤回）

| 资源 | 拟新增或改变的内容 | 当前证据/授权门槛 |
| --- | --- | --- |
| PG 迁移 | 3 个 `public.zzb_feedback_*` 表、3 个索引、4 个 SQL 函数、RLS 与 scoped grants | 仅新增前缀；实际 PG 烟测通过；部署前重新查重并审阅 migration preview |
| HTTP 函数 | `zzb-feedback`，Nodejs24.11，20 秒超时，ZIP 自带依赖，初始收集关闭 | 核对现有套餐覆盖、用量与最高并发/预算边界；验证具体官方入口 |
| 清理函数 | `zzb-feedback-cleanup`，Event / `index.main`，Nodejs24.11，20 秒 | 明确禁止客户端调用并完成负向测试后才可激活 |
| 定时触发器 | `zzb-feedback-daily-cleanup`，每天一次 | 官方定时器时区语义仍需确认；数据库过期判定使用 DB clock，不依赖声称北京时间 |
| 服务端凭据 | 仅两函数环境中的 `ZZB_FEEDBACK_ENV_ID` 与 `ZZB_FEEDBACK_API_KEY` | API Key 权限为环境级；最新 Key 列表读取失败，不能认定不存在；安全建立/复用/撤销均需可核验路径 |
| 客户端凭据 | 客户端仅有公共 Publishable Key | 现有 Key 不可用，需授权创建/取得并完成官方入口 smoke；不创建匿名账号或登录界面 |
| 函数调用规则 | 只开放命名反馈入口，保持清理入口私有及原有资源权限 | 当前官方 MCP 文档明确 PG 环境拒绝旧 `ModifyResourcePermission`；旧规则合并不能作为该环境可用部署路径，需先证明 PG 兼容策略的读取及局部修改机制 |
| 超额使用设置 | **本轮不改**当前 `EnableOverrun=true` | 用户已选择保留当前设置、暂不部署公网反馈。未来开放前需重新确认费用边界；应用限流不封住所有调用成本 |
| CLS、日志与备份 | **本轮不启用、不更改** | 需核对实际保留期、正文采集与费用；未证实前不承诺彻底擦除或零新增费用 |

还不会创建 HTTP 网关 alias 路由、自有域名、网站、云托管、OPA 迁移、全环境 allow、登录方式、Hooks、后台自动化或付费升级。

## 函数权限的可审阅提案

官方[函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)描述了旧规则保留通配默认项并添加具体函数覆盖的形状；具体名字优先。下例仅用于说明曾考虑的命名规则，**不是本 PG 环境的可执行部署方案**：

```json
{
  "zzb-feedback": { "invoke": true },
  "zzb-feedback-cleanup": { "invoke": false }
}
```

这不是可直接上传的完整规则：完整文件必须有既有 `*`，以及所有原有规则，且要先确认当前环境确实使用旧函数规则。保存原像、重新核对原像 SHA-256，再构建差异；出现漂移时停止该项。不得凭空补一个 `*` 或用公开所有函数的模板覆盖现有配置。

旧 `ModifyResourcePermission` 的写入形状是 `EnvId / ResourceType=function / Permission=CUSTOM / SecurityRule=<完整JSON字符串>`；本轮没有调用。官方[权限管理](https://docs.cloudbase.net/api-reference/manager/node/permission)已标注资源权限接口废弃，并提示设置 Rego 会令旧鉴权直接失效。当前[官方 MCP 工具说明](https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/mcp-tools)进一步明确 PG 环境会直接拒绝该接口。撤回把旧规则合并作为本环境候选执行路径的提议；必须先取得当前 PG 兼容策略的完整原像、读取与局部写入证据。本轮不迁移 OPA，高层 fallback 或空 Rego 不构成原权限证明。

定时触发器不受客户端函数规则限制，命名 `invoke:false` 在旧规则生效时应允许内部清理而拒绝客户端；必须在真实环境做公开 Key 与匿名/已登录客户端的拒绝验收。SQL 的 service_role guard 不能替代这项验证。

## 应用顺序与技术门槛

1. 解决费用、当前函数权限与平台保留期证据，并重新读取环境身份、对象冲突和权限原像。保存本机审阅原像，勿把真实身份或凭据写入公开说明。
2. 重打 ZIP，校验 `manifest.json`、运行源码和模板 SHA-256；执行 `cloudbase-feedback-plan.mjs` 得到审阅步骤。任何源码/模板漂移都要求重新打包。
3. 通过官方版本化 PG migration 先预览，再应用已审阅迁移。只新增命名对象；不改旧表或 OPA。
4. 通过现有环境的上传 URL 上传 HTTP ZIP，并原样使用平台返回的 COS 三元组。`force=false`、`installDependency=false`；不使用上传源码目录后云端安装依赖的捷径。
5. Event runtime：现有 MCP 2.35.1 Event 白名单不包含 Nodejs24.11。官方[运行时文档](https://docs.cloudbase.net/cloud-function/runtime-support)与[CLI 配置](https://docs.cloudbase.net/cli-v1/functions/configs)列出该版本并标注 beta；可继续核实官方 CLI 单函数 `tcb fn deploy <name>` 或 SCF `CreateFunction` 路线。后者还须证明 CloudBase 环境归属与调用/定时语义，不能把普通 SCF 资源创建等同于 CloudBase 集成。两条路线尚无本账户运行证据；不隐式安装 CLI、不使用 `--all`、不回退运行时掩盖问题。
6. 安全注入服务器凭据，应用得到证明的局部函数调用规则，验证清理入口拒绝客户端。先让 HTTP 收集关闭；撤回仍可用。
7. 完成下表部署验收，再启用每日清理，最后启用收集和客户端公开 endpoint。记录真实端点/构建对应关系，避免将本地测试通过说成线上通过。

工具不会自动执行以上步骤。`deployment.template.json` 保存配置提案；`scripts/cloudbase-feedback-plan.mjs` 只检查 source/artifact hashes 并输出步骤，`--apply` 拒绝执行。

## 验收矩阵

| 验收项 | 当前本地证据 | 仍需云端证据 |
| --- | --- | --- |
| 严格诊断白名单、隐私 canary、不回显原始错误 | Vitest 已通过 | 查看平台日志采集与保留策略，合成 canary 不进入公开错误/日志 |
| 原始体 64 KiB 边界含 action | 精确 65536 接受、65537 拒绝 | 网关同样传达拒绝；不假设网关包装与状态语义 |
| receipt、同 ID 相同重试、变更冲突 | 后端及实际 PG smoke 已通过 | 公共 Publishable Key + webfn 的接受/重复/冲突响应 |
| 重复不占每日新报告预算 | 实际 PG counters 17 项 smoke 已覆盖 | 多实例同 ID/不同 ID 并发、日预算临界点 |
| 撤回证明、误证明、撤回后延迟重试 | token 字符串 SHA-256 / 墓碑 smoke 已通过 | 真实网关 token 路径、重复撤回及拒绝重放 |
| 暂停收集仍可撤回、清理 | Vitest 已通过 | 环境变量切换后确认有效实例行为 |
| NULL/anon/authenticated 不可 RPC 或读表 | 内存 PG role + grants + guard 已通过 | 用公开 Key 对真实 PG RPC/表做负向测试 |
| 清理客户端不可调用、计数不含正文 | 计数 schema 已通过；入口权限未证明 | 公共/匿名/已登录客户端均拒绝，可信定时/管理员调用可成功 |
| 90 × 24 小时过期、25 小时墓碑 | 实际 PG smoke 已通过 | timer 注册/时区、TTL 清理可观测证据；平台备份/日志另行披露 |
| 函数 ZIP、LF、UNIX0755、source hash | 独立 zipfile CRC 与入口校验已通过 | 平台部署 Ready、Nodejs24.11 可运行，COS 包与 hash 对应 |

单连接 PGlite 不模拟 CloudBase 鉴权或多实例调度，也不证明 advisory lock 的并发效果。云端并发测试只使用合成反馈，不读取真实画布或任务内容。

## 回滚

本轮没有云端改动，当前不需要云端回滚。本机产物在 `.tmp`，保留现有项目、插件和云端配置。

部署后需要回滚时：

1. 暂停新提交，保留撤回；不要把 `ZZB_FEEDBACK_ENABLED=false` 误当作撤回和 TTL 的停止开关。
2. 只停用命名清理 trigger/函数；先验证它当前是否仍在持有待删除报告的保留义务。已有反馈需明确处理，不静默丢弃。
3. 校验当前权限 postimage，原像恢复仅在未漂移时进行；新规则仅移除两项命名覆盖，保留无关修改。API Key 仅撤销本轮确实创建且未被其他资源使用的 Key。
4. 由原迁移身份审阅并执行 `rollback.sql`。所有业务表、策略、内部函数和本次新建的角色均按精确名称处理。存在外部依赖或仍有账号属于反馈组时事务会停止。此操作会删除反馈。
5. 复查其余环境资源和旧权限均保持原状；记录平台日志/备份仍可能保留历史数据的实际期限。

## 剩余需要用户决定或补证的动作

- 已确认：保留现有环境超额使用设置，暂不部署公网反馈。未来公网启用时重新确认费用安排；代码内 admission 限制发生在函数调用后，不能封住网关调用、函数实例启动和被拒绝请求的所有费用。
- 确认 PG 环境当前函数策略的实际机制、完整原像与局部修改路径；旧 `ModifyResourcePermission` 已由现行官方文档明确排除，不再要求用户尝试该接口或直接提交新的 OPA 策略。
- 提供当前环境 PostgreSQL 备份保留期、平台函数/网关日志保留期与正文采集状态的可核验证据。无需提供凭据或真实反馈数据。
- 选择 Event Nodejs24.11 的官方部署路径，以及在这些条件证明后应用命名资源的时点；公开 GitHub/许可由主任务统一处理。
