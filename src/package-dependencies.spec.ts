import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Объявленные зависимости совпадают с тем, что грузит ПОСТАВЛЯЕМЫЙ код
 * (src без спек и без src/testing): каждый внешний импорт объявлен в
 * dependencies или peerDependencies, и каждая объявленная зависимость
 * действительно импортируется. Лишняя peer-зависимость — ложное требование
 * к потребителю (менеджер пакетов предупреждает о ней и тянет её версии в
 * разрешение), неучтённая — падение у потребителя без неё.
 */
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const shippedFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' || entry.name === 'architecture' ? [] : shippedFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });

/** Имя пакета внешнего импорта (`@scope/name/sub` → `@scope/name`); относительные и `node:` — не внешние. */
const packageOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) {
    return undefined;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

describe('зависимости пакета', () => {
  const files = shippedFiles(join(ROOT, 'src'));
  const imported = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+'([^']+)'/g)) {
      const name = match[1] === undefined ? undefined : packageOf(match[1]);
      if (name !== undefined) {
        imported.set(name, [...(imported.get(name) ?? []), relative(ROOT, file)]);
      }
    }
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  it('выборка не выродилась: файлов поставки больше 60, внешний импорт найден', () => {
    expect(files.length).toBeGreaterThan(60);
    expect([...imported.keys()]).toContain('pg');
  });

  it('каждый внешний импорт объявлен', () => {
    expect([...imported.keys()].filter((name) => !declared.has(name))).toEqual([]);
  });

  it('каждая объявленная зависимость импортируется (типы — тоже: @types/<имя> при импорте <имя>)', () => {
    const used = (name: string): boolean =>
      imported.has(name) || (name.startsWith('@types/') && imported.has(name.slice('@types/'.length)));
    expect([...declared].filter((name) => !used(name))).toEqual([]);
  });
});
