package webuiegresspoolapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

const (
	// ProbePath 是立即探测节点连通性的 POST 契约路径。
	ProbePath = Path + "/probe"
	// PolicyPath 是读写节点拦截策略的契约路径。
	PolicyPath = Path + "/node-policy"
	// PolicyClearDisabledPath 是清空全部手动禁用节点的 POST 契约路径。
	PolicyClearDisabledPath = PolicyPath + "/clear-disabled"
	// NodeActionPath 是单节点控制动作的路径模式。
	NodeActionPath = Path + "/nodes/{name}/{action}"

	// GroupsPath 是节点池组三层视图路径。
	GroupsPath = "/v1/management/webui/egress-pool-groups"
	// PoolsPath 是代理池列表视图路径。
	PoolsPath = "/v1/management/webui/egress-pools"
	// PoolItemPath 是单个代理池查询路径。
	PoolItemPath = PoolsPath + "/{poolId}"
	// NodeItemPath 是单个代理节点查询路径。
	NodeItemPath = "/v1/management/webui/egress-nodes/{nodeId}"
	// EvidencePath 是限定作用域实测诊断查询路径。
	EvidencePath = "/v1/management/webui/egress-evidence"

	maxActionBodyBytes = 8 * 1024
)

type fullPoolResponse struct {
	OK bool `json:"ok"`
	*runtimeegress.PoolDescribeResult
}

func (handler *Handler) serveFullHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	escapedPath := request.URL.EscapedPath()
	if escapedPath == "" {
		escapedPath = request.URL.Path
	}

	switch {
	case escapedPath == Path:
		if request.Method != http.MethodGet {
			responseWriter.Header().Set("Allow", http.MethodGet)
			writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 读取出口池")
			return
		}
		handler.handleFullPoolGet(responseWriter, request)

	case escapedPath == GroupsPath:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		groups := handler.manager.ListPoolGroupsTree(request.Context())
		if groups == nil {
			groups = []runtimeegress.ResourceGroupView{}
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "groups": groups})

	case escapedPath == PoolsPath:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		pools := handler.manager.ListPoolsView(request.Context())
		if pools == nil {
			pools = []runtimeegress.ResourcePoolView{}
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "pools": pools})

	case strings.HasPrefix(escapedPath, PoolsPath+"/"):
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		rawID := strings.TrimPrefix(escapedPath, PoolsPath+"/")
		if strings.Contains(rawID, "/") {
			writeError(responseWriter, http.StatusNotFound, "not_found", "未找到资源路径")
			return
		}
		poolID, ok := decodeSingleSegment(rawID)
		if !ok || poolID == "" {
			writeError(responseWriter, http.StatusBadRequest, "invalid_pool_id", "代理池 ID 无效")
			return
		}
		pool, found := handler.manager.GetPoolView(request.Context(), poolID)
		if !found {
			writeError(responseWriter, http.StatusNotFound, "egress_pool_not_found", "未找到指定代理池")
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "pool": pool})

	case strings.HasPrefix(escapedPath, "/v1/management/webui/egress-nodes/"):
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		rawID := strings.TrimPrefix(escapedPath, "/v1/management/webui/egress-nodes/")
		if strings.Contains(rawID, "/") {
			writeError(responseWriter, http.StatusNotFound, "not_found", "未找到资源路径")
			return
		}
		nodeID, ok := decodeSingleSegment(rawID)
		if !ok || nodeID == "" {
			writeError(responseWriter, http.StatusBadRequest, "invalid_node_id", "节点 ID 无效")
			return
		}
		node, found := handler.manager.GetNodeView(request.Context(), nodeID)
		if !found {
			writeError(responseWriter, http.StatusNotFound, "egress_node_not_found", "未找到指定节点")
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "node": node})

	case escapedPath == EvidencePath:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		q := request.URL.Query()
		diagQuery := runtimeegress.AccountDiagnosticQuery{
			Provider:   strings.TrimSpace(q.Get("provider")),
			AccountRef: strings.TrimSpace(q.Get("accountRef")),
			UpstreamID: strings.TrimSpace(q.Get("upstreamId")),
			NodeID:     strings.TrimSpace(q.Get("nodeId")),
		}
		if diagQuery.Provider == "" && diagQuery.AccountRef == "" && diagQuery.UpstreamID == "" && diagQuery.NodeID == "" {
			writeError(responseWriter, http.StatusBadRequest, "diagnostic_scope_required", "需要至少一个诊断作用域参数")
			return
		}
		diag := handler.manager.BuildDiagnosticView(request.Context(), diagQuery)
		writeJSON(responseWriter, http.StatusOK, map[string]any{
			"ok":             true,
			"scope":          diag.Scope,
			"query":          diag.Query,
			"evidence":       diag.Evidence,
			"summary":        diag.Summary,
			"globalBlocking": diag.GlobalBlocking,
		})

	case escapedPath == ProbePath:
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		var body struct {
			Node string `json:"node"`
		}
		if !readOptionalJSONObject(responseWriter, request, &body) {
			return
		}
		result := handler.manager.ProbePoolNodes(request.Context(), strings.TrimSpace(body.Node))
		writeActionResult(responseWriter, result)

	case escapedPath == PolicyPath:
		switch request.Method {
		case http.MethodGet:
			summary := handler.manager.ReadNodePolicySummary(request.Context())
			writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "nodePolicy": summary})
		case http.MethodPost:
			var patch runtimeegress.NodePolicyPatch
			if !readOptionalJSONObject(responseWriter, request, &patch) {
				return
			}
			result := handler.manager.UpdateNodePolicy(request.Context(), patch)
			writeActionResult(responseWriter, result)
		default:
			responseWriter.Header().Set("Allow", "GET, POST")
			writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 或 POST")
		}

	case escapedPath == PolicyClearDisabledPath:
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		result := handler.manager.ClearDisabledNodePolicy(request.Context())
		writeActionResult(responseWriter, result)

	case strings.HasPrefix(escapedPath, Path+"/nodes/"):
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		handler.handleNodeAction(responseWriter, request, escapedPath)

	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到出口池路由")
	}
}

func (handler *Handler) handleFullPoolGet(responseWriter http.ResponseWriter, request *http.Request) {
	query := parsePoolQuery(request)
	result, etag, err := handler.manager.DescribePool(request.Context(), query)
	if err != nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "egress_pool_unavailable", "出口池配置读取失败")
		return
	}
	if query.HasPage && etag != "" && strings.TrimSpace(request.Header.Get("If-None-Match")) == etag {
		responseWriter.Header().Set("ETag", etag)
		responseWriter.Header().Set("Cache-Control", "no-store")
		responseWriter.WriteHeader(http.StatusNotModified)
		return
	}
	if query.HasPage && etag != "" {
		responseWriter.Header().Set("ETag", etag)
	}
	writeJSON(responseWriter, http.StatusOK, fullPoolResponse{OK: true, PoolDescribeResult: result})
}

func (handler *Handler) handleNodeAction(responseWriter http.ResponseWriter, request *http.Request, escapedPath string) {
	rest := strings.TrimPrefix(escapedPath, Path+"/nodes/")
	slash := strings.LastIndex(rest, "/")
	if slash <= 0 || slash == len(rest)-1 {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到节点操作路由")
		return
	}
	rawName := rest[:slash]
	action := rest[slash+1:]
	if strings.Contains(rawName, "/") {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到节点操作路由")
		return
	}
	nodeName, ok := decodeSingleSegment(rawName)
	if !ok || nodeName == "" {
		writeError(responseWriter, http.StatusBadRequest, "invalid_node_name", "节点名称无效")
		return
	}

	var result runtimeegress.PoolActionResult
	switch action {
	case "select":
		result = handler.manager.SelectPoolNode(request.Context(), nodeName)
	case "clear-cooldown":
		result = handler.manager.ClearPoolNodeCooldown(request.Context(), nodeName)
	case "block", "unblock":
		var body struct {
			Reason string `json:"reason"`
		}
		if !readOptionalJSONObject(responseWriter, request, &body) {
			return
		}
		reason := strings.TrimSpace(body.Reason)
		if reason == "" {
			reason = "manual"
		}
		result = handler.manager.SetPoolNodeBlocked(request.Context(), nodeName, action == "block", reason)
	default:
		writeError(responseWriter, http.StatusNotFound, "egress_pool_action_unknown", "不支持的节点操作")
		return
	}
	writeActionResult(responseWriter, result)
}

func parsePoolQuery(request *http.Request) runtimeegress.PoolQueryOptions {
	values := request.URL.Query()
	if !values.Has("page") {
		return runtimeegress.PoolQueryOptions{HasPage: false, Filter: "all"}
	}
	page, _ := strconv.Atoi(strings.TrimSpace(values.Get("page")))
	if page <= 0 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(strings.TrimSpace(values.Get("pageSize")))
	if pageSize <= 0 {
		pageSize = 50
	}
	filter := strings.TrimSpace(values.Get("filter"))
	if filter == "" {
		filter = "all"
	}
	return runtimeegress.PoolQueryOptions{
		HasPage:  true,
		Page:     page,
		PageSize: pageSize,
		Filter:   filter,
		Query:    strings.TrimSpace(values.Get("query")),
	}
}

func decodeSingleSegment(raw string) (string, bool) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(decoded), true
}

func requireMethod(responseWriter http.ResponseWriter, request *http.Request, allow string) bool {
	if request.Method == allow {
		return true
	}
	responseWriter.Header().Set("Allow", allow)
	writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不支持")
	return false
}

func readOptionalJSONObject(responseWriter http.ResponseWriter, request *http.Request, target any) bool {
	if request.Body == nil {
		return true
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxActionBodyBytes+1))
	if err != nil || len(raw) > maxActionBodyBytes {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体过大或不可读")
		return false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return true
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil || obj == nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体必须是 JSON 对象")
		return false
	}
	if err := json.Unmarshal([]byte(trimmed), target); err != nil {
		var synErr *json.SyntaxError
		_ = errors.As(err, &synErr)
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体 JSON 格式错误")
		return false
	}
	return true
}

func writeActionResult(responseWriter http.ResponseWriter, result runtimeegress.PoolActionResult) {
	status := http.StatusOK
	if !result.OK {
		status = http.StatusConflict
	}
	writeJSON(responseWriter, status, result)
}
