import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import * as settings from "./settings";

const dir = mkdtempSync(join(tmpdir(), "corgi-voice-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string) => {
  const at = join(dir, name);
  writeFileSync(at, content);
  return at;
};

test("a missing file gives the defaults without notices", () => {
  expect(settings.read(join(dir, "absent.json"))).toEqual({
    settings: {
      threshold: 44,
      silence: 2.5,
      pre_roll: 0.3,
      post_roll: 1,
      min_speech: 0.2,
      burst: 0.1,
      model: "base.en",
      port: null,
      speech_filter: true,
      device: null,
      transcripts: null,
      recording: { threshold: 20, silence: 1.0, max_chunk: 10, pause_break: 2.0 },
    },
    notices: [],
  });
});

test("valid fields are read", () => {
  const { settings: s, notices } = settings.read(
    file(
      "valid.json",
      JSON.stringify({
        threshold: 60,
        silence: 1.5,
        pre_roll: 0.5,
        post_roll: 1.5,
        min_speech: 0.1,
        burst: 0.05,
        model: "small.en",
        port: 9000,
        speech_filter: false,
        device: "1",
        // Unknown keys, such as the command words of earlier builds, are ignored.
        commands: { submit: ["send", "done"] },
        unknown: true,
      }),
    ),
  );
  expect(notices).toEqual([]);
  expect(s).toEqual({
    threshold: 60,
    silence: 1.5,
    pre_roll: 0.5,
    post_roll: 1.5,
    min_speech: 0.1,
    burst: 0.05,
    model: "small.en",
    port: 9000,
    speech_filter: false,
    device: "1",
    transcripts: null,
    recording: settings.default_recording,
  });
});

test('post-roll is seconds from 0 to 10, or "pause" for the whole pause', () => {
  const post_roll = (value: unknown) => settings.read(file("post_roll.json", JSON.stringify({ post_roll: value })));
  for (const [value, read] of [
    [0, 0],
    [10, 10],
    [1.2, 1.2],
    ["pause", Infinity],
  ] as [unknown, number][])
    expect(post_roll(value)).toEqual({ settings: { ...settings.defaults(), post_roll: read }, notices: [] });
  for (const value of ["Pause", null, -0.1, 10.5, "1"])
    expect(post_roll(value)).toEqual({
      settings: settings.defaults(),
      notices: ['voice.json: "post_roll" must be 0..10 or "pause"; using 1'],
    });
});

test("each invalid field falls back with one notice", () => {
  const { settings: s, notices } = settings.read(
    file(
      "invalid.json",
      JSON.stringify({
        threshold: 101,
        silence: 0.1,
        pre_roll: -1,
        min_speech: 5,
        burst: "short",
        model: "large",
        port: 80,
        speech_filter: "yes",
        device: "",
      }),
    ),
  );
  expect(s).toEqual(settings.defaults());
  expect(notices).toEqual([
    'voice.json: "threshold" must be 0..100; using 44',
    'voice.json: "silence" must be 0.5..10; using 2.5',
    'voice.json: "pre_roll" must be 0..2; using 0.3',
    'voice.json: "min_speech" must be 0.02..2; using 0.2',
    'voice.json: "burst" must be 0.02..1; using 0.1',
    'voice.json: "model" must be tiny.en|base.en|small.en|medium|large-v3-turbo; using "base.en"',
    'voice.json: "port" must be 1024..65535 or null; using null',
    'voice.json: "speech_filter" must be true or false; using true',
    'voice.json: "device" must be a device name or null; using null',
  ]);
});

test("an unreadable file gives the defaults and one notice", () => {
  for (const [name, content] of [
    ["broken.json", "{"],
    ["array.json", "[]"],
    ["big.json", JSON.stringify({ pad: "x".repeat(70 * 1024) })],
  ]) {
    const { settings: s, notices } = settings.read(file(name, content));
    expect(s).toEqual(settings.defaults());
    expect(notices).toHaveLength(1);
  }
});

test("flags override the file for one run", () => {
  const merged = settings.merge(settings.defaults(), { model: "tiny.en", threshold: 30, speech_filter: false });
  expect(merged).toMatchObject({ model: "tiny.en", threshold: 30, speech_filter: false, port: null });
  expect(settings.merge(settings.defaults(), { port: undefined }).port).toBeNull();
  expect(settings.read(file("null_port.json", JSON.stringify({ port: null })))).toEqual({
    settings: settings.defaults(),
    notices: [],
  });
});

test("voice.json lives in the state directory", () => {
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/state";
  try {
    expect(settings.path()).toBe("/state/corgi/voice.json");
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
  }
});

test("transcripts and recording are read", () => {
  for (const transcripts of ["/srv/transcripts", "~/Notes/transcripts"]) {
    const recording = { threshold: 30, silence: 0.8, max_chunk: 20, pause_break: 3 };
    const { settings: s, notices } = settings.read(file("recording.json", JSON.stringify({ transcripts, recording })));
    expect(notices).toEqual([]);
    expect(s).toEqual({ ...settings.defaults(), transcripts, recording });
  }
  const { settings: s, notices } = settings.read(
    file("recording_null.json", JSON.stringify({ recording: { threshold: null, silence: 1.5 } })),
  );
  expect(notices).toEqual([]);
  expect(s.recording).toEqual({ ...settings.default_recording, threshold: null, silence: 1.5 });
});

test("a bad transcripts value falls back to the default with one notice", () => {
  for (const transcripts of ["notes", "./notes", "~notes", "~", "", null, 3, ["/x"]]) {
    const { settings: s, notices } = settings.read(file("transcripts.json", JSON.stringify({ transcripts })));
    expect(s.transcripts).toBeNull();
    expect(notices).toEqual([
      'voice.json: "transcripts" must be an absolute folder or start with ~/; using the default',
    ]);
  }
});

test("each invalid recording field falls back on its own", () => {
  const valid = { threshold: 30, silence: 0.8, max_chunk: 20, pause_break: 3 };
  const cases: [Record<string, unknown>, string][] = [
    [{ threshold: 101 }, 'voice.json: "recording.threshold" must be 0..100; using 20'],
    [{ threshold: 12.5 }, 'voice.json: "recording.threshold" must be 0..100; using 20'],
    [{ silence: 0.1 }, 'voice.json: "recording.silence" must be 0.5..10; using 1'],
    [{ silence: "long" }, 'voice.json: "recording.silence" must be 0.5..10; using 1'],
    [{ max_chunk: 4 }, 'voice.json: "recording.max_chunk" must be 5..30; using 10'],
    [{ max_chunk: 31 }, 'voice.json: "recording.max_chunk" must be 5..30; using 10'],
    [{ pause_break: 0.4 }, 'voice.json: "recording.pause_break" must be 0.5..30; using 2'],
    [{ pause_break: 40 }, 'voice.json: "recording.pause_break" must be 0.5..30; using 2'],
  ];
  for (const [bad, notice] of cases) {
    const [key] = Object.keys(bad) as (keyof settings.RecordingSettings)[];
    const { settings: s, notices } = settings.read(
      file("recording_bad.json", JSON.stringify({ silence: 3, recording: { ...valid, ...bad } })),
    );
    expect(notices).toEqual([notice]);
    expect(s.recording).toEqual({ ...valid, [key]: settings.default_recording[key] });
    // The dictation fields are untouched.
    expect(s.silence).toBe(3);
  }
});

test("a recording group that is not an object gives one notice and defaults", () => {
  for (const recording of [null, 5, "fast", [1, 2]]) {
    const { settings: s, notices } = settings.read(
      file("recording_type.json", JSON.stringify({ threshold: 50, recording })),
    );
    expect(notices).toEqual(['voice.json: "recording" must be an object; using defaults']);
    expect(s.recording).toEqual(settings.default_recording);
    expect(s.threshold).toBe(50);
  }
});

test("a pause break not longer than the recording silence is kept with a notice", () => {
  const notice =
    'voice.json: recording "pause_break" is not longer than "silence", so every passage starts a new contribution';
  for (const recording of [
    { silence: 2, pause_break: 2 },
    { silence: 3, pause_break: 1 },
    // The default pause break (2) against a longer silence.
    { silence: 5 },
  ]) {
    const { settings: s, notices } = settings.read(file("pause_break.json", JSON.stringify({ recording })));
    expect(notices).toEqual([notice]);
    expect(s.recording).toEqual({ ...settings.default_recording, ...recording });
  }
  // The values in effect after validation are compared: a bad silence falls back to 1.
  const { notices } = settings.read(
    file("pause_break_bad.json", JSON.stringify({ recording: { silence: 0, pause_break: 1.5 } })),
  );
  expect(notices).toEqual(['voice.json: "recording.silence" must be 0.5..10; using 1']);
  // The dictation silence does not count.
  expect(settings.read(file("pause_break_dictation.json", JSON.stringify({ silence: 5 }))).notices).toEqual([]);
});

test("the transcripts flag overrides voice.json", () => {
  const read = settings.read(file("flag.json", JSON.stringify({ transcripts: "/from/file" }))).settings;
  expect(settings.merge(read, { transcripts: "notes" }).transcripts).toBe("notes");
  expect(settings.merge(read, {}).transcripts).toBe("/from/file");
});

test("the transcript folder follows the precedence", () => {
  const env = { HOME: "/home/me", XDG_DATA_HOME: "/data" },
    cwd = "/work/here",
    folder = (transcripts: string | null, e: NodeJS.ProcessEnv = env) =>
      settings.transcriptsFolder({ ...settings.defaults(), transcripts }, e, cwd);
  // The flag: relative resolves against the start directory.
  expect(folder("notes")).toBe("/work/here/notes");
  expect(folder("../notes")).toBe("/work/notes");
  expect(folder("/abs/notes")).toBe("/abs/notes");
  expect(folder("~/notes")).toBe("/home/me/notes");
  // voice.json values are absolute or start with ~/.
  const fromFile = settings.read(file("folder.json", JSON.stringify({ transcripts: "~/Notes/t" }))).settings;
  expect(settings.transcriptsFolder(fromFile, env, cwd)).toBe("/home/me/Notes/t");
  expect(settings.transcriptsFolder(settings.merge(fromFile, { transcripts: "x" }), env, cwd)).toBe("/work/here/x");
  // The defaults.
  expect(folder(null)).toBe("/data/corgi/transcripts");
  expect(folder(null, { HOME: "/home/me", XDG_DATA_HOME: "" })).toBe("/home/me/.local/share/corgi/transcripts");
  expect(folder(null, { HOME: "/home/me" })).toBe("/home/me/.local/share/corgi/transcripts");
  expect(folder(null, {})).toBe(join(homedir(), ".local", "share", "corgi", "transcripts"));
});
