# Adding New Audio Samples

This document outlines the steps required to add new example audio files to the narration system.

## Steps to Add New Audio Samples

### 1. Prepare the Audio Files
- Place the new MP3 audio files in the `server/example-audio/` directory
- Ensure files are named descriptively (e.g., `viet_female_north_1.mp3`, `viet_female_north_2.mp3`)
### 2. Add Files to Git
```bash
git add server/example-audio/your_new_file.mp3
```

### 3. Update Backend Code - getExampleAudioList
In `server/controllers/narration/referenceAudioController.js`, add new entries to the `exampleAudioFiles` array in **alphabetical order by filename**:

```javascript
{
  filename: 'your_filename.mp3',
  displayName: 'your_filename.mp3',
  language: 'Language Name',
  descriptionKey: 'narration.exampleAudio.your_filename'
}
```

**Important**: Always maintain alphabetical order by filename when adding new entries to ensure consistent frontend display.

### 4. Update Backend Code - Reference Text Logic
In the same file, add reference text logic in the `uploadExampleAudio` function:

```javascript
} else if (filename === 'your_filename.mp3') {
  reference_text = 'Your reference text here';
}
```

### 5. Update i18n Translations
Add translation keys to all three language files:
- `src/i18n/locales/en/narration.json`
- `src/i18n/locales/ko/narration.json`
- `src/i18n/locales/vi/narration.json`

In the `exampleAudio` object, add:
```json
"your_filename": "Description in the respective language"
```

## Example: Adding Vietnamese Northern Female Voices

### Files Added:
- `viet_female_north_1.mp3` - Reference text: "Đây là đài tiếng nói Việt Nam, phát thanh từ thủ đô Hà Nội, nước Cộng hòa xã hội chủ nghĩa Việt Nam."
- `viet_female_north_2.mp3` - Reference text: "Người ta là hoa đất, học ăn, học nói, học gói, học mở."

### Backend Changes:
- Added to `getExampleAudioList` array with language "Vietnamese" in alphabetical order by filename
- Added exact filename matches in `uploadExampleAudio` function

### i18n Changes:
- English: "Vietnamese Northern female voice 1/2"
- Korean: "베트남 북부 여성 음성 1/2"
- Vietnamese: "Giọng nữ miền Bắc Việt Nam 1/2"

## Important Notes

- Use exact filename matching in reference text logic to avoid conflicts
- Ensure descriptionKey values match the translation file keys exactly
- Files are served from `server/example-audio/` directory with fallback to F5-TTS examples