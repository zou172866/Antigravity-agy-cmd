import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  createDefaultSettings,
  parseTurnRetryOverride,
  readSettings,
  recordAutoRetryStat,
  SettingsLockTimeoutError,
  updateAutoUpdateState,
  updateSettings
} from "../hooks/lib/settings.mjs";
import { runPostToolUse } from "../hooks/post-tool-use.mjs";
import { runPreInvocation } from "../hooks/pre-invocation.mjs";
import { runSessionStart } from "../hooks/session-start.mjs";
import { runStop } from "../hooks/stop.mjs";
import { dispatchPanelApi } from "../sidecars/panel/api-handler.mjs";
import { createStandaloneServer, renderPanelHtml } from "../sidecars/panel/server.mjs";

function makeTmpDir(prefix = "agy-cmd-v21-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    AGY_CMD_STATE_DIR: stateDir,
    ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
    ANTIGRAVITY_SUBAGENT: "",
    AGY_CMD_UI_ONLY: "",
    ...extra
  };
}

test("defaults: strictly starts in Free-Tier Safe Mode (boostEnabled=false) with smart count=3 retries and configuredByUser=false", () => {
  const dir = makeTmpDir();
  const s = readSettings(dir);
  assert.deepEqual(s, createDefaultSettings());
  assert.equal(s.version, 3);
  assert.equal(s.planTier, "free");
  assert.equal(s.boostEnabled, false);
  assert.equal(s.boostAfterPlanApproval, false);
  assert.equal(s.freePlanReviewEnabled, false);
  assert.equal(s.autoRetryMode, "count");
  assert.equal(s.autoRetryMax, 3);
  assert.equal(s.autoRetryScope, "smart");
  assert.equal(s.deliveryTestGateEnabled, false);
  assert.equal(s.deliveryTestCommand, "");
  assert.equal(s.configuredByUser, false);
  assert.equal(s.onboardingShown, false);

  // Legacy v1 unconfigured goal_only auto-migrates to smart, whereas explicit user goal_only stays preserved
  const dirLegacy = makeTmpDir();
  fs.writeFileSync(
    path.join(dirLegacy, "settings.json"),
    JSON.stringify({ version: 1, planTier: "free", autoRetryScope: "goal_only", configuredByUser: false }) + "\n"
  );
  assert.equal(readSettings(dirLegacy).autoRetryScope, "smart");
  assert.equal(readSettings(dirLegacy).freePlanReviewEnabled, false);

  const dirExplicit = makeTmpDir();
  fs.writeFileSync(
    path.join(dirExplicit, "settings.json"),
    JSON.stringify({ version: 1, planTier: "free", autoRetryScope: "goal_only", configuredByUser: true }) + "\n"
  );
  assert.equal(readSettings(dirExplicit).autoRetryScope, "goal_only");

  // Legacy v2 (e.g. v2.3.0) or versionless disk settings reset boostAfterPlanApproval to false while keeping paid/boostEnabled
  for (const legacyPayload of [
    { version: 2, planTier: "paid", boostEnabled: true, boostAfterPlanApproval: true, configuredByUser: true },
    { planTier: "paid", boostEnabled: true, boostAfterPlanApproval: true, configuredByUser: true }
  ]) {
    const dirV2 = makeTmpDir();
    fs.writeFileSync(path.join(dirV2, "settings.json"), JSON.stringify(legacyPayload) + "\n");
    const migrated = readSettings(dirV2);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.planTier, "paid");
    assert.equal(migrated.boostEnabled, true);
    assert.equal(migrated.boostAfterPlanApproval, false);

    const panelState = dispatchPanelApi("/api/state", {}, { stateDir: dirV2 });
    assert.equal(panelState.status, 200);
    assert.equal(panelState.body.settings.version, 3);
    assert.equal(panelState.body.settings.boostEnabled, true);
    assert.equal(panelState.body.settings.boostAfterPlanApproval, false);

    // Updating an unrelated field writes v3 with boostAfterPlanApproval kept false
    const afterRetryEdit = updateSettings(dirV2, { autoRetryMax: 5 });
    assert.equal(afterRetryEdit.version, 3);
    assert.equal(afterRetryEdit.boostEnabled, true);
    assert.equal(afterRetryEdit.boostAfterPlanApproval, false);
    assert.equal(readSettings(dirV2).boostAfterPlanApproval, false);

    // Explicit opt-in after v3 migration persists across reads
    const reEnabled = updateSettings(dirV2, { boostAfterPlanApproval: true });
    assert.equal(reEnabled.version, 3);
    assert.equal(reEnabled.boostAfterPlanApproval, true);
    assert.equal(readSettings(dirV2).boostAfterPlanApproval, true);
  }
});

test("parseTurnRetryOverride parses off / count (Arabic & Chinese) / infinite and ignores global config sentences", () => {
  assert.deepEqual(parseTurnRetryOverride("帮我修单测，这次不用重试"), { mode: "off", max: 0 });
  assert.deepEqual(parseTurnRetryOverride("帮我把所有单测修好，一直重试"), { mode: "infinite", max: null });
  assert.deepEqual(parseTurnRetryOverride("修一下报错，最多重试 5 次"), { mode: "count", max: 5 });
  assert.deepEqual(parseTurnRetryOverride("修一下报错，自动重试十二次"), { mode: "count", max: 12 });
  assert.deepEqual(parseTurnRetryOverride("fix tests, retry up to 4 times"), { mode: "count", max: 4 });
  assert.equal(parseTurnRetryOverride("把 agy-cmd 自动重试改成 5 次"), null);
  assert.equal(parseTurnRetryOverride("解释一下 config.toml"), null);
});

test("SessionStart onboarding reminder fires strictly ONCE on main session and skips subagents", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);

  // Subagent session must NOT trigger onboarding or consume the one-time flag
  const subOut = await runSessionStart({ conversationId: "sub-1", parentConversationId: "p-1" }, env);
  assert.deepEqual(subOut, {});
  assert.equal(readSettings(dir).onboardingShown, false);

  // First main session emits protojson-safe onboarding reminder with sidecar:// pill
  const firstMain = await runSessionStart({ conversationId: "main-1" }, env);
  assert.equal(firstMain.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(firstMain.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(firstMain.injectSteps[0].systemMessage.systemMessage, /sidecar:\/\/agy-cmd\/panel\//);
  assert.match(firstMain.injectSteps[0].systemMessage.systemMessage, /Boost/);
  assert.equal(readSettings(dir).onboardingShown, true);
  assert.equal(readSettings(dir).configuredByUser, false);

  // Second main session returns {} (zero steady-state overhead)
  const secondMain = await runSessionStart({ conversationId: "main-2" }, env);
  assert.deepEqual(secondMain, {});
});

test("Free-Tier Safe default suppresses /boost & /teamwork; switching to Paid unlocks /boost", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);

  // 1. Default Free tier: 3 consecutive failures -> emits free fallback, NEVER "/boost"
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: "c-free", toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      1000 + i * 10
    );
  }
  const freeOut = await runPreInvocation(
    { conversationId: "c-free", invocationNum: 1, initialNumSteps: 4, lastUserInput: "修一下 pytest" },
    env,
    1050
  );
  assert.equal(freeOut.injectSteps?.length, 1);
  const freeMsg = freeOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(freeMsg, /自动换视角排查/);
  assert.doesNotMatch(freeMsg, /\/(?:boost|teamwork|swarm|run-workflow)\b/i);
  assert.match(freeMsg, /main session/i);

  // Repo-wide migration in Free tier -> emits phased plan fallback, NEVER "/teamwork <cmd>"
  const freeTw = await runPreInvocation(
    { conversationId: "c-free-tw", invocationNum: 0, initialNumSteps: 1, lastUserInput: "做整个项目的仓库级迁移" },
    env,
    1100
  );
  assert.equal(freeTw.injectSteps?.length, 1);
  assert.match(freeTw.injectSteps[0].systemMessage.systemMessage, /分阶段迁移规划/);

  // Paid tier enables automatic Boost delegation on repeated failures.
  const updated = updateSettings(dir, { planTier: "paid" });
  assert.equal(updated.planTier, "paid");
  assert.equal(updated.boostEnabled, true);
  assert.equal(updated.configuredByUser, true);

  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: "c-paid", toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      2000 + i * 10
    );
  }
  const paidOut = await runPreInvocation(
    { conversationId: "c-paid", invocationNum: 1, initialNumSteps: 4, lastUserInput: "修一下 pytest" },
    env,
    2050
  );
  assert.equal(paidOut.injectSteps?.length, 1);
  const paidMsg = paidOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(paidMsg, /自动 Boost/);
  assert.match(paidMsg, /invoke_subagent once with TypeName='DeepCoder' and Workspace='inherit'/);

  // Switching back to Free forces boostEnabled=false
  const backToFree = updateSettings(dir, { planTier: "free" });
  assert.equal(backToFree.planTier, "free");
  assert.equal(backToFree.boostEnabled, false);
});

test("Stop hook: enforces count=2 cap, stops immediately on pass, and respects off & infinite modes", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  updateSettings(dir, { autoRetryMode: "count", autoRetryMax: 2, autoRetryScope: "goal_only" });

  const convId = "stop-count-2";
  // Turn entry with unattended goal
  const pre = await runPreInvocation(
    { conversationId: convId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
    env,
    3000
  );
  assert.equal(pre.injectSteps?.length, 1);
  assert.match(pre.injectSteps[0].systemMessage.systemMessage, /自动续跑已启用/);
  assert.match(pre.injectSteps[0].systemMessage.systemMessage, /最多自动续跑 2 次/);

  // Attempt 1 fails -> Stop continues (1/2)
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
    env,
    3100
  );
  const s1 = await runStop(
    { conversationId: convId, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
    env,
    3150
  );
  assert.equal(s1.decision, "continue");
  assert.match(s1.reason, /1\/2/);

  // Attempt 2 edits & fails again -> Stop continues (2/2)
  await runPostToolUse({ conversationId: convId, toolCall: { name: "edit_file", args: { Path: "a.py" } } }, env, 3200);
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
    env,
    3250
  );
  const s2 = await runStop(
    { conversationId: convId, executionNum: 1, continuationActive: true, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
    env,
    3300
  );
  assert.equal(s2.decision, "continue");
  assert.match(s2.reason, /2\/2/);

  // Attempt 3 still fails -> reaches cap 2 -> Stop allows!
  await runPostToolUse({ conversationId: convId, toolCall: { name: "edit_file", args: { Path: "a.py" } } }, env, 3350);
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
    env,
    3400
  );
  const s3 = await runStop(
    { conversationId: convId, executionNum: 2, continuationActive: true, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
    env,
    3450
  );
  assert.deepEqual(s3, { decision: "allow" });
  assert.equal(readSettings(dir).stats.totalAutoRetries, 2);

  // Verify single-turn NL override: "这次不用重试" forces allow even when global count=2
  const convOff = "stop-override-off";
  await runPreInvocation(
    { conversationId: convOff, invocationNum: 0, initialNumSteps: 1, lastUserInput: "修到全绿，但这次不用重试" },
    env,
    4000
  );
  await runPostToolUse(
    { conversationId: convOff, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
    env,
    4050
  );
  assert.deepEqual(
    await runStop({ conversationId: convOff, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "修到全绿，但这次不用重试" }, env, 4100),
    { decision: "allow" }
  );

  // Verify infinite mode continues past 3 retries, and stops immediately once pytest passes OR USER_CANCELED
  updateSettings(dir, { autoRetryMode: "infinite" });
  const convInf = "stop-inf";
  await runPreInvocation(
    { conversationId: convInf, invocationNum: 0, initialNumSteps: 1, lastUserInput: "修到全绿，中途别停" },
    env,
    5000
  );
  for (let round = 0; round < 4; round++) {
    await runPostToolUse(
      { conversationId: convInf, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      5100 + round * 50
    );
    const r = await runStop(
      { conversationId: convInf, executionNum: round, continuationActive: round > 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      env,
      5120 + round * 50
    );
    assert.equal(r.decision, "continue");
    assert.match(r.reason, /无限模式/);
  }

  // User clicks stop button (`USER_CANCELED`) -> MUST allow immediately even in infinite mode!
  assert.deepEqual(
    await runStop({ conversationId: convInf, executionNum: 4, continuationActive: true, terminationReason: "USER_CANCELED", fullyIdle: true }, env, 5400),
    { decision: "allow" }
  );

  // Passing test -> MUST allow immediately!
  await runPostToolUse(
    { conversationId: convInf, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, toolResponse: "Command exited with code 0." },
    env,
    5450
  );
  assert.deepEqual(
    await runStop({ conversationId: convInf, executionNum: 4, continuationActive: true, terminationReason: "NO_TOOL_CALL", fullyIdle: true }, env, 5500),
    { decision: "allow" }
  );
});

test("Stop hook safety brake: No-Progress Guard allows stopping when model asks a question without new edits/commands", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  updateSettings(dir, { autoRetryMode: "infinite" });
  const convId = "no-progress-1";

  await runPreInvocation(
    { conversationId: convId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "一直重试直到全部通过" },
    env,
    6000
  );
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    6050
  );

  // 1st stop -> continues
  const first = await runStop(
    { conversationId: convId, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
    env,
    6100
  );
  assert.equal(first.decision, "continue");

  // Model realizes DB password is missing and stops to ask user WITHOUT running any new edit/command -> MUST allow!
  const second = await runStop(
    { conversationId: convId, executionNum: 1, continuationActive: true, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
    env,
    6150
  );
  assert.deepEqual(second, { decision: "allow" });
});

test("Stop hook default smart scope: zero-passphrase auto-retry on code edits & failing tests, zero false positives on read-only/env probes", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  // Uses pure out-of-the-box default settings (autoRetryScope = "smart", max = 3)

  // 1. Normal feature/refactor prompt (ZERO magic phrase) + edit + custom script failure -> MUST continue, with 0 PreInvocation noise!
  const cEdit = "smart-edit-fail";
  const pre1 = await runPreInvocation(
    { conversationId: cEdit, invocationNum: 0, initialNumSteps: 1, lastUserInput: "给导出接口加一个字段校验" },
    env,
    7000
  );
  assert.deepEqual(pre1, {});
  await runPostToolUse({ conversationId: cEdit, toolCall: { name: "edit_file", args: { Path: "src/export.js" } } }, env, 7020);
  await runPostToolUse(
    { conversationId: cEdit, toolCall: { name: "run_command", args: { CommandLine: "node scripts/smoke.js" } }, error: "exit status 1" },
    env,
    7040
  );
  const stopEdit = await runStop(
    { conversationId: cEdit, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "给导出接口加一个字段校验" },
    env,
    7060
  );
  assert.equal(stopEdit.decision, "continue");
  assert.match(stopEdit.reason, /1\/3/);

  // 2. Normal bugfix / compound "analyze + fix" prompts + failing verify BEFORE edit -> MUST continue!
  for (const [id, prompt, ts] of [
    ["smart-verify-1", "不要修改别的文件，修好 auth.py 的报错", 7100],
    ["smart-verify-2", "分析一下为什么挂了，顺便修好", 7150]
  ]) {
    await runPreInvocation({ conversationId: id, invocationNum: 0, initialNumSteps: 1, lastUserInput: prompt }, env, ts);
    await runPostToolUse(
      { conversationId: id, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      ts + 20
    );
    const stopRes = await runStop(
      { conversationId: id, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: prompt },
      env,
      ts + 40
    );
    assert.equal(stopRes.decision, "continue", `Expected continue for "${prompt}"`);
  }

  // 3. Natural diagnostic / inquiry / status-check prompts WITHOUT any explicit "先别改代码" declaration -> MUST auto-recognize & allow stop!
  for (const [id, prompt, ts] of [
    ["smart-ask-why", "为什么 pytest 会挂？", 7200],
    ["smart-ask-cause", "帮我看看这个报错是什么原因", 7230],
    ["smart-ask-past-edit", "为什么我刚才修改之后还是挂？", 7260],
    ["smart-diagnose", "排查一下编译不过的问题出在哪", 7290],
    ["smart-check-fixed", "看看修好了吗？", 7310],
    ["smart-pure-run", "跑一下 pytest", 7340]
  ]) {
    await runPreInvocation({ conversationId: id, invocationNum: 0, initialNumSteps: 1, lastUserInput: prompt }, env, ts);
    await runPostToolUse(
      { conversationId: id, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      ts + 10
    );
    assert.deepEqual(
      await runStop(
        { conversationId: id, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: prompt },
        env,
        ts + 20
      ),
      { decision: "allow" },
      `Natural inquiry "${prompt}" must auto-allow without needing explicit declaration`
    );
  }

  // 4. Plan approval pause (`implementation_plan.md` artifact write + `[agy-cmd → /plan 审批]`) -> MUST NOT count plan file as code edit & MUST allow stop!
  const cPlanWait = "smart-plan-wait";
  const planTx = path.join(dir, "plan-wait.jsonl");
  fs.writeFileSync(
    planTx,
    [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n重构三个核心模块并修好测试\n</USER_REQUEST>" },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "Command exited with code 1.\nFAILED" },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "write_file",
            args: {
              Path: "/mock/home/.gemini/antigravity/brain/c1/implementation_plan.md",
              ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: "Plan" }
            }
          }
        ]
      },
      { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", content: "Created file." },
      { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "`[agy-cmd → /plan 审批]`\n请确认方案" }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  await runPreInvocation(
    { conversationId: cPlanWait, transcriptPath: planTx, invocationNum: 0, initialNumSteps: 1, lastUserInput: "重构三个核心模块并修好测试" },
    env,
    7360
  );
  await runPostToolUse(
    { conversationId: cPlanWait, transcriptPath: planTx, stepIdx: 2, toolCall: { name: "run_command", args: { CommandLine: "pytest" } } },
    env,
    7370
  );
  await runPostToolUse(
    {
      conversationId: cPlanWait,
      transcriptPath: planTx,
      stepIdx: 4,
      toolCall: {
        name: "write_file",
        args: {
          Path: "/mock/home/.gemini/antigravity/brain/c1/implementation_plan.md",
          ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: "Plan" }
        }
      }
    },
    env,
    7380
  );
  assert.deepEqual(
    await runStop(
      { conversationId: cPlanWait, transcriptPath: planTx, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "重构三个核心模块并修好测试" },
      env,
      7390
    ),
    { decision: "allow" }
  );

  // 5. Environment probe ("看看本机装没装 docker" -> `docker info` exit 1, zero edits, non-verify cmd) -> smart allows, all_failures continues!
  const cProbe = "smart-env-probe";
  await runPreInvocation(
    { conversationId: cProbe, invocationNum: 0, initialNumSteps: 1, lastUserInput: "看看本机装没装 docker" },
    env,
    7400
  );
  await runPostToolUse(
    { conversationId: cProbe, toolCall: { name: "run_command", args: { CommandLine: "docker info" } }, error: "exit status 1" },
    env,
    7420
  );
  assert.deepEqual(
    await runStop(
      { conversationId: cProbe, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "看看本机装没装 docker" },
      env,
      7440
    ),
    { decision: "allow" }
  );

  updateSettings(dir, { autoRetryScope: "all_failures" });
  const stopAll = await runStop(
    { conversationId: cProbe, executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "看看本机装没装 docker" },
    env,
    7460
  );
  assert.equal(stopAll.decision, "continue");
});

test("Sidecar HTTP server: serves UI, persists settings, blocks CSRF/cross-origin/GET-api, and syncs live with hooks", async () => {
  const dir = makeTmpDir();
  const csrf = "test-csrf-token-123456";
  const server = createStandaloneServer({ stateDir: dir, csrfToken: csrf });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. GET / serves panel HTML with CSRF injected and onboarding card
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes(csrf));
    assert.ok(html.includes("安装后首次确认提醒"));
    assert.ok(html.includes('id="chk-free-plan-review"'));
    assert.ok(html.includes('id="chk-delivery-gate"'));
    assert.ok(html.includes('id="inp-delivery-cmd"'));
    assert.ok(html.includes('id="btn-save-delivery-cmd"'));
    assert.ok(html.includes('id="btn-clear-delivery-cmd"'));

    // 2. Security: GET /api/state -> 405; missing CSRF -> 401; cross-site -> 403
    const getApi = await fetch(`${base}/api/state`);
    assert.equal(getApi.status, 405);

    const noCsrf = await fetch(`${base}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(noCsrf.status, 401);

    const crossSite = await fetch(`${base}/api/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agy-Cmd-Csrf": csrf,
        "Sec-Fetch-Site": "cross-site"
      },
      body: "{}"
    });
    assert.equal(crossSite.status, 403);

    // 3. Valid POST /api/state returns Free-Tier Safe defaults
    const stRes = await fetch(`${base}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: "{}"
    });
    assert.equal(stRes.status, 200);
    const stData = await stRes.json();
    assert.equal(stData.settings.planTier, "free");
    assert.equal(stData.settings.boostEnabled, false);
    assert.equal(stData.settings.boostAfterPlanApproval, false);
    assert.equal(stData.settings.freePlanReviewEnabled, false);
    assert.equal(stData.settings.deliveryTestGateEnabled, false);
    assert.equal(stData.settings.deliveryTestCommand, "");
    assert.match(stData.deliveryGateStatusZh, /交付测试门禁：关闭/);
    assert.equal(stData.settings.configuredByUser, false);

    const reviewPatch = (value) => fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ freePlanReviewEnabled: value })
    });
    assert.equal((await reviewPatch("true")).status, 400);
    const enabledReview = await reviewPatch(true);
    assert.equal(enabledReview.status, 200);
    const { settings: reviewed } = await enabledReview.json();
    assert.equal(reviewed.freePlanReviewEnabled, true);
    assert.equal(reviewed.planTier, "free");
    assert.equal(reviewed.boostEnabled, false);
    assert.equal(readSettings(dir).freePlanReviewEnabled, true);
    // 4. Invalid autoRetryMax rejected with 400
    const badPatch = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ autoRetryMax: 999 })
    });
    assert.equal(badPatch.status, 400);

    // 4b. Delivery test gate validation & persistence (independent of tier/boost, preserves custom command on toggle off)
    const gatePost = (patch) =>
      fetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: JSON.stringify(patch)
      });
    assert.equal((await gatePost({ deliveryTestGateEnabled: "yes" })).status, 400);
    assert.equal((await gatePost({ deliveryTestCommand: "npm test\necho hi" })).status, 400);
    assert.equal((await gatePost({ deliveryTestCommand: "a".repeat(241) })).status, 400);
    assert.equal((await gatePost({ deliveryTestCommand: 123 })).status, 400);

    const gateOnRes = await gatePost({
      deliveryTestGateEnabled: true,
      deliveryTestCommand: "  npm run typecheck  &&  npm test  "
    });
    assert.equal(gateOnRes.status, 200);
    const gateOnData = await gateOnRes.json();
    assert.equal(gateOnData.settings.deliveryTestGateEnabled, true);
    assert.equal(gateOnData.settings.deliveryTestCommand, "npm run typecheck && npm test");
    assert.equal(gateOnData.settings.planTier, "free");
    assert.equal(gateOnData.settings.boostEnabled, false);
    assert.match(gateOnData.deliveryGateStatusZh, /自定义命令：npm run typecheck && npm test/);

    const gateOffRes = await gatePost({ deliveryTestGateEnabled: false });
    assert.equal(gateOffRes.status, 200);
    const gateOffData = await gateOffRes.json();
    assert.equal(gateOffData.settings.deliveryTestGateEnabled, false);
    assert.equal(gateOffData.settings.deliveryTestCommand, "npm run typecheck && npm test");
    assert.equal(readSettings(dir).deliveryTestCommand, "npm run typecheck && npm test");

    // 5. Update via Sidecar UI -> sets autoRetryMode="off", planTier="paid" -> immediately read by hooks!
    const updRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ autoRetryMode: "off", planTier: "paid", boostAfterPlanApproval: true })
    });
    assert.equal(updRes.status, 200);
    const updData = await updRes.json();
    assert.equal(updData.settings.autoRetryMode, "off");
    assert.equal(updData.settings.planTier, "paid");
    assert.equal(updData.settings.boostEnabled, true);
    assert.equal(updData.settings.boostAfterPlanApproval, true);
    assert.equal(updData.settings.freePlanReviewEnabled, true);
    assert.equal(updData.settings.configuredByUser, true);

    // Hook immediately sees autoRetryMode="off" -> suggests /goal instead of arming auto-retry
    const env = makeEnv(dir);
    const hookOut = await runPreInvocation(
      { conversationId: "live-sync", invocationNum: 0, initialNumSteps: 1, lastUserInput: "修到全绿，中途别停" },
      env,
      9000
    );
    assert.equal(hookOut.injectSteps?.length, 1);
    assert.match(hookOut.injectSteps[0].systemMessage.systemMessage, /建议 \/goal/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Sidecar UI index.html: Delivery Test Gate toggle, custom command save/clear, dirty-input poll protection, and off-retry warning", async () => {
  const dir = makeTmpDir("agy-cmd-gate-ui-");
  const htmlSource = renderPanelHtml("vm-csrf");
  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptBlocks[scriptBlocks.length - 1][1];

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = new Map();
    return {
      id,
      hidden: id === "delivery-gate-box" || id === "btn-clear-delivery-cmd" || id === "delivery-off-warn",
      value: id === "inp-max" ? "3" : "",
      checked: false,
      disabled: false,
      textContent: "",
      style: { getPropertyValue: () => "" },
      dataset: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, force) {
          const on = force === undefined ? !this._s.has(c) : Boolean(force);
          if (on) this._s.add(c);
          else this._s.delete(c);
          return on;
        },
        contains(c) { return this._s.has(c); }
      },
      setAttribute() {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      async trigger(type, ev = { preventDefault() {} }) {
        for (const fn of listeners.get(type) || []) {
          await fn(ev);
        }
      }
    };
  };
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  let pollCb = null;
  const ctx = {
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { style: { getPropertyValue: () => "" }, setAttribute() {} },
      getElementById: getEl,
      querySelectorAll: () => []
    },
    window: {
      addEventListener() {},
      fetch: async (urlPath, opts = {}) => {
        const out = dispatchPanelApi(urlPath, JSON.parse(opts.body || "{}"), { stateDir: dir });
        return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => structuredClone(out.body) };
      }
    },
    navigator: {},
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: (fn) => {
      pollCb = fn;
      return 1;
    }
  };
  ctx.window.window = ctx.window;
  vm.runInNewContext(mainScript, ctx);
  await new Promise((r) => setTimeout(r, 15));

  // Initial render: gate OFF, custom box hidden
  assert.equal(getEl("chk-delivery-gate").checked, false);
  assert.equal(getEl("delivery-gate-box").hidden, true);
  assert.match(getEl("lbl-gate-status").textContent, /交付测试门禁：关闭/);

  // Toggle gate ON -> custom box opens
  getEl("chk-delivery-gate").checked = true;
  await getEl("chk-delivery-gate").trigger("change");
  assert.equal(readSettings(dir).deliveryTestGateEnabled, true);
  assert.equal(getEl("delivery-gate-box").hidden, false);
  assert.equal(getEl("delivery-off-warn").hidden, true);

  // Typing unsaved command marks dirty -> 3s poll must NOT overwrite the input!
  getEl("inp-delivery-cmd").value = "npm run typecheck && npm test";
  await getEl("inp-delivery-cmd").trigger("input");
  assert.equal(getEl("btn-clear-delivery-cmd").hidden, false);
  assert.ok(typeof pollCb === "function");
  pollCb();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(getEl("inp-delivery-cmd").value, "npm run typecheck && npm test");

  // Save custom command via Save button -> persists and updates status
  await getEl("btn-save-delivery-cmd").trigger("click");
  assert.equal(readSettings(dir).deliveryTestCommand, "npm run typecheck && npm test");
  assert.match(getEl("lbl-gate-status").textContent, /自定义命令：npm run typecheck && npm test/);

  // External autoRetryMode=off update -> poll shows warning banner when gate is ON
  updateSettings(dir, { autoRetryMode: "off" });
  pollCb();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(getEl("delivery-off-warn").hidden, false);

  // Clear button resets custom command back to auto-detect
  await getEl("btn-clear-delivery-cmd").trigger("click");
  assert.equal(readSettings(dir).deliveryTestCommand, "");
  assert.equal(getEl("inp-delivery-cmd").value, "");
  assert.equal(getEl("btn-clear-delivery-cmd").hidden, true);

  // Tab normalizes cleanly; IME composing Enter does NOT save; emptying input keeps Clear visible when server has a saved command
  getEl("inp-delivery-cmd").value = "npm\trun\ttest";
  await getEl("inp-delivery-cmd").trigger("input");
  await getEl("inp-delivery-cmd").trigger("keydown", { key: "Enter", isComposing: true, preventDefault() {} });
  assert.equal(readSettings(dir).deliveryTestCommand, "");
  await getEl("inp-delivery-cmd").trigger("keydown", { key: "Enter", isComposing: false, preventDefault() {} });
  assert.equal(readSettings(dir).deliveryTestCommand, "npm run test");
  getEl("inp-delivery-cmd").value = "";
  await getEl("inp-delivery-cmd").trigger("input");
  assert.equal(getEl("btn-clear-delivery-cmd").hidden, false);
});

test("P1 Batch A panel API & UI: rejects invalid/9-segment deliveryTestCommand preserving old value, surfaces pre-existing invalid config, and supports /api/resume-normal-session", async (t) => {
  const dir = makeTmpDir("agy-cmd-p1a-panel-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const valid8 = Array.from({ length: 8 }, (_, i) => `npm run check${i + 1}`).join(" && ");
  const invalid9 = Array.from({ length: 9 }, (_, i) => `npm run check${i + 1}`).join(" && ");

  // 1. Valid 8-segment command saves cleanly; 9-segment and unsupported syntax return 400 and preserve valid8
  const ok8 = dispatchPanelApi(
    "/api/settings",
    { deliveryTestGateEnabled: true, deliveryTestCommand: valid8 },
    { stateDir: dir }
  );
  assert.equal(ok8.status, 200);
  assert.equal(ok8.body.settings.deliveryTestCommand, valid8);
  assert.equal(ok8.body.deliveryCommandError, "");

  for (const bad of [invalid9, "npm test | cat", "npm test || true", "npm test; echo ok", "cd backend", "npm test &&"]) {
    const res = dispatchPanelApi("/api/settings", { deliveryTestCommand: bad }, { stateDir: dir });
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.ok, false, bad);
    assert.equal(readSettings(dir).deliveryTestCommand, valid8, `Old value changed on: ${bad}`);
  }

  // 2. Pre-existing invalid command on disk surfaces deliveryCommandError & 需修正 summary
  const settingsPath = path.join(dir, "settings.json");
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.deliveryTestCommand = invalid9;
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");

  const invalidState = dispatchPanelApi("/api/state", {}, { stateDir: dir });
  assert.equal(invalidState.status, 200);
  assert.ok(invalidState.body.deliveryCommandError);
  assert.match(invalidState.body.deliveryGateStatusZh, /自定义命令无效（需修正/);

  // 3. Swarm active session exposes swarmActive and /api/resume-normal-session clears it with anti-reactivation watermark
  const convId = "panel-swarm-conv";
  const txPath = path.join(dir, "panel-swarm.jsonl");
  fs.writeFileSync(
    txPath,
    JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\n/swarm 并行修改\n</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  const env = makeEnv(dir);
  await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 0, initialNumSteps: 2, lastUserInput: "/swarm 并行修改" },
    env,
    1000
  );

  const beforeResume = dispatchPanelApi("/api/state", { conversationId: convId }, { stateDir: dir });
  assert.equal(beforeResume.status, 200);
  assert.equal(beforeResume.body.activeSession?.swarmActive, true);

  const badResume = dispatchPanelApi("/api/resume-normal-session", { conversationId: convId, extra: 1 }, { stateDir: dir });
  assert.equal(badResume.status, 400);

  const resumed = dispatchPanelApi("/api/resume-normal-session", { conversationId: convId }, { stateDir: dir });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.activeSession?.swarmActive, false);

  // Subsequent PreInvocation reading the same transcript tail must NOT re-activate swarmActive!
  fs.appendFileSync(
    txPath,
    JSON.stringify({ step_index: 5, type: "USER_INPUT", content: "<USER_REQUEST>\n普通任务\n</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 0, initialNumSteps: 6, lastUserInput: "普通任务" },
    env,
    2000
  );
  const afterNormal = dispatchPanelApi("/api/state", { conversationId: convId }, { stateDir: dir });
  assert.equal(afterNormal.body.activeSession?.swarmActive, false);

  // 4. Panel inline script renders #delivery-cmd-error and wires #btn-resume-normal button
  const html = renderPanelHtml("tok");
  const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(scriptBlocks.length >= 1);
  const mainScript = scriptBlocks[scriptBlocks.length - 1][1];
  const elements = new Map();
  const makeEl = (id = "") => ({
    id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    href: "",
    dataset: {},
    listeners: {},
    style: { getPropertyValue: () => "" },
    setAttribute() {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      toggle(c, force) { if (force) this.set.add(c); else this.set.delete(c); },
      contains(c) { return this.set.has(c); }
    },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async trigger(ev, arg = {}) { for (const fn of this.listeners[ev] || []) await fn(arg); }
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };
  // Put convId back in Swarm mode for UI button test
  fs.appendFileSync(
    txPath,
    JSON.stringify({ step_index: 10, type: "USER_INPUT", content: "<USER_REQUEST>\n/swarm 再次并行\n</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 0, initialNumSteps: 11, lastUserInput: "/swarm 再次并行" },
    env,
    3000
  );

  const ctx = {
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { style: { getPropertyValue: () => "" }, setAttribute() {} },
      getElementById: (id) => getEl(id),
      querySelectorAll: () => []
    },
    window: {
      addEventListener() {},
      sidecar: {
        conversationId: convId,
        async fetch(url, init = {}) {
          const out = dispatchPanelApi(url, init.body ? JSON.parse(init.body) : {}, { stateDir: dir, defaultConvId: convId });
          return { ok: out.status >= 200 && out.status < 300, status: out.status, async json() { return structuredClone(out.body); } };
        }
      }
    },
    navigator: {},
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {}
  };
  ctx.window.window = ctx.window;
  vm.runInNewContext(mainScript, ctx);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(getEl("delivery-cmd-error").hidden, false);
  assert.match(getEl("delivery-cmd-error").textContent, /已保存的自定义命令无效/);
  assert.equal(getEl("row-swarm-resume").hidden, false);

  await getEl("btn-resume-normal").trigger("click");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getEl("row-swarm-resume").hidden, true);
  assert.equal(dispatchPanelApi("/api/state", { conversationId: convId }, { stateDir: dir }).body.activeSession?.swarmActive, false);
});

test("P1 Batch B · B-2: settings lock timeout aborts writes with 503 preserving file/lock, telemetry stays fail-open, and concurrent JS+Python writes do not clobber", async (t) => {
  const dir = makeTmpDir("agy-cmd-b2-lock-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prevWait = process.env.AGY_CMD_SETTINGS_LOCK_WAIT_MS;
  t.after(() => {
    if (prevWait === undefined) delete process.env.AGY_CMD_SETTINGS_LOCK_WAIT_MS;
    else process.env.AGY_CMD_SETTINGS_LOCK_WAIT_MS = prevWait;
  });

  updateSettings(dir, { planTier: "paid", boostEnabled: true, autoRetryMax: 4 });
  const lockPath = path.join(dir, ".settings.lock");
  const holderToken = "0123456789abcdef";
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: holderToken, ts: Date.now() }) + "\n");
  process.env.AGY_CMD_SETTINGS_LOCK_WAIT_MS = "50";

  // 1. Strict write paths reject with 503 SETTINGS_LOCK_TIMEOUT and keep settings.json & foreign lock intact
  assert.throws(
    () => updateSettings(dir, { autoRetryMax: 9 }),
    (err) => err instanceof SettingsLockTimeoutError && err.statusCode === 503 && err.retryable === true
  );
  const apiRes = dispatchPanelApi("/api/settings", { autoRetryMax: 9 }, { stateDir: dir });
  assert.equal(apiRes.status, 503);
  assert.equal(apiRes.body.code, "SETTINGS_LOCK_TIMEOUT");
  assert.equal(apiRes.body.retryable, true);

  const dismissRes = dispatchPanelApi("/api/dismiss-onboarding", {}, { stateDir: dir });
  assert.equal(dismissRes.status, 503);
  assert.equal(dismissRes.body.code, "SETTINGS_LOCK_TIMEOUT");

  const starRes = dispatchPanelApi("/api/star-prompt", { state: "dismissed" }, { stateDir: dir });
  assert.equal(starRes.status, 503);
  assert.equal(starRes.body.code, "SETTINGS_LOCK_TIMEOUT");

  assert.equal(readSettings(dir).autoRetryMax, 4, "Original settings must remain untouched on lock timeout");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, holderToken, "Holder lock must not be unlinked");

  // 2. Non-critical telemetry & /api/state read remain fail-open under lock contention
  assert.doesNotThrow(() => recordAutoRetryStat(dir, "c1"));
  assert.equal(updateAutoUpdateState(dir, { failedVersion: "2.9.9" }), null);
  const stateRead = dispatchPanelApi("/api/state", {}, { stateDir: dir });
  assert.equal(stateRead.status, 200);
  assert.equal(stateRead.body.settings.autoRetryMax, 4);

  // Release lock and run concurrent JS + Python CLI writes to distinct fields
  fs.unlinkSync(lockPath);
  process.env.AGY_CMD_SETTINGS_LOCK_WAIT_MS = "2500";
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pyScript = path.join(repoRoot, "skills", "agy-cmd", "scripts", "setup_auto_router.py");
  const pyBin = process.platform === "win32" ? "python" : "python3";

  const runSub = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: { ...process.env, AGY_CMD_SETTINGS_LOCK_WAIT_MS: "2500" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err || out}`))));
    });

  const jsWorker = `
    import { updateSettings } from ${JSON.stringify(new URL("../hooks/lib/settings.mjs", import.meta.url).href)};
    updateSettings(process.argv[1], { autoRetryMax: 12, freeFallbackEnabled: false });
  `;
  await Promise.all([
    runSub(process.execPath, ["--input-type=module", "-e", jsWorker, dir]),
    runSub(pyBin, [pyScript, "--delivery-test-gate", "on", "--plan-fallback", "off", "--state-dir", dir, "--json"])
  ]);

  const merged = readSettings(dir);
  assert.equal(merged.autoRetryMax, 12);
  assert.equal(merged.freeFallbackEnabled, false);
  assert.equal(merged.deliveryTestGateEnabled, true);
  assert.equal(merged.planFallbackEnabled, false);
});
