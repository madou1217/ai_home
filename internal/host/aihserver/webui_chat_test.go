package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

// 装配方没有提供聊天 Handler 时保持 404：不挂空 Handler，也不猜测能力。
func TestMountWebUIChatSkipsNilHandler(t *testing.T) {
	mux := http.NewServeMux()
	mountWebUIChat(mux, nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodPost, webuichatapi.ManagementCollectionPath+"s-1/commands", nil,
	))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, want 404", recorder.Code)
	}
}

// 聊天入口同时挂管理前缀与浏览器公开入口：公开入口改写前缀后复用同一处理器。
func TestMountWebUIChatServesManagementAndPublicPrefixes(t *testing.T) {
	var servedPath string
	mux := http.NewServeMux()
	mountWebUIChat(mux, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		servedPath = request.URL.Path
		response.WriteHeader(http.StatusAccepted)
	}))

	management := httptest.NewRecorder()
	mux.ServeHTTP(management, httptest.NewRequest(
		http.MethodPost, webuichatapi.ManagementCollectionPath+"s-1/commands", nil,
	))
	if management.Code != http.StatusAccepted {
		t.Fatalf("管理路径状态码 = %d, want 202", management.Code)
	}
	if servedPath != webuichatapi.ManagementCollectionPath+"s-1/commands" {
		t.Fatalf("实际路径 = %q", servedPath)
	}

	browser := httptest.NewRecorder()
	mux.ServeHTTP(browser, httptest.NewRequest(
		http.MethodPost, webuichatapi.CollectionPath+"s-1/commands", nil,
	))
	if browser.Code != http.StatusAccepted {
		t.Fatalf("浏览器路径状态码 = %d, want 202", browser.Code)
	}
	if servedPath != webuichatapi.ManagementCollectionPath+"s-1/commands" {
		t.Fatalf("浏览器路径改写后 = %q, want %q", servedPath, webuichatapi.ManagementCollectionPath+"s-1/commands")
	}
}

// 生产装配用的构造函数必须把缺依赖原样报出来（这里以空依赖为最小样本）。
func TestNewWebUIChatHandlerFailsClosed(t *testing.T) {
	if _, err := newWebUIChatHandler(webuichatapi.Dependencies{}); err == nil {
		t.Fatal("缺依赖时 newWebUIChatHandler() 必须失败")
	}
}
