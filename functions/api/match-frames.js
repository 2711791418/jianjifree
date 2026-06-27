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

    const MAX_IMAGES_PER_CALL = 15;
    const totalBatches = Math.ceil(frames.length / MAX_IMAGES_PER_CALL);

    // 并行发送所有批次（避免串行超时）
    const batchPromises = [];
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchFrames = frames.slice(batch * MAX_IMAGES_PER_CALL, (batch + 1) * MAX_IMAGES_PER_CALL);
      const validFrames = batchFrames.filter(f => f.base64);
      if (validFrames.length === 0) continue;

      const batchPrompt = `描述每张画面的内容（场景、人物、情绪）。输出JSON：[{"idx":帧号,"desc":"描述"},...]`;
      const userContent = [{ type: 'text', text: batchPrompt }];
      for (const f of validFrames) {
        const b64 = f.base64.split(',')[1] || f.base64;
        userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
      }

      batchPromises.push(
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: userContent }], max_tokens: 1024, temperature: 0.3 }),
        }).then(async r => {
          if (!r.ok) return [];
          const d = await r.json();
          const raw = (d.choices?.[0]?.message?.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          try { return JSON.parse(raw); } catch { return []; }
        }).catch(() => [])
      );
    }

    // 等待所有批次完成（并行，总耗时 = 单批耗时）
    const batchResults = await Promise.all(batchPromises);
    const allFrameDescs = [];
    batchResults.forEach((descs, bi) => {
      if (Array.isArray(descs)) {
        descs.forEach(d => {
          const idx = d.idx ?? d.i ?? bi * MAX_IMAGES_PER_CALL;
          allFrameDescs.push({ index: idx, desc: d.desc || d.description || '', time: frames[idx]?.time || 0 });
        });
      }
    });

    if (allFrameDescs.length === 0) {
      return Response.json({
        success: false,
        error: `${totalBatches} 批次全部失败。可能：1) API Key 未开通视觉模型 2) 模型名错误`,
        hint: '去 dashscope.aliyun.com → 百炼 → 模型广场 → 搜 qwen-vl-plus → 确认已开通',
      }, { status: 500 });
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
