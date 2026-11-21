import type { DROP_MODE } from './drop-mode.constant';

export type DropMode = (typeof DROP_MODE)[keyof typeof DROP_MODE];
