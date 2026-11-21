package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/codexappconfig"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

// runCodexCLIResume 接管 codex resume 的交互式启动：先自愈配置，再按“本地
// app-server + --remote”路径启动 TUI；显式 --remote、--help、profile 或禁用
// 本地 app-server 时直接 exec 上游，保持用户显式选择。
func runCodexCLIResume(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-codex-cli-resume-v1")
		return err
	}
	upstream := ""
	separator := -1
	for index := 0; index < len(args); index++ {
		switch {
		case args[index] == "--":
			separator = index
			index = len(args)
		case args[index] == "--upstream":
			if index+1 >= len(args) {
				return errors.New("codex_cli_resume_arguments_invalid")
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
	if upstream == "" || separator < 0 || separator+1 >= len(args) {
		return errors.New("codex_cli_resume_arguments_invalid")
	}
	forward := append([]string{}, args[separator+1:]...)
	if len(forward) == 0 || strings.TrimSpace(forward[0]) != "resume" {
		return execCodexUpstream(ctx, upstream, forward, os.Environ(), runtime)
	}
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
	if _, healErr := codexappconfig.HealConfigFile(filepath.Join(codexHome, "config.toml"), codexappconfig.HealOptions{}); healErr != nil {
		return healErr
	}
	if localAppServerDisabled(spawnMap, forward) || hasExplicitRemoteArg(forward) || hasHelpArg(forward) {
		return execCodexUpstream(ctx, upstream, forward, spawnEnv, runtime)
	}

	stripped, removed := codexappconfig.StripPermissionOverrides(forward)
	if len(removed) > 0 {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 远程恢复会话时不接受权限覆盖，已忽略：%s\n", strings.Join(removed, " "))
	}
	if !codexappconfig.HasCodexModelProviderArg(stripped) {
		if strings.TrimSpace(spawnMap["OPENAI_API_KEY"]) != "" && strings.TrimSpace(spawnMap["OPENAI_BASE_URL"]) != "" {
			stripped = codexappconfig.InjectProviderArgs(stripped, codexappconfig.BuildProviderArgs(spawnMap, codexappconfig.ProviderArgsOptions{}))
		}
	}
	if !hasStartupPolicyArg(stripped) {
		stripped = append(codexappconfig.BuildStartupPolicyArgs(), stripped...)
	}

	proxy, err := startLocalAppServer(ctx, upstream, stripped, spawnEnv, runtime.stderr)
	if err != nil {
		return err
	}
	resumeIndex := -1
	for index, token := range stripped {
		if strings.TrimSpace(token) == "resume" {
			resumeIndex = index
			break
		}
	}
	remoteArgs := []string{"--remote", proxy.RemoteURL, "--remote-auth-token-env", localRemoteTokenEnv}
	launchArgs := make([]string, 0, len(stripped)+len(remoteArgs))
	if resumeIndex >= 0 {
		launchArgs = append(launchArgs, stripped[:resumeIndex+1]...)
		launchArgs = append(launchArgs, remoteArgs...)
		launchArgs = append(launchArgs, stripped[resumeIndex+1:]...)
	} else {
		launchArgs = append(launchArgs, remoteArgs...)
		launchArgs = append(launchArgs, stripped...)
	}
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

func execCodexUpstream(ctx context.Context, upstream string, args []string, env []string, runtime commandRuntime) error {
	if len(env) == 0 {
		env = os.Environ()
	}
	if goruntime.GOOS != "windows" {
		return syscall.Exec(upstream, append([]string{upstream}, args...), env)
	}
	command := exec.CommandContext(ctx, upstream, args...)
	command.Env = env
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	err := command.Run()
	if exitErr, ok := err.(*exec.ExitError); ok {
		os.Exit(exitErr.ExitCode())
	}
	return err
}

func hasHelpArg(args []string) bool {
	for _, token := range args {
		if value := strings.TrimSpace(token); value == "--help" || value == "-h" {
			return true
		}
	}
	return false
}

func hasExplicitRemoteArg(args []string) bool {
	for _, token := range args {
		value := strings.TrimSpace(token)
		if value == "--remote" || strings.HasPrefix(value, "--remote=") ||
			value == "--remote-auth-token-env" || strings.HasPrefix(value, "--remote-auth-token-env=") {
			return true
		}
	}
	return false
}
