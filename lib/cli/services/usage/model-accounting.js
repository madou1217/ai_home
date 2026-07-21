'use strict';

function pad(value, width) {
  const text = String(value || '');
  if (text.length >= width) return text;
  return `${text}${' '.repeat(width - text.length)}`;
}

function formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function formatCost(value) {
  const number = Number(value) || 0;
  if (number <= 0) return '$0.0000';
  if (number < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(2)}`;
}

function parseLocalDateStart(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function normalizeDateRange(fromRaw, toRaw) {
  const today = formatLocalDate(new Date());
  const fromText = String(fromRaw || today).trim();
  const toText = String(toRaw || fromText).trim();
  const fromMs = parseLocalDateStart(fromText);
  const toStartMs = parseLocalDateStart(toText);
  if (!fromMs || !toStartMs) {
    const error = new Error('日期格式必须是 YYYY-MM-DD');
    error.code = 'invalid_date';
    throw error;
  }
  return {
    from: fromText,
    to: toText,
    fromMs,
    toMs: toStartMs + 24 * 60 * 60 * 1000 - 1
  };
}

function parseModelUsageArgs(argv = []) {
  const tokens = Array.isArray(argv) ? argv.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const command = tokens[0] && !tokens[0].startsWith('-') ? tokens.shift() : 'stats';
  const options = {
    command,
    provider: '',
    model: '',
    sessionId: '',
    from: '',
    to: '',
    limit: 20,
    scan: true,
    json: false,
    reindexCodexForkHistory: false
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      const value = tokens[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`缺少 ${token} 参数值`);
      }
      index += 1;
      return value;
    };

    if (token === '--from') {
      options.from = next();
      continue;
    }
    if (token === '--to') {
      options.to = next();
      continue;
    }
    if (token === '--provider' || token === '--source') {
      options.provider = next();
      continue;
    }
    if (token === '--model') {
      options.model = next();
      continue;
    }
    if (token === '--session-id') {
      options.sessionId = next();
      continue;
    }
    if (token === '--limit' || token === '-n') {
      options.limit = Number(next());
      continue;
    }
    if (token === '--no-scan') {
      options.scan = false;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--reindex-codex-forks') {
      options.reindexCodexForkHistory = true;
      continue;
    }
    throw new Error(`未知 usage 参数: ${token}`);
  }

  const normalizedCommand = String(options.command || '').trim().toLowerCase();
  if (options.reindexCodexForkHistory && normalizedCommand !== 'scan') {
    throw new Error('--reindex-codex-forks 仅支持 usage scan');
  }
  if (
    options.reindexCodexForkHistory
    && options.provider
    && String(options.provider).trim().toLowerCase() !== 'codex'
  ) {
    throw new Error('--reindex-codex-forks 仅支持 codex provider');
  }

  return options;
}

function printRows(log, headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    String(header).length,
    ...rows.map((row) => String(row[index] || '').length)
  ));
  log(headers.map((header, index) => pad(header, widths[index])).join('  '));
  log(widths.map((width) => '-'.repeat(width)).join('  '));
  rows.forEach((row) => {
    log(row.map((value, index) => pad(value, widths[index])).join('  '));
  });
}

function createModelUsageAccountingService(options = {}) {
  const modelUsageService = options.modelUsageService;
  const log = options.log || console.log;

  async function syncPricingBestEffort() {
    if (!modelUsageService || typeof modelUsageService.syncPricingIfStale !== 'function') return null;
    try {
      return await modelUsageService.syncPricingIfStale();
    } catch (_error) {
      return null;
    }
  }

  function buildQueryOptions(parsed) {
    const range = normalizeDateRange(parsed.from, parsed.to);
    return {
      ...range,
      provider: parsed.provider,
      model: parsed.model,
      sessionId: parsed.sessionId,
      limit: parsed.limit,
      scan: parsed.scan
    };
  }

  async function prepareQuery(parsed) {
    const query = buildQueryOptions(parsed);
    await syncPricingBestEffort();
    if (parsed.scan) modelUsageService.scan({ provider: query.provider });
    return query;
  }

  async function printStats(parsed) {
    const query = await prepareQuery(parsed);
    const stats = modelUsageService.getStats(query);
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'stats', range: { from: query.from, to: query.to }, stats }, null, 2));
      return;
    }
    log(`\x1b[36m[aih]\x1b[0m 模型用量统计 ${query.from} ~ ${query.to}`);
    log(`  调用: ${stats.totalCalls}`);
    log(`  会话: ${stats.totalSessions}`);
    log(`  Prompt: ${stats.totalPrompts}`);
    log(`  Tokens: ${formatTokenCount(stats.totalTokens)} (input ${formatTokenCount(stats.inputTokens)}, output ${formatTokenCount(stats.outputTokens)}, cache ${formatTokenCount(stats.cacheReadInputTokens + stats.cacheCreationInputTokens)}, reasoning ${formatTokenCount(stats.reasoningOutputTokens)})`);
    log(`  估算成本: ${formatCost(stats.totalCostUsd)}`);
  }

  async function printModels(parsed) {
    const query = await prepareQuery(parsed);
    const models = modelUsageService.getCostByModel(query);
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'models', range: { from: query.from, to: query.to }, models }, null, 2));
      return;
    }
    log(`\x1b[36m[aih]\x1b[0m 模型用量按模型 ${query.from} ~ ${query.to}`);
    if (models.length === 0) {
      log('  无记录');
      return;
    }
    printRows(log, ['provider', 'model', 'calls', 'tokens', 'cost'], models.map((item) => [
      item.provider,
      item.model || '-',
      String(item.calls),
      formatTokenCount(item.totalTokens),
      formatCost(item.costUsd)
    ]));
  }

  async function printSessions(parsed) {
    const query = await prepareQuery(parsed);
    const sessions = modelUsageService.getSessions(query);
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'sessions', range: { from: query.from, to: query.to }, sessions }, null, 2));
      return;
    }
    log(`\x1b[36m[aih]\x1b[0m 模型用量按会话 ${query.from} ~ ${query.to}`);
    if (sessions.length === 0) {
      log('  无记录');
      return;
    }
    printRows(log, ['provider', 'session', 'project', 'calls', 'tokens', 'cost'], sessions.map((item) => [
      item.provider,
      String(item.sessionId || '').slice(0, 18),
      item.project || '-',
      String(item.calls),
      formatTokenCount(item.totalTokens),
      formatCost(item.costUsd)
    ]));
  }

  async function printSessionDetail(parsed) {
    if (!parsed.sessionId) {
      throw new Error('session-detail 需要 --session-id');
    }
    const query = await prepareQuery(parsed);
    const session = modelUsageService.getSessionDetail(query);
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'session-detail', range: { from: query.from, to: query.to }, session }, null, 2));
      return;
    }
    log(`\x1b[36m[aih]\x1b[0m 会话模型明细 ${parsed.sessionId}`);
    if (session.length === 0) {
      log('  无记录');
      return;
    }
    printRows(log, ['provider', 'model', 'calls', 'input', 'output', 'cache', 'cost'], session.map((item) => [
      item.provider,
      item.model || '-',
      String(item.calls),
      formatTokenCount(item.inputTokens),
      formatTokenCount(item.outputTokens),
      formatTokenCount(item.cacheReadInputTokens + item.cacheCreationInputTokens),
      formatCost(item.costUsd)
    ]));
  }

  async function printScan(parsed) {
    await syncPricingBestEffort();
    const provider = parsed.reindexCodexForkHistory ? 'codex' : (parsed.provider || '');
    const result = modelUsageService.scan({
      provider,
      reindexCodexForkHistory: parsed.reindexCodexForkHistory === true
    });
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'scan', result }, null, 2));
      return;
    }
    const filesDeferred = Number(result.filesDeferred) || 0;
    const reindexRequired = Number(result.reindexRequired) || 0;
    log(`\x1b[36m[aih]\x1b[0m 模型用量扫描完成: files=${result.files}, records=${result.records}, prompts=${result.prompts}, skipped=${result.skipped}, filesDeferred=${filesDeferred}, reindexRequired=${reindexRequired}`);
    Object.entries(result.providers || {}).forEach(([name, item]) => {
      const reason = item.reason ? ` (${item.reason})` : '';
      log(`  - ${name}: files=${item.files}, records=${item.records}, prompts=${item.prompts}, skipped=${item.skipped}, filesDeferred=${Number(item.filesDeferred) || 0}, reindexRequired=${Number(item.reindexRequired) || 0}${reason}`);
    });
    if (reindexRequired > 0) {
      log('  需要显式维护: aih usage scan --reindex-codex-forks');
    }
  }

  async function printCostMaintenance(parsed) {
    if (!modelUsageService || typeof modelUsageService.syncPricingIfStale !== 'function') {
      throw new Error('模型用量定价维护不可用');
    }
    const result = await modelUsageService.syncPricingIfStale({
      recalculateCosts: true
    });
    if (!result || result.ok === false) {
      throw new Error(String(result && result.reason || '模型用量成本重算失败'));
    }
    if (parsed.json) {
      log(JSON.stringify({ ok: true, command: 'recalculate-costs', result }, null, 2));
      return;
    }
    log(`\x1b[36m[aih]\x1b[0m 模型用量成本重算完成: scanned=${Number(result.scanned) || 0}, recalculated=${Number(result.recalculated) || 0}, batches=${Number(result.batches) || 0}`);
  }

  async function printModelUsageReport(argv = []) {
    const parsed = parseModelUsageArgs(argv);
    const command = String(parsed.command || 'stats').trim().toLowerCase();
    if (command === 'stats' || command === 'summary') return printStats(parsed);
    if (command === 'models' || command === 'cost-by-model' || command === 'by-model') return printModels(parsed);
    if (command === 'sessions') return printSessions(parsed);
    if (command === 'session' || command === 'session-detail') return printSessionDetail(parsed);
    if (command === 'scan') return printScan(parsed);
    if (command === 'recalculate-costs') return printCostMaintenance(parsed);
    throw new Error(`未知 usage 命令: ${command}`);
  }

  return {
    printModelUsageReport,
    parseModelUsageArgs
  };
}

module.exports = {
  createModelUsageAccountingService,
  parseModelUsageArgs,
  __private: {
    formatCost,
    formatTokenCount,
    normalizeDateRange,
    parseLocalDateStart
  }
};
