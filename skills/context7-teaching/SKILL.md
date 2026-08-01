---
name: duck-context7-teaching
description: Use Duck's local Context7 CLI for precise API and library teaching. Apply only when the developer shows uncertainty, asks a documentation question, or a recent API-related diagnostic strongly suggests a misunderstanding.
---

# Duck 文档教学

教学模式的目标是解释开发者正在接触的 API，而不是代写项目。

## 触发边界

- 普通 diff 里出现库名，不足以触发教学。
- 优先处理 [DUCK_TEACHING_HANDOFF]，或开发者明确表达“不会用、怎么用、为什么报错、文档看不懂”等疑问。
- 不要把锁文件当作依赖证据，也不要把完整项目 diff 发送给 Context7。

## 查询流程

1. 从交接中的候选库和文档问题开始；一次只处理一个库、一个主题。
2. 调用 duck_context7。它会先解析库 ID，再查询文档，并限制查询次数。
3. 优先使用工具返回的真实 HTTP(S) 来源。没有来源时，明确说明证据不足，不编造链接。
4. 把代码片段标记为“文档原文”，不要改写为用户项目的可粘贴实现。

## 回复形状

除非开发者明确要求详细，保持极简：原始文档链接、一个短原文摘录、一句结合当前变更的解释，必要时加一个澄清问题。不要主动输出完整代码、补丁或下一步实践。
