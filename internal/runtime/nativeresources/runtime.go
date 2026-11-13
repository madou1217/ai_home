package nativeresources

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const doctorFreshDuration = 60 * time.Second

// RuntimeProbeResult 描述本机 Provider CLI 或 Host 运行时探测结果。
type RuntimeProbeResult struct {
	Available       bool     `json:"available"`
	Binary          string   `json:"binary,omitempty"`
	Source          string   `json:"source,omitempty"`
	Args            []string `json:"args,omitempty"`
	Version         string   `json:"version,omitempty"`
	Package         string   `json:"package,omitempty"`
	Entry           string   `json:"entry,omitempty"`
	VersionObserved string   `json:"versionObserved,omitempty"`
	Reason          string   `json:"reason,omitempty"`
}

// ProviderRuntimeSpec 描述调用 Provider 原生资源命令的可执行入口与环境。
type ProviderRuntimeSpec struct {
	Command string
	Args    []string
	Env     map[string]string
	Source  string
}

// CommandExecResult 抽象同步/异步外部命令执行结果。
type CommandExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
	ErrCode  string
}

// CommandRunner 抽象命令执行与 Node 二进制探测，便于测试注入。
type CommandRunner interface {
	Run(ctx context.Context, command string, args []string, cwd string, env map[string]string, timeout time.Duration) CommandExecResult
	FindNode() string
}

type defaultCommandRunner struct {
	exec hostexec.Executor
}

func (r defaultCommandRunner) Run(ctx context.Context, command string, args []string, cwd string, env map[string]string, timeout time.Duration) CommandExecResult {
	res := r.exec.Run(ctx, command, args, environment.ExecOptions{
		Dir:            cwd,
		Env:            env,
		Timeout:        timeout,
		MaxOutputBytes: 1024 * 1024,
	})
	code := -1
	if res.ExitCode != nil {
		code = *res.ExitCode
	}
	errCode := ""
	if res.TimedOut {
		errCode = "ETIMEDOUT"
	} else if res.SpawnFailed {
		errCode = res.Message
	}
	return CommandExecResult{
		ExitCode: code,
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
		TimedOut: res.TimedOut,
		ErrCode:  errCode,
	}
}

func (r defaultCommandRunner) FindNode() string {
	for _, cand := range []string{"node", "/opt/homebrew/bin/node", "/usr/local/bin/node"} {
		if p, err := exec.LookPath(cand); err == nil {
			return p
		}
	}
	return ""
}

func resolveDesktopNodeRuntime(catalog *providers.Catalog, provider, hostHome string, nodeBin string) *ProviderRuntimeSpec {
	if catalog == nil || nodeBin == "" {
		return nil
	}
	def, ok := catalog.Get(provider)
	if !ok || def.NativeBoundary == nil || def.NativeBoundary.Runtime == nil {
		return nil
	}
	rt := def.NativeBoundary.Runtime
	if rt.Handler != "desktop-node" || rt.Entry == "" {
		return nil
	}
	if def.CLI == nil || def.CLI.DesktopClient == nil {
		return nil
	}
	var platformCfg *providers.DesktopPlatform
	switch runtime.GOOS {
	case "darwin":
		platformCfg = def.CLI.DesktopClient.MacOS
	case "windows":
		platformCfg = def.CLI.DesktopClient.Windows
	default:
		platformCfg = def.CLI.DesktopClient.Linux
	}
	if platformCfg == nil {
		return nil
	}
	segments := strings.Split(rt.Entry, "/")
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." || strings.Contains(seg, `\`) || strings.Contains(seg, ":") {
			return nil
		}
	}
	for _, tmpl := range platformCfg.InstallPaths {
		root := strings.ReplaceAll(tmpl, "{hostHomeDir}", hostHome)
		entry := filepath.Join(append([]string{root}, segments...)...)
		if info, err := os.Stat(entry); err == nil && info.Mode().IsRegular() {
			envCopy := make(map[string]string, len(rt.Env))
			for k, v := range rt.Env {
				envCopy[k] = v
			}
			return &ProviderRuntimeSpec{
				Command: nodeBin,
				Args:    []string{entry},
				Env:     envCopy,
				Source:  "desktop-node",
			}
		}
	}
	return nil
}

func resolveProviderRuntime(catalog *providers.Catalog, provider, hostHome string, env map[string]string, nodeBin string) *ProviderRuntimeSpec {
	id := strings.ToLower(strings.TrimSpace(provider))
	if catalog == nil {
		return nil
	}
	def, ok := catalog.Get(id)
	if !ok {
		return nil
	}
	var strategyEnv map[string]string
	if def.NativeBoundary != nil && def.NativeBoundary.Runtime != nil {
		strategyEnv = def.NativeBoundary.Runtime.Env
	}
	bin := resolveProviderBinary(catalog, id, hostHome, env)
	if bin != "" {
		envCopy := make(map[string]string, len(strategyEnv))
		for k, v := range strategyEnv {
			envCopy[k] = v
		}
		return &ProviderRuntimeSpec{
			Command: bin,
			Env:     envCopy,
			Source:  "native-cli",
		}
	}
	return resolveDesktopNodeRuntime(catalog, id, hostHome, nodeBin)
}

func resolveProviderBinary(catalog *providers.Catalog, provider, hostHome string, env map[string]string) string {
	overrideKey := "AIH_" + strings.ToUpper(provider) + "_BINARY"
	if override, ok := env[overrideKey]; ok && strings.TrimSpace(override) != "" {
		if info, err := os.Stat(override); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return filepath.Clean(override)
		}
		return ""
	}
	names := []string{provider}
	if catalog != nil {
		if def, ok := catalog.Get(provider); ok && def.CLI != nil && strings.TrimSpace(def.CLI.BinaryName) != "" {
			if def.CLI.BinaryName != provider {
				names = []string{def.CLI.BinaryName, provider}
			}
		}
	}
	dirs := collectPathDirs(hostHome, env)
	for _, name := range names {
		for _, dir := range dirs {
			cand := filepath.Join(dir, name)
			if info, err := os.Stat(cand); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
				return cand
			}
		}
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func collectPathDirs(hostHome string, env map[string]string) []string {
	seen := make(map[string]bool)
	var dirs []string
	add := func(d string) {
		d = strings.TrimSpace(d)
		if d != "" && !seen[d] {
			seen[d] = true
			dirs = append(dirs, d)
		}
	}
	if rt := env["AIH_RUNTIME_TOOLS_DIR"]; rt != "" {
		add(rt)
	}
	for _, p := range filepath.SplitList(env["PATH"]) {
		add(p)
	}
	if hostHome != "" {
		add(filepath.Join(hostHome, ".local", "bin"))
		add(filepath.Join(hostHome, ".npm-global", "bin"))
		add(filepath.Join(hostHome, ".cargo", "bin"))
		add(filepath.Join(hostHome, ".opencode", "bin"))
	}
	add("/opt/homebrew/bin")
	add("/usr/local/bin")
	return dirs
}

func findHostRuntimePackage(desc HostDescriptor, hostHome string, nodeBin string, env map[string]string) (pkgName, version, entry string, found bool) {
	pkgName = harnessPackageNames[desc.Harness]
	if pkgName == "" {
		return "", "", "", false
	}
	var roots []string
	if nodeBin != "" {
		roots = append(roots, filepath.Clean(filepath.Join(filepath.Dir(nodeBin), "..", "lib", "node_modules", pkgName)))
	}
	roots = append(roots, filepath.Join("/opt/homebrew/lib/node_modules", pkgName))
	roots = append(roots, filepath.Join("/usr/local/lib/node_modules", pkgName))
	if hostHome != "" {
		roots = append(roots, filepath.Join(hostHome, ".npm-global", "lib", "node_modules", pkgName))
		// 扫描 pnpm 全局 store 候选目录
		stores := []string{
			filepath.Join(hostHome, "Library", "pnpm", "store"),
			filepath.Join(hostHome, ".local", "share", "pnpm", "store"),
		}
		if p := env["PNPM_HOME"]; p != "" {
			stores = append([]string{filepath.Join(p, "store")}, stores...)
		}
		for _, store := range stores {
			pattern := filepath.Join(store, "*", "files", "package.json")
			if matches, err := filepath.Glob(pattern); err == nil {
				for _, m := range matches {
					if raw, err := os.ReadFile(m); err == nil {
						var pj struct {
							Name string `json:"name"`
						}
						if json.Unmarshal(raw, &pj) == nil && pj.Name == pkgName {
							roots = append(roots, filepath.Dir(m))
						}
					}
				}
			}
		}
	}
	for _, candidate := range roots {
		pjPath := filepath.Join(candidate, "package.json")
		raw, err := os.ReadFile(pjPath)
		if err != nil {
			continue
		}
		var pj struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if json.Unmarshal(raw, &pj) != nil || pj.Name != pkgName {
			continue
		}
		entryPath := filepath.Join(candidate, desc.Entry)
		if info, err := os.Stat(entryPath); err == nil && info.Mode().IsRegular() {
			return pj.Name, pj.Version, entryPath, true
		}
	}
	return pkgName, "", "", false
}

// DoctorProviderRow 表示 Doctor 报告中的单个 Provider 行。
type DoctorProviderRow struct {
	Provider  string                        `json:"provider"`
	Source    string                        `json:"source"`
	Runtime   RuntimeProbeResult            `json:"runtime"`
	Resources map[string]ResourceCapability `json:"resources"`
}

// DoctorHostRow 表示 Doctor 报告中的单个 Host 行。
type DoctorHostRow struct {
	Host      string              `json:"host"`
	State     string              `json:"state"`
	Harness   string              `json:"harness,omitempty"`
	Entry     string              `json:"entry,omitempty"`
	CLIExport string              `json:"cliExport,omitempty"`
	Reason    string              `json:"reason"`
	Evidence  string              `json:"evidence"`
	Runtime   *RuntimeProbeResult `json:"runtime,omitempty"`
}

// DoctorSnapshot 是缓存 60s SWR 的只读探测报告。
type DoctorSnapshot struct {
	Source       string              `json:"source"`
	Providers    []DoctorProviderRow `json:"providers"`
	HostAdapters []DoctorHostRow     `json:"hostAdapters"`
}

type doctorCache struct {
	mu       sync.Mutex
	snapshot *DoctorSnapshot
	at       time.Time
	inFlight bool
	waitCh   chan struct{}
}

func newDoctorCache() *doctorCache {
	return &doctorCache{}
}

func (c *doctorCache) getSWR(ctx context.Context, refresh func(context.Context) DoctorSnapshot) DoctorSnapshot {
	c.mu.Lock()
	if c.snapshot != nil && time.Since(c.at) < doctorFreshDuration {
		snap := *c.snapshot
		c.mu.Unlock()
		return snap
	}
	if c.snapshot != nil {
		// Stale-while-revalidate：立刻返回旧快照，并在后台启动至多一次刷新。
		snap := *c.snapshot
		if !c.inFlight {
			c.inFlight = true
			c.waitCh = make(chan struct{})
			go c.runRefresh(context.Background(), refresh)
		}
		c.mu.Unlock()
		return snap
	}
	if c.inFlight {
		ch := c.waitCh
		c.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return DoctorSnapshot{}
		}
		c.mu.Lock()
		if c.snapshot != nil {
			snap := *c.snapshot
			c.mu.Unlock()
			return snap
		}
		c.mu.Unlock()
		return DoctorSnapshot{}
	}
	c.inFlight = true
	c.waitCh = make(chan struct{})
	ch := c.waitCh
	c.mu.Unlock()

	c.runRefresh(ctx, refresh)
	<-ch

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.snapshot != nil {
		return *c.snapshot
	}
	return DoctorSnapshot{}
}

func (c *doctorCache) runRefresh(ctx context.Context, refresh func(context.Context) DoctorSnapshot) {
	snap := refresh(ctx)
	c.mu.Lock()
	c.snapshot = &snap
	c.at = time.Now()
	c.inFlight = false
	ch := c.waitCh
	c.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func probeAllCapabilities(ctx context.Context, catalog *providers.Catalog, hostHome string, env map[string]string, runner CommandRunner, skipProbe bool) DoctorSnapshot {
	defs := []providers.Definition{}
	if catalog != nil {
		defs = catalog.List()
	}
	nodeBin := runner.FindNode()

	totalJobs := len(defs) + len(importedHosts)
	provRows := make([]DoctorProviderRow, len(defs))
	hostRows := make([]DoctorHostRow, len(importedHosts))

	var idxMu sync.Mutex
	nextIdx := 0
	workerCount := 4
	if totalJobs < workerCount {
		workerCount = totalJobs
	}
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				idxMu.Lock()
				i := nextIdx
				nextIdx++
				idxMu.Unlock()
				if i >= totalJobs {
					return
				}
				if i < len(defs) {
					def := defs[i]
					rt := probeSingleProvider(ctx, catalog, def.ID, hostHome, env, nodeBin, runner, skipProbe)
					resMap := make(map[string]ResourceCapability, len(resourceTypes))
					for _, kind := range resourceTypes {
						resMap[kind] = nativeResourceStatus(def, kind)
					}
					provRows[i] = DoctorProviderRow{
						Provider:  def.ID,
						Source:    "core/providers/native.go",
						Runtime:   rt,
						Resources: resMap,
					}
				} else {
					hi := i - len(defs)
					desc := importedHosts[hi]
					row := DoctorHostRow{
						Host:      desc.Host,
						State:     desc.State,
						Harness:   desc.Harness,
						Entry:     desc.Entry,
						CLIExport: desc.CLIExport,
						Reason:    desc.Reason,
						Evidence:  desc.Evidence,
					}
					if desc.Harness != "" {
						rt := probeSingleHost(ctx, desc, hostHome, nodeBin, env, runner, skipProbe)
						row.Runtime = &rt
						hostCap := getHostResourceCapability(desc.Host, "plugin")
						if rt.Available && hostCap.State == "supported" {
							row.State = "supported"
						} else if rt.Available && desc.State == "runtime-unavailable" {
							row.State = "projection-only"
						}
					}
					hostRows[hi] = row
				}
			}
		}()
	}
	wg.Wait()

	return DoctorSnapshot{
		Source:       "core/providers/native.go → contracts/providers/manifest.json",
		Providers:    provRows,
		HostAdapters: hostRows,
	}
}

func probeSingleProvider(ctx context.Context, catalog *providers.Catalog, provider, hostHome string, env map[string]string, nodeBin string, runner CommandRunner, skipProbe bool) RuntimeProbeResult {
	spec := resolveProviderRuntime(catalog, provider, hostHome, env, nodeBin)
	if spec == nil {
		return RuntimeProbeResult{Available: false, Reason: "native_cli_not_registered"}
	}
	if skipProbe {
		return RuntimeProbeResult{Available: true, Binary: spec.Command, Source: spec.Source, Args: spec.Args}
	}
	probeEnv := copyEnvMap(env)
	for k, v := range spec.Env {
		probeEnv[k] = v
	}
	args := append(append([]string(nil), spec.Args...), "--version")
	res := runner.Run(ctx, spec.Command, args, hostHome, probeEnv, 5*time.Second)
	if res.ExitCode == 0 {
		firstLine := strings.TrimSpace(strings.SplitN(res.Stdout, "\n", 2)[0])
		return RuntimeProbeResult{
			Available: true,
			Binary:    spec.Command,
			Source:    spec.Source,
			Args:      spec.Args,
			Version:   firstLine,
		}
	}
	reason := res.ErrCode
	if reason == "" {
		reason = "native_cli_probe_failed"
	}
	return RuntimeProbeResult{
		Available: false,
		Binary:    spec.Command,
		Source:    spec.Source,
		Args:      spec.Args,
		Reason:    reason,
	}
}

func probeSingleHost(ctx context.Context, desc HostDescriptor, hostHome, nodeBin string, env map[string]string, runner CommandRunner, skipProbe bool) RuntimeProbeResult {
	pkgName, ver, entry, found := findHostRuntimePackage(desc, hostHome, nodeBin, env)
	if !found {
		return RuntimeProbeResult{Available: false, Reason: "native_runtime_package_not_found"}
	}
	if skipProbe || nodeBin == "" {
		return RuntimeProbeResult{Available: false, Package: pkgName, Version: ver, Entry: entry, Reason: "native_runtime_not_probed"}
	}
	var args []string
	if desc.CLIExport != "" {
		entryJSON, _ := json.Marshal(entry)
		exportJSON, _ := json.Marshal(desc.CLIExport)
		urlStr := "file://" + filepath.ToSlash(entry)
		urlJSON, _ := json.Marshal(urlStr)
		script := fmt.Sprintf("process.argv = [process.argv[0], %s, '--version']; const cli = await import(%s); await cli[%s]();", entryJSON, urlJSON, exportJSON)
		args = []string{"--input-type=module", "-e", script}
	} else {
		args = []string{entry, "--version"}
	}
	res := runner.Run(ctx, nodeBin, args, hostHome, env, 5*time.Second)
	observed := strings.TrimSpace(res.Stdout)
	if res.ExitCode == 0 && strings.Contains(observed, ver) {
		return RuntimeProbeResult{Available: true, Package: pkgName, Version: ver, Entry: entry, VersionObserved: observed}
	}
	reason := res.ErrCode
	if reason == "" {
		reason = "native_runtime_probe_failed"
	}
	return RuntimeProbeResult{Available: false, Package: pkgName, Version: ver, Entry: entry, Reason: reason}
}

func copyEnvMap(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
