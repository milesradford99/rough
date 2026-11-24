// jj：剪讲命令行。agent 负责找素材和判断，jj 负责抓下来、记住、摆上时间线、渲染、检查。
// 流程：init → voice（hj voice）→ scaffold → 逐个镜头：grab / snap / look / hear / compare → check → board →（用户确认）→ render
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadProject, loadShots, saveShots, loadAssets, saveAssets, loadTried, saveTried, loadLibrary, approvals, approvalsFile, LICENSES, tierOf, type Shot } from './project';
import { scaffoldShots, timeShots, checkProject, printIssues, type Timed } from './shots';
import { grab, grabHd, remember, stockSearch } from './grab';
import { filmstrip, hear, probe, fmtTime } from './media';
import { compareSheet, boardReview, footageHash, cutSheet } from './sheets';
import { renderVideo } from './render';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string | true> = {};
const args: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v != null && !v.startsWith('--')) { flags[k] = v; i++; } else flags[k] = true; }
  else args.push(a);
}
const die = (msg: string): never => { console.error('✗ ' + msg); process.exit(1); };
const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
const num = (k: string) => (str(k) != null ? +str(k)! : undefined);

function ctx(dir: string) {
  let p; try { p = loadProject(dir); } catch (e: any) { return die(e.message); }
  if (!p.al) die(`还没有配音（${join(dir, 'voice', 'alignment.json')}）。先配音：jj voice ${dir} --engine edge`);
  const shots = loadShots(dir), assets = loadAssets(dir);
  return { p, shots, assets };
}

const HELP = `剪讲（jj）：素材剪辑式口播视频。agent 找素材、做判断；jj 抓取、记账、上时间线、渲染、检查。

开工
  jj init <目录> --script <口播稿.txt> | --from <画讲项目目录>   建项目（--from 连配音和附录一起拿过来）
  jj voice <目录> [--engine edge]           配音（就是 hj voice，参数一样；付费引擎要用户确认）
  jj scaffold <目录> [--pace fast|normal|calm]   按口播切镜头骨架，写 shots.yaml
       fast 平均 2.2 秒（快剪新闻）| normal 2.8 秒 | calm 4 秒左右（讲道理、放数据图）
  jj sync <目录>                            改了 at 之后，重算 say 和 dur
  jj status <目录> [镜头]                   整片进度；带镜头号时列出搜过什么、候选、否掉的

找素材（找什么、去哪儿找，你自己决定；先查库，再上网）
  jj library <关键词…>                      查跨项目的素材库（抓过的、否过的都在）
  jj stock <关键词> [--video] [--n 8] [--orientation portrait|landscape|any] [--site pexels|pixabay]
       搜 Pexels / Pixabay 的官方接口（云端不会被拦；要 PEXELS_API_KEY / PIXABAY_API_KEY）。搜到的页面网址直接 jj grab
  jj grab <目录> <网址|本地文件> [--as s07] [--note "…"]
       图片直链、视频页面（B站/YouTube 等，用 yt-dlp）、普通网页（截图+正文）都行；自动记来源和许可证
       --video 强制按视频抓   --page 强制按网页截图   本地文件可加 --license own|ai
       别处下好的文件（用户上传、自己电脑上下的）：jj grab <目录> <文件> --source-url <原网址>，许可证按原网址认
  jj grab <目录> --hd a031                  长视频先下的是低清版：选定片段后，只下镜头用到的那几秒高清版
  jj snap <目录> <网址> --find "页面上的原文" [--as s08]   截下这句原文所在的一屏，渲染时自动推近、高亮
  jj tried <目录> <镜头> "搜索词" [--where 网站] [--result "没找到 / 只有2023年的"]   记下搜过什么

看素材、挑素材
  jj look <目录> <素材> [--from 秒 --to 秒] [--n 帧数]   视频压成一张胶片条（带时间）；图片出预览
  jj hear <目录> <素材> [--find "加息"] [--lang zh] [--model small]   视频转带时间的文字（有平台字幕先用字幕）
  jj compare <目录> <镜头>                  这个镜头的所有候选拼成一张图，标出重复、太短、横屏、授权问题
  jj note <目录> <素材> [--purpose quote --why "评论的是什么"] [--note "…"] [--as s07]
  jj reject <目录> <素材> "为什么不用"      否掉（记进素材库，以后不会再被捡回来）

剪、看、交
  jj check <目录>                           时长、覆盖、锚点、授权、重复
  jj board <目录>                           故事板审片页 → 发给用户做“素材定稿”确认
  jj approve <目录> footage --by "<用户的确认原话>"
  jj preview <目录> [--from 秒 --to 秒] [--full]   草稿（带水印，不用确认），自己看节奏；--full 出全尺寸
  jj render <目录>                          成片 out/video.mp4 + 切点检查图 out/cuts.png

镜头单的字段：jj help shots`;

const HELP_SHOTS = `shots.yaml 的字段（每个镜头一项）

  id      镜头号（s01…）
  at      从口播的哪几个字开始（到下一个镜头的 at 为止）。原文，重复出现的写 "原文#2"
  say     只读：这一镜说的话        dur  只读：时长（秒）。改了 at 后 jj sync

  want    你想要什么画面（先写它，再去找）
  use     素材 id（a001…），或 title（金句卡：直接用这句口播排版），或 chart（数据图，数据写在 chart 里）
  from    视频素材从第几秒开始用（jj look / jj hear 找到的）
  fit     fill 裁满竖屏 | frame 整幅放中间、上下用模糊的同一画面垫底（横屏素材默认 frame）
  focus   fill 时保哪边：left | center | right | top | bottom，或 0..1
  crop    只用素材的一块：[左, 上, 宽, 高]（0..1 的比例）。切掉烧进去的字幕、水印，或者只要图表那块
  text    金句卡上的字（不写就用 say）
  pop     说到这几个字时弹出大字（必须是这一镜的原文）
  meme    { use: 素材, at: "原文", dur: 1, place: corner | center }  表情包
  cut     进入这个镜头的转场：cut 硬切（默认）| flash 闪白 | zoom 推近 | whip 甩
  layout  card 顶部标题条 + 中间一张卡片放画面 | full 铺满全屏。不写用 project.yaml 的 layout
  head    这一镜标题条的字（不写沿用上一镜；第一镜用 project.yaml 的 headline）。换话题时换一次
  chart   use: chart 时的数据：{ type: bar | line, title, unit, data: [[标签, 数值], …], highlight: 标签, note: 出处 }
          横条最多 8 条；note 必须写出处。数字一定要和口播、和出处对得上
  note    备注

镜头时长：静止画面超过 6 秒、视频和数据图超过 9 秒会提醒，超过 12 秒报错。
素材比镜头短：放慢（不低于 0.8 倍），再不够定格推近；够不到一半 jj check 报错。
图片自动缓慢推拉（相邻镜头方向交替）；jj snap 的截图说着说着推近到那句原文并画高亮框。`;

const commands: Record<string, () => Promise<void> | void> = {
  help() { console.log(args[0] === 'shots' ? HELP_SHOTS : HELP); },

  init() {
    const dir = args[0] ?? die('用法：jj init <目录> --script <口播稿.txt> | --from <画讲项目目录>');
    if (existsSync(join(dir, 'project.yaml'))) die(`${dir} 已经是一个项目了`);
    mkdirSync(join(dir, 'voice'), { recursive: true });
    const src = str('from');
    let title = str('title') ?? '';
    if (src) {
      if (!existsSync(join(src, 'project.yaml'))) die(`${src} 不是画讲项目（没有 project.yaml）`);
      const m = YAML.parse(readFileSync(join(src, 'project.yaml'), 'utf8')) ?? {};
      title ||= m.title ?? '';
      for (const f of ['script.txt', 'appendix.yaml']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dir, f));
      const al = join(src, m.voice ?? 'voice/alignment.json'), au = join(src, m.audio ?? 'voice/narration.wav');
      for (const [a, b] of [[al, 'alignment.json'], [au, 'narration.wav'], [join(src, 'voice', 'metadata.json'), 'metadata.json']]) if (existsSync(a)) copyFileSync(a, join(dir, 'voice', b));
      if (existsSync(join(src, 'approvals.json'))) { const ap = JSON.parse(readFileSync(join(src, 'approvals.json'), 'utf8')); if (ap.script) writeFileSync(approvalsFile(dir), JSON.stringify({ script: ap.script }, null, 2) + '\n'); }
    } else if (str('script')) copyFileSync(str('script')!, join(dir, 'script.txt'));
    else die('要给口播稿：--script <口播稿.txt>，或者从画讲项目拿：--from <目录>');
    const hasVoice = existsSync(join(dir, 'voice', 'alignment.json'));
    writeFileSync(join(dir, 'project.yaml'), `# 剪讲项目\nengine: jianjiang\ntitle: ${JSON.stringify(title || '未命名')}\nformat: portrait   # 竖屏 1080×1920\nfps: 30\nsubtitles: true\nlayout: card      # card：顶部标题条 + 中间卡片放画面；full：画面铺满全屏（每个镜头也可以单独写 layout）\nheadline: ${JSON.stringify(title || '未命名')}   # 标题条的字；镜头里写 head 换掉\naccent: "#e53935"\n${hasVoice ? 'voice: voice/alignment.json\naudio: voice/narration.wav\n' : ''}`);
    console.log(`✓ 建好了：${dir}\n下一步：${hasVoice ? `jj scaffold ${dir}` : `jj voice ${dir} --engine edge（免费配音；付费的火山引擎要用户先确认朗读稿）`}`);
  },

  voice() {
    const hj = fileURLToPath(new URL('../../bin/hj.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [hj, 'voice', ...process.argv.slice(3)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  },

  scaffold() {
    const dir = args[0] ?? die('用法：jj scaffold <目录>');
    const { p, shots } = ctx(dir);
    if (shots.length && !flags.force) die(`${join(dir, 'shots.yaml')} 已经有 ${shots.length} 个镜头了，里面有你写的决定。改了 at 用 jj sync；确实要从头切加 --force`);
    const pace = str('pace') ?? 'normal';
    if (!['fast', 'normal', 'calm'].includes(pace)) die('--pace 只能是 fast | normal | calm');
    const s = scaffoldShots(p.al!, p.duration, pace);
    saveShots(dir, s);
    const d = s.map(x => x.dur!);
    console.log(`✓ ${join(dir, 'shots.yaml')}：${s.length} 个镜头，${p.duration.toFixed(1)} 秒，平均 ${(p.duration / s.length).toFixed(1)} 秒（${Math.min(...d).toFixed(1)}–${Math.max(...d).toFixed(1)}）\n下一步：读稿子，给每个镜头写 want（想要什么画面），再去找。jj help shots 看字段`);
  },

  sync() {
    const dir = args[0] ?? die('用法：jj sync <目录>');
    const { p, shots } = ctx(dir);
    const issues: any[] = [];
    const timed = timeShots(p, shots, issues);
    const byId = new Map(timed.map(t => [t.id, t]));
    for (const s of shots) { const t = byId.get(s.id); if (t) { s.say = t.sayNow; s.dur = +(t.t1 - t.t0).toFixed(2); } }
    saveShots(dir, shots);
    if (issues.length) printIssues(issues); else console.log(`✓ 重算了 ${shots.length} 个镜头的 say 和 dur`);
  },

  status() {
    const dir = args[0] ?? die('用法：jj status <目录> [镜头]');
    const { p, shots, assets } = ctx(dir);
    const { issues, timed } = checkProject(p, shots, assets);
    const tried = loadTried(dir);
    if (args[1]) {
      const s = timed.find(x => x.id === args[1]) ?? die(`没有镜头 ${args[1]}`);
      console.log(`${s.id}  ${fmtTime(s.t0)}–${fmtTime(s.t1)}（${(s.t1 - s.t0).toFixed(1)} 秒）\n  口播：${s.sayNow}\n  想要：${s.want ?? '（没写）'}\n  选定：${s.use ?? '（没有）'}${s.from != null ? ` from ${s.from}` : ''}`);
      const t = tried.filter(x => x.shot === s.id);
      console.log(t.length ? `  搜过：\n${t.map(x => `    · "${x.q}"${x.where ? ` @${x.where}` : ''}${x.result ? ` → ${x.result}` : ''}`).join('\n')}` : '  搜过：（没记录。搜过的词用 jj tried 记下来，免得原地打转）');
      const c = Object.entries(assets).filter(([, a]) => a.for?.includes(s.id));
      console.log(c.length ? `  候选：\n${c.map(([id, a]) => `    ${a.rejected ? '✗' : '·'} ${id} ${a.kind} ${a.source.site ?? ''} ${LICENSES[a.source.license]?.name ?? ''}${a.note ? ` — ${a.note}` : ''}${a.rejected ? `（否：${a.rejected}）` : ''}`).join('\n')}` : '  候选：（没有）');
      for (const i of issues.filter(i => i.where === s.id)) console.log(`  ${i.level === 'error' ? '✗' : '!'} ${i.msg}`);
      return;
    }
    const chosen = timed.filter(s => s.use && s.use !== 'title' && s.use !== 'chart').length, titles = timed.filter(s => s.use === 'title').length, charts = timed.filter(s => s.use === 'chart').length, missing = timed.filter(s => !s.use);
    const licBad = [...new Set(issues.filter(i => i.level === 'error' && /purpose|许可证|授权/.test(i.msg)).map(i => i.where))];
    const errs = issues.filter(i => i.level === 'error').length, warns = issues.filter(i => i.level === 'warn').length;
    console.log(`${String(p.meta.title ?? dir)}：${timed.length} 个镜头，${p.duration.toFixed(0)} 秒\n  ${chosen} 个已选素材，${charts} 个数据图，${titles} 个用金句卡，${missing.length} 个还没找${missing.length ? `（${missing.slice(0, 12).map(s => s.id).join(' ')}${missing.length > 12 ? ' …' : ''}）` : ''}${licBad.length ? `，${licBad.length} 个授权有问题（${licBad.slice(0, 8).join(' ')}）` : ''}\n  台账 ${Object.keys(assets).length} 个素材（${Object.values(assets).filter(a => a.rejected).length} 个已否），搜索记录 ${tried.length} 条\n  检查：${errs} 个错误，${warns} 个警告（jj check ${dir}）`);
    const a = approvals(dir), h = footageHash(p, timed, assets);
    console.log(`  素材定稿：${a.footage?.hash === h ? '✓ 已确认' : a.footage ? '确认之后又改过，要重新确认' : '还没确认'}`);
    console.log(`下一步：${missing.length ? `给 ${missing[0].id} 找画面（jj status ${dir} ${missing[0].id}）` : errs ? `修掉错误（jj check ${dir}）` : a.footage?.hash !== h ? `jj board ${dir} → 发给用户确认素材` : `jj render ${dir}`}`);
  },

  async grab() {
    const dir = args[0] ?? die('用法：jj grab <目录> <网址|本地文件> [--as s07] [--note "…"]   或   jj grab <目录> --hd a031');
    if (!existsSync(join(dir, 'project.yaml'))) die(`${dir} 不是剪讲项目`);
    if (str('hd')) {
      const { p, shots, assets } = ctx(dir);
      const timed = timeShots(p, shots), id = str('hd')!;
      const ranges = timed.filter(s => s.use === id).map(s => [s.from ?? 0, (s.from ?? 0) + (s.t1 - s.t0)] as [number, number]);
      if (!ranges.length) die(`还没有镜头用 ${id}：先在 shots.yaml 里写 use: ${id} 和 from，再下高清片段`);
      void assets;
      try { const r = grabHd(dir, id, ranges); console.log(r.length ? `✓ 高清片段：\n${r.map(x => '  ' + x).join('\n')}` : '✓ 用到的片段都已经有高清版了'); } catch (e: any) { die(e.message); }
      return;
    }
    const url = args[1] ?? die('要给网址或本地文件');
    try {
      const r = await grab(dir, url, { as: str('as'), note: str('note'), video: !!flags.video, page: !!flags.page, license: str('license'), full: !!flags.full, sourceUrl: str('source-url') });
      const a = r.asset, lic = LICENSES[a.source.license];
      console.log(`${r.reused ? `✓ ${r.id}（${r.reused === 'project' ? '本项目里已经有了，没有重新下载' : '素材库里有，直接拷过来'}）` : `✓ ${r.id}`}  ${a.kind === 'video' ? `视频 ${a.duration}s` : a.kind === 'page' ? '网页截图' : '图片'} ${a.w ?? ''}×${a.h ?? ''} → ${a.file}`);
      console.log(`  来源：${a.source.title ?? ''}${a.source.author ? ` · ${a.source.author}` : ''} · ${a.source.site ?? ''}${a.source.published ? ` · ${a.source.published}` : ''}\n  许可证：${lic?.name ?? a.source.license}（${{ green: '可以直接用', yellow: '官方公开信息，写一下用途', red: '要用得写 purpose: quote 和 why', banned: '不能用' }[tierOf(a)]}）${a.for?.length ? `\n  候选给：${a.for.join(' ')}` : ''}`);
      for (const e of r.extra) console.log('  ' + e);
      console.log(`  看一眼：jj look ${dir} ${r.id}`);
    } catch (e: any) { die(e.message); }
  },

  stock() {
    const q = args.join(' ') || die('用法：jj stock <关键词> [--video] [--n 8] [--orientation portrait|landscape|any] [--site pexels|pixabay]   关键词用英文搜得更全');
    let r; try { r = stockSearch(q, { video: !!flags.video, n: num('n'), orientation: str('orientation'), site: str('site') }); } catch (e: any) { return die(e.message); }
    for (const sk of r.skipped) console.log(`! 跳过 ${sk}`);
    if (!r.hits.length) { console.log(r.skipped.length === 2 || (str('site') && r.skipped.length) ? '没有可用的图库密钥。' : `没搜到“${q}”。换个说法（英文更全），或者 --orientation any`); return; }
    console.log(`“${q}”：${r.hits.length} 个${flags.video ? '视频' : '图片'}（许可证：可以直接用）`);
    for (const h of r.hits) console.log(`  ${h.page}\n    ${h.site} · ${h.w}×${h.h}${h.h > h.w ? ' 竖' : ' 横'}${h.duration ? ` · ${h.duration}s` : ''}${h.author ? ` · ${h.author}` : ''}${h.title ? ` · ${String(h.title).slice(0, 50)}` : ''}`);
    console.log('  要哪个：jj grab <目录> <上面的页面网址> --as s07（直接用接口给的文件，作者和许可证自动记）');
  },

  async snap() {
    const dir = args[0], url = args[1];
    if (!dir || !url || !str('find')) die('用法：jj snap <目录> <网址> --find "页面上的原文" [--as s08] [--note "…"]');
    try {
      const r = await grab(dir, url, { find: str('find'), as: str('as'), note: str('note') });
      console.log(`✓ ${r.id}  截图 → ${r.asset.file}\n  原文位置：${r.asset.source.box?.join(', ')}（渲染时推近到这里并画高亮框）\n  许可证：${LICENSES[r.asset.source.license]?.name}\n  看一眼：jj look ${dir} ${r.id}`);
    } catch (e: any) { die(e.message); }
  },

  async look() {
    const dir = args[0], id = args[1];
    if (!dir || !id) die('用法：jj look <目录> <素材> [--from 秒 --to 秒] [--n 帧数]');
    const assets = loadAssets(dir), a = assets[id] ?? die(`台账里没有 ${id}`);
    const outDir = join(dir, 'out', 'look'); mkdirSync(outDir, { recursive: true });
    if (a.kind !== 'video') {
      console.log(`${id} 是${a.kind === 'page' ? '网页截图' : '图片'}（${a.w}×${a.h}），直接看文件：${resolve(dir, a.file)}${a.kind === 'page' ? `\n  页面正文：${resolve(dir, a.file.replace(/\.png$/, '.txt'))}` : ''}`);
      return;
    }
    const out = join(outDir, `${id}${str('from') || str('to') ? `-${str('from') ?? 0}-${str('to') ?? 'end'}` : ''}.png`);
    try {
      const ts = await filmstrip(join(dir, a.file), out, { from: num('from'), to: num('to'), n: num('n'), title: `${id} · ${a.source.title ?? ''}`.slice(0, 60) });
      console.log(`✓ 胶片条：${resolve(out)}（${ts.length} 帧，${fmtTime(ts[0])}–${fmtTime(ts[ts.length - 1])}）\n  打开这张图看。要细看某几秒：jj look ${dir} ${id} --from 10 --to 16`);
    } catch (e: any) { die(e.message); }
  },

  hear() {
    const dir = args[0], id = args[1];
    if (!dir || !id) die('用法：jj hear <目录> <素材> [--find "原文"] [--lang zh] [--model small]');
    const assets = loadAssets(dir), a = assets[id] ?? die(`台账里没有 ${id}`);
    if (a.kind !== 'video') die(`${id} 不是视频`);
    if (!probe(join(dir, a.file)).audio) die(`${id} 没有声音`);
    let r;
    try { r = hear(join(dir, a.file), join(dir, a.file.replace(/\.[^.]+$/, '.transcript.json')), { model: str('model'), lang: str('lang') }); } catch (e: any) { return die(e.message); }
    if (!a.transcript) { a.transcript = r.segs.map(s => s.text).join(' ').slice(0, 4000); saveAssets(dir, assets); remember(dir, id, a); }
    const find = str('find');
    const segs = find ? r.segs.filter(s => s.text.replace(/\s/g, '').toLowerCase().includes(find.replace(/\s/g, '').toLowerCase())) : r.segs;
    console.log(`${id} 的文字稿（${r.via}，${r.segs.length} 段）${find ? `里含“${find}”的 ${segs.length} 段` : ''}：`);
    for (const s of segs.slice(0, find ? 50 : 400)) console.log(`  [${fmtTime(s.start)} ${s.start.toFixed(1)}s] ${s.text}`);
    if (find && !segs.length) console.log('  （没找到。换个说法，或者去掉标点、只留关键词）');
  },

  async compare() {
    const dir = args[0], sid = args[1];
    if (!dir || !sid) die('用法：jj compare <目录> <镜头>');
    const { p, shots, assets } = ctx(dir);
    const timed = timeShots(p, shots);
    const s = timed.find(x => x.id === sid) ?? die(`没有镜头 ${sid}`);
    const out = join(dir, 'out', 'compare', `${sid}.png`);
    const r = await compareSheet(p, s, timed, assets, out);
    console.log(`✓ ${resolve(out)}（${r.ids.length} 个候选）`);
    for (const [id, f] of Object.entries(r.flags)) if (f.length) console.log(`  ${id}：${f.join('；')}`);
    console.log(`  选定后在 shots.yaml 里写 use${r.ids.some(i => assets[i].kind === 'video') ? ' 和 from' : ''}；不要的 jj reject ${dir} <素材> "理由"`);
  },

  note() {
    const dir = args[0], id = args[1];
    if (!dir || !id) die('用法：jj note <目录> <素材> [--purpose quote|licensed --why "…"] [--note "…"] [--as s07]');
    const assets = loadAssets(dir), a = assets[id] ?? die(`台账里没有 ${id}`);
    if (str('purpose')) { if (!['quote', 'licensed'].includes(str('purpose')!)) die('--purpose 只能是 quote（评论性引用）或 licensed（用户有授权）'); a.purpose = str('purpose') as any; }
    if (str('why')) a.why = str('why');
    if (a.purpose && !a.why) die('写 purpose 就要写 --why：评论的是什么、为什么非用这段不可');
    if (str('note')) a.note = str('note');
    if (str('as')) a.for = [...new Set([...(a.for ?? []), ...str('as')!.split(',')])];
    saveAssets(dir, assets); remember(dir, id, a);
    console.log(`✓ ${id}${a.purpose ? ` purpose: ${a.purpose}（${a.why}）` : ''}${a.note ? ` 备注：${a.note}` : ''}`);
  },

  reject() {
    const dir = args[0], id = args[1], why = args[2] ?? str('why');
    if (!dir || !id || !why) die('用法：jj reject <目录> <素材> "为什么不用"（比如“这是2023年的发布会”）');
    const assets = loadAssets(dir), a = assets[id] ?? die(`台账里没有 ${id}`);
    a.rejected = why; saveAssets(dir, assets); remember(dir, id, a);
    console.log(`✓ 否掉 ${id}：${why}（记进素材库，以后抓到同一个文件会提醒）`);
  },

  tried() {
    const dir = args[0], shot = args[1], q = args[2];
    if (!dir || !shot || !q) die('用法：jj tried <目录> <镜头> "搜索词" [--where 网站] [--result "结果"]');
    const t = loadTried(dir); t.push({ shot, q, ...(str('where') ? { where: str('where') } : {}), ...(str('result') ? { result: str('result') } : {}), at: new Date().toISOString() }); saveTried(dir, t);
    console.log(`✓ 记下了（${shot} 一共搜过 ${t.filter(x => x.shot === shot).length} 次）`);
  },

  library() {
    const terms = args.map(s => s.toLowerCase());
    if (args[0] === 'search') terms.shift();
    if (!terms.length) die('用法：jj library <关键词…>');
    const lib = loadLibrary();
    const hits = lib.filter(e => terms.every(t => [e.title, e.site, e.url, ...e.notes, e.transcript].join(' ').toLowerCase().includes(t)));
    console.log(`素材库 ${lib.length} 个素材，匹配 ${hits.length} 个：`);
    for (const e of hits.slice(0, 30)) console.log(`  ${e.rejected.length ? '✗' : '·'} ${e.kind} ${e.title ?? ''} · ${e.site ?? ''} · ${LICENSES[e.license]?.name ?? e.license}\n      ${e.url}${e.notes.length ? `\n      备注：${e.notes.join('；')}` : ''}${e.rejected.length ? `\n      否过：${e.rejected.join('；')}` : ''}`);
    if (hits.length) console.log('要用：jj grab <目录> <上面的网址>（素材库里有就直接拷，不重新下载）');
  },

  check() {
    const dir = args[0] ?? die('用法：jj check <目录>');
    const { p, shots, assets } = ctx(dir);
    const { issues } = checkProject(p, shots, assets);
    printIssues(issues);
    if (issues.some(i => i.level === 'error')) process.exit(1);
  },

  async board() {
    const dir = args[0] ?? die('用法：jj board <目录>');
    const { p, shots, assets } = ctx(dir);
    const { issues, timed } = checkProject(p, shots, assets);
    if (issues.some(i => i.level === 'error')) { printIssues(issues); die('还有错误，先修掉再出故事板（缺画面的镜头可以先用 use: title）'); }
    const r = await boardReview(p, timed, assets, issues);
    console.log(`■ 交给用户审（素材定稿，版本 ${r.hash}）：\n  长图   ${r.png}\n  审片页 ${r.html}（图都嵌在里面，一个文件）\n  必须让用户看到图：把长图或审片页作为文件发出来。用两三句话说清楚要用户决定什么（特别是标红的评论性引用）。\n  用户看过、表示同意后运行：jj approve ${dir} footage --by "<用户原话>"`);
  },

  approve() {
    const dir = args[0], stage = args[1];
    if (!dir || stage !== 'footage' || !str('by')) die('用法：jj approve <目录> footage --by "<用户的确认原话>"\n只有在用户看过这一版故事板、明确表示同意之后才能运行。');
    const { p, shots, assets } = ctx(dir);
    const { issues, timed } = checkProject(p, shots, assets);
    if (issues.some(i => i.level === 'error')) { printIssues(issues); die('还有错误，不能确认'); }
    const h = footageHash(p, timed, assets), rf = join(dir, 'out', 'review', 'footage.json');
    const seen = existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null;
    if (seen?.hash !== h) die(`${seen ? `故事板是旧的（它是 ${seen.hash} 那一版，现在是 ${h}）` : '这一版还没有出故事板'}，用户不可能看过现在这一版。先 jj board ${dir}，发给用户看，再来确认`);
    const a = approvals(dir); a.footage = { hash: h, by: str('by'), at: new Date().toISOString() };
    writeFileSync(approvalsFile(dir), JSON.stringify(a, null, 2) + '\n');
    console.log(`✓ 已记录用户对素材定稿的确认（版本 ${h}）。下一步：jj render ${dir}`);
  },

  async preview() { await render(true); },
  async render() { await render(!!flags.draft); },
};

async function render(draft: boolean) {
  const dir = args[0] ?? die(`用法：jj ${draft ? 'preview' : 'render'} <目录> [--from 秒 --to 秒]`);
  const { p, shots, assets } = ctx(dir);
  const { issues, timed } = checkProject(p, shots, assets);
  const errors = issues.filter(i => i.level === 'error');
  if (!draft) {
    if (errors.length) { printIssues(issues); die('还有错误，不能出成片。想先看看：jj preview（草稿，缺画面的地方会标出来）'); }
    const a = approvals(dir), h = footageHash(p, timed, assets);
    if (a.footage?.hash !== h) die(`${a.footage ? '素材定稿确认之后又改过（换了素材、挪了起点或时间）' : '素材还没有定稿'}。先 jj board ${dir} 出故事板发给用户；用户确认后 jj approve ${dir} footage --by "<用户原话>"。\n  想先自己看：jj preview ${dir}（草稿，不用确认）`);
  } else if (errors.length) console.log(`（有 ${errors.length} 个错误，草稿照出：缺画面的镜头显示成灰卡）`);
  if (!timed.length) die('没有能解析的镜头');
  const from = num('from'), to = num('to');
  const out = str('out') ?? join(dir, 'out', `${draft ? 'preview' : 'video'}${from != null || to != null ? `-${from ?? 0}-${to ?? 'end'}` : ''}.mp4`);
  console.log(`开始渲染${draft ? (flags.full ? '草稿（全尺寸，带水印）' : '草稿（540×960，15 帧/秒）') : '成片（1080×1920）'}：${timed.length} 个镜头…`);
  const r = await renderVideo(p, timed as Timed[], assets, { out, draft, full: !!flags.full, from, to });
  console.log(`✓ ${resolve(r.file)}（${r.frames} 帧，用了 ${r.seconds.toFixed(0)} 秒）`);
  if (!draft && r.cuts.length) {
    const cf = join(dir, 'out', 'cuts.png');
    const bad = await cutSheet(r.file, r.cuts, cf);
    console.log(`  切点检查图：${resolve(cf)}${bad.length ? `\n  ! 这些切点有黑帧：${bad.join(' ')}` : '（没发现黑帧）'}\n  自己先看一遍切点图，再把成片发给用户（发文件，不是路径）`);
  }
}

const fn = commands[cmd ?? 'help'];
if (!fn) die(`不认识的命令 "${cmd}"。jj help 看全部命令`);
Promise.resolve(fn()).catch(e => die(e?.stack ?? String(e)));
export type { Shot };
