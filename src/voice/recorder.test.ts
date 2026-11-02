import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "./recorder";
import type { Tuning } from "./tuning";
import type { Utterance } from "./session";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "corgi-recorder-"));
  dirs.push(d);
  return d;
}
function setup() {
  let now = 1000;
  const calls: string[] = [],
    lines: string[] = [],
    tuning = {
      pause_break: 2,
      begin: () => void calls.push("begin"),
      end: () => void calls.push("end"),
    } as unknown as Tuning,
    recorder = new Recorder({ tuning, now: () => now, log: line => lines.push(line) });
  return { recorder, calls, lines, tick: (ms: number) => (now += ms) };
}
let next_id = 1;
/** A passage whose speech ran from `start` to `end` ms. */
function passage(start: number, end: number, cut_at: number | null = null, continues = false): Utterance {
  return {
    id: next_id++,
    // Pre-roll comes before the speech; it must not count anywhere.
    captured_at: start - 300,
    duration: (end - start) / 1000,
    status: "transcribing",
    text: null,
    reason: null,
    timings: {},
    record: null,
    untyped: null,
    maybe_typed: false,
    speech_start: start,
    speech_end: end,
    cut_at,
    continues,
  };
}

test("a recording writes passages as they come and closes on stop", async () => {
  const { recorder, calls, lines } = setup(),
    path = join(folder(), "t.txt");
  expect(recorder.start(path)).toEqual({ path });
  expect(recorder.current?.state).toBe("running");
  expect(calls).toEqual(["begin"]);
  const a = passage(0, 1000),
    b = passage(1500, 2500),
    c = passage(6000, 7000);
  for (const u of [a, b, c]) recorder.claim(u);
  expect(a.record).toBe(recorder.current);
  expect(recorder.write(a, "First sentence.")).toBe(true);
  // Synced as it comes, not on stop.
  expect(readFileSync(path, "utf8")).toBe("First sentence.\n");
  recorder.write(b, "Second one.");
  recorder.write(c, "After a long pause.");
  const contributions = recorder.current!.turns.contributions;
  expect(contributions.map(t => t.texts)).toEqual([["First sentence.", "Second one."], ["After a long pause."]]);
  expect(await recorder.stop()).toEqual({ path, late: 0 });
  expect(recorder.current).toBeNull();
  expect(calls).toEqual(["begin", "end"]);
  expect(readFileSync(path, "utf8")).toBe("First sentence.\nSecond one.\n\nAfter a long pause.\n");
  expect(recorder.notices.map(n => [n.kind, n.text])).toEqual([
    ["info", `recording started: ${path}`],
    ["info", `stopped: ${path}`],
  ]);
  expect(lines[0]).toBe(`recording: started ${path}`);
  expect(lines[1]).toMatch(new RegExp(`^recording: stopped ${path} waited_ms=\\d+ late=0$`));
  // The log names the file, never what was said.
  expect(lines.join("\n")).not.toContain("sentence");
});

test("stop waits for pending passages, and a late one is left out", async () => {
  const { recorder, lines } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const done = passage(0, 1000),
    late = passage(2000, 3000);
  recorder.claim(done);
  recorder.claim(late);
  const stopping = recorder.stop(100);
  // The indicator goes at once.
  expect(recorder.current).toBeNull();
  recorder.write(done, "Made it.");
  expect(await stopping).toEqual({ path, late: 1 });
  expect(recorder.write(late, "Too late.")).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("Made it.\n");
  expect(recorder.notices.at(-1)).toMatchObject({ kind: "error", text: "1 passage did not finish in time" });
  expect(lines.at(-1)).toMatch(/late=1$/);
});

test("stop resolves at once when every pending passage is released", async () => {
  const { recorder } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const a = passage(0, 1000);
  recorder.claim(a);
  const started = performance.now(),
    stopping = recorder.stop(5000);
  recorder.release(a);
  expect(await stopping).toEqual({ path, late: 0 });
  expect(performance.now() - started).toBeLessThan(1000);
});

test("an open failure starts nothing and leaves dictation timing alone", () => {
  const { recorder, calls } = setup(),
    dir = folder();
  mkdirSync(join(dir, "taken"));
  const result = recorder.start(join(dir, "taken"));
  expect(result).toHaveProperty("error");
  expect(recorder.current).toBeNull();
  expect(recorder.error).toBe((result as { error: string }).error);
  expect(calls).toEqual([]);
  const u = passage(0, 1000);
  recorder.claim(u);
  expect(u.record).toBeNull();
});

test("a write failure closes the recording and restores dictation timing", () => {
  const { recorder, calls, lines } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const u = passage(0, 1000);
  recorder.claim(u);
  // A closed descriptor fails the write as a full disk would.
  recorder.current!.file.close();
  expect(recorder.write(u, "Lost words.")).toBe(false);
  expect(recorder.current).toBeNull();
  expect(recorder.error).not.toBeNull();
  expect(calls).toEqual(["begin", "end"]);
  expect(recorder.notices.at(-1)?.kind).toBe("error");
  expect(recorder.notices.at(-1)?.text).toStartWith("recording stopped: ");
  expect(lines.at(-1)).toStartWith(`recording: write failed ${path}: `);
  expect(lines.join("\n")).not.toContain("Lost words");
});

test("a close that fails is reported, and the stop still settles", async () => {
  const { recorder, lines } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  recorder.current!.file.close = () => {
    throw new Error("EIO: i/o error, close");
  };
  expect(await recorder.stop()).toEqual({ path, late: 0 });
  expect(recorder.stopping.size).toBe(0);
  expect(recorder.error).toBe("EIO: i/o error, close");
  expect(recorder.notices.at(-1)).toMatchObject({ kind: "error", text: "recording stopped: EIO: i/o error, close" });
  expect(lines.at(-1)).toBe(`recording: close failed ${path}: EIO: i/o error, close`);
});

test("a stopping recording keeps its passages after a new one starts", async () => {
  const { recorder } = setup(),
    dir = folder(),
    old_path = join(dir, "old.txt"),
    new_path = join(dir, "new.txt");
  recorder.start(old_path);
  const pending = passage(0, 1000);
  recorder.claim(pending);
  const stopping = recorder.stop(1000);
  expect(recorder.start(new_path)).toEqual({ path: new_path });
  const fresh = passage(2000, 3000);
  recorder.claim(fresh);
  recorder.write(fresh, "New recording.");
  recorder.write(pending, "Old recording.");
  expect(await stopping).toEqual({ path: old_path, late: 0 });
  expect(readFileSync(old_path, "utf8")).toBe("Old recording.\n");
  expect(readFileSync(new_path, "utf8")).toBe("New recording.\n");
});

test("pause keeps passages out, and resume starts a contribution", async () => {
  const { recorder, calls, lines } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const a = passage(0, 1000);
  recorder.claim(a);
  recorder.write(a, "Before.");
  recorder.pause();
  expect(recorder.current?.state).toBe("paused");
  const aside = passage(1200, 1500);
  recorder.claim(aside);
  expect(aside.record).toBeNull();
  recorder.resume();
  // A short gap, yet a new contribution after the resume.
  const b = passage(1600, 2000);
  recorder.claim(b);
  recorder.write(b, "After.");
  // Tuning stays in recording mode while paused.
  expect(calls).toEqual(["begin"]);
  await recorder.stop();
  expect(readFileSync(path, "utf8")).toBe("Before.\n\nAfter.\n");
  expect(recorder.notices.map(n => n.text).slice(1, 3)).toEqual(["paused", "resumed"]);
  expect(lines.slice(1, 3)).toEqual([`recording: paused ${path}`, `recording: resumed ${path}`]);
});

test("a passage spoken before the pause and written after the resume continues its contribution", async () => {
  const { recorder, tick } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const a = passage(0, 1000),
    late = passage(1200, 1800);
  recorder.claim(a);
  recorder.claim(late);
  recorder.write(a, "Before.");
  // Paused at 2000 while `late` is still with Whisper; resumed at 5000.
  tick(1000);
  recorder.pause();
  tick(3000);
  recorder.resume();
  recorder.write(late, "Still before.");
  // The first passage spoken after the resume starts one, however short the gap.
  const after = passage(5100, 5500);
  recorder.claim(after);
  recorder.write(after, "After.");
  expect(recorder.current!.turns.contributions.map(c => c.texts)).toEqual([["Before.", "Still before."], ["After."]]);
  await recorder.stop();
  expect(readFileSync(path, "utf8")).toBe("Before.\nStill before.\n\nAfter.\n");
});

test("pause gaps and block times count from the speech, not the pre-roll", () => {
  const { recorder } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  // 2.1 s from the end of `a` to the speech of `b`, but only 1.8 s to its pre-roll.
  const a = passage(0, 1000),
    b = passage(3100, 4000);
  for (const u of [a, b]) recorder.claim(u);
  recorder.write(a, "One.");
  recorder.write(b, "Two.");
  expect(recorder.current!.turns.contributions).toEqual([
    { started_at: 0, texts: ["One."] },
    { started_at: 3100, texts: ["Two."] },
  ]);
});

test("a speaker dash starts a contribution and is not written", async () => {
  const { recorder } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const a = passage(0, 1000),
    b = passage(1100, 2000),
    c = passage(2100, 2500);
  for (const u of [a, b, c]) recorder.claim(u);
  recorder.write(a, "Question?");
  recorder.write(b, "- Answer.");
  expect(recorder.write(c, "-")).toBe(false);
  await recorder.stop();
  expect(readFileSync(path, "utf8")).toBe("Question?\n\nAnswer.\n");
});

test("an existing file is appended to after one blank line", async () => {
  const { recorder } = setup(),
    dir = folder(),
    path = join(dir, "t.txt");
  recorder.start(path);
  const a = passage(0, 1000);
  recorder.claim(a);
  recorder.write(a, "Earlier.");
  await recorder.stop();
  recorder.start(path);
  const b = passage(0, 1000);
  recorder.claim(b);
  recorder.write(b, "Later.");
  await recorder.stop();
  expect(readFileSync(path, "utf8")).toBe("Earlier.\n\nLater.\n");
});

test("a write failure while stopping still logs how long the stop waited", async () => {
  const { recorder, lines } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const r = recorder.current!,
    u = passage(0, 1000);
  recorder.claim(u);
  const stopping = recorder.stop(1000);
  r.file.close();
  recorder.write(u, "Lost.");
  expect(await stopping).toEqual({ path, late: 0 });
  expect(lines.at(-1)).toMatch(new RegExp(`^recording: stopped ${path} waited_ms=\\d+ late=0$`));
  expect(recorder.stopping.size).toBe(0);
});

test("a file still being finished cannot be recorded into again yet", async () => {
  const { recorder } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  const u = passage(0, 1000);
  recorder.claim(u);
  const stopping = recorder.stop(1000);
  expect(recorder.start(path)).toHaveProperty("error");
  recorder.release(u);
  await stopping;
  expect(recorder.start(path)).toEqual({ path });
});

test("finish closes every recording at once and counts what it still waited for", async () => {
  const { recorder, lines } = setup(),
    dir = folder(),
    old_path = join(dir, "old.txt"),
    new_path = join(dir, "new.txt");
  recorder.start(old_path);
  recorder.claim(passage(0, 1000));
  const stopping = recorder.stop(10_000);
  recorder.start(new_path);
  recorder.claim(passage(2000, 3000));
  recorder.claim(passage(3000, 4000));
  const started = performance.now();
  expect(recorder.finish()).toEqual([
    { path: old_path, late: 1 },
    { path: new_path, late: 2 },
  ]);
  expect(recorder.current).toBeNull();
  expect(recorder.stopping.size).toBe(0);
  // The earlier stop ends with it, logged once.
  expect(await stopping).toEqual({ path: old_path, late: 1 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(lines.filter(l => l.startsWith(`recording: stopped ${old_path}`))).toHaveLength(1);
});

test("a refused start says why in the history", async () => {
  const { recorder } = setup(),
    path = join(folder(), "t.txt");
  recorder.start(path);
  recorder.claim(passage(0, 1000));
  void recorder.stop(1000);
  const refused = recorder.start(path);
  expect(refused).toEqual({ error: "this file is still being finished; try again in a moment" });
  expect(recorder.error).toBe("this file is still being finished; try again in a moment");
  expect(recorder.notices.at(-1)).toMatchObject({
    kind: "error",
    text: "recording not started: this file is still being finished; try again in a moment",
  });
  recorder.finish();
});
