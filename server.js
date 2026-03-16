const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/render', (req, res) => {
  const { videoUrl, outputFormat } = req.body;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl required' });
  }

  const outputFile = path.join('/tmp', `output-${Date.now()}.${outputFormat || 'mp4'}`);
  
  const ffmpeg = spawn('ffmpeg', [
    '-i', videoUrl,
    '-c:v', 'libx264',
    '-preset', 'fast',
    outputFile
  ]);

  ffmpeg.on('close', (code) => {
    if (code === 0) {
      res.download(outputFile, () => {
        fs.unlink(outputFile, () => {});
      });
    } else {
      res.status(500).json({ error: 'Render failed' });
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    console.error(`FFmpeg: ${data}`);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Render service running on port ${PORT}`);
});
