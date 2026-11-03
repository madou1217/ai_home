type RemoteNodePreviewDefaults = {
  nodeId?: string;
  name?: string;
  provider?: string;
} | null | undefined;

type RemoteTransportPreviewDefaults = {
  provider?: string;
} | null | undefined;

export type RemoteNodeDefaultPreviewItem = {
  id: 'nodeId' | 'name' | 'provider';
  label: string;
  value: string;
};

export function formatRemoteNodeIdentity(defaults?: RemoteNodePreviewDefaults): string;

export function buildRemoteNodeDefaultPreview(
  defaults?: RemoteNodePreviewDefaults,
  transportDefaults?: RemoteTransportPreviewDefaults
): RemoteNodeDefaultPreviewItem[];
