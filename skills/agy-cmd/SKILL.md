---
name: agy-cmd
description: Antigravity 桌面端/IDE 高阶能力自动路由与内置斜杠指令参谋。当用户开关全局自动路由、调节自动重试次数或会员/Boost 开关、查询或对比 /grill-me、/plan、/goal、/boost、/run-workflow 等内置指令，或匹配原生工具时使用；禁混入 CLI 专属命令。
---

# agy-cmd：高阶能力自动路由器与内置指令参谋（v2.5.2）

本插件提供四项核心能力：

1. **常驻精简路由规则（`rules/AGENTS.md`）**：轻量任务零打扰；命中高阶路由时在首行输出简短徽标（如 `[agy-cmd → /plan 审批]`），内置只读 Plan Mode 兜底与**免费版默认防报错保护**；
2. **零稳态开销生命周期钩子（`hooks.json`）**：`SessionStart` 一次性安装引导 + `PostToolUse` 真实退出码记账 + `PreInvocation` 套餐感知熔断 + **`Stop` 防停机自动续跑监工**（支持不用重试 / 指定 1..50 次 / 一直重试 + 单句口语覆盖 + 无进展提问防死锁刹车）；
3. **右侧边栏可视化控制面板（`sidecar://agy-cmd/panel/`）**：鼠标一键调节自动重试档位与账号套餐（默认免费安全模式，Pro/Ultra 会员可手动开启 `/boost` 自动接入）；
4. **指令选型与分类速查**。结合任务、宿主和配额偏好给出可复制请求，支持直接在主会话处理或委派。

## 关键不变量

1. **免费安全模式**。默认 `planTier = "free"`、`boostEnabled = false`。`/boost`、`/teamwork` 需要付费权限。`/swarm`、`/run-workflow` 对 App 各套餐开放，多 Worker 会消耗更多配额，插件默认抑制主动推荐和调用。卡壳时优先派当前可用的 `dart-reviewer` 核查根因，否则用只读 `research`，角色均不可用则主会话逐项检验假设。
2. **安装后必提醒手动确认**：每当执行安装/初始化或用户首次询问状态且尚未确认面板配置时，必须提醒用户打开右侧 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 面板手动确认 **① 自动重试次数** 与 **② 是否开启 Boost（Pro/Ultra 会员）自动接入**。
3. **Plan Mode 审批不可绕过**：若只读 Plan Mode 拒绝 `write_file` 写方案产物，必须在正文直接输出精简方案并停止等待确认，严禁调用 `exit_plan_mode` 绕过审批。
4. **轻量任务零打扰**：1～2 文件明确修改、普通问答、本地确定性查找直接执行，**不加徽标、不建计划、不推指令**。
5. **严守桌面端与 IDE 边界**：禁止推荐 CLI 专属指令（`/undo`、`/rewind`、`/branch`、`/fork`、`/clear`、`/new`、`/resume`、`/switch`、`/effort`、`/codesearch`、`/diff`、`/statusline`、`/title`、`/voice`、`/exit`）。

## 工作流程

### 模式 A：调节自动重试次数、切换会员/Boost 档位、启停与自检

用户既可点击 **[agy-cmd 自动路由](sidecar://agy-cmd/panel/)** 在右侧边栏可视化面板直接点选，也可在聊天中直接说口令由你运行内置脚本 [scripts/setup_auto_router.py](scripts/setup_auto_router.py)：

- **调节自动重试模式/次数**（不重试 `off` / 指定次数 `1..50` / 一直重试 `infinite`）：
  ```bash
  python scripts/setup_auto_router.py --auto-retry off
  python scripts/setup_auto_router.py --auto-retry 5
  python scripts/setup_auto_router.py --auto-retry infinite
  ```
- **切换账号套餐与 `/boost` 自动接入**（`free` 默认防报错 / `paid` 开启会员接入）：
  ```bash
  python scripts/setup_auto_router.py --plan-tier free
  python scripts/setup_auto_router.py --plan-tier paid --boost on
  python scripts/setup_auto_router.py --boost off
  ```
- **交付前强制测试门禁（改后必测，全绿交付）**。默认关闭，免费与付费全套餐通用。开启后，只要本轮实质修改了源码，必须在最后一次修改后跑通全量测试（或面板/CLI 手填的自定义验证命令）才放行交付；项目无现成测试且未填自定义命令时，保守放行不改仓库并在交付末尾强制说明缺测项。单轮说 `这次跳过测试` 可临时豁免。
  ```bash
  python scripts/setup_auto_router.py --delivery-test-gate on
  python scripts/setup_auto_router.py --delivery-test-cmd "npm run typecheck && npm test"
  python scripts/setup_auto_router.py --delivery-test-cmd ""
  python scripts/setup_auto_router.py --delivery-test-gate off
  ```
- **免费计划实施后的独立复核**。默认关闭。开启后，主会话实施并验证，每份获批的实施计划最多请一位只读 `cmd-verifier` 复核，会额外消耗配额。付费档沿用原有 Boost 开关。
  ```bash
  python scripts/setup_auto_router.py --free-plan-review on
  python scripts/setup_auto_router.py --free-plan-review off
  ```
- **切换重试触发范围**（`smart` 默认智能无感触发 / `all_failures` 所有失败均触发 / `goal_only` 仅口令触发）：
  ```bash
  python scripts/setup_auto_router.py --retry-scope smart
  ```
- **查看状态 / 安装同步 / 零漂移校验 / 关闭**：
  ```bash
  python scripts/setup_auto_router.py --status
  python scripts/setup_auto_router.py --install
  python scripts/setup_auto_router.py --sync-check
  python scripts/setup_auto_router.py --remove
  ```

安装或修改设置后，顺带附上 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)` 胶囊方便用户随时打开右侧面板微调。

### 模式 B：日常开发任务自动调度

**Swarm / Workflow 的准入判断**

1. 只有候选任务需要判断。用户问区别或查指令时给说明；本轮明确要求运行某一项时才视为单次点选。用户指定模型、单线程或配额上限，按其约束执行。已有原生命令在运行时，直接跟随该任务。
2. 从当前会话的宿主标识（或用户明确说明当前正在 App 中）确认 Antigravity App，并从当前公开的命令或工具清单确认目标能力可用，如 Workflow 对应 `run_workflow`。IDE、宿主未知、组织禁用或无目标能力时，沿用主会话。磁盘上的内置技能与已安装插件可以跨宿主共用，不能证明当前入口可用。
3. App 能力确认后，用户单次点选可直接沿用当前套餐及设置。对于主动路由，从本任务已读取的插件状态取 `settings.planTier`；未知时，仅在此次选型调用一次本技能目录的 `python scripts/setup_auto_router.py --status --json`，读取该字段即可。仅 `paid` 进入主动重型路由；读不到或为 `free` 就顺序分批，不显示重型命令徽标。套餐字段是用户在插件里的偏好。此处只读状态，不修改配置。

| 任务特征 | 调度轨道与徽标 | Agent 立即执行的动作 |
| --- | --- | --- |
| 新功能只有模糊方向，边界未定 | **自动代执行** `[agy-cmd → /grill-me 追问]` | 调用 `ask_question` 每次只问 1 个关键决策问题并置顶 `(Recommended)` 推荐项 |
| 预计改 ≥3 个文件、变更公共接口或涉及高风险 | **自动代执行** `[agy-cmd → /plan 审批]` | 只读确认范围，批量编辑按文件计。提交 `RequestFeedback: true` 的 `Implementation Plan`，获批后再写项目文件（含 `apply_edits`）。只读 Plan Mode 拒写方案时在正文提交并等待确认。会员开启 Boost 后，收到钩子的计划获批指令时直接调度 Boost 执行并验证。 |
| 一项独立的旁支调查 | Subagents | 主线程有可继续做的工作时，通过 `invoke_subagent` 派一个可用角色，写清范围、需回传的路径与证据。主线程据此核对结论。 |
| ≥5 个同质对象依同一规则检查 | 默认顺序分批；准入后用 `[agy-cmd → /run-workflow]` | 纯匹配用本地命令。进入 Workflow 后读当前宿主的 `run-workflow` 技能。每项 Prompt 带目标、输入、规则、验收与 JSON Schema，逐项捕获异常并返回失败项。共享规则长且对象相关时，可按 3～5 项复用多轮 Worker。编码优先选可用的 `dart-coder`，否则选 `self`。高精度使用 `model="inherit"`；若当前接口靠省略模型参数继承，则省略。 |
| 2～4 个模块需协商接口并交叉验收 | 默认单写手；准入后用 `[agy-cmd → /swarm]` | 确认接口、每人的写入范围和验收命令后再派活。每 2～4 个 Worker 配 1 个独立 Verifier，可选时用另一模型；检查 Diff、执行项目验证、保留既有断言。共享配置由同一人修改。非 Git 仓库或 Windows 脏工作区优先单写手。 |
| 动态网页操作或复杂可视化图表 | `[agy-cmd → /browser]` / `[agy-cmd → /generative_ui]` | 按需委派可用的 `browser`。交互图表仅在支持该入口的 App 使用 `generative_ui`。 |
| 明确要求排查竞态、死锁等单点疑难，或同一问题跨 ≥2 轮、修改后仍失败 ≥2 次、连续 ≥3 次命令失败 | **按套餐自动派工** | 会员开启 Boost 后，收到 `[agy-cmd → 自动 Boost]` 即直接派一个 `DeepInvestigator` 只读排查，已授权的修复可派 `DeepCoder`。主会话验证结果，角色不可用时接手。免费档或关闭 Boost 时，卡壳可按 `[agy-cmd → 自动换视角排查]` 调用 `dart-reviewer` 或 `research`。 |
| 日常改代码后命令未过 / 要求修错但测试未绿 | **Stop 自动续跑监工** | 免口令免声明：改过源码后命令失败或要求修错但单测/构建未绿时自动拦截续跑；自然问原因（“为什么挂了/分析报错”）、查看状态、环境探测或等待方案审批时自动识别放行 |

对于免费档已获批的实施计划，只有确认主会话已编辑相关源码、能识别对应检查且缺少改后验证证据时，Stop 才在本次允许的续跑额度内提醒补验，最多一次。若用户在面板开启了「交付前强制测试门禁」，则对所有套餐与所有实质改源码的轮次生效：有自定义验证命令或可识别项目测试时，须在最后一次修改后全部通过才放行；无现成测试时保守放行并要求在回复末尾说明缺测项。

### 模式 C：指令选型参谋与分类速查

1. **按任务选型**。日常留在当前会话；账户已选 Orchestrator 时由其分配规划与执行。单个旁支可派一个 Subagent。单点疑难考虑 Boost；一次横跨独立模块、需协商或互审选 Swarm；同质任务各自返回结构化结果选 Workflow；跨天且需分里程碑审计选 Teamwork。复用已确定的目标、接口和验证方式；需求不清先澄清，涉及多文件按原规则取得计划审批。
2. **用户问“这活怎么跑”**。优先给当前宿主及策略可执行的方式、可复制的带 `@` 请求和验收条件。免费或未知档可直接给普通语言模板。用户点名比较重型能力时，可解释其平台和额度条件。需要具体模板或支持端明细，读取 [选型矩阵](references/desktop-commands-matrix.md)。
