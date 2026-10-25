// Package modelcatalogapi receives the complete public model catalog projection
// from the Node host. The projection is intentionally separate from Go's
// routable model index, which remains the source for inference selection.
package modelcatalogapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/core/inference"
)

const (
	Path               = "/v1/management/model-catalog"
	maxProjectionBytes = 1 << 20
)

var ErrInvalidDependencies = errors.New("模型目录投影 Handler 依赖无效")

type Authorizer interface {
	Authorized(request *http.Request) bool
}

type Dependencies struct {
	Authorizer Authorizer
	Store      *modelcatalog.Store
	Routable   accountapp.RoutableModelReader
}

type Handler struct {
	authorizer Authorizer
	store      *modelcatalog.Store
	routable   accountapp.RoutableModelReader
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil || dependencies.Routable == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		routable:   dependencies.Routable,
	}, nil
}

type projectionRequest struct {
	Revision string            `json:"revision"`
	Models   []projectionModel `json:"models"`
}

type projectionModel struct {
	ID               string                      `json:"id"`
	OwnedBy          string                      `json:"owned_by"`
	InputModalities  []string                    `json:"input_modalities"`
	OutputModalities []string                    `json:"output_modalities"`
	ReasoningEfforts []inference.ReasoningEffort `json:"reasoning_efforts"`
}

type modelView struct {
	ID               string                      `json:"id"`
	OwnedBy          string                      `json:"owned_by"`
	InputModalities  []string                    `json:"input_modalities"`
	OutputModalities []string                    `json:"output_modalities"`
	ReasoningEfforts []inference.ReasoningEffort `json:"reasoning_efforts"`
}

type projectionView struct {
	Generation       int64       `json:"generation"`
	Revision         string      `json:"revision"`
	AcceptedCount    int         `json:"accepted_count"`
	RoutableModelIDs []string    `json:"routable_model_ids"`
	Models           []modelView `json:"models,omitempty"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil || handler.routable == nil {
		writeError(response, http.StatusServiceUnavailable, "model_catalog_unavailable", "模型目录投影不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	routableIDs, err := handler.routableIDs(request)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "routable_models_unavailable", "可路由模型暂不可用")
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.writeView(response, http.StatusOK, routableIDs, true)
	case http.MethodPut:
		handler.put(response, request, routableIDs)
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 与 PUT")
	}
}

func (handler *Handler) put(response http.ResponseWriter, request *http.Request, routableIDs []string) {
	var payload projectionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxProjectionBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_projection", "模型目录投影格式无效")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(response, http.StatusBadRequest, "invalid_projection", "模型目录投影格式无效")
		return
	}
	items := make([]modelcatalog.Item, 0, len(payload.Models))
	for _, item := range payload.Models {
		items = append(items, modelcatalog.Item{
			ID:               item.ID,
			OwnedBy:          item.OwnedBy,
			InputModalities:  item.InputModalities,
			OutputModalities: item.OutputModalities,
			ReasoningEfforts: item.ReasoningEfforts,
		})
	}
	if _, err := handler.store.Replace(payload.Revision, items); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_projection", "模型目录投影格式无效")
		return
	}
	handler.writeView(response, http.StatusOK, routableIDs, false)
}

func (handler *Handler) routableIDs(request *http.Request) ([]string, error) {
	models, err := handler.routable.ListRoutableModels(request.Context())
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		if !model.IsValid() {
			return nil, errors.New("invalid routable model")
		}
		id := strings.TrimSpace(model.ModelID().String())
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func (handler *Handler) writeView(response http.ResponseWriter, status int, routableIDs []string, includeModels bool) {
	snapshot := handler.store.Snapshot()
	view := projectionView{
		Generation:       snapshot.Generation,
		Revision:         snapshot.Revision,
		AcceptedCount:    len(snapshot.Items),
		RoutableModelIDs: append([]string(nil), routableIDs...),
	}
	if includeModels {
		view.Models = make([]modelView, 0, len(snapshot.Items))
		for _, item := range snapshot.Items {
			view.Models = append(view.Models, modelView{
				ID:               item.ID,
				OwnedBy:          item.OwnedBy,
				InputModalities:  append([]string(nil), item.InputModalities...),
				OutputModalities: append([]string(nil), item.OutputModalities...),
				ReasoningEfforts: append([]inference.ReasoningEffort(nil), item.ReasoningEfforts...),
			})
		}
	}
	writeJSON(response, status, map[string]any{"data": view})
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    map[bool]string{true: "server_error", false: "invalid_request_error"}[status >= 500],
			"code":    code,
		},
	})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
