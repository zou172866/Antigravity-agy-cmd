# Antigravity 自动路由 (agy-cmd)

仅桌面端 App/IDE；工作区 `AGENTS.md` 优先。**子智能体、Swarm 成员或 Workflow Worker 跳过本文件路由，按任务书/留言板执行。**

- **轻量直出**：解释/查找或 1～2 文件明确低风险修改 → 直接做，**不加徽标、不建计划、不推指令**。
- **徽标**：仅命中下方调度/兜底时首行输出 1 个徽标（如 `[agy-cmd → /plan 审批]`、`[agy-cmd → 自动换视角排查]`）。
- **原生调度**：
  1. 需求/边界未定 → `[agy-cmd → /grill-me 追问]`，调 `ask_question` 单题追问，推荐项置顶 `(Recommended)`。
  2. 写项目文件前判范围（不明先只读扫描；`apply_edits` 按文件计）：≥3 文件、改公共接口或高风险 → `[agy-cmd → /plan 审批]`，提 `RequestFeedback: true` 计划获批再写；**只读 Plan Mode 拒写方案时正文给方案并等待，严禁调 `exit_plan_mode` 绕过**。
  3. 批处理/多模块默认顺序分批（纯正则用本地命令）；主动重型路由须同时确认 `planTier=paid`、Antigravity App 且宿主开放该能力（见 `agy-cmd` 技能），免费、未知或 IDE 走默认不亮徽标；用户点名运行 App 已开放项可单次执行。
  4. 准入后：≥5 同质独立项 → `[agy-cmd → /run-workflow]`（读 `run-workflow`）；无冲突独立 Lane → 先 Pre-flight（接口/所有权/验证）再给 `[agy-cmd → 建议 /swarm]` 与可复制提示词（多模块获批计划可接 `/swarm execute our plan`），未点名不私调 `swarm`。**前后强依赖或紧耦合改动禁止强行并行**（留主会话/Orchestrator 或 `/boost`）。
  5. 独立旁支且主会话有余量 → 派 1 个 `research` 并核对；动态网页 → `[agy-cmd → /browser]`；App 交互图表 → `[agy-cmd → /generative_ui]`（读 `generative_ui`）。
- **套餐兜底与自动续跑**（禁推 CLI 专属 `/undo`、`/branch`、`/effort`；已用对应 `/` 不重复提示）：
  1. **疑难/卡壳**：收 `[agy-cmd → 自动 Boost]` 派 `DeepInvestigator`（只读/待审）或 `DeepCoder`（已授权）；收 `[agy-cmd → 自动换视角排查]` 派只读 `dart-reviewer`/`research`；主会话验证，失败接手。
  2. **Stop 监工**：改码/修错后实跑现成测试/构建供 `Stop` 核验续跑；仅收钩子提示时输出 `[agy-cmd → 自动续跑已启用]` 或 `[agy-cmd → 建议 /goal]`。
  3. **设置/选型**：调参或查指令对比读 `agy-cmd` `SKILL.md`；仅引导或明确开面板/调参时附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)`，纯查指令勿附。
