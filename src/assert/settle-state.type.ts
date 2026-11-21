/** Что известно о работе к моменту проверки. */
export type SettleState<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'rejected'; readonly reason: unknown };
