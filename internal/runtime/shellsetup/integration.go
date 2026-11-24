package shellsetup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Service 把生成的片段落到（或从）用户 rc 文件里。
//
// 纪律：plan 只打印、apply 才写；写前备份；原子替换；只动受管块。
type Service struct {
	HomeDir string
	Env     func(string) string
}

// NewService 使用宿主家目录创建服务。HOME 被投影覆盖时仍写宿主 rc。
func NewService(homeDir string, env func(string) string) *Service {
	return &Service{HomeDir: homeDir, Env: env}
}

// Describe 是某个 shell 的现状。
type Describe struct {
	Shell             string
	RcFile            string
	SnippetFile       string
	SnippetOptions    SnippetOptions
	Snippet           string
	SnippetStub       string
	SnippetFileExists bool
	SnippetUpToDate   bool
	RcExists          bool
	RcError           string
	Installed         bool
	UpToDate          bool
	ShellAvailable    bool
}

// DescribeJSON 与历史 `status --json` 的 shells 项字段一致。
type DescribeJSON struct {
	Shell             string         `json:"shell"`
	RcFile            string         `json:"rcFile"`
	SnippetFile       string         `json:"snippetFile"`
	SnippetOptions    SnippetOptions `json:"snippetOptions"`
	Snippet           string         `json:"snippet"`
	SnippetStub       string         `json:"snippetStub"`
	SnippetFileExists bool           `json:"snippetFileExists"`
	SnippetUpToDate   bool           `json:"snippetUpToDate"`
	RcExists          bool           `json:"rcExists"`
	RcError           string         `json:"rcError"`
	Installed         bool           `json:"installed"`
	UpToDate          bool           `json:"upToDate"`
	ShellAvailable    bool           `json:"shellAvailable"`
}

// JSON 投影为公开结构。
func (d Describe) JSON() DescribeJSON {
	return DescribeJSON{
		Shell:             d.Shell,
		RcFile:            d.RcFile,
		SnippetFile:       d.SnippetFile,
		SnippetOptions:    d.SnippetOptions,
		Snippet:           d.Snippet,
		SnippetStub:       d.SnippetStub,
		SnippetFileExists: d.SnippetFileExists,
		SnippetUpToDate:   d.SnippetUpToDate,
		RcExists:          d.RcExists,
		RcError:           d.RcError,
		Installed:         d.Installed,
		UpToDate:          d.UpToDate,
		ShellAvailable:    d.ShellAvailable,
	}
}

// ResolveTarget 解析目标 shell 与 rc 文件。
func (s *Service) ResolveTarget(shellOption, rcOverride string) (string, string) {
	shell := DetectShell(shellOption, s.Env)
	override := strings.TrimSpace(rcOverride)
	if override != "" {
		return shell, override
	}
	if shell == "" {
		return "", ""
	}
	return shell, RcFile(shell, s.HomeDir, s.Env)
}

func snippetExtension(shell string) string {
	switch shell {
	case "zsh":
		return "zsh"
	case "bash":
		return "bash"
	case "fish":
		return "fish"
	case "powershell":
		return "ps1"
	case "sh":
		return "sh"
	default:
		return ""
	}
}

func (s *Service) snippetFile(shell, rcFile string) string {
	extension := snippetExtension(shell)
	if extension == "" {
		return ""
	}
	absolute, err := filepath.Abs(rcFile)
	if err != nil {
		absolute = rcFile
	}
	sum := sha256.Sum256([]byte(absolute))
	identity := hex.EncodeToString(sum[:])[:20]
	return filepath.Join(s.HomeDir, ".ai_home", "shell", fmt.Sprintf("aih-%s.%s", identity, extension))
}

func (s *Service) legacySnippetFile(shell string) string {
	extension := snippetExtension(shell)
	if extension == "" {
		return ""
	}
	return filepath.Join(s.HomeDir, ".ai_home", "shell", "aih."+extension)
}

func quoteDouble(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		`$`, `\$`,
		"`", "\\`",
	)
	return `"` + replacer.Replace(value) + `"`
}

func buildRcStub(shell, snippetFile string) string {
	switch shell {
	case "powershell":
		return fmt.Sprintf("if (Test-Path -LiteralPath '%s') { . '%s' }",
			strings.ReplaceAll(snippetFile, "'", "''"), strings.ReplaceAll(snippetFile, "'", "''"))
	case "fish":
		file := "'" + strings.ReplaceAll(strings.ReplaceAll(snippetFile, `\`, `\\`), "'", `\'`) + "'"
		return "test -f " + file + "; and source " + file
	default:
		file := quoteDouble(snippetFile)
		return "[ -f " + file + " ] && . " + file
	}
}

func legacyRcStub(shell, snippetFile string) string {
	quoted := quoteDouble(snippetFile)
	switch shell {
	case "powershell":
		return fmt.Sprintf("if (Test-Path %s) { . %s }", quoted, quoted)
	case "fish":
		return fmt.Sprintf("test -f %s; and source %s", quoted, quoted)
	default:
		return fmt.Sprintf("[ -f %s ] && . %s", quoted, quoted)
	}
}

func referencesSnippet(block, shell, file string) bool {
	if file == "" {
		return false
	}
	known := map[string]bool{
		buildRcStub(shell, file):  true,
		legacyRcStub(shell, file): true,
	}
	for _, line := range strings.Split(block, "\n") {
		if known[strings.TrimSpace(strings.TrimSuffix(line, "\r"))] {
			return true
		}
	}
	return false
}

func readTextIfExists(file string) (string, bool) {
	if file == "" {
		return "", false
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	return string(bytes), true
}

func (s *Service) describe(shellOption, rcOverride string, explicit SnippetOverrides) Describe {
	shell, rcFile := s.ResolveTarget(shellOption, rcOverride)
	result := Describe{Shell: shell, RcFile: rcFile}
	if shell != "" {
		result.SnippetFile = s.snippetFile(shell, rcFile)
		result.SnippetStub = buildRcStub(shell, result.SnippetFile)
		result.ShellAvailable = ResolveShellBinary(shell, s.Env) != ""
	}
	snippetText, snippetExists := readTextIfExists(result.SnippetFile)
	result.SnippetFileExists = snippetExists

	snapshot := Snapshot{File: rcFile, Target: rcFile, Mode: 0o600, Encoding: "utf8"}
	if rcFile != "" {
		loaded, err := ReadSnapshot(rcFile)
		if err != nil {
			result.RcError = err.Error()
		} else {
			snapshot = loaded
		}
	}
	result.RcExists = snapshot.Exists
	installedBlock, installed, inspectErr := ReadManagedBlock(snapshot.Text)
	if inspectErr != nil && result.RcError == "" {
		result.RcError = inspectErr.Error()
	}
	result.Installed = installed

	settingsText := ""
	if installed {
		switch {
		case referencesSnippet(installedBlock, shell, result.SnippetFile) && snippetExists:
			settingsText = snippetText
		case referencesSnippet(installedBlock, shell, s.legacySnippetFile(shell)):
			settingsText, _ = readTextIfExists(s.legacySnippetFile(shell))
		}
	}
	stored := StoredSnippetOptions(settingsText)
	result.SnippetOptions = ResolveSnippetOptions(stored, explicit)
	if shell != "" {
		result.Snippet, _ = Snippet(shell, result.SnippetOptions)
	}
	result.SnippetUpToDate = result.Snippet != "" && snippetExists &&
		strings.TrimSpace(snippetText) == strings.TrimSpace(result.Snippet)
	result.UpToDate = result.RcError == "" && installed &&
		strings.TrimSpace(stripJoinLines(installedBlock)) == strings.TrimSpace(result.SnippetStub) &&
		result.SnippetUpToDate
	return result
}

func stripJoinLines(block string) string {
	lines := strings.Split(block, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(line, joinPrefix) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// DescribeShell 返回指定 shell 的现状。
func (s *Service) DescribeShell(shell string, explicit SnippetOverrides) Describe {
	return s.describe(shell, "", explicit)
}

// DescribeTarget 返回检测到的 shell 的现状。
func (s *Service) DescribeTarget(shellOption, rcOverride string, explicit SnippetOverrides) Describe {
	return s.describe(shellOption, rcOverride, explicit)
}

// StatusAll 返回所有受支持 shell 的现状。
func (s *Service) StatusAll(explicit SnippetOverrides, rcOverride string) []Describe {
	result := make([]Describe, 0, len(SupportedShells()))
	for _, shell := range SupportedShells() {
		result = append(result, s.describe(shell, rcOverride, explicit))
	}
	return result
}

// Status 是 `aih shell status` 的公开结果。
type Status struct {
	OK              bool           `json:"ok"`
	Reason          string         `json:"reason"`
	Shell           string         `json:"shell"`
	RcFile          string         `json:"rcFile"`
	SnippetFile     string         `json:"snippetFile"`
	RcExists        bool           `json:"rcExists"`
	Installed       bool           `json:"installed"`
	UpToDate        bool           `json:"upToDate"`
	SnippetUpToDate bool           `json:"snippetUpToDate"`
	AihBinPath      string         `json:"aihBinPath"`
	Features        StatusFeatures `json:"features"`
}

// StatusFeatures 是功能开关投影。
type StatusFeatures struct {
	Completion bool `json:"completion"`
	Typo       bool `json:"typo"`
	Wrapper    bool `json:"wrapper"`
}

// StatusResult 返回公开状态。
func (s *Service) Status(shellOption, rcOverride string, explicit SnippetOverrides) Status {
	info := s.describe(shellOption, rcOverride, explicit)
	reason := info.RcError
	if reason == "" && info.Shell == "" {
		reason = "unsupported_shell"
	}
	return Status{
		OK:              info.Shell != "" && info.RcError == "",
		Reason:          reason,
		Shell:           info.Shell,
		RcFile:          info.RcFile,
		SnippetFile:     info.SnippetFile,
		RcExists:        info.RcExists,
		Installed:       info.Installed,
		UpToDate:        info.UpToDate,
		SnippetUpToDate: info.SnippetUpToDate,
		AihBinPath:      info.SnippetOptions.AihBinPath,
		Features: StatusFeatures{
			Completion: info.SnippetOptions.Completion,
			Typo:       info.SnippetOptions.Typo,
			Wrapper:    info.SnippetOptions.Wrapper,
		},
	}
}

// Plan 是 `aih shell plan` 的公开结果。
type Plan struct {
	OK             bool   `json:"ok"`
	Reason         string `json:"reason"`
	Shell          string `json:"shell"`
	RcFile         string `json:"rcFile"`
	SnippetFile    string `json:"snippetFile"`
	RcExists       bool   `json:"rcExists"`
	Installed      bool   `json:"installed"`
	UpToDate       bool   `json:"upToDate"`
	Content        string `json:"content"`
	SnippetContent string `json:"snippetContent"`
}

// PlanResult 计算将要写入的内容，不触碰磁盘。
func (s *Service) Plan(shellOption, rcOverride string, explicit SnippetOverrides) Plan {
	info := s.describe(shellOption, rcOverride, explicit)
	reason := info.RcError
	if reason == "" && info.Shell == "" {
		reason = "unsupported_shell"
	}
	return Plan{
		OK:             info.Shell != "" && info.RcError == "",
		Reason:         reason,
		Shell:          info.Shell,
		RcFile:         info.RcFile,
		SnippetFile:    info.SnippetFile,
		RcExists:       info.RcExists,
		Installed:      info.Installed,
		UpToDate:       info.UpToDate,
		Content:        info.SnippetStub,
		SnippetContent: info.Snippet,
	}
}

// ApplyResult 是单次写入的公开结果。
type ApplyResult struct {
	OK          bool   `json:"ok"`
	Changed     bool   `json:"changed,omitempty"`
	Shell       string `json:"shell,omitempty"`
	RcFile      string `json:"rcFile,omitempty"`
	SnippetFile string `json:"snippetFile,omitempty"`
	RcCreated   bool   `json:"rcCreated,omitempty"`
	BackupPath  string `json:"backupPath,omitempty"`
	ReloadHint  string `json:"reloadHint,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Error       string `json:"error,omitempty"`
	Detail      string `json:"detail,omitempty"`
}

// MarshalJSON 对齐历史结果的字段集合：成功时显式输出 rcCreated/backupPath
// （即使是 false/空串），已是最新时只输出 reason，错误时只输出错误相关字段。
func (r ApplyResult) MarshalJSON() ([]byte, error) {
	if r.OK && r.Error == "" {
		if r.Reason == "already_up_to_date" {
			return json.Marshal(struct {
				Shell       string `json:"shell"`
				OK          bool   `json:"ok"`
				Changed     bool   `json:"changed"`
				RcFile      string `json:"rcFile"`
				SnippetFile string `json:"snippetFile"`
				Reason      string `json:"reason"`
			}{r.Shell, r.OK, r.Changed, r.RcFile, r.SnippetFile, r.Reason})
		}
		return json.Marshal(struct {
			Shell       string `json:"shell"`
			OK          bool   `json:"ok"`
			Changed     bool   `json:"changed"`
			RcFile      string `json:"rcFile"`
			SnippetFile string `json:"snippetFile"`
			RcCreated   bool   `json:"rcCreated"`
			BackupPath  string `json:"backupPath"`
			ReloadHint  string `json:"reloadHint"`
		}{r.Shell, r.OK, r.Changed, r.RcFile, r.SnippetFile, r.RcCreated, r.BackupPath, r.ReloadHint})
	}
	return json.Marshal(struct {
		Shell       string `json:"shell,omitempty"`
		OK          bool   `json:"ok"`
		RcFile      string `json:"rcFile,omitempty"`
		SnippetFile string `json:"snippetFile,omitempty"`
		Error       string `json:"error,omitempty"`
		Detail      string `json:"detail,omitempty"`
	}{r.Shell, r.OK, r.RcFile, r.SnippetFile, r.Error, r.Detail})
}

func reloadHint(shell, rcFile string) string {
	if shell == "fish" {
		return "exec fish"
	}
	if shell == "powershell" {
		return ". '" + strings.ReplaceAll(rcFile, "'", "''") + "'"
	}
	return "source '" + strings.ReplaceAll(rcFile, "'", `'\''`) + "'"
}

func writeGeneratedFile(file, content string) error {
	snapshot, err := ReadSnapshot(file)
	if err != nil {
		return err
	}
	body := strings.TrimPrefix(content, "\uFEFF")
	bom := ""
	if strings.HasPrefix(content, "\uFEFF") {
		bom = "efbbbf"
	}
	_, err = WriteSnapshot(snapshot, body, "utf8", bom, false)
	return err
}

// Apply 写入片段与 rc 受管块。
func (s *Service) Apply(shellOption, rcOverride string, explicit SnippetOverrides, dryRun bool) ApplyResult {
	info := s.describe(shellOption, rcOverride, explicit)
	if info.Shell == "" {
		return ApplyResult{OK: false, Error: "unsupported_shell"}
	}
	if info.RcError != "" {
		return ApplyResult{OK: false, Error: "rc_read_failed", Detail: info.RcError, RcFile: info.RcFile}
	}
	if info.Installed && info.UpToDate {
		return ApplyResult{OK: true, Changed: false, Shell: info.Shell, RcFile: info.RcFile,
			SnippetFile: info.SnippetFile, Reason: "already_up_to_date"}
	}
	snapshot, err := ReadSnapshot(info.RcFile)
	if err != nil {
		return ApplyResult{OK: false, Error: "rc_read_failed", Detail: err.Error(), RcFile: info.RcFile}
	}
	next, err := ReplaceManagedBlock(snapshot.Text, info.SnippetStub)
	if err != nil {
		return ApplyResult{OK: false, Error: "rc_read_failed", Detail: err.Error(), RcFile: info.RcFile}
	}
	if dryRun {
		return ApplyResult{OK: true, Changed: true, Shell: info.Shell, RcFile: info.RcFile,
			SnippetFile: info.SnippetFile, RcCreated: !info.RcExists}
	}
	if err := writeGeneratedFile(info.SnippetFile, info.Snippet); err != nil {
		return ApplyResult{OK: false, Error: "snippet_write_failed", Detail: err.Error(), SnippetFile: info.SnippetFile}
	}
	backupPath, err := WriteSnapshot(snapshot, next, "", "", true)
	if err != nil {
		return ApplyResult{OK: false, Error: "rc_write_failed", Detail: err.Error(), RcFile: info.RcFile, SnippetFile: info.SnippetFile}
	}
	return ApplyResult{
		OK:          true,
		Changed:     true,
		Shell:       info.Shell,
		RcFile:      info.RcFile,
		SnippetFile: info.SnippetFile,
		RcCreated:   !info.RcExists,
		BackupPath:  backupPath,
		ReloadHint:  reloadHint(info.Shell, info.RcFile),
	}
}

// RemoveResult 是移除操作的公开结果。
type RemoveResult struct {
	OK                    bool   `json:"ok"`
	Removed               bool   `json:"removed"`
	Shell                 string `json:"shell,omitempty"`
	RcFile                string `json:"rcFile,omitempty"`
	SnippetFile           string `json:"snippetFile,omitempty"`
	SnippetFileRemoved    bool   `json:"snippetFileRemoved,omitempty"`
	BackupPath            string `json:"backupPath,omitempty"`
	Reason                string `json:"reason,omitempty"`
	Error                 string `json:"error,omitempty"`
	Detail                string `json:"detail,omitempty"`
	RetainedSharedSnippet string `json:"retainedSharedSnippet,omitempty"`
}

// MarshalJSON 对齐历史结果的字段集合：成功移除时显式输出 snippetFileRemoved，
// 未安装/rc 缺失时只输出原因，错误时保留已完成的移除事实。
func (r RemoveResult) MarshalJSON() ([]byte, error) {
	if r.OK && r.Removed {
		return json.Marshal(struct {
			Shell                 string `json:"shell"`
			OK                    bool   `json:"ok"`
			Removed               bool   `json:"removed"`
			RcFile                string `json:"rcFile"`
			SnippetFile           string `json:"snippetFile"`
			SnippetFileRemoved    bool   `json:"snippetFileRemoved"`
			BackupPath            string `json:"backupPath"`
			RetainedSharedSnippet string `json:"retainedSharedSnippet,omitempty"`
		}{r.Shell, r.OK, r.Removed, r.RcFile, r.SnippetFile, r.SnippetFileRemoved, r.BackupPath, r.RetainedSharedSnippet})
	}
	if r.OK {
		return json.Marshal(struct {
			Shell       string `json:"shell"`
			OK          bool   `json:"ok"`
			Removed     bool   `json:"removed"`
			RcFile      string `json:"rcFile"`
			SnippetFile string `json:"snippetFile,omitempty"`
			Reason      string `json:"reason"`
		}{r.Shell, r.OK, r.Removed, r.RcFile, r.SnippetFile, r.Reason})
	}
	return json.Marshal(struct {
		Shell       string `json:"shell,omitempty"`
		OK          bool   `json:"ok"`
		Removed     bool   `json:"removed,omitempty"`
		RcFile      string `json:"rcFile,omitempty"`
		SnippetFile string `json:"snippetFile,omitempty"`
		BackupPath  string `json:"backupPath,omitempty"`
		Error       string `json:"error,omitempty"`
		Detail      string `json:"detail,omitempty"`
	}{r.Shell, r.OK, r.Removed, r.RcFile, r.SnippetFile, r.BackupPath, r.Error, r.Detail})
}

// Remove 摘除 rc 受管块，并在能证明归属时删除独立片段文件。
func (s *Service) Remove(shellOption, rcOverride string) RemoveResult {
	shell, rcFile := s.ResolveTarget(shellOption, rcOverride)
	if shell == "" {
		return RemoveResult{OK: false, Error: "unsupported_shell"}
	}
	snapshot, err := ReadSnapshot(rcFile)
	if err != nil {
		return RemoveResult{OK: false, Error: "rc_read_failed", Detail: err.Error(), Shell: shell, RcFile: rcFile}
	}
	if !snapshot.Exists {
		return RemoveResult{OK: true, Removed: false, Shell: shell, RcFile: rcFile, Reason: "rc_missing"}
	}
	snippetFile := s.snippetFile(shell, rcFile)
	legacyFile := s.legacySnippetFile(shell)
	legacyBlock, _, blockErr := ReadManagedBlock(snapshot.Text)
	if blockErr != nil {
		return RemoveResult{OK: false, Error: "rc_read_failed", Detail: blockErr.Error(), Shell: shell, RcFile: rcFile}
	}
	sharedSnippet := ""
	if referencesSnippet(legacyBlock, shell, legacyFile) {
		sharedSnippet = legacyFile
	}
	next, removed, err := RemoveManagedBlock(snapshot.Text)
	if err != nil {
		return RemoveResult{OK: false, Error: "rc_read_failed", Detail: err.Error(), Shell: shell, RcFile: rcFile}
	}
	if !removed {
		return RemoveResult{OK: true, Removed: false, Shell: shell, RcFile: rcFile, SnippetFile: snippetFile, Reason: "not_installed"}
	}
	backupPath, err := WriteSnapshot(snapshot, next, "", "", true)
	if err != nil {
		return RemoveResult{OK: false, Error: "rc_write_failed", Detail: err.Error(), RcFile: rcFile, SnippetFile: snippetFile}
	}
	snippetRemoved := false
	if referencesSnippet(legacyBlock, shell, snippetFile) {
		if err := os.Remove(snippetFile); err != nil && !os.IsNotExist(err) {
			return RemoveResult{OK: false, Removed: true, Error: "snippet_remove_failed", Detail: err.Error(),
				Shell: shell, RcFile: rcFile, SnippetFile: snippetFile, BackupPath: backupPath}
		} else if err == nil {
			snippetRemoved = true
		}
	}
	result := RemoveResult{
		OK:                 true,
		Removed:            true,
		Shell:              shell,
		RcFile:             rcFile,
		SnippetFile:        snippetFile,
		SnippetFileRemoved: snippetRemoved,
		BackupPath:         backupPath,
	}
	if sharedSnippet != "" {
		result.RetainedSharedSnippet = sharedSnippet
	}
	return result
}

// SnippetResult 是 `aih shell snippet` 的公开结果。
type SnippetResult struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Shell   string `json:"shell,omitempty"`
	Content string `json:"content,omitempty"`
}

// Snippet 生成指定 shell 的片段，不读取/写入任何文件。
func (s *Service) Snippet(shellOption, rcOverride string, explicit SnippetOverrides) SnippetResult {
	shell, _ := s.ResolveTarget(shellOption, rcOverride)
	if shell == "" {
		return SnippetResult{OK: false, Error: "unsupported_shell"}
	}
	content, ok := Snippet(shell, ResolveSnippetOptions(SnippetOverrides{}, explicit))
	if !ok {
		return SnippetResult{OK: false, Error: "unsupported_shell"}
	}
	return SnippetResult{OK: true, Shell: shell, Content: content}
}
