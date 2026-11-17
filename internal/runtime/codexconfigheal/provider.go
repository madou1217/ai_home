// Package codexconfigheal owns pure managed-provider text repairs. File reads,
// publication, default selection, and other healer stages are separate owners.
package codexconfigheal

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	codexconfig "github.com/madou1217/ai_home/internal/host/aihdefault/content/codex"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxInput = 16 << 20
const maxConfig = 4 << 20
const maxProviderBlock = 1 << 20

var ErrInput = errors.New("codex_provider_heal_input_invalid")

// Match the existing healer's deliberately narrow line grammar. A full TOML
// re-encoder would normalize unrelated text, comments, quoting and examples.
// JavaScript dot excludes CR, LF, LS and PS; Go dot excludes only LF.
const space = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var providerHeader = regexp.MustCompile(`^` + space + `*\[` + space + `*model_providers` + space + `*\.` + space + `*(?:aih_server|"aih_server"|'aih_server')` + space + `*(\.[^\]]+)?` + space + `*\]` + space + `*(?:#[^\r\n\x{2028}\x{2029}]*)?$`)
var nameKey = regexp.MustCompile(`^` + space + `*(?:name|"name"|'name')` + space + `*=`)
var nameValue = regexp.MustCompile(`^(` + space + `*(?:name|"name"|'name')` + space + `*=` + space + `*)("(?:\\[^\r\n\x{2028}\x{2029}]|[^"\\])*"|'[^']*')(` + space + `*(?:#[^\r\n\x{2028}\x{2029}]*)?)$`)
var sectionStart = regexp.MustCompile(`^` + space + `*\[`)
var providerTable = regexp.MustCompile(`^` + space + `*\[` + space + `*model_providers` + space + `*\]` + space + `*(?:#[^\r\n\x{2028}\x{2029}]*)?$`)
var inlineRoot = regexp.MustCompile(`^` + space + `*(?:model_providers|"model_providers"|'model_providers')` + space + `*(?:\.|=)`)
var inlineMember = regexp.MustCompile(`^` + space + `*(?:aih_server|"aih_server"|'aih_server')` + space + `*(?:\.|=)`)

// Result is a text patch, not permission to publish it. The existing outer
// healer uses the shared Go expected-document lock once after all stages.
type Result struct {
	Version int    `json:"version"`
	Config  string `json:"config"`
	Changed bool   `json:"changed"`
}

func DecodeAndHeal(raw []byte) (Result, error) {
	if len(raw) > MaxInput {
		return Result{}, ErrInput
	}
	obj, err := jsondocument.Object(raw)
	if err != nil || len(obj) != 3 || obj["version"] != json.Number("1") {
		return Result{}, ErrInput
	}
	config, valid := obj["config"].(string)
	block, validBlock := obj["missingProviderBlock"].(string)
	if !valid || !validBlock || len(config) > maxConfig || len(block) > maxProviderBlock || strings.ContainsRune(config, 0) || strings.ContainsRune(block, 0) {
		return Result{}, ErrInput
	}
	return healProvider(config, block), nil
}

func healProvider(original, missingBlock string) Result {
	unchanged := Result{Version: 1, Config: original}
	newline := "\n"
	if strings.Contains(original, "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(original, "\r\n", "\n"), "\n")
	structural := structuralLines(lines)
	parent, child := -1, -1
	for index, line := range lines {
		if !structural[index] {
			continue
		}
		match := providerHeader.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		if child < 0 {
			child = index
		}
		if parent < 0 && match[1] == "" {
			parent = index
		}
	}
	nameLine := `name = "` + codexconfig.DefaultLabel + `"`
	if parent >= 0 {
		end := parent + 1
		for end < len(lines) && !(structural[end] && sectionStart.MatchString(lines[end])) {
			end++
		}
		name := -1
		for i := parent + 1; i < end; i++ {
			if structural[i] && nameKey.MatchString(lines[i]) {
				name = i
				break
			}
		}
		if name >= 0 {
			match := nameValue.FindStringSubmatch(lines[name])
			if match == nil || !emptyName(match[2]) {
				return unchanged
			}
			lines[name] = match[1] + `"` + codexconfig.DefaultLabel + `"` + match[3]
		} else {
			lines = insert(lines, parent+1, nameLine)
		}
	} else if child >= 0 {
		lines = insert(lines, child, "[model_providers.aih_server]", nameLine, "")
	} else if missingBlock != "" && !hasInlineProvider(lines, structural) {
		config := trimEnd(original)
		if trim(original) != "" {
			config += newline + newline
		}
		config += strings.ReplaceAll(strings.ReplaceAll(missingBlock, "\r\n", "\n"), "\n", newline) + newline
		return Result{Version: 1, Config: config, Changed: true}
	} else {
		return unchanged
	}
	return Result{Version: 1, Config: strings.Join(lines, newline), Changed: true}
}

func emptyName(literal string) bool {
	value := ""
	if strings.HasPrefix(literal, `"`) {
		if json.Unmarshal([]byte(literal), &value) != nil {
			return false
		}
	} else {
		value = literal[1 : len(literal)-1]
	}
	return trim(value) == ""
}

func structuralLines(lines []string) []bool {
	out := make([]bool, len(lines))
	multiline := ""
	for row, line := range lines {
		out[row] = multiline == ""
		quote := byte(0)
		for i := 0; i < len(line); i++ {
			if (multiline == `"""` || quote == '"') && line[i] == '\\' {
				i++
			} else if multiline != "" {
				if strings.HasPrefix(line[i:], multiline) {
					multiline = ""
					i += 2
				}
			} else if quote != 0 {
				if line[i] == quote {
					quote = 0
				}
			} else if line[i] == '#' {
				break
			} else if strings.HasPrefix(line[i:], `"""`) || strings.HasPrefix(line[i:], `'''`) {
				multiline = line[i : i+3]
				i += 2
			} else if line[i] == '"' || line[i] == '\'' {
				quote = line[i]
			}
		}
	}
	return out
}

func hasInlineProvider(lines []string, structural []bool) bool {
	inProviderTable := false
	for index, line := range lines {
		if !structural[index] {
			continue
		}
		if sectionStart.MatchString(line) {
			inProviderTable = providerTable.MatchString(line)
			continue
		}
		if inlineRoot.MatchString(line) || inProviderTable && inlineMember.MatchString(line) {
			return true
		}
	}
	return false
}

func insert(lines []string, index int, values ...string) []string {
	out := make([]string, 0, len(lines)+len(values))
	out = append(out, lines[:index]...)
	out = append(out, values...)
	return append(out, lines[index:]...)
}

func jsSpace(r rune) bool {
	return r >= 0x09 && r <= 0x0d || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func trim(s string) string    { return strings.TrimFunc(s, jsSpace) }
func trimEnd(s string) string { return strings.TrimRightFunc(s, jsSpace) }
