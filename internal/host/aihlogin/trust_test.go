package aihlogin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSeedLoginFolderTrustAddsPatterns 保留其它键与已有信任项，只补缺失 pattern。
func TestSeedLoginFolderTrustAddsPatterns(t *testing.T) {
	configDir := t.TempDir()
	workDir := t.TempDir()
	settingsPath := filepath.Join(configDir, "settings.json")
	initial := "{\"model\":\"glm-5.3\",\"trustedDirectories\":[\"/existing/**\"]}"
	if err := os.WriteFile(settingsPath, []byte(initial), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := seedLoginFolderTrust(configDir, workDir); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var settings map[string]any
	raw, _ := os.ReadFile(settingsPath)
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if settings["model"] != "glm-5.3" {
		t.Fatalf("其它键被丢失: %#v", settings)
	}
	dirs, _ := settings["trustedDirectories"].([]any)
	if len(dirs) < 2 || dirs[0] != "/existing/**" {
		t.Fatalf("trustedDirectories = %#v", dirs)
	}
	found := false
	for _, value := range dirs {
		if text, ok := value.(string); ok && text == workDir+"/**" {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺少工作目录 pattern: %#v", dirs)
	}
	// 幂等：再次调用不改内容。
	before, _ := os.ReadFile(settingsPath)
	if err := seedLoginFolderTrust(configDir, workDir); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	after, _ := os.ReadFile(settingsPath)
	if string(before) != string(after) {
		t.Fatalf("重复调用改写了内容")
	}
}

// TestSeedLoginFolderTrustReplacesSharedSymlink 登录投影的共享 settings 链接被替换成
// 独立文件，宿主那份不被写入临时目录。
func TestSeedLoginFolderTrustReplacesSharedSymlink(t *testing.T) {
	hostDir := t.TempDir()
	hostSettings := filepath.Join(hostDir, "settings.json")
	hostContent := "{\"model\":\"glm-5.3\"}"
	if err := os.WriteFile(hostSettings, []byte(hostContent), 0o600); err != nil {
		t.Fatalf("host write: %v", err)
	}
	configDir := t.TempDir()
	settingsPath := filepath.Join(configDir, "settings.json")
	if err := os.Symlink(hostSettings, settingsPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	workDir := t.TempDir()
	if err := seedLoginFolderTrust(configDir, workDir); err != nil {
		t.Fatalf("seed: %v", err)
	}
	info, err := os.Lstat(settingsPath)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("投影 settings 仍是链接: %v %v", info, err)
	}
	hostRaw, _ := os.ReadFile(hostSettings)
	if string(hostRaw) != hostContent {
		t.Fatalf("宿主配置被改写: %s", hostRaw)
	}
	projectionRaw, _ := os.ReadFile(settingsPath)
	if !strings.Contains(string(projectionRaw), "glm-5.3") {
		t.Fatalf("投影未继承原配置: %s", projectionRaw)
	}
}
