//! voice.json: voice mode's settings on the machine with the microphone.
//! Each field is checked on its own; a bad one falls back to its default
//! with a notice, and never costs the rest of the file.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as models from "./models";
import * as level from "./level";
import { default_timing } from "./segmenter";

/** Speech detection while a transcript is recorded; times in seconds. */
export type RecordingSettings = {
  /** 20 by default, as in cc-deck; null follows the dictation threshold. */
  threshold: number | null;
  silence: number;
  max_chunk: number;
  pause_break: number;
};
export type VoiceSettings = {
  threshold: number;
  silence: number;
  pre_roll: number;
  min_speech: number;
  burst: number;
  model: models.ModelName;
  /** null picks a free port each run. */
  port: number | null;
  speech_filter: boolean;
  device: string | null;
  /**
   * The transcript folder; null uses the XDG default. From voice.json it is
   * absolute or starts with `~/`; after `merge` it may be the `--transcripts`
   * flag as typed, and only that can be relative (see `transcriptsFolder`).
   */
  transcripts: string | null;
  recording: RecordingSettings;
};
/** `--transcripts DIR` is kept as typed; `transcriptsFolder` resolves it. */
export type VoiceFlags = Partial<Omit<VoiceSettings, "transcripts" | "recording">> & { transcripts?: string };

export const default_recording: RecordingSettings = { threshold: 20, silence: 1.0, max_chunk: 10, pause_break: 2.0 };
export const defaults = (): VoiceSettings => ({
  threshold: level.default_threshold,
  ...default_timing,
  model: models.default_model,
  port: null,
  speech_filter: true,
  device: null,
  transcripts: null,
  recording: { ...default_recording },
});
export function path(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "corgi", "voice.json");
  if (!process.env.HOME) throw Error("NoHome");
  return join(process.env.HOME, ".local", "state", "corgi", "voice.json");
}
export function read(file: string): { settings: VoiceSettings; notices: string[] } {
  const settings = defaults(),
    notices: string[] = [];
  let data: unknown;
  try {
    if (statSync(file).size > 64 * 1024) return { settings, notices: ["voice.json is over 64 KiB; using defaults"] };
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings, notices };
    return { settings, notices: ["voice.json is not valid JSON; using defaults"] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { settings, notices: ["voice.json is not an object; using defaults"] };
  const d = data as Record<string, unknown>;
  const field = <K extends keyof VoiceSettings>(
    key: K,
    rule: string,
    parse: (v: unknown) => VoiceSettings[K] | null,
  ) => {
    if (!Object.hasOwn(d, key)) return;
    const value = parse(d[key]);
    if (value === null) notices.push(`voice.json: "${key}" must be ${rule}; using ${JSON.stringify(settings[key])}`);
    else settings[key] = value;
  };
  field("threshold", "0..100", percent);
  field("silence", "0.5..10", seconds(0.5, 10));
  field("pre_roll", "0..2", seconds(0, 2));
  field("min_speech", "0.02..2", seconds(0.02, 2));
  field("burst", "0.02..1", seconds(0.02, 1));
  field("model", models.names.join("|"), v => (typeof v === "string" ? models.parseName(v) : null));
  // null, the default, may also be written out.
  if (d.port !== null)
    field("port", "1024..65535 or null", v =>
      Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 ? (v as number) : null,
    );
  field("speech_filter", "true or false", v => (typeof v === "boolean" ? v : null));
  if (Object.hasOwn(d, "device")) {
    if (d.device === null || (typeof d.device === "string" && d.device.trim()))
      settings.device = d.device as string | null;
    else notices.push(`voice.json: "device" must be a device name or null; using null`);
  }
  if (Object.hasOwn(d, "transcripts")) {
    const v = d.transcripts;
    if (typeof v === "string" && (isAbsolute(v) || v.startsWith("~/"))) settings.transcripts = v;
    else notices.push(`voice.json: "transcripts" must be an absolute folder or start with ~/; using the default`);
  }
  if (Object.hasOwn(d, "recording")) readRecording(d.recording, settings.recording, notices);
  if (settings.recording.pause_break <= settings.recording.silence)
    notices.push(
      `voice.json: recording "pause_break" is not longer than "silence", so every passage starts a new contribution`,
    );
  return { settings, notices };
}
const percent = (v: unknown) =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100 ? (v as number) : null;
const seconds = (min: number, max: number) => (v: unknown) =>
  typeof v === "number" && v >= min && v <= max ? v : null;
/** The `recording` group: each field on its own, like the top level. */
function readRecording(value: unknown, out: RecordingSettings, notices: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    notices.push(`voice.json: "recording" must be an object; using defaults`);
    return;
  }
  const r = value as Record<string, unknown>;
  const field = <K extends keyof RecordingSettings>(
    key: K,
    rule: string,
    parse: (v: unknown) => RecordingSettings[K] | null,
  ) => {
    if (!Object.hasOwn(r, key)) return;
    const parsed = parse(r[key]);
    if (parsed !== null) out[key] = parsed;
    else {
      const using = out[key] === null ? "the dictation threshold" : JSON.stringify(out[key]);
      notices.push(`voice.json: "recording.${key}" must be ${rule}; using ${using}`);
    }
  };
  // A null threshold follows the dictation one.
  if (r.threshold === null) out.threshold = null;
  else field("threshold", "0..100", percent);
  field("silence", "0.5..10", seconds(0.5, 10));
  field("max_chunk", "5..30", seconds(5, 30));
  field("pause_break", "0.5..30", seconds(0.5, 30));
}
/** The settings for this run: flags override the file. */
export function merge(settings: VoiceSettings, flags: VoiceFlags): VoiceSettings {
  const out = { ...settings };
  for (const [key, value] of Object.entries(flags)) if (value !== undefined) (out as any)[key] = value;
  return out;
}
/**
 * The transcript folder for this run: `--transcripts` (relative to `cwd`),
 * else voice.json `transcripts`, else `$XDG_DATA_HOME/corgi/transcripts`,
 * else `~/.local/share/corgi/transcripts`. `~/` expands to the home folder.
 * A relative `settings.transcripts` can only be the flag, since `read`
 * refuses relative values.
 */
export function transcriptsFolder(settings: VoiceSettings, env: NodeJS.ProcessEnv, cwd: string): string {
  const given = settings.transcripts;
  if (given !== null) return given.startsWith("~/") ? join(home(env), given.slice(2)) : resolve(cwd, given);
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "corgi", "transcripts");
  return join(home(env), ".local", "share", "corgi", "transcripts");
}
/** The home folder `~/` stands for: `$HOME`, else the account's. */
export function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}
