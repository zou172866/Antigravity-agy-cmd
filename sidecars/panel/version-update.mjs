import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { compareVersions, parseVersion, REPO } from "./version-check.mjs";
import { downloadArchive, readReleaseArchive, UpdateError } from "./update-archive.mjs";

export const UPDATE_ROUTE = "/api/update";
export const UPDATE_MARKER_NAME = ".update-in-progress";
export const UPDATE_JOURNAL_NAME = "journal.json";
const UPDATE_WORK_PREFIX = ".agy-cmd-update-";

const PLUGIN_NAME = "agy-cmd";
const SIDECAR_REL_DIR = "sidecars/panel";
const SIDECAR_MANIFEST = `${SIDECAR_REL_DIR}/sidecar.json`;
const STALE_MARKER_MS = 10 * 60_000;

const REQUIRED_FILES = [
  "plugin.json",
  "package.json",
  "hooks.json",
  "rules/AGENTS.md",
  "agents/cmd-verifier.md",
  SIDECAR_MANIFEST,
  `${SIDECAR_REL_DIR}/server.mjs`,
  `${SIDECAR_REL_DIR}/api-handler.mjs`,
  `${SIDECAR_REL_DIR}/index.html`,
  "hooks/session-start.mjs",
  "hooks/pre-tool-use.mjs",
  "hooks/post-tool-use.mjs",
  "hooks/pre-invocation.mjs",
  "hooks/stop.mjs",
  "hooks/lib/common.mjs",
  "hooks/lib/detector.mjs",
  "hooks/lib/diagnostics.mjs",
  "hooks/lib/plan-verification.mjs",
  "hooks/lib/settings.mjs",
  "hooks/lib/state.mjs",
  "hooks/lib/transcript.mjs",
  "skills/agy-cmd/SKILL.md",
  "skills/agy-cmd/scripts/setup_auto_router.py"
];

const BUNDLE_ROOT_FILES = new Set([
  "plugin.json",
  "hooks.json",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "install.ps1",
  "install.sh",
  "LICENSE",
  "SECURITY.md"
]);

const BUNDLE_DIRS = new Set(["assets", "rules", "agents", "hooks", "sidecars", "skills", "test"]);
const PRESERVED_HIDDEN_FILES = new Set([UPDATE_MARKER_NAME, ".gitignore"]);
const FILE_ERROR_REASONS = { EACCES: "permission", EBUSY: "locked", EPERM: "locked", ETXTBSY: "locked" };

class InstallError extends UpdateError {
  constructor(error, relPath, { restored = false, recovery = false } = {}) {
    const code = typeof error?.code === "string" && /^E[A-Z0-9_]{1,31}$/.test(error.code) ? error.code : undefined;
    const reason = error instanceof UpdateError ? error.reason : FILE_ERROR_REASONS[code] || "install";
    super(recovery ? "recovery" : reason);
    // Only expose plugin-relative paths to avoid leaking host usernames or absolute paths.
    this.diagnostics = { ...(code && { code }), ...(relPath && { path: relPath }), ...(restored && { restored }) };
  }
}

async function safeLstat(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function isSamePath(a, b) {
  const normA = resolve(a);
  const normB = resolve(b);
  return process.platform === "win32" ? normA.toLowerCase() === normB.toLowerCase() : normA === normB;
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function parseMarkerJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Legacy plain-text marker format
  }
  return null;
}

function isSafeWorkDirName(name) {
  return (
    typeof name === "string" &&
    name.startsWith(UPDATE_WORK_PREFIX) &&
    name.length > UPDATE_WORK_PREFIX.length &&
    name.length <= 96 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

function isSafeRelPosixPath(rel) {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) {
    return false;
  }
  const parts = rel.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

async function writeMarkerAtomic(markerPath, record, { exclusive = false } = {}) {
  const serialized = JSON.stringify(record) + "\n";
  if (exclusive) {
    await writeFile(markerPath, serialized, { flag: "wx" });
    return;
  }
  const tmpPath = `${markerPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, markerPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function evaluateMarkerState(
  raw,
  mtimeMs,
  { now = Date.now, staleMs = STALE_MARKER_MS, isPidAlive = defaultIsPidAlive } = {}
) {
  const parsed = parseMarkerJson(raw);
  if (parsed) {
    if (parsed.phase === "recovery") return "recovery";
    if (Number.isInteger(parsed.pid)) {
      const alive = parsed.pid === process.pid || isPidAlive(parsed.pid);
      const expired = Number.isFinite(parsed.startedAt) && now() - parsed.startedAt > staleMs;
      if (alive && !expired) return "active";
      if (parsed.phase === "staging") return "stale";
      if (parsed.phase === "committed") return "committed_stale";
      if (parsed.phase === "replacing") return "interrupted";
      return "stale";
    }
  }
  return Number.isFinite(mtimeMs) && now() - mtimeMs > staleMs ? "stale" : "active";
}

/**
 * Synchronous check used by the sidecar auto-reload poller so an active, interrupted, or recovery
 * update marker suppresses reloads while dead-process staging locks do not permanently disable reload.
 */
export function hasActiveUpdateMarker(
  markerPath,
  { now = Date.now, staleMs = STALE_MARKER_MS, isPidAlive = defaultIsPidAlive } = {}
) {
  let st;
  try {
    st = lstatSync(markerPath);
  } catch {
    return false;
  }
  if (!st.isFile() || st.isSymbolicLink()) return true;
  try {
    const raw = readFileSync(markerPath, "utf8");
    const state = evaluateMarkerState(raw, st.mtimeMs, { now, staleMs, isPidAlive });
    return state === "active" || state === "recovery" || state === "interrupted";
  } catch {
    return true;
  }
}

async function resolveSiblingWorkDir(root, workDirName) {
  if (!isSafeWorkDirName(workDirName)) return null;
  const candidate = join(dirname(root), workDirName);
  const st = await safeLstat(candidate);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return null;
  return candidate;
}

async function rollbackFromJournal(root, workDir, journal, move) {
  const orderedInstall = Array.isArray(journal?.orderedInstall) ? journal.orderedInstall : [];
  const obsoleteFiles = Array.isArray(journal?.obsoleteFiles) ? journal.obsoleteFiles : [];
  if (!orderedInstall.every(isSafeRelPosixPath) || !obsoleteFiles.every(isSafeRelPosixPath)) {
    throw new UpdateError("recovery");
  }
  const stageDir = join(workDir, "next");
  const prevDir = join(workDir, "backup", "prev");
  const obsoleteDir = join(workDir, "backup", "obsolete");
  let activePath = "plugin.json";

  try {
    for (const rel of [...obsoleteFiles].reverse()) {
      activePath = rel;
      const saved = join(obsoleteDir, rel);
      const live = join(root, rel);
      if ((await safeLstat(saved)) && !(await safeLstat(live))) {
        await assertNoIntermediateSymlink(root, rel);
        await mkdir(dirname(live), { recursive: true });
        await move(saved, live);
      }
    }

    for (const rel of [...orderedInstall].reverse()) {
      activePath = rel;
      const stageFile = join(stageDir, rel);
      const prevFile = join(prevDir, rel);
      const liveFile = join(root, rel);
      const hasStage = Boolean(await safeLstat(stageFile));
      const hasPrev = Boolean(await safeLstat(prevFile));
      const hasLive = Boolean(await safeLstat(liveFile));

      if (!hasStage && hasLive) {
        await mkdir(dirname(stageFile), { recursive: true });
        await move(liveFile, stageFile);
      }
      if (hasPrev) {
        const liveAfter = await safeLstat(liveFile);
        if (!liveAfter) {
          await assertNoIntermediateSymlink(root, rel);
          await mkdir(dirname(liveFile), { recursive: true });
          await move(prevFile, liveFile);
        }
      }
    }

    await removeEmptyDirsRecursive(root, root).catch(() => {});

    if (!journal.freshInstall && journal.previousVersion) {
      const restoredManifest = await readDiskJson(root, "plugin.json");
      if (parseVersion(restoredManifest?.version)?.version !== journal.previousVersion) {
        throw new UpdateError("recovery");
      }
    }
  } catch (err) {
    throw new InstallError(err, activePath, { recovery: true });
  }
}

/**
 * Inspect `.update-in-progress` and deterministically recover an interrupted update
 * using its persisted sibling journal & backup directory, or transition explicitly to `recovery`.
 */
export async function recoverInterruptedUpdate(
  root,
  { markerOptions = {}, move = rename, reclaimStale = true } = {}
) {
  const markerPath = join(root, UPDATE_MARKER_NAME);
  const st = await safeLstat(markerPath);
  if (!st) return { status: "clean" };
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new UpdateError("pathConflict");
  }

  const raw = await readFile(markerPath, "utf8").catch(() => "");
  const parsed = parseMarkerJson(raw);
  const state = evaluateMarkerState(raw, st.mtimeMs, markerOptions);

  if (state === "active") {
    throw new UpdateError("busy");
  }

  if (state === "stale" || state === "committed_stale") {
    if (!reclaimStale) {
      return { status: state };
    }
    const workDir = parsed?.workDirName ? await resolveSiblingWorkDir(root, parsed.workDirName) : null;
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    await unlink(markerPath).catch((err) => {
      if (err?.code !== "ENOENT") throw new InstallError(err, UPDATE_MARKER_NAME);
    });
    return { status: state === "committed_stale" ? "cleaned_committed" : "cleaned_stale" };
  }

  // `interrupted` (dead-PID replacing) or `recovery` with an intact sibling journal
  const markerNow = markerOptions.now || Date.now;
  const workDir = parsed?.workDirName ? await resolveSiblingWorkDir(root, parsed.workDirName) : null;
  let journal = null;
  if (workDir) {
    const journalPath = join(workDir, UPDATE_JOURNAL_NAME);
    const jSt = await safeLstat(journalPath);
    if (jSt?.isFile() && !jSt.isSymbolicLink()) {
      try {
        const jObj = JSON.parse((await readFile(journalPath, "utf8")).replace(/^\uFEFF/, ""));
        if (
          jObj &&
          typeof jObj === "object" &&
          !Array.isArray(jObj) &&
          Array.isArray(jObj.orderedInstall) &&
          (!parsed.token || jObj.token === parsed.token)
        ) {
          journal = jObj;
        }
      } catch {}
    }
  }

  if (!workDir || !journal) {
    if (state === "interrupted") {
      await writeMarkerAtomic(markerPath, {
        ...(parsed || {}),
        schemaVersion: 2,
        pid: process.pid,
        startedAt: markerNow(),
        phase: "recovery"
      }).catch(() => {});
    }
    throw new UpdateError("recovery");
  }

  try {
    await rollbackFromJournal(root, workDir, journal, move);
    await unlink(markerPath).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    return {
      status: "recovered",
      restoredVersion: journal.previousVersion || ""
    };
  } catch (err) {
    await writeMarkerAtomic(markerPath, {
      ...(parsed || {}),
      schemaVersion: 2,
      pid: process.pid,
      startedAt: markerNow(),
      phase: "recovery",
      workDirName: parsed.workDirName,
      journalFile: UPDATE_JOURNAL_NAME
    }).catch(() => {});
    throw err instanceof UpdateError ? err : new InstallError(err, UPDATE_MARKER_NAME, { recovery: true });
  }
}

async function checkUpdateMarker(markerPath, markerOptions, reclaimStale = false, move = rename) {
  const root = dirname(markerPath);
  return recoverInterruptedUpdate(root, { markerOptions, move, reclaimStale });
}

async function readDiskJson(root, relPath) {
  const fullPath = join(root, relPath);
  const st = await safeLstat(fullPath);
  if (!st?.isFile() || st.isSymbolicLink()) throw new UpdateError("notInstalled");
  try {
    return JSON.parse((await readFile(fullPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (err) {
    if (err instanceof SyntaxError || err?.code === "ENOENT") throw new UpdateError("notInstalled");
    throw new InstallError(err, relPath);
  }
}

async function assertNoIntermediateSymlink(root, relPosix) {
  const parts = relPosix.split("/").slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    const st = await safeLstat(cur);
    if (!st) break;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new UpdateError("pathConflict");
    }
  }
}

export async function resolveInstalledRoot(
  sidecarDirectory,
  { pluginsDirectory = "", allowCustomRoot = false } = {}
) {
  const root = resolve(sidecarDirectory, "../..");
  const expectedSidecarDir = join(root, "sidecars", "panel");
  if (!isSamePath(sidecarDirectory, expectedSidecarDir)) {
    throw new UpdateError("notInstalled");
  }

  for (const dirPath of [root, join(root, "sidecars"), expectedSidecarDir]) {
    const st = await safeLstat(dirPath);
    if (!st?.isDirectory() || st.isSymbolicLink()) throw new UpdateError("notInstalled");
  }

  const canonical = await realpath(root);
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  const fsRoot = resolve(canonical, "/");
  if (isSamePath(canonical, fsRoot) || isSamePath(canonical, home)) {
    throw new UpdateError("notInstalled");
  }

  // Never overwrite a Git source checkout directly at root.
  if (await safeLstat(join(canonical, ".git"))) {
    throw new UpdateError("gitCheckout");
  }

  let isStandardPluginSlot = false;
  if (pluginsDirectory) {
    const expectedTarget = await realpath(join(pluginsDirectory, PLUGIN_NAME)).catch(() =>
      resolve(pluginsDirectory, PLUGIN_NAME)
    );
    isStandardPluginSlot = isSamePath(canonical, expectedTarget);
  } else {
    const dirName = basename(canonical);
    const parentName = basename(dirname(canonical));
    isStandardPluginSlot = dirName === PLUGIN_NAME && parentName === "plugins";
  }

  if (!allowCustomRoot && !isStandardPluginSlot) {
    throw new UpdateError("notInstalled");
  }

  // Never overwrite a Marketplace / `agy plugin install` host-managed plugin directory.
  if (isStandardPluginSlot) {
    const configPath = join(dirname(dirname(canonical)), "config.json");
    const cfgSt = await safeLstat(configPath);
    if (cfgSt?.isFile() && !cfgSt.isSymbolicLink()) {
      try {
        const cfg = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
        const entry = cfg?.plugins?.[PLUGIN_NAME];
        if (entry && typeof entry === "object" && entry.installedFrom) {
          throw new UpdateError("managedByHost");
        }
      } catch (err) {
        if (err instanceof UpdateError) throw err;
      }
    }
  }

  // For custom/non-standard roots, walk ancestors below $HOME/fsRoot to protect monorepo checkouts,
  // while avoiding false positives when a user keeps a $HOME/.git dotfiles repository.
  if (!isStandardPluginSlot) {
    for (let dir = dirname(canonical); ; dir = dirname(dir)) {
      if (isSamePath(dir, home) || isSamePath(dir, fsRoot)) break;
      if (await safeLstat(join(dir, ".git"))) {
        throw new UpdateError("gitCheckout");
      }
      const parent = dirname(dir);
      if (parent === dir) break;
    }
  }

  const manifest = await readDiskJson(canonical, "plugin.json");
  if (manifest?.name !== PLUGIN_NAME) throw new UpdateError("notInstalled");
  await readDiskJson(canonical, SIDECAR_MANIFEST);
  return canonical;
}

export function shouldPreserveExecutableMode(relPath, bytes) {
  if (typeof relPath === "string" && relPath.endsWith(".sh")) return true;
  if (bytes && bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true;
  return false;
}

export function preservePinnedNodeCommand(sidecarBuf, installedSidecar) {
  const { command } = installedSidecar || {};
  if (typeof command !== "string" || !command || /[\x00-\x1f\r\n]/.test(command)) {
    return sidecarBuf;
  }
  const isWindowsNode =
    win32.isAbsolute(command) &&
    win32.basename(command).toLowerCase() === "node.exe" &&
    win32.parse(command).root.length > 1 &&
    !command.startsWith("\\\\");
  const isPosixNode =
    posix.isAbsolute(command) &&
    !command.startsWith("//") &&
    posix.basename(command) === "node";
  if (isWindowsNode || isPosixNode) {
    try {
      const sidecar = JSON.parse(sidecarBuf.toString("utf8"));
      sidecar.command = command;
      return Buffer.from(JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    } catch {
      // Keep archive sidecar.json as-is
    }
  }
  return sidecarBuf;
}

const ALLOWED_VERIFIER_KEYS = new Set([
  "name",
  "description",
  "mainAgent",
  "subagent",
  "model",
  "inheritMcp",
  "inheritCustomizations",
  "tools",
  "commandExecutionPolicy"
]);
const ALLOWED_VERIFIER_MODELS = new Set(["inherit", "flash", "flash_lite", "pro"]);
const ALLOWED_VERIFIER_READONLY_TOOLS = new Set([
  "read_file",
  "view_file",
  "grep_search",
  "find_by_name",
  "list_dir",
  "send_message"
]);

/**
 * Validate bundled `agents/cmd-verifier.md` read-only security invariants (mirrors setup_auto_router.py).
 * Allows safe read-only tool subsets and optional `commandExecutionPolicy: off` while blocking
 * write, shell, MCP, or unknown frontmatter fields.
 */
export function isValidVerifierRole(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return false;
  const rest = text.slice(4);
  const dividerIdx = rest.indexOf("\n---\n");
  if (dividerIdx < 0) return false;
  const header = rest.slice(0, dividerIdx);
  const lines = header.split("\n");
  const fields = {};
  for (const line of lines) {
    const idx = line.indexOf(": ");
    if (idx <= 0) return false;
    const key = line.slice(0, idx);
    if (!ALLOWED_VERIFIER_KEYS.has(key) || Object.prototype.hasOwnProperty.call(fields, key)) {
      return false;
    }
    fields[key] = line.slice(idx + 2).trim();
  }
  if (!fields.description) return false;
  if (fields.name !== "cmd-verifier") return false;
  if (fields.mainAgent !== "false") return false;
  if (fields.subagent !== "true") return false;
  if (fields.inheritMcp !== "false") return false;
  if (fields.inheritCustomizations !== "true" && fields.inheritCustomizations !== "false") return false;
  if (!ALLOWED_VERIFIER_MODELS.has(fields.model)) return false;
  if (
    Object.prototype.hasOwnProperty.call(fields, "commandExecutionPolicy") &&
    fields.commandExecutionPolicy !== "off"
  ) {
    return false;
  }
  let tools;
  try {
    tools = JSON.parse(fields.tools || "");
  } catch {
    return false;
  }
  if (
    !Array.isArray(tools) ||
    tools.length === 0 ||
    !tools.every((t) => typeof t === "string" && ALLOWED_VERIFIER_READONLY_TOOLS.has(t))
  ) {
    return false;
  }
  return true;
}

function isValidHooksManifest(hooks) {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const spec = hooks["agy-cmd-router"];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
  for (const ev of ["SessionStart", "PostToolUse", "PreInvocation", "Stop"]) {
    if (!Array.isArray(spec[ev]) || spec[ev].length === 0) return false;
  }
  if (spec.PreToolUse !== undefined && (!Array.isArray(spec.PreToolUse) || spec.PreToolUse.length === 0)) {
    return false;
  }
  return true;
}

/**
 * Extract top-level static relative ESM import/export specifiers (single-line and multiline
 * named `{ ... } from './...'` statements) without executing archive code.
 */
export function extractStaticRelativeImports(source) {
  const targets = new Set();
  const singleLineRe =
    /^(?:import[ \t]+['"](\.{1,2}\/[^'"\r\n]+)['"]|(?:import|export)[ \t]+[^\r\n'"`;]*?\bfrom[ \t]*['"](\.{1,2}\/[^'"\r\n]+)['"])/gm;
  for (const m of source.matchAll(singleLineRe)) {
    const spec = m[1] || m[2];
    if (spec) targets.add(spec);
  }
  const multiLineNamedRe =
    /^(?:import|export)[ \t]+(?:[A-Za-z_$][\w$]*[ \t]*,[ \t]*)?\{[^{};()`]*?\}[ \t]*from[ \t]*['"](\.{1,2}\/[^'"\r\n]+)['"]/gm;
  for (const m of source.matchAll(multiLineNamedRe)) {
    if (m[1]) targets.add(m[1]);
  }
  return Array.from(targets);
}

function selectBundleFiles(archiveFiles) {
  const selected = new Map();
  for (const [relPath, bytes] of archiveFiles) {
    if (!bytes?.length) continue;
    const parts = relPath.split("/");
    if (parts.includes("__pycache__") || /\.(?:pyc|pyo)$/i.test(relPath)) continue;
    if (BUNDLE_ROOT_FILES.has(relPath) || (parts.length >= 2 && BUNDLE_DIRS.has(parts[0]))) {
      selected.set(relPath, bytes);
    }
  }
  return selected;
}

function prepareReleaseFiles(archiveFiles, expectedVersion, context = {}) {
  if (REQUIRED_FILES.some((rel) => !archiveFiles.get(rel)?.length)) {
    throw new UpdateError("incomplete");
  }

  let manifest;
  let pkg;
  let sidecar;
  let hooks;
  try {
    manifest = JSON.parse(archiveFiles.get("plugin.json").toString("utf8").replace(/^\uFEFF/, ""));
    pkg = JSON.parse(archiveFiles.get("package.json").toString("utf8").replace(/^\uFEFF/, ""));
    sidecar = JSON.parse(archiveFiles.get(SIDECAR_MANIFEST).toString("utf8").replace(/^\uFEFF/, ""));
    hooks = JSON.parse(archiveFiles.get("hooks.json").toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new UpdateError("incomplete");
  }

  if (
    manifest?.name !== PLUGIN_NAME ||
    pkg?.name !== PLUGIN_NAME ||
    parseVersion(manifest?.version)?.version !== expectedVersion ||
    parseVersion(pkg?.version)?.version !== expectedVersion
  ) {
    throw new UpdateError("version");
  }

  if (
    sidecar?.command !== "node" ||
    !Array.isArray(sidecar?.args) ||
    sidecar.args[0] !== "server.mjs" ||
    !sidecar.args.every((arg) => typeof arg === "string") ||
    sidecar.restart_policy !== "always"
  ) {
    throw new UpdateError("incomplete");
  }

  if (!isValidHooksManifest(hooks)) {
    throw new UpdateError("incomplete");
  }

  if (!isValidVerifierRole(archiveFiles.get("agents/cmd-verifier.md").toString("utf8"))) {
    throw new UpdateError("incomplete");
  }

  const selectedFiles = selectBundleFiles(archiveFiles);
  for (const rel of REQUIRED_FILES) {
    if (!selectedFiles.has(rel)) {
      selectedFiles.set(rel, archiveFiles.get(rel));
    }
  }

  // Verify static relative imports across runtime JS modules without executing archive code.
  for (const [rel, bytes] of selectedFiles) {
    if (rel.startsWith("test/") || !/\.[cm]?js$/i.test(rel)) continue;
    const src = bytes.toString("utf8");
    for (const target of extractStaticRelativeImports(src)) {
      const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
      if (!selectedFiles.get(resolved)?.length) {
        throw new UpdateError("incomplete");
      }
    }
  }

  selectedFiles.set(
    SIDECAR_MANIFEST,
    preservePinnedNodeCommand(selectedFiles.get(SIDECAR_MANIFEST), context.installedSidecar)
  );
  return selectedFiles;
}

function isPreservedLocalFile(relPosix) {
  if (PRESERVED_HIDDEN_FILES.has(relPosix)) return true;
  if (/^rules\/[^/]+\.local\.md$/i.test(relPosix)) return true;
  return false;
}

async function listLiveFiles(rootDir, currentRel = "") {
  const absDir = currentRel ? join(rootDir, currentRel) : rootDir;
  const entries = await readdir(absDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relPosix = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (isPreservedLocalFile(relPosix)) continue;
    if (entry.isDirectory()) {
      results.push(...(await listLiveFiles(rootDir, relPosix)));
    } else {
      results.push(relPosix);
    }
  }
  return results;
}

async function removeEmptyDirsRecursive(dirPath, rootDir) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dirPath, entry.name);
    await removeEmptyDirsRecursive(child, rootDir);
  }
  if (!isSamePath(dirPath, rootDir)) {
    const after = await readdir(dirPath).catch(() => ["non-empty"]);
    if (after.length === 0) {
      await unlink(dirPath).catch(async () => {
        await rm(dirPath, { recursive: false, force: true }).catch(() => {});
      });
    }
  }
}

async function replaceInstalledFiles(
  root,
  stageDir,
  backupDir,
  expectedCurrentVersion,
  selectedRelPaths,
  move,
  {
    caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin",
    markerOptions = {},
    targetVersion = "",
    workDirName = ""
  } = {}
) {
  await mkdir(backupDir, { recursive: true });
  const markerPath = join(root, UPDATE_MARKER_NAME);
  await checkUpdateMarker(markerPath, markerOptions, true, move);

  const markerNow = markerOptions.now || Date.now;
  const token = randomBytes(8).toString("hex");
  const resolvedWorkDirName = workDirName || basename(dirname(stageDir));
  const workDir = dirname(stageDir);
  const journalPath = join(workDir, UPDATE_JOURNAL_NAME);

  const baseMarker = {
    schemaVersion: 2,
    pid: process.pid,
    token,
    source: "sidecar",
    startedAt: markerNow(),
    previousVersion: expectedCurrentVersion || "",
    targetVersion: targetVersion || "",
    workDirName: resolvedWorkDirName,
    journalFile: UPDATE_JOURNAL_NAME
  };

  try {
    await writeMarkerAtomic(markerPath, { ...baseMarker, phase: "staging" }, { exclusive: true });
  } catch (err) {
    if (err?.code === "EEXIST") throw new UpdateError("busy");
    throw new InstallError(err, UPDATE_MARKER_NAME);
  }

  const changes = [];
  let activePath = "plugin.json";

  async function moveTracked(from, to) {
    await mkdir(dirname(to), { recursive: true });
    await move(from, to);
    changes.push({ path: activePath, from, to });
  }

  try {
    const localManifest = await readDiskJson(root, "plugin.json");
    if (parseVersion(localManifest?.version)?.version !== expectedCurrentVersion) {
      throw new UpdateError("releaseChanged");
    }

    const normKey = (rel) => (caseInsensitiveFs ? rel.toLowerCase() : rel);
    const selectedKeySet = new Set(selectedRelPaths.map(normKey));
    const liveFiles = await listLiveFiles(root);
    const obsoleteFiles = liveFiles.filter((rel) => !selectedKeySet.has(normKey(rel)));

    // Guard against symlinked intermediate directories before modifying live files.
    for (const rel of selectedRelPaths) {
      activePath = rel;
      await assertNoIntermediateSymlink(root, rel);
    }

    // Order replacements so server.mjs and plugin.json land last.
    const tail = new Set([`${SIDECAR_REL_DIR}/server.mjs`, "plugin.json"]);
    const orderedInstall = [
      ...selectedRelPaths.filter((rel) => !tail.has(rel)),
      ...selectedRelPaths.filter((rel) => tail.has(rel))
    ];

    const preexistingPaths = [];
    for (const rel of orderedInstall) {
      const existing = await safeLstat(join(root, rel));
      if (existing) {
        if (existing.isDirectory()) throw new UpdateError("pathConflict");
        preexistingPaths.push(rel);
      }
    }

    // Persist crash-recovery journal BEFORE transitioning marker to `replacing` and mutating live files.
    const journalRecord = {
      schemaVersion: 2,
      token,
      source: "sidecar",
      previousVersion: expectedCurrentVersion || "",
      targetVersion: targetVersion || "",
      freshInstall: false,
      orderedInstall,
      preexistingPaths,
      obsoleteFiles
    };
    await writeFile(journalPath, JSON.stringify(journalRecord, null, 2) + "\n", "utf8");
    await writeMarkerAtomic(markerPath, { ...baseMarker, phase: "replacing" });

    for (const rel of orderedInstall) {
      activePath = rel;
      const incoming = join(stageDir, rel);
      const live = join(root, rel);
      const existing = await safeLstat(live);
      if (existing) {
        if (existing.isDirectory()) throw new UpdateError("pathConflict");
        const saved = join(backupDir, "prev", rel);
        await moveTracked(live, saved);
      }
      await moveTracked(incoming, live);
    }

    for (const rel of obsoleteFiles) {
      activePath = rel;
      const live = join(root, rel);
      const existing = await safeLstat(live);
      if (existing && !existing.isDirectory()) {
        const saved = join(backupDir, "obsolete", rel);
        await moveTracked(live, saved);
      }
    }

    await removeEmptyDirsRecursive(root, root).catch(() => {});
    await writeMarkerAtomic(markerPath, { ...baseMarker, phase: "committed" });
    activePath = UPDATE_MARKER_NAME;
    await unlink(markerPath);
  } catch (err) {
    const failedPath = activePath;
    const restored = changes.length > 0;
    try {
      for (const { path: relPath, from, to } of [...changes].reverse()) {
        activePath = relPath;
        await mkdir(dirname(from), { recursive: true });
        await move(to, from);
      }
      activePath = UPDATE_MARKER_NAME;
      await unlink(markerPath);
    } catch (rollbackErr) {
      await writeMarkerAtomic(markerPath, {
        ...baseMarker,
        startedAt: markerNow(),
        phase: "recovery"
      }).catch(() => {});
      throw new InstallError(rollbackErr, activePath, { recovery: true });
    }
    throw new InstallError(err, failedPath, { restored });
  }
}

const RELEASE_ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const ASSET_FILENAME = /^[a-z0-9][a-z0-9._+-]*\.(?:zip|tgz)$/i;

export function verifiedAssetIdentity({ assetName, assetUrl, assetSha256 }, { strictNameMatch = false } = {}) {
  if (typeof assetUrl !== "string" || !assetUrl.startsWith(RELEASE_ASSET_PREFIX)) return null;
  if (typeof assetSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(assetSha256)) return null;
  if (assetName !== undefined && (typeof assetName !== "string" || !ASSET_FILENAME.test(assetName))) return null;

  // GitHub may encode the plus sign of SemVer build metadata in the download URL.
  const parts = assetUrl.slice(RELEASE_ASSET_PREFIX.length).replace(/%2b/gi, "+").split("/");
  if (parts.length !== 2 || !/^[a-z0-9][a-z0-9.+-]*$/i.test(parts[0]) || !ASSET_FILENAME.test(parts[1])) {
    return null;
  }
  if (strictNameMatch && assetName !== undefined && assetName !== parts[1]) {
    return null;
  }
  return { ...(assetName !== undefined && { assetName }), assetUrl, assetSha256: assetSha256.toLowerCase() };
}

/**
 * Evaluate whether a discovered release qualifies for opt-in silent auto-install:
 * requires same major version, a verified SHA-256 release asset, and no open failure
 * circuit breaker for the same target version.
 */
export function evaluateAutoInstallEligibility({ release, currentVersion, failedVersion = "" } = {}) {
  const cur = parseVersion(currentVersion);
  if (!cur) return { eligible: false, skipReason: "invalidVersion" };
  if (!release || release.status !== "update") {
    return { eligible: false, skipReason: "notUpdate" };
  }
  const latest = parseVersion(release.latestVersion);
  const tagParsed = parseVersion(release.releaseTag);
  if (
    !latest ||
    !tagParsed ||
    latest.pre.length > 0 ||
    tagParsed.pre.length > 0 ||
    latest.version !== tagParsed.version
  ) {
    return { eligible: false, skipReason: "invalidVersion" };
  }
  if (compareVersions(latest.version, cur.version) !== 1) {
    return { eligible: false, skipReason: "notUpdate" };
  }
  if (cur.core[0] !== latest.core[0]) {
    return { eligible: false, skipReason: "majorUpgrade", targetVersion: latest.version };
  }
  const expectedAsset = verifiedAssetIdentity(release);
  if (!expectedAsset) {
    return { eligible: false, skipReason: "noVerifiedAsset", targetVersion: latest.version };
  }
  const failedParsed = parseVersion(failedVersion);
  if (failedParsed && failedParsed.version === latest.version) {
    return { eligible: false, skipReason: "failedCircuitOpen", targetVersion: latest.version };
  }
  return { eligible: true, skipReason: null, targetVersion: latest.version, expectedAsset };
}

/**
 * Create an atomic, rollback-safe self-updater for an installed agy-cmd plugin directory.
 */
export function createPluginUpdater({
  sidecarDirectory,
  checkVersion,
  pluginsDirectory = process.env.AGY_CMD_PLUGINS_DIR || "",
  allowCustomRoot = false,
  downloadOptions,
  move = rename,
  caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin",
  markerOptions = {}
} = {}) {
  let busy = false;
  const failure = (reason, step, details = {}) => ({
    ok: false,
    status: "error",
    reason,
    diagnostics: { step, ...details }
  });

  return async function update(expectedVersion, { expectedAsset } = {}) {
    if (busy) return failure("busy", "start");
    busy = true;
    let workDir;
    let stagedFile;
    let keepBackup = false;
    let step = "start";

    try {
      const parsedExpected = parseVersion(expectedVersion);
      if (!parsedExpected) throw new UpdateError("releaseChanged");
      const targetVersion = parsedExpected.version;
      const pinned = expectedAsset && verifiedAssetIdentity(expectedAsset);
      if (expectedAsset !== undefined && !pinned) throw new UpdateError("releaseChanged");

      step = "inspect";
      const root = await resolveInstalledRoot(sidecarDirectory, { pluginsDirectory, allowCustomRoot });
      await checkUpdateMarker(join(root, UPDATE_MARKER_NAME), markerOptions, false, move);
      const localManifest = await readDiskJson(root, "plugin.json");
      const currentVersion = parseVersion(localManifest?.version)?.version;
      if (!currentVersion || localManifest?.name !== PLUGIN_NAME) {
        throw new UpdateError("notInstalled");
      }
      const installedSidecar = await readDiskJson(root, SIDECAR_MANIFEST);

      step = "verify-release";
      const release = await checkVersion("manual", { fresh: true });
      if (release?.reason === "rateLimit") {
        return { ...failure("rateLimit", step), retryAt: release.retryAt };
      }
      if (release?.status === "error") {
        throw new UpdateError(release.reason === "timeout" ? "timeout" : "releaseCheck");
      }
      const releaseParsed = parseVersion(release?.releaseTag);
      if (
        !releaseParsed ||
        releaseParsed.pre.length > 0 ||
        releaseParsed.version !== release?.latestVersion ||
        releaseParsed.version !== targetVersion ||
        compareVersions(releaseParsed.version, currentVersion) !== 1 ||
        release?.status !== "update"
      ) {
        throw new UpdateError("releaseChanged");
      }

      const asset = verifiedAssetIdentity(release);
      if (!asset) throw new UpdateError("noVerifiedAsset");
      if (pinned && (
        pinned.assetUrl !== asset.assetUrl ||
        pinned.assetSha256 !== asset.assetSha256 ||
        (pinned.assetName !== undefined && pinned.assetName !== asset.assetName)
      )) {
        throw new UpdateError("releaseChanged");
      }

      step = "download";
      const archiveBuffer = await downloadArchive(asset.assetUrl, {
        ...downloadOptions,
        expectedSha256: asset.assetSha256
      });

      step = "validate-archive";
      const archiveFiles = await readReleaseArchive(archiveBuffer);
      const selectedFiles = prepareReleaseFiles(archiveFiles, releaseParsed.version, {
        installedSidecar
      });

      step = "stage";
      workDir = await mkdtemp(join(dirname(root), UPDATE_WORK_PREFIX));
      const stageDir = join(workDir, "next");
      for (const [relPath, bytes] of selectedFiles) {
        stagedFile = relPath;
        const destination = join(stageDir, relPath);
        await mkdir(dirname(destination), { recursive: true });
        const writeOpts =
          process.platform !== "win32" && shouldPreserveExecutableMode(relPath, bytes)
            ? { flag: "wx", mode: 0o755 }
            : { flag: "wx" };
        await writeFile(destination, bytes, writeOpts);
      }

      step = "replace";
      await replaceInstalledFiles(
        root,
        stageDir,
        join(workDir, "backup"),
        currentVersion,
        Array.from(selectedFiles.keys()),
        move,
        {
          caseInsensitiveFs,
          markerOptions,
          targetVersion: releaseParsed.version,
          workDirName: basename(workDir)
        }
      );

      return {
        ok: true,
        status: "updated",
        previousVersion: currentVersion,
        version: releaseParsed.version,
        releaseTag: release.releaseTag,
        releaseUrl: release.releaseUrl,
        verifiedAssetName: asset.assetName || "",
        verifiedSha256: asset.assetSha256
      };
    } catch (error) {
      const failureError =
        error instanceof UpdateError ? error : new InstallError(error, step === "stage" ? stagedFile : undefined);
      keepBackup = failureError.reason === "recovery";
      return failure(failureError.reason, keepBackup ? "rollback" : step, failureError.diagnostics);
    } finally {
      if (workDir && !keepBackup) {
        await rm(workDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
      busy = false;
    }
  };
}
