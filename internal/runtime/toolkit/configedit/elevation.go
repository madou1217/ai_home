package configedit

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const elevationTimeout = 60 * time.Second

// ElevationRunner 执行单条提权 shell/PowerShell 指令，便于单测替换。
type ElevationRunner interface {
	RunElevated(ctx context.Context, platform string, command string, env map[string]string) ElevationResult
}

// ElevationResult 表示提权工具（osascript/pkexec/sudo/RunAs）的调用结果。
type ElevationResult struct {
	OK        bool
	Available bool
	Cancelled bool
	Detail    string
}

type hostElevationRunner struct {
	exec environment.Executor
}

func defaultElevationRunner(exec environment.Executor) ElevationRunner {
	if exec == nil {
		exec = hostexec.Executor{}
	}
	return hostElevationRunner{exec: exec}
}

func (runner hostElevationRunner) RunElevated(ctx context.Context, platform string, command string, env map[string]string) ElevationResult {
	switch NormalizePlatform(platform) {
	case "macos":
		script := "do shell script " + quoteAppleScriptString(command) + " with administrator privileges"
		res := runner.exec.Run(ctx, "osascript", []string{"-e", script}, environment.ExecOptions{
			Env:     env,
			Timeout: elevationTimeout,
		})
		return toElevationResult(res)
	case "windows":
		innerEncoded := encodePowerShellUTF16Base64(command)
		outerScript := strings.Join([]string{
			"$ErrorActionPreference = 'Stop'",
			"$innerEncoded = " + quotePowerShellLiteral(innerEncoded),
			"$elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $innerEncoded) -Verb RunAs -Wait -PassThru",
			"exit $elevated.ExitCode",
		}, "; ")
		res := runner.exec.Run(ctx, "powershell.exe", []string{
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellUTF16Base64(outerScript),
		}, environment.ExecOptions{
			Env:     env,
			Timeout: elevationTimeout,
		})
		return toElevationResult(res)
	default:
		res := runner.exec.Run(ctx, "pkexec", []string{"/bin/sh", "-c", command}, environment.ExecOptions{
			Env:     env,
			Timeout: elevationTimeout,
		})
		if res.OK {
			return ElevationResult{OK: true, Available: true}
		}
		if !isExecNotFound(res) {
			return ElevationResult{
				OK:        false,
				Available: true,
				Cancelled: true,
				Detail:    firstNonEmpty(res.Stderr, res.Stdout, res.Message),
			}
		}
		fallback := runner.exec.Run(ctx, "sudo", []string{"-n", "/bin/sh", "-c", command}, environment.ExecOptions{
			Env:     env,
			Timeout: elevationTimeout,
		})
		return toElevationResult(fallback)
	}
}

func toElevationResult(res environment.RunResult) ElevationResult {
	available := !isExecNotFound(res)
	return ElevationResult{
		OK:        res.OK,
		Available: available,
		Cancelled: !res.OK,
		Detail:    firstNonEmpty(res.Stderr, res.Stdout, res.Message),
	}
}

func isExecNotFound(res environment.RunResult) bool {
	if res.SpawnFailed && (res.ExitCode == nil || strings.Contains(strings.ToLower(res.Message), "executable file not found") || strings.Contains(strings.ToLower(res.Message), "no such file")) {
		return true
	}
	return res.ExitCode != nil && *res.ExitCode == 127
}

func buildElevationError(operation string, result ElevationResult) error {
	if !result.Available {
		return NewError("privilege_unavailable", operation+"配置需要系统授权，但当前平台没有可用的授权工具")
	}
	return &ToolkitError{
		Code:    "privilege_denied",
		Message: operation + "配置的系统授权未完成",
		Detail:  result.Detail,
	}
}

func readElevatedFile(ctx context.Context, runner ElevationRunner, platform string, targetPath string, env map[string]string) (string, error) {
	tempDir, err := os.MkdirTemp("", "aih-toolkit-config-")
	if err != nil {
		return "", configIOError("read", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	tempFile := filepath.Join(tempDir, "payload")
	if err := os.WriteFile(tempFile, nil, 0o600); err != nil {
		return "", configIOError("read", err)
	}
	var cmd string
	if NormalizePlatform(platform) == "windows" {
		cmd = strings.Join([]string{
			"$ErrorActionPreference = 'Stop'",
			fmt.Sprintf("[IO.File]::WriteAllText(%s, [IO.File]::ReadAllText(%s), [Text.UTF8Encoding]::new($false))", quotePowerShellLiteral(tempFile), quotePowerShellLiteral(targetPath)),
		}, "; ")
	} else {
		cmd = fmt.Sprintf("/bin/cat -- %s > %s", quoteShellArg(targetPath), quoteShellArg(tempFile))
	}
	res := runner.RunElevated(ctx, platform, cmd, env)
	if !res.OK {
		return "", buildElevationError("读取", res)
	}
	data, err := os.ReadFile(tempFile)
	if err != nil {
		return "", configIOError("read", err)
	}
	return string(data), nil
}

func writeElevatedFile(ctx context.Context, runner ElevationRunner, platform string, targetPath string, content string, mode os.FileMode, env map[string]string) error {
	tempDir, err := os.MkdirTemp("", "aih-toolkit-config-")
	if err != nil {
		return configIOError("save", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	tempFile := filepath.Join(tempDir, "payload")
	if err := os.WriteFile(tempFile, []byte(content), 0o600); err != nil {
		return configIOError("save", err)
	}
	stagingPath := createSiblingTempPath(targetPath)
	var cmd string
	if NormalizePlatform(platform) == "windows" {
		cmd = strings.Join([]string{
			"$ErrorActionPreference = 'Stop'",
			"$parent = Split-Path -Parent -LiteralPath " + quotePowerShellLiteral(targetPath),
			"New-Item -ItemType Directory -Force -Path $parent | Out-Null",
			fmt.Sprintf(
				"try { Copy-Item -LiteralPath %s -Destination %s -Force; if (Test-Path -LiteralPath %s) { [IO.File]::Replace(%s, %s, $null, $true) } else { [IO.File]::Move(%s, %s) } } finally { if (Test-Path -LiteralPath %s) { Remove-Item -LiteralPath %s -Force } }",
				quotePowerShellLiteral(tempFile), quotePowerShellLiteral(stagingPath),
				quotePowerShellLiteral(targetPath),
				quotePowerShellLiteral(stagingPath), quotePowerShellLiteral(targetPath),
				quotePowerShellLiteral(stagingPath), quotePowerShellLiteral(targetPath),
				quotePowerShellLiteral(stagingPath), quotePowerShellLiteral(stagingPath),
			),
		}, "; ")
	} else {
		modeStr := fmt.Sprintf("%03o", mode.Perm())
		if modeStr == "000" {
			modeStr = "600"
		}
		parentPath := filepath.Dir(targetPath)
		op := strings.Join([]string{
			"/bin/mkdir -p -- " + quoteShellArg(parentPath),
			fmt.Sprintf("/usr/bin/install -m %s -- %s %s", modeStr, quoteShellArg(tempFile), quoteShellArg(stagingPath)),
			fmt.Sprintf("/bin/mv -f -- %s %s", quoteShellArg(stagingPath), quoteShellArg(targetPath)),
		}, " && ")
		cmd = fmt.Sprintf("%s; aih_config_status=$?; /bin/rm -f -- %s; exit $aih_config_status", op, quoteShellArg(stagingPath))
	}
	res := runner.RunElevated(ctx, platform, cmd, env)
	if !res.OK {
		return buildElevationError("保存", res)
	}
	return nil
}

func quoteShellArg(val string) string {
	return "'" + strings.ReplaceAll(val, "'", `'\''`) + "'"
}

func quotePowerShellLiteral(val string) string {
	return "'" + strings.ReplaceAll(val, "'", "''") + "'"
}

func quoteAppleScriptString(val string) string {
	escaped := strings.ReplaceAll(val, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `"` + escaped + `"`
}

func encodePowerShellUTF16Base64(script string) string {
	u16 := utf16.Encode([]rune(script))
	raw := make([]byte, len(u16)*2)
	for i, code := range u16 {
		raw[i*2] = byte(code)
		raw[i*2+1] = byte(code >> 8)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func randomHex(bytesLen int) string {
	buf := make([]byte, bytesLen)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	const hexChars = "0123456789abcdef"
	out := make([]byte, len(buf)*2)
	for i, b := range buf {
		out[i*2] = hexChars[b>>4]
		out[i*2+1] = hexChars[b&0x0f]
	}
	return string(out)
}
