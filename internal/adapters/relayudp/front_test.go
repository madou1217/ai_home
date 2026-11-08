package relayudp

import (
	"net"
	"testing"
	"time"
)

// sentDatagram 记录一次转发，用来断言去向与内容。
type sentDatagram struct {
	payload string
	to      string
}

func mustAddr(t *testing.T, value string) *net.UDPAddr {
	t.Helper()
	addr, err := net.ResolveUDPAddr("udp4", value)
	if err != nil {
		t.Fatalf("ResolveUDPAddr(%q) error = %v", value, err)
	}
	return addr
}

// newStartedFront 起一个真实 socket 的前端（只有绑定后 AddAssociation 才被接受），
// 但路由断言仍走注入的 send，不依赖收发时序。
func newStartedFront(t *testing.T, cfg Config) *Front {
	t.Helper()
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	cfg.Port = 0
	front := New(cfg)
	if err := front.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		if err := front.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	return front
}

func collectSender(sent *[]sentDatagram) func([]byte, *net.UDPAddr) {
	return func(payload []byte, to *net.UDPAddr) {
		*sent = append(*sent, sentDatagram{payload: string(payload), to: to.String()})
	}
}

func lockedClient(front *Front, id string) string {
	front.mu.Lock()
	defer front.mu.Unlock()
	assoc := front.byID[id]
	if assoc == nil {
		return ""
	}
	return assoc.clientKey
}

func TestHandleDatagramRouting(t *testing.T) {
	const (
		sidecarA = "127.0.0.1:51001"
		sidecarB = "127.0.0.1:51002"
		client1  = "192.168.31.20:40001"
		client2  = "192.168.31.21:40002"
	)
	type associationSpec struct {
		id  string
		bnd string
	}
	type step struct {
		from    string
		payload string
	}

	cases := []struct {
		name         string
		associations []associationSpec
		steps        []step
		want         []sentDatagram
		wantLocked   map[string]string
	}{
		{
			name:         "唯一未锁定关联：首报锁定并双向转发",
			associations: []associationSpec{{"assoc-1", sidecarA}},
			steps: []step{
				{client1, "q1"},
				{client1, "q2"},
				{sidecarA, "r1"},
			},
			want: []sentDatagram{
				{"q1", sidecarA},
				{"q2", sidecarA},
				{"r1", client1},
			},
			wantLocked: map[string]string{"assoc-1": client1},
		},
		{
			name:         "锁定之后其他客户端来源一律丢弃",
			associations: []associationSpec{{"assoc-1", sidecarA}},
			steps: []step{
				{client1, "q1"},
				{client2, "q2"},
			},
			want:       []sentDatagram{{"q1", sidecarA}},
			wantLocked: map[string]string{"assoc-1": client1},
		},
		{
			name:         "多个未锁定关联：歧义丢弃，不猜",
			associations: []associationSpec{{"assoc-1", sidecarA}, {"assoc-2", sidecarB}},
			steps: []step{
				{client1, "q1"},
			},
			want: nil,
		},
		{
			name:  "没有关联：丢弃",
			steps: []step{{client1, "q1"}},
			want:  nil,
		},
		{
			name:         "客户端未锁定时边车回程：丢弃",
			associations: []associationSpec{{"assoc-1", sidecarA}},
			steps: []step{
				{sidecarA, "r1"},
			},
			want: nil,
		},
		{
			name:         "边车回程不会改写锁定关系",
			associations: []associationSpec{{"assoc-1", sidecarA}},
			steps: []step{
				{client1, "q1"},
				{sidecarA, "r1"},
				{client2, "q2"},
			},
			want: []sentDatagram{
				{"q1", sidecarA},
				{"r1", client1},
			},
			wantLocked: map[string]string{"assoc-1": client1},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			front := newStartedFront(t, Config{Now: func() time.Time { return time.Unix(0, 0) }})
			for _, spec := range tc.associations {
				bnd := mustAddr(t, spec.bnd)
				if !front.AddAssociation(spec.id, BND{Host: bnd.IP.String(), Port: bnd.Port}) {
					t.Fatalf("AddAssociation(%q, %q) = false", spec.id, spec.bnd)
				}
			}

			var sent []sentDatagram
			send := collectSender(&sent)
			for _, step := range tc.steps {
				front.handleDatagram([]byte(step.payload), mustAddr(t, step.from), send)
			}

			if len(sent) != len(tc.want) {
				t.Fatalf("转发次数 = %d (%+v), want %d (%+v)", len(sent), sent, len(tc.want), tc.want)
			}
			for index := range sent {
				if sent[index] != tc.want[index] {
					t.Errorf("第 %d 次转发 = %+v, want %+v", index+1, sent[index], tc.want[index])
				}
			}
			if front.AssociationCount() != len(tc.associations) {
				t.Errorf("关联数 = %d, want %d", front.AssociationCount(), len(tc.associations))
			}
			for _, spec := range tc.associations {
				if got := lockedClient(front, spec.id); got != tc.wantLocked[spec.id] {
					t.Errorf("%s 锁定的客户端 = %q, want %q", spec.id, got, tc.wantLocked[spec.id])
				}
			}
		})
	}
}

func TestIdleReap(t *testing.T) {
	base := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

	t.Run("空闲满 120s 回收并清空两张表", func(t *testing.T) {
		clock := base
		front := newStartedFront(t, Config{Now: func() time.Time { return clock }})
		var sent []sentDatagram
		send := collectSender(&sent)

		if !front.AddAssociation("assoc-1", BND{Host: "127.0.0.1", Port: 51001}) {
			t.Fatal("AddAssociation(assoc-1) = false")
		}
		front.handleDatagram([]byte("q1"), mustAddr(t, "192.168.31.20:40001"), send)
		if !front.AddAssociation("assoc-2", BND{Host: "127.0.0.1", Port: 51002}) {
			t.Fatal("AddAssociation(assoc-2) = false")
		}
		front.handleDatagram([]byte("q2"), mustAddr(t, "192.168.31.21:40002"), send)
		if front.AssociationCount() != 2 {
			t.Fatalf("关联数 = %d, want 2", front.AssociationCount())
		}

		clock = base.Add(DefaultIdleTimeout - time.Second)
		if reaped := front.ReapIdle(); reaped != 0 {
			t.Errorf("未到期就回收了 %d 条", reaped)
		}

		// 与 Node 同口径：恰好 120s（lastUsed == deadline）算到期。
		clock = base.Add(DefaultIdleTimeout)
		if reaped := front.ReapIdle(); reaped != 2 {
			t.Errorf("回收数 = %d, want 2", reaped)
		}
		if front.AssociationCount() != 0 {
			t.Errorf("回收后关联数 = %d, want 0", front.AssociationCount())
		}
		front.mu.Lock()
		remaining := len(front.bySidecar) + len(front.byClient)
		front.mu.Unlock()
		if remaining != 0 {
			t.Errorf("回收后仍残留 %d 条索引", remaining)
		}

		sent = nil
		front.handleDatagram([]byte("q3"), mustAddr(t, "192.168.31.20:40001"), send)
		if len(sent) != 0 {
			t.Errorf("关联已回收却仍转发了 %+v", sent)
		}
	})

	t.Run("有数据报往来就刷新空闲计时", func(t *testing.T) {
		clock := base
		front := newStartedFront(t, Config{Now: func() time.Time { return clock }})
		var sent []sentDatagram
		send := collectSender(&sent)
		client := mustAddr(t, "192.168.31.20:40001")

		if !front.AddAssociation("assoc-1", BND{Host: "127.0.0.1", Port: 51001}) {
			t.Fatal("AddAssociation(assoc-1) = false")
		}
		front.handleDatagram([]byte("q1"), client, send)

		clock = base.Add(100 * time.Second)
		front.handleDatagram([]byte("q2"), client, send)

		// 距上次活动 100s：虽然距登记已经 200s，仍不该回收。
		clock = base.Add(200 * time.Second)
		if reaped := front.ReapIdle(); reaped != 0 {
			t.Errorf("活动后仍被回收了 %d 条", reaped)
		}
		clock = base.Add(219 * time.Second)
		if reaped := front.ReapIdle(); reaped != 0 {
			t.Errorf("未到期就回收了 %d 条", reaped)
		}
		clock = base.Add(220 * time.Second)
		if reaped := front.ReapIdle(); reaped != 1 {
			t.Errorf("到期回收数 = %d, want 1", reaped)
		}
	})
}

func TestAdvertiseBND(t *testing.T) {
	cases := []struct {
		name          string
		advertiseHost string
		advertisePort int
		fallbackHost  string
		wantHost      string
		wantPort      int // 0 表示「用实际绑定端口」
	}{
		{"默认用客户端连过来的地址和绑定端口", "", 0, "10.0.0.5", "10.0.0.5", 0},
		{"advertiseHost 覆盖 1:1 NAT 的内侧地址", "relay.example.com", 0, "10.0.0.5", "relay.example.com", 0},
		{"advertisePort 覆盖 frp 转发端口", "", 29527, "10.0.0.5", "10.0.0.5", 29527},
		{"主机与端口都钉住", "relay.example.com", 29527, "10.0.0.5", "relay.example.com", 29527},
		{"没有可用的客户端地址", "", 0, "", "", 0},
		{"空白会被裁掉", "  relay.example.com  ", 0, "  ", "relay.example.com", 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			front := newStartedFront(t, Config{
				AdvertiseHost: tc.advertiseHost,
				AdvertisePort: tc.advertisePort,
			})
			boundPort := front.BoundPort()
			if boundPort <= 0 {
				t.Fatalf("BoundPort() = %d, want > 0", boundPort)
			}
			wantPort := tc.wantPort
			if wantPort == 0 {
				wantPort = boundPort
			}
			got := front.Advertise(tc.fallbackHost)
			if got.Host != tc.wantHost || got.Port != wantPort {
				t.Errorf("Advertise(%q) = %+v, want %s:%d", tc.fallbackHost, got, tc.wantHost, wantPort)
			}
		})
	}
}

func TestStartCloseLifecycle(t *testing.T) {
	front := New(Config{Host: "127.0.0.1"})
	if front.Enabled() {
		t.Fatal("New() 之后不该已启用")
	}
	if front.BoundPort() != 0 {
		t.Fatalf("未启动时 BoundPort() = %d, want 配置端口 0", front.BoundPort())
	}
	if err := front.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	first := front.BoundPort()
	if !front.Enabled() || first <= 0 {
		t.Fatalf("Start() 后 Enabled() = %v, BoundPort() = %d", front.Enabled(), first)
	}
	// 重复 Start 必须保持同一个绑定，不能把已有 socket 换掉。
	if err := front.Start(); err != nil {
		t.Fatalf("第二次 Start() error = %v", err)
	}
	if front.BoundPort() != first {
		t.Fatalf("重复 Start() 后端口 = %d, want %d", front.BoundPort(), first)
	}
	if err := front.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if front.Enabled() {
		t.Fatal("Close() 之后仍然启用")
	}
	if err := front.Close(); err != nil {
		t.Fatalf("重复 Close() error = %v", err)
	}
}

func TestAddAssociationRejectsInvalidBND(t *testing.T) {
	front := newStartedFront(t, Config{})
	cases := []struct {
		name string
		id   string
		bnd  BND
	}{
		{"空 id", "", BND{Host: "127.0.0.1", Port: 51001}},
		{"空主机", "assoc-1", BND{Host: "", Port: 51001}},
		{"端口为 0", "assoc-1", BND{Host: "127.0.0.1", Port: 0}},
		{"端口越界", "assoc-1", BND{Host: "127.0.0.1", Port: 70000}},
		{"udp4 不支持 IPv6", "assoc-1", BND{Host: "::1", Port: 51001}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if front.AddAssociation(tc.id, tc.bnd) {
				t.Fatalf("AddAssociation(%q, %s) = true, want false", tc.id, tc.bnd)
			}
		})
	}
	if front.AssociationCount() != 0 {
		t.Fatalf("非法 BND 也登记了关联：%d", front.AssociationCount())
	}
}

func TestAddAssociationReplacesSameID(t *testing.T) {
	front := newStartedFront(t, Config{})
	var sent []sentDatagram
	send := collectSender(&sent)
	client := mustAddr(t, "192.168.31.20:40001")

	if !front.AddAssociation("assoc-1", BND{Host: "127.0.0.1", Port: 51001}) {
		t.Fatal("首次 AddAssociation = false")
	}
	front.handleDatagram([]byte("q1"), client, send)

	if !front.AddAssociation("assoc-1", BND{Host: "127.0.0.1", Port: 51002}) {
		t.Fatal("同 id 替换 AddAssociation = false")
	}
	if front.AssociationCount() != 1 {
		t.Fatalf("替换后关联数 = %d, want 1", front.AssociationCount())
	}
	front.mu.Lock()
	_, stale := front.bySidecar["127.0.0.1:51001"]
	front.mu.Unlock()
	if stale {
		t.Fatal("替换后旧 BND 的索引必须删除")
	}
	if got := lockedClient(front, "assoc-1"); got != "" {
		t.Fatalf("替换后的新关联不该继承锁定：%q", got)
	}

	// 新关联未锁定，客户端首报重新锁定并改走新 BND。
	front.handleDatagram([]byte("q2"), client, send)
	want := []sentDatagram{
		{"q1", "127.0.0.1:51001"},
		{"q2", "127.0.0.1:51002"},
	}
	if len(sent) != len(want) {
		t.Fatalf("转发 = %+v, want %+v", sent, want)
	}
	for index := range want {
		if sent[index] != want[index] {
			t.Errorf("第 %d 次转发 = %+v, want %+v", index+1, sent[index], want[index])
		}
	}
	if got := lockedClient(front, "assoc-1"); got != "192.168.31.20:40001" {
		t.Errorf("重新锁定 = %q", got)
	}
}

func TestRemoveAssociationKeepsNewerSidecarOwner(t *testing.T) {
	front := newStartedFront(t, Config{})
	var sent []sentDatagram
	send := collectSender(&sent)
	shared := BND{Host: "127.0.0.1", Port: 51001}

	if !front.AddAssociation("assoc-1", shared) {
		t.Fatal("AddAssociation(assoc-1) = false")
	}
	front.handleDatagram([]byte("q1"), mustAddr(t, "192.168.31.20:40001"), send)

	// 同一个 BND 被后来的关联重新占用（边车可能复用端口）。
	if !front.AddAssociation("assoc-2", shared) {
		t.Fatal("AddAssociation(assoc-2) = false")
	}
	front.handleDatagram([]byte("q2"), mustAddr(t, "192.168.31.21:40002"), send)

	// 回收旧关联不能把新关联的回程索引一起删掉。
	front.RemoveAssociation("assoc-1")
	if front.AssociationCount() != 1 {
		t.Fatalf("回收后关联数 = %d, want 1", front.AssociationCount())
	}
	front.handleDatagram([]byte("r1"), mustAddr(t, "127.0.0.1:51001"), send)

	want := []sentDatagram{
		{"q1", "127.0.0.1:51001"},
		{"q2", "127.0.0.1:51001"},
		{"r1", "192.168.31.21:40002"},
	}
	if len(sent) != len(want) {
		t.Fatalf("转发 = %+v, want %+v", sent, want)
	}
	for index := range want {
		if sent[index] != want[index] {
			t.Errorf("第 %d 次转发 = %+v, want %+v", index+1, sent[index], want[index])
		}
	}
}

// TestSharedSocketBridgesBothWays 用真实回环 socket 验证「一个共享 UDP socket」：
// 客户端 → 前端 → 边车、边车 → 前端 → 客户端，两侧看到的源端口都是前端那个端口。
func TestSharedSocketBridgesBothWays(t *testing.T) {
	front := newStartedFront(t, Config{Host: "127.0.0.1"})

	listen := func() *net.UDPConn {
		t.Helper()
		conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatalf("ListenUDP() error = %v", err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
	sidecar := listen()
	client := listen()

	sidecarPort := sidecar.LocalAddr().(*net.UDPAddr).Port
	if !front.AddAssociation("assoc-1", BND{Host: "127.0.0.1", Port: sidecarPort}) {
		t.Fatal("AddAssociation(assoc-1) = false")
	}

	frontAddr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: front.BoundPort()}
	if _, err := client.WriteToUDP([]byte("question"), frontAddr); err != nil {
		t.Fatalf("客户端发送失败: %v", err)
	}

	buf := make([]byte, 2048)
	if err := sidecar.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	n, from, err := sidecar.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("边车没有收到客户端数据报: %v", err)
	}
	if string(buf[:n]) != "question" {
		t.Errorf("边车收到 %q, want %q", string(buf[:n]), "question")
	}
	if from.Port != front.BoundPort() {
		t.Errorf("边车看到的前端源端口 = %d, want %d", from.Port, front.BoundPort())
	}

	if _, err := sidecar.WriteToUDP([]byte("answer"), from); err != nil {
		t.Fatalf("边车回程失败: %v", err)
	}
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	n, replyFrom, err := client.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("客户端没有收到回程: %v", err)
	}
	if string(buf[:n]) != "answer" {
		t.Errorf("客户端收到 %q, want %q", string(buf[:n]), "answer")
	}
	if replyFrom.Port != front.BoundPort() {
		t.Errorf("客户端看到的前端源端口 = %d, want %d", replyFrom.Port, front.BoundPort())
	}
	if front.AssociationCount() != 1 {
		t.Errorf("关联数 = %d, want 1", front.AssociationCount())
	}
}
