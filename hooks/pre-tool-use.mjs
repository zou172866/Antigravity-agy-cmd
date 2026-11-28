#!/usr/bin/env node
/**
 * agy-cmd PreToolUse hook (scoped strictly to `exit_plan_mode`):
 * Provides a deterministic guardrail preventing read-only Plan Mode from
 * silently bypassing user plan approval after artifact `write_file` was denied.
 * Always fails open (`{"decision":"allow"}`) on errors or non-target tools.
 */
import {
  isDirectRun,
  isSubagentPayload,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { evaluatePreToolUse } from "./lib/detector.mjs";
import { readSettings } from "./lib/settings.mjs";
import { createDefaultState, readEvents, readState } from "./lib/state.mjs";
import {
  inspectTranscriptTail,
  resolveTranscriptPath,
  resolveWorkerTranscriptIdentity
} from "./lib/transcript.mjs";

export async function runPreToolUse(rawInput, env = process.env) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env)) {
    return { decision: "allow" };
  }

  const toolName = typeof payload.toolCall?.name === "string" ? payload.toolCall.name.trim() : "";
  if (toolName !== "exit_plan_mode") {
    return { decision: "allow" };
  }

  const stateDir = resolveStateDir(env);
  const convId = resolveConversationId(payload, env);
  const transcriptPath = resolveTranscriptPath(payload);
  let preloadedTailRaw = null;
  if (transcriptPath) {
    const workerId = resolveWorkerTranscriptIdentity(transcriptPath, {
      stateDir,
      convId,
      includeTailRaw: true
    });
    if (workerId.isSubagent) {
      return { decision: "allow" };
    }
    preloadedTailRaw = workerId._tailRaw || null;
  }

  try {
    const settings = readSettings(stateDir);
    const prevState = convId ? readState(stateDir, convId) : createDefaultState();
    const events = convId ? readEvents(stateDir, convId, { compact: false }) : [];
    const transcriptTail = transcriptPath ? inspectTranscriptTail(transcriptPath, { preloadedTailRaw }) : null;

    const verdict = evaluatePreToolUse(payload, events, prevState, {
      env,
      settings,
      transcriptTail
    });

    if (verdict.decision && verdict.decision !== "allow") {
      return {
        decision: verdict.decision,
        ...(verdict.reason ? { reason: verdict.reason } : {})
      };
    }

    return { decision: "allow" };
  } catch {
    return { decision: "allow" };
  }
}

async function main() {
  const raw = await readStdin(1000);
  const out = await runPreToolUse(raw, process.env);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch(() => {
    process.stdout.write('{"decision":"allow"}\n');
  });
}
