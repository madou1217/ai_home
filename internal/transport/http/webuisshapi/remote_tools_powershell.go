package webuisshapi

// 远程工具的 Windows/PowerShell 方言。
//
// 与 Node 的 ops/dialect.js 对应：远端默认 shell 是 cmd.exe，所有操作通过
// powershell -EncodedCommand 执行（避免 cmd 的双引号转义地狱）。
// 读/写用 base64 走 stdin/stdout，保证二进制与 UTF-8 不被换行/编码破坏。

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

// powershellCommand 把脚本编码成 PowerShell -EncodedCommand（UTF-16LE base64）。
func powershellCommand(script string) string {
	prefix := "$ProgressPreference='SilentlyContinue';" +
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
		"$OutputEncoding=[Text.Encoding]::UTF8;"
	codes := utf16.Encode([]rune(prefix + script))
	buffer := make([]byte, 0, len(codes)*2)
	for _, code := range codes {
		buffer = binary.LittleEndian.AppendUint16(buffer, code)
	}
	return "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(buffer)
}

// psQuote 用 PowerShell 单引号引用字符串（内部单引号翻倍）。
func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func (host *remoteToolHost) windowsReadContent(ctx context.Context, rel string) ([]byte, string, error) {
	abs := host.abs(rel)
	script := "$p=" + psQuote(abs) + ";if(-not(Test-Path -LiteralPath $p)){exit 3};" +
		"$b=[IO.File]::ReadAllBytes($p);[Convert]::ToBase64String($b)"
	result, err := host.client.Run(ctx, powershellCommand(script), 4*1024*1024)
	if err != nil {
		return nil, "", err
	}
	if result.Code == 3 {
		return nil, "", errRemoteNotFound
	}
	if result.Code != 0 {
		return nil, "", fmt.Errorf("读取远端文件失败: %s", strings.TrimSpace(string(result.Stderr)))
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(result.Stdout)))
	if err != nil {
		return nil, "", fmt.Errorf("解码远端文件失败: %w", err)
	}
	if len(decoded) > remoteReadMaxBytes {
		decoded = decoded[:remoteReadMaxBytes]
	}
	return decoded, versionOfContent(decoded), nil
}

func (host *remoteToolHost) windowsWriteContent(ctx context.Context, rel string, content []byte) error {
	abs := host.abs(rel)
	script := "$p=" + psQuote(abs) + ";$d=Split-Path -Parent $p;" +
		"if($d -and -not (Test-Path -LiteralPath $d)){New-Item -ItemType Directory -Force -Path $d|Out-Null};" +
		"$s=[Console]::In.ReadToEnd();" +
		"[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String($s.Trim()))"
	encoded := base64.StdEncoding.EncodeToString(content)
	result, err := host.client.RunWithInput(ctx, powershellCommand(script), []byte(encoded), 4096)
	if err != nil {
		return err
	}
	if result.Code != 0 {
		return fmt.Errorf("写入远端文件失败: %s", strings.TrimSpace(string(result.Stderr)))
	}
	return nil
}

func (host *remoteToolHost) windowsListRaw(ctx context.Context, rel string) ([]byte, error) {
	abs := host.abs(rel)
	script := "if(-not (Test-Path -LiteralPath " + psQuote(abs) + ")){exit 3};" +
		"$items=Get-ChildItem -LiteralPath " + psQuote(abs) + " -Force -ErrorAction Stop;" +
		"foreach($i in $items){$t=if($i.PSIsContainer){'d'}elseif($i.LinkType){'l'}else{'-'};" +
		"$s=if($i.PSIsContainer){0}else{$i.Length};" +
		"[Console]::Out.WriteLine($t+[char]9+$s+[char]9+$i.Name)}"
	result, err := host.client.Run(ctx, powershellCommand(script), 4*1024*1024)
	if err != nil {
		return nil, err
	}
	if result.Code == 3 {
		return nil, errRemoteNotFound
	}
	if result.Code != 0 {
		return nil, errors.New(strings.TrimSpace(string(result.Stderr)))
	}
	return result.Stdout, nil
}

func (host *remoteToolHost) windowsSearchRaw(ctx context.Context, pattern string, maxResults int) ([]byte, error) {
	abs := host.root
	script := "$r=Get-ChildItem -LiteralPath " + psQuote(abs) + " -Recurse -File -Force -ErrorAction SilentlyContinue | " +
		"Select-String -Pattern " + psQuote(pattern) + " | Select-Object -First " + strconv.Itoa(maxResults) + ";" +
		"foreach($m in $r){[Console]::Out.WriteLine($m.Path+':'+$m.LineNumber+':'+$m.Line)}"
	return host.runPowerShell(ctx, script, 4*1024*1024)
}

func (host *remoteToolHost) windowsRun(ctx context.Context, command string, timeoutMS int) (sshremote.Result, error) {
	timeout := remoteCmdTimeout
	if timeoutMS > 0 {
		timeout = time.Duration(timeoutMS) * time.Millisecond
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > remoteMaxCmdTimeout {
		timeout = remoteMaxCmdTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	script := "Set-Location -LiteralPath " + psQuote(host.root) + "; " + command + "; " +
		"if($LASTEXITCODE -ne $null){exit $LASTEXITCODE}"
	return host.client.Run(runCtx, powershellCommand(script), remoteCommandMaxOutput)
}

func (host *remoteToolHost) runPowerShell(ctx context.Context, script string, limit int) ([]byte, error) {
	result, err := host.client.Run(ctx, powershellCommand(script), limit)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, errors.New(strings.TrimSpace(string(result.Stderr)))
	}
	return result.Stdout, nil
}

// detectRemoteDialect 先试 POSIX uname，再试 PowerShell；两者都失败返回空。
func detectRemoteDialect(ctx context.Context, client *sshremote.Client) string {
	if client == nil {
		return ""
	}
	if result, err := client.Run(ctx, "uname -s 2>/dev/null", 4096); err == nil && result.Code == 0 {
		if text := strings.TrimSpace(string(result.Stdout)); text != "" {
			lower := strings.ToLower(text)
			if strings.Contains(lower, "mingw") || strings.Contains(lower, "msys") || strings.Contains(lower, "cygwin") {
				return "windows"
			}
			return "posix"
		}
	}
	if result, err := client.Run(ctx, powershellCommand("$PSVersionTable.PSVersion.Major"), 4096); err == nil && result.Code == 0 {
		if strings.TrimSpace(string(result.Stdout)) != "" {
			return "windows"
		}
	}
	return ""
}

var _ = fmt.Sprintf
