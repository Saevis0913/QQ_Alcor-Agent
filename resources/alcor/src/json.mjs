// Walk iteratively: hostile nesting must not consume the JavaScript call stack.
// Array iterators avoid allocating a second full-width array for large payloads.
export function withinJsonDepth(value, limit) {
  if (value === null || typeof value !== 'object') return true;
  const frame = (item, depth) => ({ item, depth, keys: Array.isArray(item) ? item.keys() : Object.keys(item)[Symbol.iterator]() });
  const stack = [frame(value, 1)];
  while (stack.length) {
    const current = stack[stack.length - 1];
    if (current.depth > limit) return false;
    const key = current.keys.next();
    if (key.done) { stack.pop(); continue; }
    const child = current.item[key.value];
    if (child !== null && typeof child === 'object') stack.push(frame(child, current.depth + 1));
  }
  return true;
}
