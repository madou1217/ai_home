package apps

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPlanTimeout  = 20 * time.Minute
	packagePlanTimeout  = 30 * time.Minute
	wingetNoUpdatePos   = 2316632107
	wingetNoUpdateNeg   = -1978335189
	windowsInnoSilent   = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-"
	windowsNsisSilent   = "/S"
	windowsPowerShell   = "powershell.exe"
	windowsCmdExe       = "cmd.exe"
)

var (
	npmPackageNameRe = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
	homebrewCaskRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9@._-]*$`)
	wingetIDRe       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$|^[A-Za-z0-9]{10,20}$`)
	linuxPkgNameRe   = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9+._-]*$`)
)

// IDEClientSpec 描述跨平台 IDE 客户端宿主信息与 Linux 仓库。
type IDEClientSpec struct {
	ID                   string
	Name                 string
	Order                int
	BinaryName           string
	MacBundleNames       []string
	MacExecutableNames   []string
	WindowsProgramNames  []string
	WindowsExecutableNames []string
	LinuxExecutableNames []string
	ConfigDirectoryName  string
	RemoteServerDirName  string
	Cask                 string
	WingetID             string
	WindowsDisplayNames  []string
	LinuxRepo            LinuxRepoSpec
}

// LinuxRepoSpec 描述 IDE 的 apt/yum 官方仓库定义。
type LinuxRepoSpec struct {
	PackageName string
	AptKeyURL   string
	AptKeyPath  string
	AptRepoPath string
	AptRepoLine string
	RpmKeyURL   string
	RpmRepoPath string
	RpmRepoBody string
}

// StandaloneAppSpec 描述不在 Provider 目录内、但纳入托管工具箱的独立 CLI（如 dsh / pi）。
type StandaloneAppSpec struct {
	ID             string
	Provider       string
	Name           string
	ClientName     string
	Categories     []string
	BinaryName     string
	Pkg            string
	HookSupported  bool
	SyncMode       string
}

type desktopPlatformDescriptor struct {
	Cask                 string
	WingetID             string
	WingetSource         string
	WindowsDisplayNames  []string
	LinuxPackages        []string
	Hint                 string
	CleanupFiles         []string
	CleanupHomeFiles     []string
	CleanupTrees         []string
	CleanupHomeTrees     []string
	ResolveInstallPlans  func(Options) []LifecyclePlan
	ResolveUpdatePlans   func(Options) []LifecyclePlan
	ResolveUninstallPlans func(Options) []LifecyclePlan
	ExplicitVersionSource *VersionSource
}

type cliDescriptor struct {
	Pkg                  string
	BinaryNames          []string
	LegacyNpmPackages    []string
	MinNodeVersion       string
	CleanupFiles         []string
	CleanupHomeFiles     []string
	CleanupTrees         []string
	CleanupHomeTrees     []string
	CollectPathEntries   func(Options) []string
	ResolveInstallPlans  func(Options) []LifecyclePlan
	ResolveUpdatePlans   func(Options) []LifecyclePlan
	ResolveUninstallPlans func(Options) []LifecyclePlan
	ExplicitVersionSource *VersionSource
}

type providerInstallerSpec struct {
	Provider          string
	ManagedApp        *StandaloneAppSpec
	IDEClient         *IDEClientSpec
	CLI               *cliDescriptor
	Desktop           map[string]*desktopPlatformDescriptor
	DesktopConfigPath func(platform string, hostHome string, configHome string) string
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func powershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func assertOfficialURL(raw string, allowedHosts []string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || strings.ToLower(parsed.Scheme) != "https" {
		return "", fmt.Errorf("invalid_official_url")
	}
	host := strings.ToLower(parsed.Hostname())
	if len(allowedHosts) > 0 {
		matched := false
		for _, allowed := range allowedHosts {
			candidate := strings.ToLower(strings.TrimSpace(allowed))
			if host == candidate || strings.HasSuffix(host, "."+candidate) {
				matched = true
				break
			}
		}
		if !matched {
			return "", fmt.Errorf("untrusted_installer_host:%s", host)
		}
	}
	return parsed.String(), nil
}

func buildShellPlan(id, label, script string) LifecyclePlan {
	return LifecyclePlan{
		ID:      id,
		Label:   label,
		Command: "sh",
		Args:    []string{"-lc", script},
		Timeout: defaultPlanTimeout,
	}
}

func buildPowerShellPlan(id, label, script string, opts Options) LifecyclePlan {
	cmd := windowsPowerShell
	if resolvePlatform(opts) != platformWindows {
		cmd = windowsPowerShell
	}
	return LifecyclePlan{
		ID:      id,
		Label:   label,
		Command: cmd,
		Args:    []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script},
		Timeout: defaultPlanTimeout,
	}
}

func buildPosixScriptPlan(id, label, rawURL string, hosts []string, args []string) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	script := "curl -fsSL " + shellQuote(official) + " | bash"
	if len(args) > 0 {
		quotedArgs := make([]string, 0, len(args))
		for _, arg := range args {
			quotedArgs = append(quotedArgs, shellQuote(arg))
		}
		script = "curl -fsSL " + shellQuote(official) + " | bash -s -- " + strings.Join(quotedArgs, " ")
	}
	return buildShellPlan(id, label, script)
}

func buildPowerShellScriptPlan(id, label, rawURL string, hosts []string, opts Options) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	script := fmt.Sprintf("irm %s | iex", powershellQuote(official))
	return buildPowerShellPlan(id, label, script, opts)
}

func buildCmdScriptPlan(id, label, rawURL string, hosts []string) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	script := fmt.Sprintf(`set "TMP_SCRIPT=%%TEMP%%\aih-install-%%RANDOM%%.cmd" && curl -fsSL "%s" -o "%%TMP_SCRIPT%%" && call "%%TMP_SCRIPT%%" & set "RC=%%ERRORLEVEL%%" & del /f /q "%%TMP_SCRIPT%%" >nul 2>&1 & exit /b %%RC%%`, official)
	return LifecyclePlan{
		ID:      id,
		Label:   label,
		Command: windowsCmdExe,
		Args:    []string{"/d", "/s", "/c", script},
		Timeout: defaultPlanTimeout,
	}
}

func npmCommand(opts Options) (cmd string, userConfig string) {
	if resolvePlatform(opts) == platformWindows {
		return "npm.cmd", "NUL"
	}
	return "npm", "/dev/null"
}

func npmNetworkFlags(userConfig string) []string {
	return []string{
		"--userconfig=" + userConfig,
		"--registry=" + NPMRegistry,
		"--maxsockets=4",
		"--fetch-timeout=60000",
		"--fetch-retries=3",
		"--fetch-retry-mintimeout=5000",
		"--fetch-retry-maxtimeout=20000",
		"--no-audit",
		"--no-fund",
	}
}

func buildNpmPlan(pkg string, opts Options) LifecyclePlan {
	norm := strings.TrimSpace(pkg)
	if !npmPackageNameRe.MatchString(norm) {
		return LifecyclePlan{}
	}
	cmd, uc := npmCommand(opts)
	args := append([]string{"install", "-g", norm}, npmNetworkFlags(uc)...)
	return LifecyclePlan{
		ID:      "npm_global",
		Label:   "npm 安装 " + norm,
		Command: cmd,
		Args:    args,
		Timeout: packagePlanTimeout,
	}
}

func buildNpmUpdatePlan(pkg string, opts Options) LifecyclePlan {
	norm := strings.TrimSpace(pkg)
	if !npmPackageNameRe.MatchString(norm) {
		return LifecyclePlan{}
	}
	cmd, uc := npmCommand(opts)
	args := append([]string{"install", "--global", norm + "@latest"}, npmNetworkFlags(uc)...)
	return LifecyclePlan{
		ID:      "npm_global_update",
		Label:   "npm 更新 " + norm,
		Command: cmd,
		Args:    args,
		Timeout: packagePlanTimeout,
	}
}

func buildNpmUninstallPlan(pkg string, opts Options) LifecyclePlan {
	norm := strings.TrimSpace(pkg)
	if !npmPackageNameRe.MatchString(norm) {
		return LifecyclePlan{}
	}
	cmd, uc := npmCommand(opts)
	args := append([]string{"uninstall", "-g", norm}, "--userconfig="+uc, "--no-audit", "--no-fund")
	return LifecyclePlan{
		ID:      "npm_global_uninstall",
		Label:   "npm 卸载 " + norm,
		Command: cmd,
		Args:    args,
		Timeout: packagePlanTimeout,
	}
}

func buildCaskPlan(cask, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew_cask", Label: nonEmpty(label, "Homebrew 安装 "+cask), Command: "brew", Args: []string{"install", "--cask", strings.TrimSpace(cask)}, Timeout: packagePlanTimeout}
}

func buildCaskUpdatePlan(cask, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew_cask_update", Label: nonEmpty(label, "Homebrew 更新 "+cask), Command: "brew", Args: []string{"upgrade", "--cask", strings.TrimSpace(cask)}, Timeout: packagePlanTimeout}
}

func buildCaskUninstallPlan(cask, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew_cask_uninstall", Label: nonEmpty(label, "Homebrew 卸载 "+cask), Command: "brew", Args: []string{"uninstall", "--cask", strings.TrimSpace(cask)}, Timeout: packagePlanTimeout}
}

func buildBrewFormulaPlan(formula, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew", Label: nonEmpty(label, "Homebrew 安装 "+formula), Command: "brew", Args: []string{"install", strings.TrimSpace(formula)}, Timeout: packagePlanTimeout}
}

func buildBrewFormulaUpdatePlan(formula, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew_formula_update", Label: nonEmpty(label, "Homebrew 更新 "+formula), Command: "brew", Args: []string{"upgrade", strings.TrimSpace(formula)}, Timeout: packagePlanTimeout}
}

func buildBrewFormulaUninstallPlan(formula, label string) LifecyclePlan {
	return LifecyclePlan{ID: "homebrew_formula_uninstall", Label: nonEmpty(label, "Homebrew 卸载 "+formula), Command: "brew", Args: []string{"uninstall", strings.TrimSpace(formula)}, Timeout: packagePlanTimeout}
}

func buildWingetPlan(pkgID, label, source string) LifecyclePlan {
	args := []string{"install", "--id", strings.TrimSpace(pkgID), "--exact"}
	if strings.TrimSpace(source) != "" {
		args = append(args, "--source", strings.TrimSpace(source))
	}
	args = append(args, "--accept-package-agreements", "--accept-source-agreements")
	return LifecyclePlan{ID: "winget", Label: nonEmpty(label, "winget 安装 "+pkgID), Command: "winget.exe", Args: args, Timeout: packagePlanTimeout}
}

func buildWingetUpdatePlan(pkgID, label, source string) LifecyclePlan {
	args := []string{"upgrade", "--id", strings.TrimSpace(pkgID), "--exact"}
	if strings.TrimSpace(source) != "" {
		args = append(args, "--source", strings.TrimSpace(source))
	}
	args = append(args, "--accept-package-agreements", "--accept-source-agreements")
	return LifecyclePlan{ID: "winget_update", Label: nonEmpty(label, "winget 更新 "+pkgID), Command: "winget.exe", Args: args, Timeout: packagePlanTimeout}
}

func buildWingetUninstallPlan(pkgID, label string) LifecyclePlan {
	return LifecyclePlan{ID: "winget_uninstall", Label: nonEmpty(label, "winget 卸载 "+pkgID), Command: "winget.exe", Args: []string{"uninstall", "--id", strings.TrimSpace(pkgID), "--exact"}, Timeout: packagePlanTimeout}
}

func buildWindowsDownloadStatements(urlLiteral, urlExpr, label string) string {
	src := urlExpr
	if src == "" {
		src = powershellQuote(urlLiteral)
	}
	return fmt.Sprintf(`$curl = Get-Command curl.exe -ErrorAction SilentlyContinue; if ($curl) { & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o $dest %s; if ($LASTEXITCODE -ne 0) { throw (%s + '下载失败: curl 退出码 ' + $LASTEXITCODE) } } else { Invoke-WebRequest -Uri %s -OutFile $dest -UseBasicParsing }`,
		src, powershellQuote(nonEmpty(label, "应用安装包")), src)
}

func buildWindowsExecutableLaunchStatements(silentArgs string) string {
	argsList := strings.Fields(strings.TrimSpace(silentArgs))
	quoted := make([]string, 0, len(argsList))
	for _, item := range argsList {
		quoted = append(quoted, powershellQuote(item))
	}
	argFlag := ""
	if len(quoted) > 0 {
		argFlag = " -ArgumentList @(" + strings.Join(quoted, ", ") + ")"
	}
	launch := `$process = Start-Process -FilePath $dest` + argFlag + ` -PassThru`
	return fmt.Sprintf(`try { %s } catch { $message = [string]$_.Exception.Message; $native = [int]$_.Exception.NativeErrorCode; if ($native -eq 740 -or $message -match 'elevation|提升|管理员权限|740') { throw ('安装器需要管理员权限，请允许 UAC 提示后重试: ' + $message) }; if ($native -eq 1223 -or $message -match 'canceled|cancelled|取消') { throw ('安装器需要管理员权限，但 UAC 授权被取消，请重试并允许授权: ' + $message) }; throw $_ }; if (-not $process) { throw '安装器进程未能启动' }; if (-not $process.WaitForExit(1200000)) { throw '安装器运行超时（20 分钟未退出）' }; $exitCode = [int]$process.ExitCode; if ($exitCode -ne 0 -and $exitCode -ne 3010) { throw ('安装器退出码: ' + $exitCode) }`, launch)
}

func buildWindowsExecutableInstallPlan(id, label, rawURL string, hosts []string, silentArgs string, opts Options) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	script := fmt.Sprintf(`$dest = Join-Path $env:TEMP ('aih-app-' + [guid]::NewGuid().ToString('n') + '.exe'); %s; try { %s } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`,
		buildWindowsDownloadStatements(official, "", label),
		buildWindowsExecutableLaunchStatements(silentArgs),
	)
	return buildPowerShellPlan(id, label, script, opts)
}

func buildMacDmgInstallPlan(id, label, rawURL string, hosts []string, appName string) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	findApp := `app="$(find "$mount" -maxdepth 1 -type d -name '*.app' -print -quit)"`
	if strings.TrimSpace(appName) != "" {
		findApp += `; if [ -z "$app" ] || [ "$(basename "$app")" != ` + shellQuote(appName) + ` ]; then app="$(find "$mount" -maxdepth 1 -type d -name ` + shellQuote(appName) + ` -print -quit)"; fi`
	}
	script := strings.Join([]string{
		`tmp="$(mktemp -t aih-app).dmg"`,
		`mount="$(mktemp -d -t aih-mount)"`,
		`cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }`,
		`trap cleanup EXIT`,
		`curl -fsSL ` + shellQuote(official) + ` -o "$tmp"`,
		`hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null`,
		findApp,
		`if [ -z "$app" ]; then echo "desktop app bundle not found" >&2; exit 1; fi`,
		`mkdir -p "$HOME/Applications"`,
		`installed="$HOME/Applications/$(basename "$app")"`,
		`ditto "$app" "$installed"`,
		`echo "` + installedPathMarker + `$installed"`,
	}, "; ")
	return buildShellPlan(id, label, script)
}

func buildLinuxPackageInstallPlan(id, label, rawURL string, hosts []string, pkgType string) LifecyclePlan {
	official, err := assertOfficialURL(rawURL, hosts)
	if err != nil {
		return LifecyclePlan{}
	}
	suffix := ".deb"
	installCmd := `if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi`
	if pkgType == "rpm" {
		suffix = ".rpm"
		installCmd = `if [ "$(id -u)" -eq 0 ]; then rpm -Uvh "$tmp"; else sudo -n rpm -Uvh "$tmp"; fi`
	}
	script := fmt.Sprintf(`tmp="$(mktemp --suffix=%s aih-app.XXXXXX)"; trap 'rm -f "$tmp"' EXIT; curl -fsSL %s -o "$tmp"; %s`, suffix, shellQuote(official), installCmd)
	return buildShellPlan(id, label, script)
}

func buildWindowsRegistryUninstallPlan(displayNames []string, label string, opts Options) LifecyclePlan {
	if len(displayNames) == 0 {
		return LifecyclePlan{}
	}
	quoted := make([]string, 0, len(displayNames))
	for _, n := range displayNames {
		if strings.TrimSpace(n) != "" {
			quoted = append(quoted, powershellQuote(strings.TrimSpace(n)))
		}
	}
	if len(quoted) == 0 {
		return LifecyclePlan{}
	}
	script := fmt.Sprintf(`$names = @(%s); $roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'); $entry = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $display = [string]$_.DisplayName; $names | Where-Object { $display -eq $_ -or $display -like ("*" + $_ + "*") } } | Select-Object -First 1; if (-not $entry) { throw '未找到已安装应用的卸载注册项' }; $command = [string]$(if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { $entry.UninstallString }); if (-not $command) { throw '卸载注册项没有可执行命令' }; $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -PassThru; if (-not $process.WaitForExit(600000)) { throw '卸载器运行超时（10 分钟未退出）' }; if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('卸载器退出码: ' + $process.ExitCode) }`,
		strings.Join(quoted, ", "))
	return buildPowerShellPlan("windows_registered_app_uninstall", nonEmpty(label, "卸载 "+displayNames[0]), script, opts)
}

func buildLinuxPackageUninstallPlan(pkgNames []string, label string) LifecyclePlan {
	valid := make([]string, 0, len(pkgNames))
	for _, n := range pkgNames {
		trimmed := strings.TrimSpace(n)
		if linuxPkgNameRe.MatchString(trimmed) {
			valid = append(valid, shellQuote(trimmed))
		}
	}
	if len(valid) == 0 {
		return LifecyclePlan{}
	}
	script := strings.Join([]string{
		"for pkg in " + strings.Join(valid, " ") + "; do",
		`  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f="${Status}" "$pkg" 2>/dev/null | grep -q "install ok installed"; then`,
		`    if [ "$(id -u)" -eq 0 ]; then apt-get remove -y "$pkg"; else sudo -n apt-get remove -y "$pkg"; fi; exit 0`,
		"  fi",
		`  if command -v rpm >/dev/null 2>&1 && rpm -q "$pkg" >/dev/null 2>&1; then`,
		`    if command -v dnf >/dev/null 2>&1; then manager=dnf; else manager=yum; fi`,
		`    if [ "$(id -u)" -eq 0 ]; then "$manager" remove -y "$pkg"; else sudo -n "$manager" remove -y "$pkg"; fi; exit 0`,
		"  fi",
		"done",
		`echo "未找到匹配的系统软件包" >&2`,
		"exit 44",
	}, "\n")
	return buildShellPlan("linux_package_uninstall", nonEmpty(label, "卸载 "+pkgNames[0]), script)
}

func buildManagedPathCleanupPlan(id, label string, files, trees []string, opts Options) LifecyclePlan {
	cleanFiles := uniqueStrings(files)
	cleanTrees := uniqueStrings(trees)
	if len(cleanFiles) == 0 && len(cleanTrees) == 0 {
		return LifecyclePlan{}
	}
	if resolvePlatform(opts) == platformWindows {
		stmts := make([]string, 0, len(cleanFiles)+len(cleanTrees))
		for _, f := range cleanFiles {
			stmts = append(stmts, fmt.Sprintf("if (Test-Path -LiteralPath %s) { Remove-Item -LiteralPath %s -Force -ErrorAction SilentlyContinue }", powershellQuote(f), powershellQuote(f)))
		}
		for _, t := range cleanTrees {
			stmts = append(stmts, fmt.Sprintf("if (Test-Path -LiteralPath %s) { Remove-Item -LiteralPath %s -Recurse -Force -ErrorAction SilentlyContinue }", powershellQuote(t), powershellQuote(t)))
		}
		return buildPowerShellPlan(id, label, strings.Join(stmts, "; "), opts)
	}
	parts := make([]string, 0, len(cleanFiles)+len(cleanTrees))
	for _, f := range cleanFiles {
		parts = append(parts, "rm -f "+shellQuote(f))
	}
	for _, t := range cleanTrees {
		parts = append(parts, "rm -rf "+shellQuote(t))
	}
	return buildShellPlan(id, label, strings.Join(parts, "; "))
}

func buildLinuxRepoPlan(appID, name, action string, repo LinuxRepoSpec) LifecyclePlan {
	actionLabels := map[string]string{"install": "安装", "update": "更新", "uninstall": "卸载"}
	label := nonEmpty(actionLabels[action], action) + " " + name
	runRoot := `run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }`
	var lines []string
	switch action {
	case "install":
		aptSteps := []string{
			"  command -v curl >/dev/null 2>&1",
			"  command -v gpg >/dev/null 2>&1",
			`  tmp_dir="$(mktemp -d -t aih-ide.XXXXXX)"`,
			`  trap 'rm -rf "$tmp_dir"' EXIT`,
			"  curl -fsSL " + shellQuote(repo.AptKeyURL) + ` -o "$tmp_dir/key.asc"`,
			`  gpg --batch --yes --dearmor -o "$tmp_dir/key.gpg" "$tmp_dir/key.asc"`,
			"  printf '%s\\n' " + shellQuote(repo.AptRepoLine) + ` > "$tmp_dir/repository.list"`,
			"  run_root install -d -m 0755 " + shellQuote(filepath.Dir(repo.AptKeyPath)),
			`  run_root install -m 0644 "$tmp_dir/key.gpg" ` + shellQuote(repo.AptKeyPath),
			`  run_root install -m 0644 "$tmp_dir/repository.list" ` + shellQuote(repo.AptRepoPath),
			"  run_root apt-get update",
			"  run_root apt-get install -y " + shellQuote(repo.PackageName),
		}
		rpmSteps := []string{
			`  tmp_dir="$(mktemp -d -t aih-ide.XXXXXX)"`,
			`  trap 'rm -rf "$tmp_dir"' EXIT`,
			"  printf '%s\\n' " + shellQuote(repo.RpmRepoBody) + ` > "$tmp_dir/repository.repo"`,
			"  run_root rpm --import " + shellQuote(repo.RpmKeyURL),
			`  run_root install -m 0644 "$tmp_dir/repository.repo" ` + shellQuote(repo.RpmRepoPath),
			"  if command -v dnf >/dev/null 2>&1; then package_manager=dnf; else package_manager=yum; fi",
			`  run_root "$package_manager" install -y ` + shellQuote(repo.PackageName),
		}
		lines = append([]string{runRoot, "if command -v apt-get >/dev/null 2>&1; then"}, aptSteps...)
		lines = append(lines, "elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then")
		lines = append(lines, rpmSteps...)
		lines = append(lines, "else", `  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2`, "  exit 64", "fi")
	case "update":
		lines = []string{
			runRoot,
			"if command -v apt-get >/dev/null 2>&1; then",
			"  run_root apt-get update",
			"  run_root apt-get install -y --only-upgrade " + shellQuote(repo.PackageName),
			"elif command -v dnf >/dev/null 2>&1; then",
			"  run_root dnf upgrade -y " + shellQuote(repo.PackageName),
			"elif command -v yum >/dev/null 2>&1; then",
			"  run_root yum update -y " + shellQuote(repo.PackageName),
			"else",
			`  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2`,
			"  exit 64",
			"fi",
		}
	case "uninstall":
		lines = []string{
			runRoot,
			"if command -v apt-get >/dev/null 2>&1; then",
			"  run_root apt-get remove -y " + shellQuote(repo.PackageName),
			"  run_root rm -f " + shellQuote(repo.AptRepoPath) + " " + shellQuote(repo.AptKeyPath),
			"elif command -v dnf >/dev/null 2>&1; then",
			"  run_root dnf remove -y " + shellQuote(repo.PackageName),
			"  run_root rm -f " + shellQuote(repo.RpmRepoPath),
			"elif command -v yum >/dev/null 2>&1; then",
			"  run_root yum remove -y " + shellQuote(repo.PackageName),
			"  run_root rm -f " + shellQuote(repo.RpmRepoPath),
			"else",
			`  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2`,
			"  exit 64",
			"fi",
		}
	}
	return buildShellPlan(appID+"_linux_"+action, label, strings.Join(lines, "\n"))
}

// buildDshTuiProfileUpdatePlans 扫描 run/harness/dsh-tui/*/dsh，更新托管的 dsh-tui wrapper bundle。
func buildDshTuiProfileUpdatePlans(opts Options) []LifecyclePlan {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	if aiHome == "" {
		return nil
	}
	platform := resolvePlatform(opts)
	profileRoot := joinPlatformPath(platform, aiHome, "run", "harness", "dsh-tui")
	entries, err := os.ReadDir(profileRoot)
	if err != nil {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	plans := make([]LifecyclePlan, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		accountRef := entry.Name()
		wrapper := findDshTuiWrapper(platform, joinPlatformPath(platform, profileRoot, accountRef))
		if wrapper == "" {
			continue
		}
		plans = append(plans, LifecyclePlan{
			ID:      "dsh_tui_profile_update:" + accountRef,
			Label:   "dsh-tui bundle update (" + accountRef + ")",
			Command: wrapper,
			Args:    []string{"--profile", "dsh-tui", "bundle", "update", "--profile", "dsh-tui"},
			Timeout: packagePlanTimeout,
		})
	}
	return plans
}

func findDshTuiWrapper(platform, accountDir string) string {
	candidates := []string{"dsh"}
	if platform == platformWindows {
		candidates = []string{"dsh.cmd", "dsh.exe", "dsh"}
	}
	for _, name := range candidates {
		target := joinPlatformPath(platform, accountDir, name)
		if fileExists(target) {
			return target
		}
	}
	return ""
}

func normalizeVersionSource(raw *VersionSource) *VersionSource {
	if raw == nil {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(raw.Type)) {
	case "npm":
		pkg := strings.TrimSpace(raw.PackageName)
		if !npmPackageNameRe.MatchString(pkg) {
			return nil
		}
		return &VersionSource{Type: "npm", PackageName: pkg}
	case "homebrew_cask":
		cask := strings.TrimSpace(raw.Cask)
		if !homebrewCaskRe.MatchString(cask) {
			return nil
		}
		return &VersionSource{Type: "homebrew_cask", Cask: cask}
	case "winget":
		id := strings.TrimSpace(raw.ID)
		if !wingetIDRe.MatchString(id) {
			return nil
		}
		return &VersionSource{Type: "winget", ID: id}
	default:
		return nil
	}
}

func inferVersionSourceFromPlan(plan LifecyclePlan) *VersionSource {
	cmd := strings.ToLower(strings.TrimSpace(filepath.Base(strings.ReplaceAll(plan.Command, "\\", "/"))))
	if (cmd == "npm" || cmd == "npm.cmd") && len(plan.Args) >= 3 && plan.Args[0] == "install" && (plan.Args[1] == "-g" || plan.Args[1] == "--global") {
		pkg := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(plan.Args[2], "@latest"), "@next"), "@stable")
		return normalizeVersionSource(&VersionSource{Type: "npm", PackageName: pkg})
	}
	if cmd == "brew" && len(plan.Args) >= 3 && plan.Args[0] == "install" && plan.Args[1] == "--cask" {
		return normalizeVersionSource(&VersionSource{Type: "homebrew_cask", Cask: plan.Args[2]})
	}
	if cmd == "winget" || cmd == "winget.exe" {
		if len(plan.Args) >= 2 && plan.Args[0] == "install" {
			sourceVal := ""
			pkgID := ""
			for i := 1; i+1 < len(plan.Args); i++ {
				if strings.EqualFold(plan.Args[i], "--id") {
					pkgID = plan.Args[i+1]
				} else if strings.EqualFold(plan.Args[i], "--source") {
					sourceVal = strings.ToLower(strings.TrimSpace(plan.Args[i+1]))
				}
			}
			if sourceVal == "" || sourceVal == "winget" {
				return normalizeVersionSource(&VersionSource{Type: "winget", ID: pkgID})
			}
		}
	}
	return nil
}

func inferLifecyclePlansFromInstallPlans(action string, installPlans []LifecyclePlan, opts Options) []LifecyclePlan {
	var out []LifecyclePlan
	for _, plan := range installPlans {
		cmd := strings.ToLower(strings.TrimSpace(filepath.Base(strings.ReplaceAll(plan.Command, "\\", "/"))))
		switch {
		case (cmd == "npm" || cmd == "npm.cmd") && len(plan.Args) >= 3 && plan.Args[0] == "install" && (plan.Args[1] == "-g" || plan.Args[1] == "--global"):
			pkg := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(plan.Args[2], "@latest"), "@next"), "@stable")
			if action == "update" {
				out = append(out, buildNpmUpdatePlan(pkg, opts))
			} else {
				out = append(out, buildNpmUninstallPlan(pkg, opts))
			}
		case cmd == "brew" && len(plan.Args) >= 2 && plan.Args[0] == "install":
			if len(plan.Args) >= 3 && plan.Args[1] == "--cask" {
				if action == "update" {
					out = append(out, buildCaskUpdatePlan(plan.Args[2], ""))
				} else {
					out = append(out, buildCaskUninstallPlan(plan.Args[2], ""))
				}
			} else {
				formula := ""
				for _, arg := range plan.Args[1:] {
					if !strings.HasPrefix(arg, "-") {
						formula = arg
						break
					}
				}
				if formula != "" {
					if action == "update" {
						out = append(out, buildBrewFormulaUpdatePlan(formula, ""))
					} else {
						out = append(out, buildBrewFormulaUninstallPlan(formula, ""))
					}
				}
			}
		case (cmd == "winget" || cmd == "winget.exe") && len(plan.Args) >= 2 && plan.Args[0] == "install":
			pkgID := ""
			sourceVal := ""
			for i := 1; i+1 < len(plan.Args); i++ {
				if strings.EqualFold(plan.Args[i], "--id") {
					pkgID = plan.Args[i+1]
				} else if strings.EqualFold(plan.Args[i], "--source") {
					sourceVal = plan.Args[i+1]
				}
			}
			if pkgID != "" {
				if action == "update" {
					out = append(out, buildWingetUpdatePlan(pkgID, "", sourceVal))
				} else {
					out = append(out, buildWingetUninstallPlan(pkgID, ""))
				}
			}
		}
	}
	return filterValidPlans(out)
}

func uniquePlans(plans []LifecyclePlan) []LifecyclePlan {
	seen := make(map[string]struct{}, len(plans))
	out := make([]LifecyclePlan, 0, len(plans))
	for _, p := range plans {
		if strings.TrimSpace(p.Command) == "" {
			continue
		}
		key := p.Command + "\x00" + strings.Join(p.Args, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, p)
	}
	return out
}

func filterValidPlans(plans []LifecyclePlan) []LifecyclePlan {
	out := make([]LifecyclePlan, 0, len(plans))
	for _, p := range plans {
		if strings.TrimSpace(p.Command) != "" {
			out = append(out, p)
		}
	}
	return out
}

func nonEmpty(primary, fallback string) string {
	if strings.TrimSpace(primary) != "" {
		return strings.TrimSpace(primary)
	}
	return fallback
}

func parseVersionTuple(text string) ([3]int, bool) {
	re := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)
	m := re.FindStringSubmatch(text)
	if len(m) != 4 {
		return [3]int{}, false
	}
	var out [3]int
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}
