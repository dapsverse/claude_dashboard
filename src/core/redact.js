export const REDACTED = '[redacted]';

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A capture cut off before its END marker — truncated tool output, a killed subprocess, a log line
  // clipped mid-stream. Without this, the pattern above does not match at all and the key body below
  // is persisted verbatim. Runs to end of input deliberately: everything after BEGIN is key material.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,   // JWT
  // Long opaque blobs: base64 key bodies, long tokens. `\b` is useless here — a hex run embedded in a
  // base64 blob has word characters on both sides, so no word boundary exists to anchor on. Two
  // narrowings keep this from eating ordinary text: `/` is excluded from the class, so filesystem paths
  // survive into previews, and the lookaheads require the run to mix lower, upper, and digits the way
  // encoded key material does. Without them a 60-character camelCase identifier or any long unbroken
  // word is destroyed, which makes previews useless for the sake of a secret that was never there.
  /(?<![A-Za-z0-9+=])(?=[A-Za-z0-9+]{60,})(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[0-9])[A-Za-z0-9+]{60,}={0,2}(?![A-Za-z0-9+=])/g,
  /\b[0-9a-fA-F]{40,}\b/g,                                            // seeds, long digests
];

export function redact(text) {
  if (typeof text !== 'string') return '';
  return PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), text);
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function preview(text, max = 500) {
  return truncate(redact(text), max);
}
