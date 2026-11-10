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
		ManagedHash: contentHash(nextContent),
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
	restoreManaged := inspected.matchesManaged ||
		(inspected.takeover != nil && !inspected.takeover.AdoptedAsBaseline)
	if restoreManaged {
		if inspected.state.OriginalExisted {
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
		inspected.matchesManaged = existed && contentHash(current) == state.ManagedHash
		matchesOriginal := (!state.OriginalExisted && !existed) ||
			(state.OriginalExisted && existed && current == state.Original)
		if !inspected.matchesManaged && !matchesOriginal {
			if target.Takeover == nil {
				return inspection{}, newError(CodeHostConfigChanged, nil)
			}
			inspected.takeover = &TakeoverDecision{
				ExternallyChanged: true,
				AdoptedAsBaseline: !looksManaged(current, target.Takeover),
			}
		}
		return inspected, nil
	}
	if stateReset {
		inspected.takeover = &TakeoverDecision{AdoptedAsBaseline: true, StateReset: true}
	}
	return inspected, nil
}

// looksManaged 判断当前内容是否仍带 AIH 网关痕迹（整文件托管的内容内嵌网关地址）。
func looksManaged(current string, takeover *Takeover) bool {
	if takeover == nil {
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
		case "", OwnershipFile:
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
	case "", OwnershipFile:
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
