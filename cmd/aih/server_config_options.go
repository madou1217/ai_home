package main

import (
	"errors"
	"fmt"
	"strings"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

// 这个文件把 server config 的每个可设置项收敛成一张声明表。
//
// 之前每个新选项要在五处同步修改：长 usage 字符串、setServerConfig 的 if 链、
// configFlagKey、clearConfigKey/clearConfigValue、serverConfigPatchRequiresRestart。
// 多处并行修改同一文件时极易互相覆盖（2026-11-21 起 server_config.go 被反复重写）。
// 现在新增选项只写一条 configOption：flag、JSON 路径、取值方式、是否热更新、
// 是否可清除，都在同一处。

type optionAction int

const (
	// optionValue 消费一个值并写入 Path。
	optionValue optionAction = iota
	// optionFixed 不消费值，写入固定值（布尔开关、重置默认）。
	optionFixed
	// optionGenerate 不消费值，调用 Generate 生成密钥。
	optionGenerate
)

type optionValueKind int

const (
	valueString optionValueKind = iota
	valueEnum
	valueBackoffList
)

type configOption struct {
	Flag      string
	Aliases   []string
	Path      []string // config:server 的 JSON 路径，支持一层嵌套
	Action    optionAction
	Kind      optionValueKind
	Choices   []string
	Fixed     any
	Generate  func() (string, error)
	Secret    bool
	HotReload bool
	// Clearable 表示支持 --clear-<flag>（把字段重置为 ClearValue）。
	Clearable  bool
	ClearValue any
	// UnsetSupported 表示 aih server config unset 接受该字段。
	UnsetSupported bool
	UnsetValue     any
}

var configOptions = []configOption{
	// 监听与密钥
	{Flag: "--host", Path: []string{"host"}, Action: optionValue},
	{Flag: "--port", Path: []string{"port"}, Action: optionValue},
	{Flag: "--api-key", Aliases: []string{"--client-key"}, Path: []string{"apiKey"}, Action: optionValue, Secret: true},
	{Flag: "--management-key", Path: []string{"managementKey"}, Action: optionValue, Secret: true},
	{Flag: "--generate-api-key", Path: []string{"apiKey"}, Action: optionGenerate, Generate: generateAPIKey, Secret: true},
	{Flag: "--generate-management-key", Path: []string{"managementKey"}, Action: optionGenerate, Generate: generateManagementKey, Secret: true},

	// 网络与代理
	{Flag: "--open-network", Path: []string{"openNetwork"}, Action: optionFixed, Fixed: true},
	{Flag: "--local-only", Path: []string{"openNetwork"}, Action: optionFixed, Fixed: false},
	{Flag: "--proxy-url", Path: []string{"proxyUrl"}, Action: optionValue, HotReload: true, UnsetSupported: true, UnsetValue: ""},
	{Flag: "--no-proxy", Path: []string{"noProxy"}, Action: optionValue},
	{Flag: "--models-probe-accounts", Path: []string{"modelsProbeAccounts"}, Action: optionValue},
	{Flag: "--model-cache-sync", Path: []string{"modelCacheSync"}, Action: optionValue, Kind: valueEnum, Choices: []string{"scheduler", "go-batch"}},

	// 窗口与 Go Core
	{Flag: "--window-activation", Path: []string{"windowActivation"}, Action: optionFixed, Fixed: true},
	{Flag: "--no-window-activation", Path: []string{"windowActivation"}, Action: optionFixed, Fixed: false},
	{Flag: "--window-activation-default-interval-ms", Path: []string{"windowActivationDefaultIntervalMs"}, Action: optionValue},
	{Flag: "--window-activation-min-interval-ms", Path: []string{"windowActivationMinIntervalMs"}, Action: optionValue},
	{Flag: "--go-core", Path: []string{"goCoreEnabled"}, Action: optionFixed, Fixed: true},
	{Flag: "--no-go-core", Path: []string{"goCoreEnabled"}, Action: optionFixed, Fixed: false},
	{Flag: "--go-core-routes", Path: []string{"goCoreRoutes"}, Action: optionValue, Clearable: true, ClearValue: []string{}},

	// 上游错误规则与 429 重试
	{Flag: "--upstream-error-rules", Path: []string{"upstreamErrorRuleProviders"}, Action: optionValue, Clearable: true, ClearValue: []string{}},
	{Flag: "--upstream-429-retry", Path: []string{"upstream429Retry", "enabled"}, Action: optionFixed, Fixed: true, HotReload: true},
	{Flag: "--no-upstream-429-retry", Path: []string{"upstream429Retry", "enabled"}, Action: optionFixed, Fixed: false, HotReload: true},
	{Flag: "--upstream-429-retry-backoff", Path: []string{"upstream429Retry", "backoffSeconds"}, Action: optionValue, Kind: valueBackoffList, HotReload: true},
	{Flag: "--clear-upstream-429-retry-backoff", Path: []string{"upstream429Retry", "backoffSeconds"}, Action: optionFixed, Fixed: corepolicy.DefaultBackoffSeconds(), HotReload: true},

	// 中继
	{Flag: "--relay-udp", Path: []string{"relayUdp"}, Action: optionValue},
	{Flag: "--relay-udp-advertise-host", Path: []string{"relayUdpAdvertiseHost"}, Action: optionValue, Clearable: true, ClearValue: 0},
	{Flag: "--relay-udp-advertise-port", Path: []string{"relayUdpAdvertisePort"}, Action: optionValue, Clearable: true, ClearValue: 0},
	{Flag: "--relay-port-mode", Path: []string{"relayPortMode"}, Action: optionValue},
	{Flag: "--relay-listen-host", Path: []string{"relayListenHost"}, Action: optionValue, Clearable: true, ClearValue: 0},

	// 限制与诊断
	{Flag: "--max-attempts", Path: []string{"maxAttempts"}, Action: optionValue, Clearable: true, ClearValue: 0},
	{Flag: "--large-paste-chars", Path: []string{"largePasteChars"}, Action: optionValue, Clearable: true, ClearValue: 0},
	{Flag: "--egress-evidence-ttl-ms", Path: []string{"egressEvidenceTtlMs"}, Action: optionValue, Clearable: true, ClearValue: 0},
}

// configOptionIndex 在进程启动时建一次，避免每次解析都重新分配映射。
var configOptionIndex = buildConfigOptionIndex()

func buildConfigOptionIndex() map[string]*configOption {
	index := make(map[string]*configOption, len(configOptions)*2+8)
	for position := range configOptions {
		option := &configOptions[position]
		index[option.Flag] = option
		for _, alias := range option.Aliases {
			index[alias] = option
		}
		if option.Clearable {
			index["--clear-"+strings.TrimPrefix(option.Flag, "--")] = option
		}
	}
	return index
}

// parseConfigSetArgs 把 set 参数解析成 config:server patch 与本次生成的密钥。
// 不再有逐 flag 的 if 链：行为由 configOption.Action/Kind 决定。
func parseConfigSetArgs(args []string) (map[string]any, map[string]string, error) {
	patch := map[string]any{}
	generated := map[string]string{}
	for index := 0; index < len(args); index++ {
		flag := args[index]
		if flag == "--json" || flag == "--one-line" || flag == "--verbose" || flag == "--show-secrets" {
			continue
		}
		if flag == "--qr" || flag == "--qr-url" || strings.HasPrefix(flag, "--qr-url=") {
			return nil, nil, errors.New("--qr 只能用于 show/get，不能和设置项一起使用")
		}
		option, value, inline, err := matchConfigOption(flag)
		if err != nil {
			return nil, nil, err
		}
		if option.Clearable && strings.HasPrefix(flag, "--clear-") {
			setConfigPath(patch, option.Path, option.ClearValue)
			continue
		}
		switch option.Action {
		case optionGenerate:
			key, generateErr := option.Generate()
			if generateErr != nil {
				return nil, nil, generateErr
			}
			setConfigPath(patch, option.Path, key)
			generated[option.Path[0]] = key
		case optionFixed:
			setConfigPath(patch, option.Path, option.Fixed)
		case optionValue:
			if !inline {
				if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
					return nil, nil, fmt.Errorf("%s requires a value", flag)
				}
				index++
				value = args[index]
			}
			typed, valueErr := normalizeOptionValue(option, value, flag)
			if valueErr != nil {
				return nil, nil, valueErr
			}
			setConfigPath(patch, option.Path, typed)
		}
	}
	if len(patch) == 0 {
		return nil, nil, errors.New("server config set requires at least one option")
	}
	return patch, generated, nil
}

// matchConfigOption 解析 --flag 或 --flag=value；未知 flag 保持原有错误文案。
func matchConfigOption(arg string) (*configOption, string, bool, error) {
	if option, found := configOptionIndex[arg]; found {
		return option, "", false, nil
	}
	// 只有 backoff 列表沿用 --flag=value 写法；其余 flag 带等号仍按未知选项处理，
	// 与重构前保持一致。
	if cut := strings.Index(arg, "="); cut > 0 {
		if option, found := configOptionIndex[arg[:cut]]; found && option.Kind == valueBackoffList {
			return option, arg[cut+1:], true, nil
		}
	}
	return nil, "", false, fmt.Errorf("unknown server config option: %s", arg)
}

func normalizeOptionValue(option *configOption, raw string, flag string) (any, error) {
	switch option.Kind {
	case valueEnum:
		for _, choice := range option.Choices {
			if raw == choice {
				return raw, nil
			}
		}
		return nil, fmt.Errorf("Invalid %s value: 只接受 %s", flag, strings.Join(option.Choices, " 或 "))
	case valueBackoffList:
		return parseUpstream429BackoffCSV(raw, flag)
	default:
		if option.Path[0] == "proxyUrl" && strings.TrimSpace(raw) == "" {
			return nil, errors.New("--proxy-url requires a non-empty value; run: aih server config unset proxy-url")
		}
		return raw, nil
	}
}

func setConfigPath(patch map[string]any, path []string, value any) {
	if len(path) == 1 {
		patch[path[0]] = value
		return
	}
	nested, _ := patch[path[0]].(map[string]any)
	if nested == nil {
		nested = map[string]any{}
		patch[path[0]] = nested
	}
	nested[path[1]] = value
}

// hotReloadTopLevelKeys 是 patch 顶层键里无需重启即可生效的集合。
func hotReloadTopLevelKeys() map[string]bool {
	hot := map[string]bool{}
	for position := range configOptions {
		option := &configOptions[position]
		if option.HotReload {
			hot[option.Path[0]] = true
		}
	}
	return hot
}

// configOptionForUnset 让 unset 与 set 共用同一张表，避免又一份 key 映射。
func configOptionForUnset(raw string) (*configOption, bool) {
	normalized := normalizeConfigKey(raw)
	for position := range configOptions {
		option := &configOptions[position]
		if !option.UnsetSupported {
			continue
		}
		if normalizeConfigKey(option.Path[0]) == normalized || strings.TrimPrefix(option.Flag, "--") == strings.TrimPrefix(raw, "--") {
			return option, true
		}
	}
	return nil, false
}
