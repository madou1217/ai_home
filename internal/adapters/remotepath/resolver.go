// Package remotepath resolves paths in the remote filesystem's namespace.
// It constrains observed paths, not concurrent replacements or arbitrary shell
// commands. Do not cache an approval across operations or retries.
package remotepath

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/madou1217/ai_home/contracts/workspacepath"
	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

type Runner interface {
	Run(context.Context, string, int) (sshremote.Result, error)
}
type Mode string

const (
	Read    Mode = "read"
	Replace Mode = "replace"
	Remove  Mode = "remove"
)

type Path struct{ Root, Target, IO string }
type Error struct{ Code string }

func (e *Error) Error() string { return "远端工作区路径校验失败: " + e.Code }

// Relative preserves POSIX filename bytes; callers decide whether a \ is a
// separator by the remote dialect, not by the local operating system.
func Relative(value, dialect string) (string, error) {
	if strings.ContainsRune(value, 0) {
		return "", &Error{"invalid_path"}
	}
	if dialect == "windows" || dialect == "powershell" {
		value = strings.ReplaceAll(value, "\\", "/")
	}
	if strings.HasPrefix(value, "/") || (len(value) >= 2 && value[1] == ':') {
		return "", &Error{"invalid_path"}
	}
	parts := make([]string, 0)
	for _, p := range strings.Split(value, "/") {
		if p == "" || p == "." {
			continue
		}
		if p == ".." {
			if len(parts) == 0 {
				return "", &Error{"path_outside_workspace"}
			}
			parts = parts[:len(parts)-1]
			continue
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, "/"), nil
}

func Resolve(ctx context.Context, runner Runner, dialect, root, rel string, mode Mode, expectedRoot ...string) (Path, error) {
	var out Path
	normalized, err := Relative(rel, dialect)
	if err != nil {
		return out, err
	}
	if strings.ContainsRune(root, 0) {
		return out, &Error{"invalid_path"}
	}
	expected := ""
	if len(expectedRoot) > 0 {
		expected = expectedRoot[0]
	}
	var command string
	if dialect == "windows" || dialect == "powershell" {
		command = PowerShellCommand("$root=" + psQuote(root) + ";$rel=" + psQuote(normalized) + ";$mode=" + psQuote(string(mode)) + ";$expected=" + psQuote(expected) + ";" + workspacepath.PowerShell)
	} else if dialect == "posix" {
		command = "sh -c " + sshhost.ShellQuote(workspacepath.POSIX) + " aih-workspace-path " + sshhost.ShellQuote(root) + " " + sshhost.ShellQuote(normalized) + " " + sshhost.ShellQuote(string(mode)) + " " + sshhost.ShellQuote(expected)
	} else {
		return out, &Error{"path_resolution_unsupported"}
	}
	result, err := runner.Run(ctx, command, 64*1024)
	if err != nil {
		return out, err
	}
	if result.Truncated {
		return out, &Error{"path_query_failed"}
	}
	if result.Code != 0 {
		return out, Failure(result.Stderr)
	}
	fields := strings.Split(string(result.Stdout), "\x00")
	if len(fields) != 4 || fields[3] != "" || fields[0] == "" || fields[1] == "" || fields[2] == "" {
		return out, &Error{"path_query_failed"}
	}
	return Path{Root: fields[0], Target: fields[1], IO: fields[2]}, nil
}

func Failure(stderr []byte) error {
	// Only the resolver's framed code is control data; never infer permission to
	// create a file from a localized shell error or a generic transport failure.
	for _, line := range strings.Split(string(stderr), "\n") {
		if !strings.HasPrefix(line, "AIH_PATH:") {
			continue
		}
		code := strings.TrimSuffix(strings.TrimPrefix(line, "AIH_PATH:"), "\r")
		switch code {
		case "workspace_root_changed", "invalid_path", "path_outside_workspace", "path_resolution_failed", "path_query_failed", "not_found", "not_directory", "permission_denied":
			return &Error{code}
		}
	}
	return &Error{"path_query_failed"}
}
func SearchCommand(root, pattern string, maximum int) string {
	return "cd " + sshhost.ShellQuote(root) + " && sh -c " + sshhost.ShellQuote(workspacepath.SearchPOSIX) + " aih-workspace-search " + sshhost.ShellQuote(pattern) + fmt.Sprintf(" %d", maximum)
}
func PowerShellCommand(script string) string {
	encode := func(text string) string {
		codes := utf16.Encode([]rune(text))
		data := make([]byte, 0, len(codes)*2)
		for _, code := range codes {
			data = binary.LittleEndian.AppendUint16(data, code)
		}
		return "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
	}
	full := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script
	command := encode(full)
	if len(command) <= 7500 {
		return command
	}
	// Windows OpenSSH may launch through cmd.exe's 8191-character limit.
	// Compress the trusted script, not stdin (which file writes may need).
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(full))
	_ = writer.Close()
	bootstrap := "$b=[Convert]::FromBase64String(" + psQuote(base64.StdEncoding.EncodeToString(compressed.Bytes())) + ");" +
		"$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);" +
		"$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);try{&([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$g.Dispose();$m.Dispose()}"
	return encode(bootstrap)
}

func psQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

// PowerShellSearch retains each caller's rg/ignore preference, but always avoids
// content reads through reparse points before Select-String runs.
func PowerShellSearch(root, pattern string, maximum int, preferRG, skipIgnored bool) string {
	boolean := func(value bool) string {
		if value {
			return "$true"
		}
		return "$false"
	}
	return PowerShellCommand("$root=" + psQuote(root) + ";$pattern=" + psQuote(pattern) + fmt.Sprintf(";$maximum=%d;", maximum) + "$preferRg=" + boolean(preferRG) + ";$skipIgnored=" + boolean(skipIgnored) + ";" + workspacepath.SearchPowerShell)
}
