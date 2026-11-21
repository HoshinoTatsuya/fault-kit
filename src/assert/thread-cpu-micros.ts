import { realProcess } from '../real-process';

/** Процессорное время ЭТОГО потока, мкс: время, когда поток снят с ядра, сюда не входит. */
export const threadCpuMicros = (): number => {
  const usage = realProcess.threadCpuUsage();
  return usage.user + usage.system;
};
