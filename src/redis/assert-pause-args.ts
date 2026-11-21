import { valueText } from '../value-text';
import { REDIS_PAUSE_MODE } from './redis-pause-mode.constant';

/** Длительность паузы — целое положительное число мс, режим — из `REDIS_PAUSE_MODE`; иначе отказ без команды. */
export const assertPauseArgs = (ms: number, mode: unknown): void => {
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new RangeError(`длительность паузы — целое положительное число мс, получено ${valueText(ms)}`);
  }
  if (mode !== REDIS_PAUSE_MODE.all && mode !== REDIS_PAUSE_MODE.write) {
    throw new RangeError(`неизвестный режим паузы: ${valueText(mode)}`);
  }
};
