package clauderelay_test

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/clauderelay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const leaseModel = "claude-opus-5"

// TestLeaseRegistryBindsExpiresAndRevokesTokens 验证租约只解析到签发账号模型。
func TestLeaseRegistryBindsExpiresAndRevokesTokens(t *testing.T) {
	t.Parallel()

	clock := &leaseClock{
		now: time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC),
	}
	registry := newLeaseRegistry(t, clock, 2)
	accountRef := mustLeaseAccountRef(t, "acct_1234567890abcdef1234")

	modelID := mustLeaseModelID(t)
	lease, err := registry.Issue(accountRef, modelID)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	resolved, resolvedModel, found := registry.ConsumeRelayToken(lease.Token())
	if !lease.IsValid() ||
		!found ||
		resolved != accountRef ||
		resolvedModel != modelID ||
		lease.AccountRef() != accountRef ||
		lease.ModelID() != modelID ||
		lease.ExpiresAt() != clock.now.Add(time.Hour) {
		t.Fatalf(
			"lease=%#v resolved=%s found=%t",
			lease,
			resolved,
			found,
		)
	}
	if _, _, found := registry.ConsumeRelayToken("unknown-token"); found {
		t.Fatal("未知 Token 被错误解析")
	}
	if _, _, found := registry.ConsumeRelayToken(lease.Token()); found {
		t.Fatal("已经消费的 Token 仍然有效")
	}

	expiring, err := registry.Issue(accountRef, modelID)
	if err != nil {
		t.Fatalf("Issue(expiring) error = %v", err)
	}
	clock.advance(time.Hour)
	if _, _, found := registry.ConsumeRelayToken(expiring.Token()); found {
		t.Fatal("到期 Token 仍然有效")
	}
}

// TestLeaseRegistryPrunesBeforeCapacityCheck 验证过期项不占用有界容量。
func TestLeaseRegistryPrunesBeforeCapacityCheck(t *testing.T) {
	t.Parallel()

	clock := &leaseClock{
		now: time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC),
	}
	registry := newLeaseRegistry(t, clock, 1)
	accountRef := mustLeaseAccountRef(t, "acct_1234567890abcdef1234")
	modelID := mustLeaseModelID(t)
	if _, err := registry.Issue(accountRef, modelID); err != nil {
		t.Fatalf("Issue(first) error = %v", err)
	}
	if _, err := registry.Issue(accountRef, modelID); !errors.Is(
		err,
		clauderelay.ErrLeaseCapacity,
	) {
		t.Fatalf("Issue(capacity) error = %v", err)
	}
	clock.advance(time.Hour)
	if _, err := registry.Issue(accountRef, modelID); err != nil {
		t.Fatalf("Issue(after expiry) error = %v", err)
	}
}

// TestLeaseRegistrySupportsConcurrentResolution 验证读写并发没有数据竞争。
func TestLeaseRegistrySupportsConcurrentResolution(t *testing.T) {
	t.Parallel()

	clock := &leaseClock{
		now: time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC),
	}
	registry := newLeaseRegistry(t, clock, 128)
	accountRef := mustLeaseAccountRef(t, "acct_1234567890abcdef1234")
	modelID := mustLeaseModelID(t)
	leases := make([]clauderelay.Lease, 32)
	for index := range leases {
		lease, err := registry.Issue(accountRef, modelID)
		if err != nil {
			t.Fatalf("Issue(%d) error = %v", index, err)
		}
		leases[index] = lease
	}

	var wait sync.WaitGroup
	for _, lease := range leases {
		lease := lease
		wait.Add(2)
		go func() {
			defer wait.Done()
			resolved, resolvedModel, found := registry.ConsumeRelayToken(
				lease.Token(),
			)
			if !found || resolved != accountRef || resolvedModel != modelID {
				t.Errorf(
					"ConsumeRelayToken()=%s,%s,%t",
					resolved,
					resolvedModel,
					found,
				)
			}
		}()
		go func() {
			defer wait.Done()
			reissued, err := registry.Issue(accountRef, modelID)
			if err == nil {
				registry.Revoke(reissued.Token())
			}
		}()
	}
	wait.Wait()
}

// mustLeaseModelID 创建请求级租约绑定的真实模型。
func mustLeaseModelID(t *testing.T) runtimecore.ModelID {
	t.Helper()
	modelID, err := runtimecore.NewModelID(leaseModel)
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	return modelID
}

// TestNewLeaseRegistryRejectsInvalidDependencies 验证边界不会被绕过。
func TestNewLeaseRegistryRejectsInvalidDependencies(t *testing.T) {
	t.Parallel()

	validClock := func() time.Time {
		return time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC)
	}
	tests := []clauderelay.Dependencies{
		{Clock: validClock},
		{Random: bytes.NewReader(make([]byte, 64))},
		{
			Random: bytes.NewReader(make([]byte, 64)),
			Clock:  validClock,
			TTL:    time.Second,
		},
		{
			Random:    bytes.NewReader(make([]byte, 64)),
			Clock:     validClock,
			MaxLeases: -1,
		},
	}
	for index, dependencies := range tests {
		if _, err := clauderelay.NewLeaseRegistry(
			dependencies,
		); !errors.Is(err, clauderelay.ErrInvalidDependencies) {
			t.Fatalf("NewLeaseRegistry(case %d) error = %v", index, err)
		}
	}
}

// newLeaseRegistry 创建使用确定随机流的一小时测试 Registry。
func newLeaseRegistry(
	t *testing.T,
	clock *leaseClock,
	maxLeases int,
) *clauderelay.LeaseRegistry {
	t.Helper()

	random := make([]byte, 32*512)
	for index := range random {
		random[index] = byte(index%251 + 1)
	}
	registry, err := clauderelay.NewLeaseRegistry(clauderelay.Dependencies{
		Random:    bytes.NewReader(random),
		Clock:     clock.current,
		TTL:       time.Hour,
		MaxLeases: maxLeases,
	})
	if err != nil {
		t.Fatalf("NewLeaseRegistry() error = %v", err)
	}
	return registry
}

// mustLeaseAccountRef 创建稳定测试账号身份。
func mustLeaseAccountRef(
	t *testing.T,
	value string,
) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("accounts.ParseAccountRef() error = %v", err)
	}
	return accountRef
}

// leaseClock 提供并发安全的可推进测试时钟。
type leaseClock struct {
	mu  sync.Mutex
	now time.Time
}

// current 返回当前 UTC 时间。
func (clock *leaseClock) current() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

// advance 推进测试时间。
func (clock *leaseClock) advance(duration time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(duration)
	clock.mu.Unlock()
}
