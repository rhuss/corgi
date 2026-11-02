import { test, expect } from "bun:test";
import * as turns from "./turns";

/** A passage of `text` from `start` to `end` ms. */
const p = (text: string, start: number, end: number, extra: { capped?: boolean; dash?: boolean } = {}) => ({
  text,
  speech_start: start,
  speech_end: end,
  capped: extra.capped ?? false,
  dash: extra.dash ?? false,
});

test("speakerDash strips a leading dash of any kind", () => {
  for (const d of ["-", "–", "—"]) {
    expect(turns.speakerDash(`${d} Sure, go ahead.`)).toEqual({ text: "Sure, go ahead.", dash: true });
    expect(turns.speakerDash(`${d}\tNext`)).toEqual({ text: "Next", dash: true });
    expect(turns.speakerDash(d)).toEqual({ text: "", dash: true });
    expect(turns.speakerDash(` ${d} `)).toEqual({ text: "", dash: true });
  }
});

test("speakerDash leaves other dashes as text", () => {
  expect(turns.speakerDash("well - maybe")).toEqual({ text: "well - maybe", dash: false });
  expect(turns.speakerDash("a — b")).toEqual({ text: "a — b", dash: false });
  expect(turns.speakerDash("-5 degrees")).toEqual({ text: "-5 degrees", dash: false });
  expect(turns.speakerDash("--flag")).toEqual({ text: "--flag", dash: false });
  expect(turns.speakerDash("—quote")).toEqual({ text: "—quote", dash: false });
});

test("the first passage starts a contribution", () => {
  const t = new turns.Turns(2);
  expect(t.next(p("one", 1000, 2000))).toBe(true);
  expect(t.contributions).toEqual([{ started_at: 1000, texts: ["one"] }]);
});

test("a gap longer than pause_break starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 3000, 4000))).toBe(false); // exactly 2 s
  expect(t.next(p("three", 6001, 7000))).toBe(true); // 2.001 s
  expect(t.next(p("four", 7500, 8000))).toBe(false);
  expect(t.contributions).toEqual([
    { started_at: 0, texts: ["one", "two"] },
    { started_at: 6001, texts: ["three", "four"] },
  ]);
});

test("a passage after a capped one continues its contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("long", 0, 10_000, { capped: true }));
  expect(t.next(p("rest", 20_000, 21_000))).toBe(false);
  // The gap rule applies again after an uncapped passage.
  expect(t.next(p("later", 30_000, 31_000))).toBe(true);
});

test("a speaker dash starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 1100, 2000, { dash: true }))).toBe(true);
  // Even right after a capped passage.
  t.next(p("long", 2100, 12_100, { capped: true }));
  expect(t.next(p("reply", 12_100, 13_000, { dash: true }))).toBe(true);
  expect(t.contributions.map(c => c.texts)).toEqual([["one"], ["two", "long"], ["reply"]]);
});

test("reset makes the next passage start a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  t.reset();
  expect(t.next(p("two", 1100, 2000))).toBe(true);
  expect(t.next(p("three", 2100, 3000))).toBe(false);
  // Reset also overrides a capped previous passage.
  t.next(p("long", 3100, 13_100, { capped: true }));
  t.reset();
  expect(t.next(p("after", 13_100, 14_000))).toBe(true);
  expect(t.contributions).toEqual([
    { started_at: 0, texts: ["one"] },
    { started_at: 1100, texts: ["two", "three", "long"] },
    { started_at: 13_100, texts: ["after"] },
  ]);
});

test("pause_break is in seconds", () => {
  const t = new turns.Turns(0.5);
  expect(t.pause_break).toBe(0.5);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 1500, 2000))).toBe(false);
  expect(t.next(p("three", 2501, 3000))).toBe(true);
});
