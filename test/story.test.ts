import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { fakeAlignment, loadAlignment } from '../src/core/alignment';
import { loadStory, checkStory } from '../src/core/story';
import { compile } from '../src/core/compile';
import { lint } from '../src/core/lint';

const hj = (...a: string[]) => spawnSync(process.execPath, ['bin/hj.mjs', ...a], { encoding: 'utf8' });
const SCRIPT = '你存进银行一百块，钱会变多吗？大多数人以为银行只是保管钱。银行留一成，把剩下的借出去。借出去的钱又存回来。你猜最后能变成多少？\n\n一千块。\n\n所以银行不只是保管钱，它在创造存款。';
const STORY = {
  audience: '存过钱、没想过银行怎么运作的人', myth: '银行只是保管钱', truth: '银行把同一笔钱反复借出，创造了存款', motif: '一条每轮短一截的横条',
  hook: { say: '你存进银行一百块', why: '和他有关' }, predict: { say: '你猜最后能变成多少' },
  aha: { say: '一千块', see: '所有横条汇成一行，数字滚到 1000', move: 'count' },
  land: { say: '它在创造存款', callback: '开头那一百块' },
};
function dir(story: any, script = SCRIPT) {
  const d = mkdtempSync(join(tmpdir(), 'hj-story-'));
  writeFileSync(join(d, 'story.yaml'), YAML.stringify(story));
  writeFileSync(join(d, 'script.txt'), script);
  return d;
}
const errs = (story: any, script = SCRIPT) => { const d = dir(story, script), { story: s, issues } = loadStory(d); return [...issues, ...(s ? checkStory(s, script) : [])].filter(i => i.level === 'error').map(i => i.msg).join('\n'); };

test('创意简报：写对了零错误；四句话要在稿子里、顺序要对、位置要对', () => {
  assert.equal(errs(STORY), '');
  assert.match(errs({ ...STORY, aha: { ...STORY.aha, say: '一万块' } }), /aha.say "一万块" 在稿子里找不到/);
  assert.match(errs({ ...STORY, predict: { say: '它在创造存款' }, land: { say: '它在创造存款', callback: 'x' } }), /predict（让观众猜）要在 aha（揭晓）之前/);
  assert.match(errs({ ...STORY, hook: { say: '借出去的钱又存回来' } }), /钩子在稿子的/);
  assert.match(errs({ ...STORY, land: { say: '把剩下的借出去', callback: 'x' } }), /落点在稿子的/);
  assert.match(errs({ ...STORY, aha: { ...STORY.aha, move: 'draw' } }), /aha.move 写/);
  assert.match(errs({ ...STORY, truth: '银行只是保管钱' }), /myth 和 truth 一样/);
  assert.match(errs({ ...STORY, myth: '很长'.repeat(40) }), /压到 50 个字以内/);
  assert.match(errs({ ...STORY, extra: 1 }), /不认识字段 "extra"/);
  assert.match(errs({}), /简报还是空的/);
  const d = dir(STORY), { story } = loadStory(d);
  const warn = checkStory(story!, SCRIPT.replace('你猜最后能变成多少？', '最后能变成多少。')).map(i => i.msg).join('\n');
  assert.match(warn, /predict.*在稿子里找不到|不是一个问句/);
  // 配了音之后：揭晓前要有停顿
  const f = join(d, 'al.json'); writeFileSync(f, JSON.stringify(fakeAlignment(SCRIPT.replace(/？\n\n一千块/, '一千块'))));
  assert.ok(checkStory(story!, SCRIPT, loadAlignment(f)).some(i => /前面几乎没有停顿/.test(i.msg)));
  const g = join(d, 'al2.json'); writeFileSync(g, JSON.stringify(fakeAlignment(SCRIPT)));
  assert.ok(!checkStory(story!, SCRIPT, loadAlignment(g)).some(i => /前面几乎没有停顿/.test(i.msg)), '断了句就有停顿');
});

test('创意简报是一道闸：没确认不能配音，hj status 先指向导演；确认后改了简报要重新确认', () => {
  const d = mkdtempSync(join(tmpdir(), 'hj-story-gate-'));
  const sf = join(d, 's.txt'); writeFileSync(sf, SCRIPT);
  const p = join(d, 'p');
  assert.equal(hj('init', p, '--script', sf).status, 0);
  assert.match(readFileSync(join(p, 'story.yaml'), 'utf8'), /创意简报/);
  assert.match(hj('status', p).stdout, /现在轮到：导演/);
  assert.notEqual(hj('story', p).status, 0, '模板是空的，不能过');
  writeFileSync(join(p, 'story.yaml'), YAML.stringify(STORY));
  const st = hj('story', p);
  assert.equal(st.status, 0, st.stderr + st.stdout);
  assert.match(readFileSync(join(p, 'story.md'), 'utf8'), /\*\*一千块\*\*/);
  const v = hj('voice', p, '--engine', 'edge');
  assert.notEqual(v.status, 0); assert.match(v.stderr + v.stdout, /创意简报还没有得到用户确认/);
  assert.equal(hj('approve', p, 'story', '--by', '可以').status, 0);
  assert.doesNotMatch(hj('status', p).stdout, /导演/);
  writeFileSync(join(p, 'story.yaml'), YAML.stringify({ ...STORY, motif: '一条会变短的横条' }));
  assert.match(hj('status', p).stdout, /在用户确认之后又改过/);
});

test('简报落到计划和画面：惊叹那一句要单独成段，那一段要用一个“变”的动作', () => {
  const d = mkdtempSync(join(tmpdir(), 'hj-story-plan-'));
  cpSync('examples/one-board', d, { recursive: true });
  const al = loadAlignment(join(d, 'voice/alignment.json')), text = al.units.map(u => u.display).join('');
  writeFileSync(join(d, 'script.txt'), text);
  const story = { ...STORY, hook: { say: '你有没有想过' }, predict: { say: '是怎么越变越多' }, aha: { say: '最多是一千块', see: '数字从 0 滚到 1000', move: 'count' }, land: { say: '只是理论上的上限', callback: '开头的银行' } };
  writeFileSync(join(d, 'story.yaml'), YAML.stringify(story));
  const issues = lint(compile(d));
  const msgs = issues.map(i => `${i.level} ${i.msg}`).join('\n');
  assert.match(msgs, /error 导演定的惊叹点是“最多是一千块”。计划里要有一段正好从这一句开始/);
  // 惊叹点换到计划已有的一段上：这一段的画面用了 count，就过
  writeFileSync(join(d, 'story.yaml'), YAML.stringify({ ...story, aha: { say: '把所有存款加起来', see: '所有横条汇成一行，数字滚到 1000', move: 'count' } }));
  const ok = lint(compile(d)).filter(i => i.level === 'error' && /惊叹/.test(i.msg));
  assert.deepEqual(ok, []);
  // 那一段只画不变：拦住
  const sf = join(d, 'scenes/01-board.yaml');
  writeFileSync(sf, readFileSync(sf, 'utf8').replace('{ count: total, from: 0, dur: 1.6 }', '{ draw: total }'));
  assert.ok(lint(compile(d)).some(i => i.level === 'error' && /全片的揭晓/.test(i.msg)));
});
