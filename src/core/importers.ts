// 素材导入：把外部的手绘数据（Excalidraw 素材库、Quick Draw 简笔画）转成本项目的手绘件。
// 只转几何，不带原来的线宽和抖动：进来之后由我们自己的笔重新画一遍，所以和内置素材是同一种笔触。
import YAML from 'yaml';

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

/** 手绘件 → YAML 文本：坐标数组写成一行，和手写的手绘件一个样子 */
export function doodleYaml(d: Doodle): string {
  const doc = new YAML.Document(d);
  YAML.visit(doc, { Seq(_k, node) { if (node.items.every((i: any) => YAML.isScalar(i) || (YAML.isSeq(i) && i.items.every((j: any) => YAML.isScalar(j))))) node.flow = true; } });
  return doc.toString({ lineWidth: 0 });
}
