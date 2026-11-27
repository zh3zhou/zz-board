import { expect, it } from 'vitest';
import { RasterCache } from '../../src/web/rasterCache.js';
it('keeps recent sampled images inside a byte cap and releases the job', () => {
  const cache = new RasterCache(12);
  cache.set('a', 'aa'); cache.set('b', 'bb'); cache.set('c', 'cc');
  expect(cache.get('a')).toBe('aa'); cache.set('d', 'dd');
  expect(cache.get('b')).toBeUndefined(); expect(cache.get('a')).toBe('aa');
  cache.set('large', '1234567'); expect(cache.get('large')).toBeUndefined();
  cache.clear(); expect(cache.get('a')).toBeUndefined();
});
