// Package appcatalog 枚举本机可启动的应用，并支持按应用实例挂载代理。
//
// 代理挂载的语义是「只影响这一次启动的进程」：不修改系统代理，也不复用
// 已有实例。macOS 通过 open -n 启动独立实例；Chromium 系浏览器再附加
// --proxy-server 与独立的 user-data-dir，普通应用用 --env 注入代理环境变量。
package appcatalog

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// App 是一个本机可启动应用的公开描述。
type App struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	BundleID string `json:"bundleId,omitempty"`
	// Chromium 表示支持 --proxy-server 的 Chromium 系浏览器。
	Chromium bool `json:"chromium,omitempty"`
}

// LaunchOptions 描述一次启动。
type LaunchOptions struct {
	// ProxyURL 非空时只给本次启动的进程挂代理（例如 http://127.0.0.1:6152）。
	ProxyURL string
	// ProfileDir 供 Chromium 系浏览器隔离实例；为空时按应用名与代理端口派生。
	ProfileDir string
	// ExtraArgs 追加到应用参数（仅 Chromium 系 + ProxyURL 时生效）。
	ExtraArgs []string
}

// ErrNoMatch 表示没有找到应用。
var ErrNoMatch = errors.New("没有匹配的本机应用")

// ErrAmbiguous 表示查询命中多个应用，调用方应让用户选择。
var ErrAmbiguous = errors.New("匹配到多个本机应用")

// List 返回当前平台可启动的应用（按名称去重、排序）。
func List() ([]App, error) {
	var apps []App
	var err error
	switch runtime.GOOS {
	case "darwin":
		apps, err = listDarwinApps()
	case "linux":
		apps, err = listLinuxApps()
	case "windows":
		apps, err = listWindowsApps()
	default:
		apps, err = nil, nil
	}
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(apps))
	out := make([]App, 0, len(apps))
	for _, app := range apps {
		key := strings.ToLower(app.Path)
		if app.ID == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, app)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Resolve 按名称/id/路径做大小写不敏感匹配；精确命中优先，其次唯一前缀，最后子串。
func Resolve(query string) (App, error) {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return App{}, ErrNoMatch
	}
	apps, err := List()
	if err != nil {
		return App{}, err
	}
	lower := strings.ToLower(trimmed)
	var exact, prefix, contains []App
	for _, app := range apps {
		name := strings.ToLower(app.Name)
		switch {
		case name == lower || strings.ToLower(app.ID) == lower || strings.ToLower(app.Path) == lower:
			exact = append(exact, app)
		case strings.HasPrefix(name, lower):
			prefix = append(prefix, app)
		case strings.Contains(name, lower):
			contains = append(contains, app)
		}
	}
	for _, group := range [][]App{exact, prefix, contains} {
		if len(group) == 1 {
			return group[0], nil
		}
		if len(group) > 1 {
			return App{}, ErrAmbiguous
		}
	}
	return App{}, ErrNoMatch
}

// Launch 启动应用；ProxyURL 非空时只把代理注入本次启动的进程。
func Launch(app App, options LaunchOptions) error {
	proxyURL := strings.TrimSpace(options.ProxyURL)
	switch runtime.GOOS {
	case "darwin":
		return launchDarwin(app, proxyURL, options)
	case "windows":
		return launchWindows(app, proxyURL)
	default:
		return launchLinux(app, proxyURL)
	}
}

// ProxyEnv 返回一次启动应注入的代理环境变量（空代理返回 nil）。
func ProxyEnv(proxyURL string) map[string]string {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" {
		return nil
	}
	return map[string]string{
		"HTTP_PROXY":  proxyURL,
		"HTTPS_PROXY": proxyURL,
		"ALL_PROXY":   proxyURL,
		"NO_PROXY":    "127.0.0.1,localhost,::1",
	}
}

func launchDarwin(app App, proxyURL string, options LaunchOptions) error {
	args := []string{"-n", "-a", app.Path}
	if proxyURL != "" {
		for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
			args = append(args, "--env", key+"="+ProxyEnv(proxyURL)[key])
		}
		if app.Chromium {
			profile := strings.TrimSpace(options.ProfileDir)
			if profile == "" {
				profile = defaultChromiumProfile(app, proxyURL)
			}
			if profile != "" {
				if err := os.MkdirAll(profile, 0o700); err == nil {
					args = append(args, "--args", "--proxy-server="+proxyURL, "--user-data-dir="+profile)
					args = append(args, options.ExtraArgs...)
				}
			}
		}
	} else {
		args = append(args, options.ExtraArgs...)
	}
	command := exec.Command("/usr/bin/open", args...)
	if output, err := command.CombinedOutput(); err != nil {
		return errors.New("启动应用失败: " + strings.TrimSpace(string(output)))
	}
	return nil
}

func launchWindows(app App, proxyURL string) error {
	command := exec.Command("cmd", "/c", "start", "", app.Path)
	command.Env = os.Environ()
	for key, value := range ProxyEnv(proxyURL) {
		command.Env = append(command.Env, key+"="+value)
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Wait()
}

func launchLinux(app App, proxyURL string) error {
	command := exec.Command(app.Path)
	command.Env = os.Environ()
	for key, value := range ProxyEnv(proxyURL) {
		command.Env = append(command.Env, key+"="+value)
	}
	return command.Start()
}

func defaultChromiumProfile(app App, proxyURL string) string {
	home := strings.TrimSpace(os.Getenv("AIH_HOME_DIR"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = filepath.Join(userHome, ".ai_home")
	}
	port := "proxy"
	if index := strings.LastIndex(proxyURL, ":"); index >= 0 {
		port = strings.Trim(proxyURL[index+1:], "/")
	}
	slug := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(app.Name), " ", "-"))
	if slug == "" {
		slug = "app"
	}
	return filepath.Join(home, "run", "app-proxy", slug+"-"+port)
}

func listDarwinApps() ([]App, error) {
	home, _ := os.UserHomeDir()
	roots := []string{"/Applications", "/System/Applications", "/System/Applications/Utilities"}
	if home != "" {
		roots = append([]string{filepath.Join(home, "Applications")}, roots...)
	}
	var apps []App
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".app") {
				continue
			}
			path := filepath.Join(root, entry.Name())
			apps = append(apps, darwinApp(path))
		}
	}
	return apps, nil
}

func darwinApp(path string) App {
	name := strings.TrimSuffix(filepath.Base(path), ".app")
	app := App{ID: strings.ToLower(name), Name: name, Path: path, Chromium: isChromiumApp(name)}
	plist := filepath.Join(path, "Contents", "Info.plist")
	if id := readPlistString(plist, "CFBundleIdentifier"); id != "" {
		app.BundleID = id
		app.ID = id
	}
	if display := readPlistString(plist, "CFBundleDisplayName"); display != "" && !looksLikeKey(display) {
		app.Name = display
	}
	return app
}

func readPlistString(path, key string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	previous := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "<key>"+key+"</key>" {
			if scanner.Scan() {
				value := strings.TrimSpace(scanner.Text())
				value = strings.TrimPrefix(value, "<string>")
				value = strings.TrimSuffix(value, "</string>")
				return strings.TrimSpace(value)
			}
			return ""
		}
		if strings.Contains(line, "<"+key+">") && strings.Contains(line, "</"+key+">") {
			value := line[strings.Index(line, "<"+key+">")+len(key)+2 : strings.Index(line, "</"+key+">")]
			return strings.TrimSpace(value)
		}
		previous = line
	}
	_ = previous
	return ""
}

func looksLikeKey(value string) bool {
	return strings.HasPrefix(value, "$(") || value == "${EXECUTABLE_NAME}"
}

func isChromiumApp(name string) bool {
	lower := strings.ToLower(name)
	for _, marker := range []string{"chrome", "edge", "brave", "chromium", "vivaldi", "opera"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func listLinuxApps() ([]App, error) {
	roots := []string{"/usr/share/applications", "/usr/local/share/applications"}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".local", "share", "applications"))
	}
	var apps []App
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".desktop") {
				continue
			}
			path := filepath.Join(root, entry.Name())
			values := readDesktopEntry(path)
			name := strings.TrimSpace(values["Name"])
			execLine := strings.TrimSpace(values["Exec"])
			if name == "" || execLine == "" || values["NoDisplay"] == "true" || values["Type"] == "Link" {
				continue
			}
			binary := firstExecToken(execLine)
			if binary == "" {
				continue
			}
			apps = append(apps, App{ID: strings.TrimSuffix(entry.Name(), ".desktop"), Name: name, Path: binary, Chromium: isChromiumApp(name)})
		}
	}
	return apps, nil
}

func readDesktopEntry(path string) map[string]string {
	values := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return values
	}
	defer func() { _ = file.Close() }()
	inMain := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			inMain = line == "[Desktop Entry]"
			continue
		}
		if !inMain || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if found {
			values[key] = strings.ReplaceAll(value, "\\s", " ")
		}
	}
	return values
}

func firstExecToken(line string) string {
	for _, token := range strings.Fields(line) {
		if token == "" || strings.Contains(token, "%") {
			continue
		}
		return strings.Trim(token, "\"'")
	}
	return ""
}

func listWindowsApps() ([]App, error) {
	roots := []string{}
	if programData := strings.TrimSpace(os.Getenv("ProgramData")); programData != "" {
		roots = append(roots, filepath.Join(programData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		roots = append(roots, filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	var apps []App
	for _, root := range roots {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil || info.IsDir() {
				return nil
			}
			if strings.EqualFold(filepath.Ext(path), ".lnk") || strings.EqualFold(filepath.Ext(path), ".url") {
				name := strings.TrimSuffix(info.Name(), filepath.Ext(info.Name()))
				apps = append(apps, App{ID: strings.ToLower(name), Name: name, Path: path})
			}
			return nil
		})
	}
	return apps, nil
}
// DefaultProxyURL 返回本机应用代理应使用的地址：固定匿名入口 6152 优先，
// 其次读取常驻入口发布文件；入口文件可能是旧会话写的，因此先探测端口。
func DefaultProxyURL() string {
	defaultURL := "http://127.0.0.1:6152"
	if proxyURLReachable(defaultURL) {
		return defaultURL
	}
	home := strings.TrimSpace(os.Getenv("AIH_HOME_DIR"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return defaultURL
		}
		home = filepath.Join(userHome, ".ai_home")
	}
	raw, err := os.ReadFile(filepath.Join(home, "run", "proxy", "entry.json"))
	if err == nil {
		var entry struct {
			HTTPURL string `json:"httpUrl"`
		}
		if json.Unmarshal(raw, &entry) == nil && proxyURLReachable(entry.HTTPURL) {
			return strings.TrimSpace(entry.HTTPURL)
		}
	}
	return defaultURL
}

func proxyURLReachable(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	connection, err := net.DialTimeout("tcp", parsed.Host, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
