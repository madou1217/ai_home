package harnessrun

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
)

// prepareDshHarness 复刻 prepareDshHarness。
//
// Node 的 `aih harness dsh` 路径没有传 binaryPath（只有 `aih dsh` 路径解析 PATH），
// 因此 Node 在这里会以 dsh_entry_not_found 失败。Go 作为严格超集：binPath 为空时
// 用描述符里的 binaryName（dsh）从 PATH 解析入口；解析不到仍然报同一个错误。
func prepareDshHarness(input prepareInput) (preparedLaunch, error) {
	models, model, err := resolveHarnessModels(input)
	if err != nil {
		return preparedLaunch{}, err
	}
	dshHome, err := resolveProjectionRoot(input.AIHomeDir, "dsh", input.AccountRef)
	if err != nil {
		return preparedLaunch{}, err
	}
	if _, err := ensureDshProfile(dshHome, dshPatchInput{
		BaseURL:    input.Gateway.BaseURL,
		AccountRef: input.AccountRef,
		Models:     models,
		Model:      model,
	}); err != nil {
		return preparedLaunch{}, err
	}
	linkHostSessions(dshHome, input.HostHomeDir, []string{".dsh"})

	entryPath := resolveDshEntry(input.BinPath)
	if entryPath == "" {
		return preparedLaunch{}, errors.New("dsh_entry_not_found")
	}
	nodeExec := strings.TrimSpace(input.NodeExec)
	if nodeExec == "" {
		return preparedLaunch{}, errors.New("node_executable_missing")
	}
	wrapperPath := filepath.Join(dshHome, dshWrapperFile)
	if err := writePrivateText(wrapperPath, buildDshWrapperSource(entryPath)); err != nil {
		return preparedLaunch{}, err
	}

	pluginArgs, pluginErr := buildHostPluginArgs(context.Background(), input.AIHomeDir, input.HostHomeDir, "deepseek")
	if pluginErr != nil {
		return preparedLaunch{}, pluginErr
	}
	nativeArgs := append([]string(nil), pluginArgs...)
	nativeArgs = append(nativeArgs, input.NativeArgs...)
	dshArgs := append([]string{"--profile", dshProfileName}, nativeArgs...)

	env := map[string]string{
		"DSH_HOME":       dshHome,
		"OPENAI_API_KEY": input.Gateway.APIKey,
	}
	nodePathPatch := nodePathEnv(entryPath, input.BaseEnv["NODE_PATH"])
	for key, value := range nodePathPatch {
		env[key] = value
	}
	return preparedLaunch{
		File:  nodeExec,
		Args:  append([]string{wrapperPath}, dshArgs...),
		Env:   env,
		Model: model,
	}, nil
}
