// Package codebuddy 读取 CodeBuddy 家族（codebuddy / codebuddycn /
// workbuddy / workbuddycn）在宿主 HOME 下的项目与会话。
//
// 家族四个成员共用同一份物理会话存储（runtime/codebuddy-family-session-store.js
// 在启动时把各地区根的 projects 归一到 .codebuddy），因此候选根按真实路径去重，
// 同一 projectDirName 出现在多个根时按 sessionId 合并（保留更新的那份）。
//
// 与 Node 的差异：Node 会合并 workbuddy.db 的 sessions 表（桌面端重命名与最后
// 活动），本包只读 JSONL 事实（custom-title / ai-title / 记录时间戳），不打开
// SQLite。
package codebuddy

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// metaMaxBytes 是读取会话头部（标题 / 项目路径 / 首条用户消息）的预算。
	// 实测首条记录最长约 41KB，给足余量即可，避免整文件扫描。
	metaMaxBytes = 512 * 1024
	// tailBytes 是读取最后活动时间的初始尾部窗口。
	tailBytes = 64 * 1024
	// tailMaxBytes 是尾部窗口的上限；仍无有效时间就退回文件 mtime。
	// Node 会一直扩到文件头，单个 98MB 的 JSONL 会因此整份重读；本包刻意收紧。
	tailMaxBytes = 1 << 20
	// titleMaxRunes 与 Node 的 compactCodebuddyTitle 一致：超过 120 字符截断。
	titleMaxRunes = 120
)

// Providers 是 CodeBuddy 家族的成员名单，顺序与 Node FAMILY_PROVIDERS 一致。
//
// 顺序只影响候选目录的读取优先级；家族成员共用同一份物理会话存储，
// 读取时会按真实路径去重。
func Providers() []string {
	return []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}
}

// Budget 控制一次扫描的条目预算与时限。
//
// 实现方通常是 HTTP 层的扫描器；预算或时限用尽时 Take 返回 false，
// OutOfTime 只报告时限，不消费预算。
type Budget interface {
	Take() bool
	OutOfTime() bool
}

// Session 是聚合前的一条会话。
type Session struct {
	ID             string
	Title          string
	UpdatedAt      int64
	Provider       string
	ProjectDirName string
}

// Project 是聚合前的一个项目。
type Project struct {
	ID       string
	Name     string
	Path     string
	Provider string
	Sessions []Session
}

// configDirByProvider 是每个成员的配置根（= 存储策略的 nativeRoot）。
var configDirByProvider = map[string]string{
	"codebuddy":   ".codebuddy",
	"codebuddycn": ".codebuddy-cn",
	"workbuddy":   ".workbuddy-ai",
	"workbuddycn": ".workbuddy",
}

// regionRootsByProvider 是同一地区共享会话历史的两个原生数据根。
var regionRootsByProvider = map[string][]string{
	"codebuddy":   {".codebuddy", ".workbuddy-ai"},
	"workbuddy":   {".workbuddy-ai", ".codebuddy"},
	"codebuddycn": {".codebuddy-cn", ".workbuddy"},
	"workbuddycn": {".workbuddy", ".codebuddy-cn"},
}

// familyConfigDirs 是家族全部配置根；规范存储 .codebuddy 排在最前。
var familyConfigDirs = []string{".codebuddy", ".codebuddy-cn", ".workbuddy-ai", ".workbuddy"}

// timestampedProjectDir 匹配 WorkBuddy 无项目任务使用的日期目录名。
var timestampedProjectDir = regexp.MustCompile("^\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$")

// systemReminderPattern 剥掉每轮注入的 <system-reminder> 前导块。
var systemReminderPattern = regexp.MustCompile("(?s)<system-reminder.*?</system-reminder>")

// userQueryPattern 解开 <user_query> 包裹。
var userQueryPattern = regexp.MustCompile("(?is)^\\s*<user_query>\\s*(.*?)\\s*</user_query>\\s*$")

// record 是会话 JSONL 里本包关心的字段。
type record struct {
	Type        string          `json:"type"`
	Cwd         string          `json:"cwd"`
	AiTitle     string          `json:"aiTitle"`
	CustomTitle string          `json:"customTitle"`
	Role        string          `json:"role"`
	Content     json.RawMessage `json:"content"`
	Timestamp   json.RawMessage `json:"timestamp"`
}

// sessionFacts 是从单个会话文件读到的事实。
type sessionFacts struct {
	projectPath   string
	customTitle   string
	aiTitle       string
	firstUserText string
	updatedAt     int64
}

// title 复刻 Node 的优先级：自定义标题 → AI 标题 → 首条用户消息。
func (facts sessionFacts) title() string {
	if facts.customTitle != "" {
		return facts.customTitle
	}
	if facts.aiTitle != "" {
		return facts.aiTitle
	}
	return facts.firstUserText
}

// ReadProjects 读取该 Provider 所属地区的全部项目与会话。
func ReadProjects(hostHome, provider string, budget Budget) []Project {
	projectsByDir := make(map[string]*Project)
	order := make([]string, 0, 16)

	for _, root := range projectsRoots(hostHome, provider) {
		if budget.OutOfTime() {
			break
		}
		for _, dirName := range subdirectories(budget, root) {
			if budget.OutOfTime() {
				break
			}
			if !safeChild(root, dirName) {
				continue
			}
			sessions, projectPath := readProjectDir(budget, filepath.Join(root, dirName), dirName, provider)
			if len(sessions) == 0 {
				continue
			}
			existing, exists := projectsByDir[dirName]
			if !exists {
				projectsByDir[dirName] = &Project{
					ID:       dirName,
					Path:     projectPath,
					Sessions: sessions,
					Provider: provider,
				}
				order = append(order, dirName)
				continue
			}
			if existing.Path == "" {
				existing.Path = projectPath
			}
			existing.Sessions = mergeSessions(existing.Sessions, sessions)
		}
	}

	projects := make([]Project, 0, len(order))
	for _, dirName := range order {
		project := projectsByDir[dirName]
		project.Path = normalizeProjectPath(project.Path)
		if project.Path == "" {
			project.Path = dirName
		}
		sort.SliceStable(project.Sessions, func(left, right int) bool {
			return project.Sessions[left].UpdatedAt > project.Sessions[right].UpdatedAt
		})
		project.Name = projectName(project.Path, dirName, project.Sessions)
		projects = append(projects, *project)
	}
	return projects
}

// projectsRoots 返回该 Provider 能看到的全部 <configDir>/projects。
//
// 顺序：自己的配置根 → 本地区另一支 → 家族其余成员；按真实路径去重，
// 避免家族归一后同一批会话被读两遍（Node 的 resolveCodebuddyProjectsRoots 同口径）。
func projectsRoots(hostHome, provider string) []string {
	dirNames := make([]string, 0, 4)
	seenDir := make(map[string]bool, 4)
	addDir := func(dirName string) {
		if dirName == "" || seenDir[dirName] {
			return
		}
		seenDir[dirName] = true
		dirNames = append(dirNames, dirName)
	}
	addDir(configDirByProvider[provider])
	for _, dirName := range regionRootsByProvider[provider] {
		addDir(dirName)
	}
	for _, dirName := range familyConfigDirs {
		addDir(dirName)
	}

	roots := make([]string, 0, len(dirNames))
	seenPhysical := make(map[string]bool, len(dirNames))
	for _, dirName := range dirNames {
		root := filepath.Join(hostHome, dirName, "projects")
		identity := root
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			identity = resolved
		}
		if seenPhysical[identity] {
			continue
		}
		seenPhysical[identity] = true
		roots = append(roots, root)
	}
	return roots
}

// readProjectDir 读取单个项目目录下的全部会话文件。
func readProjectDir(budget Budget, projectDir, dirName, provider string) ([]Session, string) {
	files := jsonlFiles(budget, projectDir)
	sessions := make([]Session, 0, len(files))
	projectPath := ""
	for _, filePath := range files {
		if budget.OutOfTime() {
			break
		}
		sessionID := strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
		if sessionID == "" {
			continue
		}
		facts := readSessionFacts(filePath)
		if projectPath == "" && facts.projectPath != "" {
			projectPath = facts.projectPath
		}
		title := compactTitle(facts.title())
		if title == "" {
			title = filepath.Base(projectPath)
			if projectPath == "" {
				title = filepath.Base(dirName)
			}
		}
		updatedAt := facts.updatedAt
		if updatedAt <= 0 {
			updatedAt = fileModifiedMillis(filePath)
		}
		sessions = append(sessions, Session{
			ID:             sessionID,
			Title:          title,
			UpdatedAt:      updatedAt,
			Provider:       provider,
			ProjectDirName: dirName,
		})
	}
	return sessions, projectPath
}

// mergeSessions 按 sessionId 合并多个根的会话，保留更新时间较新的一份。
func mergeSessions(existing, incoming []Session) []Session {
	merged := make(map[string]Session, len(existing)+len(incoming))
	for _, session := range existing {
		merged[session.ID] = session
	}
	for _, session := range incoming {
		previous, exists := merged[session.ID]
		if !exists || session.UpdatedAt > previous.UpdatedAt {
			merged[session.ID] = session
		}
	}
	sessions := make([]Session, 0, len(merged))
	for _, session := range merged {
		sessions = append(sessions, session)
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		return sessions[left].UpdatedAt > sessions[right].UpdatedAt
	})
	return sessions
}

// readSessionFacts 读取一个会话文件的标题 / 项目路径 / 最后活动时间。
//
// 只读头部窗口与尾部窗口：ai-title 通常写在文件开头，重命名追加在文件末尾，
// 最后一条记录的时间戳也只在尾部。整文件扫描在长会话上代价过高。
func readSessionFacts(sessionPath string) sessionFacts {
	facts := sessionFacts{}
	if content, err := readFileHead(sessionPath, metaMaxBytes); err == nil {
		for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
			entry, ok := parseRecord(line)
			if !ok {
				continue
			}
			facts.absorb(entry)
		}
	}

	info, err := os.Stat(sessionPath)
	if err != nil {
		return facts
	}
	tailTimestamp, customTitle, aiTitle := readTailFacts(sessionPath, info.Size())
	if tailTimestamp > 0 {
		facts.updatedAt = tailTimestamp
	}
	// 尾部的重命名记录比头部更新，覆盖头部读到的值。
	if customTitle != "" {
		facts.customTitle = customTitle
	}
	if aiTitle != "" {
		facts.aiTitle = aiTitle
	}
	return facts
}

// absorb 把一条记录并入事实集；空字段不覆盖已有值。
func (facts *sessionFacts) absorb(entry record) {
	if facts.projectPath == "" {
		facts.projectPath = trimSpace(entry.Cwd)
	}
	switch entry.Type {
	case "ai-title":
		if title := trimSpace(entry.AiTitle); title != "" {
			facts.aiTitle = title
		}
	case "custom-title":
		if title := trimSpace(entry.CustomTitle); title != "" {
			facts.customTitle = title
		}
	case "message":
		if facts.firstUserText == "" && entry.Role == "user" {
			facts.firstUserText = stripSystemReminder(collectBlockText(entry.Content))
		}
	}
}

// readTailFacts 从文件尾部窗口读取最后活动时间与重命名记录。
//
// 窗口从 64KB 开始，只有读不到有效时间时才扩大（上限 1MB）；扩到上限仍无时间
// 就返回 0，由调用方退回 mtime。窗口起点可能落在行中间，先丢掉第一段残行。
func readTailFacts(sessionPath string, size int64) (updatedAt int64, customTitle, aiTitle string) {
	windowBytes := int64(tailBytes)
	for {
		offset := size - windowBytes
		if offset < 0 {
			offset = 0
		}
		window := readFileSection(sessionPath, offset, size-offset)
		if offset > 0 {
			if index := bytes.IndexByte(window, '\n'); index >= 0 {
				window = window[index+1:]
			} else {
				window = nil
			}
		}
		for _, line := range strings.Split(strings.ReplaceAll(string(window), "\r\n", "\n"), "\n") {
			entry, ok := parseRecord(line)
			if !ok {
				continue
			}
			if timestamp := timestampMillis(entry.Timestamp); timestamp > 0 {
				updatedAt = timestamp
			}
			switch entry.Type {
			case "custom-title":
				if title := trimSpace(entry.CustomTitle); title != "" {
					customTitle = title
				}
			case "ai-title":
				if title := trimSpace(entry.AiTitle); title != "" {
					aiTitle = title
				}
			}
		}
		if updatedAt > 0 || offset == 0 || windowBytes >= tailMaxBytes {
			return updatedAt, customTitle, aiTitle
		}
		windowBytes *= 2
		if windowBytes > tailMaxBytes {
			windowBytes = tailMaxBytes
		}
	}
}

// readFileSection 读取 [offset, offset+length) 区间。
func readFileSection(filePath string, offset, length int64) []byte {
	if length <= 0 {
		return nil
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	section := io.NewSectionReader(file, offset, length)
	content, err := io.ReadAll(section)
	if err != nil && len(content) == 0 {
		return nil
	}
	return content
}

// parseRecord 解析一行 JSON；空行与坏行返回 ok=false。
func parseRecord(line string) (record, bool) {
	trimmed := trimSpace(line)
	if trimmed == "" || trimmed[0] != '{' {
		return record{}, false
	}
	var entry record
	if json.Unmarshal([]byte(trimmed), &entry) != nil {
		return record{}, false
	}
	return entry, true
}

// timestampMillis 兼容毫秒数字、数字字符串与 ISO 时间串。
func timestampMillis(raw json.RawMessage) int64 {
	text := trimSpace(string(raw))
	if text == "" || text == "null" {
		return 0
	}
	if raw[0] == '"' {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return 0
		}
		text = trimSpace(value)
	}
	if text == "" {
		return 0
	}
	if numeric, err := strconv.ParseFloat(text, 64); err == nil {
		if numeric > 0 {
			return int64(numeric)
		}
		return 0
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999Z07:00"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

// stripSystemReminder 剥掉系统提醒块并解开 <user_query> 包裹。
func stripSystemReminder(text string) string {
	cleaned := systemReminderPattern.ReplaceAllString(text, "")
	if match := userQueryPattern.FindStringSubmatch(cleaned); len(match) == 2 {
		cleaned = match[1]
	}
	return trimSpace(cleaned)
}

// collectBlockText 把 content（字符串或分片数组）拍平成文本。
func collectBlockText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return trimSpace(text)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type != "input_text" && block.Type != "output_text" && block.Type != "text" {
			continue
		}
		if block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return trimSpace(strings.Join(parts, "\n"))
}

// compactTitle 折叠空白并截到 120 字符（按 rune，避免切坏 UTF-8）。
func compactTitle(text string) string {
	normalized := compactWhitespace(text)
	if utf8.RuneCountInString(normalized) <= titleMaxRunes {
		return normalized
	}
	return string([]rune(normalized)[:titleMaxRunes-1]) + "…"
}

// projectName 复刻 Node：默认取项目目录名；WorkBuddy 的日期目录改用
// 最新会话标题，避免列表里出现一串时间戳。
func projectName(projectPath, projectDirName string, sessions []Session) string {
	name := filepath.Base(projectPath)
	if name == "." || name == "/" {
		name = filepath.Base(projectDirName)
	}
	if !timestampedProjectDir.MatchString(name) {
		return name
	}
	parent := filepath.Base(filepath.Dir(projectPath))
	if parent != "WorkBuddy" && parent != "WorkBuddy AI" {
		return name
	}
	if len(sessions) > 0 && sessions[0].Title != "" {
		return sessions[0].Title
	}
	return name
}

// subdirectories 返回 root 下的一级目录名；符号链接目录跳过。
func subdirectories(budget Budget, root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if budget.OutOfTime() {
			break
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		if !budget.Take() {
			break
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// jsonlFiles 返回 root 下的一级 .jsonl 文件（排序后）；符号链接与目录跳过。
func jsonlFiles(budget Budget, root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if budget.OutOfTime() {
			break
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		if !budget.Take() {
			break
		}
		files = append(files, filepath.Join(root, entry.Name()))
	}
	sort.Strings(files)
	return files
}

// safeChild 校验 root 下的 name 解析后仍落在 root 内（防御符号链接逃逸）。
func safeChild(root, name string) bool {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	resolvedChild, err := filepath.EvalSymlinks(filepath.Join(root, name))
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedChild)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

func trimSpace(value string) string {
	return strings.TrimSpace(value)
}

// compactWhitespace 等价于 JS 的 replace(/\s+/g, ' ').trim()。
func compactWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// normalizeProjectPath 等价于 Node 的 normalizeProjectPath：去空白并去掉尾部斜杠。
func normalizeProjectPath(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

// readFileHead 只读文件前 limit 字节。
func readFileHead(filePath string, limit int64) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil && len(content) == 0 {
		return "", err
	}
	return string(content), nil
}

// fileModifiedMillis 返回文件 mtime（毫秒）；读不到时为 0。
func fileModifiedMillis(filePath string) int64 {
	info, err := os.Stat(filePath)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}
