# Web Agent Console 问题记录

记录时间：2026-06-18

测试上下文：
- Web 控制台：`http://localhost:5179/`
- 测试目标：阿里招聘网站 Alibaba preset
- 测试简历：`/Users/sunqiankai/唐哥简历.pdf`
- 成功跑通的测试 run：`runtime-2026-06-18T07-35-18-754Z`
- Trace 目录：`output/traces/claude_2026-06-18T07-35-19-374Z`
- 最新真实投递体验 run：`runtime-2026-06-18T07-44-10-627Z`
- 最新 Trace 目录：`output/traces/claude_2026-06-18T07-44-11-428Z`
- 最新 Runtime 目录：`output/claude-runtime/2026-06-18T07-44-11-428Z`
- 安全备注：本文档不记录 API key 明文，也不应在后续 issue / log 中粘贴任何密钥。

## 优先级拆分

### S0 - 下一次真实投递前必须完成

这些问题会直接影响真实投递结果、用户信任或隐私安全，未修复前不建议继续用真实账号做正式投递。

1. **以本次传入简历为准的投递闸门**
   - 对应问题：18、19、20。
   - 目标：只要用户提供了 `resumePath`，就必须先完成上传、解析、字段检查，才能点击最终投递。
   - 验收：trace 中能看到本次文件的 `browser_upload_file` 或明确的等价上传动作；未满足 `providedResumeUploaded / resumeParsed / requiredFieldsChecked` 时，提交按钮点击会被 wrapper 拦截。

2. **高风险提交必须交给 Web UI 确认**
   - 对应问题：2、8、25。
   - 目标：区分“演示到提交前”“提交前请求确认”“允许真实提交一次”三种模式。
   - 验收：真实投递前 UI 必须展示目标站点、按钮文本、将发送的数据来源；用户确认后才允许 `confirmed=true`。

3. **完成态必须有页面证据**
   - 对应问题：21。
   - 目标：不能因为点过按钮或跳过页面就显示 `COMPLETED`。
   - 验收：只有看到“投递成功 / 申请已提交 / 已申请列表出现该岗位”等明确页面信号才显示完成；浏览器关闭、风控中断或无法验证时显示 `INCOMPLETE` 或 `NEEDS_CONFIRMATION`。

4. **隐私脱敏先于展示和落盘**
   - 对应问题：1。
   - 目标：Web timeline、stdout 普通日志、trace 摘要默认不展示手机号、邮箱、姓名、地址等敏感信息。
   - 验收：普通 UI 和默认日志中只出现脱敏值；完整原始内容只能在显式 debug 模式下保存。

### S1 - MVP 体验稳定优先

这些问题不一定导致错误投递，但会明显影响用户能否顺畅完成一次任务。

1. **固定 Web Console 三栏布局，避免左侧配置栏消失**
   - 对应问题：22。
   - 目标：任务运行和结束后，左侧配置、运行按钮、继续按钮始终可见或可明确打开。
   - 验收：长 timeline 下页面不整体被撑高；`aside`、timeline、trace 面板各自滚动。

2. **Handoff 文案和状态中文化**
   - 对应问题：6、13。
   - 目标：用户清楚知道要去哪个窗口登录、完成后点哪个按钮继续、停止会清理什么。
   - 验收：blocked 状态显示中文说明；按钮改为“我已完成登录，继续任务”；Stop 清理语义明确。

3. **运行历史和最新 run 恢复**
   - 对应问题：16、24。
   - 目标：刷新页面后能找回刚才的 run，不丢 trace 和状态。
   - 验收：UI 显示最近运行列表；默认选中最近启动或最近更新的 run。

4. **不把回合数不足当成普通失败**
   - 对应问题：7、11。
   - 目标：长任务期间有 heartbeat；max turns 不足显示为可继续的 `incomplete`。
   - 验收：模型长时间思考时 UI 有活跃状态；回合数不足时提供“一键继续”。

### S2 - 运维和调试可靠性

这些问题主要影响开发调试、配置稳定性和问题复盘。

1. **多服务实例和端口状态可见**
   - 对应问题：23。
   - 目标：避免 5178 / 5179 同时运行导致用户看错实例。
   - 验收：启动时检测旧实例；UI 显示当前端口和启动时间；提供停止旧实例的脚本或提示。

2. **API key 和 provider 配置稳定**
   - 对应问题：3、4、14。
   - 目标：重启后配置不意外丢失，空 key 保存不覆盖已有 key，协议语义清楚。
   - 验收：有配置持久化选项；有空 key 不覆盖回归测试；UI 明确标注 Anthropic-compatible endpoint。

3. **允许域名和登录域名策略清楚**
   - 对应问题：12。
   - 目标：用户知道 agent 访问了哪些域，登录跳转不会被误拦或静默放行。
   - 验收：Alibaba preset 默认包含招聘域和登录域；跨域跳转在 timeline 中可见。

4. **Trace 可诊断性增强**
   - 对应问题：9、10、17。
   - 目标：不用回文件系统也能看关键 span、错误、成本、截图。
   - 验收：Trace 面板支持详情展开、过滤、成本 token 汇总和关键截图预览。

### S3 - 产品 polish

这些问题可以放到核心闭环稳定之后做。

1. **用户进度流和开发者 trace 分层**
   - 对应问题：5。
   - 目标：普通用户看“正在做什么”，开发者再展开原始工具调用。

2. **全量中文化和文案统一**
   - 对应问题：15。
   - 目标：按钮、状态、错误、handoff、确认弹窗统一为中文表达。

## 问题列表

1. **P0 - stdout / timeline 存在简历隐私泄露风险**
   - 现象：运行过程中，模型 thinking / stdout 曾输出从简历解析出的姓名、邮箱、电话、技能等信息。
   - 影响：虽然 trace session 的部分字段有 redaction，但 `stdout.log`、Web timeline、stream-json 原始输出仍可能出现 PII。
   - 建议：在写入 UI timeline 和普通日志前增加统一脱敏层；默认隐藏邮箱、手机号、姓名、地址等字段。完整原始日志仅允许显式 debug 模式保存，并在 UI 中提示风险。

2. **P0 - 高风险网页动作缺少 Web 侧用户确认**
   - 现象：agent 在测试流程中点击了 `投递简历`，该按钮被 MCP 标记为 L3 高风险；第一次点击被拒绝后，模型自行用 `confirmed=true` 重试。
   - 影响：不同网站上“投递/申请”按钮可能直接产生外部副作用。当前 Web 控制台没有把这个确认权交给用户。
   - 建议：在 runtime wrapper 或 MCP tool 层拦截 L3/L4 动作，向 Web UI 发出确认事件；用户点击确认后才允许继续。确认文案必须说明目标网站、按钮文本和可能发送的数据。

3. **P1 - API key 只保存在 Web server 内存中**
   - 现象：智谱 `claude-code-runtime` key 配置成功后，重启 Web server 会回到 `key: NOT SET`。
   - 影响：每次重启都要重新从 BigModel 页面取 key，体验断裂。
   - 建议：增加显式的“保存到本地配置”能力，可写入 repo `.env` 或用户目录安全配置文件。UI 要保持 masked 展示，不把 key 写入 trace、stdout 或普通日志。

4. **P1 - 空 API key 保存曾清空已有 key，需要补回归测试**
   - 现象：Web UI 点击 Run 前会调用 `saveConfig()`；当 key 输入框为空时，旧实现会让后端配置丢失 key，导致 `Missing model credential`。
   - 当前状态：已修改为后端合并 `modelOverride`，空 key 不覆盖已有 key。
   - 建议：补一个 HTTP/API 回归测试：先 POST 带 key 的配置，再 POST 空 key 的配置，确认 `/api/config` 仍返回 `hasKey=true`。

5. **P1 - Timeline 太原始，用户进度和开发者 trace 混在一起**
   - 现象：timeline 同时显示 stdout、assistant thinking、tool_use、tool_result、result、handoff 等事件。
   - 影响：对开发者有信息量，但普通用户很难判断“现在做到哪一步、是否需要我操作”。
   - 建议：拆成两层：默认显示“用户可读进度流”，例如“打开网站 / 找到岗位 / 进入详情 / 等待登录”；高级面板再显示原始 trace 和 JSON。

6. **P1 - Handoff 体验还不够面向用户**
   - 现象：到达登录页后，Web UI 进入 `blocked` 并显示 `Continue After Handoff`，但提示文案仍偏英文和工程化。
   - 影响：用户可能不知道应该去哪个浏览器窗口登录、登录完成后该点哪里、点了 Continue 会发生什么。
   - 建议：中文化并强化 blocked 状态：显示“请在弹出的阿里登录窗口完成登录，然后点击继续”；按钮改为“我已完成登录，继续任务”；附带“停止任务”入口。

7. **P1 - maxTurns 不足时错误语义不清晰**
   - 现象：上一次 `maxTurns=8` 时任务在投递入口附近停止，UI 显示 failed。
   - 影响：用户会误以为模型或网站失败，其实只是 turn budget 不够。
   - 建议：识别 `error_max_turns`，在 UI 显示为 `incomplete` 或 “回合数不足”，并提供“一键继续 / 提高 max turns 后继续”。

8. **P1 - Prompt 安全边界需要更精细**
   - 现象：测试 prompt 写了“不要最终提交真实投递”，但模型仍将点击 `投递简历` 理解为可执行的流程验证。
   - 影响：在部分网站中，“投递简历”可能就是最终提交动作。
   - 建议：把 prompt 分为操作策略和安全策略。安全策略明确：未得到 Web 用户确认前，不点击任何可能发送简历、创建申请、提交表单的按钮。

9. **P2 - Trace 面板只有列表，不够可诊断**
   - 现象：右侧 Trace Spans 当前主要显示 span 类型、名称、耗时，缺少详情展开。
   - 影响：需要回到文件系统看 `spans.jsonl` / `events.jsonl` 才能定位问题。
   - 建议：增加 span 详情抽屉，显示 input/output 摘要、状态、错误、耗时、parent/child 关系；增加按 `llm_call`、`mcp_tool_call`、`runtime_event` 过滤。

10. **P2 - 缺少运行成本和 token 摘要**
    - 现象：stream-json result 里有 `total_cost_usd`、token usage，但 Web UI 没有汇总展示。
    - 影响：用户无法感知一次运行的成本和 token 消耗。
    - 建议：在 Run inspector 中增加 cost、input/output/cache tokens、model、duration、turns。

11. **P2 - 长响应期间缺少 heartbeat**
    - 现象：智谱模型某些阶段响应较慢，timeline 会数十秒不更新。
    - 影响：用户可能以为页面卡住。
    - 建议：runtimeRuns 增加 heartbeat event，UI 显示 elapsed time、当前 pass、最近一次事件时间和“模型正在思考/工具正在执行”状态。

12. **P2 - 允许域名和登录跳转域名关系不清晰**
    - 现象：运行配置显示 allowed domains 为 `talent-holding.alibaba.com`，但点击投递后跳到 `mozi-login.alibaba-inc.com`。
    - 影响：如果未来严格执行域名白名单，登录流程可能被误拦；如果不拦，UI 又会让用户误以为只访问了一个域名。
    - 建议：在 Alibaba preset 中显式列出相关登录域名，或在跳转跨域时向 UI 记录“已跳转到登录域”事件。

13. **P2 - Run / Stop / Continue 状态需要更严谨**
    - 现象：blocked 后 wrapper 仍在等待 continue 文件；Stop 是否会关闭 handoff browser、清理子进程和 storage state，目前 UI 没有说明。
    - 影响：用户可能留下后台进程或浏览器窗口。
    - 建议：Stop 文案改为“停止并关闭浏览器”；停止后确认子进程组、browser session、SSE subscriber 都被清理。

14. **P2 - 配置表单缺少 provider 语义**
    - 现象：UI 文案显示 `Model endpoint` / `Model`，但 saveConfig 固定按 Anthropic-compatible 写入。
    - 影响：用户可能填 OpenAI endpoint 后误用 Anthropic 协议。
    - 建议：增加 provider 选择或固定文案为“Anthropic-compatible endpoint”；BigModel preset 可以一键填充 `https://open.bigmodel.cn/api/anthropic` + `glm-4.7`。

15. **P3 - UI 中英文混杂**
    - 现象：按钮和状态包含 `Run Agent`、`Refresh Trace`、`Continue After Handoff`、`blocked` 等英文。
    - 影响：面向中文用户时不够自然。
    - 建议：做一版中文 UI 文案：运行任务、刷新 Trace、我已完成登录、停止任务、等待人工处理等。

16. **P3 - 缺少运行历史入口**
    - 现象：后端有 `/api/runtime/runs`，但 UI 没有历史 run 列表。
    - 影响：刷新页面后不容易找回刚才的 run、trace、runDir。
    - 建议：左侧或右侧增加最近运行列表，支持点击恢复 run 状态和 trace。

17. **P3 - 缺少截图/页面状态可视化**
    - 现象：MCP 有 `browser_screenshot` 工具，但 Web UI 没有展示当前浏览器截图。
    - 影响：用户只能从文字 timeline 推断网页操作过程。
    - 建议：增加“当前页面预览”区域，展示关键截图或最后一次 screenshot；没有截图时提供按钮触发截图工具。

18. **P0 - 提供新简历后仍可能直接用网站已有简历投递**
   - 现象：最新真实投递体验中，用户提供了 `/Users/sunqiankai/唐哥简历.pdf`，但 trace 中没有实际 `mcp__playwright__browser_upload_file` 调用；agent 在确认弹窗中直接点击了 `投递`。
   - 证据：最新 run 的 stream 里只出现了 `browser_click` / `browser_form_snapshot` / `browser_screenshot` 等工具调用，没有 `browser_upload_file`；第 3 轮先点击 `投递简历`，随后点击确认弹窗里的 `投递`。
   - 影响：如果招聘网站账号里已有旧简历，系统会用旧资料直接完成投递；这与用户“以本次传入简历为准”的预期不一致，且会造成真实外部副作用。
   - 建议：当 `resumePath` 存在时进入 `resume-first` 模式：必须上传本次文件、等待解析、检查解析结果、补齐必填字段后，才允许点击任何最终投递按钮。

19. **P0 - 提交前缺少硬性投递闸门**
   - 现象：当前安全策略主要依赖 prompt 提醒模型“优先上传简历”，但 runtime / tool 层没有状态机阻止提交。
   - 影响：模型只要判断“流程已到确认弹窗”，就可能用 `confirmed=true` 点击提交，绕过用户希望的简历解析和表单检查步骤。
   - 建议：增加提交闸门状态，例如 `providedResumeUploaded=true`、`resumeParsed=true`、`requiredFieldsChecked=true`、`userSubmitApproved=true`。当用户提供了简历文件但这些条件未满足时，MCP wrapper 应拒绝 `投递 / 提交 / 确认投递` 等高风险点击。

20. **P1 - `form_snapshot` 的 `uploadHints` 存在误判**
   - 现象：最新 run 的 `form_snapshot` 返回 `1 upload hints`，但实际 hint 是按钮文本 `投递简历`，不是文件上传入口。
   - 影响：模型可能被误导，以为已经识别到“上传相关入口”，但没有真正发现 `<input type=file>` 或上传简历按钮。
   - 建议：调整 `uploadHints` 规则：只把 `input[type=file]`、明确的“上传 / 选择文件 / 附件简历 / 重新上传 / 简历解析”等入口标记为上传；`投递简历` 应归类为 submit-like high-risk action，不应作为 upload hint。

21. **P1 - 完成态判断过于乐观**
   - 现象：最新 run 在点击确认投递后跳到个人中心附近，但随后浏览器会话被关闭，截图和重新打开页面都失败；agent 仍输出 `AGENT_STATUS=COMPLETED`。
   - 影响：Web UI 显示 `done` 会让用户误以为已经确认投递成功，但实际上缺少“投递成功 / 申请已提交 / 已申请列表出现该岗位”等最终证据。
   - 建议：完成条件必须绑定可验证页面信号；如果浏览器关闭或风控中断发生在最终确认前，应标记为 `INCOMPLETE` 或 `NEEDS_CONFIRMATION`，并提示用户去个人中心确认。

22. **P1 - Web 左侧配置栏在任务结束后可能从视野中消失**
   - 现象：用户体验中，任务结束后 Web 界面左侧似乎消失。初步检查新开页面时左侧 DOM 仍存在，基础 CSS 没有被删除。
   - 可能原因：当前 `.app` 使用 `min-height: 100vh`，timeline 事件很多时整页高度被撑大；页面滚动位置可能落在中下部，导致左侧顶部配置区不在视野内。窄屏断点下 `.app { display: block; }` 也会让左侧配置区排在主内容上方，更像“消失”。
   - 影响：用户在结束态无法快速修改参数、重新运行、继续查看配置，体验割裂。
   - 建议：改为固定工作台布局：`.app { height: 100vh; overflow: hidden; }`，`aside`、`main .timeline`、`.inspect` 分别内部滚动；同时在移动宽度下提供显式 tabs 或抽屉，不让左侧自然滚走。

23. **P2 - 本地存在多个 Web server 实例，容易造成体验混乱**
   - 现象：排查时发现 `dist/web/server.js` 同时监听 `5178` 和 `5179`；用户当前使用的是 `5179`，但另一个实例仍在运行。
   - 影响：用户可能打开不同端口看到不同运行状态、不同内存配置或不同 API key 状态；开发调试时也容易误判“配置丢失”或“run 不见了”。
   - 建议：启动时检测已有实例并提示；UI 显示当前 server port 和启动时间；开发脚本提供 `npm run web:stop` 或自动清理旧进程。

24. **P2 - 最新 run 的选择和历史恢复能力不足**
   - 现象：后端 `/api/runtime/runs` 能返回多个 run，但 Web UI 刷新后默认回到 `no run`，没有自动恢复最近一次真实投递记录。
   - 影响：用户任务完成后刷新页面或重新打开页面，会以为记录丢了；同时不容易对比“早一轮 blocked run”和“最新真实投递 run”。
   - 建议：增加最近运行列表，并默认选中最近启动或最近更新的 run；每个 run 显示状态、开始时间、目标域名、是否 handoff、是否 completed/incomplete。

25. **P2 - “真实投递”和“流程演示”模式没有清晰分离**
   - 现象：本次测试是用户授权的真实投递，但系统没有在 UI 上显式展示当前是“真实提交模式”还是“演示/只到提交前模式”。
   - 影响：用户难以判断 agent 会不会点最终提交；模型也没有稳定的模式约束。
   - 建议：增加运行模式开关：`演示到提交前`、`提交前请求确认`、`允许真实提交一次`。默认应为“提交前请求确认”；真实提交模式需要在 UI 上显示红色/橙色状态，并在最终提交前再次列出将发送的数据来源。

## 已验证的正向能力

1. Web 控制台可以通过 UI 启动 `claude-runtime + Playwright MCP`。
2. 智谱 `glm-4.7` 配置成功后，模型和 MCP server 能正常连通。
3. stream-json trace 能持续产生 span，本轮测试达到 `spanCount=55`。
4. Alibaba preset 能打开阿里招聘、识别岗位列表、进入岗位详情。
5. 到达登录页后，handoff 状态能传回 Web UI，并显示 Continue 按钮。
6. 最新真实体验 run 能在 handoff 后继续执行，并把最终 runtime 事件和 span 写入 trace。
7. 最新真实体验 run 的截图能力正常，保存了申请确认弹窗截图，可用于复盘 UI 行为。
