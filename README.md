# agy-cmd

Google Antigravity 桌面端与 IDE 高阶能力自动路由器与内置斜杠指令参谋 Skill。

## 解决什么问题

Google Antigravity 把需求追问、先审施工图、批量并发编排、三层深度推演等高阶能力分散在 19 个内置斜杠指令与底层工具中，默认对话不会主动调用。`agy-cmd` 提供双轨解决方案：

1. **全局常驻自动路由（安装后开启一次，所有新任务自动生效）**：
   - **原生工具自动代执行**：遇到模糊新想法自动启动 Grill-Me 单题追问（`ask_question`）；跨 3 个以上文件改动自动先出 `Implementation Plan` 等批准再动代码；5 个以上独立模块语义批处理自动调用 `run_workflow` 写并发脚本；动态网页交互自动委派 `browser` 子智能体；简单局部小改保持零打扰直接执行。
   - **前端专属模式首行提醒**：遇到反复未修好的疑难故障、死锁竞态或无人值守长闭环任务，在正常排查的同时于回复第 1 行附上可直接复制的 `/boost`、`/goal`、`/teamwork` 命令。
2. **极简指令选型参谋与分类速查**：
   - 主动询问“这活该敲什么指令”或对比相近指令时，零反问直接交付带 `@` 上下文挂载的可复制命令块与近邻排他理由，严格拦截桌面端无法使用的终端 CLI 专属命令。

## 安装与开启全局自动路由

### 第 1 步：一行命令安装 Skill

```bash
npx -y skills add zou172866/agy-cmd -g --all
```

### 第 2 步：激活全局常驻自动路由（任选一种）

在 Antigravity 聊天框直接发送：

```text
/agy-cmd 开启自动路由
```

或在终端运行内置脚本（将向 `~/.gemini/config/rules/agy-auto-router.md` 写入 `always_on` 规则并同步桌面端目录）：

```bash
python ~/.agents/skills/agy-cmd/scripts/setup_auto_router.py --install
```

如需关闭自动路由恢复默认行为，发送 `/agy-cmd 关闭自动路由` 或运行 `python ~/.agents/skills/agy-cmd/scripts/setup_auto_router.py --remove` 即可一键卸载。

## 运行依赖

- Google Antigravity 桌面端 App 或 Antigravity IDE
- Python 3（仅用于执行 `setup_auto_router.py` 启用或移除全局常驻规则）

## 仓库目录结构

```text
.
├── README.md
└── skills/
    └── agy-cmd/
        ├── SKILL.md
        ├── references/
        │   └── desktop-commands-matrix.md
        └── scripts/
            └── setup_auto_router.py
```
