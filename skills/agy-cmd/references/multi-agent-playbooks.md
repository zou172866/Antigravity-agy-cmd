# 多智能体分流、Gemini 4 选模与可复制模板

做多智能体选型、设计 Swarm / Workflow / Boost / Teamwork 提示词、核对 Gemini 4 三层选模或跑 Swarm 启动自检时读取本卡。完整指令速查、远程执行模式与 CLI 边界见 [desktop-commands-matrix.md](desktop-commands-matrix.md)。

---

## 一、四条分流判据（含负向否决门）

1. **先判能否拆出无冲突 Lane**：前后强依赖或紧耦合改动禁止强行并行（多人撞改重叠代码反而拉低成功率）→ 留在主会话 / Orchestrator，单点疑难走 `/boost`。
2. **单点深挖 vs 宽而独立**：单点疑难需独立检验多假设选 `/boost`；多模块或多视角可独立并行（含 3～4 个相似修复用 `@fix-1..N` 编号池）选 `/swarm`。
3. **是否需要互相对话 / 互看 Diff**：Worker 须在留言板协商接口、跨模型审 Diff 或做 Best-of-N / 匿名评议，选 `/swarm`；同质检查各自交 JSON 结果由脚本汇总（或把跑顺的 Swarm 固化复用），选 `/run-workflow`。
4. **单次交付 vs 跨天里程碑**：一次交付可验收走 `/swarm`；跨天分里程碑审计与上下文交接选 `/teamwork`。[官方场景对照](https://antigravity.google/docs/teamwork)

> **共享资源提醒**：目录分开后，共用的 GPU、内存或测试端口仍会撞车；并行实验或集成测试在启动前须先约定资源认领与释放时机。

---

## 二、Gemini 4 三层选模与角色边界

| Swarm 角色 | 推荐模型（按账户可选） | 职责与经济性 |
| --- | --- | --- |
| **Coordinator / Planner** | `Gemini 4 Neon`（经 Orchestrator 运行） | 只拆解、派 brief、判定与汇总，**不亲自改业务代码**；等汇报时零 Token 休眠 |
| **Workers / Executors** | `Gemini 4 Hydrogen` | 并行读写、构建与跑测；单价约 Neon 一半，共享稳定 `AGENTS.md` 前缀享隐式缓存折扣 |
| **Verifier / Auditor** | `Gemini 4 Carbon`（或与 Worker 不同的模型） | 跨模型审 Diff、重跑测试、打回缺证据的 `[done]` 声明，消除自审盲区 |

- **自定义 Subagent `model` 限制**：`.agents/agents/*.md` 的 `model` frontmatter 仅支持档位（`inherit`、`flash`、`pro`），无法直接写死具体模型 ID；要按角色锁模型，在 `/swarm` 中让 Coordinator 指定并在侧栏 `Members` 标签核对。
- **`cmd-verifier` 边界**：本插件内置的 `cmd-verifier` 采用 `model: inherit` + 仅 `read_file`，提供**干净上下文独立复核**（去主会话锚定），尚未跨模型；需要严格跨模型对抗验收优先用 `/swarm` 锁定异构模型。

---

## 三、`@` 上下文挂载高频连招

- **锁死修改范围防乱改**：
  ```text
  /plan 升级 @目标目录/ 下的组件支持新功能，先出修改方案
  ```
- **直接喂终端报错修到全绿**：
  ```text
  /goal 根据 @终端 里的最新报错修复构建问题，直到编译与测试全部通过
  ```
- **跨会话继承上次结论**：
  ```text
  /plan 参考 @历史会话 里敲定的数据结构，完成剩余接口实现
  ```

---

## 四、后台委派与多智能体提示词模板

把示例中的路径、复现命令和指标换成当前项目真实值。生成付费或并发命令前先过技能准入判断；用户主动查看用法时直接展示适用条件与示例。

**Subagents · 单项只读调查**

```text
请派一个可用的只读 research 子智能体，追踪 @src/cache/ 中缓存失效通知从哪里发出、哪些调用方接收。回报文件、行号和触发条件；主会话核对调用点并汇总。
```

**Boost · 单个可复现的疑难故障（付费）**

```text
/boost @src/queue/ 在两个消费者同时取消时偶发重复投递。复现命令是 go test -race ./queue -run TestConcurrentCancel -count=50。找出竞态，保留既有断言，修复后重跑同一命令并回报结果。
```

**Swarm 1 · 审批后并行实施（`/grill-me → /plan → /swarm` 连招，App）**

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

**Swarm 3 · 多视角只读评审团（Team of Reviewers，零写冲突，Windows 脏工作区适用）**

```text
/swarm 用四位只读评审员并行审阅当前分支：@ux、@simplicity、@edge-cases、@security。每人严禁改文件，发现的问题必须附仓库相对路径和 1-based 行号，完成后 @verifier [done]（未阻塞勿 @coordinator）。@verifier 逐条交叉核验路径、行号与事实后汇总给 Coordinator；确认后再派单名写手修复，并由新评审复核直到全部通过（评审模型与写手不同）。
```

**Swarm 4 · 并行只读排障（Read-Only First，新仓库首次用 Swarm 推荐）**

```text
/swarm 排查我们的 CLI 启动耗时 4 秒的原因。派三位只读调查员分别检查模块导入、配置加载和插件发现，严禁修改任何文件；每条结论附仓库相对路径、1-based 行号和实测命令输出，完成后 @verifier [done] 交叉核验，最后由 Coordinator 在留言板输出按收益排序的修复清单。
```

**Swarm 5 · 同题多解择优（Best of N，须有确定性测试 / 基准）**

```text
/swarm 创建 @try-1 到 @try-4 四名 Worker，各自在独立 working copy 中优化 @src/search/rank.ts 且不得改变其公共 API。每轮改动都跑 npm run bench 和 npm test，把真实命令输出与耗时表发给 @verifier [done]（未阻塞勿 @coordinator）。@verifier 复跑确认无删改断言且全绿，Coordinator 仅保留最快且通过的版本。
```

**Swarm 6 · 多模型匿名评审团（Council of Models，无自动测试的架构 / UI 选型）**

```text
/swarm 请 @design-neon（Gemini 4 Neon）、@design-carbon（Gemini 4 Carbon）和 @design-opus（Claude Opus 5.5）分别给出新设置页的独立设计方案（严格只读）。再派三位新裁判在隐藏模型名的前提下逐项打分，最后合并最强思路输出一份规格说明并停下。
```

**Workflow · 同质对象独立交回结果（App）**

```text
/run-workflow 对照 @docs/package-rules.md 逐包检查 @packages/。每个 agent 的任务书都给出包路径、适用规则和判据，用 JSON Schema 要求返回包名、pass/fail/error 及证据。逐项捕获异常并记录失败包，保留其他结果；最后输出统计和待复查清单。
```

**Teamwork · 多个里程碑分别验收（付费）**

```text
/teamwork 将 @services/ 的订单接口迁移到新框架。先在范围访谈中确定迁移包清单、兼容性契约和验收指标。逐包验证契约测试全过，随后在同一数据集上比较 P95 延迟，增幅不得超过 5%。本次允许复用框架，采用 development 完整性模式；提交目标与验收产物供我审批后再实施。
```

Teamwork 范围访谈按允许范围选完整性模式：日常工程用 `development`，可复现演示用 `demo`，限定标准库从零评测用 `benchmark`。[完整性模式](https://antigravity.google/docs/teamwork#integrity-modes)

**免费默认或 IDE · 主会话顺序分批**

```text
对照 @docs/package-rules.md 顺序检查 @packages/ 中每个包，分别记录包名、通过或失败、依据。遇到读不到的包，记下原因并继续，最后汇总待复查项。
```

---

## 五、Swarm 启动前自检清单（Pre-launch Checklist）

- [ ] **无冲突 Lane**：无共享核心文件、无前后强依赖；拆不开就留在主会话 / Orchestrator 或走 `/boost`。
- [ ] **确定性验收**：验收条件写成明确命令或可观测指标（如 `npm test`、`go test -race ./...`、`0 console errors`）。
- [ ] **三层选模**：Coordinator 用 Orchestrator（Neon）、Worker 用 Hydrogen、`@verifier` 换另一模型（如 Carbon）。
- [ ] **硬证据与省配额路由**：要求仓库相对路径 + 1-based 行号、禁删断言；Worker 完工发 `@verifier [done]`，未阻塞勿 `@coordinator`。
- [ ] **写入隔离**：重叠写入或构建各开独立 working copy（git worktree），合并落地后再 `kill`。
- [ ] **配额与切模**：确认账号余量撑得住单会话 4～5 倍消耗，保持 `AGENTS.md` 稳定以利前缀缓存；成员遇 `quota out` 暂停时直接用 `swarm(action:"model")` 切模型续跑，别 `kill` 重建。
