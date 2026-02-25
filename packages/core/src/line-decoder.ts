export interface LineDecoder {
  push(chunk: string | Uint8Array): string[];
  flush(): string[];
  getPending(): string;
}

export function createLineDecoder(): LineDecoder {
  const decoder = new TextDecoder();
  let pending = '';

  const extractLines = (source: string): string[] => {
    const lines: string[] = [];
    let cursor = 0;

    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== '\n') {
        continue;
      }

      let line = source.slice(cursor, index);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      lines.push(line);
      cursor = index + 1;
    }

    pending = source.slice(cursor);
    return lines;
  };

  return {
    push(chunk) {
      const decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      return extractLines(pending + decoded);
    },
    flush() {
      const rest = decoder.decode();
      const source = pending + rest;
      pending = '';

      if (source.length === 0) {
        return [];
      }

      return [source.endsWith('\r') ? source.slice(0, -1) : source];
    },
    getPending() {
      return pending;
    },
  };
}
