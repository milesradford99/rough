// 素材导入：把外部的手绘数据（Excalidraw 素材库、Quick Draw 简笔画）转成本项目的手绘件。
// 只转几何，不带原来的线宽和抖动：进来之后由我们自己的笔重新画一遍，所以和内置素材是同一种笔触。
import YAML from 'yaml';
import { parsePath, absolutize, normalize as normPath } from 'path-data-parser';

export interface Doodle { desc: string; source?: string; box: [number, number]; parts: any[] }
export interface Imported { name: string; doodle: Doodle; skipped: string[] }

const TARGET = 200; // 导入后的设计尺寸：长边 200，和内置手绘件一致
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 文件名：只留小写字母、数字、连字符 */
export function slug(s: string): string {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** 任意颜色 → 调色板里的名字。导入的素材不带自己的颜色体系，全片才是一套颜色。墨色返回 undefined */
export function paletteName(c: string | undefined): string | undefined {
  if (!c || c === 'transparent') return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const h6 = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
  const R = parseInt(h6.slice(0, 2), 16) / 255, G = parseInt(h6.slice(2, 4), 16) / 255, B = parseInt(h6.slice(4, 6), 16) / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.12) return l < 0.3 ? undefined : l > 0.93 ? 'paper' : 'gray';
  let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return h < 15 || h >= 335 ? 'red' : h < 40 ? 'orange' : h < 68 ? 'yellow' : h < 170 ? 'green' : h < 262 ? 'blue' : 'purple';
}

type P = [number, number];
/** 把一组图形整体缩放、平移进 [0, TARGET] 的框里 */
function normalize(shapes: { part: any; pts: P[] }[], pad = 6): { box: [number, number]; map: (p: P) => P; k: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const [x, y] of s.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), k = (TARGET - pad * 2) / Math.max(w, h);
  return { box: [Math.round(w * k + pad * 2), Math.round(h * k + pad * 2)], k, map: ([x, y]) => [r1((x - x0) * k + pad), r1((y - y0) * k + pad)] };
}

// ── Excalidraw ──
const rot = (p: P, c: P, a: number): P => { const s = Math.sin(a), co = Math.cos(a), dx = p[0] - c[0], dy = p[1] - c[1]; return [c[0] + dx * co - dy * s, c[1] + dx * s + dy * co]; };

/** 一个 .excalidrawlib 文件 → 若干手绘件。text 为 true 时保留素材里的文字 */
export function fromExcalidraw(json: any, o: { text?: boolean; source?: string } = {}): Imported[] {
  const items: any[] = json?.libraryItems ?? json?.library;
  if (!Array.isArray(items)) throw new Error('这不是 Excalidraw 素材库文件（缺少 libraryItems / library）');
  const out: Imported[] = [], used = new Set<string>();
  items.forEach((it, idx) => {
    const els: any[] = (Array.isArray(it) ? it : it.elements ?? []).filter((e: any) => !e.isDeleted);
    const title = (!Array.isArray(it) && it.name) || '';
    const skipped: string[] = [], shapes: { part: any; pts: P[]; kind: string }[] = [];
    for (const e of els) {
      const c: P = [e.x + e.width / 2, e.y + e.height / 2], a = e.angle || 0, R = (p: P) => (a ? rot(p, c, a) : p);
      const look: any = {};
      const col = paletteName(e.strokeColor), fill = paletteName(e.backgroundColor);
      if (col) look.color = col;
      if (fill && fill !== 'paper') look.fill = fill;
      if (e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted') skipped.push('虚线按实线画');
      if (e.type === 'rectangle' || e.type === 'diamond') {
        const pts: P[] = e.type === 'diamond' ? [[c[0], e.y], [e.x + e.width, c[1]], [c[0], e.y + e.height], [e.x, c[1]]] : [[e.x, e.y], [e.x + e.width, e.y], [e.x + e.width, e.y + e.height], [e.x, e.y + e.height]];
        shapes.push({ kind: e.type === 'rectangle' && !a ? 'rect' : 'poly', part: { close: true, ...look }, pts: pts.map(R) });
      } else if (e.type === 'ellipse') {
        // 转过的椭圆用多边形近似；没转的保持椭圆
        if (a) { const pts: P[] = []; for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; pts.push(R([c[0] + (Math.cos(t) * e.width) / 2, c[1] + (Math.sin(t) * e.height) / 2])); } shapes.push({ kind: 'curve', part: { ...look }, pts: [...pts, pts[0]] }); }
        else shapes.push({ kind: 'ellipse', part: { ...look }, pts: [[e.x, e.y], [e.x + e.width, e.y + e.height]] });
      } else if (e.type === 'line' || e.type === 'arrow' || e.type === 'freedraw') {
        let pts: P[] = (e.points ?? []).map((p: number[]) => R([e.x + p[0], e.y + p[1]]));
        if (pts.length < 2) continue;
        if (e.type === 'freedraw') pts = thin(pts, Math.max(e.width, e.height) / 60);
        const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < Math.max(e.width, e.height, 1) * 0.03;
        const smooth = e.type === 'freedraw' || !!e.roundness || e.strokeSharpness === 'round';
        if (!closed) delete look.fill;
        if (e.type === 'arrow') skipped.push('箭头的头没有带过来');
        if (pts.length === 2) shapes.push({ kind: 'line', part: look, pts });
        else if (smooth) shapes.push({ kind: 'curve', part: look, pts });
        else shapes.push({ kind: 'poly', part: closed ? { close: true, ...look } : look, pts: closed ? pts.slice(0, -1) : pts });
      } else if (e.type === 'text') {
        if (o.text && e.text && String(e.text).length <= 8) shapes.push({ kind: 'text', part: { text: String(e.text), size: e.fontSize ?? 20, ...(col ? { color: col } : {}) }, pts: [[e.x, e.y], [e.x + e.width, e.y + e.height]] });
      } else skipped.push(`不支持的元素类型 ${e.type}`);
    }
    if (!shapes.length) return;
    const n = normalize(shapes);
    const parts = shapes.map(s => {
      const m = s.pts.map(n.map);
      if (s.kind === 'rect') return { rect: [m[0][0], m[0][1], r1(m[2][0] - m[0][0]), r1(m[2][1] - m[0][1])], ...strip(s.part) };
      if (s.kind === 'ellipse') return { ellipse: [r1((m[0][0] + m[1][0]) / 2), r1((m[0][1] + m[1][1]) / 2), r1(m[1][0] - m[0][0]), r1(m[1][1] - m[0][1])], ...s.part };
      if (s.kind === 'line') return { line: [...m[0], ...m[1]], ...s.part };
      if (s.kind === 'text') return { text: s.part.text, at: [r1((m[0][0] + m[1][0]) / 2), r1((m[0][1] + m[1][1]) / 2)], size: Math.max(14, Math.round(s.part.size * n.k)), ...(s.part.color ? { color: s.part.color } : {}) };
      return { [s.kind]: m, ...s.part };
    });
    let name = slug(title) || `item-${idx + 1}`;
    for (let i = 2; used.has(name); i++) name = `${slug(title) || 'item'}-${i}`;
    used.add(name);
    out.push({ name, doodle: { desc: title || name, ...(o.source ? { source: o.source } : {}), box: n.box, parts }, skipped: [...new Set(skipped)] });
  });
  return out;
}
const strip = (p: any) => { const { close, ...rest } = p; return rest; };

/** 抽稀：去掉离前一个点太近的点（手写轨迹的点很密，画出来不需要） */
function thin(pts: P[], min: number): P[] {
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i][0] - out[out.length - 1][0], pts[i][1] - out[out.length - 1][1]) >= min) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

// ── Quick Draw ──
export interface QDrawing { word: string; recognized: boolean; key_id?: string; drawing: number[][][] }

/** Quick Draw 的 .ndjson（simplified 版：每行一张画，坐标 0–255）→ 逐张解析。坏行跳过 */
export function parseQuickDraw(ndjson: string, limit = Infinity): QDrawing[] {
  const out: QDrawing[] = [];
  for (const line of ndjson.split('\n')) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (Array.isArray(d.drawing) && d.drawing.length) out.push(d); } catch { /* 文件被截断时最后一行不完整 */ }
  }
  return out;
}

/** 一张 Quick Draw 简笔画 → 手绘件。笔画顺序就是真人落笔的顺序 */
export function fromQuickDraw(d: QDrawing, o: { name?: string; desc?: string; color?: string } = {}): Imported {
  const shapes = d.drawing.filter(s => s[0]?.length >= 2).map(s => ({ part: {}, pts: s[0].map((x, i) => [x, s[1][i]] as P) }));
  if (!shapes.length) throw new Error('这张画没有可用的笔画');
  const n = normalize(shapes);
  const parts = shapes.map(s => {
    const m = s.pts.map(n.map);
    // 数据已经是人手画的折线，再抖就过头了：压低 rough，只让笔自己的轻重起作用
    const look = { rough: 0.25, ...(o.color ? { color: o.color } : {}) };
    return m.length === 2 ? { line: [...m[0], ...m[1]], ...look } : { curve: m, ...look };
  });
  const name = o.name ?? slug(d.word);
  return { name, doodle: { desc: o.desc ?? d.word, source: `Quick Draw Dataset (Google, CC BY 4.0)${d.key_id ? ' #' + d.key_id : ''}`, box: n.box, parts }, skipped: [] };
}

// ── SVG ──
type M6 = [number, number, number, number, number, number];
const mmul = (m: M6, n: M6): M6 => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ID: M6 = [1, 0, 0, 1, 0, 0];

function parseTransform(s: string | undefined): M6 {
  let m = ID;
  if (!s) return m;
  for (const [, fn, raw] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = raw.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: M6 | null = null;
    if (fn === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') { const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), si = Math.sin(r), cx = a[1] ?? 0, cy = a[2] ?? 0; t = [c, si, -si, c, cx - c * cx + si * cy, cy - si * cx - c * cy]; }
    else if (fn === 'matrix' && a.length === 6) t = a as M6;
    else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    if (t && t.every(Number.isFinite)) m = mmul(m, t);
  }
  return m;
}

const NAMED: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080' };
/** SVG 颜色 → #rrggbb；none / 渐变 / 看不懂的返回 null */
function svgColor(c: string | undefined): string | null {
  if (!c) return null;
  c = c.trim().toLowerCase();
  if (c === 'none' || c === 'transparent' || c.startsWith('url(')) return null;
  if (c === 'currentcolor') return '#000000';
  if (NAMED[c]) return NAMED[c];
  const rgb = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/.exec(c);
  if (rgb) { const f = (v: string, pc: string) => Math.max(0, Math.min(255, Math.round(pc ? (+v / 100) * 255 : +v))).toString(16).padStart(2, '0'); return '#' + f(rgb[1], rgb[2]) + f(rgb[3], rgb[4]) + f(rgb[5], rgb[6]); }
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c) ? c : null;
}

type Seg = { t: 'M' | 'L' | 'C'; p: number[] };
interface Sub { segs: Seg[]; closed: boolean }
interface SvgShape { subs: Sub[]; fill: string | null; rule: 'evenodd' | 'nonzero'; fillOpacity: number; stroke: string | null; sw: number; kind: string }

const applyM = (m: M6, x: number, y: number): P => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 路径数据 → 子路径（只剩 M L C Z，坐标已经过变换） */
function subsOf(d: string, m: M6): Sub[] {
  const out: Sub[] = [];
  let cur: Sub | null = null;
  const T = (a: number[]) => { const r: number[] = []; for (let i = 0; i < a.length; i += 2) r.push(...applyM(m, a[i], a[i + 1])); return r; };
  for (const s of normPath(absolutize(parsePath(d)))) {
    if (s.key === 'M') { cur = { segs: [{ t: 'M', p: T(s.data) }], closed: false }; out.push(cur); }
    else if (!cur) continue;
    else if (s.key === 'L') cur.segs.push({ t: 'L', p: T(s.data) });
    else if (s.key === 'C') cur.segs.push({ t: 'C', p: T(s.data) });
    else if (s.key === 'Z') {
      cur.closed = true;
      const start: number[] = cur.segs[0].p; cur = { segs: [{ t: 'M', p: start.slice() }], closed: false }; // Z 之后如果还有线，从起点接着画
      out.push(cur);
    }
  }
  return out.filter(s => s.segs.length > 1);
}

/** 曲线压成折线。step：每段最长多少（源坐标） */
function flatten(sub: Sub, step: number): P[] {
  const pts: P[] = [[sub.segs[0].p[0], sub.segs[0].p[1]]];
  for (const g of sub.segs.slice(1)) {
    const [x0, y0] = pts[pts.length - 1];
    if (g.t === 'L') pts.push([g.p[0], g.p[1]]);
    else {
      const [x1, y1, x2, y2, x3, y3] = g.p;
      const approx = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const n = Math.max(2, Math.min(64, Math.ceil(approx / step)));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]); }
    }
  }
  return pts;
}

/** Douglas-Peucker 抽稀（闭合环不动首尾） */
function simplify(pts: P[], eps: number): P[] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const ringArea = (p: P[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i][0] * p[j][1] - p[j][0] * p[i][1]; } return a / 2; };
function pointIn(pt: P, poly: P[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i][1] > pt[1] !== poly[j][1] > pt[1] && pt[0] < ((poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  return c;
}
function segCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 一组环 → 若干没有洞的多边形。洞用一条零宽的“桥”并进外环，这样引擎的平涂（不分奇偶）也能把洞留出来 */
export function fillPolys(rings: P[][], rule: 'evenodd' | 'nonzero'): P[][] {
  const rs = rings.filter(r => r.length >= 3).map(pts => ({ pts, a: ringArea(pts), hole: false, parent: -1, holes: [] as P[][] })).sort((x, y) => Math.abs(y.a) - Math.abs(x.a));
  rs.forEach((r, i) => {
    let best = -1;
    for (let j = i - 1; j >= 0; j--) if (Math.abs(rs[j].a) > Math.abs(r.a) && pointIn(r.pts[0], rs[j].pts)) { best = j; break; } // 面积从大到小，最近的一个就是最小的包住它的
    r.parent = best;
    r.hole = best >= 0 && !rs[best].hole && (rule === 'evenodd' || Math.sign(rs[best].a) !== Math.sign(r.a));
    if (r.hole) rs[best].holes.push(r.pts);
  });
  const out: P[][] = [];
  for (const r of rs) {
    if (r.hole) continue;
    let poly = r.a < 0 ? r.pts.slice().reverse() : r.pts.slice(); // 外环统一正向，洞反向
    for (const h0 of r.holes.sort((x, y) => Math.max(...y.map(p => p[0])) - Math.max(...x.map(p => p[0])))) {
      const h = ringArea(h0) > 0 ? h0.slice().reverse() : h0.slice();
      let hi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[hi][0]) hi = i;
      const cand = poly.map((p, i) => ({ i, d: Math.hypot(p[0] - h[hi][0], p[1] - h[hi][1]) })).sort((x, y) => x.d - y.d);
      let vi = cand[0].i;
      for (const c of cand.slice(0, 60)) {
        const a = h[hi], b = poly[c.i];
        const clear = ![poly, h].some(ring => ring.some((p, k) => { const q = ring[(k + 1) % ring.length]; return segCross(a, b, p, q); }));
        if (clear) { vi = c.i; break; }
      }
      const rot = [...h.slice(hi), ...h.slice(0, hi), h[hi]];
      poly = [...poly.slice(0, vi + 1), ...rot, ...poly.slice(vi)];
    }
    out.push(poly);
  }
  return out;
}

export interface SvgOptions {
  name?: string; desc?: string; source?: string;
  /** 墨色块的描边粗细（默认 2；房子的笔是 7，对着 Open Peeps 这种满幅的细线稿太粗） */
  pen?: number;
  /** 抖动（默认 0.3；低于 0.5 时顶点不动，墨块里的洞不会被抖开） */
  rough?: number;
  /** 保留白色/纸色的填充（默认丢掉：底板本来就是纸色，保留只会让后画的白块盖住先画的线） */
  paper?: boolean;
}

/** 一个 SVG → 一个手绘件。
 *  填色的图形：墨色（深色）→ 平涂墨块，保留镂空；纸色 → 默认丢掉；其他颜色 → 并到调色板，用房子的马克笔涂色。
 *  只有描边的图形 → 当作中线笔画。渐变、裁剪、蒙版、图片、<use>、文字不支持，会写进 skipped。 */
export function fromSvg(svg: string, o: SvgOptions = {}): Imported {
  const text = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  if (!/<svg[\s>]/i.test(text)) throw new Error('这不是 SVG 文件（找不到 <svg>）');
  const skipped = new Set<string>();
  const shapes: SvgShape[] = [];
  const attrsOf = (s: string) => { const a: Record<string, string> = {}; for (const [, k, v1, v2] of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[k] = v1 ?? v2; if (a.style) for (const decl of a.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) a[decl.slice(0, i).trim()] = decl.slice(i + 1).trim(); } return a; };
  type Ctx = { m: M6; fill: string; stroke: string; rule: string; sw: number; fo: number; skip: boolean };
  const stack: Ctx[] = [{ m: ID, fill: '#000000', stroke: 'none', rule: 'nonzero', sw: 1, fo: 1, skip: false }];
  const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'style', 'script', 'title', 'desc', 'metadata', 'filter', 'lineargradient', 'radialgradient', 'pattern', 'marker']);
  for (const [, close, tagRaw, rest, selfClose] of text.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const tag = tagRaw.toLowerCase();
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const top = stack[stack.length - 1], a = attrsOf(rest);
    const ctx: Ctx = { ...top, m: mmul(top.m, parseTransform(a.transform)), fill: a.fill ?? top.fill, stroke: a.stroke ?? top.stroke, rule: a['fill-rule'] ?? top.rule, sw: a['stroke-width'] ? parseFloat(a['stroke-width']) : top.sw, fo: a['fill-opacity'] ? parseFloat(a['fill-opacity']) : top.fo };
    if (SKIP.has(tag)) { if (tag === 'clippath' || tag === 'mask' || tag === 'lineargradient' || tag === 'radialgradient') skipped.add(`不支持 ${tag}`); ctx.skip = true; }
    if (!selfClose) stack.push(ctx);
    if (ctx.skip || tag === 'svg' || tag === 'g') continue;
    const n = (k: string, d = 0) => (a[k] !== undefined ? parseFloat(a[k]) : d);
    let d: string | null = null;
    if (tag === 'path') d = a.d ?? null;
    else if (tag === 'rect') { const x = n('x'), y = n('y'), w = n('width'), h = n('height'); d = `M${x} ${y}H${x + w}V${y + h}H${x}Z`; }
    else if (tag === 'circle' || tag === 'ellipse') { const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry'); d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`; }
    else if (tag === 'line') d = `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    else if (tag === 'polyline' || tag === 'polygon') { const v = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number); if (v.length >= 4) d = 'M' + v.join(' ').replace(/^(\S+ \S+)/, '$1L') + (tag === 'polygon' ? 'Z' : ''); }
    else if (tag === 'use' || tag === 'image' || tag === 'text' || tag === 'foreignobject') { skipped.add(`不支持 <${tag}>`); continue; }
    else continue;
    if (!d) continue;
    let subs: Sub[];
    try { subs = subsOf(d, ctx.m); } catch { skipped.add(`有一条路径读不懂（<${tag}>）`); continue; }
    const fill = svgColor(ctx.fill), stroke = svgColor(ctx.stroke);
    if (ctx.fill.trim().startsWith('url(') || ctx.stroke.trim().startsWith('url(')) skipped.add('渐变填充不支持');
    const sc = Math.sqrt(Math.abs(ctx.m[0] * ctx.m[3] - ctx.m[1] * ctx.m[2]));
    if (subs.length) shapes.push({ subs, fill, rule: ctx.rule === 'evenodd' ? 'evenodd' : 'nonzero', fillOpacity: Number.isFinite(ctx.fo) ? ctx.fo : 1, stroke, sw: ctx.sw * sc, kind: tag });
  }
  const kindOf = (c: string | null) => { if (!c) return null; const p = paletteName(c); return p === undefined ? 'ink' : p === 'paper' ? 'paper' : p; };
  // 只统计真正会画出来的图形，用它们的外框来定缩放
  const used = shapes.filter(s => (s.fill && (kindOf(s.fill) !== 'paper' || o.paper)) || s.stroke);
  if (!used.length) throw new Error('SVG 里没有可画的图形');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of used) for (const u of s.subs) for (const g of u.segs) for (let i = 0; i < g.p.length; i += 2) { x0 = Math.min(x0, g.p[i]); x1 = Math.max(x1, g.p[i]); y0 = Math.min(y0, g.p[i + 1]); y1 = Math.max(y1, g.p[i + 1]); }
  const k0 = (TARGET - 12) / Math.max(1, x1 - x0, y1 - y0);
  const flat = used.map(s => s.subs.map(u => ({ pts: simplify(flatten(u, 1.5 / k0), 0.12 / k0), closed: u.closed })));
  const n = normalize(flat.flatMap(f => f.map(u => ({ part: {}, pts: u.pts }))));
  const pen = o.pen ?? 2, rough = o.rough ?? 0.3;
  const parts: any[] = [];
  used.forEach((s, si) => {
    const rings = flat[si].map(u => ({ pts: u.pts.map(n.map), closed: u.closed }));
    const fk = kindOf(s.fill);
    if (s.fill && (fk !== 'paper' || o.paper)) {
      const polys = fillPolys(rings.filter(r => r.closed || r.pts.length > 2).map(r => r.pts), s.rule).filter(p => Math.abs(ringArea(p)) > 0.15);
      for (const p of polys) {
        const dedup = p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
        if (fk === 'ink') parts.push({ poly: dedup, close: true, fill: 'ink', fillStyle: 'solid', fillAlpha: s.fillOpacity < 1 ? s.fillOpacity : 1, pen, rough, shade: false });
        else if (fk === 'paper') parts.push({ poly: dedup, close: true, color: 'paper', fill: 'paper', fillStyle: 'solid', fillAlpha: 1, pen: 1, rough, shade: false });
        else parts.push({ poly: dedup, close: true, fill: fk, pen, rough, shade: false });
      }
    }
    if (s.stroke && !(s.fill && s.stroke === s.fill)) {
      const sk = kindOf(s.stroke);
      for (const r of rings) {
        if (r.pts.length < 2) continue;
        const look = { ...(sk && sk !== 'ink' ? { color: sk } : {}), pen: Math.max(pen, Math.min(8, Math.round(s.sw * n.k * 10) / 10)), rough, shade: false };
        parts.push(r.pts.length === 2 ? { line: [...r.pts[0], ...r.pts[1]], ...look } : { poly: r.pts, ...(r.closed ? { close: true } : {}), ...look });
      }
    }
  });
  if (!parts.length) throw new Error('SVG 里没有可画的图形');
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? '';
  const name = o.name ? slug(o.name) : slug(title) || 'svg';
  return { name, doodle: { desc: o.desc ?? (title || name), ...(o.source ? { source: o.source } : {}), box: n.box, parts }, skipped: [...skipped] };
}

/** 手绘件 → YAML 文本：坐标数组写成一行，和手写的手绘件一个样子 */
export function doodleYaml(d: Doodle): string {
  const doc = new YAML.Document(d);
  YAML.visit(doc, { Seq(_k, node) { if (node.items.every((i: any) => YAML.isScalar(i) || (YAML.isSeq(i) && i.items.every((j: any) => YAML.isScalar(j))))) node.flow = true; } });
  return doc.toString({ lineWidth: 0 });
}
