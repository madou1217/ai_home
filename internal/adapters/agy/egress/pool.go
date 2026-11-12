package egress

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// 本文件对应 Node lib/runtime/egress-pool-state-file.js 与
// lib/runtime/egress-pool-registry.js 的读取路径：
//
//   - state.json 是 server 进程写下的池运行文件（<aiHomeDir>/run/egress-pool/state.json），
//     含 ownerPid / corePid / proxyUrl / lanes（accountRef → 车道回环地址）；
//   - 只有 owner（写文件的 server）与 core（内核进程）都存活、且地址是回环 http 时才采用，
//     否则按未就绪 fail-closed —— 不猜固定端口，也不回落到全局代理。
//
// Go 进程里没有池内核（池仍由宿主 Node 运行时持有），所以这里只读运行文件；
// 保存时的连通性探测与节点轮换留在 Node 的 probePoolEgressWithRotation。

const (
	poolStateFileVersion = 1
	poolStateFileName    = "state.json"
	poolStateDirName     = "egress-pool"
	// 与 Node readLiveEgressPoolState 的 reason 原文一致，直接进错误详情。
	reasonPoolServerNotRunning = "egress_pool_server_not_running"
	reasonPoolCoreExited       = "egress_pool_core_exited"
)

// poolState 是 state.json 里 Go 解析需要的字段（不含 secret / 节点凭据）。
//
// 账号车道 lanes 是「已分配且未被拦截」的车道地址；没有车道的账号用默认出口
// proxyUrl（Node 的 laneUrlMap 不会写被拦截或没有活动节点的车道）。
type poolState struct {
	OwnerPID int
	CorePID  int
	ProxyURL string
	Lanes    map[string]string
}

// readPoolStateFile 读取并做形状校验；不存在/损坏/版本不符返回 false（Node 永不抛）。
func readPoolStateFile(aiHomeDir string) (poolState, bool) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return poolState{}, false
	}
	raw, err := os.ReadFile(filepath.Join(root, "run", poolStateDirName, poolStateFileName))
	if err != nil {
		return poolState{}, false
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return poolState{}, false
	}
	object, isObject := decoded.(map[string]any)
	if !isObject {
		return poolState{}, false
	}
	// Node: parsed.version !== 1 即视为损坏（字符串 "1" 也不接受）。
	version, isNumber := object["version"].(float64)
	if !isNumber || version != poolStateFileVersion {
		return poolState{}, false
	}
	state := poolState{
		OwnerPID: toPID(object["ownerPid"]),
		CorePID:  toPID(object["corePid"]),
		ProxyURL: textValue(object["proxyUrl"]),
		Lanes:    map[string]string{},
	}
	if !isLoopbackHTTPURL(state.ProxyURL) {
		return poolState{}, false
	}
	if lanes, isLanes := object["lanes"].(map[string]any); isLanes {
		for accountRef, value := range lanes {
			laneURL, isText := value.(string)
			// 空账号引用与非回环地址一律丢弃，等价于 Node 的 filter。
			if !isText || accountRef == "" || !isLoopbackHTTPURL(laneURL) {
				continue
			}
			state.Lanes[accountRef] = laneURL
		}
	}
	// Node 要求 owner/core 两个 pid 都存在，否则整份状态作废。
	if state.OwnerPID == 0 || state.CorePID == 0 {
		return poolState{}, false
	}
	return state, true
}

// toPID 对应 Node 的 toPid()：Number(value) 后取正整数，否则 0。
func toPID(value any) int {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed == float64(int64(typed)) && typed <= float64(1<<53) {
			return int(typed)
		}
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}

// readLivePoolState 返回账号应使用的本地出站地址；不可用时返回空串与原因。
//
// 账号有车道时优先车道，否则用默认出口。与 Node currentEgressPoolProxyUrl +
// describeEgressPoolUnavailable 的 CLI 分支同口径。
func (resolver *Resolver) readLivePoolState(accountRef string) (string, string) {
	state, ok := readPoolStateFile(resolver.aiHomeDir)
	if !ok {
		return "", reasonPoolServerNotRunning
	}
	alive := resolver.pidAliveFunc()
	if !alive(state.OwnerPID) {
		return "", reasonPoolServerNotRunning
	}
	if !alive(state.CorePID) {
		return "", reasonPoolCoreExited
	}
	if laneURL, exists := state.Lanes[accountRef]; exists && laneURL != "" {
		return laneURL, ""
	}
	return state.ProxyURL, ""
}

// defaultPidAlive 对应 Node isPidAlive()：signal 0 只做权限/存在检查，
// EPERM 表示进程存在但属于别的用户。
func defaultPidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
