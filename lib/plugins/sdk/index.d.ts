import type { Context } from '@deepseek-ai/cordis';
export * from './wire.generated';

export interface Contribution { id: string; capability: string; version: number; order?: number; failurePolicy?: 'deny' | 'delegate'; }
export interface Manifest {
  manifestVersion: 1; protocolVersion: 1; pluginId: string; version: string;
  engines: { aih: string; node?: string }; runtime: 'node'; entry: string; targets?: string[];
  contributes: Contribution[]; requires?: { name: string; versionRange: string }[];
  provides?: { name: string; version: string }[];
  configSchema?: object; secretsSchema?: object; stateSchemaVersion?: number;
}
export interface InvocationContext {
  invocationId: string; instanceId: string; generation: number; deadline: number; signal: AbortSignal;
  payload: Uint8Array;
  /** 仅 gateway.attempt：让网关执行本次尝试（或内层中间件），在提交点返回摘要；至多调用一次。 */
  next?: (value?: unknown) => Promise<AttemptSummary>;
}
/**
 * observe 贡献项收到的尝试摘要（每次上游尝试一条，best-effort、可能丢弃）。
 * Node 与 Go 数据面的键集合相同；取值差异：Go 记录失败时不知道之后是否换号，
 * 失败一律是 outcome "error"（error 为运行态失败分类），不会出现 Node 的 "retry_next" 等动作值。
 * 不要靠 "retry_next" 判断失败，否则会漏掉 Go 承接的流量。
 */
export interface AttemptObservation {
  type: 'gateway.attempt'; generation: number; provider: string; model: string; attempt: number;
  accountRef: string; outcome: string; error: string; durationMs: number; committed: boolean;
}
export interface AttemptSummary {
  committed: boolean; outcome: string; status?: number; error?: string;
  stopped?: boolean; rejected?: { status: number; message: string };
}
/** handler 返回 JSON 值；要附带二进制数据时返回 withPayload(value, bytes)。 */
export type ContributionHandler = (value: unknown, context: InvocationContext) => unknown | Promise<unknown>;
export interface PluginHostService {
  /** 为清单中声明的贡献项注册 handler；随插件卸载自动注销。 */
  register(contributionId: string, handler: ContributionHandler): () => Promise<void>;
  /** 提供清单 provides 中声明过的服务；依赖它的插件按 Cordis inject 等待。 */
  provide(name: string, value: unknown): () => void;
  instance(): Readonly<{ instanceId: string; pluginId: string; generation: number }>;
}
declare module '@deepseek-ai/cordis' { interface Context { aih: PluginHostService; } }
export function withPayload<T>(value: T, payload: Uint8Array): Readonly<{ value: T; payload: Uint8Array }>;
export function definePlugin<T extends { apply(ctx: Context, config: any): unknown }>(plugin: T): Readonly<T>;
export function validateManifest(input: unknown, options?: { hostVersion?: string; nodeVersion?: string; target?: string }): Readonly<Manifest>;
export function validateConfiguration(manifest: Manifest, configuration?: object, secrets?: object): Readonly<{ configuration: object; secrets: object }>;
export class PluginError extends Error { readonly code: string; constructor(code: string, message?: string); }
export const contract: { manifestVersion: 1; protocolVersion: number; sdkVersion: string; limits: Record<string, number> };
