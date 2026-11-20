package aihserver

import (
	"context"
	"fmt"
	"os"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/host/codexdefault"
	"github.com/madou1217/ai_home/internal/runtime/codexhostauth"
)

type codexDefaultProjection struct{ aiHome, hostHome string }

func (codexDefaultProjection) Supports(provider string) bool { return provider == "codex" }

func (projection codexDefaultProjection) Select(ctx context.Context, provider string, ref accountcore.AccountRef, gateway bool) (accountcore.ProviderDefault, error) {
	var zero accountcore.ProviderDefault
	if provider != "codex" {
		return zero, fmt.Errorf("codex_default_provider_mismatch")
	}
	authCommand, err := hostDefaultAuthCommand()
	if err != nil {
		return zero, err
	}
	selector := ref.String()
	if gateway {
		selector = ".aih-server"
	}
	out, err := codexdefault.Apply(ctx, codexdefault.Options{AIHomeDir: projection.aiHome, HostHomeDir: projection.hostHome, AuthCommand: authCommand, Selector: selector, LookupEnv: os.LookupEnv})
	if err != nil {
		return zero, err
	}
	if gateway {
		return zero, nil
	}
	return accountcore.NewProviderDefault("codex", accountcore.AccountRef(out.AccountRef), time.UnixMilli(out.UpdatedAtMS).UTC())
}

func hostDefaultAuthCommand() (string, error) {
	binary, err := os.Executable()
	if err != nil {
		return "", err
	}
	return codexhostauth.SiblingCLI(binary)
}

func (projection codexDefaultProjection) RevokeIfSelected(ctx context.Context, ref accountcore.AccountRef) (bool, error) {
	return projection.landConditionally(ctx, ref.String(), false)
}
func (projection codexDefaultProjection) LandIfUnselected(ctx context.Context) (bool, error) {
	return projection.landConditionally(ctx, "", true)
}
func (projection codexDefaultProjection) landConditionally(ctx context.Context, expectedRef string, unselected bool) (bool, error) {
	authCommand, err := hostDefaultAuthCommand()
	if err != nil {
		return false, err
	}
	out, err := codexdefault.Apply(ctx, codexdefault.Options{AIHomeDir: projection.aiHome, HostHomeDir: projection.hostHome, AuthCommand: authCommand, Selector: ".aih-server", ExpectedAccountRef: expectedRef, OnlyIfUnselected: unselected, LookupEnv: os.LookupEnv})
	return out.Applied, err
}
