// 活元素：画面不只是“画出来、挪一挪”，东西本身会变——横条伸长、数字滚动、柱子长高，
// 连着它的箭头、批注、标签跟着重新生成。某一时刻一个元素长什么样，由它的参数在这一刻的值算出来。
import type { TL, Compiled } from './compile';
import type { El } from './elements';
import { translateStrokes, type Pt, type Stroke } from './strokes';
import { color } from './theme';

// ── 缓动：动作的手感 ──
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
export const EASES: Record<string, (k: number) => number> = {
  /** 慢起慢收（默认） */
  soft: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  /** 冲过头一点再弹回来：东西“到位”时有分量 */
  spring: k => (k >= 1 ? 1 : 1 - Math.exp(-5 * k) * Math.cos(1.8 * Math.PI * k)),
  /** 一下子过去，最后轻轻停住：干脆 */
  snap: k => 1 - Math.pow(1 - k, 4),
  /** 匀速：走路、流动 */
  linear: k => k,
};
export const easeBy = (name: string | undefined, k: number) => (EASES[name ?? 'soft'] ?? EASES.soft)(clamp01(k));

// ── 参数插值 ──
/** base：变完就是定义里的样子（grow、count 从零长到定义的值），之后不用再重新生成 */
export interface Morph { t0: number; t1: number; from: Record<string, any>; to: Record<string, any>; ease?: string; base?: boolean }

const HEX = /^#[0-9a-f]{6}$/i;
function lerpColor(a: string, b: string, k: number): string {
  const p = (s: string, i: number) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map(i => Math.round(p(a, i) + (p(b, i) - p(a, i)) * k).toString(16).padStart(2, '0')).join('');
}
function lerpVal(a: any, b: any, k: number, key: string): any {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * (key === '__num' ? clamp01(k) : k);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(x => typeof x === 'number') && b.every(x => typeof x === 'number')) return a.map((x, i) => x + (b[i] - x) * k);
  if (key === 'color' && typeof a === 'string' && typeof b === 'string') { const ca = color(a), cb = color(b); if (HEX.test(ca) && HEX.test(cb)) return lerpColor(ca, cb, clamp01(k)); }
  return k < 0.5 ? a : b;
}
/** t 时刻的参数补丁；第二个返回值是“这个状态的名字”，同名的状态长得一样，可以缓存。空串 = 原样 */
export function morphAt(morphs: Morph[], t: number): [Record<string, any>, string] {
  let cur: Record<string, any> = {}, key = '';
  for (let i = 0; i < morphs.length; i++) {
    const m = morphs[i];
    if (t < m.t0) break;
    if (t >= m.t1) { if (m.base) { cur = {}; key = ''; } else { cur = m.to; key = `${i}`; } continue; }
    const k = easeBy(m.ease, (t - m.t0) / (m.t1 - m.t0));
    cur = Object.fromEntries(Object.keys(m.to).map(p => [p, lerpVal(m.from[p], m.to[p], k, p)]));
    key = `${i}:${k.toFixed(3)}`;
  }
  return [cur, key];
}

// ── 数字：count 让一串字里的那个数滚动 ──
const NUM = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/;
/** 一串字里的第一个数。没有数返回 null */
export function numberIn(text: string): { value: number; dec: number; comma: boolean } | null {
  const m = NUM.exec(text);
  if (!m) return null;
  const raw = m[0], comma = raw.includes(','), v = +raw.replace(/,/g, ''), d = /\.(\d+)$/.exec(raw);
  return Number.isFinite(v) ? { value: v, dec: d ? d[1].length : 0, comma } : null;
}
export function withNumber(text: string, v: number, dec: number, comma: boolean): string {
  let s = v.toFixed(dec);
  if (comma) { const [i, f] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); }
  return text.replace(NUM, s);
}
/** 补丁里的内部字段换成元素真正认识的字段 */
function toSrc(el: El, patch: Record<string, any>): Record<string, any> {
  const { __num, ...rest } = patch;
  if (__num != null) { const n = numberIn(String(el.src.text)); if (n) rest.text = withNumber(String(el.src.text), __num, (patch.__numDec ?? n.dec), n.comma); }
  delete rest.__numDec;
  if (Array.isArray(rest.data) && el.kind === 'chart') rest.__dec = (el.src.data as number[]).map(v => { const m = /\.(\d+)$/.exec(String(v)); return m ? m[1].length : 0; });
  return rest;
}

// ── 某一时刻，每块板上哪些东西的样子和定义时不一样 ──
interface SceneLive { tls: Map<string, TL>; base: Map<string, El>; order: TL[] }
const sceneCache = new WeakMap<Compiled, Map<number, SceneLive | null>>();
function sceneLive(c: Compiled, si: number): SceneLive | null {
  let m = sceneCache.get(c); if (!m) sceneCache.set(c, (m = new Map()));
  if (m.has(si)) return m.get(si)!;
  const sc = c.scenes[si], tls = new Map<string, TL>();
  for (const tl of c.tls) if (tl.scene === si) tls.set(tl.el.id, tl);
  // 按定义的顺序（被引用的写在前面），挪动的、变化的、跟着别人变的
  const order = sc.els.map(id => tls.get(id)!).filter(tl => tl && (tl.moves.length || tl.morphs.length || tl.live?.length));
  const out = order.some(tl => tl.morphs.length || tl.live?.length) ? { tls, base: new Map([...tls].map(([k, v]) => [k, v.el])), order } : null;
  m.set(si, out);
  return out;
}
function shiftedEl(el: El, d: Pt): El {
  const sh = (p: Pt): Pt => [p[0] + d[0], p[1] + d[1]];
  return { ...el, box: { ...el.box, x: el.box.x + d[0], y: el.box.y + d[1] }, solid: { ...el.solid, x: el.solid.x + d[0], y: el.solid.y + d[1] },
    anchors: Object.fromEntries(Object.entries(el.anchors).map(([k, p]) => [k, sh(p)])), path: el.path?.map((v, i) => v + d[i % 2]) };
}
const cacheOf = new WeakMap<TL, Map<string, El>>();
/** 定义时的位置是引擎避让、吸附过的；重新生成时不再避让，差多少补多少 */
const offsets = new WeakMap<TL, Pt>();
/** 按一组参数、一组周围元素重新生成，并补上定义时引擎挪过的那一段 */
export function remade(tl: TL, patch: Record<string, any>, els: Map<string, El>, base: Map<string, El>): El {
  let off = offsets.get(tl);
  if (!off) { const b0 = tl.remake!({}, base).box; off = [tl.el.box.x - b0.x, tl.el.box.y - b0.y]; offsets.set(tl, off); }
  const built = tl.remake!(toSrc(tl.el, patch), els);
  return off[0] || off[1] ? (translateStrokes(built.strokes, off[0], off[1]), shiftedEl(built, off)) : built;
}

/**
 * t 时刻这块板上要换掉笔画的元素：元素 → 这一刻的笔画。
 * moveAt 给出挪动的元素此刻的位移（不含晃动），连着它的东西据此重新生成
 */
export function liveStrokes(c: Compiled, si: number, t: number, moveAt: (tl: TL, t: number) => Pt): Map<TL, Stroke[]> | null {
  const S = sceneLive(c, si);
  if (!S) return null;
  const out = new Map<TL, Stroke[]>();
  let cur: Map<string, El> | null = null;
  const keys = new Map<string, string>();
  for (const tl of S.order) {
    const id = tl.el.id;
    if (tl.moves.length) {
      const d = moveAt(tl, t);
      if (Math.abs(d[0]) + Math.abs(d[1]) < 0.05) continue;
      (cur ??= new Map(S.base)).set(id, shiftedEl(tl.el, d));
      keys.set(id, `${d[0].toFixed(1)},${d[1].toFixed(1)}`);
      continue;
    }
    if (!tl.remake) continue;
    const [patch, mk] = morphAt(tl.morphs, t);
    const dk = (tl.live ?? []).map(d => keys.get(d) ?? '').join('|');
    if (!mk && !dk.replace(/\|/g, '')) continue;
    const key = mk + '#' + dk;
    let cache = cacheOf.get(tl); if (!cache) cacheOf.set(tl, (cache = new Map()));
    let el = cache.get(key);
    if (!el) {
      try { el = remade(tl, patch, cur ?? S.base, S.base); } catch { el = tl.el; } // 变化途中某个值排不出来（框比字小之类）：这一刻保持原样
      if (cache.size > 6) cache.delete(cache.keys().next().value!); // 往后渲染，旧的状态用不到了
      cache.set(key, el);
    }
    (cur ??= new Map(S.base)).set(id, el);
    keys.set(id, key);
    out.set(tl, el.strokes);
  }
  return out.size ? out : null;
}
