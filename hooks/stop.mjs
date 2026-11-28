#!/usr/bin/env node
/**
 * agy-cmd Stop hook:
 * Enforces the user-configured auto-retry guard (`off` | `count(1..50)` | `infinite`
 * + single-turn natural-language overrides) when unresolved verification/command
 * failures remain at turn completion.
 *
 * Built-in safety brakes (always active even in `infinite` mode):
 *   1. Immediate allow on `USER_CANCELED`, `ERROR`, `MAX_FORCED_INVOCATIONS`, `MAX_INVOCATIONS`, `MAX_TOKEN_BUDGET_EXCEEDED`
 *   2. No-progress stall guard: if a prior continuation produced zero new edit/cmd events, allow stop so questions reach the user
 *   3. Background task guard: allow when `fullyIdle === false`
 *   4. Subagent & explicit `/goal` isolation
 */
import {
  detectHostSurface,
  isDirectRun,
  isSubagentPayload,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { evaluateStop } from "./lib/detector.mjs";
import { detectHostVersion, recordHostDiagnostic } from "./lib/diagnostics.mjs";
import { readSettings, recordAutoRetryStat } from "./lib/settings.mjs";
import { readEvents, readState, withSessionLock, writeState } from "./lib/state.mjs";
import {
  inspectTranscriptTail,
  resolveTranscriptPath,
  resolveWorkerTranscriptIdentity
} from "./lib/transcript.mjs";

export async function runStop(rawInput, env = process.env, nowMs = Date.now()) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env)) {
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
      nowMs,
      includeTailRaw: true
    });
    if (workerId.isSubagent) {
      return { decision: "allow" };
    }
    preloadedTailRaw = workerId._tailRaw || null;
  }
  if (!convId) {
    return { decision: "allow" };
  }

  try {
    const settings = readSettings(stateDir);
    const transcriptTail = transcriptPath ? inspectTranscriptTail(transcriptPath, { preloadedTailRaw }) : null;
    if (transcriptTail?.adapter) {
      const st = transcriptTail.adapter.readStatus;
      if (st === "malformed" || st === "unreadable" || st === "truncated_empty") {
        recordHostDiagnostic(stateDir, {
          surface: detectHostSurface(payload),
          hostVersion: detectHostVersion(payload, env),
          reason: "transcript_parse_unknown"
        });
      }
    }

    const verdict = withSessionLock(stateDir, convId, () => {
      const prevState = readState(stateDir, convId);
      const events = readEvents(stateDir, convId);
      const res = evaluateStop(payload, events, prevState, {
        nowMs,
        env,
        settings,
        transcriptTail
      });
      if (res.stateChanged) {
        writeState(stateDir, convId, res.nextState);
      }
      return res;
    });

    if (verdict.decision === "continue") {
      if (
        verdict.reasonCode !== "approved_plan_missing_verification" &&
        verdict.reasonCode !== "delivery_gate_missing_verification"
      ) {
        recordAutoRetryStat(stateDir, convId, new Date(nowMs).toISOString());
      }
      return {
        decision: "continue",
        reason: verdict.reason
      };
    }

    return { decision: "allow" };
  } catch {
    // Fail-open: never trap the agent in an unrecoverable loop
    return { decision: "allow" };
  }
}

async function main() {
  const raw = await readStdin(1000);
  const out = await runStop(raw, process.env);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch(() => {
    process.stdout.write('{"decision":"allow"}\n');
  });
}
