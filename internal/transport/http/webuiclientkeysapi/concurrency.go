package webuiclientkeysapi

// 并发限流的配置预览与账号覆盖读写。
//
// 本轮不执行拦截：effective 值只用于 UI 展示与下一轮实现对齐；enforced 恒为 false。

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/admission"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/concurrency"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

// ServeEffectiveConcurrency 返回某个 provider/账号/模型/Key 组合的生效值预览。
func (handler *Handler) ServeEffectiveConcurrency(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	config, err := handler.loadConcurrencyConfig(request)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "concurrency_config_unavailable")
		return
	}
	limits := []concurrency.AccountLimit{}
	if handler.limits != nil {
		if loaded, loadErr := handler.limits.ListAccountConcurrencyLimits(request.Context()); loadErr == nil {
			limits = loaded
		}
	}
	query := request.URL.Query()
	provider := strings.TrimSpace(query.Get("provider"))
	accountRef := strings.TrimSpace(query.Get("account"))
	model := strings.TrimSpace(query.Get("model"))
	accountMax := config.AccountConcurrency(provider, accountRef, model, limits)
	keyMax := 0
	if keyID := strings.TrimSpace(query.Get("key")); keyID != "" && keyID != coreclientkeys.MasterKeyID {
		if key, getErr := handler.keys.Get(request.Context(), keyID); getErr == nil {
			keyMax = config.KeyConcurrency(key.Limits.MaxConcurrency)
		}
	}
	effective := config.ClampToSystem(accountMax)
	if keyMax > 0 && (effective <= 0 || keyMax < effective) {
		effective = keyMax
	}
	providerDefault := config.ProviderDefaults[strings.ToLower(provider)]
	live := admission.Observe(provider, accountRef, model)
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                 true,
		"enforced":           true,
		"systemMax":          config.SystemMax,
		"accountMax":         accountMax,
		"keyMax":             keyMax,
		"providerDefault":    providerDefault,
		"accountDefault":     config.AccountDefault,
		"effective":          effective,
		"queueLimit":         config.QueueLimit,
		"queueWaitTimeoutMs": config.QueueWaitTimeoutMS,
		"retryAfterSeconds":  config.RetryAfterSeconds,
		"inFlight": map[string]any{
			"system":  live.SystemInFlight,
			"account": live.AccountInFlight,
			"model":   live.ModelInFlight,
		},
	})
}

// ServeAccountConcurrency 读写账号/账号+模型的并发覆盖。
func (handler *Handler) ServeAccountConcurrency(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	if handler.limits == nil {
		writeError(response, http.StatusServiceUnavailable, "limits_unavailable")
		return
	}
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account")
		return
	}
	switch request.Method {
	case http.MethodGet:
		limits, err := handler.limits.ListAccountConcurrencyLimits(request.Context())
		if err != nil {
			writeError(response, http.StatusInternalServerError, "limits_read_failed")
			return
		}
		filtered := make([]concurrency.AccountLimit, 0, len(limits))
		for _, limit := range limits {
			if limit.AccountRef == accountRef {
				filtered = append(filtered, limit)
			}
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "limits": filtered})
	case http.MethodPut:
		var payload struct {
			ModelID        string `json:"modelId"`
			MaxConcurrency int    `json:"maxConcurrency"`
			RPMLimit       int    `json:"rpmLimit"`
			TPMLimit       int    `json:"tpmLimit"`
			Delete         bool   `json:"delete"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 1<<20)).Decode(&payload); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_payload")
			return
		}
		if payload.Delete {
			if _, err := handler.limits.DeleteAccountConcurrencyLimit(request.Context(), accountRef, payload.ModelID); err != nil {
				writeError(response, http.StatusInternalServerError, "limits_write_failed")
				return
			}
			writeJSON(response, http.StatusOK, map[string]any{"ok": true, "deleted": true})
			return
		}
		if payload.MaxConcurrency < 0 || payload.RPMLimit < 0 || payload.TPMLimit < 0 {
			writeError(response, http.StatusBadRequest, "invalid_limits")
			return
		}
		limit := concurrency.AccountLimit{
			AccountRef:     accountRef,
			ModelID:        strings.TrimSpace(payload.ModelID),
			MaxConcurrency: payload.MaxConcurrency,
			RPMLimit:       payload.RPMLimit,
			TPMLimit:       payload.TPMLimit,
		}
		if err := handler.limits.SetAccountConcurrencyLimit(request.Context(), limit); err != nil {
			writeError(response, http.StatusInternalServerError, "limits_write_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "limit": limit})
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func (handler *Handler) loadConcurrencyConfig(request *http.Request) (concurrency.Config, error) {
	if strings.TrimSpace(handler.aiHomeDir) == "" {
		return concurrency.Default(), nil
	}
	view, err := webuiserverconfigapi.ReadFullConfig(request.Context(), handler.aiHomeDir)
	if err != nil {
		return concurrency.Config{}, err
	}
	return concurrency.ParseConfig(view.Concurrency)
}
