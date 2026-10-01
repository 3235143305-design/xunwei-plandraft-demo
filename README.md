# 寻味 PlanDraft 合成演示

这是一个仅使用 Node.js 与内置 SQLite 的本地合成演示，展示 PlanDraft 草稿的创建、保存、显式恢复和版本冲突保护。页面中的目的地与行程由本地表单合成，不调用地图、天气、路线、大模型或其他真实外部服务，也不需要 API Key。

本候选版由用户确定产品方向，并在 Codex 辅助下实现和整理；不宣称由用户独立手写。

## 环境与范围

- 已知开发环境：Node.js `v26.8.1`。
- 仅监听 `127.0.0.1`；默认端口为 `0`，由操作系统分配并在启动日志中显示。
- 默认数据库：`data/runtime/plan-drafts.sqlite`。可用 `PLAN_DRAFT_DB_PATH` 指定其他本地路径。
- 浏览器只在当前站点的 `localStorage` 中保存草稿入口键 `xunwei.planDraft.active.v1`；完整草稿保存在 SQLite 中。
- 没有登录、用户隔离、真实旅行数据、云同步、部署或公网能力。

## 启动（本机受控路径已验证）

以下命令已在冻结 Node 版本、独占环境和冻结控制器下完成一次受控本机验证：

```bash
npm start
```

控制器确认进程归属为 `npm -> Node` 两成员链；固定检查 `/api/health`、`/`、`/api.js`、`/plan-draft.js` 和 `/plan-draft-demo.js` 均返回 `200`，向已确认归属的 Node 进程发送 `TERM` 后，进程与监听均完成收口。首次真实尝试的门禁要求 `npm + shell + Node` 三成员，但实际仅观察到 `npm -> Node` 两成员，因此以 `unexpected-process-count` 失败；其失败记录仍保留，本次通过不覆盖该记录。

该结论仅说明本机 `npm start` 命令路径在这一次受控验证中通过；它不是人工逐步启动或跨机器“一键复现”证明。

## 数据保留与清理边界

- 停止 Node 进程不会自动删除 SQLite 数据或浏览器入口。
- `data/runtime/`、SQLite 的 WAL/SHM 文件、浏览器 profile、缓存和测试输出不属于可发布源码。
- 需要清理演示数据时，应先停止服务；核对目标只属于候选运行数据后，将明确的候选 `data/runtime/` 或独占浏览器 profile 移入 macOS 废纸篓，不永久删除、不清空废纸篓。归属不确定时保留并报告。
- 浏览器站点入口仍需从该本机站点的站点数据中单独处理；数据库移入废纸篓后，浏览器中残留的入口会失效。发布、复制或清理前必须逐文件复核，`.gitignore` 不能替代敏感信息和运行产物扫描。

## 已有有限证据

以下有限测试已经直接在候选副本运行并通过：PlanDraft 客户端 `13/13`；进程内服务端 wiring `6/6`、health `1/1`、API `4/4`；demo UI 替身 `11/11`；Service `6/6`；隔离临时 SQLite Store `10/10`。

此外，当前 17 文件候选版完成过一次有界真实闭环：使用独立 QA 根和合成输入，由自动化驱动真实 Chrome 按钮，并连接本机 Node 与 SQLite；实际请求顺序为 `POST -> GET -> PATCH`，草稿版本由 `revision 1` 更新至 `revision 2`；SQLite 脱敏核对为单行且 `integrity_check` 返回 `ok`，候选 17 文件前后哈希一致。

浏览器闭环不是人工手点，受控 `npm start` 验证也不是人工逐步启动或跨机器复现。Chrome BrowserContext 之外是否存在外流量仍为 `unknown`；这些结果不构成地图、天气、路线、大模型等外部服务证据，也不证明公网、生产安全或部署可用。原始运行报告和 QA 现场不属于发布源码。

`package.json` 故意不提供统一 `test` 脚本：Store 测试要求调用方先提供独占 `TMPDIR`，在未设计出不会绕开该门禁的统一入口前，不用一个便利脚本伪装安全测试流程。
