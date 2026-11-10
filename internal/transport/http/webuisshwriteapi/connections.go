package webuisshwriteapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxLabelRunes   = 200
	maxHostBytes    = 255
	maxUserBytes    = 128
	maxIdentityFile = 4096
)

var connectionIDPattern = regexp.MustCompile(`^conn_[a-f0-9]{16}$`)

var authTypes = map[string]struct{}{
	authTypeAgent:    {},
	authTypeKey:      {},
	authTypeKeyFile:  {},
	authTypePassword: {},
}

// connectionInput 是 POST 解析后的必填 / 可选字段。
type connectionInput struct {
	Label              string
	Host               string
	User               string
	Port               int
	AuthType           string
	Password           string
	PrivateKey         string
	IdentityFile       string
	EgressConnectionID string
	ReverseTunnel      map[string]any
}

// updatePatch 用指针区分「字段缺省」与「显式清空」。
type updatePatch struct {
	label              *string
	host               *string
	user               *string
	port               *int
	authType           *string
	password           *string
	privateKey         *string
	identityFile       *string
	egressConnectionID *string
	reverseTunnelSet   bool
	reverseTunnel      map[string]any
}

func parseCreateInput(payload map[string]any) (connectionInput, *requestError) {
	var input connectionInput
	var valid bool
	if input.Label, _, valid = readStringField(payload, "label"); !valid {
		return input, invalidFieldType("label")
	}
	if input.Host, _, valid = readStringField(payload, "host"); !valid {
		return input, invalidFieldType("host")
	}
	if input.User, _, valid = readStringField(payload, "user"); !valid {
		return input, invalidFieldType("user")
	}
	port, present, valid := readPortField(payload, "port")
	if !valid {
		return input, invalidPort()
	}
	input.Port = 22
	if present {
		input.Port = port
	}
	authType, _, valid := readStringField(payload, "authType")
	if !valid {
		return input, invalidAuthType()
	}
	if authType == "" {
		authType = authTypeAgent
	}
	input.AuthType = authType
	if input.Password, _, valid = readStringField(payload, "password"); !valid {
		return input, invalidFieldType("password")
	}
	if input.PrivateKey, _, valid = readStringField(payload, "privateKey"); !valid {
		return input, invalidFieldType("privateKey")
	}
	if input.IdentityFile, _, valid = readStringField(payload, "identityFile"); !valid {
		return input, invalidFieldType("identityFile")
	}
	if input.EgressConnectionID, _, valid = readStringField(payload, "egressConnectionId"); !valid {
		return input, invalidFieldType("egressConnectionId")
	}
	tunnel, _, failure := readReverseTunnel(payload)
	if failure != nil {
		return input, failure
	}
	input.ReverseTunnel = tunnel
	return input, nil
}

func parseUpdatePatch(payload map[string]any) (updatePatch, *requestError) {
	var patch updatePatch
	var valid bool
	if patch.label, valid = presentTrimmedString(payload, "label"); !valid {
		return patch, invalidFieldType("label")
	}
	if patch.host, valid = presentTrimmedString(payload, "host"); !valid {
		return patch, invalidFieldType("host")
	}
	if patch.user, valid = presentTrimmedString(payload, "user"); !valid {
		return patch, invalidFieldType("user")
	}
	port, present, valid := readPortField(payload, "port")
	if !valid {
		return patch, invalidPort()
	}
	if present {
		patch.port = &port
	}
	if patch.authType, valid = presentTrimmedString(payload, "authType"); !valid {
		return patch, invalidAuthType()
	} else if patch.authType != nil && *patch.authType == "" {
		defaultType := authTypeAgent
		patch.authType = &defaultType
	}
	if patch.password, valid = presentTrimmedString(payload, "password"); !valid {
		return patch, invalidFieldType("password")
	}
	if patch.privateKey, valid = presentTrimmedString(payload, "privateKey"); !valid {
		return patch, invalidFieldType("privateKey")
	}
	if patch.identityFile, valid = presentTrimmedString(payload, "identityFile"); !valid {
		return patch, invalidFieldType("identityFile")
	}
	if patch.egressConnectionID, valid = presentTrimmedString(payload, "egressConnectionId"); !valid {
		return patch, invalidFieldType("egressConnectionId")
	}
	tunnel, tunnelPresent, failure := readReverseTunnel(payload)
	if failure != nil {
		return patch, failure
	}
	if tunnelPresent {
		patch.reverseTunnelSet = true
		patch.reverseTunnel = tunnel
	}
	return patch, nil
}

// presentTrimmedString 缺省时返回 nil；null 视为空串；非字符串类型非法。
func presentTrimmedString(payload map[string]any, key string) (*string, bool) {
	raw, exists := payload[key]
	if !exists {
		return nil, true
	}
	if raw == nil {
		value := ""
		return &value, true
	}
	text, ok := raw.(string)
	if !ok {
		return nil, false
	}
	value := strings.TrimSpace(text)
	return &value, true
}

func readStringField(payload map[string]any, key string) (string, bool, bool) {
	value, valid := presentTrimmedString(payload, key)
	if !valid {
		return "", false, false
	}
	if value == nil {
		return "", false, true
	}
	return *value, true, true
}

func readPortField(payload map[string]any, key string) (int, bool, bool) {
	raw, exists := payload[key]
	if !exists || raw == nil {
		return 0, false, true
	}
	number, ok := raw.(float64)
	if !ok || math.Trunc(number) != number || number < 1 || number > 65535 {
		return 0, true, false
	}
	return int(number), true, true
}

// readReverseTunnel 返回 (规范化的隧道, 字段是否出现, 失败)。
// tunnel 为 nil 表示关闭 / 未配置。
func readReverseTunnel(payload map[string]any) (map[string]any, bool, *requestError) {
	raw, exists := payload["reverseTunnel"]
	if !exists {
		return nil, false, nil
	}
	if raw == nil {
		return nil, true, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return nil, true, invalidReverseTunnel("反向隧道必须是对象")
	}
	remotePort, failure := integerField(object, "remotePort", 0)
	if failure != nil {
		return nil, true, failure
	}
	if remotePort == 0 {
		return nil, true, nil
	}
	if remotePort < 1024 || remotePort > 65535 {
		return nil, true, invalidReverseTunnel("反向隧道端口必须在 1024–65535")
	}
	localPort, failure := integerField(object, "localPort", 22)
	if failure != nil {
		return nil, true, failure
	}
	if localPort < 1 || localPort > 65535 {
		return nil, true, invalidReverseTunnel("本机 SSH 端口无效")
	}
	return map[string]any{"remotePort": remotePort, "localPort": localPort}, true, nil
}

func integerField(object map[string]any, key string, fallback int) (int, *requestError) {
	raw, exists := object[key]
	if !exists || raw == nil {
		return fallback, nil
	}
	number, ok := raw.(float64)
	if !ok || math.Trunc(number) != number || number < 0 || number > 65535 {
		return 0, invalidReverseTunnel("隧道端口必须是整数")
	}
	return int(number), nil
}

func buildConnection(id string, input connectionInput, connections []map[string]any) (map[string]any, *requestError) {
	label := strings.TrimSpace(input.Label)
	host := strings.TrimSpace(input.Host)
	user := strings.TrimSpace(input.User)
	if label == "" || host == "" || user == "" {
		return nil, &requestError{status: http.StatusBadRequest, code: "missing_fields", message: "Label, Host and User are required."}
	}
	if failure := validateFields(label, host, user); failure != nil {
		return nil, failure
	}
	if _, ok := authTypes[input.AuthType]; !ok {
		return nil, invalidAuthType()
	}
	if input.AuthType == authTypeKeyFile {
		if failure := validateIdentityFile(input.IdentityFile); failure != nil {
			return nil, failure
		}
	}
	egress := strings.TrimSpace(input.EgressConnectionID)
	if egress != "" && !connectionExists(connections, egress) {
		return nil, &requestError{status: http.StatusBadRequest, code: "invalid_egress", message: "出网代理指向的连接不存在"}
	}
	connection := map[string]any{
		"id":                 id,
		"label":              label,
		"host":               host,
		"port":               input.Port,
		"user":               user,
		"authType":           input.AuthType,
		"password":           input.Password,
		"privateKey":         input.PrivateKey,
		"identityFile":       input.IdentityFile,
		"egressConnectionId": egress,
		"createdAt":          time.Now().UnixMilli(),
	}
	if input.ReverseTunnel != nil {
		connection["reverseTunnel"] = input.ReverseTunnel
	}
	clearInactiveCredentials(connection)
	return connection, nil
}

func (patch updatePatch) apply(connection map[string]any, connections []map[string]any, id string) *requestError {
	if patch.label != nil {
		connection["label"] = *patch.label
	}
	if patch.host != nil {
		connection["host"] = *patch.host
	}
	if patch.user != nil {
		connection["user"] = *patch.user
	}
	if patch.port != nil {
		connection["port"] = *patch.port
	}
	if patch.authType != nil {
		connection["authType"] = *patch.authType
	}
	// 掩码哨兵代表「界面回传的脱敏值」，不能覆盖真实凭据。
	if patch.password != nil && *patch.password != passwordMask {
		connection["password"] = *patch.password
	}
	if patch.privateKey != nil && *patch.privateKey != passwordMask {
		connection["privateKey"] = *patch.privateKey
	}
	if patch.identityFile != nil {
		connection["identityFile"] = *patch.identityFile
	}
	if patch.reverseTunnelSet {
		if patch.reverseTunnel == nil {
			delete(connection, "reverseTunnel")
		} else {
			connection["reverseTunnel"] = patch.reverseTunnel
		}
	}
	if patch.egressConnectionID != nil {
		egress := strings.TrimSpace(*patch.egressConnectionID)
		if egress != "" {
			if egress == id {
				return &requestError{status: http.StatusBadRequest, code: "invalid_egress", message: "出网代理不能是这条连接自己"}
			}
			if !connectionExists(connections, egress) {
				return &requestError{status: http.StatusBadRequest, code: "invalid_egress", message: "出网代理指向的连接不存在"}
			}
		}
		connection["egressConnectionId"] = egress
	}
	return nil
}

func validateConnection(connection map[string]any) *requestError {
	label := connectionString(connection, "label")
	host := connectionString(connection, "host")
	user := connectionString(connection, "user")
	if label == "" || host == "" || user == "" {
		return &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: "Label, Host and User cannot be empty."}
	}
	if failure := validateFields(label, host, user); failure != nil {
		return failure
	}
	authType := connectionString(connection, "authType")
	if _, ok := authTypes[authType]; !ok {
		return invalidAuthType()
	}
	if authType == authTypeKeyFile {
		if failure := validateIdentityFile(connectionString(connection, "identityFile")); failure != nil {
			return failure
		}
	}
	port, ok := integerValue(connection["port"])
	if !ok || port < 1 || port > 65535 {
		return invalidPort()
	}
	return nil
}

func validateFields(label string, host string, user string) *requestError {
	label = strings.TrimSpace(label)
	host = strings.TrimSpace(host)
	user = strings.TrimSpace(user)
	if !validLabel(label) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_label", message: "Label 为空、过长或含控制字符"}
	}
	if !validHost(host) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_host", message: "Host 含非法字符或以 - 开头"}
	}
	if !validUser(user) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_user", message: "User 含非法字符或以 - 开头"}
	}
	return nil
}

func validLabel(label string) bool {
	if label == "" || utf8.RuneCountInString(label) > maxLabelRunes {
		return false
	}
	return !strings.ContainsFunc(label, unicode.IsControl)
}

// validHost 只放行主机名 / IPv4 / IPv6（含 [ ] 与 %zone）；拒绝空白、控制字符、
// @ / 斜杠 / shell 元字符，避免 user@host 歧义与参数注入。
func validHost(host string) bool {
	if host == "" || len(host) > maxHostBytes || strings.HasPrefix(host, "-") {
		return false
	}
	for _, character := range host {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '.' || character == '-' || character == '_':
		case character == ':' || character == '%' || character == '[' || character == ']':
		default:
			return false
		}
	}
	return true
}

// validUser 放行常规 Unix / AD 用户名；拒绝 @ 与空白，避免拼接 user@host 时改写目标。
func validUser(user string) bool {
	if user == "" || len(user) > maxUserBytes || strings.HasPrefix(user, "-") {
		return false
	}
	for _, character := range user {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '.' || character == '_' || character == '-' || character == '\\':
		default:
			return false
		}
	}
	return true
}

// validateIdentityFile 只做语法检查（绝对路径或 ~/ 开头、无控制字符、无 ..）。
// 「必须在 ~/.ssh 内且权限不开放」需要宿主 homeDir，Go 侧尚未接入，见阻塞项。
func validateIdentityFile(identityFile string) *requestError {
	identityFile = strings.TrimSpace(identityFile)
	if identityFile == "" {
		return &requestError{status: http.StatusBadRequest, code: "invalid_identity_file", message: "SSH identity file path is required."}
	}
	if len(identityFile) > maxIdentityFile || strings.ContainsFunc(identityFile, unicode.IsControl) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_identity_file", message: "SSH identity file is invalid."}
	}
	if !filepath.IsAbs(identityFile) && !strings.HasPrefix(identityFile, "~/") {
		return &requestError{status: http.StatusBadRequest, code: "invalid_identity_file", message: "SSH identity file path must be absolute or start with ~/."}
	}
	for _, segment := range strings.Split(strings.ReplaceAll(identityFile, "\\", "/"), "/") {
		if segment == ".." {
			return &requestError{status: http.StatusBadRequest, code: "invalid_identity_file", message: "SSH identity file must not contain .."}
		}
	}
	return nil
}

// clearInactiveCredentials 与 Node 一致：非当前 authType 的凭据一律写空。
func clearInactiveCredentials(connection map[string]any) {
	authType := connectionString(connection, "authType")
	if authType == "" {
		authType = authTypeAgent
	}
	if authType != authTypePassword {
		connection["password"] = ""
	}
	if authType != authTypeKey {
		connection["privateKey"] = ""
	}
	if authType != authTypeKeyFile {
		connection["identityFile"] = ""
	}
}

func decodeConnections(current string, found bool) ([]map[string]any, *requestError) {
	connections := make([]map[string]any, 0)
	if !found || strings.TrimSpace(current) == "" {
		return connections, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(current), &decoded); err != nil {
		return nil, corruptStore()
	}
	list, ok := decoded.([]any)
	if !ok {
		return nil, corruptStore()
	}
	for _, item := range list {
		connection, ok := item.(map[string]any)
		if !ok {
			return nil, corruptStore()
		}
		connections = append(connections, connection)
	}
	return connections, nil
}

func corruptStore() *requestError {
	return &requestError{
		status:  http.StatusInternalServerError,
		code:    "ssh_connections_invalid",
		message: "ssh_connections 不是合法的连接数组，拒绝覆盖",
	}
}

func newConnectionID(connections []map[string]any) (string, *requestError) {
	for attempt := 0; attempt < 8; attempt++ {
		buffer := make([]byte, 8)
		if _, err := rand.Read(buffer); err != nil {
			return "", &requestError{status: http.StatusInternalServerError, code: "ssh_connections_write_failed"}
		}
		candidate := "conn_" + hex.EncodeToString(buffer)
		if !connectionExists(connections, candidate) {
			return candidate, nil
		}
	}
	return "", &requestError{status: http.StatusInternalServerError, code: "ssh_connections_write_failed", message: "无法生成唯一连接 id"}
}

func indexOfConnection(connections []map[string]any, id string) int {
	for index, connection := range connections {
		if connectionString(connection, "id") == id {
			return index
		}
	}
	return -1
}

func connectionExists(connections []map[string]any, id string) bool {
	return indexOfConnection(connections, id) >= 0
}

func connectionString(connection map[string]any, key string) string {
	value, _ := connection[key].(string)
	return strings.TrimSpace(value)
}

func integerValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		if math.Trunc(typed) != typed || typed < 0 || typed > 65535 {
			return 0, false
		}
		return int(typed), true
	default:
		return 0, false
	}
}

// sanitizeConnection 复刻 Node：password / privateKey 有真值 → ******，否则空串。
func sanitizeConnection(connection map[string]any) map[string]any {
	sanitized := make(map[string]any, len(connection))
	for key, value := range connection {
		sanitized[key] = value
	}
	sanitized["password"] = maskSecret(connection["password"])
	sanitized["privateKey"] = maskSecret(connection["privateKey"])
	return sanitized
}

func maskSecret(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		if typed == "" {
			return ""
		}
		return passwordMask
	case bool:
		if !typed {
			return ""
		}
		return passwordMask
	case float64:
		if typed == 0 {
			return ""
		}
		return passwordMask
	default:
		return passwordMask
	}
}

func invalidFieldType(field string) *requestError {
	return &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: field + " 必须是字符串"}
}

func invalidAuthType() *requestError {
	return &requestError{status: http.StatusBadRequest, code: "invalid_auth_type", message: "Unsupported SSH authentication type."}
}

func invalidPort() *requestError {
	return &requestError{status: http.StatusBadRequest, code: "invalid_port", message: "Port must be an integer between 1 and 65535."}
}

func invalidReverseTunnel(message string) *requestError {
	return &requestError{status: http.StatusBadRequest, code: "invalid_reverse_tunnel", message: message}
}
