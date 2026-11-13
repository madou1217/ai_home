package egress

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	stateFileVersion       = 1
	defaultProbeURL        = "https://www.gstatic.com/generate_204"
	controllerTimeout      = 5 * time.Second
	mihomoProbeGroup       = "AIH-PROBE"
	mihomoGlobalGroup      = "GLOBAL"
	defaultProbeTimeoutMS  = 5000
	defaultProbeIntervalMS = 60 * 1000
)

// PoolStateFile 对应 <aiHomeDir>/run/egress-pool/state.json。
type PoolStateFile struct {
	Version        int                 `json:"version"`
	OwnerPID       int                 `json:"ownerPid"`
	CorePID        int                 `json:"corePid"`
	ProxyURL       string              `json:"proxyUrl"`
	ControllerPort int                 `json:"controllerPort"`
	Secret         string              `json:"secret"`
	StartedAt      int64               `json:"startedAt"`
	Lanes          map[string]string   `json:"lanes"`
	SessionLanes   map[string][]string `json:"sessionLanes"`
}

// PoolConfigListener 描述 config.json 中的 listeners 条目。
type PoolConfigListener struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Port   int    `json:"port"`
	Listen string `json:"listen"`
	Proxy  string `json:"proxy"`
}

// PoolConfigProxy 描述 config.json 中单个出站节点的脱敏摘要。
type PoolConfigProxy struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
	Protocol string `json:"-"`
}

// PoolRuntimeConfig 解析 <aiHomeDir>/run/egress-pool/config.json 得到的运行配置。
type PoolRuntimeConfig struct {
	MixedPort      int
	ControllerPort int
	Secret         string
	Proxies        []PoolConfigProxy
	ProbePort      int
	LanePorts      map[int]int
}

// ControllerProxyInfo 描述 mihomo GET /proxies 单项返回结构。
type ControllerProxyInfo struct {
	Name string   `json:"name"`
	Type string   `json:"type"`
	Now  string   `json:"now"`
	All  []string `json:"all"`
}

// ReadPoolStateFile 读取并校验 <aiHomeDir>/run/egress-pool/state.json。
func ReadPoolStateFile(aiHomeDir string) (*PoolStateFile, error) {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return nil, errors.New("egress_pool_server_not_running")
	}
	raw, err := os.ReadFile(filepath.Join(trimmed, "run", "egress-pool", "state.json"))
	if err != nil {
		return nil, errors.New("egress_pool_server_not_running")
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errors.New("egress_pool_server_not_running")
	}
	if int64Field(doc["version"]) != stateFileVersion {
		return nil, errors.New("egress_pool_server_not_running")
	}
	ownerPID := parsePIDAny(doc["ownerPid"])
	corePID := parsePIDAny(doc["corePid"])
	proxyURL := strings.TrimSpace(stringField(doc["proxyUrl"]))
	if ownerPID <= 0 || corePID <= 0 || !IsLoopbackHTTPURL(proxyURL) {
		return nil, errors.New("egress_pool_server_not_running")
	}
	lanes := make(map[string]string)
	if rawLanes, ok := doc["lanes"].(map[string]any); ok {
		for ref, val := range rawLanes {
			u := strings.TrimSpace(stringField(val))
			if strings.TrimSpace(ref) != "" && IsLoopbackHTTPURL(u) {
				lanes[ref] = u
			}
		}
	}
	sessionLanes := make(map[string][]string)
	if rawSess, ok := doc["sessionLanes"].(map[string]any); ok {
		for ref, val := range rawSess {
			items, ok := val.([]any)
			if !ok || strings.TrimSpace(ref) == "" {
				continue
			}
			var urls []string
			for _, item := range items {
				u := strings.TrimSpace(stringField(item))
				if IsLoopbackHTTPURL(u) {
					urls = append(urls, u)
				}
			}
			if len(urls) > 0 {
				sessionLanes[ref] = urls
			}
		}
	}
	return &PoolStateFile{
		Version:        stateFileVersion,
		OwnerPID:       ownerPID,
		CorePID:        corePID,
		ProxyURL:       proxyURL,
		ControllerPort: int(int64Field(doc["controllerPort"])),
		Secret:         stringField(doc["secret"]),
		StartedAt:      int64Field(doc["startedAt"]),
		Lanes:          lanes,
		SessionLanes:   sessionLanes,
	}, nil
}

// DefaultPIDAlive 检测进程是否存活（signal 0，EPERM 视为存在）。
func DefaultPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

// ReadLivePoolState 仅在 owner 与 core 均存活时返回有效状态，否则给出明确原因。
func ReadLivePoolState(aiHomeDir string, pidAlive func(int) bool) (*PoolStateFile, string) {
	if pidAlive == nil {
		pidAlive = DefaultPIDAlive
	}
	state, err := ReadPoolStateFile(aiHomeDir)
	if err != nil || state == nil {
		return nil, "egress_pool_server_not_running"
	}
	if !pidAlive(state.OwnerPID) {
		return nil, "egress_pool_server_not_running"
	}
	if !pidAlive(state.CorePID) {
		return nil, "egress_pool_core_exited"
	}
	return state, ""
}

// ReadPoolRuntimeConfig 解析 <aiHomeDir>/run/egress-pool/config.json（若存在）。
func ReadPoolRuntimeConfig(aiHomeDir string) (*PoolRuntimeConfig, bool) {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return nil, false
	}
	raw, err := os.ReadFile(filepath.Join(trimmed, "run", "egress-pool", "config.json"))
	if err != nil {
		return nil, false
	}
	var doc struct {
		MixedPort          int                  `json:"mixed-port"`
		ExternalController string               `json:"external-controller"`
		Secret             string               `json:"secret"`
		Proxies            []json.RawMessage    `json:"proxies"`
		Listeners          []PoolConfigListener `json:"listeners"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, false
	}
	cfg := &PoolRuntimeConfig{
		MixedPort: doc.MixedPort,
		Secret:    strings.TrimSpace(doc.Secret),
		LanePorts: make(map[int]int),
	}
	if _, portStr, ok := strings.Cut(doc.ExternalController, ":"); ok {
		if p, err := strconv.Atoi(strings.TrimSpace(portStr)); err == nil && p > 0 {
			cfg.ControllerPort = p
		}
	}
	for _, item := range doc.Proxies {
		var m map[string]any
		if err := json.Unmarshal(item, &m); err != nil || m == nil {
			continue
		}
		proto := NormalizeProtocol(stringField(m["type"]))
		if proto == "ss" || proto == "shadowsocks" {
			proto = "ss"
		}
		cfg.Proxies = append(cfg.Proxies, PoolConfigProxy{
			Name:     stringField(m["name"]),
			Type:     NormalizeProtocol(stringField(m["type"])),
			Protocol: proto,
			Server:   stringField(m["server"]),
			Port:     ParsePortAny(m["port"]),
		})
	}
	for _, listener := range doc.Listeners {
		switch {
		case listener.Proxy == mihomoProbeGroup && listener.Port > 0:
			cfg.ProbePort = listener.Port
		case strings.HasPrefix(listener.Proxy, "LANE-") && listener.Port > 0:
			if idx, err := strconv.Atoi(strings.TrimPrefix(listener.Proxy, "LANE-")); err == nil && idx >= 0 {
				cfg.LanePorts[idx] = listener.Port
			}
		}
	}
	return cfg, true
}

func parsePIDAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		if typed <= 0 || typed != float64(int(typed)) {
			return 0
		}
		return int(typed)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil || n <= 0 {
			return 0
		}
		return n
	default:
		return 0
	}
}

// ControllerClient 封装对本机回环 mihomo 控制端口的调用与无连接复用代理客户端。
type ControllerClient struct {
	Port       int
	Secret     string
	HTTPClient *http.Client
}

// NewControllerClient 构造控制端口客户端（仅允许访问 127.0.0.1）。
func NewControllerClient(port int, secret string, client *http.Client) *ControllerClient {
	if client == nil {
		client = &http.Client{Timeout: controllerTimeout}
	}
	return &ControllerClient{
		Port:       port,
		Secret:     strings.TrimSpace(secret),
		HTTPClient: client,
	}
}

func (c *ControllerClient) doJSON(ctx context.Context, method string, apiPath string, body any, target any, timeout time.Duration) error {
	if c == nil || c.Port <= 0 {
		return errors.New("controller_unavailable")
	}
	if timeout <= 0 {
		timeout = controllerTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var bodyReader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(encoded)
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", c.Port, apiPath)
	req, err := http.NewRequestWithContext(reqCtx, method, endpoint, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.Secret)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("controller_http_%d", resp.StatusCode)
	}
	if target == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, target)
}

// Version 查询 /version 以确认控制端口就绪且密钥有效。
func (c *ControllerClient) Version(ctx context.Context) (bool, error) {
	var out map[string]any
	if err := c.doJSON(ctx, http.MethodGet, "/version", nil, &out, controllerTimeout); err != nil {
		return false, err
	}
	return true, nil
}

// GetProxies 查询 /proxies 全表。
func (c *ControllerClient) GetProxies(ctx context.Context) (map[string]ControllerProxyInfo, error) {
	var out struct {
		Proxies map[string]ControllerProxyInfo `json:"proxies"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/proxies", nil, &out, controllerTimeout); err != nil {
		return nil, err
	}
	return out.Proxies, nil
}

// SelectProxy 切换指定 select 策略组（如 GLOBAL、AIH-PROBE、LANE-0）的当前出站节点。
func (c *ControllerClient) SelectProxy(ctx context.Context, group string, nodeName string) error {
	escapedGroup := url.PathEscape(group)
	return c.doJSON(ctx, http.MethodPut, "/proxies/"+escapedGroup, map[string]string{"name": nodeName}, nil, controllerTimeout)
}

// ProbeDelay 调用 /proxies/{name}/delay 测速并检查连通性。
func (c *ControllerClient) ProbeDelay(ctx context.Context, nodeName string, probeURL string, timeoutMS int) (int64, error) {
	if strings.TrimSpace(probeURL) == "" {
		probeURL = defaultProbeURL
	}
	if timeoutMS <= 0 {
		timeoutMS = defaultProbeTimeoutMS
	}
	apiPath := fmt.Sprintf("/proxies/%s/delay?timeout=%d&url=%s",
		url.PathEscape(nodeName), timeoutMS, url.QueryEscape(probeURL))
	var out struct {
		Delay int64 `json:"delay"`
	}
	reqTimeout := time.Duration(timeoutMS)*time.Millisecond + 2*time.Second
	if err := c.doJSON(ctx, http.MethodGet, apiPath, nil, &out, reqTimeout); err != nil {
		return 0, err
	}
	if out.Delay <= 0 {
		return 0, errors.New("probe_unreachable")
	}
	return out.Delay, nil
}

// NewDirectOrProxiedHTTPClient 构造禁止连接复用的 HTTP 客户端，避免切换 AIH-PROBE 节点后误复用上一条 CONNECT 隧道。
func NewDirectOrProxiedHTTPClient(proxyURL string, timeout time.Duration) (*http.Client, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	transport := &http.Transport{
		DisableKeepAlives: true,
		MaxIdleConns:      0,
		Proxy:             http.ProxyFromEnvironment,
	}
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed != "" {
		parsed, err := url.Parse(trimmed)
		if err != nil {
			return nil, fmt.Errorf("invalid_proxy_url: %w", err)
		}
		transport.Proxy = http.ProxyURL(parsed)
	} else {
		// 直连明确不走环境变量代理。
		transport.Proxy = nil
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}, nil
}
