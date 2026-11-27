#!/usr/bin/env node
/**
 * agy-cmd PreInvocation hook:
 * Zero steady-state token overhead (outputs `{}` on normal turns).
 * Dynamically injects a single concise protojson-safe `systemMessage`
 * (`{ systemMessage: { systemMessage: "..." } }`) ONLY when objective thresholds are hit:
 *   1. Read-only Plan Mode blocked artifact `write_file`
 *   2. Hard debugging requests or repeated failures -> dispatch a Boost role when enabled.
 *      Free fallback can delegate read-only investigation on repeated failures.
 *   3. Explicit unattended fix-until-green request -> suggest `/goal`
 *   4. Repo-wide multi-day migration/rewrite -> suggest `/teamwork`
 */
import {
  detectHostSurface,
  isDirectRun,
  isSubagentPayload,
  isUiOnlyMode,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { evaluatePreInvocation } from "./lib/detector.mjs";
import { detectHostVersion, recordHostDiagnostic } from "./lib/diagnostics.mjs";
import { readSettings } from "./lib/settings.mjs";
import {
  clearEvents,
  createDefaultState,
  maybeGcStaleSessions,
  readEvents,
  readState,
  withSessionLock,
  writeState
} from "./lib/state.mjs";
import {
  inspectTranscriptTail,
  resolveTranscriptPath,
  resolveWorkerTranscriptIdentity
} from "./lib/transcript.mjs";

export async function runPreInvocation(rawInput, env = process.env, nowMs = Date.now()) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env)) {
    return {};
  }

  const stateDir = resolveStateDir(env);
  const convId = resolveConversationId(payload, env);
  const transcriptPath = resolveTranscriptPath(payload);
  if (transcriptPath) {
    const workerId = resolveWorkerTranscriptIdentity(transcriptPath, { stateDir, convId, nowMs });
    if (workerId.isSubagent) {
      return {};
    }
    if (workerId.status === "unknown" && workerId.source !== "fork_window_gap") {
      recordHostDiagnostic(stateDir, {
        surface: detectHostSurface(payload),
        hostVersion: detectHostVersion(payload, env),
        reason: "worker_identity_unknown"
      });
    }
  }
  const uiOnly = isUiOnlyMode(env);

  try {
    const settings = readSettings(stateDir);
    const transcriptTail = transcriptPath ? inspectTranscriptTail(transcriptPath) : null;
    if (transcriptTail?.adapter) {
      const st = transcriptTail.adapter.readStatus;
      if (st === "malformed" || st === "unreadable" || st === "truncated_empty") {
        recordHostDiagnostic(stateDir, {
          surface: detectHostSurface(payload),
          hostVersion: detectHostVersion(payload, env),
          reason: "transcript_parse_unknown"
        });
      } else if (transcriptTail.tailRolledOverWithoutUserInput) {
        recordHostDiagnostic(stateDir, {
          surface: detectHostSurface(payload),
          hostVersion: detectHostVersion(payload, env),
          reason: "transcript_rolled_over_unknown"
        });
      }
    }

    if (!convId) {
      const decision = evaluatePreInvocation(payload, [], createDefaultState(), {
        nowMs,
        env,
        uiOnly,
        settings,
        transcriptTail
      });
      return decision.injectStep ? { injectSteps: [decision.injectStep] } : {};
    }

    const decision = withSessionLock(stateDir, convId, () => {
      const prevState = readState(stateDir, convId);
      const events = readEvents(stateDir, convId);
      const res = evaluatePreInvocation(payload, events, prevState, {
        nowMs,
        env,
        uiOnly,
        settings,
        transcriptTail
      });
      if (res.shouldResetEvents) {
        clearEvents(stateDir, convId);
      }
      if (res.stateChanged) {
        writeState(stateDir, convId, res.nextState);
      }
      return res;
    });

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
