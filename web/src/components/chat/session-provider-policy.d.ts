import type { Session } from '@/types';

export declare function areNativeSessionProvidersCompatible(left?: string, right?: string): boolean;
export declare function isSharedNativeSession(session: Session | null | undefined): boolean;
export declare function isSessionAccountProviderCompatible(session: Session, provider: string): boolean;
