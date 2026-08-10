/** Human-readable rendering of an unknown YAML value for messages and
 * normalization — bare String() on an object prints '[object Object]'. */
export function displayValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? 'undefined';
}
