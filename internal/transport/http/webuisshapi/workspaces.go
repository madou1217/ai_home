package webuisshapi

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"regexp"
)

const (
	// WorkspacesPath 是 SSH 工作区列表的只读管理契约。
	WorkspacesPath = "/v1/management/webui/ssh-workspaces"

	remoteWorkspacesDir = "remote-workspaces"
)

// remoteWorkspaceID 与 Node remote-session-bridge.js 的 WORKSPACE_ID 一致。
var remoteWorkspaceID = regexp.MustCompile(`^ws_[a-f0-9]{16}$`)

// WorkspaceStore 读取 Node 的 ssh_workspaces 原文。
type WorkspaceStore interface {
	ReadWorkspaces(ctx context.Context) (string, bool, error)
}

// WorkspacesHandler 处理 SSH 工作区列表读取。
type WorkspacesHandler struct {
	authorizer Authorizer
	store      WorkspaceStore
	aiHomeDir  string
}

// NewWorkspacesHandler 创建默认失败关闭的 Handler。
func NewWorkspacesHandler(dependencies Dependencies, store WorkspaceStore, aiHomeDir string) (*WorkspacesHandler, error) {
	if dependencies.Authorizer == nil || store == nil {
		return nil, ErrInvalidDependencies
	}
	return &WorkspacesHandler{authorizer: dependencies.Authorizer, store: store, aiHomeDir: aiHomeDir}, nil
}

type workspacesResponseView struct {
	OK         bool             `json:"ok"`
	Workspaces []map[string]any `json:"workspaces"`
}

// ServeHTTP 只接受 GET。
func (handler *WorkspacesHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_workspaces_unavailable", "SSH 工作区服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	raw, found, err := handler.store.ReadWorkspaces(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspaces_read_failed", "")
		return
	}
	workspaces, err := handler.sanitizeWorkspaces(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspaces_invalid", "ssh_workspaces 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, workspacesResponseView{OK: true, Workspaces: workspaces})
}

// sanitizeWorkspaces 复刻 Node：非数组 = 空列表；远端工作区补 projectPath
// （Server 本机影子目录），其它字段原样保留。
func (handler *WorkspacesHandler) sanitizeWorkspaces(raw string, found bool) ([]map[string]any, error) {
	result := make([]map[string]any, 0)
	if !found || raw == "" {
		return result, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return result, nil
	}
	for _, item := range list {
		workspace := map[string]any{}
		if object, ok := item.(map[string]any); ok {
			for key, value := range object {
				workspace[key] = value
			}
		}
		id, _ := workspace["id"].(string)
		if remoteWorkspaceID.MatchString(id) {
			workspace["projectPath"] = filepath.Join(handler.aiHomeDir, "run", remoteWorkspacesDir, id)
		}
		result = append(result, workspace)
	}
	return result, nil
}
