# Futures Quant Agent MVP

一个本地可运行的期货量化智能体原型，面向期货数据研究、特征工程、模型训练、回测诊断、风控检查和大模型辅助分析。

- 9000 端口深色金融风格前端
- OpenAI-compatible 大模型接口配置页，可替换任意兼容服务
- 官方开源期货数据下载器（Binance Data Vision USD-M Futures）
- 特征工程、逻辑回归训练、时间切分评估、简化回测
- 数据摘要、训练报告、风控检查、智能体对话
- Codex Skill 示例与 Word 开发说明

## 安全说明

仓库内不包含任何真实大模型 API Key。请在前端“模型配置”页填写自己的 `baseUrl`、`apiKey` 和 `model`，或复制 `config/model.example.json` 自行配置。

## 运行

```powershell
npm start
```

浏览器打开：

```text
http://localhost:9000
```

## 训练

前端点击“运行训练”，或命令行：

```powershell
npm run train
```

数据会缓存到 `data/market-cache.json`，训练结果保存到 `artifacts/training-report.json`。

## 重要边界

本项目是研究和工程原型，不构成投资建议。智能体不会直接下单；任何实盘交易都应接入独立风控服务、审批流程、交易网关和审计日志。
