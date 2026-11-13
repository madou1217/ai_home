// Package tools 实现 Toolkit 受管工具（tmux、psmux、herdr、frpc、nginx、caddy）的
// 探测、配置读写与校验、生命周期计划与异步作业、官方包下载安装与服务进程守护。
package tools

import (
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	defaultDiscoveryTimeout = 3 * time.Second
	edgeContextEnvName      = "AIH_EDGE_CONTEXT"
)

var (
	frpConfigExtensions = []string{"toml", "yaml", "yml", "json", "ini"}
	frpConfigFlags      = []string{"-c", "--config", "--config-file"}
	frpConfigDirFlags   = []string{"--config-dir"}
	networkToolIDs      = []string{"frpc"}

	commandWrappers = map[string]struct{}{
		"cmd": {}, "daemonize": {}, "doas": {}, "env": {}, "nohup": {}, "nssm": {},
		"powershell": {}, "pwsh": {}, "setsid": {}, "sh": {}, "bash": {}, "dash": {},
		"start-stop-daemon": {}, "sudo": {}, "winsw": {}, "zsh": {},
	}

	psLinePattern       = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(.*)$`)
	lsofCwdPattern      = regexp.MustCompile(`(?m)^n(.+)$`)
	commandTokenPattern = regexp.MustCompile(`"([^"]*)"|'([^']*)'|(\S+)`)
	envAssignPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	winPercentEnvRegex  = regexp.MustCompile(`%([^%]+)%`)
	winPsEnvRegex       = regexp.MustCompile(`(?i)\$env:([A-Za-z_][A-Za-z0-9_]*)`)
	systemdExecPattern  = regexp.MustCompile(`(?m)^\s*ExecStart\s*=\s*(.+)$`)
	systemdWdirPattern  = regexp.MustCompile(`(?m)^\s*WorkingDirectory\s*=\s*(.+)$`)
	plistArrayStrRegex  = regexp.MustCompile(`<string>([^<]*)</string>`)
	plistHexEntityRegex = regexp.MustCompile(`(?i)&#x([0-9a-f]+);`)
	plistDecEntityRegex = regexp.MustCompile(`&#(\d+);`)
	plistKeepAliveRegex = regexp.MustCompile(`<key>KeepAlive</key>\s*<(true|dict)`)
	systemctlRowPattern = regexp.MustCompile(`^([^\s]+)\s+([^\s]+)`)
	systemctlEnabledRx  = regexp.MustCompile(`^(?i)(enabled|enabled-runtime|static|alias)$`)
)

// ProcessEntry 表示探测到的宿主进程快照条目。
type ProcessEntry struct {
	PID            int      `json:"pid"`
	ParentPID      int      `json:"parentPid"`
	Name           string   `json:"name,omitempty"`
	ExecutablePath string   `json:"executablePath,omitempty"`
	CommandLine    string   `json:"commandLine,omitempty"`
	Args           []string `json:"args,omitempty"`
	Cwd            string   `json:"cwd,omitempty"`
}

// StartupEntry 表示探测到的系统启动项/后台服务定义（systemd / launchd / Windows）。
type StartupEntry struct {
	Source           string   `json:"source,omitempty"`
	Name             string   `json:"name,omitempty"`
	TaskName         string   `json:"taskName,omitempty"`
	Label            string   `json:"label,omitempty"`
	ExecutablePath   string   `json:"executablePath,omitempty"`
	Args             []string `json:"args,omitempty"`
	CommandLine      string   `json:"commandLine,omitempty"`
	WorkingDirectory string   `json:"workingDirectory,omitempty"`
	ConfigPath       string   `json:"configPath,omitempty"`
	Enabled          bool     `json:"enabled"`
}

// NetworkToolRuntime 表示网络/代理工具（frpc）的运行态与权威配置解析结果。
type NetworkToolRuntime struct {
	Running          bool     `json:"running"`
	RunningCount     int      `json:"runningCount"`
	StartupManaged   bool     `json:"startupManaged"`
	StartupSources   []string `json:"startupSources"`
	ExecutablePath   string   `json:"executablePath"`
	ExecutableExists bool     `json:"executableExists"`
	ConfigPath       string   `json:"configPath"`
	ConfigSource     string   `json:"configSource"`
	ConfigCount      int      `json:"configCount"`
	ConfigAmbiguous  bool     `json:"configAmbiguous"`
	ConfigState      string   `json:"configState"`
}

// Options 控制探测、配置读写、计划生成、包管理与服务操作的依赖与测试桩。
type Options struct {
	Platform               string
	Arch                   string
	HostHomeDir            string
	AIHomeDir              string
	AIHLogDir              string
	Exec                   environment.Executor
	LookupEnv              func(string) string
	Environ                func() []string
	Now                    func() time.Time
	HTTPClient             HTTPDoer
	IncludeService         *bool
	ProcessEntriesOverride []ProcessEntry
	StartupEntriesOverride []StartupEntry
	LookPathOverride       func(string) (string, error)
	FileExistsOverride     func(string) bool
}

func (o Options) withDefaults() Options {
	out := o
	if out.Exec == nil {
		out.Exec = hostexec.Executor{}
	}
	if out.LookupEnv == nil {
		out.LookupEnv = os.Getenv
	}
	if out.Environ == nil {
		out.Environ = os.Environ
	}
	if out.Now == nil {
		out.Now = time.Now
	}
	return out
}

func (o Options) nodePlatform() string {
	return toNodePlatform(o.Platform)
}

func (o Options) hostHome() string {
	if trimmed := strings.TrimSpace(o.HostHomeDir); trimmed != "" {
		return trimmed
	}
	if o.nodePlatform() == "win32" {
		if up := strings.TrimSpace(o.LookupEnv("USERPROFILE")); up != "" {
			return up
		}
		if hd, hp := strings.TrimSpace(o.LookupEnv("HOMEDRIVE")), strings.TrimSpace(o.LookupEnv("HOMEPATH")); hd != "" && hp != "" {
			return hd + hp
		}
		return strings.TrimSpace(o.LookupEnv("HOME"))
	}
	if home := strings.TrimSpace(o.LookupEnv("HOME")); home != "" {
		return home
	}
	if h, err := os.UserHomeDir(); err == nil {
		return strings.TrimSpace(h)
	}
	return ""
}

func (o Options) envValue(name string) string {
	if val := o.LookupEnv(name); val != "" {
		return val
	}
	if o.nodePlatform() == "win32" && o.Environ != nil {
		wanted := strings.ToLower(name)
		for _, item := range o.Environ() {
			k, v, ok := strings.Cut(item, "=")
			if ok && strings.ToLower(k) == wanted {
				return v
			}
		}
	}
	return ""
}

func toNodePlatform(raw string) string {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		v = runtime.GOOS
	}
	switch v {
	case "darwin", "macos", "mac":
		return "darwin"
	case "win32", "windows", "win":
		return "win32"
	default:
		return "linux"
	}
}

func toClientPlatform(raw string) string {
	switch toNodePlatform(raw) {
	case "darwin":
		return "macos"
	case "win32":
		return "windows"
	default:
		return "linux"
	}
}

func toGoArch(raw string) string {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		v = runtime.GOARCH
	}
	switch v {
	case "x64", "amd64", "x86_64":
		return "amd64"
	case "arm64", "aarch64":
		return "arm64"
	default:
		return ""
	}
}

// ReadEdgeContextField 读取 AIH_EDGE_CONTEXT 环境变量中编码的字段（与 edge-context.js 一致）。
func ReadEdgeContextField(lookupEnv func(string) string, key string) string {
	if lookupEnv == nil {
		return ""
	}
	raw := strings.TrimSpace(lookupEnv(edgeContextEnvName))
	if raw == "" {
		return ""
	}
	for _, part := range strings.Split(raw, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		if strings.TrimSpace(k) != key {
			continue
		}
		trimmed := strings.TrimSpace(v)
		if decoded, err := decodePercent(trimmed); err == nil {
			return decoded
		}
		return trimmed
	}
	return ""
}

func decodePercent(s string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String(), nil
}

func envBoolExists(o Options, p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return false
	}
	if o.FileExistsOverride != nil {
		return o.FileExistsOverride(p)
	}
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func pathExistsAny(o Options, p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return false
	}
	if o.FileExistsOverride != nil {
		return o.FileExistsOverride(p)
	}
	_, err := os.Stat(p)
	return err == nil
}

func envPlatformPathJoin(platform string, elem ...string) string {
	if platform == "win32" {
		cleaned := make([]string, 0, len(elem))
		for _, part := range elem {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			part = strings.ReplaceAll(part, "/", `\`)
			if len(cleaned) == 0 {
				cleaned = append(cleaned, strings.TrimRight(part, `\`))
			} else {
				cleaned = append(cleaned, strings.Trim(part, `\`))
			}
		}
		return strings.Join(cleaned, `\`)
	}
	return path.Join(elem...)
}

func envPlatformBase(platform string, p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if platform == "win32" {
		p = strings.ReplaceAll(p, "/", `\`)
		p = strings.TrimRight(p, `\`)
		idx := strings.LastIndex(p, `\`)
		if idx >= 0 {
			return p[idx+1:]
		}
		return p
	}
	return path.Base(strings.ReplaceAll(p, `\`, `/`))
}

func envPlatformDir(platform string, p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if platform == "win32" {
		norm := envPlatformNormalize(platform, p)
		idx := strings.LastIndex(norm, `\`)
		if idx <= 0 {
			return norm
		}
		return norm[:idx]
	}
	return path.Dir(strings.ReplaceAll(p, `\`, `/`))
}

func envPlatformExt(platform string, p string) string {
	base := envPlatformBase(platform, p)
	idx := strings.LastIndex(base, ".")
	if idx <= 0 {
		return ""
	}
	return base[idx:]
}

func envPlatformIsAbs(platform string, p string) bool {
	return environment.IsAbsPath(toClientPlatform(platform), p)
}

func envPlatformNormalize(platform string, p string) string {
	return environment.NormalizePath(toClientPlatform(platform), p)
}

func tokenizeCommandLine(value string) []string {
	matches := commandTokenPattern.FindAllStringSubmatch(value, -1)
	tokens := make([]string, 0, len(matches))
	for _, m := range matches {
		token := m[1]
		if token == "" {
			token = m[2]
		}
		if token == "" {
			token = m[3]
		}
		token = strings.TrimSpace(token)
		if token != "" {
			tokens = append(tokens, token)
		}
	}
	return tokens
}

func processArgs(p ProcessEntry) []string {
	if len(p.Args) > 0 {
		out := make([]string, 0, len(p.Args))
		for _, a := range p.Args {
			if t := strings.TrimSpace(a); t != "" {
				out = append(out, t)
			}
		}
		return out
	}
	return tokenizeCommandLine(p.CommandLine)
}

func processExecutable(p ProcessEntry) string {
	if v := strings.TrimSpace(p.ExecutablePath); v != "" {
		return v
	}
	args := processArgs(p)
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

func normalizeExecutableName(platform string, val string) string {
	base := envPlatformBase(platform, strings.TrimSpace(strings.TrimPrefix(val, "@")))
	if strings.HasSuffix(strings.ToLower(base), ".exe") {
		base = base[:len(base)-4]
	}
	return strings.ToLower(base)
}

func nestedWrapperArguments(platform string, args []string) []string {
	if len(args) == 0 {
		return nil
	}
	wrapper := normalizeExecutableName(platform, args[0])
	if _, ok := commandWrappers[wrapper]; !ok {
		return nil
	}
	var nested []string
	for _, arg := range args[1:] {
		if envAssignPattern.MatchString(arg) {
			continue
		}
		nested = append(nested, arg)
		if strings.ContainsAny(arg, " \t") {
			nested = append(nested, tokenizeCommandLine(arg)...)
		}
	}
	return nested
}

// EntryDirectlyRunsRole 判断进程条目主可执行文件是否直接对应目标角色（如 frpc）。
func EntryDirectlyRunsRole(platform string, p ProcessEntry, role string) bool {
	return normalizeExecutableName(platform, processExecutable(p)) == strings.ToLower(strings.TrimSpace(role))
}

func processExecutableForRole(platform string, p ProcessEntry, role string) string {
	normRole := strings.ToLower(strings.TrimSpace(role))
	if normRole == "" {
		return ""
	}
	explicit := processExecutable(p)
	explicitName := normalizeExecutableName(platform, explicit)
	if explicitName == normRole {
		return explicit
	}
	if _, ok := commandWrappers[explicitName]; !ok {
		return ""
	}
	args := processArgs(p)
	for _, c := range nestedWrapperArguments(platform, append([]string{explicit}, args...)) {
		if normalizeExecutableName(platform, c) == normRole {
			return c
		}
	}
	return ""
}

func processArgumentsForRole(platform string, p ProcessEntry, role string) []string {
	normRole := strings.ToLower(strings.TrimSpace(role))
	args := processArgs(p)
	explicit := processExecutable(p)
	direct := normalizeExecutableName(platform, explicit)
	if direct == normRole {
		return args
	}
	wrapperArgs := args
	if _, ok := commandWrappers[direct]; ok {
		wrapperArgs = append([]string{explicit}, args...)
	}
	nested := nestedWrapperArguments(platform, wrapperArgs)
	for i, v := range nested {
		if normalizeExecutableName(platform, v) == normRole {
			return nested[i+1:]
		}
	}
	return args
}

func processMatchesRole(platform string, p ProcessEntry, role string) bool {
	if processExecutableForRole(platform, p, role) != "" {
		return true
	}
	normRole := strings.ToLower(strings.TrimSpace(role))
	svc := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(p.Name)), ".service")
	return svc == normRole || strings.HasPrefix(svc, normRole+"-") || strings.HasPrefix(svc, normRole+"_")
}

func startupAsProcess(s StartupEntry) ProcessEntry {
	return ProcessEntry{
		Name:           firstNonEmpty(s.Name, s.TaskName, s.Label),
		ExecutablePath: s.ExecutablePath,
		Args:           s.Args,
		CommandLine:    s.CommandLine,
		Cwd:            s.WorkingDirectory,
	}
}

func startupMatchesRole(platform string, s StartupEntry, role string) bool {
	return processMatchesRole(platform, startupAsProcess(s), role)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func expandWindowsEnv(o Options, value string) string {
	if o.nodePlatform() != "win32" {
		return value
	}
	out := winPercentEnvRegex.ReplaceAllStringFunc(value, func(m string) string {
		sub := winPercentEnvRegex.FindStringSubmatch(m)
		if len(sub) == 2 {
			if v := o.envValue(sub[1]); v != "" {
				return v
			}
		}
		return m
	})
	out = winPsEnvRegex.ReplaceAllStringFunc(out, func(m string) string {
		sub := winPsEnvRegex.FindStringSubmatch(m)
		if len(sub) == 2 {
			if v := o.envValue(sub[1]); v != "" {
				return v
			}
		}
		return m
	})
	return out
}

func resolveCandidatePath(o Options, raw string, cwd string) string {
	platform := o.nodePlatform()
	expanded := strings.TrimSpace(expandWindowsEnv(o, raw))
	candidate := strings.Trim(expanded, `"'`)
	if candidate == "" {
		return ""
	}
	if envPlatformIsAbs(platform, candidate) {
		return envPlatformNormalize(platform, candidate)
	}
	base := strings.TrimSpace(expandWindowsEnv(o, cwd))
	if base != "" && envPlatformIsAbs(platform, base) {
		return envPlatformNormalize(platform, envPlatformJoinPathResolved(platform, base, candidate))
	}
	return ""
}

func envPlatformJoinPathResolved(platform string, base string, rel string) string {
	if platform == "win32" {
		return envPlatformPathJoin(platform, base, rel)
	}
	return path.Clean(path.Join(base, rel))
}

func extractFlagValues(platform string, p ProcessEntry, flags []string, role string) (present bool, values []string) {
	flagSet := make(map[string]struct{}, len(flags))
	for _, f := range flags {
		flagSet[strings.ToLower(strings.TrimSpace(f))] = struct{}{}
	}
	args := processArgumentsForRole(platform, p, role)
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		lower := strings.ToLower(arg)
		if _, ok := flagSet[lower]; ok {
			present = true
			if i+1 < len(args) && strings.TrimSpace(args[i+1]) != "" {
				values = append(values, args[i+1])
			}
			continue
		}
		for f := range flagSet {
			prefix := f + "="
			if strings.HasPrefix(lower, prefix) {
				present = true
				values = append(values, arg[len(prefix):])
				break
			}
		}
	}
	return present, values
}

// ExtractConfigPath 从进程命令行参数中提取配置文件路径（如 frpc -c /path/frpc.toml）。
func ExtractConfigPath(p ProcessEntry, role string, opts Options) string {
	o := opts.withDefaults()
	_, values := extractFlagValues(o.nodePlatform(), p, frpConfigFlags, firstNonEmpty(role, "frpc"))
	if len(values) > 0 {
		return resolveCandidatePath(o, values[0], p.Cwd)
	}
	return ""
}

// ReadProcessEntries 枚举当前宿主上的相关进程及匹配角色的工作目录。
func ReadProcessEntries(ctx context.Context, opts Options, roles []string) []ProcessEntry {
	o := opts.withDefaults()
	if o.ProcessEntriesOverride != nil {
		return append([]ProcessEntry{}, o.ProcessEntriesOverride...)
	}
	if len(roles) == 0 {
		roles = networkToolIDs
	}
	platform := o.nodePlatform()
	if platform == "win32" {
		script := "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
		res := o.Exec.Run(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Command", script}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
		if !res.OK {
			return nil
		}
		var rows []struct {
			ProcessID      int    `json:"ProcessId"`
			ParentPID      int    `json:"ParentProcessId"`
			Name           string `json:"Name"`
			ExecutablePath string `json:"ExecutablePath"`
			CommandLine    string `json:"CommandLine"`
		}
		if err := unmarshalOneOrMany(res.Stdout, &rows); err != nil {
			return nil
		}
		entries := make([]ProcessEntry, 0, len(rows))
		for _, r := range rows {
			entries = append(entries, ProcessEntry{
				PID:            r.ProcessID,
				ParentPID:      r.ParentPID,
				Name:           r.Name,
				ExecutablePath: r.ExecutablePath,
				CommandLine:    r.CommandLine,
			})
		}
		return entries
	}

	res := o.Exec.Run(ctx, "ps", []string{"-ww", "-axo", "pid=,ppid=,command="}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
	if !res.OK {
		return nil
	}
	var entries []ProcessEntry
	for _, line := range strings.Split(res.Stdout, "\n") {
		m := psLinePattern.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if len(m) != 4 {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		ppid, _ := strconv.Atoi(m[2])
		entry := ProcessEntry{PID: pid, ParentPID: ppid, CommandLine: strings.TrimSpace(m[3])}
		matched := false
		for _, role := range roles {
			if processMatchesRole(platform, entry, role) {
				matched = true
				break
			}
		}
		if matched {
			entry.Cwd = resolveProcessCwd(ctx, o, pid)
		}
		entries = append(entries, entry)
	}
	return entries
}

func resolveProcessCwd(ctx context.Context, o Options, pid int) string {
	if pid <= 0 {
		return ""
	}
	switch o.nodePlatform() {
	case "linux":
		target, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
		if err != nil {
			return ""
		}
		return strings.TrimSpace(target)
	case "darwin":
		res := o.Exec.Run(ctx, "lsof", []string{"-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn"}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
		if !res.OK {
			return ""
		}
		if m := lsofCwdPattern.FindStringSubmatch(res.Stdout); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

// ReadStartupEntries 扫描系统的启动项/后台托管服务配置（launchd / systemd / Windows）。
func ReadStartupEntries(ctx context.Context, opts Options, roles []string) []StartupEntry {
	o := opts.withDefaults()
	if o.StartupEntriesOverride != nil {
		return append([]StartupEntry{}, o.StartupEntriesOverride...)
	}
	if len(roles) == 0 {
		roles = networkToolIDs
	}
	roleRx := buildRolePattern(roles)
	switch o.nodePlatform() {
	case "darwin":
		return readLaunchdEntries(ctx, o, roleRx)
	case "linux":
		return readSystemdEntries(ctx, o, roleRx)
	case "win32":
		return readWindowsStartupEntries(ctx, o)
	}
	return nil
}

func buildRolePattern(roles []string) *regexp.Regexp {
	escaped := make([]string, 0, len(roles))
	for _, r := range roles {
		r = strings.ToLower(strings.TrimSpace(r))
		if r != "" {
			escaped = append(escaped, regexp.QuoteMeta(r))
		}
	}
	if len(escaped) == 0 {
		return regexp.MustCompile(`a^`)
	}
	return regexp.MustCompile(`(?i)\b(?:` + strings.Join(escaped, "|") + `)(?:\.exe)?\b`)
}

func listSuffixFiles(dir string, suffix string, depth int) []string {
	if dir == "" || depth > 2 {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		info, err := os.Stat(full)
		if err == nil && info.IsDir() && !entry.Type().IsRegular() && (entry.Type()&os.ModeSymlink == 0) {
			if depth < 2 {
				out = append(out, listSuffixFiles(full, suffix, depth+1)...)
			}
			continue
		}
		if entry.IsDir() {
			if depth < 2 {
				out = append(out, listSuffixFiles(full, suffix, depth+1)...)
			}
			continue
		}
		if suffix == "" || strings.HasSuffix(strings.ToLower(full), suffix) {
			out = append(out, full)
		}
	}
	return out
}

func readLaunchdEntries(ctx context.Context, o Options, roleRx *regexp.Regexp) []StartupEntry {
	home := o.hostHome()
	dirs := []string{"/Library/LaunchDaemons", "/Library/LaunchAgents"}
	if home != "" {
		dirs = append(dirs, filepath.Join(home, "Library", "LaunchAgents"))
	}
	var out []StartupEntry
	for _, dir := range dirs {
		for _, file := range listSuffixFiles(dir, ".plist", 0) {
			raw, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			content := string(raw)
			if !strings.Contains(content, "<plist") {
				conv := o.Exec.Run(ctx, "/usr/bin/plutil", []string{"-convert", "xml1", "-o", "-", "--", file}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
				if conv.OK {
					content = conv.Stdout
				}
			}
			args := plistArray(content, "ProgramArguments")
			program := plistString(content, "Program")
			if !roleRx.MatchString(program + " " + strings.Join(args, " ")) {
				continue
			}
			cmdLine := program
			if len(args) > 0 {
				quoted := make([]string, len(args))
				for i, a := range args {
					if strings.ContainsAny(a, " \t") {
						quoted[i] = `"` + a + `"`
					} else {
						quoted[i] = a
					}
				}
				cmdLine = strings.Join(quoted, " ")
			}
			exe := program
			if exe == "" && len(args) > 0 {
				exe = args[0]
			}
			var rest []string
			if len(args) > 1 {
				rest = args[1:]
			}
			out = append(out, StartupEntry{
				Source:           "launchd",
				Name:             filepath.Base(file),
				ExecutablePath:   exe,
				Args:             rest,
				CommandLine:      cmdLine,
				WorkingDirectory: plistString(content, "WorkingDirectory"),
				Enabled:          launchdEntryEnabled(content),
			})
		}
	}
	return out
}

func decodePlistText(v string) string {
	v = plistHexEntityRegex.ReplaceAllStringFunc(v, func(m string) string {
		sub := plistHexEntityRegex.FindStringSubmatch(m)
		if cp, err := strconv.ParseInt(sub[1], 16, 32); err == nil {
			return string(rune(cp))
		}
		return m
	})
	v = plistDecEntityRegex.ReplaceAllStringFunc(v, func(m string) string {
		sub := plistDecEntityRegex.FindStringSubmatch(m)
		if cp, err := strconv.ParseInt(sub[1], 10, 32); err == nil {
			return string(rune(cp))
		}
		return m
	})
	r := strings.NewReplacer("&quot;", `"`, "&apos;", `'`, "&lt;", "<", "&gt;", ">", "&amp;", "&")
	return r.Replace(v)
}

func plistString(content string, key string) string {
	rx := regexp.MustCompile(`<key>` + regexp.QuoteMeta(key) + `</key>\s*<string>([^<]*)</string>`)
	m := rx.FindStringSubmatch(content)
	if len(m) != 2 {
		return ""
	}
	return strings.TrimSpace(decodePlistText(m[1]))
}

func plistBoolean(content string, key string) bool {
	rx := regexp.MustCompile(`<key>` + regexp.QuoteMeta(key) + `</key>\s*<(true|false)\s*/>`)
	m := rx.FindStringSubmatch(content)
	return len(m) == 2 && m[1] == "true"
}

func plistArray(content string, key string) []string {
	rx := regexp.MustCompile(`(?s)<key>` + regexp.QuoteMeta(key) + `</key>\s*<array>(.*?)</array>`)
	m := rx.FindStringSubmatch(content)
	if len(m) != 2 {
		return nil
	}
	matches := plistArrayStrRegex.FindAllStringSubmatch(m[1], -1)
	out := make([]string, 0, len(matches))
	for _, item := range matches {
		if s := strings.TrimSpace(decodePlistText(item[1])); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func launchdEntryEnabled(content string) bool {
	if plistBoolean(content, "Disabled") {
		return false
	}
	if plistBoolean(content, "RunAtLoad") || plistBoolean(content, "StartOnMount") || plistKeepAliveRegex.MatchString(content) {
		return true
	}
	for _, k := range []string{"StartInterval", "StartCalendarInterval", "WatchPaths", "QueueDirectories", "MachServices", "Sockets"} {
		if strings.Contains(content, "<key>"+k+"</key>") {
			return true
		}
	}
	return false
}

func readSystemdEntries(ctx context.Context, o Options, roleRx *regexp.Regexp) []StartupEntry {
	home := o.hostHome()
	dirs := systemdServiceDirectories(o, home)
	var out []StartupEntry
	for _, dir := range dirs {
		for _, file := range listSuffixFiles(dir, ".service", 0) {
			raw, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			content := string(raw)
			if !roleRx.MatchString(content) {
				continue
			}
			enabled := strings.Contains(file, ".wants/") || strings.Contains(file, "wants/")
			out = append(out, parseSystemdUnit(filepath.Base(file), content, enabled)...)
		}
	}
	out = append(out, readSystemctlEntries(ctx, o, roleRx, nil)...)
	out = append(out, readSystemctlEntries(ctx, o, roleRx, []string{"--user"})...)
	return out
}

func systemdServiceDirectories(o Options, home string) []string {
	split := func(v string, fb string) []string {
		if strings.TrimSpace(v) == "" {
			v = fb
		}
		var list []string
		for _, part := range strings.Split(v, ":") {
			if p := strings.TrimSpace(part); p != "" {
				list = append(list, p)
			}
		}
		return list
	}
	configHome := strings.TrimSpace(o.LookupEnv("XDG_CONFIG_HOME"))
	if configHome == "" && home != "" {
		configHome = filepath.Join(home, ".config")
	}
	dataHome := strings.TrimSpace(o.LookupEnv("XDG_DATA_HOME"))
	if dataHome == "" && home != "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	runtimeDir := strings.TrimSpace(o.LookupEnv("XDG_RUNTIME_DIR"))
	var userBases []string
	if configHome != "" {
		userBases = append(userBases, configHome)
	}
	userBases = append(userBases, split(o.LookupEnv("XDG_CONFIG_DIRS"), "/etc/xdg")...)
	if runtimeDir != "" {
		userBases = append(userBases, runtimeDir)
	}
	if dataHome != "" {
		userBases = append(userBases, dataHome)
	}
	userBases = append(userBases, split(o.LookupEnv("XDG_DATA_DIRS"), "/usr/local/share:/usr/share")...)

	all := []string{
		"/etc/systemd/system", "/run/systemd/system", "/usr/local/lib/systemd/system",
		"/usr/lib/systemd/system", "/lib/systemd/system",
	}
	for _, b := range userBases {
		all = append(all, filepath.Join(b, "systemd", "user"))
	}
	all = append(all, "/etc/systemd/user", "/usr/local/lib/systemd/user", "/usr/lib/systemd/user")
	return uniqueStrings(all)
}

func readSystemctlEntries(ctx context.Context, o Options, roleRx *regexp.Regexp, scope []string) []StartupEntry {
	args := append(append([]string{}, scope...), "list-unit-files", "--type=service", "--all", "--no-legend", "--no-pager")
	res := o.Exec.Run(ctx, "systemctl", args, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
	if !res.OK {
		return nil
	}
	var out []StartupEntry
	for _, line := range strings.Split(res.Stdout, "\n") {
		m := systemctlRowPattern.FindStringSubmatch(strings.TrimSpace(line))
		if len(m) != 3 || !roleRx.MatchString(m[1]) {
			continue
		}
		catArgs := append(append([]string{}, scope...), "cat", m[1])
		unit := o.Exec.Run(ctx, "systemctl", catArgs, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
		if !unit.OK {
			continue
		}
		out = append(out, parseSystemdUnit(m[1], unit.Stdout, systemctlEnabledRx.MatchString(m[2]))...)
	}
	return out
}

func parseSystemdUnit(name string, content string, enabled bool) []StartupEntry {
	normalized := regexp.MustCompile(`\\\r?\n\s*`).ReplaceAllString(content, " ")
	wdir := ""
	if m := systemdWdirPattern.FindStringSubmatch(normalized); len(m) == 2 {
		wdir = strings.TrimSpace(m[1])
	}
	matches := systemdExecPattern.FindAllStringSubmatch(normalized, -1)
	out := make([]StartupEntry, 0, len(matches))
	for _, m := range matches {
		cmdLine := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(m[1]), "-@:+!"))
		if cmdLine == "" {
			continue
		}
		out = append(out, StartupEntry{
			Source:           "systemd",
			Name:             name,
			CommandLine:      cmdLine,
			WorkingDirectory: wdir,
			Enabled:          enabled,
		})
	}
	return out
}

func readWindowsStartupEntries(ctx context.Context, o Options) []StartupEntry {
	script := strings.Join([]string{
		"$items = @(",
		`Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $task = $_; foreach ($action in @($task.Actions)) { [PSCustomObject]@{ Source="scheduled-task"; Name=$task.TaskName; TaskPath=$task.TaskPath; Execute=$action.Execute; Arguments=$action.Arguments; WorkingDirectory=$action.WorkingDirectory; State=$task.State } } };`,
		`Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Source="startup-command"; Name=$_.Name; Command=$_.Command; Location=$_.Location; User=$_.User } };`,
		`Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Source="windows-service"; Name=$_.Name; State=$_.State; StartMode=$_.StartMode; PathName=$_.PathName } }`,
		"); $items | ConvertTo-Json -Compress",
	}, " ")
	res := o.Exec.Run(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Command", script}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
	if !res.OK {
		return nil
	}
	var rows []struct {
		Source           string `json:"Source"`
		Name             string `json:"Name"`
		TaskPath         string `json:"TaskPath"`
		Execute          string `json:"Execute"`
		Arguments        string `json:"Arguments"`
		WorkingDirectory string `json:"WorkingDirectory"`
		State            string `json:"State"`
		Command          string `json:"Command"`
		Location         string `json:"Location"`
		StartMode        string `json:"StartMode"`
		PathName         string `json:"PathName"`
	}
	if err := unmarshalOneOrMany(res.Stdout, &rows); err != nil {
		return nil
	}
	var out []StartupEntry
	for _, r := range rows {
		switch strings.TrimSpace(r.Source) {
		case "scheduled-task":
			exec := strings.TrimSpace(r.Execute)
			args := strings.TrimSpace(r.Arguments)
			cmdLine := exec
			if args != "" {
				if cmdLine != "" {
					cmdLine += " " + args
				} else {
					cmdLine = args
				}
			}
			out = append(out, StartupEntry{
				Source:           "scheduled-task",
				Name:             r.TaskPath + r.Name,
				ExecutablePath:   exec,
				CommandLine:      cmdLine,
				WorkingDirectory: r.WorkingDirectory,
				Enabled:          strings.ToLower(strings.TrimSpace(r.State)) != "disabled",
			})
		case "startup-command":
			out = append(out, StartupEntry{
				Source:      "startup-command",
				Name:        firstNonEmpty(r.Name, r.Location),
				CommandLine: r.Command,
				Enabled:     true,
			})
		case "windows-service":
			mode := strings.ToLower(strings.TrimSpace(r.StartMode))
			out = append(out, StartupEntry{
				Source:      "windows-service",
				Name:        r.Name,
				CommandLine: r.PathName,
				Enabled:     mode == "auto" || strings.Contains(mode, "delayed"),
			})
		}
	}
	return out
}

func unmarshalOneOrMany[T any](raw string, dest *[]T) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		return json.Unmarshal([]byte(trimmed), dest)
	}
	var single T
	if err := json.Unmarshal([]byte(trimmed), &single); err != nil {
		return err
	}
	*dest = []T{single}
	return nil
}

// DiscoverNetworkTools 发现 frpc 运行实例、启动项及权威配置目标。
func DiscoverNetworkTools(ctx context.Context, opts Options) map[string]NetworkToolRuntime {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	procs := ReadProcessEntries(ctx, o, networkToolIDs)
	startups := ReadStartupEntries(ctx, o, networkToolIDs)
	result := make(map[string]NetworkToolRuntime, len(networkToolIDs))

	for _, toolID := range networkToolIDs {
		var allMatchingProcs []ProcessEntry
		var directProcs []ProcessEntry
		for _, p := range procs {
			if processMatchesRole(platform, p, toolID) {
				allMatchingProcs = append(allMatchingProcs, p)
				if EntryDirectlyRunsRole(platform, p, toolID) {
					directProcs = append(directProcs, p)
				}
			}
		}
		matchingProcs := allMatchingProcs
		if len(directProcs) > 0 {
			matchingProcs = directProcs
		}
		var matchingStartups []StartupEntry
		for _, s := range startups {
			if startupMatchesRole(platform, s, toolID) {
				matchingStartups = append(matchingStartups, s)
			}
		}

		cfg := selectFrpcConfig(o, matchingProcs, matchingStartups)
		exePath := ""
		for _, p := range matchingProcs {
			if v := strings.TrimSpace(processExecutableForRole(platform, p, toolID)); v != "" {
				exePath = v
				break
			}
		}
		if exePath == "" {
			for _, s := range matchingStartups {
				if v := strings.TrimSpace(processExecutableForRole(platform, startupAsProcess(s), toolID)); v != "" {
					exePath = v
					break
				}
			}
		}
		exeExists := len(matchingProcs) > 0 || envBoolExists(o, exePath)
		if !exeExists {
			for _, s := range matchingStartups {
				if envBoolExists(o, processExecutableForRole(platform, startupAsProcess(s), toolID)) {
					exeExists = true
					break
				}
			}
		}

		startupManaged := false
		var startupSources []string
		for _, s := range matchingStartups {
			if s.Enabled {
				startupManaged = true
				src := strings.TrimSpace(s.Source)
				if src == "" {
					src = "startup-task"
				}
				startupSources = append(startupSources, src)
			}
		}
		result[toolID] = NetworkToolRuntime{
			Running:          len(matchingProcs) > 0,
			RunningCount:     len(matchingProcs),
			StartupManaged:   startupManaged,
			StartupSources:   uniqueStrings(startupSources),
			ExecutablePath:   exePath,
			ExecutableExists: exeExists,
			ConfigPath:       cfg.Path,
			ConfigSource:     cfg.Source,
			ConfigCount:      cfg.Count,
			ConfigAmbiguous:  cfg.Ambiguous,
			ConfigState:      cfg.State,
		}
	}
	return result
}

type configCandidate struct {
	Path   string
	Source string
}

type configSelection struct {
	Path      string
	Source    string
	Count     int
	Ambiguous bool
	State     string
}

func selectFrpcConfig(o Options, procs []ProcessEntry, startups []StartupEntry) configSelection {
	if sel, ok := selectEntryTier(o, procs, func(ProcessEntry) string { return "running-process" }); ok {
		return sel
	}
	startupProcs := make([]ProcessEntry, len(startups))
	startupSources := make([]string, len(startups))
	for i, s := range startups {
		startupProcs[i] = startupAsProcess(s)
		if strings.TrimSpace(s.Source) != "" {
			startupSources[i] = strings.TrimSpace(s.Source)
		} else {
			startupSources[i] = "startup-task"
		}
	}
	if sel, ok := selectIndexedEntryTier(o, startupProcs, startupSources); ok {
		return sel
	}

	envDeclared := strings.TrimSpace(o.LookupEnv("FRPC_CONFIG")) != "" ||
		strings.TrimSpace(ReadEdgeContextField(o.LookupEnv, "frpcConfig")) != ""
	var envCands []configCandidate
	if val := strings.TrimSpace(o.LookupEnv("FRPC_CONFIG")); val != "" {
		if target := resolveCandidatePath(o, val, ""); target != "" && envPlatformIsAbs(o.nodePlatform(), target) {
			envCands = append(envCands, configCandidate{Path: target, Source: "environment"})
		}
	}
	envSelected := selectExistingCandidates(o, envCands, true)
	if sel, ok := finalizeSelected(envSelected); ok {
		return sel
	}
	if envDeclared {
		return configSelection{Ambiguous: true, State: "unresolved"}
	}

	stdPaths := StandardFrpcConfigCandidates(o)
	stdCands := make([]configCandidate, 0, len(stdPaths))
	for _, p := range stdPaths {
		stdCands = append(stdCands, configCandidate{Path: p, Source: "standard-path"})
	}
	stdSelected := selectExistingCandidates(o, stdCands, true)
	if sel, ok := finalizeSelected(stdSelected); ok {
		return sel
	}
	return configSelection{State: "none"}
}

func selectEntryTier(o Options, entries []ProcessEntry, srcFn func(ProcessEntry) string) (configSelection, bool) {
	if len(entries) == 0 {
		return configSelection{}, false
	}
	sources := make([]string, len(entries))
	for i, e := range entries {
		sources[i] = srcFn(e)
	}
	return selectIndexedEntryTier(o, entries, sources)
}

func selectIndexedEntryTier(o Options, entries []ProcessEntry, sources []string) (configSelection, bool) {
	if len(entries) == 0 {
		return configSelection{}, false
	}
	var allCands []configCandidate
	unresolved := false
	for i, entry := range entries {
		cands := collectEntryCandidates(o, entry, sources[i])
		allCands = append(allCands, cands...)
		if len(cands) == 0 || len(selectExistingCandidates(o, cands, false)) == 0 {
			unresolved = true
		}
	}
	selected := selectExistingCandidates(o, allCands, false)
	if unresolved {
		return configSelection{Count: len(selected), Ambiguous: true, State: "unresolved"}, true
	}
	return finalizeSelected(selected)
}

func collectEntryCandidates(o Options, entry ProcessEntry, source string) []configCandidate {
	platform := o.nodePlatform()
	cfgPresent, cfgVals := extractFlagValues(platform, entry, frpConfigFlags, "frpc")
	dirPresent, dirVals := extractFlagValues(platform, entry, frpConfigDirFlags, "frpc")
	var cands []configCandidate
	for _, val := range cfgVals {
		if target := resolveCandidatePath(o, val, entry.Cwd); target != "" {
			cands = append(cands, configCandidate{Path: target, Source: source})
		}
	}
	for _, val := range dirVals {
		if dir := resolveCandidatePath(o, val, entry.Cwd); dir != "" {
			cands = append(cands, listConfigDir(o, dir, source)...)
		}
	}
	if cfgPresent || dirPresent {
		return cands
	}
	if base := strings.TrimSpace(expandWindowsEnv(o, entry.Cwd)); base != "" && envPlatformIsAbs(platform, base) {
		cands = append(cands, configCandidate{Path: envPlatformJoinPathResolved(platform, base, "frpc.ini"), Source: "working-directory"})
	}
	return cands
}

func listConfigDir(o Options, dir string, source string) []configCandidate {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []configCandidate
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		target := filepath.Join(dir, entry.Name())
		if isEditableFrpConfig(o.nodePlatform(), target) {
			out = append(out, configCandidate{Path: target, Source: source})
		}
	}
	return out
}

func isEditableFrpConfig(platform string, target string) bool {
	if strings.TrimSpace(target) == "" {
		return false
	}
	ext := strings.TrimPrefix(strings.ToLower(envPlatformExt(platform, target)), ".")
	for _, allowed := range frpConfigExtensions {
		if ext == allowed {
			return true
		}
	}
	return false
}

func selectExistingCandidates(o Options, cands []configCandidate, firstOnly bool) []configCandidate {
	platform := o.nodePlatform()
	seen := make(map[string]struct{}, len(cands))
	var selected []configCandidate
	for _, c := range cands {
		target := strings.TrimSpace(c.Path)
		if target == "" || !isEditableFrpConfig(platform, target) {
			continue
		}
		key := envPlatformNormalize(platform, target)
		if platform == "win32" {
			key = strings.ToLower(key)
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		if !envBoolExists(o, target) {
			continue
		}
		selected = append(selected, configCandidate{Path: target, Source: c.Source})
		if firstOnly {
			break
		}
	}
	return selected
}

func finalizeSelected(selected []configCandidate) (configSelection, bool) {
	if len(selected) > 1 {
		return configSelection{Count: len(selected), Ambiguous: true, State: "multiple"}, true
	}
	if len(selected) == 1 {
		return configSelection{
			Path:   selected[0].Path,
			Source: selected[0].Source,
			Count:  1,
			State:  "single",
		}, true
	}
	return configSelection{}, false
}

// StandardFrpcConfigCandidates 返回标准路径候选列表。
func StandardFrpcConfigCandidates(o Options) []string {
	platform := o.nodePlatform()
	home := o.hostHome()
	var dirs []string
	if platform == "win32" {
		programData := o.envValue("PROGRAMDATA")
		appData := o.envValue("APPDATA")
		if appData == "" && home != "" {
			appData = envPlatformPathJoin(platform, home, "AppData", "Roaming")
		}
		if programData != "" {
			dirs = append(dirs, envPlatformPathJoin(platform, programData, "frp"))
		}
		if appData != "" {
			dirs = append(dirs, envPlatformPathJoin(platform, appData, "frp"))
		}
		if home != "" {
			dirs = append(dirs, envPlatformPathJoin(platform, home, ".config", "frp"))
		}
	} else {
		if home != "" {
			dirs = append(dirs, envPlatformPathJoin(platform, home, ".config", "frp"))
		}
		dirs = append(dirs, "/etc/frp", "/usr/local/etc/frp", "/etc")
		if platform == "darwin" {
			dirs = append(dirs, "/opt/homebrew/etc/frp")
		}
	}
	var out []string
	for _, dir := range dirs {
		for _, ext := range frpConfigExtensions {
			out = append(out, envPlatformPathJoin(platform, dir, "frpc."+ext))
		}
	}
	return uniqueStrings(out)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		t := strings.TrimSpace(v)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}
