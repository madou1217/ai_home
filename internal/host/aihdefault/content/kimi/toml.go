package kimi

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// tomlPaths 记录文档里定义过的表/键路径（含隐式父表）。
// 只需支撑冲突判定：用户是否已经自己定义了 providers.aih-server
// 或 models."aih-server/kimi-for-coding"。
type tomlPaths map[string]struct{}

const pathSeparator = "\x00"

func (paths tomlPaths) add(path []string) {
	for index := 1; index <= len(path); index++ {
		paths[strings.Join(path[:index], pathSeparator)] = struct{}{}
	}
}

func (paths tomlPaths) has(parts ...string) bool {
	_, found := paths[strings.Join(parts, pathSeparator)]
	return found
}

// 标量校验用字符类而不是 \d/\s，避免把 Go 字符串写得难读。
var (
	integerPattern    = regexp.MustCompile("^[+-]?(0|[1-9](_?[0-9])*)$")
	hexPattern        = regexp.MustCompile("^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$")
	octalPattern      = regexp.MustCompile("^0o[0-7](_?[0-7])*$")
	binaryPattern     = regexp.MustCompile("^0b[01](_?[01])*$")
	floatPattern      = regexp.MustCompile("^[+-]?(0|[1-9](_?[0-9])*)([.][0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$")
	specialPattern    = regexp.MustCompile("^[+-]?(inf|nan)$")
	datePattern       = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
	timePattern       = regexp.MustCompile("^[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?$")
	dateTimePattern   = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})?$")
	timeOffsetPattern = regexp.MustCompile("^[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})?$")
)

// scanTOML 做语法校验并收集所有已定义路径。它覆盖 Kimi config.toml 会用到的
// TOML 子集（表、数组表、字符串、数组、内联表、数字/布尔/日期），足以拒绝
// 让 smol-toml 报错的坏内容，同时不引入第三方依赖。
func scanTOML(source string) (tomlPaths, error) {
	scanner := &tomlScanner{src: source, paths: tomlPaths{}, defined: map[string]struct{}{}}
	var table []string
	tableIsArray := false
	for {
		scanner.skipBlank()
		if scanner.eof() {
			break
		}
		if scanner.peek() == '[' {
			path, isArray, err := scanner.parseTableHeader()
			if err != nil {
				return nil, err
			}
			if !isArray {
				if err := scanner.define(path); err != nil {
					return nil, err
				}
			}
			scanner.paths.add(path)
			table = path
			tableIsArray = isArray
			if err := scanner.finishStatement(); err != nil {
				return nil, err
			}
			continue
		}
		keyPath, err := scanner.parseDottedKey()
		if err != nil {
			return nil, err
		}
		scanner.skipSpace()
		if scanner.eof() || scanner.peek() != '=' {
			return nil, scanner.errorf("expected '=' after key")
		}
		scanner.pos++
		scanner.skipSpace()
		if scanner.eof() || scanner.peek() == '\n' || scanner.peek() == '\r' || scanner.peek() == '#' {
			return nil, scanner.errorf("missing value")
		}
		fullPath := append(append([]string{}, table...), keyPath...)
		valuePrefix := fullPath
		// 数组表的每个元素可以有同名键；此时不做重复判定，也不收集元素内路径。
		if tableIsArray {
			valuePrefix = nil
		} else if err := scanner.define(fullPath); err != nil {
			return nil, err
		}
		scanner.paths.add(fullPath)
		if err := scanner.parseValue(valuePrefix); err != nil {
			return nil, err
		}
		if err := scanner.finishStatement(); err != nil {
			return nil, err
		}
	}
	return scanner.paths, nil
}

type tomlScanner struct {
	src     string
	pos     int
	paths   tomlPaths
	defined map[string]struct{}
}

// define 记录显式定义的表/键并拒绝重复定义（smol-toml 同样报错）。
// 隐式父表不在这里登记，因此 [a] 之后再写 [a.b] 不会误判。
func (scanner *tomlScanner) define(path []string) error {
	key := strings.Join(path, pathSeparator)
	if _, found := scanner.defined[key]; found {
		return scanner.errorf("duplicate key %q", strings.Join(path, "."))
	}
	scanner.defined[key] = struct{}{}
	return nil
}

func (scanner *tomlScanner) eof() bool {
	return scanner.pos >= len(scanner.src)
}

func (scanner *tomlScanner) peek() byte {
	return scanner.src[scanner.pos]
}

func (scanner *tomlScanner) errorf(format string, args ...any) error {
	line := 1 + strings.Count(scanner.src[:scanner.pos], "\n")
	return fmt.Errorf("%w: line %d: %s", ErrInvalidTOML, line, fmt.Sprintf(format, args...))
}

func (scanner *tomlScanner) skipSpace() {
	for !scanner.eof() && (scanner.peek() == ' ' || scanner.peek() == '\t') {
		scanner.pos++
	}
}

func (scanner *tomlScanner) skipComment() {
	for !scanner.eof() && scanner.peek() != '\n' {
		scanner.pos++
	}
}

func (scanner *tomlScanner) skipBlank() {
	for !scanner.eof() {
		switch scanner.peek() {
		case ' ', '\t', '\r', '\n':
			scanner.pos++
		case '#':
			scanner.skipComment()
		default:
			return
		}
	}
}

func (scanner *tomlScanner) skipArraySpace() {
	for !scanner.eof() {
		switch scanner.peek() {
		case ' ', '\t', '\r', '\n':
			scanner.pos++
		case '#':
			scanner.skipComment()
		default:
			return
		}
	}
}

func (scanner *tomlScanner) finishStatement() error {
	scanner.skipSpace()
	if !scanner.eof() && scanner.peek() == '#' {
		scanner.skipComment()
	}
	if scanner.eof() {
		return nil
	}
	switch scanner.peek() {
	case '\n':
		scanner.pos++
	case '\r':
		scanner.pos++
		if !scanner.eof() && scanner.peek() == '\n' {
			scanner.pos++
		}
	default:
		return scanner.errorf("expected end of line")
	}
	return nil
}

func (scanner *tomlScanner) parseTableHeader() ([]string, bool, error) {
	scanner.pos++
	isArray := false
	if !scanner.eof() && scanner.peek() == '[' {
		isArray = true
		scanner.pos++
	}
	scanner.skipSpace()
	path, err := scanner.parseDottedKey()
	if err != nil {
		return nil, false, err
	}
	scanner.skipSpace()
	if scanner.eof() || scanner.peek() != ']' {
		return nil, false, scanner.errorf("unterminated table header")
	}
	scanner.pos++
	if isArray {
		scanner.skipSpace()
		if scanner.eof() || scanner.peek() != ']' {
			return nil, false, scanner.errorf("unterminated array table header")
		}
		scanner.pos++
	}
	return path, isArray, nil
}

func (scanner *tomlScanner) parseDottedKey() ([]string, error) {
	var parts []string
	for {
		scanner.skipSpace()
		part, err := scanner.parseKeyPart()
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
		scanner.skipSpace()
		if scanner.eof() || scanner.peek() != '.' {
			return parts, nil
		}
		scanner.pos++
	}
}

func (scanner *tomlScanner) parseKeyPart() (string, error) {
	if scanner.eof() {
		return "", scanner.errorf("expected key")
	}
	switch scanner.peek() {
	case '"':
		return scanner.parseBasicString()
	case '\'':
		return scanner.parseLiteralString()
	}
	start := scanner.pos
	for !scanner.eof() && isBareKeyChar(scanner.peek()) {
		scanner.pos++
	}
	if start == scanner.pos {
		return "", scanner.errorf("invalid key")
	}
	return scanner.src[start:scanner.pos], nil
}

func isBareKeyChar(value byte) bool {
	return value >= 'A' && value <= 'Z' ||
		value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9' ||
		value == '_' || value == '-'
}

func (scanner *tomlScanner) parseValue(prefix []string) error {
	if scanner.eof() {
		return scanner.errorf("missing value")
	}
	switch scanner.peek() {
	case '"':
		if scanner.hasTriple('"') {
			return scanner.skipMultilineBasic()
		}
		_, err := scanner.parseBasicString()
		return err
	case '\'':
		if scanner.hasTriple('\'') {
			return scanner.skipMultilineLiteral()
		}
		_, err := scanner.parseLiteralString()
		return err
	case '[':
		return scanner.parseArray()
	case '{':
		return scanner.parseInlineTable(prefix)
	}
	return scanner.parseScalar()
}

func (scanner *tomlScanner) hasTriple(quote byte) bool {
	return scanner.pos+3 <= len(scanner.src) &&
		scanner.src[scanner.pos] == quote &&
		scanner.src[scanner.pos+1] == quote &&
		scanner.src[scanner.pos+2] == quote
}

func (scanner *tomlScanner) parseBasicString() (string, error) {
	scanner.pos++
	var builder strings.Builder
	for {
		if scanner.eof() {
			return "", scanner.errorf("unterminated string")
		}
		value := scanner.peek()
		switch value {
		case '"':
			scanner.pos++
			return builder.String(), nil
		case '\\':
			scanner.pos++
			if err := scanner.decodeEscape(&builder); err != nil {
				return "", err
			}
		case '\n', '\r':
			return "", scanner.errorf("newline in string")
		default:
			if value < 0x20 && value != '\t' {
				return "", scanner.errorf("control character in string")
			}
			builder.WriteByte(value)
			scanner.pos++
		}
	}
}

func (scanner *tomlScanner) parseLiteralString() (string, error) {
	scanner.pos++
	start := scanner.pos
	for {
		if scanner.eof() {
			return "", scanner.errorf("unterminated literal string")
		}
		value := scanner.peek()
		if value == '\'' {
			result := scanner.src[start:scanner.pos]
			scanner.pos++
			return result, nil
		}
		if value == '\n' || value == '\r' {
			return "", scanner.errorf("newline in literal string")
		}
		scanner.pos++
	}
}

func (scanner *tomlScanner) decodeEscape(builder *strings.Builder) error {
	if scanner.eof() {
		return scanner.errorf("unterminated escape")
	}
	value := scanner.peek()
	switch value {
	case '"', '\\':
		if builder != nil {
			builder.WriteByte(value)
		}
		scanner.pos++
	case 'b', 't', 'n', 'f', 'r':
		if builder != nil {
			switch value {
			case 'b':
				builder.WriteByte('\b')
			case 't':
				builder.WriteByte('\t')
			case 'n':
				builder.WriteByte('\n')
			case 'f':
				builder.WriteByte('\f')
			case 'r':
				builder.WriteByte('\r')
			}
		}
		scanner.pos++
	case 'u', 'U':
		digits := 4
		if value == 'U' {
			digits = 8
		}
		scanner.pos++
		if scanner.pos+digits > len(scanner.src) {
			return scanner.errorf("short unicode escape")
		}
		parsed, err := strconv.ParseUint(scanner.src[scanner.pos:scanner.pos+digits], 16, 32)
		if err != nil {
			return scanner.errorf("invalid unicode escape")
		}
		if parsed > 0x10FFFF || (parsed >= 0xD800 && parsed <= 0xDFFF) {
			return scanner.errorf("invalid unicode scalar")
		}
		if builder != nil {
			builder.WriteRune(rune(parsed))
		}
		scanner.pos += digits
	default:
		return scanner.errorf("invalid escape")
	}
	return nil
}

func (scanner *tomlScanner) skipMultilineBasic() error {
	scanner.pos += 3
	for {
		if scanner.eof() {
			return scanner.errorf("unterminated multiline string")
		}
		if scanner.peek() == '"' && scanner.hasTriple('"') {
			count := 0
			for scanner.pos+count < len(scanner.src) && scanner.src[scanner.pos+count] == '"' {
				count++
			}
			scanner.pos += count
			return nil
		}
		if scanner.peek() != '\\' {
			scanner.pos++
			continue
		}
		scanner.pos++
		if scanner.eof() {
			return scanner.errorf("unterminated escape")
		}
		if scanner.peek() == '\n' {
			scanner.pos++
			scanner.skipMultilineGap()
			continue
		}
		if scanner.peek() == '\r' {
			scanner.pos++
			if !scanner.eof() && scanner.peek() == '\n' {
				scanner.pos++
			}
			scanner.skipMultilineGap()
			continue
		}
		if err := scanner.decodeEscape(nil); err != nil {
			return err
		}
	}
}

func (scanner *tomlScanner) skipMultilineGap() {
	for !scanner.eof() {
		switch scanner.peek() {
		case ' ', '\t', '\r', '\n':
			scanner.pos++
		default:
			return
		}
	}
}

func (scanner *tomlScanner) skipMultilineLiteral() error {
	scanner.pos += 3
	for {
		if scanner.eof() {
			return scanner.errorf("unterminated multiline literal string")
		}
		if scanner.peek() == '\'' && scanner.hasTriple('\'') {
			count := 0
			for scanner.pos+count < len(scanner.src) && scanner.src[scanner.pos+count] == '\'' {
				count++
			}
			scanner.pos += count
			return nil
		}
		scanner.pos++
	}
}

func (scanner *tomlScanner) parseArray() error {
	scanner.pos++
	for {
		scanner.skipArraySpace()
		if scanner.eof() {
			return scanner.errorf("unterminated array")
		}
		if scanner.peek() == ']' {
			scanner.pos++
			return nil
		}
		if err := scanner.parseValue(nil); err != nil {
			return err
		}
		scanner.skipArraySpace()
		if scanner.eof() {
			return scanner.errorf("unterminated array")
		}
		switch scanner.peek() {
		case ',':
			scanner.pos++
		case ']':
			scanner.pos++
			return nil
		default:
			return scanner.errorf("expected ',' or ']' in array")
		}
	}
}

func (scanner *tomlScanner) parseInlineTable(prefix []string) error {
	scanner.pos++
	scanner.skipSpace()
	if !scanner.eof() && scanner.peek() == '}' {
		scanner.pos++
		return nil
	}
	for {
		scanner.skipSpace()
		keyPath, err := scanner.parseDottedKey()
		if err != nil {
			return err
		}
		scanner.skipSpace()
		if scanner.eof() || scanner.peek() != '=' {
			return scanner.errorf("expected '=' in inline table")
		}
		scanner.pos++
		scanner.skipSpace()
		var child []string
		if prefix != nil {
			child = append(append([]string{}, prefix...), keyPath...)
			if err := scanner.define(child); err != nil {
				return err
			}
			scanner.paths.add(child)
		}
		if err := scanner.parseValue(child); err != nil {
			return err
		}
		scanner.skipSpace()
		if scanner.eof() {
			return scanner.errorf("unterminated inline table")
		}
		switch scanner.peek() {
		case ',':
			scanner.pos++
		case '}':
			scanner.pos++
			return nil
		default:
			return scanner.errorf("expected ',' or '}' in inline table")
		}
	}
}

func (scanner *tomlScanner) parseScalar() error {
	start := scanner.pos
	for !scanner.eof() && !isValueDelimiter(scanner.peek()) {
		scanner.pos++
	}
	if start == scanner.pos {
		return scanner.errorf("invalid value")
	}
	token := scanner.src[start:scanner.pos]
	if validScalar(token) {
		return nil
	}
	// 日期与时间可以用空格分隔（1979-05-27 07:32:00）。
	if datePattern.MatchString(token) && !scanner.eof() && scanner.peek() == ' ' {
		afterDate := scanner.pos
		scanner.pos++
		startTime := scanner.pos
		for !scanner.eof() && !isValueDelimiter(scanner.peek()) {
			scanner.pos++
		}
		if timeOffsetPattern.MatchString(scanner.src[startTime:scanner.pos]) {
			return nil
		}
		scanner.pos = afterDate
		return nil
	}
	return scanner.errorf("invalid value %q", token)
}

func isValueDelimiter(value byte) bool {
	switch value {
	case ' ', '\t', '\r', '\n', ',', ']', '}', '#':
		return true
	}
	return false
}

func validScalar(token string) bool {
	if token == "true" || token == "false" {
		return true
	}
	return integerPattern.MatchString(token) ||
		hexPattern.MatchString(token) ||
		octalPattern.MatchString(token) ||
		binaryPattern.MatchString(token) ||
		floatPattern.MatchString(token) ||
		specialPattern.MatchString(token) ||
		datePattern.MatchString(token) ||
		timePattern.MatchString(token) ||
		dateTimePattern.MatchString(token)
}
