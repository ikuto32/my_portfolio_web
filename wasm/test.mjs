// lab.wasm の動作確認。Deno でも Node でも動く。
//   deno run --allow-read wasm/test.mjs
//   node wasm/test.mjs
import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('../public/assets/wasm/lab.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const x = instance.exports;
const u8 = () => new Uint8Array(x.memory.buffer);

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  (${detail})`}`);
}

// --- cloud -----------------------------------------------------------------
const points = x.cloud_init(32);
check('cloud_init builds points', points > 10000 && points <= 20000, points);

const [w, h] = [640, 400];
const drawn = x.cloud_render(w, h, 0.6, 0.35, 150, w / 2, h / 2, 1.0, -1, -1, 1, 1);
check('cloud_render draws most points', drawn > points * 0.9, drawn);

const fb = u8().subarray(x.fb_ptr(), x.fb_ptr() + w * h * 4);
let lit = 0;
for (let i = 3; i < fb.length; i += 4) if (fb[i]) lit += 1;
check('framebuffer has lit pixels', lit > 3000, lit);

const bbox = new Float32Array(x.memory.buffer, x.cloud_bbox_ptr(), 4);
check('bbox is inside the frame and non-empty',
  bbox[2] > bbox[0] && bbox[3] > bbox[1] && bbox[0] > 0 && bbox[2] < w, Array.from(bbox, Math.round).join(','));

check('oversized frame is rejected', x.cloud_render(4000, 4000, 0, 0, 100, 0, 0, 0, -1, -1, 1, 1) === 0);

// --- glyph -----------------------------------------------------------------
// 横棒（長さ 200・太さ 21）を細線化すると、長さおよそ 180〜200 の1本線になるはず
const g = 256;
const mask = u8().subarray(x.glyph_ptr(), x.glyph_ptr() + g * g);
mask.fill(0);
for (let y = 118; y < 139; y += 1) for (let xx = 28; xx < 228; xx += 1) mask[y * g + xx] = 1;
const ink = x.glyph_begin(g, g);
check('glyph_begin counts ink', ink === 200 * 21, ink);

let iterations = 0;
while (x.thin_step(g, g) > 0 && iterations < 200) iterations += 1;
check('thinning converges', iterations > 5 && iterations < 40, `${iterations} iterations`);

let left = 0;
let thickest = 0;
const after = u8().subarray(x.glyph_ptr(), x.glyph_ptr() + g * g);
for (let xx = 0; xx < g; xx += 1) {
  let column = 0;
  for (let y = 0; y < g; y += 1) column += after[y * g + xx];
  left += column;
  thickest = Math.max(thickest, column);
}
check('skeleton is one pixel thick', thickest === 1, `thickest column ${thickest}, ${left} px left`);

const length = x.skeleton_length(g, g);
check('skeleton length matches the bar', length > 170 && length < 205, length.toFixed(1));

x.glyph_render(g, g, 1);
const gfb = u8().subarray(x.glyph_fb_ptr(), x.glyph_fb_ptr() + g * g * 4);
let accent = 0;
for (let i = 0; i < gfb.length; i += 4) if (gfb[i] === 255 && gfb[i + 3] === 255) accent += 1;
check('finished skeleton is painted in accent', accent > 400, accent);

// --- rd --------------------------------------------------------------------
const r = x.rd_size();
x.rd_reset(7);
x.rd_step(400, 0.0367, 0.0649);
x.rd_render(0, r);
x.rd_render(1, 8);
const hi = u8().slice(x.rd_fb_ptr(0), x.rd_fb_ptr(0) + r * r * 4);
const lo = u8().slice(x.rd_fb_ptr(1), x.rd_fb_ptr(1) + r * r * 4);

const colours = (buf) => {
  const seen = new Set();
  for (let i = 0; i < buf.length; i += 4) seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
  return seen.size;
};
check('pattern survives 400 steps', colours(hi) > 20, `${colours(hi)} colours`);
check('8×8 level has at most 64 colours', colours(lo) <= 64 && colours(lo) > 1, `${colours(lo)} colours`);

// 全面を消すと 1 色になり、触ったところからまた模様が出る
x.rd_erase(r / 2, r / 2, r);
x.rd_render(0, r);
const wiped = u8().slice(x.rd_fb_ptr(0), x.rd_fb_ptr(0) + r * r * 4);
check('rd_erase clears the field', colours(wiped) === 1, `${colours(wiped)} colours`);
x.rd_touch(r / 2, r / 2, 6);
x.rd_step(200, 0.0367, 0.0649);
x.rd_render(0, r);
const regrown = colours(u8().slice(x.rd_fb_ptr(0), x.rd_fb_ptr(0) + r * r * 4));
check('rd_touch seeds a new pattern', regrown > 5, `${regrown} colours`);

let blocky = true;
const block = r / 8;
for (let i = 0; i < block * 4; i += 4) if (lo[i] !== lo[0] || lo[i + 1] !== lo[1]) blocky = false;
check('8×8 level is flat inside a block', blocky);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
if (failed) throw new Error('lab.wasm checks failed');
