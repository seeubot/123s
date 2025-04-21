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
    console.log('Starting thumbnail generation process');
    
    try {
      // First try to get video information if not provided
      if (!videoInfo || !videoInfo.duration) {
        videoInfo = await this.getVideoMetadata(fileUrl);
        console.log('Retrieved video metadata:', videoInfo);
      }
      
      // Method 1: Try extract embedded thumbnail with proper conversion
      console.log('Trying to extract embedded thumbnail with format conversion');
      const embeddedThumbnail = await this.extractEmbeddedThumbnailWithConversion(fileUrl);
      
      if (embeddedThumbnail) {
        console.log('Successfully extracted and converted embedded thumbnail');
        return [embeddedThumbnail];
      }
      
      // Method 2: Try to generate thumbnails with improved approach
      console.log('Trying thumbnails with improved method');
      const thumbnails = await this.generateImprovedThumbnails(fileUrl, videoInfo);
      
      if (thumbnails && thumbnails.length > 0) {
        return thumbnails;
      }
      
      // Method 3: Create a blank thumbnail with text as fallback
      console.log('All thumbnail methods failed, creating fallback thumbnail');
      const fallbackThumbnail = await this.createFallbackThumbnail(videoInfo);
      
      if (fallbackThumbnail) {
        return [fallbackThumbnail];
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
        
        // Use ffprobe if available, otherwise use ffmpeg
        const probePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
        const ffprobeProcess = spawn(
          fs.existsSync(probePath) ? probePath : ffmpegPath, 
          ffprobeArgs
        );
        
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
  
  // Extract embedded thumbnail with conversion to make it Telegram-compatible
  async extractEmbeddedThumbnailWithConversion(fileUrl) {
    try {
      const rawThumbnailPath = path.join(this.tempDir, `raw-thumbnail-${uuidv4()}.jpg`);
      const convertedThumbnailPath = path.join(this.tempDir, `converted-thumbnail-${uuidv4()}.jpg`);
      
      // Step 1: Try to extract the embedded thumbnail
      try {
        await this._runFfmpegCommand([
          '-i', fileUrl,
          '-map', '0:v:0',
          '-map', '-0:a',
          '-c', 'copy',
          '-frames:v', '1',
          rawThumbnailPath
        ], 15000);
        
        // Check if thumbnail was extracted
        if (!fs.existsSync(rawThumbnailPath) || fs.statSync(rawThumbnailPath).size < 100) {
          console.log('No valid embedded thumbnail found, trying alternative method');
          
          // Try alternative methods for extraction
          await this._runFfmpegCommand([
            '-i', fileUrl,
            '-an',  // No audio
            '-vcodec', 'copy',
            '-y',
            rawThumbnailPath
          ], 15000);
        }
        
        // Check again if we have a valid file
        if (fs.existsSync(rawThumbnailPath) && fs.statSync(rawThumbnailPath).size > 100) {
          // Step 2: Convert the thumbnail to a format Telegram can handle (JPEG)
          await this._runFfmpegCommand([
            '-i', rawThumbnailPath,
            '-vf', 'scale=320:-1', // Resize to reasonable size
            '-q:v', '2',           // High quality
            '-f', 'image2',        // Force image format
            '-vcodec', 'mjpeg',    // Use MJPEG codec (more compatible)
            convertedThumbnailPath
          ], 10000);
          
          // Clean up the raw thumbnail
          try {
            if (fs.existsSync(rawThumbnailPath)) {
              fs.unlinkSync(rawThumbnailPath);
            }
          } catch (e) {
            console.error('Error cleaning up raw thumbnail:', e);
          }
          
          // Check if conversion succeeded
          if (fs.existsSync(convertedThumbnailPath) && fs.statSync(convertedThumbnailPath).size > 100) {
            return convertedThumbnailPath;
          }
        }
      } catch (extractError) {
        console.error('Error extracting or converting embedded thumbnail:', extractError);
        // Clean up any partial files
        this.cleanupThumbnails([rawThumbnailPath, convertedThumbnailPath]);
      }
      
      return null;
    } catch (error) {
      console.error('Error in extractEmbeddedThumbnailWithConversion:', error);
      return null;
    }
  }
  
  // Generate thumbnails with improved approach to work with Telegram
  async generateImprovedThumbnails(fileUrl, videoInfo) {
    const { duration } = videoInfo || { duration: 10 };
    const thumbnails = [];
    
    // Try different positions in the video
    const positions = [
      Math.min(1, duration * 0.1),      // Near start but avoid potential black frames
      Math.max(2, duration * 0.25),     // 1/4 through
      Math.max(3, duration * 0.5)       // Middle
    ];
    
    for (const position of positions) {
      const thumbnailPath = path.join(this.tempDir, `improved-thumbnail-${uuidv4()}.jpg`);
      
      try {
        // Use a more robust approach - seek first, then input
        await this._runFfmpegCommand([
          '-ss', position.toString(),   // Seek before input for better accuracy
          '-i', fileUrl,                // Video file
          '-vframes', '1',              // Single frame
          '-vf', 'scale=320:-1',        // Scale to 320px width
          '-f', 'image2',               // Force image output
          '-q:v', '2',                  // High quality
          thumbnailPath                 // Output path
        ], 30000);
        
        // Verify and test if the created thumbnail is valid
        if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
          // Additional validation to ensure it's a valid image
          try {
            // Try to re-encode it to confirm it's a valid image
            const validationPath = path.join(this.tempDir, `validation-${uuidv4()}.jpg`);
            
            await this._runFfmpegCommand([
              '-i', thumbnailPath,
              '-f', 'image2',
              validationPath
            ], 5000);
            
            // If validation passes, use this thumbnail
            if (fs.existsSync(validationPath) && fs.statSync(validationPath).size > 100) {
              // Use the validated image instead
              thumbnails.push(validationPath);
              
              // Clean up original
              this.cleanupThumbnails([thumbnailPath]);
              console.log(`Successfully generated validated thumbnail at position ${position}`);
              
              // Break after one successful thumbnail
              break;
            } else {
              console.log(`Generated thumbnail failed validation, trying next position`);
              this.cleanupThumbnails([thumbnailPath, validationPath]);
            }
          } catch (validationError) {
            console.error(`Thumbnail validation failed:`, validationError);
            this.cleanupThumbnails([thumbnailPath]);
          }
        } else {
          console.log(`Generated thumbnail was invalid, trying next position`);
          this.cleanupThumbnails([thumbnailPath]);
        }
      } catch (error) {
        console.error(`Error generating thumbnail at position ${position}:`, error);
        this.cleanupThumbnails([thumbnailPath]);
      }
    }
    
    return thumbnails;
  }
  
  // Create a simple fallback thumbnail with text
  async createFallbackThumbnail(videoInfo) {
    try {
      const { duration } = videoInfo || { duration: 0 };
      const thumbnailPath = path.join(this.tempDir, `fallback-thumbnail-${uuidv4()}.jpg`);
      
      // Create a thumbnail with duration info
      const durationText = duration > 0 ? `Duration: ${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}` : 'Video';
      
      // Generate image with text
      await this._runFfmpegCommand([
        '-f', 'lavfi',
        '-i', `color=c=black:s=320x240`,
        '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${durationText}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-frames:v', '1',
        thumbnailPath
      ], 10000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        console.log('Created fallback thumbnail with text');
        return thumbnailPath;
      }
      
      // If text overlay fails, try just a simple color
      console.log('Text overlay failed, creating simple color thumbnail');
      await this._runFfmpegCommand([
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=320x240',
        '-frames:v', '1',
        thumbnailPath
      ], 5000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        console.log('Created simple color thumbnail');
        return thumbnailPath;
      }
      
      return null;
    } catch (error) {
      console.error('Error creating fallback thumbnail:', error);
      return null;
    }
  }
  
  // Helper method to run ffmpeg with proper error handling and timeouts
  async _runFfmpegCommand(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      console.log(`Running ffmpeg with args: ${args.join(' ')}`);
      
      // Set conservative memory limits
      const ffmpegProcess = spawn(ffmpegPath, [
        '-hide_banner',         // Hide ffmpeg banner
        '-threads', '1',        // Use only one thread
        '-loglevel', 'error',   // Only show errors in logs
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
  
  // Clean up thumbnail files
  cleanupThumbnails(thumbnailPaths) {
    if (!thumbnailPaths) return;
    
    thumbnailPaths.forEach(path => {
      if (path && fs.existsSync(path)) {
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
