package subaggregator

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// EmitYAML 将数据渲染为可读 YAML，保持 YAMLMap 的字段顺序并避免 HTML 转义。
func EmitYAML(value any) string {
	var buf strings.Builder
	writeYAMLValue(&buf, value, 0)
	return buf.String()
}

func yamlScalar(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}

func isScalar(v any) bool {
	if v == nil {
		return true
	}
	switch v.(type) {
	case string, bool, int, int64, float64, float32:
		return true
	}
	return false
}

func writeYAMLValue(buf *strings.Builder, value any, indent int) {
	pad := strings.Repeat(" ", indent)
	switch v := value.(type) {
	case nil:
		buf.WriteString("null")
	case string, bool, int, int64, float64, float32:
		buf.WriteString(yamlScalar(v))
	case []any:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		for i, item := range v {
			if i > 0 {
				buf.WriteByte('\n')
			}
			buf.WriteString(pad)
			buf.WriteString("- ")
			writeYAMLListItem(buf, item, indent+2)
		}
	case []string:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		for i, item := range v {
			if i > 0 {
				buf.WriteByte('\n')
			}
			buf.WriteString(pad)
			buf.WriteString("- ")
			buf.WriteString(yamlScalar(item))
		}
	case []YAMLMap:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		for i := range v {
			if i > 0 {
				buf.WriteByte('\n')
			}
			buf.WriteString(pad)
			buf.WriteString("- ")
			writeYAMLListItem(buf, v[i], indent+2)
		}
	case *YAMLMap:
		if v == nil || len(v.Entries) == 0 {
			buf.WriteString("{}")
			return
		}
		writeYAMLMapEntries(buf, v.Entries, indent)
	case YAMLMap:
		if len(v.Entries) == 0 {
			buf.WriteString("{}")
			return
		}
		writeYAMLMapEntries(buf, v.Entries, indent)
	case map[string]any:
		if len(v) == 0 {
			buf.WriteString("{}")
			return
		}
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		entries := make([]YAMLKV, 0, len(keys))
		for _, k := range keys {
			entries = append(entries, YAMLKV{Key: k, Value: v[k]})
		}
		writeYAMLMapEntries(buf, entries, indent)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			buf.WriteString(yamlScalar(fmt.Sprint(v)))
			return
		}
		var generic any
		if json.Unmarshal(raw, &generic) == nil {
			writeYAMLValue(buf, generic, indent)
		} else {
			buf.WriteString(string(raw))
		}
	}
}

func formatYAMLKey(key string) string {
	for i := 0; i < len(key); i++ {
		c := key[i]
		ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-'
		if !ok {
			return yamlScalar(key)
		}
	}
	if key == "" {
		return `""`
	}
	return key
}

func writeYAMLMapEntries(buf *strings.Builder, entries []YAMLKV, indent int) {
	pad := strings.Repeat(" ", indent)
	for i, entry := range entries {
		if i > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteString(formatYAMLKey(entry.Key))
		buf.WriteByte(':')
		if isScalar(entry.Value) || isEmptyYAMLContainer(entry.Value) {
			buf.WriteByte(' ')
			writeYAMLValue(buf, entry.Value, indent)
		} else {
			buf.WriteByte('\n')
			writeYAMLValue(buf, entry.Value, indent+2)
		}
	}
}

func isEmptyYAMLContainer(v any) bool {
	switch x := v.(type) {
	case []any:
		return len(x) == 0
	case []string:
		return len(x) == 0
	case []YAMLMap:
		return len(x) == 0
	case *YAMLMap:
		return x == nil || len(x.Entries) == 0
	case YAMLMap:
		return len(x.Entries) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}

func writeYAMLListItem(buf *strings.Builder, item any, childIndent int) {
	var entries []YAMLKV
	switch x := item.(type) {
	case *YAMLMap:
		if x != nil {
			entries = x.Entries
		}
	case YAMLMap:
		entries = x.Entries
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			entries = append(entries, YAMLKV{Key: k, Value: x[k]})
		}
	default:
		writeYAMLValue(buf, item, childIndent)
		return
	}
	if len(entries) == 0 {
		buf.WriteString("{}")
		return
	}
	first := entries[0]
	buf.WriteString(formatYAMLKey(first.Key))
	buf.WriteByte(':')
	if isScalar(first.Value) || isEmptyYAMLContainer(first.Value) {
		buf.WriteByte(' ')
		writeYAMLValue(buf, first.Value, childIndent)
	} else {
		buf.WriteByte('\n')
		writeYAMLValue(buf, first.Value, childIndent+2)
	}
	if len(entries) > 1 {
		buf.WriteByte('\n')
		writeYAMLMapEntries(buf, entries[1:], childIndent)
	}
}

// StripJSONC 清理 JSON 中的 // 注释、/* */ 注释及尾随逗号。
func StripJSONC(input string) string {
	var out strings.Builder
	out.Grow(len(input))
	inString := false
	escaped := false
	inLineComment := false
	inBlockComment := false

	for i := 0; i < len(input); i++ {
		c := input[i]
		next := byte(0)
		if i+1 < len(input) {
			next = input[i+1]
		}
		if inLineComment {
			if c == '\n' || c == '\r' {
				inLineComment = false
				out.WriteByte(c)
			}
			continue
		}
		if inBlockComment {
			if c == '*' && next == '/' {
				inBlockComment = false
				i++
			}
			continue
		}
		if inString {
			out.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
			out.WriteByte(c)
			continue
		}
		if c == '/' && next == '/' {
			inLineComment = true
			i++
			continue
		}
		if c == '/' && next == '*' {
			inBlockComment = true
			i++
			continue
		}
		out.WriteByte(c)
	}
	raw := out.String()
	var clean strings.Builder
	clean.Grow(len(raw))
	inString = false
	escaped = false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if inString {
			clean.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
			clean.WriteByte(c)
			continue
		}
		if c == ',' {
			j := i + 1
			for j < len(raw) && (raw[j] == ' ' || raw[j] == '\t' || raw[j] == '\r' || raw[j] == '\n') {
				j++
			}
			if j < len(raw) && (raw[j] == '}' || raw[j] == ']') {
				continue
			}
		}
		clean.WriteByte(c)
	}
	return clean.String()
}

// ParseYAML 解析订阅常见 YAML 子集（含映射、列表、流式集合、单双引号、多行块标量及 anchor/alias/merge）。
func ParseYAML(input string) (any, error) {
	input = strings.TrimPrefix(input, "\uFEFF")
	p := &yamlParser{
		lines:   splitYAMLLines(input),
		anchors: make(map[string]any),
	}
	p.skipBlankAndDocMarkers()
	if p.pos >= len(p.lines) {
		return nil, nil
	}
	val, err := p.parseBlock(0)
	if err != nil {
		return nil, err
	}
	return val, nil
}

type yamlLine struct {
	indent  int
	content string
	raw     string
}

type yamlParser struct {
	lines   []yamlLine
	pos     int
	anchors map[string]any
}

func splitYAMLLines(input string) []yamlLine {
	norm := strings.ReplaceAll(strings.ReplaceAll(input, "\r\n", "\n"), "\r", "\n")
	rawLines := strings.Split(norm, "\n")
	out := make([]yamlLine, len(rawLines))
	for i, line := range rawLines {
		indent := 0
		for indent < len(line) && line[indent] == ' ' {
			indent++
		}
		trimmed := stripYAMLComment(strings.TrimLeft(line, " \t"))
		out[i] = yamlLine{
			indent:  indent,
			content: strings.TrimSpace(trimmed),
			raw:     line,
		}
	}
	return out
}

func stripYAMLComment(s string) string {
	var inSingle, inDouble, escaped bool
	var braceDepth, bracketDepth int
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
				} else {
					inSingle = false
				}
			}
			continue
		}
		if inDouble {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '{':
			braceDepth++
		case '}':
			if braceDepth > 0 {
				braceDepth--
			}
		case '[':
			bracketDepth++
		case ']':
			if bracketDepth > 0 {
				bracketDepth--
			}
		case '#':
			if braceDepth == 0 && bracketDepth == 0 {
				if i == 0 || s[i-1] == ' ' || s[i-1] == '\t' {
					return strings.TrimRight(s[:i], " \t")
				}
			}
		}
	}
	return strings.TrimRight(s, " \t")
}

func (p *yamlParser) skipBlank() {
	for p.pos < len(p.lines) && p.lines[p.pos].content == "" {
		p.pos++
	}
}

func (p *yamlParser) skipBlankAndDocMarkers() {
	for p.pos < len(p.lines) {
		c := p.lines[p.pos].content
		if c == "" || c == "---" || c == "..." {
			p.pos++
			continue
		}
		break
	}
}

func (p *yamlParser) parseBlock(minIndent int) (any, error) {
	p.skipBlank()
	if p.pos >= len(p.lines) {
		return nil, nil
	}
	line := p.lines[p.pos]
	if line.indent < minIndent {
		return nil, nil
	}
	if line.content == "-" || strings.HasPrefix(line.content, "- ") {
		return p.parseSequence(line.indent)
	}
	if _, _, ok := splitYAMLMapEntry(line.content); ok {
		return p.parseMapping(line.indent)
	}
	p.pos++
	if strings.HasPrefix(line.content, "{") || strings.HasPrefix(line.content, "[") {
		text := p.collectFlowText(line.content)
		val, _, err := p.parseFlowValue(text)
		return val, err
	}
	return p.parseScalarOrAlias(line.content)
}

func (p *yamlParser) collectFlowText(first string) string {
	var sb strings.Builder
	sb.WriteString(first)
	balance := flowBracketBalance(first)
	for balance > 0 && p.pos < len(p.lines) {
		next := p.lines[p.pos].content
		p.pos++
		sb.WriteByte(' ')
		sb.WriteString(next)
		balance += flowBracketBalance(next)
	}
	return sb.String()
}

func flowBracketBalance(s string) int {
	bal := 0
	var inSingle, inDouble, escaped bool
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
				} else {
					inSingle = false
				}
			}
			continue
		}
		if inDouble {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '{', '[':
			bal++
		case '}', ']':
			bal--
		}
	}
	return bal
}

func (p *yamlParser) parseSequence(seqIndent int) ([]any, error) {
	var out []any
	for p.pos < len(p.lines) {
		p.skipBlank()
		if p.pos >= len(p.lines) {
			break
		}
		line := p.lines[p.pos]
		if line.content == "---" || line.content == "..." || line.indent < seqIndent {
			break
		}
		if line.indent != seqIndent || (line.content != "-" && !strings.HasPrefix(line.content, "- ")) {
			break
		}
		after := ""
		if len(line.content) > 1 {
			after = strings.TrimSpace(line.content[1:])
		}
		anchorName := ""
		if strings.HasPrefix(after, "&") {
			anchorName, after = extractYAMLAnchor(after)
		}
		p.pos++
		var item any
		var err error
		if after == "" {
			p.skipBlank()
			if p.pos < len(p.lines) && p.lines[p.pos].indent > seqIndent {
				item, err = p.parseBlock(seqIndent + 1)
			}
		} else if after == "|" || after == "|-" || after == ">" || after == ">-" {
			item = p.parseMultilineScalar(seqIndent+1, after)
		} else if strings.HasPrefix(after, "{") || strings.HasPrefix(after, "[") {
			text := p.collectFlowText(after)
			item, _, err = p.parseFlowValue(text)
		} else if k, vStr, ok := splitYAMLMapEntry(after); ok {
			itemIndent := seqIndent + 2
			firstVal, e := p.parseEntryValue(vStr, itemIndent)
			if e != nil {
				return nil, e
			}
			m := map[string]any{}
			var merges []any
			if k == "<<" {
				merges = append(merges, firstVal)
			} else {
				m[k] = firstVal
			}
			rest, e := p.parseMappingInto(itemIndent, m, &merges)
			if e != nil {
				return nil, e
			}
			applyYAMLMerges(rest, merges)
			item = rest
		} else if after == "-" || strings.HasPrefix(after, "- ") {
			item = []any{}
		} else {
			item, err = p.parseScalarOrAlias(after)
		}
		if err != nil {
			return nil, err
		}
		if anchorName != "" {
			p.anchors[anchorName] = deepCloneYAML(item)
		}
		out = append(out, item)
	}
	return out, nil
}

func (p *yamlParser) parseMapping(mapIndent int) (map[string]any, error) {
	m := map[string]any{}
	var merges []any
	res, err := p.parseMappingInto(mapIndent, m, &merges)
	if err != nil {
		return nil, err
	}
	applyYAMLMerges(res, merges)
	return res, nil
}

func (p *yamlParser) parseMappingInto(mapIndent int, m map[string]any, merges *[]any) (map[string]any, error) {
	for p.pos < len(p.lines) {
		p.skipBlank()
		if p.pos >= len(p.lines) {
			break
		}
		line := p.lines[p.pos]
		if line.content == "---" || line.content == "..." || line.indent < mapIndent {
			break
		}
		if line.indent > mapIndent {
			break
		}
		if line.content == "-" || strings.HasPrefix(line.content, "- ") {
			break
		}
		k, vStr, ok := splitYAMLMapEntry(line.content)
		if !ok {
			break
		}
		p.pos++
		val, err := p.parseEntryValue(vStr, mapIndent)
		if err != nil {
			return nil, err
		}
		if k == "<<" {
			*merges = append(*merges, val)
		} else {
			m[k] = val
		}
	}
	return m, nil
}

func (p *yamlParser) parseEntryValue(vStr string, parentIndent int) (any, error) {
	vStr = strings.TrimSpace(vStr)
	anchorName := ""
	if strings.HasPrefix(vStr, "&") {
		anchorName, vStr = extractYAMLAnchor(vStr)
	}
	vStr = stripYAMLTag(vStr)
	var val any
	var err error
	if vStr == "" {
		p.skipBlank()
		if p.pos < len(p.lines) {
			next := p.lines[p.pos]
			if next.indent > parentIndent || (next.indent == parentIndent && (next.content == "-" || strings.HasPrefix(next.content, "- "))) {
				val, err = p.parseBlock(next.indent)
			}
		}
	} else if vStr == "|" || vStr == "|-" || vStr == "|+" || vStr == ">" || vStr == ">-" || vStr == ">+" {
		val = p.parseMultilineScalar(parentIndent+1, vStr)
	} else if strings.HasPrefix(vStr, "{") || strings.HasPrefix(vStr, "[") {
		text := p.collectFlowText(vStr)
		val, _, err = p.parseFlowValue(text)
	} else {
		val, err = p.parseScalarOrAlias(vStr)
	}
	if err != nil {
		return nil, err
	}
	if anchorName != "" {
		p.anchors[anchorName] = deepCloneYAML(val)
	}
	return val, nil
}

func (p *yamlParser) parseMultilineScalar(minIndent int, header string) string {
	folded := strings.HasPrefix(header, ">")
	chompStrip := strings.HasSuffix(header, "-")
	var blockLines []string
	blockIndent := -1
	for p.pos < len(p.lines) {
		rawLine := p.lines[p.pos].raw
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" {
			blockLines = append(blockLines, "")
			p.pos++
			continue
		}
		ind := 0
		for ind < len(rawLine) && rawLine[ind] == ' ' {
			ind++
		}
		if blockIndent == -1 {
			if ind < minIndent {
				break
			}
			blockIndent = ind
		} else if ind < blockIndent {
			break
		}
		if len(rawLine) >= blockIndent {
			blockLines = append(blockLines, rawLine[blockIndent:])
		} else {
			blockLines = append(blockLines, "")
		}
		p.pos++
	}
	for len(blockLines) > 0 && blockLines[len(blockLines)-1] == "" {
		blockLines = blockLines[:len(blockLines)-1]
	}
	sep := "\n"
	if folded {
		sep = " "
	}
	out := strings.Join(blockLines, sep)
	if !chompStrip && out != "" {
		out += "\n"
	}
	return out
}

func extractYAMLAnchor(s string) (string, string) {
	if !strings.HasPrefix(s, "&") {
		return "", s
	}
	i := 1
	for i < len(s) && s[i] != ' ' && s[i] != '\t' {
		i++
	}
	return s[1:i], strings.TrimSpace(s[i:])
}

func stripYAMLTag(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "!") {
		if idx := strings.IndexAny(s, " \t"); idx >= 0 {
			return strings.TrimSpace(s[idx+1:])
		}
	}
	return s
}

func splitYAMLMapEntry(s string) (key string, val string, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "-" || strings.HasPrefix(s, "- ") || strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") {
		return "", "", false
	}
	var inSingle, inDouble, escaped bool
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
				} else {
					inSingle = false
				}
			}
			continue
		}
		if inDouble {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			if i == 0 {
				inSingle = true
			}
		case '"':
			if i == 0 {
				inDouble = true
			}
		case ':':
			if i+1 == len(s) || s[i+1] == ' ' || s[i+1] == '\t' {
				kRaw := strings.TrimSpace(s[:i])
				vRaw := ""
				if i+1 < len(s) {
					vRaw = strings.TrimSpace(s[i+1:])
				}
				return unquoteYAMLScalar(kRaw), vRaw, true
			}
		}
	}
	return "", "", false
}

func (p *yamlParser) parseScalarOrAlias(s string) (any, error) {
	s = stripYAMLTag(strings.TrimSpace(s))
	if strings.HasPrefix(s, "*") {
		name := strings.TrimSpace(s[1:])
		if ref, ok := p.anchors[name]; ok {
			return deepCloneYAML(ref), nil
		}
		return nil, nil
	}
	return parseYAMLScalarToken(s), nil
}

func parseYAMLScalarToken(s string) any {
	s = strings.TrimSpace(s)
	if s == "" || s == "~" || strings.EqualFold(s, "null") {
		return nil
	}
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var out string
		if json.Unmarshal([]byte(s), &out) == nil {
			return out
		}
		return s[1 : len(s)-1]
	}
	switch strings.ToLower(s) {
	case "true":
		return true
	case "false":
		return false
	}
	if !strings.ContainsAny(s, ".eE") {
		if iv, err := strconv.ParseInt(s, 10, 64); err == nil {
			return iv
		}
	}
	if strings.ContainsAny(s, ".eE") {
		if fv, err := strconv.ParseFloat(s, 64); err == nil {
			return fv
		}
	}
	return s
}

func unquoteYAMLScalar(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var out string
		if json.Unmarshal([]byte(s), &out) == nil {
			return out
		}
		return s[1 : len(s)-1]
	}
	return s
}

func (p *yamlParser) parseFlowValue(text string) (any, int, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, 0, nil
	}
	if text[0] == '{' {
		m := map[string]any{}
		var merges []any
		i := 1
		for i < len(text) {
			i = skipSpaces(text, i)
			if i >= len(text) {
				break
			}
			if text[i] == '}' {
				applyYAMLMerges(m, merges)
				return m, i + 1, nil
			}
			if text[i] == ',' {
				i++
				continue
			}
			key, nextIdx := readFlowTokenUntil(text, i, ":}")
			i = skipSpaces(text, nextIdx)
			if i >= len(text) || text[i] != ':' {
				break
			}
			i = skipSpaces(text, i+1)
			var val any
			var err error
			if i < len(text) && (text[i] == '{' || text[i] == '[') {
				sub, consumed, e := p.parseFlowValue(text[i:])
				if e != nil {
					return nil, i, e
				}
				val = sub
				i += consumed
			} else {
				rawVal, nextV := readFlowTokenUntil(text, i, ",}")
				val, err = p.parseScalarOrAlias(rawVal)
				if err != nil {
					return nil, i, err
				}
				i = nextV
			}
			k := unquoteYAMLScalar(key)
			if k == "<<" {
				merges = append(merges, val)
			} else {
				m[k] = val
			}
		}
		applyYAMLMerges(m, merges)
		return m, len(text), nil
	}
	if text[0] == '[' {
		var list []any
		i := 1
		for i < len(text) {
			i = skipSpaces(text, i)
			if i >= len(text) {
				break
			}
			if text[i] == ']' {
				return list, i + 1, nil
			}
			if text[i] == ',' {
				i++
				continue
			}
			if text[i] == '{' || text[i] == '[' {
				sub, consumed, err := p.parseFlowValue(text[i:])
				if err != nil {
					return nil, i, err
				}
				list = append(list, sub)
				i += consumed
			} else {
				rawVal, nextV := readFlowTokenUntil(text, i, ",]")
				val, err := p.parseScalarOrAlias(rawVal)
				if err != nil {
					return nil, i, err
				}
				list = append(list, val)
				i = nextV
			}
		}
		return list, len(text), nil
	}
	v, err := p.parseScalarOrAlias(text)
	return v, len(text), err
}

func skipSpaces(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n') {
		i++
	}
	return i
}

func readFlowTokenUntil(s string, start int, stopChars string) (string, int) {
	var inSingle, inDouble, escaped bool
	i := start
	for i < len(s) {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i += 2
					continue
				}
				inSingle = false
			}
			i++
			continue
		}
		if inDouble {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inDouble = false
			}
			i++
			continue
		}
		if c == '\'' {
			inSingle = true
			i++
			continue
		}
		if c == '"' {
			inDouble = true
			i++
			continue
		}
		if strings.IndexByte(stopChars, c) >= 0 {
			break
		}
		i++
	}
	return strings.TrimSpace(s[start:i]), i
}

func applyYAMLMerges(m map[string]any, merges []any) {
	for _, entry := range merges {
		switch x := entry.(type) {
		case map[string]any:
			for k, v := range x {
				if _, exists := m[k]; !exists {
					m[k] = deepCloneYAML(v)
				}
			}
		case []any:
			for _, sub := range x {
				if sm, ok := sub.(map[string]any); ok {
					for k, v := range sm {
						if _, exists := m[k]; !exists {
							m[k] = deepCloneYAML(v)
						}
					}
				}
			}
		}
	}
}

func deepCloneYAML(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = deepCloneYAML(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = deepCloneYAML(val)
		}
		return out
	default:
		return x
	}
}
