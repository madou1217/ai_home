package sshhost

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultBrowseTimeout 对应 Node 的 DEFAULT_BROWSE_TIMEOUT_MS：一次列目录的默认上限。
const DefaultBrowseTimeout = 15 * time.Second

// 远端路径方言：POSIX 用 /，Windows PowerShell 用 \。
const (
	DialectPOSIX      = "posix"
	DialectPowerShell = "powershell"
)

// IsWindowsPath 判断一个路径是不是 Windows 盘符形式（C:\ 或 C:/）。
func IsWindowsPath(value string) bool {
	text := strings.TrimSpace(value)
	if len(text) < 3 {
		return false
	}
	letter := text[0]
	if !((letter >= 'A' && letter <= 'Z') || (letter >= 'a' && letter <= 'z')) {
		return false
	}
	return text[1] == ':' && (text[2] == '\\' || text[2] == '/')
}

// IsWindowsDialect 判断方言是否为 PowerShell。
func IsWindowsDialect(dialect string) bool {
	return strings.TrimSpace(dialect) == DialectPowerShell
}

// JoinRemotePath 按方言拼接远端路径；POSIX 根为空时落到 /，PowerShell 保留盘符与反斜杠。
func JoinRemotePath(base, name, dialect string) string {
	parent := base
	child := name
	if IsWindowsDialect(dialect) {
		return trimRightSet(parent, "\\/") + "\\" + trimLeftSet(child, "\\/")
	}
	root := trimRightSet(parent, "/")
	if root != "" {
		return root + "/" + trimLeftSet(child, "/")
	}
	return "/" + trimLeftSet(child, "/")
}

// ResolveBrowsePath 把界面传入的路径折成绝对路径：
// 空 / ~ → 家目录；~/ 前缀 → 家目录下的相对路径；相对路径 → 家目录下的相对路径；绝对路径原样。
func ResolveBrowsePath(input, home, dialect string) string {
	raw := strings.TrimSpace(input)
	homeDir := strings.TrimSpace(home)
	if raw == "" {
		return homeDir
	}
	if raw == "~" {
		return homeDir
	}
	if strings.HasPrefix(raw, "~/") {
		return JoinRemotePath(homeDir, raw[2:], dialect)
	}
	if IsWindowsDialect(dialect) {
		if IsWindowsPath(raw) {
			return raw
		}
		return JoinRemotePath(homeDir, raw, dialect)
	}
	if strings.HasPrefix(raw, "/") {
		return raw
	}
	return JoinRemotePath(homeDir, raw, dialect)
}

// ParentRemotePath 返回上一级目录；POSIX 根与 Windows 盘符根的返回值与 Node 实现一致。
func ParentRemotePath(value, dialect string) string {
	current := strings.TrimSpace(value)
	if IsWindowsDialect(dialect) || IsWindowsPath(current) {
		normalized := trimRightSet(current, "\\/")
		index := strings.LastIndexAny(normalized, "\\/")
		if index < 0 {
			return normalized
		}
		return normalized[:index]
	}
	if current == "/" || current == "" {
		return "/"
	}
	trimmed := trimRightSet(current, "/")
	index := strings.LastIndex(trimmed, "/")
	if index <= 0 {
		return "/"
	}
	return trimmed[:index]
}

// NormalizeType 把 GNU stat %F、BSD stat %HT 与 PowerShell 的 d/f/l 统一成 d / f / l。
func NormalizeType(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	switch {
	case text == "d" || text == "directory":
		return "d"
	case text == "l" || strings.Contains(text, "symbolic") || strings.Contains(text, "link"):
		return "l"
	default:
		return "f"
	}
}

// DirEntry 是 dialect.listDir 的一行：type\tsize\tmtime\tname。
type DirEntry struct {
	Name  string
	Type  string
	Size  int64
	Mtime int64
}

// ParseListDirOutput 解析列目录输出；少于四个字段（没有名字）的行被丢弃，与 Node 一致。
func ParseListDirOutput(stdout string) []DirEntry {
	entries := make([]DirEntry, 0)
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		entry := DirEntry{Type: NormalizeType(parts[0])}
		if len(parts) > 1 {
			entry.Size = parseNumber(parts[1])
		}
		if len(parts) > 2 {
			entry.Mtime = parseNumber(parts[2])
		}
		if len(parts) > 3 {
			entry.Name = parts[3]
		}
		if entry.Name == "" || entry.Name == "." || entry.Name == ".." {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

// BrowseError 是浏览失败的结构化错误，Code 与 Node 的 error.code 对齐。
type BrowseError struct {
	Code    string
	Message string
}

func (err *BrowseError) Error() string {
	if err == nil {
		return ""
	}
	return err.Message
}

// ClassifyBrowseFailure 把远端命令的退出码与 stderr 归到 not_found / permission_denied / remote_io_error。
func ClassifyBrowseFailure(code int, stderr string) *BrowseError {
	text := strings.TrimSpace(stderr)
	lower := strings.ToLower(text)
	if code == 3 || strings.Contains(text, "NOENT") {
		return &BrowseError{Code: "not_found", Message: "目录不存在或不可访问。"}
	}
	if strings.Contains(lower, "permission denied") ||
		(strings.Contains(lower, "access") && strings.Contains(lower, "denied")) {
		return &BrowseError{Code: "permission_denied", Message: "没有权限访问该目录。"}
	}
	message := text
	if message == "" {
		message = "连接远程服务器失败。"
	}
	return &BrowseError{Code: "remote_io_error", Message: message}
}

// Profile 是远端机器的环境事实：家目录与方言。
type Profile struct {
	Home    string
	Dialect string
}

// ExecResult 是远端命令执行结果。
type ExecResult struct {
	Code   int
	Stdout string
	Stderr string
}

// BrowseMachine 是本包对 remote-workspace 连接池的最小依赖。
//
// Node 侧直接调用 RemoteWorkspaceService.machine(id).profile() / machine.exec(...)；
// Go 侧由调用方适配，测试用 fake 实现。
type BrowseMachine interface {
	Profile(ctx context.Context) (Profile, error)
	Exec(ctx context.Context, command string, timeout time.Duration, lane string) (ExecResult, error)
}

// Directory 是浏览结果里的一项；Path 已经按方言拼好。
type Directory struct {
	Name string
	Path string
}

// BrowseResult 是列目录的展示结果。
type BrowseResult struct {
	CurrentDir  string
	ParentDir   string
	Directories []Directory
}

// BrowseDirectories 列出一台远端机器上某个目录下的子目录。
//
// 对应 Node 的 browseRemoteDirectories：解析路径 → 执行 dialect.listDir → 只留目录 → 排序。
func BrowseDirectories(
	ctx context.Context,
	machine BrowseMachine,
	subDir string,
	timeout time.Duration,
) (BrowseResult, error) {
	if machine == nil {
		return BrowseResult{}, &BrowseError{Code: "remote_io_error", Message: "连接远程服务器失败。"}
	}
	facts, err := machine.Profile(ctx)
	if err != nil {
		return BrowseResult{}, err
	}
	dialect := facts.Dialect
	if strings.TrimSpace(dialect) == "" {
		dialect = DialectPOSIX
	}
	currentDir := ResolveBrowsePath(subDir, facts.Home, dialect)
	if timeout <= 0 {
		timeout = DefaultBrowseTimeout
	}
	result, err := machine.Exec(ctx, ListDirCommand(dialect, currentDir), timeout, "interactive")
	if err != nil {
		return BrowseResult{}, err
	}
	if result.Code != 0 {
		return BrowseResult{}, ClassifyBrowseFailure(result.Code, result.Stderr)
	}
	directories := make([]Directory, 0)
	for _, entry := range ParseListDirOutput(result.Stdout) {
		if entry.Type != "d" {
			continue
		}
		directories = append(directories, Directory{
			Name: entry.Name,
			Path: JoinRemotePath(currentDir, entry.Name, dialect),
		})
	}
	sort.SliceStable(directories, func(left, right int) bool {
		return strings.Compare(directories[left].Name, directories[right].Name) < 0
	})
	return BrowseResult{
		CurrentDir:  currentDir,
		ParentDir:   ParentRemotePath(currentDir, dialect),
		Directories: directories,
	}, nil
}

// ListDirCommand 构造列目录命令：每行 type\tsize\tmtime\tname。
func ListDirCommand(dialect, absPath string) string {
	if IsWindowsDialect(dialect) {
		script := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; $d=%s; if (-not (Test-Path -LiteralPath $d -PathType Container)) { [Console]::Error.Write('NOENT'); exit 3 }; "+
				"Get-ChildItem -LiteralPath $d -Force | ForEach-Object { $t = if ($_.LinkType) {'l'} elseif ($_.PSIsContainer) {'d'} else {'f'}; "+
				"$s = if ($_.PSIsContainer) {0} else {$_.Length}; $m=[int][double]::Parse((Get-Date $_.LastWriteTimeUtc -UFormat %%s)); "+
				"[Console]::Out.WriteLine(\"$t`t$s`t$m`t$($_.Name)\") }",
			PSQuote(absPath),
		)
		return EncodePowerShellScript(script)
	}
	return "d=" + ShellQuote(absPath) + "; [ -d \"$d\" ] || { echo NOENT >&2; exit 3; }; cd \"$d\" || exit 3; " +
		"set --; for n in * .[!.]* ..?*; do { [ -e \"$n\" ] || [ -L \"$n\" ]; } && set -- \"$@\" \"$n\"; done; [ $# -eq 0 ] && exit 0; " +
		"if stat -c %s . >/dev/null 2>&1; then stat --printf '%F\\t%s\\t%Y\\t%n\\n' -- \"$@\"; else stat -f '%HT%t%z%t%m%t%N' -- \"$@\"; fi 2>/dev/null; exit 0"
}

func trimRightSet(value, cutset string) string {
	return strings.TrimRight(value, cutset)
}

func trimLeftSet(value, cutset string) string {
	return strings.TrimLeft(value, cutset)
}

// parseNumber 复刻 JS Number(x) || 0 的宽松行为：解析不了就当 0。
func parseNumber(value string) int64 {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || number != number { // NaN 自比较为假
		return 0
	}
	return int64(number)
}
