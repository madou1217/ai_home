package qodercred

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// importModule 是 CLI 内嵌 wasm 的 import 命名空间（wasm-bindgen 固定值）。
const importModule = "./qoder_auth_wasm_bg.js"

// compilationCache 跨实例复用编译结果：解密按调用建运行时，避免堆引用串到别的账号。
var compilationCache = wazero.NewCompilationCache()

// wasmInstance 是一次解密用的隔离实例（含独立 wasm-bindgen 堆）。
type wasmInstance struct {
	runtime wazero.Runtime
	module  api.Module
	state   *hostState
}

func newInstance(ctx context.Context, wasmBytes []byte) (*wasmInstance, error) {
	config := wazero.NewRuntimeConfig().
		WithCompilationCache(compilationCache).
		WithCloseOnContextDone(true)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	state := newHostState()
	if err := state.register(ctx, runtime); err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	compiled, err := runtime.CompileModule(ctx, wasmBytes)
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("%w: %v", ErrWasmMissing, err)
	}
	module, err := runtime.InstantiateModule(
		ctx,
		compiled,
		wazero.NewModuleConfig().WithName("qoder-auth").WithStartFunctions(),
	)
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("%w: %v", ErrWasmMissing, err)
	}
	return &wasmInstance{runtime: runtime, module: module, state: state}, nil
}

func (instance *wasmInstance) close(ctx context.Context) {
	if instance == nil || instance.runtime == nil {
		return
	}
	_ = instance.runtime.Close(ctx)
	instance.runtime = nil
	instance.module = nil
}

// decrypt 调用厂商 wasm 的 credential_storage_decrypt。
func (instance *wasmInstance) decrypt(ctx context.Context, cipherText, key string) (string, error) {
	decryptFn := instance.module.ExportedFunction("credential_storage_decrypt")
	mallocFn := instance.module.ExportedFunction("__wbindgen_export2")
	stackFn := instance.module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	if decryptFn == nil || mallocFn == nil || stackFn == nil {
		return "", ErrWasmMissing
	}
	dataPtr, dataLen, err := writeString(ctx, instance.module, mallocFn, cipherText)
	if err != nil {
		return "", err
	}
	keyPtr, keyLen, err := writeString(ctx, instance.module, mallocFn, key)
	if err != nil {
		return "", err
	}
	stackPointer, err := stackFn.Call(ctx, encodeI32(-16))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	ret := uint32(stackPointer[0])
	if _, err := decryptFn.Call(
		ctx,
		uint64(ret),
		uint64(dataPtr),
		uint64(dataLen),
		uint64(keyPtr),
		uint64(keyLen),
	); err != nil {
		_, _ = stackFn.Call(ctx, 16)
		return "", fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	ptr, length, errorPointer, failed, readErr := readResult(instance.module, ret)
	if _, err := stackFn.Call(ctx, 16); err != nil {
		return "", fmt.Errorf("%w: %v", ErrDecryptFailed, err)
	}
	if readErr != nil {
		return "", readErr
	}
	if failed != 0 {
		message := instance.state.takeError(errorPointer)
		if message == "" {
			message = "wasm 返回错误"
		}
		return "", fmt.Errorf("%w: %s", ErrDecryptFailed, message)
	}
	plaintext, ok := instance.module.Memory().Read(ptr, length)
	if !ok {
		return "", ErrDecryptFailed
	}
	// Read 返回的是内存视图，复制一份再离开调用栈。
	return string(append([]byte(nil), plaintext...)), nil
}

// writeString 用 wasm 自己的 malloc 分配并写入字符串。
func writeString(ctx context.Context, module api.Module, malloc api.Function, value string) (uint32, uint32, error) {
	bytes := []byte(value)
	result, err := malloc.Call(ctx, uint64(len(bytes)), 1)
	if err != nil || len(result) == 0 {
		return 0, 0, fmt.Errorf("%w: malloc 失败", ErrDecryptFailed)
	}
	ptr := uint32(result[0])
	if !module.Memory().Write(ptr, bytes) {
		return 0, 0, fmt.Errorf("%w: 写入 wasm 内存失败", ErrDecryptFailed)
	}
	return ptr, uint32(len(bytes)), nil
}

// readResult 读取 wasm-bindgen 返回值布局：ptr/len/errPtr/failed。
func readResult(module api.Module, ret uint32) (uint32, uint32, uint32, uint32, error) {
	view, ok := module.Memory().Read(ret, 16)
	if !ok {
		return 0, 0, 0, 0, ErrDecryptFailed
	}
	return binary.LittleEndian.Uint32(view[0:4]),
		binary.LittleEndian.Uint32(view[4:8]),
		binary.LittleEndian.Uint32(view[8:12]),
		binary.LittleEndian.Uint32(view[12:16]),
		nil
}

func encodeI32(value int32) uint64 {
	return uint64(uint32(value))
}

// hostState 复刻 wasm-bindgen JS glue 的堆语义（索引 >=132，132..131 是固定槽）。
type hostState struct {
	values []any
	next   int
	// lastThrow 记录 wasm 侧 throw 的消息：Rust panic 在 wasm 里往往紧跟一条
	// unreachable 指令，trap 本身不带原因，只能靠这里还原。
	lastThrow string
}

func newHostState() *hostState {
	state := &hostState{values: make([]any, 132), next: 132}
	state.values[128] = nil
	state.values[129] = nil
	state.values[130] = true
	state.values[131] = false
	return state
}

func (state *hostState) add(value any) uint32 {
	if state.next >= len(state.values) {
		state.values = append(state.values, state.next+1)
	}
	index := state.next
	if link, ok := state.values[index].(int); ok {
		state.next = link
	} else {
		state.next = index + 1
	}
	state.values[index] = value
	return uint32(index)
}

func (state *hostState) get(index uint32) any {
	if int(index) >= len(state.values) {
		return nil
	}
	return state.values[index]
}

func (state *hostState) drop(index uint32) {
	if index < 132 || int(index) >= len(state.values) {
		return
	}
	state.values[index] = state.next
	state.next = int(index)
}

func (state *hostState) take(index uint32) any {
	value := state.get(index)
	state.drop(index)
	return value
}

func (state *hostState) takeError(index uint32) string {
	value := state.take(index)
	switch typed := value.(type) {
	case nil:
		return ""
	case error:
		return typed.Error()
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

type hostFunc func(module api.Module, stack []uint64)

// register 注册全部 wasm-bindgen import。
//
// 解密路径只用到少数几个；其余按「不 trap、返回安全默认值」实现，保证实例化与
// 未来厂商小版本新增调用都不会把 aih 打挂。
func (state *hostState) register(ctx context.Context, runtime wazero.Runtime) error {
	builder := runtime.NewHostModuleBuilder(importModule)
	define := func(name string, params, results []api.ValueType, fn hostFunc) {
		builder.NewFunctionBuilder().
			WithGoModuleFunction(api.GoModuleFunc(func(_ context.Context, module api.Module, stack []uint64) {
				if os.Getenv("AIH_QODER_DEBUG") != "" && name != "__wbg_now_88621c9c9a4f3ffc" {
					fmt.Fprintf(os.Stderr, "qoder-host %s args=%v\n", name, stack)
				}
				fn(module, stack)
			}), params, results).
			Export(name)
	}
	i32 := []api.ValueType{api.ValueTypeI32}
	i32i32 := []api.ValueType{api.ValueTypeI32, api.ValueTypeI32}
	i32i32i32 := []api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32}
	noParams := []api.ValueType{}
	oneI32 := []api.ValueType{api.ValueTypeI32}
	oneF64 := []api.ValueType{api.ValueTypeF64}

	define("__wbindgen_object_drop_ref", i32, nil, func(_ api.Module, stack []uint64) {
		state.take(uint32(stack[0]))
	})
	define("__wbindgen_object_clone_ref", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(state.get(uint32(stack[0]))))
	})
	define("__wbindgen_cast_0000000000000001", i32i32, oneI32, func(module api.Module, stack []uint64) {
		ptr, length := uint32(stack[0]), uint32(stack[1])
		bytes, ok := module.Memory().Read(ptr, length)
		if !ok {
			stack[0] = uint64(state.add([]byte(nil)))
			return
		}
		stack[0] = uint64(state.add(append([]byte(nil), bytes...)))
	})
	define("__wbindgen_cast_0000000000000002", i32i32, oneI32, func(module api.Module, stack []uint64) {
		stack[0] = uint64(state.add(readStringValue(module, uint32(stack[0]), uint32(stack[1]))))
	})
	define("__wbg_set_08463b1df38a7e29", i32i32i32, oneI32, func(_ api.Module, stack []uint64) {
		target := state.get(uint32(stack[0]))
		key := state.get(uint32(stack[1]))
		value := state.get(uint32(stack[2]))
		if object, ok := target.(map[string]any); ok {
			if name, ok := key.(string); ok {
				object[name] = value
			}
		}
		stack[0] = uint64(state.add(nil))
	})
	define("__wbg_getRandomValues_d49329ff89a07af1", i32i32, nil, func(module api.Module, stack []uint64) {
		fillRandom(module, uint32(stack[0]), uint32(stack[1]))
	})
	define("__wbg_getRandomValues_c44a50d8cfdaebeb", i32i32, nil, func(_ api.Module, stack []uint64) {
		// 这条路径只服务随机数：堆里存的是 Go 侧切片副本，填它不会回写 wasm 内存。
		// 解密不需要随机数；如需支持 credential_storage_encrypt，要改成按内存视图写入。
		if buffer, ok := state.get(uint32(stack[1])).([]byte); ok {
			fillRandomSlice(buffer)
		}
	})
	define("__wbg_randomFillSync_6c25eac9869eb53c", i32i32, nil, func(module api.Module, stack []uint64) {
		_ = module
		_ = stack
	})
	// 下面五个 accessor 都带一个 self 参数（wasm-bindgen 把 JS 对象当参数传）。
	// getrandom 会先探测运行环境（globalThis/self/window/crypto/process/require），
	// 任何一步判成「不存在」都会走 Rust panic → unreachable。所以这些 accessor 必须
	// 返回 object/function 类型的占位符，不能返回字符串或 nil。
	define("__wbg_crypto_38df2bab126b63dc", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "crypto"}))
	})
	define("__wbg_msCrypto_bd5a034af96bcba6", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "crypto"}))
	})
	define("__wbg_process_44c7a14e11e9f69e", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "process"}))
	})
	define("__wbg_versions_276b2795b1c6a219", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "versions"}))
	})
	define("__wbg_node_84ea875411254db1", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add("22.0.0"))
	})
	define("__wbg_require_b4edbdcf3e2a1ef0", noParams, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "function"}))
	})
	define("__wbg_call_d578befcc3145dee", i32i32i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "object"}))
	})
	define("__wbg_new_with_length_9cedd08484b73942", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(make([]byte, uint32(stack[0]))))
	})
	define("__wbg_length_0c32cb8543c8e4c8", i32, oneI32, func(_ api.Module, stack []uint64) {
		value := state.get(uint32(stack[0]))
		switch typed := value.(type) {
		case []byte:
			stack[0] = uint64(uint32(len(typed)))
		case string:
			stack[0] = uint64(uint32(len(typed)))
		default:
			stack[0] = 0
		}
	})
	define("__wbg_prototypesetcall_3e05eb9545565046", i32i32i32, nil, func(module api.Module, stack []uint64) {
		ptr, length := uint32(stack[0]), uint32(stack[1])
		source := state.get(uint32(stack[2]))
		bytes, ok := source.([]byte)
		if !ok || len(bytes) < int(length) {
			return
		}
		_ = module.Memory().Write(ptr, bytes[:length])
	})
	define("__wbg_subarray_0f98d3fb634508ad", i32i32i32, oneI32, func(_ api.Module, stack []uint64) {
		value := state.get(uint32(stack[0]))
		start, end := int(uint32(stack[1])), int(uint32(stack[2]))
		bytes, ok := value.([]byte)
		if !ok {
			stack[0] = uint64(state.add([]byte(nil)))
			return
		}
		if start > len(bytes) {
			start = len(bytes)
		}
		if end > len(bytes) {
			end = len(bytes)
		}
		if end < start {
			end = start
		}
		stack[0] = uint64(state.add(bytes[start:end]))
	})
	define("__wbg_new_99cabae501c0a8a0", noParams, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(map[string]any{}))
	})
	define("__wbg_now_88621c9c9a4f3ffc", noParams, oneF64, func(_ api.Module, stack []uint64) {
		stack[0] = math.Float64bits(float64(time.Now().UnixMilli()))
	})
	staticAccessor := func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(hostObject{kind: "global"}))
	}
	define("__wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f", noParams, oneI32, staticAccessor)
	define("__wbg_static_accessor_SELF_24f78b6d23f286ea", noParams, oneI32, staticAccessor)
	define("__wbg_static_accessor_GLOBAL_f2e0f995a21329ff", noParams, oneI32, staticAccessor)
	define("__wbg_static_accessor_WINDOW_59fd959c540fe405", noParams, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(state.add(nil))
	})
	define("__wbg___wbindgen_throw_81fc77679af83bc6", i32i32, nil, func(module api.Module, stack []uint64) {
		// 不能从 host 抛异常穿过 wasm；记录消息由上层转成错误。
		state.lastThrow = readStringValue(module, uint32(stack[0]), uint32(stack[1]))
	})
	define("__wbg_Error_2e59b1b37a9a34c3", i32i32, oneI32, func(module api.Module, stack []uint64) {
		message := readStringValue(module, uint32(stack[0]), uint32(stack[1]))
		stack[0] = uint64(state.add(fmt.Errorf("%s", message)))
	})
	define("__wbg___wbindgen_is_object_40c5a80572e8f9d3", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(boolValue(isObject(state.get(uint32(stack[0])))))
	})
	define("__wbg___wbindgen_is_string_b29b5c5a8065ba1a", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(boolValue(isString(state.get(uint32(stack[0])))))
	})
	define("__wbg___wbindgen_is_function_49868bde5eb1e745", i32, oneI32, func(_ api.Module, stack []uint64) {
		object, ok := state.get(uint32(stack[0])).(hostObject)
		stack[0] = boolValue(ok && object.kind == "function")
	})
	define("__wbg___wbindgen_is_undefined_c0cca72b82b86f4d", i32, oneI32, func(_ api.Module, stack []uint64) {
		stack[0] = uint64(boolValue(state.get(uint32(stack[0])) == nil))
	})
	_, err := builder.Instantiate(ctx)
	return err
}

func readStringValue(module api.Module, ptr, length uint32) string {
	bytes, ok := module.Memory().Read(ptr, length)
	if !ok {
		return ""
	}
	return string(bytes)
}

func fillRandom(module api.Module, ptr, length uint32) {
	bytes, ok := module.Memory().Read(ptr, length)
	if !ok {
		return
	}
	target := make([]byte, length)
	_, _ = rand.Read(target)
	copy(bytes, target)
}

func fillRandomSlice(bytes []byte) {
	_, _ = rand.Read(bytes)
}

// hostObject 是 JS 对象的占位符：只需要类型判定（typeof === "object"/"function"），
// 属性访问都走各自的专用 import。
type hostObject struct{ kind string }

func isObject(value any) bool {
	switch value.(type) {
	case map[string]any, []byte, hostObject:
		return true
	default:
		return false
	}
}

func isString(value any) bool {
	_, ok := value.(string)
	return ok
}

func boolValue(value bool) uint64 {
	if value {
		return 1
	}
	return 0
}
