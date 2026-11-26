package clilaunch

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The interactive OpenCode TUI rejects `--model`; a one-shot `opencode run`
// accepts it. Model preselection for the TUI therefore has to travel through
// OPENCODE_CONFIG_CONTENT. This file owns that vendor fact.

// SplitInteractiveModel 从交互式参数里取出 --model/-m 选择并返回剩余参数。
// 含 run 子命令时保持原样（run 自己支持 --model）。
func SplitInteractiveModel(arguments []string) (remaining []string, model string, ok bool) {
	for _, argument := range arguments {
		if argument == "run" {
			return arguments, "", false
		}
	}
	remaining = make([]string, 0, len(arguments))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case argument == "--model" || argument == "-m":
			if index+1 < len(arguments) {
				model = strings.TrimSpace(arguments[index+1])
				index++
			}
		case strings.HasPrefix(argument, "--model="):
			model = strings.TrimSpace(strings.TrimPrefix(argument, "--model="))
		case strings.HasPrefix(argument, "-m="):
			model = strings.TrimSpace(strings.TrimPrefix(argument, "-m="))
		default:
			remaining = append(remaining, argument)
		}
	}
	return remaining, model, model != ""
}

// MergeConfigModel 把模型写进已有的 OPENCODE_CONFIG_CONTENT JSON 对象。
// 既有内容不是 JSON 对象时失败关闭，避免静默丢掉用户配置。
func MergeConfigModel(existing, model string) (string, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		return "", fmt.Errorf("opencode 模型为空")
	}
	document := map[string]any{}
	if trimmed := strings.TrimSpace(existing); trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
			return "", fmt.Errorf("OPENCODE_CONFIG_CONTENT 不是 JSON 对象: %w", err)
		}
	}
	document["model"] = model
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
