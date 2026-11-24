import fs from "node:fs";
import path from "node:path";

// Only project-wide commands with unambiguous scope are recognized. Shell chains,
// file filters, --prefix, workspaces and free-form command output are not evidence.
const NODE_TEST = /^(?:npm(?:\.cmd)? (?:t|test|run test)|(?:pnpm|yarn|bun)(?:\.cmd)? (?:run )?test)$/i;
const PROJECT_CHECK = /^(?:go test \.\/\.\.\.|cargo test|(?:python3?|py) -m (?:pytest|unittest discover)|pytest|node --test)$/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|c(?:pp|xx)?|h(?:pp)?|rb|php|swift|dart|sh|ps1)$/i;
const EXAMPLE = /(?:^|[\\/])(?:examples?|templates?|fixtures?|node_modules|vendor|dist|build|\.git)(?:[\\/]|$)|(?:\.example|\.sample|\.template)\./i;
const RUNTIME_CONFIG = /(?:^|[\\/])(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i;
const SKIP_CHECK = /(?:跳过|不用|不要|别|不必|无需|免)(?:再|运行|跑|执行|做|进行|补跑|补)?(?:任何|相关|这些|自动)?(?:测试|验证|检查)|(?:skip|without|do not run|don.t run|no)\s+(?:(?:the|any|running|automated)\s+)*(?:tests?|verification|checks?)\b/i;
const SKIP_REVIEW = /(?:跳过|不用|不要|别|不必|无需)(?:再|调用|安排|启动|做|进行)?(?:独立|额外|子智能体|只读)?(?:复核|审查|审阅|子智能体)|(?:skip|without|no)\s+(?:(?:the|independent|extra)\s+)*(?:review|subagents?)\b/i;

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
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
}

function location(raw, cwd) {
  raw = decoded(raw);
  if (typeof raw !== "string" || !raw.trim() || /[\x00-\x1f]/.test(raw)) return "";
  const value = raw.trim().replace(/^"([^"]+)"$/, "$1");
  if (path.isAbsolute(value)) return path.normalize(value);
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

function codePaths(tool, args, allowConfig) {
  const target = args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath;
  const edits = tool === "apply_edits" ? decoded(args.edits) :
    decoded(args.ReplacementChunks ?? args.replacementChunks ?? [args]);
  if (!Array.isArray(edits)) return [];
  const result = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const file = decoded(tool === "apply_edits" ? edit.path : target);
    if (typeof file !== "string" || !(SOURCE.test(file) || (allowConfig && RUNTIME_CONFIG.test(file))) || EXAMPLE.test(file)) continue;
    const hunks = decoded(edit.hunks) ?? [edit];
    const changed = Array.isArray(hunks) && hunks.some(h => h && changesCode(
      sourceText(h.target ?? h.Target ?? h.TargetContent ?? h.old_text ?? h.oldText ?? h.find),
      sourceText(h.replacement ?? h.Replacement ?? h.ReplacementContent ?? h.new_text ?? h.newText ?? h.replace)
    ));
    const nativeWrite = tool === "write_file" || tool === "write_to_file";
    const create = nativeWrite ? sourceText(args.CodeContent ?? args.Content ?? args.content) : edit.create;
    const overwrite = decoded(nativeWrite ? args.Overwrite ?? args.overwrite : edit.overwrite);
    const wroteCode = typeof create === "string" && create.split(/\r?\n/).some(line => changesCode("", line));
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

function checkCommand(cmd) {
  cmd = decoded(cmd);
  if (typeof cmd !== "string") return "";
  const normalized = cmd.trim().replace(/[ \t]+/g, " ");
  if (NODE_TEST.test(normalized)) return "npm test";
  return PROJECT_CHECK.test(normalized) ? normalized : "";
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
  const cwd = location(args.Cwd ?? args.cwd ?? hostCwd, hostCwd);
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
