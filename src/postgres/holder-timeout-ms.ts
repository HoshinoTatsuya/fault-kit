import { TIMER_CEILING_MS } from '../timer-ceiling-ms.constant';
import { valueText } from '../value-text';

/**
 * Потолок открытия и освобождения держателя из настроек; по умолчанию
 * 10 000 мс. Больше потолка таймера Node — отказ: `setTimeout` поставил бы
 * 1 мс, и держатель отказал бы сразу, назвав потолок, которого не ждал.
 */
export const holderTimeoutMs = (timeoutMs = 10_000): number => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMER_CEILING_MS) {
    throw new RangeError(
      `timeoutMs — целое от 1 до ${TIMER_CEILING_MS} мс (потолок таймера Node), получено ${valueText(timeoutMs)}`,
    );
  }
  return timeoutMs;
};
