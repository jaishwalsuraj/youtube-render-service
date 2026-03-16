const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
app.use(express.json({ limit: '200mb' }));

const TMP = '/tmp/renders';
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = proto.get(url, { timeout: 90000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    file.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

function downloadWithFallback(primary, fallback, dest) {
  return downloadFile(primary, dest)
    .then(() => { if (fs.statSync(dest).size < 1000) throw new Error('Too small'); return dest; })
    .catch(() => downloadFile(fallback, dest));
}

function uploadToDrive(filePath, fileName, mimeType, folderId, accessToken) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const boundary = 'RENDER_BOUNDARY_314159';
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const bodyEnd = `\r\n--${boundary}--`;
    const bodyBuf = Buffer.concat([Buffer.from(body), fileContent, Buffer.from(bodyEnd)]);
    const options = {
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary="${boundary}"`, 'Content-Length': bodyBuf.length },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { const p = JSON.parse(data); if (p.id) resolve(p); else reject(new Error('Drive failed: ' + data)); }
        catch (e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}

function cleanup(dir) { try { execSync(`rm -rf "${dir}"`); } catch {} }

app.get('/', (req, res) => {
  let ffmpeg = 'not found';
  try { ffmpeg = execSync('ffmpeg -version 2>&1').toString().split('\n')[0]; } catch {}
  res.json({ status: 'ok', service: 'YouTube Render Microservice', port: PORT, ffmpeg, timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/render', async (req, res) => {
  const start = Date.now();
  const { run_id, tts_chunks_base64, image_urls, thumbnail_url, scene_count, total_seconds, video_title, google_access_token, google_drive_folder_id } = req.body;
  if (!run_id || !tts_chunks_base64 || !image_urls || !google_access_token || !google_drive_folder_id)
    return res.status(400).json({ success: false, error: 'Missing required fields' });

  const runDir = path.join(TMP, run_id);
  ensureDir(runDir);
  console.log(`[${run_id}] Starting — ${scene_count} scenes, ${total_seconds}s`);

  try {
    const chunkFiles = tts_chunks_base64.map((b64, i) => {
      const p = path.join(runDir, `chunk_${i}.mp3`);
      fs.writeFileSync(p, Buffer.from(b64, 'base64')); return p;
    });
    const voicePath = path.join(runDir, 'voiceover.mp3');
    chunkFiles.length === 1 ? fs.copyFileSync(chunkFiles[0], voicePath) : execSync(`cat ${chunkFiles.map(f=>`"${f}"`).join(' ')} > "${voicePath}"`);
    console.log(`[${run_id}] Audio ready.`);

    const musicPath = path.join(runDir, 'bgmusic.mp3');
    try { await downloadFile('https://cdn.pixabay.com/download/audio/2022/11/22/audio_febc508520.mp3', musicPath); } catch {}

    const scenePaths = [];
    for (let i = 0; i < image_urls.length; i++) {
      const dest = path.join(runDir, `scene_${i}.jpg`);
      await downloadWithFallback(image_urls[i], `https://picsum.photos/1920/1080?random=${i+10}`, dest);
      scenePaths.push(dest);
      console.log(`[${run_id}] Scene ${i+1}/${image_urls.length} ready.`);
    }

    const thumbPath = path.join(runDir, 'thumbnail.jpg');
    try { await downloadWithFallback(thumbnail_url, 'https://picsum.photos/1920/1080?random=999', thumbPath); } catch {}

    const count = scenePaths.length;
    const base = Math.floor(total_seconds / count);
    const extra = total_seconds - base * count;
    let concat = scenePaths.map((p,i) => `file '${p}'\nduration ${i===count-1?base+extra:base}`).join('\n') + `\nfile '${scenePaths[count-1]}'`;
    const concatPath = path.join(runDir, 'concat.txt');
    fs.writeFileSync(concatPath, concat);

    const outPath = path.join(runDir, 'output.mp4');
    const fadeOut = Math.max(0, total_seconds - 4);
    const vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p';
    const hasBg = fs.existsSync(musicPath) && fs.statSync(musicPath).size > 10000;
    const cmd = hasBg
      ? `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -i "${voicePath}" -i "${musicPath}" -vf "${vf}" -filter_complex "[1:a]volume=1.0[v];[2:a]volume=0.09,afade=t=in:st=0:d=3,afade=t=out:st=${fadeOut}:d=4[m];[v][m]amix=inputs=2:duration=first:weights=10 1[a]" -map 0:v -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -movflags +faststart -shortest "${outPath}" 2>&1`
      : `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -i "${voicePath}" -vf "${vf}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -movflags +faststart -shortest "${outPath}" 2>&1`;

    console.log(`[${run_id}] Running FFmpeg...`);
    try { execSync(cmd, { maxBuffer: 50*1024*1024, timeout: 600000 }); } catch(e) { throw new Error('FFmpeg: ' + String(e.stdout||e.message||'').substring(0,400)); }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) throw new Error('FFmpeg produced no output.');
    const sizeMB = (fs.statSync(outPath).size/1024/1024).toFixed(1);
    console.log(`[${run_id}] Rendered ${sizeMB}MB`);

    const safeTitle = (video_title||run_id).replace(/[<>:"/\\|?*]/g,'');
    const videoUpload = await uploadToDrive(outPath, `${safeTitle} [${run_id}].mp4`, 'video/mp4', google_drive_folder_id, google_access_token);
    let thumbUpload = null;
    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 1000)
      thumbUpload = await uploadToDrive(thumbPath, `${safeTitle}_thumb_${run_id}.jpg`, 'image/jpeg', google_drive_folder_id, google_access_token);

    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    console.log(`[${run_id}] ✅ Done in ${elapsed}s`);
    cleanup(runDir);

    res.json({ success: true, run_id, elapsed_seconds: parseFloat(elapsed),
      video_file_id: videoUpload.id,
      video_drive_link: `https://drive.google.com/file/d/${videoUpload.id}/view`,
      video_download_link: `https://drive.google.com/uc?export=download&id=${videoUpload.id}`,
      thumbnail_file_id: thumbUpload?.id||null,
      thumbnail_drive_link: thumbUpload?`https://drive.google.com/file/d/${thumbUpload.id}/view`:null,
      video_size_mb: parseFloat(sizeMB)
    });

  } catch(err) {
    console.error(`[${run_id}] ❌`, err.message);
    cleanup(runDir);
    res.status(500).json({ success: false, run_id, error: err.message });
  }
});

ensureDir(TMP);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Render service on 0.0.0.0:${PORT}`);
  try { console.log('✅ FFmpeg:', execSync('ffmpeg -version 2>&1').toString().split('\n')[0]); }
  catch { console.error('❌ FFmpeg not found'); }
});
