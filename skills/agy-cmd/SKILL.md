---
name: agy-cmd
description: Antigravity 桌面端/IDE 高阶能力自动路由与内置斜杠指令参谋。用于开关路由、调自动重试/交付门禁/会员 Boost，或查询对比 /grill-me、/plan、/goal、/boost、/swarm、/run-workflow 等内置指令（禁混 CLI 专属命令）。
---

# agy-cmd：高阶能力自动路由与指令参谋（v2.8.2）

四项能力：**常驻精简规则**（`rules/AGENTS.md`）、**零稳态开销钩子**（`hooks.json`：`SessionStart` / `PreToolUse` / `PostToolUse` / `PreInvocation` / `Stop`）、**右侧 Sidecar 面板**（`sidecar://agy-cmd/panel/`）与**按需指令参谋**。

## 关键不变量

1. **免费安全默认**：`planTier = "free"`、`boostEnabled = false`。`/boost`、`/teamwork` 仅付费；`/swarm`、`/run-workflow` 全套餐开放但耗额较高，免费档默认不主动推荐。卡壳改派内置只读 `research`（1× 原价，避免自定义/插件 Agent 触发 4× 配额倍率），不可用则主会话排查。
2. **安装后首次引导**：初始化或未确认配置时，提醒打开 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 确认 **① 自动重试次数** 与 **② 会员 Boost 自动接入**。
3. **审批与轻量边界**：只读 Plan Mode 拒写方案时正文输出方案并等待，严禁调 `exit_plan_mode` 绕过；1～2 文件明确低风险修改直接执行，不加徽标、不建计划、不推指令。
4. **严禁 CLI 专属指令**：禁止推荐 `/undo`、`/rewind`、`/branch`、`/fork`、`/clear`、`/new`、`/resume`、`/switch`、`/effort`、`/codesearch`、`/diff`、`/statusline`、`/title`、`/voice`、`/exit`。

## 工作流程

### 模式 A：面板调参、门禁与自检

App（含 SSH 转发）点击 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 调节；IDE/CLI 或聊天口令调参运行 [scripts/setup_auto_router.py](scripts/setup_auto_router.py)（Linux/macOS/SSH 用 `python3`，Windows 可用 `python`）：

```bash
# 自动重试次数（可选：off / 1..50 / infinite）与触发范围（可选：smart 默认 / all_failures / goal_only）
python3 scripts/setup_auto_router.py --auto-retry 5
python3 scripts/setup_auto_router.py --retry-scope smart

# 账号套餐、Boost、降级保护与统计清零（开关参数可选：on / off；默认 free 防报错）
python3 scripts/setup_auto_router.py --plan-tier free
python3 scripts/setup_auto_router.py --plan-tier paid --boost on --boost-after-plan-approval off
python3 scripts/setup_auto_router.py --free-fallback on --plan-fallback on
python3 scripts/setup_auto_router.py --reset-stats

# 交付前强制测试门禁（开关可选：on / off，默认关；传 "" 清空自定义命令并回退自动探测；单轮「这次跳过测试」豁免）
python3 scripts/setup_auto_router.py --delivery-test-gate on
python3 scripts/setup_auto_router.py --delivery-test-cmd "npm run typecheck && npm test"

# 免费计划获批后的可选只读复核（开关可选：on / off，默认关，最多派 1 次内置只读 research）
python3 scripts/setup_auto_router.py --free-plan-review on

# 极速查套餐 / 完整状态 / 同步安装 / 零漂移校验 / 停用
python3 scripts/setup_auto_router.py --tier --json
python3 scripts/setup_auto_router.py --status
python3 scripts/setup_auto_router.py --install
python3 scripts/setup_auto_router.py --sync-check
python3 scripts/setup_auto_router.py --remove
```

> **面板链接边界**：仅安装引导、调参或要求开面板时附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)`（App `v2.35.1+` 自动弹开侧栏）；**纯查指令对比勿附该链接**。

### 模式 B：日常开发自动调度

**重型路由（Swarm / Workflow）准入三步**：
1. 仅候选任务判断；用户点名运行某项按单次执行（查用法不算点名运行），已有原生命令直接跟随。
2. 确认当前为 Antigravity App 且公开工具/命令含目标能力（如 `run_workflow`）；IDE、未知宿主或未开放时留主会话（勿以磁盘存在内置技能作证）。
3. 主动路由取 `settings.planTier`；未知时仅调一次 `python3 scripts/setup_auto_router.py --tier --json`（只读极速，按返回的 `configRev` 会话内缓存）。仅 `paid` 进主动重型路由，`free`/未知走顺序分批且不亮重型徽标。

| 任务特征 | 调度徽标 / 轨道 | 执行动作 |
| --- | --- | --- |
| 需求模糊、边界未定 | `[agy-cmd → /grill-me 追问]` | `ask_question` 只问阻碍下一步的问题，独立问题可合问，推荐项置顶 `(Recommended)` |
| 改 ≥3 文件、改公共接口或高风险 | `[agy-cmd → /plan 审批]` | 只读定范围（`apply_edits` 按文件计），交 `RequestFeedback: true` 计划；只读拒写时正文交方案等待。多模块获批计划在 App 可接 `/swarm execute our plan`；开「计划获批自动 Boost」按钩子单次派工 |
| 单项独立旁支调查 | Subagents | 主线程有余量时 `invoke_subagent` 派 1 个可用角色，写清范围与证据，主线程核对 |
| ≥5 同质对象同规则检查 | 默认顺序分批；准入后 `[agy-cmd → /run-workflow]` | 纯匹配用本地命令；进 Workflow 先读 `run-workflow`，按菱形骨架（便宜并发 Fan-out→纯代码 Reduce→独立 Verify→单节点 Synthesize）执行，强制首轮 `CAP` 上限、Fan-in 完整性校验（核对 `total/dispatched/returned/remaining`）与超 30～40 项分层汇聚（模板见 [多智能体与 Swarm 模板](references/multi-agent-playbooks.md)）。编码选内置 `self`，只读选内置 `research`（均为 1× 原价，避免自定义/插件 Agent 的 4× 配额倍率）；高精度用 `model="inherit"`（接口靠省略继承则省略） |
| 独立 Lane（多模块写码、多视角只读评审/排障、Best-of-N） | 默认单写手；准入后 `[agy-cmd → 建议 /swarm]` | **负向否决门**：先过假边测试与隐式资源边检查，前后强依赖或紧耦合改动禁止强行并行（留主会话/Orchestrator 或 `/boost`）。准入后先 Pre-flight（接口、`OWNS`/`MUST NOT TOUCH`/`DONE MEANS` 与验证命令），出可复制 `/swarm` 提示词（未点名不私调 `swarm`）。活跃 Swarm 读 `swarm_pane`，6 套模板、三层选模与自检见 [多智能体与 Swarm 模板](references/multi-agent-playbooks.md) |
| 长程 `/goal` 治理或重构（用户点名并授权连续执行） | 跟随原生 `/goal` | `/grill-me`、`/plan` 门禁改为写入待确认清单并继续独立任务；产品决策、破坏性迁移、改外部合同或只读 Plan Mode 仍停下。锁定单仓库范围、独立 worktree 每批 commit、写硬停止条件，模板见 [多智能体与 Swarm 模板](references/multi-agent-playbooks.md) 的「Goal · 长程治理闭环」 |
| 动态网页 / 交互图表 | `[agy-cmd → /browser]` / `[agy-cmd → /generative_ui]` | 委派 `browser`；App 支持时读 `generative_ui` |
| 疑难或反复卡壳（免费 ≥2 次 / 付费 ≥3 次震荡，连败 ≥3 次或跨 ≥2 轮） | 套餐感知自动派工 | 按钩子提示：会员 `[agy-cmd → 自动 Boost]` 派 `DeepInvestigator`（只读/待审）或 `DeepCoder`（已授权），主会话验收、失败接手；免费 `[agy-cmd → 自动换视角排查]` 派内置只读 `research`（1× 原价）。活跃 Swarm 及 Worker 由钩子豁免 |
| 改码/修错后测试未绿 | Stop 自动续跑监工 | 验证未绿自动续跑；问原因、只读探测或等确认自动放行。免费获批计划漏测最多提醒补验 1 次；开交付门禁全套餐改后必测 |

### 模式 C：指令选型参谋（按需读单卡）

- **分流口诀**：日常留主会话（Orchestrator 由 Neon 规划、Hydrogen 执行，遇阻回交）；单项旁支用 Subagent；单点疑难用 `/boost`；独立 Lane 并行或跨模型审 Diff 用 `/swarm`；同质批处理或固化 Swarm 流程用 `/run-workflow`；跨天里程碑审计用 `/teamwork`；需求未清先 `/grill-me`，多文件先 `/plan`（多模块计划可标出并行组与串行依赖）。
- **按需查卡（免整本读取）**：
  - 查指令对比、全量指令速查、远程 SSH / Remote 模式或 CLI 专属边界 → 读 [指令速查矩阵](references/desktop-commands-matrix.md)。
  - 做假边/隐式资源边检查、Gemini 4 三层选模、Swarm 6 套模板、菱形/收敛 `/run-workflow` 工业模板或长程 `/goal` 治理闭环模板 → 读 [多智能体与 Swarm 模板](references/multi-agent-playbooks.md)（免费/未知给普通语言模板）。
