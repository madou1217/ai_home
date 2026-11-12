// Package accountprojection 定义账号运行时投影的应用层合同：
// 一个 Provider/账号在启动原生 CLI 前需要怎样的伪 HOME/config 目录、auth 文件、
// 共享会话链接和凭据物化/捕获端口。
//
// P3.0 只定义类型与校验，不包含目录创建、链接、凭据写入或清理实现；这些由
// internal/runtime/accountprojection 与 internal/adapters/providerstorage 在后续切片实现。
package accountprojection

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Mode 是投影形态。不要假设所有 Provider 都需要伪 HOME：
//   - none：直接用宿主配置根（Claude 正常会话、env 鉴权的 Codex）；
//   - config_dir：只隔离 Provider 配置根（Codex OAuth 的 CODEX_HOME）；
//   - fake_home：整个 HOME 都是账号沙箱（CodeBuddy 家族、gemini/agy 等）。
type Mode string

const (
	ModeNone      Mode = "none"
	ModeConfigDir Mode = "config_dir"
	ModeFakeHome  Mode = "fake_home"
)

// ArtifactBase 是 auth artifact 路径的基准。
type ArtifactBase string

const (
	// ArtifactBaseProjectionRoot 相对投影根（默认）。
	ArtifactBaseProjectionRoot ArtifactBase = "projection_root"
	// ArtifactBaseNativeRoot 相对 Provider 原生根（例如 .codex）。
	ArtifactBaseNativeRoot ArtifactBase = "native_root"
	// ArtifactBaseHome 相对伪 HOME（CodeBuddy 的 Library/.../auth/*.info）。
	ArtifactBaseHome ArtifactBase = "home"
)

// ArtifactFormat 是 auth artifact 的编码形态。
type ArtifactFormat string

const (
	FormatJSON         ArtifactFormat = "json"
	FormatText         ArtifactFormat = "text"
	FormatBinaryBase64 ArtifactFormat = "binary-base64"
)

// Artifact 是一份需要从账号凭据物化到投影里的文件。
type Artifact struct {
	// Field 是凭据绑定/策略里的字段名（credentials/auth/oauthCreds...）。
	Field string
	// Base 为空时按 ArtifactBaseProjectionRoot 处理。
	Base ArtifactBase
	// Path 是相对 Base 的路径段；禁止绝对路径、.. 和分隔符。
	Path []string
	// Format 必填，决定如何写入/读取。
	Format ArtifactFormat
	// Optional 允许字段缺失。
	Optional bool
	// LiveStore 表示客户端会原地续期这份文件：投影不能用旧账号快照覆盖更新的磁盘值。
	LiveStore bool
}

// BaseOrDefault 返回实际使用的路径基准。
func (artifact Artifact) BaseOrDefault() ArtifactBase {
	if artifact.Base == "" {
		return ArtifactBaseProjectionRoot
	}
	return artifact.Base
}

// PathSpec 是私有路径声明。
type PathSpec struct {
	Path []string
}

// Mapping 是投影根到宿主存储根的映射。
type Mapping struct {
	From []string
	To   []string
}

// SharedLink 是需要链接到宿主的目录/文件。
type SharedLink struct {
	Projection []string
	Host       []string
	Platforms  []string
	Exclude    []string
}

// EnvBase 是投影 env 值的路径基准。
type EnvBase string

const (
	EnvBaseProjectionRoot EnvBase = "projection_root"
	EnvBaseNativeRoot     EnvBase = "native_root"
	EnvBaseHostHome       EnvBase = "host_home"
	EnvBaseHostNativeRoot EnvBase = "host_native_root"
)

// EnvBinding 是投影需要写入子进程环境的变量。
//
// 例：Codex 的 CODEX_HOME=projection_root/.codex、CODEX_SQLITE_HOME=host_native_root；
// fake-home Provider 的 HOME=projection_root。
type EnvBinding struct {
	Key  string
	Base EnvBase
	Path []string
}

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Policy 是一个 Provider 的投影策略。
//
// 字段刻意与 Node lib/runtime/provider-storage-policy.js 对齐，但 Go 先按需实现：
// 不要为了“完整”一次性搬 1,300 行策略表。
type Policy struct {
	Provider string
	Mode     Mode

	NativeRoot      []string
	RuntimeHomeRoot []string

	AuthArtifacts    []Artifact
	PrivateArtifacts []PathSpec
	ProjectionRoots  []Mapping

	// SharedEntries 是链接到宿主的条目；SessionEntries 只链接、绝不迁移。
	SharedEntries         []string
	SessionEntries        []string
	PrecreatedDirectories []string

	SharedHostCaches    []SharedLink
	SharedHostDataRoots []SharedLink
	SharedHostDedupe    []SharedLink

	// Env 是投影根/宿主路径到子进程环境变量的映射；不含明文凭据。
	Env []EnvBinding

	AttachmentSubdir []string
}

// Validate 检查策略的结构安全；不触碰文件系统。
func (policy Policy) Validate() error {
	if strings.TrimSpace(policy.Provider) == "" {
		return errors.New("projection policy provider is empty")
	}
	switch policy.Mode {
	case ModeNone, ModeConfigDir, ModeFakeHome:
	default:
		return fmt.Errorf("projection policy mode invalid: %q", policy.Mode)
	}
	if err := validateOptionalPath("native root", policy.NativeRoot); err != nil {
		return err
	}
	if err := validateOptionalPath("runtime home root", policy.RuntimeHomeRoot); err != nil {
		return err
	}
	seenArtifactPaths := make(map[string]struct{}, len(policy.AuthArtifacts))
	for index, artifact := range policy.AuthArtifacts {
		if strings.TrimSpace(artifact.Field) == "" {
			return fmt.Errorf("auth artifact[%d] field is empty", index)
		}
		switch artifact.BaseOrDefault() {
		case ArtifactBaseProjectionRoot, ArtifactBaseNativeRoot, ArtifactBaseHome:
		default:
			return fmt.Errorf("auth artifact[%d] base invalid: %q", index, artifact.Base)
		}
		switch artifact.Format {
		case FormatJSON, FormatText, FormatBinaryBase64:
		default:
			return fmt.Errorf("auth artifact[%d] format invalid: %q", index, artifact.Format)
		}
		if err := ValidateRelativePath(artifact.Path); err != nil {
			return fmt.Errorf("auth artifact[%d] path: %w", index, err)
		}
		key := string(artifact.BaseOrDefault()) + "\x00" + strings.Join(artifact.Path, "\x00")
		if _, exists := seenArtifactPaths[key]; exists {
			return fmt.Errorf("auth artifact[%d] path duplicated: %v", index, artifact.Path)
		}
		seenArtifactPaths[key] = struct{}{}
	}
	for index, private := range policy.PrivateArtifacts {
		if err := ValidateRelativePath(private.Path); err != nil {
			return fmt.Errorf("private artifact[%d] path: %w", index, err)
		}
	}
	for index, mapping := range policy.ProjectionRoots {
		if err := validateOptionalPath("projection mapping from", mapping.From); err != nil {
			return fmt.Errorf("projection mapping[%d]: %w", index, err)
		}
		if err := ValidateRelativePath(mapping.To); err != nil {
			return fmt.Errorf("projection mapping[%d] to: %w", index, err)
		}
	}
	for index, entry := range policy.SharedEntries {
		if err := validateEntryName(entry); err != nil {
			return fmt.Errorf("shared entry[%d]: %w", index, err)
		}
	}
	for index, entry := range policy.SessionEntries {
		if err := validateEntryName(entry); err != nil {
			return fmt.Errorf("session entry[%d]: %w", index, err)
		}
	}
	for index, entry := range policy.PrecreatedDirectories {
		if err := validateEntryName(entry); err != nil {
			return fmt.Errorf("precreated directory[%d]: %w", index, err)
		}
	}
	if err := validateSharedLinks("shared host cache", policy.SharedHostCaches); err != nil {
		return err
	}
	if err := validateSharedLinks("shared host data root", policy.SharedHostDataRoots); err != nil {
		return err
	}
	if err := validateSharedLinks("shared host dedupe", policy.SharedHostDedupe); err != nil {
		return err
	}
	seenEnv := make(map[string]struct{}, len(policy.Env))
	for index, binding := range policy.Env {
		key := strings.TrimSpace(binding.Key)
		if !envNamePattern.MatchString(key) {
			return fmt.Errorf("env binding[%d] key invalid: %q", index, binding.Key)
		}
		if _, exists := seenEnv[key]; exists {
			return fmt.Errorf("env binding[%d] key duplicated: %s", index, key)
		}
		seenEnv[key] = struct{}{}
		switch binding.Base {
		case EnvBaseProjectionRoot, EnvBaseNativeRoot, EnvBaseHostHome, EnvBaseHostNativeRoot:
		default:
			return fmt.Errorf("env binding[%d] base invalid: %q", index, binding.Base)
		}
		if err := validateOptionalPath("env binding path", binding.Path); err != nil {
			return fmt.Errorf("env binding[%d]: %w", index, err)
		}
	}
	if err := validateOptionalPath("attachment subdir", policy.AttachmentSubdir); err != nil {
		return err
	}
	return nil
}

// ValidateRelativePath 校验相对路径段：非空、不是 . / ..、不含分隔符或 NUL。
func ValidateRelativePath(segments []string) error {
	if len(segments) == 0 {
		return errors.New("path is empty")
	}
	for index, segment := range segments {
		if err := validatePathSegment(segment); err != nil {
			return fmt.Errorf("segment[%d]: %w", index, err)
		}
	}
	return nil
}

func validateOptionalPath(label string, segments []string) error {
	if len(segments) == 0 {
		return nil
	}
	if err := ValidateRelativePath(segments); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return nil
}

func validateEntryName(value string) error {
	entry := strings.TrimSpace(value)
	if entry == "" {
		return errors.New("entry name is empty")
	}
	if entry == "." || entry == ".." || strings.ContainsAny(entry, "/\\\x00") {
		return fmt.Errorf("entry name invalid: %q", value)
	}
	return nil
}

func validatePathSegment(value string) error {
	segment := strings.TrimSpace(value)
	if segment == "" || segment == "." || segment == ".." ||
		strings.ContainsAny(segment, "/\\\x00") {
		return fmt.Errorf("segment invalid: %q", value)
	}
	return nil
}

func validateSharedLinks(label string, links []SharedLink) error {
	for index, link := range links {
		if err := ValidateRelativePath(link.Projection); err != nil {
			return fmt.Errorf("%s[%d] projection: %w", label, index, err)
		}
		if err := ValidateRelativePath(link.Host); err != nil {
			return fmt.Errorf("%s[%d] host: %w", label, index, err)
		}
		for platformIndex, platform := range link.Platforms {
			if strings.TrimSpace(platform) == "" {
				return fmt.Errorf("%s[%d] platform[%d] is empty", label, index, platformIndex)
			}
		}
		for excludeIndex, exclude := range link.Exclude {
			if err := validateEntryName(exclude); err != nil {
				return fmt.Errorf("%s[%d] exclude[%d]: %w", label, index, excludeIndex, err)
			}
		}
	}
	return nil
}
