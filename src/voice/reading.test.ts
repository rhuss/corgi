import { test, expect } from "bun:test";
import { Reading, clock, wrap } from "./reading";
import type { Contribution } from "./turns";

const at = (h: number, m: number, s: number) => new Date(2026, 10, 2, h, m, s).getTime();

test("each block is its start time, then its passages wrapped to the width", () => {
  const contributions: Contribution[] = [
    { started_at: at(14, 2, 31), texts: ["Okay, so let's go over the plan for today.", "First the release notes."] },
    { started_at: at(14, 2, 40), texts: ["Sounds good."] },
  ];
  const lines = new Reading().lines(contributions, 24);
  expect(lines.map(l => [l.kind, l.text])).toEqual([
    ["time", "14:02:31"],
    ["text", "Okay, so let's go over"],
    ["text", "the plan for today."],
    // Passages run on in one paragraph.
    ["text", "First the release"],
    ["text", "notes."],
    ["gap", ""],
    ["time", "14:02:40"],
    ["text", "Sounds good."],
  ]);
  // The gutter takes two cells.
  expect(lines.every(l => l.text.length <= 22)).toBe(true);
});

test("gutter colors alternate from block to block", () => {
  const contributions = Array.from({ length: 4 }, (_, i) => ({ started_at: at(9, 0, i), texts: [`block ${i}`] }));
  const bars = new Reading()
    .lines(contributions, 40)
    .filter(l => l.kind === "time")
    .map(l => l.bar);
  expect(bars).toEqual(["accent", "warm", "accent", "warm"]);
});

test("a block that grows is drawn again; the others are kept", () => {
  const reading = new Reading(),
    contributions: Contribution[] = [
      { started_at: at(10, 0, 0), texts: ["one"] },
      { started_at: at(10, 0, 5), texts: ["two"] },
    ];
  reading.lines(contributions, 40);
  const [first, second] = [reading.block(0), reading.block(1)];
  contributions[1].texts.push("more");
  const lines = reading.lines(contributions, 40);
  expect(reading.block(0)).toBe(first!);
  expect(reading.block(1)).not.toBe(second!);
  expect(lines.at(-1)?.text).toBe("two more");
  // Another width draws every block again.
  reading.lines(contributions, 30);
  expect(reading.block(0)).not.toBe(first!);
});

test("with 500 blocks, a passage added to the last redraws only that block", () => {
  const reading = new Reading(),
    contributions: Contribution[] = Array.from({ length: 500 }, (_, i) => ({
      started_at: at(8, 0, 0) + i * 10_000,
      texts: [`passage number ${i} with a few words in it`],
    }));
  reading.lines(contributions, 60);
  const before = contributions.map((_, i) => reading.block(i));
  contributions[499].texts.push("and one more");
  reading.lines(contributions, 60);
  for (let i = 0; i < 499; i++) expect(reading.block(i)).toBe(before[i]!);
  expect(reading.block(499)).not.toBe(before[499]!);
});

test("a new recording's contributions start a fresh cache", () => {
  const reading = new Reading();
  reading.lines([{ started_at: 0, texts: ["old"] }], 40);
  const lines = reading.lines([{ started_at: 0, texts: ["new"] }], 40);
  expect(lines.at(-1)?.text).toBe("new");
});

test("clock and wrap", () => {
  expect(clock(at(7, 5, 9))).toBe("07:05:09");
  expect(wrap("a bb ccc dddd", 6)).toEqual(["a bb", "ccc", "dddd"]);
});
