package webuiserverrestartapi

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	nodeExecEnv  = "AIH_SERVER_NODE_EXEC"
	entryFileEnv = "AIH_SERVER_ENTRY_FILE"

	restartContextEnv   = "AIH_SERVER_RESTART"
	restartContextValue = "mode=background"

	defaultServerHost = "127.0.0.1"
	defaultServerPort = 9527

	defaultModelsProbeAccounts = 2
	defaultWindowIntervalMs    = 3600000 // 1h
	minWindowIntervalMs        = 60000   // 1m
	minLargePasteChars         = 50
	maxLargePasteChars         = 100000
	maxEgressEvidenceTTLMs     = 31536000000
	minEgressEvidenceTTLMs     = 60000
)

// NativeRestarterOptions 配置 Go 原生拉起独立 Node Server 重启进程的参数。
type NativeRestarterOptions struct {
	AIHomeDir      string
	RepoRoot       string
	NodeExecPath   string
	EntryFilePath  string
	CommandFactory func(name string, args ...string) *exec.Cmd
}

// NativeRestarter 直接以分离进程拉起 `<node> <entry> server restart`，
// 并在返回前读取持久化 `config:server` 的脱敏公开视图作为 `appliedConfig`。
type NativeRestarter struct {
	aiHomeDir            string
	repoRoot             string
	nodeExecPath         string
	entryFilePath        string
	commandFactory       func(name string, args ...string) *exec.Cmd
	customCommandFactory bool
}

// NewNativeRestarter 创建原生重启器；AIHomeDir 为空时返回 nil。
func NewNativeRestarter(options NativeRestarterOptions) *NativeRestarter {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	if aiHomeDir == "" {
		return nil
	}
	factory := options.CommandFactory
	customFactory := factory != nil
	if factory == nil {
		factory = exec.Command
	}
	return &NativeRestarter{
		aiHomeDir:            aiHomeDir,
		repoRoot:             strings.TrimSpace(options.RepoRoot),
		nodeExecPath:         strings.TrimSpace(options.NodeExecPath),
		entryFilePath:        strings.TrimSpace(options.EntryFilePath),
		commandFactory:       factory,
		customCommandFactory: customFactory,
	}
}

// Restart 读取当前持久化服务端配置，并拉起分离的后台重启命令。
func (r *NativeRestarter) Restart(ctx context.Context, _ RestartJob) (RestartOutcome, error) {
	if r == nil || r.aiHomeDir == "" {
		return RestartOutcome{}, ErrRestartUnavailable
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return RestartOutcome{}, err
		}
	}

	nodeExecPath, entryFilePath, err := r.resolveCommand()
	if err != nil {
		return RestartOutcome{}, err
	}

	appliedConfig, err := readPublicServerConfig(ctx, r.aiHomeDir)
	if err != nil {
		return RestartOutcome{}, err
	}

	// 严禁使用 exec.CommandContext：请求/超时上下文在 Restart 返回后即刻取消，
	// 若绑定上下文会把刚拉起的独立重启进程直接杀死。
	cmd := r.commandFactory(nodeExecPath, entryFilePath, "server", "restart")
	if cmd == nil {
		return RestartOutcome{}, ErrRestartUnavailable
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Env = buildRestartEnv(os.Environ())
	configureDetachedCmd(cmd)

	if err := cmd.Start(); err != nil {
		return RestartOutcome{}, err
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	return RestartOutcome{
		PID:           pid,
		AppliedConfig: appliedConfig,
	}, nil
}

func (r *NativeRestarter) resolveCommand() (string, string, error) {
	nodePath := r.nodeExecPath
	if nodePath == "" {
		nodePath = strings.TrimSpace(os.Getenv(nodeExecEnv))
	}
	if nodePath == "" {
		found, err := exec.LookPath("node")
		if err != nil {
			return "", "", ErrRestartUnavailable
		}
		nodePath = found
	} else if !r.customCommandFactory {
		found, err := exec.LookPath(nodePath)
		if err != nil {
			return "", "", ErrRestartUnavailable
		}
		nodePath = found
	}

	entry := r.entryFilePath
	if entry == "" {
		entry = strings.TrimSpace(os.Getenv(entryFileEnv))
	}
	if entry == "" {
		root := r.repoRoot
		if root == "" {
			root = discoverRepoRoot()
		}
		if root != "" {
			entry = filepath.Join(root, "bin", "ai-home.js")
		}
	}
	if entry == "" {
		return "", "", ErrRestartUnavailable
	}
	info, err := os.Stat(entry)
	if err != nil || info.IsDir() {
		return "", "", ErrRestartUnavailable
	}
	return nodePath, entry, nil
}

func discoverRepoRoot() string {
	candidates := make([]string, 0, 2)
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	for _, start := range candidates {
		dir := start
		for depth := 0; depth < 6; depth++ {
			if info, err := os.Stat(filepath.Join(dir, "bin", "ai-home.js")); err == nil && !info.IsDir() {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func buildRestartEnv(base []string) []string {
	env := make([]string, 0, len(base)+1)
	for _, item := range base {
		idx := strings.IndexByte(item, '=')
		if idx > 0 && strings.EqualFold(item[:idx], restartContextEnv) {
			continue
		}
		env = append(env, item)
	}
	return append(env, restartContextEnv+"="+restartContextValue)
}

func readPublicServerConfig(ctx context.Context, aiHomeDir string) (map[string]any, error) {
	source, err := webuiserverconfigapi.OpenSource(aiHomeDir)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	raw, found, err := source.ReadServerConfig(ctx)
	if err != nil {
		return nil, err
	}
	return sanitizePublicServerConfigFromJSON(raw, found)
}

// sanitizePublicServerConfigFromJSON 按 webuiserverconfigapi 同一口径解析并脱敏 config:server。
func sanitizePublicServerConfigFromJSON(raw string, found bool) (map[string]any, error) {
	input := map[string]any{}
	if found && strings.TrimSpace(raw) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
			return nil, err
		}
		if object, ok := decoded.(map[string]any); ok {
			input = object
		}
	}
	view := sanitizeServerConfigView(input)
	encoded, err := json.Marshal(view)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func sanitizeServerConfigView(input map[string]any) webuiserverconfigapi.ConfigView {
	requestedHost := defaultServerHost
	if value, ok := input["host"]; ok && value != nil {
		requestedHost = strings.TrimSpace(jsString(value))
	}
	host := defaultServerHost
	if requestedHost != "" && requestedHost != "0.0.0.0" {
		host = requestedHost
	}
	openNetwork := jsBool(input["openNetwork"]) || requestedHost == "0.0.0.0"

	apiKey := strings.TrimSpace(jsString(valueOrNil(input["apiKey"])))
	managementKey := strings.TrimSpace(jsString(valueOrNil(input["managementKey"])))
	if openNetwork {
		host = "0.0.0.0"
	}

	minInterval := math.Max(
		minWindowIntervalMs,
		numberOr(input["windowActivationMinIntervalMs"], defaultWindowIntervalMs),
	)
	defaultInterval := math.Max(
		minInterval,
		numberOr(input["windowActivationDefaultIntervalMs"], defaultWindowIntervalMs),
	)

	relayUDPRaw := "default"
	if value, ok := input["relayUdp"]; ok && value != nil {
		relayUDPRaw = strings.ToLower(strings.TrimSpace(jsString(value)))
	}
	relayUDP := "default"
	if relayUDPRaw == "on" || relayUDPRaw == "off" {
		relayUDP = relayUDPRaw
	}

	relayPortModeRaw := "default"
	if value, ok := input["relayPortMode"]; ok && value != nil {
		relayPortModeRaw = strings.ToLower(strings.TrimSpace(jsString(value)))
	}
	relayPortMode := "default"
	if relayPortModeRaw == "server" || relayPortModeRaw == "dedicated" {
		relayPortMode = relayPortModeRaw
	}

	egressTTL := math.Round(numberOr(input["egressEvidenceTtlMs"], 0))
	if egressTTL < minEgressEvidenceTTLMs {
		egressTTL = 0
	} else if egressTTL > maxEgressEvidenceTTLMs {
		egressTTL = maxEgressEvidenceTTLMs
	}

	view := webuiserverconfigapi.ConfigView{
		Host:                              host,
		Port:                              normalizeServerPort(input["port"]),
		APIKey:                            "",
		ManagementKey:                     "",
		OpenNetwork:                       openNetwork,
		ProxyURL:                          strings.TrimSpace(jsString(valueOrNil(input["proxyUrl"]))),
		NoProxy:                           strings.TrimSpace(jsString(valueOrNil(input["noProxy"]))),
		ModelsProbeAccounts:               clampNumber(input["modelsProbeAccounts"], 1, 8, defaultModelsProbeAccounts),
		ModelCacheSync:                    "go-batch",
		WindowActivation:                  input["windowActivation"] == true,
		WindowActivationDefaultIntervalMs: defaultInterval,
		WindowActivationMinIntervalMs:     minInterval,
		GoCoreEnabled:                     input["goCoreEnabled"] == true,
		GoCoreRoutes:                      normalizeStringList(input["goCoreRoutes"], false),
		UpstreamErrorRuleProviders:        normalizeStringList(input["upstreamErrorRuleProviders"], true),
		RelayUDP:                          relayUDP,
		RelayUDPAdvertiseHost:             strings.TrimSpace(jsString(valueOrNil(input["relayUdpAdvertiseHost"]))),
		RelayUDPAdvertisePort:             clampNumber(input["relayUdpAdvertisePort"], 0, 65535, 0),
		RelayPortMode:                     relayPortMode,
		RelayListenHost:                   strings.TrimSpace(jsString(valueOrNil(input["relayListenHost"]))),
		MaxAttempts:                       clampNumber(input["maxAttempts"], 0, 32, 0),
		EgressEvidenceTTLMs:               egressTTL,
		LargePasteChars:                   normalizeLargePasteChars(input["largePasteChars"]),
		APIKeyConfigured:                  apiKey != "",
		ManagementKeyConfigured:           managementKey != "",
	}
	if value, ok := input["modelCacheSync"]; ok && value == "scheduler" {
		view.ModelCacheSync = "scheduler"
	}
	return view
}

func normalizeServerPort(value any) int {
	port := jsNumber(value)
	if !math.IsNaN(port) && port > 0 && port <= 65535 && port == math.Trunc(port) {
		return int(port)
	}
	return defaultServerPort
}

func normalizeLargePasteChars(value any) int {
	number := math.Round(numberOr(value, 0))
	if number <= 0 {
		return 0
	}
	if number < minLargePasteChars {
		return minLargePasteChars
	}
	if number > maxLargePasteChars {
		return maxLargePasteChars
	}
	return int(number)
}

func clampNumber(value any, min float64, max float64, fallback float64) float64 {
	number := numberOr(value, fallback)
	if number < min {
		return min
	}
	if number > max {
		return max
	}
	return number
}

func normalizeStringList(value any, lowercase bool) []string {
	items := make([]string, 0)
	if list, ok := value.([]any); ok {
		for _, item := range list {
			items = append(items, jsString(item))
		}
	} else {
		text := ""
		if value != nil && jsBool(value) {
			text = jsString(value)
		}
		if text != "" {
			items = strings.Split(text, ",")
		}
	}
	seen := map[string]struct{}{}
	result := make([]string, 0, len(items))
	for _, item := range items {
		normalized := strings.TrimSpace(item)
		if lowercase {
			normalized = strings.ToLower(normalized)
		}
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func valueOrNil(value any) any {
	if value == nil {
		return nil
	}
	return value
}

func numberOr(value any, fallback float64) float64 {
	number := jsNumber(value)
	if math.IsNaN(number) || number == 0 {
		return fallback
	}
	return number
}

func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case bool:
		if typed {
			return 1
		}
		return math.NaN()
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	default:
		return math.NaN()
	}
}

func jsBool(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return "[object Object]"
	}
}
