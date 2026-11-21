import type { LOCK_MODE } from './lock-mode.constant';

export type LockMode = (typeof LOCK_MODE)[keyof typeof LOCK_MODE];
