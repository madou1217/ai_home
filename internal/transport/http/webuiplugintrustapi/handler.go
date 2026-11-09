// Package webuiplugintrustapi 是插件发布者信任根的管理 HTTP 边界。
//
// 信任根文件 <aiHomeDir>/plugins/trusted-keys.json 是插件安装时校验发布者签名的
// 唯一事实源。本包把「读 / 加信任 / 撤信任」三个动作从 Node 收到 Go：
//
//	GET  /v1/management/plugins/trusted
//	POST /v1/management/plugins/trust
//	POST /v1/management/plugins/untrust
//
// 为什么只有这三条：安装、启停、卸载仍归 Node 控制面（lib/plugins/control/*），
// 但信任根是文件型写面——WebUI 与 CLI 两条写路径各写一份就会产生竞态与两种文件形状。
// 收敛到 Go 后 WebUI 的写操作只有一种实现；Node CLI 仍在独立进程里直接改同一个文件，
// 所以文件格式、0600 权限、keyId 派生与 PEM 归一必须与 Node 逐字节兼容。
//
// body.file 的文件读取留在 Node：Node 先把 PEM 读出来再传给 Go，Go 只接
// publicKey / publicKeyPem，避免管理面出现第二套「服务器本地路径」语义。
package webuiplugintrustapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// TrustedPath 列出本机信任的发布者公钥。响应 {ok:true, keys:[{keyId,fingerprint,algorithm}]}。
	TrustedPath = "/v1/management/plugins/trusted"
	// TrustPath 把一把 Ed25519 公钥加入信任根。
	// 响应 {ok:true, keyId, file, fingerprint}。
	TrustPath = "/v1/management/plugins/trust"
	// UntrustPath 按 keyId 撤销一把公钥。响应 {ok:true, keyId, removed, file}。
	UntrustPath = "/v1/management/plugins/untrust"
)

// maxBodyBytes 与 Node 插件路由的 MAX_BODY_BYTES（256KB）一致。
const maxBodyBytes = 256 * 1024

// ErrInvalidDependencies 表示 Handler 缺少鉴权或数据根。
var ErrInvalidDependencies = errors.New("插件信任根接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总信任根接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
}

// Handler 提供信任根的读、写入与撤销。
type Handler struct {
	authorizer Authorizer
	store      *TrustStore
}

// NewHandler 创建信任根管理接口；依赖无效时拒绝装配，避免挂出永远 500 的路由。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	store, err := NewTrustStore(dependencies.AIHomeDir)
	if err != nil {
		return nil, errors.Join(ErrInvalidDependencies, err)
	}
	return &Handler{authorizer: dependencies.Authorizer, store: store}, nil
}

// ServeHTTP 按路径分派三个动作；三条路径都是管理密钥保护路径。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "plugin_trust_unavailable", "插件信任根服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "")
		return
	}
	switch request.URL.Path {
	case TrustedPath:
		handler.list(response, request)
	case TrustPath:
		handler.trust(response, request)
	case UntrustPath:
		handler.untrust(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "")
	}
}

// list 返回全部可信公钥。
func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	keys, err := handler.store.List()
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, trustedResponse{OK: true, Keys: keys})
}

// trust 请求体；publicKey 与 publicKeyPem 都是 Node 既有入口接受的字段。
type trustPayload struct {
	PublicKey    string `json:"publicKey"`
	PublicKeyPEM string `json:"publicKeyPem"`
	KeyID        string `json:"keyId"`
}

// untrust 请求体。
type untrustPayload struct {
	KeyID string `json:"keyId"`
}

// trust 把公钥写入信任根。重复登记同一把公钥是幂等的。
func (handler *Handler) trust(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var payload trustPayload
	if !decodePayload(response, request, &payload) {
		return
	}
	// 与 Node 的 input.publicKey || input.publicKeyPem 同义：只有空串才回落，
	// 纯空白仍按「公钥不能为空」报错。
	publicKey := payload.PublicKey
	if publicKey == "" {
		publicKey = payload.PublicKeyPEM
	}
	result, err := handler.store.Add(AddInput{PublicKey: publicKey, KeyID: payload.KeyID})
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, trustResponse{
		OK:          true,
		KeyID:       result.KeyID,
		File:        result.File,
		Fingerprint: result.Fingerprint,
	})
}

// untrust 按 keyId 撤销公钥；不存在的 keyId 返回 removed:false。
func (handler *Handler) untrust(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var payload untrustPayload
	if !decodePayload(response, request, &payload) {
		return
	}
	result, err := handler.store.Remove(payload.KeyID)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, untrustResponse{
		OK:      true,
		KeyID:   result.KeyID,
		Removed: result.Removed,
		File:    result.File,
	})
}

// requireMethod 拒绝错误的方法，并显式给出 Allow。
func requireMethod(response http.ResponseWriter, request *http.Request, method string) bool {
	if request.Method == method {
		return true
	}
	response.Header().Set("Allow", method)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	return false
}

// decodePayload 严格解码请求体：与 Node readJson 的错误码/文案保持同一套。
func decodePayload(response http.ResponseWriter, request *http.Request, target any) bool {
	err := httpjson.DecodeRequest(response, request, target, maxBodyBytes)
	switch {
	case err == nil:
		return true
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writeDomainError(response, http.StatusBadRequest, "plugin_request_too_large", "请求体过大")
	default:
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
	}
	return false
}

// writeStoreError 把信任根错误映射成 Node 插件管理面的错误形状。
//
// Node writeError 只把 runtime/revision/not_installed 少数码改成 5xx/409/404，
// 公钥、keyId、信任文件这三类都是参数/输入问题 → 400。
func writeStoreError(response http.ResponseWriter, err error) {
	var coded *Error
	if errors.As(err, &coded) {
		writeDomainError(response, http.StatusBadRequest, coded.Code, coded.Message)
		return
	}
	writeDomainError(response, http.StatusBadRequest, "plugin_error", err.Error())
}

// trustedResponse 与 Node GET /v0/plugins/trusted 的响应逐字段一致。
type trustedResponse struct {
	OK   bool         `json:"ok"`
	Keys []TrustedKey `json:"keys"`
}

// trustResponse 与 Node POST /v0/plugins/trust 的响应逐字段一致。
type trustResponse struct {
	OK          bool   `json:"ok"`
	KeyID       string `json:"keyId"`
	File        string `json:"file"`
	Fingerprint string `json:"fingerprint"`
}

// untrustResponse 与 Node POST /v0/plugins/untrust 的响应逐字段一致。
type untrustResponse struct {
	OK      bool   `json:"ok"`
	KeyID   string `json:"keyId"`
	Removed bool   `json:"removed"`
	File    string `json:"file"`
}

// errorView 复刻 Node writeError 的错误形状；diagnostics 只在领域错误时出现，
// 与 Node 的 { ok:false, error, message, diagnostics:[] } 对齐。
type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
	// Diagnostics 用指针区分「不出现」与「空数组」：Node 的领域错误固定带
	// diagnostics: []，而鉴权/方法/路径错误的响应体里没有这个字段。
	Diagnostics *[]any `json:"diagnostics,omitempty"`
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

// writeError 用于鉴权/方法/路径错误：Node 这些分支不带 message 与 diagnostics。
func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

// writeDomainError 用于领域错误：message 为空时回落到 code（Node PluginError 默认值），
// 并保留 diagnostics: [] 字段。
func writeDomainError(response http.ResponseWriter, status int, code string, message string) {
	if message == "" {
		message = code
	}
	diagnostics := []any{}
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message, Diagnostics: &diagnostics})
}
