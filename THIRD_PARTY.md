# 第三方组件

除特别注明外，以下组件通过 npm 依赖安装，不在本仓库内分发。

| 组件 | 用途 | 许可 |
|---|---|---|
| [rough.js](https://github.com/rough-stuff/rough) | 手绘线条生成。源码在 `src/rough/`，由本项目维护 | MIT，© Preet Shihn |
| [霞鹜漫黑 LXGW Marker Gothic](https://github.com/lxgw/LxgwMarkerGothic) | 全部文字的字形（手写马克笔体）。**字体文件随仓库分发**，在 `assets/fonts/`，附许可全文 `OFL.txt` | SIL OFL 1.1 |
| [hanzi-writer-data](https://github.com/chanind/hanzi-writer-data) | 9500+ 汉字的笔顺中线（只用来决定书写顺序，不用其字形），数据来自 [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) | Arphic Public License |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | 线条图标 | MIT |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | 画布（Skia） | MIT |
| opentype.js、yaml、tsx、path-data-parser、points-on-curve、points-on-path、hachure-fill | 工具库 | MIT |

用本项目生成的视频包含上述字形和图标的渲染结果，OFL 与 MIT 均允许这样使用。

## 导入的手绘件

`doodles/` 里带 `source:` 一行的文件是从 [Excalidraw Libraries](https://github.com/excalidraw/excalidraw-libraries)（MIT，© 2020 Excalidraw 及各素材库作者）转换来的：只取了几何形状，重新命名、改色，由本项目的笔重画。每个文件的 `source:` 记着它出自哪个素材库。目前 36 个，来自 Artem's icons（Artem Anufrij）、Icons（xxxdeveloper）、Awesome Icons（ferminrp）、Tools（pixelass）、Boardgame（pocomane）。

用 `hj import quickdraw` 导入的简笔画来自 [Quick Draw Dataset](https://github.com/googlecreativelab/quickdraw-dataset)（Google，CC BY 4.0）；仓库里目前没有内置这类素材，自己导入并用在成片里时需要署名。

`doodles/peep-*.yaml` 共 32 个，是 [Open Peeps](https://www.openpeeps.com/)（Pablo Stanley，CC0 1.0，公共领域）的人物拼出来的：头、脸、身体按部件组合，被头遮住的身体线条裁掉后，用 `hj import svg` 转成手绘件，只取墨块和填充的形状，由本项目的笔重画。部件取自 npm 上的 `react-peeps`（MIT，Emre Çakır，只是把 Open Peeps 的图形包成了 React 组件）。CC0 的授权依据是 Open Peeps 原作者署名和 CC0 声明（见 `@dicebear/open-peeps` 的 LICENSE：“Designer: Pablo Stanley，License: CC0 1.0”）。CC0 不要求署名，但每个文件的 `source:` 仍记着出处。

## 品牌形象

`doodles/claude*.yaml` 画的是 Anthropic 的 Claude 像素形象，形象归 Anthropic 所有，不在本项目的开源许可范围内。只用于在视频里指代 Claude 这款产品，不要让画面看起来像官方出品或官方代言。
