package plugincontrol

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 启用/停用编排用到的错误码；与 Node control.js / plugin-management-routes 逐字一致。
const (
	// CodePublishBusy 表示已有未完成的发布票据（并发 enable/disable）。
	CodePublishBusy = "plugin_publish_busy"
	// CodeTicketUnknown 表示票据不存在（可能已被 activate/discard 消费）。
	CodeTicketUnknown = "plugin_ticket_unknown"
	// CodeTicketExpired 表示票据超过 TTL 已被 Node 自动回收。
	CodeTicketExpired = "plugin_ticket_expired"
	// CodeCandidateRejected 表示宿主准备候选代次失败（旧代次继续服务）。
	CodeCandidateRejected = "plugin_candidate_rejected"
	// CodeConfigInvalid 表示候选配置不符合插件 configSchema。
	CodeConfigInvalid = "plugin_config_invalid"
	// CodePermissionsUnacknowledged 表示插件申请了权限但未确认。
	CodePermissionsUnacknowledged = "plugin_permissions_unacknowledged"
	// CodeRuntimeUnavailable 表示 Node 插件运行时不可达或未就绪。
	CodeRuntimeUnavailable = "plugin_runtime_unavailable"
	// CodeOperationInvalid 表示实例端点收到了未知操作。
	CodeOperationInvalid = "plugin_operation_invalid"
	// CodeInstanceUnknown 与 Node control.disable 的「没有实例」错误码一致。
	CodeInstanceUnknown = "plugin_instance_unknown"
)

// discardTimeout 是候选回收的独立预算：调用方请求可能已经取消，回收仍要尽量完成。
const discardTimeout = 10 * time.Second

// PrepareRequest 是 Node 构建候选所需的输入。
//
// Input 是原始 enable/disable body：Go 不解释配置、权限或默认值，只补上路径里的 instanceId。
type PrepareRequest struct {
	Operation        Operation       `json:"operation"`
	ExpectedRevision int64           `json:"expectedRevision"`
	Input            json.RawMessage `json:"input"`
}

// PreparedCandidate 是 Node prepare 成功后返回的票据与候选文档。
type PreparedCandidate struct {
	Ticket        string            `json:"ticket"`
	Generation    int64             `json:"generation"`
	Candidate     json.RawMessage   `json:"candidate"`
	Contributions []json.RawMessage `json:"contributions"`
}

// ActivationResult 是 Node activate 成功后的运行态。
type ActivationResult struct {
	Generation int64  `json:"generation"`
	State      string `json:"state"`
}

// RuntimePreparer 是 Node 内部发布协议（prepare/activate/discard）的端口。
type RuntimePreparer interface {
	Prepare(ctx context.Context, request PrepareRequest) (PreparedCandidate, error)
	Activate(ctx context.Context, ticket string, revision int64) (ActivationResult, error)
	Discard(ctx context.Context, ticket string, reason string) error
}

// CandidateCommitter 以候选原文做 CAS 写入；pluginstatestore.Store 实现它。
type CandidateCommitter interface {
	Commit(ctx context.Context, operation Operation, expectedRevision int64, candidate []byte) (int64, error)
}

// StateRevisionReader 读取当前控制状态 revision；缺库/缺表必须返回 plugin_state_unavailable。
type StateRevisionReader interface {
	CurrentRevision(ctx context.Context) (int64, error)
}

// InstanceResult 是实例启停的公开响应，字段与 Node 既有契约一致。
type InstanceResult struct {
	Revision   int64  `json:"revision"`
	Generation int64  `json:"generation"`
	State      string `json:"state"`
}

// InstanceOperator 编排「读 revision → Node prepare → CAS 提交 → Node activate」。
//
// 顺序不可交换：prepare 成功之前不写状态；commit 失败只丢弃候选，旧代次继续服务。
type InstanceOperator struct {
	revisions StateRevisionReader
	committer CandidateCommitter
	runtime   RuntimePreparer
}

// NewInstanceOperator 创建实例启停用例；任一依赖缺失都拒绝装配。
func NewInstanceOperator(
	revisions StateRevisionReader,
	committer CandidateCommitter,
	runtime RuntimePreparer,
) (*InstanceOperator, error) {
	if revisions == nil || committer == nil || runtime == nil {
		return nil, errors.New("插件实例启停依赖无效")
	}
	return &InstanceOperator{revisions: revisions, committer: committer, runtime: runtime}, nil
}

// Apply 执行一次启用或停用。
//
// expectedRevision 来自调用方；为空时用读取到的当前 revision。CAS 仍由 Commit 在事务内复核，
// 读与写之间的并发修改会得到 plugin_revision_conflict，不会覆盖别人的提交。
func (operator *InstanceOperator) Apply(
	ctx context.Context,
	operation Operation,
	instanceID string,
	input json.RawMessage,
	expectedRevision *int64,
) (InstanceResult, error) {
	if operator == nil {
		return InstanceResult{}, pluginerr.New(CodeStateUnavailable, "")
	}
	if operation != OperationEnable && operation != OperationDisable {
		return InstanceResult{}, pluginerr.New(CodeOperationInvalid, "未知 operation")
	}
	id := strings.TrimSpace(instanceID)
	if id == "" {
		return InstanceResult{}, pluginerr.New(CodeInstanceUnknown, "")
	}
	current, err := operator.revisions.CurrentRevision(ctx)
	if err != nil {
		return InstanceResult{}, err
	}
	expected := current
	if expectedRevision != nil {
		expected = *expectedRevision
	}
	prepared, err := operator.runtime.Prepare(ctx, PrepareRequest{
		Operation:        operation,
		ExpectedRevision: expected,
		Input:            input,
	})
	if err != nil {
		return InstanceResult{}, err
	}
	revision, err := operator.committer.Commit(ctx, operation, expected, prepared.Candidate)
	if err != nil {
		operator.discard(prepared.Ticket, "commit_failed")
		return InstanceResult{}, err
	}
	activation, err := operator.runtime.Activate(ctx, prepared.Ticket, revision)
	if err != nil {
		// 状态已经提交；这里只能释放候选锁，运行时由下一次恢复按 desired state 收敛。
		operator.discard(prepared.Ticket, "activate_failed")
		return InstanceResult{}, err
	}
	return InstanceResult{Revision: revision, Generation: activation.Generation, State: activation.State}, nil
}

// discard 用独立超时回收候选：调用方 ctx 取消不能阻止回收，否则发布锁会卡到 TTL。
func (operator *InstanceOperator) discard(ticket string, reason string) {
	if operator == nil || strings.TrimSpace(ticket) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), discardTimeout)
	defer cancel()
	_ = operator.runtime.Discard(ctx, ticket, reason)
}
