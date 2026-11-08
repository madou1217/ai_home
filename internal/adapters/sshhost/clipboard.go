package sshhost

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SSH 剪贴板桥的默认参数（对应 Node 的 DEFAULT_* 常量）。
const (
	DefaultWatchInterval = 1200 * time.Millisecond
	DefaultClipMaxBytes  = 16 * 1024 * 1024
	DefaultClipChunkSize = 3072
)

// ParsedSSHArgs 是 aih ssh 的参数拆分结果。
type ParsedSSHArgs struct {
	SSHArgs        []string
	RemoteArgs     []string
	WatchClipboard bool
	MaxBytes       int
	ChunkSize      int
}

var plainRemoteArgPattern = regexp.MustCompile(`^[A-Za-z0-9_./:=@%+,-]+$`)

var (
	altVPattern                 = regexp.MustCompile(`^\x1b[vV]$`)
	altVCSIuPattern             = regexp.MustCompile(`^\x1b\[(86|118);3([:;][0-9]+)*u$`)
	altVModifyOtherKeysPattern  = regexp.MustCompile(`^\x1b\[27;3;(86|118)(;[0-9]+)*~$`)
	ctrlVPattern                = regexp.MustCompile(`^\x16$`)
	ctrlVCSIuPattern            = regexp.MustCompile(`^\x1b\[(86|118);(4|5)([:;][0-9]+)*u$`)
	ctrlVModifyOtherKeysPattern = regexp.MustCompile(`^\x1b\[27;(4|5);(86|118)(;[0-9]+)*~$`)
)

// ParseAihSSHArgs 拆分 aih ssh 的包装参数：-- 之前是 ssh 参数，之后是远端命令。
func ParseAihSSHArgs(args []string) ParsedSSHArgs {
	parsed := ParsedSSHArgs{
		SSHArgs:    make([]string, 0, len(args)),
		RemoteArgs: make([]string, 0),
		MaxBytes:   DefaultClipMaxBytes,
		ChunkSize:  DefaultClipChunkSize,
	}
	afterSeparator := false
	for index := 0; index < len(args); index++ {
		token := args[index]
		if afterSeparator {
			parsed.RemoteArgs = append(parsed.RemoteArgs, token)
			continue
		}
		switch token {
		case "--":
			afterSeparator = true
		case "--watch-clipboard", "--aih-watch-clipboard":
			parsed.WatchClipboard = true
		case "--no-watch-clipboard", "--aih-no-watch-clipboard":
			parsed.WatchClipboard = false
		case "--clip-max-bytes", "--aih-clip-max-bytes":
			parsed.MaxBytes = parsePositiveInt(nextToken(args, index), parsed.MaxBytes)
			index++
		case "--clip-chunk-size", "--aih-clip-chunk-size":
			parsed.ChunkSize = parsePositiveInt(nextToken(args, index), parsed.ChunkSize)
			index++
		default:
			parsed.SSHArgs = append(parsed.SSHArgs, token)
		}
	}
	return parsed
}

// ShellQuoteRemoteArg 给远端命令的单个参数加引号；可打印的安全字符保持原样。
func ShellQuoteRemoteArg(value string) string {
	if plainRemoteArgPattern.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// BuildSSHSpawnArgs 把远端参数拼成 ssh 的最后一个参数（远端 shell 命令串）。
func BuildSSHSpawnArgs(parsed ParsedSSHArgs) []string {
	args := make([]string, 0, len(parsed.SSHArgs)+1)
	args = append(args, parsed.SSHArgs...)
	if len(parsed.RemoteArgs) == 0 {
		return args
	}
	quoted := make([]string, 0, len(parsed.RemoteArgs))
	for _, value := range parsed.RemoteArgs {
		quoted = append(quoted, ShellQuoteRemoteArg(value))
	}
	return append(args, strings.Join(quoted, " "))
}

// IsAltVClipboardTrigger 识别 Alt+V 的各种终端编码。
func IsAltVClipboardTrigger(data []byte) bool {
	text := string(data)
	return altVPattern.MatchString(text) ||
		altVCSIuPattern.MatchString(text) ||
		altVModifyOtherKeysPattern.MatchString(text)
}

// IsCtrlVClipboardTrigger 识别 Ctrl+V 的各种终端编码。
func IsCtrlVClipboardTrigger(data []byte) bool {
	text := string(data)
	return ctrlVPattern.MatchString(text) ||
		ctrlVCSIuPattern.MatchString(text) ||
		ctrlVModifyOtherKeysPattern.MatchString(text)
}

// IsEmptyBracketedPaste 识别空 bracketed paste（部分终端把 Ctrl+V 转成它）。
func IsEmptyBracketedPaste(data []byte) bool {
	return string(data) == "\x1b[200~\x1b[201~"
}

// ExtractBracketedPastePayload 取出 bracketed paste 的内容；不是该形式时返回 false。
func ExtractBracketedPastePayload(data []byte) (string, bool) {
	text := string(data)
	const prefix = "\x1b[200~"
	const suffix = "\x1b[201~"
	if !strings.HasPrefix(text, prefix) || !strings.HasSuffix(text, suffix) {
		return "", false
	}
	return text[len(prefix) : len(text)-len(suffix)], true
}

func nextToken(args []string, index int) string {
	if index+1 >= len(args) {
		return ""
	}
	return args[index+1]
}

// parsePositiveInt 复刻 JS parsePositiveInt：只接受正整数，否则回退。
func parsePositiveInt(value string, fallback int) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return fallback
	}
	return number
}
