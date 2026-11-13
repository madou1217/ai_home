package webuiremoteworkspace

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	// DialectPOSIX 是 Linux / macOS 等 POSIX 远端命令方言。
	DialectPOSIX = "posix"
	// DialectPowerShell 是 Windows OpenSSH PowerShell 方言。
	DialectPowerShell = "powershell"

	// DetectCommand 与 Node remote-workspace/ops/dialect.js 完全一致。
	DetectCommand = `uname -s 2>/dev/null && echo AIH_POSIX || powershell -NoProfile -Command "Write-Output AIH_WINDOWS"`
)

var lineColSuffixPattern = regexp.MustCompile(`:\d+(?::\d+)?$`)

// RemoteError 携带稳定错误码与 HTTP 状态，方便传输层直接写响应。
type RemoteError struct {
	Status  int
	Code    string
	Message string
}

func (err *RemoteError) Error() string {
	if err == nil {
		return ""
	}
	if strings.TrimSpace(err.Message) != "" {
		return err.Message
	}
	return err.Code
}

// Entry 表示远端目录列表中的一项。
type Entry struct {
	Name  string
	Type  string // "d" / "f" / "l"
	Size  int64
	Mtime int64 // Unix 秒
}

// StatInfo 表示远端文件或目录的元数据。
type StatInfo struct {
	Type  string // "d" / "f"
	Size  int64
	Mtime int64 // Unix 秒
}

// StripLineColSuffix 去掉文件引用的 :line[:col] 后缀。
func StripLineColSuffix(raw string) string {
	return lineColSuffixPattern.ReplaceAllString(strings.TrimSpace(raw), "")
}

// RelativePathFromShadow 将影子目录绝对路径或相对路径转为规范工作区相对路径。
func RelativePathFromShadow(shadowRoot, rawPath string) (string, error) {
	value := StripLineColSuffix(rawPath)
	if value == "" {
		return "", nil
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", &RemoteError{Status: http.StatusForbidden, Code: "invalid_path", Message: "非法路径"}
	}
	if filepath.IsAbs(value) {
		rel, err := filepath.Rel(shadowRoot, value)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return "", &RemoteError{Status: http.StatusForbidden, Code: "path_escape", Message: "只允许读取远程工作区内的文件"}
		}
		if rel == "." {
			return "", nil
		}
		return NormalizeRelativePath(filepath.ToSlash(rel))
	}
	return NormalizeRelativePath(value)
}

// NormalizeRelativePath 校验工作区相对路径不含越界段与非法字符。
func NormalizeRelativePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || value == "." {
		return "", nil
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", &RemoteError{Status: http.StatusForbidden, Code: "invalid_path", Message: "非法路径"}
	}
	slashed := strings.ReplaceAll(value, `\`, `/`)
	if strings.HasPrefix(slashed, "/") {
		return "", &RemoteError{Status: http.StatusForbidden, Code: "invalid_path", Message: "必须提供项目内的相对路径"}
	}
	cleaned := path.Clean(slashed)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", &RemoteError{Status: http.StatusForbidden, Code: "path_escape", Message: "只允许读取远程工作区内的文件"}
	}
	return cleaned, nil
}

// JoinRemotePath 按方言将相对路径拼到远端工作区根目录下。
func JoinRemotePath(dialect, root, rel string) string {
	cleanRel := strings.TrimSpace(rel)
	if dialect == DialectPowerShell {
		trimmedRoot := strings.TrimRight(strings.TrimSpace(root), `/\`)
		if cleanRel == "" || cleanRel == "." {
			return trimmedRoot
		}
		winRel := strings.ReplaceAll(strings.TrimLeft(cleanRel, `/\`), `/`, `\`)
		return trimmedRoot + `\` + winRel
	}
	trimmedRoot := strings.TrimRight(strings.TrimSpace(root), "/")
	if trimmedRoot == "" {
		trimmedRoot = "/"
	}
	if cleanRel == "" || cleanRel == "." {
		return trimmedRoot
	}
	return trimmedRoot + "/" + strings.TrimLeft(cleanRel, "/")
}

// QuotePOSIX 用单引号安全转义 POSIX shell 参数。
func QuotePOSIX(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// QuotePS 用单引号安全转义 PowerShell 字面量。
func QuotePS(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// EncodePowerShell 将 PowerShell 脚本编码为 -EncodedCommand 调用。
func EncodePowerShell(script string) string {
	runes := utf16.Encode([]rune(script))
	raw := make([]byte, len(runes)*2)
	for index, r := range runes {
		raw[index*2] = byte(r)
		raw[index*2+1] = byte(r >> 8)
	}
	return "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(raw)
}

// BuildStatCommand 构造远端 stat 命令。
func BuildStatCommand(dialect, absPath string) string {
	if dialect == DialectPowerShell {
		script := fmt.Sprintf(
			"$f=%s; if (-not (Test-Path -LiteralPath $f)) { [Console]::Error.Write('NOENT'); exit 3 }; "+
				"$i=Get-Item -LiteralPath $f; $t = if ($i.PSIsContainer) {'d'} else {'f'}; "+
				"$s = if ($i.PSIsContainer) {0} else {$i.Length}; "+
				"[Console]::Out.Write(\"$t $s $([int][double]::Parse((Get-Date $i.LastWriteTimeUtc -UFormat %%s)))\")",
			QuotePS(absPath),
		)
		return EncodePowerShell(script)
	}
	return fmt.Sprintf(
		`f=%s; [ -e "$f" ] || { echo NOENT >&2; exit 3; }; `+
			`if [ -d "$f" ]; then t=d; else t=f; fi; `+
			`s=$(stat -c '%%s %%Y' "$f" 2>/dev/null || stat -f '%%z %%m' "$f"); printf '%%s %%s' "$t" "$s"`,
		QuotePOSIX(absPath),
	)
}

// BuildListDirCommand 构造远端列目录命令。
func BuildListDirCommand(dialect, absPath string) string {
	if dialect == DialectPowerShell {
		script := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; $d=%s; if (-not (Test-Path -LiteralPath $d -PathType Container)) { [Console]::Error.Write('NOENT'); exit 3 }; "+
				"Get-ChildItem -LiteralPath $d -Force | ForEach-Object { "+
				"$t = if ($_.LinkType) {'l'} elseif ($_.PSIsContainer) {'d'} else {'f'}; "+
				"$s = if ($_.PSIsContainer) {0} else {$_.Length}; "+
				"$m=[int][double]::Parse((Get-Date $_.LastWriteTimeUtc -UFormat %%s)); "+
				"[Console]::Out.WriteLine(\"$t`t$s`t$m`t$($_.Name)\") }",
			QuotePS(absPath),
		)
		return EncodePowerShell(script)
	}
	return fmt.Sprintf(
		`d=%s; [ -d "$d" ] || { echo NOENT >&2; exit 3; }; cd "$d" || exit 3; `+
			`set --; for n in * .[!.]* ..?*; do { [ -e "$n" ] || [ -L "$n" ]; } && set -- "$@" "$n"; done; [ $# -eq 0 ] && exit 0; `+
			`if stat -c %%s . >/dev/null 2>&1; then stat --printf '%%F\t%%s\t%%Y\t%%n\n' -- "$@"; else stat -f '%%HT%%t%%z%%t%%m%%t%%N' -- "$@"; fi 2>/dev/null; exit 0`,
		QuotePOSIX(absPath),
	)
}

// BuildReadFileCommand 构造远端 base64 读文件命令（第一行输出 size mtime）。
func BuildReadFileCommand(dialect, absPath string) string {
	if dialect == DialectPowerShell {
		script := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; $f=%s; if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { [Console]::Error.Write('NOENT'); exit 3 }; "+
				"$i=Get-Item -LiteralPath $f; "+
				"[Console]::Out.WriteLine(\"$($i.Length) $([int][double]::Parse((Get-Date $i.LastWriteTimeUtc -UFormat %%s)))\"); "+
				"[Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes($f)))",
			QuotePS(absPath),
		)
		return EncodePowerShell(script)
	}
	return fmt.Sprintf(
		`f=%s; [ -f "$f" ] || { echo NOENT >&2; exit 3; }; `+
			`(stat -c '%%s %%Y' "$f" 2>/dev/null || stat -f '%%z %%m' "$f"); base64 < "$f" | tr -d '\n'`,
		QuotePOSIX(absPath),
	)
}

// BuildGitCommand 构造在远端工作区根目录执行 git 参数向量的命令。
func BuildGitCommand(dialect, rootPath string, args []string) string {
	if dialect == DialectPowerShell {
		quotedArgs := make([]string, 0, len(args)+1)
		quotedArgs = append(quotedArgs, "git")
		for _, arg := range args {
			quotedArgs = append(quotedArgs, QuotePS(arg))
		}
		script := fmt.Sprintf(
			"Set-Location -LiteralPath %s; & %s",
			QuotePS(rootPath),
			strings.Join(quotedArgs, " "),
		)
		return EncodePowerShell(script)
	}
	quotedArgs := make([]string, 0, len(args)+1)
	quotedArgs = append(quotedArgs, "git")
	for _, arg := range args {
		quotedArgs = append(quotedArgs, QuotePOSIX(arg))
	}
	return fmt.Sprintf("cd %s && %s", QuotePOSIX(rootPath), strings.Join(quotedArgs, " "))
}

// ParseDetectOutput 识别 DetectCommand 输出的远端方言。
func ParseDetectOutput(stdout string) (string, bool) {
	if strings.Contains(stdout, "AIH_POSIX") {
		return DialectPOSIX, true
	}
	if strings.Contains(stdout, "AIH_WINDOWS") {
		return DialectPowerShell, true
	}
	return "", false
}

// ParseStatOutput 解析 stat 命令输出（type size mtime）。
func ParseStatOutput(stdout string) (StatInfo, error) {
	fields := strings.Fields(strings.TrimSpace(stdout))
	if len(fields) < 1 {
		return StatInfo{}, &RemoteError{Status: http.StatusBadGateway, Code: "remote_io_error", Message: "远端 stat 输出为空"}
	}
	kind := "f"
	if fields[0] == "d" {
		kind = "d"
	}
	var size, mtime int64
	if len(fields) >= 2 {
		size, _ = strconv.ParseInt(fields[1], 10, 64)
	}
	if len(fields) >= 3 {
		mtime, _ = strconv.ParseInt(fields[2], 10, 64)
	}
	return StatInfo{Type: kind, Size: size, Mtime: mtime}, nil
}

// ParseListDirOutput 解析列目录输出（每行 type\tsize\tmtime\tname）。
func ParseListDirOutput(stdout string) []Entry {
	lines := strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n")
	entries := make([]Entry, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		name := parts[3]
		if name == "" || name == "." || name == ".." {
			continue
		}
		size, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		mtime, _ := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		entries = append(entries, Entry{
			Name:  name,
			Type:  normalizeEntryType(parts[0]),
			Size:  size,
			Mtime: mtime,
		})
	}
	return entries
}

// ParseReadFileOutput 解析 readFile 的两段输出并按 maxBytes 截断检查。
func ParseReadFileOutput(stdout string, truncated bool, maxBytes int64) ([]byte, int64, int64, error) {
	if truncated {
		return nil, 0, 0, &RemoteError{Status: http.StatusRequestEntityTooLarge, Code: "too_large", Message: "文件过大"}
	}
	normalized := strings.ReplaceAll(stdout, "\r\n", "\n")
	newline := strings.IndexByte(normalized, '\n')
	if newline < 0 {
		return nil, 0, 0, &RemoteError{Status: http.StatusBadGateway, Code: "remote_io_error", Message: "远端文件响应格式异常"}
	}
	headerFields := strings.Fields(normalized[:newline])
	var size, mtime int64
	if len(headerFields) >= 1 {
		size, _ = strconv.ParseInt(headerFields[0], 10, 64)
	}
	if len(headerFields) >= 2 {
		mtime, _ = strconv.ParseInt(headerFields[1], 10, 64)
	}
	if maxBytes > 0 && size > maxBytes {
		return nil, size, mtime, &RemoteError{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    "too_large",
			Message: fmt.Sprintf("文件过大（%d 字节）", size),
		}
	}
	encoded := strings.TrimSpace(normalized[newline+1:])
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, size, mtime, &RemoteError{Status: http.StatusBadGateway, Code: "remote_io_error", Message: "解码远端文件内容失败"}
	}
	if maxBytes > 0 && int64(len(raw)) > maxBytes {
		return nil, int64(len(raw)), mtime, &RemoteError{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    "too_large",
			Message: fmt.Sprintf("文件过大（%d 字节）", len(raw)),
		}
	}
	if size == 0 {
		size = int64(len(raw))
	}
	return raw, size, mtime, nil
}

func normalizeEntryType(raw string) string {
	lower := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case lower == "d" || lower == "directory":
		return "d"
	case lower == "l" || strings.Contains(lower, "symbolic"):
		return "l"
	default:
		return "f"
	}
}
