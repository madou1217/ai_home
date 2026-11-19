package shellsetup

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// SyntaxCheck 是片段语法自检结果。
type SyntaxCheck struct {
	OK      bool   `json:"ok"`
	Shell   string `json:"shell"`
	Checker string `json:"checker,omitempty"`
	Skipped bool   `json:"skipped,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

const powershellParserScript = `param([string]$Path)
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Output ("{0}:{1}: {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message) }
    exit 1
}
exit 0
`

func runChecker(binary string, args []string) SyntaxCheck {
	command := exec.Command(binary, args...)
	command.Env = os.Environ()
	output, err := command.CombinedOutput()
	detail := strings.TrimSpace(string(output))
	if err != nil {
		if detail == "" {
			detail = err.Error()
		}
		return SyntaxCheck{OK: false, Detail: detail}
	}
	return SyntaxCheck{OK: true, Detail: detail}
}

// CheckShellSyntax 把片段交给该 shell 自己的解析器验证；shell 未安装时跳过。
func CheckShellSyntax(shell, snippet, binary string) SyntaxCheck {
	directory, err := os.MkdirTemp("", "aih-shell-check-")
	if err != nil {
		return SyntaxCheck{OK: false, Shell: shell, Checker: "internal", Detail: err.Error()}
	}
	defer os.RemoveAll(directory)
	extension := shell
	if shell == "powershell" {
		extension = "ps1"
	}
	snippetFile := filepath.Join(directory, "snippet."+extension)
	if err := os.WriteFile(snippetFile, []byte(snippet), 0o600); err != nil {
		return SyntaxCheck{OK: false, Shell: shell, Checker: "internal", Detail: err.Error()}
	}
	if shell == "powershell" {
		if binary == "" {
			return SyntaxCheck{OK: true, Shell: shell, Skipped: true, Detail: "powershell_not_found"}
		}
		parserFile := filepath.Join(directory, "parse.ps1")
		if err := os.WriteFile(parserFile, []byte(powershellParserScript), 0o600); err != nil {
			return SyntaxCheck{OK: false, Shell: shell, Checker: "internal", Detail: err.Error()}
		}
		result := runChecker(binary, []string{"-NoProfile", "-NoLogo", "-NonInteractive", "-File", parserFile, snippetFile})
		result.Shell = shell
		result.Checker = "powershell-parser"
		return result
	}
	switch shell {
	case "zsh", "bash", "fish":
	default:
		return SyntaxCheck{OK: true, Shell: shell, Skipped: true, Detail: "unsupported_shell"}
	}
	if binary == "" {
		return SyntaxCheck{OK: true, Shell: shell, Skipped: true, Detail: shell + "_not_found"}
	}
	result := runChecker(binary, []string{"-n", snippetFile})
	result.Shell = shell
	result.Checker = fmt.Sprintf("%s -n", shell)
	return result
}
