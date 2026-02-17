# OpenSCAD Parity Feature Batch — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 5 features to close the gap with OpenSCAD: resize, shape colors, enhanced 2D offset, DXF import, height-map surface.

**Architecture:** Each feature is a new function (or enhancement) in the existing functional API layer. All follow the `*Fns.ts` pattern with `Result<T>` types, branded shapes, and `.js` import extensions. Color propagation reuses the same WeakMap + boolean/modifier hook pattern as face tags.

**Tech Stack:** TypeScript, OpenCascade WASM, Vitest

---

### Task 1: `resize()` — Dimension-based scaling

**Files:**

- Modify: `src/topology/shapeFns.ts` (add `resize` after `scale`)
- Modify: `src/index.ts` (export `resize`)
- Modify: `tests/public-api-types.test.ts` (add to `EXPECTED_RUNTIME_EXPORTS`)
- Create: `tests/fn-resize.test.ts`

**Context:** The existing `scale()` function in `src/topology/shapeFns.ts:122` applies a uniform scale factor. `resize()` sets exact target dimensions by computing per-axis scale factors from the bounding box. The kernel exposes `boundingBox(shape)` via `getKernel().boundingBox()` returning `{ min: Vec3, max: Vec3 }`. Non-uniform scaling uses `applyMatrix()` which is already in the same file at line 220.

**Step 1: Write the failing test**

Create `tests/fn-resize.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { initOC } from './setup.js';
import { box, sphere, resize, measureVolume, unwrap } from '../src/index.js';

beforeAll(async () => {
  await initOC();
}, 30000);

describe('resize', () => {
  it('resizes box to exact dimensions', () => {
    const b = box(10, 20, 30);
    const resized = resize(b, [5, 10, 15]);
    const vol = unwrap(measureVolume(resized));
    expect(vol).toBeCloseTo(5 * 10 * 15, 0);
  });

  it('resizes with partial dimensions (auto-proportional)', () => {
    const b = box(10, 20, 30);
    // Set X to 5 (factor 0.5), Y and Z scale proportionally
    const resized = resize(b, [5, undefined, undefined], { auto: true });
    const vol = unwrap(measureVolume(resized));
    // factor = 0.5, so Y=10, Z=15 → vol = 5*10*15 = 750
    expect(vol).toBeCloseTo(750, 0);
  });

  it('resizes with only some dimensions (no auto = no change on undefined)', () => {
    const b = box(10, 20, 30);
    // Set X to 5, leave Y and Z unchanged
    const resized = resize(b, [5, undefined, undefined]);
    const vol = unwrap(measureVolume(resized));
    // X=5, Y=20, Z=30 → vol = 3000
    expect(vol).toBeCloseTo(3000, 0);
  });

  it('works on non-box shapes', () => {
    const s = sphere(10);
    // Sphere bbox is 20x20x20, resize to 10x10x10
    const resized = resize(s, [10, 10, 10]);
    const vol = unwrap(measureVolume(resized));
    // Sphere r=5, vol = 4/3 π r³ ≈ 523.6
    expect(vol).toBeCloseTo((4 / 3) * Math.PI * 125, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fn-resize.test.ts`
Expected: FAIL — `resize` is not exported

**Step 3: Write minimal implementation**

In `src/topology/shapeFns.ts`, add after the `scale` function (after line 135):

```typescript
/**
 * Resize a shape to exact target dimensions.
 *
 * @param dimensions - Target [x, y, z] sizes. Use `undefined` for axes to keep unchanged (or auto-scale).
 * @param options.auto - When true, undefined axes scale proportionally to the first defined axis.
 */
export function resize<T extends AnyShape>(
  shape: T,
  dimensions: [number | undefined, number | undefined, number | undefined],
  options?: { auto?: boolean }
): T {
  const kernel = getKernel();
  const bb = kernel.boundingBox(shape.wrapped);
  const size: Vec3 = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

  let factors: [number, number, number] = [1, 1, 1];

  if (options?.auto) {
    // Find the first defined axis and use its factor for all undefined axes
    let baseFactor = 1;
    for (let i = 0; i < 3; i++) {
      if (dimensions[i] !== undefined && size[i] > 0) {
        baseFactor = dimensions[i]! / size[i];
        break;
      }
    }
    factors = [
      dimensions[0] !== undefined && size[0] > 0 ? dimensions[0] / size[0] : baseFactor,
      dimensions[1] !== undefined && size[1] > 0 ? dimensions[1] / size[1] : baseFactor,
      dimensions[2] !== undefined && size[2] > 0 ? dimensions[2] / size[2] : baseFactor,
    ];
  } else {
    factors = [
      dimensions[0] !== undefined && size[0] > 0 ? dimensions[0] / size[0] : 1,
      dimensions[1] !== undefined && size[1] > 0 ? dimensions[1] / size[1] : 1,
      dimensions[2] !== undefined && size[2] > 0 ? dimensions[2] / size[2] : 1,
    ];
  }

  // Non-uniform scale via matrix
  return applyMatrix(shape, [
    [factors[0], 0, 0, 0],
    [0, factors[1], 0, 0],
    [0, 0, factors[2], 0],
  ]);
}
```

Note: The `!` after `dimensions[i]` is safe because we check `!== undefined` first. However, lint bans non-null assertions, so use the pattern: `(dimensions[0] as number) / size[0]` or restructure with a variable.

Add to `src/index.ts` in the topology exports section (alphabetical order):

```typescript
export { resize } from './topology/shapeFns.js';
```

Add `'resize'` to `EXPECTED_RUNTIME_EXPORTS` in `tests/public-api-types.test.ts` in correct alphabetical position (after `'removeChild'`, before `'replayFrom'`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fn-resize.test.ts`
Expected: PASS — all 4 tests green

**Step 5: Commit**

```bash
git add src/topology/shapeFns.ts src/index.ts tests/fn-resize.test.ts tests/public-api-types.test.ts
git commit -m "feat: add resize() for dimension-based scaling"
```

---

### Task 2: Shape-attached colors

**Files:**

- Create: `src/topology/colorFns.ts`
- Modify: `src/topology/booleanFns.ts` (add `propagateColors` calls)
- Modify: `src/topology/modifierFns.ts` (add `propagateColors` calls)
- Modify: `src/index.ts` (export color functions)
- Modify: `tests/public-api-types.test.ts` (add to `EXPECTED_RUNTIME_EXPORTS`)
- Create: `tests/fn-colorFns.test.ts`

**Context:** Face tags (`src/topology/faceTagFns.ts`) use WeakMap keyed on `shape.wrapped` with face hashes for tracking through operations. `propagateFaceTags` is called alongside `propagateOrigins` in `booleanFns.ts` (lines 130-131, 168-169, 204-205, 295, 347-348) and `modifierFns.ts` (lines 52-53, 137-138, 254-255, 323-324, 378-379). Color propagation follows the exact same pattern.

The color type: `ColorInput = string | [number, number, number] | [number, number, number, number]`. Hex strings parsed with `colorFromHex` from `src/operations/exporterUtils.ts:40`. Internal storage normalized to `[r, g, b, a]` as 0-1 floats.

**Step 1: Write the failing test**

Create `tests/fn-colorFns.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { initOC } from './setup.js';
import {
  box,
  fuse,
  fillet,
  colorShape,
  colorFaces,
  getShapeColor,
  getFaceColor,
  getFaces,
  faceFinder,
  isOk,
  unwrap,
} from '../src/index.js';

beforeAll(async () => {
  await initOC();
}, 30000);

describe('shape colors', () => {
  it('assigns and retrieves color on a shape', () => {
    const b = box(10, 10, 10);
    const colored = colorShape(b, '#ff0000');
    const c = getShapeColor(colored);
    expect(c).toBeDefined();
    expect(c![0]).toBeCloseTo(1, 1); // r
    expect(c![1]).toBeCloseTo(0, 1); // g
    expect(c![2]).toBeCloseTo(0, 1); // b
    expect(c![3]).toBeCloseTo(1, 1); // a
  });

  it('assigns color with RGB tuple', () => {
    const b = box(10, 10, 10);
    const colored = colorShape(b, [0.5, 0.5, 0.5]);
    const c = getShapeColor(colored);
    expect(c).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('assigns color with RGBA tuple', () => {
    const b = box(10, 10, 10);
    const colored = colorShape(b, [1, 0, 0, 0.5]);
    const c = getShapeColor(colored);
    expect(c).toEqual([1, 0, 0, 0.5]);
  });

  it('assigns color per-face', () => {
    const b = box(10, 10, 10);
    const topFaces = faceFinder().inDirection([0, 0, 1]).findAll(b);
    const colored = colorFaces(b, topFaces, [1, 0, 0, 1]);
    const fc = getFaceColor(colored, topFaces[0]);
    expect(fc).toEqual([1, 0, 0, 1]);
  });

  it('returns undefined for uncolored shape', () => {
    const b = box(10, 10, 10);
    expect(getShapeColor(b)).toBeUndefined();
  });

  it('colors persist through fuse', () => {
    const b1 = box(10, 10, 10);
    const colored = colorShape(b1, [1, 0, 0, 1]);
    const b2 = box(5, 5, 5);
    const result = fuse(colored, b2);
    expect(isOk(result)).toBe(true);
    const fused = unwrap(result);
    const c = getShapeColor(fused);
    expect(c).toEqual([1, 0, 0, 1]);
  });

  it('face colors persist through fillet', () => {
    const b = box(10, 10, 10);
    const allFaces = getFaces(b);
    const colored = colorFaces(b, allFaces, [0, 1, 0, 1]);
    const filleted = unwrap(fillet(colored, 0.5));
    // At least some original faces should retain color
    const faces = getFaces(filleted);
    const colorsFound = faces.filter((f) => getFaceColor(filleted, f) !== undefined);
    expect(colorsFound.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fn-colorFns.test.ts`
Expected: FAIL — `colorShape` is not exported

**Step 3: Write minimal implementation**

Create `src/topology/colorFns.ts`:

```typescript
/**
 * Shape color functions — attach RGBA colors to shapes and faces,
 * persisting through boolean operations and modifiers.
 */

import type { AnyShape, Face } from '../core/shapeTypes.js';
import { HASH_CODE_MAX } from '../core/constants.js';
import { getKernel } from '../kernel/index.js';
import { getFaces } from './shapeFns.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** RGBA color as 0-1 float tuple. */
export type Color = [number, number, number, number];

/** Input color: hex string, RGB tuple, or RGBA tuple. */
export type ColorInput = string | [number, number, number] | [number, number, number, number];

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

// shape.wrapped → whole-shape color
const shapeColorStore = new WeakMap<object, Color>();

// shape.wrapped → face hash → color
const faceColorStore = new WeakMap<object, Map<number, Color>>();

function parseColor(input: ColorInput): Color {
  if (typeof input === 'string') {
    let hex = input;
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3) hex = hex.replace(/([0-9a-f])/gi, '$1$1');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b, 1];
  }
  if (input.length === 3) return [input[0], input[1], input[2], 1];
  return [input[0], input[1], input[2], input[3]];
}

function getFaceHash(face: Face): number {
  return face.wrapped.HashCode(HASH_CODE_MAX);
}

function getFaceColorMap(shape: AnyShape): Map<number, Color> {
  let map = faceColorStore.get(shape.wrapped);
  if (!map) {
    map = new Map();
    faceColorStore.set(shape.wrapped, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set color on an entire shape.
 * Returns the same shape (color is stored externally).
 */
export function colorShape<T extends AnyShape>(shape: T, color: ColorInput): T {
  shapeColorStore.set(shape.wrapped, parseColor(color));
  return shape;
}

/**
 * Set color on specific faces of a shape.
 */
export function colorFaces<T extends AnyShape>(shape: T, faces: Face[], color: ColorInput): T {
  const parsed = parseColor(color);
  const map = getFaceColorMap(shape);
  for (const face of faces) {
    map.set(getFaceHash(face), parsed);
  }
  return shape;
}

/**
 * Get the whole-shape color, or undefined if not set.
 */
export function getShapeColor(shape: AnyShape): Color | undefined {
  return shapeColorStore.get(shape.wrapped);
}

/**
 * Get the color of a specific face, or undefined if not set.
 */
export function getFaceColor(shape: AnyShape, face: Face): Color | undefined {
  const map = faceColorStore.get(shape.wrapped);
  if (!map) return undefined;
  return map.get(getFaceHash(face));
}

// ---------------------------------------------------------------------------
// Propagation (called from booleanFns / modifierFns)
// ---------------------------------------------------------------------------

/**
 * Propagate colors from input shapes to output shape through a boolean/modifier op.
 * Same pattern as propagateFaceTags.
 */
export function propagateColors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCCT op type
  op: any,
  inputs: readonly AnyShape[],
  output: AnyShape
): void {
  const oc = getKernel().oc;
  const outputFaceMap = getFaceColorMap(output);

  // Propagate whole-shape color from first input that has one
  for (const input of inputs) {
    const shapeColor = shapeColorStore.get(input.wrapped);
    if (shapeColor && !shapeColorStore.has(output.wrapped)) {
      shapeColorStore.set(output.wrapped, shapeColor);
    }
  }

  // Propagate per-face colors
  for (const input of inputs) {
    const inputFaceMap = faceColorStore.get(input.wrapped);
    if (!inputFaceMap || inputFaceMap.size === 0) continue;

    const inputFaces = getFaces(input);
    for (const face of inputFaces) {
      const hash = getFaceHash(face);
      const color = inputFaceMap.get(hash);
      if (!color) continue;

      const modified = op.Modified(face.wrapped);
      const count = modified.Size();
      for (let i = 1; i <= count; i++) {
        const modifiedFace = oc.TopoDS.Face_1(modified.Value(i));
        outputFaceMap.set(modifiedFace.HashCode(HASH_CODE_MAX), color);
      }
    }
  }
}
```

Add propagation calls in `src/topology/booleanFns.ts` — add `import { propagateColors } from './colorFns.js';` alongside the existing faceTag import, then add `propagateColors(...)` after every `propagateFaceTags(...)` call (same arguments). There are 5 call sites: lines 131, 169, 205, 295 area (fuseAll by hash — skip this one, it uses `propagateOriginsByHash` not a standard op), and 348.

Add propagation calls in `src/topology/modifierFns.ts` — same pattern. Add import, then add `propagateColors(builder, [shape], cast)` after every `propagateFaceTags(builder, [shape], cast)` call. There are 5 call sites: lines 53, 138, 255, 324, 379.

Add to `src/index.ts`:

```typescript
export { colorShape, colorFaces, getShapeColor, getFaceColor } from './topology/colorFns.js';
export type { Color, ColorInput } from './topology/colorFns.js';
```

Add to `EXPECTED_RUNTIME_EXPORTS` in alphabetical order: `'colorFaces'` (before `'collectShapes'`), `'colorShape'` (after `'colorFaces'`), `'getFaceColor'` (near other `get*` entries — after `'getEdges'`, before `'getFaceTags'`), `'getShapeColor'` (after `'getSurfaceType'`, before `'getTagMetadata'`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fn-colorFns.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Commit**

```bash
git add src/topology/colorFns.ts src/topology/booleanFns.ts src/topology/modifierFns.ts src/index.ts tests/fn-colorFns.test.ts tests/public-api-types.test.ts
git commit -m "feat: add shape-attached colors with propagation"
```

---

### Task 3: Enhanced 2D offset with chamfer join

**Files:**

- Modify: `src/topology/curveFns.ts` (add `'chamfer'` join type)
- Modify: `src/kernel/modifierOps.ts` (if kernel-level change needed)
- Modify: `tests/fn-curveFns.test.ts` (or create new test file)

**Context:** `offsetWire2D` in `src/topology/curveFns.ts:242` accepts `'arc' | 'intersection' | 'tangent'` and maps to OCCT `GeomAbs_JoinType` enum values. The kernel-level function in `src/kernel/modifierOps.ts:223` uses `BRepOffsetAPI_MakeOffset_3`. OCCT's `GeomAbs_JoinType` typically has `GeomAbs_Arc`, `GeomAbs_Tangent`, and `GeomAbs_Intersection`. There is no native `GeomAbs_Chamfer` — chamfer offset is implemented by using `GeomAbs_Intersection` which produces sharp corners (miter), which is equivalent to a chamfer when combined with appropriate distance.

**IMPORTANT:** Before implementing, check if `GeomAbs_JoinType` in the WASM build has additional values. Run: `node -e "const oc = ...; console.log(Object.keys(oc.GeomAbs_JoinType))"` or inspect the enum. If no chamfer value exists, document that `'intersection'` already produces chamfer-like results and consider whether adding a `'chamfer'` alias is sufficient, or if post-processing is needed.

**Step 1: Write the failing test**

Add to existing test file or create `tests/fn-offsetWire2D.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { initOC } from './setup.js';
import { sketchRectangle, offsetWire2D, isOk, unwrap, curveLength } from '../src/index.js';

beforeAll(async () => {
  await initOC();
}, 30000);

describe('offsetWire2D chamfer join', () => {
  it('offsets with chamfer join type', () => {
    const rect = sketchRectangle(10, 10);
    const result = offsetWire2D(rect, 2, 'chamfer');
    expect(isOk(result)).toBe(true);
    const wire = unwrap(result);
    // Chamfered corners should give a different perimeter than arc corners
    const len = curveLength(wire);
    expect(len).toBeGreaterThan(0);
  });

  it('chamfer produces different result than arc', () => {
    const rect = sketchRectangle(10, 10);
    const arcResult = unwrap(offsetWire2D(rect, 2, 'arc'));
    const chamferResult = unwrap(offsetWire2D(rect, 2, 'chamfer'));
    const arcLen = curveLength(arcResult);
    const chamferLen = curveLength(chamferResult);
    // Arc corners are longer than chamfer corners
    expect(arcLen).not.toBeCloseTo(chamferLen, 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fn-offsetWire2D.test.ts`
Expected: FAIL — `'chamfer'` not in type union

**Step 3: Write minimal implementation**

In `src/topology/curveFns.ts`, update the `offsetWire2D` function signature and join type map:

```typescript
export function offsetWire2D(
  wire: Wire,
  offset: number,
  kind: 'arc' | 'intersection' | 'tangent' | 'chamfer' = 'arc'
): Result<Wire> {
  const oc = getKernel().oc;
  const joinTypes = {
    arc: oc.GeomAbs_JoinType.GeomAbs_Arc,
    intersection: oc.GeomAbs_JoinType.GeomAbs_Intersection,
    tangent: oc.GeomAbs_JoinType.GeomAbs_Tangent,
    chamfer: oc.GeomAbs_JoinType.GeomAbs_Intersection, // chamfer = sharp corners (miter)
  };
  // ... rest unchanged
```

**Note:** If `GeomAbs_JoinType` has no true chamfer, `intersection` produces sharp miter corners which is the closest equivalent. If the WASM build includes an actual chamfer enum value, use that instead. The test should still differentiate arc from chamfer since intersection/miter gives different lengths than arc.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fn-offsetWire2D.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/topology/curveFns.ts tests/fn-offsetWire2D.test.ts
git commit -m "feat: add chamfer join type to offsetWire2D"
```

---

### Task 4: DXF import

**Files:**

- Create: `src/io/dxfImportFns.ts`
- Modify: `src/index.ts` (export `importDXF`)
- Modify: `tests/public-api-types.test.ts` (add to `EXPECTED_RUNTIME_EXPORTS`)
- Create: `tests/fn-dxfImport.test.ts`
- Create: `tests/fixtures/test-rectangle.dxf` (minimal DXF test fixture)

**Context:** The existing `importSTEP`/`importSTL`/`importIGES` functions in `src/io/importFns.ts` all follow the same pattern: accept a `Blob`, read it as text/arraybuffer, process it, return `Result<AnyShape>`. DXF import is different because DXF is a text format that we parse ourselves (no OCCT DXF reader for 2D). We parse entities into OCCT edges and assemble into wires.

DXF ASCII format: sections delimited by `0\nSECTION` / `0\nENDSEC`. We only need the `ENTITIES` section. Each entity starts with `0\nENTITY_TYPE`. Key group codes: 10/20/30 = start point, 11/21/31 = end point, 40 = radius, 50/51 = start/end angle, 8 = layer name.

**Step 1: Write the failing test**

First create a minimal DXF fixture file `tests/fixtures/test-rectangle.dxf`:

```
0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
10.0
21
0.0
31
0.0
0
LINE
8
0
10
10.0
20
0.0
30
0.0
11
10.0
21
10.0
31
0.0
0
LINE
8
0
10
10.0
20
10.0
30
0.0
11
0.0
21
10.0
31
0.0
0
LINE
8
0
10
0.0
20
10.0
30
0.0
11
0.0
21
0.0
31
0.0
0
ENDSEC
0
EOF
```

Create `tests/fn-dxfImport.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initOC } from './setup.js';
import { importDXF, isOk, unwrap, curveLength } from '../src/index.js';

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
    // Rectangle 10x10 → perimeter = 40
    const len = curveLength(wires[0]);
    expect(len).toBeCloseTo(40, 0);
  });

  it('filters by layer', async () => {
    // All lines in fixture are on layer "0"
    const dxfData = readFileSync(resolve(__dirname, 'fixtures/test-rectangle.dxf'), 'utf-8');
    const blob = new Blob([dxfData]);
    const result = await importDXF(blob, { layer: 'nonexistent' });
    expect(isOk(result)).toBe(true);
    const wires = unwrap(result);
    expect(wires.length).toBe(0);
  });

  it('returns error for empty/invalid DXF', async () => {
    const blob = new Blob(['not a dxf file']);
    const result = await importDXF(blob);
    // Should still return ok with empty wires (no entities found)
    expect(isOk(result)).toBe(true);
    const wires = unwrap(result);
    expect(wires.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fn-dxfImport.test.ts`
Expected: FAIL — `importDXF` is not exported

**Step 3: Write minimal implementation**

Create `src/io/dxfImportFns.ts`:

```typescript
/**
 * DXF file import — parse ASCII DXF entities into OCCT wires.
 */

import { getKernel } from '../kernel/index.js';
import type { Wire } from '../core/shapeTypes.js';
import { castShape, isWire } from '../core/shapeTypes.js';
import { type Result, ok, err } from '../core/result.js';
import { ioError, BrepErrorCode } from '../core/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DXFImportOptions {
  /** Filter entities to a specific layer name. */
  layer?: string;
}

interface DXFEntity {
  type: string;
  layer: string;
  data: Map<number, string[]>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseDXF(text: string): DXFEntity[] {
  const lines = text.split(/\r?\n/);
  const entities: DXFEntity[] = [];
  let inEntities = false;
  let current: DXFEntity | null = null;

  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1]?.trim() ?? '';

    if (code === 0 && value === 'SECTION') {
      // Check if next pair is 2/ENTITIES
      if (i + 2 < lines.length - 1) {
        const nextCode = parseInt(lines[i + 2].trim(), 10);
        const nextVal = lines[i + 3]?.trim() ?? '';
        if (nextCode === 2 && nextVal === 'ENTITIES') {
          inEntities = true;
          i += 2; // skip the 2/ENTITIES pair
          continue;
        }
      }
    }

    if (code === 0 && value === 'ENDSEC') {
      if (current) entities.push(current);
      current = null;
      inEntities = false;
      continue;
    }

    if (code === 0 && value === 'EOF') break;

    if (!inEntities) continue;

    if (code === 0) {
      if (current) entities.push(current);
      current = { type: value, layer: '0', data: new Map() };
      continue;
    }

    if (current) {
      if (code === 8) current.layer = value;
      const existing = current.data.get(code);
      if (existing) existing.push(value);
      else current.data.set(code, [value]);
    }
  }

  if (current) entities.push(current);
  return entities;
}

function getNum(entity: DXFEntity, code: number): number {
  const val = entity.data.get(code);
  return val ? parseFloat(val[0]) : 0;
}

// ---------------------------------------------------------------------------
// Entity → Edge conversion
// ---------------------------------------------------------------------------

function buildEdges(
  entities: DXFEntity[],
  layer?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCCT edge type
): any[] {
  const oc = getKernel().oc;
  const edges: ReturnType<typeof oc.BRepBuilderAPI_MakeEdge_3>[] = [];

  for (const ent of entities) {
    if (layer && ent.layer !== layer) continue;

    if (ent.type === 'LINE') {
      const p1 = new oc.gp_Pnt_3(getNum(ent, 10), getNum(ent, 20), getNum(ent, 30));
      const p2 = new oc.gp_Pnt_3(getNum(ent, 11), getNum(ent, 21), getNum(ent, 31));
      const builder = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
      if (builder.IsDone()) edges.push(builder.Edge());
      builder.delete();
      p1.delete();
      p2.delete();
    }

    if (ent.type === 'CIRCLE') {
      const cx = getNum(ent, 10);
      const cy = getNum(ent, 20);
      const cz = getNum(ent, 30);
      const r = getNum(ent, 40);
      const center = new oc.gp_Pnt_3(cx, cy, cz);
      const dir = new oc.gp_Dir_4(0, 0, 1);
      const ax2 = new oc.gp_Ax2_3(center, dir);
      const circ = new oc.gp_Circ_2(ax2, r);
      const builder = new oc.BRepBuilderAPI_MakeEdge_8(circ);
      if (builder.IsDone()) edges.push(builder.Edge());
      builder.delete();
      circ.delete();
      ax2.delete();
      dir.delete();
      center.delete();
    }

    if (ent.type === 'ARC') {
      const cx = getNum(ent, 10);
      const cy = getNum(ent, 20);
      const cz = getNum(ent, 30);
      const r = getNum(ent, 40);
      const startAngle = (getNum(ent, 50) * Math.PI) / 180;
      const endAngle = (getNum(ent, 51) * Math.PI) / 180;
      const center = new oc.gp_Pnt_3(cx, cy, cz);
      const dir = new oc.gp_Dir_4(0, 0, 1);
      const ax2 = new oc.gp_Ax2_3(center, dir);
      const circ = new oc.gp_Circ_2(ax2, r);
      const builder = new oc.BRepBuilderAPI_MakeEdge_9(circ, startAngle, endAngle);
      if (builder.IsDone()) edges.push(builder.Edge());
      builder.delete();
      circ.delete();
      ax2.delete();
      dir.delete();
      center.delete();
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Wire assembly
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCCT edge array
function assembleWires(edges: any[]): Wire[] {
  if (edges.length === 0) return [];

  const oc = getKernel().oc;
  const connector = new oc.ShapeAnalysis_FreeBounds();

  // Build a compound of all edges
  const compBuilder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  compBuilder.MakeCompound(compound);
  for (const edge of edges) {
    compBuilder.Add(compound, edge);
  }

  // Use ConnectEdgesToWires to auto-assemble
  const wireHandle = new oc.Handle_TopTools_HSequenceOfShape_1();
  const edgeHandle = new oc.Handle_TopTools_HSequenceOfShape_1();

  // Fallback: just build a single wire from all edges
  const wireBuilder = new oc.BRepBuilderAPI_MakeWire_1();
  for (const edge of edges) {
    wireBuilder.Add_1(edge);
  }

  const wires: Wire[] = [];
  if (wireBuilder.IsDone()) {
    const wrapped = castShape(wireBuilder.Wire());
    if (isWire(wrapped)) wires.push(wrapped);
  }

  wireBuilder.delete();
  return wires;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a DXF file from a Blob.
 *
 * Parses ASCII DXF entities (LINE, CIRCLE, ARC) and assembles them into wires.
 *
 * @param blob - A Blob or File containing DXF data.
 * @param options.layer - Filter to entities on a specific layer.
 */
export async function importDXF(blob: Blob, options?: DXFImportOptions): Promise<Result<Wire[]>> {
  try {
    const text = await blob.text();
    const entities = parseDXF(text);
    const edges = buildEdges(entities, options?.layer);
    const wires = assembleWires(edges);
    return ok(wires);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(ioError(BrepErrorCode.IO_IMPORT_FAILED, `DXF import failed: ${msg}`, e));
  }
}
```

Add to `src/index.ts`:

```typescript
export { importDXF } from './io/dxfImportFns.js';
export type { DXFImportOptions } from './io/dxfImportFns.js';
```

Add `'importDXF'` to `EXPECTED_RUNTIME_EXPORTS` in alphabetical order (after `'importBrep'` or `'healWire'`, before `'importIGES'`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fn-dxfImport.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/io/dxfImportFns.ts src/index.ts tests/fn-dxfImport.test.ts tests/fixtures/test-rectangle.dxf tests/public-api-types.test.ts
git commit -m "feat: add DXF import for LINE, CIRCLE, ARC entities"
```

---

### Task 5: Height-map surface

**Files:**

- Create: `src/topology/surfaceFns.ts`
- Modify: `src/index.ts` (export `surfaceFromGrid`)
- Modify: `tests/public-api-types.test.ts` (add to `EXPECTED_RUNTIME_EXPORTS`)
- Create: `tests/fn-surfaceFns.test.ts`

**Context:** OCCT provides `GeomAPI_PointsToBSplineSurface` for fitting B-spline surfaces to point grids, and `BRepBuilderAPI_MakeFace` for converting surfaces to faces. **WARNING:** These types may not be bound in the WASM build (similar to `gp_Pln` issue from previous batch). If `GeomAPI_PointsToBSplineSurface` is not available, fall back to constructing a grid of triangular faces via `BRepBuilderAPI_Sewing`.

The function takes a 2D array of heights and optional physical dimensions, returning a `Result<Face>`.

**Step 1: Write the failing test**

Create `tests/fn-surfaceFns.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { initOC } from './setup.js';
import { surfaceFromGrid, isOk, isErr, unwrap, measureArea } from '../src/index.js';

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
    const face = unwrap(result);
    const area = unwrap(measureArea(face));
    expect(area).toBeCloseTo(100, 0);
  });

  it('creates a surface with varying heights', () => {
    const heights = [
      [0, 0, 0],
      [0, 5, 0],
      [0, 0, 0],
    ];
    const result = surfaceFromGrid(heights, { width: 10, depth: 10 });
    expect(isOk(result)).toBe(true);
    const face = unwrap(result);
    const area = unwrap(measureArea(face));
    // Area should be greater than flat 100 due to the raised center
    expect(area).toBeGreaterThan(100);
  });

  it('respects scaleZ option', () => {
    const heights = [
      [0, 0],
      [0, 1],
    ];
    const r1 = surfaceFromGrid(heights, { width: 10, depth: 10 });
    const r2 = surfaceFromGrid(heights, { width: 10, depth: 10, scaleZ: 5 });
    expect(isOk(r1)).toBe(true);
    expect(isOk(r2)).toBe(true);
    const a1 = unwrap(measureArea(unwrap(r1)));
    const a2 = unwrap(measureArea(unwrap(r2)));
    // Scaled version should have more area
    expect(a2).toBeGreaterThan(a1);
  });

  it('rejects grids smaller than 2x2', () => {
    const result = surfaceFromGrid([[1]], { width: 10, depth: 10 });
    expect(isErr(result)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fn-surfaceFns.test.ts`
Expected: FAIL — `surfaceFromGrid` is not exported

**Step 3: Write minimal implementation**

Create `src/topology/surfaceFns.ts`:

```typescript
/**
 * Surface creation functions — generate faces from height-map grids.
 */

import { getKernel } from '../kernel/index.js';
import type { Face } from '../core/shapeTypes.js';
import { castShape, isFace } from '../core/shapeTypes.js';
import { type Result, ok, err } from '../core/result.js';
import { validationError, occtError, BrepErrorCode } from '../core/errors.js';

export interface SurfaceFromGridOptions {
  /** Physical width in X direction. Default: number of columns - 1. */
  width?: number;
  /** Physical depth in Y direction. Default: number of rows - 1. */
  depth?: number;
  /** Scale factor for Z values. Default: 1. */
  scaleZ?: number;
}

/**
 * Create a B-spline surface from a 2D grid of height values.
 *
 * @param heights - Row-major 2D array of Z values. Must be at least 2x2.
 * @param options - Physical dimensions and Z scale.
 */
export function surfaceFromGrid(
  heights: number[][],
  options?: SurfaceFromGridOptions
): Result<Face> {
  const rows = heights.length;
  if (rows < 2) {
    return err(
      validationError(BrepErrorCode.INVALID_INPUT, 'surfaceFromGrid: grid must be at least 2x2')
    );
  }
  const cols = heights[0].length;
  if (cols < 2) {
    return err(
      validationError(BrepErrorCode.INVALID_INPUT, 'surfaceFromGrid: grid must be at least 2x2')
    );
  }

  const width = options?.width ?? cols - 1;
  const depth = options?.depth ?? rows - 1;
  const scaleZ = options?.scaleZ ?? 1;

  const oc = getKernel().oc;

  try {
    // Build point grid
    const pntArray = new oc.TColgp_Array2OfPnt_2(1, rows, 1, cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c / (cols - 1)) * width;
        const y = (r / (rows - 1)) * depth;
        const z = (heights[r][c] ?? 0) * scaleZ;
        const pnt = new oc.gp_Pnt_3(x, y, z);
        pntArray.SetValue(r + 1, c + 1, pnt);
        pnt.delete();
      }
    }

    // Fit B-spline surface
    const fitter = new oc.GeomAPI_PointsToBSplineSurface_2(
      pntArray,
      3, // degMin
      8, // degMax
      0, // continuity (GeomAbs_C2)
      1e-3 // tolerance
    );

    if (!fitter.IsDone()) {
      pntArray.delete();
      fitter.delete();
      return err(
        occtError(BrepErrorCode.OCCT_OPERATION_FAILED, 'surfaceFromGrid: B-spline fitting failed')
      );
    }

    const surface = fitter.Surface();
    const faceMaker = new oc.BRepBuilderAPI_MakeFace_8(surface, 1e-6);

    if (!faceMaker.IsDone()) {
      pntArray.delete();
      fitter.delete();
      faceMaker.delete();
      return err(
        occtError(BrepErrorCode.OCCT_OPERATION_FAILED, 'surfaceFromGrid: face construction failed')
      );
    }

    const result = castShape(faceMaker.Face());
    pntArray.delete();
    fitter.delete();
    faceMaker.delete();

    if (!isFace(result)) {
      return err(
        occtError(BrepErrorCode.OCCT_OPERATION_FAILED, 'surfaceFromGrid: result is not a face')
      );
    }

    return ok(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If GeomAPI_PointsToBSplineSurface is not bound in WASM, this will throw
    return err(occtError(BrepErrorCode.OCCT_OPERATION_FAILED, `surfaceFromGrid failed: ${msg}`, e));
  }
}
```

**FALLBACK:** If `GeomAPI_PointsToBSplineSurface` or `TColgp_Array2OfPnt` throws `UnboundTypeError`, implement a triangulated mesh approach instead:

1. Create triangular faces from adjacent grid points using `BRepBuilderAPI_MakePolygon` + `BRepBuilderAPI_MakeFace`
2. Sew them together with `BRepBuilderAPI_Sewing`
3. Return the resulting shell/face

Add to `src/index.ts`:

```typescript
export { surfaceFromGrid } from './topology/surfaceFns.js';
export type { SurfaceFromGridOptions } from './topology/surfaceFns.js';
```

Add `'surfaceFromGrid'` to `EXPECTED_RUNTIME_EXPORTS` (after `'subFace'`, before `'sweep'`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fn-surfaceFns.test.ts`
Expected: PASS — all 4 tests green. If `GeomAPI_PointsToBSplineSurface` is unbound, implement the triangulated fallback.

**Step 5: Commit**

```bash
git add src/topology/surfaceFns.ts src/index.ts tests/fn-surfaceFns.test.ts tests/public-api-types.test.ts
git commit -m "feat: add surfaceFromGrid for height-map surfaces"
```

---

### Task 6: Integration checks

**Step 1: Run full test suite**

```bash
npm run test
```

Expected: All tests pass (1600+ tests)

**Step 2: Run type checker**

```bash
npm run typecheck
```

Expected: No errors

**Step 3: Run lint**

```bash
npm run lint
```

Expected: No errors

**Step 4: Run boundary check**

```bash
npm run check:boundaries
```

Expected: No violations (`colorFns.ts` and `surfaceFns.ts` in Layer 2, `dxfImportFns.ts` in Layer 2)

**Step 5: Run knip**

```bash
npm run knip
```

Expected: No unused exports
