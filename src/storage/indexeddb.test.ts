import { del, get, set } from 'idb-keyval';
import { expect, it } from 'vitest';

it('テスト環境のIndexedDBで保存と再読み込みができる', async () => {
  const key = 'foundation-smoke-test';
  try {
    await set(key, { revision: 1 });
    expect(await get(key)).toEqual({ revision: 1 });
  } finally {
    await del(key);
  }
});
