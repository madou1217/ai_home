package providerconfigs

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxValidationErrors = 20

// ValidationError 描述配置文件语法校验的单条错误及行列位置。
type ValidationError struct {
	Message string `json:"message"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
}

// ValidationResult 表示配置文本校验结果。
type ValidationResult struct {
	Valid   bool              `json:"valid"`
	Format  string            `json:"format"`
	Errors  []ValidationError `json:"errors"`
	Empty   bool              `json:"empty,omitempty"`
	Skipped bool              `json:"skipped,omitempty"`
}

// RedactResult 表示脱敏导出的转换结果。
type RedactResult struct {
	Content string
	Fields  []string
	Parsed  bool
}

var (
	secretKeyPattern  = regexp.MustCompile(`(?i)(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|cookie|session[_-]?key|bearer)`)
	sensitiveSafeKeys = map[string]bool{
		"type": true, "mode": true, "kind": true, "provider": true, "plan": true,
		"region": true, "scope": true, "scopes": true, "token_type": true,
		"auth_type": true, "endpoint": true, "base_url": true, "baseurl": true, "expires": true,
	}
	reLineRedact = regexp.MustCompile(`^(\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*[:=]\s*)(.+?)(,?)$`)
)

func offsetToPosition(content string, offset int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(content) {
		offset = len(content)
	}
	before := content[:offset]
	lines := strings.Split(before, "\n")
	lineNum := len(lines)
	colNum := utf8.RuneCountInString(lines[len(lines)-1]) + 1
	return lineNum, colNum
}

type syntaxErrorWithPos struct {
	msg  string
	line int
	col  int
}

func (e *syntaxErrorWithPos) Error() string { return e.msg }

// ValidateContent 校验给定配置文本是否满足对应格式（json / jsonc / toml / yaml）的语法。
func ValidateContent(content, format string) ValidationResult {
	normalized := strings.ToLower(strings.TrimSpace(format))
	if normalized == "" {
		normalized = "text"
	}
	if strings.TrimSpace(content) == "" {
		return ValidationResult{
			Valid:  true,
			Format: normalized,
			Errors: []ValidationError{},
			Empty:  true,
		}
	}
	switch normalized {
	case "json":
		_, errs := parseJSONStrict(content)
		return ValidationResult{Valid: len(errs) == 0, Format: normalized, Errors: errs}
	case "jsonc":
		_, errs := parseJSONC(content)
		return ValidationResult{Valid: len(errs) == 0, Format: normalized, Errors: errs}
	case "toml":
		_, err := parseTOML(content)
		if err != nil {
			return ValidationResult{Valid: false, Format: normalized, Errors: []ValidationError{toValidationError(err)}}
		}
		return ValidationResult{Valid: true, Format: normalized, Errors: []ValidationError{}}
	case "yaml":
		_, err := parseYAML(content)
		if err != nil {
			return ValidationResult{Valid: false, Format: normalized, Errors: []ValidationError{toValidationError(err)}}
		}
		return ValidationResult{Valid: true, Format: normalized, Errors: []ValidationError{}}
	default:
		return ValidationResult{Valid: true, Format: normalized, Errors: []ValidationError{}, Skipped: true}
	}
}

func toValidationError(err error) ValidationError {
	var posErr *syntaxErrorWithPos
	if errors.As(err, &posErr) {
		return ValidationError{Message: posErr.msg, Line: posErr.line, Column: posErr.col}
	}
	msg := strings.SplitN(strings.TrimSpace(err.Error()), "\n", 2)[0]
	if msg == "" {
		msg = "语法错误"
	}
	return ValidationError{Message: msg, Line: 0, Column: 0}
}

func parseJSONStrict(content string) (any, []ValidationError) {
	var val any
	dec := json.NewDecoder(strings.NewReader(content))
	dec.UseNumber()
	if err := dec.Decode(&val); err != nil {
		line, col := 0, 0
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			line, col = offsetToPosition(content, int(synErr.Offset)-1)
		}
		return nil, []ValidationError{{Message: strings.SplitN(err.Error(), "\n", 2)[0], Line: line, Column: col}}
	}
	// 检查尾随非空白字符
	var extra any
	if err := dec.Decode(&extra); err == nil {
		line, col := offsetToPosition(content, int(dec.InputOffset()))
		return nil, []ValidationError{{Message: "JSON 文档末尾存在多余内容", Line: line, Column: col}}
	} else if err.Error() != "EOF" {
		line, col := 0, 0
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			line, col = offsetToPosition(content, int(synErr.Offset)-1)
		}
		return nil, []ValidationError{{Message: strings.SplitN(err.Error(), "\n", 2)[0], Line: line, Column: col}}
	}
	return normalizeJSONNumbers(val), []ValidationError{}
}

func normalizeJSONNumbers(v any) any {
	switch tv := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(tv))
		for k, item := range tv {
			out[k] = normalizeJSONNumbers(item)
		}
		return out
	case []any:
		out := make([]any, len(tv))
		for i, item := range tv {
			out[i] = normalizeJSONNumbers(item)
		}
		return out
	case json.Number:
		if i, err := tv.Int64(); err == nil {
			return i
		}
		if f, err := tv.Float64(); err == nil {
			return f
		}
		return tv.String()
	default:
		return v
	}
}

// parseJSONC 支持行注释（//）、块注释（/* ... */）和尾随逗号，同时保留精确行列报错。
func parseJSONC(content string) (any, []ValidationError) {
	var stripped bytes.Buffer
	origOffsets := make([]int, 0, len(content))
	errs := make([]ValidationError, 0)

	i := 0
	n := len(content)
	appendByte := func(b byte, origIdx int) {
		stripped.WriteByte(b)
		origOffsets = append(origOffsets, origIdx)
	}

	for i < n {
		c := content[i]
		// 字符串字面量
		if c == '"' {
			start := i
			appendByte(c, i)
			i++
			closed := false
			for i < n {
				ch := content[i]
				if ch == '\n' || ch == '\r' {
					break
				}
				appendByte(ch, i)
				i++
				if ch == '\\' && i < n {
					appendByte(content[i], i)
					i++
					continue
				}
				if ch == '"' {
					closed = true
					break
				}
			}
			if !closed && len(errs) < maxValidationErrors {
				line, col := offsetToPosition(content, start)
				errs = append(errs, ValidationError{Message: "未闭合的字符串字面量", Line: line, Column: col})
			}
			continue
		}
		// // 行注释
		if c == '/' && i+1 < n && content[i+1] == '/' {
			i += 2
			for i < n && content[i] != '\n' {
				i++
			}
			continue
		}
		// /* ... */ 块注释
		if c == '/' && i+1 < n && content[i+1] == '*' {
			start := i
			i += 2
			closed := false
			for i+1 < n {
				if content[i] == '*' && content[i+1] == '/' {
					i += 2
					closed = true
					break
				}
				if content[i] == '\n' {
					appendByte('\n', i)
				}
				i++
			}
			if !closed {
				if len(errs) < maxValidationErrors {
					line, col := offsetToPosition(content, start)
					errs = append(errs, ValidationError{Message: "未闭合的块注释", Line: line, Column: col})
				}
				i = n
			}
			continue
		}
		// 尾随逗号检查：若 ',' 之后跳过空白/注释紧跟 '}' 或 ']'，则忽略该 ','。
		if c == ',' {
			j := skipJSONCWhitespaceAndComments(content, i+1)
			if j < n && (content[j] == '}' || content[j] == ']') {
				i++
				continue
			}
		}
		appendByte(c, i)
		i++
	}

	if len(errs) > 0 {
		return nil, errs
	}

	cleanText := stripped.String()
	if strings.TrimSpace(cleanText) == "" {
		return map[string]any{}, []ValidationError{}
	}
	var val any
	dec := json.NewDecoder(strings.NewReader(cleanText))
	dec.UseNumber()
	if err := dec.Decode(&val); err != nil {
		line, col := 0, 0
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			idx := int(synErr.Offset) - 1
			if idx >= 0 && idx < len(origOffsets) {
				line, col = offsetToPosition(content, origOffsets[idx])
			} else if len(origOffsets) > 0 {
				line, col = offsetToPosition(content, origOffsets[len(origOffsets)-1])
			}
		}
		return nil, []ValidationError{{Message: strings.SplitN(err.Error(), "\n", 2)[0], Line: line, Column: col}}
	}
	var extra any
	if err := dec.Decode(&extra); err == nil {
		idx := int(dec.InputOffset())
		origPos := len(content) - 1
		if idx >= 0 && idx < len(origOffsets) {
			origPos = origOffsets[idx]
		}
		line, col := offsetToPosition(content, origPos)
		return nil, []ValidationError{{Message: "JSONC 文档末尾存在多余内容", Line: line, Column: col}}
	} else if err.Error() != "EOF" {
		line, col := 0, 0
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			idx := int(synErr.Offset) - 1
			if idx >= 0 && idx < len(origOffsets) {
				line, col = offsetToPosition(content, origOffsets[idx])
			}
		}
		return nil, []ValidationError{{Message: strings.SplitN(err.Error(), "\n", 2)[0], Line: line, Column: col}}
	}
	return normalizeJSONNumbers(val), []ValidationError{}
}

func skipJSONCWhitespaceAndComments(s string, pos int) int {
	n := len(s)
	for pos < n {
		c := s[pos]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			pos++
			continue
		}
		if c == '/' && pos+1 < n && s[pos+1] == '/' {
			pos += 2
			for pos < n && s[pos] != '\n' {
				pos++
			}
			continue
		}
		if c == '/' && pos+1 < n && s[pos+1] == '*' {
			pos += 2
			for pos+1 < n && !(s[pos] == '*' && s[pos+1] == '/') {
				pos++
			}
			if pos+1 < n {
				pos += 2
			} else {
				pos = n
			}
			continue
		}
		break
	}
	return pos
}

// ---------- 纯 Go TOML 解析与导出 ----------

type tomlParser struct {
	src string
	pos int
}

func parseTOML(content string) (map[string]any, error) {
	p := &tomlParser{src: content}
	root := make(map[string]any)
	current := root
	definedTables := make(map[string]bool)
	arrayTables := make(map[string]bool)

	for {
		p.skipWSAndComments(true)
		if p.eof() {
			break
		}
		if p.peek() == '[' {
			isArray := p.pos+1 < len(p.src) && p.src[p.pos+1] == '['
			if isArray {
				p.pos += 2
			} else {
				p.pos++
			}
			keys, err := p.parseDottedKey()
			if err != nil {
				return nil, err
			}
			p.skipWSInline()
			if isArray {
				if p.eof() || p.peek() != ']' || p.pos+1 >= len(p.src) || p.src[p.pos+1] != ']' {
					return nil, p.errAt("数组表头缺少闭合 ']]'")
				}
				p.pos += 2
			} else {
				if p.eof() || p.peek() != ']' {
					return nil, p.errAt("表头缺少闭合 ']'")
				}
				p.pos++
			}
			p.skipWSInline()
			if err := p.expectLineEndOrComment(); err != nil {
				return nil, err
			}

			pathKey := tomlTableIdentity(keys)
			if isArray {
				tbl, err := p.navigateArrayTable(root, keys, arrayTables, definedTables)
				if err != nil {
					return nil, err
				}
				arrayTables[pathKey] = true
				current = tbl
			} else {
				if definedTables[pathKey] || arrayTables[pathKey] {
					return nil, p.errAt(fmt.Sprintf("重复定义表 [%s]", pathKey))
				}
				definedTables[pathKey] = true
				tbl, err := p.navigateTable(root, keys, true)
				if err != nil {
					return nil, err
				}
				current = tbl
			}
			continue
		}

		keys, err := p.parseDottedKey()
		if err != nil {
			return nil, err
		}
		p.skipWSInline()
		if p.eof() || p.peek() != '=' {
			return nil, p.errAt("键值对缺少 '='")
		}
		p.pos++
		p.skipWSInline()
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		p.skipWSInline()
		if err := p.expectLineEndOrComment(); err != nil {
			return nil, err
		}
		if err := p.assignDotted(current, keys, val); err != nil {
			return nil, err
		}
	}
	return root, nil
}

func (p *tomlParser) eof() bool  { return p.pos >= len(p.src) }
func (p *tomlParser) peek() byte { return p.src[p.pos] }

func (p *tomlParser) errAt(msg string) error {
	line, col := offsetToPosition(p.src, p.pos)
	return &syntaxErrorWithPos{msg: msg, line: line, col: col}
}

func (p *tomlParser) skipWSInline() {
	for !p.eof() && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t') {
		p.pos++
	}
}

func (p *tomlParser) skipWSAndComments(allowNewlines bool) {
	for !p.eof() {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || (allowNewlines && (c == '\n' || c == '\r')) {
			p.pos++
			continue
		}
		if c == '#' {
			for !p.eof() && p.src[p.pos] != '\n' {
				p.pos++
			}
			continue
		}
		break
	}
}

func (p *tomlParser) expectLineEndOrComment() error {
	p.skipWSInline()
	if p.eof() {
		return nil
	}
	if p.src[p.pos] == '#' {
		for !p.eof() && p.src[p.pos] != '\n' {
			p.pos++
		}
	}
	if p.eof() {
		return nil
	}
	if p.src[p.pos] == '\r' {
		p.pos++
	}
	if !p.eof() && p.src[p.pos] != '\n' {
		return p.errAt(fmt.Sprintf("行末存在意外字符 %q", p.src[p.pos]))
	}
	if !p.eof() && p.src[p.pos] == '\n' {
		p.pos++
	}
	return nil
}

func (p *tomlParser) parseDottedKey() ([]string, error) {
	var keys []string
	for {
		p.skipWSInline()
		k, err := p.parseSingleKey()
		if err != nil {
			return nil, err
		}
		keys = append(keys, k)
		p.skipWSInline()
		if p.eof() || p.src[p.pos] != '.' {
			break
		}
		p.pos++
	}
	return keys, nil
}

func (p *tomlParser) parseSingleKey() (string, error) {
	if p.eof() {
		return "", p.errAt("缺少键名")
	}
	switch p.src[p.pos] {
	case '"':
		return p.parseBasicString(false)
	case '\'':
		return p.parseLiteralString(false)
	default:
		start := p.pos
		for !p.eof() {
			c := p.src[p.pos]
			if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
				p.pos++
				continue
			}
			break
		}
		if p.pos == start {
			return "", p.errAt(fmt.Sprintf("无效的键名字符 %q", p.src[p.pos]))
		}
		return p.src[start:p.pos], nil
	}
}

func (p *tomlParser) parseValue() (any, error) {
	if p.eof() {
		return nil, p.errAt("缺少字段值")
	}
	switch p.src[p.pos] {
	case '"':
		if strings.HasPrefix(p.src[p.pos:], `"""`) {
			return p.parseBasicString(true)
		}
		return p.parseBasicString(false)
	case '\'':
		if strings.HasPrefix(p.src[p.pos:], `'''`) {
			return p.parseLiteralString(true)
		}
		return p.parseLiteralString(false)
	case '[':
		return p.parseArray()
	case '{':
		return p.parseInlineTable()
	default:
		return p.parseBareScalar()
	}
}

func (p *tomlParser) parseBasicString(multiline bool) (string, error) {
	startPos := p.pos
	if multiline {
		p.pos += 3
		if !p.eof() && p.src[p.pos] == '\r' {
			p.pos++
		}
		if !p.eof() && p.src[p.pos] == '\n' {
			p.pos++
		}
	} else {
		p.pos++
	}
	var out strings.Builder
	for !p.eof() {
		if multiline && strings.HasPrefix(p.src[p.pos:], `"""`) {
			p.pos += 3
			// TOML 允许末尾额外最多 2 个引号归属内容
			for !p.eof() && p.src[p.pos] == '"' && out.Len() >= 0 {
				if strings.HasPrefix(p.src[p.pos:], `"`) {
					out.WriteByte('"')
					p.pos++
				}
			}
			return out.String(), nil
		}
		if !multiline && p.src[p.pos] == '"' {
			p.pos++
			return out.String(), nil
		}
		ch := p.src[p.pos]
		if !multiline && (ch == '\n' || ch == '\r') {
			return "", &syntaxErrorWithPos{msg: "未闭合的字符串", line: offsetLine(p.src, startPos), col: offsetCol(p.src, startPos)}
		}
		if ch == '\\' {
			p.pos++
			if p.eof() {
				break
			}
			esc := p.src[p.pos]
			p.pos++
			switch esc {
			case 'b':
				out.WriteByte('\b')
			case 't':
				out.WriteByte('\t')
			case 'n':
				out.WriteByte('\n')
			case 'f':
				out.WriteByte('\f')
			case 'r':
				out.WriteByte('\r')
			case '"':
				out.WriteByte('"')
			case '\\':
				out.WriteByte('\\')
			case 'u', 'U':
				hexLen := 4
				if esc == 'U' {
					hexLen = 8
				}
				if p.pos+hexLen > len(p.src) {
					return "", p.errAt("无效的 Unicode 转义")
				}
				v, err := strconv.ParseUint(p.src[p.pos:p.pos+hexLen], 16, 32)
				if err != nil {
					return "", p.errAt("无效的 Unicode 转义")
				}
				out.WriteRune(rune(v))
				p.pos += hexLen
			case '\r', '\n', ' ', '\t':
				if !multiline {
					return "", p.errAt(fmt.Sprintf("无效的转义字符 \\%c", esc))
				}
				for !p.eof() && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t' || p.src[p.pos] == '\r' || p.src[p.pos] == '\n') {
					p.pos++
				}
			default:
				return "", p.errAt(fmt.Sprintf("无效的转义字符 \\%c", esc))
			}
			continue
		}
		out.WriteByte(ch)
		p.pos++
	}
	return "", &syntaxErrorWithPos{msg: "未闭合的字符串", line: offsetLine(p.src, startPos), col: offsetCol(p.src, startPos)}
}

func (p *tomlParser) parseLiteralString(multiline bool) (string, error) {
	startPos := p.pos
	if multiline {
		p.pos += 3
		if !p.eof() && p.src[p.pos] == '\r' {
			p.pos++
		}
		if !p.eof() && p.src[p.pos] == '\n' {
			p.pos++
		}
	} else {
		p.pos++
	}
	start := p.pos
	for !p.eof() {
		if multiline && strings.HasPrefix(p.src[p.pos:], `'''`) {
			end := p.pos
			for !p.eof() && p.src[p.pos] == '\'' {
				p.pos++
			}
			quotes := p.pos - end
			if quotes > 5 {
				return "", p.errAt("单引号字符串闭合引号过多")
			}
			return p.src[start:end] + strings.Repeat("'", quotes-3), nil
		}
		if !multiline && p.src[p.pos] == '\'' {
			val := p.src[start:p.pos]
			p.pos++
			return val, nil
		}
		if !multiline && (p.src[p.pos] == '\n' || p.src[p.pos] == '\r') {
			return "", &syntaxErrorWithPos{msg: "未闭合的单引号字符串", line: offsetLine(p.src, startPos), col: offsetCol(p.src, startPos)}
		}
		p.pos++
	}
	return "", &syntaxErrorWithPos{msg: "未闭合的单引号字符串", line: offsetLine(p.src, startPos), col: offsetCol(p.src, startPos)}
}

func (p *tomlParser) parseArray() ([]any, error) {
	p.pos++ // skip '['
	items := make([]any, 0)
	for {
		p.skipWSAndComments(true)
		if p.eof() {
			return nil, p.errAt("数组缺少闭合 ']'")
		}
		if p.src[p.pos] == ']' {
			p.pos++
			return items, nil
		}
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		items = append(items, val)
		p.skipWSAndComments(true)
		if p.eof() {
			return nil, p.errAt("数组缺少闭合 ']'")
		}
		if p.src[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.src[p.pos] == ']' {
			p.pos++
			return items, nil
		}
		return nil, p.errAt("数组元素之间缺少 ','")
	}
}

func (p *tomlParser) parseInlineTable() (map[string]any, error) {
	p.pos++ // skip '{'
	tbl := make(map[string]any)
	p.skipWSInline()
	if !p.eof() && p.src[p.pos] == '}' {
		p.pos++
		return tbl, nil
	}
	for {
		p.skipWSInline()
		keys, err := p.parseDottedKey()
		if err != nil {
			return nil, err
		}
		p.skipWSInline()
		if p.eof() || p.src[p.pos] != '=' {
			return nil, p.errAt("内联表键值对缺少 '='")
		}
		p.pos++
		p.skipWSInline()
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		if err := p.assignDotted(tbl, keys, val); err != nil {
			return nil, err
		}
		p.skipWSInline()
		if p.eof() {
			return nil, p.errAt("内联表缺少闭合 '}'")
		}
		if p.src[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.src[p.pos] == '}' {
			p.pos++
			return tbl, nil
		}
		return nil, p.errAt("内联表缺少闭合 '}'")
	}
}

func (p *tomlParser) parseBareScalar() (any, error) {
	start := p.pos
	for !p.eof() {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '#' || c == ',' || c == ']' || c == '}' {
			break
		}
		p.pos++
	}
	raw := p.src[start:p.pos]
	if raw == "" {
		return nil, p.errAt("无效的字段值")
	}
	if raw == "true" {
		return true, nil
	}
	if raw == "false" {
		return false, nil
	}
	if raw == "inf" || raw == "+inf" || raw == "-inf" || raw == "nan" || raw == "+nan" || raw == "-nan" {
		return raw, nil
	}
	cleanNum := strings.ReplaceAll(raw, "_", "")
	if i, err := strconv.ParseInt(cleanNum, 0, 64); err == nil {
		return i, nil
	}
	if f, err := strconv.ParseFloat(cleanNum, 64); err == nil {
		return f, nil
	}
	// RFC 3339 / TOML 本地日期时间
	if isTOMLDateTime(raw) {
		return raw, nil
	}
	return nil, p.errAt(fmt.Sprintf("无法识别的 TOML 值 %q（字符串请加引号）", raw))
}

func isTOMLDateTime(s string) bool {
	if len(s) >= 10 && s[4] == '-' && s[7] == '-' {
		return true
	}
	if len(s) >= 8 && s[2] == ':' && s[5] == ':' {
		return true
	}
	return false
}

func (p *tomlParser) navigateTable(root map[string]any, keys []string, create bool) (map[string]any, error) {
	curr := root
	for _, k := range keys {
		existing, exists := curr[k]
		if !exists {
			if !create {
				return nil, p.errAt(fmt.Sprintf("表 %q 不存在", k))
			}
			next := make(map[string]any)
			curr[k] = next
			curr = next
			continue
		}
		switch tv := existing.(type) {
		case map[string]any:
			curr = tv
		case []any:
			if len(tv) == 0 {
				return nil, p.errAt(fmt.Sprintf("表路径 %q 为空数组", k))
			}
			last, ok := tv[len(tv)-1].(map[string]any)
			if !ok {
				return nil, p.errAt(fmt.Sprintf("表路径 %q 冲突", k))
			}
			curr = last
		default:
			return nil, p.errAt(fmt.Sprintf("键 %q 已存在标量值，不能再定义为表", k))
		}
	}
	return curr, nil
}

// Encode each decoded key as a separate JSON string followed by a delimiter.
// A quoted dot belongs to its component, and a path is a prefix only when the
// complete encoded parent components match.
func tomlTableIdentity(keys []string) string {
	var out strings.Builder
	for _, key := range keys {
		encoded, _ := json.Marshal(key)
		out.Write(encoded)
		out.WriteByte('/')
	}
	return out.String()
}

func (p *tomlParser) navigateArrayTable(root map[string]any, keys []string, arrayTables, definedTables map[string]bool) (map[string]any, error) {
	parent, err := p.navigateTable(root, keys[:len(keys)-1], true)
	if err != nil {
		return nil, err
	}
	lastKey := keys[len(keys)-1]
	existing, exists := parent[lastKey]
	if !exists {
		item := make(map[string]any)
		parent[lastKey] = []any{item}
		return item, nil
	}
	arr, ok := existing.([]any)
	if !ok {
		return nil, p.errAt(fmt.Sprintf("键 %q 已定义为非数组表，不能再用 [[...]]", lastKey))
	}
	// 同路径下之前定义过子表需要清除子节点表标记，允许下个元素继续定义同名子表
	prefix := tomlTableIdentity(keys)
	for k := range definedTables {
		if strings.HasPrefix(k, prefix) {
			delete(definedTables, k)
		}
	}
	for k := range arrayTables {
		if strings.HasPrefix(k, prefix) {
			delete(arrayTables, k)
		}
	}
	item := make(map[string]any)
	parent[lastKey] = append(arr, item)
	return item, nil
}

func (p *tomlParser) assignDotted(tbl map[string]any, keys []string, val any) error {
	curr := tbl
	for _, k := range keys[:len(keys)-1] {
		nextRaw, exists := curr[k]
		if !exists {
			next := make(map[string]any)
			curr[k] = next
			curr = next
			continue
		}
		next, ok := nextRaw.(map[string]any)
		if !ok {
			return p.errAt(fmt.Sprintf("键 %q 已定义为标量，无法继续写入子键", k))
		}
		curr = next
	}
	leaf := keys[len(keys)-1]
	if _, exists := curr[leaf]; exists {
		return p.errAt(fmt.Sprintf("重复定义键 %q", leaf))
	}
	curr[leaf] = val
	return nil
}

func offsetLine(s string, offset int) int { l, _ := offsetToPosition(s, offset); return l }
func offsetCol(s string, offset int) int  { _, c := offsetToPosition(s, offset); return c }

func stringifyTOML(doc map[string]any) string {
	var b strings.Builder
	writeTOMLTable(&b, doc, "")
	text := strings.TrimRight(b.String(), "\n")
	if text == "" {
		return ""
	}
	return text + "\n"
}

func writeTOMLTable(b *strings.Builder, tbl map[string]any, prefix string) {
	keys := make([]string, 0, len(tbl))
	for k := range tbl {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var subTables []string
	var arrayTables []string

	for _, k := range keys {
		v := tbl[k]
		switch tv := v.(type) {
		case map[string]any:
			subTables = append(subTables, k)
		case []any:
			if isArrayOfMaps(tv) {
				arrayTables = append(arrayTables, k)
			} else {
				fmt.Fprintf(b, "%s = %s\n", formatTOMLKey(k), formatTOMLValue(v))
			}
		default:
			fmt.Fprintf(b, "%s = %s\n", formatTOMLKey(k), formatTOMLValue(v))
		}
	}

	for _, k := range subTables {
		sub := tbl[k].(map[string]any)
		fullName := formatTOMLKey(k)
		if prefix != "" {
			fullName = prefix + "." + fullName
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(b, "[%s]\n", fullName)
		writeTOMLTable(b, sub, fullName)
	}

	for _, k := range arrayTables {
		arr := tbl[k].([]any)
		fullName := formatTOMLKey(k)
		if prefix != "" {
			fullName = prefix + "." + fullName
		}
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok {
				if b.Len() > 0 {
					b.WriteByte('\n')
				}
				fmt.Fprintf(b, "[[%s]]\n", fullName)
				writeTOMLTable(b, m, fullName)
			}
		}
	}
}

func isArrayOfMaps(arr []any) bool {
	if len(arr) == 0 {
		return false
	}
	for _, item := range arr {
		if _, ok := item.(map[string]any); !ok {
			return false
		}
	}
	return true
}

func formatTOMLKey(k string) string {
	if k == "" {
		return `""`
	}
	for _, r := range k {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return strconv.Quote(k)
		}
	}
	return k
}

func formatTOMLValue(v any) string {
	switch tv := v.(type) {
	case nil:
		return `""`
	case string:
		return strconv.Quote(tv)
	case bool:
		return strconv.FormatBool(tv)
	case int:
		return strconv.Itoa(tv)
	case int64:
		return strconv.FormatInt(tv, 10)
	case float64:
		return strconv.FormatFloat(tv, 'g', -1, 64)
	case []any:
		parts := make([]string, len(tv))
		for i, item := range tv {
			parts[i] = formatTOMLValue(item)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		keys := make([]string, 0, len(tv))
		for k := range tv {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = fmt.Sprintf("%s = %s", formatTOMLKey(k), formatTOMLValue(tv[k]))
		}
		return "{ " + strings.Join(parts, ", ") + " }"
	default:
		return strconv.Quote(fmt.Sprint(tv))
	}
}

// ---------- 纯 Go YAML 子集解析与导出 ----------

type yamlLine struct {
	num    int
	indent int
	raw    string
	text   string
}

func parseYAML(content string) (any, error) {
	rawLines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	lines := make([]yamlLine, 0, len(rawLines))
	for i, raw := range rawLines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || trimmed == "---" || trimmed == "..." {
			continue
		}
		indent := 0
		for _, r := range raw {
			if r == ' ' {
				indent++
			} else if r == '\t' {
				return nil, &syntaxErrorWithPos{msg: "YAML 不允许使用 Tab 作为缩进", line: i + 1, col: indent + 1}
			} else {
				break
			}
		}
		clean := stripYAMLComment(trimmed)
		if clean == "" {
			continue
		}
		lines = append(lines, yamlLine{num: i + 1, indent: indent, raw: raw, text: clean})
	}
	if len(lines) == 0 {
		return map[string]any{}, nil
	}
	val, next, err := parseYAMLNode(lines, 0, lines[0].indent)
	if err != nil {
		return nil, err
	}
	if next < len(lines) {
		return nil, &syntaxErrorWithPos{msg: "YAML 结构缩进不匹配", line: lines[next].num, col: lines[next].indent + 1}
	}
	return val, nil
}

func stripYAMLComment(s string) string {
	inSingle, inDouble := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\'' && !inDouble {
			inSingle = !inSingle
		} else if c == '"' && !inSingle {
			if i == 0 || s[i-1] != '\\' {
				inDouble = !inDouble
			}
		} else if c == '#' && !inSingle && !inDouble {
			if i == 0 || unicode.IsSpace(rune(s[i-1])) {
				return strings.TrimSpace(s[:i])
			}
		}
	}
	return strings.TrimSpace(s)
}

func parseYAMLNode(lines []yamlLine, idx int, expectedIndent int) (any, int, error) {
	if idx >= len(lines) {
		return nil, idx, nil
	}
	cur := lines[idx]
	if cur.text == "-" || strings.HasPrefix(cur.text, "- ") {
		return parseYAMLSeq(lines, idx, cur.indent)
	}
	if _, _, ok := splitYAMLKV(cur.text); ok {
		return parseYAMLMap(lines, idx, cur.indent)
	}
	val, err := parseYAMLScalarOrFlow(cur.text, cur.num)
	if err != nil {
		return nil, idx, err
	}
	return val, idx + 1, nil
}

func parseYAMLSeq(lines []yamlLine, idx int, seqIndent int) ([]any, int, error) {
	items := make([]any, 0)
	for idx < len(lines) {
		cur := lines[idx]
		if cur.indent < seqIndent {
			break
		}
		if cur.indent > seqIndent {
			return nil, idx, &syntaxErrorWithPos{msg: "YAML 序列缩进不匹配", line: cur.num, col: cur.indent + 1}
		}
		if cur.text != "-" && !strings.HasPrefix(cur.text, "- ") {
			break
		}
		rest := strings.TrimSpace(strings.TrimPrefix(cur.text, "-"))
		if rest == "" {
			idx++
			if idx < len(lines) && lines[idx].indent > seqIndent {
				val, next, err := parseYAMLNode(lines, idx, lines[idx].indent)
				if err != nil {
					return nil, idx, err
				}
				items = append(items, val)
				idx = next
			} else {
				items = append(items, nil)
			}
			continue
		}
		if k, v, ok := splitYAMLKV(rest); ok {
			// `- key: val` 开头的内联对象条目
			itemMap := make(map[string]any)
			seen := map[string]bool{k: true}
			itemIndent := cur.indent + 2
			if v == "|" || v == ">" {
				blockVal, next := collectYAMLBlockScalar(lines, idx+1, itemIndent)
				itemMap[k] = blockVal
				idx = next
			} else if v == "" {
				idx++
				if idx < len(lines) && (lines[idx].indent > itemIndent || ((lines[idx].text == "-" || strings.HasPrefix(lines[idx].text, "- ")) && lines[idx].indent == itemIndent)) {
					nested, next, err := parseYAMLNode(lines, idx, lines[idx].indent)
					if err != nil {
						return nil, idx, err
					}
					itemMap[k] = nested
					idx = next
				} else {
					itemMap[k] = nil
				}
			} else {
				sv, err := parseYAMLScalarOrFlow(v, cur.num)
				if err != nil {
					return nil, idx, err
				}
				itemMap[k] = sv
				idx++
			}
			// 合并紧随其后缩进对齐的键值对
			if idx < len(lines) && lines[idx].indent >= itemIndent && !(lines[idx].text == "-" || strings.HasPrefix(lines[idx].text, "- ")) {
				if _, _, hasKV := splitYAMLKV(lines[idx].text); hasKV {
					more, next, err := parseYAMLMapInto(lines, idx, lines[idx].indent, itemMap, seen)
					if err != nil {
						return nil, idx, err
					}
					itemMap = more
					idx = next
				}
			}
			items = append(items, itemMap)
			continue
		}
		sv, err := parseYAMLScalarOrFlow(rest, cur.num)
		if err != nil {
			return nil, idx, err
		}
		items = append(items, sv)
		idx++
	}
	return items, idx, nil
}

func parseYAMLMap(lines []yamlLine, idx int, mapIndent int) (map[string]any, int, error) {
	return parseYAMLMapInto(lines, idx, mapIndent, make(map[string]any), make(map[string]bool))
}

func parseYAMLMapInto(lines []yamlLine, idx int, mapIndent int, out map[string]any, seen map[string]bool) (map[string]any, int, error) {
	for idx < len(lines) {
		cur := lines[idx]
		if cur.indent < mapIndent {
			break
		}
		if cur.indent > mapIndent {
			return nil, idx, &syntaxErrorWithPos{msg: "YAML 映射缩进异常", line: cur.num, col: cur.indent + 1}
		}
		if cur.text == "-" || strings.HasPrefix(cur.text, "- ") {
			break
		}
		k, v, ok := splitYAMLKV(cur.text)
		if !ok {
			return nil, idx, &syntaxErrorWithPos{msg: "YAML 行缺少 ':' 分隔符", line: cur.num, col: cur.indent + 1}
		}
		if seen[k] {
			return nil, idx, &syntaxErrorWithPos{msg: fmt.Sprintf("重复的 YAML 键 %q", k), line: cur.num, col: cur.indent + 1}
		}
		seen[k] = true
		if v == "|" || v == ">" || v == "|-" || v == ">-" {
			blockVal, next := collectYAMLBlockScalar(lines, idx+1, mapIndent)
			out[k] = blockVal
			idx = next
			continue
		}
		if v == "" {
			idx++
			if idx < len(lines) && (lines[idx].indent > mapIndent || ((lines[idx].text == "-" || strings.HasPrefix(lines[idx].text, "- ")) && lines[idx].indent == mapIndent)) {
				val, next, err := parseYAMLNode(lines, idx, lines[idx].indent)
				if err != nil {
					return nil, idx, err
				}
				out[k] = val
				idx = next
			} else {
				out[k] = nil
			}
			continue
		}
		sv, err := parseYAMLScalarOrFlow(v, cur.num)
		if err != nil {
			return nil, idx, err
		}
		out[k] = sv
		idx++
	}
	return out, idx, nil
}

func collectYAMLBlockScalar(lines []yamlLine, idx int, parentIndent int) (string, int) {
	parts := make([]string, 0)
	for idx < len(lines) && lines[idx].indent > parentIndent {
		parts = append(parts, strings.TrimSpace(lines[idx].raw))
		idx++
	}
	return strings.Join(parts, "\n"), idx
}

func splitYAMLKV(text string) (string, string, bool) {
	inSingle, inDouble := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c == '\'' && !inDouble {
			inSingle = !inSingle
		} else if c == '"' && !inSingle {
			if i == 0 || text[i-1] != '\\' {
				inDouble = !inDouble
			}
		} else if c == ':' && !inSingle && !inDouble {
			if i+1 == len(text) || text[i+1] == ' ' {
				rawKey := strings.TrimSpace(text[:i])
				key := unquoteYAMLKey(rawKey)
				val := ""
				if i+1 < len(text) {
					val = strings.TrimSpace(text[i+1:])
				}
				if key != "" {
					return key, val, true
				}
			}
		}
	}
	return "", "", false
}

func unquoteYAMLKey(k string) string {
	if len(k) >= 2 && ((k[0] == '"' && k[len(k)-1] == '"') || (k[0] == '\'' && k[len(k)-1] == '\'')) {
		return k[1 : len(k)-1]
	}
	return k
}

func parseYAMLScalarOrFlow(raw string, lineNum int) (any, error) {
	s := strings.TrimSpace(raw)
	if s == "" || s == "null" || s == "~" {
		return nil, nil
	}
	if s == "true" || s == "True" || s == "TRUE" {
		return true, nil
	}
	if s == "false" || s == "False" || s == "FALSE" {
		return false, nil
	}
	if strings.HasPrefix(s, `"`) {
		if len(s) < 2 || s[len(s)-1] != '"' {
			return nil, &syntaxErrorWithPos{msg: "未闭合的双引号字符串", line: lineNum, col: 1}
		}
		if u, err := strconv.Unquote(s); err == nil {
			return u, nil
		}
		return s[1 : len(s)-1], nil
	}
	if strings.HasPrefix(s, `'`) {
		if len(s) < 2 || s[len(s)-1] != '\'' {
			return nil, &syntaxErrorWithPos{msg: "未闭合的单引号字符串", line: lineNum, col: 1}
		}
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'"), nil
	}
	if strings.HasPrefix(s, "[") {
		if !strings.HasSuffix(s, "]") {
			return nil, &syntaxErrorWithPos{msg: "流式列表缺少闭合 ']'", line: lineNum, col: 1}
		}
		inner := strings.TrimSpace(s[1 : len(s)-1])
		if inner == "" {
			return []any{}, nil
		}
		parts := splitFlowTopLevel(inner)
		out := make([]any, len(parts))
		for i, part := range parts {
			v, err := parseYAMLScalarOrFlow(part, lineNum)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	}
	if strings.HasPrefix(s, "{") {
		if !strings.HasSuffix(s, "}") {
			return nil, &syntaxErrorWithPos{msg: "流式映射缺少闭合 '}'", line: lineNum, col: 1}
		}
		inner := strings.TrimSpace(s[1 : len(s)-1])
		out := make(map[string]any)
		if inner == "" {
			return out, nil
		}
		for _, part := range splitFlowTopLevel(inner) {
			k, v, ok := splitYAMLKV(part)
			if !ok {
				return nil, &syntaxErrorWithPos{msg: "流式映射条目缺少 ':'", line: lineNum, col: 1}
			}
			sv, err := parseYAMLScalarOrFlow(v, lineNum)
			if err != nil {
				return nil, err
			}
			out[k] = sv
		}
		return out, nil
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i, nil
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f, nil
	}
	return s, nil
}

func splitFlowTopLevel(s string) []string {
	var parts []string
	depth := 0
	inSingle, inDouble := false, false
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\'' && !inDouble {
			inSingle = !inSingle
		} else if c == '"' && !inSingle && (i == 0 || s[i-1] != '\\') {
			inDouble = !inDouble
		} else if !inSingle && !inDouble {
			switch c {
			case '[', '{':
				depth++
			case ']', '}':
				depth--
			case ',':
				if depth == 0 {
					parts = append(parts, strings.TrimSpace(s[start:i]))
					start = i + 1
				}
			}
		}
	}
	if tail := strings.TrimSpace(s[start:]); tail != "" {
		parts = append(parts, tail)
	}
	return parts
}

func stringifyYAML(v any) string {
	var b strings.Builder
	writeYAMLValue(&b, v, 0)
	text := strings.TrimRight(b.String(), "\n")
	if text == "" {
		return "{}\n"
	}
	return text + "\n"
}

func writeYAMLValue(b *strings.Builder, v any, indent int) {
	pad := strings.Repeat("  ", indent)
	switch tv := v.(type) {
	case map[string]any:
		if len(tv) == 0 {
			b.WriteString(pad + "{}\n")
			return
		}
		keys := make([]string, 0, len(tv))
		for k := range tv {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			item := tv[k]
			switch child := item.(type) {
			case map[string]any:
				if len(child) == 0 {
					fmt.Fprintf(b, "%s%s: {}\n", pad, formatYAMLKey(k))
				} else {
					fmt.Fprintf(b, "%s%s:\n", pad, formatYAMLKey(k))
					writeYAMLValue(b, child, indent+1)
				}
			case []any:
				if len(child) == 0 {
					fmt.Fprintf(b, "%s%s: []\n", pad, formatYAMLKey(k))
				} else {
					fmt.Fprintf(b, "%s%s:\n", pad, formatYAMLKey(k))
					writeYAMLValue(b, child, indent+1)
				}
			default:
				fmt.Fprintf(b, "%s%s: %s\n", pad, formatYAMLKey(k), formatYAMLScalar(item))
			}
		}
	case []any:
		for _, item := range tv {
			switch child := item.(type) {
			case map[string]any, []any:
				fmt.Fprintf(b, "%s-\n", pad)
				writeYAMLValue(b, child, indent+1)
			default:
				fmt.Fprintf(b, "%s- %s\n", pad, formatYAMLScalar(item))
			}
		}
	default:
		fmt.Fprintf(b, "%s%s\n", pad, formatYAMLScalar(v))
	}
}

func formatYAMLKey(k string) string {
	if k == "" || strings.ContainsAny(k, ": #{}[]\"'\n") {
		return strconv.Quote(k)
	}
	return k
}

func formatYAMLScalar(v any) string {
	if v == nil {
		return "null"
	}
	switch tv := v.(type) {
	case bool:
		return strconv.FormatBool(tv)
	case int:
		return strconv.Itoa(tv)
	case int64:
		return strconv.FormatInt(tv, 10)
	case float64:
		return strconv.FormatFloat(tv, 'g', -1, 64)
	case string:
		if tv == "" || tv == "true" || tv == "false" || tv == "null" || tv == "~" ||
			strings.ContainsAny(tv, ":#{}[]&*!|>'\"%@`\n") {
			return strconv.Quote(tv)
		}
		if _, err := strconv.ParseFloat(tv, 64); err == nil {
			return strconv.Quote(tv)
		}
		return tv
	default:
		return strconv.Quote(fmt.Sprint(tv))
	}
}

// ---------- 脱敏导出 ----------

func parseForExport(content, format string) (any, bool) {
	if strings.TrimSpace(content) == "" {
		return map[string]any{}, true
	}
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json":
		val, errs := parseJSONStrict(content)
		return val, len(errs) == 0
	case "jsonc":
		val, errs := parseJSONC(content)
		return val, len(errs) == 0
	case "toml":
		val, err := parseTOML(content)
		return val, err == nil
	case "yaml":
		val, err := parseYAML(content)
		return val, err == nil
	default:
		return nil, false
	}
}

func stringifyForExport(val any, format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "toml":
		if m, ok := val.(map[string]any); ok {
			return stringifyTOML(m)
		}
		return stringifyTOML(map[string]any{})
	case "yaml":
		return stringifyYAML(val)
	default:
		data, err := json.MarshalIndent(val, "", "  ")
		if err != nil {
			return "{}\n"
		}
		return string(data) + "\n"
	}
}

func secretFieldPaths(schema *ConfigSchema) map[string]bool {
	paths := make(map[string]bool)
	if schema == nil {
		return paths
	}
	for _, f := range schema.Fields {
		if f.Secret {
			if norm := NormalizeSchemaPath(f.Path); norm != "" {
				paths[norm] = true
			}
		}
	}
	return paths
}

func pathIsSecret(pathText string, secretPaths map[string]bool, key string, sensitiveFile bool) bool {
	lowerKey := strings.ToLower(key)
	if sensitiveFile {
		return !sensitiveSafeKeys[lowerKey]
	}
	if secretKeyPattern.MatchString(lowerKey) {
		return true
	}
	norm := NormalizeSchemaPath(pathText)
	if norm == "" {
		return false
	}
	for sp := range secretPaths {
		if norm == sp || strings.HasPrefix(norm, sp+".") {
			return true
		}
	}
	return false
}

func walkRedacted(val any, secretPaths map[string]bool, sensitiveFile bool, pathParts []string, key string, fields *[]string) any {
	switch tv := val.(type) {
	case []any:
		out := make([]any, len(tv))
		nextParts := append(append([]string(nil), pathParts...), "*")
		for i, item := range tv {
			out[i] = walkRedacted(item, secretPaths, sensitiveFile, nextParts, key, fields)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(tv))
		for k, item := range tv {
			nextParts := append(append([]string(nil), pathParts...), k)
			out[k] = walkRedacted(item, secretPaths, sensitiveFile, nextParts, k, fields)
		}
		return out
	case string:
		if tv != "" {
			pathText := strings.Join(pathParts, ".")
			if pathIsSecret(pathText, secretPaths, key, sensitiveFile) {
				if len(*fields) < 200 {
					*fields = append(*fields, pathText)
				}
				return "<redacted>"
			}
		}
		return tv
	default:
		return val
	}
}

func redactLineBased(content string) (string, []string) {
	fields := make([]string, 0)
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		m := reLineRedact.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key := strings.NewReplacer(`"`, "", `'`, "", ":", "", "=", "", " ", "", "\t", "").Replace(m[1])
		if !secretKeyPattern.MatchString(key) {
			continue
		}
		fields = append(fields, key)
		quote := ""
		if strings.HasPrefix(strings.TrimLeft(m[2], " \t"), `"`) {
			quote = `"`
		}
		lines[i] = m[1] + quote + "<redacted>" + quote + m[3]
	}
	return strings.Join(lines, "\n"), fields
}

// RedactConfigContent 对配置文本执行凭据脱敏并返回替换字段清单。
func RedactConfigContent(content, format string, schema *ConfigSchema, sensitiveFile bool) RedactResult {
	secretPaths := secretFieldPaths(schema)
	if parsed, ok := parseForExport(content, format); ok {
		fields := make([]string, 0)
		redacted := walkRedacted(parsed, secretPaths, sensitiveFile, nil, "", &fields)
		outFmt := strings.ToLower(strings.TrimSpace(format))
		if outFmt == "jsonc" {
			outFmt = "json"
		}
		return RedactResult{
			Content: stringifyForExport(redacted, outFmt),
			Fields:  fields,
			Parsed:  true,
		}
	}
	text, fields := redactLineBased(content)
	return RedactResult{
		Content: text,
		Fields:  fields,
		Parsed:  false,
	}
}

// ParseYAML 将 YAML 文本解析为通用 Go 结构（map[string]any / []any / 标量），供跨包复用。
func ParseYAML(content string) (any, error) {
	return parseYAML(content)
}

// StringifyYAML 将通用 Go 结构序列化为标准两空格缩进 YAML 文本，供跨包复用。
func StringifyYAML(v any) string {
	return stringifyYAML(v)
}
