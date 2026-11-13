// Package terminalicon 把 Provider 图标安装到各终端（iTerm2 / Windows Terminal /
// Linux XDG / Warp），并生成稳定的 Profile 身份。
//
// 与 Node lib/cli/services/terminal-icons.js 同源：Provider 元数据来自 Go 的
// provider manifest（Presentation.Label/Short/TerminalIcon），图标资产内嵌在
// assets 包；Profile GUID 用与 Node 完全相同的 UUIDv5 命名空间。
package terminalicon

import (
	"crypto/sha1"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// FragmentNamespace 是 Windows Terminal fragment 的固定命名空间。
	FragmentNamespace = "{f65ddb7e-706b-4499-8a50-40313caf510a}"
	// warpCommandSection 是 Warp CLI agent 命令映射所在的 TOML 段。
	warpCommandSection = "agents.third_party.cli_agent_toolbar_enabled_commands"
	// regexMetaChars 是 Node buildWarpAgentCommandPattern 转义的元字符集合。
	regexMetaChars = ".*+?()[]{}\\|^$"
)

// ErrUnknownProvider 表示 Provider 不在 manifest 里。
var ErrUnknownProvider = errors.New("terminal icon: unknown provider")

// Provider 是图标安装需要的展示元数据。
type Provider struct {
	ID           string
	Label        string
	Short        string
	TerminalIcon string
	Asset        string
}

// Registry 是 Provider 元数据的只读索引（顺序与 manifest 一致）。
type Registry struct {
	order []string
	byID  map[string]Provider
}

// NewRegistry 从 Provider Catalog 构建注册表。
func NewRegistry(catalog *providers.Catalog) *Registry {
	registry := &Registry{byID: make(map[string]Provider)}
	if catalog == nil {
		return registry
	}
	for _, definition := range catalog.List() {
		presentation := definition.Presentation
		provider := Provider{
			ID:           definition.ID,
			Label:        strings.TrimSpace(presentation.Label),
			Short:        strings.TrimSpace(presentation.Short),
			TerminalIcon: strings.TrimSpace(presentation.TerminalIcon),
			Asset:        strings.TrimSpace(presentation.TerminalIconAsset),
		}
		if provider.Label == "" {
			provider.Label = provider.ID
		}
		registry.byID[provider.ID] = provider
		registry.order = append(registry.order, provider.ID)
	}
	return registry
}

// List 按 manifest 顺序返回全部 Provider。
func (registry *Registry) List() []Provider {
	if registry == nil {
		return nil
	}
	result := make([]Provider, 0, len(registry.order))
	for _, id := range registry.order {
		result = append(result, registry.byID[id])
	}
	return result
}

// Get 读取单个 Provider。
func (registry *Registry) Get(providerID string) (Provider, bool) {
	if registry == nil {
		return Provider{}, false
	}
	provider, ok := registry.byID[strings.ToLower(strings.TrimSpace(providerID))]
	return provider, ok
}

// Normalize 过滤未知/重复的 Provider，保持输入顺序。
func (registry *Registry) Normalize(items []Provider) []Provider {
	seen := make(map[string]bool, len(items))
	result := make([]Provider, 0, len(items))
	for _, provider := range items {
		if provider.ID == "" || seen[provider.ID] {
			continue
		}
		if _, ok := registry.Get(provider.ID); !ok {
			continue
		}
		seen[provider.ID] = true
		result = append(result, provider)
	}
	return result
}

// ProfileName 返回终端 Profile 展示名（AIH <Label>）。
func ProfileName(provider Provider) string {
	label := provider.Label
	if label == "" {
		label = provider.ID
	}
	return "AIH " + label
}

// IconName 返回 XDG 图标/桌面文件基名（aih-<id>）。
func IconName(provider Provider) string {
	return "aih-" + provider.ID
}

// Title 返回标题栏徽标文本（图标 + 短名）。
func Title(provider Provider) string {
	short := provider.Short
	if short == "" {
		short = provider.Label
	}
	if short == "" {
		short = provider.ID
	}
	if provider.TerminalIcon != "" {
		return provider.TerminalIcon + " AIH " + short
	}
	return "AIH " + short
}

// StableGUID 生成与 Node stableGuidForProvider 相同的 UUIDv5：
// uuidV5(uuidV5(FragmentNamespace, "AI Home"), "AIH <Label>")。
func StableGUID(provider Provider) (string, error) {
	if provider.ID == "" {
		return "", ErrUnknownProvider
	}
	appNamespace, err := uuidV5(FragmentNamespace, "AI Home")
	if err != nil {
		return "", err
	}
	return uuidV5(appNamespace, ProfileName(provider))
}

// uuidV5 用 SHA-1 生成 RFC 4122 v5 UUID（name 按 UTF-16LE 编码，与 Node 一致）。
func uuidV5(namespace string, name string) (string, error) {
	namespaceBytes, err := guidBytes(namespace)
	if err != nil {
		return "", err
	}
	hasher := sha1.New()
	hasher.Write(namespaceBytes)
	hasher.Write(utf16LE(name))
	sum := hasher.Sum(nil)[:16]
	sum[6] = (sum[6] & 0x0f) | 0x50
	sum[8] = (sum[8] & 0x3f) | 0x80
	hexText := fmt.Sprintf("%x", sum)
	return "{" + hexText[0:8] + "-" + hexText[8:12] + "-" + hexText[12:16] + "-" +
		hexText[16:20] + "-" + hexText[20:32] + "}", nil
}

// guidBytes 把 {xxxxxxxx-xxxx-...} 解析成 16 字节。
func guidBytes(guid string) ([]byte, error) {
	hexText := strings.NewReplacer("{", "", "}", "", "-", "").Replace(strings.TrimSpace(guid))
	if len(hexText) != 32 {
		return nil, fmt.Errorf("terminal icon: invalid guid %q", guid)
	}
	result := make([]byte, 16)
	for index := 0; index < 16; index++ {
		var value byte
		if _, err := fmt.Sscanf(hexText[index*2:index*2+2], "%02x", &value); err != nil {
			return nil, fmt.Errorf("terminal icon: invalid guid %q", guid)
		}
		result[index] = value
	}
	return result, nil
}

// utf16LE 把字符串编码成 UTF-16 小端字节序列（BMP + 代理对）。
func utf16LE(value string) []byte {
	result := make([]byte, 0, len(value)*2)
	for _, char := range value {
		if char > 0xFFFF {
			char -= 0x10000
			high := uint16(0xD800 + (char >> 10))
			low := uint16(0xDC00 + (char & 0x3FF))
			result = append(result, byte(high), byte(high>>8), byte(low), byte(low>>8))
			continue
		}
		result = append(result, byte(char), byte(char>>8))
	}
	return result
}

// Iterm2Profiles 是 DynamicProfiles 文件根。
type Iterm2Profiles struct {
	Profiles []Iterm2Profile "json:\"Profiles\""
}

// Iterm2Profile 是 iTerm2 Dynamic Profile 的单项。
type Iterm2Profile struct {
	Guid           string   "json:\"Guid\""
	Name           string   "json:\"Name\""
	Tags           []string "json:\"Tags\""
	CustomCommand  string   "json:\"Custom Command\""
	Command        string   "json:\"Command\""
	Icon           int      "json:\"Icon\""
	CustomIconPath string   "json:\"Custom Icon Path\""
}

// BuildIterm2Profiles 生成 iTerm2 Dynamic Profiles；iconPath 返回单个 Provider 的 PNG 路径。
func BuildIterm2Profiles(items []Provider, aihCommand string, iconPath func(Provider) string) (Iterm2Profiles, error) {
	if strings.TrimSpace(aihCommand) == "" {
		aihCommand = "aih"
	}
	profiles := make([]Iterm2Profile, 0, len(items))
	for _, provider := range items {
		guid, err := StableGUID(provider)
		if err != nil {
			return Iterm2Profiles{}, err
		}
		icon := ""
		if iconPath != nil {
			icon = iconPath(provider)
		}
		profiles = append(profiles, Iterm2Profile{
			Guid:           guid,
			Name:           ProfileName(provider),
			Tags:           []string{"AIH"},
			CustomCommand:  "Yes",
			Command:        aihCommand + " " + provider.ID,
			Icon:           2,
			CustomIconPath: icon,
		})
	}
	return Iterm2Profiles{Profiles: profiles}, nil
}

// WindowsTerminalFragment 是 fragment 文件根。
type WindowsTerminalFragment struct {
	Profiles []WindowsTerminalProfile "json:\"profiles\""
}

// WindowsTerminalProfile 是 fragment/settings 里的 profile 项。
type WindowsTerminalProfile struct {
	GUID              string "json:\"guid\""
	Name              string "json:\"name\""
	Commandline       string "json:\"commandline\""
	StartingDirectory string "json:\"startingDirectory\""
	Icon              string "json:\"icon\""
	Hidden            bool   "json:\"hidden\""
}

// BuildWindowsTerminalFragment 生成 Windows Terminal fragment。
func BuildWindowsTerminalFragment(
	items []Provider,
	aihCommand string,
	cmdCommand string,
	iconPath func(Provider) string,
) (WindowsTerminalFragment, error) {
	if strings.TrimSpace(aihCommand) == "" {
		aihCommand = "aih"
	}
	if strings.TrimSpace(cmdCommand) == "" {
		cmdCommand = "cmd.exe"
	}
	profiles := make([]WindowsTerminalProfile, 0, len(items))
	for _, provider := range items {
		guid, err := StableGUID(provider)
		if err != nil {
			return WindowsTerminalFragment{}, err
		}
		icon := ""
		if iconPath != nil {
			icon = iconPath(provider)
		}
		inner := quoteWindowsArg(aihCommand) + " " + quoteWindowsArg(provider.ID)
		profiles = append(profiles, WindowsTerminalProfile{
			GUID:              guid,
			Name:              ProfileName(provider),
			Commandline:       cmdCommand + " /d /s /c \"" + inner + "\"",
			StartingDirectory: "%USERPROFILE%",
			Icon:              icon,
			Hidden:            false,
		})
	}
	return WindowsTerminalFragment{Profiles: profiles}, nil
}

// quoteWindowsArg 与 Node quoteWindowsCmdArg 一致：安全字符原样，其余加引号。
func quoteWindowsArg(value string) string {
	safe := value != ""
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune("_@%+=:,./\\-:", char) {
			continue
		}
		safe = false
		break
	}
	if safe {
		return value
	}
	return "\"" + strings.ReplaceAll(value, "\"", "\"\"") + "\""
}

// WarpEntry 是 Warp agent 命令映射的一条。
type WarpEntry struct {
	Provider  string
	Pattern   string
	AgentName string
}

// warpAgentNames 与 Node WARP_AGENT_NAME_BY_PROVIDER 一致。
var warpAgentNames = map[string]string{
	"codex":       "codex",
	"claude":      "claude",
	"gemini":      "gemini",
	"agy":         "antigravity",
	"opencode":    "opencode",
	"grok":        "grok",
	"qoder":       "qoder",
	"qodercn":     "qoder",
	"kimi":        "kimi",
	"kiro":        "kiro",
	"zcode":       "zcode",
	"codebuddy":   "codebuddy",
	"codebuddycn": "codebuddy",
	"workbuddy":   "workbuddy",
	"workbuddycn": "workbuddy",
	"cline":       "cline",
}

// BuildWarpEntries 生成 Warp agent 命令映射。
func BuildWarpEntries(items []Provider, aihCommand string) []WarpEntry {
	if strings.TrimSpace(aihCommand) == "" {
		aihCommand = "aih"
	}
	entries := make([]WarpEntry, 0, len(items))
	for _, provider := range items {
		agentName, ok := warpAgentNames[provider.ID]
		if !ok {
			continue
		}
		entries = append(entries, WarpEntry{
			Provider:  provider.ID,
			Pattern:   "^" + escapeRegex(aihCommand) + "\\s+" + provider.ID + "(?:\\s|$).*",
			AgentName: agentName,
		})
	}
	return entries
}

// escapeRegex 只转义正则元字符（与 Node 的 replace 集合一致）。
func escapeRegex(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if strings.ContainsRune(regexMetaChars, char) {
			builder.WriteRune('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// UpdateWarpSettingsContent 把 agent 命令映射写入 settings.toml 的固定段。
// 与 Node 同语义：已有同名 key 先删再追加，其余行保持原样。
func UpdateWarpSettingsContent(content string, entries []WarpEntry) string {
	if len(entries) == 0 {
		return content
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := []string{}
	if normalized != "" {
		lines = strings.Split(normalized, "\n")
	}
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	entryKeys := make(map[string]bool, len(entries))
	entryLines := make([]string, 0, len(entries))
	for _, entry := range entries {
		entryKeys[entry.Pattern] = true
		entryLines = append(entryLines, tomlBasicString(entry.Pattern)+" = "+tomlBasicString(entry.AgentName))
	}
	start, end := findTomlSection(lines, warpCommandSection)
	if start < 0 {
		next := append([]string(nil), lines...)
		if len(next) > 0 && strings.TrimSpace(next[len(next)-1]) != "" {
			next = append(next, "")
		}
		next = append(next, "["+warpCommandSection+"]")
		next = append(next, entryLines...)
		return strings.Join(next, "\n") + "\n"
	}
	body := make([]string, 0, end-start)
	for _, line := range lines[start+1 : end] {
		if entryKeys[tomlKey(line)] {
			continue
		}
		body = append(body, line)
	}
	next := make([]string, 0, len(lines)+len(entryLines))
	next = append(next, lines[:start+1]...)
	next = append(next, body...)
	next = append(next, entryLines...)
	next = append(next, lines[end:]...)
	return strings.Join(next, "\n") + "\n"
}

// findTomlSection 返回 [section] 的行区间；不存在时 start<0。
func findTomlSection(lines []string, section string) (int, int) {
	start := -1
	for index, line := range lines {
		name, ok := tomlHeader(line)
		if ok && name == section {
			start = index
			break
		}
	}
	if start < 0 {
		return -1, -1
	}
	for index := start + 1; index < len(lines); index++ {
		if _, ok := tomlHeader(lines[index]); ok {
			return start, index
		}
	}
	return start, len(lines)
}

// tomlHeader 解析 [a.b.c] 段头。
func tomlHeader(line string) (string, bool) {
	text := strings.TrimSpace(line)
	if !strings.HasPrefix(text, "[") {
		return "", false
	}
	end := strings.Index(text, "]")
	if end < 0 {
		return "", false
	}
	name := strings.TrimSpace(text[1:end])
	if name == "" || strings.ContainsAny(name, "[]") {
		return "", false
	}
	rest := strings.TrimSpace(text[end+1:])
	if rest != "" && !strings.HasPrefix(rest, "#") {
		return "", false
	}
	return name, true
}

// tomlKey 读取一行 "key = value" 的 key（支持基本字符串与裸 key）。
func tomlKey(line string) string {
	text := strings.TrimSpace(line)
	if text == "" {
		return ""
	}
	if strings.HasPrefix(text, "\"") {
		closing := strings.Index(text[1:], "\"")
		if closing < 0 {
			return ""
		}
		return unescapeTomlBasic(text[1 : 1+closing])
	}
	if index := strings.Index(text, "="); index > 0 {
		return strings.TrimSpace(text[:index])
	}
	return ""
}

// unescapeTomlBasic 解码 TOML 基本字符串里的转义（与 Node parseTomlKeyLine 同序）。
func unescapeTomlBasic(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		char := value[index]
		if char != '\\' || index+1 >= len(value) {
			builder.WriteByte(char)
			continue
		}
		index++
		switch value[index] {
		case 'b':
			builder.WriteByte('\b')
		case 't':
			builder.WriteByte('\t')
		case 'n':
			builder.WriteByte('\n')
		case 'f':
			builder.WriteByte('\f')
		case 'r':
			builder.WriteByte('\r')
		case '"':
			builder.WriteByte('"')
		case '\\':
			builder.WriteByte('\\')
		default:
			builder.WriteByte('\\')
			builder.WriteByte(value[index])
		}
	}
	return builder.String()
}

// tomlBasicString 生成 TOML 基本字符串。
func tomlBasicString(value string) string {
	replacer := strings.NewReplacer(
		"\\", "\\\\",
		"\"", "\\\"",
		"\b", "\\b",
		"\t", "\\t",
		"\n", "\\n",
		"\f", "\\f",
		"\r", "\\r",
	)
	return "\"" + replacer.Replace(value) + "\""
}

// DesktopEntry 生成 Linux .desktop 文件内容。
func DesktopEntry(provider Provider, aihCommand string) string {
	if strings.TrimSpace(aihCommand) == "" {
		aihCommand = "aih"
	}
	name := ProfileName(provider)
	exec := quoteDesktopArg(aihCommand) + " " + quoteDesktopArg(provider.ID)
	lines := []string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=" + desktopValue(name),
		"Comment=" + desktopValue("Open "+name+" in a terminal"),
		"Exec=" + exec,
		"Icon=" + IconName(provider),
		"Terminal=true",
		"Categories=Development;Utility;",
		"StartupNotify=false",
		"",
	}
	return strings.Join(lines, "\n")
}

// KonsoleProfile 生成 Konsole profile 文件内容。
func KonsoleProfile(provider Provider, aihCommand string) string {
	if strings.TrimSpace(aihCommand) == "" {
		aihCommand = "aih"
	}
	lines := []string{
		"[General]",
		"Name=" + desktopValue(ProfileName(provider)),
		"Icon=" + IconName(provider),
		"Command=" + desktopValue(aihCommand),
		"Arguments=" + desktopValue(provider.ID),
		"",
	}
	return strings.Join(lines, "\n")
}

// quoteDesktopArg 与 Node quoteDesktopExecArg 一致。
func quoteDesktopArg(value string) string {
	safe := value != ""
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune("_@%+=:,./-", char) {
			continue
		}
		safe = false
		break
	}
	if safe {
		return value
	}
	escaped := strings.NewReplacer("\"", "\\\"", "\\", "\\\\").Replace(value)
	return "\"" + escaped + "\""
}

// desktopValue 去掉换行（.desktop 值不能跨行）。
func desktopValue(value string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(value))
}
