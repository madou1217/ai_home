package qodercred

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero/api"
)

// PreparedRequest 是厂商 wasm 签出的完整请求（URL 已含 query，Headers 已含签名头）。
type PreparedRequest struct {
	URL     string
	Headers map[string]string
	Body    string
}

// ErrRuntimeClosed 表示签名运行时已关闭。
var ErrRuntimeClosed = errors.New("qoder 签名运行时已关闭")

// SigningRuntime 是 qoder 客户端的「完整运行时」：newContext / prepareRequest /
// decryptServerResponse / model_cache_decrypt。
//
// 与凭据解密分开实例是刻意的：Node 侧 2026-10-21 实测，同一个实例上先调
// credential_storage_decrypt 再 newContext 会直接 wasm trap（Rust 侧有全局状态）。
// 因此解密走短期实例，签名走这里的长生命周期实例；两者都按账号/进程隔离。
type SigningRuntime struct {
	mu      sync.Mutex
	module  api.Module
	runtime *instanceRuntime
}

// instanceRuntime 持有可关闭的运行时（与 wasmInstance 共用一套宿主）。
type instanceRuntime = wasmInstance

// NewSigningRuntime 创建签名运行时（按需编译 wasm，实例复用）。
func NewSigningRuntime(provider string, options Options) (*SigningRuntime, error) {
	wasmBytes, err := loadWasm(provider, options)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), decryptTimeout)
	defer cancel()
	instance, err := newInstance(ctx, wasmBytes)
	if err != nil {
		return nil, err
	}
	return &SigningRuntime{runtime: instance, module: instance.module}, nil
}

// Close 释放 wasm 运行时。
func (runtime *SigningRuntime) Close(ctx context.Context) {
	if runtime == nil {
		return
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.runtime != nil {
		runtime.runtime.close(ctx)
		runtime.runtime = nil
	}
	runtime.module = nil
}

// NewContext 用已解密的登录态创建签名上下文。
//
// userInfoJSON 必须是 CLI 写出的**原始明文**（不要再 marshal：字段顺序与额外字段
// 都可能参与指纹计算）。
func (runtime *SigningRuntime) NewContext(
	ctx context.Context,
	machineID, version, userInfoJSON string,
) (uint32, error) {
	return runtime.newContext(ctx, machineID, version, userInfoJSON, "")
}

func (runtime *SigningRuntime) newContext(
	ctx context.Context,
	machineID, version, userInfoJSON, optionsJSON string,
) (uint32, error) {
	module, err := runtime.acquire()
	if err != nil {
		return 0, err
	}
	defer runtime.mu.Unlock()
	machinePtr, machineLen, err := writeString(ctx, module, mallocOf(module), machineID)
	if err != nil {
		return 0, err
	}
	versionPtr, versionLen, err := writeString(ctx, module, mallocOf(module), version)
	if err != nil {
		return 0, err
	}
	userPtr, userLen, err := writeString(ctx, module, mallocOf(module), userInfoJSON)
	if err != nil {
		return 0, err
	}
	optionsPtr, optionsLen := uint32(0), uint32(0)
	if optionsJSON != "" {
		optionsPtr, optionsLen, err = writeString(ctx, module, mallocOf(module), optionsJSON)
		if err != nil {
			return 0, err
		}
	}
	addToStack := module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	newContextFn := module.ExportedFunction("qodercontext_new")
	if addToStack == nil || newContextFn == nil {
		return 0, ErrWasmMissing
	}
	ret, err := callWithRet(ctx, addToStack, func(ret uint32) error {
		_, callErr := newContextFn.Call(
			ctx,
			uint64(ret),
			uint64(machinePtr), uint64(machineLen),
			uint64(versionPtr), uint64(versionLen),
			uint64(userPtr), uint64(userLen),
			uint64(optionsPtr), uint64(optionsLen),
		)
		return callErr
	})
	if err != nil {
		if hint := runtime.throwHint(); hint != "" {
			return 0, fmt.Errorf("%w: %s", err, hint)
		}
		return 0, err
	}
	pointer, errPtr, failed, readErr := readTriple(module, ret)
	if readErr != nil {
		return 0, readErr
	}
	if failed != 0 {
		return 0, runtime.stateError(errPtr)
	}
	return pointer, nil
}

// PrepareRequest 让 wasm 为一次请求生成完整 URL 与签名头。
//
// mode 取 "auth" 或 "sign"：前者走登录态鉴权（模型目录），后者只签名（推理）。
func (runtime *SigningRuntime) PrepareRequest(
	ctx context.Context,
	contextID uint32,
	endpoint, path, method, mode string,
) (PreparedRequest, error) {
	module, err := runtime.acquire()
	if err != nil {
		return PreparedRequest{}, err
	}
	defer runtime.mu.Unlock()
	endpointPtr, endpointLen, err := writeString(ctx, module, mallocOf(module), endpoint)
	if err != nil {
		return PreparedRequest{}, err
	}
	pathPtr, pathLen, err := writeString(ctx, module, mallocOf(module), path)
	if err != nil {
		return PreparedRequest{}, err
	}
	methodPtr, methodLen, err := writeString(ctx, module, mallocOf(module), method)
	if err != nil {
		return PreparedRequest{}, err
	}
	modePtr, modeLen, err := writeString(ctx, module, mallocOf(module), mode)
	if err != nil {
		return PreparedRequest{}, err
	}
	addToStack := module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	prepareFn := module.ExportedFunction("qodercontext_prepareRequest")
	if addToStack == nil || prepareFn == nil {
		return PreparedRequest{}, ErrWasmMissing
	}
	ret, err := callWithRet(ctx, addToStack, func(ret uint32) error {
		_, callErr := prepareFn.Call(
			ctx,
			uint64(ret),
			uint64(contextID),
			uint64(endpointPtr), uint64(endpointLen),
			uint64(pathPtr), uint64(pathLen),
			uint64(methodPtr), uint64(methodLen),
			uint64(modePtr), uint64(modeLen),
			0, 0, // body 缺省：wasm 侧按 Option 处理
			0, 0, // headers 缺省
		)
		return callErr
	})
	if err != nil {
		if hint := runtime.throwHint(); hint != "" {
			return PreparedRequest{}, fmt.Errorf("%w: %s", err, hint)
		}
		return PreparedRequest{}, err
	}
	resultPtr, errPtr, failed, readErr := readTriple(module, ret)
	if readErr != nil {
		return PreparedRequest{}, readErr
	}
	if failed != 0 {
		return PreparedRequest{}, runtime.stateError(errPtr)
	}
	if free := module.ExportedFunction("__wbg_requestresult_free"); free != nil {
		defer func() { _, _ = free.Call(context.Background(), uint64(resultPtr), 0) }()
	}
	return runtime.readRequestResult(ctx, module, resultPtr)
}

// readRequestResult 读取 RequestResult 三件套（url/headers/body）。
func (runtime *SigningRuntime) readRequestResult(ctx context.Context, module api.Module, resultPtr uint32) (PreparedRequest, error) {
	url, err := readRequestString(ctx, module, resultPtr, "requestresult_url")
	if err != nil {
		return PreparedRequest{}, err
	}
	body, err := readRequestString(ctx, module, resultPtr, "requestresult_body")
	if err != nil {
		return PreparedRequest{}, err
	}
	headers, err := readHeaders(ctx, module, runtime.runtime.state, resultPtr)
	if err != nil {
		return PreparedRequest{}, err
	}
	return PreparedRequest{URL: url, Headers: headers, Body: body}, nil
}

// PrepareInferRequest 让 wasm 为推理请求生成完整 URL、签名头与**自定义编码的请求体**。
//
// 返回的 Body 不是明文 JSON：客户端还要 zstd(level 1) 压缩并带 Content-Encoding: zstd。
func (runtime *SigningRuntime) PrepareInferRequest(
	ctx context.Context,
	contextID uint32,
	endpoint, bodyJSON, modelKey, modelSource string,
) (PreparedRequest, error) {
	module, err := runtime.acquire()
	if err != nil {
		return PreparedRequest{}, err
	}
	defer runtime.mu.Unlock()
	endpointPtr, endpointLen, err := writeString(ctx, module, mallocOf(module), endpoint)
	if err != nil {
		return PreparedRequest{}, err
	}
	bodyPtr, bodyLen, err := writeString(ctx, module, mallocOf(module), bodyJSON)
	if err != nil {
		return PreparedRequest{}, err
	}
	modelPtr, modelLen, err := writeString(ctx, module, mallocOf(module), modelKey)
	if err != nil {
		return PreparedRequest{}, err
	}
	sourcePtr, sourceLen, err := writeString(ctx, module, mallocOf(module), modelSource)
	if err != nil {
		return PreparedRequest{}, err
	}
	addToStack := module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	prepareFn := module.ExportedFunction("qodercontext_prepareInferRequest")
	if addToStack == nil || prepareFn == nil {
		return PreparedRequest{}, ErrWasmMissing
	}
	ret, err := callWithRet(ctx, addToStack, func(ret uint32) error {
		_, callErr := prepareFn.Call(
			ctx,
			uint64(ret),
			uint64(contextID),
			uint64(endpointPtr), uint64(endpointLen),
			uint64(bodyPtr), uint64(bodyLen),
			uint64(modelPtr), uint64(modelLen),
			uint64(sourcePtr), uint64(sourceLen),
		)
		return callErr
	})
	if err != nil {
		if hint := runtime.throwHint(); hint != "" {
			return PreparedRequest{}, fmt.Errorf("%w: %s", err, hint)
		}
		return PreparedRequest{}, err
	}
	resultPtr, errPtr, failed, readErr := readTriple(module, ret)
	if readErr != nil {
		return PreparedRequest{}, readErr
	}
	if failed != 0 {
		return PreparedRequest{}, runtime.stateError(errPtr)
	}
	if free := module.ExportedFunction("__wbg_requestresult_free"); free != nil {
		defer func() { _, _ = free.Call(context.Background(), uint64(resultPtr), 0) }()
	}
	return runtime.readRequestResult(ctx, module, resultPtr)
}

// DecryptServerResponse 解密被编码的服务端响应体。
func (runtime *SigningRuntime) DecryptServerResponse(ctx context.Context, cipherText string) (string, error) {
	return runtime.callStringExport(ctx, "decrypt_server_response", cipherText, "")
}

// DecryptModelCache 解密本地模型缓存（key 是账号 uid）。
func (runtime *SigningRuntime) DecryptModelCache(ctx context.Context, cipherText, uid string) (string, error) {
	return runtime.callStringExport(ctx, "model_cache_decrypt", cipherText, uid)
}

// FreeContext 释放 wasm 侧上下文。
func (runtime *SigningRuntime) FreeContext(contextID uint32) {
	if runtime == nil || contextID == 0 {
		return
	}
	module, err := runtime.acquire()
	if err != nil {
		return
	}
	defer runtime.mu.Unlock()
	if free := module.ExportedFunction("__wbg_qodercontext_free"); free != nil {
		_, _ = free.Call(context.Background(), uint64(contextID), 0)
	}
}

// acquire 锁住运行时并返回 wasm 模块；调用方负责 Unlock。
func (runtime *SigningRuntime) acquire() (api.Module, error) {
	if runtime == nil {
		return nil, ErrRuntimeClosed
	}
	runtime.mu.Lock()
	if runtime.module == nil {
		runtime.mu.Unlock()
		return nil, ErrRuntimeClosed
	}
	return runtime.module, nil
}

// throwHint 返回 wasm 侧最近一次 throw 的消息（Rust panic 的唯一线索）。
func (runtime *SigningRuntime) throwHint() string {
	if runtime == nil || runtime.runtime == nil {
		return ""
	}
	return runtime.runtime.state.lastThrow
}

func (runtime *SigningRuntime) stateError(errPtr uint32) error {
	message := ""
	if runtime.runtime != nil {
		message = runtime.runtime.state.takeError(errPtr)
	}
	if message == "" {
		message = "wasm 返回错误"
	}
	return fmt.Errorf("%w: %s", ErrDecryptFailed, message)
}

// callStringExport 处理 (ret, ptr, len, keyPtr, keyLen) 形态的字符串导出。
func (runtime *SigningRuntime) callStringExport(
	ctx context.Context,
	name, value, key string,
) (string, error) {
	module, err := runtime.acquire()
	if err != nil {
		return "", err
	}
	defer runtime.mu.Unlock()
	valuePtr, valueLen, err := writeString(ctx, module, mallocOf(module), value)
	if err != nil {
		return "", err
	}
	keyPtr, keyLen := uint32(0), uint32(0)
	if key != "" {
		keyPtr, keyLen, err = writeString(ctx, module, mallocOf(module), key)
		if err != nil {
			return "", err
		}
	}
	fn := module.ExportedFunction(name)
	addToStack := module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	if fn == nil || addToStack == nil {
		return "", ErrWasmMissing
	}
	ret, err := callWithRet(ctx, addToStack, func(ret uint32) error {
		_, callErr := fn.Call(ctx, uint64(ret), uint64(valuePtr), uint64(valueLen), uint64(keyPtr), uint64(keyLen))
		return callErr
	})
	if err != nil {
		return "", err
	}
	pointer, length, errPtr, failed, readErr := readResult(module, ret)
	if readErr != nil {
		return "", readErr
	}
	if failed != 0 {
		return "", runtime.stateError(errPtr)
	}
	out, ok := module.Memory().Read(pointer, length)
	if !ok {
		return "", ErrDecryptFailed
	}
	result := string(append([]byte(nil), out...))
	if free := module.ExportedFunction("__wbindgen_export4"); free != nil {
		_, _ = free.Call(ctx, uint64(pointer), uint64(length), 1)
	}
	return result, nil
}

// readHeaders 从 wasm 侧的 RequestResult 读回请求头。
//
// wasm-bindgen 用 js_sys::Map 构造头表：先 __wbg_new_99cabae501c0a8a0 建 Map，
// 再逐条 __wbg_set_08463b1df38a7e29 写入。宿主把 Map 表示成 map[string]any，
// 因此这里按字符串键读。
func readHeaders(
	ctx context.Context,
	module api.Module,
	state *hostState,
	resultPtr uint32,
) (map[string]string, error) {
	headersFn := module.ExportedFunction("requestresult_headers")
	if headersFn == nil {
		return nil, ErrWasmMissing
	}
	values, err := headersFn.Call(ctx, uint64(resultPtr))
	if err != nil || len(values) == 0 {
		return nil, fmt.Errorf("%w: 读取请求头失败", ErrDecryptFailed)
	}
	object := state.take(uint32(values[0]))
	headers := map[string]string{}
	switch typed := object.(type) {
	case map[string]any:
		for key, value := range typed {
			if text, ok := value.(string); ok {
				headers[key] = text
			}
		}
	case map[string]string:
		for key, value := range typed {
			headers[key] = value
		}
	}
	if len(headers) == 0 {
		return nil, fmt.Errorf("%w: 请求头为空", ErrDecryptFailed)
	}
	return headers, nil
}

func readRequestString(ctx context.Context, module api.Module, resultPtr uint32, name string) (string, error) {
	fn := module.ExportedFunction(name)
	addToStack := module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	if fn == nil || addToStack == nil {
		return "", ErrWasmMissing
	}
	ret, err := callWithRet(ctx, addToStack, func(ret uint32) error {
		_, callErr := fn.Call(ctx, uint64(ret), uint64(resultPtr))
		return callErr
	})
	if err != nil {
		return "", err
	}
	pointer, length, _, _, readErr := readResult(module, ret)
	if readErr != nil {
		return "", readErr
	}
	out, ok := module.Memory().Read(pointer, length)
	if !ok {
		return "", ErrDecryptFailed
	}
	result := string(append([]byte(nil), out...))
	if free := module.ExportedFunction("__wbindgen_export4"); free != nil {
		_, _ = free.Call(ctx, uint64(pointer), uint64(length), 1)
	}
	return result, nil
}

func mallocOf(module api.Module) api.Function {
	return module.ExportedFunction("__wbindgen_export2")
}

// callWithRet 预留 16 字节返回槽并调用 wasm，返回槽地址。
func callWithRet(
	ctx context.Context,
	addToStack api.Function,
	invoke func(ret uint32) error,
) (uint32, error) {
	stackPointer, err := addToStack.Call(ctx, encodeI32(-16))
	if err != nil || len(stackPointer) == 0 {
		return 0, fmt.Errorf("%w: 预留返回槽失败", ErrDecryptFailed)
	}
	ret := uint32(stackPointer[0])
	if err := invoke(ret); err != nil {
		_, _ = addToStack.Call(ctx, 16)
		return 0, fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	if _, err := addToStack.Call(ctx, 16); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	return ret, nil
}

// readTriple 读取 (value, errPtr, failed) 布局（newContext / prepareRequest）。
func readTriple(module api.Module, ret uint32) (value, errPtr, failed uint32, err error) {
	view, ok := module.Memory().Read(ret, 12)
	if !ok {
		return 0, 0, 0, ErrDecryptFailed
	}
	return binary.LittleEndian.Uint32(view[0:4]),
		binary.LittleEndian.Uint32(view[4:8]),
		binary.LittleEndian.Uint32(view[8:12]), nil
}
