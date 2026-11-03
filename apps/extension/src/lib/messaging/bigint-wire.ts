// Extension messaging is JSON, which has no bigint: sending one fails with
// "Could not serialize message". Wallet values that are bigint (SDK amounts)
// must stay exact, so they cross the popup <-> background
// channel tagged as decimal strings and are restored on the other side.
const TAG = '__bigint';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

export function encodeBigints(value: unknown): unknown {
  if (typeof value === 'bigint') return { [TAG]: value.toString() };
  if (Array.isArray(value)) return value.map(encodeBigints);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBigints(v)]));
  }
  return value;
}

export function decodeBigints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBigints);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === TAG && typeof value[TAG] === 'string') return BigInt(value[TAG]);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeBigints(v)]));
  }
  return value;
}
