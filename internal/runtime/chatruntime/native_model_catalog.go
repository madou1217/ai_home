package chatruntime

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// NativeExecutionResolver is directly assignable from NativeLaunchPreparer.GetTarget.
// Its answer must describe the actual launch configuration, not a UI label or
// provider capability alone. It must not prepare credentials or start a process.
type NativeExecutionResolver func(context.Context, string, string) (NativeExecutionDescriptor, error)

// NativeAccountModelCatalog is an optional SDK/CLI catalog for one exact launch
// target. Model IDs use the canonical account catalog namespace (not CLI labels).
// Known=false is unknown, not a successful empty catalog. DefaultModel is a
// preference, never evidence that a model is executable.
type NativeAccountModelCatalog struct {
	Execution    NativeExecutionDescriptor
	Known        bool
	Models       []string
	DefaultModel string
}

// NativeAccountModelReader reads an authoritative directory for exactly Execution.
// Errors and unknown results never fall back to another account or source.
type NativeAccountModelReader func(context.Context, NativeExecutionDescriptor) (NativeAccountModelCatalog, error)

// NativeDefaultModelReader reads a configured preference for this launch target.
// The result is used only if it is present in the currently executable catalog.
// It is called for composer defaults and turns without an explicit model, never
// to validate an explicit model against the current catalog.
type NativeDefaultModelReader func(context.Context, NativeExecutionDescriptor) (string, error)

// NativeModelCatalogObservation describes the source, not provider permissions.
// StaleKnown states whether refresh health belongs to the selected source read.
// Gateway Health is explicitly an independent current observation, not evidence
// that carriers/aliases/routes are stale or fresh at the same generation.
// No account identity, credential, raw upstream body or error message is exposed.
type NativeModelCatalogObservation struct {
	Source           string                               `json:"source"`
	Stale            bool                                 `json:"stale"`
	StaleKnown       bool                                 `json:"staleKnown"`
	AliasGeneration  *int64                               `json:"aliasGeneration,omitempty"`
	Health           *NativeModelCatalogHealthObservation `json:"health,omitempty"`
	ProbeErrorCode   string                               `json:"probeErrorCode,omitempty"`
	DefaultSelection string                               `json:"defaultSelection,omitempty"`
}

// NativeModelCatalogHealthObservation must not be used as a publication token.
type NativeModelCatalogHealthObservation struct {
	Scope string `json:"scope"`
	Ready bool   `json:"ready"`
	Stale bool   `json:"stale"`
}

type nativeModelCatalogRead struct {
	execution    NativeExecutionDescriptor
	models       []string
	defaultModel string
	observation  NativeModelCatalogObservation
}

// NativeModelCatalogResolver supplies WORK-only composer and turn callbacks.
// It reads no credentials, host environment, chat history or discovery caches.
// The execution owner must revalidate the target when preparing each attempt;
// account retries must resolve against the actual retry account, not the first.
type NativeModelCatalogResolver struct {
	AccountStore AccountPoolReader
	Catalog      *providers.Catalog
	// GatewaySnapshot must bind carriers, protocol aliases and ordered route
	// candidates to one published snapshot for the requested client protocol.
	GatewaySnapshot NativeProtocolCatalogReader
	// GatewayModels is retained for composition compatibility. It is usable
	// only if it also implements NativeProtocolCatalogReader; its separate
	// carrier/alias methods are never combined by this resolver.
	GatewayModels    GatewayModelReader
	Metadata         modelmetadata.Reader
	ResolveExecution NativeExecutionResolver
	ReadNativeModels NativeAccountModelReader
	ReadDefaultModel NativeDefaultModelReader
}

// ReadComposerCatalog never presents a missing source or unsupported execution
// as a successful empty menu. Known-empty and unknown have different error codes.
func (r *NativeModelCatalogResolver) ReadComposerCatalog(ctx context.Context, session *Session) (ComposerCatalog, error) {
	catalog, _, err := r.ReadComposerCatalogWithObservation(ctx, session)
	return catalog, err
}

// ReadComposerCatalogWithObservation lets the host include a low-sensitivity
// source field in the composer response without modifying the shared Chat type
// or making a second read that could observe a different catalog generation.
func (r *NativeModelCatalogResolver) ReadComposerCatalogWithObservation(ctx context.Context, session *Session) (ComposerCatalog, NativeModelCatalogObservation, error) {
	read, err := r.readModels(ctx, session)
	if err != nil {
		return ComposerCatalog{}, read.observation, err
	}
	if err := r.selectDefaultModel(ctx, &read); err != nil {
		return ComposerCatalog{}, read.observation, err
	}
	out := ComposerCatalog{
		SessionID:    session.SessionID,
		DefaultModel: read.defaultModel,
		Models:       make([]ComposerModelEntry, 0, len(read.models)),
	}
	for _, id := range read.models {
		// This is the current WORK run contract, not an assertion that the
		// official CLI/provider lacks effort controls.
		out.Models = append(out.Models, ComposerModelEntry{ID: id, Label: id, SupportedEfforts: []string{}})
	}
	return out, read.observation, nil
}

// ResolveTurnSettings shares the composer source/default rules and re-reads them
// before execution. Effort is rejected only because NativeRunRequest cannot carry
// it; official CLI capability declarations and direct CLI usage are unchanged.
func (r *NativeModelCatalogResolver) ResolveTurnSettings(ctx context.Context, session *Session, requestedModel, requestedEffort string) (TurnModelSettings, error) {
	read, err := r.readModels(ctx, session)
	if err != nil {
		return TurnModelSettings{}, err
	}
	model := strings.TrimSpace(requestedModel)
	if model == "" {
		if err := r.selectDefaultModel(ctx, &read); err != nil {
			return TurnModelSettings{}, err
		}
		model = read.defaultModel
	}
	if !slices.Contains(read.models, model) {
		return TurnModelSettings{}, NewError("native_model_unavailable", http.StatusUnprocessableEntity, map[string]any{"model": model})
	}
	if strings.TrimSpace(requestedEffort) != "" {
		return TurnModelSettings{}, NewError("native_model_effort_unsupported", http.StatusUnprocessableEntity, map[string]any{"reason": "native_run_contract_has_no_reasoning_effort"})
	}
	return TurnModelSettings{Model: model}, nil
}

func (r *NativeModelCatalogResolver) readModels(ctx context.Context, session *Session) (nativeModelCatalogRead, error) {
	var read nativeModelCatalogRead
	target, err := r.resolveTarget(ctx, session)
	if err != nil {
		return read, err
	}
	if target.Mode == NativeExecutionGateway {
		read, err = r.readGatewayModels(ctx, target)
	} else {
		read, err = r.readAccountModels(ctx, target)
	}
	read.execution = target
	if err != nil {
		return read, err
	}
	if err := ctx.Err(); err != nil {
		return read, err
	}
	if len(read.models) == 0 {
		return read, nativeModelObservedError("native_model_catalog_empty", http.StatusUnprocessableEntity, read.observation)
	}
	sort.Strings(read.models)
	read.models = slices.Compact(read.models)
	return read, nil
}

// selectDefaultModel is deliberately outside catalog validation. Configuration
// reader failures must not disable an explicit model that is still executable.
// Reuse the already resolved execution target; never resolve a second identity.
func (r *NativeModelCatalogResolver) selectDefaultModel(ctx context.Context, read *nativeModelCatalogRead) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r.ReadDefaultModel != nil {
		configured, readErr := r.ReadDefaultModel(ctx, read.execution)
		if readErr != nil {
			return nativeModelSourceError("native_model_default_unavailable", readErr)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if configured = strings.TrimSpace(configured); slices.Contains(read.models, configured) {
			read.defaultModel = configured
			read.observation.DefaultSelection = "configured"
			return nil
		}
	}
	if candidate := strings.TrimSpace(read.defaultModel); slices.Contains(read.models, candidate) {
		read.defaultModel = candidate
		read.observation.DefaultSelection = "native_catalog"
		return nil
	}
	// Explicit fallback policy: lexical first of this verified, nonempty catalog.
	// This is a WORK selection default, not a claimed upstream/CLI default.
	read.defaultModel = read.models[0]
	read.observation.DefaultSelection = "catalog_first"
	return nil
}

func nativeModelObservedError(code string, status int, observation NativeModelCatalogObservation) error {
	details := map[string]any{
		"source":         observation.Source,
		"stale":          observation.Stale,
		"staleKnown":     observation.StaleKnown,
		"probeErrorCode": observation.ProbeErrorCode,
	}
	if observation.AliasGeneration != nil {
		details["aliasGeneration"] = *observation.AliasGeneration
	}
	if observation.Health != nil {
		details["health"] = map[string]any{
			"scope": observation.Health.Scope,
			"ready": observation.Health.Ready,
			"stale": observation.Health.Stale,
		}
	}
	return NewError(code, status, details)
}

func (r *NativeModelCatalogResolver) resolveTarget(ctx context.Context, session *Session) (NativeExecutionDescriptor, error) {
	var empty NativeExecutionDescriptor
	if ctx == nil {
		return empty, NewError("native_model_context_required", http.StatusInternalServerError, nil)
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	if session == nil || strings.TrimSpace(session.ProjectPath) == "" {
		return empty, NewError("native_model_work_session_required", http.StatusUnprocessableEntity, nil)
	}
	if r == nil || r.ResolveExecution == nil || r.Catalog == nil {
		return empty, NewError("native_model_execution_unavailable", http.StatusServiceUnavailable, nil)
	}
	provider, found := r.Catalog.CanonicalID(session.Provider)
	if !found || provider == "codex" {
		return empty, NewError("native_model_execution_unsupported", http.StatusUnprocessableEntity, nil)
	}
	ref := strings.TrimSpace(session.ExecutionAccountRef)
	target, err := r.ResolveExecution(ctx, provider, ref)
	if err != nil {
		return empty, err
	}
	if target.Provider != provider || target.ClientProtocol == "" || target.ClientProtocol != strings.TrimSpace(target.ClientProtocol) {
		return empty, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
	}
	switch target.Mode {
	case NativeExecutionAccountNative:
		if _, err := accountcore.ParseAccountRef(ref); err != nil || target.AccountRef != ref {
			return empty, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
		}
		if provider == "agy" && target.ClientProtocol != NativeClientProtocolAGYStreamJSON {
			return empty, NewError("native_model_execution_unsupported", http.StatusUnprocessableEntity, nil)
		}
	case NativeExecutionGateway:
		// The harness provider is not a carrier/permission filter. A gateway scope
		// suffix is also not an account restriction. The launch must be unpinned.
		if !IsGatewayRuntimeScope(ref) || target.AccountRef != "" {
			return empty, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
		}
		if !r.Catalog.Supports(provider, providers.CapabilityGatewayProfile) || !inference.ClientProtocolID(target.ClientProtocol).IsValid() {
			return empty, NewError("native_gateway_execution_unsupported", http.StatusUnprocessableEntity, nil)
		}
	default:
		return empty, NewError("native_model_execution_unsupported", http.StatusUnprocessableEntity, nil)
	}
	return target, nil
}

func (r *NativeModelCatalogResolver) supportsNativeText(provider, model string) bool {
	if r.Metadata == nil {
		return true
	}
	modalities, known := r.Metadata.LookupModalities(provider, model)
	return !known || slices.Contains(modalities.Output(), "text")
}

// Keep the source error chain without exposing a database/SDK response body in
// a public diagnostic. Execution resolver errors already belong to the host.
func nativeModelSourceError(code string, cause error) error {
	if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) {
		return cause
	}
	err := NewError(code, http.StatusServiceUnavailable, nil)
	err.Cause = cause
	return err
}
