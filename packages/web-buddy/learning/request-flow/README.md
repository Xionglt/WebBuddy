# Web-Buddy 请求主链学习骨架

这不是另一个完整 Agent 框架，而是一条可以亲手写完的最小请求链：

```text
POST /api/learning/runs
  -> server.ts                 Node HTTP 适配
  -> create-run-handler.ts     协议校验与错误码
  -> CreateRunUseCase          业务编排与幂等语义
  -> RunRepository             持久化端口
  -> InMemoryRunRepository     第一版内存适配器
  -> HTTP response
```

## 为什么先只做到 queued

真实 Web-Buddy 在创建 Run 后，还会进入 Runtime、工具调用、完成条件校验和恢复链路。第一轮先把“请求能否被正确接受并形成可靠任务记录”写扎实。否则 HTTP、幂等、状态机、Agent Loop、Tool、Memory 一起出现，很难知道错误属于哪一层。

## 你的第一轮任务

按顺序只改两个文件：

1. `src/http/create-run-handler.ts`
   - 完成 `TODO(learning-1)`。
   - 运行 `npm run test:learning-1`，先只让协议层用例通过。
2. `src/application/create-run.ts`
   - 完成 `TODO(learning-2)`。
   - 运行 `npm run test:learning-2`，让创建、重复请求和幂等冲突三个用例通过。

不要先改 Repository，也不要把 HTTP Request 直接传进 UseCase。

## 当前边界

- `InMemoryRunRepository` 只用于单进程练习，进程重启后数据会丢失。
- 当前的 `find -> insert` 还不能抵抗两个并发请求同时创建；数据库版要用唯一约束或原子 `createOrGet`。这是后续 `learning-3`，不是这一轮偷偷忽略的问题。
- 暂时没有认证、Runtime Worker、Tool、Memory 和恢复逻辑。

## 运行方式

```bash
cd packages/web-buddy/learning/request-flow
npm run check
npm run test:learning-1
npm run test:learning-2
npm test
```

当前是刻意保留 TODO 的红灯骨架：`npm run check` 应通过，`npm test` 应失败。你完成两个 TODO 后，再启动真实 HTTP server：

```bash
npm run build
npm start
```

另开终端发送请求：

```bash
curl -i \
  -X POST http://127.0.0.1:4310/api/learning/runs \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-001' \
  -d '{"goal":"Inspect the current page"}'
```

## 写代码时逐行回答这五个问题

1. 这个字段是谁提供的，能不能信？
2. 校验应该属于协议层还是业务层？
3. 请求重试会不会创建两个任务？
4. Repository 换成数据库后，UseCase 是否需要改？
5. 失败最终为什么是 400、409，而不是统一 500？

## 与真实项目的对应关系

| 学习骨架 | 真实 Web-Buddy |
| --- | --- |
| `src/server.ts` | `src/web/server.ts` 中 `POST /api/runs` |
| `createRunHandler` | `handle()` 的认证、读 Body、错误映射 |
| `CreateRunUseCase` | `createRun()` + `RunService.create()` |
| `RunRepository` | `RunStore` 接口 |
| `InMemoryRunRepository` | `FileRunStore` |
| 后续 Runtime Worker | `launchWebTask()` + `runWebTask()` |

## 下一轮再加什么

等这一轮五个测试全绿后，再增加：

```text
queued -> running -> completed / failed
             |
             -> AgentRuntime -> Tool -> Evidence -> CompletionGate
```

下一轮的重点不是“调一个大模型接口”，而是回答：谁有权改变 Run 状态、工具结果怎样成为证据、什么条件才算任务真正完成。
