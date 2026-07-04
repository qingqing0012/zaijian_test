/**
 * /api/diary — Vercel Serverless Function
 * 恋爱日记：读取历史复盘列表 + 删除单条记录
 *
 * GET   → ?user_id=xxx  读取该用户的历史复盘，最多 20 条，created_at 倒序
 * DELETE → ?id=xxx&user_id=xxx  删除该用户的一条复盘记录
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const TABLE = 'review_results';

function checkSupabase() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// GET 列表
async function listDiary(userId, res) {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    return res.status(400).json({ success: false, error: '缺少 user_id' });
  }

  const url = `${SUPABASE_URL}/rest/v1/${TABLE}`
    + `?user_id=eq.${encodeURIComponent(userId)}`
    + `&order=created_at.desc`
    + `&limit=20`
    + `&select=*`;

  try {
    const sr = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!sr.ok) {
      console.error('[diary] Supabase 查询失败', sr.status);
      return res.status(502).json({ success: false, error: '日记读取失败' });
    }

    const items = await sr.json();
    return res.status(200).json({ success: true, items });
  } catch (err) {
    console.error('[diary] 查询异常', err);
    return res.status(502).json({ success: false, error: '日记读取失败' });
  }
}

// DELETE 删除
async function deleteDiary(id, userId, res) {
  if (!id || !userId) {
    return res.status(400).json({ success: false, error: '缺少 id 或 user_id' });
  }

  const url = `${SUPABASE_URL}/rest/v1/${TABLE}`
    + `?id=eq.${encodeURIComponent(id)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`;

  try {
    const sr = await fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!sr.ok) {
      console.error('[diary] 删除失败', sr.status);
      return res.status(502).json({ success: false, error: '删除失败，请稍后再试' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[diary] 删除异常', err);
    return res.status(502).json({ success: false, error: '删除失败，请稍后再试' });
  }
}

// 主入口
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!checkSupabase()) {
    return res.status(500).json({ success: false, error: '后端未配置 Supabase' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get('user_id');

  if (req.method === 'GET') {
    return listDiary(userId, res);
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    return deleteDiary(id, userId, res);
  }

  return res.status(405).json({ success: false, error: '请使用 GET 或 DELETE' });
}
