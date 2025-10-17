/**
 * Add floating buttons to standalone album art previews
 */
document.addEventListener('DOMContentLoaded', () => {
  // Find all standalone album-art-preview elements
  const albumArtPreviews = document.querySelectorAll('div.album-art-preview');
  
  albumArtPreviews.forEach(preview => {
    // Skip if it's already inside the BackgroundImageGenerator component
    if (preview.closest('.album-art-container')) {
      return;
    }
    
    // Get the image inside the preview
    const img = preview.querySelector('img');
    if (!img) return;
    
    // Create download button
    const downloadButton = document.createElement('button');
    downloadButton.className = 'floating-download-button';
    downloadButton.title = 'Download';
    downloadButton.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px; color: currentColor;">download</span>';
    
    // Add click event to download the image
    downloadButton.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = img.src;
      link.download = img.src.split('/').pop() || 'album-art.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
    
    // Add the button to the preview
    preview.appendChild(downloadButton);
  });
});
