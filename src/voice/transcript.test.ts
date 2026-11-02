import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as transcript from "./transcript";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-transcript-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `passages` (text, starts_contribution) to `file` in one recording. */
function record(file: string, passages: [string, boolean][]): string {
  const out = transcript.TranscriptFile.open(file);
  for (const [text, starts] of passages) out.write(text, starts);
  out.close();
  return fs.readFileSync(file, "utf8");
}

test("a new file starts without a blank line and separates contributions with one", () => {
  const file = path.join(dir, "t.txt");
  expect(
    record(file, [
      ["Okay, so let's go over the plan for today.", true],
      ["First the release notes.", false],
      ["Sounds good.", true],
      ["Sure, go ahead.", true],
    ]),
  ).toBe("Okay, so let's go over the plan for today.\nFirst the release notes.\n\nSounds good.\n\nSure, go ahead.\n");
});

test("appending to a file adds one blank line after its text", () => {
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "earlier\n");
  expect(record(file, [["now", true]])).toBe("earlier\n\nnow\n");
});

test("appending to a file without a final line break adds it first", () => {
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "earlier");
  expect(
    record(file, [
      ["now", true],
      ["more", false],
    ]),
  ).toBe("earlier\n\nnow\nmore\n");
});

test("appending to a file ending in a blank line reuses it", () => {
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "earlier\n\n");
  expect(record(file, [["now", true]])).toBe("earlier\n\nnow\n");
  expect(record(file, [["again", true]])).toBe("earlier\n\nnow\n\nagain\n");
});

test("a blank line in Windows line endings counts as the blank line", () => {
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "earlier\r\n\r\n");
  expect(record(file, [["now", true]])).toBe("earlier\r\n\r\nnow\n");
});

test("an empty existing file is written like a new one", () => {
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "");
  expect(record(file, [["first", true]])).toBe("first\n");
});

test("new files are private and missing folders are created", () => {
  const file = path.join(dir, "a", "b", "t.txt");
  record(file, [["x", true]]);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(dir, "a", "b")).mode & 0o777).toBe(0o700);
});

test("open on a folder throws with the OS message", () => {
  expect(() => transcript.TranscriptFile.open(dir)).toThrow(/EISDIR|directory/i);
});

test("close twice is harmless and writes after close throw", () => {
  const out = transcript.TranscriptFile.open(path.join(dir, "t.txt"));
  out.close();
  out.close();
  expect(() => out.write("late", true)).toThrow();
});

test("resolve keeps relative names inside the folder", () => {
  const folder = path.join(dir, "transcripts");
  expect(transcript.resolve("  call.txt  ", folder, "/home/me")).toEqual({ path: path.join(folder, "call.txt") });
  expect(transcript.resolve("notes", folder, "/home/me")).toEqual({ path: path.join(folder, "notes") });
  expect(transcript.resolve("a/b/c.txt", folder, "/home/me")).toEqual({ path: path.join(folder, "a", "b", "c.txt") });
  expect(transcript.resolve("a/../b.txt", folder, "/home/me")).toEqual({ path: path.join(folder, "b.txt") });
  expect(transcript.resolve("..notes.txt", folder, "/home/me")).toEqual({ path: path.join(folder, "..notes.txt") });
  const refused = { error: "stays inside the transcript folder: remove .." };
  expect(transcript.resolve("../x.txt", folder, "/home/me")).toEqual(refused);
  expect(transcript.resolve("a/../../x.txt", folder, "/home/me")).toEqual(refused);
  expect(transcript.resolve("..", folder, "/home/me")).toEqual(refused);
});

test("resolve uses home and absolute names as given", () => {
  expect(transcript.resolve("~/calls/x.txt", "/data", "/home/me")).toEqual({ path: "/home/me/calls/x.txt" });
  expect(transcript.resolve("/tmp/x.txt", "/data", "/home/me")).toEqual({ path: "/tmp/x.txt" });
  expect(transcript.resolve("/tmp/a/../x.txt", "/data", "/home/me")).toEqual({ path: "/tmp/x.txt" });
});

test("resolve refuses empty names", () => {
  expect(transcript.resolve("", "/data", "/home/me")).toEqual({ error: "name is empty" });
  expect(transcript.resolve("   ", "/data", "/home/me")).toEqual({ error: "name is empty" });
});

test("exists reports existing files", () => {
  const file = path.join(dir, "t.txt");
  expect(transcript.exists(file)).toBe(false);
  fs.writeFileSync(file, "x");
  expect(transcript.exists(file)).toBe(true);
});

test("the default name is the local time, zero padded", () => {
  expect(transcript.defaultName(new Date(2026, 0, 2, 3, 4, 5))).toBe("transcript-2026-01-02T03-04-05.txt");
  expect(transcript.defaultName(new Date(2026, 10, 22, 13, 45, 59))).toBe("transcript-2026-11-22T13-45-59.txt");
});
