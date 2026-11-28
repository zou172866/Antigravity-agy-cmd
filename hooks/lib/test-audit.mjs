import path from "node:path";

export const SOURCE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|c(?:pp|xx)?|h(?:pp)?|rb|php|swift|dart|sh|ps1)$/i;
export const EXAMPLE =
  /(?:^|[\\/])(?:examples?|templates?|fixtures?|node_modules|vendor|dist|build|\.git)(?:[\\/]|$)|(?:\.example|\.sample|\.template)\./i;

export function pathKey(p) {
  if (typeof p !== "string" || !p) return "";
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function decoded(value) {
  if (typeof value === "string" && /^\s*["\[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

export function sourceText(value) {
  if (typeof value === "string" && value.startsWith('"')) {
    const unquoted = decoded(value);
    if (typeof unquoted === "string") return unquoted;
  }
  return value;
}

export function inside(root, target) {
  const rel = path.relative(pathKey(root), pathKey(target));
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
}

// ============================================================================
// Frozen Rules: Test Assertion Weakening Soft Audit (zero extra file I/O)
// ============================================================================

const TEST_FILE_RE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|(?:^|[\\/])tests[\\/](?:[^\\/]+[\\/])*[^\\/]+\.rs$|(?:Test|Tests|Spec)\.(?:java|kt|cs|dart|swift)$|_(?:test|spec)\.(?:rb|dart|ex|exs)$)/i;
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

const JS_REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "new",
  "yield",
  "await",
  "instanceof",
  "else",
  "do"
]);
const JS_REGEX_PREFIX_PUNCT_RE = /^[([,=:;!&|?{}+~^%<>-]$/;

const SKIP_OPT_FALSE_RE = /(?:^|[{,\s])skip\s*:\s*false\b/gm;
const SKIP_OPT_TRUE_RE = /(?:^|[{,\s])skip\s*:\s*true\b/gm;

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

export function normalizeRelativeAuditPath(filePath) {
  const posix = toAuditPosixPath(stripAuditQuotes(filePath));
  if (!posix) return "";
  return path.posix.normalize(posix).replace(/^\.\//, "");
}

export function canonicalTestFileKey(rawFile, cwd = "") {
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
 * Lightweight single-pass lexer that masks comments, string literals, and single-line
 * JS/TS regex literals (preserving newlines and JS/TS template `${...}` expressions)
 * so hunk regexes ignore strings/patterns like `"test.skip("` or `/a'b/` with zero file I/O.
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
  let regexAllowed = true;
  let afterDot = false;

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
        regexAllowed = true;
        afterDot = false;
        return;
      }
      if (ch === "`") {
        out.push("`");
        i += 1;
        regexAllowed = false;
        afterDot = false;
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

    if (isJsTs && regexAllowed && ch === "/" && next !== "/" && next !== "*") {
      let j = i + 1;
      let inCharClass = false;
      let closed = -1;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") {
        const rch = text[j];
        if (rch === "\\") {
          j += 2;
          continue;
        }
        if (rch === "[") {
          inCharClass = true;
        } else if (rch === "]" && inCharClass) {
          inCharClass = false;
        } else if (rch === "/" && !inCharClass) {
          closed = j;
          break;
        }
        j += 1;
      }
      if (closed > i) {
        out.push("/", " ".repeat(closed - i - 1), "/");
        i = closed + 1;
        while (i < n && /[a-zA-Z]/.test(text[i])) {
          out.push(text[i]);
          i += 1;
        }
        regexAllowed = false;
        afterDot = false;
        continue;
      }
    }

    if (isJsTs && templateBraceDepths.length > 0) {
      if (ch === "{") {
        templateBraceDepths[templateBraceDepths.length - 1] += 1;
        out.push("{");
        i += 1;
        regexAllowed = true;
        afterDot = false;
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
        regexAllowed = true;
        afterDot = false;
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
      regexAllowed = false;
      afterDot = false;
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
      regexAllowed = false;
      afterDot = false;
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
      regexAllowed = false;
      afterDot = false;
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

    if (isJsTs) {
      if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < n && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
        const word = text.slice(i, end);
        out.push(word);
        regexAllowed = !afterDot && JS_REGEX_PREFIX_KEYWORDS.has(word);
        afterDot = false;
        i = end;
        continue;
      }
      if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
        out.push(ch, next);
        i += 2;
        regexAllowed = false;
        afterDot = false;
        continue;
      }
      if (!/\s/.test(ch)) {
        if (ch === ".") {
          afterDot = true;
          regexAllowed = false;
        } else {
          afterDot = false;
          if (ch === ")" || ch === "]" || /[0-9]/.test(ch)) {
            regexAllowed = false;
          } else if (ch === "}" || ch === "/" || JS_REGEX_PREFIX_PUNCT_RE.test(ch)) {
            regexAllowed = true;
          }
        }
      }
    }

    out.push(ch);
    i += 1;
  }

  return out.join("");
}

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

export function matchAppliedFileEntries(details, appliedFiles, cwd = "", exactOnly = false) {
  const matched = new Set();
  const unmatched = [];
  for (const rawApplied of appliedFiles) {
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
    if (exactHits.length > 1 || exactOnly) {
      unmatched.push(rawApplied);
      continue;
    }

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
    } else {
      unmatched.push(rawApplied);
    }
  }
  return { matched, unmatched };
}

export function filterTestWeakeningByAppliedFiles(weakening, details, partialReceipt, cwd = "") {
  if (!weakening) return null;
  if (!partialReceipt?.isPartial) return weakening;
  if (!details?.length || !partialReceipt.appliedFiles?.length) return null;
  const { matched } = matchAppliedFileEntries(details, partialReceipt.appliedFiles, cwd);

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
