/**
 * Service for grouping subtitles into fuller sentences for better narration
 * Uses Gemini API to intelligently combine subtitle lines
 */

import i18n from '../../i18n/i18n';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

// import { addResponseSchema } from '../../utils/schemaUtils'; // No longer needed if schema is removed

// createSubtitleGroupingSchema can be removed or commented out if not used.

/**
 * Group subtitles into fuller sentences for better narration
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} language - Language code of the subtitles
 * @param {string} model - Gemini model to use
 * @param {string} intensity - Grouping intensity level (minimal, moderate, aggressive)
 * @returns {Promise<Object>} - Object with grouped subtitles and mapping
 */
export const groupSubtitlesForNarration = async (subtitles, language = 'en', model = 'gemini-2.5-flash-lite', intensity = 'moderate') => {
  if (!subtitles || subtitles.length === 0) {
    return {
      success: false,
      error: 'No subtitles provided',
      groupedSubtitles: [],
      groupMapping: {}
    };
  }

  try {
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) {
      throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
    }

    const subtitleText = subtitles.map((sub, index) =>
      `ID: ${sub.subtitle_id || sub.id || (index + 1)}, Text: "${sub.text}"`
    ).join('\n');

    const maxOutputTokens = 8192; // Adjusted from 65536, which is very high.

    // Define grouping intensity guidelines
    let intensityGuidelines = '';

    switch (intensity) {
      case 'minimal':
        intensityGuidelines = `
Grouping Intensity: MINIMAL
- Be extremely conservative in grouping subtitles.
- Only combine subtitles that are clearly part of the same incomplete sentence.
- Prioritize keeping subtitles separate unless they absolutely need to be combined.
- Aim for very small groups of 1-2 subtitles at most.
- When in doubt, always keep subtitles separate.`;
        break;
      case 'light':
        intensityGuidelines = `
Grouping Intensity: LIGHT
- Be conservative in grouping subtitles.
- Combine subtitles only when they clearly form part of the same sentence.
- Prefer smaller groups over larger ones.
- Aim for small groups of 2-3 subtitles at most.
- Maintain frequent breaks between groups.`;
        break;
      case 'balanced':
        intensityGuidelines = `
Grouping Intensity: BALANCED
- Find a middle ground between light and moderate grouping.
- Combine subtitles that are likely part of the same sentence or closely related thoughts.
- Create groups that balance readability with natural flow.
- Aim for groups of 2-4 subtitles, favoring the lower end when in doubt.
- Pay close attention to natural speech patterns and pauses.`;
        break;
      case 'moderate':
      default:
        intensityGuidelines = `
Grouping Intensity: MODERATE
- Balance between keeping subtitles separate and combining them.
- Combine subtitles that form part of the same thought or sentence.
- Create natural groupings that sound good when read aloud.
- Aim for groups of 3-4 subtitles on average.
- Respect natural pauses and topic changes.`;
        break;
      case 'enhanced':
        intensityGuidelines = `
Grouping Intensity: ENHANCED
- Be somewhat liberal in grouping subtitles.
- Actively look for opportunities to combine related subtitles.
- Create fuller, more complete sentences where possible.
- Aim for groups of 4-5 subtitles on average.
- Maintain flow between related thoughts.`;
        break;
      case 'aggressive':
        intensityGuidelines = `
Grouping Intensity: AGGRESSIVE
- Be very liberal in grouping subtitles.
- Combine as many subtitles as possible into coherent units.
- Look for opportunities to create longer, more complete thoughts.
- Aim for larger groups of 5-7 subtitles where possible.
- Only create breaks when there's a clear topic change or natural pause.`;
        break;
    }

    const groupingPrompt = `
You are an expert in natural language processing. Your task is to group the following subtitles into fuller, more coherent sentences for narration purposes.

Each subtitle line may only contain a few words, which is suitable for displaying as subtitles but not ideal for generating narration. Please combine these subtitles into logical groups that form complete thoughts or sentences.

${intensityGuidelines}

General Guidelines:
1. Each original subtitle should appear in exactly one group.
2. Maintain the original order of subtitles.
3. Group IDs should be strings (e.g., "1", "2", ..., "N").

Subtitles:
${subtitleText}

IMPORTANT: You must respond with a JSON object in the following exact format:
{
  "groups": {
    "1": [1, 2, 3],
    "2": [4, 5],
    "3": [6]
    // ... and so on, for all groups needed.
  }
}

Where:
- The outer object has a single "groups" property.
- Inside "groups", each key is a new group ID (a string, starting from "1" and incrementing sequentially).
- Each value is an array of original subtitle IDs (integers) that should be combined. These IDs must match the IDs provided in the input subtitles.

DO NOT include any explanations, comments, or any other text in your response. Return ONLY the JSON object.
`;

    let requestData = {
      contents: [
        {
          role: "user",
          parts: [
            { text: groupingPrompt }
          ]
        }
      ],
      generationConfig: {
        topK: 32,
        topP: 0.95,
        maxOutputTokens: maxOutputTokens,
        // REMOVED: responseMimeType: "application/json",
        // REMOVED: responseSchema: createSubtitleGroupingSchema()
      },
    };

    // REMOVED: requestData = addResponseSchema(requestData, createSubtitleGroupingSchema());

    console.log('Final requestData being sent to Gemini API (no schema):', JSON.stringify(requestData, null, 2));
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log('Calling Gemini API for subtitle grouping (no schema)...');

    const responseData = await (async () => {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', },
          body: JSON.stringify(requestData)
        });

        if (!response.ok) {
          const errorBodyText = await response.text();
          let errorData;
          try { errorData = JSON.parse(errorBodyText); }
          catch (e) { errorData = { error: { message: `Non-JSON error response (status ${response.status}): ${errorBodyText}` } }; }
          console.error('Gemini API error response (raw):', errorBodyText);
          throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
        }
        const data = await response.json();
        console.log('Received response from Gemini API for subtitle grouping');
        return data;
      } catch (error) {
        console.error('Error during Gemini API call:', error);
        throw error;
      }
    })();

    let groupMapping = {};
    try {
      console.log('Parsing response for subtitle grouping');
      // With no responseSchema, we will always rely on parsing text
      if (responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content &&
          responseData.candidates[0].content.parts && responseData.candidates[0].content.parts[0] &&
          responseData.candidates[0].content.parts[0].text) {

        const text = responseData.candidates[0].content.parts[0].text;
        console.log('Using text response. Text content:', text);
        const jsonMatch = text.match(/\{[\s\S]*\}/); // Basic regex to find a JSON object
        if (jsonMatch) {
            const jsonStr = jsonMatch[0];
            try {
                const parsedJson = JSON.parse(jsonStr);
                if (parsedJson.groups) {
                    groupMapping = parsedJson.groups;
                    console.log('Extracted "groups" property from text JSON:', Object.keys(groupMapping).length);
                } else if (Object.keys(parsedJson).length > 0 && Object.keys(parsedJson).every(key => /^\d+$/.test(key) && Array.isArray(parsedJson[key]))) {
                    // If the parsed JSON is directly the groups object like {"1": [...], "2": [...]}
                    // This case might be less likely if the prompt strictly asks for {"groups": ...}
                    groupMapping = parsedJson;
                    console.log('Extracted groups directly from text JSON:', Object.keys(groupMapping).length);
                } else {
                    console.warn('Parsed JSON from text does not have "groups" property or match direct group structure. Parsed:', parsedJson);
                }
            } catch (e) {
                console.error('Error parsing JSON from text response:', e, 'JSON string that failed to parse:', jsonStr);
            }
        } else {
            console.warn('No JSON object-like structure found in text response. Text was:', text);
        }
      } else {
        console.warn('Response structure did not contain expected text part for parsing.', responseData);
      }

      if (!groupMapping || Object.keys(groupMapping).length === 0) {
        console.warn('Could not parse subtitle grouping result from API text or result is empty, using fallback grouping.');
        groupMapping = {}; // Initialize for fallback
        let currentGroupId = 1;
        let currentGroupBuffer = [];
        const FALLBACK_MAX_GROUP_SIZE = 3;
        subtitles.forEach((subtitle, index) => {
          const id = subtitle.subtitle_id || subtitle.id || (index + 1);
          currentGroupBuffer.push(id);
          if (currentGroupBuffer.length >= FALLBACK_MAX_GROUP_SIZE || index === subtitles.length - 1) {
            if (currentGroupBuffer.length > 0) {
              groupMapping[currentGroupId.toString()] = [...currentGroupBuffer];
              currentGroupId++;
              currentGroupBuffer = [];
            }
          }
        });
        console.log('Created fallback grouping with', Object.keys(groupMapping).length, 'groups:', groupMapping);
      }
    } catch (error) {
      console.error('Error processing API response for subtitle grouping:', error);
    }

    const groupedSubtitles = createGroupedSubtitles(subtitles, groupMapping);
    const success = Object.keys(groupMapping).length > 0 && groupedSubtitles.length > 0;

    if (!success && subtitles.length > 0) {
        console.warn("Grouping failed or resulted in no groups. Original subtitles count:", subtitles.length);
    }

    return {
      success: success,
      groupedSubtitles: success ? groupedSubtitles : subtitles,
      groupMapping: success ? groupMapping : {},
      error: !success ? (groupMapping && Object.keys(groupMapping).length === 0 ? 'Failed to generate/parse group mapping from API.' : 'Grouping produced no valid subtitle groups.') : null
    };

  } catch (error) {
    console.error('Critical error in groupSubtitlesForNarration:', error.message);
    return {
      success: false,
      error: error.message,
      groupedSubtitles: subtitles,
      groupMapping: {}
    };
  }
};

// createGroupedSubtitles function remains the same
const createGroupedSubtitles = (originalSubtitles, groupMapping) => {
  if (!groupMapping || Object.keys(groupMapping).length === 0) {
    console.warn('createGroupedSubtitles called with empty/null groupMapping. Returning empty array.');
    return [];
  }
  console.log('Creating grouped subtitles from mapping with', Object.keys(groupMapping).length, 'groups');

  const subtitleMap = originalSubtitles.reduce((map, sub, index) => {
    const id = sub.subtitle_id || sub.id || (index + 1);
    map[id] = {
        ...sub,
        start: parseFloat(sub.start),
        end: parseFloat(sub.end),
        original_id_for_lookup: id
    };
    return map;
  }, {});

  const groupedSubtitlesResult = Object.entries(groupMapping)
    .map(([groupIdStr, subtitleIdsInGroup]) => {
      const groupId = parseInt(groupIdStr, 10);
      if (isNaN(groupId)) {
          console.warn(`Invalid group ID string: ${groupIdStr}, skipping.`);
          return null;
      }
      if (!Array.isArray(subtitleIdsInGroup) || subtitleIdsInGroup.length === 0) {
        console.warn(`Group ${groupIdStr} has invalid/empty subtitle IDs, skipping.`);
        return null;
      }
      const normalizedIds = subtitleIdsInGroup.map(id => {
        const numId = parseInt(id, 10);
        return isNaN(numId) ? null : numId;
      }).filter(id => id !== null && id !== undefined);

      const groupSubtitles = normalizedIds
        .map(id => subtitleMap[id])
        .filter(Boolean);

      if (groupSubtitles.length === 0) {
        console.warn(`Group ${groupIdStr} (mapped IDs: ${normalizedIds.join(',')}) resulted in no valid subtitles after lookup, skipping.`);
        return null;
      }
      groupSubtitles.sort((a, b) => {
        const aIndex = originalSubtitles.findIndex(sub => (sub.subtitle_id || sub.id || originalSubtitles.indexOf(sub) + 1) === a.original_id_for_lookup);
        const bIndex = originalSubtitles.findIndex(sub => (sub.subtitle_id || sub.id || originalSubtitles.indexOf(sub) + 1) === b.original_id_for_lookup);
        return aIndex - bIndex;
    });
      const startTime = Math.min(...groupSubtitles.map(sub => sub.start));
      const endTime = Math.max(...groupSubtitles.map(sub => sub.end));
      if (isNaN(startTime) || isNaN(endTime)) {
          console.warn(`Group ${groupIdStr} has NaN start/end times. Subtitles:`, groupSubtitles.map(s => ({id: s.original_id_for_lookup, start: s.start, end: s.end})));
          return null;
      }
      const combinedText = groupSubtitles
        .map(sub => (sub.text || "").trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        subtitle_id: groupId, id: groupId, start: startTime, end: endTime, text: combinedText,
        original_ids: groupSubtitles.map(sub => sub.original_id_for_lookup)
      };
    })
    .filter(Boolean)
    .sort((a,b) => a.id - b.id);
  console.log('Created', groupedSubtitlesResult.length, 'grouped subtitles');
  return groupedSubtitlesResult;
};