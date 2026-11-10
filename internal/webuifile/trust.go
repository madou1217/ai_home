package webuifile

import (
	"errors"
	"path/filepath"
	"strings"
)

// TrustBoundary 是判断授权范围是否安全时的两条边界：宿主 HOME 与 AIH 数据目录。
type TrustBoundary struct {
	HostHomeDir string
	AIHomeDir   string
}

// TrustCandidate 对应 createFileTrustCandidates 的候选项形状。
type TrustCandidate struct {
	Scope       string
	Path        string
	Label       string
	Description string
}

// 两个可选授权范围。
const (
	TrustScopeFileDirectory   = "file_directory"
	TrustScopeParentDirectory = "parent_directory"
)

// UnsafeTrustRoot 对应 isUnsafeTrustRoot：空、相对路径、文件系统根，
// 以及包含 HOME 或 AIH 数据目录的上级目录都不能被信任。
func UnsafeTrustRoot(rootPath string, boundary TrustBoundary) bool {
	candidate := strings.TrimSpace(rootPath)
	if candidate == "" || !filepath.IsAbs(candidate) {
		return true
	}
	resolved := filepath.Clean(candidate)
	if resolved == filepath.VolumeName(resolved)+string(filepath.Separator) {
		return true
	}
	protected := []string{}
	for _, value := range []string{boundary.HostHomeDir, boundary.AIHomeDir} {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			protected = append(protected, filepath.Clean(trimmed))
		}
	}
	for _, protectedRoot := range protected {
		// 方向与普通包含判断相反：授权根如果包含 HOME，就等于把凭据一起放开。
		if WithinRoot(resolved, protectedRoot) {
			return true
		}
	}
	return false
}

// TrustCandidates 对应 createFileTrustCandidates：文件所在目录与它的父目录。
func TrustCandidates(filePath string, boundary TrustBoundary) []TrustCandidate {
	target := strings.TrimSpace(filePath)
	if target == "" || !filepath.IsAbs(target) {
		return nil
	}
	fileDirectory := filepath.Dir(filepath.Clean(target))
	candidates := []TrustCandidate{
		{
			Scope:       TrustScopeFileDirectory,
			Path:        fileDirectory,
			Label:       "信任此文件夹",
			Description: "仅允许预览此文件夹及其子目录中的文件",
		},
		{
			Scope:       TrustScopeParentDirectory,
			Path:        filepath.Dir(fileDirectory),
			Label:       "信任父级文件夹",
			Description: "允许预览父级文件夹及其所有子目录中的文件",
		},
	}
	seen := make(map[string]struct{}, len(candidates))
	out := make([]TrustCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if _, ok := seen[candidate.Path]; ok {
			continue
		}
		if UnsafeTrustRoot(candidate.Path, boundary) {
			continue
		}
		seen[candidate.Path] = struct{}{}
		out = append(out, candidate)
	}
	return out
}

// TrustedRoot 是已授权目录的一条记录。
type TrustedRoot struct {
	Path      string
	TrustedAt int64
}

// NormalizeTrustedRoots 对应 normalizeTrustedRootEntries：只保留绝对路径并去重。
func NormalizeTrustedRoots(entries []TrustedRoot) []TrustedRoot {
	seen := make(map[string]struct{}, len(entries))
	out := make([]TrustedRoot, 0, len(entries))
	for _, entry := range entries {
		candidate := strings.TrimSpace(entry.Path)
		if candidate == "" || !filepath.IsAbs(candidate) {
			continue
		}
		trustedPath := filepath.Clean(candidate)
		if _, ok := seen[trustedPath]; ok {
			continue
		}
		seen[trustedPath] = struct{}{}
		out = append(out, TrustedRoot{Path: trustedPath, TrustedAt: entry.TrustedAt})
	}
	return out
}

// ErrTrustRootInvalid 对应 Node 的 webui_file_trust_root_invalid。
var ErrTrustRootInvalid = errors.New("webui_file_trust_root_invalid")

// AddTrustedRoot 对应 addTrustedFileRoot：已有覆盖项直接复用；
// 否则插入新根并移除被它覆盖的旧根，返回新列表与最终生效的根。
//
// 落盘由调用方负责：Node 侧读写 app-state 的 webui-file-trusted-roots，
// 那是宿主存储职责，不属于访问策略。
func AddTrustedRoot(current []TrustedRoot, rootPath string, now int64) ([]TrustedRoot, string, error) {
	candidate := strings.TrimSpace(rootPath)
	if candidate == "" || !filepath.IsAbs(candidate) {
		return NormalizeTrustedRoots(current), "", ErrTrustRootInvalid
	}
	trustedPath := filepath.Clean(candidate)
	normalized := NormalizeTrustedRoots(current)
	for _, entry := range normalized {
		if WithinRoot(entry.Path, trustedPath) {
			return normalized, entry.Path, nil
		}
	}
	next := make([]TrustedRoot, 0, len(normalized)+1)
	next = append(next, TrustedRoot{Path: trustedPath, TrustedAt: now})
	for _, entry := range normalized {
		if WithinRoot(trustedPath, entry.Path) {
			continue
		}
		next = append(next, entry)
	}
	return next, trustedPath, nil
}
