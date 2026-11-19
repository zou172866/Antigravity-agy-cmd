#!/usr/bin/env python3
"""Install, check, or remove the global always-on Antigravity auto-router rule."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

RULE_FILENAME = "agy-auto-router.md"

RULE_CONTENT = """---
trigger: always_on
description: "Automatically invoke Antigravity native capabilities (Grill-Me interview, Implementation Plan, run_workflow, swarm, browser) and surface UI-only slash commands (/boost, /goal, /teamwork, /compact) on matching tasks."
---

# Antigravity 高阶能力全局自动路由规则 (agy-cmd)

在桌面端 App 与 IDE 的所有对话中，除非当前工作区已有更具体的项目专属 `AGENTS.md` 流程覆盖，否则按以下双轨规则自动调度反重力内置高阶能力：

## 一、轻量任务免打扰白名单（直接执行，零额外弹窗）

单文件或两文件内的明确局部修改、代码解释、常规报错单次修复、以及可用本地命令（如 `rg` 或简短脚本）秒级完成的确定性文本查找，直接干脆执行，禁止强行创建计划文档或推销斜杠指令。

## 二、原生底层能力自动代执行轨（无需用户手敲斜杠）

1. **模糊新想法 → 自动执行 Grill-Me 单题追问**：用户提出新功能、新工具或重构意向，但关键业务规则、输入输出或边界条件未定时，禁止臆测硬写代码，也禁止一次抛出一长串问卷；使用 `ask_question`（或简短单问）每次只问 1 个最关键的决策问题并置顶 `(Recommended)` 推荐项，逐步对齐后再动手。
2. **跨 3 个及以上文件或高风险改动 → 自动执行 Plan 先审后改**：目标已清晰，但预计改动 3 个及以上源文件、修改公共接口或核心架构时，先只读扫描相关代码，在产物目录创建带 `RequestFeedback: true` 的 `Implementation Plan` 实施方案，获用户确认后再修改业务文件。
3. **5 个及以上独立对象需语义判断批处理 → 自动调度 `run_workflow`**：需要对 5 个及以上文件、模块或子目录执行依赖大模型语义理解的同质任务（如逐模块代码审查、批量文稿语义质检、批量补写单测）时，先读取内置 `run-workflow` Skill 并调用 `run_workflow` 工具编写 Python `parallel()` / `pipeline()` 脚本并发执行（纯字符或正则匹配仍优先用本地命令直接完成）。
4. **多模块异构并行开发加验收 → 按需调度 `swarm`**：任务天然拆分为 2～4 个互不冲突的模块并行开发且需独立测试员验收时，读取内置 `swarm` Skill 协调并行分工。
5. **动态网页实操与交互式可视化**：涉及真实网页点击、查询动态渲染页面或 UI 截图核验时，直接调用 `browser` 子智能体；涉及复杂架构图或交互演示时，读取内置 `generative_ui` Skill。

## 三、前端专属控制器首行提醒轨（不阻断当前排查，首行附可复制命令）

以下模式仅能由用户在聊天输入框输入 `/` 挂载外层控制器。命中时，在正常推进分析的同时，于回复第 1 行用 1 句话附上可直接复制的命令块（严禁推荐终端 CLI 专属命令如 `/undo`、`/branch`、`/effort`）：

- **同一疑难 Bug 已尝试修复 2 次及以上仍失败、偶发并发死锁/竞态或复杂算法优化**：首行提示可复制 `/boost <精炼问题>` 开启三层多假设深度推演与验证；
- **要求无人值守把长链路构建或测试套件修到全绿为止、中途别停**：首行提示可复制 `/goal <精炼目标>` 开启持续自治闭环；
- **跨天级仓库框架大迁移或子系统重写**：首行提示可复制 `/teamwork <迁移目标>`；
- **用户主动询问指令选型、对比或速查**：读取 `agy-cmd` 的 `SKILL.md` 按极简处方或速查表交付。
"""


def resolve_config_dir(custom_root: str | None) -> Path:
    if custom_root:
        root = Path(custom_root).expanduser().resolve()
        if root.exists() and not root.is_dir():
            raise SystemExit(f"ERROR：目标根路径已存在且不是目录：{root}")
        return root
    return Path.home() / ".gemini" / "config"


def sync_skill_if_needed(config_dir: Path) -> str | None:
    skill_source = Path(__file__).resolve().parent.parent
    target_skill_dir = config_dir / "skills" / "agy-cmd"
    if skill_source.resolve() == target_skill_dir.resolve():
        return None
    if (skill_source / "SKILL.md").is_file() and not (target_skill_dir / "SKILL.md").is_file():
        target_skill_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(skill_source, target_skill_dir, dirs_exist_ok=True)
        return str(target_skill_dir)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="管理 Antigravity 全局常驻自动路由规则 (agy-auto-router.md)"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--install", action="store_true", help="安装并启用全局 always_on 自动路由规则")
    group.add_argument("--remove", action="store_true", help="移除全局 always_on 自动路由规则")
    group.add_argument("--status", action="store_true", help="查看当前自动路由规则安装状态")
    parser.add_argument(
        "--config-dir",
        default=None,
        help="可选：指定自定义配置根目录（默认使用 ~/.gemini/config）",
    )
    args = parser.parse_args()

    config_dir = resolve_config_dir(args.config_dir)
    rule_path = config_dir / "rules" / RULE_FILENAME

    if args.status:
        if rule_path.is_file():
            print(f"状态：已启用（{rule_path}）")
            return 0
        print(f"状态：未启用（未检测到 {rule_path}）")
        return 0

    if args.remove:
        if rule_path.is_file():
            rule_path.unlink()
            print(f"已移除全局自动路由规则：{rule_path}")
        else:
            print(f"无需移除，规则文件不存在：{rule_path}")
        return 0

    if args.install:
        rule_path.parent.mkdir(parents=True, exist_ok=True)
        rule_path.write_text(RULE_CONTENT, encoding="utf-8")
        synced = sync_skill_if_needed(config_dir)
        print(f"已启用全局常驻自动路由规则：{rule_path}")
        if synced:
            print(f"已同步桌面端 Skill 目录：{synced}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
