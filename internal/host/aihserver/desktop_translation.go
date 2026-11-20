package aihserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/desktopbuild"
	"github.com/madou1217/ai_home/internal/runtime/desktopchat"
	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	"github.com/madou1217/ai_home/internal/runtime/translation"
	"github.com/madou1217/ai_home/internal/transport/http/webuidesktoptranslationapi"
)

func newDesktopTranslation(ctx context.Context, deps webuiRouteDependencies, chat *chatruntime.Service) (*desktoptranslation.Service, []webuiRoute, error) {
	database, err := appstate.DatabasePath(deps.AIHomeDir)
	if err != nil {
		return nil, nil, err
	}
	client := &http.Client{CheckRedirect: rejectOAuthRedirect}
	executor := &desktoptranslation.Executor{DatabasePath: database, Gateway: translation.GatewayConfig{BaseURL: func() string { return "http://aih-internal.invalid" }, ClientKey: deps.ClientKey, HTTPClient: &http.Client{Transport: NewTranslationInProcessTransport(deps.TranslationGateway)}}, HTTPClient: client}
	service, err := desktoptranslation.New(ctx, desktoptranslation.Options{
		AIHomeDir: deps.AIHomeDir, DatabasePath: database, Origin: deps.SelfBaseURL, Mode: "helper", ManagementKey: deps.ManagementKey, Executor: executor,
		LargePasteChars: func() int {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			raw, found, err := appstate.ReadKV(ctx, database, appstate.KeyServerConfig)
			if err != nil || !found {
				return 200
			}
			var config struct {
				LargePasteChars int `json:"largePasteChars"`
			}
			if json.Unmarshal([]byte(raw), &config) != nil || config.LargePasteChars < 50 || config.LargePasteChars > 100000 {
				return 200
			}
			return config.LargePasteChars
		},
		Build: func(ctx context.Context) (desktoplauncher.LaunchSpec, error) {
			repo, err := desktopRepositoryRoot()
			if err != nil {
				return desktoplauncher.LaunchSpec{}, err
			}
			built, err := desktopbuild.Build(ctx, desktopbuild.Options{AIHomeDir: deps.AIHomeDir, RepoRoot: repo, Mode: "helper", Register: runtime.GOOS == "darwin"})
			return desktoplauncher.LaunchSpec{File: built.File, Args: built.Args, Env: built.Env}, err
		},
		Catalog: func(ctx context.Context) (translation.ModelCatalog, error) {
			saved, err := translation.ReadSettings(ctx, database)
			if err != nil {
				return translation.ModelCatalog{}, err
			}
			return translation.BuildTranslationModelCatalog(ctx, buildTranslationCatalogDependencies(deps, deps.AIHomeDir), saved)
		},
	})
	if err != nil {
		return nil, nil, err
	}
	if chat != nil {
		bridge, err := desktopchat.New(desktopchat.Options{Client: chat, TempDir: os.TempDir(), Emit: func(event map[string]any) { _ = service.Send(event) }, ResolveTarget: func(ctx context.Context, request map[string]any) (desktopchat.Target, error) {
			// Node's embedded native Chat bridge is pinned to the local host runtime;
			// helper target metadata never selects its HTTP origin. Preserve that ownership:
			// remote Quick Chat windows use their own WebUI profiles, not this bridge.
			settings := service.SettingsSnapshot()
			provider, model := settings.Provider, settings.Model
			if model == "" {
				for _, route := range settings.Routes {
					if route.Enabled {
						model = route.Model
						provider = route.ModelProvider
						break
					}
				}
			}
			if provider == "" || model == "" {
				return desktopchat.Target{}, errors.New("chat_target_unconfigured")
			}
			return desktopchat.Target{Provider: provider, Model: model, ExecutionAccountRef: "gateway"}, nil
		}})
		if err != nil {
			service.Close()
			return nil, nil, err
		}
		service.SetChat(bridge)
	}
	handler := &webuidesktoptranslationapi.Handler{Service: service, Authorize: deps.Authorizer.Authorized}
	return service, []webuiRoute{{Pattern: "GET " + webuidesktoptranslationapi.Path + "/system", Handler: handler}, {Pattern: "POST " + webuidesktoptranslationapi.Path + "/system", Handler: handler}, {Pattern: "POST " + webuidesktoptranslationapi.Path + "/focus", Handler: handler}}, nil
}
func desktopText(value any) string { s, _ := value.(string); return s }
func desktopRepositoryRoot() (string, error) {
	starts := []string{}
	if path, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(path))
	}
	if path, err := os.Getwd(); err == nil {
		starts = append(starts, path)
	}
	for _, start := range starts {
		dir := start
		for depth := 0; depth < 8; depth++ {
			if info, err := os.Stat(filepath.Join(dir, "native", "translation", "main.swift")); err == nil && info.Mode().IsRegular() {
				return dir, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", errors.New("desktop_native_sources_unavailable")
}

func startDesktopOnListener(ctx context.Context, service *desktoptranslation.Service, origin string) {
	if service == nil {
		return
	}
	go func() {
		start, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		_ = service.StartAt(start, origin)
	}()
}

type desktopSettingsNotifier struct {
	mu      sync.Mutex
	service *desktoptranslation.Service
}

func (n *desktopSettingsNotifier) attach(service *desktoptranslation.Service) {
	n.mu.Lock()
	n.service = service
	n.mu.Unlock()
}
func (n *desktopSettingsNotifier) changed() {
	n.mu.Lock()
	s := n.service
	n.mu.Unlock()
	if s != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.Reload(ctx)
	}
}
