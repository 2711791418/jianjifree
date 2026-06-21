/**
 * POST /api/copywriting  — 文案生成代理
 * 使用 Pages Functions 环境变量，前端看不到 Key
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { provider, model, movieName, targetCount, styleSample } = body;

    if (!provider || !movieName) {
      return Response.json({ success: false, error: '缺少参数 provider / movieName' }, { status: 400 });
    }

    const apiKey = getAPIKey(env, provider);
    const endpoint = getEndpoint(env, provider);
    const modelName = model || getDefaultModel(provider);

    if (!apiKey) {
      return Response.json({ success: false, error: `未配置 ${provider} 的 API Key` }, { status: 500 });
    }

    const systemPrompt = buildPrompt(movieName, targetCount || 800, styleSample || '');

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
          { role: 'user', content: `请为电影《${movieName}》撰写一篇约 ${targetCount || 800} 字的解说文案。` },
        ],
        max_tokens: Math.min((targetCount || 800) * 3, 16000),
        temperature: 0.85,
        top_p: 0.9,
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text().catch(() => '');
      return Response.json({ success: false, error: `AI API ${aiResp.status}: ${errText.substring(0, 200)}` }, { status: 502 });
    }

    const data = await aiResp.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    return Response.json({ success: true, content, model: modelName });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

function getAPIKey(env, provider) {
  const keys = {
    deepseek: env.DEEPSEEK_API_KEY,
    doubao:   env.DOUBAO_API_KEY,
    qianwen:  env.QIANWEN_API_KEY,
    yuanbao:  env.YUANBAO_API_KEY,
    custom:   env.CUSTOM_API_KEY,
  };
  return keys[provider] || '';
}

function getEndpoint(env, provider) {
  const defaults = {
    deepseek: 'https://api.deepseek.com/chat/completions',
    doubao:   'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    qianwen:  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    yuanbao:  'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    custom:   env.CUSTOM_ENDPOINT || '',
  };
  return defaults[provider] || '';
}

function getDefaultModel(provider) {
  const models = {
    deepseek: 'deepseek-chat',
    doubao:   'doubao-pro-32k',
    qianwen:  'qwen-plus',
    yuanbao:  'hunyuan-lite',
    custom:   '',
  };
  return models[provider] || '';
}

function buildPrompt(movieName, targetCount, styleSample) {
  let prompt = `你是一位专业的电影解说文案写手。请根据以下要求撰写一篇电影解说文案。

【电影名称】《${movieName}》
【目标字数】约 ${targetCount} 字（请严格控制在此字数的 ±15% 范围内）
【格式要求】使用自然段分隔，每个段落之间用空行隔开。不要使用 Markdown 格式，直接输出纯文本。`;

  if (styleSample) {
    prompt += `

【风格模仿样本】以下是用户提供的参考文案，请仔细分析其写作风格并在生成文案时尽可能模仿：
---
${styleSample}
---
请分析样本以下特征并严格模仿：
1. 句式结构 2. 语气风格 3. 用词习惯
4. 段落节奏 5. 情绪表达 6. 修辞手法（emoji/感叹号/反问等）
请让人读起来感觉是同一个作者写的。`;
  } else {
    prompt += `
【风格要求】以自然流畅的中文撰写，语气亲切但不随意，适合作为电影解说视频的旁白配音文案。适当融入对剧情的分析、角色的解读、视听语言的点评。`;
  }
  return prompt;
}
