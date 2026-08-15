package managementapi

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

const maxTransferDocumentBytes = 1024 * 1024

// StaticCredentialInput 是静态账号原地更新所需的完整敏感输入。
type StaticCredentialInput struct {
	Kind      string
	APIKey    string
	AuthToken string
	BaseURL   string
}

// staticCredentialRequest 是 Management API 静态凭据 PUT 的私有传输 DTO。
type staticCredentialRequest struct {
	Auth staticCredentialAuth `json:"auth"`
}

// staticCredentialAuth 保持与 Server 静态账号入站 DTO 一致的字段名和互斥语义。
type staticCredentialAuth struct {
	Kind      string `json:"kind"`
	APIKey    string `json:"api_key,omitempty"`
	AuthToken string `json:"auth_token,omitempty"`
	BaseURL   string `json:"base_url,omitempty"`
}

// String 返回不泄露 API Key 或 Auth Token 的输入摘要。
func (input StaticCredentialInput) String() string {
	return fmt.Sprintf(
		"managementapi.StaticCredentialInput{kind=%s,secret=<redacted>,base_url_set=%t}",
		input.Kind,
		input.BaseURL != "",
	)
}

// GoString 确保 %#v 不会反射敏感字段。
func (input StaticCredentialInput) GoString() string {
	return input.String()
}

// Format 覆盖全部 fmt verb，避免格式化绕过凭据脱敏。
func (input StaticCredentialInput) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(input.String()))
}

// ExportSub2API 下载一个账号的标准 sub2api-data 文档。
func (client *Client) ExportSub2API(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	return client.exportAccount(
		ctx,
		accountRef,
		accountcontract.AccountSub2APIExportSuffix,
		"sub2api-data.json",
	)
}

// ExportCLIProxyAPI 下载一个可直接放入 CLIProxyAPI auth-dir 的 OAuth 文件。
func (client *Client) ExportCLIProxyAPI(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	return client.exportAccount(
		ctx,
		accountRef,
		accountcontract.AccountCLIProxyAPIExportSuffix,
		"cliproxyapi-auth.json",
	)
}

// ImportSub2API 提交有界单账号文档，并区分首建与同身份命中。
func (client *Client) ImportSub2API(
	ctx context.Context,
	document []byte,
) (AccountImportResult, error) {
	if !client.isValid() {
		return AccountImportResult{}, ErrInvalidConfig
	}
	if ctx == nil || len(document) == 0 || len(document) > maxTransferDocumentBytes ||
		!json.Valid(document) {
		return AccountImportResult{}, ErrInvalidRequest
	}
	result, err := client.doResponseRequest(
		ctx,
		http.MethodPost,
		client.baseURL+accountcontract.Sub2APIImportsPath,
		document,
	)
	if err != nil {
		return AccountImportResult{}, err
	}
	return decodeAccountImportResult(result)
}

// UpdateStaticCredential 原地替换 Codex/Claude 静态凭据并返回同一账号投影。
func (client *Client) UpdateStaticCredential(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	input StaticCredentialInput,
) (AccountSnapshot, error) {
	if !client.isValid() {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() || !input.isValid() {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(staticCredentialRequest{Auth: staticCredentialAuth{
		Kind:      input.Kind,
		APIKey:    input.APIKey,
		AuthToken: input.AuthToken,
		BaseURL:   input.BaseURL,
	}})
	if err != nil {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	defer clear(payload)
	requestURL := accountURL(client.baseURL, accountRef) +
		accountcontract.AccountCredentialSuffix
	result, err := client.doResponseRequest(ctx, http.MethodPut, requestURL, payload)
	if err != nil {
		return AccountSnapshot{}, err
	}
	if result.statusCode != http.StatusOK || !isJSONResponse(result.header) {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	snapshot, err := decodeAccountSnapshot(result.body)
	if err != nil || snapshot.AccountRef != accountRef {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return snapshot, nil
}

// exportAccount 复用两个标准格式的严格附件响应校验。
func (client *Client) exportAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	suffix string,
	fileName string,
) ([]byte, error) {
	if !client.isValid() {
		return nil, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return nil, ErrInvalidRequest
	}
	result, err := client.doResponseRequest(
		ctx,
		http.MethodGet,
		accountURL(client.baseURL, accountRef)+suffix,
		nil,
	)
	if err != nil {
		return nil, err
	}
	if result.statusCode != http.StatusOK ||
		!isJSONResponse(result.header) ||
		!isExpectedAttachment(result.header, fileName) ||
		!json.Valid(result.body) {
		return nil, ErrInvalidResponse
	}
	return result.body, nil
}

// accountURL 构造稳定账号成员地址。
func accountURL(baseURL string, accountRef accountcore.AccountRef) string {
	return baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String())
}

// isJSONResponse 只接受标准 JSON 媒体类型和可选 UTF-8 charset。
func isJSONResponse(header http.Header) bool {
	mediaType, parameters, err := mime.ParseMediaType(header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || len(parameters) > 1 {
		return false
	}
	charset, found := parameters["charset"]
	return !found || strings.EqualFold(charset, "utf-8")
}

// isExpectedAttachment 拒绝 Server 返回其他格式或不确定文件名。
func isExpectedAttachment(header http.Header, fileName string) bool {
	disposition, parameters, err := mime.ParseMediaType(
		header.Get("Content-Disposition"),
	)
	return err == nil && disposition == "attachment" &&
		parameters["filename"] == fileName
}

// isValid 只校验凭据种类与互斥字段；Provider 语义由 Server 领域工厂负责。
func (input StaticCredentialInput) isValid() bool {
	switch input.Kind {
	case "api_key":
		return validSensitiveValue(input.APIKey) && input.AuthToken == ""
	case "auth_token":
		return input.APIKey == "" && validSensitiveValue(input.AuthToken)
	default:
		return false
	}
}

// validSensitiveValue 拒绝空值、首尾空白和控制字符进入 HTTP 请求。
func validSensitiveValue(value string) bool {
	if value == "" || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character < ' ' || character == 0x7f {
			return false
		}
	}
	return true
}
