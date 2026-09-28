package claudenativerelay

import (
	"errors"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestReportDisconnectDistinguishesUpstreamAndClient 验证只有未完成的流才上报，
// 并区分上游中途断开与客户端一侧断开。
func TestReportDisconnectDistinguishesUpstreamAndClient(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, "claude-opus-5-5")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	now := time.Unix(1_790_000_000, 0)
	var events []StreamDisconnect
	handler := &Handler{
		clock:       func() time.Time { return now },
		disconnects: func(event StreamDisconnect) { events = append(events, event) },
	}
	started := now.Add(-42 * time.Second)
	handler.reportDisconnect(route, started, responseCopyResult{upstreamErr: errors.New("read: connection reset by peer")}, nativeStreamObservation{})
	handler.reportDisconnect(route, started, responseCopyResult{downstreamErr: errors.New("broken pipe")}, nativeStreamObservation{})
	handler.reportDisconnect(route, started, responseCopyResult{upstreamErr: errors.New("late eof")}, nativeStreamObservation{completed: true})
	handler.reportDisconnect(route, started, responseCopyResult{}, nativeStreamObservation{})
	if len(events) != 2 ||
		events[0].Side != StreamDisconnectUpstream ||
		events[0].Elapsed != 42*time.Second ||
		events[0].AccountRef != accountRef.String() ||
		events[1].Side != StreamDisconnectClient {
		t.Fatalf("events = %#v", events)
	}
}
