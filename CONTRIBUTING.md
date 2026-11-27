# 参与 ZZ Board

ZZ Board 使用 Source Available 1.0（源码可用）。项目的授权范围和商业使用条件见 [LICENSE](LICENSE)。

欢迎问题复现、使用建议、合成示例与独立社区实验。首测反馈在本机起草。你可以在「反馈与帮助」复制或保存公开预览。源码预览开放问题和建议两种 GitHub 表单。按类型打开后，检查内容并用自己的 GitHub 账号提交。请只提供可公开的复现步骤，保留真实便签、对话、联系方式和完整路径在本机。可疑安全问题见 [安全报告](SECURITY.md)。[报告问题](https://github.com/zh3zhou/zz-board/issues/new?template=bug.yml) · [提出建议](https://github.com/zh3zhou/zz-board/issues/new?template=feature.yml)

## 代码与 Fork

免费社区 Fork、免费源码及配套二进制分享、免费社区托管均在许可允许范围内。修改版需要说明维护者和改动；分发二进制时提供完全对应的源码与构建步骤，并延续同一许可。独立分支的问题由其维护者处理，主项目不承诺合并每一种产品方向。

大功能、持久数据格式、模型访问、网络上传和许可变更，请先通过 Issue 说明目标与兼容性。接受实质性外部贡献前，维护者与贡献者需说清该代码能否用于未来另行授权的商业版本，并记录约定和覆盖范围。许可第 6 条默认由贡献者保留版权，按同一许可提交；如需额外商业再许可权，要有相应权利人的书面授权。

## 开发与验证

Windows x64；Node.js 24.18 或更新版本、`pnpm@11`，桌面构建还需 Rust/MSVC 和 WebView2。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm smoke:windows
```

桌面改动再运行 `pnpm desktop:build` 和 `pnpm desktop:smoke`。生成目录不提交；使用合成夹具，不连接维护者的私有数据或云环境。同步和总结不能修改源 Codex 任务；网络反馈必须由用户预览并主动提交。PR 说明改动后的行为、实际验证和未验收事项。

维护者集中处理反馈，不承诺即时响应或固定 SLA。安全问题按 [SECURITY.md](SECURITY.md) 的私密路径处理。
