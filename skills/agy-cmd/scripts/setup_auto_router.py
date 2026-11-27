#!/usr/bin/env python3
"""Install, check, sync-verify, configure retry/tier settings, or disable agy-cmd."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
from datetime import datetime, timezone
import json
import math
import os
import posixpath
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MIN_PYTHON_VERSION = (3, 8)
PLUGIN_NAME = "agy-cmd"
RULE_FILENAME = "agy-auto-router.md"
MIN_RETRY_MAX = 1
MAX_RETRY_MAX = 50
DEFAULT_RETRY_MAX = 3
MAX_DELIVERY_CMD_LEN = 240
MAX_CUSTOM_SEGMENTS = 8
MAX_CHAIN_PARTS = 32
SETTINGS_VERSION = 3
SETTINGS_LOCK_STALE_SEC = 2.0
SETTINGS_LOCK_DEAD_PID_GRACE_SEC = 0.1
SETTINGS_LOCK_DEFAULT_WAIT_SEC = 1.0
SETTINGS_LOCK_STEP_SEC = 0.008
UPDATE_MARKER_NAME = ".update-in-progress"
UPDATE_JOURNAL_NAME = "journal.json"
UPDATE_WORK_PREFIX = ".agy-cmd-update-"
UPDATE_STALE_MARKER_MS = 10 * 60 * 1000
BUNDLE_ROOT_FILES = (
    "plugin.json",
    "hooks.json",
    "package.json",
    "README.md",
    "README.zh-CN.md",
    "install.ps1",
    "install.sh",
    "LICENSE",
    "SECURITY.md",
)
BUNDLE_DIRS = ("assets", "rules", "agents", "hooks", "sidecars", "skills", "test")
PRESERVED_HIDDEN_FILES = {UPDATE_MARKER_NAME, ".gitignore"}
CD_SEGMENT_RE = re.compile(r"^(?:cd(?:\s+/d)?|pushd|Set-Location(?:\s+-Path)?)\s+(.+)$", re.IGNORECASE)


class SettingsLockTimeoutError(RuntimeError):
    code = "SETTINGS_LOCK_TIMEOUT"
    retryable = True


class UpdateTransactionError(RuntimeError):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _ensure_supported_python_version() -> None:
    if sys.version_info < MIN_PYTHON_VERSION:
        cur = f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"
        req = f"{MIN_PYTHON_VERSION[0]}.{MIN_PYTHON_VERSION[1]}"
        raise SystemExit(f"ERROR：agy-cmd 需要 Python >= {req}（当前版本：{cur}）。")

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

仅桌面 App/IDE，工作区 `AGENTS.md` 优先。子智能体、Swarm 成员、Workflow Worker 跳过路由，按任务书或留言板执行。技能缺失时依本规则。

- 仅触发带徽标的动作时首行给 1 个对应徽标。勿复推已用命令，禁推 CLI `/undo`、`/branch`、`/effort`。
- 需求或边界未定 → `[agy-cmd → /grill-me 追问]`。用 `ask_question` 只问阻碍下一步的问题，独立问题可合问，推荐项置顶 `(Recommended)`。
- 写项目文件前定范围，不明先只读扫描，`apply_edits` 按文件计。改 ≥3 个文件、改公共接口或高风险 → `[agy-cmd → /plan 审批]`，交 `RequestFeedback: true` 计划，获批再写。只读 Plan Mode 拒写计划文件时，正文交方案等审批，严禁用 `exit_plan_mode` 绕过。
- 批处理、多模块默认顺序分批，纯正则直接在本地完成。主动推荐或调用重型命令须同时满足 `planTier=paid`、Antigravity App、宿主开放该项。免费、未知或 IDE 走默认，不亮重型徽标。
- 准入后，≥5 个同质独立项 → `[agy-cmd → /run-workflow]`，先读 `run-workflow`。独立分工先核对接口、文件归属、验证方式，无冲突再给 `[agy-cmd → 建议 /swarm]` 和可复制提示词。未点名运行不调 `swarm`。前后强依赖或紧耦合改动禁止强行并行，留主会话。
- App 内点名运行可单次执行对当前账号开放的该项。`/boost`、`/teamwork` 仅限付费。查用法不算点名运行。
- 主会话有余量才派 1 个 `research` 查独立旁支。动态网页 → `[agy-cmd → /browser]`。App 交互图表 → `[agy-cmd → /generative_ui]`，先读 `generative_ui`。
- 卡壳按钩子指定角色派工，无钩子由主会话排查。待审或只读时只调查。`[agy-cmd → 自动换视角排查]` 始终只读。所有派工由主会话验收，失败接手。
- 改码或修错后实跑现成测试或构建供 `Stop` 核验。续跑和建议 `/goal` 仅用当轮钩子指定的徽标。
- 用户点名 `/goal` 且授权不必逐轮询问时，`/grill-me`、`/plan` 门禁改为写入待确认清单并继续独立任务；产品决策、破坏性迁移、改外部合同或只读 Plan Mode 仍停下确认。长程任务读 `agy-cmd` 技能的 `/goal` 模板。
- 重型准入、调参或查指令读 `agy-cmd` 技能。纯查或对比指令勿输出面板地址。仅安装引导、明确要求开面板或调参时附 Markdown 链接，文字为 `agy-cmd 自动路由`，地址为 `sidecar://agy-cmd/panel/`。
- 其余解释、查找或明确的 1～2 文件低风险修改直接做，不建计划、不推命令。
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
    gemini_home = os.environ.get("GEMINI_HOME", "").strip()
    if gemini_home:
        resolved_home = Path(gemini_home).expanduser().resolve()
        gemini_root = resolved_home if resolved_home.name.lower() == ".gemini" else resolved_home / ".gemini"
        return gemini_root / "antigravity" / "plugin_data" / PLUGIN_NAME
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / PLUGIN_NAME


def _is_pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        try:
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                err = ctypes.get_last_error()
                return err == 5  # ERROR_ACCESS_DENIED => process exists
            try:
                exit_code = ctypes.c_ulong(0)
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return exit_code.value == STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _read_lock_info(lock_path: Path) -> dict | None:
    try:
        raw = lock_path.read_text(encoding="utf-8").lstrip("\ufeff")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return None


def _resolve_settings_lock_wait_sec(max_wait_sec: float | None = None) -> float:
    if max_wait_sec is not None:
        return max(0.0, float(max_wait_sec))
    raw_env = os.environ.get("AGY_CMD_SETTINGS_LOCK_WAIT_MS", "").strip()
    if raw_env:
        try:
            val = float(raw_env)
            if math.isfinite(val) and val >= 0:
                return val / 1000.0
        except ValueError:
            pass
    return SETTINGS_LOCK_DEFAULT_WAIT_SEC


def _is_settings_lock_stale(
    lock_path: Path,
    stale_sec: float,
    pid_alive_fn,
) -> tuple[bool, str | None]:
    try:
        st = lock_path.stat()
    except OSError:
        return False, None
    now_sec = time.time()
    age_sec = now_sec - st.st_mtime
    info = _read_lock_info(lock_path)
    if info and isinstance(info.get("pid"), int) and not isinstance(info.get("pid"), bool):
        pid = info["pid"]
        tok = info.get("token") if isinstance(info.get("token"), str) else None
        raw_ts = info.get("ts")
        ts_age = (now_sec - (float(raw_ts) / 1000.0)) if isinstance(raw_ts, (int, float)) else age_sec
        if pid != os.getpid() and not pid_alive_fn(pid) and age_sec >= SETTINGS_LOCK_DEAD_PID_GRACE_SEC:
            return True, tok
        if ts_age > stale_sec and age_sec > stale_sec:
            return True, tok
        return False, tok
    if age_sec > stale_sec:
        return True, None
    return False, None


def _try_reclaim_stale_settings_lock(
    lock_path: Path,
    expected_token: str | None,
    stale_sec: float,
    pid_alive_fn,
) -> bool:
    stale, cur_token = _is_settings_lock_stale(lock_path, stale_sec, pid_alive_fn)
    if not stale:
        return False
    if expected_token is not None and cur_token != expected_token:
        return False
    try:
        lock_path.unlink()
        return True
    except OSError:
        return False


@contextmanager
def _with_settings_lock(
    state_dir: Path,
    *,
    max_wait_sec: float | None = None,
    stale_sec: float = SETTINGS_LOCK_STALE_SEC,
    pid_alive_fn=None,
):
    lock_path = state_dir / ".settings.lock"
    wait_sec = _resolve_settings_lock_wait_sec(max_wait_sec)
    alive_fn = pid_alive_fn or _is_pid_alive
    token = secrets.token_hex(8)
    acquired = False

    state_dir.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + wait_sec
    while True:
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                record = json.dumps({"pid": os.getpid(), "token": token, "ts": int(time.time() * 1000)}) + "\n"
                os.write(lock_fd, record.encode("utf-8"))
            finally:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            acquired = True
            break
        except FileExistsError:
            stale, stale_tok = _is_settings_lock_stale(lock_path, stale_sec, alive_fn)
            if stale and _try_reclaim_stale_settings_lock(lock_path, stale_tok, stale_sec, alive_fn):
                continue
            if time.monotonic() >= deadline:
                raise SettingsLockTimeoutError(
                    "配置文件当前被其他进程占用（锁等待超时），未执行写入，请稍后重试。"
                )
            time.sleep(SETTINGS_LOCK_STEP_SEC)

    try:
        yield
    finally:
        if acquired:
            try:
                cur = _read_lock_info(lock_path)
                if cur and cur.get("token") == token:
                    lock_path.unlink()
            except OSError:
                pass


def _write_text_lf_atomic(file_path: Path, text: str) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", suffix=".tmp", dir=str(file_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        last_err: Exception | None = None
        for attempt in range(8):
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
            raise last_err
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def save_json_atomic(file_path: Path, data: dict) -> None:
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    _write_text_lf_atomic(file_path, serialized)


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


def _parse_strict_and_chain(raw_cmd: str) -> tuple[list[str] | None, str]:
    s = raw_cmd.strip()
    if not s:
        return [], ""
    parts: list[str] = []
    cur: list[str] = []
    quote = ""
    last_sep = ""
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if quote:
            cur.append(ch)
            if ch == quote and (quote == "'" or (i > 0 and s[i - 1] != "\\")):
                quote = ""
            i += 1
            continue
        if ch in ('"', "'"):
            quote = ch
            cur.append(ch)
            i += 1
            continue
        if ch == "`" or (ch == "$" and i + 1 < n and s[i + 1] == "("):
            return None, "自定义验证命令不支持命令替换语法（反引号或 $()）"
        if ch == "|":
            return None, "自定义验证命令不支持管道（|）或逻辑或（||）"
        if ch == ";":
            seg = "".join(cur).strip()
            if not seg:
                return None, "自定义验证命令包含空的分号命令段"
            if not CD_SEGMENT_RE.match(seg):
                return None, "自定义验证命令仅允许在 cd/pushd/Set-Location 后使用分号（;），其余多段请使用 && 连接"
            parts.append(seg)
            cur = []
            last_sep = ";"
            if len(parts) > MAX_CHAIN_PARTS:
                return None, f"自定义验证命令分段过多（最多支持 {MAX_CUSTOM_SEGMENTS} 个执行段）"
            i += 1
            continue
        if ch == "&":
            if i + 1 < n and s[i + 1] == "&":
                seg = "".join(cur).strip()
                if not seg:
                    return None, "自定义验证命令包含空的 && 命令段"
                parts.append(seg)
                cur = []
                last_sep = "&&"
                if len(parts) > MAX_CHAIN_PARTS:
                    return None, f"自定义验证命令分段过多（最多支持 {MAX_CUSTOM_SEGMENTS} 个执行段）"
                i += 2
                continue
            if (i > 0 and s[i - 1] == ">") or (i + 1 < n and s[i + 1] == ">"):
                cur.append(ch)
                i += 1
                continue
            return None, "自定义验证命令不支持后台操作符（&）"
        cur.append(ch)
        i += 1
    if quote:
        return None, "自定义验证命令存在未闭合的引号"
    tail = "".join(cur).strip()
    if not tail:
        if last_sep:
            return None, f"自定义验证命令末尾存在悬空的 {last_sep}"
    else:
        parts.append(tail)
        if len(parts) > MAX_CHAIN_PARTS:
            return None, f"自定义验证命令分段过多（最多支持 {MAX_CUSTOM_SEGMENTS} 个执行段）"
    return parts, ""


def inspect_delivery_test_command(raw: object) -> tuple[bool, str, str]:
    if not isinstance(raw, str):
        return False, "", "--delivery-test-cmd 必须是字符串。"
    if re.search(r"[\x00-\x08\x0a-\x1f\x7f]", raw):
        return False, "", "--delivery-test-cmd 仅支持单行命令，不能包含换行或控制字符。"
    cleaned = re.sub(r"[ \t]+", " ", raw.strip())
    if not cleaned:
        return True, "", ""
    if len(cleaned) > MAX_DELIVERY_CMD_LEN:
        return False, cleaned, f"--delivery-test-cmd 长度不能超过 {MAX_DELIVERY_CMD_LEN} 字符（收到：{len(cleaned)}）。"
    parts, err = _parse_strict_and_chain(cleaned)
    if parts is None:
        return False, cleaned, err
    exec_count = 0
    for part in parts:
        m = CD_SEGMENT_RE.match(part.strip())
        if m:
            raw_target = m.group(1).strip()
            if not raw_target or raw_target == "-" or re.search(r"[$%`*?<>|;]", raw_target):
                return False, cleaned, "自定义验证命令包含不支持的目录切换目标（不支持 -、环境变量或通配符）"
            continue
        seg = re.sub(r"\s+2>&1\s*$", "", part.strip()).strip()
        if not seg:
            return False, cleaned, "自定义验证命令包含空执行段"
        exec_count += 1
        if exec_count > MAX_CUSTOM_SEGMENTS:
            return False, cleaned, f"自定义验证命令最多支持 {MAX_CUSTOM_SEGMENTS} 个执行段（当前超出上限）"
    if exec_count == 0:
        return False, cleaned, "自定义验证命令未包含可执行验证段"
    return True, cleaned, ""


def sanitize_delivery_test_command(raw: object, *, strict: bool = False) -> str:
    if strict:
        ok, cleaned, err = inspect_delivery_test_command(raw)
        if not ok:
            raise SystemExit(f"ERROR：{err}")
        return cleaned
    if not isinstance(raw, str):
        return ""
    cleaned = re.sub(r"[\x00-\x1f\x7f]+", " ", raw).strip()
    return re.sub(r"[ \t]+", " ", cleaned)[:MAX_DELIVERY_CMD_LEN]


def _is_valid_current_settings_version(raw_version: object) -> bool:
    return (
        isinstance(raw_version, int)
        and not isinstance(raw_version, bool)
        and raw_version >= SETTINGS_VERSION
    )


def normalize_auto_update_state(raw: object) -> dict:
    defaults = {
        "lastAutoUpdatedVersion": "",
        "lastAutoUpdatedFrom": "",
        "lastAutoUpdatedAt": "",
        "lastAutoUpdatedUrl": "",
        "failedVersion": "",
        "failedReason": "",
        "failedAt": "",
    }
    if not isinstance(raw, dict):
        return dict(defaults)

    def _norm(val: object, limit: int = 64) -> str:
        return val.strip()[:limit] if isinstance(val, str) else ""

    raw_url = _norm(raw.get("lastAutoUpdatedUrl"), 256)
    return {
        "lastAutoUpdatedVersion": _norm(raw.get("lastAutoUpdatedVersion"), 32),
        "lastAutoUpdatedFrom": _norm(raw.get("lastAutoUpdatedFrom"), 32),
        "lastAutoUpdatedAt": _norm(raw.get("lastAutoUpdatedAt"), 64),
        "lastAutoUpdatedUrl": raw_url if raw_url.startswith(f"{GITHUB_REPO_URL}/releases/") else "",
        "failedVersion": _norm(raw.get("failedVersion"), 32),
        "failedReason": _norm(raw.get("failedReason"), 64),
        "failedAt": _norm(raw.get("failedAt"), 64),
    }


def default_settings() -> dict:
    return {
        "version": SETTINGS_VERSION,
        "planTier": "free",
        "boostEnabled": False,
        "boostAfterPlanApproval": False,
        "freePlanReviewEnabled": False,
        "autoRetryMode": "count",
        "autoRetryMax": DEFAULT_RETRY_MAX,
        "autoRetryScope": "smart",
        "deliveryTestGateEnabled": False,
        "deliveryTestCommand": "",
        "freeFallbackEnabled": True,
        "planFallbackEnabled": True,
        "autoUpdateCheck": True,
        "autoUpdateInstall": False,
        "autoUpdateState": normalize_auto_update_state(None),
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


def _clamp_retry_max(val: object, fallback: int = DEFAULT_RETRY_MAX) -> int:
    if isinstance(val, bool) or val is None:
        return fallback
    try:
        n = float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return min(MAX_RETRY_MAX, max(MIN_RETRY_MAX, int(math.floor(n))))


def load_settings(state_dir: Path) -> dict:
    base = default_settings()
    settings_path = state_dir / "settings.json"
    raw = None
    for attempt in range(4):
        try:
            if not settings_path.is_file():
                return base
            text = settings_path.read_text(encoding="utf-8")
            if not text.strip() and attempt < 3:
                time.sleep(0.008 * (attempt + 1))
                continue
            raw = json.loads(text)
            break
        except PermissionError:
            if attempt < 3:
                time.sleep(0.008 * (attempt + 1))
                continue
            return default_settings()
        except Exception:
            return default_settings()
    if not isinstance(raw, dict):
        return default_settings()

    base.update({k: v for k, v in raw.items() if k not in ("stats", "starPrompt", "autoUpdateState")})
    raw_stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    raw_total = raw_stats.get("totalAutoRetries", 0)
    total_retries = 0
    if not isinstance(raw_total, bool):
        try:
            num_total = float(raw_total)
            if math.isfinite(num_total) and num_total >= 0:
                total_retries = int(math.floor(num_total))
        except (TypeError, ValueError):
            total_retries = 0
    base["stats"] = {
        "totalAutoRetries": total_retries,
        "lastAutoRetryAt": raw_stats.get("lastAutoRetryAt") if isinstance(raw_stats.get("lastAutoRetryAt"), str) else "",
        "lastAutoRetryConvId": (
            raw_stats.get("lastAutoRetryConvId") if isinstance(raw_stats.get("lastAutoRetryConvId"), str) else ""
        ),
    }
    base["starPrompt"] = normalize_star_prompt_state(raw.get("starPrompt"))
    base["autoUpdateState"] = normalize_auto_update_state(raw.get("autoUpdateState"))
    if (
        raw.get("version") == 1
        and raw.get("configuredByUser") is False
        and raw.get("autoRetryScope") == "goal_only"
    ):
        base["autoRetryScope"] = "smart"
    if not _is_valid_current_settings_version(raw.get("version")):
        base["boostAfterPlanApproval"] = False
    base["version"] = SETTINGS_VERSION

    if base.get("autoRetryMode") not in ("off", "count", "infinite"):
        base["autoRetryMode"] = "count"
    base["autoRetryMax"] = _clamp_retry_max(base.get("autoRetryMax"), DEFAULT_RETRY_MAX)
    if base.get("autoRetryScope") not in ("smart", "all_failures", "goal_only"):
        base["autoRetryScope"] = "smart"
    if base.get("planTier") != "paid":
        base["planTier"] = "free"
        base["boostEnabled"] = False
    else:
        base["boostEnabled"] = base.get("boostEnabled") is True
    base["boostAfterPlanApproval"] = base.get("boostAfterPlanApproval") is True
    base["freePlanReviewEnabled"] = base.get("freePlanReviewEnabled") is True
    base["deliveryTestGateEnabled"] = base.get("deliveryTestGateEnabled") is True
    base["deliveryTestCommand"] = sanitize_delivery_test_command(base.get("deliveryTestCommand"), strict=False)
    base["freeFallbackEnabled"] = (
        base["freeFallbackEnabled"] if isinstance(base.get("freeFallbackEnabled"), bool) else True
    )
    base["planFallbackEnabled"] = (
        base["planFallbackEnabled"] if isinstance(base.get("planFallbackEnabled"), bool) else True
    )
    base["autoUpdateCheck"] = base["autoUpdateCheck"] if isinstance(base.get("autoUpdateCheck"), bool) else True
    base["autoUpdateInstall"] = base.get("autoUpdateInstall") is True
    base["configuredByUser"] = base["configuredByUser"] if isinstance(base.get("configuredByUser"), bool) else False
    base["onboardingShown"] = base["onboardingShown"] if isinstance(base.get("onboardingShown"), bool) else False
    base["updatedAt"] = base["updatedAt"] if isinstance(base.get("updatedAt"), str) else ""
    base["autoUpdateState"] = normalize_auto_update_state(base.get("autoUpdateState"))
    base["starPrompt"] = normalize_star_prompt_state(base.get("starPrompt"))
    return base


def migrate_legacy_settings_if_needed(state_dir: Path) -> bool:
    settings_path = state_dir / "settings.json"
    if not settings_path.is_file():
        return False
    try:
        with _with_settings_lock(state_dir):
            if not settings_path.is_file():
                return False
            raw = json.loads(settings_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return False
            if _is_valid_current_settings_version(raw.get("version")):
                return False
            migrated = load_settings(state_dir)
            save_json_atomic(settings_path, migrated)
            return True
    except Exception:
        return False


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
        review = "开启" if settings.get("freePlanReviewEnabled") is True else "关闭"
        tier_str = f"免费版默认（独立复核{review}）"
    if settings.get("deliveryTestGateEnabled") is True:
        custom_cmd = sanitize_delivery_test_command(settings.get("deliveryTestCommand"), strict=False)
        if custom_cmd:
            cmd_ok, _, cmd_err = inspect_delivery_test_command(custom_cmd)
            gate_str = f"开启（自定义：{custom_cmd}）" if cmd_ok else f"开启（自定义命令无效，需修正：{cmd_err}）"
        else:
            gate_str = "开启（自动探测）"
    else:
        gate_str = "关闭"
    return f"自动重试={retry_str} | 交付门禁={gate_str} | 套餐档位={tier_str}"


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
    free_plan_review: str | None = None,
    delivery_test_gate: str | None = None,
    delivery_test_cmd: str | None = None,
    auto_update_check: str | None = None,
    auto_update_install: str | None = None,
    boost_after_plan_approval: str | None = None,
    free_fallback: str | None = None,
    plan_fallback: str | None = None,
    reset_stats: bool = False,
) -> dict:
    with _with_settings_lock(state_dir):
        current = load_settings(state_dir)
        prev_tier = current["planTier"]
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
            elif plan_tier == "paid" and boost_flag is None and prev_tier == "free":
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
        if boost_after_plan_approval is not None:
            current["boostAfterPlanApproval"] = boost_after_plan_approval == "on"
        if free_plan_review is not None:
            current["freePlanReviewEnabled"] = free_plan_review == "on"
        if delivery_test_gate is not None:
            current["deliveryTestGateEnabled"] = delivery_test_gate == "on"
        if delivery_test_cmd is not None:
            current["deliveryTestCommand"] = sanitize_delivery_test_command(delivery_test_cmd, strict=True)
        if free_fallback is not None:
            current["freeFallbackEnabled"] = free_fallback == "on"
        if plan_fallback is not None:
            current["planFallbackEnabled"] = plan_fallback == "on"
        if auto_update_check is not None:
            current["autoUpdateCheck"] = auto_update_check == "on"
        if auto_update_install is not None:
            want_install = auto_update_install == "on"
            current["autoUpdateInstall"] = want_install
            if want_install and auto_update_check is None and not current.get("autoUpdateCheck", True):
                current["autoUpdateCheck"] = True
        if reset_stats:
            current["stats"] = {
                "totalAutoRetries": 0,
                "lastAutoRetryAt": "",
                "lastAutoRetryConvId": "",
            }

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
        pre_tool_groups = spec.get("PreToolUse")
        if pre_tool_groups is not None:
            if not isinstance(pre_tool_groups, list) or not pre_tool_groups:
                issues.append(f"PreToolUse 配置格式无效（{hook_name}）")
            else:
                for grp in pre_tool_groups:
                    if isinstance(grp, dict) and isinstance(grp.get("hooks"), list):
                        for handler in grp["hooks"]:
                            cmd = handler.get("command", "") if isinstance(handler, dict) else ""
                            if cmd:
                                _check_hook_script_exists(plugin_dir, cmd, hook_name, issues)
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
    checked_sources: list[str] = []
    for entry_name in ("server.mjs", "api-handler.mjs", "version-update.mjs"):
        entry_fp = panel_dir / entry_name
        if entry_fp.is_file():
            try:
                checked_sources.append(entry_fp.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                pass
    joined_src = "\n".join(checked_sources)
    for dep_name in ("api-handler.mjs", "version-check.mjs", "update-archive.mjs", "version-update.mjs"):
        if dep_name in joined_src and not (panel_dir / dep_name).is_file():
            issues.append(f"缺少右侧边栏面板文件：{panel_dir / dep_name}")
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

    for dir_name in ("assets", "agents", "hooks", "sidecars", "skills"):
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
                    if rel.as_posix() == "sidecars/panel/sidecar.json" and _sidecar_json_matches_except_pinned_node(
                        src_txt, dst_txt
                    ):
                        continue
                    issues.append(f"插件运行文件与源码仓库存在漂移：{dst_fp}")
            except UnicodeDecodeError:
                if src_fp.read_bytes() != dst_fp.read_bytes():
                    issues.append(f"插件运行文件与源码仓库存在漂移：{dst_fp}")
    return issues


def validate_verifier(plugin_dir: Path) -> list[str]:
    role = plugin_dir / "agents" / "cmd-verifier.md"
    try:
        contents = normalize_lf(role.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return [f"无法读取独立复核角色：{role}"]

    # Security-invariant validation (mirrors version-update.mjs):
    # Allows safe read-only tool subsets and optional `commandExecutionPolicy: off`,
    # while rejecting duplicates, unknown keys, write/shell tools, or MCP access.
    if not contents.startswith("---\n"):
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]
    header, divider, _ = contents[4:].partition("\n---\n")
    if not divider:
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]

    allowed_keys = {
        "name",
        "description",
        "mainAgent",
        "subagent",
        "model",
        "inheritMcp",
        "inheritCustomizations",
        "tools",
        "commandExecutionPolicy",
    }
    allowed_models = {"inherit", "flash", "flash_lite", "pro"}
    allowed_tools = {"read_file", "view_file", "grep_search", "find_by_name", "list_dir", "send_message"}

    fields: dict[str, str] = {}
    for line in header.splitlines():
        if ": " not in line:
            return [f"独立复核角色的只读工具或权限配置无效：{role}"]
        key, val = line.split(": ", 1)
        if key not in allowed_keys or key in fields:
            return [f"独立复核角色的只读工具或权限配置无效：{role}"]
        fields[key] = val.strip()

    if (
        not fields.get("description")
        or fields.get("name") != "cmd-verifier"
        or fields.get("mainAgent") != "false"
        or fields.get("subagent") != "true"
        or fields.get("inheritMcp") != "false"
        or fields.get("inheritCustomizations") not in ("true", "false")
        or fields.get("model") not in allowed_models
    ):
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]

    if "commandExecutionPolicy" in fields and fields["commandExecutionPolicy"] != "off":
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]

    try:
        tools = json.loads(fields.get("tools", ""))
    except Exception:
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]
    if not isinstance(tools, list) or not tools or not all(isinstance(t, str) and t in allowed_tools for t in tools):
        return [f"独立复核角色的只读工具或权限配置无效：{role}"]
    return []


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


def _is_pinned_node_command(command: object) -> bool:
    if not isinstance(command, str) or not command or re.search(r"[\x00-\x1f\r\n]", command):
        return False
    is_win_node = bool(
        re.match(r"^[A-Za-z]:[\\/]", command)
        and not command.startswith("\\\\")
        and os.path.basename(command.replace("/", "\\")).lower() == "node.exe"
    )
    is_posix_node = bool(
        command.startswith("/")
        and not command.startswith("//")
        and posixpath.basename(command) == "node"
    )
    return is_win_node or is_posix_node


def _preserve_pinned_node_command(sidecar_bytes: bytes, installed_sidecar: dict | None) -> bytes:
    if not isinstance(installed_sidecar, dict):
        return sidecar_bytes
    command = installed_sidecar.get("command")
    if not _is_pinned_node_command(command):
        return sidecar_bytes
    try:
        sidecar = json.loads(sidecar_bytes.decode("utf-8").lstrip("\ufeff"))
        if isinstance(sidecar, dict):
            sidecar["command"] = command
            return (json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    except Exception:
        pass
    return sidecar_bytes


def _sidecar_json_matches_except_pinned_node(src_txt: str, dst_txt: str) -> bool:
    try:
        src_obj = json.loads(src_txt.lstrip("\ufeff"))
        dst_obj = json.loads(dst_txt.lstrip("\ufeff"))
    except Exception:
        return False
    if not isinstance(src_obj, dict) or not isinstance(dst_obj, dict):
        return False
    if not _is_pinned_node_command(dst_obj.get("command")):
        return False
    src_copy = dict(src_obj)
    dst_copy = dict(dst_obj)
    src_copy.pop("command", None)
    dst_copy.pop("command", None)
    return src_copy == dst_copy


def _is_preserved_local_file(rel_posix: str) -> bool:
    if rel_posix in PRESERVED_HIDDEN_FILES:
        return True
    if re.match(r"^rules/[^/]+\.local\.md$", rel_posix, re.IGNORECASE):
        return True
    return False


def _is_safe_work_dir_name(name: object) -> bool:
    return bool(
        isinstance(name, str)
        and name.startswith(UPDATE_WORK_PREFIX)
        and len(name) > len(UPDATE_WORK_PREFIX)
        and len(name) <= 96
        and "/" not in name
        and "\\" not in name
        and ".." not in name
        and re.match(r"^[A-Za-z0-9._-]+$", name)
    )


def _is_safe_rel_posix(rel: object) -> bool:
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
        return False
    parts = rel.split("/")
    return all(part and part not in (".", "..") for part in parts)


def _assert_no_intermediate_symlink(root: Path, rel_posix: str) -> None:
    cur = root
    for part in rel_posix.split("/")[:-1]:
        cur = cur / part
        if not cur.exists() and not cur.is_symlink():
            break
        if cur.is_symlink() or not cur.is_dir():
            raise UpdateTransactionError("pathConflict", f"目录路径存在符号链接或非目录冲突：{rel_posix}")


def _list_live_files(root_dir: Path, current_rel: str = "") -> list[str]:
    abs_dir = root_dir / current_rel if current_rel else root_dir
    if not abs_dir.is_dir():
        return []
    results: list[str] = []
    for entry in sorted(abs_dir.iterdir(), key=lambda p: p.name):
        rel_posix = f"{current_rel}/{entry.name}" if current_rel else entry.name
        if _is_preserved_local_file(rel_posix):
            continue
        if entry.is_dir() and not entry.is_symlink():
            results.extend(_list_live_files(root_dir, rel_posix))
        else:
            results.append(rel_posix)
    return results


def _remove_empty_dirs_recursive(dir_path: Path, root_dir: Path) -> None:
    if not dir_path.is_dir() or dir_path.is_symlink():
        return
    for entry in list(dir_path.iterdir()):
        if entry.is_dir() and not entry.is_symlink():
            _remove_empty_dirs_recursive(entry, root_dir)
    if dir_path.resolve() != root_dir.resolve():
        try:
            if not any(dir_path.iterdir()):
                dir_path.rmdir()
        except OSError:
            pass


def _parse_update_marker(raw: str) -> dict | None:
    try:
        parsed = json.loads(raw.lstrip("\ufeff"))
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return None


def _evaluate_update_marker_state(
    raw: str,
    mtime_ms: float,
    *,
    now_ms: float | None = None,
    stale_ms: float = UPDATE_STALE_MARKER_MS,
    pid_alive_fn=None,
) -> str:
    cur_ms = time.time() * 1000.0 if now_ms is None else float(now_ms)
    alive_fn = pid_alive_fn or _is_pid_alive
    parsed = _parse_update_marker(raw)
    if parsed:
        if parsed.get("phase") == "recovery":
            return "recovery"
        pid = parsed.get("pid")
        if isinstance(pid, int) and not isinstance(pid, bool):
            alive = pid == os.getpid() or alive_fn(pid)
            started_at = parsed.get("startedAt")
            expired = isinstance(started_at, (int, float)) and not isinstance(started_at, bool) and (
                cur_ms - float(started_at) > stale_ms
            )
            if alive and not expired:
                return "active"
            phase = parsed.get("phase")
            if phase == "staging":
                return "stale"
            if phase == "committed":
                return "committed_stale"
            if phase == "replacing":
                return "interrupted"
            return "stale"
    return "stale" if (cur_ms - mtime_ms > stale_ms) else "active"


def _write_update_marker(marker_path: Path, record: dict, *, exclusive: bool = False) -> None:
    serialized = json.dumps(record, ensure_ascii=False) + "\n"
    if exclusive:
        fd = os.open(str(marker_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, serialized.encode("utf-8"))
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
        return
    _write_text_lf_atomic(marker_path, serialized)


def _move_path(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    for attempt in range(6):
        try:
            os.replace(str(src), str(dst))
            return
        except PermissionError as exc:
            last_err = exc
            if os.name != "nt":
                raise
            time.sleep(0.01 * (attempt + 1))
        except OSError:
            shutil.move(str(src), str(dst))
            return
    if last_err is not None:
        raise last_err


def _read_plugin_version(root: Path) -> str:
    manifest = root / "plugin.json"
    if not manifest.is_file() or manifest.is_symlink():
        return ""
    try:
        parsed = json.loads(manifest.read_text(encoding="utf-8").lstrip("\ufeff"))
        ver = parsed.get("version") if isinstance(parsed, dict) else ""
        return ver.strip().lstrip("v") if isinstance(ver, str) else ""
    except Exception:
        return ""


def _rollback_from_journal(root: Path, work_dir: Path, journal: dict) -> None:
    ordered_install = journal.get("orderedInstall")
    obsolete_files = journal.get("obsoleteFiles")
    if not isinstance(ordered_install, list) or not isinstance(obsolete_files, list):
        raise UpdateTransactionError("recovery", "恢复清单格式无效。")
    if not all(_is_safe_rel_posix(rel) for rel in ordered_install) or not all(
        _is_safe_rel_posix(rel) for rel in obsolete_files
    ):
        raise UpdateTransactionError("recovery", "恢复清单包含非法路径。")

    stage_dir = work_dir / "next"
    prev_dir = work_dir / "backup" / "prev"
    obsolete_dir = work_dir / "backup" / "obsolete"

    for rel in reversed(obsolete_files):
        saved = obsolete_dir / rel
        live = root / rel
        if (saved.exists() or saved.is_symlink()) and not (live.exists() or live.is_symlink()):
            _assert_no_intermediate_symlink(root, rel)
            _move_path(saved, live)

    for rel in reversed(ordered_install):
        stage_file = stage_dir / rel
        prev_file = prev_dir / rel
        live_file = root / rel
        has_stage = stage_file.exists() or stage_file.is_symlink()
        has_prev = prev_file.exists() or prev_file.is_symlink()
        has_live = live_file.exists() or live_file.is_symlink()
        if not has_stage and has_live:
            _move_path(live_file, stage_file)
        if has_prev and not (live_file.exists() or live_file.is_symlink()):
            _assert_no_intermediate_symlink(root, rel)
            _move_path(prev_file, live_file)

    _remove_empty_dirs_recursive(root, root)
    prev_ver = journal.get("previousVersion")
    if not journal.get("freshInstall") and isinstance(prev_ver, str) and prev_ver:
        if _read_plugin_version(root) != prev_ver.lstrip("v"):
            raise UpdateTransactionError("recovery", "回滚后 plugin.json 版本核验失败。")


def recover_interrupted_update(
    plugin_dir: Path,
    *,
    reclaim_stale: bool = True,
    pid_alive_fn=None,
    now_ms: float | None = None,
) -> dict:
    marker_path = plugin_dir / UPDATE_MARKER_NAME
    if not marker_path.exists() and not marker_path.is_symlink():
        return {"status": "clean"}
    if marker_path.is_symlink() or not marker_path.is_file():
        raise UpdateTransactionError("pathConflict", f"更新标记不是普通文件：{marker_path}")

    st = marker_path.stat()
    raw = marker_path.read_text(encoding="utf-8", errors="replace")
    parsed = _parse_update_marker(raw)
    state = _evaluate_update_marker_state(raw, st.st_mtime * 1000.0, now_ms=now_ms, pid_alive_fn=pid_alive_fn)

    if state == "active":
        raise UpdateTransactionError("busy", "检测到另一进程正在更新/同步 agy-cmd 插件，请稍后再试。")

    work_dir: Path | None = None
    if parsed and _is_safe_work_dir_name(parsed.get("workDirName")):
        candidate = plugin_dir.parent / str(parsed["workDirName"])
        if candidate.is_dir() and not candidate.is_symlink():
            work_dir = candidate

    if state in ("stale", "committed_stale"):
        if not reclaim_stale:
            return {"status": state}
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        try:
            marker_path.unlink()
        except FileNotFoundError:
            pass
        return {"status": "cleaned_committed" if state == "committed_stale" else "cleaned_stale"}

    journal: dict | None = None
    if work_dir is not None:
        journal_path = work_dir / UPDATE_JOURNAL_NAME
        if journal_path.is_file() and not journal_path.is_symlink():
            try:
                j_obj = json.loads(journal_path.read_text(encoding="utf-8").lstrip("\ufeff"))
                if (
                    isinstance(j_obj, dict)
                    and isinstance(j_obj.get("orderedInstall"), list)
                    and (not parsed or not parsed.get("token") or j_obj.get("token") == parsed.get("token"))
                ):
                    journal = j_obj
            except Exception:
                journal = None

    cur_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if work_dir is None or journal is None:
        if state == "interrupted":
            rec = dict(parsed or {})
            rec.update({"schemaVersion": 2, "pid": os.getpid(), "startedAt": cur_ms, "phase": "recovery"})
            try:
                _write_update_marker(marker_path, rec)
            except OSError:
                pass
        raise UpdateTransactionError(
            "recovery",
            f"检测到中断的安装事务且缺少完整备份清单，已保持待恢复状态：{marker_path}",
        )

    try:
        _rollback_from_journal(plugin_dir, work_dir, journal)
        try:
            marker_path.unlink()
        except FileNotFoundError:
            pass
        shutil.rmtree(work_dir, ignore_errors=True)
        return {"status": "recovered", "restoredVersion": journal.get("previousVersion") or ""}
    except Exception as exc:
        rec = dict(parsed or {})
        rec.update(
            {
                "schemaVersion": 2,
                "pid": os.getpid(),
                "startedAt": cur_ms,
                "phase": "recovery",
                "workDirName": work_dir.name,
                "journalFile": UPDATE_JOURNAL_NAME,
            }
        )
        try:
            _write_update_marker(marker_path, rec)
        except OSError:
            pass
        raise UpdateTransactionError("recovery", f"中断安装恢复失败，已保留备份目录：{exc}") from exc


def check_update_marker_issues(plugin_dir: Path, *, pid_alive_fn=None) -> list[str]:
    marker_path = plugin_dir / UPDATE_MARKER_NAME
    if not marker_path.exists() and not marker_path.is_symlink():
        return []
    if marker_path.is_symlink() or not marker_path.is_file():
        return [f"更新标记文件异常：{marker_path}"]
    try:
        st = marker_path.stat()
        raw = marker_path.read_text(encoding="utf-8", errors="replace")
        state = _evaluate_update_marker_state(raw, st.st_mtime * 1000.0, pid_alive_fn=pid_alive_fn)
    except OSError as exc:
        return [f"无法读取更新标记文件：{marker_path}（{exc}）"]
    if state == "active":
        return [f"插件正在更新中，暂不建议修改或重载：{marker_path}"]
    if state in ("interrupted", "recovery"):
        return [f"检测到未完成或待恢复的插件更新标记（可运行 --install 自动恢复）：{marker_path}"]
    return []


def sync_plugin_bundle_if_needed(target_plugin_dir: Path, *, _fail_after_moves: int | None = None) -> bool:
    """Atomically sync runtime files from a source checkout into target_plugin_dir using the shared update journal."""
    source_root = Path(__file__).resolve().parents[3]
    if not (source_root / "plugin.json").is_file():
        return False
    if source_root.resolve() == target_plugin_dir.resolve():
        return True

    target_plugin_dir.parent.mkdir(parents=True, exist_ok=True)
    if target_plugin_dir.exists():
        recover_interrupted_update(target_plugin_dir, reclaim_stale=True)

    installed_sidecar: dict | None = None
    installed_sidecar_path = target_plugin_dir / "sidecars" / "panel" / "sidecar.json"
    if installed_sidecar_path.is_file() and not installed_sidecar_path.is_symlink():
        try:
            parsed_sc = json.loads(installed_sidecar_path.read_text(encoding="utf-8").lstrip("\ufeff"))
            if isinstance(parsed_sc, dict):
                installed_sidecar = parsed_sc
        except Exception:
            installed_sidecar = None

    previous_version = _read_plugin_version(target_plugin_dir)
    target_version = _read_plugin_version(source_root)
    fresh_install = not (target_plugin_dir / "plugin.json").is_file()

    work_dir = Path(tempfile.mkdtemp(prefix=UPDATE_WORK_PREFIX, dir=str(target_plugin_dir.parent)))
    stage_dir = work_dir / "next"
    backup_dir = work_dir / "backup"
    stage_dir.mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    keep_work_dir = False

    selected_rel_paths: list[str] = []
    try:
        for item_name in BUNDLE_ROOT_FILES:
            src_file = source_root / item_name
            if src_file.is_file():
                dst_file = stage_dir / item_name
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)
                selected_rel_paths.append(item_name)

        for dir_name in BUNDLE_DIRS:
            src_dir = source_root / dir_name
            if not src_dir.is_dir():
                continue
            for src_fp in sorted(src_dir.rglob("*")):
                if not src_fp.is_file() or src_fp.is_symlink():
                    continue
                if "__pycache__" in src_fp.parts or src_fp.suffix.lower() in (".pyc", ".pyo"):
                    continue
                rel_posix = src_fp.relative_to(source_root).as_posix()
                dst_fp = stage_dir / rel_posix
                dst_fp.parent.mkdir(parents=True, exist_ok=True)
                if rel_posix == "sidecars/panel/sidecar.json":
                    data = _preserve_pinned_node_command(src_fp.read_bytes(), installed_sidecar)
                    dst_fp.write_bytes(data)
                elif rel_posix == "rules/AGENTS.md":
                    with open(dst_fp, "w", encoding="utf-8", newline="\n") as fh:
                        fh.write(RULE_BODY)
                else:
                    shutil.copy2(src_fp, dst_fp)
                selected_rel_paths.append(rel_posix)

        target_plugin_dir.mkdir(parents=True, exist_ok=True)
        marker_path = target_plugin_dir / UPDATE_MARKER_NAME
        token = secrets.token_hex(8)
        base_marker = {
            "schemaVersion": 2,
            "pid": os.getpid(),
            "token": token,
            "source": "python-cli",
            "startedAt": int(time.time() * 1000),
            "previousVersion": previous_version,
            "targetVersion": target_version,
            "workDirName": work_dir.name,
            "journalFile": UPDATE_JOURNAL_NAME,
        }
        try:
            _write_update_marker(marker_path, {**base_marker, "phase": "staging"}, exclusive=True)
        except FileExistsError as exc:
            raise UpdateTransactionError("busy", "检测到另一进程正在更新 agy-cmd 插件，请稍后再试。") from exc

        case_insensitive = os.name == "nt" or sys.platform == "darwin"
        norm_key = (lambda p: p.lower()) if case_insensitive else (lambda p: p)
        selected_keys = {norm_key(rel) for rel in selected_rel_paths}
        live_files = _list_live_files(target_plugin_dir)
        obsolete_files = [rel for rel in live_files if norm_key(rel) not in selected_keys]

        for rel in selected_rel_paths:
            _assert_no_intermediate_symlink(target_plugin_dir, rel)

        tail = {"sidecars/panel/server.mjs", "plugin.json"}
        ordered_install = [rel for rel in selected_rel_paths if rel not in tail] + [
            rel for rel in selected_rel_paths if rel in tail
        ]
        preexisting_paths: list[str] = []
        for rel in ordered_install:
            live = target_plugin_dir / rel
            if live.exists() or live.is_symlink():
                if live.is_dir() and not live.is_symlink():
                    raise UpdateTransactionError("pathConflict", f"目标文件位置已被目录占用：{rel}")
                preexisting_paths.append(rel)

        journal = {
            "schemaVersion": 2,
            "token": token,
            "source": "python-cli",
            "previousVersion": previous_version,
            "targetVersion": target_version,
            "freshInstall": fresh_install,
            "orderedInstall": ordered_install,
            "preexistingPaths": preexisting_paths,
            "obsoleteFiles": obsolete_files,
        }
        _write_text_lf_atomic(work_dir / UPDATE_JOURNAL_NAME, json.dumps(journal, indent=2, ensure_ascii=False) + "\n")
        _write_update_marker(marker_path, {**base_marker, "phase": "replacing"})

        moves_done = 0
        try:
            for rel in ordered_install:
                incoming = stage_dir / rel
                live = target_plugin_dir / rel
                if live.exists() or live.is_symlink():
                    if live.is_dir() and not live.is_symlink():
                        raise UpdateTransactionError("pathConflict", f"目标文件位置已被目录占用：{rel}")
                    _move_path(live, backup_dir / "prev" / rel)
                    moves_done += 1
                    if _fail_after_moves is not None and moves_done >= _fail_after_moves:
                        raise RuntimeError("Injected move failure for recovery testing")
                _move_path(incoming, live)
                moves_done += 1
                if _fail_after_moves is not None and moves_done >= _fail_after_moves:
                    raise RuntimeError("Injected move failure for recovery testing")

            for rel in obsolete_files:
                live = target_plugin_dir / rel
                if (live.exists() or live.is_symlink()) and not (live.is_dir() and not live.is_symlink()):
                    _move_path(live, backup_dir / "obsolete" / rel)
                    moves_done += 1
                    if _fail_after_moves is not None and moves_done >= _fail_after_moves:
                        raise RuntimeError("Injected move failure for recovery testing")

            _remove_empty_dirs_recursive(target_plugin_dir, target_plugin_dir)
            _clean_pycache_dirs(target_plugin_dir)
            _write_update_marker(marker_path, {**base_marker, "phase": "committed"})
            try:
                marker_path.unlink()
            except FileNotFoundError:
                pass
            return True
        except Exception as exc:
            try:
                _rollback_from_journal(target_plugin_dir, work_dir, journal)
                try:
                    marker_path.unlink()
                except FileNotFoundError:
                    pass
            except Exception as rb_exc:
                keep_work_dir = True
                try:
                    _write_update_marker(
                        marker_path,
                        {**base_marker, "startedAt": int(time.time() * 1000), "phase": "recovery"},
                    )
                except OSError:
                    pass
                raise UpdateTransactionError(
                    "recovery", f"安装失败且自动回滚失败，已保留备份目录 {work_dir}：{rb_exc}"
                ) from exc
            raise
    finally:
        if not keep_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


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
    _ensure_supported_python_version()
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
        help="开启或关闭疑难任务与连续失败时的 Boost 自动派工（开启时自动切至 paid 档位）",
    )
    parser.add_argument(
        "--boost-after-plan-approval",
        choices=["on", "off"],
        default=None,
        help="开启或关闭计划获批后自动单次调度 Boost 子智能体（默认关闭，仅 paid+Boost 生效）",
    )
    parser.add_argument(
        "--free-plan-review",
        choices=["on", "off"],
        help="开启或关闭免费档计划实施后的单次独立复核",
    )
    parser.add_argument(
        "--delivery-test-gate",
        choices=["on", "off"],
        default=None,
        help="开启或关闭交付前强制测试门禁（改后必测，全绿交付；无现成测试时保守放行并说明缺测）",
    )
    parser.add_argument(
        "--delivery-test-cmd",
        default=None,
        help="设置交付测试门禁的自定义验证命令（支持 && 组合；传空字符串清空并回退自动探测）",
    )
    parser.add_argument(
        "--free-fallback",
        choices=["on", "off"],
        default=None,
        help="开启或关闭免费版/关闭 Boost 时的卡壳只读换视角排查（默认开启）",
    )
    parser.add_argument(
        "--plan-fallback",
        choices=["on", "off"],
        default=None,
        help="开启或关闭只读 Plan Mode 拒写方案时的正文审批兜底与 exit_plan_mode 拦截（默认开启）",
    )
    parser.add_argument(
        "--auto-update-check",
        choices=["on", "off"],
        default=None,
        help="开启或关闭右侧边栏启动时自动检查 GitHub Releases 新版本（默认开启）",
    )
    parser.add_argument(
        "--auto-update-install",
        choices=["on", "off"],
        default=None,
        help="开启或关闭发现同主版本且通过 SHA-256 校验的新版本时静默自动更新（默认关闭）",
    )
    parser.add_argument(
        "--reset-stats",
        action="store_true",
        help="清空累计自动重试统计（不修改账号档位、Boost 或 Star 提醒状态）",
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

    has_settings_mutation = bool(args.reset_stats) or any(
        x is not None
        for x in (
            args.auto_retry,
            args.retry_scope,
            args.plan_tier,
            args.boost,
            args.boost_after_plan_approval,
            args.free_plan_review,
            args.delivery_test_gate,
            args.delivery_test_cmd,
            args.free_fallback,
            args.plan_fallback,
            args.auto_update_check,
            args.auto_update_install,
        )
    )
    has_lifecycle_action = any((args.install, args.remove, args.status, args.sync_check))
    if not has_settings_mutation and not has_lifecycle_action:
        parser.error("请至少指定一项操作（如 --status / --install / --auto-retry / --plan-tier / --boost / --reset-stats）")

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
        try:
            updated = apply_settings_cli(
                state_dir,
                auto_retry=args.auto_retry,
                retry_scope=args.retry_scope,
                plan_tier=args.plan_tier,
                boost_flag=args.boost,
                free_plan_review=args.free_plan_review,
                delivery_test_gate=args.delivery_test_gate,
                delivery_test_cmd=args.delivery_test_cmd,
                auto_update_check=args.auto_update_check,
                auto_update_install=args.auto_update_install,
                boost_after_plan_approval=args.boost_after_plan_approval,
                free_fallback=args.free_fallback,
                plan_fallback=args.plan_fallback,
                reset_stats=bool(args.reset_stats),
            )
        except SettingsLockTimeoutError as exc:
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "code": exc.code,
                            "retryable": True,
                            "error": str(exc),
                        },
                        ensure_ascii=False,
                    )
                )
            else:
                print(f"ERROR：{exc}", file=sys.stderr)
            return 3
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
            drift_issues = (
                check_update_marker_issues(plugin_dir)
                + validate_verifier(plugin_dir)
                + validate_bundle_sync(plugin_dir)
            )
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
            issues.extend(check_update_marker_issues(plugin_dir))
            issues.extend(validate_hooks_json(plugin_dir, plugin_hooks_path))
            issues.extend(validate_sidecar(plugin_dir))
            issues.extend(validate_verifier(plugin_dir))
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
        source_root = Path(__file__).resolve().parents[3]
        has_source_bundle = (source_root / "plugin.json").is_file()
        if not args.standalone and (has_plugin or has_source_bundle):
            role_issues = validate_verifier(source_root if has_source_bundle else plugin_dir)
            if role_issues:
                if args.json:
                    print(json.dumps({"ok": False, "issues": role_issues}, ensure_ascii=False))
                else:
                    print(role_issues[0], file=sys.stderr)
                return 2
            try:
                synced_bundle = sync_plugin_bundle_if_needed(plugin_dir)
            except UpdateTransactionError as exc:
                if args.json:
                    print(
                        json.dumps(
                            {"ok": False, "reason": exc.reason, "error": str(exc)},
                            ensure_ascii=False,
                        )
                    )
                else:
                    print(f"ERROR：{exc}", file=sys.stderr)
                return 3 if exc.reason == "busy" else 2
            if not synced_bundle or source_root.resolve() == plugin_dir.resolve():
                _write_text_lf_atomic(plugin_rule_path, RULE_BODY)
            cfg = set_plugin_enabled(config_dir, True)
            migrate_legacy_settings_if_needed(state_dir)
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

        _write_text_lf_atomic(standalone_rule_path, RULE_CONTENT)
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
