package terminalicon

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

func testRegistry(t *testing.T) *Registry {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	return NewRegistry(catalog)
}

// TestStableGUIDMatchesNode 用 Node 侧实测值锁住 UUIDv5 命名空间与 UTF-16LE 编码：
// 任一侧改动 GUID 都会让已安装的 Profile 失联。
func TestStableGUIDMatchesNode(t *testing.T) {
	registry := testRegistry(t)
	cases := map[string]string{
		"codex":       "{128f41f6-0b12-5b49-8288-506c7878afaf}",
		"gemini":      "{221b123b-8adb-5210-98d2-864a32dfd84d}",
		"claude":      "{0bd1f07d-de0f-5ee4-976a-c9f6bc5450ae}",
		"agy":         "{9cfad2cb-1ad4-5228-9d01-4c412338c064}",
		"opencode":    "{eff7b26b-7611-58a7-80bc-110ec27eb7a2}",
		"grok":        "{d7f5b268-ba8d-59cd-9f0e-eb6dd279d21c}",
		"qoder":       "{7f7317ad-7ff2-5cbb-abe7-f19ae47b3218}",
		"qodercn":     "{d47ed289-b9cd-51cd-b7db-34732f96b6c7}",
		"kimi":        "{0e9ff2bd-86ca-597e-882f-0a1897e790aa}",
		"kiro":        "{76ae1308-fb48-5cda-8110-91c8619ff60d}",
		"zcode":       "{733e1ced-a93b-5195-b968-ba27ecc6e9ab}",
		"codebuddy":   "{c2d41356-b5f0-50ba-a12a-9a0a33113357}",
		"codebuddycn": "{74c40410-4854-565f-a827-575ab1c97252}",
		"workbuddy":   "{587dc694-5440-564c-bd4d-24ef26b0fa0f}",
		"workbuddycn": "{a68078c0-2320-5ae0-af0b-adbfab869f21}",
		"cline":       "{0a2f31fd-6fe0-5b99-84da-928c27dd91ee}",
	}
	for providerID, want := range cases {
		provider, ok := registry.Get(providerID)
		if !ok {
			t.Fatalf("缺少 Provider %s", providerID)
		}
		got, err := StableGUID(provider)
		if err != nil {
			t.Fatalf("%s guid: %v", providerID, err)
		}
		if got != want {
			t.Fatalf("%s guid = %s, want %s", providerID, got, want)
		}
	}
}

// TestIterm2ProfileShape 与 Node buildIterm2DynamicProfile 的字段名逐字一致。
func TestIterm2ProfileShape(t *testing.T) {
	registry := testRegistry(t)
	provider, _ := registry.Get("codebuddycn")
	profiles, err := BuildIterm2Profiles([]Provider{provider}, "aih", func(Provider) string { return "/tmp/cb.png" })
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	encoded, err := json.Marshal(profiles)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(encoded)
	for _, want := range []string{
		"\"Profiles\"", "\"Guid\"", "\"Name\":\"AIH CodeBuddy CN\"", "\"Tags\":[\"AIH\"]",
		"\"Custom Command\":\"Yes\"", "\"Command\":\"aih codebuddycn\"", "\"Icon\":2",
		"\"Custom Icon Path\":\"/tmp/cb.png\"",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("iTerm2 profile 缺少 %s: %s", want, text)
		}
	}
}

// TestUpdateWarpSettingsInsertsAndReplaces 新增段、替换旧 key、保留其它段。
func TestUpdateWarpSettingsInsertsAndReplaces(t *testing.T) {
	entries := []WarpEntry{
		{Provider: "codebuddycn", Pattern: "^aih\\s+codebuddycn(?:\\s|$).*", AgentName: "codebuddy"},
	}
	inserted := UpdateWarpSettingsContent("[other]\nkey = \"value\"\n", entries)
	if !strings.Contains(inserted, "[agents.third_party.cli_agent_toolbar_enabled_commands]") {
		t.Fatalf("缺少段: %s", inserted)
	}
	if !strings.Contains(inserted, "[other]") {
		t.Fatalf("其它段被删: %s", inserted)
	}
	replaced := UpdateWarpSettingsContent(inserted, entries)
	if strings.Count(replaced, "codebuddycn") != 1 {
		t.Fatalf("重复写入: %s", replaced)
	}
	stale := "[agents.third_party.cli_agent_toolbar_enabled_commands]\n\"^aih\\\\s+codebuddycn(?:\\\\s|$).*\" = \"old\"\n"
	updated := UpdateWarpSettingsContent(stale, entries)
	if strings.Contains(updated, "\"old\"") {
		t.Fatalf("旧映射未替换: %s", updated)
	}
}

// TestDesktopEntry 生成 XDG 桌面入口与 Konsole profile。
func TestDesktopEntry(t *testing.T) {
	provider := Provider{ID: "codebuddycn", Label: "CodeBuddy CN"}
	entry := DesktopEntry(provider, "aih")
	for _, want := range []string{
		"[Desktop Entry]", "Name=AIH CodeBuddy CN", "Exec=aih codebuddycn",
		"Icon=aih-codebuddycn", "Terminal=true",
	} {
		if !strings.Contains(entry, want) {
			t.Fatalf("desktop entry 缺少 %s:\n%s", want, entry)
		}
	}
	profile := KonsoleProfile(provider, "aih")
	if !strings.Contains(profile, "Command=aih") || !strings.Contains(profile, "Arguments=codebuddycn") {
		t.Fatalf("konsole profile = %s", profile)
	}
}

// TestWarpPatternEscapesAIHCommand aih 命令里的正则元字符必须转义。
func TestWarpPatternEscapesAIHCommand(t *testing.T) {
	entries := BuildWarpEntries([]Provider{{ID: "codex"}}, "aih.v2")
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if !strings.HasPrefix(entries[0].Pattern, "^aih\\.v2\\s+codex") {
		t.Fatalf("pattern = %q", entries[0].Pattern)
	}
}
