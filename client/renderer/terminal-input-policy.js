// Terminal paste policy stays independent from the terminal renderer so the
// potentially destructive multi-line decision has a small, testable boundary.
export const MAX_PENDING_TERMINAL_INPUT_BYTES = 16 * 1024;

export function isMultilineTerminalPaste(value) {
  return /[\r\n]/.test(String(value == null ? '' : value));
}

export function terminalPasteText(value) {
  return String(value == null ? '' : value);
}

// Match UTF-8 byte accounting without relying on a Node-only Buffer in the
// renderer. Lone surrogates are encoded as U+FFFD by TextEncoder, also 3 bytes.
export function utf8ByteLength(value) {
  const text = terminalPasteText(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
