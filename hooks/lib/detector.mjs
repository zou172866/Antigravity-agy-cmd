import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  detectHostSurface,
  extractActiveSlashCommands,
  isBareResumeNormalSessionRequest,
  isResumeNormalSessionRequest,
  isSubagentPayload,
  nonEmptyString,
  parseMaybeJson,
  resolveHostSlashCapability,
  sanitizeSnippet,
  shortFileLabel,
  unwrapUserRequestText
} from "./common.mjs";
import { createDefaultState } from "./state.mjs";
import { normalizeSettings, parseTurnRetryOverride } from "./settings.mjs";
import { isPlanApprovalNotice, stripTranscriptStepHeaders } from "./transcript.mjs";
import {
  advanceDeliveryGate,
  advancePlan,
  allowsTestWeakening,
  applyEditReceipt,
  autoCheckCanonicalKey,
  compareDeliveryOrder,
  deliveryEditOrders,
  deliveryEventOrder,
  deliveryGateToolEvidence,
  detectTestAssertionWeakeningDetails,
  evaluateDeliveryGateStatus,
  filterTestWeakeningByAppliedFiles,
  matchesCustomCheckCommand,
  pathKey,
  pendingPlanChecks,
  planPreferences,
  planToolEvidence,
  requestedProjectCheck
} from "./plan-verification.mjs";

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

function resolvePendingPlanApprovalState(inputEnvelope, transcriptTail, eventBlock, turnStartedAt, enabled) {
  const request = unwrapUserRequestText(inputEnvelope);
  const transcriptInput = nonEmptyString(transcriptTail?.latestUserInput);
  const matchesTranscript = inputEnvelope === transcriptInput || inputEnvelope === unwrapUserRequestText(transcriptInput);
  const confirmed = confirmsPlan(request);
  const approvedNotice = (isPlanApprovalNotice(inputEnvelope) || (matchesTranscript && isPlanApprovalNotice(transcriptInput))) &&
    (!request || confirmed);
  const planAdapterUnknown = transcriptTail?.adapter?.states?.planApproval === "unknown";
  const chatApproval = !planAdapterUnknown && confirmed && transcriptTail?.latestInputFollowsPlan && (!transcriptInput || matchesTranscript);
  const recentEvent = eventBlock && eventBlock.ts >= turnStartedAt - 5000 ? eventBlock : null;
  const txDenial = transcriptTail?.latestPlanModeDenial;
  const block = enabled ? txDenial || recentEvent : null;
  // The tail scanner clears its denial at each USER_INPUT, even when the host omits indexes.
  const inputStep = /^step:(\d+)$/.exec(transcriptTail?.latestUserInputKey || "");
  const laterTxDenial = txDenial && (!inputStep || txDenial.stepIdx == null || txDenial.stepIdx > Number(inputStep[1]));
  const laterEvent = recentEvent && inputStep && recentEvent.stepIdx != null && recentEvent.stepIdx > Number(inputStep[1]);
  const laterDenial = matchesTranscript && (laterTxDenial || laterEvent);
  const isApproved = Boolean((approvedNotice || chatApproval) && !laterDenial);
  return { approvedNotice, isApproved, activePlanBlock: block, requiresConfirmation: Boolean(block && !isApproved) };
}

// Note: ctx_execute is intentionally excluded (it is a read/analysis sandbox, not a build/test runner)
const CMD_TOOL_NAMES = new Set(["run_command", "run_checks"]);

const VERIFY_CMD_RE =
  /(?:\b(?:test|vitest|jest|pytest|mocha|ava|playwright|cypress|rspec|phpunit|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|build|vet)|tsc|typecheck|lint|eslint|biome|ruff|flake8|mypy|gradle|mvn|dotnet\s+(?:test|build)|make|cmake|bazel\s+(?:test|build)|deno\s+test|swift\s+test|mix\s+test|npm\s+(?:test|t|run\s+(?:build|check|verify|lint|test|typecheck))|pnpm\s+(?:build|check|verify|lint|test|typecheck)|yarn\s+(?:build|check|verify|lint|test|typecheck)|bun\s+(?:test|build)|(?:node|tsx)\s+--test|(?:python3?|py)\s+-m\s+(?:unittest|pytest)|uv\s+run\s+(?:pytest|ruff|mypy|python\s+-m\s+(?:pytest|unittest)))\b|(?:^|[\s/\\"'`])(?:run_?tests?|test_[A-Za-z0-9_]+)\.(?:py|sh|ps1|mjs|cjs|js|ts)\b)/i;

const NON_FAILURE_EXIT1_CMD_RE =
  /^\s*(?:rg|ripgrep|grep|egrep|fgrep|findstr|select-string|git\s+diff\b[^\n]*--quiet|git\s+grep\b|diff\b|fc\b|test\b|\[)\b/i;

const READ_ONLY_INSPECT_CMD_RE =
  /^\s*(?:git\s+(?:(?:status|diff|log|show|branch|rev-parse|ls-files|grep)\b|remote(?:\s+-v)?$|tag\s+(?:-l|--list|--points-at)\b|config\s+(?:--get|--list|-l)\b)|ls\b|dir\b|pwd\b|echo\b|rg\b|ripgrep\b|grep\b|egrep\b|fgrep\b|findstr\b|select-string\b|which\b|where(?:\.exe)?\b|command\s+-v\b|Get-ChildItem\b|Get-Location\b|Test-Path\b|cat\b|head\b|tail\b|wc\b|stat\b|file\b|(?:node|python3?|py|npm|pnpm|yarn|bun|git|go|cargo|rustc|java|dotnet|gh|agy|uv|docker)(?:\.exe|\.cmd)?\s+(?:-v|-V|--version)\b)/i;

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
  /(?:报错|出错|失败|排查|调试|修一下.*(?:错|bug|问题)|异常(?!处理|兜底|边界|路径|分支|场景|情况|恢复|安全|校验|测试|用例|单测)|崩溃|死锁|竞态|卡死|跑不通|测不过|通不过|\b(?:error|exception|traceback|stack\s*trace|failing|failed|bug|crash|deadlock|race\s+condition|broken|debug|fix\s+(?:this|the)\s+(?:bug|error|issue|crash|failure))\b)/i;

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

const DEFERRED_EDIT_INTENT_RE =
  /(?:(?:改动|修改|编辑|写)(?:代码|文件)?之?前(?:请)?(?:先|务必先)?[^\n。；！？.;!?]{0,24}(?:复述|确认|对齐|告知|说明|汇报|出方案|给方案|提方案|讨论|沟通|审批|批准)|先[^\n。；！？.;!?]{0,24}(?:复述(?:计划|方案)|确认(?:范围|方案|计划)|对齐(?:范围|方案|需求)|出(?:方案|计划)|等(?:我|用户)(?:确认|批准|同意|点头))[^\n。；！？.;!?]{0,16}(?:再|后)(?:改|修|写|动|执行|实施)|(?:确认|批准|同意|点头|对齐)(?:范围|方案|计划)?之?后(?:再|才)(?:改|修改|改动|写|动)(?:代码|文件)?|\b(?:before\s+(?:editing|modifying|changing|writing)(?:\s+(?:any\s+)?(?:code|files?))?[^\n.!?;]{0,40}\b(?:confirm|restate|align|review|ask|approve|plan)\b|(?:confirm|restate|align|review|approve)\b[^\n.!?;]{0,40}\bbefore\s+(?:editing|modifying|changing|writing)\b))/i;

const DIAGNOSTIC_OR_CHECK_INQUIRY_RE =
  /(?:为什么|为何|怎么回事|什么原因|啥原因|什么问题|哪里(?:有|出了)?(?:问题|错|bug)|哪儿(?:有|出了)?(?:问题|错|bug)|问题出在哪|错在哪|怎么会|什么意思|(?:帮我|先|只)?(?:分析|解释|诊断|评估|定位|查一下|看看)(?:一下)?|(?:跑|运行|执行|测)一下|\b(?:why\s+(?:is|does|did|are|do)|what(?:'s|\s+is)\s+(?:wrong|causing|the\s+(?:cause|error|issue|reason))|how\s+come|explain|analyze|diagnose|investigate)\b)/i;

const IMPERATIVE_FIX_INTENT_RE =
  /(?:(?:帮我|请|顺便|直接|一起|并|再|去|试着|继续)\s*(?:修(?:复|好|掉|一下|通)?|改(?:好|掉|一下|正)?|解决|修改)|(?!\s*(?:之后|以后|后|前|之前))(?:修(?:复|好|掉|一下|通)|改(?:好|掉|一下|正)|解决(?:一下|掉)|跑通)(?!\s*(?:之后|以后|后|前|之前|了没|了吗))|把[^\n，。；！？,.;!?]{1,24}(?:修(?:复|好|掉|一下|通)|改(?:好|掉|一下|正)|跑通|解决)|\b(?:please\s+|help\s+(?:me\s+)?|and\s+|then\s+)?(?:fix|resolve|repair|patch)\s+(?:it|this|the|all|failing|broken|test|tests|build|bug|error|issue))/i;

const DIRECT_TASK_MUTATE_RE =
  /(?:^(?:修|改|修复|修改|解决|重构|实现|新增|加上?|补上?)|(?:修复|修好|修一下|修掉|改一下|改好|解决掉?|重构|实现|新增|加上|补上|跑通)|\b(?:fix|resolve|repair|refactor|implement)\b)/i;

const TEAMWORK_MIGRATION_RE =
  /(?:跨天(?:重构|迁移|开发)|仓库级(?:重构|迁移|重写)|全仓库(?:重写|迁移|重构)|整个项目(?:重写|迁移)|大规模框架迁移|\b(?:repo[- ]?wide\s+(?:migration|rewrite|refactor)|multi[- ]?day\s+(?:migration|rewrite|refactor)|full\s+codebase\s+(?:migration|rewrite))\b)/i;

const LEADING_SWARM_SLASH_RE = /^\s*\/swarm(?=$|\s)/i;
const LEADING_AUTONOMY_SLASH_RE = /^\s*\/(swarm|teamwork|boost|run-workflow)(?=$|\s)/i;

function isHostSwarmEndedPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return (
    payload.swarmEnded === true ||
    payload.swarm_ended === true ||
    payload.swarmActive === false ||
    payload.swarm_active === false ||
    payload.metadata?.swarmEnded === true ||
    payload.metadata?.swarm_ended === true ||
    payload.metadata?.swarmActive === false ||
    payload.metadata?.swarm_active === false
  );
}

function parseStepKeyPosition(key) {
  if (typeof key !== "string" || !key) return null;
  const stepMatch = /^step:(\d+)$/.exec(key);
  if (stepMatch) return { kind: "step", value: Number(stepMatch[1]) };
  const byteMatch = /^byte:(\d+)$/.exec(key);
  if (byteMatch) return { kind: "byte", value: Number(byteMatch[1]) };
  return null;
}

function isSwarmActivitySuperseded(txKey, txStep, clearedKey, clearedStep) {
  if (txKey && clearedKey && txKey === clearedKey) return true;
  if (Number.isSafeInteger(txStep) && Number.isSafeInteger(clearedStep) && txStep <= clearedStep) {
    return true;
  }
  const txPos = parseStepKeyPosition(txKey);
  const clPos = parseStepKeyPosition(clearedKey);
  if (txPos && clPos && txPos.kind === clPos.kind && txPos.value <= clPos.value) {
    return true;
  }
  return false;
}

function hasFreshTranscriptSwarmActivity(transcriptTail, state) {
  if (!transcriptTail?.hasSwarmActivity) return false;
  const txKey = nonEmptyString(transcriptTail.latestSwarmActivityKey);
  const txStep = Number.isSafeInteger(transcriptTail.latestSwarmActivityStep)
    ? transcriptTail.latestSwarmActivityStep
    : null;
  if (!txKey && txStep === null) {
    return !(state?.swarmClearedAfterKey || Number.isSafeInteger(state?.swarmClearedAtStep));
  }
  return !isSwarmActivitySuperseded(
    txKey,
    txStep,
    nonEmptyString(state?.swarmClearedAfterKey),
    Number.isSafeInteger(state?.swarmClearedAtStep) ? state.swarmClearedAtStep : null
  );
}

function isTranscriptUserTurnAfterSwarmEnd(transcriptTail) {
  if (transcriptTail?.swarmLifecycle !== "ended") return false;
  const userPos = parseStepKeyPosition(nonEmptyString(transcriptTail.latestUserInputKey));
  const endPos = parseStepKeyPosition(nonEmptyString(transcriptTail.latestSwarmEndKey));
  if (userPos && endPos && userPos.kind === endPos.kind) {
    return userPos.value > endPos.value;
  }
  if (Number.isSafeInteger(transcriptTail.latestSwarmEndStep) && userPos?.kind === "step") {
    return userPos.value > transcriptTail.latestSwarmEndStep;
  }
  return false;
}

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

function extractRunChecksItems(args = {}, deliveryTestCommand = "") {
  const parsedCmds = Array.isArray(args.commands) ? args.commands : parseMaybeJson(args.commands);
  const cmds = Array.isArray(parsedCmds) ? parsedCmds : [];
  const out = [];
  for (const c of cmds.slice(0, 12)) {
    const rawCmd = unwrapCliFilterCommand(typeof c === "string" ? c : String(c?.command || "").trim());
    const rawName = typeof c === "object" && c ? nonEmptyString(c.name) : "";
    const label = sanitizeSnippet(rawName || rawCmd, 64);
    if (!label && !rawCmd) continue;
    const matchesCustom = Boolean(
      rawCmd && deliveryTestCommand && matchesCustomCheckCommand(rawCmd, deliveryTestCommand)
    );
    const isVerify = Boolean(rawCmd && (VERIFY_CMD_RE.test(rawCmd) || matchesCustom));
    const isReadOnly = Boolean(rawCmd && isReadOnlyInspectCommand(rawCmd));
    out.push({ label, isVerify, isReadOnly });
  }
  return out;
}

function normalizeCheckLabel(label) {
  return sanitizeSnippet(String(label || "").replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/i, "").trim(), 64).toLowerCase();
}

function parseRunChecksFailedLabels(body) {
  if (typeof body !== "string" || !body) return [];
  const hasFullSections = /^## \[(?:PASS|FAIL|ERROR|TIMEOUT)[^\]]*\]\s+/im.test(body);
  const re = hasFullSections
    ? /^## \[(?:FAIL|ERROR|TIMEOUT)[^\]]*\]\s+(.+?)\s*$/gim
    : /^-\s*\[(?:FAIL|ERROR|TIMEOUT)[^\]]*\]\s+(.+?)\s*$/gim;
  const labels = [];
  for (const m of body.matchAll(re)) {
    const clean = normalizeCheckLabel(m[1]);
    if (clean) labels.push(clean);
  }
  return labels;
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

// Windows PowerShell can report exit 1 when a successful test runner wrote progress to stderr.
// Only accept complete runner summaries, and check all earlier suites for failures first.
function hasSuccessfulNativeTestSummary(output, errorText) {
  output = stripVTControlCharacters(output);
  if (!/^[ \t]*\+[ \t]+FullyQualifiedErrorId[ \t]*:[ \t]*NativeCommandError[ \t]*\r?$/im.test(output)) return false;
  if (errorText && !/^(?:(?:command|process)\s+)?exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*:?\s*1\.?$/i.test(errorText.trim())) return false;
  const runnerFailure = /^[ \t]*(?:FAILED\b|(?:ERROR|FAIL):[ \t]+|(?:[ℹ#][ \t]+)?(?:fail|cancelled)[ \t]+[1-9]\d*\b|✖[ \t]+|not ok[ \t]+\d+\b|Bail out!)/im;
  const processFailure = /^[ \t]*(?:Segmentation fault\b|Fatal Python error:|npm (?:ERR!|error)\s|(?:(?:Command|Process) )?exit(?:ed)?(?: with)? (?:code|status)[ \t]*:?[ \t]*[1-9]\d*\b)/im;
  if (REAL_CMD_ERROR_RE.test(output) || runnerFailure.test(output) || processFailure.test(output)) return false;
  const summary = output.replace(/\r\n/g, "\n").trimEnd()
    .replace(/\n[ \t]*<\/SYSTEM_MESSAGE>$/i, "").trimEnd()
    .replace(/\n[ \t]*Log:[ \t]+file:\/\/\/[^\n]+$/i, "").trimEnd();
  const unittestSummary = /(?:^|\n)Ran [1-9]\d* tests? in \d+(?:\.\d+)?s\n(?:[ \t]*\n)*OK(?: \((?:skipped|expected failures)=\d+(?:, (?:skipped|expected failures)=\d+)*\))?$/;
  const nodeSummary = /(?:^|\n)([ℹ#]?[ \t]*)pass [1-9]\d*\n\1fail 0(?:\n\1(?:cancelled 0|(?:skipped|todo) \d+|duration_ms \d+(?:\.\d+)?))*$/;
  return unittestSummary.test(summary) || nodeSummary.test(summary);
}

function classifyCommandOutcome(bareTool, isBenignCmd, errorText, rawResponseText, explicitError, checkMeta = null, isVerify = false) {
  const body = stripTranscriptStepHeaders(rawResponseText);

  if (BG_RUNNING_RE.test(body) && !explicitError) {
    return { backgroundRunning: true, failed: false, errSig: "" };
  }

  let failed = false;
  let terminal = false;
  let failedIsVerify;
  if (bareTool === "run_checks") {
    let failedCnt = null;
    const m = body.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
    if (m) {
      const passedCnt = Number(m[1]);
      const totalCnt = Number(m[2]);
      failedCnt = m[3] ? Number(m[3]) : Math.max(0, totalCnt - passedCnt);
      failed = failedCnt > 0 || totalCnt === 0;
      terminal = m.index === 0 && totalCnt > 0 && (failedCnt > 0 || (passedCnt === totalCnt && !explicitError));
    } else {
      failed = explicitError || /## \[(?:FAIL|ERROR|TIMEOUT)/i.test(body);
    }

    if (failed && !explicitError && Array.isArray(checkMeta) && checkMeta.length > 0) {
      const failedLabels = parseRunChecksFailedLabels(body);
      const countMatches = failedLabels.length > 0 && (failedCnt === null || failedLabels.length === failedCnt);
      if (countMatches) {
        const matchedGroups = failedLabels.map((lbl) =>
          checkMeta.filter((item) => normalizeCheckLabel(item?.l) === lbl)
        );
        if (matchedGroups.every((grp) => grp.length > 0)) {
          if (matchedGroups.every((grp) => grp.every((item) => item.ro === 1))) {
            failed = false;
          } else {
            failedIsVerify = matchedGroups.some((grp) => grp.some((item) => item.v === 1));
          }
        }
      }
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
        const powerShellProgress = isVerify && hasSuccessfulNativeTestSummary(body.slice(headExitMatch[0].length), errorText);
        failed = !powerShellProgress && !isBenignSearchExit1(isBenignCmd, errorText, body);
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
    ...(failedIsVerify !== undefined ? { failedIsVerify } : {}),
    errSig: failed ? extractErrorSignature(errorText, body) : ""
  };
}

function parseApplyEditsPartialReceipt(body) {
  if (typeof body !== "string" || !/Partial edit applied\b/i.test(body)) {
    return { isPartial: false, writtenCount: null, appliedFiles: null };
  }
  const countMatch = body.match(/Partial edit applied\s*\(\s*(\d+)\s*\/\s*(\d+)\s+file\(s\)\s+written/i);
  const writtenCount = countMatch ? Number(countMatch[1]) : null;
  if (writtenCount === 0) {
    return { isPartial: true, writtenCount: 0, appliedFiles: [] };
  }
  const appliedHeader = /^Applied:\s*$/im.exec(body);
  if (!appliedHeader) {
    return { isPartial: true, writtenCount, appliedFiles: null };
  }
  const rest = body.slice(appliedHeader.index + appliedHeader[0].length).replace(/^\r?\n/, "");
  const appliedFiles = [];
  for (const line of rest.split(/\r?\n/)) {
    if (!line.trim()) break;
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (!bullet) break;
    const item = bullet[1]
      .trim()
      .replace(/:\s+(?:updated|created|modified|edited|replaced)\b.*$/i, "")
      .replace(/:\s+lines\s+[+-]?\d+.*$/i, "")
      .trim();
    if (item) appliedFiles.push(item);
  }
  return {
    isPartial: true,
    writtenCount,
    appliedFiles: appliedFiles.length > 0 ? appliedFiles : null
  };
}

function classifyEditOutcome(bareTool, hasArtifactMeta, looksLikePlanPath, errorText, rawResponseText, explicitError) {
  const body = stripTranscriptStepHeaders(rawResponseText);
  const combinedErr = `${errorText}\n${body}`.trim();

  const partialReceipt =
    bareTool === "apply_edits"
      ? parseApplyEditsPartialReceipt(body)
      : { isPartial: false, writtenCount: null, appliedFiles: null };

  const explicitlyApplied =
    bareTool === "apply_edits" &&
    (/^\s*Applied edits to [1-9]\d* file\(s\):/im.test(body) ||
      (partialReceipt.isPartial && partialReceipt.writtenCount !== 0));

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
  return { editFailed, abortedNoWrite, planModeWriteBlocked, verifyResult, applied, partialReceipt };
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

  const stepIdx = parseNonNegInt(payload.stepIdx ?? payload.step_idx);
  const transcriptStep = stepIdx === null ? null : options.transcriptStep || null;
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
  const extractedCmd = extractCommandString(bareTool, effectiveArgs);
  const planEvidence = options.plan && planToolEvidence(
    options.plan, bareTool, effectiveArgs, payload, extractedCmd
  );
  const deliveryEvidence = options.deliveryGate
    ? deliveryGateToolEvidence(
        options.deliveryGate,
        bareTool,
        effectiveArgs,
        payload,
        extractedCmd,
        options.deliveryTestCommand || ""
      )
    : null;
  const planFields = {
    ...(planEvidence ? { planEvidence } : {}),
    ...(deliveryEvidence ? { deliveryEvidence } : {})
  };
  const hasVerificationEvidence = Boolean(planEvidence || deliveryEvidence);

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
    // A timestamp alone cannot distinguish two edits in the same millisecond.
    const inlineBatch = emitInlineVerify && hasVerificationEvidence && stepIdx === null
      ? { inlineBatch: crypto.randomUUID() } : {};
    const pendingEdit = Boolean(
      needsPreInvocationResolve && (bareTool === "apply_edits" || !explicitError)
    );
    const editCwd = nonEmptyString(effectiveArgs.cwd ?? effectiveArgs.Cwd) || nonEmptyString(payload.cwd);

    const rawWeakening =
      !hasArtifactMeta && !looksLikePlanPath && (!editOutcome.editFailed || pendingEdit)
        ? detectTestAssertionWeakeningDetails(bareTool, effectiveArgs, { cwd: editCwd })
        : null;
    const baseWeakening = rawWeakening
      ? {
          files: rawWeakening.files,
          addedSkip: rawWeakening.addedSkip,
          droppedAssert: rawWeakening.droppedAssert
        }
      : null;
    const testWeakening = baseWeakening
      ? pendingEdit
        ? baseWeakening
        : filterTestWeakeningByAppliedFiles(
            baseWeakening,
            rawWeakening.entries,
            editOutcome.partialReceipt,
            editCwd
          )
      : null;
    const testWeakeningDetails =
      bareTool === "apply_edits" &&
      rawWeakening?.entries?.length &&
      (pendingEdit || editOutcome.partialReceipt?.isPartial)
        ? rawWeakening.entries.slice(0, 16)
        : null;

    const events = [
      {
        ts: nowMs,
        stepIdx,
        kind: "edit",
        ...inlineBatch,
        ...applyEditReceipt(planFields, editOutcome.partialReceipt, editOutcome.applied, editCwd,
          { ts: nowMs, stepIdx, ...inlineBatch }),
        ...(testWeakening ? { testWeakening } : {}),
        ...(testWeakeningDetails ? { testWeakeningDetails } : {}),
        ...((testWeakeningDetails || (bareTool === "apply_edits" && hasVerificationEvidence)) && editCwd ? { editCwd } : {}),
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
        ...inlineBatch,
        ...planFields,
        ...(hasVerificationEvidence ? { terminal: true } : {}),
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
    const cmdStr = extractedCmd;
    const isRunChecks = bareTool === "run_checks";
    const checkItems = isRunChecks ? extractRunChecksItems(effectiveArgs, options.deliveryTestCommand || "") : [];
    const matchesCustom = Boolean(
      !isRunChecks && options.deliveryTestCommand && matchesCustomCheckCommand(cmdStr, options.deliveryTestCommand)
    );
    const baseIsVerify = isRunChecks
      ? checkItems.some((item) => item.isVerify)
      : VERIFY_CMD_RE.test(cmdStr) || matchesCustom;
    const isBenignCmd = bareTool === "run_command" && isBenignSearchCommand(cmdStr);
    const isReadOnlyCmd = isRunChecks
      ? checkItems.length > 0 && checkItems.every((item) => item.isReadOnly)
      : bareTool === "run_command" && isReadOnlyInspectCommand(cmdStr);
    const checkMeta =
      isRunChecks && checkItems.length > 1 && !isReadOnlyCmd
        ? checkItems.map((item) => ({
            l: item.label,
            ...(item.isVerify ? { v: 1 } : {}),
            ...(item.isReadOnly ? { ro: 1 } : {})
          }))
        : null;

    if ((stepIsRunning || (hasVerificationEvidence && BG_RUNNING_RE.test(stripTranscriptStepHeaders(responseText)))) && !payloadExplicitError) {
      // Background task not finished yet; record as pending so PreInvocation resolves from completion SYSTEM_MESSAGE
      return [
        {
          ts: nowMs,
          stepIdx,
          kind: "cmd",
          tool: bareTool,
          failed: false,
          isVerify: baseIsVerify,
          isBenignSearchCmd: isBenignCmd,
          isReadOnlyCmd,
          ...(checkMeta ? { checkMeta } : {}),
          pending: true,
          backgroundRunning: true,
          ...planFields,
          cmd: sanitizeSnippet(cmdStr, 64),
          errSig: ""
        }
      ];
    }

    const cmdOutcome = classifyCommandOutcome(
      bareTool,
      isBenignCmd,
      errorText,
      responseText,
      explicitError,
      checkMeta,
      baseIsVerify
    );
    if (cmdOutcome.backgroundRunning) {
      return [];
    }
    const isVerify = cmdOutcome.failedIsVerify !== undefined ? cmdOutcome.failedIsVerify : baseIsVerify;

    return [
      {
        ts: nowMs,
        stepIdx,
        kind: "cmd",
        tool: bareTool,
        failed: cmdOutcome.failed,
        ...planFields,
        ...(hasVerificationEvidence && cmdOutcome.terminal ? { terminal: true } : {}),
        isVerify,
        ...(isBenignCmd ? { isBenignSearchCmd: true } : {}),
        ...(isReadOnlyCmd ? { isReadOnlyCmd: true } : {}),
        ...(checkMeta ? { checkMeta } : {}),
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

function hashUserInput(val) {
  const s = nonEmptyString(val);
  if (!s) return "";
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function deriveTurnSignals(rawText, wsRoots) {
  const cleaned = nonEmptyString(rawText);
  if (!cleaned) return null;
  const prose = extractProseForIntent(cleaned);
  const stripped = cleaned.replace(/```[\s\S]*?```/g, " ");
  const prefs = planPreferences(stripped);
  const directFixIntent = hasDirectFixOrChangeIntent(prose);
  return {
    activeSlash: [...extractActiveSlashCommands(cleaned)],
    leadingSwarm: LEADING_SWARM_SLASH_RE.test(cleaned),
    leadingAutonomy: LEADING_AUTONOMY_SLASH_RE.test(cleaned),
    declinesDelegation: DECLINES_DELEGATION_RE.test(prose),
    debugDiscussion: DEBUG_DISCUSSION_RE.test(prose),
    allowFix: directFixIntent && !/只读|\bread[- ]only\b/i.test(prose),
    directFixIntent,
    explicitNoEdit: NEGATED_EDIT_INTENT_RE.test(prose) || DEFERRED_EDIT_INTENT_RE.test(prose),
    matchesHardTask: DEBUG_ACTION_RE.test(prose) && HARD_DEBUG_TASK_RE.test(prose),
    skipCheck: Boolean(prefs.skipCheck),
    skipReview: Boolean(prefs.skipReview),
    allowTestWeakening: Boolean(allowsTestWeakening(cleaned)),
    requestedCheck: requestedProjectCheck(cleaned, wsRoots)
  };
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

function hasDirectFixOrChangeIntent(intentProse) {
  if (!intentProse) return false;
  if (NEGATED_EDIT_INTENT_RE.test(intentProse) || DEFERRED_EDIT_INTENT_RE.test(intentProse)) {
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
        "[agy-cmd] This approved implementation has one optional independent review. Finish all planned edits yourself and run relevant project checks first (honor any user skip). Before final delivery, call invoke_subagent once with TypeName='cmd-verifier' and Workspace='inherit'. Context isolation is mandatory: Do NOT pass main-session reasoning, self-justifications, summaries, or chat history. Send ONLY: (1) the acceptance criteria, (2) this task's repo-relative paths and diff excerpts, (3) applicable root/nested AGENTS.md or GEMINI.md paths, and (4) actual check commands with raw terminal results (or the concrete reason they could not run)." +
        auditExtra +
        " The reviewer audits correctness/edge counterexamples, API/dependency authenticity and assertion integrity, and traceable terminal evidence, replying with Verdict / Blocking / Missing Evidence. Address blockers and verify the final changes yourself. If unavailable, over quota or unsuccessful, report that the independent review was not completed and finish on the main thread. Do not retry the role or start a second reviewer. Respect later user requests to stop or skip review." })
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
      const surface = detectHostSurface(payload);
      const adjustHintZh =
        surface === "ide" || surface === "cli"
          ? "可通过 `python3 scripts/setup_auto_router.py --auto-retry ...` 随时调节"
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
      ? ` For this approved plan's single TypeName='cmd-verifier' (Workspace='inherit') dispatch, also include these newly flagged test edits for strict assertion-integrity review (do NOT start a second reviewer): ${activeTestWeakening.files.join(", ")} (${detail}). Keep context isolation mandatory — pass ONLY: (1) the acceptance criteria, (2) this task's repo-relative paths and diff excerpts, (3) applicable root/nested AGENTS.md or GEMINI.md paths, and (4) actual check commands with raw terminal results (do NOT pass main-session reasoning, self-justifications, summaries, or chat history).`
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
