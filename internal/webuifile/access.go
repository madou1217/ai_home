package webuifile

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

// SourceCodexMemory 是唯一绕过项目登记的来源：改由记忆根强制约束。
const SourceCodexMemory = "codex-memory"

// ProviderPath 是 provider 资源路径解析的结果投影：
// Blocked 表示命中了账号凭证投影，Path 是规范化后的路径。
type ProviderPath struct {
	Path    string
	Blocked bool
}

// Env 是访问策略依赖的宿主环境。HostHomeDir 为空时按 Node 规则从 AIHomeDir 推导。
//
// CanonicalizeProviderPath 对应 Node 的 resolveProviderResourcePath：投影别名到宿主
// 原生目录的映射属于 provider 存储策略，不在本包内复制，由调用方注入。
type Env struct {
	AIHomeDir                string
	HostHomeDir              string
	ChatImageRootDir         string
	CanonicalizeProviderPath func(rawPath string) ProviderPath
}

func (e Env) hostHomeDir() string {
	if trimmed := strings.TrimSpace(e.HostHomeDir); trimmed != "" {
		return trimmed
	}
	if trimmed := strings.TrimSpace(e.AIHomeDir); trimmed != "" {
		return filepath.Dir(filepath.Clean(trimmed))
	}
	return ""
}

// MemoryRoot 是 Codex 记忆引用允许的根目录。
func (e Env) MemoryRoot() string {
	hostHome := e.hostHomeDir()
	if hostHome == "" {
		return ""
	}
	return filepath.Join(hostHome, ".codex", "memories")
}

// Target 是已通过字面检查与凭证检查的读取目标。
type Target struct {
	TargetPath           string
	ReadPath             string
	ForcedAuthorizedRoot string
	Stat                 os.FileInfo
	AIHomeDir            string
	HostHomeDir          string
	TrustBoundary        TrustBoundary
}

// Authorization 是 outside_workspace 响应里用于前端弹授权框的载荷。
type Authorization struct {
	Required   bool
	FilePath   string
	Candidates []TrustCandidate
}

// FileError 是策略层返回的错误：Status 与 Code 直接对应 Node 写出的 JSON。
type FileError struct {
	Status        int
	Code          string
	Message       string
	Authorization *Authorization
	Cause         error
}

func (e *FileError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap 暴露底层 IO 错误，方便调用方区分策略拒绝与真实 IO 失败。
func (e *FileError) Unwrap() error { return e.Cause }

// Request 对应 read/check-access/media 三条路由的查询参数。
type Request struct {
	RawPath     string
	ProjectPath string
	Source      string
	SizeLimit   int64
}

var fileLineSuffixPattern = regexp.MustCompile("^(.*?):[0-9]+(-[0-9]+)?$")

// StripFileLineSuffix 对应 stripFileLineSuffix：去掉 path:12 或 path:12-18 的行号后缀。
func StripFileLineSuffix(filePath string) string {
	trimmed := strings.TrimSpace(filePath)
	if match := fileLineSuffixPattern.FindStringSubmatch(trimmed); match != nil {
		return match[1]
	}
	return trimmed
}

// ResolveTarget 对应 resolveRequestedFileTarget。
func ResolveTarget(fs FS, env Env, rawFilePath, source string) (*Target, *FileError) {
	aiHomeDir := strings.TrimSpace(env.AIHomeDir)
	hostHomeDir := env.hostHomeDir()
	requested := StripFileLineSuffix(rawFilePath)
	forcedRoot := ""

	if requested == "" {
		return nil, &FileError{Status: 400, Code: "path_required", Message: "必须提供文件路径"}
	}
	if strings.TrimSpace(source) == SourceCodexMemory {
		memoryRoot := env.MemoryRoot()
		resolved, ok := resolveMemoryCitationPath(memoryRoot, requested)
		if !ok {
			return nil, &FileError{
				Status:  403,
				Code:    "outside_memory_root",
				Message: "只允许读取 Codex 记忆目录内的引用文件",
			}
		}
		requested = resolved
		forcedRoot = memoryRoot
	} else if strings.HasPrefix(requested, "~") {
		requested = filepath.Join(hostHomeDir, strings.TrimPrefix(requested, "~"))
	}

	deny := DenyPolicy{HostHomeDir: hostHomeDir}
	if deny.IsSensitive(requested) {
		return nil, credentialDeniedError()
	}

	providerPath := ProviderPath{Path: requested}
	if env.CanonicalizeProviderPath != nil {
		if resolved := env.CanonicalizeProviderPath(requested); resolved.Path != "" {
			providerPath = resolved
		}
	}
	if providerPath.Blocked {
		return nil, &FileError{
			Status:  403,
			Code:    "permission_denied",
			Message: "出于安全考虑，不允许读取账号凭证投影",
		}
	}

	targetPath, err := absPath(providerPath.Path)
	if err != nil {
		return nil, ioFailure(err)
	}
	if deny.IsSensitive(targetPath) {
		return nil, credentialDeniedError()
	}
	if _, err := fs.Stat(targetPath); err != nil {
		return nil, &FileError{
			Status:  404,
			Code:    "not_found",
			Message: "文件不存在: " + requested,
			Cause:   err,
		}
	}

	readPath := resolveRealPathOrSelf(fs, targetPath)
	if deny.IsSensitive(readPath) {
		return nil, credentialDeniedError()
	}
	info, err := fs.Stat(readPath)
	if err != nil {
		return nil, ioFailure(err)
	}
	if !info.Mode().IsRegular() {
		return nil, &FileError{Status: 400, Code: "not_a_file", Message: "目标路径不是一个普通文件"}
	}

	return &Target{
		TargetPath:           targetPath,
		ReadPath:             readPath,
		ForcedAuthorizedRoot: forcedRoot,
		Stat:                 info,
		AIHomeDir:            aiHomeDir,
		HostHomeDir:          hostHomeDir,
		TrustBoundary: TrustBoundary{
			HostHomeDir: resolveOptionalRealPath(fs, hostHomeDir),
			AIHomeDir:   resolveOptionalRealPath(fs, aiHomeDir),
		},
	}, nil
}

// ResolveAuthorized 对应 resolveAuthorizedFileRequest：项目登记 + 目标解析 +
// 可读根集合 + 大小上限。
func ResolveAuthorized(fs FS, env Env, registry *ProjectRoots, req Request, trusted []TrustedRoot) (*Target, *FileError) {
	sizeLimit := req.SizeLimit
	if sizeLimit == 0 {
		sizeLimit = TextFileSizeLimit
	}

	projectDir := ""
	if strings.TrimSpace(req.Source) != SourceCodexMemory && strings.TrimSpace(req.ProjectPath) != "" {
		authorized, ok := registry.Authorize(req.ProjectPath)
		if !ok {
			return nil, &FileError{
				Status:  403,
				Code:    "unknown_project_root",
				Message: "只允许读取服务端已登记项目内的文件",
			}
		}
		projectDir = authorized
	}

	target, failure := ResolveTarget(fs, env, req.RawPath, req.Source)
	if failure != nil {
		return nil, failure
	}

	roots := make([]string, 0, 4)
	if target.ForcedAuthorizedRoot != "" {
		roots = append(roots, target.ForcedAuthorizedRoot)
	}
	if projectDir != "" {
		roots = append(roots, projectDir)
	}
	roots = append(roots, ExtraReadableRoots(env)...)

	authorizedRoots := make([]string, 0, len(roots)+len(trusted))
	for _, root := range dedupe(roots) {
		authorizedRoots = append(authorizedRoots, resolveRealPathOrSelf(fs, root))
	}
	for _, entry := range trusted {
		if trimmed := strings.TrimSpace(entry.Path); trimmed != "" {
			authorizedRoots = append(authorizedRoots, trimmed)
		}
	}
	if !authorizedByRoots(target.ReadPath, authorizedRoots) {
		return nil, outsideWorkspaceError(target)
	}
	if target.Stat.Size() > sizeLimit {
		return nil, &FileError{
			Status:  413,
			Code:    "file_too_large",
			Message: fmt.Sprintf("文件超过%dMB大小限制", SizeLimitMB(sizeLimit)),
		}
	}
	return target, nil
}

// ExtraReadableRoots 对应 resolveExtraReadableRoots：provider 会话产物目录
// 与 AIH 图片临时目录在项目之外，必须显式只读放开。
func ExtraReadableRoots(env Env) []string {
	hostHomeDir := env.hostHomeDir()
	if hostHomeDir == "" {
		hostHomeDir, _ = os.UserHomeDir()
	}
	roots := make([]string, 0, 8)
	if hostHomeDir != "" {
		roots = append(roots, providerReadableRoots(hostHomeDir)...)
	}
	roots = append(roots, chatImageRoot(env))
	return dedupe(roots)
}

// providerReadableRoots 对应 resolveProviderReadableResourceRoots：
// 唯一真值在 storagepolicy，本包只负责与图片临时目录合并去重。
func providerReadableRoots(hostHomeDir string) []string {
	return storagepolicy.ReadableResourceRoots(hostHomeDir)
}

func chatImageRoot(env Env) string {
	if trimmed := strings.TrimSpace(env.ChatImageRootDir); trimmed != "" {
		return filepath.Clean(trimmed)
	}
	return filepath.Join(os.TempDir(), "aih-web-chat-images")
}

// resolveMemoryCitationPath 对应 resolveCodexMemoryCitationPath：
// 只接受记忆根下的相对路径，且不允许 "."、".." 与绝对路径。
func resolveMemoryCitationPath(memoryRoot, rawFilePath string) (string, bool) {
	normalized := normalizeSlashPath(rawFilePath)
	if memoryRoot == "" || normalized == "" {
		return "", false
	}
	if strings.HasPrefix(normalized, "/") || strings.HasPrefix(normalized, "~") {
		return "", false
	}
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(normalized, "/") {
		if part == "" {
			continue
		}
		if part == "." || part == ".." {
			return "", false
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return "", false
	}
	targetPath := filepath.Join(append([]string{memoryRoot}, parts...)...)
	if !WithinRoot(memoryRoot, targetPath) {
		return "", false
	}
	return targetPath, true
}

func authorizedByRoots(targetPath string, roots []string) bool {
	for _, root := range roots {
		if root != "" && WithinRoot(root, targetPath) {
			return true
		}
	}
	return false
}

func resolveOptionalRealPath(fs FS, target string) string {
	candidate := strings.TrimSpace(target)
	if candidate == "" {
		return ""
	}
	return resolveRealPathOrSelf(fs, candidate)
}

func outsideWorkspaceError(target *Target) *FileError {
	return &FileError{
		Status:  403,
		Code:    "outside_workspace",
		Message: "此文件位于未信任的文件夹，请授权后继续预览",
		Authorization: &Authorization{
			Required:   true,
			FilePath:   target.ReadPath,
			Candidates: TrustCandidates(target.ReadPath, target.TrustBoundary),
		},
	}
}

func credentialDeniedError() *FileError {
	return &FileError{
		Status:  403,
		Code:    "permission_denied",
		Message: "出于安全考虑，不允许读取此系统或凭证文件",
	}
}

func ioFailure(err error) *FileError {
	return &FileError{Status: 500, Code: "io_error", Message: err.Error(), Cause: err}
}
