package permissionlaunch

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
)

// argvConfigRules 声明「命令行旗标 → 宿主配置键」的对照关系。
//
// 只登记同一件事两种表达都已知的组合；未登记的旗标不参与去重（宁可多注入，也不
// 静默丢掉权限）。新增 Provider 只加一行，逻辑不认 Provider 名。
var argvConfigRules = map[string][]argConfigRule{
	"codex": {
		{Flag: "--sandbox", Aliases: []string{"-s"}, Keys: []string{"sandbox_mode"}},
		{Flag: "--ask-for-approval", Aliases: []string{"-a"}, Keys: []string{"approval_policy"}},
	},
	"claude": {
		{Flag: "--permission-mode", Keys: []string{"permissions.defaultMode"}},
	},
}

type argConfigRule struct {
	Flag    string
	Aliases []string
	Keys    []string
}

type hostPermissionState struct {
	Known bool
	Items []hostPermissionItem
}

type hostPermissionItem struct {
	Key      string
	Expected string
	Actual   string
	Matched  bool
}

// readHostPermissionState 读取宿主配置里已经表达的权限值。
//
// 必须显式给出 hostHomeDir 才读配置：不传就退回进程 HOME 会让「读的是谁的配置」
// 变得隐式，也可能把用户真实宿主配置的内容混进一次隔离启动。
func readHostPermissionState(options Options, providerID string, argv []string) hostPermissionState {
	provider := normalizeProvider(providerID)
	hostHome := strings.TrimSpace(options.HostHomeDir)
	if hostHome == "" {
		return hostPermissionState{}
	}
	pairs := argvToConfigPairs(provider, argv)
	if len(pairs) == 0 {
		return hostPermissionState{}
	}
	target, err := configedit.ResolveAppTarget(options.Catalog, provider, hostHome, options.GOOS, lookupEnv(options))
	if err != nil || strings.TrimSpace(target.TargetPath) == "" {
		return hostPermissionState{}
	}
	content, err := os.ReadFile(target.TargetPath)
	if err != nil {
		return hostPermissionState{}
	}
	format := target.ConfigFormat
	if format == "" {
		format = strings.TrimPrefix(strings.ToLower(filepath.Ext(target.TargetPath)), ".")
	}
	items := make([]hostPermissionItem, 0, len(pairs))
	for _, pair := range pairs {
		actual, found := providerconfigs.LookupValue(string(content), format, pair.Key)
		items = append(items, hostPermissionItem{
			Key:      pair.Key,
			Expected: pair.Value,
			Actual:   actual,
			Matched:  found && strings.TrimSpace(actual) == strings.TrimSpace(pair.Value),
		})
	}
	return hostPermissionState{Known: true, Items: items}
}

type configPair struct {
	Key   string
	Value string
}

func argvToConfigPairs(provider string, argv []string) []configPair {
	rules := argvConfigRules[provider]
	if len(rules) == 0 {
		return nil
	}
	args := make([]string, 0, len(argv))
	for _, item := range argv {
		if text := strings.TrimSpace(item); text != "" {
			args = append(args, text)
		}
	}
	pairs := make([]configPair, 0, len(args))
	for index := 0; index < len(args); index++ {
		rule := findArgvRule(rules, args[index])
		if rule == nil {
			continue
		}
		if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") {
			continue
		}
		value := args[index+1]
		index++
		for _, key := range rule.Keys {
			pairs = append(pairs, configPair{Key: key, Value: value})
		}
	}
	return pairs
}

func findArgvRule(rules []argConfigRule, flag string) *argConfigRule {
	name := strings.TrimSpace(flag)
	if name == "" {
		return nil
	}
	for index := range rules {
		rule := &rules[index]
		if rule.Flag == name {
			return rule
		}
		for _, alias := range rule.Aliases {
			if alias == name {
				return rule
			}
		}
	}
	return nil
}

// dropHostSatisfiedArgs 从待注入参数里剔除「宿主配置已经表达」的项。
// 只丢整对（旗标+值）都满足的参数；部分满足时保留，用于补全缺失维度。
func dropHostSatisfiedArgs(provider string, argv []string, state hostPermissionState) []string {
	if !state.Known || len(state.Items) == 0 {
		return append([]string(nil), argv...)
	}
	satisfied := map[string]bool{}
	for _, item := range state.Items {
		if item.Matched {
			satisfied[item.Key] = true
		}
	}
	if len(satisfied) == 0 {
		return append([]string(nil), argv...)
	}
	kept := make([]string, 0, len(argv))
	for index := 0; index < len(argv); index++ {
		flag := strings.TrimSpace(argv[index])
		value := ""
		hasValue := index+1 < len(argv) && !strings.HasPrefix(strings.TrimSpace(argv[index+1]), "-")
		if hasValue {
			value = strings.TrimSpace(argv[index+1])
		}
		if hasValue {
			pairs := argvToConfigPairs(provider, []string{flag, value})
			allSatisfied := len(pairs) > 0
			for _, pair := range pairs {
				if !satisfied[pair.Key] {
					allSatisfied = false
					break
				}
			}
			if allSatisfied {
				index++
				continue
			}
		}
		kept = append(kept, argv[index])
		if hasValue {
			kept = append(kept, argv[index+1])
			index++
		}
	}
	return kept
}

func lookupEnv(options Options) func(string) string {
	if options.LookupEnv != nil {
		return options.LookupEnv
	}
	if len(options.Env) > 0 {
		return func(name string) string { return options.Env[name] }
	}
	return os.Getenv
}
