'use strict';

// Qoder 凭据解密 —— 复用 **CLI 自己内嵌的 WASM**，不是逆向密码学。
//
// 问题：qoder CLI（1.1.x）把登录态写成 `.auth/user`（base64 密文）+ `.auth/machine_id`，
// 密文由 CLI 自带的 `qoder_auth_wasm_bg.wasm` 以 `machineId.slice(0,16)` 为密钥加解密
// （WASM 导出 `credential_storage_encrypt/decrypt`）。因此 aih 拿到的是**不可读**的
// opaque blob：`resolveQoderNativeAuthPayload` 返回 null → 身份 seed 推不出来 →
// 「从本机导入」「OAuth 登录任务」「导出」全部失败（missing_stable_identity）。
//
// 解法：CLI 是 Bun 单文件可执行，WASM 以 base64 内嵌其中。这里把它抽出来、用标准
// wasm-bindgen glue 实例化，再调厂商自己的 `credential_storage_decrypt` —— 解出来的
// 明文（uid / email / security_oauth_token …）只用于**身份推导**；写回 CLI 的仍是原始 blob。
//
// 纪律：只在能拿到 CLI 二进制时工作；任何一步失败都返回 null（fail-open，绝不抛）；
// 二进制里有多个 wasm，按「是否导出 credential_storage_decrypt」挑，不猜偏移。

const nodePath = require('node:path');

const WASM_BASE64_PREFIX = 'AGFzbQ'; // \0asm
const MAX_WASM_BYTES = 8 * 1024 * 1024;
const MIN_WASM_BYTES = 64 * 1024;
const extractionCache = new Map();

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function isRegularFile(fs, filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

/** 在 CLI 二进制里找内嵌 wasm 候选（base64 → 字节）。 */
function extractEmbeddedWasmCandidates(fs, binaryPath) {
  let raw = null;
  try {
    raw = fs.readFileSync(binaryPath);
  } catch (_error) {
    return [];
  }
  const text = raw.toString('latin1');
  const out = [];
  let cursor = 0;
  while (out.length < 16) {
    const at = text.indexOf(WASM_BASE64_PREFIX, cursor);
    if (at < 0) break;
    cursor = at + WASM_BASE64_PREFIX.length;
    let end = at;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      const isBase64 = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
      if (!isBase64) break;
      end += 1;
    }
    const base64 = text.slice(at, end);
    if (base64.length > MIN_WASM_BYTES) {
      try {
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length >= MIN_WASM_BYTES && bytes.length <= MAX_WASM_BYTES
          && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
          out.push({ bytes, offset: at });
        }
      } catch (_error) { /* 非法 base64 段跳过 */ }
    }
  }
  return out;
}

/** 挑出导出 credential_storage_decrypt 的那个 wasm。 */
function findQoderAuthWasm(fs, binaryPath) {
  for (const candidate of extractEmbeddedWasmCandidates(fs, binaryPath)) {
    try {
      const mod = new WebAssembly.Module(candidate.bytes);
      const names = WebAssembly.Module.exports(mod).map((entry) => entry.name);
      if (names.includes('credential_storage_decrypt') && names.includes('memory')) {
        return candidate.bytes;
      }
    } catch (_error) { /* 非法 wasm 继续找 */ }
  }
  return null;
}

/** 取内嵌 wasm 字节（进程内缓存，160MB 二进制只扫一次）。 */
function readQoderAuthWasm(fs, binaryPath) {
  let stat = null;
  try {
    stat = fs.statSync(binaryPath);
  } catch (_error) {
    return null;
  }
  const key = `${binaryPath}:${stat.size}:${stat.mtimeMs}`;
  if (extractionCache.has(key)) return extractionCache.get(key);
  const bytes = findQoderAuthWasm(fs, binaryPath);
  if (extractionCache.size > 4) extractionCache.clear();
  extractionCache.set(key, bytes);
  return bytes;
}

/** 候选 CLI 路径（安装布局 = aih installer 的 ~/.qoder/bin/qodercli/）。 */
function listQoderCliCandidates(provider, options = {}) {
  const fs = options.fs || require('node:fs');
  const pathImpl = options.path || nodePath;
  const hostHomeDir = normalizeText(options.hostHomeDir) || normalizeText(process.env.HOME)
    || normalizeText(process.env.USERPROFILE);
  if (!hostHomeDir) return [];
  const normalized = normalizeText(provider).toLowerCase() === 'qodercn' ? 'qodercn' : 'qoder';
  const globalDir = normalized === 'qodercn' ? '.qoder-cn' : '.qoder';
  const binaryName = normalized === 'qodercn' ? 'qoderclicn' : 'qodercli';
  const versionsRoot = pathImpl.join(hostHomeDir, globalDir, 'bin', binaryName);
  const candidates = [];
  try {
    fs.readdirSync(versionsRoot)
      .filter((name) => name.startsWith(`${binaryName}-`))
      .sort()
      .reverse()
      .forEach((name) => {
        const candidate = pathImpl.join(versionsRoot, name);
        if (isRegularFile(fs, candidate)) candidates.push(candidate);
      });
  } catch (_error) { /* 目录不存在即无候选 */ }
  const direct = pathImpl.join(versionsRoot, binaryName);
  if (isRegularFile(fs, direct)) candidates.push(direct);
  return candidates;
}

/** 明文载荷 → 身份字段（uid / token）。 */
function readQoderCredentialIdentity(plaintext) {
  const text = normalizeText(plaintext);
  if (!text) return null;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const uid = normalizeText(payload.uid || payload.user_id || payload.userId
    || payload.account_id || payload.accountId || payload.id);
  const token = normalizeText(payload.security_oauth_token || payload.access_token
    || payload.accessToken || payload.token);
  return { payload, uid, token };
}

/** 标准 wasm-bindgen glue：实例化厂商 wasm（导出名固定，import 全是 JS 侧 shim）。 */
function instantiateQoderAuthWasm(wasmBytes) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  const heap = new Array(128).fill(undefined);
  heap.push(undefined, null, true, false);
  let heapNext = heap.length;
  const addHeapObject = (value) => {
    if (heapNext === heap.length) heap.push(heap.length + 1);
    const index = heapNext;
    heapNext = heap[index];
    heap[index] = value;
    return index;
  };
  const getObject = (index) => heap[index];
  const dropObject = (index) => {
    if (index < 132) return;
    heap[index] = heapNext;
    heapNext = index;
  };
  const takeObject = (index) => {
    const value = getObject(index);
    dropObject(index);
    return value;
  };

  let exportsRef = null;
  const readString = (ptr, len) => decoder.decode(new Uint8Array(exportsRef.memory.buffer, ptr, len));
  const passString = (value, malloc) => {
    const bytes = encoder.encode(value);
    const ptr = malloc(bytes.length, 1) >>> 0;
    new Uint8Array(exportsRef.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  };

  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, {
    './qoder_auth_wasm_bg.js': {
      __wbindgen_object_drop_ref: (index) => { takeObject(index); },
      __wbindgen_object_clone_ref: (index) => addHeapObject(getObject(index)),
      __wbindgen_cast_0000000000000001: (value) => value,
      __wbindgen_cast_0000000000000002: (value) => value,
      __wbg_set_08463b1df38a7e29: (target, prop, value) => Reflect.set(getObject(target), getObject(prop), getObject(value)),
      __wbg_getRandomValues_d49329ff89a07af1: (_self, buffer) => { globalThis.crypto.getRandomValues(getObject(buffer)); },
      __wbg_getRandomValues_c44a50d8cfdaebeb: (_self, buffer) => { globalThis.crypto.getRandomValues(getObject(buffer)); },
      __wbg_randomFillSync_6c25eac9869eb53c: (_self, view, buffer) => { getObject(view).set(getObject(buffer)); },
      __wbg_crypto_38df2bab126b63dc: () => addHeapObject(globalThis.crypto),
      __wbg_msCrypto_bd5a034af96bcba6: () => addHeapObject(globalThis.crypto),
      __wbg_process_44c7a14e11e9f69e: () => addHeapObject(process),
      __wbg_versions_276b2795b1c6a219: () => addHeapObject(process.versions),
      __wbg_node_84ea875411254db1: () => addHeapObject(process.versions.node),
      __wbg_require_b4edbdcf3e2a1ef0: () => addHeapObject(require),
      __wbg_call_d578befcc3145dee: (fn, thisArg, ...rest) => addHeapObject(
        getObject(fn).call(getObject(thisArg), ...rest.map(getObject))
      ),
      __wbg_new_with_length_9cedd08484b73942: (len) => addHeapObject(new Uint8Array(len)),
      __wbg_length_0c32cb8543c8e4c8: (array) => getObject(array).length,
      __wbg_prototypesetcall_3e05eb9545565046: (target, source, offset) => { getObject(target).set(getObject(source), offset); },
      __wbg_subarray_0f98d3fb634508ad: (array, start, end) => addHeapObject(getObject(array).subarray(start, end)),
      __wbg_new_99cabae501c0a8a0: () => addHeapObject({}),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => addHeapObject(globalThis),
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => addHeapObject(globalThis),
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => addHeapObject(globalThis),
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => addHeapObject(undefined),
      __wbg___wbindgen_throw_81fc77679af83bc6: (ptr, len) => { throw new Error(readString(ptr, len)); },
      __wbg_Error_2e59b1b37a9a34c3: (ptr, len) => addHeapObject(new Error(readString(ptr, len))),
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (index) => typeof getObject(index) === 'object',
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (index) => typeof getObject(index) === 'string',
      __wbg___wbindgen_is_function_49868bde5eb1e745: (index) => typeof getObject(index) === 'function',
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (index) => getObject(index) === undefined
    }
  });
  exportsRef = instance.exports;
  const free = exportsRef.__wbindgen_export;
  const malloc = exportsRef.__wbindgen_export2;
  const realloc = exportsRef.__wbindgen_export3;

  return {
    decrypt(cipherText, key) {
      const data = passString(cipherText, malloc, realloc);
      const keyPart = passString(key, malloc, realloc);
      const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      try {
        exportsRef.credential_storage_decrypt(ret, data.ptr, data.len, keyPart.ptr, keyPart.len);
        const view = new DataView(exportsRef.memory.buffer);
        const ptr = view.getInt32(ret + 0, true);
        const len = view.getInt32(ret + 4, true);
        const errPtr = view.getInt32(ret + 8, true);
        const failed = view.getInt32(ret + 12, true);
        if (failed) throw new Error(String(takeObject(errPtr)));
        return readString(ptr, len);
      } finally {
        exportsRef.__wbindgen_add_to_stack_pointer(16);
        free(data.ptr, data.len, 1);
        free(keyPart.ptr, keyPart.len, 1);
      }
    }
  };
}


/**
 * 解出 opaque qoder 凭据的明文载荷（身份推导用）。
 * @returns {{payload:object, uid:string, token:string}|null}
 */
function decryptQoderCredential(provider, nativeAuth, options = {}) {
  const fs = options.fs || require('node:fs');
  const source = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth : {};
  const blob = normalizeText(source.credentials);
  const machineId = normalizeText(source.machineId);
  if (!blob || !machineId) return null;
  // 可读 JSON / aih 自己的 iv:tag:cipher 由上层解析，这里只管 opaque blob。
  if (blob.startsWith('{') || blob.split(':').length === 3) return null;

  for (const binaryPath of listQoderCliCandidates(provider, options)) {
    const wasmBytes = readQoderAuthWasm(fs, binaryPath);
    if (!wasmBytes) continue;
    let plaintext = '';
    try {
      plaintext = instantiateQoderAuthWasm(wasmBytes).decrypt(blob, machineId.slice(0, 16));
    } catch (_error) {
      continue;
    }
    const identity = readQoderCredentialIdentity(plaintext);
    if (identity) return identity;
  }
  return null;
}

module.exports = {
  decryptQoderCredential,
  listQoderCliCandidates,
  __private: {
    extractEmbeddedWasmCandidates,
    findQoderAuthWasm,
    instantiateQoderAuthWasm,
    readQoderAuthWasm,
    readQoderCredentialIdentity
  }
};

