package codexlocalappserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

type handler struct {
	ctx    context.Context
	config Config
	env    []string
	slots  chan struct{}
}

func newHandler(ctx context.Context, config Config, env []string) (*handler, error) {
	if strings.TrimSpace(config.Command) == "" || !filepath.IsAbs(config.Cwd) || len(config.AuthToken) < 32 || len(config.AuthToken) > 8192 || strings.ContainsAny(config.AuthToken, "\r\n\x00") {
		return nil, errors.New("local_app_server_options_invalid")
	}
	if info, err := os.Stat(config.Cwd); err != nil || !info.IsDir() {
		return nil, errors.New("local_app_server_cwd_invalid")
	}
	cleanEnv := make([]string, 0, len(env))
	for _, value := range env {
		if strings.HasPrefix(value, "AIH_CODEX_LOCAL_REMOTE_TOKEN=") || strings.HasPrefix(value, "AIH_CODEX_REMOTE_AUTH_TOKEN=") {
			continue
		}
		cleanEnv = append(cleanEnv, value)
	}
	return &handler{ctx: ctx, config: config, env: cleanEnv, slots: make(chan struct{}, 8)}, nil
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/" || request.URL.RawQuery != "" {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodGet {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if request.Header.Get("Origin") != "" {
		http.Error(response, "local_app_server_cli_only", http.StatusForbidden)
		return
	}
	fields := strings.Fields(request.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || subtle.ConstantTimeCompare([]byte(fields[1]), []byte(h.config.AuthToken)) != 1 {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !codexappserverapi.IsUpgradeRequest(request) {
		http.Error(response, "upgrade_required", http.StatusUpgradeRequired)
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		http.Error(response, "local_app_server_busy", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stopHost := context.AfterFunc(h.ctx, cancel)
	defer stopHost()
	process, err := codexappserverws.StartAppServerProcess(codexappserverws.StartProcessOptions{Command: h.config.Command, Args: h.config.Args, Env: h.env, Dir: h.config.Cwd, WindowsVerbatim: h.config.WindowsVerbatim})
	if err != nil {
		http.Error(response, "local_app_server_start_failed", http.StatusBadGateway)
		return
	}
	defer process.Close()
	if err = process.WaitForStartup(ctx, 150*time.Millisecond); err != nil {
		http.Error(response, "local_app_server_start_failed", http.StatusBadGateway)
		return
	}
	controller := http.NewResponseController(response)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(response, request, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	stdio := &codexappserverapi.StdioSession{Stdin: process.Stdin(), Stdout: process.Stdout(), Stderr: process.Stderr(), Wait: func() error { <-process.Done(); return process.WaitErr() }, Close: func() error { process.Close(); return nil }}
	codexappserverapi.BridgeAppServerStdio(ctx, conn, stdio, codexappserverapi.StdioBridgeOptions{Rewrite: codexappserverws.RewriteOptions{Cwd: h.config.Cwd, SkipInjectCwd: !h.config.InjectCwd}})
}
