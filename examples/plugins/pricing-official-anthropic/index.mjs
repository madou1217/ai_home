// P5 官方价格源样例：数据是离线快照，网络权限只用于声明来源 URL。
// 真实部署中把 QUOTES 换成官方页面/合同的机器可读快照，复核通过后才会生效。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE = {
  "id": "official:anthropic",
  "kind": "official",
  "authority": 90,
  "confidence": 0.9,
  "url": "https://www.anthropic.com/pricing",
  "fetchedAt": "2026-10-20T00:00:00.000Z"
};

const QUOTES = [
  {
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:anthropic",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://www.anthropic.com/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "input": 3,
    "output": 15,
    "cacheRead": 0.3,
    "cacheWrite": 3.75,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:anthropic",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://www.anthropic.com/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "input": 1,
    "output": 5,
    "cacheRead": 0.1,
    "cacheWrite": 1.25,
    "cacheWrite1h": null,
    "reasoning": null,
    "source": {
      "id": "official:anthropic",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://www.anthropic.com/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  }
];

export default definePlugin({
  name: "aih.pricing.official.anthropic",
  apply(ctx) {
    ctx.aih.register("aih.pricing.official.anthropic.catalog", () => ({
      generatedAt: SOURCE.fetchedAt,
      source: SOURCE,
      quotes: QUOTES
    }));
  }
});
