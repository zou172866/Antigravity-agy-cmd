---
name: agy-cmd
description: Antigravity 桌面端/IDE 高阶能力自动路由与内置斜杠指令参谋。用于开关路由、调自动重试/交付门禁/会员 Boost，或查询对比 /grill-me、/plan、/goal、/boost、/swarm、/run-workflow 等内置指令（禁混 CLI 专属命令）。
---

# agy-cmd：高阶能力自动路由与指令参谋（v2.7.2）

四项核心能力：**常驻精简规则**（`rules/AGENTS.md`，轻量零打扰、免费防报错）、**零稳态开销钩子**（`hooks.json`：`SessionStart` / `PreToolUse` / `PostToolUse` / `PreInvocation` / `Stop`）、**右侧 Sidecar 面板**（`sidecar://agy-cmd/panel/`）与**指令选型参谋**。

## 关键不变量

1. **免费安全默认**：`planTier = "free"`、`boostEnabled = false`。`/boost`、`/teamwork` 仅付费；`/swarm`、`/run-workflow` 全套餐开放但耗额较高，免费档默认不主动推荐。卡壳优先派可用只读 `dart-reviewer` 或 `research`，否则主会话排查。
2. **安装后首次引导**：初始化或用户未确认配置时，提醒打开右侧 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 确认 **① 自动重试次数** 与 **② 会员 Boost 自动接入**。
3. **审批与轻量边界**：只读 Plan Mode 拒写方案时在正文给方案并等待，严禁调 `exit_plan_mode` 绕过；1～2 文件明确低风险修改直接执行，不加徽标、不建计划、不推指令。
4. **严禁 CLI 专属指令**：禁止推荐 `/undo`、`/rewind`、`/branch`、`/fork`、`/clear`、`/new`、`/resume`、`/switch`、`/effort`、`/codesearch`、`/diff`、`/statusline`、`/title`、`/voice`、`/exit`。

## 工作流程

### 模式 A：调节面板设置、门禁与自检

Antigravity App（含 SSH 转发）可直接点击 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 调节；IDE/CLI 或聊天口令调参可运行 [scripts/setup_auto_router.py](scripts/setup_auto_router.py)（Linux/macOS/SSH 用 `python3`，Windows 可用 `python`）：

```bash
# 自动重试次数（off / 1..50 / infinite）与触发范围（smart 默认 / all_failures / goal_only）
python3 scripts/setup_auto_router.py --auto-retry off|5|infinite
python3 scripts/setup_auto_router.py --retry-scope smart

# 账号套餐与 Boost 开关（free 默认防报错 / paid 开启）
python3 scripts/setup_auto_router.py --plan-tier free
python3 scripts/setup_auto_router.py --plan-tier paid --boost on|off

# 交付前强制测试门禁（默认关，全套餐可用；实质改码后必过全量/自定义验证，无测项目保守放行并声明缺测；单轮说「这次跳过测试」可豁免）
python3 scripts/setup_auto_router.py --delivery-test-gate on|off
python3 scripts/setup_auto_router.py --delivery-test-cmd "npm run typecheck && npm test"   # 传 "" 清空

# 免费计划获批后的可选只读复核（默认关，最多派 1 次 cmd-verifier）
python3 scripts/setup_auto_router.py --free-plan-review on|off

# 状态 / 同步安装 / 零漂移校验 / 停用
python3 scripts/setup_auto_router.py --status
python3 scripts/setup_auto_router.py --install
python3 scripts/setup_auto_router.py --sync-check
python3 scripts/setup_auto_router.py --remove
```

> **面板链接边界**：仅安装引导、调参或用户要求打开面板时附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)`（App `v2.35.1+` 会自动弹开侧栏）；**纯查指令对比勿附该链接**。

### 模式 B：日常开发自动调度

**重型路由（Swarm / Workflow）准入三步**：
1. 仅候选任务判断；用户明确点名运行某项时视为单次点选，已有原生命令运行时直接跟随。
2. 确认当前为 Antigravity App 且公开工具/命令含目标能力（如 `run_workflow`）；IDE、未知宿主或未开放时留在主会话（勿以磁盘存在内置技能作证）。
3. 主动路由取已读状态中的 `settings.planTier`；未知时仅调一次 `python3 scripts/setup_auto_router.py --status --json`（只读不改）。仅 `paid` 进入主动重型路由，`free`/未知走顺序分批且不亮重型徽标。

| 任务特征 | 调度徽标 / 轨道 | 执行动作 |
| --- | --- | --- |
| 需求模糊、边界未定 | `[agy-cmd → /grill-me 追问]` | `ask_question` 单题追问，推荐项置顶 `(Recommended)` |
| 预计改 ≥3 文件、改公共接口或高风险 | `[agy-cmd → /plan 审批]` | 先只读确认范围（`apply_edits` 按文件计），提交 `RequestFeedback: true` 计划；只读模式拒写时在正文提交并等待。多模块获批计划在 App 可接 `/swarm execute our plan`；会员开「计划获批自动 Boost」时按钩子单次派工 |
| 单项独立旁支调查 | Subagents | 主线程有余量时 `invoke_subagent` 派 1 个可用角色，写清范围与回传证据，主线程核对 |
| ≥5 同质对象按同规则检查 | 默认顺序分批；准入后 `[agy-cmd → /run-workflow]` | 纯匹配用本地命令；进入 Workflow 先读 `run-workflow`，每项 Prompt 含目标/规则/验收与 JSON Schema 并逐项捕获异常。编码优先选可用的 `dart-coder`，否则选 `self`；高精度用 `model="inherit"`（接口靠省略继承则省略） |
| 可拆独立 Lane（多模块写码、多视角只读评审/排障、Best-of-N） | 默认单写手；准入后 `[agy-cmd → 建议 /swarm]` | **负向否决门**：前后强依赖或紧耦合改动禁止强行并行（留主会话/Orchestrator 或 `/boost`）。准入后先 Pre-flight（定接口、`OWNS`/`MUST NOT TOUCH`/`DONE MEANS` 与验证命令），输出可复制 `/swarm` 提示词（未经点名不私调 `swarm`）。活跃 Swarm 须读 `swarm_pane`，6 套模板、三层选模、worktree 隔离与配额切模细则见 [选型矩阵](references/desktop-commands-matrix.md) |
| 动态网页 / 交互图表 | `[agy-cmd → /browser]` / `[agy-cmd → /generative_ui]` | 委派可用 `browser`；App 支持时读 `generative_ui` |
| 疑难任务或反复卡壳（免费 ≥2 次 / 付费 Boost ≥3 次震荡，或连续 ≥3 次失败、跨 ≥2 轮未解） | 套餐感知自动派工 | 按钩子提示：会员 `[agy-cmd → 自动 Boost]` 派 `DeepInvestigator`（只读/待审批）或 `DeepCoder`（已授权修复），主会话验证、失败接手；免费 `[agy-cmd → 自动换视角排查]` 派只读 `dart-reviewer` 或 `research`。活跃 Swarm 及 Worker 由钩子自动豁免 |
| 改码/修错后测试未绿 | Stop 自动续跑监工 | 实跑验证未绿时自动续跑；问原因、只读环境探测或等待确认自动放行。免费获批计划漏测时最多提醒补验 1 次；开启交付门禁则全套餐改后必测 |

### 模式 C：指令选型参谋

- **分流原则**：日常留主会话（已选 Orchestrator 时由 Neon 规划、Hydrogen 执行，遇阻自动回交）；单项旁支用 Subagent；单点疑难用 `/boost`；独立 Lane 并行/跨模型审 Diff 用 `/swarm`；同质批处理或高频固化的 Swarm 流程用 `/run-workflow`；跨天分里程碑审计用 `/teamwork`；需求不清先 `/grill-me`，多文件先 `/plan`。
- **交付口径**：按当前宿主与配额给出可执行方案、带 `@` 提示词模板和验收条件（免费/未知给普通语言模板）。完整指令对比、6 套 Swarm 模板、三层选模与远程 SSH/Remote 模式明细见 [选型矩阵](references/desktop-commands-matrix.md)。
