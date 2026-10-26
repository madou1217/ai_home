export interface ServerCredentialsQr {
  endpoint: string;
  managementKey: string;
}
export function buildManagementKeyQrPayload(input: ServerCredentialsQr): string;
export function parseManagementKeyQrPayload(value: string): ServerCredentialsQr;
export function normalizeEndpoint(value: string): string;
export function normalizeManagementKey(value: string): string;
