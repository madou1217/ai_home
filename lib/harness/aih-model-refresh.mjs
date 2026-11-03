// aih-model-refresh — keep a DSH profile's provider catalogue in step with the
// running aih gateway, without restarting the harness.
//
// DSH resolves `providers.<id>.models` from the profile patch at boot and the
// `providers` dict is a volatile config field. `llm-pi-ai` listens to
// `loader/volatile-update` and replaces its provider directory in place, while
// the TUI `/model` picker (and the web model catalogue) asks `llm.listModels()`
// on every open — so rewriting that one field through the settings service is
// enough for a freshly added or removed model to appear on screen.
//
// The settings service edits the profile patch document itself (the same path
// the native settings UI uses). That keeps a single source of truth: the
// refresh persists across launches and never introduces a second, stale
// override layer.

export const name = 'aih-model-refresh';
export const inject = ['settings'];

const DEFAULT_SETTINGS_NAMESPACE = 'llm-pi-ai';
const DEFAULT_PROVIDER = 'aih';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const INPUT_MODALITIES = new Set(['text', 'image']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, '');
}

function modelIds(models) {
  return (Array.isArray(models) ? models : []).map((model) => normalizeText(model && model.id));
}

function sameIds(left, right) {
  const a = modelIds(left);
  const b = modelIds(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function buildInput(row) {
  const modalities = row && row.aih_modalities && typeof row.aih_modalities === 'object'
    ? row.aih_modalities
    : null;
  const source = modalities && Array.isArray(modalities.input) ? modalities.input : [];
  const input = source
    .map((item) => normalizeText(item).toLowerCase())
    .filter((item) => INPUT_MODALITIES.has(item));
  if (!input.includes('text')) input.unshift('text');
  return input;
}

// pi 的 thinkingLevelMap 键集合（固定七档，见 @earendil-works/pi-coding-agent 的
// model-config schema）。值为 null 表示该档位不可用。
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 把网关发布的 `aih_reasoning_efforts` 转成 pi 的 thinkingLevelMap。
 *
 * 不写这一项时 pi 只能用自己的默认上限 —— 用户看到的现象是「最大只能选 high」，
 * 而网关其实支持到 xhigh / max（2026-10-22 用户反馈）。网关没发布档位时返回 null，
 * 让 pi 退回自己的默认，不猜。
 */
function buildThinkingLevelMap(row) {
  const declared = row && Array.isArray(row.aih_reasoning_efforts) ? row.aih_reasoning_efforts : [];
  const supported = new Set(declared.map((item) => normalizeText(item).toLowerCase()).filter(Boolean));
  if (supported.size === 0) return null;
  // `none` 在 pi 的词汇里是 `off`：同一语义两个名字，做一次映射而不是漏掉。
  if (supported.has('none')) supported.add('off');
  const map = {};
  for (const level of PI_THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
  return map;
}

// 现有条目保留自己的元数据（contextWindow / maxTokens / reasoning …）：
// /v1/models 只发布 id 与模态，凭一次刷新把上下文窗口降级成默认值反而更糟。
// 唯一例外是档位：它正是本轮要补的信息，且只可能来自网关，因此即使条目已存在也补上。
function buildModelEntry(id, row, previous) {
  const thinkingLevelMap = buildThinkingLevelMap(row);
  if (previous && typeof previous === 'object') {
    if (!thinkingLevelMap) return previous;
    return { ...previous, thinkingLevelMap };
  }
  return {
    id,
    name: normalizeText(row && row.name) || id,
    input: buildInput(row),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {})
  };
}

export function buildRefreshedModels(current, rows) {
  const previous = new Map();
  for (const model of Array.isArray(current) ? current : []) {
    const id = normalizeText(model && model.id);
    if (id) previous.set(id, model);
  }
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row && row.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, buildModelEntry(id, row, previous.get(id)));
  }
  return Array.from(byId.values());
}

export function createModelRefresher(input = {}) {
  const settings = input.settings;
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const fetchImpl = input.fetchImpl;
  const namespace = normalizeText(input.settingsNamespace) || DEFAULT_SETTINGS_NAMESPACE;
  const provider = normalizeText(input.provider) || DEFAULT_PROVIDER;
  const intervalMs = Number(input.intervalMs) > 0
    ? Math.trunc(Number(input.intervalMs))
    : DEFAULT_INTERVAL_MS;
  const initialDelayMs = Number(input.initialDelayMs) >= 0
    ? Math.trunc(Number(input.initialDelayMs))
    : DEFAULT_INITIAL_DELAY_MS;
  const timeoutMs = Number(input.timeoutMs) > 0
    ? Math.trunc(Number(input.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  let inFlight = false;

  async function refresh() {
    if (!settings || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
      return { changed: false, reason: 'settings_unavailable' };
    }
    let descriptor = null;
    try {
      const rows = settings.describe();
      descriptor = Array.isArray(rows)
        ? rows.find((row) => row && row.ns === namespace) || null
        : null;
    } catch (_error) {
      return { changed: false, reason: 'settings_unavailable' };
    }
    if (!descriptor) return { changed: false, reason: 'settings_namespace_missing' };
    const providers = descriptor.value && descriptor.value.providers;
    const profile = providers && providers[provider];
    if (!profile || typeof profile !== 'object') {
      return { changed: false, reason: 'provider_missing' };
    }
    const baseUrl = normalizeBaseUrl(profile.baseURL);
    if (!baseUrl) return { changed: false, reason: 'base_url_missing' };
    const apiKeyEnv = normalizeText(profile.apiKeyEnv) || 'OPENAI_API_KEY';
    const apiKey = normalizeText(env[apiKeyEnv]);
    if (!apiKey) return { changed: false, reason: 'api_key_missing' };
    if (typeof fetchImpl !== 'function') return { changed: false, reason: 'fetch_unavailable' };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    let payload = null;
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json'
        },
        signal: controller ? controller.signal : undefined
      });
      if (!response || !response.ok) {
        return { changed: false, reason: 'http_error', status: response && response.status };
      }
      payload = await response.json();
    } catch (_error) {
      return { changed: false, reason: 'request_failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    if (!rows.length) return { changed: false, reason: 'empty_catalog' };
    const current = Array.isArray(profile.models) ? profile.models : [];
    const next = buildRefreshedModels(current, rows);
    if (!next.length) return { changed: false, reason: 'empty_catalog' };
    if (sameIds(current, next)) return { changed: false, reason: 'unchanged', count: next.length };
    try {
      await settings.mutate(
        namespace,
        [{ op: 'set', path: ['providers', provider, 'models'], value: next }],
        descriptor.revision
      );
    } catch (_error) {
      // 用户正在设置页编辑同一段，或 revision 已经前进：下一轮按新快照重试。
      return { changed: false, reason: 'settings_conflict' };
    }
    return { changed: true, count: next.length };
  }

  async function tick() {
    if (inFlight) return { changed: false, reason: 'busy' };
    inFlight = true;
    try {
      return await refresh();
    } catch (_error) {
      return { changed: false, reason: 'error' };
    } finally {
      inFlight = false;
    }
  }

  return { intervalMs, initialDelayMs, refresh: tick };
}

export function apply(ctx, config = {}) {
  const refresher = createModelRefresher({
    ...config,
    settings: ctx.settings,
    env: typeof process === 'object' && process ? process.env : {},
    fetchImpl: typeof fetch === 'function' ? fetch : undefined
  });
  ctx.effect(() => {
    let interval = null;
    const start = () => {
      interval = setInterval(() => { void refresher.refresh(); }, refresher.intervalMs);
      if (interval && typeof interval.unref === 'function') interval.unref();
    };
    const initial = setTimeout(() => {
      void refresher.refresh();
      start();
    }, refresher.initialDelayMs);
    if (initial && typeof initial.unref === 'function') initial.unref();
    return () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  });
}
