// Package distribution composes the release checker, persistent appointment
// service and detached native installer. No transport owns its own updater.
package distribution

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
	"github.com/madou1217/ai_home/internal/runtime/distributionupdate"
)

func New(home, root string) (*distributionupdate.Service, error) {
	if root == "" {
		root = FindPackageRoot()
	}
	if root == "" {
		return nil, errors.New("AIH package root unavailable")
	}
	var info struct {
		Version string `json:"version"`
	}
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil || json.Unmarshal(raw, &info) != nil {
		return nil, errors.New("AIH package version unavailable")
	}
	release, err := distributionrelease.New(distributionrelease.Options{CurrentVersion: info.Version, Target: distributioninstall.Target(), CacheFile: filepath.Join(home, "run", "distribution-release-hint.json")})
	if err != nil {
		return nil, err
	}
	return distributionupdate.New(distributionupdate.Options{Home: home, PackageRoot: root, Check: release.Check, Download: release.Download, Apply: func(ctx context.Context, path string) error {
		return distributioninstall.StartDetachedApply(ctx, home, path)
	}, Busy: func(ctx context.Context) (bool, string, error) { return distributioninstall.Busy(ctx, home) }})
}
func FindPackageRoot() string {
	if root := os.Getenv("AIH_PACKAGE_ROOT"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "package.json")); err == nil {
			return root
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 7; i++ {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}
func Run(ctx context.Context, svc *distributionupdate.Service) { _ = svc.Run(ctx) }
func Immediate(svc *distributionupdate.Service, ctx context.Context) (distributionupdate.Status, error) {
	status, err := svc.Schedule(ctx, time.Now(), "UTC")
	if err == nil {
		go func() { _, _ = svc.Tick(context.Background()) }()
	}
	return status, err
}
