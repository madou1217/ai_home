package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

// runCodexEffort updates native preferences, not the prompt sent to the model.
func runCodexEffort(arguments []string, runtime commandRuntime) error {
	normalized := make([]string, len(arguments))
	for i, arg := range arguments {
		normalized[i] = strings.ToLower(strings.TrimSpace(arg))
	}
	arguments = normalized
	const usage = "用法: aih codex effort [show|none|minimal|low|medium|high|xhigh|max|ultra|fast [on|off]]（fast 独立于推理强度）"
	if len(arguments) == 1 && isRootHelp(arguments[0]) {
		fmt.Fprintln(runtime.stdout, usage)
		return nil
	}
	key, value := "", ""
	if len(arguments) > 0 && arguments[0] != "show" {
		value = strings.ToLower(arguments[0])
		switch value {
		case "fast":
			key = "service_tier"
			value = "fast"
			if len(arguments) == 2 {
				switch arguments[1] {
				case "on":
				case "off":
					value = "default"
				default:
					return fmt.Errorf("%w: %s", errInvalidCommand, usage)
				}
			}
		case "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra":
			key = "model_reasoning_effort"
		default:
			return fmt.Errorf("%w: %s", errInvalidCommand, usage)
		}
	}
	if len(arguments) > 2 || (len(arguments) > 1 && arguments[0] != "fast") {
		return fmt.Errorf("%w: %s", errInvalidCommand, usage)
	}
	home := lookupOrDefault(runtime.lookupEnv, "CODEX_HOME", "")
	if home == "" {
		host := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
		if host == "" {
			var err error
			host, err = runtime.userHomeDir()
			if err != nil {
				return err
			}
		}
		home = filepath.Join(host, ".codex")
	}
	var prefs codexpreferences.Snapshot
	var err error
	if key == "" {
		prefs, err = codexpreferences.Read(home)
	} else {
		prefs, err = codexpreferences.Update(home, key, value)
	}
	if err != nil {
		return err
	}
	if key != "" {
		fmt.Fprintln(runtime.stdout, "已保存 Codex 配置；新启动的会话生效，实际可用性取决于模型和账号。")
	}
	fmt.Fprintf(runtime.stdout, "model_reasoning_effort: %s\nservice_tier: %s\nconfig: %s\n", prefs.Effort, prefs.Tier, prefs.Path)
	return nil
}
