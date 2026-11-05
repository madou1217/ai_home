package qodercred

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// wasmBase64Prefix 是 wasm 魔数 \0asm 的 base64 前缀；CLI 把 wasm 以 base64 内嵌。
	wasmBase64Prefix = "AGFzbQ"
	minWasmBytes     = 64 * 1024
	maxWasmBytes     = 8 * 1024 * 1024
	// maxCandidates 限制同一次扫描的候选数量，避免在超大二进制里无界搜索。
	maxCandidates = 16
	// decryptTimeout 覆盖首次编译 + 解密；vendor wasm 冷编译通常在百毫秒级。
	decryptTimeout = 20 * time.Second
)

var (
	// ErrNotOpaque 表示值不是 CLI 写的 opaque blob（可读 JSON / aih 信封）。
	ErrNotOpaque = errors.New("qoder 凭据不是 opaque blob")
	// ErrInvalidKey 表示 machineId 太短，无法作为 wasm 密钥。
	ErrInvalidKey = errors.New("qoder machineId 无效")
	// ErrRuntimeMissing 表示本机找不到可用的 qoder CLI 二进制。
	ErrRuntimeMissing = errors.New("qoder CLI 运行时不存")
	// ErrWasmMissing 表示二进制里没有导出 credential_storage_decrypt 的 wasm。
	ErrWasmMissing = errors.New("qoder 凭据 wasm 缺失")
	// ErrDecryptFailed 表示 wasm 解密失败（密钥不匹配或密文损坏）。
	ErrDecryptFailed = errors.New("qoder 凭据解密失败")
)

type extractedWasm struct {
	path  string
	size  int64
	mtime time.Time
	bytes []byte
}

var (
	extractMu    sync.Mutex
	extractCache = map[string]*extractedWasm{}
)

// loadWasm 找到 provider 对应的 CLI 二进制并取出内嵌 wasm。
func loadWasm(provider string, options Options) ([]byte, error) {
	candidates := candidateBinaries(provider, options)
	if len(candidates) == 0 {
		return nil, ErrRuntimeMissing
	}
	var lastErr error = ErrWasmMissing
	for _, candidate := range candidates {
		wasmBytes, err := wasmFromBinary(candidate)
		if err != nil {
			lastErr = err
			continue
		}
		return wasmBytes, nil
	}
	return nil, lastErr
}

// candidateBinaries 按安装布局列出 CLI 二进制，新版本优先。
func candidateBinaries(provider string, options Options) []string {
	if path := strings.TrimSpace(options.BinaryPath); path != "" {
		return []string{path}
	}
	home := resolveHostHome(options.HostHomeDir)
	if home == "" {
		return nil
	}
	normalized := normalizeProvider(provider)
	globalDir := ".qoder"
	binaryName := "qodercli"
	if normalized == "qodercn" {
		globalDir = ".qoder-cn"
		binaryName = "qoderclicn"
	}
	versionsRoot := filepath.Join(home, globalDir, "bin", binaryName)
	entries, err := os.ReadDir(versionsRoot)
	if err != nil {
		return nil
	}
	type versioned struct {
		name string
		path string
	}
	versions := make([]versioned, 0, len(entries))
	direct := ""
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(versionsRoot, entry.Name())
		if entry.Name() == binaryName {
			direct = path
			continue
		}
		if strings.HasPrefix(entry.Name(), binaryName+"-") {
			versions = append(versions, versioned{name: entry.Name(), path: path})
		}
	}
	// 目录名按字典序倒排：qodercli-1.1.81 > qodercli-1.1.80。
	sort.Slice(versions, func(i, j int) bool { return versions[i].name > versions[j].name })
	result := make([]string, 0, len(versions)+1)
	for _, item := range versions {
		result = append(result, item.path)
	}
	if direct != "" {
		result = append(result, direct)
	}
	return result
}

// CLIVersion 返回安装布局里的客户端版本：version.txt 优先，其次二进制名后缀。
//
// wasm 的 newContext 需要它参与客户端指纹；空版本会让签名头缺字段。
func CLIVersion(provider string, options Options) string {
	candidates := candidateBinaries(provider, options)
	if len(candidates) == 0 {
		return ""
	}
	dir := filepath.Dir(candidates[0])
	if data, err := os.ReadFile(filepath.Join(dir, "version.txt")); err == nil {
		if value := strings.TrimSpace(string(data)); value != "" {
			return value
		}
	}
	name := filepath.Base(candidates[0])
	if index := strings.LastIndex(name, "-"); index >= 0 && index+1 < len(name) {
		return strings.TrimSpace(name[index+1:])
	}
	return ""
}

func normalizeProvider(provider string) string {
	if strings.EqualFold(strings.TrimSpace(provider), "qodercn") {
		return "qodercn"
	}
	return "qoder"
}

// resolveHostHome 复刻 Node 的宿主 HOME 语义：显式注入 → AIH_HOST_HOME → 用户主目录。
func resolveHostHome(injected string) string {
	if value := strings.TrimSpace(injected); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv("AIH_HOST_HOME")); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(home)
}

// wasmFromBinary 读取二进制并抽出内嵌 wasm（按路径+大小+mtime 缓存）。
func wasmFromBinary(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrRuntimeMissing
	}
	key := fmt.Sprintf("%s:%d:%d", path, info.Size(), info.ModTime().UnixNano())
	extractMu.Lock()
	if cached, ok := extractCache[key]; ok {
		extractMu.Unlock()
		return cached.bytes, nil
	}
	extractMu.Unlock()

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ErrRuntimeMissing
	}
	wasmBytes := findAuthWasm(raw)
	if wasmBytes == nil {
		return nil, ErrWasmMissing
	}
	extractMu.Lock()
	if len(extractCache) > 8 {
		extractCache = map[string]*extractedWasm{}
	}
	extractCache[key] = &extractedWasm{path: path, size: info.Size(), mtime: info.ModTime(), bytes: wasmBytes}
	extractMu.Unlock()
	return wasmBytes, nil
}

// findAuthWasm 在二进制里搜 base64 内嵌的 wasm，挑导出 credential_storage_decrypt 的那个。
func findAuthWasm(raw []byte) []byte {
	cursor := 0
	found := 0
	for found < maxCandidates {
		at := bytes.Index(raw[cursor:], []byte(wasmBase64Prefix))
		if at < 0 {
			return nil
		}
		at += cursor
		cursor = at + len(wasmBase64Prefix)
		end := at
		for end < len(raw) && isBase64Byte(raw[end]) {
			end++
		}
		if end-at < minWasmBytes*4/3-4 {
			continue
		}
		candidate, err := base64.StdEncoding.DecodeString(string(raw[at:end]))
		if err != nil {
			continue
		}
		found++
		if len(candidate) < minWasmBytes || len(candidate) > maxWasmBytes {
			continue
		}
		if !bytes.HasPrefix(candidate, []byte("\x00asm")) {
			continue
		}
		// 导出名在 export section 里是明文；先做廉价过滤，再由 wazero 编译确认。
		if !bytes.Contains(candidate, []byte("credential_storage_decrypt")) {
			continue
		}
		if !bytes.Contains(candidate, []byte("memory")) {
			continue
		}
		return candidate
	}
	return nil
}

func isBase64Byte(value byte) bool {
	switch {
	case value >= 'A' && value <= 'Z':
		return true
	case value >= 'a' && value <= 'z':
		return true
	case value >= '0' && value <= '9':
		return true
	case value == '+', value == '/', value == '=':
		return true
	default:
		return false
	}
}

// decryptWithWasm 在一次性 wazero 实例里执行 credential_storage_decrypt。
func decryptWithWasm(wasmBytes []byte, cipherText, key string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), decryptTimeout)
	defer cancel()
	instance, err := newInstance(ctx, wasmBytes)
	if err != nil {
		return "", err
	}
	defer instance.close(ctx)
	return instance.decrypt(ctx, cipherText, key)
}
