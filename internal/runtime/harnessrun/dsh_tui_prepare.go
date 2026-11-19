package harnessrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// prepareDshTuiHarness 复刻 prepareDshTuiHarness：HOME + DSH_HOME 双投影、
// profile bundle 就绪检查与按需补装、偏好预写、会话链接。
func prepareDshTuiHarness(input prepareInput) (preparedLaunch, error) {
	models, model, err := resolveHarnessModels(input)
	if err != nil {
		return preparedLaunch{}, err
	}
	aiHomeDir := strings.TrimSpace(input.AIHomeDir)
	if aiHomeDir == "" {
		return preparedLaunch{}, errors.New("ai_home_dir_missing")
	}
	projectionRoot, err := resolveProjectionRoot(aiHomeDir, "dsh-tui", input.AccountRef)
	if err != nil {
		return preparedLaunch{}, err
	}
	homeDir := filepath.Join(projectionRoot, "home")
	dshHome := filepath.Join(projectionRoot, "dsh")
	if err := os.MkdirAll(homeDir, privateDirMode); err != nil {
		return preparedLaunch{}, err
	}
	if err := os.MkdirAll(dshHome, privateDirMode); err != nil {
		return preparedLaunch{}, err
	}

	entryPath := resolveDshEntry(input.BinPath)
	if entryPath == "" {
		return preparedLaunch{}, errors.New("dsh_entry_not_found")
	}
	nodeExec := strings.TrimSpace(input.NodeExec)
	if nodeExec == "" {
		return preparedLaunch{}, errors.New("node_executable_missing")
	}

	if _, err := ensureDshTuiProfile(dshHome, dshPatchInput{
		BaseURL:    input.Gateway.BaseURL,
		AccountRef: input.AccountRef,
		Models:     models,
		Model:      model,
	}); err != nil {
		return preparedLaunch{}, err
	}

	launchEnv := mergeEnv(
		buildHomeProjectionEnv(homeDir, input.HostHomeDir),
		map[string]string{
			"DSH_HOME":       dshHome,
			"OPENAI_API_KEY": input.Gateway.APIKey,
		},
	)
	nodePathPatch := nodePathEnv(entryPath, input.BaseEnv["NODE_PATH"])
	wrapperPath := filepath.Join(projectionRoot, dshTuiWrapperFile)
	if err := writePrivateText(wrapperPath, buildDshWrapperSource(entryPath)); err != nil {
		return preparedLaunch{}, err
	}

	// profile 本体缺 bundle（或依赖树残缺）时补装一次；就绪判据仍以
	// isBundleReady 为准（修复路径上 dsh 可能以 0 退出但依赖仍不齐）。
	if !isBundleReady(dshHome) {
		installEnv := mergeEnv(input.BaseEnv, launchEnv, nodePathPatch)
		ok, _, output := runDshCLI(
			nodeExec,
			append([]string{wrapperPath}, buildDshTuiInstallArgs()...),
			projectionRoot,
			installEnv,
			dshTuiInstallTimeout,
		)
		installed := ok && isBundleReady(dshHome)
		if !installed {
			reason := strings.TrimSpace(output)
			if ok {
				reason = "profile bundle 安装后依赖仍不完整（dsh plugin add 未补齐 dependencies）"
			}
			if reason == "" {
				reason = "dsh plugin add 失败"
			}
			return preparedLaunch{}, dshTuiInstallFailure(reason)
		}
	}

	if _, err := ensureTuiPreferences(homeDir, model); err != nil {
		return preparedLaunch{}, err
	}
	linkHostSessions(dshHome, input.HostHomeDir, []string{".dsh"})

	pluginArgs, pluginErr := buildHostPluginArgs(context.Background(), aiHomeDir, input.HostHomeDir, "deepseek")
	if pluginErr != nil {
		return preparedLaunch{}, pluginErr
	}
	nativeArgs := append([]string(nil), pluginArgs...)
	nativeArgs = append(nativeArgs, input.NativeArgs...)
	launchArgs := append([]string{"--profile", dshTuiProfileName}, nativeArgs...)

	env := mergeEnv(launchEnv, nodePathPatch)
	return preparedLaunch{
		File:  nodeExec,
		Args:  append([]string{wrapperPath}, launchArgs...),
		Env:   env,
		Model: model,
	}, nil
}
