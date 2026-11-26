<div align="center">

**简体中文** · [English](README.md)

<img src="assets/logo.svg" alt="agy-cmd logo" width="80" />

# agy-cmd

**Google Antigravity 桌面端插件：按任务自动路由指令 · 测试未过自动续跑 · 自动调用多智能体 · 卡壳时自动换视角排查 · 防止偷偷改代码**

[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-cmd.json)](https://github.com/zou172866/repo-traffic-archive)

[怎么安装](#怎么安装-agy-cmd) · [核心功能](#agy-cmd-有哪些功能) · [命令行管理](#怎么用命令行管理)

</div>

---

## agy-cmd 是什么？

`agy-cmd` 是 **Google Antigravity 桌面版 / IDE** 的辅助插件。

安装以后，它会在你和 AI 对话时自动处理这几件事：

- **按不同任务自动路由指令**：根据任务范围自动匹配 `/grill-me`、`/plan`、`/run-workflow` 等内置能力；
- **测试未过自动续跑**：在测试或验证还没通过时让 AI 接着排查修复，不提前停工；
- **疑难排查与卡壳自动调用 Boost**：会员开启 Boost 后，明确要求排查或修复竞态/死锁等疑难问题，或多次修复仍失败时，自动调度 `DeepCoder` / `DeepInvestigator` 排查、执行与验收（面板另提供可选的「计划获批后自动使用 Boost」开关）；
- **自动调用多智能体**：会根据任务自动调用合适的多智能体模式，简单任务由主会话直接完成。
- **卡壳时自动换视角排查（全套餐可用）**：反复修错未果时，将只读诊断任务交给一个可用的调查角色，由主 Agent 验证修复结果。
- **只读模式防绕过审批**：在只读模式拒绝写方案文件时，强制正文直接输出方案等你确认，严禁自动跳过审批偷偷改代码；
- **右侧可视化控制面板**：提供随时点选的控制面板，同时内置免费账号防报错保护，默认屏蔽未开通套餐的付费口令。

## 怎么安装 agy-cmd？

要安装打包好的稳定版，请从 [GitHub Releases](https://github.com/zou172866/Antigravity-agy-cmd/releases/latest) 下载 ZIP 并解压。在解压目录中，Windows 运行 `.\install.ps1`，macOS 或 Linux 运行 `sh ./install.sh`。

需要电脑已安装 Google Antigravity 桌面版、Node.js（20 及以上版本）和 Python 3。

打开终端，复制对应系统的一行命令运行，完成后重启或刷新 Antigravity 窗口即可使用。

**Windows（PowerShell 一行直装）：**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/main/install.ps1 | iex
```

**macOS / Linux（一行直装）：**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/main/install.sh | sh
```

也可以手动克隆仓库安装：

```powershell
git clone https://github.com/zou172866/Antigravity-agy-cmd "$HOME\.gemini\config\plugins\agy-cmd"
python "$HOME\.gemini\config\plugins\agy-cmd\skills\agy-cmd\scripts\setup_auto_router.py" --install
```

如果只安装基础文字规则（不含自动重试和右侧面板），可以运行：

```bash
npx -y skills add zou172866/Antigravity-agy-cmd -g --all
python ~/.agents/skills/agy-cmd/scripts/setup_auto_router.py --install --standalone
```

## 装好后先看哪两项设置？

为了防止免费账号误输付费口令报错，插件刚装好时默认开启「免费版保护」和「最多自动重试 3 次」。

安装完成后，请打开软件右侧边栏的「agy-cmd 自动路由」面板（也可以在聊天框点击 `sidecar://agy-cmd/panel/` 打开），确认两项设置：

1. **自动重试次数**：选择「不用重试（0 次）」「指定次数（1～50 次）」或「一直重试」。
2. **账号档位**：如果你开通了 Google AI Pro / Ultra 会员，可以切换到「Pro / Ultra 会员」，开启 Boost 自动接入，在排查竞态、死锁等疑难任务或多次修复仍失败时自动调度 `DeepCoder` / `DeepInvestigator`。「计划获批后自动使用 Boost」默认关闭；如需让所有获批方案也直接交给 Boost 执行，可在面板手动开启，届时点击「批准」或在方案后回复“按计划执行”会提示 `[agy-cmd → 计划获批，自动 Boost]` 并单次调度隐藏的 `DeepCoder` / `DeepInvestigator` 子智能体执行与验证（无需手动输入 `/boost`，仅在调用报错时才回退为普通工具执行），且后台任务唤醒不会重复触发。

## agy-cmd 有哪些功能？

### 1. 按任务大小自动分步骤

这项功能用于省去手动挑选内置命令的步骤。

- 改动 1～2 个文件、解释代码或查找内容时，AI 直接给出结果，不额外弹窗打扰。
- 需求没说清时，AI 先出一个选择题向你确认方向。
- 需要改动 3 个及以上文件时，AI 先把修改方案列出来，等你确认后再动手改代码。即使当前处于只读模式无法新建方案文件，AI 也会直接在对话框里写出方案等你点头；如在会员 Boost 模式下手动开启了「计划获批后自动使用 Boost」，方案获批后会自动提示 `[agy-cmd → 计划获批，自动 Boost]` 并单次触发 `DeepCoder` / `DeepInvestigator` 执行，同时在后台任务唤醒时保留 `Stop` 自动续跑状态。
- 查一条复杂调用链、验一个页面，可以各自作为单点旁支交给一个子智能体。简单查找直接在主会话完成。
- 给 5 个及以上同类对象做相同检查时，默认顺序分批。面板已选付费档且当前 App 提供该命令时，插件可选用 `/run-workflow` 逐项检查、汇总结构化结果。
- 多个模块要协商接口、相互审查时，App 可用 `/swarm`。先定接口、各写手负责的文件和整体验证命令。单个反复失败的难题适合 `/boost`，跨天且能分里程碑验收的工程适合 `/teamwork`。[选型与可复制示例](skills/agy-cmd/references/desktop-commands-matrix.md)
- 需要操作网页或展示可点击的图表时，AI 会自动打开内置浏览器或生成交互画面。

### 2. 测试没过自动接着修

这项功能用于防止 AI 在报错还没修好时提前停工。

当你让 AI 改代码或修错，但测试、运行验证还没通过时，插件会自动让 AI 继续排查修改，直到验证通过或达到设定的重试上限。

当你在面板开启可选的**「交付前强制测试门禁（改后必测，全绿交付）」**（默认关闭，全套餐可用）后，无论是否走计划审批，只要当轮实质修改了源码：

- **有自定义验证命令或现成测试**：必须在最后一次代码改动之后跑通全部验证命令（支持单条或 `&&` 组合命令，如 `npm run typecheck && npm test`）才允许交付；改完漏跑会被拦截补测，跑挂则按自动重试上限继续修到全绿。
- **项目无现成测试且未填自定义命令**：保守放行、不私自改动仓库测试结构，并在交付末尾强制说明缺测项与原因。
- 某次提问不想触发门禁，顺带说一句 `这次跳过测试` 即可单轮豁免。

免费模式下，执行已批准的实施计划时，如果主 Agent 确实写了源码，且漏跑了可识别的项目检查，插件可在现有重试额度内提醒补跑一次。纯文档修改、用户取消和等待批准均不会触发这次提醒。

在下面几种情况下，插件会自动放行并立即停下：

- 你只是提问（例如“为什么报错了”“帮我查查原因”“跑一下测试看看”），没有要求改代码；
- AI 刚把修改方案发给你，正在等你确认；
- AI 缺少必要信息，需要停下来问你；
- 你手动点击了停止按钮。

如果某一次提问想临时换用别的重试次数，直接在话里加上 `这次最多重试 5 次`、`这次一直重试` 或 `这次不用重试`，就只对当次提问生效。

### 3. 免费账号防报错与卡壳换思路

这项功能用于避免免费账号误触付费功能报错，并防止 AI 在同一个错上反复打转。

- **套餐与配额**。Google 将 `/boost`、`/teamwork` 列为付费功能。App 的 `/swarm`、`/run-workflow` 对所有套餐开放。插件在免费模式下默认顺序执行以节省周配额，用户可以在支持的 App 会话里明确要求本次使用后两项。在 IDE 或宿主能力未知时，自动路由留在主会话。[官方套餐对照](https://antigravity.google/docs/boost/) · [工作流说明](https://antigravity.google/docs/dynamic-workflows/)
- **可选独立复核**。免费用户可在侧栏打开计划实施后的独立复核，默认关闭。主 Agent 负责改代码、跑验证，再把本次改动路径、关键 diff 和验证证据交给一位仅可读文件的 `cmd-verifier`。宿主未提供该角色时，主 Agent 会说明独立复核未完成。
- **疑难排查与卡壳换思路**：免费版或关闭 Boost 时，命令连续失败 3 次或连改两次仍报同一个错，插件会让 AI 停下反复试错，改为只读排查原因；会员开启 Boost 后，遇到明确的疑难排查或反复失败会自动调度 `DeepInvestigator` / `DeepCoder` 介入，由主会话核对结果。

Hook 和安装流程已通过本地测试，真实免费账号在 App 和 IDE 中调度复核角色仍待验证。[多智能体路由调研](docs/research/multi-agent-routing-best-practices.md) · [免费档设计提案](docs/proposals/free-tier-v2.3.md)

### 4. 右侧面板与口令查询

这项功能用于随时查看和修改插件设置，或查询软件自带口令的用法。

- 在软件右侧「agy-cmd 自动路由」面板中点击按钮即可修改重试次数、触发方式和会员档位，点完立即生效。
- 在面板右上角点击「检查更新」可检查 GitHub Releases 并对已安装插件一键在线自更新（优先校验 Release `.zip` SHA-256，失败自动回滚；打开面板默认自动检查，可在面板开关、命令行 `--auto-update-check off` 或设置环境变量 `AGY_CMD_DISABLE_AUTO_UPDATE_CHECK=1` 关闭）。
- 在面板右上角可以点击 `★ Star` 前往 GitHub 仓库关注版本更新；累计帮你自动接着修满 3 次后也会提示一次，点击或关闭后不再重复弹出。
- 在聊天框直接输入“把自动重试改成 5 次”“开启 Boost 接入”或“列出 Antigravity 所有内置斜杠指令的区别”，AI 也会直接帮你改好或列出对比说明。

## 怎么用命令行管理？

除了点选右侧面板和在聊天框直接说以外，也可以在终端运行脚本管理设置：

```bash
# 查看插件状态与当前设置
python skills/agy-cmd/scripts/setup_auto_router.py --status

# 修改自动重试次数（可选 off / 1..50 / infinite）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry off
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry 5
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry infinite

# 切换免费版或会员版
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier free
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier paid --boost on

# 开启或关闭交付前强制测试门禁（默认关闭），并可选配置自定义验证命令
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-gate on
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-cmd "npm run typecheck && npm test"
python skills/agy-cmd/scripts/setup_auto_router.py --delivery-test-gate off

# 免费档在实施已批准的计划后进行一次独立复核
python skills/agy-cmd/scripts/setup_auto_router.py --free-plan-review on

# 开启或关闭打开右侧面板时自动检查 GitHub Releases 新版本（默认开启）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-check off
python skills/agy-cmd/scripts/setup_auto_router.py --auto-update-check on

# 检查插件文件是否完整
python skills/agy-cmd/scripts/setup_auto_router.py --sync-check

# 停用插件
python skills/agy-cmd/scripts/setup_auto_router.py --remove
```

运行自带测试：

```bash
npm test
python -m unittest discover -s test -p "test_*.py" -v
```
