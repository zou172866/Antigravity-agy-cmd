/**
 * Layer 2 (Ledger): Reconcile pending tool receipts against transcript steps,
 * track per-turn verification metrics, and audit test-assertion weakening.
 */
import { nonEmptyString } from "./common.mjs";
import { stripTranscriptStepHeaders } from "./transcript.mjs";
import {
  applyEditReceipt,
  filterTestWeakeningByAppliedFiles
} from "./plan-verification.mjs";
import {
  BG_RUNNING_RE,
  classifyCommandOutcome,
  classifyEditOutcome,
  parseNonNegInt
} from "./detector-facts.mjs";

/**
 * Reconcile PostToolUse events with the real Antigravity transcript tail (and cached
 * `state.resolvedSteps`) so command exit codes, `run_checks` failures, `apply_edits`
 * inline verify results, and background task completions are resolved accurately even
 * when Antigravity omits `toolResponse` and `error` from `PostToolUse`.
 */
export function reconcileEventsWithTranscript(events, transcriptTail = null, prevResolvedSteps = {}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const prevCache = prevResolvedSteps && typeof prevResolvedSteps === "object" ? prevResolvedSteps : {};
  const nextCache = {};
  const resolvedEvents = [];

  const stepsByIndex = transcriptTail?.stepsByIndex instanceof Map ? transcriptTail.stepsByIndex : null;
  const taskResults = transcriptTail?.taskResultsByStepIdx instanceof Map ? transcriptTail.taskResultsByStepIdx : null;
  const receiptsAdapterUnknown = transcriptTail?.adapter?.states?.toolReceipts === "unknown";
  const tailTruncated = Boolean(transcriptTail?.truncated);
  let unknownReceipts = 0;
  let pendingOutOfWindow = 0;

  const activeStepKeys = new Set();

  for (const ev of safeEvents) {
    if (!ev || typeof ev !== "object") continue;
    const hasStepIdx = parseNonNegInt(ev.stepIdx) !== null;
    const stepIdx = hasStepIdx ? Math.floor(Number(ev.stepIdx)) : null;
    const key = stepIdx !== null ? String(stepIdx) : "";
    if (key) activeStepKeys.add(key);

    // Non-pending events that aren't missing transcript lookup pass through directly,
    // UNLESS a matching step exists in transcriptTail with richer error/verify info.
    const cached = key && prevCache[key] ? prevCache[key] : null;
    const txStep = stepIdx !== null && stepsByIndex ? stepsByIndex.get(stepIdx) : null;
    const bgTask = stepIdx !== null && taskResults ? taskResults.get(stepIdx) : null;

    const hasEv = Boolean(ev.planEvidence || ev.deliveryEvidence);

    if (ev.kind === "cmd" && ev.tool !== "apply_edits:verify") {
      if (bgTask) {
        const outcome = classifyCommandOutcome(
          ev.tool,
          Boolean(ev.isBenignSearchCmd),
          "",
          bgTask.text,
          false,
          ev.checkMeta,
          ev.isVerify
        );
        const isVerify = outcome.failedIsVerify !== undefined ? outcome.failedIsVerify : Boolean(ev.isVerify);
        nextCache[key] = {
          kind: "cmd",
          failed: outcome.failed,
          errSig: outcome.errSig,
          ...(outcome.failedIsVerify !== undefined ? { isVerify } : {}),
          ...(hasEv ? { terminal: Boolean(outcome.terminal) } : {})
        };
        resolvedEvents.push({
          ...ev,
          failed: outcome.failed,
          isVerify,
          ...(hasEv ? { terminal: Boolean(outcome.terminal) } : {}),
          errSig: outcome.errSig,
          pending: false,
          backgroundRunning: false
        });
        continue;
      }

      if (txStep) {
        const txBody = stripTranscriptStepHeaders(txStep.content || "");
        const txRunning = txStep.status === "RUNNING" || BG_RUNNING_RE.test(txBody);
        if (txRunning) {
          // Background task still running: drop from effective metrics until completion SYSTEM_MESSAGE arrives
          continue;
        }
        const txErr = nonEmptyString(txStep.error);
        const txExplicitErr = txStep.status === "ERROR" || Boolean(txErr);
        const outcome = classifyCommandOutcome(
          ev.tool,
          Boolean(ev.isBenignSearchCmd),
          txErr,
          txStep.content || "",
          txExplicitErr,
          ev.checkMeta,
          ev.isVerify
        );
        const receipt = outcome.terminal ? outcome : !txExplicitErr && (ev.terminal ? ev : cached?.terminal ? cached : null);
        const terminal = Boolean(receipt);
        const failed = (hasEv && terminal) ? receipt.failed : outcome.failed;
        const isVerify = outcome.failedIsVerify !== undefined ? outcome.failedIsVerify : Boolean(ev.isVerify);
        nextCache[key] = {
          kind: "cmd",
          failed,
          errSig: outcome.errSig,
          ...(outcome.failedIsVerify !== undefined ? { isVerify } : {}),
          ...(hasEv ? { terminal } : {})
        };
        resolvedEvents.push({
          ...ev,
          failed,
          isVerify,
          ...(hasEv ? { terminal } : {}),
          errSig: outcome.errSig,
          pending: false,
          backgroundRunning: false
        });
        continue;
      }

      if (cached && cached.kind === "cmd") {
        nextCache[key] = cached;
        resolvedEvents.push({
          ...ev,
          failed: Boolean(cached.failed),
          ...(cached.isVerify !== undefined ? { isVerify: Boolean(cached.isVerify) } : {}),
          ...(hasEv ? { terminal: Boolean(cached.terminal) } : {}),
          errSig: cached.errSig || "",
          pending: false,
          backgroundRunning: false
        });
        continue;
      }

      if (ev.backgroundRunning) {
        // Still waiting for background task completion
        if (receiptsAdapterUnknown) {
          unknownReceipts += 1;
        }
        continue;
      }

      if (ev.pending && (receiptsAdapterUnknown || (tailTruncated && stepIdx !== null))) {
        if (receiptsAdapterUnknown) unknownReceipts += 1;
        else pendingOutOfWindow += 1;
        resolvedEvents.push({ ...ev, terminal: false, evidenceUnknown: true });
        continue;
      }

      resolvedEvents.push(ev);
      continue;
    }

    if (ev.kind === "edit") {
      if (txStep) {
        if (txStep.status === "RUNNING") continue;
        const txErr = nonEmptyString(txStep.error);
        const txExplicitErr = txStep.status === "ERROR" || Boolean(txErr);
        const editOut = classifyEditOutcome(
          ev.tool,
          Boolean(ev.hasArtifactMeta),
          Boolean(ev.looksLikePlanPath),
          txErr,
          txStep.content || "",
          txExplicitErr
        );
        const partial = editOut.partialReceipt?.isPartial ? editOut.partialReceipt
          : (!editOut.editFailed && !editOut.applied ? ev.partialReceipt : null);
        const resolvedWeakening = editOut.editFailed
          ? null
          : partial
            ? filterTestWeakeningByAppliedFiles(
                ev.testWeakening,
                ev.testWeakeningDetails,
                partial,
                ev.editCwd || ""
              )
            : ev.testWeakening || null;
        const applied = !partial && !editOut.editFailed && (editOut.applied || Boolean(ev.applied));
        nextCache[key] = {
          kind: "edit",
          ...(hasEv ? { applied } : {}),
          failed: editOut.editFailed,
          ...(partial ? { partialReceipt: partial } : {}),
          planModeWriteBlocked: editOut.planModeWriteBlocked,
          verifyResult: editOut.verifyResult
        };
        resolvedEvents.push({
          ...ev,
          failed: editOut.editFailed,
          ...applyEditReceipt({ planEvidence: ev.planEvidence, deliveryEvidence: ev.deliveryEvidence },
            partial, applied, ev.editCwd, ev),
          testWeakening: resolvedWeakening,
          abortedNoWrite: editOut.editFailed,
          planModeWriteBlocked: ev.planModeWriteBlocked || editOut.planModeWriteBlocked,
          pending: false
        });
        if (ev.hasVerify && !ev.verifyEmitted && editOut.verifyResult) {
          resolvedEvents.push({
            ts: ev.ts,
            stepIdx,
            kind: "cmd",
            tool: "apply_edits:verify",
            ...(ev.planEvidence ? { planEvidence: ev.planEvidence } : {}),
            ...(ev.deliveryEvidence ? { deliveryEvidence: ev.deliveryEvidence } : {}),
            ...(hasEv ? { terminal: true } : {}),
            failed: editOut.verifyResult.failed,
            isVerify: true,
            cmd: ev.verifyCmd || "verify",
            errSig: editOut.verifyResult.errSig
          });
        }
        continue;
      }

      if (cached && cached.kind === "edit") {
        nextCache[key] = cached;
        const resolvedWeakening = cached.failed
          ? null
          : cached.partialReceipt?.isPartial
            ? filterTestWeakeningByAppliedFiles(
                ev.testWeakening,
                ev.testWeakeningDetails,
                cached.partialReceipt,
                ev.editCwd || ""
              )
            : ev.testWeakening || null;
        resolvedEvents.push({
          ...ev,
          failed: Boolean(cached.failed),
          abortedNoWrite: Boolean(cached.failed),
          ...applyEditReceipt({ planEvidence: ev.planEvidence, deliveryEvidence: ev.deliveryEvidence },
            cached.partialReceipt, cached.applied, ev.editCwd, ev),
          testWeakening: resolvedWeakening,
          planModeWriteBlocked: Boolean(ev.planModeWriteBlocked || cached.planModeWriteBlocked),
          pending: false
        });
        if (ev.hasVerify && !ev.verifyEmitted && cached.verifyResult) {
          resolvedEvents.push({
            ts: ev.ts,
            stepIdx,
            kind: "cmd",
            tool: "apply_edits:verify",
            ...(ev.planEvidence ? { planEvidence: ev.planEvidence } : {}),
            ...(ev.deliveryEvidence ? { deliveryEvidence: ev.deliveryEvidence } : {}),
            ...(hasEv ? { terminal: true } : {}),
            failed: Boolean(cached.verifyResult.failed),
            isVerify: true,
            cmd: ev.verifyCmd || "verify",
            errSig: cached.verifyResult.errSig || ""
          });
        }
        continue;
      }

      if (ev.pending && (receiptsAdapterUnknown || (tailTruncated && stepIdx !== null))) {
        if (receiptsAdapterUnknown) unknownReceipts += 1;
        else pendingOutOfWindow += 1;
        resolvedEvents.push({ ...ev, applied: false, evidenceUnknown: true });
        continue;
      }

      resolvedEvents.push(ev);
      continue;
    }

    resolvedEvents.push(ev);
  }

  // Keep only resolvedSteps entries that belong to active events (bounded <=120)
  const prunedCache = {};
  for (const k of activeStepKeys) {
    if (nextCache[k]) prunedCache[k] = nextCache[k];
  }

  const cacheChanged = JSON.stringify(prevCache) !== JSON.stringify(prunedCache);
  return {
    resolvedEvents,
    nextResolvedSteps: prunedCache,
    cacheChanged,
    unknownReceipts,
    pendingOutOfWindow
  };
}

function normalizeCmdKey(cmd) {
  return typeof cmd === "string" ? cmd.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function analyzeEventMetrics(events, turnFloorTs = 0) {
  let consecutiveCmdFailures = 0;
  let editFailOscillations = 0;
  let latestPassTs = 0;
  let latestFailureTs = 0;
  let latestEventTs = 0;
  let latestPlanModeBlock = null;
  let lastFailureCmd = "";
  let hasTurnEdit = false;
  let lastFailureIsVerify = false;
  const pendingEditedFiles = new Set();
  const oscillatingFiles = new Map();
  const failedCmds = new Set();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;
    const evTs = Number(ev.ts) || i + 1;
    if (evTs > latestEventTs) latestEventTs = evTs;

    if (ev.planModeWriteBlocked) {
      latestPlanModeBlock = {
        idx: i,
        ts: evTs,
        stepIdx: ev.stepIdx ?? null,
        key: `${evTs}:${ev.stepIdx ?? i}`
      };
      continue;
    }

    if (ev.kind === "edit") {
      const isArtifactOrPlanEdit = Boolean(ev.hasArtifactMeta || ev.looksLikePlanPath);
      if (!ev.failed && !ev.abortedNoWrite && !isArtifactOrPlanEdit) {
        if (evTs >= turnFloorTs) {
          hasTurnEdit = true;
        }
        const files = Array.isArray(ev.files) && ev.files.length > 0 ? ev.files : ["(edited file)"];
        for (const f of files) pendingEditedFiles.add(f);
      }
      continue;
    }

    if (ev.kind === "cmd") {
      // Pure read-only inspection commands (git status/diff/log/rev-parse, ls, rg, grep, which)
      // are environmental probes, never build/test verifications: neither passing nor failing them
      // should trigger Stop auto-retry, bump failure/oscillation streaks, or reset real test failures.
      if (ev.isReadOnlyCmd) {
        continue;
      }
      const cmdKey = normalizeCmdKey(ev.cmd);
      if (ev.failed) {
        consecutiveCmdFailures += 1;
        if (evTs >= latestFailureTs) {
          latestFailureTs = evTs;
          lastFailureIsVerify = Boolean(ev.isVerify);
        }
        if (ev.cmd) lastFailureCmd = ev.cmd;
        if (cmdKey) failedCmds.add(cmdKey);
        if (pendingEditedFiles.size > 0) {
          editFailOscillations += 1;
          for (const f of pendingEditedFiles) {
            oscillatingFiles.set(f, (oscillatingFiles.get(f) || 0) + 1);
          }
          pendingEditedFiles.clear();
        }
      } else {
        consecutiveCmdFailures = 0;
        lastFailureIsVerify = false;
        const matchesPriorFailedCmd = Boolean(cmdKey && failedCmds.has(cmdKey));
        if (ev.isVerify || matchesPriorFailedCmd) {
          if (evTs > latestPassTs) latestPassTs = evTs;
          editFailOscillations = 0;
          pendingEditedFiles.clear();
          oscillatingFiles.clear();
          failedCmds.clear();
        }
      }
    }
  }

  const topOscillatingFiles = [...oscillatingFiles.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file)
    .filter((f) => f !== "(edited file)")
    .slice(0, 2);

  return {
    consecutiveCmdFailures,
    editFailOscillations,
    latestPassTs,
    latestFailureTs,
    latestEventTs,
    latestPlanModeBlock,
    lastFailureCmd,
    hasTurnEdit,
    lastFailureIsVerify,
    topOscillatingFiles
  };
}

function collectActiveTestWeakening(events, turnFloorTs = 0, deliveryGateEnabled = false, turnFloorStep = -1) {
  let sawActiveFailure = false;
  const files = new Set();
  let addedSkip = 0;
  let droppedAssert = 0;
  let matchCount = 0;
  let latestTs = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== "object" || ev.pending || ev.backgroundRunning) continue;
    const evTs = Number(ev.ts) || i + 1;
    const evStep = parseNonNegInt(ev.stepIdx);
    const inCurrentTurn =
      turnFloorStep >= 0 && evStep !== null
        ? evStep > turnFloorStep && evTs >= turnFloorTs
        : evTs >= turnFloorTs;

    if (ev.kind === "cmd") {
      if (ev.isReadOnlyCmd || ev.isBenignSearchCmd) continue;
      if (ev.failed && ev.isVerify) {
        sawActiveFailure = true;
      } else if (!ev.failed && !inCurrentTurn && ev.isVerify) {
        // A clean passing verification before the current turn started clears stale prior failure context.
        sawActiveFailure = false;
      }
      continue;
    }

    if (ev.kind === "edit" && !ev.failed && ev.testWeakening && inCurrentTurn) {
      if (!deliveryGateEnabled && !sawActiveFailure) continue;
      const w = ev.testWeakening;
      const sk = Number(w.addedSkip) || 0;
      const dr = Number(w.droppedAssert) || 0;
      if (sk <= 0 && dr <= 0) continue;
      addedSkip += sk;
      droppedAssert += dr;
      matchCount += 1;
      if (evTs > latestTs) latestTs = evTs;
      for (const f of Array.isArray(w.files) ? w.files : []) {
        if (f && files.size < 5) files.add(f);
      }
    }
  }

  if (matchCount === 0) return null;
  const fileList = [...files];
  return {
    files: fileList,
    addedSkip,
    droppedAssert,
    sig: `${matchCount}:${latestTs}:${addedSkip}:${droppedAssert}:${fileList.join(",")}`
  };
}

function formatTestWeakeningDetailZh(audit) {
  const parts = [];
  if (audit.addedSkip > 0) parts.push(`新增 ${audit.addedSkip} 处跳过标记`);
  if (audit.droppedAssert > 0) parts.push(`净删减 ${audit.droppedAssert} 处断言`);
  return parts.join("、");
}

export {
  analyzeEventMetrics,
  collectActiveTestWeakening,
  formatTestWeakeningDetailZh
};
