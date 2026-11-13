// hj：画讲命令行。流程是 init → brief → 写分镜 → check → plan →（用户确认）→ stills →（用户确认）→ render
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import YAML from 'yaml';
import { compile, type Compiled, type CScene } from '../core/compile';
import { lint, printIssues, planMarkdown } from '../core/lint';
import { drawFrame, drawStrokes, type Env } from '../core/render';
import { writeSfx } from '../core/sfx';
import { loadAlignment, fakeAlignment, resolveAnchor } from '../core/alignment';
import { searchIcons } from '../core/icons';
import { POSES, FACES, ACCESSORIES } from '../core/figure';
import { doodleDirs } from '../core/elements';
import { textStrokes } from '../core/text';
import { PATTERNS } from '../core/patterns';
import { THEME, FORMATS } from '../core/theme';

const env: Env = { createCanvas, Path2D };
process.stdout.on('error', () => process.exit(0)); // 输出被 head 之类截断时安静退出
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string | true> = {};
const args: string[] = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true; }
  else args.push(argv[i]);
}
const die = (msg: string): never => { console.error('✗ ' + msg); process.exit(1); };
const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function load(dir: string, strict = true): Compiled {
  let c: Compiled;
  try { c = compile(dir); } catch (e: any) { return die(e.message); }
  c.issues = lint(c);
  const errors = c.issues.filter(i => i.level === 'error');
  if (strict && errors.length) { printIssues(c.issues); die('分镜有错误，先修掉再继续（hj check 可随时重查）'); }
  return c;
}
const approvalsFile = (dir: string) => join(dir, 'approvals.json');
const approvals = (dir: string): any => (existsSync(approvalsFile(dir)) ? JSON.parse(readFileSync(approvalsFile(dir), 'utf8')) : {});
function gate(c: Compiled, stage: 'plan' | 'keyframes') {
  const a = approvals(c.dir);
  const label = stage === 'plan' ? '文字分镜' : '关键帧';
  const how = stage === 'plan'
    ? `先运行 hj plan ${c.dir} 生成 storyboard.md 交给用户看；用户明确同意后运行 hj approve ${c.dir} plan --by "<用户的确认原话>"\n  想在交给用户之前自己先看看画面：hj stills ${c.dir} --draft（带水印的草稿，不需要确认）`
    : `先运行 hj stills ${c.dir} 出关键帧交给用户看；用户明确同意后运行 hj approve ${c.dir} keyframes --by "<用户的确认原话>"`;
  if (!a[stage]) die(`${label}还没有得到用户确认，不能继续。\n  ${how}`);
  if (a[stage].planHash !== c.planHash) die(`${label}确认之后，分镜内容（场景划分 / 每拍画什么）又改过了（确认的是 ${a[stage].planHash}，现在是 ${c.planHash}），需要用户重新确认。\n  ${how}\n  只调位置、大小、颜色、时长这类细节不会触发重新确认。`);
}

/** 一个场景板上的三层信息各有几样（一模一样的重复元素算一样） */
function layers(c: Compiled, sc: CScene) {
  const shown = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear));
  const seen = new Set<string>(); let main = 0, support = 0, notes = 0;
  for (const t of shown) {
    const e = t.el, k = e.kind;
    if (['figure', 'doodle', 'icon', 'parts'].includes(k)) { const sig = k + JSON.stringify([e.src.figure, e.src.doodle, e.src.icon, e.src.wear, e.src.size]); if (!seen.has(sig)) { seen.add(sig); main++; } if (e.src.label) notes++; }
    else if (k === 'note') notes++;
    else if (k === 'text') { if (/[0-9０-９%％½¼¾×÷=≠+＋]/.test(e.text ?? '')) support++; else if ((e.src.size ?? 72) <= 60) notes++; else main++; }
    else if (k === 'chart' || k === 'shape') support++;
    else if (k === 'arrow' || k === 'line') { support++; if (e.src.label) notes++; }
  }
  return { main, support: Math.min(support, 99), notes };
}

const CAST_TEMPLATE = `# 角色表：全片反复出现的人和东西，长相只在这里定义一次。
# 场景里写 { cast: 名字, at: [x, y], size: 300 } 引用；可以再加 pose / face / carry / size 覆盖。
# 同一个角色全片一个样，观众才认得出来。
#
# me:     { figure: stand }                                  # 讲述者
# boss:   { figure: stand, face: smug, wear: [tophat] }      # 老板永远戴礼帽
# money:  { doodle: banknote }                               # 钱永远是那张绿钞票
`;
const OUTLINE_TEMPLATE = `# 提纲（写分镜之前先填；填不出来说明还没想清楚，不要急着写 YAML）

## 一句话
这条片子讲完，观众记住的那一个画面是什么？（不是一句话，是一个画面）

## 母图
全片反复回来的那张图（两个阵营、一条流程、一杆天平…）。它在第几场立起来，在哪几场回来（recall），每次回来加了什么、破坏了什么？

## 角色表（同步写进 cast.yaml）
| 角色 | 长相 | 代表什么 |
|---|---|---|

## 逐段
| 场景 | 口播从哪句到哪句 | 这段在干什么（设问/说法/理由/算账/数据/转折/结论） | 手法 | 主体画什么 | 支撑：哪些数字、小账 | 批注：出处、名字、倍数 | 和前面哪个画面呼应 |
|---|---|---|---|---|---|---|---|

## 开头 5 秒
第一句话落地时，板上是什么？（一个让人想看下去的画面，不是慢慢搭台）

## 结尾
最后一句话落下时，板上只多一样东西。是什么？
`;

function canvasFor(c: Compiled, scale: number) { const cv = createCanvas(Math.round(c.fmt.W * scale), Math.round(c.fmt.H * scale)); return { cv, ctx: cv.getContext('2d') }; }
function sceneArg(c: Compiled): CScene | null {
  if (!flags.scene) return null;
  return c.scenes.find(s => s.id === flags.scene || String(s.index + 1) === flags.scene || s.file.includes(String(flags.scene))) ?? die(`没有叫 "${flags.scene}" 的场景。现有：${c.scenes.map(s => s.id).join(' ')}`);
}

const commands: Record<string, () => Promise<void> | void> = {
  init() {
    const dir = args[0] ?? die('用法：hj init <项目目录> --voice <配音材料目录或 alignment.json> [--format portrait|landscape] [--title 标题]');
    const voice = flags.voice ? String(flags.voice) : die('需要 --voice：配音材料目录（含 alignment.json），或一份时间表文件');
    mkdirSync(join(dir, 'voice'), { recursive: true }); mkdirSync(join(dir, 'scenes'), { recursive: true });
    const srcAl = existsSync(join(voice, 'alignment.json')) ? join(voice, 'alignment.json') : existsSync(join(voice, 'subtitles.srt')) ? join(voice, 'subtitles.srt') : voice;
    if (!existsSync(srcAl)) die(`找不到时间表：${srcAl}`);
    const alName = /\.srt$/i.test(srcAl) ? 'subtitles.srt' : 'alignment.json';
    copyFileSync(srcAl, join(dir, 'voice', alName));
    let audio = '';
    for (const n of ['narration.wav', 'narration.mp3', 'narration.m4a']) { const f = join(existsSync(join(voice, n)) ? voice : resolve(voice, '..'), n); if (existsSync(f)) { copyFileSync(f, join(dir, 'voice', n)); audio = 'voice/' + n; break; } }
    const fmt = String(flags.format ?? 'portrait');
    if (!FORMATS[fmt]) die('format 只能是 portrait 或 landscape');
    if (!existsSync(join(dir, 'project.yaml'))) writeFileSync(join(dir, 'project.yaml'), `title: ${JSON.stringify(String(flags.title ?? basename(resolve(dir))))}\nformat: ${fmt}        # portrait 竖屏 1080×1920 / landscape 横屏 1920×1080\nfps: 30\nvoice: voice/${alName}\n${audio ? `audio: ${audio}` : '# audio: voice/narration.wav   # 配音文件放进 voice/ 后取消注释'}\nsubtitles: true\nsfx: true              # 落笔音效\npen: false             # 是否显示笔尖\n`);
    if (!existsSync(join(dir, 'cast.yaml'))) writeFileSync(join(dir, 'cast.yaml'), CAST_TEMPLATE);
    if (!existsSync(join(dir, 'outline.md'))) writeFileSync(join(dir, 'outline.md'), OUTLINE_TEMPLATE);
    console.log(`✓ 项目已创建：${dir}\n  时间表：voice/${alName}${audio ? `\n  配音：${audio}` : '\n  （没找到配音文件，渲染出来只有落笔音效；把 narration.wav 放进 voice/ 并在 project.yaml 里填 audio）'}\n下一步：hj brief ${dir}   通读口播和时间；先填 outline.md（论证、母图、角色表），再在 scenes/ 里写分镜`);
  },

  brief() {
    const dir = args[0] ?? die('用法：hj brief <项目目录>');
    const meta = YAML.parse(readFileSync(join(dir, 'project.yaml'), 'utf8'));
    const al = loadAlignment(join(dir, meta.voice ?? 'voice/alignment.json'));
    const L: string[] = [`# 口播简报`, '', `总时长 ${fmtT(al.duration)}，${al.units.length} 个字/词，${al.sentences.length} 句，平均每秒 ${(al.units.length / al.duration).toFixed(1)} 字。`, '',
      '每句后面的“停顿”是到下一句开口前的空隙——转场、擦板、提前起笔都该放在停顿里。', '带 ~波浪线~ 的字时间不可靠，尽量别把卡点落在它们上面。', '', '| # | 起 | 止 | 时长 | 停顿 | 口播 |', '|--:|--:|--:|--:|--:|---|'];
    al.sentences.forEach((s, i) => {
      const gap = al.sentences[i + 1] ? al.sentences[i + 1].start - s.end : 0;
      let txt = '';
      for (let k = s.from; k < s.to; k++) { const u = al.units[k]; txt += u.shaky ? `~${u.display}~` : u.display; }
      L.push(`| ${i + 1} | ${s.start.toFixed(2)} | ${s.end.toFixed(2)} | ${(s.end - s.start).toFixed(1)}s | ${gap > 0.02 ? gap.toFixed(2) + 's' : ''} | ${txt.replace(/~~/g, '')} |`);
    });
    const out = L.join('\n') + '\n';
    writeFileSync(join(dir, 'brief.md'), out);
    console.log(out + `\n（已写入 ${join(dir, 'brief.md')}）`);
  },

  check() {
    const dir = args[0] ?? die('用法：hj check <项目目录>');
    const c = load(dir, false);
    console.log(`${c.scenes.length} 个场景，${c.tls.length} 个元素，时长 ${fmtT(c.duration)}，分镜版本 ${c.planHash}\n`);
    // 每个场景的三层信息各有多少：主体（人、物）/ 支撑（数字、图表、箭头）/ 批注（小字）。哪一层是 0，哪一层就该补
    for (const sc of c.scenes) {
      const L = layers(c, sc);
      console.log(`  ${String(sc.index + 1).padStart(2)}. ${sc.id.padEnd(18)} ${fmtT(sc.t0)}–${fmtT(sc.t1)}  ${String(sc.beats.length).padStart(2)} 拍  主体 ${L.main} · 支撑 ${L.support} · 批注 ${L.notes}${L.main && L.support && L.notes ? '' : '   ← 缺一层'}`);
    }
    console.log('');
    const r = printIssues(c.issues);
    const a = approvals(dir);
    console.log(`确认状态：文字分镜 ${a.plan ? (a.plan.planHash === c.planHash ? '✓ 已确认' : '✗ 确认后又改过，需重新确认') : '未确认'}；关键帧 ${a.keyframes ? (a.keyframes.planHash === c.planHash ? '✓ 已确认' : '✗ 需重新确认') : '未确认'}`);
    if (r.errors || (flags.strict && r.warns)) process.exit(1); // --strict：有警告也算失败（给 CI 用）
  },

  plan() {
    const dir = args[0] ?? die('用法：hj plan <项目目录>');
    const c = load(dir);
    const warns = c.issues.filter(i => i.level === 'warn');
    writeFileSync(join(dir, 'storyboard.md'), planMarkdown(c));
    console.log(`✓ 文字分镜表已生成：${join(dir, 'storyboard.md')}（分镜版本 ${c.planHash}）`);
    if (warns.length) console.log(`  注意：还有 ${warns.length} 个警告（hj check 查看）。交给用户之前最好处理掉，或向用户说明。`);
    console.log('把这份分镜表交给用户确认。用户同意之前不要出图、不要渲染。');
  },

  approve() {
    const dir = args[0], stage = args[1] as 'plan' | 'keyframes';
    if (!dir || !['plan', 'keyframes'].includes(stage) || typeof flags.by !== 'string') die('用法：hj approve <项目目录> plan|keyframes --by "<用户的确认原话>"\n只有在用户明确表示同意之后才能运行。');
    const c = load(dir);
    if (stage === 'keyframes') gate(c, 'plan');
    const a = approvals(dir);
    a[stage] = { planHash: c.planHash, by: flags.by, at: new Date().toISOString() };
    writeFileSync(approvalsFile(dir), JSON.stringify(a, null, 2) + '\n');
    console.log(`✓ 已记录用户对${stage === 'plan' ? '文字分镜' : '关键帧'}的确认（分镜版本 ${c.planHash}）。下一步：${stage === 'plan' ? `hj stills ${dir}` : `hj render ${dir}`}`);
  },

  // 布局线框：不画任何笔画，只把每个元素最后落在哪儿画成方框。写分镜时随时看，不需要用户确认
  async layout() {
    const dir = args[0] ?? die('用法：hj layout <项目目录> [--scene 场景]');
    const c = load(dir, false);
    const out = join(dir, 'out', 'layout'); mkdirSync(out, { recursive: true });
    const only = sceneArg(c), B = c.fmt.board, k = 0.6, M = 30;
    const COL: Record<string, string> = { figure: '#2f6fb7', doodle: '#2f6fb7', icon: '#2f6fb7', parts: '#2f6fb7', text: '#3c8f4f', note: '#8a8580', shape: '#7556c2', chart: '#7556c2', mark: '#d9433a', arrow: '#e8792b', line: '#e8792b' };
    for (const sc of c.scenes) {
      if (only && sc !== only) continue;
      const shown = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear));
      const cv = createCanvas(Math.round(B.w * k) + M * 2, Math.round(B.h * k) + M * 2), x = cv.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, cv.width, cv.height);
      x.strokeStyle = '#212529'; x.lineWidth = 2; x.setLineDash([8, 6]); x.strokeRect(M, M, B.w * k, B.h * k); x.setLineDash([]);
      const flagged = new Set(c.issues.filter(i => i.level !== 'info' && i.where.startsWith(sc.file + ' / 元素 ')).map(i => i.where.split('元素 ')[1]));
      const label = (txt: string, px: number, py: number, col: string) => { const t = textStrokes(txt, { size: 17, color: col }); x.save(); x.translate(px, py); drawStrokes(x, env, t.strokes); x.restore(); };
      console.log(`\n■ ${sc.index + 1}. ${sc.id}（画板 ${B.w}×${B.h}，坐标是元素的外框）`);
      for (const t of shown) {
        const e = t.el, b = e.kind === 'note' ? e.solid : e.box, gone = t.gone != null && t.gone < sc.t1 - 0.7, mv = t.moves.length ? t.moves[t.moves.length - 1].to : [0, 0];
        const bx = M + (b.x + mv[0]) * k, by = M + (b.y + mv[1]) * k;
        x.globalAlpha = gone ? 0.3 : 1; x.strokeStyle = COL[e.kind] ?? '#000'; x.lineWidth = flagged.has(e.id) ? 4 : 1.5;
        if (e.kind === 'arrow' || e.kind === 'line') { if (e.path) { x.beginPath(); x.moveTo(M + e.path[0] * k, M + e.path[1] * k); for (let i = 2; i < e.path.length; i += 2) x.lineTo(M + e.path[i] * k, M + e.path[i + 1] * k); x.stroke(); } }
        else { if (e.kind === 'mark') x.setLineDash([4, 4]); if (flagged.has(e.id)) { x.fillStyle = 'rgba(217,67,58,0.12)'; x.fillRect(bx, by, b.w * k, b.h * k); } x.strokeRect(bx, by, b.w * k, b.h * k); x.setLineDash([]); }
        if (e.nudged && Math.hypot(e.nudged[0], e.nudged[1]) > 30) { x.strokeStyle = '#e8792b'; x.lineWidth = 2; x.setLineDash([3, 3]); x.strokeRect(bx - e.nudged[0] * k, by - e.nudged[1] * k, b.w * k, b.h * k); x.beginPath(); x.moveTo(bx - e.nudged[0] * k + b.w * k / 2, by - e.nudged[1] * k + b.h * k / 2); x.lineTo(bx + b.w * k / 2, by + b.h * k / 2); x.stroke(); x.setLineDash([]); }
        if (e.kind !== 'arrow' && e.kind !== 'line' && e.kind !== 'mark') label(e.id.slice(0, 14), bx + 3, by + 2, COL[e.kind] ?? '#000');
        x.globalAlpha = 1;
        console.log(`  ${e.id.padEnd(12)} ${e.kind.padEnd(7)} x ${String(Math.round(b.x + mv[0])).padStart(4)}…${String(Math.round(b.x + mv[0] + b.w)).padEnd(4)} y ${String(Math.round(b.y + mv[1])).padStart(4)}…${String(Math.round(b.y + mv[1] + b.h)).padEnd(4)}${e.text ? ' “' + e.text.replace(/\n/g, '/') + '”' : ''}${gone ? '  （中途擦掉）' : ''}${t.recalled ? '  （沿用）' : ''}${e.nudged && Math.hypot(e.nudged[0], e.nudged[1]) > 30 ? `  ← 被挪了 (${e.nudged[0].toFixed(0)}, ${e.nudged[1].toFixed(0)})` : ''}${flagged.has(e.id) ? '  ← 有警告' : ''}`);
      }
      // 占用图：一眼看出哪儿挤、哪儿空
      const cols = 24, rows = Math.round(cols * B.h / B.w / 2), live = shown.filter(t => !(t.gone != null && t.gone < sc.t1 - 0.7) && !['mark', 'arrow', 'line'].includes(t.el.kind));
      let filled = 0; const map: string[] = [];
      for (let r0 = 0; r0 < rows; r0++) { let ln = ''; for (let c0 = 0; c0 < cols; c0++) { const cx = (c0 + 0.5) * B.w / cols, cy = (r0 + 0.5) * B.h / rows; const n = live.filter(t => { const b = t.el.solid; return cx >= b.x - 12 && cx <= b.x + b.w + 12 && cy >= b.y - 12 && cy <= b.y + b.h + 12; }).length; if (n) filled++; ln += n > 1 ? '▓' : n ? '█' : '·'; } map.push('    ' + ln); }
      console.log(`  场景结束时的占用（█ 有东西，▓ 叠着，· 空）：占了 ${Math.round(filled / (rows * cols) * 100)}%\n${map.join('\n')}`);
      const f = `${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png`;
      writeFileSync(join(out, f), await cv.encode('png'));
    }
    console.log(`\n✓ 线框图已输出到 ${out}（蓝=人和物 绿=文字 灰=批注 紫=形状 红虚线=标记 橙=箭头和连线；粗红框=有警告；橙色虚框=被引擎挪走前的位置）\n这不是画面，只是位置。它不需要用户确认，写分镜时随时跑。`);
  },

  async stills() {
    const dir = args[0] ?? die('用法：hj stills <项目目录> [--draft] [--scene 场景] [--at 秒数或口播片段] [--guides]');
    const c = load(dir);
    // --draft：给写分镜的人自己看的草稿。半分辨率、打水印、单独存放，不需要确认，也不能当作交付
    const draft = !!flags.draft, sc0 = draft ? 0.5 : 1;
    if (!draft) gate(c, 'plan');
    const out = join(dir, 'out', draft ? 'draft' : 'stills'); mkdirSync(out, { recursive: true });
    const { cv, ctx } = canvasFor(c, sc0);
    const stamp = draft ? textStrokes('草稿 · 未确认', { size: 54, color: '#d9433a' }) : null;
    const frame = (t: number, o: { pen: boolean; guides?: boolean }) => {
      drawFrame(ctx, c, t, env, { scale: sc0, subtitles: true, ...o });
      if (stamp) for (const [fx, fy] of [[0.5, 0.045], [0.5, 0.93]]) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.6; ctx.translate(cv.width * fx - (stamp.w * 0.7) / 2, cv.height * fy); ctx.scale(0.7, 0.7); drawStrokes(ctx, env, stamp.strokes); ctx.restore(); }
    };
    const shot = async (t: number, name: string) => { frame(t, { pen: !!c.meta.pen, guides: !!flags.guides }); writeFileSync(join(out, name), await cv.encode('png')); };
    if (flags.at != null) {
      const t = /^[\d.]+$/.test(String(flags.at)) ? +flags.at : resolveAnchor(c.al, String(flags.at)).time;
      await shot(t, `at-${t.toFixed(2)}.png`);
      console.log(`✓ ${join(out, `at-${t.toFixed(2)}.png`)}  （${fmtT(t)}）`);
      return;
    }
    const only = sceneArg(c);
    if (!only) for (const f of readdirSync(out)) if (/^(\d+-|sheet-)/.test(f)) rmSync(join(out, f));
    const sheets: string[] = [];
    for (const sc of c.scenes) {
      if (only && sc !== only) continue;
      const tiles: { t: number; label: string; file: string }[] = [];
      for (let bi = 0; bi < sc.beats.length; bi++) {
        const b = sc.beats[bi];
        const end = Math.max(b.t + 0.05, ...b.actions.map(a => a.t1));
        // 取这一拍“画完之后、下一拍之前”的一刻；场景最后一拍要避开转场镜头
        const cap = bi === sc.beats.length - 1 && c.scenes[sc.index + 1] ? sc.t1 - 0.7 : b.tEnd - 0.03;
        const t = Math.min(Math.max(b.t + 0.05, cap, Math.min(end + 0.03, sc.t1 - 0.7)), c.duration - 0.01);
        const file = `${String(sc.index + 1).padStart(2, '0')}-${sc.id}-${String(bi + 1).padStart(2, '0')}.png`;
        await shot(t, file);
        tiles.push({ t, label: `${sc.index + 1}.${bi + 1}  ${fmtT(t)}`, file });
      }
      if (!tiles.length) continue;
      // 联系表：一个场景一张，方便一眼看完
      const k = c.fmt.name === 'portrait' ? 0.3 : 0.34, cols = Math.min(tiles.length, c.fmt.name === 'portrait' ? 5 : 3), rows = Math.ceil(tiles.length / cols);
      const tw = Math.round(c.fmt.W * k), th = Math.round(c.fmt.H * k), pad = 16, cap = 44;
      const sheet = createCanvas(cols * (tw + pad) + pad, rows * (th + cap + pad) + pad), sx = sheet.getContext('2d');
      sx.fillStyle = '#e9ecef'; sx.fillRect(0, 0, sheet.width, sheet.height);
      for (let i = 0; i < tiles.length; i++) {
        const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + cap + pad);
        frame(tiles[i].t, { pen: false });
        sx.drawImage(cv, x, y + cap, tw, th);
        sx.strokeStyle = '#adb5bd'; sx.lineWidth = 1; sx.strokeRect(x + 0.5, y + cap + 0.5, tw, th);
        const lab = textStrokes(tiles[i].label, { size: 28, color: '#212529' });
        sx.save(); sx.translate(x + 4, y + 6);
        drawStrokes(sx, env, lab.strokes);
        sx.restore();
      }
      const sf = `sheet-${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png`;
      writeFileSync(join(out, sf), await sheet.encode('png')); sheets.push(sf);
    }
    if (draft) { console.log(`✓ 草稿关键帧已输出到 ${out}（半分辨率，带“草稿 · 未确认”水印）\n  每个场景一张联系表：${sheets.join('  ')}\n这是给你自己看的：逐张检查重叠、出界、难看、看不懂、和口播对不上，改到满意再把 storyboard.md 交给用户。\n草稿不是交付物：不要把它当作关键帧请用户确认，用户确认文字分镜之后再出正式关键帧（hj stills，不带 --draft）。`); return; }
    console.log(`✓ 关键帧已输出到 ${out}\n  每个场景一张联系表：${sheets.join('  ')}\n  每一拍的全尺寸图：<场景序号>-<场景>-<拍>.png`);
    console.log('先自己逐张看一遍（重叠、出界、难看、看不懂），改好后再交给用户确认关键帧。');
  },

  async render() {
    const dir = args[0] ?? die('用法：hj render <项目目录> [--scene 场景 | --from 秒 --to 秒] [--draft] [--out 文件]');
    const c = load(dir);
    gate(c, 'plan'); gate(c, 'keyframes');
    const only = sceneArg(c);
    const from = only ? Math.max(0, only.t0 - 0.6) : +(flags.from ?? 0), to = only ? only.t1 : +(flags.to ?? c.duration);
    const draft = !!flags.draft, scale = draft ? 0.5 : 1, fps = draft ? Math.min(15, c.fps) : c.fps;
    const outDir = join(dir, 'out'); mkdirSync(outDir, { recursive: true });
    const name = String(flags.out ?? join(outDir, `${only ? only.id : flags.from || flags.to ? `${from.toFixed(0)}-${to.toFixed(0)}` : 'video'}${draft ? '.draft' : ''}.mp4`));
    const { cv, ctx } = canvasFor(c, scale);
    const inputs: string[] = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cv.width}x${cv.height}`, '-r', String(fps), '-i', '-'];
    const audio = c.meta.audio ? join(dir, c.meta.audio) : '';
    const amix: string[] = [];
    if (audio && existsSync(audio)) { inputs.push('-ss', String(from), '-t', String(to - from), '-i', audio); amix.push(`[${amix.length + 1}:a]`); }
    else console.log('  （没有配音文件，成片只有落笔音效）');
    if (c.meta.sfx !== false) { const sfx = join(outDir, 'sfx.wav'); const r = writeSfx(c, sfx); console.log(`  音效：${r.mode === 'sparse' ? '稀疏' : '密集'}模式，全片 ${r.count} 声（平均每分钟 ${((r.count / c.duration) * 60).toFixed(0)} 声）`); inputs.push('-ss', String(from), '-t', String(to - from), '-i', sfx); amix.push(`[${amix.length + 1}:a]`); }
    const ff = ['-y', '-loglevel', 'error', ...inputs];
    if (amix.length > 1) ff.push('-filter_complex', `${amix.join('')}amix=inputs=${amix.length}:normalize=0[a]`, '-map', '0:v', '-map', '[a]');
    else if (amix.length === 1) ff.push('-map', '0:v', '-map', '1:a');
    ff.push('-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '26' : '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', name);
    const p = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('error', () => die('没有找到 ffmpeg，请先安装'));
    const done = new Promise<number>(r => p.on('close', code => r(code ?? 1)));
    const total = Math.round((to - from) * fps), started = Date.now();
    for (let i = 0; i < total; i++) {
      drawFrame(ctx, c, from + i / fps, env, { scale, subtitles: true, pen: !!c.meta.pen });
      if (!p.stdin.write(cv.data())) await new Promise(r => p.stdin.once('drain', r));
      if (i % (fps * 10) === 0 && i) console.log(`  ${fmtT(from + i / fps)} / ${fmtT(to)}  （${((i / total) * 100).toFixed(0)}%，已用 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
    }
    p.stdin.end();
    if ((await done) !== 0) die('ffmpeg 合成失败');
    console.log(`✓ ${name}  （${fmtT(from)}–${fmtT(to)}，${total} 帧，${((Date.now() - started) / 1000).toFixed(0)}s）`);
  },

  assets() {
    const what = args[0];
    if (what === 'icons') {
      const q = args.slice(1).join(' ') || die('用法：hj assets icons <英文关键词…>   例：hj assets icons money bag');
      const r = searchIcons(q, +(flags.limit ?? 40));
      if (!r.length) console.log('没有匹配的图标，换个英文近义词试试');
      for (const it of r) console.log(`${it.name.padEnd(30)} ${it.category.padEnd(14)} ${it.tags}`);
    } else if (what === 'doodles') {
      for (const d of doodleDirs(args[1])) for (const f of readdirSync(d).filter(f => f.endsWith('.yaml')).sort()) { const y = YAML.parse(readFileSync(join(d, f), 'utf8')); console.log(`${f.replace('.yaml', '').padEnd(18)} ${String(y.desc ?? '').padEnd(30)} ${y.vars ? '可调：' + Object.keys(y.vars).join(' ') : ''}`); }
    } else if (what === 'figure') {
      console.log('姿势 pose：' + Object.keys(POSES).join('  '));
      console.log('表情 face：' + Object.keys(FACES).filter(f => f !== 'none').join('  '));
      console.log('配饰 wear：' + ACCESSORIES.join('  '));
    } else if (what === 'colors') console.log(Object.entries(THEME.colors).map(([k, v]) => `${k} ${v}`).join('\n'));
    else if (what === 'sheet') return assetSheet();
    else die('用法：hj assets icons <关键词> | doodles [项目目录] | figure | colors | sheet [--out 文件] [--dir 手绘件目录]');
  },

  patterns() {
    const name = args[0];
    for (const [k, p] of Object.entries(PATTERNS)) {
      if (name && name !== k) continue;
      console.log(`■ ${k}  ${p.title}\n  什么时候用：${p.when}`);
      if (name) { console.log('  参数：'); for (const x of p.params) console.log('    ' + x); console.log('    area: [x, y, w, h]  只占画板的一部分（可省，默认整块画板），留出地方放自己的元素'); console.log('  步骤（在节拍的 do 里写 {step: 名字}）：'); for (const x of p.steps) console.log('    ' + x); }
      if (name) { // 附上一个能直接照着改的完整场景
        const ex = join(fileURLToPath(new URL('../../examples/patterns/scenes', import.meta.url)));
        const f = existsSync(ex) ? readdirSync(ex).find(x => x.includes('-' + k + '.')) : undefined;
        if (f) console.log(`  照着改的完整例子（examples/patterns/scenes/${f}）：\n\n` + readFileSync(join(ex, f), 'utf8').split('\n').map(l => '    ' + l).join('\n'));
      }
      console.log('');
    }
    if (!name) console.log('hj patterns <名字> 查看参数和步骤。九种手法的实际效果见 examples/patterns/');
    else if (!PATTERNS[name]) die(`没有叫 "${name}" 的手法。可用：${Object.keys(PATTERNS).join(' ')}`);
  },

  async import() {
    const usage = `用法：
  hj import excalidraw <素材库.excalidrawlib> --out <目录> [--only 名字,名字] [--prefix 前缀] [--text] [--source "出处"]
  hj import quickdraw <类别.ndjson> --sheet <候选图.png> [--count 48]          先出候选图，挑编号
  hj import quickdraw <类别.ndjson> --pick <编号> --name <名字> --out <目录> [--desc 说明] [--color 颜色]
导入的是几何形状，进来后由本项目的笔重新画；--out 一般是项目的 doodles/ 目录。导入前先核对素材的授权。`;
    const kind = args[0], file = args[1];
    if (!file || !existsSync(file)) die(usage);
    const im = await import('../core/importers');
    const save = (outDir: string, it: { name: string; doodle: any; skipped: string[] }) => {
      mkdirSync(outDir, { recursive: true });
      const f = join(outDir, it.name + '.yaml');
      if (existsSync(f) && !flags.force) { console.log(`- 跳过 ${it.name}：${f} 已存在（--force 覆盖）`); return; }
      writeFileSync(f, im.doodleYaml(it.doodle));
      console.log(`✓ ${it.name.padEnd(22)} ${it.doodle.parts.length} 个图形${it.skipped.length ? '  注意：' + it.skipped.join('；') : ''}`);
    };
    if (kind === 'excalidraw') {
      const outDir = flags.out ? String(flags.out) : die(usage);
      let items: any[];
      try { items = im.fromExcalidraw(JSON.parse(readFileSync(file, 'utf8')), { text: !!flags.text, source: flags.source ? String(flags.source) : undefined }); } catch (e: any) { return die(e.message); }
      const only = flags.only ? String(flags.only).split(',').map(s => s.trim()) : null;
      const miss = only?.filter(n => !items.some(i => i.name === n)) ?? [];
      if (miss.length) die(`素材库里没有：${miss.join(' ')}。可选：${items.map(i => i.name).join(' ')}`);
      for (const it of items) if (!only || only.includes(it.name)) save(outDir, { ...it, name: (flags.prefix ? String(flags.prefix) : '') + it.name });
      console.log(`\n看长相：hj assets sheet --dir ${outDir} --out sheet.png。不好看的直接删掉文件；名字、desc、颜色可以手改。`);
    } else if (kind === 'quickdraw') {
      const all = im.parseQuickDraw(readFileSync(file, 'utf8')).filter(d => d.recognized);
      if (!all.length) die('文件里没有可用的画（需要 Quick Draw 的 simplified .ndjson）');
      if (flags.sheet) {
        const n = Math.min(all.length, +(flags.count ?? 48));
        await drawSheet(all.slice(0, n).map((d, i) => { const it = im.fromQuickDraw(d); return { src: { parts: it.doodle.parts, box: it.doodle.box, size: 200, shade: false }, label: String(i + 1) }; }), String(flags.sheet));
        console.log(`✓ ${flags.sheet}：前 ${n} 张候选（共 ${all.length} 张）。挑一张，再跑 --pick <编号> --name <名字> --out <目录>`);
      } else if (flags.pick) {
        const d = all[+flags.pick - 1] ?? die(`没有第 ${flags.pick} 张（共 ${all.length} 张）`);
        save(flags.out ? String(flags.out) : die(usage), im.fromQuickDraw(d, { name: flags.name ? im.slug(String(flags.name)) : undefined, desc: flags.desc ? String(flags.desc) : undefined, color: flags.color ? String(flags.color) : undefined }));
      } else die(usage);
    } else die(usage);
  },
  'fake-align'() {
    const f = args[0] ?? die('用法：hj fake-align <口播稿.txt> [--cps 4.5] > alignment.json   （没有配音时先造一份匀速时间表打草稿）');
    process.stdout.write(JSON.stringify(fakeAlignment(readFileSync(f, 'utf8'), +(flags.cps ?? 4.5)), null, 1));
  },
};

/** 素材一览图：所有姿势、表情、手绘件画在一张图上，供挑选。--dir 只画某个目录里的手绘件 */
async function assetSheet() {
  const items: { src: any; label: string }[] = [];
  const only = flags.dir ? String(flags.dir) : null;
  if (!only) {
    for (const p of Object.keys(POSES)) items.push({ src: { figure: p, size: 230 }, label: p });
    for (const f of Object.keys(FACES).filter(f => f !== 'none')) items.push({ src: { figure: 'stand', face: f, size: 230 }, label: 'face:' + f });
    for (const a of ACCESSORIES) items.push({ src: { figure: 'stand', wear: [a], accent: 'blue', size: 230 }, label: 'wear:' + a });
  } else if (!existsSync(only)) die(`找不到目录：${only}`);
  for (const d of only ? [only] : doodleDirs()) for (const f of readdirSync(d).filter(f => f.endsWith('.yaml')).sort()) { const y = YAML.parse(readFileSync(join(d, f), 'utf8')); items.push({ src: { parts: y.parts, box: y.box, vars: undefined, size: 200 }, label: f.replace('.yaml', '') }); if (y.vars) (items[items.length - 1].src as any).__vars = y.vars; }
  const out = String(flags.out ?? 'assets-sheet.png');
  await drawSheet(items, out);
  console.log(`✓ ${out}`);
}
async function drawSheet(items: { src: any; label: string }[], out: string) {
  const { buildElement } = await import('../core/elements');
  const fmt = { ...FORMATS.landscape, board: { x: 0, y: 0, w: 100000, h: 100000 } };
  const els = new Map<string, any>(), ctxB = { scene: 'sheet', fmt, els };
  const built = items.map((it, i) => {
    const { __vars, vars, ...src } = it.src;
    // 带可调项的手绘件按默认值画
    const sub = (v: any): any => (typeof v === 'string' && v.startsWith('$') ? (__vars ?? {})[v.slice(1)] ?? '' : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
    return { el: buildElement(ctxB, 'i' + i, { ...sub(src), at: [0, 0] }), label: it.label };
  });
  const cols = 8, cw = 290, chh = 330, rows = Math.ceil(built.length / cols);
  const cv = createCanvas(cols * cw, rows * chh), ctx = cv.getContext('2d');
  ctx.fillStyle = THEME.paper; ctx.fillRect(0, 0, cv.width, cv.height);
  built.forEach((it, i) => {
    const x = (i % cols) * cw + cw / 2, y = Math.floor(i / cols) * chh + 140, b = it.el.box;
    ctx.save(); ctx.translate(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
    drawStrokes(ctx, env, it.el.strokes);
    ctx.restore(); ctx.globalAlpha = 1;
    const lab = textStrokes(it.label, { size: 26, color: '#495057' });
    ctx.save(); ctx.translate(x - lab.w / 2, Math.floor(i / cols) * chh + chh - 50);
    drawStrokes(ctx, env, lab.strokes);
    ctx.restore();
  });
  writeFileSync(out, await cv.encode('png'));
}

if (cmd === '--version' || cmd === '-v') { console.log(JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version); process.exit(0); }
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || !commands[cmd]) {
  console.log(`画讲 hj —— 把带时间表的口播做成“边画边讲”的手绘视频

  hj init <目录> --voice <配音材料>   建项目，导入时间表
  hj brief <目录>                     口播逐句时间简报（写分镜前先读）
  hj check <目录>                     编译 + 质量检查（随时跑，很快）
  hj layout <目录> [--scene x]        布局线框：每个元素最后落在哪儿（随时跑，不需要确认）
  hj plan <目录>                      生成文字分镜表 storyboard.md → 交用户确认
  hj approve <目录> plan|keyframes --by "<用户确认原话>"
  hj stills <目录> --draft            草稿关键帧：带水印、半分辨率，写分镜时自查用（不需要确认）
  hj stills <目录> [--scene x]        出关键帧（需先确认文字分镜）→ 交用户确认
  hj render <目录> [--scene x] [--draft]   渲染视频（需先确认关键帧）
  hj patterns [名字]                  表现手法：自带构图和动作编排的场景骨架
  hj assets doodles | figure | icons <关键词> | colors | sheet
  hj import excalidraw|quickdraw <文件>   把外部手绘素材转成手绘件
  hj fake-align <稿.txt>              没配音时造匀速时间表打草稿

完整工作流见 AGENTS.md`);
  process.exit(!cmd || ['--help', '-h', 'help'].includes(cmd) ? 0 : 1);
}
try { await commands[cmd](); }
catch (e: any) {
  // 走到这里说明是框架自己的缺陷，不是分镜写错了
  console.error(`✗ 框架内部错误：${e?.message ?? e}\n${String(e?.stack ?? '').split('\n').slice(1, 6).join('\n')}\n这不是你的分镜的问题。请带上这段信息和触发它的场景文件报告给维护者。`);
  process.exit(2);
}
