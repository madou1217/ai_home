import { readFileSync, statSync, watch, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// AIH 生成的 models.json 是 Pi 的唯一模型事实源。它有两种变化方式，这里都要
// 让运行中的 TUI 立刻跟上，不需要重启：
//
//   1. aih 在账号/模型目录变化时整体重写文件（下次启动或后台刷新）——监听文件。
//   2. 上游账号在 Pi 运行期间新增/下线了模型——aih 的进程已经不在了，没人替
//      我们重写文件，所以要自己按固定间隔回读网关 /v1/models，把新目录写回
//      同一份 models.json，再让 modelRegistry 重新解析。
//
// 两条路径最后都走同一个 refreshModels()，保证 Pi 的 /model 菜单与 aih WebUI
// 的模型目录是同一份事实。

const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'models.json');
const PROVIDER_ID = 'aih';
const POLL_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 150;
const CATALOG_INTERVAL_MS = 5 * 60 * 1000;
const CATALOG_INITIAL_DELAY_MS = 5000;
const CATALOG_TIMEOUT_MS = 10000;
const INPUT_MODALITIES = new Set(['text', 'image']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
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

// 已有条目保留自己的元数据（contextWindow / maxTokens / reasoning / cost）：
// /v1/models 只发布 id 与模态，凭一次刷新把上下文窗口降级成默认值反而更糟。
function buildRefreshedModels(current, rows) {
  const previous = new Map();
  for (const model of Array.isArray(current) ? current : []) {
    const id = normalizeText(model && model.id);
    if (id) previous.set(id, model);
  }
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row && row.id);
    if (!id || byId.has(id)) continue;
    const existing = previous.get(id);
    byId.set(id, existing && typeof existing === 'object'
      ? existing
      : { id, name: normalizeText(row && row.name) || id, input: buildInput(row) });
  }
  return Array.from(byId.values());
}

export default function (pi) {
  let registry = null;
  let watcher = null;
  let pollTimer = null;
  let catalogTimer = null;
  let catalogInitialTimer = null;
  let debounceTimer = null;
  let lastMtime = 0;
  let refreshing = false;
  let catalogBusy = false;
  let stopped = true;

  function readMtime() {
    try {
      return statSync(MODELS_PATH).mtimeMs;
    } catch (_error) {
      return 0;
    }
  }

  function readDocument() {
    try {
      const raw = readFileSync(MODELS_PATH, 'utf8');
      const document = JSON.parse(raw);
      return document && typeof document === 'object' ? document : null;
    } catch (_error) {
      return null;
    }
  }

  function writeDocument(document) {
    // 原子替换：Pi 可能正读到一半，截断写会喂给它半份 JSON。
    const temporary = `${MODELS_PATH}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, MODELS_PATH);
      return true;
    } catch (_error) {
      try { unlinkSync(temporary); } catch (_ignored) {}
      return false;
    }
  }

  async function refreshModels() {
    if (stopped || refreshing || !registry || typeof registry.refresh !== 'function') return;
    refreshing = true;
    try {
      await registry.refresh({ providers: [PROVIDER_ID], allowNetwork: false });
    } catch (_error) {
      // 文件正在被原子替换时 refresh 可能读到一半；下一轮轮询会重试。
    } finally {
      refreshing = false;
    }
  }

  function checkForChanges() {
    const mtime = readMtime();
    if (!mtime || mtime === lastMtime) return;
    lastMtime = mtime;
    void refreshModels();
  }

  // 回读网关模型目录；只有 id 集合真的变了才落盘 + 刷新。
  async function refreshCatalog() {
    if (stopped || catalogBusy) return;
    const document = readDocument();
    const profile = document && document.providers && document.providers[PROVIDER_ID];
    if (!profile || typeof profile !== 'object') return;
    const baseUrl = normalizeText(profile.baseUrl).replace(/\/+$/, '');
    if (!baseUrl) return;
    const apiKey = normalizeText(process.env && process.env.OPENAI_API_KEY);
    if (!apiKey) return;
    catalogBusy = true;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS) : null;
    try {
      // 请求形状必须与 aih 启动器（lib/harness/gateway-catalog.js）逐字一致：
      // 目录端点不做账号钉选，带上 profile.headers 会让两侧读到不同的列表，
      // 每次轮询都判定「变了」→ 无谓重写。
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json'
        },
        signal: controller ? controller.signal : undefined
      });
      if (!response || !response.ok) return;
      const payload = await response.json();
      const rows = Array.isArray(payload && payload.data) ? payload.data : [];
      if (!rows.length) return;
      const current = Array.isArray(profile.models) ? profile.models : [];
      const next = buildRefreshedModels(current, rows);
      if (!next.length || sameIds(current, next)) return;
      profile.models = next;
      if (!writeDocument(document)) return;
      // 自己刚写过文件，避免 watcher 再触发一次无意义的 refresh。
      lastMtime = readMtime();
      await refreshModels();
    } catch (_error) {
      // 网关未启动 / 网络抖动：保持现有目录，下一轮再试。
    } finally {
      if (timer) clearTimeout(timer);
      catalogBusy = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    lastMtime = readMtime();
    try {
      watcher = watch(dirname(MODELS_PATH), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== 'models.json') return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkForChanges, DEBOUNCE_MS);
      });
    } catch (_error) {
      watcher = null;
    }
    pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    catalogInitialTimer = setTimeout(() => {
      void refreshCatalog();
      catalogTimer = setInterval(() => { void refreshCatalog(); }, CATALOG_INTERVAL_MS);
      if (catalogTimer && typeof catalogTimer.unref === 'function') catalogTimer.unref();
    }, CATALOG_INITIAL_DELAY_MS);
    if (catalogInitialTimer && typeof catalogInitialTimer.unref === 'function') catalogInitialTimer.unref();
  }

  function stop() {
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (catalogTimer) {
      clearInterval(catalogTimer);
      catalogTimer = null;
    }
    clearTimeout(catalogInitialTimer);
    catalogInitialTimer = null;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (watcher) {
      try { watcher.close(); } catch (_error) {}
      watcher = null;
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    registry = ctx && ctx.modelRegistry ? ctx.modelRegistry : null;
    start();
  });

  pi.on('session_shutdown', async () => {
    stop();
  });
}
