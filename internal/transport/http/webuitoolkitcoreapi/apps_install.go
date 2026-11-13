package webuitoolkitcoreapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
)

func (h *Handler) handleAppsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	opts := h.appsOpts
	if r.URL.Query().Get("refresh") == "1" {
		opts.RefreshInventory = true
	}
	writeJSON(w, http.StatusOK, h.appsMgr.ListManagedApps(r.Context(), opts))
}

func (h *Handler) handleAppConfig(w http.ResponseWriter, r *http.Request) {
	appID := strings.TrimSpace(r.PathValue("appId"))
	editOpts := configedit.Options{
		Catalog:     h.catalog,
		HostHomeDir: h.hostHomeDir,
		GOOS:        h.appsOpts.Platform,
		Env:         h.appsOpts.Env,
		Exec:        h.executor,
	}
	switch r.Method {
	case http.MethodGet:
		data, err := configedit.ReadAppConfig(r.Context(), appID, editOpts)
		if err != nil {
			writeConfigError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, data)

	case http.MethodPut:
		var body struct {
			Content  *string `json:"content"`
			Revision string  `json:"revision"`
		}
		if ok, status, errMsg := decodeJSONBody(w, r, configBodyMaxBytes, &body); !ok {
			writeError(w, status, errMsg, errMsg)
			return
		}
		if body.Content == nil {
			writeError(w, http.StatusBadRequest, "content_required", "必须提供配置文本内容")
			return
		}
		editOpts.ExpectedRevision = body.Revision
		data, err := configedit.SaveAppConfig(r.Context(), appID, *body.Content, editOpts)
		if err != nil {
			writeConfigError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, data)

	default:
		writeMethodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

func (h *Handler) handleAppCheckUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	appID := strings.TrimSpace(r.PathValue("appId"))
	refreshed := h.appsMgr.RefreshManagedAppVersion(r.Context(), appID, h.appsOpts)
	if !refreshed.OK || refreshed.App == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"ok":    false,
			"error": "app_not_found",
			"appId": appID,
		})
		return
	}
	result := h.appsMgr.CheckManagedAppUpdate(r.Context(), *refreshed.App, h.appsOpts)
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) handleAppOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	appID := strings.TrimSpace(r.PathValue("appId"))
	var body struct {
		Kind       string `json:"kind"`
		Action     string `json:"action"`
		AccountRef string `json:"accountRef"`
		Unscoped   bool   `json:"unscoped"`
		Provider   string `json:"provider"`
		TerminalID string `json:"terminalId"`
		Transport  string `json:"transport"`
		SessionKey string `json:"sessionKey"`
		Model      string `json:"model"`
		Workdir    string `json:"workdir"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}

	normAppID := strings.ToLower(appID)
	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	if kind == "" {
		if strings.HasSuffix(normAppID, "-desktop") {
			kind = "desktop"
		} else {
			kind = "cli"
		}
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	if action == "" {
		action = "open"
	}
	provider := strings.ToLower(strings.TrimSpace(body.Provider))
	if kind == "desktop" && strings.HasSuffix(normAppID, "-desktop") {
		provider = strings.TrimSuffix(normAppID, "-desktop")
	} else if provider == "" {
		provider = normAppID
	}

	selectedAccountRef := ""
	if !body.Unscoped {
		selectedAccountRef = strings.TrimSpace(body.AccountRef)
		if selectedAccountRef == "" && h.defaultAccount != nil {
			selectedAccountRef = strings.TrimSpace(h.defaultAccount(r.Context(), provider))
		}
	}

	// 未绑定账号（显式 unscoped 或无默认账号）且目标为 Desktop 时，由 Go 直接完成本机拉起（含 Claude-3p 网关准备）。
	if selectedAccountRef == "" && kind == "desktop" {
		res := apps.OpenManagedDesktopApp(r.Context(), normAppID, h.appsOpts)
		if res.OK {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":         true,
				"status":     res.Status,
				"appId":      res.AppID,
				"provider":   provider,
				"accountRef": "",
				"kind":       kind,
				"executable": res.Executable,
			})
			return
		}
		h.writeAppOpenFailure(w, appID, provider, kind, webuiopenappapi.Result{
			Error:   res.Error,
			Message: res.Message,
		})
		return
	}

	// 绑定账号或 CLI 启动：透传给 HostLauncher（覆盖账号投影与 zcode 出口代理等宿主机行为）。
	if h.appLauncher == nil {
		writeError(w, http.StatusNotImplemented, "launch_unavailable", "宿主机应用启动执行器未配置")
		return
	}
	transport := strings.ToLower(strings.TrimSpace(body.Transport))
	sessionKey := strings.TrimSpace(body.SessionKey)
	if kind == "cli" && transport == "webui" && sessionKey == "" {
		sessionKey = fmt.Sprintf("aih-term:%s:%s", selectedAccountRef, provider)
	}
	launchRes, err := h.appLauncher.Launch(r.Context(), webuiopenappapi.Request{
		Provider:    provider,
		AccountRef:  selectedAccountRef,
		Kind:        kind,
		Action:      action,
		Harness:     provider,
		HarnessKind: "native",
		Model:       strings.TrimSpace(body.Model),
		TerminalID:  strings.TrimSpace(body.TerminalID),
		Workdir:     strings.TrimSpace(body.Workdir),
		Transport:   transport,
		SessionKey:  sessionKey,
		AIHomeDir:   h.aiHomeDir,
		HostHomeDir: h.hostHomeDir,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "launch_host_unavailable", err.Error())
		return
	}
	if launchRes.OK {
		payload := map[string]any{
			"ok":         true,
			"status":     launchRes.Status,
			"provider":   provider,
			"accountRef": selectedAccountRef,
			"kind":       kind,
		}
		if launchRes.PID != nil {
			payload["pid"] = *launchRes.PID
		}
		if launchRes.TerminalID != "" {
			payload["terminalId"] = launchRes.TerminalID
		}
		if launchRes.SessionKey != "" {
			payload["sessionKey"] = launchRes.SessionKey
		}
		if launchRes.LaunchMode != "" {
			payload["launchMode"] = launchRes.LaunchMode
		}
		if launchRes.Executable != "" {
			payload["executable"] = launchRes.Executable
		}
		if len(launchRes.PIDs) > 0 {
			payload["pids"] = launchRes.PIDs
		}
		if launchRes.EgressWarning != "" {
			payload["egressWarning"] = launchRes.EgressWarning
		}
		writeJSON(w, http.StatusOK, payload)
		return
	}
	h.writeAppOpenFailure(w, appID, provider, kind, launchRes)
}

func (h *Handler) writeAppOpenFailure(w http.ResponseWriter, appID, provider, kind string, res webuiopenappapi.Result) {
	if res.Error == "desktop_not_installed" || res.Error == "cli_not_installed" {
		targetAppID := provider
		if kind == "desktop" {
			if strings.HasSuffix(strings.ToLower(appID), "-desktop") {
				targetAppID = strings.ToLower(appID)
			} else {
				targetAppID = provider + "-desktop"
			}
		}
		installTarget := map[string]any{
			"appId":    targetAppID,
			"provider": provider,
			"kind":     kind,
			"action":   "install",
		}
		installAvailable := h.appInstallJobs.CanInstall(apps.InstallInput{
			AppID:    targetAppID,
			Provider: provider,
			Kind:     kind,
			Action:   "install",
		})
		msg := res.Message
		if msg == "" {
			if installAvailable {
				if kind == "desktop" {
					msg = "未检测到 Desktop 应用，请确认后开始安装。"
				} else {
					msg = "未检测到原生 CLI，请确认后开始安装。"
				}
			} else {
				if kind == "desktop" {
					msg = "当前平台没有可用的自动安装器，请手动安装官方 Desktop 应用后重试。"
				} else {
					msg = "当前 Provider 没有可用的自动安装器，请手动安装原生 CLI 后重试。"
				}
			}
		}
		writeJSON(w, http.StatusPreconditionRequired, map[string]any{
			"ok":               false,
			"error":            res.Error,
			"appId":            appID,
			"provider":         provider,
			"installRequired":  true,
			"installTarget":    installTarget,
			"installAvailable": installAvailable,
			"message":          msg,
		})
		return
	}

	status := http.StatusConflict
	switch res.Error {
	case "unsupported_app", "unsupported_kind", "unsupported_provider":
		status = http.StatusBadRequest
	case "account_not_found":
		status = http.StatusNotFound
	case "agy_desktop_process_probe_failed", "codebuddy_desktop_keychain_unavailable",
		"account_egress_unavailable", "zcode_egress_unavailable", "launch_host_unavailable":
		status = http.StatusServiceUnavailable
	case "zcode_native_proxy_settings_failed",
		"account_egress_binding_unavailable", "zcode_egress_binding_unavailable":
		status = http.StatusInternalServerError
	}
	payload := map[string]any{
		"ok":      false,
		"error":   res.Error,
		"message": fallbackAppOpenMessage(res.Error, res.Message),
	}
	if res.EgressWarning != "" {
		payload["egressWarning"] = res.EgressWarning
	}
	writeJSON(w, status, payload)
}

func fallbackAppOpenMessage(code, existing string) string {
	if strings.TrimSpace(existing) != "" {
		return existing
	}
	switch code {
	case "account_unconfigured":
		return "该账号尚未完成配置，未启动应用。"
	case "account_auth_invalid":
		return "该账号的授权已失效，请重新授权后再打开。"
	case "desktop_not_installed":
		return "未检测到 Desktop 应用。"
	case "cli_not_installed":
		return "未检测到原生 CLI。"
	case "terminal_not_found":
		return "未找到可用的终端。"
	case "workdir_not_found":
		return "所选项目目录不存在或不是文件夹，未启动 CLI。"
	default:
		return code
	}
}

type installActionDTO struct {
	AppID         string  `json:"appId"`
	Provider      string  `json:"provider"`
	ProviderID    string  `json:"providerId"`
	Kind          string  `json:"kind"`
	Action        *string `json:"action"`
	InstalledPath string  `json:"installedPath"`
}

func (dto installActionDTO) toInstallInput(requireApp bool) (apps.InstallInput, string) {
	appID := strings.TrimSpace(dto.AppID)
	prov := strings.TrimSpace(dto.Provider)
	if prov == "" {
		prov = strings.TrimSpace(dto.ProviderID)
	}
	if appID == "" {
		appID = prov
	}
	if requireApp && appID == "" {
		return apps.InstallInput{}, "app_required"
	}
	action := ""
	if dto.Action != nil {
		if strings.TrimSpace(*dto.Action) == "" {
			action = " "
		} else {
			action = *dto.Action
		}
	}
	return apps.InstallInput{
		AppID:         appID,
		Provider:      prov,
		Kind:          dto.Kind,
		Action:        action,
		InstalledPath: dto.InstalledPath,
	}, ""
}

func (h *Handler) handleAppsInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body installActionDTO
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	input, errCode := body.toInstallInput(true)
	if errCode != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errCode})
		return
	}
	started := h.appInstallJobs.Start(r.Context(), input)
	if !started.OK {
		errOut := started.Error
		if errOut == "" {
			errOut = "app_install_unavailable"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errOut})
		return
	}
	writeJSON(w, http.StatusAccepted, started)
}

func (h *Handler) handleAppsPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body installActionDTO
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	input, errCode := body.toInstallInput(true)
	if errCode != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errCode})
		return
	}
	plan := h.appInstallJobs.Plan(input)
	status := http.StatusOK
	if !plan.OK {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, plan)
}

func (h *Handler) handleAppsHooks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		Providers []string `json:"providers"`
		Provider  string   `json:"provider"`
		Action    string   `json:"action"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	providersList := body.Providers
	if len(providersList) == 0 && strings.TrimSpace(body.Provider) != "" {
		providersList = []string{body.Provider}
	}
	if len(providersList) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "providers_required"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	if action == "" {
		action = "install"
	}
	switch action {
	case "install":
		writeJSON(w, http.StatusOK, h.appsMgr.InstallAppHooks(r.Context(), providersList, h.appsOpts))
	case "uninstall":
		writeJSON(w, http.StatusOK, h.appsMgr.UninstallAppHooks(r.Context(), providersList, h.appsOpts))
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_hook_action"})
	}
}

func (h *Handler) handleAppInstallCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body installActionDTO
	if ok, _, _ := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, http.StatusBadRequest, "invalid_install_payload", "安装目标参数无效。")
		return
	}
	input, _ := body.toInstallInput(false)
	started := h.appInstallJobs.Start(r.Context(), input)
	if !started.OK {
		writeError(w, http.StatusBadRequest, started.Error, "无法创建安装任务。")
		return
	}
	writeJSON(w, http.StatusAccepted, started)
}

func (h *Handler) handleAppInstallJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"jobs": h.appInstallJobs.ListActive(),
	})
}

func (h *Handler) handleAppInstallJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	job := h.appInstallJobs.Get(jobID)
	if job == nil {
		writeError(w, http.StatusNotFound, "job_not_found", "安装任务不存在或已清理。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "job": job})
}

func (h *Handler) handleAppInstallJobCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	res := h.appInstallJobs.Cancel(jobID)
	if !res.OK {
		status := http.StatusConflict
		if res.Error == "job_not_found" {
			status = http.StatusNotFound
		}
		msg := res.Error
		if res.Job != nil && res.Job.Error != "" {
			msg = res.Job.Error
		}
		writeError(w, status, res.Error, msg)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
