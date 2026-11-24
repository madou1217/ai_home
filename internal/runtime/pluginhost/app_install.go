package pluginhost

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/appinstall"
)

// AppInstallCapability 是插件式应用安装的能力名。
const AppInstallCapability = "app.install"

const (
	appInstallDescribeTimeout  = 10 * time.Second
	appInstallStatusTimeout    = 5 * time.Second
	appInstallInstallTimeout   = 30 * time.Minute
	appInstallUninstallTimeout = 5 * time.Minute
	appInstallOpenTimeout      = 30 * time.Second
	appInstallDefaultTimeout   = 10 * time.Second
	appInstallStatusTTL        = 30 * time.Second

	maxAppInstallPayload     = 256 * 1024
	maxAppInstallApps        = 32
	maxAppInstallContribs    = 32
	maxAppInstallSteps       = 32
	maxAppInstallOutputLines = 40
	maxAppInstallText        = 512
)

var (
	appInstallAppIDPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	appInstallProviderPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	appInstallURLSecretRE     = regexp.MustCompile(`(?i)(https?://)[^/\s@]+@`)
)

// appInstallActionTimeout 给长耗时生命周期动作留出预算；状态探测仍快速失败。
func appInstallActionTimeout(action string) time.Duration {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "install", "update":
		return appInstallInstallTimeout
	case "uninstall":
		return appInstallUninstallTimeout
	case "open", "close":
		return appInstallOpenTimeout
	default:
		return appInstallDefaultTimeout
	}
}

// Apps 返回当前代次的应用声明快照；不触发 RPC。
func (s *Service) Apps() []appinstall.App {
	if s == nil {
		return nil
	}
	s.appInstallMu.Lock()
	defer s.appInstallMu.Unlock()
	if len(s.appInstallApps) == 0 {
		return nil
	}
	out := make([]appinstall.App, len(s.appInstallApps))
	copy(out, s.appInstallApps)
	for index := range out {
		out[index].Platforms = append([]string(nil), out[index].Platforms...)
	}
	return out
}

// Snapshot 返回最近一次状态缓存的副本；不触发 RPC。
func (s *Service) Snapshot() map[string]appinstall.Status {
	if s == nil {
		return map[string]appinstall.Status{}
	}
	s.appInstallMu.Lock()
	defer s.appInstallMu.Unlock()
	out := make(map[string]appinstall.Status, len(s.appInstallStatus))
	for key, value := range s.appInstallStatus {
		out[key] = value
	}
	return out
}

// Refresh 刷新 app.install 声明与状态。单飞；30 秒内复用状态缓存。
func (s *Service) Refresh(ctx context.Context) error {
	if s == nil || s.runtime == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.appInstallMu.Lock()
	if s.appInstallRefreshing {
		done := s.appInstallRefreshDone
		s.appInstallMu.Unlock()
		if done == nil {
			return nil
		}
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.appInstallRefreshing = true
	done := make(chan struct{})
	s.appInstallRefreshDone = done
	s.appInstallMu.Unlock()
	defer func() {
		s.appInstallMu.Lock()
		s.appInstallRefreshing = false
		s.appInstallRefreshDone = nil
		close(done)
		s.appInstallMu.Unlock()
	}()
	return s.refreshAppInstall(ctx)
}

func (s *Service) refreshAppInstall(ctx context.Context) error {
	lease := s.runtime.Acquire()
	if lease == nil {
		s.clearAppInstallCache()
		return pluginerr.New("plugin_runtime_inactive", "当前没有已发布的插件代次")
	}
	defer lease.Release()

	now := time.Now()
	s.appInstallMu.Lock()
	fresh := s.appInstallGeneration == lease.Generation &&
		len(s.appInstallApps) > 0 &&
		!s.appInstallStatusAt.IsZero() &&
		now.Sub(s.appInstallStatusAt) < appInstallStatusTTL
	s.appInstallMu.Unlock()
	if fresh {
		return nil
	}

	apps, describeErr := s.describeAppInstallApps(ctx, lease)
	if describeErr != nil && len(apps) == 0 {
		return describeErr
	}
	statuses := s.readAppInstallStatus(ctx, lease, apps)

	s.appInstallMu.Lock()
	s.appInstallGeneration = lease.Generation
	s.appInstallApps = apps
	s.appInstallStatus = statuses
	s.appInstallStatusAt = time.Now()
	s.appInstallMu.Unlock()
	return describeErr
}

func (s *Service) clearAppInstallCache() {
	s.appInstallMu.Lock()
	s.appInstallGeneration = 0
	s.appInstallApps = nil
	s.appInstallStatus = map[string]appinstall.Status{}
	s.appInstallStatusAt = time.Time{}
	s.appInstallMu.Unlock()
}

type rawAppInstallApp struct {
	AppID        string   `json:"appId"`
	Provider     string   `json:"provider"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Platforms    []string `json:"platforms"`
	Order        int      `json:"order"`
	Capabilities struct {
		Install      bool   `json:"install"`
		Update       bool   `json:"update"`
		Uninstall    bool   `json:"uninstall"`
		Open         bool   `json:"open"`
		AccountScope bool   `json:"accountScope"`
		OpenMode     string `json:"openMode"`
	} `json:"capabilities"`
	Install struct {
		RequiresConfirmation bool  `json:"requiresConfirmation"`
		RequiresAdmin        bool  `json:"requiresAdmin"`
		DownloadBytes        int64 `json:"downloadBytes"`
	} `json:"install"`
	Uninstall struct {
		RemovesUserData bool `json:"removesUserData"`
	} `json:"uninstall"`
	Open struct {
		Mode string `json:"mode"`
	} `json:"open"`
}

type rawAppInstallDescriptor struct {
	Apps []rawAppInstallApp `json:"apps"`
}

func (s *Service) describeAppInstallApps(ctx context.Context, lease *Lease) ([]appinstall.App, error) {
	chain := lease.Snapshot.Projection.ByCapability(AppInstallCapability)
	if len(chain) > maxAppInstallContribs {
		chain = chain[:maxAppInstallContribs]
	}
	apps := make([]appinstall.App, 0, len(chain))
	seen := make(map[string]struct{}, len(chain))
	var firstErr error
	for _, item := range chain {
		raw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID,
			map[string]any{"schemaVersion": 1, "kind": "describe"}, appInstallDescribeTimeout)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if len(raw) > maxAppInstallPayload {
			if firstErr == nil {
				firstErr = pluginerr.New("app_install_payload_too_large", "应用描述超过大小限制")
			}
			continue
		}
		var response rawAppInstallDescriptor
		if err := json.Unmarshal(raw, &response); err != nil {
			if firstErr == nil {
				firstErr = pluginerr.New("app_install_descriptor_invalid", "应用 describe 返回值不是合法 JSON")
			}
			continue
		}
		for _, descriptor := range response.Apps {
			app, err := normalizeAppInstallDescriptor(descriptor)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			if _, exists := seen[app.AppID]; exists {
				if firstErr == nil {
					firstErr = pluginerr.New("app_install_duplicate", "重复的应用 id："+app.AppID)
				}
				continue
			}
			seen[app.AppID] = struct{}{}
			app.PluginID = item.InstanceID
			app.ContributionID = item.ID
			app.Generation = lease.Generation
			if len(apps) >= maxAppInstallApps {
				break
			}
			apps = append(apps, app)
		}
		if len(apps) >= maxAppInstallApps {
			break
		}
	}
	if firstErr != nil && len(apps) > 0 {
		// 单个插件失败不拖垮其余声明；Doctor 会单独显示该插件的诊断。
		s.logAppInstall("app.install describe 部分失败: " + firstErr.Error())
	}
	return apps, firstErr
}

func normalizeAppInstallDescriptor(raw rawAppInstallApp) (appinstall.App, error) {
	appID := strings.ToLower(strings.TrimSpace(raw.AppID))
	if !appInstallAppIDPattern.MatchString(appID) {
		return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "应用 id 非法："+raw.AppID)
	}
	provider := strings.ToLower(strings.TrimSpace(raw.Provider))
	if provider != "" && !appInstallProviderPattern.MatchString(provider) {
		return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "应用 Provider 非法："+raw.Provider)
	}
	kind := appinstall.Kind(strings.ToLower(strings.TrimSpace(raw.Kind)))
	switch kind {
	case appinstall.KindDesktop, appinstall.KindIDE, appinstall.KindCLI:
	default:
		return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "应用类型非法："+raw.Kind)
	}
	platforms := make([]string, 0, len(raw.Platforms))
	seenPlatform := map[string]bool{}
	for _, value := range raw.Platforms {
		platform := strings.ToLower(strings.TrimSpace(value))
		if platform != "macos" && platform != "windows" && platform != "linux" {
			return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "应用平台非法："+value)
		}
		if seenPlatform[platform] {
			continue
		}
		seenPlatform[platform] = true
		platforms = append(platforms, platform)
	}
	openMode := strings.ToLower(strings.TrimSpace(firstNonEmpty(raw.Open.Mode, raw.Capabilities.OpenMode, "plugin")))
	if openMode != "plugin" && openMode != "host" {
		return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "open.mode 必须是 plugin 或 host")
	}
	capabilities := appinstall.Capabilities{
		Install:      raw.Capabilities.Install,
		Update:       raw.Capabilities.Update,
		Uninstall:    raw.Capabilities.Uninstall,
		Open:         raw.Capabilities.Open,
		AccountScope: raw.Capabilities.AccountScope,
		OpenMode:     openMode,
	}
	if !capabilities.Install && !capabilities.Update && !capabilities.Uninstall && !capabilities.Open {
		return appinstall.App{}, pluginerr.New("app_install_descriptor_invalid", "应用未声明任何生命周期能力")
	}
	downloadBytes := raw.Install.DownloadBytes
	if downloadBytes < 0 {
		downloadBytes = 0
	}
	return appinstall.App{
		AppID:        appID,
		Provider:     provider,
		Name:         firstNonEmpty(sanitizeAppInstallText(raw.Name, 160), appID),
		Kind:         kind,
		Platforms:    platforms,
		Order:        raw.Order,
		Capabilities: capabilities,
		Install: appinstall.InstallHint{
			RequiresConfirmation: raw.Install.RequiresConfirmation,
			RequiresAdmin:        raw.Install.RequiresAdmin,
			DownloadBytes:        downloadBytes,
		},
		UninstallRemovesUserData: raw.Uninstall.RemovesUserData,
	}, nil
}

type rawAppInstallStatus struct {
	AppID           string `json:"appId"`
	Installed       bool   `json:"installed"`
	State           string `json:"state"`
	Version         string `json:"version"`
	Executable      string `json:"executable"`
	Running         bool   `json:"running"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

func (s *Service) readAppInstallStatus(ctx context.Context, lease *Lease, apps []appinstall.App) map[string]appinstall.Status {
	statuses := make(map[string]appinstall.Status, len(apps))
	if len(apps) == 0 {
		return statuses
	}
	declared := make(map[string]bool, len(apps))
	byContribution := map[string][]string{}
	for _, app := range apps {
		declared[app.AppID] = true
		byContribution[app.ContributionID] = append(byContribution[app.ContributionID], app.AppID)
	}
	for _, item := range lease.Snapshot.Projection.ByCapability(AppInstallCapability) {
		appIDs := byContribution[item.ID]
		if len(appIDs) == 0 {
			continue
		}
		raw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": 1,
			"kind":          "status",
			"appIds":        appIDs,
		}, appInstallStatusTimeout)
		if err != nil {
			s.logAppInstall("app.install status 失败: " + err.Error())
			continue
		}
		if len(raw) > maxAppInstallPayload {
			continue
		}
		var response struct {
			Apps []rawAppInstallStatus `json:"apps"`
		}
		if err := json.Unmarshal(raw, &response); err != nil {
			s.logAppInstall("app.install status 返回非法 JSON")
			continue
		}
		for _, item := range response.Apps {
			status, err := normalizeAppInstallStatus(item)
			if err != nil {
				s.logAppInstall("app.install status 非法: " + err.Error())
				continue
			}
			if status.AppID == "" || !declared[status.AppID] {
				continue
			}
			statuses[status.AppID] = status
		}
	}
	return statuses
}

func normalizeAppInstallStatus(raw rawAppInstallStatus) (appinstall.Status, error) {
	appID := strings.ToLower(strings.TrimSpace(raw.AppID))
	if appID == "" || !appInstallAppIDPattern.MatchString(appID) {
		return appinstall.Status{}, pluginerr.New("app_install_status_invalid", "状态缺少合法 appId")
	}
	status := appinstall.Status{
		AppID:           appID,
		Installed:       raw.Installed,
		State:           strings.ToLower(strings.TrimSpace(raw.State)),
		Version:         sanitizeAppInstallText(raw.Version, 96),
		Running:         raw.Running,
		UpdateAvailable: raw.UpdateAvailable,
	}
	executable, ok := normalizeAppInstallExecutable(raw.Executable)
	if !ok {
		status.Installed = false
		status.State = "invalid"
	} else {
		status.Executable = executable
	}
	if status.State == "" {
		if status.Installed {
			status.State = "installed"
		} else {
			status.State = "missing"
		}
	}
	return status, nil
}

func normalizeAppInstallExecutable(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", true
	}
	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", false
		}
		value = filepath.Join(home, value[2:])
	}
	if !filepath.IsAbs(value) {
		return "", false
	}
	if _, err := os.Stat(value); err != nil {
		return "", false
	}
	return filepath.Clean(value), true
}

// Operate 执行 app.install 生命周期动作。
func (s *Service) Operate(ctx context.Context, request appinstall.OperateRequest) (appinstall.OperateResult, error) {
	if s == nil || s.runtime == nil {
		return appinstall.OperateResult{}, pluginerr.New("plugin_runtime_inactive", "插件运行时不可用")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	appID := strings.ToLower(strings.TrimSpace(request.AppID))
	action := strings.ToLower(strings.TrimSpace(request.Action))
	if appID == "" || action == "" {
		return appinstall.OperateResult{}, pluginerr.New("app_install_operation_unsupported", "appId 与 action 必填")
	}
	if err := s.Refresh(ctx); err != nil && len(s.Apps()) == 0 {
		return appinstall.OperateResult{}, err
	}
	var app *appinstall.App
	for _, item := range s.Apps() {
		if item.AppID == appID {
			copy := item
			app = &copy
			break
		}
	}
	if app == nil {
		return appinstall.OperateResult{}, pluginerr.New("app_install_operation_unsupported", "未知应用："+appID)
	}
	if !app.SupportsPlatform(appinstall.CurrentPlatform()) {
		return appinstall.OperateResult{}, pluginerr.New("app_install_operation_unsupported", "当前平台不支持该应用")
	}
	if !app.SupportsAction(action) {
		return appinstall.OperateResult{}, pluginerr.New("app_install_operation_unsupported", "应用未声明该动作："+action)
	}
	if appinstall.RequiresConfirmation(action) && !request.Confirmed {
		return appinstall.OperateResult{}, pluginerr.New("app_install_confirmation_required", "该操作需要明确确认")
	}
	proxyURL, err := validateAppInstallProxy(request.ProxyURL)
	if err != nil {
		return appinstall.OperateResult{}, err
	}
	payload := map[string]any{
		"schemaVersion": 1,
		"kind":          "operate",
		"appId":         app.AppID,
		"action":        action,
		"platform":      appinstall.CurrentPlatform(),
		"arch":          appinstall.CurrentArch(),
	}
	if proxyURL != "" {
		payload["proxyUrl"] = proxyURL
	}
	if jobID := strings.TrimSpace(request.JobID); jobID != "" {
		payload["jobId"] = jobID
	}
	started := time.Now()
	raw, invokeErr := s.runtime.Invoke(ctx, app.Generation, app.ContributionID, payload, appInstallActionTimeout(action))
	durationMs := time.Since(started).Milliseconds()
	if invokeErr != nil {
		s.Audit("app.install.operate", map[string]any{
			"appId": app.AppID, "action": action, "ok": false,
			"durationMs": durationMs, "error": firstNonEmpty(errorCode(invokeErr), "invoke_failed"),
		})
		return appinstall.OperateResult{}, invokeErr
	}
	if len(raw) > maxAppInstallPayload {
		return appinstall.OperateResult{}, pluginerr.New("app_install_payload_too_large", "应用操作结果超过大小限制")
	}
	result, decodeErr := decodeAppInstallOperateResult(raw)
	if decodeErr != nil {
		s.Audit("app.install.operate", map[string]any{
			"appId": app.AppID, "action": action, "ok": false,
			"durationMs": durationMs, "error": firstNonEmpty(errorCode(decodeErr), "invalid_result"),
		})
		return appinstall.OperateResult{}, decodeErr
	}
	if result.Status != nil {
		s.appInstallMu.Lock()
		if s.appInstallStatus == nil {
			s.appInstallStatus = map[string]appinstall.Status{}
		}
		s.appInstallStatus[result.Status.AppID] = *result.Status
		s.appInstallStatusAt = time.Now()
		s.appInstallMu.Unlock()
	}
	s.Audit("app.install.operate", map[string]any{
		"appId": app.AppID, "action": action, "ok": result.OK,
		"changed": result.Changed, "durationMs": durationMs,
	})
	return result, nil
}

func decodeAppInstallOperateResult(raw json.RawMessage) (appinstall.OperateResult, error) {
	var response struct {
		OK      bool                 `json:"ok"`
		Changed bool                 `json:"changed"`
		Message string               `json:"message"`
		PID     int                  `json:"pid"`
		Status  *rawAppInstallStatus `json:"status"`
		Steps   []struct {
			ID    string `json:"id"`
			Label string `json:"label"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		} `json:"steps"`
		Output   []string `json:"output"`
		Progress *struct {
			Percent int    `json:"percent"`
			Label   string `json:"label"`
		} `json:"progress"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return appinstall.OperateResult{}, pluginerr.New("app_install_operation_invalid", "应用操作返回值不是合法 JSON")
	}
	result := appinstall.OperateResult{
		OK:      response.OK,
		Changed: response.Changed,
		Message: sanitizeAppInstallText(response.Message, maxAppInstallText),
		PID:     response.PID,
	}
	if result.Message == "" && !result.OK {
		result.Message = "应用操作失败"
	}
	if response.Status != nil {
		status, err := normalizeAppInstallStatus(*response.Status)
		if err != nil {
			return appinstall.OperateResult{}, err
		}
		result.Status = &status
	}
	for _, step := range response.Steps {
		if len(result.Steps) >= maxAppInstallSteps {
			break
		}
		result.Steps = append(result.Steps, appinstall.Step{
			ID:    sanitizeAppInstallText(step.ID, 96),
			Label: sanitizeAppInstallText(step.Label, 160),
			OK:    step.OK,
			Error: sanitizeAppInstallText(step.Error, maxAppInstallText),
		})
	}
	for _, line := range response.Output {
		if len(result.Output) >= maxAppInstallOutputLines {
			break
		}
		if text := sanitizeAppInstallOutput(line); text != "" {
			result.Output = append(result.Output, text)
		}
	}
	if response.Progress != nil {
		percent := response.Progress.Percent
		if percent < 0 {
			percent = 0
		}
		if percent > 100 {
			percent = 100
		}
		result.Progress = &appinstall.Progress{
			Percent: percent,
			Label:   sanitizeAppInstallText(response.Progress.Label, 160),
		}
	}
	return result, nil
}

func validateAppInstallProxy(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.Host == "" {
		return "", pluginerr.New("app_install_proxy_invalid", "代理地址非法")
	}
	if strings.ToLower(parsed.Scheme) != "http" || parsed.User != nil {
		return "", pluginerr.New("app_install_proxy_invalid", "代理只允许无认证 loopback HTTP")
	}
	host := strings.Trim(parsed.Hostname(), "[]")
	if !(strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1") {
		return "", pluginerr.New("app_install_proxy_invalid", "代理必须是 loopback 地址")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", pluginerr.New("app_install_proxy_invalid", "代理地址不能带查询串或片段")
	}
	return value, nil
}

func sanitizeAppInstallText(value string, maxRunes int) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '	' {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"authorization:", "bearer ", "token=", "token:", "secret=", "secret:", "password=", "password:", "private_key=", "privatekey="} {
		if strings.Contains(lower, marker) {
			return "[敏感信息已隐藏]"
		}
	}
	runes := []rune(value)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes])
	}
	return value
}

func sanitizeAppInstallOutput(value string) string {
	text := sanitizeAppInstallText(value, maxAppInstallText)
	if text == "" || text == "[敏感信息已隐藏]" {
		return text
	}
	text = appInstallURLSecretRE.ReplaceAllString(text, "$1[凭据已隐藏]@")
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		text = strings.ReplaceAll(text, home, "~")
	}
	return text
}

func (s *Service) scheduleAppInstallRefresh() {
	if s == nil || s.runtime == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = s.Refresh(ctx)
	}()
}

func (s *Service) logAppInstall(message string) {
	if s == nil || s.onLog == nil {
		return
	}
	s.onLog(message)
}
