export interface NetworkLayerStatus {
  platform: string;
  systemProxy: {
    enabled: boolean;
    probeStatus?: string;
    source?: string;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string | string[];
    bypassList?: string[];
  };
  tun: {
    state: 'active' | 'inactive' | 'unknown';
    owner?: string | null;
    interfaceDetected?: boolean;
    routeDetected?: boolean;
    evidence?: string[];
  };
  effectiveRoute: 'tun' | 'system-proxy' | 'unknown' | 'direct-unknown';
  effectiveRouteKnown: boolean;
}
