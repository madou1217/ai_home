package pluginapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

type stubReader struct {
	state pluginruntime.ControlState
	err   error
}

func (stub *stubReader) ReadControlState(context.Context) (pluginruntime.ControlState, error) {
	if stub.err != nil {
		return pluginruntime.ControlState{}, stub.err
	}
	return stub.state, nil
}

func testProjection(generation int64, instanceID string) pluginruntime.Projection {
	return pluginruntime.Projection{
		Generation: generation,
		Contributions: []pluginruntime.Contribution{{
			ID: "echo.reply", Capability: "gateway.request", FailurePolicy: "deny", InstanceID: instanceID,
		}},
	}
}

func stateWithEcho() pluginruntime.ControlState {
	return pluginruntime.ControlState{
		SchemaVersion: 1,
		Revision:      7,
		Installed: []pluginruntime.InstalledRecord{{
			PluginID: "echo", Version: "1.0.0", Digest: "sha256:abc",
			Manifest: pluginruntime.Manifest{
				PluginID: "echo", Version: "1.0.0",
				Contributes: []pluginruntime.Contribution{{ID: "echo.reply", Capability: "gateway.request", FailurePolicy: "deny"}},
			},
		}},
		Instances: []pluginruntime.InstanceRecord{{
			InstanceID: "echo", PluginID: "echo", Version: "1.0.0", Enabled: true,
		}},
	}
}

type inventoryEnvelope struct {
	OK       bool   `json:"ok"`
	ReadOnly bool   `json:"readOnly"`
	Source   string `json:"source"`
	Error    string `json:"error"`
	Message  string `json:"message"`
	pluginruntime.Inventory
}

func serveInventory(
	t *testing.T,
	reader ControlStateReader,
	registry *pluginruntime.Registry,
	allowed bool,
	method string,
) (*httptest.ResponseRecorder, inventoryEnvelope) {
	t.Helper()
	handler, err := NewInventoryHandler(stubAuthorizer{allowed: allowed}, reader, registry)
	if err != nil {
		t.Fatalf("创建 handler 失败: %v", err)
	}
	request := httptest.NewRequest(method, InventoryPath, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var envelope inventoryEnvelope
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
		}
	}
	return recorder, envelope
}

// TestInventoryHandlerContract 固定只读清单的 HTTP 契约与只读边界。
func TestInventoryHandlerContract(t *testing.T) {
	projects := []pluginruntime.Projection{testProjection(9, "echo")}
	tests := []struct {
		name       string
		reader     *stubReader
		projects   []pluginruntime.Projection
		allowed    bool
		method     string
		wantStatus int
		wantCode   string
		check      func(t *testing.T, envelope inventoryEnvelope, recorder *httptest.ResponseRecorder)
	}{
		{
			name:       "空控制状态",
			reader:     &stubReader{state: pluginruntime.ControlState{SchemaVersion: 1}},
			allowed:    true,
			method:     http.MethodGet,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, envelope inventoryEnvelope, _ *httptest.ResponseRecorder) {
				t.Helper()
				if !envelope.OK || !envelope.ReadOnly || envelope.Source != InventorySource {
					t.Fatalf("只读信封不符: %+v", envelope)
				}
				if envelope.Installed == nil || envelope.Instances == nil {
					t.Fatalf("空列表必须是数组: %+v", envelope)
				}
				if !envelope.Consistency.OK {
					t.Fatalf("空状态不应有一致性问题: %+v", envelope.Consistency)
				}
			},
		},
		{
			name:       "投影一致",
			reader:     &stubReader{state: stateWithEcho()},
			projects:   projects,
			allowed:    true,
			method:     http.MethodGet,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, envelope inventoryEnvelope, _ *httptest.ResponseRecorder) {
				t.Helper()
				if envelope.Revision != 7 || envelope.Runtime.ActiveGeneration != 9 {
					t.Fatalf("revision/代次不符: %+v", envelope.Inventory)
				}
				if len(envelope.Runtime.Instances) != 1 || envelope.Runtime.Instances[0].Status != pluginruntime.InstanceStatusProjected {
					t.Fatalf("实例投影状态不符: %+v", envelope.Runtime.Instances)
				}
			},
		},
		{
			name:       "未授权",
			reader:     &stubReader{state: stateWithEcho()},
			allowed:    false,
			method:     http.MethodGet,
			wantStatus: http.StatusUnauthorized,
			wantCode:   "unauthorized",
		},
		{
			name:       "写请求只读边界",
			reader:     &stubReader{state: stateWithEcho()},
			allowed:    true,
			method:     http.MethodPost,
			wantStatus: http.StatusMethodNotAllowed,
			wantCode:   "plugin_control_read_only",
			check: func(t *testing.T, _ inventoryEnvelope, recorder *httptest.ResponseRecorder) {
				t.Helper()
				if recorder.Header().Get("Allow") != http.MethodGet {
					t.Fatalf("Allow 头应为 GET: %q", recorder.Header().Get("Allow"))
				}
			},
		},
		{
			name:       "控制状态不可读",
			reader:     &stubReader{err: pluginruntime.ErrControlStateUnavailable},
			allowed:    true,
			method:     http.MethodGet,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "plugin_state_unavailable",
		},
		{
			name:       "控制状态格式无效",
			reader:     &stubReader{err: pluginruntime.ErrControlStateInvalid},
			allowed:    true,
			method:     http.MethodGet,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "plugin_state_invalid",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := pluginruntime.NewRegistry()
			if len(test.projects) > 0 {
				if _, err := registry.Replace(
					pluginruntime.HostAccess{Address: "127.0.0.1:1", Token: "token"},
					test.projects, nil,
				); err != nil {
					t.Fatalf("安装投影失败: %v", err)
				}
			}
			recorder, envelope := serveInventory(t, test.reader, registry, test.allowed, test.method)
			if recorder.Code != test.wantStatus {
				t.Fatalf("状态码: got %d want %d (%s)", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if test.wantCode != "" {
				if envelope.Error != test.wantCode || envelope.OK {
					t.Fatalf("错误形状不符: %+v", envelope)
				}
			}
			if test.check != nil {
				test.check(t, envelope, recorder)
			}
		})
	}
}

// TestNewInventoryHandlerRequiresDependencies 防止挂出永远 500 的路由。
func TestNewInventoryHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewInventoryHandler(nil, &stubReader{}, pluginruntime.NewRegistry()); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少鉴权应被拒绝: %v", err)
	}
	if _, err := NewInventoryHandler(stubAuthorizer{allowed: true}, nil, pluginruntime.NewRegistry()); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少读取器应被拒绝: %v", err)
	}
	if _, err := NewInventoryHandler(stubAuthorizer{allowed: true}, &stubReader{}, nil); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少投影应被拒绝: %v", err)
	}
}
