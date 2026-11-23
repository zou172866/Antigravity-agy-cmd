---
name: agy-cmd
description: Antigravity 桌面端/IDE 高阶能力自动路由与内置斜杠指令参谋。当用户开关全局自动路由、调节自动重试次数或会员/Boost 开关、查询或对比 /grill-me、/plan、/goal、/boost、/run-workflow 等内置指令，或匹配原生工具时使用；禁混入 CLI 专属命令。
---

# agy-cmd：高阶能力自动路由器与内置指令参谋（v2.1）

本插件提供四项核心能力：

1. **常驻精简路由规则（`rules/AGENTS.md`）**：轻量任务零打扰；命中高阶路由时在首行输出简短徽标（如 `[agy-cmd → /plan 审批]`），内置只读 Plan Mode 兜底与**免费版默认防报错保护**；
2. **零稳态开销生命周期钩子（`hooks.json`）**：`SessionStart` 一次性安装引导 + `PostToolUse` 真实退出码记账 + `PreInvocation` 套餐感知熔断 + **`Stop` 防停机自动续跑监工**（支持不用重试 / 指定 1..50 次 / 一直重试 + 单句口语覆盖 + 无进展提问防死锁刹车）；
3. **右侧边栏可视化控制面板（`sidecar://agy-cmd/panel/`）**：鼠标一键调节自动重试档位与账号套餐（默认免费安全模式，Pro/Ultra 会员可手动开启 `/boost` 自动接入）；
4. **极简指令选型参谋与分类速查**：零反问直接交付带 `@` 挂载的可复制命令块与近邻排他理由（含免费号平替方案）。

## 关键不变量

1. **默认免费版防报错**：初始默认 `planTier = "free"`、`boostEnabled = false`，自动屏蔽 `/boost`、`/swarm`、`/teamwork` 口令推销以防非会员触发权限报错，卡壳时优先派可用的 `dart-reviewer`，否则派内置只读 `research` 子智能体换视角重查；仅当用户在右侧面板或 CLI 手动开启会员 Boost 接入后才推 `/boost`。
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

| 任务特征 | 调度轨道与徽标 | Agent 立即执行的动作 |
| --- | --- | --- |
| 新功能只有模糊方向，边界未定 | **自动代执行** `[agy-cmd → /grill-me 追问]` | 调用 `ask_question` 每次只问 1 个关键决策问题并置顶 `(Recommended)` 推荐项 |
| 改动 ≥3 个文件或调整核心架构 | **自动代执行** `[agy-cmd → /plan 审批]` | 先只读扫描，创建 `RequestFeedback: true` 的 `Implementation Plan` 获批再改；只读 Plan Mode 拒写时正文输出方案并停下等确认 |
| ≥5 个对象需语义批处理 | **自动代执行** `[agy-cmd → /run-workflow]` | 读 `run-workflow` 编写并发脚本（`model="inherit"`，3～5 项复用多轮 Worker（编码优先选可用的 `dart-coder`，否则选 `self`）；套餐受限时降级分批顺序执行） |
| 动态网页操作或复杂可视化图表 | **自动代执行** `[agy-cmd → /browser]` / `[agy-cmd → /generative_ui]` | 委派 `browser` 子智能体或读取 `generative_ui` |
| 反复修错未果 / 修改↔失败震荡 ≥2 次 / 连续 ≥3 次命令失败 | **套餐感知兜底** | **默认免费版**：输出 `[agy-cmd → 自动换视角排查]`，优先派可用的 `dart-reviewer`，否则派只读 `research` 子智能体独立查根因（禁推 `/boost` 防报错）；**已开启会员 Boost**：输出 `[agy-cmd → 建议 /boost]` + 可复制口令 |
| 日常改代码后命令未过 / 要求修错但测试未绿 | **Stop 自动续跑监工** | 免口令免声明：改过源码后命令失败或要求修错但单测/构建未绿时自动拦截续跑；自然问原因（“为什么挂了/分析报错”）、查看状态、环境探测或等待方案审批时自动识别放行 |

### 模式 C：指令选型参谋与分类速查

1. **选型处方（用户问“这活该敲什么指令”）**：按 **「首选指令（标明套餐要求）→ 带 `@` 挂载的可复制代码块 → 1 句触发效果 → 1 句近邻排他理由 + 免费号平替」** 在 150 字内交付。
2. **分类速查或深度辨析**：先读取 [references/desktop-commands-matrix.md](references/desktop-commands-matrix.md)，再输出结构化对照表。
