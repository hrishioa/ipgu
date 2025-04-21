// Common types shared across the subtitle pipeline

// Configuration options
export interface Config {
  videoPath: string;
  srtPath?: string; // Optional reference SRT
  outputDir: string;
  intermediateDir: string;
  targetLanguages: string[]; // e.g., ['ko', 'ja']
  transcriptionModel: string;
  translationModel: string;
  chunkDuration: number; // seconds
  chunkOverlap: number; // seconds
  chunkFormat: "mp3" | "mp4";
  maxConcurrent: number;
  retries: number;
  force: boolean;
  apiKeys: {
    gemini?: string;
    anthropic?: string;
  };
}

// Information about each processed chunk
export interface ChunkInfo {
  partNumber: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  // File paths within intermediateDir
  mediaChunkPath?: string; // Path to mp3 or mp4 chunk
  srtChunkPath?: string; // Path to reference SRT chunk
  rawTranscriptPath?: string;
  adjustedTranscriptPath?: string;
  promptPath?: string;
  responsePath?: string; // Path to primary LLM response
  backupResponsePath?: string; // Path if retries generated alternatives
  parsedDataPath?: string; // Path to parsed JSON from response
  status:
    | "pending"
    | "splitting"
    | "transcribing"
    | "adjusting"
    | "prompting"
    | "translating"
    | "parsing"
    | "validating"
    | "completed"
    | "failed";
  error?: string; // Store error message if failed
}

// Parsed entry from reference SRT
export interface SrtEntry {
  id: number;
  timingString: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
}

// Issue found during processing
export interface ProcessingIssue {
  type:
    | "SplitError"
    | "TranscriptionError"
    | "TimestampAdjustError"
    | "PromptGenError"
    | "TranslationError"
    | "ParseError"
    | "ValidationError"
    | "MergeError"
    | "FormatError";
  severity: "error" | "warning" | "info";
  message: string;
  chunkPart?: number;
  subtitleId?: string | number;
  context?: string; // Snippet or relevant data
}
