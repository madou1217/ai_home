package webuislashcommandsapi

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// 各 provider 的规范 id（与 core/providers 合同、Node provider-catalog 一致）。
const (
	providerClaude   = "claude"
	providerCodex    = "codex"
	providerOpenCode = "opencode"
	providerAgy      = "agy"
	providerGemini   = "gemini"
)

const (
	// sourceUserCommand 与 Node 用户自定义命令条目的 source 取值一致。
	sourceUserCommand = "claude-user"
	// defaultUserCommandDescription 是没有 frontmatter 时的兜底描述（Node 的固定值）。
	defaultUserCommandDescription = "用户自定义命令"

	// maxScanEntries 限制单次扫描检查的目录条目总数，防止超大目录拖住请求。
	maxScanEntries = 4096
	// maxScanDepth 限制子目录层数（对应命令名前缀的层级）。
	maxScanDepth = 8
	// maxCommands 限制单次返回的用户命令条数。
	maxCommands = 2048
	// maxCommandFileBytes 是单文件大小上限：超过则不读内容，只用兜底描述列出命令。
	maxCommandFileBytes = 256 << 10
	// maxFrontmatterBytes 是 frontmatter 读取上限：元数据只在文件头，不必读全文。
	maxFrontmatterBytes = 16 << 10
	// maxDescriptionRunes / maxArgumentHintRunes 限制元数据长度，避免超长文本灌进 autocomplete。
	maxDescriptionRunes  = 200
	maxArgumentHintRunes = 120
)

// claudeCommandsDir 返回 claude 用户自定义命令目录。
//
// CLAUDE_CONFIG_DIR 是 claude 自己的配置根（等价 ~/.claude），自定义命令在其 commands/ 下；
// 未设置时回落到 <宿主 HOME>/.claude/commands。
func (handler *Handler) claudeCommandsDir() string {
	if configDir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); configDir != "" {
		return filepath.Join(configDir, "commands")
	}
	return filepath.Join(handler.hostHomeDir, ".claude", "commands")
}

// scanUserCommands 扫描命令目录，把 **/*.md 翻译成 /<目录>:<文件名>。
//
// truncated 表示扫描因条目数 / 深度 / 命令数触顶而提前结束。目录不存在或不可读时返回空清单
// （Node 同样静默跳过），因为「没有自定义命令」是正常状态。
func scanUserCommands(root string) ([]Command, bool) {
	if strings.TrimSpace(root) == "" {
		return []Command{}, false
	}
	// 根目录本身允许是符号链接（~/.claude 常被指到别处），解析后的真实路径作为越界基线。
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return []Command{}, false
	}
	info, err := os.Stat(resolvedRoot)
	if err != nil || !info.IsDir() {
		return []Command{}, false
	}

	type directory struct {
		path   string
		prefix string
		depth  int
	}
	commands := make([]Command, 0, 16)
	pending := []directory{{path: resolvedRoot, depth: 0}}
	truncated := false
	examined := 0

	for len(pending) > 0 && !truncated {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]

		entries, readErr := os.ReadDir(current.path)
		if readErr != nil {
			continue
		}
		for _, entry := range entries {
			examined++
			if examined > maxScanEntries {
				truncated = true
				break
			}
			name := entry.Name()
			full := filepath.Join(current.path, name)
			// 不跟随符号链接：Node 的 Dirent 语义同样把符号链接排除在 isFile/isDirectory 之外，
			// 而跟随链接正是目录逃逸的入口。这里再补一次包含性检查作为纵深防御。
			if entry.Type()&os.ModeSymlink != 0 || !isWithinRoot(resolvedRoot, full) {
				continue
			}
			if entry.IsDir() {
				if current.depth+1 > maxScanDepth {
					truncated = true
					continue
				}
				pending = append(pending, directory{
					path:   full,
					prefix: current.prefix + name + ":",
					depth:  current.depth + 1,
				})
				continue
			}
			if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".md") {
				continue
			}
			commandName := strings.TrimSuffix(name, ".md")
			if commandName == "" {
				continue
			}
			if len(commands) >= maxCommands {
				truncated = true
				break
			}
			description, argumentHint := readCommandMetadata(full)
			if description == "" {
				description = defaultUserCommandDescription
			}
			commands = append(commands, Command{
				Command:      "/" + current.prefix + commandName,
				Description:  truncateRunes(description, maxDescriptionRunes),
				ArgumentHint: truncateRunes(argumentHint, maxArgumentHintRunes),
				Aliases:      []string{},
				Source:       sourceUserCommand,
			})
		}
	}
	return commands, truncated
}

// readCommandMetadata 读文件头的 frontmatter，取 description / argument-hint。
//
// 只解析顶格的单行标量（key: value）；嵌套 YAML 与块标量不属于命令元数据，直接忽略。
// 读失败、文件超限或没有 frontmatter 时返回空串，由调用方回落到 Node 的默认描述。
func readCommandMetadata(path string) (string, string) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxCommandFileBytes {
		return "", ""
	}
	file, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer func() { _ = file.Close() }()
	head, err := io.ReadAll(io.LimitReader(file, maxFrontmatterBytes))
	if err != nil {
		return "", ""
	}
	return parseFrontmatter(head)
}

// parseFrontmatter 从文件头解析 claude 命令的 YAML frontmatter。
func parseFrontmatter(head []byte) (string, string) {
	text := strings.TrimPrefix(string(head), "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", ""
	}
	var description, argumentHint string
	for _, line := range lines[1:] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" || trimmed == "..." {
			break
		}
		// 缩进行是嵌套结构（例如 metadata: 的子键），不能当成命令字段。
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue
		}
		separator := strings.Index(line, ":")
		if separator <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:separator]))
		value := cleanScalar(line[separator+1:])
		switch key {
		case "description":
			if description == "" {
				description = value
			}
		case "argument-hint", "argumenthint":
			if argumentHint == "" {
				argumentHint = value
			}
		}
	}
	return description, argumentHint
}

// cleanScalar 去掉 YAML 标量的引号并把换行压平，保证输出是单行文本。
func cleanScalar(raw string) string {
	value := strings.TrimSpace(raw)
	if len(value) >= 2 {
		quoted := (value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'')
		if quoted {
			if value[0] == '"' {
				if unquoted, err := strconv.Unquote(value); err == nil {
					value = unquoted
				} else {
					value = value[1 : len(value)-1]
				}
			} else {
				value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
			}
		}
	}
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\t", " ")
	return strings.TrimSpace(value)
}

// isWithinRoot 判断 target 是否仍在 root 内（两者都应是已解析的绝对路径）。
func isWithinRoot(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(relative)
}

// truncateRunes 按字符截断，避免把一个汉字切成半个字节序列。
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}
