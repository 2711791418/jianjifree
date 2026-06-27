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

    const MAX_IMAGES_PER_CALL = 10; // 视觉AI单次请求图片上限
    const totalBatches = Math.ceil(frames.length / MAX_IMAGES_PER_CALL);

    // 分批发送，每批最多10张图
    const allFrameDescs = [];
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchFrames = frames.slice(batch * MAX_IMAGES_PER_CALL, (batch + 1) * MAX_IMAGES_PER_CALL);
      const validFrames = batchFrames.filter(f => f.base64);

      if (validFrames.length === 0) continue;

      const batchPrompt = `你是一位电影画面分析师。下面是电影第${batch * MAX_IMAGES_PER_CALL + 1}到${Math.min((batch + 1) * MAX_IMAGES_PER_CALL, frames.length)}张关键帧截图（共${frames.length}张，时间范围 ${formatSec(frames[0]?.time || 0)} ~ ${formatSec(frames[frames.length-1]?.time || 0)}）。

请用一句话描述每张画面的内容（场景、人物、动作、情绪）。输出纯 JSON 数组：
[{"idx": 帧序号, "desc": "画面描述（15字内）"}, ...]

只输出 JSON 数组，不要其他文字。`;

      const userContent = [{ type: 'text', text: batchPrompt }];
      for (const f of validFrames) {
        const base64Data = f.base64.split(',')[1] || f.base64;
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${base64Data}` },
        });
      }

      try {
        const aiResp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'user', content: userContent },
            ],
            max_tokens: 2048,
            temperature: 0.3,
          }),
        });

        if (aiResp.ok) {
          const data = await aiResp.json();
          const raw = (data.choices?.[0]?.message?.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          try {
            const descs = JSON.parse(raw);
            if (Array.isArray(descs)) {
              descs.forEach(d => {
                allFrameDescs.push({ index: d.idx ?? d.i ?? batch * MAX_IMAGES_PER_CALL, desc: d.desc || d.description || '', time: frames[d.idx]?.time || 0 });
              });
            }
          } catch {}
        }
      } catch (e) {
        // 某批失败不影响其他批
        console.log(`Batch ${batch} failed: ${e.message}`);
      }
    }

    if (allFrameDescs.length === 0) {
      return Response.json({ success: false, error: '所有批次视觉分析均失败' }, { status: 500 });
    }

    // ======== 第二步：用文本AI将画面描述与文案匹配 ========
    const descList = allFrameDescs.map(d => `[帧${d.index}] ${formatSec(d.time)} ${d.desc}`).join('\n');
    const sentList = sentences.map((s, i) => `[句${i}] ${s.text}（${s.duration.toFixed(1)}秒）`).join('\n');

    const matchPrompt = `你是一位电影剪辑师。下面是电影画面描述和文案句子，请为每句文案匹配最合适的画面。

画面描述：
${descList}

文案：
${sentList}

输出 JSON 数组：
[{"s": 句序号, "fStart": 起始帧号, "fEnd": 结束帧号, "reason": "匹配理由"}, ...]

规则：按电影时间顺序、每句配1~4帧、覆盖不同部分。只输出 JSON。`;

    // 文本匹配用文本模型（不是视觉模型）
    const textModel = getTextMatchModel(provider);
    const textEndpoint = getTextMatchEndpoint(env, provider);

    const matchResp = await fetch(textEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: textModel,
        messages: [
          { role: 'user', content: matchPrompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!matchResp.ok) {
      const errText = await matchResp.text().catch(() => '');
      return Response.json({ success: false, error: `文本匹配失败 ${matchResp.status}: ${errText.substring(0, 200)}` }, { status: 502 });
    }

    const matchData = await matchResp.json();
    const rawContent = matchData.choices?.[0]?.message?.content?.trim() || '';

    let matches;
    try {
      const jsonStr = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      matches = JSON.parse(jsonStr);
      if (!Array.isArray(matches)) matches = [];
    } catch (e) {
      return Response.json({ success: false, error: '匹配结果解析失败', raw: rawContent.substring(0, 500) }, { status: 500 });
    }

    // 转换为时间戳
    const results = matches.map(m => {
      const sIdx = m.s ?? m.sentence ?? m.sentenceIdx ?? 0;
      const fStart = Math.max(0, m.fStart ?? m.startFrame ?? 0);
      const fEnd = Math.min(frames.length - 1, m.fEnd ?? m.endFrame ?? fStart + 3);

      const startFrame = frames[fStart];
      const endFrame = frames[fEnd];

      return {
        sentenceIdx: sIdx,
        startTime: startFrame ? startFrame.time : 0,
        endTime: endFrame ? endFrame.time : (startFrame ? startFrame.time + 15 : 15),
        startFrame: fStart,
        endFrame: fEnd,
        reason: m.reason || '',
      };
    });

    return Response.json({
      success: true,
      results,
      totalFrames: frames.length,
      totalSentences: sentences.length,
      batchesUsed: totalBatches,
    });
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

// 文本匹配用文本模型
function getTextMatchEndpoint(env, provider) {
  const defaults = {
    qianwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    custom: env.CUSTOM_ENDPOINT || '',
  };
  return defaults[provider] || defaults.qianwen;
}

function getTextMatchModel(provider) {
  const models = {
    qianwen: 'qwen-plus',
    deepseek: 'deepseek-chat',
    doubao: 'doubao-pro-32k',
    openai: 'gpt-4o',
    custom: '',
  };
  return models[provider] || 'qwen-plus';
}
