import { activeResources } from '../testing/active-resources';
import { startEchoServer } from '../testing/echo-server';
import { nextTurn } from './next-turn';
import { turnsDuring } from './turns-during';

/**
 * Работа партиями: каждая строка — немного счёта, чтобы партия весила
 * заметно больше учёта вокруг неё. Доли сравниваются с порогом 0,5: по замеру
 * (README) исправная форма даёт 0,1–0,2, дефектная — больше 0,9; доля —
 * отношение двух времён одного потока, от скорости машины не зависит.
 */
const ROWS = Array.from({ length: 200_000 }, (_, index) => index);
const BATCH = 20_000;
const BATCHES = ROWS.length / BATCH;
const weigh = (row: number): number => {
  let value = row;
  for (let step = 0; step < 20; step += 1) {
    value = (value * 31 + step) % 1_000_003;
  }
  return value;
};
const sumOf = (rows: readonly number[]): number => rows.reduce((sum, row) => sum + weigh(row), 0);
const EXPECTED = sumOf(ROWS);

/** Рецепт README: «самый длинный оборот — не больше половины работы» и «оборотов не меньше партий». */
const recipe = (report: { turns: number; longestTurnShare: number }): boolean =>
  report.longestTurnShare < 0.5 && report.turns >= BATCHES;

describe('turnsDuring', () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>>;

  beforeAll(async () => {
    echo = await startEchoServer();
  });

  afterAll(async () => {
    await echo.close();
  });

  it('синхронная работа любой длины — один оборот, доля 1', async () => {
    const report = await turnsDuring(async () => sumOf(ROWS));
    expect(report).toEqual({ value: EXPECTED, turns: 1, longestTurnShare: 1 });
  });

  it('await Promise.resolve() — не уступка: один оборот', async () => {
    const report = await turnsDuring(async () => {
      for (let index = 0; index < 1000; index += 1) {
        await Promise.resolve();
      }
    });
    expect(report.turns).toBe(1);
  });

  it('пять уступок setImmediate — шесть оборотов', async () => {
    const report = await turnsDuring(async () => {
      for (let index = 0; index < 5; index += 1) {
        await nextTurn();
      }
    });
    expect(report.turns).toBe(6);
  });

  /**
   * Участок в фазе check (после `setImmediate`) ставит свою границу оборота тоже
   * в check — СЛЕДУЮЩЕГО оборота цикла. Таймер работы, созревший к фазе timers
   * этого следующего оборота, выполнялся раньше границы и склеивался с участком
   * до него: два оборота считались одним, их время — одним самым длинным.
   */
  it('участок в фазе check, затем уступка таймером — разные обороты, доля делится', async () => {
    const burn = (): void => {
      // Дольше миллисекунды: таймер на 0 мс созревает к фазе timers следующего оборота.
      sumOf(ROWS.slice(0, 50_000));
    };
    const report = await turnsDuring(async () => {
      await nextTurn();
      // Таймер заведён до счёта: к следующему обороту он уже созрел.
      const tick = new Promise((resolve) => setTimeout(resolve, 0));
      burn();
      await tick;
      burn();
    });
    expect(report.turns).toBe(3);
    expect(report.longestTurnShare).toBeLessThan(0.8);
  });

  it('отказ работы — отказ вызова', async () => {
    await expect(
      turnsDuring(async () => {
        throw new Error('сломано');
      }),
    ).rejects.toThrow('сломано');
  });

  it('с вводом-выводом: исправная (партии с уступкой) — рецепт зелёный, дефектная (ждала сеть, потом всё синхронно) — красный', async () => {
    const good = await turnsDuring(async () => {
      await echo.roundTrip();
      let sum = 0;
      for (let start = 0; start < ROWS.length; start += BATCH) {
        sum += sumOf(ROWS.slice(start, start + BATCH));
        await nextTurn();
      }
      return sum;
    });
    const bad = await turnsDuring(async () => {
      await echo.roundTrip();
      return sumOf(ROWS);
    });
    expect([good.value, bad.value]).toEqual([EXPECTED, EXPECTED]);
    expect({ good: recipe(good), bad: recipe(bad) }).toEqual({ good: true, bad: false });
  });

  it('много ожиданий сети, затем всё синхронно — красный: число оборотов набрано ожиданием, доля его выдаёт', async () => {
    const bad = await turnsDuring(async () => {
      for (let index = 0; index < BATCHES; index += 1) {
        await echo.roundTrip();
      }
      return sumOf(ROWS);
    });
    expect(bad.turns).toBeGreaterThanOrEqual(BATCHES);
    expect(bad.longestTurnShare).toBeGreaterThan(0.5);
    expect(recipe(bad)).toBe(false);
  });

  it('всё синхронно, ПОТОМ ожидания сети — красный: самый длинный оборот не последний, доля его помнит', async () => {
    const bad = await turnsDuring(async () => {
      const sum = sumOf(ROWS);
      for (let index = 0; index < BATCHES; index += 1) {
        await echo.roundTrip();
      }
      return sum;
    });
    expect(bad.value).toBe(EXPECTED);
    expect(bad.turns).toBeGreaterThanOrEqual(BATCHES);
    expect(bad.longestTurnShare).toBeGreaterThan(0.5);
  });

  it('уступка ожиданием сети на каждой партии — тоже уступка: рецепт зелёный', async () => {
    const good = await turnsDuring(async () => {
      let sum = 0;
      for (let start = 0; start < ROWS.length; start += BATCH) {
        sum += sumOf(ROWS.slice(start, start + BATCH));
        await echo.roundTrip();
      }
      return sum;
    });
    expect(good.value).toBe(EXPECTED);
    expect(recipe(good)).toBe(true);
  });

  it('чужая синхронная работа рядом не приписывается работе', async () => {
    let foreignRan = false;
    // Чужой таймер, поставленный до вызова, срабатывает посреди работы и весит втрое больше её.
    const foreign = setTimeout(() => {
      sumOf(ROWS);
      sumOf(ROWS);
      sumOf(ROWS);
      foreignRan = true;
    }, 1);
    const good = await turnsDuring(async () => {
      let sum = 0;
      for (let start = 0; start < ROWS.length; start += BATCH) {
        sum += sumOf(ROWS.slice(start, start + BATCH));
        await echo.roundTrip();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return sum;
    });
    clearTimeout(foreign);
    expect(foreignRan).toBe(true);
    expect(recipe(good)).toBe(true);
  });

  it('пока работа ждёт, пакет ничего не крутит и не держит: ожидание любой длины не упирается в потолок', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let atGate: () => void = () => undefined;
    const reachedGate = new Promise<void>((resolve) => {
      atGate = resolve;
    });
    const running = turnsDuring(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      atGate();
      await gate;
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return 'дождалась';
    });
    // Работа дошла до ворот и ждёт: 20 оборотов цикла — и ни одной макрозадачи пакета в очереди.
    await reachedGate;
    for (let turn = 0; turn < 20; turn += 1) {
      await nextTurn();
    }
    const whileWaiting = process.getActiveResourcesInfo().filter((kind) => kind === 'Immediate');
    release();
    const report = await running;
    expect({ whileWaiting, value: report.value }).toEqual({ whileWaiting: [], value: 'дождалась' });
    // Начало, первый таймер, ворота и ещё 20 таймеров.
    expect(report.turns).toBe(23);
  });

  it('после возврата и после отказа ничего не висит', async () => {
    await nextTurn();
    const baseline = activeResources();
    await turnsDuring(async () => {
      await nextTurn();
      await nextTurn();
    });
    await expect(
      turnsDuring(async () => {
        await nextTurn();
        throw new Error('сломано');
      }),
    ).rejects.toThrow('сломано');
    await nextTurn();
    expect(activeResources()).toEqual(baseline);
  });
});
