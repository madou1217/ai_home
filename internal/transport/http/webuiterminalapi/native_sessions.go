package webuiterminalapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

const nativeSessionPrefix = "native:"

type directorySession struct {
	SessionKey      string `json:"sessionKey"`
	TermID          string `json:"termId,omitempty"`
	Label           string `json:"label"`
	Provider        string `json:"provider,omitempty"`
	Cwd             string `json:"cwd"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	Source          string `json:"source"`
	Status          string `json:"status"`
}

func nativeSessionKey(row persistent.SessionRow) string {
	digest := sha256.Sum256([]byte(row.Socket + "\x00" + row.Name))
	return nativeSessionPrefix + hex.EncodeToString(digest[:20])
}

func (handler *Handler) nativeRows(ctx context.Context) ([]persistent.SessionRow, error) {
	if handler.nativeSessions == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return handler.nativeSessions.CollectSessions(ctx)
}

func (handler *Handler) handleSessions(response http.ResponseWriter, request *http.Request) {
	rows, err := handler.nativeRows(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_directory_unavailable", "会话清单读取失败，请重试")
		return
	}
	items := make([]directorySession, 0, len(rows))
	for _, row := range rows {
		if row.Name == "" || row.PanePID <= 0 {
			continue
		}
		label := row.Label
		if label == "" {
			label = filepath.Base(row.Path)
		}
		if label == "" {
			label = row.Provider + " · " + row.Name
		}
		label = row.Provider + " · " + label
		if row.NativeID != "" {
			label += " · " + row.NativeID[:min(8, len(row.NativeID))]
		}
		items = append(items, directorySession{SessionKey: nativeSessionKey(row), Label: label,
			Provider: row.Provider, Cwd: row.Path, NativeSessionID: row.NativeID, Source: "native", Status: "running"})
	}
	for _, snapshot := range handler.sessions.List() {
		if snapshot.Key == "" || strings.HasPrefix(snapshot.Key, nativeSessionPrefix) {
			continue
		}
		items = append(items, directorySession{SessionKey: snapshot.Key, TermID: snapshot.ID,
			Label: handler.shellForSnapshot(snapshot), Cwd: snapshot.Dir, Source: "web", Status: string(snapshot.Status)})
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "sessions": items})
}

func nativeMuxCommand() string {
	if runtime.GOOS == "windows" {
		if path, err := exec.LookPath("psmux"); err == nil {
			return path
		}
	}
	return "tmux"
}

// Resolve the opaque key against a fresh server-side inventory. A browser can
// never select an arbitrary socket, session, executable or argument list.
func (handler *Handler) attachNative(response http.ResponseWriter, request *http.Request, key, muxID string) {
	if muxID == "" {
		writeError(response, http.StatusBadRequest, "mux_id_required", "缺少终端视图标识")
		return
	}
	rows, err := handler.nativeRows(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_directory_unavailable", "会话清单读取失败")
		return
	}
	var selected *persistent.SessionRow
	for _, row := range rows {
		if nativeSessionKey(row) == key && row.PanePID > 0 {
			copied := row
			selected = &copied
			break
		}
	}
	if selected == nil {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	cols, rowsCount := 120, 36
	if output, err := exec.CommandContext(ctx, nativeMuxCommand(), "-L", selected.Socket, "display-message", "-p", "-t", "="+selected.Name+":", "#{window_width} #{window_height} #{status}").Output(); err == nil {
		status := "off"
		if n, _ := fmt.Sscanf(string(output), "%d %d %s", &cols, &rowsCount, &status); n >= 2 && status != "off" && status != "0" {
			statusRows, parseErr := strconv.Atoi(status)
			if parseErr != nil {
				statusRows = 1
			}
			rowsCount += statusRows
		}
	}
	cols, rowsCount = normalizeSize(cols, rowsCount)
	// This is only a tmux *client*. Killing or disconnecting this PTY leaves the
	// original provider and all its children alive. Previews cannot shrink it.
	// Each browser mux owns its own tmux client. Other viewers can neither
	// resize nor disconnect this client by leaving or closing their own view.
	viewer := sha256.Sum256([]byte(muxID))
	clientKey := key + "@" + hex.EncodeToString(viewer[:8])
	handler.nativeMu.Lock()
	defer handler.nativeMu.Unlock()
	handler.mu.Lock()
	stream := handler.muxes[muxID]
	handler.mu.Unlock()
	if stream == nil || !stream.hasWatchers() {
		writeError(response, http.StatusServiceUnavailable, "terminal_mux_unavailable", "终端视图正在连接，请重试")
		return
	}
	snapshot, err := handler.sessions.Create(context.Background(), terminalsession.Spec{
		Key: clientKey, Path: nativeMuxCommand(), Args: []string{"-u", "-L", selected.Socket, "attach-session", "-f", "ignore-size", "-t", "=" + selected.Name},
		Dir: handler.resolveCwd(selected.Path), Env: handler.buildTerminalEnv(nil),
		Size: pty.Size{Cols: uint16(cols), Rows: uint16(rowsCount)}, Persistent: true, Durable: true,
	})
	if err != nil {
		if errors.Is(err, terminalsession.ErrTooManySessions) {
			writeError(response, http.StatusTooManyRequests, "too_many_terminals", "终端连接已达上限，请关闭部分视图后重试")
			return
		}
		writeError(response, http.StatusServiceUnavailable, "native_terminal_attach_failed", "无法接入原会话")
		return
	}
	handler.bind(snapshot.ID, muxID, "native")
	handler.mu.Lock()
	if meta := handler.meta[snapshot.ID]; meta != nil {
		meta.nativeSocket = selected.Socket
		meta.nativeSession = selected.Name
	}
	handler.mu.Unlock()
	snapshot.Key = key // Public address is stable across viewer reconnects.
	handler.writeOpenResult(response, &openResult{snapshot: snapshot, shell: "native", muxID: muxID, durable: true}, nil, statusForAttach)
}

func (handler *Handler) handleFocus(response http.ResponseWriter, request *http.Request) {
	var body struct {
		TermID string `json:"termId"`
		Active bool   `json:"active"`
	}
	handler.readJSON(request, handler.maxBody, &body)
	snapshot, err := handler.sessions.Attach(body.TermID)
	if err != nil {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	if !strings.HasPrefix(snapshot.Key, nativeSessionPrefix) {
		writeJSON(response, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	handler.mu.Lock()
	meta := handler.meta[snapshot.ID]
	socket, session := "", ""
	if meta != nil {
		socket, session = meta.nativeSocket, meta.nativeSession
	}
	handler.mu.Unlock()
	if socket == "" || snapshot.ProcessID == 0 {
		writeNativeClientUnavailable(response, "client_identity_pending")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	// launchd can run with the C locale. tmux replaces control separators with
	// underscores there, so use an ASCII delimiter to keep client lookup stable.
	output, err := exec.CommandContext(ctx, nativeMuxCommand(), "-L", socket, "list-clients", "-t", "="+session, "-F", "#{client_pid}|#{client_name}").Output()
	if err != nil {
		writeNativeClientUnavailable(response, "client_lookup_failed")
		return
	}
	if err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			parts := strings.SplitN(line, "|", 2)
			if len(parts) != 2 || parts[0] != strconv.Itoa(snapshot.ProcessID) {
				continue
			}
			flag := "ignore-size"
			if body.Active {
				flag = "!ignore-size"
			}
			err = exec.CommandContext(ctx, nativeMuxCommand(), "-L", socket, "refresh-client", "-t", parts[1], "-f", flag).Run()
			if err == nil {
				writeJSON(response, http.StatusOK, map[string]bool{"ok": true})
				return
			}
			writeNativeClientUnavailable(response, "client_refresh_failed")
			return
		}
	}
	writeNativeClientUnavailable(response, "client_not_found")
}

func writeNativeClientUnavailable(response http.ResponseWriter, reason string) {
	writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": "terminal_client_unavailable", "reason": reason, "message": "终端客户端尚未就绪"})
}
