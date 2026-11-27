# 和自己的 Agent 定制 ZZ Board

源码项目是定制和长期维护的主场：Agent 在这里定位、改动、验证，并由这里构建完整 Windows 交付物。完成一次交付后，仍回到这个版本的 `README.md`、本手册和测试记录维护下一次改动；不要在 EXE 内修补或把一次构建当成发布。源码许可目前仍是草案，使用和分发以最终生效全文为准。

开始前请让 Agent 依次阅读 `README.md`、`docs/USER_AGENT_GUIDE.md`、本文件；要改代码再读 `AGENTS.md` 和 `agent.project.yaml`。只用合成数据测试，除非你明确授权，否则不读真实看板、Codex 历史或 `.local-data/`。

## 看板界面与皮肤的分工

- **空间**。日常打开时回到上次画布。菜单从原按钮展开，关闭后释放画布。项目索引、搜索结果和待回应数量在展开的菜单中展示。皮肤沿用这套导航和键盘顺序。
- **文字**。先写用户要操作的对象或动作。搜索结果写出页名和命中片段。对话的「待回应」、便签里的勾选项、用户设置的优先级各自保留含义。显示失败时交代内容是否保存，以及可以在哪里恢复。
- **阅读顺序**。让项目名、便签正文和上次停点先被读到。日期、页名和来源作为第二层，长中文和英文混排都允许换行。复杂操作按需展开。关掉面板后，键盘用户能回到原入口。
- **外观**。颜色、纸面、材质和选中状态沿用当前 Skin 提供的变量。增加皮肤时，用浅色和深色各检查一次长标题、键盘焦点、搜索结果、只读与保存失败。优先级和状态要有文字或形状提示。

## 先用 Skin 做外观

打开皮肤库，展开「用 Codex 制作外观」并复制指令。把引号里的风格换成自己的描述即可。

```text
我在 ZZ Board 匹配版本的源码项目。请阅读 skills/create-zz-board-skin/SKILL.md，制作一套「蓝墨水写在暖白方格纸上」的 Skin。先预览和校验；不要安装或应用，等我选择。
```

Codex 在 V3 配方中指定暖白纸面、蓝墨正文与强调、两档优先色和纸张材质，再单独给背景加方格。完整的六个组件都由这份配方生成。新皮肤出现在「已导入」后，可以在同一段中文走访笔记上看气泡、选中便签、连线、笔迹和工具条，点「放大试读」看长文。选「整套应用」，或在「混搭外观」中只换便签、界面等单项。看板个人壁纸与分享的皮肤包各自保存。

制作需要匹配版本的源码、Node、pnpm 和已安装的依赖。收到已有 `.zzskin` 的人可以直接在应用内导入预览；需要制作、校验或改格式时，回到源码项目。

要自己编辑起稿，可以在源码目录运行以下命令。输出目录和文件需使用新名字。

```powershell
pnpm skin -- init ./blue-ink-grid --id blue-ink-grid --name "蓝墨方格"
pnpm skin -- validate ./blue-ink-grid
pnpm skin -- pack ./blue-ink-grid ./blue-ink-grid.zzskin
pnpm skin -- validate ./blue-ink-grid.zzskin
```

`init` 会写出完整的 `skin.json`、设计说明、来源记录和空的 `assets/`。可以明确交代 Codex「只制作和打包」，然后在看板中自行导入。安装与应用是两个独立操作。每次修订使用新的 `skinId@version`，旧看板继续读取已选的精确版本。

四种表面材质是平面、哑光、纸张和玻璃。气泡支持圆、椭圆、圆角矩形与八个圆角百分比的软轮廓。声明式皮肤允许本地 PNG/WebP，字体、CSS、HTML、脚本、SVG 与远程网址均由格式校验排除。个人参考原图留在本机，分享包可加入为该风格单独制作的纹理。

## 超出外观时修改源码

Agent 先读 `AGENTS.md`、`agent.project.yaml` 和当前状态，再只读定位相应代码。常见入口：

| 修改方向 | 源文件 |
| --- | --- |
| 安全外观格式/校验 | `src/shared/skin.ts` |
| Skin 渲染与预览 | `src/web/skinRuntime.ts`、`src/web/SkinPanel.tsx` |
| 便签交互 | `src/web/NoteEditor.tsx`、`src/web/NoteRichEditor.tsx` |
| 画布入口/工具 | `src/web/App.tsx` |
| 持久化与撤销 | `src/server/database.ts`、`src/server/app.ts` |
| 数据交换格式 | `src/shared/schema.ts` |

例如“增加星形便签”需要扩展受验证的形状格式、渲染、预览与命中/缩放行为；这是一个需要兼容旧数据和测试的源码任务。不要绕过校验插入任意 SVG/CSS。解释原因与最小方案后，在源码目录验证，不修改用户真实画布。

Agent 的结果应包含实际改动、操作入口、兼容范围、执行过的测试和未完成的原生验收。共享格式/服务变更运行聚焦测试，再 `pnpm check` 和 `pnpm smoke:windows`；桌面交付追加 `pnpm desktop:build`、inspection-only `pnpm desktop:smoke`。不能把 Node 集成测试称为原生 GUI E2E。

## 维护时先问 Agent 的短提示

```text
我在 ZZ Board 源码项目。目标是：<一句话>。
请先读 README.md、docs/USER_AGENT_GUIDE.md、docs/AGENT_CUSTOMIZATION.md；改代码再读 AGENTS.md 和 agent.project.yaml。
给出最小改动、兼容/数据影响和验证命令。使用合成数据；不要读取真实看板、安装 Skill、改绑定、部署或发布，除非我随后明确批准。
```
