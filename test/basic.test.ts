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
