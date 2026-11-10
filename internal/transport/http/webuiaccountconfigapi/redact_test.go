package webuiaccountconfigapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func readRedactFixture(t *testing.T) []struct {
	Name    string   `json:"name"`
	Format  string   `json:"format"`
	Content string   `json:"content"`
	Output  string   `json:"output"`
	Fields  []string `json:"fields"`
	Parsed  bool     `json:"parsed"`
} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "fixtures", "account-config-redact-cases.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []struct {
		Name    string   `json:"name"`
		Format  string   `json:"format"`
		Content string   `json:"content"`
		Output  string   `json:"output"`
		Fields  []string `json:"fields"`
		Parsed  bool     `json:"parsed"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return cases
}

func sortedCopy(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}

func TestJSONRedactionParity(t *testing.T) {
	for _, testCase := range readRedactFixture(t) {
		if testCase.Format != "json" && testCase.Format != "jsonc" {
			continue
		}
		t.Run(testCase.Name, func(t *testing.T) {
			var output string
			var fields []string
			if testCase.Format == "jsonc" {
				output, fields = redactJSONC(testCase.Content)
			} else {
				output, fields = redactJSONText(testCase.Content)
			}
			var actualValue any
			if err := json.Unmarshal([]byte(output), &actualValue); err != nil {
				t.Fatalf("redacted output is not JSON: %v\n%s", err, output)
			}
			var expectedValue any
			if err := json.Unmarshal([]byte(testCase.Output), &expectedValue); err != nil {
				t.Fatalf("fixture output is not JSON: %v", err)
			}
			if !reflect.DeepEqual(actualValue, expectedValue) {
				t.Fatalf("redacted value mismatch\nactual: %#v\nexpected: %#v", actualValue, expectedValue)
			}
			if !reflect.DeepEqual(sortedCopy(fields), sortedCopy(testCase.Fields)) {
				t.Fatalf("fields mismatch actual=%v expected=%v", sortedCopy(fields), sortedCopy(testCase.Fields))
			}
		})
	}
}

func TestTextRedactionMasksTokenLikeRuns(t *testing.T) {
	content := "token=" + strings.Repeat("a1b2c3d4", 8) + "\n"
	output, fields := redactText(content)
	if strings.Contains(output, "a1b2c3d4") {
		t.Fatalf("token leaked: %s", output)
	}
	if !reflect.DeepEqual(fields, []string{"<text>"}) {
		t.Fatalf("fields = %v", fields)
	}
}

func TestLineBasedRedactsTomlAndYamlListItems(t *testing.T) {
	content := strings.Join([]string{
		"model = \"gpt-5\"",
		"api_key = \"sk-secret\"",
		"nested.password = \"p\"",
		"safe = \"ok\"",
		"tokens:",
		"  - access_token: \"tok\"",
	}, "\n")
	output, fields := redactLineBased(content)
	if strings.Contains(output, "sk-secret") || strings.Contains(output, "\"tok\"") || strings.Contains(output, "\"p\"") {
		t.Fatalf("secret leaked: %s", output)
	}
	if !strings.Contains(output, "safe = \"ok\"") {
		t.Fatalf("safe value was masked: %s", output)
	}
	if !strings.Contains(output, "- access_token: \"<redacted>\"") {
		t.Fatalf("yaml list item not masked: %s", output)
	}
	if len(fields) < 3 {
		t.Fatalf("fields = %v", fields)
	}
}
