import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUBAGENT_ROLE_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|monitor|narrator|swarm[-_]?(?:worker|member))(?:$|[-_\s/])/i;

const SLASH_CMD_RE =
  /(?:^|[\s，。！？、,;!?(\[（`'"「『])\/(boost|goal|plan|teamwork|swarm|run-workflow|grill-me|compact|btw|browser|generative_ui)(?=$|[\s，。！？、,;!?)\]）`'"」』:：])/gi;

export function nonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : "";
}

export function unwrapUserRequestText(raw) {
  const s = nonEmptyString(raw);
  if (!s) return "";
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (m) {
    return nonEmptyString(m[1]);
  }
  return s;
}

export function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

export function parseHookPayload(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    return Array.isArray(raw) ? null : raw;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMaybeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveConversationId(payload = {}, env = process.env) {
  const p = payload && typeof payload === "object" ? payload : {};
  const e = env && typeof env === "object" ? env : {};
  const explicit =
    nonEmptyString(p.conversationId) ||
    nonEmptyString(p.conversation_id) ||
    nonEmptyString(p.sessionId) ||
    nonEmptyString(p.session_id) ||
    nonEmptyString(e.ANTIGRAVITY_CONVERSATION_ID);
  if (explicit) return explicit;

  const pathCandidates = [
    p.transcriptPath,
    p.transcript_path,
    p.metadata?.transcriptPath,
    p.metadata?.transcript_path,
    p.artifactDirectoryPath,
    p.artifact_directory_path,
    p.metadata?.artifactDirectoryPath,
    p.metadata?.artifact_directory_path
  ];
  for (const rawPath of pathCandidates) {
    const cleaned = nonEmptyString(rawPath);
    if (!cleaned) continue;
    let normalized = path.resolve(cleaned);
    if (process.platform === "win32") {
      normalized = normalized.toLowerCase();
    }
    const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
    return `tx_${digest}`;
  }
  return "";
}

export function sanitizeConversationId(convId) {
  const raw = nonEmptyString(convId);
  if (!raw) return "";
  if (
    raw.length <= 96 &&
    raw !== "." &&
    raw !== ".." &&
    !raw.startsWith(".") &&
    !raw.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(raw)
  ) {
    return raw;
  }
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `h_${digest}`;
}

export function resolveStateDir(env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  const custom = nonEmptyString(e.AGY_CMD_STATE_DIR);
  if (custom) return path.resolve(custom);
  const pluginData = nonEmptyString(e.PLUGIN_DATA);
  if (pluginData) {
    const resolved = path.resolve(pluginData);
    if (
      path.basename(path.dirname(resolved)).toLowerCase() === "plugin_data" &&
      path.basename(resolved).toLowerCase() !== "agy-cmd"
    ) {
      return path.join(path.dirname(resolved), "agy-cmd");
    }
    return resolved;
  }
  const geminiHome = nonEmptyString(e.GEMINI_HOME);
  if (geminiHome) {
    const resolved = path.resolve(geminiHome);
    const geminiRoot =
      path.basename(resolved).toLowerCase() === ".gemini" ? resolved : path.join(resolved, ".gemini");
    return path.join(geminiRoot, "antigravity", "plugin_data", "agy-cmd");
  }
  try {
    const home = os.homedir();
    if (home) {
      return path.join(home, ".gemini", "antigravity", "plugin_data", "agy-cmd");
    }
  } catch {}
  return path.join(os.tmpdir(), "agy-cmd-state");
}

const VALID_HOST_SURFACES = new Set(["app", "ide", "cli"]);

const RESUME_NORMAL_SESSION_ZH_RE =
  /(?:恢复(?:普通|正常)(?:会话|模式|护栏)|退出\s*(?:\/?swarm|协作模式|协调器模式)|结束\s*(?:\/?swarm|协作模式|协调器模式)|关闭\s*(?:\/?swarm|协作模式)\s*豁免)/i;
const RESUME_NORMAL_SESSION_EN_RE =
  /\b(?:resume\s+normal\s+(?:session|mode|guardrails?)|(?:exit|end|leave)\s+\/?swarm(?:\s+(?:session|mode))?)\b/i;
const RESUME_NEGATION_RE =
  /(?:别|不要|不用|不必|勿|请勿|暂不|先不|不(?:想|要))(?:\s*(?:现在|立刻|马上))?\s*$|(?:\b(?:do\s+not|don['’]t|never|avoid|not)\s+(?:want\s+to\s+)?)$/i;
const RESUME_INQUIRY_RE =
  /^(?:请问|什么是|(?:请|帮我)?(?:解释|介绍|说明)|如何|怎么|为什么|(?:what\s+is|how\s+(?:do|can|to)|explain)\b)|(?:是什么意思|什么意思)/i;
const BARE_RESUME_NORMAL_RE =
  /^(?:(?:请|帮我|麻烦|现在|直接|先|立即|马上|please|now)\s*)*(?:恢复(?:普通|正常)(?:会话|模式|护栏)|退出\s*(?:\/?swarm|协作模式|协调器模式)|结束\s*(?:\/?swarm|协作模式|协调器模式)|关闭\s*(?:\/?swarm|协作模式)\s*豁免|resume\s+normal\s+(?:session|mode|guardrails?)|(?:exit|end|leave)\s+\/?swarm(?:\s+(?:session|mode))?)(?:\s*(?:吧|一下|了))?[。.!！\s]*$/i;

export function isResumeNormalSessionRequest(rawText) {
  const s = nonEmptyString(rawText);
  if (!s) return false;
  const stripped = s.replace(/```[\s\S]*?```/g, " ");
  for (const rawClause of stripped.split(/[。.!！?？;\n,，]+/)) {
    const clause = rawClause.trim();
    if (!clause || RESUME_INQUIRY_RE.test(clause)) continue;
    const match = RESUME_NORMAL_SESSION_ZH_RE.exec(clause) || RESUME_NORMAL_SESSION_EN_RE.exec(clause);
    if (!match) continue;
    const prefix = clause.slice(0, match.index);
    if (RESUME_NEGATION_RE.test(prefix)) continue;
    return true;
  }
  return false;
}

export function isBareResumeNormalSessionRequest(rawText) {
  const s = nonEmptyString(rawText);
  if (!s) return false;
  const stripped = s.replace(/```[\s\S]*?```/g, " ").trim();
  return BARE_RESUME_NORMAL_RE.test(stripped);
}

export function detectHostSurface(payload = {}) {
  const p = parseHookPayload(payload);
  if (!p) return "unknown";
  const explicitCandidates = [
    p.hostSurface,
    p.host_surface,
    p.surface,
    p.metadata?.hostSurface,
    p.metadata?.host_surface,
    p.metadata?.surface
  ];
  for (const raw of explicitCandidates) {
    const norm = nonEmptyString(raw).toLowerCase();
    if (VALID_HOST_SURFACES.has(norm)) return norm;
  }
  const candidates = [
    p.transcriptPath,
    p.transcript_path,
    p.artifactDirectoryPath,
    p.artifact_directory_path
  ];
  for (const raw of candidates) {
    const s = nonEmptyString(raw);
    if (!s) continue;
    const norm = s.replace(/\\/g, "/").toLowerCase();
    if (/\/\.gemini\/antigravity-ide(?:\/|$)/.test(norm)) return "ide";
    if (/\/\.gemini\/antigravity-cli(?:\/|$)/.test(norm)) return "cli";
    if (/\/\.gemini\/antigravity(?:\/|$)/.test(norm)) return "app";
  }
  return "unknown";
}

function normalizeSlashList(val) {
  if (!Array.isArray(val)) return null;
  const out = new Set();
  for (const item of val) {
    const raw = typeof item === "string" ? item : item?.name ?? item?.command;
    const norm = nonEmptyString(raw).replace(/^\/+/, "").toLowerCase();
    if (norm) out.add(norm);
  }
  return out;
}

/**
 * Inspect structured host capability / available slash command fields if provided
 * in the hook payload. Returns "available", "unavailable", or "unknown".
 */
export function resolveHostSlashCapability(payload = {}, commandName = "") {
  const cmd = nonEmptyString(commandName).replace(/^\/+/, "").toLowerCase();
  if (!cmd) return "unknown";
  const p = parseHookPayload(payload);
  if (!p) return "unknown";

  const containers = [p, p.metadata, p.capabilities, p.metadata?.capabilities].filter(
    (c) => c && typeof c === "object" && !Array.isArray(c)
  );

  for (const c of containers) {
    for (const key of ["disabledSlashCommands", "disabled_slash_commands", "disabledCommands", "disabled_commands"]) {
      const list = normalizeSlashList(c[key]);
      if (list && list.has(cmd)) return "unavailable";
    }
  }

  const capMaps = [
    p.capabilities,
    p.slashCapabilities,
    p.slash_capabilities,
    p.capabilities?.slashCommands,
    p.capabilities?.commands,
    p.metadata?.capabilities,
    p.metadata?.slashCapabilities,
    p.metadata?.slash_capabilities,
    p.metadata?.capabilities?.slashCommands,
    p.metadata?.capabilities?.commands
  ].filter((m) => m && typeof m === "object" && !Array.isArray(m));

  for (const m of capMaps) {
    const val = Object.prototype.hasOwnProperty.call(m, cmd)
      ? m[cmd]
      : Object.prototype.hasOwnProperty.call(m, `/${cmd}`)
        ? m[`/${cmd}`]
        : undefined;
    if (val === true) return "available";
    if (val === false) return "unavailable";
  }

  for (const c of containers) {
    for (const key of [
      "availableSlashCommands",
      "available_slash_commands",
      "slashCommands",
      "slash_commands",
      "availableCommands",
      "available_commands"
    ]) {
      const list = normalizeSlashList(c[key]);
      if (list !== null) {
        return list.has(cmd) ? "available" : "unavailable";
      }
    }
  }

  return "unknown";
}

export function isUiOnlyMode(env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  const flag = nonEmptyString(e.AGY_CMD_UI_ONLY).toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function isSubagentPayload(payload, env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  if (nonEmptyString(e.ANTIGRAVITY_PARENT_CONVERSATION_ID)) return true;
  const envSub = nonEmptyString(e.ANTIGRAVITY_SUBAGENT).toLowerCase();
  if (envSub === "1" || envSub === "true") return true;
  const envSwarmWorker = nonEmptyString(e.ANTIGRAVITY_SWARM_WORKER).toLowerCase();
  if (envSwarmWorker === "1" || envSwarmWorker === "true") return true;

  const p = parseHookPayload(payload);
  if (!p) return false;

  if (
    p.subagent === true ||
    p.isSubagent === true ||
    p.is_subagent === true ||
    p.swarmWorker === true ||
    p.swarm_worker === true
  ) {
    return true;
  }
  if (
    nonEmptyString(p.subagentId) ||
    nonEmptyString(p.subagent_id) ||
    nonEmptyString(p.parentConversationId) ||
    nonEmptyString(p.parent_conversation_id) ||
    nonEmptyString(p.parentSessionId) ||
    nonEmptyString(p.parent_session_id)
  ) {
    return true;
  }

  if (p.metadata && typeof p.metadata === "object") {
    if (
      p.metadata.subagent === true ||
      p.metadata.isSubagent === true ||
      p.metadata.is_subagent === true ||
      p.metadata.swarmWorker === true ||
      p.metadata.swarm_worker === true ||
      nonEmptyString(p.metadata.subagentId) ||
      nonEmptyString(p.metadata.subagent_id) ||
      nonEmptyString(p.metadata.parentConversationId) ||
      nonEmptyString(p.metadata.parent_conversation_id) ||
      nonEmptyString(p.metadata.parentSessionId) ||
      nonEmptyString(p.metadata.parent_session_id)
    ) {
      return true;
    }
  }

  const rootId =
    nonEmptyString(p.rootConversationId) ||
    nonEmptyString(p.root_conversation_id) ||
    nonEmptyString(p.metadata?.rootConversationId) ||
    nonEmptyString(p.metadata?.root_conversation_id);
  const convId =
    nonEmptyString(p.conversationId) ||
    nonEmptyString(p.conversation_id) ||
    nonEmptyString(p.sessionId) ||
    nonEmptyString(p.session_id);
  if (rootId && convId && rootId !== convId) {
    return true;
  }

  const roles = [
    p.role,
    p.agentRole,
    p.agent_role,
    p.agentType,
    p.agent_type,
    p.sessionType,
    p.session_type,
    p.metadata?.role,
    p.metadata?.agentRole,
    p.metadata?.agent_role
  ];
  for (const r of roles) {
    const text = nonEmptyString(r);
    if (text && SUBAGENT_ROLE_RE.test(text)) {
      return true;
    }
  }

  return false;
}

export function extractActiveSlashCommands(text) {
  const found = new Set();
  if (typeof text !== "string" || !text.trim()) return found;
  SLASH_CMD_RE.lastIndex = 0;
  let m;
  while ((m = SLASH_CMD_RE.exec(text)) !== null) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return found;
}

export function redactBasicSecrets(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)(?:["'][^"']+["']|\S+)/gi, "$1[REDACTED]");
}

export function sanitizeSnippet(text, maxLen = 40) {
  if (typeof text !== "string" || !text.trim()) return "";
  const cleaned = redactBasicSecrets(text)
    .replace(/[`\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, Math.max(8, maxLen - 1)).trimEnd() + "…";
}

export function shortFileLabel(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return "";
  let p = rawPath.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/#L\d+(-L\d+)?$/i, "");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {}
  }
  p = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    return tail.length <= 42 ? tail : parts[parts.length - 1].slice(0, 42);
  }
  return parts[0] ? parts[0].slice(0, 42) : "";
}

export function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

export function isDirectRun(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return isSameFilePath(argv1, fileURLToPath(metaUrl));
}
