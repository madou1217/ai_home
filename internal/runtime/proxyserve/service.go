package proxyserve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ServiceRequest 是常驻代理服务的安装参数。
type ServiceRequest struct {
	Selector string `json:"selector"`
	NoSocks  bool   `json:"noSocks,omitempty"`
}

// ServiceView 是常驻服务的脱敏管理视图。
type ServiceView struct {
	Installed bool   `json:"installed"`
	Loaded    bool   `json:"loaded"`
	PID       int    `json:"pid,omitempty"`
	Label     string `json:"label,omitempty"`
	File      string `json:"file,omitempty"`
	Log       string `json:"log,omitempty"`
	Selector  string `json:"selector,omitempty"`
	NoSocks   bool   `json:"noSocks,omitempty"`
	Error     string `json:"error,omitempty"`
}

type serviceConfig struct {
	Selector string `json:"selector"`
	NoSocks  bool   `json:"noSocks"`
}

func (manager *Manager) serviceConfigPath() string {
	if manager == nil || strings.TrimSpace(manager.aiHomeDir) == "" {
		return ""
	}
	return filepath.Join(manager.aiHomeDir, "run", "proxy", "service-config.json")
}

func (manager *Manager) readServiceConfig() serviceConfig {
	path := manager.serviceConfigPath()
	if path == "" {
		return serviceConfig{}
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return serviceConfig{}
	}
	var config serviceConfig
	if json.Unmarshal(payload, &config) != nil {
		return serviceConfig{}
	}
	return config
}

func (manager *Manager) writeServiceConfig(config serviceConfig) error {
	path := manager.serviceConfigPath()
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(config)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func (manager *Manager) serviceEnvironment() []string {
	env := []string{"AIH_HOME_DIR=" + manager.aiHomeDir}
	if manager.managementKey != nil {
		if key := strings.TrimSpace(manager.managementKey()); key != "" {
			env = append(env, "AIH_SERVER_MANAGEMENT_KEY="+key)
		}
	}
	return env
}

func (manager *Manager) serviceCLI() (string, error) {
	if manager != nil && strings.TrimSpace(manager.cliPath) != "" {
		return manager.cliPath, nil
	}
	return LocateCLI()
}

func (manager *Manager) runServiceCLI(ctx context.Context, args ...string) (map[string]any, error) {
	cli, err := manager.serviceCLI()
	if err != nil {
		return nil, err
	}
	commandCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, cli, args...)
	command.Env = append(os.Environ(), manager.serviceEnvironment()...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()
	if runErr != nil {
		return nil, fmt.Errorf("%w: %s", ErrStartFailed, safeServiceError(stderr.Bytes(), runErr))
	}
	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		return nil, fmt.Errorf("%w: service status is not JSON", ErrStartFailed)
	}
	return payload, nil
}

func safeServiceError(output []byte, runErr error) string {
	text := strings.TrimSpace(string(output))
	if len(text) > 240 {
		text = text[:240]
	}
	if text == "" {
		return runErr.Error()
	}
	return text
}

// ServiceStatus 读取操作系统服务状态，并附上本机记录的安装参数。
func (manager *Manager) ServiceStatus(ctx context.Context) (ServiceView, error) {
	payload, err := manager.runServiceCLI(ctx, "proxy", "service", "status", "--json")
	if err != nil {
		return ServiceView{}, err
	}
	return manager.serviceViewFromPayload(payload), nil
}

func (manager *Manager) serviceViewFromPayload(payload map[string]any) ServiceView {
	view := ServiceView{
		Installed: boolValue(payload["installed"]),
		Loaded:    boolValue(payload["loaded"]),
		PID:       intValue(payload["pid"]),
		Label:     stringValue(payload["label"]),
		File:      stringValue(payload["file"]),
		Log:       stringValue(payload["log"]),
	}
	config := manager.readServiceConfig()
	view.Selector = config.Selector
	view.NoSocks = config.NoSocks
	return view
}

// InstallService 安装或更新 launchd/systemd/Windows 登录任务。
func (manager *Manager) InstallService(ctx context.Context, request ServiceRequest) (ServiceView, error) {
	selector := strings.TrimSpace(request.Selector)
	if selector == "" || strings.ContainsAny(selector, "\r\n\x00") {
		return ServiceView{}, ErrSelectorInvalid
	}
	if strings.TrimSpace(manager.serverURL) == "" {
		return ServiceView{}, ErrServerURL
	}
	args := []string{"proxy", "service", "install", "--json", "--selector", selector, "--server", manager.serverURL}
	if request.NoSocks {
		args = append(args, "--no-socks")
	}
	payload, err := manager.runServiceCLI(ctx, args...)
	if err != nil {
		return ServiceView{}, err
	}
	if err := manager.writeServiceConfig(serviceConfig{Selector: selector, NoSocks: request.NoSocks}); err != nil {
		return ServiceView{}, err
	}
	return manager.serviceViewFromPayload(payload), nil
}

// UninstallService 停止并删除常驻服务。
func (manager *Manager) UninstallService(ctx context.Context) (ServiceView, error) {
	if _, err := manager.runServiceCLI(ctx, "proxy", "service", "uninstall", "--json"); err != nil {
		return ServiceView{}, err
	}
	path := manager.serviceConfigPath()
	if path != "" {
		_ = os.Remove(path)
	}
	return ServiceView{Installed: false}, nil
}

func boolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	default:
		return false
	}
}

func intValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

func stringValue(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}
