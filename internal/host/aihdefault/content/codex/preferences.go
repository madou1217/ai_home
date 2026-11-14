package codex

import (
	"fmt"
	"strconv"
	"strings"
)

// RootString reads a scalar preference without matching keys inside tables or multiline strings.
func RootString(current, key string) string {
	doc := parseDocument(current)
	end, starts := preferenceRoot(doc.lines)
	for i := 0; i < end; i++ {
		if starts[i] != stateNone {
			continue
		}
		if found, ok := assignmentKey(doc.lines[i]); ok && found == key {
			raw := strings.TrimSpace(doc.lines[i][indexOfEquals(doc.lines[i])+1:])
			if strings.HasPrefix(raw, "'") {
				if end := strings.Index(raw[1:], "'"); end >= 0 {
					return raw[1 : 1+end]
				}
			}
			if strings.HasPrefix(raw, "\"") {
				for end := 1; end < len(raw); end++ {
					if raw[end] == '"' {
						if value, err := strconv.Unquote(raw[:end+1]); err == nil {
							return value
						}
					}
				}
			}
		}
	}
	return ""
}

// PatchPreference preserves unrelated config, comments, tables and line endings.
func PatchPreference(current, key, value string) (string, error) {
	if key != "service_tier" && key != "model_reasoning_effort" {
		return "", fmt.Errorf("unsupported Codex preference %s", key)
	}
	doc := parseDocument(current)
	end, starts := preferenceRoot(doc.lines)
	assignment := key + " = " + strconv.Quote(value)
	for i := 0; i < end; i++ {
		if starts[i] != stateNone {
			continue
		}
		if found, ok := assignmentKey(doc.lines[i]); ok && found == key {
			// Refuse to replace a multiline value with a single-line edit.
			raw := strings.TrimSpace(doc.lines[i][indexOfEquals(doc.lines[i])+1:])
			if strings.HasPrefix(raw, "\"\"\"") || strings.HasPrefix(raw, "'''") {
				return "", fmt.Errorf("%s must be a single-line string", key)
			}
			doc.lines[i] = indentOf(doc.lines[i]) + assignment + preferenceComment(doc.lines[i])
			return doc.render(), nil
		}
	}
	doc.lines = applyEdits(doc.lines, []edit{{at: leadingCommentEnd(doc.lines), insert: []string{assignment}}})
	return doc.render(), nil
}

// preferenceComment keeps user annotations, ignoring hashes inside quoted values.
func preferenceComment(line string) string {
	var quote byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		if quote != 0 {
			if quote == '"' && c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			quote = c
		case '#':
			start := i
			for start > 0 && (line[start-1] == ' ' || line[start-1] == '\t') {
				start--
			}
			if start == i {
				return " " + line[i:]
			}
			return line[start:]
		}
	}
	return ""
}

// Array tables terminate the TOML root too, even though the provider-table
// patcher deliberately does not treat them as managed replacement targets.
func preferenceRoot(lines []string) (int, []stringState) {
	_, starts := scanSections(lines)
	for i, line := range lines {
		if starts[i] == stateNone && strings.HasPrefix(strings.TrimSpace(line), "[") {
			return i, starts
		}
	}
	return len(lines), starts
}
