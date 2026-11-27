# Antigravity 自动路由 (agy-cmd)

仅桌面 App/IDE，工作区 `AGENTS.md` 优先。子智能体、Swarm 成员、Workflow Worker 跳过路由，按任务书或留言板执行。

- **顺序**：先澄清阻碍下一步的歧义，再判写入审批，获批后才选执行方式。仅触发带徽标的动作时首行给 1 个对应徽标；勿复推已用命令，禁推 CLI `/undo`、`/branch`、`/effort`。
- **澄清与审批**：边界未定 → `[agy-cmd → /grill-me 追问]`（用 `ask_question` 合问独立问题）。明确低风险 1～2 文件修改直接做；写前定范围（`apply_edits` 按文件计），改 ≥3 文件、公共接口或高风险 → `[agy-cmd → /plan 审批]`（交 `RequestFeedback: true` 计划，获批再写）。只读 Plan Mode 拒写计划时，正文交方案等待，严禁用 `exit_plan_mode` 绕过。
- **执行与重型准入**：默认主会话顺序执行。主动推荐重型命令须同时满足 `planTier=paid`、Antigravity App、宿主开放该项（免费、未知或 IDE 走默认，不亮重型徽标）；App 内点名运行按该项实际权限执行，`/boost`、`/teamwork` 仅限付费，查用法不算点名。
- **多代理轨**：准入后，≥5 同质独立项 → `[agy-cmd → /run-workflow]`（先读 `run-workflow`）；独立分工核对接口与归属无冲突再给 `[agy-cmd → 建议 /swarm]` 和提示词（未点名不私调 `swarm`，前后强依赖或紧耦合改动禁止强行并行）。动态网页 → `[agy-cmd → /browser]`；App 交互图表 → `[agy-cmd → /generative_ui]`。
- **排障、验证与长程**：卡壳按钩子指定角色派工（待审/只读仅调查，`[agy-cmd → 自动换视角排查]` 始终只读，主会话验收）。改码或修错后按当前门禁实跑现成检查供 `Stop` 核验。用户点名 `/goal` 且授权不必逐轮询问时，`/grill-me`、`/plan` 门禁改记待确认清单并继续独立任务（产品决策、破坏性迁移、改外部合同或只读 Plan Mode 仍停下确认）。
- **按需技能与面板**：调参、重型模板或查指令读 `agy-cmd` 技能。纯查或对比指令勿附面板地址；仅安装引导、调参或要求开面板时附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)`。
