/**
 * POST /api/vision  — 视频画面AI分析代理
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { provider, model, frames } = body;

    if (!frames || !frames.length) {
      return Response.json({ success: false, error: '缺少 frames' }, { status: 400 });
    }

    const apiKey = getVisionKey(env, provider);
    const endpoint = getVisionEndpoint(env, provider);
    const modelName = model || getDefaultVisionModel(provider);

    if (!apiKey) {
      const keyName = provider.toUpperCase() + '_API_KEY';
      return Response.json({
        success: false,
        error: `未配置 ${provider} 的视觉 API Key（查找环境变量：${keyName}）`,
        hint: `获取免费 Key：dashscope.aliyun.com → 开通模型服务 → 复制 Key → Cloudflare Pages → Settings → Variables and secrets → 添加 ${keyName} → 重新部署`,
      }, { status: 500 });
    }

    // 检查模型是否支持视觉识别（多模态）
    const VISION_CAPABLE = ['vl', 'vision', 'gpt-4o', 'gpt-4v', 'claude-3', 'claude-4', 'gemini', 'multimodal'];
    const isVisionCapable = VISION_CAPABLE.some(k => modelName.toLowerCase().includes(k));
    if (!isVisionCapable) {
      return Response.json({
        success: false,
        error: `模型 "${modelName}" 不支持图片识别（非多模态模型）`,
        hint: '请使用通义千问 VL（免费额度）：1.去 dashscope.aliyun.com 获取 Key → 2.在 Cloudflare Secrets 添加 QIANWEN_API_KEY → 3.视觉引擎选「通义千问 VL」',
      }, { status: 400 });
    }

    const results = [];

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!f.base64) {
        results.push({ time: f.time, description: '[提取失败]', index: i });
        continue;
      }

      try {
        const base64Data = f.base64.split(',')[1] || f.base64;

        const aiResp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: '用一句简短中文描述此电影画面：场景（室内/室外/白天/夜晚）、人物/物体、动作、情绪氛围。40字内，只输出描述。' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
              ],
            }],
            max_tokens: 80,
            temperature: 0.3,
          }),
        });

        if (aiResp.ok) {
          const data = await aiResp.json();
          results.push({
            time: f.time,
            description: data.choices?.[0]?.message?.content?.trim() || '[未返回]',
            index: i,
          });
        } else {
          results.push({ time: f.time, description: '[AI错误]', index: i });
        }
      } catch (e) {
        results.push({ time: f.time, description: '[请求失败]', index: i });
      }
    }

    return Response.json({ success: true, results });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

function getVisionKey(env, provider) {
  return env[provider.toUpperCase() + '_VISION_KEY'] ||
    env[provider.toUpperCase() + '_API_KEY'] ||
    '';
}

function getVisionEndpoint(env, provider) {
  const defaults = {
    qianwen:  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    doubao:   'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    openai:   'https://api.openai.com/v1/chat/completions',
    custom:   env.CUSTOM_VISION_ENDPOINT || '',
  };
  return defaults[provider] || '';
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
