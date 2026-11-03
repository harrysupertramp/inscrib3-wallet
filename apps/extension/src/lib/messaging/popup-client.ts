import { encodeBigints, decodeBigints } from './bigint-wire.js';

let _id = 0;

export async function sendToBackground<T>(method: string, params?: unknown): Promise<T> {
  const id = `popup-${++_id}`;
  const response = await browser.runtime.sendMessage({ id, method, params: encodeBigints(params) });
  if (response?.error) throw new Error(response.error);
  return decodeBigints(response?.result) as T;
}
