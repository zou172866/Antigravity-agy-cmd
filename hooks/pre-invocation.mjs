#!/usr/bin/env node
/**
 * agy-cmd PreInvocation hook:
 * Zero steady-state token overhead (outputs `{}` on normal turns).
 * Dynamically injects a single concise protojson-safe `systemMessage`
 * (`{ systemMessage: { systemMessage: "..." } }`) ONLY when objective thresholds are hit:
 *   1. Read-only Plan Mode blocked artifact `write_file`
 *   2. >=2 edit<->fail oscillations, >=3 consecutive command failures,
 *      or >=2 consecutive unresolved debug turns -> suggest `/boost`
 *   3. Explicit unattended fix-until-green request -> suggest `/goal`
 *   4. Repo-wide multi-day migration/rewrite -> suggest `/teamwork`
 */
import {
  isDirectRun,
  isSubagentPayload,
  isUiOnlyMode,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { evaluatePreInvocation } from "./lib/detector.mjs";
import { readSettings } from "./lib/settings.mjs";
import {
  clearEvents,
  maybeGcStaleSessions,
  readEvents,
  readState,
  writeState
} from "./lib/state.mjs";
import {
  inspectTranscriptTail,
  isSubagentTranscript,
  resolveTranscriptPath
} from "./lib/transcript.mjs";

export async function runPreInvocation(rawInput, env = process.env, nowMs = Date.now()) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env)) {
    return {};
  }

  const transcriptPath = resolveTranscriptPath(payload);
  if (transcriptPath && isSubagentTranscript(transcriptPath)) {
    return {};
  }

  const stateDir = resolveStateDir(env);
  const convId = resolveConversationId(payload, env);
  const uiOnly = isUiOnlyMode(env);

  try {
    const settings = readSettings(stateDir);
    const prevState = readState(stateDir, convId);
    const events = readEvents(stateDir, convId);
    const transcriptTail = transcriptPath ? inspectTranscriptTail(transcriptPath) : null;

    const decision = evaluatePreInvocation(payload, events, prevState, {
      nowMs,
      env,
      uiOnly,
      settings,
      transcriptTail
    });

    if (decision.shouldResetEvents) {
      clearEvents(stateDir, convId);
    }
    if (decision.stateChanged) {
      writeState(stateDir, convId, decision.nextState);
    }
    maybeGcStaleSessions(stateDir, nowMs);

    if (!decision.injectStep) {
      return {};
    }

    return {
      injectSteps: [decision.injectStep]
    };
  } catch {
    // Fail-open: never block model invocation
    return {};
  }
}

async function main() {
  const raw = await readStdin(1000);
  const out = await runPreInvocation(raw, process.env);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
