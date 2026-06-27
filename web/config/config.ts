import { defineConfig } from "@umijs/max";
import routes from "./routes";

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  request: {},
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
  publicPath: "/",
  outputPath: "dist",
  hash: true,
  targets: {
    chrome: 80,
    firefox: 80,
    safari: 13,
    edge: 80,
  }
});
