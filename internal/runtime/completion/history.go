package completion

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const historyScanLimit = 2000

const (
	historyChunkBytes   = 64 * 1024
	maxHistoryReadBytes = 4 * 1024 * 1024
)

type historyEntry struct {
	Suffix    string
	Count     int
	LastIndex int
}

var (
	zshExtendedPattern = regexp.MustCompile(`^:\s*\d+:\d+;`)
	bashNumberPattern  = regexp.MustCompile(`^\s*\d+\s+`)
	fishCommandPattern = regexp.MustCompile(`^-\s+cmd:\s?`)
	fishMetaPattern    = regexp.MustCompile(`^-\s+(when|paths|escaped_cmd):`)
	historyTimePattern = regexp.MustCompile(`^#\d+$`)
)

// normalizeHistoryLine 把一行历史归一成命令文本；解析不出内容时返回空串。
func normalizeHistoryLine(line string) string {
	text := strings.TrimSuffix(line, "\r")
	if strings.TrimSpace(text) == "" {
		return ""
	}
	if historyTimePattern.MatchString(strings.TrimSpace(text)) {
		return ""
	}
	if fishCommandPattern.MatchString(text) {
		text = fishCommandPattern.ReplaceAllString(text, "")
		text = strings.ReplaceAll(text, `\n`, " ")
		text = strings.ReplaceAll(text, `\\`, `\`)
		return strings.TrimSpace(text)
	}
	if fishMetaPattern.MatchString(text) {
		return ""
	}
	text = zshExtendedPattern.ReplaceAllString(text, "")
	text = bashNumberPattern.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

// parseHistoryText 解析历史文本；未转义 `\` 结尾的行与下一行拼接。
func parseHistoryText(text string) []string {
	rawLines := strings.Split(text, "\n")
	if len(rawLines) > historyScanLimit {
		rawLines = rawLines[len(rawLines)-historyScanLimit:]
	}
	commands := make([]string, 0, len(rawLines))
	pending := ""
	for _, raw := range rawLines {
		normalized := normalizeHistoryLine(raw)
		if normalized == "" {
			if pending == "" {
				continue
			}
			commands = append(commands, pending)
			pending = ""
			continue
		}
		if strings.HasSuffix(normalized, `\`) {
			pending += strings.TrimSuffix(normalized, `\`)
			continue
		}
		commands = append(commands, pending+normalized)
		pending = ""
	}
	if pending != "" {
		commands = append(commands, pending)
	}
	return commands
}

// extractAihSuffix 判断命令是否为 aih 调用，是则返回 `aih` 之后的原文。
func extractAihSuffix(command string) (string, bool) {
	text := strings.TrimSpace(command)
	if text == "" {
		return "", false
	}
	fields := strings.Fields(text)
	head := fields[0]
	tail := strings.TrimSpace(text[len(head):])
	if tail == "" {
		return "", false
	}
	base := head
	if position := strings.LastIndex(base, "/"); position >= 0 {
		base = base[position+1:]
	}
	if base != "aih" {
		return "", false
	}
	return tail, true
}

// collectAihHistory 汇总 aih 历史候选；越新排名越高，同一后缀保留最新一次。
func collectAihHistory(commands []string) []historyEntry {
	entries := make([]historyEntry, 0, len(commands))
	positions := make(map[string]int)
	for index, command := range commands {
		suffix, found := extractAihSuffix(command)
		if !found {
			continue
		}
		if position, exists := positions[suffix]; exists {
			entries[position].Count++
			entries[position].LastIndex = index
			continue
		}
		positions[suffix] = len(entries)
		entries = append(entries, historyEntry{Suffix: suffix, Count: 1, LastIndex: index})
	}
	return entries
}

// rankHistoryCandidates 按前缀 + 最新 + 最常用排序。
func rankHistoryCandidates(entries []historyEntry, prefix string, limit int) []historyEntry {
	prefix = strings.TrimSpace(prefix)
	if limit < 1 {
		limit = 30
	}
	filtered := make([]historyEntry, 0, len(entries))
	for _, entry := range entries {
		if prefix != "" && !strings.HasPrefix(entry.Suffix, prefix) {
			continue
		}
		filtered = append(filtered, entry)
	}
	sort.SliceStable(filtered, func(left, right int) bool {
		if filtered[left].LastIndex != filtered[right].LastIndex {
			return filtered[left].LastIndex > filtered[right].LastIndex
		}
		return filtered[left].Count > filtered[right].Count
	})
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered
}

// listHistoryRemainders 把历史命令里「当前还没敲的那一段」作为候选。
func listHistoryRemainders(entries []historyEntry, priorText, prefix string, limit int) []historyEntry {
	prior := strings.TrimSpace(priorText)
	if limit < 1 {
		limit = 30
	}
	remainders := make([]historyEntry, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		suffix := entry.Suffix
		if suffix == "" {
			continue
		}
		if prior != "" {
			if !strings.HasPrefix(suffix, prior) {
				continue
			}
			rest := suffix[len(prior):]
			if strings.TrimSpace(rest) == "" {
				continue
			}
			if !startsWithWhitespace(rest) {
				continue
			}
			value := strings.TrimSpace(rest)
			if _, exists := seen[value]; exists {
				continue
			}
			seen[value] = struct{}{}
			remainders = append(remainders, historyEntry{Suffix: value, Count: entry.Count, LastIndex: entry.LastIndex})
			continue
		}
		if _, exists := seen[suffix]; exists {
			continue
		}
		seen[suffix] = struct{}{}
		remainders = append(remainders, historyEntry{Suffix: suffix, Count: entry.Count, LastIndex: entry.LastIndex})
	}
	return rankHistoryCandidates(remainders, prefix, limit)
}

func startsWithWhitespace(value string) bool {
	if value == "" {
		return false
	}
	switch value[0] {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	default:
		return false
	}
}

// listHistoryFileCandidates 与 Node 的兜底路径一致：显式文件 → HISTFILE →
// zsh/bash/fish/PowerShell 自己的落盘位置。
func listHistoryFileCandidates(environment Environment, explicit string) []string {
	hostHome := environment.hostHomeDir()
	xdgDataHome := strings.TrimSpace(environment.env("XDG_DATA_HOME"))
	if xdgDataHome == "" {
		xdgDataHome = filepath.Join(hostHome, ".local", "share")
	}
	candidates := []string{
		strings.TrimSpace(explicit),
		strings.TrimSpace(environment.env("HISTFILE")),
		filepath.Join(hostHome, ".zsh_history"),
		filepath.Join(hostHome, ".bash_history"),
		filepath.Join(xdgDataHome, "fish", "fish_history"),
	}
	if appData := strings.TrimSpace(environment.env("APPDATA")); appData != "" {
		candidates = append(candidates, filepath.Join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"))
	}
	candidates = append(candidates, filepath.Join(xdgDataHome, "powershell", "PSReadLine", "ConsoleHost_history.txt"))
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != "" {
			result = append(result, candidate)
		}
	}
	return result
}

// readHistoryFileText 读取第一个存在的历史文件；任何 IO 失败都继续下一个候选。
func readHistoryFileText(environment Environment, explicit string) string {
	for _, file := range listHistoryFileCandidates(environment, explicit) {
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if text, ok := readHistoryTail(file); ok {
			return text
		}
	}
	return ""
}

// readHistoryTail 从文件尾部有界读取，避免在 TAB 热路径上整份读入历史。
func readHistoryTail(file string) (string, bool) {
	handle, err := os.Open(file)
	if err != nil {
		return "", false
	}
	defer func() { _ = handle.Close() }()
	info, err := handle.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return "", false
	}
	fileSize := info.Size()
	offset := fileSize
	total := 0
	newlines := 0
	chunks := make([][]byte, 0, 8)
	for offset > 0 && total < maxHistoryReadBytes && newlines <= historyScanLimit {
		length := int64(historyChunkBytes)
		if offset < length {
			length = offset
		}
		if remaining := int64(maxHistoryReadBytes - total); remaining < length {
			length = remaining
		}
		offset -= length
		buffer := make([]byte, length)
		read, readErr := handle.ReadAt(buffer, offset)
		if read <= 0 || readErr != nil && readErr != io.EOF {
			break
		}
		chunk := buffer[:read]
		for _, value := range chunk {
			if value == '\n' {
				newlines++
			}
		}
		chunks = append(chunks, chunk)
		total += read
	}
	combined := make([]byte, 0, total)
	for index := len(chunks) - 1; index >= 0; index-- {
		combined = append(combined, chunks[index]...)
	}
	if offset > 0 {
		boundary := bytes.IndexByte(combined, '\n')
		if boundary < 0 {
			return "", false
		}
		combined = combined[boundary+1:]
	}
	return string(combined), true
}

// readHistoryStdinText 只在 stdin 不是终端时读取活历史，避免在交互终端里挂住。
func readHistoryStdinText(environment Environment) string {
	if environment.StdinIsTTY || environment.Stdin == nil {
		return ""
	}
	payload, err := io.ReadAll(environment.Stdin)
	if err != nil {
		return ""
	}
	return string(payload)
}

// loadHistoryEntries 合并「文件历史 + 管道活历史」（文件在前、管道在后）。
func loadHistoryEntries(environment Environment, historyFile string, readStdin bool) []historyEntry {
	fileCommands := parseHistoryText(readHistoryFileText(environment, historyFile))
	stdinCommands := []string(nil)
	if readStdin {
		stdinCommands = parseHistoryText(readHistoryStdinText(environment))
	}
	if len(fileCommands) == 0 && len(stdinCommands) == 0 {
		return nil
	}
	commands := make([]string, 0, len(fileCommands)+len(stdinCommands))
	commands = append(commands, fileCommands...)
	commands = append(commands, stdinCommands...)
	return collectAihHistory(commands)
}
