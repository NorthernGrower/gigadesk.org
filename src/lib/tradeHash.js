// A trade's hash is its own short reference, so a day's trades can be named in
// a note or an alert. It is derived from the trade's id, so it never changes
// and never has to be stored on the trade itself.
export function tradeHash(trade) {
  const id = String((trade && (trade.id || trade)) || '');
  if (!id) return '';
  // FNV-1a, 32 bits: small, stable and plenty for a journal reference
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
