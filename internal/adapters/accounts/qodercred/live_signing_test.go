package qodercred

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLiveSigningRuntime 验证厂商 wasm 的签名入口能在 Go 运行时里跑通。
//
// 只做本地 wasm 调用，**不发任何 HTTP 请求**：qoder 带签名的请求有风控代价，
// 真机联调由主 agent 单独控制频率。
func TestLiveSigningRuntime(t *testing.T) {
	credentialFile := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_CREDENTIAL_FILE"))
	machineFile := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_MACHINE_FILE"))
	if credentialFile == "" || machineFile == "" {
		t.Skip("未提供 AIH_TEST_QODER_CREDENTIAL_FILE / AIH_TEST_QODER_MACHINE_FILE")
	}
	blob, err := os.ReadFile(credentialFile)
	if err != nil {
		t.Fatalf("读取凭据失败: %v", err)
	}
	machine, err := os.ReadFile(machineFile)
	if err != nil {
		t.Fatalf("读取 machineId 失败: %v", err)
	}
	home := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_HOST_HOME"))
	options := Options{HostHomeDir: home}
	native := map[string]any{
		"credentials": strings.TrimSpace(string(blob)),
		"machineId":   strings.TrimSpace(string(machine)),
	}
	plaintext, ok := DecryptNativeRaw("qoder", native, options)
	if !ok {
		t.Fatal("解密明文失败")
	}
	version := signingVersion(t, options)
	runtime, err := NewSigningRuntime("qoder", options)
	if err != nil {
		t.Fatalf("创建签名运行时失败: %v", err)
	}
	defer runtime.Close(context.Background())
	ctx := context.Background()
	contextID, err := runtime.NewContext(ctx, strings.TrimSpace(string(machine)), version, plaintext)
	if err != nil {
		t.Fatalf("NewContext 失败: %v", err)
	}
	defer runtime.FreeContext(contextID)
	prepared, err := runtime.PrepareRequest(
		ctx, contextID, "https://openapi.qoder.sh", "/api/v2/model/list?Encode=1", "GET", "auth",
	)
	if err != nil {
		t.Fatalf("PrepareRequest 失败: %v", err)
	}
	if !strings.HasPrefix(prepared.URL, "https://") {
		t.Fatalf("URL 非法: %q", prepared.URL)
	}
	if len(prepared.Headers) < 2 {
		t.Fatalf("签名头不足: %#v", prepared.Headers)
	}
	// 头名可能包含 Authorization / Cosy-* / User-Agent；只断言存在，不打印值。
	for name := range prepared.Headers {
		if strings.TrimSpace(name) == "" {
			t.Fatalf("出现空头名: %#v", prepared.Headers)
		}
	}
}

// signingVersion 从安装布局读 CLI 版本（version.txt 优先，其次二进制后缀）。
func signingVersion(t *testing.T, options Options) string {
	t.Helper()
	home := resolveHostHome(options.HostHomeDir)
	candidates := candidateBinaries("qoder", Options{HostHomeDir: home})
	if len(candidates) == 0 {
		t.Fatal("找不到 qoder CLI")
	}
	dir := filepath.Dir(candidates[0])
	if data, err := os.ReadFile(filepath.Join(dir, "version.txt")); err == nil {
		if value := strings.TrimSpace(string(data)); value != "" {
			return value
		}
	}
	name := filepath.Base(candidates[0])
	if index := strings.LastIndex(name, "qodercli-"); index >= 0 {
		return strings.TrimSpace(name[index+len("qodercli-"):])
	}
	t.Fatal("无法确定 CLI 版本")
	return ""
}
