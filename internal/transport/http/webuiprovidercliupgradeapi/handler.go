// Package webuiprovidercliupgradeapi 提供 provider CLI 自动升级账本的只读投影。
//
// 账本是 <aiHomeDir>/run/provider-cli-upgrade.json；调度器运行态仍在 Node，
// Node 拿到本响应后合并 scheduler 与 lastResult。
package webuiprovidercliupgradeapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// Path 是 provider CLI 升级状态的管理契约。
	Path = "/v1/management/webui/provider-cli-upgrade"

	schemaVersion = 1
	historyLimit  = 5
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("provider CLI 升级接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Catalog    *providers.Catalog
}

// Handler 处理升级状态读取。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	catalog    *providers.Catalog
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" || dependencies.Catalog == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, aiHomeDir: strings.TrimSpace(dependencies.AIHomeDir), catalog: dependencies.Catalog}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "provider_cli_upgrade_unavailable", "升级状态服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	writeJSON(response, http.StatusOK, Snapshot(handler.aiHomeDir, handler.catalog))
}

// Snapshot 返回与 GET 完全一致的账本投影。
//
// 解除熔断接口会把它原样嵌进响应的 status 字段；两处必须同一份投影，
// 否则「解除后刷新」会看到两套互相矛盾的口径。
func Snapshot(aiHomeDir string, catalog *providers.Catalog) map[string]any {
	ledger := readLedger(aiHomeDir)
	providers := collectProviders(catalog, ledger)
	rows := make([]map[string]any, 0, len(providers))
	for _, provider := range providers {
		rows = append(rows, projectProvider(provider, ledger))
	}
	return map[string]any{
		"ok": true, "scheduler": nil,
		"global": map[string]any{
			"enabled":        ledgerGlobalEnabled(ledger),
			"disabledReason": text(object(ledger["global"])["disabledReason"]),
		},
		"providers": rows,
	}
}

func readLedger(aiHomeDir string) map[string]any {
	path := filepath.Join(aiHomeDir, "run", "provider-cli-upgrade.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return emptyLedger()
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil || number(decoded["schemaVersion"]) != schemaVersion {
		return emptyLedger()
	}
	global := object(decoded["global"])
	providers := object(decoded["providers"])
	return map[string]any{"global": global, "providers": providers}
}

func emptyLedger() map[string]any {
	return map[string]any{"global": map[string]any{"enabled": true, "disabledReason": ""}, "providers": map[string]any{}}
}

func collectProviders(catalog *providers.Catalog, ledger map[string]any) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, definition := range catalog.List() {
		if definition.CLI == nil || strings.TrimSpace(definition.CLI.Package) == "" {
			continue
		}
		if _, exists := seen[definition.ID]; exists {
			continue
		}
		seen[definition.ID] = struct{}{}
		result = append(result, definition.ID)
	}
	for provider := range object(ledger["providers"]) {
		if _, exists := seen[provider]; exists {
			continue
		}
		seen[provider] = struct{}{}
		result = append(result, provider)
	}
	return result
}

var defaultRecord = map[string]any{
	"state": "unknown", "channel": "", "ownerPath": "", "resolvedPath": "",
	"installedVersion": "", "latestVersion": "", "targetVersion": "", "knownGoodVersion": "",
	"knownGoodRollbackable": false, "baselineHealthy": nil, "userPin": "", "enabled": true,
	"disabledReason": "", "blockedVersions": []any{}, "shadowedNpmInstall": false,
	"lastCheckAt": int64(0), "lastCheckError": "", "soakUnknownCount": int64(0),
	"lastApplyAt": int64(0), "lastApplyError": "", "consecutiveFailures": int64(0),
	"consecutiveDefers": int64(0), "consecutiveQuiescentTicks": int64(0),
	"lastDeferReason": "", "history": []any{},
}

func projectProvider(provider string, ledger map[string]any) map[string]any {
	record := map[string]any{}
	for key, value := range defaultRecord {
		record[key] = value
	}
	stored := object(object(ledger["providers"])[provider])
	for key, value := range stored {
		record[key] = value
	}
	blocked := stringList(record["blockedVersions"])
	history := anyList(record["history"])
	limit := len(history)
	if limit > historyLimit {
		limit = historyLimit
	}
	latest := text(record["latestVersion"])
	installed := text(record["installedVersion"])
	updateAvailable := latest != "" && installed != "" && latest != installed && !contains(blocked, latest)
	channel := text(record["channel"])
	return map[string]any{
		"provider": provider, "state": text(record["state"]), "channel": channel,
		"pinnable":         channel != "" && channelPinnable(channel, provider),
		"enabled":          record["enabled"] != false,
		"disabledReason":   text(record["disabledReason"]),
		"installedVersion": installed, "latestVersion": latest,
		"targetVersion": text(record["targetVersion"]), "knownGoodVersion": text(record["knownGoodVersion"]),
		"knownGoodRollbackable": record["knownGoodRollbackable"] == true,
		"baselineHealthy":       record["baselineHealthy"],
		"updateAvailable":       updateAvailable,
		"blockedVersions":       blocked,
		"shadowedNpmInstall":    record["shadowedNpmInstall"] == true,
		"resolvedPath":          text(record["resolvedPath"]),
		"lastCheckAt":           number(record["lastCheckAt"]), "lastCheckError": text(record["lastCheckError"]),
		"lastApplyAt": number(record["lastApplyAt"]), "lastApplyError": text(record["lastApplyError"]),
		"lastDeferReason":           text(record["lastDeferReason"]),
		"consecutiveFailures":       number(record["consecutiveFailures"]),
		"consecutiveDefers":         number(record["consecutiveDefers"]),
		"consecutiveQuiescentTicks": number(record["consecutiveQuiescentTicks"]),
		"soakUnknownCount":          number(record["soakUnknownCount"]),
		"lastTickState":             "", "lastTickReason": "",
		// 与 Node 局部投影一致：lastTick 由 Node 合并后再填。
		"history": history[len(history)-limit:],
	}
}

func channelPinnable(channel string, provider string) bool {
	switch channel {
	case "standalone_release", "npm_global":
		return true
	case "vendor_selfupdate":
		return provider == "claude" || provider == "opencode"
	default:
		return false
	}
}
