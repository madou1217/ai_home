package storagepolicy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// parity.json is generated from lib/runtime/provider-storage-policy.js and
// lib/server/webui-file-access-policy.js. It is the contract this port must
// keep: regenerate it from the JS when the policy changes.

type parityDenySample struct {
	Path    string `json:"path"`
	Auth    bool   `json:"auth"`
	Private bool   `json:"private"`
}

type parityConfigSample struct {
	Path   string `json:"path"`
	Denied bool   `json:"denied"`
}

type parityData struct {
	Home                 string               `json:"home"`
	Providers            map[string]Policy    `json:"providers"`
	PrivateEntryNames    map[string][]string  `json:"privateEntryNames"`
	DenySamples          []parityDenySample   `json:"denySamples"`
	ConfigSamples        []parityConfigSample `json:"configSamples"`
	ReadableRoots        []string             `json:"readableRoots"`
	FamilyConfigDirNames []string             `json:"familyConfigDirNames"`
}

func loadParity(t *testing.T) parityData {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "parity.json"))
	if err != nil {
		t.Fatalf("read parity fixture: %v", err)
	}
	var data parityData
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("decode parity fixture: %v", err)
	}
	return data
}

func TestPolicyParity(t *testing.T) {
	data := loadParity(t)
	if len(data.Providers) != len(Names()) {
		t.Fatalf("provider count: fixture %d, port %d", len(data.Providers), len(Names()))
	}
	for _, name := range Names() {
		name := name
		t.Run(name, func(t *testing.T) {
			want, ok := data.Providers[name]
			if !ok {
				t.Fatalf("provider %q missing from fixture", name)
			}
			got := Get(name)
			if got == nil {
				t.Fatalf("Get(%q) = nil", name)
			}
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("policy mismatch\n got: %#v\nwant: %#v", *got, want)
			}
		})
	}
	if Get("missing") != nil {
		t.Fatal("unknown provider must have no policy")
	}
}

func TestPrivateEntryNamesParity(t *testing.T) {
	data := loadParity(t)
	for name, want := range data.PrivateEntryNames {
		got := PrivateEntryNames(name)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s entry names: got %v, want %v", name, got, want)
		}
	}
}

func TestPrivateEntryNameRules(t *testing.T) {
	cases := []struct {
		provider string
		entry    string
		want     bool
	}{
		{"codex", "auth.json", true},
		{"codex", "auth.json.bak", true},
		{"codex", "AUTH.JSON", true},
		{"codex", "config.toml", true},
		{"codex", "sessions", false},
		{"codebuddy", "sessions", true},
		{"codebuddy", "sessions.bak", true},
		{"codebuddy", "projects", false},
		{"claude", "settings.json", false},
		{"workbuddy", "sessions", false},
		{"kiro", "data.sqlite3", false},
		{"", "auth.json", false},
		{"codex", "", false},
	}
	for _, testCase := range cases {
		if got := IsPrivateEntryName(testCase.provider, testCase.entry); got != testCase.want {
			t.Errorf("IsPrivateEntryName(%q, %q) = %v, want %v", testCase.provider, testCase.entry, got, testCase.want)
		}
	}
}

func TestAuthArtifactSegments(t *testing.T) {
	cases := []struct {
		provider string
		segments []string
		want     bool
	}{
		{"codex", []string{".codex", "auth.json"}, true},
		{"codex", []string{".codex", "auth.json.bak"}, true},
		{"codex", []string{"auth.json"}, false},
		{"codex", []string{".codex", "auth.json", "extra"}, false},
		{"agy", []string{".gemini", "oauth_creds.json"}, true},
		{"kimi", []string{".kimi-code", "credentials", "kimi-code.json"}, true},
		{"missing", []string{".codex", "auth.json"}, false},
	}
	for _, testCase := range cases {
		if got := IsAuthArtifactSegments(testCase.provider, testCase.segments); got != testCase.want {
			t.Errorf("IsAuthArtifactSegments(%q, %v) = %v, want %v", testCase.provider, testCase.segments, got, testCase.want)
		}
	}
}

func TestDenyParity(t *testing.T) {
	data := loadParity(t)
	for _, sample := range data.DenySamples {
		path := sample.Path
		if got := IsAuthArtifactPath(path); got != sample.Auth {
			t.Errorf("IsAuthArtifactPath(%q) = %v, want %v", path, got, sample.Auth)
		}
		if got := IsPrivateArtifactPath(path); got != sample.Private {
			t.Errorf("IsPrivateArtifactPath(%q) = %v, want %v", path, got, sample.Private)
		}
	}
	if IsAuthArtifactPath("") || IsPrivateArtifactPath("   ") {
		t.Fatal("empty paths must not be private artifacts")
	}
}

func TestConfigurationDenyParity(t *testing.T) {
	data := loadParity(t)
	for _, sample := range data.ConfigSamples {
		if got := IsConfigurationPath(data.Home, sample.Path); got != sample.Denied {
			t.Errorf("IsConfigurationPath(%q) = %v, want %v", sample.Path, got, sample.Denied)
		}
	}
	if IsConfigurationPath(data.Home, ".codex/config.toml") {
		t.Fatal("relative targets must not be denied")
	}
}

func TestReadableResourceRootsParity(t *testing.T) {
	data := loadParity(t)
	got := ReadableResourceRoots(data.Home)
	if !reflect.DeepEqual(got, data.ReadableRoots) {
		t.Fatalf("readable roots\n got: %v\nwant: %v", got, data.ReadableRoots)
	}
	if roots := ReadableResourceRoots("  "); len(roots) != 0 {
		t.Fatalf("empty home must yield no roots, got %v", roots)
	}
}

func TestFamilyConfigDirNamesParity(t *testing.T) {
	data := loadParity(t)
	if got := FamilyConfigDirNames(); !reflect.DeepEqual(got, data.FamilyConfigDirNames) {
		t.Fatalf("family config dirs: got %v, want %v", got, data.FamilyConfigDirNames)
	}
}

func TestResolvers(t *testing.T) {
	home := "/Users/x"
	cases := []struct {
		provider   string
		native     string
		runtime    string
		attachment string
	}{
		{"codex", "/Users/x/.codex", "/Users/x/.codex/.aih-runtime-home", "/Users/x/.codex/.tmp/model/images"},
		{"qoder", "/Users/x", "", "/Users/x/tmp/model/images"},
		{"kiro", "/Users/x/.kiro", "", "/Users/x/.kiro/tmp/model/images"},
		{"cline", "/Users/x/.cline", "", "/Users/x/.cline/tmp/model/images"},
		{"missing", "", "", ""},
	}
	for _, testCase := range cases {
		if got := ResolveNativeRoot(home, testCase.provider); got != testCase.native {
			t.Errorf("ResolveNativeRoot(%q) = %q, want %q", testCase.provider, got, testCase.native)
		}
		if got := ResolveRuntimeHomeRoot(home, testCase.provider); got != testCase.runtime {
			t.Errorf("ResolveRuntimeHomeRoot(%q) = %q, want %q", testCase.provider, got, testCase.runtime)
		}
		if got := ResolveAttachmentRoot(home, testCase.provider); got != testCase.attachment {
			t.Errorf("ResolveAttachmentRoot(%q) = %q, want %q", testCase.provider, got, testCase.attachment)
		}
	}
	if got := ResolveNativeRoot("", "codex"); got != "" {
		t.Fatalf("empty home must resolve to empty root, got %q", got)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		" CodeBuddy ": "codebuddy",
		"CODEX":       "codex",
		"codebuddycn": "codebuddycn",
		"nope":        "",
		"":            "",
	}
	for input, want := range cases {
		if got := Normalize(input); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", input, got, want)
		}
	}
}
