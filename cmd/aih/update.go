package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type updateOptions struct {
	checkOnly bool
	dryRun    bool
	force     bool
	help      bool
}

func runUpdate(ctx context.Context, arguments []string, runtime commandRuntime) error {
	options, err := parseUpdateOptions(arguments)
	if err != nil {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 未识别的参数 '%s'，以下是可用用法：\n", err)
		writeUpdateUsage(runtime.stdout)
		return nil
	}
	if options.help {
		writeUpdateUsage(runtime.stdout)
		return nil
	}
	root := resolvePluginRepoRoot()
	if root == "" {
		root, _ = filepath.Abs(filepath.Join(filepath.Dir(os.Args[0]), "../../../.."))
	}
	packageName, currentVersion, infoErr := readUpdatePackageInfo(root)
	if infoErr != nil {
		return infoErr
	}
	source := detectUpdateSource(root)
	if source == "source-link" {
		commit := readGitCommit(root)
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] current: %s\n", currentVersion)
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] source: source-link")
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] source path: %s\n", root)
		if commit != "" {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] commit: %s\n", commit)
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] npm registry check skipped for source-linked install")
		if options.checkOnly {
			return nil
		}
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] Automatic update skipped for source-linked install. Run: git -C %s pull --ff-only\n", root)
		return &cliExitCode{code: 1}
	}
	if source == "package" {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] current: %s\n", currentVersion)
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] source: package")
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] 分发包通过下载新版本安装包更新（数据目录不变）")
		if options.checkOnly {
			return nil
		}
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 分发包不支持原地 npm 更新；请下载新版本安装包。")
		return &cliExitCode{code: 1}
	}
	latest, latestErr := fetchLatestNPMVersion(ctx, packageName)
	if latestErr != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] update check failed: %s\n", latestErr)
		return &cliExitCode{code: 1}
	}
	hasUpdate := latest != currentVersion
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] current: %s\n", currentVersion)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] source: %s\n", source)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] latest: %s\n", latest)
	if hasUpdate {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] update available")
	} else {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] already up to date")
	}
	if options.checkOnly || (!hasUpdate && !options.force) {
		return nil
	}
	installArgs := []string{"install", "-g", packageName + "@latest"}
	if options.dryRun {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] dry-run: npm %s\n", strings.Join(installArgs, " "))
		return nil
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] running: npm %s\n", strings.Join(installArgs, " "))
	command := exec.CommandContext(ctx, "npm", installArgs...)
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Stdin = runtime.stdin
	if err := command.Run(); err != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] update failed. Retry manually: npm %s\n", strings.Join(installArgs, " "))
		return &cliExitCode{code: 1}
	}
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] update completed")
	return nil
}

func parseUpdateOptions(arguments []string) (updateOptions, error) {
	options := updateOptions{}
	for _, argument := range arguments {
		switch strings.TrimSpace(argument) {
		case "":
			continue
		case "--check":
			options.checkOnly = true
		case "--dry-run":
			options.dryRun = true
		case "--force":
			options.force = true
		case "--help", "-h", "help":
			options.help = true
		default:
			return options, fmt.Errorf("%s", argument)
		}
	}
	return options, nil
}

func writeUpdateUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "AIH Update - Check for updates or update ai-home via npm")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "Usage: aih update [--check] [--dry-run] [--force]")
	_, _ = fmt.Fprintln(output, "  --check     只检查是否有新版本，不安装")
	_, _ = fmt.Fprintln(output, "  --dry-run   打印将要执行的更新命令，不真的执行")
	_, _ = fmt.Fprintln(output, "  --force     即使已是同一版本也重装")
}

func readUpdatePackageInfo(root string) (string, string, error) {
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return "", "", fmt.Errorf("无法读取 package.json: %w", err)
	}
	var document struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &document) != nil {
		return "", "", fmt.Errorf("package.json 不是合法 JSON")
	}
	return document.Name, document.Version, nil
}

func detectUpdateSource(root string) string {
	if os.Getenv("AIH_PACKAGED") == "1" {
		return "package"
	}
	if root != "" {
		if info, err := os.Stat(filepath.Join(root, ".git")); err == nil && info.IsDir() {
			return "source-link"
		}
	}
	if strings.Contains(strings.ToLower(os.Getenv("npm_execpath")), "npm-cli.js") ||
		strings.HasPrefix(os.Getenv("npm_config_user_agent"), "npm/") {
		return "npm"
	}
	return "unknown"
}

func readGitCommit(root string) string {
	command := exec.Command("git", "-C", root, "rev-parse", "HEAD")
	output, err := command.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func fetchLatestNPMVersion(ctx context.Context, packageName string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://registry.npmjs.org/"+packageName+"/latest", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("Failed to query npm registry: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Failed to query npm registry (status: %d)", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var payload struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &payload) != nil || strings.TrimSpace(payload.Version) == "" {
		return "", fmt.Errorf("npm registry did not return a valid latest version")
	}
	return strings.TrimSpace(payload.Version), nil
}
