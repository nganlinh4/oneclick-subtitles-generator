/**
 * Douyin video downloader using Puppeteer
 * This approach uses a headless browser to navigate to the Douyin page,
 * wait for the video to load, and then extract the video URL.
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Download a file from a URL to a local path
 * @param {string} url - URL of the file to download
 * @param {string} outputPath - Path where the file should be saved
 * @returns {Promise<boolean>} - True if download was successful
 */
async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {


    // Create directory if it doesn't exist
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Determine if we need http or https
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.douyin.com/',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    }, (response) => {
      // Check if response is a redirect
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {

        // Recursively follow redirects
        downloadFile(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      // Check if response is successful
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file: HTTP status code ${response.statusCode}`));
        return;
      }

      // Create write stream
      const fileStream = fs.createWriteStream(outputPath);

      // Set up event handlers
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();

        resolve(true);
      });

      fileStream.on('error', (err) => {
        fs.unlink(outputPath, () => {}); // Delete the file if there's an error
        reject(err);
      });

      // Track download progress
      let downloaded = 0;
      const total = parseInt(response.headers['content-length'] || 0);

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const percent = Math.round((downloaded / total) * 100);
          process.stdout.write(`Download progress: ${percent}%\r`);
        }
      });
    });

    request.on('error', (err) => {
      fs.unlink(outputPath, () => {}); // Delete the file if there's an error
      reject(err);
    });
  });
}

/**
 * Extract video URL from Douyin page using Puppeteer
 * @param {string} url - Douyin video URL
 * @returns {Promise<string>} - Direct video URL
 */
async function extractVideoUrl(url) {


  // Find Chrome executable path
  let executablePath;

  if (process.platform === 'win32') {
    // Common Chrome paths on Windows
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];

    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        executablePath = path;

        break;
      }
    }
  } else if (process.platform === 'darwin') {
    // macOS
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    // Linux
    executablePath = '/usr/bin/google-chrome';
  }

  if (!executablePath) {
    throw new Error('Could not find Chrome executable. Please install Chrome or set PUPPETEER_EXECUTABLE_PATH environment variable.');
  }

  // Create a temporary user data directory for clean browser state
  const os = require('os');
  const tempDir = os.tmpdir();
  const userDataDir = path.join(tempDir, `douyin-puppeteer-${Date.now()}`);

  // Ensure the directory exists
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Launch browser with clean user data directory
  const browser = await puppeteer.launch({
    headless: 'new', // Use new headless mode
    executablePath: executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      `--user-data-dir=${userDataDir}`,
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images', // Speed up loading by disabling images
      '--disable-javascript', // Wait, we need JS for video extraction
      // Actually, keep JS enabled but disable other features
    ]
  });

  try {
    // Open new page
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Enable request interception to capture video URLs
    await page.setRequestInterception(true);

    // Store video URLs
    let videoUrls = [];

    // Listen for requests
    page.on('request', (request) => {
      // Allow the request to continue
      request.continue();
    });

    // Listen for responses
    page.on('response', async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Look for video content in responses
      if (
        // Exclude common background videos and login videos
        !url.includes('douyin-pc-web/uuu_') &&
        !url.includes('login-video') &&
        !url.includes('login_video') &&
        !url.includes('background-video') &&
        !url.includes('background_video') &&
        !url.includes('intro-video') &&
        !url.includes('intro_video') &&
        (
          // Include video content types
          (url.includes('.mp4') || url.includes('/play/') || url.includes('video')) &&
          (contentType.includes('video') || url.includes('mime/video'))
        )
      ) {

        videoUrls.push(url);
      }
    });

    // Navigate to the page

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    // Check for login modal and close it if present



    // Wait a moment for the modal to appear
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to find and click the close button on the login modal
    const closeButtonSelectors = [
      '.login-guide-close', // Common class for close buttons
      '.modal-close-icon',  // Another common class
      'button.close',       // Generic close button
      '.login-modal .close',// Login modal close button
      '.login-panel .close',// Login panel close button
      '[aria-label="Close"]', // Accessibility label
      '.login-guide .close-icon', // Specific to Douyin
      '.dy-account-close',  // Douyin specific
      '.webcast-dialog-close-button', // Douyin dialog close
      '.modal-header .close', // Bootstrap-style modal close
      '.close-button',      // Generic close button class
      '.modal-close',       // Generic modal close
      '.dialog-close',      // Generic dialog close
      '.login-guide-container .close', // Specific container close
      '.login-guide-container button', // Any button in login container
      '.login-guide-container [role="button"]', // Any element with button role
      '.login-guide-container .icon-close', // Icon close
      '.login-guide-container .icon-cross', // Icon cross
      '.login-guide-container .icon-cancel', // Icon cancel
      '.login-guide-container .icon-dismiss', // Icon dismiss
      '.login-guide-container .dismiss', // Dismiss button
      '.login-guide-container .cancel', // Cancel button
      '.login-guide-container .skip', // Skip button
      '.login-guide-container .later', // Later button
      '.login-guide-container .not-now', // Not now button
      '.login-guide-container .no-thanks', // No thanks button
      '.login-guide-container .close-icon', // Close icon
      '.login-guide-container .cross-icon', // Cross icon
      '.login-guide-container .cancel-icon', // Cancel icon
      '.login-guide-container .dismiss-icon', // Dismiss icon
      '.login-guide-container [aria-label="Close"]', // Accessibility label
      '.login-guide-container [aria-label="Dismiss"]', // Accessibility label
      '.login-guide-container [aria-label="Cancel"]', // Accessibility label
      '.login-guide-container [aria-label="Skip"]', // Accessibility label
      '.login-guide-container [aria-label="Later"]', // Accessibility label
      '.login-guide-container [aria-label="Not now"]', // Accessibility label
      '.login-guide-container [aria-label="No thanks"]', // Accessibility label
    ];

    // Try each selector
    let modalClosed = false;
    for (const selector of closeButtonSelectors) {
      try {
        const closeButton = await page.$(selector);
        if (closeButton) {

          await closeButton.click();

          modalClosed = true;
          // Wait a moment for the modal to close
          await new Promise(resolve => setTimeout(resolve, 1000));
          break;
        }
      } catch (error) {

      }
    }

    // If we couldn't find a close button with selectors, try clicking at common positions
    if (!modalClosed) {


      // Common positions for close buttons (top-right corner)
      const positions = [
        { x: 20, y: 20 },    // Very top-left (sometimes there's a back button)
        { x: 50, y: 20 },    // Top-left area
        { x: 780, y: 20 },   // Top-right area
        { x: 900, y: 20 },   // Very top-right
        { x: 400, y: 400 },  // Center (sometimes there's a "continue without login" option)
        { x: 400, y: 500 },  // Below center
        { x: 400, y: 600 }   // Further below center
      ];

      for (const pos of positions) {
        try {
          await page.mouse.click(pos.x, pos.y);

          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {

        }
      }
    }



    // Try to press Escape key to close modal
    await page.keyboard.press('Escape');

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Wait for video element to appear

    await page.waitForSelector('video', { timeout: 30000 }).catch(() => {

    });

    // Wait a bit more for any additional requests
    await new Promise(resolve => setTimeout(resolve, 5000));

    // If we haven't found any video URLs through network requests,
    // try to extract them from the page
    if (videoUrls.length === 0) {


      // Extract video URLs from video elements with more context
      const srcUrls = await page.evaluate(() => {
        const results = [];
        // Get all video elements
        const videoElements = Array.from(document.querySelectorAll('video'));

        videoElements.forEach(video => {
          // Skip small videos (likely UI elements or background videos)
          const width = video.offsetWidth || video.clientWidth || 0;
          const height = video.offsetHeight || video.clientHeight || 0;
          const isVisible = video.style.display !== 'none' &&
                           video.style.visibility !== 'hidden' &&
                           width > 200 && height > 200;

          // Get parent element classes to help identify main content
          const parentClasses = video.parentElement ? video.parentElement.className : '';
          const isMainContent = parentClasses.includes('main') ||
                               parentClasses.includes('content') ||
                               parentClasses.includes('player') ||
                               parentClasses.includes('video');

          // Check if this is likely the main video
          const isLikelyMainVideo = isVisible && (isMainContent || width > 400);

          if (video.src && video.src.length > 0) {
            results.push({
              url: video.src,
              width: width,
              height: height,
              isVisible: isVisible,
              isMainContent: isMainContent,
              isLikelyMainVideo: isLikelyMainVideo,
              parentClasses: parentClasses
            });
          }
        });



        // Return URLs, prioritizing those that are likely main videos
        const sortedUrls = results
          .sort((a, b) => {
            // Prioritize main videos
            if (a.isLikelyMainVideo && !b.isLikelyMainVideo) return -1;
            if (!a.isLikelyMainVideo && b.isLikelyMainVideo) return 1;
  
            // Then prioritize by size
            return (b.width * b.height) - (a.width * a.height);
          })
          .map(item => item.url);
  
        return sortedUrls;
      });

      if (srcUrls.length > 0) {

        videoUrls = videoUrls.concat(srcUrls);
      }

      // Extract video URLs from source elements
      const sourceUrls = await page.evaluate(() => {
        const sourceElements = Array.from(document.querySelectorAll('source'));
        return sourceElements.map(source => source.src).filter(src => src && src.length > 0);
      });

      if (sourceUrls.length > 0) {

        videoUrls = videoUrls.concat(sourceUrls);
      }

      // Try to extract from page content (look for JSON data)
      const jsonUrls = await page.evaluate(() => {
        const results = [];
        // Look for JSON data in the page that might contain video URLs
        const scripts = Array.from(document.querySelectorAll('script'));

        // Also look for JSON in window.__INITIAL_STATE__ which Douyin often uses
        try {
          if (window.__INITIAL_STATE__) {
            const stateStr = JSON.stringify(window.__INITIAL_STATE__);
            if (stateStr.includes('playAddr') || stateStr.includes('play_addr') || stateStr.includes('url_list')) {


              // Try to extract video URLs from the state
              const extractUrlsFromObj = (obj) => {
                if (!obj) return;

                // Check if this object has video URLs
                if (obj.playAddr && obj.playAddr.url_list) {
                  results.push(...obj.playAddr.url_list);
                } else if (obj.play_addr && obj.play_addr.url_list) {
                  results.push(...obj.play_addr.url_list);
                } else if (obj.url_list) {
                  results.push(...obj.url_list);
                }

                // Recursively check all properties
                for (const key in obj) {
                  if (typeof obj[key] === 'object' && obj[key] !== null) {
                    extractUrlsFromObj(obj[key]);
                  }
                }
              };

              extractUrlsFromObj(window.__INITIAL_STATE__);
            }
          }
        } catch (e) {

        }

        // Look for specific Douyin data patterns
        try {
          if (window.aweme_list || window.awemeList) {
            const awemeList = window.aweme_list || window.awemeList;


            for (const aweme of awemeList) {
              if (aweme.video && aweme.video.play_addr && aweme.video.play_addr.url_list) {
                results.push(...aweme.video.play_addr.url_list);
              }
            }
          }
        } catch (e) {

        }

        // Look through script tags
        for (const script of scripts) {
          const content = script.textContent || '';

          // Look for JSON data that might contain video URLs
          if (content.includes('playAddr') || content.includes('play_addr') ||
              content.includes('video') || content.includes('url_list')) {
            try {
              // Try to find JSON objects in the script content
              const matches = content.match(/\{.*"playAddr".*\}/g) ||
                             content.match(/\{.*"play_addr".*\}/g) ||
                             content.match(/\{.*"video".*\}/g) ||
                             content.match(/\{.*"url_list".*\}/g);

              if (matches) {
                for (const match of matches) {
                  try {
                    const data = JSON.parse(match);

                    // Extract video URLs from the data
                    if (data.playAddr && data.playAddr.url_list) {
                      results.push(...data.playAddr.url_list);
                    } else if (data.play_addr && data.play_addr.url_list) {
                      results.push(...data.play_addr.url_list);
                    } else if (data.video && data.video.play_addr && data.video.play_addr.url_list) {
                      results.push(...data.video.play_addr.url_list);
                    } else if (data.video && data.video.playAddr && data.video.playAddr.url_list) {
                      results.push(...data.video.playAddr.url_list);
                    } else if (data.url_list) {
                      results.push(...data.url_list);
                    }
                  } catch (e) {
                    // Ignore JSON parse errors
                  }
                }
              }
            } catch (e) {
              // Ignore errors
            }
          }
        }

        // Also look for video URLs in the page HTML
        const html = document.documentElement.outerHTML;
        const urlMatches = html.match(/"(https?:\/\/[^"]*\.mp4[^"]*)"/g) || [];

        for (const match of urlMatches) {
          try {
            // Extract the URL from the quotes
            const url = match.substring(1, match.length - 1);
            if (url.includes('.mp4') &&
                !url.includes('douyin-pc-web/uuu_') &&
                !url.includes('login-video') &&
                !url.includes('background-video')) {
              results.push(url);
            }
          } catch (e) {
            // Ignore errors
          }
        }

        return results;
      });

      if (jsonUrls.length > 0) {

        videoUrls = videoUrls.concat(jsonUrls);
      }
    }


    // Close browser
    await browser.close();

    // Clean up temporary user data directory
    try {
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.warn('Failed to clean up temporary user data directory:', cleanupError.message);
    }

    // Filter and prioritize video URLs
    if (videoUrls.length > 0) {

      // Remove duplicates
      videoUrls = [...new Set(videoUrls)];

      // Prioritize URLs:
      // 1. Main video content from zjcdn.com (not effect videos)
      // 2. No watermark versions first
      // 3. Higher quality versions
      videoUrls.sort((a, b) => {
        // Prioritize main video URLs from zjcdn.com over effect videos
        const aIsMainVideo = a.includes('zjcdn.com');
        const bIsMainVideo = b.includes('zjcdn.com');

        if (aIsMainVideo && !bIsMainVideo) return -1;
        if (!aIsMainVideo && bIsMainVideo) return 1;

        // Prioritize no watermark versions
        const aNoWatermark = a.includes('play') && !a.includes('playwm');
        const bNoWatermark = b.includes('play') && !b.includes('playwm');

        if (aNoWatermark && !bNoWatermark) return -1;
        if (!aNoWatermark && bNoWatermark) return 1;

        // Prioritize higher quality versions
        const aHd = a.includes('HD') || a.includes('hd');
        const bHd = b.includes('HD') || b.includes('hd');

        if (aHd && !bHd) return -1;
        if (!aHd && bHd) return 1;

        return 0;
      });

      // Return the best URL
      return videoUrls[0];
    }

    throw new Error('No video URLs found');
  } catch (error) {
    console.error(`Error extracting video URL: ${error.message}`);

    // Make sure to close the browser
    if (browser) {
      await browser.close();
    }

    // Clean up temporary user data directory
    try {
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.warn('Failed to clean up temporary user data directory:', cleanupError.message);
    }

    throw error;
  }
}

/**
 * Download a Douyin video using Puppeteer
 * @param {string} url - Douyin video URL
 * @param {string} outputPath - Path where the video should be saved
 * @returns {Promise<boolean>} - True if download was successful
 */
async function downloadDouyinVideo(url, outputPath) {
  try {
    // Extract video URL
    const videoUrl = await extractVideoUrl(url);


    // Download the video
    await downloadFile(videoUrl, outputPath);

    return true;
  } catch (error) {
    console.error(`Error downloading Douyin video: ${error.message}`);
    throw error;
  }
}

module.exports = {
  downloadDouyinVideo,
  extractVideoUrl
};
