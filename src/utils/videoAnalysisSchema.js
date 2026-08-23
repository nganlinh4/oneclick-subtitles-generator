/**
 * Schema for video analysis response from Gemini
 */

/**
 * Creates a schema for video analysis
 * @returns {Object} Schema for video analysis
 */
export const createVideoAnalysisSchema = () => {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      recommendedPreset: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: "ID of the recommended preset (e.g., 'general', 'focus-lyrics', etc.)"
          },
          reason: {
            type: "string",
            description: "Reason why this preset is recommended for this video"
          }
        },
        required: ["id", "reason"]
      },
      transcriptionRules: {
        type: "object",
        additionalProperties: false,
        properties: {
          atmosphere: {
            type: "string",
            description: "Description of the atmosphere, setting, or context of the video (if applicable)"
          },
          terminology: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: {
                  type: "string",
                  description: "Specialized term or proper noun"
                },
                definition: {
                  type: "string",
                  description: "Definition or explanation of the term"
                }
              },
              additionalProperties: false,
              required: ["term", "definition"]
            },
            description: "List of specialized terminology and proper nouns that appear in the video"
          },
          speakerIdentification: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speakerId: {
                  type: "string",
                  description: "Identifier for the speaker (e.g., 'Speaker 1', 'John', 'Female Presenter')"
                },
                description: {
                  type: "string",
                  description: "Description of the speaker's voice, role, or other identifying characteristics"
                }
              },
              additionalProperties: false,
              required: ["speakerId", "description"]
            },
            description: "List of speakers identified in the video"
          },
          formattingConventions: {
            type: "array",
            items: {
              type: "string"
            },
            description: "List of formatting and style conventions to follow when transcribing"
          },
          spellingAndGrammar: {
            type: "array",
            items: {
              type: "string"
            },
            description: "List of spelling, grammar, and punctuation rules specific to this content"
          },
          relationships: {
            type: "array",
            items: {
              type: "string"
            },
            description: "List of relationships and social hierarchy information (if applicable)"
          },
          additionalNotes: {
            type: "array",
            items: {
              type: "string"
            },
            description: "Any additional notes or rules for consistent transcription"
          }
        }
      }
    },
    required: ["recommendedPreset", "transcriptionRules"]
  };
};
