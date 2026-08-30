/**
 * A minimal DER *encoder*, used only by the bridge tests.
 *
 * Written independently of `bridge/lib/der.mjs` so the parser is checked against
 * something other than itself, and used to synthesise a `key4.db` and
 * `logins.json` whose plaintext the test already knows.
 */

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  const body = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export const seq = (...children) => tlv(0x30, Buffer.concat(children.map(Buffer.from)));
export const octet = (value) => tlv(0x04, Buffer.from(value));
export const nullValue = () => tlv(0x05, Buffer.alloc(0));

export function integer(value) {
  const bytes = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  // DER integers are signed; prefix a zero if the top bit is set.
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

export function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let remaining = part;
    do {
      chunk.unshift(remaining & 0x7f);
      remaining >>= 7;
    } while (remaining > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
