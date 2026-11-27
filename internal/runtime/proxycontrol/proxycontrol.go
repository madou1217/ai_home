// Package proxycontrol is the loopback control channel for a running
// `aih proxy serve` process. The CLI dashboard and WebUI use it to renew the
// upstream lease, toggle hot-swap, and read live proxy state.
//
// The control file contains a per-process token and lives under run/ with 0600;
// it is never logged or returned by the management API.
package proxycontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// ControlFile is the published loopback endpoint + token.
	ControlFile = "run/proxy/control.json"
	// tokenHeader avoids putting the control token in query strings or logs.
	tokenHeader = "X-AIH-Control"
)

// Status is the live view of the local proxy entry.
type Status struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	HTTPURL   string `json:"httpUrl,omitempty"`
	SOCKS5URL string `json:"socks5Url,omitempty"`
	LeaseName string `json:"leaseName,omitempty"`
	// Region is the Chinese country/city label derived from LeaseName; empty
	// when the name carries no recognizable geo ("AWS", custom names).
	Region           string `json:"region,omitempty"`
	LeaseActive      bool   `json:"leaseActive"`
	HotSwap          bool   `json:"hotSwap"`
	HotSwapAvailable bool   `json:"hotSwapAvailable"`
	LastRenewAtMs    int64  `json:"lastRenewAtMs,omitempty"`
	LastError        string `json:"lastError,omitempty"`
	Reconnects       int    `json:"reconnects,omitempty"`
	UpdatedAtMs      int64  `json:"updatedAtMs,omitempty"`
}

// Settings is the persisted proxy desk configuration shared by CLI and WebUI.
type Settings struct {
	Version int  `json:"version"`
	HotSwap bool `json:"hotSwap"`
}

// SettingsPath returns the settings file under an AIH home.
func SettingsPath(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", "proxy", "settings.json")
}

// LoadSettings reads the desk settings; missing/corrupt files mean defaults.
func LoadSettings(aiHomeDir string) Settings {
	settings := Settings{Version: 1}
	raw, err := os.ReadFile(SettingsPath(aiHomeDir))
	if err != nil || json.Unmarshal(raw, &settings) != nil || settings.Version != 1 {
		return Settings{Version: 1}
	}
	return settings
}

// SaveSettings atomically persists the desk settings.
func SaveSettings(aiHomeDir string, settings Settings) error {
	path := SettingsPath(aiHomeDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	settings.Version = 1
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// Client talks to one proxy serve control endpoint.
type Client struct {
	base  string
	token string
	http  *http.Client
}

type controlFile struct {
	Version int    `json:"version"`
	PID     int    `json:"pid"`
	URL     string `json:"url"`
	Token   string `json:"token"`
}

// ControlPath returns the control file under an AIH home.
func ControlPath(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), ControlFile)
}

// Load reads the control endpoint; a missing/stopped entry returns an error.
func Load(aiHomeDir string) (*Client, error) {
	raw, err := os.ReadFile(ControlPath(aiHomeDir))
	if err != nil {
		return nil, fmt.Errorf("代理入口控制文件不可用: %w", err)
	}
	var file controlFile
	if json.Unmarshal(raw, &file) != nil || file.Version != 1 ||
		strings.TrimSpace(file.URL) == "" || strings.TrimSpace(file.Token) == "" {
		return nil, errors.New("代理入口控制文件无效")
	}
	if !strings.HasPrefix(file.URL, "http://127.0.0.1:") {
		return nil, errors.New("代理入口控制地址必须是 loopback")
	}
	return &Client{
		base:  strings.TrimRight(file.URL, "/"),
		token: file.Token,
		http:  &http.Client{Timeout: 20 * time.Second},
	}, nil
}

// Status reads the live proxy state.
func (client *Client) Status(ctx context.Context) (Status, error) {
	return client.call(ctx, http.MethodGet, "/status", nil)
}

// Renew renews the current lease. When hot-swap is enabled this happens
// in-place; otherwise the caller may observe a short reconnect.
func (client *Client) Renew(ctx context.Context) (Status, error) {
	return client.call(ctx, http.MethodPost, "/renew", map[string]any{})
}

// SetHotSwap toggles in-place upstream replacement for automatic recovery.
func (client *Client) SetHotSwap(ctx context.Context, enabled bool) (Status, error) {
	return client.call(ctx, http.MethodPost, "/hot-swap", map[string]any{"enabled": enabled})
}

func (client *Client) call(ctx context.Context, method, path string, payload any) (Status, error) {
	var body []byte
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return Status{}, err
		}
		body = encoded
	}
	request, err := http.NewRequestWithContext(ctx, method, client.base+path, bytes.NewReader(body))
	if err != nil {
		return Status{}, err
	}
	request.Header.Set(tokenHeader, client.token)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(request)
	if err != nil {
		return Status{}, fmt.Errorf("代理入口控制请求失败: %w", err)
	}
	defer response.Body.Close()
	var decoded struct {
		OK      bool   `json:"ok"`
		Status  Status `json:"status"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return Status{}, fmt.Errorf("代理入口控制响应无效: HTTP %d", response.StatusCode)
	}
	if !decoded.OK {
		message := decoded.Message
		if message == "" {
			message = decoded.Error
		}
		if message == "" {
			message = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		return decoded.Status, errors.New(message)
	}
	return decoded.Status, nil
}
