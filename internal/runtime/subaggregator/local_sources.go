package subaggregator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	localClientCacheTTL    = 5 * time.Minute
	localClientCmdTimeout  = 8 * time.Second
	localScanMaxBytes      = 2 * 1024 * 1024
	localV2RayNMaxBytes    = 4 * 1024 * 1024
	localScanMaxFilesLimit = 40
)

var (
	surgeManagedConfigRegex = regexp.MustCompile(`(?im)^#!MANAGED-CONFIG\s+(\S+)`)
	surgeSectionHeaderRegex = regexp.MustCompile(`^\[([^\]]+)\]$`)
	surgeIncludeRegex       = regexp.MustCompile(`(?i)^#!include\s+(\S+)`)
	clashFamilyExtRegex     = regexp.MustCompile(`(?i)\.(ya?ml|conf)$`)
	surgeExtRegex           = regexp.MustCompile(`(?i)\.conf$`)
)

// LocalClientDetector 检测本机已安装哪些支持深链接的代理客户端。
type LocalClientDetector struct {
	Platform string
	Run      func(ctx context.Context, file string, args []string) string
	Now      func() time.Time

	mu        sync.Mutex
	cacheKey  string
	cachedAt  time.Time
	cachedRes map[string]*string
}

// NewLocalClientDetector 构造本机客户端检测器。
func NewLocalClientDetector() *LocalClientDetector {
	return &LocalClientDetector{
		Platform: runtime.GOOS,
		Now:      time.Now,
	}
}

func (d *LocalClientDetector) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *LocalClientDetector) platform() string {
	if d.Platform != "" {
		return d.Platform
	}
	return runtime.GOOS
}

func (d *LocalClientDetector) runCmd(ctx context.Context, file string, args []string) string {
	if d.Run != nil {
		return d.Run(ctx, file, args)
	}
	cctx, cancel := context.WithTimeout(ctx, localClientCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, file, args...)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func macAppName(appPath string) *string {
	cleaned := strings.TrimSpace(appPath)
	if cleaned == "" {
		return nil
	}
	base := filepath.Base(cleaned)
	base = strings.TrimSuffix(base, ".app")
	if base == "" || base == "." || base == "/" {
		return nil
	}
	return &base
}

func windowsAppName(command string) *string {
	text := strings.TrimSpace(command)
	if text == "" {
		return nil
	}
	exe := text
	if strings.HasPrefix(text, `"`) {
		if idx := strings.Index(text[1:], `"`); idx >= 0 {
			exe = text[1 : 1+idx]
		}
	} else {
		fields := strings.Fields(text)
		if len(fields) > 0 {
			exe = fields[0]
		}
	}
	exe = strings.ReplaceAll(exe, `\`, `/`)
	base := filepath.Base(exe)
	if idx := strings.LastIndex(strings.ToLower(base), ".exe"); idx >= 0 && idx == len(base)-4 {
		base = base[:idx]
	}
	if base == "" || base == "." || base == "/" {
		return nil
	}
	return &base
}

// Detect 按 URL Scheme 批量探测本机默认处理程序并缓存 5 分钟。
func (d *LocalClientDetector) Detect(ctx context.Context, schemes []string) map[string]*string {
	key := strings.Join(schemes, ",")
	now := d.now()

	d.mu.Lock()
	if d.cachedRes != nil && d.cacheKey == key && now.Sub(d.cachedAt) < localClientCacheTTL {
		cp := make(map[string]*string, len(d.cachedRes))
		for k, v := range d.cachedRes {
			cp[k] = v
		}
		d.mu.Unlock()
		return cp
	}
	d.mu.Unlock()

	res := make(map[string]*string, len(schemes))
	for _, s := range schemes {
		res[s] = nil
	}

	switch normalizeLocalPlatform(d.platform()) {
	case "darwin":
		schemesJSON, _ := json.Marshal(schemes)
		script := strings.Join([]string{
			"ObjC.import('AppKit');",
			"var ws = $.NSWorkspace.sharedWorkspace; var out = {};",
			fmt.Sprintf("%s.forEach(function (s) {", string(schemesJSON)),
			"  var url = $.NSURL.URLWithString(s + '://import');",
			"  var app = url.isNil() ? null : ws.URLForApplicationToOpenURL(url);",
			"  out[s] = app && !app.isNil() ? ObjC.unwrap(app.path) : null;",
			"});",
			"JSON.stringify(out);",
		}, "\n")
		out := strings.TrimSpace(d.runCmd(ctx, "osascript", []string{"-l", "JavaScript", "-e", script}))
		if out != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(out), &parsed); err == nil {
				for _, s := range schemes {
					if raw, ok := parsed[s].(string); ok {
						res[s] = macAppName(raw)
					}
				}
			}
		}
	case "win32":
		quoted := make([]string, 0, len(schemes))
		for _, s := range schemes {
			quoted = append(quoted, "'"+strings.ReplaceAll(s, "'", "''")+"'")
		}
		script := strings.Join([]string{
			"$r = @{}",
			fmt.Sprintf("foreach ($s in @(%s)) {", strings.Join(quoted, ",")),
			`  $k = "Registry::HKEY_CLASSES_ROOT\$s\shell\open\command"`,
			`  $v = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).'(default)'`,
			"  $r[$s] = $v",
			"}",
			"$r | ConvertTo-Json -Compress",
		}, "\n")
		out := strings.TrimSpace(d.runCmd(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Command", script}))
		if out != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(out), &parsed); err == nil {
				for _, s := range schemes {
					if raw, ok := parsed[s].(string); ok {
						res[s] = windowsAppName(raw)
					}
				}
			}
		}
	case "linux":
		var wg sync.WaitGroup
		var outMu sync.Mutex
		for _, s := range schemes {
			wg.Add(1)
			go func(scheme string) {
				defer wg.Done()
				out := strings.TrimSpace(d.runCmd(ctx, "xdg-mime", []string{"query", "default", "x-scheme-handler/" + scheme}))
				if out != "" {
					val := strings.TrimSuffix(out, ".desktop")
					if val != "" {
						outMu.Lock()
						res[scheme] = &val
						outMu.Unlock()
					}
				}
			}(s)
		}
		wg.Wait()
	}

	d.mu.Lock()
	d.cacheKey = key
	d.cachedAt = d.now()
	d.cachedRes = make(map[string]*string, len(res))
	for k, v := range res {
		d.cachedRes[k] = v
	}
	d.mu.Unlock()
	return res
}

func normalizeLocalPlatform(p string) string {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "darwin", "macos":
		return "darwin"
	case "windows", "win32":
		return "win32"
	case "linux":
		return "linux"
	default:
		return strings.ToLower(strings.TrimSpace(p))
	}
}

// LocalSourceCandidate 描述从本机代理客户端配置中扫描到的订阅候选。
type LocalSourceCandidate struct {
	ID                 string `json:"id"`
	ClientID           string `json:"clientId"`
	ClientName         string `json:"clientName"`
	Name               string `json:"name"`
	URL                string `json:"url"`
	File               string `json:"file"`
	UpdatedAt          int64  `json:"updatedAt,omitempty"`
	Imported           bool   `json:"imported"`
	ImportedSourceID   string `json:"importedSourceId"`
	ImportedSourceName string `json:"importedSourceName"`
}

// LocalClientScanSummary 描述单个客户端插件的扫描概要。
type LocalClientScanSummary struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Found int    `json:"found"`
	Error string `json:"error"`
}

// LocalScanResult 描述本机代理客户端配置的扫描响应。
type LocalScanResult struct {
	OK         bool                     `json:"ok"`
	Platform   string                   `json:"platform"`
	Clients    []LocalClientScanSummary `json:"clients"`
	Candidates []LocalSourceCandidate   `json:"candidates"`
}

// SubscriptionURLKey 生成用于去重与比对已导入订阅源的规范化 URL 键。
func SubscriptionURLKey(raw string) string {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.User != nil || u.Host == "" {
		return ""
	}
	hostname := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	host := hostname
	if strings.Contains(hostname, ":") && port != "" {
		host = "[" + hostname + "]:" + port
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	} else if port != "" {
		host = hostname + ":" + port
	}
	pathPart := strings.TrimRight(u.EscapedPath(), "/")
	type kv struct{ k, v string }
	var params []kv
	for k, vals := range u.Query() {
		if strings.EqualFold(k, "name") {
			continue
		}
		for _, v := range vals {
			params = append(params, kv{k: k, v: v})
		}
	}
	sort.Slice(params, func(i, j int) bool {
		if params[i].k != params[j].k {
			return params[i].k < params[j].k
		}
		return params[i].v < params[j].v
	})
	base := fmt.Sprintf("%s://%s%s", scheme, host, pathPart)
	if len(params) == 0 {
		return base
	}
	q := url.Values{}
	for _, p := range params {
		q.Add(p.k, p.v)
	}
	return base + "?" + q.Encode()
}

// DisplayNameFromURL 从订阅地址的 name 查询参数或主机名提取可读显示名称。
func DisplayNameFromURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "订阅"
	}
	if named := strings.TrimSpace(u.Query().Get("name")); named != "" {
		return named
	}
	host := strings.TrimPrefix(u.Hostname(), "www.")
	if host == "" {
		return "订阅"
	}
	return host
}

func normalizeCandidateURL(raw string) string {
	if SubscriptionURLKey(raw) == "" {
		return ""
	}
	return strings.TrimSpace(raw)
}

func createScanCandidate(clientID, clientName, rawName, rawURL, file string, updatedAt int64) (LocalSourceCandidate, bool) {
	u := normalizeCandidateURL(rawURL)
	if u == "" {
		return LocalSourceCandidate{}, false
	}
	name := strings.TrimSpace(rawName)
	if name == "" {
		name = DisplayNameFromURL(u)
	}
	name = truncateRunes(name, 64)
	return LocalSourceCandidate{
		ID:         clientID + ":" + u,
		ClientID:   clientID,
		ClientName: clientName,
		Name:       name,
		URL:        u,
		File:       file,
		UpdatedAt:  updatedAt,
	}, true
}

func readLimitedText(filePath string, limit int64) string {
	info, err := os.Stat(filePath)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return ""
	}
	b, err := os.ReadFile(filePath)
	if err != nil {
		return ""
	}
	return string(b)
}

type scannedFile struct {
	path    string
	name    string
	mtimeMs int64
}

func listClientFiles(dir string, pattern *regexp.Regexp) []scannedFile {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []scannedFile
	for _, e := range entries {
		if e.IsDir() || !pattern.MatchString(e.Name()) {
			continue
		}
		fp := filepath.Join(dir, e.Name())
		info, err := os.Stat(fp)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, scannedFile{
			path:    fp,
			name:    e.Name(),
			mtimeMs: info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].mtimeMs > out[j].mtimeMs
	})
	if len(out) > localScanMaxFilesLimit {
		out = out[:localScanMaxFilesLimit]
	}
	return out
}

func scanClashVergeCandidates(platform, home string, env map[string]string) []LocalSourceCandidate {
	const appDir = "io.github.clash-verge-rev.clash-verge-rev"
	var dir string
	switch platform {
	case "win32":
		if appData := strings.TrimSpace(env["APPDATA"]); appData != "" {
			dir = filepath.Join(appData, appDir)
		}
	case "darwin":
		if home != "" {
			dir = filepath.Join(home, "Library", "Application Support", appDir)
		}
	default:
		dataHome := strings.TrimSpace(env["XDG_DATA_HOME"])
		if dataHome == "" && home != "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		if dataHome != "" {
			dir = filepath.Join(dataHome, appDir)
		}
	}
	if dir == "" {
		return nil
	}
	text := readLimitedText(filepath.Join(dir, "profiles.yaml"), localScanMaxBytes)
	if text == "" {
		return nil
	}
	parsed, err := ParseYAML(text)
	if err != nil {
		return nil
	}
	doc, _ := parsed.(map[string]any)
	if doc == nil {
		return nil
	}
	rawItems, _ := doc["items"].([]any)
	var out []LocalSourceCandidate
	for _, raw := range rawItems {
		m, _ := raw.(map[string]any)
		if m == nil || toString(m["type"]) != "remote" {
			continue
		}
		u := toString(m["url"])
		if u == "" {
			continue
		}
		name := toString(m["name"])
		if name == "" {
			name = toString(m["file"])
		}
		updatedAt := int64(0)
		if sec, ok := toFloat(m["updated"]); ok && sec > 0 {
			updatedAt = int64(sec * 1000)
		}
		if c, ok := createScanCandidate("clash-verge", "Clash Verge Rev", name, u, filepath.Join(dir, "profiles", toString(m["file"])), updatedAt); ok {
			out = append(out, c)
		}
	}
	return out
}

func scanClashFamilyCandidates(platform, home string, env map[string]string) []LocalSourceCandidate {
	if home == "" {
		return nil
	}
	var dirs []string
	switch platform {
	case "darwin":
		dirs = []string{
			filepath.Join(home, ".config", "clash"),
			filepath.Join(home, ".config", "mihomo"),
			filepath.Join(home, "Library", "Application Support", "ClashX"),
			filepath.Join(home, "Library", "Application Support", "ClashX Meta"),
			filepath.Join(home, "Library", "Application Support", "FlClash"),
			filepath.Join(home, "Library", "Application Support", "mihomo-party"),
		}
	case "win32":
		if appData := strings.TrimSpace(env["APPDATA"]); appData != "" {
			dirs = []string{
				filepath.Join(appData, "FlClash"),
				filepath.Join(appData, "mihomo-party"),
				filepath.Join(appData, "clash-nyanpasu"),
				filepath.Join(home, ".config", "clash"),
			}
		} else {
			dirs = []string{filepath.Join(home, ".config", "clash")}
		}
	default:
		dataHome := strings.TrimSpace(env["XDG_DATA_HOME"])
		if dataHome == "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		configHome := strings.TrimSpace(env["XDG_CONFIG_HOME"])
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		dirs = []string{
			filepath.Join(configHome, "clash"),
			filepath.Join(configHome, "mihomo"),
			filepath.Join(dataHome, "FlClash"),
			filepath.Join(configHome, "FlClash"),
			filepath.Join(configHome, "mihomo-party"),
			filepath.Join(configHome, "clash-nyanpasu"),
		}
	}
	var out []LocalSourceCandidate
	seenURL := map[string]bool{}
	for _, dir := range dirs {
		for _, f := range listClientFiles(dir, clashFamilyExtRegex) {
			text := readLimitedText(f.path, localScanMaxBytes)
			if text == "" {
				continue
			}
			parsed, err := ParseYAML(text)
			if err != nil {
				continue
			}
			doc, _ := parsed.(map[string]any)
			if doc == nil {
				continue
			}
			providers, _ := doc["proxy-providers"].(map[string]any)
			for key, rawVal := range providers {
				pm, _ := rawVal.(map[string]any)
				if pm == nil {
					continue
				}
				u := toString(pm["url"])
				if u == "" {
					continue
				}
				name := toString(pm["name"])
				if name == "" {
					name = key
				}
				c, ok := createScanCandidate("clash-family", "Clash 系", name, u, f.path, 0)
				if !ok || seenURL[c.URL] {
					continue
				}
				seenURL[c.URL] = true
				out = append(out, c)
			}
		}
	}
	return out
}

func scanSurgeProfileURLs(text string) []string {
	var found []string
	if m := surgeManagedConfigRegex.FindStringSubmatch(text); len(m) >= 2 {
		found = append(found, m[1])
	}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if h := surgeSectionHeaderRegex.FindStringSubmatch(trimmed); len(h) >= 2 {
			section = strings.ToLower(strings.TrimSpace(h[1]))
			continue
		}
		if section != "proxy" && section != "proxy group" {
			continue
		}
		if inc := surgeIncludeRegex.FindStringSubmatch(trimmed); len(inc) >= 2 {
			found = append(found, inc[1])
		}
	}
	return found
}

func scanSurgeCandidates(platform, home string) []LocalSourceCandidate {
	if platform != "darwin" || home == "" {
		return nil
	}
	roots := []string{
		filepath.Join(home, "Library", "Application Support", "Surge", "Profiles"),
		filepath.Join(home, "Library", "Application Support", "com.nssurge.surge-mac", "Profiles"),
	}
	var dirs []string
	for _, root := range roots {
		dirs = append(dirs, root, filepath.Join(root, ".managed"))
	}
	var out []LocalSourceCandidate
	seenURL := map[string]bool{}
	for _, dir := range dirs {
		for _, f := range listClientFiles(dir, surgeExtRegex) {
			text := readLimitedText(f.path, localScanMaxBytes)
			if text == "" {
				continue
			}
			baseName := strings.TrimSuffix(f.name, filepath.Ext(f.name))
			for _, u := range scanSurgeProfileURLs(text) {
				c, ok := createScanCandidate("surge", "Surge", baseName, u, f.path, f.mtimeMs)
				if !ok || seenURL[c.URL] {
					continue
				}
				seenURL[c.URL] = true
				out = append(out, c)
			}
		}
	}
	return out
}

func scanV2RayNCandidates(platform, home string, env map[string]string) []LocalSourceCandidate {
	if platform != "win32" {
		return nil
	}
	appData := strings.TrimSpace(env["APPDATA"])
	if appData == "" && home != "" {
		appData = filepath.Join(home, "AppData", "Roaming")
	}
	if appData == "" {
		return nil
	}
	cfgPath := filepath.Join(appData, "v2rayN", "guiNConfig.json")
	text := readLimitedText(cfgPath, localV2RayNMaxBytes)
	if text == "" {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(text), &doc); err != nil {
		return nil
	}
	rawList, ok := doc["subItem"].([]any)
	if !ok {
		rawList, _ = doc["subscriptions"].([]any)
	}
	var out []LocalSourceCandidate
	seenURL := map[string]bool{}
	for _, raw := range rawList {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		u := toString(m["url"])
		if u == "" {
			continue
		}
		name := toString(m["remarks"])
		if name == "" {
			name = toString(m["name"])
		}
		c, ok := createScanCandidate("v2rayn", "v2rayN", name, u, cfgPath, 0)
		if !ok || seenURL[c.URL] {
			continue
		}
		seenURL[c.URL] = true
		out = append(out, c)
	}
	return out
}

// ScanLocalSources 只读扫描本机代理客户端配置文件中的远程订阅地址并去重。
func ScanLocalSources(platform, hostHomeDir string, env map[string]string) LocalScanResult {
	normPlatform := normalizeLocalPlatform(platform)
	if normPlatform == "" {
		normPlatform = normalizeLocalPlatform(runtime.GOOS)
	}
	if hostHomeDir == "" {
		hostHomeDir, _ = os.UserHomeDir()
	}

	type scannerSpec struct {
		id   string
		name string
		run  func() []LocalSourceCandidate
	}
	scanners := []scannerSpec{
		{id: "clash-verge", name: "Clash Verge Rev", run: func() []LocalSourceCandidate { return scanClashVergeCandidates(normPlatform, hostHomeDir, env) }},
		{id: "clash-family", name: "Clash 系", run: func() []LocalSourceCandidate { return scanClashFamilyCandidates(normPlatform, hostHomeDir, env) }},
		{id: "surge", name: "Surge", run: func() []LocalSourceCandidate { return scanSurgeCandidates(normPlatform, hostHomeDir) }},
		{id: "v2rayn", name: "v2rayN", run: func() []LocalSourceCandidate { return scanV2RayNCandidates(normPlatform, hostHomeDir, env) }},
	}

	seenKeys := map[string]bool{}
	candidates := make([]LocalSourceCandidate, 0)
	clients := make([]LocalClientScanSummary, 0, len(scanners))
	for _, sc := range scanners {
		list := sc.run()
		clients = append(clients, LocalClientScanSummary{
			ID:    sc.id,
			Name:  sc.name,
			Found: len(list),
			Error: "",
		})
		for _, c := range list {
			k := SubscriptionURLKey(c.URL)
			if k == "" || seenKeys[k] {
				continue
			}
			seenKeys[k] = true
			candidates = append(candidates, c)
		}
	}
	return LocalScanResult{
		OK:         true,
		Platform:   normPlatform,
		Clients:    clients,
		Candidates: candidates,
	}
}

// MarkImportedSources 对照已有订阅源标记每个扫描候选是否已导入。
func MarkImportedSources(candidates []LocalSourceCandidate, subs []Subscription) []LocalSourceCandidate {
	existingByKey := map[string]Subscription{}
	for _, s := range subs {
		if s.Kind == "local" || s.URL == nil || *s.URL == "" {
			continue
		}
		k := SubscriptionURLKey(*s.URL)
		if k != "" {
			if _, exists := existingByKey[k]; !exists {
				existingByKey[k] = s
			}
		}
	}
	out := make([]LocalSourceCandidate, len(candidates))
	for i, c := range candidates {
		item := c
		if existing, ok := existingByKey[SubscriptionURLKey(c.URL)]; ok {
			item.Imported = true
			item.ImportedSourceID = existing.ID
			item.ImportedSourceName = existing.Name
		}
		out[i] = item
	}
	return out
}
