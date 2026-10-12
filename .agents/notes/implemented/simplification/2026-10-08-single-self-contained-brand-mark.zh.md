# Agent Note: 单一自包含的品牌标记

Status: implemented

[English](2026-10-08-single-self-contained-brand-mark.md) | 中文

## 问题

界面品牌原来是两份手工制作的 SVG：`FishLogo` 绘制标记，`BrandWordmark` 绘制字形加徽章底板；二者都使用 `currentColor`，因此宿主可以给其中任一重新着色，而展开的侧边栏把二者组合为一个标记加一个独立名称。

替换的标识是一份描摹出来的矢量组合标——上方蓝色标记、下方 `Vreal` 字标。仅标记部分以 `logo-mark.svg` 发布，它自带颜色、不含字形。把组合标渲染进两个品牌 slot 会让展开的侧边栏出现它两次，这对 SVG 所支持的 `currentColor` 重新着色会静默失效，而且在 slot 的 24 px 与 34 px 下字标带只有几个像素高。

## 决策

`FishLogo` 把 `/logo-mark.svg` 渲染为 `<img>`，渲染宽度取 `size` 属性，高度取标记的固有比例。标记渲染空的 `alt`，辅助技术因此跳过它，与它所替换的 `aria-hidden` svg 一致。

`BrandWordmark` 与导出的 `BrandWordmarkProps` 已移除，`includeMark` 选项也随之消失——它原先用于选择旧图形是否显示前置标记。

`OfficialBrandName`——`@vreal/dsh-client-ui-brand-official` 中的 `sidebar.brand.name` 占位者——不渲染任何内容：标记已承载全部识别信息，而保留一个已注册的占位者正是官方构建中抑制 shell `DSH Local Build` fallback 标签的手段；其他构建 profile 仍使用 shell 自身对该 slot 的 fallback。

Web 应用同时把同一个文件作为标签页与安装图标发布，取代此前的按配色方案切换的 favicon，因此一个文件同时服务标记 slot 与两处图标引用。

## 测试

无密钥单元测试固定标记路径、请求宽度、装饰性 `alt` 与空的名称占位者（[icons 用例](../../../../packages/client/ui-primitives/tests/icons.client.spec.tsx)、[品牌占位用例](../../../../packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx)）。展开与收起侧边栏的渲染由[侧边栏快照](../../../../packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap)固定，该快照断言 mark slot 中的 `<img>` 元素。[安装元数据用例](../../../../apps/web/tests/pwa-manifest.e2e.ts)读取构建产物，固定两处图标引用以及标记文件自身承载的颜色。

## 暂缓事项

随素材提供的 `Vreal` 字标尚未进入任何表面：品牌 slot 只渲染标记，因此组合标中的字标部分未被使用。文档站保留自己的标识资产——内联字标与 favicon，二者仍绘制自上一套标识（[文档站笔记](../process/2026-08-12-documentation-site-navigation-and-chrome.zh.md)）。

## 曾考虑的替代方案

**把整份描摹出的组合标发给标记 slot。** 否决：字标带占用文件 124 单位画布中的 16 单位，在 slot 的 24 px 与 34 px 下只有几个像素高。

**在名称 slot 渲染产品名文字。** 否决：这会引入没有设计来源的用户可见文案，而 shell 已经为没有官方占位者的构建渲染文字 fallback。

**保留 `includeMark` 作为被接受的空操作。** 否决：本仓库之外不存在消费者，而一个静默忽略自身参数的参数是兼容垫片，不是契约。

**保留手工 SVG 并为新标识重新着色。** 否决：所提供的素材就是这套标识本身，手工重绘其几何等于用个人近似替代品牌方的原始图形。

## 后果

- 标记无法跟随主题油墨：描摹得到的填充是固定蓝色，在两种配色方案下都可读。Web 图标此前的按配色方案切换填充色也随之一并退场。
- 标记曲线描摹自光栅素材，因此是对所提供几何的近似；品牌方给出矢量导出后可直接替换该文件，无需改动这套组合。
- 组件名 `FishLogo` 与 `.fish*` 类名保留，尽管所绘图形已不是鱼；[rebrand codemod](../../../../scripts/rebrand.ts) 仍把 `FishLogo.tsx` 指为需要替换的图形文件。
