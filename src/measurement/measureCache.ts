/**
 * WeakMap-based cache for immutable shape measurement results.
 *
 * Shapes in brepjs are immutable after creation — boolean ops produce new shapes.
 * This cache avoids redundant WASM calls for repeated measurements on the same shape.
 * WeakMap keys auto-expire when shapes are GC'd.
 */

let cache = new WeakMap<object, Map<string, unknown>>();

export function getCachedMeasurement(shape: object, key: string): unknown {
  return cache.get(shape)?.get(key);
}

export function setCachedMeasurement(shape: object, key: string, value: unknown): void {
  let map = cache.get(shape);
  if (!map) {
    map = new Map();
    cache.set(shape, map);
  }
  map.set(key, value);
}

export function clearMeasurementCache(shape?: object): void {
  if (shape) {
    cache.delete(shape);
  } else {
    cache = new WeakMap();
  }
}
