// A QR code encoder (ISO/IEC 18004) for the LAN section's "open on your
// phone" codes: byte mode, every version, the four error correction
// levels, and the mask chosen by the standard's penalty score. It runs in
// the page, so a code never goes through a web service. Tested against a
// reference encoder (qr.test.ts).

export type Ecc = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** Error correction: M (15 %) unless set. */
  ecc?: Ecc;
  /** Force a mask (0–7) instead of the best one. */
  mask?: number;
  /** The smallest version to use (1–40). */
  minVersion?: number;
}

export interface Qr {
  version: number;
  size: number;
  mask: number;
  ecc: Ecc;
  /** modules[y][x]: true is dark. */
  modules: boolean[][];
}

// Per ECC level (L, M, Q, H) and version (index 0 unused).
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver: number, ecc: Ecc): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * BLOCKS[ecc][ver];
}

// ---- Reed–Solomon over GF(2^8), polynomial 0x11D ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// ---- data ----

function encodeData(bytes: Uint8Array, ver: number, ecc: Ecc): number[] {
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function withEcc(data: number[], ver: number, ecc: Ecc): number[] {
  const numBlocks = BLOCKS[ecc][ver];
  const eccLen = ECC_PER_BLOCK[ecc][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const block = [...dat];
    if (i < numShort) block.push(0);
    blocks.push(block.concat(rsRemainder(dat, divisor)));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

// ---- the matrix ----

class Matrix {
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.fn[y][x] = true;
  }
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function drawFormat(m: Matrix, ecc: Ecc, mask: number) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const n = m.size;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, n - 15 + i, bit(i));
  m.set(8, n - 8, true);
}

function drawFunctionPatterns(m: Matrix, ver: number, ecc: Ecc) {
  const n = m.size;
  for (let i = 0; i < n; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < n && y >= 0 && y < n) m.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver, n);
  const last = pos.length - 1;
  pos.forEach((cx, i) =>
    pos.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(m, ecc, 0); // reserves the area; drawn again with the mask
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(a, b, dark);
      m.set(b, a, dark);
    }
  }
}

function drawCodewords(m: Matrix, data: number[]) {
  const n = m.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!m.fn[y][x] && i < data.length * 8) {
          m.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number) {
  const f = MASKS[mask];
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.fn[y][x] && f(x, y)) m.modules[y][x] = !m.modules[y][x];
}

/** The standard's penalty score: lower is easier to scan. */
export function penalty(modules: boolean[][]): number {
  const n = modules.length;
  let score = 0;
  const addHistory = (run: number, history: number[]) => {
    if (history[0] === 0) run += n; // the light border before the first run
    history.pop();
    history.unshift(run);
  };
  const countFinders = (h: number[]) => {
    const u = h[1];
    const core = u > 0 && h[2] === u && h[3] === u * 3 && h[4] === u && h[5] === u;
    return (core && h[0] >= u * 4 && h[6] >= u ? 1 : 0) + (core && h[6] >= u * 4 && h[0] >= u ? 1 : 0);
  };
  const line = (get: (i: number) => boolean) => {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (get(i) === color) {
        run++;
        if (run === 5) s += 3;
        else if (run > 5) s++;
      } else {
        addHistory(run, history);
        if (!color) s += countFinders(history) * 40;
        color = get(i);
        run = 1;
      }
    }
    if (color) {
      addHistory(run, history);
      run = 0;
    }
    addHistory(run + n, history);
    return s + countFinders(history) * 40;
  };
  for (let y = 0; y < n; y++) score += line((x) => modules[y][x]);
  for (let x = 0; x < n; x++) score += line((y) => modules[y][x]);
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y][x]) dark++;
      if (y < n - 1 && x < n - 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes text (as UTF-8) in the smallest QR code that holds it. */
export function encodeQr(text: string, opts: QrOptions = {}): Qr {
  const ecc = opts.ecc ?? "M";
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(1, opts.minVersion ?? 1);
  for (; ; ver++) {
    if (ver > 40) throw new Error("This text is too long for a QR code.");
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= dataCodewords(ver, ecc) * 8) break;
  }
  const size = ver * 4 + 17;
  const codewords = withEcc(encodeData(bytes, ver, ecc), ver, ecc);
  const draw = (mask: number) => {
    const m = new Matrix(size);
    drawFunctionPatterns(m, ver, ecc);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormat(m, ecc, mask);
    return m;
  };
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      const p = penalty(draw(k).modules);
      if (p < best) {
        best = p;
        mask = k;
      }
    }
  }
  return { version: ver, size, mask, ecc, modules: draw(mask).modules };
}

/** An SVG path of the dark modules, one rectangle per horizontal run, offset by a quiet zone. */
export function qrPath(qr: Pick<Qr, "modules" | "size">, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      let w = 1;
      while (x + w < qr.size && qr.modules[y][x + w]) w++;
      parts.push(`M${x + border} ${y + border}h${w}v1h-${w}z`);
      x += w - 1;
    }
  }
  return parts.join("");
}
