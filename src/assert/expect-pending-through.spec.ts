import { connect, createServer, type Server, type Socket } from 'node:net';

import { expectPendingThrough } from './expect-pending-through';
import { FaultAssertionError } from './fault-assertion.error';
import { nextTurn } from './next-turn';

const afterTurns = async <T>(turns: number, value: T): Promise<T> => {
  for (let index = 0; index < turns; index += 1) {
    await nextTurn();
  }
  return value;
};

/** Свидетель с настоящим вводом-выводом: одно эхо через TCP по loopback. */
const ioWitness = async (): Promise<{ once(): Promise<void>; close(): Promise<void> }> => {
  const served: Socket[] = [];
  const server: Server = createServer((socket) => {
    served.push(socket);
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('нет порта');
  }
  const socket = connect(address.port, '127.0.0.1');
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return {
    once: () =>
      new Promise<void>((resolve) => {
        socket.once('data', () => resolve());
        socket.write('.');
      }),
    // Закрытие — до события close обеих сторон: колбэки закрытия не попадают в окно следующей проверки
    // (наблюдение за вводом-выводом общее на процесс).
    close: async () => {
      const closed = [socket, ...served].map(
        (each) =>
          new Promise<void>((resolve) => (each.closed ? resolve() : each.once('close', () => resolve()))),
      );
      socket.destroy();
      for (const each of served) {
        each.destroy();
      }
      await Promise.all(closed);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe('expectPendingThrough', () => {
  it('работа не завершилась до события — проходит', async () => {
    const witness = await ioWitness();
    try {
      await expect(
        expectPendingThrough(
          afterTurns(50, 'поздно'),
          (async () => {
            await witness.once();
            await witness.once();
          })(),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await witness.close();
    }
    await expect(expectPendingThrough(new Promise(() => undefined), { turns: 20 })).resolves.toBeUndefined();
  });

  it('разрешилась внутри окна — отказ со значением', async () => {
    await expect(expectPendingThrough(afterTurns(1, 'ответ'), { turns: 10 }, 'GET')).rejects.toThrow(
      "GET: разрешилась значением 'ответ' внутри окна",
    );
  });

  it('метка по умолчанию — «работа»; вложенное значение показано до глубины 4', async () => {
    await expect(
      expectPendingThrough(Promise.resolve({ a: { b: { c: { d: 1 } } } }), { turns: 1 }),
    ).rejects.toThrow('работа: разрешилась значением { a: { b: { c: { d: 1 } } } } внутри окна');
  });

  it('ОТКАЗАЛА внутри окна — тоже отказ: заморозка не отвечает и ошибкой', async () => {
    const failing = afterTurns(1, null).then(() => {
      throw new Error('ECONNRESET');
    });
    const result = expectPendingThrough(failing, { turns: 10 });
    await expect(result).rejects.toBeInstanceOf(FaultAssertionError);
    await expect(expectPendingThrough(Promise.reject(new Error('ECONNRESET')), { turns: 1 })).rejects.toThrow(
      'отклонена: ECONNRESET',
    );
    await expect(expectPendingThrough(Promise.reject('строка'), { turns: 1 })).rejects.toThrow(
      "отклонена: 'строка'",
    );
  });

  it('отказ работы ПОСЛЕ окна не становится необработанным', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      let fail: (error: Error) => void = () => undefined;
      const work = new Promise<never>((_, reject) => {
        fail = reject;
      });
      await expectPendingThrough(work, { turns: 2 });
      fail(new Error('позже'));
      await afterTurns(5, null);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  describe('окно обязано быть: иначе «не произошло» ничего не значит', () => {
    it('свидетель ОТКАЗАЛ (прямой клиент не подключён) — отказ утверждения, а не зелёное', async () => {
      const work = nextTurn().then(() => 'ответ пришёл');
      const witness = (async () => {
        throw new Error('ECONNREFUSED прямого клиента');
      })();
      await expect(expectPendingThrough(work, witness, 'GET')).rejects.toThrow(
        'GET: свидетель окна отказал (отклонена: ECONNREFUSED прямого клиента) — окно не доказано',
      );
    });

    it('свидетель отказал ПОСЛЕ настоящего ожидания — тоже не доказано', async () => {
      const witness = afterTurns(3, null).then(() => {
        throw new Error('прямой клиент упал');
      });
      await expect(expectPendingThrough(new Promise(() => undefined), witness)).rejects.toThrow(
        'окно не доказано',
      );
    });

    it.each([
      ['уже разрешённое обещание', () => Promise.resolve()],
      ['цикл из нуля обращений', () => (async () => undefined)()],
      ['цепочка микрозадач без ввода-вывода', () => afterMicrotasks(50)],
    ])('свидетель разрешился сразу (%s) — окно нулевой длины, отказ', async (_name, witness) => {
      const work = nextTurn().then(() => 'ответ пришёл');
      await expect(expectPendingThrough(work, witness())).rejects.toThrow('окно нулевой длины');
    });

    it('вызов из синхронной части макрозадачи с уже разрешённым свидетелем — тоже окно нулевой длины', async () => {
      const { verdict } = await new Promise<{ verdict: Promise<void> }>((resolve) =>
        setImmediate(() =>
          resolve({ verdict: expectPendingThrough(new Promise(() => undefined), Promise.resolve()) }),
        ),
      );
      await expect(verdict).rejects.toThrow('окно нулевой длины');
    });

    it('свидетель с одним настоящим обменом по сети — окно есть, проходит', async () => {
      const witness = await ioWitness();
      try {
        await expect(
          expectPendingThrough(new Promise(() => undefined), witness.once()),
        ).resolves.toBeUndefined();
      } finally {
        await witness.close();
      }
    });

    it.each([
      ['один nextTurn()', () => nextTurn()],
      ['цепочка из 2 оборотов', () => afterTurns(2, 'окно')],
    ])(
      'свидетель короче двух оборотов цикла (%s) — отказ: за него не успевает ни один обмен по сети',
      async (_name, witness) => {
        await expect(expectPendingThrough(new Promise(() => undefined), witness())).rejects.toThrow(
          'закрыт оборотом цикла раньше двух оборотов',
        );
      },
    );

    it('граница: свидетель из 3 оборотов — окно (двух оборотов хватает на обмен с сервером в том же процессе)', async () => {
      await expect(
        expectPendingThrough(new Promise(() => undefined), afterTurns(3, 'окно')),
      ).resolves.toBeUndefined();
    });

    it('исправно отвечающий сервер за окно в один оборот «не ответил» — прежде зелёное, теперь отказ', async () => {
      const server = await ioWitness();
      const direct = await ioWitness();
      try {
        await expect(expectPendingThrough(server.once(), nextTurn())).rejects.toThrow(
          'закрыт оборотом цикла раньше двух оборотов',
        );
        // Та же работа против окна с настоящим обменом — ответ успел: «разрешилась внутри окна».
        const twenty = (async () => {
          for (let index = 0; index < 20; index += 1) {
            await direct.once();
          }
        })();
        await expect(expectPendingThrough(server.once(), twenty)).rejects.toThrow('внутри окна');
      } finally {
        await direct.close();
        await server.close();
      }
    });

    it('{ turns: 0 } — отказ: окно из нуля оборотов зелено всегда', async () => {
      await expect(expectPendingThrough(Promise.resolve('уже'), { turns: 0 })).rejects.toThrow(RangeError);
    });
  });

  it('ленивый thenable исполняется ровно один раз', async () => {
    let executions = 0;
    const lazy: PromiseLike<never> = {
      // biome-ignore lint/suspicious/noThenProperty: проверяется именно ленивый thenable (построитель запроса)
      then(onFulfilled, onRejected) {
        executions += 1;
        return new Promise<never>(() => undefined).then(onFulfilled, onRejected);
      },
    };
    await expectPendingThrough(lazy, { turns: 3 });
    expect(executions).toBe(1);
  });
});

/** Цепочка из `count` микрозадач — разрешается, не отдав циклу событий ни одной макрозадачи. */
const afterMicrotasks = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};
