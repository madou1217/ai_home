package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	codexControllerConnectTimeout = 10 * time.Second
	codexProcessStopTimeout       = 2 * time.Second
)

var (
	ErrCodexExternalAuthProtocol = errors.New("Codex 外部 OAuth 协议失败")
	ErrCodexRemoteUnsupported    = errors.New("Codex OAuth 官方 Remote 不支持该子命令")
)

// rpcError 是官方 app-server JSON-RPC 错误的最小安全投影。
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpcEnvelope 是当前 external-auth 控制器需要识别的 JSON-RPC 字段子集。
type rpcEnvelope struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// codexExternalAuthController 持有 app-server 外部 OAuth 连接并响应官方刷新请求。
type codexExternalAuthController struct {
	socket      *unixWebSocket
	accountRef  accountcore.AccountRef
	credentials CredentialRefresher
	accountID   string
	planType    string
}

// runCodexExternalAuth 启动官方 app-server、注入内存 Token，再连接官方 TUI。
func (runner *Runner) runCodexExternalAuth(
	ctx context.Context,
	spec providerlaunch.LaunchSpec,
	arguments []string,
) error {
	runtime := spec.Runtime()
	parameters := runtime.RevealParameters()
	if runtime.Kind() != providerlaunch.RuntimeKindCodexExternalAuth ||
		parameters["access_token"] == "" ||
		parameters["chatgpt_account_id"] == "" {
		return ErrInvalidRunRequest
	}
	binary, err := runner.binaries.Resolve(spec.ProviderID(), spec.Binary())
	if err != nil {
		return err
	}
	runtimeDir, err := os.MkdirTemp("", "aih-codex-runtime-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(runtimeDir)
	if err := os.Chmod(runtimeDir, 0o700); err != nil {
		return err
	}
	socketPath := filepath.Join(runtimeDir, "app-server.sock")
	remoteURL := "unix://" + socketPath
	remoteArguments, err := codexRemoteArguments(arguments, remoteURL)
	if err != nil {
		return err
	}
	environment := applyEnvironment(runner.environ(), spec.Environment())
	serverArguments, err := spec.ResolveArguments(
		[]string{"app-server", "--listen", remoteURL},
	)
	if err != nil {
		return err
	}
	serverProcess, err := runner.processes.Start(ctx, processSpec{
		path:   binary,
		args:   serverArguments,
		env:    environment,
		stderr: runner.stderr,
	})
	if err != nil {
		return err
	}
	serverDone := waitProcess(serverProcess)
	controller, err := runner.connectCodexController(
		ctx,
		socketPath,
		spec.AccountRef(),
		parameters,
		serverDone,
	)
	if err != nil {
		stopProcess(serverProcess, serverDone)
		return err
	}
	defer controller.Close()
	controllerDone := make(chan error, 1)
	go func() {
		controllerDone <- controller.Serve(ctx)
	}()
	tuiProcess, err := runner.processes.Start(ctx, processSpec{
		path:   binary,
		args:   remoteArguments,
		env:    environment,
		stdin:  runner.stdin,
		stdout: runner.stdout,
		stderr: runner.stderr,
	})
	if err != nil {
		stopProcess(serverProcess, serverDone)
		return err
	}
	tuiDone := waitProcess(tuiProcess)
	select {
	case err := <-tuiDone:
		_ = controller.Close()
		stopProcess(serverProcess, serverDone)
		return err
	case err := <-serverDone:
		_ = controller.Close()
		stopProcess(tuiProcess, tuiDone)
		if err == nil {
			return ErrCodexExternalAuthProtocol
		}
		return errors.Join(ErrCodexExternalAuthProtocol, err)
	case err := <-controllerDone:
		stopProcess(tuiProcess, tuiDone)
		stopProcess(serverProcess, serverDone)
		if err == nil || errors.Is(err, io.EOF) {
			return ErrCodexExternalAuthProtocol
		}
		return errors.Join(ErrCodexExternalAuthProtocol, err)
	case <-ctx.Done():
		_ = controller.Close()
		stopProcess(tuiProcess, tuiDone)
		stopProcess(serverProcess, serverDone)
		return ctx.Err()
	}
}

// connectCodexController 等待 Socket 就绪，完成 initialize 和外部 Token 登录。
func (runner *Runner) connectCodexController(
	ctx context.Context,
	socketPath string,
	accountRef accountcore.AccountRef,
	parameters map[string]string,
	serverDone <-chan error,
) (*codexExternalAuthController, error) {
	deadline := time.Now().Add(codexControllerConnectTimeout)
	var lastErr error
	for time.Now().Before(deadline) {
		select {
		case err := <-serverDone:
			if err == nil {
				return nil, ErrCodexExternalAuthProtocol
			}
			return nil, errors.Join(ErrCodexExternalAuthProtocol, err)
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		socket, err := dialUnixWebSocket(ctx, socketPath, 300*time.Millisecond)
		if err == nil {
			controller := &codexExternalAuthController{
				socket:      socket,
				accountRef:  accountRef,
				credentials: runner.credentials,
				accountID:   parameters["chatgpt_account_id"],
				planType:    parameters["chatgpt_plan_type"],
			}
			if err := controller.Initialize(parameters["access_token"]); err != nil {
				_ = socket.Close()
				return nil, err
			}
			return controller, nil
		}
		lastErr = err
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, errors.Join(ErrCodexExternalAuthProtocol, lastErr)
}

// Initialize 协商 experimentalApi，并把账号 Token 注入 app-server 内存。
func (controller *codexExternalAuthController) Initialize(accessToken string) error {
	initializeID := "aih-initialize"
	if err := controller.writeJSON(map[string]any{
		"method": "initialize",
		"id":     initializeID,
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name":    "aih-go",
				"version": "1",
			},
			"capabilities": map[string]any{"experimentalApi": true},
		},
	}); err != nil {
		return err
	}
	if err := controller.waitForResponse(initializeID); err != nil {
		return err
	}
	if err := controller.writeJSON(map[string]any{"method": "initialized"}); err != nil {
		return err
	}
	loginID := "aih-login"
	params := map[string]any{
		"type":             "chatgptAuthTokens",
		"accessToken":      accessToken,
		"chatgptAccountId": controller.accountID,
	}
	if controller.planType != "" {
		params["chatgptPlanType"] = controller.planType
	}
	if err := controller.writeJSON(map[string]any{
		"method": "account/login/start",
		"id":     loginID,
		"params": params,
	}); err != nil {
		return err
	}
	return controller.waitForResponse(loginID)
}

// waitForResponse 忽略无关通知，直到收到目标请求 ID 的成功或错误响应。
func (controller *codexExternalAuthController) waitForResponse(expectedID string) error {
	for {
		payload, err := controller.socket.ReadText()
		if err != nil {
			return err
		}
		var envelope rpcEnvelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return errors.Join(ErrCodexExternalAuthProtocol, err)
		}
		var responseID string
		if len(envelope.ID) == 0 || json.Unmarshal(envelope.ID, &responseID) != nil ||
			responseID != expectedID {
			continue
		}
		if envelope.Error != nil {
			return fmt.Errorf(
				"%w: app-server 拒绝 %s（code=%d）",
				ErrCodexExternalAuthProtocol,
				expectedID,
				envelope.Error.Code,
			)
		}
		return nil
	}
}

// Serve 只处理官方外部 Token 刷新请求；其他 TUI 请求由其所属连接处理。
func (controller *codexExternalAuthController) Serve(ctx context.Context) error {
	for {
		payload, err := controller.socket.ReadText()
		if err != nil {
			return err
		}
		var envelope rpcEnvelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return errors.Join(ErrCodexExternalAuthProtocol, err)
		}
		if envelope.Method != "account/chatgptAuthTokens/refresh" || len(envelope.ID) == 0 {
			continue
		}
		if err := controller.handleRefresh(ctx, envelope); err != nil {
			return err
		}
	}
}

// handleRefresh 校验官方 401 刷新请求并返回同一账号的新 Token。
func (controller *codexExternalAuthController) handleRefresh(
	ctx context.Context,
	envelope rpcEnvelope,
) error {
	if controller.credentials == nil {
		return controller.writeRPCError(envelope.ID, -32000, "AIH 未配置本地 Codex 凭据刷新器")
	}
	var params struct {
		PreviousAccountID *string `json:"previousAccountId"`
		Reason            string  `json:"reason"`
	}
	if err := json.Unmarshal(envelope.Params, &params); err != nil ||
		params.Reason != "unauthorized" ||
		(params.PreviousAccountID != nil &&
			*params.PreviousAccountID != "" &&
			*params.PreviousAccountID != controller.accountID) {
		return controller.writeRPCError(envelope.ID, -32602, "AIH 拒绝无效的 OAuth 刷新请求")
	}
	binding, err := controller.credentials.ForceRefreshCredentialBinding(
		ctx,
		controller.accountRef,
	)
	if err != nil {
		return controller.writeRPCError(envelope.ID, -32000, "AIH 无法刷新所选 Codex 账号")
	}
	auth, ok := binding.Credential().(*codex.OAuthAuth)
	if !ok || auth == nil || binding.AccountRef() != controller.accountRef ||
		binding.ProviderID() != codex.ProviderID || auth.UpstreamAccountID() == "" {
		return controller.writeRPCError(envelope.ID, -32000, "AIH 刷新结果与所选 Codex 账号不匹配")
	}
	controller.accountID = auth.UpstreamAccountID()
	controller.planType = auth.PlanType()
	result := map[string]any{
		"accessToken":      auth.AccessToken(),
		"chatgptAccountId": controller.accountID,
		"chatgptPlanType":  nil,
	}
	if controller.planType != "" {
		result["chatgptPlanType"] = controller.planType
	}
	return controller.writeRawResponse(envelope.ID, "result", result)
}

// writeRPCError 返回不包含上游凭据或内部错误详情的稳定 JSON-RPC 错误。
func (controller *codexExternalAuthController) writeRPCError(
	id json.RawMessage,
	code int,
	message string,
) error {
	return controller.writeRawResponse(id, "error", rpcError{Code: code, Message: message})
}

// writeRawResponse 保留请求 ID 的 JSON 类型并写入指定响应字段。
func (controller *codexExternalAuthController) writeRawResponse(
	id json.RawMessage,
	field string,
	value any,
) error {
	response := map[string]any{field: value}
	var decodedID any
	if err := json.Unmarshal(id, &decodedID); err != nil {
		return errors.Join(ErrCodexExternalAuthProtocol, err)
	}
	response["id"] = decodedID
	return controller.writeJSON(response)
}

// writeJSON 序列化并发送一个完整文本消息。
func (controller *codexExternalAuthController) writeJSON(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return controller.socket.WriteText(payload)
}

// Close 中断控制连接及其阻塞读取。
func (controller *codexExternalAuthController) Close() error {
	if controller == nil {
		return nil
	}
	return controller.socket.Close()
}

// codexRemoteArguments 只为官方支持的 root、resume 和 fork TUI 注入 --remote。
func codexRemoteArguments(arguments []string, remoteURL string) ([]string, error) {
	if remoteURL == "" || strings.ContainsRune(remoteURL, '\x00') {
		return nil, ErrInvalidRunRequest
	}
	index, subcommand := codexSubcommand(arguments)
	if subcommand != "" && subcommand != "resume" && subcommand != "fork" {
		return nil, fmt.Errorf("%w: codex %s", ErrCodexRemoteUnsupported, subcommand)
	}
	result := append([]string(nil), arguments...)
	insertAt := 0
	if subcommand == "resume" || subcommand == "fork" {
		insertAt = index + 1
	}
	result = append(result, "", "")
	copy(result[insertAt+2:], result[insertAt:len(result)-2])
	result[insertAt] = "--remote"
	result[insertAt+1] = remoteURL
	return result, nil
}

// codexSubcommand 跳过带值全局参数并识别第一个真实子命令。
func codexSubcommand(arguments []string) (int, string) {
	commands := map[string]struct{}{
		"exec": {}, "review": {}, "login": {}, "logout": {}, "mcp": {},
		"plugin": {}, "mcp-server": {}, "app-server": {}, "remote-control": {},
		"app": {}, "completion": {}, "update": {}, "doctor": {}, "sandbox": {},
		"debug": {}, "apply": {}, "resume": {}, "archive": {}, "delete": {},
		"unarchive": {}, "fork": {}, "cloud": {}, "exec-server": {}, "features": {},
	}
	optionsWithValue := map[string]struct{}{
		"-c": {}, "--config": {}, "--enable": {}, "--disable": {}, "--remote": {},
		"--remote-auth-token-env": {}, "-i": {}, "--image": {}, "-m": {},
		"--model": {}, "--local-provider": {}, "-p": {}, "--profile": {},
		"-s": {}, "--sandbox": {}, "-C": {}, "--cd": {}, "--add-dir": {},
		"-a": {}, "--ask-for-approval": {},
	}
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if argument == "--" {
			return -1, ""
		}
		if _, consumes := optionsWithValue[argument]; consumes {
			index++
			continue
		}
		if strings.HasPrefix(argument, "-") {
			continue
		}
		if _, found := commands[argument]; found {
			return index, argument
		}
		return -1, ""
	}
	return -1, ""
}

// waitProcess 把阻塞 Wait 转换为只产生一次结果的生命周期通道。
func waitProcess(process processHandle) <-chan error {
	done := make(chan error, 1)
	go func() {
		done <- process.Wait()
		close(done)
	}()
	return done
}

// stopProcess 先请求优雅退出，超时后强制结束并等待资源回收。
func stopProcess(process processHandle, done <-chan error) {
	if process == nil {
		return
	}
	_ = process.Signal(os.Interrupt)
	timer := time.NewTimer(codexProcessStopTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
		_ = process.Kill()
		<-done
	}
}
