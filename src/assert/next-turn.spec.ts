import { nextTurn } from './next-turn';

/**
 * На `nextTurn` построены окна из оборотов и вспомогательные функции спек.
 * Если он перестанет уступать циклу (`() => undefined`, микрозадача), спеки
 * оборотов останутся зелёными, ничего не проверяя: эта спека — их опора.
 */
describe('nextTurn', () => {
  it('пропускает макрозадачу, поставленную до вызова, — это оборот цикла, а не микрозадача', async () => {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await nextTurn();
    expect(ran).toBe(true);
  });

  it('микрозадачи, поставленные после вызова, выполняются раньше его разрешения', async () => {
    const order: string[] = [];
    const turn = nextTurn().then(() => order.push('оборот'));
    void Promise.resolve().then(() => order.push('микрозадача'));
    await turn;
    expect(order).toEqual(['микрозадача', 'оборот']);
  });
});
