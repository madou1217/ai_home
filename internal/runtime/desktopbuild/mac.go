package desktopbuild

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

//go:embed Info.plist.tmpl
var macInfoPlist string

var macSources = []string{
	"native/translation/SelectedText.swift",
	"native/translation/TranslationPanelContent.swift",
	"native/translation/TranslationPanel.swift",
	"native/translation/TranslationSettingsWindow.swift",
	"native/chat/ChatPanelContent.swift",
	"native/chat/ChatPanel.swift",
	"native/chat/QuickChatWindow.swift",
	"native/desktop/ShortcutRegistry.swift",
	"native/translation/main.swift",
}

func buildMac(ctx context.Context, opts Options, root string) (LaunchSpec, error) {
	version, build := macVersion(ctx, opts.RepoRoot)
	agent := "<true/>"
	if opts.Mode == "full-app" {
		agent = "<false/>"
	}
	plist := []byte(strings.NewReplacer("{{VERSION}}", xmlText(version), "{{BUILD}}", xmlText(build), "{{AGENT}}", agent).Replace(macInfoPlist))
	logo, err := os.ReadFile(filepath.Join(opts.RepoRoot, "assets", "brand", "ai-home-app-icon.png"))
	if err != nil {
		return LaunchSpec{}, fmt.Errorf("desktop_icon_missing: %w", err)
	}
	parts := [][]byte{[]byte("go-desktop-build-v1"), []byte(opts.Arch), []byte(opts.Mode), plist, logo}
	for _, source := range macSources {
		content, err := os.ReadFile(filepath.Join(opts.RepoRoot, filepath.FromSlash(source)))
		if err != nil {
			return LaunchSpec{}, fmt.Errorf("desktop_source_missing: %s: %w", source, err)
		}
		parts = append(parts, content)
	}
	fingerprint := hashBytes(parts...)
	app := filepath.Join(root, "AIH Translation.app")
	binaryRel := filepath.Join("Contents", "MacOS", "aih-translation")
	plistRel := filepath.Join("Contents", "Info.plist")
	logoRel := filepath.Join("Contents", "Resources", "ai-home-app-icon.png")
	iconRel := filepath.Join("Contents", "Resources", "AppIcon.icns")
	files := []string{binaryRel, plistRel, logoRel, iconRel, filepath.Join("Contents", "_CodeSignature", "CodeResources")}
	stampPath := filepath.Join(root, ".mac-go-build.json")
	if !cachedArtifactAt(app, stampPath, fingerprint, files...) {
		stageRoot, err := os.MkdirTemp(root, ".mac-build-")
		if err != nil {
			return LaunchSpec{}, err
		}
		defer os.RemoveAll(stageRoot)
		stage := filepath.Join(stageRoot, "AIH Translation.app")
		if err := os.MkdirAll(filepath.Join(stage, "Contents", "MacOS"), 0o700); err != nil {
			return LaunchSpec{}, err
		}
		if err := os.MkdirAll(filepath.Join(stage, "Contents", "Resources"), 0o700); err != nil {
			return LaunchSpec{}, err
		}
		args := []string{"swiftc", "-O", "-o", filepath.Join(stage, binaryRel)}
		for index, source := range macSources {
			copyPath := filepath.Join(stageRoot, "source", filepath.FromSlash(source))
			if err := os.MkdirAll(filepath.Dir(copyPath), 0o700); err != nil {
				return LaunchSpec{}, err
			}
			if err := os.WriteFile(copyPath, parts[5+index], 0o600); err != nil {
				return LaunchSpec{}, err
			}
			args = append(args, copyPath)
		}
		arch := opts.Arch
		if arch == "x64" {
			arch = "x86_64"
		}
		args = append(args, "-target", arch+"-apple-macosx12.0", "-module-cache-path", filepath.Join(stageRoot, "swift-cache"), "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "WebKit")
		if _, err := runTool(ctx, 2*time.Minute, opts.RepoRoot, nil, "/usr/bin/xcrun", args...); err != nil {
			return LaunchSpec{}, err
		}
		if err := os.WriteFile(filepath.Join(stage, plistRel), plist, 0o600); err != nil {
			return LaunchSpec{}, err
		}
		if err := os.WriteFile(filepath.Join(stage, logoRel), logo, 0o600); err != nil {
			return LaunchSpec{}, err
		}
		if err := buildMacIcon(ctx, stageRoot, filepath.Join(stage, logoRel), filepath.Join(stage, iconRel)); err != nil {
			return LaunchSpec{}, err
		}
		if _, err := runTool(ctx, 15*time.Second, opts.RepoRoot, nil, "/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "com.meadeo.translation", "-r", `=designated => identifier "com.meadeo.translation"`, stage); err != nil {
			return LaunchSpec{}, err
		}
		if _, err := runTool(ctx, 15*time.Second, opts.RepoRoot, nil, "/usr/bin/codesign", "--verify", "--strict", stage); err != nil {
			return LaunchSpec{}, err
		}
		stageStamp := filepath.Join(stageRoot, ".mac-go-build.json")
		if err := writeArtifactStampAt(stage, stageStamp, fingerprint, files...); err != nil {
			return LaunchSpec{}, err
		}
		if err := publishDirectory(stage, app); err != nil {
			return LaunchSpec{}, err
		}
		if err := os.Rename(stageStamp, stampPath); err != nil {
			return LaunchSpec{}, err
		}
	}
	executable := filepath.Join(app, binaryRel)
	if opts.Mode == "helper" {
		wrapper, err := buildMacDisclaim(ctx, opts, root)
		// Never silently change TCC responsibility by dropping the wrapper on a failed build.
		if err != nil {
			return LaunchSpec{}, err
		}
		return LaunchSpec{File: wrapper, Args: []string{executable}}, nil
	}
	return LaunchSpec{File: executable, Args: []string{}}, nil
}

func macVersion(ctx context.Context, repo string) (string, string) {
	version := "1.0.0"
	if raw, err := os.ReadFile(filepath.Join(repo, "package.json")); err == nil {
		var manifest struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(raw, &manifest) == nil && manifest.Version != "" {
			version = manifest.Version
		}
	}
	build := version
	raw, err := runTool(ctx, 5*time.Second, repo, nil, "git", "-C", repo, "log", "-1", "--format=%cd", "--date=format:%Y%m%d.%H%M", "--", "native/translation", "native/chat", "native/desktop", "lib/desktop/translation")
	stamp := strings.TrimSpace(string(raw))
	if err == nil && regexp.MustCompile(`^\d{8}\.\d{4}$`).MatchString(stamp) {
		build = stamp
	}
	return version, build
}

func xmlText(value string) string {
	var escaped bytes.Buffer
	_ = xml.EscapeText(&escaped, []byte(value))
	return escaped.String()
}

func buildMacIcon(ctx context.Context, work, logo, target string) error {
	iconset := filepath.Join(work, "AppIcon.iconset")
	if err := os.Mkdir(iconset, 0o700); err != nil {
		return err
	}
	for _, size := range []int{16, 32, 128, 256, 512} {
		for _, scale := range []int{1, 2} {
			name := fmt.Sprintf("icon_%dx%d.png", size, size)
			if scale == 2 {
				name = fmt.Sprintf("icon_%dx%d@2x.png", size, size)
			}
			pixels := fmt.Sprint(size * scale)
			if _, err := runTool(ctx, 15*time.Second, work, nil, "/usr/bin/sips", "-z", pixels, pixels, logo, "--out", filepath.Join(iconset, name)); err != nil {
				return err
			}
		}
	}
	_, err := runTool(ctx, 15*time.Second, work, nil, "/usr/bin/iconutil", "-c", "icns", iconset, "-o", target)
	return err
}

func buildMacDisclaim(ctx context.Context, opts Options, root string) (string, error) {
	source := filepath.Join(opts.RepoRoot, "native", "translation", "disclaim-launcher.c")
	raw, err := os.ReadFile(source)
	if err != nil {
		return "", err
	}
	fingerprint := hashBytes([]byte("go-disclaim-v1"), []byte(opts.Arch), raw)
	dir := filepath.Join(root, "launcher")
	if cachedArtifact(dir, fingerprint, "aih-disclaim") {
		return filepath.Join(dir, "aih-disclaim"), nil
	}
	stage, err := os.MkdirTemp(root, ".launcher-build-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	arch := opts.Arch
	if arch == "x64" {
		arch = "x86_64"
	}
	copySource := filepath.Join(stage, "disclaim-launcher.c")
	if err := os.WriteFile(copySource, raw, 0o600); err != nil {
		return "", err
	}
	if _, err := runTool(ctx, time.Minute, opts.RepoRoot, nil, "/usr/bin/xcrun", "clang", "-O2", "-arch", arch, "-o", filepath.Join(stage, "aih-disclaim"), copySource); err != nil {
		return "", err
	}
	if err := writeArtifactStamp(stage, fingerprint, "aih-disclaim"); err != nil {
		return "", err
	}
	if err := publishDirectory(stage, dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, "aih-disclaim"), nil
}

func registerMac(ctx context.Context, app string) error {
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	_, _ = runTool(ctx, 10*time.Second, "", nil, lsregister, "-u", filepath.Join(home, "Applications", "AIH Translation.app"))
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := runTool(ctx, 10*time.Second, "", nil, lsregister, "-f", app); err != nil {
		return err
	}
	_, err = runTool(ctx, 10*time.Second, "", nil, "/System/Library/CoreServices/pbs", "-update")
	return err
}
