package codex

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

// RootString reads the decoded root scalar, never strings embedded in tables,
// multiline values or nested arrays. Invalid documents return no preference.
func RootString(current, key string) string {
	statements, err := providerconfigs.ScanTOMLStatements(current)
	if err != nil {
		return ""
	}
	for _, item := range statements {
		if !item.Table && len(item.TablePath) == 0 && len(item.Keys) == 1 && item.Keys[0] == key {
			value, _ := item.Value.(string)
			return value
		}
	}
	return ""
}

// PreferenceKeys 是 AIH 允许写入的 Codex 启动偏好键。
var PreferenceKeys = []string{"model", "model_reasoning_effort", "service_tier"}

// PatchPreference replaces only the parsed value span, preserving comments,
// quoted key spelling, unrelated arrays/strings, tables and original line endings.
func PatchPreference(current, key, value string) (string, error) {
	supported := false
	for _, candidate := range PreferenceKeys {
		if key == candidate {
			supported = true
			break
		}
	}
	if !supported {
		return "", fmt.Errorf("unsupported Codex preference %s", key)
	}
	if strings.ContainsAny(value, "\r\n\x00") || (key == "model" && strings.TrimSpace(value) == "") {
		return "", fmt.Errorf("invalid Codex preference value")
	}
	statements, err := providerconfigs.ScanTOMLStatements(current)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("invalid Codex preference value")
	}
	for _, item := range statements {
		if !item.Table && len(item.TablePath) == 0 && len(item.Keys) == 1 && item.Keys[0] == key {
			return current[:item.ValueStart] + string(encoded) + current[item.ValueEnd:], nil
		}
	}
	doc := parseDocument(current)
	doc.lines = applyEdits(doc.lines, []edit{{at: leadingCommentEnd(doc.lines), insert: []string{key + " = " + string(encoded)}}})
	return doc.render(), nil
}
