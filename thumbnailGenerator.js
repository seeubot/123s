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

  // Main method to generate thumbnails with enhanced error handling and retries
  async generateThumbnails(fileUrl, videoInfo) {
    console.log('Starting thumbnail generation process');
    
    try {
      // First try to get video information if not provided
      if (!videoInfo || !videoInfo.duration) {
        videoInfo = await this.getVideoMetadata(fileUrl);
        console.log('Retrieved video metadata:', videoInfo);
      }
      
      // Try each method with retries
      // Method 1: Direct ffmpeg frame extraction (with retries)
      let thumbnails = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`Attempt ${attempt} using direct extraction method`);
        thumbnails = await this.generateDirectThumbnails(fileUrl, videoInfo);
        if (thumbnails && thumbnails.length > 0) {
          console.log(`Direct extraction succeeded on attempt ${attempt}`);
          return thumbnails;
        }
      }
      
      // Method 2: Try to extract embedded thumbnail
      console.log('Direct approach failed, trying to extract embedded thumbnail');
      const embeddedThumbnail = await this.extractEmbeddedThumbnail(fileUrl);
      
      if (embeddedThumbnail) {
        console.log('Successfully extracted embedded thumbnail');
        return [embeddedThumbnail];
      }
      
      // Method 3: Use multiple screenshot methods with different configurations
      console.log('Trying alternative screenshot approaches');
      thumbnails = await this.generateMultipleScreenshots(fileUrl, videoInfo);
      
      if (thumbnails && thumbnails.length > 0) {
        return thumbnails;
      }
      
      // If we reach here, all methods failed
      console.error('All thumbnail generation methods failed');
      return null;
    } catch (error) {
      console.error('Fatal error in thumbnail generation:', error);
      return null;
    }
  }
  
  // Get video metadata if not provided
  async getVideoMetadata(fileUrl) {
    try {
      console.log('Getting video metadata');
      
      return new Promise((resolve, reject) => {
        const ffprobeArgs = [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          fileUrl
        ];
        
        const ffprobeProcess = spawn(ffmpegPath.replace('ffmpeg', 'ffprobe'), ffprobeArgs);
        
        let outputData = '';
        let errorData = '';
        
        ffprobeProcess.stdout.on('data', (data) => {
          outputData += data.toString();
        });
        
        ffprobeProcess.stderr.on('data', (data) => {
          errorData += data.toString();
        });
        
        ffprobeProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const metadata = JSON.parse(outputData);
              const duration = parseFloat(metadata.format.duration);
              resolve({ duration });
            } catch (error) {
              console.error('Error parsing ffprobe output:', error);
              // Default fallback values
              resolve({ duration: 10 });
            }
          } else {
            console.error(`ffprobe exited with code ${code}: ${errorData}`);
            // Default fallback values
            resolve({ duration: 10 });
          }
        });
        
        // Handle process errors
        ffprobeProcess.on('error', (err) => {
          console.error('ffprobe spawn error:', err);
          // Default fallback values
          resolve({ duration: 10 });
        });
      });
    } catch (error) {
      console.error('Error in getVideoMetadata:', error);
      // Default fallback values
      return { duration: 10 };
    }
  }
  
  // Direct ffmpeg execution with memory optimization
  async generateDirectThumbnails(fileUrl, videoInfo) {
    const { duration } = videoInfo;
    const timestamps = this._getTimestamps(duration);
    const thumbnails = [];
    
    // Try to generate thumbnails at different timestamps
    const limitedTimestamps = timestamps.slice(0, 3);
    
    for (const timestamp of limitedTimestamps) {
      const thumbnailPath = path.join(this.tempDir, `thumbnail-${uuidv4()}.jpg`);
      
      try {
        // Try with different quality settings
        const configs = [
          // Config 1: Lower resolution
          {
            args: [
              '-y',
              '-ss', timestamp.toString(),
              '-i', fileUrl,
              '-vframes', '1',
              '-vf', 'scale=240:-1',
              '-q:v', '5',
              thumbnailPath
            ],
            timeout: 30000
          },
          // Config 2: Higher quality settings
          {
            args: [
              '-y',
              '-ss', timestamp.toString(),
              '-i', fileUrl,
              '-vframes', '1',
              '-q:v', '2',
              thumbnailPath
            ],
            timeout: 30000
          }
        ];
        
        // Try different configurations until one works
        for (const config of configs) {
          try {
            await this._runFfmpegCommand(config.args, config.timeout);
            
            // Verify the thumbnail was created and is valid
            if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
              thumbnails.push(thumbnailPath);
              console.log(`Successfully generated thumbnail at ${timestamp}`);
              break; // Success, break out of configuration loop
            }
          } catch (configError) {
            console.log(`Config failed for timestamp ${timestamp}:`, configError.message);
            // Continue to next config
          }
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
      
      // Try two different methods for extracting embedded thumbnails
      const methods = [
        // Method 1: Copy first video frame
        {
          args: [
            '-i', fileUrl,
            '-map', '0:v:0',
            '-map', '-0:a',
            '-c', 'copy',
            '-frames:v', '1',
            thumbnailPath
          ],
          timeout: 15000
        },
        // Method 2: Extract album art/cover
        {
          args: [
            '-i', fileUrl,
            '-an',
            '-vcodec', 'copy',
            '-y',
            thumbnailPath
          ],
          timeout: 15000
        }
      ];
      
      for (const method of methods) {
        try {
          await this._runFfmpegCommand(method.args, method.timeout);
          
          if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
            console.log('Successfully extracted embedded thumbnail');
            return thumbnailPath;
          }
        } catch (methodError) {
          console.log(`Embedded thumbnail method failed:`, methodError.message);
          // Continue to next method
        }
      }
      
      console.log('No embedded thumbnail found');
      return null;
    } catch (error) {
      console.error('Error extracting embedded thumbnail:', error);
      return null;
    }
  }
  
  // Generate multiple screenshots with different approaches
  async generateMultipleScreenshots(fileUrl, videoInfo) {
    const { duration } = videoInfo;
    const thumbnails = [];
    
    // Try multiple timestamps and configurations
    const timestamps = [
      Math.max(1, Math.min(duration * 0.1, 3)),       // Near start
      Math.max(1, Math.min(duration * 0.2, 5)),       // Early
      Math.max(1, Math.min(duration * 0.5, duration * 0.5))  // Middle
    ];
    
    for (const timestamp of timestamps) {
      const thumbnailPath = path.join(this.tempDir, `minimal-thumbnail-${uuidv4()}.jpg`);
      
      const configs = [
        // Config 1: Very minimal
        {
          args: [
            '-ss', timestamp.toString(),
            '-i', fileUrl,
            '-frames:v', '1',
            '-vf', 'scale=160:-1',
            '-q:v', '10',
            thumbnailPath
          ],
          timeout: 10000
        },
        // Config 2: Input first, then seek (sometimes more reliable)
        {
          args: [
            '-i', fileUrl,
            '-ss', timestamp.toString(),
            '-frames:v', '1',
            '-vf', 'scale=240:-1',
            '-q:v', '5',
            thumbnailPath
          ],
          timeout: 15000
        },
        // Config 3: Stream copy
        {
          args: [
            '-ss', timestamp.toString(),
            '-i', fileUrl,
            '-frames:v', '1',
            '-c:v', 'mjpeg',
            '-f', 'image2',
            thumbnailPath
          ],
          timeout: 15000
        }
      ];
      
      for (const config of configs) {
        try {
          await this._runFfmpegCommand(config.args, config.timeout);
          
          if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
            thumbnails.push(thumbnailPath);
            console.log(`Successfully generated minimal screenshot at ${timestamp}`);
            break; // Success, break out of configuration loop
          }
        } catch (configError) {
          // Just continue to next config
        }
      }
      
      // If we got a thumbnail, we can stop trying
      if (thumbnails.length > 0) {
        break;
      }
    }
    
    return thumbnails;
  }
  
  // Helper method to run ffmpeg with proper error handling and timeouts
  async _runFfmpegCommand(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      console.log(`Running ffmpeg with args: ${args.join(' ')}`);
      
      // Set conservative memory limits and optimize for speed
      const ffmpegProcess = spawn(ffmpegPath, [
        '-hide_banner',       // Hide ffmpeg banner
        '-threads', '1',      // Use only one thread
        '-loglevel', 'error', // Only show errors in logs
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
        try {
          ffmpegProcess.kill('SIGKILL');
        } catch (e) {
          console.error('Error killing ffmpeg process:', e);
        }
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
  
  // Download thumbnail manually from Telegram with enhanced reliability
  async downloadThumbnailFromTelegram(fileId, botToken) {
    try {
      // Get file info from Telegram with retry
      let response = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, {
            timeout: 10000
          });
          if (response.data && response.data.ok) {
            break;
          }
        } catch (retryError) {
          console.log(`Telegram API retry ${attempt} failed:`, retryError.message);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
        }
      }
      
      if (!response || !response.data || !response.data.ok || !response.data.result) {
        console.error('Invalid response from Telegram getFile:', response?.data);
        return null;
      }
      
      const filePath = response.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      
      // Download the thumbnail with retry
      const thumbnailPath = path.join(this.tempDir, `telegram-thumbnail-${uuidv4()}.jpg`);
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const writer = fs.createWriteStream(thumbnailPath);
          
          const downloadResponse = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'stream',
            timeout: 15000
          });
          
          downloadResponse.data.pipe(writer);
          
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          
          // Verify file was created successfully
          if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
            console.log('Successfully downloaded thumbnail from Telegram');
            return thumbnailPath;
          }
          
          console.log(`Downloaded file is invalid on attempt ${attempt}`);
          
          // Clean up failed download
          if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
          }
        } catch (downloadError) {
          console.error(`Error downloading thumbnail on attempt ${attempt}:`, downloadError.message);
          
          // Clean up failed download
          if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
          }
          
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
        }
      }
      
      console.log('All download attempts failed');
      return null;
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
    
    // More timestamps at different positions for better chances of success
    return [
      Math.min(1, duration * 0.05),            // Very start
      Math.min(3, duration * 0.1),             // Near start
      Math.min(duration * 0.25, duration / 4), // First quarter
      Math.min(duration * 0.5, duration / 2),  // Middle
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
  
  // Utility method to create a simple blank thumbnail as last resort
  async createBlankThumbnail(width = 320, height = 240) {
    try {
      const thumbnailPath = path.join(this.tempDir, `blank-thumbnail-${uuidv4()}.jpg`);
      
      await this._runFfmpegCommand([
        '-f', 'lavfi',
        '-i', `color=c=black:s=${width}x${height}`,
        '-frames:v', '1',
        thumbnailPath
      ], 5000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
        console.log('Created blank thumbnail as fallback');
        return thumbnailPath;
      }
      
      return null;
    } catch (error) {
      console.error('Error creating blank thumbnail:', error);
      return null;
    }
  }
}

module.exports = ThumbnailGenerator;
