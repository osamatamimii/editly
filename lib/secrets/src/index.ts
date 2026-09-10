/**
 * Secrets that belong to somebody else, at rest.
 *
 * `social_accounts` holds OAuth access and refresh tokens for YouTube, TikTok,
 * Instagram, Facebook and X. They were stored as plain text, and the shape of
 * that risk is worth stating exactly: a leaked backup of this database is not
 * an incident about our service. It is somebody else's YouTube channel, and a
 * refresh token is a key that keeps working until they think to revoke it,
 * which they will not, because nobody told them.
 *
 * Nothing here is clever. It is AES-256-GCM with a random nonce per value and
 * the version as associated data, which is the boring answer and the right one.
 *
 * ## Why an envelope rather than a column
 *
 * The sealed value carries its own key version, so the row needs no second
 * column and no migration has to run before this is safe. A column holding
 * either a legacy plaintext token or a sealed one is readable either way —
 * `isSealed` decides — and every write from now on seals, so the plaintext
 * disappears as connections refresh rather than in a migration that has to get
 * every row right on the first attempt.
 *
 * ## Why it fails closed
 *
 * With no key configured, `seal` throws rather than storing plain text. On a
 * deployment with no key that turns the first connect attempt into a loud
 * error instead of a quiet return to exactly the problem this fixes. It is
 * safe to be strict here for a reason that will not last: no platform app has
 * finished review yet, so there is no connection in existence to break. That
 * window is the cheapest one this change will ever have.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `SOCIAL_TOKEN_KEYS`: `version:base64key` pairs, comma separated, newest
 * first. Writing always uses the first; reading accepts any of them, which is
 * what makes a rotation a deploy rather than an outage — the new key goes in
 * front, the old one stays until the last value sealed under it has been
 * rewritten, and then it goes.
 *
 * Thirty-two bytes, base64. Anything else is a misconfiguration and is refused
 * at the point of use rather than silently truncated into a weaker key.
 */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealingKey {
  version: number;
  key: Buffer;
}

export function keysFrom(raw: string | undefined): SealingKey[] {
  if (!raw || !raw.trim()) return [];
  const keys: SealingKey[] = [];
  for (const part of raw.split(",")) {
    const at = part.indexOf(":");
    if (at < 1) continue;
    const version = Number.parseInt(part.slice(0, at).trim(), 10);
    if (!Number.isInteger(version) || version < 1) continue;
    const key = Buffer.from(part.slice(at + 1).trim(), "base64");
    if (key.length !== KEY_BYTES) continue;
    keys.push({ version, key });
  }
  return keys;
}

/** Read once. A key that changes under a running process is not a rotation. */
let cached: SealingKey[] | null = null;

export function sealingKeys(): SealingKey[] {
  if (cached === null) cached = keysFrom(process.env["SOCIAL_TOKEN_KEYS"]);
  return cached;
}

/** For tests, which need to install a key without a process restart. */
export function useKeys(keys: SealingKey[] | null): void {
  cached = keys;
}

export class NoSealingKey extends Error {
  constructor() {
    super("no token key: set SOCIAL_TOKEN_KEYS before connecting an account");
    this.name = "NoSealingKey";
  }
}

export class CannotOpen extends Error {
  constructor(why: string) {
    super(`this stored token cannot be read: ${why}`);
    this.name = "CannotOpen";
  }
}

const PREFIX = "v";

/** Whether a stored value is one of ours, as opposed to a legacy plaintext. */
export function isSealed(value: string | null | undefined): boolean {
  if (!value || !value.startsWith(PREFIX)) return false;
  const parts = value.split(".");
  return parts.length === 4 && /^v\d+$/.test(parts[0]!);
}

/**
 * `v<version>.<nonce>.<tag>.<ciphertext>`, all base64url.
 *
 * The version is outside the ciphertext because the reader needs it to choose
 * a key, and it is *also* the associated data, so a value cannot be replayed
 * under a different version than the one it was sealed with.
 */
export function seal(plain: string, keys: SealingKey[] = sealingKeys()): string {
  const [newest] = keys;
  if (!newest) throw new NoSealingKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", newest.key, nonce);
  const label = `${PREFIX}${newest.version}`;
  cipher.setAAD(Buffer.from(label, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [label, nonce.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

export function open(sealed: string, keys: SealingKey[] = sealingKeys()): string {
  const [label, nonceRaw, tagRaw, bodyRaw] = sealed.split(".");
  if (!label || !nonceRaw || !tagRaw || !bodyRaw) throw new CannotOpen("it is not in the stored shape");
  const version = Number.parseInt(label.slice(PREFIX.length), 10);
  const found = keys.find((k) => k.version === version);
  if (!found) throw new CannotOpen(`it was sealed with key ${version}, which this deployment does not have`);

  const nonce = Buffer.from(nonceRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new CannotOpen("its header is the wrong size");

  const decipher = createDecipheriv("aes-256-gcm", found.key, nonce);
  decipher.setAAD(Buffer.from(label, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // The tag failing is the only interesting failure here, and it means the
    // value was altered or the key is wrong. Both are the same answer to the
    // caller and neither should say which.
    throw new CannotOpen("it does not verify");
  }
}

/**
 * Read a column that may hold either.
 *
 * Null for a value that cannot be read, rather than a throw: a connection
 * whose token is unreadable is a connection to reconnect, and the publisher
 * already knows how to say that. Throwing here would turn one bad row into a
 * failed sweep for everybody else's posts.
 */
export function openStored(value: string | null | undefined, keys: SealingKey[] = sealingKeys()): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isSealed(value)) return value;
  try {
    return open(value, keys);
  } catch {
    return null;
  }
}

/** Seal for storage, leaving null alone. */
export function sealStored(value: string | null | undefined, keys: SealingKey[] = sealingKeys()): string | null {
  if (value === null || value === undefined || value === "") return null;
  return seal(value, keys);
}

/** Constant-time equality, for the rare place a token is compared. */
export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
