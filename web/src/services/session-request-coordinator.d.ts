export function buildSessionRequestKey(url: string): string;

export class SessionRequestCoordinator {
  run<T>(url: string, loader: () => T | Promise<T>): Promise<T>;
}
