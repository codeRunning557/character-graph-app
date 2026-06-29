# Character Graph App

本地人物谱系图应用，面向小说作者整理人物、关系、事件和证据片段。

## 功能

- 导入 TXT/MD 小说文本。
- 按章节切分并调用 OpenAI-compatible 大模型抽取人物关系。
- 生成任务默认 3 路并发，支持失败重试、超长章节分段、暂停、继续、取消和断点续跑。
- 实时显示已处理章节、生成耗时和预计剩余时间。
- 生成诊断面板按章节显示候选状态、抽取人物、抽取关系、正式入图事件和被隐藏人物。
- 默认支持 DeepSeek，可配置 Kimi、通义千问、智谱、豆包、MiniMax、SiliconFlow、Ollama 和自定义端点。
- 抽取结果进入候选区，确认后写入正式图谱。
- 使用平面线性关系图展示人物节点和两人之间的唯一关系线。
- 点击人物或关系线查看详情、事件和证据。

## 本地开发

```bash
npm install
npm run dev
```

## 构建 Windows 安装包

```bash
npm run dist:win
```

构建前会自动清理旧的 `release` 目录。

## 在线 Web 版

```bash
npm run build:web
npm run web
```

默认访问地址是 `http://localhost:4173`。Web 版数据保存到 `web-data/`，可通过 `CHARACTER_GRAPH_WEB_DATA` 指定其他数据目录：

```bash
CHARACTER_GRAPH_WEB_DATA=/data/character-graph PORT=4173 npm run web
```

## 隐私说明

模型 API Key 保存到 Electron 的用户数据目录或 Web 版后端数据目录，不随项目源码提交。仓库已忽略 `model.config.json`、`graph.sqlite`、`web-data/`、导入原文、导出文件、构建产物和安装包。
