package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSettingsFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", path, err)
	}
	return path
}

func readText(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	return string(raw)
}

func requireResult(t *testing.T, result Result, status, from, to, reason string) {
	t.Helper()
	if result.Status != status || result.From != from || result.To != to || result.Reason != reason {
		t.Fatalf(
			"HealModel() = %+v, want {Status:%q From:%q To:%q Reason:%q}",
			result, status, from, to, reason,
		)
	}
}

func TestProjectionSettingsPath(t *testing.T) {
	projection := filepath.Join("/tmp", "aih", "run", "auth-projections", "agy", "acct_1")
	want := filepath.Join(projection, ".gemini", "antigravity-cli", "settings.json")
	if got := ProjectionSettingsPath(projection); got != want {
		t.Fatalf("ProjectionSettingsPath() = %q, want %q", got, want)
	}
	if got := ProjectionSettingsPath("  "); got != "" {
		t.Fatalf("ProjectionSettingsPath(blank) = %q, want empty", got)
	}
}

// Node：resolveAgyCliModelName(current) 为真 → {status:'ok', from:current, to:current}，不写文件。
func TestHealModelKeepsKnownDisplayName(t *testing.T) {
	input := "{\"model\":\" Gemini 3.8 Flash (Low) \",\"statusLine\":{\"enabled\":true}}\n"
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusOK, "Gemini 3.8 Flash (Low)", "Gemini 3.8 Flash (Low)", "")
	if got := readText(t, path); got != input {
		t.Fatalf("ok 状态不应改写文件，got %q", got)
	}
	if _, err := os.Stat(path + backupSuffix); !os.IsNotExist(err) {
		t.Fatalf("ok 状态不应创建备份，Stat error = %v", err)
	}
}

// Node 把「内部 id」也算合法默认值：不写文件（id 只在 aih 传 --model 时才转换成显示名）。
func TestHealModelKeepsKnownIDWithoutRewrite(t *testing.T) {
	input := "{\"model\":\"gemini-3.8-flash-low\"}\n"
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusOK, "gemini-3.8-flash-low", "gemini-3.8-flash-low", "")
	if got := readText(t, path); got != input {
		t.Fatalf("ok 状态不应改写文件，got %q", got)
	}
}

func TestHealModelReplacesStaleModelAndPreservesUserFields(t *testing.T) {
	input := `{
  "runningLightSpeed": "fast",
  "model": "Gemini 3.5 Flash (High)",
  "statusLine": {"enabled": true, "command": "echo \"hi\" && ls"},
  "trustedWorkspaces": ["/a", "/b"],
  "custom": {"z":1,"a":2,"nested":{"k":"v"}}
}
`
	expected := `{
  "runningLightSpeed": "fast",
  "model": "Gemini 3.8 Flash (High)",
  "statusLine": {
    "enabled": true,
    "command": "echo \"hi\" && ls"
  },
  "trustedWorkspaces": [
    "/a",
    "/b"
  ],
  "custom": {
    "z": 1,
    "a": 2,
    "nested": {
      "k": "v"
    }
  }
}
`
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
	if got := readText(t, path); got != expected {
		t.Fatalf("healed 文件 = \n%s\nwant \n%s", got, expected)
	}
	backup := readText(t, path+backupSuffix)
	if backup != input {
		t.Fatalf("备份应等于自愈前原文，got %q want %q", backup, input)
	}
}

// Node：缺 model 时 spread 会把 model 追加在末尾。
func TestHealModelAppendsMissingModel(t *testing.T) {
	input := `{"statusLine":{"enabled":true}}`
	expected := `{
  "statusLine": {
    "enabled": true
  },
  "model": "Gemini 3.8 Flash (High)"
}
`
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusHealed, "", "Gemini 3.8 Flash (High)", "")
	if got := readText(t, path); got != expected {
		t.Fatalf("healed 文件 = \n%s\nwant \n%s", got, expected)
	}
}

func TestHealModelEmptyObjectGetsDefaultModel(t *testing.T) {
	path := writeSettingsFile(t, "{}")
	result := HealModel(path, "")
	requireResult(t, result, StatusHealed, "", "Gemini 3.8 Flash (High)", "")
	want := "{\n  \"model\": \"Gemini 3.8 Flash (High)\"\n}\n"
	if got := readText(t, path); got != want {
		t.Fatalf("healed 文件 = %q, want %q", got, want)
	}
}

func TestHealModelUsesPreferredModel(t *testing.T) {
	cases := []struct {
		name      string
		preferred string
		want      string
	}{
		{"内部 id", "claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"},
		{"显示名", "Gemini 3.8 Flash (Low)", "Gemini 3.8 Flash (Low)"},
		{"带空白", "  gpt-oss-120b-medium  ", "GPT-OSS 120B (Medium)"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := writeSettingsFile(t, `{"model":"Gemini 3.5 Flash (High)"}`)
			result := HealModel(path, item.preferred)
			requireResult(t, result, StatusHealed, "Gemini 3.5 Flash (High)", item.want, "")
			var document map[string]any
			raw := readText(t, path)
			if err := json.Unmarshal([]byte(raw), &document); err != nil {
				t.Fatalf("healed 文件不是合法 JSON: %v (%s)", err, raw)
			}
			if document["model"] != item.want {
				t.Fatalf("model = %v, want %q", document["model"], item.want)
			}
		})
	}
}

// Node：preferredModel 非法 → listAgyCliModelNames()[0]；不是 DEFAULT_PREFERENCE 的 Low。
func TestHealModelFallsBackToFirstListedName(t *testing.T) {
	path := writeSettingsFile(t, `{"model":"Gemini 3.5 Flash (High)"}`)
	result := HealModel(path, "gemini-9.9-unknown")
	requireResult(t, result, StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
}

func TestHealModelKeepsExistingBackup(t *testing.T) {
	path := writeSettingsFile(t, `{"model":"Gemini 3.5 Flash (High)"}`)
	originalBackup := "用户最初的文件"
	if err := os.WriteFile(path+backupSuffix, []byte(originalBackup), 0o600); err != nil {
		t.Fatal(err)
	}
	result := HealModel(path, "")
	requireResult(t, result, StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
	if got := readText(t, path+backupSuffix); got != originalBackup {
		t.Fatalf("已存在的备份不应被覆盖，got %q", got)
	}
}

func TestHealModelIsIdempotent(t *testing.T) {
	input := `{"model":"Gemini 3.5 Flash (High)","x":1}`
	path := writeSettingsFile(t, input)
	requireResult(t, HealModel(path, ""), StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
	healed := readText(t, path)
	requireResult(t, HealModel(path, ""), StatusOK, "Gemini 3.8 Flash (High)", "Gemini 3.8 Flash (High)", "")
	if got := readText(t, path); got != healed {
		t.Fatalf("第二次自愈不应再改文件，got %q want %q", got, healed)
	}
	if got := readText(t, path+backupSuffix); got != input {
		t.Fatalf("备份应保留最初原文，got %q want %q", got, input)
	}
}

func TestHealModelPreservesFileMode(t *testing.T) {
	path := writeSettingsFile(t, `{"model":"Gemini 3.5 Flash (High)"}`)
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	requireResult(t, HealModel(path, ""), StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Fatalf("自愈后权限 = %o, want 640", got)
	}
}

// 刻意差异：Node 会重新序列化数字（1.50 → 1.5、1e3 → 1000）；这里保留用户原文。
func TestHealModelKeepsOriginalNumberText(t *testing.T) {
	path := writeSettingsFile(t, `{"model":"Gemini 3.5 Flash (High)","ratio":1.50,"big":1e3}`)
	requireResult(t, HealModel(path, ""), StatusHealed, "Gemini 3.5 Flash (High)", "Gemini 3.8 Flash (High)", "")
	got := readText(t, path)
	if !strings.Contains(got, `"ratio": 1.50`) || !strings.Contains(got, `"big": 1e3`) {
		t.Fatalf("应保留数值原文，got %s", got)
	}
}

func TestHealModelDuplicateModelKeysUseLastValue(t *testing.T) {
	input := `{"model":"Gemini 3.5 Flash (High)","x":1,"model":"Gemini 3.8 Flash (Low)"}`
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusOK, "Gemini 3.8 Flash (Low)", "Gemini 3.8 Flash (Low)", "")
	if got := readText(t, path); got != input {
		t.Fatalf("ok 状态不应改写文件，got %q", got)
	}
}

func TestHealModelNonStringModelValue(t *testing.T) {
	cases := []struct {
		name string
		body string
		from string
	}{
		{"数字", `{"model":12}`, "12"},
		{"零（JS falsy）", `{"model":0}`, ""},
		{"false（JS falsy）", `{"model":false}`, ""},
		{"true", `{"model":true}`, "true"},
		{"null", `{"model":null}`, ""},
		{"空白字符串", `{"model":"   "}`, ""},
		{"对象（诊断文本为原文）", `{"model":{"a":1}}`, `{"a":1}`},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := writeSettingsFile(t, item.body)
			result := HealModel(path, "")
			requireResult(t, result, StatusHealed, item.from, "Gemini 3.8 Flash (High)", "")
		})
	}
}

func TestHealModelSkipsUnreadableSettings(t *testing.T) {
	cases := []struct {
		name string
		body *string
	}{
		{"非法 JSON", strPtr(`{"model":`)},
		{"顶层是字符串", strPtr(`"Gemini 3.8 Flash (Low)"`)},
		{"顶层是数字", strPtr(`42`)},
		{"顶层是 null", strPtr(`null`)},
		{"BOM 前缀", strPtr("\ufeff{}")},
		{"尾随内容", strPtr(`{"a":1} {"b":2}`)},
		{"文件不存在", nil},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			if item.body != nil {
				if err := os.WriteFile(path, []byte(*item.body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			result := HealModel(path, "")
			requireResult(t, result, StatusSkipped, "", "", ReasonSettingsUnreadable)
			if item.body != nil {
				if got := readText(t, path); got != *item.body {
					t.Fatalf("skipped 状态不应改写文件，got %q", got)
				}
				if _, err := os.Stat(path + backupSuffix); !os.IsNotExist(err) {
					t.Fatalf("skipped 状态不应创建备份，Stat error = %v", err)
				}
			}
		})
	}
}

// 刻意差异：Node 把数组当 object 继续自愈（会把文件覆盖成对象）；这里按不可读跳过。
func TestHealModelSkipsArrayDocument(t *testing.T) {
	input := `[{"model":"Gemini 3.5 Flash (High)"}]`
	path := writeSettingsFile(t, input)
	result := HealModel(path, "")
	requireResult(t, result, StatusSkipped, "", "", ReasonSettingsUnreadable)
	if got := readText(t, path); got != input {
		t.Fatalf("数组文件不应被改写，got %q", got)
	}
}

func TestHealModelRequiresSettingsPath(t *testing.T) {
	for _, value := range []string{"", "   "} {
		result := HealModel(value, "")
		requireResult(t, result, StatusSkipped, "", "", ReasonSettingsPathUnavailable)
	}
}

func TestHealModelReportsWriteFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 会忽略目录权限，无法构造写入失败")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "settings.json")
	if err := os.WriteFile(path, []byte(`{"model":"Gemini 3.5 Flash (High)"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o700) })
	result := HealModel(path, "")
	if result.Status != StatusFailed || result.Reason == "" {
		t.Fatalf("HealModel() = %+v, want failed 且带原因", result)
	}
	if got := readText(t, path); got != `{"model":"Gemini 3.5 Flash (High)"}` {
		t.Fatalf("失败时原文件不应被改写，got %q", got)
	}
}

func strPtr(value string) *string { return &value }
