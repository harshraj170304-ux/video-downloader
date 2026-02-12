const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

// Set PATH to include Deno
const ENV_PATH = `/home/zeus/.deno/bin:${process.env.PATH}`;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// Check if yt-dlp is installed
async function checkDependencies() {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    console.log(`✅ yt-dlp version: ${stdout.trim()}`);
    return true;
  } catch (error) {
    console.error('❌ yt-dlp not installed. Run: pip install yt-dlp');
    return false;
  }
}

// Get video info without downloading
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
    const { stdout } = await execAsync(`yt-dlp ${cookiesArg} --dump-json --no-download "${url}"`, {
      env: { ...process.env, PATH: ENV_PATH },
      maxBuffer: 1024 * 1024 * 10
    });
    const info = JSON.parse(stdout);
    
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      formats: info.formats
        ?.filter(f => f.vcodec !== 'none' && f.height)
        .sort((a, b) => (b.height || 0) - (a.height || 0))
        .slice(0, 10)
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: `${f.width}x${f.height}`,
          height: f.height,
          fps: f.fps,
          filesize: f.filesize ? formatBytes(f.filesize) : 'Unknown'
        })) || []
    });
  } catch (error) {
    console.error('Error getting video info:', error.message);
    res.status(500).json({ error: 'Failed to get video info. Check if the URL is valid.' });
  }
});

// Stream download directly to client (no permanent server storage)
app.post('/api/stream', async (req, res) => {
  const { url, quality = '720' } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const tempId = Date.now();
  const tempOutput = path.join(tempDir, `stream_${tempId}_%(title)s.%(ext)s`);

  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath);

    // Build yt-dlp args
    let args = [];
    if (hasCookies) args.push('--cookies', cookiesPath);
    args.push('--no-playlist', '--no-mtime', '-o', tempOutput);
    
    // Add format selection
    if (quality === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      const height = quality === '4k' ? 2160 : quality === '2k' ? 1440 : quality === '1080' ? 1080 : quality === '720' ? 720 : quality === '480' ? 480 : quality === '360' ? 360 : 240;
      args.push('-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`);
      args.push('--merge-output-format', 'mp4');
    }
    
    args.push(url);
    
    console.log(`Starting stream download: ${url}`);
    
    // Download to temp
    await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, {
        env: { ...process.env, PATH: ENV_PATH }
      });
      
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data; });
      proc.stdout.on('data', (data) => { console.log(data.toString()); });
      
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `Exit code ${code}`));
      });
      proc.on('error', reject);
    });
    
    // Find the downloaded file
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith(`stream_${tempId}`));
    if (files.length === 0) {
      throw new Error('Download failed - no file created');
    }
    
    const filePath = path.join(tempDir, files[0]);
    const stat = fs.statSync(filePath);
    
    // Set headers
    const ext = path.extname(files[0]).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : ext === '.webm' ? 'video/webm' : 'video/mp4';
    const filename = files[0].replace(`stream_${tempId}_`, '');
    
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    
    // Stream file to client
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    // Clean up after sending
    fileStream.on('end', () => {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up temp file: ${files[0]}`);
    });
    
    fileStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    
  } catch (error) {
    console.error('Stream error:', error.message);
    // Clean up temp files on error
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith(`stream_${tempId}`));
    files.forEach(f => {
      const p = path.join(tempDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download: ' + error.message.substring(0, 200) });
    }
  }
});

// Download video (saves to server)
app.post('/api/download', async (req, res) => {
  const { url, quality = 'best' } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const downloadDir = path.join(__dirname, 'downloads');
  const outputPath = path.join(downloadDir, '%(title)s.%(ext)s');
  
  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath);

    // Build yt-dlp args
    let args = [];
    if (hasCookies) args.push('--cookies', cookiesPath);
    
    if (quality === '4k') {
      // 4K (2160p)
      args.push('-f', 'bestvideo[height<=2160]+bestaudio/best[height<=2160]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === 'best' || quality === '2k') {
      // 2K (1440p)
      args.push('-f', 'bestvideo[height<=1440]+bestaudio/best[height<=1440]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === '1080') {
      args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === '720') {
      args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === '480') {
      args.push('-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === '360') {
      args.push('-f', 'bestvideo[height<=360]+bestaudio/best[height<=360]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === '240') {
      args.push('-f', 'bestvideo[height<=240]+bestaudio/best[height<=240]/best', '--merge-output-format', 'mp4', '-o', outputPath, url);
    } else if (quality === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '-o', outputPath, url);
    } else {
      args.push('-f', quality, '--merge-output-format', 'mp4', '-o', outputPath, url);
    }

    console.log(`Starting download: ${url}`);
    
    // Use spawn to avoid shell interpretation issues
    const download = await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { 
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: ENV_PATH }
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });
      
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr || `Exit code ${code}`));
      });
      
      proc.on('error', reject);
    });
    
    // Find the downloaded file
    const files = fs.readdirSync(downloadDir);
    const newFiles = files
      .map(f => ({
        name: f,
        path: `/downloads/${encodeURIComponent(f)}`,
        size: formatBytes(fs.statSync(path.join(downloadDir, f)).size)
      }))
      .sort((a, b) => fs.statSync(path.join(downloadDir, b.name)).mtimeMs - 
                      fs.statSync(path.join(downloadDir, a.name)).mtimeMs);

    res.json({
      success: true,
      message: 'Download complete!',
      files: newFiles.slice(0, 5)
    });
    
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: 'Download failed: ' + error.message });
  }
});

// List downloaded files
app.get('/api/files', (req, res) => {
  const downloadDir = path.join(__dirname, 'downloads');
  
  if (!fs.existsSync(downloadDir)) {
    return res.json({ files: [] });
  }
  
  const files = fs.readdirSync(downloadDir)
    .map(f => ({
      name: f,
      path: `/downloads/${encodeURIComponent(f)}`,
      size: formatBytes(fs.statSync(path.join(downloadDir, f)).size),
      date: fs.statSync(path.join(downloadDir, f)).mtime
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  
  res.json({ files });
});

// Delete a file
app.delete('/api/files/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filepath = path.join(__dirname, 'downloads', filename);
  
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: 'File deleted' });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Start server
checkDependencies().then(ok => {
  if (ok) {
    app.listen(PORT, () => {
      console.log(`🎬 Video Downloader running at http://localhost:${PORT}`);
      console.log(`📁 Downloads saved to: ${path.join(__dirname, 'downloads')}`);
    });
  } else {
    console.error('Install yt-dlp first: pip install yt-dlp');
    process.exit(1);
  }
});
