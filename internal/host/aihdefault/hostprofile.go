package aihdefault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ManagedStateFileName 记录「当前文件是不是 AIH 写的那份、接管前是什么」。
const ManagedStateFileName = ".aih-server-default-state.json"

// 宿主配置归属策略。file：整文件归 AIH，任何外部改动都失败关闭。
// claude-env（按 env 字段判定）仍留在 Node，本包遇到它会明确拒绝而不是猜。
const (
	CodeInvalidState             = "invalid_gateway_default_state"
	CodeHostConfigChanged        = "gateway_default_host_config_changed"
	CodeHostConfigNotRegularFile = "host_config_not_regular_file"
	CodeOwnershipUnsupported     = "gateway_profile_ownership_unsupported"
)

// Ownership 是受管文件的归属策略标识。
type Ownership string

// OwnershipFile 表示整文件由 AIH 托管（opencode、kimi、codex 一类）。
const OwnershipFile Ownership = "file"

// OwnershipClaudeEnv 只托管 Claude settings.json 的凭据 env 字段；Claude Code
// 自己改写权限等其它字段不影响归属判断。
const OwnershipClaudeEnv Ownership = "claude-env"

var managedHashPattern = regexp.MustCompile("^[a-f0-9]{64}$")

// Takeover 只给显式命令（set-default / unset-default）使用：外部改动后的文件
// 若不像 AIH 网关写的，就采纳为新的还原基线。后台同步传 nil，失败关闭。
type Takeover struct {
	GatewayURLs []string
}

// TakeoverDecision 描述本次接管判断，供调用方提示用户。
type TakeoverDecision struct {
	ExternallyChanged bool `json:"externallyChanged"`
	AdoptedAsBaseline bool `json:"adoptedAsBaseline"`
	StateReset        bool `json:"stateReset,omitempty"`
}

// Target 是一次落点/还原的作用对象：某个宿主全局目录里的一个配置文件。
type Target struct {
	Directory string
	FileName  string
	Ownership Ownership
	Takeover  *Takeover
}

// BuildContent 在「当前内容 + 文件是否存在」之上生成新的整文件内容。
type BuildContent func(current string, existed bool) (string, error)

// ActivateResult 是落点结果；Takeover 非空表示这次写入了接管判断。
type ActivateResult struct {
	ConfigPath string
	Takeover   *TakeoverDecision
}

// DeactivateResult 是还原结果；Restored=false 表示本来就没有生效的受管状态。
type DeactivateResult struct {
	ConfigPath string
	Restored   bool
	Takeover   *TakeoverDecision
}

// ManagedState 是落点状态文件的形状，字段名与 Node 完全一致。
type ManagedState struct {
	FileName        string `json:"fileName"`
	Active          bool   `json:"active"`
	Ownership       string `json:"ownership,omitempty"`
	OriginalExisted bool   `json:"originalExisted"`
	Original        string `json:"original"`
	ManagedHash     string `json:"managedHash,omitempty"`
}

type inactiveState struct {
	FileName string `json:"fileName"`
	Active   bool   `json:"active"`
}

type stateDocument struct {
	FileName        *string `json:"fileName"`
	Active          *bool   `json:"active"`
	Ownership       *string `json:"ownership"`
	OriginalExisted *bool   `json:"originalExisted"`
	Original        *string `json:"original"`
	ManagedHash     *string `json:"managedHash"`
}

type inspection struct {
	state          *ManagedState
	current        string
	currentExisted bool
	matchesManaged bool
	takeover       *TakeoverDecision
}

// ActivateProfile 把目标文件写成 build 生成的内容，并记录接管前原值。
// 顺序与 Node 一致：先写状态、再写配置。
func ActivateProfile(target Target, build BuildContent) (ActivateResult, error) {
	if err := target.validate(); err != nil {
		return ActivateResult{}, err
	}
	if build == nil {
		return ActivateResult{}, fmt.Errorf("aihdefault: build 不能为空")
	}
	inspected, err := inspectTarget(target)
	if err != nil {
		return ActivateResult{}, err
	}
	nextContent, err := build(inspected.current, inspected.currentExisted)
	if err != nil {
		return ActivateResult{}, err
	}
	keepBaseline := inspected.state != nil && inspected.state.Active &&
		!(inspected.takeover != nil && inspected.takeover.AdoptedAsBaseline)
	nextState := ManagedState{
		FileName:    target.FileName,
		Active:      true,
		ManagedHash: managedHashFor(target.Ownership, nextContent),
	}
	if target.Ownership == OwnershipClaudeEnv {
		nextState.Ownership = string(OwnershipClaudeEnv)
	}
	if keepBaseline {
		nextState.OriginalExisted = inspected.state.OriginalExisted
		nextState.Original = inspected.state.Original
	} else {
		nextState.OriginalExisted = inspected.currentExisted
		nextState.Original = inspected.current
	}
	if err := writePrivateJSON(statePath(target), nextState); err != nil {
		return ActivateResult{}, err
	}
	if err := writePrivateFile(configPath(target), nextContent); err != nil {
		return ActivateResult{}, err
	}
	return ActivateResult{ConfigPath: configPath(target), Takeover: inspected.takeover}, nil
}

// DeactivateProfile 把托管字段还原到接管前的值；受管状态标记为未生效。
func DeactivateProfile(target Target) (DeactivateResult, error) {
	if err := target.validate(); err != nil {
		return DeactivateResult{}, err
	}
	inspected, err := inspectTarget(target)
	if err != nil {
		return DeactivateResult{}, err
	}
	if inspected.state == nil || !inspected.state.Active {
		return DeactivateResult{ConfigPath: configPath(target)}, nil
	}
	restoreManaged := ownershipMatchesManaged(target.Ownership, inspected.state, inspected.current, inspected.currentExisted) ||
		(inspected.takeover != nil && !inspected.takeover.AdoptedAsBaseline)
	if restoreManaged {
		if target.Ownership == OwnershipClaudeEnv {
			restored, contentExisted, restoreErr := restoreClaudeOwnedContent(inspected.current, inspected.state)
			if restoreErr != nil {
				return DeactivateResult{}, restoreErr
			}
			if !contentExisted {
				if err := removeFile(configPath(target)); err != nil {
					return DeactivateResult{}, err
				}
			} else if err := writePrivateFile(configPath(target), restored); err != nil {
				return DeactivateResult{}, err
			}
		} else if inspected.state.OriginalExisted {
			if err := writePrivateFile(configPath(target), inspected.state.Original); err != nil {
				return DeactivateResult{}, err
			}
		} else if err := removeFile(configPath(target)); err != nil {
			return DeactivateResult{}, err
		}
	}
	if err := writePrivateJSON(statePath(target), inactiveState{FileName: target.FileName}); err != nil {
		return DeactivateResult{}, err
	}
	return DeactivateResult{
		ConfigPath: configPath(target),
		Restored:   true,
		Takeover:   inspected.takeover,
	}, nil
}

// VerifyProfile 只做归属检查，不写任何文件；用于「还原前确认宿主没被外部改动」。
func VerifyProfile(target Target) error {
	if err := target.validate(); err != nil {
		return err
	}
	_, err := inspectTarget(target)
	return err
}

func inspectTarget(target Target) (inspection, error) {
	state, stateErr := readManagedState(statePath(target), target.FileName)
	stateReset := false
	if stateErr != nil {
		if target.Takeover == nil || CodeOf(stateErr) != CodeInvalidState {
			return inspection{}, stateErr
		}
		state = nil
		stateReset = true
	}
	current, existed, err := readRegularFile(configPath(target))
	if err != nil {
		return inspection{}, err
	}
	inspected := inspection{state: state, current: current, currentExisted: existed}
	if state != nil && state.Active {
		inspected.matchesManaged = ownershipMatchesManaged(target.Ownership, state, current, existed)
		matchesOriginal := ownershipMatchesOriginal(target.Ownership, state, current, existed)
		if !inspected.matchesManaged && !matchesOriginal {
			if target.Takeover == nil {
				return inspection{}, newError(CodeHostConfigChanged, nil)
			}
			inspected.takeover = &TakeoverDecision{
				ExternallyChanged: true,
				AdoptedAsBaseline: !looksManaged(current, target),
			}
		}
		return inspected, nil
	}
	if stateReset {
		inspected.takeover = &TakeoverDecision{AdoptedAsBaseline: true, StateReset: true}
	}
	return inspected, nil
}

// looksManaged 判断当前内容是否仍带 AIH 网关痕迹。
func looksManaged(current string, target Target) bool {
	takeover := target.Takeover
	if takeover == nil {
		return false
	}
	if target.Ownership == OwnershipClaudeEnv {
		projection, ok := claudeOwnedProjection(current)
		if !ok {
			return false
		}
		if strings.TrimSpace(projection["pin"]) != "" {
			return true
		}
		baseURL := strings.TrimSpace(projection["ANTHROPIC_BASE_URL"])
		if baseURL == "" {
			return false
		}
		for _, rawURL := range takeover.GatewayURLs {
			if strings.TrimSpace(rawURL) != "" && normalizeBaseURLLoose(rawURL) == normalizeBaseURLLoose(baseURL) {
				return true
			}
		}
		return false
	}
	for _, rawURL := range takeover.GatewayURLs {
		url := strings.TrimSpace(rawURL)
		if url != "" && strings.Contains(current, url) {
			return true
		}
	}
	return false
}

var claudeCredentialEnvKeys = []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"}

const claudeCustomHeadersEnv = "ANTHROPIC_CUSTOM_HEADERS"
const claudePinHeader = "x-account-ref:"

func parseClaudeSettings(content string) (map[string]json.RawMessage, bool) {
	if strings.TrimSpace(content) == "" {
		return map[string]json.RawMessage{}, true
	}
	var document map[string]json.RawMessage
	if json.Unmarshal([]byte(content), &document) != nil || document == nil {
		return nil, false
	}
	if raw, ok := document["env"]; ok {
		var env map[string]json.RawMessage
		if json.Unmarshal(raw, &env) != nil || env == nil {
			return nil, false
		}
	}
	return document, true
}

// claudeOwnedProjection 只取 AIH 托管的三个凭据变量与钉选头行。
func claudeOwnedProjection(content string) (map[string]string, bool) {
	document, ok := parseClaudeSettings(content)
	if !ok {
		return nil, false
	}
	projection := map[string]string{}
	var env map[string]json.RawMessage
	if raw, present := document["env"]; present {
		_ = json.Unmarshal(raw, &env)
	}
	for _, key := range claudeCredentialEnvKeys {
		if raw, present := env[key]; present {
			var value string
			if json.Unmarshal(raw, &value) == nil {
				projection[key] = value
			}
		}
	}
	var headers string
	if raw, present := env[claudeCustomHeadersEnv]; present {
		_ = json.Unmarshal(raw, &headers)
	}
	for _, line := range strings.Split(headers, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToLower(trimmed), claudePinHeader) {
			projection["pin"] = trimmed
			break
		}
	}
	return projection, true
}

func canonicalProjectionHash(projection map[string]string) string {
	encoded, _ := json.Marshal(projection)
	return contentHash(string(encoded))
}

func sameProjection(left, right map[string]string) bool {
	if left == nil || right == nil {
		return false
	}
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func managedHashFor(ownership Ownership, content string) string {
	if ownership == OwnershipClaudeEnv {
		projection, ok := claudeOwnedProjection(content)
		if !ok {
			return contentHash("null")
		}
		return canonicalProjectionHash(projection)
	}
	return contentHash(content)
}

func ownershipMatchesManaged(ownership Ownership, state *ManagedState, current string, existed bool) bool {
	if ownership != OwnershipClaudeEnv {
		return existed && contentHash(current) == state.ManagedHash
	}
	projection, ok := claudeOwnedProjection(current)
	if !ok {
		return false
	}
	if state.Ownership == string(OwnershipClaudeEnv) {
		return canonicalProjectionHash(projection) == state.ManagedHash
	}
	// 旧版状态按整文件哈希记录：Claude Code 改过权限后必然对不上。
	if existed && contentHash(current) == state.ManagedHash {
		return true
	}
	originalProjection, _ := claudeOwnedProjection(state.Original)
	return !sameProjection(projection, originalProjection)
}

func ownershipMatchesOriginal(ownership Ownership, state *ManagedState, current string, existed bool) bool {
	if ownership != OwnershipClaudeEnv {
		return (!state.OriginalExisted && !existed) ||
			(state.OriginalExisted && existed && current == state.Original)
	}
	currentProjection, ok := claudeOwnedProjection(current)
	if !ok {
		return false
	}
	originalProjection, originalOK := claudeOwnedProjection(state.Original)
	return originalOK && sameProjection(currentProjection, originalProjection)
}

// restoreClaudeOwnedContent 把 AIH 托管的 env 字段还原为接管前的值，保留 Claude
// Code 之后写入的权限等其它字段。返回值第二项表示是否应写文件（false = 删除）。
func restoreClaudeOwnedContent(current string, state *ManagedState) (string, bool, error) {
	document, ok := parseClaudeSettings(current)
	if !ok {
		return "", false, newError(CodeInvalidState, errors.New("当前 Claude settings.json 无法解析"))
	}
	env := map[string]json.RawMessage{}
	if raw, present := document["env"]; present {
		_ = json.Unmarshal(raw, &env)
	}
	originalProjection, _ := claudeOwnedProjection(state.Original)
	for _, key := range claudeCredentialEnvKeys {
		delete(env, key)
		if value, present := originalProjection[key]; present {
			encoded, _ := json.Marshal(value)
			env[key] = encoded
		}
	}
	var existingHeaders string
	if raw, present := env[claudeCustomHeadersEnv]; present {
		_ = json.Unmarshal(raw, &existingHeaders)
	}
	headers := make([]string, 0, 4)
	for _, line := range strings.Split(existingHeaders, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(strings.ToLower(trimmed), claudePinHeader) {
			headers = append(headers, trimmed)
		}
	}
	if pin := strings.TrimSpace(originalProjection["pin"]); pin != "" {
		headers = append(headers, pin)
	}
	delete(env, claudeCustomHeadersEnv)
	if len(headers) > 0 {
		encoded, _ := json.Marshal(strings.Join(headers, "\n"))
		env[claudeCustomHeadersEnv] = encoded
	}
	if len(env) > 0 {
		encoded, _ := json.Marshal(env)
		document["env"] = encoded
	} else {
		delete(document, "env")
	}
	// 只有托管字段变了：原样写回接管前的字节（原文件不存在则删除）。
	if originalDocument, originalOK := parseClaudeSettings(state.Original); originalOK && canonicalDocumentEqual(document, originalDocument) {
		return state.Original, state.OriginalExisted, nil
	}
	var buffer strings.Builder
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return "", false, err
	}
	return buffer.String(), true, nil
}

func canonicalDocumentEqual(left, right map[string]json.RawMessage) bool {
	leftValue := canonicalRawObject(left)
	rightValue := canonicalRawObject(right)
	return leftValue == rightValue
}

func canonicalRawObject(value map[string]json.RawMessage) string {
	decoded := make(map[string]any, len(value))
	for key, raw := range value {
		var item any
		if json.Unmarshal(raw, &item) != nil {
			item = string(raw)
		}
		decoded[key] = item
	}
	encoded, _ := json.Marshal(decoded)
	return string(encoded)
}

func normalizeBaseURLLoose(value string) string {
	text := strings.TrimRight(strings.ToLower(strings.TrimSpace(value)), "/")
	if strings.HasSuffix(text, "/v1") {
		text = strings.TrimRight(text[:len(text)-3], "/")
	}
	return text
}

func readManagedState(path, fileName string) (*ManagedState, error) {
	raw, existed, err := readRegularFile(path)
	if err != nil {
		return nil, err
	}
	if !existed {
		return nil, nil
	}
	var document stateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return nil, newError(CodeInvalidState, err)
	}
	if document.FileName == nil || *document.FileName != fileName || document.Active == nil {
		return nil, newError(CodeInvalidState, nil)
	}
	if document.Ownership != nil {
		switch Ownership(*document.Ownership) {
		case "", OwnershipFile, OwnershipClaudeEnv:
		default:
			return nil, newError(CodeOwnershipUnsupported, fmt.Errorf("ownership %q", *document.Ownership))
		}
	}
	state := &ManagedState{
		FileName: fileName,
		Active:   *document.Active,
	}
	if document.Ownership != nil {
		state.Ownership = *document.Ownership
	}
	if !state.Active {
		return state, nil
	}
	if document.OriginalExisted == nil || document.Original == nil ||
		document.ManagedHash == nil || !managedHashPattern.MatchString(*document.ManagedHash) {
		return nil, newError(CodeInvalidState, nil)
	}
	state.OriginalExisted = *document.OriginalExisted
	state.Original = *document.Original
	state.ManagedHash = *document.ManagedHash
	return state, nil
}

// readRegularFile 只接受普通文件：符号链接/目录一律报错，避免把写入重定向到别处。
func readRegularFile(path string) (string, bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", false, newError(CodeHostConfigNotRegularFile, errors.New(path))
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	return string(content), true, nil
}

// writePrivateFile 原子写 0600 文件：临时文件 + rename，符号链接先摘掉。
func writePrivateFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	tempPath := fmt.Sprintf("%s.aih-tmp-%d-%d", path, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tempPath, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func writePrivateJSON(path string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writePrivateFile(path, string(encoded)+"\n")
}

// removeFile 删除托管文件；文件已不存在不算失败（还原到「原本没有这个文件」）。
func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (target Target) validate() error {
	if strings.TrimSpace(target.Directory) == "" {
		return newError(CodeScopeUnavailable, nil)
	}
	fileName := strings.TrimSpace(target.FileName)
	if fileName == "" || strings.ContainsAny(fileName, "/\\") {
		return fmt.Errorf("aihdefault: 非法宿主配置文件名 %q", target.FileName)
	}
	switch target.Ownership {
	case "", OwnershipFile, OwnershipClaudeEnv:
		return nil
	default:
		return newError(CodeOwnershipUnsupported, fmt.Errorf("ownership %q", target.Ownership))
	}
}

func configPath(target Target) string {
	return filepath.Join(target.Directory, target.FileName)
}

func statePath(target Target) string {
	return filepath.Join(target.Directory, ManagedStateFileName)
}

func contentHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}
