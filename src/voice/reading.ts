//! The reading view's lines: one block per contribution, its start time and
//! then its text wrapped to the window, behind a gutter bar whose color
//! alternates from block to block. Blocks are kept between frames, so a long
//! recording redraws only the block that grew.
import type * as palette from "../palette";
import { displayWidth } from "../text";
import type { Contribution } from "./turns";

/** One screen line: its gutter's color (null for the gap between blocks), and
 * whether it is a block's start time or its text. */
export type Line = { bar: palette.Token | null; kind: "time" | "text" | "gap"; text: string };

/** The two gutter colors, readable on light and dark themes. */
export const bars: palette.Token[] = ["accent", "warm"];

/** A local wall-clock time, as 14:02:31. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}
/** `text` in lines of at most `width` cells, broken between words, and
 * inside a word only when it is wider than a line (as text without spaces). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" "))
    for (const piece of pieces(word, width)) {
      if (line && displayWidth(line) + 1 + displayWidth(piece) > width) {
        out.push(line);
        line = piece;
      } else line = line ? `${line} ${piece}` : piece;
    }
  return line ? [...out, line] : out;
}
/** `word` cut into pieces of at most `width` cells. */
function pieces(word: string, width: number): string[] {
  if (displayWidth(word) <= width) return [word];
  const out: string[] = [];
  let piece = "",
    cells = 0;
  for (const ch of word) {
    const w = displayWidth(ch);
    if (piece && cells + w > width) {
      out.push(piece);
      piece = "";
      cells = 0;
    }
    piece += ch;
    cells += w;
  }
  return piece ? [...out, piece] : out;
}
/** Blocks drawn for a width; a block is drawn again when its passages or the width change. */
type Block = { texts: number; width: number; lines: Line[] };

export class Reading {
  private source: Contribution[] | null = null;
  private blocks: Block[] = [];
  /** The lines of `contributions` for a window `width` cells wide, the gutter included. */
  lines(contributions: Contribution[], width: number): Line[] {
    if (this.source !== contributions) {
      this.source = contributions;
      this.blocks = [];
    }
    this.blocks.length = Math.min(this.blocks.length, contributions.length);
    const out: Line[] = [];
    contributions.forEach((c, i) => {
      let b = this.blocks[i];
      if (!b || b.texts !== c.texts.length || b.width !== width) {
        b = this.blocks[i] = { texts: c.texts.length, width, lines: render(c, i, width) };
      }
      if (i) out.push({ bar: null, kind: "gap", text: "" });
      for (const l of b.lines) out.push(l);
    });
    return out;
  }
  /** The lines kept for block `i`, as last drawn. */
  block(i: number): Line[] | undefined {
    return this.blocks[i]?.lines;
  }
}
function render(c: Contribution, i: number, width: number): Line[] {
  const bar = bars[i % bars.length];
  return [
    { bar, kind: "time", text: clock(c.started_at) },
    ...wrap(c.texts.join(" "), Math.max(1, width - 2)).map(text => ({ bar, kind: "text" as const, text })),
  ];
}
