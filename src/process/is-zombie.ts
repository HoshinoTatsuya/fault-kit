import type { ProcessInfo } from './process-info.type';

/** Завершён, но не подобран родителем: в таблице есть, работы нет. */
export const isZombie = (info: ProcessInfo): boolean => info.state.startsWith('Z');
