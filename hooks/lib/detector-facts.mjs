/**
 * Layer 1 (Facts): Extract structured host facts, intent signals, tool outcomes,
 * and Swarm/Plan-Mode state indicators from raw hook payloads and transcripts.
 */
import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  extractActiveSlashCommands,
  nonEmptyString,
  parseMaybeJson,
  sanitizeSnippet,
  shortFileLabel,
  unwrapUserRequestText
} from "./common.mjs";
import { isPlanApprovalNotice, stripTranscriptStepHeaders } from "./transcript.mjs";
import {
  allowsTestWeakening,
  applyEditReceipt,
  deliveryGateToolEvidence,
  detectTestAssertionWeakeningDetails,
  filterTestWeakeningByAppliedFiles,
  matchesCustomCheckCommand,
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

export {
  BG_RUNNING_RE,
  classifyCommandOutcome,
  classifyEditOutcome,
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
  UNATTENDED_GOAL_RE
};
