import { defineConfig } from "@umijs/max";
import routes from "./routes";

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  request: {},
  proxy: {
    "/v0": {
      target: "http://127.0.0.1:9527",
      changeOrigin: true,
      ws: true
    }
  },
  esbuildMinifyIIFE: true,
  layout: {
    title: "AIH Local Orchestrator",
    locale: true,
  },
  routes,
  npmClient: "npm",
  history: {
    type: "browser",
  },
  publicPath: "/ui/",
  base: "/ui",
  outputPath: "dist",
  hash: true,
  targets: {
    chrome: 80,
    firefox: 80,
    safari: 13,
    edge: 80,
  }
});
