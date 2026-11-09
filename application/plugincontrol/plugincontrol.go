// Package plugincontrol 是插件制品生命周期的应用层：安装 / 卸载。
//
// 启用/停用仍由 Node 的 plugin runtime 代次负责（prepare→commit→activate），
// 本包只管「接受一个制品」和「从控制状态里移除一条记录」。持久事实仍是
// app-state.db 的 app_kv/plugins.control.v1，写回必须经过 CAS 与维护租约。
package plugincontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 与 Node control.js 逐字一致的错误码。
const (
	CodeNotInstalled       = "plugin_not_installed"
	CodeVersionAmbiguous   = "plugin_version_ambiguous"
	CodeVersionConflict    = "plugin_version_conflict"
	CodeInUse              = "plugin_in_use"
	CodeRevisionConflict   = "plugin_revision_conflict"
	CodeStateUnavailable   = "plugin_state_unavailable"
	CodeStateInvalid       = "plugin_state_invalid"
	CodeArtifactRemoveFail = "plugin_artifact_remove_failed"
)

// Signature 是制品签名结论；字段形状与 Node verifyMetadataSignature 一致。
type Signature struct {
	Status   string  `json:"status"`
	KeyID    string  `json:"keyId,omitempty"`
	SignedAt *string `json:"signedAt,omitempty"`
	Detail   string  `json:"-"`
}

// AcceptOptions 是一次制品接受的校验参数。
type AcceptOptions struct {
	HostVersion   string
	NodeVersion   string
	Target        string
	RequireSigned bool
	// TrustedKeys 仅供测试注入；生产路径读插件数据根的信任根文件。
	TrustedKeys map[string]string
}

// AcceptedArtifact 是接受成功的制品。
type AcceptedArtifact struct {
	Digest                 string
	ArtifactPath           string
	Directory              string
	Manifest               json.RawMessage
	ManifestValue          map[string]any
	Signature              Signature
	Files                  int
	PermissionsFingerprint string
}

// ArtifactAcceptor 是制品校验与落盘端口。
type ArtifactAcceptor interface {
	Accept(file string, options AcceptOptions) (AcceptedArtifact, error)
}

// StateStore 是 plugins.control.v1 的事务存储端口。
//
// Update 必须在一个事务内读取当前文档、检查 expectedRevision、应用 mutator、
// 递增 revision 并写回；mutator 返回错误时整笔回滚。
type StateStore interface {
	Update(ctx context.Context, mutate func(*State) error, expectedRevision *int64) (State, error)
}

// State 是 plugins.control.v1 的可写投影。
//
// installed / instances / generations 用原始 JSON 保存：启停仍由 Node 写入
// permissionsAcceptedFingerprint、createdAt 等字段，Go 读写时必须原样保留，
// 不能因为 Go 不认识某个字段就把它删掉。顶层字段与 Node normalizeState 对齐。
type State struct {
	SchemaVersion    int               `json:"schemaVersion"`
	Revision         int64             `json:"revision"`
	Installed        []json.RawMessage `json:"installed"`
	Instances        []json.RawMessage `json:"instances"`
	Generations      []json.RawMessage `json:"generations"`
	ActiveGeneration int64             `json:"activeGeneration"`
}

// EmptyState 与 Node EMPTY_STATE 一致。
func EmptyState() State {
	return State{
		SchemaVersion: 1,
		Installed:     []json.RawMessage{},
		Instances:     []json.RawMessage{},
		Generations:   []json.RawMessage{},
	}
}

// Normalize 把缺字段与非法类型收敛成 Node normalizeState 的结果。
func (state State) Normalize() State {
	normalized := state
	normalized.SchemaVersion = 1
	if normalized.Revision < 0 {
		normalized.Revision = 0
	}
	if normalized.Installed == nil {
		normalized.Installed = []json.RawMessage{}
	}
	if normalized.Instances == nil {
		normalized.Instances = []json.RawMessage{}
	}
	if normalized.Generations == nil {
		normalized.Generations = []json.RawMessage{}
	}
	if normalized.ActiveGeneration < 0 {
		normalized.ActiveGeneration = 0
	}
	return normalized
}

// Clone 深拷贝状态，避免 mutator 修改到当前读取值。
func (state State) Clone() State {
	cloned := state
	cloned.Installed = cloneRawMessages(state.Installed)
	cloned.Instances = cloneRawMessages(state.Instances)
	cloned.Generations = cloneRawMessages(state.Generations)
	return cloned
}

func cloneRawMessages(values []json.RawMessage) []json.RawMessage {
	if values == nil {
		return []json.RawMessage{}
	}
	cloned := make([]json.RawMessage, len(values))
	for index, value := range values {
		cloned[index] = append(json.RawMessage(nil), value...)
	}
	return cloned
}

// InstallResult 与 Node control.install 的返回字段逐字一致。
type InstallResult struct {
	PluginID    string          `json:"pluginId"`
	Version     string          `json:"version"`
	Digest      string          `json:"digest"`
	Revision    int64           `json:"revision"`
	Signature   Signature       `json:"signature"`
	Permissions json.RawMessage `json:"permissions"`
}

// UninstallInput 与 Node control.uninstall 的入参一致。
type UninstallInput struct {
	PluginID         string
	Version          string
	ExpectedRevision *int64
}

// UninstallResult 与 Node control.uninstall 的返回字段逐字一致。
type UninstallResult struct {
	PluginID string `json:"pluginId"`
	Version  string `json:"version"`
	Revision int64  `json:"revision"`
}

// Installer 编排「接受制品 → CAS 写控制状态」。
type Installer struct {
	aiHomeDir string
	artifacts ArtifactAcceptor
	store     StateStore
}

// NewInstaller 创建安装器；任一依赖缺失都拒绝装配。
func NewInstaller(aiHomeDir string, artifacts ArtifactAcceptor, store StateStore) (*Installer, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" || artifacts == nil || store == nil {
		return nil, errors.New("插件安装器依赖无效")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Installer{aiHomeDir: absolute, artifacts: artifacts, store: store}, nil
}

type installedRecord struct {
	PluginID  string          `json:"pluginId"`
	Version   string          `json:"version"`
	Digest    string          `json:"digest"`
	Artifact  string          `json:"artifact"`
	Directory string          `json:"directory"`
	Signature json.RawMessage `json:"signature"`
}

type instanceRecord struct {
	InstanceID string `json:"instanceId"`
	PluginID   string `json:"pluginId"`
	Version    string `json:"version"`
}

func decodeInstalled(raw json.RawMessage) installedRecord {
	var record installedRecord
	_ = json.Unmarshal(raw, &record)
	return record
}

// Install 接受制品并写入控制状态。
//
// 同一 pluginId@version 同 digest 是幂等的（不重复追加记录，但 revision 仍递增）；
// 不同 digest 报 plugin_version_conflict。与 Node 一样，制品先落盘再写状态：
// CAS 落败时留下的是按 digest 去重的孤儿制品，不会产生半条安装记录。
func (installer *Installer) Install(ctx context.Context, file string, options AcceptOptions) (InstallResult, error) {
	accepted, err := installer.artifacts.Accept(file, options)
	if err != nil {
		return InstallResult{}, err
	}
	pluginID, _ := accepted.ManifestValue["pluginId"].(string)
	version, _ := accepted.ManifestValue["version"].(string)
	installedAt := nowMillis()
	record := map[string]any{
		"pluginId":               pluginID,
		"version":                version,
		"digest":                 accepted.Digest,
		"artifact":               accepted.ArtifactPath,
		"directory":              accepted.Directory,
		"manifest":               json.RawMessage(accepted.Manifest),
		"installedAt":            installedAt,
		"signature":              accepted.Signature,
		"permissionsFingerprint": accepted.PermissionsFingerprint,
	}
	encoded, err := encodeRecord(record)
	if err != nil {
		return InstallResult{}, pluginerr.New(CodeStateInvalid, "")
	}
	updated, err := installer.store.Update(ctx, func(state *State) error {
		for _, raw := range state.Installed {
			existing := decodeInstalled(raw)
			if existing.PluginID != pluginID || existing.Version != version {
				continue
			}
			if existing.Digest != accepted.Digest {
				return pluginerr.New(CodeVersionConflict,
					fmt.Sprintf("%s@%s 已安装且内容不同；请提升版本号", pluginID, version))
			}
			return nil // 幂等：保留原记录
		}
		state.Installed = append(state.Installed, json.RawMessage(encoded))
		return nil
	}, nil)
	if err != nil {
		return InstallResult{}, err
	}
	var permissions json.RawMessage
	if value, present := accepted.ManifestValue["permissions"]; present && value != nil {
		encoded, err := json.Marshal(value)
		if err != nil {
			return InstallResult{}, pluginerr.New(CodeStateInvalid, "")
		}
		permissions = encoded
	}
	return InstallResult{
		PluginID:    pluginID,
		Version:     version,
		Digest:      accepted.Digest,
		Revision:    updated.Revision,
		Signature:   accepted.Signature,
		Permissions: permissions,
	}, nil
}

// Uninstall 从控制状态移除记录，并清理不再被任何记录引用的制品文件。
func (installer *Installer) Uninstall(ctx context.Context, input UninstallInput) (UninstallResult, error) {
	pluginID := strings.TrimSpace(input.PluginID)
	version := strings.TrimSpace(input.Version)
	var removed installedRecord
	updated, err := installer.store.Update(ctx, func(state *State) error {
		index, target, err := findInstalled(state, pluginID, version)
		if err != nil {
			return err
		}
		users := make([]string, 0)
		for _, raw := range state.Instances {
			var instance instanceRecord
			_ = json.Unmarshal(raw, &instance)
			if instance.PluginID == target.PluginID && instance.Version == target.Version {
				users = append(users, instance.InstanceID)
			}
		}
		if len(users) > 0 {
			return pluginerr.New(CodeInUse,
				fmt.Sprintf("仍被实例引用：%s（先停用并删除实例）", strings.Join(users, ", ")))
		}
		removed = target
		state.Installed = append(state.Installed[:index], state.Installed[index+1:]...)
		return nil
	}, input.ExpectedRevision)
	if err != nil {
		return UninstallResult{}, err
	}
	stillReferenced := false
	for _, raw := range updated.Installed {
		if decodeInstalled(raw).Digest == removed.Digest {
			stillReferenced = true
			break
		}
	}
	if !stillReferenced {
		if err := installer.removeArtifact(removed); err != nil {
			return UninstallResult{}, err
		}
	}
	return UninstallResult{PluginID: removed.PluginID, Version: removed.Version, Revision: updated.Revision}, nil
}

func findInstalled(state *State, pluginID string, version string) (int, installedRecord, error) {
	matches := make([]int, 0, 1)
	var target installedRecord
	for index, raw := range state.Installed {
		record := decodeInstalled(raw)
		if record.PluginID != pluginID {
			continue
		}
		if version != "" && record.Version != version {
			continue
		}
		matches = append(matches, index)
		target = record
	}
	suffix := ""
	if version != "" {
		suffix = "@" + version
	}
	if len(matches) == 0 {
		return 0, installedRecord{}, pluginerr.New(CodeNotInstalled,
			fmt.Sprintf("未安装插件 %s%s", pluginID, suffix))
	}
	if len(matches) > 1 {
		return 0, installedRecord{}, pluginerr.New(CodeVersionAmbiguous,
			fmt.Sprintf("插件 %s 安装了多个版本，请指定 --version", pluginID))
	}
	return matches[0], target, nil
}

// removeArtifact 只删除插件数据根内的路径。
//
// 控制状态里的 artifact/directory 是持久事实；如果它被手工篡改成任意路径，
// 直接按记录删除等于把卸载变成任意文件删除。越界路径保持原样，宁可留下文件。
func (installer *Installer) removeArtifact(record installedRecord) error {
	pluginsRoot := filepath.Join(installer.aiHomeDir, "plugins")
	for _, target := range []string{record.Artifact, record.Directory} {
		clean := filepath.Clean(strings.TrimSpace(target))
		relative, err := filepath.Rel(pluginsRoot, clean)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			continue
		}
		if strings.TrimSpace(target) == "" {
			continue
		}
		if info, err := os.Lstat(clean); err != nil {
			continue // force 语义：不存在不是错误
		} else if info.IsDir() {
			if err := os.RemoveAll(clean); err != nil {
				return pluginerr.New(CodeArtifactRemoveFail, err.Error())
			}
		} else if err := os.Remove(clean); err != nil {
			return pluginerr.New(CodeArtifactRemoveFail, err.Error())
		}
	}
	return nil
}
