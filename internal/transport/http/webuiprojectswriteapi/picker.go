package webuiprojectswriteapi

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
)

// PickerError 描述系统目录选择器的结构化错误。
type PickerError struct {
	Code    string
	Message string
}

func (err *PickerError) Error() string {
	if err == nil {
		return ""
	}
	if err.Message != "" {
		return err.Message
	}
	return err.Code
}

func defaultPickDirectory(ctx context.Context, prompt string) (string, bool, error) {
	switch runtime.GOOS {
	case "darwin":
		script := `POSIX path of (choose folder with prompt "` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(prompt) + `")`
		cmd := exec.CommandContext(ctx, "osascript", "-e", script)
		out, err := cmd.CombinedOutput()
		if err != nil {
			text := string(out)
			var exitErr *exec.ExitError
			if (errors.As(err, &exitErr) && exitErr.ExitCode() == 1) &&
				(strings.Contains(text, "-128") || strings.Contains(strings.ToLower(text), "cancel")) {
				return "", true, nil
			}
			return "", false, &PickerError{Code: "project_picker_failed", Message: strings.TrimSpace(text)}
		}
		trimmed := strings.TrimSpace(string(out))
		if trimmed == "" {
			return "", true, nil
		}
		return trimmed, false, nil
	case "windows":
		script := strings.Join([]string{
			"Add-Type -AssemblyName System.Windows.Forms",
			"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
			"$dialog.Description = '" + strings.ReplaceAll(prompt, "'", "''") + "'",
			"$dialog.ShowNewFolderButton = $true",
			"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
		}, "; ")
		out, err := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Sta", "-Command", script).CombinedOutput()
		if err != nil {
			return "", false, &PickerError{Code: "project_picker_failed", Message: strings.TrimSpace(string(out))}
		}
		trimmed := strings.TrimSpace(string(out))
		if trimmed == "" {
			return "", true, nil
		}
		return trimmed, false, nil
	default:
		return "", false, &PickerError{
			Code:    "project_picker_unsupported_platform",
			Message: "当前平台暂不支持目录选择器，请手动输入路径。",
		}
	}
}
