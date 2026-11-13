package accountactivity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func buildTestPNG(t *testing.T, width, height int, paint func(x, y int) (color.NRGBA, bool)) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if c, ok := paint(x, y); ok {
				img.SetNRGBA(x, y, c)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func TestCaptchaSolveGate_SerializesAndEnforcesMinInterval(t *testing.T) {
	gate := NewCaptchaSolveGate()
	var nowMS atomic.Int64
	nowMS.Store(1000)
	var slept []time.Duration
	var sleptMu sync.Mutex

	nowFn := func() time.Time { return time.UnixMilli(nowMS.Load()) }
	sleepFn := func(ctx context.Context, d time.Duration) error {
		sleptMu.Lock()
		slept = append(slept, d)
		sleptMu.Unlock()
		nowMS.Add(d.Milliseconds())
		return nil
	}

	var active atomic.Int32
	var maxActive atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := gate.Run(context.Background(), 5*time.Second, nowFn, sleepFn, func(ctx context.Context) (string, error) {
				cur := active.Add(1)
				for {
					prev := maxActive.Load()
					if cur <= prev || maxActive.CompareAndSwap(prev, cur) {
						break
					}
				}
				time.Sleep(5 * time.Millisecond)
				nowMS.Add(200)
				active.Add(-1)
				return "ok", nil
			})
			if err != nil {
				t.Errorf("gate.Run error: %v", err)
			}
		}()
	}
	wg.Wait()

	if maxActive.Load() != 1 {
		t.Fatalf("max concurrent tasks = %d, want 1", maxActive.Load())
	}
	if len(slept) != 2 {
		t.Fatalf("slept calls = %v, want 2 interval waits", slept)
	}
	for i, d := range slept {
		if d != 5*time.Second {
			t.Fatalf("slept[%d] = %v, want 5s", i, d)
		}
	}
}

func TestRunWithF001Retry(t *testing.T) {
	var curMS atomic.Int64
	curMS.Store(0)
	nowFn := func() time.Time { return time.UnixMilli(curMS.Load()) }
	var waits []time.Duration
	sleepFn := func(ctx context.Context, d time.Duration) error {
		waits = append(waits, d)
		curMS.Add(d.Milliseconds())
		return nil
	}

	// 1. F001 on first attempt -> retries and succeeds on second attempt.
	calls := 0
	val, err := RunWithF001Retry(context.Background(), func(ctx context.Context, attempt int) (string, error) {
		calls++
		if attempt == 0 {
			return "", errors.New(`captcha_failed:{"error":{"code":"F001"}}`)
		}
		return "verify-ok", nil
	}, []time.Duration{20 * time.Second, 40 * time.Second}, 180*time.Second, sleepFn, nowFn)
	if err != nil || val != "verify-ok" || calls != 2 || len(waits) != 1 || waits[0] != 20*time.Second {
		t.Fatalf("F001 retry got val=%q err=%v calls=%d waits=%v", val, err, calls, waits)
	}

	// 2. Non-F001 error stops immediately without retrying.
	waits = nil
	calls = 0
	_, err = RunWithF001Retry(context.Background(), func(ctx context.Context, attempt int) (string, error) {
		calls++
		return "", errors.New("captcha_failed:timeout")
	}, []time.Duration{20 * time.Second}, 180*time.Second, sleepFn, nowFn)
	if err == nil || calls != 1 || len(waits) != 0 {
		t.Fatalf("non-F001 calls=%d waits=%v err=%v", calls, waits, err)
	}

	// 3. Budget exhaustion stops before waiting past deadline.
	curMS.Store(0)
	waits = nil
	calls = 0
	_, err = RunWithF001Retry(context.Background(), func(ctx context.Context, attempt int) (string, error) {
		calls++
		return "", errors.New("F001")
	}, []time.Duration{20 * time.Second, 40 * time.Second}, 30*time.Second, sleepFn, nowFn)
	if err == nil || calls != 1 || len(waits) != 0 {
		t.Fatalf("tight budget calls=%d waits=%v err=%v", calls, waits, err)
	}
}

func TestResolveMacAppBundleAndLaunchArgs(t *testing.T) {
	macExec := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if got := ResolveMacAppBundle(macExec); got != "/Applications/Google Chrome.app" {
		t.Fatalf("ResolveMacAppBundle(mac) = %q", got)
	}
	if got := ResolveMacAppBundle("/usr/bin/google-chrome"); got != "" {
		t.Fatalf("ResolveMacAppBundle(linux) = %q, want empty", got)
	}

	args := BuildCaptchaLaunchArgs("/tmp/captcha-profile")
	for _, required := range []string{
		"--remote-debugging-port=0",
		"--user-data-dir=/tmp/captcha-profile",
		"--use-mock-keychain",
		"--no-startup-window",
	} {
		if !slices.Contains(args, required) {
			t.Fatalf("missing flag %q in %v", required, args)
		}
	}
}

func TestDragPathGeometry(t *testing.T) {
	detRNG := func() float64 { return 0.5 }
	approach := BuildApproachPath(DragPoint{X: 200, Y: 300}, detRNG, 20, -100, 80, 0)
	if len(approach) != 20 {
		t.Fatalf("approach len = %d, want 20", len(approach))
	}
	last := approach[len(approach)-1]
	if math.Abs(last.X-200) > 0.05 || math.Abs(last.Y-300) > 0.05 {
		t.Fatalf("approach end = %+v, want (200, 300)", last)
	}

	points := BuildDragPoints(180, detRNG, 30, 3.0)
	if len(points) != 33 {
		t.Fatalf("drag points len = %d, want 33 (30 + 3 overshoot)", len(points))
	}
	if points[len(points)-1].DX != 180 || points[len(points)-1].DY != 0 {
		t.Fatalf("drag final delta = %+v, want DX=180 DY=0", points[len(points)-1])
	}

	plan := BuildDragPlan(DragPoint{X: 120, Y: 220}, 150, detRNG)
	if plan.Distance != 150 || len(plan.Approach) != 45 || plan.PressHoldMS <= 0 || plan.ReleaseHoldMS <= 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestComputePuzzleAlphaOffsetPNG(t *testing.T) {
	// Solid opaque cutout starting at x=80 inside a 240x120 canvas.
	solidPNG := buildTestPNG(t, 240, 120, func(x, y int) (color.NRGBA, bool) {
		if x >= 80 && x < 110 && y >= 20 && y < 60 {
			return color.NRGBA{R: 255, G: 255, B: 255, A: 255}, true
		}
		return color.NRGBA{}, false
	})
	off, err := ComputePuzzleAlphaOffsetPNG(solidPNG, 240, 240)
	if err != nil || off != 80 {
		t.Fatalf("solid PNG offset = (%d, %v), want 80", off, err)
	}

	// Soft-alpha silhouette only (alpha=60 -> >=24 fallback).
	softPNG := buildTestPNG(t, 240, 120, func(x, y int) (color.NRGBA, bool) {
		if x >= 95 && x < 115 && y >= 30 && y < 70 {
			return color.NRGBA{R: 200, G: 200, B: 200, A: 60}, true
		}
		return color.NRGBA{}, false
	})
	off, err = ComputePuzzleAlphaOffsetPNG(softPNG, 120, 120)
	if err != nil || off != 48 {
		t.Fatalf("scaled soft PNG offset = (%d, %v), want 48", off, err)
	}

	// Cropped check.
	if _, err := ComputePuzzleAlphaOffsetPNG(solidPNG, 100, 240); err == nil || err.Error() != "puzzle_image_cropped" {
		t.Fatalf("cropped err = %v, want puzzle_image_cropped", err)
	}

	// Empty transparent PNG check.
	emptyPNG := buildTestPNG(t, 60, 60, func(x, y int) (color.NRGBA, bool) { return color.NRGBA{}, false })
	if _, err := ComputePuzzleAlphaOffsetPNG(emptyPNG, 60, 60); err == nil || err.Error() != "puzzle_empty" {
		t.Fatalf("empty err = %v, want puzzle_empty", err)
	}
}

func TestClassifyWidgetChallenge(t *testing.T) {
	if classifyWidgetChallenge(nil) != nil {
		t.Fatal("nil snapshot should classify nil")
	}
	slide := classifyWidgetChallenge(&widgetSnapshot{
		Slider: &rectSnapshot{X: 10, Y: 20, Width: 40, Height: 40},
		Track:  &rectSnapshot{X: 10, Y: 20, Width: 200, Height: 40},
	})
	if slide == nil || slide.kind != "slide-to-end" || !slide.ready {
		t.Fatalf("slide = %+v", slide)
	}
	var puzzleSnap widgetSnapshot
	_ = json.Unmarshal([]byte(`{"slider":{"x":10,"y":20,"width":40,"height":40},"track":{"x":10,"y":20,"width":200,"height":40},"puzzle":{"present":true,"visible":false}}`), &puzzleSnap)
	puzzleNotReady := classifyWidgetChallenge(&puzzleSnap)
	if puzzleNotReady == nil || puzzleNotReady.kind != "puzzle-drag" || puzzleNotReady.ready {
		t.Fatalf("puzzleNotReady = %+v", puzzleNotReady)
	}
	textClick := classifyWidgetChallenge(&widgetSnapshot{Question: "请依次点击：山 水"})
	if textClick == nil || textClick.kind != "text-click" {
		t.Fatalf("textClick = %+v", textClick)
	}
}

func TestRunCaptchaInteractionWithCDP_WebSocketFlows(t *testing.T) {
	pngBytes := buildTestPNG(t, 240, 120, func(x, y int) (color.NRGBA, bool) {
		if x >= 96 && x < 126 && y >= 25 && y < 65 {
			return color.NRGBA{R: 255, G: 255, B: 255, A: 255}, true
		}
		return color.NRGBA{}, false
	})
	pngSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	}))
	defer pngSrv.Close()

	runFlow := func(t *testing.T, mode string) {
		t.Helper()
		var releaseCount atomic.Int32
		var dragMaxX atomic.Int64
		var puzzleOffsetCalled atomic.Bool

		wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer func() { _ = conn.Close(websocket.StatusNormalClosure, "done") }()
			for {
				_, data, err := conn.Read(r.Context())
				if err != nil {
					return
				}
				var req struct {
					ID        int64          `json:"id"`
					Method    string         `json:"method"`
					SessionID string         `json:"sessionId"`
					Params    map[string]any `json:"params"`
				}
				if json.Unmarshal(data, &req) != nil {
					return
				}

				var resultObj any = map[string]any{}
				switch req.Method {
				case "Input.dispatchMouseEvent":
					typ, _ := req.Params["type"].(string)
					if xVal, ok := req.Params["x"].(float64); ok {
						xInt := int64(math.Round(xVal))
						for {
							cur := dragMaxX.Load()
							if xInt <= cur || dragMaxX.CompareAndSwap(cur, xInt) {
								break
							}
						}
					}
					if typ == "mouseReleased" {
						releaseCount.Add(1)
					}
				case "Runtime.evaluate":
					expr, _ := req.Params["expression"].(string)
					var val any
					switch {
					case strings.Contains(expr, "AliyunCaptchaConfig"):
						val = map[string]any{"ok": true, "stage": "ready"}
					case strings.Contains(expr, "aih-captcha-host"):
						val = map[string]any{"x": 200.0, "y": 300.0}
					case strings.Contains(expr, "settled: Boolean"):
						// Button click = 1st mouseReleased; slider drag finishes on >= 2nd mouseReleased.
						if releaseCount.Load() >= 2 {
							val = map[string]any{
								"settled": true,
								"outcome": map[string]any{"ok": true, "stage": "verify"},
							}
						} else if mode == "puzzle-drag" {
							val = map[string]any{
								"settled": false,
								"slider":  map[string]any{"x": 100.0, "y": 200.0, "width": 40.0, "height": 40.0},
								"track":   map[string]any{"x": 100.0, "y": 200.0, "width": 240.0, "height": 40.0},
								"box":     map[string]any{"x": 100.0, "y": 50.0, "width": 240.0, "height": 120.0},
								"puzzle": map[string]any{
									"present":       true,
									"visible":       true,
									"rect":          map[string]any{"x": 110.0, "y": 60.0, "width": 240.0, "height": 120.0},
									"naturalWidth":  240,
									"naturalHeight": 120,
									"complete":      true,
									"src":           pngSrv.URL + "/puzzle.png",
								},
							}
						} else {
							val = map[string]any{
								"settled": false,
								"slider":  map[string]any{"x": 100.0, "y": 200.0, "width": 40.0, "height": 40.0},
								"track":   map[string]any{"x": 100.0, "y": 200.0, "width": 240.0, "height": 40.0},
							}
						}
					case strings.Contains(expr, "getImageData"):
						puzzleOffsetCalled.Store(true)
						val = map[string]any{
							"ok":     false,
							"reason": "tainted_canvas",
							"src":    pngSrv.URL + "/puzzle.png",
						}
					case strings.Contains(expr, "__aihCaptchaOutcome"):
						val = map[string]any{
							"ok":    true,
							"stage": "verify",
							"param": "mock-verify-param-" + mode,
						}
					}
					resultObj = map[string]any{
						"result": map[string]any{"value": val},
					}
				}

				respBytes, _ := json.Marshal(map[string]any{
					"id":     req.ID,
					"result": resultObj,
				})
				if err := conn.Write(r.Context(), websocket.MessageText, respBytes); err != nil {
					return
				}
			}
		}))
		defer wsSrv.Close()

		wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
		client, err := dialWSCDPClient(context.Background(), wsURL)
		if err != nil {
			t.Fatalf("dialWSCDPClient: %v", err)
		}
		defer client.Close()

		var beforeClicked atomic.Bool
		param, err := runCaptchaInteractionWithCDP(
			context.Background(),
			client,
			"sess-1",
			CaptchaSolveRequest{SceneID: "sc-1", Prefix: "pf-1", Region: "cn"},
			func() { beforeClicked.Store(true) },
			30*time.Second,
		)
		if err != nil {
			t.Fatalf("runCaptchaInteractionWithCDP(%s) err = %v", mode, err)
		}
		if param != "mock-verify-param-"+mode {
			t.Fatalf("param = %q, want mock-verify-param-%s", param, mode)
		}
		if !beforeClicked.Load() {
			t.Fatal("beforeClick hook was not called")
		}
		if releaseCount.Load() < 2 {
			t.Fatalf("releaseCount = %d, want >= 2 (button click + slider drag)", releaseCount.Load())
		}
		if mode == "puzzle-drag" {
			if !puzzleOffsetCalled.Load() {
				t.Fatal("expected puzzle offset probe over CDP")
			}
			// Slider center x = 120; offset=96, pieceLeft=10 => drag distance=86 => final x ~ 206.
			if dragMaxX.Load() < 200 {
				t.Fatalf("dragMaxX = %d, expected drag to reach ~206", dragMaxX.Load())
			}
		}
	}

	t.Run("slide-to-end", func(t *testing.T) { runFlow(t, "slide-to-end") })
	t.Run("puzzle-drag", func(t *testing.T) { runFlow(t, "puzzle-drag") })
}
