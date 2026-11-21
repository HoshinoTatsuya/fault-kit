import { inspect } from 'node:util';

import type { SettleState } from './settle-state.type';

/** Исход завершившейся работы словами — для текста отказа утверждения. Значение — до глубины 4, одной строкой. */
export const describeSettle = (state: Exclude<SettleState<unknown>, { readonly kind: 'pending' }>): string =>
  state.kind === 'resolved'
    ? `разрешилась значением ${inspect(state.value, { depth: 4, breakLength: Number.POSITIVE_INFINITY, compact: true })}`
    : `отклонена: ${state.reason instanceof Error ? state.reason.message : inspect(state.reason)}`;
