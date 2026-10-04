package pluginruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

// 一致性测试：对着真实的 Node Plugin Host（lib/plugins/host）跑同一份线合同。找不到 node 时跳过。

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef"

type hostFixture struct {
	address string
	dir     string
	cmd     *exec.Cmd
}

func repoRoot(t testing.TB) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func startHost(t testing.TB) *hostFixture {
	t.Helper()
	shim, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found; plugin host conformance needs the Node host")
	}
	// PATH 上的 node 可能是版本管理器的转发 shim（Volta 等）：Kill 只会杀掉 shim，真正的 node
	// 变成孤儿并攥着管道。先问出真实可执行文件再直接启动它。
	resolved, err := exec.Command(shim, "-p", "process.execPath").Output()
	if err != nil {
		t.Fatalf("resolve node binary: %v", err)
	}
	node := strings.TrimSpace(string(resolved))
	root := repoRoot(t)
	base := "/tmp"
	if runtime.GOOS == "windows" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "aihg-")
	if err != nil {
		t.Fatal(err)
	}
	address := filepath.Join(dir, "h.sock")
	if runtime.GOOS == "windows" {
		address = `\\.\pipe\aih-plugin-gotest-` + filepath.Base(dir)
	}
	// --import 只接受 URL；Windows 上裸的 C:\ 路径会被当成 c: 协议拒绝。
	hooks := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(filepath.Join(root, "lib", "plugins", "host", "register-hooks.mjs")), "/")}).String()
	cmd := exec.Command(node, "--import", hooks,
		filepath.Join(root, "lib", "plugins", "host", "host-entry.mjs"))
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "SystemRoot=" + os.Getenv("SystemRoot"), "AIH_PLUGIN_SOCKET=" + address, "AIH_PLUGIN_TOKEN=" + testToken}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "plugin_host_ready") {
				close(ready)
				break
			}
		}
		for scanner.Scan() {
		}
	}()
	select {
	case <-ready:
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("plugin host did not become ready: %s", stderr.String())
	}
	fixture := &hostFixture{address: address, dir: dir, cmd: cmd}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.RemoveAll(dir)
	})
	return fixture
}

func copySample(t testing.TB, fixture *hostFixture) map[string]any {
	t.Helper()
	source := filepath.Join(repoRoot(t), "examples", "plugins", "echo")
	target := filepath.Join(fixture.dir, "echo")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"plugin.json", "index.mjs", "package.json"} {
		data, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var manifest map[string]any
	data, _ := os.ReadFile(filepath.Join(target, "plugin.json"))
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"instanceId": "echo", "manifest": manifest, "entryPath": filepath.Join(target, "index.mjs")}
}

func dialReady(t testing.TB, fixture *hostFixture) *Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, fixture.address, DialOptions{Token: testToken})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func activateSample(t testing.TB, fixture *hostFixture, client *Client) {
	t.Helper()
	ctx := context.Background()
	prepared, err := client.Call(ctx, "prepare", map[string]any{"generation": 1, "plugins": []any{copySample(t, fixture)}}, nil)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if !strings.Contains(string(prepared.Value), `"prepared"`) {
		t.Fatalf("prepare rejected: %s", prepared.Value)
	}
	if _, err := client.Call(ctx, "activate", map[string]any{"generation": 1}, nil); err != nil {
		t.Fatalf("activate: %v", err)
	}
}

func TestRoundTripWithBoundedPayload(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	activateSample(t, fixture, client)

	payload := bytes.Repeat([]byte{0xab}, plugincontract.MaxPayloadBytes)
	result, err := client.Call(context.Background(), "invoke", map[string]any{"contributionId": "sample.echo.call", "value": map[string]any{"from": "go"}}, payload)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	var value struct {
		Echoed map[string]string `json:"echoed"`
		Bytes  int               `json:"bytes"`
	}
	if err := json.Unmarshal(result.Value, &value); err != nil {
		t.Fatal(err)
	}
	if value.Echoed["from"] != "go" || value.Bytes != len(payload) || !bytes.Equal(result.Payload, payload) {
		t.Fatalf("unexpected echo: value=%s payload=%d", result.Value, len(result.Payload))
	}
	_, err = client.Call(context.Background(), "invoke", map[string]any{"contributionId": "sample.echo.call"}, make([]byte, plugincontract.MaxPayloadBytes+1))
	if Code(err) != plugincontract.CodeRpcPayloadLimit {
		t.Fatalf("oversized payload should be rejected, got %v", err)
	}
}

func TestCancellationAndDeadlineReachTheHandler(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	activateSample(t, fixture, client)

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(30*time.Millisecond, cancel)
	if _, err := client.Call(ctx, "invoke", map[string]any{"contributionId": "sample.echo.wait"}, nil); Code(err) != plugincontract.CodeRpcCancelled {
		t.Fatalf("expected cancelled, got %v", err)
	}
	timeoutCtx, cancelTimeout := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancelTimeout()
	if _, err := client.Call(timeoutCtx, "invoke", map[string]any{"contributionId": "sample.echo.wait"}, nil); Code(err) != plugincontract.CodeRpcTimeout {
		t.Fatalf("expected timeout, got %v", err)
	}
	time.Sleep(80 * time.Millisecond)
	stats, err := client.Call(context.Background(), "invoke", map[string]any{"contributionId": "sample.echo.stats"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var observed struct {
		Aborts int `json:"aborts"`
	}
	_ = json.Unmarshal(stats.Value, &observed)
	if observed.Aborts != 2 {
		t.Fatalf("handler should observe both aborts, stats=%s", stats.Value)
	}
}

func TestIncompatibleVersionAndBadToken(t *testing.T) {
	fixture := startHost(t)
	ctx := context.Background()
	_, err := Dial(ctx, fixture.address, DialOptions{Token: testToken, ProtocolVersion: plugincontract.MaxProtocolVersion + 1})
	var pluginErr *Error
	if Code(err) != plugincontract.CodeRpcIncompatible {
		t.Fatalf("expected incompatible, got %v", err)
	}
	if ok := asError(err, &pluginErr); !ok || pluginErr.Supported == nil || pluginErr.Supported.Max != plugincontract.MaxProtocolVersion {
		t.Fatalf("incompatible reply must carry the supported range: %+v", pluginErr)
	}
	if _, err := Dial(ctx, fixture.address, DialOptions{Token: strings.Repeat("e", len(testToken))}); Code(err) != plugincontract.CodeRpcClosed {
		t.Fatalf("bad token should just be disconnected, got %v", err)
	}
}

func TestOversizedFrameClosesTheConnectionWithAReason(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	header := make([]byte, headerBytes)
	binary.BigEndian.PutUint32(header[0:4], 16)
	binary.BigEndian.PutUint64(header[4:12], uint64(plugincontract.MaxPayloadBytes+1))
	if err := client.write(header); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := client.Call(ctx, "status", nil, nil)
	// 宿主先用 id=transport 告知原因再断开：客户端拿到的是具体的超限原因，而不只是 EOF。
	if Code(err) != plugincontract.CodeRpcPayloadLimit {
		t.Fatalf("expected the host to report the payload limit before disconnecting, got %v", err)
	}
}

func TestConcurrentCalls(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	activateSample(t, fixture, client)
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for index := 0; index < 32; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			payload := []byte(fmt.Sprintf("payload-%d", index))
			result, err := client.Call(context.Background(), "invoke", map[string]any{"contributionId": "sample.echo.call", "value": index}, payload)
			if err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(result.Payload, payload) {
				errs <- fmt.Errorf("call %d got payload %q", index, result.Payload)
			}
		}(index)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func asError(err error, target **Error) bool {
	value, ok := err.(*Error)
	if ok {
		*target = value
	}
	return ok
}

// 插件同步占满 CPU 时宿主不读 socket：大 payload 的写入会阻塞在发送缓冲上。
// 调用必须在自己的期限附近返回超时，不能被卡住的宿主拖住。
func TestStalledHostCannotHoldAWritePastTheDeadline(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	busyDir := filepath.Join(fixture.dir, "busy")
	if err := os.MkdirAll(busyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"manifestVersion":1,"protocolVersion":1,"pluginId":"aih.test.busy","version":"0.1.0","engines":{"aih":">=1.0.0"},"runtime":"node","entry":"index.mjs","contributes":[{"id":"busy.spin","capability":"command","version":1}]}`
	source := "export default { apply(ctx) { ctx.aih.register('busy.spin', () => { const end = Date.now() + 1500; while (Date.now() < end) {} return 'done'; }); } };"
	if err := os.WriteFile(filepath.Join(busyDir, "plugin.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(busyDir, "index.mjs"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	_ = json.Unmarshal([]byte(manifest), &parsed)
	ctx := context.Background()
	if _, err := client.Call(ctx, "prepare", map[string]any{"generation": 1, "plugins": []any{
		map[string]any{"instanceId": "busy", "manifest": parsed, "entryPath": filepath.Join(busyDir, "index.mjs")},
	}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Call(ctx, "activate", map[string]any{"generation": 1}, nil); err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = client.Call(context.Background(), "invoke", map[string]any{"contributionId": "busy.spin"}, nil)
	}()
	time.Sleep(100 * time.Millisecond)

	deadlineCtx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := client.Call(deadlineCtx, "invoke", map[string]any{"contributionId": "busy.spin"}, bytes.Repeat([]byte{1}, plugincontract.MaxPayloadBytes))
	elapsed := time.Since(started)
	if Code(err) != plugincontract.CodeRpcTimeout {
		t.Fatalf("expected timeout from a stalled host, got %v after %s", err, elapsed)
	}
	if elapsed > 700*time.Millisecond {
		t.Fatalf("call outlived its 200ms deadline by too much: %s", elapsed)
	}
}

// Go 数据面 → Node Plugin Host 的往返开销（单连接串行调用，含 JSON 编解码与插件 handler）。
func BenchmarkCallSmall(b *testing.B) {
	benchmarkCall(b, nil)
}

func BenchmarkCall1MiBPayload(b *testing.B) {
	benchmarkCall(b, bytes.Repeat([]byte{7}, 1<<20))
}

func benchmarkCall(b *testing.B, payload []byte) {
	fixture := startHost(b)
	client := dialReady(b, fixture)
	activateSample(b, fixture, client)
	request := map[string]any{"contributionId": "sample.echo.call", "value": map[string]any{"model": "gpt-x"}}
	b.SetBytes(int64(len(payload)) * 2)
	b.ResetTimer()
	for b.Loop() {
		if _, err := client.Call(context.Background(), "invoke", request, payload); err != nil {
			b.Fatal(err)
		}
	}
}

// Go 网关还不提供 gateway.next：中间件在 Go 发起的调用里调用 next() 必须立刻得到 method_unknown，
// 而不是让宿主空等到 deadline。
func TestReverseCallsFromTheHostAreRefusedImmediately(t *testing.T) {
	fixture := startHost(t)
	client := dialReady(t, fixture)
	target := filepath.Join(fixture.dir, "attempt")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"manifestVersion": 1, "protocolVersion": 1, "pluginId": "aih.test.go-attempt", "version": "0.1.0",
		"engines": map[string]any{"aih": ">=1.0.0"}, "runtime": "node", "entry": "index.mjs",
		"contributes": []any{map[string]any{"id": "attempt.go", "capability": "gateway.attempt", "version": 1}},
	}
	encoded, _ := json.Marshal(manifest)
	source := `export default { apply(ctx) { ctx.aih.register('attempt.go', async (value, context) => {
  try { await context.next(); return 'unexpected'; } catch (error) { return error.code; }
}); } };`
	for name, data := range map[string][]byte{"plugin.json": encoded, "index.mjs": []byte(source), "package.json": []byte(`{"type":"module"}`)} {
		if err := os.WriteFile(filepath.Join(target, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	prepared, err := client.Call(ctx, "prepare", map[string]any{"generation": 1, "plugins": []any{map[string]any{"instanceId": "go-attempt", "manifest": manifest, "entryPath": filepath.Join(target, "index.mjs")}}}, nil)
	if err != nil || !strings.Contains(string(prepared.Value), `"prepared"`) {
		t.Fatalf("prepare: %v %s", err, prepared.Value)
	}
	if _, err := client.Call(ctx, "activate", map[string]any{"generation": 1}, nil); err != nil {
		t.Fatalf("activate: %v", err)
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	started := time.Now()
	result, err := client.Call(callCtx, "invoke", map[string]any{"contributionId": "attempt.go", "value": map[string]any{}}, nil)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(result.Value) != `"`+plugincontract.CodeRpcMethodUnknown+`"` {
		t.Fatalf("next() under a Go invoke should fail with method_unknown, got %s", result.Value)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("refusal should be immediate, took %s", elapsed)
	}
}
