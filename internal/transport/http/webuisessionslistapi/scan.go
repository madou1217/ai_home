package webuisessionslistapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/legacy"
)

const (
	claudeProvider = "claude"
	codexProvider  = "codex"
)

// codebuddyFamilyProviders 是 CodeBuddy 家族的成员名单。
//
// 顺序只影响候选目录的读取优先级；家族成员共用同一份物理会话存储，
// 读取时会按真实路径去重（见 codebuddy.go）。
var codebuddyFamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}

// base64StdEncoding 是 Node Buffer 默认的 base64 字母表（codex 项目 id 用）。
var base64StdEncoding = base64.StdEncoding

// isSupportedProvider 报告该 Provider 的会话是否已由 Go 承接。
func isSupportedProvider(provider string) bool {
	if provider == claudeProvider || provider == codexProvider {
		return true
	}
	for _, member := range codebuddyFamilyProviders {
		if provider == member {
			return true
		}
	}
	return false
}

func normalizeProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// isSafePathSegment 拒绝空串、分隔符与上跳，保证拼进路径的值只有一段。
func isSafePathSegment(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	if strings.ContainsAny(value, `/\`) {
		return false
	}
	return filepath.Base(value) == value
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

// scanner 是一次有界扫描的状态：预算、时限与截断标记。
type scanner struct {
	ctx       context.Context
	hostHome  string
	remaining int
	truncated bool
}

func newScanner(ctx context.Context, hostHome string, maxEntries int) *scanner {
	return &scanner{ctx: ctx, hostHome: hostHome, remaining: maxEntries}
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
// 预算限制的是「还能读取多少条目」，已经读到的条目必须处理完，否则最后一条
// 会把整批结果一起吞掉（例如预算恰好停在某个项目目录上）。
func (scan *scanner) outOfTime() bool {
	if scan.ctx.Err() != nil {
		scan.truncated = true
		return true
	}
	return false
}

// subdirectories 返回 root 下的一级目录名（排序后）；符号链接目录跳过。
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

// jsonlFiles 返回 root 下的一级 .jsonl 文件（排序后）；符号链接与目录跳过。
func (scan *scanner) jsonlFiles(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if scan.exhausted() {
			break
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		if !scan.take() {
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

// claudeProjects 扫描 <hostHome>/.claude/projects 下的一级项目目录。
//
// 会话可见性（主线程、标题、Warmup 过滤）由 legacy 读取器复刻 Node 口径；
// 本函数只负责预算、超时与符号链接逃逸防护。预算与超时按项目粒度生效：
// 单个项目内部由 legacy 一次读完（与 webuiprojectsapi 同口径）。
func (scan *scanner) claudeProjects(knownPaths []string) []projectView {
	root := filepath.Join(scan.hostHome, ".claude", "projects")
	names := scan.subdirectories(root)
	projects := make([]projectView, 0, len(names))
	for _, name := range names {
		if scan.outOfTime() {
			break
		}
		if !safeChild(root, name) {
			continue
		}
		project, ok := legacy.ReadClaudeProject(scan.hostHome, name, knownPaths)
		if !ok {
			continue
		}
		projects = append(projects, projectViewFromLegacy(project))
	}
	return projects
}

// knownProjectPaths 收集可以把 Claude sanitized 目录名反解回真实路径的已知路径。
//
// 与 webuiprojectsapi 同口径：Gemini 的 trustedFolders.json 与
// history/<name>/.project_root。Codex 的 config.toml 工作区根不在本切片内；
// 绝大多数会话能直接从记录里的 cwd 解析出项目路径，这里只补反解失败的情况。
//
// 这里不消费扫描预算：它只是几条路径线索，真正的会话目录扫描由 claudeProjects
// 计数，避免 Gemini 历史目录很多时把 Claude 的预算吃光。
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

	for _, name := range listDirectories(filepath.Join(geminiDir, "history")) {
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

// listDirectories 返回 root 下的一级目录名（排序后）；符号链接目录跳过。
func listDirectories(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// projectViewFromLegacy 把 legacy 读取器的结果转成契约形状。
func projectViewFromLegacy(project legacy.Project) projectView {
	sessions := make([]sessionView, 0, len(project.Sessions))
	for _, session := range project.Sessions {
		sessions = append(sessions, sessionView{
			ID:             session.ID,
			Title:          session.Title,
			UpdatedAt:      session.UpdatedAt,
			Provider:       session.Provider,
			ProjectDirName: session.ProjectDirName,
		})
	}
	return projectView{
		ID:       project.ID,
		Name:     project.Name,
		Path:     project.Path,
		Sessions: sessions,
		Provider: project.Provider,
	}
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
