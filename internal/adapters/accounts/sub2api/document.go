package sub2api

const dataType = "sub2api-data"

// exportDocument 是单账号导出的顶层 sub2api-data 合同。
//
// 它故意没有 version 字段；HTTP /v1 只是 API 命名空间。
type exportDocument struct {
	Type       string            `json:"type"`
	ExportedAt string            `json:"exported_at"`
	Proxies    []proxyDocument   `json:"proxies"`
	Accounts   []accountDocument `json:"accounts"`
}

// proxyDocument 保证当前没有代理元数据时输出 JSON 空数组而不是 null。
type proxyDocument struct{}

// accountDocument 是 sub2api 中一个 Codex 或 Claude 账号。
type accountDocument struct {
	Name        string `json:"name"`
	Platform    string `json:"platform"`
	Type        string `json:"type"`
	Credentials any    `json:"credentials"`
	Extra       any    `json:"extra,omitempty"`
	Concurrency int    `json:"concurrency"`
	Priority    int    `json:"priority"`
}

// apiKeyCredentials 是 Codex 与 Claude API Key 共享的标准字段。
type apiKeyCredentials struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url,omitempty"`
}

// codexOAuthCredentials 是 Codex OAuth 在 sub2api 中的标准字段。
type codexOAuthCredentials struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	IDToken          string `json:"id_token"`
	ChatGPTAccountID string `json:"chatgpt_account_id,omitempty"`
	PlanType         string `json:"plan_type,omitempty"`
	Email            string `json:"email,omitempty"`
}

// claudeOAuthCredentials 对齐当前 sub2api Anthropic 账号的 snake_case 字段。
type claudeOAuthCredentials struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	Scope        string `json:"scope,omitempty"`
	AccountUUID  string `json:"account_uuid,omitempty"`
	OrgUUID      string `json:"org_uuid,omitempty"`
	Email        string `json:"email_address,omitempty"`
	BaseURL      string `json:"base_url,omitempty"`
}

// claudeAccountExtra 保存 sub2api 当前放在 extra 中的 Claude 稳定公开身份。
type claudeAccountExtra struct {
	AccountUUID string `json:"account_uuid,omitempty"`
	OrgUUID     string `json:"org_uuid,omitempty"`
	Email       string `json:"email_address,omitempty"`
}
