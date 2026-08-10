package cliproxyapi

// codexAuthFile 对齐 CLIProxyAPI CodexTokenStorage 的单 auth 文件字段。
type codexAuthFile struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
	LastRefresh  string `json:"last_refresh"`
	Email        string `json:"email"`
	Type         string `json:"type"`
	Expired      string `json:"expired"`
	Disabled     bool   `json:"disabled"`
}

// claudeAuthFile 对齐 CLIProxyAPI ClaudeTokenStorage 的单 auth 文件字段。
type claudeAuthFile struct {
	IDToken          string `json:"id_token"`
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	LastRefresh      string `json:"last_refresh"`
	Email            string `json:"email"`
	AccountUUID      string `json:"account_uuid,omitempty"`
	OrganizationUUID string `json:"organization_uuid,omitempty"`
	OrganizationName string `json:"organization_name,omitempty"`
	Type             string `json:"type"`
	Expired          string `json:"expired"`
	Disabled         bool   `json:"disabled"`
}
