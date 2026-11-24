import crypto from "node:crypto";
import {
  extractActiveSlashCommands,
  isSubagentPayload,
  nonEmptyString,
  parseMaybeJson,
  sanitizeSnippet,
  shortFileLabel,
  unwrapUserRequestText
} from "./common.mjs";
import { createDefaultState } from "./state.mjs";
import { normalizeSettings, parseTurnRetryOverride } from "./settings.mjs";
import { isPlanApprovalNotice, stripTranscriptStepHeaders } from "./transcript.mjs";
import { advancePlan, pendingPlanChecks, planPreferences, planToolEvidence, requestedProjectCheck } from "./plan-verification.mjs";

const EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
  "apply_edits"
]);

const WRITE_ONLY_TOOLS = new Set(["write_file", "write_to_file"]);

// Match the whole reply so a question, rejection, or request to revise the plan stays with the main agent.
function confirmsPlan(reply) {
  const text = reply.replace(/[。.!！\s]+$/, "");
  if (/^(?:ok(?:ay)?|yes|approved?|proceed|go ahead|implement (?:the|this) plan)$/i.test(text)) return true;
  const approval = /^(?:确认|同意|批准|通过|可以|好的?|没问题)(?:该?(?:方案|计划))?/.exec(text);
  if (approval?.[0] === text) return true;
  const action = text.slice(approval?.[0].length ?? 0).replace(/^[，,、\s]+/, "");
  return /^(?:请)?(?:按(?:照)?(?:此|该)?(?:计划|方案)(?:执行|实施)|继续(?:执行|实施|推进)?|开始(?:执行|实施)|执行|实施)$/.test(action);
}

// Note: ctx_execute is intentionally excluded (it is a read/analysis sandbox, not a build/test runner)
const CMD_TOOL_NAMES = new Set(["run_command", "run_checks"]);

const VERIFY_CMD_RE =
  /(?:\b(?:test|vitest|jest|pytest|mocha|ava|playwright|cypress|rspec|phpunit|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|build|vet)|tsc|typecheck|lint|eslint|biome|ruff|flake8|mypy|gradle|mvn|dotnet\s+(?:test|build)|make|cmake|bazel\s+(?:test|build)|deno\s+test|swift\s+test|mix\s+test|npm\s+(?:test|t|run\s+(?:build|check|verify|lint|test|typecheck))|pnpm\s+(?:build|check|verify|lint|test|typecheck)|yarn\s+(?:build|check|verify|lint|test|typecheck)|bun\s+(?:test|build)|(?:node|tsx)\s+--test|(?:python3?|py)\s+-m\s+(?:unittest|pytest)|uv\s+run\s+(?:pytest|ruff|mypy|python\s+-m\s+(?:pytest|unittest)))\b|(?:^|[\s/\\"'`])(?:run_?tests?|test_[A-Za-z0-9_]+)\.(?:py|sh|ps1|mjs|cjs|js|ts)\b)/i;

const NON_FAILURE_EXIT1_CMD_RE =
  /^\s*(?:rg|ripgrep|grep|egrep|fgrep|findstr|select-string|git\s+diff\b[^\n]*--quiet|git\s+grep\b|diff\b|fc\b|test\b|\[)\b/i;

const READ_ONLY_INSPECT_CMD_RE =
  /^\s*(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep)\b|ls\b|dir\b|pwd\b|echo\b|rg\b|ripgrep\b|grep\b|egrep\b|fgrep\b|findstr\b|select-string\b|which\b|where(?:\.exe)?\b|Get-ChildItem\b|Get-Location\b|Test-Path\b|cat\b|head\b|tail\b|wc\b|stat\b|file\b|node\s+(?:-v|--version)\b|python3?\s+--version\b|npm\s+--version\b)/i;

const SHELL_CHAIN_RE = /(?:&&|\|\||[;|`])/;

const LEADING_CD_RE = /^\s*cd\s+(?:\/d\s+)?(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/i;

const PLAN_MODE_BLOCK_RE =
  /(?:plan\s*mode|only\s+read[- ]?only\s+tools|read[- ]?only\s+mode|cannot\s+write\s+in\s+plan|writes?\s+(?:are|is)\s+(?:disabled|blocked|not\s+allowed|forbidden)|tool\s+not\s+allowed\s+in\s+plan|计划模式|只读模式)/i;

const ARTIFACT_READONLY_RE = /(?:read[- ]?only|not\s+allowed|refused|blocked|denied|forbidden|不可写|只读)/i;

const EXPLICIT_ERROR_CONTINUATION_RE =
  /(?:还是(?:报错|出错|异常|崩溃|挂了|跑不通|测不过|通不过|有\s*bug|报同一个错)|依然(?:报错|出错|失败|异常|崩溃)|仍然(?:报错|出错|失败|异常)|又(?:报错|挂了|崩了)|同样的(?:错|报错|异常|失败)|\b(?:still\s+(?:failing|crashing|throwing|getting\s+(?:an?\s+)?error|seeing\s+(?:the\s+same\s+)?error)|same\s+(?:error|exception|bug|crash|failure)|error\s+still\s+(?:happens?|occurs?|persists?))\b)/i;

const SOFT_CONTINUATION_RE =
  /(?:还是不行|依然不行|仍然不行|没修好|还没解决|还是没解决|还是没好|\b(?:didn'?t\s+fix|still\s+broken|still\s+doesn'?t\s+work|not\s+fixed(?:\s+yet)?)\b)/i;

const DEBUG_INITIAL_RE =
  /(?:报错|出错|失败|排查|调试|修一下.*(?:错|bug|问题)|异常|崩溃|死锁|竞态|卡死|跑不通|测不过|通不过|\b(?:error|exception|traceback|stack\s*trace|failing|failed|bug|crash|deadlock|race\s+condition|broken|debug|fix\s+(?:this|the)\s+(?:bug|error|issue|crash|failure))\b)/i;

const HARD_DEBUG_TASK_RE =
  /死锁|竞态|并发竞争|内存泄漏|(?:偶发|间歇性).{0,16}(?:失败|崩溃|超时)|(?:算法|性能).{0,8}瓶颈|\b(?:deadlocks?|(?:data|thread) races?|race conditions?|memory leaks?|(?:intermittent|flaky) (?:ci|tests?|crashes|failures?|timeouts?)|(?:algorithmic|performance) bottlenecks?)\b/i;

// Match a request to do the work, including a symptom followed by an imperative.
const DEBUG_ACTION_RE =
  /(?:^|[，。,:：.!！]\s*)(?:请帮我|帮我|请|先|只|仅|please\s+)?\s*(?:修复|修好|修一下|解决|排查|定位|诊断|优化|(?:fix|resolve|debug|investigate|diagnose|optimize)\b)/i;
const DEBUG_DISCUSSION_RE =
  /^(?:请问|(?:请|帮我)?(?:解释|介绍|举例|比较|翻译|总结)|什么是|如何|怎么(?:修复|排查)|(?:please\s+)?(?:what is|what are|explain|describe|translate|summarize|how (?:do|can|to))\b)|(?:是什么意思|最佳实践是什么)/i;
const DECLINES_DELEGATION_RE =
  /(?:不用|不要|不使用|别|无需|禁止|关闭)\s*(?:自动)?(?:调用|使用|启用|开启|用|派)?\s*(?:\/?boost|多智能体|子智能体)|(?:仅|只)(?:用|在)?主(?:线程|会话)|\b(?:no|without|skip|disable|do not|don['’]t)\s+(?:(?:use|call|invoke)\s+)?(?:\/?boost|subagents?|delegation)\b/i;

const UNATTENDED_GOAL_RE =
  /(?:无人值守|一直修|修到全绿|跑到全绿|直到(?:全部|所有)?(?:测试|编译|构建|检查)?(?:全部)?通过|修通(?:全部|所有)|中途别停|别停下来|死磕到底|自动修到|全绿为止|全部修好为止|\b(?:fix\s+(?:all|every(?:thing)?|until)\s+(?:tests?\s+)?(?:pass|green)|keep\s+(?:fixing|going|trying)\s+until\s+(?:all\s+)?(?:tests?|build|ci)\s+(?:pass|green|succeed)|don'?t\s+stop\s+until\s+(?:all\s+)?(?:tests?|build)\s+(?:pass|green)|unattended\s+(?:fix|loop|run))\b)/i;

const NEGATED_EDIT_INTENT_RE =
  /(?:(?:先)?(?:别|不要|不用|不必|勿|禁止)(?:修改|改动|改代码|动代码|写代码|改(?!动|代码)|动(?!代码)|写(?!代码)|修(?!改))(?!\s*(?:别的|其他|其它|无关|其余))|只(?:看|查|分析|解释|排查|定位|跑|运行|看看)|仅(?:分析|排查|查看|解释|定位)|\b(?:do\s+not|don'?t)\s+(?:edit|modify|change|fix)(?!\s+(?:other|unrelated|any\s+other))|\bonly\s+(?:analyze|explain|check|inspect|diagnose|run)\b)/i;

const DIAGNOSTIC_OR_CHECK_INQUIRY_RE =
  /(?:为什么|为何|怎么回事|什么原因|啥原因|什么问题|哪里(?:有|出了)?(?:问题|错|bug)|哪儿(?:有|出了)?(?:问题|错|bug)|问题出在哪|错在哪|怎么会|什么意思|(?:帮我|先|只)?(?:分析|解释|诊断|评估|定位|查一下|看看)(?:一下)?|(?:跑|运行|执行|测)一下|\b(?:why\s+(?:is|does|did|are|do)|what(?:'s|\s+is)\s+(?:wrong|causing|the\s+(?:cause|error|issue|reason))|how\s+come|explain|analyze|diagnose|investigate)\b)/i;

const IMPERATIVE_FIX_INTENT_RE =
  /(?:(?:帮我|请|顺便|直接|一起|并|再|去|试着|继续)\s*(?:修(?:复|好|掉|一下|通)?|改(?:好|掉|一下|正)?|解决|修改)|(?!\s*(?:之后|以后|后|前|之前))(?:修(?:复|好|掉|一下|通)|改(?:好|掉|一下|正)|解决(?:一下|掉)|跑通)(?!\s*(?:之后|以后|后|前|之前|了没|了吗))|把[^\n，。；！？,.;!?]{1,24}(?:修(?:复|好|掉|一下|通)|改(?:好|掉|一下|正)|跑通|解决)|\b(?:please\s+|help\s+(?:me\s+)?|and\s+|then\s+)?(?:fix|resolve|repair|patch)\s+(?:it|this|the|all|failing|broken|test|tests|build|bug|error|issue))/i;

const DIRECT_TASK_MUTATE_RE =
  /(?:^(?:修|改|修复|修改|解决|重构|实现|新增|加上?|补上?)|(?:修复|修好|修一下|修掉|改一下|改好|解决掉?|重构|实现|新增|加上|补上|跑通)|\b(?:fix|resolve|repair|refactor|implement)\b)/i;

const TEAMWORK_MIGRATION_RE =
  /(?:跨天(?:重构|迁移|开发)|仓库级(?:重构|迁移|重写)|全仓库(?:重写|迁移|重构)|整个项目(?:重写|迁移)|大规模框架迁移|\b(?:repo[- ]?wide\s+(?:migration|rewrite|refactor)|multi[- ]?day\s+(?:migration|rewrite|refactor)|full\s+codebase\s+(?:migration|rewrite))\b)/i;

function requestsMigration(text) {
  const migration = TEAMWORK_MIGRATION_RE.exec(text);
  if (!migration) return false;
  const preceding = text.slice(0, migration.index);
  // Discussing a migration or explicitly declining it should leave a normal chat alone.
  const explanation = /^(?:请问|什么是|(?:请|帮我)?(?:解释|介绍|比较|对比)|(?:what (?:is|are)|explain|compare|describe)\b)|(?:什么意思|是什么意思)|(?:只|仅)(?:解释|介绍|讨论)/i;
  const declined = /(?:不要|不用|不做|别|无需|不必)(?:做|实施|进行|启动)?\s*$|\b(?:skip|avoid|without|do not|don['’]t)(?:\s+(?:start|perform|do|attempt))?(?:\s+(?:the|a))?\s*$/i;
  return !explanation.test(text) && !declined.test(preceding);
}

const REAL_CMD_ERROR_RE =
  /(?:command not found|not recognized|No such file|SyntaxError|TypeError|fatal:|error:\s|Traceback \(most recent call last\))/i;

const BG_RUNNING_RE =
  /^(?:Tool is running as a background task|Command is still running in background)/i;

function decodeCliFilterToken(encoded) {
  if (!encoded || typeof encoded !== "string") return "";
  try {
    if (encoded.startsWith("b:")) {
      return Buffer.from(encoded.slice(2), "base64url").toString("utf8").trim();
    }
    return Buffer.from(encoded, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Unwrap agy-dart PreToolUse.overwrite `cli-filter.mjs --orig-b64 ... --b64 ...` commands
 * so VERIFY_CMD_RE, benign search exit-1 detection, and read-only checks see the real command.
 */
export function unwrapCliFilterCommand(rawCmd) {
  if (typeof rawCmd !== "string" || !rawCmd.trim()) return "";
  const trimmed = rawCmd.trim();
  if (!/cli-filter\.mjs/i.test(trimmed)) return trimmed;

  const origMatch = trimmed.match(/--orig-b64\s+([^\s"']+)/);
  if (origMatch) {
    const decoded = decodeCliFilterToken(origMatch[1]);
    if (decoded) return decoded;
  }
  const b64Match = trimmed.match(/--b64\s+([^\s"']+)/);
  if (b64Match) {
    const decoded = decodeCliFilterToken(b64Match[1]);
    if (decoded) return decoded;
  }
  return trimmed;
}

function stripLeadingCdAndRedirect(cmdStr) {
  if (!cmdStr) return "";
  return cmdStr
    .replace(LEADING_CD_RE, "")
    .replace(/\s+2>&1\s*$/, "")
    .trim();
}

function isBenignSearchCommand(cmdStr) {
  const inner = stripLeadingCdAndRedirect(cmdStr);
  if (!inner || SHELL_CHAIN_RE.test(inner)) return false;
  return NON_FAILURE_EXIT1_CMD_RE.test(inner);
}

function isReadOnlyInspectCommand(cmdStr) {
  const inner = stripLeadingCdAndRedirect(cmdStr);
  if (!inner || SHELL_CHAIN_RE.test(inner)) return false;
  return READ_ONLY_INSPECT_CMD_RE.test(inner);
}

function normalizeBareTool(rawName, args = {}) {
  const name = nonEmptyString(rawName);
  if (name === "call_mcp_tool") {
    const mcpTool = nonEmptyString(args.ToolName ?? args.toolName);
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    return { bareTool: mcpTool || "call_mcp_tool", effectiveArgs: mcpArgs };
  }
  const suffixMatch = name.match(/(?:^|[_:])(apply_edits|run_checks)$/);
  if (suffixMatch) {
    const parsedDirect = typeof args === "string" ? parseMaybeJson(args) : args;
    return { bareTool: suffixMatch[1], effectiveArgs: parsedDirect && typeof parsedDirect === "object" ? parsedDirect : {} };
  }
  return { bareTool: name, effectiveArgs: args && typeof args === "object" ? args : {} };
}

function extractErrorText(payload = {}) {
  const direct = nonEmptyString(payload.error);
  if (direct) return direct;
  const candidates = [payload.toolResponse, payload.tool_response, payload.response, payload.result, payload.toolCall?.result];
  for (const c of candidates) {
    if (c && typeof c === "object" && nonEmptyString(c.error)) {
      return nonEmptyString(c.error);
    }
  }
  return "";
}

function extractResponseText(payload = {}) {
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.response,
    payload.result,
    payload.output,
    payload.toolCall?.result,
    payload.toolCall?.output
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      if (typeof c.text === "string" && c.text.trim()) return c.text;
      if (Array.isArray(c.content)) {
        const joined = c.content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n");
        if (joined.trim()) return joined;
      }
    }
  }
  return "";
}

function hasExplicitErrorFlag(payload = {}) {
  if (payload.isError === true || payload.is_error === true) return true;
  if (nonEmptyString(payload.error)) return true;
  const candidates = [payload.toolResponse, payload.tool_response, payload.response, payload.result, payload.toolCall?.result];
  for (const c of candidates) {
    if (c && typeof c === "object" && (c.isError === true || c.is_error === true)) {
      return true;
    }
  }
  return false;
}

function isBenignSearchExit1(isBenignCmd, errorText, bodyText) {
  if (!isBenignCmd) return false;
  const combined = `${errorText}\n${bodyText}`;
  if (REAL_CMD_ERROR_RE.test(combined)) {
    return false;
  }
  if (/exit(?:ed)?(?:\s+with)?\s*(?:status|code)\s*:?\s*1\b/i.test(combined)) {
    return true;
  }
  return false;
}

function extractEditFiles(bareTool, args = {}) {
  const out = [];
  const push = (raw) => {
    const label = shortFileLabel(raw);
    if (label && !out.includes(label)) out.push(label);
  };
  if (bareTool === "apply_edits") {
    const editsArr = Array.isArray(args.edits) ? args.edits : parseMaybeJson(args.edits);
    if (Array.isArray(editsArr)) {
      for (const e of editsArr) {
        if (e && e.path) push(e.path);
        if (out.length >= 4) break;
      }
    }
  } else {
    push(args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath ?? args.absolutePath);
  }
  return out;
}

function extractCommandString(bareTool, args = {}) {
  if (bareTool === "run_command") {
    const raw = String(args.CommandLine ?? args.commandLine ?? args.command ?? "").trim();
    return unwrapCliFilterCommand(raw);
  }
  if (bareTool === "run_checks") {
    const parsedCmds = Array.isArray(args.commands) ? args.commands : parseMaybeJson(args.commands);
    const cmds = Array.isArray(parsedCmds) ? parsedCmds : [];
    return cmds
      .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  }
  return "";
}

function extractErrorSignature(errorText, bodyText) {
  const src = errorText || bodyText;
  if (!src) return "";
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const prioritized =
    lines.find((l) => /(?:Error|Exception|FAIL|exit(?:ed)?(?:\s+with)?\s*(?:status|code)|AssertionError|TypeError|SyntaxError|Traceback)/i.test(l)) ||
    lines[0] ||
    "";
  return sanitizeSnippet(prioritized, 64);
}

function classifyCommandOutcome(bareTool, isBenignCmd, errorText, rawResponseText, explicitError) {
  const body = stripTranscriptStepHeaders(rawResponseText);

  if (BG_RUNNING_RE.test(body) && !explicitError) {
    return { backgroundRunning: true, failed: false, errSig: "" };
  }

  let failed = false;
  let terminal = false;
  if (bareTool === "run_checks") {
    const m = body.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
    if (m) {
      const passedCnt = Number(m[1]);
      const totalCnt = Number(m[2]);
      const failedCnt = m[3] ? Number(m[3]) : Math.max(0, totalCnt - passedCnt);
      failed = failedCnt > 0 || totalCnt === 0;
      terminal = m.index === 0 && totalCnt > 0 && (failedCnt > 0 || (passedCnt === totalCnt && !explicitError));
    } else {
      failed = explicitError || /## \[(?:FAIL|ERROR|TIMEOUT)/i.test(body);
    }
  } else {
    // Check Antigravity's leading exit-code banner FIRST so stdout content cannot spoof pass/fail
    const headExitMatch = body.match(/^Command exited with code\s+(\d+)\.?/i);
    if (headExitMatch) {
      const code = Number(headExitMatch[1]);
      terminal = !explicitError || code !== 0;
      if (code === 0) {
        failed = explicitError && !isBenignSearchExit1(isBenignCmd, errorText, body);
      } else if (code === 1) {
        failed = !isBenignSearchExit1(isBenignCmd, errorText, body);
      } else {
        failed = true;
      }
    } else if (explicitError) {
      failed = !isBenignSearchExit1(isBenignCmd, errorText, body);
    } else if (/Command exited with code 0\b/i.test(body)) {
      failed = false;
    } else if (/(?:Command exited with code|exit(?:ed)?(?:\s+with)?\s*(?:status|code))\s*:?\s*[1-9]\d*/i.test(body)) {
      failed = !isBenignSearchExit1(isBenignCmd, errorText, body);
    } else if (/(?:## \[(?:FAIL|ERROR|TIMEOUT)|Verify \[(?:FAIL|TIMEOUT))/i.test(body)) {
      failed = true;
    }
  }

  return {
    backgroundRunning: false,
    terminal,
    failed,
    errSig: failed ? extractErrorSignature(errorText, body) : ""
  };
}

function classifyEditOutcome(bareTool, hasArtifactMeta, looksLikePlanPath, errorText, rawResponseText, explicitError) {
  const body = stripTranscriptStepHeaders(rawResponseText);
  const combinedErr = `${errorText}\n${body}`.trim();

  const explicitlyApplied =
    bareTool === "apply_edits" &&
    (/^\s*Applied edits to \d+ file\(s\):/im.test(body) || /Partial edit applied\b/i.test(body));

  const abortedNoWrite =
    !explicitlyApplied &&
    /^\s*(?:(?:Atomic edit aborted|Edit aborted|Validation failed)\s*\(0 files modified\)|Write failed \(changes rolled back\)|Encountered error in step execution|Tool error \(|Error(?:\s*\[[A-Z0-9_]+\])?:)/i.test(
      body
    );

  const editFailed = !explicitlyApplied && (explicitError || abortedNoWrite);
  const planModeWriteBlocked =
    editFailed &&
    WRITE_ONLY_TOOLS.has(bareTool) &&
    (PLAN_MODE_BLOCK_RE.test(combinedErr) ||
      ((hasArtifactMeta || looksLikePlanPath) && ARTIFACT_READONLY_RE.test(combinedErr)));

  let verifyResult = null;
  if (bareTool === "apply_edits" && !abortedNoWrite) {
    const verifyMatch = body.match(/Verify \[(PASS|FAIL|TIMEOUT)[^\]]*\]/i);
    if (verifyMatch) {
      const status = verifyMatch[1].toUpperCase();
      const verifyFailed = status !== "PASS";
      verifyResult = {
        failed: verifyFailed,
        errSig: verifyFailed ? extractErrorSignature(errorText, body) : ""
      };
    }
  }

  // A blank, partial or still-running result is insufficient for the approved
  // plan ledger. Older failure counters intentionally retain their old contract.
  let applied = false;
  if (!editFailed) {
    if (bareTool === "apply_edits") applied = /^Applied edits to [1-9]\d* file\(s\):/i.test(body);
    else if (WRITE_ONLY_TOOLS.has(bareTool)) applied = /^(?:Created file\b|File (?:successfully )?created\b|Successfully created\b)/i.test(body);
    else applied = /^(?:Made [1-9]\d* replacements? in\b|Successfully (?:edited|modified|replaced|applied|updated)\b|(?:File|The file)\b[^\r\n]{0,500}\b(?:edited|modified|updated)|Applied (?:the )?(?:edit|change))/i.test(body);
  }
  return { editFailed, abortedNoWrite, planModeWriteBlocked, verifyResult, applied };
}

/**
 * Classify a PostToolUse hook payload into 0..2 lightweight tracking events.
 * Read-only tools return [] (zero disk I/O).
 * When Antigravity omits `toolResponse` in PostToolUse, marks `pending: true`
 * if `transcriptStep` wasn't flushed yet (or is still RUNNING), so PreInvocation
 * resolves the authoritative outcome from `transcript.jsonl`.
 */
export function classifyToolEvents(payload, nowMs = Date.now(), options = {}) {
  if (!payload || typeof payload !== "object") return [];
  const toolCall = payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : {};
  const { bareTool, effectiveArgs } = normalizeBareTool(toolCall.name, toolCall.args || {});
  if (!bareTool) return [];

  const stepIdx = Number.isFinite(Number(payload.stepIdx ?? payload.step_idx))
    ? Math.floor(Number(payload.stepIdx ?? payload.step_idx))
    : null;
  const transcriptStep = options.transcriptStep || null;
  const hasTranscriptPath = Boolean(options.hasTranscriptPath || nonEmptyString(payload.transcriptPath ?? payload.transcript_path));

  const payloadErrorText = extractErrorText(payload);
  const payloadResponseText = extractResponseText(payload);
  const payloadExplicitError = hasExplicitErrorFlag(payload);

  // Merge transcriptStep only when PostToolUse payload omitted toolResponse (real Antigravity runtime)
  const stepIsRunning =
    transcriptStep &&
    (transcriptStep.status === "RUNNING" || BG_RUNNING_RE.test(stripTranscriptStepHeaders(transcriptStep.content || "")));
  const useTranscriptStep = Boolean(!payloadResponseText && transcriptStep && !stepIsRunning);

  const errorText = payloadErrorText || (useTranscriptStep ? nonEmptyString(transcriptStep.error) : "");
  const responseText = payloadResponseText || (useTranscriptStep ? String(transcriptStep.content || "") : "");
  const explicitError =
    payloadExplicitError || (useTranscriptStep && (transcriptStep.status === "ERROR" || Boolean(nonEmptyString(transcriptStep.error))));

  const needsPreInvocationResolve = Boolean(
    hasTranscriptPath && stepIdx !== null && !payloadResponseText && !useTranscriptStep
  );
  const planEvidence = options.plan && planToolEvidence(
    options.plan, bareTool, effectiveArgs, payload, extractCommandString(bareTool, effectiveArgs)
  );
  const planFields = planEvidence ? { planEvidence } : {};

  // 1. Edit / write tools (including apply_edits with optional inline verify)
  if (EDIT_TOOL_NAMES.has(bareTool)) {
    if (bareTool === "apply_edits" && effectiveArgs.dryRun === true) {
      return [];
    }

    const files = extractEditFiles(bareTool, effectiveArgs);
    const hasArtifactMeta = Boolean(effectiveArgs.ArtifactMetadata || effectiveArgs.artifactMetadata);
    const targetRaw = String(
      effectiveArgs.Path ?? effectiveArgs.path ?? effectiveArgs.TargetFile ?? effectiveArgs.targetFile ?? ""
    );
    const looksLikePlanPath = /(?:implementation[_ -]?plan|plan\.md|[\\/]brain[\\/])/i.test(targetRaw);
    const hasVerify = Boolean(bareTool === "apply_edits" && effectiveArgs.verify);
    const verifyCmd = hasVerify
      ? typeof effectiveArgs.verify === "string"
        ? effectiveArgs.verify
        : String(effectiveArgs.verify?.command || "")
      : "";

    const editOutcome = classifyEditOutcome(
      bareTool,
      hasArtifactMeta,
      looksLikePlanPath,
      errorText,
      responseText,
      explicitError
    );

    const emitInlineVerify = Boolean(hasVerify && editOutcome.verifyResult);
    const pendingEdit = Boolean(
      needsPreInvocationResolve && (bareTool === "apply_edits" || !explicitError)
    );

    const events = [
      {
        ts: nowMs,
        stepIdx,
        kind: "edit",
        ...planFields,
        ...(planEvidence && editOutcome.applied ? { applied: true } : {}),
        tool: bareTool,
        failed: editOutcome.editFailed,
        abortedNoWrite: editOutcome.editFailed,
        planModeWriteBlocked: editOutcome.planModeWriteBlocked,
        files,
        ...(hasVerify ? { hasVerify: true, verifyCmd: sanitizeSnippet(verifyCmd, 64) } : {}),
        ...(emitInlineVerify ? { verifyEmitted: true } : {}),
        ...(hasArtifactMeta ? { hasArtifactMeta: true } : {}),
        ...(looksLikePlanPath ? { looksLikePlanPath: true } : {}),
        ...(pendingEdit ? { pending: true } : {})
      }
    ];

    if (emitInlineVerify) {
      events.push({
        ts: nowMs,
        stepIdx,
        kind: "cmd",
        tool: "apply_edits:verify",
        ...planFields,
        ...(planEvidence ? { terminal: true } : {}),
        failed: editOutcome.verifyResult.failed,
        isVerify: true,
        cmd: sanitizeSnippet(verifyCmd, 64),
        errSig: editOutcome.verifyResult.errSig
      });
    }

    return events;
  }

  // 2. Command / verification tools
  if (CMD_TOOL_NAMES.has(bareTool)) {
    const cmdStr = extractCommandString(bareTool, effectiveArgs);
    const isVerify = bareTool === "run_checks" || VERIFY_CMD_RE.test(cmdStr);
    const isBenignCmd = bareTool === "run_command" && isBenignSearchCommand(cmdStr);
    const isReadOnlyCmd = bareTool === "run_command" && isReadOnlyInspectCommand(cmdStr);

    if ((stepIsRunning || (planEvidence && BG_RUNNING_RE.test(stripTranscriptStepHeaders(responseText)))) && !payloadExplicitError) {
      // Background task not finished yet; record as pending so PreInvocation resolves from completion SYSTEM_MESSAGE
      return [
        {
          ts: nowMs,
          stepIdx,
          kind: "cmd",
          tool: bareTool,
          failed: false,
          isVerify,
          isBenignSearchCmd: isBenignCmd,
          isReadOnlyCmd,
          pending: true,
          backgroundRunning: true,
          ...planFields,
          cmd: sanitizeSnippet(cmdStr, 64),
          errSig: ""
        }
      ];
    }

    const cmdOutcome = classifyCommandOutcome(bareTool, isBenignCmd, errorText, responseText, explicitError);
    if (cmdOutcome.backgroundRunning) {
      return [];
    }

    return [
      {
        ts: nowMs,
        stepIdx,
        kind: "cmd",
        tool: bareTool,
        failed: cmdOutcome.failed,
        ...planFields,
        ...(planEvidence && cmdOutcome.terminal ? { terminal: true } : {}),
        isVerify,
        ...(isBenignCmd ? { isBenignSearchCmd: true } : {}),
        ...(isReadOnlyCmd ? { isReadOnlyCmd: true } : {}),
        ...(needsPreInvocationResolve ? { pending: true } : {}),
        cmd: sanitizeSnippet(cmdStr, 64),
        errSig: cmdOutcome.errSig
      }
    ];
  }

  return [];
}

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

    if (ev.kind === "cmd" && ev.tool !== "apply_edits:verify") {
      if (bgTask) {
        const outcome = classifyCommandOutcome(
          ev.tool,
          Boolean(ev.isBenignSearchCmd),
          "",
          bgTask.text,
          false
        );
        nextCache[key] = { kind: "cmd", failed: outcome.failed, errSig: outcome.errSig, ...(ev.planEvidence ? { terminal: Boolean(outcome.terminal) } : {}) };
        resolvedEvents.push({
          ...ev,
          failed: outcome.failed,
          ...(ev.planEvidence ? { terminal: Boolean(outcome.terminal) } : {}),
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
          txExplicitErr
        );
        const receipt = outcome.terminal ? outcome : !txExplicitErr && (ev.terminal ? ev : cached?.terminal ? cached : null);
        const terminal = Boolean(receipt);
        const failed = (ev.planEvidence && terminal) ? receipt.failed : outcome.failed;
        nextCache[key] = { kind: "cmd", failed, errSig: outcome.errSig, ...(ev.planEvidence ? { terminal } : {}) };
        resolvedEvents.push({
          ...ev,
          failed,
          ...(ev.planEvidence ? { terminal } : {}),
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
          ...(ev.planEvidence ? { terminal: Boolean(cached.terminal) } : {}),
          errSig: cached.errSig || "",
          pending: false,
          backgroundRunning: false
        });
        continue;
      }

      if (ev.backgroundRunning) {
        // Still waiting for background task completion
        continue;
      }

      resolvedEvents.push(ev);
      continue;
    }

    if (ev.kind === "edit") {
      if (txStep) {
        if (txStep.status === "RUNNING" && ev.planEvidence) continue;
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
        nextCache[key] = {
          kind: "edit",
          ...(ev.planEvidence ? { applied: editOut.applied || Boolean(ev.applied) } : {}),
          failed: editOut.editFailed,
          planModeWriteBlocked: editOut.planModeWriteBlocked,
          verifyResult: editOut.verifyResult
        };
        resolvedEvents.push({
          ...ev,
          failed: editOut.editFailed,
          ...(ev.planEvidence ? { applied: editOut.applied || Boolean(ev.applied) } : {}),
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
            ...(ev.planEvidence ? { planEvidence: ev.planEvidence, terminal: true } : {}),
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
        resolvedEvents.push({
          ...ev,
          failed: Boolean(cached.failed),
          abortedNoWrite: Boolean(cached.failed),
          ...(ev.planEvidence ? { applied: Boolean(cached.applied) } : {}),
          planModeWriteBlocked: Boolean(ev.planModeWriteBlocked || cached.planModeWriteBlocked),
          pending: false
        });
        if (ev.hasVerify && !ev.verifyEmitted && cached.verifyResult) {
          resolvedEvents.push({
            ts: ev.ts,
            stepIdx,
            kind: "cmd",
            tool: "apply_edits:verify",
            ...(ev.planEvidence ? { planEvidence: ev.planEvidence, terminal: true } : {}),
            failed: Boolean(cached.verifyResult.failed),
            isVerify: true,
            cmd: ev.verifyCmd || "verify",
            errSig: cached.verifyResult.errSig || ""
          });
        }
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
  return { resolvedEvents, nextResolvedSteps: prunedCache, cacheChanged };
}

function extractProseForIntent(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return "";
  // Remove fenced code blocks so pasted logs, rules, or docs do not false-trigger intent regexes
  const withoutCode = rawText.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (withoutCode.length <= 600) return withoutCode;
  return `${withoutCode.slice(0, 400)} ${withoutCode.slice(-200)}`;
}

function parseNonNegInt(val) {
  if (val === undefined || val === null || val === "" || typeof val === "boolean") return null;
  if (typeof val === "string" && val.trim() === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function hashText(val) {
  return crypto.createHash("sha1").update(String(val || "")).digest("hex").slice(0, 16);
}

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
        // Pure read-only inspection commands (git status/diff/log, ls, rg, grep) must NOT reset
        // failure streaks, wipe pending edited files, or clear edit<->fail oscillations.
        if (ev.isReadOnlyCmd) {
          continue;
        }
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

function hasDirectFixOrChangeIntent(intentProse) {
  if (!intentProse) return false;
  if (NEGATED_EDIT_INTENT_RE.test(intentProse)) {
    return false;
  }
  if (IMPERATIVE_FIX_INTENT_RE.test(intentProse)) {
    return true;
  }
  if (DIAGNOSTIC_OR_CHECK_INQUIRY_RE.test(intentProse)) {
    return false;
  }
  return DIRECT_TASK_MUTATE_RE.test(intentProse);
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

  // Reset boost alert flag once a post-alert command/verify passes cleanly (invariant to log compaction)
  if (
    metrics.latestPassTs > (nextState.lastBoostPassTs || 0) &&
    metrics.latestPassTs >= (nextState.lastBoostAlertEventTs || 0) &&
    metrics.consecutiveCmdFailures === 0 &&
    metrics.editFailOscillations === 0
  ) {
    if (nextState.boostAlerted || nextState.lastBoostPassTs !== metrics.latestPassTs) {
      nextState.boostAlerted = false;
      nextState.lastBoostPassTs = metrics.latestPassTs;
      stateChanged = true;
    }
  }

  const turnInput = rawLastUserInput || (isMidTurn ? nextState.lastUserInput : "");
  const activeSlash = extractActiveSlashCommands(turnInput);
  const intentProse = extractProseForIntent(turnInput);

  // 2. Detect new user turn entry (excluding background-task wakeups that carry no new USER_INPUT)
  const latestTxUserKey = nonEmptyString(transcriptTail?.latestUserInputKey);
  const sameTxTurnKey =
    Boolean(latestTxUserKey) && latestTxUserKey === (nextState.lastTurnUserInputKey || "");
  const isWakeupWithNoNewInput =
    !rawPayloadInput ||
    (sameTxTurnKey &&
      Boolean(transcriptTail?.hasBgTaskCompletionSinceUserInput) &&
      rawLastUserInput === nextState.lastUserInput);
  const isBgTaskWakeup =
    !isMidTurn &&
    invocationNum === 0 &&
    isWakeupWithNoNewInput &&
    (nextState.userTurnCount || 0) > 0 &&
    (sameTxTurnKey || Boolean(transcriptTail?.tailRolledOverWithoutUserInput)) &&
    (Boolean(transcriptTail?.hasBgTaskCompletionSinceUserInput) ||
      Boolean(transcriptTail?.hasPlannerResponseSinceUserInput) ||
      Boolean(transcriptTail?.tailRolledOverWithoutUserInput));

  const isNewUserTurn =
    !isMidTurn &&
    !isBgTaskWakeup &&
    ((invocationNum === 0 &&
      (initialNumSteps !== nextState.lastTurnInitialSteps ||
        rawLastUserInput !== nextState.lastUserInput ||
        nextState.userTurnCount === 0)) ||
      (invocationNum === null && rawLastUserInput !== "" && rawLastUserInput !== nextState.lastUserInput));

  if (isNewUserTurn) {
    nextState.userTurnCount = (nextState.userTurnCount || 0) + 1;
    nextState.lastUserInput = rawLastUserInput;
    nextState.lastTurnUserInputKey = latestTxUserKey;
    if (!isPlanApprovalNotice(inputEnvelope)) {
      nextState.lastPlanBoostNoticeHash = "";
    }
    nextState.lastTurnInitialSteps = initialNumSteps;
    nextState.lastTurnStartTs = nowMs;
    nextState.turnAutoRetries = 0;
    nextState.lastContinueEventSig = "";
    nextState.turnRetryOverride = parseTurnRetryOverride(intentProse);
    nextState.turnUnattendedGoal = Boolean(
      UNATTENDED_GOAL_RE.test(intentProse) ||
        (nextState.turnRetryOverride && nextState.turnRetryOverride.mode !== "off")
    );
    stateChanged = true;

    if (activeSlash.has("compact")) {
      nextState.freePlan = null;
      nextState.debugTurnStreak = 0;
      nextState.boostAlerted = false;
      nextState.lastBoostPassTs = 0;
      nextState.lastPaidBoostTurn = null;
      nextState.lastBoostAlertEventTs = 0;
      nextState.turnUnattendedGoal = false;
      nextState.turnRetryOverride = null;
      nextState.turnAutoRetries = 0;
      nextState.lastContinueEventSig = "";
      nextState.lastPlanBoostKey = "";
      nextState.lastPlanBoostNoticeHash = "";
      nextState.lastPlanBoostPromptKey = "";
      nextState.lastTurnUserInputKey = "";
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
      if (!hadPriorUnresolvedFailure && nextState.boostAlerted) {
        nextState.boostAlerted = false;
      }
    }
  }

  // A fresh user task ends the preceding plan. A replay of the same approval
  // or a background wakeup retains its one-shot budgets.
  const approvedNotice = isPlanApprovalNotice(inputEnvelope) && (!rawLastUserInput || confirmsPlan(rawLastUserInput));
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

  // 3. Priority 1: Read-only Plan Mode blocked artifact write_file
  // Sources: (a) real Antigravity PreToolUse denial in transcript.jsonl, (b) PostToolUse event fallback.
  const txPlanBlock = transcriptTail?.latestPlanModeDenial || null;
  const evPlanBlock =
    metrics.latestPlanModeBlock &&
    (nextState.lastTurnStartTs === 0 || metrics.latestPlanModeBlock.ts >= nextState.lastTurnStartTs - 5000)
      ? metrics.latestPlanModeBlock
      : null;
  const activePlanBlock = effSettings.planFallbackEnabled ? txPlanBlock || evPlanBlock : null;

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

  const paidBoostActive = effSettings.planTier === "paid" && effSettings.boostEnabled === true;
  const isDirectUnflushedNotice =
    Boolean(rawPayloadInput) &&
    isPlanApprovalNotice(rawPayloadInput) &&
    !transcriptTail?.tailRolledOverWithoutUserInput &&
    rawPayloadInput !== latestTranscriptInput;
  const noticeHash = isPlanApprovalNotice(inputEnvelope) ? hashText(inputEnvelope) : "";
  const latestPlanPromptKey = nonEmptyString(transcriptTail?.latestPlanPromptKey);
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
  if (
    ((paidBoostActive && effSettings.boostAfterPlanApproval &&
      !DECLINES_DELEGATION_RE.test(intentProse) &&
      !DECLINES_DELEGATION_RE.test(extractProseForIntent(transcriptTail?.planRequest || prevState.lastUserInput))) ||
      effSettings.planTier === "free") &&
    isNewUserTurn &&
    activeSlash.size === 0 &&
    !alreadyTriggeredPlanBoost &&
    !blockedByTailState
  ) {
    const sameInput = inputEnvelope === latestTranscriptInput || inputEnvelope === unwrapUserRequestText(latestTranscriptInput);
    const clickedApproval = isPlanApprovalNotice(inputEnvelope) || (sameInput && isPlanApprovalNotice(latestTranscriptInput));
    const confirmedInChat = confirmsPlan(rawLastUserInput);
    if ((clickedApproval && (!rawLastUserInput || confirmedInChat)) ||
        (sameInput && transcriptTail?.latestInputFollowsPlan && confirmedInChat)) {
      if (effSettings.planTier === "free" && (txPlanBlock || transcriptTail?.awaitingUserApprovalOrQuestion && !clickedApproval)) {
        return { nextState, injectStep: null, shouldResetEvents, reasonCode: "awaiting_approval", stateChanged, metrics };
      }
      nextState.lastPlanBoostKey = planBoostKey;
      nextState.lastPlanBoostNoticeHash = noticeHash;
      nextState.lastPlanBoostPromptKey = latestPlanPromptKey;
      stateChanged = true;
      if (effSettings.planTier === "free") {
        const source = unwrapUserRequestText(nonEmptyString(transcriptTail?.planRequest) || prevState.lastUserInput);
        const prefs = planPreferences(source);
        const requested = requestedProjectCheck(source + "\n" + (transcriptTail?.planCheckText || ""), payload.workspacePaths ?? payload.workspace_paths);
        nextState.freePlan = { key: planBoostKey, ...prefs, requested, wroteSource: false, reminded: false, reviewRequested: false, scopes: {} };
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

  const plan = nextState.freePlan;
  if (plan?.wroteSource && effSettings.freePlanReviewEnabled && !uiOnly && !plan.reviewRequested &&
      !plan.skipReview && !activeSlash.size && !activePlanBlock && !transcriptTail?.awaitingUserApprovalOrQuestion) {
    nextState.freePlan = { ...plan, reviewRequested: true };
    return {
      nextState, shouldResetEvents, stateChanged: true, metrics, reasonCode: "approved_free_plan_review",
      injectStep: buildInjectStep({ systemMessage:
        "[agy-cmd] This approved implementation has one optional independent review. Finish all planned edits yourself and run relevant project checks first (honor any user skip). Before final delivery, call invoke_subagent once with TypeName='cmd-verifier' and Workspace='inherit'. Send the acceptance criteria, this task's relative paths and diff excerpts only, applicable root/nested AGENTS.md or GEMINI.md paths, and actual check commands and terminal results or the concrete reason they could not run. The reviewer reads and reports specification gaps first, then risks and missing tests with file locations and counterexamples. Address blockers and verify the final changes yourself. If unavailable, over quota or unsuccessful, report that the independent review was not completed and finish on the main thread. Do not retry the role or start a second reviewer. Respect later user requests to stop or skip review." })
    };
  }

  // Route a single hard problem at entry, or escalate once the debugging signals accumulate.
  const hasFreshFailureSinceAlert =
    !nextState.boostAlerted || metrics.latestFailureTs > (nextState.lastBoostAlertEventTs || 0);
  const isCleanNonDebugTurnEntry = isNewUserTurn && (nextState.debugTurnStreak || 0) === 0;
  const oscHit = !isCleanNonDebugTurnEntry && metrics.editFailOscillations >= 2 && hasFreshFailureSinceAlert;
  const failStreakHit =
    !isCleanNonDebugTurnEntry && metrics.consecutiveCmdFailures >= 3 && hasFreshFailureSinceAlert;
  const multiTurnDebugHit = isNewUserTurn && (nextState.debugTurnStreak || 0) >= 2;
  const hardTaskHit = isNewUserTurn && DEBUG_ACTION_RE.test(intentProse) && HARD_DEBUG_TASK_RE.test(intentProse);
  const stuck = oscHit || failStreakHit || multiTurnDebugHit;
  const shouldEscalate = paidBoostActive
    ? (hardTaskHit || stuck) && !uiOnly && !isBgTaskWakeup && !activePlanBlock &&
      !transcriptTail?.awaitingUserApprovalOrQuestion && !DEBUG_DISCUSSION_RE.test(intentProse) &&
      !(isNewUserTurn && (nextState.turnUnattendedGoal || requestsMigration(intentProse))) &&
      nextState.lastPaidBoostTurn !== nextState.userTurnCount
    : stuck && effSettings.freeFallbackEnabled;

  if (shouldEscalate && activeSlash.size === 0 && !DECLINES_DELEGATION_RE.test(intentProse)) {
    const cooldownElapsed =
      !nextState.boostAlerted ||
      (!paidBoostActive && nextState.userTurnCount - (nextState.lastBoostAlertTurn || 0) >= 3);

    if (cooldownElapsed) {
      nextState.boostAlerted = true;
      nextState.lastBoostAlertTurn = nextState.userTurnCount;
      nextState.lastBoostAlertEventTs = metrics.latestFailureTs || metrics.latestEventTs || nowMs;
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
        const allowFix = hasDirectFixOrChangeIntent(intentProse) && !/只读|\bread[- ]only\b/i.test(intentProse);
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
          systemMessage: `[agy-cmd] Objective stuck threshold reached (${reasonsEn.join("; ")}). Start line 1 with "[agy-cmd → 自动换视角排查]". Give one available investigator ("dart-reviewer" or "research") a read-only task with the failing check and relevant files. Ask for a falsifiable cause and supporting evidence. If neither is available, investigate in the main session. The main agent verifies any fix. Do not recommend heavy commands for this fallback.`
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
      const policyZh =
        retryPolicy.mode === "infinite"
          ? "一直自动重试直至全绿"
          : `最多自动续跑 ${retryPolicy.max} 次`;
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown: `> **[agy-cmd → 自动续跑已启用]** 已挂载防停机监工（本轮策略：${policyZh}；可在右侧 \`agy-cmd\` 面板随时调节）。`,
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
        userMarkdown: `> **[agy-cmd → 建议 /goal]** 检测到无人值守持续修复诉求（当前自动重试为关闭状态）。可复制：\`/goal ${summary}\``,
        systemMessage:
          '[agy-cmd] User asked for an unattended fix-until-green loop while auto-retry is set to off. Put "[agy-cmd → 建议 /goal]" and a copyable "/goal <concise target + acceptance criteria>" on line 1 of your reply, then proceed with fixing.'
      }),
      shouldResetEvents,
      reasonCode: "suggest_goal",
      stateChanged,
      metrics
    };
  }

  // 6. Priority 4: Repo-wide multi-day migration/rewrite (turn entry only; tier-aware)
  if (
    isNewUserTurn &&
    activeSlash.size === 0 &&
    nextState.lastTeamworkAlertTurn !== nextState.userTurnCount &&
    requestsMigration(intentProse)
  ) {
    nextState.lastTeamworkAlertTurn = nextState.userTurnCount;
    stateChanged = true;
    if (effSettings.planTier === "paid") {
      const summary = sanitizeSnippet(intentProse, 36) || "仓库级迁移与重构";
      return {
        nextState,
        injectStep: buildInjectStep({
          uiOnly,
          userMarkdown: `> **[agy-cmd → 建议 /teamwork]** 检测到仓库级长周期迁移/重写诉求。可复制：\`/teamwork ${summary}\``,
          systemMessage:
            '[agy-cmd] User requested a repo-wide multi-phase migration/rewrite. Put "[agy-cmd → 建议 /teamwork]" and a copyable "/teamwork <concise target>" on line 1. Outline independently verifiable milestones. Start with the scoping interview to establish the target, constraints and acceptance checks before workers start.'
        }),
        shouldResetEvents,
        reasonCode: "suggest_teamwork",
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
  "MAX_INVOCATIONS",
  "MAX_FORCED_INVOCATIONS",
  "MAX_TOKEN_BUDGET_EXCEEDED",
  "TERMINAL_STEP_TYPE",
  "TERMINAL_CUSTOM_HOOK",
  "INJECTED_RESPONSE"
]);

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
  const freeModelStop = termReason === "MODEL_STOP" && effSettings.planTier === "free" &&
    Boolean(prevState.freePlan) && (payload.fullyIdle ?? payload.fully_idle) === true;
  if ((!freeModelStop && termReason !== "NO_TOOL_CALL") || STOP_ALLOW_REASONS.has(termReason)) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: `term_${termReason.toLowerCase()}`,
      nextState: prevState,
      stateChanged: false,
      metrics: null
    };
  }

  // Safety Brake 2: Wait for running background tasks instead of forcing premature loops
  if (payload.fullyIdle === false || payload.fully_idle === false) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: "not_fully_idle",
      nextState: prevState,
      stateChanged: false,
      metrics: null
    };
  }

  let nextState = { ...prevState };
  let stateChanged = false;

  const reconciled = reconcileEventsWithTranscript(events, transcriptTail, nextState.resolvedSteps);
  const effectiveEvents = reconciled.resolvedEvents;
  if (reconciled.cacheChanged) {
    nextState.resolvedSteps = reconciled.nextResolvedSteps;
    stateChanged = true;
  }

  const rawLastUserInput = unwrapUserRequestText(
    nonEmptyString(payload.lastUserInput ?? payload.last_user_input) ||
      nonEmptyString(transcriptTail?.latestUserInput) ||
      nonEmptyString(nextState.lastUserInput)
  );

  // Safety Brake 3: Do not double-continue when user explicitly invoked native `/goal`
  const activeSlash = extractActiveSlashCommands(rawLastUserInput);
  if (activeSlash.has("goal")) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: "native_goal_active",
      nextState,
      stateChanged,
      metrics: null
    };
  }

  const intentProse = extractProseForIntent(rawLastUserInput);
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
    return {
      decision: "allow",
      reason: "",
      reasonCode: "awaiting_user_input",
      nextState,
      stateChanged,
      metrics
    };
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
  // A scope outside this plan, another package's green test or arbitrary
  // successful command cannot clear a known failed project check.
  const skipPlanChecks = plan && (plan.skipCheck || planPreferences(rawLastUserInput).skipCheck);
  const checks = plan && !skipPlanChecks &&
    !transcriptTail?.latestPlanModeDenial ? pendingPlanChecks(plan) : [];
  const scopedFailure = checks.find(check => check.failed);
  const stalePlanFailure = plan && metrics.lastFailureIsVerify && effectiveEvents.some(ev =>
    ev.failed && ev.kind === "cmd" && ev.ts === metrics.latestFailureTs && ev.planEvidence?.key === plan.key &&
    Number.isSafeInteger(ev.stepIdx) && plan.scopes[ev.planEvidence.checked?.scope]?.editStep > ev.stepIdx);
  const hasUnresolvedTurnFailure = Boolean(scopedFailure) ||
    (metrics.consecutiveCmdFailures >= 1 && metrics.latestFailureTs >= turnFloorTs &&
     !stalePlanFailure && !(skipPlanChecks && metrics.lastFailureIsVerify));
  const explicitNoEdit = !turnGoal && !metrics.hasTurnEdit && NEGATED_EDIT_INTENT_RE.test(intentProse);
  const smartTriggered =
    !explicitNoEdit &&
    (metrics.hasTurnEdit || plan?.wroteSource ||
      (metrics.lastFailureIsVerify && hasDirectFixOrChangeIntent(intentProse)));
  const retryPolicy = resolveEffectiveRetryPolicy(
    effSettings,
    turnOverride,
    turnGoal,
    smartTriggered
  );

  if (!retryPolicy.active) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: "retry_inactive",
      nextState,
      stateChanged,
      metrics
    };
  }

  const missingCheck = !hasUnresolvedTurnFailure && !plan?.reminded && checks.length > 0 &&
    (payload.fullyIdle ?? payload.fully_idle) === true &&
    (freeModelStop || nonEmptyString(payload.terminationReason ?? payload.termination_reason).toUpperCase() === "NO_TOOL_CALL");
  if (!hasUnresolvedTurnFailure && !missingCheck) {
    if ((!plan && nextState.turnAutoRetries !== 0) || nextState.lastContinueEventSig !== "") {
      if (!plan) nextState.turnAutoRetries = 0;
      nextState.lastContinueEventSig = "";
      stateChanged = true;
    }
    return {
      decision: "allow",
      reason: "",
      reasonCode: "all_green_or_no_failure",
      nextState,
      stateChanged,
      metrics
    };
  }

  // Safety Brake 4: No-progress stall guard (if last continuation ran zero new edits/commands,
  // the agent is asking a clarifying question or reporting an external blocker -> let it stop!)
  const currentEventSig = `${effectiveEvents.length}:${metrics.latestEventTs}`;
  if ((nextState.turnAutoRetries || 0) > 0 && nextState.lastContinueEventSig === currentEventSig) {
    nextState.lastContinueEventSig = "";
    stateChanged = true;
    return {
      decision: "allow",
      reason: "",
      reasonCode: "no_progress_guard",
      nextState,
      stateChanged,
      metrics
    };
  }

  const execNum = parseNonNegInt(payload.executionNum ?? payload.execution_num);
  const hostRetries =
    execNum !== null && (payload.continuationActive === true || execNum > 0) ? execNum : 0;
  const completedRetries = Math.max(nextState.turnAutoRetries || 0, hostRetries);

  if (retryPolicy.mode === "count" && completedRetries >= retryPolicy.max) {
    return {
      decision: "allow",
      reason: "",
      reasonCode: "retry_limit_reached",
      nextState,
      stateChanged,
      metrics
    };
  }

  const nextRetryNum = completedRetries + 1;
  nextState.turnAutoRetries = nextRetryNum;
  nextState.lastContinueEventSig = currentEventSig;
  stateChanged = true;

  if (missingCheck) {
    nextState.freePlan = { ...plan, reminded: true };
    const tasks = checks.map(({ dir, command }) => JSON.stringify(dir) + " → " + command).join("；");
    return {
      decision: "continue", reasonCode: "approved_plan_missing_verification", nextState, stateChanged, metrics,
      reason: "[agy-cmd 计划补验] 本次计划已修改源码，尚缺最后一次修改之后的项目验证结果。请在以下目录运行对应检查并等待终态：" +
        tasks + "。若环境不可用或用户要求跳过，请在交付中说明缺测项和原因。"
    };
  }

  const progressTag =
    retryPolicy.mode === "infinite"
      ? `#${nextRetryNum} (无限模式)`
      : `${nextRetryNum}/${retryPolicy.max}`;
  const failedCheckLabel = scopedFailure ? `${JSON.stringify(scopedFailure.dir)} → ${scopedFailure.command}` : metrics.lastFailureCmd;
  const cmdHint = failedCheckLabel ? `（最近失败：${failedCheckLabel}）` : "";
  const reason =
    `[agy-cmd 自动续跑 ${progressTag}] 检测到验证/测试尚未全绿通过${cmdHint}。` +
    `请勿提前收工，继续定位根因、修改代码并重新运行验证命令；若遇到必须由用户确认的阻塞问题而无法自行推进，请直接说明原因并停下（无需再运行命令）。`;

  return {
    decision: "continue",
    reason,
    reasonCode: "auto_continue",
    nextState,
    stateChanged,
    metrics
  };
}
