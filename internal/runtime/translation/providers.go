package translation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	providerConfigKeyPrefix = "translation:provider-config:"
	maxSecretFieldLength    = 4096
	maxPlainFieldLength     = 2048
)

// ProviderCapabilities 描述单一翻译服务商支持的操作与参数能力。
type ProviderCapabilities struct {
	Operations []string `json:"operations"`
	Streaming  bool     `json:"streaming"`
	Detection  bool     `json:"detection"`
	SourceAuto bool     `json:"sourceAuto"`
	Glossary   bool     `json:"glossary"`
	Formality  bool     `json:"formality"`
}

// ProviderAuthSpec 描述鉴权需求。
type ProviderAuthSpec struct {
	Modes    []string `json:"modes"`
	Required bool     `json:"required"`
	Fields   []string `json:"fields"`
}

// ProviderFieldDef 描述配置表单的单个字段元数据。
type ProviderFieldDef struct {
	Label        string `json:"label"`
	Secret       bool   `json:"secret,omitempty"`
	Format       string `json:"format,omitempty"`
	Required     bool   `json:"required,omitempty"`
	DefaultValue string `json:"defaultValue,omitempty"`
	Placeholder  string `json:"placeholder,omitempty"`
}

// ProviderConfigSpec 描述配置模型与字段定义。
type ProviderConfigSpec struct {
	Fields           []string                    `json:"fields"`
	RouteField       string                      `json:"routeField,omitempty"`
	ModelSource      string                      `json:"modelSource"`
	DefaultModel     string                      `json:"defaultModel,omitempty"`
	FieldDefinitions map[string]ProviderFieldDef `json:"fieldDefinitions"`
}

// ProviderDescriptor 是内建翻译引擎的公开合同描述符。
type ProviderDescriptor struct {
	ContractVersion   int                  `json:"contractVersion"`
	ID                string               `json:"id"`
	Label             string               `json:"label"`
	Capabilities      ProviderCapabilities `json:"capabilities"`
	Auth              ProviderAuthSpec     `json:"auth"`
	Config            ProviderConfigSpec   `json:"config"`
	ClientFreeAdapter string               `json:"clientFreeAdapter"`
	Metadata          map[string]string    `json:"metadata"`
}

// PublicProviderConfig 是脱敏后的服务商配置投影。
type PublicProviderConfig struct {
	Configured       bool              `json:"configured"`
	MissingFields    []string          `json:"missingFields"`
	SecretConfigured map[string]bool   `json:"secretConfigured"`
	Values           map[string]string `json:"values"`
}

// ProviderStatusView 是管理接口返回的单个服务商完整状态。
type ProviderStatusView struct {
	ContractVersion   int                  `json:"contractVersion"`
	ID                string               `json:"id"`
	Label             string               `json:"label"`
	Capabilities      ProviderCapabilities `json:"capabilities"`
	Auth              ProviderAuthSpec     `json:"auth"`
	Config            ProviderConfigSpec   `json:"config"`
	ClientFreeAdapter string               `json:"clientFreeAdapter"`
	Metadata          map[string]string    `json:"metadata"`
	Executable        bool                 `json:"executable"`
	Configured        bool                 `json:"configured"`
	MissingFields     []string             `json:"missingFields"`
	SecretConfigured  map[string]bool      `json:"secretConfigured"`
	Values            map[string]string    `json:"values"`
}

// ConfigError 表示可映射为 HTTP 4xx/5xx 的业务错误。
type ConfigError struct {
	StatusCode int
	Code       string
	Detail     string
	Extra      map[string]any
}

func (err *ConfigError) Error() string {
	if err == nil {
		return ""
	}
	if err.Detail != "" {
		return err.Detail
	}
	return err.Code
}

var builtinDescriptors = []ProviderDescriptor{
	{
		ContractVersion: 1,
		ID:              "aih-gateway",
		Label:           "AIH Gateway",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  true,
			Detection:  false,
			SourceAuto: true,
			Glossary:   true,
			Formality:  true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"managed"},
			Required: false,
			Fields:   []string{"model", "modelProvider"},
		},
		Config: ProviderConfigSpec{
			Fields:           []string{"model", "provider", "routes"},
			RouteField:       "routes",
			ModelSource:      "gateway",
			FieldDefinitions: map[string]ProviderFieldDef{},
		},
		ClientFreeAdapter: "aih-gateway",
		Metadata: map[string]string{
			"transport":         "local-gateway",
			"access":            "managed",
			"accessLabel":       "使用 AIH 账号池",
			"accessDescription": "由现有网关账号和模型目录提供翻译。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "microsoft",
		Label:           "Microsoft Translator",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  true,
			SourceAuto: true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey", "region"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "region", "endpoint"},
			ModelSource:  "service",
			DefaultModel: "default",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"region":   {Label: "区域", Placeholder: "例如 eastasia"},
				"endpoint": {Label: "服务地址", Format: "url", DefaultValue: "https://api.cognitive.microsofttranslator.com"},
			},
		},
		ClientFreeAdapter: "microsoft",
		Metadata: map[string]string{
			"service":           "azure-translator",
			"access":            "official-free-quota",
			"accessLabel":       "官方免费额度 / 付费服务",
			"accessDescription": "需 Azure Translator 密钥；免费额度与计费以官方账户条款为准。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "google",
		Label:           "Google Translate",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  true,
			SourceAuto: true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "endpoint"},
			ModelSource:  "service",
			DefaultModel: "default",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"endpoint": {Label: "服务地址", Format: "url", DefaultValue: "https://translation.googleapis.com"},
			},
		},
		ClientFreeAdapter: "google",
		Metadata: map[string]string{
			"service":           "cloud-translation-basic-v2",
			"access":            "official-cloud",
			"accessLabel":       "官方云服务",
			"accessDescription": "需 Google Cloud API Key；额度、赠金与计费以官方账户条款为准。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "libretranslate",
		Label:           "LibreTranslate",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  true,
			SourceAuto: true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"optional-api-key"},
			Required: false,
			Fields:   []string{"apiKey", "endpoint"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "endpoint"},
			ModelSource:  "service",
			DefaultModel: "default",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true},
				"endpoint": {Label: "服务地址", Format: "url", Required: true, Placeholder: "https://translate.example.com"},
			},
		},
		ClientFreeAdapter: "libretranslate",
		Metadata: map[string]string{
			"service":           "libretranslate",
			"access":            "self-hosted",
			"accessLabel":       "自托管 / 自行提供服务",
			"accessDescription": "需要可访问的 LibreTranslate 服务地址；开源软件不代表提供免费公共服务。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "deepl",
		Label:           "DeepL",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  true,
			SourceAuto: true,
			Formality:  true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey", "endpoint"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "endpoint"},
			ModelSource:  "service",
			DefaultModel: "default",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"endpoint": {Label: "服务地址", Format: "url", Placeholder: "留空时根据密钥选择 Free / Pro 地址"},
			},
		},
		ClientFreeAdapter: "deepl",
		Metadata: map[string]string{
			"service":           "deepl",
			"access":            "official-free-quota",
			"accessLabel":       "官方 API Free / Pro",
			"accessDescription": "需 DeepL API 密钥；API Free 的额度与地区限制以官方条款为准。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "openai",
		Label:           "OpenAI",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  false,
			SourceAuto: true,
			Formality:  true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey", "model", "endpoint"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "model", "endpoint"},
			ModelSource:  "config",
			DefaultModel: "gpt-4o-mini",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"model":    {Label: "模型", Required: true, DefaultValue: "gpt-4o-mini"},
				"endpoint": {Label: "服务地址", Format: "url", DefaultValue: "https://api.openai.com"},
			},
		},
		ClientFreeAdapter: "openai",
		Metadata: map[string]string{
			"service":           "openai-chat-completions",
			"access":            "official-cloud",
			"accessLabel":       "官方 API（按量计费）",
			"accessDescription": "直连 OpenAI，不经过 AIH Server；需 OpenAI API Key。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "anthropic",
		Label:           "Claude (Anthropic)",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  false,
			SourceAuto: true,
			Formality:  true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey", "model", "endpoint"},
		},
		Config: ProviderConfigSpec{
			Fields:       []string{"apiKey", "model", "endpoint"},
			ModelSource:  "config",
			DefaultModel: "claude-haiku-5-5",
			FieldDefinitions: map[string]ProviderFieldDef{
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"model":    {Label: "模型", Required: true, DefaultValue: "claude-haiku-5-5"},
				"endpoint": {Label: "服务地址", Format: "url", DefaultValue: "https://api.anthropic.com"},
			},
		},
		ClientFreeAdapter: "anthropic",
		Metadata: map[string]string{
			"service":           "anthropic-messages",
			"access":            "official-cloud",
			"accessLabel":       "官方 API（按量计费）",
			"accessDescription": "直连 Anthropic Messages API，不经过 AIH Server；需 Anthropic API Key。",
		},
	},
	{
		ContractVersion: 1,
		ID:              "openai-compatible",
		Label:           "OpenAI 兼容接口",
		Capabilities: ProviderCapabilities{
			Operations: []string{"selection", "batch", "page", "replace"},
			Streaming:  false,
			Detection:  false,
			SourceAuto: true,
			Formality:  true,
		},
		Auth: ProviderAuthSpec{
			Modes:    []string{"api-key"},
			Required: true,
			Fields:   []string{"apiKey", "model", "endpoint"},
		},
		Config: ProviderConfigSpec{
			Fields:      []string{"apiKey", "model", "endpoint"},
			ModelSource: "config",
			FieldDefinitions: map[string]ProviderFieldDef{
				"endpoint": {Label: "服务地址", Format: "url", Required: true, Placeholder: "https://api.deepseek.com/v1"},
				"apiKey":   {Label: "API Key", Secret: true, Required: true},
				"model":    {Label: "模型", Required: true, Placeholder: "例如 deepseek-chat / qwen-plus / llama3"},
			},
		},
		ClientFreeAdapter: "openai-compatible",
		Metadata: map[string]string{
			"service":           "openai-compatible",
			"access":            "custom-endpoint",
			"accessLabel":       "自建 / 第三方兼容服务",
			"accessDescription": "任何兼容 OpenAI Chat Completions 的服务：DeepSeek、通义、Ollama、vLLM、OpenRouter 等。",
		},
	},
}

func cloneDescriptor(src ProviderDescriptor) ProviderDescriptor {
	out := src
	out.Capabilities.Operations = append([]string(nil), src.Capabilities.Operations...)
	out.Auth.Modes = append([]string(nil), src.Auth.Modes...)
	out.Auth.Fields = append([]string(nil), src.Auth.Fields...)
	out.Config.Fields = append([]string(nil), src.Config.Fields...)
	out.Config.FieldDefinitions = make(map[string]ProviderFieldDef, len(src.Config.FieldDefinitions))
	for k, v := range src.Config.FieldDefinitions {
		out.Config.FieldDefinitions[k] = v
	}
	out.Metadata = make(map[string]string, len(src.Metadata))
	for k, v := range src.Metadata {
		out.Metadata[k] = v
	}
	return out
}

// BuiltinProviderDescriptors 返回全部 8 个内建翻译引擎的描述符副本。
func BuiltinProviderDescriptors() []ProviderDescriptor {
	out := make([]ProviderDescriptor, 0, len(builtinDescriptors))
	for _, d := range builtinDescriptors {
		out = append(out, cloneDescriptor(d))
	}
	return out
}

// FindProviderDescriptor 按 ID 查找翻译服务商描述符。
func FindProviderDescriptor(id string) (ProviderDescriptor, bool) {
	normalized := NormalizeProviderID(id)
	for _, d := range builtinDescriptors {
		if d.ID == normalized {
			return cloneDescriptor(d), true
		}
	}
	return ProviderDescriptor{}, false
}

// CanExecuteProvider 判断服务商或路由是否有内置执行器可运行。
func CanExecuteProvider(providerID string, operation string) bool {
	descriptor, ok := FindProviderDescriptor(providerID)
	if !ok {
		return false
	}
	if operation == "" {
		return true
	}
	op := strings.ToLower(strings.TrimSpace(operation))
	for _, supported := range descriptor.Capabilities.Operations {
		if supported == op {
			return true
		}
	}
	return false
}

func descriptorFields(descriptor ProviderDescriptor) []string {
	out := make([]string, 0, len(descriptor.Config.Fields))
	for _, name := range descriptor.Config.Fields {
		if _, ok := descriptor.Config.FieldDefinitions[name]; ok {
			out = append(out, name)
		}
	}
	return out
}

// ReadProviderConfig 从 app-state.db 读取服务商运行时配置，缺失字段用默认值补齐。
func ReadProviderConfig(
	ctx context.Context,
	databasePath string,
	descriptor ProviderDescriptor,
) (map[string]string, error) {
	fields := descriptorFields(descriptor)
	stored := map[string]any{}
	if path := strings.TrimSpace(databasePath); path != "" && len(fields) > 0 {
		raw, found, err := appstate.ReadKV(ctx, path, providerConfigKeyPrefix+descriptor.ID)
		if err != nil {
			return nil, err
		}
		if found && strings.TrimSpace(raw) != "" {
			if err := json.Unmarshal([]byte(raw), &stored); err != nil {
				stored = map[string]any{}
			}
		}
	}
	config := make(map[string]string, len(fields))
	for _, name := range fields {
		def := descriptor.Config.FieldDefinitions[name]
		val := def.DefaultValue
		if rawVal, exists := stored[name]; exists && rawVal != nil {
			if text, ok := rawVal.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					val = trimmed
				}
			}
		}
		config[name] = strings.TrimSpace(val)
	}
	return config, nil
}

// ProjectPublicProviderConfig 把含密钥的内部配置投影为脱敏公开视图。
func ProjectPublicProviderConfig(
	descriptor ProviderDescriptor,
	config map[string]string,
) PublicProviderConfig {
	fields := descriptorFields(descriptor)
	missingFields := make([]string, 0)
	secretConfigured := make(map[string]bool)
	values := make(map[string]string)
	for _, name := range fields {
		def := descriptor.Config.FieldDefinitions[name]
		val := strings.TrimSpace(config[name])
		if def.Required && val == "" {
			missingFields = append(missingFields, name)
		}
		if def.Secret {
			secretConfigured[name] = val != ""
		} else {
			values[name] = val
		}
	}
	return PublicProviderConfig{
		Configured:       len(missingFields) == 0,
		MissingFields:    missingFields,
		SecretConfigured: secretConfigured,
		Values:           values,
	}
}

// WriteProviderConfig 校验并持久化单个翻译引擎的配置字段到 app-state.db。
func WriteProviderConfig(
	ctx context.Context,
	databasePath string,
	descriptor ProviderDescriptor,
	patchRaw map[string]any,
	now time.Time,
) (PublicProviderConfig, error) {
	if patchRaw == nil {
		return PublicProviderConfig{}, &ConfigError{
			StatusCode: 400,
			Code:       "translation_provider_config_invalid",
			Detail:     "请检查翻译引擎的配置字段",
		}
	}
	if strings.TrimSpace(databasePath) == "" {
		return PublicProviderConfig{}, &ConfigError{
			StatusCode: 503,
			Code:       "translation_home_dir_unavailable",
			Detail:     "数据目录不可用",
		}
	}

	next, err := ReadProviderConfig(ctx, databasePath, descriptor)
	if err != nil {
		return PublicProviderConfig{}, err
	}
	allowed := make(map[string]ProviderFieldDef)
	for _, name := range descriptorFields(descriptor) {
		allowed[name] = descriptor.Config.FieldDefinitions[name]
	}

	for name, rawValue := range patchRaw {
		def, exists := allowed[name]
		if !exists {
			return PublicProviderConfig{}, &ConfigError{
				StatusCode: 400,
				Code:       "translation_provider_config_field_invalid",
				Detail:     "请检查翻译引擎的配置字段",
			}
		}
		text, ok := rawValue.(string)
		if !ok {
			return PublicProviderConfig{}, &ConfigError{
				StatusCode: 400,
				Code:       "translation_provider_config_field_invalid",
				Detail:     "请检查翻译引擎的配置字段",
			}
		}
		trimmed := strings.TrimSpace(text)
		maxLen := maxPlainFieldLength
		if def.Secret {
			maxLen = maxSecretFieldLength
		}
		if len([]rune(trimmed)) > maxLen {
			return PublicProviderConfig{}, &ConfigError{
				StatusCode: 400,
				Code:       "translation_provider_config_field_invalid",
				Detail:     "请检查翻译引擎的配置字段",
			}
		}
		if trimmed != "" && def.Format == "url" {
			parsed, parseErr := url.Parse(trimmed)
			if parseErr != nil ||
				(parsed.Scheme != "http" && parsed.Scheme != "https") ||
				parsed.Host == "" ||
				parsed.User != nil ||
				parsed.RawQuery != "" ||
				parsed.Fragment != "" {
				return PublicProviderConfig{}, &ConfigError{
					StatusCode: 400,
					Code:       "translation_provider_endpoint_invalid",
					Detail:     "请检查翻译引擎的配置字段",
				}
			}
		}
		if trimmed == "" {
			next[name] = def.DefaultValue
		} else {
			next[name] = trimmed
		}
	}

	payload, err := json.Marshal(next)
	if err != nil {
		return PublicProviderConfig{}, fmt.Errorf("编码翻译引擎配置失败: %w", err)
	}
	updatedMS := now.UnixMilli()
	if updatedMS <= 0 {
		updatedMS = time.Now().UnixMilli()
	}
	if err := appstate.WriteKV(ctx, databasePath, providerConfigKeyPrefix+descriptor.ID, string(payload), updatedMS); err != nil {
		return PublicProviderConfig{}, &ConfigError{
			StatusCode: 500,
			Code:       "translation_provider_config_write_failed",
			Detail:     "保存翻译引擎配置失败",
		}
	}
	return ProjectPublicProviderConfig(descriptor, next), nil
}

// ListProviderStatuses 返回全部内建服务商及其当前公开配置状态。
func ListProviderStatuses(ctx context.Context, databasePath string) ([]ProviderStatusView, error) {
	descriptors := BuiltinProviderDescriptors()
	views := make([]ProviderStatusView, 0, len(descriptors))
	for _, descriptor := range descriptors {
		cfg, err := ReadProviderConfig(ctx, databasePath, descriptor)
		if err != nil {
			return nil, err
		}
		pub := ProjectPublicProviderConfig(descriptor, cfg)
		views = append(views, ProviderStatusView{
			ContractVersion:   descriptor.ContractVersion,
			ID:                descriptor.ID,
			Label:             descriptor.Label,
			Capabilities:      descriptor.Capabilities,
			Auth:              descriptor.Auth,
			Config:            descriptor.Config,
			ClientFreeAdapter: descriptor.ClientFreeAdapter,
			Metadata:          descriptor.Metadata,
			Executable:        CanExecuteProvider(descriptor.ID, ""),
			Configured:        pub.Configured,
			MissingFields:     pub.MissingFields,
			SecretConfigured:  pub.SecretConfigured,
			Values:            pub.Values,
		})
	}
	return views, nil
}
