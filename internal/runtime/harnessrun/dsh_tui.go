package harnessrun

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	dshTuiProfileName      = "dsh-tui"
	dshTuiProfileBundle    = "@deepseek-harness-tui/dsh-tui"
	dshTuiBaseBundle       = "@deepseek-ai/dsh-base"
	dshTuiWrapperFile      = "run-dsh-tui.mjs"
	dshTuiConfigDirname    = ".dsh-tui"
	dshTuiOnboardingFile   = "onboarding.json"
	dshTuiModelPrefsFile   = "model.json"
	dshTuiInstallTimeout   = 10 * time.Minute
	dshTuiInstallOutputCap = 64 * 1024
)

// buildHomeProjectionEnv 复刻 dsh-tui 的 HOME 投影：homedir() 在 macOS/Linux 读
// HOME，Windows 读 USERPROFILE；XDG 配置与状态跟身份走，缓存留宿主。
func buildHomeProjectionEnv(homeDir string, hostHomeDir string) map[string]string {
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return map[string]string{}
	}
	env := map[string]string{
		"HOME":            homeDir,
		"USERPROFILE":     homeDir,
		"XDG_CONFIG_HOME": homeDir,
		"XDG_DATA_HOME":   filepath.Join(homeDir, ".local", "share"),
		"XDG_STATE_HOME":  filepath.Join(homeDir, ".local", "state"),
	}
	if hostHomeDir = strings.TrimSpace(hostHomeDir); hostHomeDir != "" {
		env["XDG_CACHE_HOME"] = filepath.Join(hostHomeDir, ".cache")
	}
	return env
}

type tuiPreferences struct {
	DataDir        string
	OnboardingPath string
	ModelPath      string
}

// ensureTuiPreferences 预写 onboarding completed 与 provider/model
// （只在首次写入；用户之后在 TUI 内的修改不被覆盖）。
func ensureTuiPreferences(homeDir string, model string) (tuiPreferences, error) {
	dataDir := filepath.Join(homeDir, dshTuiConfigDirname)
	if err := os.MkdirAll(dataDir, privateDirMode); err != nil {
		return tuiPreferences{}, err
	}
	paths := tuiPreferences{
		DataDir:        dataDir,
		OnboardingPath: filepath.Join(dataDir, dshTuiOnboardingFile),
		ModelPath:      filepath.Join(dataDir, dshTuiModelPrefsFile),
	}
	if _, err := os.Stat(paths.OnboardingPath); os.IsNotExist(err) {
		if err := writePrivateJSON(paths.OnboardingPath, map[string]any{"completed": true, "version": 1}); err != nil {
			return tuiPreferences{}, err
		}
	}
	if _, err := os.Stat(paths.ModelPath); os.IsNotExist(err) && strings.TrimSpace(model) != "" {
		if err := writePrivateJSON(paths.ModelPath, map[string]any{"provider": "aih", "model": strings.TrimSpace(model)}); err != nil {
			return tuiPreferences{}, err
		}
	}
	return paths, nil
}

func dshTuiInstalledBundleDir(profileDir string) string {
	return filepath.Join(profileDir, "node_modules", filepath.FromSlash(dshTuiProfileBundle))
}

// readInstalledBundleVersion 读已安装 bundle 的 version；读不到返回空串。
func readInstalledBundleVersion(profileDir string) string {
	manifest := readJSONObject(filepath.Join(dshTuiInstalledBundleDir(profileDir), "package.json"))
	return normalizeTextValue(manifest["version"])
}

// buildDshTuiProfilePackage 复刻 buildDshTuiProfilePackage：defaults 覆盖 pkg
// （与 dsh profile 的覆盖方向相反），dependencies 必须声明 bundle。
func buildDshTuiProfilePackage(previous map[string]any, installedVersion string) map[string]any {
	dsh := objectOrEmpty(previous["dsh"])
	profile := objectOrEmpty(dsh["profile"])
	bundles := stringSlice(profile["bundles"])
	for _, bundle := range []string{dshTuiBaseBundle, dshTuiProfileBundle} {
		if !containsString(bundles, bundle) {
			bundles = append(bundles, bundle)
		}
	}
	profile["bundles"] = bundles
	dsh["profile"] = profile

	dependencies := objectOrEmpty(previous["dependencies"])
	if normalizeTextValue(dependencies[dshTuiProfileBundle]) == "" {
		version := strings.TrimSpace(installedVersion)
		if version != "" {
			dependencies[dshTuiProfileBundle] = "^" + version
		} else {
			dependencies[dshTuiProfileBundle] = "latest"
		}
	}
	next := cloneObject(previous)
	name := normalizeTextValue(previous["name"])
	if name == "" {
		name = "dsh-profile-" + dshTuiProfileName
	}
	next["name"] = name
	next["private"] = previous["private"] != false
	next["dependencies"] = dependencies
	next["dsh"] = dsh
	return next
}

// ensureDshTuiProfile 复刻 ensureDshTuiProfile。
func ensureDshTuiProfile(dshHome string, input dshPatchInput) (dshProfilePaths, error) {
	if strings.TrimSpace(dshHome) == "" {
		return dshProfilePaths{}, errors.New("dsh_home_missing")
	}
	profileDir := filepath.Join(dshHome, "profiles", dshTuiProfileName)
	if err := os.MkdirAll(profileDir, privateDirMode); err != nil {
		return dshProfilePaths{}, err
	}
	if err := writePrivateText(filepath.Join(profileDir, dshRefreshFile), dshModelRefreshSource); err != nil {
		return dshProfilePaths{}, err
	}
	paths := dshProfilePaths{
		ProfileDir:    profileDir,
		ProfileName:   dshTuiProfileName,
		PackagePath:   filepath.Join(profileDir, "package.json"),
		PatchPath:     filepath.Join(profileDir, "cordis.patch.yml"),
		CordisPath:    filepath.Join(profileDir, "cordis.yml"),
		WorkspacePath: filepath.Join(profileDir, "pnpm-workspace.yaml"),
	}
	if err := ensureFileIfMissing(paths.CordisPath, dshCordisYML); err != nil {
		return dshProfilePaths{}, err
	}
	if err := ensureFileIfMissing(paths.WorkspacePath, dshPnPmWorkspaceYML); err != nil {
		return dshProfilePaths{}, err
	}
	previous := readJSONObject(paths.PackagePath)
	if err := writePrivateJSON(paths.PackagePath, buildDshTuiProfilePackage(previous, readInstalledBundleVersion(profileDir))); err != nil {
		return dshProfilePaths{}, err
	}
	existing := "[]\n"
	if content, err := os.ReadFile(paths.PatchPath); err == nil {
		existing = string(content)
	}
	entries, err := parseDshPatch(existing)
	if err != nil {
		return dshProfilePaths{}, err
	}
	merged := mergeDshPatchEntries(entries, input)
	serialized, err := serializeDshPatch(merged)
	if err != nil {
		return dshProfilePaths{}, err
	}
	return paths, writePrivateText(paths.PatchPath, serialized)
}

func hasInstalledBundle(dshHome string) bool {
	profileDir := filepath.Join(dshHome, "profiles", dshTuiProfileName)
	content, err := os.ReadFile(filepath.Join(dshTuiInstalledBundleDir(profileDir), "package.json"))
	return err == nil && strings.TrimSpace(string(content)) != ""
}

// isBundleReady 比「包文件存在」严格两档：
//  1. profile package.json 必须声明 bundle 依赖；
//  2. bundle 声明的非 optional dependencies 必须能从 profile 或 bundle 自身解析。
func isBundleReady(dshHome string) bool {
	if strings.TrimSpace(dshHome) == "" || !hasInstalledBundle(dshHome) {
		return false
	}
	profileDir := filepath.Join(dshHome, "profiles", dshTuiProfileName)
	profileDocument := readJSONObject(filepath.Join(profileDir, "package.json"))
	dependencies := objectOrEmpty(profileDocument["dependencies"])
	if normalizeTextValue(dependencies[dshTuiProfileBundle]) == "" {
		return false
	}
	bundleDir := dshTuiInstalledBundleDir(profileDir)
	bundleManifest := readJSONObject(filepath.Join(bundleDir, "package.json"))
	bundleDependencies, ok := asObject(bundleManifest["dependencies"])
	if !ok {
		return true
	}
	for name := range bundleDependencies {
		if !resolvesFromProfile(name, profileDir, bundleDir) {
			return false
		}
	}
	return true
}

func resolvesFromProfile(name string, profileDir string, bundleDir string) bool {
	segments := make([]string, 0)
	for _, segment := range strings.Split(name, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return false
	}
	for _, root := range []string{profileDir, bundleDir} {
		manifestPath := filepath.Join(append([]string{root, "node_modules"}, append(segments, "package.json")...)...)
		if content, err := os.ReadFile(manifestPath); err == nil && strings.TrimSpace(string(content)) != "" {
			return true
		}
	}
	return false
}

func buildDshTuiInstallArgs() []string {
	return []string{"plugin", "--profile", dshTuiProfileName, "add", dshTuiProfileBundle}
}

// runDshCLI 以 pipe 方式执行一次 dsh 子命令（安装/修复 profile bundle）。
func runDshCLI(file string, args []string, cwd string, env map[string]string, timeout time.Duration) (bool, int, string) {
	command := exec.Command(file, args...)
	command.Dir = cwd
	command.Env = envSlice(env)
	buffer := &cappedBuffer{limit: dshTuiInstallOutputCap}
	command.Stdout = buffer
	command.Stderr = buffer
	if err := command.Start(); err != nil {
		return false, -1, err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	if timeout <= 0 {
		timeout = dshTuiInstallTimeout
	}
	select {
	case err := <-done:
		if err == nil {
			return true, 0, buffer.String()
		}
		return false, exitCodeOf(err), buffer.String()
	case <-time.After(timeout):
		_ = command.Process.Kill()
		<-done
		return false, -1, buffer.String()
	}
}

func dshTuiInstallFailure(reason string) error {
	text := strings.TrimSpace(reason)
	if len(text) > 400 {
		text = text[len(text)-400:]
	}
	if text == "" {
		text = "no output"
	}
	return fmt.Errorf("dsh_tui_profile_install_failed: %s", text)
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

// cappedBuffer 只保留固定上限的输出（Node runDshCli 的 64KB 口径）。
type cappedBuffer struct {
	buffer []byte
	limit  int
}

func (buffer *cappedBuffer) Write(chunk []byte) (int, error) {
	remaining := buffer.limit - len(buffer.buffer)
	if remaining > 0 {
		if len(chunk) < remaining {
			remaining = len(chunk)
		}
		buffer.buffer = append(buffer.buffer, chunk[:remaining]...)
	}
	return len(chunk), nil
}

func (buffer *cappedBuffer) String() string {
	return string(buffer.buffer)
}
