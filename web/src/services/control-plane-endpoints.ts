import type { ControlPlaneEndpointHint } from '@/types';

export function getBrowserControlEndpoint(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export function isLoopbackEndpoint(value?: string): boolean {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '::1' || /^127(?:\.|$)/.test(hostname);
  } catch (_error) {
    return false;
  }
}

export function formatEndpointHintLabel(hint: ControlPlaneEndpointHint): string {
  try {
    return `${hint.label}: ${new URL(hint.endpoint).host}`;
  } catch (_error) {
    return `${hint.label}: ${hint.endpoint}`;
  }
}

export function resolveDefaultControlEndpoint(
  hints: ControlPlaneEndpointHint[] = [],
  fallback = getBrowserControlEndpoint()
): string {
  const nonLoopbackHints = hints.filter((hint) => hint.endpoint && !isLoopbackEndpoint(hint.endpoint));
  const recommended = nonLoopbackHints.find((hint) => hint.recommended);
  return recommended?.endpoint || nonLoopbackHints[0]?.endpoint || fallback;
}

export function normalizeEndpointHintWarnings(
  hints: ControlPlaneEndpointHint[] = [],
  warnings: string[] = []
): string[] {
  return Array.from(new Set([
    ...warnings,
    ...hints.map((hint) => hint.warning || '')
  ].map((item) => String(item || '').trim()).filter(Boolean)));
}
