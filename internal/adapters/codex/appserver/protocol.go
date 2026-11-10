// Package appserver 提供 Codex app-server 的 stdio JSON-RPC 客户端。
//
// 传输格式是 newline-delimited JSON：每行一条 JSON-RPC 2.0 消息。本切片只
// 覆盖会话生命周期需要的协议面——initialize 握手、thread/list 归档分页、
// thread/archive 与 thread/unarchive，以及围绕这三个方法的 capabilities
// 探测。进程发现（runtime 解析）不属于这里：可执行文件、参数与环境由调用
// 方提供，客户端只负责子进程监护与协议会话。
package appserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	// DefaultRequestTimeout 与官方 app-server 客户端保持一致的 30s 单请求上限。
	DefaultRequestTimeout = 30 * time.Second

	// listPageSize 是归档线程分页大小，与 Node 生命周期策略一致。
	listPageSize = 100

	// probeThreadID 是 probes 用的合法但不存在的线程 ID：方法存在时 app-server
	// 只会回业务错误，方法缺失时回 -32601。
	probeThreadID = "00000000-0000-4000-8000-000000000000"

	unnamedThreadTitle = "未命名会话"

	codeMethodNotFound = -32601

	// SupportNative / SupportUnsupported 是 capabilities 的操作支持态。
	SupportNative      = "native"
	SupportUnsupported = "unsupported"

	// ReasonMethodUnavailable 表示 app-server 未实现该 JSON-RPC 方法。
	ReasonMethodUnavailable = "native_method_unavailable"
	// ReasonWorkflowIncomplete 表示归档工作流未完整可用。
	ReasonWorkflowIncomplete = "native_archive_workflow_incomplete"
)

var (
	// ErrInvalidConfig 表示客户端配置无法构成一次有效启动。
	ErrInvalidConfig = errors.New("Codex app-server 客户端配置无效")
	// ErrSpawn 表示子进程启动失败。
	ErrSpawn = errors.New("Codex app-server 进程启动失败")
	// ErrClosed 表示客户端已经关闭，不再接受请求。
	ErrClosed = errors.New("Codex app-server 客户端已关闭")
	// ErrTransport 表示 stdio 传输中断（进程退出、管道损坏或读取失败）。
	ErrTransport = errors.New("Codex app-server 传输已中断")
	// ErrProtocol 表示报文无法编码或无法解析成预期结构。
	ErrProtocol = errors.New("Codex app-server 协议错误")
	// ErrMethodNotFound 用于 errors.Is 判断 JSON-RPC -32601。
	ErrMethodNotFound = errors.New("Codex app-server 方法不存在")
	// ErrCursorRepeated 表示归档分页游标重复，继续翻页会死循环。
	ErrCursorRepeated = errors.New("Codex 归档会话分页游标重复")
	// ErrMissingThreadID 表示调用方没有给出线程 ID。
	ErrMissingThreadID = errors.New("Codex 线程 ID 不能为空")
)

// RPCError 是 JSON-RPC 错误响应的完整投影。
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Error 输出带错误码的消息；上游 message 是诊断信息，不参与控制流。
func (rpcErr *RPCError) Error() string {
	return fmt.Sprintf("Codex app-server RPC 错误（code=%d）: %s", rpcErr.Code, rpcErr.Message)
}

// Is 让 errors.Is(err, ErrMethodNotFound) 能识别 -32601。
func (rpcErr *RPCError) Is(target error) bool {
	return target == ErrMethodNotFound && rpcErr.Code == codeMethodNotFound
}

// rpcEnvelope 是客户端需要识别的 JSON-RPC 字段子集。
type rpcEnvelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// ClientInfo 是 initialize 握手中的客户端身份。
type ClientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
}

type initializeCapabilities struct {
	ExperimentalAPI bool `json:"experimentalApi"`
}

type initializeParams struct {
	ClientInfo   ClientInfo             `json:"clientInfo"`
	Capabilities initializeCapabilities `json:"capabilities"`
}

// threadParams 是 thread/archive 与 thread/unarchive 的公共参数。
type threadParams struct {
	ThreadID string `json:"threadId"`
}

// listParams 与官方 thread/list 的请求形状一致；空集合必须是 [] 而不是 null。
type listParams struct {
	Archived       bool     `json:"archived"`
	Cursor         *string  `json:"cursor"`
	Limit          int      `json:"limit"`
	ModelProviders []string `json:"modelProviders"`
	SourceKinds    []string `json:"sourceKinds"`
	UseStateDBOnly bool     `json:"useStateDbOnly"`
}

// threadRecord 是 thread/list 返回的单条线程事实（只取归档视图需要的字段）。
type threadRecord struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Preview   string  `json:"preview"`
	Cwd       string  `json:"cwd"`
	UpdatedAt float64 `json:"updatedAt"`
}

type threadListResponse struct {
	Data       []threadRecord `json:"data"`
	NextCursor string         `json:"nextCursor"`
}

// ArchivedThread 是已归档线程的稳定投影，与 WebUI 归档条目字段一致。
type ArchivedThread struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Provider     string `json:"provider"`
	ProjectPath  string `json:"projectPath,omitempty"`
	Origin       string `json:"origin"`
	CanUnarchive bool   `json:"canUnarchive"`
	UpdatedAt    int64  `json:"updatedAt"`
}

// Operation 描述单个归档能力是否由原生 app-server 提供。
type Operation struct {
	Support   string `json:"support"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// Operations 是归档工作流三个动作的能力明细。
type Operations struct {
	Archive      Operation `json:"archive"`
	ListArchived Operation `json:"listArchived"`
	Unarchive    Operation `json:"unarchive"`
}

// Capabilities 是 capabilities 探测结果。
type Capabilities struct {
	Provider          string     `json:"provider"`
	WorkflowAvailable bool       `json:"workflowAvailable"`
	Operations        Operations `json:"operations"`
	Reason            string     `json:"reason,omitempty"`
}

// mapArchivedThread 把原生线程投影成归档条目；缺少 ID 的线程丢弃。
func mapArchivedThread(record threadRecord) (ArchivedThread, bool) {
	threadID := strings.TrimSpace(record.ID)
	if threadID == "" {
		return ArchivedThread{}, false
	}
	title := strings.TrimSpace(record.Name)
	if title == "" {
		title = strings.TrimSpace(record.Preview)
	}
	if title == "" {
		title = unnamedThreadTitle
	}
	thread := ArchivedThread{
		ID:           threadID,
		Title:        title,
		Provider:     "codex",
		ProjectPath:  strings.TrimSpace(record.Cwd),
		Origin:       "native",
		CanUnarchive: true,
	}
	if record.UpdatedAt > 0 && !math.IsInf(record.UpdatedAt, 0) && !math.IsNaN(record.UpdatedAt) {
		thread.UpdatedAt = int64(math.Round(record.UpdatedAt * 1000))
	}
	return thread, true
}

// newCapabilities 按三个方法的可用性合成能力快照。
func newCapabilities(archiveAvailable, listAvailable, unarchiveAvailable bool) Capabilities {
	workflowAvailable := archiveAvailable && listAvailable && unarchiveAvailable
	capabilities := Capabilities{
		Provider:          "codex",
		WorkflowAvailable: workflowAvailable,
		Operations: Operations{
			Archive:      newOperation(archiveAvailable),
			ListArchived: newOperation(listAvailable),
			Unarchive:    newOperation(unarchiveAvailable),
		},
	}
	if !workflowAvailable {
		capabilities.Reason = ReasonWorkflowIncomplete
	}
	return capabilities
}

func newOperation(available bool) Operation {
	if available {
		return Operation{Support: SupportNative, Available: true}
	}
	return Operation{Support: SupportUnsupported, Reason: ReasonMethodUnavailable}
}
