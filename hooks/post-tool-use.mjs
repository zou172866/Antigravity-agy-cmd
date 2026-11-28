#!/usr/bin/env node
/**
 * agy-cmd PostToolUse hook:
 * Records lightweight edit & command/verification outcomes to an append-only
 * per-conversation JSONL log under PLUGIN_DATA so PreInvocation can detect
 * objective failure streaks, edit<->fail oscillations, and read-only Plan Mode
 * artifact write refusals with zero steady-state token overhead.
 * Always outputs `{}` and never blocks tool execution.
 */
import {
  isDirectRun,
  isSubagentPayload,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { classifyToolEvents, isTrackableToolPayload } from "./lib/detector-facts.mjs";
import { readSettings } from "./lib/settings.mjs";
import { appendEvents, readState } from "./lib/state.mjs";
import {
  findTranscriptStep,
  resolveTranscriptPath,
  resolveWorkerTranscriptIdentity
} from "./lib/transcript.mjs";

export async function runPostToolUse(rawInput, env = process.env, nowMs = Date.now()) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env) || !isTrackableToolPayload(payload)) {
    return {};
  }

  const stateDir = resolveStateDir(env);
  const convId = resolveConversationId(payload, env);
  const transcriptPath = resolveTranscriptPath(payload);
  let preloadedTailRaw = null;
  if (transcriptPath) {
    const workerId = resolveWorkerTranscriptIdentity(transcriptPath, {
      stateDir,
      convId,
      nowMs,
      includeTailRaw: true
    });
    if (workerId.isSubagent) {
      return {};
    }
    preloadedTailRaw = workerId._tailRaw || null;
  }

  const stepIdx = Number.isFinite(Number(payload.stepIdx ?? payload.step_idx))
    ? Math.floor(Number(payload.stepIdx ?? payload.step_idx))
    : null;
  const hasInlineResponse = Boolean(
    payload.toolResponse || payload.tool_response || payload.response || payload.result || payload.output
  );
  const transcriptStep =
    transcriptPath && stepIdx !== null && !hasInlineResponse
      ? findTranscriptStep(transcriptPath, stepIdx, { preloadedTailRaw })
      : null;

  if (!convId) {
    return {};
  }
  const settings = readSettings(stateDir);
  const state = readState(stateDir, convId);
  const deliveryGate = settings.deliveryTestGateEnabled
    ? state.deliveryGate || { key: `turn:${state.userTurnCount || 0}`, requested: null }
    : null;
  const events = classifyToolEvents(payload, nowMs, {
    transcriptStep,
    hasTranscriptPath: Boolean(transcriptPath),
    plan: state.freePlan,
    deliveryGate,
    deliveryTestCommand: settings.deliveryTestCommand
  });
  if (events.length === 0) {
    return {};
  }

  try {
    appendEvents(stateDir, convId, events);
  } catch {
    // Fail-open: never disrupt Antigravity tool execution
  }
  return {};
}

async function main() {
  const raw = await readStdin(1000);
  const out = await runPostToolUse(raw, process.env);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
