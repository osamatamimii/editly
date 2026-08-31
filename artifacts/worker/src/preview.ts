/**
 * A preview the browser can always decode.
 *
 * The master output is H.264, and stays H.264: it is what TikTok, Reels and
 * every phone editor expect, and it is the file people download. But as the
 * *only* copy it has a failure mode we have now watched happen on a real
 * machine: H.264 decode is a licensed platform component, and a browser whose
 * OS codec is broken sits at `readyState 0` forever — no error, no event,
 * `canPlayType` cheerfully answering "probably" the whole time. The person
 * renders an edit and cannot watch it, on the one file this product exists to
 * produce.
 *
 * VP9 has no such dependency: every Chromium and Firefox build decodes it in
 * software, shipped with the browser itself. So each render also writes a
 * small VP9/Opus preview next to the master, and the player offers both —
 * the master for browsers that can, the preview for browsers that cannot.
 *
 * The preview is found by convention — the master's storage key plus
 * `.preview.webm` — because a convention needs no schema change and cannot
 * drift from the file it describes. A render from before this existed simply
 * has no object at that key, and the player falls back to the master alone,
 * which is exactly the behaviour it had before.
 *
 * Encoding cost is real but small at this size: `-cpu-used 5 -row-mt 1` keeps
 * libvpx at several times realtime for a 720-tall short, and CRF 34 is
 * preview quality on purpose — the master is the deliverable, this is the
 * mirror it is checked in.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";

/** Where the preview lives, derived from where the master lives. */
export function previewPathFor(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, "") + ".preview.webm";
}

export function encodePreview(
  input: string,
  output: string,
  options: { ffmpegPath?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffmpegPath ?? "ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-y",
      "-i", input,
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", "34",
      "-row-mt", "1",
      "-cpu-used", "5",
      "-pix_fmt", "yuv420p",
      "-c:a", "libopus",
      "-b:a", "96k",
      "-f", "webm",
      output,
    ]);

    // `-loglevel error` means this says nothing at all while it works, so a
    // stall limit would fire on a healthy encode. Only the clock can judge it.
    const deadline = guard(child, { ...LIMITS.preview, what: "encoding the browser-playable copy" });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      deadline.clear();
      reject(e);
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`preview encode exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });
}
