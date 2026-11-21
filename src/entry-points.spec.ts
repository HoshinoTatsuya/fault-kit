/**
 * Входы пакета и необязательные peer-зависимости. `pg` и `ioredis` —
 * необязательные: проекту, которому нужен только прокси или утверждения,
 * ставить их не нужно. Поэтому ни корень, ни /tcp, /dns, /process, /redis
 * не грузят ни одного из них, а /postgres грузит `pg` (контроль подмены:
 * без него зелёные проверки ниже могли бы значить «подмена не сработала»).
 */
describe('входы пакета', () => {
  const forbid = (): void => {
    jest.doMock('pg', () => {
      throw new Error('pg загружен');
    });
    jest.doMock('ioredis', () => {
      throw new Error('ioredis загружен');
    });
  };

  it.each(['./index', './tcp/index', './dns/index', './process/index', './redis/index'])(
    '%s грузится без pg и ioredis',
    (entry) => {
      jest.isolateModules(() => {
        forbid();
        const api = require(entry) as Record<string, unknown>;
        expect(Object.keys(api).length).toBeGreaterThan(0);
      });
    },
  );

  it('вход /postgres грузит pg', () => {
    jest.isolateModules(() => {
      forbid();
      expect(() => require('./postgres/index')).toThrow('pg загружен');
    });
  });
});
