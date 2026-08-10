/**
 * Response processing service for document processing
 * Handles processing and cleaning API responses
 */

/**
 * Process structured JSON response from Gemini API
 * @param {Object} structuredJson - The structured JSON response
 * @param {string|null} language - The expected language of the response
 * @returns {string} - Extracted text content
 */
export const processStructuredJsonResponse = (structuredJson, language = null) => {


    // Convert structured JSON to plain text
    if (typeof structuredJson === 'string') {
        return structuredJson;
    } else if (typeof structuredJson === 'object') {
        // Special handling for title+content format
        if (structuredJson.title && structuredJson.content) {


            // Check if the content appears to be in the expected language
            if (language) {

                // In a future enhancement, we could add language detection here
            }

            // Format as a proper document with title and content
            return `${structuredJson.title}\n\n${structuredJson.content}`;
        }
        // If it's an object with a text or content property, use that
        else if (structuredJson.content) {

            return structuredJson.content;
        } else if (structuredJson.text) {

            return structuredJson.text;
        } else if (structuredJson.document) {

            return structuredJson.document;
        } else if (structuredJson.summary) {

            let summaryText = structuredJson.summary;

            // Optionally add key points if available
            if (structuredJson.keyPoints && Array.isArray(structuredJson.keyPoints) && structuredJson.keyPoints.length > 0) {
                summaryText += '\n\nKey Points:\n';
                structuredJson.keyPoints.forEach((point, index) => {
                    summaryText += `\n${index + 1}. ${point}`;
                });
            }

            return summaryText;
        } else {
            // Otherwise, stringify it and extract plain text

            // Extract any text fields from the JSON
            const textFields = [];
            const extractText = (obj, key = null) => {
                if (!obj) return;
                if (typeof obj === 'string') {
                    // Skip short strings that are likely field names
                    if (obj.length > 10 || key === 'title' || key === 'content' || key === 'text') {
                        textFields.push(obj);
                    }
                } else if (Array.isArray(obj)) {
                    obj.forEach(item => extractText(item));
                } else if (typeof obj === 'object') {
                    Object.entries(obj).forEach(([k, value]) => extractText(value, k));
                }
            };
            extractText(structuredJson);

            if (textFields.length > 0) {

                return textFields.join('\n\n');
            } else {
                // If no text fields found, return the stringified JSON as a last resort

                return JSON.stringify(structuredJson, null, 2);
            }
        }
    }

    // Fallback if nothing else works
    return JSON.stringify(structuredJson, null, 2);
};

/**
 * Process text response that might contain JSON or markdown
 * @param {string} completedText - The text response from the API
 * @returns {string} - Cleaned and processed text
 */
export const processTextResponse = (completedText) => {
    if (!completedText) {
        throw new Error('No completed text returned from Gemini');
    }

    // Check if the response is a JSON array
    if (completedText.trim().startsWith('[') && completedText.trim().endsWith(']')) {
        try {
            // Try to parse as JSON
            const jsonArray = JSON.parse(completedText);
            if (Array.isArray(jsonArray)) {

                // Join the array items into a single text
                return jsonArray.join('\n\n');
            }
        } catch (e) {
            // Continue with the original text when it is not a JSON array.
        }
    }

    // Check if the response contains structured output and extract plain text if needed
    if (completedText.includes('```json') ||
        (completedText.includes('```') && completedText.includes('```') && completedText.trim().startsWith('```')) ||
        (completedText.includes('{"') && completedText.includes('"}') && completedText.trim().startsWith('{')) ||
        (completedText.includes('# ') && completedText.includes('## ') && completedText.trim().startsWith('#'))) {



        // Try to parse as JSON first if it looks like JSON
        if ((completedText.includes('{"') && completedText.includes('"}')) ||
            (completedText.includes('```json') && completedText.includes('```'))) {
            try {
                // Extract JSON from code blocks if present
                let jsonText = completedText;
                const jsonMatch = completedText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonText = jsonMatch[1].trim();
                }

                // Try to parse the JSON
                const jsonData = JSON.parse(jsonText);


                // Extract content from the JSON
                if (jsonData.title && jsonData.content) {

                    return `${jsonData.title}\n\n${jsonData.content}`;
                } else if (jsonData.content) {

                    return jsonData.content;
                } else if (jsonData.text) {

                    return jsonData.text;
                } else if (jsonData.document) {

                    return jsonData.document;
                } else {
                    // Extract text fields from the JSON object
                    const textFields = [];
                    const extractText = (obj, key = null) => {
                        if (!obj) return;
                        if (typeof obj === 'string') {
                            if (obj.length > 10 || key === 'title' || key === 'content' || key === 'text') {
                                textFields.push(obj);
                            }
                        } else if (Array.isArray(obj)) {
                            obj.forEach(item => extractText(item));
                        } else if (typeof obj === 'object') {
                            Object.entries(obj).forEach(([k, value]) => extractText(value, k));
                        }
                    };
                    extractText(jsonData);

                    if (textFields.length > 0) {

                        return textFields.join('\n\n');
                    }
                }
            } catch (error) {
                // Continue with selective markdown cleanup when JSON parsing fails.
            }
        }

        // If JSON parsing failed or wasn't applicable, selectively clean the text
        let cleanedText = completedText;

        // Remove markdown code blocks but preserve their content
        cleanedText = cleanedText.replace(/```(?:json|javascript|html|css|[a-z]*)\s*([\s\S]*?)```/g, '$1');

        // Remove markdown headers but keep the text
        cleanedText = cleanedText.replace(/#+\s+(.*?)\n/g, '$1\n');

        // Only remove JSON-like structures if they appear to be examples, not the main content
        if (cleanedText.includes('Example:') || cleanedText.includes('```json')) {
            cleanedText = cleanedText.replace(/\{[\s\S]*?\}/g, '');
        }

        // Remove markdown formatting characters but preserve the text
        cleanedText = cleanedText.replace(/[*#`[\]()>]/g, '');
        cleanedText = cleanedText.replace(/\|/g, '');

        // Normalize whitespace
        cleanedText = cleanedText.replace(/\n\s*\n/g, '\n\n');

        // If after all this cleaning we have very little text left, return the original
        if (cleanedText.trim().length < completedText.trim().length * 0.3) {

            return completedText;
        }

        return cleanedText.trim();
    }

    return completedText;
};
