import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIN_RETRY_MAX = 1;
export const MAX_RETRY_MAX = 50;
export const DEFAULT_RETRY_MAX = 3;

export const VALID_RETRY_MODES = new Set(["off", "count", "infinite"]);
export const VALID_RETRY_SCOPES = new Set(["goal_only", "all_failures"]);
export const VALID_PLAN_TIERS = new Set(["free", "paid"]);

const CN_DIGIT_MAP = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

const OVERRIDE_OFF_RE =
  /(?:不(?:用|要|需|必)?(?:自动)?重试|别(?:自动)?重试|禁止(?:自动)?重试|取消(?:自动)?重试|(?:自动)?重试\s*0\s*次|\b(?:no\s+(?:auto[- ]?)?retr(?:y|ies)|do\s+not\s+retry|don'?t\s+retry|zero\s+retries)\b)/i;

const OVERRIDE_INFINITE_RE =
  /(?:一直(?:自动)?重试|无限(?:次)?(?:自动)?重试|不停(?:地)?(?:自动)?重试|无上限(?:自动)?重试|重试到(?:全部|所有)?(?:测试|单测|构建|编译)?(?:通过|全绿|修好|成功)(?:为止)?|\b(?:retry\s+(?:infinitely|forever|indefinitely|until\s+(?:green|all\s+pass|passing))|infinite\s+retries)\b)/i;

const OVERRIDE_COUNT_ZH_RE =
  /(?:(?:最多|至多|自动|连续|上限)\s*重试|重试(?:\s*(?:上限|次数))?(?:\s*(?:为|设为|最多|至多))?)\s*([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*次/i;

const OVERRIDE_COUNT_EN_RE =
  /\b(?:auto[- ]?)?retry\s+(?:up\s+to\s+|at\s+most\s+|max\s+)?([0-9]{1,3})\s+times?\b/i;

const GLOBAL_CONFIG_MUTATION_RE =
  /(?:把\s*(?:cmd|agy[-_]?cmd)?\s*(?:自动)?重试(?:次数|模式|档位)?\s*(?:改成|设为|调成|调到|设置为)|修改\s*(?:自动)?重试配置)/i;

export function createDefaultSettings() {
  return {
    version: 1,
    // Default strictly to Free-Tier Safe Mode so non-subscribers never hit /boost errors.
    planTier: "free",
    boostEnabled: false,
    autoRetryMode: "count",
    autoRetryMax: DEFAULT_RETRY_MAX,
    autoRetryScope: "goal_only",
    freeFallbackEnabled: true,
    planFallbackEnabled: true,
    configuredByUser: false,
    onboardingShown: false,
    stats: {
      totalAutoRetries: 0,
      lastAutoRetryAt: "",
      lastAutoRetryConvId: ""
    },
    updatedAt: ""
  };
}

export function getSettingsFilePath(stateDir) {
  return path.join(stateDir, "settings.json");
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpName = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpName, content, "utf8");
    try {
      fs.renameSync(tmpName, filePath);
    } catch (err) {
      if (process.platform === "win32" && (err?.code === "EPERM" || err?.code === "EBUSY")) {
        fs.writeFileSync(filePath, content, "utf8");
        try {
          fs.unlinkSync(tmpName);
        } catch {}
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpName);
    } catch {}
    throw err;
  }
}

export function clampRetryMax(val, fallback = DEFAULT_RETRY_MAX) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RETRY_MAX, Math.max(MIN_RETRY_MAX, Math.floor(n)));
}

export function normalizeSettings(raw = {}) {
  const def = createDefaultSettings();
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  const planTier = VALID_PLAN_TIERS.has(src.planTier) ? src.planTier : def.planTier;
  // In free tier, boostEnabled is forcibly false in effective evaluation, and normalized cleanly:
  const rawBoost = typeof src.boostEnabled === "boolean" ? src.boostEnabled : def.boostEnabled;
  const boostEnabled = planTier === "paid" ? rawBoost : false;

  const autoRetryMode = VALID_RETRY_MODES.has(src.autoRetryMode)
    ? src.autoRetryMode
    : def.autoRetryMode;
  const autoRetryMax = clampRetryMax(src.autoRetryMax, def.autoRetryMax);
  const autoRetryScope = VALID_RETRY_SCOPES.has(src.autoRetryScope)
    ? src.autoRetryScope
    : def.autoRetryScope;

  const freeFallbackEnabled =
    typeof src.freeFallbackEnabled === "boolean" ? src.freeFallbackEnabled : def.freeFallbackEnabled;
  const planFallbackEnabled =
    typeof src.planFallbackEnabled === "boolean" ? src.planFallbackEnabled : def.planFallbackEnabled;
  const configuredByUser =
    typeof src.configuredByUser === "boolean" ? src.configuredByUser : def.configuredByUser;
  const onboardingShown =
    typeof src.onboardingShown === "boolean" ? src.onboardingShown : def.onboardingShown;

  const rawStats = src.stats && typeof src.stats === "object" ? src.stats : {};
  const totalAutoRetries =
    Number.isFinite(Number(rawStats.totalAutoRetries)) && Number(rawStats.totalAutoRetries) >= 0
      ? Math.floor(Number(rawStats.totalAutoRetries))
      : 0;

  return {
    version: 1,
    planTier,
    boostEnabled,
    autoRetryMode,
    autoRetryMax,
    autoRetryScope,
    freeFallbackEnabled,
    planFallbackEnabled,
    configuredByUser,
    onboardingShown,
    stats: {
      totalAutoRetries,
      lastAutoRetryAt: typeof rawStats.lastAutoRetryAt === "string" ? rawStats.lastAutoRetryAt : "",
      lastAutoRetryConvId:
        typeof rawStats.lastAutoRetryConvId === "string" ? rawStats.lastAutoRetryConvId : ""
    },
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : ""
  };
}

export function readSettings(stateDir) {
  const filePath = getSettingsFilePath(stateDir);
  try {
    if (!fs.existsSync(filePath)) {
      return createDefaultSettings();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeSettings(raw);
  } catch {
    return createDefaultSettings();
  }
}

export function writeSettings(stateDir, settings) {
  const normalized = normalizeSettings(settings);
  const filePath = getSettingsFilePath(stateDir);
  writeFileAtomic(filePath, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

/**
 * Validate and apply a partial settings patch atomically.
 * Throws an Error with `statusCode = 400` if explicit invalid fields are sent.
 */
export function updateSettings(stateDir, patch = {}, options = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const err = new Error("Settings patch must be a JSON object");
    err.statusCode = 400;
    throw err;
  }

  const current = readSettings(stateDir);
  const next = { ...current, stats: { ...current.stats } };

  if ("planTier" in patch) {
    if (!VALID_PLAN_TIERS.has(patch.planTier)) {
      const err = new Error(`Invalid planTier '${patch.planTier}'. Expected 'free' or 'paid'.`);
      err.statusCode = 400;
      throw err;
    }
    next.planTier = patch.planTier;
    // If switching to paid and boostEnabled was not explicitly specified, enable boost by default;
    // if switching to free, force boostEnabled off to prevent free-tier /boost errors.
    if (patch.planTier === "free") {
      next.boostEnabled = false;
    } else if (patch.planTier === "paid" && !("boostEnabled" in patch) && current.planTier === "free") {
      next.boostEnabled = true;
    }
  }

  if ("boostEnabled" in patch) {
    if (typeof patch.boostEnabled !== "boolean") {
      const err = new Error("boostEnabled must be a boolean");
      err.statusCode = 400;
      throw err;
    }
    if (patch.boostEnabled && next.planTier !== "paid") {
      // Switching boost on automatically upgrades planTier to paid only if explicitly requested via allowTierPromote,
      // otherwise reject or promote cleanly: promoting to "paid" when user toggles "开启 Boost (需会员)" in UI is ergonomic,
      // UNLESS planTier: "free" was sent in the exact same patch!
      if (patch.planTier === "free") {
        next.boostEnabled = false;
      } else {
        next.planTier = "paid";
        next.boostEnabled = true;
      }
    } else {
      next.boostEnabled = patch.boostEnabled;
    }
  }

  if ("autoRetryMode" in patch) {
    if (!VALID_RETRY_MODES.has(patch.autoRetryMode)) {
      const err = new Error(
        `Invalid autoRetryMode '${patch.autoRetryMode}'. Expected 'off', 'count', or 'infinite'.`
      );
      err.statusCode = 400;
      throw err;
    }
    next.autoRetryMode = patch.autoRetryMode;
  }

  if ("autoRetryMax" in patch) {
    const rawNum = Number(patch.autoRetryMax);
    if (!Number.isFinite(rawNum) || rawNum < MIN_RETRY_MAX || rawNum > MAX_RETRY_MAX) {
      const err = new Error(
        `autoRetryMax must be an integer between ${MIN_RETRY_MAX} and ${MAX_RETRY_MAX}.`
      );
      err.statusCode = 400;
      throw err;
    }
    next.autoRetryMax = Math.floor(rawNum);
  }

  if ("autoRetryScope" in patch) {
    if (!VALID_RETRY_SCOPES.has(patch.autoRetryScope)) {
      const err = new Error(
        `Invalid autoRetryScope '${patch.autoRetryScope}'. Expected 'goal_only' or 'all_failures'.`
      );
      err.statusCode = 400;
      throw err;
    }
    next.autoRetryScope = patch.autoRetryScope;
  }

  if ("freeFallbackEnabled" in patch) {
    if (typeof patch.freeFallbackEnabled !== "boolean") {
      const err = new Error("freeFallbackEnabled must be a boolean");
      err.statusCode = 400;
      throw err;
    }
    next.freeFallbackEnabled = patch.freeFallbackEnabled;
  }

  if ("planFallbackEnabled" in patch) {
    if (typeof patch.planFallbackEnabled !== "boolean") {
      const err = new Error("planFallbackEnabled must be a boolean");
      err.statusCode = 400;
      throw err;
    }
    next.planFallbackEnabled = patch.planFallbackEnabled;
  }

  if ("configuredByUser" in patch && typeof patch.configuredByUser === "boolean") {
    next.configuredByUser = patch.configuredByUser;
  } else if (options.markConfigured !== false) {
    next.configuredByUser = true;
    next.onboardingShown = true;
  }

  if ("onboardingShown" in patch && typeof patch.onboardingShown === "boolean") {
    next.onboardingShown = patch.onboardingShown;
  }

  if (patch.resetStats === true) {
    next.stats = {
      totalAutoRetries: 0,
      lastAutoRetryAt: "",
      lastAutoRetryConvId: ""
    };
  }

  next.updatedAt = options.nowIso || new Date().toISOString();
  return writeSettings(stateDir, next);
}

export function recordAutoRetryStat(stateDir, convId, nowIso = new Date().toISOString()) {
  try {
    const current = readSettings(stateDir);
    current.stats = {
      totalAutoRetries: (current.stats?.totalAutoRetries || 0) + 1,
      lastAutoRetryAt: nowIso,
      lastAutoRetryConvId: typeof convId === "string" ? convId.slice(0, 36) : ""
    };
    writeSettings(stateDir, current);
  } catch {
    // Non-critical telemetry; never fail Stop hook
  }
}

export function parseChineseOrArabicInt(token) {
  if (typeof token !== "string" || !token.trim()) return null;
  const s = token.trim();
  if (/^\d+$/.test(s)) {
    return Number.parseInt(s, 10);
  }
  if (s === "十") return 10;
  if (s.length === 1 && s in CN_DIGIT_MAP) {
    return CN_DIGIT_MAP[s];
  }
  if (s.startsWith("十") && s.length === 2 && s[1] in CN_DIGIT_MAP) {
    return 10 + CN_DIGIT_MAP[s[1]];
  }
  if (s.endsWith("十") && s.length === 2 && s[0] in CN_DIGIT_MAP) {
    return CN_DIGIT_MAP[s[0]] * 10;
  }
  if (s.length === 3 && s[1] === "十" && s[0] in CN_DIGIT_MAP && s[2] in CN_DIGIT_MAP) {
    return CN_DIGIT_MAP[s[0]] * 10 + CN_DIGIT_MAP[s[2]];
  }
  return null;
}

/**
 * Parse single-turn natural-language retry overrides from user prompt prose
 * (e.g., "这次不用重试", "最多重试 5 次", "一直重试到全绿").
 * Returns null if no per-turn override phrase is present.
 */
export function parseTurnRetryOverride(proseText) {
  if (typeof proseText !== "string" || !proseText.trim()) return null;
  // Do not treat global settings mutation requests ("把自动重试改成 5 次") as a per-turn execution loop
  if (GLOBAL_CONFIG_MUTATION_RE.test(proseText)) {
    return null;
  }
  if (OVERRIDE_OFF_RE.test(proseText)) {
    return { mode: "off", max: 0 };
  }
  if (OVERRIDE_INFINITE_RE.test(proseText)) {
    return { mode: "infinite", max: null };
  }
  const mZh = proseText.match(OVERRIDE_COUNT_ZH_RE);
  if (mZh) {
    const n = parseChineseOrArabicInt(mZh[1]);
    if (n === 0) return { mode: "off", max: 0 };
    if (n !== null && n > 0) {
      return { mode: "count", max: clampRetryMax(n) };
    }
  }
  const mEn = proseText.match(OVERRIDE_COUNT_EN_RE);
  if (mEn) {
    const n = Number.parseInt(mEn[1], 10);
    if (n === 0) return { mode: "off", max: 0 };
    if (Number.isFinite(n) && n > 0) {
      return { mode: "count", max: clampRetryMax(n) };
    }
  }
  return null;
}

export function formatRetrySummaryZh(settings = {}) {
  const s = normalizeSettings(settings);
  const scopeLabel = s.autoRetryScope === "all_failures" ? "所有测试失败均触发" : "口令触发";
  if (s.autoRetryMode === "off") {
    return "不用重试（已关闭）";
  }
  if (s.autoRetryMode === "infinite") {
    return `一直重试直至全绿（${scopeLabel}）`;
  }
  return `最多重试 ${s.autoRetryMax} 次（${scopeLabel}）`;
}
