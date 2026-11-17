package apps

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// Keep semantic npm plans intact for lifecycle inference and registry fallback.
// Only Windows Codex jobs need this native launch adapter: CreateProcess cannot
// execute npm.cmd, and passing prefix/registry values through a shell is unsafe.
func runCodexNPMPlan(ctx context.Context, plan LifecyclePlan, opts Options, execOpts environment.ExecOptions) environment.RunResult {
	command, args := plan.Command, plan.Args
	if resolvePlatform(opts) == platformWindows && isNPMCommand(command) && len(args) >= 3 &&
		(args[0] == "install" || args[0] == "uninstall") &&
		strings.TrimSuffix(args[2], "@latest") == "@openai/codex" {
		launchOpts := opts
		launchOpts.Env = execOpts.Env
		var err error
		command, args, err = windowsCodexNPMCommand(args, launchOpts)
		if err != nil {
			return environment.RunResult{
				SpawnFailed: true,
				Message:     "无法启动 Codex 的 npm 作业：" + err.Error() + "。请将完整 Node.js/npm 安装目录加入当前服务器 PATH 后重试；现有配置及 Codex hook 不会被修改。",
			}
		}
	}
	return opts.exec().Run(ctx, command, args, execOpts)
}

// npm.cmd's standard installed payload is relative to the shim. Invoke that
// payload with its sibling Node (or the configured/PATH Node) using argv only.
func windowsCodexNPMCommand(args []string, opts Options) (string, []string, error) {
	npm, err := windowsNPMExecutable("npm.cmd", opts)
	if err != nil {
		return "", nil, fmt.Errorf("找不到 npm.cmd: %w", err)
	}
	dir := filepath.Dir(npm)
	entry := filepath.Join(dir, "node_modules", "npm", "bin", "npm-cli.js")
	if !fileExists(entry) {
		return "", nil, fmt.Errorf("npm 安装缺少 npm-cli.js: %w", exec.ErrNotFound)
	}
	node := filepath.Join(dir, "node.exe")
	if !isExecutableFile(platformWindows, node) {
		if opts.NodeExecPath != "" {
			node = opts.NodeExecPath
			if !filepath.IsAbs(node) || !strings.EqualFold(filepath.Base(node), "node.exe") || !isExecutableFile(platformWindows, node) {
				return "", nil, fmt.Errorf("配置的 NodeExecPath 不可用: %w", exec.ErrNotFound)
			}
		} else {
			node, err = windowsNPMExecutable("node.exe", opts)
			if err != nil {
				return "", nil, fmt.Errorf("找不到 node.exe: %w", err)
			}
		}
	}
	return node, append([]string{entry}, args...), nil
}

// Resolve exact filenames from the active server's effective PATH, not the
// agent/process PATH or the current directory. A PATH file is not a directory.
func windowsNPMExecutable(name string, opts Options) (string, error) {
	if opts.LookPath != nil {
		found, err := opts.LookPath(name)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(found) {
			return "", exec.ErrDot
		}
		if !strings.EqualFold(filepath.Base(found), name) || !isExecutableFile(platformWindows, found) {
			return "", exec.ErrNotFound
		}
		return found, nil
	}
	var path string
pathEnv:
	for _, values := range []map[string]string{opts.Env, resolveEnvMap(opts)} {
		if value, ok := values["PATH"]; ok {
			path = value
			break
		}
		for key, value := range values {
			if strings.EqualFold(key, "PATH") {
				path = value
				break pathEnv
			}
		}
	}
	for _, dir := range filepath.SplitList(path) {
		if !dirExists(dir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		if !isExecutableFile(platformWindows, candidate) {
			continue
		}
		if !filepath.IsAbs(candidate) {
			return "", exec.ErrDot
		}
		return candidate, nil
	}
	return "", exec.ErrNotFound
}
