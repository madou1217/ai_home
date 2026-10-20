'use strict';

// 外部价格源快照与人工复核队列（P5）。
//
// 规则：
//   * 每个来源一份独立快照文件（<aiHome>/pricing/sources/<id>.json），0600，原子写入；
//   * 首次采集直接生效；后续价格**变化**不自动覆盖，进入 pending + reviews 队列，等待人工确认；
//   * 只改 metadata（fetchedAt）不算价格变化，直接更新；
//   * 采集失败绝不删除/覆盖旧快照（调用方只在成功解析后调用 apply）；
//   * 复核通过后整份候选快照生效；拒绝则丢候选、保留旧快照。
//
// 价格是计费事实，所以这里不提供「自动接受」开关：调用方可以传 requireReview:false
// 仅用于测试/宿主内置的受信任场景，插件路径永远默认复核。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPriceQuote, PRICE_QUOTE_DIMENSIONS } = require('./price-quote');
const { mergePriceQuotes } = require('./merge-quotes');

const CATALOG_SOURCE_SCHEMA_VERSION = 1;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const REVIEW_FILE = 'reviews.json';
const SOURCES_DIR = 'sources';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeSourceId(value) {
  const id = normalizeText(value);
  if (!SOURCE_ID_PATTERN.test(id)) throw new Error('pricing_source_id_invalid');
  return id;
}

function fileSafeId(id) {
  // ':' 是合法来源 id 字符（official:openai、community:litellm），必须用可逆且不会与
  // 另一个合法 id 撞名的编码：`__` 会让 `a:b` 与 `a__b` 落到同一文件。
  return safeSourceId(id).replace(/:/g, '%3A');
}

function createPricingCatalogSourceStore(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const root = aiHomeDir ? path.join(aiHomeDir, 'pricing') : '';
  const sourcesDir = root ? path.join(root, SOURCES_DIR) : '';
  const reviewsFile = root ? path.join(root, REVIEW_FILE) : '';
  let reviews = null;

  function ensureDirs() {
    if (!root) throw new Error('pricing_source_store_unavailable');
    fsImpl.mkdirSync(sourcesDir, { recursive: true, mode: 0o700 });
  }

  function sourceFile(sourceId) {
    return path.join(sourcesDir, `${fileSafeId(sourceId)}.json`);
  }

  function pendingFile(sourceId) {
    return path.join(sourcesDir, `${fileSafeId(sourceId)}.pending.json`);
  }

  function atomicWrite(file, value) {
    ensureDirs();
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { fsImpl.chmodSync(temp, 0o600); } catch (_error) { /* Windows */ }
    fsImpl.renameSync(temp, file);
  }

  function readJson(file) {
    if (!file || !fsImpl.existsSync(file)) return null;
    try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (_error) { return null; }
  }

  function normalizeQuotes(values) {
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      try {
        out.push(createPriceQuote(value));
      } catch (_error) {
        // 单条坏报价不毒化整份快照；调用方通过 invalid 数观察。
      }
    }
    return out;
  }

  function readSource(sourceId) {
    const document = readJson(sourceFile(sourceId));
    if (!document || document.schemaVersion !== CATALOG_SOURCE_SCHEMA_VERSION) return null;
    return {
      ...document,
      quotes: normalizeQuotes(document.quotes)
    };
  }

  function readPending(sourceId) {
    const document = readJson(pendingFile(sourceId));
    if (!document || document.schemaVersion !== CATALOG_SOURCE_SCHEMA_VERSION) return null;
    return { ...document, quotes: normalizeQuotes(document.quotes) };
  }

  function listSources() {
    if (!sourcesDir || !fsImpl.existsSync(sourcesDir)) return [];
    return fsImpl.readdirSync(sourcesDir)
      .filter((file) => file.endsWith('.json') && !file.endsWith('.pending.json'))
      .map((file) => {
        // 文件名是来源 id 的编码（':' → '%3A'），不能把文件名直接当 id。
        const document = readJson(path.join(sourcesDir, file));
        if (!document || document.schemaVersion !== CATALOG_SOURCE_SCHEMA_VERSION || !normalizeText(document.sourceId)) return null;
        return { ...document, quotes: normalizeQuotes(document.quotes) };
      })
      .filter(Boolean)
      .sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
  }

  function quoteSnapshot(quote) {
    return {
      provider: quote.provider,
      model: quote.model,
      status: quote.status,
      input: quote.input,
      output: quote.output,
      cacheRead: quote.cacheRead,
      cacheWrite: quote.cacheWrite,
      cacheWrite1h: quote.cacheWrite1h,
      reasoning: quote.reasoning,
      tiers: quote.tiers || []
    };
  }

  function diffQuotes(previous, next) {
    const keyOf = (quote) => `${String(quote.provider).toLowerCase()}\0${String(quote.model).toLowerCase()}`;
    const oldMap = new Map((previous || []).map((quote) => [keyOf(quote), quote]));
    const changes = [];
    for (const quote of next || []) {
      const old = oldMap.get(keyOf(quote));
      if (!old) {
        changes.push({ provider: quote.provider, model: quote.model, change: 'added', next: quoteSnapshot(quote) });
        oldMap.delete(keyOf(quote));
        continue;
      }
      oldMap.delete(keyOf(quote));
      for (const dimension of PRICE_QUOTE_DIMENSIONS) {
        if ((old[dimension] ?? null) !== (quote[dimension] ?? null)) {
          changes.push({
            provider: quote.provider,
            model: quote.model,
            change: 'changed',
            dimension,
            previous: old[dimension],
            next: quote[dimension]
          });
        }
      }
      if (JSON.stringify(old.tiers || []) !== JSON.stringify(quote.tiers || [])) {
        changes.push({ provider: quote.provider, model: quote.model, change: 'tiers_changed' });
      }
    }
    for (const quote of oldMap.values()) {
      changes.push({ provider: quote.provider, model: quote.model, change: 'removed' });
    }
    return changes;
  }

  function loadReviews() {
    if (reviews) return reviews;
    const document = readJson(reviewsFile);
    reviews = isRecord(document) && Array.isArray(document.items)
      ? { schemaVersion: CATALOG_SOURCE_SCHEMA_VERSION, items: document.items }
      : { schemaVersion: CATALOG_SOURCE_SCHEMA_VERSION, items: [] };
    return reviews;
  }

  function persistReviews() {
    atomicWrite(reviewsFile, { schemaVersion: CATALOG_SOURCE_SCHEMA_VERSION, items: loadReviews().items });
  }

  function queueReviews(sourceId, changes, meta) {
    const store = loadReviews();
    const at = new Date(now()).toISOString();
    const items = changes.map((change) => ({
      id: crypto.createHash('sha256')
        .update(`${sourceId}\0${change.provider}\0${change.model}\0${change.dimension || change.change}\0${JSON.stringify(change.next ?? change.nextValue ?? '')}\0${at}`)
        .digest('hex')
        .slice(0, 24),
      sourceId,
      provider: change.provider,
      model: change.model,
      change: change.change,
      dimension: change.dimension || '',
      previous: change.previous ?? null,
      next: change.nextValue ?? change.next ?? null,
      detectedAt: at,
      status: 'pending',
      sourceUrl: meta && meta.url || ''
    }));
    // 同一 source 重复采集时替换旧的 pending 条目，避免队列无限增长。
    store.items = store.items.filter((item) => item.sourceId !== sourceId || item.status !== 'pending').concat(items);
    persistReviews();
    return items;
  }

  function markSourceReviews(sourceId, status) {
    const store = loadReviews();
    let changed = false;
    for (const item of store.items) {
      if (item.sourceId === sourceId && item.status === 'pending') {
        item.status = status;
        item.resolvedAt = new Date(now()).toISOString();
        changed = true;
      }
    }
    if (changed) persistReviews();
  }

  /**
   * 提交一次已成功采集的快照。
   * @returns {{applied:boolean, reviewRequired:boolean, changes:Array, reviews:Array, fetchedAt:string}}
   */
  function applySnapshot(input = {}) {
    const sourceId = safeSourceId(input.sourceId || (input.source && input.source.id));
    const quotes = normalizeQuotes(input.quotes);
    const previous = readSource(sourceId);
    const fetchedAt = Number(input.fetchedAt) > 0
      ? new Date(Number(input.fetchedAt)).toISOString()
      : (normalizeText(input.fetchedAt) || new Date(now()).toISOString());
    const source = {
      ...(input.source || {}),
      id: sourceId,
      kind: normalizeText(input.source && input.source.kind) || 'unknown',
      ...(normalizeText(input.source && input.source.url) ? { url: normalizeText(input.source.url) } : {}),
      fetchedAt
    };
    const document = {
      schemaVersion: CATALOG_SOURCE_SCHEMA_VERSION,
      sourceId,
      source,
      fetchedAt,
      appliedAt: previous ? previous.appliedAt : fetchedAt,
      quotes
    };
    if (!previous) {
      atomicWrite(sourceFile(sourceId), document);
      return { applied: true, reviewRequired: false, changes: [], reviews: [], fetchedAt };
    }
    const changes = diffQuotes(previous.quotes, quotes);
    if (changes.length === 0) {
      // 价格没变：只推进 fetchedAt，保留 appliedAt。
      atomicWrite(sourceFile(sourceId), { ...previous, source, fetchedAt });
      return { applied: true, reviewRequired: false, changes: [], reviews: [], fetchedAt };
    }
    if (input.requireReview === false) {
      atomicWrite(sourceFile(sourceId), document);
      markSourceReviews(sourceId, 'superseded');
      try { fsImpl.rmSync(pendingFile(sourceId), { force: true }); } catch (_error) {}
      return { applied: true, reviewRequired: false, changes, reviews: [], fetchedAt };
    }
    // 价格变化：保留旧快照作为计费事实，只写候选与复核项。
    atomicWrite(pendingFile(sourceId), document);
    const queued = queueReviews(sourceId, changes, source);
    return { applied: false, reviewRequired: true, changes, reviews: queued, fetchedAt };
  }

  function listReviews(reviewOptions = {}) {
    const status = normalizeText(reviewOptions.status);
    return loadReviews().items
      .filter((item) => !status || item.status === status)
      .sort((left, right) => String(right.detectedAt).localeCompare(String(left.detectedAt)));
  }

  function getPending(sourceId) {
    return readPending(sourceId);
  }

  function approveSource(sourceId) {
    const id = safeSourceId(sourceId);
    const pending = readPending(id);
    if (!pending) throw new Error('pricing_review_pending_missing');
    atomicWrite(sourceFile(id), {
      ...pending,
      sourceId: id,
      appliedAt: new Date(now()).toISOString()
    });
    try { fsImpl.rmSync(pendingFile(id), { force: true }); } catch (_error) {}
    markSourceReviews(id, 'approved');
    return { sourceId: id, appliedAt: new Date(now()).toISOString(), quotes: pending.quotes.length };
  }

  function rejectSource(sourceId) {
    const id = safeSourceId(sourceId);
    try { fsImpl.rmSync(pendingFile(id), { force: true }); } catch (_error) {}
    markSourceReviews(id, 'rejected');
    return { sourceId: id, rejected: true };
  }

  /**
   * 生效快照 → 统一的 per-token pricing records（models.dev 兼容）。
   * 同一 provider/model 的多来源报价在这里做维度级合并（official 优先于 community）。
   */
  function buildPricingRecords() {
    const groups = new Map();
    for (const source of listSources()) {
      for (const quote of source.quotes) {
        const key = `${quote.provider}\0${quote.model}`;
        if (!groups.has(key)) groups.set(key, { provider: quote.provider, model: quote.model, quotes: [] });
        groups.get(key).quotes.push(quote);
      }
    }
    const records = [];
    for (const group of groups.values()) {
      const merged = mergePriceQuotes(group.quotes, { provider: group.provider, model: group.model, now: now() });
      if (!merged || merged.status === 'unknown') continue;
      const perToken = (value) => (value === null || value === undefined ? null : Number(value) / 1_000_000);
      const record = {
        model: `${group.provider}/${group.model}`,
        inputCostPerToken: perToken(merged.input),
        outputCostPerToken: perToken(merged.output),
        cacheReadInputTokenCost: perToken(merged.cacheRead),
        cacheCreationInputTokenCost: perToken(merged.cacheWrite),
        reasoningOutputTokenCost: perToken(merged.reasoning),
        contextCostTiers: (merged.tiers || []).map((tier) => ({
          size: tier.when.contextTokensGt,
          inputCostPerToken: perToken(tier.input),
          outputCostPerToken: perToken(tier.output),
          cacheReadInputTokenCost: perToken(tier.cacheRead),
          cacheCreationInputTokenCost: perToken(tier.cacheWrite),
          reasoningOutputTokenCost: perToken(tier.reasoning)
        }))
      };
      // 只保留至少一个有效维度，避免把 unknown 写成 0。
      if ([record.inputCostPerToken, record.outputCostPerToken, record.cacheReadInputTokenCost,
        record.cacheCreationInputTokenCost, record.reasoningOutputTokenCost]
        .every((value) => value === null) && record.contextCostTiers.length === 0) continue;
      records.push(record);
    }
    return records.sort((left, right) => left.model.localeCompare(right.model));
  }

  return {
    aiHomeDir,
    applySnapshot,
    approveSource,
    buildPricingRecords,
    getPending,
    listReviews,
    listSources,
    readSource,
    rejectSource,
    root,
    sourcesDir
  };
}

module.exports = {
  CATALOG_SOURCE_SCHEMA_VERSION,
  REVIEW_FILE,
  SOURCES_DIR,
  createPricingCatalogSourceStore
};
