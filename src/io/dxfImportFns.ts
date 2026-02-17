/**
 * DXF file import -- parse ASCII DXF entities into OCCT wires.
 */

import { getKernel } from '../kernel/index.js';
import type { Wire } from '../core/shapeTypes.js';
import { createWire } from '../core/shapeTypes.js';
import { type Result, ok, err } from '../core/result.js';
import { ioError, BrepErrorCode } from '../core/errors.js';

export interface DXFImportOptions {
  readonly layer?: string;
}

interface DXFEntity {
  readonly type: string;
  readonly layer: string;
  readonly data: Map<number, string>;
}

// ---------------------------------------------------------------------------
// DXF Parser
// ---------------------------------------------------------------------------

function parseEntities(text: string): DXFEntity[] {
  const lines = text.split(/\r?\n/);
  const entities: DXFEntity[] = [];
  let inEntities = false;
  let current: { type: string; layer: string; data: Map<number, string> } | undefined;

  for (let i = 0; i < lines.length - 1; i += 2) {
    const codeLine = lines[i];
    const valueLine = lines[i + 1];
    if (codeLine === undefined || valueLine === undefined) continue;
    const code = parseInt(codeLine.trim(), 10);
    const value = valueLine.trim();

    if (isNaN(code)) continue;

    if (code === 2 && value === 'ENTITIES') {
      inEntities = true;
      continue;
    }

    if (!inEntities) continue;

    if (code === 0) {
      if (value === 'ENDSEC' || value === 'EOF') {
        if (current) entities.push(current);
        break;
      }

      if (current) entities.push(current);
      current = { type: value, layer: '0', data: new Map() };
      continue;
    }

    if (current) {
      if (code === 8) {
        current.layer = value;
      } else {
        current.data.set(code, value);
      }
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Entity -> Edge conversion
// ---------------------------------------------------------------------------

function getNum(data: Map<number, string>, code: number, fallback = 0): number {
  const v = data.get(code);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCCT types
function entityToEdge(entity: DXFEntity, oc: any): unknown {
  const { type, data } = entity;

  if (type === 'LINE') {
    const p1 = new oc.gp_Pnt_3(getNum(data, 10), getNum(data, 20), getNum(data, 30));
    const p2 = new oc.gp_Pnt_3(getNum(data, 11), getNum(data, 21), getNum(data, 31));
    try {
      const builder = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
      const edge = builder.Edge();
      builder.delete();
      return edge;
    } finally {
      p1.delete();
      p2.delete();
    }
  }

  if (type === 'CIRCLE') {
    const cx = getNum(data, 10);
    const cy = getNum(data, 20);
    const cz = getNum(data, 30);
    const radius = getNum(data, 40);
    const center = new oc.gp_Pnt_3(cx, cy, cz);
    const dir = new oc.gp_Dir_4(0, 0, 1);
    const ax2 = new oc.gp_Ax2_3(center, dir);
    const circ = new oc.gp_Circ_2(ax2, radius);
    try {
      const builder = new oc.BRepBuilderAPI_MakeEdge_8(circ);
      const edge = builder.Edge();
      builder.delete();
      return edge;
    } finally {
      center.delete();
      dir.delete();
      ax2.delete();
      circ.delete();
    }
  }

  if (type === 'ARC') {
    const cx = getNum(data, 10);
    const cy = getNum(data, 20);
    const cz = getNum(data, 30);
    const radius = getNum(data, 40);
    const startAngleDeg = getNum(data, 50);
    const endAngleDeg = getNum(data, 51);
    const startAngle = (startAngleDeg * Math.PI) / 180;
    const endAngle = (endAngleDeg * Math.PI) / 180;
    const center = new oc.gp_Pnt_3(cx, cy, cz);
    const dir = new oc.gp_Dir_4(0, 0, 1);
    const ax2 = new oc.gp_Ax2_3(center, dir);
    const circ = new oc.gp_Circ_2(ax2, radius);
    try {
      const builder = new oc.BRepBuilderAPI_MakeEdge_9(circ, startAngle, endAngle);
      const edge = builder.Edge();
      builder.delete();
      return edge;
    } finally {
      center.delete();
      dir.delete();
      ax2.delete();
      circ.delete();
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a DXF file from a Blob, returning OCCT wires.
 *
 * Parses ASCII DXF LINE, CIRCLE, and ARC entities.
 * Edges are assembled into wires using `BRepBuilderAPI_MakeWire`.
 *
 * @param blob - A Blob containing ASCII DXF data.
 * @param options - Optional import settings (layer filter).
 * @returns A `Result` wrapping an array of wires.
 */
export async function importDXF(blob: Blob, options?: DXFImportOptions): Promise<Result<Wire[]>> {
  const oc = getKernel().oc;

  let text: string;
  try {
    text = await blob.text();
  } catch (cause: unknown) {
    return err(ioError(BrepErrorCode.DXF_IMPORT_FAILED, 'Failed to read DXF blob', cause));
  }

  const allEntities = parseEntities(text);
  const entities =
    options?.layer !== undefined
      ? allEntities.filter((e) => e.layer === options.layer)
      : allEntities;

  if (entities.length === 0) {
    return ok([]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCCT edge types
  const edges: Array<any> = [];
  try {
    for (const entity of entities) {
      const edge = entityToEdge(entity, oc);
      if (edge !== undefined) {
        edges.push(edge);
      }
    }

    if (edges.length === 0) {
      return ok([]);
    }

    const wireBuilder = new oc.BRepBuilderAPI_MakeWire_1();
    try {
      for (const edge of edges) {
        wireBuilder.Add_1(edge);
      }

      if (wireBuilder.IsDone()) {
        const wire = wireBuilder.Wire();
        return ok([createWire(wire)]);
      }

      return err(
        ioError(BrepErrorCode.DXF_IMPORT_FAILED, 'Failed to assemble DXF edges into a wire')
      );
    } finally {
      wireBuilder.delete();
    }
  } catch (cause: unknown) {
    return err(
      ioError(BrepErrorCode.DXF_IMPORT_FAILED, 'Failed to convert DXF entities to geometry', cause)
    );
  } finally {
    for (const edge of edges) {
      edge.delete();
    }
  }
}
