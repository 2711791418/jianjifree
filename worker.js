/**
 * AI 视频编辑器 - Cloudflare Worker 后端代理
 *
 * 作用：
 * 1. 隐藏所有 AI API Key，前端拿不到
 * 2. 代理转发文案生成 / 视觉分析请求
 * 3. 可在此处添加调用频率限制
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============ CORS 预检 ============
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // ============ 文案生成代理 ============
    if (url.pathname === '/api/copywriting' && request.method === 'POST') {
      return handleCopywriting(request, env);
    }

    // ============ 视觉分析代理 ============
    if (url.pathname === '/api/vision' && request.method === 'POST') {
      return handleVision(request, env);
    }

    // ============ 健康检查 ============
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders() });
  },
};

// ==================== CORS 头 ====================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// ==================== 文案生成处理 ====================
async function handleCopywriting(request, env) {
  try {
    const body = await request.json();
    const { provider, model, movieName, targetCount, styleSample } = body;

    if (!provider || !movieName) {
      return jsonError('缺少必要参数 provider / movieName', 400);
    }

    // 从环境变量获取对应 API Key
    const apiKey = getAPIKey(env, provider);
    const endpoint = getEndpoint(env, provider);
    const modelName = model || getDefaultModel(provider);

    if (!apiKey) {
      return jsonError('未配置 ' + provider + ' 的 API Key，请在 Worker 环境变量中设置', 500);
    }

    // 构建 Prompt
    let systemPrompt = buildCopywritingPrompt(movieName, targetCount || 800, styleSample || '');

    const aiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请为电影《${movieName}》撰写一篇约 ${targetCount || 800} 字的解说文案。${styleSample ? '务必模仿我提供的风格样本。' : ''}` },
        ],
        max_tokens: Math.min((targetCount || 800) * 3, 16000),
        temperature: 0.85,
        top_p: 0.9,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(() => '');
      return jsonError('AI API 错误 ' + aiResponse.status + '：' + errText.substring(0, 200), 502);
    }

    const data = await aiResponse.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    return new Response(JSON.stringify({ success: true, content, model: modelName }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return jsonError('Worker 内部错误：' + e.message, 500);
  }
}

// ==================== 视觉分析处理 ====================
async function handleVision(request, env) {
  try {
    const body = await request.json();
    const { provider, model, frames, movieName } = body;

    if (!frames || !frames.length) {
      return jsonError('缺少 frames（base64 图片数组）', 400);
    }

    const apiKey = getVisionAPIKey(env, provider);
    const endpoint = getVisionEndpoint(env, provider);
    const modelName = model || getDefaultVisionModel(provider);

    if (!apiKey) {
      return jsonError('未配置视觉 AI 的 API Key', 500);
    }

    const results = [];

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!f.base64) {
        results.push({ time: f.time, description: '[画面提取失败]', index: i });
        continue;
      }

      try {
        const base64Data = f.base64.split(',')[1] || f.base64;

        const aiResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '请用一句简短的中文描述这个电影画面的内容。描述应包含：场景（室内/室外/白天/夜晚）、主要人物或物体、动作、情绪氛围。限40字以内，只输出描述。',
                },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/jpeg;base64,' + base64Data },
                },
              ],
            }],
            max_tokens: 80,
            temperature: 0.3,
          }),
        });

        if (aiResponse.ok) {
          const data = await aiResponse.json();
          const desc = data.choices?.[0]?.message?.content?.trim() || '[未返回]';
          results.push({ time: f.time, description: desc, index: i });
        } else {
          results.push({ time: f.time, description: '[AI 错误]', index: i });
        }
      } catch (e) {
        results.push({ time: f.time, description: '[请求失败]', index: i });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return jsonError('Worker 内部错误：' + e.message, 500);
  }
}

// ==================== 辅助函数 ====================
function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
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
  return env[provider.toUpperCase() + '_ENDPOINT'] || defaults[provider] || '';
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

function getVisionAPIKey(env, provider) {
  return env[provider.toUpperCase() + '_VISION_KEY'] || getAPIKey(env, provider);
}

function getVisionEndpoint(env, provider) {
  const defaults = {
    qianwen:  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    doubao:   'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    openai:   'https://api.openai.com/v1/chat/completions',
    custom:   env.CUSTOM_VISION_ENDPOINT || '',
  };
  return env[provider.toUpperCase() + '_VISION_ENDPOINT'] || defaults[provider] || '';
}

function getDefaultVisionModel(provider) {
  const models = {
    qianwen:  'qwen-vl-plus',
    deepseek: 'deepseek-chat',
    doubao:   'doubao-vision-pro',
    openai:   'gpt-4o',
    custom:   '',
  };
  return models[provider] || '';
}

function buildCopywritingPrompt(movieName, targetCount, styleSample) {
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
1. 句式结构：长句还是短句？复杂句还是简单句？
2. 语气风格：口语化/正式/幽默/文艺/犀利？
3. 用词习惯：偏好的词汇、语气词、转折方式
4. 段落节奏：每段长度、段落之间的过渡方式
5. 情绪表达：克制/奔放、客观/主观、冷静/热情
6. 是否使用 emoji、感叹号、反问句等修辞手法

请在生成的文案中复现上述所有风格特征，让人读起来感觉是同一个作者写的。`;
  } else {
    prompt += `
【风格要求】以自然流畅的中文撰写，语气亲切但不随意，适合作为电影解说视频的旁白配音文案。适当融入对剧情的分析、角色的解读、视听语言的点评。`;
  }

  return prompt;
}
