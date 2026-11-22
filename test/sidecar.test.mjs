import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultSettings,
  parseTurnRetryOverride,
  readSettings,
  updateSettings
} from "../hooks/lib/settings.mjs";
import { runPostToolUse } from "../hooks/post-tool-use.mjs";
import { runPreInvocation } from "../hooks/pre-invocation.mjs";
import { runSessionStart } from "../hooks/session-start.mjs";
import { runStop } from "../hooks/stop.mjs";
import { createStandaloneServer } from "../sidecars/panel/server.mjs";

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

test("defaults: strictly starts in Free-Tier Safe Mode (boostEnabled=false) with count=3 retries and configuredByUser=false", () => {
  const dir = makeTmpDir();
  const s = readSettings(dir);
  assert.deepEqual(s, createDefaultSettings());
  assert.equal(s.planTier, "free");
  assert.equal(s.boostEnabled, false);
  assert.equal(s.autoRetryMode, "count");
  assert.equal(s.autoRetryMax, 3);
  assert.equal(s.autoRetryScope, "goal_only");
  assert.equal(s.configuredByUser, false);
  assert.equal(s.onboardingShown, false);
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
  assert.match(freeMsg, /Do NOT suggest \/boost/i);

  // Repo-wide migration in Free tier -> emits phased plan fallback, NEVER "/teamwork <cmd>"
  const freeTw = await runPreInvocation(
    { conversationId: "c-free-tw", invocationNum: 0, initialNumSteps: 1, lastUserInput: "做整个项目的仓库级迁移" },
    env,
    1100
  );
  assert.equal(freeTw.injectSteps?.length, 1);
  assert.match(freeTw.injectSteps[0].systemMessage.systemMessage, /分阶段迁移规划/);

  // 2. Switch to Paid tier in settings -> auto-enables boostEnabled -> stuck failures suggest /boost
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
  assert.match(paidOut.injectSteps[0].systemMessage.systemMessage, /建议 \/boost/);

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
    assert.equal(stData.settings.configuredByUser, false);

    // 4. Invalid autoRetryMax rejected with 400
    const badPatch = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ autoRetryMax: 999 })
    });
    assert.equal(badPatch.status, 400);

    // 5. Update via Sidecar UI -> sets autoRetryMode="off", planTier="paid" -> immediately read by hooks!
    const updRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ autoRetryMode: "off", planTier: "paid" })
    });
    assert.equal(updRes.status, 200);
    const updData = await updRes.json();
    assert.equal(updData.settings.autoRetryMode, "off");
    assert.equal(updData.settings.planTier, "paid");
    assert.equal(updData.settings.boostEnabled, true);
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
