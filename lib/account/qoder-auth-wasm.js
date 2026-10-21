'use strict';

// Qoder 客户端内嵌 WASM 的完整宿主（只做「让厂商自己的 wasm 跑起来」，不含密码学逆向）。
//
// `qoder-credential-decrypt.js` 只需要 `credential_storage_decrypt`，所以它的宿主只
// 实现了那一小部分 import。推理签名走的是同一个 wasm 的
//   qodercontext_new / qodercontext_prepareInferRequest
// 两条 Rust 入口，它们会用到 crypto / Map / Uint8Array / 时间等完整 wasm-bindgen
// 运行时面，必须补齐全部 import 才能实例化。这里的 ABI 来自 2026-10-20 对
// qodercli 1.1.73 与 qoderclicn 1.1.72 的离线复现（两个二进制内嵌的 wasm 字节一致）。
//
// 纪律：
//   * `newContext` / `prepare` 的输入字符串交给 Rust 侧持有，**调用方不能 free**；
//     释放会触发 wasm trap（double free）。这是实测结论，不是推测。
//   * 凭据明文只在本模块与调用方内存里出现，不落盘、不写日志。
//   * wasm 编译结果按字节哈希缓存；实例由调用方按客户端二进制缓存。

const nodeCrypto = require('node:crypto');

const moduleCache = new Map();
const MAX_MODULE_CACHE = 4;

function normalizeBytes(wasmBytes) {
  if (Buffer.isBuffer(wasmBytes)) return wasmBytes;
  if (wasmBytes instanceof Uint8Array) return Buffer.from(wasmBytes);
  return null;
}

function wasmCacheKey(bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

function getCompiledModule(bytes) {
  const key = wasmCacheKey(bytes);
  if (moduleCache.has(key)) return moduleCache.get(key);
  const compiled = new WebAssembly.Module(bytes);
  if (moduleCache.size >= MAX_MODULE_CACHE) moduleCache.clear();
  moduleCache.set(key, compiled);
  return compiled;
}

function resolveCrypto() {
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto;
  }
  return nodeCrypto.webcrypto;
}

/**
 * 用完整 wasm-bindgen 宿主实例化 Qoder 客户端 wasm。
 *
 * @param {Buffer|Uint8Array} wasmBytes 从 qodercli/qoderclicn 二进制抽出的 wasm 字节
 * @returns {{decrypt:Function,decryptModelCache:Function,decryptServerResponse:Function,
 *   newContext:Function,prepare:Function,prepareRequest:Function,freeContext:Function}}
 */
function createQoderAuthRuntime(wasmBytes) {
  const bytes = normalizeBytes(wasmBytes);
  if (!bytes || bytes.length === 0) {
    const error = new Error('qoder_auth_wasm_missing');
    error.code = 'qoder_auth_wasm_missing';
    throw error;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  const heap = new Array(132).fill(undefined);
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
  const passString = (value) => {
    const encoded = encoder.encode(value);
    const ptr = exportsRef.__wbindgen_export2(encoded.length, 1) >>> 0;
    new Uint8Array(exportsRef.memory.buffer, ptr, encoded.length).set(encoded);
    return { ptr, len: encoded.length };
  };
  const free = (ptr, len) => exportsRef.__wbindgen_export4(ptr, len, 1);
  const cryptoImpl = resolveCrypto();
  const imports = {
    './qoder_auth_wasm_bg.js': {
      __wbindgen_object_drop_ref: (index) => { takeObject(index); },
      __wbindgen_object_clone_ref: (index) => addHeapObject(getObject(index)),
      __wbindgen_cast_0000000000000001: (ptr, len) => addHeapObject(new Uint8Array(exportsRef.memory.buffer, ptr, len)),
      __wbindgen_cast_0000000000000002: (ptr, len) => addHeapObject(readString(ptr, len)),
      __wbg_set_08463b1df38a7e29: (target, key, value) => addHeapObject(getObject(target).set(getObject(key), getObject(value))),
      __wbg_getRandomValues_d49329ff89a07af1: (ptr, len) => {
        cryptoImpl.getRandomValues(new Uint8Array(exportsRef.memory.buffer, ptr, len));
      },
      __wbg_getRandomValues_c44a50d8cfdaebeb: (self, buffer) => {
        getObject(self).getRandomValues(getObject(buffer));
      },
      __wbg_randomFillSync_6c25eac9869eb53c: (self, buffer) => {
        getObject(self).randomFillSync(getObject(buffer));
      },
      __wbg_crypto_38df2bab126b63dc: () => addHeapObject(cryptoImpl),
      __wbg_msCrypto_bd5a034af96bcba6: () => addHeapObject(cryptoImpl),
      __wbg_process_44c7a14e11e9f69e: () => addHeapObject(process),
      __wbg_versions_276b2795b1c6a219: () => addHeapObject(process.versions),
      __wbg_node_84ea875411254db1: () => addHeapObject(process.versions.node),
      __wbg_require_b4edbdcf3e2a1ef0: () => addHeapObject(require),
      __wbg_call_d578befcc3145dee: (fn, thisArg, ...rest) => addHeapObject(
        getObject(fn).call(getObject(thisArg), ...rest.map(getObject))
      ),
      __wbg_new_with_length_9cedd08484b73942: (len) => addHeapObject(new Uint8Array(len >>> 0)),
      __wbg_length_0c32cb8543c8e4c8: (array) => getObject(array).length,
      __wbg_prototypesetcall_3e05eb9545565046: (ptr, len, source) => {
        Uint8Array.prototype.set.call(new Uint8Array(exportsRef.memory.buffer, ptr, len), getObject(source));
      },
      __wbg_subarray_0f98d3fb634508ad: (array, start, end) => addHeapObject(getObject(array).subarray(start >>> 0, end >>> 0)),
      __wbg_new_99cabae501c0a8a0: () => addHeapObject(new Map()),
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
  };
  const instance = new WebAssembly.Instance(getCompiledModule(bytes), imports);
  exportsRef = instance.exports;
  const readRet = (ptr) => new DataView(exportsRef.memory.buffer).getInt32(ptr, true);
  const throwIfFailed = (ret) => {
    const view = new DataView(exportsRef.memory.buffer);
    const errPtr = view.getInt32(ret + 4, true);
    const failed = view.getInt32(ret + 8, true);
    if (failed) throw takeObject(errPtr);
  };
  // 统一的「返回 (ptr,len) 的 wasm-bindgen 函数」调用形状：
  //   ret+0 = ptr, ret+4 = len, ret+8 = errPtr, ret+12 = failed；
  //   输出字符串归 JS 侧所有，读完必须 free(ptr,len,1)。
  // 输入字符串归 Rust 侧所有（与 credential_storage_decrypt 不同），调用方**不能 free**。
  const callStringResult = (invoke) => {
    const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
    let outPtr = 0;
    let outLen = 0;
    try {
      invoke(ret);
      const view = new DataView(exportsRef.memory.buffer);
      outPtr = view.getInt32(ret, true);
      outLen = view.getInt32(ret + 4, true);
      const errPtr = view.getInt32(ret + 8, true);
      const failed = view.getInt32(ret + 12, true);
      if (failed) throw new Error(String(takeObject(errPtr)));
      return readString(outPtr, outLen);
    } finally {
      exportsRef.__wbindgen_add_to_stack_pointer(16);
      if (outPtr && outLen) free(outPtr, outLen);
    }
  };
  const readRequestResult = (resultPtr) => {
    try {
      const urlRet = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      exportsRef.requestresult_url(urlRet, resultPtr);
      const urlView = new DataView(exportsRef.memory.buffer);
      const urlPtr = urlView.getInt32(urlRet, true);
      const urlLen = urlView.getInt32(urlRet + 4, true);
      const url = readString(urlPtr, urlLen);
      free(urlPtr, urlLen);
      exportsRef.__wbindgen_add_to_stack_pointer(16);

      const bodyRet = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      exportsRef.requestresult_body(bodyRet, resultPtr);
      const bodyView = new DataView(exportsRef.memory.buffer);
      const bodyPtr = bodyView.getInt32(bodyRet, true);
      const bodyLen = bodyView.getInt32(bodyRet + 4, true);
      const body = readString(bodyPtr, bodyLen);
      free(bodyPtr, bodyLen);
      exportsRef.__wbindgen_add_to_stack_pointer(16);

      const headers = takeObject(exportsRef.requestresult_headers(resultPtr));
      return { url, headers, body };
    } finally {
      exportsRef.__wbg_requestresult_free(resultPtr, 0);
    }
  };

  return {
    decrypt(cipherText, key) {
      const data = passString(cipherText);
      const keyPart = passString(key);
      const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      try {
        exportsRef.credential_storage_decrypt(ret, data.ptr, data.len, keyPart.ptr, keyPart.len);
        const view = new DataView(exportsRef.memory.buffer);
        const ptr = view.getInt32(ret, true);
        const len = view.getInt32(ret + 4, true);
        const errPtr = view.getInt32(ret + 8, true);
        const failed = view.getInt32(ret + 12, true);
        if (failed) throw new Error(String(takeObject(errPtr)));
        return readString(ptr, len);
      } finally {
        exportsRef.__wbindgen_add_to_stack_pointer(16);
        free(data.ptr, data.len);
        free(keyPart.ptr, keyPart.len);
      }
    },

    newContext(machineId, cosyVersion, userInfoJson, optionsJson) {
      const machine = passString(machineId);
      const version = passString(cosyVersion);
      const userInfo = passString(userInfoJson);
      const options = optionsJson === undefined
        ? { ptr: 0, len: 0 }
        : passString(optionsJson);
      const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      try {
        exportsRef.qodercontext_new(
          ret,
          machine.ptr, machine.len,
          version.ptr, version.len,
          userInfo.ptr, userInfo.len,
          options.ptr, options.len
        );
        throwIfFailed(ret);
        return readRet(ret);
      } finally {
        exportsRef.__wbindgen_add_to_stack_pointer(16);
        // qodercontext_new 接管输入字符串的释放；这里 free 会 double free。
      }
    },

    prepare(context, endpoint, bodyJson, modelKey, modelSource) {
      const endpointPart = passString(endpoint);
      const bodyPart = passString(bodyJson);
      const modelPart = passString(modelKey);
      const sourcePart = passString(modelSource);
      const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      let resultPtr = 0;
      try {
        exportsRef.qodercontext_prepareInferRequest(
          ret,
          context,
          endpointPart.ptr, endpointPart.len,
          bodyPart.ptr, bodyPart.len,
          modelPart.ptr, modelPart.len,
          sourcePart.ptr, sourcePart.len
        );
        throwIfFailed(ret);
        resultPtr = readRet(ret);
      } finally {
        exportsRef.__wbindgen_add_to_stack_pointer(16);
        // 与 newContext 相同：输入字符串归 Rust 侧所有。
      }
      return readRequestResult(resultPtr);
    },

    /**
     * 非推理请求的签名（模型目录 / BYOK / 队列状态等）。
     *
     * 官方 glue（qodercli 1.1.73 内嵌 JS）的同名调用：
     *   prepareRequest(endpoint, path, method, "auth"|"sign", body?, headersJson?)
     * body 与 headers 可缺省；缺省时传 (0,0)，wasm 侧按 Option 处理。
     */
    prepareRequest(context, input = {}) {
      const endpointPart = passString(input.endpoint || '');
      const pathPart = passString(input.path || '');
      const methodPart = passString(input.method || 'GET');
      const modePart = passString(input.mode || 'auth');
      const bodyPart = input.body === undefined || input.body === null
        ? { ptr: 0, len: 0 }
        : passString(String(input.body));
      const headersPart = input.headers === undefined || input.headers === null
        ? { ptr: 0, len: 0 }
        : passString(String(input.headers));
      const ret = exportsRef.__wbindgen_add_to_stack_pointer(-16);
      let resultPtr = 0;
      try {
        exportsRef.qodercontext_prepareRequest(
          ret,
          context,
          endpointPart.ptr, endpointPart.len,
          pathPart.ptr, pathPart.len,
          methodPart.ptr, methodPart.len,
          modePart.ptr, modePart.len,
          bodyPart.ptr, bodyPart.len,
          headersPart.ptr, headersPart.len
        );
        throwIfFailed(ret);
        resultPtr = readRet(ret);
      } finally {
        exportsRef.__wbindgen_add_to_stack_pointer(16);
        // 与 prepareInferRequest 相同：输入字符串归 Rust 侧所有。
      }
      return readRequestResult(resultPtr);
    },

    /**
     * 解密模型目录缓存（`.models/<uid>/catalog-v7`）。
     * 与 credential_storage_decrypt 不同，这里两个输入字符串**归 Rust 侧所有**，
     * 调用方 free 会触发 wasm trap（2026-10-21 实测）。
     */
    decryptModelCache(cipherText, uid) {
      const data = passString(cipherText);
      const keyPart = passString(uid);
      return callStringResult((ret) => {
        exportsRef.model_cache_decrypt(ret, data.ptr, data.len, keyPart.ptr, keyPart.len);
      });
    },

    /**
     * 解密服务端响应体（模型目录等接口返回的不是明文 JSON）。
     * 输入字符串同样归 Rust 侧所有，调用方不能 free。
     */
    decryptServerResponse(cipherText) {
      const data = passString(cipherText);
      return callStringResult((ret) => {
        exportsRef.decrypt_server_response(ret, data.ptr, data.len);
      });
    },

    freeContext(context) {
      exportsRef.__wbg_qodercontext_free(context, 0);
    }
  };
}

module.exports = {
  createQoderAuthRuntime,
  __private: {
    getCompiledModule,
    moduleCache
  }
};
