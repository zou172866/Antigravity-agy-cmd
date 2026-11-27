# Antigravity 桌面端与 IDE 指令速查矩阵

用户查询完整指令列表、易混命令差异、远程执行模式或 CLI 专属命令替代方式时读取本卡。多智能体分流、Gemini 4 选模与 Swarm 模板见 [multi-agent-playbooks.md](multi-agent-playbooks.md)。

---

## 一、4 组高频易混指令临界差异

### 1. 动手前规划：`/grill-me` vs `/plan`

| 维度 | `/grill-me` | `/plan` |
| --- | --- | --- |
| **起点** | 想法还在毛坯阶段，输入输出、边界与验收标准未定 | 目标已清楚，涉及多文件、公共接口或高风险改动 |
| **行为** | 每次只问 1 题并附推荐项，连续追问直到消除盲区 | 先只读扫描代码库与依赖，产出可审阅 `Implementation Plan` |
| **切换** | 访谈收口后紧接 `/plan` 出修改清单 | 扫描发现业务规则空白时，退回先跑 `/grill-me` |

### 2. 单会话、委派与五条自治命令

| 能力 | 适用场景 | 支持端 | 套餐门槛 | 免费 / IDE 默认路径 |
| --- | --- | --- | --- | --- |
| 主会话 / Orchestrator | 日常开发默认留主会话；Orchestrator 由规划模型（默认 Neon）只读规划、执行模型（默认 Hydrogen）落地，遇阻（如验证连败 2 次、异常或用户插话）自动回交规划模型 | 普通会话全端；Orchestrator 看当前模型选择器 | 普通会话全套餐；Orchestrator 面向合资格 Pro / Ultra / Enterprise | 沿用当前模型 |
| Subagents（`invoke_subagent`） | 查一条调用链或验一个页面等单项独立旁支，主会话复核 | App、CLI、IDE 扩展、Antigravity IDE | 全套餐 | 用宿主开放角色；不可用留主会话 |
| `/goal` | 单一明确目标持续推进，按测试或产物验收；长程任务在独立 worktree 中每批单独 commit 作回滚点（替代 CLI 专属 `/undo`、`/rewind`），模板见 [multi-agent-playbooks.md](multi-agent-playbooks.md) | App、CLI、IDE 扩展、Antigravity IDE | 全套餐 | 普通会话按同一验收条件推进 |
| `/boost` | 竞态、疑难算法或高耦合故障，需多假设独立挑战与验证 | App、CLI、IDE 扩展、Antigravity IDE | 付费 | 提可反驳假设，用同一复现实验逐项验证 |
| `/swarm` | 可拆成互不撞文件的独立 Lane（多模块写码、多视角只读评审、只读排障、Best-of-N、多模型匿名评议） | App（`v2.30.0+` 侧栏 `Board · Members · Graph`；`v2.33.0+` 含商业/企业账户，受组织策略约束）、CLI（预览） | 全套餐（组织账户受策略约束） | 单写手分模块实施，按需补只读核查 |
| `/run-workflow` | ≥5 个同质对象跑同一检查并交结构化结果，或把高频 Swarm 流程固化为脚本 | App、CLI | 全套餐 | 主会话顺序分批；纯匹配用本地命令 |
| `/teamwork` | 跨天、多里程碑仓库迁移或系统重写，需分阶段独立审计 | App、CLI、IDE 扩展、Antigravity IDE | 付费 | 在实施计划中拆里程碑逐项验收；跨会话用 `PROGRESS.md`、`ADR/`、`TASKS.md`（含待确认项）交接 |

入口以当前客户端实际开放为准。免费安全模式默认抑制 Swarm / Workflow 主动调度以保周配额（单次多成员 Swarm 约耗单会话 4～5 倍配额）；App 支持时用户可手动点名使用，IDE 走上表末列路径。Orchestrator 使用固定推理配置，单会话 effort 覆盖不生效。[模型与账户条件](https://antigravity.google/docs/models#orchestrator) · [Swarm](https://antigravity.google/docs/swarm) · [Dynamic Workflows](https://antigravity.google/docs/dynamic-workflows)

### 3. 定时自动化：`/schedule` vs `/automation`

| 维度 | `/schedule` | `/automation` |
| --- | --- | --- |
| **生命周期** | 绑定当前会话的一次性倒计时或轻量 Cron | 独立后台常驻定时流，关窗仍持续运行 |
| **管理入口** | 会话内后台任务管理 | 桌面端 App 左侧 **Automations** 面板 |
| **支持端** | App / IDE / CLI 通用 | 仅桌面端 App |

### 4. 对话减负：`/btw` vs `/compact`

| 维度 | `/btw` | `/compact` |
| --- | --- | --- |
| **痛点** | 主线推进时临时插问旁支，不愿打断主线或弄脏历史 | 窗口聊了数十轮上下文逼近上限，仍要接着前文干活 |
| **效果** | 侧栏开独立多轮只读页（`v2.32.2+` 可读文件/查库/跑只读命令，`v2.33.0+` 支持一键 `Insert into main conversation`） | 把长对话压缩成高密度摘要，释放上下文空间 |

---

## 二、桌面端与 IDE 其余内置指令速查

输出完整指令表时，按 5 组呈现（第 1 组规划 `/grill-me`·`/plan` 与第 2 组自治 `/goal`·`/boost`·`/swarm`·`/run-workflow`·`/teamwork` 见上方差异表）：

- **旁支工具与可视化**：`/btw`（侧栏只读边问并可插回主对话）、`/compact`（压缩历史释空间）、`/browser`（内置浏览器点击、查询与截图核验）、`/generative_ui`（交互式 HTML 图表与小工具，仅 App）。
- **定时自动化**：`/schedule`（会话内倒计时/Cron）、`/automation`（后台常驻定时流，仅 App）。
- **规则沉淀、插件与帮助**：`/learn`（把人工纠正沉淀为 Rules / Skills）、`/plugin`（打开插件商店或管理插件）、`/agy-customizations`（官方 Rules/Skills/Plugins/Hooks/MCP 编写指南）、`/migrate-agent-settings`（迁移 Claude Code/Cursor/Codex 配置）、`/migrate-workflows`（旧版 Workflow 升级为 `SKILL.md`）、`/antigravity-guide`（查询官方指南）。

---

## 三、远程与后台执行模式对照（`v2.33.0+`）

| 远程模式 | 运行环境 | `agy-cmd` / Sidecar 支持 | 适用场景与限制 |
| --- | --- | --- | --- |
| **Connect over SSH**（App `v2.33.0+`） | 自有 64 位 Linux 远程主机 | **完整支持**：加载远程 `~/.gemini/` 插件与钩子，Sidecar 面板自动经 SSH 转发至本机 App（关窗后远程续跑） | 需远程 Linux 算力/内网/大仓；Linux 宿主机命令优先 `python3` |
| **Remote Control**（App / CLI） | 自有本机或服务器（经 `antigravity.google.com` 远控） | **支持宿主侧钩子**；CLI 无头进程（`agy remote-control start`）无 Sidecar，用 `setup_auto_router.py` 调参 | 离桌手机/浏览器接管本机长任务；要求本机保持开机联网 |
| **Remote Agents**（Pro / Ultra 个人版） | Google 托管隔离云端（挂 GitHub / Drive / 上传目录） | **不支持本机插件与 Sidecar**；默认 `turbo` 执行，不支持 Plan Mode / 本机 MCP | 移动办公、纯仓库后台任务或本机休眠时持续执行 |

---

## 四、桌面端被问及 CLI 专属能力时的应答口径

桌面端聊天框无下列斜杠命令，严禁编造，按对应界面引导：

- **撤回上一步 / 回滚代码**（无 `/undo`、`/rewind`）：点击聊天历史消息旁的回退/编辑按钮，或在代码变更审阅面板（Review Changes）拒绝单文件修改。
- **把当前对话分叉成两路**（无 `/branch`、`/fork`）：新开对话窗口，在输入框敲 `@` 引用刚才的历史对话继续试另一套方案。
- **切思考强度或看剩余额度**（无 `/effort`、`/usage`）：在输入框下方模型选择器切换模型档位，在左侧 **Settings** 面板查看配额。

> 需要多智能体四条分流判据、Gemini 4 三层选模、Swarm 启动自检或可复制提示词模板，读取 [multi-agent-playbooks.md](multi-agent-playbooks.md)。
