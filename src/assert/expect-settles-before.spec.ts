import { expectSettlesBefore } from './expect-settles-before';
import { FaultAssertionError } from './fault-assertion.error';
import { nextTurn } from './next-turn';

/** Работа, которая разрешается значением после `turns` оборотов цикла. */
const afterTurns = async <T>(turns: number, value: T): Promise<T> => {
  for (let index = 0; index < turns; index += 1) {
    await nextTurn();
  }
  return value;
};

const never = new Promise<never>(() => undefined);

describe('expectSettlesBefore', () => {
  it('работа раньше события-дедлайна — её значение', async () => {
    await expect(expectSettlesBefore(afterTurns(2, 'готово'), afterTurns(20, 'дедлайн'))).resolves.toBe(
      'готово',
    );
  });

  it('событие-дедлайн раньше работы — FaultAssertionError с меткой', async () => {
    const result = expectSettlesBefore(never, afterTurns(2, 'дедлайн'), 'захват слота');
    await expect(result).rejects.toBeInstanceOf(FaultAssertionError);
    await expect(expectSettlesBefore(never, Promise.resolve(), 'захват слота')).rejects.toThrow(
      'захват слота: не завершилась до дедлайна',
    );
    await expect(expectSettlesBefore(never, Promise.resolve())).rejects.toThrow(
      /^работа: не завершилась до дедлайна$/,
    );
  });

  it('обороты: работа за 3 оборота укладывается в 6 и не укладывается в 1', async () => {
    await expect(expectSettlesBefore(afterTurns(3, 'a'), { turns: 6 })).resolves.toBe('a');
    await expect(expectSettlesBefore(afterTurns(3, 'b'), { turns: 1 })).rejects.toBeInstanceOf(
      FaultAssertionError,
    );
  });

  it('обороты: граница точная — работа за N оборотов укладывается в N и не укладывается в N-1', async () => {
    await expect(expectSettlesBefore(afterTurns(4, 'ровно'), { turns: 4 })).resolves.toBe('ровно');
    await expect(expectSettlesBefore(afterTurns(4, 'поздно'), { turns: 3 })).rejects.toBeInstanceOf(
      FaultAssertionError,
    );
  });

  it('обороты: окно кончается, как только работа завершилась, а не через все обороты', async () => {
    let turnsAfterDone = 0;
    let done = false;
    const counter = (): void => {
      if (done) {
        turnsAfterDone += 1;
      }
      if (turnsAfterDone < 1000) {
        setImmediate(counter);
      }
    };
    setImmediate(counter);
    await expectSettlesBefore(
      afterTurns(1, 'x').then((value) => {
        done = true;
        return value;
      }),
      { turns: 500 },
    );
    const seen = turnsAfterDone;
    turnsAfterDone = 1000;
    expect(seen).toBeLessThan(5);
  });

  it('обороты: окно кончается и тогда, когда работа ОТКАЗАЛА', async () => {
    let turns = 0;
    let counting = true;
    const counter = (): void => {
      if (counting) {
        turns += 1;
        setImmediate(counter);
      }
    };
    setImmediate(counter);
    const failure = new Error('отказ');
    await expect(
      expectSettlesBefore(
        afterTurns(1, null).then(() => {
          throw failure;
        }),
        { turns: 500 },
      ),
    ).rejects.toBe(failure);
    counting = false;
    expect(turns).toBeLessThan(10);
  });

  it('работа отказала раньше дедлайна — её отказ как есть', async () => {
    const failure = new Error('отказ работы');
    await expect(expectSettlesBefore(Promise.reject(failure), never)).rejects.toBe(failure);
  });

  it('отказ обещания-дедлайна — тоже наступление дедлайна, причина в тексте', async () => {
    const result = expectSettlesBefore(never, Promise.reject(new Error('свидетель упал')));
    await expect(result).rejects.toBeInstanceOf(FaultAssertionError);
    await expect(expectSettlesBefore(never, Promise.reject(new Error('свидетель упал')))).rejects.toThrow(
      'не завершилась до дедлайна (свидетель-дедлайн отклонена: свидетель упал)',
    );
  });

  /**
   * Ноль оборотов — «без единой макрозадачи»: уже разрешённое обещание и
   * цепочка микрозадач укладываются. Прежде состояние читалось синхронно, до
   * опустошения очереди микрозадач, и окно { turns: 0 } не видело даже
   * `Promise.resolve()`.
   */
  it('обороты: { turns: 0 } — работа на одних микрозадачах укладывается, за один оборот — нет', async () => {
    await expect(expectSettlesBefore(Promise.resolve('сразу'), { turns: 0 })).resolves.toBe('сразу');
    let chain: Promise<string> = Promise.resolve('цепочка');
    for (let index = 0; index < 10; index += 1) {
      chain = chain.then((value) => value);
    }
    await expect(expectSettlesBefore(chain, { turns: 0 })).resolves.toBe('цепочка');
    await expect(expectSettlesBefore(afterTurns(1, 'поздно'), { turns: 0 })).rejects.toBeInstanceOf(
      FaultAssertionError,
    );
  });

  it('число оборотов — целое неотрицательное', async () => {
    await expect(expectSettlesBefore(never, { turns: -1 })).rejects.toThrow(
      'число оборотов — целое неотрицательное, получено -1',
    );
    await expect(expectSettlesBefore(never, { turns: 1.5 })).rejects.toThrow(RangeError);
  });

  it.each([1, 2, 3, 8])(
    'исход, пришедший цепочкой из %i микрозадач ПОСЛЕ события-дедлайна, — опоздал',
    async (hops) => {
      let fire: () => void = () => undefined;
      const deadline = new Promise<void>((resolve) => {
        fire = resolve;
      });
      let work: Promise<string> = deadline.then(() => 'после дедлайна');
      for (let index = 1; index < hops; index += 1) {
        work = work.then((value) => value);
      }
      const result = expectSettlesBefore(work, deadline);
      fire();
      await expect(result).rejects.toBeInstanceOf(FaultAssertionError);
    },
  );

  it('исход, случившийся до события в той же очереди микрозадач, — успел', async () => {
    let finish: (value: string) => void = () => undefined;
    let fire: () => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const deadline = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const result = expectSettlesBefore(work, deadline);
    finish('раньше');
    fire();
    await expect(result).resolves.toBe('раньше');
  });

  it('ленивый thenable исполняется ровно один раз', async () => {
    let executions = 0;
    const lazy: PromiseLike<string> = {
      // biome-ignore lint/suspicious/noThenProperty: проверяется именно ленивый thenable (построитель запроса)
      then(onFulfilled, onRejected) {
        executions += 1;
        return afterTurns(1, 'row').then(onFulfilled, onRejected);
      },
    };
    await expect(expectSettlesBefore(lazy, { turns: 10 })).resolves.toBe('row');
    expect(executions).toBe(1);
  });

  it('обещание другого realm (vm): исполняется один раз и засчитывается', async () => {
    const { runInNewContext } = require('node:vm') as typeof import('node:vm');
    let executions = 0;
    const foreign = runInNewContext(
      'new Promise((resolve) => resolve("из другого realm"))',
    ) as Promise<string>;
    const counted: PromiseLike<string> = {
      // biome-ignore lint/suspicious/noThenProperty: считается число вызовов then у обещания другого realm
      then: (onFulfilled, onRejected) => {
        executions += 1;
        return foreign.then(onFulfilled, onRejected);
      },
    };
    expect(foreign instanceof Promise).toBe(false);
    await expect(expectSettlesBefore(counted, { turns: 5 })).resolves.toBe('из другого realm');
    expect(executions).toBe(1);
  });
});
