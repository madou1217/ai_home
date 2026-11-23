// Package webuiworkspaceconnectorapi exposes the Server-side enrollment and
// observation API for local Workspace Connectors.
//
// The connect endpoint is authenticated by the connector token in its first
// frame, not by the management key: the local connector must never receive the
// Server management credential.
package webuiworkspaceconnectorapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const (
	Path            = remoteconnector.ManagementPath
	EnrollmentsPath = remoteconnector.EnrollmentsPath
	ConnectPath     = remoteconnector.ConnectPath
	WorkspacePath   = remoteconnector.WorkspacePath
	EntriesPath     = remoteconnector.EntriesPath
	RPCPath         = remoteconnector.RPCPath
	ToolPath        = remoteconnector.ToolPath
	ApprovalsPath   = remoteconnector.ApprovalsPath

	maxEnrollmentBodyBytes = 16 * 1024
	maxRPCBodyBytes        = 8 * 1024 * 1024
	maxToolBodyBytes       = 1024 * 1024
	maxEntriesLimit        = 1000
)

var ErrInvalidDependencies = errors.New("workspace connector handler dependencies are invalid")

type Authorizer interface {
	Authorized(*http.Request) bool
}

type Dependencies struct {
	Authorizer Authorizer
	Store      *workspaceconnector.Store
	Hub        *workspaceconnector.Hub
	ServerID   func(context.Context) (string, error)
}

type Handler struct {
	authorizer Authorizer
	store      *workspaceconnector.Store
	hub        *workspaceconnector.Hub
	serverID   func(context.Context) (string, error)
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil || dependencies.Hub == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		hub:        dependencies.Hub,
		serverID:   dependencies.ServerID,
	}, nil
}

type enrollmentRequest struct {
	Label      string `json:"label,omitempty"`
	TTLSeconds int    `json:"ttlSeconds,omitempty"`
}

type enrollmentResponse struct {
	OK         bool                          `json:"ok"`
	Enrollment workspaceconnector.Enrollment `json:"enrollment"`
}

type workspaceView struct {
	workspaceconnector.Workspace
	Transport      string `json:"transport"`
	State          string `json:"state"`
	Online         bool   `json:"online"`
	SessionID      string `json:"sessionId,omitempty"`
	ConnectedAt    int64  `json:"connectedAt,omitempty"`
	LiveLastSeenAt int64  `json:"liveLastSeenAt,omitempty"`
}

type listResponse struct {
	OK         bool            `json:"ok"`
	ServerID   string          `json:"serverId,omitempty"`
	Count      int             `json:"count"`
	Workspaces []workspaceView `json:"workspaces"`
}

type entriesResponse struct {
	OK          bool                                `json:"ok"`
	WorkspaceID string                              `json:"workspaceId"`
	Directory   remoteconnector.ListDirectoryResult `json:"directory"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.store == nil || handler.hub == nil {
		writeError(response, http.StatusServiceUnavailable, remoteconnector.CodeInternal, "workspace connector service is unavailable")
		return
	}
	if request.URL != nil && request.URL.Path == ConnectPath {
		handler.serveConnect(response, request)
		return
	}
	if strings.HasSuffix(request.URL.Path, "/tools") {
		handler.serveTool(response, request)
		return
	}
	if handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch {
	case request.URL.Path == Path:
		handler.serveList(response, request)
	case request.URL.Path == EnrollmentsPath:
		handler.serveEnrollment(response, request)
	case strings.HasSuffix(request.URL.Path, "/entries"):
		handler.serveEntries(response, request)
	case strings.HasSuffix(request.URL.Path, "/approvals"):
		handler.serveApprovals(response, request)
	case strings.HasSuffix(request.URL.Path, "/rpc"):
		handler.serveRPC(response, request)
	case request.PathValue("workspaceId") != "":
		handler.serveWorkspace(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "workspace connector route not found")
	}
}

func (handler *Handler) serveList(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, http.MethodGet)
		return
	}
	workspaces, err := handler.store.List(request.Context())
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	views := make([]workspaceView, 0, len(workspaces))
	for _, workspace := range workspaces {
		view := workspaceView{Workspace: workspace, Transport: "connector", State: "offline"}
		if workspace.Revoked() {
			view.State = "revoked"
		} else if status, online := handler.hub.Status(workspace.ID); online {
			view.State = "online"
			view.Online = true
			view.SessionID = status.SessionID
			view.ConnectedAt = status.ConnectedAt
			view.LiveLastSeenAt = status.LastSeenAt
			// The live session is authoritative: it reflects a connector
			// started with --no-command, not just the durable grant.
			view.Capabilities = status.Capabilities
		}
		views = append(views, view)
	}
	payload := listResponse{OK: true, Count: len(views), Workspaces: views}
	if handler.serverID != nil {
		if serverID, err := handler.serverID(request.Context()); err == nil {
			payload.ServerID = strings.TrimSpace(serverID)
		}
	}
	writeJSON(response, http.StatusOK, payload)
}

func (handler *Handler) serveEnrollment(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, http.MethodPost)
		return
	}
	var input enrollmentRequest
	if request.Body != nil {
		body, err := io.ReadAll(io.LimitReader(request.Body, maxEnrollmentBodyBytes+1))
		if err != nil {
			writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "cannot read enrollment request")
			return
		}
		if len(body) > maxEnrollmentBodyBytes {
			writeError(response, http.StatusRequestEntityTooLarge, remoteconnector.CodeInvalidPayload, "enrollment request is too large")
			return
		}
		if len(strings.TrimSpace(string(body))) > 0 {
			if err := json.Unmarshal(body, &input); err != nil {
				writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "enrollment request must be JSON")
				return
			}
		}
	}
	ttl := time.Duration(input.TTLSeconds) * time.Second
	enrollment, err := handler.store.CreateEnrollment(request.Context(), input.Label, ttl)
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, enrollmentResponse{OK: true, Enrollment: enrollment})
}

func (handler *Handler) serveWorkspace(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodDelete {
		methodNotAllowed(response, http.MethodDelete)
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeWorkspaceNotFound, "workspace id is required")
		return
	}
	if err := handler.store.Revoke(request.Context(), workspaceID); err != nil {
		writeProtocolError(response, err)
		return
	}
	handler.hub.DisconnectWithError(workspaceID, "revoked", remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "workspaceId": workspaceID, "state": "revoked"})
}

func (handler *Handler) serveEntries(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, http.MethodGet)
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeWorkspaceNotFound, "workspace id is required")
		return
	}
	workspace, found, err := handler.store.Find(request.Context(), workspaceID)
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
		return
	}
	if workspace.Revoked() {
		writeError(response, http.StatusConflict, remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
		return
	}
	limit := 0
	if raw := strings.TrimSpace(request.URL.Query().Get("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 0 {
			writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidQuery, "limit must be a non-negative integer")
			return
		}
		limit = parsed
	}
	if limit > maxEntriesLimit {
		limit = maxEntriesLimit
	}
	result, err := handler.hub.Call(request.Context(), workspaceID, remoteconnector.OperationListDirectory, remoteconnector.ListDirectoryRequest{
		Path: strings.TrimSpace(request.URL.Query().Get("path")), Limit: limit,
	})
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	var directory remoteconnector.ListDirectoryResult
	if err := json.Unmarshal(result, &directory); err != nil {
		writeError(response, http.StatusBadGateway, remoteconnector.CodeProtocolError, "connector returned an invalid directory result")
		return
	}
	writeJSON(response, http.StatusOK, entriesResponse{OK: true, WorkspaceID: workspaceID, Directory: directory})
}

type toolCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

// serveTool is authenticated by a workspace-scoped tool token, never by the
// management key or the connector session token. It returns the MCP tools/call
// shape unchanged so the stdio bridge can forward it.
func (handler *Handler) serveTool(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, http.MethodPost)
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeWorkspaceNotFound, "workspace id is required")
		return
	}
	token := strings.TrimSpace(request.Header.Get(remoteconnector.ToolTokenHeader))
	if token == "" {
		writeError(response, http.StatusUnauthorized, remoteconnector.CodeInvalidToken, "tool token is required")
		return
	}
	workspace, err := handler.store.AuthenticateToolToken(request.Context(), workspaceID, token)
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	if workspace.ID != workspaceID {
		writeError(response, http.StatusUnauthorized, remoteconnector.CodeInvalidToken, "tool token does not match the workspace")
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxToolBodyBytes+1))
	if err != nil {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "cannot read tool call")
		return
	}
	if len(body) > maxToolBodyBytes {
		writeError(response, http.StatusRequestEntityTooLarge, remoteconnector.CodeInvalidPayload, "tool call is too large")
		return
	}
	var input toolCallRequest
	if err := json.Unmarshal(body, &input); err != nil || strings.TrimSpace(input.Name) == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "tool call must include a name")
		return
	}
	result := workspaceconnector.CallTool(request.Context(), handler.hub, workspaceID, input.Name, input.Arguments)
	writeJSON(response, http.StatusOK, result)
}

type rpcRequest struct {
	Operation string          `json:"operation"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type rpcResponse struct {
	OK          bool            `json:"ok"`
	WorkspaceID string          `json:"workspaceId"`
	Operation   string          `json:"operation"`
	Result      json.RawMessage `json:"result,omitempty"`
}

func (handler *Handler) serveRPC(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, http.MethodPost)
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeWorkspaceNotFound, "workspace id is required")
		return
	}
	workspace, found, err := handler.store.Find(request.Context(), workspaceID)
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
		return
	}
	if workspace.Revoked() {
		writeError(response, http.StatusConflict, remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
		return
	}
	if request.Body == nil {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "rpc body is required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxRPCBodyBytes+1))
	if err != nil {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "cannot read rpc body")
		return
	}
	if len(body) > maxRPCBodyBytes {
		writeError(response, http.StatusRequestEntityTooLarge, remoteconnector.CodeInvalidPayload, "rpc body is too large")
		return
	}
	var input rpcRequest
	if err := json.Unmarshal(body, &input); err != nil {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "rpc body must be JSON")
		return
	}
	input.Operation = strings.TrimSpace(input.Operation)
	if input.Operation == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "rpc operation is required")
		return
	}
	result, err := handler.hub.Call(request.Context(), workspaceID, input.Operation, json.RawMessage(input.Payload))
	if err != nil {
		writeProtocolError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, rpcResponse{
		OK: true, WorkspaceID: workspaceID, Operation: input.Operation, Result: result,
	})
}

type approvalsResponse struct {
	OK        bool                              `json:"ok"`
	Workspace string                            `json:"workspaceId"`
	Mode      string                            `json:"mode"`
	Approvals []remoteconnector.ApprovalRequest `json:"approvals"`
}

type decideApprovalRequest struct {
	ID      string `json:"id"`
	Approve bool   `json:"approve"`
}

type decideApprovalResponse struct {
	OK       bool                            `json:"ok"`
	Approval remoteconnector.ApprovalRequest `json:"approval"`
}

// serveApprovals exposes the local command approvals to the WebUI. The
// decision itself is recorded by the connector; this endpoint only relays it
// over the authenticated management surface.
func (handler *Handler) serveApprovals(response http.ResponseWriter, request *http.Request) {
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, remoteconnector.CodeWorkspaceNotFound, "workspace id is required")
		return
	}
	switch request.Method {
	case http.MethodGet:
		raw, err := handler.hub.Call(request.Context(), workspaceID, remoteconnector.OperationListApprovals, struct{}{})
		if err != nil {
			writeProtocolError(response, err)
			return
		}
		var result remoteconnector.ListApprovalsResult
		if err := json.Unmarshal(raw, &result); err != nil {
			writeError(response, http.StatusBadGateway, remoteconnector.CodeProtocolError, "connector returned an invalid approvals result")
			return
		}
		if result.Approvals == nil {
			result.Approvals = []remoteconnector.ApprovalRequest{}
		}
		writeJSON(response, http.StatusOK, approvalsResponse{OK: true, Workspace: workspaceID, Mode: result.Mode, Approvals: result.Approvals})
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(request.Body, 4096))
		if err != nil {
			writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "cannot read approval decision")
			return
		}
		var input decideApprovalRequest
		if err := json.Unmarshal(body, &input); err != nil || strings.TrimSpace(input.ID) == "" {
			writeError(response, http.StatusBadRequest, remoteconnector.CodeInvalidPayload, "approval decision must include an id")
			return
		}
		raw, err := handler.hub.Call(request.Context(), workspaceID, remoteconnector.OperationDecideApproval, remoteconnector.DecideApprovalRequest{
			ID: strings.TrimSpace(input.ID), Approve: input.Approve,
		})
		if err != nil {
			writeProtocolError(response, err)
			return
		}
		var result remoteconnector.DecideApprovalResult
		if err := json.Unmarshal(raw, &result); err != nil {
			writeError(response, http.StatusBadGateway, remoteconnector.CodeProtocolError, "connector returned an invalid approval result")
			return
		}
		writeJSON(response, http.StatusOK, decideApprovalResponse{OK: true, Approval: result.Approval})
	default:
		methodNotAllowed(response, http.MethodGet+", "+http.MethodPost)
	}
}

func methodNotAllowed(response http.ResponseWriter, allowed string) {
	response.Header().Set("Allow", allowed)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 "+allowed)
}

func writeProtocolError(response http.ResponseWriter, err error) {
	code := remoteconnector.ErrorCode(err)
	message := "workspace connector operation failed"
	if protocolErr := asProtocolError(err); protocolErr != nil && protocolErr.Message != "" {
		message = protocolErr.Message
	}
	writeError(response, statusForCode(code), code, message)
}

func asProtocolError(err error) *remoteconnector.ProtocolError {
	var protocolErr *remoteconnector.ProtocolError
	if errors.As(err, &protocolErr) {
		return protocolErr
	}
	return nil
}

func statusForCode(code string) int {
	switch code {
	case remoteconnector.CodeInvalidToken, remoteconnector.CodeEnrollmentNotFound,
		remoteconnector.CodeEnrollmentExpired, remoteconnector.CodeEnrollmentUsed:
		return http.StatusUnauthorized
	case remoteconnector.CodeWorkspaceNotFound, remoteconnector.CodePathNotFound, remoteconnector.CodeJobNotFound,
		remoteconnector.CodeApprovalNotFound:
		return http.StatusNotFound
	case remoteconnector.CodeWorkspaceRevoked, remoteconnector.CodeWorkspaceOffline,
		remoteconnector.CodeVersionConflict, remoteconnector.CodeWorkspaceLimit,
		remoteconnector.CodeJobLimit, remoteconnector.CodeApprovalRequired,
		remoteconnector.CodeApprovalDenied, remoteconnector.CodeApprovalExpired,
		remoteconnector.CodeApprovalUsed:
		return http.StatusConflict
	case remoteconnector.CodeCapabilityNotAllowed:
		return http.StatusForbidden
	case remoteconnector.CodeUnsupportedOperation:
		return http.StatusNotImplemented
	case remoteconnector.CodeInvalidPath, remoteconnector.CodePathOutsideWorkspace,
		remoteconnector.CodeInvalidPayload, remoteconnector.CodeInvalidQuery,
		remoteconnector.CodeNotAFile, remoteconnector.CodeNotADirectory:
		return http.StatusBadRequest
	case remoteconnector.CodeFileTooLarge:
		return http.StatusRequestEntityTooLarge
	case remoteconnector.CodeRequestTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
