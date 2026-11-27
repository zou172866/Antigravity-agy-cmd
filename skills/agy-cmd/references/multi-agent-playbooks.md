# 多智能体分流、Gemini 4 选模与可复制模板

做多智能体选型、设计 Swarm / Workflow / Boost / Teamwork 提示词、核对 Gemini 4 三层选模或跑 Swarm 启动自检时读取本卡。完整指令速查、远程执行模式与 CLI 边界见 [desktop-commands-matrix.md](desktop-commands-matrix.md)。

---

## 一、拆并行前两步机械判据与四条分流

动手拆并行前，先按以下两步机械核对，过不了直接留单会话：

- **机械判据 1 · 数据假边测试**：步骤 B 是否必须读取步骤 A 的输出？若整条链路都是真数据依赖，直接走单会话 / Loop / `/boost`，不硬拆并行。
- **机械判据 2 · 隐式资源边检查**：两段 Prompt 表面互不相干，但会写同一文件、共享配置/锁、抢同一测试端口、共用 GPU/内存或撞同一限流 API 吗？只要共享可变资源就存在隐式边，必须隔离独立 worktree / 端口，或加边串行。

过关后再按四条分流（含负向否决门）：

1. **先判能否拆出无冲突 Lane**：前后强依赖或紧耦合改动禁止强行并行（多人撞改重叠代码反而拉低成功率）→ 留在主会话 / Orchestrator，单点疑难走 `/boost`。
2. **单点深挖 vs 宽而独立**：单点疑难需独立检验多假设选 `/boost`；多模块或多视角可独立并行（含 3～4 个相似修复用 `@fix-1..N` 编号池）选 `/swarm`。
3. **是否需要互相对话 / 互看 Diff**：Worker 须在留言板协商接口、跨模型审 Diff 或做 Best-of-N / 匿名评议，选 `/swarm`；同质检查各自交 JSON 结果由脚本汇总（或把跑顺的 Swarm 固化复用），选 `/run-workflow`。
4. **单次交付 vs 跨天里程碑**：一次交付可验收走 `/swarm`；跨天分里程碑审计与上下文交接选 `/teamwork`。[官方场景对照](https://antigravity.google/docs/teamwork)

> **`/plan` 衔接提示**：`/plan` 产出多模块实施计划时，建议直接标出**可并行任务组**与**串行依赖**，获批后可无缝衔接 `/swarm execute our plan`。

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

**Workflow 1 · 菱形工业模板（Diamond：已知规模批量检查 / 迁移，App）**

标准四段骨架：`Fan-out`（便宜模型并发）→ `Reduce`（纯 Python 代码去重与计数，0 Token）→ `Verify`（独立洁净上下文强模型挑刺）→ `Synthesize`（单节点汇总）。三条防爆硬护栏：
- **首轮 `CAP` 硬上限**：首轮强制限 `<= 20` 项且设总 Agent 硬上限，看清实际耗时与配额再放量。
- **Fan-in Guard（完整性守卫）**：Reduce 脚本核对 `total / dispatched / returned / missing / failed / remaining` 六项计数（例如 41 项目标首轮仅派发 20 项全回传时，仍须显式标明 `dispatched: 20/41`、`remaining: 21`），报告顶部显式列出 `missing / failed / remaining` 清单，严禁拿残缺集或首批截断集当全量报告交付。
- **分层汇聚（Layered Fan-in）**：扇出超过 `30～40` 项时，先按 `15～20` 项分批做中间摘要，再进最终单节点汇总，防止上下文坍塌。

```text
/run-workflow 对照 @docs/package-rules.md 批量检查 @packages/，按四段菱形骨架执行：
1. Fan-out（CAP 硬上限）：先统计全量目标总数 total（例如 41 项），首轮仅派发前 20 项（dispatched=20，remaining=total-dispatched，设总 Agent 上限 25），用便宜模型并发跑每项任务书（含路径、规则、判据与严格 JSON Schema：item/status/issues/evidence），逐项 try/except 捕获超时与异常。
2. Reduce（纯 Python，0 Token）：按 item 去重合并，核对 total / dispatched / returned / missing / failed / remaining，分离 passed / failed / missing / remaining 清单，禁止跳过失败项或把首批 20/20 误报为全量完成。若有效结果超过 35 项，先每 15～20 项分组做中间摘要（Layered Fan-in）。
3. Verify（洁净上下文强模型）：把高危/失败项的相对路径、Diff 或代码证据交给独立强模型核查假阳性（不传前序推理过程）。
4. Synthesize（单节点汇总）：顶部显式给出 total / dispatched / returned / missing / failed / remaining 计数与未完成/待派发清单，再输出分级整改表。
```

**Workflow 2 · 未知规模猎错 / 重构收敛模板（App）**

适合“不知道全库还有多少同类缺陷/技术债”的场景，靠纯代码历史去重与双停机条件防死循环烧额：

```text
/run-workflow 在 @src/ 开展未知规模缺陷猎杀（设总 Agent 硬上限 30、单轮批次上限 15）：
1. 并行发现：每轮用便宜模型分片扫描未覆盖区域，按 JSON Schema 返回 (file, line, rule_id, snippet)。
2. 历史去重（纯 Python，0 Token）：按 (file, line, rule_id) 签名过滤历轮已记录项，仅保留本轮净新增候选。
3. 独立校验：将本轮净新增候选及对应代码片段交给独立洁净上下文强模型复核，剔除假阳性并产出可复现证据。
4. 自动停机：连续 2 轮验证后净新增为 0 或触及总 Agent 硬上限立即停机，由单节点汇总去重后的最终修复清单（顶部标明覆盖率与未扫/失败分片）。
```

**Goal · 长程治理闭环（全套餐，单会话）**

适合降架构熵、统一重复实现、解耦模块这类跨多轮推进的目标。四个要点：锁定单仓库范围、每轮必须闭环、待确认不阻塞、写死硬性停止条件。

```text
/goal 在 <仓库路径> 的独立 worktree（分支 <name>）中降低架构熵。
范围：只改 <目录>；禁区：<公共 API / 数据格式 / 外部合同>。
每轮闭环：扫描 → 选复杂度最低的方案 → 补行为基线测试 → 迁移全部调用方 → 删除旧实现 → 跑 <验证命令> → 加防回归检查（lint / AST / 契约测试）→ 独立 commit → 更新 PROGRESS.md、ADR/、TASKS.md。
遇产品决策、破坏性迁移或改外部合同：记入 TASKS.md「待确认」，跳过并继续其他独立任务，无需逐轮询问。
停止：<N> 轮 / <时长> / 连续 2 轮无可安全落地项 / 验证连败 3 次。
验收：<可机器检查的指标，如无循环依赖、新增 lint 规则通过、测试全绿>。
```

- **范围红线**：多项目工作区根目录禁止直接跑，先锁定单仓库或单目录。
- **额度护栏**：自动重试设为 `infinite` 时必须写硬停止条件，防止空转烧额度。
- **回滚点**：每批独立 commit，代替 CLI 专属的 `/undo`、`/rewind`；出问题直接 `git revert` 该批。
- **付费 App 分流**：首轮按多个维度做全库扫描属于同质只读，可交 Workflow 1（Diamond）或 Swarm 3（只读评审团）并行出清单；落地写入多为紧耦合改动，按负向否决门回主会话串行执行，每批 commit 后可派 `cmd-verifier` 独立复核。
- **免费 / IDE**：全程单会话顺序推进，每轮自审 Diff 并实跑验证命令。

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

- [ ] **假边测试通过**：各 Lane 间无真数据前后依赖（步骤 B 无需读取步骤 A 的输出）；强依赖或紧耦合改动留在主会话 / Orchestrator 或走 `/boost`。
- [ ] **隐式资源边清零**：核对共享文件、公共配置/锁、测试端口、GPU/内存与限流 API；有共享可变资源就隔离 worktree/端口或加边串行。
- [ ] **确定性验收**：验收条件写成明确命令或可观测指标（如 `npm test`、`go test -race ./...`、`0 console errors`）。
- [ ] **三层选模**：Coordinator 用 Orchestrator（Neon）、Worker 用 Hydrogen、`@verifier` 换另一模型（如 Carbon）。
- [ ] **硬证据与省配额路由**：要求仓库相对路径 + 1-based 行号、禁删断言；Worker 完工发 `@verifier [done]`，未阻塞勿 `@coordinator`。
- [ ] **写入隔离**：重叠写入或构建各开独立 working copy（git worktree），合并落地后再 `kill`。
- [ ] **配额与切模**：确认账号余量撑得住单会话 4～5 倍消耗，保持 `AGENTS.md` 稳定以利前缀缓存；成员遇 `quota out` 暂停时直接用 `swarm(action:"model")` 切模型续跑，别 `kill` 重建。
