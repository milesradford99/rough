// 元素：把分镜里“画什么、放哪儿”的声明变成摆好位置的笔画。
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { R, type ImageStroke, type Stroke, type Style, type Pt, type Box, boxOf, unionBox, translateStrokes, cloneStrokes, hash, polyLen, imageSize } from './strokes';
import { textStrokes } from './text';
import { iconStrokes, iconExists, scalePath } from './icons';
import { figureStrokes, POSES, FACES, ACCESSORIES, type Pose, type FigureSpec } from './figure';
import { THEME, color, isInk, wash, type Format } from './theme';

export class SrcError extends Error { constructor(public where: string, msg: string) { super(`${where}: ${msg}`); } }

export interface El {
  id: string; scene: string; kind: string; src: any;
  strokes: Stroke[]; box: Box; anchors: Record<string, Pt>;
  text?: string;              // 板书文字内容（用于检查与分镜表）
  missing?: string[];
  path?: number[];            // 箭头/线的走向，可作移动轨迹
  figure?: { spec: FigureSpec; dx: number; dy: number; labelStrokes: Stroke[]; prop?: { strokes: Stroke[]; hand: 'handL' | 'handR' } };
  rebuild?: (pose: Pose, face: string) => Stroke[];
  /** 允许压在哪些元素上（它是明确叠放在这些元素上的，如气泡里的内容） */
  over: Set<string>;
  /** 参与避让的占位框（批注只算文字，不算那条细线） */
  solid: Box;
  /** 不含标签的本体，相对 box 左上角（box 随元素平移，这个偏移不变）。标记打叉、划线时只盖本体，不盖住标签 */
  body?: Box;
  /** 箭头、连线上那行小字的位置，相对 box 左上角。打在线上的标记要让开它 */
  label?: Box;
  /** 数轴：数值范围。数值 v 的位置在 anchors.start 和 anchors.end 之间按比例插值 */
  axis?: [number, number];
  /** 被引擎自动挪动的距离 */
  nudged?: Pt;
  /** 被引擎吸附对齐的距离 */
  snapped?: Pt;
  /** 细节框：从它要展开的那样东西连过来的两条引线（场景坐标） */
  leaders?: [Pt, Pt][];
  /** 第一次排版时引擎替它做的选择（连线的弯度、小字在哪一侧、批注贴哪边、标记收紧几成）。
   *  元素随时间重新生成时照这些来，不会因为周围的东西变了就跳到另一侧 */
  frozen?: { curve?: number; flip?: boolean; side?: string; k?: number };
  /** 占位框是定死的（固定了取值范围的图表）：挪动时整体平移，不按笔画重算 */
  fixedBox?: boolean;
}

/** 大小的档位：写名字不写数字，同一类东西全片一样大。字四档，东西三档 */
export const TEXT_TIERS: Record<string, number> = { hero: 108, key: 64, label: 46, note: 40 };
export const THING_TIERS: Record<string, number> = { big: 210, mid: 160, small: 120 };
export const KINDS = ['text', 'figure', 'icon', 'doodle', 'parts', 'image', 'video', 'shape', 'axis', 'span', 'arrow', 'line', 'mark', 'chart', 'note', 'detail'] as const;
const RESERVED_ANCHORS = ['center', 'top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
const POS_KEYS = ['at', 'rightOf', 'leftOf', 'above', 'below'];
const COMMON = ['id', 'at', 'rightOf', 'leftOf', 'above', 'below', 'gap', 'align', 'anchor', 'dx', 'dy', 'size', 'color', 'label', 'labelSize', 'rough', 'w', 'h', 'fill', 'fillStyle', 'fillAlpha', 'fillGap', 'pen', 'weight', 'near', 'overlap', 'shade', 'snap', '__rigid', '__seed', '__tier', '__frozen', '__dec', '__in'];
const FIELDS: Record<string, string[]> = {
  text: ['lineGap'], figure: ['face', 'wear', 'accent', 'pose', 'carry'], icon: [], image: ['frame', 'style'], video: ['frame', 'style', 'from', 'to', 'loop'], doodle: ['vars'], parts: ['box', 'anchors'],
  shape: ['inside', 'insideSize'], arrow: ['curve', 'head', 'both', 'pad'], line: ['curve', 'pad'], mark: ['target', 'pad'],
  chart: ['data', 'labels', 'highlight', 'values', 'unit', 'range', 'perUnit', 'axes', 'smooth', 'base'], note: ['target', 'side'],
  axis: ['length', 'step', 'ticks', 'labels', 'unit', 'dir'], span: ['on', 'inside', 'insideSize', 'offset'], detail: ['shape'],
};

const DOODLE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../doodles');
export function doodleDirs(projectDir?: string): string[] { return [projectDir ? join(projectDir, 'doodles') : '', DOODLE_DIR].filter(d => d && existsSync(d)); }
/** 一段视频的宽、高、时长（用 ffprobe 读；读不出返回 null） */
const probed = new Map<string, { w: number; h: number; dur: number } | null>();
export function probeVideo(file: string): { w: number; h: number; dur: number } | null {
  if (probed.has(file)) return probed.get(file)!;
  let out: { w: number; h: number; dur: number } | null = null;
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:format=duration', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout || '{}'), s0 = j.streams?.[0], dur = +(s0?.duration ?? j.format?.duration ?? 0);
    if (s0?.width && s0?.height && dur > 0) out = { w: +s0.width, h: +s0.height, dur };
  } catch { /* 没有 ffprobe */ }
  probed.set(file, out);
  return out;
}
export function loadDoodle(name: string, projectDir?: string): any | null {
  if (!/^[\w-]+$/.test(String(name))) return null; // 名字只能是字母数字和连字符，不当路径用
  for (const d of doodleDirs(projectDir)) { const f = join(d, name + '.yaml'); if (existsSync(f)) return YAML.parse(readFileSync(f, 'utf8')); }
  return null;
}

function num(v: any, total: number, where: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?[\d.]+%$/.test(v)) return (parseFloat(v) / 100) * total;
  throw new SrcError(where, `坐标要写数字或百分比（如 320 或 "50%"），现在是 ${JSON.stringify(v)}`);
}

/** 小图形清单（doodle 的内容，或元素里内联的 parts）→ 笔画。k 为缩放 */
export function buildParts(parts: any[], k: number, base: Style, vars: Record<string, any>, where: string): { strokes: Stroke[]; text: string } {
  const out: Stroke[] = [];
  let text = '';
  const sub = (v: any): any => (typeof v === 'string' && v.startsWith('$') ? vars[v.slice(1)] ?? '' : v);
  const P = (a: any[]): Pt[] => a.map(p => [p[0] * k, p[1] * k]);
  const build = (p: any, i: number, shade: boolean): Stroke[] => {
    const out: Stroke[] = [];
    const w0 = `${where} 第 ${i + 1} 个图形`;
    if (!p || typeof p !== 'object') throw new SrcError(w0, '应该是一个对象，例如 {rect: [0,0,100,60]}');
    // 克制墨线：手绘件的轮廓一律用墨（或这个元素自己的颜色），颜色只留在一层淡彩的底色里
    const pc = p.color ? color(sub(p.color)) : base.color, pf = p.fill ? color(sub(p.fill)) : undefined, ink = isInk();
    const opaque = p.fillAlpha != null && p.fillAlpha >= 0.9;
    const st: Style = { ...base, seed: base.seed + i * 7 + 1, color: ink && pc !== THEME.paper ? base.color : pc, w: p.pen ?? base.w, rough: p.rough ?? base.rough,
      fill: pf && ink && !opaque ? wash(pf) : pf, fillStyle: ink && pf && !opaque && (!p.fillStyle || p.fillStyle === 'marker') ? 'solid' : p.fillStyle,
      fillAlpha: ink && pf && !opaque ? 0.85 : p.fillAlpha, fillGap: p.fillGap, shade };
    const need = (key: string, n: number) => { if (!Array.isArray(p[key]) || p[key].length < n) throw new SrcError(w0, `${key} 需要 ${n} 个数字`); return p[key].map((x: number) => x * k); };
    if ('line' in p) { const a = need('line', 4); out.push(...R.line(a[0], a[1], a[2], a[3], st)); }
    else if ('rect' in p) { const a = need('rect', 4); out.push(...R.rect(a[0], a[1], a[2], a[3], st)); }
    else if ('ellipse' in p) { const a = need('ellipse', 4); out.push(...R.ellipse(a[0], a[1], a[2], a[3], st)); }
    else if ('circle' in p) { const a = need('circle', 3); out.push(...R.ellipse(a[0], a[1], a[2], a[2], st)); }
    else if ('arc' in p) { const a = p.arc; out.push(...R.arc(a[0] * k, a[1] * k, a[2] * k, a[3] * k, (a[4] * Math.PI) / 180, (a[5] * Math.PI) / 180, st)); }
    else if ('poly' in p) out.push(...R.poly(P(p.poly), !!p.close, st));
    else if ('curve' in p) out.push(...R.curve(P(p.curve), st));
    else if ('path' in p) out.push(...R.path(scalePath(String(p.path), k), st));
    else if ('icon' in p) { if (!iconExists(p.icon)) throw new SrcError(w0, `没有叫 ${p.icon} 的图标，用 hj assets icons <关键词> 搜索`); out.push(...iconStrokes(p.icon, p.at[0] * k, p.at[1] * k, (p.size ?? 24) * k, st)); }
    else if ('text' in p) {
      const s = String(sub(p.text));
      if (!s) return out;
      const t = textStrokes(s, { size: (p.size ?? 40) * k, color: st.color });
      translateStrokes(t.strokes, p.at[0] * k - t.w / 2, p.at[1] * k - t.h / 2);
      out.push(...t.strokes); if (!shade) text += s;
    } else throw new SrcError(w0, `不认识的图形 ${JSON.stringify(Object.keys(p))}，可用：line rect ellipse circle arc poly curve path icon text`);
    return out;
  };
  // 阴影只给“外轮廓”加：闭合、够大、没有被别的闭合图形包住。门窗这类里面的小件不加
  const built = parts.map((p, i) => build(p, i, false));
  const closed = (p: any) => 'rect' in p || 'ellipse' in p || 'circle' in p || ('poly' in p && !!p.close) || ('path' in p && /z\s*$/i.test(String(p.path)));
  const boxes = built.map((ss, i) => (closed(parts[i]) ? boxOf(ss.filter(s => !(s as any).under)) : null));
  const all = boxOf(built.flat()), big = Math.max(all.w, all.h) * 0.3;
  const inside = (a: Box, b: Box) => a.x >= b.x - 4 && a.y >= b.y - 4 && a.x + a.w <= b.x + b.w + 4 && a.y + a.h <= b.y + b.h + 4;
  const shades: Stroke[] = [];
  built.forEach((ss, i) => {
    const b = boxes[i];
    out.push(...ss);
    if (!base.shade || !b || parts[i].shade === false || Math.max(b.w, b.h) < big) return;
    if (boxes.some((o, j) => o && j !== i && inside(b, o) && !(inside(o, b) && j > i))) return;
    shades.push(...build(parts[i], i, true).filter(s => (s as any).deco));
  });
  out.push(...shades); // 整个东西画完、涂完色，最后才扫阴影
  return { strokes: out, text };
}

export interface BuildCtx {
  scene: string; fmt: Format; els: Map<string, El>; projectDir?: string;
  /** 项目级开关：false 关掉全片的灰色阴影 */
  shade?: boolean;
  /** 每个元素在画面上存在的时间段 [出现, 消失]。有它才启用自动避让 */
  life?: Map<string, [number, number]>;
  /** 成组的元素（crowd）：组名 → 成员。箭头、坐标可以把整群当一个东西引用 */
  groups?: Map<string, string[]>;
  note?: (where: string, msg: string, level?: 'info' | 'warn') => void;
}

// ── 自动避让：手绘的板面上东西不互相压着。这里是底层机制，不靠写分镜的人自己看 ──
const NON_SOLID = new Set(['mark', 'arrow', 'line', 'axis']);
/** 和 el 同时存在、且不允许被它压住的元素的占位框 */
function obstacles(ctx: BuildCtx, el: { id: string; over: Set<string>; src: any }, skip: string[] = []): Box[] {
  if (!ctx.life || el.src?.overlap === true) return [];
  const me = ctx.life.get(el.id);
  if (!me) return [];
  const out: Box[] = [];
  for (const o of ctx.els.values()) {
    if (o.id === el.id || NON_SOLID.has(o.kind) || o.src?.overlap === true || skip.includes(o.id)) continue;
    if (el.over.has(o.id) || o.over.has(el.id)) continue;
    const lf = ctx.life.get(o.id);
    if (!lf || Math.max(me[0], lf[0]) >= Math.min(me[1], lf[1])) continue;
    out.push(o.solid);
  }
  return out;
}
/** b（外扩 pad）是否压到任何一个障碍。两个方向都重叠超过 8px 才算，紧挨着不算 */
function hits(b: Box, obs: Box[], pad = 0): boolean {
  for (const o of obs) {
    const ox = Math.min(b.x + b.w + pad, o.x + o.w) - Math.max(b.x - pad, o.x), oy = Math.min(b.y + b.h + pad, o.y + o.h) - Math.max(b.y - pad, o.y);
    if (ox > 8 && oy > 8) return true;
  }
  return false;
}
/** 和 el 同时在板上的线（分隔线、箭头、连线）沿途的小占位框：字不该压在线上 */
function lineBoxes(ctx: BuildCtx, el: { id: string }, skip: string[] = []): Box[] {
  if (!ctx.life) return [];
  const me = ctx.life.get(el.id);
  if (!me) return [];
  const out: Box[] = [];
  for (const o of ctx.els.values()) {
    if (o.id === el.id || !o.path || (o.kind !== 'line' && o.kind !== 'arrow') || skip.includes(o.id)) continue;
    const lf = ctx.life.get(o.id);
    if (!lf || Math.max(me[0], lf[0]) >= Math.min(me[1], lf[1])) continue;
    const p = o.path;
    for (let i = 2; i < p.length; i += 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / 12));
      for (let k = 0; k <= n; k++) out.push({ x: p[i - 2] + ((p[i] - p[i - 2]) * k) / n - 13, y: p[i - 1] + ((p[i + 1] - p[i - 1]) * k) / n - 13, w: 26, h: 26 });
    }
  }
  return out;
}
/** 自动拉回画板时留的边距；挪动超过 FAR_NUDGE 说明原位置根本不成立，升级为警告 */
export const EDGE = 14, FAR_NUDGE = 80;
const inBoard = (b: Box, B: Box, m = 0) => b.x >= -m && b.y >= -m && b.x + b.w <= B.w + m && b.y + b.h <= B.h + m;
/** 离原位最近的空位：一圈一圈往外找 */
function nearestFree(b: Box, obs: Box[], B: Box): Pt | null {
  for (let rad = 24; rad <= 720; rad += 24) {
    const n = Math.max(12, Math.round(rad / 9));
    let best: Pt | null = null;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, dx = Math.cos(a) * rad, dy = Math.sin(a) * rad * 0.9;
      const c = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
      if (inBoard(c, B, 4) && !hits(c, obs, 14)) { best = [dx, dy]; break; }
    }
    if (best) return best;
  }
  return null;
}
/** 没写位置的元素：像人在板上找地方写一样，从上到下、从左到右找第一块放得下的空地；写了 near 就找离它最近的 */
function autoSpot(b: Box, obs: Box[], B: Box, near?: Pt): Pt | null {
  let best: Pt | null = null, bestScore = Infinity;
  for (let y = 10; y + b.h <= B.h - 6; y += 26) for (let x = 14; x + b.w <= B.w - 10; x += 26) {
    const c = { x, y, w: b.w, h: b.h };
    if (hits(c, obs, 22)) continue;
    const score = near ? Math.hypot(x + b.w / 2 - near[0], y + b.h / 2 - near[1]) : y * 1.6 + x * 0.35;
    if (score < bestScore) { bestScore = score; best = [x - b.x, y - b.y]; }
  }
  return best;
}
function shiftEl(el: El, dx: number, dy: number) {
  translateStrokes(el.strokes, dx, dy);
  if (el.path) for (let i = 0; i < el.path.length; i += 2) { el.path[i] += dx; el.path[i + 1] += dy; }
  for (const k of Object.keys(el.anchors)) el.anchors[k] = [el.anchors[k][0] + dx, el.anchors[k][1] + dy];
  if (el.figure) { el.figure.dx += dx; el.figure.dy += dy; }
  el.box = el.fixedBox ? { ...el.box, x: el.box.x + dx, y: el.box.y + dy } : boxOf(el.strokes);
}

/** 数轴上数值 v 的位置 */
export function axisPoint(ax: El, v: number): Pt {
  const [v0, v1] = ax.axis!, a = ax.anchors.start, b = ax.anchors.end, k = (v - v0) / (v1 - v0 || 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
const AXREF = /^([A-Za-z_][\w-]*)@(-?[\d.]+)$/;
function axisRef(ctx: BuildCtx, v: string, where: string): Pt | null {
  const m = AXREF.exec(v.trim());
  if (!m) return null;
  const ax = ctx.els.get(m[1]);
  if (!ax) throw new SrcError(where, `坐标 "${v}" 引用了不存在（或定义在它后面）的数轴 "${m[1]}"`);
  if (!ax.axis) throw new SrcError(where, `坐标 "${v}"：元素 "${m[1]}" 不是数轴（axis）。"名字@数值" 只能用在数轴上`);
  return axisPoint(ax, +m[2]);
}

/** 按 id 找元素；id 是一群（crowd）的名字时，给出一个代表整群外框的替身，箭头就能指向“这一群” */
function findEl(ctx: BuildCtx, id: string): El | undefined {
  const el = ctx.els.get(id);
  if (el) return el;
  const ms = (ctx.groups?.get(id) ?? []).map(m => ctx.els.get(m)).filter((m): m is El => !!m);
  if (!ms.length) return undefined;
  const b = unionBox(ms.map(m => m.box)), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return { ...ms[0], id, kind: 'group', strokes: [], box: b, solid: b, body: undefined, over: new Set(ms.flatMap(m => [m.id, ...m.over])),
    anchors: { center: [cx, cy], top: [cx, b.y], bottom: [cx, b.y + b.h], left: [b.x, cy], right: [b.x + b.w, cy], topLeft: [b.x, b.y], topRight: [b.x + b.w, b.y], bottomLeft: [b.x, b.y + b.h], bottomRight: [b.x + b.w, b.y + b.h] } } as El;
}
function parseRef(ctx: BuildCtx, ref: any, where: string): { pt: Pt; el?: El; explicit: boolean } {
  if (Array.isArray(ref)) {
    // 每个坐标可以是数字、百分比，或 "元素.锚点"（取那个锚点的 x 或 y）：和别的东西共用一根轴，不用抄坐标
    const axis = (v: any, i: 0 | 1, total: number): number => {
      if (typeof v !== 'string' || /^-?[\d.]+%?$/.test(v)) return num(v, total, where);
      const ap = axisRef(ctx, v, where); if (ap) return ap[i]; // 数轴上的数值：t@2
      const [id, a = 'center'] = v.split('.'), el = findEl(ctx, id);
      if (!el) throw new SrcError(where, `坐标里引用了不存在（或定义在它后面）的元素 "${id}"`);
      if (!el.anchors[a]) throw new SrcError(where, `元素 "${id}" 没有锚点 "${a}"，可用：${Object.keys(el.anchors).join(' ')}`);
      return el.anchors[a][i];
    };
    return { pt: [axis(ref[0], 0, ctx.fmt.board.w), axis(ref[1], 1, ctx.fmt.board.h)], explicit: true };
  }
  if (typeof ref !== 'string') throw new SrcError(where, `位置引用要写元素 id、"id.锚点" 或 [x, y]，现在是 ${JSON.stringify(ref)}`);
  const ap = axisRef(ctx, ref, where);
  if (ap) return { pt: ap, explicit: true };
  const [id, a] = ref.split('.');
  const el = findEl(ctx, id);
  if (!el) throw new SrcError(where, `引用了不存在（或定义在它后面）的元素 "${id}"。被引用的元素要写在前面`);
  if (!a) return { pt: el.anchors.center, el, explicit: false };
  if (!el.anchors[a]) throw new SrcError(where, `元素 "${id}" 没有锚点 "${a}"，可用：${Object.keys(el.anchors).join(' ')}`);
  return { pt: el.anchors[a], el, explicit: true };
}

/** 从 from 指向 to 的射线离开 box（外扩 pad）的位置 */
function exitPoint(b: Box, pad: number, from: Pt, to: Pt): Pt {
  const hw = b.w / 2 + pad, hh = b.h / 2 + pad, dx = to[0] - from[0], dy = to[1] - from[1];
  if (!dx && !dy) return from;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [from[0] + dx * Math.min(t, 0.48), from[1] + dy * Math.min(t, 0.48)];
}

function setAnchors(el: El) {
  const b = el.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  el.anchors = { ...el.anchors, center: [cx, cy], top: [cx, b.y], bottom: [cx, b.y + b.h], left: [b.x, cy], right: [b.x + b.w, cy],
    topLeft: [b.x, b.y], topRight: [b.x + b.w, b.y], bottomLeft: [b.x, b.y + b.h], bottomRight: [b.x + b.w, b.y + b.h] };
}

export function buildElement(ctx: BuildCtx, id: string, src: any): El {
  const where = `场景 ${ctx.scene} / 元素 ${id}`;
  if (!src || typeof src !== 'object') throw new SrcError(where, '元素定义应该是一个对象');
  const kind = KINDS.find(k => k in src);
  if (!kind) throw new SrcError(where, `看不出这是什么元素。需要包含其中一个键：${KINDS.join(' ')}`);
  for (const k of Object.keys(src)) if (k !== kind && !COMMON.includes(k) && !FIELDS[kind].includes(k)) throw new SrcError(where, `${kind} 元素不认识字段 "${k}"。可用：${[...COMMON, ...FIELDS[kind]].join(' ')}`);
  if (typeof src.size === 'string') {
    const tiers = kind === 'text' || kind === 'note' ? TEXT_TIERS : ['figure', 'doodle', 'parts', 'icon', 'image', 'video', 'shape'].includes(kind) ? THING_TIERS : null;
    if (!tiers || !(src.size in tiers)) throw new SrcError(where, tiers ? `size 没有 "${src.size}" 这一档。${tiers === TEXT_TIERS ? '字' : '东西'}的档位：${Object.entries(tiers).map(([k, v]) => `${k}（${v}）`).join(' ')}；也可以直接写数字` : `${kind} 的 size 要写数字`);
    src = { ...src, size: tiers[src.size], __tier: src.size };
  }
  const B = ctx.fmt.board;
  const seed = hash((src.__seed ?? ctx.scene) + '/' + id); // 沿用过来的元素用原场景的种子，抖动才一模一样
  // 线的轻重：weight 写 bold / light；不写时按东西的大小来——小东西线细、大东西线粗，像真人换着力道画
  if (src.weight != null && !['bold', 'normal', 'light'].includes(src.weight)) throw new SrcError(where, 'weight 只能是 bold（加重）/ normal / light（轻）');
  const wk = src.weight === 'bold' ? 1.35 : src.weight === 'light' ? 0.7 : 1;
  const bySize = ['doodle', 'parts', 'icon'].includes(kind) && src.size && src.weight == null ? Math.min(1.25, Math.max(0.62, Math.pow(src.size / 190, 0.55))) : 1;
  const st: Style = { color: color(src.color), w: src.pen ?? THEME.pen * wk * bySize, rough: src.rough ?? THEME.rough, seed, fill: src.fill ? (isInk() && !(src.fillAlpha >= 0.9) ? wash(color(src.fill)) : color(src.fill)) : undefined, fillStyle: src.fillStyle, fillAlpha: src.fillAlpha, fillGap: src.fillGap };
  const shade = (src.shade ?? ctx.shade) !== false;
  const el: El = { id, scene: ctx.scene, kind, src, strokes: [], box: { x: 0, y: 0, w: 0, h: 0 }, anchors: {}, over: new Set(), solid: { x: 0, y: 0, w: 0, h: 0 } };
  if (src.__in) el.over.add(String(src.__in)); // 写在细节框里的东西本来就叠在框上
  let placed = false, frame: Box | null = null; // arrow/line/mark 直接画在场景坐标里
  let lineLabel: Box | null = null; // 箭头上小字的绝对位置，box 定下来之后换成相对的

  if (kind === 'text') {
    const t = textStrokes(String(src.text), { size: src.size ?? THEME.textSize, color: st.color, align: src.align, lineGap: src.lineGap });
    el.strokes = t.strokes; el.text = String(src.text); el.missing = t.missing;
    // 字的轻重：大字（标题、结论的数）自动加重一点，light 不加；bold 明确加重
    const tsz = src.size ?? THEME.textSize, bold = src.weight === 'bold' ? tsz * 0.045 : src.weight == null && tsz >= 84 ? tsz * 0.028 : 0;
    if (bold) for (const g of el.strokes) if (g.kind === 'fglyph' || g.kind === 'wipe') g.bold = bold;
  } else if (kind === 'figure') {
    const f = typeof src.figure === 'string' ? { pose: src.figure } : src.figure ?? {};
    const poseName = src.pose ?? f.pose ?? 'stand', face = src.face ?? f.face ?? 'happy', wear = src.wear ?? f.wear ?? [];
    if (!POSES[poseName]) throw new SrcError(where, `没有姿势 "${poseName}"。可用：${Object.keys(POSES).join(' ')}`);
    if (!FACES[face]) throw new SrcError(where, `没有表情 "${face}"。可用：${Object.keys(FACES).join(' ')}`);
    for (const a of wear) if (!ACCESSORIES.includes(a)) throw new SrcError(where, `没有配饰 "${a}"。可用：${ACCESSORIES.join(' ')}`);
    const spec: FigureSpec = { size: src.size ?? 320, color: st.color, pose: POSES[poseName], face, accessories: wear, accent: src.accent ? color(src.accent) : undefined, seed, shade };
    const r = figureStrokes(spec);
    el.strokes = r.strokes; el.anchors = r.anchors; el.figure = { spec, dx: 0, dy: 0, labelStrokes: [] };
    if (src.carry) { // 手里拿的东西：跟着手走
      const { hand, ...psrc } = src.carry;
      const prop = buildElement({ ...ctx, els: new Map(), life: undefined }, id + '.carry', { size: Math.round(spec.size * 0.28), ...psrc, at: [0, 0] });
      const h = hand === 'left' ? 'handL' : 'handR', pc = prop.anchors.center;
      el.figure.prop = { strokes: cloneStrokes(prop.strokes, -pc[0], -pc[1]), hand: h };
      el.strokes.push(...cloneStrokes(el.figure.prop.strokes, r.anchors[h][0], r.anchors[h][1]));
    }
  } else if (kind === 'icon') {
    if (!iconExists(src.icon)) throw new SrcError(where, `没有叫 "${src.icon}" 的图标。用 hj assets icons <英文关键词> 搜索`);
    el.strokes = iconStrokes(src.icon, 0, 0, src.size ?? 200, { ...st, rough: src.rough ?? 0.6 });
  } else if (kind === 'doodle' || kind === 'parts') {
    let parts = src.parts, box = src.box, vars = src.vars ?? {}, named = src.anchors;
    if (kind === 'doodle') {
      const d = loadDoodle(src.doodle, ctx.projectDir);
      if (!d) throw new SrcError(where, `没有叫 "${src.doodle}" 的手绘件。用 hj assets doodles 查看，或在项目的 doodles/ 目录里自己画一个`);
      parts = d.parts; box = d.box; vars = { ...(d.vars ?? {}), ...vars }; named = d.anchors;
    }
    if (!Array.isArray(parts)) throw new SrcError(where, 'parts 应该是图形列表');
    const k = src.size && box ? src.size / Math.max(box[0], box[1]) : 1;
    const r = buildParts(parts, k, { ...st, shade }, vars, where);
    el.strokes = r.strokes; el.text = r.text || undefined;
    // 手绘件自己声明的锚点（甲板、桌面、门口…）：让别的东西能“站上去”“放进去”，不用估坐标
    if (named != null) {
      if (typeof named !== 'object' || Array.isArray(named)) throw new SrcError(where, 'anchors 应该是 "名字: [x, y]" 的映射，坐标在 box 内');
      for (const [an, pt] of Object.entries(named)) {
        if (!Array.isArray(pt) || pt.length !== 2 || pt.some(v => typeof v !== 'number')) throw new SrcError(where, `锚点 "${an}" 要写成 [x, y]（box 内的坐标）`);
        if (RESERVED_ANCHORS.includes(an)) throw new SrcError(where, `锚点名 "${an}" 是内置的，换一个名字（如 deck、door、seat）`);
        el.anchors[an] = [(pt as number[])[0] * k, (pt as number[])[1] * k];
      }
    }
  } else if (kind === 'image' || kind === 'video') {
    // 真实的影像：照片、截图、logo、一段视频。像贴在板上的一张照片，外面手绘一圈框；视频画完之后在框里播
    const name = String(src[kind]), file = resolve(ctx.projectDir ?? '.', name);
    if (!existsSync(file)) throw new SrcError(where, `找不到${kind === 'video' ? '视频' : '图片'} ${name}（路径相对项目目录，如 media/${kind === 'video' ? 'clip.mp4' : 'photo.jpg'}）`);
    const STYLES = ['plain', 'photo', 'avatar'], style = src.style ?? 'plain';
    if (!STYLES.includes(style)) throw new SrcError(where, `style 只能是 plain（贴图，默认）/ photo（带白边和胶带的照片）/ avatar（圆形头像）`);
    let dim: { w: number; h: number } | null, clip: ImageStroke['clip'];
    if (kind === 'video') {
      const info = probeVideo(file);
      if (!info) throw new SrcError(where, `读不出 ${name}：需要装有 ffmpeg / ffprobe，文件要是带画面的视频（mp4、mov、webm、gif）`);
      const from = +(src.from ?? 0), to = Math.min(+(src.to ?? info.dur), info.dur);
      if (!(to > from)) throw new SrcError(where, `from / to 是从片段里取哪几秒（这段视频长 ${info.dur.toFixed(1)} 秒），to 要大于 from`);
      if (to - from > 20) throw new SrcError(where, `一段视频最多播 20 秒（现在是 ${(to - from).toFixed(1)} 秒）：用 from / to 取其中最要紧的几秒，如 { from: 3, to: 9 }`);
      dim = info;
      const fps = 25;
      clip = { dir: '', src: file, fps, n: Math.max(1, Math.round((to - from) * fps)), from, loop: src.loop !== false, w: 0 };
    } else {
      dim = imageSize(readFileSync(file));
      if (!dim || !dim.w || !dim.h) throw new SrcError(where, `读不出 ${name} 的尺寸。支持 PNG、JPEG、WebP、GIF`);
    }
    const round = style === 'avatar';
    const w = src.w ?? src.size ?? 360, h = src.h ?? (round ? w : (w * dim.h) / dim.w);
    // 白边：照片样式四周留一圈，下边宽一点（拍立得）
    const m = style === 'photo' ? Math.max(8, w * 0.045) : 0, pic: Box = { x: m, y: m, w: w - 2 * m, h: h - m * 3.2 };
    if (style !== 'photo') Object.assign(pic, { x: 0, y: 0, w, h });
    // 按比例裁满，不拉伸
    const ar = pic.w / pic.h, sr = dim.w / dim.h, crop = sr > ar ? { x: (1 - ar / sr) / 2, y: 0, w: ar / sr, h: 1 } : { x: 0, y: (1 - sr / ar) * 0.3, w: 1, h: sr / ar };
    if (clip) clip.w = Math.min(1080, Math.ceil(pic.w) * 2); // 抽帧时先裁后缩，存成显示尺寸的两倍
    el.strokes = [{ kind: 'image', file, tx: 0, ty: 0, color: '', len: (w + h) * 0.5, box: { x: 0, y: 0, w, h }, under: true, pic, crop, ...(round ? { round } : {}), ...(clip ? { clip } : {}) }];
    if (style === 'photo') {
      // 一截胶带，斜着贴在上边
      const tw = Math.min(120, w * 0.34), th = tw * 0.3, cx = w / 2, sk = th * 0.25;
      el.strokes.push({ kind: 'fill', pts: [cx - tw / 2, -th * 0.55 + sk, cx + tw / 2, -th * 0.55 - sk, cx + tw / 2, th * 0.45 - sk, cx - tw / 2, th * 0.45 + sk], color: '#f1d98a', alpha: 0.78, len: tw, under: true });
      if (src.frame !== false) el.strokes.push(...R.rect(0, 0, w, h, { ...st, color: '#8a8378', w: Math.max(2, st.w * 0.55), fill: undefined, shade: false }));
    } else if (src.frame !== false) el.strokes.push(...(round ? R.ellipse(w / 2, h / 2, w, h, { ...st, fill: undefined, shade: false }) : R.rect(0, 0, w, h, { ...st, fill: undefined, shade: false })));
  } else if (kind === 'shape') {
    const w = src.w ?? src.size ?? 240, h = src.h ?? src.size ?? 160, sst = { ...st, shade };
    if (src.shape === 'rect') el.strokes = R.rect(0, 0, w, h, sst);
    else if (src.shape === 'ellipse') el.strokes = R.ellipse(0, 0, w, h, sst);
    else if (src.shape === 'circle') el.strokes = R.ellipse(0, 0, w, w, sst);
    else if (src.shape === 'diamond') el.strokes = R.poly([[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]], true, sst);
    else if (src.shape === 'triangle') el.strokes = R.poly([[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], true, sst);
    else if (src.shape === 'cloud') { const d = `M${-w * 0.3},${h * 0.3} C${-w * 0.62},${h * 0.3} ${-w * 0.6},${-h * 0.15} ${-w * 0.33},${-h * 0.12} C${-w * 0.32},${-h * 0.5} ${w * 0.08},${-h * 0.55} ${w * 0.13},${-h * 0.22} C${w * 0.4},${-h * 0.42} ${w * 0.62},${-h * 0.05} ${w * 0.4},${h * 0.08} C${w * 0.6},${h * 0.2} ${w * 0.45},${h * 0.32} ${w * 0.3},${h * 0.3} Z`; el.strokes = R.path(d, sst); }
    else throw new SrcError(where, `没有形状 "${src.shape}"。可用：rect ellipse circle diamond triangle cloud`);
    if (src.inside != null) {
      // 框里的字：和框是一样东西，一起画（框画完接着写字，不会空着框等下一拍）。字号不写时按框的大小取，放不下就缩
      const sb = boxOf(el.strokes), inner = { w: sb.w * (src.shape === 'rect' ? 0.86 : 0.66), h: sb.h * (src.shape === 'rect' ? 0.8 : 0.6) };
      const lines = String(src.inside).split('\n').length;
      let size = typeof src.insideSize === 'string' ? TEXT_TIERS[src.insideSize] ?? NaN : +(src.insideSize ?? Math.min(64, (inner.h / lines) * 0.8));
      if (!(size > 0)) throw new SrcError(where, `insideSize 写字号数字，或档位：${Object.keys(TEXT_TIERS).join(' ')}`);
      let t = textStrokes(String(src.inside), { size, color: st.color, align: 'center' });
      if (src.insideSize == null) while ((t.w > inner.w || t.h > inner.h) && size > 30) { size = Math.max(30, Math.round(size * 0.9)); t = textStrokes(String(src.inside), { size, color: st.color, align: 'center' }); }
      if (t.w > sb.w || t.h > sb.h) throw new SrcError(where, `框里的字“${src.inside}”（${Math.round(t.w)}×${Math.round(t.h)}）比框（${Math.round(sb.w)}×${Math.round(sb.h)}）还大：把框写大（w、h），或者字写短`);
      translateStrokes(t.strokes, sb.x + sb.w / 2 - t.w / 2, sb.y + sb.h / 2 - t.h / 2);
      el.strokes.push(...t.strokes); el.text = String(src.inside); el.missing = t.missing;
    }
  } else if (kind === 'axis') {
    // 数轴：一根带刻度的线，也是一把比例尺。别的东西用 "名字@数值" 落在它的数值上；不画它就只当比例尺用
    const r0 = Array.isArray(src.axis) ? src.axis : [src.axis?.from, src.axis?.to];
    const v0 = +r0[0], v1 = +r0[1];
    if (!Number.isFinite(v0) || !Number.isFinite(v1) || v0 === v1) throw new SrcError(where, 'axis 写数值范围，如 axis: [0, 4]（从 0 到 4）');
    const L = +(src.length ?? 800), up = src.dir === 'up';
    if (!(L > 20)) throw new SrcError(where, 'length 写数轴在板上的长度（像素），如 800');
    if (src.dir != null && !['right', 'up'].includes(src.dir)) throw new SrcError(where, 'dir 只能是 right（从左往右，默认）或 up（从下往上）');
    const at = parseRef(ctx, src.at ?? [80, ctx.fmt.board.h / 2], where).pt; // at 是数轴的起点（数值 v0 的位置）
    const end: Pt = up ? [at[0], at[1] - L] : [at[0] + L, at[1]];
    el.axis = [v0, v1]; el.anchors.start = at; el.anchors.end = end;
    const P = (v: number): Pt => { const k = (v - v0) / (v1 - v0); return [at[0] + (end[0] - at[0]) * k, at[1] + (end[1] - at[1]) * k]; };
    const ast: Style = { ...st, color: color(src.color, THEME.colors.gray), w: src.pen ?? 4, rough: Math.min(st.rough, 0.6) };
    el.strokes = R.line(at[0], at[1], end[0], end[1], ast);
    // 刻度：step 每隔多少一个；或者 ticks 直接列出数值
    const nice = (x: number) => { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
    const ticks: number[] = Array.isArray(src.ticks) ? src.ticks.map(Number) : src.ticks === false ? [] : (() => { const stp = +(src.step ?? nice(Math.abs(v1 - v0) / 5)), out: number[] = []; for (let v = v0, n = 0; (v1 > v0 ? v <= v1 + 1e-9 : v >= v1 - 1e-9) && n < 60; v += (v1 > v0 ? stp : -stp), n++) out.push(+v.toFixed(6)); return out; })();
    const tl = 14, tsz = src.size ?? 38;
    ticks.forEach((v, i) => {
      const p = P(v);
      el.strokes.push(...(up ? R.line(p[0] - tl, p[1], p[0] + tl, p[1], { ...ast, seed: seed + 3 + i }) : R.line(p[0], p[1] - tl, p[0], p[1] + tl, { ...ast, seed: seed + 3 + i })));
      if (src.labels === false) return;
      const t = textStrokes(`${v}${src.unit ?? ''}`, { size: tsz, color: color(src.color, THEME.colors.gray) });
      translateStrokes(t.strokes, up ? p[0] - tl - 10 - t.w : p[0] - t.w / 2, up ? p[1] - t.h / 2 : p[1] + tl + 8);
      el.strokes.push(...t.strokes);
    });
    placed = true;
  } else if (kind === 'span') {
    // 区间条：沿数轴从一个数值画到另一个数值。长度和位置由数轴算，不用手算像素
    const ax = ctx.els.get(String(src.on ?? ''));
    if (!ax) throw new SrcError(where, `span 要写 on: 数轴的名字（数轴定义在它前面）。现在是 ${JSON.stringify(src.on)}`);
    if (!ax.axis) throw new SrcError(where, `on: "${src.on}" 不是数轴（axis）`);
    const r0 = src.span;
    if (!Array.isArray(r0) || r0.length !== 2 || r0.some((v: any) => !Number.isFinite(+v))) throw new SrcError(where, 'span 写起止数值，如 span: [0, 3]');
    const up = ax.anchors.end[0] === ax.anchors.start[0] && ax.anchors.end[1] !== ax.anchors.start[1];
    const a = axisPoint(ax, +r0[0]), b = axisPoint(ax, +r0[1]), th = src.h ?? 50;
    // 离数轴多远：at 给出垂直方向的位置（横轴给 y、竖轴给 x），或者 offset 相对数轴；都不写就紧贴在数轴上方 / 右侧
    let c0: number;
    if (src.at != null) { const p = parseRef(ctx, Array.isArray(src.at) ? src.at : [src.at, src.at], where).pt; c0 = up ? p[0] : p[1]; }
    else c0 = (up ? a[0] : a[1]) + (src.offset ?? (up ? th / 2 + 18 : -(th / 2 + 18)));
    const x0 = up ? c0 - th / 2 : Math.min(a[0], b[0]), y0 = up ? Math.min(a[1], b[1]) : c0 - th / 2;
    const w = up ? th : Math.abs(b[0] - a[0]), h = up ? Math.abs(b[1] - a[1]) : th;
    const sst: Style = { ...st, fill: st.fill ?? (src.color ? color(src.color) : undefined), shade: false };
    el.strokes = w > 2 && h > 2 ? R.rect(x0, y0, w, h, sst) : R.line(x0, y0, x0 + w, y0 + h, sst);
    if (src.inside != null) { // 写在条里面的字（如“3年”）
      const t = textStrokes(String(src.inside), { size: src.insideSize ?? Math.min(48, Math.round(th * 0.72)), color: THEME.ink });
      translateStrokes(t.strokes, x0 + w / 2 - t.w / 2, y0 + h / 2 - t.h / 2);
      el.strokes.push(...t.strokes); el.text = String(src.inside); el.missing = t.missing;
    }
    // 起点、终点也当锚点：别的东西可以接在这一段后面
    el.anchors.from = up ? [x0 + w / 2, a[1]] : [a[0], y0 + h / 2]; el.anchors.to = up ? [x0 + w / 2, b[1]] : [b[0], y0 + h / 2];
    placed = true;
  } else if (kind === 'arrow' || kind === 'line') {
    const refs = src[kind];
    if (!Array.isArray(refs) || refs.length < 2 || refs.length > 9) throw new SrcError(where, `${kind} 要写成 [起点, 终点]，起终点可以是元素 id、"id.锚点" 或 [x, y]；中间可以再写几个途经点（最多 7 个），线顺滑地穿过它们`);
    const a = parseRef(ctx, refs[0], where), b = parseRef(ctx, refs[refs.length - 1], where);
    if (refs.length > 2) {
      // 途经点：一条顺滑的线依次穿过它们（贯穿几行的斜线、一根鞭子）。照写的走，不自动绕路
      const mids = refs.slice(1, -1).map((r: any) => parseRef(ctx, r, where).pt);
      const pad = src.pad ?? 18;
      const p0 = a.el && !a.explicit ? exitPoint(a.el.box, pad, a.pt, mids[0]) : a.pt;
      const p1 = b.el && !b.explicit ? exitPoint(b.el.box, pad, b.pt, mids[mids.length - 1]) : b.pt;
      const path = catmull([p0, ...mids, p1], 10);
      el.strokes = R.poly(path, false, { ...st, rough: Math.min(st.rough, 0.45), bow: 0.2 });
      el.path = path.flat();
      if (kind === 'arrow') {
        const hs = src.head ?? 26, tip = path[path.length - 1], from = path[Math.max(0, path.length - 4)], ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
        for (const sg of [-1, 1]) { const q = ang + Math.PI + sg * 0.48; el.strokes.push(...R.line(tip[0], tip[1], tip[0] + Math.cos(q) * hs, tip[1] + Math.sin(q) * hs, { ...st, rough: 0.4, seed: seed + 11 + sg })); }
      }
      if (src.label) {
        const t = textStrokes(String(src.label), { size: src.labelSize ?? 46, color: st.color }), m = path[Math.floor(path.length / 2)];
        translateStrokes(t.strokes, m[0] + 24, m[1] - t.h / 2); el.strokes.push(...t.strokes);
        lineLabel = boxOf(t.strokes);
      }
      placed = true;
    } else {
    const pad = src.pad ?? 18;
    const p0 = a.el && !a.explicit ? exitPoint(a.el.box, pad, a.pt, b.pt) : a.pt;
    const p1 = b.el && !b.explicit ? exitPoint(b.el.box, pad, b.pt, a.pt) : b.pt;
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
    const midOf = (cv: number): Pt => [(p0[0] + p1[0]) / 2 - (dy / L) * cv * L, (p0[1] + p1[1]) / 2 + (dx / L) * cv * L];
    // 线不从别的东西身上穿过去：按给定的弯度试，穿了就换一个弯度绕开
    const blockers = obstacles(ctx, el, [a.el?.id ?? '', b.el?.id ?? '']);
    const crosses = (cv: number) => { const m = midOf(cv); for (let i = 1; i < 12; i++) { const t = i / 12, u = 1 - t, c1x = 2 * m[0] - (p0[0] + p1[0]) / 2, c1y = 2 * m[1] - (p0[1] + p1[1]) / 2; const x = u * u * p0[0] + 2 * u * t * c1x + t * t * p1[0], y = u * u * p0[1] + 2 * u * t * c1y + t * t * p1[1]; if (hits({ x: x - 5, y: y - 5, w: 10, h: 10 }, blockers, -2)) return true; } return false; };
    const want = src.curve ?? 0, fz = src.__frozen;
    const clear = fz?.curve ?? [want, 0.22, -0.22, 0.36, -0.36, 0.5, -0.5].find(cv => !crosses(cv));
    const curveUsed = clear ?? want;
    if (clear == null) ctx.note?.(where, '这条连线怎么弯都会从别的元素身上穿过去。把两端的元素挪近、挪到中间没有东西的位置，或者拆成两段', 'warn');
    else if (curveUsed !== want) ctx.note?.(where, `连线会从别的元素身上穿过，已自动改成弯度 ${curveUsed} 绕开`);
    el.frozen = { curve: curveUsed };
    const bow = curveUsed * L, mid = midOf(curveUsed);
    el.strokes = bow ? R.curve([p0, mid, p1], { ...st, rough: Math.min(st.rough, 0.6) }) : R.line(p0[0], p0[1], p1[0], p1[1], st);
    el.path = (el.strokes[0] as any).pts.slice();
    if (kind === 'arrow') {
      const hs = src.head ?? 26;
      const head = (tip: Pt, from: Pt, n: number) => { const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]); for (const s of [-1, 1]) { const q = ang + Math.PI + s * 0.48; el.strokes.push(...R.line(tip[0], tip[1], tip[0] + Math.cos(q) * hs, tip[1] + Math.sin(q) * hs, { ...st, rough: 0.4, seed: seed + n + s })); } };
      head(p1, bow ? mid : p0, 11);
      if (src.both) head(p0, bow ? mid : p1, 17);
    }
    if (src.label) { // 箭头上的小字：写在中点、鼓起的那一侧
      const t = textStrokes(String(src.label), { size: src.labelSize ?? 46, color: st.color });
      const nx = -dy / L, ny = dx / L, side = bow >= 0 ? 1 : -1, off = Math.abs(nx) * t.w / 2 + Math.abs(ny) * t.h / 2 + 24;
      let lx = mid[0] + nx * side * off, ly = mid[1] + ny * side * off;
      if (!bow && Math.abs(nx) < 0.3) ly = mid[1] - off; // 水平直线：字写在上面
      // 小字压到别的东西就换到线的另一侧
      const lblObs = [...obstacles(ctx, el), ...lineBoxes(ctx, el)], lb = (x: number, y: number) => ({ x: x - t.w / 2, y: y - t.h / 2, w: t.w, h: t.h });
      const flip = fz?.flip ?? (hits(lb(lx, ly), lblObs, 6) && !hits(lb(2 * mid[0] - lx, 2 * mid[1] - ly), lblObs, 6));
      if (flip) { lx = 2 * mid[0] - lx; ly = 2 * mid[1] - ly; }
      el.frozen = { ...el.frozen, flip };
      translateStrokes(t.strokes, lx - t.w / 2, ly - t.h / 2);
      el.strokes.push(...t.strokes); el.text = String(src.label); el.missing = t.missing;
      lineLabel = lb(lx, ly);
    }
    placed = true;
    }
  } else if (kind === 'note') {
    // 批注：一行小字贴在目标旁边，用一条细线牵过去。用来补数字、名字、出处这类“第二层信息”
    const tg = parseRef(ctx, src.target, where);
    if (!tg.el) throw new SrcError(where, 'note 需要 target: 元素 id（批注贴在谁旁边）');
    const t = textStrokes(String(src.note), { size: src.size ?? 46, color: color(src.color, THEME.colors.gray), align: 'left' });
    const b = tg.el.box, gap = src.gap ?? 54, sideWant = src.side ?? 'right';
    if (!['right', 'left', 'top', 'bottom'].includes(sideWant)) throw new SrcError(where, 'note 的 side 只能是 right left top bottom');
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    // 贴在上/下时可以左右滑、贴在左/右时可以上下滑，免得一行长字顶到板沿
    const slide = (v: number, size: number, total: number) => (size + EDGE * 2 <= total ? Math.min(Math.max(v, EDGE), total - size - EDGE) : v);
    const spot = (sd: string): Pt => [sd === 'right' ? b.x + b.w + gap : sd === 'left' ? b.x - gap - t.w : slide(cx - t.w / 2, t.w, B.w), sd === 'top' ? b.y - gap - t.h : sd === 'bottom' ? b.y + b.h + gap : slide(cy - t.h / 2, t.h, B.h)];
    // 想放的那一侧放不下（出界或压到东西）就换一侧
    const nObs = [...obstacles(ctx, el, [tg.el.id]), ...lineBoxes(ctx, el, [tg.el.id])];
    const okSide = (sd: string, m = 2) => { const q = spot(sd), bx = { x: q[0], y: q[1], w: t.w, h: t.h }; return inBoard(bx, B, m) && !hits(bx, nObs, 8); };
    // 先找不贴板沿的一侧，实在没有再接受贴边的
    const sides = [sideWant, 'right', 'left', 'bottom', 'top'];
    const side = src.__frozen?.side ?? sides.find(sd => okSide(sd, -EDGE)) ?? sides.find(sd => okSide(sd)) ?? sideWant;
    el.frozen = { side };
    let [tx, ty] = spot(side);
    if (ctx.life && !okSide(side)) { // 四边都放不下：就近找一块空地，细线照样牵回去
      tx = Math.min(Math.max(tx, 0), B.w - t.w); ty = Math.min(Math.max(ty, 0), B.h - t.h);
      const sp = hits({ x: tx, y: ty, w: t.w, h: t.h }, [...nObs, tg.el.solid], 8) ? nearestFree({ x: tx, y: ty, w: t.w, h: t.h }, [...nObs, tg.el.solid], B) : [0, 0] as Pt;
      if (sp) { tx += sp[0]; ty += sp[1]; }
    }
    el.solid = { x: tx, y: ty, w: t.w, h: t.h };
    translateStrokes(t.strokes, tx, ty);
    // 细线从文字朝向目标的那条边出发，到目标最近的边
    const tcx = tx + t.w / 2, tcy = ty + t.h / 2, horiz = Math.abs(tcx - cx) / (b.w + t.w) > Math.abs(tcy - cy) / (b.h + t.h);
    const from: Pt = horiz ? [tcx < cx ? tx + t.w + 10 : tx - 10, tcy] : [tcx, tcy < cy ? ty + t.h + 8 : ty - 8];
    const to: Pt = horiz ? [tcx < cx ? b.x - 8 : b.x + b.w + 8, Math.min(Math.max(tcy, b.y + 6), b.y + b.h - 6)] : [Math.min(Math.max(tcx, b.x + 6), b.x + b.w - 6), tcy < cy ? b.y - 8 : b.y + b.h + 8];
    el.strokes = [...R.line(from[0], from[1], to[0], to[1], { ...st, color: color(src.color, THEME.colors.gray), w: 3.5, rough: 0.8 }), ...t.strokes];
    el.text = String(src.note); el.missing = t.missing;
    placed = true;
  } else if (kind === 'mark') {
    const targets = (Array.isArray(src.target) ? src.target : [src.target]).map((t: any) => parseRef(ctx, t, where));
    if (targets.some((t: any) => !t.el)) throw new SrcError(where, 'mark 的 target 要写元素 id');
    // 叉、划线、框、高亮只盖本体，标签留在外面读得清；圈和下划线连标签一起
    const bodyOf = (e: El): Box => (e.body && ['cross', 'strike', 'box', 'highlight'].includes(src.mark) ? { x: e.box.x + e.body.x, y: e.box.y + e.body.y, w: e.body.w, h: e.body.h } : e.box);
    let tb = unionBox(targets.map((t: any) => bodyOf(t.el!)));
    // 标记打在一条箭头或连线上：只在线的中点画一个小的，不盖住整条线的外框。叉、划线的意思是“把这条线掐断”（长斜线的外框很大，会压住两头的东西和标签）
    const cut = ['cross', 'strike'].includes(src.mark);
    if (targets.length === 1 && (cut || ['circle', 'box', 'highlight', 'underline'].includes(src.mark)) && ['arrow', 'line'].includes(targets[0].el!.kind) && targets[0].el!.path && targets[0].el!.path.length >= 4) {
      const T = targets[0].el!, pth = T.path as number[]; let total = 0;
      for (let i = 2; i < pth.length; i += 2) total += Math.hypot(pth[i] - pth[i - 2], pth[i + 1] - pth[i - 1]);
      const at = (f: number): Pt => { let acc = 0; for (let i = 2; i < pth.length; i += 2) { const d = Math.hypot(pth[i] - pth[i - 2], pth[i + 1] - pth[i - 1]); if (acc + d >= total * f) { const k = d ? (total * f - acc) / d : 0; return [pth[i - 2] + (pth[i] - pth[i - 2]) * k, pth[i - 1] + (pth[i + 1] - pth[i - 1]) * k]; } acc += d; } return [pth[pth.length - 2], pth[pth.length - 1]]; };
      const lab: Box | null = T.label ? { x: T.box.x + T.label.x, y: T.box.y + T.label.y, w: T.label.w, h: T.label.h } : null;
      const around = (c: Pt, r: number): Box => ({ x: c[0] - r, y: c[1] - r, w: r * 2, h: r * 2 });
      if (cut) {
        // 叉、划线：把线掐断。画在线上离小字最近的空处——先试中点，压到小字就沿线往两头让
        const r = Math.max(26, Math.min(40, total * 0.12)), clear = (b: Box) => !lab || !hits(b, [lab], 6);
        const spots = [0.5, 0.34, 0.66, 0.24, 0.76].map(f => around(at(f), r));
        tb = spots.find(clear) ?? spots.reduce((a, b) => { const d = (q: Box) => Math.hypot(q.x + r - lab!.x - lab!.w / 2, q.y + r - lab!.y - lab!.h / 2); return d(b) > d(a) ? b : a; });
      } else if (lab) tb = lab; // 圈、框、高亮、下划线：意思是“看这条关系”。线上有小字就标那行小字，圈在字外面，不从字上压过去
      else tb = around(at(0.5), Math.max(34, Math.min(58, total * 0.16))); // 没有小字：圈住线的中段，不去圈整条线的外框
    }
    const ms: Style = { ...st, color: color(src.color, THEME.colors.red), w: src.pen ?? THEME.pen * 1.15 };
    const m = src.mark;
    // 标记是贴着目标画的，挪不走；旁边有别的东西时就收紧一点（圈小一圈、框贴近、下划线只留一道），不压到邻居
    const tids = new Set<string>(targets.map((t: any) => t.el!.id)), me = ctx.life?.get(id);
    const neighbours: Box[] = [];
    if (ctx.life && src.overlap !== true) for (const o of ctx.els.values()) {
      if (tids.has(o.id) || NON_SOLID.has(o.kind) || o.src?.overlap === true) continue;
      if ([...tids].some(t => o.over.has(t) || ctx.els.get(t)!.over.has(o.id))) continue;                  // 本来就叠在目标上（气泡和里面的字）
      if (o.solid.x <= tb.x + 2 && o.solid.y <= tb.y + 2 && o.solid.x + o.solid.w >= tb.x + tb.w - 2 && o.solid.y + o.solid.h >= tb.y + tb.h - 2) continue; // 目标在它里面
      const lf = ctx.life.get(o.id);
      if (me && lf && Math.max(me[0], lf[0]) >= Math.min(me[1], lf[1])) continue;                           // 不同时在板上
      neighbours.push(o.solid);
    }
    const textTarget = targets.every((t: any) => ['text', 'note'].includes(t.el!.kind));
    // 叉和划线跟目标同色就看不出划了什么：换成墨色
    if ((m === 'cross' || m === 'strike') && targets.every((t: any) => color(t.el!.src?.color) === ms.color)) ms.color = ms.color === THEME.ink ? THEME.colors.red : THEME.ink;
    const make = (k: number): Stroke[] => {
      const pad = Math.max(3, (src.pad ?? 14) * k);
      const b = { x: tb.x - pad, y: tb.y - pad, w: tb.w + pad * 2, h: tb.h + pad * 2 }, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (m === 'circle') return R.ellipse(cx, cy, b.w + Math.max(44, b.h * 0.5) * k, b.h * (1 + 0.12 * k) + 14 * k, { ...ms, rough: 1.6 * (0.5 + k / 2), double: true });
      if (m === 'box') return R.rect(b.x, b.y, b.w, b.h, { ...ms, rough: 1.3 * (0.5 + k / 2) });
      if (m === 'underline') return [...R.line(b.x, b.y + b.h + 2, b.x + b.w, b.y + b.h + 2, ms), ...(k < 0.5 ? [] : R.line(b.x + b.w * 0.98, b.y + b.h + 14, b.x + b.w * 0.08, b.y + b.h + 14, { ...ms, seed: seed + 5 }))];
      // 压在字上的叉和划线画细一点、略透：划掉了，但划掉的是什么还读得出
      if (m === 'strike') return R.line(b.x, cy + 2, b.x + b.w, cy - 2, { ...ms, w: ms.w * (textTarget ? 0.95 : 1.2) }).map(q => (textTarget && q.kind === 'line' ? { ...q, alpha: 0.82 } : q));
      if (m === 'cross') return [...R.line(b.x, b.y, b.x + b.w, b.y + b.h, { ...ms, w: ms.w * (textTarget ? 0.95 : 1.4) }), ...R.line(b.x + b.w, b.y, b.x, b.y + b.h, { ...ms, w: ms.w * (textTarget ? 0.95 : 1.4), seed: seed + 5 })].map(q => (textTarget && q.kind === 'line' ? { ...q, alpha: 0.82 } : q));
      if (m === 'highlight') { const pts = [b.x + 4, cy + 3, b.x + b.w - 4, cy - 3]; return [{ kind: 'line', pts, w: tb.h * 0.82, color: color(src.color, THEME.colors.yellow), len: polyLen(pts), under: true, alpha: 0.38 }]; }
      if (m === 'check') return R.poly([[cx - b.w * 0.3, cy], [cx - b.w * 0.05, cy + b.h * 0.3], [cx + b.w * 0.4, cy - b.h * 0.4]], false, { ...ms, color: color(src.color, THEME.colors.green), w: ms.w * 1.5, rough: 0.6 });
      if (m === 'burst') { const out: Stroke[] = [], n = 10; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 - Math.PI / 2, rx = b.w / 2 + 14 * k, ry = b.h / 2 + 14 * k, l = (30 + (i % 2) * 16) * (0.4 + 0.6 * k); out.push(...R.line(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, cx + Math.cos(a) * (rx + l), cy + Math.sin(a) * (ry + l), { ...ms, seed: seed + i, rough: 0.5 })); } return out; }
      return [];
    };
    let mk = src.__frozen?.k ?? 1;
    el.strokes = make(mk);
    if (src.__frozen?.k == null && neighbours.length && ['circle', 'box', 'underline', 'burst', 'cross'].includes(m)) {
      for (const k of [1, 0.7, 0.45, 0.2, 0]) { mk = k; el.strokes = make(k); if (!hits(boxOf(el.strokes), neighbours)) break; }
    }
    el.frozen = { k: mk };
    if (!el.strokes.length) throw new SrcError(where, `没有标记 "${m}"。可用：circle box underline strike cross highlight check burst`);
    placed = true;
  } else if (kind === 'detail') {
    // 细节框：像拿放大镜看一样东西的里面。框画在板上的空地方，两条引线从那样东西连到框；框里的东西写 in: 框的名字
    const node = ctx.els.get(String(src.detail));
    if (!node) throw new SrcError(where, `detail 写要展开的那样东西的 id（定义在它前面），如 detail: bank。现在是 ${JSON.stringify(src.detail)}`);
    const shp = src.shape ?? 'rect', w = +(src.w ?? 480), h = shp === 'circle' ? w : +(src.h ?? 360);
    if (!['rect', 'circle'].includes(shp)) throw new SrcError(where, 'detail 的 shape 只能是 rect（方框，默认）或 circle（圆，像放大镜）');
    if (!(w >= 160 && h >= 120)) throw new SrcError(where, '细节框至少 160×120，里面要画得下一张小图：写大 w、h');
    if (!Array.isArray(src.at)) throw new SrcError(where, 'detail 的 at 写框的中心 [x, y]（放在板上空着的地方，和要展开的东西隔开一点）');
    const [cx, cy] = parseRef(ctx, src.at, where).pt;
    const fst: Style = { ...st, color: color(src.color, THEME.colors.gray), w: src.pen ?? 5, rough: Math.min(st.rough, 0.7), fill: '#ece5d3', fillStyle: 'solid', fillAlpha: 0.5, shade: false };
    el.strokes = shp === 'circle' ? R.ellipse(cx, cy, w, w, fst) : R.rect(cx - w / 2, cy - h / 2, w, h, fst);
    // 引线：从那样东西朝框的两侧边缘，连到框离它近的那两个角（圆框就是两条切线方向上的点）
    const N = node.body ? { x: node.box.x + node.body.x, y: node.box.y + node.body.y, w: node.body.w, h: node.body.h } : node.box;
    const nc: Pt = [N.x + N.w / 2, N.y + N.h / 2], dx = cx - nc[0], dy = cy - nc[1], L = Math.hypot(dx, dy) || 1, gap = 10;
    let pairs: [Pt, Pt][];
    if (shp === 'circle') {
      const px = -dy / L, py = dx / L, rn = Math.min(N.w, N.h) / 2 + gap, rf = w / 2;
      pairs = [1, -1].map(sg => [[nc[0] + px * rn * sg, nc[1] + py * rn * sg], [cx + px * rf * sg - (dx / L) * rf * 0.25, cy + py * rf * sg - (dy / L) * rf * 0.25]] as [Pt, Pt]);
    } else if (Math.abs(dx) / (N.w / 2 + w / 2) >= Math.abs(dy) / (N.h / 2 + h / 2)) {
      const sx = Math.sign(dx) || 1, nx = sx > 0 ? N.x + N.w + gap : N.x - gap, fx = sx > 0 ? cx - w / 2 : cx + w / 2;
      pairs = [[[nx, N.y], [fx, cy - h / 2]], [[nx, N.y + N.h], [fx, cy + h / 2]]];
    } else {
      const sy = Math.sign(dy) || 1, ny = sy > 0 ? N.y + N.h + gap : N.y - gap, fy = sy > 0 ? cy - h / 2 : cy + h / 2;
      pairs = [[[N.x, ny], [cx - w / 2, fy]], [[N.x + N.w, ny], [cx + w / 2, fy]]];
    }
    el.leaders = pairs;
    el.anchors.node = nc;
    placed = true;
  } else if (kind === 'chart') {
    const csrc = { ...src };
    el.strokes = chartStrokes(csrc, { ...st, shade }, where); el.text = (src.labels ?? []).join('') || undefined;
    if (csrc.__path) el.path = csrc.__path;
    if (csrc.__frame) frame = csrc.__frame;
  }

  if (!el.strokes.length) throw new SrcError(where, '这个元素没有画出任何笔画');
  // 标签：写在元素正下方，属于元素的一部分，跟着一起画
  const core = boxOf(el.strokes);
  let labelStrokes: Stroke[] = [];
  if (src.label && kind !== 'arrow' && kind !== 'line') {
    const t = textStrokes(String(src.label), { size: src.labelSize ?? 50, color: st.color });
    translateStrokes(t.strokes, core.x + core.w / 2 - t.w / 2, core.y + core.h + (el.strokes.some(s => (s as any).deco) ? 24 : 14)); // 有阴影就让开一点
    labelStrokes = t.strokes; el.text = (el.text ? el.text + ' ' : '') + String(src.label); // 手绘件自带的字和标签分开，分镜表里才不会粘成“粉面粉店” el.missing = [...(el.missing ?? []), ...t.missing];
    el.strokes.push(...labelStrokes);
  }
  el.box = frame && !labelStrokes.length ? frame : boxOf(el.strokes);
  if (frame && !labelStrokes.length) el.fixedBox = true;
  if (labelStrokes.length) el.body = { x: core.x - el.box.x, y: core.y - el.box.y, w: core.w, h: core.h };
  if (lineLabel) el.label = { x: lineLabel.x - el.box.x, y: lineLabel.y - el.box.y, w: lineLabel.w, h: lineLabel.h };

  if (!placed) {
    const keys = POS_KEYS.filter(k => k in src);
    if (keys.length > 1) throw new SrcError(where, `只能有一种定位方式：at / rightOf / leftOf / above / below（现在有 ${keys.length} 种）。也可以都不写，让引擎自动找空位`);
    const b = el.box, gap = src.gap ?? 40;
    let tx = 0, ty = 0, auto = false;
    if (!keys.length) { auto = true; tx = B.w / 2 - (b.x + b.w / 2); ty = B.h / 2 - (b.y + b.h / 2); }
    else if ('at' in src) {
      const r = parseRef(ctx, src.at, where);
      const an = src.anchor ?? 'center';
      // anchor 也可以是元素自己的锚点：小人的 hip（坐到凳子上）、feet、handR，手绘件自己声明的锚点
      const own = !RESERVED_ANCHORS.includes(an) && el.anchors[an];
      const ax = own ? own[0] : /left/i.test(an) ? b.x : /right/i.test(an) ? b.x + b.w : b.x + b.w / 2;
      const ay = own ? own[1] : /top/i.test(an) ? b.y : /bottom/i.test(an) ? b.y + b.h : b.y + b.h / 2;
      tx = r.pt[0] - ax; ty = r.pt[1] - ay;
      if (r.el) { el.over.add(r.el.id); for (const o of r.el.over) el.over.add(o); } // 明确叠放在它上面
    } else {
      const key = keys[0], ref = ctx.els.get(String(src[key]));
      if (!ref) throw new SrcError(where, `${key} 引用了不存在（或定义在它后面）的元素 "${src[key]}"`);
      for (const o of ref.over) el.over.add(o); // 挨着气泡里的东西摆，自己也在气泡里
      const rb = ref.box, al = src.align ?? 'center';
      const alignX = () => (al === 'start' ? rb.x - b.x : al === 'end' ? rb.x + rb.w - b.x - b.w : rb.x + rb.w / 2 - b.x - b.w / 2);
      const alignY = () => (al === 'start' ? rb.y - b.y : al === 'end' ? rb.y + rb.h - b.y - b.h : rb.y + rb.h / 2 - b.y - b.h / 2);
      if (key === 'rightOf') { tx = rb.x + rb.w + gap - b.x; ty = alignY(); }
      else if (key === 'leftOf') { tx = rb.x - gap - b.x - b.w; ty = alignY(); }
      else if (key === 'below') { ty = rb.y + rb.h + gap - b.y; tx = alignX(); }
      else { ty = rb.y - gap - b.y - b.h; tx = alignX(); }
    }
    tx += src.dx ?? 0; ty += src.dy ?? 0;
    // 差一点对齐的，引擎帮着对齐：手写的坐标离同类东西的边只差十几个像素时吸过去。字对左边和中线，东西对底边和中线
    if (ctx.life && src.snap !== false && src.__rigid !== true && Array.isArray(src.at) && src.at.every((v: any) => typeof v === 'number')) {
      const me = ctx.life.get(id), isText = kind === 'text', THINGS = ['figure', 'doodle', 'icon', 'parts', 'image', 'video'], nb = { x: b.x + tx, y: b.y + ty, w: b.w, h: b.h };
      let sx = 0, sy = 0, bx = 19, by = 19;
      if (me && (isText || THINGS.includes(kind))) for (const o of ctx.els.values()) {
        if (isText ? o.kind !== 'text' : !THINGS.includes(o.kind)) continue;
        if (o.src?.__rigid === true) continue;
        const lf = ctx.life.get(o.id); if (!lf || Math.max(me[0], lf[0]) >= Math.min(me[1], lf[1])) continue;
        const ob = o.body ? { x: o.box.x + o.body.x, y: o.box.y + o.body.y, w: o.body.w, h: o.body.h } : o.box;
        const gapX = Math.max(ob.x - (nb.x + nb.w), nb.x - (ob.x + ob.w)), gapY = Math.max(ob.y - (nb.y + nb.h), nb.y - (ob.y + ob.h));
        // 上下排着的对左边 / 中线；左右排着的对底边 / 中线
        if (gapY > -4 && gapY < 320 && gapX < 0) for (const d of isText ? [ob.x - nb.x, ob.x + ob.w / 2 - nb.x - nb.w / 2] : [ob.x + ob.w / 2 - nb.x - nb.w / 2]) if (Math.abs(d) > 0.5 && Math.abs(d) < bx) { bx = Math.abs(d); sx = d; }
        if (gapX > -4 && gapX < 320 && gapY < 0) for (const d of isText ? [ob.y + ob.h / 2 - nb.y - nb.h / 2] : [ob.y + ob.h - nb.y - (el.body ? el.body.y + el.body.h : nb.h), ob.y + ob.h / 2 - nb.y - nb.h / 2]) if (Math.abs(d) > 0.5 && Math.abs(d) < by) { by = Math.abs(d); sy = d; }
      }
      if (sx || sy) { tx += sx; ty += sy; el.snapped = [sx, sy]; }
    }
    if (el.figure) { el.figure.dx = 0; el.figure.dy = 0; el.figure.labelStrokes = labelStrokes; }
    shiftEl(el, tx, ty);
    if (ctx.life) {
      const obs = obstacles(ctx, el);
      if (auto) {
        const near = src.near != null ? parseRef(ctx, src.near, where).pt : undefined;
        const sp = autoSpot(el.box, obs, B, near);
        if (sp) shiftEl(el, sp[0], sp[1]); else ctx.note?.(where, '板上已经没有放得下它的空地了（没写位置，由引擎自动找空位）。擦掉一些旧内容、缩小它，或换一块板');
      } else if (src.__rigid !== true) { // 成组的元素整体定位，不单独挪
        // 出了画板就拉回来；压到同时存在的东西就挪到最近的空位
        const bx = el.box;
        if (!inBoard(bx, B) && bx.w <= B.w && bx.h <= B.h) {
          // 拉回来时留一点边，不贴着板沿
          const mx = Math.min(EDGE, Math.max(0, (B.w - bx.w) / 2)), my = Math.min(EDGE, Math.max(0, (B.h - bx.h) / 2));
          const clamp = (m1: number, m2: number): Pt => [Math.min(Math.max(bx.x, m1), B.w - bx.w - m1) - bx.x, Math.min(Math.max(bx.y, m2), B.h - bx.h - m2) - bx.y];
          let [cx, cy] = clamp(mx, my);
          // 留边反而把它推到别的东西上时，就只拉回到板沿
          if (hits({ x: bx.x + cx, y: bx.y + cy, w: bx.w, h: bx.h }, obs)) { const z = clamp(0, 0); if (!hits({ x: bx.x + z[0], y: bx.y + z[1], w: bx.w, h: bx.h }, obs)) [cx, cy] = z; }
          shiftEl(el, cx, cy); el.nudged = [cx, cy];
        }
        if (hits(el.box, obs)) {
          const sp = nearestFree(el.box, obs, B);
          if (sp) { shiftEl(el, sp[0], sp[1]); el.nudged = [(el.nudged?.[0] ?? 0) + sp[0], (el.nudged?.[1] ?? 0) + sp[1]]; }
        }
        if (el.nudged && Math.hypot(el.nudged[0], el.nudged[1]) > 30) {
          const far = Math.hypot(el.nudged[0], el.nudged[1]) > FAR_NUDGE;
          ctx.note?.(where, `按你写的位置它会${hits({ x: el.box.x - el.nudged[0], y: el.box.y - el.nudged[1], w: el.box.w, h: el.box.h }, obs) ? '压到别的元素' : '超出画板'}，已自动挪开 (${el.nudged[0].toFixed(0)}, ${el.nudged[1].toFixed(0)})。${far ? '挪得很远，它多半已经不在你想让它在的地方了（离开了原来挨着的东西）：改它的坐标，或给这块板腾地方；' : '想自己定位置就改它的坐标；'}确实要叠放就写 overlap: true`, far ? 'warn' : 'info');
        }
      }
    }
    if (el.figure) {
      const fg = el.figure;
      el.rebuild = (pose, face) => { const r = figureStrokes({ ...fg.spec, pose, face }); translateStrokes(r.strokes, fg.dx, fg.dy); return [...r.strokes, ...(fg.prop ? cloneStrokes(fg.prop.strokes, r.anchors[fg.prop.hand][0] + fg.dx, r.anchors[fg.prop.hand][1] + fg.dy) : []), ...fg.labelStrokes]; };
    }
  } else if (src.dx || src.dy) { translateStrokes(el.strokes, src.dx ?? 0, src.dy ?? 0); el.box = boxOf(el.strokes); }
  setAnchors(el);
  if (kind !== 'note') el.solid = el.box;
  return el;
}

/** 数字写成几位小数：变化途中的值按最终值的位数写，不出现 37.29999 */
export const fmtNum = (v: number, dec?: number) => (dec == null ? String(v) : v.toFixed(dec));
export const decimalsOf = (v: number) => { const m = /\.(\d+)$/.exec(String(v)); return m ? m[1].length : 0; };

/** 元素的定义里引用了哪些别的元素（箭头的两端、批注和标记的对象、区间条的数轴、相对定位、"id.锚点" 坐标）。
 *  这些东西挪动或变化时，它要跟着重新生成 */
export function depsOf(src: any, has: (id: string) => boolean): string[] {
  const out = new Set<string>();
  const take = (v: any) => {
    if (typeof v === 'string') { const id = v.split('.')[0].split('@')[0]; if (has(id)) out.add(id); }
    else if (Array.isArray(v)) v.forEach(take);
  };
  for (const k of ['arrow', 'line', 'target', 'on', 'at', 'rightOf', 'leftOf', 'above', 'below', 'near']) if (src?.[k] != null) take(src[k]);
  return [...out];
}

/** 穿过每个点的顺滑曲线（Catmull-Rom），每段取 k 个点 */
function catmull(p: Pt[], k: number): Pt[] {
  const out: Pt[] = [p[0]];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    for (let j = 1; j <= k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(d => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)) as Pt);
    }
  }
  return out;
}
function chartStrokes(src: any, st: Style, where: string): Stroke[] {
  const data: number[] = src.data;
  if (!Array.isArray(data) || data.length < 2 || data.some(v => typeof v !== 'number')) throw new SrcError(where, 'chart 需要 data: [数字, ...]（至少 2 个）');
  // range：固定的取值范围（下限在底边，上限在顶边）。几张图要比高低，就写 range 和同一个 perUnit（每个单位多少像素），高度由它算出来
  let rg: [number, number] | null = null;
  if (src.range != null) {
    if (!Array.isArray(src.range) || src.range.length !== 2 || src.range.some((v: any) => typeof v !== 'number') || !(src.range[1] > src.range[0])) throw new SrcError(where, 'range 写 [下限, 上限]，上限大于下限，如 range: [0, 300]');
    rg = [src.range[0], src.range[1]];
  }
  if (src.perUnit != null && !(rg && +src.perUnit > 0)) throw new SrcError(where, 'perUnit（每个单位多少像素）要和 range 一起写，且大于 0：几张图写同一个 perUnit，高低才能直接比');
  const W = src.w ?? 620, H = rg && src.perUnit ? (rg[1] - rg[0]) * +src.perUnit : src.h ?? 380, n = data.length, out: Stroke[] = [];
  // 固定了取值范围的图，占位框就是整个范围：数据变了，图不挪地方，几张图也对得齐
  if (rg) src.__frame = { x: 0, y: 0, w: W, h: H };
  const max = Math.max(...data, 0), min = src.chart === 'line' ? Math.min(...data) - (Math.max(...data) - Math.min(...data)) * 0.25 : 0;
  const Y = rg ? (v: number) => H - ((v - rg![0]) / (rg![1] - rg![0])) * H : (v: number) => H - ((v - min) / (max - min || 1)) * H * 0.86;
  const hl: Record<number, string> = typeof src.highlight === 'number' ? { [src.highlight]: 'red' } : src.highlight ?? {};
  // 坐标轴（axes: false 不画：几条线叠着比的时候，轴是多余的墨）
  if (src.axes !== false) out.push(...R.line(0, -10, 0, H, st), ...R.line(0, H, W + 10, H, { ...st, seed: st.seed + 1 }));
  // 基准线：base 那个值画一条很淡的细线，“平时”在哪儿一眼就看得出
  if (src.base != null) {
    if (typeof src.base !== 'number') throw new SrcError(where, 'base 写一个数（基准线画在这个值上），如 base: 100');
    out.push(...R.line(0, Y(src.base), W, Y(src.base), { ...st, color: color('gray'), w: Math.max(2, st.w * 0.35), rough: 0.3, seed: st.seed + 3 }).map(k => ({ ...k, alpha: 0.45 }) as Stroke));
  }
  const tsize = Math.min(44, (W / n) * 0.42);
  const lab = (s: string, cx: number, y: number, c: string, size = tsize) => { const t = textStrokes(s, { size, color: c }); translateStrokes(t.strokes, cx - t.w / 2, y); out.push(...t.strokes); };
  if (src.chart === 'bar') {
    const slot = W / n, bw = slot * 0.56;
    data.forEach((v, i) => {
      const c = color(hl[i] ?? src.color ?? 'blue'), x = slot * i + (slot - bw) / 2;
      out.push(...R.rect(x, Y(v), bw, H - Y(v), { ...st, color: c, fill: isInk() ? wash(c) : c, seed: st.seed + 10 + i }));
      if (src.values) lab(fmtNum(v, src.__dec?.[i]) + (src.unit ?? ''), x + bw / 2, Y(v) - tsize - 8, c);
      if (src.labels?.[i] != null) lab(String(src.labels[i]), x + bw / 2, H + 12, st.color, tsize * 0.9);
    });
  } else if (src.chart === 'line') {
    const X = (i: number) => (W * (i + 0.5)) / n, c = color(src.color ?? 'blue');
    const linePts = data.map((v, i) => [X(i), Y(v)] as Pt);
    // smooth：顺滑的曲线（波浪），不是折线。轨迹也取曲线上的点
    const pts = src.smooth ? catmull(linePts, 8) : linePts;
    (src as any).__path = pts.flat();
    // fill：线和基准线（没写 base 就是底边）之间淡淡涂一层，像墨洇开
    if (src.fill) {
      const y0 = src.base != null ? Y(src.base) : H, area = [pts[0][0], y0, ...pts.flat(), pts[pts.length - 1][0], y0];
      out.push({ kind: 'fill', pts: area, color: color(src.fill), alpha: src.fillAlpha ?? 0.16, len: Math.sqrt(polyLen(area)) * 10, under: true });
    }
    out.push(...(src.smooth
      ? R.poly(pts, false, { ...st, color: c, w: st.w * 1.25, rough: 0.35, bow: 0.2, seed: st.seed + 9 })
      : R.poly(linePts, false, { ...st, color: c, w: st.w * 1.25, rough: 0.5, seed: st.seed + 9 })));
    data.forEach((v, i) => {
      const hc = hl[i] ? color(hl[i]) : null;
      if (hc) out.push(...R.ellipse(X(i), Y(v), 26, 26, { ...st, color: hc, fill: hc, fillStyle: 'solid', fillAlpha: 1, seed: st.seed + 20 + i }));
      if (src.values && (hc || i === 0 || i === n - 1)) lab(String(v) + (src.unit ?? ''), X(i), Y(v) - tsize - 16, hc ?? c);
      if (src.labels?.[i] != null) lab(String(src.labels[i]), X(i), H + 12, st.color, tsize * 0.9);
    });
  } else throw new SrcError(where, `没有图表类型 "${src.chart}"。可用：bar line`);
  return out;
}
