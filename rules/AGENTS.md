# Antigravity 自动路由 (agy-cmd)

仅桌面端 App/IDE；工作区 `AGENTS.md` 优先。

- **轻量直出（零打扰）**：解释代码、本地文本查找，或改法明确、仅涉及 1～2 个文件且不触及公共接口的低风险修改 → 直接执行，**不加徽标、不建计划、不推指令**。
- **可见徽标**：仅当命中下方「原生调度」或「套餐感知兜底」时，在回复（或方案/提问）第 1 行输出 1 个简短徽标，例如 `[agy-cmd → /plan 审批]`、`[agy-cmd → 自动换视角排查]`。
- **原生调度**：
  1. 需求/边界未定 → 标注 `[agy-cmd → /grill-me 追问]` 并调 `ask_question` 单题追问，推荐项置顶 `(Recommended)`。
  2. 首次写项目文件前，按本次任务预计改动的文件数判断范围（`agy-dart` 的 `apply_edits` 批量修改按文件计）。范围不明时先只读扫描。预计改 ≥3 个文件、变更公共接口或涉及高风险 → 输出 `[agy-cmd → /plan 审批]`，提交 `RequestFeedback: true` 的 Implementation Plan，获批后再写项目文件。**若只读 Plan Mode 拒绝 `write_file` 写方案产物，在回复正文给出方案并等待确认，严禁调用 `exit_plan_mode` 绕过审批**。
  3. ≥5 对象语义批处理 → `[agy-cmd → /run-workflow]`，读 `run-workflow`（`parallel()`/`pipeline()`；纯正则用本地命令；高精度批处理显式 `model="inherit"` 禁擅自降级，共享长前缀时按 3～5 项复用多轮 Worker（编码优先选可用的 `dart-coder`，否则选 `self`） 命中 KV 缓存并做单项异常隔离；若套餐不支持则自动分批顺序处理）。
  4. 动态网页/截图 → `[agy-cmd → /browser]` 调 `browser`；复杂图表/交互 → `[agy-cmd → /generative_ui]` 读 `generative_ui`；2～4 模块并行+验收（仅确认付费套餐可用时）→ `[agy-cmd → /swarm]` 读 `swarm`。
- **防报错套餐感知与自动续跑**（禁推 CLI 专属 `/undo`、`/branch`、`/effort`；本轮已用对应 `/` 指令则不重复提示）：
  1. **卡壳排错（默认免费版防报错）**：同一 Bug 跨 ≥2 轮未解、≥2 次「修改→仍失败」震荡、连续 ≥3 次命令失败或难算法 → **默认严禁主动推荐 `/boost`、`/teamwork` 等付费指令以防免费号报错**；仅当收到 `agy-cmd` 钩子明确指示输出 `[agy-cmd → 建议 /boost]` 时才给 `/boost` 口令，否则统一输出 `[agy-cmd → 自动换视角排查]`，停止盲改并优先调可用的 `dart-reviewer`，否则派只读 `research` 子智能体独立核查根因或先列排查假设逐一验证。
  2. **防停机自动续跑（Stop 监工）**：改代码或修错后若存在现成测试/构建命令，结束前优先实跑验证以便 `agy-cmd` `Stop` 钩子无感核验并在未通过时按面板设定次数自动续跑；仅当收到钩子明确提示时输出 `[agy-cmd → 自动续跑已启用]` 或 `[agy-cmd → 建议 /goal]`。
  3. **调节重试/Boost 与指令选型**：当用户调节自动重试次数、切换会员/Boost 开关，或查询对比指令时，读 `agy-cmd` `SKILL.md`（可附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)` 面板入口）。
