package webuiprojectsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
	"github.com/madou1217/ai_home/internal/sessionscan/legacy"
)

const (
	claudeProvider = "claude"
	geminiProvider = "gemini"
	codexProvider  = "codex"

	// codexSessionsMaxDepth 覆盖 sessions/<年>/<月>/<日>/rollout-*.jsonl 的目录层数。
	codexSessionsMaxDepth = 4
	// codexSessionFilePrefix / codexSessionFileSuffix 是 Codex 原生会话文件名。
	codexSessionFilePrefix = "rollout-"
	codexSessionFileSuffix = ".jsonl"
	// codexMetaMaxBytes 与 Node 的 CODEX_SESSION_META_MAX_BYTES 一致：只读文件头找 session_meta。
	// 它是「首行最长能有多长」的安全上限，实际按块读到换行为止。
	codexMetaMaxBytes = 16 * 1024 * 1024
	// codexTitleMaxBytes 与 Node 的 CODEX_SESSION_TITLE_MAX_BYTES 一致：
	// 补标题时最多读这么长的文件头，超过就当作没有可用用户消息。
	codexTitleMaxBytes = 1024 * 1024
	// codexTitleMaxRunes 与 Node normalizeCodexSessionTitle(content, 50) 一致。
	codexTitleMaxRunes = 50
)

// codexSessionIDPattern 与 Node 一致：从 rollout-*.jsonl 文件名尾部取 UUID。
var codexSessionIDPattern = regexp.MustCompile(`([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`)

// rawSession 是 Provider 读取器产出的会话条目（聚合前的中间形态）。
type rawSession struct {
	ID             string
	Title          string
	UpdatedAt      int64
	Provider       string
	ProjectDirName string
}

// rawProject 是 Provider 读取器产出的项目条目（聚合前的中间形态）。
type rawProject struct {
	ID       string
	Name     string
	Path     string
	Provider string
	Sessions []rawSession
}

// scanner 是一次有界扫描的状态：预算、时限与截断标记。
type scanner struct {
	ctx       context.Context
	hostHome  string
	aiHome    string
	remaining int
	truncated bool
}

func newScanner(ctx context.Context, hostHome, aiHome string, maxEntries int) *scanner {
	return &scanner{ctx: ctx, hostHome: hostHome, aiHome: aiHome, remaining: maxEntries}
}

// exhausted 报告预算或时限是否已用尽；一旦用尽就把结果标记为不完整。
func (scan *scanner) exhausted() bool {
	if scan.ctx.Err() != nil || scan.remaining <= 0 {
		scan.truncated = true
		return true
	}
	return false
}

// take 消费一个条目预算。
func (scan *scanner) take() bool {
	if scan.exhausted() {
		return false
	}
	scan.remaining--
	return true
}

// outOfTime 只检查时限。
//
// SQLite 类 Provider 的会话行不是目录条目，不消费条目预算；但超时仍要截断，
// 否则 8 秒预算对它们不生效。
func (scan *scanner) outOfTime() bool {
	if scan.ctx.Err() != nil {
		scan.truncated = true
		return true
	}
	return false
}

// Take 实现 codebuddy.Budget：消费一个目录条目预算。
func (scan *scanner) Take() bool {
	return scan.take()
}

// OutOfTime 实现 codebuddy.Budget：只检查时限。
func (scan *scanner) OutOfTime() bool {
	return scan.outOfTime()
}

// collectProjects 按 Node 的 Provider 顺序读取宿主项目：
// claude、codex、gemini、opencode、cline、CodeBuddy 家族。
//
// 顺序影响 providers 数组与重复会话的归属（Node readProjectsFromHostByProviders
// 同口径）。账号投影型 Provider 里只有 cline 在本切片的合同内；其余
// （qoder/grok/kiro）与 zcode 不在 /projects 的覆盖范围。
func (scan *scanner) collectProjects() []rawProject {
	knownPaths := scan.knownProjectPaths()
	projects := make([]rawProject, 0, 64)
	projects = append(projects, scan.claudeProjects(knownPaths)...)
	projects = append(projects, scan.codexProjects()...)
	projects = append(projects, scan.geminiProjects()...)
	projects = append(projects, scan.opencodeProjects()...)
	projects = append(projects, scan.clineProjects()...)
	for _, provider := range codebuddy.Providers() {
		projects = append(projects, scan.codebuddyProjects(provider)...)
	}
	return projects
}

// knownProjectPaths 收集可以把 Claude sanitized 目录名反解回真实路径的已知路径。
//
// 与 Node collectKnownProjectPaths 同口径：Gemini 的 trustedFolders.json 与
// history/<name>/.project_root。Codex 的 config.toml 工作区根不在本切片内。
func (scan *scanner) knownProjectPaths() []string {
	geminiDir := filepath.Join(scan.hostHome, ".gemini")
	paths := make([]string, 0, 16)
	seen := make(map[string]bool, 16)
	add := func(value string) {
		trimmed := trimSpace(value)
		if trimmed == "" || seen[trimmed] {
			return
		}
		seen[trimmed] = true
		paths = append(paths, trimmed)
	}

	for _, name := range scan.subdirectories(filepath.Join(geminiDir, "history")) {
		content, err := os.ReadFile(filepath.Join(geminiDir, "history", name, ".project_root"))
		if err != nil {
			continue
		}
		add(string(content))
	}

	if content, err := os.ReadFile(filepath.Join(geminiDir, "trustedFolders.json")); err == nil {
		var trusted map[string]json.RawMessage
		if json.Unmarshal(content, &trusted) == nil {
			for key := range trusted {
				add(key)
			}
		}
	}
	return paths
}

// claudeProjects 扫描 <hostHome>/.claude/projects 下的一级目录。
func (scan *scanner) claudeProjects(knownPaths []string) []rawProject {
	root := filepath.Join(scan.hostHome, ".claude", "projects")
	names := scan.subdirectories(root)
	projects := make([]rawProject, 0, len(names))
	for _, name := range names {
		if scan.exhausted() {
			break
		}
		if !safeChild(root, name) {
			continue
		}
		project, ok := legacy.ReadClaudeProject(scan.hostHome, name, knownPaths)
		if !ok {
			continue
		}
		projects = append(projects, rawProjectFromLegacy(project))
	}
	return projects
}

// geminiProjects 扫描 <hostHome>/.gemini/tmp 下的一级项目目录。
func (scan *scanner) geminiProjects() []rawProject {
	root := filepath.Join(scan.hostHome, ".gemini", "tmp")
	names := scan.subdirectories(root)
	projects := make([]rawProject, 0, len(names))
	for _, name := range names {
		if scan.exhausted() {
			break
		}
		if !safeChild(root, name) {
			continue
		}
		project, ok := legacy.ReadGeminiProject(scan.hostHome, name)
		if !ok {
			continue
		}
		projects = append(projects, rawProjectFromLegacy(project))
	}
	return projects
}

// codexProjects 扫描 <hostHome>/.codex 下的会话，按 cwd 归项目。
//
// 与 Node readCodexProjectsFromHost 同口径：先读 state DB（~/.codex/state*.sqlite
// 的 threads 表），只要库读得出来就完全以库为准，不再扫 rollout 文件；文件扫描
// 只服务于没有 state 库的旧版 Codex。库里的会话行才是完整索引，rollout 文件可能
// 已被清理，标题也可能只写在库里。
func (scan *scanner) codexProjects() []rawProject {
	codexDir := filepath.Join(scan.hostHome, ".codex")
	threadNames := scan.readCodexThreadNames(filepath.Join(codexDir, "session_index.jsonl"))

	sessionsByCwd := make(map[string][]rawSession, 16)
	cwdOrder := make([]string, 0, 16)
	add := func(cwd string, record rawSession) {
		if _, exists := sessionsByCwd[cwd]; !exists {
			cwdOrder = append(cwdOrder, cwd)
		}
		sessionsByCwd[cwd] = append(sessionsByCwd[cwd], record)
	}

	snapshot := scan.readCodexThreadSnapshot(codexDir)
	if snapshot.Authoritative {
		// SQLite 行不是目录条目，不消费条目预算；超时仍然截断。
		for _, row := range snapshot.Rows {
			if scan.outOfTime() {
				break
			}
			record, cwd, ok := readCodexThreadRecord(codexDir, row, snapshot.SpawnedChildIDs, threadNames)
			if !ok {
				continue
			}
			add(cwd, record)
		}
	} else {
		for _, file := range scan.codexSessionFiles(filepath.Join(codexDir, "sessions")) {
			if scan.exhausted() {
				break
			}
			record, cwd, ok := readCodexSessionRecord(file, threadNames)
			if !ok {
				continue
			}
			add(cwd, record)
		}
	}

	projects := make([]rawProject, 0, len(cwdOrder))
	for _, cwd := range cwdOrder {
		sessions := sessionsByCwd[cwd]
		sort.SliceStable(sessions, func(left, right int) bool {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		})
		projects = append(projects, rawProject{
			ID:       codexProjectID(cwd),
			Name:     filepath.Base(cwd),
			Path:     cwd,
			Provider: codexProvider,
			Sessions: sessions,
		})
	}
	return projects
}

// codexSessionFiles 有界递归收集 rollout 文件；archived 目录按 Node 口径跳过。
func (scan *scanner) codexSessionFiles(root string) []string {
	files := make([]string, 0, 128)
	scan.walkCodexSessions(root, 0, &files)
	sort.Strings(files)
	return files
}

func (scan *scanner) walkCodexSessions(dir string, depth int, files *[]string) {
	if scan.exhausted() {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if scan.exhausted() {
			return
		}
		// 符号链接一律跳过：它可能指向白名单根之外。
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := entry.Name()
		fullPath := filepath.Join(dir, name)
		if entry.IsDir() {
			if depth >= codexSessionsMaxDepth || name == "archived" {
				continue
			}
			scan.walkCodexSessions(fullPath, depth+1, files)
			continue
		}
		if !strings.HasPrefix(name, codexSessionFilePrefix) || !strings.HasSuffix(name, codexSessionFileSuffix) {
			continue
		}
		if !scan.take() {
			return
		}
		*files = append(*files, fullPath)
	}
}

// codexThreadName 是 session_index.jsonl 里的一条会话命名。
type codexThreadName struct {
	Title     string
	UpdatedAt int64
}

// readCodexThreadNames 读取 session_index.jsonl（id -> 线程名/更新时间）。
func (scan *scanner) readCodexThreadNames(indexPath string) map[string]codexThreadName {
	content, err := os.ReadFile(indexPath)
	if err != nil {
		return nil
	}
	names := make(map[string]codexThreadName)
	for _, line := range strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n") {
		trimmed := trimSpace(line)
		if trimmed == "" {
			continue
		}
		var entry struct {
			ID         string `json:"id"`
			ThreadName string `json:"thread_name"`
			UpdatedAt  string `json:"updated_at"`
		}
		if json.Unmarshal([]byte(trimmed), &entry) != nil {
			continue
		}
		id := trimSpace(entry.ID)
		if id == "" {
			continue
		}
		record := names[id]
		if title := trimSpace(entry.ThreadName); title != "" {
			record.Title = title
		}
		if value := trimSpace(entry.UpdatedAt); value != "" {
			if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
				record.UpdatedAt = parsed.UnixMilli()
			}
		}
		names[id] = record
	}
	return names
}

// codexRolloutMeta 是 rollout JSONL 首行 session_meta 的载荷。
type codexRolloutMeta struct {
	Type    string `json:"type"`
	Payload struct {
		ID             string          `json:"id"`
		Cwd            string          `json:"cwd"`
		Source         json.RawMessage `json:"source"`
		ThreadSource   string          `json:"thread_source"`
		ParentThreadID string          `json:"parent_thread_id"`
	} `json:"payload"`
}

// readCodexSessionRecord 把一个 rollout 文件翻译成会话条目；不满足 Node 可见性
// 规则（子代理、非交互来源、worktree 项目、无标题）时 ok=false。
func readCodexSessionRecord(sessionFilePath string, threadNames map[string]codexThreadName) (rawSession, string, bool) {
	meta, ok := readCodexSessionMeta(sessionFilePath)
	if !ok {
		return rawSession{}, "", false
	}
	if isCodexSubagent(meta) || !isCodexInteractiveSource(meta.Payload.Source) {
		return rawSession{}, "", false
	}
	cwd := normalizeProjectPath(meta.Payload.Cwd)
	if cwd == "" || isCodexWorktreePath(cwd) {
		return rawSession{}, "", false
	}

	sessionID := trimSpace(meta.Payload.ID)
	if sessionID == "" {
		sessionID = codexSessionIDFromPath(sessionFilePath)
	}
	if sessionID == "" {
		return rawSession{}, "", false
	}

	// Node：索引里有名字就只认索引，归一化后为空也不再看文件（该会话丢弃）；
	// 索引里没有名字时才去文件头找第一条用户消息。
	indexedName := ""
	updatedAt := int64(0)
	if entry, exists := threadNames[sessionID]; exists {
		indexedName = entry.Title
		updatedAt = entry.UpdatedAt
	}
	title := ""
	if indexedName != "" {
		title = normalizeCodexSessionTitle(indexedName)
	} else {
		title = readCodexFallbackTitle(sessionFilePath)
	}
	if title == "" {
		return rawSession{}, "", false
	}
	if updatedAt <= 0 {
		updatedAt = fileModifiedMillis(sessionFilePath)
	}
	return rawSession{
		ID:        sessionID,
		Title:     title,
		UpdatedAt: updatedAt,
		Provider:  codexProvider,
	}, cwd, true
}

// readCodexThreadRecord 把 state DB 的一行翻译成会话条目。
//
// 与 Node readCodexThreadSnapshotFromStateDb 的记录构造同口径：可见性过滤之后，
// 标题按 session_index -> threads.title -> threads.first_user_message -> rollout
// 文件头 的顺序取第一个可用值，都取不到就不下发。
func readCodexThreadRecord(
	codexDir string,
	row codexThreadRow,
	spawnedChildIDs map[string]bool,
	threadNames map[string]codexThreadName,
) (rawSession, string, bool) {
	if !isCodexVisibleThreadRow(row, spawnedChildIDs) {
		return rawSession{}, "", false
	}
	cwd := normalizeProjectPath(row.Cwd)
	if cwd == "" {
		return rawSession{}, "", false
	}

	// Node：normalize(thread_name || title || first_user_message) || 文件头标题。
	rawTitle := ""
	if entry, exists := threadNames[row.ID]; exists {
		rawTitle = entry.Title
	}
	if rawTitle == "" {
		rawTitle = row.Title
	}
	if rawTitle == "" {
		rawTitle = row.FirstUserMessage
	}
	title := normalizeCodexSessionTitle(rawTitle)
	if title == "" {
		if rolloutPath := resolveCodexRolloutPath(codexDir, row.ID, row.RolloutPath); rolloutPath != "" {
			title = readCodexFallbackTitle(rolloutPath)
		}
	}
	if title == "" {
		return rawSession{}, "", false
	}

	return rawSession{
		ID:        row.ID,
		Title:     title,
		UpdatedAt: row.UpdatedAtMS,
		Provider:  codexProvider,
	}, cwd, true
}

// readCodexSessionMeta 只读文件头第一行；非 session_meta 记录视为不可读。
func readCodexSessionMeta(sessionFilePath string) (codexRolloutMeta, bool) {
	firstLine, err := readFileFirstLine(sessionFilePath, codexMetaMaxBytes)
	if err != nil {
		return codexRolloutMeta{}, false
	}
	firstLine = strings.TrimSuffix(strings.TrimPrefix(firstLine, "\ufeff"), "\r")
	if trimSpace(firstLine) == "" {
		return codexRolloutMeta{}, false
	}
	var meta codexRolloutMeta
	if json.Unmarshal([]byte(firstLine), &meta) != nil || meta.Type != "session_meta" {
		return codexRolloutMeta{}, false
	}
	return meta, true
}

// readCodexFallbackTitle 从文件头里找第一条主线程用户消息作为标题。
//
// 预算是 Node CODEX_SESSION_TITLE_MAX_BYTES（1MB）；标题按 Node 的口径截到
// codexTitleMaxRunes 个字符。文件里找不到可用用户消息时返回空串。
func readCodexFallbackTitle(sessionFilePath string) string {
	content, err := readFileHead(sessionFilePath, codexTitleMaxBytes)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		trimmed := trimSpace(line)
		if trimmed == "" {
			continue
		}
		var record struct {
			Payload struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Message string `json:"message"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal([]byte(trimmed), &record) != nil {
			continue
		}
		// 与 Node extractCodexUserTitleFromPayload 同口径：既认 response_item 的
		// message/content，也认 event_msg 的 user_message.message。
		text := ""
		switch record.Payload.Type {
		case "message":
			if record.Payload.Role != "user" {
				continue
			}
			parts := make([]string, 0, len(record.Payload.Content))
			for _, block := range record.Payload.Content {
				if (block.Type == "input_text" || block.Type == "text") && block.Text != "" {
					parts = append(parts, block.Text)
				}
			}
			text = strings.Join(parts, " ")
		case "user_message":
			text = record.Payload.Message
		default:
			continue
		}
		if isSyntheticCodexUserContent(text) {
			continue
		}
		// Node 同一路径会把标题截到 50 个字符（normalizeCodexSessionTitle(nextTitle, 50)）。
		if title := truncateCodexTitle(normalizeCodexSessionTitle(text), codexTitleMaxRunes); title != "" {
			return title
		}
	}
	return ""
}

// isCodexSubagent 复刻 Node 的子代理判定：显式来源、父线程或 source.subagent。
func isCodexSubagent(meta codexRolloutMeta) bool {
	if strings.EqualFold(trimSpace(meta.Payload.ThreadSource), "subagent") {
		return true
	}
	if trimSpace(meta.Payload.ParentThreadID) != "" {
		return true
	}
	return isCodexSubagentSource(meta.Payload.Source)
}

// isCodexSubagentSource 判断 source 是否带非 null 的 subagent 字段。
//
// source 可能是 JSON 字符串（"cli"）或对象；只有对象形态才有 subagent。
func isCodexSubagentSource(raw json.RawMessage) bool {
	source := trimSpace(string(raw))
	if !strings.HasPrefix(source, "{") {
		return false
	}
	var parsed map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &parsed) != nil {
		return false
	}
	value, exists := parsed["subagent"]
	return exists && trimSpace(string(value)) != "null"
}

// isCodexInteractiveSource 复刻 Node：旧记录没有 source 时保留，其余只认 cli/vscode。
func isCodexInteractiveSource(raw json.RawMessage) bool {
	var kind string
	if err := json.Unmarshal(raw, &kind); err != nil {
		// source 是对象（含 subagent 描述）时 Node 的 normalizeSourceKind 得到空串，视为交互会话。
		return true
	}
	switch strings.ToLower(trimSpace(kind)) {
	case "", "cli", "vscode":
		return true
	default:
		return false
	}
}

// isCodexWorktreePath 与 Node 一致：worktree 项目不进项目列表。
func isCodexWorktreePath(projectPath string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(trimSpace(projectPath), "\\", "/"))
	return strings.Contains(normalized, "/.codex/worktrees/")
}

// normalizeCodexSessionTitle 压缩空白并丢弃无意义标题。
func normalizeCodexSessionTitle(content string) string {
	title := compactWhitespace(content)
	if markerIndex := strings.Index(title, "[aih] 选择要进入的持久会话"); markerIndex >= 0 {
		title = strings.TrimSpace(title[:markerIndex])
		title = strings.TrimRight(title, " \t:：-")
		title = strings.TrimSpace(title)
	}
	if title == "" || title == "Warmup" || title == legacy.UnnamedTitle {
		return ""
	}
	return title
}

// isSyntheticCodexUserContent 过滤 CLI 注入的伪用户消息（AGENTS.md、环境上下文等）。
func isSyntheticCodexUserContent(content string) bool {
	text := compactWhitespace(content)
	if text == "" {
		return false
	}
	for _, prefix := range []string{
		"# AGENTS.md instructions",
		"<environment_context",
		"<codex_internal_context",
		"<goal_context",
		"<turn_aborted",
		"<user_instructions",
		"<user_shell_command",
	} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return strings.Contains(text, "<INSTRUCTIONS>")
}

// codexProjectID 复刻 Node：cwd 的标准 base64，再把 / + = 折成下划线。
func codexProjectID(cwd string) string {
	return base64PathID("", cwd)
}

// codexSessionIDFromPath 从 rollout 文件名尾部取 UUID。
func codexSessionIDFromPath(sessionFilePath string) string {
	base := strings.TrimSuffix(filepath.Base(sessionFilePath), codexSessionFileSuffix)
	match := codexSessionIDPattern.FindStringSubmatch(base)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

// subdirectories 返回 root 下的一级目录名；符号链接目录跳过。
func (scan *scanner) subdirectories(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if scan.exhausted() {
			break
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		if !scan.take() {
			break
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
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

// rawProjectFromLegacy 把 legacy 读取器的结果转成本包的中间形态。
func rawProjectFromLegacy(project legacy.Project) rawProject {
	sessions := make([]rawSession, 0, len(project.Sessions))
	for _, session := range project.Sessions {
		sessions = append(sessions, rawSession{
			ID:             session.ID,
			Title:          session.Title,
			UpdatedAt:      session.UpdatedAt,
			Provider:       session.Provider,
			ProjectDirName: session.ProjectDirName,
		})
	}
	return rawProject{
		ID:       project.ID,
		Name:     project.Name,
		Path:     project.Path,
		Provider: project.Provider,
		Sessions: sessions,
	}
}

// readFileHead 只读文件前 limit 字节。
func readFileHead(filePath string, limit int64) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil && len(content) == 0 {
		return "", err
	}
	return string(content), nil
}

// readFileFirstLine 按块读到第一个换行或 limit 字节为止（不含换行符）。
//
// 等价于 Node readCodexSessionMeta 的读取方式：limit 是首行的安全上限，
// 不会为了拿首行把整段预算都读进内存。
func readFileFirstLine(filePath string, limit int64) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if limit <= 0 {
		return "", nil
	}

	var builder strings.Builder
	buffer := make([]byte, 64*1024)
	var consumed int64
	for consumed < limit {
		chunkSize := int64(len(buffer))
		if remaining := limit - consumed; remaining < chunkSize {
			chunkSize = remaining
		}
		count, readErr := file.Read(buffer[:chunkSize])
		if count > 0 {
			chunk := buffer[:count]
			if newlineIndex := bytes.IndexByte(chunk, '\n'); newlineIndex >= 0 {
				builder.Write(chunk[:newlineIndex])
				return builder.String(), nil
			}
			builder.Write(chunk)
			consumed += int64(count)
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return builder.String(), readErr
		}
		if count == 0 {
			break
		}
	}
	return builder.String(), nil
}

// truncateCodexTitle 等价于 JS 的 String.prototype.slice(0, limit)。
//
// 按 rune 切分，非 BMP 字符（emoji）不会被从中间截断；Node 用 UTF-16 码元切，
// 只有这类字符的结果可能相差半个码元。
func truncateCodexTitle(title string, limit int) string {
	if limit <= 0 {
		return title
	}
	runes := []rune(title)
	if len(runes) <= limit {
		return title
	}
	return string(runes[:limit])
}

// fileModifiedMillis 返回文件 mtime（毫秒）；读不到时为 0。
func fileModifiedMillis(filePath string) int64 {
	info, err := os.Stat(filePath)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

// isExistingDirectory 等价于 Node 的 projectPathExists：必须是真实存在的目录。
func isExistingDirectory(projectPath string) bool {
	if projectPath == "" {
		return false
	}
	info, err := os.Stat(projectPath)
	return err == nil && info.IsDir()
}
