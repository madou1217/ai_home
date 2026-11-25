// Package launcherd supervises the embedded Linux GTK4 AIH Launch panel,
// manages build caching, speaks the line-based stdio protocol, and provides
// Unix socket control plus XDG autostart integration.
package launcherd

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

const (
	// EnvLauncherMarker is exported to the GTK child process (§8.4).
	EnvLauncherMarker = "AIH_LAUNCHER"
	// EnvSocketPath configures the Unix control socket path.
	EnvSocketPath = "AIH_LAUNCH_SOCKET"

	socketDialTimeout = 2 * time.Second
)

// Status reports the Linux desktop launcher supervisor and GTK panel state.
type Status struct {
	Supported    bool   `json:"supported"`
	Built        bool   `json:"built"`
	BinaryPath   string `json:"binaryPath,omitempty"`
	PID          int    `json:"pid"`
	DesktopError string `json:"desktopError,omitempty"`
	Autostart    bool   `json:"autostart"`
}

// Options configures a launcherd supervisor instance.
type Options struct {
	AIHomeDir  string
	SocketPath string
	Service    *launcher.Service
	LogOutput  io.Writer
}

// DefaultSocketPath returns the control Unix socket path:
// $AIH_LAUNCH_SOCKET -> $XDG_RUNTIME_DIR/aih-launch.sock -> /tmp/aih-launch-<uid>.sock.
func DefaultSocketPath() string {
	if env := strings.TrimSpace(os.Getenv(EnvSocketPath)); env != "" {
		return env
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR")); xdg != "" {
		return filepath.Join(xdg, "aih-launch.sock")
	}
	return filepath.Join(os.TempDir(), "aih-launch-"+strconv.Itoa(os.Getuid())+".sock")
}

// SendCommand sends a single control command ("toggle", "show", "hide", "ping")
// to the running GTK launcher over its Unix domain socket.
func SendCommand(ctx context.Context, socketPath string, command string) error {
	path := strings.TrimSpace(socketPath)
	if path == "" {
		path = DefaultSocketPath()
	}
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return fmt.Errorf("%w: empty launcher socket command", launcher.ErrInvalidInput)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	dialer := &net.Dialer{Timeout: socketDialTimeout}
	conn, err := dialer.DialContext(ctx, "unix", path)
	if err != nil {
		return fmt.Errorf("%w: 无法连接启动器控制 socket (%s): %v", launcher.ErrUnavailable, path, err)
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(socketDialTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetDeadline(deadline)

	if _, err := io.WriteString(conn, cmd+"\n"); err != nil {
		return fmt.Errorf("写入启动器命令 %q 失败: %w", cmd, err)
	}
	reader := bufio.NewReader(conn)
	reply, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("读取启动器响应失败: %w", err)
	}
	trimmed := strings.TrimSpace(reply)
	if trimmed != "" && trimmed != "ok" && trimmed != "pong" {
		return fmt.Errorf("启动器拒绝命令 %q: %s", cmd, trimmed)
	}
	return nil
}

// ProbeSocket checks whether a launcher UI instance is actively listening on socketPath.
func ProbeSocket(ctx context.Context, socketPath string) bool {
	return SendCommand(ctx, socketPath, "ping") == nil
}

// FormatWireApp encodes a single App into the §8.4/§9 LAUNCH1 wire protocol line.
// Base fields match the 8-column spec; aliases (when present) are appended as a 9th column.
func FormatWireApp(app launcher.App) string {
	termFlag := "0"
	if app.Terminal {
		termFlag = "1"
	}
	base := fmt.Sprintf(
		"LAUNCH1\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
		encodeBase64(app.ID),
		encodeBase64(app.Name),
		encodeBase64(app.Subtitle),
		encodeBase64(app.Icon),
		encodeBase64(string(app.Kind)),
		termFlag,
		encodeBase64(app.Path),
	)
	if len(app.Aliases) == 0 {
		return base
	}
	return base + "\t" + encodeBase64(strings.Join(app.Aliases, "\x1f"))
}

func encodeBase64(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func decodeBase64(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
