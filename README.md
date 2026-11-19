# agy-cmd

Google Antigravity 桌面端与 IDE 内置斜杠指令选型参谋与分类速查 Skill。

## 解决什么问题

面对 Google Antigravity 十余个局部相似的内置斜杠指令（例如规划类的 `/grill-me` 与 `/plan`，多智能体与自治类的 `/goal`、`/boost`、`/swarm`、`/run-workflow`、`/teamwork`，以及定时类的 `/schedule` 与 `/automation`），根据手头真实任务描述直接给出：

1. 首选指令（或跨阶段两步连招）及套餐门槛说明；
2. 结合 `@` 上下文挂载语法的可直接复制命令块；
3. 敲下回车后的界面预期效果与排除最易混近邻指令的一句话理由。

## 适用条件与边界

- **适用场景**：在 Antigravity 桌面端 App 或 IDE 聊天框中准备开展新任务拿不准敲哪个指令、纠结两个相近指令如何取舍，或需要按场景查阅桌面端内置指令清单。
- **主要边界**：
  - 仅覆盖桌面端 App 与 IDE 通用内置指令（共 19 项）及 `@` 挂载用法，主动拦截终端 `agy` CLI 专属命令（如 `/undo`、`/branch`、`/effort` 等）；
  - 极简选型与速查定位，零反问直接交付，不做互动出题；
  - 涉及编写底层 `hooks.json` 或 `mcp_config.json` 配置字段时，引导衔接内置的 `/agy-customizations`。

## 安装

```bash
npx -y skills add zou172866/agy-cmd -g --all
```

## 最短使用示例

安装后，在 Antigravity 聊天框直接输入：

```text
/agy-cmd 我有 15 个历史文件夹想按同一套规则检查标签是否超标，该敲什么指令？
```

或直接用自然语言提问：

```text
桌面端里 /goal、/boost、/swarm 和 /run-workflow 分别在什么情况下用？
```

## 运行依赖

- Google Antigravity 桌面端 App 或 Antigravity IDE（或其他支持 Agent Skills 规范的客户端）
- 无需额外 Python / Bash 脚本或外部 API 密钥

## 仓库目录结构

```text
.
├── README.md
└── skills/
    └── agy-cmd/
        ├── SKILL.md
        └── references/
            └── desktop-commands-matrix.md
```
