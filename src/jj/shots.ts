// 镜头骨架：按句子和停顿把口播切成 1.2–4 秒的镜头；把镜头的锚点解析成时间；检查镜头单和台账。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAnchor, stripPunct, type Alignment } from '../core/alignment';
import { type Shot, type Asset, type Project, SHOT_KEYS, CUTS, LICENSES, tierOf, sealOf, mediaFor } from './project';

export const MIN_DUR = 1.2, MAX_DUR = 4, TARGET_DUR = 2.8;
/** 评论性引用的上限：每条片子的个数、单个镜头的时长 */
export const QUOTE_MAX = 12, QUOTE_SHOT_MAX = 4.5;
/** 素材比镜头短：放慢不低于 0.8 倍，再不够就定格推近；够不到一半报错 */
export const MIN_SPEED = 0.8, MIN_COVER = 0.5;

export interface Issue { level: 'error' | 'warn'; where: string; msg: string }
export interface Timed extends Shot { t0: number; t1: number; u0: number; u1: number; sayNow: string }

const CLING = /^[的了着过地得吗呢吧啊么]/;

/** 第 i 个字开口之前的切点：落在上一个字说完和这个字开口之间，离开口 0.1 秒 */
function cutTime(al: Alignment, i: number): number {
  if (i <= 0) return 0;
  const prev = al.units[i - 1].end, next = al.units[i].start;
  return Math.max(prev, next - 0.1);
}
function boundaryCost(al: Alignment, i: number): number {
  const prev = al.units[i - 1], cur = al.units[i];
  const gap = cur.start - prev.end;
  let c = /[。？！?!]/.test(prev.display) ? 0 : /[，；：、,;:—…]/.test(prev.display) ? 1 : gap >= 0.3 ? 1.5 : 7;
  if (CLING.test(cur.text)) c += 3;
  return c;
}

/** 从这个字开始、在全文里唯一的一段原文，作为锚点 */
export function anchorAt(al: Alignment, ui: number): string {
  const fi = al.flatUnit.indexOf(ui);
  if (fi < 0) return al.units[ui].text;
  for (let len = 3; len <= 12 && fi + len <= al.flat.length; len++) {
    const s = al.flat.slice(fi, fi + len);
    if (al.flat.indexOf(s) === fi && al.flat.indexOf(s, fi + 1) < 0) return s;
  }
  const s = al.flat.slice(fi, fi + 4);
  let n = 0;
  for (let i = al.flat.indexOf(s); i >= 0 && i <= fi; i = al.flat.indexOf(s, i + 1)) n++;
  return `${s}#${n}`;
}

/** 切镜头骨架：动态规划，切点尽量落在句号、逗号、停顿上，时长尽量接近 2.8 秒 */
export function scaffoldShots(al: Alignment, duration: number): Shot[] {
  const n = al.units.length;
  const T = (i: number) => (i >= n ? duration : cutTime(al, i));
  // best[i]：前 i 个字切好的最小代价（i 是下一个镜头开头的字）
  const best = new Array(n + 1).fill(Infinity), prev = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    const bc = j >= n ? 0 : boundaryCost(al, j);
    for (let i = j - 1; i >= 0; i--) {
      if (best[i] === Infinity) continue;
      const d = T(j) - T(i);
      if (d > MAX_DUR * 2.5) break;
      let c = d < MIN_DUR ? 40 + (MIN_DUR - d) * 40 : d > MAX_DUR ? 40 + (d - MAX_DUR) * 40 : 0.6 * (d - TARGET_DUR) ** 2;
      c += bc * 2;
      if (best[i] + c < best[j]) { best[j] = best[i] + c; prev[j] = i; }
    }
  }
  const starts: number[] = [];
  for (let j = n; j > 0; j = prev[j]) starts.unshift(prev[j]);
  return starts.map((u0, k) => {
    const u1 = k + 1 < starts.length ? starts[k + 1] : n;
    return { id: `s${String(k + 1).padStart(2, '0')}`, at: anchorAt(al, u0), say: al.units.slice(u0, u1).map(u => u.display).join(''), dur: +(T(u1) - T(u0)).toFixed(2) };
  });
}

/** 把镜头的锚点解析成时间。解析不了的镜头放进 issues，不进时间线 */
export function timeShots(p: Project, shots: Shot[], issues: Issue[] = []): Timed[] {
  const al = p.al!;
  const starts: { s: Shot; u: number }[] = [];
  shots.forEach((s, k) => {
    if (k === 0) { starts.push({ s, u: 0 }); return; }
    try {
      const r = resolveAnchor(al, s.at);
      if (r.ambiguous) issues.push({ level: 'error', where: s.id, msg: `at "${s.at}" 在口播里出现了 ${r.ambiguous + 1} 次，写成 "${s.at}#2" 这样指明第几次` });
      starts.push({ s, u: r.unit });
    } catch (e: any) { issues.push({ level: 'error', where: s.id, msg: e.message }); }
  });
  const out: Timed[] = [];
  for (let k = 0; k < starts.length; k++) {
    const { s, u } = starts[k];
    const u1 = k + 1 < starts.length ? starts[k + 1].u : al.units.length;
    if (u1 <= u) { issues.push({ level: 'error', where: s.id, msg: `at "${s.at}" 不在上一个镜头之后：镜头要按口播顺序排，at 一个比一个靠后` }); continue; }
    const t0 = k === 0 ? 0 : cutTime(al, u), t1 = u1 >= al.units.length ? p.duration : cutTime(al, u1);
    out.push({ ...s, t0, t1, u0: u, u1, sayNow: al.units.slice(u, u1).map(x => x.display).join('') });
  }
  return out;
}

/** 镜头里用到的视频时长、放慢多少 */
export function videoPlan(a: Asset, from: number, dur: number): { speed: number; freeze: number; cover: number } {
  const avail = Math.max(0, (a.duration ?? 0) - from);
  if (avail >= dur) return { speed: 1, freeze: 0, cover: 1 };
  if (avail >= dur * MIN_SPEED) return { speed: avail / dur, freeze: 0, cover: avail / dur };
  return { speed: MIN_SPEED, freeze: dur - avail / MIN_SPEED, cover: avail / dur };
}

export function checkProject(p: Project, shots: Shot[], assets: Record<string, Asset>): { issues: Issue[]; timed: Timed[] } {
  const issues: Issue[] = [];
  const err = (where: string, msg: string) => issues.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => issues.push({ level: 'warn', where, msg });
  if (!p.al) { err('voice', '还没有配音和逐字时间表（voice/alignment.json）。先配音：hj voice <目录> --engine edge'); return { issues, timed: [] }; }
  if (!p.audio) warn('voice', '找不到配音文件（voice/narration.wav），渲染出来没有声音');
  // 台账
  for (const [id, a] of Object.entries(assets)) {
    const where = `assets.yaml / ${id}`;
    if (!a?.source) { err(where, '缺 source：素材只能用 jj grab / jj snap 入库，不能手写'); continue; }
    if (sealOf(a.source) !== a.seal) err(where, 'source 和抓取时记下的不一样了（签对不上）。来源、作者、许可证是 jj grab 自动记的，不能手改；记错了就重新 jj grab');
    if (!existsSync(join(p.dir, a.file))) err(where, `素材文件不见了：${a.file}`);
    if (!LICENSES[a.source.license]) err(where, `不认识的许可证 "${a.source.license}"`);
    if (a.purpose && !['quote', 'licensed'].includes(a.purpose)) err(where, 'purpose 只能是 quote（评论性引用）或 licensed（用户有授权）');
  }
  if (!shots.length) { err('shots.yaml', '还没有镜头单。运行 jj scaffold <目录> 生成骨架'); return { issues, timed: [] }; }
  const ids = new Set<string>();
  shots.forEach((s, k) => {
    const where = s.id || `第 ${k + 1} 个镜头`;
    for (const key of Object.keys(s)) if (!SHOT_KEYS.includes(key)) err(where, `不认识字段 "${key}"。可用：${SHOT_KEYS.join(' ')}`);
    if (!s.id) err(where, '缺 id');
    if (ids.has(s.id)) err(where, `id 重复了：${s.id}`);
    ids.add(s.id);
    if (!s.at && k) err(where, '缺 at（这个镜头从口播的哪几个字开始）');
  });
  const timed = timeShots(p, shots, issues);
  let quotes = 0;
  const usedAt = new Map<string, Timed[]>();
  timed.forEach((s, k) => {
    const where = s.id, d = s.t1 - s.t0;
    if (d > MAX_DUR + 0.5) err(where, `镜头 ${d.toFixed(1)} 秒，太长（上限 ${MAX_DUR} 秒）：在中间加一个镜头（复制一行，at 写成后半句开头的几个字），再 jj sync`);
    else if (d > MAX_DUR) warn(where, `镜头 ${d.toFixed(1)} 秒，略长（建议不超过 ${MAX_DUR} 秒）`);
    if (d < MIN_DUR - 0.3 && k < timed.length - 1) err(where, `镜头只有 ${d.toFixed(1)} 秒，太短（下限 ${MIN_DUR} 秒）：和相邻镜头合并（删掉这一行或下一行），再 jj sync`);
    if (s.say != null && stripPunct(s.say) !== stripPunct(s.sayNow)) warn(where, `say 和口播对不上了（at 改过？）。运行 jj sync 重算 say 和 dur`);
    else if (s.dur != null && Math.abs(s.dur - d) > 0.05) warn(where, `dur 写的是 ${s.dur}，实际是 ${d.toFixed(2)}。运行 jj sync`);
    if (s.cut && !CUTS.includes(s.cut)) err(where, `cut 只能是 ${CUTS.join(' | ')}`);
    if (s.fit && !['fill', 'frame'].includes(s.fit)) err(where, 'fit 只能是 fill（裁满竖屏）或 frame（整幅放中间，上下模糊垫底）');
    if (s.focus != null && !(typeof s.focus === 'number' ? s.focus >= 0 && s.focus <= 1 : ['left', 'center', 'right', 'top', 'bottom'].includes(String(s.focus)))) err(where, 'focus 写 left | center | right | top | bottom，或 0 到 1 之间的数');
    if (s.crop != null && !(Array.isArray(s.crop) && s.crop.length === 4 && s.crop.every(v => typeof v === 'number' && v >= 0 && v <= 1) && s.crop[0] + s.crop[2] <= 1.001 && s.crop[1] + s.crop[3] <= 1.001 && s.crop[2] > 0.05 && s.crop[3] > 0.05)) err(where, 'crop 写成 [左, 上, 宽, 高]，都是 0 到 1 的比例，比如 [0, 0, 1, 0.8] 去掉下面五分之一');
    if (s.pop && !stripPunct(s.sayNow).includes(stripPunct(s.pop))) err(where, `pop "${s.pop}" 不是这一镜里说的话。弹字要用口播原文：${s.sayNow}`);
    if (!s.use) { err(where, `还没有选画面${s.want ? `（want：${s.want}）` : '：先写 want，再去找'}。实在找不到，写 use: title 用金句卡`); return; }
    if (s.use === 'title') { if (s.from != null) warn(where, '金句卡不需要 from'); return; }
    const a = assets[s.use];
    if (!a) { err(where, `use: ${s.use} 不在素材台账里。素材要先 jj grab 入库；可用：${Object.keys(assets).join(' ') || '（台账是空的）'}`); return; }
    if (a.rejected) err(where, `${s.use} 已经被否掉了（${a.rejected}）。换一个，或者先把 rejected 删掉`);
    const lic = LICENSES[a.source?.license], tier = a.source ? tierOf(a) : 'red';
    if (tier === 'banned') err(where, `${s.use} 的许可证是 ${lic?.name}，不能用在这条片子里（剪裁、加字都算演绎；自媒体算商用）。换一个素材`);
    if (tier === 'red' && !(a.purpose && a.why)) err(where, `${s.use} ${lic?.name ?? '授权不明'}（${a.source?.site ?? a.source?.url}）。要用它，在台账里写 purpose: quote 和 why（为什么是评论性引用：评论的是什么）：jj note ${p.dir} ${s.use} --purpose quote --why "…"；否则换一个授权清楚的素材`);
    if (tier === 'yellow' && !a.purpose) warn(where, `${s.use} 是官方网站的公开信息，写一下用途：jj note ${p.dir} ${s.use} --purpose quote --why "…"`);
    if (a.purpose === 'quote') { quotes++; if (d > QUOTE_SHOT_MAX) warn(where, `评论性引用的镜头 ${d.toFixed(1)} 秒，超过 ${QUOTE_SHOT_MAX} 秒：引用越短越稳妥`); }
    if (a.kind === 'video') {
      const from = s.from ?? 0;
      if (s.from == null) warn(where, `${s.use} 是视频，没写 from（从第几秒开始），默认从 0 秒。jj look / jj hear 找到要的那一段再写`);
      if (from >= (a.duration ?? 0)) err(where, `from: ${from} 超出了素材长度（${(a.duration ?? 0).toFixed(1)} 秒）`);
      else {
        const vp = videoPlan(a, from, d);
        if (vp.cover < MIN_COVER) err(where, `素材从 ${from} 秒起只剩 ${((a.duration ?? 0) - from).toFixed(1)} 秒，镜头要 ${d.toFixed(1)} 秒，差太多。把 from 往前挪到 ${Math.max(0, (a.duration ?? 0) - d).toFixed(1)} 以内，或者换素材、把镜头拆短`);
        else if (vp.freeze > 0) warn(where, `素材从 ${from} 秒起只剩 ${((a.duration ?? 0) - from).toFixed(1)} 秒：放慢到 0.8 倍后，最后 ${vp.freeze.toFixed(1)} 秒定格推近`);
        const m = mediaFor(p.dir, a, from, d);
        if (!m.hd && a.hd !== undefined) warn(where, `${s.use} 这一段还没有高清版：jj grab ${p.dir} --hd ${s.use}`);
      }
    }
    if (a.kind !== 'video' && s.from != null) warn(where, `${s.use} 是图片，from 不起作用`);
    const list = usedAt.get(s.use) ?? []; list.push(s); usedAt.set(s.use, list);
    if (s.meme) {
      const m = assets[s.meme.use];
      if (!m) err(where, `meme.use: ${s.meme.use} 不在台账里`);
      else if (tierOf(m) === 'red' && !(m.purpose && m.why)) err(where, `表情包 ${s.meme.use} 授权不明：写 purpose: quote 和 why，或换一个`);
      if (s.meme.at && !stripPunct(s.sayNow).includes(stripPunct(String(s.meme.at).replace(/@end$/, '')))) err(where, `meme.at "${s.meme.at}" 不是这一镜里说的话`);
    }
  });
  if (quotes > QUOTE_MAX) warn('全片', `评论性引用用了 ${quotes} 处，超过 ${QUOTE_MAX} 处。换一些授权清楚的素材，或者在故事板上请用户拍板`);
  // 同一个素材用在相邻镜头、或者同一段视频用了两次
  for (const [id, list] of usedAt) {
    for (let i = 1; i < list.length; i++) {
      const a = assets[id], x = list[i - 1], y = list[i];
      if (a.kind !== 'video') { if (timed.indexOf(y) === timed.indexOf(x) + 1) warn(y.id, `和 ${x.id} 用的是同一张图 ${id}，观众会以为画面卡住了`); }
      else { const x0 = x.from ?? 0, y0 = y.from ?? 0, x1 = x0 + (x.t1 - x.t0), y1 = y0 + (y.t1 - y.t0); if (Math.min(x1, y1) - Math.max(x0, y0) > 0.3) warn(y.id, `和 ${x.id} 用的是 ${id} 的同一段（${x0}s 和 ${y0}s）`); }
    }
  }
  const missing = timed.filter(s => !s.use).length;
  if (missing === 0 && timed.length) {
    const titles = timed.filter(s => s.use === 'title').length;
    if (titles / timed.length > 0.3) warn('全片', `${titles} / ${timed.length} 个镜头是金句卡，太多了：素材剪辑的片子，金句卡只用在最该停一下的地方`);
  }
  return { issues, timed };
}

export function printIssues(issues: Issue[]) {
  const e = issues.filter(i => i.level === 'error'), w = issues.filter(i => i.level === 'warn');
  for (const i of e) console.log(`✗ ${i.where}：${i.msg}`);
  for (const i of w) console.log(`! ${i.where}：${i.msg}`);
  console.log(e.length || w.length ? `\n${e.length} 个错误，${w.length} 个警告` : '✓ 没有问题');
}
