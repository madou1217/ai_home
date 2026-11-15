package aihserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/host/codexdefault"
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
	name := "aih-go"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(filepath.Dir(binary), name)
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode()&0o111 == 0) {
		return "", fmt.Errorf("codex_host_auth_cli_unavailable")
	}
	return target, nil
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
