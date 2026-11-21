package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

// CLI 只描述“怎么写 flag、开关怎么配对、密钥怎么生成”；字段的 JSON 键、默认值、
// 枚举、范围、热更新与历史标记全部来自 application/serverconfig.Schema。
// 这样 WebUI 配置接口与 CLI 不会各自演化出两份 schema。

type optionAction int

const (
	optionValue optionAction = iota
	optionFixed
	optionGenerate
)

type optionValueKind int

const (
	valueString optionValueKind = iota
	valueEnum
	valueBackoffList
)

type configOption struct {
	Flag         string
	Aliases      []string
	Key          string
	Path         []string
	Action       optionAction
	Kind         optionValueKind
	Choices      []string
	Fixed        any
	Generate     func() (string, error)
	Clearable    bool
	ClearValue   any
	HotReload    bool
	Unset        bool
	UnsetValue   any
	LegacyReason string
	Summary      string
	Group        string
	ValueHint    string
}

var configOptions = buildConfigOptions()
var configOptionIndex = buildConfigOptionIndex()

func buildConfigOptions() []configOption {
	options := make([]configOption, 0, len(serverconfig.Fields)+12)
	for _, field := range serverconfig.Fields {
		base := configOption{
			Key: field.Key, Path: []string{field.Key}, Group: groupOr(field.Group),
			HotReload: field.HotReload, LegacyReason: field.LegacyReason,
			Summary: field.Summary, ValueHint: valueHint(field),
		}
		switch field.Key {
		case "openNetwork", "windowActivation", "goCoreEnabled":
			// 一对互斥开关，不消费值。
			options = append(options,
				fixedOption(base, field.Flag, true),
				fixedOption(base, field.NegativeFlag, false))
		case "apiKey", "managementKey":
			options = append(options,
				valueOption(base, field.Flag, field),
				configOption{Key: field.Key, Path: []string{field.Key}, Group: base.Group, Action: optionGenerate,
					Generate: keyGenerator(field.Key), Flag: field.GenerateFlag,
					LegacyReason: field.LegacyReason, Summary: field.Summary})
		case "upstream429Retry":
			options = append(options,
				fixedOption(nested(base, "enabled", true), "--upstream-429-retry", true),
				fixedOption(nested(base, "enabled", false), "--no-upstream-429-retry", false),
				configOption{Key: field.Key, Path: []string{field.Key, "backoffSeconds"}, Group: base.Group,
					Action: optionValue, Kind: valueBackoffList, Flag: "--upstream-429-retry-backoff",
					ValueHint: "<sec,...>", HotReload: true, LegacyReason: field.LegacyReason,
					Summary: field.Summary},
				configOption{Key: field.Key, Path: []string{field.Key, "backoffSeconds"}, Group: base.Group,
					Action: optionFixed, Fixed: corepolicy.DefaultBackoffSeconds(),
					Flag: "--clear-upstream-429-retry-backoff", Clearable: false,
					HotReload: true, LegacyReason: field.LegacyReason, Summary: field.Summary},
			)
		case "upstreamErrorRuleProviders":
			opt := valueOption(base, field.Flag, field)
			opt.Clearable, opt.ClearValue = true, field.ClearValue
			options = append(options, opt)
		default:
			opt := valueOption(base, field.Flag, field)
			if field.ClearValue != nil {
				opt.Clearable, opt.ClearValue = true, field.ClearValue
			}
			if field.Key == "proxyUrl" {
				opt.Unset, opt.UnsetValue = true, ""
			}
			options = append(options, opt)
		}
	}
	return options
}

func groupOr(group string) string {
	if group == "" {
		return "其他"
	}
	return group
}

func valueOption(base configOption, flag string, field serverconfig.Field) configOption {
	option := base
	option.Flag = flag
	option.Action = optionValue
	if field.Type == serverconfig.TypeEnum {
		option.Kind = valueEnum
		option.Choices = field.Choices
	}
	return option
}

func fixedOption(base configOption, flag string, value any) configOption {
	option := base
	option.Flag = flag
	option.Action = optionFixed
	option.Fixed = value
	return option
}

func nested(base configOption, child string, value any) configOption {
	option := base
	option.Path = []string{base.Key, child}
	option.Fixed = value
	return option
}

func keyGenerator(key string) func() (string, error) {
	if key == "managementKey" {
		return generateManagementKey
	}
	return generateAPIKey
}

func buildConfigOptionIndex() map[string]*configOption {
	index := make(map[string]*configOption, len(configOptions)+4)
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
			generated[option.Key] = key
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

func matchConfigOption(arg string) (*configOption, string, bool, error) {
	if option, found := configOptionIndex[arg]; found {
		return option, "", false, nil
	}
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
		if option.Key == "proxyUrl" && strings.TrimSpace(raw) == "" {
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
	node, _ := patch[path[0]].(map[string]any)
	if node == nil {
		node = map[string]any{}
		patch[path[0]] = node
	}
	node[path[1]] = value
}

func hotReloadTopLevelKeys() map[string]bool {
	hot := map[string]bool{}
	for position := range configOptions {
		if configOptions[position].HotReload {
			hot[configOptions[position].Key] = true
		}
	}
	return hot
}

func configOptionForUnset(raw string) (*configOption, bool) {
	normalized := normalizeConfigKey(raw)
	for position := range configOptions {
		option := &configOptions[position]
		if !option.Unset {
			continue
		}
		if normalizeConfigKey(option.Key) == normalized || strings.TrimPrefix(option.Flag, "--") == strings.TrimPrefix(raw, "--") {
			return option, true
		}
	}
	return nil, false
}

// serverConfigHelpLines 从共享 schema 生成 help：新增字段只改 schema，不再手工同步
// 那条几百字符的 usage 字符串。
func serverConfigHelpLines() []string {
	lines := []string{
		"Usage:",
		"  aih server config show [--show-secrets] [--json] [--one-line] [--qr [--qr-url <url>]] [<filter>]",
		"  aih server config get <key> [--show-secrets] [--json]",
		"  aih server config set <option>...   # 不带 set 也可：aih server config --api-key <key>",
		"  aih server config unset proxy-url",
		"  aih server config list",
		"",
		"Options（由 config schema 生成；历史字段不在此列）:",
	}
	groups := make([]string, 0, 6)
	seen := map[string]bool{}
	for _, field := range serverconfig.Fields {
		if field.LegacyReason != "" || seen[field.Group] {
			continue
		}
		seen[field.Group] = true
		groups = append(groups, field.Group)
	}
	for _, group := range groups {
		lines = append(lines, "", group+":")
		for _, field := range serverconfig.Fields {
			if field.LegacyReason != "" || field.Group != group {
				continue
			}
			lines = append(lines, fmt.Sprintf("  %-58s %s", helpFlagText(field), field.Summary))
		}
	}
	legacy := make([]string, 0)
	for _, field := range serverconfig.Fields {
		if field.LegacyReason == "" {
			continue
		}
		legacy = append(legacy, fmt.Sprintf("  %-28s %s", field.Key, field.LegacyReason))
	}
	if len(legacy) > 0 {
		lines = append(lines, "", "历史字段（已无运行时读方，仅兼容旧配置；可读但不在补全中出现）:")
		lines = append(lines, legacy...)
	}
	lines = append(lines, "", "清除单项默认值：--clear-<option>（例如 --clear-max-attempts）。")
	return lines
}

func helpFlagText(field serverconfig.Field) string {
	if field.Key == "upstream429Retry" {
		return "--upstream-429-retry | --no-upstream-429-retry / --upstream-429-retry-backoff <sec,...>"
	}
	if field.NegativeFlag != "" {
		return field.Flag + " | " + field.NegativeFlag
	}
	if field.GenerateFlag != "" {
		return field.Flag + " <key> | " + field.GenerateFlag
	}
	hint := valueHint(field)
	if hint == "" {
		return field.Flag
	}
	if strings.HasPrefix(hint, "|") {
		return field.Flag + " " + strings.TrimPrefix(hint, "|")
	}
	return field.Flag + " " + hint
}

func valueHint(field serverconfig.Field) string {
	switch field.Type {
	case serverconfig.TypeIP:
		return "<ip>"
	case serverconfig.TypePort:
		return "<1..65535>"
	case serverconfig.TypeURL:
		return "<url>"
	case serverconfig.TypeHosts:
		return "<hosts>"
	case serverconfig.TypeInt:
		return "<n>"
	case serverconfig.TypeDuration:
		return "<ms>"
	case serverconfig.TypeBool:
		return ""
	case serverconfig.TypeEnum:
		return "|" + strings.Join(field.Choices, "|")
	case serverconfig.TypeCSV:
		return "<a,b>"
	case serverconfig.TypeSecret:
		return "<key>"
	default:
		return "<value>"
	}
}
