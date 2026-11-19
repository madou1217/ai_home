package sshbridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// DefaultClipAgentPort 是 SSH RemoteForward 剪贴板代理的默认端口。
const DefaultClipAgentPort = 17652

// ClipAgentOptions 是 `aih clip-agent start` 的参数。
type ClipAgentOptions struct {
	Action   string
	Host     string
	Port     int
	MaxBytes int
	Help     bool
}

func parsePositive(value string, fallback int) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return fallback
	}
	return number
}

// ParseClipAgentArgs 解析 `clip-agent` 之后的参数（首个非选项词是动作）。
func ParseClipAgentArgs(arguments []string) ClipAgentOptions {
	options := ClipAgentOptions{Action: "start", Host: "127.0.0.1", Port: DefaultClipAgentPort, MaxBytes: DefaultMaxBytes}
	if len(arguments) > 0 {
		if action := strings.TrimSpace(arguments[0]); action != "" && !strings.HasPrefix(action, "-") {
			options.Action = action
		}
	}
	for index := 0; index < len(arguments); index++ {
		token := arguments[index]
		switch token {
		case "--host":
			if index+1 < len(arguments) {
				if value := strings.TrimSpace(arguments[index+1]); value != "" {
					options.Host = value
				}
			}
			index++
		case "--port":
			if index+1 < len(arguments) {
				options.Port = parsePositive(arguments[index+1], options.Port)
			}
			index++
		case "--max-bytes", "--clip-max-bytes":
			if index+1 < len(arguments) {
				options.MaxBytes = parsePositive(arguments[index+1], options.MaxBytes)
			}
			index++
		case "--help", "-h", "help":
			options.Help = true
		}
	}
	return options
}

// ClipAgentHelpText 返回帮助文本。
func ClipAgentHelpText() string {
	text := fmt.Sprintf(`
\x1b[36mAI Home Clip Agent\x1b[0m - Non-zero-client clipboard image provider for SSH RemoteForward

\x1b[33mUsage:\x1b[0m
  aih clip-agent start [--host 127.0.0.1] [--port %d]

\x1b[33mSSH config example:\x1b[0m
  Host my-aih-host
    RemoteForward /tmp/aih-clip-%%r.sock 127.0.0.1:%d
    StreamLocalBindUnlink yes

\x1b[33mPriority:\x1b[0m
  Strict zero-client uses normal SSH plus terminal-native OSC 5522 / OSC 52 only.
  This agent is an explicit non-zero-client fallback. Enable it with AIH_SSH_CLIPBOARD=agent=1.
`, DefaultClipAgentPort, DefaultClipAgentPort)
	return strings.ReplaceAll(text, `\x1b`, "\x1b") + "\n"
}

func writeAgentJSON(writer http.ResponseWriter, status int, payload map[string]any) {
	writer.Header().Set("content-type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	encoded, _ := json.Marshal(payload)
	_, _ = writer.Write(append(encoded, '\n'))
}

// NewClipAgentHandler 构造剪贴板代理 HTTP 处理器。
func NewClipAgentHandler(maxBytes int) http.Handler {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writeAgentJSON(writer, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
			return
		}
		writeAgentJSON(writer, http.StatusOK, map[string]any{"ok": true, "service": "aih-clip-agent"})
	})
	mux.HandleFunc("/image", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writeAgentJSON(writer, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
			return
		}
		limit := maxBytes
		if requested := parsePositive(request.Header.Get("x-aih-clip-max-bytes"), 0); requested > 0 && requested < limit {
			limit = requested
		}
		image, found, err := ReadClipboardImage(limit)
		if err != nil {
			writeAgentJSON(writer, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if !found {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		info, err := ValidateImage(image.Buffer, image.MimeType, limit)
		if err != nil {
			writeAgentJSON(writer, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writer.Header().Set("content-type", info.MimeType)
		writer.Header().Set("content-length", strconv.Itoa(info.Bytes))
		writer.Header().Set("x-aih-clip-sha256", info.SHA256)
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(image.Buffer)
	})
	return mux
}

// RunClipAgentCommand 执行 `aih clip-agent`；start 会阻塞到进程被终止。
func RunClipAgentCommand(arguments []string, stdout, stderr io.Writer) int {
	options := ParseClipAgentArgs(arguments)
	action := options.Action
	if len(arguments) > 0 && (arguments[0] == "--help" || arguments[0] == "-h" || arguments[0] == "help") {
		options.Help = true
	}
	if options.Help || action == "--help" || action == "-h" || action == "help" {
		_, _ = fmt.Fprint(stdout, ClipAgentHelpText())
		return 0
	}
	if action != "start" {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih clip-agent]\x1b[0m unknown action: %s\n", action)
		_, _ = fmt.Fprint(stderr, ClipAgentHelpText())
		return 1
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(options.Host, strconv.Itoa(options.Port)))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih clip-agent]\x1b[0m failed: %v\n", err)
		return 1
	}
	address := listener.Addr().(*net.TCPAddr)
	host := address.IP.String()
	port := address.Port
	_, _ = fmt.Fprintf(stdout, "\x1b[36m[aih clip-agent]\x1b[0m listening on %s:%d\n", host, port)
	_, _ = fmt.Fprintf(stdout, "\x1b[90m[aih clip-agent]\x1b[0m non-zero-client ssh config: RemoteForward /tmp/aih-clip-%%r.sock %s:%d\n", host, port)
	server := &http.Server{Handler: NewClipAgentHandler(options.MaxBytes)}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih clip-agent]\x1b[0m failed: %v\n", err)
		return 1
	}
	return 0
}
