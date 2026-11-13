package providerconfigs

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	cliVersionCacheTTL = 60 * time.Second
	cliHelpCacheTTL    = 10 * time.Minute
	codexLegacyMarker  = "aih-codex-cli-hook"
)

var (
	reBinaryVer    = regexp.MustCompile(`(?i)(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?:$|[^0-9A-Za-z])`)
	reFlagToken    = regexp.MustCompile(`--[a-zA-Z][a-zA-Z0-9-]*`)
	reCamelToKebab = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	reSepToDash    = regexp.MustCompile(`[_\s]+`)
	reNonKebab     = regexp.MustCompile(`[^a-z0-9-]`)
	reTrimSuffix   = regexp.MustCompile(`-(mode|policy|permissions?|enabled|type)$`)

	fieldFlagHints = map[string]map[string]string{
		"codex": {
			"approval_policy": "--ask-for-approval",
			"sandbox_mode":    "--sandbox",
		},
		"claude": {
			"defaultmode": "--permission-mode",
		},
	}
)

// CLIInfo 描述当前宿主机上对应的 Provider 原生 CLI 状态。
type CLIInfo struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	Path      string `json:"path"`
}

// CLIEquivalent 表示配置字段在对应 CLI --help 中核实过的等价旗标。
type CLIEquivalent struct {
	Flag   string `json:"flag"`
	Sample string `json:"sample"`
}

// CLIRunner 抽象 CLI 版本与 --help 探测执行，方便测试注入。
type CLIRunner interface {
	ResolveBinary(provider string, hostHome string, env map[string]string) string
	Version(ctx context.Context, binary string) string
	Help(ctx context.Context, binary string) string
}

type hostCLIRunner struct {
	catalog *providers.Catalog
	exec    hostexec.Executor

	mu           sync.Mutex
	versionCache map[string]cachedVersion
	helpCache    map[string]cachedHelp
}

type cachedVersion struct {
	at   time.Time
	info CLIInfo
}

type cachedHelp struct {
	at   time.Time
	text string
}

func newHostCLIRunner(catalog *providers.Catalog) *hostCLIRunner {
	return &hostCLIRunner{
		catalog:      catalog,
		versionCache: make(map[string]cachedVersion),
		helpCache:    make(map[string]cachedHelp),
	}
}

func (r *hostCLIRunner) ResolveBinary(provider, hostHome string, env map[string]string) string {
	id := strings.ToLower(strings.TrimSpace(provider))
	if id == "" {
		return ""
	}
	overrideKey := "AIH_" + strings.ToUpper(id) + "_BINARY"
	if override, ok := env[overrideKey]; ok {
		trimmed := strings.TrimSpace(override)
		if trimmed == "" || trimmed != override {
			return ""
		}
		if resolved, err := lookExecutableInDirs(trimmed, nil); err == nil {
			return bypassCodexHook(id, resolved)
		}
		return ""
	}

	candidates := []string{id}
	if r.catalog != nil {
		if def, ok := r.catalog.Get(id); ok && def.CLI != nil && strings.TrimSpace(def.CLI.BinaryName) != "" {
			binName := strings.TrimSpace(def.CLI.BinaryName)
			if binName != id {
				candidates = []string{binName, id}
			}
		}
	}

	searchDirs := collectSearchDirs(hostHome, env)
	for _, name := range candidates {
		if found, err := lookExecutableInDirs(name, searchDirs); err == nil && found != "" {
			return bypassCodexHook(id, found)
		}
	}
	return ""
}

func (r *hostCLIRunner) Version(ctx context.Context, binary string) string {
	if binary == "" {
		return ""
	}
	res := r.exec.Run(ctx, binary, []string{"--version"}, environment.ExecOptions{Timeout: 3 * time.Second})
	if res.ExitCode == nil || *res.ExitCode != 0 {
		return ""
	}
	raw := res.Stdout + "\n" + res.Stderr
	return parseBinaryVersion(raw, 32)
}

func (r *hostCLIRunner) Help(ctx context.Context, binary string) string {
	if binary == "" {
		return ""
	}
	sig := binary
	if info, err := os.Stat(binary); err == nil {
		sig = binary + "|" + info.ModTime().UTC().Format(time.RFC3339Nano)
	}
	r.mu.Lock()
	if cached, ok := r.helpCache[sig]; ok && time.Since(cached.at) < cliHelpCacheTTL {
		r.mu.Unlock()
		return cached.text
	}
	r.mu.Unlock()

	res := r.exec.Run(ctx, binary, []string{"--help"}, environment.ExecOptions{Timeout: 5 * time.Second})
	text := res.Stdout + "\n" + res.Stderr
	r.mu.Lock()
	r.helpCache[sig] = cachedHelp{at: time.Now(), text: text}
	r.mu.Unlock()
	return text
}

func parseBinaryVersion(output string, maxLen int) string {
	if m := reBinaryVer.FindStringSubmatch(output); m != nil {
		return m[1]
	}
	first := strings.TrimSpace(strings.SplitN(output, "\n", 2)[0])
	runes := []rune(first)
	if len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return first
}

func bypassCodexHook(provider, resolved string) string {
	if provider != "codex" || !fileContainsMarker(resolved, codexLegacyMarker) {
		return resolved
	}
	orig := resolved + ".aih-original"
	if info, err := os.Stat(orig); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		return filepath.Clean(orig)
	}
	return ""
}

func fileContainsMarker(path, marker string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, 4096))
	return err == nil && strings.Contains(string(buf), marker)
}

func collectSearchDirs(hostHome string, env map[string]string) []string {
	seen := make(map[string]bool)
	var dirs []string
	add := func(d string) {
		d = strings.TrimSpace(d)
		if d == "" || seen[d] {
			return
		}
		seen[d] = true
		dirs = append(dirs, d)
	}
	if rt := env["AIH_RUNTIME_TOOLS_DIR"]; rt != "" {
		add(rt)
	}
	for _, entry := range filepath.SplitList(env["PATH"]) {
		add(entry)
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

func lookExecutableInDirs(name string, dirs []string) (string, error) {
	if strings.ContainsRune(name, filepath.Separator) {
		if info, err := os.Stat(name); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return filepath.Clean(name), nil
		}
		return "", exec.ErrNotFound
	}
	if len(dirs) == 0 {
		return exec.LookPath(name)
	}
	for _, d := range dirs {
		candidate := filepath.Join(d, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return exec.LookPath(name)
}

func toKebab(key string) string {
	trimmed := strings.Trim(key, `"'[] `)
	s := reCamelToKebab.ReplaceAllString(trimmed, "$1-$2")
	s = reSepToDash.ReplaceAllString(s, "-")
	s = strings.ToLower(s)
	return reNonKebab.ReplaceAllString(s, "")
}

func leafKey(fieldPath string) string {
	parts := strings.Split(fieldPath, ".")
	for i := len(parts) - 1; i >= 0; i-- {
		if p := strings.TrimSpace(parts[i]); p != "" {
			return p
		}
	}
	return ""
}

func candidateFlags(provider, fieldPath string) []string {
	p := strings.ToLower(strings.TrimSpace(provider))
	leaf := leafKey(fieldPath)
	normLeaf := strings.ToLower(leaf)
	if hints, ok := fieldFlagHints[p]; ok {
		if flag, found := hints[normLeaf]; found {
			return []string{flag}
		}
	}
	kebab := toKebab(leaf)
	if kebab == "" {
		return nil
	}
	flags := []string{"--" + kebab}
	if trimmed := reTrimSuffix.ReplaceAllString(kebab, ""); trimmed != "" && trimmed != kebab {
		flags = append(flags, "--"+trimmed)
	}
	out := make([]string, 0, len(flags))
	seen := make(map[string]bool)
	for _, f := range flags {
		if len(f) > 2 && !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// BuildFieldCLIEquivalents 在真实 --help 输出中校验并返回字段对应的 CLI 旗标示例。
func BuildFieldCLIEquivalents(provider string, fields []SchemaField, helpText, executable string) map[string]CLIEquivalent {
	matches := reFlagToken.FindAllString(helpText, -1)
	if len(matches) == 0 {
		return nil
	}
	flagSet := make(map[string]bool, len(matches))
	for _, m := range matches {
		flagSet[m] = true
	}
	command := strings.TrimSpace(executable)
	if command == "" {
		command = strings.TrimSpace(provider)
	}
	out := make(map[string]CLIEquivalent)
	for _, f := range fields {
		if f.Path == "" {
			continue
		}
		var matched string
		for _, cand := range candidateFlags(provider, f.Path) {
			if flagSet[cand] {
				matched = cand
				break
			}
		}
		if matched == "" {
			continue
		}
		leaf := toKebab(leafKey(f.Path))
		if leaf == "" {
			leaf = "value"
		}
		sample := matched + " <" + leaf + ">"
		if command != "" {
			sample = command + " " + sample
		}
		out[f.Path] = CLIEquivalent{Flag: matched, Sample: sample}
	}
	return out
}
