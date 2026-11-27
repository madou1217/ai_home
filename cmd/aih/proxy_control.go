package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxycontrol"
)

const controlFileVersion = 1

type proxyControlAction struct {
	kind    string
	enabled bool
	reply   chan proxyControlResult
}

type proxyControlResult struct {
	status proxycontrol.Status
	err    error
}

// proxyControlHub relays dashboard/WebUI commands into the serve loop.
type proxyControlHub struct {
	home      string
	commands  chan proxyControlAction
	hotSwap   *atomic.Bool
	available bool

	mu     sync.RWMutex
	status proxycontrol.Status
}

func newProxyControlHub(home string, hotSwap *atomic.Bool, available bool) *proxyControlHub {
	return &proxyControlHub{
		home:      home,
		commands:  make(chan proxyControlAction, 4),
		hotSwap:   hotSwap,
		available: available,
		status: proxycontrol.Status{
			Running:          true,
			PID:              os.Getpid(),
			HotSwap:          hotSwap != nil && hotSwap.Load(),
			HotSwapAvailable: available,
			UpdatedAtMs:      time.Now().UnixMilli(),
		},
	}
}

func (hub *proxyControlHub) setStatus(status proxycontrol.Status) {
	if hub == nil {
		return
	}
	status.PID = os.Getpid()
	status.Running = true
	status.HotSwapAvailable = hub.available
	status.HotSwap = hub.hotSwap != nil && hub.hotSwap.Load()
	status.UpdatedAtMs = time.Now().UnixMilli()
	hub.mu.Lock()
	hub.status = status
	hub.mu.Unlock()
}

func (hub *proxyControlHub) snapshot() proxycontrol.Status {
	if hub == nil {
		return proxycontrol.Status{}
	}
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	status := hub.status
	status.HotSwap = hub.hotSwap != nil && hub.hotSwap.Load()
	status.HotSwapAvailable = hub.available
	return status
}

func (hub *proxyControlHub) request(ctx context.Context, kind string, enabled bool) (proxycontrol.Status, error) {
	if hub == nil {
		return proxycontrol.Status{}, errors.New("代理控制未启用")
	}
	reply := make(chan proxyControlResult, 1)
	select {
	case hub.commands <- proxyControlAction{kind: kind, enabled: enabled, reply: reply}:
	case <-ctx.Done():
		return hub.snapshot(), ctx.Err()
	case <-time.After(5 * time.Second):
		return hub.snapshot(), errors.New("代理控制通道繁忙")
	}
	select {
	case result := <-reply:
		return result.status, result.err
	case <-ctx.Done():
		return hub.snapshot(), ctx.Err()
	case <-time.After(25 * time.Second):
		return hub.snapshot(), errors.New("代理操作超时")
	}
}

// serve binds a loopback control endpoint and publishes its token to a 0600
// file. Cleanup is idempotent and only removes the file written by this PID.
func (hub *proxyControlHub) serve(ctx context.Context) (func(), error) {
	if hub == nil || strings.TrimSpace(hub.home) == "" {
		return func() {}, nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	token, err := randomControlToken()
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	server := &http.Server{
		Handler:           hub.handler(token),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = server.Serve(listener) }()

	path := proxycontrol.ControlPath(hub.home)
	var writeErr error
	for attempt := 0; attempt < 15; attempt++ {
		writeErr = writeControlFile(path, controlFileVersion, os.Getpid(), "http://"+listener.Addr().String(), token)
		if writeErr == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if writeErr != nil {
		_ = server.Close()
		return nil, writeErr
	}
	cleanup := func() {
		_ = server.Close()
		removeControlFile(path, os.Getpid())
	}
	go func() {
		<-ctx.Done()
		cleanup()
	}()
	return cleanup, nil
}

func (hub *proxyControlHub) handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(writer http.ResponseWriter, request *http.Request) {
		if !validControlToken(request, token) {
			writeControlJSON(writer, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		if request.Method != http.MethodGet {
			writeControlJSON(writer, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		writeControlJSON(writer, http.StatusOK, map[string]any{"ok": true, "status": hub.snapshot()})
	})
	mux.HandleFunc("/renew", func(writer http.ResponseWriter, request *http.Request) {
		if !validControlToken(request, token) {
			writeControlJSON(writer, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		if request.Method != http.MethodPost {
			writeControlJSON(writer, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		status, err := hub.request(request.Context(), "renew", false)
		writeControlResult(writer, status, err)
	})
	mux.HandleFunc("/hot-swap", func(writer http.ResponseWriter, request *http.Request) {
		if !validControlToken(request, token) {
			writeControlJSON(writer, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		if request.Method != http.MethodPost {
			writeControlJSON(writer, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		var payload struct {
			Enabled bool `json:"enabled"`
		}
		if json.NewDecoder(http.MaxBytesReader(writer, request.Body, 4096)).Decode(&payload) != nil {
			writeControlJSON(writer, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
			return
		}
		status, err := hub.request(request.Context(), "hot-swap", payload.Enabled)
		writeControlResult(writer, status, err)
	})
	return mux
}

func writeControlResult(writer http.ResponseWriter, status proxycontrol.Status, err error) {
	if err != nil {
		writeControlJSON(writer, http.StatusConflict, map[string]any{"ok": false, "error": "proxy_control_failed", "message": err.Error(), "status": status})
		return
	}
	writeControlJSON(writer, http.StatusOK, map[string]any{"ok": true, "status": status})
}

func writeControlJSON(writer http.ResponseWriter, code int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(code)
	_ = json.NewEncoder(writer).Encode(payload)
}

func validControlToken(request *http.Request, token string) bool {
	if request == nil || token == "" {
		return false
	}
	provided := request.Header.Get("X-AIH-Control")
	if len(provided) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func randomControlToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func writeControlFile(path string, version, pid int, url, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// A second serve instance (temporary CLI on another port) must not steal the
	// resident entry's control file. Only replace a file whose publisher is gone.
	if raw, err := os.ReadFile(path); err == nil {
		var existing struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(raw, &existing) == nil && existing.PID > 0 &&
			existing.PID != pid && processAlive(existing.PID) {
			return errors.New("另一个代理入口正在使用控制端点")
		}
	}
	raw, err := json.Marshal(map[string]any{"version": version, "pid": pid, "url": url, "token": token})
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func removeControlFile(path string, pid int) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var file struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(raw, &file) != nil || file.PID != pid {
		return
	}
	_ = os.Remove(path)
}

func proxyHotSwapAvailable(options proxyServeOptions) bool {
	// Authenticated client URLs embed the lease token; swapping it would leave
	// existing clients presenting the old one. TUN owns its own upstream.
	return options.anonymous && !options.tun
}
