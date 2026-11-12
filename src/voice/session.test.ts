import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSession } from "./session";
import { Segmenter } from "./segmenter";
import * as level from "./level";
import { Recorder } from "./recorder";
import { Events, type VoiceLink, type WatchRequest } from "./link";
import type { Tuning } from "./tuning";
import { concat, music, shapes, silence, tone } from "../../tests/fixtures/voice/make_pcm";

/** A link whose replies the test hands out. */
class FakeLink implements VoiceLink {
  events = new Events();
  calls: { op: string; value?: unknown; at: number }[] = [];
  watched: WatchRequest[] = [];
  sets: object[] = [];
  closed = false;
  /** Whether the runtime has a viewer, as the watch reply says. */
  viewer = true;
  reply: (op: string, value?: unknown) => Promise<any> = async () => ({ pane: 1, viewer: 1 });
  async watch(req: WatchRequest) {
    this.watched.push(req);
    return { voice_id: "v-1", muted: req.muted, viewer: this.viewer, focus: "dictation" };
  }
  async set(state: object) {
    this.sets.push(state);
    return { muted: false };
  }
  type(text: string) {
    this.calls.push({ op: "type", value: text, at: performance.now() });
    return this.reply("type", text);
  }
  on(event: "muted" | "viewer" | "closed", fn: (value: any) => void) {
    this.events.on(event, fn);
  }
  close() {
    this.closed = true;
  }
}
class FakeWhisper {
  heard: string[] = [];
  requests = 0;
  /** The filter padding each request asked for, in seconds. */
  pads: number[] = [];
  speech_end?: number;
  crash: (code: number | null) => void = () => {};
  /** Holds every transcription until it resolves, for a Whisper that is behind. */
  gate: Promise<void> = Promise.resolve();
  constructor(private script: string[]) {}
  async transcribe(_wav: Uint8Array, opts: { pad: number }): Promise<{ text: string; speech_end?: number }> {
    this.requests++;
    this.pads.push(opts.pad);
    await this.gate;
    return { text: this.script.shift() ?? "", speech_end: this.speech_end };
  }
  on(_event: "crashed", fn: (code: number | null) => void) {
    this.crash = fn;
  }
}
function session(
  script: string[],
  opts: {
    link?: FakeLink;
    links?: (signal: AbortSignal) => Promise<VoiceLink>;
    timeout?: number;
    log?: (line: string) => void;
    now?: () => number;
    recorder?: Recorder;
  } = {},
) {
  const link = opts.link ?? new FakeLink(),
    whisper = new FakeWhisper(script),
    // The recorder's clock: a resume breaks by when speech began.
    segmenter = new Segmenter({ threshold: 44, timing: { silence: 0.5 }, now: () => performance.now() }),
    s = new VoiceSession({
      link: opts.links ?? (async () => link),
      transcriber: whisper,
      segmenter,
      now: opts.now ?? (() => performance.now()),
      deliverTimeoutMs: opts.timeout ?? 2000,
      retryMs: 20,
      log: opts.log,
      recorder: opts.recorder,
    });
  return { s, link, whisper, segmenter };
}
const folders: string[] = [];
afterEach(() => {
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A recorder with timing that never changes, and a transcript path in a fresh folder. */
function recorder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-session-")),
    tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning;
  folders.push(dir);
  return { recorder: new Recorder({ tuning, now: () => performance.now() }), path: join(dir, "t.txt") };
}
const transcript = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
/** One utterance: 1.5 s of tone, then enough silence to end it. */
function speak(s: VoiceSession) {
  const pcm = shapes.speech();
  for (let at = 0; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const statuses = (s: VoiceSession) => s.history.filter(u => u.status !== "dropped").map(u => [u.status, u.reason]);

test("utterances are typed one delivery at a time", async () => {
  const link = new FakeLink();
  let open = 0,
    most = 0;
  link.reply = async () => {
    most = Math.max(most, ++open);
    await Bun.sleep(30);
    open--;
    return { pane: 1, viewer: 1 };
  };
  const { s } = session(["refactor the parser", "um, add tests"], { link });
  await s.connect();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => c.value)).toEqual(["refactor the parser", "add tests"]);
  expect(most).toBe(1);
  // The UI names where the text goes.
  expect(s.focus).toBe("dictation");
});

test("a delivery that never returns fails at the bound without holding up the next", async () => {
  const link = new FakeLink();
  let first = true;
  link.reply = () => {
    if (first) {
      first = false;
      return new Promise(() => {});
    }
    return Promise.resolve({ pane: 1, viewer: 1 });
  };
  const { s, whisper } = session(["stuck", "next one please"], { link, timeout: 300 });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  const hung = performance.now();
  // Said while the first delivery hangs: heard and transcribed at once.
  speak(s);
  await until(() => whisper.requests === 2 && s.history[1]?.text === "next one please");
  expect(performance.now() - hung).toBeLessThan(300);
  expect(s.history[0].status).toBe("delivering");
  // Delivered as soon as the bound gives up on the first.
  await until(() => s.history[1].status === "delivered");
  expect(s.history[0]).toMatchObject({ status: "failed", reason: "no answer in time; may have been typed" });
  expect(performance.now() - hung).toBeLessThan(300 + 150);
});

test("what is said while disconnected fails and is never sent later", async () => {
  const link = new FakeLink(),
    links = [link, new FakeLink()];
  let connects = 0;
  const { s } = session(["lost words", "after"], { links: async () => links[Math.min(connects++, 1)] });
  await s.connect();
  link.events.emitClosed("runtime_gone");
  expect(s.link_state).toBe("lost");
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("not connected");
  await until(() => s.link_state === "connected");
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(links[1].calls.map(c => c.value)).toEqual(["after"]);
  expect(link.calls).toEqual([]);
});

test("reconnecting sends the current mute state", async () => {
  const links = [new FakeLink(), new FakeLink()];
  let connects = 0;
  const { s } = session([], { links: async () => links[connects++] });
  await s.connect();
  s.setMuted(true);
  expect(links[0].sets).toEqual([{ muted: true }]);
  links[0].events.emitClosed("runtime_gone");
  await until(() => s.link_state === "connected");
  expect(links[1].watched[0]).toMatchObject({ muted: true, available: true });
});

test("muting discards what is being said or transcribed", async () => {
  const { s, link, whisper } = session(["first", "second"]);
  await s.connect();
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[0].status).toBe("recording");
  link.events.emitMuted(true);
  expect(statuses(s)).toEqual([["muted", null]]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(link.calls).toEqual([]);
  // Unmuted mid-transcription, then muted again before delivery.
  s.setMuted(false);
  let release!: (heard: { text: string }) => void;
  whisper.transcribe = () => new Promise(resolve => (release = resolve));
  speak(s);
  await until(() => s.history.at(-1)?.status === "transcribing");
  s.setMuted(true);
  release({ text: "too late" });
  await Bun.sleep(30);
  expect(s.history.at(-1)?.status).toBe("muted");
  expect(link.calls).toEqual([]);
});

test("text the runtime refuses as muted is discarded, not failed", async () => {
  const link = new FakeLink();
  link.reply = async () => {
    throw Error("VoiceMuted");
  };
  const { s } = session(["late words"], { link });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "muted");
  expect(statuses(s)).toEqual([["muted", null]]);
});

test("a Whisper that falls behind is not handed more than four recordings", async () => {
  const { s, whisper, link } = session(["one", "two", "three", "four"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  for (let i = 0; i < 6; i++) speak(s);
  expect(statuses(s).map(([status]) => status)).toEqual([...Array(4).fill("transcribing"), "failed", "failed"]);
  expect(s.history[5].reason).toBe("backlog");
  open();
  await until(() => statuses(s).filter(([status]) => status === "delivered").length === 4);
  expect(link.calls.map(c => c.value)).toEqual(["one", "two", "three", "four"]);
  // With the backlog cleared, speech goes through again.
  speak(s);
  await until(() => s.history.at(-1)?.status === "dropped" || s.history.at(-1)?.status === "delivered");
  expect(s.history.at(-1)?.reason).not.toBe("backlog");
});

test("a runtime that is slow to take text is not handed more than four utterances", async () => {
  const link = new FakeLink();
  link.reply = () => new Promise(() => {});
  const { s } = session(["a", "b", "c", "d", "e", "f"], { link, timeout: 200 });
  await s.connect();
  for (let i = 0; i < 6; i++) speak(s);
  await until(() => s.history[0]?.status === "delivering");
  expect(statuses(s).map(([status]) => status)).toEqual([
    "delivering",
    ...Array(3).fill("transcribing"),
    "failed",
    "failed",
  ]);
  expect(s.history[4].reason).toBe("backlog");
  await until(
    () => statuses(s).filter(([, why]) => why === "no answer in time; may have been typed").length === 4,
    3000,
  );
});

test("an availability update on its way does not undo a mute from a viewer", async () => {
  const link = new FakeLink();
  const { s } = session([], { link });
  await s.connect();
  s.setAvailable(false, "mic_busy");
  // What goes out names only what changed here.
  expect(link.sets).toEqual([{ available: false }]);
  link.events.emitMuted(true);
  s.frame(new Int16Array(320));
  // Updates go one at a time: this one follows the first.
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
  expect(s.muted).toBe(true);
});

test("words that sound like commands are typed as text", async () => {
  const { s, link } = session(["Send.", "next"]);
  await s.connect();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => [c.op, c.value])).toEqual([
    ["type", "Send."],
    ["type", "next"],
  ]);
});

test("non-speech and phantom text are dropped, not typed", async () => {
  const { s, link } = session(["[BLANK_AUDIO]", "Thank you.", "um"]);
  await s.connect();
  speak(s);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "dropped").length === 3);
  expect(link.calls).toEqual([]);
});

test("a crash spares text Whisper already gave back", async () => {
  const link = new FakeLink();
  let release!: () => void,
    first = true;
  link.reply = () => {
    if (!first) return Promise.resolve({ pane: 1, viewer: 1 });
    first = false;
    return new Promise(resolve => (release = () => resolve({ pane: 1, viewer: 1 })));
  };
  const { s, whisper } = session(["held", "waiting"], { link });
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  // Transcribed, and queued behind the delivery that hangs.
  speak(s);
  await until(() => s.history[1]?.text === "waiting");
  whisper.crash(3);
  expect(s.history[1].status).toBe("transcribing");
  release();
  await until(() => s.history[1].status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["held", "waiting"]);
});

test("speech during a filter switch fails as such, not as a crash", async () => {
  const { s, whisper } = session([]);
  await s.connect();
  whisper.transcribe = () => Promise.reject(Error("ServerRestarting"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("filter switching");
  expect(s.available).toBe(true);
});

test("a fresh server after a crash makes voice listen again", async () => {
  const { s, link, whisper } = session(["back again"]);
  await s.connect();
  whisper.crash(3);
  expect(s.available).toBe(false);
  s.serverReady();
  expect([s.available, s.unavailable, s.server]).toEqual([true, null, "ready"]);
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["back again"]);
});

test("a server crash fails the utterance and stops listening", async () => {
  const { s, link, whisper } = session([]);
  await s.connect();
  whisper.transcribe = () => new Promise(() => {});
  speak(s);
  await until(() => s.history[0]?.status === "transcribing");
  whisper.crash(3);
  expect(statuses(s)).toEqual([["failed", "server crashed"]]);
  expect([s.available, s.unavailable, s.server]).toEqual([false, "server_down", "crashed"]);
  expect(link.sets).toEqual([{ available: false }]);
  speak(s);
  expect(s.history).toHaveLength(1);
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back does not revive a crashed server", async () => {
  const { s, link, whisper } = session([]);
  await s.connect();
  whisper.crash(3);
  s.setAvailable(false, "mic_missing");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([false, "server_down"]);
  expect(link.sets.at(-1)).toMatchObject({ available: false });
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back makes voice available again", async () => {
  const { s, link } = session([]);
  await s.connect();
  s.setAvailable(false, "mic_denied");
  expect(s.unavailable).toBe("mic_denied");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([true, null]);
  await until(() => link.sets.length === 2);
  expect(link.sets).toEqual([{ available: false }, { available: true }]);
});

test("a first connection that fails and is given up on never retries", async () => {
  let attempts = 0;
  const { s } = session([], {
    links: async () => {
      attempts++;
      throw Error("NoRuntime");
    },
  });
  await expect(s.connect()).rejects.toThrow("NoRuntime");
  s.close();
  await Bun.sleep(60);
  expect(attempts).toBe(1);
});

test("quitting while a connection is on its way aborts it and attaches nothing", async () => {
  const link = new FakeLink();
  let release!: () => void,
    aborted = false;
  const { s } = session([], {
    links: signal =>
      new Promise(resolve => {
        signal.addEventListener("abort", () => (aborted = true));
        release = () => resolve(link);
      }),
  });
  const connecting = s.connect();
  s.close();
  expect(aborted).toBe(true);
  release();
  await connecting;
  expect(link.closed).toBe(true);
  expect(link.watched).toEqual([]);
});

test("state the runtime did not take is sent again", async () => {
  const link = new FakeLink();
  let failures = 1;
  const set = link.set.bind(link);
  link.set = async state => {
    if (failures-- > 0) throw Error("Timeout");
    return set(state);
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  expect(link.sets).toEqual([]);
  await until(() => link.sets.length === 1, 2000);
  expect(link.sets[0]).toEqual({ muted: true });
});

test("an older answer never cancels the retry of a newer mute change", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  link.set = async state => {
    link.sets.push(state);
    if (link.sets.length === 1) return new Promise(resolve => (answer = () => resolve({ muted: true })));
    if (link.sets.length === 2) throw Error("Timeout");
    return { muted: false };
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  s.setMuted(false);
  await until(() => answer !== undefined);
  answer();
  await until(() => link.sets.length === 3, 2000);
  expect(link.sets).toEqual([{ muted: true }, { muted: false }, { muted: false }]);
});

test("a change waiting to go out never undoes a mute from a viewer", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  link.set = async state => {
    link.sets.push(state);
    if (link.sets.length === 1) await new Promise<void>(resolve => (answer = resolve));
    return { muted: true };
  };
  const { s } = session([], { link });
  await s.connect();
  s.setMuted(true);
  s.setMuted(false);
  await until(() => answer !== undefined);
  link.events.emitMuted(true);
  answer();
  await until(() => link.sets.length === 2);
  expect(s.muted).toBe(true);
  expect(link.sets).toEqual([{ muted: true }, { muted: true }]);
});

test("a mute pressed while the watch is on its way still reaches the runtime", async () => {
  const link = new FakeLink();
  let answer!: () => void;
  const watch = link.watch.bind(link);
  link.watch = req => new Promise(resolve => (answer = () => resolve(watch(req))));
  const { s } = session([], { link });
  const connecting = s.connect();
  await until(() => answer !== undefined);
  s.setMuted(true);
  answer();
  await connecting;
  expect(s.muted).toBe(true);
  expect(link.sets).toEqual([{ muted: true }]);
});

test("a runtime that refuses this voice is not retried", async () => {
  let attempts = 0;
  const { s } = session([], {
    links: async () => {
      attempts++;
      throw Error("VoiceAttached");
    },
  });
  await expect(s.connect()).rejects.toThrow("VoiceAttached");
  await Bun.sleep(60);
  expect([s.link_state, s.refused, attempts]).toEqual(["refused", "VoiceAttached", 1]);
});

test("without a viewer, voice holds off and drops what is in progress", async () => {
  const link = new FakeLink();
  link.viewer = false;
  const { s, whisper } = session(["lost"], { link });
  await s.connect();
  expect([s.viewer, s.focus]).toEqual([false, "dictation"]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(s.history).toEqual([]);
  // A viewer attaches: speech counts again.
  link.events.emitViewer({ viewer: true, focus: "build" });
  expect(s.focus).toBe("build");
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  // It goes away mid-sentence: the sentence is dropped, never typed later.
  link.events.emitViewer({ viewer: false, focus: null });
  expect(statuses(s)).toEqual([["discarded", "no viewer"]]);
  expect(link.calls).toEqual([]);
});

test("a link that keeps failing is logged once per distinct failure", async () => {
  const lines: string[] = [];
  let attempts = 0,
    failure = "NoRuntime";
  const link = new FakeLink(),
    s = new VoiceSession({
      link: async () => {
        attempts++;
        if (failure) throw Error(failure);
        return link;
      },
      transcriber: new FakeWhisper([]),
      segmenter: new Segmenter({ threshold: 44, now: () => 0 }),
      now: () => performance.now(),
      retryMs: 5,
      log: line => lines.push(line),
    });
  await s.connect().catch(() => {});
  await until(() => attempts >= 5);
  failure = "SshFailed";
  await until(() => attempts >= 10);
  failure = "";
  await until(() => s.link_state === "connected");
  s.close();
  expect(lines).toEqual(["link: NoRuntime", "link: SshFailed", "link: connected"]);
});

test("a transcription that times out says so, not that it may have been typed", async () => {
  const { s, whisper, link } = session([]);
  await s.connect();
  whisper.transcribe = () => Promise.reject(Error("Timeout"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("timed out");
  expect(link.calls).toEqual([]);
});

test("the speech filter pads by the post-roll each utterance ended with", async () => {
  const { s, whisper, segmenter } = session(["one", "two", "three", "four"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  // The default 1 s, within the tests' 0.5 s silence window.
  speak(s);
  speak(s);
  // Changed while the second waits behind the first: it keeps its own.
  segmenter.setTiming("post_roll", 0);
  open();
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(whisper.pads).toEqual([0.5, 0.5]);
  // None at all; whisper.ts keeps the filter's own 30 ms.
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 3);
  expect(whisper.pads).toEqual([0.5, 0.5, 0]);
  expect(s.history[2].pad).toBe(0.03);
  // Whole pause pads by the silence window, here 0.5 s.
  segmenter.setTiming("post_roll", Infinity);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 4);
  expect(whisper.pads).toEqual([0.5, 0.5, 0, 0.5]);
});

test("the log says what the cut kept and where Whisper heard the speech end", async () => {
  const lines: string[] = [],
    { s, whisper, segmenter } = session(["run the tests again", "send", "it"], { log: line => lines.push(line) });
  // The real server reports times such as this one.
  whisper.speech_end = 4.2700000000000005;
  await s.connect();
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 1:"))).toMatch(
    /^utterance 1: delivered duration=2s transcribe_ms=[\d.]+ deliver_ms=[\d.]+ post_roll=0\.5s kept=0\.5s dropped=0s pad=0\.5s speech_end=4\.27s$/,
  );
  // Without segment times, there is no speech end.
  whisper.speech_end = undefined;
  segmenter.setTiming("post_roll", 0.3);
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 2:"))).toMatch(/ post_roll=0\.3s kept=0\.3s dropped=0\.2s pad=0\.3s$/);
  // The cut reports the 20 ms frames it kept: 0.75 s is 38 of them.
  segmenter.setTiming("silence", 2.5);
  segmenter.setTiming("post_roll", 0.75);
  speak(s);
  await until(() => s.history[2]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 3:"))).toMatch(
    / post_roll=0\.76s kept=0\.76s dropped=1\.74s pad=0\.76s$/,
  );
});

test("an utterance cut at 30 s logs no post-roll, as none was applied", async () => {
  const lines: string[] = [],
    { s } = session(["a long one", ""], { log: line => lines.push(line) });
  await s.connect();
  // The cap comes 0.2 s into the pause, before the 0.5 s window ends it.
  const pcm = concat(tone(29.8), silence(1));
  for (let at = 0; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
  await until(() => s.history[0]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 1:"))).toMatch(
    /^utterance 1: delivered duration=30s transcribe_ms=[\d.]+ deliver_ms=[\d.]+ capped kept=0\.2s dropped=0s pad=0\.5s$/,
  );
});

/** Feeds 20 ms frames of `pcm`, moving `clock` along with them when given. */
function play(s: VoiceSession, pcm: Int16Array, clock?: { t: number }) {
  for (let at = 0; at < pcm.length; at += 320) {
    if (clock) clock.t += 20;
    s.frame(pcm.subarray(at, at + 320));
  }
}
/** Feeds `seconds` of a tone at threshold-scale level `pct`, a frame at a time. */
function hum(s: VoiceSession, pct: number, seconds = 10, clock?: { t: number }) {
  play(s, tone(seconds, level.percentToRms(pct)), clock);
}
/** The level a tone at `pct` measures, frame by frame. */
const measured = (pct: number) => level.rmsToPercent(level.rms(tone(0.02, level.percentToRms(pct))));

test("a gauge listens 10 s, then sets the threshold just above the background", async () => {
  const lines: string[] = [],
    clock = { t: 0 },
    { s, segmenter, link } = session(["after the gauge"], { log: line => lines.push(line), now: () => clock.t });
  await s.connect();
  expect(s.startGauge()).toBeNull();
  expect(s.gauge).toEqual({ frames: [], loudest: 0, progress: 0 });
  hum(s, 55.5, 5, clock);
  expect(s.gauge?.progress).toBe(0.5);
  expect(s.gauge?.loudest).toBeCloseTo(measured(55.5), 5);
  hum(s, 55.5, 5, clock);
  expect(s.gauge).toBeNull();
  expect(segmenter.percent).toBe(58);
  expect(s.gauges).toHaveLength(1);
  expect(s.gauges[0]).toMatchObject({ old: 44, threshold: 58, outcome: "no_speech_to_compare" });
  expect(s.gauges[0].loudest).toBeCloseTo(measured(55.5), 5);
  // Applied with the 500th frame, 10 s after the key press.
  expect(s.gauges[0].took_ms).toBe(10000);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([
    expect.stringMatching(/^gauge: threshold 44 → 58 loudest=55\.\d outcome=no_speech_to_compare took_ms=10000$/),
  ]);
  // The same hum now starts nothing, and speech above the threshold is typed as before.
  hum(s, 55.5, 3, clock);
  expect(s.history).toEqual([]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["after the gauge"]);
  expect(s.muted).toBe(false);
});

test("a gauge replays with the timings in effect, not the defaults", async () => {
  const { s, segmenter } = session([]);
  await s.connect();
  segmenter.setTiming("min_speech", 1);
  s.startGauge();
  play(s, music(10, 7));
  // With the helper's 0.5 s silence alone this music gives 63, with the defaults 81.
  expect(segmenter.percent).toBe(61);
});

test("quitting during a gauge ends it, with no row and the threshold as it was", async () => {
  const lines: string[] = [],
    { s, segmenter } = session([], { log: line => lines.push(line) });
  await s.connect();
  s.startGauge();
  hum(s, 60, 4);
  s.close();
  expect(s.gauge).toBeNull();
  // Frames that still come in finish no gauge.
  hum(s, 60, 6);
  expect([s.gauge, s.gauges, segmenter.percent]).toEqual([null, [], 44]);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([]);
});

test("without a microphone a gauge does not start", async () => {
  const { s } = session([]);
  await s.connect();
  s.setAvailable(false, "mic_busy");
  expect(s.startGauge()).toBe("mic_busy");
  expect(s.gauge).toBeNull();
  // A crashed server is no reason: the gauge needs only the microphone.
  const crashed = session([]);
  await crashed.s.connect();
  crashed.whisper.crash(3);
  expect(crashed.s.startGauge()).toBeNull();
});

test("a gauge drops what is being said, but what Whisper has goes on to be typed", async () => {
  const { s, whisper, link } = session(["first words", "lost"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  speak(s);
  expect(s.history[0].status).toBe("transcribing");
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[1].status).toBe("recording");
  s.startGauge();
  expect(s.history.map(u => u.status)).toEqual(["transcribing", "dropped"]);
  // Speech during the gauge is background: nothing is recorded or sent.
  speak(s);
  expect(s.history).toHaveLength(2);
  expect(s.pause).toBe(0);
  open();
  await until(() => s.history[0].status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["first words"]);
  expect(whisper.requests).toBe(1);
  expect(s.gauge).not.toBeNull();
});

test("mute, a missing viewer, a lost link or a crashed server do not stop a gauge", async () => {
  const cases: [string, (t: ReturnType<typeof session>) => void][] = [
    ["muted", t => t.s.setMuted(true)],
    ["no viewer", t => t.link.events.emitViewer({ viewer: false, focus: null })],
    ["link lost", t => t.link.events.emitClosed("runtime_gone")],
    ["server crashed", t => t.whisper.crash(3)],
  ];
  for (const [name, upset] of cases) {
    const t = session([]);
    await t.s.connect();
    upset(t);
    expect(t.s.startGauge()).toBeNull();
    hum(t.s, 60);
    expect([name, t.s.gauges.map(g => g.threshold)]).toEqual([name, [Math.floor(measured(60)) + 3]]);
    t.s.close();
  }
  // Mute changes from either side during a gauge leave it running, and mute stays.
  const { s, link } = session([]);
  await s.connect();
  s.startGauge();
  hum(s, 60, 2);
  link.events.emitMuted(true);
  s.setMuted(false);
  s.setMuted(true);
  expect(s.gauge?.progress).toBe(0.2);
  hum(s, 60, 8);
  expect(s.gauges).toHaveLength(1);
  expect(s.muted).toBe(true);
});

test("a cancelled gauge leaves no row and the threshold as it was", async () => {
  const lines: string[] = [],
    { s, segmenter, link } = session(["after"], { log: line => lines.push(line) });
  await s.connect();
  s.startGauge();
  hum(s, 70, 4);
  s.cancelGauge();
  expect([s.gauge, s.gauges, segmenter.percent]).toEqual([null, [], 44]);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([]);
  // Listening resumes.
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["after"]);
});

test("a microphone that fails mid-gauge ends it with a row, and the threshold stays", async () => {
  const lines: string[] = [],
    { s, segmenter } = session([], { log: line => lines.push(line) });
  await s.connect();
  s.startGauge();
  hum(s, 70, 4);
  s.setAvailable(false, "mic_denied");
  expect(s.gauge).toBeNull();
  expect(s.gauges).toEqual([expect.objectContaining({ old: 44, threshold: 44, outcome: "mic_failed" })]);
  expect(segmenter.percent).toBe(44);
  expect(lines).toContainEqual(
    expect.stringMatching(/^gauge: threshold 44 → 44 loudest=70(\.\d)? outcome=mic_failed took_ms=\d+$/),
  );
  // Frames again: the microphone is back, and speech is heard as before.
  hum(s, 0, 0.02);
  expect(s.available).toBe(true);
});

test("music too loud to gauge leaves the threshold, and says so", async () => {
  const lines: string[] = [],
    { s, segmenter } = session([], { log: line => lines.push(line) });
  await s.connect();
  s.startGauge();
  const loud = tone(10, 0.6);
  for (let at = 0; at < loud.length; at += 320) s.frame(loud.subarray(at, at + 320));
  expect(s.gauges).toEqual([expect.objectContaining({ old: 44, threshold: 44, loudest: 100, outcome: "too_loud" })]);
  expect(segmenter.percent).toBe(44);
  expect(lines).toContainEqual(
    expect.stringMatching(/^gauge: threshold 44 → 44 loudest=100 outcome=too_loud took_ms=\d+$/),
  );
});

test("delivered utterances keep their peak, and a gauge above most of them warns", async () => {
  const { s, segmenter } = session(["one", "two", "three"]);
  await s.connect();
  for (let i = 0; i < 3; i++) speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 3);
  // shapes.speech() is a tone at RMS 0.1.
  const peak = level.rmsToPercent(level.rms(tone(0.02, 0.1)));
  for (const u of s.history) expect(u.peak).toBeCloseTo(peak, 5);
  // Music as loud as that speech: applied, with the warning.
  s.startGauge();
  hum(s, peak);
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied_quiet_speech", threshold: Math.floor(peak) + 3 });
  expect(segmenter.percent).toBe(Math.floor(peak) + 3);
  // Music well under it: applied.
  s.startGauge();
  hum(s, 50.5);
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied", threshold: 53 });
});

test("only delivered utterances count against a gauge's result", async () => {
  const { s } = session(["loud words", "", ""]);
  await s.connect();
  speak(s);
  // Two quiet ones, above 44 but under the music to come; Whisper hears nothing in them.
  for (let i = 0; i < 2; i++) play(s, concat(tone(1.5, level.percentToRms(50.5)), silence(3)));
  await until(() => s.history.filter(u => u.status === "dropped" && u.reason === "empty").length === 2);
  expect(s.history.filter(u => u.status === "delivered")).toHaveLength(1);
  s.startGauge();
  hum(s, 55.5);
  // Two of three peaks are under 58, but neither was delivered.
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied", threshold: 58 });
});

test("a recording while unmuted writes each passage and types it too", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["refactor the parser", "um, add tests"], { recorder: r });
  await s.connect();
  r.start(path);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => c.value)).toEqual(["refactor the parser", "add tests"]);
  expect(transcript(path)).toBe("refactor the parser\nadd tests\n");
  expect(s.history.every(u => u.record !== null && u.speech_end > u.speech_start)).toBe(true);
});

test("a passage that began before the recording and ended after it is written", async () => {
  const { recorder: r, path } = recorder(),
    { s } = session(["straddles the start"], { recorder: r });
  await s.connect();
  const pcm = shapes.speech();
  let at = 0;
  for (; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  r.start(path);
  for (; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
  await until(() => s.history[0]?.status === "delivered");
  expect(transcript(path)).toBe("straddles the start\n");
});

test("a passage that ends before the recording starts is not written", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["before"], { recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  speak(s);
  r.start(path);
  open();
  await until(() => s.history[0]?.status === "delivered");
  expect(s.history[0].record).toBeNull();
  expect(transcript(path)).toBe("");
});

test("a claimed passage that comes to nothing does not hold up a stop", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["um", ""], { recorder: r });
  await s.connect();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "dropped");
  let fail!: (error: Error) => void;
  whisper.transcribe = () => new Promise<{ text: string }>((_, reject) => (fail = reject));
  speak(s);
  await until(() => s.history[1]?.status === "transcribing" && fail !== undefined);
  const stopping = r.stop(5000);
  fail(Error("Timeout"));
  const started = performance.now();
  expect(await stopping).toMatchObject({ late: 0 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(s.history[1].status).toBe("failed");
  expect(transcript(path)).toBe("");
});

/** The first second of an utterance: speech is still in progress. */
function begin(s: VoiceSession, pcm: Int16Array) {
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
}
function end(s: VoiceSession, pcm: Int16Array) {
  for (let at = 16000; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}

test("muted while recording, speech is written but never typed", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["a call", "goes on"], { recorder: r });
  await s.connect();
  s.setMuted(true);
  r.start(path);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "recorded").length === 2);
  expect(statuses(s)).toEqual([
    ["recorded", "muted"],
    ["recorded", "muted"],
  ]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("a call\ngoes on\n");
});

test("muted with the recording paused, audio is dropped as before", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper, link } = session(["private"], { recorder: r });
  await s.connect();
  r.start(path);
  r.pause();
  s.setMuted(true);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(s.history).toEqual([]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("");
});

test("a mute in the middle of a passage still writes it, untyped", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["half muted"], { recorder: r });
  await s.connect();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(true);
  expect(s.recording).toBe(true);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("half muted\n");
});

test("speech that began muted stays untyped after an unmute", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["private aside"], { recorder: r });
  await s.connect();
  r.start(path);
  s.setMuted(true);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(false);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("private aside\n");
});

test("speech that began without a viewer stays untyped when one attaches", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["before the window"], { link, recorder: r });
  await s.connect();
  r.start(path);
  link.events.emitViewer({ viewer: false, focus: null });
  const pcm = shapes.speech();
  begin(s, pcm);
  link.events.emitViewer({ viewer: true, focus: "dictation" });
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "no viewer attached"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("before the window\n");
});

test("a recorded passage that ends while the link is down is typed once it is back", async () => {
  const { recorder: r, path } = recorder();
  // Each connection gets a fresh link; `current` is the one in use.
  let current = new FakeLink();
  const { s, whisper } = session(["back again"], { links: async () => (current = new FakeLink()), recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  current.events.emitClosed("runtime_gone");
  r.start(path);
  speak(s);
  await until(() => s.link_state === "connected");
  open();
  await until(() => s.history[0]?.status === "delivered");
  expect(current.calls.map(c => c.value)).toEqual(["back again"]);
  expect(transcript(path)).toBe("back again\n");
});

test("a recorded passage whose typing gets no answer may have been typed", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["slow runtime"], { link, recorder: r, timeout: 30 });
  link.reply = () => new Promise(() => {});
  await s.connect();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "recorded");
  expect(s.history[0]).toMatchObject({
    status: "recorded",
    reason: "no answer in time; may have been typed",
    maybe_typed: true,
  });
  expect(link.calls.map(c => c.value)).toEqual(["slow runtime"]);
  expect(transcript(path)).toBe("slow runtime\n");
});

test("muted, a passage cut off by a pause or a stop is dropped, unheard and unwritten", async () => {
  for (const end_recording of ["pause", "stop"] as const) {
    const { recorder: r, path } = recorder(),
      { s, whisper, link } = session(["private"], { recorder: r });
    await s.connect();
    r.start(path);
    s.setMuted(true);
    const pcm = shapes.speech();
    begin(s, pcm);
    expect(s.recording).toBe(true);
    if (end_recording === "pause") r.pause();
    else void r.stop();
    end(s, pcm);
    await Bun.sleep(30);
    expect(statuses(s)).toEqual([["muted", null]]);
    expect(s.recording).toBe(false);
    expect(whisper.requests).toBe(0);
    expect(link.calls).toEqual([]);
    expect(transcript(path)).toBe("");
  }
});

test("nothing about a recording goes to the runtime, only the typed text", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["typed and kept", "kept only"], { link, recorder: r });
  await s.connect();
  const sets = link.sets.length;
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  s.setMuted(true);
  speak(s);
  await until(() => s.history[1]?.status === "recorded");
  r.pause();
  r.resume();
  await r.stop();
  expect(link.calls.map(c => [c.op, c.value])).toEqual([["type", "typed and kept"]]);
  // The mute goes out as before; the path and the recording state never do.
  expect(link.sets.slice(sets)).toEqual([{ muted: true }]);
  expect(JSON.stringify(link.watched)).not.toContain(path);
  expect(transcript(path)).toBe("typed and kept\nkept only\n");
});

test("a viewer that leaves mid-passage leaves it written and untyped", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["nobody watching", "still nobody"], { link, recorder: r });
  await s.connect();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  link.events.emitViewer({ viewer: false, focus: null });
  end(s, pcm);
  // And speech while no viewer is attached is heard too.
  speak(s);
  await until(() => s.history.filter(u => u.status === "recorded").length === 2);
  expect(statuses(s)).toEqual([
    ["recorded", "no viewer attached"],
    ["recorded", "no viewer attached"],
  ]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("nobody watching\nstill nobody\n");
});

test("with the link down, a recorded passage is written and says why it was not typed", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["offline"], { links: async () => link, recorder: r });
  await s.connect();
  link.events.emitClosed("runtime_gone");
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "not connected"]]);
  expect(transcript(path)).toBe("offline\n");
  s.close();
});

test("a typing backlog never drops a recorded passage from the transcript", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["one", "two", "three", "four", "five", "six"], { recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.connect();
  r.start(path);
  for (let i = 0; i < 6; i++) speak(s);
  expect(statuses(s).map(([status]) => status)).toEqual(Array(6).fill("transcribing"));
  open();
  await until(() => s.history.every(u => u.status === "delivered" || u.status === "recorded"));
  expect(statuses(s)).toEqual([
    ...Array(4).fill(["delivered", null]),
    ["recorded", "backlog"],
    ["recorded", "backlog"],
  ]);
  expect(transcript(path)).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
});

test("a passage while paused is typed but not written; the next one after resume starts a contribution", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["before", "aside", "after"], { recorder: r });
  await s.connect();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  r.pause();
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(s.history[1].record).toBeNull();
  r.resume();
  speak(s);
  await until(() => s.history[2]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["before", "aside", "after"]);
  expect(transcript(path)).toBe("before\n\nafter\n");
});

test("a passage muted and unmuted while it is said is written but not typed", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["on and off"], { recorder: r });
  await s.connect();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(true);
  s.setMuted(false);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("on and off\n");
});
