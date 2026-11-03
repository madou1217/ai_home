const SESSION_REQUEST_SCOPE = 'session-message-stream';

export function buildSessionRequestKey(url) {
  try {
    const parsed = new globalThis.URL(url, 'http://local.ai-home');
    const pathname = parsed.pathname || '';
    if (!/^\/v0\/webui\/sessions\/[^/]+\/[^/]+\/(messages|events)$/.test(pathname)) {
      return '';
    }
    parsed.searchParams.sort();
    const query = parsed.searchParams.toString();
    return `${SESSION_REQUEST_SCOPE}:${pathname}${query ? `?${query}` : ''}`;
  } catch {
    return '';
  }
}

export class SessionRequestCoordinator {
  constructor() {
    this.inflight = new Map();
  }

  run(url, loader) {
    const key = buildSessionRequestKey(url);
    if (!key) return Promise.resolve().then(loader);
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const request = Promise.resolve().then(loader);
    this.inflight.set(key, request);
    request.then(
      () => this.finish(key, request),
      () => this.finish(key, request),
    );
    return request;
  }

  finish(key, request) {
    if (this.inflight.get(key) === request) this.inflight.delete(key);
  }
}
