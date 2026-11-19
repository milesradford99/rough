import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import YAML from 'yaml';
import { fakeAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';
import { drawFrame, moveAt, handAt, camAt } from '../src/core/render';
import { liveStrokes, morphAt, numberIn, withNumber, easeBy } from '../src/core/live';
import { boxOf } from '../src/core/strokes';

const SAY = '工资一万。房租四千。工资涨到一万二。房子搬远了。房租降回去。';
function project(scene: any): string {
  const d = mkdtempSync(join(tmpdir(), 'hj-live-'));
  mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(SAY)));
  writeFileSync(join(d, 'project.yaml'), YAML.stringify({ title: 't', format: 'portrait', voice: 'voice/alignment.json', sfx: false, autoframe: false, focus: false }));
  writeFileSync(join(d, 'scenes/01-a.yaml'), YAML.stringify({ intent: '测试', ...scene }));
  return d;
}
const ELS = {
  ax: { axis: [0, 12000], length: 600, at: [150, 600] },
  bar: { span: [0, 10000], on: 'ax', at: [0, 600], color: 'blue', h: 60 },
  barT: { text: '工资 10000', size: 'label', below: 'bar', gap: 14 },
  boss: { doodle: 'office', size: 140, at: [820, 250] },
  pay: { arrow: ['boss.bottom', 'bar.right'] },
  home: { doodle: 'house', size: 120, at: [500, 250] },
  way: { line: ['home.right', 'boss.left'], color: 'gray' },
};
const BEATS = [
  { at: '工资一万', intent: '横条长出来', do: [{ draw: 'boss' }, { grow: 'bar', ease: 'spring' }, { count: 'barT', from: 0 }, { draw: 'pay' }] },
  { at: '房租四千', intent: '房子', do: [{ draw: ['home', 'way'] }] },
  { at: '工资涨到', intent: '横条变长，箭头跟着走', do: [{ change: 'bar', to: { span: [0, 12000] }, dur: 1 }, { count: 'barT', to: 12000, with: 'prev' }] },
  { at: '房子搬远', intent: '房子挪开，线跟着拉长', do: [{ move: 'home', to: [250, 250], dur: 1 }] },
  { at: '房租降回', intent: '收尾', do: [{ pulse: 'bar' }] },
];
const ok = (c: ReturnType<typeof compile>) => assert.deepEqual(c.issues.filter(i => i.level === 'error'), []);
const tlOf = (c: ReturnType<typeof compile>, id: string) => c.tls.find(t => t.el.id === id)!;

test('活元素：grow 从一头长出来，长完就是定义的样子；count 让数滚动', () => {
  const c = compile(project({ elements: ELS, beats: BEATS }));
  ok(c);
  const bar = tlOf(c, 'bar'), m = bar.morphs[0];
  assert.ok(m.base && bar.appear, 'grow 让它出现，并记下一段变化');
  const mid = liveStrokes(c, 0, m.t0 + (m.t1 - m.t0) * 0.1, moveAt)!.get(bar)!;
  assert.ok(boxOf(mid).w < bar.el.box.w * 0.95 && boxOf(mid).x <= bar.el.box.x + 4, '长到一半时比定义的短，从左边起');
  assert.equal(liveStrokes(c, 0, m.t1 + 0.01, moveAt)?.get(bar), undefined, '长完之后就用定义时的笔画');
  const cm = tlOf(c, 'barT').morphs[0];
  assert.equal(morphAt(tlOf(c, 'barT').morphs, cm.t0)[0].__num, 0);
  assert.ok(morphAt(tlOf(c, 'barT').morphs, (cm.t0 + cm.t1) / 2)[0].__num > 0);
  assert.deepEqual(numberIn('= 1,000.5'), { value: 1000.5, dec: 1, comma: true });
  assert.equal(withNumber('剩 6000 块', 6500, 0, false), '剩 6500 块');
  assert.equal(withNumber('= 1,000', 12345, 0, true), '= 12,345');
  assert.ok(easeBy('spring', 0.55) > 1.03, 'spring 会冲过头');
  assert.equal(easeBy('spring', 1), 1);
});

test('活元素：change 之后横条变长，连着它的箭头和下面的标签跟着走；房子挪开，线跟着拉长', () => {
  const c = compile(project({ elements: ELS, beats: BEATS }));
  ok(c);
  const bar = tlOf(c, 'bar'), pay = tlOf(c, 'pay'), barT = tlOf(c, 'barT'), way = tlOf(c, 'way');
  assert.deepEqual(pay.live, ['bar']);
  assert.ok(barT.live?.includes('bar'));
  assert.deepEqual(way.live, ['home']);
  const ch = bar.morphs[1];
  const after = liveStrokes(c, 0, ch.t1 + 0.05, moveAt)!;
  const nb = boxOf(after.get(bar)!), np = boxOf(after.get(pay)!), nt = boxOf(after.get(barT)!);
  assert.ok(nb.w > bar.el.box.w + 80, '横条从 10000 变到 12000');
  assert.ok(Math.abs(np.x + np.w - (nb.x + nb.w)) < 40 || np.x + np.w > bar.el.box.x + bar.el.box.w + 60, '箭头的头跟着横条的右端走');
  assert.ok(Math.abs(nt.x + nt.w / 2 - (nb.x + nb.w / 2)) < 30, '标签还在横条的正下方');
  const mv = tlOf(c, 'home').moves[0];
  const moved = liveStrokes(c, 0, mv.t1 + 0.05, moveAt)!.get(way)!;
  assert.ok(boxOf(moved).w > way.el.box.w + 200, '房子挪开 250 像素，线跟着拉长');
  // 画面仍是时间的纯函数
  const env = { createCanvas, Path2D };
  const shot = (t: number) => { const cv = createCanvas(270, 480); drawFrame(cv.getContext('2d'), c, t, env, { scale: 0.25 }); return Buffer.from(cv.data()); };
  const t = (ch.t0 + ch.t1) / 2;
  assert.ok(shot(t).equals(shot(t)));
  // 长横条时笔拖着那一头走
  const g = bar.morphs[0], hp = handAt(c, (g.t0 + g.t1) / 2, camAt(c, (g.t0 + g.t1) / 2));
  assert.ok(hp && hp.down, '长出来的时候笔在纸上');
});

test('活元素：写错了会被拦住，报错里写清楚怎么改', () => {
  const errs = (beats: any[], els: any = ELS) => compile(project({ elements: els, beats })).issues.filter(i => i.level === 'error').map(i => i.msg).join('\n');
  const first = { at: '工资一万', intent: 'x', do: [{ draw: ['boss', 'bar', 'barT', 'pay'] }] };
  assert.match(errs([{ at: '工资一万', intent: 'x', do: [{ change: 'bar', to: { span: [0, 1] } }] }]), /还没出现在画面上/);
  assert.match(errs([first, { at: '房租四千', intent: 'x', do: [{ change: 'bar', to: { at: [0, 300] } }] }]), /不能 change at。它能改的：span h color/);
  assert.match(errs([first, { at: '房租四千', intent: 'x', do: [{ change: 'bar', to: { span: [0] } }] }]), /span 写起止数值/);
  assert.match(errs([first, { at: '房租四千', intent: 'x', do: [{ grow: 'bar' }] }]), /已经在板上了，grow/);
  assert.match(errs([{ at: '工资一万', intent: 'x', do: [{ grow: 'boss' }] }]), /grow 只能用在区间条/);
  assert.match(errs([{ at: '工资一万', intent: 'x', do: [{ count: 'boss' }] }]), /count 只能用在带数字的文字上/);
  assert.match(errs([first, { at: '房租四千', intent: 'x', do: [{ count: 'barT' }] }]), /写 to: 数字/);
  assert.match(errs([first, { at: '房租四千', intent: 'x', do: [{ pulse: 'bar', ease: 'bouncy' }] }]), /ease 写动作的手感/);
  // 变大之后压到别人：提醒给变化后的样子留地方
  const crowded = { ...ELS, rent: { span: [0, 4000], on: 'ax', at: [0, 520], h: 60, color: 'red' }, tag: { text: '房租', size: 'label', at: [560, 520] } };
  const c = compile(project({ elements: crowded, beats: [first, { at: '房租四千', intent: 'x', do: [{ draw: ['rent', 'tag'] }] }, { at: '工资涨到', intent: 'x', do: [{ change: 'rent', to: { span: [0, 9000] } }] }] }));
  assert.ok(c.issues.some(i => i.level === 'warn' && /change 之后.*压到 "tag"/.test(i.msg)), c.issues.map(i => i.msg).join('\n'));
});
