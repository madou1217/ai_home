package webuisessionslistapi

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
	// codebuddyMetaMaxBytes 是读取会话头部（标题 / 项目路径 / 首条用户消息）的预算。
	// 实测首条记录最长约 41KB，给足余量即可，避免整文件扫描。
	codebuddyMetaMaxBytes = 512 * 1024
	// codebuddyTailBytes 是读取最后活动时间的初始尾部窗口。
	codebuddyTailBytes = 64 * 1024
	// codebuddyTailMaxBytes 是尾部窗口的上限；仍无有效时间就退回文件 mtime。
	// Node 会一直扩到文件头，单个 98MB 的 JSONL 会因此整份重读；本切片刻意收紧。
	codebuddyTailMaxBytes = 1 << 20
	// codebuddyTitleMaxRunes 与 Node 的 compactCodebuddyTitle 一致：超过 120 字符截断。
	codebuddyTitleMaxRunes = 120
)

// codebuddyConfigDirByProvider 是每个成员的配置根（= 存储策略的 nativeRoot）。
var codebuddyConfigDirByProvider = map[string]string{
	"codebuddy":   ".codebuddy",
	"codebuddycn": ".codebuddy-cn",
	"workbuddy":   ".workbuddy-ai",
	"workbuddycn": ".workbuddy",
}

// codebuddyRegionRootsByProvider 是同一地区共享会话历史的两个原生数据根。
var codebuddyRegionRootsByProvider = map[string][]string{
	"codebuddy":   {".codebuddy", ".workbuddy-ai"},
	"workbuddy":   {".workbuddy-ai", ".codebuddy"},
	"codebuddycn": {".codebuddy-cn", ".workbuddy"},
	"workbuddycn": {".workbuddy", ".codebuddy-cn"},
}

// codebuddyFamilyConfigDirs 是家族全部配置根；规范存储 .codebuddy 排在最前。
var codebuddyFamilyConfigDirs = []string{".codebuddy", ".codebuddy-cn", ".workbuddy-ai", ".workbuddy"}

// codebuddyTimestampedProjectDir 匹配 WorkBuddy 无项目任务使用的日期目录名。
var codebuddyTimestampedProjectDir = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$`)

// codebuddySystemReminderPattern 剥掉每轮注入的 <system-reminder> 前导块。
var codebuddySystemReminderPattern = regexp.MustCompile(`(?s)<system-reminder.*?</system-reminder>`)

// codebuddyUserQueryPattern 解开 <user_query> 包裹。
var codebuddyUserQueryPattern = regexp.MustCompile(`(?is)^\s*<user_query>\s*(.*?)\s*</user_query>\s*$`)

// codebuddyRecord 是会话 JSONL 里本切片关心的字段。
type codebuddyRecord struct {
	Type        string          `json:"type"`
	Cwd         string          `json:"cwd"`
	AiTitle     string          `json:"aiTitle"`
	CustomTitle string          `json:"customTitle"`
	Role        string          `json:"role"`
	Content     json.RawMessage `json:"content"`
	Timestamp   json.RawMessage `json:"timestamp"`
}

// codebuddySessionFacts 是从单个会话文件读到的事实。
type codebuddySessionFacts struct {
	projectPath   string
	customTitle   string
	aiTitle       string
	firstUserText string
	updatedAt     int64
}

// title 复刻 Node 的优先级：自定义标题 → AI 标题 → 首条用户消息。
func (facts codebuddySessionFacts) title() string {
	if facts.customTitle != "" {
		return facts.customTitle
	}
	if facts.aiTitle != "" {
		return facts.aiTitle
	}
	return facts.firstUserText
}

// codebuddyProjects 读取该 Provider 所属地区的全部项目与会话。
//
// 家族四个成员共用同一份物理会话存储（runtime/codebuddy-family-session-store.js
// 在启动时把各地区根的 projects 归一到 .codebuddy），因此候选根按真实路径去重，
// 同一 projectDirName 出现在多个根时按 sessionId 合并（保留更新的那份）。
//
// 与 Node 的差异：Node 会合并 workbuddy.db 的 sessions 表（桌面端重命名与最后活动），
// 本切片只读 JSONL 事实（custom-title / ai-title / 记录时间戳），不打开 SQLite。
func (scan *scanner) codebuddyProjects(provider string) []projectView {
	projectsByDir := make(map[string]*projectView)
	order := make([]string, 0, 16)

	for _, root := range scan.codebuddyProjectsRoots(provider) {
		if scan.outOfTime() {
			break
		}
		for _, dirName := range scan.subdirectories(root) {
			if scan.outOfTime() {
				break
			}
			if !safeChild(root, dirName) {
				continue
			}
			sessions, projectPath := scan.readCodebuddyProjectDir(filepath.Join(root, dirName), dirName, provider)
			if len(sessions) == 0 {
				continue
			}
			existing, exists := projectsByDir[dirName]
			if !exists {
				projectsByDir[dirName] = &projectView{
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
			existing.Sessions = mergeCodebuddySessions(existing.Sessions, sessions)
		}
	}

	projects := make([]projectView, 0, len(order))
	for _, dirName := range order {
		project := projectsByDir[dirName]
		project.Path = normalizeProjectPath(project.Path)
		if project.Path == "" {
			project.Path = dirName
		}
		sort.SliceStable(project.Sessions, func(left, right int) bool {
			return project.Sessions[left].UpdatedAt > project.Sessions[right].UpdatedAt
		})
		project.Name = codebuddyProjectName(project.Path, dirName, project.Sessions)
		projects = append(projects, *project)
	}
	return projects
}

// codebuddyProjectsRoots 返回该 Provider 能看到的全部 <configDir>/projects。
//
// 顺序：自己的配置根 → 本地区另一支 → 家族其余成员；按真实路径去重，
// 避免家族归一后同一批会话被读两遍（Node 的 resolveCodebuddyProjectsRoots 同口径）。
func (scan *scanner) codebuddyProjectsRoots(provider string) []string {
	dirNames := make([]string, 0, 4)
	seenDir := make(map[string]bool, 4)
	addDir := func(dirName string) {
		if dirName == "" || seenDir[dirName] {
			return
		}
		seenDir[dirName] = true
		dirNames = append(dirNames, dirName)
	}
	addDir(codebuddyConfigDirByProvider[provider])
	for _, dirName := range codebuddyRegionRootsByProvider[provider] {
		addDir(dirName)
	}
	for _, dirName := range codebuddyFamilyConfigDirs {
		addDir(dirName)
	}

	roots := make([]string, 0, len(dirNames))
	seenPhysical := make(map[string]bool, len(dirNames))
	for _, dirName := range dirNames {
		root := filepath.Join(scan.hostHome, dirName, "projects")
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

// readCodebuddyProjectDir 读取单个项目目录下的全部会话文件。
func (scan *scanner) readCodebuddyProjectDir(projectDir, dirName, provider string) ([]sessionView, string) {
	files := scan.jsonlFiles(projectDir)
	sessions := make([]sessionView, 0, len(files))
	projectPath := ""
	for _, filePath := range files {
		if scan.outOfTime() {
			break
		}
		sessionID := strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
		if sessionID == "" {
			continue
		}
		facts := readCodebuddySessionFacts(filePath)
		if projectPath == "" && facts.projectPath != "" {
			projectPath = facts.projectPath
		}
		title := compactCodebuddyTitle(facts.title())
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
		sessions = append(sessions, sessionView{
			ID:             sessionID,
			Title:          title,
			UpdatedAt:      updatedAt,
			Provider:       provider,
			ProjectDirName: dirName,
		})
	}
	return sessions, projectPath
}

// mergeCodebuddySessions 按 sessionId 合并多个根的会话，保留更新时间较新的一份。
func mergeCodebuddySessions(existing, incoming []sessionView) []sessionView {
	merged := make(map[string]sessionView, len(existing)+len(incoming))
	for _, session := range existing {
		merged[session.ID] = session
	}
	for _, session := range incoming {
		previous, exists := merged[session.ID]
		if !exists || session.UpdatedAt > previous.UpdatedAt {
			merged[session.ID] = session
		}
	}
	sessions := make([]sessionView, 0, len(merged))
	for _, session := range merged {
		sessions = append(sessions, session)
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		return sessions[left].UpdatedAt > sessions[right].UpdatedAt
	})
	return sessions
}

// readCodebuddySessionFacts 读取一个会话文件的标题 / 项目路径 / 最后活动时间。
//
// 只读头部窗口与尾部窗口：ai-title 通常写在文件开头，重命名追加在文件末尾，
// 最后一条记录的时间戳也只在尾部。整文件扫描在长会话上代价过高。
func readCodebuddySessionFacts(sessionPath string) codebuddySessionFacts {
	facts := codebuddySessionFacts{}
	if content, err := readFileHead(sessionPath, codebuddyMetaMaxBytes); err == nil {
		for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
			record, ok := parseCodebuddyRecord(line)
			if !ok {
				continue
			}
			facts.absorb(record)
		}
	}

	info, err := os.Stat(sessionPath)
	if err != nil {
		return facts
	}
	tailTimestamp, customTitle, aiTitle := readCodebuddyTailFacts(sessionPath, info.Size())
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
func (facts *codebuddySessionFacts) absorb(record codebuddyRecord) {
	if facts.projectPath == "" {
		facts.projectPath = trimSpace(record.Cwd)
	}
	switch record.Type {
	case "ai-title":
		if title := trimSpace(record.AiTitle); title != "" {
			facts.aiTitle = title
		}
	case "custom-title":
		if title := trimSpace(record.CustomTitle); title != "" {
			facts.customTitle = title
		}
	case "message":
		if facts.firstUserText == "" && record.Role == "user" {
			facts.firstUserText = stripCodebuddySystemReminder(collectCodebuddyBlockText(record.Content))
		}
	}
}

// readCodebuddyTailFacts 从文件尾部窗口读取最后活动时间与重命名记录。
//
// 窗口从 64KB 开始，只有读不到有效时间时才扩大（上限 1MB）；扩到上限仍无时间
// 就返回 0，由调用方退回 mtime。窗口起点可能落在行中间，先丢掉第一段残行。
func readCodebuddyTailFacts(sessionPath string, size int64) (updatedAt int64, customTitle, aiTitle string) {
	tailBytes := int64(codebuddyTailBytes)
	for {
		offset := size - tailBytes
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
			record, ok := parseCodebuddyRecord(line)
			if !ok {
				continue
			}
			if timestamp := codebuddyTimestampMillis(record.Timestamp); timestamp > 0 {
				updatedAt = timestamp
			}
			switch record.Type {
			case "custom-title":
				if title := trimSpace(record.CustomTitle); title != "" {
					customTitle = title
				}
			case "ai-title":
				if title := trimSpace(record.AiTitle); title != "" {
					aiTitle = title
				}
			}
		}
		if updatedAt > 0 || offset == 0 || tailBytes >= codebuddyTailMaxBytes {
			return updatedAt, customTitle, aiTitle
		}
		tailBytes *= 2
		if tailBytes > codebuddyTailMaxBytes {
			tailBytes = codebuddyTailMaxBytes
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

// parseCodebuddyRecord 解析一行 JSON；空行与坏行返回 ok=false。
func parseCodebuddyRecord(line string) (codebuddyRecord, bool) {
	trimmed := trimSpace(line)
	if trimmed == "" || trimmed[0] != '{' {
		return codebuddyRecord{}, false
	}
	var record codebuddyRecord
	if json.Unmarshal([]byte(trimmed), &record) != nil {
		return codebuddyRecord{}, false
	}
	return record, true
}

// codebuddyTimestampMillis 兼容毫秒数字、数字字符串与 ISO 时间串。
func codebuddyTimestampMillis(raw json.RawMessage) int64 {
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

// stripCodebuddySystemReminder 剥掉系统提醒块并解开 <user_query> 包裹。
func stripCodebuddySystemReminder(text string) string {
	cleaned := codebuddySystemReminderPattern.ReplaceAllString(text, "")
	if match := codebuddyUserQueryPattern.FindStringSubmatch(cleaned); len(match) == 2 {
		cleaned = match[1]
	}
	return trimSpace(cleaned)
}

// collectCodebuddyBlockText 把 content（字符串或分片数组）拍平成文本。
func collectCodebuddyBlockText(raw json.RawMessage) string {
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

// compactCodebuddyTitle 折叠空白并截到 120 字符（按 rune，避免切坏 UTF-8）。
func compactCodebuddyTitle(text string) string {
	normalized := compactWhitespace(text)
	if utf8.RuneCountInString(normalized) <= codebuddyTitleMaxRunes {
		return normalized
	}
	return string([]rune(normalized)[:codebuddyTitleMaxRunes-1]) + "…"
}

// codebuddyProjectName 复刻 Node：默认取项目目录名；WorkBuddy 的日期目录改用
// 最新会话标题，避免列表里出现一串时间戳。
func codebuddyProjectName(projectPath, projectDirName string, sessions []sessionView) string {
	name := filepath.Base(projectPath)
	if name == "." || name == "/" {
		name = filepath.Base(projectDirName)
	}
	if !codebuddyTimestampedProjectDir.MatchString(name) {
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
