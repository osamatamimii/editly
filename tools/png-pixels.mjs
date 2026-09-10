/**
 * Enough of a PNG decoder to look at a screenshot.
 *
 * The suites in here have one blind spot in common: they all ask the page
 * questions, and a page will happily answer that an element is present, sized,
 * opaque and correctly styled while it is painted underneath something else.
 * That is not a hypothetical — the hero's whole background canvas shipped
 * invisible exactly that way. The only witness that would have caught it is
 * the picture.
 *
 * Rather than take a dependency for it, this reads what Chromium actually
 * writes: a non-interlaced, 8-bit RGBA PNG. Both of those are guaranteed by
 * `page.screenshot()`, and anything else throws rather than guessing.
 */
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Undo one scanline's filter, in place, against the line above it. */
function unfilter(type, line, prev, bpp) {
  switch (type) {
    case 0:
      break;
    case 1: // Sub
      for (let i = bpp; i < line.length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2: // Up
      for (let i = 0; i < line.length; i += 1) line[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3: // Average
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < line.length; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pick = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pick) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown PNG filter ${type}`);
  }
  return line;
}

/** `{ width, height, at(x, y) -> [r, g, b, a] }` for an 8-bit RGBA PNG. */
export function readPng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`expected 8-bit PNG, got ${depth}`);
      if (interlace !== 0) throw new Error("interlaced PNG");
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (!channels) throw new Error(`expected RGB or RGBA PNG, got colour type ${colour}`);
    } else if (kind === "IDAT") {
      parts.push(body);
    } else if (kind === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start], line, prev, channels);
    line.copy(pixels, y * stride);
    prev = line;
  }
  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * channels;
      return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255];
    },
  };
}

/** Rec. 709 luma, which is what "brighter" should mean to an eye. */
export const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean and peak luma over a screenshot, sampled on a grid to stay cheap. */
export function brightness(buffer, step = 2) {
  const png = readPng(buffer);
  let total = 0;
  let seen = 0;
  let peak = 0;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const value = luma(png.at(x, y));
      total += value;
      peak = Math.max(peak, value);
      seen += 1;
    }
  }
  return { mean: total / seen, peak };
}
