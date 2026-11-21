/**
 * Программа, которая не завершается по SIGTERM: печатает `ready <pid>`, когда
 * обработчик уже стоит (сигнал раньше этого убил бы её по умолчанию), и
 * `term <pid>` на каждый SIGTERM. Живёт до SIGKILL.
 */
export const SIGTERM_IGNORER_SCRIPT = [
  "process.on('SIGTERM', () => process.stdout.write('term ' + process.pid + '\\n'));",
  'setInterval(() => undefined, 1 << 30);',
  "process.stdout.write('ready ' + process.pid + '\\n');",
].join(' ');
