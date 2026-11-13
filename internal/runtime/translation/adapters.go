package translation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// DefaultAdapterTimeout 是直连外部翻译 API 的单次请求超时。
	DefaultAdapterTimeout = 30 * time.Second
	// MaxAdapterResponseBytes 限制直连翻译 API 的最大响应体（2 MiB）。
	MaxAdapterResponseBytes = 2 * 1024 * 1024
)

// UsageSummary 表示一次翻译请求消耗的用量统计。
type UsageSummary struct {
	InputTokens      int `json:"inputTokens,omitempty"`
	OutputTokens     int `json:"outputTokens,omitempty"`
	BilledCharacters int `json:"billedCharacters,omitempty"`
	PromptTokens     int `json:"prompt_tokens,omitempty"`
	CompletionTokens int `json:"completion_tokens,omitempty"`
	TotalTokens      int `json:"total_tokens,omitempty"`
}

// AdapterClient 描述直连 HTTP 适配器使用的窄 HTTP 客户端端口。
type AdapterClient interface {
	Do(req *http.Request) (*http.Response, error)
}

func newStrictRedirectHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("translation_redirect_disallowed")
		},
	}
}

func buildEndpointURL(endpoint string, fallback string, path string) (*url.URL, error) {
	raw := strings.TrimSpace(endpoint)
	if raw == "" {
		raw = strings.TrimSpace(fallback)
	}
	parsed, err := url.Parse(raw)
	if err != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" {
		return nil, errors.New("translation_config_invalid")
	}
	parsed.Fragment = ""
	pathname := strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(pathname, path) {
		parsed.Path = pathname + path
	}
	return parsed, nil
}

func buildLLMEndpointURL(endpoint string, fallback string, path string) (*url.URL, error) {
	base := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(fallback), "/")
	}
	base = strings.TrimSuffix(base, "/v1")
	return buildEndpointURL(base, "", path)
}

func isAutomaticSource(source string) bool {
	return source == "" || strings.EqualFold(strings.TrimSpace(source), AutoLanguage)
}

func adapterFailure(code string, message string, status int, retryable bool) RunResult {
	return RunResult{
		OK: false,
		Error: &ExecutionError{
			Code:      code,
			Message:   message,
			Status:    status,
			Retryable: retryable,
		},
	}
}

func httpStatusFailure(status int) RunResult {
	code := "translation_upstream_http_error"
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		code = "translation_auth_failed"
	case http.StatusTooManyRequests:
		code = "translation_rate_limited"
	case 456:
		code = "translation_quota_exceeded"
	}
	retryable := status == http.StatusRequestTimeout ||
		status == http.StatusTooEarly ||
		status == http.StatusTooManyRequests ||
		status >= 500
	return adapterFailure(code, fmt.Sprintf("翻译服务请求失败（HTTP %d）", status), status, retryable)
}

type httpAdapterSpec struct {
	id             string
	required       []string
	supportsFormal bool
	buildRequest   func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error)
	parseResponse  func(body []byte) (string, *UsageSummary, bool)
}

// AdapterInput 描述单条适配器执行时的规范输入。
type AdapterInput struct {
	Text      string
	Source    string
	Target    string
	Glossary  []GlossaryItem
	Formality string
}

var httpAdapterSpecs = map[string]httpAdapterSpec{
	"microsoft": {
		id:       "microsoft",
		required: []string{"apiKey"},
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			u, err := buildEndpointURL(config["endpoint"], "https://api.cognitive.microsofttranslator.com", "/translate")
			if err != nil {
				return "", nil, nil, err
			}
			q := u.Query()
			q.Set("api-version", "3.0")
			q.Set("to", input.Target)
			q.Set("textType", "plain")
			if !isAutomaticSource(input.Source) {
				q.Set("from", input.Source)
			}
			u.RawQuery = q.Encode()

			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("Ocp-Apim-Subscription-Key", strings.TrimSpace(config["apiKey"]))
			if region := strings.TrimSpace(config["region"]); region != "" {
				headers.Set("Ocp-Apim-Subscription-Region", region)
			}
			body, err := json.Marshal([]map[string]string{{"Text": input.Text}})
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var items []struct {
				Translations []struct {
					Text string `json:"text"`
				} `json:"translations"`
			}
			if err := json.Unmarshal(raw, &items); err != nil || len(items) != 1 || len(items[0].Translations) != 1 {
				return "", nil, false
			}
			return items[0].Translations[0].Text, nil, true
		},
	},
	"google": {
		id:       "google",
		required: []string{"apiKey"},
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			u, err := buildEndpointURL(config["endpoint"], "https://translation.googleapis.com", "/language/translate/v2")
			if err != nil {
				return "", nil, nil, err
			}
			codeMap := map[string]string{"zh-Hans": "zh-CN", "zh-Hant": "zh-TW"}
			mapLang := func(code string) string {
				if mapped, ok := codeMap[code]; ok {
					return mapped
				}
				return code
			}
			payload := map[string]any{
				"q":      []string{input.Text},
				"target": mapLang(input.Target),
				"format": "text",
			}
			if !isAutomaticSource(input.Source) {
				payload["source"] = mapLang(input.Source)
			}
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("X-Goog-Api-Key", strings.TrimSpace(config["apiKey"]))
			body, err := json.Marshal(payload)
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var resp struct {
				Data struct {
					Translations []struct {
						TranslatedText string `json:"translatedText"`
					} `json:"translations"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil || len(resp.Data.Translations) != 1 {
				return "", nil, false
			}
			return resp.Data.Translations[0].TranslatedText, nil, true
		},
	},
	"libretranslate": {
		id:       "libretranslate",
		required: []string{"endpoint"},
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			u, err := buildEndpointURL(config["endpoint"], "", "/translate")
			if err != nil {
				return "", nil, nil, err
			}
			codeMap := map[string]string{"zh-Hans": "zh", "zh-Hant": "zt"}
			mapLang := func(code string) string {
				if mapped, ok := codeMap[code]; ok {
					return mapped
				}
				return code
			}
			sourceVal := "auto"
			if !isAutomaticSource(input.Source) {
				sourceVal = mapLang(input.Source)
			}
			payload := map[string]any{
				"q":      input.Text,
				"source": sourceVal,
				"target": mapLang(input.Target),
				"format": "text",
			}
			if key := strings.TrimSpace(config["apiKey"]); key != "" {
				payload["api_key"] = key
			}
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			body, err := json.Marshal(payload)
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var resp struct {
				Error          any    `json:"error"`
				TranslatedText string `json:"translatedText"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil || resp.Error != nil {
				return "", nil, false
			}
			return resp.TranslatedText, nil, true
		},
	},
	"deepl": {
		id:             "deepl",
		required:       []string{"apiKey"},
		supportsFormal: true,
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			apiKey := strings.TrimSpace(config["apiKey"])
			fallback := "https://api.deepl.com"
			if strings.HasSuffix(apiKey, ":fx") {
				fallback = "https://api-free.deepl.com"
			}
			u, err := buildEndpointURL(config["endpoint"], fallback, "/v2/translate")
			if err != nil {
				return "", nil, nil, err
			}
			targetMap := map[string]string{"zh-Hans": "ZH-HANS", "zh-Hant": "ZH-HANT", "en": "EN-US", "pt": "PT-PT"}
			sourceMap := map[string]string{"zh-Hans": "ZH", "zh-Hant": "ZH"}
			formalityMap := map[string]string{"formal": "prefer_more", "casual": "prefer_less", "default": "default"}

			targetLang := targetMap[input.Target]
			if targetLang == "" {
				targetLang = strings.ToUpper(input.Target)
			}
			payload := map[string]any{
				"text":                   []string{input.Text},
				"target_lang":            targetLang,
				"show_billed_characters": true,
				"formality":              formalityMap[input.Formality],
			}
			if !isAutomaticSource(input.Source) {
				sourceLang := sourceMap[input.Source]
				if sourceLang == "" {
					sourceLang = strings.ToUpper(input.Source)
				}
				payload["source_lang"] = sourceLang
			}
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("Authorization", "DeepL-Auth-Key "+apiKey)
			body, err := json.Marshal(payload)
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var resp struct {
				Translations []struct {
					Text             string `json:"text"`
					BilledCharacters *int   `json:"billed_characters"`
				} `json:"translations"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil || len(resp.Translations) != 1 {
				return "", nil, false
			}
			item := resp.Translations[0]
			var usage *UsageSummary
			if item.BilledCharacters != nil && *item.BilledCharacters >= 0 {
				usage = &UsageSummary{BilledCharacters: *item.BilledCharacters}
			}
			return item.Text, usage, true
		},
	},
	"openai":            openAIAdapterSpec("openai", "https://api.openai.com"),
	"openai-compatible": openAIAdapterSpec("openai-compatible", ""),
	"anthropic": {
		id:             "anthropic",
		required:       []string{"apiKey", "model"},
		supportsFormal: true,
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			sysPrompt, userText := BuildDirectLLMPrompt(input.Text, input.Source, input.Target, input.Formality)
			u, err := buildLLMEndpointURL(config["endpoint"], "https://api.anthropic.com", "/v1/messages")
			if err != nil {
				return "", nil, nil, err
			}
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("x-api-key", strings.TrimSpace(config["apiKey"]))
			headers.Set("anthropic-version", "2023-06-01")
			body, err := json.Marshal(map[string]any{
				"model":       strings.TrimSpace(config["model"]),
				"max_tokens":  4096,
				"temperature": 0,
				"system":      sysPrompt,
				"messages":    []ChatMessage{{Role: "user", Content: userText}},
			})
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var resp struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
				Usage *struct {
					InputTokens  int `json:"input_tokens"`
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return "", nil, false
			}
			var sb strings.Builder
			for _, block := range resp.Content {
				if block.Type == "text" {
					sb.WriteString(block.Text)
				}
			}
			text := strings.TrimSpace(sb.String())
			if text == "" {
				return "", nil, false
			}
			var usage *UsageSummary
			if resp.Usage != nil {
				usage = &UsageSummary{
					InputTokens:  resp.Usage.InputTokens,
					OutputTokens: resp.Usage.OutputTokens,
				}
			}
			return text, usage, true
		},
	},
}

func openAIAdapterSpec(id string, fallbackEndpoint string) httpAdapterSpec {
	return httpAdapterSpec{
		id:             id,
		required:       []string{"apiKey", "model"},
		supportsFormal: true,
		buildRequest: func(input AdapterInput, config map[string]string) (string, http.Header, []byte, error) {
			sysPrompt, userText := BuildDirectLLMPrompt(input.Text, input.Source, input.Target, input.Formality)
			u, err := buildLLMEndpointURL(config["endpoint"], fallbackEndpoint, "/v1/chat/completions")
			if err != nil {
				return "", nil, nil, err
			}
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("Authorization", "Bearer "+strings.TrimSpace(config["apiKey"]))
			body, err := json.Marshal(map[string]any{
				"model":       strings.TrimSpace(config["model"]),
				"temperature": 0,
				"messages": []ChatMessage{
					{Role: "system", Content: sysPrompt},
					{Role: "user", Content: userText},
				},
			})
			return u.String(), headers, body, err
		},
		parseResponse: func(raw []byte) (string, *UsageSummary, bool) {
			var resp struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
				Usage *struct {
					PromptTokens     int `json:"prompt_tokens"`
					CompletionTokens int `json:"completion_tokens"`
					TotalTokens      int `json:"total_tokens"`
				} `json:"usage"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil || len(resp.Choices) == 0 {
				return "", nil, false
			}
			text := strings.TrimSpace(resp.Choices[0].Message.Content)
			if text == "" {
				return "", nil, false
			}
			var usage *UsageSummary
			if resp.Usage != nil && (resp.Usage.TotalTokens > 0 || resp.Usage.PromptTokens > 0 || resp.Usage.CompletionTokens > 0) {
				usage = &UsageSummary{
					InputTokens:  resp.Usage.PromptTokens,
					OutputTokens: resp.Usage.CompletionTokens,
				}
			}
			return text, usage, true
		},
	}
}

// ExecuteHTTPAdapter 调用指定直连 HTTP 翻译引擎并返回完整结果与增量事件。
func ExecuteHTTPAdapter(
	ctx context.Context,
	providerID string,
	input AdapterInput,
	config map[string]string,
	client AdapterClient,
	timeout time.Duration,
	emit func(StreamEvent),
) RunResult {
	if ctx.Err() != nil {
		return adapterFailure("translation_aborted", "翻译已取消", 0, false)
	}
	spec, ok := httpAdapterSpecs[NormalizeProviderID(providerID)]
	if !ok {
		return adapterFailure("translation_provider_unsupported", "翻译路由不支持此操作", 0, false)
	}
	if strings.TrimSpace(input.Text) == "" || strings.TrimSpace(input.Target) == "" || input.Target == AutoLanguage {
		return adapterFailure("translation_input_invalid", "翻译内容和目标语言不能为空", 0, false)
	}
	if len(input.Glossary) > 0 {
		return adapterFailure("translation_glossary_unsupported", "此翻译服务不支持内联术语表", 0, true)
	}
	formality := strings.TrimSpace(input.Formality)
	if formality == "" {
		formality = "default"
	}
	if (formality != "default" && formality != "formal" && formality != "casual") ||
		(!spec.supportsFormal && formality != "default") {
		return adapterFailure("translation_formality_unsupported", "此翻译服务不支持所选语气", 0, true)
	}
	if config == nil {
		config = map[string]string{}
	}
	missing := make([]string, 0)
	for _, field := range spec.required {
		if strings.TrimSpace(config[field]) == "" {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		return adapterFailure("translation_config_missing", "翻译服务缺少配置："+strings.Join(missing, ", "), 0, true)
	}
	inputCopy := input
	inputCopy.Formality = formality
	targetURL, headers, body, err := spec.buildRequest(inputCopy, config)
	if err != nil {
		return adapterFailure("translation_config_invalid", "翻译服务配置不可用", 0, true)
	}

	if timeout <= 0 {
		timeout = DefaultAdapterTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		return adapterFailure("translation_config_invalid", "翻译服务配置不可用", 0, true)
	}
	req.Header = headers

	if client == nil {
		client = newStrictRedirectHTTPClient(timeout)
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return adapterFailure("translation_aborted", "翻译已取消", 0, false)
		}
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return adapterFailure("translation_timeout", "翻译服务请求超时", 0, true)
		}
		return adapterFailure("translation_network_error", "无法连接翻译服务", 0, true)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpStatusFailure(resp.StatusCode)
	}
	rawBody, err := io.ReadAll(io.LimitReader(resp.Body, MaxAdapterResponseBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return adapterFailure("translation_aborted", "翻译已取消", 0, false)
		}
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return adapterFailure("translation_timeout", "翻译服务请求超时", 0, true)
		}
		return adapterFailure("translation_response_invalid", "翻译服务返回了无效响应", resp.StatusCode, true)
	}
	if len(rawBody) > MaxAdapterResponseBytes {
		return adapterFailure("translation_response_invalid", "翻译服务返回了无效响应", resp.StatusCode, true)
	}
	text, usage, parsedOK := spec.parseResponse(rawBody)
	if !parsedOK || strings.TrimSpace(text) == "" {
		return adapterFailure("translation_response_invalid", "翻译服务返回了无效译文", resp.StatusCode, true)
	}
	if ctx.Err() != nil {
		return adapterFailure("translation_aborted", "翻译已取消", 0, false)
	}
	if emit != nil {
		emit(StreamEvent{Type: "delta", Content: text})
	}
	return RunResult{
		OK:    true,
		Text:  text,
		Usage: usage,
	}
}
