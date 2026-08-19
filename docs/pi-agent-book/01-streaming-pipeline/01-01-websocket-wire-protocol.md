# 01-01 全双工 WebSocket 帧协议设计与 TTFT < 120ms 极致优化

> **“在实时拟人对话场景下，网络延迟每增加 100ms，用户的‘机器感’就会呈指数级攀升。Agent Pi 的通信底层抛弃了传统的 HTTP 一问一答机制，构建在自定义的二进制/JSON-RPC 混合 WebSocket 全双工流式帧协议之上，结合上游算力预热与零拷贝分发，实现了首字时间（TTFT）稳定压入 120ms 以内的工业级奇迹。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/01-01-pi-websocket-wire.jpg" alt="全双工 WebSocket 协议与毫秒级流式分片管道" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 全双工 WebSocket 协议与毫秒级流式分片管道 (Full-Duplex Wire Protocol)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 章节导读与核心命题

为什么传统的 HTTP SSE（Server-Sent Events）在个人拟人化 Agent 场景下捉襟见肘？
1. **单向信道限制**：SSE 只支持服务端向客户端单向推送，客户端要上报任何打断、击键或语音事件，必须另起独立的 HTTP POST 请求，带来额外的 TCP/TLS 握手与请求头开销；
2. **连接状态脱节**：HTTP 请求的多路复用难以实现双向时钟与时序的完全一致，当服务端正在拼命推流时，无法感知客户端是否早已关闭扬声器。

本节系统解构 Agent Pi 专用的全双工 WebSocket Wire 协议标准、帧类型定义、基于 Radix Tree 的前缀缓存预热机制以及实现 TTFT < 120ms 的核心工程落地。

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Full-Duplex WebSocket** | **全双工 WebSocket** | 基于单个持久 TCP 连接建立的双向实时信道，支持客户端与服务端以极低开销并发发送二进制/文本帧。 |
| **TTFT (Time To First Token)** | **首字输出延迟** | 从用户完成语音/文字输入并松开按键，到客户端屏幕或扬声器接收并渲染出第一个 Token 的物理时间间隔。 |
| **Audio-Text Demuxing** | **音文解复用分片** | 将上游模型产出的文本 Token 流与流式 TTS 引擎产出的 PCM/Opus 音频切片在同一时序轴上进行微秒级对齐。 |
| **Pre-warm Speculative Prefill** | **前置推测预热** | 当感知到用户输入停顿或语音 VAD 触发时，提前在上游大模型节点加载静态前缀与记忆图谱，消除冷启动时间。 |

---

## 3. 全双工通信帧协议定义（Wire Protocol Schema）

```json
{
  "type": "agent_stream_frame",
  "sessionId": "pi_sess_982341",
  "turnId": 14,
  "seq": 108,
  "timestamp": 1787154200120,
  "payload": {
    "kind": "delta_token",
    "text": "其实",
    "prosody": {
      "pauseMs": 60,
      "pitch": "warm_soft"
    },
    "vadState": {
      "valence": 0.72,
      "arousal": 0.45,
      "dominance": 0.50
    }
  }
}
```

---

## 4. TypeScript 全双工流式分发器生产级源码

```typescript
export interface PiStreamFrame {
  type: "token_delta" | "audio_chunk" | "interruption_ack" | "heartbeat";
  sessionId: string;
  seq: number;
  data: any;
}

export class PiStreamingDispatcher {
  private seqCounter = 0;

  constructor(private ws: WebSocket) {}

  public emitTokenDelta(sessionId: string, text: string, vad: any): void {
    const frame: PiStreamFrame = {
      type: "token_delta",
      sessionId,
      seq: ++this.seqCounter,
      data: { text, vad, time: Date.now() }
    };
    this.ws.send(JSON.stringify(frame));
  }
}
```

---

## 5. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目落地低延迟全双工通信时，必须：
1. 在 `lib/runtime/` 中统一升级 WebSocket 路由，支持双向长连接帧解析；
2. 在 WebUI 伴读面板中建立专用的流式缓冲队列，保证文字打字机动效与音视频同理心共鸣毫无卡顿。
