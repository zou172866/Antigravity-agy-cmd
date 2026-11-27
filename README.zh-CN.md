<div align="center">

**简体中文** · [English](README.md)

<img src="assets/logo.svg" alt="agy-cmd logo" width="80" />

# agy-cmd

**Google Antigravity 桌面端 / IDE 护航插件：测试没过不许停 · 卡壳换视角排查 · 免费号防报错 · 审批零偷跑**

[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-cmd.json)](https://github.com/zou172866/Antigravity-agy-cmd)

[快速安装](#快速安装) · [核心功能](#核心功能) · [命令行管理](#命令行管理)

</div>

---

## 为什么装 agy-cmd？

测试还红着，AI 已经客客气气向你汇报“修改完成”。
免费号刚碰到付费口令，屏幕立刻甩出一串报错。
只读模式下方案写不进磁盘，它干脆想跳过审批直接改代码。
同一个 Bug 连改三遍越改越乱，它还在原地打转。

**`agy-cmd` 给 Google Antigravity 桌面版 / IDE 装上护栏。** 装好即用，后台静默值守：

- **按任务自动选轨**：小改动直接出活，大改动先交方案，同类批量或独立模块按条件匹配内置流程。
- **测试没过继续修**：改完代码若验证还挂着，钩子立刻拦住收工，推着 AI 修到全绿或达到上限。
- **卡壳自动换视角**：连改两轮还红，立刻叫停盲改。免费版派只读角色查根因，会员版可自动调度 Boost 子智能体。
- **审批锁死防偷跑**：只读 Plan Mode 写不了方案文件时，强制在聊天正文列出方案等你点头，硬拦截 `exit_plan_mode`。
- **免费账号零误触**：出厂默认关闭付费口令，单会话顺序落地，保住周配额也保住不报错。
- **侧栏面板随时调**：重试次数、测试门禁、会员档位和在线自更新，都在右侧面板点完即生效。

## 快速安装

环境要求：**Google Antigravity 桌面版**、**Node.js 20+**、**Python 3.8+**。

打开终端，跑一行对应系统的固定版本安装命令（下载同源 `SHA256SUMS.txt` 并校验正式发行 ZIP 摘要后才解压安装），然后重启或刷新 Antigravity 窗口。

**Windows（PowerShell 一行直装）：**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/v2.7.6/install.ps1 | iex
```

**macOS / Linux（一行直装）：**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/v2.7.6/install.sh | sh
```

### 其他安装方式

- **离线稳定包（带 SHA-256 验签）**：从 [GitHub Releases](https://github.com/zou172866/Antigravity-agy-cmd/releases/latest) 下载正式 ZIP 与 `SHA256SUMS.txt`：
  - 先验签再装：Windows 运行 `.\install.ps1 --archive .\agy-cmd-v2.7.6.zip --checksums .\SHA256SUMS.txt`，macOS / Linux 运行 `sh ./install.sh --archive ./agy-cmd-v2.7.6.zip --checksums ./SHA256SUMS.txt`。
  - 或解压后在目录内运行 `.\install.ps1`（Windows）/ `sh ./install.sh`（macOS / Linux）。
- **手动克隆仓库**（含 `.git` 目录时，面板在线自更新会自动关闭以防覆盖源码；后续用 `git pull` 更新，或改用上方一行直装）：

```powershell
git clone https://github.com/zou172866/Antigravity-agy-cmd "$HOME\.gemini\config\plugins\agy-cmd"
python "$HOME\.gemini\config\plugins\agy-cmd\skills\agy-cmd\scripts\setup_auto_router.py" --install
```

Linux / macOS / SSH 宿主机若无 `python` 软链，把命令里的 `python` 换成 `python3`。通过 `agy plugin install` 或官方 Marketplace 安装的用户，请直接用插件管理器更新。

- **只装纯文字规则**（不含自动续跑钩子和右侧面板）：

```bash
npx -y skills add zou172866/Antigravity-agy-cmd -g --all
python ~/.agents/skills/agy-cmd/scripts/setup_auto_router.py --install --standalone
```

## 装好先看这两项

出厂默认设为**「免费版保护」**与**「最多自动重试 3 次」**。打开右侧边栏的「agy-cmd 自动路由」面板（或点击聊天里的 `sidecar://agy-cmd/panel/`），确认两件事：

1. **自动重试次数**：可选不用重试（0 次）、指定次数（1～50 次）或一直重试。
2. **账号档位**：开通了 Google AI Pro / Ultra 的用户，切到「Pro / Ultra 会员」即可开启 Boost 自动接入。遇到竞态、死锁等疑难排查，或多次修错未果时，插件会自动调度 `DeepCoder` / `DeepInvestigator`。面板里的「计划获批后自动使用 Boost」默认关闭；手动打开后，你点「批准」或回复“按计划执行”，插件会提示 `[agy-cmd → 计划获批，自动 Boost]` 并单次派工（调用报错再回退常规工具，后台唤醒不重复触发）。

## 核心功能

### 1. 小事直出，大事先审

- **1～2 文件小改、问代码、本地查找**：直接给答案，零弹窗、零徽标。
- **需求没说清**：先出精简选择题对齐关键边界（独立问题可合并追问），少做无用功。
- **3 个及以上文件或高风险改动**：先写方案等你批。只读模式建不了方案文件，正文照样写出方案等你拍板，绝不偷偷绕过。多模块获批计划在 App 可直接接 `/swarm execute our plan`；已开启获批自动 Boost 的会员会自动单次派工，同时保住后台唤醒后的 `Stop` 续跑状态。
- **单点旁支与批量作业**：查一条复杂调用链或验一个页面，可派单名子智能体分担。5 个以上同类对象按默认顺序分批；面板设为付费档且 App 开放能力时，可选用 `/run-workflow` 汇总结构化结果。
- **独立车道与长程工程**：互不撞文件的多模块写码、多视角评审或 Best-of-N 择优，在 App 可走 `/swarm`（内置 6 套模板、Gemini 4 三层选模与启动前自检）。紧耦合改动留在主会话 / Orchestrator，单点死磕走 `/boost`，跨天里程碑工程走 `/teamwork`。活跃 `/swarm` 会话及 Worker（含 `fork`）由钩子自动放行，不打断留言板与前缀缓存。[指令速查矩阵](skills/agy-cmd/references/desktop-commands-matrix.md) · [多智能体与 Swarm 模板](skills/agy-cmd/references/multi-agent-playbooks.md)
- **动态网页与交互图表**：自动唤起内置浏览器或生成可交互画面。

### 2. 测试没过，不准收工

只要你让 AI 改代码或修错，测试还没绿，`Stop` 钩子就会把它拉回来继续查、继续修，直到全绿或用完重试额度。

想把关更严，打开面板里的**「交付前强制测试门禁」**（默认关闭，全套餐可用）。开启后，只要当轮实质改过源码：

- **有自定义命令或项目现成测试**：最后一次改码之后必须跑通全部验证（支持单条或 `&&` 组合，如 `npm run typecheck && npm test`）才准交卷。漏跑会拦回补测，跑挂按重试额度修到全绿。
- **项目无测试且未填自定义命令**：保守放行，不私改仓库测试结构，交付末尾明确写出缺测项和原因。
- **单轮临时豁免**：提问时顺口带一句 `这次跳过测试`，当轮直接放行。

免费模式下执行已批准的计划时，若确实改了源码却漏跑现成检查，插件也会在现有额度内提醒补验一次。纯文档改动、用户取消或等待审批，一律不打扰。

以下四种场景，插件立刻放行停机：

- 你只是提问或只读探测，没要求改代码（如“为什么报错了”“跑一下测试看看”）。
- AI 刚发出修改方案，正在等你拍板。
- AI 缺信息停下来等你回答。
- 你手动点了停止按钮。

单轮想临时改额度，直接说 `这次最多重试 5 次`、`这次一直重试` 或 `这次不用重试`，仅对当次生效。

### 3. 免费护航与卡壳换脑

- **套餐与配额**：`/boost` 和 `/teamwork` 属于付费功能，`/swarm` 与 `/run-workflow` 在 App 全套餐开放。免费模式下插件默认顺序执行，帮免费号省下周配额；在支持的 App 会话里你仍可手动点名使用后两项。IDE 或宿主能力未知时，路由稳妥留在主会话。[官方套餐对照](https://antigravity.google/docs/boost/) · [工作流说明](https://antigravity.google/docs/dynamic-workflows/)
- **可选独立复核**：免费用户在侧栏可打开计划实施后的独立复核（默认关闭）。主 Agent 改完并跑通验证后，把改动路径、关键 diff 和验证证据交给只读的 `cmd-verifier` 复查；宿主没提供该角色时，主 Agent 会如实声明跳过。
- **卡壳止损**：免费版或关 Boost 时，命令连挂 3 次或连改 2 轮仍红，立刻停下盲改，转交只读角色排查根因。会员开 Boost 后，遇到明确疑难任务、连挂 3 次或连改 3 轮仍红（给 Orchestrator 原生“失败 2 次回交 Neon”留出自愈空间），自动派 `DeepInvestigator` / `DeepCoder` 接力，主会话验收结果。

Hook 与安装流程已通过本地测试，真实免费账号在 App 和 IDE 中调度复核角色仍待真机验证。[多智能体路由调研](docs/research/multi-agent-routing-best-practices.md) · [免费档设计提案](docs/proposals/free-tier-v2.3.md)

### 4. 右侧面板与一键自更新

- **即点即生效**：重试次数、触发范围、测试门禁和账号档位，全在右侧「agy-cmd 自动路由」面板可视化开关。
- **带校验的在线自更新**：点面板右上角「检查更新」即可拉取 GitHub Releases 并一键升级。优先核验 `.zip` 的 SHA-256 摘要，出错自动回滚。打开面板默认自动检查，可通过面板开关、`--auto-update-check off` 或环境变量 `AGY_CMD_DISABLE_AUTO_UPDATE_CHECK=1` 关闭。面板另设「自动静默更新」开关（默认关闭），开启后仅自动升级同主版本且通过 SHA-256 校验的 Release，单版本失败自动熔断。
- **克制的 Star 提醒**：面板右上角可随时点 `★ Star` 关注更新。累计替你自动续跑救场满 3 次后轻提示一次，点过或关闭就永久收起。
- **聊天直调**：直接在对话里说“把自动重试改成 5 次”“开启 Boost 接入”或“列出 Antigravity 内置斜杠指令的区别”，AI 会直接改好或给出对照。

## 命令行管理

除了点面板和在聊天框口头交代，也能在终端用脚本直接管：

```bash
# 查看插件状态与当前设置
python skills/agy-cmd/scripts/setup_auto_router.py --status

# 修改自动重试次数（off / 1..50 / infinite）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry off
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry 5
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry infinite

# 切换免费版或会员版，并可选控制计划获批后自动 Boost / 卡壳换视角 / Plan Mode 兜底
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier free
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier paid --boost on
python skills/agy-cmd/scripts/setup_auto_router.py --boost-after-plan-approval on
python skills/agy-cmd/scripts/setup_auto_router.py --free-fallback on --plan-fallback on

# 清空累计自动重试统计（不改账号档位与 Boost）
python skills/agy-cmd/scripts/setup_auto_router.py --reset-stats

# 开关交付前强制测试门禁（默认关闭），可选配置自定义验证命令
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-gate on
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-cmd "npm run typecheck && npm test"
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-gate off

# 免费档计划实施后开启一次独立复核
python skills/agy-cmd/scripts/setup_auto_router.py --free-plan-review on

# 开关打开面板时自动检查新版本（默认开启）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-check off
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-check on

# 开关同主版本 + SHA-256 静默自动更新（默认关闭）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-install on
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-install off

# 检查插件文件完整性与本机同步
python skills/agy-cmd/scripts/setup_auto_router.py --sync-check

# 停用插件
python skills/agy-cmd/scripts/setup_auto_router.py --remove
```

运行全量测试与官方插件严格校验：

```bash
npm test
python3 -m unittest discover -s test -p "test_*.py" -v
agy plugin validate --strict .
```
