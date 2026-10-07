import type {
  ControlPlaneProfile,
  ServerRoute,
  ServerRouteHealth,
  ServerRouteKind
} from '@/types';
import { mergeServerRoutes, scoreServerRoute } from './server-routes/server-route-service';
import { classifyDirectServerEndpoint } from './server-routes/server-route-normalizer';

const ROUTE_HEALTH_VIEW: Record<ServerRouteHealth, { color: string; label: string }> = {
  healthy: { color: 'green', label: '正常' },
  degraded: { color: 'orange', label: '不稳定' },
  offline: { color: 'red', label: '离线' },
  unknown: { color: 'default', label: '未检测' }
};

export interface ServerRouteView {
  id: string;
  endpoint: string;
  endpointLabel: string;
  primary: boolean;
  roleLabel: 'Server 地址' | '可用路径';
  kindLabel: string;
  healthLabel: string;
  healthColor: string;
  rttLabel: string;
}

export interface ServerRouteRow {
  stableServerId: string;
  profile: ControlPlaneProfile;
  authorizationPending: boolean;
  authorizationLabel: '已授权' | '已发现，待授权';
  routes: ServerRouteView[];
}

function routeKindLabel(
  kind: ServerRouteKind,
  endpoint: string,
  viaServerId: string,
  serverNames: Map<string, string>
) {
  if (kind === 'direct-lan') return '局域网直连';
  if (kind === 'direct') {
    const scope = classifyDirectServerEndpoint(endpoint);
    if (scope === 'loopback') return '本机直连';
    if (scope === 'lan') return '局域网直连';
    return '直接连接';
  }
  const serverName = serverNames.get(viaServerId) || '';
  return serverName ? `经 ${serverName} 中转` : '经 Server 中转';
}

function routeRttLabel(rttMs: number) {
  return rttMs > 0 ? `${Math.round(rttMs)} ms` : '未测速';
}

function routeEndpointLabel(route: ServerRoute) {
  if (route.kind !== 'relay-via-server') return route.endpoint;
  try {
    return new URL(route.endpoint).origin;
  } catch (_error) {
    return '经已配置 Server';
  }
}

function preferredProfile(left: ControlPlaneProfile, right: ControlPlaneProfile) {
  return right.updatedAt > left.updatedAt ? right : left;
}

function toRouteViews(
  routes: ServerRoute[],
  primaryRouteId: string,
  serverNames: Map<string, string>
): ServerRouteView[] {
  return [...routes]
    .sort((left, right) => {
      const primaryDelta = Number(right.id === primaryRouteId) - Number(left.id === primaryRouteId);
      return primaryDelta || scoreServerRoute(right) - scoreServerRoute(left) || left.id.localeCompare(right.id);
    })
    .map((route) => {
      const primary = route.id === primaryRouteId;
      const health = ROUTE_HEALTH_VIEW[route.health];
      return {
        id: route.id,
        endpoint: route.endpoint,
        endpointLabel: routeEndpointLabel(route),
        primary,
        roleLabel: primary ? 'Server 地址' : '可用路径',
        kindLabel: routeKindLabel(route.kind, route.endpoint, route.viaServerId, serverNames),
        healthLabel: health.label,
        healthColor: health.color,
        rttLabel: routeRttLabel(route.rttMs)
      };
    });
}

export function buildServerRouteRows(profiles: ControlPlaneProfile[]): ServerRouteRow[] {
  const serverNames = new Map(
    profiles.map((profile) => [profile.stableServerId, profile.name || profile.stableServerId])
  );
  const grouped = new Map<string, { profile: ControlPlaneProfile; routes: ServerRoute[] }>();
  profiles.forEach((profile) => {
    const stableServerId = String(profile.stableServerId || profile.id).trim();
    if (!stableServerId) return;
    const existing = grouped.get(stableServerId);
    grouped.set(stableServerId, {
      profile: existing ? preferredProfile(existing.profile, profile) : profile,
      routes: mergeServerRoutes(existing?.routes, profile.routes)
    });
  });

  return Array.from(grouped.entries())
    .map(([stableServerId, value]) => {
      const activeRoute = value.routes.find((route) => route.id === value.profile.activeRouteId)
        || value.routes.find((route) => route.endpoint === value.profile.endpoint)
        || value.routes[0]
        || null;
      const profile = {
        ...value.profile,
        routes: value.routes,
        activeRouteId: activeRoute?.id || '',
        endpoint: activeRoute?.endpoint || value.profile.endpoint
      };
      const authorizationPending = profile.authorizationState === 'discovered-pending-auth'
        || !profile.managementKeyConfigured;
      const authorizationLabel: ServerRouteRow['authorizationLabel'] = authorizationPending
        ? '已发现，待授权'
        : '已授权';
      return {
        stableServerId,
        profile,
        authorizationPending,
        authorizationLabel,
        routes: toRouteViews(value.routes, profile.activeRouteId, serverNames)
      };
    })
    .sort((left, right) => (
      left.profile.name.localeCompare(right.profile.name)
        || left.stableServerId.localeCompare(right.stableServerId)
    ));
}
