# Antigravity 自动路由 (agy-cmd)

仅桌面端 App/IDE；工作区 `AGENTS.md` 优先。

- **轻量直出（零打扰）**：解释代码、本地文本查找，或改法明确、仅涉及 1～2 个文件且不触及公共接口的低风险修改 → 直接执行，**不加徽标、不建计划、不推指令**。
- **可见徽标**：仅当命中下方「原生调度」或「套餐感知兜底」时，在回复（或方案/提问）第 1 行输出 1 个简短徽标，例如 `[agy-cmd → /plan 审批]`、`[agy-cmd → 自动换视角排查]`。
- **原生调度**：
  1. 需求/边界未定 → 标注 `[agy-cmd → /grill-me 追问]` 并调 `ask_question` 单题追问，推荐项置顶 `(Recommended)`。
  2. 首次写项目文件前，按本次任务预计改动的文件数判断范围（`agy-dart` 的 `apply_edits` 批量修改按文件计）。范围不明时先只读扫描。预计改 ≥3 个文件、变更公共接口或涉及高风险 → 输出 `[agy-cmd → /plan 审批]`，提交 `RequestFeedback: true` 的 Implementation Plan，获批后再写项目文件。**若只读 Plan Mode 拒绝 `write_file` 写方案产物，在回复正文给出方案并等待确认，严禁调用 `exit_plan_mode` 绕过审批**。
  3. 批处理或多模块协作才检查重型路由。默认在主会话顺序分批，纯正则用本地命令。主动调度须同时确认面板 `planTier=paid`、当前是 Antigravity App 且宿主开放目标能力（取证见 `agy-cmd` 技能）。免费、未知或 IDE 直接走默认路径，不亮重型徽标。用户本次明确要求运行 App 已开放的 Swarm 或 Workflow 时可单次使用，保留其设置。
  4. 准入后，≥5 个同质对象独立交回结果 → `[agy-cmd → /run-workflow]`，读 `run-workflow`。2～4 个模块须协调接口或交叉审查 → `[agy-cmd → /swarm]`，先定接口、互不重叠的写入路径与验证命令，每组设独立 Verifier，账户可选时用不同模型。共享文件交单人顺序改。
  5. 有一项独立调查且主会话有其他工作可继续时，可派一个可用的 `research` 查证，主会话核对。动态网页/截图 → `[agy-cmd → /browser]` 调 `browser`；App 开放交互图表工具时 → `[agy-cmd → /generative_ui]` 读 `generative_ui`。
- **防报错套餐感知与自动续跑**（禁推 CLI 专属 `/undo`、`/branch`、`/effort`；本轮已用对应 `/` 指令则不重复提示）：
  1. **卡壳排错**：同一 Bug 跨 ≥2 轮未解、≥2 次「修改→仍失败」震荡、连续 ≥3 次命令失败或难算法 → 仅在钩子明确提示 `[agy-cmd → 建议 /boost]` 时给付费口令。否则输出 `[agy-cmd → 自动换视角排查]`，给可用的 `dart-reviewer` 派只读排查任务，备选 `research`；都不可用时由主会话逐一验证假设。
  2. **防停机自动续跑（Stop 监工）**：改代码或修错后若存在现成测试/构建命令，结束前优先实跑验证以便 `agy-cmd` `Stop` 钩子无感核验并在未通过时按面板设定次数自动续跑；仅当收到钩子明确提示时输出 `[agy-cmd → 自动续跑已启用]` 或 `[agy-cmd → 建议 /goal]`。
  3. **调节重试/Boost 与指令选型**：当用户调节自动重试次数、切换会员/Boost 开关，或查询对比指令时，读 `agy-cmd` `SKILL.md`（可附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)` 面板入口）。
