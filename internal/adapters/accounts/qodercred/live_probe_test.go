package qodercred

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestDecryptLiveCLI 只在显式提供真机凭据时运行：它验证的是「厂商 wasm 能被 Go 运行时
// 正确执行」，属于环境相关能力，默认跳过，避免 CI 依赖本机安装的 qoder CLI。
func TestDecryptLiveCLI(t *testing.T) {
	credentialFile := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_CREDENTIAL_FILE"))
	machineFile := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_MACHINE_FILE"))
	if credentialFile == "" || machineFile == "" {
		t.Skip("未提供 AIH_TEST_QODER_CREDENTIAL_FILE / AIH_TEST_QODER_MACHINE_FILE")
	}
	credential, err := os.ReadFile(credentialFile)
	if err != nil {
		t.Fatalf("读取凭据失败: %v", err)
	}
	machine, err := os.ReadFile(machineFile)
	if err != nil {
		t.Fatalf("读取 machineId 失败: %v", err)
	}
	home := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_HOST_HOME"))
	plaintext, err := DecryptBlob("qoder", strings.TrimSpace(string(credential)), strings.TrimSpace(string(machine)), Options{HostHomeDir: home})
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(plaintext), &payload); err != nil {
		t.Fatalf("明文不是 JSON: %v", err)
	}
	if firstText(payload, "uid") == "" {
		t.Fatalf("明文缺少 uid")
	}
	if firstText(payload, "security_oauth_token", "access_token") == "" {
		t.Fatalf("明文缺少 token")
	}
}
