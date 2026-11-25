// Package shellsetup 生成并安装 aih 的 shell 集成片段。
//
// 片段由 Node 侧历史实现一次性生成后嵌入 Go 二进制：运行时不再依赖 Node，
// Go 只负责选择片段、替换可执行文件路径并维护 rc 文件里的受管块。
package shellsetup

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

//go:embed assets/*.txt
var assets embed.FS

const (
	// BlockName 与 BlockPrefix 共同决定受管块标记：`# >>> aih:shell >>>`。
	BlockName   = "shell"
	BlockPrefix = "aih"

	optionsPrefix = "# aih-shell-options-v1: "
	binToken      = "__AIH_SHELL_BIN__"
)

// SnippetOptions 是生成片段的完整参数。
type SnippetOptions struct {
	AihBinPath  string `json:"aihBinPath"`
	Completion  bool   `json:"completion"`
	Typo        bool   `json:"typo"`
	Wrapper     bool   `json:"wrapper"`
	HistoryTail int    `json:"historyTail"`
}

// SnippetOverrides 是调用方显式给出的片段参数；nil 表示沿用已存片段/默认值。
type SnippetOverrides struct {
	AihBinPath  string
	Completion  *bool
	Typo        *bool
	Wrapper     *bool
	HistoryTail *int
}

// DefaultSnippetOptions 与历史 Node 实现的默认值一致。
func DefaultSnippetOptions() SnippetOptions {
	return SnippetOptions{AihBinPath: "aih", Completion: true, Typo: true, Wrapper: true, HistoryTail: 1000}
}

// NormalizeSnippetOptions 把零值/越界参数收敛到可落盘范围。
func NormalizeSnippetOptions(options SnippetOptions) SnippetOptions {
	if strings.TrimSpace(options.AihBinPath) == "" {
		options.AihBinPath = "aih"
	}
	if options.HistoryTail < 200 {
		options.HistoryTail = 1000
	}
	return options
}

// StoredSnippetOptions 只从片段文本读出已记录的参数，不执行任何 shell 代码。
// 返回 values 中未出现的键保持 nil，由调用方决定默认值。
func StoredSnippetOptions(text string) SnippetOverrides {
	source := strings.TrimPrefix(text, "\uFEFF")
	for _, line := range strings.Split(source, "\n") {
		if !strings.HasPrefix(line, optionsPrefix) {
			continue
		}
		var value struct {
			Completion  *bool `json:"completion"`
			Typo        *bool `json:"typo"`
			Wrapper     *bool `json:"wrapper"`
			HistoryTail *int  `json:"historyTail"`
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(line[len(optionsPrefix):])), &value); err != nil {
			return SnippetOverrides{}
		}
		if value.HistoryTail != nil && *value.HistoryTail < 200 {
			value.HistoryTail = nil
		}
		return SnippetOverrides{Completion: value.Completion, Typo: value.Typo, Wrapper: value.Wrapper, HistoryTail: value.HistoryTail}
	}
	// 升级早期片段：从变量声明还原功能开关，不执行文件。
	if !strings.HasPrefix(source, "# aih 终端集成：") {
		return SnippetOverrides{}
	}
	read := func(name string) (string, bool) {
		pattern := regexp.MustCompile(`(?m)^(?:typeset -g |set -g |\$global:)?` + regexp.QuoteMeta(name) + `(?:=| = | )(\$true|\$false|[0-9]+);?\r?$`)
		match := pattern.FindStringSubmatch(source)
		if match == nil {
			return "", false
		}
		return match[1], true
	}
	overrides := SnippetOverrides{}
	completion := strings.Contains(source, "# ---- TAB 补全 ----")
	overrides.Completion = &completion
	if value, ok := read("AIH_SHELL_TYPO"); ok {
		flag := value == "1" || value == "$true"
		overrides.Typo = &flag
	}
	if value, ok := read("AIH_SHELL_WRAPPER"); ok {
		flag := value == "1" || value == "$true"
		overrides.Wrapper = &flag
	}
	if value, ok := read("AIH_SHELL_HISTORY_TAIL"); ok {
		if number, err := strconv.Atoi(value); err == nil && number >= 200 {
			overrides.HistoryTail = &number
		}
	}
	return overrides
}

// ResolveSnippetOptions 以 defaults 为底，叠加已存片段参数与显式参数。
func ResolveSnippetOptions(stored, explicit SnippetOverrides) SnippetOptions {
	options := DefaultSnippetOptions()
	apply := func(source SnippetOverrides) {
		if source.Completion != nil {
			options.Completion = *source.Completion
		}
		if source.Typo != nil {
			options.Typo = *source.Typo
		}
		if source.Wrapper != nil {
			options.Wrapper = *source.Wrapper
		}
		if source.HistoryTail != nil && *source.HistoryTail >= 200 {
			options.HistoryTail = *source.HistoryTail
		}
		if strings.TrimSpace(source.AihBinPath) != "" {
			options.AihBinPath = source.AihBinPath
		}
	}
	apply(stored)
	apply(explicit)
	return NormalizeSnippetOptions(options)
}

// Snippet 返回指定 shell 与选项组合的集成片段。
func Snippet(shell string, options SnippetOptions) (string, bool) {
	normalizedShell := NormalizeShell(shell)
	if normalizedShell == "" {
		return "", false
	}
	options = NormalizeSnippetOptions(options)
	if normalizedShell == "sh" {
		return shSnippet(options), true
	}
	mask := 0
	if options.Completion {
		mask |= 1
	}
	if options.Typo {
		mask |= 2
	}
	if options.Wrapper {
		mask |= 4
	}
	raw, err := assets.ReadFile(filepath.ToSlash(filepath.Join("assets", fmt.Sprintf("%s-%d.txt", normalizedShell, mask))))
	if err != nil {
		return "", false
	}
	text := string(raw)
	bom := strings.HasPrefix(text, "\uFEFF")
	text = strings.TrimPrefix(text, "\uFEFF")
	headerEnd := strings.Index(text, "\n")
	if headerEnd < 0 {
		return "", false
	}
	body := text[headerEnd+1:]
	body = replaceHistoryTailDeclaration(normalizedShell, body, options.HistoryTail)
	body = strings.ReplaceAll(body, binToken, escapeSingleQuotes(normalizedShell, options.AihBinPath))
	if widget := clipboardWidget(normalizedShell); widget != "" {
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		body += widget
	}
	header := fmt.Sprintf("%s{\"completion\":%t,\"typo\":%t,\"wrapper\":%t,\"historyTail\":%d}\n",
		optionsPrefix, options.Completion, options.Typo, options.Wrapper, options.HistoryTail)
	if bom {
		return "\uFEFF" + header + body, true
	}
	return header + body, true
}

func replaceHistoryTailDeclaration(shell, body string, historyTail int) string {
	var declaration string
	switch shell {
	case "zsh":
		declaration = "typeset -g AIH_SHELL_HISTORY_TAIL=1000"
	case "bash":
		declaration = "AIH_SHELL_HISTORY_TAIL=1000"
	case "fish":
		declaration = "set -g AIH_SHELL_HISTORY_TAIL 1000"
	case "powershell":
		declaration = "$global:AIH_SHELL_HISTORY_TAIL = 1000"
	case "sh":
		declaration = "AIH_SHELL_HISTORY_TAIL=1000"
	default:
		return body
	}
	if historyTail == 1000 {
		return body
	}
	replacement := strings.Replace(declaration, "1000", strconv.Itoa(historyTail), 1)
	return strings.Replace(body, declaration, replacement, 1)
}

func escapeSingleQuotes(shell, value string) string {
	if shell == "powershell" {
		return strings.ReplaceAll(value, "'", "''")
	}
	return strings.ReplaceAll(value, "'", `'\''`)
}

// SupportedShells 返回可安装的 shell 名。
func SupportedShells() []string {
	return []string{"zsh", "bash", "fish", "powershell", "sh"}
}

// NormalizeShell 把别名归一成受支持的名字；未知返回空串。
func NormalizeShell(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "zsh":
		return "zsh"
	case "bash":
		return "bash"
	case "fish":
		return "fish"
	case "pwsh", "powershell":
		return "powershell"
	case "sh", "dash", "ash":
		return "sh"
	default:
		return ""
	}
}

// DetectShell 按「显式 → 父进程 → PSModulePath → $SHELL」判断当前 shell。
func DetectShell(explicit string, env func(string) string) string {
	if normalized := NormalizeShell(explicit); normalized != "" {
		return normalized
	}
	if explicit != "" {
		return ""
	}
	if fromParent := detectParentShell(); fromParent != "" {
		return fromParent
	}
	if env != nil && strings.TrimSpace(env("PSModulePath")) != "" {
		return "powershell"
	}
	if env != nil {
		base := strings.ToLower(filepath.Base(strings.TrimSpace(env("SHELL"))))
		base = strings.TrimSuffix(base, ".exe")
		return NormalizeShell(base)
	}
	return ""
}

func detectParentShell() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	command := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(os.Getppid()))
	command.Stderr = nil
	output, err := command.Output()
	if err != nil {
		return ""
	}
	name := strings.ToLower(filepath.Base(strings.TrimSpace(string(output))))
	return NormalizeShell(name)
}

// ResolveRcFile 按 shell 与平台解析默认 rc 文件。
func RcFile(shell, homeDir string, env func(string) string) string {
	get := func(name string) string {
		if env == nil {
			return ""
		}
		return strings.TrimSpace(env(name))
	}
	switch NormalizeShell(shell) {
	case "zsh":
		dir := get("ZDOTDIR")
		if dir == "" {
			dir = homeDir
		}
		return filepath.Join(dir, ".zshrc")
	case "bash":
		bashrc := filepath.Join(homeDir, ".bashrc")
		profile := filepath.Join(homeDir, ".bash_profile")
		if _, err := os.Stat(bashrc); err == nil {
			return bashrc
		}
		if _, err := os.Stat(profile); err == nil {
			return profile
		}
		return bashrc
	case "sh":
		if envFile := get("ENV"); envFile != "" {
			return envFile
		}
		return filepath.Join(homeDir, ".profile")
	case "fish":
		configHome := get("XDG_CONFIG_HOME")
		if configHome == "" {
			configHome = filepath.Join(homeDir, ".config")
		}
		return filepath.Join(configHome, "fish", "config.fish")
	case "powershell":
		if runtime.GOOS == "windows" {
			documents := resolveWindowsDocumentsDir(homeDir)
			ps7 := filepath.Join(documents, "PowerShell", "Microsoft.PowerShell_profile.ps1")
			ps5 := filepath.Join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")
			// PS7 进程的 PSModulePath 指向 PowerShell\7；即使 7 的 profile 还没建立，
			// 也应写入 PS7 的位置，不能因为文件不存在就回落到 5.1。
			if powershellIsSeven(get("PSModulePath")) {
				return ps7
			}
			// 5.1 的进程必须写 5.1 的 profile；不能因为 7 的 profile 已存在就跳过去。
			return ps5
		}
		configHome := get("XDG_CONFIG_HOME")
		if configHome == "" {
			configHome = filepath.Join(homeDir, ".config")
		}
		return filepath.Join(configHome, "powershell", "Microsoft.PowerShell_profile.ps1")
	default:
		return ""
	}
}

// powershellIsSeven 通过 PSModulePath 判断当前进程是 PowerShell 7+。
func powershellIsSeven(modulePath string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(modulePath), "/", "\\"))
	// 安装版是 \PowerShell\7\Modules；便携版可能只有 \PowerShell\Modules。
	// 5.1 的模块根是 \WindowsPowerShell\Modules，不会命中这两个前缀。
	return strings.Contains(normalized, "\\powershell\\modules") ||
		strings.Contains(normalized, "\\powershell\\7") ||
		strings.Contains(normalized, "\\powershell\\6")
}

func resolveWindowsDocumentsDir(homeDir string) string {
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')")
	output, err := command.Output()
	if err == nil {
		value := strings.TrimSpace(string(output))
		if value != "" {
			if info, statErr := os.Stat(value); statErr == nil && info.IsDir() {
				return value
			}
		}
	}
	return filepath.Join(homeDir, "Documents")
}

// ResolveShellBinary 在 PATH 中查找 shell 可执行文件；找不到返回空串。
func ResolveShellBinary(shell string, env func(string) string) string {
	names := map[string][]string{
		"zsh":        {"zsh"},
		"bash":       {"bash"},
		"fish":       {"fish"},
		"powershell": {"pwsh", "pwsh.exe", "powershell", "powershell.exe"},
		"sh":         {"sh", "dash"},
	}[NormalizeShell(shell)]
	if len(names) == 0 {
		return ""
	}
	pathValue := ""
	if env != nil {
		pathValue = env("PATH")
	}
	for _, directory := range filepath.SplitList(pathValue) {
		if directory == "" {
			continue
		}
		for _, name := range names {
			candidate := filepath.Join(directory, name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

// ResolveHostHomeDir 优先 AIH_HOST_HOME，其次非投影 HOME/USERPROFILE。
func ResolveHostHomeDir(env func(string) string, fallback func() (string, error)) string {
	if env != nil {
		if value := strings.TrimSpace(env("AIH_HOST_HOME")); value != "" {
			return normalizeHostHome(value)
		}
		if value := strings.TrimSpace(env("HOME")); value != "" && !looksProjectedHome(value) {
			return normalizeHostHome(value)
		}
	}
	if fallback != nil {
		if value, err := fallback(); err == nil && strings.TrimSpace(value) != "" {
			return normalizeHostHome(value)
		}
	}
	if value, err := os.UserHomeDir(); err == nil {
		return normalizeHostHome(value)
	}
	return ""
}

var projectedHomePattern = regexp.MustCompile(`[\\/]run[\\/](login|auth-projections)[\\/]`)

func looksProjectedHome(value string) bool {
	return projectedHomePattern.MatchString(value)
}

func normalizeHostHome(value string) string {
	text := strings.TrimSpace(value)
	normalized := strings.ReplaceAll(text, "\\", "/")
	normalized = strings.TrimRight(normalized, "/")
	if strings.HasSuffix(strings.ToLower(normalized), "/.codex") {
		text = normalized[:len(normalized)-len("/.codex")]
	}
	return text
}
