package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/codexappconfig"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
	"github.com/madou1217/ai_home/internal/runtime/codexexecintent"
)

// runCodexDefaultCLI 接管非交互 codex 子命令：默认账号环境、配置自愈、
// 启动策略/provider 参数，然后直接 exec 上游。交互式 TUI 仍走 Node 的
// local app-server 路径。
func runCodexDefaultCLI(ctx context.Context, args []string, runtime commandRuntime) error {
	upstream := ""
	interactive := false
	separator := -1
	for index := 0; index < len(args); index++ {
		switch {
		case args[index] == "--interactive":
			interactive = true
		case args[index] == "--":
			separator = index
			index = len(args)
		case args[index] == "--upstream":
			if index+1 >= len(args) {
				return errors.New("codex_default_cli_arguments_invalid")
			}
			upstream = strings.TrimSpace(args[index+1])
			index++
		case strings.HasPrefix(args[index], "--upstream="):
			upstream = strings.TrimSpace(strings.TrimPrefix(args[index], "--upstream="))
		case args[index] == "--state-file":
			index++
		case strings.HasPrefix(args[index], "--state-file="):
		}
	}
	if upstream == "" || separator < 0 {
		return errors.New("codex_default_cli_arguments_invalid")
	}
	forwardArgs := append([]string{}, args[separator+1:]...)
	if err := ctx.Err(); err != nil {
		return err
	}

	envMap := environmentSliceMap(os.Environ())
	aiHome := strings.TrimSpace(envMap["AIH_HOME_DIR"])
	if aiHome == "" {
		if home := strings.TrimSpace(envMap["HOME"]); home != "" {
			aiHome = filepath.Join(home, ".ai_home")
		}
	}
	hostHome := strings.TrimSpace(envMap["HOME"])
	spawnEnv, err := codexappserverws.BuildSpawnEnv(ctx, codexappserverws.SpawnEnvOptions{
		AIHomeDir: aiHome, HostHomeDir: hostHome, BaseEnv: os.Environ(),
	})
	if err != nil {
		return err
	}
	spawnMap := environmentSliceMap(spawnEnv)
	codexHome := strings.TrimSpace(spawnMap["CODEX_HOME"])
	if codexHome == "" {
		codexHome = filepath.Join(hostHome, providerroot.ConfigDir("codex"))
	}
	configPath := filepath.Join(codexHome, "config.toml")
	if _, healErr := codexappconfig.HealConfigFile(configPath, codexappconfig.HealOptions{}); healErr != nil {
		return healErr
	}

	if !codexappconfig.HasCodexModelProviderArg(forwardArgs) {
		apiKey := strings.TrimSpace(spawnMap["OPENAI_API_KEY"])
		baseURL := strings.TrimSpace(spawnMap["OPENAI_BASE_URL"])
		if apiKey != "" && baseURL != "" {
			forwardArgs = codexappconfig.InjectProviderArgs(forwardArgs, codexappconfig.BuildProviderArgs(spawnMap, codexappconfig.ProviderArgsOptions{}))
		}
	}
	if !hasStartupPolicyArg(forwardArgs) {
		forwardArgs = append(codexappconfig.BuildStartupPolicyArgs(), forwardArgs...)
	}
	if codexexecintent.IsExecResume(forwardArgs) {
		prepared, release, prepErr := codexexecintent.Prepare(ctx, "codex", upstream, forwardArgs, spawnEnv)
		if prepErr != nil {
			release()
			return prepErr
		}
		command := exec.CommandContext(ctx, upstream, prepared...)
		command.Env = spawnEnv
		command.Stdin = runtime.stdin
		command.Stdout = runtime.stdout
		command.Stderr = runtime.stderr
		runErr := command.Run()
		release()
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return runErr
	}
	if interactive && !localAppServerDisabled(envMap, forwardArgs) {
		proxy, proxyErr := startLocalAppServer(ctx, upstream, forwardArgs, spawnEnv, runtime.stderr)
		if proxyErr != nil {
			return proxyErr
		}
		launchArgs := append([]string{"--remote", proxy.RemoteURL, "--remote-auth-token-env", localRemoteTokenEnv}, forwardArgs...)
		command := exec.CommandContext(ctx, upstream, launchArgs...)
		command.Env = append(append([]string{}, spawnEnv...), localRemoteTokenEnv+"="+proxy.Token)
		command.Stdin = runtime.stdin
		command.Stdout = runtime.stdout
		command.Stderr = runtime.stderr
		runErr := command.Run()
		proxy.Close()
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return runErr
	}
	commandArgs := append([]string{upstream}, forwardArgs...)
	if goruntime.GOOS != "windows" {
		return syscall.Exec(upstream, commandArgs, spawnEnv)
	}
	command := exec.CommandContext(ctx, upstream, forwardArgs...)
	command.Env = spawnEnv
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	err = command.Run()
	if exitErr, ok := err.(*exec.ExitError); ok {
		os.Exit(exitErr.ExitCode())
	}
	return err
}

func environmentSliceMap(entries []string) map[string]string {
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			values[name] = value
		}
	}
	return values
}

func hasStartupPolicyArg(args []string) bool {
	for index, arg := range args {
		if arg == "-c" && index+1 < len(args) && strings.Contains(args[index+1], "suppress_unstable_features_warning") {
			return true
		}
		if strings.HasPrefix(arg, "--config=") && strings.Contains(arg, "suppress_unstable_features_warning") {
			return true
		}
	}
	return false
}
