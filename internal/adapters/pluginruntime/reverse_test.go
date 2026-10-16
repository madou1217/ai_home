package pluginruntime

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

// 反向调用（协议 v2）的传输层测试：用一个最小线合同对端精确控制父调用与子调用的时序，
// 覆盖真实宿主难以构造的边界（parent_unknown、没有 onCall、父调用结束即取消子调用）。
// 真实宿主 + 真实 Go 的端到端覆盖在 test/plugin-gateway-go.test.js。

type fakeHostConn struct {
	conn    net.Conn
	writeMu sync.Mutex
}

func (host *fakeHostConn) send(message plugincontract.Message, payload []byte) error {
	host.writeMu.Lock()
	defer host.writeMu.Unlock()
	encoded, err := encodeFrame(message, payload)
	if err != nil {
		return err
	}
	_, err = host.conn.Write(encoded)
	return err
}

func (host *fakeHostConn) read() (frame, error) { return readFrame(host.conn) }

// callBack 在父调用 parent 名下发起一次反向调用并等回帧。
func (host *fakeHostConn) callBack(id string, parent string, method string, deadlineMs int64) (frame, error) {
	message := plugincontract.Message{
		Kind:            plugincontract.KindCall,
		ProtocolVersion: plugincontract.ProtocolVersion,
		ID:              id,
		Parent:          parent,
		Method:          method,
		Value:           json.RawMessage("null"),
	}
	if deadlineMs > 0 {
		message.Deadline = time.Now().Add(time.Duration(deadlineMs) * time.Millisecond).UnixMilli()
	}
	if err := host.send(message, nil); err != nil {
		return frame{}, err
	}
	return host.read()
}

func serveFakeHost(conn net.Conn, handler func(host *fakeHostConn)) {
	defer func() { _ = conn.Close() }()
	host := &fakeHostConn{conn: conn}
	incoming, err := host.read()
	if err != nil || incoming.message.Kind != plugincontract.KindHello {
		return
	}
	if err := host.send(plugincontract.Message{
		Kind:            plugincontract.KindHelloResult,
		ProtocolVersion: plugincontract.ProtocolVersion,
		ID:              incoming.message.ID,
		Value:           json.RawMessage(`{"protocolVersion":2}`),
	}, nil); err != nil {
		return
	}
	handler(host)
}

// startFakeHost 起一个最小对端，返回它的地址。
func startFakeHost(t testing.TB, handler func(host *fakeHostConn)) string {
	t.Helper()
	base := "/tmp"
	if runtime.GOOS == "windows" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "aihrev-")
	if err != nil {
		t.Fatal(err)
	}
	address := filepath.Join(dir, "h.sock")
	if runtime.GOOS == "windows" {
		address = `\\.\pipe\aih-plugin-reverse-` + filepath.Base(dir)
	}
	listener, err := listenFakeHost(address)
	if err != nil {
		_ = os.RemoveAll(dir)
		t.Fatalf("listen fake host: %v", err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.RemoveAll(dir)
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveFakeHost(conn, handler)
		}
	}()
	return address
}

func dialFakeHost(t testing.TB, address string) *Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, DialOptions{Token: testToken})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestReverseCallRoundTripDeliversTheClientValue(t *testing.T) {
	replies := make(chan frame, 1)
	address := startFakeHost(t, func(host *fakeHostConn) {
		incoming, err := host.read()
		if err != nil {
			return
		}
		reply, err := host.callBack("child-1", incoming.message.ID, "gateway.next", 2000)
		if err == nil {
			replies <- reply
		}
		_ = host.send(plugincontract.Message{
			Kind:            plugincontract.KindResult,
			ProtocolVersion: plugincontract.ProtocolVersion,
			ID:              incoming.message.ID,
			Value:           json.RawMessage("null"),
		}, nil)
	})
	client := dialFakeHost(t, address)

	result, err := client.CallWith(context.Background(), "invoke", map[string]any{"contributionId": "a.attempt"}, nil, CallOptions{
		OnCall: func(_ context.Context, method string, _ json.RawMessage) (any, error) {
			if method != "gateway.next" {
				t.Errorf("method=%q", method)
			}
			return map[string]any{"committed": true, "outcome": "committed"}, nil
		},
	})
	if err != nil || string(result.Value) != "null" {
		t.Fatalf("invoke: value=%s err=%v", result.Value, err)
	}
	select {
	case reply := <-replies:
		if reply.message.Kind != plugincontract.KindResult {
			t.Fatalf("child reply kind=%s", reply.message.Kind)
		}
		var value map[string]any
		if err := json.Unmarshal(reply.message.Value, &value); err != nil {
			t.Fatal(err)
		}
		if value["committed"] != true || value["outcome"] != "committed" {
			t.Fatalf("child value=%v", value)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("反向调用没有回帧")
	}
	if pending, parked := client.Pending(); pending != 0 || parked != 0 {
		t.Fatalf("调用结束后不应残留在途调用：pending=%d parked=%d", pending, parked)
	}
}

func TestReverseCallErrorsUseTheContractCodes(t *testing.T) {
	for name, testCase := range map[string]struct {
		unknownParent bool
		withOnCall    bool
		want          string
	}{
		"unknown-parent":      {unknownParent: true, withOnCall: true, want: plugincontract.CodeRpcParentUnknown},
		"call-without-onCall": {withOnCall: false, want: plugincontract.CodeRpcMethodUnknown},
	} {
		replies := make(chan frame, 1)
		address := startFakeHost(t, func(host *fakeHostConn) {
			incoming, err := host.read()
			if err != nil {
				return
			}
			parent := incoming.message.ID
			if testCase.unknownParent {
				parent = "no-such-call"
			}
			reply, err := host.callBack("child-1", parent, "gateway.next", 2000)
			if err == nil {
				replies <- reply
			}
			_ = host.send(plugincontract.Message{
				Kind:            plugincontract.KindResult,
				ProtocolVersion: plugincontract.ProtocolVersion,
				ID:              incoming.message.ID,
				Value:           json.RawMessage("null"),
			}, nil)
		})
		client := dialFakeHost(t, address)
		options := CallOptions{}
		if testCase.withOnCall {
			options.OnCall = func(context.Context, string, json.RawMessage) (any, error) {
				t.Errorf("%s: 不该调用 onCall", name)
				return nil, nil
			}
		}
		if _, err := client.CallWith(context.Background(), "invoke", map[string]any{}, nil, options); err != nil {
			t.Fatalf("%s: invoke: %v", name, err)
		}
		select {
		case reply := <-replies:
			if reply.message.Kind != plugincontract.KindError || reply.message.Error == nil {
				t.Fatalf("%s: reply=%+v", name, reply.message)
			}
			if reply.message.Error.Code != testCase.want {
				t.Fatalf("%s: code=%q want=%q", name, reply.message.Error.Code, testCase.want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: 反向调用没有回帧", name)
		}
	}
}

func TestReverseCallHandlerErrorIsReportedToTheHost(t *testing.T) {
	replies := make(chan frame, 1)
	address := startFakeHost(t, func(host *fakeHostConn) {
		incoming, err := host.read()
		if err != nil {
			return
		}
		reply, err := host.callBack("child-1", incoming.message.ID, "gateway.next", 2000)
		if err == nil {
			replies <- reply
		}
		_ = host.send(plugincontract.Message{
			Kind:            plugincontract.KindResult,
			ProtocolVersion: plugincontract.ProtocolVersion,
			ID:              incoming.message.ID,
			Value:           json.RawMessage("null"),
		}, nil)
	})
	client := dialFakeHost(t, address)
	if _, err := client.CallWith(context.Background(), "invoke", map[string]any{}, nil, CallOptions{
		OnCall: func(context.Context, string, json.RawMessage) (any, error) {
			return nil, &Error{Code: plugincontract.CodeNextCalledTwice, Message: "next() 在一次调用中只能调用一次"}
		},
	}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	select {
	case reply := <-replies:
		if reply.message.Error == nil || reply.message.Error.Code != plugincontract.CodeNextCalledTwice {
			t.Fatalf("reply=%+v", reply.message)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("反向调用没有回帧")
	}
}

func TestReverseCallContextEndsWhenTheParentSettles(t *testing.T) {
	settled := make(chan error, 1)
	release := make(chan struct{})
	address := startFakeHost(t, func(host *fakeHostConn) {
		incoming, err := host.read()
		if err != nil {
			return
		}
		// 子调用发出后不等结果：父调用会被客户端取消，宿主侧本来也会取消它。
		_ = host.send(plugincontract.Message{
			Kind:            plugincontract.KindCall,
			ProtocolVersion: plugincontract.ProtocolVersion,
			ID:              "child-1",
			Parent:          incoming.message.ID,
			Method:          "gateway.next",
			Value:           json.RawMessage("null"),
		}, nil)
		<-release
	})
	client := dialFakeHost(t, address)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_, _ = client.CallWith(ctx, "invoke", map[string]any{}, nil, CallOptions{
			OnCall: func(reverseCtx context.Context, _ string, _ json.RawMessage) (any, error) {
				<-reverseCtx.Done()
				settled <- reverseCtx.Err()
				return nil, nil
			},
		})
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-settled:
		if err == nil {
			t.Fatal("父调用结束后反向调用必须被取消")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("反向调用没有被取消")
	}
	close(release)
	<-done
	if pending, parked := client.Pending(); pending != 0 || parked != 0 {
		t.Fatalf("取消后不应残留：pending=%d parked=%d", pending, parked)
	}
}
