package shellsetup

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

// DoctorCheck 是单项自检结果。
type DoctorCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// DoctorReport 汇总 shell 集成的可用性。
type DoctorReport struct {
	OK         bool          `json:"ok"`
	Shell      string        `json:"shell"`
	RcFile     string        `json:"rcFile"`
	AihBinPath string        `json:"aihBinPath"`
	Checks     []DoctorCheck `json:"checks"`
}

// Doctor 检查：shell 识别、rc 完整性、片段语法与最新度、aih 路径、补全/纠正入口。
func (s *Service) Doctor(shellOption, rcOverride string, explicit SnippetOverrides) DoctorReport {
	status := s.Status(shellOption, rcOverride, explicit)
	checks := make([]DoctorCheck, 0, 12)
	push := func(name string, ok bool, detail string) {
		checks = append(checks, DoctorCheck{Name: name, OK: ok, Detail: detail})
	}
	shellDetail := status.Shell
	if shellDetail == "" {
		shellDetail = "未识别（用 --shell 指定）"
	}
	push("shell 识别", status.Shell != "", shellDetail)
	if status.Reason != "" && status.Reason != "unsupported_shell" {
		push("rc 完整性", false, status.Reason)
	}

	var candidates []Describe
	if strings.TrimSpace(shellOption) != "" {
		candidates = []Describe{s.describe(shellOption, rcOverride, explicit)}
	} else {
		candidates = s.StatusAll(explicit, rcOverride)
	}
	targets := make([]Describe, 0, len(candidates))
	for _, entry := range candidates {
		if entry.Installed {
			targets = append(targets, entry)
		}
	}
	if len(targets) == 0 {
		push("rc 片段", false, "没有任何 shell 装了 aih 片段（先 aih shell apply）")
	}
	for _, entry := range targets {
		push(entry.Shell+" 片段已装", true, entry.RcFile)
		if entry.RcError != "" {
			push(entry.Shell+" rc 完整性", false, entry.RcError)
		}
		binary := ResolveShellBinary(entry.Shell, s.Env)
		snippet := ""
		if entry.SnippetFileExists {
			if raw, err := os.ReadFile(entry.SnippetFile); err == nil {
				snippet = string(raw)
			}
		}
		syntax := CheckShellSyntax(entry.Shell, snippet, binary)
		detail := syntax.Detail
		if syntax.Skipped {
			detail = "未验证：本机未安装该 shell"
		}
		if detail == "" {
			detail = syntax.Checker
		}
		push(entry.Shell+" 已安装片段语法", entry.SnippetFileExists && syntax.OK && !syntax.Skipped, detail)
		latestDetail := ""
		if !entry.UpToDate {
			latestDetail = "内容与当前参数不一致，可重新 apply"
		}
		push(entry.Shell+" 片段最新", entry.UpToDate, latestDetail)
	}

	binPath := status.AihBinPath
	binOK := false
	if binPath != "" && platform.IsExecutable(binPath) {
		binOK = true
	}
	push("aih 路径可用", binOK, binPath)

	if binOK {
		completeOutput, completeErr := runCapture(binPath, []string{"__complete", "--plain", "--", ""})
		lines := 0
		for _, line := range strings.Split(strings.TrimSpace(completeOutput), "\n") {
			if strings.TrimSpace(line) != "" {
				lines++
			}
		}
		push("补全入口", completeErr == nil && lines > 0, strconv.Itoa(lines)+" 个候选")
		suggestOutput, suggestErr := runCapture(binPath, []string{"__suggest", "--inside", "--", "aih", "codx"})
		suggestOK := suggestErr == nil && regexp.MustCompile(`aih:cand`).MatchString(suggestOutput)
		detail := "没有返回候选"
		if suggestOK {
			detail = "aih codx → aih codex"
		}
		push("纠正入口", suggestOK, detail)
	}

	ok := true
	for _, check := range checks {
		if !check.OK {
			ok = false
			break
		}
	}
	return DoctorReport{OK: ok, Shell: status.Shell, RcFile: status.RcFile, AihBinPath: binPath, Checks: checks}
}

func runCapture(binary string, args []string) (string, error) {
	command := exec.Command(binary, args...)
	command.Env = os.Environ()
	output, err := command.Output()
	return string(output), err
}
