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
}
/** handler 可直接返回 JSON 值，或返回 { value, payload } 以附带二进制数据。 */
export type ContributionHandler = (value: unknown, context: InvocationContext) => unknown | Promise<unknown>;
export interface PluginHostService {
  /** 为清单中声明的贡献项注册 handler；随插件卸载自动注销。 */
  register(contributionId: string, handler: ContributionHandler): () => Promise<void>;
  /** 提供清单 provides 中声明过的服务；依赖它的插件按 Cordis inject 等待。 */
  provide(name: string, value: unknown): () => void;
  instance(): Readonly<{ instanceId: string; pluginId: string; generation: number }>;
}
declare module '@deepseek-ai/cordis' { interface Context { aih: PluginHostService; } }
export function definePlugin<T extends { apply(ctx: Context, config: any): unknown }>(plugin: T): Readonly<T>;
export function validateManifest(input: unknown, options?: { hostVersion?: string; nodeVersion?: string; target?: string }): Readonly<Manifest>;
export function validateConfiguration(manifest: Manifest, configuration?: object, secrets?: object): Readonly<{ configuration: object; secrets: object }>;
export class PluginError extends Error { readonly code: string; constructor(code: string, message?: string); }
export const contract: { manifestVersion: 1; protocolVersion: 1; sdkVersion: string; limits: Record<string, number> };
