package chatruntime

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

// sendNativeRunEvent 保留背压，但消费者取消后不能把 producer 永久留在发送处。
func sendNativeRunEvent(ctx context.Context, events chan<- NativeRunEvent, event NativeRunEvent) bool {
	select {
	case <-ctx.Done():
		return false
	default:
	}
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func startNativeStreamProcess(
	ctx context.Context,
	req NativeRunRequest,
	binPath string,
	args []string,
	workDir string,
	launchCleanup func(),
) (_ *NativeRunHandle, startErr error) {
	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, binPath, args...)
	cmd.Dir = workDir
	cmd.Env = os.Environ()
	cmd.WaitDelay = nativeStreamErrorSettleTimeout

	input := &claudeStreamInput{}
	usesStreamJSON := sessionchat.ClaudeUsesStreamJSONInput(req.Provider, false, runtime.GOOS)
	var stdout, stdoutWriter, stderr, stderrWriter *os.File
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			input.close()
			for _, file := range []*os.File{stdout, stdoutWriter, stderr, stderrWriter} {
				if file != nil {
					_ = file.Close()
				}
			}
			launchCleanup()
			cancel()
		})
	}
	defer func() {
		if startErr != nil {
			cleanup()
		}
	}()

	if usesStreamJSON {
		var err error
		input.stdin, err = cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
	}
	// 自己持有读端，避免并发 Wait 关闭 StdoutPipe 丢掉已退出进程的尾帧。
	var err error
	stdout, stdoutWriter, err = os.Pipe()
	if err != nil {
		return nil, err
	}
	stderr, stderrWriter, err = os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = stdoutWriter, stderrWriter
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()

	eventsCh := make(chan NativeRunEvent, 64)
	sidsCh := make(chan string, 4)
	doneCh := make(chan NativeRunExit, 1)
	producerDone := make(chan struct{})
	processDone := make(chan struct{})
	var waitErr error
	var closeOutputsOnce sync.Once
	closeOutputs := func() {
		closeOutputsOnce.Do(func() {
			_ = stdout.Close()
			_ = stderr.Close()
		})
	}
	var abortOnce sync.Once
	abort := func() {
		abortOnce.Do(func() {
			input.abort()
			cancel()
			_ = cmd.Process.Kill()
			// 必须关管道：CLI/MCP 后代持有写端时，仅 kill 直接子进程不保证 EOF。
			closeOutputs()
		})
	}
	stopCancellation := context.AfterFunc(runCtx, abort)
	go func() {
		waitErr = cmd.Wait()
		// 子进程已退出但后代仍持有写端时，限制真正阻塞的 Read；不能用定时 Close
		// 把慢消费者的正常背压误当成孤儿管道。每次后续读取都会刷新读期限。
		deadline := time.Now().Add(nativeStreamErrorSettleTimeout)
		_ = stdout.SetReadDeadline(deadline)
		_ = stderr.SetReadDeadline(deadline)
		close(processDone)
	}()

	go func() {
		defer close(producerDone)
		defer close(doneCh)
		defer cleanup()
		defer stopCancellation()

		var stderrText string
		stderrDone := make(chan struct{})
		go func() {
			defer close(stderrDone)
			// stderr 只有有限诊断价值，进程退出后使用固定期限，不因后代持续输出延长。
			stderrText = readNativeStderr(stderr)
		}()

		state := &NativeStreamState{}
		scanner := bufio.NewScanner(nativeProcessReader{file: stdout, processDone: processDone})
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		expectedKill := false
		terminalDelivered := false
		var streamErr error
	readLoop:
		for scanner.Scan() {
			for _, chunk := range ParseNativeStreamLine(req.Provider, scanner.Text(), state) {
				if chunk.Type == "session-created" && chunk.SessionID != "" {
					select {
					case sidsCh <- chunk.SessionID:
					default:
					}
					continue
				}
				// 先决定接收边界，再投递 result；否则背压期间的新 steer 会落到已结束的轮次。
				terminal := false
				if usesStreamJSON && (chunk.Type == "result" || chunk.ClaudeResultError) {
					terminal = input.result(chunk.ClaudeResultError)
				}
				if terminal || chunk.ClaudeResultError {
					input.close()
					if killErr := cmd.Process.Kill(); killErr == nil && input.expectedExit() {
						expectedKill = true
					}
				}
				if !sendNativeRunEvent(runCtx, eventsCh, NativeRunEvent{
					Type: chunk.Type, Delta: chunk.Delta, Thinking: chunk.Thinking,
					Content: chunk.Content, Message: chunk.Message, Usage: chunk.Usage,
				}) {
					abort()
					break readLoop
				}
				if terminal || chunk.ClaudeResultError {
					terminalDelivered = true
					// 最后一个 result 已交付，之后不再接受新的轮次或依赖 stdout EOF。
					break readLoop
				}
			}
		}
		streamErr = scanner.Err()
		if streamErr != nil {
			abort()
		}
		input.close()
		// stdout 已结束但进程仍不退出也不能无限等待。
		exitTimer := time.NewTimer(nativeStreamErrorSettleTimeout)
		select {
		case <-processDone:
		case <-runCtx.Done():
			abort()
			<-processDone
		case <-exitTimer.C:
			streamErr = errors.New("native_process_exit_timeout")
			abort()
			<-processDone
		}
		exitTimer.Stop()
		<-stderrDone

		finalErr := waitErr
		var exitErr *exec.ExitError
		if terminalDelivered && expectedKill && input.expectedExit() && errors.As(waitErr, &exitErr) {
			// 只归零本次主动 Kill 的 SIGKILL；其他信号或非零退出状态仍按失败结算。
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() && status.Signal() == syscall.SIGKILL {
				finalErr = nil
			}
		}
		if streamErr != nil && !errors.Is(streamErr, os.ErrClosed) {
			finalErr = streamErr
		} else if runCtx.Err() != nil && !(terminalDelivered && input.expectedExit()) {
			finalErr = runCtx.Err()
		} else if streamErr != nil {
			finalErr = streamErr
		}
		if finalErr == nil && usesStreamJSON && input.incomplete() {
			finalErr = NewError("native_stream_incomplete", http.StatusBadGateway, nil)
		}
		exitCode := 0
		if finalErr != nil {
			exitCode = 1
			if errors.As(finalErr, &exitErr) {
				exitCode = exitErr.ExitCode()
			}
		}
		// 先关闭事件通道；Done 后不再依赖消费者或 stdin 才能完成清理。
		stopCancellation()
		cleanup()
		close(eventsCh)
		close(sidsCh)
		doneCh <- NativeRunExit{ExitCode: exitCode, SessionID: state.SessionID, Stderr: stderrText, Err: finalErr}
	}()

	if usesStreamJSON {
		images := make([]sessionchat.ImageAttachment, 0, len(req.ImagePaths))
		for _, path := range req.ImagePaths {
			raw, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			images = append(images, sessionchat.ImageAttachment{
				MediaType: sessionchat.DetectImageMediaType(path), Base64: base64.StdEncoding.EncodeToString(raw),
			})
		}
		if err := input.write(runCtx, sessionchat.BuildClaudeStreamJSONUserMessage(req.Prompt, images)); err != nil {
			abort()
			<-producerDone
			return nil, err
		}
	}
	return &NativeRunHandle{
		RunID: req.RunID,
		WriteSteer: func(content string) error {
			if !usesStreamJSON {
				return NewError("native_steer_unsupported", http.StatusConflict, nil)
			}
			err := input.steer(runCtx, content)
			if err != nil && input.writeFailed() {
				abort()
			}
			return err
		},
		Abort:  func() error { abort(); return nil },
		Events: eventsCh, SessionIDs: sidsCh, Done: doneCh,
	}, nil
}

// readNativeStderr 持续排空 stderr，只保留有限诊断，超长单行也不停止读取。
func readNativeStderr(reader io.Reader) string {
	const limit = 64 * 1024
	var text strings.Builder
	buffer := make([]byte, 16*1024)
	for {
		n, err := reader.Read(buffer)
		if n > 0 && text.Len() < limit {
			text.Write(buffer[:min(n, limit-text.Len())])
		}
		if err != nil {
			return text.String()
		}
	}
}

// nativeProcessReader 在已退出进程的每次实际读取上应用空闲上限；事件背压不计入该等待。
type nativeProcessReader struct {
	file        *os.File
	processDone <-chan struct{}
}

func (reader nativeProcessReader) Read(buffer []byte) (int, error) {
	select {
	case <-reader.processDone:
		_ = reader.file.SetReadDeadline(time.Now().Add(nativeStreamErrorSettleTimeout))
	default:
	}
	return reader.file.Read(buffer)
}
