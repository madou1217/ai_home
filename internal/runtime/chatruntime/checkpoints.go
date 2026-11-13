package chatruntime

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const checkpointRefRoot = "refs/aih/checkpoints"

var (
	safeCheckpointSegRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
	checkpointCommitRegex  = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	checkpointSnapRegex    = regexp.MustCompile(`AIH_CKPT ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([01])`)
	checkpointRefRegex     = regexp.MustCompile(`^AIH_REF (\S+) ([0-9a-f]{40,64}) (\d+) ?(.*)$`)
)

// CheckpointScriptResult 表示一次本机或远端 sh 脚本执行结果。
type CheckpointScriptResult struct {
	Code   int
	Stdout string
	Stderr string
}

// CheckpointRunner 抽象本机 child_process 与远端 SSH git plumbing 执行面。
type CheckpointRunner interface {
	Kind() string
	Run(ctx context.Context, script string) (CheckpointScriptResult, error)
}

// WorkspaceCheckpointsOpener 按 projectPath 解析检查点管理器，返回 nil 表示不可用。
type WorkspaceCheckpointsOpener func(ctx context.Context, projectPath string) (*WorkspaceCheckpoints, error)

// CheckpointSnapshotResult 对应 workspace-checkpoints.js snapshot() 返回。
type CheckpointSnapshotResult struct {
	Commit  string `json:"commit,omitempty"`
	Tree    string `json:"tree,omitempty"`
	Reused  bool   `json:"reused,omitempty"`
	Skipped string `json:"skipped,omitempty"`
}

// CheckpointEntry 对应一条检查点 ref 记录。
type CheckpointEntry struct {
	Ref       string `json:"ref"`
	Commit    string `json:"commit"`
	CreatedAt int64  `json:"createdAt"`
	Label     string `json:"label"`
}

// CheckpointListResult 对应 list() 响应载荷。
type CheckpointListResult struct {
	Skipped     string            `json:"skipped,omitempty"`
	Checkpoints []CheckpointEntry `json:"checkpoints"`
}

// CheckpointChangedFile 描述恢复检查点会影响的单个工作区文件。
type CheckpointChangedFile struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

// CheckpointChangesResult 对应 changes() 响应载荷。
type CheckpointChangesResult struct {
	Skipped string                  `json:"skipped,omitempty"`
	Files   []CheckpointChangedFile `json:"files"`
}

// CheckpointRestoreResult 对应 restore() 响应载荷。
type CheckpointRestoreResult struct {
	Skipped    string `json:"skipped,omitempty"`
	Restored   string `json:"restored,omitempty"`
	PreRestore string `json:"preRestore,omitempty"`
}

// WorkspaceCheckpoints 通过 git plumbing refs/aih/checkpoints/* 提供无侵入快照与回滚。
type WorkspaceCheckpoints struct {
	runner CheckpointRunner
}

// NewWorkspaceCheckpoints 构造检查点控制器。
func NewWorkspaceCheckpoints(runner CheckpointRunner) *WorkspaceCheckpoints {
	if runner == nil {
		return nil
	}
	return &WorkspaceCheckpoints{runner: runner}
}

// OpenWorkspaceCheckpoints 按 projectPath 打开本机或 SSH 远程检查点管理器；非目录或无远程配置返回 nil。
func OpenWorkspaceCheckpoints(ctx context.Context, aiHomeDir, hostHomeDir, projectPath string, remoteDial webuiremoteworkspace.DialFunc) (*WorkspaceCheckpoints, error) {
	trimmed := strings.TrimSpace(projectPath)
	if trimmed == "" {
		return nil, nil
	}
	if wsID := webuiremoteworkspace.WorkspaceIDFromProjectPath(aiHomeDir, trimmed); wsID != "" {
		ws, found, err := webuiremoteworkspace.FindWorkspace(ctx, aiHomeDir, wsID)
		if err != nil || !found {
			return nil, err
		}
		if remoteDial == nil {
			remoteDial = defaultRemoteCheckpointDialer
		}
		return NewWorkspaceCheckpoints(&remoteCheckpointRunner{
			aiHomeDir:   aiHomeDir,
			hostHomeDir: hostHomeDir,
			workspace:   ws,
			dial:        remoteDial,
		}), nil
	}
	info, err := os.Stat(trimmed)
	if err != nil || !info.IsDir() {
		return nil, nil
	}
	return NewWorkspaceCheckpoints(&localCheckpointRunner{projectPath: trimmed}), nil
}

// DefaultWorkspaceCheckpointsOpener 返回适配 Service 的默认 opener。
func DefaultWorkspaceCheckpointsOpener(aiHomeDir, hostHomeDir string, remoteDial webuiremoteworkspace.DialFunc) WorkspaceCheckpointsOpener {
	return func(ctx context.Context, projectPath string) (*WorkspaceCheckpoints, error) {
		return OpenWorkspaceCheckpoints(ctx, aiHomeDir, hostHomeDir, projectPath, remoteDial)
	}
}

func defaultRemoteCheckpointDialer(ctx context.Context, conn webuiremoteworkspace.Connection, hostHomeDir string) (webuiremoteworkspace.SessionRunner, error) {
	cfg, err := webuiremoteworkspace.ToSSHConfig(conn, hostHomeDir)
	if err != nil {
		return nil, err
	}
	return sshremote.Dial(ctx, cfg, 15*time.Second)
}

type localCheckpointRunner struct {
	projectPath string
}

func (r *localCheckpointRunner) Kind() string { return "local" }

func (r *localCheckpointRunner) Run(ctx context.Context, script string) (CheckpointScriptResult, error) {
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Dir = r.projectPath
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			return CheckpointScriptResult{}, err
		}
	}
	return CheckpointScriptResult{
		Code:   exitCode,
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}, nil
}

type remoteCheckpointRunner struct {
	aiHomeDir   string
	hostHomeDir string
	workspace   webuiremoteworkspace.WorkspaceRecord
	dial        webuiremoteworkspace.DialFunc
}

func (r *remoteCheckpointRunner) Kind() string { return "remote" }

func (r *remoteCheckpointRunner) Run(ctx context.Context, script string) (CheckpointScriptResult, error) {
	conn, found, err := webuiremoteworkspace.LoadConnection(ctx, r.aiHomeDir, r.workspace.ConnectionID)
	if err != nil {
		return CheckpointScriptResult{}, err
	}
	if !found {
		return CheckpointScriptResult{}, NewError("workspace_connection_not_found", http.StatusNotFound, nil)
	}
	sessionRunner, err := r.dial(ctx, conn, r.hostHomeDir)
	if err != nil {
		return CheckpointScriptResult{}, err
	}
	defer func() { _ = sessionRunner.Close() }()

	detectRes, err := sessionRunner.Run(ctx, webuiremoteworkspace.DetectCommand, webuiremoteworkspace.DefaultCommandLimit)
	if err != nil {
		return CheckpointScriptResult{}, err
	}
	dialect, ok := webuiremoteworkspace.ParseDetectOutput(string(detectRes.Stdout))
	if !ok || dialect != webuiremoteworkspace.DialectPOSIX {
		return CheckpointScriptResult{}, NewError("workspace_checkpoints_unsupported_remote_os", http.StatusConflict, nil)
	}
	wrapped := "cd " + checkpointShQuote(r.workspace.RemoteRoot) + " && sh -c " + checkpointShQuote(script)
	res, err := sessionRunner.Run(ctx, wrapped, 4<<20)
	if err != nil {
		return CheckpointScriptResult{}, err
	}
	return CheckpointScriptResult{
		Code:   res.Code,
		Stdout: string(res.Stdout),
		Stderr: string(res.Stderr),
	}, nil
}

func checkpointShQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func checkpointSessionSegment(sessionID string) (string, error) {
	var b strings.Builder
	for _, r := range sessionID {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
		if b.Len() >= 96 {
			break
		}
	}
	seg := b.String()
	if !safeCheckpointSegRegex.MatchString(seg) {
		return "", ErrInvalid("invalid_session_id")
	}
	return seg, nil
}

const checkpointPrelude = `command -v git >/dev/null 2>&1 || { echo AIH_NO_GIT; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo AIH_NO_REPO; exit 0; }
cd "$top" || exit 3
gitdir=$(git rev-parse --absolute-git-dir) || exit 4
tmp="$gitdir/aih-ckpt-index.$$"
trap 'rm -f "$tmp" "$tmp.lock"' EXIT
if [ -f "$gitdir/index" ]; then cp -p "$gitdir/index" "$tmp" 2>/dev/null || rm -f "$tmp"; else rm -f "$tmp"; fi
export GIT_INDEX_FILE="$tmp"
export GIT_AUTHOR_NAME=aih GIT_AUTHOR_EMAIL=aih@localhost GIT_COMMITTER_NAME=aih GIT_COMMITTER_EMAIL=aih@localhost`

func buildCheckpointSnapshotScript(seg, label string) string {
	refPrefix := checkpointShQuote(checkpointRefRoot + "/" + seg + "/")
	return checkpointPrelude + fmt.Sprintf(`
git add -A -- . >/dev/null 2>&1 || exit 5
tree=$(git write-tree) || exit 6
last=$(git for-each-ref --sort=-creatordate --count=1 --format='%%(objectname)' %s)
if [ -n "$last" ] && [ "$(git rev-parse "$last^{tree}" 2>/dev/null)" = "$tree" ]; then echo "AIH_CKPT $last $tree 1"; exit 0; fi
parent=$(git rev-parse -q --verify HEAD 2>/dev/null)
commit=$(printf '%%s\n' %s | git commit-tree "$tree" ${parent:+-p "$parent"}) || exit 7
seq=$(date +%%s)$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' ')
git update-ref %s"$seq" "$commit" || exit 8
echo "AIH_CKPT $commit $tree 0"`, refPrefix, checkpointShQuote(label), refPrefix)
}

func buildCheckpointListScript(seg string) string {
	refPrefix := checkpointShQuote(checkpointRefRoot + "/" + seg + "/")
	return checkpointPrelude + fmt.Sprintf(`
git for-each-ref --sort=-creatordate --format='AIH_REF %%(refname) %%(objectname) %%(creatordate:unix) %%(subject)' %s`, refPrefix)
}

func buildCheckpointDiffScript(commit string) string {
	quotedTree := checkpointShQuote(commit) + "^{tree}"
	return checkpointPrelude + fmt.Sprintf(`
git add -A -- . >/dev/null 2>&1 || exit 5
now=$(git write-tree) || exit 6
echo AIH_DIFF
git diff-tree -r --name-status %s "$now"`, quotedTree)
}

func buildCheckpointRestoreScript(commit string) string {
	quotedTree := checkpointShQuote(commit) + "^{tree}"
	return checkpointPrelude + fmt.Sprintf(`
git cat-file -e %s 2>/dev/null || { echo AIH_NO_CHECKPOINT; exit 0; }
git add -A -- . >/dev/null 2>&1 || exit 5
now=$(git write-tree) || exit 6
git diff-tree -r --diff-filter=A --name-only -z %s "$now" | xargs -0 rm -f -- 2>/dev/null
git read-tree %s || exit 9
git checkout-index -a -f || exit 10
GIT_INDEX_FILE="$gitdir/index" git update-index -q --refresh >/dev/null 2>&1
echo AIH_RESTORED`, quotedTree, quotedTree, quotedTree)
}

func parseCheckpointMarker(stdout string) string {
	if strings.Contains(stdout, "AIH_NO_GIT") {
		return "git_not_installed"
	}
	if strings.Contains(stdout, "AIH_NO_REPO") {
		return "not_a_git_repository"
	}
	return ""
}

func checkpointFailure(res CheckpointScriptResult, code string) error {
	detail := strings.TrimSpace(res.Stderr)
	if detail == "" {
		detail = strings.TrimSpace(res.Stdout)
	}
	if len(detail) > 400 {
		detail = detail[len(detail)-400:]
	}
	if detail == "" {
		detail = fmt.Sprintf("%s (exit %d)", code, res.Code)
	}
	return &Error{
		Code:       code,
		StatusCode: http.StatusInternalServerError,
		Message:    detail,
	}
}

// Kind 返回检查点执行面类型（local/remote）。
func (c *WorkspaceCheckpoints) Kind() string {
	if c == nil || c.runner == nil {
		return ""
	}
	return c.runner.Kind()
}

// Snapshot 拍一张工作区快照，未变动则复用上一检查点，非 git 仓库返回 skipped。
func (c *WorkspaceCheckpoints) Snapshot(ctx context.Context, sessionID, label string) (*CheckpointSnapshotResult, error) {
	if c == nil || c.runner == nil {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	seg, err := checkpointSessionSegment(sessionID)
	if err != nil {
		return nil, err
	}
	trimmedLabel := strings.TrimSpace(label)
	if trimmedLabel == "" {
		trimmedLabel = "aih checkpoint"
	}
	res, err := c.runner.Run(ctx, buildCheckpointSnapshotScript(seg, trimmedLabel))
	if err != nil {
		return nil, err
	}
	if skipped := parseCheckpointMarker(res.Stdout); skipped != "" {
		return &CheckpointSnapshotResult{Skipped: skipped}, nil
	}
	m := checkpointSnapRegex.FindStringSubmatch(res.Stdout)
	if res.Code != 0 || len(m) < 4 {
		return nil, checkpointFailure(res, "checkpoint_failed")
	}
	return &CheckpointSnapshotResult{
		Commit: m[1],
		Tree:   m[2],
		Reused: m[3] == "1",
	}, nil
}

// List 列出某会话的全部检查点（按创建时间倒序）。
func (c *WorkspaceCheckpoints) List(ctx context.Context, sessionID string) (*CheckpointListResult, error) {
	if c == nil || c.runner == nil {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	seg, err := checkpointSessionSegment(sessionID)
	if err != nil {
		return nil, err
	}
	res, err := c.runner.Run(ctx, buildCheckpointListScript(seg))
	if err != nil {
		return nil, err
	}
	if skipped := parseCheckpointMarker(res.Stdout); skipped != "" {
		return &CheckpointListResult{Skipped: skipped, Checkpoints: []CheckpointEntry{}}, nil
	}
	if res.Code != 0 {
		return nil, checkpointFailure(res, "checkpoint_list_failed")
	}
	entries := make([]CheckpointEntry, 0)
	for _, rawLine := range strings.Split(string(res.Stdout), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		m := checkpointRefRegex.FindStringSubmatch(line)
		if len(m) < 5 {
			continue
		}
		sec, _ := strconv.ParseInt(m[3], 10, 64)
		entries = append(entries, CheckpointEntry{
			Ref:       m[1],
			Commit:    m[2],
			CreatedAt: sec * 1000,
			Label:     m[4],
		})
	}
	return &CheckpointListResult{Checkpoints: entries}, nil
}

// Changes 列出指定检查点相对于当前工作区的改动文件。
func (c *WorkspaceCheckpoints) Changes(ctx context.Context, commit string) (*CheckpointChangesResult, error) {
	if c == nil || c.runner == nil {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	if !checkpointCommitRegex.MatchString(commit) {
		return nil, ErrInvalid("invalid_checkpoint")
	}
	res, err := c.runner.Run(ctx, buildCheckpointDiffScript(commit))
	if err != nil {
		return nil, err
	}
	if skipped := parseCheckpointMarker(res.Stdout); skipped != "" {
		return &CheckpointChangesResult{Skipped: skipped, Files: []CheckpointChangedFile{}}, nil
	}
	if res.Code != 0 {
		return nil, checkpointFailure(res, "checkpoint_diff_failed")
	}
	idx := strings.Index(string(res.Stdout), "AIH_DIFF\n")
	body := ""
	if idx >= 0 {
		body = res.Stdout[idx+len("AIH_DIFF\n"):]
	}
	files := make([]CheckpointChangedFile, 0)
	for _, line := range strings.Split(body, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		status := ""
		if len(parts[0]) > 0 {
			status = parts[0][:1]
		}
		filePath := ""
		if len(parts) > 1 {
			filePath = strings.Join(parts[1:], "\t")
		}
		files = append(files, CheckpointChangedFile{Status: status, Path: filePath})
	}
	return &CheckpointChangesResult{Files: files}, nil
}

// Restore 先对当前工作区拍 pre-restore 检查点，再恢复到指定检查点。
func (c *WorkspaceCheckpoints) Restore(ctx context.Context, sessionID, commit string) (*CheckpointRestoreResult, error) {
	if c == nil || c.runner == nil {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	if !checkpointCommitRegex.MatchString(commit) {
		return nil, ErrInvalid("invalid_checkpoint")
	}
	before, err := c.Snapshot(ctx, sessionID, "aih pre-restore")
	if err != nil {
		return nil, err
	}
	if before.Skipped != "" {
		return &CheckpointRestoreResult{Skipped: before.Skipped}, nil
	}
	res, err := c.runner.Run(ctx, buildCheckpointRestoreScript(commit))
	if err != nil {
		return nil, err
	}
	if strings.Contains(string(res.Stdout), "AIH_NO_CHECKPOINT") {
		return nil, NewError("checkpoint_not_found", http.StatusNotFound, nil)
	}
	if res.Code != 0 || !strings.Contains(string(res.Stdout), "AIH_RESTORED") {
		return nil, checkpointFailure(res, "checkpoint_restore_failed")
	}
	return &CheckpointRestoreResult{
		Restored:   commit,
		PreRestore: before.Commit,
	}, nil
}
