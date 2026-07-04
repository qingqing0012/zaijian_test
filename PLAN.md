# 再见爱人 · 项目计划

## 已完成

### 测试流程
- 18 道题关系人格测试
- 18 种角色匹配 + 六维雷达图
- 三色系主题切换（清醒款 / 成长款 / 隐藏款）

### 导师聊天
- 5 位观察室导师接入（沈奕斐、黄执中、李松蔚、胡彦斌、易立竞）
- 扣子 Bot SSE 流式对话
- 多导师切换，AbortController 防串话
- Supabase 聊天记录落库

### 复盘工作流
- 扣子异步工作流接入 + 前端轮询（180s 超时）
- 复盘信生成（按导师口吻）
- 关系卡片生成
- Supabase 复盘结果落库

### 卡片视觉
- 烟玫色竖版卡片，3:4 手机比例
- card-bg.webp 底图 + 半透内容层
- html2canvas 保存为 PNG
- 动态导师落款

### 复盘信视觉 ✅ MVP 可用
- 信纸形状：独立纸张，轻微圆角，投影层次
- 信纸纹理：letter-bg.png 底图铺满
- 右上角轻微卷边
- 旧纸感边缘层次
- 深棕手写体排版，行距 2.0
- 桌面 / 移动端适配

### 恋爱日记 MVP ✅ 已完成
- review_results 表已建成并启用 RLS
- localStorage 匿名 user_id（zaijian_user_id）
- 复盘完成自动入库（user_id / session_id / mentor_name / reflection_letter / card_copy）
- api/diary.js：GET 列表 + DELETE 删除（id + user_id 双条件）
- 前端列表页（日期 / 导师 / 摘要）
- 前端详情页（完整复盘信 + 完整关系卡片）
- 删除确认 + 刷新
- 入库失败不阻塞复盘展示

## 待优化（后置）

- [ ] 复盘信手写字体精修（huimou.ttf 未作为 MVP 阻塞项）
- [ ] 字体加载稳定性
- [ ] 卡片底图 Lovart 精调

## 下一阶段

待定
