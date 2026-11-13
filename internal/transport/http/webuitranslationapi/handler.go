// Package webuitranslationapi 承接 AI 翻译页面的全部管理端 HTTP 与 SSE 路由：
//
//	OPTIONS /v1/management/webui/translation/{rest...}
//	GET     /v1/management/webui/translation/settings
//	POST    /v1/management/webui/translation/settings
//	GET     /v1/management/webui/translation/providers
//	POST    /v1/management/webui/translation/providers
//	GET     /v1/management/webui/translation/languages
//	POST    /v1/management/webui/translation/detect
//	GET     /v1/management/webui/translation/models
//	POST    /v1/management/webui/translation/stream
//
// 所有业务逻辑、SQLite 持久化、模型目录筛选、语种判定、HTTP 直连适配器与对冲网关流式执行
// 全部由 internal/runtime/translation 承担；Node 侧仅保留薄代理。
package webuitranslationapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

const (
	// Path 是 Go 管理端翻译接口的固定前缀。
	Path = "/v1/management/webui/translation"

	// MaxTranslationInputChars 限制单次翻译正文长度，对齐 Node MAX_TRANSLATION_INPUT_CHARS。
	MaxTranslationInputChars = 40000

	settingsBodyLimitBytes  = 64 * 1024
	providersBodyLimitBytes = 16 * 1024
	detectBodyLimitBytes    = 64 * 1024
	streamBodyLimitBytes    = 256 * 1024
)

// ErrInvalidDependencies 表示创建 Handler 时缺少核心依赖。
var ErrInvalidDependencies = errors.New("翻译接口依赖无效")

// Authorizer 校验 Management Key 授权状态。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总翻译 HTTP Handler 所需依赖。
type Dependencies struct {
	Authorizer   Authorizer
	AIHomeDir    string
	DatabasePath string
	Catalog      translation.CatalogDependencies
	Gateway      translation.GatewayConfig
	HTTPClient   translation.AdapterClient
	AdapterTime  time.Duration
	Now          func() time.Time
	// OnSettingsUpdated 在持久化保存翻译设置后触发（可选），用于扩展通知或本地状态刷新。
	OnSettingsUpdated func(translation.Settings)
}

// Handler 实现 /v1/management/webui/translation* 的路由分发与 SSE 响应。
type Handler struct {
	authorizer        Authorizer
	databasePath      string
	catalogDeps       translation.CatalogDependencies
	gateway           translation.GatewayConfig
	httpClient        translation.AdapterClient
	adapterTime       time.Duration
	now               func() time.Time
	onSettingsUpdated func(translation.Settings)
}

// NewHandler 创建并校验翻译接口处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	dbPath := strings.TrimSpace(deps.DatabasePath)
	if dbPath == "" && strings.TrimSpace(deps.AIHomeDir) != "" {
		if resolved, err := appstate.DatabasePath(strings.TrimSpace(deps.AIHomeDir)); err == nil {
			dbPath = resolved
		}
	}
	catalogDeps := deps.Catalog
	if catalogDeps.DatabasePath == "" {
		catalogDeps.DatabasePath = dbPath
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Handler{
		authorizer:        deps.Authorizer,
		databasePath:      dbPath,
		catalogDeps:       catalogDeps,
		gateway:           deps.Gateway,
		httpClient:        deps.HTTPClient,
		adapterTime:       deps.AdapterTime,
		now:               nowFn,
		onSettingsUpdated: deps.OnSettingsUpdated,
	}, nil
}

// ServeHTTP 按方法与子路径分派请求，并在允许的浏览器扩展来源下附加 CORS 头。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.authorizer == nil {
		writeTranslationError(w, r, http.StatusServiceUnavailable, "translation_unavailable", "翻译服务不可用", nil)
		return
	}

	if r.Method == http.MethodOptions {
		applyCorsHeaders(w.Header(), r)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeTranslationError(w, r, http.StatusUnauthorized, "unauthorized", "需要管理密钥", nil)
		return
	}

	subPath := strings.TrimPrefix(r.URL.Path, Path)
	if subPath == "" {
		subPath = "/"
	}

	switch {
	case subPath == "/settings" && r.Method == http.MethodGet:
		h.handleGetSettings(w, r)
	case subPath == "/settings" && r.Method == http.MethodPost:
		h.handlePostSettings(w, r)
	case subPath == "/providers" && r.Method == http.MethodGet:
		h.handleGetProviders(w, r)
	case subPath == "/providers" && r.Method == http.MethodPost:
		h.handlePostProviders(w, r)
	case subPath == "/languages" && r.Method == http.MethodGet:
		h.handleGetLanguages(w, r)
	case subPath == "/detect" && r.Method == http.MethodPost:
		h.handlePostDetect(w, r)
	case subPath == "/models" && r.Method == http.MethodGet:
		h.handleGetModels(w, r)
	case subPath == "/stream" && r.Method == http.MethodPost:
		h.handlePostStream(w, r)
	default:
		writeTranslationError(w, r, http.StatusNotFound, "translation_route_not_found", "未找到对应的翻译路由", nil)
	}
}

func (h *Handler) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if h.databasePath == "" {
		writeTranslationError(w, r, http.StatusServiceUnavailable, "translation_home_dir_unavailable", "数据目录不可用", nil)
		return
	}
	settings, err := translation.ReadSettings(r.Context(), h.databasePath)
	if err != nil {
		settings = nil
	}
	catalog, err := translation.BuildTranslationModelCatalog(r.Context(), h.catalogDeps, settings)
	if err != nil {
		catalog = translation.ModelCatalog{}
	}
	effectiveSettings := translation.DefaultSettings()
	if settings != nil {
		effectiveSettings = *settings
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":                   true,
		"settings":             effectiveSettings,
		"autoDetectedModel":    catalog.DefaultModel,
		"autoDetectedProvider": catalog.DefaultProvider,
	})
}

func (h *Handler) handlePostSettings(w http.ResponseWriter, r *http.Request) {
	if h.databasePath == "" {
		writeTranslationError(w, r, http.StatusServiceUnavailable, "translation_home_dir_unavailable", "数据目录不可用", nil)
		return
	}
	body, ok := readJSONObjectBody(w, r, settingsBodyLimitBytes)
	if !ok {
		return
	}
	updated, err := translation.WriteSettingsPatch(r.Context(), h.databasePath, body, h.now())
	if err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_settings_write_failed", "保存翻译设置失败")
		return
	}
	if h.onSettingsUpdated != nil {
		h.onSettingsUpdated(updated)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":       true,
		"settings": updated,
	})
}

func (h *Handler) handleGetProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := translation.ListProviderStatuses(r.Context(), h.databasePath)
	if err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_providers_read_failed", "读取翻译服务商配置失败")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":        true,
		"providers": providers,
	})
}

func (h *Handler) handlePostProviders(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSONObjectBody(w, r, providersBodyLimitBytes)
	if !ok {
		return
	}
	providerID, _ := body["provider"].(string)
	descriptor, found := translation.FindProviderDescriptor(providerID)
	if !found {
		writeTranslationError(w, r, http.StatusBadRequest, "translation_provider_unsupported", "请选择支持的翻译引擎", nil)
		return
	}
	var cfgPatch map[string]any
	if rawCfg, exists := body["config"]; exists {
		casted, isMap := rawCfg.(map[string]any)
		if !isMap && rawCfg != nil {
			writeTranslationError(w, r, http.StatusBadRequest, "translation_provider_config_invalid", "翻译服务商配置格式无效", nil)
			return
		}
		cfgPatch = casted
	}
	if _, err := translation.WriteProviderConfig(r.Context(), h.databasePath, descriptor, cfgPatch, h.now()); err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_provider_write_failed", "保存翻译服务商配置失败")
		return
	}
	providers, err := translation.ListProviderStatuses(r.Context(), h.databasePath)
	if err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_providers_read_failed", "读取翻译服务商配置失败")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":        true,
		"providers": providers,
	})
}

func (h *Handler) handleGetLanguages(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":        true,
		"languages": translation.ListLanguages(),
		"auto":      translation.AutoLanguage,
	})
}

func (h *Handler) handlePostDetect(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSONObjectBody(w, r, detectBodyLimitBytes)
	if !ok {
		return
	}
	rawText, _ := body["text"].(string)
	text := truncateRunes(rawText, translation.MaxDetectSampleRunes)
	detection := translation.DetectLanguage(text)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":         true,
		"code":       detection.Code,
		"label":      detection.Label,
		"confidence": detection.Confidence,
		"script":     detection.Script,
	})
}

func (h *Handler) handleGetModels(w http.ResponseWriter, r *http.Request) {
	var savedSettings *translation.Settings
	if h.databasePath != "" {
		if loaded, err := translation.ReadSettings(r.Context(), h.databasePath); err == nil {
			savedSettings = loaded
		}
	}
	catalog, err := translation.BuildTranslationModelCatalog(r.Context(), h.catalogDeps, savedSettings)
	if err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_models_failed", "构建翻译模型目录失败")
		return
	}
	fallbackCatalog := translation.ResolveTranslationFallbackCatalog(catalog, savedSettings)
	_, selModel, selProvider, selErr := translation.ResolveTranslationRequestRoutes(
		false, nil, "", "", "selection", fallbackCatalog, savedSettings,
	)
	if selErr != nil {
		var cfgErr *translation.ConfigError
		if !errors.As(selErr, &cfgErr) || cfgErr.Code != "translation_model_unavailable" {
			writeFromTranslationErr(w, r, selErr, http.StatusInternalServerError, "translation_models_failed", "构建翻译模型目录失败")
			return
		}
		selModel = ""
		selProvider = ""
	}
	models := catalog.Models
	if models == nil {
		models = []translation.ModelEntry{}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":              true,
		"models":          models,
		"defaultModel":    selModel,
		"defaultProvider": selProvider,
	})
}

func (h *Handler) handlePostStream(w http.ResponseWriter, r *http.Request) {
	startedAt := h.now()
	body, ok := readJSONObjectBody(w, r, streamBodyLimitBytes)
	if !ok {
		return
	}

	var savedSettings *translation.Settings
	if h.databasePath != "" {
		if loaded, err := translation.ReadSettings(r.Context(), h.databasePath); err == nil {
			savedSettings = loaded
		}
	}

	rawText := extractStringField(body, "text")
	if len([]rune(rawText)) > MaxTranslationInputChars {
		writeTranslationError(
			w, r, http.StatusRequestEntityTooLarge,
			"translation_input_too_large",
			fmt.Sprintf("单次翻译最多 %d 字符", MaxTranslationInputChars),
			nil,
		)
		return
	}
	if strings.TrimSpace(rawText) == "" {
		writeTranslationError(w, r, http.StatusBadRequest, "translation_text_required", "请输入要翻译的内容", nil)
		return
	}

	reqSource, reqTarget, langErr := resolveStreamRequestLanguages(body)
	if langErr != nil {
		writeFromTranslationErr(w, r, langErr, http.StatusBadRequest, "translation_language_unsupported", "源语言或目标语言不受支持")
		return
	}

	catalog, err := translation.BuildTranslationModelCatalog(r.Context(), h.catalogDeps, savedSettings)
	if err != nil {
		writeFromTranslationErr(w, r, err, http.StatusInternalServerError, "translation_models_failed", "加载翻译模型失败")
		return
	}
	fallbackCatalog := translation.ResolveTranslationFallbackCatalog(catalog, savedSettings)

	operation := strings.ToLower(strings.TrimSpace(extractStringField(body, "operation")))
	rawRoutes, hasRoutes := body["routes"]
	routes, selModel, selProvider, routeErr := translation.ResolveTranslationRequestRoutes(
		hasRoutes,
		rawRoutes,
		extractStringField(body, "model"),
		extractStringField(body, "provider"),
		operation,
		fallbackCatalog,
		savedSettings,
	)
	if routeErr != nil {
		writeFromTranslationErr(w, r, routeErr, http.StatusConflict, "translation_model_unavailable", "当前没有可用作翻译的模型")
		return
	}

	detection := translation.DetectLanguage(rawText)
	confidence := ""
	if reqSource == translation.AutoLanguage {
		confidence = detection.Confidence
	}
	intent := translation.ResolveLanguageIntent(translation.LanguageIntentInput{
		Source:          reqSource,
		Target:          reqTarget,
		Detected:        detection.Code,
		Confidence:      confidence,
		TargetPolicy:    extractStringField(body, "targetPolicy"),
		AllowAutoSource: translation.RoutesAllowAutoSource(routes, operation, len(routes) == 0),
	})
	if intent.State == "unsupported" {
		writeTranslationError(w, r, http.StatusBadRequest, "translation_language_unsupported", "源语言或目标语言不受支持", nil)
		return
	}
	if intent.State != "ready" {
		suggested := make([]string, 0, 3)
		for _, lang := range translation.ListLanguages() {
			if lang.Code == intent.Source {
				continue
			}
			suggested = append(suggested, lang.Code)
			if len(suggested) == 3 {
				break
			}
		}
		detail := "请确认目标语言后再翻译"
		if intent.State == "same_language" {
			detail = "源语言与目标语言相同，请确认目标语言"
		}
		writeTranslationError(w, r, http.StatusConflict, "translation_target_confirmation_required", detail, map[string]any{
			"detected":         detection.Code,
			"confidence":       detection.Confidence,
			"suggestedTargets": suggested,
			"reason":           intent.Reason,
		})
		return
	}

	glossary := parseGlossary(body["glossary"])
	formality := strings.TrimSpace(extractStringField(body, "formality"))
	prompt := translation.BuildTranslationMessages(translation.TranslationMessagesInput{
		Text:      rawText,
		Source:    intent.Source,
		Target:    intent.Target,
		Glossary:  glossary,
		Formality: formality,
	})

	headers := w.Header()
	applyCorsHeaders(headers, r)
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	var replyBuf strings.Builder
	writeSSE := func(ev translation.StreamEvent) {
		if r.Context().Err() != nil {
			return
		}
		if ev.Type == "delta" && ev.Content != "" {
			replyBuf.WriteString(ev.Content)
		}
		payload, marshalErr := json.Marshal(ev)
		if marshalErr != nil {
			return
		}
		_, _ = w.Write([]byte("data: "))
		_, _ = w.Write(payload)
		_, _ = w.Write([]byte("\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}

	fromLabel := ""
	if intent.Source != "" {
		fromLabel = translation.LanguageLabel(intent.Source)
	}
	writeSSE(translation.StreamEvent{
		Type:                "start",
		From:                intent.Source,
		FromLabel:           fromLabel,
		Detected:            detection.Code,
		DetectedLabel:       detection.Label,
		DetectionConfidence: detection.Confidence,
		To:                  intent.Target,
		ToLabel:             translation.LanguageLabel(intent.Target),
		Model:               selModel,
		Provider:            selProvider,
	})

	maxTokens := 0
	if rawMax, ok := body["maxTokens"].(float64); ok && rawMax > 0 {
		maxTokens = int(rawMax)
	}
	result := translation.RunRoutes(r.Context(), translation.ExecuteRouteInput{
		Operation: operation,
		Text:      rawText,
		Source:    intent.Source,
		Target:    intent.Target,
		Glossary:  glossary,
		Formality: formality,
		Messages:  prompt.Messages,
		MaxTokens: maxTokens,
	}, translation.RunOptions{
		Routes:       routes,
		Operation:    operation,
		DatabasePath: h.databasePath,
		Gateway:      h.gateway,
		HTTPClient:   h.httpClient,
		AdapterTime:  h.adapterTime,
	}, writeSSE)

	if r.Context().Err() != nil {
		return
	}
	elapsedMS := h.now().Sub(startedAt).Milliseconds()
	if elapsedMS < 0 {
		elapsedMS = 0
	}
	if result.OK {
		finalText := replyBuf.String()
		if finalText == "" {
			finalText = result.Text
		}
		writeSSE(translation.StreamEvent{
			Type:      "done",
			Route:     result.Route,
			Text:      finalText,
			Usage:     result.Usage,
			ElapsedMS: elapsedMS,
		})
		return
	}

	errCode := "translation_failed"
	errMsg := "翻译失败"
	errStatus := 0
	if result.Error != nil {
		if result.Error.Code != "" {
			errCode = result.Error.Code
		}
		if result.Error.Message != "" {
			errMsg = result.Error.Message
		}
		errStatus = result.Error.Status
	}
	writeSSE(translation.StreamEvent{
		Type:        "error",
		Code:        errCode,
		Message:     errMsg,
		Status:      errStatus,
		PartialText: replyBuf.String(),
		ElapsedMS:   elapsedMS,
	})
}

func resolveStreamRequestLanguages(body map[string]any) (string, string, error) {
	rawTargetVal, hasTargetVal := body["target"]
	rawTargetStr := strings.TrimSpace(extractAnyString(rawTargetVal))
	hasTarget := hasTargetVal && rawTargetVal != nil && rawTargetStr != ""
	normTarget := translation.NormalizeLanguageCode(rawTargetStr)
	target := ""
	if normTarget == translation.AutoLanguage || translation.IsSupportedLanguage(normTarget) {
		target = normTarget
	}
	if hasTarget && target == "" {
		return "", "", &translation.ConfigError{
			StatusCode: http.StatusBadRequest,
			Code:       "translation_target_unsupported",
			Detail:     "目标语言不受支持",
		}
	}

	rawSourceVal, hasSourceVal := body["source"]
	rawSourceStr := strings.TrimSpace(extractAnyString(rawSourceVal))
	hasSource := hasSourceVal && rawSourceVal != nil && rawSourceStr != ""
	normSource := translation.NormalizeLanguageCode(rawSourceStr)
	if hasSource && normSource == "" {
		return "", "", &translation.ConfigError{
			StatusCode: http.StatusBadRequest,
			Code:       "translation_source_unsupported",
			Detail:     "源语言不受支持",
		}
	}
	source := translation.AutoLanguage
	if normSource == translation.AutoLanguage || translation.IsSupportedLanguage(normSource) {
		source = normSource
	}
	return source, target, nil
}

func parseGlossary(raw any) []translation.GlossaryItem {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil
	}
	out := make([]translation.GlossaryItem, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok || m == nil {
			continue
		}
		out = append(out, translation.GlossaryItem{
			Source: extractStringField(m, "source"),
			Target: extractStringField(m, "target"),
		})
	}
	return translation.NormalizeGlossary(out)
}

func readJSONObjectBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]any, bool) {
	if r.Body == nil {
		return map[string]any{}, true
	}
	limited := http.MaxBytesReader(w, r.Body, maxBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeTranslationError(w, r, http.StatusRequestEntityTooLarge, "request_body_too_large", "请求内容过大", nil)
			return nil, false
		}
		writeTranslationError(w, r, http.StatusBadRequest, "invalid_request_body", "无法读取请求内容", nil)
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return map[string]any{}, true
	}
	var parsed map[string]any
	if err := json.Unmarshal(trimmed, &parsed); err != nil || parsed == nil {
		writeTranslationError(w, r, http.StatusBadRequest, "invalid_json", "请求内容必须是合法 JSON", nil)
		return nil, false
	}
	return parsed, true
}

func applyCorsHeaders(headers http.Header, r *http.Request) {
	if r == nil {
		return
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if !strings.HasPrefix(origin, "chrome-extension://") && !strings.HasPrefix(origin, "moz-extension://") {
		return
	}
	headers.Set("Access-Control-Allow-Origin", origin)
	headers.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-AIH-Server-Id")
	headers.Set("Vary", "Origin")
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload map[string]any) {
	headers := w.Header()
	applyCorsHeaders(headers, r)
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeTranslationError(
	w http.ResponseWriter,
	r *http.Request,
	status int,
	code string,
	detail string,
	extra map[string]any,
) {
	if status <= 0 {
		status = http.StatusInternalServerError
	}
	if code == "" {
		code = "translation_error"
	}
	if detail == "" {
		detail = "translation request failed"
	}
	payload := map[string]any{
		"ok":     false,
		"error":  code,
		"detail": detail,
	}
	for k, v := range extra {
		payload[k] = v
	}
	writeJSON(w, r, status, payload)
}

func writeFromTranslationErr(
	w http.ResponseWriter,
	r *http.Request,
	err error,
	fallbackStatus int,
	fallbackCode string,
	fallbackDetail string,
) {
	var cfgErr *translation.ConfigError
	if errors.As(err, &cfgErr) {
		status := cfgErr.StatusCode
		if status <= 0 {
			status = fallbackStatus
		}
		code := cfgErr.Code
		if code == "" {
			code = fallbackCode
		}
		detail := cfgErr.Detail
		if detail == "" {
			detail = fallbackDetail
		}
		writeTranslationError(w, r, status, code, detail, cfgErr.Extra)
		return
	}
	detail := fallbackDetail
	if detail == "" && err != nil {
		detail = err.Error()
	}
	writeTranslationError(w, r, fallbackStatus, fallbackCode, detail, nil)
}

func extractStringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	return extractAnyString(m[key])
}

func extractAnyString(v any) string {
	switch val := v.(type) {
	case string:
		return val
	default:
		return ""
	}
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if max <= 0 || len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
