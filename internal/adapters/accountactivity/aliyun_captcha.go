package accountactivity

// 阿里云验证码 2.0 交互式求解器（Chrome + CDP + 拟人轨迹 + 拼图/滑块挑战）。
//
// 对齐 lib/account/activity-claim/aliyun-captcha.js 与 lib/captcha/{aliyun,drag,index}.js：
//   - 有头窗口 + 离屏定位（macOS 通过 open -g -na 启动 App Bundle 并用 CDP 移至工作区外）；
//   - `--use-mock-keychain` + `--no-startup-window` 避免钥匙串弹窗与闪窗抢焦点；
//   - Proxy 屏蔽 `startTracelessVerification` 强制触发可交互轨迹；
//   - 贝塞尔接近 + 缓动拖拽（含过冲回弹）+ 拼图 alpha 包围盒（支持 canvas 污染回退与 PNG 解码）；
//   - 全局串行解算闸门（默认 5s 冷却）+ F001 退避重试（[20s, 40s]，总预算 180s）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"math"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	captchaSDKURL          = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
	captchaPageURL         = "https://zcode.z.ai/"
	captchaPageOrigin      = "https://zcode.z.ai"
	captchaDefaultTimeout  = 60 * time.Second
	captchaDevtoolsTimeout = 20 * time.Second
	captchaPageReadyTime   = 30 * time.Second
	captchaPageSettleDelay = 2500 * time.Millisecond
	captchaWidgetTimeout   = 10 * time.Second
	captchaOffscreenLeft   = -3000
	captchaOffscreenTop    = 3000
	captchaSolveInterval   = 5 * time.Second
	captchaRetryBudget     = 180 * time.Second
	captchaMaxImageBytes   = 2 * 1024 * 1024
)

var (
	captchaF001RetryDelays = []time.Duration{20 * time.Second, 40 * time.Second}
	defaultSolveGate       = NewCaptchaSolveGate()
)

// CaptchaSolveRequest 是一次阿里云验证码求解请求。
type CaptchaSolveRequest struct {
	SceneID        string
	Prefix         string
	Region         string
	ExecutablePath string
	HostHomeDir    string
	Timeout        time.Duration
}

// CaptchaSolverFunc 抽象一次完整验证码求解（可测试注入）。
type CaptchaSolverFunc func(ctx context.Context, req CaptchaSolveRequest) (string, error)

// CaptchaSolveGate 对同一进程内的阿里云解算执行串行排他与最小冷却间隔。
type CaptchaSolveGate struct {
	mu        sync.Mutex
	lastEnded time.Time
}

// NewCaptchaSolveGate 创建解算闸门。
func NewCaptchaSolveGate() *CaptchaSolveGate {
	return &CaptchaSolveGate{}
}

// Run 在闸门内串行执行解算，确保两次解算之间至少间隔 minInterval。
func (g *CaptchaSolveGate) Run(
	ctx context.Context,
	minInterval time.Duration,
	nowFn func() time.Time,
	sleepFn func(context.Context, time.Duration) error,
	task func(context.Context) (string, error),
) (string, error) {
	if g == nil {
		g = defaultSolveGate
	}
	if nowFn == nil {
		nowFn = time.Now
	}
	if sleepFn == nil {
		sleepFn = sleepWithContext
	}
	g.mu.Lock()
	defer func() {
		g.lastEnded = nowFn()
		g.mu.Unlock()
	}()

	if !g.lastEnded.IsZero() && minInterval > 0 {
		wait := g.lastEnded.Add(minInterval).Sub(nowFn())
		if wait > 0 {
			if err := sleepFn(ctx, wait); err != nil {
				return "", err
			}
		}
	}
	return task(ctx)
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func isF001Error(err error) bool {
	return err != nil && strings.Contains(err.Error(), "F001")
}

// RunWithF001Retry 只对包含 F001 的风控拦截做退避重试，并在预算不足下一轮 15s 解算时提前收手。
func RunWithF001Retry(
	ctx context.Context,
	attemptFn func(ctx context.Context, attempt int) (string, error),
	delays []time.Duration,
	budget time.Duration,
	sleepFn func(context.Context, time.Duration) error,
	nowFn func() time.Time,
) (string, error) {
	if delays == nil {
		delays = captchaF001RetryDelays
	}
	if budget <= 0 {
		budget = captchaRetryBudget
	}
	if sleepFn == nil {
		sleepFn = sleepWithContext
	}
	if nowFn == nil {
		nowFn = time.Now
	}
	deadline := nowFn().Add(budget)
	attempt := 0
	for {
		val, err := attemptFn(ctx, attempt)
		if err == nil {
			return val, nil
		}
		if attempt >= len(delays) || !isF001Error(err) {
			return "", err
		}
		delay := delays[attempt]
		attempt++
		if nowFn().Add(delay + 15*time.Second).After(deadline) {
			return "", err
		}
		if delay > 0 {
			if sErr := sleepFn(ctx, delay); sErr != nil {
				return "", err
			}
		}
	}
}

// SolveAliyunCaptchaWithRetry 使用全局/注入闸门与 F001 退避策略解算一次阿里云验证码。
func SolveAliyunCaptchaWithRetry(
	ctx context.Context,
	req CaptchaSolveRequest,
	gate *CaptchaSolveGate,
) (string, error) {
	sceneID := strings.TrimSpace(req.SceneID)
	prefix := strings.TrimSpace(req.Prefix)
	if sceneID == "" || prefix == "" {
		return "", errors.New("captcha_config_missing:sceneId/prefix")
	}
	if gate == nil {
		gate = defaultSolveGate
	}
	return RunWithF001Retry(ctx, func(attemptCtx context.Context, _ int) (string, error) {
		return gate.Run(attemptCtx, captchaSolveInterval, time.Now, sleepWithContext, func(innerCtx context.Context) (string, error) {
			return solveAliyunCaptchaOnce(innerCtx, req)
		})
	}, captchaF001RetryDelays, captchaRetryBudget, sleepWithContext, time.Now)
}

// --- 浏览器发现与启动 ---

// ResolveChromeExecutable 按平台候选路径与 PATH 探测本机 Chrome / Chromium / Edge。
func ResolveChromeExecutable(explicitPath, platform, hostHomeDir string) (string, error) {
	if p := strings.TrimSpace(explicitPath); p != "" {
		if fileExists(p) {
			return p, nil
		}
		return "", errors.New("captcha_browser_not_found:" + p)
	}
	if platform == "" {
		platform = runtime.GOOS
	}
	home := resolveHostHomeDir(hostHomeDir)
	var candidates []string
	switch platform {
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			filepath.Join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
	case "windows":
		for _, root := range []string{os.Getenv("PROGRAMFILES"), os.Getenv("PROGRAMFILES(X86)"), os.Getenv("LOCALAPPDATA")} {
			r := strings.TrimSpace(root)
			if r == "" {
				continue
			}
			candidates = append(candidates,
				filepath.Join(r, "Google", "Chrome", "Application", "chrome.exe"),
				filepath.Join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
			)
		}
	default:
		candidates = []string{
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		}
	}
	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate, nil
		}
	}
	var names []string
	if platform == "windows" {
		names = []string{"chrome.exe", "msedge.exe"}
	} else {
		names = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"}
	}
	for _, name := range names {
		if found, err := exec.LookPath(name); err == nil && found != "" {
			return found, nil
		}
	}
	return "", errors.New("captcha_browser_not_found: install Google Chrome or pass browser executable path")
}

func fileExists(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// BuildCaptchaLaunchArgs 生成有头、无钥匙串弹窗、无启动闪窗的 Chrome 参数。
func BuildCaptchaLaunchArgs(userDataDir string) []string {
	return []string{
		fmt.Sprintf("--window-position=%d,%d", captchaOffscreenLeft, captchaOffscreenTop),
		"--window-size=900,700",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-blink-features=AutomationControlled",
		"--use-mock-keychain",
		"--remote-debugging-port=0",
		"--user-data-dir=" + userDataDir,
		"--no-startup-window",
	}
}

// ResolveMacAppBundle 从 macOS Chrome 可执行路径提取 `.app` 包目录。
func ResolveMacAppBundle(executable string) string {
	marker := string(filepath.Separator) + filepath.Join("Contents", "MacOS") + string(filepath.Separator)
	idx := strings.Index(executable, marker)
	if idx <= 0 {
		return ""
	}
	return executable[:idx]
}

func waitForDevtoolsPort(ctx context.Context, userDataDir string, timeout time.Duration) (int, string, error) {
	portFile := filepath.Join(userDataDir, "DevToolsActivePort")
	if timeout <= 0 {
		timeout = captchaDevtoolsTimeout
	}
	deadline := time.Now().Add(timeout)
	lastErr := "not_ready"
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return 0, "", errors.New("captcha_devtools_timeout:" + lastErr)
		}
		raw, err := os.ReadFile(portFile)
		if err == nil {
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			if len(lines) >= 1 {
				port, pErr := strconv.Atoi(strings.TrimSpace(lines[0]))
				if pErr == nil && port > 0 {
					wsPath := ""
					if len(lines) >= 2 {
						wsPath = strings.TrimSpace(lines[1])
					}
					return port, wsPath, nil
				}
			}
		} else {
			lastErr = err.Error()
		}
		_ = sleepWithContext(ctx, 100*time.Millisecond)
	}
	return 0, "", errors.New("captcha_devtools_timeout:" + lastErr)
}

func killBrowserOnPort(port int) {
	if port <= 0 {
		return
	}
	out, err := exec.Command("lsof", "-ti", fmt.Sprintf("tcp:%d", port), "-sTCP:LISTEN").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		pid, pErr := strconv.Atoi(strings.TrimSpace(line))
		if pErr != nil || pid <= 0 {
			continue
		}
		if proc, findErr := os.FindProcess(pid); findErr == nil && proc != nil {
			_ = proc.Kill()
		}
	}
}

// --- CDP 客户端抽象（便于单测与生产共享）---

// CDPClient 抽象与浏览器的 Chrome DevTools Protocol 通道。
type CDPClient interface {
	Call(ctx context.Context, method string, params map[string]any, sessionID string) (json.RawMessage, error)
	Close()
}

type cdpCallResult struct {
	result json.RawMessage
	err    error
}

type wsCDPClient struct {
	conn    *websocket.Conn
	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]chan cdpCallResult
	writeMu sync.Mutex
	done    chan struct{}
	once    sync.Once
}

func dialWSCDPClient(ctx context.Context, wsURL string) (*wsCDPClient, error) {
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("captcha_cdp_ws_error:%w", err)
	}
	conn.SetReadLimit(4 * 1024 * 1024)
	c := &wsCDPClient{
		conn:    conn,
		pending: make(map[int64]chan cdpCallResult),
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *wsCDPClient) readLoop() {
	defer func() {
		close(c.done)
		c.failAll(errors.New("captcha_cdp_closed"))
	}()
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			return
		}
		var msg struct {
			ID     int64           `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.ID == 0 {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[msg.ID]
		if ok {
			delete(c.pending, msg.ID)
		}
		c.mu.Unlock()
		if !ok {
			continue
		}
		if msg.Error != nil {
			ch <- cdpCallResult{err: fmt.Errorf("%d:%s", msg.Error.Code, msg.Error.Message)}
		} else {
			ch <- cdpCallResult{result: msg.Result}
		}
	}
}

func (c *wsCDPClient) failAll(err error) {
	c.mu.Lock()
	pending := c.pending
	c.pending = map[int64]chan cdpCallResult{}
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- cdpCallResult{err: err}
	}
}

func (c *wsCDPClient) Call(ctx context.Context, method string, params map[string]any, sessionID string) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	if params == nil {
		params = map[string]any{}
	}
	reqBody := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	if sessionID != "" {
		reqBody["sessionId"] = sessionID
	}
	encoded, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	ch := make(chan cdpCallResult, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	c.writeMu.Lock()
	writeErr := c.conn.Write(ctx, websocket.MessageText, encoded)
	c.writeMu.Unlock()
	if writeErr != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, writeErr
	}

	select {
	case res := <-ch:
		return res.result, res.err
	case <-c.done:
		return nil, errors.New("captcha_cdp_closed")
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (c *wsCDPClient) Close() {
	c.once.Do(func() {
		_ = c.conn.Close(websocket.StatusNormalClosure, "")
		<-c.done
	})
}

// --- 拟人轨迹与拼图算法（纯函数 + 完整单测覆盖）---

// DragPoint 表示鼠标接近或拖拽过程中的一个控制点。
type DragPoint struct {
	X       float64
	Y       float64
	DelayMS int
}

// DragDelta 表示相对按压起点的水平/垂直增量点。
type DragDelta struct {
	DX      float64
	DY      float64
	DelayMS int
}

// DragPlan 描述一次完整滑块拖拽轨迹与停顿分布。
type DragPlan struct {
	Origin           DragPoint
	Distance         float64
	Approach         []DragPoint
	Points           []DragDelta
	ApproachSettleMS int
	PressHoldMS      int
	ReleaseHoldMS    int
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func clampFloat(v, minV, maxV float64) float64 {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

// BuildApproachPath 生成鼠标从目标点左下方沿着二次贝塞尔缓动移动的接近轨迹。
func BuildApproachPath(target DragPoint, rng func() float64, steps int, offsetX, offsetY, jitter float64) []DragPoint {
	if rng == nil {
		rng = rand.Float64
	}
	if steps < 8 {
		steps = 45
	}
	startX := target.X + offsetX
	startY := target.Y + offsetY
	points := make([]DragPoint, 0, steps)
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		var eased float64
		if t < 0.5 {
			eased = 2 * t * t
		} else {
			u := -2*t + 2
			eased = 1 - (u*u)/2
		}
		points = append(points, DragPoint{
			X:       round2(startX + (target.X-startX)*eased + (rng()-0.5)*jitter),
			Y:       round2(startY + (target.Y-startY)*eased + (rng()-0.5)*jitter),
			DelayMS: int(math.Round(18 + rng()*12)),
		})
	}
	return points
}

// BuildDragPoints 生成起手快、尾段慢（1-(1-t)^2.4）且末段含三段过冲回弹的拖拽轨迹。
func BuildDragPoints(distance float64, rng func() float64, steps int, overshoot float64) []DragDelta {
	if rng == nil {
		rng = rand.Float64
	}
	if steps <= 0 {
		if math.Abs(distance) > 160 {
			steps = 52
		} else {
			steps = 36
		}
	}
	if steps < 10 {
		steps = 10
	}
	if overshoot < 0 {
		overshoot = 2 + rng()*4
	}
	direction := 1.0
	if distance < 0 {
		direction = -1.0
	}
	points := make([]DragDelta, 0, steps+3)
	progress := 0.0
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		eased := 1 - math.Pow(1-t, 2.4)
		cand := math.Min(1.0, eased+(rng()-0.5)*0.01)
		if cand > progress {
			progress = cand
		}
		points = append(points, DragDelta{
			DX:      round2(distance * progress),
			DY:      round2((rng()-0.5)*1.6 + math.Sin(t*math.Pi*2)*0.6),
			DelayMS: int(math.Round(9 + rng()*13)),
		})
	}
	if overshoot > 0 {
		points = append(points,
			DragDelta{DX: round2(distance + direction*overshoot), DY: round2((rng() - 0.5) * 1.2), DelayMS: int(math.Round(40 + rng()*40))},
			DragDelta{DX: round2(distance - direction*overshoot*0.4), DY: round2((rng() - 0.5) * 1.2), DelayMS: int(math.Round(30 + rng()*30))},
			DragDelta{DX: round2(distance), DY: 0, DelayMS: int(math.Round(60 + rng()*50))},
		)
	}
	return points
}

// BuildDragPlan 组装一次完整滑块拖拽计划。
func BuildDragPlan(origin DragPoint, distance float64, rng func() float64) DragPlan {
	if rng == nil {
		rng = rand.Float64
	}
	return DragPlan{
		Origin:           origin,
		Distance:         distance,
		Approach:         BuildApproachPath(origin, rng, 45, -320, 260, 3),
		Points:           BuildDragPoints(distance, rng, 0, -1),
		ApproachSettleMS: int(math.Round(100 + rng()*80)),
		PressHoldMS:      int(math.Round(70 + rng()*60)),
		ReleaseHoldMS:    int(math.Round(120 + rng()*160)),
	}
}

// ComputePuzzleAlphaOffsetPNG 解析拼图 PNG 的非透明包围盒，返回需拖动的水平像素偏移。
func ComputePuzzleAlphaOffsetPNG(pngBytes []byte, displayWidth, boxWidth float64) (int, error) {
	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return 0, errors.New("image_decode_failed")
	}
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width <= 0 || height <= 0 {
		return 0, errors.New("puzzle_not_loaded")
	}
	if boxWidth > 0 && displayWidth > 0 && displayWidth < boxWidth*0.8 {
		return 0, errors.New("puzzle_image_cropped")
	}
	scan := func(minAlpha uint8) (minX int, found bool) {
		minX = width
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				_, _, _, a16 := img.At(x, y).RGBA()
				a8 := uint8(a16 >> 8)
				if a8 < minAlpha {
					continue
				}
				relX := x - bounds.Min.X
				if !found || relX < minX {
					minX = relX
					found = true
				}
			}
		}
		return minX, found
	}
	minX, found := scan(200)
	if !found {
		minX, found = scan(24)
	}
	if !found {
		return 0, errors.New("puzzle_empty")
	}
	scale := 1.0
	if displayWidth > 0 {
		scale = displayWidth / float64(width)
	}
	return int(math.Round(float64(minX) * scale)), nil
}

// --- 控件探测与交互式解算流程 ---

type rectSnapshot struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (r *rectSnapshot) center() DragPoint {
	return DragPoint{X: r.X + r.Width/2, Y: r.Y + r.Height/2}
}

type widgetSnapshot struct {
	Settled bool `json:"settled"`
	Outcome *struct {
		OK    bool   `json:"ok"`
		Stage string `json:"stage"`
	} `json:"outcome"`
	Slider         *rectSnapshot `json:"slider"`
	Track          *rectSnapshot `json:"track"`
	TrackClassName string        `json:"trackClassName"`
	TrackState     []string      `json:"trackState"`
	Box            *rectSnapshot `json:"box"`
	Puzzle         *struct {
		Present       bool          `json:"present"`
		Visible       bool          `json:"visible"`
		Rect          *rectSnapshot `json:"rect"`
		NaturalWidth  float64       `json:"naturalWidth"`
		NaturalHeight float64       `json:"naturalHeight"`
		Complete      bool          `json:"complete"`
		Src           string        `json:"src"`
	} `json:"puzzle"`
	Text     string `json:"text"`
	Question string `json:"question"`
}

type challengeState struct {
	kind     string
	ready    bool
	snapshot widgetSnapshot
}

// ClassifyChallenge 从控件 DOM 快照识别当前交互挑战类型（puzzle-drag / slide-to-end / text-click）。
func classifyWidgetChallenge(snap *widgetSnapshot) *challengeState {
	if snap == nil {
		return nil
	}
	hasSlider := snap.Slider != nil && snap.Track != nil
	if !hasSlider {
		if strings.TrimSpace(snap.Question) != "" {
			return &challengeState{kind: "text-click", ready: true, snapshot: *snap}
		}
		return nil
	}
	puzzlePresent := (snap.Puzzle != nil && snap.Puzzle.Present) || strings.Contains(snap.TrackClassName, "puzzle")
	if !puzzlePresent {
		return &challengeState{kind: "slide-to-end", ready: true, snapshot: *snap}
	}
	ready := snap.Puzzle != nil && snap.Puzzle.Visible && snap.Puzzle.NaturalWidth > 0 && snap.Puzzle.NaturalHeight > 0
	return &challengeState{kind: "puzzle-drag", ready: ready, snapshot: *snap}
}

const widgetProbeExpression = `(() => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rectOf = (element) => {
    if (!visible(element)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
  const track = document.querySelector('#aliyunCaptcha-sliding-body');
  const puzzle = document.querySelector('#aliyunCaptcha-puzzle');
  const box = document.querySelector('#aliyunCaptcha-img-box');
  const text = document.querySelector('#aliyunCaptcha-sliding-text');
  const question = document.querySelector('#aliyunCaptcha-question');
  const outcome = window.__aihCaptchaOutcome || null;
  return {
    settled: Boolean(outcome),
    outcome: outcome ? { ok: outcome.ok === true, stage: outcome.stage || null } : null,
    slider: rectOf(slider),
    track: rectOf(track),
    trackClassName: track ? String(track.className || '') : '',
    trackState: track ? ['verified', 'fail', 'slided'].filter((name) => track.classList.contains(name)) : [],
    box: rectOf(box),
    puzzle: puzzle ? {
      present: true,
      visible: visible(puzzle),
      rect: rectOf(puzzle),
      naturalWidth: puzzle.naturalWidth || 0,
      naturalHeight: puzzle.naturalHeight || 0,
      complete: Boolean(puzzle.complete),
      src: String(puzzle.currentSrc || puzzle.src || '')
    } : null,
    text: text ? String(text.textContent || '').trim() : '',
    question: question ? String(question.textContent || '').trim() : ''
  };
})()`

const captchaButtonExpression = `(() => {
  const host = document.getElementById('aih-captcha-host');
  if (!host) return null;
  const nodes = Array.from(host.querySelectorAll('*')).filter((node) => (
    node.children.length === 0 && /点击|开始验证/.test(node.textContent || '')
  ));
  if (nodes.length === 0) return null;
  const box = nodes[0].getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
})()`

func buildCaptchaExpression(sceneID, prefix, region string) string {
	sceneJSON, _ := json.Marshal(sceneID)
	prefixJSON, _ := json.Marshal(prefix)
	regionJSON, _ := json.Marshal(region)
	sdkJSON, _ := json.Marshal(captchaSDKURL)
	return fmt.Sprintf(`(async () => {
    window.AliyunCaptchaConfig = { region: %s, prefix: %s };
    window.__aihCaptchaOutcome = null;
    window.__aihCaptchaInstance = null;
    const loadSdk = () => new Promise((resolve, reject) => {
      if (typeof window.initAliyunCaptcha === 'function') return resolve();
      const script = document.createElement('script');
      script.src = %s;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('captcha_sdk_load_failed'));
      document.head.appendChild(script);
    });
    try {
      await loadSdk();
    } catch (error) {
      return { ok: false, stage: 'sdk', error: String(error && error.message || error) };
    }
    try {
      window.initAliyunCaptcha({
        SceneId: %s,
        mode: 'embed',
        language: 'cn',
        showErrorTip: false,
        element: '#aih-captcha-host',
        getInstance: (instance) => {
          try {
            window.__aihCaptchaInstance = new Proxy(instance, {
              get(target, property) {
                if (property === 'startTracelessVerification') return undefined;
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          } catch (_error) {
            window.__aihCaptchaInstance = instance;
          }
        },
        success: (param) => { window.__aihCaptchaOutcome = { ok: true, param: String(param || '') }; },
        fail: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'fail', error }; },
        onError: (error) => { window.__aihCaptchaOutcome = { ok: false, stage: 'onError', error }; }
      });
    } catch (error) {
      return { ok: false, stage: 'init', error: String(error && error.message || error) };
    }
    return { ok: false, stage: 'ready' };
  })()`, regionJSON, prefixJSON, sdkJSON, sceneJSON)
}

func buildPuzzleOffsetExpression(dataURL string, boxWidth, displayWidth float64) string {
	loadImg := `const image = document.querySelector("#aliyunCaptcha-puzzle");
       if (!image) return { ok: false, reason: 'puzzle_missing' };
       if (!image.complete || !image.naturalWidth) {
         try { await image.decode(); } catch (_error) { return { ok: false, reason: 'puzzle_not_loaded' }; }
       }`
	if dataURL != "" {
		dJSON, _ := json.Marshal(dataURL)
		loadImg = fmt.Sprintf(`const image = new Image();
       image.src = %s;
       try { await image.decode(); } catch (_error) { return { ok: false, reason: 'image_decode_failed' }; }`, dJSON)
	}
	boxSource := `const box = document.querySelector("#aliyunCaptcha-img-box");
       const boxWidth = box ? box.getBoundingClientRect().width : 0;`
	if boxWidth > 0 {
		boxSource = fmt.Sprintf(`const boxWidth = %v;`, boxWidth)
	}
	displaySource := `const displayWidth = (typeof image.getBoundingClientRect === 'function' ? image.getBoundingClientRect().width : 0) || 0;`
	if displayWidth > 0 {
		displaySource = fmt.Sprintf(`const displayWidth = %v;`, displayWidth)
	}
	return fmt.Sprintf(`(async () => {
    %s
    const width = image.naturalWidth || 0;
    const height = image.naturalHeight || 0;
    if (!width || !height) return { ok: false, reason: 'puzzle_not_loaded' };
    %s
    %s
    if (boxWidth && displayWidth && displayWidth < boxWidth * 0.8) {
      return { ok: false, reason: 'puzzle_image_cropped', naturalWidth: width, displayWidth, boxWidth };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { ok: false, reason: 'canvas_unavailable' };
    context.drawImage(image, 0, 0, width, height);
    let data;
    try {
      data = context.getImageData(0, 0, width, height).data;
    } catch (_error) {
      return { ok: false, reason: 'tainted_canvas', src: String(image.currentSrc || image.src || ''), naturalWidth: width, naturalHeight: height };
    }
    const scan = (threshold) => {
      let minX = width, maxX = -1, minY = height, maxY = -1, count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (data[(y * width + x) * 4 + 3] < threshold) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count += 1;
        }
      }
      return count > 0 ? { minX, maxX, minY, maxY, count } : null;
    };
    const piece = scan(200) || scan(24);
    if (!piece) return { ok: false, reason: 'puzzle_empty' };
    const scale = displayWidth > 0 ? displayWidth / width : 1;
    return { ok: true, naturalWidth: width, naturalHeight: height, displayWidth, boxWidth, scale, offset: Math.round(piece.minX * scale) };
  })()`, loadImg, boxSource, displaySource)
}

func cdpEval(ctx context.Context, cdp CDPClient, sessionID, expression string, awaitPromise bool, dest any) error {
	raw, err := cdp.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    expression,
		"awaitPromise":  awaitPromise,
		"returnByValue": true,
	}, sessionID)
	if err != nil {
		return err
	}
	var env struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Exception *struct {
				Description string `json:"description"`
				Value       any    `json:"value"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.ExceptionDetails != nil {
		detail := "unknown"
		if env.ExceptionDetails.Exception != nil {
			if env.ExceptionDetails.Exception.Description != "" {
				detail = env.ExceptionDetails.Exception.Description
			} else if env.ExceptionDetails.Exception.Value != nil {
				detail = fmt.Sprint(env.ExceptionDetails.Exception.Value)
			}
		}
		return errors.New("captcha_evaluate_failed:" + detail)
	}
	if dest == nil || len(env.Result.Value) == 0 || string(env.Result.Value) == "null" {
		return nil
	}
	return json.Unmarshal(env.Result.Value, dest)
}

func moveCaptchaWindowOffscreen(ctx context.Context, cdp CDPClient, targetID string) {
	raw, err := cdp.Call(ctx, "Browser.getWindowForTarget", map[string]any{"targetId": targetID}, "")
	if err != nil {
		return
	}
	var win struct {
		WindowID int `json:"windowId"`
	}
	if json.Unmarshal(raw, &win) != nil || win.WindowID == 0 {
		return
	}
	_, _ = cdp.Call(ctx, "Browser.setWindowBounds", map[string]any{
		"windowId": win.WindowID,
		"bounds":   map[string]any{"left": captchaOffscreenLeft, "top": captchaOffscreenTop},
	}, "")
}

func ensureCaptchaPageTarget(ctx context.Context, cdp CDPClient) (string, error) {
	raw, err := cdp.Call(ctx, "Target.getTargets", map[string]any{}, "")
	if err != nil {
		return "", err
	}
	var targets struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
		} `json:"targetInfos"`
	}
	if json.Unmarshal(raw, &targets) == nil {
		for _, info := range targets.TargetInfos {
			if info.Type == "page" && info.TargetID != "" {
				return info.TargetID, nil
			}
		}
	}
	createdRaw, err := cdp.Call(ctx, "Target.createTarget", map[string]any{
		"url":       "about:blank",
		"newWindow": true,
	}, "")
	if err != nil {
		return "", err
	}
	var created struct {
		TargetID string `json:"targetId"`
	}
	if json.Unmarshal(createdRaw, &created) != nil || created.TargetID == "" {
		return "", errors.New(`captcha_failed:{"ok":false,"stage":"target_missing"}`)
	}
	return created.TargetID, nil
}

func waitForCaptchaDocument(ctx context.Context, cdp CDPClient, sessionID string, timeout time.Duration) (ready bool) {
	if timeout < time.Second {
		timeout = captchaPageReadyTime
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var doc struct {
			Origin  string `json:"origin"`
			Ready   string `json:"ready"`
			HasBody bool   `json:"hasBody"`
		}
		err := cdpEval(ctx, cdp, sessionID, `({ origin: String(location.origin), ready: String(document.readyState), hasBody: Boolean(document.body) })`, false, &doc)
		if err == nil && doc.Origin == captchaPageOrigin && doc.HasBody {
			ready = true
			if doc.Ready == "complete" {
				return true
			}
		}
		if sleepWithContext(ctx, 200*time.Millisecond) != nil {
			return ready
		}
	}
	return ready
}

func waitForCaptchaButton(ctx context.Context, cdp CDPClient, sessionID string, timeout time.Duration) (*DragPoint, error) {
	if timeout < time.Second {
		timeout = captchaWidgetTimeout
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var pt DragPoint
		pt.X = -1
		err := cdpEval(ctx, cdp, sessionID, captchaButtonExpression, false, &pt)
		if err != nil {
			return nil, err
		}
		if pt.X >= 0 {
			return &pt, nil
		}
		if sleepWithContext(ctx, 200*time.Millisecond) != nil {
			return nil, nil
		}
	}
	return nil, nil
}

func dispatchHumanClick(ctx context.Context, cdp CDPClient, sessionID string, point DragPoint) error {
	approach := BuildApproachPath(point, nil, 45, -320, 260, 3)
	for _, pt := range approach {
		if _, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved",
			"x":    pt.X,
			"y":    pt.Y,
		}, sessionID); err != nil {
			return err
		}
		if err := sleepWithContext(ctx, time.Duration(pt.DelayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	if err := sleepWithContext(ctx, 180*time.Millisecond); err != nil {
		return err
	}
	if _, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mousePressed", "x": point.X, "y": point.Y, "button": "left", "clickCount": 1,
	}, sessionID); err != nil {
		return err
	}
	hold := 90 + rand.Intn(60)
	if err := sleepWithContext(ctx, time.Duration(hold)*time.Millisecond); err != nil {
		return err
	}
	_, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseReleased", "x": point.X, "y": point.Y, "button": "left", "clickCount": 1,
	}, sessionID)
	return err
}

func performCDPDrag(ctx context.Context, cdp CDPClient, sessionID string, plan DragPlan) error {
	for _, pt := range plan.Approach {
		if _, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved", "x": pt.X, "y": pt.Y,
		}, sessionID); err != nil {
			return err
		}
		if err := sleepWithContext(ctx, time.Duration(pt.DelayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	if err := sleepWithContext(ctx, time.Duration(plan.ApproachSettleMS)*time.Millisecond); err != nil {
		return err
	}
	if _, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mousePressed", "x": plan.Origin.X, "y": plan.Origin.Y,
		"button": "left", "buttons": 1, "clickCount": 1,
	}, sessionID); err != nil {
		return err
	}
	if err := sleepWithContext(ctx, time.Duration(plan.PressHoldMS)*time.Millisecond); err != nil {
		return err
	}
	lastX, lastY := plan.Origin.X, plan.Origin.Y
	for _, delta := range plan.Points {
		lastX = round2(plan.Origin.X + delta.DX)
		lastY = round2(plan.Origin.Y + delta.DY)
		if _, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved", "x": lastX, "y": lastY,
			"button": "left", "buttons": 1,
		}, sessionID); err != nil {
			return err
		}
		if err := sleepWithContext(ctx, time.Duration(delta.DelayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	if err := sleepWithContext(ctx, time.Duration(plan.ReleaseHoldMS)*time.Millisecond); err != nil {
		return err
	}
	_, err := cdp.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseReleased", "x": lastX, "y": lastY,
		"button": "left", "buttons": 0, "clickCount": 1,
	}, sessionID)
	return err
}

func readWidgetSnapshot(ctx context.Context, cdp CDPClient, sessionID string) (*widgetSnapshot, error) {
	var snap widgetSnapshot
	if err := cdpEval(ctx, cdp, sessionID, widgetProbeExpression, false, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

func waitForChallenge(ctx context.Context, cdp CDPClient, sessionID string, timeout time.Duration) (*challengeState, error) {
	deadline := time.Now().Add(timeout)
	for {
		snap, err := readWidgetSnapshot(ctx, cdp, sessionID)
		if err != nil {
			return nil, err
		}
		if snap != nil && snap.Settled {
			return nil, nil
		}
		ch := classifyWidgetChallenge(snap)
		if ch != nil && ch.ready {
			return ch, nil
		}
		if !time.Now().Before(deadline) {
			return nil, nil
		}
		if sleepWithContext(ctx, 250*time.Millisecond) != nil {
			return nil, nil
		}
	}
}

func waitForChallengeOutcome(ctx context.Context, cdp CDPClient, sessionID string, baselineSrc string, timeout time.Duration) string {
	if timeout < time.Second {
		timeout = 6 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		snap, err := readWidgetSnapshot(ctx, cdp, sessionID)
		if err != nil || snap == nil {
			return "timeout"
		}
		if snap.Outcome != nil {
			if snap.Outcome.OK {
				return "verified"
			}
			return "failed"
		}
		for _, st := range snap.TrackState {
			if st == "verified" {
				return "verified"
			}
		}
		for _, st := range snap.TrackState {
			if st == "fail" {
				src := ""
				if snap.Puzzle != nil {
					src = snap.Puzzle.Src
				}
				if baselineSrc == "" || src != baselineSrc {
					return "failed"
				}
			}
		}
		if !time.Now().Before(deadline) {
			return "timeout"
		}
		if sleepWithContext(ctx, 150*time.Millisecond) != nil {
			return "timeout"
		}
	}
}

func readPuzzleOffset(ctx context.Context, cdp CDPClient, sessionID string, ch *challengeState) (int, error) {
	type offsetResult struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Src    string `json:"src"`
		Offset int    `json:"offset"`
	}
	var res offsetResult
	if err := cdpEval(ctx, cdp, sessionID, buildPuzzleOffsetExpression("", 0, 0), true, &res); err != nil {
		return 0, err
	}
	if res.OK {
		return res.Offset, nil
	}
	if res.Reason == "tainted_canvas" && res.Src != "" {
		imgBytes, contentType, err := fetchImageBytes(ctx, res.Src)
		if err == nil && len(imgBytes) > 0 {
			boxW := 0.0
			if ch.snapshot.Box != nil && ch.snapshot.Box.Width > 0 {
				boxW = ch.snapshot.Box.Width
			} else if ch.snapshot.Track != nil {
				boxW = ch.snapshot.Track.Width
			}
			displayW := 0.0
			if ch.snapshot.Puzzle != nil && ch.snapshot.Puzzle.Rect != nil {
				displayW = ch.snapshot.Puzzle.Rect.Width
			}
			if off, pngErr := ComputePuzzleAlphaOffsetPNG(imgBytes, displayW, boxW); pngErr == nil {
				return off, nil
			}
			dataURL := fmt.Sprintf("data:%s;base64,%s", contentType, base64.StdEncoding.EncodeToString(imgBytes))
			var retried offsetResult
			if err := cdpEval(ctx, cdp, sessionID, buildPuzzleOffsetExpression(dataURL, boxW, displayW), true, &retried); err == nil && retried.OK {
				return retried.Offset, nil
			}
		}
	}
	return 0, errors.New("offset_" + firstNonEmptyString(res.Reason, "unknown"))
}

func fetchImageBytes(ctx context.Context, imgURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if err != nil {
		return nil, "", err
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("http_%d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, captchaMaxImageBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > captchaMaxImageBytes {
		return nil, "", errors.New("invalid_image_bytes")
	}
	ct := strings.SplitN(firstNonEmptyString(resp.Header.Get("Content-Type"), "image/png"), ";", 2)[0]
	return raw, ct, nil
}

func solveChallenge(ctx context.Context, cdp CDPClient, sessionID string, ch *challengeState, budget time.Duration) error {
	if ch == nil {
		return nil
	}
	outcomeTimeout := budget - 2*time.Second
	if outcomeTimeout > 6*time.Second {
		outcomeTimeout = 6 * time.Second
	}
	if outcomeTimeout < time.Second {
		outcomeTimeout = time.Second
	}

	switch ch.kind {
	case "slide-to-end":
		maxDist := math.Max(0, ch.snapshot.Track.Width-ch.snapshot.Slider.Width)
		plan := BuildDragPlan(ch.snapshot.Slider.center(), maxDist, nil)
		if err := performCDPDrag(ctx, cdp, sessionID, plan); err != nil {
			return err
		}
		if out := waitForChallengeOutcome(ctx, cdp, sessionID, "", outcomeTimeout); out != "verified" {
			return fmt.Errorf(`captcha_failed:{"ok":false,"stage":"challenge","kind":"slide-to-end","reason":%q}`, out)
		}
		return nil

	case "puzzle-drag":
		excludeSrc := ""
		lastReason := "unknown"
		for attempt := 1; attempt <= 2; attempt++ {
			curr := ch
			if attempt > 1 {
				started := time.Now()
				deadline := started.Add(15 * time.Second)
				var settled bool
				var nextCh *challengeState
				for time.Now().Before(deadline) {
					snap, err := readWidgetSnapshot(ctx, cdp, sessionID)
					if err != nil {
						break
					}
					if snap != nil && snap.Settled {
						if snap.Outcome != nil && snap.Outcome.OK {
							return nil
						}
						settled = true
						break
					}
					cand := classifyWidgetChallenge(snap)
					if cand != nil && cand.ready {
						src := ""
						if cand.snapshot.Puzzle != nil {
							src = cand.snapshot.Puzzle.Src
						}
						if excludeSrc == "" || src != excludeSrc || time.Since(started) > 1500*time.Millisecond {
							nextCh = cand
							break
						}
					}
					if sleepWithContext(ctx, 250*time.Millisecond) != nil {
						break
					}
				}
				if settled {
					return errors.New(`captcha_failed:{"ok":false,"stage":"challenge","kind":"puzzle-drag","reason":"settled_failed"}`)
				}
				if nextCh == nil {
					return errors.New(`captcha_failed:{"ok":false,"stage":"challenge","kind":"puzzle-drag","reason":"challenge_not_ready"}`)
				}
				curr = nextCh
			}
			offset, err := readPuzzleOffset(ctx, cdp, sessionID, curr)
			if err != nil {
				return fmt.Errorf(`captcha_failed:{"ok":false,"stage":"challenge","kind":"puzzle-drag","reason":%q}`, err.Error())
			}
			maxDist := math.Max(0, curr.snapshot.Track.Width-curr.snapshot.Slider.Width)
			pieceLeft := 0.0
			if curr.snapshot.Puzzle != nil && curr.snapshot.Puzzle.Rect != nil && curr.snapshot.Box != nil {
				pieceLeft = curr.snapshot.Puzzle.Rect.X - curr.snapshot.Box.X
			}
			distance := clampFloat(float64(offset)-pieceLeft, 0, maxDist)
			plan := BuildDragPlan(curr.snapshot.Slider.center(), distance, nil)
			if err := performCDPDrag(ctx, cdp, sessionID, plan); err != nil {
				return err
			}
			src := ""
			if curr.snapshot.Puzzle != nil {
				src = curr.snapshot.Puzzle.Src
			}
			out := waitForChallengeOutcome(ctx, cdp, sessionID, src, outcomeTimeout)
			if out == "verified" {
				return nil
			}
			lastReason = out
			excludeSrc = src
			if out == "timeout" {
				break
			}
		}
		return fmt.Errorf(`captcha_failed:{"ok":false,"stage":"challenge","kind":"puzzle-drag","reason":%q}`, lastReason)

	default:
		return errors.New("captcha_unsupported:" + firstNonEmptyString(ch.kind, "unknown"))
	}
}

func runCaptchaInteractionWithCDP(
	ctx context.Context,
	cdp CDPClient,
	sessionID string,
	req CaptchaSolveRequest,
	beforeClick func(),
	remainingBudget time.Duration,
) (string, error) {
	region := firstNonEmptyString(req.Region, "cn")
	var initState struct {
		OK    bool   `json:"ok"`
		Stage string `json:"stage"`
		Error string `json:"error"`
	}
	if err := cdpEval(ctx, cdp, sessionID, buildCaptchaExpression(req.SceneID, req.Prefix, region), true, &initState); err != nil {
		return "", err
	}
	if initState.Stage != "ready" {
		b, _ := json.Marshal(initState)
		return "", errors.New("captcha_failed:" + string(b))
	}
	widgetTimeout := captchaWidgetTimeout
	if rem := remainingBudget - 10*time.Second; rem < widgetTimeout {
		if rem < 2*time.Second {
			rem = 2 * time.Second
		}
		widgetTimeout = rem
	}
	btnPoint, err := waitForCaptchaButton(ctx, cdp, sessionID, widgetTimeout)
	if err != nil {
		return "", err
	}
	if btnPoint == nil {
		return "", errors.New(`captcha_failed:{"ok":false,"stage":"button_missing"}`)
	}
	if beforeClick != nil {
		beforeClick()
	}
	if err := dispatchHumanClick(ctx, cdp, sessionID, *btnPoint); err != nil {
		return "", err
	}

	chTimeout := remainingBudget - 5*time.Second
	if chTimeout > 15*time.Second {
		chTimeout = 15 * time.Second
	}
	if chTimeout < time.Second {
		chTimeout = time.Second
	}
	started := time.Now()
	ch, err := waitForChallenge(ctx, cdp, sessionID, chTimeout)
	if err != nil {
		return "", err
	}
	if ch != nil {
		if err := solveChallenge(ctx, cdp, sessionID, ch, remainingBudget); err != nil {
			return "", err
		}
	}

	outRemaining := remainingBudget - time.Since(started)
	if outRemaining < 5*time.Second {
		outRemaining = 5 * time.Second
	}
	expr := fmt.Sprintf(`(async () => {
      const deadline = Date.now() + %d;
      while (Date.now() < deadline) {
        if (window.__aihCaptchaOutcome) return window.__aihCaptchaOutcome;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { ok: false, stage: 'timeout' };
    })()`, outRemaining.Milliseconds())
	var outcome struct {
		OK    bool   `json:"ok"`
		Stage string `json:"stage"`
		Param string `json:"param"`
		Error any    `json:"error"`
	}
	if err := cdpEval(ctx, cdp, sessionID, expr, true, &outcome); err != nil {
		return "", err
	}
	if !outcome.OK || strings.TrimSpace(outcome.Param) == "" {
		b, _ := json.Marshal(outcome)
		return "", errors.New("captcha_failed:" + string(b))
	}
	return strings.TrimSpace(outcome.Param), nil
}

func solveAliyunCaptchaOnce(ctx context.Context, req CaptchaSolveRequest) (string, error) {
	deadline := req.Timeout
	if deadline < 10*time.Second {
		deadline = captchaDefaultTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()

	executable, err := ResolveChromeExecutable(req.ExecutablePath, runtime.GOOS, req.HostHomeDir)
	if err != nil {
		return "", err
	}
	userDataDir, err := os.MkdirTemp("", "aih-captcha-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(userDataDir) }()

	args := BuildCaptchaLaunchArgs(userDataDir)
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		if bundle := ResolveMacAppBundle(executable); bundle != "" {
			openArgs := append([]string{"-g", "-na", bundle, "--args"}, args...)
			cmd = exec.Command("open", openArgs...)
		}
	}
	if cmd == nil {
		cmd = exec.Command(executable, args...)
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}

	var cdp *wsCDPClient
	devtoolsPort := 0
	defer func() {
		if cdp != nil {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
			_, _ = cdp.Call(closeCtx, "Browser.close", map[string]any{}, "")
			closeCancel()
			cdp.Close()
		}
		killBrowserOnPort(devtoolsPort)
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	}()

	dtTimeout := captchaDevtoolsTimeout
	if deadline < dtTimeout {
		dtTimeout = deadline
	}
	port, wsPath, err := waitForDevtoolsPort(callCtx, userDataDir, dtTimeout)
	if err != nil {
		return "", err
	}
	devtoolsPort = port
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d%s", port, wsPath)
	cdp, err = dialWSCDPClient(callCtx, wsURL)
	if err != nil {
		return "", err
	}

	targetID, err := ensureCaptchaPageTarget(callCtx, cdp)
	if err != nil {
		return "", err
	}
	moveCaptchaWindowOffscreen(callCtx, cdp, targetID)
	attRaw, err := cdp.Call(callCtx, "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, "")
	if err != nil {
		return "", err
	}
	var att struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(attRaw, &att) != nil || att.SessionID == "" {
		return "", errors.New(`captcha_failed:{"ok":false,"stage":"attach_failed"}`)
	}
	sessionID := att.SessionID
	_, _ = cdp.Call(callCtx, "Page.enable", map[string]any{}, sessionID)
	_, _ = cdp.Call(callCtx, "Runtime.enable", map[string]any{}, sessionID)

	go func() {
		_, _ = cdp.Call(callCtx, "Page.navigate", map[string]any{"url": captchaPageURL}, sessionID)
	}()

	deadlineAt := time.Now().Add(deadline)
	pageReadyTimeout := captchaPageReadyTime
	if rem := time.Until(deadlineAt) - 20*time.Second; rem < pageReadyTimeout {
		if rem < 5*time.Second {
			rem = 5 * time.Second
		}
		pageReadyTimeout = rem
	}
	if !waitForCaptchaDocument(callCtx, cdp, sessionID, pageReadyTimeout) {
		return "", errors.New(`captcha_failed:{"ok":false,"stage":"page_not_ready"}`)
	}
	if err := sleepWithContext(callCtx, captchaPageSettleDelay); err != nil {
		return "", err
	}

	_, err = cdp.Call(callCtx, "Runtime.evaluate", map[string]any{
		"expression": `(() => {
        if (!document.getElementById('aih-captcha-host')) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'position:fixed;top:80px;left:80px;width:460px;padding:12px;background:#fff;border:2px solid #e5e7eb;border-radius:8px;z-index:2147483647;';
          const host = document.createElement('div');
          host.id = 'aih-captcha-host';
          host.style.cssText = 'min-height:420px;';
          wrap.appendChild(host);
          document.body.appendChild(wrap);
        }
        return true;
      })()`,
		"returnByValue": true,
	}, sessionID)
	if err != nil {
		return "", err
	}

	return runCaptchaInteractionWithCDP(callCtx, cdp, sessionID, req, func() {
		moveCaptchaWindowOffscreen(callCtx, cdp, targetID)
	}, time.Until(deadlineAt)-time.Second)
}
