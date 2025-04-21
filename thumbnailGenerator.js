const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

class ThumbnailGenerator {
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  }

  // Main method to generate thumbnails
  async generateThumbnails(fileUrl, videoInfo) {
    console.log('Starting thumbnail generation with direct ffmpeg spawning');
    
    try {
      // Try direct ffmpeg frame extraction with spawn
      const thumbnails = await this.generateDirectThumbnails(fileUrl, videoInfo);
      
      if (thumbnails && thumbnails.length > 0) {
        return thumbnails;
      }
      
      // If direct approach fails, try to get embedded thumbnail
      console.log('Direct approach failed, trying to extract embedded thumbnail');
      const embeddedThumbnail = await this.extractEmbeddedThumbnail(fileUrl);
      
      if (embeddedThumbnail) {
        return [embeddedThumbnail];
      }
      
      // If all else fails, use http screenshot method with very minimal options
      console.log('Trying minimal screenshot approach');
      return await this.generateMinimalScreenshots(fileUrl, videoInfo);
    } catch (error) {
      console.error('All thumbnail generation methods failed:', error);
      return null;
    }
  }
  
  // Direct ffmpeg execution with very limited memory usage
  async generateDirectThumbnails(fileUrl, videoInfo) {
    const { duration } = videoInfo;
    const timestamps = this._getTimestamps(duration);
    const thumbnails = [];
    
    // Try to generate at most 3 thumbnails to prevent memory issues
    const limitedTimestamps = timestamps.slice(0, 3);
    
    for (const timestamp of limitedTimestamps) {
      const thumbnailPath = path.join(this.tempDir, `thumbnail-${uuidv4()}.jpg`);
      
      try {
        // Use direct spawn with minimal options and lower resolution
        await this._runFfmpegCommand([
          '-y',                         // Overwrite output files
          '-ss', timestamp.toString(),  // Seek to position
          '-i', fileUrl,                // Input file
          '-vframes', '1',              // Extract 1 frame
          '-vf', 'scale=240:-1',        // Lower resolution
          '-q:v', '5',                  // Medium quality (1-31, lower is better)
          thumbnailPath                 // Output file
        ], 30000);
        
        // Verify the thumbnail was created and is valid
        if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
          thumbnails.push(thumbnailPath);
        } else {
          console.log(`Thumbnail at ${thumbnailPath} was not valid, skipping`);
        }
      } catch (error) {
        console.error(`Error generating thumbnail at ${timestamp}:`, error);
        // Continue to next timestamp
      }
    }
    
    return thumbnails;
  }
  
  // Try to extract embedded thumbnail if the video has one
  async extractEmbeddedThumbnail(fileUrl) {
    try {
      const thumbnailPath = path.join(this.tempDir, `embedded-thumbnail-${uuidv4()}.jpg`);
      
      await this._runFfmpegCommand([
        '-i', fileUrl,
        '-map', '0:v:0',
        '-map', '-0:a',
        '-c', 'copy',
        '-frames:v', '1',
        thumbnailPath
      ], 15000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        return thumbnailPath;
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting embedded thumbnail:', error);
      return null;
    }
  }
  
  // Absolutely minimal screenshot approach
  async generateMinimalScreenshots(fileUrl, videoInfo) {
    const { duration } = videoInfo;
    const thumbnails = [];
    
    // Just try one screenshot at 20% of the video
    const timestamp = Math.max(1, Math.min(duration * 0.2, duration - 5));
    const thumbnailPath = path.join(this.tempDir, `minimal-thumbnail-${uuidv4()}.jpg`);
    
    try {
      // Use an extremely minimal command with lower timeouts
      await this._runFfmpegCommand([
        '-ss', timestamp.toString(),
        '-i', fileUrl,
        '-frames:v', '1',
        '-vf', 'scale=160:-1',  // Very small thumbnail
        '-q:v', '10',           // Lower quality
        thumbnailPath
      ], 10000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        thumbnails.push(thumbnailPath);
      }
    } catch (error) {
      console.error('Error in minimal screenshot approach:', error);
    }
    
    return thumbnails;
  }
  
  // Helper method to run ffmpeg with proper error handling and timeouts
  async _runFfmpegCommand(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      console.log(`Running ffmpeg with args: ${args.join(' ')}`);
      
      // Set very conservative memory limits
      const ffmpegProcess = spawn(ffmpegPath, [
        // Add memory limits
        '-threads', '1',        // Use only one thread
        ...args
      ]);
      
      let stdoutData = '';
      let stderrData = '';
      
      // Collect stdout data
      ffmpegProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
      
      // Collect stderr data
      ffmpegProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
      });
      
      // Set a timeout to kill the process if it takes too long
      const timeout = setTimeout(() => {
        console.log('Process timed out, killing ffmpeg');
        ffmpegProcess.kill('SIGKILL');
        reject(new Error('FFmpeg process timed out'));
      }, timeoutMs);
      
      // When process exits
      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve();
        } else {
          console.error(`FFmpeg exited with code ${code}`);
          console.error(`stderr: ${stderrData}`);
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });
      
      // Handle process errors
      ffmpegProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('FFmpeg spawn error:', err);
        reject(err);
      });
    });
  }
  
  // Download thumbnail manually from Telegram
  async downloadThumbnailFromTelegram(fileId, botToken) {
    try {
      // Get file info from Telegram
      const response = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      if (!response.data || !response.data.ok || !response.data.result) {
        console.error('Invalid response from Telegram getFile:', response.data);
        return null;
      }
      
      const filePath = response.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      
      // Download the thumbnail
      const thumbnailPath = path.join(this.tempDir, `manual-thumbnail-${uuidv4()}.jpg`);
      const writer = fs.createWriteStream(thumbnailPath);
      
      try {
        const downloadResponse = await axios({
          method: 'GET',
          url: fileUrl,
          responseType: 'stream',
          timeout: 15000 // 15 second timeout
        });
        
        downloadResponse.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        // Verify file was created successfully
        if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
          return thumbnailPath;
        } else {
          throw new Error('Downloaded thumbnail is empty or not found');
        }
      } catch (downloadError) {
        console.error('Error downloading thumbnail:', downloadError);
        
        // Clean up failed download
        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
        
        return null;
      }
    } catch (error) {
      console.error('Error in downloadThumbnailFromTelegram:', error);
      return null;
    }
  }
  
  // Helper function to get timestamps that are well-distributed
  _getTimestamps(duration) {
    // If duration is 0 or invalid, use default values
    if (!duration || duration <= 0) {
      return [0, 5, 10];
    }
    
    return [
      Math.min(3, duration * 0.1),             // Near start
      Math.min(duration * 0.5, duration - 10), // Middle
      Math.max(duration * 0.8, duration - 5)   // Near end
    ];
  }
  
  // Clean up thumbnail files
  cleanupThumbnails(thumbnailPaths) {
    if (!thumbnailPaths) return;
    
    thumbnailPaths.forEach(path => {
      if (fs.existsSync(path)) {
        try {
          fs.unlinkSync(path);
        } catch (err) {
          console.error(`Error deleting thumbnail file ${path}:`, err);
        }
      }
    });
  }
}

module.exports = ThumbnailGenerator;
