// P5 官方价格源样例：数据是离线快照，网络权限只用于声明来源 URL。
// 真实部署中把 QUOTES 换成官方页面/合同的机器可读快照，复核通过后才会生效。
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE = {
  "id": "official:deepseek",
  "kind": "official",
  "authority": 90,
  "confidence": 0.9,
  "url": "https://api-docs.deepseek.com/quick_start/pricing",
  "fetchedAt": "2026-10-20T00:00:00.000Z"
};

const QUOTES = [
  {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "input": 0.66,
    "output": 1.98,
    "cacheRead": 0.022,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": 1.98,
    "source": {
      "id": "official:deepseek",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://api-docs.deepseek.com/quick_start/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  },
  {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.003,
    "cacheWrite": null,
    "cacheWrite1h": null,
    "reasoning": 0.6,
    "source": {
      "id": "official:deepseek",
      "kind": "official",
      "authority": 90,
      "confidence": 0.9,
      "url": "https://api-docs.deepseek.com/quick_start/pricing",
      "fetchedAt": "2026-10-20T00:00:00.000Z"
    }
  }
];

export default definePlugin({
  name: "aih.pricing.official.deepseek",
  apply(ctx) {
    ctx.aih.register("aih.pricing.official.deepseek.catalog", () => ({
      generatedAt: SOURCE.fetchedAt,
      source: SOURCE,
      quotes: QUOTES
    }));
  }
});
