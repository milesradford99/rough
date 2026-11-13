# 画讲（huajiang）—— 给 agent 的工作手册

这个仓库是一个底座：把**带逐字时间表的口播**做成“边画边讲”的手绘视频。
你的任务通常是：用户给你一份口播稿、时间表和配音，你来决定画面上画什么、什么时候画，然后交出成片。

成片的标准只有一条：**看起来像一个真人站在一块白板前，一边讲一边画给你看。**
从一个点切入，在同一块板上把全部内容一点点展开、连到一起，讲完时整块板是一张全景。
不是 PPT 翻页，不是带插图的字幕。

## 铁律

1. **用户确认之前不交付画面。** 流程有两道闸：文字分镜 → 关键帧 → 视频。`hj approve` 只能在用户明确说“可以”之后运行，`--by` 里填用户的原话。不要替用户确认，不要绕过闸门。
   唯一的例外是**草稿关键帧**（`hj stills --draft`）：带水印、半分辨率，是给你自己在交分镜之前检查画面用的。它不是交付物，不能拿去请用户确认关键帧，也不解锁渲染。
2. **画面演示口播，不抄写口播。** 板书只允许关键词、数字、标签。完整的话只出现在字幕里。检查器会拦截照抄口播 7 个字以上的板书。
3. **卡点写口播原文，不写秒数。** `at: "收走一百块税"`，而不是 `at: 31.2`。这样换配音、改语速后分镜自动跟随。
4. **`hj check` 零错误才能往下走**；警告要么修掉，要么向用户说明为什么保留。
5. **先定全景，再动笔。** 写 YAML 之前先填 `outline.md`：整块板最后是一张什么图、分成哪几个区、区和区怎么连、从哪个点切入。见 directing.md 第二节。
6. **一条片子一块板。** 两分钟以内的内容画在同一块板上：画过的东西留在原位，后面的内容对着前面的摆、用线连回去。讲完时整块板是一张信息丰富、值得截图的全景（主体、支撑数字、批注三层都有）。换景靠镜头的远近，不靠换板；擦除可以用，但只在“推翻前面的说法”时用。见 directing.md 第二、四、十一节。
7. **改动要小。** 用户提修改意见时，改对应的那几行，不要重写场景。见 [docs/revising.md](docs/revising.md)。

## 工作流

```bash
npm install                                   # 首次
npx hj init work/<项目名> --voice <配音材料目录> --format portrait
npx hj brief work/<项目名>                    # 逐句时间、停顿、不可靠的字
# 读 docs/directing.md；填 outline.md（全景、分区、怎么连、从哪儿切入）和 cast.yaml（角色表）
# 然后在 work/<项目名>/scenes/ 里一个场景一个文件地写分镜；每写完一个场景：
npx hj layout work/<项目名> --scene <场景>    # 看每个元素落在哪儿、哪儿空哪儿挤（不需要确认，随时跑）
npx hj check work/<项目名>                    # 编译 + 质量检查，随时跑
npx hj stills work/<项目名> --draft           # 草稿关键帧（带水印）：自己逐张看，改到满意。不需要确认
npx hj plan work/<项目名>                     # 生成 storyboard.md
# ── 把 storyboard.md 交给用户，等用户确认 ──
npx hj approve work/<项目名> plan --by "<用户原话>"
npx hj stills work/<项目名>                   # 每拍一张关键帧 + 每场景一张联系表
# 正式关键帧。再看一遍，交给用户，等用户确认
npx hj approve work/<项目名> keyframes --by "<用户原话>"
npx hj render work/<项目名> --draft           # 半分辨率草稿，快
npx hj render work/<项目名>                   # 正式成片 out/video.mp4
```

`work/` 已被 git 忽略：用户的稿子和配音默认不进仓库。

**确认之后还能改吗？** 能。只调位置、大小、颜色、时长、动作细节，不会让确认失效。
改了场景划分、`from`、`intent` 或某一拍的 `at`（也就是“画什么、什么时候画”变了），确认自动失效，需要用户重新确认。

## 一块板长什么样

一个场景文件就是一块板，一条片子通常只有一个。完整的例子在 [examples/one-board/](examples/one-board/)，下面是它的骨架：

```yaml
# scenes/01-board.yaml
from: "你有没有想过"              # 这块板从哪句口播开始
intent: 每一圈的存款是一条横条，左对齐、逐条变短；借出的钱从右侧绕回来变成下一条；最后往下汇成 1000。

regions:                          # 先把板面分区：这是全景的骨架
  top:    [0, 0, 960, 180]        # 谁、往哪儿存
  loop:   [0, 190, 960, 350]      # 第一圈
  stair:  [0, 540, 960, 420]      # 后面几圈
  bottom: [0, 980, 960, 270]      # 汇总

elements:                         # 画什么、放哪儿
  bank: { doodle: bank, size: 140, in: top, at: [120, 100] }     # in: 坐标相对这个分区
  n1:   { text: "100", size: 60, at: [225, 250], anchor: right }
  r1:   { shape: rect, w: 50, h: 50, at: [250, 250], anchor: left, color: red, fill: red }
  l1:   { shape: rect, w: 450, h: 50, at: [r1.right, r1.center], anchor: left, color: blue, fill: blue }
  r2:   { shape: rect, w: 45, h: 50, at: [r1.left, 440], anchor: left, color: red, fill: red }   # 和第一条共用左端这根轴

beats:                            # 什么时候、怎么动、镜头看哪儿
  - at: "假设你存进"
    intent: 板上出现第一条：100
    do:
      - draw: n1
  - at: "也就是十块"
    intent: 近景：推到第一条的左端，涂出红色的一小段
    do:
      - { camera: { focus: [n1, r1], pad: 60 } }
      - draw: r1
  - at: "就这样一圈一圈"
    intent: 拉回全景，后面几条接连长出来
    do:
      - { camera: home }
      - draw: [r2]
```

`regions` 管“板面怎么分”，`elements` 管“是什么、在哪儿”，`beats` 管“什么时候、怎么动、镜头看哪儿”。
坐标可以引用前面的东西（`at: [r1.left, 440]`）：后画的对着先画的摆，位置本身就在说话。

内容多、一屏放不下时，把板放大而不是换板：场景里写 `board: 1.6`，全景是缩小的整块板，近景才是原大。
很长的片子可以分章，一章一块板；确实要一页页陈列（素材展示）就在 `project.yaml` 里写 `layout: pages`。

**框架替你兜底的事**（不需要你自己盯）：

- 元素不会互相重叠、不会出画板：压到了引擎自动挪开，连线自动绕路，批注自动换边。
- 一排人用 `crowd`，永远对齐；分章的片子里前面的图再出现用 `recall`，位置永远一致；角色长相写在 `cast.yaml`，全片一个样；人站在东西上用锚点（`boat.deck`），脚一定落在上面。
- 位置可以不写，引擎自动找空位。拿不准坐标时不写比乱写好。
- 用表现手法时，构图、大小、动作顺序都是现成的。
- 画的速度自动匹配语速。
- 镜头的全景自动对准板上所有内容；推近写 `camera: { focus: 分区或元素 }`，拉回写 `camera: home`。
- 翻页（切成很多块小板）、一块板从头到尾镜头不动、划了分区却空着、结尾没回全景，检查器都会指出来。
- 没处理的质量警告会原样出现在给用户的分镜表里。

## 该读什么

| 你要做的事 | 读 |
|---|---|
| 想清楚每段话画什么（**最重要，先读这个**） | [docs/directing.md](docs/directing.md) |
| 怎么写才能一次做对、每块板都不难看 | directing.md 第五、六节 |
| 查某个字段、动作、元素怎么写 | [docs/reference.md](docs/reference.md) |
| 用户提了修改意见 | [docs/revising.md](docs/revising.md) |
| 要给配音方提要求 / 自己生成配音 | [docs/voice-guide.md](docs/voice-guide.md) |
| 看九种表现手法各长什么样 | [examples/patterns/](examples/patterns/) |
| 看一块板讲完一条片子的完整例子（**照这个写**） | [examples/one-board/](examples/one-board/) |
| 看分页写法的例子（只在分章、陈列时用） | [examples/compound/](examples/compound/) |

找手法和素材：

```bash
npx hj patterns                    # 九种表现手法：自带构图和动作编排（先看这个）
npx hj assets doodles              # 123 个手绘件，和小人同一画风（首选）；`peep-` 开头的是坐、蹲、站、半身的真人插画
npx hj assets icons factory        # 5000+ 线条图标，英文关键词搜索（兜底）
npx hj assets figure               # 小人的姿势、表情、配饰
npx hj assets sheet --out sheet.png   # 把上面这些画成一张图，直接看长相
```

没有合适的素材时，在项目的 `doodles/` 目录里用基本图形自己画一个，或用 `hj import` 从外部素材库转一个进来（两种做法都见 reference），不要用文字顶替。

## 代码地图

```
src/rough/        原 rough.js：把几何图形抖成手绘线（笔画引擎，一般不用动）
src/core/
  alignment.ts    时间表加载、口播锚点解析、字幕切分
  strokes.ts      rough 输出 → 可按时间重放的笔画
  text.ts         手写字体字形 + 按笔顺书写
  figure.ts       火柴人：姿势、表情、配饰、手持物
  patterns.ts     表现手法：九种自带构图与编排的场景骨架
  icons.ts        Tabler 图标
  elements.ts     元素构建与相对布局
  compile.ts      分镜 → 绝对时间线（动作排程、镜头、擦除）
  lint.ts         质量检查、文字分镜表
  render.ts       drawFrame(ctx, 时间线, t)：画面是时间的纯函数；笔触、纸面、涂色的质感都在这里
  sfx.ts          落笔音效合成
src/cli/main.ts   hj 命令
doodles/          内置手绘件
assets/fonts/     手写字体（霞鹜漫黑，OFL）
```

改引擎之后跑 `npm test` 和 `npm run typecheck`。
