import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initOC } from './setup.js';
import { importDXF, isOk, unwrap, curveLength } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  await initOC();
}, 30000);

describe('importDXF', () => {
  it('imports a rectangle from DXF', async () => {
    const dxfData = readFileSync(resolve(__dirname, 'fixtures/test-rectangle.dxf'), 'utf-8');
    const blob = new Blob([dxfData]);
    const result = await importDXF(blob);
    expect(isOk(result)).toBe(true);
    const wires = unwrap(result);
    expect(wires.length).toBeGreaterThanOrEqual(1);
    const len = curveLength(wires[0]);
    expect(len).toBeCloseTo(40, 0); // 10x10 rectangle perimeter
  });

  it('filters by layer', async () => {
    const dxfData = readFileSync(resolve(__dirname, 'fixtures/test-rectangle.dxf'), 'utf-8');
    const blob = new Blob([dxfData]);
    const result = await importDXF(blob, { layer: 'nonexistent' });
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).length).toBe(0);
  });

  it('returns empty array for non-DXF content', async () => {
    const blob = new Blob(['not a dxf file']);
    const result = await importDXF(blob);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).length).toBe(0);
  });
});
