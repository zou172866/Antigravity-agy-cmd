/**
 * Layer 3 (Policy & Facade): Adjudicate PreInvocation, PreToolUse, and Stop hook
 * decisions from extracted facts (detector-facts.mjs) and reconciled ledgers
 * (detector-ledger.mjs), preserving the stable public detector API.
 */
import {
  detectHostSurface,
  extractActiveSlashCommands,
  formatRouterCliCommand,
  isBareResumeNormalSessionRequest,
  isResumeNormalSessionRequest,
  isSubagentPayload,
  nonEmptyString,
  resolveHostSlashCapability,
  sanitizeSnippet,
  unwrapUserRequestText
} from "./common.mjs";
import { createDefaultState } from "./state.mjs";
import { normalizeSettings, parseTurnRetryOverride } from "./settings.mjs";
import { isPlanApprovalNotice } from "./transcript.mjs";
import {
  advanceDeliveryGate,
  advancePlan,
  allowsTestWeakening,
  autoCheckCanonicalKey,
  compareDeliveryOrder,
  deliveryEditOrders,
  deliveryEventOrder,
  evaluateDeliveryGateStatus,
  pathKey,
  pendingPlanChecks,
  planPreferences,
  requestedProjectCheck
} from "./plan-verification.mjs";
import {
  classifyToolEvents,
  confirmsPlan,
  DEBUG_ACTION_RE,
  DEBUG_DISCUSSION_RE,
  DEBUG_INITIAL_RE,
  DECLINES_DELEGATION_RE,
  DEFERRED_EDIT_INTENT_RE,
  deriveTurnSignals,
  EXPLICIT_ERROR_CONTINUATION_RE,
  extractProseForIntent,
  HARD_DEBUG_TASK_RE,
  hasDirectFixOrChangeIntent,
  hasFreshTranscriptSwarmActivity,
  hashText,
  hashUserInput,
  isHostSwarmEndedPayload,
  isTranscriptUserTurnAfterSwarmEnd,
  LEADING_AUTONOMY_SLASH_RE,
  LEADING_SWARM_SLASH_RE,
  NEGATED_EDIT_INTENT_RE,
  parseNonNegInt,
  requestsMigration,
  resolvePendingPlanApprovalState,
  SOFT_CONTINUATION_RE,
  UNATTENDED_GOAL_RE,
  unwrapCliFilterCommand
} from "./detector-facts.mjs";
import {
  analyzeEventMetrics,
  collectActiveTestWeakening,
  formatTestWeakeningDetailZh,
  reconcileEventsWithTranscript
} from "./detector-ledger.mjs";

export { classifyToolEvents, reconcileEventsWithTranscript, unwrapCliFilterCommand };

/**
 * Build a strictly protojson-compatible `CortexStepSystemMessage` payload.
 * Note: Antigravity's desktop Go protojson unmarshaler rejects unknown nested
 * `metadata` fields on `systemMessage` (`DiscardUnknown: false`), so we emit ONLY
 * `{ systemMessage: { systemMessage: "..." } }` (identical to working SessionStart hooks).
 */
function buildInjectStep({ userMarkdown, systemMessage, uiOnly = false }) {
  if (uiOnly) {
    return null;
  }
  const text = [userMarkdown, systemMessage].filter(Boolean).join("\n");
  return {
    systemMessage: {
      systemMessage: text
    }
  };
}

/**
 * Resolve effective auto-retry policy by combining persistent `settings.json`
 * with optional per-turn natural-language overrides.
 */
export function resolveEffectiveRetryPolicy(
  settingsInput = {},
  turnRetryOverride = null,
  turnUnattendedGoal = false,
  smartTriggered = false
) {
  const settings = normalizeSettings(settingsInput);
  if (turnRetryOverride && typeof turnRetryOverride === "object") {
    if (turnRetryOverride.mode === "off") {
      return { mode: "off", max: 0, active: false, overridden: true };
    }
    if (turnRetryOverride.mode === "infinite") {
      return { mode: "infinite", max: Infinity, active: true, overridden: true };
    }
    if (turnRetryOverride.mode === "count") {
      const max = Number(turnRetryOverride.max) || settings.autoRetryMax;
      return { mode: "count", max, active: true, overridden: true };
    }
  }

  if (settings.autoRetryMode === "off") {
    return { mode: "off", max: settings.autoRetryMax, active: false, overridden: false };
  }
  const scopeMatched =
    settings.autoRetryScope === "all_failures" ||
    Boolean(turnUnattendedGoal) ||
    (settings.autoRetryScope === "smart" && Boolean(smartTriggered));
  if (!scopeMatched) {
    return { mode: settings.autoRetryMode, max: settings.autoRetryMax, active: false, overridden: false };
  }
  return {
    mode: settings.autoRetryMode,
    max: settings.autoRetryMode === "infinite" ? Infinity : settings.autoRetryMax,
    active: true,
    overridden: false
  };
}

/**
 * Pure PreInvocation decision engine.
 * Returns { nextState, injectStep, shouldResetEvents, reasonCode, stateChanged, metrics }.
 */
export function evaluatePreInvocation(payload, events = [], prevStateInput = null, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const uiOnly = Boolean(options.uiOnly);
  const transcriptTail = options.transcriptTail || null;
  const effSettings = normalizeSettings(options.settings || {});
  const prevState = { ...createDefaultState(), ...(prevStateInput || {}) };

  if (!payload || typeof payload !== "object") {
    return {
      nextState: prevState,
      injectStep: null,
      shouldResetEvents: false,
      reasonCode: "empty_payload",
      stateChanged: false,
      metrics: null
    };
  }

  if (isSubagentPayload(payload, env)) {
    return {
      nextState: prevState,
      injectStep: null,
      shouldResetEvents: false,
      reasonCode: "subagent_skip",
      stateChanged: false,
      metrics: null
    };
  }

  const initialNumSteps = parseNonNegInt(payload.initialNumSteps ?? payload.initial_num_steps);
  const invocationNum = parseNonNegInt(payload.invocationNum ?? payload.invocation_num);
  const latestTranscriptInput = nonEmptyString(transcriptTail?.latestUserInput);
  const rawPayloadInput = nonEmptyString(payload.lastUserInput ?? payload.last_user_input);
  const inputEnvelope = rawPayloadInput || latestTranscriptInput;
  const rawLastUserInput = unwrapUserRequestText(inputEnvelope);
  const isMidTurn = invocationNum !== null && invocationNum >= 1;

  let nextState = { ...prevState };
  delete nextState.lastUserInput;
  const wsRoots = payload.workspacePaths ?? payload.workspace_paths;
  const prevInputHash =
    nonEmptyString(prevState.lastUserInputHash) || hashUserInput(prevState.lastUserInput);
  if (prevInputHash && !nextState.lastUserInputHash) {
    nextState.lastUserInputHash = prevInputHash;
  }
  const prevSavedSignals =
    prevState.lastTurnSignals && typeof prevState.lastTurnSignals === "object"
      ? prevState.lastTurnSignals
      : prevState.lastUserInput
        ? deriveTurnSignals(prevState.lastUserInput, wsRoots)
        : null;
  if (prevSavedSignals && !nextState.lastTurnSignals) {
    nextState.lastTurnSignals = prevSavedSignals;
  }
  const rawInputHash = hashUserInput(rawLastUserInput);
  let rawEvents = Array.isArray(events) ? events : [];
  let shouldResetEvents = false;
  let stateChanged = false;

  // 1. Detect trajectory rewind / rollback
  if (
    initialNumSteps !== null &&
    prevState.lastInitialNumSteps !== null &&
    initialNumSteps < prevState.lastInitialNumSteps
  ) {
    nextState = {
      ...createDefaultState(),
      lastInitialNumSteps: initialNumSteps
    };
    rawEvents = [];
    shouldResetEvents = true;
    stateChanged = true;
  } else if (initialNumSteps !== null && initialNumSteps !== prevState.lastInitialNumSteps) {
    nextState.lastInitialNumSteps = initialNumSteps;
    stateChanged = true;
  }

  // Reconcile events with real transcript tail + cached resolvedSteps
  const reconciled = reconcileEventsWithTranscript(rawEvents, transcriptTail, nextState.resolvedSteps);
  const effectiveEvents = reconciled.resolvedEvents;
  if (reconciled.cacheChanged) {
    nextState.resolvedSteps = reconciled.nextResolvedSteps;
    stateChanged = true;
  }

  // Compute current event metrics BEFORE updating debugTurnStreak so soft-continuation check sees unresolved failures
  const metrics = analyzeEventMetrics(effectiveEvents);

  // Reset boost alert & detection flags once a post-alert command/verify passes cleanly (invariant to log compaction)
  if (
    metrics.latestPassTs > (nextState.lastBoostPassTs || 0) &&
    metrics.latestPassTs >= Math.max(nextState.lastBoostAlertEventTs || 0, nextState.lastBoostDetectedEventTs || 0) &&
    metrics.consecutiveCmdFailures === 0 &&
    metrics.editFailOscillations === 0
  ) {
    if (nextState.boostAlerted || nextState.boostDetected || nextState.lastBoostPassTs !== metrics.latestPassTs) {
      nextState.boostAlerted = false;
      nextState.boostDetected = false;
      nextState.lastBoostPassTs = metrics.latestPassTs;
      stateChanged = true;
    }
  }

  const hasFreshInput = Boolean(rawLastUserInput);
  const midTurnSignals = isMidTurn ? nextState.lastTurnSignals : null;
  const activeSlash = hasFreshInput
    ? extractActiveSlashCommands(rawLastUserInput)
    : new Set(Array.isArray(midTurnSignals?.activeSlash) ? midTurnSignals.activeSlash : []);
  const intentProse = hasFreshInput ? extractProseForIntent(rawLastUserInput) : "";

  // 2. Detect new user turn entry (excluding background-task, subagent, swarm, and Stop wakeups
  //    that carry no new USER_INPUT — Antigravity often runs PreInvocation before flushing the
  //    wakeup SYSTEM_MESSAGE while repeating the previous turn's lastUserInput in the payload)
  const latestTxUserKey = nonEmptyString(transcriptTail?.latestUserInputKey);
  const latestPlanPromptKey = nonEmptyString(transcriptTail?.latestPlanPromptKey);
  const sameTxTurnKey =
    Boolean(latestTxUserKey) && latestTxUserKey === (nextState.lastTurnUserInputKey || "");
  const isDirectUnflushedNotice =
    Boolean(rawPayloadInput) &&
    isPlanApprovalNotice(rawPayloadInput) &&
    !transcriptTail?.tailRolledOverWithoutUserInput &&
    rawPayloadInput !== latestTranscriptInput;
  const isFreshPlanApprovalClick =
    isDirectUnflushedNotice ||
    (Boolean(rawPayloadInput) &&
      isPlanApprovalNotice(rawPayloadInput) &&
      !transcriptTail?.tailRolledOverWithoutUserInput &&
      Boolean(transcriptTail?.awaitingUserApprovalOrQuestion) &&
      latestPlanPromptKey !== "" &&
      latestPlanPromptKey !== (nextState.lastPlanBoostPromptKey || ""));
  const sameAsPrevInput = rawInputHash === (nextState.lastUserInputHash || "");
  const isWakeupWithNoNewInput =
    !rawPayloadInput ||
    (!isFreshPlanApprovalClick &&
      sameAsPrevInput &&
      (sameTxTurnKey || Boolean(transcriptTail?.tailRolledOverWithoutUserInput)));
  const isBgTaskWakeup =
    !isMidTurn &&
    invocationNum === 0 &&
    isWakeupWithNoNewInput &&
    (nextState.userTurnCount || 0) > 0 &&
    (sameTxTurnKey || Boolean(transcriptTail?.tailRolledOverWithoutUserInput));

  const isNewUserTurn =
    !isMidTurn &&
    !isBgTaskWakeup &&
    ((invocationNum === 0 &&
      (initialNumSteps !== nextState.lastTurnInitialSteps ||
        !sameAsPrevInput ||
        nextState.userTurnCount === 0)) ||
      (invocationNum === null && rawLastUserInput !== "" && !sameAsPrevInput));

  const approval = resolvePendingPlanApprovalState(inputEnvelope, transcriptTail, metrics.latestPlanModeBlock,
    isNewUserTurn ? nowMs : nextState.lastTurnStartTs, effSettings.planFallbackEnabled);
  const { approvedNotice } = approval;
  const txPlanRequest = approval.isApproved ? unwrapUserRequestText(nonEmptyString(transcriptTail?.planRequest)) : "";
  const inheritedPlanSignals = approval.isApproved
    ? txPlanRequest
      ? deriveTurnSignals(txPlanRequest, wsRoots)
      : prevSavedSignals
    : null;

  if (isNewUserTurn) {
    let maxEventStep = -1;
    for (const ev of effectiveEvents) {
      const st = parseNonNegInt(ev?.stepIdx);
      if (st !== null && st > maxEventStep) maxEventStep = st;
    }
    nextState.userTurnCount = (nextState.userTurnCount || 0) + 1;
    nextState.lastUserInputHash = rawInputHash;
    nextState.lastTurnSignals = deriveTurnSignals(rawLastUserInput, wsRoots);
    nextState.lastTurnUserInputKey = latestTxUserKey;
    if (!isPlanApprovalNotice(inputEnvelope)) {
      nextState.lastPlanBoostNoticeHash = "";
    }
    nextState.lastTurnInitialSteps = initialNumSteps;
    nextState.lastTurnStartTs = nowMs;
    nextState.turnAuditFloorTs = nowMs;
    nextState.turnAuditFloorStep = maxEventStep;
    nextState.turnAllowTestWeakening = Boolean(
      allowsTestWeakening(rawLastUserInput) || inheritedPlanSignals?.allowTestWeakening
    );
    nextState.turnAutoRetries = 0;
    nextState.turnBaseExecutionNum = null;
    nextState.lastContinueEventSig = "";
    nextState.testAuditNoticedSig = "";
    nextState.turnRetryOverride = parseTurnRetryOverride(intentProse);
    nextState.turnUnattendedGoal = Boolean(
      UNATTENDED_GOAL_RE.test(intentProse) ||
        (nextState.turnRetryOverride && nextState.turnRetryOverride.mode !== "off")
    );
    stateChanged = true;

    if (activeSlash.has("compact")) {
      nextState.freePlan = null;
      nextState.deliveryGate = null;
      nextState.swarmActive = false;
      nextState.swarmLastActivityKey = "";
      nextState.swarmLastActivityStep = null;
      nextState.swarmClearedAfterKey = "";
      nextState.swarmClearedAtStep = null;
      nextState.debugTurnStreak = 0;
      nextState.boostDetected = false;
      nextState.lastBoostDetectedTurn = 0;
      nextState.lastBoostDetectedEventTs = 0;
      nextState.boostAlerted = false;
      nextState.lastBoostPassTs = 0;
      nextState.lastPaidBoostTurn = null;
      nextState.lastBoostAlertEventTs = 0;
      nextState.turnUnattendedGoal = false;
      nextState.turnRetryOverride = null;
      nextState.turnAutoRetries = 0;
      nextState.turnBaseExecutionNum = null;
      nextState.lastContinueEventSig = "";
      nextState.testAuditNoticedSig = "";
      nextState.turnAllowTestWeakening = false;
      nextState.turnAuditFloorTs = 0;
      nextState.turnAuditFloorStep = -1;
      nextState.lastPlanBoostKey = "";
      nextState.lastPlanBoostNoticeHash = "";
      nextState.lastPlanBoostPromptKey = "";
      nextState.lastTurnUserInputKey = "";
      nextState.lastUserInputHash = "";
      nextState.lastTurnSignals = null;
      nextState.resolvedSteps = {};
      shouldResetEvents = true;
      return {
        nextState,
        injectStep: null,
        shouldResetEvents,
        reasonCode: "compact_reset",
        stateChanged: true,
        metrics
      };
    }

    const hadPriorUnresolvedFailure =
      metrics.consecutiveCmdFailures >= 1 || metrics.editFailOscillations >= 1;
    const prevStreak = nextState.debugTurnStreak || 0;

    if (EXPLICIT_ERROR_CONTINUATION_RE.test(intentProse)) {
      nextState.debugTurnStreak =
        nextState.userTurnCount >= 2 ? Math.max(2, prevStreak + 1) : 1;
    } else if (SOFT_CONTINUATION_RE.test(intentProse)) {
      if (prevStreak >= 1 || hadPriorUnresolvedFailure) {
        nextState.debugTurnStreak = Math.max(2, prevStreak + 1);
      } else {
        nextState.debugTurnStreak = 0;
      }
    } else if (DEBUG_INITIAL_RE.test(intentProse)) {
      nextState.debugTurnStreak =
        prevStreak >= 1 || hadPriorUnresolvedFailure ? prevStreak + 1 : 1;
    } else {
      nextState.debugTurnStreak = 0;
      // Clean pivot to a non-debug task with zero active failures re-arms /boost for future episodes
      if (!hadPriorUnresolvedFailure && (nextState.boostAlerted || nextState.boostDetected)) {
        nextState.boostAlerted = false;
        nextState.boostDetected = false;
      }
    }
  }

  // A fresh user task ends the preceding plan. A replay of the same approval
  // or a background wakeup retains its one-shot budgets.
  if (nextState.freePlan && (effSettings.planTier !== "free" || (isNewUserTurn &&
      !approvedNotice && (!sameTxTurnKey || !confirmsPlan(rawLastUserInput))))) {
    nextState.freePlan = null;
    stateChanged = true;
  }
  if (nextState.freePlan) {
    const advanced = advancePlan(nextState.freePlan, effectiveEvents);
    if (advanced !== nextState.freePlan) {
      nextState.freePlan = advanced;
      stateChanged = true;
    }
  }

  // Delivery Test Gate per-turn ledger (all tiers, opt-in via deliveryTestGateEnabled)
  if (effSettings.deliveryTestGateEnabled) {
    if (isNewUserTurn || !nextState.deliveryGate) {
      const gateKey = `turn:${nextState.userTurnCount || 0}`;
      const strippedUserProse = rawLastUserInput.replace(/```[\s\S]*?```/g, " ");
      const gatePrefs = planPreferences(strippedUserProse);
      const gateAllowTestWeakening = Boolean(
        allowsTestWeakening(rawLastUserInput) || inheritedPlanSignals?.allowTestWeakening
      );
      const inheritedRequested = approval.isApproved
        ? txPlanRequest
          ? requestedProjectCheck(txPlanRequest + "\n" + (transcriptTail?.planCheckText || ""), wsRoots)
          : requestedProjectCheck(transcriptTail?.planCheckText || "", wsRoots) ||
            inheritedPlanSignals?.requestedCheck ||
            null
        : null;
      const gateRequested = requestedProjectCheck(rawLastUserInput, wsRoots) || inheritedRequested;
      nextState.deliveryGate = {
        key: gateKey,
        skipCheck: Boolean(gatePrefs.skipCheck || inheritedPlanSignals?.skipCheck),
        ...(gateAllowTestWeakening ? { allowTestWeakening: true } : {}),
        requested: gateRequested,
        wroteSource: false,
        noCmdNoticed: false,
        lastProgressStep: -1,
        consecutiveNoTestNudges: 0,
        scopes: {},
        customReceipts: {}
      };
      stateChanged = true;
    }
    if (nextState.deliveryGate) {
      const advancedGate = advanceDeliveryGate(
        nextState.deliveryGate,
        effectiveEvents,
        effSettings.deliveryTestCommand
      );
      if (advancedGate !== nextState.deliveryGate) {
        nextState.deliveryGate = advancedGate;
        stateChanged = true;
      }
    }
  } else if (nextState.deliveryGate !== null) {
    nextState.deliveryGate = null;
    stateChanged = true;
  }

  // 3. Priority 1: Read-only Plan Mode blocked artifact write_file
  // Sources: (a) real Antigravity PreToolUse denial in transcript.jsonl, (b) PostToolUse event fallback.
  const activePlanBlock = approval.requiresConfirmation ? approval.activePlanBlock : null;

  if (activePlanBlock && activePlanBlock.key !== (nextState.lastPlanBlockAlertKey || "")) {
    nextState.lastPlanBlockAlertKey = activePlanBlock.key;
    stateChanged = true;
    return {
      nextState,
      injectStep: buildInjectStep({
        uiOnly,
        userMarkdown:
          "> **[agy-cmd → /plan 审批]** 检测到当前只读 Plan Mode 拦截了方案产物写入，已切换为正文直接输出方案并等待确认（禁止自动调用 `exit_plan_mode` 绕过审批）。",
        systemMessage:
          '[agy-cmd] Plan Mode denied write_file for the plan artifact. Override the tool denial\'s exit_plan_mode suggestion: Do NOT call exit_plan_mode yet (calling it bypasses user approval and switches straight to execution). Start your response with "[agy-cmd → /plan 审批]", output a concise structured plan directly in the response body, and stop to wait for explicit user confirmation.'
      }),
      shouldResetEvents,
      reasonCode: "plan_mode_fallback",
      stateChanged,
      metrics
    };
  }

  // Active Swarm Coordinator sessions manage their own shared board, @verifier and @monitor.
  // Never interrupt them with Boost/fallback/goal/delivery-gate injections, while still supporting
  // clean lifecycle exit on verifiable teardown events or explicit "恢复普通会话" requests.
  const wantsLeadingSwarm = hasFreshInput
    ? LEADING_SWARM_SLASH_RE.test(rawLastUserInput)
    : Boolean(midTurnSignals?.leadingSwarm);
  const hostSwarmEnded = isHostSwarmEndedPayload(payload);
  const explicitResumeNormal =
    isNewUserTurn && !isBgTaskWakeup && !wantsLeadingSwarm && isResumeNormalSessionRequest(rawLastUserInput);
  const txSwarmEnded = transcriptTail?.swarmLifecycle === "ended";
  const freshTxSwarm = hasFreshTranscriptSwarmActivity(transcriptTail, nextState);
  const txSwarmKey = nonEmptyString(transcriptTail?.latestSwarmActivityKey);
  const txSwarmStep = Number.isSafeInteger(transcriptTail?.latestSwarmActivityStep)
    ? transcriptTail.latestSwarmActivityStep
    : null;

  if (wantsLeadingSwarm || (freshTxSwarm && !hostSwarmEnded && !explicitResumeNormal)) {
    const activityKey = txSwarmKey || nextState.swarmLastActivityKey || "";
    const activityStep = txSwarmStep ?? initialNumSteps ?? nextState.swarmLastActivityStep ?? null;
    if (
      !nextState.swarmActive ||
      nextState.swarmLastActivityKey !== activityKey ||
      nextState.swarmLastActivityStep !== activityStep
    ) {
      nextState.swarmActive = true;
      nextState.swarmLastActivityKey = activityKey;
      nextState.swarmLastActivityStep = activityStep;
      stateChanged = true;
    }
  } else if (
    explicitResumeNormal ||
    hostSwarmEnded ||
    (nextState.swarmActive && isNewUserTurn && !isBgTaskWakeup && txSwarmEnded)
  ) {
    const clearKey = txSwarmKey || nextState.swarmLastActivityKey || "";
    const clearStep = txSwarmStep ?? nextState.swarmLastActivityStep ?? initialNumSteps ?? null;
    const wasSwarmActive = Boolean(nextState.swarmActive);
    if (
      nextState.swarmActive ||
      nextState.swarmClearedAfterKey !== clearKey ||
      nextState.swarmClearedAtStep !== clearStep
    ) {
      nextState.swarmActive = false;
      nextState.swarmClearedAfterKey = clearKey;
      nextState.swarmClearedAtStep = clearStep;
      if (wasSwarmActive) {
        if ((nextState.debugTurnStreak || 0) > 1 && (prevState.debugTurnStreak || 0) === 0) {
          nextState.debugTurnStreak = 1;
        }
        nextState.boostAlerted = false;
        nextState.boostDetected = false;
      }
      stateChanged = true;
    }
    if (explicitResumeNormal && isBareResumeNormalSessionRequest(rawLastUserInput)) {
      return {
        nextState,
        injectStep: null,
        shouldResetEvents,
        reasonCode: "swarm_resumed_normal",
        stateChanged,
        metrics
      };
    }
  }

  if (nextState.swarmActive) {
    return {
      nextState,
      injectStep: null,
      shouldResetEvents,
      reasonCode: "swarm_active_skip",
      stateChanged,
      metrics
    };
  }

  const paidBoostActive = effSettings.planTier === "paid" && effSettings.boostEnabled === true;
  const noticeHash = isPlanApprovalNotice(inputEnvelope) ? hashText(inputEnvelope) : "";
  const planBoostKey = isDirectUnflushedNotice
    ? `notice:${noticeHash}:${initialNumSteps ?? nextState.userTurnCount}`
    : latestTxUserKey || `turn:${nextState.userTurnCount}`;
  const alreadyTriggeredPlanBoost =
    planBoostKey === (nextState.lastPlanBoostKey || "") ||
    (effSettings.planTier === "free" && latestPlanPromptKey !== "" &&
      latestPlanPromptKey === nextState.lastPlanBoostPromptKey) ||
    (isDirectUnflushedNotice &&
      noticeHash !== "" &&
      noticeHash === (nextState.lastPlanBoostNoticeHash || "") &&
      latestPlanPromptKey === (nextState.lastPlanBoostPromptKey || ""));
  const blockedByTailState =
    Boolean(transcriptTail?.tailRolledOverWithoutUserInput) ||
    (!isDirectUnflushedNotice && Boolean(transcriptTail?.hasPlannerResponseSinceUserInput));
  const inheritedDeclinesDelegation = txPlanRequest
    ? DECLINES_DELEGATION_RE.test(extractProseForIntent(txPlanRequest))
    : Boolean(prevSavedSignals?.declinesDelegation);
  if (
    ((paidBoostActive && effSettings.boostAfterPlanApproval &&
      !DECLINES_DELEGATION_RE.test(intentProse) &&
      !inheritedDeclinesDelegation) ||
      effSettings.planTier === "free") &&
    isNewUserTurn &&
    activeSlash.size === 0 &&
    !alreadyTriggeredPlanBoost &&
    !blockedByTailState
  ) {
    if (approval.isApproved) {
      if (effSettings.planTier === "free" && transcriptTail?.awaitingUserApprovalOrQuestion && !approvedNotice) {
        return { nextState, injectStep: null, shouldResetEvents, reasonCode: "awaiting_approval", stateChanged, metrics };
      }
      nextState.lastPlanBoostKey = planBoostKey;
      nextState.lastPlanBoostNoticeHash = noticeHash;
      nextState.lastPlanBoostPromptKey = latestPlanPromptKey;
      stateChanged = true;
      if (effSettings.planTier === "free") {
        const prefs = txPlanRequest
          ? planPreferences(txPlanRequest)
          : {
              skipCheck: Boolean(inheritedPlanSignals?.skipCheck),
              skipReview: Boolean(inheritedPlanSignals?.skipReview)
            };
        const planAllowTestWeakening = Boolean(
          inheritedPlanSignals?.allowTestWeakening || allowsTestWeakening(rawLastUserInput)
        );
        const requested = txPlanRequest
          ? requestedProjectCheck(txPlanRequest + "\n" + (transcriptTail?.planCheckText || ""), wsRoots)
          : requestedProjectCheck(transcriptTail?.planCheckText || "", wsRoots) ||
            inheritedPlanSignals?.requestedCheck ||
            null;
        nextState.freePlan = {
          key: planBoostKey,
          ...prefs,
          ...(planAllowTestWeakening ? { allowTestWeakening: true } : {}),
          requested,
          wroteSource: false,
          reminded: false,
          reviewRequested: false,
          scopes: {}
        };
        return { nextState, injectStep: null, shouldResetEvents, reasonCode: "approved_free_plan", stateChanged, metrics };
      }
      nextState.lastPaidBoostTurn = nextState.userTurnCount;
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown:
            "> **[agy-cmd → 计划获批，自动 Boost]** 检测到实施计划已获批准，正在尝试直接调度 `DeepCoder` / `DeepInvestigator` 隐藏子智能体执行并验证。",
          systemMessage:
            '[agy-cmd → 计划获批，自动 Boost] For this approval turn, execute the approved implementation plan now. Start line 1 of your reply with "[agy-cmd → 计划获批，自动 Boost]". If still in read-only Plan Mode, use the host\'s approved transition to execution first. IMPORTANT: DeepCoder and DeepInvestigator are hidden from the <subagents> ("Available subagents") list—do NOT skip them just because they are omitted from that list. Call invoke_subagent directly with TypeName=\'DeepCoder\' (or TypeName=\'DeepInvestigator\' for a read-only investigation plan) and Workspace=\'inherit\', passing the approved plan or its path, scope, user constraints and verification criteria. Follow the worker to completion and independently verify the result. ONLY if invoke_subagent actually returns an error (e.g. role unavailable without /boost), fall back to carrying out the approved plan with the available tools/subagents and note the fallback reason. Do not ask the user to type /boost.'
        }),
        shouldResetEvents,
        reasonCode: "approved_plan_boost",
        stateChanged,
        metrics
      };
    }
  }

  const allowWeakeningThisTurn = Boolean(
    allowsTestWeakening(intentProse) ||
      nextState.freePlan?.allowTestWeakening ||
      nextState.deliveryGate?.allowTestWeakening ||
      nextState.turnAllowTestWeakening
  );
  const auditTurnFloorTs = nextState.turnAuditFloorTs || nextState.lastTurnStartTs || 0;
  const auditTurnFloorStep = Number.isInteger(nextState.turnAuditFloorStep) ? nextState.turnAuditFloorStep : -1;
  const activeTestWeakening = !allowWeakeningThisTurn
    ? collectActiveTestWeakening(
        effectiveEvents,
        auditTurnFloorTs,
        effSettings.deliveryTestGateEnabled,
        auditTurnFloorStep
      )
    : null;

  const plan = nextState.freePlan;
  if (plan?.wroteSource && effSettings.freePlanReviewEnabled && !uiOnly && !plan.reviewRequested &&
      !plan.skipReview && !activeSlash.size && !activePlanBlock && !transcriptTail?.awaitingUserApprovalOrQuestion) {
    nextState.freePlan = { ...plan, reviewRequested: true };
    let auditExtra = "";
    if (activeTestWeakening) {
      nextState.testAuditNoticedSig = activeTestWeakening.sig;
      auditExtra =
        ` Also flag these audited test edits for strict assertion-integrity review: ${activeTestWeakening.files.join(", ")} (${formatTestWeakeningDetailZh(activeTestWeakening)}).`;
    }
    return {
      nextState, shouldResetEvents, stateChanged: true, metrics, reasonCode: "approved_free_plan_review",
      injectStep: buildInjectStep({ systemMessage:
        "[agy-cmd] This approved implementation has one optional independent review. Finish all planned edits yourself and run relevant project checks first (honor any user skip). Before final delivery, call invoke_subagent once with TypeName='research' and Workspace='inherit' (built-in 1x read-only sandbox; do NOT invoke custom/plugin agents). Instruct the reviewer to perform a strictly read-only review without making edits or expanding scope, and to read the explicitly listed rule files. Context isolation is mandatory: Do NOT pass main-session reasoning, self-justifications, summaries, or chat history. Send ONLY: (1) the acceptance criteria, (2) this task's repo-relative paths and diff excerpts (to separate from unrelated tree edits), (3) explicit paths of applicable root/nested AGENTS.md or GEMINI.md rule files, and (4) actual check commands with raw terminal results (or the concrete reason they could not run)." +
        auditExtra +
        " Instruct the reviewer to audit three mandatory dimensions: (1) correctness & concrete edge-case counterexamples against every acceptance criterion and scope boundary, (2) API/dependency authenticity against real workspace manifests and test assertion integrity (no deleted, skipped, or weakened existing test assertions just to pass), and (3) traceable terminal evidence (treat any claim without raw command output as 证据不足; note missing live /browser checks for UI changes when relevant). Require the reply to start with: Verdict: 通过 | 需修复 | 证据不足, Blocking: (each item citing repo-relative path:line 1-based line number, or None), and Missing Evidence: (smallest additional check, or None). Address blockers and verify the final changes yourself. If unavailable, over quota or unsuccessful, report that the independent review was not completed and finish on the main thread. Do not retry the role or start a second reviewer. Respect later user requests to stop or skip review." })
    };
  }

  // Route a single hard problem at entry, or escalate once the debugging signals accumulate.
  const hasFreshFailureSinceAlert =
    !nextState.boostAlerted || metrics.latestFailureTs > (nextState.lastBoostAlertEventTs || 0);
  const isCleanNonDebugTurnEntry = isNewUserTurn && (nextState.debugTurnStreak || 0) === 0;
  // Paid users on Orchestrator get a native planner hand-back after 2 verification failures;
  // require 3 edit-fail oscillations before escalating to heavy Boost, while keeping free fallback at 2.
  const oscThreshold = paidBoostActive ? 3 : 2;
  const oscHit =
    !isCleanNonDebugTurnEntry && metrics.editFailOscillations >= oscThreshold && hasFreshFailureSinceAlert;
  const failStreakHit =
    !isCleanNonDebugTurnEntry && metrics.consecutiveCmdFailures >= 3 && hasFreshFailureSinceAlert;
  const pendingTurnDebugDetect =
    !nextState.boostAlerted &&
    nextState.boostDetected &&
    nextState.lastBoostDetectedTurn === nextState.userTurnCount &&
    (nextState.debugTurnStreak || 0) >= 2;
  const multiTurnDebugHit =
    (isNewUserTurn && (nextState.debugTurnStreak || 0) >= 2) || pendingTurnDebugDetect;
  const matchesHardTask = hasFreshInput
    ? DEBUG_ACTION_RE.test(intentProse) && HARD_DEBUG_TASK_RE.test(intentProse)
    : Boolean(midTurnSignals?.matchesHardTask);
  const pendingTurnHardDetect =
    !nextState.boostAlerted &&
    nextState.boostDetected &&
    nextState.lastBoostDetectedTurn === nextState.userTurnCount &&
    matchesHardTask;
  const hardTaskHit = (isNewUserTurn && matchesHardTask) || pendingTurnHardDetect;
  const stuck = oscHit || failStreakHit || multiTurnDebugHit;

  const declinesDelegation = hasFreshInput
    ? DECLINES_DELEGATION_RE.test(intentProse)
    : Boolean(midTurnSignals?.declinesDelegation);
  const isDebugDiscussion = hasFreshInput
    ? DEBUG_DISCUSSION_RE.test(intentProse)
    : Boolean(midTurnSignals?.debugDiscussion);

  // Shared dispatch-eligibility gate for BOTH paid Boost and free stuck fallback
  const dispatchEligible =
    activeSlash.size === 0 &&
    !declinesDelegation &&
    !isBgTaskWakeup &&
    !activePlanBlock &&
    !transcriptTail?.awaitingUserApprovalOrQuestion &&
    !isDebugDiscussion &&
    !(isNewUserTurn && (nextState.turnUnattendedGoal || requestsMigration(intentProse)));

  const branchTriggered = paidBoostActive
    ? (hardTaskHit || stuck) && nextState.lastPaidBoostTurn !== nextState.userTurnCount
    : stuck && effSettings.freeFallbackEnabled;

  if (dispatchEligible && branchTriggered) {
    const cooldownElapsed =
      !nextState.boostAlerted ||
      (!paidBoostActive && nextState.userTurnCount - (nextState.lastBoostAlertTurn || 0) >= 3);

    if (cooldownElapsed) {
      const detectedEventTs = metrics.latestFailureTs || metrics.latestEventTs || nowMs;
      if (
        !nextState.boostDetected ||
        nextState.lastBoostDetectedTurn !== nextState.userTurnCount ||
        nextState.lastBoostDetectedEventTs !== detectedEventTs
      ) {
        nextState.boostDetected = true;
        nextState.lastBoostDetectedTurn = nextState.userTurnCount;
        nextState.lastBoostDetectedEventTs = detectedEventTs;
        stateChanged = true;
      }

      // Separate detection state from dispatched-alert state so uiOnly -> visible
      // never swallows the first visible escalation prompt.
      if (uiOnly) {
        return {
          nextState,
          injectStep: null,
          shouldResetEvents,
          reasonCode: paidBoostActive ? "auto_boost_ui_only" : "free_stuck_fallback_ui_only",
          stateChanged,
          metrics
        };
      }

      nextState.boostAlerted = true;
      nextState.lastBoostAlertTurn = nextState.userTurnCount;
      nextState.lastBoostAlertEventTs = detectedEventTs;
      stateChanged = true;

      const reasonsZh = [];
      const reasonsEn = [];
      if (paidBoostActive && hardTaskHit) {
        reasonsZh.push("明确的疑难排查或修复任务");
        reasonsEn.push("explicit request to tackle a hard debugging or optimization task");
      }
      if (oscHit) {
        const filesHint =
          metrics.topOscillatingFiles.length > 0
            ? `（${metrics.topOscillatingFiles.join("、")}）`
            : "";
        reasonsZh.push(`${metrics.editFailOscillations} 次「修改→仍失败」震荡${filesHint}`);
        reasonsEn.push(`${metrics.editFailOscillations}x edit-fail oscillation`);
      }
      if (failStreakHit) {
        reasonsZh.push(`连续 ${metrics.consecutiveCmdFailures} 次命令失败`);
        reasonsEn.push(`${metrics.consecutiveCmdFailures} consecutive command failures`);
      }
      if (multiTurnDebugHit) {
        reasonsZh.push(`同一问题跨 ${nextState.debugTurnStreak} 轮未解决`);
        reasonsEn.push(`unresolved debug issue across ${nextState.debugTurnStreak} turns`);
      }

      if (paidBoostActive) {
        nextState.lastPaidBoostTurn = nextState.userTurnCount;
        const allowFix = hasFreshInput
          ? hasDirectFixOrChangeIntent(intentProse) && !/只读|\bread[- ]only\b/i.test(intentProse)
          : Boolean(midTurnSignals?.allowFix);
        const role = allowFix ? "DeepCoder" : "DeepInvestigator";
        return {
          nextState,
          injectStep: buildInjectStep({
            uiOnly,
            userMarkdown: `> **[agy-cmd → 自动 Boost]** 检测到${reasonsZh.join("、")}。`,
            systemMessage: `[agy-cmd] Start line 1 with "[agy-cmd → 自动 Boost]". Call invoke_subagent once with TypeName='${role}' and Workspace='inherit' for this single problem (${reasonsEn.join(", ")}). If edits need plan approval or the session is read-only, use DeepInvestigator for read-only investigation and obtain approval before implementation. Honor the user's scope and constraints. Give the worker relevant files, observed failures or symptoms, and a verification criterion. Hidden roles may be omitted from the available list. If the call fails, continue in the main session and report the fallback. Follow the worker to completion and independently verify its result.`
          }),
          shouldResetEvents,
          reasonCode: "auto_boost",
          stateChanged,
          metrics
        };
      }

      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown: `> **[agy-cmd → 自动换视角排查]** 检测到${reasonsZh.join("、")}。先独立排查根因，再修改代码。`,
          systemMessage: `[agy-cmd] Objective stuck threshold reached (${reasonsEn.join("; ")}). Start line 1 with "[agy-cmd → 自动换视角排查]". Call invoke_subagent once with the built-in read-only "research" subagent (Workspace='inherit', 1x standard quota; do NOT invoke custom/plugin agents). Pass the failing check's raw terminal output and relevant files, and ask for a falsifiable root cause with supporting code evidence (repo-relative path and 1-based line number). If "research" is unavailable, investigate in the main session. The main agent applies and verifies any fix. Do not recommend heavy commands for this fallback.`
        }),
        shouldResetEvents,
        reasonCode: "free_stuck_fallback",
        stateChanged,
        metrics
      };
    }
  }

  // 5. Priority 3: Unattended fix-until-green intent (or explicit per-turn retry override)
  if (
    isNewUserTurn &&
    activeSlash.size === 0 &&
    nextState.lastGoalAlertTurn !== nextState.userTurnCount &&
    nextState.turnUnattendedGoal
  ) {
    nextState.lastGoalAlertTurn = nextState.userTurnCount;
    stateChanged = true;
    const retryPolicy = resolveEffectiveRetryPolicy(
      effSettings,
      nextState.turnRetryOverride,
      nextState.turnUnattendedGoal
    );

    if (retryPolicy.active) {
      const surface = detectHostSurface(payload);
      const adjustHintZh =
        surface === "ide" || surface === "cli"
          ? `可通过 \`${formatRouterCliCommand("--auto-retry 5")}\` 随时调节`
          : "可在右侧 `agy-cmd` 面板随时调节";
      const policyZh =
        retryPolicy.mode === "infinite"
          ? "一直自动重试直至全绿"
          : `最多自动续跑 ${retryPolicy.max} 次`;
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown: `> **[agy-cmd → 自动续跑已启用]** 已挂载防停机监工（本轮策略：${policyZh}；${adjustHintZh}）。`,
          systemMessage: `[agy-cmd] Auto-retry Stop guard is armed for this turn (${retryPolicy.mode === "infinite" ? "infinite retries until green" : `up to ${retryPolicy.max} automatic continuations`}). Start line 1 of your reply with "[agy-cmd → 自动续跑已启用]", and always run actual verification/test commands before finishing so the Stop hook can verify pass/fail.`
        }),
        shouldResetEvents,
        reasonCode: "auto_retry_armed",
        stateChanged,
        metrics
      };
    }

    const summary = sanitizeSnippet(intentProse, 36) || "持续修复直至全部测试与构建通过";
    return {
      nextState,
      injectStep: buildInjectStep({
        uiOnly,
        userMarkdown: `> **[agy-cmd → 建议 /goal]** 检测到无人值守持续修复诉求（当前自动重试为关闭状态）。可复制：\`/goal ${summary}；范围：<目录>；验证：<测试命令> 全绿；停止：连败 3 次或无可安全推进项\``,
        systemMessage:
          '[agy-cmd] User asked for an unattended fix-until-green loop while auto-retry is set to off. Put "[agy-cmd → 建议 /goal]" and a copyable "/goal <target>; scope: <dirs>; verify: <test command> green; stop: <hard stop condition>" on line 1 of your reply (fill placeholders from the conversation when known), then proceed with fixing.'
      }),
      shouldResetEvents,
      reasonCode: "suggest_goal",
      stateChanged,
      metrics
    };
  }

  // 6. Priority 4: Repo-wide multi-day migration/rewrite (turn entry only; tier-, surface-, and capability-aware)
  if (
    isNewUserTurn &&
    activeSlash.size === 0 &&
    nextState.lastTeamworkAlertTurn !== nextState.userTurnCount &&
    requestsMigration(intentProse)
  ) {
    nextState.lastTeamworkAlertTurn = nextState.userTurnCount;
    stateChanged = true;
    const surface = detectHostSurface(payload);
    const teamworkCap = resolveHostSlashCapability(payload, "teamwork");
    if (effSettings.planTier === "paid" && surface === "app" && teamworkCap !== "unavailable") {
      const summary = sanitizeSnippet(intentProse, 36) || "仓库级迁移与重构";
      const capabilityGuard =
        teamworkCap === "unknown"
          ? ' First verify that "/teamwork" is listed in this host\'s available slash commands; ONLY if exposed by the current host, put "[agy-cmd → 建议 /teamwork]" and a copyable "/teamwork <concise target>" on line 1. If the host does not expose "/teamwork", do NOT emit a heavy command badge—silently fall back to creating a phased Implementation Plan (RequestFeedback: true) broken into independently verifiable milestones.'
          : ' Put "[agy-cmd → 建议 /teamwork]" and a copyable "/teamwork <concise target>" on line 1.';
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown:
            teamworkCap === "available"
              ? `> **[agy-cmd → 建议 /teamwork]** 检测到仓库级长周期迁移/重写诉求。可复制：\`/teamwork ${summary}\``
              : `> 检测到仓库级长周期迁移/重写诉求（若当前 Antigravity App 宿主开放 \`/teamwork\`，可建议：\`/teamwork ${summary}\`；未开放则改用分里程碑实施计划，不亮重型徽标）。`,
          systemMessage:
            `[agy-cmd] User requested a repo-wide multi-phase migration/rewrite.${capabilityGuard} Outline independently verifiable milestones. Start with the scoping interview to establish the target, constraints and acceptance checks before workers start.`
        }),
        shouldResetEvents,
        reasonCode: "suggest_teamwork",
        stateChanged,
        metrics
      };
    }

    if (effSettings.planTier === "paid" && surface !== "app") {
      const surfaceLabel = surface === "ide" ? "IDE" : surface === "cli" ? "CLI" : "未确认表面";
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown: `> **[agy-cmd → 分阶段迁移规划]** 检测到仓库级迁移/重写诉求（当前为 ${surfaceLabel}，非 Antigravity App 表面，按默认分里程碑方案推进，不推荐 \`/teamwork\`）。`,
          systemMessage:
            '[agy-cmd] Repo-wide migration detected on a non-App or unconfirmed host surface (do NOT suggest /teamwork or emit a heavy command badge). Start line 1 with "[agy-cmd → 分阶段迁移规划]" and create a phased Implementation Plan (RequestFeedback: true) broken into independently verifiable milestones.'
        }),
        shouldResetEvents,
        reasonCode: "migration_surface_fallback",
        stateChanged,
        metrics
      };
    }

    if (effSettings.planTier === "paid" && teamworkCap === "unavailable") {
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown:
            "> **[agy-cmd → 分阶段迁移规划]** 检测到仓库级迁移/重写诉求（当前宿主未开放 `/teamwork`，按默认分里程碑方案推进，不亮重型徽标）。",
          systemMessage:
            '[agy-cmd] Repo-wide migration detected while /teamwork is unavailable in this host (do NOT suggest /teamwork or emit a heavy command badge). Start line 1 with "[agy-cmd → 分阶段迁移规划]" and create a phased Implementation Plan (RequestFeedback: true) broken into independently verifiable milestones.'
        }),
        shouldResetEvents,
        reasonCode: "migration_capability_fallback",
        stateChanged,
        metrics
      };
    }

    return {
      nextState,
      injectStep: buildInjectStep({
        uiOnly,
        userMarkdown:
          "> **[agy-cmd → 分阶段迁移规划]** 检测到仓库级迁移/重写诉求（免费安全模式已屏蔽 `/teamwork` 防报错，自动切换分里程碑方案审批）。",
        systemMessage:
          '[agy-cmd] Repo-wide migration detected in Free-Tier Safe Mode (do NOT suggest /teamwork). Start line 1 with "[agy-cmd → 分阶段迁移规划]" and create a phased Implementation Plan (RequestFeedback: true) broken into verifiable milestones.'
      }),
      shouldResetEvents,
      reasonCode: "free_migration_fallback",
      stateChanged,
      metrics
    };
  }

  // 7. Priority 5: Delivery Test Gate invalid custom command or conservative missing-test disclosure (once per turn)
  const activeGate = effSettings.deliveryTestGateEnabled ? nextState.deliveryGate : null;
  if (
    activeGate &&
    activeGate.wroteSource &&
    !activeGate.skipCheck &&
    !activeGate.noCmdNoticed &&
    !uiOnly &&
    activeSlash.size === 0 &&
    !activePlanBlock &&
    !transcriptTail?.awaitingUserApprovalOrQuestion
  ) {
    const gateStatus = evaluateDeliveryGateStatus(activeGate, effSettings.deliveryTestCommand);
    if (gateStatus.invalidCustomCommand) {
      nextState.deliveryGate = { ...activeGate, noCmdNoticed: true };
      stateChanged = true;
      const errMsg = gateStatus.invalidCustomCommand.error || "语法或分段数不符合要求";
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          systemMessage:
            `[agy-cmd 交付测试门禁 · 自定义命令无效（需修正）] 检测到已保存的自定义验证命令无效（${errMsg}），本次不会静默截断，也不会静默回退到自动探测。` +
            `请在最终交付回复末尾明确提醒用户在面板或 CLI 修正 \`deliveryTestCommand\` 后重新验证，严禁宣称已通过交付测试门禁。`
        }),
        shouldResetEvents,
        reasonCode: "delivery_gate_invalid_custom_command",
        stateChanged,
        metrics
      };
    }
    if (
      gateStatus.untestedScopes.length > 0 &&
      gateStatus.pendingChecks.length === 0 &&
      gateStatus.failedChecks.length === 0
    ) {
      nextState.deliveryGate = { ...activeGate, noCmdNoticed: true };
      stateChanged = true;
      const dirs = gateStatus.untestedScopes.map((s) => JSON.stringify(s.dir)).join("、");
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          systemMessage:
            `[agy-cmd 交付测试门禁 · 保守放行提示] 本轮在以下目录修改了源码，但未检测到现成的自动测试命令，且面板未配置自定义验证命令：${dirs}。` +
            `请保持保守放行，不要私自修改仓库或强行新增测试框架；但在最终交付回复末尾必须明确说明「未检测到现成测试命令 / 缺测项及原因」（如已执行其他手动检查请一并如实列出），严禁宣称测试已通过。`
        }),
        shouldResetEvents,
        reasonCode: "delivery_gate_no_test_disclosure",
        stateChanged,
        metrics
      };
    }
  }

  // 8. Priority 6: Frozen Rules soft audit for suspected test assertion weakening (soft notice only, never hard-blocks)
  if (
    activeTestWeakening &&
    activeTestWeakening.sig !== nextState.testAuditNoticedSig &&
    !uiOnly &&
    activeSlash.size === 0 &&
    !activePlanBlock &&
    !transcriptTail?.awaitingUserApprovalOrQuestion
  ) {
    nextState.testAuditNoticedSig = activeTestWeakening.sig;
    stateChanged = true;
    const filesLabel = activeTestWeakening.files.join("、");
    const detail = formatTestWeakeningDetailZh(activeTestWeakening);
    const hasPendingFreePlanReview = Boolean(
      plan?.reviewRequested && effSettings.freePlanReviewEnabled && !plan.skipReview
    );
    const verifierSupplement = hasPendingFreePlanReview
      ? ` For this approved plan's single TypeName='research' (Workspace='inherit') independent review dispatch, also include these newly flagged test edits for strict assertion-integrity review (do NOT start a second reviewer): ${activeTestWeakening.files.join(", ")} (${detail}). Keep context isolation mandatory — pass ONLY: (1) the acceptance criteria, (2) this task's repo-relative paths and diff excerpts, (3) applicable root/nested AGENTS.md or GEMINI.md paths, and (4) actual check commands with raw terminal results (do NOT pass main-session reasoning, self-justifications, summaries, or chat history).`
      : "";
    return {
      nextState,
      injectStep: buildInjectStep({
        uiOnly,
        systemMessage:
          `[agy-cmd 测试断言审计] 检测到在近期测试失败或交付门禁开启期间，对测试文件（${filesLabel}）存在疑似弱化校验的改动（${detail}）。` +
          `请自查是否为强行跑绿而删改/跳过断言；若属于合法测试重构，请在最终交付回复中向用户明确列出删改/跳过的用例与原因（本次仅做软审计提醒，不阻断正常交付）。` +
          verifierSupplement
      }),
      shouldResetEvents,
      reasonCode: "test_assertion_weakening_audit",
      stateChanged,
      metrics
    };
  }

  return {
    nextState,
    injectStep: null,
    shouldResetEvents,
    reasonCode: "steady_state",
    stateChanged,
    metrics
  };
}

const STOP_ALLOW_REASONS = new Set([
  "USER_CANCELED",
  "ERROR",
  "MAX_STEPS_EXCEEDED",
  "MAX_INVOCATIONS",
  "MAX_FORCED_INVOCATIONS",
  "MAX_TOKEN_BUDGET_EXCEEDED",
  "TERMINAL_STEP_TYPE",
  "TERMINAL_CUSTOM_HOOK",
  "INJECTED_RESPONSE"
]);

const NORMAL_STOP_REASONS = new Set(["NO_TOOL_CALL", "MODEL_STOP"]);

/**
 * Pure PreToolUse decision engine for deterministic guardrails.
 * Currently targets `exit_plan_mode` when read-only Plan Mode blocked artifact
 * writes and the user has not yet approved the inline plan.
 */
export function evaluatePreToolUse(payload, events = [], prevStateInput = null, options = {}) {
  const env = options.env ?? process.env;
  const transcriptTail = options.transcriptTail || null;
  const effSettings = normalizeSettings(options.settings || {});
  const prevState = { ...createDefaultState(), ...(prevStateInput || {}) };

  if (!payload || typeof payload !== "object" || isSubagentPayload(payload, env)) {
    return { decision: "allow", reason: "", reasonCode: "subagent_or_empty" };
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : {};
  const toolName = nonEmptyString(toolCall.name);
  if (toolName !== "exit_plan_mode") {
    return { decision: "allow", reason: "", reasonCode: "non_target_tool" };
  }

  if (!effSettings.planFallbackEnabled) {
    return { decision: "allow", reason: "", reasonCode: "plan_fallback_disabled" };
  }

  const inputEnvelope = nonEmptyString(payload.lastUserInput ?? payload.last_user_input) || nonEmptyString(transcriptTail?.latestUserInput);
  const { resolvedEvents } = reconcileEventsWithTranscript(events, transcriptTail, prevState.resolvedSteps);
  const approval = resolvePendingPlanApprovalState(inputEnvelope, transcriptTail, analyzeEventMetrics(resolvedEvents).latestPlanModeBlock,
    prevState.lastTurnStartTs, effSettings.planFallbackEnabled);
  if (approval.isApproved) {
    return { decision: "allow", reason: "", reasonCode: "plan_already_approved" };
  }

  if (!approval.requiresConfirmation) {
    return { decision: "allow", reason: "", reasonCode: "no_plan_denial" };
  }

  return {
    decision: "force_ask",
    reason:
      "[agy-cmd → /plan 审批] 检测到当前只读 Plan Mode 拒绝了方案产物写入且尚未收到用户明确批准。请确认已审阅正文方案后再允许调用 exit_plan_mode。",
    reasonCode: "plan_mode_exit_guard"
  };
}

/**
 * Pure Stop hook decision engine.
 * Returns { decision: "allow" | "continue", reason, reasonCode, nextState, stateChanged, metrics }.
 */
export function evaluateStop(payload, events = [], prevStateInput = null, options = {}) {
  const env = options.env ?? process.env;
  const transcriptTail = options.transcriptTail || null;
  const effSettings = normalizeSettings(options.settings || {});
  const prevState = { ...createDefaultState(), ...(prevStateInput || {}) };

  if (!payload || typeof payload !== "object" || isSubagentPayload(payload, env)) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: "subagent_or_empty",
      nextState: prevState,
      stateChanged: false,
      metrics: null
    };
  }

  // Safety Brake 1: Always honor user cancellation, errors, and host invocation/token ceilings
  const rawTerm = nonEmptyString(payload.terminationReason ?? payload.termination_reason) || "NO_TOOL_CALL";
  const termReason = rawTerm.toUpperCase();
  const stopNowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const finalizeStop = (res, verificationStatus, exitReason = res.reasonCode) => {
    const out = {
      ...res,
      verificationStatus,
      exitReason
    };
    const prevOut = out.nextState?.lastStopOutcome;
    const nextOut = {
      decision: out.decision,
      verificationStatus,
      exitReason,
      reasonCode: out.reasonCode,
      ts: stopNowMs
    };
    const outcomeChanged =
      !prevOut ||
      prevOut.decision !== nextOut.decision ||
      prevOut.verificationStatus !== nextOut.verificationStatus ||
      prevOut.exitReason !== nextOut.exitReason ||
      prevOut.reasonCode !== nextOut.reasonCode;
    if (out.nextState && outcomeChanged) {
      out.nextState = { ...out.nextState, lastStopOutcome: nextOut };
      out.stateChanged = true;
    }
    return out;
  };

  if (!NORMAL_STOP_REASONS.has(termReason) || STOP_ALLOW_REASONS.has(termReason)) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: `term_${termReason.toLowerCase()}`,
        nextState: prevState,
        stateChanged: false,
        metrics: null
      },
      termReason === "USER_CANCELED" ? "user_exempt" : "not_run"
    );
  }

  // Safety Brake 2: Wait for running background tasks instead of forcing premature loops
  if (payload.fullyIdle === false || payload.fully_idle === false) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "not_fully_idle",
        nextState: prevState,
        stateChanged: false,
        metrics: null
      },
      "insufficient_evidence"
    );
  }

  let nextState = { ...prevState };
  delete nextState.lastUserInput;
  let stateChanged = false;

  const reconciled = reconcileEventsWithTranscript(events, transcriptTail, nextState.resolvedSteps);
  const effectiveEvents = reconciled.resolvedEvents;
  const hasUnknownEvidence = Boolean(
    reconciled.unknownReceipts > 0 ||
      reconciled.pendingOutOfWindow > 0 ||
      transcriptTail?.adapter?.states?.toolReceipts === "unknown"
  );
  if (reconciled.cacheChanged) {
    nextState.resolvedSteps = reconciled.nextResolvedSteps;
    stateChanged = true;
  }

  const rawLastUserInput = unwrapUserRequestText(
    nonEmptyString(payload.lastUserInput ?? payload.last_user_input) ||
      nonEmptyString(transcriptTail?.latestUserInput)
  );
  const hasFreshInput = Boolean(rawLastUserInput);
  const savedSignals =
    nextState.lastTurnSignals && typeof nextState.lastTurnSignals === "object"
      ? nextState.lastTurnSignals
      : prevState.lastUserInput
        ? deriveTurnSignals(prevState.lastUserInput, payload.workspacePaths ?? payload.workspace_paths)
        : null;

  // Safety Brake 3: Do not double-continue when user explicitly invoked native `/goal`,
  // `/swarm`, `/teamwork`, `/boost`, `/run-workflow`, or when this conversation is an active Swarm coordinator.
  const activeSlash = hasFreshInput
    ? extractActiveSlashCommands(rawLastUserInput)
    : new Set(Array.isArray(savedSignals?.activeSlash) ? savedSignals.activeSlash : []);
  if (activeSlash.has("goal")) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "native_goal_active",
        nextState,
        stateChanged,
        metrics: null
      },
      "user_exempt"
    );
  }
  const wantsLeadingSwarm = hasFreshInput
    ? LEADING_SWARM_SLASH_RE.test(rawLastUserInput)
    : Boolean(savedSignals?.leadingSwarm);
  const wantsLeadingAutonomy = hasFreshInput
    ? LEADING_AUTONOMY_SLASH_RE.test(rawLastUserInput)
    : Boolean(savedSignals?.leadingAutonomy);
  const hostSwarmEnded = isHostSwarmEndedPayload(payload);
  const explicitResumeNormal = hasFreshInput && !wantsLeadingSwarm && isResumeNormalSessionRequest(rawLastUserInput);
  const postTeardownUserTurn = isTranscriptUserTurnAfterSwarmEnd(transcriptTail);
  const freshTxSwarm = hasFreshTranscriptSwarmActivity(transcriptTail, nextState);
  const txSwarmKey = nonEmptyString(transcriptTail?.latestSwarmActivityKey);
  const txSwarmStep = Number.isSafeInteger(transcriptTail?.latestSwarmActivityStep)
    ? transcriptTail.latestSwarmActivityStep
    : null;

  let hasActiveSwarm = false;
  if (wantsLeadingSwarm || (freshTxSwarm && !hostSwarmEnded && !explicitResumeNormal)) {
    hasActiveSwarm = true;
    const activityKey = txSwarmKey || nextState.swarmLastActivityKey || "";
    const activityStep = txSwarmStep ?? nextState.swarmLastActivityStep ?? null;
    if (
      !nextState.swarmActive ||
      nextState.swarmLastActivityKey !== activityKey ||
      nextState.swarmLastActivityStep !== activityStep
    ) {
      nextState.swarmActive = true;
      nextState.swarmLastActivityKey = activityKey;
      nextState.swarmLastActivityStep = activityStep;
      stateChanged = true;
    }
  } else if (hostSwarmEnded || explicitResumeNormal || (nextState.swarmActive && postTeardownUserTurn)) {
    const clearKey = txSwarmKey || nextState.swarmLastActivityKey || "";
    const clearStep = txSwarmStep ?? nextState.swarmLastActivityStep ?? null;
    if (
      nextState.swarmActive ||
      nextState.swarmClearedAfterKey !== clearKey ||
      nextState.swarmClearedAtStep !== clearStep
    ) {
      nextState.swarmActive = false;
      nextState.swarmClearedAfterKey = clearKey;
      nextState.swarmClearedAtStep = clearStep;
      stateChanged = true;
    }
  } else if (nextState.swarmActive) {
    hasActiveSwarm = true;
  }

  if (hasActiveSwarm || wantsLeadingAutonomy) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "native_autonomy_active",
        nextState,
        stateChanged,
        metrics: null
      },
      "user_exempt"
    );
  }

  const intentProse = hasFreshInput ? extractProseForIntent(rawLastUserInput) : "";
  const turnOverride = nextState.turnRetryOverride ?? parseTurnRetryOverride(intentProse);
  const turnGoal = Boolean(
    nextState.turnUnattendedGoal ||
      UNATTENDED_GOAL_RE.test(intentProse) ||
      (turnOverride && turnOverride.mode !== "off")
  );
  const turnFloorTs = nextState.lastTurnStartTs > 0 ? nextState.lastTurnStartTs - 1000 : 0;
  const metrics = analyzeEventMetrics(effectiveEvents, turnFloorTs);
  // Automatic pause recognition: never interrupt /plan approval or /grill-me ask_question waits
  if (transcriptTail?.awaitingUserApprovalOrQuestion) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "awaiting_user_input",
        nextState,
        stateChanged,
        metrics
      },
      "not_run"
    );
  }

  // Smart automatic classification (zero explicit user declaration needed):
  // - If AI edited workspace code in this turn (`hasTurnEdit`), finish until green.
  // - If AI has NOT edited any code (`!hasTurnEdit`), natural inquiries ("为什么挂了？", "分析报错原因",
  //   "排查哪里有问题", "跑一下测试", env probes) automatically stop cleanly; only explicit fix/repair
  //   requests ("帮我修一下报错", "分析原因并修好") push past a lazy pre-edit test failure.
  const plan = effSettings.planTier === "free" ? advancePlan(nextState.freePlan, effectiveEvents) : null;
  if (plan !== nextState.freePlan) {
    nextState.freePlan = plan;
    stateChanged = true;
  }

  const rawDeliveryGate = effSettings.deliveryTestGateEnabled
    ? nextState.deliveryGate || {
        key: `turn:${nextState.userTurnCount || 0}`,
        skipCheck: false,
        requested: null,
        wroteSource: false,
        noCmdNoticed: false,
        lastProgressStep: -1,
        consecutiveNoTestNudges: 0,
        scopes: {},
        customReceipts: {}
      }
    : null;
  const deliveryGate = rawDeliveryGate
    ? advanceDeliveryGate(rawDeliveryGate, effectiveEvents, effSettings.deliveryTestCommand)
    : null;
  if (deliveryGate && deliveryGate !== nextState.deliveryGate) {
    nextState.deliveryGate = deliveryGate;
    stateChanged = true;
  }
  const strippedStopProse = hasFreshInput ? rawLastUserInput.replace(/```[\s\S]*?```/g, " ") : "";
  const inputSkipCheck = hasFreshInput
    ? planPreferences(strippedStopProse).skipCheck
    : Boolean(savedSignals?.skipCheck);
  const userSkipTests = Boolean(inputSkipCheck || deliveryGate?.skipCheck);
  const skipDeliveryGate =
    !deliveryGate ||
    userSkipTests ||
    turnOverride?.mode === "off" ||
    Boolean(transcriptTail?.latestPlanModeDenial);
  const gateStatus =
    deliveryGate && !skipDeliveryGate
      ? evaluateDeliveryGateStatus(deliveryGate, effSettings.deliveryTestCommand)
      : { pendingChecks: [], failedChecks: [], untestedScopes: [], invalidCustomCommand: null, allPassed: true };
  if (gateStatus.invalidCustomCommand && deliveryGate?.wroteSource) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "delivery_gate_invalid_custom_command",
        nextState,
        stateChanged,
        metrics
      },
      "insufficient_evidence"
    );
  }
  const gateFailedCheck = gateStatus.failedChecks[0] || null;
  const gatePendingChecks = gateStatus.pendingChecks;

  // A scope outside this plan, another package's green test or arbitrary
  // successful command cannot clear a known failed project check.
  const skipPlanChecks = plan && (plan.skipCheck || inputSkipCheck);
  const checks = plan && !skipPlanChecks &&
    !transcriptTail?.latestPlanModeDenial ? pendingPlanChecks(plan) : [];
  const scopedFailure = gateFailedCheck || checks.find(check => check.failed);
  const stalePlanFailure = plan && metrics.lastFailureIsVerify && effectiveEvents.some(ev =>
    ev.failed && ev.kind === "cmd" && ev.ts === metrics.latestFailureTs && ev.planEvidence?.key === plan.key &&
    Number.isSafeInteger(ev.stepIdx) && plan.scopes[ev.planEvidence.checked?.scope]?.editStep > ev.stepIdx);
  const latestFailures = effectiveEvents.filter(ev => ev.failed && ev.ts === metrics.latestFailureTs);
  const staleGateFailure = Boolean(
    deliveryGate &&
    !skipDeliveryGate &&
    gatePendingChecks.length > 0 &&
    !gateFailedCheck &&
    metrics.lastFailureIsVerify &&
    latestFailures.length > 0 &&
    latestFailures.every(ev => {
      if (ev.kind !== "cmd" || ev.deliveryEvidence?.key !== deliveryGate.key) {
        return false;
      }
      const evOrder = deliveryEventOrder(ev);
      const checkedEntries = Array.isArray(ev.deliveryEvidence?.checked) ? ev.deliveryEvidence.checked : [];
      if (checkedEntries.length === 0) return false;
      return checkedEntries.every(entry => {
        const runKey = pathKey(entry?.runDir || "");
        if (!runKey) return false;
        const entryAutoKeys =
          Array.isArray(entry.autoKeys) && entry.autoKeys.length > 0
            ? entry.autoKeys
            : entry.autoKey
              ? [entry.autoKey]
              : [];
        const scopes = Object.entries(deliveryGate.scopes || {}).filter(([key, sc]) =>
          (key === runKey || pathKey(sc.root || "") === runKey) && deliveryEditOrders(sc).length);
        return scopes.length > 0 && scopes.every(([, sc]) => {
          const obs = sc.obligations && typeof sc.obligations === "object" ? Object.values(sc.obligations) : [];
          if (obs.length > 0 && entryAutoKeys.length > 0 && !effSettings.deliveryTestCommand) {
            const matchingObs = obs.filter(ob => {
              const obKey = ob?.declared ? autoCheckCanonicalKey(ob.declared) : "";
              return obKey && entryAutoKeys.includes(obKey);
            });
            if (matchingObs.length > 0) {
              return matchingObs.every(ob =>
                deliveryEditOrders(ob).some(edit => compareDeliveryOrder(edit, evOrder) === 1)
              );
            }
            const entryFamilies = new Set(
              entryAutoKeys
                .map(k => {
                  if (k.startsWith("node:") || k.startsWith("static:tsc") || k.startsWith("static:npm")) return "node";
                  if (k.startsWith("python:")) return "python";
                  if (k.startsWith("go:") || k.startsWith("static:go ")) return "go";
                  if (k.startsWith("rust:") || k.startsWith("static:cargo ")) return "rust";
                  return "";
                })
                .filter(Boolean)
            );
            if (entryFamilies.size > 0) {
              const familyObs = obs.filter(ob => ob?.family && entryFamilies.has(ob.family));
              if (familyObs.length > 0) {
                return familyObs.every(ob =>
                  deliveryEditOrders(ob).some(edit => compareDeliveryOrder(edit, evOrder) === 1)
                );
              }
              return false;
            }
          }
          return deliveryEditOrders(sc).some(edit => compareDeliveryOrder(edit, evOrder) === 1);
        });
      });
    })
  );
  const hasUnresolvedTurnFailure = Boolean(scopedFailure) ||
    (metrics.consecutiveCmdFailures >= 1 && metrics.latestFailureTs >= turnFloorTs &&
     !stalePlanFailure && !staleGateFailure &&
     !((skipPlanChecks || (effSettings.deliveryTestGateEnabled && userSkipTests)) && metrics.lastFailureIsVerify));
  const explicitNoEditInput = hasFreshInput
    ? NEGATED_EDIT_INTENT_RE.test(intentProse) || DEFERRED_EDIT_INTENT_RE.test(intentProse)
    : Boolean(savedSignals?.explicitNoEdit);
  const directFixIntent = hasFreshInput
    ? hasDirectFixOrChangeIntent(intentProse)
    : Boolean(savedSignals?.directFixIntent);
  const explicitNoEdit = !turnGoal && !metrics.hasTurnEdit && explicitNoEditInput;
  const smartTriggered =
    !explicitNoEdit &&
    (metrics.hasTurnEdit || plan?.wroteSource || deliveryGate?.wroteSource ||
      (metrics.lastFailureIsVerify && directFixIntent));
  const baseRetryPolicy = resolveEffectiveRetryPolicy(
    effSettings,
    turnOverride,
    turnGoal,
    smartTriggered
  );
  const deliveryGateActive = Boolean(
    deliveryGate && !skipDeliveryGate && (gateFailedCheck || gatePendingChecks.length > 0)
  );
  // When the user explicitly opted into the Delivery Test Gate:
  // - If autoRetryMode is count/infinite, enforce gate even when autoRetryScope is goal_only.
  // - If autoRetryMode is off (and not explicitly overridden per-turn), still allow 1 missing-test
  //   reminder while keeping failure auto-retries disabled.
  let retryPolicy = baseRetryPolicy;
  if (!retryPolicy.active && deliveryGateActive && turnOverride?.mode !== "off") {
    if (effSettings.autoRetryMode !== "off") {
      retryPolicy = {
        mode: effSettings.autoRetryMode,
        max: effSettings.autoRetryMode === "infinite" ? Infinity : effSettings.autoRetryMax,
        active: true,
        overridden: false
      };
    } else if (!hasUnresolvedTurnFailure && gatePendingChecks.length > 0) {
      retryPolicy = {
        mode: "count",
        max: 1,
        active: true,
        overridden: false
      };
    }
  }

  const hasTurnVerifyPass = Boolean(metrics.latestPassTs >= turnFloorTs && metrics.latestPassTs > 0);
  const hasUntestedScopes = Boolean(gateStatus.untestedScopes && gateStatus.untestedScopes.length > 0);
  const inferAllowVerificationStatus = () => {
    if (userSkipTests || turnOverride?.mode === "off" || explicitNoEdit) return "user_exempt";
    if (hasUnresolvedTurnFailure) return "failed";
    if (hasUnknownEvidence || hasUntestedScopes) return "insufficient_evidence";
    if (gatePendingChecks.length > 0 || checks.length > 0) return "not_run";
    if (hasTurnVerifyPass) return "passed";
    if (metrics.hasTurnEdit || plan?.wroteSource || deliveryGate?.wroteSource) return "not_run";
    return "not_run";
  };

  if (!retryPolicy.active) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "retry_inactive",
        nextState,
        stateChanged,
        metrics
      },
      inferAllowVerificationStatus()
    );
  }

  const gateNudges = Number(deliveryGate?.consecutiveNoTestNudges || 0);
  const gateMissingCheck =
    deliveryGateActive &&
    !hasUnresolvedTurnFailure &&
    gatePendingChecks.length > 0 &&
    gateNudges < 2 &&
    (payload.fullyIdle ?? payload.fully_idle) !== false;
  const missingCheck = !effSettings.deliveryTestGateEnabled &&
    !hasUnresolvedTurnFailure && !plan?.reminded && checks.length > 0 &&
    (payload.fullyIdle ?? payload.fully_idle) === true &&
    NORMAL_STOP_REASONS.has(termReason);
  if (!hasUnresolvedTurnFailure && !missingCheck && !gateMissingCheck) {
    if ((!plan && !deliveryGate && nextState.turnAutoRetries !== 0) || nextState.lastContinueEventSig !== "") {
      if (!plan && !deliveryGate) nextState.turnAutoRetries = 0;
      nextState.lastContinueEventSig = "";
      stateChanged = true;
    }
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "all_green_or_no_failure",
        nextState,
        stateChanged,
        metrics
      },
      inferAllowVerificationStatus()
    );
  }

  // Safety Brake 4: No-progress stall guard (if last continuation ran zero new substantive
  // edits or non-read-only commands, the agent is asking a clarifying question or reporting
  // an external blocker -> let it stop!)
  let progressEventCount = 0;
  let latestProgressTs = 0;
  for (let i = 0; i < effectiveEvents.length; i++) {
    const ev = effectiveEvents[i];
    if (!ev || typeof ev !== "object") continue;
    if (ev.kind === "cmd" && ev.isReadOnlyCmd) continue;
    progressEventCount += 1;
    const evTs = Number(ev.ts) || i + 1;
    if (evTs > latestProgressTs) latestProgressTs = evTs;
  }
  const progressEventSig = `${progressEventCount}:${latestProgressTs}`;
  const rawEventSig = `${effectiveEvents.length}:${metrics.latestEventTs}`;
  const currentEventSig = gateMissingCheck ? rawEventSig : progressEventSig;
  if ((nextState.turnAutoRetries || 0) > 0 && nextState.lastContinueEventSig === currentEventSig) {
    nextState.lastContinueEventSig = "";
    stateChanged = true;
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "no_progress_guard",
        nextState,
        stateChanged,
        metrics
      },
      hasUnresolvedTurnFailure ? "failed" : hasUnknownEvidence ? "insufficient_evidence" : "not_run"
    );
  }

  const execNum = parseNonNegInt(payload.executionNum ?? payload.execution_num);
  let hostRetries = 0;
  if (execNum !== null) {
    const baseExec = parseNonNegInt(nextState.turnBaseExecutionNum);
    if (baseExec !== null) {
      hostRetries = Math.max(0, execNum - baseExec);
    } else if (payload.continuationActive === true) {
      hostRetries = execNum;
    } else {
      nextState.turnBaseExecutionNum = execNum;
      stateChanged = true;
      hostRetries = 0;
    }
  }
  const completedRetries = Math.max(nextState.turnAutoRetries || 0, hostRetries);

  if (retryPolicy.mode === "count" && completedRetries >= retryPolicy.max) {
    return finalizeStop(
      {
        decision: "allow",
        reason: "",
        reasonCode: "retry_limit_reached",
        nextState,
        stateChanged,
        metrics
      },
      hasUnresolvedTurnFailure ? "failed" : hasUnknownEvidence ? "insufficient_evidence" : "not_run"
    );
  }

  const nextRetryNum = completedRetries + 1;
  nextState.turnAutoRetries = nextRetryNum;
  nextState.lastContinueEventSig = currentEventSig;
  stateChanged = true;

  const stopAllowWeakening = Boolean(
    (hasFreshInput ? allowsTestWeakening(intentProse) : Boolean(savedSignals?.allowTestWeakening)) ||
      plan?.allowTestWeakening ||
      deliveryGate?.allowTestWeakening ||
      nextState.turnAllowTestWeakening
  );
  const stopAuditFloorTs = nextState.turnAuditFloorTs || nextState.lastTurnStartTs || 0;
  const stopAuditFloorStep = Number.isInteger(nextState.turnAuditFloorStep) ? nextState.turnAuditFloorStep : -1;
  const stopTestWeakening = !stopAllowWeakening
    ? collectActiveTestWeakening(
        effectiveEvents,
        stopAuditFloorTs,
        effSettings.deliveryTestGateEnabled,
        stopAuditFloorStep
      )
    : null;
  const auditSuffix = stopTestWeakening
    ? `另检测到测试文件（${stopTestWeakening.files.join("、")}）存在疑似弱化校验改动（${formatTestWeakeningDetailZh(stopTestWeakening)}），请核对并恢复必要断言，或在交付时向用户明示删改/跳过原因。`
    : "";

  if (gateMissingCheck) {
    nextState.deliveryGate = { ...deliveryGate, consecutiveNoTestNudges: gateNudges + 1 };
    const tasks = gatePendingChecks.map(({ dir, command }) => JSON.stringify(dir) + " → " + command).join("；");
    return finalizeStop(
      {
        decision: "continue",
        reasonCode: "delivery_gate_missing_verification",
        nextState,
        stateChanged,
        metrics,
        reason:
          "[agy-cmd 交付测试门禁] 本轮已修改源码，尚缺最后一次修改之后的完整测试通过结果。请在以下目录运行对应验证命令并确认全部通过后再交付：" +
          tasks +
          "。若环境不可用或存在必须由用户确认的阻塞，请直接说明缺测项与原因并停下（无需再运行命令）。" +
          auditSuffix
      },
      hasUnknownEvidence ? "insufficient_evidence" : "not_run"
    );
  }

  if (missingCheck) {
    nextState.freePlan = { ...plan, reminded: true };
    const tasks = checks.map(({ dir, command }) => JSON.stringify(dir) + " → " + command).join("；");
    return finalizeStop(
      {
        decision: "continue",
        reasonCode: "approved_plan_missing_verification",
        nextState,
        stateChanged,
        metrics,
        reason:
          "[agy-cmd 计划补验] 本次计划已修改源码，尚缺最后一次修改之后的项目验证结果。请在以下目录运行对应检查并等待终态：" +
          tasks +
          "。若环境不可用或用户要求跳过，请在交付中说明缺测项和原因。" +
          auditSuffix
      },
      hasUnknownEvidence ? "insufficient_evidence" : "not_run"
    );
  }

  const progressTag =
    retryPolicy.mode === "infinite"
      ? `#${nextRetryNum} (无限模式)`
      : `${nextRetryNum}/${retryPolicy.max}`;
  const failedCheckLabel = scopedFailure ? `${JSON.stringify(scopedFailure.dir)} → ${scopedFailure.command}` : metrics.lastFailureCmd;
  const cmdHint = failedCheckLabel ? `（最近失败：${failedCheckLabel}）` : "";
  const reason =
    `[agy-cmd 自动续跑 ${progressTag}] 检测到验证/测试尚未全绿通过${cmdHint}。` +
    `请勿提前收工，继续定位根因、修改代码并重新运行验证命令；若遇到必须由用户确认的阻塞问题而无法自行推进，请直接说明原因并停下（无需再运行命令）。` +
    auditSuffix;

  return finalizeStop(
    {
      decision: "continue",
      reason,
      reasonCode: "auto_continue",
      nextState,
      stateChanged,
      metrics
    },
    "failed"
  );
}
