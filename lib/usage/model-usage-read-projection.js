'use strict';

const { formatAttributedModel } = require('./model-usage-identity');
const { calculateCostUsd, matchModelPricing } = require('./model-usage-pricing');

const ATTRIBUTION_WINDOW_MS = 1000;
const LEGACY_UNKNOWN_MODEL = 'legacy-unknown';
const CODEX_FILE_EVENT_PATTERN = /^codex:file:([0-9a-f]{16}):(\d+):(usage|prompt)$/;
const SCANNER_SOURCE_KINDS = new Set(['session_jsonl', 'session_json']);
const CROSS_PROVIDER_PROXY_SOURCES = Object.freeze({
  agy: new Set(['server_code_assist_proxy']),
  codex: new Set(['server_codex_proxy'])
});

const READ_PROJECTION_SCHEMA = `
  CREATE TEMP TABLE IF NOT EXISTS model_usage_read_fork_contexts (
    source_hash TEXT PRIMARY KEY,
    replay_pending INTEGER NOT NULL,
    boundary_offset INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL
  );
  CREATE TEMP TABLE IF NOT EXISTS model_usage_read_attributions (
    scanner_id INTEGER PRIMARY KEY,
    proxy_id INTEGER NOT NULL UNIQUE,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL
  );
`;

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeProvider(value) {
  return normalizeString(value).toLowerCase();
}

function readForkDescriptors(db) {
  const rows = db.prepare(`
    SELECT path, scan_context
    FROM model_usage_file_state
    WHERE scan_context != ''
      AND scan_context LIKE '%"codexForkSession":true%'
  `).all() || [];
  const byHash = new Map();
  const ambiguousHashes = new Set();

  rows.forEach((row) => {
    let context = null;
    try {
      context = JSON.parse(row.scan_context);
    } catch (_error) {
      return;
    }
    if (!context || context.codexForkSession !== true) return;
    const sourceHash = normalizeString(context.codexForkSourceHash).toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(sourceHash)) return;
    if (byHash.has(sourceHash)) {
      ambiguousHashes.add(sourceHash);
      return;
    }
    byHash.set(sourceHash, {
      sourceHash,
      replayPending: context.codexForkReplayPending === true,
      boundaryOffset: finiteInteger(context.codexForkReplayBoundaryOffset),
      sessionId: normalizeString(context.codexForkCanonicalSessionId || context.sessionId),
      cwd: normalizeString(context.codexForkCanonicalCwd || context.cwd),
      project: normalizeString(context.codexForkCanonicalProject)
    });
  });

  ambiguousHashes.forEach((sourceHash) => byHash.delete(sourceHash));
  return Array.from(byHash.values());
}

function materializeReadProjectionContext(db, forkDescriptors, attributions) {
  db.exec(READ_PROJECTION_SCHEMA);
  const insertFork = db.prepare(`
    INSERT INTO model_usage_read_fork_contexts (
      source_hash, replay_pending, boundary_offset, session_id, cwd, project
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAttribution = db.prepare(`
    INSERT INTO model_usage_read_attributions (
      scanner_id, proxy_id, model, cost_usd
    ) VALUES (?, ?, ?, ?)
  `);

  db.exec('SAVEPOINT model_usage_read_projection');
  try {
    db.exec(`
      DELETE FROM model_usage_read_fork_contexts;
      DELETE FROM model_usage_read_attributions;
    `);
    (Array.isArray(forkDescriptors) ? forkDescriptors : []).forEach((item) => {
      insertFork.run(
        item.sourceHash,
        item.replayPending ? 1 : 0,
        finiteInteger(item.boundaryOffset),
        normalizeString(item.sessionId),
        normalizeString(item.cwd),
        normalizeString(item.project)
      );
    });
    (Array.isArray(attributions) ? attributions : []).forEach((item) => {
      insertAttribution.run(
        finiteInteger(item.scannerId),
        finiteInteger(item.proxyId),
        normalizeString(item.model),
        Number(item.costUsd) || 0
      );
    });
    db.exec('RELEASE SAVEPOINT model_usage_read_projection');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT model_usage_read_projection');
    db.exec('RELEASE SAVEPOINT model_usage_read_projection');
    throw error;
  }
}

function buildForkDescriptorMap(descriptors) {
  return new Map((Array.isArray(descriptors) ? descriptors : []).map((item) => [item.sourceHash, item]));
}

function projectForkCandidate(row, descriptorsByHash) {
  if (normalizeProvider(row && row.provider) !== 'codex') return row;
  const match = CODEX_FILE_EVENT_PATTERN.exec(normalizeString(row && row.event_key));
  if (!match || match[3] !== 'usage') return row;
  const descriptor = descriptorsByHash.get(match[1]);
  if (!descriptor) return row;
  if (descriptor.replayPending) return null;
  if (!descriptor.boundaryOffset) return row;
  if (finiteInteger(match[2]) <= descriptor.boundaryOffset) return null;
  return {
    ...row,
    session_id: descriptor.sessionId || normalizeString(row.session_id),
    cwd: descriptor.cwd || normalizeString(row.cwd),
    project: descriptor.project || normalizeString(row.project)
  };
}

function isCrossProviderCandidate(scanner, proxy) {
  if (normalizeProvider(scanner.provider) !== 'claude') return false;
  const executionProvider = normalizeProvider(proxy.provider);
  const allowedSources = CROSS_PROVIDER_PROXY_SOURCES[executionProvider];
  return Boolean(allowedSources && allowedSources.has(normalizeString(proxy.source_kind)));
}

function areCandidateObservationsCompatible(scanner, proxy) {
  const scannerProvider = normalizeProvider(scanner && scanner.provider);
  const proxyProvider = normalizeProvider(proxy && proxy.provider);
  if (!scannerProvider || !proxyProvider) return false;

  const scannerSessionId = normalizeString(scanner.session_id);
  const proxySessionId = normalizeString(proxy.session_id);
  if (scannerSessionId && proxySessionId && scannerSessionId !== proxySessionId) return false;

  if (scannerProvider === proxyProvider) {
    return normalizeString(scanner.model).toLowerCase() === normalizeString(proxy.model).toLowerCase();
  }
  return isCrossProviderCandidate(scanner, proxy);
}

function candidatePriority(left, right) {
  if (left.sessionRank !== right.sessionRank) return left.sessionRank - right.sessionRank;
  if (left.deltaMs !== right.deltaMs) return left.deltaMs - right.deltaMs;
  if (left.scannerTimestampMs !== right.scannerTimestampMs) {
    return left.scannerTimestampMs - right.scannerTimestampMs;
  }
  if (left.scannerId !== right.scannerId) return left.scannerId - right.scannerId;
  return left.proxyId - right.proxyId;
}

function addResidualEdge(graph, from, to, cost, candidate = null) {
  const forward = { to, reverse: graph[to].length, capacity: 1, cost, candidate };
  const reverse = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost, candidate: null };
  graph[from].push(forward);
  graph[to].push(reverse);
}

function findShortestAugmentingPath(graph, source, sink) {
  const distance = Array(graph.length).fill(Number.POSITIVE_INFINITY);
  const previousNode = Array(graph.length).fill(-1);
  const previousEdge = Array(graph.length).fill(-1);
  distance[source] = 0;

  for (let iteration = 0; iteration < graph.length - 1; iteration += 1) {
    let changed = false;
    graph.forEach((edges, node) => {
      if (!Number.isFinite(distance[node])) return;
      edges.forEach((edge, edgeIndex) => {
        if (edge.capacity < 1) return;
        const nextDistance = distance[node] + edge.cost;
        if (nextDistance >= distance[edge.to]) return;
        distance[edge.to] = nextDistance;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        changed = true;
      });
    });
    if (!changed) break;
  }

  return Number.isFinite(distance[sink]) ? { previousNode, previousEdge } : null;
}

function matchObservationCandidates(candidates) {
  const ordered = (Array.isArray(candidates) ? candidates.slice() : []).sort(candidatePriority);
  if (ordered.length === 0) return [];

  const scannerIds = [];
  const proxyIds = [];
  const scannerIndexById = new Map();
  const proxyIndexById = new Map();
  ordered.forEach((candidate) => {
    if (!scannerIndexById.has(candidate.scannerId)) {
      scannerIndexById.set(candidate.scannerId, scannerIds.length);
      scannerIds.push(candidate.scannerId);
    }
    if (!proxyIndexById.has(candidate.proxyId)) {
      proxyIndexById.set(candidate.proxyId, proxyIds.length);
      proxyIds.push(candidate.proxyId);
    }
  });

  const source = 0;
  const scannerOffset = 1;
  const proxyOffset = scannerOffset + scannerIds.length;
  const sink = proxyOffset + proxyIds.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  scannerIds.forEach((_scannerId, index) => addResidualEdge(graph, source, scannerOffset + index, 0));
  proxyIds.forEach((_proxyId, index) => addResidualEdge(graph, proxyOffset + index, sink, 0));

  const maximumMatches = Math.min(scannerIds.length, proxyIds.length);
  const maximumDeltaMs = ordered.reduce((maximum, candidate) => (
    Math.max(maximum, finiteInteger(candidate.deltaMs))
  ), 0);
  const sessionPenalty = (maximumDeltaMs * maximumMatches) + 1;
  ordered.forEach((candidate) => {
    const scannerNode = scannerOffset + scannerIndexById.get(candidate.scannerId);
    const proxyNode = proxyOffset + proxyIndexById.get(candidate.proxyId);
    const cost = (finiteInteger(candidate.sessionRank) * sessionPenalty)
      + finiteInteger(candidate.deltaMs);
    addResidualEdge(graph, scannerNode, proxyNode, cost, candidate);
  });

  while (true) {
    const path = findShortestAugmentingPath(graph, source, sink);
    if (!path) break;
    for (let node = sink; node !== source; node = path.previousNode[node]) {
      const previousNode = path.previousNode[node];
      const edge = graph[previousNode][path.previousEdge[node]];
      edge.capacity -= 1;
      graph[node][edge.reverse].capacity += 1;
    }
  }

  const matches = [];
  for (let index = 0; index < scannerIds.length; index += 1) {
    const scannerNode = scannerOffset + index;
    graph[scannerNode].forEach((edge) => {
      if (edge.candidate && edge.capacity === 0) matches.push(edge.candidate);
    });
  }
  return matches.sort(candidatePriority);
}

function readProxyRows(db, query) {
  const fromMs = Math.max(0, finiteInteger(query.fromMs) - ATTRIBUTION_WINDOW_MS);
  const toMs = Math.min(Number.MAX_SAFE_INTEGER, finiteInteger(query.toMs) + ATTRIBUTION_WINDOW_MS);
  return db.prepare(`
    SELECT id, provider, session_id, source_kind, model,
      input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
      cost_usd, timestamp_ms
    FROM model_usage_records
    WHERE timestamp_ms BETWEEN ? AND ?
      AND source_kind GLOB 'server_*'
      AND model != ''
      AND (
        input_tokens > 0 OR output_tokens > 0 OR cache_read_input_tokens > 0
        OR cache_creation_input_tokens > 0 OR reasoning_output_tokens > 0
      )
    ORDER BY timestamp_ms, id
  `).all(fromMs, toMs) || [];
}

function readScannerCandidates(db, proxies) {
  if (!Array.isArray(proxies) || proxies.length === 0) return [];
  const serialized = JSON.stringify(proxies.map((row) => ({
    id: finiteInteger(row.id),
    timestampMs: finiteInteger(row.timestamp_ms),
    contextTokens: finiteInteger(row.input_tokens)
      + finiteInteger(row.cache_read_input_tokens)
      + finiteInteger(row.cache_creation_input_tokens),
    outputTokens: finiteInteger(row.output_tokens),
    generationTokens: finiteInteger(row.output_tokens) + finiteInteger(row.reasoning_output_tokens)
  })));
  return db.prepare(`
    WITH proxy_observations AS (
      SELECT
        CAST(json_extract(value, '$.id') AS INTEGER) AS proxy_id,
        CAST(json_extract(value, '$.timestampMs') AS INTEGER) AS timestamp_ms,
        CAST(json_extract(value, '$.contextTokens') AS INTEGER) AS context_tokens,
        CAST(json_extract(value, '$.outputTokens') AS INTEGER) AS output_tokens,
        CAST(json_extract(value, '$.generationTokens') AS INTEGER) AS generation_tokens
      FROM json_each(?)
    )
    SELECT
      s.id, s.event_key, s.provider, s.session_id, s.source_kind, s.model,
      s.input_tokens, s.output_tokens, s.cache_read_input_tokens,
      s.cache_creation_input_tokens, s.reasoning_output_tokens, s.total_tokens,
      s.cost_usd, s.timestamp_ms, s.project, s.cwd, s.git_branch,
      p.proxy_id
    FROM proxy_observations p
    JOIN model_usage_records AS s INDEXED BY idx_model_usage_timestamp
      ON s.timestamp_ms BETWEEN p.timestamp_ms - ? AND p.timestamp_ms + ?
      AND s.input_tokens + s.cache_read_input_tokens + s.cache_creation_input_tokens = p.context_tokens
      AND (
        s.output_tokens = p.output_tokens
        OR s.output_tokens + s.reasoning_output_tokens = p.generation_tokens
      )
    WHERE s.source_kind IN ('session_jsonl', 'session_json')
      AND s.model != ''
    ORDER BY s.timestamp_ms, s.id, p.proxy_id
  `).all(serialized, ATTRIBUTION_WINDOW_MS, ATTRIBUTION_WINDOW_MS) || [];
}

function createAttributions(db, query, forkDescriptors, getPricingByModel) {
  const proxies = readProxyRows(db, query);
  if (proxies.length === 0) return [];
  const proxyById = new Map(proxies.map((row) => [finiteInteger(row.id), row]));
  const forkDescriptorsByHash = buildForkDescriptorMap(forkDescriptors);
  const scannerById = new Map();
  const candidates = [];

  readScannerCandidates(db, proxies).forEach((candidateRow) => {
    const proxy = proxyById.get(finiteInteger(candidateRow.proxy_id));
    if (!proxy) return;
    const scanner = projectForkCandidate(candidateRow, forkDescriptorsByHash);
    if (!scanner || !areCandidateObservationsCompatible(scanner, proxy)) return;
    const scannerId = finiteInteger(scanner.id);
    const proxyId = finiteInteger(proxy.id);
    scannerById.set(scannerId, scanner);
    candidates.push({
      scannerId,
      proxyId,
      scannerTimestampMs: finiteInteger(scanner.timestamp_ms),
      deltaMs: Math.abs(finiteInteger(scanner.timestamp_ms) - finiteInteger(proxy.timestamp_ms)),
      sessionRank: normalizeString(scanner.session_id)
        && normalizeString(scanner.session_id) === normalizeString(proxy.session_id)
        ? 0
        : 1
    });
  });

  const matches = matchObservationCandidates(candidates);
  if (matches.length === 0) return [];
  let pricingByModel = null;
  const getPricing = () => {
    if (!pricingByModel) {
      pricingByModel = typeof getPricingByModel === 'function' ? getPricingByModel() : {};
    }
    return pricingByModel || {};
  };

  return matches.map((match) => {
    const scanner = scannerById.get(match.scannerId);
    const proxy = proxyById.get(match.proxyId);
    const model = formatAttributedModel(scanner.provider, proxy.provider, proxy.model || scanner.model);
    const pricing = matchModelPricing(model, getPricing(), scanner.provider);
    const crossesProvider = normalizeProvider(scanner.provider) !== normalizeProvider(proxy.provider);
    const costUsd = pricing
      ? calculateCostUsd({
        inputTokens: scanner.input_tokens,
        outputTokens: scanner.output_tokens,
        cacheReadInputTokens: scanner.cache_read_input_tokens,
        cacheCreationInputTokens: scanner.cache_creation_input_tokens,
        reasoningOutputTokens: scanner.reasoning_output_tokens
      }, pricing)
      : (crossesProvider ? 0 : Number(scanner.cost_usd) || 0);
    return {
      scannerId: match.scannerId,
      proxyId: match.proxyId,
      model,
      costUsd
    };
  });
}

function buildCanonicalProjectionSql() {
  const usageOffsetText = "substr(r.event_key, 29, length(r.event_key) - 34)";
  const promptOffsetText = "substr(p.event_key, 29, length(p.event_key) - 35)";
  return `
    fork_contexts AS (
      SELECT
        source_hash, replay_pending, boundary_offset, session_id, cwd, project
      FROM model_usage_read_fork_contexts
    ),
    usage_attributions AS (
      SELECT
        scanner_id, proxy_id, model, cost_usd
      FROM model_usage_read_attributions
    ),
    usage_source AS (
      SELECT r.*,
        CASE WHEN
          r.provider = 'codex'
          AND substr(r.event_key, 1, 11) = 'codex:file:'
          AND length(r.event_key) > 34
          AND length(substr(r.event_key, 12, 16)) = 16
          AND substr(r.event_key, 12, 16) NOT GLOB '*[^0-9a-f]*'
          AND substr(r.event_key, 28, 1) = ':'
          AND substr(r.event_key, -6) = ':usage'
          AND ${usageOffsetText} != ''
          AND ${usageOffsetText} NOT GLOB '*[^0-9]*'
          THEN substr(r.event_key, 12, 16)
          ELSE ''
        END AS fork_source_hash,
        CASE WHEN
          r.provider = 'codex'
          AND substr(r.event_key, 1, 11) = 'codex:file:'
          AND length(r.event_key) > 34
          AND substr(r.event_key, -6) = ':usage'
          AND ${usageOffsetText} != ''
          AND ${usageOffsetText} NOT GLOB '*[^0-9]*'
          THEN CAST(${usageOffsetText} AS INTEGER)
          ELSE -1
        END AS fork_event_offset
      FROM model_usage_records r
      WHERE r.timestamp_ms BETWEEN ? AND ?
    ),
    canonical_usage AS (
      SELECT
        u.id,
        u.event_key,
        u.provider,
        u.account_ref,
        CASE WHEN
          f.source_hash IS NOT NULL AND f.replay_pending = 0
          AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
          THEN COALESCE(NULLIF(f.session_id, ''), u.session_id)
          ELSE u.session_id
        END AS session_id,
        u.request_id,
        u.source_kind,
        CASE
          WHEN trim(COALESCE(NULLIF(a.model, ''), u.model)) = ''
            THEN '${LEGACY_UNKNOWN_MODEL}'
          ELSE trim(COALESCE(NULLIF(a.model, ''), u.model))
        END AS model,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens,
        u.cache_creation_input_tokens,
        u.reasoning_output_tokens,
        u.total_tokens,
        CASE WHEN a.scanner_id IS NOT NULL THEN a.cost_usd ELSE u.cost_usd END AS cost_usd,
        u.timestamp_ms,
        CASE WHEN
          f.source_hash IS NOT NULL AND f.replay_pending = 0
          AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
          THEN COALESCE(NULLIF(f.project, ''), u.project)
          ELSE u.project
        END AS project,
        CASE WHEN
          f.source_hash IS NOT NULL AND f.replay_pending = 0
          AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
          THEN COALESCE(NULLIF(f.cwd, ''), u.cwd)
          ELSE u.cwd
        END AS cwd,
        u.git_branch
      FROM usage_source u
      LEFT JOIN fork_contexts f ON f.source_hash = u.fork_source_hash
      LEFT JOIN usage_attributions a ON a.scanner_id = u.id
      LEFT JOIN usage_attributions matched_proxy ON matched_proxy.proxy_id = u.id
      WHERE matched_proxy.proxy_id IS NULL
        AND NOT (
          f.source_hash IS NOT NULL
          AND (
            f.replay_pending = 1
            OR (f.boundary_offset > 0 AND u.fork_event_offset <= f.boundary_offset)
          )
        )
    ),
    prompt_source AS (
      SELECT p.*,
        CASE WHEN
          p.provider = 'codex'
          AND substr(p.event_key, 1, 11) = 'codex:file:'
          AND length(p.event_key) > 35
          AND length(substr(p.event_key, 12, 16)) = 16
          AND substr(p.event_key, 12, 16) NOT GLOB '*[^0-9a-f]*'
          AND substr(p.event_key, 28, 1) = ':'
          AND substr(p.event_key, -7) = ':prompt'
          AND ${promptOffsetText} != ''
          AND ${promptOffsetText} NOT GLOB '*[^0-9]*'
          THEN substr(p.event_key, 12, 16)
          ELSE ''
        END AS fork_source_hash,
        CASE WHEN
          p.provider = 'codex'
          AND substr(p.event_key, 1, 11) = 'codex:file:'
          AND length(p.event_key) > 35
          AND substr(p.event_key, -7) = ':prompt'
          AND ${promptOffsetText} != ''
          AND ${promptOffsetText} NOT GLOB '*[^0-9]*'
          THEN CAST(${promptOffsetText} AS INTEGER)
          ELSE -1
        END AS fork_event_offset
      FROM model_usage_prompt_events p
      WHERE p.timestamp_ms BETWEEN ? AND ?
    ),
    canonical_prompt_events AS (
      SELECT
        p.event_key,
        p.provider,
        CASE WHEN
          f.source_hash IS NOT NULL AND f.replay_pending = 0
          AND f.boundary_offset > 0 AND p.fork_event_offset > f.boundary_offset
          THEN COALESCE(NULLIF(f.session_id, ''), p.session_id)
          ELSE p.session_id
        END AS session_id,
        p.timestamp_ms
      FROM prompt_source p
      LEFT JOIN fork_contexts f ON f.source_hash = p.fork_source_hash
      WHERE NOT (
        f.source_hash IS NOT NULL
        AND (
          f.replay_pending = 1
          OR (f.boundary_offset > 0 AND p.fork_event_offset <= f.boundary_offset)
        )
      )
    )
  `;
}

function createCanonicalReadProjection(db, query, options = {}) {
  const forkDescriptors = readForkDescriptors(db);
  const attributions = createAttributions(
    db,
    query,
    forkDescriptors,
    options.getPricingByModel
  );
  const fromMs = finiteInteger(query.fromMs);
  const toMs = finiteInteger(query.toMs);
  materializeReadProjectionContext(db, forkDescriptors, attributions);
  return {
    ctes: buildCanonicalProjectionSql(),
    args: [
      fromMs,
      toMs,
      fromMs,
      toMs
    ],
    attributions,
    forkDescriptors
  };
}

module.exports = {
  ATTRIBUTION_WINDOW_MS,
  LEGACY_UNKNOWN_MODEL,
  createCanonicalReadProjection,
  __private: {
    CODEX_FILE_EVENT_PATTERN,
    areCandidateObservationsCompatible,
    buildCanonicalProjectionSql,
    buildForkDescriptorMap,
    candidatePriority,
    createAttributions,
    materializeReadProjectionContext,
    matchObservationCandidates,
    projectForkCandidate,
    readForkDescriptors,
    readProxyRows,
    readScannerCandidates
  }
};
