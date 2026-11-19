package sshbridge

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

// DefaultWatchInterval 是剪贴板监视的轮询间隔。
const DefaultWatchInterval = 1200 * time.Millisecond

// ParsedArgs 是 `aih ssh` 自己的选项与透传参数。
type ParsedArgs struct {
	SSHArgs        []string
	RemoteArgs     []string
	WatchClipboard bool
	MaxBytes       int
	ChunkSize      int
}

func parsePositiveInt(value string, fallback int) int {
	number, err := strconv.Atoi(value)
	if err != nil || number <= 0 {
		return fallback
	}
	return number
}

// ParseArgs 解析 `aih ssh` 参数；`--` 之后原样组成远端命令。
func ParseArgs(arguments []string) ParsedArgs {
	parsed := ParsedArgs{MaxBytes: DefaultMaxBytes, ChunkSize: DefaultChunkSize}
	afterSeparator := false
	for index := 0; index < len(arguments); index++ {
		token := arguments[index]
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
			if index+1 < len(arguments) {
				parsed.MaxBytes = parsePositiveInt(arguments[index+1], parsed.MaxBytes)
			}
			index++
		case "--clip-chunk-size", "--aih-clip-chunk-size":
			if index+1 < len(arguments) {
				parsed.ChunkSize = parsePositiveInt(arguments[index+1], parsed.ChunkSize)
			}
			index++
		default:
			parsed.SSHArgs = append(parsed.SSHArgs, token)
		}
	}
	return parsed
}

var safeRemoteArgPattern = regexp.MustCompile(`^[A-Za-z0-9_./:=@%+,-]+$`)

func shellQuoteRemoteArg(value string) string {
	if safeRemoteArgPattern.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// BuildSpawnArgs 把远端命令合并成 ssh 的最后一个参数。
func BuildSpawnArgs(parsed ParsedArgs) []string {
	if len(parsed.RemoteArgs) == 0 {
		return append([]string{}, parsed.SSHArgs...)
	}
	quoted := make([]string, 0, len(parsed.RemoteArgs))
	for _, value := range parsed.RemoteArgs {
		quoted = append(quoted, shellQuoteRemoteArg(value))
	}
	return append(append([]string{}, parsed.SSHArgs...), strings.Join(quoted, " "))
}

// HelpText 是 `aih ssh --help` 的输出。
func HelpText() string {
	text := fmt.Sprintf(`
\x1b[36mAI Home SSH\x1b[0m - SSH wrapper with remote image paste bridge

\x1b[33mUsage:\x1b[0m
  aih ssh [ssh args...] -- aih <cli> [args...]
  aih ssh --watch-clipboard user@host -- aih claude

\x1b[33mImage Paste:\x1b[0m
  Press Alt+V or Ctrl+V in the wrapped SSH session. The client reads this machine's
  clipboard image, sends it through the SSH tty, caches it on the remote host,
  and injects the remote image file path into the active aih PTY.

\x1b[33mOptions:\x1b[0m
  --watch-clipboard       Cache changed clipboard images while the SSH session is open
  --no-watch-clipboard    Disable clipboard watch
  --clip-max-bytes N      Max raw image bytes (default: %d)
  --clip-chunk-size N     Base64 chars per tty frame (default: %d)
`, DefaultMaxBytes, DefaultChunkSize)
	return strings.ReplaceAll(text, `\x1b`, "\x1b") + "\n"
}

func writeStatus(stream io.Writer, message string) {
	if stream == nil {
		return
	}
	_, _ = fmt.Fprintf(stream, "\r\n\x1b[33m[aih ssh]\x1b[0m %s\r\n", message)
}

// Run 执行一次包装后的 SSH 会话，返回进程退出码。
func Run(arguments []string, stdin *os.File, stdout, stderr io.Writer) int {
	for _, argument := range arguments {
		if argument == "--help" || argument == "-h" {
			_, _ = fmt.Fprint(stdout, HelpText())
			return 0
		}
	}
	if len(arguments) == 0 {
		_, _ = fmt.Fprint(stdout, HelpText())
		return 0
	}
	parsed := ParseArgs(arguments)
	if len(parsed.SSHArgs) == 0 {
		_, _ = fmt.Fprintln(stderr, "\x1b[31m[aih ssh]\x1b[0m missing ssh target or arguments.")
		_, _ = fmt.Fprint(stderr, HelpText())
		return 1
	}

	child := exec.Command("ssh", BuildSpawnArgs(parsed)...)
	child.Env = os.Environ()
	child.Stdin = nil
	child.Stdout = stdout
	child.Stderr = stderr
	childInput, err := child.StdinPipe()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih ssh]\x1b[0m failed to start ssh: %v\n", err)
		return 1
	}
	if err := child.Start(); err != nil {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih ssh]\x1b[0m failed to start ssh: %v\n", err)
		return 1
	}

	interactive := stdin != nil && term.IsTerminal(int(stdin.Fd())) && isTerminalWriter(stdout)
	var previousState *term.State
	if interactive {
		if state, stateErr := term.MakeRaw(int(stdin.Fd())); stateErr == nil {
			previousState = state
		}
	}
	cleanup := func() {
		if previousState != nil {
			_ = term.Restore(int(stdin.Fd()), previousState)
		}
	}
	defer cleanup()

	var writeMutex sync.Mutex
	writeFrames := func(action string, image Image) (EncodedFrames, error) {
		encoded, err := EncodeClipboardImageFrames(image, action, parsed.MaxBytes, parsed.ChunkSize)
		if err != nil {
			return EncodedFrames{}, err
		}
		writeMutex.Lock()
		defer writeMutex.Unlock()
		for _, frame := range encoded.Frames {
			if _, err := io.WriteString(childInput, frame); err != nil {
				return EncodedFrames{}, err
			}
		}
		return encoded, nil
	}

	stopWatch := make(chan struct{})
	var watchOnce sync.Once
	stopWatching := func() { watchOnce.Do(func() { close(stopWatch) }) }
	defer stopWatching()

	sendClipboard := func(action, skipSHA string) (Image, bool, error) {
		image, found, err := ReadClipboardImage(parsed.MaxBytes)
		if err != nil || !found {
			return Image{}, false, err
		}
		if skipSHA != "" && image.SHA256 == skipSHA {
			return image, false, nil
		}
		if _, err := writeFrames(action, image); err != nil {
			return image, false, err
		}
		return image, true, nil
	}

	if interactive {
		go func() {
			buffer := make([]byte, 32*1024)
			for {
				count, readErr := stdin.Read(buffer)
				if count > 0 {
					chunk := buffer[:count]
					if IsAltVClipboardTrigger(chunk) || IsCtrlVClipboardTrigger(chunk) {
						image, sent, sendErr := sendClipboard("paste", "")
						if sendErr != nil {
							writeStatus(stderr, "image paste failed: "+sendErr.Error())
						} else if sent {
							writeStatus(stderr, fmt.Sprintf("sent clipboard image (%d bytes)", image.Bytes))
						} else {
							writeStatus(stderr, "clipboard image unavailable on the SSH client")
						}
						continue
					}
					writeMutex.Lock()
					_, _ = childInput.Write(chunk)
					writeMutex.Unlock()
				}
				if readErr != nil {
					_ = childInput.Close()
					return
				}
			}
		}()
	} else if stdin != nil {
		go func() {
			_, _ = io.Copy(childInput, stdin)
			_ = childInput.Close()
		}()
	}

	if parsed.WatchClipboard && interactive {
		go func() {
			ticker := time.NewTicker(DefaultWatchInterval)
			defer ticker.Stop()
			lastSHA := ""
			for {
				select {
				case <-stopWatch:
					return
				case <-ticker.C:
					image, sent, err := sendClipboard("cache", lastSHA)
					if err == nil && image.SHA256 != "" {
						lastSHA = image.SHA256
					}
					_ = sent
				}
			}
		}()
	}

	waitErr := child.Wait()
	stopWatching()
	if interactive && previousState != nil {
		_ = term.Restore(int(stdin.Fd()), previousState)
		previousState = nil
	}
	if waitErr == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(waitErr, &exitError) {
		if exitError.ExitCode() >= 0 {
			return exitError.ExitCode()
		}
		return 128
	}
	_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih ssh]\x1b[0m ssh exited: %v\n", waitErr)
	return 1
}

func isTerminalWriter(writer io.Writer) bool {
	file, ok := writer.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}
