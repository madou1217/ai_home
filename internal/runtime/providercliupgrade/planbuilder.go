package providercliupgrade

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const (
	// CodexInstallSH / CodexInstallPS1 是官方 Codex standalone 渠道安装脚本地址。
	CodexInstallSH  = "https://chatgpt.com/codex/install.sh"
	CodexInstallPS1 = "https://chatgpt.com/codex/install.ps1"

	defaultPosixInstallTimeout  = 15 * time.Minute
	defaultNpmInstallTimeout    = 20 * time.Minute
	defaultVendorInstallTimeout = 10 * time.Minute
)

// InstallPlan 描述一次可执行的 CLI 定向安装/回滚命令。
type InstallPlan struct {
	ID          string
	Label       string
	Command     string
	Args        []string
	Env         map[string]string
	Timeout     time.Duration
	PostInstall []string
}

// PlanBuildInput 描述构造定向安装计划的输入上下文。
type PlanBuildInput struct {
	Channel     string
	PackageName string
	Version     string
	GoOS        string
	InstallDir  string
	Provider    string
	CLIPath     string
	BaseEnv     map[string]string
}

// BuildPinnedPlans 为升级或回滚构建确定版本安装计划。
func BuildPinnedPlans(input PlanBuildInput) ([]InstallPlan, string) {
	version := NormalizeVersionSpec(input.Version)
	if version == "" {
		return nil, "invalid_version"
	}
	goos := strings.TrimSpace(input.GoOS)
	if goos == "" {
		goos = runtime.GOOS
	}

	channel := strings.TrimSpace(input.Channel)
	switch channel {
	case ChannelStandaloneRelease:
		plan, ok := buildStandalonePinnedPlan(version, goos, input.InstallDir, input.BaseEnv)
		if !ok {
			return nil, "standalone_plan_unavailable"
		}
		return []InstallPlan{plan}, ""

	case ChannelNpmGlobal:
		pkg := strings.TrimSpace(input.PackageName)
		if pkg == "" {
			return nil, "missing_package_name"
		}
		userConfig := "/dev/null"
		cmd := "npm"
		if isWindowsOS(goos) {
			userConfig = "NUL"
			cmd = "npm.cmd"
		}
		spec := pkg + "@" + version
		return []InstallPlan{{
			ID:      "npm_global_pin_" + version,
			Label:   fmt.Sprintf("安装 %s（npm 全局渠道）", spec),
			Command: cmd,
			Args: []string{
				"install", "--global", spec,
				"--userconfig=" + userConfig,
				"--registry=" + NpmRegistryURL,
				"--maxsockets=4",
				"--fetch-timeout=60000",
				"--fetch-retries=3",
				"--fetch-retry-mintimeout=5000",
				"--fetch-retry-maxtimeout=20000",
				"--no-audit",
				"--no-fund",
			},
			Timeout: defaultNpmInstallTimeout,
		}}, ""

	case ChannelVendorSelfUpdate:
		args, ok := VendorPinnedArgs(input.Provider, version)
		cliPath := strings.TrimSpace(input.CLIPath)
		if !ok || cliPath == "" {
			return nil, "channel_not_pinnable"
		}
		return []InstallPlan{{
			ID:      fmt.Sprintf("%s_vendor_pin_%s", input.Provider, version),
			Label:   fmt.Sprintf("安装 %s %s（官方自更新命令）", input.Provider, version),
			Command: cliPath,
			Args:    args,
			Timeout: defaultVendorInstallTimeout,
		}}, ""

	default:
		return nil, "channel_not_pinnable"
	}
}

func buildStandalonePinnedPlan(version string, goos string, installDir string, baseEnv map[string]string) (InstallPlan, bool) {
	env := map[string]string{
		"CODEX_RELEASE": version,
	}
	for k, v := range buildInstallDirEnv(installDir, goos, baseEnv) {
		env[k] = v
	}

	if isWindowsOS(goos) {
		psScript := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $tmpDir = if ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }; $script = Join-Path $tmpDir (\"aih-installer-\" + $PID + \".ps1\"); try { Invoke-WebRequest -UseBasicParsing -Uri '%s' -OutFile $script; & $script } finally { if (Test-Path $script) { Remove-Item -Force $script -ErrorAction SilentlyContinue } }",
			CodexInstallPS1,
		)
		return InstallPlan{
			ID:          "codex_standalone_pin_" + version,
			Label:       fmt.Sprintf("安装 Codex %s（官方 standalone 渠道）", version),
			Command:     "powershell.exe",
			Args:        []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript},
			Env:         env,
			Timeout:     defaultPosixInstallTimeout,
			PostInstall: []string{PostInstallReinstallCodexCLIHook},
		}, true
	}

	shScript := fmt.Sprintf(
		"set -euo pipefail; tmp_dir=\"${TMPDIR:-/tmp}\"; script=\"$tmp_dir/aih-installer-$$.sh\"; trap 'rm -f \"$script\"' EXIT; curl --compressed -fsSL '%s' -o \"$script\"; bash \"$script\"",
		CodexInstallSH,
	)
	return InstallPlan{
		ID:          "codex_standalone_pin_" + version,
		Label:       fmt.Sprintf("安装 Codex %s（官方 standalone 渠道）", version),
		Command:     "bash",
		Args:        []string{"-c", shScript},
		Env:         env,
		Timeout:     defaultPosixInstallTimeout,
		PostInstall: []string{PostInstallReinstallCodexCLIHook},
	}, true
}

// buildInstallDirEnv 把 BIN_DIR 放进子进程 PATH，避免 install.sh 改写用户的 ~/.zprofile。
func buildInstallDirEnv(installDir string, goos string, baseEnv map[string]string) map[string]string {
	dir := strings.TrimSpace(installDir)
	if dir == "" {
		return nil
	}
	out := map[string]string{"CODEX_INSTALL_DIR": dir}
	currentPath := lookupEnvMapOrOS(baseEnv, "PATH")
	sep := ":"
	if isWindowsOS(goos) {
		sep = ";"
	}
	alreadyOnPath := false
	for _, entry := range strings.Split(currentPath, sep) {
		if entry == dir {
			alreadyOnPath = true
			break
		}
	}
	if !alreadyOnPath {
		if currentPath == "" {
			out["PATH"] = dir
		} else {
			out["PATH"] = dir + sep + currentPath
		}
	}
	return out
}

// ExecuteInstallPlans 顺序执行安装计划，遇到失败立即中止并返回详情。
func ExecuteInstallPlans(ctx context.Context, plans []InstallPlan, goos string, baseEnv map[string]string) PlanResult {
	if len(plans) == 0 {
		return PlanResult{OK: false, Error: "no_plan"}
	}
	var last PlanResult
	for _, plan := range plans {
		last = executeSingleInstallPlan(ctx, plan, goos, baseEnv)
		if !last.OK {
			return last
		}
	}
	return last
}

func executeSingleInstallPlan(ctx context.Context, plan InstallPlan, goos string, baseEnv map[string]string) PlanResult {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := plan.Timeout
	if timeout <= 0 {
		timeout = defaultNpmInstallTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var cmd *exec.Cmd
	if isWindowsOS(goos) && cmdOrBatExtRe.MatchString(plan.Command) {
		parts := make([]string, 0, len(plan.Args)+1)
		parts = append(parts, `"`+plan.Command+`"`)
		for _, a := range plan.Args {
			parts = append(parts, `"`+strings.ReplaceAll(a, `"`, `\"`)+`"`)
		}
		cmd = exec.CommandContext(runCtx, "cmd.exe", "/d", "/s", "/c", strings.Join(parts, " "))
	} else {
		cmd = exec.CommandContext(runCtx, plan.Command, plan.Args...)
	}

	mergedEnv := buildChildEnvMap(baseEnv, plan.Env)
	cmd.Env = envSliceFromMap(mergedEnv)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return PlanResult{
			OK:     false,
			Error:  err.Error(),
			Stdout: stdout.String(),
			Stderr: stderr.String(),
		}
	}
	return PlanResult{
		OK:     true,
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
}

func buildChildEnvMap(baseEnv map[string]string, overrides map[string]string) map[string]string {
	merged := make(map[string]string)
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx > 0 {
			merged[entry[:idx]] = entry[idx+1:]
		}
	}
	for k, v := range baseEnv {
		merged[k] = v
	}
	merged["CI"] = "1"
	merged["NONINTERACTIVE"] = "1"
	for k, v := range overrides {
		merged[k] = v
	}
	return merged
}
