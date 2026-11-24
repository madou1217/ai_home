package codexenvironments

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 受管块标记：合并时只替换这一段，块内由 AIH 全权维护。
const (
	managedBegin = "# >>> aih managed environments (do not edit inside this block)"
	managedEnd   = "# <<< aih managed environments"
)

// environments.toml 的顶层键是封闭集合：Codex 遇到其它任何顶层键都会直接拒载
// （"unknown field `x`, expected one of `default`, `include_local`, `environments`"）。
const (
	rootKeyDefault      = "default"
	rootKeyIncludeLocal = "include_local"
	rootKeyEnvironments = "environments"
)

var (
	managedBlockPattern = regexp.MustCompile(`(?s)` + regexp.QuoteMeta(managedBegin) + `.*?` + regexp.QuoteMeta(managedEnd) + "\n?")
	entryIDPattern      = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

// MergeResult 是一次合并的结果与可观测量。
type MergeResult struct {
	Config string
	// Changed 为 false 时调用方不应写盘。
	Changed bool
	// DefaultKept 非空表示 default 仍指向用户自己的环境。
	DefaultKept string
	// DroppedRootKeys 是被剥离的非法顶层键：Codex 会因此拒载整份文件，
	// 所以必须在合并时移除，并让调用方把这件事告诉用户。
	DroppedRootKeys []string
}

// Merge 把受管条目并入既有 environments.toml 文本，产出 Codex 一定能解析的文件。
//
// 行为约定：
//   - 顶层只保留 default / include_local / environments 三个键，标量写在表之前；
//   - 受管条目独占一个标记块；用户自己的 [[environments]] 原样保留；
//   - 用户的 default 指向自己的环境时保持不变；缺失或指向已消失的受管条目时，
//     落到第一个受管条目；
//   - 用户写了与受管同 id 的条目时，用户那条会被移除（Codex 不接受重复 id），
//     这件事通过 MergeResult 暴露，不做静默处理。
func Merge(existing string, entries []Entry, includeLocal bool) MergeResult {
	cleaned := stripManagedBlock(existing)
	// 必须在剥离 default 之前读取用户的默认环境，否则永远读不到。
	userDefault := parseRootString(cleaned, rootKeyDefault)

	parsed := parseDocument(cleaned)
	kept := dedupeEntries(entries)
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].ID < kept[j].ID })

	managedIDs := make(map[string]struct{}, len(kept))
	for _, entry := range kept {
		managedIDs[entry.ID] = struct{}{}
	}

	// 用户区只保留合法顶层标量与 [[environments]] 表；
	// 其它表（如 [tui]）连同表体整体丢弃，否则表体会被当成顶层键，Codex 拒载整份文件。
	var userScalars []string
	sections := make([]userSection, 0, len(parsed.sections))
	for _, section := range parsed.sections {
		if section.isEnvironments {
			if _, clash := managedIDs[section.id]; clash {
				continue
			}
			sections = append(sections, section)
		}
	}
	dropped := append([]string{}, parsed.droppedKeys...)
	conflicts := []string{}
	for _, entry := range kept {
		for _, section := range parsed.sections {
			if section.isEnvironments && section.id == entry.ID {
				conflicts = appendUnique(conflicts, entry.ID)
			}
		}
	}

	// default 必须指向真实存在的环境：用户的默认值只在它仍有对应条目时保留，
	// 否则 Codex 的默认环境会指向一个不存在的 id。
	defaultID := userDefault
	if defaultID == "" || !hasEnvironment(defaultID, kept, sections) {
		defaultID = firstEntryID(kept)
		if defaultID == "" {
			defaultID = firstUserEnvironmentID(sections)
		}
	}

	var builder strings.Builder
	if defaultID != "" {
		builder.WriteString(rootKeyDefault + " = " + quoteTOML(defaultID) + "\n")
	}
	builder.WriteString(rootKeyIncludeLocal + " = " + strconv.FormatBool(includeLocal) + "\n")
	for _, line := range userScalars {
		builder.WriteString(line)
		builder.WriteString("\n")
	}
	for _, section := range sections {
		builder.WriteString("\n")
		// 表体尾部的空行必须剥掉：留着会在每次合并后累积，破坏幂等。
		builder.WriteString(strings.TrimRight(strings.Join(section.lines, "\n"), "\n"))
		builder.WriteString("\n")
	}
	if block := renderManagedBlock(kept); block != "" {
		builder.WriteString("\n")
		builder.WriteString(block)
	}

	config := normalizeTrailingNewline(builder.String())
	// DefaultKept 只在用户的默认环境确实保留下来时才有意义。
	keptDefault := ""
	if userDefault != "" && defaultID == userDefault {
		keptDefault = userDefault
	}
	return MergeResult{
		Config:          config,
		Changed:         config != existing,
		DefaultKept:     keptDefault,
		DroppedRootKeys: appendKeys(dropped, conflicts),
	}
}

// userSection 是用户区里的一张 [[environments]] 表。
type userSection struct {
	lines          []string
	isEnvironments bool
	id             string
}

// parsedDocument 是 environments.toml 的结构化视图。
type parsedDocument struct {
	// scalars 是顶层标量行（已剔除 default / include_local）。
	scalars []string
	// sections 是所有表（[[environments]] 与其它表），其它表整体标记为不收留。
	sections []userSection
	// droppedKeys 是被丢弃的顶层键与表名，供调用方如实上报。
	droppedKeys []string
}

// parseDocument 把文本切成「顶层标量」与「表」两类，并识别非法顶层键。
//
// TOML 语义：第一个表头之后的一切都属于某张表，因此顶层标量必须严格取
// 表头之前的部分；把表体漏到顶层会写出 Codex 无法解析的文件。
func parseDocument(text string) parsedDocument {
	doc := parsedDocument{}
	lines := strings.Split(text, "\n")
	current := userSection{}
	inSection := false
	flush := func() {
		if inSection {
			doc.sections = append(doc.sections, current)
			current = userSection{}
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[[") && strings.HasSuffix(trimmed, "]]") {
			flush()
			inSection = true
			name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, "[["), "]]"))
			current = userSection{lines: []string{line}, isEnvironments: name == rootKeyEnvironments}
			if !current.isEnvironments {
				doc.droppedKeys = appendUnique(doc.droppedKeys, name)
			}
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			flush()
			inSection = true
			name := strings.TrimSpace(strings.Trim(line, "[]"))
			current = userSection{lines: []string{line}}
			doc.droppedKeys = appendUnique(doc.droppedKeys, name)
			continue
		}
		if inSection {
			current.lines = append(current.lines, line)
			if current.isEnvironments && current.id == "" && strings.HasPrefix(trimmed, "id") {
				if name, value, ok := splitAssignment(trimmed); ok && name == "id" {
					current.id = unquoteTOML(value)
				}
			}
			continue
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			doc.scalars = append(doc.scalars, line)
			continue
		}
		name, _, ok := splitAssignment(trimmed)
		if !ok {
			// 不是合法赋值：原样保留（多半是注释风格的说明），交给 Codex 判定。
			doc.scalars = append(doc.scalars, line)
			continue
		}
		switch name {
		case rootKeyDefault, rootKeyIncludeLocal:
			// 这两个由 AIH 统一重建，丢弃原行。
			continue
		default:
			doc.droppedKeys = appendUnique(doc.droppedKeys, name)
		}
	}
	flush()
	return doc
}

// hasEnvironment 判断 id 是否对应一条受管条目或用户自己的 [[environments]]。
func hasEnvironment(id string, managed []Entry, sections []userSection) bool {
	for _, entry := range managed {
		if entry.ID == id {
			return true
		}
	}
	for _, section := range sections {
		if section.isEnvironments && section.id == id {
			return true
		}
	}
	return false
}

func firstUserEnvironmentID(sections []userSection) string {
	for _, section := range sections {
		if section.isEnvironments && section.id != "" {
			return section.id
		}
	}
	return ""
}

func appendKeys(keys []string, extra []string) []string {
	if len(extra) == 0 {
		return keys
	}
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		seen[key] = struct{}{}
	}
	for _, key := range extra {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	return keys
}

func dedupeEntries(entries []Entry) []Entry {
	kept := make([]Entry, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		id := strings.TrimSpace(entry.ID)
		if id == "" || !entryIDPattern.MatchString(id) {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		entry.ID = id
		kept = append(kept, entry)
	}
	return kept
}

func stripManagedBlock(text string) string {
	return managedBlockPattern.ReplaceAllString(text, "")
}

func appendUnique(values []string, value string) []string {
	if value == "" {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func firstEntryID(entries []Entry) string {
	if len(entries) == 0 {
		return ""
	}
	return entries[0].ID
}

// parseUserEntryIDs 收集用户区里所有 [[environments]] 的 id。
func parseUserEntryIDs(text string) map[string]struct{} {
	ids := make(map[string]struct{})
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		name, value, ok := splitAssignment(trimmed)
		if !ok || name != "id" {
			continue
		}
		if id := unquoteTOML(value); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids
}

func parseRootString(text, key string) string {
	seenHeader := false
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			seenHeader = true
		}
		if seenHeader || trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		name, value, ok := splitAssignment(trimmed)
		if !ok || name != key {
			continue
		}
		return unquoteTOML(value)
	}
	return ""
}

func splitAssignment(line string) (string, string, bool) {
	idx := strings.Index(line, "=")
	if idx <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(line[:idx])
	if key == "" || strings.ContainsAny(key, " \t\"'") {
		return "", "", false
	}
	return key, strings.TrimSpace(line[idx+1:]), true
}

func unquoteTOML(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 && (trimmed[0] == '"' || trimmed[0] == '\'') && trimmed[len(trimmed)-1] == trimmed[0] {
		return trimmed[1 : len(trimmed)-1]
	}
	return ""
}

func normalizeTrailingNewline(text string) string {
	trimmed := strings.TrimRight(text, "\n")
	if trimmed == "" {
		return ""
	}
	return trimmed + "\n"
}

func renderManagedBlock(entries []Entry) string {
	if len(entries) == 0 {
		return ""
	}
	var builder strings.Builder
	builder.WriteString(managedBegin)
	builder.WriteString("\n")
	for _, entry := range entries {
		builder.WriteString("\n[[environments]]\n")
		writeStringField(&builder, "id", entry.ID)
		if url := strings.TrimSpace(entry.URL); url != "" {
			writeStringField(&builder, "url", url)
			if token := strings.TrimSpace(entry.AuthBearerToken); token != "" {
				writeStringField(&builder, "auth_bearer_token", token)
			}
		} else if program := strings.TrimSpace(entry.Program); program != "" {
			writeStringField(&builder, "program", program)
		}
		if len(entry.Args) > 0 {
			builder.WriteString("args = [")
			for i, arg := range entry.Args {
				if i > 0 {
					builder.WriteString(", ")
				}
				builder.WriteString(quoteTOML(arg))
			}
			builder.WriteString("]\n")
		}
		if cwd := strings.TrimSpace(entry.Cwd); cwd != "" {
			writeStringField(&builder, "cwd", cwd)
		}
		if len(entry.Env) > 0 {
			keys := make([]string, 0, len(entry.Env))
			for key := range entry.Env {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			builder.WriteString("env = { ")
			for i, key := range keys {
				if i > 0 {
					builder.WriteString(", ")
				}
				builder.WriteString(quoteTOML(key))
				builder.WriteString(" = ")
				builder.WriteString(quoteTOML(entry.Env[key]))
			}
			builder.WriteString(" }\n")
		}
		// connect_timeout_sec 只在 url 模式下合法；与 program 同用会被 Codex 拒载。
		if entry.ConnectTimeoutSec > 0 && strings.TrimSpace(entry.URL) != "" {
			builder.WriteString("connect_timeout_sec = ")
			builder.WriteString(strconv.Itoa(entry.ConnectTimeoutSec))
			builder.WriteString("\n")
		}
		if entry.InitializeTimeoutSec > 0 {
			builder.WriteString("initialize_timeout_sec = ")
			builder.WriteString(strconv.Itoa(entry.InitializeTimeoutSec))
			builder.WriteString("\n")
		}
	}
	builder.WriteString(managedEnd)
	builder.WriteString("\n")
	return builder.String()
}

func writeStringField(builder *strings.Builder, key, value string) {
	builder.WriteString(key)
	builder.WriteString(" = ")
	builder.WriteString(quoteTOML(value))
	builder.WriteString("\n")
}

// quoteTOML 产出 TOML basic string；控制字符一律转义，避免写出无法解析的文件。
func quoteTOML(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if r < 0x20 || r == utf8.RuneError {
				builder.WriteString(`\u`)
				builder.WriteString(padHex(int(r)))
				continue
			}
			builder.WriteRune(r)
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

func padHex(value int) string {
	const hexDigits = "0123456789ABCDEF"
	digits := make([]byte, 4)
	for i := 3; i >= 0; i-- {
		digits[i] = hexDigits[value&0xF]
		value >>= 4
	}
	return string(digits)
}
