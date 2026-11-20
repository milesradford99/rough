import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { fakeAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';
import { THEME } from '../src/core/theme';

const SAY = '顾客。一家店。线平着。突然冲起来。连起来。';
function project(meta: any, elements: any, beats: any[]): string {
  const d = mkdtempSync(join(tmpdir(), 'hj-ink-'));
  mkdirSync(join(d, 'voice')); mkdirSync(join(d, 'scenes'));
  writeFileSync(join(d, 'voice/alignment.json'), JSON.stringify(fakeAlignment(SAY)));
  writeFileSync(join(d, 'project.yaml'), YAML.stringify({ title: 't', format: 'portrait', voice: 'voice/alignment.json', sfx: false, ...meta }));
  writeFileSync(join(d, 'scenes/01-a.yaml'), YAML.stringify({ intent: '测试', elements, beats }));
  return d;
}
const tl = (c: ReturnType<typeof compile>, id: string) => c.tls.find(t => t.el.id === id)!;
const lineColors = (c: ReturnType<typeof compile>, id: string) => new Set(tl(c, id).el.strokes.filter(s => s.kind === 'line' && !(s as any).under).map(s => (s as any).color));

test('克制墨线：手绘件的轮廓用墨、底色是淡彩，没有马克笔笔道和阴影；不写 style 的老项目照旧', () => {
  const els = { car: { doodle: 'car', size: 200, at: [480, 400] } }, beats = [{ at: '顾客', intent: 'x', do: [{ draw: 'car' }] }];
  const ink = compile(project({ style: 'ink' }, els, beats));
  assert.equal(THEME.style, 'ink');
  assert.deepEqual([...lineColors(ink, 'car')].filter(c => c !== THEME.paper), [THEME.ink], '轮廓只有墨色');
  const strokes = tl(ink, 'car').el.strokes;
  assert.ok(!strokes.some(s => (s as any).flat), '没有马克笔笔道，也没有阴影');
  assert.ok(strokes.some(s => s.kind === 'fill' && s.color !== THEME.colors.blue), '底色是压淡了的颜色');
  const old = compile(project({}, els, beats));
  assert.equal(THEME.style, 'color');
  assert.ok(lineColors(old, 'car').has(THEME.colors.blue), '彩色画风的车还是蓝的');
});

test('折线图比高低：同一个比例尺，同一个数一样高；数据变了图不挪地方', () => {
  const els = {
    a: { chart: 'line', axes: false, smooth: true, w: 600, range: [80, 140], perUnit: 2, base: 100, data: [100, 100, 110, 100], at: [480, 200] },
    b: { chart: 'line', axes: false, smooth: true, w: 600, range: [0, 300], perUnit: 2, base: 100, data: [100, 100, 260, 100], at: [480, 700] },
  };
  const beats = [
    { at: '顾客', intent: 'x', do: [{ draw: ['a', 'b'] }] },
    { at: '突然冲起来', intent: 'x', do: [{ change: 'b', to: { data: [100, 100, 100, 260] } }] },
  ];
  const c = compile(project({ style: 'ink' }, els, beats));
  assert.deepEqual(c.issues.filter(i => i.level === 'error'), []);
  const A = tl(c, 'a').el, B = tl(c, 'b').el;
  assert.equal(A.box.h, 120); assert.equal(B.box.h, 600); // 高度 = 范围 × perUnit
  // 两张图上 +10 和 +160 的高度比就是 1 : 16
  const peak = (e: typeof A) => { const p = e.path!; let lo = Infinity; for (let i = 1; i < p.length; i += 2) lo = Math.min(lo, p[i]); return lo; };
  const baseY = (e: typeof A, v: number, r: [number, number]) => e.box.y + e.box.h - ((v - r[0]) / (r[1] - r[0])) * e.box.h;
  const ra = baseY(A, 100, [80, 140]) - peak(A), rb = baseY(B, 100, [0, 300]) - peak(B);
  assert.ok(Math.abs(rb / ra - 16) < 0.6, `比例 ${rb / ra}`);
  assert.equal(tl(c, 'b').morphs.length, 1);
});

test('连线的途经点：一条顺滑的线依次穿过写的点；写错了会被拦住', () => {
  const els = { p: { text: '起', at: [200, 200] }, q: { text: '止', at: [700, 1000] }, whip: { line: ['p', [300, 500], [600, 700], 'q'], color: 'red' } };
  const beats = [{ at: '顾客', intent: 'x', do: [{ draw: ['p', 'q'] }] }, { at: '连起来', intent: 'x', do: [{ draw: 'whip' }] }];
  const c = compile(project({ style: 'ink' }, els, beats));
  assert.deepEqual(c.issues.filter(i => i.level === 'error'), []);
  const path = tl(c, 'whip').el.path!, near = (x: number, y: number) => { for (let i = 0; i < path.length; i += 2) if (Math.hypot(path[i] - x, path[i + 1] - y) < 3) return true; return false; };
  assert.ok(near(300, 500) && near(600, 700), '穿过每个途经点');
  const bad = compile(project({}, { ...els, whip: { line: ['p'] } }, beats));
  assert.match(bad.issues.map(i => i.msg).join('\n'), /中间可以再写几个途经点/);
});
