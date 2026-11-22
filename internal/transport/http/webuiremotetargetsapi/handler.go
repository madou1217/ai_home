package webuiremotetargetsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/remoteexecution"
)

const (
	Path        = "/v1/management/webui/remote-targets"
	ResolvePath = Path + "/resolve"
	DoctorPath  = Path + "/preflight"
)

var ErrInvalidDependencies = errors.New("remote target handler dependencies are invalid")

type Authorizer interface {
	Authorized(*http.Request) bool
}

type Dependencies struct {
	Authorizer Authorizer
	Source     FactsReader
}

type FactsReader interface {
	Read(context.Context) (remoteexecution.Facts, error)
}

type Handler struct {
	authorizer Authorizer
	source     FactsReader
	resolver   remoteexecution.Resolver
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Source == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		source:     dependencies.Source,
		resolver:   remoteexecution.Resolver{},
	}, nil
}

type listResponse struct {
	OK         bool                              `json:"ok"`
	ServerID   string                            `json:"serverId"`
	Candidates []remoteexecution.TargetCandidate `json:"candidates"`
	Warnings   []string                          `json:"warnings,omitempty"`
}

type resolveResponse struct {
	OK         bool                       `json:"ok"`
	Resolution remoteexecution.Resolution `json:"resolution"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
	Field   string `json:"field,omitempty"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.source == nil {
		writeError(response, http.StatusServiceUnavailable, "remote_targets_unavailable", "remote target service is unavailable")
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
	selector, err := parseSelector(request.URL.Query())
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	facts, err := handler.source.Read(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "remote_targets_read_failed", "读取远程执行目标事实失败")
		return
	}

	switch request.URL.Path {
	case Path:
		handler.serveList(response, facts, selector)
	case ResolvePath, DoctorPath:
		resolution, resolveErr := handler.resolver.Resolve(facts, selector)
		if resolveErr != nil {
			writeResolutionError(response, resolveErr)
			return
		}
		writeJSON(response, http.StatusOK, resolveResponse{OK: true, Resolution: resolution})
	default:
		writeError(response, http.StatusNotFound, "not_found", "remote target route not found")
	}
}

func (handler *Handler) serveList(response http.ResponseWriter, facts remoteexecution.Facts, selector remoteexecution.TargetSelector) {
	candidates := handler.resolver.Candidates(facts)
	candidates = filterCandidates(candidates, selector)
	writeJSON(response, http.StatusOK, listResponse{
		OK: true, ServerID: facts.ServerID, Candidates: candidates,
	})
}

func filterCandidates(candidates []remoteexecution.TargetCandidate, selector remoteexecution.TargetSelector) []remoteexecution.TargetCandidate {
	result := make([]remoteexecution.TargetCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if selector.ServerID != "" && candidate.ServerID != selector.ServerID {
			continue
		}
		if selector.WorkspaceID != "" && candidate.Workspace.ID != selector.WorkspaceID {
			continue
		}
		if selector.ConnectionID != "" && candidate.Workspace.ConnectionID != selector.ConnectionID {
			continue
		}
		if selector.Harness != "" && !strings.EqualFold(candidate.Runner.ID, selector.Harness) {
			continue
		}
		if selector.Provider != "" && !strings.EqualFold(candidate.Model.Provider, selector.Provider) {
			continue
		}
		if selector.AccountRef != "" && candidate.Account.AccountRef != selector.AccountRef {
			continue
		}
		if selector.Model != "" && candidate.Model.CatalogModelID != selector.Model && candidate.Model.CLIModelName != selector.Model {
			continue
		}
		result = append(result, candidate)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func parseSelector(values url.Values) (remoteexecution.TargetSelector, error) {
	allowed := map[string]bool{
		"serverProfileId": true, "serverId": true, "workspaceId": true, "connectionId": true,
		"harness": true, "provider": true, "accountRef": true, "model": true,
	}
	for key := range values {
		if !allowed[key] {
			return remoteexecution.TargetSelector{}, errors.New("unknown query parameter: " + key)
		}
		if len(values[key]) != 1 {
			return remoteexecution.TargetSelector{}, errors.New("query parameter must appear once: " + key)
		}
	}
	return remoteexecution.NormalizeSelector(remoteexecution.TargetSelector{
		ServerProfileID: values.Get("serverProfileId"),
		ServerID:        values.Get("serverId"),
		WorkspaceID:     values.Get("workspaceId"),
		ConnectionID:    values.Get("connectionId"),
		Harness:         values.Get("harness"),
		Provider:        values.Get("provider"),
		AccountRef:      values.Get("accountRef"),
		Model:           values.Get("model"),
	}), nil
}

func writeResolutionError(response http.ResponseWriter, err error) {
	var resolutionErr *remoteexecution.ResolutionError
	if errors.As(err, &resolutionErr) {
		status := http.StatusUnprocessableEntity
		if resolutionErr.Code == "server_identity_unavailable" || resolutionErr.Code == "invalid_workspace_fact" {
			status = http.StatusServiceUnavailable
		}
		writeErrorWithField(response, status, resolutionErr.Code, resolutionErr.Detail, resolutionErr.Field)
		return
	}
	writeError(response, http.StatusServiceUnavailable, "remote_target_resolution_failed", "远程执行目标解析失败")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeErrorWithField(response, status, code, message, "")
}

func writeErrorWithField(response http.ResponseWriter, status int, code, message, field string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message, Field: field})
}
