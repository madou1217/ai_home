package webuiserverrestartapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/madou1217/ai_home/application/serverconfig"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
	"github.com/madou1217/ai_home/internal/runtime/autostart"
	"github.com/madou1217/ai_home/internal/runtime/serverprobe"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	// defaultServiceLabel 是自启服务标识（launchd label / systemd user unit 名）。
	defaultServiceLabel = "com.meadeo.ai_home"
	// serviceProbeTimeout 限制探测服务是否存在的等待时间。
	serviceProbeTimeout = 5 * time.Second

	restartContextEnv   = "AIH_SERVER_RESTART"
	restartContextValue = "mode=background"

	// 监听主机与端口的归一规则只在 application/serverconfig 定义一次。
	defaultServerHost = serverconfig.DefaultHost
	defaultServerPort = serverconfig.DefaultPort

	defaultModelsProbeAccounts = 2
	defaultWindowIntervalMs    = 3600000 // 1h
	minWindowIntervalMs        = 60000   // 1m
	minLargePasteChars         = 50
	maxLargePasteChars         = 100000
	maxEgressEvidenceTTLMs     = 31536000000
	minEgressEvidenceTTLMs     = 60000
)

// NativeRestarterOptions 配置原生服务管理器重启的参数。
type NativeRestarterOptions struct {
	AIHomeDir string
	// RequestShutdown is the host-owned, idempotent, nonblocking graceful exit callback.
	// Both HTTP entry points authorize before invoking the shared restarter.
	RequestShutdown func()
	// ServiceLabel 是自启服务标识；空时用 com.meadeo.ai_home。
	ServiceLabel string
	// ResolveCommand 覆盖平台服务管理器探测（测试或嵌入式宿主注入）。
	ResolveCommand func() (string, []string, error)
	CommandFactory func(name string, args ...string) *exec.Cmd
}

// NativeRestarter 通过系统服务管理器（launchd / systemd user / Windows Task Scheduler）重启当前实例，
// 不经过 Node；并在返回前读取持久化 `config:server` 的脱敏公开视图作为 `appliedConfig`。
type NativeRestarter struct {
	usePlatformRestart bool
	requestShutdown    func()
	aiHomeDir          string
	resolveCommand     func() (string, []string, error)
	commandFactory     func(name string, args ...string) *exec.Cmd
}

// NewNativeRestarter 创建原生重启器；AIHomeDir 为空时返回 nil。
func NewNativeRestarter(options NativeRestarterOptions) *NativeRestarter {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	if aiHomeDir == "" {
		return nil
	}
	factory := options.CommandFactory
	if factory == nil {
		factory = exec.Command
	}
	label := strings.TrimSpace(options.ServiceLabel)
	if label == "" {
		label = defaultServiceLabel
	}
	resolve := options.ResolveCommand
	if resolve == nil {
		resolve = func() (string, []string, error) { return detectServiceRestartCommand(label) }
	}
	return &NativeRestarter{
		usePlatformRestart: options.ResolveCommand == nil,
		requestShutdown:    options.RequestShutdown,
		aiHomeDir:          aiHomeDir,
		resolveCommand:     resolve,
		commandFactory:     factory,
	}
}

// Restart 读取当前持久化服务端配置，并拉起分离的后台重启命令。
func (r *NativeRestarter) Restart(ctx context.Context, job RestartJob) (RestartOutcome, error) {
	if r == nil || r.aiHomeDir == "" {
		return RestartOutcome{}, ErrRestartUnavailable
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return RestartOutcome{}, err
		}
	}

	drainKey := ""
	drainPort := 0
	drainOn := false
	cancelDrain := func() {
		if drainOn {
			_ = serverprobe.CancelDrain(ctx, drainPort, drainKey)
			drainOn = false
		}
	}

	if r.usePlatformRestart {
		// 与 CLI restart 同一道保护：先关闭新推理入口，再检查存量流。
		// 有活跃流时明确拒绝；这样不会在检查与 SIGTERM 之间再插入新流。
		drainKey = r.managementKey(ctx)
		drainPort = r.serverPort(ctx)
		active, drainErr := serverprobe.BeginDrain(ctx, drainPort, drainKey)
		drainOn = drainErr == nil
		if !drainOn {
			// 兼容旧服务端：至少用只读计数拒绝已知活跃流。
			active = serverprobe.ActiveInference(ctx, drainPort)
		}
		if active > 0 {
			cancelDrain()
			return RestartOutcome{}, fmt.Errorf(
				"server_restart_busy: %d active inference stream(s); retry when idle",
				active,
			)
		}
		if outcome, handled, err := r.restartPlatform(ctx, job); handled {
			if err != nil {
				cancelDrain()
			}
			return outcome, err
		}
	}

	commandName, commandArgs, err := r.resolveCommand()
	if err != nil {
		cancelDrain()
		return RestartOutcome{}, err
	}

	appliedConfig, err := readPublicServerConfig(ctx, r.aiHomeDir)
	if err != nil {
		cancelDrain()
		return RestartOutcome{}, err
	}

	// 严禁使用 exec.CommandContext：请求/超时上下文在 Restart 返回后即刻取消，
	// 若绑定上下文会把刚拉起的独立重启进程直接杀死。
	cmd := r.commandFactory(commandName, commandArgs...)
	if cmd == nil {
		cancelDrain()
		return RestartOutcome{}, ErrRestartUnavailable
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Env = buildRestartEnv(os.Environ())
	configureDetachedCmd(cmd)

	if err := cmd.Start(); err != nil {
		cancelDrain()
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

// detectServiceRestartCommand 用系统服务管理器重启整个 aih 服务。
//
// Go 不再拉起 `node ... server restart`：重启动作属于宿主生命周期，
// 应该由持有该进程的服务管理器完成。没有受管服务（开发态前台运行）时
// 明确返回 ErrRestartUnavailable，由 Handler 回 503，而不是退回 Node。
func detectServiceRestartCommand(label string) (string, []string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", nil, ErrRestartUnavailable
	}
	// 平台事实只在那里推导一次；这里只判断当前部署是否真的受服务管理器托管，
	// 未托管（开发态前台运行）时明确返回 ErrRestartUnavailable，由 Handler 回 503。
	if !autostart.ServiceJobLoaded(context.Background(), label) {
		return "", nil, ErrRestartUnavailable
	}
	name, args, err := autostart.GracefulRestartCommand(label)
	if err != nil {
		return "", nil, ErrRestartUnavailable
	}
	return name, args, nil
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

// activeInference 读取当前服务端公开的活跃推理数；配置/探针不可用时返回 0，
// 不阻断旧版本或未受管开发态的原重启路径。
func (r *NativeRestarter) activeInference(ctx context.Context) int {
	if r == nil {
		return 0
	}
	return serverprobe.ActiveInference(ctx, r.serverPort(ctx))
}

func (r *NativeRestarter) serverPort(ctx context.Context) int {
	config, err := readPublicServerConfig(ctx, r.aiHomeDir)
	if err != nil {
		return defaultServerPort
	}
	if value, ok := config["port"].(float64); ok && value > 0 && value <= 65535 {
		return int(value)
	}
	return defaultServerPort
}

func (r *NativeRestarter) managementKey(ctx context.Context) string {
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, r.aiHomeDir)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(config.ManagementKey)
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
		Upstream429Retry:                  corepolicy.SanitizeGlobalRaw(input["upstream429Retry"]),
		APIKeyConfigured:                  apiKey != "",
		ManagementKeyConfigured:           managementKey != "",
	}
	if value, ok := input["modelCacheSync"]; ok && value == "scheduler" {
		view.ModelCacheSync = "scheduler"
	}
	return view
}

func normalizeServerPort(value any) int {
	return serverconfig.NormalizePort(value)
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
