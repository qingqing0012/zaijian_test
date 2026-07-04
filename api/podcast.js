/**
 * /api/podcast — Vercel Serverless Function
 * 观察室文字播客：从 chat_messages 捞原始对话 → 调 Coze 异步工作流 → 轮询
 *
 * POST  → 启动异步工作流，秒返 execute_id
 * GET   → ?execute_id=xxx  轮询状态，Success 时返回 6 个播客字段
 */

const COZE_API_BASE = 'https://api.coze.cn';
const WORKFLOW_ID = '7657392124916367394';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

// ---- 从 chat_messages 捞原始对话 ----
async function fetchChatMessages(sessionId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[podcast] Supabase 未配置，无法捞取对话');
    return [];
  }

  const url = `${SUPABASE_URL}/rest/v1/chat_messages`
    + `?session_id=eq.${encodeURIComponent(sessionId)}`
    + `&order=created_at.asc`
    + `&select=role,content`;

  try {
    const sr = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!sr.ok) {
      console.error('[podcast] chat_messages 查询失败', sr.status);
      return [];
    }

    return await sr.json();
  } catch (err) {
    console.error('[podcast] chat_messages 查询异常', err);
    return [];
  }
}

// ---- 拼 raw_dialogue ----
function buildRawDialogue(messages) {
  return messages
    .map(function (m) {
      const speaker = m.role === 'user' ? '用户' : '导师';
      return speaker + '：' + (m.content || '');
    })
    .join('\n');
}

// ---- 主处理 ----
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.COZE_API_TOKEN;
  if (!token || token.startsWith('pat_你的')) {
    return res.status(500).json({ error: '后端配置缺失：请设置 COZE_API_TOKEN' });
  }

  // ====================================================
  // POST — 启动异步工作流
  // ====================================================
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: '请求体格式错误' });
    }

    const { session_id, reflection_letter, card_copy } = body;

    if (!session_id) {
      return res.status(400).json({ error: '缺少 session_id' });
    }

    // 捞原始对话
    let raw_dialogue = '';
    try {
      const messages = await fetchChatMessages(session_id);
      raw_dialogue = buildRawDialogue(messages);
    } catch (err) {
      console.error('[podcast] 捞取对话失败', err);
    }

    if (!raw_dialogue || raw_dialogue.trim().length === 0) {
      return res.status(400).json({
        error: '没有找到对话记录。请先和导师聊上一段。',
      });
    }

    try {
      const cozeRes = await fetch(`${COZE_API_BASE}/v1/workflow/run`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: WORKFLOW_ID,
          parameters: {
            raw_dialogue: raw_dialogue,
            reflection_letter: reflection_letter || '',
            card_copy: card_copy || '',
            selected_mentors: '自动',
          },
          is_async: true,
        }),
      });

      const data = await cozeRes.json();

      if (data.code !== 0) {
        console.error('[podcast] 启动工作流失败', data);
        return res.status(502).json({
          error: `工作流启动失败 (code: ${data.code})${data.msg ? ': ' + data.msg : ''}`,
        });
      }

      const executeId = data.execute_id;
      if (!executeId) {
        return res.status(502).json({ error: '未返回 execute_id' });
      }

      return res.status(200).json({ execute_id: executeId });
    } catch (err) {
      console.error('[podcast] 启动工作流异常', err);
      return res.status(502).json({ error: '调用工作流启动接口失败' });
    }
  }

  // ====================================================
  // GET — 轮询执行结果 ?execute_id=xxx
  // ====================================================
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const executeId = url.searchParams.get('execute_id');

    if (!executeId) {
      return res.status(400).json({ error: '缺少 execute_id 参数' });
    }

    try {
      const cozeRes = await fetch(
        `${COZE_API_BASE}/v1/workflows/${WORKFLOW_ID}/run_histories/${executeId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await cozeRes.json();

      if (data.code !== 0) {
        console.error('[podcast] 查询工作流状态失败', data);
        return res.status(200).json({
          status: 'fail',
          error: `查询失败 (code: ${data.code})`,
        });
      }

      const records = data.data;
      if (!records || records.length === 0) {
        return res.status(200).json({ status: 'running' });
      }

      const record = records[0];
      const status = record.execute_status;

      if (status === 'Running') {
        return res.status(200).json({ status: 'running' });
      }

      if (status === 'Fail') {
        return res.status(200).json({
          status: 'fail',
          error: record.error_message || '工作流执行失败',
        });
      }

      if (status === 'Success') {
        // 解析工作流输出的 6 个字段
        const output = record.output || {};
        let result = {};

        try {
          // Coze 工作流 output 可能包在 Output 字段里
          const raw = typeof output === 'string' ? JSON.parse(output) : output;
          const inner = raw.Output
            ? (typeof raw.Output === 'string' ? JSON.parse(raw.Output) : raw.Output)
            : raw;

          result = {
            title: inner.title || '',
            mentors_used: inner.mentors_used || '',
            opening: inner.opening || '',
            dialogue: inner.dialogue || '',
            closing: inner.closing || '',
            takeaway: inner.takeaway || '',
          };
        } catch (parseErr) {
          console.error('[podcast] 解析输出失败', parseErr);
          // fallback: 尝试直接从 output 取
          result = {
            title: output.title || '',
            mentors_used: output.mentors_used || '',
            opening: output.opening || '',
            dialogue: output.dialogue || '',
            closing: output.closing || '',
            takeaway: output.takeaway || '',
          };
        }

        return res.status(200).json({
          status: 'success',
          ...result,
        });
      }

      return res.status(200).json({ status: 'running' });
    } catch (err) {
      console.error('[podcast] 查询工作流异常', err);
      return res.status(200).json({ status: 'running' });
    }
  }

  return res.status(405).json({ error: '请使用 POST 或 GET 方法' });
}
