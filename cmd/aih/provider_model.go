package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

const codexModelUsage = "用法: aih codex model [show|<模型 ID>]"

// sharedCodexHomeDir 是启动与偏好写入共享的 Codex 配置根：
// 显式 CODEX_HOME 优先；否则用未被投影的宿主家目录（投影 HOME 不保存用户偏好）。
func sharedCodexHomeDir(runtime commandRuntime) string {
	if home := strings.TrimSpace(lookupOrDefault(runtime.lookupEnv, "CODEX_HOME", "")); home != "" {
		return home
	}
	host := terminalSessionHostHome(runtime)
	if host == "" {
		return ""
	}
	return filepath.Join(host, providerroot.ConfigDir("codex"))
}

func codexPreferencesHome(runtime commandRuntime) (string, error) {
	home := sharedCodexHomeDir(runtime)
	if home == "" {
		return "", errInvalidCommand
	}
	return home, nil
}

// printCodexPreferences 是 model/effort 两个入口共享的只读视图。
func printCodexPreferences(runtime commandRuntime, prefs codexpreferences.Snapshot) {
	fmt.Fprintf(
		runtime.stdout,
		"model: %s\nmodel_reasoning_effort: %s\nservice_tier: %s\nconfig: %s\n",
		prefs.Model,
		prefs.Effort,
		prefs.Tier,
		prefs.Path,
	)
}

// runCodexModel 读取或写入 Codex 的默认模型；写入位置与 CLI 启动实际读取的配置一致。
func runCodexModel(arguments []string, runtime commandRuntime) error {
	if len(arguments) == 1 && isRootHelp(arguments[0]) {
		fmt.Fprintln(runtime.stdout, codexModelUsage)
		return nil
	}
	if len(arguments) > 1 {
		return fmt.Errorf("%w: %s", errInvalidCommand, codexModelUsage)
	}
	home, err := codexPreferencesHome(runtime)
	if err != nil {
		return err
	}
	if len(arguments) == 0 || strings.EqualFold(strings.TrimSpace(arguments[0]), "show") {
		prefs, readErr := codexpreferences.Read(home)
		if readErr != nil {
			return readErr
		}
		printCodexPreferences(runtime, prefs)
		return nil
	}
	model := strings.TrimSpace(arguments[0])
	if model == "" {
		return fmt.Errorf("%w: %s", errInvalidCommand, codexModelUsage)
	}
	prefs, err := codexpreferences.Update(home, "model", model)
	if err != nil {
		return err
	}
	fmt.Fprintln(runtime.stdout, "已保存 Codex 默认模型；新启动的会话生效。")
	printCodexPreferences(runtime, prefs)
	return nil
}
