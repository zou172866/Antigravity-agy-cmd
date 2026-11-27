import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactBasicSecrets } from "./common.mjs";

// Only project-wide commands with unambiguous scope are recognized. Shell chains,
// file filters, --prefix, workspaces and free-form command output are not evidence.
const NODE_TEST = /^(?:npm(?:\.cmd|\.exe)? (?:t|test|run test)|(?:pnpm|yarn|bun)(?:\.cmd|\.exe)? (?:run )?test)$/i;
const PROJECT_CHECK = /^(?:go test \.\/\.\.\.|cargo test|(?:python3?|py) -m (?:pytest|unittest discover)|pytest|node --test)$/i;
const STATIC_PROJECT_CHECK = /^(?:(?:npx(?:\.cmd|\.exe)?\s+)?tsc(?:\.cmd|\.exe)?\s+--noEmit|go(?:\.exe)?\s+vet\s+\.\/\.\.\.|cargo(?:\.exe)?\s+(?:check|clippy)|(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+run\s+(?:typecheck|lint|build|check|verify)|(?:pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:typecheck|lint|build|check|verify))$/i;
const PYTHON_FULL_TEST = /^(?:(?:(?:python3?|py)(?:\.exe)?\s+(?:-B\s+)?-m\s+(?:pytest|unittest(?:\s+discover)?))|(?:uv\s+run\s+pytest)|pytest(?:\.exe)?)(?:\s+(?:-q|--quiet|-v|-vv|--verbose|--tb=(?:short|line|no)|-r[a-zA-Z]+))*$/i;
const GO_FULL_TEST = /^go(?:\.exe)?\s+test(?:\s+(?:-v|-race|-count=1|-short))*\s+\.\/\.\.\.(?:\s+(?:-v|-race|-count=1|-short))*$/i;
const RUST_FULL_TEST = /^cargo(?:\.exe)?\s+test(?:\s+(?:--workspace|--all-targets|--all-features|--quiet|-q|--verbose|-v))*$/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|c(?:pp|xx)?|h(?:pp)?|rb|php|swift|dart|sh|ps1)$/i;
const EXAMPLE = /(?:^|[\\/])(?:examples?|templates?|fixtures?|node_modules|vendor|dist|build|\.git)(?:[\\/]|$)|(?:\.example|\.sample|\.template)\./i;
const RUNTIME_CONFIG = /(?:^|[\\/])(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i;
const SKIP_CHECK = /(?:跳过|不用|不要|别|不必|无需|免)(?:再|运行|跑|执行|做|进行|补跑|补)?(?:任何|相关|这些|自动)?(?:测试|验证|检查)|(?:skip|without|do not run|don.t run|no)\s+(?:(?:the|any|running|automated)\s+)*(?:tests?|verification|checks?)\b/i;
const SKIP_REVIEW = /(?:跳过|不用|不要|别|不必|无需)(?:再|调用|安排|启动|做|进行)?(?:独立|额外|子智能体|只读)?(?:复核|审查|审阅|子智能体)|(?:skip|without|no)\s+(?:(?:the|independent|extra)\s+)*(?:review|subagents?)\b/i;
const LEADING_CD_CMD_RE = /^(?:(?:cd\s+(?:\/d\s+)?|pushd\s+|Set-Location\s+)(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*)+/i;
const CD_SEGMENT_RE = /^(?:cd(?:\s+\/d)?|pushd|Set-Location(?:\s+-Path)?)\s+(.+)$/i;
const PURE_COMMENT_LINE_RE = /^\s*(?:$|\/\/|\/\*|\*\/|\*(?:\s|$)|<!--|-->|'''|"""|#(?!\[|(?:include|define|ifdef|ifndef|endif|pragma|else|elif|undef)\b|[A-Za-z_$][\w$]*\s*(?:[=;(])))/;
const MAX_CUSTOM_SEGMENTS = 8;
const MAX_CUSTOM_RECEIPTS = 32;

export function pathKey(p) {
  if (typeof p !== "string" || !p) return "";
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function deliveryEventOrder(ev, idx = 0) {
  if (Number.isSafeInteger(ev?.stepIdx) && ev.stepIdx >= 0) return ev.stepIdx;
  const ts = Number(ev?.ts);
  if (Number.isFinite(ts) && ts > 0) return Math.floor(ts) * 1000 + Math.min(999, Math.max(0, idx));
  return idx;
}

export function planPreferences(text) {
  const normalized = String(text || "").replace(
    /(?:别|不要|请勿|不应|不可|不能|不许)\s*(?:跳过|省略)|\b(?:do\s+not|don['’]t|never|must\s+not)\s+(?:skip|omit)\b/gi, "执行"
  );
  return { skipCheck: SKIP_CHECK.test(normalized), skipReview: SKIP_REVIEW.test(normalized) };
}

function decoded(value) {
  if (typeof value === "string" && /^\s*["\[{]/.test(value)) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function sourceText(value) {
  if (typeof value === "string" && value.startsWith('"')) {
    const unquoted = decoded(value);
    if (typeof unquoted === "string") return unquoted;
  }
  return value;
}

function inside(root, target) {
  const rel = path.relative(pathKey(root), pathKey(target));
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
}

function location(raw, cwd) {
  raw = decoded(raw);
  if (typeof raw !== "string" || !raw.trim() || /[\x00-\x1f]/.test(raw)) return "";
  let value = raw.trim().replace(/^(['"])([\s\S]+)\1$/, "$2");
  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      return "";
    }
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, value) : "";
}

// Compare only the changed lines. This avoids treating unchanged context around
// a comment replacement as executable code. With no usable before/after or
// explicit create payload there is insufficient evidence to enforce a check.
function changesCode(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let first = 0, lastOld = oldLines.length, lastNew = newLines.length;
  while (first < lastOld && first < lastNew && oldLines[first] === newLines[first]) first++;
  while (lastOld > first && lastNew > first && oldLines[lastOld - 1] === newLines[lastNew - 1]) {
    lastOld--; lastNew--;
  }
  const changed = [...oldLines.slice(first, lastOld), ...newLines.slice(first, lastNew)];
  // Omit comment-bearing edits conservatively, including trailing comments and
  // block/docstring boundaries. Unknown mixed prose should not interrupt Stop.
  return changed.some(line => /(?:[=;{}()[\]]|^\s*"[^"]+"\s*:|\b(?:return|import|export|def|function|class|const|let|var|package|func)\s+\S)/.test(line)) &&
    changed.every(line => !/(?:\/\/|\/\*|\*\/|#|<!--|-->|'''|"""|^\s*\*)/.test(line));
}

function changesCodeForDelivery(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let first = 0, lastOld = oldLines.length, lastNew = newLines.length;
  while (first < lastOld && first < lastNew && oldLines[first] === newLines[first]) first++;
  while (lastOld > first && lastNew > first && oldLines[lastOld - 1] === newLines[lastNew - 1]) {
    lastOld--; lastNew--;
  }
  const changed = [...oldLines.slice(first, lastOld), ...newLines.slice(first, lastNew)];
  const codeLines = changed.filter(line => !PURE_COMMENT_LINE_RE.test(line));
  return codeLines.some(line => /(?:[=;{}()[\]]|^\s*"[^"]+"\s*:|\b(?:return|import|export|def|function|class|const|let|var|package|func)\s+\S)/.test(line));
}

function codePaths(tool, args, allowConfig, { delivery = false } = {}) {
  const target = args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath;
  const edits = tool === "apply_edits" ? decoded(args.edits) :
    decoded(args.ReplacementChunks ?? args.replacementChunks ?? [args]);
  if (!Array.isArray(edits)) return [];
  const checkHunk = delivery ? changesCodeForDelivery : changesCode;
  const result = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const file = decoded(tool === "apply_edits" ? edit.path : target);
    if (typeof file !== "string" || !(SOURCE.test(file) || (allowConfig && RUNTIME_CONFIG.test(file))) || EXAMPLE.test(file)) continue;
    const hunks = decoded(edit.hunks) ?? [edit];
    const changed = Array.isArray(hunks) && hunks.some(h => h && checkHunk(
      sourceText(h.target ?? h.Target ?? h.TargetContent ?? h.old_text ?? h.oldText ?? h.find),
      sourceText(h.replacement ?? h.Replacement ?? h.ReplacementContent ?? h.new_text ?? h.newText ?? h.replace)
    ));
    const nativeWrite = tool === "write_file" || tool === "write_to_file";
    const create = nativeWrite ? sourceText(args.CodeContent ?? args.Content ?? args.content) : edit.create;
    const overwrite = decoded(nativeWrite ? args.Overwrite ?? args.overwrite : edit.overwrite);
    const wroteCode = typeof create === "string" && create.split(/\r?\n/).some(line => checkHunk("", line));
    if (changed || wroteCode) {
      // The desktop can say "Created file." even for a whole-file overwrite.
      // This proves a source write for opt-in review, but without a before-image
      // only an explicit create or a substantive hunk can force verification.
      result.push({ file, canRequireCheck: changed || (nativeWrite ? overwrite === false : overwrite !== true) });
    }
  }
  return result;
}

// Walk ancestors of this edit only, stopping at its workspace or nearest package
// boundary. The Hook never executes project code and does no repository scan.
function projectFor(dir, root, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let found = null;
  for (let current = dir; inside(root, current); current = path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      found = { scope: current, command: "" };
      try {
        const st = fs.lstatSync(manifest);
        if (st.isFile() && st.size <= 256 * 1024) {
          const json = JSON.parse(fs.readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));
          const script = json.scripts?.test;
          if (typeof script === "string" && script.trim() && !/^(?:echo\b|exit\b|true\b)/i.test(script.trim())) {
            const pm = /^(pnpm|yarn|bun)@/.exec(json.packageManager)?.[1] ?? "npm";
            found.command = pm + " test";
          }
        }
      } catch {}
      break;
    }
    if (["go.mod", "Cargo.toml", "pyproject.toml", "setup.cfg"].some(f => fs.existsSync(path.join(current, f)))) {
      found = { scope: current, command: "" };
      break;
    }
    if (current === root || path.dirname(current) === current) break;
  }
  cache.set(dir, found);
  return found;
}

function normalizeSingleCheckCommand(cmd) {
  const normalized = String(cmd || "").trim().replace(/[ \t]+/g, " ");
  if (!normalized) return "";
  if (NODE_TEST.test(normalized)) return "npm test";
  if (PROJECT_CHECK.test(normalized)) return normalized;
  if (!STATIC_PROJECT_CHECK.test(normalized)) return "";
  if (/^(?:npx(?:\.cmd|\.exe)?\s+)?tsc(?:\.cmd|\.exe)?\s+--noEmit$/i.test(normalized)) return "tsc --noEmit";
  if (/^go(?:\.exe)?\s+vet\s+\.\/\.\.\.$/i.test(normalized)) return "go vet ./...";
  const cargoMatch = /^cargo(?:\.exe)?\s+(check|clippy)$/i.exec(normalized);
  if (cargoMatch) return `cargo ${cargoMatch[1].toLowerCase()}`;
  const scriptMatch = /^(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?(typecheck|lint|build|check|verify)$/i.exec(normalized);
  if (scriptMatch) return `npm run ${scriptMatch[1].toLowerCase()}`;
  return "";
}

function checkCommand(cmd) {
  cmd = decoded(cmd);
  if (typeof cmd !== "string") return "";
  const normalized = cmd.trim().replace(/[ \t]+/g, " ");
  const single = normalizeSingleCheckCommand(normalized);
  if (single) return single;
  const parts = splitStrictAndChain(normalized);
  if (!parts || parts.length < 2 || parts.length > 4) return "";
  const normParts = [];
  for (const part of parts) {
    if (parseCdTarget(part) !== null) return "";
    const norm = normalizeSingleCheckCommand(stripTrailingStderrRedirect(part));
    if (!norm) return "";
    normParts.push(norm);
  }
  return normParts.join(" && ");
}

// An explicitly named project-wide check in the user's request or the host's
// approved plan can apply to the one known workspace root. Never execute or
// re-inject arbitrary text from the plan.
export function requestedProjectCheck(text, roots) {
  if (!Array.isArray(roots) || roots.length !== 1 || !location(roots[0])) return null;
  const matches = String(text || "").matchAll(/(?:`([^\r\n`]{1,64})`|(?:验证|测试命令|验收命令|运行|run|verify with|validation)\s*[:：]?\s*([^\n。，；;`]{1,64}))/gi);
  const cmds = [...new Set([...matches].map(m => (m[1] ?? m[2]).trim().replace(/[.!]$/, "").replace(/[ \t]+/g, " ")).filter(checkCommand))];
  return cmds.length === 1 ? { scope: location(roots[0]), command: cmds[0] } : null;
}

// Bind scope at dispatch time (background checks may finish after later edits).
// Keep no source snippets or arbitrarily user-supplied shell strings on disk.
export function planToolEvidence(plan, tool, args, payload, command) {
  const roots = decoded(payload.workspacePaths ?? payload.workspace_paths ?? []);
  if (!Array.isArray(roots) || !plan?.key) return null;
  const workspace = roots.map(r => location(r)).filter(Boolean);
  if (!workspace.length) return null;
  const hostCwd = location(payload.cwd);
  const fallbackCwd = hostCwd || workspace[0] || "";
  const cwd = location(args.Cwd ?? args.cwd ?? fallbackCwd, fallbackCwd);
  const findRoot = f => workspace.filter(r => inside(r, f)).sort((a,b) => b.length-a.length)[0];
  const packages = new Map();
  let wroteSource = false;
  const edited = new Map();
  for (const edit of codePaths(tool, args, Boolean(plan.requested))) {
    const file = location(edit.file, cwd);
    const root = file && findRoot(file);
    if (!root || EXAMPLE.test(path.relative(root, file))) continue;
    const detected = projectFor(path.dirname(file), root, packages);
    const requested = plan.requested && plan.requested.scope === (detected?.scope ?? root) ? plan.requested : null;
    if (RUNTIME_CONFIG.test(file) && !requested) continue;
    wroteSource = true;
    const pkg = requested ?? detected;
    if (pkg && edit.canRequireCheck) edited.set(pkg.scope, pkg);
  }

  let commands = [];
  let runDir = cwd;
  if (tool === "run_command") commands = [command];
  const items = decoded(args.commands);
  if (tool === "run_checks" && Array.isArray(items)) {
    // Each item can override the cwd. Only a single, unambiguous aggregate
    // check can supply this receipt.
    if (items.length === 1) {
      const item = items[0];
      commands = [typeof item === "string" ? item : item?.command];
      if (item?.cwd) runDir = location(item.cwd, cwd);
    }
  }
  if (tool === "apply_edits" && args.verify) {
    commands = [typeof args.verify === "string" ? args.verify : args.verify.command];
    if (args.verify.cwd) runDir = location(args.verify.cwd, cwd);
  }
  const check = checkCommand(commands[0]);
  const checkRoot = check && runDir && findRoot(runDir);
  const pkg = checkRoot && (projectFor(runDir, checkRoot, packages) ??
    (runDir === plan.requested?.scope ? plan.requested : null));
  const checked = pkg && pkg.scope === runDir ? { scope: pkg.scope, command: check } : null;
  return wroteSource || checked ? { key: plan.key, wroteSource, edited: [...edited.values()], checked } : null;
}

// Store one edit watermark and the most recent terminal result per package.
// Replay is idempotent, including after the JSONL tail has been compacted.
export function advancePlan(plan, events) {
  if (!plan) return plan;
  const next = { ...plan, scopes: { ...plan.scopes } };
  for (const ev of events) {
    const data = ev.planEvidence;
    if (data?.key !== plan.key || ev.pending || ev.backgroundRunning) continue;
    const step = Number.isSafeInteger(ev.stepIdx) && ev.stepIdx >= 0 ? ev.stepIdx : null;
    if (step === null) continue;
    if (ev.kind === "edit" && ev.applied && !ev.failed && !ev.hasArtifactMeta && !ev.looksLikePlanPath && data.wroteSource) {
      next.wroteSource = true;
      for (const ed of data.edited) {
        const scope = { ...next.scopes[ed.scope] };
        if (scope.editStep === undefined || step >= scope.editStep) {
          scope.editStep = step;
          scope.declared = ed.command;
          next.scopes[ed.scope] = scope;
        }
      }
    }
    if (ev.kind === "cmd" && ev.terminal && data.checked) {
      const { scope: dir, command } = data.checked;
      const scope = { ...next.scopes[dir] };
      // Project-wide npm test from multiple managers has one semantic key.
      const receipt = scope.checks?.[command];
      if (!receipt || step >= receipt.step) {
        scope.checks = { ...scope.checks, [command]: { step, passed: !ev.failed, known: !ev.failed || receipt?.known === true } };
        next.scopes[dir] = scope;
      }
    }
  }
  return JSON.stringify(next) === JSON.stringify(plan) ? plan : next;
}

export function pendingPlanChecks(plan) {
  const pending = [];
  for (const [dir, scope] of Object.entries(plan?.scopes ?? {})) {
    if (scope.editStep === undefined) continue;
    const receipts = scope.checks ?? {};
    const command = scope.declared || Object.keys(receipts).find(cmd => receipts[cmd].known);
    if (!command) continue;
    const receipt = receipts[checkCommand(command)];
    if (receipt && receipt.step >= scope.editStep) {
      if (!receipt.passed) pending.push({ dir, command, failed: true });
      continue;
    }
    pending.push({ dir, command, failed: false });
  }
  return pending;
}

// ============================================================================
// Delivery Test Gate (opt-in, all tiers, all substantive source-edit turns)
// ============================================================================

function readSmallText(filePath, maxBytes = 256 * 1024) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return "";
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function hasTestsDir(dir) {
  return ["tests", "test"].some(name => {
    try {
      return fs.statSync(path.join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function hasGoTestFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(e => e.isFile() && /_test\.go$/i.test(e.name));
  } catch {
    return false;
  }
}

function stripLeadingCdAndRedirect(cmd) {
  if (typeof cmd !== "string") return "";
  return cmd
    .trim()
    .replace(LEADING_CD_CMD_RE, "")
    .replace(/\s+2>&1\s*$/, "")
    .trim();
}

function stripTrailingStderrRedirect(cmd) {
  if (typeof cmd !== "string") return "";
  return cmd.trim().replace(/\s+2>&1\s*$/, "").trim();
}

/**
 * Safely split a shell command string on `&&` (and `;` ONLY immediately after a
 * `cd`/`pushd`/`Set-Location` segment), while rejecting unquoted operators that
 * can mask a test failure (`||`, `|`, non-cd `;`, standalone `&`, backticks, `$(`).
 * Returns `null` if any masking operator is detected.
 */
function splitStrictAndChain(rawCmd) {
  if (typeof rawCmd !== "string" || !rawCmd.trim()) return [];
  const s = rawCmd.trim();
  const parts = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && (quote === "'" || s[i - 1] !== "\\")) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && s[i + 1] === "(")) {
      return null;
    }
    if (ch === "|") {
      // Both `||` and pipe `|` can mask non-zero exit codes
      return null;
    }
    if (ch === ";") {
      const seg = cur.trim();
      if (!seg || !CD_SEGMENT_RE.test(seg)) return null;
      parts.push(seg);
      cur = "";
      if (parts.length >= MAX_CUSTOM_SEGMENTS + 4) return null;
      continue;
    }
    if (ch === "&") {
      if (s[i + 1] === "&") {
        const seg = cur.trim();
        if (seg) parts.push(seg);
        cur = "";
        i++;
        if (parts.length >= MAX_CUSTOM_SEGMENTS + 4) return null;
        continue;
      }
      // Allow fd redirection like `2>&1` or `>&2`, reject background `&`
      if (s[i - 1] === ">" || s[i + 1] === ">") {
        cur += ch;
        continue;
      }
      return null;
    }
    cur += ch;
  }
  if (quote) return null;
  const tail = cur.trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseCdTarget(segment) {
  const m = CD_SEGMENT_RE.exec(segment.trim());
  if (!m) return null;
  const rawTarget = m[1].trim();
  if (!rawTarget || rawTarget === "-" || /[$%`*?<>|;]/.test(rawTarget)) return undefined;
  return rawTarget.replace(/^(['"])([\s\S]+)\1$/, "$2").trim();
}

export function splitChainedCommands(rawCmd) {
  const parts = splitStrictAndChain(rawCmd);
  if (!parts) return [];
  const out = [];
  for (const part of parts) {
    const cdTarget = parseCdTarget(part);
    if (cdTarget === undefined) return [];
    if (cdTarget !== null) continue;
    const cleaned = stripTrailingStderrRedirect(part);
    if (cleaned) out.push(cleaned);
    if (out.length >= MAX_CUSTOM_SEGMENTS) break;
  }
  return out;
}

/**
 * Walk `&&` (and cd `;`) segments sequentially, resolving `cd`/`pushd`/`Set-Location`
 * into each executable segment's true `runDir` so neither leading nor mid-chain `cd`
 * can misattribute a check to the wrong package.
 */
function resolveExecutedSegments(rawCmd, initialDir) {
  const parts = splitStrictAndChain(rawCmd);
  if (!parts || !parts.length) return [];
  let curDir = initialDir;
  const resolved = [];
  for (const part of parts) {
    const cdTarget = parseCdTarget(part);
    if (cdTarget === undefined) return [];
    if (cdTarget !== null) {
      const nextDir = location(cdTarget, curDir);
      if (!nextDir) return [];
      curDir = nextDir;
      continue;
    }
    const cleanSeg = stripTrailingStderrRedirect(part);
    if (!cleanSeg) continue;
    resolved.push({ raw: cleanSeg, runDir: curDir });
    if (resolved.length >= MAX_CUSTOM_SEGMENTS) break;
  }
  return resolved;
}

export function normalizeCustomSegment(segment) {
  const cleaned = stripLeadingCdAndRedirect(segment).replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return "";
  let norm = cleaned
    .replace(/^(npm|pnpm|yarn|bun|npx|pytest|go|cargo|node)(?:\.cmd|\.exe)?(?=\s|$)/i, (_, bin) => bin.toLowerCase())
    .replace(/^(?:python3?|py)(?:\.exe)?(?=\s|$)/i, "python");
  if (/^npm (?:t|run test)$/i.test(norm)) norm = "npm test";
  else if (/^(pnpm|yarn|bun) run test$/i.test(norm)) norm = norm.replace(/ run test$/i, " test");
  return redactBasicSecrets(norm).slice(0, 240);
}

export function parseCustomCheckSpec(customCommand) {
  if (typeof customCommand !== "string" || !customCommand.trim()) return null;
  const cleaned = customCommand.trim().replace(/[ \t]+/g, " ");
  const parts = splitStrictAndChain(cleaned);
  if (!parts || !parts.length) return null;
  let curSubDir = "";
  const seen = new Set();
  const segments = [];
  for (const part of parts) {
    const cdTarget = parseCdTarget(part);
    if (cdTarget === undefined) return null;
    if (cdTarget !== null) {
      curSubDir = curSubDir && !path.isAbsolute(cdTarget) ? path.join(curSubDir, cdTarget) : cdTarget;
      continue;
    }
    const rawSeg = stripTrailingStderrRedirect(part);
    const key = normalizeCustomSegment(rawSeg);
    const dedupKey = `${pathKey(curSubDir)}\0${key}`;
    if (!key || seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    segments.push({ raw: curSubDir ? `cd ${curSubDir} && ${rawSeg}` : rawSeg, key, subDir: curSubDir });
    if (segments.length >= MAX_CUSTOM_SEGMENTS) break;
  }
  if (!segments.length) return null;
  return {
    raw: cleaned,
    fullKey: segments.map(s => s.key).join(" && "),
    segments
  };
}

export function autoCheckCanonicalKey(cmd) {
  const cleaned = stripTrailingStderrRedirect(decoded(cmd)).replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return "";
  if (NODE_TEST.test(cleaned)) return "node:test";
  if (PYTHON_FULL_TEST.test(cleaned)) return "python:test";
  if (GO_FULL_TEST.test(cleaned)) return "go:test";
  if (RUST_FULL_TEST.test(cleaned)) return "rust:test";
  if (/^node(?:\.exe)? --test$/i.test(cleaned)) return "node:--test";
  const staticNorm = STATIC_PROJECT_CHECK.test(cleaned) ? normalizeSingleCheckCommand(cleaned) : "";
  if (staticNorm) return `static:${staticNorm}`;
  return "";
}

function detectNodePackageManager(dir, json) {
  const fromField = /^(pnpm|yarn|bun)@/.exec(json?.packageManager)?.[1];
  if (fromField) return fromField;
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}

function familyForEditedFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  if (/\.py$/i.test(filePath)) return "python";
  if (/\.go$/i.test(filePath)) return "go";
  if (/\.rs$/i.test(filePath)) return "rust";
  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filePath)) return "node";
  return "";
}

function inspectManifestsInDir(current, fileDir, root) {
  const candidates = [];

  const pkgPath = path.join(current, "package.json");
  if (fs.existsSync(pkgPath)) {
    let command = "";
    try {
      const text = readSmallText(pkgPath);
      if (text) {
        const json = JSON.parse(text);
        const script = json.scripts?.test;
        if (typeof script === "string" && script.trim() && !/^(?:echo\b|exit\b|true\b)/i.test(script.trim())) {
          command = `${detectNodePackageManager(current, json)} test`;
        }
      }
    } catch {}
    candidates.push({ scope: current, root, command, family: "node" });
  }

  const pytestIni = path.join(current, "pytest.ini");
  const pyproject = path.join(current, "pyproject.toml");
  const setupCfg = path.join(current, "setup.cfg");
  if (fs.existsSync(pytestIni)) {
    candidates.push({ scope: current, root, command: "pytest", family: "python" });
  } else if (fs.existsSync(pyproject)) {
    const text = readSmallText(pyproject);
    const hasPytest = /\[tool\.pytest(?:\.|\])/i.test(text) || hasTestsDir(current);
    candidates.push({ scope: current, root, command: hasPytest ? "pytest" : "", family: "python" });
  } else if (fs.existsSync(setupCfg)) {
    const text = readSmallText(setupCfg);
    const hasPytest = /\[tool:pytest\]/i.test(text) || hasTestsDir(current);
    candidates.push({ scope: current, root, command: hasPytest ? "pytest" : "", family: "python" });
  }

  if (fs.existsSync(path.join(current, "go.mod"))) {
    const hasGoTests = hasGoTestFiles(fileDir) || hasGoTestFiles(current) || hasTestsDir(current);
    candidates.push({ scope: current, root, command: hasGoTests ? "go test ./..." : "", family: "go" });
  }

  const cargoToml = path.join(current, "Cargo.toml");
  if (fs.existsSync(cargoToml)) {
    const text = readSmallText(cargoToml);
    const hasCargoSuite =
      /\[(?:package|workspace)\]/i.test(text) &&
      (hasTestsDir(current) || /\[dev-dependencies\]/i.test(text) || fs.existsSync(path.join(current, "src")));
    candidates.push({ scope: current, root, command: hasCargoSuite ? "cargo test" : "", family: "rust" });
  }

  return candidates;
}

export function detectDeliveryProject(fileDir, root, cache = new Map(), editedFile = "") {
  const pref = familyForEditedFile(editedFile);
  const cacheKey = `${pathKey(fileDir)}\0${pathKey(root)}\0${pref}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let found = null;
  for (let current = fileDir; inside(root, current); current = path.dirname(current)) {
    const candidates = inspectManifestsInDir(current, fileDir, root);
    if (candidates.length > 0) {
      found =
        (pref && candidates.find(c => c.family === pref && c.command)) ||
        candidates.find(c => c.command) ||
        (pref && candidates.find(c => c.family === pref)) ||
        candidates[0];
      break;
    }
    if (pathKey(current) === pathKey(root) || path.dirname(current) === current) break;
  }

  const result = found || { scope: root, root, command: "", family: "" };
  cache.set(cacheKey, result);
  return result;
}

export function matchesCustomCheckCommand(rawCmd, customCommand) {
  const spec = parseCustomCheckSpec(customCommand);
  if (!spec || typeof rawCmd !== "string" || !rawCmd.trim()) return false;
  const segs = splitChainedCommands(rawCmd).map(normalizeCustomSegment).filter(Boolean);
  if (!segs.length) return false;
  const specKeys = new Set(spec.segments.map(s => s.key));
  return segs.some(k => specKeys.has(k));
}

export function deliveryGateToolEvidence(gate, tool, args, payload, command, customCommand = "") {
  const hostCwd = location(payload.cwd);
  const rawRoots = payload.workspacePaths ?? payload.workspace_paths;
  const roots = rawRoots !== undefined ? decoded(rawRoots) : hostCwd ? [hostCwd] : [];
  if (!Array.isArray(roots) || !gate?.key) return null;
  const workspace = roots.map(r => location(r)).filter(Boolean);
  if (!workspace.length) return null;
  const fallbackCwd = hostCwd || workspace[0] || "";
  const cwd = location(args.Cwd ?? args.cwd ?? fallbackCwd, fallbackCwd);
  const findRoot = f => workspace.filter(r => inside(r, f)).sort((a, b) => b.length - a.length)[0];
  const packages = new Map();
  const hasCustom = Boolean(parseCustomCheckSpec(customCommand));
  const hasChainedRequest = Boolean(!hasCustom && gate.requested?.command?.includes("&&"));
  const trackCustomSegments = hasCustom || hasChainedRequest;

  let wroteSource = false;
  const edited = new Map();
  for (const edit of codePaths(tool, args, true, { delivery: true })) {
    const file = location(edit.file, cwd);
    const root = file && findRoot(file);
    if (!root || EXAMPLE.test(path.relative(root, file))) continue;
    const pkg = detectDeliveryProject(path.dirname(file), root, packages, file);
    const hasConfiguredCheck = hasCustom || Boolean(pkg.command) ||
      Boolean(gate.requested && pathKey(gate.requested.scope) === pathKey(pkg.scope));
    if (RUNTIME_CONFIG.test(file) && !hasConfiguredCheck) continue;
    wroteSource = true;
    edited.set(pathKey(pkg.scope), {
      scope: pkg.scope,
      root: pkg.root,
      command: pkg.command,
      family: pkg.family
    });
  }

  const rawEntries = [];
  if (tool === "run_command" && command) {
    rawEntries.push({ raw: command, runDir: cwd });
  }
  const items = decoded(args.commands);
  if (tool === "run_checks" && Array.isArray(items)) {
    for (const item of items) {
      const itemCmd = typeof item === "string" ? item : item?.command;
      if (!itemCmd) continue;
      const itemDir = item?.cwd ? location(item.cwd, cwd) : cwd;
      rawEntries.push({ raw: itemCmd, runDir: itemDir });
    }
  }
  if (tool === "apply_edits" && args.verify) {
    const verifyCmd = typeof args.verify === "string" ? args.verify : args.verify.command;
    if (verifyCmd) {
      const verifyDir = args.verify.cwd ? location(args.verify.cwd, cwd) : cwd;
      rawEntries.push({ raw: verifyCmd, runDir: verifyDir });
    }
  }

  const checked = [];
  for (const entry of rawEntries) {
    const resolvedSegs = resolveExecutedSegments(entry.raw, entry.runDir);
    if (!resolvedSegs.length) continue;
    // Group segments by resolved runDir (handles `cd pkg-a && npm test` and mid-chain `cd`)
    const byDir = new Map();
    for (const seg of resolvedSegs) {
      const checkRoot = seg.runDir && findRoot(seg.runDir);
      if (!checkRoot) continue;
      const dKey = pathKey(seg.runDir);
      if (!byDir.has(dKey)) {
        byDir.set(dKey, { runDir: seg.runDir, root: checkRoot, rawSegs: [] });
      }
      byDir.get(dKey).rawSegs.push(seg.raw);
    }
    for (const group of byDir.values()) {
      const pkg = detectDeliveryProject(group.runDir, group.root, packages);
      // Auto-detect only recognizes an unambiguous single project-wide check in the package root
      let autoKey = "";
      if (pathKey(pkg.scope) === pathKey(group.runDir) && resolvedSegs.length === 1) {
        autoKey = autoCheckCanonicalKey(group.rawSegs[0]);
      }
      const segments = trackCustomSegments
        ? group.rawSegs.map(normalizeCustomSegment).filter(Boolean)
        : [];
      if (!autoKey && !segments.length) continue;
      checked.push({
        runDir: group.runDir,
        root: group.root,
        autoKey,
        segments
      });
    }
  }

  if (!wroteSource && checked.length === 0) return null;
  return {
    key: gate.key,
    wroteSource,
    edited: [...edited.values()],
    checked
  };
}

export function advanceDeliveryGate(gate, events, customCommand = "") {
  if (!gate) return gate;
  const effectiveCustomCmd =
    parseCustomCheckSpec(customCommand)
      ? customCommand
      : gate.requested?.command?.includes("&&")
        ? gate.requested.command
        : "";
  const customSpec = parseCustomCheckSpec(effectiveCustomCmd);
  const customKeySet = customSpec ? new Set(customSpec.segments.map(s => s.key)) : null;

  const next = {
    ...gate,
    scopes: { ...(gate.scopes || {}) },
    customReceipts: { ...(gate.customReceipts || {}) }
  };

  let progressStep = Number.isSafeInteger(next.lastProgressStep) ? next.lastProgressStep : -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const data = ev?.deliveryEvidence;
    if (!data || data.key !== gate.key || ev.pending || ev.backgroundRunning) continue;
    const step = deliveryEventOrder(ev, i);

    if (
      ev.kind === "edit" &&
      ev.applied &&
      !ev.failed &&
      !ev.hasArtifactMeta &&
      !ev.looksLikePlanPath &&
      data.wroteSource
    ) {
      next.wroteSource = true;
      if (step > progressStep) progressStep = step;
      for (const ed of data.edited || []) {
        const sKey = pathKey(ed.scope);
        const prev = next.scopes[sKey] || {};
        const scope = { ...prev };
        if (scope.editStep === undefined || step >= scope.editStep) {
          scope.dir = ed.scope;
          scope.editStep = step;
          scope.root = ed.root;
          scope.declared = ed.command || "";
          scope.family = ed.family || "";
          next.scopes[sKey] = scope;
        }
      }
    }

    if (ev.kind === "cmd" && ev.terminal && Array.isArray(data.checked)) {
      for (const entry of data.checked) {
        if (!entry?.runDir) continue;
        const dKey = pathKey(entry.runDir);
        if (entry.autoKey) {
          const prevScope = next.scopes[dKey] || {};
          const autoChecks = { ...(prevScope.autoChecks || {}) };
          const prevRec = autoChecks[entry.autoKey];
          if (!prevRec || step >= prevRec.step) {
            autoChecks[entry.autoKey] = { step, passed: !ev.failed };
            next.scopes[dKey] = { ...prevScope, dir: prevScope.dir || entry.runDir, autoChecks };
          }
          if (step > progressStep) progressStep = step;
        }
        if (customSpec && Array.isArray(entry.segments) && entry.segments.length > 0) {
          for (const segKey of entry.segments) {
            if (!segKey) continue;
            const rKey = `${dKey}\0${segKey}`;
            const prevRec = next.customReceipts[rKey];
            if (!prevRec || step >= prevRec.step) {
              next.customReceipts[rKey] = {
                runDir: entry.runDir,
                root: entry.root || "",
                segKey,
                step,
                passed: !ev.failed
              };
            }
            if (customKeySet && customKeySet.has(segKey) && step > progressStep) {
              progressStep = step;
            }
          }
        }
      }
    }
  }

  // Bound stored custom receipts while preserving receipts matching the active custom command
  const receiptEntries = Object.entries(next.customReceipts);
  if (receiptEntries.length > MAX_CUSTOM_RECEIPTS) {
    receiptEntries.sort((a, b) => {
      const aMatch = customKeySet && customKeySet.has(a[1]?.segKey) ? 1 : 0;
      const bMatch = customKeySet && customKeySet.has(b[1]?.segKey) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return (b[1]?.step ?? -1) - (a[1]?.step ?? -1);
    });
    next.customReceipts = Object.fromEntries(receiptEntries.slice(0, MAX_CUSTOM_RECEIPTS));
  }

  if (progressStep > (Number.isSafeInteger(next.lastProgressStep) ? next.lastProgressStep : -1)) {
    next.lastProgressStep = progressStep;
    next.consecutiveNoTestNudges = 0;
  }

  return JSON.stringify(next) === JSON.stringify(gate) ? gate : next;
}

export function evaluateDeliveryGateStatus(gate, customCommand = "") {
  const pendingChecks = [];
  const failedChecks = [];
  const untestedScopes = [];
  if (!gate || !gate.wroteSource) {
    return { pendingChecks, failedChecks, untestedScopes, allPassed: true };
  }

  const customSpec = parseCustomCheckSpec(customCommand);
  const receipts = Object.values(gate.customReceipts || {});

  for (const [sKey, scope] of Object.entries(gate.scopes || {})) {
    if (scope.editStep === undefined) continue;
    const dir = scope.dir || sKey;
    const scopeDirKey = pathKey(dir);
    const scopeRootKey = pathKey(scope.root || "");

    if (customSpec) {
      const missingSegs = [];
      const failedSegs = [];
      for (const seg of customSpec.segments) {
        const expectedSubDirKey = seg.subDir ? pathKey(location(seg.subDir, scope.root || dir)) : "";
        let best = null;
        for (const r of receipts) {
          if (!r || r.segKey !== seg.key) continue;
          const rDirKey = pathKey(r.runDir);
          const scopeMatches = expectedSubDirKey
            ? rDirKey === expectedSubDirKey
            : rDirKey === scopeDirKey || (rDirKey === scopeRootKey && inside(r.runDir, dir));
          if (!scopeMatches) continue;
          if (!best || r.step >= best.step) best = r;
        }
        if (best && best.step >= scope.editStep) {
          if (!best.passed) failedSegs.push(seg.raw);
        } else {
          missingSegs.push(seg.raw);
        }
      }
      if (failedSegs.length > 0) {
        const label =
          failedSegs.length === customSpec.segments.length ? customSpec.raw : failedSegs.join(" && ");
        failedChecks.push({ dir, command: label, failed: true, isCustom: true });
      }
      if (missingSegs.length > 0) {
        const label =
          missingSegs.length === customSpec.segments.length ? customSpec.raw : missingSegs.join(" && ");
        pendingChecks.push({ dir, command: label, failed: false, isCustom: true });
      }
      continue;
    }

    const requestedForDir =
      gate.requested && pathKey(gate.requested.scope) === scopeDirKey ? gate.requested.command : "";
    const expectedCmd = requestedForDir || scope.declared || "";
    if (!expectedCmd) {
      untestedScopes.push({ dir, family: scope.family || "" });
      continue;
    }

    if (requestedForDir && requestedForDir.includes("&&")) {
      const reqSpec = parseCustomCheckSpec(requestedForDir);
      if (reqSpec) {
        const missingSegs = [];
        const failedSegs = [];
        for (const seg of reqSpec.segments) {
          let best = null;
          for (const r of receipts) {
            if (!r || r.segKey !== seg.key) continue;
            const rDirKey = pathKey(r.runDir);
            if (rDirKey !== scopeDirKey && !(rDirKey === scopeRootKey && inside(r.runDir, dir))) continue;
            if (!best || r.step >= best.step) best = r;
          }
          if (best && best.step >= scope.editStep) {
            if (!best.passed) failedSegs.push(seg.raw);
          } else {
            missingSegs.push(seg.raw);
          }
        }
        if (failedSegs.length > 0) {
          failedChecks.push({
            dir,
            command: failedSegs.length === reqSpec.segments.length ? reqSpec.raw : failedSegs.join(" && "),
            failed: true,
            isCustom: false
          });
        }
        if (missingSegs.length > 0) {
          pendingChecks.push({
            dir,
            command: missingSegs.length === reqSpec.segments.length ? reqSpec.raw : missingSegs.join(" && "),
            failed: false,
            isCustom: false
          });
        }
        continue;
      }
    }

    const expectedKey = autoCheckCanonicalKey(expectedCmd);
    const receipt = expectedKey ? scope.autoChecks?.[expectedKey] : null;
    if (receipt && receipt.step >= scope.editStep) {
      if (!receipt.passed) {
        failedChecks.push({ dir, command: expectedCmd, failed: true, isCustom: false });
      }
    } else {
      pendingChecks.push({ dir, command: expectedCmd, failed: false, isCustom: false });
    }
  }

  return {
    pendingChecks,
    failedChecks,
    untestedScopes,
    allPassed: pendingChecks.length === 0 && failedChecks.length === 0
  };
}

// ============================================================================
// Frozen Rules: Test Assertion Weakening Soft Audit (zero extra file I/O)
// ============================================================================

const TEST_FILE_RE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|(?:^|[\\/])tests[\\/][^\\/]+\.rs$|(?:Test|Tests|Spec)\.(?:java|kt|cs|dart|swift)$|_(?:test|spec)\.(?:rb|dart|ex|exs)$)/i;
const DUNDER_TESTS_DIR_RE = /(?:^|[\\/])__tests__[\\/]/i;

const TEST_SKIP_MARKER_RE =
  /(?:\b(?:it|test|describe|suite|context|specify)(?:\s*\.\s*(?:concurrent|sequential|serial|failing|only))*\s*\.\s*(?:(?:skip|todo|fixme)\s*(?:\(|\.\s*(?:each|for)\b)|skipIf\s*\(\s*(?!false\s*\)))|\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(|\b(?:test|it|describe|suite)(?:\s*\.\s*(?:only|concurrent|sequential|serial))?\s*\(\s*(?:[^;{}()]{0,240}?,\s*)?\{[^;{}]{0,240}?\bskip\s*:\s*true\b|@\s*pytest\.mark\.(?:skip|skipif|xfail)\b|@\s*unittest\.skip(?:If|Unless)?\b|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(|\b[tb]\.[sS]kip(?:f|Now)?\s*\(|#\[\s*ignore\b|@(?:Disabled|Ignore)\b|\[\s*(?:Ignore\b|Fact\s*\(\s*Skip\s*=))/g;

const TEST_ASSERTION_RE =
  /(?:\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(|(?:^|[;:])\s*assert\s+(?![=])|\bexpect\s*\(|\bassert(?:_[a-z_]+)?!\s*\(|\bassert_[a-z_]+\s*\(|\bself\.assert[A-Z]\w*\s*\(|\b[tb]\.(?:Error|Fatal|Fail)(?:f|Now)?\s*\(|\b(?:require|assert)\.[A-Z]\w*\s*\(|\bAssert\.[A-Z]\w*\s*\()/gm;

const TEST_ARTIFACT_NOUN_ZH_STR =
  "(?:的|里的?)?(?:缓存|日志|目录|文件夹|临时(?:文件)?|产物|报告|数据(?:库)?|环境|配置|容器|进程|端口|锁(?:文件)?|快照|覆盖率|夹具|输出)";
const TEST_ARTIFACT_NOUN_EN_STR =
  "\\s+(?:cache|caches|log|logs|dir|dirs|directory|directories|folder|folders|artifact|artifacts|data|db|database|env|environment|report|reports|coverage|tmp|temp|fixture|fixtures|mock|mocks|snapshot|snapshots|output|outputs|build|dist|container|containers|process|processes|port|ports|lock|config)\\b";

const ALLOW_TEST_WEAKENING_ZH_RE = new RegExp(
  `(?:(?:删掉?|删除|移除|去掉|清理|先?跳过|暂时跳过|禁用|注释掉?|加\\s*\\.?skip|标记\\s*skip|忽略)[^。\\n，,;；]{0,16}(?:这[个些条批]?|该|旧|过时|冗余|重复|flaky|不稳定|失败的?)?(?:(?:测试|单测)(?!${TEST_ARTIFACT_NOUN_ZH_STR})|用例|断言|assert|expect|test(?!${TEST_ARTIFACT_NOUN_EN_STR})|spec)|(?:(?:测试|单测)(?!${TEST_ARTIFACT_NOUN_ZH_STR})|用例|断言)[^。\\n，,;；]{0,12}(?:删掉?|删除|移除|去掉|先?跳过|禁用|注释掉?|加\\s*\\.?skip))`,
  "i"
);

const ALLOW_TEST_WEAKENING_EN_RE = new RegExp(
  `\\b(?:remove|delete|drop|skip|disable|ignore|comment\\s+out|mark\\s+as\\s+skip(?:ped)?)\\s+(?:(?:the|this|these|that|old|legacy|obsolete|flaky|failing|redundant|unit|existing)\\s+){0,3}(?:tests?(?!${TEST_ARTIFACT_NOUN_EN_STR})|test\\s+cases?|specs?|assertions?)\\b`,
  "i"
);

const MONOREPO_ROOT_SEG_RE = /^(?:packages|apps|services|libs|crates|modules|workspaces)$/i;

export function isTestFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const cleaned = filePath.trim().replace(/^(['"])([\s\S]+)\1$/, "$2");
  if (!cleaned || EXAMPLE.test(cleaned)) return false;
  if (TEST_FILE_RE.test(cleaned)) return true;
  return DUNDER_TESTS_DIR_RE.test(cleaned) && SOURCE.test(cleaned);
}

function stripAuditQuotes(filePath) {
  return String(filePath || "").trim().replace(/^(['"])([\s\S]+)\1$/, "$2").trim();
}

function toAuditPosixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function normalizeRelativeAuditPath(filePath) {
  const posix = toAuditPosixPath(stripAuditQuotes(filePath));
  if (!posix) return "";
  return path.posix.normalize(posix).replace(/^\.\//, "");
}

function canonicalTestFileKey(rawFile, cwd = "") {
  const cleaned = stripAuditQuotes(rawFile);
  if (!cleaned) return "";
  if (cwd && path.isAbsolute(cwd)) {
    const resolved = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
    return pathKey(toAuditPosixPath(resolved));
  }
  return pathKey(normalizeRelativeAuditPath(cleaned));
}

function trailingPathSegments(posixPath, count) {
  const parts = posixPath.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  return parts.slice(-Math.min(parts.length, count)).join("/");
}

function assignDisambiguatedLabels(perFileEntries, cwd = "") {
  const resolved = perFileEntries.map((entry) => {
    const cleaned = stripAuditQuotes(entry.rawFile);
    const posix = toAuditPosixPath(cleaned);
    let preferred = "";
    if (cwd && path.isAbsolute(cwd)) {
      const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
      if (inside(cwd, abs)) {
        preferred = toAuditPosixPath(path.relative(cwd, abs));
      }
    }
    if (!preferred && !path.isAbsolute(cleaned) && !/^[A-Za-z]:\//.test(posix)) {
      preferred = normalizeRelativeAuditPath(cleaned);
    }
    const parts = posix.split("/").filter(Boolean);
    const initialSegCount = preferred ? parts.length : Math.min(2, parts.length);
    return {
      entry,
      parts,
      segCount: initialSegCount,
      label: preferred || trailingPathSegments(posix, initialSegCount)
    };
  });

  // Expand colliding labels until unique across the batch
  for (let pass = 0; pass < 8; pass++) {
    const counts = new Map();
    for (const item of resolved) {
      const k = pathKey(item.label);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let changed = false;
    for (const item of resolved) {
      if ((counts.get(pathKey(item.label)) || 0) > 1 && item.segCount < item.parts.length) {
        item.segCount += 1;
        // Include monorepo parent segment (e.g. packages/a/...) when disambiguating sibling packages
        if (
          item.segCount < item.parts.length &&
          MONOREPO_ROOT_SEG_RE.test(item.parts[item.parts.length - item.segCount - 1] || "")
        ) {
          item.segCount += 1;
        }
        item.label = item.parts.slice(-item.segCount).join("/");
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const item of resolved) {
    item.entry.label = item.label;
  }
}

/**
 * Lightweight single-pass lexer that masks comments and string literals (preserving
 * newlines and JS/TS template `${...}` expressions) so hunk regexes ignore strings
 * like `"test.skip("` while retaining multi-line code structure with zero file I/O.
 */
function maskCodeForAudit(text, filePath = "") {
  if (typeof text !== "string" || !text) return "";
  const ext = path.extname(stripAuditQuotes(filePath)).toLowerCase();
  const hashComment = ext === ".py" || ext === ".rb" || ext === ".ex" || ext === ".exs";
  const slashComment = !hashComment;
  const isJsTs = /\.[cm]?[jt]sx?$/.test(ext);
  const isGo = ext === ".go";
  const isRust = ext === ".rs";
  const isPy = ext === ".py";
  const supportsTripleQuote =
    isPy || ext === ".dart" || ext === ".kt" || ext === ".java" || ext === ".swift" || ext === ".ex" || ext === ".exs";

  const out = [];
  const templateBraceDepths = [];
  const n = text.length;
  let i = 0;

  const scanTemplateChunk = () => {
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") {
        out.push(" ");
        i += 1;
        if (i < n) {
          out.push(text[i] === "\n" ? "\n" : " ");
          i += 1;
        }
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        templateBraceDepths.push(0);
        out.push("${");
        i += 2;
        return;
      }
      if (ch === "`") {
        out.push("`");
        i += 1;
        return;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i += 1;
    }
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (slashComment && ch === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (slashComment && ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n) {
        if (text[i] === "*" && text[i + 1] === "/") {
          out.push("  ");
          i += 2;
          break;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }
    if (hashComment && ch === "#") {
      out.push(" ");
      i += 1;
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (isJsTs && templateBraceDepths.length > 0) {
      if (ch === "{") {
        templateBraceDepths[templateBraceDepths.length - 1] += 1;
        out.push("{");
        i += 1;
        continue;
      }
      if (ch === "}") {
        const top = templateBraceDepths[templateBraceDepths.length - 1];
        if (top === 0) {
          templateBraceDepths.pop();
          out.push("}");
          i += 1;
          scanTemplateChunk();
          continue;
        }
        templateBraceDepths[templateBraceDepths.length - 1] = top - 1;
        out.push("}");
        i += 1;
        continue;
      }
    }

    if (
      supportsTripleQuote &&
      ((ch === '"' && next === '"' && text[i + 2] === '"') ||
        ((isPy || ext === ".dart") && ch === "'" && next === "'" && text[i + 2] === "'"))
    ) {
      const q = ch;
      out.push(q, q, q);
      i += 3;
      while (i < n) {
        if (text[i] === "\\") {
          out.push(" ");
          i += 1;
          if (i < n) {
            out.push(text[i] === "\n" ? "\n" : " ");
            i += 1;
          }
          continue;
        }
        if (text[i] === q && text[i + 1] === q && text[i + 2] === q) {
          out.push(q, q, q);
          i += 3;
          break;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }

    if (isRust && ch === "r" && (i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < n && text[j] === "#") j += 1;
      if (text[j] === '"') {
        const hashes = j - (i + 1);
        const closing = '"' + "#".repeat(hashes);
        out.push(" ".repeat(hashes + 1), '"');
        i = j + 1;
        while (i < n) {
          if (text.startsWith(closing, i)) {
            out.push('"', " ".repeat(hashes));
            i += closing.length;
            break;
          }
          out.push(text[i] === "\n" ? "\n" : " ");
          i += 1;
        }
        continue;
      }
    }

    if (ch === '"') {
      out.push('"');
      i += 1;
      while (i < n && text[i] !== "\n") {
        if (text[i] === "\\") {
          out.push(" ");
          i += 1;
          if (i < n && text[i] !== "\n") {
            out.push(" ");
            i += 1;
          }
          continue;
        }
        if (text[i] === '"') {
          out.push('"');
          i += 1;
          break;
        }
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      if (isRust) {
        const charLit = /^'(?:[^'\\\r\n]|\\[^'\r\n]{1,6})'/.exec(text.slice(i));
        if (charLit) {
          out.push("'", " ".repeat(Math.max(0, charLit[0].length - 2)), "'");
          i += charLit[0].length;
          continue;
        }
        out.push("'");
        i += 1;
        continue;
      }
      out.push("'");
      i += 1;
      while (i < n && text[i] !== "\n") {
        if (text[i] === "\\") {
          out.push(" ");
          i += 1;
          if (i < n && text[i] !== "\n") {
            out.push(" ");
            i += 1;
          }
          continue;
        }
        if (text[i] === "'") {
          out.push("'");
          i += 1;
          break;
        }
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "`" && (isJsTs || isGo)) {
      out.push("`");
      i += 1;
      if (isGo) {
        while (i < n) {
          if (text[i] === "`") {
            out.push("`");
            i += 1;
            break;
          }
          out.push(text[i] === "\n" ? "\n" : " ");
          i += 1;
        }
      } else {
        scanTemplateChunk();
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }

  return out.join("");
}

const SKIP_OPT_FALSE_RE = /(?:^|[{,\s])skip\s*:\s*false\b/gm;
const SKIP_OPT_TRUE_RE = /(?:^|[{,\s])skip\s*:\s*true\b/gm;

function countPatternMatchesInText(maskedText, re) {
  if (!maskedText) return 0;
  re.lastIndex = 0;
  const matches = maskedText.match(re);
  return matches ? matches.length : 0;
}

/**
 * Reuse edit tool hunk arguments (zero disk I/O) to detect suspected test weakening:
 * newly added skip/ignore markers or net reduction of existing assertions in test files.
 * Returns per-file entries alongside the aggregate summary so partial `apply_edits`
 * receipts can attribute writes accurately without guessing.
 */
export function detectTestAssertionWeakeningDetails(tool, args, options = {}) {
  if (!args || typeof args !== "object") return null;
  if (tool === "write_file" || tool === "write_to_file") return null;
  if (tool === "apply_edits" && args.dryRun === true) return null;

  const cwd = typeof options.cwd === "string" ? options.cwd : "";
  const target = args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath;
  const edits =
    tool === "apply_edits"
      ? decoded(args.edits)
      : decoded(args.ReplacementChunks ?? args.replacementChunks ?? [args]);
  if (!Array.isArray(edits)) return null;

  const perFile = new Map();
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const rawFile = decoded(tool === "apply_edits" ? edit.path : target);
    if (typeof rawFile !== "string" || !isTestFilePath(rawFile)) continue;
    const hunks = decoded(edit.hunks) ?? [edit];
    if (!Array.isArray(hunks)) continue;

    const key = canonicalTestFileKey(rawFile, cwd);
    if (!key) continue;
    const stats = perFile.get(key) || {
      key,
      rawFile: stripAuditQuotes(rawFile),
      label: "",
      oldSkips: 0,
      newSkips: 0,
      oldAsserts: 0,
      newAsserts: 0
    };

    for (const h of hunks) {
      if (!h || typeof h !== "object") continue;
      const before = sourceText(h.target ?? h.Target ?? h.TargetContent ?? h.old_text ?? h.oldText ?? h.find);
      const after = sourceText(h.replacement ?? h.Replacement ?? h.ReplacementContent ?? h.new_text ?? h.newText ?? h.replace);
      if (typeof before !== "string" || typeof after !== "string" || before === after) continue;

      const maskedBefore = maskCodeForAudit(before, rawFile);
      const maskedAfter = maskCodeForAudit(after, rawFile);

      const oldSkipsHunk = countPatternMatchesInText(maskedBefore, TEST_SKIP_MARKER_RE);
      let newSkipsHunk = countPatternMatchesInText(maskedAfter, TEST_SKIP_MARKER_RE);
      // Catch tight hunks inside JS/TS test files that flip `skip: false` -> `skip: true`
      // without including the enclosing `test(` header line, while avoiding double-counting.
      if (/\.[cm]?[jt]sx?$/i.test(rawFile)) {
        const beforeFalse = countPatternMatchesInText(maskedBefore, SKIP_OPT_FALSE_RE);
        const afterFalse = countPatternMatchesInText(maskedAfter, SKIP_OPT_FALSE_RE);
        const beforeTrue = countPatternMatchesInText(maskedBefore, SKIP_OPT_TRUE_RE);
        const afterTrue = countPatternMatchesInText(maskedAfter, SKIP_OPT_TRUE_RE);
        const flippedToTrue = Math.min(
          Math.max(0, beforeFalse - afterFalse),
          Math.max(0, afterTrue - beforeTrue)
        );
        if (flippedToTrue > Math.max(0, newSkipsHunk - oldSkipsHunk)) {
          newSkipsHunk = oldSkipsHunk + flippedToTrue;
        }
      }

      stats.oldSkips += oldSkipsHunk;
      stats.newSkips += newSkipsHunk;
      stats.oldAsserts += countPatternMatchesInText(maskedBefore, TEST_ASSERTION_RE);
      stats.newAsserts += countPatternMatchesInText(maskedAfter, TEST_ASSERTION_RE);
    }

    perFile.set(key, stats);
  }

  if (perFile.size === 0) return null;
  const allEntries = [...perFile.values()];
  assignDisambiguatedLabels(allEntries, cwd);

  let addedSkip = 0;
  let droppedAssert = 0;
  const files = [];
  const entries = [];
  for (const stats of allEntries) {
    const skipDelta = Math.max(0, stats.newSkips - stats.oldSkips);
    const assertDelta = stats.oldAsserts > 0 ? Math.max(0, stats.oldAsserts - stats.newAsserts) : 0;
    if (skipDelta > 0 || assertDelta > 0) {
      addedSkip += skipDelta;
      droppedAssert += assertDelta;
      if (files.length < 5) files.push(stats.label);
      entries.push({
        key: stats.key,
        path: normalizeRelativeAuditPath(stats.rawFile),
        label: stats.label,
        addedSkip: skipDelta,
        droppedAssert: assertDelta
      });
    }
  }

  if (addedSkip === 0 && droppedAssert === 0) return null;
  return { files, addedSkip, droppedAssert, entries };
}

/**
 * Public hunk-only test assertion weakening detector (zero disk I/O).
 * Preserves the compact `{ files, addedSkip, droppedAssert }` return shape.
 */
export function detectTestAssertionWeakening(tool, args, options = {}) {
  const details = detectTestAssertionWeakeningDetails(tool, args, options);
  if (!details) return null;
  return {
    files: details.files,
    addedSkip: details.addedSkip,
    droppedAssert: details.droppedAssert
  };
}

/**
 * Filter a batch's test-weakening summary by the files confirmed written in a
 * `Partial edit applied` receipt. If the receipt only reports total counts (no
 * confirmed file list), conservatively return null (unknown attribution).
 */
export function filterTestWeakeningByAppliedFiles(weakening, details, partialReceipt, cwd = "") {
  if (!weakening) return null;
  if (!partialReceipt || !partialReceipt.isPartial) return weakening;
  if (!Array.isArray(partialReceipt.appliedFiles) || partialReceipt.appliedFiles.length === 0) {
    return null;
  }
  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const matched = new Set();
  for (const rawApplied of partialReceipt.appliedFiles) {
    const normApplied = normalizeRelativeAuditPath(rawApplied);
    if (!normApplied) continue;
    const appliedKey = canonicalTestFileKey(rawApplied, cwd);
    const appliedNormKey = pathKey(normApplied);

    // 1. Exact canonical / normalized path / label match
    const exactHits = [];
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (!d) continue;
      if (
        (appliedKey && d.key && appliedKey === d.key) ||
        (d.path && appliedNormKey === pathKey(d.path)) ||
        (d.label && appliedNormKey === pathKey(d.label))
      ) {
        exactHits.push(i);
      }
    }
    if (exactHits.length === 1) {
      matched.add(exactHits[0]);
      continue;
    }
    if (exactHits.length > 1) continue;

    // 2. Unambiguous path-segment suffix match when one side is absolute and the other relative
    const suffixHits = [];
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (!d || !d.key) continue;
      const suffix = `/${appliedNormKey}`;
      if (
        (normApplied.includes("/") && (d.key.endsWith(suffix) || pathKey(d.path || "").endsWith(suffix))) ||
        (d.path && d.path.includes("/") && appliedKey.endsWith(`/${pathKey(d.path)}`))
      ) {
        suffixHits.push(i);
      }
    }
    if (suffixHits.length === 1) {
      matched.add(suffixHits[0]);
    }
  }

  let addedSkip = 0;
  let droppedAssert = 0;
  const files = [];
  for (let i = 0; i < details.length; i++) {
    if (!matched.has(i)) continue;
    const d = details[i];
    addedSkip += Number(d.addedSkip) || 0;
    droppedAssert += Number(d.droppedAssert) || 0;
    if (d.label && files.length < 5) files.push(d.label);
  }

  if (addedSkip === 0 && droppedAssert === 0) return null;
  return { files, addedSkip, droppedAssert };
}

export function allowsTestWeakening(text) {
  const stripped = String(text || "").replace(/```[\s\S]*?```/g, " ");
  const clauses = stripped.split(/[。.!！?？;\n,，]+/);
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const sanitized = clause
      .replace(
        /(?:别|不要|请勿|切勿|勿|不应(?:该)?|不可(?!用|行|能)|不能(?!用|跑|通过)|不许|不得|禁止|严禁|不准|不允许)(?:(?!但是|不过|而是)[\s\S])*/g,
        "保留"
      )
      .replace(
        /\b(?:do\s+not|don['’]t|never|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|cannot|can['’]t|avoid|refuse\s+to|forbid(?:den)?(?:\s+to)?|not\s+allowed\s+to|no\s+(?:skipping|removing|deleting|dropping|disabling|weakening))\b(?:(?!\b(?:but|however)\b)[\s\S])*/gi,
        "keep"
      );
    if (ALLOW_TEST_WEAKENING_ZH_RE.test(sanitized) || ALLOW_TEST_WEAKENING_EN_RE.test(sanitized)) {
      return true;
    }
  }
  return false;
}
