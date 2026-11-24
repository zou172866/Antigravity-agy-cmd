import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractActiveSlashCommands,
  isSubagentPayload,
  resolveStateDir,
  sanitizeConversationId,
  sanitizeSnippet,
  unwrapUserRequestText
} from "../hooks/lib/common.mjs";
import {
  classifyToolEvents,
  evaluatePreInvocation,
  unwrapCliFilterCommand
} from "../hooks/lib/detector.mjs";
import { maybeGcStaleSessions, readEvents } from "../hooks/lib/state.mjs";
import { isSubagentTranscript } from "../hooks/lib/transcript.mjs";
import { runPostToolUse } from "../hooks/post-tool-use.mjs";
import { runPreInvocation } from "../hooks/pre-invocation.mjs";
import { runStop } from "../hooks/stop.mjs";
import { readSettings, updateSettings } from "../hooks/lib/settings.mjs";
import { planPreferences } from "../hooks/lib/plan-verification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function makeTmpDir(prefix = "agy-cmd-test-") {
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

async function freePlanFixture(t, { settings, task = "重构入口", approval = true, packageTest = true } = {}) {
  const dir = makeTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = makeEnv(path.join(dir, "data"));
  const workspace = path.join(dir, "project");
  fs.mkdirSync(workspace);
  const manifest = JSON.stringify({ scripts: packageTest ? { test: "node --test" } : {} });
  fs.writeFileSync(path.join(workspace, "package.json"), manifest);
  if (settings) updateSettings(env.AGY_CMD_STATE_DIR, settings);
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const base = { conversationId: "scope", cwd: workspace, workspacePaths: [workspace], transcriptPath };
  const rows = [{ step_index: 0, type: "USER_INPUT", content: task }];
  if (approval) rows.push(
    { step_index: 1, type: "PLANNER_RESPONSE", content: "[agy-cmd → /plan 审批]\n请审阅。" },
    { step_index: 2, type: "USER_INPUT", content: "按计划执行" }
  );
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const pre = (extra = {}) => runPreInvocation({ ...base, initialNumSteps: rows.length, invocationNum: 1, ...extra }, env);
  assert.deepEqual(await pre({ invocationNum: 0 }), {});
  const post = (stepIdx, name, args, toolResponse) => runPostToolUse({ ...base, stepIdx, toolCall: { name, args }, toolResponse }, env);
  const edit = (idx, target = "app.ts") => post(idx, "edit_file",
    { Path: JSON.stringify(path.join(workspace, target)), Target: JSON.stringify("return 1;"), Replacement: JSON.stringify("return 2;") },
    "Made 1 replacement in " + target + " at line 2.");
  const command = (idx, cmd, response, cwd = workspace) => post(idx, "run_command", { CommandLine: cmd, Cwd: cwd }, response);
  const stop = (extra = {}) => runStop({ ...base, terminationReason: "NO_TOOL_CALL", fullyIdle: true, ...extra }, env);
  const stats = () => readSettings(env.AGY_CMD_STATE_DIR).stats.totalAutoRetries;
  const append = (row) => fs.appendFileSync(transcriptPath, JSON.stringify(row) + "\n");
  return { pre, post, edit, command, stop, stats, append, workspace, manifest };
}

test("approved free plan prompts once after a real native edit and shares the retry budget without increasing failure statistics", async (t) => {
  const f = await freePlanFixture(t, { settings: { autoRetryMax: 1 } });
  await f.edit(3);
  assert.deepEqual(await f.pre(), {});
  for (const extra of [{ terminationReason: "USER_CANCELED" }, { fullyIdle: false }, { terminationReason: "UNKNOWN" },
    { terminationReason: "MAX_INVOCATIONS" }, { lastUserInput: "/goal" }, { executionNum: 1 }]) {
    assert.deepEqual(await f.stop(extra), { decision: "allow" });
  }
  const verdict = await f.stop({ terminationReason: "model_stop" });
  assert.equal(verdict.decision, "continue");
  assert.match(verdict.reason, /计划补验.*npm test/);
  assert.equal(f.stats(), 0);
  assert.deepEqual(await f.stop(), { decision: "allow" });
  await f.command(4, "npm test", "Command exited with code 1.");
  assert.deepEqual(await f.stop(), { decision: "allow" });
  assert.equal(f.stats(), 0);
});

test("approved plans require a completed test in each edited package at or after its edit step", async (t) => {
  const f = await freePlanFixture(t);
  const other = path.join(f.workspace, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "package.json"), f.manifest);
  await f.command(3, "npm test", "Command exited with code 0.");
  await f.edit(4);
  await f.edit(5, "other/app.ts");
  await f.command(6, "npm test", "Command exited with code 0.", other);
  await f.command(7, "echo test", "Command exited with code 0.");
  await f.command(8, "npm test", "");
  const missing = await f.stop();
  assert.match(missing.reason, /计划补验/);
  assert.doesNotMatch(missing.reason, /other/);
  const clean = await freePlanFixture(t);
  await clean.edit(3);
  await clean.command(4, "npm.cmd test", "Command exited with code 0.");
  assert.deepEqual(await clean.stop(), { decision: "allow" });
});

test("real apply_edits hunks with same-step inline checks, pending background completion and terminal failures", async (t) => {
  const f = await freePlanFixture(t);
  const edits = [{ path: "src/app.ts", hunks: [{ target: "return 1;", replacement: "return 2;" }] }];
  await f.post(3, "apply_edits", { cwd: f.workspace, edits: JSON.stringify(edits), verify: "npm test" },
    "Applied edits to 1 file(s):\n- src/app.ts: updated\nVerify [PASS in 30ms] `npm test`:");
  assert.deepEqual(await f.stop(), { decision: "allow" });
  await f.command(4, "npm test", "Tool is running as a background task with task id: scope/task-4");
  await f.edit(5);
  f.append({ step_index: 6, type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-01-01 sender=scope/task-4 finished with result:\nCommand exited with code 0." });
  assert.match((await f.stop()).reason, /计划补验/);
  await f.command(7, "npm test", "Command exited with code 1.");
  assert.match((await f.stop()).reason, /自动续跑/);
  assert.equal(f.stats(), 1);

  const repaired = await freePlanFixture(t);
  await repaired.command(3, "npm test", "Command exited with code 1.");
  await repaired.edit(4);
  assert.match((await repaired.stop()).reason, /计划补验/);
  assert.equal(repaired.stats(), 0);
});

test("missing-check nudges ignore ordinary tasks, ambiguous edits, unavailable checks, skip requests and disabled budgets", async (t) => {
  for (const args of [{ approval: false }, { packageTest: false }, { task: "重构但不用跑测试" },
    { settings: { autoRetryMode: "off" } }, { settings: { autoRetryScope: "goal_only" } }]) {
    const f = await freePlanFixture(t, args);
    await f.edit(3);
    assert.deepEqual(await f.stop(), { decision: "allow" });
    if (args.task) {
      await f.command(4, "npm test", "Command exited with code 1.");
      assert.deepEqual(await f.stop(), { decision: "allow" });
    }
  }
  const f = await freePlanFixture(t);
  const native = { Path: "src/app.ts", Target: "// before", Replacement: "// after" };
  await f.post(3, "edit_file", native, "Made 1 replacement in src/app.ts");
  await f.edit(4, "README.md");
  await f.edit(5, "templates/sample.ts");
  await f.post(6, "write_file", { Path: "app.ts", Content: "return 1;", Overwrite: true }, "Created file.");
  await f.post(7, "edit_file", { Path: "app.ts", Target: "return 1;", Replacement: "return 2;" }, "");
  const edits = [{ path: "app.ts", hunks: [{ target: "return 1;", replacement: "return 2;" }] }];
  await f.post(8, "apply_edits", { edits, dryRun: true }, "Dry run validated 1 file(s) (0 files modified):");
  await f.post(9, "apply_edits", { edits, bestEffort: true }, "Partial edit applied (1/2 file(s) written; 1 file(s) failed)");
  assert.deepEqual(await f.stop(), { decision: "allow" });
  assert.deepEqual(planPreferences("Do not skip tests. 请勿跳过独立复核"), { skipCheck: false, skipReview: false });
  assert.deepEqual(planPreferences("不要跳过测试，但跳过复核"), { skipCheck: false, skipReview: true });
});

test("opt-in review requires an approved implementation and actual write, and never redispatches after wakeup or replay", async (t) => {
  const f = await freePlanFixture(t, { settings: { freePlanReviewEnabled: true } });
  assert.deepEqual(await f.pre(), {});
  await f.edit(3);
  const result = await f.pre();
  assert.match(result.injectSteps?.[0]?.systemMessage.systemMessage, /invoke_subagent once.*cmd-verifier.*Workspace='inherit'/);
  assert.deepEqual(await f.pre(), {});
  f.append({ step_index: 4, type: "PLANNER_RESPONSE", content: "running" });
  f.append({ step_index: 5, type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-01-01 sender=scope/task-3 finished with result: ok" });
  assert.deepEqual(await f.pre({ invocationNum: 0, initialNumSteps: 6, lastUserInput: "" }), {});
  assert.match((await f.stop()).reason, /计划补验/);
  f.append({ step_index: 6, type: "USER_INPUT", content: "解释这段代码" });
  assert.deepEqual(await f.pre({ invocationNum: 0, initialNumSteps: 7 }), {});
  await f.edit(7);
  assert.deepEqual(await f.pre({ invocationNum: 1, initialNumSteps: 7 }), {});
  assert.deepEqual(await f.stop(), { decision: "allow" });
});

test("confirmed whole-file overwrite can receive review without treating unknown prior contents as a code change", async (t) => {
  const f = await freePlanFixture(t, { settings: { freePlanReviewEnabled: true } });
  await f.post(3, "write_file", { Path: "app.ts", Overwrite: true, Content: "// note\nexport const version = 1;" }, "Created file.");
  assert.match((await f.pre()).injectSteps[0].systemMessage.systemMessage, /cmd-verifier/);
  assert.deepEqual(await f.stop(), { decision: "allow" });
  assert.deepEqual(await f.pre(), {});
});

test("bounded plan commands cover root runtime config, preserve its package manager, and honor a user question", async (t) => {
  const f = await freePlanFixture(t, { task: "修改根目录配置。验收命令为 `pnpm test`。", packageTest: false });
  await f.post(3, "edit_file", { Path: "tsconfig.json", Target: '"strict": false,', Replacement: '"strict": true,' },
    "Made 1 replacement in tsconfig.json at line 2.");
  f.append({ step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "ask_question" }] });
  assert.deepEqual(await f.stop(), { decision: "allow" });
  f.append({ step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file" }] });
  assert.match((await f.stop()).reason, /计划补验.*pnpm test/);
});

test("paid Boost hands an approved plan to the executor once through the desktop hook", async (t) => {
  const dir = makeTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = makeEnv(dir);
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const plan = { type: "PLANNER_RESPONSE", content: "[agy-cmd → /plan 审批]\n请审阅方案。" };
  const artifact = { type: "PLANNER_RESPONSE", tool_calls: [{ name: "write_file", args: {
    Path: '"C:\\brain\\implementation_plan_v2.md"', ArtifactMetadata: '{"RequestFeedback":true}'
  } }] };
  const question = { type: "PLANNER_RESPONSE", tool_calls: [{ name: "ask_question" }] };
  const approval = "Comments on artifact URI: file:///c%3A/brain/implementation_plan_v2.md\n\nThe user has approved this document.\n\n<USER_REQUEST>\n\n</USER_REQUEST>";
  const request = (content) => ({ type: "USER_INPUT", content });
  async function run(conversationId, steps, extra = {}) {
    const log = [request("帮我重构"), ...steps].map((s, step_index) => JSON.stringify({ step_index, ...s }));
    fs.writeFileSync(transcriptPath, log.join("\n") + "\n");
    return runPreInvocation({ conversationId, transcriptPath, invocationNum: 0, initialNumSteps: log.length, ...extra }, env);
  }
  assert.deepEqual(await run("free", [request(approval)]), {});
  updateSettings(dir, { planTier: "paid", boostEnabled: false });
  assert.deepEqual(await run("disabled", [request(approval)]), {});
  updateSettings(dir, { boostEnabled: true });
  updateSettings(dir, { boostAfterPlanApproval: false });
  assert.deepEqual(await run("plan-boost-off", [request(approval)]), {});
  assert.deepEqual(await run("plan-boost-chat-off", [plan, request("按计划执行")]), {});
  updateSettings(dir, { planTier: "free" });
  const paidAgain = updateSettings(dir, { planTier: "paid" });
  assert.equal(paidAgain.boostEnabled, true);
  assert.equal(paidAgain.boostAfterPlanApproval, false);
  updateSettings(dir, { boostAfterPlanApproval: true });
  for (const [name, steps] of [
    ["button", [request(approval)]],
    ["inline", [plan, request("按计划执行")]],
    ["artifact", [artifact, request("继续")]]
  ]) {
    const result = await run(name, steps);
    const injected = result.injectSteps[0].systemMessage.systemMessage;
    assert.match(injected, /> \*\*\[agy-cmd → 计划获批，自动 Boost\]\*\*/);
    assert.match(injected, /Start line 1 of your reply with "\[agy-cmd → 计划获批，自动 Boost\]"/);
    assert.match(injected, /hidden from the <subagents>/);
    assert.match(injected, /invoke_subagent.*DeepCoder.*Workspace='inherit'/s);
    assert.match(injected, /ONLY if invoke_subagent actually returns an error/);
    assert.deepEqual(await run(name, steps), {});
    assert.deepEqual(await run(name, steps, { invocationNum: 1 }), {});
    // Background task wakeup increases initialNumSteps with invocationNum=0 and empty lastUserInput: must not re-fire
    const wakeupSteps = [
      ...steps,
      { type: "PLANNER_RESPONSE", content: "[agy-cmd → 计划获批，自动 Boost]\n正在启动..." },
      { type: "SYSTEM_MESSAGE", content: "[Message] sender=c/task-240 finished with result: ok" }
    ];
    assert.deepEqual(await run(name, wakeupSteps, { lastUserInput: "" }), {}, `${name} wakeup dedup`);
    // A second distinct plan approval in the same session must still fire once
    const secondPlan = [...wakeupSteps, plan, request(approval)];
    const secondResult = await run(name, secondPlan, { lastUserInput: approval });
    assert.equal(secondResult.injectSteps?.length, 1, `${name} second plan approval`);
    assert.deepEqual(await run(name, [...secondPlan, { type: "PLANNER_RESPONSE", content: "ok" }], { lastUserInput: "" }), {});
  }
  for (const [name, steps] of [
    ["waiting", [plan]],
    ["question", [plan, question, request("同意")]],
    ["revision", [plan, request("可以先改一下计划吗？")]],
    ["manual", [plan, request("按计划执行 /boost")]],
    ["unrelated", [request("继续")]],
    ["superseded", [plan, request("先等等"), request("继续")]],
    ["other-artifact", [request(approval.replace("implementation_plan_v2", "walkthrough"))]],
    ["quoted", [request("<USER_REQUEST>\n" + approval + "\n</USER_REQUEST>")]],
    ["qualified", [plan, request(approval.replace("<USER_REQUEST>\n\n", "<USER_REQUEST>\n先别执行\n"))]]
  ]) {
    assert.deepEqual(await run(name, steps), {}, name);
  }
});

test("paid Boost edge cases: null step_index, >256KB tail rollover, unflushed approval, and Stop wakeup preservation", async (t) => {
  const dir = makeTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = makeEnv(dir);
  updateSettings(dir, { planTier: "paid", boostEnabled: true, boostAfterPlanApproval: true });

  const approval =
    "Comments on artifact URI: file:///c%3A/brain/implementation_plan_v2.md\n\nThe user has approved this document.\n\n<USER_REQUEST>\n\n</USER_REQUEST>";
  const plan = { type: "PLANNER_RESPONSE", content: "[agy-cmd → /plan 审批]\n请审阅方案。" };

  // 1. Null / empty step_index with distinct approvals must NOT collide on step:0
  const nullTx = path.join(dir, "null-idx.jsonl");
  const nullLines = [
    { step_index: null, type: "USER_INPUT", content: "重构模块" },
    { step_index: null, ...plan },
    { step_index: null, type: "USER_INPUT", content: approval }
  ];
  fs.writeFileSync(nullTx, nullLines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const rNull1 = await runPreInvocation(
    { conversationId: "null-idx", transcriptPath: nullTx, invocationNum: 0, initialNumSteps: 3, lastUserInput: approval },
    env,
    1000
  );
  assert.equal(rNull1.injectSteps?.length, 1);
  fs.appendFileSync(
    nullTx,
    [plan, { step_index: null, type: "USER_INPUT", content: approval }].map((x) => JSON.stringify(x)).join("\n") + "\n"
  );
  const rNull2 = await runPreInvocation(
    { conversationId: "null-idx", transcriptPath: nullTx, invocationNum: 0, initialNumSteps: 5, lastUserInput: approval },
    env,
    2000
  );
  assert.equal(rNull2.injectSteps?.length, 1);

  // 2a. >256KB tail rollover without step_index/created_at: byte offset keeps second approval distinct
  const rollTx = path.join(dir, "rollover-ord.jsonl");
  const pad160k = "A".repeat(160 * 1024);
  const pad140k = "B".repeat(140 * 1024);
  fs.writeFileSync(
    rollTx,
    [
      { type: "USER_INPUT", content: `首次请求 ${pad160k}` },
      { type: "USER_INPUT", content: approval }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rRoll1 = await runPreInvocation(
    { conversationId: "roll-ord", transcriptPath: rollTx, invocationNum: 0, initialNumSteps: 2, lastUserInput: approval },
    env,
    3000
  );
  assert.equal(rRoll1.injectSteps?.length, 1);
  fs.appendFileSync(
    rollTx,
    [
      { type: "GENERIC", status: "DONE", content: pad140k },
      plan,
      { type: "USER_INPUT", content: approval }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rRoll2 = await runPreInvocation(
    { conversationId: "roll-ord", transcriptPath: rollTx, invocationNum: 0, initialNumSteps: 5, lastUserInput: approval },
    env,
    4000
  );
  assert.equal(rRoll2.injectSteps?.length, 1);

  // 2b. >256KB output pushing USER_INPUT & PLANNER_RESPONSE out of tail while payload.lastUserInput keeps approval: wakeup must NOT re-fire
  const bigOutTx = path.join(dir, "rollover-wakeup.jsonl");
  fs.writeFileSync(
    bigOutTx,
    [
      { step_index: 0, type: "USER_INPUT", content: "帮我重构" },
      { step_index: 1, ...plan },
      { step_index: 2, type: "USER_INPUT", content: approval }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rBig1 = await runPreInvocation(
    { conversationId: "roll-wake", transcriptPath: bigOutTx, invocationNum: 0, initialNumSteps: 3, lastUserInput: approval },
    env,
    5000
  );
  assert.equal(rBig1.injectSteps?.length, 1);
  fs.appendFileSync(
    bigOutTx,
    [
      { step_index: 3, type: "PLANNER_RESPONSE", content: "[agy-cmd → 计划获批，自动 Boost]" },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "C".repeat(270 * 1024) }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rBigWake = await runPreInvocation(
    { conversationId: "roll-wake", transcriptPath: bigOutTx, invocationNum: 0, initialNumSteps: 5, lastUserInput: approval },
    env,
    6000
  );
  assert.deepEqual(rBigWake, {});

  // 3. Delayed transcript flush on clickedApproval: fires once before USER_INPUT flush, stays suppressed on later wakeup
  const flushTx = path.join(dir, "delayed-flush.jsonl");
  fs.writeFileSync(
    flushTx,
    [
      { step_index: 0, type: "USER_INPUT", content: "帮我重构" },
      { step_index: 1, ...plan }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rFlush1 = await runPreInvocation(
    { conversationId: "flush-1", transcriptPath: flushTx, invocationNum: 0, initialNumSteps: 2, lastUserInput: approval },
    env,
    7000
  );
  assert.equal(rFlush1.injectSteps?.length, 1);
  fs.appendFileSync(
    flushTx,
    [
      { step_index: 2, type: "USER_INPUT", content: approval },
      { step_index: 3, type: "PLANNER_RESPONSE", content: "[agy-cmd → 计划获批，自动 Boost]" },
      { step_index: 4, type: "SYSTEM_MESSAGE", content: "[Message] sender=flush-1/task-4 finished with result: ok" }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "flush-1", transcriptPath: flushTx, invocationNum: 1, initialNumSteps: 2, lastUserInput: approval },
      env,
      7100
    ),
    {}
  );
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "flush-1", transcriptPath: flushTx, invocationNum: 0, initialNumSteps: 5, lastUserInput: "" },
      env,
      7200
    ),
    {}
  );

  // 4. Wakeup after pre-wakeup edit + test failure must NOT wipe Stop's turnFloorTs
  const stopTx = path.join(dir, "stop-wakeup.jsonl");
  fs.writeFileSync(
    stopTx,
    [
      { step_index: 0, type: "USER_INPUT", content: "帮我重构" },
      { step_index: 1, ...plan },
      { step_index: 2, type: "USER_INPUT", content: approval }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  const rStopEntry = await runPreInvocation(
    { conversationId: "stop-wake", transcriptPath: stopTx, invocationNum: 0, initialNumSteps: 3, lastUserInput: approval },
    env,
    10000
  );
  assert.equal(rStopEntry.injectSteps?.length, 1);
  await runPostToolUse(
    { conversationId: "stop-wake", transcriptPath: stopTx, stepIdx: 4, toolCall: { name: "edit_file", args: { Path: "src/a.js" } } },
    env,
    10500
  );
  await runPostToolUse(
    { conversationId: "stop-wake", transcriptPath: stopTx, stepIdx: 5, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    10600
  );
  fs.appendFileSync(
    stopTx,
    [
      { step_index: 3, type: "PLANNER_RESPONSE", content: "[agy-cmd → 计划获批，自动 Boost]" },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "ok" },
      { step_index: 5, type: "GENERIC", status: "ERROR", error: "exit status 1", content: "Command exited with code 1." },
      { step_index: 6, type: "SYSTEM_MESSAGE", content: "[Message] sender=stop-wake/task-5 finished with result:\nCommand exited with code 1." }
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "stop-wake", transcriptPath: stopTx, invocationNum: 0, initialNumSteps: 7, lastUserInput: "" },
      env,
      30000
    ),
    {}
  );
  const stopDecision = await runStop(
    { conversationId: "stop-wake", transcriptPath: stopTx, terminationReason: "NO_TOOL_CALL", executionNum: 0, fullyIdle: true },
    env,
    31000
  );
  assert.equal(stopDecision.decision, "continue");
});

test("common: extractActiveSlashCommands detects prefix/suffix/quoted commands and ignores URLs/paths", () => {
  assert.deepEqual([...extractActiveSlashCommands("/boost fix race condition")], ["boost"]);
  assert.deepEqual([...extractActiveSlashCommands("方案A和B同时做了吧 /boost")], ["boost"]);
  assert.deepEqual([...extractActiveSlashCommands("请用 /goal 修到全绿")], ["goal"]);
  assert.deepEqual([...extractActiveSlashCommands("帮我优化 `/goal` 的触发条件")], ["goal"]);
  assert.deepEqual([...extractActiveSlashCommands("访问 https://example.com/boost/api 报错")], []);
  assert.deepEqual([...extractActiveSlashCommands("编辑 src/plan/index.ts 和 C:/goal/run.js")], []);
});

test("common: sanitizeConversationId blocks path traversal and preserves safe IDs", () => {
  assert.equal(sanitizeConversationId("abc-123_XYZ.1"), "abc-123_XYZ.1");
  const escaped = sanitizeConversationId("../../etc/passwd");
  assert.match(escaped, /^h_[0-9a-f]{24}$/);
  assert.ok(!escaped.includes(".."));
  assert.ok(!escaped.includes("/"));
  assert.equal(sanitizeConversationId(""), "default");
});

test("common: sanitizeSnippet redacts secrets and strips backticks/newlines", () => {
  const s = sanitizeSnippet("token=supersecret123 Bearer abcdefgh123456\n`rm -rf`", 80);
  assert.ok(!s.includes("supersecret123"));
  assert.ok(!s.includes("abcdefgh123456"));
  assert.ok(!s.includes("`"));
  assert.ok(!s.includes("\n"));
});

test("common: isSubagentPayload detects env vars and payload fields", () => {
  assert.equal(isSubagentPayload({ conversationId: "c1" }, {}), false);
  assert.equal(isSubagentPayload({ conversationId: "c1" }, { ANTIGRAVITY_PARENT_CONVERSATION_ID: "p1" }), true);
  assert.equal(isSubagentPayload({ conversationId: "c1" }, { ANTIGRAVITY_SUBAGENT: "1" }), true);
  assert.equal(isSubagentPayload({ conversationId: "c1", parentConversationId: "p1" }, {}), true);
  assert.equal(isSubagentPayload({ conversationId: "c1", isSubagent: true }, {}), true);
  assert.equal(isSubagentPayload({ conversationId: "child", rootConversationId: "root" }, {}), true);
  assert.equal(isSubagentPayload({ conversationId: "c1", role: "worker" }, {}), true);
});

test("steady state: normal prompts and below-threshold failures return {} with zero overhead", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-steady";

  const out0 = await runPreInvocation(
    { conversationId: convId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "解释一下 src/index.ts 做了什么" },
    env,
    1000
  );
  assert.deepEqual(out0, {});

  // 2 command failures (below threshold of 3)
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    1010
  );
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    1020
  );

  const out1 = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 1, lastUserInput: "解释一下 src/index.ts 做了什么" },
    env,
    1030
  );
  assert.deepEqual(out1, {});
});

test("benign search exit-1 (rg/grep) and read-only MCP calls never trigger failure alerts", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-benign";

  for (let i = 0; i < 5; i++) {
    await runPostToolUse(
      {
        conversationId: convId,
        toolCall: { name: "run_command", args: { CommandLine: "rg nonexistent_symbol src/" } },
        error: "exit status 1"
      },
      env,
      2000 + i * 10
    );
  }

  // Read-only MCP tool should write zero events
  const roEvents = classifyToolEvents({
    toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_fast", ToolName: "batch_search", Arguments: { queries: [] } } }
  });
  assert.equal(roEvents.length, 0);

  const out = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 2, lastUserInput: "查找一下这个符号" },
    env,
    2100
  );
  assert.deepEqual(out, {});
});

test("Trigger 1: Plan Mode read-only write_file refusal injects immediate inline-plan fallback once", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-plan-mode";

  // Turn start
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: convId, invocationNum: 0, initialNumSteps: 3, lastUserInput: "重构 auth、session 和 router 三个模块" },
      env,
      3000
    ),
    {}
  );

  // Plan Mode refuses write_file on Implementation Plan artifact
  await runPostToolUse(
    {
      conversationId: convId,
      stepIdx: 5,
      toolCall: {
        name: "write_file",
        args: {
          Path: "/mock/home/.gemini/antigravity/brain/x/implementation_plan.md",
          ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: "Plan" }
        }
      },
      error: "Tool write_file is not allowed in read-only Plan Mode"
    },
    env,
    3010
  );

  const out1 = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 3, lastUserInput: "重构 auth、session 和 router 三个模块" },
    env,
    3020
  );
  assert.equal(out1.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(out1.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /agy-cmd → \/plan 审批/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /Do NOT call exit_plan_mode/);

  // Must not repeat on next invocation for the same blocked event
  const out2 = await runPreInvocation(
    { conversationId: convId, invocationNum: 2, initialNumSteps: 3, lastUserInput: "重构 auth、session 和 router 三个模块" },
    env,
    3030
  );
  assert.deepEqual(out2, {});
});

test("Plan Mode trigger does not false-fire on unrelated OS EACCES error to normal source file", () => {
  const evs = classifyToolEvents({
    toolCall: { name: "write_file", args: { Path: "src/app.ts", Content: "x" } },
    error: "EACCES: permission denied, open 'src/app.ts'"
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].planModeWriteBlocked, false);
});

test("Trigger 2a: >=2 edit<->fail oscillations trigger /boost once, and passing verify resets & re-arms", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-osc";

  // Cycle 1: edit -> fail
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "edit_file", args: { Path: "src/auth.ts" } } },
    env,
    4000
  );
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    4010
  );

  // Cycle 2: edit -> fail
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "edit_file", args: { Path: "src/auth.ts" } } },
    env,
    4020
  );
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    4030
  );

  const out1 = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 10, lastUserInput: "修一下 auth 测试" },
    env,
    4040
  );
  assert.equal(out1.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(out1.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /agy-cmd → 自动换视角排查/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /one available investigator \("dart-reviewer" or "research"\) a read-only task/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /src\/auth\.ts/);

  // Cooldown: must NOT fire again immediately during same episode
  const out2 = await runPreInvocation(
    { conversationId: convId, invocationNum: 2, initialNumSteps: 10, lastUserInput: "修一下 auth 测试" },
    env,
    4050
  );
  assert.deepEqual(out2, {});

  // Passing verification clears and re-arms
  await runPostToolUse(
    {
      conversationId: convId,
      toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
      toolResponse: "Command exited with code 0\nAll tests passed"
    },
    env,
    4060
  );
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: convId, invocationNum: 3, initialNumSteps: 10, lastUserInput: "修一下 auth 测试" },
      env,
      4070
    ),
    {}
  );

  // Brand new oscillation episode later via apply_edits + inline verify FAIL (even when isError:true)
  for (let i = 0; i < 2; i++) {
    await runPostToolUse(
      {
        conversationId: convId,
        isError: true,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "agy-dart_fast",
            ToolName: "apply_edits",
            Arguments: { edits: [{ path: "src/token.ts", hunks: [] }], verify: "pytest" }
          }
        },
        toolResponse: "Applied edits to 1 file(s):\n- src/token.ts: updated\nVerify [FAIL exit 1] `pytest`: AssertionError"
      },
      env,
      4100 + i * 20
    );
  }

  const out3 = await runPreInvocation(
    { conversationId: convId, invocationNum: 4, initialNumSteps: 10, lastUserInput: "修一下 token 模块" },
    env,
    4200
  );
  assert.equal(out3.injectSteps?.length, 1);
  assert.match(out3.injectSteps[0].systemMessage.systemMessage, /src\/token\.ts/);
});

test("Trigger 2b: >=3 consecutive command failures trigger /boost; passing command resets streak", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-3fails";

  // 2 fails + 1 pass + 2 fails => NOT 3 consecutive
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" }, env, 5000);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" }, env, 5010);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, toolResponse: "Command exited with code 0" }, env, 5020);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" }, env, 5030);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" }, env, 5040);

  assert.deepEqual(
    await runPreInvocation({ conversationId: convId, invocationNum: 1, initialNumSteps: 4, lastUserInput: "跑测试" }, env, 5050),
    {}
  );

  // 3rd consecutive failure via run_checks
  await runPostToolUse(
    {
      conversationId: convId,
      toolCall: {
        name: "call_mcp_tool",
        args: { ToolName: "run_checks", Arguments: { commands: [{ name: "unit", command: "pytest" }] } }
      },
      toolResponse: "Checks: 0/1 passed, 1 failed\n## [FAIL] unit"
    },
    env,
    5060
  );

  const out = await runPreInvocation(
    { conversationId: convId, invocationNum: 2, initialNumSteps: 4, lastUserInput: "跑测试" },
    env,
    5070
  );
  assert.equal(out.injectSteps?.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /连续 3 次命令失败/);
});

test("Trigger 2c: multi-turn repeated debugging triggers /boost, while non-debug style feedback does not", async () => {
  // Case A: non-debug CSS tweak -> soft continuation "还是不行" must NOT false-trigger
  const dirA = makeTmpDir();
  const envA = makeEnv(dirA);
  assert.deepEqual(
    await runPreInvocation({ conversationId: "css-1", invocationNum: 0, initialNumSteps: 1, lastUserInput: "把按钮背景色改深一点" }, envA, 6000),
    {}
  );
  assert.deepEqual(
    await runPreInvocation({ conversationId: "css-1", invocationNum: 0, initialNumSteps: 5, lastUserInput: "还是不行，再深一点" }, envA, 6010),
    {}
  );

  // Case B: Turn 1 debug -> Turn 2 "改完还是不行" MUST trigger /boost
  const dirB = makeTmpDir();
  const envB = makeEnv(dirB);
  assert.deepEqual(
    await runPreInvocation({ conversationId: "dbg-1", invocationNum: 0, initialNumSteps: 1, lastUserInput: "修一下登录接口的 TypeError 报错" }, envB, 6100),
    {}
  );
  const outB = await runPreInvocation(
    { conversationId: "dbg-1", invocationNum: 0, initialNumSteps: 6, lastUserInput: "改完还是不行" },
    envB,
    6110
  );
  assert.equal(outB.injectSteps?.length, 1);
  assert.match(outB.injectSteps[0].systemMessage.systemMessage, /跨 2 轮未解决/);

  // Case C: Turn 1 fresh session says "还是报错" -> must NOT false-fire on turn 1
  const dirC = makeTmpDir();
  const envC = makeEnv(dirC);
  assert.deepEqual(
    await runPreInvocation({ conversationId: "dbg-2", invocationNum: 0, initialNumSteps: 1, lastUserInput: "帮我看看这段代码还是报错" }, envC, 6200),
    {}
  );
});

test("Trigger 3 & 4: /goal and /teamwork fire on turn entry only and suppress when slash command already present", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);

  // Chinese /goal intent
  const goalOut = await runPreInvocation(
    { conversationId: "g1", invocationNum: 0, initialNumSteps: 1, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
    env,
    7000
  );
  assert.equal(goalOut.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(goalOut.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(goalOut.injectSteps[0].systemMessage.systemMessage, /agy-cmd → 自动续跑已启用/);

  // Mid-turn continuation must NOT repeat /goal
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "g1", invocationNum: 1, initialNumSteps: 1, lastUserInput: "帮我把所有单测修到全绿，中途别停" },
      env,
      7010
    ),
    {}
  );

  // Already invoked /goal -> suppressed
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "g2", invocationNum: 0, initialNumSteps: 1, lastUserInput: "/goal 把所有单测修到全绿，中途别停" },
      env,
      7020
    ),
    {}
  );

  // A user's chosen workflow keeps control even when a mid-turn failure streak would reroute it.
  for (const command of ["/boost", "/swarm", "/run-workflow", "/goal"]) {
    const conversationId = `chosen-${command.slice(1)}`;
    const lastUserInput = `排查反复报错的模块 ${command}`;
    await runPreInvocation({ conversationId, invocationNum: 0, initialNumSteps: 8, lastUserInput }, env, 7090);
    for (let i = 0; i < 3; i++) {
      await runPostToolUse(
        { conversationId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
        env, 7100 + i * 10
      );
    }
    assert.deepEqual(await runPreInvocation({ conversationId, invocationNum: 1, initialNumSteps: 8, lastUserInput }, env, 7150), {});
  }

  // Teamwork intent
  const twOut = await runPreInvocation(
    { conversationId: "tw1", invocationNum: 0, initialNumSteps: 1, lastUserInput: "请帮我做整个项目的仓库级迁移，从 Vue 2 升到 Vue 3" },
    env,
    7200
  );
  assert.equal(twOut.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(twOut.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(twOut.injectSteps[0].systemMessage.systemMessage, /agy-cmd → 分阶段迁移规划/);

  for (const [i, lastUserInput] of ["什么是仓库级迁移？", "不要做仓库级迁移，只修这个页面。", "What is a repo-wide migration?"].entries()) {
    const explanation = await runPreInvocation({ conversationId: `migration-question-${i}`, invocationNum: 0, initialNumSteps: 1, lastUserInput }, env, 7210);
    assert.deepEqual(explanation, {});
  }
});

test("rewind (initialNumSteps decrease) and /compact clear stale failure streaks", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-rewind";

  // Turn at step 10
  await runPreInvocation({ conversationId: convId, invocationNum: 0, initialNumSteps: 10, lastUserInput: "跑测试" }, env, 8000);
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
      env,
      8010 + i * 10
    );
  }
  // Rewind to step 4 -> must clear stale failures and return {}
  const afterRewind = await runPreInvocation(
    { conversationId: convId, invocationNum: 0, initialNumSteps: 4, lastUserInput: "换个思路" },
    env,
    8050
  );
  assert.deepEqual(afterRewind, {});
  assert.equal(readEvents(dir, convId).length, 0);

  // /compact also clears events
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
    env,
    8060
  );
  const afterCompact = await runPreInvocation(
    { conversationId: convId, invocationNum: 0, initialNumSteps: 6, lastUserInput: "/compact" },
    env,
    8070
  );
  assert.deepEqual(afterCompact, {});
  assert.equal(readEvents(dir, convId).length, 0);
});

test("silent hook mode (AGY_CMD_UI_ONLY=1) suppresses systemMessage injection while still updating state", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir, { AGY_CMD_UI_ONLY: "1" });
  const out = await runPreInvocation(
    { conversationId: "ui-only", invocationNum: 0, initialNumSteps: 1, lastUserInput: "帮我一直修到全部测试通过，中途别停" },
    env,
    9000
  );
  assert.deepEqual(out, {});
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "ui-only.state.json"), "utf8"));
  assert.equal(saved.lastGoalAlertTurn, 1);
});

test("subagent payloads are completely ignored by both hooks", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "sub-1";

  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      {
        conversationId: convId,
        parentConversationId: "parent-1",
        toolCall: { name: "run_command", args: { CommandLine: "pytest" } },
        error: "exit status 1"
      },
      env,
      9500 + i
    );
  }
  assert.equal(readEvents(dir, convId).length, 0);

  const out = await runPreInvocation(
    {
      conversationId: convId,
      parentConversationId: "parent-1",
      invocationNum: 0,
      initialNumSteps: 1,
      lastUserInput: "修到全绿，中途别停"
    },
    env,
    9550
  );
  assert.deepEqual(out, {});
});

test("log compaction invariance: >180 events still resets boostAlerted on subsequent pass", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "conv-compact-log";

  for (let i = 0; i < 190; i++) {
    await runPostToolUse(
      {
        conversationId: convId,
        toolCall: { name: "run_command", args: { CommandLine: "pytest" } },
        toolResponse: "Command exited with code 0"
      },
      env,
      10000 + i
    );
  }
  // 3 failures -> trigger boost
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      10300 + i
    );
  }
  const firstAlert = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 20, lastUserInput: "修测试" },
    env,
    10400
  );
  assert.equal(firstAlert.injectSteps?.length, 1);
  // Compaction should have trimmed log to <=120 lines
  assert.ok(readEvents(dir, convId).length <= 120);

  // Passing run resets boostAlerted
  await runPostToolUse(
    { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, toolResponse: "Command exited with code 0" },
    env,
    10500
  );
  assert.deepEqual(
    await runPreInvocation({ conversationId: convId, invocationNum: 2, initialNumSteps: 20, lastUserInput: "修测试" }, env, 10510),
    {}
  );

  // 3 new failures must fire again (proving compaction did not break reset)
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env,
      10600 + i
    );
  }
  const secondAlert = await runPreInvocation(
    { conversationId: convId, invocationNum: 3, initialNumSteps: 20, lastUserInput: "修测试" },
    env,
    10700
  );
  assert.equal(secondAlert.injectSteps?.length, 1);
});

test("stale session GC removes >7d files and preserves fresh ones", () => {
  const dir = makeTmpDir();
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const oldFile = path.join(sessionsDir, "old.state.json");
  const freshFile = path.join(sessionsDir, "fresh.state.json");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(freshFile, "{}\n");

  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

  const removed = maybeGcStaleSessions(dir, now);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
});

test("end-to-end subprocess CLI hooks (matching hooks.json commands) handle valid & malformed stdin", () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const runHook = (relPath, input) =>
    spawnSync(process.execPath, [relPath], {
      cwd: PLUGIN_ROOT,
      input,
      encoding: "utf8",
      timeout: 5000,
      env
    });

  // Malformed & empty stdin fail-open to {} with zero stderr
  for (const bad of ["", "not-json", "[]", "123", "null"]) {
    const r1 = runHook("./hooks/post-tool-use.mjs", bad);
    assert.equal(r1.status, 0);
    assert.equal(r1.stderr, "");
    assert.deepEqual(JSON.parse(r1.stdout.trim()), {});

    const r2 = runHook("./hooks/pre-invocation.mjs", bad);
    assert.equal(r2.status, 0);
    assert.equal(r2.stderr, "");
    assert.deepEqual(JSON.parse(r2.stdout.trim()), {});

    const r3 = runHook("./hooks/session-start.mjs", bad);
    assert.equal(r3.status, 0);
    assert.equal(r3.stderr, "");
    assert.deepEqual(JSON.parse(r3.stdout.trim()), {});

    const r4 = runHook("./hooks/stop.mjs", bad);
    assert.equal(r4.status, 0);
    assert.equal(r4.stderr, "");
    assert.deepEqual(JSON.parse(r4.stdout.trim()), { decision: "allow" });
  }

  // Real flow via subprocesses: 3 failing commands -> PreInvocation injects /boost
  for (let i = 0; i < 3; i++) {
    const r = runHook(
      "./hooks/post-tool-use.mjs",
      JSON.stringify({
        conversationId: "e2e-cli-1",
        hookEventName: "PostToolUse",
        toolCall: { id: `t${i}`, name: "run_command", args: { CommandLine: "npm test" } },
        error: "exit status 1"
      })
    );
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {});
  }

  const pre = runHook(
    "./hooks/pre-invocation.mjs",
    JSON.stringify({
      conversationId: "e2e-cli-1",
      hookEventName: "PreInvocation",
      invocationNum: 1,
      initialNumSteps: 5,
      lastUserInput: "修一下单测"
    })
  );
  assert.equal(pre.status, 0);
  assert.equal(pre.stderr, "");
  const parsed = JSON.parse(pre.stdout.trim());
  assert.equal(parsed.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(parsed.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /agy-cmd → 自动换视角排查/);
});

test("fenced code blocks containing trigger phrases do not false-fire /goal or /teamwork", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const prompt = "帮我润色一下这段文档排版：\n```markdown\n示例：修到全绿、中途别停、仓库级迁移\n```";
  const out = await runPreInvocation(
    { conversationId: "codeblock-1", invocationNum: 0, initialNumSteps: 1, lastUserInput: prompt },
    env,
    11000
  );
  assert.deepEqual(out, {});
});

test("PLUGIN_DATA env var is used by hooks when AGY_CMD_STATE_DIR is unset", () => {
  const dir = makeTmpDir("agy-cmd-plugin-data-");
  const env = {
    ...process.env,
    PLUGIN_DATA: dir,
    AGY_CMD_STATE_DIR: "",
    ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
    ANTIGRAVITY_SUBAGENT: ""
  };
  const shellCmd = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = (cmd) => (process.platform === "win32" ? ["/c", cmd] : ["-c", cmd]);

  const hooksCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks.json"), "utf8"));
  const postCmd = hooksCfg["agy-cmd-router"].PostToolUse[0].hooks[0].command;
  const preCmd = hooksCfg["agy-cmd-router"].PreInvocation[0].command;

  for (let i = 0; i < 3; i++) {
    const r = spawnSync(shellCmd, shellArgs(postCmd), {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({
        conversationId: "shell-e2e",
        toolCall: { name: "run_command", args: { CommandLine: "pytest" } },
        error: "exit status 1"
      }),
      encoding: "utf8",
      timeout: 5000,
      env
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {});
  }

  const pre = spawnSync(shellCmd, shellArgs(preCmd), {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify({
      conversationId: "shell-e2e",
      invocationNum: 1,
      initialNumSteps: 3,
      lastUserInput: "继续查 pytest"
    }),
    encoding: "utf8",
    timeout: 5000,
    env
  });
  assert.equal(pre.status, 0, pre.stderr);
  const parsed = JSON.parse(pre.stdout.trim());
  assert.equal(parsed.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(parsed.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /自动换视角排查/);
  assert.ok(fs.existsSync(path.join(dir, "sessions", "shell-e2e.state.json")));

  // Cross-plugin MCP env guard: if invoked under another plugin's MCP server (e.g. PLUGIN_DATA=.../plugin_data/agy-dart),
  // resolveStateDir redirects to sibling .../plugin_data/agy-cmd instead of polluting agy-dart!
  const fakeParent = path.join(dir, "plugin_data");
  assert.equal(
    resolveStateDir({ PLUGIN_DATA: path.join(fakeParent, "agy-dart"), AGY_CMD_STATE_DIR: "" }),
    path.join(fakeParent, "agy-cmd")
  );
});

test("pure evaluatePreInvocation handles null/missing fields gracefully", () => {
  const res = evaluatePreInvocation(null, [], null);
  assert.equal(res.injectStep, null);
  assert.equal(res.reasonCode, "empty_payload");
});

function writeTranscript(dir, name, lines) {
  const txPath = path.join(dir, name);
  fs.writeFileSync(txPath, lines.map((obj) => JSON.stringify(obj)).join("\n") + "\n", "utf8");
  return txPath;
}

function appendTranscript(txPath, lines) {
  fs.appendFileSync(txPath, lines.map((obj) => JSON.stringify(obj)).join("\n") + "\n", "utf8");
}

test("real Antigravity runtime: PostToolUse without toolResponse/error reconciles run_command, run_checks & apply_edits:verify from transcript.jsonl", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "real-tx-1";
  const txPath = writeTranscript(dir, "transcript.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n修一下单测报错\n</USER_REQUEST>" }
  ]);

  // Turn entry
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: convId, transcriptPath: txPath, invocationNum: 0, initialNumSteps: 1, lastUserInput: "修一下单测报错" },
      env,
      12000
    ),
    {}
  );

  // Step 2: run_command exits with code 1 (NO toolResponse, NO error in PostToolUse; flushed to transcript AFTER PostToolUse!)
  await runPostToolUse(
    {
      conversationId: convId,
      transcriptPath: txPath,
      stepIdx: 2,
      toolCall: { name: "run_command", args: { CommandLine: "python scripts/run_tests.py --layer unit" } }
    },
    env,
    12010
  );
  appendTranscript(txPath, [
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Created At: 2026-11-21T23:41:53-05:00\nCompleted At: 2026-11-21T23:41:57-05:00\nCommand exited with code 1.\n\nCommand output:\nTraceback (most recent call last):\nAssertionError: boom"
    }
  ]);

  // Step 4: run_checks returns 1/2 passed, 1 failed (isError:false -> NO error in PostToolUse!)
  await runPostToolUse(
    {
      conversationId: convId,
      transcriptPath: txPath,
      stepIdx: 4,
      toolCall: {
        name: "call_mcp_tool",
        args: { ToolName: "run_checks", Arguments: { commands: [{ name: "unit", command: "pytest" }] } }
      }
    },
    env,
    12020
  );
  appendTranscript(txPath, [
    {
      step_index: 4,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Created At: 2026-11-21T23:42:21-05:00\nCompleted At: 2026-11-21T23:42:26-05:00\nChecks: 1/2 passed, 1 failed (wall: 2819ms)\n\n- [FAIL] unit"
    }
  ]);

  // Step 6: apply_edits with inline verify FAIL (isError:false -> NO error in PostToolUse!)
  await runPostToolUse(
    {
      conversationId: convId,
      transcriptPath: txPath,
      stepIdx: 6,
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ToolName: "apply_edits",
          Arguments: { edits: [{ path: "src/core.py", hunks: [] }], verify: "pytest" }
        }
      }
    },
    env,
    12030
  );
  appendTranscript(txPath, [
    {
      step_index: 6,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Created At: 2026-11-21T23:42:30-05:00\nCompleted At: 2026-11-21T23:42:32-05:00\nApplied edits to 1 file(s):\n- src/core.py: updated\nVerify [FAIL in 120ms] `pytest`:\nAssertionError"
    }
  ]);

  // 3 consecutive real failures (step 2 run_command + step 4 run_checks + step 6 apply_edits:verify) -> MUST trigger /boost!
  const out = await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 1, initialNumSteps: 1, lastUserInput: "修一下单测报错" },
    env,
    12040
  );
  assert.equal(out.injectSteps?.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /连续 3 次命令失败/);

  // Verify resolvedSteps cached in state survives >128KB transcript rollover
  const bigPad = "x".repeat(140 * 1024);
  appendTranscript(txPath, [{ step_index: 99, source: "MODEL", type: "GENERIC", status: "DONE", content: bigPad }]);
  const statePath = path.join(dir, "sessions", `${convId}.state.json`);
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(saved.resolvedSteps["2"]?.failed, true);
  assert.equal(saved.resolvedSteps["4"]?.failed, true);
  assert.equal(saved.resolvedSteps["6"]?.verifyResult?.failed, true);
});

test("real Antigravity runtime: background tasks (status RUNNING -> completion SYSTEM_MESSAGE) never falsely reset streaks", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "bg-task-1";
  const txPath = writeTranscript(dir, "bg.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n修单测\n</USER_REQUEST>" },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "Command exited with code 1.\nFAIL 1" },
    { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", content: "Command exited with code 1.\nFAIL 2" }
  ]);

  // 2 failures first
  await runPostToolUse({ conversationId: convId, transcriptPath: txPath, stepIdx: 2, toolCall: { name: "run_command", args: { CommandLine: "pytest" } } }, env, 13000);
  await runPostToolUse({ conversationId: convId, transcriptPath: txPath, stepIdx: 4, toolCall: { name: "run_command", args: { CommandLine: "pytest" } } }, env, 13010);

  // Step 6 starts as RUNNING background task
  appendTranscript(txPath, [
    {
      step_index: 6,
      source: "MODEL",
      type: "GENERIC",
      status: "RUNNING",
      content: `Created At: 2026-11-21T23:38:38-05:00\nTool is running as a background task with task id: ${convId}/task-6\nTask Description: python scripts/run_tests.py`
    }
  ]);
  await runPostToolUse(
    { conversationId: convId, transcriptPath: txPath, stepIdx: 6, toolCall: { name: "run_command", args: { CommandLine: "python scripts/run_tests.py" } } },
    env,
    13020
  );

  // While still running, streak stays at 2 (not reset to 0, not bumped to 3)
  assert.deepEqual(
    await runPreInvocation({ conversationId: convId, transcriptPath: txPath, invocationNum: 1, initialNumSteps: 1, lastUserInput: "修单测" }, env, 13030),
    {}
  );

  // Background task finishes with exit code 1 via SYSTEM_MESSAGE -> streak reaches 3 -> triggers /boost!
  appendTranscript(txPath, [
    {
      step_index: 10,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T04:39:14Z sender=${convId}/task-6 priority=MESSAGE_PRIORITY_HIGH content=Task id "${convId}/task-6" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError`
    }
  ]);
  const out = await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 2, initialNumSteps: 1, lastUserInput: "修单测" },
    env,
    13040
  );
  assert.equal(out.injectSteps?.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /连续 3 次命令失败/);
});

test("real Antigravity runtime: PreToolUse-denied Plan Mode write_file (ZERO PostToolUse) triggers inline-plan fallback from transcript.jsonl", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "real-plan-deny";
  const txPath = writeTranscript(dir, "plan-deny.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n重构三个核心模块，先给方案\n</USER_REQUEST>" },
    {
      step_index: 84,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [
        {
          name: "write_file",
          args: {
            ArtifactMetadata: JSON.stringify({ RequestFeedback: true, UserFacing: true, Summary: "Plan" }),
            Path: '"/mock/home/.gemini/antigravity/brain/x/implementation_plan.md"'
          }
        }
      ]
    },
    {
      step_index: 85,
      source: "MODEL",
      type: "GENERIC",
      status: "ERROR",
      error: "tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace. Plan mode is read-only: finish the plan and call exit_plan_mode with it; the execution model makes the changes.",
      content: "Created At: 2026-11-21T23:10:47-05:00\nCompleted At: 2026-11-21T23:10:49-05:00\nEncountered error in step execution: tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace. Plan mode is read-only: finish the plan and call exit_plan_mode with it; the execution model makes the changes."
    }
  ]);

  // Notice: ZERO PostToolUse calls occurred (because PreToolUse denied write_file!)
  const out1 = await runPreInvocation(
    { conversationId: convId, transcriptPath: txPath, invocationNum: 1, initialNumSteps: 1, lastUserInput: "重构三个核心模块，先给方案" },
    env,
    14000
  );
  assert.equal(out1.injectSteps?.length, 1);
  assert.deepEqual(Object.keys(out1.injectSteps[0].systemMessage), ["systemMessage"]);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /agy-cmd → \/plan 审批/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /do NOT call exit_plan_mode/i);

  // Must not repeat on subsequent invocation for same step 85
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: convId, transcriptPath: txPath, invocationNum: 2, initialNumSteps: 1, lastUserInput: "重构三个核心模块，先给方案" },
      env,
      14010
    ),
    {}
  );

  // If Plan mode is turned off AFTER a denial (in a fresh conversation), stale denial must NOT fire
  const txOff = writeTranscript(dir, "plan-off.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n重构\n</USER_REQUEST>" },
    {
      step_index: 10,
      source: "MODEL",
      type: "GENERIC",
      status: "ERROR",
      error: "tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace. Plan mode is read-only: finish the plan and call exit_plan_mode with it.",
      content: "Encountered error in step execution: tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace."
    },
    {
      step_index: 12,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Created At: 2026-11-21T23:12:36-05:00\nCompleted At: 2026-11-21T23:12:38-05:00\nPlan mode is off."
    }
  ]);
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "real-plan-off", transcriptPath: txOff, invocationNum: 1, initialNumSteps: 1, lastUserInput: "重构" },
      env,
      14020
    ),
    {}
  );

  // Accidental write_file to non-plan source file in Plan Mode must NOT hijack with plan-artifact fallback
  const txNonPlan = writeTranscript(dir, "plan-non-artifact.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n分析代码\n</USER_REQUEST>" },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "write_file", args: { Path: '"src/app.ts"', Content: '"x"' } }]
    },
    {
      step_index: 6,
      source: "MODEL",
      type: "GENERIC",
      status: "ERROR",
      error: "tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace. Plan mode is read-only.",
      content: "Encountered error in step execution: tool call denied by pre-tool hook: Plan mode is on, and write_file changes the workspace."
    }
  ]);
  assert.deepEqual(
    await runPreInvocation(
      { conversationId: "real-plan-src", transcriptPath: txNonPlan, invocationNum: 1, initialNumSteps: 1, lastUserInput: "分析代码" },
      env,
      14030
    ),
    {}
  );
});

test("real Antigravity runtime: subagents detected from transcript head (zero USER_INPUT + [Message] sender=) write zero state files", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const subId = "subagent-live-like";
  const subTx = writeTranscript(dir, "sub-tx.jsonl", [
    { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", content: "The following is a <SYSTEM_MESSAGE> ... SessionStart hook" },
    { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T04:41:55Z sender=53380b3a-bd6f-4225-8acd-2a41e378f072 priority=MESSAGE_PRIORITY_HIGH content=<original_task>" }
  ]);

  assert.equal(isSubagentTranscript(subTx), true);

  // No explicit parentConversationId / isSubagent fields at all (matches real Antigravity hooks!)
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      {
        conversationId: subId,
        transcriptPath: subTx,
        stepIdx: 10 + i,
        toolCall: { name: "run_command", args: { CommandLine: "pytest" } },
        error: "exit status 1"
      },
      env,
      15000 + i
    );
  }
  const out = await runPreInvocation(
    { conversationId: subId, transcriptPath: subTx, invocationNum: 1, initialNumSteps: 15, lastUserInput: "" },
    env,
    15020
  );
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(path.join(dir, "sessions", `${subId}.events.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(dir, "sessions", `${subId}.state.json`)), false);

  // Main session transcript with USER_INPUT is NOT misclassified as subagent
  const mainTx = writeTranscript(dir, "main-tx.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n帮我查问题\n</USER_REQUEST>" },
    { step_index: 1, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", content: "SessionStart hook" }
  ]);
  assert.equal(isSubagentTranscript(mainTx), false);

  // Giant (>64KB) line 1 subagent prompt in transcript_full.jsonl is STILL classified as subagent!
  const giantSubTx = writeTranscript(dir, "giant-sub-full.jsonl", [
    { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", content: "SessionStart hook" },
    { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T04:41:55Z sender=parent-uuid content=${"A".repeat(80 * 1024)}` }
  ]);
  assert.equal(isSubagentTranscript(giantSubTx), true);

  // Giant (>64KB) line 0 USER_INPUT in transcript_full.jsonl is STILL classified as main session!
  const giantMainTx = writeTranscript(dir, "giant-main-full.jsonl", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${"B".repeat(80 * 1024)}\n</USER_REQUEST>` }
  ]);
  assert.equal(isSubagentTranscript(giantMainTx), false);
});

test("agy-dart cli-filter.mjs --orig-b64/--b64 unwrapping preserves benign rg exit-1 and verify detection", async () => {
  const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
  const wrappedRg = `node "/mock/home/.gemini/config/plugins/agy-dart/hooks/cli-filter.mjs" --rule rg --b64 ${enc("rg missing_sym src/")} --orig-b64 ${enc("rg missing_sym src/")} --session ${enc("c1")}`;
  const wrappedPytest = `node "/mock/home/.gemini/config/plugins/agy-dart/hooks/cli-filter.mjs" --rule test-runner --b64 ${enc("pytest -q")} --orig-b64 ${enc("pytest -q")} --session ${enc("c1")}`;

  assert.equal(unwrapCliFilterCommand(wrappedRg), "rg missing_sym src/");
  assert.equal(unwrapCliFilterCommand(wrappedPytest), "pytest -q");

  const rgEvs = classifyToolEvents({
    toolCall: { name: "run_command", args: { CommandLine: wrappedRg } },
    toolResponse: "A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.\n\nCommand exited with code 1."
  });
  assert.equal(rgEvs.length, 1);
  assert.equal(rgEvs[0].failed, false);
  assert.equal(rgEvs[0].isReadOnlyCmd, true);

  const pytestEvs = classifyToolEvents({
    toolCall: { name: "run_command", args: { CommandLine: wrappedPytest } },
    toolResponse: "Command exited with code 1.\nFAILED tests/test_a.py"
  });
  assert.equal(pytestEvs.length, 1);
  assert.equal(pytestEvs[0].failed, true);
  assert.equal(pytestEvs[0].isVerify, true);
});

test("read-only inspection commands (git diff/status) and ctx_execute never wipe edit<->fail oscillations or failure streaks", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "readonly-preserves-osc";

  // Cycle 1: edit -> git diff (pass) -> ctx_execute (ignored) -> run_tests.py (fail)
  await runPostToolUse({ conversationId: convId, toolCall: { name: "edit_file", args: { Path: "src/worker.py" } } }, env, 16000);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "git diff --stat" } }, toolResponse: "Command exited with code 0." }, env, 16010);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "call_mcp_tool", args: { ToolName: "ctx_execute", Arguments: { language: "nodejs", intent: "inspect" } } }, toolResponse: '{"ok":true}' }, env, 16015);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "python scripts/run_tests.py --layer unit" } }, error: "exit status 1" }, env, 16020);

  // Cycle 2: edit -> git status (pass) -> run_tests.py (fail)
  await runPostToolUse({ conversationId: convId, toolCall: { name: "edit_file", args: { Path: "src/worker.py" } } }, env, 16030);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "cd e:\\repo && git status" } }, toolResponse: "Command exited with code 0." }, env, 16040);
  await runPostToolUse({ conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "python scripts/run_tests.py --layer unit" } }, error: "exit status 1" }, env, 16050);

  const out = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 5, lastUserInput: "修一下 worker.py 单测" },
    env,
    16060
  );
  assert.equal(out.injectSteps?.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /2 次「修改→仍失败」震荡/);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /src\/worker\.py/);
});

test("stale failures from an earlier turn never false-fire /boost on unrelated lightweight questions after cooldown", async () => {
  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const convId = "stale-pivot";

  // Turn 1: debug + 3 command failures -> fires /boost once
  await runPreInvocation({ conversationId: convId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "修单测" }, env, 17000);
  for (let i = 0; i < 3; i++) {
    await runPostToolUse(
      { conversationId: convId, toolCall: { name: "run_command", args: { CommandLine: "npm test" } }, error: "exit status 1" },
      env,
      17010 + i * 10
    );
  }
  const firstAlert = await runPreInvocation(
    { conversationId: convId, invocationNum: 1, initialNumSteps: 1, lastUserInput: "修单测" },
    env,
    17050
  );
  assert.equal(firstAlert.injectSteps?.length, 1);

  // Turns 2, 3, 4: user pivots to unrelated lightweight questions without running tests
  for (const [turnStep, prompt, ts] of [
    [10, "算了先不管单测，解释一下 README.md", 17100],
    [15, "看看 package.json 有哪些脚本", 17200],
    [20, "解释一下 config.toml", 17300]
  ]) {
    const out = await runPreInvocation(
      { conversationId: convId, invocationNum: 0, initialNumSteps: turnStep, lastUserInput: prompt },
      env,
      ts
    );
    assert.deepEqual(out, {}, `Turn at step ${turnStep} ("${prompt}") must NOT false-fire stale /boost`);
  }
});

test("unwrapUserRequestText strips <ADDITIONAL_METADATA> so expanded slash prompts never pollute intent regexes", async () => {
  const wrapped = "<USER_REQUEST>\n解释一下 config.toml\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n修到全绿 仓库级迁移 /boost\n</ADDITIONAL_METADATA>";
  assert.equal(unwrapUserRequestText(wrapped), "解释一下 config.toml");

  const dir = makeTmpDir();
  const env = makeEnv(dir);
  const out = await runPreInvocation(
    { conversationId: "unwrap-1", invocationNum: 0, initialNumSteps: 1, lastUserInput: wrapped },
    env,
    18000
  );
  assert.deepEqual(out, {});
});

test("hooks.json cross-workspace bootstrapper executes all 4 hooks cleanly from a foreign workspace CWD", () => {
  const dir = makeTmpDir("agy-cmd-foreign-cwd-");
  const foreignWs = path.join(dir, "business-repo");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(foreignWs, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const hooksCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks.json"), "utf8"));
  const spec = hooksCfg["agy-cmd-router"];
  const env = {
    ...process.env,
    PLUGIN_ROOT,
    PLUGIN_DATA: stateDir,
    AGY_CMD_STATE_DIR: "",
    ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
    ANTIGRAVITY_SUBAGENT: ""
  };

  for (const [evName, cmdStr, payload, checkFn] of [
    ["SessionStart", spec.SessionStart[0].command, { conversationId: "xcwd-1" }, (o) => typeof o === "object"],
    [
      "PostToolUse",
      spec.PostToolUse[0].hooks[0].command,
      { conversationId: "xcwd-1", toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit 1" },
      (o) => Object.keys(o).length === 0
    ],
    [
      "PreInvocation",
      spec.PreInvocation[0].command,
      { conversationId: "xcwd-1", invocationNum: 0, initialNumSteps: 1, lastUserInput: "你好" },
      (o) => typeof o === "object"
    ],
    [
      "Stop",
      spec.Stop[0].command,
      { conversationId: "xcwd-1", terminationReason: "IDLE_READY", fullyIdle: true },
      (o) => o.decision === "allow"
    ]
  ]) {
    const res = spawnSync(cmdStr, {
      shell: true,
      cwd: foreignWs,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env
    });
    assert.equal(res.status, 0, `${evName} failed from foreign CWD: ${res.stderr}`);
    assert.equal(res.stderr, "", `${evName} emitted unexpected stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.ok(checkFn(parsed), `${evName} unexpected output: ${res.stdout}`);
  }
});

test("detector classifies stringified apply_edits.edits and Error [HOST_SERIALIZATION_CORRUPTION] zero-write aborts", () => {
  const okEvents = classifyToolEvents({
    conversationId: "det-str-1",
    toolCall: {
      name: "mcp_agy-dart_fast_apply_edits",
      args: { edits: JSON.stringify([{ path: "src/app.mjs", create: "export default 1;\n" }]) }
    },
    toolResponse: "Applied edits to 1 file(s):\n- src/app.mjs: created, lines +1"
  });
  assert.equal(okEvents.length, 1);
  assert.equal(okEvents[0].failed, false);
  assert.deepEqual(okEvents[0].files, ["src/app.mjs"]);

  const corruptEvents = classifyToolEvents({
    conversationId: "det-str-2",
    toolCall: {
      name: "call_mcp_tool",
      args: { ServerName: "agy-dart_fast", ToolName: "apply_edits", Arguments: { edits: [] } }
    },
    toolResponse: "Error [HOST_SERIALIZATION_CORRUPTION]: 'edits' must be a non-empty array of file edit objects"
  });
  assert.equal(corruptEvents.length, 1);
  assert.equal(corruptEvents[0].failed, true);
  assert.equal(corruptEvents[0].abortedNoWrite, true);
});
