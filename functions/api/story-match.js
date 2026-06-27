/**
 * POST /api/story-match  — AI：ASR文本分章节 + 解说词匹配到具体时间点
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { provider, model, transcript, commentary } = body;

    if (!transcript || !transcript.length) {
      return Response.json({ success: false, error: '缺少 transcript（音频转文字结果）' }, { status: 400 });
    }
    if (!commentary || !commentary.length) {
      return Response.json({ success: false, error: '缺少 commentary（解说文案）' }, { status: 400 });
    }

    const apiKey = getTextKey(env, provider);
    const endpoint = getTextEndpoint(env, provider);
    const modelName = model || getTextModel(provider);

    if (!apiKey) {
      return Response.json({
        success: false,
        error: `未配置 ${provider} 的 API Key`,
        hint: '在 Cloudflare Secrets 中添加 DEEPSEEK_API_KEY 或其他文本AI Key',
      }, { status: 500 });
    }

    // 构建 transcript 文本（压缩格式）
    const transcriptText = transcript.map((t, i) =>
      `[T${i}] ${fmtTime(t.start)}→${fmtTime(t.end)} ${t.text}`
    ).join('\n');

    const commentaryText = commentary.map((c, i) =>
      `[C${i}] ${c.text}（配音${c.duration.toFixed(1)}秒）`
    ).join('\n');

    const systemPrompt = `你是电影剪辑分析专家。我会给你：
1. 电影音频转文字的带时间戳文本（transcript）
2. 解说文案的句子列表（commentary）

请完成两个任务：

任务A：将 transcript 分成若干"小故事"（按剧情发展阶段划分），每个小故事标注名称和起止时间。

任务B：为每句解说文案找到最匹配的 transcript 行。推理时要理解 transcript 的语义（比如"我不行了，快送我回家"意味着角色快死了）。

输出纯 JSON（不要 Markdown 代码块）：
{
  "chapters": [
    {"name": "章节名", "startIdx": T起始行号, "endIdx": T结束行号, "startTime": 秒数, "endTime": 秒数}
  ],
  "matches": [
    {"commentaryIdx": C序号, "transcriptStartIdx": T起始行号, "transcriptEndIdx": T结束行号, "startTime": 秒数, "endTime": 秒数, "chapterName": "所属章节", "reason": "匹配理由（20字）"}
  ]
}

规则：
- 章节按时间顺序，不重叠，覆盖全片
- 每句解说匹配1~6行 transcript
- matches 按电影时间顺序排列
- startTime/endTime 使用 transcript 中对应行的原始时间`;

    const userPrompt = `===== TRANSCRIPT（${transcript.length}行）=====\n${transcriptText.substring(0, 30000)}\n\n===== COMMENTARY（${commentary.length}句）=====\n${commentaryText}`;

    const aiResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8192,
        temperature: 0.3,
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text().catch(() => '');
      return Response.json({ success: false, error: `AI ${aiResp.status}: ${errText.substring(0, 300)}` }, { status: 502 });
    }

    const data = await aiResp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '';

    let parsed;
    try {
      const json = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(json);
    } catch {
      return Response.json({ success: false, error: 'AI返回格式异常', raw: raw.substring(0, 500) }, { status: 500 });
    }

    return Response.json({
      success: true,
      chapters: parsed.chapters || [],
      matches: parsed.matches || [],
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function getTextKey(env, provider) {
  const keys = {
    deepseek: env.DEEPSEEK_API_KEY,
    doubao: env.DOUBAO_API_KEY,
    qianwen: env.QIANWEN_API_KEY || env.TONGYIQIANWEN_API_KEY || env.DASHSCOPE_API_KEY,
    yuanbao: env.YUANBAO_API_KEY,
    custom: env.CUSTOM_API_KEY,
  };
  return keys[provider] || '';
}

function getTextEndpoint(env, provider) {
  const defaults = {
    deepseek: 'https://api.deepseek.com/chat/completions',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    qianwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    yuanbao: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    custom: env.CUSTOM_ENDPOINT || '',
  };
  return defaults[provider] || '';
}

function getTextModel(provider) {
  const models = {
    deepseek: 'deepseek-chat',
    doubao: 'doubao-pro-32k',
    qianwen: 'qwen-plus',
    yuanbao: 'hunyuan-lite',
    custom: '',
  };
  return models[provider] || '';
}
