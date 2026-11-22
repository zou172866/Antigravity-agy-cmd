import fs from "node:fs";
import { nonEmptyString } from "./common.mjs";

const HEAD_READ_BYTES = 64 * 1024;
const TAIL_READ_BYTES = 256 * 1024;

const SUBAGENT_MSG_RE = /\[Message\]\s+timestamp=[^\n]*\bsender=/;
const BG_TASK_SENDER_RE = /\[Message\]\s+timestamp=[^\n]*\bsender=[^\s\]]*\/task-(\d+)\b/;
const PLAN_MODE_DENY_RE =
  /(?:plan\s*mode\s+is\s+on|only\s+read[- ]?only\s+tools|read[- ]?only\s+mode|cannot\s+write\s+in\s+plan|writes?\s+(?:are|is)\s+(?:disabled|blocked|not\s+allowed|forbidden)|tool\s+not\s+allowed\s+in\s+plan|plan\s*mode\s+is\s+read[- ]?only|计划模式|只读模式)/i;
const PLAN_MODE_OFF_RE = /^Plan mode is off\.?$/i;
const PLAN_WRITE_TOOL_RE = /\b(?:write_file|write_to_file)\b/i;
const PLAN_ARTIFACT_PATH_RE = /(?:implementation[_ -]?plan|plan\.md|[\\/]brain[\\/])/i;

function parseJsonLines(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        out.push(obj);
      }
    } catch {
      // Ignore partial or malformed lines safely
    }
  }
  return out;
}

export function resolveTranscriptPath(payload = {}) {
  if (!payload || typeof payload !== "object") return "";
  const candidate = nonEmptyString(payload.transcriptPath ?? payload.transcript_path);
  if (!candidate) return "";
  try {
    const st = fs.statSync(candidate);
    return st.isFile() ? candidate : "";
  } catch {
    return "";
  }
}

function readTranscriptHeadRaw(transcriptPath, maxBytes = HEAD_READ_BYTES) {
  if (!transcriptPath) return { steps: [], truncatedTail: "" };
  let fd = null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return { steps: [], truncatedTail: "" };
    const readLen = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(transcriptPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    let raw = buf.subarray(0, bytesRead).toString("utf8");
    let truncatedTail = "";
    if (st.size > readLen) {
      const lastNl = raw.lastIndexOf("\n");
      if (lastNl >= 0) {
        truncatedTail = raw.slice(lastNl + 1, lastNl + 1 + 1024);
        raw = raw.slice(0, lastNl);
      } else {
        truncatedTail = raw.slice(0, 1024);
        raw = "";
      }
    }
    return { steps: parseJsonLines(raw), truncatedTail };
  } catch {
    return { steps: [], truncatedTail: "" };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function readTranscriptHead(transcriptPath, maxBytes = HEAD_READ_BYTES) {
  return readTranscriptHeadRaw(transcriptPath, maxBytes).steps;
}

export function readTranscriptTail(transcriptPath, maxBytes = TAIL_READ_BYTES) {
  if (!transcriptPath) return [];
  let fd = null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return [];
    const offset = Math.max(0, st.size - maxBytes);
    const readLen = st.size - offset;
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(transcriptPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
    let raw = buf.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
      else return [];
    }
    return parseJsonLines(raw);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Antigravity's real hook payloads omit explicit parentConversationId/isSubagent fields,
 * so main vs subagent sessions are distinguished reliably from the transcript head:
 * - Main sessions contain a `USER_INPUT` step near step 0.
 * - Subagent sessions have zero `USER_INPUT` steps and begin with `SYSTEM_MESSAGE`
 *   (including `[Message] timestamp=... sender=...` dispatch from parent).
 */
export function isSubagentTranscript(transcriptPath) {
  if (!transcriptPath) return false;
  const { steps: head, truncatedTail } = readTranscriptHeadRaw(transcriptPath, HEAD_READ_BYTES);
  if (head.length === 0 && !truncatedTail) return false;

  const sample = head.slice(0, 12);
  let hasUserInput = false;
  let hasSubagentMessage = false;
  let systemHeadCount = 0;

  for (const step of sample) {
    if (step.type === "USER_INPUT") {
      hasUserInput = true;
      break;
    }
    if (step.type === "SYSTEM_MESSAGE") {
      systemHeadCount += 1;
      const content = typeof step.content === "string" ? step.content : "";
      if (SUBAGENT_MSG_RE.test(content)) {
        hasSubagentMessage = true;
      }
    }
  }

  // Handle giant (>64KB) line 0 or line 1 in `transcript_full.jsonl` whose JSON line was truncated
  if (!hasUserInput && truncatedTail && sample.length < 12) {
    if (/"type"\s*:\s*"USER_INPUT"/.test(truncatedTail)) {
      hasUserInput = true;
    } else if (/"type"\s*:\s*"SYSTEM_MESSAGE"/.test(truncatedTail)) {
      systemHeadCount += 1;
      if (SUBAGENT_MSG_RE.test(truncatedTail)) {
        hasSubagentMessage = true;
      }
    }
  }

  if (hasUserInput) return false;
  if (hasSubagentMessage) return true;
  if (systemHeadCount >= 2 && (sample[0]?.type === "SYSTEM_MESSAGE" || (sample.length === 0 && /"type"\s*:\s*"SYSTEM_MESSAGE"/.test(truncatedTail)))) {
    return true;
  }
  return false;
}

export function stripTranscriptStepHeaders(content) {
  if (typeof content !== "string" || !content) return "";
  return content
    .replace(/^(?:(?:Created At|Completed At):[^\n]*\r?\n|A pre-tool hook changed[^\n]*\r?\n|\r?\n)+/i, "")
    .trim();
}

function parseToolCallArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function hasMeaningfulArtifactMeta(val) {
  if (!val) return false;
  if (typeof val === "object") return Object.keys(val).length > 0;
  if (typeof val === "string") {
    const trimmed = val.trim();
    return Boolean(trimmed && trimmed !== "null" && trimmed !== "{}" && trimmed !== '""');
  }
  return false;
}

function isPlanWriteToolCall(call) {
  if (!call || typeof call !== "object") return false;
  const name = nonEmptyString(call.name);
  if (!PLAN_WRITE_TOOL_RE.test(name)) return false;
  const args = parseToolCallArgs(call.args);
  if (hasMeaningfulArtifactMeta(args.ArtifactMetadata ?? args.artifactMetadata)) return true;
  const rawPath = String(
    args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? ""
  ).replace(/^["']|["']$/g, "");
  return PLAN_ARTIFACT_PATH_RE.test(rawPath);
}

/**
 * Single bounded tail scan of `transcript.jsonl` returning:
 * - stepsByIndex: Map<step_index, step> for GENERIC tool result steps
 * - taskResultsByStepIdx: Map<step_index, { stepIndex, text }> for completed background tasks
 * - latestPlanModeDenial: active PreToolUse-denied Plan Mode artifact write (cleared on `Plan mode is off.` or new USER_INPUT)
 * - latestUserInput: most recent USER_INPUT step content (fallback if payload.lastUserInput is omitted)
 */
export function inspectTranscriptTail(transcriptPath) {
  const empty = {
    stepsByIndex: new Map(),
    taskResultsByStepIdx: new Map(),
    latestPlanModeDenial: null,
    latestUserInput: ""
  };
  if (!transcriptPath) return empty;

  const steps = readTranscriptTail(transcriptPath, TAIL_READ_BYTES);
  if (steps.length === 0) return empty;

  const stepsByIndex = new Map();
  const taskResultsByStepIdx = new Map();
  let latestPlanModeDenial = null;
  let latestUserInput = "";
  let lastPlannerStep = null;

  for (const step of steps) {
    const idx = Number.isFinite(Number(step.step_index)) ? Math.floor(Number(step.step_index)) : null;

    if (step.type === "USER_INPUT") {
      if (typeof step.content === "string" && step.content.trim()) {
        latestUserInput = step.content;
      }
      // A new user turn supersedes any prior turn's Plan Mode denial
      latestPlanModeDenial = null;
      lastPlannerStep = null;
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      lastPlannerStep = step;
      continue;
    }

    if (step.type === "SYSTEM_MESSAGE") {
      const content = typeof step.content === "string" ? step.content : "";
      const taskMatch = content.match(BG_TASK_SENDER_RE);
      if (taskMatch && /finished with result:/i.test(content)) {
        const taskStepIdx = Number(taskMatch[1]);
        const resultIdx = content.search(/finished with result:\s*\r?\n?/i);
        const body =
          resultIdx >= 0
            ? content.slice(resultIdx).replace(/^finished with result:\s*\r?\n?/i, "")
            : content;
        if (Number.isFinite(taskStepIdx)) {
          taskResultsByStepIdx.set(taskStepIdx, {
            stepIndex: idx,
            text: stripTranscriptStepHeaders(body)
          });
        }
      }
      continue;
    }

    if (step.type === "GENERIC") {
      if (idx !== null) {
        stepsByIndex.set(idx, step);
      }
      const rawContent = typeof step.content === "string" ? step.content : "";
      const body = stripTranscriptStepHeaders(rawContent);
      const errText = nonEmptyString(step.error);

      // If Plan Mode was explicitly exited after an earlier denial, clear the denial
      if (step.status !== "ERROR" && PLAN_MODE_OFF_RE.test(body)) {
        latestPlanModeDenial = null;
        continue;
      }

      // Catch real Antigravity PreToolUse Plan Mode write_file denials (which never invoke PostToolUse)
      if (step.status === "ERROR" || Boolean(errText)) {
        const combined = `${errText}\n${body}`;
        if (PLAN_MODE_DENY_RE.test(combined) && PLAN_WRITE_TOOL_RE.test(combined)) {
          const calls = Array.isArray(lastPlannerStep?.tool_calls)
            ? lastPlannerStep.tool_calls
            : Array.isArray(lastPlannerStep?.toolCalls)
              ? lastPlannerStep.toolCalls
              : null;
          // If preceding PLANNER_RESPONSE tool_calls are visible, confirm write_file targeted an artifact/plan
          // (avoid hijacking an accidental non-plan source edit); if unavailable, still catch write_file denial.
          const writeCalls = calls ? calls.filter((c) => PLAN_WRITE_TOOL_RE.test(nonEmptyString(c?.name))) : null;
          const matchesPlanArtifact =
            !writeCalls || writeCalls.length === 0 || writeCalls.some((c) => isPlanWriteToolCall(c));
          if (matchesPlanArtifact) {
            latestPlanModeDenial = {
              stepIdx: idx,
              key: `tx:${idx ?? "unknown"}`,
              error: errText || body.slice(0, 200)
            };
          }
        }
      }
    }
  }

  return {
    stepsByIndex,
    taskResultsByStepIdx,
    latestPlanModeDenial,
    latestUserInput
  };
}

/**
 * Lightweight single-step lookup used by PostToolUse when payload omits `toolResponse`.
 */
export function findTranscriptStep(transcriptPath, stepIdx) {
  if (!transcriptPath || !Number.isFinite(Number(stepIdx))) return null;
  const target = Math.floor(Number(stepIdx));
  const steps = readTranscriptTail(transcriptPath, 32 * 1024);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "GENERIC" && Number(s.step_index) === target) {
      return s;
    }
  }
  return null;
}
