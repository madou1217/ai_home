package codexresetcredit

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const defaultConsumeTimeout = 30 * time.Second

var operationIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ErrInvalidDependencies 表示服务缺少 aiHomeDir。
var ErrInvalidDependencies = errors.New("Codex 重置卡服务缺少 aiHomeDir")

// ServiceDependencies 汇总重置卡服务依赖。
type ServiceDependencies struct {
	AIHomeDir        string
	Transport        Transport
	ConsumeTimeout   time.Duration
	Now              func() time.Time
	OnResetConfirmed func(ctx context.Context, accountRef string)
}

type activeRun struct {
	operationID      string
	inventoryVersion string
	done             chan struct{}
	result           *OperationEnvelope
	err              error
}

// Service 管理 Codex 额度重置卡库存、并发互斥与幂等消费/核对。
type Service struct {
	aiHomeDir        string
	transport        Transport
	consumeTimeout   time.Duration
	now              func() time.Time
	onResetConfirmed func(ctx context.Context, accountRef string)

	mu         sync.Mutex
	activeRuns map[string]*activeRun
}

// NewService 创建 Codex 重置卡服务实例。
func NewService(deps ServiceDependencies) (*Service, error) {
	home := strings.TrimSpace(deps.AIHomeDir)
	if home == "" {
		return nil, ErrInvalidDependencies
	}
	timeout := deps.ConsumeTimeout
	if timeout <= 0 {
		timeout = defaultConsumeTimeout
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		aiHomeDir:        home,
		transport:        deps.Transport,
		consumeTimeout:   timeout,
		now:              now,
		onResetConfirmed: deps.OnResetConfirmed,
		activeRuns:       map[string]*activeRun{},
	}, nil
}

func requireOperationID(raw string) (string, error) {
	opID := strings.ToLower(strings.TrimSpace(raw))
	if !operationIDPattern.MatchString(opID) {
		return "", newCodedError("codex_reset_operation_invalid", "重置操作 ID 无效", http.StatusBadRequest)
	}
	return opID, nil
}

func (s *Service) isRunActive(accountRef string, operationID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.activeRuns[accountRef]
	return run != nil && run.operationID == operationID
}

func (s *Service) recoverInterruptedOperation(ctx context.Context, accountRef string, op *OperationRecord) (*OperationRecord, error) {
	if op == nil || op.Status != "consuming" {
		return op, nil
	}
	if s.isRunActive(accountRef, op.OperationID) {
		return op, nil
	}
	currentMS := s.now().UnixMilli()
	if currentMS-op.UpdatedAt < s.consumeTimeout.Milliseconds() {
		return op, nil
	}
	return MarkOperationUnknown(ctx, s.aiHomeDir, op.OperationID, "codex_reset_server_interrupted", currentMS)
}

func (s *Service) getActiveOperation(ctx context.Context, accountRef string) (*OperationRecord, error) {
	op, err := GetActiveOperation(ctx, s.aiHomeDir, accountRef)
	if err != nil {
		return nil, err
	}
	return s.recoverInterruptedOperation(ctx, accountRef, op)
}

type inventorySnapshot struct {
	AccountRef       string
	Supported        bool
	AvailableCount   int
	SelectableCount  int
	SelectionMode    string
	DetailsComplete  bool
	InventoryVersion string
	CapturedAt       int64
	Credits          []CreditRecord
}

func (s *Service) fetchInventory(ctx context.Context, accountRef string) (inventorySnapshot, error) {
	if s.transport == nil {
		return inventorySnapshot{}, newCodedError("codex_reset_service_unavailable", "Codex 重置传输层不可用", http.StatusServiceUnavailable)
	}
	if err := s.transport.AssertOAuthAccount(ctx, accountRef); err != nil {
		return inventorySnapshot{}, err
	}
	res, err := s.transport.ReadRateLimits(ctx, accountRef)
	if err != nil {
		return inventorySnapshot{}, err
	}
	summary, supported := res["rateLimitResetCredits"].(map[string]any)
	inventory := NormalizeInventory(summary)
	capturedAt := s.now().UnixMilli()
	if err := SyncInventory(ctx, s.aiHomeDir, accountRef, inventory, capturedAt); err != nil {
		return inventorySnapshot{}, err
	}
	credits, err := ListHistory(ctx, s.aiHomeDir, accountRef, capturedAt)
	if err != nil {
		return inventorySnapshot{}, err
	}
	inventoryVersion := BuildInventoryVersion(inventory.AvailableCount, credits)
	persistedAvailable := 0
	for _, c := range credits {
		if c.Status == "available" {
			persistedAvailable++
		}
	}
	detailsComplete := supported && inventory.DetailsComplete && persistedAvailable == inventory.AvailableCount
	selectionMode := "none"
	if detailsComplete {
		selectionMode = "local"
	} else if supported && inventory.AvailableCount > 0 {
		selectionMode = "upstream"
	}
	selectableCount := 0
	switch selectionMode {
	case "local":
		selectableCount = persistedAvailable
	case "upstream":
		selectableCount = inventory.AvailableCount
	}
	return inventorySnapshot{
		AccountRef:       accountRef,
		Supported:        supported,
		AvailableCount:   inventory.AvailableCount,
		SelectableCount:  selectableCount,
		SelectionMode:    selectionMode,
		DetailsComplete:  detailsComplete,
		InventoryVersion: inventoryVersion,
		CapturedAt:       capturedAt,
		Credits:          credits,
	}, nil
}

// List 查询指定 Codex 账号当前可用的重置卡库存与历史。
func (s *Service) List(ctx context.Context, accountRef string) (*ListResult, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	snap, err := s.fetchInventory(ctx, normalizedRef)
	if err != nil {
		return nil, err
	}
	nextCreditID := ""
	if snap.SelectionMode == "local" {
		if picked := SelectNextCredit(snap.Credits, snap.CapturedAt); picked != nil {
			nextCreditID = picked.CreditID
		}
	}
	activeOp, err := s.getActiveOperation(ctx, normalizedRef)
	if err != nil {
		return nil, err
	}
	return &ListResult{
		AccountRef:       snap.AccountRef,
		Supported:        snap.Supported,
		AvailableCount:   snap.AvailableCount,
		SelectableCount:  snap.SelectableCount,
		SelectionMode:    snap.SelectionMode,
		DetailsComplete:  snap.DetailsComplete,
		InventoryVersion: snap.InventoryVersion,
		CapturedAt:       snap.CapturedAt,
		Credits:          snap.Credits,
		NextCreditID:     nextCreditID,
		ActiveOperation:  activeOp,
	}, nil
}

// GetOperation 查询单次消费操作的当前状态，并自动收敛超时孤儿操作。
func (s *Service) GetOperation(ctx context.Context, accountRef string, operationID string) (*OperationRecord, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	opID, err := requireOperationID(operationID)
	if err != nil {
		return nil, err
	}
	rawOp, err := GetOperation(ctx, s.aiHomeDir, opID)
	if err != nil {
		return nil, err
	}
	op, err := s.recoverInterruptedOperation(ctx, normalizedRef, rawOp)
	if err != nil {
		return nil, err
	}
	if op == nil || op.AccountRef != normalizedRef {
		return nil, newCodedError("codex_reset_operation_not_found", "重置操作不存在", http.StatusNotFound)
	}
	return op, nil
}

func wrapOperation(op *OperationRecord) *OperationEnvelope {
	return &OperationEnvelope{
		Operation:              op,
		ReconciliationRequired: op != nil && op.Status == "unknown",
	}
}

func isKnownOutcome(outcome string) bool {
	switch outcome {
	case "reset", "nothingToReset", "noCredit", "alreadyRedeemed":
		return true
	default:
		return false
	}
}

func isConfirmedReset(env *OperationEnvelope) bool {
	if env == nil || env.Operation == nil || env.Operation.Status != "succeeded" {
		return false
	}
	switch env.Operation.Outcome {
	case "reset", "nothingToReset", "alreadyRedeemed":
		return true
	default:
		return false
	}
}

// Consume 幂等消费一张重置卡（并发按 accountRef 互斥，同 operationId 复用）。
func (s *Service) Consume(ctx context.Context, accountRef string, operationID string, inventoryVersion string) (*OperationEnvelope, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	opID, err := requireOperationID(operationID)
	if err != nil {
		return nil, err
	}
	invVer := strings.TrimSpace(inventoryVersion)
	if invVer == "" {
		return nil, newCodedError("codex_reset_operation_invalid", "重置请求无效", http.StatusBadRequest)
	}

	s.mu.Lock()
	if active := s.activeRuns[normalizedRef]; active != nil {
		if active.operationID == opID {
			if active.inventoryVersion != "" && active.inventoryVersion != invVer {
				s.mu.Unlock()
				return nil, newCodedError("codex_reset_idempotency_conflict", "", http.StatusConflict)
			}
			done := active.done
			s.mu.Unlock()
			select {
			case <-done:
				return active.result, active.err
			case <-ctx.Done():
				return nil, newCodedError("codex_reset_consume_timeout", "Codex 重置请求超时，结果需要核对", http.StatusGatewayTimeout)
			}
		}
		s.mu.Unlock()
		return nil, newCodedError("codex_reset_operation_in_progress", "", http.StatusConflict)
	}
	run := &activeRun{
		operationID:      opID,
		inventoryVersion: invVer,
		done:             make(chan struct{}),
	}
	s.activeRuns[normalizedRef] = run
	s.mu.Unlock()

	res, execErr := s.executeConsume(ctx, normalizedRef, opID, invVer)

	s.mu.Lock()
	run.result = res
	run.err = execErr
	if s.activeRuns[normalizedRef] == run {
		delete(s.activeRuns, normalizedRef)
	}
	close(run.done)
	s.mu.Unlock()

	if execErr == nil && isConfirmedReset(res) && s.onResetConfirmed != nil {
		s.onResetConfirmed(ctx, normalizedRef)
	}
	return res, execErr
}

func (s *Service) executeConsume(ctx context.Context, accountRef string, operationID string, inventoryVersion string) (*OperationEnvelope, error) {
	if s.transport == nil {
		return nil, newCodedError("codex_reset_service_unavailable", "Codex 重置传输层不可用", http.StatusServiceUnavailable)
	}
	if err := s.transport.AssertOAuthAccount(ctx, accountRef); err != nil {
		return nil, err
	}
	existingRaw, err := GetOperation(ctx, s.aiHomeDir, operationID)
	if err != nil {
		return nil, err
	}
	existing, err := s.recoverInterruptedOperation(ctx, accountRef, existingRaw)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.AccountRef != accountRef || existing.InventoryVersion != inventoryVersion {
			return nil, newCodedError("codex_reset_idempotency_conflict", "", http.StatusConflict)
		}
		return wrapOperation(existing), nil
	}
	activeOp, err := s.getActiveOperation(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	if activeOp != nil {
		code := "codex_reset_operation_in_progress"
		if activeOp.Status == "unknown" {
			code = "codex_reset_operation_unknown"
		}
		return nil, newCodedError(code, "", http.StatusConflict)
	}

	snap, err := s.fetchInventory(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	if !snap.Supported {
		return nil, newCodedError("codex_reset_not_supported", "当前 Codex 版本未返回重置卡库存", http.StatusBadRequest)
	}
	if snap.InventoryVersion != inventoryVersion {
		return nil, newCodedError("codex_reset_inventory_changed", "重置卡库存已变化，请刷新后重试", http.StatusConflict)
	}

	selectedCreditID := ""
	switch snap.SelectionMode {
	case "local":
		picked := SelectNextCredit(snap.Credits, snap.CapturedAt)
		if picked == nil {
			return nil, newCodedError("codex_reset_credit_unavailable", "没有可用的 Codex 重置卡", http.StatusConflict)
		}
		selectedCreditID = picked.CreditID
	case "upstream":
		selectedCreditID = ""
	default:
		return nil, newCodedError("codex_reset_credit_unavailable", "没有可用的 Codex 重置卡", http.StatusConflict)
	}

	created, reservedOp, err := ReserveOperation(
		ctx, s.aiHomeDir, operationID, accountRef, selectedCreditID, inventoryVersion, snap.AvailableCount, s.now().UnixMilli(),
	)
	if err != nil {
		return nil, err
	}
	if !created {
		return wrapOperation(reservedOp), nil
	}

	rpcCtx, cancel := context.WithTimeout(ctx, s.consumeTimeout)
	defer cancel()
	rpcRes, rpcErr := s.transport.ConsumeCredit(rpcCtx, accountRef, operationID, selectedCreditID)
	if rpcErr != nil {
		errCode, _, _ := ExtractError(rpcErr, "codex_reset_result_unknown")
		if errors.Is(rpcErr, context.DeadlineExceeded) {
			errCode = "codex_reset_consume_timeout"
		}
		unknownOp, markErr := MarkOperationUnknown(context.Background(), s.aiHomeDir, operationID, errCode, s.now().UnixMilli())
		if markErr != nil {
			return nil, markErr
		}
		return wrapOperation(unknownOp), nil
	}

	outcome, _ := rpcRes["outcome"].(string)
	outcome = strings.TrimSpace(outcome)
	if !isKnownOutcome(outcome) {
		unknownOp, markErr := MarkOperationUnknown(context.Background(), s.aiHomeDir, operationID, "codex_reset_outcome_unknown", s.now().UnixMilli())
		if markErr != nil {
			return nil, markErr
		}
		return wrapOperation(unknownOp), nil
	}

	var afterCount *int64
	if afterSnap, err := s.fetchInventory(ctx, accountRef); err == nil {
		val := int64(afterSnap.AvailableCount)
		afterCount = &val
	}
	completed, err := CompleteOperation(context.Background(), s.aiHomeDir, operationID, outcome, afterCount, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	return wrapOperation(completed), nil
}

// Reconcile 针对 unknown 状态操作用原幂等键向官方重新核对最终结果。
func (s *Service) Reconcile(ctx context.Context, accountRef string, operationID string) (*OperationEnvelope, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	opID, err := requireOperationID(operationID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	if active := s.activeRuns[normalizedRef]; active != nil {
		if active.operationID == opID {
			done := active.done
			s.mu.Unlock()
			select {
			case <-done:
				return active.result, active.err
			case <-ctx.Done():
				return nil, newCodedError("codex_reset_consume_timeout", "Codex 重置请求超时，结果需要核对", http.StatusGatewayTimeout)
			}
		}
		s.mu.Unlock()
		return nil, newCodedError("codex_reset_operation_in_progress", "", http.StatusConflict)
	}
	run := &activeRun{
		operationID: opID,
		done:        make(chan struct{}),
	}
	s.activeRuns[normalizedRef] = run
	s.mu.Unlock()

	res, execErr := s.executeReconcile(ctx, normalizedRef, opID)

	s.mu.Lock()
	run.result = res
	run.err = execErr
	if s.activeRuns[normalizedRef] == run {
		delete(s.activeRuns, normalizedRef)
	}
	close(run.done)
	s.mu.Unlock()

	if execErr == nil && isConfirmedReset(res) && s.onResetConfirmed != nil {
		s.onResetConfirmed(ctx, normalizedRef)
	}
	return res, execErr
}

func (s *Service) executeReconcile(ctx context.Context, accountRef string, operationID string) (*OperationEnvelope, error) {
	if s.transport == nil {
		return nil, newCodedError("codex_reset_service_unavailable", "Codex 重置传输层不可用", http.StatusServiceUnavailable)
	}
	if err := s.transport.AssertOAuthAccount(ctx, accountRef); err != nil {
		return nil, err
	}
	op, err := s.GetOperation(ctx, accountRef, operationID)
	if err != nil {
		return nil, err
	}
	if op.Status != "unknown" {
		return wrapOperation(op), nil
	}

	rpcCtx, cancel := context.WithTimeout(ctx, s.consumeTimeout)
	defer cancel()
	rpcRes, rpcErr := s.transport.ConsumeCredit(rpcCtx, accountRef, operationID, op.CreditID)
	if rpcErr != nil {
		errCode, _, _ := ExtractError(rpcErr, "codex_reset_result_unknown")
		if errors.Is(rpcErr, context.DeadlineExceeded) {
			errCode = "codex_reset_consume_timeout"
		}
		unknownOp, markErr := MarkOperationUnknown(context.Background(), s.aiHomeDir, operationID, errCode, s.now().UnixMilli())
		if markErr != nil {
			return nil, markErr
		}
		return wrapOperation(unknownOp), nil
	}

	outcome, _ := rpcRes["outcome"].(string)
	outcome = strings.TrimSpace(outcome)
	if !isKnownOutcome(outcome) {
		unknownOp, markErr := MarkOperationUnknown(context.Background(), s.aiHomeDir, operationID, "codex_reset_outcome_unknown", s.now().UnixMilli())
		if markErr != nil {
			return nil, markErr
		}
		return wrapOperation(unknownOp), nil
	}
	if outcome == "noCredit" {
		unknownOp, markErr := MarkOperationUnknown(context.Background(), s.aiHomeDir, operationID, "codex_reset_reconcile_no_credit", s.now().UnixMilli())
		if markErr != nil {
			return nil, markErr
		}
		return wrapOperation(unknownOp), nil
	}

	var afterCount *int64
	if afterSnap, err := s.fetchInventory(ctx, accountRef); err == nil {
		val := int64(afterSnap.AvailableCount)
		afterCount = &val
	}
	completed, err := CompleteOperation(context.Background(), s.aiHomeDir, operationID, outcome, afterCount, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	return wrapOperation(completed), nil
}
