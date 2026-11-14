// Package desktopbuild builds the real native desktop translation helper.
// It owns build artifacts only; process lifecycle, translation and Chat stay with the caller.
package desktopbuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var (
	ErrInvalidOptions             = errors.New("desktop_build_invalid_options")
	ErrUnsupportedPlatform        = errors.New("desktop_platform_unsupported")
	ErrRegistrationInProtocolMode = errors.New("desktop_protocol_only_registration_forbidden")
)

// Options selects the target artifact, not whether the user's desktop service is enabled.
// Register is an explicit opt-in to macOS LaunchServices/PBS registration; false has no such side effect.
type Options struct {
	AIHomeDir    string
	RepoRoot     string
	Mode         string
	Platform     string
	Arch         string
	ProtocolOnly bool
	Register     bool
}

// LaunchSpec is independent of any process supervisor package. Env is the complete
// allowlisted child environment, not a patch to append to os.Environ().
type LaunchSpec struct {
	File string   `json:"file"`
	Args []string `json:"args"`
	Env  []string `json:"env"`
}

// Build produces a verified cached artifact and launch description. It never starts the helper.
func Build(ctx context.Context, options Options) (LaunchSpec, error) {
	if ctx == nil {
		return LaunchSpec{}, ErrInvalidOptions
	}
	if err := ctx.Err(); err != nil {
		return LaunchSpec{}, err
	}
	opts, err := normalizeOptions(options)
	if err != nil {
		return LaunchSpec{}, err
	}
	if opts.Register && opts.ProtocolOnly {
		return LaunchSpec{}, ErrRegistrationInProtocolMode
	}
	if opts.Platform == "linux" {
		return LaunchSpec{}, ErrUnsupportedPlatform
	}
	if opts.Platform == "darwin" && runtime.GOOS != "darwin" {
		return LaunchSpec{}, ErrUnsupportedPlatform
	}
	if opts.Register && opts.Platform != "darwin" {
		return LaunchSpec{}, fmt.Errorf("desktop_registration_unsupported: %s", opts.Platform)
	}

	// Validate mode/platform/registration before creating any cache directories.
	if err := os.MkdirAll(opts.AIHomeDir, 0o700); err != nil {
		return LaunchSpec{}, err
	}
	if opts.AIHomeDir, err = filepath.EvalSymlinks(opts.AIHomeDir); err != nil {
		return LaunchSpec{}, err
	}
	root := filepath.Join(opts.AIHomeDir, "run", "desktop-translation")
	if opts.ProtocolOnly {
		root = filepath.Join(root, "protocol-only")
	}
	if err := mkdirWithin(opts.AIHomeDir, root); err != nil {
		return LaunchSpec{}, err
	}
	release, err := acquireBuildLock(ctx, root)
	if err != nil {
		return LaunchSpec{}, err
	}
	defer release()

	var spec LaunchSpec
	switch opts.Platform {
	case "darwin":
		spec, err = buildMac(ctx, opts, root)
	case "win32":
		spec, err = buildWindows(ctx, opts, root)
	default:
		return LaunchSpec{}, ErrUnsupportedPlatform
	}
	if err != nil {
		return LaunchSpec{}, err
	}
	if opts.Mode == "full-app" {
		spec.Args = append(spec.Args, "--full-app")
	}
	if opts.ProtocolOnly {
		spec.Args = append(spec.Args, "--protocol-only")
	}
	spec.Env = launchEnvironment(opts.Platform)
	if opts.Register {
		if err := registerMac(ctx, filepath.Join(root, "AIH Translation.app")); err != nil {
			return LaunchSpec{}, err
		}
	}
	return spec, nil
}

func normalizeOptions(opts Options) (Options, error) {
	opts.Mode = strings.TrimSpace(opts.Mode)
	if opts.Mode == "" {
		opts.Mode = "helper"
	}
	if opts.Mode != "helper" && opts.Mode != "full-app" {
		return opts, ErrInvalidOptions
	}
	opts.Platform = strings.ToLower(strings.TrimSpace(opts.Platform))
	if opts.Platform == "" {
		opts.Platform = runtime.GOOS
	}
	if opts.Platform == "windows" {
		opts.Platform = "win32"
	}
	if opts.Platform != "darwin" && opts.Platform != "win32" && opts.Platform != "linux" {
		return opts, ErrUnsupportedPlatform
	}
	opts.Arch = strings.ToLower(strings.TrimSpace(opts.Arch))
	if opts.Arch == "" {
		opts.Arch = runtime.GOARCH
	}
	switch opts.Arch {
	case "amd64", "x86_64", "x64":
		opts.Arch = "x64"
	case "arm64", "aarch64":
		opts.Arch = "arm64"
	default:
		return opts, ErrUnsupportedPlatform
	}
	for _, path := range []*string{&opts.AIHomeDir, &opts.RepoRoot} {
		if *path == "" || *path != strings.TrimSpace(*path) || !filepath.IsAbs(*path) || strings.ContainsRune(*path, 0) {
			return opts, ErrInvalidOptions
		}
		*path = filepath.Clean(*path)
	}
	info, err := os.Stat(opts.RepoRoot)
	if err != nil || !info.IsDir() {
		return opts, fmt.Errorf("desktop_repository_unavailable")
	}
	if opts.RepoRoot, err = filepath.EvalSymlinks(opts.RepoRoot); err != nil {
		return opts, err
	}
	return opts, nil
}
