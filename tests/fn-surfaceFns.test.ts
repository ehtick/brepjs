import { describe, expect, it, beforeAll } from 'vitest';
import { initOC } from './setup.js';
import {
  surfaceFromGrid,
  isOk,
  isErr,
  unwrap,
  measureArea,
  type Face,
  type Shape3D,
} from '../src/index.js';

beforeAll(async () => {
  await initOC();
}, 30000);

describe('surfaceFromGrid', () => {
  it('creates a flat surface from uniform heights', () => {
    const heights = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const result = surfaceFromGrid(heights, { width: 10, depth: 10 });
    expect(isOk(result)).toBe(true);
    const shape = unwrap(result) as Face | Shape3D;
    const area = measureArea(shape);
    expect(area).toBeCloseTo(100, -1);
  });

  it('creates a surface with varying heights', () => {
    const heights = [
      [0, 0, 0],
      [0, 5, 0],
      [0, 0, 0],
    ];
    const result = surfaceFromGrid(heights, { width: 10, depth: 10 });
    expect(isOk(result)).toBe(true);
    const shape = unwrap(result) as Face | Shape3D;
    const area = measureArea(shape);
    expect(area).toBeGreaterThan(100);
  });

  it('rejects grids smaller than 2x2', () => {
    expect(isErr(surfaceFromGrid([[1]]))).toBe(true);
    expect(isErr(surfaceFromGrid([]))).toBe(true);
  });

  it('rejects jagged grids', () => {
    const jagged = [
      [0, 0, 0],
      [0, 0],
    ];
    expect(isErr(surfaceFromGrid(jagged))).toBe(true);
  });

  it('applies scaleZ option', () => {
    const heights = [
      [0, 0],
      [0, 1],
    ];
    const r1 = surfaceFromGrid(heights, { width: 10, depth: 10, scaleZ: 1 });
    const r2 = surfaceFromGrid(heights, { width: 10, depth: 10, scaleZ: 10 });
    expect(isOk(r1)).toBe(true);
    expect(isOk(r2)).toBe(true);
    const a1 = measureArea(unwrap(r1) as Face | Shape3D);
    const a2 = measureArea(unwrap(r2) as Face | Shape3D);
    expect(a2).toBeGreaterThan(a1);
  });
});
