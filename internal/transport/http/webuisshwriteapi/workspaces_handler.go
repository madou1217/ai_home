package webuisshwriteapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// WorkspacesPath 是 SSH 工作区写入的集合管理路径（POST 新增）。
	WorkspacesPath = "/v1/management/webui/ssh-workspaces"
	// WorkspaceItemPath 是单条工作区的编辑 / 删除管理路径（PUT / DELETE）。
	WorkspaceItemPath = WorkspacesPath + "/{id}"

	maxRemoteRootBytes = 4096
)

var workspaceIDPattern = regexp.MustCompile(`^ws_[a-f0-9]{16}$`)

// WorkspaceStore 在 BEGIN IMMEDIATE 事务里读 ssh_connections 并原子读改写 ssh_workspaces。
type WorkspaceStore interface {
	UpdateWorkspacesWithConnections(ctx context.Context, mutate func(connections KV, workspaces KV) (string, error)) error
}

// WorkspaceDependencies 汇总工作区写入依赖。
type WorkspaceDependencies struct {
	Authorizer          Authorizer
	Store               WorkspaceStore
	OnWorkspacesChanged func(ctx context.Context)
}

// WorkspacesHandler 处理 SSH 工作区新增、编辑、删除。
type WorkspacesHandler struct {
	authorizer          Authorizer
	store               WorkspaceStore
	onWorkspacesChanged func(ctx context.Context)
}

// NewWorkspacesHandler 创建默认失败关闭的 Handler。
func NewWorkspacesHandler(dependencies WorkspaceDependencies) (*WorkspacesHandler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &WorkspacesHandler{
		authorizer:          dependencies.Authorizer,
		store:               dependencies.Store,
		onWorkspacesChanged: dependencies.OnWorkspacesChanged,
	}, nil
}

type workspaceResponse struct {
	OK        bool           `json:"ok"`
	Workspace map[string]any `json:"workspace"`
}

// ServeHTTP 按路径分派工作区集合（POST）与单条工作区（PUT / DELETE）。
func (handler *WorkspacesHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_workspaces_unavailable", "SSH 工作区写入服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	id, collection, ok := workspaceRouteTarget(request)
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "未知的 SSH 工作区路径")
		return
	}
	if collection {
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
			return
		}
		handler.create(response, request)
		return
	}
	if !workspaceIDPattern.MatchString(id) {
		writeError(response, http.StatusBadRequest, "invalid_workspace_id", "工作区 id 必须形如 ws_<16 位十六进制>")
		return
	}
	switch request.Method {
	case http.MethodPut:
		handler.update(response, request, id)
	case http.MethodDelete:
		handler.remove(response, request, id)
	default:
		response.Header().Set("Allow", http.MethodPut+", "+http.MethodDelete)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 PUT/DELETE")
	}
}

func workspaceRouteTarget(request *http.Request) (string, bool, bool) {
	path := strings.TrimSuffix(request.URL.Path, "/")
	if path == WorkspacesPath {
		return "", true, true
	}
	prefix := WorkspacesPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	id := request.PathValue("id")
	if id == "" {
		id = strings.TrimPrefix(path, prefix)
	}
	if id == "" || strings.Contains(id, "/") {
		return "", false, false
	}
	return id, false, true
}

func (handler *WorkspacesHandler) create(response http.ResponseWriter, request *http.Request) {
	payload, failure := decodePayload(response, request)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	connectionID, _, valid := readStringField(payload, "connectionId")
	if !valid {
		writeFailure(response, invalidFieldType("connectionId"))
		return
	}
	label, valid := readWorkspaceString(payload, "label")
	if !valid {
		writeFailure(response, invalidFieldType("label"))
		return
	}
	remoteRoot, valid := readWorkspaceString(payload, "remoteRoot")
	if !valid {
		writeFailure(response, invalidFieldType("remoteRoot"))
		return
	}
	if connectionID == "" || label == "" || remoteRoot == "" {
		writeError(response, http.StatusBadRequest, "missing_fields", "Connection, Label, and Remote Root are required.")
		return
	}
	if failure := validateWorkspaceFields(label, remoteRoot); failure != nil {
		writeFailure(response, failure)
		return
	}

	var created map[string]any
	err := handler.store.UpdateWorkspacesWithConnections(request.Context(), func(connectionsKV KV, workspacesKV KV) (string, error) {
		connections, failure := decodeConnections(connectionsKV.Value, connectionsKV.Found)
		if failure != nil {
			return "", failure
		}
		if !connectionExists(connections, connectionID) {
			return "", &requestError{status: http.StatusBadRequest, code: "invalid_connection", message: "Specified SSH connection does not exist."}
		}
		workspaces, failure := decodeWorkspaces(workspacesKV.Value, workspacesKV.Found)
		if failure != nil {
			return "", failure
		}
		id, failure := newWorkspaceID(workspaces)
		if failure != nil {
			return "", failure
		}
		workspace := map[string]any{
			"id":           id,
			"connectionId": connectionID,
			"label":        label,
			"remoteRoot":   remoteRoot,
			"createdAt":    time.Now().UnixMilli(),
		}
		workspaces = append(workspaces, workspace)
		encoded, encodeErr := json.Marshal(workspaces)
		if encodeErr != nil {
			return "", encodeErr
		}
		created = workspace
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_workspaces_write_failed")
		return
	}
	if handler.onWorkspacesChanged != nil {
		handler.onWorkspacesChanged(request.Context())
	}
	writeJSON(response, http.StatusOK, workspaceResponse{OK: true, Workspace: created})
}

func (handler *WorkspacesHandler) update(response http.ResponseWriter, request *http.Request, id string) {
	payload, failure := decodePayload(response, request)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	labelPatch, valid := presentRawWorkspaceString(payload, "label")
	if !valid {
		writeFailure(response, invalidFieldType("label"))
		return
	}
	remoteRootPatch, valid := presentRawWorkspaceString(payload, "remoteRoot")
	if !valid {
		writeFailure(response, invalidFieldType("remoteRoot"))
		return
	}
	connIDPatch, valid := presentTrimmedString(payload, "connectionId")
	if !valid {
		writeFailure(response, invalidFieldType("connectionId"))
		return
	}

	var updated map[string]any
	err := handler.store.UpdateWorkspacesWithConnections(request.Context(), func(connectionsKV KV, workspacesKV KV) (string, error) {
		workspaces, failure := decodeWorkspaces(workspacesKV.Value, workspacesKV.Found)
		if failure != nil {
			return "", failure
		}
		index := indexOfWorkspace(workspaces, id)
		if index < 0 {
			return "", &requestError{status: http.StatusNotFound, code: "not_found", message: "Workspace not found."}
		}
		workspace := cloneMap(workspaces[index])
		if connIDPatch != nil {
			connID := strings.TrimSpace(*connIDPatch)
			if connID != "" {
				connections, failure := decodeConnections(connectionsKV.Value, connectionsKV.Found)
				if failure != nil {
					return "", failure
				}
				if !connectionExists(connections, connID) {
					return "", &requestError{status: http.StatusBadRequest, code: "invalid_connection", message: "Specified SSH connection does not exist."}
				}
			} else {
				return "", &requestError{status: http.StatusBadRequest, code: "invalid_connection", message: "Specified SSH connection does not exist."}
			}
			workspace["connectionId"] = connID
		}
		if labelPatch != nil {
			workspace["label"] = *labelPatch
		}
		if remoteRootPatch != nil {
			workspace["remoteRoot"] = *remoteRootPatch
		}
		label := connectionString(workspace, "label")
		remoteRoot := connectionString(workspace, "remoteRoot")
		if label == "" || remoteRoot == "" {
			return "", &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: "Label and Remote Root cannot be empty."}
		}
		if failure := validateWorkspaceFields(label, remoteRoot); failure != nil {
			return "", failure
		}
		workspaces[index] = workspace
		encoded, encodeErr := json.Marshal(workspaces)
		if encodeErr != nil {
			return "", encodeErr
		}
		updated = workspace
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_workspaces_write_failed")
		return
	}
	if handler.onWorkspacesChanged != nil {
		handler.onWorkspacesChanged(request.Context())
	}
	writeJSON(response, http.StatusOK, workspaceResponse{OK: true, Workspace: updated})
}

func (handler *WorkspacesHandler) remove(response http.ResponseWriter, request *http.Request, id string) {
	var changed bool
	err := handler.store.UpdateWorkspacesWithConnections(request.Context(), func(_ KV, workspacesKV KV) (string, error) {
		workspaces, failure := decodeWorkspaces(workspacesKV.Value, workspacesKV.Found)
		if failure != nil {
			return "", failure
		}
		next := make([]map[string]any, 0, len(workspaces))
		for _, workspace := range workspaces {
			if connectionString(workspace, "id") == id {
				changed = true
				continue
			}
			next = append(next, workspace)
		}
		encoded, encodeErr := json.Marshal(next)
		if encodeErr != nil {
			return "", encodeErr
		}
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_workspaces_write_failed")
		return
	}
	if changed && handler.onWorkspacesChanged != nil {
		handler.onWorkspacesChanged(request.Context())
	}
	writeJSON(response, http.StatusOK, deleteResponse{OK: true})
}

func presentRawWorkspaceString(payload map[string]any, key string) (*string, bool) {
	raw, exists := payload[key]
	if !exists {
		return nil, true
	}
	if raw == nil {
		empty := ""
		return &empty, true
	}
	text, ok := raw.(string)
	if !ok {
		return nil, false
	}
	if strings.ContainsFunc(text, unicode.IsControl) {
		return nil, false
	}
	trimmed := strings.TrimSpace(text)
	return &trimmed, true
}

func readWorkspaceString(payload map[string]any, key string) (string, bool) {
	value, valid := presentRawWorkspaceString(payload, key)
	if !valid {
		return "", false
	}
	if value == nil {
		return "", true
	}
	return *value, true
}

func validateWorkspaceFields(label string, remoteRoot string) *requestError {
	if !validLabel(label) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: "Label 为空、过长或含控制字符"}
	}
	if remoteRoot == "" || len(remoteRoot) > maxRemoteRootBytes || strings.ContainsFunc(remoteRoot, unicode.IsControl) {
		return &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: "Remote Root 为空、过长或含控制字符"}
	}
	if utf8.RuneCountInString(label) > maxLabelRunes {
		return &requestError{status: http.StatusBadRequest, code: "invalid_fields", message: "Label 过长"}
	}
	return nil
}

func newWorkspaceID(workspaces []map[string]any) (string, *requestError) {
	for attempt := 0; attempt < 8; attempt++ {
		buffer := make([]byte, 8)
		if _, err := rand.Read(buffer); err != nil {
			return "", &requestError{status: http.StatusInternalServerError, code: "ssh_workspaces_write_failed"}
		}
		candidate := "ws_" + hex.EncodeToString(buffer)
		if indexOfWorkspace(workspaces, candidate) < 0 {
			return candidate, nil
		}
	}
	return "", &requestError{status: http.StatusInternalServerError, code: "ssh_workspaces_write_failed", message: "无法生成唯一工作区 id"}
}

func indexOfWorkspace(workspaces []map[string]any, id string) int {
	for index, workspace := range workspaces {
		if connectionString(workspace, "id") == id {
			return index
		}
	}
	return -1
}

// Keep unused error import explicit for callers checking ErrInvalidDependencies.
var _ = errors.Is
