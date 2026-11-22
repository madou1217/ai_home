// Command aih-engine-singbox 是 egress.engine 进程插件示例：sing-box。
//
// 协议：行分隔 JSON-RPC（describe/resolve/compile/shutdown）；只编译配置与启动
// 事实，不启动内核进程。宿主负责进程/控制面/健康/回收。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/madou1217/ai_home/application/egressengine"
	"github.com/madou1217/ai_home/internal/engineplugins/singbox"
)

type request struct {
	ID      int64           `json:"id"`
	Op      string          `json:"op"`
	Request json.RawMessage `json:"request,omitempty"`
}

type response struct {
	ID     int64 `json:"id"`
	Result any   `json:"result,omitempty"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}
		reply := response{ID: req.ID}
		switch req.Op {
		case "describe":
			reply.Result = singbox.Descriptor()
		case "resolve":
			var input egressengine.ResolveRequest
			if err := json.Unmarshal(req.Request, &input); err != nil {
				reply.Error = &struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				}{Code: "invalid_request", Message: err.Error()}
				break
			}
			result, err := singbox.Resolve(input)
			if err != nil {
				reply.Error = &struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				}{Code: "resolve_failed", Message: err.Error()}
			} else {
				reply.Result = result
			}
		case "compile":
			var input egressengine.CompileRequest
			if err := json.Unmarshal(req.Request, &input); err != nil {
				reply.Error = &struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				}{Code: "invalid_request", Message: err.Error()}
				break
			}
			result, err := singbox.Compile(context.Background(), input)
			if err != nil {
				reply.Error = &struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				}{Code: "compile_failed", Message: err.Error()}
			} else {
				reply.Result = result
			}
		case "shutdown":
			_ = encoder.Encode(reply)
			return
		default:
			reply.Error = &struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}{Code: "unknown_op", Message: fmt.Sprintf("未知操作：%s", req.Op)}
		}
		if err := encoder.Encode(reply); err != nil {
			return
		}
	}
}
