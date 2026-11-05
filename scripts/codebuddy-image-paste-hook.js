#!/usr/bin/env node
'use strict';

// CodeBuddy CLI 的 `UserPromptSubmit` hook：把「粘贴图片路径」自动换成视觉描述。
//
// 背景：iTerm2 粘贴图片时只会把图片写进自己的临时目录，然后把**绝对路径**当文本
// 送进 CLI（例如 `/var/folders/.../pasted-image-20261104-182211-....png`）。
// CLI 和模型都只看到路径，看不到像素；aih 的 aih-collab skill 能借视觉模型，
// 但需要模型自己想起去调用。这个 hook 在用户提交 prompt 时自动完成同一件事：
//   1. 从 prompt 里找出 pasted-image-*.{png,jpg,webp,gif} 临时路径；
//   2. 调 aih 网关的 `/v1/models?capability=vision` 选一个视觉模型；
//   3. 把图片 base64 后发 `/v1/chat/completions` 取描述；
//   4. 以 `hookSpecificOutput.additionalContext` 注入给模型。
//
// 纪律：
//   * 只读临时目录里的 pasted-image-*，不读用户随便写的其它路径；
//   * 失败 fail-soft（不阻塞提交），注入一条「请用 aih-collab」的提示；
//   * 不输出图片字节/凭据，只输出描述文本；描述缓存按 (路径, mtime, size) 去重。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');

const HOOK_EVENT = 'UserPromptSubmit';
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 2400;
const GATEWAY_TIMEOUT_MS = 25000;
const MODEL_TIMEOUT_MS = 8000;
const PREFERRED_VISION_MODELS = Object.freeze([
  'gemini-3-flash',
  'gemini-2.5-flash',
  'claude-haiku-4.5',
  'deepseek-v4.1-flash'
]);
const TEMP_IMAGE_PATH_RE = /(?:\/private)?\/(?:var\/folders|tmp)\/[^\s"'`<>]+?pasted-image-[^\s"'`<>]+?\.(?:png|jpe?g|webp|gif)/gi;
const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从 prompt 里提取 iTerm2/终端粘贴产生的临时图片路径。
 * 只接受临时目录下的 `pasted-image-*`，避免 hook 被诱导读取任意文件。
 */
function findPastedImagePaths(prompt, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const max = Math.max(0, Number(options.max) || MAX_IMAGES);
  const text = String(prompt || '');
  const seen = new Set();
  const paths = [];
  for (const match of text.matchAll(TEMP_IMAGE_PATH_RE)) {
    let filePath = normalizeText(match[0]).replace(/[),.;:!?]+$/, '');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      const stat = fsImpl.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) continue;
    } catch (_error) {
      continue;
    }
    paths.push(filePath);
    if (paths.length >= max) break;
  }
  return paths;
}

function pickVisionModel(models) {
  const ids = (Array.isArray(models) ? models : [])
    .map((item) => normalizeText(item && (item.id || item.modelId)))
    .filter(Boolean);
  for (const preferred of PREFERRED_VISION_MODELS) {
    if (ids.includes(preferred)) return preferred;
  }
  return ids[0] || '';
}

function imageMimeType(filePath) {
  return IMAGE_MIME_BY_EXT[nodePath.extname(String(filePath || '')).toLowerCase()] || 'image/png';
}

function truncateDescription(value) {
  const text = normalizeText(value);
  return text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : text;
}

function cachePath() {
  return nodePath.join(nodeOs.tmpdir(), 'aih-codebuddy-image-hook-cache.json');
}

function readCache(fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(cachePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeCache(fsImpl, cache) {
  try {
    const entries = Object.entries(cache).slice(-20);
    fsImpl.writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
  } catch (_error) {
    // 缓存失败不影响主流程。
  }
}

function cacheKey(filePath, stat) {
  return `${filePath}|${Number(stat && stat.mtimeMs) || 0}|${Number(stat && stat.size) || 0}`;
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response || response.ok === false) return null;
    return await response.json().catch(() => null);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function describeImage(input) {
  const {
    filePath, baseUrl, apiKey, model, fetchImpl, fsImpl
  } = input;
  let stat;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (_error) {
    return { ok: false, reason: 'missing_file' };
  }
  const cache = readCache(fsImpl);
  const key = cacheKey(filePath, stat);
  const cached = normalizeText(cache[key]);
  if (cached) return { ok: true, description: cached, model: 'cache' };
  let base64 = '';
  try {
    base64 = fsImpl.readFileSync(filePath).toString('base64');
  } catch (_error) {
    return { ok: false, reason: 'read_failed' };
  }
  if (!base64) return { ok: false, reason: 'empty_image' };
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Describe this image concisely but completely: layout, all visible text verbatim, colors, objects, and anything needed to answer the user question. Do not invent details.'
        },
        {
          type: 'image_url',
          image_url: { url: `data:${imageMimeType(filePath)};base64,${base64}` }
        }
      ]
    }]
  };
  const payload = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    GATEWAY_TIMEOUT_MS
  );
  const content = payload && payload.choices && payload.choices[0]
    && payload.choices[0].message && payload.choices[0].message.content;
  const description = truncateDescription(
    Array.isArray(content)
      ? content.map((part) => normalizeText(part && part.text)).filter(Boolean).join('\n')
      : content
  );
  if (!description) return { ok: false, reason: 'empty_description' };
  cache[key] = description;
  writeCache(fsImpl, cache);
  return { ok: true, description, model };
}

/**
 * 纯逻辑入口：给定 hook stdin 文本与环境，返回要注入的 additionalContext。
 * 无图片/无网关/失败时都不抛错；失败给一条明确的 fallback 指令。
 */
async function runHook(input = {}) {
  const env = input.env || process.env;
  const fsImpl = input.fs || nodeFs;
  const fetchImpl = input.fetch || fetch;
  let hookInput = input.hookInput;
  if (!hookInput && input.stdinText) {
    try {
      hookInput = JSON.parse(String(input.stdinText));
    } catch (_error) {
      hookInput = null;
    }
  }
  const prompt = normalizeText(hookInput && hookInput.prompt);
  if (!prompt) return { additionalContext: '' };
  const imagePaths = findPastedImagePaths(prompt, { fs: fsImpl });
  if (imagePaths.length === 0) return { additionalContext: '' };

  const baseUrl = normalizeText(env.AIH_GATEWAY_BASE_URL);
  const apiKey = normalizeText(env.AIH_GATEWAY_API_KEY);
  // 共享 settings 也会被非 aih 启动的 CodeBuddy 读到；没有 aih 网关标记时
  // 保持完全静默，不改变原生 CLI 的粘贴行为。
  if (!baseUrl) return { additionalContext: '' };
  if (!apiKey) {
    return {
      additionalContext: `[aih image hook] 用户粘贴了图片（${imagePaths.map((p) => nodePath.basename(p)).join(', ')}），但当前没有 AIH_GATEWAY_API_KEY，无法自动借视觉模型。请用 aih-collab skill 读取该路径。`
    };
  }
  const models = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/models?capability=vision`,
    { headers: { authorization: `Bearer ${apiKey}` } },
    MODEL_TIMEOUT_MS
  ).catch(() => null);
  const model = pickVisionModel(models && models.data);
  if (!model) {
    return {
      additionalContext: `[aih image hook] 用户粘贴了图片（${imagePaths.map((p) => nodePath.basename(p)).join(', ')}），但网关没有可用的视觉模型。请用 aih-collab skill 或让用户描述图片。`
    };
  }

  const descriptions = [];
  for (const filePath of imagePaths) {
    const result = await describeImage({
      filePath, baseUrl, apiKey, model, fetchImpl, fsImpl
    }).catch(() => ({ ok: false, reason: 'request_failed' }));
    if (result.ok) {
      descriptions.push(`- ${nodePath.basename(filePath)}: ${result.description}`);
    } else {
      descriptions.push(`- ${nodePath.basename(filePath)}: 自动描述失败（${result.reason}）`);
    }
  }
  const text = descriptions.join('\n');
  return {
    additionalContext:
      `[aih image hook] 用户粘贴了图片，视觉模型（${model}）的描述如下，请把它当作 ground truth，直接用于回答；不要声称看不到图片，也不要再重复调用视觉工具。\n${text}`
  };
}

function hookOutput(additionalContext) {
  const context = normalizeText(additionalContext);
  if (!context) return null;
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      additionalContext: context
    }
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { text += chunk; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      setTimeout(done, 2000).unref?.();
    } catch (_error) {
      done();
    }
  });
}

if (require.main === module) {
  readStdin()
    .then((stdinText) => runHook({ stdinText }))
    .then((result) => {
      const output = hookOutput(result && result.additionalContext);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    })
    .catch(() => {
      // hook 失败不能阻塞用户提交。
    });
}

module.exports = {
  HOOK_EVENT,
  PREFERRED_VISION_MODELS,
  TEMP_IMAGE_PATH_RE,
  cachePath,
  findPastedImagePaths,
  hookOutput,
  pickVisionModel,
  runHook
};
