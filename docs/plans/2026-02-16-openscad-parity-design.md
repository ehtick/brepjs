# OpenSCAD Parity Feature Batch — Design

## Goal

Close the feature gap between brepjs and OpenSCAD by adding 5 high-impact features: dimension-based resize, shape-attached colors, enhanced 2D offset with chamfer, DXF import, and height-map surface creation.

## Features

### 1. `resize()` — Dimension-based scaling

Scale a shape to exact target dimensions with optional proportional scaling.

```typescript
resize<T extends AnyShape>(shape: T, dimensions: Partial<Vec3Like>, options?: { auto?: boolean }): T
```

- `resize(myBox, [100, undefined, undefined])` — set X to 100, keep Y/Z proportional
- `resize(myBox, [100, 50, 30])` — set all three dimensions exactly
- `auto: true` — undefined axes scale proportionally to the first defined axis

**Implementation:** Compute bounding box, derive scale factors, apply via `applyMatrix()`. Lives in `src/topology/shapeFns.ts`. ~30 lines.

### 2. Shape-attached colors

Attach RGBA color to shapes (whole shape or per-face), persisting through boolean/modifier operations.

```typescript
colorShape(shape: AnyShape, color: ColorInput): AnyShape
colorFaces(shape: AnyShape, faces: Face[], color: ColorInput): AnyShape
getShapeColor(shape: AnyShape): Color | undefined
getFaceColor(shape: AnyShape, face: Face): Color | undefined
propagateColors(op: ShapeMapper, inputs: AnyShape[], output: AnyShape): void
```

`ColorInput = string | [r,g,b] | [r,g,b,a]` (hex or 0-1 floats).

**Implementation:** WeakMap on `shape.wrapped`, same pattern as `faceTagFns.ts`. Propagation hooks in booleanFns/modifierFns. New file `src/topology/colorFns.ts`. Auto-populate glTF materials from shape colors.

### 3. Enhanced 2D offset with chamfer join

Add chamfer join type to `offsetWire2D()`.

```typescript
offsetWire2D(wire, offset, joinType?: 'arc' | 'intersection' | 'tangent' | 'chamfer'): Result<Wire>
```

**Implementation:** Check OCCT `GeomAbs_JoinType` support. If chamfer not natively available, use intersection-join + post-process chamfer. Modify `src/topology/curveFns.ts`.

### 4. DXF import

Import DXF files to wires.

```typescript
importDXF(blob: Blob, options?: { layer?: string }): Promise<Result<Wire[]>>
```

**Implementation:** ASCII DXF parser in `src/io/dxfImportFns.ts`. Entities: LINE, ARC, CIRCLE, POLYLINE, LWPOLYLINE, SPLINE, ELLIPSE. Group by layer, convert to OCCT edges, assemble into wires. ~300-400 lines.

### 5. Height-map surface

Create a B-spline surface from a 2D grid of height values.

```typescript
surfaceFromGrid(
  heights: number[][] | Float64Array,
  options?: { width?: number; depth?: number; scaleZ?: number }
): Result<Face>
```

**Implementation:** `TColgp_Array2OfPnt` grid → `GeomAPI_PointsToBSplineSurface` → `BRepBuilderAPI_MakeFace`. New file `src/topology/surfaceFns.ts`. ~80 lines.

## Architecture

All features follow existing patterns:

- Functional API in `*Fns.ts` files
- `Result<T>` for fallible operations
- Branded shape types
- `.js` extensions for ESM
- Layer 2 for topology/io features
