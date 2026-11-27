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
        self.assertIn("Swarm 成员", disk)
        self.assertIn("前后强依赖或紧耦合改动禁止强行并行", disk)
        self.assertIn("[agy-cmd → 建议 /swarm]", disk)
        skill = (PLUGIN_ROOT / "skills/agy-cmd/SKILL.md").read_text(encoding="utf-8")
        self.assertIn('model="inherit"', skill)
        self.assertIn("编码优先选可用的 `dart-coder`，否则选 `self`", skill)
        self.assertIn("/swarm execute our plan", skill)
        self.assertIn("用户点名 `/goal` 且授权不必逐轮询问时", disk)
        self.assertIn("待确认清单", disk)
        self.assertIn("Goal · 长程治理闭环", skill)
        playbooks = (PLUGIN_ROOT / "skills/agy-cmd/references/multi-agent-playbooks.md").read_text(encoding="utf-8")
        self.assertIn("**Goal · 长程治理闭环", playbooks)
        verifier_doc = (PLUGIN_ROOT / "agents/cmd-verifier.md").read_text(encoding="utf-8")
        self.assertIn("1-based line number", verifier_doc)
        self.assertIn("existing test assertions", verifier_doc)
        # Standalone installs only get this text. Keep the quota and host gate
        # ahead of the first instruction that emits a heavy command badge.
        heavy_gate = next(line for line in disk.splitlines() if "planTier=paid" in line)
        self.assertIn("Antigravity App", heavy_gate)
        self.assertIn("免费、未知或 IDE", heavy_gate)
        self.assertLess(disk.index(heavy_gate), disk.index("[agy-cmd → /run-workflow]"))
        self.assertFalse(disk.startswith("---"))

    def test_plugin_json_hooks_json_and_sidecar_schema(self) -> None:
        plugin_meta = json.loads(PLUGIN_JSON_PATH.read_text(encoding="utf-8"))
        self.assertEqual(plugin_meta["name"], "agy-cmd")
        package = json.loads((PLUGIN_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(plugin_meta["version"], package["version"])
        panel = (PLUGIN_ROOT / "sidecars/panel/index.html").read_text(encoding="utf-8")
        self.assertIn(f'<span class="ver-pill">v{package["version"]}</span>', panel)
        self.assertTrue((PLUGIN_ROOT / plugin_meta["logo"]).is_file())

        hooks = json.loads(HOOKS_JSON_PATH.read_text(encoding="utf-8"))
        self.assertIn("agy-cmd-router", hooks)
        spec = hooks["agy-cmd-router"]
        self.assertIsInstance(spec["PreToolUse"], list)
        self.assertEqual(spec["PreToolUse"][0]["matcher"], "exit_plan_mode")
        self.assertIsInstance(spec["PostToolUse"], list)
        self.assertIn("matcher", spec["PostToolUse"][0])
        for flat_ev in ("SessionStart", "PreInvocation", "Stop"):
            self.assertIsInstance(spec[flat_ev], list)
            self.assertIn("command", spec[flat_ev][0])
            self.assertNotIn("matcher", spec[flat_ev][0])
        self.assertEqual(router.validate_hooks_json(PLUGIN_ROOT, HOOKS_JSON_PATH), [])
        self.assertEqual(router.validate_sidecar(PLUGIN_ROOT), [])
        self.assertEqual(router.validate_verifier(PLUGIN_ROOT), [])


class TestSetupAutoRouterCLI(unittest.TestCase):
    def test_installed_verifier_permissions_drift_and_upgrade(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "cfg"
            plugin_dir = cfg_dir / "plugins" / "agy-cmd"
            installed = plugin_dir / "agents" / "cmd-verifier.md"
            install_args = ("--install", "--config-dir", str(cfg_dir), "--state-dir", tmp, "--json")
            self.assertEqual(run_cli(*install_args).returncode, 0)
            original = installed.read_text(encoding="utf-8")
            self.assertEqual(original, (PLUGIN_ROOT / "agents/cmd-verifier.md").read_text(encoding="utf-8"))

            dart_role = cfg_dir / "plugins/agy-dart/agents/dart-reviewer.md"
            dart_role.parent.mkdir(parents=True)
            dart_role.write_text("# existing reviewer\n", encoding="utf-8")
            for bad in (
                original.replace('["read_file"]', '["read_file", "run_command"]'),
                original.replace("read_file", "raed_file"),
                original.replace("inheritMcp: false", "inheritMcp: true"),
                original.replace("tools:", "mainAgent: true\ntools:"),
                original.replace("tools:", "plugins: [agy-dart]\ntools:"),
            ):
                with self.subTest(header=bad.split("---")[1]):
                    installed.write_text(bad, encoding="utf-8")
                    self.assertTrue(router.validate_verifier(plugin_dir))
            check = run_cli("--sync-check", "--config-dir", str(cfg_dir), "--json")
            self.assertEqual(check.returncode, 2)
            self.assertIn("cmd-verifier.md", json.loads(check.stdout)["issues"][0])
            installed.unlink()
            self.assertTrue(router.validate_verifier(plugin_dir))
            self.assertEqual(run_cli(*install_args).returncode, 0)
            self.assertEqual(installed.read_text(encoding="utf-8"), original)
            self.assertEqual(dart_role.read_text(encoding="utf-8"), "# existing reviewer\n")

    def test_free_plan_review_is_independent_of_tier_and_boost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            path = state / "settings.json"
            for legacy in ({"version": 1}, {"version": 2, "freePlanReviewEnabled": "true"}):
                path.write_text(json.dumps(legacy), encoding="utf-8")
                self.assertFalse(router.load_settings(state)["freePlanReviewEnabled"])

            def set_option(*args: str) -> dict:
                result = run_cli(*args, "--state-dir", tmp, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)["settings"]

            enabled = set_option("--free-plan-review", "on")
            self.assertTrue(enabled["freePlanReviewEnabled"])
            self.assertEqual(enabled["planTier"], "free")
            self.assertFalse(enabled["boostEnabled"])
            self.assertTrue(set_option("--plan-tier", "paid")["freePlanReviewEnabled"])
            self.assertTrue(set_option("--plan-tier", "free")["freePlanReviewEnabled"])
            self.assertFalse(set_option("--free-plan-review", "off")["freePlanReviewEnabled"])

    def test_delivery_test_gate_and_custom_cmd_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            path = state / "settings.json"
            for legacy in (
                {"version": 1},
                {"version": 2, "deliveryTestGateEnabled": "true", "deliveryTestCommand": "npm test\nrm -rf /"},
            ):
                path.write_text(json.dumps(legacy), encoding="utf-8")
                loaded = router.load_settings(state)
                self.assertFalse(loaded["deliveryTestGateEnabled"])
                self.assertNotIn("\n", loaded["deliveryTestCommand"])

            def set_option(*args: str) -> dict:
                result = run_cli(*args, "--state-dir", tmp, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)["settings"]

            on = set_option("--delivery-test-gate", "on", "--delivery-test-cmd", "  npm run typecheck  &&  npm test  ")
            self.assertTrue(on["deliveryTestGateEnabled"])
            self.assertEqual(on["deliveryTestCommand"], "npm run typecheck && npm test")
            self.assertEqual(on["planTier"], "free")
            self.assertFalse(on["boostEnabled"])
            self.assertIn("自定义：npm run typecheck && npm test", router.format_settings_summary(on))

            off = set_option("--delivery-test-gate", "off")
            self.assertFalse(off["deliveryTestGateEnabled"])
            self.assertEqual(off["deliveryTestCommand"], "npm run typecheck && npm test")

            cleared = set_option("--delivery-test-cmd", "")
            self.assertEqual(cleared["deliveryTestCommand"], "")

            bad_multiline = run_cli("--delivery-test-cmd", "npm test\necho bad", "--state-dir", tmp)
            self.assertNotEqual(bad_multiline.returncode, 0)
            bad_long = run_cli("--delivery-test-cmd", "a" * 241, "--state-dir", tmp)
            self.assertNotEqual(bad_long.returncode, 0)

            # Auto-update-check & auto-update-install toggles persist cleanly via CLI
            self.assertTrue(router.load_settings(state)["autoUpdateCheck"])
            self.assertFalse(router.load_settings(state)["autoUpdateInstall"])
            upd_off = set_option("--auto-update-check", "off")
            self.assertFalse(upd_off["autoUpdateCheck"])
            self.assertFalse(router.load_settings(state)["autoUpdateCheck"])
            # Enabling --auto-update-install automatically turns autoUpdateCheck back on
            inst_on = set_option("--auto-update-install", "on")
            self.assertTrue(inst_on["autoUpdateInstall"])
            self.assertTrue(inst_on["autoUpdateCheck"])
            inst_off = set_option("--auto-update-install", "off")
            self.assertFalse(inst_off["autoUpdateInstall"])
            self.assertTrue(inst_off["autoUpdateCheck"])

    def test_legacy_v2_plan_boost_resets_to_false_on_load_and_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "cfg"
            st_dir = Path(tmp) / "state"
            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)

            # 1. Fresh --install must not prematurely create settings.json
            fresh = run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json")
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            self.assertFalse((st_dir / "settings.json").exists())

            # 2. Legacy v2.3.0 settings (and versionless settings) reset boostAfterPlanApproval to False
            #    while preserving planTier, boostEnabled, configuredByUser, and starPrompt
            st_dir.mkdir(parents=True, exist_ok=True)
            legacy_payload = {
                "version": 2,
                "planTier": "paid",
                "boostEnabled": True,
                "boostAfterPlanApproval": True,
                "configuredByUser": True,
                "onboardingShown": True,
                "starPrompt": {
                    "state": "clicked",
                    "triggeredAt": "2026-11-22T00:00:00Z",
                    "resolvedAt": "2026-11-22T00:01:00Z",
                    "milestoneAutoRetries": 3,
                },
                "updatedAt": "2026-11-24T00:00:00Z",
            }
            for sample in (legacy_payload, {k: v for k, v in legacy_payload.items() if k != "version"}):
                (st_dir / "settings.json").write_text(json.dumps(sample) + "\n", encoding="utf-8")
                loaded = router.load_settings(st_dir)
                self.assertEqual(loaded["version"], 3)
                self.assertEqual(loaded["planTier"], "paid")
                self.assertTrue(loaded["boostEnabled"])
                self.assertFalse(loaded["boostAfterPlanApproval"])
                self.assertTrue(loaded["configuredByUser"])
                self.assertEqual(loaded["starPrompt"]["state"], "clicked")

            # --status --json reports migrated v3 state
            (st_dir / "settings.json").write_text(json.dumps(legacy_payload) + "\n", encoding="utf-8")
            st = run_cli("--status", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json")
            self.assertEqual(st.returncode, 0, st.stderr)
            st_settings = json.loads(st.stdout)["settings"]
            self.assertEqual(st_settings["version"], 3)
            self.assertTrue(st_settings["boostEnabled"])
            self.assertFalse(st_settings["boostAfterPlanApproval"])

            # 3. --install atomically migrates existing legacy v2 settings.json on disk to v3
            upg = run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json")
            self.assertEqual(upg.returncode, 0, upg.stderr)
            on_disk = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(on_disk["version"], 3)
            self.assertEqual(on_disk["planTier"], "paid")
            self.assertTrue(on_disk["boostEnabled"])
            self.assertFalse(on_disk["boostAfterPlanApproval"])
            self.assertTrue(on_disk["configuredByUser"])
            self.assertEqual(on_disk["starPrompt"]["state"], "clicked")
            self.assertEqual(on_disk["updatedAt"], "2026-11-24T00:00:00Z")

            # 4. Explicit opt-in at v3 survives load_settings and subsequent --install
            on_disk["boostAfterPlanApproval"] = True
            (st_dir / "settings.json").write_text(json.dumps(on_disk) + "\n", encoding="utf-8")
            self.assertTrue(router.load_settings(st_dir)["boostAfterPlanApproval"])
            re_inst = run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json")
            self.assertEqual(re_inst.returncode, 0, re_inst.stderr)
            after_reinst = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(after_reinst["version"], 3)
            self.assertTrue(after_reinst["boostAfterPlanApproval"])

    def _create_valid_plugin_skeleton(self, p_dir: Path) -> None:
        (p_dir / "rules").mkdir(parents=True, exist_ok=True)
        (p_dir / "hooks").mkdir(parents=True, exist_ok=True)
        (p_dir / "sidecars" / "panel").mkdir(parents=True, exist_ok=True)
        (p_dir / "skills" / "agy-cmd").mkdir(parents=True, exist_ok=True)
        (p_dir / "plugin.json").write_text('{"name":"agy-cmd"}\n', encoding="utf-8")
        (p_dir / "skills" / "agy-cmd" / "SKILL.md").write_text("# agy-cmd\n", encoding="utf-8")
        for script_name in ("session-start.mjs", "pre-tool-use.mjs", "post-tool-use.mjs", "pre-invocation.mjs", "stop.mjs"):
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

            # Set retry to 5 (default retry_scope should be smart)
            r1 = run_cli("--auto-retry", "5", "--state-dir", str(st_dir))
            self.assertEqual(r1.returncode, 0, r1.stderr)
            self.assertIn("智能无感触发", r1.stdout)
            s1 = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(s1["autoRetryMode"], "count")
            self.assertEqual(s1["autoRetryMax"], 5)
            self.assertEqual(s1["autoRetryScope"], "smart")
            self.assertEqual(s1["planTier"], "free")
            self.assertFalse(s1["boostEnabled"])
            self.assertTrue(s1["configuredByUser"])

            # Switch retry-scope explicitly to goal_only and back to smart
            r_scope = run_cli("--retry-scope", "goal_only", "--state-dir", str(st_dir))
            self.assertEqual(r_scope.returncode, 0, r_scope.stderr)
            self.assertEqual(
                json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))["autoRetryScope"],
                "goal_only",
            )
            r_smart = run_cli("--retry-scope", "smart", "--state-dir", str(st_dir))
            self.assertEqual(r_smart.returncode, 0, r_smart.stderr)
            self.assertEqual(
                json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))["autoRetryScope"],
                "smart",
            )

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


class TestStarFollowupCliAndState(unittest.TestCase):
    def _create_valid_plugin_skeleton(self, p_dir: Path) -> None:
        TestSetupAutoRouterCLI()._create_valid_plugin_skeleton(p_dir)

    def test_normalize_star_prompt_state_and_settings_preservation(self) -> None:
        for bad in (None, "", "{bad", [], {"starPrompt": "bad"}, {"state": "evil", "milestoneAutoRetries": -3, "milestone": True}):
            self.assertEqual(
                router.normalize_star_prompt_state(bad),
                {
                    "state": "pending",
                    "triggeredAt": None,
                    "resolvedAt": None,
                    "milestoneAutoRetries": 0,
                },
            )
        self.assertEqual(
            router.normalize_star_prompt_state(
                {
                    "starPrompt": {
                        "state": "copied_cli",
                        "triggeredAt": "2026-11-22T01:00:00Z",
                        "resolvedAt": "2026-11-22T01:05:00Z",
                        "milestoneAutoRetries": 4,
                    }
                }
            ),
            {
                "state": "copied_cli",
                "triggeredAt": "2026-11-22T01:00:00Z",
                "resolvedAt": "2026-11-22T01:05:00Z",
                "milestoneAutoRetries": 4,
            },
        )
        # Bool and non-finite floats/strings must fail-open to milestoneAutoRetries=0
        for edge in (True, "Infinity", "-Infinity", "inf", "nan", float("inf"), float("-inf"), float("nan")):
            self.assertEqual(
                router.normalize_star_prompt_state({"milestoneAutoRetries": edge})["milestoneAutoRetries"],
                0,
            )

    def test_gh_cli_auth_timeout_fail_open_and_followup_hint_formatting(self) -> None:
        import io
        import time
        from contextlib import redirect_stdout

        self.assertFalse(router.is_gh_cli_authenticated(bin_name="definitely-missing-gh-xyz-999"))
        # Must respect custom env PATH even in-process on Windows (no parent PATH leak)
        no_gh_env = dict(router.os.environ)
        no_gh_env["PATH"] = str(PLUGIN_ROOT / "nonexistent-bin-dir")
        no_gh_env["Path"] = str(PLUGIN_ROOT / "nonexistent-bin-dir")
        self.assertFalse(router.is_gh_cli_authenticated(bin_name="gh", env=no_gh_env))
        self.assertFalse(
            router.is_gh_cli_authenticated(bin_name=sys.executable, args=["-c", "import sys; sys.exit(1)"])
        )
        self.assertTrue(
            router.is_gh_cli_authenticated(bin_name=sys.executable, args=["-c", "import sys; sys.exit(0)"])
        )

        t0 = time.monotonic()
        slow = router.is_gh_cli_authenticated(
            bin_name=sys.executable,
            args=["-c", "import time; time.sleep(5)"],
            timeout_sec=0.2,
        )
        elapsed = time.monotonic() - t0
        self.assertFalse(slow)
        self.assertLess(elapsed, 1.5)

        buf_no_gh = io.StringIO()
        with redirect_stdout(buf_no_gh):
            router.print_star_followup_hint(mode="install", gh_authenticated=False)
        self.assertIn(router.GITHUB_REPO_URL, buf_no_gh.getvalue())
        self.assertNotIn(router.GH_STAR_COMMAND, buf_no_gh.getvalue())

        buf_with_gh = io.StringIO()
        with redirect_stdout(buf_with_gh):
            router.print_star_followup_hint(mode="check", gh_authenticated=True)
        self.assertIn(router.GITHUB_REPO_URL, buf_with_gh.getvalue())
        self.assertIn(router.GH_STAR_COMMAND, buf_with_gh.getvalue())

    def test_stripped_path_install_check_status_json_isolation_and_non_interactive(self) -> None:
        import os

        stripped_env = dict(os.environ)
        stripped_env.pop("PATH", None)
        stripped_env.pop("Path", None)
        py_dir = str(Path(sys.executable).resolve().parent)
        stripped_env["PATH"] = py_dir
        if os.name == "nt":
            stripped_env["Path"] = py_dir

        def run_stripped(*cli_args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, str(SCRIPT_PATH), *cli_args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=stripped_env,
                check=False,
            )

        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "cfg"
            st_dir = Path(tmp) / "state"
            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)

            # 1. Failing --sync-check omits Star hint; --sync-check --json emits valid JSON
            fail_chk = run_stripped("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(fail_chk.returncode, 2)
            self.assertNotIn(router.GITHUB_REPO_URL, fail_chk.stdout)

            fail_json = run_stripped("--sync-check", "--json", "--config-dir", str(cfg_dir))
            self.assertEqual(fail_json.returncode, 2)
            parsed_fail = json.loads(fail_json.stdout)
            self.assertFalse(parsed_fail["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, fail_json.stdout)

            # 2. --install prints GitHub URL exactly once and omits gh command when gh is absent
            inst = run_stripped("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(inst.returncode, 0, inst.stderr)
            self.assertEqual(inst.stdout.count(router.GITHUB_REPO_URL), 1)
            self.assertNotIn(router.GH_STAR_COMMAND, inst.stdout)

            # 3. Passing --sync-check & healthy --status print Star hint; --json stays strictly pure JSON
            ok_chk = run_stripped("--sync-check", "--config-dir", str(cfg_dir))
            self.assertEqual(ok_chk.returncode, 0, ok_chk.stderr)
            self.assertEqual(ok_chk.stdout.count(router.GITHUB_REPO_URL), 1)
            self.assertNotIn(router.GH_STAR_COMMAND, ok_chk.stdout)
            self.assertEqual(list(p_dir.rglob("__pycache__")), [])
            self.assertTrue((p_dir / "test" / "star-prompt.test.mjs").is_file())

            # Drift in sidecar runtime file or missing sidecar update modules fails --sync-check
            for mod_name in ("api-handler.mjs", "version-check.mjs", "update-archive.mjs", "version-update.mjs"):
                mod_fp = p_dir / "sidecars" / "panel" / mod_name
                orig_mod = mod_fp.read_text(encoding="utf-8")
                mod_fp.unlink()
                missing_chk = run_stripped("--sync-check", "--config-dir", str(cfg_dir))
                self.assertEqual(missing_chk.returncode, 2, f"Expected missing {mod_name} to fail --sync-check")
                mod_fp.write_text(orig_mod + "\n// drifted\n", encoding="utf-8")
                drifted_chk = run_stripped("--sync-check", "--config-dir", str(cfg_dir))
                self.assertEqual(drifted_chk.returncode, 2, f"Expected drifted {mod_name} to fail --sync-check")
                mod_fp.write_text(orig_mod, encoding="utf-8")

            ok_chk_json = run_stripped("--sync-check", "--json", "--config-dir", str(cfg_dir))
            self.assertEqual(ok_chk_json.returncode, 0)
            self.assertTrue(json.loads(ok_chk_json.stdout)["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, ok_chk_json.stdout)

            ok_st = run_stripped("--status", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(ok_st.returncode, 0)
            self.assertEqual(ok_st.stdout.count(router.GITHUB_REPO_URL), 1)

            ok_st_json = run_stripped("--status", "--json", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(ok_st_json.returncode, 0)
            self.assertTrue(json.loads(ok_st_json.stdout)["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, ok_st_json.stdout)

            # 4. Settings mutation & --remove never spam Star hint, and preserve terminal starPrompt
            st_dir.mkdir(parents=True, exist_ok=True)
            (st_dir / "settings.json").write_text(
                json.dumps(
                    {
                        "version": 2,
                        "planTier": "free",
                        "starPrompt": {
                            "state": "dismissed",
                            "triggeredAt": "2026-11-22T00:00:00Z",
                            "resolvedAt": "2026-11-22T00:01:00Z",
                            "milestoneAutoRetries": 3,
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            mut = run_stripped("--auto-retry", "4", "--state-dir", str(st_dir))
            self.assertEqual(mut.returncode, 0)
            self.assertNotIn(router.GITHUB_REPO_URL, mut.stdout)
            saved_after = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_after["starPrompt"]["state"], "dismissed")

            mut_json = run_stripped("--auto-retry", "5", "--json", "--state-dir", str(st_dir))
            self.assertEqual(mut_json.returncode, 0)
            self.assertTrue(json.loads(mut_json.stdout)["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, mut_json.stdout)

            rem = run_stripped("--remove", "--config-dir", str(cfg_dir))
            self.assertEqual(rem.returncode, 0)
            self.assertNotIn(router.GITHUB_REPO_URL, rem.stdout)

            inst_json = run_stripped("--install", "--json", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(inst_json.returncode, 0)
            self.assertTrue(json.loads(inst_json.stdout)["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, inst_json.stdout)

            rem_json = run_stripped("--remove", "--json", "--config-dir", str(cfg_dir))
            self.assertEqual(rem_json.returncode, 0)
            self.assertTrue(json.loads(rem_json.stdout)["ok"])
            self.assertNotIn(router.GITHUB_REPO_URL, rem_json.stdout)

            # 5. Disabled plugin --status omits Star hint
            disabled_st = run_stripped("--status", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir))
            self.assertEqual(disabled_st.returncode, 0)
            self.assertNotIn(router.GITHUB_REPO_URL, disabled_st.stdout)

        # Static non-interactive guarantee
        script_src = SCRIPT_PATH.read_text(encoding="utf-8")
        self.assertNotRegex(script_src, r"\binput\s*\(")

    def test_validate_hooks_json_detects_missing_script_inside_polyglot_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p_dir = Path(tmp) / "agy-cmd"
            self._create_valid_plugin_skeleton(p_dir)
            real_hooks = HOOKS_JSON_PATH.read_text(encoding="utf-8")
            (p_dir / "hooks.json").write_text(real_hooks, encoding="utf-8")
            self.assertEqual(router.validate_hooks_json(p_dir, p_dir / "hooks.json"), [])
            (p_dir / "hooks" / "stop.mjs").unlink()
            issues = router.validate_hooks_json(p_dir, p_dir / "hooks.json")
            self.assertTrue(any("stop.mjs" in item for item in issues), f"Expected missing stop.mjs issue, got {issues}")

    def test_v270_pretooluse_assets_sync_verifier_invariants_and_gemini_home(self) -> None:
        import os

        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "cfg"
            st_dir = Path(tmp) / "state"
            p_dir = cfg_dir / "plugins" / "agy-cmd"
            self.assertEqual(run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json").returncode, 0)

            # 1. validate_hooks_json detects missing pre-tool-use.mjs
            pre_tool_script = p_dir / "hooks" / "pre-tool-use.mjs"
            pre_tool_script.unlink()
            hook_issues = router.validate_hooks_json(p_dir, p_dir / "hooks.json")
            self.assertTrue(any("pre-tool-use.mjs" in item for item in hook_issues), f"Expected pre-tool-use.mjs issue, got {hook_issues}")
            self.assertEqual(run_cli("--install", "--config-dir", str(cfg_dir), "--state-dir", str(st_dir), "--json").returncode, 0)

            # 2. validate_bundle_sync detects drift in assets/logo.svg
            logo_path = p_dir / "assets" / "logo.svg"
            logo_path.write_text("<svg>drifted</svg>\n", encoding="utf-8")
            sync_issues = router.validate_bundle_sync(p_dir)
            self.assertTrue(any("logo.svg" in item for item in sync_issues), f"Expected logo.svg drift issue, got {sync_issues}")

            # 3. validate_verifier allows safe read-only extensions and blocks unsafe policies
            verifier_path = p_dir / "agents" / "cmd-verifier.md"
            original = (PLUGIN_ROOT / "agents" / "cmd-verifier.md").read_text(encoding="utf-8")
            safe_ext = (
                original.replace('tools: ["read_file"]', 'tools: ["read_file", "view_file", "grep_search"]')
                .replace("model: inherit", "model: inherit\ncommandExecutionPolicy: off")
            )
            verifier_path.write_text(safe_ext, encoding="utf-8")
            self.assertEqual(router.validate_verifier(p_dir), [])
            unsafe_policy = original.replace("model: inherit", "model: inherit\ncommandExecutionPolicy: auto")
            verifier_path.write_text(unsafe_policy, encoding="utf-8")
            self.assertTrue(router.validate_verifier(p_dir))

            # 4. resolve_state_dir honors GEMINI_HOME (both parent and .gemini forms)
            old_env = {k: os.environ.get(k) for k in ("AGY_CMD_STATE_DIR", "PLUGIN_DATA", "GEMINI_HOME")}
            try:
                os.environ.pop("AGY_CMD_STATE_DIR", None)
                os.environ.pop("PLUGIN_DATA", None)
                custom_home = Path(tmp) / "custom-home"
                os.environ["GEMINI_HOME"] = str(custom_home)
                self.assertEqual(
                    router.resolve_state_dir(),
                    custom_home.resolve() / ".gemini" / "antigravity" / "plugin_data" / "agy-cmd",
                )
                os.environ["GEMINI_HOME"] = str(custom_home / ".gemini")
                self.assertEqual(
                    router.resolve_state_dir(),
                    custom_home.resolve() / ".gemini" / "antigravity" / "plugin_data" / "agy-cmd",
                )
            finally:
                for k, v in old_env.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v

    def test_p1_batch_a_delivery_test_cmd_strict_validation_and_invalid_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            st_dir = Path(tmp) / "state"
            valid_8 = " && ".join(f"npm run check{i}" for i in range(1, 9))
            valid_8_cd = " && ".join(f"cd p{i} && pytest" for i in range(1, 9))
            invalid_9 = " && ".join(f"npm run check{i}" for i in range(1, 10))

            # 8 segments (plain and with cd prefixes) succeed
            ok8 = run_cli("--delivery-test-gate", "on", "--delivery-test-cmd", valid_8, "--state-dir", str(st_dir), "--json")
            self.assertEqual(ok8.returncode, 0, ok8.stderr)
            self.assertEqual(json.loads(ok8.stdout)["settings"]["deliveryTestCommand"], valid_8)

            ok8_cd = run_cli("--delivery-test-cmd", valid_8_cd, "--state-dir", str(st_dir), "--json")
            self.assertEqual(ok8_cd.returncode, 0, ok8_cd.stderr)
            self.assertEqual(json.loads(ok8_cd.stdout)["settings"]["deliveryTestCommand"], valid_8_cd)

            # 9 segments and unsupported shell syntax are rejected and preserve prior saved value
            for bad in (
                invalid_9,
                "npm test | cat",
                "npm test || true",
                "npm test; echo ok",
                "npm test & echo bg",
                "npm test && $(echo ok)",
                "npm test &&",
                "cd backend",
                "cd - && npm test",
                'npm test "unclosed',
            ):
                res = run_cli("--delivery-test-cmd", bad, "--state-dir", str(st_dir))
                self.assertNotEqual(res.returncode, 0, f"Expected failure for: {bad}")
                saved = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
                self.assertEqual(saved["deliveryTestCommand"], valid_8_cd, f"Previous value changed on: {bad}")

            # Pre-existing invalid command on disk displays 需修正 in summary
            raw = json.loads((st_dir / "settings.json").read_text(encoding="utf-8"))
            raw["deliveryTestCommand"] = invalid_9
            (st_dir / "settings.json").write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
            summary = router.format_settings_summary(router.load_settings(st_dir))
            self.assertIn("自定义命令无效，需修正", summary)


if __name__ == "__main__":
    unittest.main()
