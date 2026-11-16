// 口播时间表：加载、文本锚点解析、字幕切分。
// 标准输入是逐字级 alignment.json（units[].text/start/end/confidence），SRT 作为降级输入。
import { readFileSync } from 'node:fs';

export interface Unit {
  text: string;        // 不含标点
  display: string;     // 含随字标点
  start: number;
  end: number;
  confidence: number;
  shaky: boolean;      // 时间不可靠（低置信度或被标记待复核）
  sentence: number;
}
export interface Sentence { text: string; start: number; end: number; from: number; to: number }
export interface Alignment {
  units: Unit[];
  sentences: Sentence[];
  duration: number;
  precision: 'char' | 'sentence';
  /** 去标点后的全文，以及每个字符对应的 unit 下标 */
  flat: string;
  flatUnit: number[];
}

const PUNCT = /[\s，。？！、；：,.?!;:"'“”‘’（）()《》〈〉【】\[\]—…·\-]/g;
export const stripPunct = (s: string) => s.replace(PUNCT, '');

function finish(units: Unit[], sentences: Sentence[], duration: number, precision: Alignment['precision']): Alignment {
  let flat = '';
  const flatUnit: number[] = [];
  units.forEach((u, i) => {
    const t = stripPunct(u.text);
    flat += t;
    for (let k = 0; k < t.length; k++) flatUnit.push(i);
  });
  return { units, sentences, duration, precision, flat, flatUnit };
}

export function loadAlignment(file: string): Alignment {
  const raw = readFileSync(file, 'utf8');
  if (/\.srt$/i.test(file)) return fromSrt(raw);
  const j = JSON.parse(raw);
  if (!Array.isArray(j.units)) throw new Error(`${file}: 缺少 units 数组，不是受支持的时间表`);
  const units: Unit[] = j.units.map((u: any) => ({
    text: String(u.text),
    display: String(u.display_text ?? u.text),
    start: +u.start,
    end: +u.end,
    confidence: u.confidence ?? 1,
    shaky: (u.timing_warnings?.length ?? 0) > 0 || (u.confidence ?? 1) < 0.6,
    sentence: u.sentence_index ?? 0,
  }));
  let sentences: Sentence[];
  if (Array.isArray(j.sentences)) {
    sentences = j.sentences.map((s: any) => ({ text: s.text, start: +s.start, end: +s.end, from: s.unit_range[0], to: s.unit_range[1] }));
  } else {
    sentences = [];
    let from = 0;
    units.forEach((u, i) => {
      if (/[。？！?!]$/.test(u.display) || i === units.length - 1) {
        sentences.push({ text: units.slice(from, i + 1).map(x => x.display).join(''), start: units[from].start, end: u.end, from, to: i + 1 });
        from = i + 1;
      }
    });
    sentences.forEach((s, si) => { for (let i = s.from; i < s.to; i++) units[i].sentence = si; });
  }
  const duration = +(j.duration_seconds ?? units[units.length - 1]?.end ?? 0);
  return finish(units, sentences, duration, 'char');
}

/** SRT 降级：每条字幕内按字数均分时间，所有字标记为 shaky。 */
function fromSrt(raw: string): Alignment {
  const units: Unit[] = [];
  const sentences: Sentence[] = [];
  const ts = (s: string) => { const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/)!; return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
  for (const block of raw.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map(ts);
    const text = lines.slice(ti + 1).join('');
    const chars = [...text].filter(c => stripPunct(c));
    if (!chars.length) continue;
    const from = units.length;
    const step = (b - a) / chars.length;
    let ci = 0;
    const all = [...text];
    for (let i = 0; i < all.length; i++) {
      if (!stripPunct(all[i])) { if (units.length > from) units[units.length - 1].display += all[i]; continue; }
      units.push({ text: all[i], display: all[i], start: a + ci * step, end: a + (ci + 1) * step, confidence: 0.5, shaky: true, sentence: sentences.length });
      ci++;
    }
    sentences.push({ text, start: a, end: b, from, to: units.length });
  }
  return finish(units, sentences, units[units.length - 1]?.end ?? 0, 'sentence');
}

/** 从纯文本造一份匀速的假时间表：没有配音时用来先做分镜草稿。 */
export function fakeAlignment(text: string, charsPerSec = 4.5): any {
  const units: any[] = [];
  const sentences: any[] = [];
  let t = 0, from = 0, si = 0, buf = '';
  const chars = [...text.replace(/\s+/g, '')];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!stripPunct(c)) {
      if (units.length) units[units.length - 1].display_text += c;
      buf += c;
      t += /[。？！?!]/.test(c) ? 0.55 : 0.22;
      if (/[。？！?!]/.test(c) && units.length > from) {
        sentences.push({ text: buf, start: units[from].start, end: units[units.length - 1].end, unit_range: [from, units.length] });
        from = units.length; si++; buf = '';
      }
      continue;
    }
    const d = 1 / charsPerSec;
    units.push({ text: c, display_text: c, start: +t.toFixed(3), end: +(t + d).toFixed(3), confidence: 1, timing_warnings: [], sentence_index: si });
    buf += c; t += d;
  }
  if (units.length > from) sentences.push({ text: buf, start: units[from].start, end: units[units.length - 1].end, unit_range: [from, units.length] });
  return { provider: 'fake', timing_status: 'fake_uniform', duration_seconds: +(t + 0.5).toFixed(3), units, sentences };
}

export interface Resolved { time: number; unit: number; shaky: boolean; /** 未用 #n 指明时，范围内还有几处同样的文字 */ ambiguous: number }

/**
 * 锚点语法： "口播原文片段[#第几次出现][@end][±秒数]"
 *   "收走一百块税"       → 这几个字开口的那一刻
 *   "一百块#2"           → 范围内第 2 次出现
 *   "一分没有@end"       → 说完这几个字的那一刻
 *   "发给你-0.3"         → 提前 0.3 秒
 * 数字（秒）也接受，但换配音后不会自动跟随，仅作兜底。
 */
export function resolveAnchor(al: Alignment, anchor: string | number, span?: [number, number]): Resolved {
  if (typeof anchor === 'number') return { time: anchor, unit: -1, shaky: false, ambiguous: 0 };
  let s = String(anchor).trim();
  let offset = 0, atEnd = false, nth = 1;
  let m = s.match(/([+-]\d+(?:\.\d+)?)$/);
  if (m) { offset = parseFloat(m[1]); s = s.slice(0, -m[1].length); }
  if (s.endsWith('@end')) { atEnd = true; s = s.slice(0, -4); }
  m = s.match(/#(\d+)$/);
  if (m) { nth = +m[1]; s = s.slice(0, -m[0].length); }
  const needle = stripPunct(s);
  if (!needle) throw new Error(`锚点 "${anchor}" 里没有可匹配的文字`);
  const hits: number[] = [];
  for (let i = al.flat.indexOf(needle); i >= 0; i = al.flat.indexOf(needle, i + 1)) {
    const t = al.units[al.flatUnit[i]].start;
    if (!span || (t >= span[0] - 1e-6 && t < span[1] - 1e-6)) hits.push(i);
  }
  if (!hits.length) {
    const any = al.flat.includes(needle);
    throw new Error(`锚点 "${anchor}" ${any ? '在本场景的口播范围内找不到（它出现在别的场景里）' : '在口播稿里找不到，请逐字核对原文'}`);
  }
  if (nth > hits.length) throw new Error(`锚点 "${anchor}" 要第 ${nth} 次出现，但范围内只出现了 ${hits.length} 次`);
  const explicit = /#\d+(@end)?([+-][\d.]+)?$/.test(String(anchor).trim());
  const fi = hits[nth - 1];
  const ui = atEnd ? al.flatUnit[fi + needle.length - 1] : al.flatUnit[fi];
  const u = al.units[ui];
  return { time: Math.max(0, (atEnd ? u.end : u.start) + offset), unit: ui, shaky: u.shaky, ambiguous: explicit ? 0 : hits.length - 1 };
}

export interface SubLine { text: string; start: number; end: number }

/** 断句的标点：字后面挂着的标点里有一个就能断（“吸”，“”这种引号夹着逗号的也算）；”“ 两个引号挨着也算 */
const BREAK = /[，。？！、；：?!;:]|,(?!\d)|”\s*“/;
/** 一个字后面不该断开的字：结构助词、语气词 */
const CLING = /^[的了着过地得吗呢吧啊么]/;
const OPENERS = /[“‘（(《「『【]+$/;

/** 把口播切成字幕行：按标点断句，过长再拆，过短并入相邻行。
 *  过长的拆法：在接近均分的位置里挑一个好断的地方——不切在引号里面、不切在“的了着”前面，能落在标点后就落在标点后 */
export function buildSubtitles(al: Alignment, maxChars: number): SubLine[] {
  const lines: { from: number; to: number }[] = [];
  const L = (a: number, b: number) => { let n = 0; for (let i = a; i < b; i++) n += al.units[i].text.length; return n; };
  // 每个字之后还在几层引号 / 括号里
  const depth: number[] = [];
  { let d = 0; for (const u of al.units) { for (const ch of u.display) { if ('“‘（(《「『【'.includes(ch)) d++; else if ('”’）)》」』】'.includes(ch)) d = Math.max(0, d - 1); } depth.push(d); } }
  const splitLong = (from: number, to: number): { from: number; to: number }[] => {
    const n0 = Math.ceil(L(from, to) / maxChars), a = splitInto(from, to, n0);
    // 均分的几个位置都不好断（只能切在引号里、“的”前面），就多切一行
    if (!a.bad) return a.out;
    const b = splitInto(from, to, n0 + 1);
    return b.bad ? a.out : b.out;
  };
  const splitInto = (from: number, to: number, n: number): { out: { from: number; to: number }[]; bad: boolean } => {
    const total = L(from, to), out: { from: number; to: number }[] = [];
    let start = from, bad = false;
    for (let k = 1; k < n; k++) {
      const target = (total * k) / n;
      let best = -1, bestCost = Infinity;
      for (let i = start + 1; i < to; i++) { // 切在第 i 个字之前
        const head = L(start, i);
        if (head > maxChars) break;
        if (L(i, to) > maxChars * (n - k)) continue;
        const prev = al.units[i - 1];
        let cost = Math.abs(L(from, i) - target);
        if (depth[i - 1] > 0) cost += 6;                      // 切在引号里面
        if (CLING.test(al.units[i].text)) cost += 5;           // 切在“的了着”前面
        if (/\p{P}/u.test(prev.display) && depth[i - 1] === 0) cost -= 3; // 落在标点后面
        if (cost < bestCost) { bestCost = cost; best = i; }
      }
      if (best < 0) best = Math.min(to - 1, start + Math.ceil((to - start) / (n - k + 1)));
      if (depth[best - 1] > 0 || CLING.test(al.units[best].text)) bad = true;
      out.push({ from: start, to: best }); start = best;
    }
    out.push({ from: start, to });
    return { out, bad };
  };
  for (const s of al.sentences) {
    let segs: { from: number; to: number }[] = [];
    let from = s.from;
    for (let i = s.from; i < s.to; i++) {
      if (BREAK.test(al.units[i].display) || i === s.to - 1) { segs.push({ from, to: i + 1 }); from = i + 1; }
    }
    const len = (g: { from: number; to: number }) => L(g.from, g.to);
    // 合并过短片段
    const merged: typeof segs = [];
    for (const g of segs) {
      const last = merged[merged.length - 1];
      if (last && len(last) + len(g) <= maxChars && (len(g) < 5 || len(last) < 5)) last.to = g.to; else merged.push({ ...g });
    }
    // 拆分过长片段
    for (const g of merged) { if (len(g) <= maxChars) lines.push(g); else lines.push(...splitLong(g.from, g.to)); }
  }
  // 开引号挂在上一行的末尾（标点跟着前一个字走）：挪到下一行的开头
  const texts = lines.map(g => al.units.slice(g.from, g.to).map(u => u.display).join(''));
  for (let i = 0; i < texts.length - 1; i++) { const m = texts[i].match(OPENERS); if (m) { texts[i] = texts[i].slice(0, -m[0].length); texts[i + 1] = m[0] + texts[i + 1]; } }
  return lines.map((g, i) => {
    const us = al.units.slice(g.from, g.to);
    const next = lines[i + 1] ? al.units[lines[i + 1].from].start : Infinity;
    const text = texts[i].replace(/[，。、；：,;:]+$/g, '').replace(/[，、；：]/g, ' ').replace(/\s+$/, '');
    return { text, start: us[0].start, end: Math.min(us[us.length - 1].end + 0.35, next) };
  });
}
