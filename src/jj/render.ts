// 渲染：逐帧合成。视频素材由 ffmpeg 解码成帧（对时长、裁 9:16 在 ffmpeg 里做），
// 图片和截图在画布上推拉，金句卡在画布上排字；转场、弹字、表情包、字幕、来源标注都画在画布上；最后和配音一起编码。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { buildSubtitles, resolveAnchor, stripPunct } from '../core/alignment';
import { loadAppendix } from '../core/appendix';
import { type Project, type Asset, type Shot, LICENSES, mediaFor, W, H, CARD, fillLoss } from './project';
import { type Timed, videoPlan } from './shots';
import { fonts } from './media';

/** 抖音、视频号界面挡住的地方：顶部状态栏和搜索、底部文案和导航、右侧按钮列 */
export const SAFE = { top: 170, bottom: 400, right: 150, rightFrom: 860 };
export const SUB = { y: 1500, size: 64, max: 13 };

type Ctx = any;
const ease = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

class Reader {
  private ended = false;
  private chunks: Buffer[] = [];
  private len = 0;
  private wake: (() => void) | null = null;
  constructor(private proc: ChildProcess, readonly size: number) {
    const s = proc.stdout!;
    s.on('data', (c: Buffer) => { this.chunks.push(c); this.len += c.length; if (this.len > size * 3) s.pause(); this.wake?.(); });
    s.on('end', () => { this.ended = true; this.wake?.(); });
    proc.on('error', () => { this.ended = true; this.wake?.(); });
  }
  async next(): Promise<Buffer | null> {
    while (this.len < this.size && !this.ended) await new Promise<void>(r => (this.wake = () => { this.wake = null; r(); }));
    if (this.len < this.size) return null;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, this.size), rest = all.subarray(this.size);
    this.chunks = rest.length ? [rest] : []; this.len = rest.length;
    if (this.len < this.size * 3) this.proc.stdout!.resume();
    return out;
  }
  kill() { try { this.proc.kill('SIGKILL'); } catch { /* 已经结束 */ } }
}

function focusXY(f: Shot['focus']): [number, number] {
  if (typeof f === 'number') return [f, 0.5];
  return f === 'left' ? [0.15, 0.5] : f === 'right' ? [0.85, 0.5] : f === 'top' ? [0.5, 0.15] : f === 'bottom' ? [0.5, 0.85] : [0.5, 0.5];
}

/** 一个镜头的底层画面：每一帧调用 draw(ctx, i) */
interface Layer { draw(ctx: Ctx, i: number, n: number): Promise<void>; close(): void }

function blurBg(src: any, sw: number, sh: number, cw: number, ch: number): any {
  const bg = createCanvas(cw, ch), b = bg.getContext('2d');
  const s = Math.max(cw / sw, ch / sh) * 1.1;
  b.filter = `blur(${Math.round(cw / 28)}px)`;
  b.drawImage(src, (cw - sw * s) / 2, (ch - sh * s) / 2, sw * s, sh * s);
  b.filter = 'none'; b.fillStyle = 'rgba(0,0,0,0.45)'; b.fillRect(0, 0, cw, ch);
  return bg;
}

/** 默认不裁画面：宽高比和画框差得多（裁掉超过一成），就整幅放进去、空处垫模糊底。画面里的字不会被切掉 */
function fitMode(s: Shot, a: Asset, cw: number, ch: number): 'fill' | 'frame' {
  if (s.fit) return s.fit;
  if (a.kind === 'page') return 'fill';
  return fillLoss(a, s.crop, cw, ch) > 0.1 ? 'frame' : 'fill';
}

async function videoLayer(p: Project, s: Timed, a: Asset, cw: number, ch: number, fps: number): Promise<Layer> {
  const dur = s.t1 - s.t0, from = s.from ?? 0, vp = videoPlan(a, from, dur);
  const m = mediaFor(p.dir, a, from, dur);
  const mode = fitMode(s, a, cw, ch), [fx, fy] = focusXY(s.focus);
  const c = s.crop ?? [0, 0, 1, 1];
  const aw = (a.w ?? 1920) * c[2], ah = (a.h ?? 1080) * c[3];
  const pre = s.crop ? `crop=trunc(iw*${c[2]}/2)*2:trunc(ih*${c[3]}/2)*2:iw*${c[0]}:ih*${c[1]},` : '';
  let w = cw, h = ch, geo: string;
  if (mode === 'fill') geo = `scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-${cw})*${fx}:(ih-${ch})*${fy}`;
  else {
    { const k = Math.min(cw / aw, (ch * 0.86) / ah); w = 2 * Math.round((aw * k) / 2); h = 2 * Math.round((ah * k) / 2); }
    geo = `scale=${w}:${h}`;
  }
  geo = pre + geo;
  const srcDur = Math.min(dur * vp.speed, Math.max(0.1, (a.duration ?? dur) - from)) + 0.2;
  const args = ['-v', 'error', '-ss', String(Math.max(0, from - m.offset)), '-i', m.file, '-t', srcDur.toFixed(3), '-vf', `setpts=${(1 / vp.speed).toFixed(4)}*PTS,fps=${fps},${geo},format=rgba`, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const reader = new Reader(proc, w * h * 4);
  const src = createCanvas(w, h), sctx = src.getContext('2d');
  let bg: any = null, have = false, frozenAt = -1;
  return {
    async draw(ctx, i, n) {
      const buf = frozenAt < 0 ? await reader.next() : null;
      if (buf) { sctx.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), w, h), 0, 0); have = true; }
      else if (frozenAt < 0) frozenAt = i;
      if (!have) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); return; }
      // 素材不够长：定格，慢慢推近
      const z = frozenAt >= 0 ? 1 + 0.08 * ease((i - frozenAt) / Math.max(1, n - frozenAt)) : 1;
      if (mode === 'frame') {
        bg ??= blurBg(src, w, h, cw, ch);
        ctx.drawImage(bg, 0, 0);
        const y = (ch - h) / 2 - (ch / cw > 1.3 ? ch * 0.06 : 0);
        const zf = Math.min(z, cw / w, ch / h);  // 整幅放的画面推近也不出框，字不会被切
        ctx.drawImage(src, (cw - w * zf) / 2, y + (h - h * zf) / 2, w * zf, h * zf);
      } else ctx.drawImage(src, (cw - cw * z) / 2, (ch - ch * z) / 2, cw * z, ch * z);
    },
    close() { reader.kill(); },
  };
}

/** 网页截图的上下边缘淡成白色：切在半行字上的地方不扎眼 */
function pageFade(ctx: Ctx, cw: number, ch: number) {
  const f = Math.round(ch * 0.07);
  for (const [y0, y1] of [[0, f], [ch, ch - f]]) { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, Math.min(y0, y1), cw, f); }
}

async function stillLayer(p: Project, s: Timed, a: Asset, cw: number, ch: number, k: number): Promise<Layer> {
  let img: any = await loadImage(join(p.dir, a.file));
  if (s.crop) { const c = s.crop, cc = createCanvas(Math.max(2, Math.round(img.width * c[2])), Math.max(2, Math.round(img.height * c[3]))); cc.getContext('2d').drawImage(img, -img.width * c[0], -img.height * c[1]); img = cc; }
  const iw = img.width, ih = img.height, mode = fitMode(s, a, cw, ch), [fx, fy] = focusXY(s.focus);
  const zoomIn = k % 2 === 0;
  const box = a.source.box;
  let bg: any = null;
  return {
    async draw(ctx, i, n) {
      const t = i / Math.max(1, n - 1);
      if (a.kind === 'page' && box) {
        // 截图镜头：先整屏，说着说着推近到那句原文，再画出高亮框
        // 不横向放大：整行字始终完整，只上下移动，把那句原文挪到画面中间偏上
        const s0 = cw / iw, e = ease(t * 1.4), z = 1;
        const cy = (box[1] + box[3] / 2) * s0, maxUp = Math.max(0, ih * s0 - ch);
        const yEnd = -Math.min(maxUp, Math.max(0, cy - ch * 0.4)), y0 = -Math.min(maxUp, Math.max(0, cy - ch * 0.7));
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
        ctx.save(); ctx.translate(0, y0 + (yEnd - y0) * e);
        ctx.drawImage(img, 0, 0, iw * s0, ih * s0);
        const hl = ease((t - 0.2) / 0.25);
        if (hl > 0) {
          const pad = 8 * s0, bx = box[0] * s0 - pad, by = box[1] * s0 - pad, bw = (box[2] * s0 + pad * 2) * hl, bh = box[3] * s0 + pad * 2;
          ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(255,214,0,0.55)'; ctx.fillRect(bx, by, bw, bh); ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = '#e8322b'; ctx.lineWidth = 5 * s0 / z; ctx.strokeRect(bx, by, bw, bh);
        }
        ctx.restore();
        pageFade(ctx, cw, ch);
        return;
      }
      if (a.kind === 'page') {
        // 网页长截图：从上往下慢慢滚
        const s0 = cw / iw, travel = Math.max(0, ih * s0 - ch), y = -Math.min(travel, 50 * (cw / W) * (n / 30)) * t;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, y, iw * s0, ih * s0);
        pageFade(ctx, cw, ch);
        return;
      }
      const z = zoomIn ? 1 + 0.05 * t : 1.05 - 0.05 * t;
      if (mode === 'frame') {
        bg ??= blurBg(img, iw, ih, cw, ch);
        ctx.drawImage(bg, 0, 0);
        const base = Math.min(cw / iw, (ch * 0.9) / ih), s0 = base * Math.min(z, cw / (iw * base)), w = iw * s0, h = ih * s0;
        ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2 - (ch / cw > 1.3 ? ch * 0.06 : 0), w, h);
      } else {
        const s0 = Math.max(cw / iw, ch / ih) * z, w = iw * s0, h = ih * s0;
        const drift = (k % 4 < 2 ? 1 : -1) * 0.04 * t;
        ctx.drawImage(img, (cw - w) * Math.min(1, Math.max(0, fx + drift)), (ch - h) * fy, w, h);
      }
    },
    close() {},
  };
}

/** 一行字：白字黑边，可以给其中一段上色 */
function drawText(ctx: Ctx, text: string, x: number, y: number, size: number, o: { fill?: string; stroke?: string; lw?: number; accent?: string; accentColor?: string; align?: 'center' | 'left' } = {}) {
  const F = fonts();
  ctx.font = `${size}px ${F}`; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const chars = [...text], widths = chars.map(c => ctx.measureText(c).width), total = widths.reduce((s, v) => s + v, 0);
  let cx = o.align === 'left' ? x : x - total / 2;
  const acc = o.accent ? text.indexOf(o.accent) : -1, accEnd = acc >= 0 ? acc + o.accent!.length : -1;
  const pos: number[] = []; for (const w of widths) { pos.push(cx); cx += w; }
  if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.lw ?? size * 0.16; chars.forEach((c, i) => ctx.strokeText(c, pos[i], y)); }
  chars.forEach((c, i) => { const idx = chars.slice(0, i).join('').length; ctx.fillStyle = acc >= 0 && idx >= acc && idx < accEnd ? o.accentColor ?? '#ffd400' : o.fill ?? '#fff'; ctx.fillText(c, pos[i], y); });
  return total;
}
function wrap(ctx: Ctx, text: string, size: number, maxW: number): string[] {
  ctx.font = `${size}px ${fonts()}`;
  if (text.includes('\n')) return text.split('\n').flatMap(t => wrap(ctx, t, size, maxW));
  const out: string[] = []; let line = '';
  for (const c of [...text]) { if (ctx.measureText(line + c).width > maxW && line) { if (/^[，。、？！：；”）]$/.test(c)) { line += c; continue; } out.push(line); line = c; } else line += c; }
  if (line) out.push(line);
  // 最后一行只剩一个字：从上一行挪一个字下来
  if (out.length > 1 && [...out[out.length - 1]].length === 1) { const prev = [...out[out.length - 2]]; out[out.length - 1] = prev.pop()! + out[out.length - 1]; out[out.length - 2] = prev.join(''); }
  return out;
}

function titleLayer(s: Timed, cw: number, ch: number): Layer {
  const text = (s.text ?? s.sayNow).replace(/[，。、；：,.;:]+$/, '');
  return {
    async draw(ctx, i, n) {
      const sc = cw / W;
      const g = ctx.createRadialGradient(cw / 2, ch * 0.42, 50 * sc, cw / 2, ch * 0.42, ch * 0.75);
      g.addColorStop(0, '#2a2723'); g.addColorStop(1, '#0d0c0b'); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
      let size = 112 * sc, lines = wrap(ctx, text, size, 860 * sc);
      // 手动换了行（\n）的，每一行尽量不再被折开：缩字号直到放得下
      const want = text.split('\n').length;
      while ((lines.length > 4 || (want > 1 && lines.length > want)) && size > 60 * sc) { size *= 0.9; lines = wrap(ctx, text, size, 860 * sc); }
      const cy = ch / cw < 1.2 ? 0.5 : 0.42, lh = size * 1.32, y0 = ch * cy - ((lines.length - 1) * lh) / 2;
      const k = ease(i / (0.3 * 30));
      ctx.globalAlpha = k;
      lines.forEach((l, j) => drawText(ctx, l, cw / 2, y0 + j * lh + (1 - k) * 30 * sc, size, { fill: '#f5f1e8', accent: s.pop && l.includes(s.pop) ? s.pop : undefined, accentColor: '#ffcf33' }));
      ctx.globalAlpha = 1;
      void n;
    },
    close() {},
  };
}

function missingLayer(s: Timed, cw: number, ch: number): Layer {
  return {
    async draw(ctx) {
      const sc = cw / W;
      ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, cw, ch);
      drawText(ctx, `缺画面 · ${s.id}`, cw / 2, ch * 0.36, 72 * sc, { fill: '#ff8a80' });
      wrap(ctx, s.want ? `想要：${s.want}` : '还没写 want', 44 * sc, 860 * sc).slice(0, 4).forEach((l, j) => drawText(ctx, l, cw / 2, ch * 0.44 + j * 60 * sc, 44 * sc, { fill: '#ddd' }));
    },
    close() {},
  };
}

async function innerLayer(p: Project, s: Timed, assets: Record<string, Asset>, cw: number, ch: number, fps: number, k: number): Promise<Layer> {
  if (!s.use) return missingLayer(s, cw, ch);
  if (s.use === 'title') return titleLayer(s, cw, ch);
  if (s.use === 'chart') return s.chart ? chartLayer(s, cw, ch) : missingLayer(s, cw, ch);
  const a = assets[s.use];
  if (!a) return missingLayer(s, cw, ch);
  return a.kind === 'video' ? videoLayer(p, s, a, cw, ch, fps) : stillLayer(p, s, a, cw, ch, k);
}

/** 版式：card 是顶部标题条 + 中间一张卡片，画面放在卡片里；full 是铺满全屏 */
export const layoutOf = (p: Project, s: Shot): 'card' | 'full' => s.layout ?? (p.meta.layout === 'card' ? 'card' : 'full');
export { CARD };
/** 每一镜顶部标题条的字：写了 head 就换，不写沿用上一镜 */
export function resolveHeads(p: Project, timed: Timed[]): string[] {
  let cur = String(p.meta.headline ?? p.meta.title ?? '');
  return timed.map(s => (cur = s.head ?? cur));
}
const ACCENT = (p: Project) => String(p.meta.accent ?? '#e53935');
const bgCache = new Map<string, any>();
function cardBackground(p: Project, head: string, cw: number, ch: number): any {
  const key = `${head}|${cw}|${ACCENT(p)}`;
  if (bgCache.has(key)) return bgCache.get(key);
  const sc = cw / W, bg = createCanvas(cw, ch), b = bg.getContext('2d');
  const g = b.createLinearGradient(0, 0, 0, ch); g.addColorStop(0, '#1b1e24'); g.addColorStop(1, '#0c0d10');
  b.fillStyle = g; b.fillRect(0, 0, cw, ch);
  if (head) {
    let size = 84 * sc, lines = wrap(b, head, size, 960 * sc);
    while (lines.length > 2 && size > 48 * sc) { size *= 0.9; lines = wrap(b, head, size, 960 * sc); }
    const lh = size * 1.25, cy = (CARD.y - 120) * sc, y0 = cy - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, j) => drawText(b, l, cw / 2, y0 + j * lh, size, { fill: '#fff' }));
    b.fillStyle = ACCENT(p); b.fillRect(cw / 2 - 60 * sc, y0 + (lines.length - 1) * lh + size * 0.75, 120 * sc, 8 * sc);
  }
  if (bgCache.size > 6) bgCache.delete(bgCache.keys().next().value!);
  bgCache.set(key, bg);
  return bg;
}

async function layerFor(p: Project, s: Timed, assets: Record<string, Asset>, cw: number, ch: number, fps: number, k: number, head = ''): Promise<Layer> {
  if (layoutOf(p, s) !== 'card') return innerLayer(p, s, assets, cw, ch, fps, k);
  const sc = cw / W, x = CARD.x * sc, y = CARD.y * sc, w = Math.round(CARD.w * sc), h = Math.round(CARD.h * sc), r = 28 * sc;
  const inner = await innerLayer(p, s, assets, w, h, fps, k);
  const card = createCanvas(w, h), cctx = card.getContext('2d');
  return {
    async draw(ctx, i, n) {
      ctx.drawImage(cardBackground(p, head, cw, ch), 0, 0);
      await inner.draw(cctx, i, n);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 40 * sc; ctx.shadowOffsetY = 10 * sc;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = '#000'; ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.clip(); ctx.drawImage(card, x, y);
      ctx.restore();
    },
    close() { inner.close(); },
  };
}

/** 原生数据图：横条一根根长出来（标红的那根最后、最醒目），或者折线从左往右画出来 */
function chartLayer(s: Timed, cw: number, ch: number): Layer {
  const c = s.chart!, sc = cw / W, F = fonts();
  const hl = new Set(Array.isArray(c.highlight) ? c.highlight : c.highlight != null ? [c.highlight] : []);
  const data = c.data ?? [], unit = c.unit ?? '';
  const fmtV = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(Math.abs(v) < 10 ? 1 : 0)}${unit}`;
  return {
    async draw(ctx, i, n) {
      const t = i / 30;
      ctx.fillStyle = '#f7f4ee'; ctx.fillRect(0, 0, cw, ch);
      let top = 50 * sc;
      if (c.title) { drawText(ctx, c.title, cw / 2, top + 30 * sc, 52 * sc, { fill: '#1f1d1b' }); top += 100 * sc; }
      const bottom = ch - (c.note ? 70 : 40) * sc;
      if (c.note) { ctx.font = `${26 * sc}px ${F}`; ctx.fillStyle = '#8c8781'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(c.note, cw / 2, ch - 40 * sc); ctx.textAlign = 'left'; }
      const max = Math.max(...data.map(d => Math.abs(d[1])), 1e-9);
      if ((c.type ?? 'bar') === 'bar') {
        const rows = data.length, gap = (bottom - top) / Math.max(rows, 1), bh = Math.min(gap * 0.62, 90 * sc);
        ctx.font = `${40 * sc}px ${F}`;
        const labW = Math.max(...data.map(d => ctx.measureText(d[0]).width)) + 30 * sc, x0 = 40 * sc + labW;
        ctx.font = `${50 * sc}px ${F}`;
        const valW = Math.max(...data.map(d => ctx.measureText(fmtV(d[1])).width)) + 50 * sc, maxW = Math.max(cw * 0.25, cw - x0 - valW);
        const stagger = Math.min(0.35, (n / 30) * 0.5 / Math.max(rows, 1));
        data.forEach(([lab, v], j) => {
          const y = top + gap * (j + 0.5), on = hl.has(lab), e = ease((t - j * stagger) / 0.5);
          drawText(ctx, lab, x0 - 20 * sc - ctx.measureText(lab).width / 2, y, 40 * sc, { fill: on ? '#c4402f' : '#3a3632' });
          ctx.fillStyle = on ? '#d9433a' : '#8fa3b3'; ctx.beginPath(); ctx.roundRect(x0, y - bh / 2, Math.max(2, (Math.abs(v) / max) * maxW * e), bh, 8 * sc); ctx.fill();
          if (e > 0.05) { ctx.globalAlpha = Math.min(1, e * 1.5); drawText(ctx, fmtV(v), x0 + (Math.abs(v) / max) * maxW * e + 20 * sc, y, (on ? 50 : 40) * sc, { fill: on ? '#c4402f' : '#3a3632', align: 'left' }); ctx.globalAlpha = 1; }
        });
      } else {
        const vals = data.map(d => d[1]), lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12 || 1;
        const x0 = 90 * sc, x1 = cw - 120 * sc, y0 = bottom - 60 * sc, y1 = top + 40 * sc;
        const X = (j: number) => x0 + ((x1 - x0) * j) / Math.max(1, data.length - 1), Y = (v: number) => y0 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (y0 - y1);
        ctx.strokeStyle = '#d6d0c4'; ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
        const e = ease(t / Math.max(0.6, (n / 30) * 0.6)), upto = e * (data.length - 1);
        ctx.strokeStyle = '#d9433a'; ctx.lineWidth = 8 * sc; ctx.lineJoin = 'round'; ctx.beginPath();
        for (let j = 0; j <= Math.floor(upto); j++) (j ? ctx.lineTo(X(j), Y(vals[j])) : ctx.moveTo(X(j), Y(vals[j])));
        const fj = Math.floor(upto), fr = upto - fj;
        if (fj < data.length - 1) ctx.lineTo(X(fj) + (X(fj + 1) - X(fj)) * fr, Y(vals[fj]) + (Y(vals[fj + 1]) - Y(vals[fj])) * fr);
        ctx.stroke();
        data.forEach(([lab, v], j) => {
          if (j > upto + 1e-6) return;
          const on = hl.has(lab) || j === 0 || j === data.length - 1;
          ctx.fillStyle = '#d9433a'; ctx.beginPath(); ctx.arc(X(j), Y(v), (on ? 12 : 6) * sc, 0, Math.PI * 2); ctx.fill();
          if (on) drawText(ctx, fmtV(v), X(j), Y(v) - 44 * sc, 42 * sc, { fill: '#c4402f' });
          if (on || data.length <= 8) drawText(ctx, lab, X(j), y0 + 40 * sc, 32 * sc, { fill: '#5a554f' });
        });
      }
    },
    close() {},
  };
}

/** 来源标注：授权需要署名、或者是评论性引用的素材，画面左上角标出出处 */
export function creditLine(a: Asset): string {
  const s = a.source, who = [s.author, s.site].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' / ');
  return `${who || (s.url.startsWith('file://') ? LICENSES[s.license]?.name ?? '' : s.url)}${LICENSES[s.license]?.credit && s.license.startsWith('cc') ? ` · ${LICENSES[s.license].name}` : ''}`;
}

/** 片尾附录：项目的 appendix.yaml，加上自动生成的“素材来源”。画成一张长图，从下往上滚 */
async function appendixSheet(p: Project, timed: Timed[], assets: Record<string, Asset>, cw: number): Promise<any | null> {
  const { appendix } = loadAppendix(p.dir);
  const sections: { title: string; note?: string; items: { when?: string; tag?: string; title: string; text?: string }[] }[] = appendix ? [...appendix.sections] : [];
  const used = [...new Set(timed.flatMap(s => [s.use, s.meme?.use]).filter((u): u is string => !!u && u !== 'title' && !!assets[u]))];
  if (used.length) sections.push({ title: '画面素材来源', items: used.map(id => { const a = assets[id], shots = timed.filter(s => s.use === id || s.meme?.use === id).map(s => s.id); const local = a.source.url.startsWith('file://'); return { tag: shots.length > 4 ? `${shots.slice(0, 3).join(' ')} 等 ${shots.length} 镜` : shots.join(' '), title: a.source.title?.slice(0, 40) || a.source.site || id, text: local ? `${LICENSES[a.source.license]?.name ?? a.source.license}${a.note ? `：${a.note}` : ''}`.slice(0, 160) : `${creditLine(a)}（${LICENSES[a.source.license]?.name ?? a.source.license}${a.purpose === 'quote' ? '，评论引用' : ''}${a.source.via === 'upload' ? '，上传文件' : ''}）${a.source.page ?? a.source.url}`.slice(0, 160) }; }) });
  const charts = timed.filter(s => s.use === 'chart' && s.chart);
  if (charts.length) sections.push({ title: '图表数据来源', items: charts.map(s => ({ tag: s.id, title: s.chart!.title ?? s.sayNow.slice(0, 30), text: [s.chart!.data.map(([k, v]) => `${k} ${v}${s.chart!.unit ?? ''}`).join('；'), s.chart!.note].filter(Boolean).join('。').slice(0, 200) })) });
  if (!sections.length) return null;
  const sc = cw / W, F = fonts();
  const tmp = createCanvas(cw, 10).getContext('2d');
  type Row = { y: number; draw: (c: Ctx, y: number) => void };
  const rows: Row[] = []; let y = 0;
  const lineRows = (text: string, size: number, color: string, indent = 0) => { for (const l of wrap(tmp, text, size, cw - (120 + indent) * sc)) { const yy = y; rows.push({ y: yy, draw: (c, oy) => { c.font = `${size}px ${F}`; c.fillStyle = color; c.textBaseline = 'top'; c.fillText(l, (60 + indent) * sc, oy + yy); } }); y += size * 1.35; } };
  for (const s of sections) {
    lineRows(s.title, 60 * sc, '#ffd34d'); y += 10 * sc;
    if (s.note) { lineRows(s.note, 34 * sc, '#bbb'); y += 8 * sc; }
    for (const it of s.items) {
      lineRows([it.when, it.tag].filter(Boolean).join('  ') ? `${[it.when, it.tag].filter(Boolean).join('  ')}　${it.title}` : it.title, 40 * sc, '#fff');
      if (it.text) lineRows(it.text, 30 * sc, '#c8c8c8', 30);
      y += 18 * sc;
    }
    y += 50 * sc;
  }
  const sheet = createCanvas(cw, Math.ceil(y) + 10), c = sheet.getContext('2d');
  for (const r of rows) r.draw(c, 0);
  return sheet;
}

export interface RenderOpts { out: string; draft?: boolean; /** 草稿也出全尺寸（仍带水印） */ full?: boolean; from?: number; to?: number; appendix?: boolean; log?: (s: string) => void }

export async function renderVideo(p: Project, timed: Timed[], assets: Record<string, Asset>, o: RenderOpts): Promise<{ file: string; seconds: number; frames: number; cuts: { id: string; t: number }[] }> {
  const log = o.log ?? console.log;
  const draft = !!o.draft, low = draft && !o.full, scale = low ? 0.5 : 1, fps = low ? 15 : p.fps;
  const cw = Math.round(W * scale / 2) * 2, ch = Math.round(H * scale / 2) * 2, sc = cw / W;
  const cv = createCanvas(cw, ch), ctx = cv.getContext('2d');
  const F = fonts();
  const narr = p.duration;
  const subs = p.meta.subtitles === false ? [] : buildSubtitles(p.al!, SUB.max);
  const sheet = o.appendix === false || o.from != null || o.to != null ? null : await appendixSheet(p, timed, assets, cw);
  const speed = 170 * sc, holdEnd = 1.5;
  const appDur = sheet ? (sheet.height + ch * 0.1) / speed + holdEnd : 0;
  const from = o.from ?? 0, to = Math.min(o.to ?? narr + appDur, narr + appDur);
  const total = Math.round((to - from) * fps);
  mkdirSync(join(o.out, '..'), { recursive: true });
  // 先写到临时文件，合成成功才换上：中断的、同时跑的两次渲染不会把成片写坏
  const partial = `${o.out}.${process.pid}.part`;
  const ff = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cw}x${ch}`, '-r', String(fps), '-i', '-'];
  if (p.audio) ff.push('-ss', String(from), '-i', p.audio);
  ff.push('-map', '0:v'); if (p.audio) ff.push('-map', '1:a', '-af', 'apad');
  ff.push('-t', (to - from).toFixed(3), '-c:v', 'libx264', '-preset', low ? 'veryfast' : 'medium', '-crf', low ? '28' : '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', partial);
  const enc = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>(r => enc.on('close', c => r(c ?? 1)));
  // 弹字、表情包的时间
  const popAt = new Map<string, number>(), memeAt = new Map<string, number>();
  for (const s of timed) {
    if (s.pop) try { popAt.set(s.id, resolveAnchor(p.al!, s.pop, [s.t0, s.t1 + 0.01]).time); } catch { popAt.set(s.id, s.t0); }
    if (s.meme) try { memeAt.set(s.id, s.meme.at ? resolveAnchor(p.al!, s.meme.at, [s.t0, s.t1 + 0.01]).time : s.t0 + 0.2); } catch { memeAt.set(s.id, s.t0); }
  }
  const memeImg = new Map<string, any>();
  for (const s of timed) if (s.meme && assets[s.meme.use] && !memeImg.has(s.meme.use)) { try { memeImg.set(s.meme.use, await loadImage(join(p.dir, assets[s.meme.use].file))); } catch { /* 读不了的表情包不画 */ } }
  const heads = resolveHeads(p, timed);
  const subSprite = new Map<number, any>();
  let k = -1, layer: Layer | null = null, layerStart = 0, layerN = 0, lastFrame: any = null, appBg: any = null;
  const started = Date.now();
  for (let fi = 0; fi < total; fi++) {
    const t = from + fi / fps;
    if (t < narr) {
      // 换镜头
      let kk = k; while (kk + 1 < timed.length && t >= timed[kk + 1].t0 - 1e-6) kk++;
      if (kk < 0) kk = 0;
      if (kk !== k || !layer) {
        layer?.close(); k = kk;
        const s = timed[k];
        layerStart = Math.max(0, Math.round((s.t0 - from) * fps)); layerN = Math.max(1, Math.round((s.t1 - s.t0) * fps));
        const sub: Timed = { ...s };
        // 只渲染一段时：视频从镜头中间开始，素材也要往后挪
        if (t > s.t0 + 1 / fps && s.from != null) sub.from = s.from + (t - s.t0);
        layer = await layerFor(p, sub, assets, cw, ch, fps, k, heads[k]);
        layerStart = fi; if (t > s.t0 + 1 / fps) layerN = Math.max(1, Math.round((s.t1 - t) * fps));
      }
      const s = timed[k], li = fi - layerStart, lt = li / fps;
      ctx.save();
      // 转场：在新镜头的开头
      if (s.cut === 'zoom' && lt < 0.3) { const z = 1.18 - 0.18 * ease(lt / 0.3); ctx.translate(cw / 2, ch / 2); ctx.scale(z, z); ctx.translate(-cw / 2, -ch / 2); }
      if (s.cut === 'whip' && lt < 0.22) ctx.translate(cw * 0.45 * (1 - ease(lt / 0.22)), 0);
      await layer.draw(ctx, li, layerN);
      ctx.restore();
      if (s.cut === 'whip' && lt < 0.22 && lastFrame) { ctx.globalAlpha = 1 - ease(lt / 0.22); ctx.drawImage(lastFrame, -cw * 0.45 * ease(lt / 0.22), 0); ctx.globalAlpha = 1; }
      if (s.cut === 'flash' && lt < 0.2) { ctx.fillStyle = `rgba(255,255,255,${1 - lt / 0.2})`; ctx.fillRect(0, 0, cw, ch); }
      // 来源标注
      const a = s.use ? assets[s.use] : undefined;
      if (a && (a.purpose === 'quote' || LICENSES[a.source.license]?.credit)) {
        ctx.font = `${26 * sc}px ${F}`; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const txt = `画面：${creditLine(a)}`.slice(0, 40), tw = ctx.measureText(txt).width;
        // card 版式：署名写在卡片下面，不压画面里的字
        if (layoutOf(p, s) === 'card') { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(txt, (CARD.x + 8) * sc, (CARD.y + CARD.h + 14) * sc); }
        else { ctx.fillRect(40 * sc, (SAFE.top + 10) * sc, tw + 24 * sc, 40 * sc); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(txt, 52 * sc, (SAFE.top + 17) * sc); }
      }
      // 表情包
      if (s.meme && memeImg.has(s.meme.use)) {
        const m0 = memeAt.get(s.id)!, md = s.meme.dur ?? 1, mt = t - m0;
        if (mt >= 0 && mt < md) {
          const img = memeImg.get(s.meme.use), center = s.meme.place === 'center';
          const box = (center ? 640 : 380) * sc, z = mt < 0.15 ? 0.6 + 0.5 * (mt / 0.15) : mt < 0.25 ? 1.1 - (mt - 0.15) : 1;
          const s0 = Math.min(box / img.width, box / img.height) * z, w = img.width * s0, h = img.height * s0;
          const cx = center ? cw / 2 : (SAFE.rightFrom - 30) * sc - box / 2, cy = center ? ch * 0.36 : (SAFE.top + 120) * sc + box / 2;
          ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20 * sc; ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h); ctx.restore();
        }
      }
      // 弹字
      if (s.pop && s.use !== 'title') {
        const p0 = popAt.get(s.id)!, pt = t - p0;
        if (pt >= 0) {
          const z = pt < 0.12 ? 0.5 + 0.7 * (pt / 0.12) : pt < 0.22 ? 1.2 - 2 * (pt - 0.12) : 1;
          // card 版式：弹字落在卡片和字幕之间，不盖住画面
          const inCard = layoutOf(p, s) === 'card';
          let size = (inCard ? 100 : 128) * sc; ctx.font = `${size}px ${F}`;
          while (ctx.measureText(s.pop).width > 900 * sc && size > 60 * sc) { size *= 0.9; ctx.font = `${size}px ${F}`; }
          ctx.save(); ctx.translate(cw / 2, inCard ? (CARD.y + CARD.h + 105) * sc : ch * 0.3); ctx.scale(z, z); ctx.rotate(-0.04);
          drawText(ctx, s.pop, 0, 0, size, { fill: '#ffd400', stroke: '#111', lw: size * 0.2 });
          ctx.restore();
        }
      }
      // 字幕
      const si = subs.findIndex(l => t >= l.start && t < l.end);
      if (si >= 0) {
        let sp = subSprite.get(si);
        if (!sp) {
          const size = SUB.size * sc; sp = createCanvas(cw, Math.ceil(size * 1.8)); const c = sp.getContext('2d');
          let sz = size; c.font = `${sz}px ${F}`; while (c.measureText(subs[si].text).width > (SAFE.rightFrom - 120) * sc && sz > 40 * sc) { sz *= 0.94; c.font = `${sz}px ${F}`; }
          drawText(c, subs[si].text, (SAFE.rightFrom / 2 + 20) * sc, sp.height / 2, sz, { fill: '#fff', stroke: '#111', lw: sz * 0.22 });
          subSprite.set(si, sp); if (subSprite.size > 8) subSprite.delete(subSprite.keys().next().value!);
        }
        ctx.drawImage(sp, 0, SUB.y * sc - sp.height / 2);
      }
      if (fi % 3 === 0 || t + 1 / fps >= narr) { lastFrame ??= createCanvas(cw, ch); lastFrame.getContext('2d').drawImage(cv, 0, 0); }
    } else {
      // 附录：最后一帧虚化成底色，附录从下往上滚
      layer?.close(); layer = null;
      if (!appBg) { appBg = createCanvas(cw, ch); const b = appBg.getContext('2d'); b.filter = `blur(${Math.round(24 * sc)}px)`; if (lastFrame) b.drawImage(lastFrame, 0, 0); b.filter = 'none'; b.fillStyle = 'rgba(0,0,0,0.72)'; b.fillRect(0, 0, cw, ch); }
      ctx.drawImage(appBg, 0, 0);
      if (sheet) { const at = t - narr, y = ch * 0.92 - Math.min(at * speed, sheet.height - ch * 0.8); ctx.drawImage(sheet, 0, y); }
    }
    if (draft) { ctx.save(); ctx.globalAlpha = 0.6; drawText(ctx, '草稿 · 素材未定稿', cw / 2, 120 * sc, 44 * sc, { fill: '#ff5a4f', stroke: '#000', lw: 6 * sc }); ctx.restore(); }
    if (!enc.stdin!.write(cv.data())) await new Promise(r => enc.stdin!.once('drain', r));
    if (fi && fi % (fps * 15) === 0) log(`  ${t.toFixed(0)}s / ${to.toFixed(0)}s（${((fi / total) * 100).toFixed(0)}%，已用 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
  }
  layer?.close();
  enc.stdin!.end();
  if ((await done) !== 0) throw new Error('ffmpeg 合成失败');
  renameSync(partial, o.out);
  return { file: o.out, seconds: (Date.now() - started) / 1000, frames: total, cuts: timed.filter(s => s.t0 > from && s.t0 < to).map(s => ({ id: s.id, t: s.t0 - from })) };
}

export function hasFfmpeg(): boolean { return existsSync('/usr/bin/ffmpeg') || !!process.env.PATH?.split(':').some(d => existsSync(join(d, 'ffmpeg'))); }
export { stripPunct };

/** 一个镜头中间那一刻的画面（裁切、推拉都和成片一样，不含字幕）：故事板和候选图用 */
export async function shotStill(p: Project, s: Timed, assets: Record<string, Asset>, width = 360, k = 0, head = ''): Promise<any> {
  const cw = Math.round(width / 2) * 2, ch = Math.round((width * H) / W / 2) * 2;
  const cv = createCanvas(cw, ch), ctx = cv.getContext('2d');
  const mid: Timed = { ...s };
  const a = s.use ? assets[s.use] : undefined;
  if (a?.kind === 'video') mid.from = Math.min((s.from ?? 0) + (s.t1 - s.t0) / 2, Math.max(0, (a.duration ?? 1) - 0.2));
  const layer = await layerFor(p, mid, assets, cw, ch, 30, k, head);
  const n = Math.round((s.t1 - s.t0) * 30);
  try { await layer.draw(ctx, a?.kind === 'video' ? 0 : Math.round(n * 0.7), n); } finally { layer.close(); }
  return cv;
}
