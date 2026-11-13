// Package webuimanagementkeyapi 提供 WebUI Management Key 即时轮换契约。
//
// 契约来源：lib/server/web-ui-router.js 的
// POST /v0/webui/server-config/management-key/rotate 分支，语义由
// lib/server/webui-config-routes.js 的 handleRotateManagementKeyRequest 与
// lib/server/management-key-rotation.js 的 createManagementKeyRotationService 定义：
//
//   - 旧 Key 必须随请求以 Authorization: Bearer 提交。轮换比普通 WebUI 门更严格：
//     永远要求当前凭据，否则第三方页面一个 CSRF POST 就能改掉 localhost 的 Key。
//   - 请求体 managementKey 是「新 Key」，不是旧 Key。字段名与 Node 一致。
//   - 新 Key 写进 app-state.db 的 config:server，写成功才算生效；写完回读确认。
//
// 与 Node 的差异（有意为之）：Node 只接受客户端指定新 Key，本包在请求体省略或留空时
// 用 crypto/rand 生成一个，并在响应里回显一次——客户端不指定就说明它拿不到新 Key，
// 不回显会把它锁在门外。响应字段仍是 Node 的超集，客户端指定新 Key 时行为一致。
//
// 安全约束：错误信息与响应头之外不出现 Key 明文；旧 Key 比较用常量时间摘要比较；
// 响应一律 no-store，避免新 Key 落进任何缓存。
package webuimanagementkeyapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// Path 是 Management Key 轮换的管理契约路径。
	//
	//	POST /v1/management/webui/server-config/management-key/rotate
	Path = "/v1/management/webui/server-config/management-key/rotate"

	// 与 Node MIN_MANAGEMENT_KEY_LENGTH / MAX_MANAGEMENT_KEY_LENGTH 对齐。
	minManagementKeyLength = 32
	maxManagementKeyLength = 8192

	// maxRequestBytes 与 Node readRequestBody({maxBytes: 16 * 1024}) 对齐。
	maxRequestBytes = 16 * 1024

	// generatedKeyBytes 是服务端生成新 Key 的熵：32 字节 base64url 后 43 字符，
	// 高于 minManagementKeyLength。
	generatedKeyBytes = 32

	// serverConfigKey 是 Node app-state 里 server 配置的唯一持久化键。
	serverConfigKey = "config:server"

	managementKeyField = "managementKey"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("Management Key 轮换接口依赖无效")

// errInvalidStoredConfig 表示 config:server 存的不是 JSON 对象，无法安全合并。
var errInvalidStoredConfig = errors.New("config:server 不是 JSON 对象")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读写 app-state.db 的 config:server 原文。
//
// 方法集与 webuiserverconfigapi.Store 一致：*webuiserverconfigapi.Source 可以直接
// 当作本包的 Store 使用，接线时不必重复打开数据库。
type Store interface {
	ReadServerConfig(ctx context.Context) (string, bool, error)
	// UpdateServerConfig 在立即事务里读改写 config:server，避免把并发写入的字段覆盖回旧值。
	UpdateServerConfig(ctx context.Context, mutate func(current string, found bool) (string, error)) error
}

// Generator 生成一个新的 Management Key；可注入，测试里用来固定取值或制造失败。
type Generator func() (string, error)

// Dependencies 汇总轮换依赖。Generator 为零值时使用 NewRandomGenerator。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
	Generator  Generator
}

// Handler 是 Management Key 轮换的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	store      Store
	generator  Generator
}

// NewHandler 校验依赖并创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	generator := dependencies.Generator
	if generator == nil {
		generator = NewRandomGenerator()
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		generator:  generator,
	}, nil
}

// NewRandomGenerator 返回 crypto/rand + base64url（无填充）的新 Key 生成器。
func NewRandomGenerator() Generator {
	return func() (string, error) {
		buffer := make([]byte, generatedKeyBytes)
		if _, err := rand.Read(buffer); err != nil {
			return "", err
		}
		return base64.RawURLEncoding.EncodeToString(buffer), nil
	}
}

// rotateResponse 是成功响应；前三个字段与 Node 完全一致，managementKey/generated 是本包新增。
type rotateResponse struct {
	OK                      bool   `json:"ok"`
	ManagementKeyConfigured bool   `json:"managementKeyConfigured"`
	RotatedAt               int64  `json:"rotatedAt"`
	ManagementKey           string `json:"managementKey"`
	Generated               bool   `json:"generated"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// rotationFailure 是可直接映射成 HTTP 响应的轮换失败。
type rotationFailure struct {
	status  int
	code    string
	message string
}

// ServeHTTP 只接受 POST；鉴权沿用共享 Authorizer，另外强制校验旧 Key。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 响应可能包含新 Key：先关掉所有缓存与引用传递，错误响应也一并生效。
	setNoStoreHeaders(response)
	if handler == nil || handler.authorizer == nil || handler.store == nil || handler.generator == nil {
		writeError(response, http.StatusServiceUnavailable, "management_key_rotation_unavailable", "Management Key 轮换不可用。")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	view, failure := handler.rotate(response, request)
	if failure != nil {
		writeError(response, failure.status, failure.code, failure.message)
		return
	}
	writeJSON(response, http.StatusOK, view)
}

// rotate 复刻 Node 的校验顺序：当前 Key → 外部来源 → 新 Key → 同值 → 落库 → 回读确认。
func (handler *Handler) rotate(response http.ResponseWriter, request *http.Request) (*rotateResponse, *rotationFailure) {
	ctx := request.Context()

	payload, ok := readPayload(response, request)
	if !ok {
		return nil, &rotationFailure{http.StatusBadRequest, "invalid_payload", ""}
	}

	raw, found, err := handler.store.ReadServerConfig(ctx)
	if err != nil {
		return nil, &rotationFailure{http.StatusInternalServerError, "management_key_rotation_failed", "无法读取当前 Server 配置。"}
	}
	current, err := managementKeyFromConfig(raw, found)
	if err != nil {
		return nil, &rotationFailure{http.StatusInternalServerError, "management_key_rotation_failed", "当前 Server 配置不是合法 JSON 对象。"}
	}

	bearer, hasBearer := bearerCredential(request)
	if current == "" {
		// config:server 没有 Key，但调用方拿着一个能过鉴权的 Key：说明当前 Key 来自
		// 启动参数或环境变量（Node 的 managementKeySource），客户端不能轮换。
		if hasBearer {
			return nil, &rotationFailure{http.StatusConflict, "management_key_external_source", "当前 Server 的 Management Key 由启动参数或环境变量管理，不能由客户端轮换。"}
		}
		return nil, &rotationFailure{http.StatusServiceUnavailable, "management_key_not_configured", "当前 Server 未配置 Management Key。"}
	}
	submittedCurrent := ""
	if rawCurrent, okCurrent := payload["currentManagementKey"].(string); okCurrent {
		submittedCurrent = strings.TrimSpace(rawCurrent)
	}
	if !credentialsEqual(bearer, current) && (submittedCurrent == "" || !credentialsEqual(submittedCurrent, current)) {
		return nil, &rotationFailure{http.StatusUnauthorized, "webui_unauthorized", "当前 Management Key 无效。"}
	}

	replacement, generated, failure := handler.resolveReplacement(payload)
	if failure != nil {
		return nil, failure
	}
	if replacement == current {
		return nil, &rotationFailure{http.StatusConflict, "management_key_unchanged", "新 Management Key 不能与当前 Key 相同。"}
	}

	err = handler.store.UpdateServerConfig(ctx, func(stored string, storedFound bool) (string, error) {
		return withManagementKey(stored, storedFound, replacement)
	})
	if err != nil {
		return nil, &rotationFailure{http.StatusInternalServerError, "management_key_rotation_persist_failed", "Server 无法保存新的 Management Key。"}
	}
	confirmedRaw, confirmedFound, err := handler.store.ReadServerConfig(ctx)
	if err != nil {
		return nil, &rotationFailure{http.StatusInternalServerError, "management_key_rotation_persist_failed", "Server 未能确认新的 Management Key。"}
	}
	confirmed, err := managementKeyFromConfig(confirmedRaw, confirmedFound)
	if err != nil || confirmed != replacement {
		return nil, &rotationFailure{http.StatusInternalServerError, "management_key_rotation_persist_failed", "Server 未能确认新的 Management Key。"}
	}

	return &rotateResponse{
		OK:                      true,
		ManagementKeyConfigured: true,
		RotatedAt:               time.Now().UnixMilli(),
		ManagementKey:           replacement,
		Generated:               generated,
	}, nil
}

// resolveReplacement 决定新 Key：请求体给了就用它（Node 路径），否则服务端生成。
func (handler *Handler) resolveReplacement(payload map[string]any) (string, bool, *rotationFailure) {
	if value, exists := payload[managementKeyField]; exists && value != nil {
		text, isString := value.(string)
		if !isString {
			return "", false, &rotationFailure{http.StatusBadRequest, "invalid_payload", ""}
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			if failure := validateReplacement(trimmed); failure != nil {
				return "", false, failure
			}
			return trimmed, false, nil
		}
	}
	generated, err := handler.generator()
	if err != nil {
		return "", false, &rotationFailure{http.StatusInternalServerError, "management_key_generation_failed", "Server 无法生成新的 Management Key。"}
	}
	trimmed := strings.TrimSpace(generated)
	if failure := validateReplacement(trimmed); failure != nil {
		return "", false, &rotationFailure{http.StatusInternalServerError, "management_key_generation_failed", "Server 生成的新 Management Key 不合法。"}
	}
	return trimmed, true, nil
}

// validateReplacement 复刻 Node normalizeReplacementManagementKey。
func validateReplacement(key string) *rotationFailure {
	if len(key) < minManagementKeyLength || len(key) > maxManagementKeyLength || strings.ContainsAny(key, "\r\n\x00") {
		return &rotationFailure{
			http.StatusBadRequest,
			"invalid_management_key",
			"Management Key 必须为 32-8192 个字符，且不能包含换行。",
		}
	}
	return nil
}

// readPayload 读取请求体。空体视为「不指定新 Key」，交给生成器；其余非法形态一律拒绝。
func readPayload(response http.ResponseWriter, request *http.Request) (map[string]any, bool) {
	body := http.MaxBytesReader(response, request.Body, maxRequestBytes)
	document, err := io.ReadAll(body)
	if err != nil {
		return nil, false
	}
	if len(bytes.TrimSpace(document)) == 0 {
		return map[string]any{}, true
	}
	var decoded any
	if err := json.Unmarshal(document, &decoded); err != nil {
		return nil, false
	}
	payload, isObject := decoded.(map[string]any)
	if !isObject {
		return nil, false
	}
	return payload, true
}

// managementKeyFromConfig 从 config:server 原文取出当前 Key；缺失/空串都算未配置。
func managementKeyFromConfig(raw string, found bool) (string, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return "", err
	}
	config, isObject := decoded.(map[string]any)
	if !isObject {
		return "", errInvalidStoredConfig
	}
	value, isString := config[managementKeyField].(string)
	if !isString {
		return "", nil
	}
	return strings.TrimSpace(value), nil
}

// withManagementKey 只替换 managementKey，其余字段原样保留（Node mergeServerConfigPatch 的单键语义）。
func withManagementKey(raw string, found bool, key string) (string, error) {
	config := map[string]any{}
	if found && strings.TrimSpace(raw) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
			return "", err
		}
		object, isObject := decoded.(map[string]any)
		if !isObject {
			return "", errInvalidStoredConfig
		}
		config = object
	}
	config[managementKeyField] = key
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// bearerCredential 解析标准 Authorization: Bearer；缺失或不合规时 ok=false。
func bearerCredential(request *http.Request) (string, bool) {
	headers := request.Header.Values("Authorization")
	if len(headers) != 1 {
		return "", false
	}
	scheme, token, found := strings.Cut(strings.TrimSpace(headers[0]), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}

// credentialsEqual 用摘要做常量时间比较：长度不同也不早退，不泄露 Key 长度。
func credentialsEqual(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftDigest := sha256.Sum256([]byte(left))
	rightDigest := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(leftDigest[:], rightDigest[:]) == 1
}

func setNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
