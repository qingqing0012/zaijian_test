/**
 * /api/chat — Vercel Serverless Function
 * 接收前端用户消息 → 存 Supabase → 调扣子 Bot（SSE 流式）→ 存回复 → 返回
 * Token / 密钥仅存在于后端环境变量，绝不出现在前端代码中
 */

const COZE_API_BASE = 'https://api.coze.cn';
const WAIT_TIMEOUT_MS = 8000;

// 导师 → 扣子 Bot ID 映射（Bot ID 非密钥，允许硬编码）
const MENTOR_BOTS = {
  "沈奕斐": "7647043981314179135",
  "黄执中": "7647189192426029066",
  "李松蔚": "7646981072140009481",
  "胡彦斌": "7647049872747069483",
  "易立竞": "7647040408144773158",
};

// ---- Supabase 写入（REST API，零依赖） ----
async function supabaseInsert(row) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[supabase] 未配置 SUPABASE_URL / SUPABASE_SECRET_KEY，跳过写入');
    return;
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/chat_messages`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error('[supabase] 写入失败（聊天不受影响）', err);
  }
}

// ---- 主处理函数 ----
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

  const {
    message,
    conversation_id,
    session_id,
    is_init,
    mentor,
  } = body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: '缺少 message 字段' });
  }

  const token = process.env.COZE_API_TOKEN;
  if (!token || token.startsWith('pat_你的')) {
    return res.status(500).json({
      error: '后端配置缺失：请设置 COZE_API_TOKEN',
    });
  }

  // 多导师路由：根据 mentor 参数匹配 Bot ID，fallback 到李松蔚
  const mentorName = (mentor && MENTOR_BOTS[mentor]) ? mentor : '李松蔚';
  const mentorBotId = MENTOR_BOTS[mentorName];
  // 暂存用户消息，等拿到 bot 回复后一起入库（保证 Vercel 冻结前完成写入）
  const userMessage = message.trim();
  const shouldStore = !is_init && session_id;

  try {
    // 调用扣子 v3/chat（SSE 流式）
    const cozeRes = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: mentorBotId,
        user_id: 'zaijian-user',
        stream: true,
        auto_save_history: true,
        ...(conversation_id ? { conversation_id } : {}),
        additional_messages: [
          {
            role: 'user',
            type: 'question',
            content_type: 'text',
            content: message.trim(),
          },
        ],
      }),
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

    const finalReply = reply || '（机器人没有返回回复，请稍后重试）';
    const finalConvId = conversationId || null;

    // 不是系统握手消息 → 批量写入（await 确保在函数返回前完成）
    if (shouldStore) {
      const rows = [
        {
          session_id,
          conversation_id: conversation_id || null,
          role: 'user',
          content: userMessage,
          mentor_name: mentorName,
          mentor_bot_id: mentorBotId,
        },
      ];
      if (reply) {
        rows.push({
          session_id,
          conversation_id: finalConvId,
          role: 'assistant',
          content: finalReply,
          mentor_name: mentorName,
          mentor_bot_id: mentorBotId,
        });
      }
      for (const row of rows) await supabaseInsert(row);
    }

    return res.status(200).json({
      reply: finalReply,
      conversation_id: finalConvId,
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
