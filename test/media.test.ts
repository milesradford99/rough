// 图片 / 视频元素、片尾附录、连线看完整的镜头、看得清的计划审片页。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { fakeAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';
import { drawFrame, camAt, clipIndex } from '../src/core/render';
import { buildElement } from '../src/core/elements';
import { FORMATS } from '../src/core/theme';
import { loadAppendix, appendixOffset, appendixTiming, wrapText } from '../src/core/appendix';
import { loadPlan } from '../src/core/plan';

const hj = (args: string[]) => spawnSync(process.execPath, ['bin/hj.mjs', ...args], { encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'hj-media-'));
const png = (w: number, h: number, col = '#3b6fb6') => { const cv = createCanvas(w, h), g = cv.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, w, h); return cv.toBuffer('image/png'); };
const video = (file: string, sec: number) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=25:duration=${sec}`, '-pix_fmt', 'yuv420p', file]).status === 0;

const APPENDIX = `title: 1993–2026 关键事件
note: 持股比例按当年披露口径
items:
  - { when: "1993.04", tag: "33.3%", title: 三人各出资创办英伟达, text: 黄仁勋、马拉科夫斯基、普里姆各占三分之一 }
  - { when: "1999.01", tag: "约 10%", color: red, title: 纳斯达克上市, text: 发行价 12 美元（上市前经历两轮稀释） }
  - { when: "2026", color: gray, title: 持股约 3.5% }
`;

test('图片元素：照片有白边和胶带，头像裁成圆的方框，文件不存在要说清楚', () => {
  const d = tmp(); mkdirSync(join(d, 'media'));
  writeFileSync(join(d, 'media/a.png'), png(400, 200));
  const mk = (src: any) => buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map(), projectDir: d } as any, 'e', src);
  const pic = (el: any) => el.strokes.find((s: any) => s.kind === 'image');
  const plain = mk({ image: 'media/a.png', size: 300, at: [400, 400] }), photo = mk({ image: 'media/a.png', size: 300, at: [400, 400], style: 'photo' }), avatar = mk({ image: 'media/a.png', size: 200, at: [400, 400], style: 'avatar' });
  assert.ok(Math.abs(plain.box.h - 150) < 30, '贴图按原比例');
  assert.ok(pic(photo).pic.w < photo.box.w && pic(photo).pic.x > 0, '照片四周留白边');
  assert.ok(photo.strokes.length > plain.strokes.length, '照片多一截胶带');
  assert.ok(pic(avatar).round, '头像是圆的');
  assert.ok(Math.abs(avatar.box.w - avatar.box.h) < 12, '头像是方框');
  const cr = pic(avatar).crop;
  assert.ok(cr && Math.abs(cr.w - cr.h) < 1 && cr.x > 0, '头像从长方形的原图中间裁一个正方形');
  assert.throws(() => mk({ image: 'media/none.png', at: [0, 0] }), /找不到图片 media\/none\.png/);
  assert.throws(() => mk({ image: 'media/a.png', at: [0, 0], style: 'fancy' }), /style 只能是/);
  rmSync(d, { recursive: true });
});

test('视频元素：取其中几秒，最多 20 秒，画完才开始播', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
  const d = tmp(); mkdirSync(join(d, 'media'));
  assert.ok(video(join(d, 'media/long.mp4'), 24));
  const mk = (src: any) => buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map(), projectDir: d } as any, 'e', src);
  assert.throws(() => mk({ video: 'media/long.mp4', at: [400, 400] }), /最多播 20 秒/);
  assert.throws(() => mk({ video: 'media/long.mp4', at: [400, 400], from: 5, to: 3 }), /to 要大于 from/);
  assert.throws(() => mk({ video: 'media/none.mp4', at: [400, 400] }), /找不到视频/);
  writeFileSync(join(d, 'media/bad.mp4'), 'not a video');
  assert.throws(() => mk({ video: 'media/bad.mp4', at: [400, 400] }), /读不出/);
  const el = mk({ video: 'media/long.mp4', at: [400, 400], size: 320, from: 2, to: 6 }), clip = (el.strokes.find((s: any) => s.kind === 'image') as any).clip;
  assert.equal(clip.n, 100); assert.equal(clip.from, 2);
  assert.ok(Math.abs(el.box.h / el.box.w - 180 / 320) < 0.12, '按视频的比例');
  // 播放：没画完停在第一帧；循环；不循环就停在最后一帧
  assert.equal(clipIndex(clip, -1), 0);
  assert.equal(clipIndex(clip, 1), 25);
  assert.equal(clipIndex(clip, 4.4), 10, '循环');
  assert.equal(clipIndex({ ...clip, loop: false }, 9), 99, '不循环：停在最后一帧');
  rmSync(d, { recursive: true });
});

test('附录：只写内容；写错的字段拦住；折行不拆数字、标点不落行首', () => {
  const d = tmp();
  assert.equal(loadAppendix(d).appendix, null, '没有文件就是没有附录');
  writeFileSync(join(d, 'appendix.yaml'), APPENDIX);
  const ok = loadAppendix(d);
  assert.equal(ok.issues.length, 0);
  assert.equal(ok.appendix!.sections[0].items.length, 3);
  writeFileSync(join(d, 'appendix.yaml'), 'title: 时间线\nfontSize: 30\nitems:\n  - { when: "1993", title: 创办, x: 100 }\n  - { title: 上市, color: pink }\n  - { text: 没有标题 }\n');
  const bad = loadAppendix(d).issues.filter(i => i.level === 'error').map(i => i.msg).join('\n');
  assert.match(bad, /不认识字段 "fontSize"/); assert.match(bad, /不认识字段 "x"/); assert.match(bad, /color 只能是/); assert.match(bad, /缺 title/);
  writeFileSync(join(d, 'appendix.yaml'), 'title: 时间线\nitems: []\n');
  assert.match(loadAppendix(d).issues[0].msg, /缺 items/);
  writeFileSync(join(d, 'appendix.yaml'), `title: 时间线\nitems:\n  - { title: 一条, text: ${'很长的说明'.repeat(30)} }\n`);
  assert.match(loadAppendix(d).issues.find(i => i.level === 'warn')!.msg, /滚动时读不完/);
  rmSync(d, { recursive: true });

  const lines = wrapText('发行价 12 美元，市值约 6.26 亿美元（上市前经历两轮稀释）。', 40, 330);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(''), '发行价 12 美元，市值约 6.26 亿美元（上市前经历两轮稀释）。'.replace(/ (?=[^\dA-Za-z])/g, m => m), '不丢字');
  for (const l of lines) { assert.doesNotMatch(l, /^[，。）]/, '标点不落行首'); assert.doesNotMatch(l, /[（]$/, '开括号不留行尾'); }
  assert.ok(!lines.some(l => /6\.$/.test(l) || /^26/.test(l)), '数字不拆开');

  // 梯形速度：从零起步、匀速、到底停住，全程不倒退
  const { scroll } = appendixTiming(2000, 170, 0);
  assert.equal(appendixOffset(0, 2000, 170), 0);
  assert.ok(Math.abs(appendixOffset(scroll, 2000, 170) - 2000) < 1e-6);
  let prev = 0;
  for (let u = 0; u <= scroll; u += 0.1) { const o = appendixOffset(u, 2000, 170); assert.ok(o >= prev - 1e-9 && o - prev <= 17.5); prev = o; }
});

test('附录接在正片后面：同一张纸往下滚，总时长变长，改了附录确认就失效', () => {
  const d = tmp(); mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment('先画一个工厂。再画一个银行。')));
  writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\n');
  writeFileSync(join(d, 'scenes/01.yaml'), 'from: "先画"\nintent: 两样东西\nelements:\n  a: { doodle: factory, size: 300, at: [170, 170] }\n  b: { doodle: bank, size: 300, at: [790, 1080] }\nbeats:\n  - { at: "先画", intent: 画, do: [{ draw: [a, b] }] }\n');
  const plain = compile(d);
  assert.equal(plain.total, plain.duration); assert.equal(plain.appendix, undefined);
  writeFileSync(join(d, 'appendix.yaml'), APPENDIX);
  const c = compile(d), ap = c.appendix!;
  assert.ok(ap && c.total > c.duration + 3);
  assert.equal(ap.t0, c.duration);
  assert.notEqual(c.planHash, plain.planHash, '附录是内容的一部分：改了要重新确认');
  const fmt = c.fmt, last = c.scenes[c.scenes.length - 1].home;
  assert.ok(ap.y >= last.cy + fmt.H / last.zoom / 2, '排在最后一块板的下面，不压住板书');
  // 镜头：开始时还在最后的全景，结束时最后一行已经滚进画面，中间只往下走
  const c0 = camAt(c, c.duration), c1 = camAt(c, c.total);
  assert.ok(Math.abs(c0.cy - last.cy) < 1);
  assert.equal(c1.zoom, 1);
  assert.ok(c1.cy + fmt.H / 2 >= ap.y + ap.layout.height, '滚到底能看到最后一条');
  let prev = c0.cy;
  for (let t = c.duration; t <= c.total; t += 0.2) { const cy = camAt(c, t).cy; assert.ok(cy >= prev - 1e-6); prev = cy; }
  // 画得出来，而且真的画了字（附录那一屏不是空白纸）
  const cv = createCanvas(fmt.W / 4, fmt.H / 4), g = cv.getContext('2d');
  drawFrame(g as any, c, c.total - 0.5, { createCanvas, Path2D } as any, { scale: 0.25 });
  const px = g.getImageData(0, 0, cv.width, cv.height).data; let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 380) dark++;
  assert.ok(dark > 200, `附录画面上有字（${dark}）`);
  // 指定总时长；滚得太快要提醒
  writeFileSync(join(d, 'appendix.yaml'), APPENDIX + 'seconds: 12\n');
  const fixed = compile(d);
  assert.ok(Math.abs(fixed.total - fixed.duration - 12) < 1.2);
  writeFileSync(join(d, 'appendix.yaml'), APPENDIX + 'seconds: 3\n');
  assert.ok(compile(d).issues.some(i => /滚得太快/.test(i.msg)));
  // 附录写错：不出附录，check 报错
  writeFileSync(join(d, 'appendix.yaml'), 'title: 时间线\nitems:\n  - { text: 没有标题 }\n');
  const bad = compile(d);
  assert.equal(bad.appendix, undefined);
  assert.ok(bad.issues.some(i => i.level === 'error' && /缺 title/.test(i.msg)));
  rmSync(d, { recursive: true });
});

const SCRIPT = '公司交一百块税。政府发给你。你又花回公司。转了一圈，一分没多赚。所以这笔钱，谁也没有多出来。';
const PLAN = `thesis: 税、补贴、消费转了一圈，谁也没有多赚一分钱
cast:
  co:  { name: 公司, look: { image: media/co.png, style: photo } }
  gov: { name: 政府, look: { doodle: gov } }
  me:  { name: 你,   look: { figure: stand } }
relations:
  tax:   { from: co, to: gov, label: 交税 }
  give:  { from: gov, to: me, label: 发钱 }
  spend: { from: me, to: co, label: 消费 }
boards:
  - id: loop
    picture: 公司、政府、你站成一个三角，三条箭头首尾相接成一个圈，圈中间写着结论 +0
    grid:
      areas:
        - [up, up]
        - [left, right]
    regions: { up: 公司和政府, left: 你, right: 结论 }
    segments:
      - { at: "公司交一百块税", act: 例子, in: up, show: [co, gov], link: [tax], words: ["100"], intent: 公司把一百块交给政府 }
      - { at: "政府发给你", act: 例子, in: left, show: [me], link: [give], intent: 政府把钱发给你 }
      - { at: "你又花回公司", act: 例子, in: left, link: [spend], intent: 你把钱花回公司，圈闭合 }
      - { at: "一分没多赚", act: 结论, in: right, revisit: [co], words: ["+0"], intent: 回到公司身上圈一下：它没有多赚 }
`;

test('计划里的真实影像和附录：缺文件拦住；审片页逐段有图有字，附录印在页上', { timeout: 120000 }, () => {
  const root = tmp(), voice = join(root, 'v'), dir = join(root, 'proj');
  mkdirSync(voice, { recursive: true });
  writeFileSync(join(voice, 'alignment.json'), JSON.stringify(fakeAlignment(SCRIPT)));
  assert.equal(hj(['init', dir, '--voice', voice]).status, 0);
  rmSync(join(dir, 'story.yaml')); writeFileSync(join(dir, 'project.yaml'), readFileSync(join(dir, 'project.yaml'), 'utf8').replace(/^story:.*\n/m, '')); // 这条测试不管导演那一步（在 story.test.ts）
  writeFileSync(join(dir, 'plan.yaml'), PLAN);
  const miss = hj(['check', dir]);
  assert.equal(miss.status, 1);
  assert.match(miss.stdout + miss.stderr, /找不到图片 media\/co\.png/);
  mkdirSync(join(dir, 'media')); writeFileSync(join(dir, 'media/co.png'), png(300, 300));
  const h0 = loadPlan(dir)!.hash;
  writeFileSync(join(dir, 'appendix.yaml'), APPENDIX);
  const h1 = loadPlan(dir)!.hash;
  assert.notEqual(h0, h1, '附录算在计划的版本号里');
  const r = hj(['plan', dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = readFileSync(join(dir, 'out/review/plan.html'), 'utf8');
  assert.ok(existsSync(join(dir, 'out/review/plan.png')));
  assert.equal((html.match(/class="seg"/g) ?? []).length, 4, '一段一张卡片');
  for (const s of ['公司交一百块税', '回到公司身上圈一下', '片尾的滚动附录（3 条）']) assert.ok(html.includes(s), s);
  // 附录写错：check 拦住
  writeFileSync(join(dir, 'appendix.yaml'), 'title: 时间线\nitems:\n  - { title: 创办, size: 40 }\n');
  const bad = hj(['check', dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /不认识字段 "size"/);
  rmSync(root, { recursive: true });
});
