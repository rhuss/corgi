//! One character atlas for every mood and 2-degree turn; shared by Bun and the browser.
import * as moonlander from "./moonlander";
import type { Rgb } from "../palette";

export const step = 2;
export type Bits = 2 | 4 | 8;
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placement extends Rect {
  sx: number;
  sy: number;
}
export interface Atlas {
  cw: number;
  ch: number;
  side: number;
  cols: number;
  width: number;
  height: number;
  turns: number;
  tiles: { glyph: string; first: number; count: number }[];
}
export function layout(cw: number, ch: number): Atlas {
  const side = Math.ceil(Math.hypot(cw, ch)) + 4,
    turns = 180 / step + 1;
  let count = 0;
  const tiles = [...new Set(Object.values(moonlander.FACE).flatMap(face => [...face]))].map(glyph => {
    const tile = { glyph, first: count, count: glyph === "•" ? 1 : turns };
    count += tile.count;
    return tile;
  });
  const cols = Math.ceil(Math.sqrt(count));
  return { cw, ch, side, cols, width: cols * side, height: Math.ceil(count / cols) * side, turns, tiles };
}
/** The rasterizer supplies alpha tiles; packing and encoding stay in TypeScript. */
export function pack(atlas: Atlas, tiles: Uint8Array): Uint8Array {
  const count = atlas.tiles.reduce((n, tile) => n + tile.count, 0),
    { side, cols, width, height } = atlas;
  if (tiles.length !== count * side * side) throw Error("BadFaceTiles");
  const alpha = new Uint8Array(width * height);
  for (let tile = 0; tile < count; tile++)
    for (let row = 0; row < side; row++)
      alpha.set(
        tiles.subarray((tile * side + row) * side, (tile * side + row + 1) * side),
        (Math.floor(tile / cols) * side + row) * width + (tile % cols) * side,
      );
  return alpha;
}
export interface Masks {
  cw: number;
  ch: number;
  side: number;
  glyphs: Record<string, string>;
}
/** The binary rotates embedded font masks; no font renderer is needed at runtime. */
export function rasterize(atlas: Atlas, masks: Masks): Uint8Array {
  const count = atlas.tiles.reduce((n, tile) => n + tile.count, 0),
    tiles = new Uint8Array(count * atlas.side ** 2);
  for (const item of atlas.tiles) {
    const runs = Uint8Array.from(atob(masks.glyphs[item.glyph]), c => c.charCodeAt(0)),
      source = new Uint8Array(masks.side ** 2);
    let offset = 0;
    for (let i = 0; i < runs.length; i += 2) {
      source.fill(runs[i + 1], offset, offset + runs[i]);
      offset += runs[i];
    }
    const sample = (x: number, y: number) => {
      const ix = Math.floor(x),
        iy = Math.floor(y),
        u = x - ix,
        v = y - iy;
      if (ix < 0 || iy < 0 || ix + 1 >= masks.side || iy + 1 >= masks.side) return 0;
      const i = iy * masks.side + ix;
      return (
        (source[i] * (1 - u) + source[i + 1] * u) * (1 - v) +
        (source[i + masks.side] * (1 - u) + source[i + masks.side + 1] * u) * v
      );
    };
    for (let turn = 0; turn < item.count; turn++) {
      const angle = item.count === 1 ? 0 : ((turn * step - 90) * Math.PI) / 180,
        cos = Math.cos(angle),
        sin = Math.sin(angle);
      for (let y = 0; y < atlas.side; y++)
        for (let x = 0; x < atlas.side; x++) {
          let alpha = 0;
          for (let sy = 0; sy < 2; sy++)
            for (let sx = 0; sx < 2; sx++) {
              const dx = x + 0.25 + sx * 0.5 - atlas.side / 2,
                dy = y + 0.25 + sy * 0.5 - atlas.side / 2;
              alpha += sample(
                ((dx * cos + dy * sin) * masks.cw) / atlas.cw + masks.side / 2 - 0.5,
                ((-dx * sin + dy * cos) * masks.ch) / atlas.ch + masks.side / 2 - 0.5,
              );
            }
          tiles[((item.first + turn) * atlas.side + y) * atlas.side + x] = Math.round(alpha / 4);
        }
    }
  }
  return pack(atlas, tiles);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(
    [...type].map(c => c.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  let crc = ~0;
  for (const b of out.subarray(4, 8 + data.length)) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  dv.setUint32(8 + data.length, ~crc >>> 0);
  return out;
}
export type Compress = (raw: Uint8Array) => Promise<Uint8Array> | Uint8Array;
async function compress(raw: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob([Uint8Array.from(raw)]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
}
/** A single RGB color, palette alpha, packed 2/4/8-bit indices, and filter 0. */
export async function encode(
  atlas: Pick<Atlas, "width" | "height">,
  alpha: Uint8Array,
  color: Rgb,
  bits: Bits = 4,
  deflate: Compress = compress,
): Promise<Uint8Array> {
  return png(atlas, color, bits, await deflate(scanlines(atlas, alpha, bits)));
}
/** The image data `encode` deflates: one palette index per pixel. */
export function scanlines(atlas: Pick<Atlas, "width" | "height">, alpha: Uint8Array, bits: Bits): Uint8Array {
  const { width, height } = atlas,
    levels = (1 << bits) - 1,
    stride = Math.ceil((width * bits) / 8);
  if (alpha.length !== width * height) throw Error("BadFaceAtlas");
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = Math.round((alpha[y * width + x] * levels) / 255);
      raw[y * (stride + 1) + 1 + ((x * bits) >> 3)] |= a << (8 - bits - ((x * bits) & 7));
    }
  return raw;
}
/** Wraps deflated `scanlines` in a PNG. */
export function png(atlas: Pick<Atlas, "width" | "height">, color: Rgb, bits: Bits, idat: Uint8Array): Uint8Array {
  const { width, height } = atlas,
    levels = (1 << bits) - 1;
  const plte = new Uint8Array((levels + 1) * 3),
    trns = new Uint8Array(levels + 1);
  for (let i = 0; i <= levels; i++) {
    plte.set(color, i * 3);
    trns[i] = Math.round((i * 255) / levels);
  }
  const ihdr = new Uint8Array(13),
    dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([bits, 3, 0, 0, 0], 8);
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("tRNS", trns),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    w = Math.min(a.x + a.w, b.x + b.w) - x,
    h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export function subtract(a: Rect, b: Rect): Rect[] {
  const cut = intersect(a, b);
  if (!cut) return [a];
  return [
    { x: a.x, y: a.y, w: a.w, h: cut.y - a.y },
    { x: a.x, y: cut.y + cut.h, w: a.w, h: a.y + a.h - cut.y - cut.h },
    { x: a.x, y: cut.y, w: cut.x - a.x, h: cut.h },
    { x: cut.x + cut.w, y: cut.y, w: a.x + a.w - cut.x - cut.w, h: cut.h },
  ].filter(r => r.w > 0 && r.h > 0);
}
/** The ship's origin on whole pixels, where the hull image sits and the face
 * with it; on the hull's whole dots (`onDots`) when the hull is braille. */
export function origin(engine: moonlander.Engine, cw: number, ch: number, onDots: boolean): [number, number] {
  const L = engine.lander!,
    [x, y] = onDots ? engine.shipAt(L, engine.cameraY) : [L.x, (L.y - engine.cameraY) / engine.world.K];
  return [Math.round((x * cw) / 2), Math.round((y * ch) / 4)];
}
/** All destinations and source crops are whole pixels, as Kitty requires.
 * The face turns to `a`, the angle the hull is drawn at, and each glyph keeps
 * a whole-pixel offset from the hull's origin for that angle, so the face and
 * the hull move as one piece. */
export function placements(
  engine: moonlander.Engine,
  atlas: Atlas,
  occludes: Rect[] = [],
  onDots = true,
  a = engine.lander?.a ?? 0,
): Placement[] {
  const L = engine.lander,
    face = engine.face();
  if (!L || !face) return [];
  const { cw, ch, side, cols, turns } = atlas,
    cos = Math.cos(a),
    sin = Math.sin(a),
    glyphs = [...face];
  const turn = moonlander.clamp(Math.round(((a * 180) / Math.PI + 90) / step), 0, turns - 1);
  const [px, py] = origin(engine, cw, ch, onDots),
    fx = (-moonlander.SHIP.face * sin * cw) / 2,
    fy = (moonlander.SHIP.face * cos * ch) / (4 * engine.world.K);
  const bounds = { x: 0, y: 0, w: engine.world.cols * cw, h: engine.world.rows * ch };
  const hidden = occludes.map(r => ({
    x: Math.floor(r.x * cw),
    y: Math.floor(r.y * ch),
    w: Math.ceil(r.w * cw),
    h: Math.ceil(r.h * ch),
  }));
  const out: Placement[] = [];
  for (const shift of [0, -bounds.w, bounds.w])
    glyphs.forEach((glyph, k) => {
      const first = atlas.tiles.find(tile => tile.glyph === glyph)!,
        tile = first.first + (first.count === 1 ? 0 : turn);
      const along = (k - glyphs.length / 2 + 0.5) * cw,
        x = px + Math.round(fx + along * cos - side / 2) + shift,
        y = py + Math.round(fy + along * sin - side / 2);
      const clip = intersect({ x, y, w: side, h: side }, bounds);
      if (!clip) return;
      let pieces = [clip];
      for (const r of hidden) pieces = pieces.flatMap(piece => subtract(piece, r));
      for (const piece of pieces)
        out.push({
          ...piece,
          sx: (tile % cols) * side + piece.x - x,
          sy: Math.floor(tile / cols) * side + piece.y - y,
        });
    });
  return out;
}
