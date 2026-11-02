import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flags, message, quitter, lateMessage } from "./main";
import { Recorder } from "./recorder";
import type { Tuning } from "./tuning";
import type { Utterance } from "./session";
import * as settings from "./settings";
import { exitError } from "./bridge";
import * as config from "../build_config";

test("flags override settings within their ranges", () => {
  expect(
    flags([
      "--ssh",
      "devbox",
      "--model",
      "small.en",
      "--threshold",
      "60",
      "--silence",
      "1.5",
      "--port",
      "9000",
      "--device",
      "1",
      "--no-filter",
      "--verbose",
    ]),
  ).toEqual({
    ssh: "devbox",
    model: "small.en",
    threshold: 60,
    silence: 1.5,
    port: 9000,
    device: "1",
    speech_filter: false,
    verbose: true,
  });
  expect(flags([])).toEqual({});
  for (const bad of [
    ["--model", "large"],
    ["--threshold", "101"],
    ["--threshold", "4.5"],
    ["--silence", "0.2"],
    ["--port", "80"],
    ["--port", ""],
    ["--ssh", "-oProxyCommand=x"],
    ["--ssh"],
    ["--device"],
    ["--bogus"],
  ])
    expect(() => flags(bad)).toThrow("Usage");
});

test("startup failures read as the CLI contract words them", () => {
  const local = { model: "base.en", port: 8234 },
    remote = { ...local, ssh: "devbox" };
  const say = (name: string, s: { model: string; port: number | null; ssh?: string } = local) =>
    message(Error(name), s);
  expect(say("ModelMissing")).toBe("voice model base.en is not installed; run: corgi voice setup --model base.en");
  expect(say("PortInUse")).toBe(
    'port 8234 is in use; set another "port" in voice.json, pass --port, or leave it unset',
  );
  expect(say("PortInUse", { model: "base.en", port: null })).toBe(
    "whisper-server's port was taken as it started; start voice mode again",
  );
  expect(say("LocalTooOld", { ...local, ssh: "devbox" })).toBe(
    "Corgi on devbox speaks a newer voice bridge; update Corgi here",
  );
  expect(say("DaemonLacksVoice")).toBe("this Corgi daemon has no voice support; reload it with: corgi reload");
  expect(say("VoiceAttached")).toBe("another voice session is already attached to this runtime");
  expect(say("NoRuntime")).toBe("no Corgi runtime is running");
  expect(say("NoRuntime", remote)).toBe("no Corgi runtime is running on devbox");
  expect(say("RemoteTooOld", remote)).toBe(
    `Corgi on devbox has no voice support; install Corgi ${config.releaseVersion} or newer there`,
  );
  expect(say("WhisperMissing")).toStartWith("whisper-server not found; install: ");
  expect(message(Object.assign(Error("SshFailed"), { detail: "Permission denied" }), remote)).toBe(
    "could not reach devbox: Permission denied",
  );
});

test("how ssh ended says why the bridge never answered", () => {
  expect(exitError(2, "corgi: unknown command __voice-bridge; see corgi --help\n").message).toBe("RemoteTooOld");
  expect(exitError(127, "").message).toBe("RemoteMissing");
  expect(exitError(1, "sh: corgi: not found\n").message).toBe("RemoteMissing");
  const ssh = exitError(255, "ssh: connect to host devbox port 22: Connection refused\x1b]0;x\x07\n");
  expect(ssh.message).toBe("SshFailed");
  expect((ssh as { detail?: string }).detail).toBe("ssh: connect to host devbox port 22: Connection refused ]0;x ");
});

test("--transcripts names the folder for one run; it needs a value", () => {
  expect(flags(["--transcripts", "notes/calls"])).toEqual({ transcripts: "notes/calls" });
  expect(() => flags(["--transcripts"])).toThrow("Usage");
});

// What reaches the runtime during a recording is checked in session.test.ts.
test("--transcripts wins over voice.json and resolves against the start folder; --ssh changes nothing", () => {
  const env = { HOME: "/home/me" },
    folder = (args: string[]) =>
      settings.transcriptsFolder(settings.merge(settings.defaults(), flags(args)), env, "/work");
  expect(folder(["--ssh", "devbox", "--transcripts", "calls"])).toBe("/work/calls");
  expect(folder(["--ssh", "devbox"])).toBe("/home/me/.local/share/corgi/transcripts");
  expect(folder([])).toBe(folder(["--ssh", "devbox"]));
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A recorder running into a fresh file, with one passage still being transcribed. */
function busy() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-quit-")),
    tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning,
    recorder = new Recorder({ tuning, now: () => 0 }),
    path = join(dir, "t.txt");
  dirs.push(dir);
  recorder.start(path);
  const u = { speech_start: 0, speech_end: 1000, continues: false, record: null } as unknown as Utterance;
  recorder.claim(u);
  const view = { finishing: false };
  let quits = 0;
  const q = quitter(
    recorder,
    () => view,
    () => quits++,
  );
  return { recorder, path, u, view, q, quits: () => quits };
}

test("quitting with a recording waits for its transcript, then quits", async () => {
  const { recorder, u, view, q, quits } = busy();
  q.press();
  expect(view.finishing).toBe(true);
  expect(recorder.current).toBeNull();
  await Bun.sleep(5);
  expect(quits()).toBe(0);
  recorder.write(u, "Last words.");
  await Bun.sleep(0);
  expect(quits()).toBe(1);
  expect(q.finish().map(r => r.late)).toEqual([0]);
});

test("quitting again ends the wait, and the passage left out is reported", async () => {
  const { path, view, q, quits } = busy();
  q.press();
  q.press();
  expect(quits()).toBe(1);
  expect(view.finishing).toBe(true);
  const finished = q.finish();
  expect(finished).toEqual([{ path, late: 1 }]);
  await Bun.sleep(0);
  // The first wait ends too, without reporting it twice.
  expect(finished).toHaveLength(1);
  expect(lateMessage(path, 1)).toBe(
    `corgi: 1 passage of ${path} did not finish in time and is not in the transcript\n`,
  );
  expect(lateMessage("/t\x1b]0;x\x07.txt", 2)).toBe(
    "corgi: 2 passages of /t ]0;x .txt did not finish in time and are not in the transcript\n",
  );
});

test("quitting without a recording quits at once", () => {
  const recorder = new Recorder({ tuning: {} as Tuning, now: () => 0 }),
    view = { finishing: false };
  let quits = 0;
  quitter(
    recorder,
    () => view,
    () => quits++,
  ).press();
  expect(quits).toBe(1);
  expect(view.finishing).toBe(false);
});
