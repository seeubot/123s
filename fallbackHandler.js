const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

class FallbackHandler {
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  }
  
  // Extract video thumbnail from Telegram
  async extractVideoThumbnail(telegram, fileId) {
    try {
      console.log('Trying to extract Telegram\'s own thumbnail');
      const thumbnailPath = path.join(this.tempDir, `telegram-thumbnail-${uuidv4()}.jpg`);
      
      // Get file info
      const fileInfo = await telegram.getFile(fileId);
     
      // Try to download Telegram's auto-generated thumbnail if it exists
      if (fileInfo && fileInfo.thumbnail) {
        const thumbnailFileId = fileInfo.thumbnail.file_id;
        const thumbnailInfo = await telegram.getFile(thumbnailFileId);
        
        if (thumbnailInfo && thumbnailInfo.file_path) {
          // Download the thumbnail
          const downloadUrl = `https://api.telegram.org/file/bot${telegram.token}/${thumbnailInfo.file_path}`;
          const writer = fs.createWriteStream(thumbnailPath);
          
          const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            timeout: 10000 // 10 second timeout
          });
          
          response.data.pipe(writer);
          
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          
          // Verify file was created successfully
          if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
            return thumbnailPath;
          }
        }
      }
      
      // If we get here, try to use ffmpeg to extract the first frame
      return await this.extractFirstFrame(fileInfo, thumbnailPath);
    } catch (error) {
      console.error('Error extracting video thumbnail from Telegram:', error);
      return null;
    }
  }
  
  // Extract first frame as fallback
  async extractFirstFrame(fileInfo, outputPath) {
    try {
      if (!fileInfo || !fileInfo.file_path) {
        return null;
      }
      
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
      
      return new Promise((resolve, reject) => {
        // Use very conservative settings
        const args = [
          '-ss', '0',           // Start at the beginning
          '-i', fileUrl,        // Input file
          '-vframes', '1',      // Extract 1 frame
          '-vf', 'scale=240:-1', // Lower resolution
          '-q:v', '5',          // Medium quality
          outputPath            // Output file
        ];
        
        console.log(`Running ffmpeg first frame extraction: ${ffmpegPath} ${args.join(' ')}`);
        
        const ffmpegProcess = spawn(ffmpegPath, [
          '-threads', '1',      // Use only one thread
          ...args
        ]);
        
        let stderrData = '';
        
        ffmpegProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
        });
        
        // Set a timeout to kill the process if it takes too long
        const timeout = setTimeout(() => {
          console.log('First frame extraction timed out, killing ffmpeg');
          ffmpegProcess.kill('SIGKILL');
          reject(new Error('FFmpeg process timed out'));
        }, 15000);
        
        ffmpegProcess.on('close', (code) => {
          clearTimeout(timeout);
          
          if (code === 0) {
            // Check if file exists and has content
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
              resolve(outputPath);
            } else {
              console.log('First frame extraction produced empty file');
              resolve(null);
            }
          } else {
            console.error(`FFmpeg exited with code ${code}`);
            console.error(`stderr: ${stderrData}`);
            resolve(null); // Resolve with null to continue with other methods
          }
        });
        
        ffmpegProcess.on('error', (err) => {
          clearTimeout(timeout);
          console.error('FFmpeg spawn error:', err);
          resolve(null); // Resolve with null to continue with other methods
        });
      });
    } catch (error) {
      console.error('Error extracting first frame:', error);
      return null;
    }
  }
  
  // Generate text-based thumbnail using ffmpeg (replaces canvas-based approach)
  async generatePlaceholderThumbnail(videoName) {
    try {
      console.log('Generating ffmpeg text-based placeholder thumbnail');
      const thumbnailPath = path.join(this.tempDir, `placeholder-thumbnail-${uuidv4()}.jpg`);
      
      // Create a safe version of the video name (escape special characters)
      const safeName = (videoName || 'Unknown Video').replace(/['"]/g, '');
      
      return new Promise((resolve, reject) => {
        // Create a simple black image with text using ffmpeg
        const args = [
          '-f', 'lavfi',
          '-i', 'color=c=black:s=640x360',
          '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='${safeName}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`,
          '-frames:v', '1',
          thumbnailPath
        ];
        
        console.log(`Running ffmpeg placeholder generation: ${args.join(' ')}`);
        
        const ffmpegProcess = spawn(ffmpegPath, args);
        
        let stderrData = '';
        
        ffmpegProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
        });
        
        const timeout = setTimeout(() => {
          ffmpegProcess.kill('SIGKILL');
          reject(new Error('FFmpeg placeholder generation timed out'));
        }, 10000);
        
        ffmpegProcess.on('close', (code) => {
          clearTimeout(timeout);
          
          if (code === 0 && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
            resolve(thumbnailPath);
          } else {
            console.error(`Failed to generate placeholder, code: ${code}`);
            console.error(`stderr: ${stderrData}`);
            
            // Try a simpler approach as last resort
            this.generateSimplePlaceholder(thumbnailPath).then(result => {
              if (result) {
                resolve(thumbnailPath);
              } else {
                resolve(null);
              }
            }).catch(() => resolve(null));
          }
        });
        
        ffmpegProcess.on('error', (err) => {
          clearTimeout(timeout);
          console.error('FFmpeg placeholder error:', err);
          this.generateSimplePlaceholder(thumbnailPath).then(result => {
            if (result) {
              resolve(thumbnailPath);
            } else {
              resolve(null);
            }
          }).catch(() => resolve(null));
        });
      });
    } catch (error) {
      console.error('Error generating placeholder thumbnail:', error);
      return null;
    }
  }
  
  // Super simple placeholder generation as a last resort
  async generateSimplePlaceholder(outputPath) {
    try {
      // Create a very basic black image
      const args = [
        '-f', 'lavfi',
        '-i', 'color=c=black:s=320x240:d=1',
        '-frames:v', '1',
        outputPath
      ];
      
      return new Promise((resolve) => {
        const ffmpegProcess = spawn(ffmpegPath, args);
        
        ffmpegProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        
        ffmpegProcess.on('error', () => {
          resolve(false);
        });
      });
    } catch (error) {
      console.error('Error in simple placeholder:', error);
      return false;
    }
  }
  
  // Advanced thumbnail extraction with precise seeking
  async extractAdvancedThumbnail(fileUrl, videoInfo) {
    try {
      const { duration } = videoInfo;
      const thumbnailPath = path.join(this.tempDir, `advanced-thumbnail-${uuidv4()}.jpg`);
      
      // Calculate better thumbnail position (25% into the video)
      const position = Math.max(1, Math.min(duration * 0.25, duration - 5));
      
      return new Promise((resolve, reject) => {
        // Use more advanced ffmpeg options for better thumbnail extraction
        const args = [
          // Fast seeking to approximate position first
          '-ss', position.toString(),
          '-i', fileUrl,
          // Then fine-tune with precise seeking
          '-frames:v', '1',
          '-q:v', '2',             // High quality
          '-vf', 'scale=640:-1',   // Better resolution
          thumbnailPath
        ];
        
        console.log(`Running advanced thumbnail extraction: ${args.join(' ')}`);
        
        const ffmpegProcess = spawn(ffmpegPath, args);
        
        let stderrData = '';
        ffmpegProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
        });
        
        // Set timeout
        const timeout = setTimeout(() => {
          ffmpegProcess.kill('SIGKILL');
          reject(new Error('Advanced thumbnail extraction timed out'));
        }, 30000);
        
        ffmpegProcess.on('close', (code) => {
          clearTimeout(timeout);
          
          if (code === 0 && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
            resolve(thumbnailPath);
          } else {
            console.error(`Advanced extraction failed, code: ${code}`);
            resolve(null);
          }
        });
        
        ffmpegProcess.on('error', (err) => {
          clearTimeout(timeout);
          console.error('FFmpeg advanced extraction error:', err);
          resolve(null);
        });
      });
    } catch (error) {
      console.error('Error in advanced thumbnail extraction:', error);
      return null;
    }
  }
}

module.exports = FallbackHandler;
