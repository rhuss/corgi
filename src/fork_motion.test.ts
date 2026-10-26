import { test, expect } from "bun:test";
import { inflateSync } from "node:zlib";
import * as f from "./fork_motion";
import { colors } from "./palette";
const hero = { motion: { start: 0, cell: { width: 18, height: 40 } } };
test("the spring overshoots, then settles on its end", () => {
  expect(f.spring(0)).toBe(0);
  expect(f.spring(1)).toBe(1);
  const peak = Math.max(...Array.from({ length: 100 }, (_, i) => f.spring(i / 100)));
  expect(peak).toBeGreaterThan(1.05);
  expect(peak).toBeLessThan(1.25);
});
test("without motion the hero is at rest; with it, blank until it starts", () => {
  const rest = f.frameAt({}, 0);
  expect(rest.placed).toBe(0);
  expect(rest.text.at(-1)?.glyph).toBe("copy");
  expect(f.frameAt(hero, -1).len).toBe(0);
  expect(f.moving(hero, 639)).toBe(true);
  expect(f.moving(hero, 640)).toBe(false);
  expect(f.frameAt(hero, 640).len).toBe(rest.len);
  expect(f.frameAt(hero, 640).placed).toBe(0);
});
test("the node leads the growing line, then the branches lift apart", () => {
  let last = -Infinity;
  for (let t = 0; t < 197; t += 10) {
    const frame = f.frameAt(hero, t);
    expect(frame.placed).toBe(1);
    expect(frame.placements[0].x).toBeGreaterThanOrEqual(last);
    last = frame.placements[0].x;
  }
  const early = f.frameAt(hero, 347),
    late = f.frameAt(hero, 467);
  expect(early.placed).toBe(4);
  expect(late.placements[0].y).toBeLessThan(early.placements[0].y);
  expect(late.placements[1].crop!.h).toBeGreaterThan(early.placements[1].crop!.h);
  expect(late.placements[0].image !== early.placements[0].image || late.placements[0].image === 730108).toBe(true);
});
test("placements land inside their anchor cell, and only while moving", () => {
  for (let t = 0; t <= 640; t += 7) {
    const drawn = f.draw(30, 3, { ...hero, glyphs: true }, t);
    for (const m of drawn.matchAll(/,X=(\d+),Y=(\d+)/g)) {
      expect(Number(m[1])).toBeLessThan(18);
      expect(Number(m[2])).toBeLessThan(40);
    }
    if (t >= 640) expect(drawn).not.toContain("a=p");
  }
});
test("the hero at rest is text: node glyphs where the host draws them, dots elsewhere", () => {
  const native = f.draw(0, 0, { glyphs: true }, 0),
    fallback = f.draw(0, 0, {}, 0);
  expect(native.split("\uf5f2").length - 1).toBe(2);
  expect(native).not.toContain("\x1b_G");
  expect(fallback.split("●").length - 1).toBe(2);
  expect(fallback).not.toContain("\uf5f2");
});
function decode(png: Buffer) {
  const chunks: Record<string, Buffer[]> = {};
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at),
      type = png.toString("latin1", at + 4, at + 8);
    (chunks[type] ??= []).push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const w = chunks.IHDR[0].readUInt32BE(0),
    h = chunks.IHDR[0].readUInt32BE(4),
    rows = inflateSync(Buffer.concat(chunks.IDAT)),
    pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = rows[y * (w + 1) + 1 + x];
      chunks.PLTE[0].copy(pixels, (y * w + x) * 4, i * 3, i * 3 + 3);
      pixels[(y * w + x) * 4 + 3] = chunks.tRNS[0][i];
    }
  return { w, h, pixels };
}
test("images go out as PNG, once each, and unpack to their pixels", () => {
  const sent = f.upload({ width: 9, height: 20 });
  expect(sent.split("a=t,t=d,f=100,").length - 1).toBe(16);
  const png = decode(Buffer.from(sent.slice(sent.indexOf(";") + 1, sent.indexOf("\x1b\\")), "base64"));
  expect([png.w, png.h]).toEqual([9, 20]);
  const center = (10 * 9 + 4) * 4;
  expect([...png.pixels.subarray(center, center + 3)]).toEqual(colors.muted);
  expect(png.pixels[center + 3]).toBe(255);
  expect(png.pixels[3]).toBe(0);
});
test("large cells never ask the terminal to inflate zlib data", () => {
  // Ghostty 1.3.1 crashes inflating o=z images over its 64 KiB window.
  const sent = f.upload({ width: 22, height: 46 });
  expect(sent).not.toContain("o=z");
  expect(sent.split("a=t,t=d,f=100,").length - 1).toBe(16);
});
