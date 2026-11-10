package webuisshwriteapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

// decodeWorkspaces 解析 ssh_workspaces 数组；元素按 map 保留未知字段与顺序，
// 与 Node 的 filter 语义一致。已存在但不是合法数组时失败关闭，不按空列表覆盖。
func decodeWorkspaces(current string, found bool) ([]map[string]any, *requestError) {
	workspaces := make([]map[string]any, 0)
	if !found || strings.TrimSpace(current) == "" {
		return workspaces, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(current), &decoded); err != nil {
		return nil, corruptWorkspaces()
	}
	list, ok := decoded.([]any)
	if !ok {
		return nil, corruptWorkspaces()
	}
	for _, item := range list {
		workspace, ok := item.(map[string]any)
		if !ok {
			return nil, corruptWorkspaces()
		}
		workspaces = append(workspaces, workspace)
	}
	return workspaces, nil
}

// removeWorkspacesForConnection 丢弃 connectionId 等于 id 的工作区，
// 其余（含未知字段）原样保留。比较不做 trim，与 Node 的 !== 等价。
func removeWorkspacesForConnection(current string, found bool, id string) ([]map[string]any, *requestError) {
	workspaces, failure := decodeWorkspaces(current, found)
	if failure != nil {
		return nil, failure
	}
	remaining := make([]map[string]any, 0, len(workspaces))
	for _, workspace := range workspaces {
		if workspaceConnectionID(workspace) == id {
			continue
		}
		remaining = append(remaining, workspace)
	}
	return remaining, nil
}

func workspaceConnectionID(workspace map[string]any) string {
	id, _ := workspace["connectionId"].(string)
	return id
}

func corruptWorkspaces() *requestError {
	return &requestError{
		status:  http.StatusInternalServerError,
		code:    "ssh_workspaces_invalid",
		message: "ssh_workspaces 不是合法的工作区数组，拒绝覆盖",
	}
}
