import { describe, expect, test } from 'bun:test';
import type { DelegateInfo, DelegateProvider } from '@arkade-os/sdk';
import { withDelegateInfoCache } from './delegate-provider.js';
import { inMemoryStore } from './test-helpers.js';

const URL_A = 'https://delegate.arkade.money';
const URL_B = 'https://delegate.example.test';

function info(pubkey: string): DelegateInfo {
  return { pubkey, fee: '0', delegateAddress: 'ark1qtest' };
}

// Only getDelegateInfo/delegate are exercised; `fail` flips the stub from
// answering to behaving like an unreachable service.
function stub(initial: DelegateInfo, opts: { fail?: boolean } = {}) {
  const calls = { getDelegateInfo: 0, delegate: 0 };
  const state = { current: initial, fail: opts.fail ?? false };
  const provider: DelegateProvider = {
    async getDelegateInfo() {
      calls.getDelegateInfo++;
      if (state.fail) throw new Error('ECONNREFUSED');
      return state.current;
    },
    async delegate() {
      calls.delegate++;
    },
  };
  return { provider, calls, state };
}

describe('withDelegateInfoCache', () => {
  test('returns live info and remembers it', async () => {
    const store = inMemoryStore();
    const { provider } = stub(info('aa'));
    const cached = withDelegateInfoCache(provider, URL_A, store);

    expect((await cached.getDelegateInfo()).pubkey).toBe('aa');
    // Second provider is permanently down, but the store now has the answer.
    const down = withDelegateInfoCache(stub(info('aa'), { fail: true }).provider, URL_A, store);
    expect((await down.getDelegateInfo()).pubkey).toBe('aa');
  });

  // The whole point: without this the SDK falls back to the 2-leaf script and
  // the 3-leaf address's balance vanishes until the service is back.
  test('falls back to the cached pubkey when the service is unreachable', async () => {
    const store = inMemoryStore();
    const s = stub(info('bb'));
    const cached = withDelegateInfoCache(s.provider, URL_A, store);
    await cached.getDelegateInfo();

    s.state.fail = true;
    expect((await cached.getDelegateInfo()).pubkey).toBe('bb');
  });

  test('rethrows when the service is down and nothing is cached', async () => {
    const cached = withDelegateInfoCache(stub(info('cc'), { fail: true }).provider, URL_A, inMemoryStore());
    await expect(cached.getDelegateInfo()).rejects.toThrow('ECONNREFUSED');
  });

  // A cache entry from a different delegator must never be used to derive an
  // address against this one.
  test('ignores a cache entry written for a different URL', async () => {
    const store = inMemoryStore();
    await withDelegateInfoCache(stub(info('dd')).provider, URL_A, store).getDelegateInfo();

    const other = withDelegateInfoCache(stub(info('dd'), { fail: true }).provider, URL_B, store);
    await expect(other.getDelegateInfo()).rejects.toThrow('ECONNREFUSED');
  });

  test('a live answer overwrites a stale cached pubkey', async () => {
    const store = inMemoryStore();
    const s = stub(info('old'));
    const cached = withDelegateInfoCache(s.provider, URL_A, store);
    await cached.getDelegateInfo();

    s.state.current = info('rotated');
    expect((await cached.getDelegateInfo()).pubkey).toBe('rotated');

    s.state.fail = true;
    expect((await cached.getDelegateInfo()).pubkey).toBe('rotated');
  });

  test('delegate() passes straight through and is never cached', async () => {
    const s = stub(info('ee'));
    const cached = withDelegateInfoCache(s.provider, URL_A, inMemoryStore());
    await cached.delegate({} as never, []);
    await cached.delegate({} as never, []);
    expect(s.calls.delegate).toBe(2);
  });
});
