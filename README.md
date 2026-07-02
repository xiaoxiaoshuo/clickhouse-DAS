# ClickHouse DAS

一个轻量级 ClickHouse 数据治理控制台，首个功能是 SQL 执行记录审计。

## 功能

- 连接 ClickHouse 并读取 `system.query_log`
- 按时间、用户、库名、客户端 IP、关键字、状态筛选 SQL 记录
- 展示总查询数、失败数、平均耗时、扫描行数
- 查看单条 SQL 明细和异常信息
- 展示活跃用户排行
- 慢 SQL 看板：按阈值定位慢 SQL、聚合问题 SQL 模板、展示最慢明细
- 预留权限治理、资产画像、风险规则等治理模块入口

## 运行

```bash
npm install
npm run dev
```

默认访问地址：

```text
http://localhost:3020
```

连接配置在 `.env` 中。`.env` 已加入 `.gitignore`，不要提交真实账号密码。
