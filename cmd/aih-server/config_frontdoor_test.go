package main

import "testing"

// TestLoadCommandConfigFrontDoorRequiresNodeBaseURL 前置门没有回退目标时必须拒绝启动：
// 否则公开端口上未注册的路径会全部 404，看上去像「网关坏了」。
func TestLoadCommandConfigFrontDoorRequiresNodeBaseURL(t *testing.T) {
	if _, err := loadCommandConfig([]string{"--front-door"}, testRuntime(nil)); err == nil {
		t.Fatal("--front-door 缺少 --node-base-url 未被拒绝")
	}
}

// TestLoadCommandConfigFrontDoorRejectsSelfTarget 指向自身会让未注册路径无限自环。
func TestLoadCommandConfigFrontDoorRejectsSelfTarget(t *testing.T) {
	_, err := loadCommandConfig(
		[]string{"--front-door", "--node-base-url", "http://127.0.0.1:9527"},
		testRuntime(nil),
	)
	if err == nil {
		t.Fatal("前置门指向自身未被拒绝")
	}
}

// TestLoadCommandConfigFrontDoorRequiresExplicitPort 缺端口会落到 80/443，
// 宿主内部没有 Node 在那两个端口上，故障会推迟到首个请求才以 502 暴露。
func TestLoadCommandConfigFrontDoorRequiresExplicitPort(t *testing.T) {
	_, err := loadCommandConfig(
		[]string{"--front-door", "--node-base-url", "http://127.0.0.1"},
		testRuntime(nil),
	)
	if err == nil {
		t.Fatal("前置门缺少显式端口未被拒绝")
	}
}

// TestLoadCommandConfigFrontDoorAcceptsPrivateNode 记录成功路径的关键事实：
// 只有打开开关时 frontDoorBaseURL 才非空，关闭时保持旧合同。
func TestLoadCommandConfigFrontDoorAcceptsPrivateNode(t *testing.T) {
	cfg, err := loadCommandConfig(
		[]string{"--front-door", "--node-base-url", "http://127.0.0.1:19551"},
		testRuntime(nil),
	)
	if err != nil {
		t.Fatalf("合法前置门配置被拒绝: %v", err)
	}
	if !cfg.frontDoor {
		t.Fatal("frontDoor 未开启")
	}
	if got := cfg.frontDoorBaseURL(); got != "http://127.0.0.1:19551" {
		t.Fatalf("frontDoorBaseURL() = %q", got)
	}

	cfg, err = loadCommandConfig(
		[]string{"--node-base-url", "http://127.0.0.1:19551"},
		testRuntime(nil),
	)
	if err != nil {
		t.Fatalf("不带前置门的配置被拒绝: %v", err)
	}
	if got := cfg.frontDoorBaseURL(); got != "" {
		t.Fatalf("未开启前置门时 frontDoorBaseURL() = %q，期望为空", got)
	}
}
