// P5 官方价格源样例：数据是离线快照，网络权限只用于声明来源 URL。
// 真实部署中把 QUOTES 换成官方页面/合同的机器可读快照，复核通过后才会生效。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE = {
  "id": "official:openai",
  "kind": "official",
  "authority": 90,
  "confidence": 0.9,
  "url": "https://openai.com/api/pricing/",
  "fetchedAt": "2026-10-20T00:00:00.000Z"
};

const QUOTES = [
  {
    "provider": "openai",
    "model": "gpt-5.4",
    "input": 2.5,
    "output": 15,
    "cacheRead": 0.25,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:openai",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://openai.com/api/pricing/",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "openai",
    "model": "gpt-5.4-mini",
    "input": 0.75,
    "output": 4.5,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:openai",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://openai.com/api/pricing/",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "openai",
    "model": "gpt-5.3-codex",
    "input": 1.75,
    "output": 14,
    "cacheRead": 0.175,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:openai",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://openai.com/api/pricing/",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  }
];

export default definePlugin({
  name: "aih.pricing.official.openai",
  apply(ctx) {
    ctx.aih.register("aih.pricing.official.openai.catalog", () => ({
      generatedAt: SOURCE.fetchedAt,
      source: SOURCE,
      quotes: QUOTES
    }));
  }
});
