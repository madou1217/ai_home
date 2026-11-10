// Package codex 给 Codex 的全局 config.toml 打「默认账号落点」补丁。
//
// 只改两处受管内容：
//
//   - 顶层 model_provider = "<provider>"
//   - [model_providers.<provider>] 表里的 name/base_url/wire_api/env_key/重试次数
//
// 其余键、其它 model_providers 表、profiles、注释与行序都原样保留：用户常把
// 代理、feature 开关和 profiles 写在同一份文件里，整文件重排会吃掉这些配置。
package codex

import (
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

const (
	// DefaultProviderID 与 codex clilaunch 的受管 provider 身份一致。
	// Codex thread 元数据会持久记录 provider 名，不能另造第二套。
	DefaultProviderID = "aih_server"
	// DefaultLabel 是 config.toml 里展示的 provider 名称。
	DefaultLabel = "AIH Server"
	// DefaultEnvKey 承载 AIH Server 的 client key。
	DefaultEnvKey = "OPENAI_API_KEY"

	wireAPI = "responses"
)

var (
	// ErrBaseURLRequired 表示没有给出网关地址。
	ErrBaseURLRequired = errors.New("codex: base url 不能为空")
	// ErrInvalidBaseURL 表示地址不是 http(s) 绝对 URL。
	ErrInvalidBaseURL = errors.New("codex: base url 必须是 http(s) 绝对地址")
	// ErrInvalidProviderID 表示 provider id 不是合法的 TOML bare key。
	ErrInvalidProviderID = errors.New("codex: provider id 不是合法的 TOML bare key")
)

// Spec 描述要落到的网关 provider。零值字段使用 Default* 常量。
type Spec struct {
	ProviderID string
	Label      string
	BaseURL    string
	EnvKey     string
}

func (spec Spec) normalized() (Spec, error) {
	if spec.ProviderID == "" {
		spec.ProviderID = DefaultProviderID
	}
	if spec.Label == "" {
		spec.Label = DefaultLabel
	}
	if spec.EnvKey == "" {
		spec.EnvKey = DefaultEnvKey
	}
	spec.BaseURL = strings.TrimSpace(spec.BaseURL)
	if spec.BaseURL == "" {
		return Spec{}, ErrBaseURLRequired
	}
	parsed, err := url.Parse(spec.BaseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return Spec{}, ErrInvalidBaseURL
	}
	if !isBareKey(spec.ProviderID) {
		return Spec{}, ErrInvalidProviderID
	}
	return spec, nil
}

// isBareKey 接受 TOML bare key（字母/数字/下划线/连字符）。
func isBareKey(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

type entry struct {
	key   string
	value string
}

func managedEntries(spec Spec) []entry {
	return []entry{
		{"name", strconv.Quote(spec.Label)},
		{"base_url", strconv.Quote(spec.BaseURL)},
		{"wire_api", strconv.Quote(wireAPI)},
		{"env_key", strconv.Quote(spec.EnvKey)},
		{"request_max_retries", "0"},
		{"stream_max_retries", "0"},
	}
}

// Patch 返回打过落点补丁的新文件内容。current 里的其它内容（含注释、空行、
// CRLF、缺失的行尾换行）保持不变；同一份输入重复 Patch 结果一致。
func Patch(current string, spec Spec) (string, error) {
	prepared, err := spec.normalized()
	if err != nil {
		return "", err
	}
	doc := parseDocument(current)
	doc.lines = patchModelProvider(doc.lines, prepared)
	doc.lines = patchProviderTable(doc.lines, prepared)
	return doc.render(), nil
}

func patchModelProvider(lines []string, spec Spec) []string {
	sections, starts := scanSections(lines)
	root := sections[0]
	assignment := "model_provider = " + strconv.Quote(spec.ProviderID)
	for i := root.start; i < root.end; i++ {
		if starts[i] != stateNone {
			continue
		}
		if key, ok := assignmentKey(lines[i]); !ok || key != "model_provider" {
			continue
		}
		return applyEdits(lines, []edit{{
			at:     i,
			remove: 1,
			insert: []string{indentOf(lines[i]) + assignment},
		}})
	}
	at := leadingCommentEnd(lines)
	block := []string{assignment}
	if at < len(lines) {
		if _, isHeader := parseHeader(lines[at]); isHeader {
			block = append(block, "")
		}
	}
	return applyEdits(lines, []edit{{at: at, insert: block}})
}

func patchProviderTable(lines []string, spec Spec) []string {
	sections, starts := scanSections(lines)
	entries := managedEntries(spec)
	target := -1
	for i, section := range sections {
		if len(section.path) == 2 && section.path[0] == "model_providers" && section.path[1] == spec.ProviderID {
			target = i
			break
		}
	}
	if target < 0 {
		block := make([]string, 0, len(entries)+2)
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			block = append(block, "")
		}
		block = append(block, "[model_providers."+spec.ProviderID+"]")
		for _, item := range entries {
			block = append(block, item.key+" = "+item.value)
		}
		return applyEdits(lines, []edit{{at: len(lines), insert: block}})
	}

	section := sections[target]
	pending := append([]entry(nil), entries...)
	edits := make([]edit, 0, len(entries)+1)
	for i := section.start; i < section.end; i++ {
		if starts[i] != stateNone {
			continue
		}
		key, ok := assignmentKey(lines[i])
		if !ok {
			continue
		}
		index := indexOfEntry(pending, key)
		if index < 0 {
			continue
		}
		edits = append(edits, edit{
			at:     i,
			remove: 1,
			insert: []string{indentOf(lines[i]) + pending[index].key + " = " + pending[index].value},
		})
		pending = append(pending[:index], pending[index+1:]...)
	}
	if len(pending) > 0 {
		at := section.end
		for at > section.start && strings.TrimSpace(lines[at-1]) == "" {
			at--
		}
		block := make([]string, 0, len(pending))
		for _, item := range pending {
			block = append(block, item.key+" = "+item.value)
		}
		edits = append(edits, edit{at: at, insert: block})
	}
	if len(edits) == 0 {
		return lines
	}
	return applyEdits(lines, edits)
}

func indexOfEntry(entries []entry, key string) int {
	for i, item := range entries {
		if item.key == key {
			return i
		}
	}
	return -1
}

// leadingCommentEnd 跳过开头的注释/空行，让文件头注释保持在最前面。
func leadingCommentEnd(lines []string) int {
	at := 0
	for at < len(lines) {
		trimmed := strings.TrimSpace(lines[at])
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			at++
			continue
		}
		break
	}
	return at
}

func indentOf(line string) string {
	for i := 0; i < len(line); i++ {
		if line[i] != ' ' && line[i] != '\t' {
			return line[:i]
		}
	}
	return ""
}

type edit struct {
	at     int
	remove int
	insert []string
}

func applyEdits(lines []string, edits []edit) []string {
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].at > edits[j].at })
	for _, item := range edits {
		next := make([]string, 0, len(lines)-item.remove+len(item.insert))
		next = append(next, lines[:item.at]...)
		next = append(next, item.insert...)
		next = append(next, lines[item.at+item.remove:]...)
		lines = next
	}
	return lines
}

type document struct {
	lines    []string
	eol      string
	trailing bool
	bom      bool
}

func parseDocument(content string) document {
	doc := document{eol: "\n"}
	if strings.HasPrefix(content, "\ufeff") {
		doc.bom = true
		content = strings.TrimPrefix(content, "\ufeff")
	}
	if content == "" {
		doc.trailing = true
		return doc
	}
	crlf := strings.Contains(content, "\r\n")
	if crlf {
		doc.eol = "\r\n"
	}
	doc.trailing = strings.HasSuffix(content, "\n")
	body := content
	if doc.trailing {
		body = body[:len(body)-1]
	}
	doc.lines = strings.Split(body, "\n")
	if crlf {
		for i := range doc.lines {
			doc.lines[i] = strings.TrimSuffix(doc.lines[i], "\r")
		}
	}
	return doc
}

func (doc document) render() string {
	out := strings.Join(doc.lines, doc.eol)
	if doc.trailing && len(doc.lines) > 0 {
		out += doc.eol
	}
	if doc.bom {
		out = "\ufeff" + out
	}
	return out
}

type section struct {
	path   []string
	header int
	start  int
	end    int
}

func scanSections(lines []string) ([]section, []stringState) {
	starts := make([]stringState, len(lines))
	state := stateNone
	for i, line := range lines {
		starts[i] = state
		state = advanceStringState(line, state)
	}
	sections := []section{{header: -1, start: 0, end: len(lines)}}
	for i, line := range lines {
		if starts[i] != stateNone {
			continue
		}
		path, ok := parseHeader(line)
		if !ok {
			continue
		}
		sections[len(sections)-1].end = i
		sections = append(sections, section{path: path, header: i, start: i + 1})
	}
	sections[len(sections)-1].end = len(lines)
	return sections, starts
}

// parseHeader 只认单表头 [a.b]，数组表 [[...]] 不是受管目标。
func parseHeader(line string) ([]string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "[[") {
		return nil, false
	}
	end := strings.Index(trimmed, "]")
	if end < 0 {
		return nil, false
	}
	return splitDotted(strings.TrimSpace(trimmed[1:end]))
}

func splitDotted(value string) ([]string, bool) {
	var parts []string
	var current strings.Builder
	var quote byte
	for i := 0; i < len(value); i++ {
		c := value[i]
		if quote != 0 {
			if quote == '"' && c == '\\' && i+1 < len(value) {
				current.WriteByte(value[i+1])
				i++
				continue
			}
			if c == quote {
				quote = 0
				continue
			}
			current.WriteByte(c)
			continue
		}
		switch c {
		case '"', '\'':
			quote = c
		case '.':
			part := strings.TrimSpace(current.String())
			if part == "" {
				return nil, false
			}
			parts = append(parts, part)
			current.Reset()
		default:
			current.WriteByte(c)
		}
	}
	if quote != 0 {
		return nil, false
	}
	part := strings.TrimSpace(current.String())
	if part == "" {
		return nil, false
	}
	return append(parts, part), true
}

// assignmentKey 返回顶层/表内单个赋值语句的键；dotted key 不算受管键。
func assignmentKey(line string) (string, bool) {
	index := indexOfEquals(line)
	if index < 0 {
		return "", false
	}
	raw := strings.TrimSpace(line[:index])
	if raw == "" || strings.HasPrefix(raw, "#") {
		return "", false
	}
	if strings.HasPrefix(raw, "\"") || strings.HasPrefix(raw, "'") {
		parts, ok := splitDotted(raw)
		if !ok || len(parts) != 1 {
			return "", false
		}
		return parts[0], true
	}
	if strings.ContainsAny(raw, ". \t") {
		return "", false
	}
	return raw, true
}

func indexOfEquals(line string) int {
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
			return -1
		case '=':
			return i
		}
	}
	return -1
}

type stringState int

const (
	stateNone stringState = iota
	stateBasic
	stateLiteral
)

// advanceStringState 跟踪多行字符串，避免把字符串里的 [table] 当成表头。
func advanceStringState(line string, state stringState) stringState {
	for i := 0; i < len(line); {
		if state == stateNone {
			switch line[i] {
			case '#':
				return stateNone
			case '"':
				if strings.HasPrefix(line[i:], "\"\"\"") {
					state = stateBasic
					i += 3
					continue
				}
				i++
				for i < len(line) {
					if line[i] == '\\' {
						i += 2
						continue
					}
					if line[i] == '"' {
						i++
						break
					}
					i++
				}
			case '\'':
				if strings.HasPrefix(line[i:], "'''") {
					state = stateLiteral
					i += 3
					continue
				}
				i++
				for i < len(line) && line[i] != '\'' {
					i++
				}
				if i < len(line) {
					i++
				}
			default:
				i++
			}
			continue
		}
		if state == stateBasic {
			if strings.HasPrefix(line[i:], "\"\"\"") {
				state = stateNone
				i += 3
				continue
			}
			i++
			continue
		}
		if strings.HasPrefix(line[i:], "'''") {
			state = stateNone
			i += 3
			continue
		}
		i++
	}
	return state
}
