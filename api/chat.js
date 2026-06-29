/**
 * /api/chat — Vercel Serverless Function
 * 接收前端用户消息 → 用环境变量中的 Token 调用扣子 Bot（SSE 流式）→ 返回完整回复
 * Token 仅存在于后端环境变量，绝不出现在前端代码中
 */

const COZE_API_BASE = 'https://api.coze.cn';

// Vercel Hobby 计划函数超时约 10s，留 2s 余量
const WAIT_TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '请使用 POST 方法' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: '请求体格式错误，需要 JSON' });
  }

  const { message } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: '缺少 message 字段' });
  }

  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId || token.startsWith('pat_你的')) {
    return res.status(500).json({
      error: '后端配置缺失：请设置 COZE_API_TOKEN 和 COZE_BOT_ID',
    });
  }

  try {
    // 调用扣子 v3/chat（SSE 流式）
    const cozeRes = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: 'zaijian-user',
        stream: true,
        auto_save_history: true,
        additional_messages: [
          {
            role: 'user',
            type: 'question',
            content_type: 'text',
            content: message.trim(),
          },
        ],
      }),
      // 避免 HTTP/2 流超时卡住函数
      signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    });

    if (!cozeRes.ok) {
      const errText = await cozeRes.text();
      console.error('[coze] HTTP error', cozeRes.status, errText);
      return res.status(502).json({
        error: `扣子 API 返回错误 (${cozeRes.status})`,
      });
    }

    const sseText = await cozeRes.text();
    const lines = sseText.split('\n');

    // —— 解析 SSE 事件流 ——
    let reply = '';
    let conversationId = '';
    let currentEvent = '';

    for (const line of lines) {
      // 记录事件类型
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }

      if (!line.startsWith('data:')) continue;

      try {
        const data = JSON.parse(line.slice(5).trim());

        if (data.conversation_id) {
          conversationId = data.conversation_id;
        }

        // 只从 delta 事件中收集 answer 内容（避免 message.completed 的重复全文）
        if (
          currentEvent === 'conversation.message.delta' &&
          data.role === 'assistant' &&
          data.type === 'answer' &&
          data.content
        ) {
          reply += data.content;
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    return res.status(200).json({
      reply: reply || '（机器人没有返回回复，请稍后重试）',
      conversation_id: conversationId || null,
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      console.error('[coze] timeout after', WAIT_TIMEOUT_MS, 'ms');
      return res.status(504).json({
        error: 'Bot 回复时间较长，请稍后重试或缩短问题',
      });
    }
    console.error('[coze] unexpected error', err);
    return res.status(500).json({
      error: '后端调用扣子 API 时发生意外错误',
    });
  }
}
