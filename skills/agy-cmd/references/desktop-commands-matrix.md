# Antigravity 桌面端与 IDE 通用指令深度辨析与速查矩阵

当用户要求查看完整指令速查表、深入对比某一组易混指令，或任务处于多智能体选型模糊地带时读取本文件。

---

## 一、4 组高频易混指令临界差异表

### 1. 动手前规划组：`/grill-me` vs `/plan`

| 对比维度 | `/grill-me` | `/plan` |
| --- | --- | --- |
| **适用起点** | 想法尚处于毛坯阶段，连输入输出、评判标准、边缘情况都没定 | 做什么已经清楚，但涉及多文件、架构变动或高风险修改 |
| **触发后行为** | 每次只问你 1 个问题并附带推荐选项，持续追问直到消灭盲区 | 先只读扫描代码库与依赖，必要时少量提问，产出可审阅的 `Implementation Plan` 产物 |
| **何时切换** | 访谈完需求清晰后，可紧接 `/plan` 生成具体代码修改清单 | 若 `/plan` 扫描时发现核心业务规则全空，应退回先跑 `/grill-me` |

### 2. 单会话、后台委派和五条自治命令

| 能力 | 适用场景 | 支持端 | 平台套餐 | 默认或低配额路径 |
| --- | --- | --- | --- | --- |
| 当前会话 / Orchestrator 模型选项 | 日常开发留在主会话。已选 Orchestrator 时由规划模型（默认 Neon）先只读规划，执行模型（默认 Hydrogen）落地，遇阻（如验证失败 2 次、API 异常、checkpoint 或用户插话）自动交回规划模型修补 | 普通会话各端；Orchestrator 查询当前模型选择器 | 普通会话全套餐；Orchestrator 见下方说明 | 沿用用户当前模型 |
| Subagents（`invoke_subagent`） | 将一条调用链、一次 UI 核验等独立旁支交给一个角色，由主会话复核 | App、CLI、IDE 扩展、Antigravity IDE | 全套餐 | 用宿主列出的角色；不可用则主会话完成 |
| `/goal` | 一个明确目标持续实施，按测试或产物判断完成 | App、CLI、IDE 扩展、Antigravity IDE | 全套餐 | 普通会话按同一验收条件推进 |
| `/boost` | 一个竞态、疑难算法或高耦合故障，需多轮独立挑战和验证 | App、CLI、IDE 扩展、Antigravity IDE | 付费 | 提出可反驳的根因假设，用同一复现实验验证 |
| `/swarm` | 可拆成互不碰撞独立 Lane 的任务（多模块并行写码、多视角只读评审、并行只读排障、Best-of-N 择优、多模型匿名评议） | App（`v2.30.0+` 侧边栏 `Board · Members · Graph`）、CLI（`/swarm board` / `Alt+S`，预览） | 全套餐；组织账户受管理员设置约束 | 单写手分模块实现，必要时另派只读核查 |
| `/run-workflow` | 多个同质对象各做同一项检查，或脚本按固定先后顺序处理，各项返回结构化结果；高频复跑的 Swarm 流程也可升格沉淀为脚本 | App、CLI | 全套餐 | 主会话按相同格式分批检查，确定性规则用本地命令 |
| `/teamwork` | 跨天、多里程碑的仓库迁移或系统重写，需要逐阶段独立审计 | App、CLI、IDE 扩展、Antigravity IDE | 付费 | 在实施计划中列出里程碑，逐项验证 |

具体入口以当前客户端开放的命令/工具为准。免费安全模式默认节省 Swarm / Workflow 的多 Worker 配额（一次多成员 Swarm 通常消耗单会话 4～5 倍配额）。在支持的 App 中，用户可明确选择本次使用；IDE 直接采用表中最后一列的对应方式。Orchestrator 是模型选择器提供的单会话双模型双向循环选项，面向符合条件的 Pro、Ultra 和 Gemini Enterprise 账户（官方基准较单用 Carbon 省约 24% 配额、提速约 19%；运行固定推理配置，单会话 effort 覆盖不生效；Gemini Enterprise 固定为 `Carbon High + Hydrogen High`）。[模型与账户条件](https://antigravity.google/docs/models#orchestrator) · [Swarm](https://antigravity.google/docs/swarm) · [Dynamic Workflows](https://antigravity.google/docs/dynamic-workflows)

**四条分流判断（含负向否决门）**

1. **先判可否拆成独立 Lane**：前后步骤强依赖或紧耦合改动，强行并行反而大幅降质（研究测得可下降 39%～70%，两人改重叠代码成功率降约 30%）→ 留在主会话 / Orchestrator，或单点疑难走 `/boost`。
2. **单点深度 vs 宽而独立**：单点疑难、需独立检验多假设选 `/boost`；多文件/多视角可拆分并行（含 3～4 个相似修复用 `@fix-1..N` 编号池）选 `/swarm`。
3. **是否需要互相对话/互看 Diff**：Worker 需共享留言板协商接口、跨模型审 Diff 或做 Best-of-N/匿名评议，选 `/swarm`；同质检查各自独立交 JSON 结果给脚本归集（或把跑顺的 Swarm 固化复用），选 `/run-workflow`。
4. **单次交付 vs 跨天里程碑**：一次交付可验收走 `/swarm`；跨天分里程碑审计与上下文交接选 `/teamwork`。[官方场景对照](https://antigravity.google/docs/teamwork)

**Gemini 4 三层选模与自定义角色边界**

| Swarm 角色 | 推荐模型（以账户可选为准） | 职责与经济性说明 |
| --- | --- | --- |
| **Coordinator / Planner** | `Gemini 4 Neon`（通过 Orchestrator 运行） | 只做拆解、派 brief、判定与汇总，**不亲自改业务代码**；等待汇报时零 Token 休眠 |
| **Workers / Executors** | `Gemini 4 Hydrogen` | 并行读写、构建与跑测；价格约 Neon 一半，共享稳定 `AGENTS.md` 前缀可享 95% 隐式缓存读取折扣 |
| **Verifier / Auditor** | `Gemini 4 Carbon`（或其他与 Worker 不同的模型） | 跨模型独立审 Diff、重跑测试、打回不实 `[done]` 声明；避免模型自审偏袒盲区 |

- **自定义 Subagent `model` 字段限制**：`.agents/agents/*.md` 的 `model` frontmatter 仅支持档位（`inherit`、`flash`、`pro`），无法直接写死 `gemini-4-neon` / `gemini-4-carbon` 等模型 ID；要按角色锁定具体模型，请在 `/swarm` 中让 Coordinator 指定并在侧边栏 `Members` 标签核对。
- **`cmd-verifier` 能力边界**：本插件内置的 `cmd-verifier` 使用 `model: inherit` + 仅 `read_file` 工具，提供的是**干净上下文独立复核**（消除主会话锚定），尚未跨模型；需要严格跨模型对抗验收时优先走 `/swarm` pin 不同模型。

一位使用 Swarm 跑并行实验的开发者让 Worker 在留言板上认领 GPU、CPU 和内存。即使写入目录分开，共用的 GPU 或测试端口也可能让任务互相干扰。这类任务在启动前就应约定资源归属和释放时机。[开发者实践记录](https://www.reddit.com/r/google_antigravity/comments/1y1yf8u/swarm_is_great_use_it/)

### 3. 定时自动化组：`/schedule` vs `/automation`

| 对比维度 | `/schedule` | `/automation` |
| --- | --- | --- |
| **生命周期** | 绑定当前会话任务的临时倒计时（如 20 分钟后看渲染结果）或轻量 Cron | 独立的后台常驻定时工作流（如每天早 9 点汇总数据），关闭当前聊天仍可管理 |
| **管理入口** | 会话内后台任务管理 | 桌面端 App 左侧 **Automations** 专属面板 |
| **平台支持** | 桌面端 App / IDE / CLI 通用 | 仅桌面端 App |

### 4. 对话减负组：`/btw` vs `/compact`

| 对比维度 | `/btw` | `/compact` |
| --- | --- | --- |
| **解决痛点** | 主线正在干活，临时想插嘴问个旁支问题，怕带偏主线或弄脏历史 | 同一个窗口已经聊了几十轮，上下文快满变慢，但还要接着前文继续干 |
| **实际效果** | 在只读副本分支秒回，主对话零感知、零新增历史记录 | 将前文长对话压缩总结为高密度摘要，腾出大量上下文窗口 |

---

## 二、插件涉及的桌面端与 IDE 指令

输出完整速查表时，按以下 5 大功能组呈现：

1. **需求与规划**
   - `/grill-me`：一问一答附带推荐选项，帮模糊想法补齐边界条件
   - `/plan`：只读调研代码库，生成可审阅实施方案（`Implementation Plan`）获批后再改代码
2. **自治与多智能体**
   - `/goal`：单目标无人值守持续执行与自修错，直到验收通过
   - `/boost`：多智能体多假设深度推演与独立验证，攻坚疑难 Bug 与复杂算法（付费计划）
   - `/swarm`：具名 Worker 与 Verifier 在共享留言板上分工、讨论和验收（App、CLI；全套餐）
   - `/run-workflow`：Python 脚本用 `parallel()` / `pipeline()` 处理独立项或固定管线（App、CLI；全套餐）
   - `/teamwork`：多角色长周期工程团队，适合仓库级重构与迁移（付费计划）
3. **旁支工具与可视化**
   - `/btw`：在只读分支顺便问旁支问题，不打断主线、不污染上下文
   - `/compact`：压缩总结长对话历史，释放上下文窗口空间
   - `/browser`：启动内置浏览器子智能体，执行真实网页点击、查询与 UI 截图核验
   - `/generative_ui`：生成内嵌或独立交互式 HTML 图表、流程图与可视化小工具（仅桌面端 App）
4. **定时与常驻自动化**
   - `/schedule`：设置一次性倒计时或周期性 Cron 唤醒任务
   - `/automation`：交互式配置后台常驻定时自动化，在 Automations 面板管理（仅桌面端 App）
5. **规则沉淀、插件与官方帮助**
   - `/learn`：把会话中的人工纠正与偏好提炼保存为持久化 Rules 或 Skills
   - `/plugin`：打开 Plugins Manager 插件商店，或管理、创建插件包
   - `/agy-customizations`：加载官方自定义规范手册，指导编写 Rules、Skills、Plugins、Hooks 与 MCP 配置
   - `/migrate-agent-settings`：将 Claude Code、Cursor、Codex 等外部 Agent 配置迁移为 Antigravity 插件
   - `/migrate-workflows`：扫描旧版 Workflow 文件并自动升级为现代 `SKILL.md` 格式
   - `/antigravity-guide`：查询 Antigravity 官方文档与功能指南

---

## 三、`@` 上下文挂载高频连招模板

生成可复制命令时，优先结合以下 `@` 语法减少用户手动粘贴成本：

- **锁死修改范围防乱改**：
  ```text
  /plan 升级 @目标目录/ 下的组件支持新功能，先出修改方案
  ```
- **直接喂终端报错死磕到底**：
  ```text
  /goal 根据 @终端 里的最新报错修复构建问题，直到编译与测试全部通过
  ```
- **跨会话继承上次结论**：
  ```text
  /plan 参考 @历史会话 里敲定的数据结构，完成剩余接口实现
  ```

### 后台委派与四条多智能体指令模板

把示例中的路径、复现步骤、命令和指标替换为该项目真实可用的值。生成付费命令或 App 并发命令前，先按技能的准入判断选择模板。用户明确要求查看用法时可展示适用条件和示例。

**Subagents · 单项只读调查**

```text
请派一个可用的只读 research 子智能体，追踪 @src/cache/ 中缓存失效通知从哪里发出、哪些调用方接收。回报文件、行号和触发条件；主会话核对调用点并汇总。
```

**Boost · 单个可复现的疑难故障（付费）**

```text
/boost @src/queue/ 在两个消费者同时取消时偶发重复投递。复现命令是 go test -race ./queue -run TestConcurrentCancel -count=50。找出竞态，保留既有断言，修复后重跑同一命令并回报结果。
```

**Swarm 1 · 审批后并行实施（`/grill-me → /plan → /swarm` 官方连招，App）**

```text
# 第 1 步：澄清需求并产出可审阅 Implementation Plan
/grill-me 为 <功能名称> 补齐边界并生成 Implementation Plan

# 第 2 步：审核批准计划后，直接交由 Swarm 按模块并行落地
/swarm execute our plan
```

**Swarm 2 · 多模块并行写码 + worktree 隔离 + 跨模型验收（App）**

```text
/swarm 按 @docs/retry-contract.md 给 @src/http/ 和 @src/webhooks/ 增加退避重试。Coordinator 只负责拆分、派单和汇总，不亲自改业务代码；每个目录由一名 Worker 独占（重叠构建时各开独立 working copy / worktree，合并后再清理），公共配置交同一人串行改。每条 brief 写清 OWNS / MUST NOT TOUCH / DONE MEANS，完工发 @verifier [done] 并附仓库相对路径与 1-based 行号（未阻塞勿 @coordinator）。@verifier 使用与 Worker 不同的模型审 Diff、禁止删减既有断言并实跑 npm test，无真实命令输出一律打回。
```

**Swarm 3 · 多视角只读评审团（Team of Reviewers，零写冲突，Windows 脏工作区也适用）**

```text
/swarm 用四位只读评审员并行审阅当前分支：@ux、@simplicity、@edge-cases、@security。每人严禁改文件，发现的问题必须附仓库相对路径和 1-based 行号，完成后 @verifier [done]（未阻塞勿 @coordinator）。@verifier 逐条交叉核验路径、行号与事实后汇总给 Coordinator；确认后再派单名写手修复，并由新评审复核直到全部通过（评审模型与写手不同）。
```

**Swarm 4 · 并行只读排障（Read-Only First，新仓库首次用 Swarm 推荐）**

```text
/swarm 排查我们的 CLI 启动耗时 4 秒的原因。派三位只读调查员分别检查模块导入、配置加载和插件发现，严禁修改任何文件；每条结论附仓库相对路径、1-based 行号和实测命令输出，完成后 @verifier [done] 交叉核验，最后由 Coordinator 在留言板输出按收益排序的修复清单。
```

**Swarm 5 · 同题多解择优（Best of N，须有确定性测试/基准）**

```text
/swarm 创建 @try-1 到 @try-4 四名 Worker，各自在独立 working copy 中优化 @src/search/rank.ts 且不得改变其公共 API。每轮改动都跑 npm run bench 和 npm test，把真实命令输出与耗时表发给 @verifier [done]（未阻塞勿 @coordinator）。@verifier 复跑确认无删改断言且全绿，Coordinator 仅保留最快且通过的版本。
```

**Swarm 6 · 多模型匿名评审团（Council of Models，无自动测试的架构/UI 选型）**

```text
/swarm 请 @design-neon（Gemini 4 Neon）、@design-carbon（Gemini 4 Carbon）和 @design-opus（Claude Opus 5.5）分别给出新设置页的独立设计方案（严格只读）。再派三位新裁判在隐藏模型名的前提下逐项打分，最后合并最强思路输出一份规格说明并停下。
```

**Swarm 启动前自检清单（Pre-launch Checklist）**

- [ ] **能否拆成无冲突 Lane**（无共享核心文件、非前后强依赖）？不能则留在主会话 / Orchestrator 或 `/boost`。
- [ ] **验收标准是否写成确定性命令或可观测条件**（如 `npm test`、`go test -race ./...`、`0 console errors`）？
- [ ] **三层选模是否到位**：Coordinator 用 Orchestrator（Neon）、Worker 用 Hydrogen、`@verifier` 换另一模型（如 Carbon）？
- [ ] **是否约束硬证据与省配额路由**：要求仓库相对路径 + 1-based 行号、禁删断言、Worker 完工 `@verifier [done]` 且未阻塞不 `@coordinator`？
- [ ] **并发写入是否隔离**：重叠写入/构建分配独立 working copy（git worktree），并明确“合并落地后再 `kill`”？
- [ ] **配额与缓存准备**：账号余量足够支撑单会话 4～5 倍消耗；`AGENTS.md` 稳定以利前缀缓存；遇到某成员 `quota out` 暂停时用 `swarm(action:"model")` 切模型续跑，而非 `kill` 重建。

**Workflow · 同质对象独立交回结果（App）**

```text
/run-workflow 对照 @docs/package-rules.md 逐包检查 @packages/。每个 agent 的任务书都给出包路径、适用规则和判据，用 JSON Schema 要求返回包名、pass/fail/error 及证据。逐项捕获异常并记录失败包，保留其他结果；最后输出统计和待复查清单。
```

**Teamwork · 多个里程碑分别验收（付费）**

```text
/teamwork 将 @services/ 的订单接口迁移到新框架。先在范围访谈中确定迁移包清单、兼容性契约和验收指标。逐包验证契约测试全过，随后在同一数据集上比较 P95 延迟，增幅不得超过 5%。本次允许复用框架，采用 development 完整性模式；提交目标与验收产物供我审批后再实施。
```

Teamwork 在范围访谈中按用户允许的做法选完整性模式。日常工程可用 `development`；可复现演示可用 `demo`；限定标准库、独立从零实现的评测可用 `benchmark`。[完整性模式](https://antigravity.google/docs/teamwork#integrity-modes)

**免费默认或 IDE · 主会话顺序分批**

```text
对照 @docs/package-rules.md 顺序检查 @packages/ 中每个包，分别记录包名、通过或失败、依据。遇到读不到的包，记下原因并继续，最后汇总待复查项。
```

---

## 四、桌面端被问及 CLI 专属能力时的标准应答口径

用户若在桌面端询问以下操作，严禁编造斜杠指令，统一按右侧方式引导：

- **“怎么敲指令撤回上一步 / 回滚代码？”**：桌面端聊天框没有 `/undo` 或 `/rewind` 斜杠指令；请直接点击聊天记录中历史消息旁的回退/编辑按钮，或在代码变更审阅面板（Review Changes）中拒绝单文件修改。
- **“怎么敲指令把当前对话分叉成两个？”**：桌面端聊天框没有 `/branch` 或 `/fork` 斜杠指令；可新开一个对话窗口，在输入框敲 `@` 引用刚才那条历史对话继续尝试另一套方案。
- **“怎么敲指令切思考强度或看剩余额度？”**：桌面端无 `/effort` 或 `/usage` 斜杠指令；请直接在输入框下方的模型选择器或左侧 **Settings** 面板切换模型档位与查看账户配额。
