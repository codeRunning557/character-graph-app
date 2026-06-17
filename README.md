# Character Graph App

本地人物谱系图应用，面向小说作者整理人物、关系、事件和证据片段。

## 功能

- 导入 TXT/MD 小说文本。
- 按章节切分并调用 OpenAI-compatible 大模型抽取人物关系。
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

## 隐私说明

模型 API Key 保存到 Electron 的用户数据目录，不随项目源码提交。仓库已忽略 `model.config.json`、`graph.sqlite`、导入原文、导出文件、构建产物和安装包。
