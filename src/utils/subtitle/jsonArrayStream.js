/** Append-only JSON array framing. Each character and completed record is processed once. */
export class JsonArrayStream {
  constructor() {
    this.offset = 0;
    this.depth = 0;
    this.quoted = false;
    this.escaped = false;
    this.start = -1;
    this.started = false;
    this.done = false;
    this.records = 0;
    this.separator = false;
    this.afterComma = false;
  }

  append(text) {
    if (typeof text !== 'string' || text.length < this.offset || text.length > 8 * 1024 * 1024) {
      throw new Error('Subtitle stream must be append-only and bounded.');
    }
    const result = [];
    for (; this.offset < text.length; this.offset += 1) {
      const char = text[this.offset];
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
        continue;
      }
      if (!this.started) {
        if (/\s/.test(char)) continue;
        if (char !== '[') throw new Error('Subtitle stream must be a JSON array.');
        this.started = true;
        continue;
      }
      if (this.done) {
        if (!/\s/.test(char)) throw new Error('Unexpected data after subtitle array.');
        continue;
      }
      if (this.depth === 0) {
        if (/\s/.test(char)) continue;
        if (char === ']') {
          if (this.afterComma) throw new Error('Trailing comma in subtitle array.');
          this.done = true;
          continue;
        }
        if (this.separator) {
          if (char !== ',') throw new Error('Missing subtitle record separator.');
          this.separator = false;
          this.afterComma = true;
          continue;
        }
        if (char !== '{') throw new Error('Subtitle array contains a non-object record.');
        this.afterComma = false;
      }
      if (char === '"') this.quoted = true;
      else if (char === '{') {
        if (this.depth === 0) this.start = this.offset;
        this.depth += 1;
        if (this.depth > 64) throw new Error('Subtitle JSON nesting limit exceeded.');
      } else if (char === '}') {
        this.depth -= 1;
        if (this.depth < 0) throw new Error('Unbalanced subtitle record.');
        if (this.depth === 0) {
          result.push({ index: this.records++, value: JSON.parse(text.slice(this.start, this.offset + 1)) });
          this.separator = true;
        }
      } else if (this.depth === 0 && char === ']') this.done = true;
      else if (this.depth === 0 && char !== ',' && !/\s/.test(char)) {
        throw new Error('Subtitle array contains a non-object record.');
      }
    }
    return result;
  }
}
