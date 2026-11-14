package desktoptranslation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/translation"
)

type modelCache struct {
	scope      string
	generation uint64
	updated    time.Time
	pending    bool
	cancel     context.CancelFunc
	value      translation.ModelCatalog
}

func (c *modelCache) resetLocked() {
	c.generation++
	if c.cancel != nil {
		c.cancel()
	}
	c.cancel = nil
	c.pending = false
	c.updated = time.Time{}
	c.value = translation.ModelCatalog{}
}
func (s *Service) Configure() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	settings := s.settings
	configCtx := s.configCtx
	localOrigin := s.options.Origin
	target := s.target
	targets := append([]translation.SystemServerTarget(nil), s.targets...)
	models := s.catalog.value
	scope := settings.ExecutionTarget + ":" + target.Origin + ":" + target.ServerID
	if s.catalog.scope != scope {
		s.catalog.resetLocked()
		s.catalog.scope = scope
		models = s.catalog.value
	}
	refresh := settings.ExecutionTarget == "aih-server" && !s.catalog.pending && (s.catalog.updated.IsZero() || time.Since(s.catalog.updated) > time.Minute)
	if settings.ExecutionTarget == "direct-provider" {
		models = translation.ModelCatalog{}
		for _, route := range selectionRoutes(settings.Routes) {
			if route.Enabled && route.Model != "" {
				provider := route.ModelProvider
				if provider == "" {
					provider = route.Provider
				}
				if len(models.Models) < 256 {
					models.Models = append(models.Models, translation.ModelEntry{ID: route.Model, Provider: provider})
				}
			}
		}
	}
	for _, route := range selectionRoutes(settings.Routes) {
		if route.Enabled {
			models.DefaultModel = route.Model
			models.DefaultProvider = route.ModelProvider
			if models.DefaultProvider == "" && settings.ExecutionTarget == "direct-provider" {
				models.DefaultProvider = route.Provider
			}
			break
		}
	}
	if models.DefaultModel == "" {
		models.DefaultModel = settings.Model
	}
	if models.DefaultProvider == "" {
		models.DefaultProvider = settings.Provider
	}
	var token uint64
	var refreshCtx context.Context
	if refresh {
		var cancel context.CancelFunc
		refreshCtx, cancel = context.WithTimeout(s.ctx, 4*time.Second)
		s.catalog.pending = true
		s.catalog.cancel = cancel
		token = s.catalog.generation
	}
	s.mu.Unlock()
	paste := 200
	if s.options.LargePasteChars != nil {
		paste = s.options.LargePasteChars()
	}
	modelViews := make([]map[string]any, 0, min(len(models.Models), 256))
	for i, m := range models.Models {
		if i >= 256 {
			break
		}
		modelViews = append(modelViews, map[string]any{"id": m.ID, "provider": m.Provider, "label": m.ID})
	}
	config := map[string]any{"type": "configure", "quickChatKey": "", "model": settings.Model, "provider": settings.Provider, "target": settings.Target, "autoCopy": settings.AutoCopy, "copyScope": settings.CopyScope, "executionTarget": settings.ExecutionTarget, "shortcut": settings.Shortcut, "shortcutEnabled": settings.ShortcutEnabled, "chatShortcut": settings.ChatShortcut, "chatShortcutEnabled": settings.ChatShortcutEnabled, "serverTarget": target, "serverTargets": targets, "chatTarget": target, "chatModel": settings.Model, "languages": translation.ListLanguages(), "platform": s.options.Platform, "captureModes": platformStatus(s.options.Platform)["captureModes"], "permission": platformStatus(s.options.Platform)["permission"], "nativeShortcut": platformStatus(s.options.Platform)["shortcut"], "largePasteChars": paste, "readingTheme": settings.ReadingTheme, "models": modelViews, "defaultModel": models.DefaultModel, "defaultProvider": models.DefaultProvider, "quickChatOrigin": target.Origin}
	local, _ := normalizeOrigin(localOrigin)
	actual, _ := normalizeOrigin(target.Origin)
	if local != "" && local == actual && target.ServerID == "" && s.options.ManagementKey != nil {
		config["quickChatKey"] = s.options.ManagementKey()
	}
	_ = s.launcher.SendContext(configCtx, config)
	if refresh {
		go s.refreshCatalog(refreshCtx, token, target)
	}
}
func (s *Service) refreshCatalog(ctx context.Context, token uint64, target translation.SystemServerTarget) {
	var catalog translation.ModelCatalog
	var err error
	local, _ := normalizeOrigin(s.LocalOrigin())
	actual, _ := normalizeOrigin(target.Origin)
	if s.options.Catalog != nil && target.ServerID == "" && local == actual {
		catalog, err = s.options.Catalog(ctx)
	} else {
		catalog, err = s.readRemoteCatalog(ctx, target)
	}
	s.mu.Lock()
	if s.catalog.generation != token || s.closed {
		s.mu.Unlock()
		return
	}
	s.catalog.pending = false
	if s.catalog.cancel != nil {
		s.catalog.cancel()
		s.catalog.cancel = nil
	}
	s.catalog.updated = time.Now()
	if err == nil {
		s.catalog.value = catalog
	}
	s.mu.Unlock()
	if err == nil {
		s.Configure()
	}
}
func (s *Service) readRemoteCatalog(ctx context.Context, target translation.SystemServerTarget) (translation.ModelCatalog, error) {
	if s.executor.ResolveTarget == nil {
		return translation.ModelCatalog{}, ErrTarget
	}
	resolved, err := s.executor.ResolveTarget(ctx, target)
	if err != nil {
		return translation.ModelCatalog{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resolved.Origin+"/v0/webui/translation/models", nil)
	if err != nil {
		return translation.ModelCatalog{}, err
	}
	if resolved.ManagementKey != "" {
		req.Header.Set("Authorization", "Bearer "+resolved.ManagementKey)
	}
	client := s.executor.HTTPClient
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return translation.ModelCatalog{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return translation.ModelCatalog{}, ErrTarget
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return translation.ModelCatalog{}, ErrTarget
	}
	var catalog translation.ModelCatalog
	if json.Unmarshal(raw, &catalog) != nil {
		return translation.ModelCatalog{}, ErrTarget
	}
	if len(catalog.Models) > 256 {
		catalog.Models = catalog.Models[:256]
	}
	return catalog, nil
}
func (s *Service) GetStatus(ctx context.Context) map[string]any {
	s.mu.Lock()
	status := toMap(s.snapshot)
	status["executionTarget"] = s.settings.ExecutionTarget
	status["serverTarget"] = s.target
	status["serverTargets"] = append([]translation.SystemServerTarget(nil), s.targets...)
	targetConfigured := s.target.Origin != ""
	s.mu.Unlock()
	providers, err := translation.ListProviderStatuses(ctx, s.options.DatabasePath)
	if err != nil {
		providers = nil
	}
	configured := false
	streaming := false
	for _, provider := range providers {
		configured = configured || provider.Configured
		streaming = streaming || provider.Capabilities.Streaming
	}
	status["executionTargets"] = []any{
		map[string]any{"id": "aih-server", "label": "AIH Server", "available": true, "configured": targetConfigured, "capabilities": map[string]any{"streaming": true, "operations": []string{"selection", "batch", "page", "replace"}}},
		map[string]any{"id": "direct-provider", "label": "Provider 直连", "available": true, "configured": configured, "capabilities": map[string]any{"streaming": streaming, "operations": []string{"selection", "batch", "page", "replace"}}, "providers": providers},
	}
	return status
}
