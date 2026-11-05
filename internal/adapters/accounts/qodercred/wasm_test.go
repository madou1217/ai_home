package qodercred

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// testWasmExport 描述一个导出项；只支持 func(0x00) 与 memory(0x02)。
type testWasmExport struct {
	name  string
	kind  byte
	index byte
}

// leb128 编码 section 长度/向量长度。
func leb128(value int) []byte {
	var out []byte
	for {
		current := byte(value & 0x7f)
		value >>= 7
		if value != 0 {
			out = append(out, current|0x80)
			continue
		}
		return append(out, current)
	}
}

func wasmSection(id byte, payload []byte) []byte {
	out := []byte{id}
	out = append(out, leb128(len(payload))...)
	return append(out, payload...)
}

// padToSize 用 custom section（id=0，校验器会忽略其内容）把模块填充到目标长度。
// CLI 里内嵌的 wasm 动辄几 MB，findAuthWasm 有 64KB 下限，测试必须跨过这个门槛。
func padToSize(t *testing.T, module []byte, target int) []byte {
	t.Helper()
	for headerSize := 1; headerSize <= 4; headerSize++ {
		payloadLen := target - len(module) - 1 - headerSize
		if payloadLen < 8 || len(leb128(payloadLen)) != headerSize {
			continue
		}
		payload := make([]byte, payloadLen)
		payload[0] = 3
		copy(payload[1:], "pad")
		out := make([]byte, 0, target)
		out = append(out, module...)
		out = append(out, 0x00)
		out = append(out, leb128(payloadLen)...)
		out = append(out, payload...)
		return out
	}
	t.Fatalf("无法把 wasm 填充到 %d 字节", target)
	return nil
}

// buildTestWasm 拼一个结构合法的 wasm 模块：
// magic+version、type(func () -> ())、function、memory(1 页)、export、code(空函数体)。
// 导出项由调用方指定，用来区分「带解密导出」与「只有 memory」的候选。
func buildTestWasm(t *testing.T, targetSize int, exports []testWasmExport) []byte {
	t.Helper()
	module := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	module = append(module, wasmSection(1, []byte{0x01, 0x60, 0x00, 0x00})...) // 1 个类型：() -> ()
	module = append(module, wasmSection(3, []byte{0x01, 0x00})...)             // 1 个函数，用类型 0
	module = append(module, wasmSection(5, []byte{0x01, 0x00, 0x01})...)       // 1 页内存，无上限
	exportPayload := []byte{byte(len(exports))}
	for _, export := range exports {
		exportPayload = append(exportPayload, byte(len(export.name)))
		exportPayload = append(exportPayload, export.name...)
		exportPayload = append(exportPayload, export.kind, export.index)
	}
	module = append(module, wasmSection(7, exportPayload)...)
	module = append(module, wasmSection(10, []byte{0x01, 0x02, 0x00, 0x0b})...) // 函数体只有 end
	return padToSize(t, module, targetSize)
}

func authExports() []testWasmExport {
	return []testWasmExport{
		{name: "memory", kind: 0x02, index: 0},
		{name: "credential_storage_decrypt", kind: 0x00, index: 0},
	}
}

// filler 生成伪随机填充。只取 0x80 以上的字节：既不会意外出现 base64 前缀，
// 也不会和相邻的 base64 串粘成一个候选，保证测试稳定可复现。
func filler(seed int64, length int) []byte {
	rng := rand.New(rand.NewSource(seed))
	out := make([]byte, length)
	for index := range out {
		out[index] = byte(0x80 + rng.Intn(0x7f))
	}
	return out
}

// embedBinary 模拟 CLI 二进制：非 base64 前缀 + base64(wasm) + 后缀。
func embedBinary(wasmBytes []byte, seed int64) []byte {
	binary := filler(seed, 4096)
	binary = append(binary, 0x00)
	binary = append(binary, []byte(base64.StdEncoding.EncodeToString(wasmBytes))...)
	binary = append(binary, 0x00)
	return append(binary, filler(seed+100, 4096)...)
}

func TestFindAuthWasmRandomBytes(t *testing.T) {
	raw := filler(1, 64*1024)
	if bytes.Contains(raw, []byte(wasmBase64Prefix)) {
		t.Fatalf("测试数据不应包含 base64 前缀")
	}
	if got := findAuthWasm(raw); got != nil {
		t.Fatalf("随机字节不应抽出 wasm，得到 %d 字节", len(got))
	}
	if got := findAuthWasm(nil); got != nil {
		t.Fatalf("空二进制不应抽出 wasm")
	}
}

func TestFindAuthWasmExtractsEmbeddedModule(t *testing.T) {
	module := buildTestWasm(t, minWasmBytes+4096, authExports())
	binary := embedBinary(module, 2)

	got := findAuthWasm(binary)
	// 必须逐字节一致：多取到后缀/少取到尾部都会让 wazero 编译失败。
	if !bytes.Equal(got, module) {
		t.Fatalf("抽出的 wasm 与内嵌字节不一致: got %d bytes, want %d bytes", len(got), len(module))
	}
}

func TestFindAuthWasmSkipsCandidateWithoutExport(t *testing.T) {
	// 第一个候选只有 memory 导出，体积同样达标，用来确认选择依据是导出名而不是先到先得。
	plain := buildTestWasm(t, minWasmBytes+2048, []testWasmExport{{name: "memory", kind: 0x02, index: 0}})
	auth := buildTestWasm(t, minWasmBytes+8192, authExports())

	binary := filler(3, 2048)
	binary = append(binary, 0x00)
	binary = append(binary, []byte(base64.StdEncoding.EncodeToString(plain))...)
	binary = append(binary, 0x00)
	binary = append(binary, []byte(base64.StdEncoding.EncodeToString(auth))...)
	binary = append(binary, 0x00)
	binary = append(binary, filler(4, 2048)...)

	got := findAuthWasm(binary)
	if !bytes.Equal(got, auth) {
		t.Fatalf("应挑出带 credential_storage_decrypt 的候选: got %d bytes, want %d bytes", len(got), len(auth))
	}
}

func TestFindAuthWasmRejectsUndersizedModule(t *testing.T) {
	// 低于 64KB 的 wasm 是误命中（base64 片段之类），实现必须先按体积过滤。
	module := buildTestWasm(t, 4096, authExports())
	if got := findAuthWasm(embedBinary(module, 5)); got != nil {
		t.Fatalf("小于 %d 字节的候选不应被接受，得到 %d 字节", minWasmBytes, len(got))
	}
}

func TestCandidateBinariesOrdersVersionsThenDirect(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".qoder", "bin", "qodercli")
	// 目录形态通常是残留的安装目录，按现有实现要跳过。
	if err := os.MkdirAll(filepath.Join(dir, "qodercli-1.1.82"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	for _, name := range []string{"qodercli-1.1.80", "qodercli-1.1.81", "qodercli", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("stub"), 0o755); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
	}

	got := candidateBinaries("qoder", Options{HostHomeDir: home})
	want := []string{
		filepath.Join(dir, "qodercli-1.1.81"), // 新版本优先
		filepath.Join(dir, "qodercli-1.1.80"),
		filepath.Join(dir, "qodercli"), // 直装文件最后
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidateBinaries() = %v, want %v", got, want)
	}
}

func TestCandidateBinariesQoderCNLayout(t *testing.T) {
	home := t.TempDir()
	cnDir := filepath.Join(home, ".qoder-cn", "bin", "qoderclicn")
	globalDir := filepath.Join(home, ".qoder", "bin", "qodercli")
	for _, dir := range []string{cnDir, globalDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(cnDir, "qoderclicn-1.2.0"), []byte("stub"), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cnDir, "qoderclicn"), []byte("stub"), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	// 国际版的布局不能被 qodercn 误用。
	if err := os.WriteFile(filepath.Join(globalDir, "qodercli-9.9.9"), []byte("stub"), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	got := candidateBinaries("QoderCN", Options{HostHomeDir: home})
	want := []string{
		filepath.Join(cnDir, "qoderclicn-1.2.0"),
		filepath.Join(cnDir, "qoderclicn"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("qodercn candidateBinaries() = %v, want %v", got, want)
	}
}

func TestCandidateBinariesBinaryPathOverride(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".qoder", "bin", "qodercli")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "qodercli-1.1.99"), []byte("stub"), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}

	// 显式注入优先于安装布局搜索，且只返回注入项；首尾空白要忽略。
	got := candidateBinaries("qoder", Options{HostHomeDir: home, BinaryPath: "  /custom/qodercli  "})
	if !reflect.DeepEqual(got, []string{"/custom/qodercli"}) {
		t.Fatalf("BinaryPath 注入应独占候选: %v", got)
	}
}

func TestCandidateBinariesWithoutInstallLayout(t *testing.T) {
	emptyHome := t.TempDir()
	if got := candidateBinaries("qoder", Options{HostHomeDir: emptyHome}); len(got) != 0 {
		t.Fatalf("没有安装布局时应无候选: %v", got)
	}

	// 目录存在但没有任何 CLI 文件时同理。
	dir := filepath.Join(emptyHome, ".qoder", "bin", "qodercli")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if got := candidateBinaries("qoder", Options{HostHomeDir: emptyHome}); len(got) != 0 {
		t.Fatalf("无关文件不应成为候选: %v", got)
	}
}

func TestWasmFromBinaryReadsEmbeddedModule(t *testing.T) {
	resetCaches(t)
	module := buildTestWasm(t, minWasmBytes+1024, authExports())
	path := filepath.Join(t.TempDir(), "qodercli")
	if err := os.WriteFile(path, embedBinary(module, 6), 0o755); err != nil {
		t.Fatalf("写假二进制失败: %v", err)
	}

	first, err := wasmFromBinary(path)
	if err != nil {
		t.Fatalf("wasmFromBinary() 失败: %v", err)
	}
	if !bytes.Equal(first, module) {
		t.Fatalf("首次读取的 wasm 不一致: got %d bytes, want %d bytes", len(first), len(module))
	}
	// 第二次按 path+size+mtime 命中 extractCache，内容必须仍然一致。
	second, err := wasmFromBinary(path)
	if err != nil {
		t.Fatalf("缓存读取失败: %v", err)
	}
	if !bytes.Equal(second, module) {
		t.Fatalf("缓存返回的 wasm 被改动: got %d bytes, want %d bytes", len(second), len(module))
	}
}

func TestWasmFromBinaryMissingOrUnusable(t *testing.T) {
	resetCaches(t)
	dir := t.TempDir()

	if _, err := wasmFromBinary(filepath.Join(dir, "absent")); !errors.Is(err, ErrRuntimeMissing) {
		t.Fatalf("文件不存在应返回 ErrRuntimeMissing，得到 %v", err)
	}
	// 目录不是普通文件，同样视为运行时不可用。
	if _, err := wasmFromBinary(dir); !errors.Is(err, ErrRuntimeMissing) {
		t.Fatalf("目录应返回 ErrRuntimeMissing，得到 %v", err)
	}

	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, filler(7, 8192), 0o755); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if _, err := wasmFromBinary(plain); !errors.Is(err, ErrWasmMissing) {
		t.Fatalf("二进制里没有 wasm 应返回 ErrWasmMissing，得到 %v", err)
	}
}

func TestNewInstanceAcceptsSyntheticModule(t *testing.T) {
	// 合成模块没有 import，必须能通过 wazero 编译并实例化；
	// 这一步同时证明下面的「缺导出」失败不是模块本身非法导致的。
	ctx := context.Background()
	instance, err := newInstance(ctx, buildTestWasm(t, minWasmBytes, authExports()))
	if err != nil {
		t.Fatalf("合成 wasm 应能实例化: %v", err)
	}
	defer instance.close(ctx)
	// 只导出 credential_storage_decrypt，缺少 malloc/栈指针导出时必须是 ErrWasmMissing。
	if _, err := instance.decrypt(ctx, "cipher", "0123456789abcdef"); !errors.Is(err, ErrWasmMissing) {
		t.Fatalf("缺少运行时导出应返回 ErrWasmMissing，得到 %v", err)
	}
	instance.close(ctx) // close 幂等，重复调用不能 panic
}

func TestDecryptBlobFailsWhenWasmLacksExports(t *testing.T) {
	resetCaches(t)
	// 合成模块能编译、能实例化，但缺少 __wbindgen_export2 / add_to_stack_pointer，
	// 必须在调用 wasm 前返回 ErrWasmMissing，而不是 panic 或挂住。
	path := filepath.Join(t.TempDir(), "qodercli")
	if err := os.WriteFile(path, embedBinary(buildTestWasm(t, minWasmBytes, authExports()), 8), 0o755); err != nil {
		t.Fatalf("写假二进制失败: %v", err)
	}
	_, err := DecryptBlob("qoder", opaqueBlob(64), "0123456789abcdef", Options{
		HostHomeDir: t.TempDir(),
		BinaryPath:  path,
	})
	if !errors.Is(err, ErrWasmMissing) {
		t.Fatalf("缺少运行时导出应返回 ErrWasmMissing，得到 %v", err)
	}
}
