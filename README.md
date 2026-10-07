# NotionAI++

Notion AI 的插件化用户脚本（仓库名 NotionPP）。单个脚本，按插件开关，所有设置集中在一个弹窗里。

[安装 / 更新](https://raw.githubusercontent.com/0-V-linuxdo/NotionPP/main/userscript/NotionPP.user.js)（需要 Tampermonkey / Violentmonkey 等脚本管理器）

## 插件

| 插件 | 作用 |
| --- | --- |
| AI 用量 | 显示 6 小时与月度用量、套餐与试用状态；最小化后双圆环贴在 AI 输入框底部中央，跟随布局变化与对话切换 |
| 对话目录 | 对话右侧的 Notion 风格目录，悬停展开，点击跳到对应提问或回复；自动避开右侧面板 |
| 自动折叠 AI 思考 | 回复完成后折叠「N steps」思考步骤，手动展开过的不再折叠 |
| 输入框高亮色 | 自定义 AI 输入框获得焦点时的高亮色，浅色 / 深色主题分别设置；在输入框右侧双击右键打开调色面板 |
| 问候语自定义 | 自定义 Notion AI 首页问候语，支持多条文案、随机 / 顺序轮播、点击或定时切换 |

设置入口：用量面板里的齿轮按钮，或脚本管理器菜单「⚙️ NotionAI++ 设置」。

安装后请停用单独安装的 usage、导航目录、Focus Highlight Color、Greeting Customizer 脚本，避免重复处理。

## 隐私

- 只调用 Notion 同源接口（`getCreditRateLimitStatus`、`getBillingData`），浏览器自带登录状态，不读取、不保存、不发送 Cookie 或 token。
- 不访问任何第三方服务器。

## 开发

```sh
bun install
bun run check   # tsc + 单元测试 + 构建
bun run build   # 生成 userscript/NotionPP.user.js
```

结构参考 VoidPP：`src/api` 为插件管理、设置、网络 / 路由 / DOM / 主题观察器与 Shadow DOM 浮层；`src/plugins/*` 每个目录一个插件。功能规格与验收记录见 `docs/`。

## 许可

MIT
