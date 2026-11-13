// Package webuichatattachmentsapi 提供聊天图片/视频附件的安全只读下载端点。
//
// 契约边界（对齐 Node GET /v0/webui/chat/attachments）：
//   - GET /v1/management/webui/chat/attachments?path=...
//   - 只允许读取明确白名单内的附件根目录（临时剪贴板图片目录、provider 原生会话/附件目录、
//     以及项目工作区下 /.aih/chat-images），对符号链接先解析真实路径再二次校验越界。
//   - 对账号私密产物（凭证、electron-user-data、sessions、diagnostics 等）即使位于允许根下
//     或经由符号链接指向也一律拒绝并返回 404 chat_attachment_not_found。
//   - 仅支持图片（png/jpg/jpeg/webp/gif）与视频（m4v/mov/mp4/webm）扩展名，其余返回
//     415 unsupported_chat_attachment_type；响应带 Cache-Control: private, max-age=300。
package webuichatattachmentsapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

// Path 是 WebUI 聊天附件读取路由。
const Path = "/v1/management/webui/chat/attachments"

// ErrInvalidDependencies 表示 Handler 缺少必要的鉴权器。
var ErrInvalidDependencies = errors.New("WebUI 聊天附件接口依赖无效")

// Authorizer 校验管理面请求鉴权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总聊天附件读取接口依赖。
type Dependencies struct {
	Authorizer       Authorizer
	AIHomeDir        string
	HostHomeDir      string
	ChatImageRootDir string
}

// Handler 处理聊天附件读取。
type Handler struct {
	authorizer       Authorizer
	aiHomeDir        string
	hostHomeDir      string
	chatImageRootDir string
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

var attachmentContentTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif":  "image/gif",
	".m4v":  "video/x-m4v",
	".mov":  "video/quicktime",
	".mp4":  "video/mp4",
	".webm": "video/webm",
}

// privateDirSequences 匹配私密目录片段序列，防止访问目录内部文件（不仅限目录本身）。
var privateDirSequences = [][]string{
	{"electron-user-data"},
	{".auth"},
	{".kimi-code", "credentials"},
	{".cline", "data", "settings"},
	{"library", "keychains"},
	{".codebuddy", "sessions"},
	{".codebuddy-cn", "sessions"},
	{"codebuddyextension", "cache"},
	{"codebuddyextension", "logs"},
	{".codebuddy", "diagnostics"},
}

// NewHandler 创建聊天附件读取 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	aiHomeDir := strings.TrimSpace(dependencies.AIHomeDir)
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHomeDir == "" && aiHomeDir != "" {
		hostHomeDir = filepath.Dir(filepath.Clean(aiHomeDir))
	}
	chatImageRoot := strings.TrimSpace(dependencies.ChatImageRootDir)
	if chatImageRoot == "" {
		chatImageRoot = filepath.Join(os.TempDir(), "aih-web-chat-images")
	}
	return &Handler{
		authorizer:       dependencies.Authorizer,
		aiHomeDir:        aiHomeDir,
		hostHomeDir:      hostHomeDir,
		chatImageRootDir: filepath.Clean(chatImageRoot),
	}, nil
}

// ServeHTTP 只接受 GET 请求并流式返回附件内容。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_chat_attachments_unavailable", "聊天附件服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取聊天附件")
		return
	}

	rawPath := strings.TrimSpace(request.URL.Query().Get("path"))
	resolvedPath, ok := handler.resolveAttachmentPath(rawPath)
	if !ok {
		writeError(response, http.StatusNotFound, "chat_attachment_not_found", "未找到聊天附件")
		return
	}

	contentType := attachmentMIMEType(resolvedPath)
	if contentType == "" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_chat_attachment_type", "不支持的聊天附件类型")
		return
	}

	file, err := os.Open(resolvedPath)
	if err != nil {
		writeError(response, http.StatusNotFound, "chat_attachment_not_found", "未找到聊天附件")
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		writeError(response, http.StatusNotFound, "chat_attachment_not_found", "未找到聊天附件")
		return
	}

	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	response.Header().Set("Cache-Control", "private, max-age=300")
	response.WriteHeader(http.StatusOK)
	_, _ = io.Copy(response, file)
}

func (handler *Handler) resolveAttachmentPath(rawPath string) (string, bool) {
	if rawPath == "" {
		return "", false
	}
	canonical := sessionevents.CanonicalizePath(rawPath, handler.aiHomeDir, handler.hostHomeDir, "")
	if canonical == rawPath && isInsideProjectionRoot(rawPath, handler.aiHomeDir) {
		return "", false
	}
	if !filepath.IsAbs(canonical) {
		return "", false
	}
	lexicalTarget := filepath.Clean(canonical)
	if isPrivateAttachmentPath(lexicalTarget) {
		return "", false
	}
	lexicalRoot := handler.matchAllowedRoot(lexicalTarget)
	if lexicalRoot == "" {
		return "", false
	}

	realTarget, err := filepath.EvalSymlinks(lexicalTarget)
	if err != nil {
		return "", false
	}
	realRoot, err := filepath.EvalSymlinks(lexicalRoot)
	if err != nil {
		return "", false
	}
	realTarget = filepath.Clean(realTarget)
	realRoot = filepath.Clean(realRoot)

	if !storagepolicy.PathWithinRoot(realRoot, realTarget) || isPrivateAttachmentPath(realTarget) {
		return "", false
	}
	stat, err := os.Stat(realTarget)
	if err != nil || !stat.Mode().IsRegular() {
		return "", false
	}
	return realTarget, true
}

func (handler *Handler) matchAllowedRoot(lexicalTarget string) string {
	roots := handler.allowedRoots(lexicalTarget)
	for _, root := range roots {
		if storagepolicy.PathWithinRoot(root, lexicalTarget) {
			return root
		}
	}
	return ""
}

func (handler *Handler) allowedRoots(lexicalTarget string) []string {
	roots := make([]string, 0, 20)
	seen := make(map[string]struct{}, 20)
	addRoot := func(candidate string) {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			return
		}
		clean := filepath.Clean(trimmed)
		if _, ok := seen[clean]; !ok {
			seen[clean] = struct{}{}
			roots = append(roots, clean)
		}
		// macOS 下 os.TempDir() 常通过 /var -> /private/var 符号链接到达，补齐真实根避免误拒。
		if eval, err := filepath.EvalSymlinks(clean); err == nil {
			cleanEval := filepath.Clean(eval)
			if _, ok := seen[cleanEval]; !ok {
				seen[cleanEval] = struct{}{}
				roots = append(roots, cleanEval)
			}
		}
	}

	addRoot(handler.chatImageRootDir)
	if handler.hostHomeDir != "" {
		for _, provider := range storagepolicy.Names() {
			policy := storagepolicy.Get(provider)
			if policy == nil {
				continue
			}
			// qoder/qodercn 没有独立原生目录（NativeRoot 为空）：绝不把裸 hostHomeDir 加入白名单，
			// 只放行其附件子目录及宿主演示认证目录（其中凭证路径仍由私密规则阻止）。
			if len(policy.NativeRoot) == 0 {
				addRoot(storagepolicy.ResolveAttachmentRoot(handler.hostHomeDir, provider))
				if len(policy.HostAuthRoot) > 0 {
					parts := append([]string{handler.hostHomeDir}, policy.HostAuthRoot...)
					addRoot(filepath.Join(parts...))
				}
				continue
			}
			addRoot(storagepolicy.ResolveNativeRoot(handler.hostHomeDir, provider))
		}
	}
	if projectRoot := resolveProjectAttachmentRoot(lexicalTarget); projectRoot != "" {
		addRoot(projectRoot)
	}
	return roots
}

func resolveProjectAttachmentRoot(targetPath string) string {
	marker := string(filepath.Separator) + ".aih" + string(filepath.Separator) + "chat-images"
	index := strings.Index(targetPath, marker)
	if index < 0 {
		return ""
	}
	end := index + len(marker)
	if end < len(targetPath) && targetPath[end] != filepath.Separator {
		return ""
	}
	return filepath.Clean(targetPath[:end])
}

func isInsideProjectionRoot(rawPath, aiHomeDir string) bool {
	if strings.TrimSpace(aiHomeDir) == "" || !filepath.IsAbs(rawPath) {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(aiHomeDir), filepath.Clean(rawPath))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	slashed := strings.ToLower(filepath.ToSlash(rel))
	return strings.HasPrefix(slashed, "run/auth-projections/") || strings.HasPrefix(slashed, "profiles/")
}

func isPrivateAttachmentPath(filePath string) bool {
	if storagepolicy.IsPrivateArtifactPath(filePath) {
		return true
	}
	parts := splitLowerSegments(filePath)
	for _, seq := range privateDirSequences {
		if containsSegmentSequence(parts, seq) {
			return true
		}
	}
	return false
}

func splitLowerSegments(filePath string) []string {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	raw := strings.Split(normalized, "/")
	parts := make([]string, 0, len(raw))
	for _, seg := range raw {
		trimmed := strings.ToLower(strings.TrimSpace(seg))
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	return parts
}

func containsSegmentSequence(parts, seq []string) bool {
	if len(seq) == 0 || len(parts) < len(seq) {
		return false
	}
	for start := 0; start <= len(parts)-len(seq); start++ {
		matched := true
		for i := range seq {
			if parts[start+i] != seq[i] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func attachmentMIMEType(filePath string) string {
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filePath)))
	return attachmentContentTypes[ext]
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(errorResponse{
		OK:      false,
		Error:   code,
		Message: message,
	})
}
