# ZZ Board 反馈后端

官方首测选用本机报告和 GitHub Issues。本目录保留可选的云收件实现、部署说明及[技术归档](CLOUD_FEEDBACK_ARCHIVE.md)。

2026-11-27 更新。部署模板按顺序列出基础表、处理状态及专用数据库角色三份迁移。第三份迁移保留已有报告、回执和撤回凭证，将服务操作移入私有 schema。旧版环境级 API Key 已从两个入口移除。

状态（2026-10-11）：本地代码、迁移、测试和函数 ZIP 已备妥；**未部署，未创建云端数据、密钥、函数或触发器，未修改环境权限或计费设置**。线上提交、撤回和私有清理尚未验收。当前环境开启了超额使用，清理函数的客户端拒绝规则及平台保留期也未证实，部署保持待审。

本目录是独立反馈服务，不会把 ZZ Board 的本地 SQLite、画布、任务记录或总结运行时接到云端。共享传输契约由 `src/shared/feedback.ts` 定义。

## 本地验证与打包

在仓库根目录运行：

```powershell
pnpm exec vitest run tests/cloudbaseFeedback.test.ts
node scripts/cloudbase-feedback-sql-smoke.mjs --pglite-entry .tmp/cloudbase-feedback-tools/node_modules/@electric-sql/pglite/dist/index.js
node scripts/cloudbase-feedback-package.mjs
node scripts/cloudbase-feedback-plan.mjs
```

数据库烟测只使用内存中的 PGlite PostgreSQL，不能指定外部连接或真实数据目录。当前验证使用隔离工具目录中的 `@electric-sql/pglite@0.5.8`，未加入产品依赖。新开发机需要先准备这一依赖；本轮已完成准备。

HTTP 测试由 Vitest 在 `127.0.0.1` 随机端口启动合成服务，验证真实请求处理。不要把 `http.ts` 作为桌面服务启动：它是云函数入口，监听云端要求的 `0.0.0.0:9000`。ZZ Board 主服务继续使用 loopback。

打包输出位于忽略目录 `.tmp/cloudbase-feedback-package/`：HTTP 包为 `zzb-feedback.zip`，事件包为 `zzb-feedback-cleanup.zip`。`manifest.json` 包含 ZIP 和运行源码 SHA-256；审阅脚本发现源码或产物漂移时拒绝继续。`--apply` 明确拒绝执行，脚本只生成可审阅步骤。

本地验证覆盖 HTTP 收件、合成维护者看板，以及 PostgreSQL 17.10 的两个独立 TCP 登录。真实云端收件和调用规则仍待验收。

## 接口与数据边界

拟使用已有 CloudBase 官方数据面入口：

```text
POST https://<environment-id>.api.tcloudbasegateway.com/v1/functions/zzb-feedback?webfn=true
Authorization: Bearer <public-publishable-key>
Content-Type: application/json
```

不要求新建独立网站或用户自有域名。CloudBase HTTP 网关的开发别名域名仅供开发测试，不能当作生产公开域名承诺。上述 `webfn + Publishable Key` 的组合仍需部署后的合成验收。[调用云函数](https://docs.cloudbase.net/http-api/functions/functions-post)、[开发别名域名](https://docs.cloudbase.net/service/alias)。

提交体是平铺的 `{ action: "submit", ...FeedbackSubmission }`；撤回体为 `{ action: "delete", schemaVersion: 1, reportId, deleteToken }`。**整个原始 HTTP 请求体包含 action 后最多 65,536 字节**；诊断包最多 16,384 字节，字段使用共享严格白名单。非法内容、额外字段或超限请求在调用数据库前拒绝。

- 接受新报告返回 `201`，相同报告重试返回 `200` 和原收据；同一 ID 内容或证明改变返回 `409`。
- 发送时间与重试期限必须相差 24 小时；数据库拒绝过期重试和超过 5 分钟的未来时间。
- 撤回证明在 HTTP 后端将 43 字符 token 字符串做 SHA-256；数据库仅保存摘要。撤回后保留 25 小时墓碑，阻止延迟提交复活已撤回报告。
- 主表保留期为接受时间起精确 90 × 24 小时。定时清理删除到期报告、墓碑和旧配额计数。数据库 TTL 删除不代表平台日志或备份立即擦除。
- 全局提交每分钟 30 次 admission，每 UTC 日 500 条新报告。重复、冲突及墓碑拒绝不占每日新报告额度；重复仍受分钟 admission 限制。撤回使用独立的每分钟 30 次、每 UTC 日 500 次额度。没有伪称可信的客户端 IP 限流。
- `ZZB_FEEDBACK_ENABLED=false` 仅暂停新提交；合法撤回和定时保留期清理继续工作。

程序不记录请求、正文、头部、运行时上下文、凭据或供应商原始错误；清理程序仅记录删除计数。**尚未证明 CloudBase 网关、函数平台或数据库日志是否保存正文，也未读取实际 PG 备份保留期**。`checkLogService.enabled=false` 只证明现有 CLS 服务未开启，不能证明平台没有其他日志。

## 运行配置与凭据

私有 PostgreSQL 连接使用 `ZZB_FEEDBACK_PG_HOST`、`ZZB_FEEDBACK_PG_PORT`、`ZZB_FEEDBACK_PG_DATABASE`、`ZZB_FEEDBACK_PG_USER`、`ZZB_FEEDBACK_PG_PASSWORD`。若使用平台私有 CA，将证书链注入 `ZZB_FEEDBACK_PG_CA`。网络必须已连通数据库的私网主机，TLS 证书须能验证该主机名或 IP。生产函数使用控制台提供的实例端点、VPC 和子网。微型共享实例仅开放 SDK 和网关，专用任务账号的 PostgreSQL 协议路径适用于支持私网直连的实例。[连接数据库](https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql) · [CloudBase MCP 工具](https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/mcp-tools)

收件与清理使用两个独立登录。数据库所有者通过平台支持的账号管理方式创建普通 LOGIN，只在目标环境为经过核对的登录执行以下对应绑定。引号中的名称须替换为已创建的账号；具体密码通过服务器密钥配置注入。

```sql
GRANT zzb_feedback_intake TO "intake_login_from_console" WITH INHERIT TRUE, SET FALSE;
GRANT zzb_feedback_retention TO "retention_login_from_console" WITH INHERIT TRUE, SET FALSE;
```

两个登录均需开启 INHERIT，只能直接加入其专属组，且不具有管理成员、建库、建角色、复制、超级用户或绕过 RLS 权限。绑定前需核对既有环境授予 PUBLIC 或该登录的直接权限，以独立连接确认其无法读取其他业务表。收件登录可执行提交和凭证撤回；清理登录可执行过期清理。两个账户均不能读反馈表、调配额内部函数，或调用对方的操作。私有函数在数据库内核验原始登录身份；云函数进程仅持有自己的凭据。运行时依赖 postgres.js 与 Zod 的许可原文在每个 ZIP 的 `licenses/`。

新部署先用合成报告，在已知私网入口验证接收、并发重试、凭证撤回和到期清理。平台函数入口还需证明只允许受控维护者调用，首次联调保留空触发器；通过验收后另行启用每日清理。正式对外收件需独立验收公开入口、费用和留存。

## 只读环境证据

可使用已经安装的官方 MCP CLI 读取绑定环境：

```powershell
node scripts/cloudbase-feedback-mcp.mjs --entry <absolute-existing-official-dist-cli.cjs> --status
node scripts/cloudbase-feedback-preflight.mjs --entry <absolute-existing-official-dist-cli.cjs> --out .tmp/cloudbase-feedback-preflight-new
```

工具不会安装包、登录、改绑定、改 Codex 配置或发起云端写操作；只允许选择过的 metadata 查询和单条 catalog SELECT。CLI 必须是现有官方包的 `dist/cli.cjs`，不是库入口 `index.cjs`。`.tmp` 中环境身份和权限原像仅为本机审阅材料，不可公开。

最新证据位于 `.tmp/cloudbase-feedback-preflight-extended/preflight.json` 与 `failure-details.json`：

| 项目 | 本轮证据与限制 |
| --- | --- |
| 环境 | 已绑定授权上海环境；`baas_personal`、预付费、PostgreSQL 与 NoSQL 可用 |
| 费用 | `DescribeBillingInfo` 返回 `EnableOverrun=true`，自动续费关闭；没有据此承诺额外费用为零 |
| 套餐 | `DescribeEnvPlans` / `DescribeBaasPackageList` 可读；为可售套餐 metadata，不能证明当前环境 PG 和函数的实际历史权益 |
| 使用量 | 当月 `FunctionInvocationpkg=0`；用量查询不构成未来费用上限 |
| 新对象冲突 | catalog 未见 `zzb_feedback_%` 列；本轮函数列表为空；部署前仍需重新检查 |
| Publishable Key | 最新读取未返回可用 Key；未创建 |
| 服务端 Key 列表 | 最新 `listApiKeys` 返回失败，记为 **unavailable**。早版仅看响应形状后报告“列表为空”，不能用作 Key 不存在的证据 |
| 权限 | `authz.user.rego` 读取为空；无法推导 OPA 是否启用或旧规则行为。高层权限 helper 使用 fallback；直调 `tcb.tencentcloudapi.com / DescribeResourcePermission` 返回 MCP `isError=true`，没有可识别的腾讯云错误码 |
| CLS | 当前 `checkLogService.enabled=false`；环境 metadata 未提供绑定 TopicId，未查询无关日志主题、未启用 CLS |
| PG 备份 | 未找到经核对的环境级保留期读取路径。官方 PG 文档指向底层腾讯云 PostgreSQL，文档型数据库的 7 天不能套用 |

详见 [部署审阅与授权差异](DEPLOYMENT_REVIEW.md)；收集端只能在其验收完成后启用。
