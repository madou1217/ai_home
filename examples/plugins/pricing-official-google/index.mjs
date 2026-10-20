// P5 官方价格源样例：数据是离线快照，网络权限只用于声明来源 URL。
// 真实部署中把 QUOTES 换成官方页面/合同的机器可读快照，复核通过后才会生效。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE = {
  "id": "official:google",
  "kind": "official",
  "authority": 90,
  "confidence": 0.9,
  "url": "https://ai.google.dev/gemini-api/docs/pricing",
  "fetchedAt": "2026-10-20T00:00:00.000Z"
};

const QUOTES = [
  {
    "provider": "google",
    "model": "gemini-3.1-pro-preview",
    "input": 2,
    "output": 12,
    "cacheRead": 0.2,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:google",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://ai.google.dev/gemini-api/docs/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "google",
    "model": "gemini-3.5-flash",
    "input": 1.5,
    "output": 9,
    "cacheRead": 0.15,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:google",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://ai.google.dev/gemini-api/docs/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "google",
    "model": "gemini-3.8-flash",
    "input": 0.75,
    "output": 3.75,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:google",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://ai.google.dev/gemini-api/docs/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  }
];

export default definePlugin({
  name: "aih.pricing.official.google",
  apply(ctx) {
    ctx.aih.register("aih.pricing.official.google.catalog", () => ({
      generatedAt: SOURCE.fetchedAt,
      source: SOURCE,
      quotes: QUOTES
    }));
  }
});
