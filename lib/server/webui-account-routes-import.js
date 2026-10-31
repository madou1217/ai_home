'use strict';
// 账号导入作业（只认本机原生格式，见 lib/account/native-account-transfer.js）。

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ensureDirSync } = require('./fs-compat');
const { importNativeAccounts } = require('../account/native-account-transfer');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsLiveEvent
} = require('./webui-account-live');
const { reloadRuntimeAccountsIfNeeded } = require('./webui-account-routes-utils');

const WEBUI_ACCOUNT_IMPORT_MAX_BYTES = 80 * 1024 * 1024;

const ACCOUNT_IMPORT_JOB_RETENTION_MS = 30 * 60 * 1000;

const ACCOUNT_IMPORT_JOB_MAX = 50;

const ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS = 250;

const accountImportJobs = new Map();

function createImportSummary() {
  return {
    imported: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    total: 0,
    providers: [],
    accounts: []
  };
}


function addImportedProvider(summary, provider) {
  if (!provider || summary.providers.includes(provider)) return;
  summary.providers.push(provider);
  summary.providers.sort();
}


function safeUploadRelativePath(value, fallbackName = '') {
  const raw = String(value || fallbackName || '').trim().replace(/\\/g, '/');
  const withoutRoot = raw.replace(/^\/+/, '');
  const parts = withoutRoot
    .split('/')
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part) => part !== '.' && part !== '..');
  return parts.join('/') || String(fallbackName || 'upload.json');
}


function decodeBase64UploadContent(value) {
  const text = String(value || '');
  const normalized = text.includes(',') && /^data:/i.test(text) ? text.slice(text.indexOf(',') + 1) : text;
  return Buffer.from(normalized, 'base64');
}


function normalizeUploadedFiles(payload) {
  const source = Array.isArray(payload && payload.files)
    ? payload.files
    : (payload && (payload.file || payload.content) ? [payload] : []);
  return source
    .map((item, index) => {
      const file = item && typeof item === 'object' ? item : {};
      const name = safeUploadRelativePath(file.relativePath || file.webkitRelativePath || file.name, `upload-${index + 1}.json`);
      const base64 = file.contentBase64 || file.base64 || (file.encoding === 'base64' ? file.content : '');
      const content = base64 ? decodeBase64UploadContent(base64) : Buffer.from(String(file.content || ''), 'utf8');
      return {
        name,
        content
      };
    })
    .filter((item) => item.name && item.content.length > 0);
}


function isImportJobActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}


function pruneAccountImportJobs(now = Date.now()) {
  for (const [jobId, job] of accountImportJobs.entries()) {
    if (isImportJobActive(job)) continue;
    const finishedAt = Number(job.finishedAt || job.updatedAt || job.createdAt || 0);
    if (finishedAt > 0 && now - finishedAt > ACCOUNT_IMPORT_JOB_RETENTION_MS) {
      accountImportJobs.delete(jobId);
    }
  }
  if (accountImportJobs.size <= ACCOUNT_IMPORT_JOB_MAX) return;
  const removable = Array.from(accountImportJobs.values())
    .filter((job) => !isImportJobActive(job))
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  while (accountImportJobs.size > ACCOUNT_IMPORT_JOB_MAX && removable.length > 0) {
    const job = removable.shift();
    if (job && job.id) accountImportJobs.delete(job.id);
  }
}


function findActiveAccountImportJob() {
  pruneAccountImportJobs();
  return Array.from(accountImportJobs.values()).find(isImportJobActive) || null;
}


function appendAccountImportJobLog(job, line) {
  if (!job) return;
  const text = String(line || '').trim();
  if (!text) return;
  const nextLogs = `${String(job.logs || '')}${text}\n`;
  job.logs = nextLogs.length > 20000 ? nextLogs.slice(nextLogs.length - 20000) : nextLogs;
  job.updatedAt = Date.now();
}


function serializeAccountImportJob(job) {
  if (!job) return null;
  return {
    id: String(job.id || ''),
    status: String(job.status || 'running'),
    mode: String(job.mode || ''),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    summary: job.summary || createImportSummary(),
    result: job.result || null,
    error: String(job.error || ''),
    logs: String(job.logs || ''),
    progress: job.progress || null
  };
}


function emitAccountImportJobEvent(ctx, job) {
  if (typeof emitAccountsLiveEvent !== 'function') return;
  emitAccountsLiveEvent(ctx, {
    type: 'import-job',
    job: serializeAccountImportJob(job)
  });
}


function emitAccountImportJobProgressEvent(ctx, job) {
  const now = Date.now();
  const progress = job && job.progress;
  const current = Number(progress && progress.current || 0);
  const total = Number(progress && progress.total || 0);
  const complete = total > 0 && current >= total;
  if (!complete && now - Number(job.lastProgressEventAt || 0) < ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS) return;
  job.lastProgressEventAt = now;
  emitAccountImportJobEvent(ctx, job);
}


function buildImportJobContext(ctx) {
  return {
    fs: ctx.fs,
    deps: ctx.deps,
    state: ctx.state,
    accountStateIndex: ctx.accountStateIndex,
    getProfileDir: ctx.getProfileDir,
    loadServerRuntimeAccounts: ctx.loadServerRuntimeAccounts,
    applyReloadState: ctx.applyReloadState,
    checkStatus: ctx.checkStatus,
    options: ctx.options || {}
  };
}


function buildImportJobResponse(job) {
  return {
    ok: true,
    status: job.status,
    jobId: job.id,
    imported: Number(job.summary && job.summary.imported || 0),
    summary: job.summary,
    result: job.result,
    job: serializeAccountImportJob(job)
  };
}


function createImportJobProgressUpdater(ctx, job) {
  return (current, total, label) => {
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current) || 0));
    job.progress = {
      current: safeCurrent,
      total: safeTotal,
      percent: Math.round((safeCurrent / safeTotal) * 100),
      label: String(label || '').trim()
    };
    job.updatedAt = Date.now();
    emitAccountImportJobProgressEvent(ctx, job);
  };
}


async function executeAccountImportPayload(ctx, payload, job) {
  const {
    fs,
    deps,
    accountStateIndex,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus
  } = ctx;
  const aiHomeDir = deps.aiHomeDir || '';
  const onProgress = createImportJobProgressUpdater(ctx, job);
  // 只认本机原生格式（native-account-transfer）。上传的每个文件、粘贴的文本都按同一格式解析；
  // 旧的 Antigravity / CLIProxyAPI / sub2api / 目录布局导入已移除（2026-10-31）。
  const documents = collectImportDocuments(payload);
  if (documents.length === 0) {
    const error = new Error('missing_import_content');
    error.statusCode = 400;
    throw error;
  }
  const summary = createImportSummary();
  const sourceResults = [];
  for (let index = 0; index < documents.length; index += 1) {
    const doc = documents[index];
    onProgress(index, documents.length, doc.name);
    const result = importNativeAccounts({
      fs,
      aiHomeDir,
      input: doc.content,
      accountArtifactHooks: deps.accountArtifactHooks
    });
    if (!result.ok) {
      summary.failed += 1;
      sourceResults.push({ source: doc.name, error: result.error });
      appendAccountImportJobLog(job, `${doc.name}: ${describeImportError(result.error)}`);
      continue;
    }
    mergeNativeImportSummary(summary, result);
    sourceResults.push({ source: doc.name, ...result.summary });
    for (const entry of result.accounts) {
      if (entry.status === 'invalid' || entry.status === 'failed') {
        appendAccountImportJobLog(job, `${doc.name}: ${entry.provider} ${entry.sourceRef || ''} ${entry.status} (${entry.reason})`);
      }
    }
  }
  onProgress(documents.length, documents.length, 'done');

  try {
    reloadRuntimeAccountsIfNeeded({
      ...ctx,
      fs,
      deps,
      accountStateIndex,
      getProfileDir,
      loadServerRuntimeAccounts,
      applyReloadState,
      checkStatus
    });
  } catch (_error) {}

  return {
    ok: true,
    imported: summary.imported,
    summary,
    result: { sourceResults }
  };
}

/** 上传文件（file/files）或粘贴文本（content/text）→ [{name, content}]。 */
function collectImportDocuments(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!Array.isArray(source.files) && typeof (source.text || source.content) === 'string' && !source.contentBase64) {
    const text = String(source.text || source.content || '').trim();
    return text ? [{ name: '粘贴内容', content: text }] : [];
  }
  return normalizeUploadedFiles(source)
    .filter((file) => /\.(json|txt)$/i.test(file.name))
    .map((file) => ({ name: file.name, content: file.content.toString('utf8') }));
}

function mergeNativeImportSummary(summary, result) {
  summary.total += result.summary.total;
  summary.created += result.summary.created;
  summary.updated += result.summary.updated;
  summary.skipped += result.summary.unchanged;
  summary.invalid += result.summary.invalid;
  summary.failed += result.summary.failed;
  summary.imported = summary.created + summary.updated;
  for (const entry of result.accounts) {
    if (entry.status === 'created' || entry.status === 'updated') {
      summary.accounts.push({ provider: entry.provider, accountRef: entry.accountRef, status: entry.status });
      addImportedProvider(summary, entry.provider);
    }
  }
}

const IMPORT_ERROR_TEXT = Object.freeze({
  invalid_json: '不是有效的 JSON',
  unsupported_import_format: '不是 aih 账号导出文件',
  unsupported_document_version: '导出文件版本不受支持',
  invalid_document: '导出文件结构损坏',
  too_many_accounts: '单个文件账号数超过上限'
});

function describeImportError(code) {
  return IMPORT_ERROR_TEXT[code] || code;
}


function startAccountImportJob(ctx, payload) {
  pruneAccountImportJobs();
  const now = Date.now();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    mode: String(payload && payload.mode || (payload && payload.content ? 'text' : 'json')),
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    summary: createImportSummary(),
    result: null,
    error: '',
    logs: '',
    progress: null,
    lastProgressEventAt: 0
  };
  accountImportJobs.set(job.id, job);
  const jobCtx = buildImportJobContext(ctx);
  emitAccountImportJobEvent(jobCtx, job);

  Promise.resolve()
    .then(async () => {
      job.status = 'running';
      job.updatedAt = Date.now();
      appendAccountImportJobLog(job, '导入任务已开始。');
      emitAccountImportJobEvent(jobCtx, job);
      const response = await executeAccountImportPayload(jobCtx, payload, job);
      job.summary = response.summary || createImportSummary();
      job.result = response.result || null;
      job.status = 'succeeded';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      appendAccountImportJobLog(job, `导入完成：写入 ${Number(job.summary.imported || 0)}，失败 ${Number(job.summary.failed || 0) + Number(job.summary.invalid || 0)}。`);
      emitAccountImportJobEvent(jobCtx, job);
    })
    .catch((error) => {
      job.status = 'failed';
      job.error = String((error && error.message) || error || 'import_failed');
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      appendAccountImportJobLog(job, `导入失败：${job.error}`);
      emitAccountImportJobEvent(jobCtx, job);
    });

  return job;
}


module.exports = { WEBUI_ACCOUNT_IMPORT_MAX_BYTES, ACCOUNT_IMPORT_JOB_RETENTION_MS, ACCOUNT_IMPORT_JOB_MAX, ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS, accountImportJobs, createImportSummary, addImportedProvider, safeUploadRelativePath, decodeBase64UploadContent, normalizeUploadedFiles, isImportJobActive, pruneAccountImportJobs, findActiveAccountImportJob, appendAccountImportJobLog, serializeAccountImportJob, emitAccountImportJobEvent, emitAccountImportJobProgressEvent, buildImportJobContext, buildImportJobResponse, createImportJobProgressUpdater, executeAccountImportPayload, startAccountImportJob, collectImportDocuments };
