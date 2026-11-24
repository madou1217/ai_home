package completion

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

// 逃生门 -- 之后是原生 CLI 的世界。AIH 不复制各厂商的旗标表，而是把
// <bin> --help 的输出解析成一份按 Provider 缓存的候选：
//   - TAB 只读缓存，不等待子进程（codebuddy --help 实测 1s+）；
//   - 缓存缺失/过期时，后台拉起自身刷新，下一次 TAB 就能用上；
//   - 二进制路径 + size + mtime 是缓存的有效性键，升级 CLI 自动失效。
const (
	nativeFlagRefreshVerb    = "--refresh-native-flags"
	nativeFlagCacheTTL       = 24 * time.Hour
	nativeFlagPendingTTL     = 10 * time.Minute
	nativeFlagHelpTimeout    = 20 * time.Second
	nativeFlagCacheDepth     = 200
	nativeFlagDescriptionMax = 200
)

var (
	nativeFlagTokenPattern   = regexp.MustCompile(`--[A-Za-z0-9][A-Za-z0-9_-]*`)
	nativeFlagColumnPattern  = regexp.MustCompile(`\s{2,}`)
	nativeFlagAnsiPattern    = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	nativeFlagChoicesPattern = regexp.MustCompile(`(?i)choices?:\s*([^.;)]+)`)
	nativeFlagValuePattern   = regexp.MustCompile(`^[A-Za-z0-9_.:/+-]+$`)
)

type nativeFlagEntry struct {
	Value       string   `json:"value"`
	Description string   `json:"description,omitempty"`
	Values      []string `json:"values,omitempty"`
}

type nativeFlagCache struct {
	Binary            string            `json:"binary"`
	BinarySize        int64             `json:"binarySize"`
	BinaryModUnixNano int64             `json:"binaryModUnixNano"`
	RefreshedAt       int64             `json:"refreshedAt"`
	Flags             []nativeFlagEntry `json:"flags"`
}

func nativeFlagCacheFile(aiHome, provider string) string {
	home := strings.TrimSpace(aiHome)
	name := sanitizeCacheToken(provider)
	if home == "" || name == "" {
		return ""
	}
	return filepath.Join(home, "run", "cache", "complete", "native-flags-"+name+".json")
}

// sanitizeCacheToken 只保留安全的文件名字符；Provider 名不需要更复杂的转义。
func sanitizeCacheToken(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char == '_', char == '-':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

// nativeFlagBinaryName 对齐启动路径的二进制名：家族四支共用 codebuddy。
func nativeFlagBinaryName(provider string) string {
	id := normalizeProviderID(provider)
	if id == "" {
		return ""
	}
	if providers.IsCodeBuddyFamilyProvider(id) {
		return "codebuddy"
	}
	definition, found := providerDefinition(id)
	if !found || definition.CLI == nil {
		return ""
	}
	if name := strings.TrimSpace(definition.CLI.BinaryName); name != "" {
		return name
	}
	return definition.ID
}

func resolveNativeFlagBinary(provider string) (string, int64, int64) {
	name := nativeFlagBinaryName(provider)
	if name == "" {
		return "", 0, 0
	}
	path, err := providercli.ResolveBinary(normalizeProviderID(provider), name)
	if err != nil || strings.TrimSpace(path) == "" {
		// 受管运行时未激活（例如 Codex 的 runtime 目录尚未安装）时仍然可以用
		// PATH 上的官方 CLI 生成帮助候选；这里只是补全，不改变启动选择。
		resolved, lookErr := exec.LookPath(name)
		if lookErr != nil {
			return "", 0, 0
		}
		path = resolved
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, 0
	}
	return path, info.Size(), info.ModTime().UnixNano()
}

func readNativeFlagCache(file, binary string, size, mod int64, now time.Time) ([]nativeFlagEntry, bool) {
	if file == "" || binary == "" {
		return nil, false
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, false
	}
	var document nativeFlagCache
	if json.Unmarshal(raw, &document) != nil || document.RefreshedAt <= 0 {
		return nil, false
	}
	if now.Sub(time.UnixMilli(document.RefreshedAt)) > nativeFlagCacheTTL {
		return nil, false
	}
	if document.Binary != binary || document.BinarySize != size || document.BinaryModUnixNano != mod {
		return nil, false
	}
	return document.Flags, true
}

func writeNativeFlagCache(file string, document nativeFlagCache) {
	if file == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return
	}
	temp, err := os.CreateTemp(filepath.Dir(file), ".native-flags-*.tmp")
	if err != nil {
		return
	}
	tempName := temp.Name()
	if _, err := temp.Write(raw); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempName)
		return
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return
	}
	if err := os.Rename(tempName, file); err != nil {
		_ = os.Remove(tempName)
	}
}

// listNativeFlags 读取缓存；缓存不可用时只登记一次后台刷新，绝不阻塞 TAB。
func listNativeFlags(environment Environment, provider string) []nativeFlagEntry {
	aiHome := environment.aiHomeDir()
	file := nativeFlagCacheFile(aiHome, provider)
	binary, size, mod := resolveNativeFlagBinary(provider)
	if flags, ok := readNativeFlagCache(file, binary, size, mod, environment.now()); ok {
		return flags
	}
	if binary == "" {
		return nil
	}
	requestNativeFlagRefresh(aiHome, provider)
	return nil
}

func pendingNativeFlagFile(cacheFile string) string {
	if cacheFile == "" {
		return ""
	}
	return cacheFile + ".pending"
}

func requestNativeFlagRefresh(aiHome, provider string) {
	cacheFile := nativeFlagCacheFile(aiHome, provider)
	pending := pendingNativeFlagFile(cacheFile)
	if pending == "" {
		return
	}
	if info, err := os.Stat(pending); err == nil {
		if time.Since(info.ModTime()) < nativeFlagPendingTTL {
			return
		}
		_ = os.Remove(pending)
	}
	handle, err := os.OpenFile(pending, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_ = handle.Close()
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		_ = os.Remove(pending)
		return
	}
	command := exec.Command(executable, "__complete", nativeFlagRefreshVerb, provider)
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	detachCompletionProcess(command)
	if err := command.Start(); err != nil {
		_ = os.Remove(pending)
		return
	}
	_ = command.Process.Release()
}

// refreshNativeFlags 由后台子进程执行：跑一次 <bin> --help 并落缓存。
func refreshNativeFlags(provider string, environment Environment) {
	id := normalizeProviderID(provider)
	cacheFile := nativeFlagCacheFile(environment.aiHomeDir(), id)
	if cacheFile == "" {
		return
	}
	pending := pendingNativeFlagFile(cacheFile)
	defer func() { _ = os.Remove(pending) }()
	binary, size, mod := resolveNativeFlagBinary(id)
	if binary == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), nativeFlagHelpTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "--help")
	output, _ := command.CombinedOutput()
	// 即使 --help 失败或超时也写一条空缓存：避免每次 TAB 都重复拉起子进程；
	// CLI 升级会改变二进制 mtime，缓存自动失效并重试。
	flags := parseNativeHelpFlags(string(output))
	writeNativeFlagCache(cacheFile, nativeFlagCache{
		Binary:            binary,
		BinarySize:        size,
		BinaryModUnixNano: mod,
		RefreshedAt:       environment.now().UnixMilli(),
		Flags:             flags,
	})
}

// addNativeDynamicValues 给 help 里没有 Choices 的常见旗标补上 AIH 数据源：
// --model 用模型目录，--resume 用该 Provider 的会话列表。
func addNativeDynamicValues(target *collector, context *resolverContext, provider, flag string, prior []string, current string) {
	switch flag {
	case "--model", "-m":
		if context.modelLister == nil {
			return
		}
		targetProvider, token := resolveModelTarget(prior)
		if targetProvider == "" {
			targetProvider = provider
		}
		accountRef := resolveAccountRef(context, targetProvider, token)
		for _, model := range context.modelLister(modelRequest{
			Provider: targetProvider, AccountRef: accountRef, AccountToken: token, Current: current, Mode: "model",
		}) {
			group := groupModel
			if strings.TrimSpace(model.Group) != "" {
				group = model.Group
			}
			target.add(model.Value, model.Description, group, model.Value)
		}
	case "--resume", "-r":
		if context.sessionLister == nil {
			return
		}
		accountToken := accountTokenBefore(prior)
		accountRef := resolveAccountRef(context, provider, accountToken)
		for _, session := range context.sessionLister(provider, accountRef, current) {
			title := strings.TrimSpace(session.Title)
			if title == "" {
				title = "(无标题)"
			}
			target.add(session.ID, formatSessionTime(session.UpdatedAt)+" · "+title, groupSession, title)
		}
	}
}

// parseNativeFlagChoices 从 help 说明里抽取枚举取值（Choices: a, b / choices: "a","b"）。
func parseNativeFlagChoices(description string) []string {
	match := nativeFlagChoicesPattern.FindStringSubmatch(description)
	if match == nil {
		return nil
	}
	parts := strings.FieldsFunc(match[1], func(char rune) bool {
		return char == ',' || char == '|'
	})
	values := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		value := trimChoiceQuotes(part)
		if value == "" || strings.HasSuffix(value, ":") || strings.ContainsAny(value, " \t") ||
			!nativeFlagValuePattern.MatchString(value) {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
		if len(values) >= 16 {
			break
		}
	}
	return values
}

// listNativeFlagValues 返回某个原生旗标的枚举取值；缓存缺失时返回空。
func trimChoiceQuotes(value string) string {
	value = strings.TrimSpace(value)
	for len(value) > 0 && (value[0] == 34 || value[0] == 39 || value[0] == 96) {
		value = value[1:]
	}
	for len(value) > 0 && (value[len(value)-1] == 34 || value[len(value)-1] == 39 || value[len(value)-1] == 96) {
		value = value[:len(value)-1]
	}
	return value
}

func listNativeFlagValues(environment Environment, provider, flag string) []string {
	file := nativeFlagCacheFile(environment.aiHomeDir(), provider)
	binary, size, mod := resolveNativeFlagBinary(provider)
	entries, ok := readNativeFlagCache(file, binary, size, mod, environment.now())
	if !ok {
		return nil
	}
	for _, entry := range entries {
		if entry.Value == flag {
			return entry.Values
		}
	}
	return nil
}

// filterNativeFlags 只在当前词是旗标时才给原生候选：其它形态交回 shell 的
// 路径补全（prompt 里的文件参数仍然可用）。
func filterNativeFlags(entries []nativeFlagEntry, current string) []nativeFlagEntry {
	if !strings.HasPrefix(current, "-") {
		return nil
	}
	result := make([]nativeFlagEntry, 0, len(entries))
	for _, entry := range entries {
		if matchesPrefix(entry.Value, current) {
			result = append(result, entry)
		}
	}
	return result
}

// parseNativeHelpFlags 从 help 文本里抽取长旗标与紧随其后的说明。
func parseNativeHelpFlags(text string) []nativeFlagEntry {
	lines := strings.Split(nativeFlagAnsiPattern.ReplaceAllString(text, ""), "\n")
	seen := make(map[string]struct{}, 64)
	entries := make([]nativeFlagEntry, 0, 64)
	for index := 0; index < len(lines); index++ {
		trimmed := strings.TrimSpace(lines[index])
		if !strings.HasPrefix(trimmed, "-") {
			continue
		}
		spec := trimmed
		description := ""
		if location := nativeFlagColumnPattern.FindStringIndex(trimmed); location != nil {
			spec = strings.TrimSpace(trimmed[:location[0]])
			description = strings.TrimSpace(trimmed[location[1]:])
		}
		// help 的说明会按终端宽度换行（Windows 的 claude 尤其明显）：
		// 把紧随其后的缩进续行拼回来，否则 "(choices: ...)" 会被截断成空枚举。
		for lookahead := index + 1; lookahead < len(lines); lookahead++ {
			raw := lines[lookahead]
			next := strings.TrimSpace(raw)
			if next == "" {
				break
			}
			if strings.HasPrefix(next, "-") {
				break
			}
			if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") {
				break
			}
			description = strings.TrimSpace(description + " " + next)
			if len(description) > 400 {
				break
			}
		}
		for _, token := range nativeFlagTokenPattern.FindAllString(spec, -1) {
			if token == "--" {
				continue
			}
			if _, exists := seen[token]; exists {
				continue
			}
			seen[token] = struct{}{}
			entries = append(entries, nativeFlagEntry{
				Value:       token,
				Description: clipText(description, nativeFlagDescriptionMax),
				Values:      parseNativeFlagChoices(description),
			})
			if len(entries) >= nativeFlagCacheDepth {
				return entries
			}
		}
	}
	return entries
}
