/**
 * /api/review — Vercel Serverless Function
 * 复盘工作流：启动扣子异步工作流 + 轮询查询结果 + 存 Supabase
 *
 * POST  → 启动异步工作流 (is_async:true)，秒返 execute_id
 * GET   → 按 execute_id 查询执行状态，成功时解析输出并入库
 */

const COZE_API_BASE = 'https://api.coze.cn';
const WORKFLOW_ID = '7657016359910359074';

// ---- Supabase 写入 ----
async function supabaseInsertReview(row) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[supabase] 未配置，跳过复盘写入');
    return;
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/review_results`, {
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
    console.error('[supabase] 复盘写入失败（不影响返回）', err);
  }
}

// 解析工作流输出
// 扣子工作流 output 格式: { "Output": "{\"data\":\"卡片文案：{...}\\n复盘信：...\",...}" }
// 从 Output.data 中拆出卡片文案和复盘信
function parseWorkflowOutput(raw) {
  let fupan = '';
  let kapian = '';
  try {
    const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!outer.Output) {
      // fallback: 直接格式
      fupan = outer.fupan || '';
      kapian = outer.kapian || '';
      return { fupan, kapian };
    }

    const inner = typeof outer.Output === 'string' ? JSON.parse(outer.Output) : outer.Output;
    const data = inner.data || '';

    if (!data) return { fupan, kapian };

    // data 格式: "卡片文案：{...卡片JSON...}\n复盘信：...正文..."
    const letterIdx = data.indexOf('\n复盘信：');
    if (letterIdx !== -1) {
      const cardPart = data.substring(0, letterIdx);
      fupan = data.substring(letterIdx + 5).trim(); // 跳过 "\n复盘信："

      // 卡片部分: "卡片文案：{...JSON...}"
      const jsonStart = cardPart.indexOf('{');
      if (jsonStart !== -1) {
        try {
          const cardJson = JSON.parse(cardPart.substring(jsonStart));
          // 从卡片JSON中提取可读文案
          kapian = cardJson['卡片主文案'] || cardJson['标题'] || JSON.stringify(cardJson);
        } catch {
          kapian = cardPart.replace('卡片文案：', '').trim();
        }
      } else {
        kapian = cardPart.replace('卡片文案：', '').trim();
      }
    } else {
      // 无明确分隔，整段当复盘信
      fupan = data;
    }
  } catch {
    fupan = typeof raw === 'string' ? raw : '';
  }
  return { fupan, kapian };
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

    const { session_id, mentor, chat_history } = body;
    if (!chat_history || typeof chat_history !== 'string' || chat_history.trim().length === 0) {
      return res.status(400).json({ error: '缺少 chat_history' });
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
          parameters: { chathistory: chat_history.trim() },
          is_async: true,
        }),
      });

      const data = await cozeRes.json();

      if (data.code !== 0) {
        console.error('[review] 启动工作流失败', data);
        return res.status(502).json({
          error: `扣子工作流启动失败 (code: ${data.code})${data.msg ? ': ' + data.msg : ''}`,
        });
      }

      const executeId = data.execute_id;
      if (!executeId) {
        return res.status(502).json({ error: '扣子未返回 execute_id' });
      }

      return res.status(200).json({ execute_id: executeId });
    } catch (err) {
      console.error('[review] 启动工作流异常', err);
      return res.status(502).json({ error: '调用扣子工作流启动接口失败' });
    }
  }

  // ====================================================
  // GET — 查询异步执行结果 ?eid=xxx&sid=xxx&mentor=xxx
  // ====================================================
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const executeId = url.searchParams.get('eid');
    const sessionId = url.searchParams.get('sid');
    const mentorName = url.searchParams.get('mentor');

    if (!executeId) {
      return res.status(400).json({ error: '缺少 eid 参数' });
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
        console.error('[review] 查询工作流状态失败', data);
        return res.status(502).json({
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
        const { fupan, kapian } = parseWorkflowOutput(record.output);

        // 存 Supabase（不阻塞返回）
        if (sessionId) {
          supabaseInsertReview({
            session_id: sessionId,
            execute_id: executeId,
            mentor_name: mentorName || null,
            reflection_letter: fupan,
            card_copy: kapian,
          });
        }

        return res.status(200).json({
          status: 'success',
          letter: fupan,
          card: kapian,
        });
      }

      return res.status(200).json({ status: 'running' });
    } catch (err) {
      console.error('[review] 查询工作流异常', err);
      return res.status(200).json({ status: 'running' });
    }
  }

  return res.status(405).json({ error: '请使用 POST 或 GET 方法' });
}
