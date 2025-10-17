/**
 * Test script to verify Douyin download cancellation functionality
 */

const fetch = require('node-fetch');

const SERVER_URL = 'http://localhost:3031';

// Test video ID and URL (using a sample Douyin URL)
const TEST_VIDEO_ID = 'test-cancel-123';
const TEST_URL = 'https://v.douyin.com/ieFsaUmh/';

async function testCancelFunctionality() {
  console.log('🧪 Testing Douyin download cancellation functionality...\n');

  try {
    // Step 1: Start a download
    console.log('1. Starting download...');
    const downloadResponse = await fetch(`${SERVER_URL}/api/download-douyin-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoId: TEST_VIDEO_ID,
        url: TEST_URL,
        quality: '360p',
        useCookies: false
      }),
    });

    if (!downloadResponse.ok) {
      console.log('❌ Failed to start download:', await downloadResponse.text());
      return;
    }

    console.log('✅ Download started successfully');

    // Step 2: Wait a moment to let the download begin
    console.log('2. Waiting 3 seconds for download to begin...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Check progress
    console.log('3. Checking download progress...');
    const progressResponse = await fetch(`${SERVER_URL}/api/douyin-download-progress/${TEST_VIDEO_ID}`);
    if (progressResponse.ok) {
      const progressData = await progressResponse.json();
      console.log(`   Progress: ${progressData.progress}% - Status: ${progressData.status}`);
    }

    // Step 4: Cancel the download
    console.log('4. Cancelling download...');
    const cancelResponse = await fetch(`${SERVER_URL}/api/cancel-douyin-download/${TEST_VIDEO_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!cancelResponse.ok) {
      console.log('❌ Failed to cancel download:', await cancelResponse.text());
      return;
    }

    const cancelData = await cancelResponse.json();
    console.log('✅ Cancel response:', cancelData);

    // Step 5: Wait and check if download actually stopped
    console.log('5. Waiting 2 seconds and checking if download stopped...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const finalProgressResponse = await fetch(`${SERVER_URL}/api/douyin-download-progress/${TEST_VIDEO_ID}`);
    if (finalProgressResponse.ok) {
      const finalProgressData = await finalProgressResponse.json();
      console.log(`   Final status: ${finalProgressData.status} - Progress: ${finalProgressData.progress}%`);
      
      if (finalProgressData.status === 'cancelled') {
        console.log('✅ SUCCESS: Download was properly cancelled!');
      } else if (finalProgressData.status === 'downloading') {
        console.log('❌ FAILURE: Download is still running after cancellation!');
      } else {
        console.log(`ℹ️  Download status: ${finalProgressData.status}`);
      }
    }

    // Step 6: Check if partial file was cleaned up
    console.log('6. Checking if partial file was cleaned up...');
    const fileCheckResponse = await fetch(`${SERVER_URL}/api/douyin-video-exists/${TEST_VIDEO_ID}`);
    if (fileCheckResponse.ok) {
      const fileData = await fileCheckResponse.json();
      if (!fileData.exists) {
        console.log('✅ SUCCESS: Partial file was properly cleaned up!');
      } else {
        console.log('❌ WARNING: Partial file still exists after cancellation');
      }
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
  }

  console.log('\n🏁 Test completed!');
}

// Run the test
if (require.main === module) {
  testCancelFunctionality();
}

module.exports = { testCancelFunctionality };
