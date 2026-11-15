// 计划的结构草图：还没有任何场景文件时，把 plan.yaml 画成一张看得懂的图。
// 它回答三件事：每个分区里有谁、写什么字、画什么图；谁连着谁；这些东西是按什么顺序一段段加上去的。
// 同一套排法既画“讲完时的全貌”，也画“讲到第 N 段时的样子”（前面的淡下去，这一段的亮着），所以逐段的小图之间位置不跳。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { drawStrokes, type Env } from '../core/render';
import { textStrokes, textWidth } from '../core/text';
import { buildElement, type El, type BuildCtx } from '../core/elements';
import { boardBox, planRegions, type Plan, type PlanBoard } from '../core/plan';
import { THEME, type Format } from '../core/theme';

interface Row { seg: number; words: string[]; diagram?: string; y: number }
export interface SketchLayout {
  B: { w: number; h: number }; regions: Record<string, [number, number, number, number]>;
  els: Map<string, El>; /** 元素是第几段加上去的 */ born: Map<string, number>;
  rows: Map<string, { rows: Row[]; size: number; x: number; w: number; more: number }>;
  hero?: { seg: number; word: string };
  /** 关系箭头上的小字，各自放在哪儿 */
  labels: { id: string; text: string; size: number; x: number; y: number; w: number; h: number }[];
}

const BADGE = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
export const badge = (i: number) => BADGE[i] ?? `(${i + 1})`;
const clip = (t: string, size: number, maxW: number) => { if (textWidth(t, size) <= maxW) return t; let o = ''; for (const ch of t) { if (textWidth(o + ch + '…', size) > maxW) break; o += ch; } return o + '…'; };

export function layoutSketch(plan: Plan, b: PlanBoard, fmt: Format, dir: string): SketchLayout {
  const B = boardBox(b, fmt), { regions } = planRegions(b, fmt);
  const els = new Map<string, El>(), life = new Map<string, [number, number]>(), born = new Map<string, number>();
  const ctx: BuildCtx = { scene: 'sketch', fmt: { ...fmt, board: { x: 0, y: 0, w: B.w, h: B.h } }, els, projectDir: dir, life, shade: false };
  const add = (id: string, src: any, seg: number) => { try { life.set(id, [0, 1]); els.set(id, buildElement(ctx, id, src)); born.set(id, seg); } catch { life.delete(id); } };
  // 角色第一次出场在哪个分区，就住在哪个分区
  const per = new Map<string, { id: string; seg: number }[]>(), seen = new Set<string>();
  b.segments.forEach((s, si) => { for (const id of s.show) if (plan.cast[id] && !seen.has(id) && s.in && regions[s.in]) { seen.add(id); per.set(s.in, [...(per.get(s.in) ?? []), { id, seg: si }]); } });
  const HEAD = 58;
  // 矮的分区（放不下“上面角色、下面字”两层）：角色靠左，字在右边
  const side = (rn: string) => !!per.get(rn)?.length && regions[rn][3] - HEAD < 300;
  const castBand = (rn: string) => (!per.get(rn)?.length ? 0 : side(rn) ? regions[rn][3] - HEAD - 10 : Math.min(200, Math.max(120, (regions[rn][3] - HEAD) * 0.46)));
  const castW = (rn: string) => (side(rn) ? Math.min(regions[rn][2] * 0.3, per.get(rn)!.length * 230) : regions[rn][2]);
  for (const [rn, ids] of per) {
    const r = regions[rn], ch = castBand(rn), cw = castW(rn), size = Math.round(Math.max(64, Math.min(150, ch * 0.62, (cw / (ids.length + 0.6)) * 0.5)));
    ids.forEach(({ id, seg }, i) => {
      const lk = plan.cast[id].look, base = lk && typeof lk === 'object' && 'crowd' in lk ? lk.of : lk;
      add(id, { ...base, size: b.hero === id ? Math.round(size * 1.25) : size, label: plan.cast[id].name + (lk?.crowd ? ` ×${lk.crowd}` : '') + (b.hero === id ? '（主角）' : ''), labelSize: 30, at: [r[0] + (cw * (i + 1)) / (ids.length + 1), r[1] + HEAD + ch * 0.44] }, seg);
    });
  }
  // 每个分区的下半边：这一区的每一段各占一两行——写什么字、画什么图
  const rows: SketchLayout['rows'] = new Map();
  const heroWord = b.hero && !plan.cast[b.hero] ? b.hero.replace(/\s/g, '') : '';
  let hero: SketchLayout['hero'];
  for (const [rn, r] of Object.entries(regions)) {
    const list: Row[] = [];
    b.segments.forEach((s, si) => { if (s.in !== rn || (!s.words.length && !s.diagram)) return; list.push({ seg: si, words: s.words, ...(s.diagram ? { diagram: s.diagram } : {}), y: 0 }); if (heroWord && !hero && s.words.some(w => w.replace(/\s/g, '') === heroWord)) hero = { seg: si, word: s.words.find(w => w.replace(/\s/g, '') === heroWord)! }; });
    if (!list.length) continue;
    const top = r[1] + HEAD + (side(rn) ? 0 : castBand(rn)) + 6, room = r[1] + r[3] - 14 - top, rx = r[0] + 26 + (side(rn) ? castW(rn) : 0);
    const lines = (l: Row[]) => l.reduce((n, x) => n + (x.words.length ? 1 : 0) + (x.diagram ? 1 : 0), 0);
    let size = Math.min(36, Math.floor(room / lines(list) / 1.32)), more = 0;
    // 字不能小到看不清：放不下就少列几段，注明“还有几段”，细节在逐段的卡片里
    while (size < 24 && list.length > 1) { list.pop(); more++; size = Math.min(36, Math.floor((room - 34) / lines(list) / 1.32)); }
    size = Math.max(22, size);
    let y = top;
    for (const row of list) { row.y = y; y += size * 1.32 * ((row.words.length ? 1 : 0) + (row.diagram ? 1 : 0)); }
    rows.set(rn, { rows: list, size, x: rx, w: r[0] + r[2] - 26 - rx, more });
  }
  // 关系的箭头：两头都出场了才画，算在连它的那一段上
  const done = new Set<string>(), rels: { id: string; label: string; from: string; to: string }[] = [];
  b.segments.forEach((s, si) => { for (const id of s.link) { const rl = plan.relations[id]; if (!rl || done.has(id) || !els.has(rl.from) || !els.has(rl.to)) continue; done.add(id); add('rel_' + id, { arrow: [rl.from, rl.to], pen: 4, color: 'blue' }, si); if (rl.label) rels.push({ id: 'rel_' + id, label: rl.label, from: rl.from, to: rl.to }); } });
  // 箭头上的小字：沿着线找一处不压板书、不压角色、不压分区标题的地方
  const obs: number[][] = [];
  for (const r of Object.values(regions)) obs.push([r[0], r[1], r[2], HEAD - 4]);
  for (const g of rows.values()) for (const row of g.rows) obs.push([g.x - 6, row.y - 4, g.w + 12, g.size * 1.32 * ((row.words.length ? 1 : 0) + (row.diagram ? 1 : 0)) + 4]);
  for (const [id, e] of els) if (!id.startsWith('rel_')) obs.push([e.box.x - 6, e.box.y - 6, e.box.w + 12, e.box.h + 12]);
  const labels: SketchLayout['labels'] = [];
  for (const rl of rels) {
    const a = els.get(rl.from)!.anchors.center, c = els.get(rl.to)!.anchors.center, size = 28, w = textWidth(rl.label, size) + 12, h = size * 1.25;
    let best = [0.5, Infinity];
    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
      const bx = a[0] + (c[0] - a[0]) * t - w / 2, by = a[1] + (c[1] - a[1]) * t - h / 2;
      const hit = [...obs, ...labels.map(l => [l.x, l.y, l.w, l.h])].reduce((n, o) => n + Math.max(0, Math.min(bx + w, o[0] + o[2]) - Math.max(bx, o[0])) * Math.max(0, Math.min(by + h, o[1] + o[3]) - Math.max(by, o[1])), 0);
      if (hit < best[1] - 1) best = [t, hit];
      if (!hit) break;
    }
    labels.push({ id: rl.id, text: rl.label, size, x: a[0] + (c[0] - a[0]) * best[0] - w / 2, y: a[1] + (c[1] - a[1]) * best[0] - h / 2, w, h });
  }
  return { B, regions, els, born, rows, labels, ...(hero ? { hero } : {}) };
}

/** 草图里用到的照片先读进来；视频用它的第一帧（poster 由调用的人给） */
export async function sketchEnv(env: Env, L: SketchLayout, poster: (file: string) => Promise<any>): Promise<Env> {
  const cache = new Map<string, any>();
  for (const e of L.els.values()) for (const s of e.strokes) {
    if (s.kind !== 'image' || cache.has(s.file)) continue;
    try { cache.set(s.file, s.clip ? await poster(s.clip.src) : await loadImage(readFileSync(s.file))); } catch { cache.set(s.file, null); }
  }
  return { ...env, image: f => cache.get(f) };
}

/**
 * 画草图。upto：只画到第几段（不写就是讲完时的全貌）；这时第 upto 段新加的东西亮着，之前的淡下去。
 * width：出图的宽度（像素）
 */
export function drawSketch(plan: Plan, b: PlanBoard, L: SketchLayout, env: Env, o: { upto?: number; width?: number } = {}): any {
  const { B, regions } = L, step = o.upto != null, upto = o.upto ?? b.segments.length - 1, cur = step ? b.segments[upto] : undefined;
  const k = (o.width ?? 900) / B.w, M = Math.round(16 * Math.max(0.5, k / 0.67));
  const cv = createCanvas(Math.round(B.w * k) + M * 2, Math.round((B.h + (step ? 0 : 52)) * k) + M * 2), x = cv.getContext('2d');
  x.fillStyle = THEME.paper; x.fillRect(0, 0, cv.width, cv.height);
  x.translate(M, M); x.scale(k, k); x.lineCap = 'round'; x.lineJoin = 'round';
  const label = (txt: string, px: number, py: number, size: number, col: string, alpha = 1, back = false) => { const t = textStrokes(txt, { size, color: col }); if (back) { x.fillStyle = 'rgba(248,245,237,0.88)'; x.fillRect(px - 4, py - 2, t.w + 8, size * 1.2); } x.save(); x.translate(px, py); drawStrokes(x, env, t.strokes, alpha); x.restore(); return t.w; };
  const dim = step ? 0.38 : 1;
  for (const [n, r] of Object.entries(regions)) {
    const active = cur?.in === n;
    if (active) { x.fillStyle = 'rgba(251,234,184,0.45)'; x.fillRect(r[0] + 5, r[1] + 5, r[2] - 10, r[3] - 10); }
    x.strokeStyle = active ? '#d9433a' : '#c9a227'; x.lineWidth = active ? 5 : 2; x.setLineDash(active ? [] : [10, 9]); x.strokeRect(r[0] + 5, r[1] + 5, r[2] - 10, r[3] - 10); x.setLineDash([]);
    const nw = label(n, r[0] + 20, r[1] + 16, 30, '#a07d00');
    const d = b.regions[n] ?? ''; if (d) label(clip(d, 26, r[2] - nw - 70), r[0] + 34 + nw, r[1] + 19, 26, THEME.colors.gray);
  }
  // 这一段把哪几个分区连起来：粗虚线从上一个分区连过来
  if (cur?.in && regions[cur.in]) for (const j of cur.joins) { const a = regions[j], c = regions[cur.in]; if (!a) continue; x.strokeStyle = 'rgba(217,67,58,0.55)'; x.lineWidth = 7; x.setLineDash([18, 14]); x.beginPath(); x.moveTo(a[0] + a[2] * 0.5, a[1] + a[3] * 0.5); x.lineTo(c[0] + c[2] * 0.5, c[1] + c[3] * 0.5); x.stroke(); x.setLineDash([]); }
  for (const [id, e] of L.els) { const at = L.born.get(id) ?? 0; if (at > upto) continue; drawStrokes(x, env, e.strokes, (!step || at === upto ? 1 : dim) * (id.startsWith('rel_') ? 0.75 : 1)); }
  for (const l of L.labels) { const at = L.born.get(l.id) ?? 0; if (at > upto) continue; x.fillStyle = 'rgba(248,245,237,0.92)'; x.fillRect(l.x, l.y, l.w, l.h); label(l.text, l.x + 6, l.y + 3, l.size, THEME.colors.blue, !step || at === upto ? 1 : dim); }
  for (const [, g] of L.rows) {
    const lh = g.size * 1.32;
    for (const row of g.rows) {
      if (row.seg > upto) continue;
      const a = !step || row.seg === upto ? 1 : dim;
      let y = row.y;
      const bw = label(badge(row.seg), g.x, y, g.size, THEME.colors.gray, a) + 10;
      if (row.words.length) {
        let px = g.x + bw;
        row.words.forEach((w, wi) => {
          const isHero = L.hero?.seg === row.seg && L.hero.word === w, sep = wi < row.words.length - 1 ? '　' : '';
          if (px + textWidth(w, g.size) > g.x + g.w) return;
          px += label(w, px, y, g.size, isHero ? THEME.colors.red : THEME.ink, a, true);
          if (isHero) px += label('（主角）', px, y + g.size * 0.2, g.size * 0.7, THEME.colors.red, a);
          px += textWidth(sep, g.size);
        });
        y += lh;
      }
      if (row.diagram) {
        const txt = clip(`图：${row.diagram}`, g.size * 0.86, g.w - bw - 16), tw = textWidth(txt, g.size * 0.86);
        x.globalAlpha = a; x.strokeStyle = THEME.colors.gray; x.lineWidth = 2; x.setLineDash([5, 7]); x.strokeRect(g.x + bw - 6, y - 2, tw + 16, g.size * 1.12); x.setLineDash([]); x.globalAlpha = 1;
        label(txt, g.x + bw + 2, y + g.size * 0.08, g.size * 0.86, THEME.colors.gray, a, true);
      }
    }
    if (g.more && !step) { const last = g.rows[g.rows.length - 1]; label(`… 这一区还有 ${g.more} 段，见下面逐段的卡片`, g.x, last.y + lh * ((last.words.length ? 1 : 0) + (last.diagram ? 1 : 0)), 24, THEME.colors.gray); }
  }
  // 这一段回头去动的东西：红圈圈出来
  if (cur) for (const id of cur.revisit) {
    const e = L.els.get(id) ?? L.els.get('rel_' + id); if (!e) continue;
    const lb = L.els.has(id) ? undefined : L.labels.find(l => l.id === 'rel_' + id), bx = lb ?? e.box;
    x.strokeStyle = THEME.colors.red; x.lineWidth = 6; x.beginPath(); x.ellipse(bx.x + bx.w / 2, bx.y + bx.h / 2, bx.w / 2 + 16, bx.h / 2 + 14, 0, 0, Math.PI * 2); x.stroke();
  }
  if (!step) { // 这是草图，不是成片：印在图上，免得被当成构图来审
    const t = '结构草图 · 只看“谁在哪一区、谁连着谁、先后顺序”，位置和大小不是成片的样子';
    label(clip(t, 28, B.w - 20), 10, B.h + 14, 28, THEME.colors.red);
  }
  return cv;
}
