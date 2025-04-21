const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { logActivity, logError } = require('./utils/logger');

/**
 * Class to handle thumbnail generation from videos
 */
class ThumbnailGenerator {
  /**
   * Constructor
   * @param {string} tempDir - Directory to store temporary files
   */
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    logActivity(`ThumbnailGenerator initialized with tempDir: ${this.tempDir}`);
  }
  
  /**
   * Generate thumbnails from a video URL
   * @param {string} videoUrl - URL of the video file
   * @param {Object} videoInfo - Video metadata
   * @returns {Promise<string[]>} - Array of paths to generated thumbnails
   */
  async generateThumbnails(videoUrl, videoInfo) {
    const sessionId = uuidv4();
    const thumbnails = [];
    
    logActivity(`Starting thumbnail generation for session ${sessionId}`);
    
    try {
      // Calculate thumbnail positions (at 10%, 25%, 50%, and 75% of the video)
      const positions = [
        Math.floor(videoInfo.duration * 0.1),
        Math.floor(videoInfo.duration * 0.25),
        Math.floor(videoInfo.duration * 0.5),
        Math.floor(videoInfo.duration * 0.75)
      ];
      
      // Generate a thumbnail for each position
      for (let i = 0; i < positions.length; i++) {
        const position = positions[i];
        const thumbnailPath = path.join(this.tempDir, `${sessionId}_thumb_${i}.jpg`);
        
        logActivity(`Generating thumbnail ${i+1} at position ${position}s`);
        
        try {
          await this.extractFrameWithFfmpeg(videoUrl, position, thumbnailPath);
          thumbnails.push(thumbnailPath);
          logActivity(`Generated thumbnail ${i+1}: ${thumbnailPath}`);
        } catch (error) {
          logError(`Failed to generate thumbnail ${i+1}:`, error);
          // Continue with next thumbnail
        }
      }
      
      logActivity(`Generated ${thumbnails.length} thumbnails for session ${sessionId}`);
      return thumbnails;
    } catch (error) {
      logError(`Error generating thumbnails for session ${sessionId}:`, error);
      // Clean up any generated thumbnails on error
      this.cleanupThumbnails(thumbnails);
      return [];
    }
  }
  
  /**
   * Extract a frame from video using ffmpeg
   * @param {string} videoUrl - URL of the video
   * @param {number} position - Position in seconds
   * @param {string} outputPath - Where to save the extracted frame
   * @returns {Promise<void>}
   */
  extractFrameWithFfmpeg(videoUrl, position, outputPath) {
    return new Promise((resolve, reject) => {
      // Set timeout to prevent hanging
      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('FFmpeg process timed out after 30 seconds'));
      }, 30000);
      
      // Convert position to FFmpeg format (HH:MM:SS)
      const formattedTime = new Date(position * 1000).toISOString().substring(11, 19);
      
      // Run FFmpeg to extract frame
      const ffmpeg = spawn('ffmpeg', [
        '-ss', formattedTime,
        '-i', videoUrl,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        outputPath
      ]);
      
      let stdoutData = '';
      let stderrData = '';
      
      ffmpeg.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
      
      ffmpeg.stderr.on('data', (data) => {
        stderrData += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          const error = new Error(`FFmpeg process failed with code ${code}: ${stderrData}`);
          reject(error);
        }
      });
      
      ffmpeg.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
  
  /**
   * Download a thumbnail from Telegram
   * @param {string} fileId - Telegram file ID
   * @param {string} botToken - Bot token for API access
   * @returns {Promise<string>} - Path to the downloaded thumbnail
   */
  async downloadThumbnailFromTelegram(fileId, botToken) {
    try {
      // Get file info from Telegram
      const fileInfo = await this.getFileInfo(fileId, botToken);
      
      if (!fileInfo || !fileInfo.file_path) {
        throw new Error('Could not get file info from Telegram');
      }
      
      // Generate output path
      const thumbnailPath = path.join(this.tempDir, `manual_${uuidv4()}.jpg`);
      
      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
      await this.downloadFile(fileUrl, thumbnailPath);
      
      logActivity(`Downloaded manual thumbnail: ${thumbnailPath}`);
      return thumbnailPath;
    } catch (error) {
      logError('Error downloading thumbnail from Telegram:', error);
      return null;
    }
  }
  
  /**
   * Get file info from Telegram
   * @param {string} fileId - Telegram file ID
   * @param {string} botToken - Bot token for API access
   * @returns {Promise<Object>} - File information
   */
  async getFileInfo(fileId, botToken) {
    return new Promise((resolve, reject) => {
      const url = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
      
      https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (response.ok) {
              resolve(response.result);
            } else {
              reject(new Error(`Telegram API error: ${response.description}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  }
  
  /**
   * Download a file from URL
   * @param {string} url - URL to download
   * @param {string} outputPath - Where to save the file
   * @returns {Promise<void>}
   */
  async downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);
      
      https.get(url, (response) => {
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(err);
      });
    });
  }
  
  /**
   * Clean up generated thumbnails
   * @param {string[]} thumbnails - Array of thumbnail paths
   */
  cleanupThumbnails(thumbnails) {
    if (!thumbnails || !Array.isArray(thumbnails)) return;
    
    thumbnails.forEach((thumbnailPath) => {
      try {
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
          logActivity(`Cleaned up thumbnail: ${thumbnailPath}`);
        }
      } catch (error) {
        logError(`Error cleaning up thumbnail ${thumbnailPath}:`, error);
      }
    });
  }
}

module.exports = ThumbnailGenerator;
