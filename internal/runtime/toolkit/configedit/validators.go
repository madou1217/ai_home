package configedit

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const verifyTimeout = 15 * time.Second

// ValidationOutcome 描述配置保存前校验的结果。
type ValidationOutcome struct {
	OK      bool
	Skipped bool
	Message string
}

// ValidateTOML 使用 providerconfigs 的严格 TOML 解析器校验语法。
func ValidateTOML(content string) ValidationOutcome {
	res := providerconfigs.ValidateContent(content, "toml")
	if res.Valid {
		return ValidationOutcome{OK: true}
	}
	msg := "TOML 语法错误"
	if len(res.Errors) > 0 && strings.TrimSpace(res.Errors[0].Message) != "" {
		msg = res.Errors[0].Message
	}
	return ValidationOutcome{OK: false, Message: msg}
}

// VerifyWithBinary 将候选配置写入临时文件并调用工具自带校验命令（如 caddy validate / frpc verify）。
func VerifyWithBinary(
	ctx context.Context,
	exec environment.Executor,
	executablePath string,
	targetPath string,
	content string,
	displayLabel string,
	preferTargetDir bool,
	buildArgs func(tmpFile string) []string,
) ValidationOutcome {
	bin := strings.TrimSpace(executablePath)
	if bin == "" || exec == nil {
		return ValidationOutcome{OK: true, Skipped: true}
	}
	ext := filepath.Ext(strings.TrimSpace(targetPath))
	if ext == "" {
		ext = ".conf"
	}
	suffix := randomHex(4) + ext

	var tmpDir string
	var tmpFile string
	if preferTargetDir && strings.TrimSpace(targetPath) != "" {
		candidate := filepath.Join(filepath.Dir(targetPath), ".aih-verify-"+suffix)
		f, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, werr := f.WriteString(content)
			_ = f.Close()
			if werr == nil {
				tmpFile = candidate
			} else {
				_ = os.Remove(candidate)
			}
		}
	}
	if tmpFile == "" {
		createdDir, err := os.MkdirTemp("", "aih-verify-")
		if err != nil {
			return ValidationOutcome{OK: false, Message: err.Error()}
		}
		tmpDir = createdDir
		tmpFile = filepath.Join(tmpDir, displayLabel+"-"+suffix)
		if err := os.WriteFile(tmpFile, []byte(content), 0o600); err != nil {
			_ = os.RemoveAll(tmpDir)
			return ValidationOutcome{OK: false, Message: err.Error()}
		}
	}
	defer func() {
		if tmpDir != "" {
			_ = os.RemoveAll(tmpDir)
		} else if tmpFile != "" {
			_ = os.Remove(tmpFile)
		}
	}()

	res := exec.Run(ctx, bin, buildArgs(tmpFile), environment.ExecOptions{Timeout: verifyTimeout})
	if res.OK {
		return ValidationOutcome{OK: true}
	}
	combined := strings.TrimSpace(res.Stdout + "\n" + res.Stderr + "\n" + res.Message)
	combined = strings.ReplaceAll(combined, tmpFile, displayLabel)
	if len(combined) > 800 {
		combined = combined[:800]
	}
	if combined == "" {
		combined = displayLabel + " 校验未通过"
	}
	return ValidationOutcome{OK: false, Message: combined}
}
