//go:build windows

package appcatalog

import (
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/application/launcher"
)

// windowsAliasEntry adds alternate-language search names for a Windows application.
// Keys are compared against the normalized display name and against normalized
// tokens of the launch target (executable stem, package identity, path segments).
type windowsAliasEntry struct {
	keys    []string
	aliases []string
}

// windowsCuratedAliasEntries fills the gap Windows leaves: the shell exposes a
// single localized display name per app, so an English-UI machine never reports
// the Chinese name of Calculator, and a Chinese-named app's English name only
// appears in its executable. Runtime derivation (see windowsSearchAliases) covers
// whatever the target path or package identity carries; this table adds the
// well-known names that are not derivable.
var windowsCuratedAliasEntries = []windowsAliasEntry{
	{keys: []string{"Calculator", "WindowsCalculator", "计算器"}, aliases: []string{"计算器"}},
	{keys: []string{"Settings", "ImmersiveControlPanel", "设置"}, aliases: []string{"设置"}},
	{keys: []string{"Microsoft Store", "WindowsStore", "微软商店", "商店"}, aliases: []string{"微软商店", "商店"}},
	{keys: []string{"Terminal", "WindowsTerminal", "终端"}, aliases: []string{"终端"}},
	{keys: []string{"File Explorer", "Explorer", "文件资源管理器", "资源管理器"}, aliases: []string{"文件资源管理器", "资源管理器"}},
	{keys: []string{"Notepad", "记事本"}, aliases: []string{"记事本"}},
	{keys: []string{"Snipping Tool", "ScreenSketch", "截图工具"}, aliases: []string{"截图工具", "截图"}},
	{keys: []string{"Paint", "mspaint", "画图"}, aliases: []string{"画图"}},
	{keys: []string{"Photos", "照片"}, aliases: []string{"照片"}},
	{keys: []string{"Camera", "相机"}, aliases: []string{"相机"}},
	{keys: []string{"Clock", "WindowsAlarms", "时钟"}, aliases: []string{"时钟"}},
	{keys: []string{"Weather", "天气"}, aliases: []string{"天气"}},
	{keys: []string{"Media Player", "MediaPlayer", "WindowsMediaPlayer", "媒体播放器"}, aliases: []string{"媒体播放器"}},
	{keys: []string{"Sound Recorder", "SoundRecorder", "录音机"}, aliases: []string{"录音机"}},
	{keys: []string{"Task Manager", "Taskmgr", "任务管理器"}, aliases: []string{"任务管理器"}},
	{keys: []string{"Control Panel", "ControlPanel", "控制面板"}, aliases: []string{"控制面板"}},
	{keys: []string{"Windows Security", "WindowsSecurity", "安全中心"}, aliases: []string{"安全中心", "Windows 安全中心"}},
	{keys: []string{"Registry Editor", "Regedit", "注册表编辑器"}, aliases: []string{"注册表", "注册表编辑器"}},
	{keys: []string{"Command Prompt", "cmd"}, aliases: []string{"命令提示符"}},
	{keys: []string{"WeChat", "Weixin", "微信"}, aliases: []string{"微信", "Weixin"}},
	{keys: []string{"WeChat DevTools", "wechatdevtools", "微信开发者工具"}, aliases: []string{"微信开发者工具", "WeChat DevTools"}},
	{keys: []string{"DingTalk", "钉钉"}, aliases: []string{"钉钉", "DingTalk"}},
	{keys: []string{"QQ", "腾讯QQ"}, aliases: []string{"腾讯QQ"}},
	{keys: []string{"TIM", "腾讯TIM"}, aliases: []string{"腾讯TIM"}},
	{keys: []string{"Baidu Netdisk", "BaiduNetdisk", "百度网盘", "百度云"}, aliases: []string{"百度网盘", "百度云", "Baidu Netdisk"}},
	{keys: []string{"Thunder", "Xunlei", "迅雷"}, aliases: []string{"迅雷", "Thunder", "Xunlei"}},
	{keys: []string{"NetEase Cloud Music", "CloudMusic", "网易云音乐", "网易云"}, aliases: []string{"网易云音乐", "网易云", "NetEase Cloud Music"}},
	{keys: []string{"QQ Music", "QQMusic", "QQ音乐"}, aliases: []string{"QQ音乐", "QQ Music"}},
	{keys: []string{"Kuwo", "KuwoMusic", "酷我音乐"}, aliases: []string{"酷我音乐", "Kuwo Music"}},
	{keys: []string{"BiliBili", "BiliBiliPC", "哔哩哔哩", "B站"}, aliases: []string{"哔哩哔哩", "B站", "bilibili"}},
	{keys: []string{"Quark", "QuarkClouddrive", "夸克", "夸克网盘"}, aliases: []string{"夸克", "夸克网盘", "Quark"}},
	{keys: []string{"Huorong", "HipsMain", "火绒", "火绒安全软件"}, aliases: []string{"火绒", "火绒安全软件", "Huorong"}},
	{keys: []string{"HiSuite", "华为手机助手"}, aliases: []string{"华为手机助手", "HiSuite"}},
	{keys: []string{"MindMaster", "EdrawMind", "万兴脑图"}, aliases: []string{"万兴脑图", "EdrawMind"}},
	{keys: []string{"Minecraft", "我的世界"}, aliases: []string{"我的世界", "Minecraft"}},
	{keys: []string{"Mini World", "MiniWorld", "迷你世界", "官方版迷你世界"}, aliases: []string{"迷你世界", "Mini World"}},
	{keys: []string{"Steam", "蒸汽平台"}, aliases: []string{"蒸汽平台", "Steam"}},
	{keys: []string{"Dota 2", "Dota2", "Dota", "Dota 2 刀塔", "刀塔"}, aliases: []string{"刀塔", "Dota 2"}},
	{keys: []string{"Visual Studio Code", "VisualStudioCode", "VSCode"}, aliases: []string{"VSCode", "VS Code"}},
	{keys: []string{"Sogou Input", "SogouInput", "搜狗输入法", "搜狗"}, aliases: []string{"搜狗输入法", "Sogou Input"}},
	{keys: []string{"WeType", "微信输入法"}, aliases: []string{"微信输入法", "WeChat Input"}},
	{keys: []string{"WPS Office", "WPS"}, aliases: []string{"WPS Office"}},
}

var windowsCuratedAliasIndex = buildWindowsAliasIndex()

func buildWindowsAliasIndex() map[string][]string {
	index := make(map[string][]string, len(windowsCuratedAliasEntries)*2)
	for _, entry := range windowsCuratedAliasEntries {
		for _, key := range entry.keys {
			normalized := windowsAliasKey(key)
			if normalized == "" {
				continue
			}
			index[normalized] = append(index[normalized], entry.aliases...)
		}
	}
	return index
}

// windowsAliasKey lowercases text and drops separators so "Microsoft Store",
// "microsoft-store" and "MicrosoftStore" share one key.
func windowsAliasKey(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// windowsSearchAliases returns the alternate-language names for one catalog entry,
// capped at launcher.MaxAliases. Curated names come first, then names derived from
// the launch target so the searchable identity survives renames by the installer.
func windowsSearchAliases(name, target string) []string {
	keys := make(map[string]struct{}, 12)
	addKey := func(candidate string) {
		if key := windowsAliasKey(candidate); key != "" {
			keys[key] = struct{}{}
		}
	}
	addKey(name)
	tokens := windowsIdentityTokens(target)
	for _, token := range tokens {
		addKey(token)
	}

	seen := map[string]struct{}{windowsAliasKey(name): {}}
	out := make([]string, 0, launcher.MaxAliases)
	push := func(alias string) {
		if len(out) >= launcher.MaxAliases {
			return
		}
		alias = strings.TrimSpace(alias)
		key := windowsAliasKey(alias)
		if key == "" {
			return
		}
		if _, dup := seen[key]; dup {
			return
		}
		seen[key] = struct{}{}
		out = append(out, alias)
	}

	if aliases, ok := windowsCuratedAliasIndex[windowsAliasKey(name)]; ok {
		for _, alias := range aliases {
			push(alias)
		}
	}
	// Protocol targets (steamchina://, bilibili.com docs) identify a platform or a
	// documentation page, not the application, so they must not pull curated names.
	if !strings.Contains(target, "://") {
		for _, token := range tokens {
			aliases, ok := windowsCuratedAliasIndex[windowsAliasKey(token)]
			if !ok {
				continue
			}
			for _, alias := range aliases {
				push(alias)
			}
		}
	}
	for _, alias := range windowsDerivedAliases(target) {
		push(alias)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// windowsIdentityTokens splits a launch target into normalized-match pieces:
// every run of letters/digits from the executable path, package identity, or AUMID.
func windowsIdentityTokens(target string) []string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(target), `shell:AppsFolder\`)
	if idx := strings.IndexByte(trimmed, '?'); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	return strings.FieldsFunc(trimmed, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// windowsDerivedAliases turns the executable stem, package identity, or URL host
// into human-readable search names ("BaiduNetdisk.exe" -> BaiduNetdisk / Baidu Netdisk).
func windowsDerivedAliases(target string) []string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(target), `shell:AppsFolder\`)

	var candidates []string
	switch {
	case strings.Contains(trimmed, "://"):
		// Only web shortcuts carry an application name in their host
		// (bilibili.com -> bilibili). Custom schemes name a platform
		// (steamchina://, fevergames://), not the launched application.
		scheme := strings.ToLower(trimmed[:strings.Index(trimmed, "://")])
		if scheme != "http" && scheme != "https" {
			return nil
		}
		host := trimmed[strings.Index(trimmed, "://")+3:]
		if idx := strings.IndexAny(host, "/?#"); idx >= 0 {
			host = host[:idx]
		}
		for _, label := range strings.Split(host, ".") {
			candidates = append(candidates, label)
		}
	case strings.ContainsAny(trimmed, `\/`) || strings.HasPrefix(trimmed, "{"):
		candidates = append(candidates, windowsExecutableCandidates(trimmed)...)
	case strings.Contains(trimmed, "!"):
		candidates = append(candidates, windowsPackageCandidates(trimmed[:strings.Index(trimmed, "!")])...)
	case strings.ContainsAny(trimmed, "._"):
		candidates = append(candidates, windowsPackageCandidates(trimmed)...)
	default:
		candidates = append(candidates, trimmed)
	}

	out := make([]string, 0, len(candidates)*2)
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if len([]rune(candidate)) < 3 || windowsGenericIdentityToken(candidate) {
			continue
		}
		out = append(out, candidate)
		if spaced := joinCamelWords(candidate); spaced != "" {
			out = append(out, spaced)
		}
	}
	return out
}

func windowsExecutableCandidates(target string) []string {
	cleaned := strings.ReplaceAll(target, `/`, `\`)
	if idx := strings.LastIndex(cleaned, `\`); idx >= 0 {
		cleaned = cleaned[idx+1:]
	}
	if idx := strings.LastIndex(cleaned, "."); idx > 0 {
		cleaned = cleaned[:idx]
	}
	return []string{cleaned}
}

func windowsPackageCandidates(pkg string) []string {
	var out []string
	for _, segment := range strings.Split(pkg, ".") {
		segment = strings.TrimSpace(segment)
		if idx := strings.IndexByte(segment, '_'); idx > 0 {
			segment = segment[:idx]
		}
		if segment == "" {
			continue
		}
		out = append(out, segment)
	}
	return out
}

var windowsGenericIdentityTokens = map[string]struct{}{
	"com": {}, "net": {}, "org": {}, "www": {},
	"app": {}, "apps": {}, "application": {}, "applications": {},
	"client": {}, "core": {}, "host": {}, "server": {}, "service": {}, "services": {},
	"helper": {}, "updater": {}, "update": {}, "updates": {},
	"setup": {}, "install": {}, "installer": {}, "uninstall": {}, "unins": {}, "unins000": {},
	"exe": {}, "dll": {}, "bin": {}, "lib": {}, "libs": {},
	"windows": {}, "microsoft": {}, "microsoftwindows": {},
	"program": {}, "programs": {}, "files": {}, "file": {}, "programdata": {},
	"appdata": {}, "roaming": {}, "local": {}, "users": {}, "user": {}, "public": {},
	"system32": {}, "syswow64": {}, "desktop": {}, "common": {}, "temp": {}, "tmp": {},
	"cache": {}, "assets": {}, "resources": {}, "runtime": {}, "data": {}, "config": {},
	"tools": {}, "launcher": {}, "main": {}, "ui": {},
	"autogenerated": {}, "aumid": {},
}

func windowsGenericIdentityToken(token string) bool {
	normalized := windowsAliasKey(token)
	if normalized == "" {
		return true
	}
	if _, ok := windowsGenericIdentityTokens[normalized]; ok {
		return true
	}
	first, _ := utf8FirstRune(normalized)
	return unicode.IsDigit(first)
}

func utf8FirstRune(s string) (rune, bool) {
	for _, r := range s {
		return r, true
	}
	return 0, false
}

// joinCamelWords returns "Baidu Netdisk" for "BaiduNetdisk" and "" when the token
// has no internal word boundary worth showing.
func joinCamelWords(token string) string {
	words := camelWords(token)
	if len(words) < 2 {
		return ""
	}
	joined := strings.Join(words, " ")
	if len([]rune(joined)) > 48 {
		return ""
	}
	return joined
}

func camelWords(token string) []string {
	runes := []rune(token)
	if len(runes) < 2 {
		return []string{token}
	}
	words := make([]string, 0, 4)
	start := 0
	for i := 1; i < len(runes); i++ {
		prev, cur := runes[i-1], runes[i]
		boundary := unicode.IsLower(prev) && unicode.IsUpper(cur)
		if !boundary && unicode.IsUpper(prev) && unicode.IsUpper(cur) && i+1 < len(runes) && unicode.IsLower(runes[i+1]) {
			boundary = true
		}
		if boundary {
			words = append(words, string(runes[start:i]))
			start = i
		}
	}
	words = append(words, string(runes[start:]))
	return words
}
