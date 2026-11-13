// 质量检查：把“没人味、像 PPT、抄字幕、不同步”这些毛病在渲染前拦下来。
import type { Compiled, Issue, TL } from './compile';
import { stripPunct } from './alignment';
import type { Box, Pt } from './strokes';
import type { El } from './elements';

/** 沿元素的线条每隔约 10px 取一个点（只取线，不取字形和填充） */
function linePoints(el: El, pathOnly = false): Pt[] {
  const out: Pt[] = [];
  const walk = (p: number[]) => { for (let i = 2; i < p.length; i += 2) { const n = Math.max(1, Math.ceil(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / 10)); for (let k = 0; k < n; k++) out.push([p[i - 2] + ((p[i] - p[i - 2]) * k) / n, p[i - 1] + ((p[i + 1] - p[i - 1]) * k) / n]); } };
  if (pathOnly) { if (el.path) walk(el.path); return out; }
  for (const st of el.strokes) if (st.kind === 'line' && !st.under) walk(st.pts);
  return out;
}
const countIn = (pts: Pt[], b: Box, shrink: number) => pts.filter(q => q[0] > b.x + shrink && q[0] < b.x + b.w - shrink && q[1] > b.y + shrink && q[1] < b.y + b.h - shrink).length;
const contains = (a: Box, b: Box, m = 2) => a.x <= b.x + m && a.y <= b.y + m && a.x + a.w >= b.x + b.w - m && a.y + a.h >= b.y + b.h - m;
const POS = new Set(['__rigid', '__seed', 'id', 'at', 'dx', 'dy', 'anchor', 'rightOf', 'leftOf', 'above', 'below', 'gap', 'align', 'near', 'overlap']);
const NAMES = (ids: string[]) => ids.map(i => `"${i}"`).join('、');

function longestCommon(a: string, b: string): number {
  let best = 0; const prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { for (let j = 1; j <= b.length; j++) { cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0; if (cur[j] > best) best = cur[j]; } prev.set(cur); }
  return best;
}
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const WINDOW = 11;
const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

export function lint(c: Compiled): Issue[] {
  const out: Issue[] = [...c.issues];
  const add = (level: Issue['level'], where: string, msg: string) => out.push({ level, where, msg });
  let figures = 0, draws = 0, appears = 0;

  for (const sc of c.scenes) {
    const B = sc.board ?? c.fmt.board; // 这块板自己的画板（可能比屏幕大）
    const tls = c.tls.filter(t => t.scene === sc.index);
    const shown = tls.filter(t => t.drawT0 != null || t.appear);
    const say = stripPunct(sc.say);
    let textChars = 0;
    for (const tl of shown) {
      const el = tl.el, where = `${sc.file} / 元素 ${el.id}`;
      if (el.kind === 'figure') figures++;
      if (tl.drawT0 != null) draws++; else if (!tl.recalled) appears++;
      // 1. 板书不抄口播
      if (el.text) {
        const txt = stripPunct(el.text.replace(/\n/g, ''));
        textChars += txt.length;
        for (const piece of (el.kind === 'text' ? String(el.src.text).split('\n') : [el.text])) {
          const p = stripPunct(piece), lc = longestCommon(p, say);
          if (lc >= 7) add('error', where, `板书“${piece}”有 ${lc} 个字是照抄口播的。画面要演示口播在讲的事，不要把话再写一遍：换成图形、小人动作、数字或 2–5 字的关键词`);
          else if (p.length > 10 && p.replace(/[\d.+\-×÷=%≈≠<>→*/xX]/g, '').length > 6 && el.kind === 'text') add('warn', where, `板书“${piece}”一行有 ${p.length} 个字，偏长。板书只留关键词、数字、标签`);
        }
      }
      // 2. 出界
      const b = el.box;
      const outside = b.x < -12 || b.y < -12 || b.x + b.w > B.w + 12 || b.y + b.h > B.h + 12;
      if (b.x > B.w || b.y > B.h || b.x + b.w < 0 || b.y + b.h < 0) add('error', where, `整个元素在画板外面（画板 ${B.w}×${B.h}，它在 x ${b.x.toFixed(0)}…${(b.x + b.w).toFixed(0)}，y ${b.y.toFixed(0)}…${(b.y + b.h).toFixed(0)}）`);
      else if (outside) add('warn', where, `超出画板安全区（画板 ${B.w}×${B.h}，它占 x ${b.x.toFixed(0)}…${(b.x + b.w).toFixed(0)}，y ${b.y.toFixed(0)}…${(b.y + b.h).toFixed(0)}），可能被平台界面或字幕挡住`);
      // 3. 画得太赶
      if (tl.compress != null && tl.compress < 0.4) add('warn', where, `要用自然速度的 ${(1 / tl.compress).toFixed(1)} 倍才画得完（${(tl.drawT1! - tl.drawT0!).toFixed(2)} 秒），会像快进。简化它、给它更多时间（节拍加 lead 提前起笔），或拆到两拍`);
    }
    if (textChars > 110) add('warn', sc.file, `这个场景板书共 ${textChars} 个字，偏多。批注要短：数字、名字、出处，一条不超过十个字`);
    // 信息密度：一块板讲了这么久，上面应该已经是一张内容丰富的图
    const sig = new Map<string, number>();
    for (const t of shown) if (t.el.kind !== 'mark') { const k = t.el.kind + JSON.stringify(Object.fromEntries(Object.entries(t.el.src).filter(([key]) => !POS.has(key)))); sig.set(k, (sig.get(k) ?? 0) + 1); }
    // 一模一样的东西画十遍（一排小人）是一组，不是十样：第一个算 1，其余每个只算四分之一
    const dur = sc.t1 - sc.t0, things = Math.floor([...sig.values()].reduce((n, c) => n + 1 + (c - 1) * 0.25, 0)), want = Math.max(6, Math.round(dur / 2.4));
    if (dur >= 8 && things < want) add('warn', sc.file, `信息密度偏低：这个场景讲了 ${dur.toFixed(0)} 秒，板上一共只出现了 ${things} 样东西（这个时长建议不少于 ${want} 样）。画面稀疏会显得内容单薄。往上加“第二层信息”：给箭头写小字（label）、给关键元素加批注（note：数字、名字、出处）、补一个小图表或再放一种手法（pattern 写成列表、各占一块 area）`);
    for (const tl of shown) if (tl.el.kind === 'text' && (tl.el.src.size ?? 72) < 34) add('warn', `${sc.file} / 元素 ${tl.el.id}`, `字号 ${tl.el.src.size} 太小，手机上看不清，至少 36`);
    const visual = shown.filter(t => !['text', 'mark'].includes(t.el.kind));
    if (shown.length && !visual.length) add('warn', sc.file, '这个场景只有文字，没有任何图形或小人——这就是“像 PPT”。至少用一个画面元素来演示正在讲的事');
    // 画面太空
    if (visual.length && sc.t1 - sc.t0 >= 6) {
      const bs = shown.map(t => t.el.box), x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y)), x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
      const cover = ((x1 - x0) * (y1 - y0)) / (B.w * B.h);
      // 一横排或一竖列撑满了长边，也算把板面用起来了
      if (cover < 0.45 && Math.max((x1 - x0) / B.w, (y1 - y0) / B.h) < 0.8) add('warn', sc.file, `所有元素加起来只占了画板的 ${(cover * 100).toFixed(0)}%（画板 ${B.w}×${B.h}，内容在 x ${x0.toFixed(0)}…${x1.toFixed(0)}，y ${y0.toFixed(0)}…${y1.toFixed(0)}）。画面太空、东西太小，手机上看不清：放大元素，把板面用满`);
    }
    // 红色是用来指“此刻最要紧的那一样”的；满板红字等于没有重点
    const reds = shown.filter(t => (t.el.kind === 'text' || t.el.kind === 'note') && t.el.src.color === 'red' && !(t.gone != null && t.gone < sc.t1 - 0.7));
    // 一块板讲得越久，能容下的红字越多（每十秒左右一处），但总要远少于墨色
    if (reds.length > Math.max(4, Math.round((sc.t1 - sc.t0) / 8))) add('warn', sc.file, `这块板上有 ${reds.length} 处红字（${reds.slice(0, 6).map(t => `“${t.el.text}”`).join('、')}${reds.length > 6 ? '…' : ''}）。红色只留给否定、警示的数字和此刻的重点，一块板不超过三四处；其余改回墨色，次要的用灰色`);
    // 构图：场景结束时，板上有没有一整条横带是空的
    if (visual.length && sc.t1 - sc.t0 >= 8) {
      const live = shown.filter(t => t.el.kind !== 'mark').map(t => { const b = t.el.kind === 'note' ? t.el.solid : t.el.box, mv = t.moves.length ? t.moves[t.moves.length - 1].to : [0, 0]; return [b.y + mv[1], b.y + mv[1] + b.h]; });
      const N = 50, row = (i: number) => live.some(([y0, y1]) => y1 > (i * B.h) / N && y0 < ((i + 1) * B.h) / N);
      let best = 0, bestAt = 0, run = 0;
      for (let i = 0; i <= N; i++) { if (i < N && !row(i)) run++; else { if (run > best) { best = run; bestAt = i - run; } run = 0; } }
      if (best / N >= (c.fmt.name === 'portrait' ? 0.16 : 0.3)) { // 被擦掉的东西留下的空位是有意的，上面已经把它们算作“用过”
        const y0 = Math.round((bestAt * B.h) / N), y1 = Math.round(((bestAt + best) * B.h) / N), whereY = bestAt === 0 ? '最上面' : bestAt + best >= N ? '最下面' : '中间';
        add('warn', sc.file, `场景结束时，板面${whereY}有一整条是空的（y ${y0}…${y1}，占板高的 ${Math.round((best / N) * 100)}%）。画面重心偏了，这块地方正好放“支撑”那一层：一行小账、一个数字、一条批注，或者把主体往这边挪、放大。hj layout 可以看占用图`);
      }
    }
    // 4. 重叠
    const solid = shown.filter(t => !['mark', 'arrow', 'line'].includes(t.el.kind) && !t.moves.length);
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      const life = (t: TL): [number, number] => [t.drawT0 ?? t.appear!.t, t.gone ?? Infinity];
      const [a0, a1] = life(a), [b0, b1] = life(b);
      if (Math.max(a0, b0) >= Math.min(a1, b1)) continue;
      const refs = (x: TL, y: TL) => typeof x.el.src.at === 'string' && x.el.src.at.split('.')[0] === y.el.id;
      if (refs(a, b) || refs(b, a)) continue;
      const ov = inter(a.el.solid, b.el.solid) / Math.max(1, Math.min(a.el.box.w * a.el.box.h, b.el.box.w * b.el.box.h));
      // 小的整个装在大的容器里（气泡里的字、框里的图）是有意为之
      const big = a.el.box.w * a.el.box.h > b.el.box.w * b.el.box.h ? a : b;
      if (ov > 0.9 && ['doodle', 'shape', 'parts'].includes(big.el.kind)) continue;
      if (a.el.over.has(b.el.id) || b.el.over.has(a.el.id) || a.el.src.overlap === true || b.el.src.overlap === true) continue;
      if (ov > 0.06) add('warn', sc.file, `元素 "${a.el.id}" 和 "${b.el.id}" 重叠了 ${(ov * 100).toFixed(0)}%，引擎没能自动挪开（板上太挤，找不到空位）。减少这块板上的东西、缩小它们，或者先擦掉一部分`);
    }
    // ── 后画的那一层：标记、批注、线，落下之后压到了谁 ──
    const t0of = (t: TL) => t.drawT0 ?? t.appear!.t;
    const lifeOf = (t: TL): [number, number] => [t0of(t), t.gone ?? Infinity];
    const together = (a: TL, b: TL) => { const [a0, a1] = lifeOf(a), [b0, b1] = lifeOf(b); return Math.max(a0, b0) < Math.min(a1, b1); };
    const byId = new Map(tls.map(t => [t.el.id, t]));
    const targetsOf = (t: TL): string[] => (t.el.src.target == null ? [] : [t.el.src.target].flat().map((x: any) => String(x).split('.')[0]));
    for (const tl of shown) {
      const el = tl.el, where = `${sc.file} / 元素 ${el.id}`;
      // 批注、标记不能比它的目标先出现
      for (const id of targetsOf(tl)) {
        const tg = byId.get(id);
        if (!tg) continue;
        if (tg.drawT0 == null && !tg.appear) add('error', where, `它${el.kind === 'note' ? '批注' : '标记'}的是 "${id}"，但 "${id}" 从没画出来，画面上会是一行没有主的小字或一个空圈`);
        else if (t0of(tg) > t0of(tl) + 0.01) add('error', where, `它${el.kind === 'note' ? '批注' : '标记'}的是 "${id}"，却比 "${id}" 早 ${(t0of(tg) - t0of(tl)).toFixed(1)} 秒出现。先画目标，再画它；或者把 target 换成这一刻已经在板上的东西`);
      }
      // 标记（圈、框、叉）画下去之后压到了目标以外的东西
      if (el.kind === 'mark') {
        const tids = targetsOf(tl), tboxes = tids.map(i => byId.get(i)?.el.box).filter(Boolean) as Box[];
        if (!tboxes.length) continue;
        const tb = { x: Math.min(...tboxes.map(b => b.x)), y: Math.min(...tboxes.map(b => b.y)), w: 0, h: 0 }; tb.w = Math.max(...tboxes.map(b => b.x + b.w)) - tb.x; tb.h = Math.max(...tboxes.map(b => b.y + b.h)) - tb.y;
        const pts = linePoints(el), hit: string[] = [];
        for (const o of shown) {
          if (o === tl || tids.includes(o.el.id) || ['mark', 'arrow', 'line'].includes(o.el.kind) || o.moves.length || !together(tl, o)) continue;
          if (contains(o.el.box, tb) || tids.some(i => o.el.over.has(i) || byId.get(i)?.el.over.has(o.el.id))) continue; // 目标本来就在它里面 / 它本来就放在目标上
          const isText = o.el.kind === 'text' || o.el.kind === 'note';
          if (countIn(pts, o.el.solid, isText ? 4 : 10) >= (isText ? 2 : 5)) hit.push(o.el.id);
        }
        if (hit.length) add('warn', where, `这个${{ circle: '圈', box: '框', cross: '叉', strike: '划线', underline: '下划线' }[String(el.src.mark)] ?? '标记'}画下去会压到 ${NAMES(hit)}。标记不参与自动避让：把它们从 ${NAMES(tids)} 旁边挪开一点、调小 pad，或换一种标记（underline 占地最小）`);
      }
      // 字被线穿过（分隔线、箭头、别的批注的牵线）
      if ((el.kind === 'text' || el.kind === 'note') && !tl.moves.length) {
        const cut = shown.filter(o => o !== tl && (o.el.kind === 'line' || o.el.kind === 'arrow') && !o.moves.length && together(tl, o) && !el.over.has(o.el.id) && !targetsOf(tl).includes(o.el.id) && countIn(linePoints(o.el, true), el.solid, -3) >= 3).map(o => o.el.id);
        if (cut.length) add('warn', where, `“${el.text}”被线 ${NAMES(cut)} 穿过去了，字会看不清。把字挪开（批注换一个 side、调 gap），或把线画短一点`);
      }
      // 东西直接摆在小人手的位置上（不是拿在手里）
      if (typeof el.src.at === 'string' && /\.hand[LR]$/.test(el.src.at) && !el.src.dx && !el.src.dy && !tl.moves.length && el.kind !== 'text') {
        const who = byId.get(el.src.at.split('.')[0]);
        if (who?.el.figure) add('warn', where, `它是摆在 "${who.el.id}" 手的位置上，不是拿在手里：会盖住小人的身体，小人换姿势、走动时它也不跟着。去掉这个元素，改成在小人上写 carry: { ${el.kind}: ${JSON.stringify(el.src[el.kind])} }`);
      }
      // 一排东西里被单独挪走的那个
      if (el.nudged && Math.hypot(el.nudged[0], el.nudged[1]) > 8) {
        const ix = el.box.x - el.nudged[0], iy = el.box.y - el.nudged[1];
        const sib = shown.filter(o => o !== tl && o.el.kind === el.kind && !o.el.nudged && Math.abs(o.el.box.w - el.box.w) < 6 && Math.abs(o.el.box.h - el.box.h) < 6);
        if (sib.filter(o => Math.abs(o.el.box.y - iy) < 4).length >= 2 || sib.filter(o => Math.abs(o.el.box.x - ix) < 4).length >= 2) add('warn', where, `它本来和别的几个排成一排，但原位置会压到东西，被引擎单独挪开了 (${el.nudged[0].toFixed(0)}, ${el.nudged[1].toFixed(0)})，队列不齐了。给整排挪个位置，或者把挡在那儿的东西移走`);
      }
      // 贴着板沿
      if (!['mark', 'arrow', 'line', 'parts'].includes(el.kind) && !tl.moves.length && el.src.overlap !== true) {
        const b = el.solid, isText = el.kind === 'text' || el.kind === 'note', m = isText ? 12 : 5;
        const gap = Math.min(b.x, b.y, B.w - b.x - b.w, B.h - b.y - b.h);
        if (gap < m && gap >= -12) add('warn', where, `${isText ? `“${el.text}”` : '它'}贴着画板边缘（只剩 ${Math.max(0, gap).toFixed(0)}px）。板沿之外就是平台按钮和字幕，贴边的东西看着像被裁了一刀：往里收至少 ${isText ? 16 : 10}px`);
      }
    }
    // 走到一半原地消失
    const vanished = shown.filter(t => t.el.figure && t.gone != null && t.moves.length && t.moves[t.moves.length - 1].linear && t.alpha.some(a => a.to === 0 && a.t0 - t.moves[t.moves.length - 1].t1 < 0.6)).filter(t => {
      const mv = t.moves[t.moves.length - 1].to, b = { x: t.el.box.x + mv[0], y: t.el.box.y + mv[1], w: t.el.box.w, h: t.el.box.h };
      if (b.x + b.w < 30 || b.y + b.h < 30 || b.x > B.w - 30 || b.y > B.h - 30) return false; // 走出画板了
      return !shown.some(o => o !== t && !o.el.figure && !['mark', 'arrow', 'line', 'note', 'text'].includes(o.el.kind) && together(t, o) && inter(b, o.el.box) > 0.25 * b.w * b.h); // 走进了某样东西里（上船、进门）
    }).map(t => t.el.id);
    if (vanished.length) add('warn', sc.file, `${NAMES(vanished)} 走了一段就在板子中间凭空消失了。要么走到目的地（walk: 小人, to: 目标 或 "目标.锚点"，到了再 hide 或干脆留在那儿），要么走出画板`);
    // 画完马上就擦：观众还没看清“这里原本有什么”
    const brief: string[] = [];
    for (const tl of shown) {
      if (tl.drawT1 == null || tl.gone == null) continue;
      const g = tl.erase != null ? c.erases[tl.erase] : null, start = g ? g.t0 : Math.min(...tl.alpha.filter(a => a.to === 0).map(a => a.t0), tl.gone);
      if (g && g.t0 >= sc.t1 - 0.7) continue; // 转场擦板
      if (tl.moves.length) continue;
      if (start - tl.drawT1 < 0.3 && start - tl.drawT0! < 1.0) brief.push(tl.el.id); // 从起笔到被擦不足 1 秒，且画完几乎没停
    }
    if (brief.length) add('warn', sc.file, `${NAMES(brief)} 从起笔到被擦掉/隐去不到 1 秒，刚画完就没了。“先建立、再破坏”要让建立的那一下站得住：把画提前一拍，或把擦往后挪，中间至少留 1 秒`);
    // 一拍里赶着画一大群
    for (const b of sc.beats) {
      // 只数“有分量”的东西：小人、手绘件、图标。圆点、线段、几个字本来就是一两笔的事
      const ds = b.actions.filter(a => a.verb === 'draw' && a.ids.some(i => ['figure', 'doodle', 'icon', 'parts', 'chart'].includes(byId.get(i)?.el.kind ?? '')));
      if (ds.length < 6) continue;
      const avg = ds.reduce((n, a) => n + a.t1 - a.t0, 0) / ds.length;
      if (avg < 0.26) add('warn', sc.file, `${fmtT(b.t)} 这一拍要画 ${ds.length} 样东西，平均每样只有 ${avg.toFixed(2)} 秒，看起来是“唰”地闪出来的，不是画出来的。分到两三拍，或者用 lead 提前起笔`);
    }
    // 5. 画面静止太久
    const acts = sc.beats.flatMap(b => b.actions).sort((x, y) => x.t0 - y.t0);
    let cursor = sc.t0;
    const idle = (from: number, to: number) => {
      if (to - from < 4.2) return;
      const said = c.al.units.filter(u => u.start >= from && u.start < to).map(u => u.display).join('');
      add('warn', sc.file, `${fmtT(from)}–${fmtT(to)} 有 ${(to - from).toFixed(1)} 秒画面没有任何变化，这段在说：“${said.slice(0, 40)}${said.length > 40 ? '…' : ''}”。真人讲到这里手不会停：加一拍（画点东西、小人换个动作、圈一下重点、推一下镜头）`);
    };
    for (const a of acts) { idle(cursor, a.t0); cursor = Math.max(cursor, a.t1); }
    idle(cursor, sc.t1);
    // 换到新板面后，板子空着等人
    const firstInk = Math.min(...shown.map(t => t.drawT0 ?? t.appear!.t));
    if (shown.length && firstInk - sc.t0 > 1.5) {
      const said = c.al.units.filter(u => u.start >= sc.t0 - 1e-6 && u.start < firstInk).map(u => u.display).join('');
      add('warn', sc.file, `这个场景开始后，板面空了 ${(firstInk - sc.t0).toFixed(1)} 秒才落第一笔，这段在说：“${said.slice(0, 40)}”。空板比静止的满板更难看：把第一拍卡到场景开口的那几个字上，或者把 from 往后挪到真正开始画的地方`);
    }
    // 小动作撑不起一长段：晃一下、换个表情不算往板上加东西
    if (sc.t1 - sc.t0 >= WINDOW) {
      const ink = acts.filter(a => ['draw', 'pop', 'fade', 'erase', 'move', 'walk', 'scale', 'camera'].includes(a.verb));
      let worst = -1, worstInk = Infinity;
      for (let w0 = sc.t0; w0 + WINDOW <= sc.t1 + 1e-6; w0 += 0.5) {
        const sum = ink.reduce((n, a) => n + Math.max(0, Math.min(a.t1, w0 + WINDOW) - Math.max(a.t0, w0)), 0);
        if (sum < worstInk) { worstInk = sum; worst = w0; }
      }
      if (worstInk < 0.5) {
        const said = c.al.units.filter(u => u.start >= worst && u.start < worst + WINDOW).map(u => u.display).join('');
        add('warn', sc.file, `${fmtT(worst)}–${fmtT(worst + WINDOW)} 这 ${WINDOW} 秒里板上几乎没有新东西（只有晃动、换姿势这类小动作），这段在说：“${said.slice(0, 44)}…”。小动作只能垫一两秒：这段话里一定有能画的东西（一个数、一个对比、一个后果），给它一拍`);
      }
    }
    // 一块板讲了很久却始终是同一个景别：讲细节时该推近，讲完拉回全景
    const camActs = acts.filter(a => a.verb === 'camera');
    if (sc.t1 - sc.t0 >= 25 && !camActs.length) add('warn', sc.file, `这块板讲了 ${(sc.t1 - sc.t0).toFixed(0)} 秒，镜头一次都没动。全程一个远景，细节看不清，也没有节奏：讲到某一块的细节时推近（{ camera: { focus: 分区名或元素 } }），讲完、要看它和别处的关系时拉回全景（{ camera: home }）`);
    // 推近却几乎没放大：竖屏里横贯全宽的东西推不近，近景要对准局部的几样东西
    {
      const hz = sc.home.zoom || 1, segs = c.cams.filter(k => k.t0 >= sc.t0 - 1e-6 && k.t0 < sc.t1 && k.to !== sc.home && !k.cut);
      const flat = segs.filter(k => k.to.zoom / hz < 1.2);
      if (flat.length) add('warn', sc.file, `有 ${flat.length} 次推近几乎没有放大（${flat.slice(0, 4).map(k => `${fmtT(k.t0)} 放大 ${(k.to.zoom / hz).toFixed(2)} 倍`).join('、')}）：它对准的东西几乎和整块板一样宽，推了等于没推。近景对准局部的两三样东西（如 { camera: { focus: [n1, r1], pad: 60 } }），放大到 1.5 倍以上才看得出是近景`);
    }
    // 分区是全景的骨架：划了地盘就得用上
    for (const rg of sc.regions ?? []) {
      const used = shown.some(t => { const b = t.el.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= rg.box.x && cx <= rg.box.x + rg.box.w && cy >= rg.box.y && cy <= rg.box.y + rg.box.h; });
      if (!used) add('warn', sc.file, `分区 "${rg.name}" 到最后还是空的。全景缺了一块：把该放这儿的内容补上，或者重新划分区`);
    }
    // 6. 转场时上一场还没画完
    const next = c.scenes[sc.index + 1];
    if (next && acts.length) { const last = Math.max(...acts.map(a => a.t1)); if (last > next.t0 - 0.3) add('warn', sc.file, `最后一个动作 ${fmtT(last)} 才结束，但 ${fmtT(next.t0)} 就要转到下一个场景了，会画到一半被带走`); }
  }
  // 翻页：一条片子被切成一页页互不相干的小板。默认应该是一块板，从一个点切入、一点点展开、最后连成一张全景
  if (c.scenes.length >= 2 && c.meta.layout !== 'pages') {
    const avg = c.duration / c.scenes.length;
    if (avg < 40) add('warn', '全片', `这条片子有 ${c.scenes.length} 块板，平均一块只讲 ${avg.toFixed(0)} 秒——这是翻页，不是边画边讲。两分钟以内的内容应该画在一块板上：先定全景和分区（regions），画过的东西留在原位，后面的内容对着前面的摆、用线连回去；靠镜头的远近（camera focus / home）换景，而不是换板。确实要分页（很长的片子分章、素材陈列）就在 project.yaml 里写 layout: pages`);
  }
  // 片尾停在全景上：最后观众要看到整张图
  {
    const ls = c.scenes[c.scenes.length - 1], seg = ls ? [...c.cams].filter(k => k.t0 >= ls.t0 - 0.5).pop() : null;
    if (ls && seg && seg.to !== ls.home && ls.t1 - ls.t0 >= 25) add('warn', ls.file, '片子结束时镜头还推在局部。最后一拍拉回全景（{ camera: home }），让观众看到整块板连成的那一张图');
  }
  // 片尾：最后一笔要在配音说完之前落定
  const lastSc = c.scenes[c.scenes.length - 1], voiceEnd = c.al.units.length ? c.al.units[c.al.units.length - 1].end : c.duration;
  if (lastSc) {
    const la = lastSc.beats.flatMap(b => b.actions).filter(a => ['draw', 'pop', 'fade', 'erase', 'move', 'walk'].includes(a.verb));
    const last = la.length ? Math.max(...la.map(a => a.t1)) : 0;
    if (last > Math.max(voiceEnd + 0.15, c.al.duration + 0.05)) add('warn', lastSc.file, `最后一个动作 ${fmtT(last)} 才做完，配音 ${fmtT(voiceEnd)} 就说完了：片子会在画到一半、或刚画完的那一下结束。最后一拍只留一件事，并用 lead 提前，让它在最后一个字之前落定`);
  }
  if (draws + appears > 6 && appears / (draws + appears) > 0.4) add('warn', '全片', `有 ${appears} 个元素是直接弹出/淡入的（共 ${draws + appears} 个）。这是 PPT 的出场方式；手绘视频里东西应该是画出来的，pop/fade 只留给“变戏法”的时刻`);
  if (c.scenes.length > 2 && figures === 0) add('info', '全片', '全片没有出现小人。一个会指、会愣、会摊手的小人是“有人在讲”的来源，考虑让它贯穿全片');
  return out;
}

export function printIssues(issues: Issue[]): { errors: number; warns: number } {
  const errors = issues.filter(i => i.level === 'error'), warns = issues.filter(i => i.level === 'warn'), infos = issues.filter(i => i.level === 'info');
  for (const [label, list] of [['✗ 错误', errors], ['! 警告', warns], ['· 提示', infos]] as const) for (const i of list) console.log(`${label}  ${i.where}\n      ${i.msg}`);
  console.log(`\n${errors.length} 个错误，${warns.length} 个警告，${infos.length} 个提示`);
  return { errors: errors.length, warns: warns.length };
}

/** 给用户确认用的文字分镜表 */
export function planMarkdown(c: Compiled): string {
  const L: string[] = [];
  const paged = c.meta.layout === 'pages', n = c.scenes.length;
  L.push(`# 分镜表：${c.meta.title ?? '未命名'}`, '');
  L.push(`画幅 ${c.fmt.name === 'portrait' ? '竖屏 9:16' : '横屏 16:9'} · 时长 ${fmtT(c.duration)} · ${n} 块板${paged ? '（分页写法）' : ''} · 分镜版本 \`${c.planHash}\``, '');
  L.push('> 请按这个顺序看：先看**全景**（整块板讲完是一张什么图、分成哪几块），再看**镜头**怎么走，最后逐行看“画面”一栏是否在**演示**口播讲的事，而不是把话再写一遍。确认前不会渲染任何画面。', '');
  for (const sc of c.scenes) {
    const B = sc.board ?? c.fmt.board, tls = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear));
    L.push(`## ${n > 1 ? `第 ${sc.index + 1} 块板：` : ''}${sc.id}　${fmtT(sc.t0)}–${fmtT(sc.t1)}`, '');
    L.push(`**全景：** ${sc.intent || '（未填写）'}`, '');
    if (B.w > c.fmt.board.w + 1) L.push(`这块板是屏幕的 ${(B.w / c.fmt.board.w).toFixed(1)} 倍大：全景是缩小的整块板，近景才是原大。`, '');
    if (sc.index > 0 || sc.recall) L.push(`进场方式：${{ pan: '镜头平移到新板面', wipe: '板擦擦净后重画', cut: '直接切换' }[sc.enter] ?? sc.enter}${sc.recall ? `；板上已经有场景 ${sc.recall} 留下的画面（不重画），在它上面接着讲` : ''}`, '');
    // 分区：在板上的位置、讲完时里面有什么
    if (sc.regions?.length) {
      const where = (b: Box) => { const cx = (b.x + b.w / 2) / B.w, cy = (b.y + b.h / 2) / B.h, v = cy < 0.34 ? '上' : cy > 0.66 ? '下' : '中', h = b.w / B.w > 0.7 ? '' : cx < 0.4 ? '左' : cx > 0.6 ? '右' : '中'; return h ? `${v}部${h}侧` : `${v}部，横贯`; };
      const name = (t: TL) => t.el.src?.label ? String(t.el.src.label) : t.el.src?.doodle ? String(t.el.src.doodle) : t.el.kind === 'figure' ? '小人' : t.el.text ? `“${t.el.text.replace(/\n/g, ' ').slice(0, 10)}”` : '';
      L.push('| 分区 | 位置 | 讲完时这里有什么 |', '|---|---|---|');
      for (const rg of sc.regions) {
        const inside = tls.filter(t => !['arrow', 'line', 'mark'].includes(t.el.kind) && !(t.gone != null && t.gone < sc.t1 - 0.7)).filter(t => { const b = t.el.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= rg.box.x && cx <= rg.box.x + rg.box.w && cy >= rg.box.y && cy <= rg.box.y + rg.box.h; });
        const names = [...new Set(inside.map(name).filter(Boolean))];
        L.push(`| ${rg.name} | ${where(rg.box)} | ${names.slice(0, 8).join('、')}${names.length > 8 ? ` 等 ${names.length} 样` : ''}${names.length ? '' : '（空）'} |`);
      }
      L.push('');
    }
    const cams = sc.beats.flatMap(b => b.actions.filter(a => a.verb === 'camera').map(a => `${fmtT(a.t0)} ${a.desc.replace(/^镜头/, '')}`));
    L.push(`**镜头：** ${cams.length ? cams.join(' → ') : '全程停在全景，没有推近'}`, '');
    L.push('| 时间 | 口播 | 画面 | 板书文字 |', '|---|---|---|---|');
    const first = sc.beats[0];
    if (first && first.t - sc.t0 > 0.4) { const pre = c.al.units.filter(u => u.start >= sc.t0 - 1e-6 && u.start < first.t - 1e-6).map(u => u.display).join(''); if (pre) L.push(`| ${fmtT(sc.t0)} | ${pre} | （承接上一拍，画面不变） | |`); }
    for (const b of sc.beats) {
      const texts = b.actions.flatMap(a => a.ids).map(id => c.tls.find(t => t.scene === sc.index && t.el.id === id)?.el).filter(e => e?.text && b.actions.some(a => ['draw', 'pop', 'fade'].includes(a.verb) && a.ids.includes(e!.id))).map(e => e!.text!.replace(/\n/g, ' / '));
      L.push(`| ${fmtT(b.t)} | ${b.say || '—'} | ${b.intent} | ${[...new Set(texts)].join('、')} |`);
    }
    L.push('');
  }
  // 没解决的质量警告原样交给用户看，不让它们被悄悄带过去
  const warns = c.issues.filter(i => i.level === 'warn');
  if (warns.length) {
    L.push('## 尚未解决的质量警告', '', '下面是自动检查发现、但写分镜的人没有处理的问题。确认前请留意：', '');
    for (const w of warns) L.push(`- **${w.where}**：${w.msg}`);
    L.push('');
  }
  return L.join('\n');
}
