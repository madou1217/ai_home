package providercliupgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	// NpmRegistryURL 锁定官方 npm registry，不被用户 .npmrc 私服劫持。
	NpmRegistryURL         = "https://registry.npmjs.org"
	defaultNpmViewTimeout  = 15 * time.Second
	defaultNpmLatestTimeout = 8 * time.Second
)

var validNpmPackageRe = regexp.MustCompile(`(?i)^@?[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?$`)

// NormalizeNpmPackageName 校验并返回安全的 npm 包名。
func NormalizeNpmPackageName(value string) string {
	trimmed := strings.TrimSpace(value)
	if !validNpmPackageRe.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

// QueryNpmLatestVersion 查询 npm dist-tags.latest 版本号。
func QueryNpmLatestVersion(ctx context.Context, packageName string, goos string, env []string) (string, error) {
	pkg := NormalizeNpmPackageName(packageName)
	if pkg == "" {
		return "", errors.New("unsupported_package")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	queryCtx, cancel := context.WithTimeout(ctx, defaultNpmLatestTimeout)
	defer cancel()

	userConfig := "/dev/null"
	if isWindowsOS(goos) {
		userConfig = "NUL"
	}
	args := []string{
		"view", pkg, "version",
		"--userconfig=" + userConfig,
		"--registry=" + NpmRegistryURL,
	}
	out, stderr, err := runNpmCommand(queryCtx, args, goos, env)
	if err != nil {
		msg := strings.TrimSpace(stderr)
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("latest_version_unavailable:%s", msg)
	}
	version := strings.TrimSpace(out)
	if version == "" {
		return "", errors.New("latest_version_unavailable")
	}
	return version, nil
}

// FetchNpmTimeTable 拉取 npm view <pkg> time --json 并返回完整版本发布时间戳映射与稳定版升序表。
func FetchNpmTimeTable(ctx context.Context, packageName string, goos string, env []string) (map[string]int64, []ReleaseTime, error) {
	pkg := NormalizeNpmPackageName(packageName)
	if pkg == "" {
		return nil, nil, errors.New("unsupported_package")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	queryCtx, cancel := context.WithTimeout(ctx, defaultNpmViewTimeout)
	defer cancel()

	userConfig := "/dev/null"
	if isWindowsOS(goos) {
		userConfig = "NUL"
	}
	args := []string{
		"view", pkg, "time", "--json",
		"--userconfig=" + userConfig,
		"--registry=" + NpmRegistryURL,
	}
	stdout, stderr, err := runNpmCommand(queryCtx, args, goos, env)
	if err != nil {
		msg := strings.TrimSpace(stderr)
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg == "" {
			msg = "npm_view_failed"
		}
		return nil, nil, errors.New(msg)
	}
	var rawTable map[string]string
	if err := json.Unmarshal([]byte(stdout), &rawTable); err != nil || rawTable == nil {
		return nil, nil, errors.New("npm_view_unparsable")
	}
	byVersion := make(map[string]int64, len(rawTable))
	stable := make([]ReleaseTime, 0, len(rawTable))
	for ver, rawTime := range rawTable {
		ts, ok := parseNPMTimestamp(rawTime)
		if !ok {
			continue
		}
		byVersion[ver] = ts
		if IsStrictStableVersion(ver) {
			stable = append(stable, ReleaseTime{Version: ver, PublishedAt: ts})
		}
	}
	sort.Slice(stable, func(i, j int) bool {
		if stable[i].PublishedAt != stable[j].PublishedAt {
			return stable[i].PublishedAt < stable[j].PublishedAt
		}
		return stable[i].Version < stable[j].Version
	})
	return byVersion, stable, nil
}

// FetchNpmPublishTime 返回单个目标版本的发布毫秒时间戳。
func FetchNpmPublishTime(ctx context.Context, packageName string, version string, goos string, env []string) (int64, error) {
	ver := NormalizeVersionSpec(version)
	if ver == "" {
		return 0, errors.New("unsupported_version")
	}
	table, _, err := FetchNpmTimeTable(ctx, packageName, goos, env)
	if err != nil {
		return 0, err
	}
	ts, ok := table[ver]
	if !ok {
		return 0, errors.New("publish_time_missing")
	}
	return ts, nil
}

func parseNPMTimestamp(raw string) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, trimmed); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

func runNpmCommand(ctx context.Context, args []string, goos string, env []string) (string, string, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	var cmd *exec.Cmd
	if isWindowsOS(goos) {
		quoted := make([]string, 0, len(args)+1)
		quoted = append(quoted, "npm.cmd")
		for _, a := range args {
			quoted = append(quoted, `"`+strings.ReplaceAll(a, `"`, `\"`)+`"`)
		}
		cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", strings.Join(quoted, " "))
	} else {
		cmd = exec.CommandContext(ctx, "npm", args...)
	}
	if len(env) > 0 {
		cmd.Env = env
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}
