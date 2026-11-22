# agy-cmd (v2.1)

Google Antigravity 桌面端（App）与 IDE 高阶能力自动路由插件、防停机自动续跑监工与内置斜杠指令参谋。

> [!IMPORTANT]
> **安装后首次必做确认**：为防止非会员账号误输 `/boost` 触发套餐权限报错，插件初始默认运行在 **「免费版安全模式（关闭 `/boost` 自动接入）」** 且 **「智能无感触发最多自动重试 3 次」**。
> 安装完成后，请务必打开右侧辅助边栏 **「agy-cmd 自动路由」** 面板（或在聊天中点击胶囊链接 `sidecar://agy-cmd/panel/`）手动确认两项设置：
> 1. **自动重试次数**：按需切换「不用重试 (0) / 指定次数 (1~50) / 一直重试 (∞)」；
> 2. **Boost 自动接入**：若你已开通 Google AI Pro / Ultra 会员，请在面板中手动切换至「Pro / Ultra 会员」以开启 `/boost` 自动接入提示。

---

## 解决什么问题

Google Antigravity 将需求追问、先审施工图、多智能体并发、防停机闭环等能力分散在 19 个内置斜杠指令与底层工具中，普通对话容易漏触发，或在多轮修错时半途停机、陷入原地盲改死循环。`agy-cmd v2.1` 采用主流 Coding Agent 最佳实践的 **「极薄常驻规则 + 零稳态开销生命周期钩子 + 右侧可视化面板 + 按需渐进 Skill」** 混合架构：

1. **原生能力全自动代执行（轻量直出零打扰）**
   - **轻量小改零打扰**：1～2 个文件的明确修改、解释代码、本地确定性查找直接执行，**不加徽标、不建计划、不推指令**。
   - **高阶能力自动路由**：遇到模糊需求自动调起 `ask_question` 单题追问（`[agy-cmd → /grill-me 追问]`）；跨 ≥3 文件改动先只读扫描并生成 `Implementation Plan` 等批准再改代码（`[agy-cmd → /plan 审批]`，含只读 Plan Mode 拒写自动正文兜底）；≥5 对象语义批处理自动调用 `run_workflow` 并发脚本；网页交互与可视化自动调度 `browser` / `generative_ui`。
2. **`Stop` 防停机自动续跑监工（免口令免声明，替代手动敲 `/goal`）**
   - 默认启用 **「智能无感触发 (`smart`)」**：改过源码后验证命令失败、或要求修错但单测/构建未绿而 AI 试图提前收工时自动拦截续跑；当你只是自然提问（如 *“为什么单测挂了 / 排查下报错原因 / 跑一下测试 / 看看环境”*）或处于 `/plan` 方案等待审批时，**无需声明“先别改代码”即可自动识别放行**，支持 **不用重试 (0) / 指定 1~50 次 / 一直重试 (∞)**。
   - 支持**单句口语临时覆盖**：提问时顺带说 `这次最多重试 5 次`、`这次一直重试` 或 `这次不用重试` 即可仅对当轮生效。
   - **4 道安全刹车始终生效**：手动点击停止按钮（`USER_CANCELED`）立即放行、AI 停下向你提问（无新改动/命令）防死锁放行、后台异步任务避让、子智能体零干扰。
3. **默认免费版防报错保护 + 卡壳自动换视角重查**
   - 默认屏蔽 `/boost`、`/swarm`、`/teamwork` 付费口令提示，杜绝免费档用户复制后遭遇权限报错；当连续命令失败 ≥3 次或出现 ≥2 次「修改→仍失败」震荡时，自动指示 AI 停止原地打补丁，委派独立只读 `research` 子智能体换全新上下文核查根因。
   - Pro / Ultra 会员在右侧面板开启后，自动解锁首行可复制 `/boost` 攻坚口令推荐。
4. **右侧边栏可视化控制面板 + 自然语言参谋**
   - 内置 Antigravity 原生辅助边栏面板（`agy-cmd 自动路由`），鼠标一点即存、秒级生效；也支持直接在聊天框对 AI 说 *“把自动重试改成 5 次 / 开启 Boost 接入”* 或查询对比全部 19 项桌面端指令。

---

## 安装方式

### 方式一：完整插件安装（推荐，含自动续跑钩子 + 右侧可视化面板）

**一行克隆直装**（重启或刷新 Antigravity 窗口即自动加载）：

- **Windows (PowerShell)**：
  ```powershell
  git clone https://github.com/zou172866/agy-cmd "$HOME\.gemini\config\plugins\agy-cmd"
  python "$HOME\.gemini\config\plugins\agy-cmd\skills\agy-cmd\scripts\setup_auto_router.py" --install
  ```
- **macOS / Linux**：
  ```bash
  git clone https://github.com/zou172866/agy-cmd ~/.gemini/config/plugins/agy-cmd
  python3 ~/.gemini/config/plugins/agy-cmd/skills/agy-cmd/scripts/setup_auto_router.py --install
  ```

*(也可克隆到任意本地目录后运行 `python skills/agy-cmd/scripts/setup_auto_router.py --install`，脚本会自动将完整插件包同步安装至 `~/.gemini/config/plugins/agy-cmd/` 并清理旧版重复规则。)*

### 方式二：仅安装轻量 Skill 与静态规则（兼容 `skills` CLI）

```bash
npx -y skills add zou172866/agy-cmd -g --all
python ~/.agents/skills/agy-cmd/scripts/setup_auto_router.py --install --standalone
```

---

## 常用管理与配置命令

除在右侧 **「agy-cmd 自动路由」** 面板可视化点选外，也可通过聊天口令或命令行管理：

```bash
# 查看插件、钩子、面板与当前重试/套餐状态
python skills/agy-cmd/scripts/setup_auto_router.py --status

# 调节自动重试档位（off / 1..50 / infinite）
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry off
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry 5
python skills/agy-cmd/scripts/setup_auto_router.py --auto-retry infinite

# 切换套餐档位与 Boost 自动接入（默认 free 关闭 Boost 防报错；Pro/Ultra 会员可设为 paid）
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier free
python skills/agy-cmd/scripts/setup_auto_router.py --plan-tier paid --boost on

# 校验规则、钩子与面板完整性（零漂移检查）
python skills/agy-cmd/scripts/setup_auto_router.py --sync-check

# 停用插件
python skills/agy-cmd/scripts/setup_auto_router.py --remove
```

---

## 自检与测试

- 运行依赖：Google Antigravity 桌面端 App / IDE、Node.js ≥ 20、Python 3
- 执行全套单元测试（钩子、面板安全、Star 里程碑与 CLI 测试）：
  ```bash
  node --test test/hooks.test.mjs test/sidecar.test.mjs test/star-prompt.test.mjs
  python -m unittest discover -s test -p "test_*.py" -v
  ```

## 仓库目录结构

```text
.
├── plugin.json                              # Antigravity 插件清单
├── hooks.json                               # 生命周期钩子配置 (SessionStart / PostToolUse / PreInvocation / Stop)
├── package.json
├── assets/
│   └── logo.svg                             # 插件图标
├── rules/
│   └── AGENTS.md                            # 极薄常驻路由规则（零稳态干扰 + 免费版默认防报错）
├── hooks/
│   ├── session-start.mjs                    # 首次启用一次性面板引导钩子（之后永久返回 {}）
│   ├── post-tool-use.mjs                    # 编辑与命令事件轻量记账钩子
│   ├── pre-invocation.mjs                   # 客观卡壳阈值与只读 Plan Mode 兜底钩子
│   ├── stop.mjs                             # 防停机自动续跑监工钩子（含 4 道安全刹车）
│   └── lib/                                 # 真实退出码对账、配置与状态核心库
├── sidecars/
│   └── panel/                               # 右侧辅助边栏可视化控制面板 (agy-cmd/panel)
│       ├── sidecar.json
│       ├── server.mjs
│       ├── api-handler.mjs
│       └── index.html
├── skills/
│   └── agy-cmd/                             # 19 项指令选型参谋 Skill 与 CLI 管理脚本
│       ├── SKILL.md
│       ├── references/
│       │   └── desktop-commands-matrix.md
│       └── scripts/
│           └── setup_auto_router.py
└── test/                                    # Node 与 Python 自动化测试套件
```
