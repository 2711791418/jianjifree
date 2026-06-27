/**
 * POST /api/match-frames  — AI 看完所有画面+所有文案，直接返回每句话匹配哪几帧
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { provider, model, frames, sentences } = body;

    if (!frames || !frames.length) {
      return Response.json({ success: false, error: '缺少 frames' }, { status: 400 });
    }
    if (!sentences || !sentences.length) {
      return Response.json({ success: false, error: '缺少 sentences' }, { status: 400 });
    }

    const apiKey = getMatchKey(env, provider);
    const endpoint = getMatchEndpoint(env, provider);
    const modelName = model || getMatchModel(provider);

    if (!apiKey) {
      return Response.json({
        success: false,
        error: `未配置 ${provider} 的 API Key`,
        hint: `在 Cloudflare Secrets 中添加对应的 API Key 即可使用 AI 画面匹配`,
      }, { status: 500 });
    }

    // 构建 prompt：让 AI 为每句话匹配画面范围
    const frameList = frames.map((f, i) =>
      `[帧${i}] 时间=${formatSec(f.time)}`
    ).join('\n');

    const sentenceList = sentences.map((s, i) =>
      `[句${i}] ${s.text}（配音约${s.duration.toFixed(1)}秒）`
    ).join('\n');

    const systemPrompt = `你是一位资深电影剪辑师。我会给你：
1. 一部电影的关键帧截图（按时间顺序排列，共${frames.length}张）
2. 一段解说文案（共${sentences.length}句话）

请为每句文案找到电影中最匹配的画面。输出纯 JSON 数组（不要 Markdown 代码块）：
[{"s": 句索引, "fStart": 起始帧号, "fEnd": 结束帧号, "reason": "为什么选这段（10字以内）"}, ...]

规则：
- 每句话配一段连续画面（fStart 到 fEnd，通常 2~6 帧跨度）
- 按电影时间顺序，不能倒序
- 尽量覆盖电影不同部分（开头/中段/结尾都要有）
- 优先选择画面内容与文案语义相关的片段

只输出 JSON 数组，不要其他文字。`;

    const userPrompt = `下面是 ${frames.length} 帧画面截图和 ${sentences.length} 句解说文案，请逐一匹配：\n\n===== 帧列表 =====\n${frameList}\n\n===== 文案 =====\n${sentenceList}`;

    // 构建消息：system + 用户文本 + 所有帧图片
    const userContent = [
      { type: 'text', text: userPrompt },
    ];

    // 添加所有帧（每张作为一个 image_url）
    for (const f of frames) {
      if (!f.base64) continue;
      const base64Data = f.base64.split(',')[1] || f.base64;
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${base64Data}` },
      });
    }

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
          { role: 'user', content: userContent },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text().catch(() => '');
      return Response.json({ success: false, error: `AI API ${aiResp.status}: ${errText.substring(0, 300)}` }, { status: 502 });
    }

    const data = await aiResp.json();
    const rawContent = data.choices?.[0]?.message?.content?.trim() || '';

    // 解析 AI 返回的 JSON
    let matches;
    try {
      // 去除可能的 Markdown 代码块包裹
      const jsonStr = rawContent
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
      matches = JSON.parse(jsonStr);
      if (!Array.isArray(matches)) matches = [];
    } catch (e) {
      return Response.json({
        success: false,
        error: 'AI 返回格式异常，无法解析 JSON',
        raw: rawContent.substring(0, 500),
      }, { status: 500 });
    }

    // 转换为时间戳
    const results = matches.map(m => {
      const sIdx = m.s ?? m.sentence ?? m.sentenceIdx ?? 0;
      const fStart = m.fStart ?? m.startFrame ?? 0;
      const fEnd = m.fEnd ?? m.endFrame ?? Math.min(fStart + 3, frames.length - 1);

      const startFrame = frames[Math.min(fStart, frames.length - 1)];
      const endFrame = frames[Math.min(fEnd, frames.length - 1)];

      return {
        sentenceIdx: sIdx,
        startTime: startFrame ? startFrame.time : 0,
        endTime: endFrame ? Math.min(endFrame.time, startFrame ? startFrame.time + 30 : 30) : 10,
        startFrame: fStart,
        endFrame: fEnd,
        reason: m.reason || '',
      };
    });

    return Response.json({ success: true, results, totalFrames: frames.length, totalSentences: sentences.length });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

function formatSec(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function getMatchKey(env, provider) {
  const candidates = [
    env[provider.toUpperCase() + '_API_KEY'],
    env[provider.toUpperCase() + '_VISION_KEY'],
  ];
  if (provider === 'qianwen') {
    candidates.push(env['TONGYIQIANWEN_API_KEY']);
    candidates.push(env['DASHSCOPE_API_KEY']);
  }
  return candidates.find(k => k && k.trim()) || '';
}

function getMatchEndpoint(env, provider) {
  const defaults = {
    qianwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    custom: env.CUSTOM_VISION_ENDPOINT || '',
  };
  return defaults[provider] || '';
}

function getMatchModel(provider) {
  const models = {
    qianwen: 'qwen-vl-plus',
    doubao: 'doubao-vision-pro',
    openai: 'gpt-4o',
    custom: '',
  };
  return models[provider] || '';
}
