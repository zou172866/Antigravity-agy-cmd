# Antigravity 自动路由 (agy-cmd)

仅桌面 App/IDE，工作区 `AGENTS.md` 优先。子智能体、Swarm 成员、Workflow Worker 跳过路由，按任务书或留言板执行。技能缺失时依本规则。

- 仅触发带徽标的动作时首行给 1 个对应徽标。勿复推已用命令，禁推 CLI `/undo`、`/branch`、`/effort`。
- 需求或边界未定 → `[agy-cmd → /grill-me 追问]`。用 `ask_question` 只问阻碍下一步的问题，独立问题可合问，推荐项置顶 `(Recommended)`。
- 写项目文件前定范围，不明先只读扫描，`apply_edits` 按文件计。改 ≥3 个文件、改公共接口或高风险 → `[agy-cmd → /plan 审批]`，交 `RequestFeedback: true` 计划，获批再写。只读 Plan Mode 拒写计划文件时，正文交方案等审批，严禁用 `exit_plan_mode` 绕过。
- 批处理、多模块默认顺序分批，纯正则直接在本地完成。主动推荐或调用重型命令须同时满足 `planTier=paid`、Antigravity App、宿主开放该项。免费、未知或 IDE 走默认，不亮重型徽标。
- 准入后，≥5 个同质独立项 → `[agy-cmd → /run-workflow]`，先读 `run-workflow`。独立分工先核对接口、文件归属、验证方式，无冲突再给 `[agy-cmd → 建议 /swarm]` 和可复制提示词。未点名运行不调 `swarm`。前后强依赖或紧耦合改动禁止强行并行，留主会话。
- App 内点名运行可单次执行对当前账号开放的该项。`/boost`、`/teamwork` 仅限付费。查用法不算点名运行。
- 主会话有余量才派 1 个 `research` 查独立旁支。动态网页 → `[agy-cmd → /browser]`。App 交互图表 → `[agy-cmd → /generative_ui]`，先读 `generative_ui`。
- 卡壳按钩子指定角色派工，无钩子由主会话排查。待审或只读时只调查。`[agy-cmd → 自动换视角排查]` 始终只读。所有派工由主会话验收，失败接手。
- 改码或修错后实跑现成测试或构建供 `Stop` 核验。续跑和建议 `/goal` 仅用当轮钩子指定的徽标。
- 重型准入、调参或查指令读 `agy-cmd` 技能。纯查或对比指令勿输出面板地址。仅安装引导、明确要求开面板或调参时附 Markdown 链接，文字为 `agy-cmd 自动路由`，地址为 `sidecar://agy-cmd/panel/`。
- 其余解释、查找或明确的 1～2 文件低风险修改直接做，不建计划、不推命令。
