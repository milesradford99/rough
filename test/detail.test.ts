import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { fakeAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';
import { moveAt } from '../src/core/render';

const SAY = '一家公司。打开看看里面。一百块收入。成本六十。合上它。从外面看。';
function project(elements: any, beats: any[]): string {
  const d = mkdtempSync(join(tmpdir(), 'hj-detail-'));
  mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(SAY)));
  writeFileSync(join(d, 'project.yaml'), YAML.stringify({ title: 't', format: 'portrait', voice: 'voice/alignment.json', sfx: false }));
  writeFileSync(join(d, 'scenes/01-a.yaml'), YAML.stringify({ intent: '测试', elements, beats }));
  return d;
}
const ELS = {
  co: { doodle: 'factory', size: 160, at: [480, 220] },
  inside: { detail: 'co', at: [480, 760], w: 800, h: 520 },
  ax: { axis: [0, 100], length: 600, at: [100, 120], in: 'inside' },
  rev: { span: [0, 100], on: 'ax', at: [0, 140], color: 'blue', in: 'inside' },
  revT: { text: '收入 100', size: 'label', below: 'rev', gap: 12 },
  cost: { span: [0, 60], on: 'ax', at: [0, 340], color: 'red', in: 'inside' },
  out: { text: '盒子', size: 'key', at: [480, 760] },
};
const BEATS = [
  { at: '一家公司', intent: 'x', do: [{ draw: 'co' }] },
  { at: '打开看看', intent: 'x', do: [{ expand: 'inside' }] },
  { at: '一百块收入', intent: 'x', do: [{ grow: 'rev' }, { draw: 'revT' }] },
  { at: '成本六十', intent: 'x', do: [{ grow: 'cost' }] },
  { at: '合上它', intent: 'x', do: [{ collapse: 'inside' }] },
  { at: '从外面看', intent: 'x', do: [{ draw: 'out' }] },
];
const tl = (c: ReturnType<typeof compile>, id: string) => c.tls.find(t => t.el.id === id)!;

test('展开 / 收起：框从那样东西里长出来，引线随后画出；收起时框和框里的东西一起缩回去', () => {
  const c = compile(project(ELS, BEATS));
  assert.deepEqual(c.issues.filter(i => i.level === 'error'), []);
  const fr = tl(c, 'inside'), co = tl(c, 'co'), la = tl(c, 'inside_a'), lb = tl(c, 'inside_b');
  assert.ok(fr.appear && la.drawT0! > fr.appear.t && lb.drawT0! > fr.appear.t, '框先长出来，引线后画');
  const ex = fr.moves[0], start = moveAt(fr, ex.t0), nc = co.el.anchors.center, fc = fr.el.anchors.center;
  assert.ok(Math.hypot(fc[0] + start[0] - nc[0], fc[1] + start[1] - nc[1]) < 2, '展开时从那样东西的中心出发');
  assert.ok(fr.scale[0].from < 0.4 && fr.scale[0].to === 1);
  // 框里的东西：写了 in 的、相对它们定位的标签，都叠在框上，不被避让挤出去；收起时一起走
  for (const id of ['rev', 'revT', 'cost']) { const m = tl(c, id); assert.ok(m.el.over.has('inside'), id); assert.equal(m.el.nudged, undefined, id); assert.equal(m.gone, fr.gone, id); }
  assert.ok(la.gone! < fr.gone!, '引线先消失');
  const end = moveAt(tl(c, 'rev'), fr.gone! - 1e-3), rc = tl(c, 'rev').el.anchors.center;
  assert.ok(Math.hypot(rc[0] + end[0] - nc[0], rc[1] + end[1] - nc[1]) < 120, '收到那样东西身上');
  assert.ok(co.shakes.some(k => k.kind === 'pulse' && k.t0 >= fr.gone! - 0.1), '收起之后它跳一下');
  // 框收起之后，那块地方空出来了：后画的字不用让
  assert.equal(tl(c, 'out').el.nudged, undefined);
});

test('展开 / 收起：写错了会被拦住', () => {
  const errs = (els: any, beats: any[]) => compile(project(els, beats)).issues.filter(i => i.level !== 'info').map(i => i.msg).join('\n');
  assert.match(errs(ELS, [BEATS[0], { at: '打开看看', intent: 'x', do: [{ expand: 'co' }] }]), /expand 的对象是细节框/);
  assert.match(errs(ELS, [BEATS[0], { at: '打开看看', intent: 'x', do: [{ draw: 'inside' }] }]), /用 \{ expand: inside \} 打开/);
  assert.match(errs(ELS, [BEATS[0], { at: '打开看看', intent: 'x', do: [{ draw: 'rev' }] }, { at: '一百块收入', intent: 'x', do: [{ expand: 'inside' }] }]), /在框打开.*之前就画了/);
  assert.match(errs(ELS, [...BEATS.slice(0, 2), { at: '合上它', intent: 'x', do: [{ collapse: 'inside' }] }, { at: '从外面看', intent: 'x', do: [{ grow: 'rev' }] }]), /框在 .* 已经收起了/);
  assert.match(errs(ELS, [{ at: '一家公司', intent: 'x', do: [{ expand: 'inside' }] }]), /要先把 "co" 画出来/);
  assert.match(errs({ ...ELS, inside: { detail: 'nope', at: [480, 760] } }, BEATS), /detail 写要展开的那样东西的 id/);
  const blocked = { ...ELS, other: { text: '挡路', size: 'key', at: [480, 700], overlap: true } };
  assert.match(errs(blocked, [{ ...BEATS[0], do: [{ draw: ['co', 'other'] }] }, ...BEATS.slice(1, 5)]), /细节框打开的时候会盖住 "other"/);
});
