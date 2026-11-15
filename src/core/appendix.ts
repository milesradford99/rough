// 附录：口播讲完之后，镜头顺着同一张纸往下走，滚过一份补充材料（完整时间线、数据出处、名词表）。
// 内容写在项目的 appendix.yaml 里，只写字，不写坐标和字号；版面、字体、纸面都由引擎排，和正片是同一套笔画。
// 它排在最后一块板的正下方（同一个世界坐标系），所以“滚动”只是镜头往下平移：纸纹、手写字、线条和正片完全一致。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { R, type Stroke, translateStrokes } from './strokes';
import { textStrokes, textWidth } from './text';
import { THEME, color, type Format } from './theme';

export interface AppendixItem { when?: string; tag?: string; color?: string; title: string; text?: string }
export interface AppendixSection { title: string; note?: string; items: AppendixItem[] }
export interface Appendix { sections: AppendixSection[]; /** 每秒滚过多少像素 */ speed: number; /** 滚到底之后停几秒 */ hold: number }
export interface AppendixIssue { level: 'error' | 'warn'; where: string; msg: string }
/** 排好版的附录：一行一组笔画，带上下范围（渲染时只画镜头里的） */
export interface AppendixLayout { rows: { y0: number; y1: number; strokes: Stroke[] }[]; width: number; height: number; missing: string[] }

const FILE = 'appendix.yaml';
const SECTION_KEYS = ['title', 'note', 'items'], ITEM_KEYS = ['when', 'tag', 'color', 'title', 'text'], TOP_KEYS = ['sections', 'speed', 'seconds', 'hold', ...SECTION_KEYS];
export const APPENDIX_SPEED = 170;
const COLORS = ['blue', 'red', 'gray', 'green', 'orange', 'purple', 'ink'];

export function loadAppendix(dir: string): { appendix: Appendix | null; issues: AppendixIssue[]; seconds?: number } {
  const f = join(dir, FILE), issues: AppendixIssue[] = [];
  if (!existsSync(f)) return { appendix: null, issues };
  const err = (where: string, msg: string) => issues.push({ level: 'error', where, msg }), warn = (where: string, msg: string) => issues.push({ level: 'warn', where, msg });
  let raw: any;
  try { raw = YAML.parse(readFileSync(f, 'utf8'), { prettyErrors: true }); } catch (e: any) { err(FILE, `YAML 写错了：${e.message}`); return { appendix: null, issues }; }
  if (raw == null) return { appendix: null, issues }; // 空文件：没有附录
  if (typeof raw !== 'object' || Array.isArray(raw)) { err(FILE, '最外层要写成 { title, items: [...] }，或者分几节 { sections: [{ title, items }, …] }'); return { appendix: null, issues }; }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) err(FILE, `不认识字段 "${k}"。可用：${TOP_KEYS.join(' ')}。附录只写内容，版面由引擎排`);
  const rawSections: any[] = Array.isArray(raw.sections) ? raw.sections : [raw];
  const sections: AppendixSection[] = [];
  rawSections.forEach((s, si) => {
    const where = `${FILE} / 第 ${si + 1} 节`;
    if (!s || typeof s !== 'object') { err(where, '每一节写成 { title, items: [...] }'); return; }
    if (Array.isArray(raw.sections)) for (const k of Object.keys(s)) if (!SECTION_KEYS.includes(k)) err(where, `不认识字段 "${k}"。可用：${SECTION_KEYS.join(' ')}`);
    if (!s.title) err(where, '缺 title（这一节的标题，如“1993–2026 关键事件”）');
    if (!Array.isArray(s.items) || !s.items.length) { err(where, '缺 items（一条一条的内容）'); return; }
    const items: AppendixItem[] = [];
    s.items.forEach((it: any, ii: number) => {
      const w = `${where} / 第 ${ii + 1} 条`;
      if (typeof it === 'string') { items.push({ title: it }); return; }
      if (!it || typeof it !== 'object') { err(w, '每一条写成 { when: "1993.04", tag: "33.3%", title: 一句话, text: 一两句说明 }；when、tag、text 可以不写'); return; }
      for (const k of Object.keys(it)) if (!ITEM_KEYS.includes(k)) err(w, `不认识字段 "${k}"。可用：${ITEM_KEYS.join(' ')}`);
      if (!it.title) err(w, '缺 title');
      if (it.color != null && !COLORS.includes(String(it.color))) err(w, `color 只能是 ${COLORS.join(' / ')}（默认 blue；gray 用于次要的一条，red 用于转折）`);
      const text = it.text != null ? String(it.text).replace(/\s*\n\s*/g, '') : undefined;
      if (text && [...text].length > 110) warn(w, `说明有 ${[...text].length} 个字，滚动时读不完。压到 110 字以内，或者拆成两条`);
      if ([...String(it.title ?? '')].length > 32) warn(w, `标题有 ${[...String(it.title)].length} 个字，会折成好几行。标题写一句短的，细节放进 text`);
      items.push({ ...(it.when != null ? { when: String(it.when) } : {}), ...(it.tag != null ? { tag: String(it.tag) } : {}), ...(it.color != null ? { color: String(it.color) } : {}), title: String(it.title ?? ''), ...(text ? { text } : {}) });
    });
    sections.push({ title: String(s.title ?? ''), ...(s.note != null ? { note: String(s.note).replace(/\s*\n\s*/g, '') } : {}), items });
  });
  if (!sections.length) return { appendix: null, issues };
  const speed = raw.speed != null ? +raw.speed : APPENDIX_SPEED;
  if (!(speed >= 60 && speed <= 600)) err(FILE, 'speed 是每秒滚过多少像素，写 60 到 600 之间的数（默认 170）；也可以改写 seconds: 总共滚多少秒');
  const seconds = raw.seconds != null ? +raw.seconds : undefined;
  if (seconds != null && !(seconds >= 3 && seconds <= 180)) err(FILE, 'seconds 是附录总共滚多少秒，写 3 到 180 之间的数');
  return { appendix: { sections, speed: speed >= 60 && speed <= 600 ? speed : APPENDIX_SPEED, hold: raw.hold != null ? Math.max(0, +raw.hold || 0) : 1.5 }, issues, ...(seconds != null ? { seconds } : {}) };
}

const NO_START = /[，。、；：？！）》」』”’％%,.;:!?)\]]/, NO_END = /[（《「『“‘(\[]/;
/** 按宽度折行：西文单词和数字不拆开，标点不落在行首 */
export function wrapText(text: string, size: number, maxW: number): string[] {
  const tokens = String(text).match(/[A-Za-z0-9$€¥~.,%/+\-:'’]+|\s+|[\s\S]/gu) ?? [];
  const lines: string[] = [];
  let cur = '';
  for (const tk of tokens) {
    if (cur === '' && /^\s+$/.test(tk)) continue;
    if (cur !== '' && textWidth(cur + tk, size) > maxW && !NO_START.test(tk[0])) {
      // 行尾不留开括号、开引号：带到下一行
      let carry = ''; while (cur.length > 1 && NO_END.test(cur[cur.length - 1])) { carry = cur[cur.length - 1] + carry; cur = cur.slice(0, -1); }
      lines.push(cur.trimEnd()); cur = carry + (/^\s+$/.test(tk) ? '' : tk);
    }
    else cur += tk;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/** 排版。坐标以附录左上角为原点，宽度是整屏宽 */
export function layoutAppendix(ap: Appendix, fmt: Format): AppendixLayout {
  const W = fmt.W, portrait = fmt.name === 'portrait';
  const contentW = Math.min(W - (portrait ? 150 : 360), 1500), left = (W - contentW) / 2;
  const S = portrait ? { head: 62, note: 36, when: 46, tag: 36, title: 48, text: 37 } : { head: 56, note: 32, when: 40, tag: 32, title: 42, text: 33 };
  const col = portrait ? 205 : 250; // 时间那一栏的宽度
  const rows: AppendixLayout['rows'] = [], missing: string[] = [];
  let y = 0, seed = 7;
  const put = (text: string, size: number, col_: string, x: number, yy: number): number => {
    const t = textStrokes(text, { size, color: col_, align: 'left' });
    translateStrokes(t.strokes, x, yy); missing.push(...t.missing);
    rows.push({ y0: yy, y1: yy + t.h, strokes: t.strokes });
    return t.h;
  };
  const para = (text: string, size: number, col_: string, x: number, maxW: number, gap = 0.36, yy = y): number => {
    let h = 0;
    for (const line of wrapText(text, size, maxW)) { put(line, size, col_, x, yy + h); h += size * (1 + gap); }
    return h - size * gap;
  };
  const st = (c: string, w: number) => ({ color: c, w, rough: 0.7, seed: seed++ });
  ap.sections.forEach((sec, si) => {
    if (si) y += 90;
    // 节标题：蓝色大字，下面一道手绘的线
    y += para(sec.title, S.head, THEME.colors.blue, left, contentW, 0.25) + 14;
    rows.push({ y0: y, y1: y + 8, strokes: R.line(left, y, left + Math.min(contentW, 420), y + 2, st(THEME.colors.blue, 4)) });
    y += 30;
    if (sec.note) y += para(sec.note, S.note, THEME.colors.gray, left, contentW) + 26;
    y += 18;
    const timeline = sec.items.some(it => it.when), spineX = left + 12, x1 = left + 40, x2 = timeline ? x1 + col : x1;
    const spineTop = y + S.title * 0.5;
    let lastDot = spineTop;
    for (const it of sec.items) {
      const c = color(it.color ?? 'blue'), top = y, dotY = top + S.title * 0.5;
      rows.push({ y0: dotY - 14, y1: dotY + 14, strokes: R.ellipse(spineX, dotY, 20, 20, { ...st(c, 3), fill: c, fillStyle: 'solid' }) });
      lastDot = dotY;
      let hl = 0;
      if (timeline && it.when) { hl = put(it.when, S.when, c, x1, top + (S.title - S.when) * 0.6) + 10; if (it.tag) hl += put(it.tag, S.tag, c, x1, top + hl) + 6; }
      let hr = para(it.title, S.title, THEME.ink, x2, left + contentW - x2, 0.28);
      if (it.text) hr += 16 + para(it.text, S.text, '#4b463f', x2, left + contentW - x2, 0.36, top + hr + 16);
      if (!timeline && it.tag) hr += 8 + put(it.tag, S.tag, c, x2, top + hr + 8);
      y = top + Math.max(hl, hr) + (portrait ? 62 : 50);
    }
    // 时间线的竖线：从第一个点连到这一节的末尾，画在点的下面
    rows.unshift({ y0: spineTop, y1: y - 30, strokes: R.line(spineX, spineTop, spineX + 1, Math.max(lastDot, y - 40), st('#c9c3b6', 3)) });
  });
  return { rows, width: W, height: y, missing: [...new Set(missing)] };
}

/** 镜头从最后一块板的全景往下走的路程和时间：先加速、匀速滚、到底减速，再停一会儿 */
export function appendixTiming(dist: number, speed: number, hold: number): { ramp: number; scroll: number; total: number } {
  const ramp = Math.min(0.9, dist / speed); // 起步、收尾各用这么久，从零加到匀速
  const scroll = dist / speed + ramp;       // 梯形速度曲线：总路程 = speed × (scroll − ramp)
  return { ramp, scroll, total: scroll + hold };
}
/** 滚了多远（0 到 dist） */
export function appendixOffset(u: number, dist: number, speed: number): number {
  const { ramp, scroll } = appendixTiming(dist, speed, 0);
  if (u <= 0) return 0;
  if (u >= scroll) return dist;
  if (u < ramp) return (speed * u * u) / (2 * ramp);
  if (u > scroll - ramp) { const r = scroll - u; return dist - (speed * r * r) / (2 * ramp); }
  return speed * (u - ramp / 2);
}
