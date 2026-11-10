package webuigitapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// gitTimeout 与 Node 的 DEFAULT_TIMEOUT_MS 一致。
	gitTimeout = 8 * time.Second
	// maxGitOutputBytes 与 Node 的 MAX_OUTPUT_BYTES 一致：stdout 与 stderr 共享同一份预算。
	maxGitOutputBytes = 2 * 1024 * 1024
)

// 子进程失败的错误码：直接作为响应里的 error 字段。
//
// git_not_found 是 Node 没有单独命名的一类（Node 会把 spawn 的 ENOENT 原样透出），
// 这里给它一个稳定码，避免把 errno 当契约。
const (
	codeGitTimeout  = "git_timeout"
	codeGitFailed   = "git_failed"
	codeGitNotFound = "git_not_found"
)

// gitFailure 是 git 子进程失败。
type gitFailure struct {
	code    string
	message string
}

func (failure *gitFailure) Error() string { return failure.code + ": " + failure.message }

// gitResult 是一次 git 子进程的退出结果。
type gitResult struct {
	stdout    string
	stderr    string
	exitCode  int
	truncated bool
}

// gitRunner 是 git 子进程执行端口：root 由调用方保证已通过包含校验。
// allowFailure 为 true 时非零退出码不算错误（对应 Node 的 allowFailure）。
type gitRunner func(ctx context.Context, root string, args []string, allowFailure bool) (gitResult, error)

// runGit 是 gitRunner 的生产实现：直接 exec，不经过 shell，参数按数组传入。
func runGit(ctx context.Context, root string, args []string, allowFailure bool) (gitResult, error) {
	commandContext, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()

	arguments := make([]string, 0, len(args)+3)
	arguments = append(arguments, "-C", root, "--no-optional-locks")
	arguments = append(arguments, args...)

	command := exec.CommandContext(commandContext, "git", arguments...)
	command.Env = gitEnvironment()
	output := &gitOutput{remaining: maxGitOutputBytes}
	command.Stdout = output.writer(false)
	command.Stderr = output.writer(true)

	runErr := command.Run()
	stdout, stderr, truncated := output.snapshot()
	result := gitResult{stdout: stdout, stderr: stderr, truncated: truncated}
	if runErr == nil {
		return result, nil
	}

	var exitError *exec.ExitError
	if !errors.As(runErr, &exitError) {
		return result, &gitFailure{code: codeGitNotFound, message: runErr.Error()}
	}
	result.exitCode = exitError.ExitCode()
	if errors.Is(commandContext.Err(), context.DeadlineExceeded) {
		// 超时一律失败，与 Node 一致：allowFailure 只放宽退出码，不放宽超时。
		return result, &gitFailure{code: codeGitTimeout, message: "git 命令超时"}
	}
	if allowFailure {
		return result, nil
	}
	message := strings.TrimSpace(result.stderr)
	if message == "" {
		message = fmt.Sprintf("git 退出码 %d", result.exitCode)
	}
	return result, &gitFailure{code: codeGitFailed, message: message}
}

// gitEnvironment 对应 Node 的子进程环境：关掉分页器与交互提示，固定 C locale，
// 保证 porcelain 输出不随宿主语言变化。
func gitEnvironment() []string {
	overrides := map[string]string{
		"GIT_PAGER":           "cat",
		"GIT_TERMINAL_PROMPT": "0",
		"LC_ALL":              "C",
	}
	environment := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, overridden := overrides[name]; overridden {
			continue
		}
		environment = append(environment, entry)
	}
	for name, value := range overrides {
		environment = append(environment, name+"="+value)
	}
	return environment
}

// gitOutput 把 stdout / stderr 收进同一份字节预算。
//
// 超限后继续读并丢弃，而不是提前关闭管道：否则子进程会因为写不进管道被阻塞，
// 变成一次看起来像超时的假故障。
type gitOutput struct {
	lock      sync.Mutex
	remaining int
	truncated bool
	stdout    bytes.Buffer
	stderr    bytes.Buffer
}

type gitOutputWriter struct {
	output *gitOutput
	stderr bool
}

func (output *gitOutput) writer(stderr bool) gitOutputWriter {
	return gitOutputWriter{output: output, stderr: stderr}
}

// Write 永远返回 len(chunk)：丢弃的部分已经记在 truncated 上，
// 不能让 io.Copy 把它当成写失败。
func (writer gitOutputWriter) Write(chunk []byte) (int, error) {
	output := writer.output
	output.lock.Lock()
	defer output.lock.Unlock()
	if output.remaining <= 0 {
		output.truncated = true
		return len(chunk), nil
	}
	accepted := chunk
	if len(accepted) > output.remaining {
		accepted = accepted[:output.remaining]
		output.truncated = true
	}
	output.remaining -= len(accepted)
	if writer.stderr {
		output.stderr.Write(accepted)
	} else {
		output.stdout.Write(accepted)
	}
	return len(chunk), nil
}

func (output *gitOutput) snapshot() (string, string, bool) {
	output.lock.Lock()
	defer output.lock.Unlock()
	return output.stdout.String(), output.stderr.String(), output.truncated
}

// getSummary 对应 Node 的 getGitSummary。
//
// status / branch / upstream 互不依赖，并发执行（Node 用 Promise.all）；
// rev-list 依赖 upstream 的解析结果，只能串行跟在后面。
func getSummary(ctx context.Context, runner gitRunner, root string) (summaryResponse, error) {
	var statusResult, branchResult, upstreamResult gitResult
	var statusErr, branchErr, upstreamErr error

	var waitGroup sync.WaitGroup
	waitGroup.Add(3)
	go func() {
		defer waitGroup.Done()
		statusResult, statusErr = runner(ctx, root, []string{"status", "--porcelain=v1", "-z"}, false)
	}()
	go func() {
		defer waitGroup.Done()
		branchResult, branchErr = runner(ctx, root, []string{"branch", "--show-current"}, false)
	}()
	go func() {
		defer waitGroup.Done()
		upstreamResult, upstreamErr = runner(ctx, root, []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"}, true)
	}()
	waitGroup.Wait()

	if statusErr != nil {
		return summaryResponse{}, statusErr
	}
	if branchErr != nil {
		return summaryResponse{}, branchErr
	}
	if upstreamErr != nil {
		return summaryResponse{}, upstreamErr
	}
	if statusResult.truncated {
		// Node 会静默丢掉超出预算的记录，返回一份看起来完整、实际缺项的清单；
		// 宁可明确失败，也不让前端把残缺状态当成工作区全貌。
		return summaryResponse{}, &gitFailure{
			code:    codeGitOutputTooLarge,
			message: "Git 工作区状态超过 2MB，无法给出完整变更清单",
		}
	}

	view := summaryResponse{
		OK:     true,
		Branch: strings.TrimSpace(branchResult.stdout),
		Files:  parsePorcelain(statusResult.stdout),
	}
	if view.Branch == "" {
		view.Branch = "HEAD"
	}
	if upstreamResult.exitCode == 0 {
		view.Upstream = strings.TrimSpace(upstreamResult.stdout)
	}
	if view.Upstream != "" {
		counts, err := runner(ctx, root, []string{"rev-list", "--left-right", "--count", "HEAD...@{upstream}"}, true)
		if err != nil {
			return summaryResponse{}, err
		}
		if counts.exitCode == 0 {
			view.Ahead, view.Behind = parseAheadBehind(counts.stdout)
		}
	}
	return view, nil
}

// parsePorcelain 对应 Node 的 parsePorcelain（porcelain=v1 -z）。
//
// -z 下记录以 NUL 分隔；重命名/复制记录后面紧跟一条独立记录，内容是原路径。
// untracked 记录是 "?? path"，所以 Node 口径下 untracked 文件同时满足 unstaged
// （y !== ' '），这里照抄，不改语义。
func parsePorcelain(output string) []fileView {
	raw := strings.Split(output, "\x00")
	records := make([]string, 0, len(raw))
	for _, record := range raw {
		if record != "" {
			records = append(records, record)
		}
	}

	files := make([]fileView, 0, len(records))
	for index := 0; index < len(records); index++ {
		record := records[index]
		x, y := byte(' '), byte(' ')
		if len(record) > 0 {
			x = record[0]
		}
		if len(record) > 1 {
			y = record[1]
		}
		filePath := ""
		if len(record) > 3 {
			filePath = record[3:]
		}
		oldPath := ""
		if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
			index++
			if index < len(records) {
				oldPath = records[index]
			}
		}
		files = append(files, fileView{
			Path:      filePath,
			OldPath:   oldPath,
			Staged:    x != ' ' && x != '?',
			Unstaged:  y != ' ',
			Untracked: x == '?' && y == '?',
			Status:    string([]byte{x, y}),
		})
	}
	return files
}

// parseAheadBehind 解析 rev-list --left-right --count 的 "<ahead>\t<behind>"。
// 解析不出来时按 0 处理，与 Node 的 Number.isFinite 兜底一致。
func parseAheadBehind(output string) (int, int) {
	fields := strings.Fields(strings.TrimSpace(output))
	ahead, behind := 0, 0
	if len(fields) > 0 {
		if value, err := strconv.Atoi(fields[0]); err == nil {
			ahead = value
		}
	}
	if len(fields) > 1 {
		if value, err := strconv.Atoi(fields[1]); err == nil {
			behind = value
		}
	}
	return ahead, behind
}

// getDiff 对应 Node 的 getGitDiff。
func getDiff(ctx context.Context, runner gitRunner, root, filePath string, staged bool) (diffResponse, error) {
	arguments := []string{"diff", "--no-ext-diff", "--no-color", "--unified=3"}
	if staged {
		arguments = append(arguments, "--cached")
	}
	// "--" 之后一律按路径解释，文件名以 "-" 开头也不会被当成选项。
	arguments = append(arguments, "--", filePath)

	result, err := runner(ctx, root, arguments, false)
	if err != nil {
		return diffResponse{}, err
	}
	return diffResponse{OK: true, Path: filePath, Content: result.stdout, Truncated: result.truncated}, nil
}
