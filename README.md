# 画讲 huajiang

[![CI](https://github.com/milesradford99/rough/actions/workflows/ci.yml/badge.svg)](https://github.com/milesradford99/rough/actions/workflows/ci.yml)

把一段口播稿做成“边画边讲”的手绘白板视频：像一个人站在白板前，一边讲一边画，画面和声音逐字同步。
成片要体现系统化的思考：观众记住的是一张图，有哪些东西、它们之间什么关系、结论从哪儿连出来。

这个仓库是一个引擎加一个给 AI agent 用的技能。

![成片画面](docs/images/hero.jpg)

## 给 agent 用

把技能装进 agent 的技能目录（下面以 Claude Code 为例，其他 agent 换成它自己的技能目录）：

```bash
git clone https://github.com/milesradford99/rough.git ~/.huajiang
```

```bash
ln -s ~/.huajiang/skills/huajiang ~/.claude/skills/huajiang
```

然后对 agent 说“用画讲把这段稿子做成视频”。技能每次开始工作前会自己检查更新。
不方便软链接的环境，直接把 `skills/huajiang/` 整个目录拷过去也行：技能会把引擎下载到 `~/.huajiang`。

需要 Node.js 20 以上和 ffmpeg；免费配音另需 Python 和 `pip install edge-tts`。

## 它是怎么工作的

```
稿子 ──► 配音 ──► 规划者写计划 ──► 执行者照计划画 ──► 关键帧 ──► 视频
        用户确认①   用户确认②                        用户确认③
       （付费配音前）
```

- **配音**：火山引擎豆包语音（付费）或 edge-tts（免费），产出一条音频和逐字时间表。
- **规划者**交一份 `plan.yaml`：论点、角色、关系、几块板、怎么分区、每段口播往板上添什么。不写坐标。
- **执行者**照计划把每块板画出来。`hj check` 会对照计划检查：角色、关系、卡点、板书有没有照做。

计划长这样：

```yaml
thesis: 银行把同一笔存款反复借出去，你存的 100 块最多能变成 1000 块存款
cast:
  bank: { name: 银行, look: { doodle: bank } }
  me:   { name: 你,   look: { figure: stand } }
relations:
  dep:  { from: me, to: bank, label: 存 }
boards:
  - id: board
    picture: 每一圈的存款是一条横条，逐条变短；借出的钱绕回来变成下一条；最后汇成 1000。
    grid: { areas: [[top], [loop], [stair], [bottom]] }
    regions: { top: 谁往哪儿存, loop: 第一圈, stair: 后面几圈, bottom: 汇总 }
    segments:
      - { at: "假设你存进", act: 例子, in: top, show: [me], link: [dep], words: ["100"], intent: 你把钱存进银行 }
      - { at: "不只是保管钱", act: 结论, in: top, revisit: [bank], words: [创造存款], intent: 回到银行身上：它在创造存款 }
```

完整的例子在 [examples/one-board/](examples/one-board/)。技能的说明在 [skills/huajiang/](skills/huajiang/)；开发这个仓库看 [AGENTS.md](AGENTS.md)。

## 框架保证的事

这些不依赖 agent 有多好的眼光：

| | |
|---|---|
| **不重叠、不出界** | 元素压到别的东西会被自动挪到最近的空位，连线自动绕路，批注自动换边；不写位置的元素自动找空地 |
| **全景和布局** | 板面分区、相对分区的坐标、和前面的东西共用一根轴；板可以比屏幕大，全景缩小、近景原大 |
| **镜头** | 全景自动对准板上所有内容；推近分区或几样东西、拉回全景各一行 |
| **构图和编排** | 九种表现手法各自带一套构图和动作顺序，可以放进一个分区 |
| **同步** | 卡点绑定口播原文；画的速度自动匹配语速；整片和分段渲染的音画对齐有自动测试 |
| **质感** | 手写马克笔字体按真实笔顺写出；墨线有粗细变化；纸面有纹理；马克笔式涂色 |
| **流程** | 三道确认：付费配音前确认朗读稿，动笔前确认计划，渲染前确认关键帧。确认绑定内容的版本，内容变了自动失效 |
| **系统性** | 计划里角色没连成网、分区之间没有连线、整块板一次都不回头、板分得太碎，都会被指出来；只有字的段、照抄口播的板书直接报错 |
| **照计划执行** | 执行者不能增删角色、不能改分区、不能加计划外的长板书；每个角色和每条关系都要在计划的那一段画出来 |
| **质量底线** | 画得太赶、画面静止、信息稀疏、镜头全程不动、结尾没回全景都会警告，没处理的警告如实交给用户 |
| **可返工** | 分区、位置、时间分开写，可以只看一帧、只渲染一段 |

## 九种表现手法

循环流转、两相对比、因果链、柱子被砍、走势、时间线、想法泡泡、等式、怎么分。手法是往全景上添的一块：写 `area: 分区名` 就画在那个分区里。`npx hj patterns <名字>` 会打印参数、步骤和一个能照着改的例子。

![九种表现手法](docs/images/patterns.jpg)

## 内置素材

可摆姿势、换表情、戴配饰、手里拿东西、能走动的火柴人；126 个同一画风的手绘件（含 Claude 像素形象的五个表情，和 32 个 Open Peeps 真人插画：坐、蹲、站、半身）；另有 5000+ 线条图标兜底。不够时用基本图形自己画（一个 YAML 文件），或用 `hj import` 把 Excalidraw 素材库、SVG、Quick Draw 简笔画转进来。

![内置素材](docs/images/assets.jpg)

## 快速开始

需要 Node 20 或更高版本，以及 ffmpeg。渲染不依赖浏览器。

```bash
npm install
```

```bash
npx hj check examples/compound
```

```bash
npx hj stills examples/compound
```

```bash
npx hj render examples/compound
```

成片在 `examples/compound/out/video.mp4`。两个示例都用匀速的假时间表，没有配音：

- `examples/compound`：一段 24 秒的“复利”讲解，两块信息密集的板。
- `examples/patterns`：九种表现手法各演示一遍。

做自己的片子，让 agent 用技能来做（见上文“给 agent 用”）。手工走一遍流程：

```bash
npx hj init work/my-video --script 稿子.txt
```

```bash
npx hj status work/my-video
```

`hj status` 会一步步告诉你接下来该做什么。

## 文档

| | |
|---|---|
| [skills/huajiang/SKILL.md](skills/huajiang/SKILL.md) | 技能入口：流程、铁律、命令 |
| [skills/huajiang/planner.md](skills/huajiang/planner.md) | 规划者：怎么把一段话想成一个系统，`plan.yaml` 的写法 |
| [skills/huajiang/executor.md](skills/huajiang/executor.md) | 执行者：照计划画，怎么摆、怎么动、交图前怎么自查 |
| [skills/huajiang/voice.md](skills/huajiang/voice.md) | 配音：朗读稿怎么写，火山引擎和 edge-tts 的用法与参数 |
| [skills/huajiang/revising.md](skills/huajiang/revising.md) | 返工：修改意见该谁改、改哪儿 |
| [skills/huajiang/reference.md](skills/huajiang/reference.md) | 字段参考 |
| [AGENTS.md](AGENTS.md) | 开发这个仓库：设计准则、代码地图 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

## 现状与边界

- **已验证**：全部引擎功能有自动测试（单元测试加端到端测试），含流程闸门、自动避让、九种手法在竖屏和横屏下展开、带音频渲染的音画对齐。两个示例在竖屏下逐帧人工看过，手法一览在横屏下也看过。
- **尚未验证**：还没有用真实配音完整做过一条正式的片子。同步的机制经过了测试，但卡点“听起来对不对”需要真实配音来检验。
- **音效是合成的**：默认是稀疏的短促落笔声。它不如真实录音自然，可以用 `sfxSamples` 换成自己的录音，或用 `sfx: false` 关掉。
- **配音**：火山引擎的协议用本地模拟的服务端测过，没有在这个仓库的测试里真调过付费接口；edge-tts 实测可用，但它是微软的非官方接口，可能随时变。
- **不支持**：真人出镜；录屏和视频片段（只能贴静态图片）；浏览器实时预览；小人的侧脸。仓库不附带背景音乐，`music` 用你自己有权使用的文件。
- 元素移动之后，先前画好的箭头和标记不会跟着走。
- 一块板挤到找不到空位时，引擎会报警告而不是缩小元素。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run check:examples
```

## 致谢与许可

MIT 许可。笔画引擎来自 [rough.js](https://github.com/rough-stuff/rough)（MIT，Preet Shihn），本仓库由它的 fork 改造而来，原引擎保留在 `src/rough/`。
文字使用 [霞鹜漫黑](https://github.com/lxgw/LxgwMarkerGothic)（SIL OFL 1.1），笔顺数据来自 [Make Me a Hanzi](https://github.com/skishore/makemeahanzi)，图标来自 [Tabler Icons](https://github.com/tabler/tabler-icons)。完整清单见 [THIRD_PARTY.md](THIRD_PARTY.md)。
