package providerlaunch

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const secretProjectionFileMode fs.FileMode = 0o600

var (
	// ErrInvalidProjectionFile 表示临时凭据文件的相对路径或内容无效。
	ErrInvalidProjectionFile = errors.New("Provider 启动投影文件无效")
	// ErrInvalidProjectionRequest 表示临时凭据投影缺少账号归属或绑定环境变量。
	ErrInvalidProjectionRequest = errors.New("Provider 启动投影请求无效")
)

// ProjectionFile 是需要写入临时认证投影根目录的只读敏感文件。
type ProjectionFile struct {
	relativePath string
	content      []byte
}

// NewProjectionFile 创建固定为 0600 权限的敏感投影文件。
func NewProjectionFile(relativePath string, content []byte) (ProjectionFile, error) {
	if !isSafeRelativePath(relativePath) || len(content) == 0 {
		return ProjectionFile{}, ErrInvalidProjectionFile
	}
	return ProjectionFile{
		relativePath: relativePath,
		content:      append([]byte(nil), content...),
	}, nil
}

// RelativePath 返回投影根目录内的规范正斜杠相对路径。
func (file ProjectionFile) RelativePath() string {
	return file.relativePath
}

// Mode 返回凭据文件必须使用的最小权限。
func (file ProjectionFile) Mode() fs.FileMode {
	return secretProjectionFileMode
}

// RevealContent 显式返回凭据文件内容副本，仅供投影 Materializer 写入。
func (file ProjectionFile) RevealContent() []byte {
	return append([]byte(nil), file.content...)
}

// IsValid 判断敏感文件是否仍满足路径和内容约束。
func (file ProjectionFile) IsValid() bool {
	return isSafeRelativePath(file.relativePath) && len(file.content) > 0
}

// String 返回不含文件内容的安全摘要。
func (file ProjectionFile) String() string {
	return fmt.Sprintf(
		"providerlaunch.ProjectionFile{path=%s,mode=%#o,content=<redacted:%d bytes>}",
		file.relativePath,
		file.Mode(),
		len(file.content),
	)
}

// GoString 确保 %#v 不会输出敏感文件内容。
func (file ProjectionFile) GoString() string {
	return file.String()
}

// Format 覆盖所有 fmt verb，避免值格式化绕过文件内容脱敏。
func (file ProjectionFile) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(file.String()))
}

// ProjectionRequestInput 是创建临时认证投影合同所需的完整输入。
type ProjectionRequestInput struct {
	// OwnerAccountRef 是资源租约和清理 marker 必须复核的稳定账号引用。
	OwnerAccountRef accountcore.AccountRef
	// EnvironmentKey 是 Materializer 最终绑定投影根目录的 Provider 环境变量。
	EnvironmentKey string
	// PreserveNativeState 要求临时认证根不能切断 Provider 原生会话和配置状态。
	PreserveNativeState bool
	// Files 是投影根目录内需要原子写入的敏感文件。
	Files []ProjectionFile
}

// ProjectionRequest 描述尚未分配路径的临时认证文件需求。
//
// 本值只声明资源合同；系统临时目录分配、marker 写入、共享状态覆盖和回收均由后续
// Runtime Adapter 负责。
type ProjectionRequest struct {
	ownerAccountRef     accountcore.AccountRef
	environmentKey      string
	preserveNativeState bool
	files               []ProjectionFile
}

// NewProjectionRequest 校验投影所有权、环境绑定和文件唯一性后创建只读合同。
func NewProjectionRequest(input ProjectionRequestInput) (ProjectionRequest, error) {
	if !input.OwnerAccountRef.IsValid() ||
		!isEnvironmentName(input.EnvironmentKey) ||
		!input.PreserveNativeState ||
		len(input.Files) == 0 {
		return ProjectionRequest{}, ErrInvalidProjectionRequest
	}
	files := make([]ProjectionFile, 0, len(input.Files))
	seenPaths := make(map[string]struct{}, len(input.Files))
	for _, file := range input.Files {
		if !file.IsValid() {
			return ProjectionRequest{}, ErrInvalidProjectionRequest
		}
		if _, duplicated := seenPaths[file.RelativePath()]; duplicated {
			return ProjectionRequest{}, ErrInvalidProjectionRequest
		}
		seenPaths[file.RelativePath()] = struct{}{}
		files = append(files, cloneProjectionFile(file))
	}
	sort.Slice(files, func(left int, right int) bool {
		return files[left].RelativePath() < files[right].RelativePath()
	})
	return ProjectionRequest{
		ownerAccountRef:     input.OwnerAccountRef,
		environmentKey:      input.EnvironmentKey,
		preserveNativeState: true,
		files:               files,
	}, nil
}

// OwnerAccountRef 返回投影资源唯一允许服务的稳定账号。
func (request ProjectionRequest) OwnerAccountRef() accountcore.AccountRef {
	return request.ownerAccountRef
}

// EnvironmentKey 返回 Materializer 应绑定临时根目录的环境变量。
func (request ProjectionRequest) EnvironmentKey() string {
	return request.environmentKey
}

// PreserveNativeState 表示 Materializer 必须保留宿主原生会话和非凭据配置。
func (request ProjectionRequest) PreserveNativeState() bool {
	return request.preserveNativeState
}

// Files 返回敏感投影文件的深副本。
func (request ProjectionRequest) Files() []ProjectionFile {
	files := make([]ProjectionFile, 0, len(request.files))
	for _, file := range request.files {
		files = append(files, cloneProjectionFile(file))
	}
	return files
}

// IsValid 判断投影合同是否仍满足所有权和文件约束。
func (request ProjectionRequest) IsValid() bool {
	rebuilt, err := NewProjectionRequest(ProjectionRequestInput{
		OwnerAccountRef:     request.ownerAccountRef,
		EnvironmentKey:      request.environmentKey,
		PreserveNativeState: request.preserveNativeState,
		Files:               request.files,
	})
	return err == nil && len(rebuilt.files) == len(request.files)
}

// String 返回不含任何投影文件内容的安全摘要。
func (request ProjectionRequest) String() string {
	paths := make([]string, 0, len(request.files))
	for _, file := range request.files {
		paths = append(paths, file.RelativePath())
	}
	return fmt.Sprintf(
		"providerlaunch.ProjectionRequest{owner=%s,env=%s,preserve_native_state=%t,files=%v,content=<redacted>}",
		request.ownerAccountRef,
		request.environmentKey,
		request.preserveNativeState,
		paths,
	)
}

// GoString 确保 %#v 不会输出投影文件内容。
func (request ProjectionRequest) GoString() string {
	return request.String()
}

// Format 覆盖所有 fmt verb，避免值格式化绕过投影脱敏。
func (request ProjectionRequest) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(request.String()))
}

// cloneProjectionFile 深复制投影文件的敏感字节。
func cloneProjectionFile(source ProjectionFile) ProjectionFile {
	return ProjectionFile{
		relativePath: source.relativePath,
		content:      append([]byte(nil), source.content...),
	}
}

// cloneProjectionRequest 深复制投影请求及其所有敏感文件。
func cloneProjectionRequest(source ProjectionRequest) ProjectionRequest {
	files := make([]ProjectionFile, 0, len(source.files))
	for _, file := range source.files {
		files = append(files, cloneProjectionFile(file))
	}
	return ProjectionRequest{
		ownerAccountRef:     source.ownerAccountRef,
		environmentKey:      source.environmentKey,
		preserveNativeState: source.preserveNativeState,
		files:               files,
	}
}

// cloneOptionalProjection 深复制可选投影请求。
func cloneOptionalProjection(source *ProjectionRequest) *ProjectionRequest {
	if source == nil {
		return nil
	}
	cloned := cloneProjectionRequest(*source)
	return &cloned
}

// isSafeRelativePath 拒绝绝对路径、反斜杠和任何父目录穿越。
func isSafeRelativePath(value string) bool {
	if value == "" || strings.Contains(value, "\\") || strings.ContainsRune(value, '\x00') {
		return false
	}
	cleaned := path.Clean(value)
	return cleaned == value &&
		cleaned != "." &&
		!strings.HasPrefix(cleaned, "/") &&
		cleaned != ".." &&
		!strings.HasPrefix(cleaned, "../")
}
