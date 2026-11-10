package webuiaccountconfigapi

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

const maxRedactedFields = 200

// secretKeyPattern 与 Node provider-config-manager.js 的 SECRET_KEY_PATTERN 一致。
var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|cookie|session[_-]?key|bearer)`)

// tokenLikePattern 与 Node 的 TOKEN_LIKE_PATTERN 一致（纯文本文件按长串保守遮蔽）。
var tokenLikePattern = regexp.MustCompile(`[A-Za-z0-9_.+/=\\-]{32,}`)

// lineKeyValuePattern 复刻 Node redactLineBased 的键值行匹配；额外允许 YAML 列表项 "- key: value"。
var lineKeyValuePattern = regexp.MustCompile(`^(\s*(?:-\s+)?(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*[:=]\s*)(.+?)(,?)$`)

var leadingDoubleQuote = regexp.MustCompile(`^\s*"`)

func redactJSONText(content string) (string, []string) {
	return redactJSON(content, false)
}

func redactJSONC(content string) (string, []string) {
	return redactJSON(content, true)
}

func redactJSON(content string, allowJSONC bool) (string, []string) {
	text := strings.TrimSpace(content)
	if text == "" {
		return "{}\n", []string{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		if !allowJSONC {
			return redactLineBased(content)
		}
		stripped := stripJSONC(content)
		if err := json.Unmarshal([]byte(stripped), &parsed); err != nil {
			return redactLineBased(content)
		}
	}
	fields := make([]string, 0, 4)
	redacted := redactValue(parsed, nil, "", &fields)
	encoded, err := marshalPretty(redacted)
	if err != nil {
		return redactLineBased(content)
	}
	return encoded, fields
}

// redactValue 复刻 Node walkRedacted：数组用父 key 判定；对象逐子键；只处理非空字符串叶子。
func redactValue(value any, path []string, key string, fields *[]string) any {
	switch typed := value.(type) {
	case []any:
		result := make([]any, 0, len(typed))
		for _, entry := range typed {
			result = append(result, redactValue(entry, appendPath(path, "*"), key, fields))
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(typed))
		keys := make([]string, 0, len(typed))
		for childKey := range typed {
			keys = append(keys, childKey)
		}
		// map 遍历顺序不稳定；排序保证同输入得到同输出。
		sort.Strings(keys)
		for _, childKey := range keys {
			result[childKey] = redactValue(typed[childKey], appendPath(path, childKey), childKey, fields)
		}
		return result
	case string:
		if typed == "" {
			return typed
		}
		if secretKeyPattern.MatchString(key) {
			if len(*fields) < maxRedactedFields {
				*fields = append(*fields, strings.Join(path, "."))
			}
			return passwordMask
		}
		return typed
	default:
		return value
	}
}

func appendPath(path []string, segment string) []string {
	next := make([]string, len(path)+1)
	copy(next, path)
	next[len(path)] = segment
	return next
}

// redactLineBased 复刻 Node 的键值行脱敏：值整体替换为 <redacted>，保留引号与逗号。
func redactLineBased(content string) (string, []string) {
	lines := strings.Split(content, "\n")
	fields := make([]string, 0, 4)
	for index, line := range lines {
		match := lineKeyValuePattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		key := strings.Map(func(r rune) rune {
			switch r {
			case '"', '\'', ':', '=', ' ', '\t':
				return -1
			default:
				return r
			}
		}, match[1])
		if !secretKeyPattern.MatchString(key) {
			continue
		}
		fields = append(fields, key)
		quote := ""
		if leadingDoubleQuote.MatchString(match[2]) {
			quote = "\""
		}
		lines[index] = match[1] + quote + passwordMask + quote + match[3]
	}
	return strings.Join(lines, "\n"), fields
}

// redactText 复刻 Node 纯文本兜底：像 token 的长串整体遮蔽。
func redactText(content string) (string, []string) {
	count := 0
	masked := tokenLikePattern.ReplaceAllStringFunc(content, func(string) string {
		count++
		return passwordMask
	})
	if count == 0 {
		return masked, []string{}
	}
	return masked, []string{"<text>"}
}

// stripJSONC 去掉注释与尾逗号；只在字符串外生效。
func stripJSONC(content string) string {
	var withoutComments strings.Builder
	inString := false
	escaped := false
	for index := 0; index < len(content); index++ {
		character := content[index]
		if inString {
			withoutComments.WriteByte(character)
			if escaped {
				escaped = false
			} else if character == '\\' {
				escaped = true
			} else if character == '"' {
				inString = false
			}
			continue
		}
		if character == '"' {
			inString = true
			withoutComments.WriteByte(character)
			continue
		}
		if character == '/' && index+1 < len(content) {
			next := content[index+1]
			if next == '/' {
				index += 2
				for index < len(content) && content[index] != '\n' {
					index++
				}
				if index < len(content) {
					withoutComments.WriteByte('\n')
				}
				continue
			}
			if next == '*' {
				index += 2
				for index+1 < len(content) && !(content[index] == '*' && content[index+1] == '/') {
					index++
				}
				index++
				continue
			}
		}
		withoutComments.WriteByte(character)
	}

	text := withoutComments.String()
	var withoutTrailing strings.Builder
	inString = false
	escaped = false
	for index := 0; index < len(text); index++ {
		character := text[index]
		if inString {
			withoutTrailing.WriteByte(character)
			if escaped {
				escaped = false
			} else if character == '\\' {
				escaped = true
			} else if character == '"' {
				inString = false
			}
			continue
		}
		if character == '"' {
			inString = true
			withoutTrailing.WriteByte(character)
			continue
		}
		if character == ',' {
			lookahead := index + 1
			for lookahead < len(text) && (text[lookahead] == ' ' || text[lookahead] == '\t' || text[lookahead] == '\n' || text[lookahead] == '\r') {
				lookahead++
			}
			if lookahead < len(text) && (text[lookahead] == '}' || text[lookahead] == ']') {
				continue
			}
		}
		withoutTrailing.WriteByte(character)
	}
	return withoutTrailing.String()
}
