package codexappserverws

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

func TestRewriteClientMessage(t *testing.T) {
	t.Parallel()

	t.Run("thread_list注入cwd与清空modelProviders并保留特殊字符与原字段", func(t *testing.T) {
		raw := []byte(`{"id":1,"method":"thread/list","params":{"modelProviders":["openai"],"limit":20,"extra":"a&b<c>"}}`)
		out := RewriteClientMessage(raw, RewriteOptions{Cwd: "  /Users/work/repo  "})
		if bytes.Contains(out, []byte(`\u0026`)) || bytes.Contains(out, []byte(`\u003c`)) {
			t.Fatalf("不应转义 HTML 特殊字符: %s", string(out))
		}
		var parsed map[string]any
		if err := json.Unmarshal(out, &parsed); err != nil {
			t.Fatal(err)
		}
		params := parsed["params"].(map[string]any)
		if params["cwd"] != "/Users/work/repo" {
			t.Fatalf("cwd = %v, 期望 /Users/work/repo", params["cwd"])
		}
		if params["useStateDbOnly"] != true {
			t.Fatalf("useStateDbOnly = %v, 期望 true", params["useStateDbOnly"])
		}
		if params["extra"] != "a&b<c>" {
			t.Fatalf("extra = %v, 期望保留", params["extra"])
		}
		providers := params["modelProviders"].([]any)
		if len(providers) != 0 {
			t.Fatalf("modelProviders 应清空为 [], 实际 %v", providers)
		}
	})

	t.Run("thread_list尊重已有cwd与SkipInjectCwd及null_cwd覆盖", func(t *testing.T) {
		keepRaw := []byte(`{"id":2,"method":"thread/list","params":{"cwd":"/explicit/dir"}}`)
		outKeep := RewriteClientMessage(keepRaw, RewriteOptions{Cwd: "/injected"})
		var parsedKeep map[string]any
		if err := json.Unmarshal(outKeep, &parsedKeep); err != nil {
			t.Fatal(err)
		}
		if parsedKeep["params"].(map[string]any)["cwd"] != "/explicit/dir" {
			t.Fatalf("显式 cwd 不应被覆盖: %s", string(outKeep))
		}

		skipRaw := []byte(`{"id":3,"method":"thread/list","params":{}}`)
		outSkip := RewriteClientMessage(skipRaw, RewriteOptions{Cwd: "/injected", SkipInjectCwd: true})
		var parsedSkip map[string]any
		if err := json.Unmarshal(outSkip, &parsedSkip); err != nil {
			t.Fatal(err)
		}
		if _, exists := parsedSkip["params"].(map[string]any)["cwd"]; exists {
			t.Fatalf("SkipInjectCwd=true 时不应注入 cwd: %s", string(outSkip))
		}

		nullRaw := []byte(`{"id":4,"method":"thread/list","params":{"cwd":null}}`)
		outNull := RewriteClientMessage(nullRaw, RewriteOptions{Cwd: "/injected"})
		var parsedNull map[string]any
		if err := json.Unmarshal(outNull, &parsedNull); err != nil {
			t.Fatal(err)
		}
		if parsedNull["params"].(map[string]any)["cwd"] != "/injected" {
			t.Fatalf("cwd 为 null 时应注入 cwd: %s", string(outNull))
		}
	})

	t.Run("thread_list无需修改时原样返回原始字节", func(t *testing.T) {
		raw := []byte(`{"id":5,"method":"thread/list","params":{"cwd":"/repo","modelProviders":[],"useStateDbOnly":true}}`)
		out := RewriteClientMessage(raw, RewriteOptions{Cwd: "/other"})
		if !bytes.Equal(out, raw) {
			t.Fatalf("未变更时应原样返回: got=%s want=%s", string(out), string(raw))
		}
	})

	t.Run("thread_start_resume_fork剥离非空profile并在config变空时移除config", func(t *testing.T) {
		for _, method := range []string{"thread/start", "thread/resume", "thread/fork"} {
			onlyProfile := []byte(`{"id":10,"method":"` + method + `","params":{"threadId":"t1","config":{"profile":"fast"}}}`)
			out := RewriteClientMessage(onlyProfile, RewriteOptions{})
			var parsed map[string]any
			if err := json.Unmarshal(out, &parsed); err != nil {
				t.Fatal(err)
			}
			params := parsed["params"].(map[string]any)
			if _, hasCfg := params["config"]; hasCfg {
				t.Fatalf("%s 仅含 profile 时应删除整个 config: %s", method, string(out))
			}

			withExtra := []byte(`{"id":11,"method":"` + method + `","params":{"config":{"profile":"fast","sandbox":"workspace-write"}}}`)
			outExtra := RewriteClientMessage(withExtra, RewriteOptions{})
			var parsedExtra map[string]any
			if err := json.Unmarshal(outExtra, &parsedExtra); err != nil {
				t.Fatal(err)
			}
			cfg := parsedExtra["params"].(map[string]any)["config"].(map[string]any)
			if _, hasProfile := cfg["profile"]; hasProfile {
				t.Fatalf("%s 应删除 config.profile: %s", method, string(outExtra))
			}
			if cfg["sandbox"] != "workspace-write" {
				t.Fatalf("%s 应保留其他 config 字段: %s", method, string(outExtra))
			}

			blankProfile := []byte(`{"id":12,"method":"` + method + `","params":{"config":{"profile":"   "}}}`)
			outBlank := RewriteClientMessage(blankProfile, RewriteOptions{})
			if !bytes.Equal(outBlank, blankProfile) {
				t.Fatalf("%s 空白 profile 不应改写: %s", method, string(outBlank))
			}
		}
	})

	t.Run("非JSON或未知方法原样返回", func(t *testing.T) {
		for _, raw := range [][]byte{
			[]byte("not json"),
			[]byte("[1,2,3]"),
			[]byte(`{"id":1,"method":"turn/start","params":{"foo":"bar"}}`),
			[]byte(`{"id":1,"params":{}}`),
		} {
			if out := RewriteClientMessage(raw, RewriteOptions{Cwd: "/repo"}); !bytes.Equal(out, raw) {
				t.Fatalf("应原样返回 %q, 实际 %q", string(raw), string(out))
			}
		}
	})
}

func TestResumeTracker(t *testing.T) {
	t.Parallel()

	tracker := NewResumeTracker()

	if !tracker.RememberRequest([]byte(`{"id":42,"method":"thread/resume","params":{"threadId":"thr-req-1"}}`)) {
		t.Fatal("带数字 id 的 thread/resume 应被记录")
	}
	patched := tracker.PatchResponse([]byte(`{"id":42,"result":{"model":"gpt-5","url":"https://a/b?x=1&y=2"}}`))
	if bytes.Contains(patched, []byte(`\u0026`)) {
		t.Fatalf("补丁输出不应转义 HTML 字符: %s", string(patched))
	}
	var parsed map[string]any
	if err := json.Unmarshal(patched, &parsed); err != nil {
		t.Fatal(err)
	}
	result := parsed["result"].(map[string]any)
	tids := result["threadIds"].([]any)
	if len(tids) != 1 || tids[0] != "thr-req-1" {
		t.Fatalf("期望补齐 [thr-req-1], 实际 %v", tids)
	}

	second := []byte(`{"id":42,"result":{"thread":{"id":"thr-other"}}}`)
	if out := tracker.PatchResponse(second); !bytes.Equal(out, second) {
		t.Fatalf("已消费的请求 id 不应重复打补丁: %s", string(out))
	}

	if !tracker.RememberRequest([]byte(`{"id":0,"method":"thread/resume","params":{}}`)) {
		t.Fatal("id=0 的 thread/resume 应被记录")
	}
	patchedFallback := tracker.PatchResponse([]byte(`{"id":0,"result":{"thread":{"id":"thr-from-resp"}}}`))
	var parsedFallback map[string]any
	if err := json.Unmarshal(patchedFallback, &parsedFallback); err != nil {
		t.Fatal(err)
	}
	tidsFallback := parsedFallback["result"].(map[string]any)["threadIds"].([]any)
	if len(tidsFallback) != 1 || tidsFallback[0] != "thr-from-resp" {
		t.Fatalf("期望回退补齐 [thr-from-resp], 实际 %v", tidsFallback)
	}

	_ = tracker.RememberRequest([]byte(`{"id":"r-has","method":"thread/resume","params":{"thread_id":"thr-old"}}`))
	alreadyHas := []byte(`{"id":"r-has","result":{"threadIds":["thr-exist"]}}`)
	if out := tracker.PatchResponse(alreadyHas); !bytes.Equal(out, alreadyHas) {
		t.Fatalf("已有 threadIds 不应被覆盖: %s", string(out))
	}

	if tracker.RememberRequest([]byte(`{"id":"x","method":"thread/start","params":{"threadId":"t1"}}`)) {
		t.Fatal("非 thread/resume 不应记录")
	}
	if tracker.RememberRequest([]byte(`{"method":"thread/resume","params":{"threadId":"t1"}}`)) {
		t.Fatal("无 id 不应记录")
	}

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := []byte(`{"id":"k-` + string(rune('a'+idx%26)) + `","method":"thread/resume","params":{"thread":{"id":"thr-conc"}}}`)
			tracker.RememberRequest(req)
			tracker.PatchResponse([]byte(`{"id":"k-` + string(rune('a'+idx%26)) + `","result":{}}`))
		}(i)
	}
	wg.Wait()
}

func TestSplitJSONRPCLinesAndFlags(t *testing.T) {
	t.Parallel()

	lines, rest := SplitJSONRPCLines("{\"a\":1}\r\n\n{\"b\":2}\n{\"part\":")
	if len(lines) != 2 || lines[0] != `{"a":1}` || lines[1] != `{"b":2}` || rest != `{"part":` {
		t.Fatalf("SplitJSONRPCLines 异常: lines=%q rest=%q", lines, rest)
	}

	env := map[string]string{
		CodexFlagsEnv: "authPreflight=0,managedLaunch=1,upstreamProtocol=openai%20chat",
	}
	if !ConsumeCodexManagedLaunch(env) {
		t.Fatal("应消费 managedLaunch=1")
	}
	if ReadCodexFlagFromEnv(env, "managedLaunch") != "" {
		t.Fatalf("managedLaunch 应被清除: %q", env[CodexFlagsEnv])
	}
	if ReadCodexFlagFromEnv(env, "upstreamProtocol") != "openai chat" {
		t.Fatalf("upstreamProtocol 解码异常: %q", ReadCodexFlagFromEnv(env, "upstreamProtocol"))
	}
	SetCodexFlagInEnv(env, "remoteProxy", "1")
	if ReadCodexFlagFromEnv(env, "remoteProxy") != "1" {
		t.Fatalf("remoteProxy 应写入成功: %q", env[CodexFlagsEnv])
	}
	if ConsumeCodexManagedLaunch(env) {
		t.Fatal("二次消费 managedLaunch 应返回 false")
	}
}
