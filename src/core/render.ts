// 渲染器：画面是时间的纯函数。drawFrame(ctx, compiled, t) 能精确画出任意时刻的一帧。
import type { Compiled, TL, Cam, EraseGroup } from './compile';
import { type Stroke, type LineStroke, type Pt, cumLen, pointAt, widthProfile, rng } from './strokes';
import { lerpPose } from './figure';
import { textStrokes } from './text';
import { THEME } from './theme';

export interface Env { createCanvas(w: number, h: number): any; Path2D: any; /** 读一张位图（image 元素用） */ image?(file: string): any }
export interface FrameOpts { scale?: number; subtitles?: boolean; /** 笔：marker 只有一支马克笔，hand 是握着笔的手；true 等于 marker */ pen?: boolean | 'marker' | 'hand'; guides?: boolean; /** 只画板上的东西，不画纸面、暗角和上下的遮罩（透明底，给封面等二次合成用） */ bare?: boolean }

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);
const span = (t: number, t0: number, t1: number) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp01((t - t0) / (t1 - t0)));
const outBack = (k: number) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

export function camAt(c: Compiled, t: number): Cam {
  let s: Cam = c.cams[0]?.to ?? { cx: c.fmt.W / 2, cy: c.fmt.H / 2, zoom: 1 };
  for (const seg of c.cams) {
    if (t >= seg.t1) { s = seg.to; continue; }
    if (t <= seg.t0 || seg.cut) break;
    const k = ease(span(t, seg.t0, seg.t1));
    // 缩放按对数插值，推拉更自然
    const z = Math.exp(Math.log(s.zoom) + (Math.log(seg.to.zoom) - Math.log(s.zoom)) * k);
    return { cx: s.cx + (seg.to.cx - s.cx) * k, cy: s.cy + (seg.to.cy - s.cy) * k, zoom: z };
  }
  return s;
}

const paths = new Map<string, any>();
const P = (env: Env, d: string) => { let p = paths.get(d); if (!p) { p = new env.Path2D(d); paths.set(d, p); } return p; };

function tracePartial(ctx: any, pts: number[], cum: number[], frac: number) {
  ctx.moveTo(pts[0], pts[1]);
  if (frac >= 1) { for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); return; }
  const target = frac * cum[cum.length - 1];
  let i = 1;
  for (; i < cum.length && cum[i] <= target; i++) ctx.lineTo(pts[2 * i], pts[2 * i + 1]);
  if (i < cum.length) { const k = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); ctx.lineTo(pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * k, pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * k); }
}

/** 等宽描线（涂色笔道、板擦） */
function lineUniform(ctx: any, s: LineStroke, frac: number) {
  ctx.beginPath(); tracePartial(ctx, s.pts, cumLen(s), frac);
  ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.stroke();
}

/** 墨线：一小段一小段画，每段粗细不同——落笔重、行笔有起伏、收笔出锋 */
function lineBrush(ctx: any, s: LineStroke, frac: number) {
  const pts = s.pts, cum = cumLen(s), wm = widthProfile(s), n = cum.length;
  const target = frac >= 1 ? Infinity : frac * cum[n - 1];
  ctx.strokeStyle = s.color;
  for (let i = 1; i < n; i++) {
    let x1 = pts[2 * i], y1 = pts[2 * i + 1], w = (wm[i - 1] + wm[i]) / 2, last = false;
    if (cum[i] > target) {
      const k = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      if (k <= 0) break;
      x1 = pts[2 * i - 2] + (x1 - pts[2 * i - 2]) * k; y1 = pts[2 * i - 1] + (y1 - pts[2 * i - 1]) * k; w = wm[i - 1]; last = true;
    }
    ctx.beginPath(); ctx.moveTo(pts[2 * i - 2], pts[2 * i - 1]); ctx.lineTo(x1, y1); ctx.lineWidth = s.w * w; ctx.stroke();
    if (last) break;
  }
}

export function drawStroke(ctx: any, env: Env, s: Stroke, frac: number, alpha: number) {
  if (frac <= 0) return;
  if (s.kind === 'line') {
    ctx.globalAlpha = alpha * (s.alpha ?? 1);
    if (s.flat) { ctx.globalCompositeOperation = 'multiply'; lineUniform(ctx, s, frac); ctx.globalCompositeOperation = 'source-over'; }
    else if ((s.alpha ?? 1) < 1 || s.pts.length <= 4 && s.len < 3) lineUniform(ctx, s, frac);
    else lineBrush(ctx, s, frac);
  } else if (s.kind === 'fill') {
    // 涂色：沿斜向一路涂过去，而不是整块淡入
    ctx.save(); ctx.globalAlpha = alpha * s.alpha; ctx.globalCompositeOperation = 'multiply';
    if (frac < 1) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < s.pts.length; i += 2) { const v = s.pts[i] * 0.83 + s.pts[i + 1] * 0.55; if (v < lo) lo = v; if (v > hi) hi = v; }
      const edge = lo + (hi - lo) * frac, R = 1e5;
      ctx.beginPath(); // 半平面 {0.83x + 0.55y <= edge}
      ctx.moveTo(edge * 0.83 - 0.55 * R, edge * 0.55 + 0.83 * R); ctx.lineTo(edge * 0.83 + 0.55 * R, edge * 0.55 - 0.83 * R);
      ctx.lineTo(edge * 0.83 + 0.55 * R - 0.83 * R, edge * 0.55 - 0.83 * R - 0.55 * R); ctx.lineTo(edge * 0.83 - 0.55 * R - 0.83 * R, edge * 0.55 + 0.83 * R - 0.55 * R);
      ctx.closePath(); ctx.clip();
    }
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.moveTo(s.pts[0], s.pts[1]);
    for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i], s.pts[i + 1]);
    ctx.closePath(); ctx.fill(); ctx.restore();
  } else if (s.kind === 'image') {
    // 位图：先垫一张白底（照片的白边），沿斜向揭开
    const img = env.image?.(s.file); if (!img) return;
    ctx.save(); ctx.globalAlpha = alpha;
    if (frac < 1) {
      const b = s.box, lo = b.x * 0.83 + b.y * 0.55, hi = (b.x + b.w) * 0.83 + (b.y + b.h) * 0.55, edge = lo + (hi - lo) * frac, R = 1e5;
      ctx.beginPath();
      ctx.moveTo(edge * 0.83 - 0.55 * R, edge * 0.55 + 0.83 * R); ctx.lineTo(edge * 0.83 + 0.55 * R, edge * 0.55 - 0.83 * R);
      ctx.lineTo(edge * 0.83 + 0.55 * R - 0.83 * R, edge * 0.55 - 0.83 * R - 0.55 * R); ctx.lineTo(edge * 0.83 - 0.55 * R - 0.83 * R, edge * 0.55 + 0.83 * R - 0.55 * R);
      ctx.closePath(); ctx.clip();
    }
    ctx.fillStyle = 'rgba(60,45,25,0.16)'; ctx.fillRect(s.box.x + 5, s.box.y + 7, s.box.w, s.box.h);
    ctx.fillStyle = '#fff'; ctx.fillRect(s.box.x, s.box.y, s.box.w, s.box.h);
    ctx.drawImage(img, s.box.x, s.box.y, s.box.w, s.box.h);
    ctx.restore();
  } else {
    ctx.globalAlpha = alpha; ctx.save();
    if (frac < 1) {
      ctx.beginPath();
      if (s.kind === 'wipe') ctx.rect(s.box.x - 6, s.box.y - 30, (s.box.w + 12) * frac, s.box.h + 60);
      else {
        // 沿笔顺中线撒一串圆，圆的并集就是“笔已经走过的地方”
        s.mcum ??= s.medians.map(m => cumLen({ pts: m }));
        const total = s.mcum.reduce((n, c) => n + c[c.length - 1], 0);
        let left = frac * total;
        const step = s.r * 0.55;
        for (let mi = 0; mi < s.medians.length && left > 0; mi++) {
          const m = s.medians[mi], c = s.mcum[mi], L = c[c.length - 1], upto = Math.min(L, left);
          for (let d = 0; ; d += step) { const dd = Math.min(d, upto), q = pointAt(m, c, L ? dd / L : 0); ctx.moveTo(q[0] + s.r, q[1]); ctx.arc(q[0], q[1], s.r, 0, 6.2832); if (d >= upto) break; }
          left -= L;
        }
      }
      ctx.clip();
    }
    ctx.translate(s.tx, s.ty); ctx.scale(s.s, s.s);
    ctx.fillStyle = s.color; ctx.fill(P(env, s.d));
    if (s.bold) { ctx.strokeStyle = s.color; ctx.lineJoin = 'round'; ctx.lineWidth = s.bold / s.s; ctx.stroke(P(env, s.d)); }
    ctx.restore();
  }
}

/** 把一组笔画完整画出来（素材一览、字幕等静态用途） */
export function drawStrokes(ctx: any, env: Env, strokes: Stroke[], alpha = 1) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const under of [true, false]) for (const s of strokes) if (!!(s as any).under === under) drawStroke(ctx, env, s, 1, alpha);
  ctx.globalAlpha = 1;
}

// ── 纸面 ──
const papers = new Map<string, any>();
function paperTexture(env: Env, W: number, H: number): any {
  const key = `${W}x${H}`;
  let cv = papers.get(key);
  if (cv) return cv;
  cv = env.createCanvas(W, H);
  const x = cv.getContext('2d'), r = rng(7);
  x.fillStyle = THEME.paper; x.fillRect(0, 0, W, H);
  // 大块的明暗不匀：许多很淡的柔边色团叠在一起
  for (let i = 0; i < 46; i++) {
    const px = r() * W, py = r() * H, rad = 180 + r() * 420, dark = r() < 0.55;
    const g = x.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, dark ? 'rgba(120,95,60,0.045)' : 'rgba(255,255,255,0.09)'); g.addColorStop(1, dark ? 'rgba(120,95,60,0)' : 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  // 细颗粒
  const id = x.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() + r() - 1) * 6; d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.9; }
  x.putImageData(id, 0, 0);
  // 纸纤维
  x.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const px = r() * W, py = r() * H, a = r() * 6.28, l = 6 + r() * 22;
    x.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(90,70,40,0.05)'; x.lineWidth = 0.6 + r() * 0.8;
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + Math.cos(a) * l * 0.5 + (r() - 0.5) * 6, py + Math.sin(a) * l * 0.5 + (r() - 0.5) * 6, px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  papers.set(key, cv);
  return cv;
}

const veils = new Map<string, any>();
function veil(env: Env, tex: any, W: number, H: number, board: { x: number; y: number; w: number; h: number }): any {
  const key = `${W}x${H}:${board.y}:${board.h}`;
  let cv = veils.get(key);
  if (cv) return cv;
  cv = env.createCanvas(W, H);
  const x = cv.getContext('2d'), F = 70, top = board.y - 8, bot = board.y + board.h + 8;
  x.drawImage(tex, 0, 0, W, H);
  x.globalCompositeOperation = 'destination-in';
  const g = x.createLinearGradient(0, 0, 0, H), st = (y: number) => Math.min(1, Math.max(0, y / H));
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(st(top - F), 'rgba(0,0,0,1)'); g.addColorStop(st(top), 'rgba(0,0,0,0)');
  g.addColorStop(st(bot), 'rgba(0,0,0,0)'); g.addColorStop(st(bot + F), 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,1)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  veils.set(key, cv);
  return cv;
}

interface ElState { visible: boolean; dx: number; dy: number; scale: number; alpha: number; strokes: Stroke[]; drawing: boolean }
const poseCache = new WeakMap<object, Map<string, Stroke[]>>();

export function stateAt(tl: TL, t: number): ElState {
  const el = tl.el;
  const st: ElState = { visible: false, dx: 0, dy: 0, scale: 1, alpha: 1, strokes: el.strokes, drawing: false };
  const born = tl.drawT0 ?? tl.appear?.t;
  if (born == null || t < born || (tl.gone != null && t >= tl.gone)) return st;
  st.visible = true;
  st.drawing = tl.drawT1 != null && t < tl.drawT1;
  if (tl.appear) { const k = span(t, tl.appear.t, tl.appear.t + tl.appear.dur); if (tl.appear.kind === 'pop') st.scale *= Math.max(0.01, outBack(k)); else st.alpha *= k; }
  for (const m of tl.moves) {
    if (t < m.t0) break;
    const k = m.linear ? span(t, m.t0, m.t1) : ease(span(t, m.t0, m.t1));
    if (m.path && m.base) {
      // 先滑到轨迹起点，再沿轨迹走
      const cum = cumLen({ pts: m.path }), p = pointAt(m.path, cum, k);
      const lead = Math.min(1, k * 6);
      const sx = m.from[0] + (m.path[0] - m.base[0] - m.from[0]) * lead, sy = m.from[1] + (m.path[1] - m.base[1] - m.from[1]) * lead;
      st.dx = k < 1 / 6 ? sx : p[0] - m.base[0]; st.dy = k < 1 / 6 ? sy : p[1] - m.base[1];
    } else { st.dx = m.from[0] + (m.to[0] - m.from[0]) * k; st.dy = m.from[1] + (m.to[1] - m.from[1]) * k; }
  }
  for (const a of tl.alpha) if (t >= a.t0) st.alpha *= a.from + (a.to - a.from) * span(t, a.t0, a.t1);
  for (const a of tl.scale) if (t >= a.t0) st.scale = (st.scale / (tl.scale[tl.scale.indexOf(a) - 1]?.to ?? 1)) * (a.from + (a.to - a.from) * ease(span(t, a.t0, a.t1)));
  for (const s of tl.shakes) {
    if (t < s.t0 || t > s.t1) continue;
    const k = span(t, s.t0, s.t1);
    if (s.kind === 'shake') st.dx += 14 * Math.sin(k * Math.PI * 7) * (1 - k);
    else if (s.kind === 'nod') st.dy += 12 * Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k);
    else st.scale *= 1 + 0.2 * Math.sin(k * Math.PI);
  }
  if (tl.poses.length && el.rebuild) {
    let pose = tl.poses[0].from, face = tl.poses[0].faceFrom, key = '';
    for (const p of tl.poses) {
      if (t < p.t0) break;
      const k = ease(span(t, p.t0, p.t1));
      pose = k >= 1 ? p.to : lerpPose(p.from, p.to, k); face = k >= 0.5 ? p.faceTo : p.faceFrom;
      key = k >= 1 ? `${tl.poses.indexOf(p)}` : '';
    }
    if (t >= tl.poses[0].t0) {
      let cache = poseCache.get(tl); if (!cache) poseCache.set(tl, (cache = new Map()));
      st.strokes = (key && cache.get(key)) || el.rebuild(pose, face);
      if (key) cache.set(key, st.strokes);
    }
  }
  return st;
}

function strokeFrac(tl: TL, i: number, t: number): number {
  if (!tl.sched || t >= tl.drawT1!) return 1;
  const a = tl.sched[2 * i], b = tl.sched[2 * i + 1];
  if (t <= a) return 0;
  if (t >= b) return 1;
  const k = (t - a) / (b - a);
  return k * 0.55 + (k * k * (3 - 2 * k)) * 0.45; // 起笔、收笔略慢
}

function drawEl(ctx: any, env: Env, tl: TL, t: number, st: ElState) {
  ctx.save();
  ctx.translate(st.dx, st.dy);
  if (st.scale !== 1) { const c = tl.el.anchors.center; ctx.translate(c[0], c[1]); ctx.scale(st.scale, st.scale); ctx.translate(-c[0], -c[1]); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const ss = st.strokes, same = ss === tl.el.strokes;
  for (const under of [true, false]) for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!!(s as any).under !== under) continue;
    drawStroke(ctx, env, s, same ? strokeFrac(tl, i, t) : 1, st.alpha);
  }
  ctx.restore();
}

/** 当前笔尖位置（场景坐标），没在画则为 null */
export function penAt(tl: TL, t: number): Pt | null {
  if (!tl.sched || t < tl.drawT0! || t >= tl.drawT1!) return null;
  for (let i = 0; i < tl.el.strokes.length; i++) {
    if (t >= tl.sched[2 * i] && t < tl.sched[2 * i + 1]) {
      const s = tl.el.strokes[i], f = strokeFrac(tl, i, t);
      if (s.kind === 'line') return pointAt(s.pts, cumLen(s), f);
      if (s.kind === 'fill') return null;
      return [s.box.x + s.box.w * f, s.box.y + s.box.h * 0.6];
    }
  }
  return null;
}

// ── 小地图：大板上推近之后，角上一张缩小的整块板，红框是镜头现在看的地方 ──
function drawMinimap(ctx: any, c: Compiled, t: number, cam: Cam) {
  const sc = c.scenes.find(s => t >= s.t0 - 1e-6 && t < s.t1) ?? c.scenes[c.scenes.length - 1];
  if (!sc) return;
  const { W, H, board } = c.fmt, B = sc.board, big = Math.max(B.w / board.w, B.h / board.h);
  const on = c.meta.minimap ?? big >= 2;
  if (!on || big < 1.3) return;
  // 镜头还在这块板的全景附近时不显示；推近的过程中淡入
  const a = clamp01((cam.zoom / (sc.home.zoom || 1) - 1.15) / 0.5);
  const vw = board.w / cam.zoom, vh = board.h / cam.zoom;
  const vx = cam.cx - sc.origin[0] - board.x - (W / 2 - (board.x + board.w / 2)) / cam.zoom - vw / 2, vy = cam.cy - sc.origin[1] - board.y - (H / 2 - (board.y + board.h / 2)) / cam.zoom - vh / 2;
  if (a <= 0 || vx > B.w || vx + vw < 0) return; // 镜头在别的板上
  const portrait = H > W, mw = portrait ? 150 : 190, m = mw / B.w, mh = B.h * m;
  const x0 = W - mw - (portrait ? 44 : 28), y0 = portrait ? Math.max(24, board.y - mh - 10) : board.y + 16;
  ctx.save(); ctx.globalAlpha = a; ctx.globalCompositeOperation = 'source-over'; ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(253,251,245,0.92)'; ctx.strokeStyle = 'rgba(36,33,30,0.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(x0 - 5, y0 - 5, mw + 10, mh + 10); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.rect(x0 - 5, y0 - 5, mw + 10, mh + 10); ctx.clip();
  // 已经画出来的东西：一个个小灰块，板就这样一点点长满
  ctx.fillStyle = 'rgba(36,33,30,0.38)';
  for (const tl of c.tls) {
    if (tl.scene !== sc.index || tl.el.kind === 'axis') continue;
    const born = tl.drawT0 ?? tl.appear?.t;
    if (born == null || t < born || (tl.gone != null && t >= tl.gone)) continue;
    const b = tl.el.kind === 'note' ? tl.el.solid : tl.el.box;
    if (tl.el.kind === 'arrow' || tl.el.kind === 'line' || tl.el.kind === 'mark') continue;
    ctx.fillRect(x0 + b.x * m, y0 + b.y * m, Math.max(2, b.w * m), Math.max(2, b.h * m));
  }
  ctx.strokeStyle = THEME.colors.red; ctx.lineWidth = 3;
  ctx.strokeRect(x0 + Math.max(0, vx) * m, y0 + Math.max(0, vy) * m, (Math.min(B.w, vx + vw) - Math.max(0, vx)) * m, (Math.min(B.h, vy + vh) - Math.max(0, vy)) * m);
  ctx.restore();
}

// ── 握笔的手 ──
interface PenSeg { t0: number; t1: number; tl: TL; i: number }
const penSegs = new WeakMap<object, PenSeg[]>();
function segsOf(c: Compiled): PenSeg[] {
  let segs = penSegs.get(c);
  if (segs) return segs;
  segs = [];
  for (const tl of c.tls) {
    if (!tl.sched || tl.drawT0 == null) continue;
    for (let i = 0; i < tl.el.strokes.length; i++) {
      const s = tl.el.strokes[i], a = tl.sched[2 * i], b = tl.sched[2 * i + 1];
      if ((s as any).deco || !(b > a)) continue;
      segs.push({ t0: a, t1: b, tl, i });
    }
  }
  segs.sort((x, y) => x.t0 - y.t0);
  penSegs.set(c, segs);
  return segs;
}
/** 一笔画到 f 时笔尖在哪儿（元素坐标） */
function tipOf(s: Stroke, f: number): Pt {
  if (s.kind === 'line') return pointAt(s.pts, cumLen(s), f);
  if (s.kind === 'fglyph') {
    s.mcum ??= s.medians.map(m => cumLen({ pts: m }));
    const total = s.mcum.reduce((n, c) => n + c[c.length - 1], 0);
    let left = f * total;
    for (let mi = 0; mi < s.medians.length; mi++) { const L = s.mcum[mi][s.mcum[mi].length - 1]; if (left <= L || mi === s.medians.length - 1) return pointAt(s.medians[mi], s.mcum[mi], L ? Math.min(1, left / L) : 0); left -= L; }
  }
  if (s.kind === 'wipe') return [s.box.x + s.box.w * f, s.box.y + s.box.h * (0.6 + 0.25 * Math.sin(f * 9))];
  // 涂色、贴图：沿斜向来回扫
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (s.kind === 'fill') { for (let i = 0; i < s.pts.length; i += 2) { x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]); y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]); } }
  else { x0 = s.box.x; y0 = s.box.y; x1 = s.box.x + s.box.w; y1 = s.box.y + s.box.h; }
  const sw = Math.sin(f * Math.PI * Math.max(3, Math.round((x1 - x0 + y1 - y0) / 60))) * 0.5, d = Math.min(x1 - x0, y1 - y0) * 0.45;
  return [x0 + (x1 - x0) * f + sw * d * 0.55, y0 + (y1 - y0) * f - sw * d * 0.83];
}
export interface HandPos { x: number; y: number; color: string; scene: number; down: boolean }
/** 这一刻手（笔尖）在屏幕上的位置；不在画面里时返回 null */
export function handAt(c: Compiled, t: number, cam: Cam): HandPos | null {
  const segs = segsOf(c);
  if (!segs.length) return null;
  const { W, H, board } = c.fmt;
  const screen = (g: PenSeg, f: number): [number, number] => {
    const sc = c.scenes[g.tl.scene], p = tipOf(g.tl.el.strokes[g.i], f);
    return [(sc.origin[0] + board.x + p[0] - cam.cx) * cam.zoom + W / 2, (sc.origin[1] + board.y + p[1] - cam.cy) * cam.zoom + H / 2];
  };
  const colorOf = (g: PenSeg) => (g.tl.el.strokes[g.i] as any).color || THEME.ink;
  // 二分找到最后一个 t0 <= t 的
  let lo = 0, hi = segs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].t0 <= t) lo = m + 1; else hi = m; }
  let cur: PenSeg | null = null, prev: PenSeg | null = null;
  for (let i = lo - 1; i >= 0 && i >= lo - 40; i--) { const g = segs[i]; if (t < g.t1) { cur = g; break; } if (!prev || g.t1 > prev.t1) prev = g; }
  if (cur) { const k = (t - cur.t0) / (cur.t1 - cur.t0), p = screen(cur, k * 0.55 + k * k * (3 - 2 * k) * 0.45); return { x: p[0], y: p[1], color: colorOf(cur), scene: cur.tl.scene, down: true }; }
  const next = segs[lo] ?? null, rest: [number, number] = [W * 0.92, H * 1.12];
  const a = prev ? screen(prev, 1) : rest, b = next ? screen(next, 0) : rest;
  const tp = prev ? prev.t1 : -Infinity, tn = next ? next.t0 : Infinity, gap = tn - tp, IN = 0.42, OUT = 0.5, lift = -14;
  const mix = (p: [number, number], q: [number, number], k: number, col: string, scene: number): HandPos => ({ x: p[0] + (q[0] - p[0]) * k, y: p[1] + (q[1] - p[1]) * k + lift * Math.sin(Math.PI * k), color: col, scene, down: false });
  if (prev && next && gap < IN + OUT + 0.5) return mix(a, b, ease((t - tp) / gap), colorOf(next), next.tl.scene); // 两笔挨得近：悬着滑过去
  if (prev && t - tp < OUT) return mix(a, rest, ease((t - tp) / OUT), colorOf(prev), prev.tl.scene);
  if (next && tn - t < IN) return mix(rest, b, ease(1 - (tn - t) / IN), colorOf(next), next.tl.scene);
  return null;
}
function drawHand(ctx: any, hp: HandPos, hand: boolean, size: number) {
  ctx.save();
  ctx.translate(hp.x, hp.y); ctx.rotate(0.92); ctx.scale(size, size); // 笔杆朝右下
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const ink = THEME.ink, skin = '#fdfaf3';
  const rr = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); };
  const paint = (fill: string, lw = 5) => { ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke(); };
  // 落在纸上的影子
  ctx.save(); ctx.translate(10, 16); ctx.globalAlpha = 0.1; ctx.fillStyle = '#3c2d19';
  rr(16, -15, 250, 30, 14); ctx.fill();
  if (hand) { ctx.beginPath(); ctx.ellipse(150, 44, 74, 54, 0.25, 0, 6.2832); ctx.fill(); }
  ctx.restore();
  if (hand) { // 小臂和袖口：从右下角伸进来
    ctx.beginPath(); ctx.moveTo(196, 6); ctx.lineTo(2600, 190); ctx.lineTo(2600, 610); ctx.lineTo(170, 96); ctx.closePath(); paint(skin);
    ctx.beginPath(); ctx.moveTo(330, 8); ctx.lineTo(2600, 160); ctx.lineTo(2600, 650); ctx.lineTo(306, 134); ctx.closePath(); paint('#5d7fa8');
    // 手掌（压在笔杆下面的那几根手指）
    ctx.beginPath(); ctx.ellipse(150, 46, 72, 50, 0.25, 0, 6.2832); paint(skin);
  }
  // 马克笔：笔头、笔杆、笔帽一样的色环
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(20, -8); ctx.lineTo(20, 8); ctx.closePath(); paint(hp.color, 4);
  rr(20, -11, 22, 22, 4); paint('#e9e5db', 4);
  rr(40, -17, 220, 34, 12); paint('#fbfaf6');
  rr(52, -17, 26, 34, 3); paint(hp.color, 4);
  if (hand) {
    // 食指搭在笔杆上，拇指从下面抵住
    ctx.beginPath(); ctx.moveTo(206, -14); ctx.quadraticCurveTo(150, -52, 84, -30); ctx.quadraticCurveTo(62, -20, 76, -6); ctx.quadraticCurveTo(140, -14, 196, 16); ctx.closePath(); paint(skin);
    ctx.beginPath(); ctx.moveTo(176, 40); ctx.quadraticCurveTo(120, 34, 92, 14); ctx.quadraticCurveTo(82, 0, 100, -2); ctx.quadraticCurveTo(150, 4, 196, 22); ctx.closePath(); paint(skin);
    // 指节
    ctx.strokeStyle = ink; ctx.lineWidth = 4;
    for (const [x, y] of [[128, 66], [160, 76], [192, 78]]) { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 10, y + 12, x + 24, y + 8); ctx.stroke(); }
  }
  ctx.restore();
}

const subCache = new Map<string, { strokes: Stroke[]; w: number }>();
let layer: any = null;

export function drawFrame(ctx: any, c: Compiled, t: number, env: Env, o: FrameOpts = {}) {
  const k = o.scale ?? 1, { W, H, board } = c.fmt;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const cam = camAt(c, t);
  const world = (x: any) => { x.setTransform(k, 0, 0, k, 0, 0); x.translate(W / 2, H / 2); x.scale(cam.zoom, cam.zoom); x.translate(-cam.cx, -cam.cy); };
  const vx0 = cam.cx - W / 2 / cam.zoom, vx1 = cam.cx + W / 2 / cam.zoom, vy0 = cam.cy - H / 2 / cam.zoom, vy1 = cam.cy + H / 2 / cam.zoom;
  // 纸面铺在世界坐标里：镜头移动时纸纹跟着画一起走
  const tex = paperTexture(env, W, H);
  world(ctx);
  if (o.bare) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W * k, H * k); ctx.restore(); }
  else for (let i = Math.floor(vx0 / W); i * W < vx1; i++) for (let j = Math.floor(vy0 / H); j * H < vy1; j++) {
    // 相邻两块互为镜像，接缝处纹理连续
    ctx.save(); ctx.translate(i * W + (i & 1 ? W : 0), j * H + (j & 1 ? H : 0)); ctx.scale(i & 1 ? -1 : 1, j & 1 ? -1 : 1);
    ctx.drawImage(tex, -0.5, -0.5, W + 1, H + 1); ctx.restore();
  }
  const groups = new Map<number, { tl: TL; st: ElState }[]>();
  let curScene = -1;
  for (const tl of c.tls) {
    const sc = c.scenes[tl.scene];
    if (sc.origin[0] > vx1 || sc.origin[0] + (sc.span ?? W) < vx0) continue;
    const st = stateAt(tl, t);
    if (!st.visible) continue;
    if (tl.erase != null) { const g = c.erases[tl.erase]; if (t >= g.t0) { if (!groups.has(tl.erase)) groups.set(tl.erase, []); groups.get(tl.erase)!.push({ tl, st }); continue; } }
    if (tl.scene !== curScene) { world(ctx); ctx.translate(sc.origin[0] + board.x, sc.origin[1] + board.y); curScene = tl.scene; }
    drawEl(ctx, env, tl, t, st);
  }
  // 正在被擦的元素：画到单独一层，用板擦路径抠掉
  for (const [gi, items] of groups) {
    const g: EraseGroup = c.erases[gi], sc = c.scenes[g.scene], kk = span(t, g.t0, g.t1);
    const cw = Math.round(W * k), ch = Math.round(H * k);
    if (!layer || layer.width !== cw || layer.height !== ch) layer = env.createCanvas(cw, ch);
    const lx = layer.getContext('2d');
    lx.setTransform(1, 0, 0, 1, 0, 0); lx.globalCompositeOperation = 'source-over'; lx.globalAlpha = 1; lx.clearRect(0, 0, cw, ch);
    world(lx); lx.translate(sc.origin[0] + board.x, sc.origin[1] + board.y);
    for (const it of items) drawEl(lx, env, it.tl, t, it.st);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (g.style === 'wipe') {
      lx.globalCompositeOperation = 'destination-out'; lx.globalAlpha = 1; lx.lineCap = 'round'; lx.lineJoin = 'round';
      lineUniform(lx, { kind: 'line', pts: g.path, w: g.width, color: '#000', len: 0 }, Math.min(1, ease(kk) * 1.02));
      ctx.globalAlpha = 1;
    } else ctx.globalAlpha = 1 - kk;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
  }
  // 画板上下是平台界面和字幕的地方：近景时邻近的东西会漫进去，用纸面把它们柔和地收掉
  ctx.setTransform(k, 0, 0, k, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  if (!o.bare) ctx.drawImage(veil(env, tex, W, H, board), 0, 0, W, H);
  // 笔 / 握笔的手：跟着笔尖走；两笔之间悬着滑过去，停得久了退出画面，要画时再进来
  if (o.pen) {
    const hp = handAt(c, t, cam);
    if (hp) { ctx.setTransform(k, 0, 0, k, 0, 0); drawHand(ctx, hp, o.pen === 'hand', Math.sqrt(cam.zoom / (c.scenes[hp.scene]?.home.zoom || 1)) * (W < H ? 1 : 0.85)); }
  }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (!o.bare) drawMinimap(ctx, c, t, cam);
  if (o.guides) {
    ctx.strokeStyle = '#4dabf7'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.strokeRect(board.x, board.y, board.w, board.h); ctx.setLineDash([]);
  }
  // 四角略暗，像拍下来的纸面
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(60,45,25,0)'); vg.addColorStop(1, 'rgba(60,45,25,0.13)');
  ctx.globalAlpha = 1; ctx.fillStyle = vg; if (!o.bare) ctx.fillRect(0, 0, W, H);
  if (o.subtitles !== false) {
    const line = c.subs.find(s => t >= s.start && t < s.end);
    if (line) {
      let sub = subCache.get(line.text);
      if (!sub) { const r = textStrokes(line.text, { size: c.fmt.subSize, color: THEME.ink }); sub = { strokes: r.strokes, w: r.w }; subCache.set(line.text, sub); }
      ctx.save(); ctx.translate(W / 2 - sub.w / 2, c.fmt.subY - c.fmt.subSize / 2);
      ctx.lineJoin = 'round'; ctx.strokeStyle = THEME.paper;
      for (const s of sub.strokes) { // 先垫一圈纸色描边，保证压在画上也读得清
        if (s.kind !== 'fglyph' && s.kind !== 'wipe') continue;
        ctx.save(); ctx.translate(s.tx, s.ty); ctx.scale(s.s, s.s); ctx.lineWidth = 16 / s.s; ctx.stroke(P(env, s.d)); ctx.restore();
      }
      for (const s of sub.strokes) drawStroke(ctx, env, s, 1, 1);
      ctx.restore(); ctx.globalAlpha = 1;
    }
  }
}
