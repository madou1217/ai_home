package webuiterminalapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

// openBody 是浏览器 /open 的入参，字段集合与 Node handleTerminalOpen 的收口完全一致：
// 任意可执行/argv/env 永远不从这里进入。
type openBody struct {
	Cols       any    `json:"cols"`
	Rows       any    `json:"rows"`
	MuxID      string `json:"muxId"`
	Cwd        string `json:"cwd"`
	SessionKey string `json:"sessionKey"`
}

// launchBody 是 Node 进程内启动器（账号应用 / 远程工作区 / SSH）的入参。
//
// 它与 /open 分开是为了把权限边界写死在路由上：浏览器路由只转发 /open，
// /launch 只接受带管理密钥的进程内调用。
type launchBody struct {
	SessionKey string     `json:"sessionKey"`
	Cwd        string     `json:"cwd"`
	File       string     `json:"file"`
	Args       []string   `json:"args"`
	Env        []string   `json:"env"`
	Cols       any        `json:"cols"`
	Rows       any        `json:"rows"`
	MuxID      string     `json:"muxId"`
	Persistent bool       `json:"persistent"`
	SSH        *sshLaunch `json:"ssh"`
}

// sshLaunch 是 Node 进程内启动器交给 Go 的 SSH 终端事实。
// 浏览器永远不直接调用这条路由；凭据只走管理密钥保护的本机链路。
type sshLaunch struct {
	Host         string     `json:"host"`
	Port         int        `json:"port"`
	User         string     `json:"user"`
	AuthType     string     `json:"authType"`
	Password     string     `json:"password"`
	PrivateKey   string     `json:"privateKey"`
	IdentityFile string     `json:"identityFile"`
	Command      string     `json:"command"`
	Env          []string   `json:"env"`
	Jump         *sshLaunch `json:"jump"`
}

// terminalView 是 open/attach 的成功响应，字段与 Node 返回同名同义。
type terminalView struct {
	OK         bool   `json:"ok"`
	TermID     string `json:"termId"`
	SessionKey string `json:"sessionKey"`
	MuxID      string `json:"muxId"`
	Cols       uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
	Shell      string `json:"shell"`
	Cwd        string `json:"cwd"`
	Durable    bool   `json:"durable"`
	Reused     bool   `json:"reused,omitempty"`
}

type openInput struct {
	sessionKey string
	muxID      string
	cwd        string
	cols       int
	rows       int
	shell      Shell
	env        []string
	persistent bool
	attachOnly bool
	remote     *terminalsession.RemoteSpec
}

type openResult struct {
	snapshot terminalsession.Snapshot
	shell    string
	muxID    string
	durable  bool
	reused   bool
}

func (handler *Handler) handleOpen(response http.ResponseWriter, request *http.Request) {
	var body openBody
	handler.readJSON(request, handler.maxBody, &body)
	result, failure := handler.openSession(request.Context(), openInput{
		sessionKey: body.SessionKey,
		muxID:      body.MuxID,
		cwd:        body.Cwd,
		cols:       intValue(body.Cols),
		rows:       intValue(body.Rows),
		shell:      handler.pickShell(),
	})
	handler.writeOpenResult(response, result, failure, statusForOpen)
}

func (handler *Handler) handleLaunch(response http.ResponseWriter, request *http.Request) {
	var body launchBody
	handler.readJSON(request, handler.maxBody, &body)
	file := strings.TrimSpace(body.File)
	var remote *terminalsession.RemoteSpec
	if body.SSH != nil {
		remote = &terminalsession.RemoteSpec{
			Config:  sshConfigFromLaunch(body.SSH),
			Command: body.SSH.Command,
			Env:     append([]string(nil), body.SSH.Env...),
		}
	}
	if file == "" && remote == nil {
		writeTerminalError(response, http.StatusInternalServerError, errPTYSpawnFailed)
		return
	}
	result, failure := handler.openSession(request.Context(), openInput{
		sessionKey: body.SessionKey,
		muxID:      body.MuxID,
		cwd:        body.Cwd,
		cols:       intValue(body.Cols),
		rows:       intValue(body.Rows),
		shell:      Shell{File: file, Args: append([]string(nil), body.Args...)},
		env:        append([]string(nil), body.Env...),
		persistent: body.Persistent,
		remote:     remote,
	})
	handler.writeOpenResult(response, result, failure, statusForOpen)
}

// sshConfigFromLaunch 递归展开 egress/jump 链；密码/私钥只在管理链路里传输。
func sshConfigFromLaunch(launch *sshLaunch) sshremote.Config {
	config := sshremote.Config{
		Host:         launch.Host,
		Port:         launch.Port,
		User:         launch.User,
		AuthType:     launch.AuthType,
		Password:     launch.Password,
		PrivateKey:   launch.PrivateKey,
		IdentityFile: launch.IdentityFile,
	}
	if launch.Jump != nil {
		jump := sshConfigFromLaunch(launch.Jump)
		config.Jump = &jump
	}
	return config
}

func (handler *Handler) writeOpenResult(
	response http.ResponseWriter,
	result *openResult,
	failure *terminalError,
	status func(*terminalError) int,
) {
	if failure != nil {
		writeTerminalError(response, status(failure), failure)
		return
	}
	view := terminalView{
		OK:         true,
		TermID:     result.snapshot.ID,
		SessionKey: result.snapshot.Key,
		MuxID:      result.muxID,
		Cols:       result.snapshot.Cols,
		Rows:       result.snapshot.Rows,
		Shell:      result.shell,
		Cwd:        result.snapshot.Dir,
		Durable:    result.durable,
		Reused:     result.reused,
	}
	writeJSON(response, http.StatusOK, view)
}

// openSession 复刻 Node openTerminalSession 的完整语义：
// 同 key 存活会话复用 → 探测/创建 tmux 外层 → 启动 PTY → 绑定 mux。
func (handler *Handler) openSession(ctx context.Context, input openInput) (*openResult, *terminalError) {
	handler.sessions.Reap()
	handler.forgetStaleMeta(handler.sessions.List())
	key := normalizeSessionKey(input.sessionKey)

	// 1) 同 key 存活会话直接复用（Node 在探测 tmux 之前就返回）。
	if key != "" {
		if existing, err := handler.sessions.Attach(key); err == nil {
			shell := handler.shellForSnapshot(existing)
			handler.bind(existing.ID, input.muxID, shell)
			return &openResult{
				snapshot: existing,
				shell:    shell,
				muxID:    handler.muxIDFor(existing.ID),
				durable:  existing.Durable,
				reused:   true,
			}, nil
		}
	}

	cols, rows := normalizeSize(input.cols, input.rows)
	// 远端 SSH 终端不经过本地 tmux/壳层；会话生命周期由 terminalsession 管理。
	if input.remote != nil {
		snapshot, err := handler.sessions.Create(ctx, terminalsession.Spec{
			Key:        key,
			Remote:     input.remote,
			Size:       pty.Size{Rows: uint16(rows), Cols: uint16(cols)},
			Persistent: true,
		})
		if err != nil {
			return nil, &terminalError{code: errPTYSpawnFailed.code, message: err.Error()}
		}
		return &openResult{snapshot: snapshot, shell: "ssh", muxID: handler.muxIDFor(snapshot.ID)}, nil
	}
	dir := handler.resolveCwd(input.cwd)
	env := handler.buildTerminalEnv(input.env)
	file := input.shell.File
	args := append([]string(nil), input.shell.Args...)
	durableFlag := false
	createdDurable := false

	// 2) 有 sessionKey 时先对齐 tmux 外层；attach 路径要求外层必须已存在。
	if key != "" {
		probe := handler.durable.Probe(key)
		if probe.State == DurableUnavailable && (input.attachOnly || !probe.MissingBinary) {
			return nil, &terminalError{code: "persistent_terminal_unavailable", message: probe.Message}
		}
		adopted := probe.State == DurableAlive
		if !adopted {
			if input.attachOnly {
				return nil, errTerminalNotFound
			}
			created, err := handler.durable.Create(key, DurableSpec{
				File: file,
				Args: args,
				Dir:  dir,
				Env:  env,
				Cols: cols,
				Rows: rows,
			})
			if err != nil {
				return nil, &terminalError{code: "persistent_terminal_unavailable", message: err.Error()}
			}
			createdDurable = created.Durable
			durableFlag = created.Durable
		} else {
			durableFlag = true
		}
		if durableFlag {
			file, args = handler.durable.AttachCommand(key)
			// Server 自身可能跑在 tmux 里；attach 客户端必须清掉 TMUX 标记，
			// 否则内层 CLI 会把自己当成嵌套会话而拒绝启动（与 Node 一致）。
			env = withoutEnv(env, "TMUX")
		}
	}

	snapshot, err := handler.sessions.Create(ctx, terminalsession.Spec{
		Key:        key,
		Path:       file,
		Args:       args,
		Env:        env,
		Dir:        dir,
		Size:       pty.Size{Rows: uint16(rows), Cols: uint16(cols)},
		Durable:    durableFlag,
		Persistent: key != "" || input.persistent,
	})
	if err != nil {
		if createdDurable {
			_ = handler.durable.Close(key)
		}
		if errors.Is(err, terminalsession.ErrTooManySessions) {
			return nil, errTooManyTerminals
		}
		// 其余（无效 spec、spawn 失败、服务已关闭）统一按 Node 的 pty_spawn_failed 返回。
		return nil, &terminalError{code: errPTYSpawnFailed.code, message: err.Error()}
	}

	handler.bind(snapshot.ID, input.muxID, input.shell.File)
	return &openResult{
		snapshot: snapshot,
		shell:    input.shell.File,
		muxID:    handler.muxIDFor(snapshot.ID),
		durable:  snapshot.Durable,
		reused:   snapshot.Reused,
	}, nil
}

func (handler *Handler) handleAttach(response http.ResponseWriter, request *http.Request) {
	var body struct {
		SessionKey string `json:"sessionKey"`
		MuxID      string `json:"muxId"`
	}
	handler.readJSON(request, handler.maxBody, &body)
	key := normalizeSessionKey(body.SessionKey)
	if key == "" {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	if existing, err := handler.sessions.Attach(key); err == nil {
		shell := handler.shellForSnapshot(existing)
		handler.bind(existing.ID, body.MuxID, shell)
		handler.writeOpenResult(response, &openResult{
			snapshot: existing,
			shell:    shell,
			muxID:    handler.muxIDFor(existing.ID),
			durable:  existing.Durable,
		}, nil, statusForAttach)
		return
	}
	// 刚退出、还在保留期内的会话按 Node 语义直接 404，不再尝试恢复 tmux。
	for _, snapshot := range handler.sessions.List() {
		if snapshot.Key == key {
			writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
			return
		}
	}
	restored, failure := handler.openSession(request.Context(), openInput{
		sessionKey: key,
		muxID:      body.MuxID,
		shell:      handler.pickShell(),
		attachOnly: true,
	})
	if failure != nil {
		writeTerminalError(response, statusForAttach(failure), failure)
		return
	}
	handler.writeOpenResult(response, restored, nil, statusForAttach)
}

func (handler *Handler) handleInput(response http.ResponseWriter, request *http.Request) {
	var body struct {
		TermID string `json:"termId"`
		Data   string `json:"data"`
	}
	handler.readJSON(request, handler.maxBody, &body)
	termID := strings.TrimSpace(body.TermID)
	if _, err := handler.sessions.Attach(termID); err != nil {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	if err := handler.sessions.Write(termID, []byte(body.Data)); err != nil {
		writeJSON(response, http.StatusBadRequest, errorView{
			OK: false, Error: "terminal_write_failed", Message: err.Error(),
		})
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

func (handler *Handler) handleResize(response http.ResponseWriter, request *http.Request) {
	var body struct {
		TermID string `json:"termId"`
		Cols   any    `json:"cols"`
		Rows   any    `json:"rows"`
	}
	handler.readJSON(request, handler.maxBody, &body)
	termID := strings.TrimSpace(body.TermID)
	cols, colsOK := parseIntValue(body.Cols)
	rows, rowsOK := parseIntValue(body.Rows)
	if !colsOK || !rowsOK {
		writeJSON(response, http.StatusBadRequest, errorView{OK: false, Error: "terminal_resize_invalid"})
		return
	}
	cols = clamp(cols, 2, 500)
	rows = clamp(rows, 1, 200)
	if _, err := handler.sessions.Attach(termID); err != nil {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	if _, err := handler.sessions.Resize(termID, pty.Size{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		writeJSON(response, http.StatusBadRequest, errorView{
			OK: false, Error: "terminal_resize_failed", Message: err.Error(),
		})
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK   bool   `json:"ok"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}{OK: true, Cols: uint16(cols), Rows: uint16(rows)})
}

func (handler *Handler) handleClose(response http.ResponseWriter, request *http.Request) {
	var body struct {
		TermID     string `json:"termId"`
		SessionKey string `json:"sessionKey"`
	}
	handler.readJSON(request, handler.maxBody, &body)
	termID := strings.TrimSpace(body.TermID)
	key := normalizeSessionKey(body.SessionKey)

	target := handler.findSnapshot(termID)
	if target != nil && key != "" && target.Key != key {
		writeJSON(response, http.StatusConflict, errorView{OK: false, Error: "terminal_identity_mismatch"})
		return
	}
	if target == nil && key != "" {
		target = handler.findSnapshotByKey(key)
	}

	// 服务器重启后 termId 已失效，但客户端仍持有 sessionKey：必须把 tmux 会话也关掉，
	// 否则「关闭」只关了本地视图，后台 shell 还在跑（与 Node 语义一致）。
	durableKey := key
	if target != nil {
		durableKey = ""
		if target.Durable {
			durableKey = target.Key
		}
	}
	if durableKey != "" {
		if err := handler.durable.Close(durableKey); err != nil {
			writeTerminalError(response, http.StatusServiceUnavailable, errPersistentTerminalUnavailable)
			return
		}
	}
	if target != nil {
		_ = handler.sessions.Kill(target.ID)
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

func (handler *Handler) handleProbe(response http.ResponseWriter, request *http.Request) {
	key := normalizeSessionKey(request.URL.Query().Get("sessionKey"))
	if key == "" {
		writeJSON(response, http.StatusBadRequest, errorView{OK: false, Error: "session_key_required"})
		return
	}
	probe := handler.durable.Probe(key)
	state := string(probe.State)
	writeJSON(response, http.StatusOK, struct {
		OK      bool   `json:"ok"`
		State   string `json:"state"`
		Message string `json:"message,omitempty"`
	}{OK: true, State: state, Message: probe.Message})
}

// ---------- 会话查找 / 绑定 ----------

func (handler *Handler) findSnapshot(termID string) *terminalsession.Snapshot {
	if termID == "" {
		return nil
	}
	for _, snapshot := range handler.sessions.List() {
		if snapshot.ID == termID {
			copied := snapshot
			return &copied
		}
	}
	return nil
}

func (handler *Handler) findSnapshotByKey(key string) *terminalsession.Snapshot {
	if key == "" {
		return nil
	}
	for _, snapshot := range handler.sessions.List() {
		if snapshot.Key == key {
			copied := snapshot
			return &copied
		}
	}
	return nil
}

func (handler *Handler) shellFor(termID string) string {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if meta := handler.meta[termID]; meta != nil && meta.shell != "" {
		return meta.shell
	}
	return ""
}

// shellForSnapshot 在传输层元数据缺失时回退到 PTY 实际路径（例如进程重启后的旧会话）。
func (handler *Handler) shellForSnapshot(snapshot terminalsession.Snapshot) string {
	if shell := handler.shellFor(snapshot.ID); shell != "" {
		return shell
	}
	return snapshot.Path
}

// bind 把 termId 绑到 mux，并把输出分发注册到已存在的面板流。
// 重新绑定到另一个 mux 时先解除旧订阅，避免同一会话向两个面板重复广播。
func (handler *Handler) bind(termID string, muxID string, shell string) {
	if termID == "" {
		return
	}
	handler.mu.Lock()
	meta := handler.meta[termID]
	if meta == nil {
		meta = &sessionMeta{}
		handler.meta[termID] = meta
	}
	previous := meta.muxID
	// 与 Node 一致：只有显式带了 muxId 才重绑；不带 mux 的 open/attach 不能把
	// 会话从正在观察它的面板上摘下来。
	if muxID != "" {
		meta.muxID = muxID
	} else {
		muxID = previous
	}
	if shell != "" {
		meta.shell = shell
	}
	var oldMux *muxStream
	if previous != "" && previous != muxID {
		oldMux = handler.muxes[previous]
	}
	var newMux *muxStream
	if muxID != "" {
		newMux = handler.muxes[muxID]
	}
	handler.mu.Unlock()

	if oldMux != nil {
		oldMux.unsubscribe(termID)
	}
	if newMux != nil {
		newMux.subscribe(handler.sessions, termID)
	}
}

func (handler *Handler) muxIDFor(termID string) string {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if meta := handler.meta[termID]; meta != nil {
		return meta.muxID
	}
	return ""
}

// forgetStaleMeta 清理已不在服务里的会话元数据，避免 termId 映射无限增长。
func (handler *Handler) forgetStaleMeta(snapshots []terminalsession.Snapshot) {
	alive := make(map[string]struct{}, len(snapshots))
	for _, snapshot := range snapshots {
		alive[snapshot.ID] = struct{}{}
	}
	handler.mu.Lock()
	defer handler.mu.Unlock()
	for termID := range handler.meta {
		if _, ok := alive[termID]; !ok {
			delete(handler.meta, termID)
		}
	}
}

// ---------- 尺寸 / cwd / shell / 环境 ----------

func normalizeSessionKey(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 192 || strings.ContainsAny(value, "\x00\r\n") {
		return ""
	}
	return value
}

func normalizeSize(cols int, rows int) (int, int) {
	// Node 的 Number(x) || 80 语义：0/缺省都回落默认值，再做夹取。
	if cols == 0 {
		cols = defaultCols
	}
	if rows == 0 {
		rows = defaultRows
	}
	return clamp(cols, 2, 500), clamp(rows, 1, 200)
}

func clamp(value int, minimum int, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func parseIntValue(value any) (int, bool) {
	switch item := value.(type) {
	case float64:
		return int(item), true
	case int:
		return item, true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(item))
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}

// resolveCwd 与 Node resolveTerminalCwd 一致：请求目录不存在/不可访问时回退 home，
// 避免跨机器路径（Mac → Linux）直接让 PTY spawn 失败。
func (handler *Handler) resolveCwd(requested string) string {
	candidate := strings.TrimSpace(requested)
	if candidate != "" {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return handler.homeDir
}

func defaultShellPicker(lookupEnv func(string) string) ShellPicker {
	return func() Shell {
		if runtime.GOOS == "windows" {
			command := strings.TrimSpace(lookupEnv("COMSPEC"))
			if command == "" {
				command = "powershell.exe"
			}
			return Shell{File: command}
		}
		shell := strings.TrimSpace(lookupEnv("SHELL"))
		if shell == "" {
			shell = "/bin/bash"
		}
		return Shell{File: shell, Args: []string{"-l"}}
	}
}

// buildTerminalEnv 对齐 Node buildTerminalEnv + setRuntimeMarkerField：
// 继承宿主环境 → TERM → aih shim 目录前置 PATH → 调用方覆盖 → web 运行时标记。
func (handler *Handler) buildTerminalEnv(overrides []string) []string {
	environment := append([]string(nil), os.Environ()...)
	environment = setEnv(environment, "TERM", "xterm-256color")
	if shimDir := handler.ensureAihShimDir(); shimDir != "" {
		separator := ":"
		if runtime.GOOS == "windows" {
			separator = ";"
		}
		current := envValue(environment, "PATH")
		environment = setEnv(environment, "PATH", shimDir+separator+current)
	}
	for _, entry := range overrides {
		separator := strings.IndexByte(entry, '=')
		if separator <= 0 {
			continue
		}
		environment = setEnv(environment, entry[:separator], entry[separator+1:])
	}
	return setRuntimeMarker(environment, "web", "1")
}

var runtimeMarkerFieldOrder = []string{"utf8", "claude", "psmux", "supervisor", "web"}

// setRuntimeMarker 合并 AIH_RUNTIME_MARKER 的 key=value 列表。
// 旧 Node 实现只在 web 终端里设置 web=1 并补 utf8；字段顺序必须保持一致，
// 因为 CLI 侧按同一个序列化结果做字符串比较。
func setRuntimeMarker(environment []string, key string, value string) []string {
	fields := make(map[string]string)
	for _, part := range strings.Split(envValue(environment, "AIH_RUNTIME_MARKER"), ",") {
		separator := strings.IndexByte(part, '=')
		if separator <= 0 {
			continue
		}
		fields[strings.TrimSpace(part[:separator])] = strings.TrimSpace(part[separator+1:])
	}
	if fields["utf8"] == "" {
		fields["utf8"] = "2026-06-utf8"
	}
	if value == "" {
		delete(fields, key)
	} else {
		fields[key] = value
	}
	parts := make([]string, 0, len(runtimeMarkerFieldOrder))
	for _, name := range runtimeMarkerFieldOrder {
		if fields[name] != "" {
			parts = append(parts, name+"="+fields[name])
		}
	}
	return setEnv(environment, "AIH_RUNTIME_MARKER", strings.Join(parts, ","))
}

func envValue(environment []string, key string) string {
	prefix := key + "="
	for index := len(environment) - 1; index >= 0; index-- {
		if strings.HasPrefix(environment[index], prefix) {
			return environment[index][len(prefix):]
		}
	}
	return ""
}

func setEnv(environment []string, key string, value string) []string {
	prefix := key + "="
	for index := range environment {
		if strings.HasPrefix(environment[index], prefix) {
			environment[index] = prefix + value
			return environment
		}
	}
	return append(environment, prefix+value)
}

func withoutEnv(environment []string, key string) []string {
	prefix := key + "="
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		if !strings.HasPrefix(entry, prefix) {
			result = append(result, entry)
		}
	}
	return result
}

// ensureAihShimDir 在仓库根生成 aih shim，并返回要前置到 PATH 的目录。
//
// 远端部署包通常没做过 npm link，login shell 里 aih 会 command not found；
// 旧 Node 实现每次 open 都保证这个 shim 存在（失败则静默跳过），这里保持一致。
// 仓库根只从可执行文件位置推导：生产构件在 <root>/bin/native/<os>-<arch>/ 下，
// 打包位置不同或找不到 bin/ai-home.js 时不生成，不靠额外环境变量兜底。
func (handler *Handler) ensureAihShimDir() string {
	handler.shimOnce.Do(func() {
		if runtime.GOOS == "windows" {
			return
		}
		root := repositoryRootFromExecutable()
		if root == "" {
			return
		}
		entry := filepath.Join(root, "bin", "ai-home.js")
		if info, err := os.Stat(entry); err != nil || info.IsDir() {
			return
		}
		nodePath, err := exec.LookPath("node")
		if err != nil {
			return
		}
		shimDir := filepath.Join(root, ".runtime-bin")
		if err := os.MkdirAll(shimDir, 0o755); err != nil {
			return
		}
		shim := filepath.Join(shimDir, "aih")
		body := "#!/bin/sh\nexec \"" + nodePath + "\" \"" + entry + "\" \"$@\"\n"
		existing, _ := os.ReadFile(shim)
		// 幂等：内容没变不重写，避免每次 open 都 churn 磁盘。
		if string(existing) != body {
			if err := os.WriteFile(shim, []byte(body), 0o755); err != nil {
				return
			}
		}
		_ = os.Chmod(shim, 0o755)
		handler.shimDir = shimDir
	})
	return handler.shimDir
}

func repositoryRootFromExecutable() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	directory := filepath.Dir(executable)
	for depth := 0; depth < 4; depth++ {
		if info, err := os.Stat(filepath.Join(directory, "bin", "ai-home.js")); err == nil && !info.IsDir() {
			return directory
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return ""
}
