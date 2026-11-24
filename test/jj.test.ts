// 剪讲（jj）：镜头骨架、台账封签、授权检查、素材定稿闸门、渲染。都不联网：素材用 ffmpeg 现做的本地文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import YAML from 'yaml';
import { fakeAlignment, loadAlignment } from '../src/core/alignment';
import { scaffoldShots, MIN_DUR, MAX_DUR, videoPlan, PACES } from '../src/jj/shots';
import { licenseFromText } from '../src/jj/grab';
import { parseSubs } from '../src/jj/media';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const SCRIPT = '你被黄金套住了吗？你的成本价是多少？历史上，黄金这样的大跌有过好几次。答案，就藏在这几次里。像这样股市一崩、黄金被拿去换现金的，过去二十年至少七次。快的几天就见底，慢的三个月左右。这一次从高点算，跌了三成七，比哪一次都深，而且还没停。';

function project(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jj-')), src = join(root, 'src'), dir = join(root, 'proj');
  mkdirSync(join(src, 'voice'), { recursive: true });
  const al = fakeAlignment(SCRIPT);
  writeFileSync(join(src, 'voice', 'alignment.json'), JSON.stringify(al));
  writeFileSync(join(src, 'script.txt'), SCRIPT);
  if (hasFfmpeg) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(al.duration_seconds), join(src, 'voice', 'narration.wav')]);
  writeFileSync(join(src, 'project.yaml'), 'title: 测试\nvoice: voice/alignment.json\naudio: voice/narration.wav\n');
  const env = { ...process.env, JJ_HOME: join(root, 'home'), ...extraEnv };
  const jj = (...a: string[]) => spawnSync(process.execPath, ['bin/jj.mjs', ...a], { encoding: 'utf8', env });
  assert.equal(jj('init', dir, '--from', src).status, 0);
  return { root, dir, jj, al };
}
const shotsOf = (dir: string) => YAML.parse(readFileSync(join(dir, 'shots.yaml'), 'utf8'));
const setShots = (dir: string, f: (s: any[]) => void) => { const s = shotsOf(dir); f(s); writeFileSync(join(dir, 'shots.yaml'), YAML.stringify(s)); };

test('镜头骨架：每个镜头 1.2–4 秒，切点落在标点上，锚点唯一', () => {
  const al = loadAlignmentFrom(fakeAlignment(SCRIPT));
  const shots = scaffoldShots(al, al.duration);
  assert.ok(shots.length >= 8);
  for (const s of shots.slice(0, -1)) { assert.ok(s.dur! >= MIN_DUR - 0.01 && s.dur! <= MAX_DUR + 0.01, `${s.id} ${s.dur}`); assert.match(s.say!, /[，。？！、]$/, `${s.id} 切在了句子中间：${s.say}`); }
  assert.equal(shots.map(s => s.say).join(''), al.units.map(u => u.display).join(''));
});
function loadAlignmentFrom(j: any) { const d = mkdtempSync(join(tmpdir(), 'jj-al-')); writeFileSync(join(d, 'a.json'), JSON.stringify(j)); return loadAlignment(join(d, 'a.json')); }

test('认许可证：CC 的各种写法', () => {
  assert.equal(licenseFromText('CC BY-SA 4.0'), 'cc-by-sa');
  assert.equal(licenseFromText('Creative Commons Attribution-NonCommercial 2.0'), 'cc-nc');
  assert.equal(licenseFromText('https://creativecommons.org/licenses/by-nd/4.0/'), 'cc-nd');
  assert.equal(licenseFromText('Public domain'), 'pd');
  assert.equal(licenseFromText('CC0'), 'cc0');
  assert.equal(licenseFromText('Standard YouTube License'), null);
});

test('素材比镜头短：先放慢，再定格', () => {
  assert.deepEqual(videoPlan({ duration: 10 } as any, 2, 3), { speed: 1, freeze: 0, cover: 1 });
  assert.ok(Math.abs(videoPlan({ duration: 10 } as any, 7.5, 3).speed - 2.5 / 3) < 1e-9);
  const p = videoPlan({ duration: 10 } as any, 8, 3);
  assert.equal(p.speed, 0.8); assert.ok(p.freeze > 0);
});

test('平台字幕解析', () => {
  const s = parseSubs('1\n00:00:01,000 --> 00:00:02,500\n加息25个基点\n\n2\n00:00:03.000 --> 00:00:04.000\n<c>美联储</c>宣布\n');
  assert.deepEqual(s.map(x => [x.start, x.text]), [[1, '加息25个基点'], [3, '美联储宣布']]);
});

test('jj：骨架 → 缺画面报错 → 本地素材入库 → 授权和封签检查', { skip: !hasFfmpeg }, () => {
  const { root, dir, jj } = project();
  assert.equal(jj('scaffold', dir).status, 0);
  assert.notEqual(jj('scaffold', dir).status, 0, '已有镜头单时不能覆盖');
  let r = jj('check', dir);
  assert.notEqual(r.status, 0); assert.match(r.stdout, /还没有选画面/);
  // 本地素材：授权未知
  const img = join(root, 'pic.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1', img]);
  r = jj('grab', dir, img, '--as', 's01');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /a001/);
  assert.notEqual(jj('grab', dir, img, '--license', 'cc0').status, 0, '本地文件不能自称 CC0');
  r = jj('grab', dir, img); assert.match(r.stdout, /已经有了|一模一样/, '同一个文件不重复入库');
  setShots(dir, s => s.forEach((x: any) => (x.use = 'title')));
  setShots(dir, s => { s[0].use = 'a001'; });
  r = jj('check', dir);
  assert.notEqual(r.status, 0); assert.match(r.stdout, /授权未知[\s\S]*purpose: quote/);
  assert.equal(jj('note', dir, 'a001', '--purpose', 'quote', '--why', '测试：评论这张图').status, 0);
  r = jj('check', dir); assert.doesNotMatch(r.stdout, /✗/, r.stdout);
  // 手改来源：签对不上
  const assets = readFileSync(join(dir, 'assets.yaml'), 'utf8');
  writeFileSync(join(dir, 'assets.yaml'), assets.replace('license: unknown', 'license: cc0'));
  r = jj('check', dir); assert.match(r.stdout, /签对不上/);
  writeFileSync(join(dir, 'assets.yaml'), assets);
  // 弹字必须是这一镜的原文
  setShots(dir, s => { s[1].pop = '不存在的话'; });
  r = jj('check', dir); assert.match(r.stdout, /pop "不存在的话" 不是这一镜里说的话/);
});

test('jj：素材定稿闸门：没出故事板不能确认，改了素材要重新确认；渲染出片', { skip: !hasFfmpeg }, () => {
  const { root, dir, jj, al } = project();
  jj('scaffold', dir);
  const vid = join(root, 'clip.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-pix_fmt', 'yuv420p', vid]);
  assert.equal(jj('grab', dir, vid, '--license', 'own', '--as', 's02').status, 0);
  setShots(dir, s => s.forEach((x: any, i: number) => { x.use = i === 1 ? 'a001' : 'title'; if (i === 1) x.from = 0.5; }));
  assert.match(jj('render', dir).stderr, /素材还没有定稿/);
  assert.match(jj('approve', dir, 'footage', '--by', '确认').stderr, /还没有出故事板/);
  let r = jj('board', dir); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(dir, 'out', 'review', 'footage.html')));
  assert.equal(jj('approve', dir, 'footage', '--by', '确认').status, 0);
  setShots(dir, s => { s[1].from = 1; });
  assert.match(jj('render', dir).stderr, /确认之后又改过/);
  jj('board', dir); jj('approve', dir, 'footage', '--by', '确认');
  r = jj('render', dir, '--to', '6');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = join(dir, 'out', 'video-0-6.mp4');
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert.ok(Math.abs(d - 6) < 0.3, `时长 ${d}`);
  const wh = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();
  assert.equal(wh, '1080,1920');
  assert.ok(existsSync(join(dir, 'out', 'cuts.png')));
  void al;
});

test('镜头节奏：--pace calm 切得更长，fast 切得更短', () => {
  const al = loadAlignmentFrom(fakeAlignment(SCRIPT));
  const avg = (p: string) => { const s = scaffoldShots(al, al.duration, p); return al.duration / s.length; };
  assert.ok(avg('calm') > avg('normal') && avg('normal') > avg('fast'), `${avg('fast')} ${avg('normal')} ${avg('calm')}`);
  for (const s of scaffoldShots(al, al.duration, 'calm').slice(0, -1)) assert.ok(s.dur! <= PACES.calm.max + 0.01, `${s.id} ${s.dur}`);
});

test('jj：数据图要有数据和出处；图库接口搜到的直接抓；上传的文件记声明的出处', { skip: !hasFfmpeg }, async () => {
  // 本地模拟 Pexels 接口：返回一张图，图片也由它提供
  const srvRoot = mkdtempSync(join(tmpdir(), 'jj-stock-'));
  const img = join(srvRoot, 'p.jpg');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920', '-frames:v', '1', img]);
  const srv = spawn(process.execPath, ['-e', `
    const http = require('http'), fs = require('fs');
    const s = http.createServer((q, r) => {
      const base = 'http://127.0.0.1:' + s.address().port;
      if (q.url.startsWith('/v1/search')) { if (q.headers.authorization !== 'k1') { r.writeHead(401); return r.end('{}'); } r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ photos: [{ id: 7, width: 1080, height: 1920, url: 'https://www.pexels.com/photo/gold-bars-7/', photographer: '摄影师甲', alt: 'gold bars', src: { original: base + '/p.jpg' } }] })); }
      if (q.url === '/p.jpg') { r.setHeader('content-type', 'image/jpeg'); return r.end(fs.readFileSync(${JSON.stringify(img)})); }
      r.writeHead(404); r.end();
    }).listen(0, '127.0.0.1', () => console.log('ready ' + s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>(ok => srv.stdout!.on('data', (d: Buffer) => { const m = String(d).match(/ready (\d+)/); if (m) ok(+m[1]); }));
  try {
    const { root, dir, jj } = project({ PEXELS_API_KEY: 'k1', JJ_PEXELS_API: `http://127.0.0.1:${port}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
    assert.match(readFileSync(join(dir, 'project.yaml'), 'utf8'), /layout: card/);
    jj('scaffold', dir);
    let r = jj('stock', 'gold bars', '--site', 'pexels');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pexels\.com\/photo\/gold-bars-7/);
    r = jj('grab', dir, 'https://www.pexels.com/photo/gold-bars-7/', '--as', 's01');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Pexels 许可/); assert.match(r.stdout, /摄影师甲/);
    // 上传的文件：许可证按声明的出处认，check 提醒出处是声明的
    const up = join(root, 'up.png');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', up]);
    assert.notEqual(jj('grab', dir, up, '--source-url', 'https://pixabay.com/x/', '--license', 'own').status, 0);
    r = jj('grab', dir, up, '--source-url', 'https://pixabay.com/photos/coins-123/');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /a002/); assert.match(r.stdout, /Pixabay 许可/);
    setShots(dir, s => s.forEach((x: any, i: number) => { x.use = i === 0 ? 'a001' : i === 1 ? 'a002' : 'title'; }));
    setShots(dir, s => { s[2].use = 'chart'; s[2].chart = { data: [['中国', 5.2]] }; s[3].head = '黄金跌了多少'; });
    r = jj('check', dir);
    assert.match(r.stdout, /chart\.data 至少两项/); assert.match(r.stdout, /a002 是上传的文件/);
    setShots(dir, s => { s[2].chart = { data: [['中国', 5.2], ['美国', 2.5]], highlight: '日本', unit: '%' }; });
    r = jj('check', dir); assert.match(r.stdout, /highlight "日本"/); assert.match(r.stdout, /chart\.note/);
    setShots(dir, s => { s[2].chart = { data: [['中国', 5.2], ['美国', 2.5]], highlight: '中国', unit: '%', note: '来源：测试' }; });
    r = jj('check', dir); assert.doesNotMatch(r.stdout, /✗/, r.stdout);
    r = jj('board', dir); assert.equal(r.status, 0, r.stdout + r.stderr);
    const html = readFileSync(join(dir, 'out', 'review', 'footage.html'), 'utf8');
    assert.match(html, /数据图/); assert.match(html, /上传·出处待确认/);
  } finally { srv.kill(); }
});

test('不裁画面：横图放进卡片会裁掉多少；超过一成默认整幅放', async () => {
  const { fillLoss, CARD } = await import('../src/jj/project');
  assert.ok(fillLoss({ w: 2400, h: 1600 }, undefined, CARD.w, CARD.h) > 0.2, '3:2 的图裁满卡片要丢两成多');
  assert.ok(fillLoss({ w: 1000, h: 860 }, undefined, CARD.w, CARD.h) < 0.01);
  assert.ok(fillLoss({ w: 1080, h: 1920 }, [0, 0, 1, 0.5], 1080, 1920) > 0.4);
});
