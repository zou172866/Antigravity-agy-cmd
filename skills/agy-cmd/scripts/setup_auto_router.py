#!/usr/bin/env python3
"""Install, check, sync-verify, configure retry/tier settings, or disable agy-cmd."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PLUGIN_NAME = "agy-cmd"
RULE_FILENAME = "agy-auto-router.md"
MIN_RETRY_MAX = 1
MAX_RETRY_MAX = 50
DEFAULT_RETRY_MAX = 3

GITHUB_REPO_URL = "https://github.com/zou172866/Antigravity-agy-cmd"
GH_STAR_COMMAND = "gh api -X PUT /user/starred/zou172866/Antigravity-agy-cmd"
GH_AUTH_CHECK_TIMEOUT_SEC = 1.5
STAR_PROMPT_STATES = ("pending", "clicked", "dismissed", "copied_cli")

RULE_FRONTMATTER = """---
trigger: always_on
description: "Auto-route Antigravity native tools and tier-safe lifecycle guards."
---

"""

RULE_BODY = """# Antigravity 自动路由 (agy-cmd)

仅桌面端 App/IDE；工作区 `AGENTS.md` 优先。

- **轻量直出（零打扰）**：解释代码、本地文本查找，或改法明确、仅涉及 1～2 个文件且不触及公共接口的低风险修改 → 直接执行，**不加徽标、不建计划、不推指令**。
- **可见徽标**：仅当命中下方「原生调度」或「套餐感知兜底」时，在回复（或方案/提问）第 1 行输出 1 个简短徽标，例如 `[agy-cmd → /plan 审批]`、`[agy-cmd → 自动换视角排查]`。
- **原生调度**：
  1. 需求/边界未定 → 标注 `[agy-cmd → /grill-me 追问]` 并调 `ask_question` 单题追问，推荐项置顶 `(Recommended)`。
  2. 首次写项目文件前，按本次任务预计改动的文件数判断范围（`agy-dart` 的 `apply_edits` 批量修改按文件计）。范围不明时先只读扫描。预计改 ≥3 个文件、变更公共接口或涉及高风险 → 输出 `[agy-cmd → /plan 审批]`，提交 `RequestFeedback: true` 的 Implementation Plan，获批后再写项目文件。**若只读 Plan Mode 拒绝 `write_file` 写方案产物，在回复正文给出方案并等待确认，严禁调用 `exit_plan_mode` 绕过审批**。
  3. ≥5 对象语义批处理 → `[agy-cmd → /run-workflow]`，读 `run-workflow`（`parallel()`/`pipeline()`；纯正则用本地命令；高精度批处理显式 `model="inherit"` 禁擅自降级，共享长前缀时按 3～5 项复用多轮 Worker（编码优先选可用的 `dart-coder`，否则选 `self`） 命中 KV 缓存并做单项异常隔离；若套餐不支持则自动分批顺序处理）。
  4. 动态网页/截图 → `[agy-cmd → /browser]` 调 `browser`；复杂图表/交互 → `[agy-cmd → /generative_ui]` 读 `generative_ui`；2～4 模块并行+验收（仅确认付费套餐可用时）→ `[agy-cmd → /swarm]` 读 `swarm`。
- **防报错套餐感知与自动续跑**（禁推 CLI 专属 `/undo`、`/branch`、`/effort`；本轮已用对应 `/` 指令则不重复提示）：
  1. **卡壳排错（默认免费版防报错）**：同一 Bug 跨 ≥2 轮未解、≥2 次「修改→仍失败」震荡、连续 ≥3 次命令失败或难算法 → **默认严禁主动推荐 `/boost`、`/teamwork` 等付费指令以防免费号报错**；仅当收到 `agy-cmd` 钩子明确指示输出 `[agy-cmd → 建议 /boost]` 时才给 `/boost` 口令，否则统一输出 `[agy-cmd → 自动换视角排查]`，停止盲改并优先调可用的 `dart-reviewer`，否则派只读 `research` 子智能体独立核查根因或先列排查假设逐一验证。
  2. **防停机自动续跑（Stop 监工）**：改代码或修错后若存在现成测试/构建命令，结束前优先实跑验证以便 `agy-cmd` `Stop` 钩子无感核验并在未通过时按面板设定次数自动续跑；仅当收到钩子明确提示时输出 `[agy-cmd → 自动续跑已启用]` 或 `[agy-cmd → 建议 /goal]`。
  3. **调节重试/Boost 与指令选型**：当用户调节自动重试次数、切换会员/Boost 开关，或查询对比指令时，读 `agy-cmd` `SKILL.md`（可附 `[agy-cmd 自动路由](sidecar://agy-cmd/panel/)` 面板入口）。
"""

RULE_CONTENT = RULE_FRONTMATTER + RULE_BODY

POST_INSTALL_REMINDER = """
⚠️ 安装后重要提醒（默认运行在「免费版安全模式」防报错）：
   请在右侧边栏打开【agy-cmd 自动路由】面板（或点击聊天胶囊 sidecar://agy-cmd/panel/）手动确认两项设置：
   1. 自动重试次数：手动切换「不用重试 (0) / 指定次数 (当前默认 3 次) / 一直重试 (∞)」；
   2. Boost 自动接入：当前默认为「免费版（关闭 /boost 提示以防非会员报错）」，如为 Pro/Ultra 会员请手动开启 Boost 自动接入。
""".strip()


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def normalize_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def resolve_config_dir(custom_root: str | None) -> Path:
    if custom_root:
        root = Path(custom_root).expanduser().resolve()
        if root.exists() and not root.is_dir():
            raise SystemExit(f"ERROR：目标根路径已存在且不是目录：{root}")
        return root
    return Path.home() / ".gemini" / "config"


def resolve_state_dir(custom_state_dir: str | None = None) -> Path:
    if custom_state_dir:
        return Path(custom_state_dir).expanduser().resolve()
    env_custom = os.environ.get("AGY_CMD_STATE_DIR", "").strip()
    if env_custom:
        return Path(env_custom).expanduser().resolve()
    plugin_data = os.environ.get("PLUGIN_DATA", "").strip()
    if plugin_data:
        resolved = Path(plugin_data).expanduser().resolve()
        if resolved.parent.name.lower() == "plugin_data" and resolved.name.lower() != PLUGIN_NAME:
            return resolved.parent / PLUGIN_NAME
        return resolved
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / PLUGIN_NAME


@contextmanager
def _with_settings_lock(state_dir: Path):
    lock_fd: int | None = None
    lock_path = state_dir / ".settings.lock"
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 0.32
        while True:
            try:
                lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                try:
                    if time.time() - lock_path.stat().st_mtime > 2.0:
                        lock_path.unlink()
                        continue
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.008)
            except OSError:
                break
    except OSError:
        pass

    try:
        yield
    finally:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass
            try:
                lock_path.unlink()
            except OSError:
                pass


def save_json_atomic(file_path: Path, data: dict) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=str(file_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(serialized)
        last_err: Exception | None = None
        for attempt in range(6):
            try:
                os.replace(tmp_name, file_path)
                last_err = None
                break
            except PermissionError as exc:
                last_err = exc
                if os.name != "nt":
                    raise
                time.sleep(0.01 * (attempt + 1))
        if last_err is not None:
            file_path.write_text(serialized, encoding="utf-8", newline="\n")
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def is_gh_cli_authenticated(
    *,
    bin_name: str = "gh",
    args: tuple[str, ...] | list[str] = ("auth", "status"),
    timeout_sec: float = GH_AUTH_CHECK_TIMEOUT_SEC,
    env: dict[str, str] | None = None,
) -> bool:
    try:
        raw_timeout = float(timeout_sec)
    except (TypeError, ValueError):
        raw_timeout = GH_AUTH_CHECK_TIMEOUT_SEC
    effective_timeout = (
        min(GH_AUTH_CHECK_TIMEOUT_SEC, max(0.05, raw_timeout))
        if raw_timeout > 0
        else GH_AUTH_CHECK_TIMEOUT_SEC
    )
    base_env = dict(os.environ if env is None else env)
    base_env["GH_PROMPT_DISABLED"] = "1"
    base_env["NO_COLOR"] = "1"

    has_sep = ("/" in bin_name) or (os.sep in bin_name) or bool(os.altsep and os.altsep in bin_name)
    if has_sep:
        resolved_bin: str | None = bin_name
    else:
        env_path = ""
        for key, val in base_env.items():
            if key.upper() == "PATH" and isinstance(val, str):
                env_path = val
                break
        resolved_bin = shutil.which(bin_name, path=env_path)
        if not resolved_bin:
            return False

    run_kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "timeout": effective_timeout,
        "env": base_env,
        "check": False,
    }
    if os.name == "nt":
        run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        res = subprocess.run([resolved_bin, *args], **run_kwargs)
        return bool(res.returncode == 0)
    except Exception:
        return False


def print_star_followup_hint(
    *,
    mode: str = "install",
    gh_authenticated: bool | None = None,
) -> None:
    is_authed = is_gh_cli_authenticated() if gh_authenticated is None else bool(gh_authenticated)
    if mode in ("check", "status", "doctor"):
        print(f"[agy-cmd] 自检通过 · 追踪兼容性更新或点 Star：{GITHUB_REPO_URL}")
        if is_authed:
            print(f"[agy-cmd] 检测到已登录 GitHub CLI（可手动点 Star）：{GH_STAR_COMMAND}")
        return
    print()
    print("[agy-cmd] Antigravity 更新频繁，去 GitHub 点 Star / Watch Releases 防升级失效：")
    print(f"          {GITHUB_REPO_URL}")
    if is_authed:
        print("[agy-cmd] 检测到已登录 GitHub CLI，也可随时在终端手动执行点 Star：")
        print(f"          {GH_STAR_COMMAND}")


def normalize_star_prompt_state(raw: object) -> dict:
    defaults = {
        "state": "pending",
        "triggeredAt": None,
        "resolvedAt": None,
        "milestoneAutoRetries": 0,
    }
    obj = raw
    if isinstance(raw, str):
        trimmed = raw.strip()
        if not trimmed:
            return dict(defaults)
        try:
            obj = json.loads(trimmed)
        except Exception:
            return dict(defaults)
    if not isinstance(obj, dict):
        return dict(defaults)
    src = obj.get("starPrompt") if "starPrompt" in obj else obj
    if not isinstance(src, dict):
        return dict(defaults)
    raw_state = src.get("state")
    state = raw_state if isinstance(raw_state, str) and raw_state in STAR_PROMPT_STATES else "pending"

    def _norm_iso(val: object) -> str | None:
        if not isinstance(val, str):
            return None
        t = val.strip()
        return t if t and len(t) <= 64 else None

    milestone = 0
    raw_count = src.get("milestoneAutoRetries")
    if isinstance(raw_count, (int, float)) and not isinstance(raw_count, bool):
        num_val = float(raw_count)
        if math.isfinite(num_val) and num_val >= 0:
            milestone = int(num_val)
    elif isinstance(raw_count, str) and raw_count.strip():
        try:
            parsed_num = float(raw_count.strip())
            if math.isfinite(parsed_num) and parsed_num >= 0:
                milestone = int(parsed_num)
        except (ValueError, OverflowError):
            pass

    return {
        "state": state,
        "triggeredAt": _norm_iso(src.get("triggeredAt")),
        "resolvedAt": _norm_iso(src.get("resolvedAt")),
        "milestoneAutoRetries": milestone,
    }


def default_settings() -> dict:
    return {
        "version": 2,
        "planTier": "free",
        "boostEnabled": False,
        "autoRetryMode": "count",
        "autoRetryMax": DEFAULT_RETRY_MAX,
        "autoRetryScope": "smart",
        "freeFallbackEnabled": True,
        "planFallbackEnabled": True,
        "configuredByUser": False,
        "onboardingShown": False,
        "stats": {
            "totalAutoRetries": 0,
            "lastAutoRetryAt": "",
            "lastAutoRetryConvId": "",
        },
        "starPrompt": normalize_star_prompt_state(None),
        "updatedAt": "",
    }


def load_settings(state_dir: Path) -> dict:
    base = default_settings()
    settings_path = state_dir / "settings.json"
    if not settings_path.is_file():
        return base
    try:
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            base.update({k: v for k, v in raw.items() if k not in ("stats", "starPrompt")})
            if isinstance(raw.get("stats"), dict):
                base["stats"].update(raw["stats"])
            base["starPrompt"] = normalize_star_prompt_state(raw.get("starPrompt"))
            if (
                raw.get("version") == 1
                and raw.get("configuredByUser") is False
                and raw.get("autoRetryScope") == "goal_only"
            ):
                base["autoRetryScope"] = "smart"
            base["version"] = 2
    except Exception:
        return default_settings()
    if base.get("autoRetryScope") not in ("smart", "all_failures", "goal_only"):
        base["autoRetryScope"] = "smart"
    if base.get("planTier") != "paid":
        base["planTier"] = "free"
        base["boostEnabled"] = False
    base["starPrompt"] = normalize_star_prompt_state(base.get("starPrompt"))
    return base


def format_settings_summary(settings: dict) -> str:
    mode = settings.get("autoRetryMode", "count")
    raw_scope = settings.get("autoRetryScope", "smart")
    if raw_scope == "all_failures":
        scope = "所有失败均触发"
    elif raw_scope == "goal_only":
        scope = "仅口令触发"
    else:
        scope = "智能无感触发"
    if mode == "off":
        retry_str = "不用重试（已关闭）"
    elif mode == "infinite":
        retry_str = f"一直重试直至全绿（{scope}）"
    else:
        retry_str = f"最多重试 {settings.get('autoRetryMax', DEFAULT_RETRY_MAX)} 次（{scope}）"

    tier = settings.get("planTier", "free")
    boost_on = bool(tier == "paid" and settings.get("boostEnabled"))
    if boost_on:
        tier_str = "Pro/Ultra 会员（已开启 /boost 自动接入）"
    elif tier == "paid":
        tier_str = "Pro/Ultra 会员（已关闭 /boost 自动接入）"
    else:
        tier_str = "免费版默认（已关闭 /boost 防报错）"
    return f"自动重试={retry_str} | 套餐档位={tier_str}"


def parse_auto_retry_arg(raw_val: str) -> tuple[str, int | None]:
    v = raw_val.strip().lower()
    if v in ("off", "0", "false", "none", "disable", "disabled", "关闭", "不重试", "不用重试"):
        return "off", None
    if v in ("infinite", "inf", "forever", "unlimited", "-1", "无限", "一直", "一直重试"):
        return "infinite", None
    try:
        n = int(v)
    except ValueError as exc:
        raise SystemExit(
            f"ERROR：无效的 --auto-retry 值 '{raw_val}'（可选：off / 0 / 1..{MAX_RETRY_MAX} / infinite）"
        ) from exc
    if n == 0:
        return "off", None
    if n < MIN_RETRY_MAX or n > MAX_RETRY_MAX:
        raise SystemExit(f"ERROR：重试次数需在 {MIN_RETRY_MAX}..{MAX_RETRY_MAX} 之间（收到：{n}）")
    return "count", n


def apply_settings_cli(
    state_dir: Path,
    auto_retry: str | None,
    retry_scope: str | None,
    plan_tier: str | None,
    boost_flag: str | None,
) -> dict:
    with _with_settings_lock(state_dir):
        current = load_settings(state_dir)
        if auto_retry is not None:
            mode, count_val = parse_auto_retry_arg(auto_retry)
            current["autoRetryMode"] = mode
            if count_val is not None:
                current["autoRetryMax"] = count_val
        if retry_scope is not None:
            current["autoRetryScope"] = retry_scope
        if plan_tier is not None:
            current["planTier"] = plan_tier
            if plan_tier == "free":
                current["boostEnabled"] = False
            elif plan_tier == "paid" and boost_flag is None:
                current["boostEnabled"] = True
        if boost_flag is not None:
            want_on = boost_flag == "on"
            if want_on and current["planTier"] != "paid":
                if plan_tier == "free":
                    raise SystemExit(
                        "ERROR：免费版模式（--plan-tier free）下不能开启 --boost on，以防触发权限报错。"
                    )
                current["planTier"] = "paid"
            current["boostEnabled"] = want_on

        current["configuredByUser"] = True
        current["onboardingShown"] = True
        current["updatedAt"] = datetime.now(timezone.utc).isoformat()
        save_json_atomic(state_dir / "settings.json", current)
        return current


def load_config_json(config_path: Path) -> tuple[dict, bool]:
    if not config_path.is_file():
        return {}, False
    try:
        raw = config_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        raise SystemExit(f"ERROR：无法解析 {config_path}（为避免损坏配置已中止）：{exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR：{config_path} 根节点不是 JSON 对象。")
    return data, True


def get_plugin_enabled_state(config_dir: Path) -> tuple[bool, str | None]:
    config_path = config_dir / "config.json"
    if not config_path.is_file():
        return True, None
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return True, f"config.json 解析失败（{config_path}）：{exc}"
    if not isinstance(data, dict):
        return True, f"config.json 根节点不是 JSON 对象（{config_path}）"
    entry = (data.get("plugins") or {}).get(PLUGIN_NAME)
    if isinstance(entry, dict) and "enabled" in entry:
        return bool(entry["enabled"]), None
    return True, None


def validate_hooks_json(plugin_dir: Path, hooks_path: Path) -> list[str]:
    issues: list[str] = []
    if not hooks_path.is_file():
        return [f"缺少钩子配置文件：{hooks_path}"]
    try:
        data = json.loads(hooks_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"钩子配置文件 JSON 无效（{hooks_path}）：{exc}"]
    if not isinstance(data, dict) or not data:
        return [f"钩子配置文件为空或格式无效：{hooks_path}"]

    has_post = False
    has_pre = False
    has_stop = False
    for hook_name, spec in data.items():
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            continue
        post_groups = spec.get("PostToolUse")
        if isinstance(post_groups, list):
            for grp in post_groups:
                if isinstance(grp, dict) and isinstance(grp.get("hooks"), list):
                    for handler in grp["hooks"]:
                        cmd = handler.get("command", "") if isinstance(handler, dict) else ""
                        if cmd:
                            has_post = True
                            _check_hook_script_exists(plugin_dir, cmd, hook_name, issues)
        for flat_event, flag_name in (("SessionStart", "session"), ("PreInvocation", "pre"), ("Stop", "stop")):
            handlers = spec.get(flat_event)
            if isinstance(handlers, list):
                for handler in handlers:
                    if isinstance(handler, dict) and "matcher" in handler:
                        issues.append(f"{flat_event} 应为平铺 handler 数组，不应包含 matcher（{hook_name}）")
                    cmd = handler.get("command", "") if isinstance(handler, dict) else ""
                    if cmd:
                        if flag_name == "pre":
                            has_pre = True
                        elif flag_name == "stop":
                            has_stop = True
                        _check_hook_script_exists(plugin_dir, cmd, hook_name, issues)

    if not has_post:
        issues.append(f"钩子配置缺少有效的 PostToolUse 处理器：{hooks_path}")
    if not has_pre:
        issues.append(f"钩子配置缺少有效的 PreInvocation 处理器：{hooks_path}")
    if not has_stop:
        issues.append(f"钩子配置缺少有效的 Stop 处理器：{hooks_path}")
    return issues


def validate_sidecar(plugin_dir: Path) -> list[str]:
    issues: list[str] = []
    panel_dir = plugin_dir / "sidecars" / "panel"
    for req_name in ("sidecar.json", "server.mjs", "index.html"):
        fp = panel_dir / req_name
        if not fp.is_file():
            issues.append(f"缺少右侧边栏面板文件：{fp}")
    server_fp = panel_dir / "server.mjs"
    if server_fp.is_file():
        try:
            srv_src = server_fp.read_text(encoding="utf-8", errors="replace")
            if "api-handler.mjs" in srv_src and not (panel_dir / "api-handler.mjs").is_file():
                issues.append(f"缺少右侧边栏面板文件：{panel_dir / 'api-handler.mjs'}")
        except OSError:
            pass
    return issues


def validate_bundle_sync(plugin_dir: Path) -> list[str]:
    source_root = Path(__file__).resolve().parents[3]
    if not (source_root / "plugin.json").is_file():
        return []
    if source_root.resolve() == plugin_dir.resolve():
        return []
    manifest_fp = plugin_dir / "plugin.json"
    if not manifest_fp.is_file():
        return []
    try:
        manifest_obj = json.loads(manifest_fp.read_text(encoding="utf-8"))
    except Exception:
        return [f"插件清单 JSON 无效：{manifest_fp}"]
    if not isinstance(manifest_obj, dict) or "version" not in manifest_obj:
        # Synthetic minimal skeleton without version metadata
        return []

    issues: list[str] = []
    for rel_file in ("plugin.json", "hooks.json", "package.json"):
        src_fp = source_root / rel_file
        dst_fp = plugin_dir / rel_file
        if not src_fp.is_file():
            continue
        if not dst_fp.is_file():
            issues.append(f"缺少插件运行文件：{dst_fp}")
        elif normalize_lf(src_fp.read_text(encoding="utf-8")) != normalize_lf(
            dst_fp.read_text(encoding="utf-8")
        ):
            issues.append(f"插件运行文件与源码仓库存在漂移：{dst_fp}")

    for dir_name in ("hooks", "sidecars", "skills"):
        src_dir = source_root / dir_name
        if not src_dir.is_dir():
            continue
        for src_fp in sorted(src_dir.rglob("*")):
            if not src_fp.is_file():
                continue
            if "__pycache__" in src_fp.parts or src_fp.suffix in (".pyc", ".pyo"):
                continue
            rel = src_fp.relative_to(source_root)
            dst_fp = plugin_dir / rel
            if not dst_fp.is_file():
                issues.append(f"缺少插件运行文件：{dst_fp}")
                continue
            try:
                src_txt = normalize_lf(src_fp.read_text(encoding="utf-8"))
                dst_txt = normalize_lf(dst_fp.read_text(encoding="utf-8"))
                if src_txt != dst_txt:
                    issues.append(f"插件运行文件与源码仓库存在漂移：{dst_fp}")
            except UnicodeDecodeError:
                if src_fp.read_bytes() != dst_fp.read_bytes():
                    issues.append(f"插件运行文件与源码仓库存在漂移：{dst_fp}")
    return issues


def _check_hook_script_exists(plugin_dir: Path, command: str, hook_name: str, issues: list[str]) -> None:
    checked_any = False
    for dir_seg, file_seg in re.findall(
        r"s0=/([A-Za-z0-9_.-]+)/\.source;s1=/([A-Za-z0-9_.-]+\.(?:m?js|cjs))/\.source",
        command,
    ):
        checked_any = True
        script_path = (plugin_dir / dir_seg / file_seg).resolve()
        if not script_path.is_file():
            issues.append(f"钩子 {hook_name} 引用的脚本不存在：{script_path}")

    for quoted_rel in re.findall(r"\br\s*=\s*['\"](\.?/?hooks/[A-Za-z0-9_./-]+\.(?:m?js|cjs))['\"]", command):
        checked_any = True
        script_path = (plugin_dir / quoted_rel).resolve()
        if not script_path.is_file():
            issues.append(f"钩子 {hook_name} 引用的脚本不存在：{script_path}")

    if not checked_any:
        tokens = command.split()
        for tok in tokens:
            cleaned = tok.strip("\"'")
            if cleaned.startswith("./") or cleaned.startswith(".\\"):
                script_path = (plugin_dir / cleaned).resolve()
                if not script_path.is_file():
                    issues.append(f"钩子 {hook_name} 引用的脚本不存在：{script_path}")


def remove_legacy_duplicate_skill(config_dir: Path, plugin_dir: Path) -> Path | None:
    legacy_skill_dir = config_dir / "skills" / PLUGIN_NAME
    legacy_skill_md = legacy_skill_dir / "SKILL.md"
    plugin_skill_dir = plugin_dir / "skills" / PLUGIN_NAME
    plugin_skill_md = plugin_skill_dir / "SKILL.md"
    if not legacy_skill_md.is_file() or not plugin_skill_md.is_file():
        return None
    if legacy_skill_dir.is_symlink():
        legacy_skill_dir.unlink()
        return legacy_skill_dir
    if legacy_skill_dir.resolve() == plugin_skill_dir.resolve():
        return None
    shutil.rmtree(legacy_skill_dir)
    return legacy_skill_dir


def set_plugin_enabled(config_dir: Path, enabled: bool) -> Path:
    config_path = config_dir / "config.json"
    data, _ = load_config_json(config_path)
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}
        data["plugins"] = plugins
    entry = plugins.get(PLUGIN_NAME)
    if not isinstance(entry, dict):
        entry = {}
    entry["enabled"] = bool(enabled)
    plugins[PLUGIN_NAME] = entry
    save_json_atomic(config_path, data)
    return config_path


def _clean_pycache_dirs(root_dir: Path) -> None:
    if not root_dir.is_dir():
        return
    for cache_dir in list(root_dir.rglob("__pycache__")):
        if cache_dir.is_dir():
            shutil.rmtree(cache_dir, ignore_errors=True)


def sync_plugin_bundle_if_needed(target_plugin_dir: Path) -> bool:
    """When invoked from a cloned source checkout containing plugin.json, sync runtime files into target_plugin_dir."""
    source_root = Path(__file__).resolve().parents[3]
    if not (source_root / "plugin.json").is_file():
        return False
    if source_root.resolve() == target_plugin_dir.resolve():
        return True

    ignore_fn = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo")
    target_plugin_dir.mkdir(parents=True, exist_ok=True)
    for item_name in ("plugin.json", "hooks.json", "package.json", "README.md", "README.zh-CN.md", "install.ps1", "install.sh"):
        src_file = source_root / item_name
        if src_file.is_file():
            shutil.copy2(src_file, target_plugin_dir / item_name)
    for dir_name in ("assets", "rules", "hooks", "sidecars", "skills", "test"):
        src_dir = source_root / dir_name
        if src_dir.is_dir():
            shutil.copytree(
                src_dir,
                target_plugin_dir / dir_name,
                dirs_exist_ok=True,
                ignore=ignore_fn,
            )
    _clean_pycache_dirs(target_plugin_dir)
    return True


def sync_skill_if_needed(config_dir: Path) -> str | None:
    skill_source = Path(__file__).resolve().parent.parent
    target_skill_dir = config_dir / "skills" / PLUGIN_NAME
    if skill_source.resolve() == target_skill_dir.resolve():
        return None
    if (skill_source / "SKILL.md").is_file() and not (target_skill_dir / "SKILL.md").is_file():
        target_skill_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            skill_source,
            target_skill_dir,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
        )
        return str(target_skill_dir)
    return None


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(
        description="管理 Antigravity agy-cmd 插件、自动续跑次数与套餐档位设置"
    )
    group = parser.add_mutually_exclusive_group(required=False)
    group.add_argument("--install", action="store_true", help="启用并同步 agy-cmd 自动路由规则")
    group.add_argument("--remove", action="store_true", help="停用插件或移除独立自动路由规则")
    group.add_argument("--status", action="store_true", help="查看当前插件、面板、钩子与重试配置状态")
    group.add_argument("--sync-check", action="store_true", help="校验磁盘规则、钩子与面板完整性且无漂移")

    parser.add_argument(
        "--auto-retry",
        default=None,
        help="设置自动重试档位：off (或 0) / 1..50 / infinite",
    )
    parser.add_argument(
        "--retry-scope",
        choices=["smart", "all_failures", "goal_only"],
        default=None,
        help="设置自动重试触发范围：smart（默认，智能无感触发）、all_failures（所有失败均触发）或 goal_only（仅口令触发）",
    )
    parser.add_argument(
        "--plan-tier",
        choices=["free", "paid"],
        default=None,
        help="设置账号档位：free（默认防报错）或 paid（Pro/Ultra 会员）",
    )
    parser.add_argument(
        "--boost",
        choices=["on", "off"],
        default=None,
        help="开启或关闭计划获批后的 Boost 自动执行与卡壳提示（开启时自动切至 paid 档位）",
    )
    parser.add_argument(
        "--standalone",
        action="store_true",
        help="强制使用独立规则模式（~/.gemini/config/rules/agy-auto-router.md）",
    )
    parser.add_argument(
        "--config-dir",
        default=None,
        help="可选：指定自定义配置根目录（默认使用 ~/.gemini/config）",
    )
    parser.add_argument(
        "--state-dir",
        default=None,
        help="可选：指定自定义插件状态目录（默认使用 PLUGIN_DATA）",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以纯 JSON 格式输出 --status 或 --sync-check 结果（不包含文本提示）",
    )
    args = parser.parse_args(argv)

    has_settings_mutation = any(
        x is not None for x in (args.auto_retry, args.retry_scope, args.plan_tier, args.boost)
    )
    has_lifecycle_action = any((args.install, args.remove, args.status, args.sync_check))
    if not has_settings_mutation and not has_lifecycle_action:
        parser.error("请至少指定一项操作（如 --status / --install / --auto-retry / --plan-tier / --boost）")

    config_dir = resolve_config_dir(args.config_dir)
    state_dir = resolve_state_dir(args.state_dir)
    plugin_dir = config_dir / "plugins" / PLUGIN_NAME
    plugin_manifest = plugin_dir / "plugin.json"
    plugin_rule_path = plugin_dir / "rules" / "AGENTS.md"
    plugin_hooks_path = plugin_dir / "hooks.json"
    standalone_rule_path = config_dir / "rules" / RULE_FILENAME
    legacy_skill_path = config_dir / "skills" / PLUGIN_NAME / "SKILL.md"
    has_plugin = plugin_manifest.is_file()

    if has_settings_mutation:
        updated = apply_settings_cli(
            state_dir,
            auto_retry=args.auto_retry,
            retry_scope=args.retry_scope,
            plan_tier=args.plan_tier,
            boost_flag=args.boost,
        )
        if not args.json:
            print(f"已更新 agy-cmd 运行设置（{state_dir / 'settings.json'}）：")
            print(f"  {format_settings_summary(updated)}")
        if not has_lifecycle_action:
            if args.json:
                print(json.dumps({"ok": True, "settings": updated}, ensure_ascii=False))
            return 0

    if args.status:
        settings = load_settings(state_dir)
        if has_plugin:
            enabled, cfg_warning = get_plugin_enabled_state(config_dir)
            rule_ok = plugin_rule_path.is_file() and normalize_lf(
                plugin_rule_path.read_text(encoding="utf-8")
            ) == normalize_lf(RULE_BODY)
            hook_issues = validate_hooks_json(plugin_dir, plugin_hooks_path)
            sidecar_issues = validate_sidecar(plugin_dir)
            drift_issues = validate_bundle_sync(plugin_dir)
            warnings = list(hook_issues) + list(sidecar_issues) + list(drift_issues)
            if cfg_warning:
                warnings.insert(0, cfg_warning)
            if standalone_rule_path.is_file():
                warnings.append(f"检测到旧版独立规则，可能造成重复注入：{standalone_rule_path}")
            if legacy_skill_path.is_file():
                warnings.append(f"检测到旧版独立 Skill，可能造成重复加载：{legacy_skill_path.parent}")
            healthy = bool(enabled and rule_ok and not warnings)
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": healthy,
                            "installed": True,
                            "mode": "plugin",
                            "enabled": enabled,
                            "ruleSynced": rule_ok,
                            "pluginDir": str(plugin_dir),
                            "issues": warnings,
                            "settings": settings,
                        },
                        ensure_ascii=False,
                    )
                )
                return 0
            print(f"模式：正式插件（{plugin_dir}）")
            print(f"插件状态：{'已启用' if enabled else '已停用'}")
            if cfg_warning:
                print(f"警告：{cfg_warning}")
            print(
                f"插件规则：{'已同步' if rule_ok else ('存在漂移' if plugin_rule_path.is_file() else '缺失')}（{plugin_rule_path}）"
            )
            print(f"生命周期钩子：{'已配置' if not hook_issues else '异常/缺失'}（{plugin_hooks_path}）")
            print(
                f"右侧边栏面板：{'已就绪 (sidecar://agy-cmd/panel/)' if not sidecar_issues else '缺失文件'}"
            )
            print(f"当前策略：{format_settings_summary(settings)}")
            if not settings.get("configuredByUser"):
                print(POST_INSTALL_REMINDER)
            for issue in [*hook_issues, *sidecar_issues, *drift_issues]:
                print(f"警告：{issue}")
            if standalone_rule_path.is_file():
                print(f"警告：检测到旧版独立规则，可能造成重复注入：{standalone_rule_path}")
            if legacy_skill_path.is_file():
                print(f"警告：检测到旧版独立 Skill，可能造成重复加载：{legacy_skill_path.parent}")
            if healthy:
                print_star_followup_hint(mode="status")
            return 0
        if standalone_rule_path.is_file():
            synced = normalize_lf(standalone_rule_path.read_text(encoding="utf-8")) == normalize_lf(
                RULE_CONTENT
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": synced,
                            "installed": True,
                            "mode": "standalone",
                            "enabled": True,
                            "ruleSynced": synced,
                            "rulePath": str(standalone_rule_path),
                            "issues": [] if synced else [f"独立规则存在漂移：{standalone_rule_path}"],
                        },
                        ensure_ascii=False,
                    )
                )
                return 0
            print(
                f"模式：独立规则 | 状态：已启用（{'已同步' if synced else '存在漂移'}，{standalone_rule_path}）"
            )
            if synced:
                print_star_followup_hint(mode="status")
            return 0
        if args.json:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "installed": False,
                        "mode": None,
                        "enabled": False,
                        "issues": [f"未检测到插件 {plugin_dir} 或独立规则 {standalone_rule_path}"],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        print(f"状态：未启用（未检测到插件 {plugin_dir} 或独立规则 {standalone_rule_path}）")
        return 0

    if args.sync_check:
        if has_plugin and not args.standalone:
            issues: list[str] = []
            if not plugin_rule_path.is_file():
                issues.append(f"缺少插件规则文件：{plugin_rule_path}")
            else:
                disk = normalize_lf(plugin_rule_path.read_text(encoding="utf-8"))
                if disk != normalize_lf(RULE_BODY):
                    issues.append(f"插件规则与脚本 RULE_BODY 存在漂移：{plugin_rule_path}")
            if standalone_rule_path.is_file():
                issues.append(f"存在重复的旧版独立规则：{standalone_rule_path}")
            if legacy_skill_path.is_file():
                issues.append(f"存在重复的旧版独立 Skill：{legacy_skill_path.parent}")
            issues.extend(validate_hooks_json(plugin_dir, plugin_hooks_path))
            issues.extend(validate_sidecar(plugin_dir))
            issues.extend(validate_bundle_sync(plugin_dir))
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": len(issues) == 0,
                            "installed": True,
                            "mode": "plugin",
                            "pluginDir": str(plugin_dir),
                            "issues": issues,
                        },
                        ensure_ascii=False,
                    )
                )
                return 2 if issues else 0
            if issues:
                for item in issues:
                    print(f"FAIL：{item}")
                return 2
            print(f"OK：插件规则、钩子与右侧面板均已零漂移同步且无重复加载（{plugin_rule_path}）")
            print_star_followup_hint(mode="check")
            return 0

        if not standalone_rule_path.is_file():
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "installed": False,
                            "mode": "standalone",
                            "issues": [f"独立规则不存在：{standalone_rule_path}"],
                        },
                        ensure_ascii=False,
                    )
                )
                return 1
            print(f"FAIL：独立规则不存在：{standalone_rule_path}")
            return 1
        disk = normalize_lf(standalone_rule_path.read_text(encoding="utf-8"))
        if disk != normalize_lf(RULE_CONTENT):
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "installed": True,
                            "mode": "standalone",
                            "issues": [f"独立规则与脚本 RULE_CONTENT 存在漂移：{standalone_rule_path}"],
                        },
                        ensure_ascii=False,
                    )
                )
                return 2
            print(f"FAIL：独立规则与脚本 RULE_CONTENT 存在漂移：{standalone_rule_path}")
            return 2
        if args.json:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "installed": True,
                        "mode": "standalone",
                        "rulePath": str(standalone_rule_path),
                        "issues": [],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        print(f"OK：独立规则已零漂移同步（{standalone_rule_path}）")
        print_star_followup_hint(mode="check")
        return 0

    if args.remove:
        if has_plugin and not args.standalone:
            cfg = set_plugin_enabled(config_dir, False)
            removed_legacy = False
            if standalone_rule_path.is_file():
                standalone_rule_path.unlink()
                removed_legacy = True
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "mode": "plugin",
                            "enabled": False,
                            "configPath": str(cfg),
                            "removedLegacyRule": removed_legacy,
                        },
                        ensure_ascii=False,
                    )
                )
                return 0
            print(f"已在配置中停用 {PLUGIN_NAME} 插件：{cfg}")
            if removed_legacy:
                print(f"已同时清理旧版独立规则：{standalone_rule_path}")
            return 0
        existed = standalone_rule_path.is_file()
        if existed:
            standalone_rule_path.unlink()
        if args.json:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "standalone",
                        "enabled": False,
                        "removed": existed,
                        "rulePath": str(standalone_rule_path),
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        if existed:
            print(f"已移除全局自动路由规则：{standalone_rule_path}")
        else:
            print(f"无需移除，规则文件不存在：{standalone_rule_path}")
        return 0

    if args.install:
        if not args.standalone and (has_plugin or (Path(__file__).resolve().parents[3] / "plugin.json").is_file()):
            synced_bundle = sync_plugin_bundle_if_needed(plugin_dir)
            plugin_rule_path.parent.mkdir(parents=True, exist_ok=True)
            plugin_rule_path.write_text(RULE_BODY, encoding="utf-8", newline="\n")
            cfg = set_plugin_enabled(config_dir, True)
            had_legacy_rule = standalone_rule_path.is_file()
            if had_legacy_rule:
                standalone_rule_path.unlink()
            removed_skill = remove_legacy_duplicate_skill(config_dir, plugin_dir)
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "mode": "plugin",
                            "enabled": True,
                            "pluginDir": str(plugin_dir),
                            "configPath": str(cfg),
                            "syncedBundle": synced_bundle,
                        },
                        ensure_ascii=False,
                    )
                )
                return 0
            if synced_bundle and Path(__file__).resolve().parents[3].resolve() != plugin_dir.resolve():
                print(f"已将完整插件包同步安装至：{plugin_dir}")
            print(f"已同步并启用插件规则：{plugin_rule_path}")
            print(f"已确认插件启用状态：{cfg}")
            if had_legacy_rule:
                print(f"已清理旧版独立规则以防重复加载：{standalone_rule_path}")
            if removed_skill is not None:
                print(f"已清理旧版独立 Skill 以防重复加载：{removed_skill}")
            print()
            print(POST_INSTALL_REMINDER)
            print_star_followup_hint(mode="install")
            return 0

        standalone_rule_path.parent.mkdir(parents=True, exist_ok=True)
        standalone_rule_path.write_text(RULE_CONTENT, encoding="utf-8", newline="\n")
        synced = sync_skill_if_needed(config_dir)
        if args.json:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "standalone",
                        "enabled": True,
                        "rulePath": str(standalone_rule_path),
                        "syncedSkillDir": synced,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        print(f"已启用全局常驻自动路由规则（独立模式）：{standalone_rule_path}")
        if synced:
            print(f"已同步桌面端 Skill 目录：{synced}")
        print_star_followup_hint(mode="install")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
