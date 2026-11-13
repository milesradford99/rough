import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { fakeAlignment, resolveAnchor, buildSubtitles, loadAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';
import { lint } from '../src/core/lint';
import { drawFrame } from '../src/core/render';

const tmp = () => mkdtempSync(join(tmpdir(), 'hj-'));
function alignmentOf(text: string) { const d = tmp(), f = join(d, 'alignment.json'); writeFileSync(f, JSON.stringify(fakeAlignment(text))); return loadAlignment(f); }

test('锚点：文字、第 n 次、@end、偏移、范围', () => {
  const al = alignmentOf('一百块给你。你拿一百块去买东西。');
  const a = resolveAnchor(al, '一百块'), b = resolveAnchor(al, '一百块#2');
  assert.equal(a.time, 0);
  assert.ok(b.time > a.time);
  assert.equal(a.ambiguous, 1);
  assert.equal(b.ambiguous, 0);
  assert.ok(resolveAnchor(al, '给你@end').time > resolveAnchor(al, '给你').time);
  assert.ok(Math.abs(resolveAnchor(al, '买东西-0.2').time - (resolveAnchor(al, '买东西').time - 0.2)) < 1e-9);
  assert.equal(resolveAnchor(al, '一百块', [b.time - 0.01, 99]).time, b.time);
  assert.throws(() => resolveAnchor(al, '两百块'), /找不到/);
  assert.equal(resolveAnchor(al, '给，你').time, resolveAnchor(al, '给你').time);
});

test('字幕：按标点断行，不超过上限', () => {
  const al = alignmentOf('很多人信，而且理由听着特别硬。人都没工资了，东西卖给谁？');
  const subs = buildSubtitles(al, 13);
  assert.ok(subs.length >= 3);
  for (const s of subs) { assert.ok(s.text.replace(/\s/g, '').length <= 14, s.text); assert.ok(s.end > s.start); }
});

test('示例项目：零错误零警告，时间线合理', () => {
  const c = compile('examples/compound');
  const issues = lint(c);
  assert.deepEqual(issues.filter(i => i.level !== 'info'), []);
  assert.equal(c.scenes.length, 2);
  for (const tl of c.tls) if (tl.drawT0 != null) assert.ok(tl.drawT1! > tl.drawT0);
  const sc2 = c.scenes[1];
  assert.ok(Math.abs(sc2.t0 - resolveAnchor(c.al, '时间越长').time) < 1e-9);
});

test('渲染：画面是时间的纯函数（同一时刻两次渲染逐像素一致，且画面随时间变化）', () => {
  const c = compile('examples/compound');
  const env = { createCanvas, Path2D };
  const shot = (t: number) => { const cv = createCanvas(270, 480); drawFrame(cv.getContext('2d'), c, t, env, { scale: 0.25 }); return Buffer.from(cv.data()); };
  const a = shot(9.5), b = shot(3), a2 = shot(9.5);
  assert.ok(a.equals(a2));
  assert.ok(!a.equals(b));
  assert.ok(a.some((v, i) => i % 4 === 0 && v < 100), '画面上应该有墨迹');
});

test('检查器：拦住抄口播、找不到的锚点、引用不存在的元素', () => {
  const d = tmp();
  cpSync('examples/compound', d, { recursive: true });
  const f = join(d, 'scenes/02-snowball.yaml');
  let s = readFileSync(f, 'utf8');
  s = s.replace('text: "本金"', 'text: "复利的关键不是本金"').replace('at: "这个雪球"', 'at: "这个火球"').replace('draw: me', 'draw: nobody');
  writeFileSync(f, s);
  const msgs = lint(compile(d)).filter(i => i.level === 'error').map(i => i.msg).join('\n');
  assert.match(msgs, /照抄口播/);
  assert.match(msgs, /这个火球/);
  assert.match(msgs, /nobody/);
});

test('确认：只调细节不改变分镜版本，改“画什么”才改变', () => {
  const d = tmp();
  cpSync('examples/compound', d, { recursive: true });
  const h0 = compile(d).planHash, f = join(d, 'scenes/01-deposit.yaml');
  const s = readFileSync(f, 'utf8');
  writeFileSync(f, s.replace('size: 560', 'size: 540'));
  assert.equal(compile(d).planHash, h0);
  writeFileSync(f, s.replace('intent: 画出小人和存钱罐', 'intent: 画出小人和保险箱'));
  assert.notEqual(compile(d).planHash, h0);
});

test('表现手法：九种都能在竖屏和横屏下展开，示例零警告', () => {
  const c = compile('examples/patterns');
  assert.deepEqual(lint(c).filter(i => i.level !== 'info'), []);
  assert.equal(c.scenes.length, 9);
  const d = tmp();
  cpSync('examples/patterns', d, { recursive: true });
  const pf = join(d, 'project.yaml');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace('format: portrait', 'format: landscape'));
  const errors = lint(compile(d)).filter(i => i.level === 'error');
  assert.deepEqual(errors, []);
});

test('表现手法：写错步骤名时列出可用步骤', () => {
  const d = tmp();
  cpSync('examples/patterns', d, { recursive: true });
  const f = join(d, 'scenes/01-cycle.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace('step: result', 'step: finish'));
  const msgs = lint(compile(d)).filter(i => i.level === 'error').map(i => i.msg).join('\n');
  assert.match(msgs, /finish/);
  assert.match(msgs, /go\.1/);
});

test('一块板放两种手法：自动起名的元素不撞名，步骤带前缀', () => {
  const d = tmp();
  cpSync('examples/patterns', d, { recursive: true });
  const f = join(d, 'scenes/04-bars.yaml');
  writeFileSync(f, `from: "按公式该发"
intent: 上半板柱子被砍，下半板一条走势
pattern:
  - { kind: bars, area: ["5%", "2%", "90%", "48%"], items: [{ label: 法定, value: 3800, cutTo: 1200 }, { label: 去年, value: 1300 }] }
  - { kind: trend, area: ["5%", "52%", "90%", "46%"], points: [{ value: 3, label: A }, { value: 2, label: B }, { value: 1, label: C }] }
beats:
  - { at: "按公式该发", intent: 画柱子, do: [{ step: bars.axis }, { step: bars.bar.1 }, { step: bars.bar.2 }] }
  - { at: "最后只批了", intent: 砍柱子并画走势, do: [{ step: bars.cut.1 }, { step: trend.axis }, { step: trend.all }, { draw: { note: 砍了, target: bars_n1, side: bottom } }] }
`);
  const c = compile(d), errors = lint(c).filter(i => i.level === 'error');
  assert.deepEqual(errors, []);
  const ids = c.tls.filter(t => t.scene === 3).map(t => t.el.id);
  assert.ok(ids.includes('bars_axis') && ids.includes('trend_axisX'));
  assert.equal(new Set(ids).size, ids.length);
});

test('自动避让：堆在同一点、不写位置、写到板外的元素，最后都在板内且互不重叠', () => {
  const d = tmp();
  cpSync('examples/patterns', d, { recursive: true });
  for (const f of ['01-cycle', '02-versus', '03-chain', '05-trend', '06-timeline', '07-thought', '08-equation', '09-split']) writeFileSync(join(d, `scenes/${f}.yaml`), '');
  const f = join(d, 'scenes/04-bars.yaml');
  writeFileSync(f, `intent: 压力测试
elements:
  a: { doodle: factory, size: 280, at: [480, 400], label: 公司 }
  b: { doodle: gov, size: 280, at: [480, 400] }
  c: { figure: stand, size: 360, at: [500, 420] }
  d: { doodle: banknote, size: 200, at: [480, 400] }
  e: { text: "+0", size: 150, at: [470, 410] }
  f: { doodle: robot, size: 240 }
  g: { doodle: server, size: 220 }
  h: { text: "53%", size: 110 }
  i: { doodle: moneybag, size: 200, near: c }
  j: { doodle: chip, size: 180, at: [1500, 300] }
  n: { note: 一条批注, target: e }
  inside: { doodle: bubble, size: 300, at: [200, 1050] }
  word: { text: "嗯", size: 80, at: inside }
beats:
  - { at: "一百块从公司", intent: 全部画出来, do: [{ draw: [a, b, c, d, e, f, g, h, i, j, n, inside, word] }] }
`);
  for (const x of readdirSync(join(d, 'scenes'))) if (!readFileSync(join(d, 'scenes', x), 'utf8').trim()) rmSync(join(d, 'scenes', x));
  const c = compile(d), B = c.fmt.board, els = c.tls.map(t => t.el);
  assert.deepEqual(lint(c).filter(i => i.level === 'error'), []);
  for (const e of els) assert.ok(e.solid.x >= -6 && e.solid.y >= -6 && e.solid.x + e.solid.w <= B.w + 6 && e.solid.y + e.solid.h <= B.h + 6, `${e.id} 出界`);
  const ov = (p: any, q: any) => Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 8 && Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > 8;
  for (const p of els) for (const q of els) if (p.id < q.id && !(p.id === 'inside' && q.id === 'word')) assert.ok(!ov(p.solid, q.solid), `${p.id} 和 ${q.id} 重叠`);
  const word = els.find(e => e.id === 'word')!, bub = els.find(e => e.id === 'inside')!;
  assert.ok(ov(word.solid, bub.solid), '明确叠放在气泡上的文字不应该被挪走');
});

/** 用一个场景搭一个临时项目，返回编译结果和检查结果 */
function oneScene(scene: string, script: string, doodles: Record<string, string> = {}) {
  const d = tmp();
  cpSync('examples/compound/project.yaml', join(d, 'project.yaml'));
  mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes')); mkdirSync(join(d, 'doodles'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(script)));
  writeFileSync(join(d, 'scenes/01-a.yaml'), scene);
  for (const [n, y] of Object.entries(doodles)) writeFileSync(join(d, 'doodles', n + '.yaml'), y);
  const c = compile(d), issues = lint(c);
  return { c, issues, msgs: (level: string) => issues.filter(i => i.level === level).map(i => `${i.where} ${i.msg}`).join('\n') };
}

test('手绘件锚点：小人能站在声明的锚点上', () => {
  const { c, issues } = oneScene(`intent: 人站在船的甲板上
elements:
  boat: { doodle: boat, size: 300, at: [500, 600] }
  p:    { figure: stand, size: 160, at: boat.deck, anchor: bottom }
beats:
  - { at: "上船", intent: 画船和人, do: [{ draw: [boat, p] }] }
`, '上船了。', { boat: 'box: [300, 200]\nanchors: { deck: [150, 120] }\nparts:\n  - poly: [[20, 120], [280, 120], [240, 190], [60, 190]]\n    close: true\n  - line: [150, 120, 150, 10]\n' });
  assert.deepEqual(issues.filter(i => i.level === 'error'), []);
  const boat = c.tls.find(t => t.el.id === 'boat')!.el, p = c.tls.find(t => t.el.id === 'p')!.el;
  assert.ok(boat.anchors.deck, '应该有 deck 锚点');
  assert.ok(Math.abs(p.box.y + p.box.h - boat.anchors.deck[1]) < 2, '脚应该落在甲板上');
  assert.ok(Math.abs(boat.anchors.deck[1] - (boat.box.y + boat.box.h * 0.6)) < 30, '锚点随手绘件一起缩放和移动');
});

test('检查器：后画的那一层——批注早于目标、标记压到旁人、东西摆在手上、挪得太远', () => {
  const r = oneScene(`intent: 一组故意写错的摆法
elements:
  a:    { doodle: factory, size: 260, at: [250, 300] }
  b:    { text: "53%", size: 90, at: [470, 300] }
  early: { note: 出处, target: b, side: bottom }
  ring: { mark: circle, target: a }
  me:   { figure: stand, size: 300, at: [250, 900] }
  bag:  { doodle: moneybag, size: 120, at: me.handR }
  far:  { doodle: gov, size: 260, at: [250, 300] }
beats:
  - { at: "先说出处", intent: 批注先出来, do: [{ draw: early }] }
  - { at: "再画工厂", intent: 工厂、数字、圈, do: [{ draw: [a, b, ring] }] }
  - { at: "最后是人", intent: 人和钱袋, do: [{ draw: [me, bag, far] }] }
`, '先说出处。再画工厂和数字。最后是人和钱袋。');
  assert.match(r.msgs('error'), /early.*早 .* 秒出现/);
  assert.match(r.msgs('warn'), /ring.*会压到 "b"/);
  assert.match(r.msgs('warn'), /bag.*carry/);
  assert.match(r.msgs('warn'), /far.*挪得很远/);
});

test('检查器：节奏——空板等人、刚画完就擦、片尾画到配音之后', () => {
  const r = oneScene(`intent: 一组故意写错的节奏
elements:
  a: { doodle: factory, size: 260, at: [250, 300] }
  b: { doodle: gov, size: 260, at: [700, 300] }
  c: { doodle: robot, size: 260, at: [480, 800] }
beats:
  - { at: "这才开始画", intent: 画工厂, do: [{ draw: a }] }
  - { at: "政府", intent: 画政府, do: [{ draw: b, dur: 0.3 }, { erase: b }] }
  - { at: "完", intent: 画机器人, do: [{ draw: c, dur: 3 }] }
`, '前面先铺垫很长很长的一大段话什么都不画。这才开始画工厂。然后是政府。完。');
  const w = r.msgs('warn');
  assert.match(w, /板面空了/);
  assert.match(w, /"b" 从起笔到被擦掉/);
  assert.match(w, /最后一个动作/);
});

test('表现手法：柱子的数值可以单独卡点；怎么分可以留白；因果链里的长文字不挤掉箭头', () => {
  const bars = oneScene(`intent: 柱子先立起来，数值等说到再写
pattern: { kind: bars, items: [{ label: 今年, value: 26 }, { label: 去年, value: 2.3 }] }
beats:
  - { at: "确实在招", intent: 画柱子, do: [{ step: axis }, { step: col.1 }] }
  - { at: "二十六个", intent: 写 26, do: [{ step: value.1 }] }
  - { at: "不到三个", intent: 画去年, do: [{ step: bar.2 }] }
`, '确实在招人，看看今年的数据。每一百个里有二十六个，去年还不到三个。');
  assert.deepEqual(bars.issues.filter(i => i.level === 'error'), []);
  const tl = (id: string) => bars.c.tls.find(t => t.el.id === id)!;
  assert.ok(tl('v1').drawT0! > tl('b1').drawT1!, '数值晚于柱子');
  assert.ok(Math.abs(tl('v1').drawT0! - resolveAnchor(bars.c.al, '二十六个').time) < 1e-6, '数值卡在说出数字的那一刻');

  const split = oneScene(`intent: 三段收益，最后一段留白打问号
pattern: { kind: split, area: ["2%", "5%", "96%", "45%"], parts: [{ label: 股东, value: 3 }, { label: 公司, value: 3 }, { label: 普通人, value: 3, blank: true }] }
beats:
  - { at: "收益", intent: 画整条和股东, do: [{ step: whole }, { step: part.1 }] }
  - { at: "公司", intent: 公司, do: [{ step: part.2 }] }
  - { at: "普通人", intent: 留白, do: [{ step: part.3 }] }
`, '收益怎么分。一份给公司。普通人呢。');
  assert.deepEqual(split.issues.filter(i => i.level !== 'info'), []);
  const q = split.c.tls.find(t => t.el.id === 'pq3')!.el, p3 = split.c.tls.find(t => t.el.id === 'p3')!.el;
  assert.ok(q.box.x >= p3.box.x && q.box.x + q.box.w <= p3.box.x + p3.box.w, '问号在留白那段里面，没被挪走');
  assert.ok(!/3/.test(split.c.tls.find(t => t.el.id === 'pl3')!.el.text ?? ''), '留白段不写数值');

  const chain = oneScene(`intent: 三环因果链，中间一环是一行字
pattern: { kind: chain, area: ["2%", "3%", "94%", "42%"], items: [{ doodle: robot }, { text: "1人顶3人", size: 78 }, { doodle: office }], links: [能顶, 于是] }
beats:
  - { at: "模型", intent: 第一环, do: [{ step: item.1 }] }
  - { at: "顶三个", intent: 第二环, do: [{ step: item.2 }] }
  - { at: "空了", intent: 第三环, do: [{ step: item.3 }] }
`, '模型来了。一个人顶三个人。工位就空了。');
  assert.deepEqual(chain.issues.filter(i => i.level !== 'info'), []);
  for (const id of ['l1', 'l2']) { const a = chain.c.tls.find(t => t.el.id === id)!.el; assert.ok(Math.hypot(a.path![a.path!.length - 2] - a.path![0], a.path![a.path!.length - 1] - a.path![1]) > 70, `箭头 ${id} 要有长度`); }
});

test('人群、角色表、场景沿用：一排人整体定位，后五个走上船；下一场母图已经在板上', () => {
  const d = tmp();
  cpSync('examples/compound/project.yaml', join(d, 'project.yaml'));
  mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes')); mkdirSync(join(d, 'doodles'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment('陆地上有十个人。调一半的人去当海军。后来再看这张图，船上多了一个人。')));
  writeFileSync(join(d, 'doodles/boat.yaml'), 'box: [300, 200]\nanchors: { deck: [150, 120] }\nparts:\n  - poly: [[20, 120], [280, 120], [240, 190], [60, 190]]\n    close: true\n  - line: [150, 120, 150, 10]\n');
  writeFileSync(join(d, 'cast.yaml'), 'worker: { figure: stand, size: 130 }\nboss: { figure: stand, wear: [tophat], face: smug }\n');
  writeFileSync(join(d, 'scenes/01-map.yaml'), `intent: 十个人站两排，后五个走上船
elements:
  boat: { doodle: boat, size: 320, at: [720, 420] }
  p:    { crowd: 10, cols: 5, of: { cast: worker }, at: [270, 800] }
  box:  { mark: box, target: p1..p5 }
beats:
  - { at: "陆地上", intent: 画船和十个人, do: [{ draw: boat }, { draw: p }] }
  - { at: "调一半", intent: 后五个走上船，圈住留下的, do: [{ walk: p6..p10, to: boat.deck, dur: 1.2 }, { draw: box }] }
`);
  writeFileSync(join(d, 'scenes/02-back.yaml'), `from: "后来再看"
intent: 回到母图，老板也站上船
recall: { scene: map, show: [boat, p1..p5] }
elements:
  boss: { cast: boss, size: 150, at: boat.deck, anchor: bottom }
beats:
  - { at: "船上多了", intent: 老板出现在船上, do: [{ draw: boss }] }
`);
  const c = compile(d), issues = lint(c);
  assert.deepEqual(issues.filter(i => i.level === 'error'), []);
  const tl = (sc: number, id: string) => c.tls.find(t => t.scene === sc && t.el.id === id)!;
  // 人群：十个成员，同一排的脚在一条线上，没有谁被单独挪走
  const row1 = [1, 2, 3, 4, 5].map(i => tl(0, `p${i}`).el);
  assert.ok(row1.every(e => Math.abs(e.box.y + e.box.h - (row1[0].box.y + row1[0].box.h)) < 1 && !e.nudged));
  assert.ok(tl(0, 'p10'), '应该有第 10 个成员');
  // 走上船：五个人的脚都落在甲板附近，而且没有叠成一个
  const deck = tl(0, 'boat').el.anchors.deck, ends = [6, 7, 8, 9, 10].map(i => { const t = tl(0, `p${i}`), mv = t.moves[t.moves.length - 1].to; return [t.el.anchors.feet[0] + mv[0], t.el.anchors.feet[1] + mv[1]]; });
  for (const e of ends) assert.ok(Math.abs(e[1] - deck[1]) < 40 && Math.abs(e[0] - deck[0]) < 160, '脚应该落在甲板附近');
  assert.ok(Math.max(...ends.map(e => e[0])) - Math.min(...ends.map(e => e[0])) > 60, '队形应该保留，不叠在一起');
  // 沿用：母图在第 2 场一开始就在板上，位置和第 1 场一模一样；没被要求的不带过来
  const b1 = tl(0, 'boat'), b2 = tl(1, 'boat');
  assert.ok(b2.recalled && b2.appear && b2.appear.t <= c.scenes[1].t0);
  assert.deepEqual(b2.el.box, b1.el.box);
  assert.ok(tl(1, 'p3') && !c.tls.some(t => t.scene === 1 && t.el.id === 'p8'));
  // 角色表：老板戴着礼帽，脚落在甲板上
  const boss = tl(1, 'boss').el;
  assert.deepEqual(boss.src.wear, ['tophat']);
  assert.ok(Math.abs(boss.box.y + boss.box.h - b2.el.anchors.deck[1]) < 2);
  // 改 recall 算“画什么变了”
  const h0 = c.planHash, f = join(d, 'scenes/02-back.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace('show: [boat, p1..p5]', 'show: [boat]'));
  assert.notEqual(compile(d).planHash, h0);
});

test('灰色阴影：默认有、只加在外轮廓、不改变占位框、可以关', async () => {
  const { buildElement } = await import('../src/core/elements');
  const { FORMATS } = await import('../src/core/theme');
  const mk = (src: any, shade?: boolean) => buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map(), shade }, 'e', src);
  const deco = (el: any) => el.strokes.filter((s: any) => s.deco);
  const on = mk({ doodle: 'factory', size: 280, at: [300, 300] }), off = mk({ doodle: 'factory', size: 280, at: [300, 300], shade: false });
  assert.ok(deco(on).length >= 1 && deco(on).length <= 2, '工厂只有外轮廓有阴影，门窗没有');
  assert.equal(deco(off).length, 0);
  assert.deepEqual(on.box, off.box);
  assert.ok(deco(on).every((s: any) => s.under && s.flat));
  assert.equal(deco(mk({ doodle: 'factory', size: 280, at: [300, 300] }, false)).length, 0, '项目级开关');
  assert.equal(deco(mk({ figure: 'stand', at: [300, 600] })).length, 1, '小人脚下一团影子');
  assert.ok(deco(mk({ shape: 'rect', w: 300, h: 160, at: [300, 300] })).length >= 1);
  assert.equal(deco(mk({ text: '复利', at: [300, 300] })).length, 0);
});

test('导入：Excalidraw 素材库和 Quick Draw 都能转成可用的手绘件', async () => {
  const im = await import('../src/core/importers');
  const { buildElement } = await import('../src/core/elements');
  const { FORMATS } = await import('../src/core/theme');
  const base = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent' };
  const lib = { libraryItems: [{ name: 'Price Tag!', elements: [
    { ...base, type: 'rectangle', x: 100, y: 100, width: 400, height: 200, backgroundColor: '#ffc9c9' },
    { ...base, type: 'ellipse', x: 150, y: 150, width: 50, height: 50, strokeColor: '#1971c2' },
    { ...base, type: 'line', x: 200, y: 200, width: 100, height: 0, points: [[0, 0], [100, 0]] },
    { ...base, type: 'text', x: 0, y: 0, width: 90, height: 20, text: 'label' },
    { ...base, type: 'image', x: 0, y: 0, width: 10, height: 10 },
  ] }, { elements: [{ ...base, type: 'diamond', x: 0, y: 0, width: 50, height: 80, isDeleted: true }] }] };
  const [it, ...rest] = im.fromExcalidraw(lib, { source: 'test' });
  assert.equal(rest.length, 0, '只有已删除元素的素材被丢掉');
  assert.equal(it.name, 'price-tag');
  assert.deepEqual(it.doodle.box, [200, 106]);
  assert.equal(it.doodle.parts.length, 3, '文字默认不要，图片不支持');
  assert.equal(it.doodle.parts[0].fill, 'red');
  assert.equal(it.doodle.parts[1].color, 'blue');
  assert.ok(it.skipped.some(s => s.includes('image')));
  assert.throws(() => im.fromExcalidraw({}), /不是 Excalidraw/);
  const q = im.parseQuickDraw('{"word":"tree","recognized":true,"drawing":[[[0,255,128],[0,10,255]],[[5,9],[5,9]]]}\n{"word":"tree","recog');
  assert.equal(q.length, 1, '截断的最后一行跳过');
  const qd = im.fromQuickDraw(q[0]);
  assert.equal(qd.doodle.parts.length, 2);
  for (const d of [it.doodle, qd.doodle]) {
    const y = (await import('yaml')).default.parse(im.doodleYaml(d));
    const el = buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map() }, 'e', { parts: y.parts, box: y.box, size: 200, at: [300, 300] });
    assert.ok(el.strokes.length > 0 && el.box.w <= 215 && el.box.h <= 215);
  }
});

test('导入：SVG 的墨块保留镂空，纸色丢掉，其他颜色并进调色板，变换生效', async () => {
  const im = await import('../src/core/importers');
  const { buildElement } = await import('../src/core/elements');
  const { FORMATS } = await import('../src/core/theme');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><title>Test Peep</title>
    <g transform="translate(100 0)">
      <path fill="#FFFFFF" d="M0 0H200V200H0Z"/>
      <path fill="#000000" fill-rule="evenodd" d="M0 0H200V200H0Z M60 60V140H140V60Z"/>
      <circle cx="100" cy="300" r="40" fill="#2f6fb7"/>
      <path d="M0 380H200" stroke="#d9433a" stroke-width="6" fill="none"/>
    </g><defs><linearGradient id="g"/></defs><text>x</text></svg>`;
  const it = im.fromSvg(svg, { source: 'test' });
  assert.equal(it.name, 'test-peep');
  assert.equal(it.doodle.source, 'test');
  assert.ok(it.skipped.some(s => s.includes('text')));
  const p = it.doodle.parts;
  assert.equal(p.length, 3, '白块丢掉；墨块、蓝圆、红线各一个');
  assert.equal(p[0].fill, 'ink'); assert.equal(p[0].fillStyle, 'solid'); assert.equal(p[0].shade, false);
  assert.ok(p[0].poly.length >= 10, '洞用桥并进了外轮廓（4 + 4 个角再加桥的两端）');
  assert.equal(p[1].fill, 'blue'); assert.equal(p[2].color, 'red');
  assert.equal(im.fromSvg(svg, { paper: true }).doodle.parts.length, 4, '--paper 保留纸色填充');
  // translate 生效：整体外框是 200 宽 × 约 380 高的比例
  assert.ok(it.doodle.box[1] > it.doodle.box[0]);
  // 带洞的环：外环 4 点 + 洞 4 点 + 桥的 2 个重复端点
  const polys = im.fillPolys([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [3, 7], [7, 7], [7, 3]]], 'evenodd');
  assert.equal(polys.length, 1);
  assert.equal(polys[0].length, 4 + 4 + 2);
  const y = (await import('yaml')).default.parse(im.doodleYaml(it.doodle));
  const el = buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map() }, 'e', { parts: y.parts, box: y.box, size: 300, at: [300, 300] });
  assert.ok(el.strokes.length > 0);
  assert.throws(() => im.fromSvg('<html/>'), /不是 SVG/);
  assert.throws(() => im.fromSvg('<svg><defs/></svg>'), /没有可画/);
});

test('内置手绘件：每一个都画得出来，导入的都带出处', async () => {
  const { buildElement, doodleDirs } = await import('../src/core/elements');
  const { FORMATS } = await import('../src/core/theme');
  const YAML = (await import('yaml')).default;
  const dir = doodleDirs()[0], files = readdirSync(dir).filter(f => f.endsWith('.yaml'));
  assert.ok(files.length >= 120);
  for (const f of files) {
    const el = buildElement({ scene: 's', fmt: FORMATS.portrait, els: new Map() }, 'e', { doodle: f.replace('.yaml', ''), size: 200, at: [300, 300] });
    assert.ok(el.strokes.length > 0, f);
    assert.ok(YAML.parse(readFileSync(join(dir, f), 'utf8')).desc, f + ' 缺 desc');
  }
});

test('试跑暴露的缺口：手法字号不小于 36、thought 的小人可起名并被批注、算式不算长板书、细线墨块不慢', () => {
  const d = tmp(); mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  const text = '每一圈都比上一圈少一成。很多人觉得这样下去就没了。可是加起来有一千块。';
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(text)));
  writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\n');
  writeFileSync(join(d, 'scenes/01.yaml'), `
from: "每一圈"
intent: 五根柱子挤在小地盘里
pattern:
  - { kind: bars, area: ["5%", "5%", "60%", "40%"], items: [{ label: 存入, value: 100 }, { label: 一圈, value: 90 }, { label: 二圈, value: 81 }, { label: 三圈, value: 73 }, { label: 四圈, value: 66 }] }
  - { kind: thought, area: ["5%", "50%", "90%", "48%"], who: { figure: think, id: me }, content: { doodle: bowl } }
elements:
  tip: { note: 饿了, target: me }
  sum: { text: "100 × 10 = 1000", size: 60, at: ["75%", "20%"] }
  guy: { doodle: peep-bust-plain, size: 260, at: ["78%", "38%"] }
beats:
  - { at: "每一圈", intent: 画柱子, do: [{ step: bars.axis }, { step: bars.bar.1 }, { step: bars.bar.2 }, { step: bars.bar.3 }, { step: bars.bar.4 }, { step: bars.bar.5 }] }
  - { at: "很多人觉得", intent: 小人和泡泡, do: [{ step: thought.who }, { draw: tip }, { step: thought.bubble }, { draw: guy }] }
  - { at: "可是加起来", intent: 写算式, do: [{ draw: sum }] }
`);
  const c = compile(d), issues = lint(c);
  assert.deepEqual(issues.filter(i => i.level === 'error'), []);
  for (const tl of c.tls) if (tl.el.kind === 'text') assert.ok((tl.el.src.size ?? 72) >= 36, tl.el.id);
  assert.ok(c.tls.some(t => t.el.id === 'me'));
  for (const bad of ['字号', '偏长', '倍才画得完']) assert.equal(issues.filter(i => i.msg.includes(bad)).length, 0, bad);
  rmSync(d, { recursive: true });
});

test('自动取景：内容没铺满就推近，铺满了不动，可以关', () => {
  const mk = (els: string, extra = '', proj = '') => {
    const d = tmp(); mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
    writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment('先画一个工厂。再画一个银行。')));
    writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\n' + proj);
    writeFileSync(join(d, 'scenes/01.yaml'), `from: "先画"\nintent: 两样东西\n${extra}elements:\n${els}beats:\n  - { at: "先画", intent: 画, do: [{ draw: [a, b] }] }\n`);
    const c = compile(d); rmSync(d, { recursive: true }); return c.scenes[0].home;
  };
  const small = '  a: { doodle: factory, size: 200, at: [380, 500] }\n  b: { doodle: bank, size: 200, at: [600, 700] }\n';
  const full = '  a: { doodle: factory, size: 300, at: [170, 170] }\n  b: { doodle: bank, size: 300, at: [790, 1080] }\n';
  assert.equal(mk(small).zoom, 1.4);
  assert.equal(mk(full).zoom, 1);
  assert.equal(mk(small, 'frame: false\n').zoom, 1);
  assert.equal(mk(small, '', 'autoframe: false\n').zoom, 1);
});

test('一块板：分区、共用轴的坐标、镜头推近分区、比屏幕大的板', () => {
  const mk = (scene: string, proj = '') => {
    const d = tmp(); mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
    writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment('先画第一条。再画第二条。最后看全景。')));
    writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\n' + proj);
    writeFileSync(join(d, 'scenes/01.yaml'), scene);
    const c = compile(d); rmSync(d, { recursive: true }); return c;
  };
  const base = (extra = '', els = '') => `from: "先画"\nintent: 两条横条共用一根轴\n${extra}regions:\n  rows: [0, 200, 960, 400]\n  foot: ["0%", "70%", "100%", "20%"]\nelements:\n  a: { shape: rect, w: 400, h: 50, in: rows, at: [100, 50], anchor: left }\n  b: { shape: rect, w: 300, h: 50, at: [a.left, 420], anchor: left }\n  t: { text: "合计", size: 60, in: foot, at: ["50%", "50%"] }\n${els}beats:\n  - { at: "先画", intent: 第一条, do: [{ draw: a }] }\n  - { at: "再画", intent: 第二条, do: [{ camera: { focus: rows } }, { draw: b }] }\n  - { at: "最后", intent: 全景, do: [{ camera: home }, { draw: t }] }\n`;
  const c = mk(base()), box = (id: string) => c.tls.find(t => t.el.id === id)!.el.box;
  assert.deepEqual(c.issues.filter(i => i.level === 'error'), []);
  assert.ok(Math.abs(box('a').x - 100) < 12 && Math.abs(box('a').y + 25 - 250) < 12, 'in: 分区后坐标相对分区');
  assert.ok(Math.abs(box('a').x - box('b').x) < 12, '第二条的左端对着第一条的左端');
  assert.ok(Math.abs(box('t').y + box('t').h / 2 - (1250 * 0.7 + 1250 * 0.1)) < 12, '百分比相对分区');
  assert.equal(c.scenes[0].regions!.length, 2);
  assert.ok(c.cams.length >= 3, '推近分区和回全景都排进了镜头');
  assert.match(mk(base('', '  rows: { text: "撞名", size: 60 }\n')).issues.map(i => i.msg).join(), /分区和元素都叫/);
  assert.match(mk(base().replace('in: foot', 'in: nowhere')).issues.map(i => i.msg).join(), /没有叫 "nowhere" 的分区/);
  // 比屏幕大的板：全景把整块板缩进画面，板外的坐标不再算出界
  const big = mk(base('board: 1.5\n').replace('at: [a.left, 420]', 'at: [1100, 1700]'));
  assert.deepEqual(big.issues.filter(i => i.level !== 'info' && /出|超/.test(i.msg)), []);
  assert.ok(big.scenes[0].home.zoom < 1 && big.scenes[0].home.zoom >= 1 / 1.5 - 1e-6);
  assert.equal(big.scenes[0].board.w, 1440);
});

test('一块板：翻页、镜头不动、分区空着会被检查器指出来；layout: pages 可以明说要分页', () => {
  const d = tmp(); mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  const text = '先讲第一件事，它很重要，要讲清楚。再讲第二件事，它也重要，同样要讲清楚。最后讲第三件事，把前面的连起来。';
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(text)));
  const sc = (from: string) => `from: "${from}"\nintent: 一页\nregions:\n  spare: [0, 900, 960, 300]\nelements:\n  a: { doodle: bank, size: 300, at: [300, 300] }\nbeats:\n  - { at: "${from}", intent: 画, do: [{ draw: a }] }\n`;
  writeFileSync(join(d, 'scenes/01.yaml'), sc('先讲第一件事')); writeFileSync(join(d, 'scenes/02.yaml'), sc('再讲第二件事')); writeFileSync(join(d, 'scenes/03.yaml'), sc('最后讲第三件事'));
  writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\n');
  const msgs = lint(compile(d)).map(i => i.msg).join('\n');
  assert.match(msgs, /这是翻页/); assert.match(msgs, /分区 "spare" 到最后还是空的/);
  writeFileSync(join(d, 'project.yaml'), 'title: t\nformat: portrait\nlayout: pages\n');
  assert.doesNotMatch(lint(compile(d)).map(i => i.msg).join('\n'), /这是翻页/);
  rmSync(d, { recursive: true });
  const one = lint(compile('examples/one-board'));
  assert.deepEqual(one.filter(i => i.level !== 'info'), []);
});
