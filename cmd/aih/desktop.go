package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// desktopAppEntry 是桌面端 canonical 应用目录；一个 bundle 可以服务多个 Provider。
type desktopAppEntry struct {
	Key           string
	Providers     []string
	BundleNames   []string
	BundleIDs     []string
	ShadowDirName string
}

var desktopApps = []desktopAppEntry{
	{Key: "zcode", Providers: []string{"zcode"}, BundleNames: []string{"ZCode.app", "ZCode Desktop.app"}, BundleIDs: []string{"dev.zcode.app"}, ShadowDirName: "zcode-shadow"},
	// 国际站与国内站是两个独立 App（2026-11-21 取证：官方 cask 分别为
	// codebuddy / codebuddy-cn，bundle id 也不同）。
	{Key: "codebuddy", Providers: []string{"codebuddy"}, BundleNames: []string{"CodeBuddy.app"}, BundleIDs: []string{"com.tencent.codebuddy"}},
	{Key: "codebuddy-cn", Providers: []string{"codebuddycn"}, BundleNames: []string{"CodeBuddy CN.app"}, BundleIDs: []string{"com.tencent.codebuddycn"}},
	{Key: "workbuddy", Providers: []string{"workbuddy"}, BundleNames: []string{"WorkBuddy AI.app"}, BundleIDs: []string{"com.workbuddy.workbuddy-ai"}},
	{Key: "workbuddy-cn", Providers: []string{"workbuddycn"}, BundleNames: []string{"WorkBuddy.app"}, BundleIDs: []string{"com.tencent.workbuddy.mac"}},
	{Key: "claude", Providers: []string{"claude"}, BundleNames: []string{"Claude.app"}, BundleIDs: []string{"com.anthropic.claudefordesktop"}},
	{Key: "codex", Providers: []string{"codex"}, BundleNames: []string{"ChatGPT.app"}, BundleIDs: []string{"com.openai.codex"}},
	// Kiro 桌面端现为 Kiro.app / dev.kiro.desktop；Kiro CLI.app 是旧版随 CLI
	// 分发的 GUI 外壳（官方 CLI 安装包只含 kiro-cli 二进制，2026-11-21 实装确认），
	// 仍保留为旧安装的回落落点。
	{Key: "kiro", Providers: []string{"kiro"}, BundleNames: []string{"Kiro.app", "Kiro CLI.app"}, BundleIDs: []string{"dev.kiro.desktop", "com.amazon.codewhisperer"}},
}

type desktopStatusApp struct {
	Key       string   `json:"key"`
	Providers []string `json:"providers"`
	Installed bool     `json:"installed"`
	Path      string   `json:"path"`
	BundleID  string   `json:"bundleId"`
	Version   string   `json:"version"`
}

type desktopShadow struct {
	Key         string   `json:"key"`
	Providers   []string `json:"providers"`
	Fingerprint string   `json:"fingerprint"`
	Path        string   `json:"path"`
	Version     string   `json:"version"`
	LastUsedAt  float64  `json:"lastUsedAt"`
}

type desktopRunning struct {
	Path      string   `json:"path"`
	Count     int      `json:"count"`
	PIDs      []int    `json:"pids"`
	Version   string   `json:"version"`
	Key       string   `json:"key"`
	Providers []string `json:"providers"`
	Source    string   `json:"source"`
}

type desktopDrift struct {
	Key              string                 `json:"key"`
	Providers        []string               `json:"providers"`
	CanonicalVersion string                 `json:"canonicalVersion"`
	RunningBehind    []desktopRunningBehind `json:"runningBehind"`
	StaleShadows     []desktopStaleShadow   `json:"staleShadows"`
}

type desktopRunningBehind struct {
	Version string `json:"version"`
	Source  string `json:"source"`
	Count   int    `json:"count"`
}

type desktopStaleShadow struct {
	Fingerprint string  `json:"fingerprint"`
	Version     string  `json:"version"`
	LastUsedAt  float64 `json:"lastUsedAt"`
}

type desktopStatus struct {
	CheckedAt string             `json:"checkedAt"`
	Platform  string             `json:"platform"`
	Apps      []desktopStatusApp `json:"apps"`
	Shadows   []desktopShadow    `json:"shadows"`
	Running   []desktopRunning   `json:"running"`
	Drift     []desktopDrift     `json:"drift"`
}

var (
	desktopBundlePathPattern = regexp.MustCompile(`(\S*?\.app)/Contents/`)
	desktopVersionPattern    = regexp.MustCompile(`(?s)<key>CFBundleShortVersionString</key>\s*<string>([^<]*)</string>`)
	desktopBundleIDPattern   = regexp.MustCompile(`(?s)<key>CFBundleIdentifier</key>\s*<string>([^<]*)</string>`)
)

func runDesktop(ctx context.Context, arguments []string, runtime commandRuntime) error {
	action := "status"
	jsonOutput := false
	for _, token := range arguments {
		switch strings.TrimSpace(token) {
		case "":
			continue
		case "--json":
			jsonOutput = true
		case "--help", "-h", "help":
			writeDesktopUsage(runtime.stdout)
			return nil
		default:
			if strings.HasPrefix(token, "-") {
				return fmt.Errorf("未知参数：%s", token)
			}
			action = token
		}
	}
	if action != "status" {
		return fmt.Errorf("未知动作：%s", action)
	}
	status, err := collectDesktopStatus(ctx, runtime)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeJSONDocument(runtime.stdout, status)
	}
	writeDesktopTable(runtime.stdout, status)
	return nil
}

func writeDesktopUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法：")
	_, _ = fmt.Fprintln(output, "  aih desktop status [--json]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "说明：")
	_, _ = fmt.Fprintln(output, "  status  canonical 应用版本 / 影子副本 / 运行中实例 / 漂移结论")
	_, _ = fmt.Fprintln(output, "  --json  机器可读输出")
}

func collectDesktopStatus(ctx context.Context, runtime commandRuntime) (desktopStatus, error) {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return desktopStatus{}, err
	}
	hostHome, err := runtime.userHomeDir()
	if err != nil {
		hostHome = ""
	}
	status := desktopStatus{
		CheckedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Platform:  "darwin",
		Apps:      make([]desktopStatusApp, 0, len(desktopApps)),
		Shadows:   []desktopShadow{},
		Running:   []desktopRunning{},
		Drift:     []desktopDrift{},
	}
	apps := make([]desktopStatusApp, 0, len(desktopApps))
	for _, entry := range desktopApps {
		app := resolveDesktopApp(entry, hostHome)
		apps = append(apps, app)
	}
	status.Apps = apps
	status.Shadows = collectDesktopShadows(aiHomeDir, apps)
	status.Running = collectDesktopRunning(ctx, apps, status.Shadows)
	status.Drift = buildDesktopDrift(apps, status.Shadows, status.Running)
	return status, nil
}

func resolveDesktopApp(entry desktopAppEntry, home string) desktopStatusApp {
	app := desktopStatusApp{Key: entry.Key, Providers: append([]string(nil), entry.Providers...)}
	if len(entry.BundleIDs) > 0 {
		app.BundleID = entry.BundleIDs[0]
	}
	roots := []string{"/Applications"}
	if home != "" {
		roots = append(roots, filepath.Join(home, "Applications"))
	}
	for _, root := range roots {
		for _, bundleName := range entry.BundleNames {
			candidate := filepath.Join(root, bundleName)
			info, err := os.Stat(candidate)
			if err != nil || !info.IsDir() {
				continue
			}
			version, bundleID := readDesktopBundleInfo(candidate)
			app.Installed = true
			app.Path = candidate
			app.Version = version
			if bundleID != "" {
				app.BundleID = bundleID
			}
			return app
		}
	}
	return app
}

func readDesktopBundleInfo(bundlePath string) (string, string) {
	plistPath := filepath.Join(bundlePath, "Contents", "Info.plist")
	raw, err := os.ReadFile(plistPath)
	if err != nil {
		return "", ""
	}
	xml := string(raw)
	if !strings.Contains(xml, "<plist") {
		output, execErr := exec.Command("plutil", "-convert", "xml1", "-o", "-", plistPath).Output()
		if execErr != nil {
			return "", ""
		}
		xml = string(output)
	}
	version := ""
	if match := desktopVersionPattern.FindStringSubmatch(xml); len(match) == 2 {
		version = strings.TrimSpace(match[1])
	}
	bundleID := ""
	if match := desktopBundleIDPattern.FindStringSubmatch(xml); len(match) == 2 {
		bundleID = strings.TrimSpace(match[1])
	}
	return version, bundleID
}

func collectDesktopShadows(aiHomeDir string, apps []desktopStatusApp) []desktopShadow {
	shadows := make([]desktopShadow, 0)
	byKey := make(map[string]desktopAppEntry, len(desktopApps))
	for _, entry := range desktopApps {
		byKey[entry.Key] = entry
	}
	for _, app := range apps {
		entry, ok := byKey[app.Key]
		if !ok || entry.ShadowDirName == "" {
			continue
		}
		root := filepath.Join(aiHomeDir, "run", entry.ShadowDirName)
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, directory := range entries {
			if !directory.IsDir() || strings.HasPrefix(directory.Name(), ".prepare-") {
				continue
			}
			fingerprintDir := filepath.Join(root, directory.Name())
			bundlePath := ""
			for _, bundleName := range entry.BundleNames {
				candidate := filepath.Join(fingerprintDir, bundleName)
				if info, err := os.Stat(candidate); err == nil && info.IsDir() {
					bundlePath = candidate
					break
				}
			}
			version := ""
			if bundlePath != "" {
				version, _ = readDesktopBundleInfo(bundlePath)
			}
			lastUsed := float64(0)
			if info, err := os.Stat(filepath.Join(fingerprintDir, "manifest.json")); err == nil {
				lastUsed = float64(info.ModTime().UnixNano()) / 1e6
			}
			shadowPath := bundlePath
			if shadowPath == "" {
				shadowPath = fingerprintDir
			}
			shadows = append(shadows, desktopShadow{
				Key:         app.Key,
				Providers:   append([]string(nil), app.Providers...),
				Fingerprint: directory.Name(),
				Path:        shadowPath,
				Version:     version,
				LastUsedAt:  lastUsed,
			})
		}
	}
	sort.SliceStable(shadows, func(left, right int) bool {
		if shadows[left].Key != shadows[right].Key {
			return shadows[left].Key < shadows[right].Key
		}
		return shadows[left].Fingerprint < shadows[right].Fingerprint
	})
	return shadows
}

func collectDesktopRunning(ctx context.Context, apps []desktopStatusApp, shadows []desktopShadow) []desktopRunning {
	output, err := exec.CommandContext(ctx, "ps", "-Ao", "pid=,command=").Output()
	if err != nil {
		return []desktopRunning{}
	}
	type processEntry struct {
		path  string
		count int
		pids  []int
	}
	byBundle := make(map[string]*processEntry)
	for _, line := range strings.Split(string(output), "\n") {
		match := desktopBundlePathPattern.FindStringSubmatch(line)
		if len(match) < 2 {
			continue
		}
		bundlePath := match[1]
		pid := 0
		if fields := strings.Fields(strings.TrimSpace(line)); len(fields) > 0 {
			_, _ = fmt.Sscanf(fields[0], "%d", &pid)
		}
		entry := byBundle[bundlePath]
		if entry == nil {
			entry = &processEntry{path: bundlePath}
			byBundle[bundlePath] = entry
		}
		entry.count++
		if pid > 0 {
			entry.pids = append(entry.pids, pid)
		}
	}
	appByPath := make(map[string]desktopStatusApp, len(apps))
	for _, app := range apps {
		if app.Installed {
			appByPath[app.Path] = app
		}
	}
	shadowByPath := make(map[string]desktopShadow, len(shadows))
	for _, shadow := range shadows {
		shadowByPath[shadow.Path] = shadow
	}
	groups := make(map[string]*desktopRunning)
	for path, entry := range byBundle {
		version := ""
		running := desktopRunning{Path: path, Count: entry.count, PIDs: append([]int(nil), entry.pids...)}
		if app, ok := appByPath[path]; ok {
			running.Key = app.Key
			running.Providers = app.Providers
			running.Source = "canonical"
			running.Version = app.Version
		} else if shadow, ok := shadowByPath[path]; ok {
			running.Key = shadow.Key
			running.Providers = shadow.Providers
			running.Source = "shadow"
			version = shadow.Version
			running.Version = version
		} else {
			continue
		}
		groupKey := running.Key + "|" + running.Version + "|" + running.Source
		if existing := groups[groupKey]; existing != nil {
			existing.Count += running.Count
			existing.PIDs = append(existing.PIDs, running.PIDs...)
			continue
		}
		copyValue := running
		groups[groupKey] = &copyValue
	}
	result := make([]desktopRunning, 0, len(groups))
	for _, item := range groups {
		result = append(result, *item)
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].Key != result[right].Key {
			return result[left].Key < result[right].Key
		}
		return result[left].Version < result[right].Version
	})
	return result
}

func buildDesktopDrift(apps []desktopStatusApp, shadows []desktopShadow, running []desktopRunning) []desktopDrift {
	drift := make([]desktopDrift, 0)
	for _, app := range apps {
		if !app.Installed {
			continue
		}
		behind := make([]desktopRunningBehind, 0)
		for _, item := range running {
			if item.Key != app.Key || item.Version == "" || item.Version == app.Version {
				continue
			}
			behind = append(behind, desktopRunningBehind{Version: item.Version, Source: item.Source, Count: item.Count})
		}
		stale := make([]desktopStaleShadow, 0)
		for _, shadow := range shadows {
			if shadow.Key != app.Key || shadow.Version == "" || shadow.Version == app.Version {
				continue
			}
			stale = append(stale, desktopStaleShadow{Fingerprint: shadow.Fingerprint, Version: shadow.Version, LastUsedAt: shadow.LastUsedAt})
		}
		if len(behind) == 0 && len(stale) == 0 {
			continue
		}
		drift = append(drift, desktopDrift{
			Key:              app.Key,
			Providers:        append([]string(nil), app.Providers...),
			CanonicalVersion: app.Version,
			RunningBehind:    behind,
			StaleShadows:     stale,
		})
	}
	return drift
}

func writeDesktopTable(output io.Writer, status desktopStatus) {
	rows := make([]desktopStatusApp, 0)
	for _, app := range status.Apps {
		if app.Installed {
			rows = append(rows, app)
		}
	}
	if len(rows) == 0 {
		_, _ = fmt.Fprintln(output, "没有找到 aih 管理的桌面端应用（/Applications 与 ~/Applications）。")
		return
	}
	driftByKey := make(map[string]desktopDrift, len(status.Drift))
	for _, item := range status.Drift {
		driftByKey[item.Key] = item
	}
	for _, app := range rows {
		shadowLabels := make([]string, 0)
		for _, shadow := range status.Shadows {
			if shadow.Key == app.Key {
				fingerprint := shadow.Fingerprint
				if len(fingerprint) > 8 {
					fingerprint = fingerprint[:8]
				}
				shadowLabels = append(shadowLabels, desktopVersionLabel(shadow.Version)+" "+fingerprint)
			}
		}
		runningLabels := make([]string, 0)
		for _, item := range status.Running {
			if item.Key != app.Key {
				continue
			}
			source := "本体"
			if item.Source == "shadow" {
				source = "影子"
			}
			runningLabels = append(runningLabels, fmt.Sprintf("%s x%d %s", desktopVersionLabel(item.Version), item.Count, source))
		}
		conclusion := "一致"
		if drift, ok := driftByKey[app.Key]; ok {
			parts := make([]string, 0, 2)
			if len(drift.RunningBehind) > 0 {
				versions := make([]string, 0, len(drift.RunningBehind))
				for _, item := range drift.RunningBehind {
					versions = append(versions, desktopVersionLabel(item.Version))
				}
				parts = append(parts, "运行中落后："+strings.Join(versions, ", "))
			}
			if len(drift.StaleShadows) > 0 {
				versions := make([]string, 0, len(drift.StaleShadows))
				for _, item := range drift.StaleShadows {
					versions = append(versions, desktopVersionLabel(item.Version))
				}
				parts = append(parts, "旧影子 "+strings.Join(versions, ", "))
			}
			conclusion = strings.Join(parts, "；")
		}
		_, _ = fmt.Fprintf(output, "%s  canonical %s  影子 %s  运行中 %s  结论 %s\n",
			app.Key,
			desktopVersionLabel(app.Version),
			emptyDesktopLabel(strings.Join(shadowLabels, ", ")),
			emptyDesktopLabel(strings.Join(runningLabels, ", "), "未运行"),
			conclusion,
		)
	}
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "提示：升级只影响 canonical；影子副本按指纹重建。旧影子等 7 天自动回收。")
}

func desktopVersionLabel(version string) string {
	if strings.TrimSpace(version) == "" {
		return "未知"
	}
	return strings.TrimSpace(version)
}

func emptyDesktopLabel(value string, fallback ...string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return "—"
}
