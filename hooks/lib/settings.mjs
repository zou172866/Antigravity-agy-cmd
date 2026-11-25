import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIN_RETRY_MAX = 1;
export const MAX_RETRY_MAX = 50;
export const DEFAULT_RETRY_MAX = 3;
export const MAX_DELIVERY_CMD_LEN = 240;
export const SETTINGS_VERSION = 2;

export const GITHUB_REPO_URL = "https://github.com/zou172866/Antigravity-agy-cmd";
export const GH_STAR_COMMAND = "gh api -X PUT /user/starred/zou172866/Antigravity-agy-cmd";
export const STAR_PROMPT_STATES = Object.freeze(["pending", "clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_TERMINAL_STATES = Object.freeze(["clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_MIN_AUTO_RETRIES = 3;

export const VALID_RETRY_MODES = new Set(["off", "count", "infinite"]);
export const VALID_RETRY_SCOPES = new Set(["smart", "all_failures", "goal_only"]);
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
    version: SETTINGS_VERSION,
    // Default strictly to Free-Tier Safe Mode so non-subscribers never hit /boost errors.
    planTier: "free",
    boostEnabled: false,
    boostAfterPlanApproval: false,
    freePlanReviewEnabled: false,
    autoRetryMode: "count",
    autoRetryMax: DEFAULT_RETRY_MAX,
    autoRetryScope: "smart",
    deliveryTestGateEnabled: false,
    deliveryTestCommand: "",
    freeFallbackEnabled: true,
    planFallbackEnabled: true,
    configuredByUser: false,
    onboardingShown: false,
    stats: {
      totalAutoRetries: 0,
      lastAutoRetryAt: "",
      lastAutoRetryConvId: ""
    },
    starPrompt: {
      state: "pending",
      triggeredAt: null,
      resolvedAt: null,
      milestoneAutoRetries: 0
    },
    updatedAt: ""
  };
}

export function normalizeStarPromptState(raw) {
  const defaults = {
    state: "pending",
    triggeredAt: null,
    resolvedAt: null,
    milestoneAutoRetries: 0
  };
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ...defaults };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ...defaults };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...defaults };
  }
  let src = obj;
  if (Object.prototype.hasOwnProperty.call(obj, "starPrompt")) {
    src =
      obj.starPrompt && typeof obj.starPrompt === "object" && !Array.isArray(obj.starPrompt)
        ? obj.starPrompt
        : null;
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ...defaults };
  }
  const state =
    typeof src.state === "string" && STAR_PROMPT_STATES.includes(src.state) ? src.state : "pending";
  const normIso = (v) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= 64 ? t : null;
  };
  let milestoneAutoRetries = 0;
  const rawCount = src.milestoneAutoRetries;
  if (typeof rawCount === "number" || (typeof rawCount === "string" && rawCount.trim() !== "")) {
    const n = Number(rawCount);
    if (Number.isFinite(n) && n >= 0) {
      milestoneAutoRetries = Math.floor(n);
    }
  }
  return {
    state,
    triggeredAt: normIso(src.triggeredAt),
    resolvedAt: normIso(src.resolvedAt),
    milestoneAutoRetries
  };
}

export function getSettingsFilePath(stateDir) {
  return path.join(stateDir, "settings.json");
}

const STAR_LOCK_STALE_MS = 2000;
const STAR_LOCK_MAX_WAIT_MS = 320;
const STAR_LOCK_STEP_MS = 8;
const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(WAIT_BUF, 0, 0, ms);
  } catch {}
}

function withSettingsLock(stateDir, fn) {
  let lockFd = null;
  const lockPath = path.join(stateDir, ".settings.lock");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const deadline = Date.now() + STAR_LOCK_MAX_WAIT_MS;
    while (true) {
      try {
        lockFd = fs.openSync(lockPath, "wx");
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") {
          break;
        }
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > STAR_LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        if (Date.now() >= deadline) {
          break;
        }
        sleepSyncMs(STAR_LOCK_STEP_MS);
      }
    }
  } catch {
    // Fail open if stateDir is unwritable
  }

  try {
    return fn();
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpName = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpName, content, "utf8");
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.renameSync(tmpName, filePath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const retryable =
          process.platform === "win32" &&
          (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES");
        if (!retryable) {
          throw err;
        }
        sleepSyncMs(10 * (attempt + 1));
      }
    }
    if (lastErr) {
      fs.writeFileSync(filePath, content, "utf8");
      try {
        fs.unlinkSync(tmpName);
      } catch {}
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

export function sanitizeDeliveryTestCommand(raw, { strict = false } = {}) {
  if (strict) {
    if (typeof raw !== "string") {
      const err = new Error("deliveryTestCommand must be a string");
      err.statusCode = 400;
      throw err;
    }
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(raw)) {
      const err = new Error("deliveryTestCommand must be a single-line command without control characters");
      err.statusCode = 400;
      throw err;
    }
    const normalized = raw.trim().replace(/[ \t]+/g, " ");
    if (normalized.length > MAX_DELIVERY_CMD_LEN) {
      const err = new Error(`deliveryTestCommand must be at most ${MAX_DELIVERY_CMD_LEN} characters`);
      err.statusCode = 400;
      throw err;
    }
    return normalized;
  }
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .replace(/[ \t]+/g, " ")
    .slice(0, MAX_DELIVERY_CMD_LEN);
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
  const isLegacyUnconfiguredGoalOnly =
    Number(src.version) === 1 &&
    src.configuredByUser === false &&
    src.autoRetryScope === "goal_only";
  const autoRetryScope = isLegacyUnconfiguredGoalOnly
    ? "smart"
    : VALID_RETRY_SCOPES.has(src.autoRetryScope)
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
    version: SETTINGS_VERSION,
    planTier,
    boostEnabled,
    boostAfterPlanApproval: typeof src.boostAfterPlanApproval === "boolean"
      ? src.boostAfterPlanApproval : def.boostAfterPlanApproval,
    freePlanReviewEnabled: src.freePlanReviewEnabled === true,
    autoRetryMode,
    autoRetryMax,
    autoRetryScope,
    deliveryTestGateEnabled: src.deliveryTestGateEnabled === true,
    deliveryTestCommand: sanitizeDeliveryTestCommand(src.deliveryTestCommand, { strict: false }),
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
    starPrompt: normalizeStarPromptState(src.starPrompt),
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : ""
  };
}

export function readSettings(stateDir) {
  const filePath = getSettingsFilePath(stateDir);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!fs.existsSync(filePath)) {
        return createDefaultSettings();
      }
      const text = fs.readFileSync(filePath, "utf8");
      if (!text.trim() && attempt < 3) {
        sleepSyncMs(8 * (attempt + 1));
        continue;
      }
      const raw = JSON.parse(text);
      return normalizeSettings(raw);
    } catch (err) {
      const retryable =
        attempt < 3 &&
        (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "EACCES");
      if (retryable) {
        sleepSyncMs(8 * (attempt + 1));
        continue;
      }
      return createDefaultSettings();
    }
  }
  return createDefaultSettings();
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

  return withSettingsLock(stateDir, () => {
    const current = readSettings(stateDir);
    const next = {
      ...current,
      stats: { ...current.stats },
      starPrompt: normalizeStarPromptState(current.starPrompt)
    };

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
          `Invalid autoRetryScope '${patch.autoRetryScope}'. Expected 'smart', 'all_failures', or 'goal_only'.`
        );
        err.statusCode = 400;
        throw err;
      }
      next.autoRetryScope = patch.autoRetryScope;
    }

    if ("deliveryTestGateEnabled" in patch) {
      if (typeof patch.deliveryTestGateEnabled !== "boolean") {
        const err = new Error("deliveryTestGateEnabled must be a boolean");
        err.statusCode = 400;
        throw err;
      }
      next.deliveryTestGateEnabled = patch.deliveryTestGateEnabled;
    }

    if ("deliveryTestCommand" in patch) {
      next.deliveryTestCommand = sanitizeDeliveryTestCommand(patch.deliveryTestCommand, { strict: true });
    }

    if ("boostAfterPlanApproval" in patch) {
      if (typeof patch.boostAfterPlanApproval !== "boolean") {
        const err = new Error("boostAfterPlanApproval must be a boolean");
        err.statusCode = 400;
        throw err;
      }
      next.boostAfterPlanApproval = patch.boostAfterPlanApproval;
    }

    if ("freePlanReviewEnabled" in patch) {
      if (typeof patch.freePlanReviewEnabled !== "boolean") {
        const err = new Error("freePlanReviewEnabled must be a boolean");
        err.statusCode = 400;
        throw err;
      }
      next.freePlanReviewEnabled = patch.freePlanReviewEnabled;
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
  });
}

export function recordAutoRetryStat(stateDir, convId, nowIso = new Date().toISOString()) {
  try {
    withSettingsLock(stateDir, () => {
      const current = readSettings(stateDir);
      current.stats = {
        totalAutoRetries: (current.stats?.totalAutoRetries || 0) + 1,
        lastAutoRetryAt: nowIso,
        lastAutoRetryConvId: typeof convId === "string" ? convId.slice(0, 36) : ""
      };
      writeSettings(stateDir, current);
    });
  } catch {
    // Non-critical telemetry; never fail Stop hook
  }
}

function buildStarPromptEvalFromSettings(settings) {
  const current = normalizeStarPromptState(settings.starPrompt);
  const totalAutoRetries = Math.max(0, Math.floor(Number(settings.stats?.totalAutoRetries || 0)));

  if (current.state !== "pending") {
    const milestoneAutoRetries = Math.max(0, Math.floor(Number(current.milestoneAutoRetries || 0)));
    return {
      state: current.state,
      triggeredAt: current.triggeredAt,
      resolvedAt: current.resolvedAt,
      milestoneAutoRetries,
      shouldShow: false,
      triggerReason: null,
      totalAutoRetries,
      thresholds: {
        minAutoRetries: STAR_PROMPT_MIN_AUTO_RETRIES
      }
    };
  }

  const milestoneReached = totalAutoRetries >= STAR_PROMPT_MIN_AUTO_RETRIES;
  return {
    state: current.state,
    triggeredAt: current.triggeredAt,
    resolvedAt: current.resolvedAt,
    milestoneAutoRetries: current.milestoneAutoRetries,
    shouldShow: milestoneReached,
    triggerReason: milestoneReached ? "auto_retry_milestone" : null,
    totalAutoRetries,
    thresholds: {
      minAutoRetries: STAR_PROMPT_MIN_AUTO_RETRIES
    }
  };
}

export function evaluateStarPrompt(stateDir, { markTriggered = false, nowIso = null } = {}) {
  const initialSettings = readSettings(stateDir);
  const initialEval = buildStarPromptEvalFromSettings(initialSettings);

  if (initialEval.shouldShow && markTriggered && !initialEval.triggeredAt) {
    const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
    return withSettingsLock(stateDir, () => {
      const freshSettings = readSettings(stateDir);
      const freshCur = normalizeStarPromptState(freshSettings.starPrompt);
      const freshRetries = Math.max(0, Math.floor(Number(freshSettings.stats?.totalAutoRetries || 0)));
      if (freshCur.state !== "pending" || freshRetries < STAR_PROMPT_MIN_AUTO_RETRIES || freshCur.triggeredAt) {
        return buildStarPromptEvalFromSettings(freshSettings);
      }
      const next = {
        state: "pending",
        triggeredAt: ts,
        resolvedAt: null,
        milestoneAutoRetries: Math.max(freshCur.milestoneAutoRetries, freshRetries)
      };
      const merged = { ...freshSettings, starPrompt: next };
      try {
        const saved = writeSettings(stateDir, merged);
        return buildStarPromptEvalFromSettings(saved);
      } catch {
        return buildStarPromptEvalFromSettings(merged);
      }
    });
  }

  return initialEval;
}

export function setStarPromptState(stateDir, nextState, { nowIso = null } = {}) {
  if (typeof nextState !== "string" || !STAR_PROMPT_TERMINAL_STATES.includes(nextState)) {
    return {
      ok: false,
      error: "Invalid 'state' value: expected 'clicked', 'dismissed', or 'copied_cli'"
    };
  }

  return withSettingsLock(stateDir, () => {
    const settings = readSettings(stateDir);
    const current = normalizeStarPromptState(settings.starPrompt);
    if (current.state !== "pending") {
      return {
        ok: true,
        starPrompt: buildStarPromptEvalFromSettings(settings),
        alreadyResolved: true
      };
    }

    const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
    const totalAutoRetries = Math.max(0, Math.floor(Number(settings.stats?.totalAutoRetries || 0)));
    const saved = {
      state: nextState,
      triggeredAt: current.triggeredAt || ts,
      resolvedAt: ts,
      milestoneAutoRetries: Math.max(current.milestoneAutoRetries, totalAutoRetries)
    };
    const written = writeSettings(stateDir, { ...settings, starPrompt: saved });
    return {
      ok: true,
      starPrompt: buildStarPromptEvalFromSettings(written),
      alreadyResolved: false
    };
  });
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
  const scopeLabel =
    s.autoRetryScope === "all_failures"
      ? "所有失败均触发"
      : s.autoRetryScope === "goal_only"
        ? "仅口令触发"
        : "智能无感触发";
  if (s.autoRetryMode === "off") {
    return "不用重试（已关闭）";
  }
  if (s.autoRetryMode === "infinite") {
    return `一直重试直至全绿（${scopeLabel}）`;
  }
  return `最多重试 ${s.autoRetryMax} 次（${scopeLabel}）`;
}

export function formatDeliveryGateSummaryZh(settings = {}) {
  const s = normalizeSettings(settings);
  if (!s.deliveryTestGateEnabled) {
    return "交付测试门禁：关闭（按默认防停机策略运行）";
  }
  if (s.deliveryTestCommand) {
    return `交付测试门禁：已开启 · 自定义命令：${s.deliveryTestCommand}`;
  }
  return "交付测试门禁：已开启 · 自动探测项目测试（无测项保守放行并说明）";
}
