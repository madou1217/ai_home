// Package webuiclientkeysapi 提供客户端 API Key 的只读/管理接口。
//
//	GET    /v1/management/webui/client-keys
//	POST   /v1/management/webui/client-keys
//	PATCH  /v1/management/webui/client-keys/{keyId}
//	DELETE /v1/management/webui/client-keys/{keyId}
//	POST   /v1/management/webui/client-keys/{keyId}/rotate
//	GET    /v1/management/webui/client-keys/stats
//
// 创建/轮换响应里的 secret 只出现一次；列表只给前缀与摘要无关的展示信息。
package webuiclientkeysapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	clientkeysapp "github.com/madou1217/ai_home/application/clientkeys"
	"github.com/madou1217/ai_home/application/clientkeystats"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/concurrency"
)

const (
	// CollectionPath 是 Key 集合路径。
	CollectionPath = "/v1/management/webui/client-keys"
	// StatsPath 是统计路径。
	StatsPath = CollectionPath + "/stats"
	// WebUICollectionPath / WebUIStatsPath 是浏览器别名（挂载层生成）。
	WebUICollectionPath = "/v1/management/webui/client-keys"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或服务端口。
var ErrInvalidDependencies = errors.New("客户端 API Key 接口依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// LimitStore 是账号并发覆盖的读写端口。
type LimitStore interface {
	ListAccountConcurrencyLimits(ctx context.Context) ([]concurrency.AccountLimit, error)
	SetAccountConcurrencyLimit(ctx context.Context, limit concurrency.AccountLimit) error
	DeleteAccountConcurrencyLimit(ctx context.Context, accountRef, modelID string) (bool, error)
}

// Dependencies 是 Handler 的构造参数。
type Dependencies struct {
	Authorizer Authorizer
	Keys       *clientkeysapp.Service
	Stats      *clientkeystats.Tracker
	AIHomeDir  string
	Limits     LimitStore
}

// Handler 提供 Key 管理、统计与并发预览。
type Handler struct {
	authorizer Authorizer
	keys       *clientkeysapp.Service
	stats      *clientkeystats.Tracker
	aiHomeDir  string
	limits     LimitStore
}

// NewHandler 创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Keys == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		keys:       dependencies.Keys,
		stats:      dependencies.Stats,
		aiHomeDir:  dependencies.AIHomeDir,
		limits:     dependencies.Limits,
	}, nil
}

type limitsView struct {
	MaxConcurrency   int      `json:"maxConcurrency"`
	RPMLimit         int      `json:"rpmLimit"`
	TPMLimit         int      `json:"tpmLimit"`
	DailyTokenLimit  int      `json:"dailyTokenLimit"`
	AllowedProviders []string `json:"allowedProviders,omitempty"`
	AllowedModels    []string `json:"allowedModels,omitempty"`
}

type keyView struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Prefix         string     `json:"prefix"`
	Enabled        bool       `json:"enabled"`
	Master         bool       `json:"master"`
	CreatedAtMS    int64      `json:"createdAtMs"`
	UpdatedAtMS    int64      `json:"updatedAtMs"`
	LastUsedAtMS   int64      `json:"lastUsedAtMs"`
	Limits         limitsView `json:"limits"`
	LimitsEnforced bool       `json:"limitsEnforced"`
}

type liveView struct {
	InFlight int64   `json:"inFlight"`
	RPM1m    float64 `json:"rpm1m"`
	RPM5m    float64 `json:"rpm5m"`
	TPM1m    float64 `json:"tpm1m"`
	TPM5m    float64 `json:"tpm5m"`
}

type totalsView struct {
	Requests              int64 `json:"requests"`
	AbortedRequests       int64 `json:"abortedRequests"`
	Attempts              int64 `json:"attempts"`
	Successes             int64 `json:"successes"`
	Failures              int64 `json:"failures"`
	Aborted               int64 `json:"aborted"`
	InputTokens           int64 `json:"inputTokens"`
	OutputTokens          int64 `json:"outputTokens"`
	CachedInputTokens     int64 `json:"cachedInputTokens"`
	CacheWriteInputTokens int64 `json:"cacheWriteInputTokens"`
	ReasoningTokens       int64 `json:"reasoningTokens"`
	TotalTokens           int64 `json:"totalTokens"`
}

type keyStatsView struct {
	keyView
	Live   liveView   `json:"live"`
	Totals totalsView `json:"totals"`
}

type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeCollection 处理集合的 GET/POST。
func (handler *Handler) ServeCollection(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.list(response, request)
	case http.MethodPost:
		handler.create(response, request)
	default:
		response.Header().Set("Allow", "GET, POST")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// ServeMember 处理单把 Key 的 PATCH/DELETE。
func (handler *Handler) ServeMember(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	keyID := strings.TrimSpace(request.PathValue("keyId"))
	switch request.Method {
	case http.MethodPatch:
		handler.update(response, request, keyID)
	case http.MethodDelete:
		handler.revoke(response, request, keyID)
	default:
		response.Header().Set("Allow", "PATCH, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// ServeRotate 处理密钥轮换。
func (handler *Handler) ServeRotate(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", "POST")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	keyID := strings.TrimSpace(request.PathValue("keyId"))
	secret, err := handler.keys.Rotate(request.Context(), keyID)
	if err != nil {
		handler.writeKeyError(response, err)
		return
	}
	key, err := handler.keys.Get(request.Context(), keyID)
	if err != nil {
		handler.writeKeyError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"key":    viewOf(key),
		"secret": secret,
	})
}

// ServeStats 返回统计（可带 keyId 过滤）。
func (handler *Handler) ServeStats(response http.ResponseWriter, request *http.Request) {
	if !handler.authorize(response, request) {
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if handler.stats == nil {
		writeError(response, http.StatusServiceUnavailable, "stats_unavailable")
		return
	}
	query, err := statsQueryFromRequest(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_query")
		return
	}
	attempts, err := handler.stats.QueryAttempts(request.Context(), query)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "stats_read_failed")
		return
	}
	requests, err := handler.stats.QueryRequests(request.Context(), query)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "stats_read_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":             true,
		"generatedAt":    time.Now().UnixMilli(),
		"granularity":    query.Granularity,
		"attempts":       attempts,
		"requests":       requests,
		"live":           handler.stats.Live(),
		"limitsEnforced": false,
	})
}

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	keys, err := handler.keys.List(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "list_client_keys_failed")
		return
	}
	liveByKey := map[string]liveView{}
	totalsByKey := map[string]totalsView{}
	if handler.stats != nil {
		for _, row := range handler.stats.Live() {
			liveByKey[row.KeyID] = liveView{
				InFlight: row.InFlight, RPM1m: row.RPM1m, RPM5m: row.RPM5m,
				TPM1m: row.TPM1m, TPM5m: row.TPM5m,
			}
		}
		from := time.Now().Add(-24 * time.Hour)
		attemptRows, _ := handler.stats.QueryAttempts(request.Context(), clientkeystats.Query{
			Granularity: coreclientkeys.GranularityHour, From: from, To: time.Now(),
		})
		requestRows, _ := handler.stats.QueryRequests(request.Context(), clientkeystats.Query{
			Granularity: coreclientkeys.GranularityHour, From: from, To: time.Now(),
		})
		for _, row := range attemptRows {
			totals := totalsByKey[row.KeyID]
			totals.Attempts += row.Attempts
			totals.Successes += row.Successes
			totals.Failures += row.Failures
			totals.Aborted += row.Aborted
			totals.InputTokens += row.InputTokens
			totals.OutputTokens += row.OutputTokens
			totals.TotalTokens += row.TotalTokens
			totalsByKey[row.KeyID] = totals
		}
		for _, row := range requestRows {
			totals := totalsByKey[row.KeyID]
			totals.Requests += row.Requests
			totals.AbortedRequests += row.Aborted
			totalsByKey[row.KeyID] = totals
		}
	}
	master := keyView{
		ID: coreclientkeys.MasterKeyID, Name: "master", Enabled: true, Master: true,
	}
	views := []keyStatsView{{
		keyView: master,
		Live:    liveByKey[coreclientkeys.MasterKeyID],
		Totals:  totalsByKey[coreclientkeys.MasterKeyID],
	}}
	for _, key := range keys {
		views = append(views, keyStatsView{
			keyView: viewOf(key),
			Live:    liveByKey[key.ID],
			Totals:  totalsByKey[key.ID],
		})
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "keys": views})
}

func (handler *Handler) create(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name   string     `json:"name"`
		Limits limitsView `json:"limits"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 1<<20)).Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload")
		return
	}
	key, secret, err := handler.keys.Create(request.Context(), payload.Name, coreOf(payload.Limits))
	if err != nil {
		handler.writeKeyError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, map[string]any{
		"ok":     true,
		"key":    viewOf(key),
		"secret": secret,
	})
}

func (handler *Handler) update(response http.ResponseWriter, request *http.Request, keyID string) {
	var payload struct {
		Name    *string     `json:"name"`
		Enabled *bool       `json:"enabled"`
		Limits  *limitsView `json:"limits"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 1<<20)).Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload")
		return
	}
	key, err := handler.keys.Update(request.Context(), keyID, func(key *coreclientkeys.Key) error {
		if payload.Name != nil {
			trimmed := strings.TrimSpace(*payload.Name)
			if trimmed == "" {
				return clientkeysapp.ErrInvalidName
			}
			key.Name = trimmed
		}
		if payload.Enabled != nil {
			key.Enabled = *payload.Enabled
		}
		if payload.Limits != nil {
			key.Limits = coreOf(*payload.Limits)
		}
		return nil
	})
	if err != nil {
		handler.writeKeyError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "key": viewOf(key)})
}

func (handler *Handler) revoke(response http.ResponseWriter, request *http.Request, keyID string) {
	if err := handler.keys.Revoke(request.Context(), keyID); err != nil {
		handler.writeKeyError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "id": keyID})
}

func (handler *Handler) writeKeyError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, clientkeysapp.ErrNotFound):
		writeError(response, http.StatusNotFound, "client_key_not_found")
	case errors.Is(err, clientkeysapp.ErrInvalidName):
		writeError(response, http.StatusBadRequest, "invalid_client_key_name")
	case errors.Is(err, clientkeysapp.ErrMasterCollision):
		writeError(response, http.StatusConflict, "client_key_collision")
	default:
		writeError(response, http.StatusInternalServerError, "client_key_failed")
	}
}

func (handler *Handler) authorize(response http.ResponseWriter, request *http.Request) bool {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func viewOf(key coreclientkeys.Key) keyView {
	return keyView{
		ID: key.ID, Name: key.Name, Prefix: key.Prefix, Enabled: key.Enabled,
		CreatedAtMS: key.CreatedAtMS, UpdatedAtMS: key.UpdatedAtMS,
		LastUsedAtMS: key.LastUsedAtMS,
		Limits: limitsView{
			MaxConcurrency: key.Limits.MaxConcurrency, RPMLimit: key.Limits.RPMLimit,
			TPMLimit: key.Limits.TPMLimit, DailyTokenLimit: key.Limits.DailyTokenLimit,
			AllowedProviders: key.Limits.AllowedProviders, AllowedModels: key.Limits.AllowedModels,
		},
		LimitsEnforced: false,
	}
}

func coreOf(view limitsView) coreclientkeys.Limits {
	return coreclientkeys.Limits{
		MaxConcurrency: view.MaxConcurrency, RPMLimit: view.RPMLimit,
		TPMLimit: view.TPMLimit, DailyTokenLimit: view.DailyTokenLimit,
		AllowedProviders: view.AllowedProviders, AllowedModels: view.AllowedModels,
	}
}

func statsQueryFromRequest(request *http.Request) (clientkeystats.Query, error) {
	query := clientkeystats.Query{
		Granularity: request.URL.Query().Get("granularity"),
		KeyID:       strings.TrimSpace(request.URL.Query().Get("key")),
		ProviderID:  strings.TrimSpace(request.URL.Query().Get("provider")),
		ModelID:     strings.TrimSpace(request.URL.Query().Get("model")),
		AccountRef:  strings.TrimSpace(request.URL.Query().Get("account")),
	}
	if raw := strings.TrimSpace(request.URL.Query().Get("from")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return clientkeystats.Query{}, err
		}
		query.From = time.UnixMilli(value)
	}
	if raw := strings.TrimSpace(request.URL.Query().Get("to")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return clientkeystats.Query{}, err
		}
		query.To = time.UnixMilli(value)
	}
	return query, nil
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, map[string]any{"ok": false, "error": code})
}
