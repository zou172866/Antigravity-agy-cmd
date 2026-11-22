#!/usr/bin/env python3
"""Unit tests for agy-cmd setup_auto_router.py, settings CLI, and plugin manifest integrity."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = PLUGIN_ROOT / "skills" / "agy-cmd" / "scripts" / "setup_auto_router.py"
PLUGIN_RULE_PATH = PLUGIN_ROOT / "rules" / "AGENTS.md"
PLUGIN_JSON_PATH = PLUGIN_ROOT / "plugin.json"
HOOKS_JSON_PATH = PLUGIN_ROOT / "hooks.json"

sys.path.insert(0, str(SCRIPT_PATH.parent))
import setup_auto_router as router  # noqa: E402


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


class TestPluginManifestsAndSync(unittest.TestCase):
    def test_plugin_rule_matches_script_rule_body_exactly(self) -> None:
        disk = router.normalize_lf(PLUGIN_RULE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(disk, router.normalize_lf(router.RULE_BODY))
        self.assertIn("exit_plan_mode", disk)
        self.assertIn("[agy-cmd → /plan 审批]", disk)
        self.assertIn("[agy-cmd → 自动换视角排查]", disk)
        self.assertIn("sidecar://agy-cmd/panel/", disk)
        self.assertIn('model="inherit"', disk)
        self.assertFalse(disk.startswith("---"))

    def test_plugin_json_hooks_json_and_sidecar_schema(self) -> None:
        plugin_meta = json.loads(PLUGIN_JSON_PATH.read_text(encoding="utf-8"))
        self.assertEqual(plugin_meta["name"], "agy-cmd")
        self.assertEqual(plugin_meta["version"], "2.1.0")
        self.assertTrue((PLUGIN_ROOT / plugin_meta["logo"]).is_file())

        hooks = json.loads(HOOKS_JSON_PATH.read_text(encoding="utf-8"))
        self.assertIn("agy-cmd-router", hooks)
        spec = hooks["agy-cmd-router"]
        self.assertIsInstance(spec["PostToolUse"], list)
        self.assertIn("matcher", spec["PostToolUse"][0])
        for flat_ev in ("SessionStart", "PreInvocation", "Stop"):
            self.assertIsInstance(spec[flat_ev], list)
            self.assertIn("command", spec[flat_ev][0])
            self.assertNotIn("matcher", spec[flat_ev][0])
        self.assertEqual(router.validate_hooks_json(PLUGIN_ROOT, HOOKS_JSON_PATH), [])
        self.assertEqual(router.validate_sidecar(PLUGIN_ROOT), [])


class TestSetupAutoRouterCLI(unittest.TestCase):
    def _create_valid_plugin_skeleton(self, p_dir: Path) -> None:
        (p_dir / "rules").mkdir(parents=True, exist_ok=True)
        (p_dir / "hooks").mkdir(parents=True, exist_ok=True)
        (p_dir / "sidecars" / "panel").mkdir(parents=True, exist_ok=True)
        (p_dir / "skills" / "agy-cmd").mkdir(parents=True, exist_ok=True)
        (p_dir / "plugin.json").write_text('{"name":"agy-cmd"}\n', encoding="utf-8")
        (p_dir / "skills" / "agy-cmd" / "SKILL.md").write_text("# agy-cmd\n", encoding="utf-8")
        for script_name in ("session-start.mjs", "post-tool-use.mjs", "pre-invocation.mjs", "stop.mjs"):
            (p_dir / "hooks" / script_name).write_text("// stub\n", encoding="utf-8")
        for sc_name in ("sidecar.json", "server.mjs", "index.html"):
            (p_dir / "sidecars" / "panel" / sc_name).write_text("{}\n", encoding="utf-8")
        (p_dir / "hooks.json").write_text(
            json.dumps(
                {
                    "agy-cmd-router": {
                        "SessionStart": [{"type": "command", "command": "node ./hooks/session-start.mjs"}],
                        "PostToolUse": [
                            {"matcher": "run_command", "hooks": [{"type": "command", "command": "node ./hooks/post-tool-use.mjs"}]}
                        ],
                        "PreInvocation": [{"type": "command", "command": "node ./hooks/pre-invocation.mjs"}],
                        "Stop": [{"type": "command", "command": "node ./hooks/stop.mjs"}],
                    }
                }
            )
            + "\n",
            encoding="utf-8",
        )

    def test_plugin_mode_install_prints_panel_reminder_and_cleans_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "cfg"
            st_dir = Path(tmp) / "state"
            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)
            (p_dir / "rules" / "AGENTS.md").write_text("stale drifted rule\n", encoding="utf-8")

            legacy_rule = cfg_dir / "rules" / "agy-auto-router.md"
            legacy_rule.parent.mkdir(parents=True)
            legacy_rule.write_text("old rule\n", encoding="utf-8")
            legacy_skill = cfg_dir / "skills" / "agy-cmd" / "SKILL.md"
            legacy_skill.parent.mkdir(parents=True)
            legacy_skill.write_text("old skill\n", encoding="utf-8")

            chk_bad = run_cli("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(chk_bad.returncode, 2)

            inst = run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(inst.returncode, 0, inst.stderr)
            self.assertIn("安装后重要提醒", inst.stdout)
            self.assertIn("sidecar://agy-cmd/panel/", inst.stdout)
            self.assertFalse(legacy_rule.exists())
            self.assertFalse(legacy_skill.exists())

            chk_ok = run_cli("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(chk_ok.returncode, 0, chk_ok.stdout)

            # Before user configures settings, --status ALSO prints the reminder
            st = run_cli("--status", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(st.returncode, 0)
            self.assertIn("免费版默认", st.stdout)
            self.assertIn("安装后重要提醒", st.stdout)

            rem = run_cli("--remove", "--config-dir", str(cfg_dir))
            self.assertEqual(rem.returncode, 0)
            cfg_after = json.loads((cfg_dir / "config.json").read_text(encoding="utf-8"))
            self.assertFalse(cfg_after["plugins"]["agy-cmd"]["enabled"])

    def test_settings_cli_auto_retry_and_tier_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            st_dir = Path(tmp) / "state"

            # Set retry to 5
            r1 = run_cli("--auto-retry", "5", "--state-dir", str(st_dir))
            self.assertEqual(r1.returncode, 0, r1.stderr)
            s1 = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(s1["autoRetryMode"], "count")
            self.assertEqual(s1["autoRetryMax"], 5)
            self.assertEqual(s1["planTier"], "free")
            self.assertFalse(s1["boostEnabled"])
            self.assertTrue(s1["configuredByUser"])

            # Set retry to infinite + enable boost (auto-promotes to paid)
            r2 = run_cli("--auto-retry", "infinite", "--boost", "on", "--state-dir", str(st_dir))
            self.assertEqual(r2.returncode, 0, r2.stderr)
            s2 = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(s2["autoRetryMode"], "infinite")
            self.assertEqual(s2["planTier"], "paid")
            self.assertTrue(s2["boostEnabled"])

            # Set retry off + switch back to free (forces boostEnabled False)
            r3 = run_cli("--auto-retry", "off", "--plan-tier", "free", "--state-dir", str(st_dir))
            self.assertEqual(r3.returncode, 0, r3.stderr)
            s3 = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(s3["autoRetryMode"], "off")
            self.assertEqual(s3["planTier"], "free")
            self.assertFalse(s3["boostEnabled"])

    def test_invalid_or_empty_hooks_json_fails_sync_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp)
            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)
            (p_dir / "rules" / "AGENTS.md").write_text(router.RULE_BODY, encoding="utf-8")
            (p_dir / "hooks.json").write_text("{}\n", encoding="utf-8")
            chk = run_cli("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(chk.returncode, 2)

            self._create_valid_plugin_skeleton(p_dir)
            (p_dir / "hooks" / "stop.mjs").unlink()
            chk2 = run_cli("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(chk2.returncode, 2)
            self.assertIn("脚本不存在", chk2.stdout)

    def test_standalone_mode_and_malformed_config_protection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp)
            inst = run_cli("--install", "--standalone", "--config-dir", str(cfg_dir))
            self.assertEqual(inst.returncode, 0, inst.stderr)
            chk = run_cli("--sync-check", "--standalone", "--config-dir", str(cfg_dir))
            self.assertEqual(chk.returncode, 0, chk.stdout)
            rem = run_cli("--remove", "--standalone", "--config-dir", str(cfg_dir))
            self.assertEqual(rem.returncode, 0)

            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)
            bad_cfg = cfg_dir / "config.json"
            bad_cfg.write_text("{broken json", encoding="utf-8")
            inst2 = run_cli("--install", "--config-dir", str(cfg_dir))
            self.assertNotEqual(inst2.returncode, 0)
            self.assertEqual(bad_cfg.read_text(encoding="utf-8"), "{broken json")


if __name__ == "__main__":
    unittest.main()
