/**
 * AI 电影解说视频渲染后端
 *
 * 部署方式（三选一）：
 * 1. Railway.app:  直接推送 GitHub，自动检测 Node.js 项目
 * 2. Render.com:   连接 GitHub 仓库，设置 Start Command: node server.js
 * 3. 自己的 VPS:   安装 Node.js + ffmpeg，运行 node server.js
 *
 * 前置依赖：系统必须安装 ffmpeg
 */

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { EdgeTTS } = require('edge-tts');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 临时文件存储
const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ==================== 健康检查 ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', backend: true, time: new Date().toISOString() });
});

// ==================== TTS 配音生成 ====================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice, rate, pitch } = req.body;
    if (!text) return res.status(400).json({ error: '缺少 text' });

    const outputFile = `/tmp/tts_${uuidv4()}.mp3`;
    const tts = new EdgeTTS({
      text: text,
      voice: voice || 'zh-CN-XiaoxiaoNeural',  // 默认中文女声
      rate: rate || '+0%',
      pitch: pitch || '+0Hz',
    });

    await tts.save(outputFile);
    res.sendFile(outputFile, () => {
      fs.unlink(outputFile, () => {});
    });
  } catch (e) {
    res.status(500).json({ error: 'TTS 失败：' + e.message });
  }
});

// ==================== 视频渲染 ====================
app.post('/api/render', upload.single('video'), async (req, res) => {
  const jobId = uuidv4();
  const workDir = `/tmp/render_${jobId}`;
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const videoFile = req.file;
    const { timeline, copywriting, subtitleStyle, ttsVoice } = req.body;

    if (!videoFile) return res.status(400).json({ error: '缺少视频文件' });

    let timelineData;
    try {
      timelineData = JSON.parse(timeline);
      if (!Array.isArray(timelineData)) timelineData = [timelineData];
    } catch {
      return res.status(400).json({ error: '时间线格式错误' });
    }

    let style = {};
    try { style = JSON.parse(subtitleStyle || '{}'); } catch {}

    const inputPath = videoFile.path;
    const segmentsDir = path.join(workDir, 'segments');
    fs.mkdirSync(segmentsDir, { recursive: true });

    // ======== 第一步：切割视频片段 ========
    console.log(`[${jobId}] 切割 ${timelineData.length} 个片段...`);
    const segmentFiles = [];

    for (let i = 0; i < timelineData.length; i++) {
      const seg = timelineData[i];
      const startTime = seg.startTime || seg.start || 0;
      const endTime = seg.endTime || seg.end || startTime + 10;
      const duration = endTime - startTime;
      const outFile = path.join(segmentsDir, `seg_${String(i).padStart(3, '0')}.mp4`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(startTime)
          .setDuration(duration)
          .output(outFile)
          .outputOptions(['-c:v libx264', '-preset ultrafast', '-crf 23', '-c:a aac'])
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      segmentFiles.push(outFile);
      console.log(`[${jobId}] 片段 ${i + 1}/${timelineData.length}: ${formatTime(startTime)}→${formatTime(endTime)}`);
    }

    // ======== 第二步：生成字幕文件 (ASS 格式) ========
    console.log(`[${jobId}] 生成字幕...`);
    const assFile = path.join(workDir, 'subtitles.ass');
    const assContent = buildASS(timelineData, style, copywriting);
    fs.writeFileSync(assFile, assContent, 'utf-8');

    // ======== 第三步：生成 TTS 配音 ========
    console.log(`[${jobId}] 生成 TTS 配音...`);
    const ttsFile = path.join(workDir, 'narration.mp3');
    let hasTTS = false;

    try {
      const fullText = timelineData.map(s => s.text || '').join('。');
      if (fullText.trim().length > 0) {
        const tts = new EdgeTTS({
          text: fullText.substring(0, 5000), // 限制长度
          voice: ttsVoice || 'zh-CN-XiaoxiaoNeural',
          rate: '+5%',
          pitch: '+0Hz',
        });
        await tts.save(ttsFile);
        hasTTS = true;
        console.log(`[${jobId}] TTS 配音完成`);
      }
    } catch (e) {
      console.log(`[${jobId}] TTS 失败（继续渲染）：${e.message}`);
    }

    // ======== 第四步：拼接片段并烧录字幕 ========
    console.log(`[${jobId}] 拼接并烧录字幕...`);

    // 创建拼接列表
    const concatFile = path.join(workDir, 'concat.txt');
    const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const outputFile = path.join(workDir, 'output.mp4');

    const ffCmd = ffmpeg()
      .input(concatFile)
      .inputOptions(['-f concat', '-safe 0']);

    // 添加字幕滤镜
    const escapedAssFile = assFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    ffCmd.outputOptions([
      '-c:v libx264',
      '-preset ultrafast',
      '-crf 23',
      '-c:a aac',
      '-vf', `ass='${escapedAssFile}'`,
    ]);

    // 如果有 TTS，混合音频
    if (hasTTS && fs.existsSync(ttsFile)) {
      ffCmd.input(ttsFile);
      ffCmd.outputOptions([
        '-filter_complex',
        '[0:a]volume=0.4[a1];[1:a]volume=1.5[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[audio]',
        '-map', '0:v',
        '-map', '[audio]',
      ]);
    } else {
      ffCmd.outputOptions(['-map', '0:v', '-map', '0:a']);
    }

    await new Promise((resolve, reject) => {
      ffCmd.output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[${jobId}] 渲染完成`);

    // ======== 返回文件 ========
    res.setHeader('X-Job-Id', jobId);
    res.sendFile(outputFile, () => {
      // 清理
      setTimeout(() => {
        fs.rm(workDir, { recursive: true, force: true }, () => {});
      }, 5000);
    });
  } catch (e) {
    console.error(`[${jobId}] 渲染失败：`, e.message);
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: '渲染失败：' + e.message });
  }
});

// ==================== 生成 ASS 字幕 ====================
function buildASS(timeline, style, copywriting) {
  const fontSize = style.subtitleSize || 24;
  const fontColor = style.subtitleColor || '&H00FFFFFF'; // ASS 格式: &HBBGGRR
  const fontName = (style.subtitleFont || 'PingFang SC').split(',')[0].replace(/['"]/g, '');
  const strokeSize = style.subtitleStroke === 'none' ? 0 : (parseInt(style.subtitleStroke) || 2);

  // 颜色转换 #ffffff → &HFFFFFF
  let assColor = '&H00FFFFFF';
  if (style.subtitleColor && style.subtitleColor.startsWith('#')) {
    const hex = style.subtitleColor.slice(1);
    assColor = '&H00' + hex[4] + hex[5] + hex[2] + hex[3] + hex[0] + hex[1]; // ABGR
  }

  const header = `[Script Info]
Title: AI Movie Commentary Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${assColor},&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${strokeSize},1,2,30,30,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = '';
  timeline.forEach((seg, i) => {
    const text = seg.text || '';
    const startSec = seg.startTime || seg.start || 0;
    const endSec = seg.endTime || seg.end || startSec + 5;
    const startAss = secondsToASS(startSec);
    const endAss = secondsToASS(endSec);

    // 拆分为短行（ASS 单行不宜过长）
    const maxChars = 30;
    const lines = [];
    for (let j = 0; j < text.length; j += maxChars) {
      lines.push(text.substring(j, j + maxChars));
    }

    lines.forEach(line => {
      events += `Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${line}\n`;
    });
  });

  return header + events;
}

function secondsToASS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.floor((totalSeconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 AI 视频渲染后端运行在端口 ${PORT}`);
  console.log(`   TTS 引擎: Microsoft Edge TTS (免费)`);
  console.log(`   POST /api/render  - 视频渲染`);
  console.log(`   POST /api/tts     - 配音生成`);
  console.log(`   GET  /api/health   - 健康检查`);
});
