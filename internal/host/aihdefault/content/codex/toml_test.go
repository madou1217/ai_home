package codex

import (
	"errors"
	"strings"
	"testing"
)

const testBaseURL = "http://127.0.0.1:9527/v1"

func mustPatch(t *testing.T, current string) string {
	t.Helper()
	patched, err := Patch(current, Spec{BaseURL: testBaseURL})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	return patched
}

func TestPatchCreatesManagedKeysOnEmptyFile(t *testing.T) {
	patched := mustPatch(t, "")
	want := "model_provider = \"aih_server\"\n\n" +
		"[model_providers.aih_server]\n" +
		"name = \"AIH Server\"\n" +
		"base_url = \"http://127.0.0.1:9527/v1\"\n" +
		"wire_api = \"responses\"\n" +
		"env_key = \"OPENAI_API_KEY\"\n" +
		"request_max_retries = 0\n" +
		"stream_max_retries = 0\n"
	if patched != want {
		t.Fatalf("unexpected output:\n%s", patched)
	}
}

func TestPatchPreservesUnrelatedContent(t *testing.T) {
	current := strings.Join([]string{
		"# 用户手写的文件头",
		"",
		"model_provider = \"openai\"",
		"approval_policy = \"on-request\"",
		"",
		"[features]",
		"web_search = true",
		"",
		"[model_providers.other]",
		"name = \"Other\"",
		"base_url = \"https://other.example.com/v1\"",
		"",
		"[profiles.fast]",
		"model_provider = \"other\"",
		"model = \"gpt-5\"",
		"",
	}, "\n")
	patched := mustPatch(t, current)
	for _, kept := range []string{
		"# 用户手写的文件头",
		"approval_policy = \"on-request\"",
		"[features]\nweb_search = true",
		"[model_providers.other]\nname = \"Other\"\nbase_url = \"https://other.example.com/v1\"",
		"[profiles.fast]\nmodel_provider = \"other\"\nmodel = \"gpt-5\"",
	} {
		if !strings.Contains(patched, kept) {
			t.Fatalf("lost %q in:\n%s", kept, patched)
		}
	}
	if strings.Count(patched, "model_provider = \"aih_server\"") != 1 {
		t.Fatalf("top-level model_provider not patched once:\n%s", patched)
	}
	if !strings.Contains(patched, "model_provider = \"other\"") {
		t.Fatalf("profile model_provider must stay untouched:\n%s", patched)
	}
}

func TestPatchUpdatesExistingTableInPlace(t *testing.T) {
	current := strings.Join([]string{
		"model_provider = \"aih_server\"",
		"",
		"[model_providers.aih_server]",
		"name = \"old\"",
		"env_key = \"OLD_KEY\"",
		"http_headers = { \"X-Tenant\" = \"acme\" }",
		"",
		"[features]",
		"web_search = true",
		"",
	}, "\n")
	patched := mustPatch(t, current)
	if strings.Count(patched, "[model_providers.aih_server]") != 1 {
		t.Fatalf("table must not be duplicated:\n%s", patched)
	}
	if !strings.Contains(patched, "http_headers = { \"X-Tenant\" = \"acme\" }") {
		t.Fatalf("unrelated table key lost:\n%s", patched)
	}
	if strings.Contains(patched, "OLD_KEY") || strings.Contains(patched, "name = \"old\"") {
		t.Fatalf("managed values not replaced:\n%s", patched)
	}
	if strings.Index(patched, "[features]") < strings.Index(patched, "stream_max_retries") {
		t.Fatalf("keys must stay inside their table:\n%s", patched)
	}
}

func TestPatchRecognizesQuotedHeaderAndIndent(t *testing.T) {
	current := "[model_providers.\"aih_server\"]\n  name = \"old\"\n"
	patched := mustPatch(t, current)
	if strings.Count(patched, "[model_providers.") != 1 {
		t.Fatalf("quoted header not recognized:\n%s", patched)
	}
	if !strings.Contains(patched, "name = \"AIH Server\"") || strings.Contains(patched, "name = \"old\"") {
		t.Fatalf("quoted table values not replaced:\n%s", patched)
	}
	if !strings.Contains(patched, "  name = \"AIH Server\"") {
		t.Fatalf("indent not preserved:\n%s", patched)
	}
}

func TestPatchIsIdempotent(t *testing.T) {
	current := "model_provider = \"openai\"\n[features]\nweb_search = true\n"
	once := mustPatch(t, current)
	twice := mustPatch(t, once)
	if once != twice {
		t.Fatalf("patch is not idempotent:\n--- once ---\n%s\n--- twice ---\n%s", once, twice)
	}
}

func TestPatchPreservesLineEndingsAndMissingFinalNewline(t *testing.T) {
	crlf := "model_provider = \"openai\"\r\n[features]\r\nweb_search = true"
	patched := mustPatch(t, crlf)
	if strings.Contains(patched, "\n") && !strings.Contains(patched, "\r\n") {
		t.Fatalf("CRLF not preserved: %q", patched)
	}
	if strings.HasSuffix(patched, "\n") {
		t.Fatalf("missing final newline should be preserved: %q", patched)
	}
	if strings.Contains(patched, "\r\r") {
		t.Fatalf("duplicated carriage return: %q", patched)
	}
}

func TestPatchIgnoresLookalikeKeysAndComments(t *testing.T) {
	current := strings.Join([]string{
		"# model_provider = \"openai\"",
		"model_provider_extra = \"keep\"",
		"[features]",
		"model_provider = \"nested\"",
		"",
	}, "\n")
	patched := mustPatch(t, current)
	if !strings.Contains(patched, "# model_provider = \"openai\"") {
		t.Fatalf("comment line changed:\n%s", patched)
	}
	if !strings.Contains(patched, "model_provider_extra = \"keep\"") {
		t.Fatalf("lookalike key changed:\n%s", patched)
	}
	if !strings.Contains(patched, "[features]\nmodel_provider = \"nested\"") {
		t.Fatalf("nested key changed:\n%s", patched)
	}
	if !strings.Contains(patched, "model_provider = \"aih_server\"") {
		t.Fatalf("missing top-level patch:\n%s", patched)
	}
}

func TestPatchKeepsHeadersInsideMultilineStrings(t *testing.T) {
	current := strings.Join([]string{
		"model_provider = \"openai\"",
		"",
		"[profiles.docs]",
		"instructions = \"\"\"",
		"[model_providers.aih_server]",
		"base_url = \"https://wrong.example.com\"",
		"\"\"\"",
		"",
	}, "\n")
	patched := mustPatch(t, current)
	if !strings.Contains(patched, "base_url = \"https://wrong.example.com\"") {
		t.Fatalf("multiline string content rewritten:\n%s", patched)
	}
	if strings.Count(patched, "[model_providers.aih_server]") != 2 {
		t.Fatalf("expected literal plus one real table:\n%s", patched)
	}
	if !strings.Contains(patched, "[model_providers.aih_server]\nname = \"AIH Server\"") {
		t.Fatalf("real table not appended:\n%s", patched)
	}
}

func TestPatchValidatesSpec(t *testing.T) {
	cases := []struct {
		name string
		spec Spec
		want error
	}{
		{"missing base url", Spec{}, ErrBaseURLRequired},
		{"relative base url", Spec{BaseURL: "/v1"}, ErrInvalidBaseURL},
		{"non http scheme", Spec{BaseURL: "ftp://example.com/v1"}, ErrInvalidBaseURL},
		{"invalid provider id", Spec{BaseURL: testBaseURL, ProviderID: "aih server"}, ErrInvalidProviderID},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := Patch("", testCase.spec); !errors.Is(err, testCase.want) {
				t.Fatalf("err = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestPatchUsesSpecIdentity(t *testing.T) {
	patched, err := Patch("", Spec{
		ProviderID: "local_gw",
		Label:      "Local GW",
		BaseURL:    "https://gw.example.com/v1",
		EnvKey:     "LOCAL_KEY",
	})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if !strings.Contains(patched, "model_provider = \"local_gw\"") ||
		!strings.Contains(patched, "[model_providers.local_gw]") ||
		!strings.Contains(patched, "env_key = \"LOCAL_KEY\"") {
		t.Fatalf("spec not applied:\n%s", patched)
	}
}

func TestPatchKeepsBOM(t *testing.T) {
	patched := mustPatch(t, "\ufeffmodel_provider = \"openai\"\n")
	if !strings.HasPrefix(patched, "\ufeffmodel_provider = \"aih_server\"") {
		t.Fatalf("BOM not preserved: %q", patched)
	}
}
