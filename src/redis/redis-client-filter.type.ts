import type { AtLeastOne } from '../at-least-one.type';
import type { RedisClientConditions } from './redis-client-conditions.type';

/**
 * Какие клиенты оборвать (см. `RedisClientConditions`). Хотя бы одно условие
 * обязательно — и типом, и отказом в рантайме: пустой фильтр не означает «все».
 */
export type RedisClientFilter = AtLeastOne<RedisClientConditions>;
