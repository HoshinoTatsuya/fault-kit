import type { REDIS_PAUSE_MODE } from './redis-pause-mode.constant';

export type RedisPauseMode = (typeof REDIS_PAUSE_MODE)[keyof typeof REDIS_PAUSE_MODE];
