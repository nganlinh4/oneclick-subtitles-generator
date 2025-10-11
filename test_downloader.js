const { downloadDouyinVideoWithRetry } = require('./server/services/douyin/downloader');

async function test() {
  try {
    const result = await downloadDouyinVideoWithRetry('test123', 'https://www.douyin.com/video/7556956398123879706', '360p', true);
    console.log('Download successful:', result);
  } catch (error) {
    console.error('Download failed:', error.message);
  }
}

test();