// Package gemini 提供 Gemini/Vertex 静态占位凭据的领域值。
//
// 占位账号没有可路由的上游凭据：它用于迁移/导出，必须由宿主保持 enabled=false，
// 不能进入 Go 的推理路由池。身份公式与 Node 的 configureVertexAiAccount 一致。
package gemini

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	// ProviderID 是 Gemini 的规范 Provider 标识。
	ProviderID = "gemini"
	// AuthKindVertex 是 Vertex 占位凭据类型。
	AuthKindVertex = "vertex_ai"
	// DefaultProjectID 与 Node 的 placeholder 默认值一致。
	DefaultProjectID = "vertex-placeholder-project"
	// DefaultLocation 与 Node 的 placeholder 默认值一致。
	DefaultLocation = "us-central1"
)

var ErrInvalidVertexCredential = errors.New("Vertex 占位凭据无效")

// VertexInput 是占位凭据的构造输入。
type VertexInput struct {
	ProjectID   string
	Location    string
	APIKey      string
	BaseURL     string
	Placeholder bool
}

// VertexAuth 是不可变的 Vertex 占位凭据值。
type VertexAuth struct {
	projectID   string
	location    string
	apiKey      string
	baseURL     string
	placeholder bool
	seed        string
}

// NewVertexAuth 规范化占位字段并计算与 Node 一致的身份种子。
func NewVertexAuth(input VertexInput) (*VertexAuth, error) {
	projectID := strings.TrimSpace(input.ProjectID)
	if projectID == "" {
		projectID = DefaultProjectID
	}
	location := strings.TrimSpace(input.Location)
	if location == "" {
		location = DefaultLocation
	}
	apiKey := strings.TrimSpace(input.APIKey)
	secret := apiKey
	if secret == "" {
		secret = projectID
	}
	baseURL := strings.TrimSpace(input.BaseURL)
	if !validComponent(projectID) || !validComponent(location) || !validComponent(secret) || !validComponent(baseURL) {
		return nil, ErrInvalidVertexCredential
	}
	digest := sha256.Sum256([]byte(secret))
	return &VertexAuth{
		projectID:   projectID,
		location:    location,
		apiKey:      apiKey,
		baseURL:     baseURL,
		placeholder: input.Placeholder,
		seed:        fmt.Sprintf("vertex_ai:gemini:%s:%s:%s", projectID, location, hex.EncodeToString(digest[:])[:16]),
	}, nil
}

// ProviderID 返回 gemini。
func (*VertexAuth) ProviderID() string { return ProviderID }

// IdentitySeed 返回与 Node 的 buildVertexAiIdentitySeed 相同的稳定种子。
func (auth *VertexAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.seed
}

// ProjectID 返回 Vertex 项目。
func (auth *VertexAuth) ProjectID() string { return auth.projectID }

// Location 返回 Vertex 区域。
func (auth *VertexAuth) Location() string { return auth.location }

// APIKey 返回占位 API Key（可能为空）。
func (auth *VertexAuth) APIKey() string { return auth.apiKey }

// BaseURL 返回占位接入点。
func (auth *VertexAuth) BaseURL() string { return auth.baseURL }

// Placeholder 标记这是一个不可路由的占位账号。
func (auth *VertexAuth) Placeholder() bool { return auth.placeholder }

// String 不暴露密钥。
func (auth *VertexAuth) String() string { return "gemini vertex placeholder credential" }

// GoString 与 String 同形。
func (auth *VertexAuth) GoString() string { return auth.String() }

func validComponent(value string) bool {
	return value == strings.TrimSpace(value) &&
		!strings.Contains(value, "\x00") &&
		!strings.Contains(value, "\ufffd")
}
