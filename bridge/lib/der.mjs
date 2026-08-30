/**
 * A minimal DER reader.
 *
 * NSS stores its key material as PKCS#5 / PKCS#8 structures, and the two
 * structures FireSync needs are small and fixed. A general ASN.1 library would
 * be a large dependency in a process that handles a user's entire password
 * store; this is 90 lines and does exactly what is needed.
 */

export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
};

/** Read one tag-length-value at `offset`. */
export function readTlv(buffer, offset = 0) {
  if (offset >= buffer.length) throw new Error('DER: truncated at tag');
  const tag = buffer[offset];
  let cursor = offset + 1;

  if (cursor >= buffer.length) throw new Error('DER: truncated at length');
  let length = buffer[cursor++];

  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error(`DER: unsupported length form (${count} bytes)`);
    if (cursor + count > buffer.length) throw new Error('DER: truncated long length');
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | buffer[cursor++];
  }

  const valueStart = cursor;
  const valueEnd = valueStart + length;
  if (valueEnd > buffer.length) throw new Error('DER: value runs past the end of the buffer');

  return {
    tag,
    length,
    valueStart,
    valueEnd,
    value: buffer.subarray(valueStart, valueEnd),
    end: valueEnd,
  };
}

/** Parse a DER buffer into a tree of `{tag, value, children}`. */
export function parse(buffer, offset = 0) {
  const tlv = readTlv(buffer, offset);
  const node = { tag: tlv.tag, value: tlv.value, end: tlv.end };

  // Bit 0x20 marks a constructed type, whose contents are more TLVs.
  if (tlv.tag & 0x20) {
    node.children = [];
    let cursor = tlv.valueStart;
    while (cursor < tlv.valueEnd) {
      const child = parse(buffer, cursor);
      node.children.push(child);
      cursor = child.end;
    }
  }
  return node;
}

/** Decode an OID value into its dotted form. */
export function decodeOid(value) {
  if (value.length === 0) throw new Error('DER: empty OID');
  const parts = [Math.floor(value[0] / 40), value[0] % 40];
  let accumulator = 0;
  for (let i = 1; i < value.length; i++) {
    accumulator = accumulator * 128 + (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      parts.push(accumulator);
      accumulator = 0;
    }
  }
  return parts.join('.');
}

/** Read an unsigned INTEGER. Rejects anything that would lose precision. */
export function decodeInteger(value) {
  if (value.length > 6) throw new Error('DER: integer too large');
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

/** Navigate a parsed tree by child index, e.g. `at(node, 0, 1, 0)`. */
export function at(node, ...path) {
  let current = node;
  for (const index of path) {
    if (!current?.children?.[index]) {
      throw new Error(`DER: no child at path ${path.join('.')}`);
    }
    current = current.children[index];
  }
  return current;
}

/** Strip PKCS#7 padding, validating it rather than trusting the last byte. */
export function unpad(buffer, blockSize) {
  if (buffer.length === 0 || buffer.length % blockSize !== 0) {
    throw new Error('padding: ciphertext is not a whole number of blocks');
  }
  const padding = buffer[buffer.length - 1];
  if (padding < 1 || padding > blockSize || padding > buffer.length) {
    throw new Error('padding: invalid length byte');
  }
  for (let i = buffer.length - padding; i < buffer.length; i++) {
    if (buffer[i] !== padding) throw new Error('padding: inconsistent bytes');
  }
  return buffer.subarray(0, buffer.length - padding);
}
