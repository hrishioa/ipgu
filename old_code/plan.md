So here's a working pipeline for taking a video and generating translated bilingual subtitles. What we want to do is turn this into a proper end to end sytem with good logging, cli ux, and retries and other things based on failures and issues, with configurable languages.

Here's how it works:

1. We take a video file and chop it into pieces. Let the default be 20 minute chunks with 5 minutes of overlap, but we can make it adjustable. Let's also make it adjustable whether the chunks are mp3s or 360p mp4 videos.
2. We also take as input any subtitle file for the video, ad we use it to keep track of timings. We split it into chunks as well, after parsing.
3. Once that's done, we take each piece and then pass it to an LLM (gemini since it's the only one supporting multimodal) to generate transcriptions of the original video. There's some formatting but not much to get the timestamps as well.
4. Then we adjust those timestamps with the known offset in the parts to match, so the next step isn't confusing.
5. Then we take the transcript and the srt chunk, and create prompts to pass to an llm to generate translated subtitles. The transcript is for full context (since its done in the native langauge of the video itself) and the srt is for timings. Here we can use any model we want.
6. We then take those and parse out the xml to get the translations and the positioning. Here's where it gets a little complicated.
   a. We parse out and check for parsing issues, and also for timings issues or missing subtitles by number. If there are, we rerun the prompt and see if there's a fix in those - either using that response as the primary if it has fewer issues, or just using one of them as backup to get the msising subtitle only.
   b. We then combine those - when there's multiple subtitles, we use the later one (since it will be part of the earlier response of another chunk).
   c. We generate (with coloring) bilingual subtitles and save them as a proper srt, after reordering, checking for overlapping timestamps, etc.
7. We want to take as input a video file and a subtitle file, a directory to save intermediates to, a gemini model to use for the audio/video transcription, a model name to use for the final translation, the languages to translate to, and optionally a chunk size. We return a final srt and an intermediate and a report with all the errors or issues. We also want to count input and output tokens to each model, any maybe provide stats on tokens per minute of video we've used across the entire pipeline.
8. We want each module to also be executable as a cli for testing.

Expanded plan:

## Subtitle Generation Pipeline: System Design Outline

This document outlines the proposed architecture for a robust, configurable system to generate bilingual subtitles from video files.

**1. Goals:**

- Create a reliable end-to-end pipeline from video input to final bilingual SRT output.
- Make the process configurable via CLI arguments (languages, models, chunking, paths).
- Implement robust error handling, logging, and retries for key steps.
- Provide a detailed report summarizing the process and any issues encountered.
- Structure the code into logical modules for better maintainability.

**2. Core Modules & File Structure:**

A modular approach will make the system easier to manage and extend.

```
subtitle-pipeline/
├── src/
│   ├── main.ts             # Entry point, CLI parsing, orchestrator
│   ├── config.ts           # Configuration loading and validation
│   ├── types.ts            # Shared TypeScript interfaces and types
│   ├── reporter.ts         # Generates the final summary report
│   ├── utils/              # Common utility functions (logging, time, fs)
│   │   ├── logger.ts
│   │   ├── time_utils.ts
│   │   └── file_utils.ts
│   ├── splitter/           # Module for splitting inputs
│   │   ├── index.ts
│   │   ├── video_splitter.ts # Uses ffmpeg for video/audio
│   │   └── srt_splitter.ts   # Parses and splits reference SRT
│   ├── transcriber/        # Module for transcription
│   │   ├── index.ts
│   │   └── gemini_transcriber.ts # Handles Gemini multimodal transcription
│   ├── timestamp_adjuster/ # Module for adjusting transcript timestamps
│   │   └── index.ts
│   ├── prompt_generator/   # Module for creating translation prompts
│   │   └── index.ts
│   ├── translator/         # Module for generating translations
│   │   ├── index.ts
│   │   ├── llm_translator.ts # Base class/interface for translators
│   │   ├── gemini_translator.ts
│   │   └── claude_translator.ts
│   ├── parser/             # Module for parsing LLM responses
│   │   ├── index.ts
│   │   └── response_parser.ts # Parses XML-like responses (improved subtitle-parser.ts)
│   ├── validator/          # Module for validating parsed responses
│   │   ├── index.ts
│   │   └── response_validator.ts # Checks for missing IDs, timing issues, etc.
│   ├── merger/             # Module for merging results from chunks
│   │   ├── index.ts
│   │   └── subtitle_merger.ts # Handles merging overlapping subtitle data
│   └── formatter/          # Module for final SRT generation
│       ├── index.ts
│       └── srt_formatter.ts  # Creates final bilingual SRT (improved generate-subtitles.ts)
├── package.json
├── tsconfig.json
└── README.md
```

**`3. Key Data Structures & Types (src/types.ts):`**

Defining clear interfaces is crucial for communication between modules.

```
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
  chunkFormat: 'mp3' | 'mp4';
  maxConcurrent: number;
  retries: number;
  force: boolean;
  apiKeys: {
    gemini?: string;
    anthropic?: string;
  };
  // Add other relevant options like logging level
}

// Information about each processed chunk
export interface ChunkInfo {
  partNumber: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  // File paths within intermediateDir
  mediaChunkPath?: string; // Path to mp3 or mp4 chunk
  srtChunkPath?: string;   // Path to reference SRT chunk
  rawTranscriptPath?: string;
  adjustedTranscriptPath?: string;
  promptPath?: string;
  responsePath?: string; // Path to primary LLM response
  backupResponsePath?: string; // Path if retries generated alternatives
  parsedDataPath?: string; // Path to parsed JSON from response
  status: 'pending' | 'splitting' | 'transcribing' | 'adjusting' | 'prompting' | 'translating' | 'parsing' | 'validating' | 'completed' | 'failed';
  error?: string; // Store error message if failed
}

// Basic timestamped line from a transcript
export interface TimestampedText {
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  language?: string; // e.g., 'ml' for Malayalam
}

// Parsed entry from reference SRT
export interface SrtEntry {
  id: number;
  timingString: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
}

// Parsed entry from LLM translation response
export interface ParsedTranslationEntry {
  originalId: string; // Corresponds to SrtEntry ID
  translations: Record<string, string>; // { 'en': 'Hello', 'ko': '안녕하세요' }
  originalTiming?: string; // Optional timing from response
  startTimeSeconds?: number; // Parsed start time (if available and valid)
  endTimeSeconds?: number; // Parsed end time (if available and valid)
  sourceChunk: number; // Which part number this came from
  isFromBackup?: boolean; // Flag if this came from a retry response
}

// Issue found during processing
export interface ProcessingIssue {
  type: 'SplitError' | 'TranscriptionError' | 'TimestampAdjustError' | 'PromptGenError' | 'TranslationError' | 'ParseError' | 'ValidationError' | 'MergeError' | 'FormatError';
  severity: 'error' | 'warning' | 'info';
  message: string;
  chunkPart?: number;
  subtitleId?: string | number;
  context?: string; // Snippet or relevant data
}

// Entry for the final, merged SRT file before formatting
export interface FinalSubtitleEntry {
  id: number; // Sequential ID for final output
  startTimeSeconds: number;
  endTimeSeconds: number;
  translations: Record<string, string>; // { 'en': 'Hello', 'ko': '안녕하세요' }
  isFallback?: boolean; // Did we use original SRT text?
}

// Structure for the final report
export interface PipelineReport {
  startTime: string;
  endTime: string;
  totalDurationSeconds: number;
  configUsed: Config;
  overallStatus: 'Success' | 'SuccessWithIssues' | 'Failed';
  summary: {
    chunksTotal: number;
    chunksCompleted: number;
    chunksFailed: number;
    // Add counts for specific steps if needed
  };
  issues: ProcessingIssue[];
  outputFilePath?: string;
  reportFilePath: string;
}
```

**`4. CLI Interface (src/main.ts):`**

Use a library like `commander` or `yargs` for a clean CLI.

```
bun run src/main.ts --video <path> [--srt <path>] [--output-dir <path>] [--intermediate-dir <path>] --languages <langs> [--transcription-model <model>] [--translation-model <model>] [--chunk-duration <sec>] [--chunk-overlap <sec>] [--chunk-format <mp3|mp4>] [--max-concurrent <num>] [--retries <num>] [--force] [--api-key-gemini <key>] [--api-key-anthropic <key>]
```

- Defaults should be sensible (as listed in the plan).
- API keys should ideally be read from environment variables (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) as a primary method, with CLI flags as overrides.

**5. Workflow & Error Handling Details (Enhanced):**

This section details the step-by-step process, data flow, potential issues, and retry strategies. The orchestrator (`main.ts`) manages this flow, calling the respective modules.

- **Initialization:**

  - **Data Flow:** Parses CLI args, loads environment variables (`apiKeys`), validates paths, creates `Config` object.
  - **Action:** Creates output/intermediate directories. Sets up logging (e.g., using `utils/logger.ts` to log to console and a file in `intermediateDir`).
  - **Potential Issues:** Invalid paths, missing required args, missing API keys.
  - **Error Handling:** Exit gracefully with informative messages if config is invalid.

- **Splitting:**

  - **Data Flow:** Takes `Config` (video path, SRT path, chunk settings, intermediate dir). Calculates time ranges. Returns an array of initial `ChunkInfo` objects with `partNumber`, `startTimeSeconds`, `endTimeSeconds`, and potentially `mediaChunkPath`, `srtChunkPath`.
  - **`Action (video_splitter):`**
    - Calls `ffprobe` to get video duration.
    - Spawns `ffmpeg` processes (up to `Config.maxConcurrent`) to extract audio/video chunks based on `ChunkInfo` time ranges and `Config.chunkFormat`. Saves to `mediaChunkPath`.
    - Updates `ChunkInfo.status` to 'splitting', then 'transcribing' (if successful) or 'failed'.
  - **`Action (srt_splitter):`**
    - If `Config.srtPath` exists, parses the SRT file.
    - For each `ChunkInfo`, filters `SrtEntry` items overlapping the time range.
    - Writes filtered entries to `srtChunkPath`.
  - **Potential Issues:** `ffmpeg`/`ffprobe` not found or errors during execution (invalid file, codec issues), errors parsing reference SRT (`split-srt.ts` experience), file system errors (permissions).
  - **Error Handling:** Catch errors from `ffmpeg`/`ffprobe`. Log detailed errors from stderr. Mark affected `ChunkInfo` as 'failed' with an error message. If reference SRT parsing fails, log a warning and proceed without it (translation quality might suffer).
  - **Retry Areas:** Unlikely needed for `ffmpeg` unless transient file system issues occur.

- **Transcription:**

  - **Data Flow:** Takes `ChunkInfo` (specifically `mediaChunkPath`) and `Config` (API key, model). Returns path to the raw transcript file (`rawTranscriptPath`) written to `intermediateDir`. Updates `ChunkInfo.status`.
  - **`Action (gemini_transcriber):`**
    - Iterates through `ChunkInfo` objects with status 'transcribing'.
    - Calls Gemini API (upload file, `generateContentStream`) using the prompt from `transcribe-audio.ts`. Handles API calls concurrently up to `Config.maxConcurrent`.
    - Saves the raw streamed response to `rawTranscriptPath`.
  - **Potential Issues:** API errors (rate limits, authentication, server errors, invalid file format for upload), network issues, Gemini failing to transcribe accurately or follow format.
  - **Error Handling:** Implement retry logic (`Config.retries`) with exponential backoff for API/network errors. Log specific API error messages. If fails after retries, mark `ChunkInfo` as 'failed'.
  - **Retry Areas:** Gemini API calls.

- **Timestamp Adjustment:**

  - **Data Flow:** Takes `ChunkInfo` (needs `rawTranscriptPath`, `startTimeSeconds`). Returns path to the adjusted transcript file (`adjustedTranscriptPath`). Updates `ChunkInfo.status`.
  - **`Action (timestamp_adjuster):`**
    - Reads `rawTranscriptPath`.
    - Parses relative timestamps (`mm:ss - mm:ss` format from `adjust-timestamps.ts`).
    - Adds `ChunkInfo.startTimeSeconds` to calculate absolute `startTimeSeconds` and `endTimeSeconds` for each `TimestampedText` entry.
    - Writes the adjusted data (perhaps as JSON list of `TimestampedText`) to `adjustedTranscriptPath`.
  - **Potential Issues:** Transcript format doesn't match expected `mm:ss - mm:ss`, parsing errors.
  - **Error Handling:** Log warnings for lines that cannot be parsed. If the entire file is unparseable, mark `ChunkInfo` as 'failed'.
  - **Retry Areas:** Not typically needed, failure usually indicates a problem in the transcription step.

- **Prompt Generation:**

  - **Data Flow:** Takes `ChunkInfo` (needs `adjustedTranscriptPath`, `srtChunkPath` if available) and `Config` (target languages). Returns path to the generated prompt file (`promptPath`). Updates `ChunkInfo.status`.
  - **`Action (prompt_generator):`**
    - Reads `adjustedTranscriptPath` and `srtChunkPath`.
    - Constructs the prompt using the template from `create-prompts.ts`, inserting the transcript content and SRT chunk content. Includes target languages in the instructions.
    - Writes the prompt to `promptPath`.
  - **Potential Issues:** File reading errors.
  - **Error Handling:** Mark `ChunkInfo` as 'failed' if input files cannot be read.

- **Translation:**

  - **Data Flow:** Takes `ChunkInfo` (needs `promptPath`) and `Config` (API key, model, target languages). Returns path to the raw LLM response file (`responsePath`). Updates `ChunkInfo.status`.
  - **`Action (translator modules):`**
    - Selects the appropriate translator (Gemini or Claude) based on `Config.translationModel`.
    - Reads `promptPath`. Sends prompt to the LLM API. Handles API calls concurrently up to `Config.maxConcurrent`.
    - Saves the raw response to `responsePath`.
  - **Potential Issues:** API errors (rate limits, auth, server errors), network issues, LLM refusing to answer or generating poorly formatted/empty responses.
  - **Error Handling:** Implement retry logic (`Config.retries`) with exponential backoff for API/network errors. Log specific API errors. If fails after retries, mark `ChunkInfo` as 'failed'.
  - **Retry Areas:** LLM API calls.

- **Parsing & Validation Loop:**

  - **Data Flow:** Takes `ChunkInfo` (needs `responsePath`, `backupResponsePath` if retry occurred, `srtChunkPath`). Returns path to parsed data (`parsedDataPath`) and a list of `ProcessingIssue`s for the chunk. Manages retry attempts per chunk.
  - **`Loop (Managed by main.ts, up to Config.retries per chunk):`**
    1. **`Parse (response_parser):`** Read `responsePath` (or `backupResponsePath` on retry). Parse the XML-like structure using logic from `subtitle-parser.ts`. Generate `ParsedTranslationEntry[]`. Log any `ParseError` issues found (malformed tags, etc.).
    2. **`Validate (response_validator):`** Compare `ParsedTranslationEntry[]` against the corresponding `SrtEntry[]` from `srtChunkPath`. Check for missing `originalId`s, inconsistent timing (if parsed). Log `ValidationError` issues. Logic adapted from `check-responses.ts`.
    3. **Decision:** Evaluate the logged issues for this chunk. If critical errors (e.g., >50% missing IDs, complete parse failure) exist AND retries remain for this chunk:
       - Log intent to retry.
       - Trigger re-translation (Step 6) for this chunk, saving to `backupResponsePath`. Decrement chunk's retry counter. Loop back to Step 1 (parsing the backup).
    4. **Exit Loop:** If no critical errors, or no retries left, proceed. Save the best available parsed data (primary or backup) as JSON to `parsedDataPath`. Update `ChunkInfo.status` to 'validating' or 'completed'.
  - **Potential Issues:** Malformed XML/tags in LLM response, missing required tags (`original_number`, translations), inconsistent data, large number of missing subtitles.
  - **Error Handling:** The loop itself is the error handling. Parsing/validation modules log specific issues. The orchestrator decides whether to retry based on issue severity/count. If validation fails after all retries, mark `ChunkInfo` as 'failed' but keep the last parsed data and issues for reporting.
  - **Retry Areas:** The entire Translation -> Parse -> Validate sequence can be retried for a specific chunk.

- **Merging:**

  - **Data Flow:** Takes all `ChunkInfo` objects with successfully parsed data (`parsedDataPath`). Reads the corresponding JSON files (`ParsedTranslationEntry[]`). Also needs the original `SrtEntry[]` map for fallbacks. Returns `FinalSubtitleEntry[]`.
  - **`Action (subtitle_merger):`**
    - Loads all `ParsedTranslationEntry` data from successful chunks.
    - Sorts entries globally by `originalId` and then `sourceChunk`.
    - Iterates through sorted entries. For each `originalId`, if it exists in multiple chunks due to overlap, prioritize the entry from the later `sourceChunk` (logic from `generate-subtitles.ts` regarding overlaps).
    - If an `originalId` from the reference SRT is completely missing in the parsed data, create a fallback `FinalSubtitleEntry` using the original `SrtEntry.text` and mark `isFallback: true`.
    - Handles merging primary/backup response data if retries occurred (e.g., prefer backup if it contains a previously missing ID).
  - **Potential Issues:** Logic errors in handling overlaps or fallbacks.
  - **Error Handling:** Log warnings if fallbacks are used extensively. Errors here likely indicate bugs in the merging logic.

- **Formatting:**

  - **Data Flow:** Takes `FinalSubtitleEntry[]` and `Config` (target languages, colors). Returns the final SRT content string.

  - **`Action (srt_formatter):`**

    - Assigns sequential IDs starting from 1.

    - Performs a final overlap check on the merged `FinalSubtitleEntry` list (based on `startTimeSeconds`, `endTimeSeconds`). Adjusts `endTimeSeconds` slightly to prevent overlap, ensuring minimum duration (logic from `generate-subtitles.ts`).

    - Formats each entry into SRT block format:

      ```
      ID
      HH:MM:SS,ms --> HH:MM:SS,ms
      <font color="#EN_COLOR">English Text</font>
      <font color="#LANG1_COLOR">Lang1 Text</font>
      ...
      ```

    - Uses `utils/time_utils.ts` for accurate `secondsToTimestamp` conversion.

  - **Potential Issues:** Errors in timestamp formatting, final overlap check fails to resolve issues completely.

  - **Error Handling:** Log warnings if significant adjustments are made during the final overlap check. Errors likely indicate issues in upstream data or formatting logic.

- **Reporting:**

  - **Data Flow:** Takes the final list of all `ProcessingIssue`s collected throughout the pipeline, the `Config`, timing info, and final status.
  - **`Action (reporter):`**
    - Aggregates issues.
    - Compiles summary statistics.
    - Formats the report (Markdown or text) as shown in Section 6.
    - Writes the report to the `outputDir`.
  - **Potential Issues:** File writing errors.
  - **Error Handling:** Log errors during report writing.

- **Cleanup (Optional):**

  - The orchestrator (`main.ts`) could optionally remove the `intermediateDir` upon successful completion if requested via a CLI flag.

This enhanced workflow provides more explicit steps, clarifies data movement, highlights potential failure points based on your existing scripts, and integrates retry mechanisms more formally.

**`6. Report Structure (src/reporter.ts):`**

Generate a Markdown (`.md`) or text (`.txt`) file.

```
# Subtitle Generation Report

**Run Started:** 2025-04-21T12:30:00Z
**Run Ended:** 2025-04-21T12:35:15Z
**Total Duration:** 315 seconds

**Overall Status:** SuccessWithIssues

## Configuration Used

* Video Input: `/path/to/movie.mp4`
* Reference SRT: `/path/to/reference.srt`
* Output Directory: `./output`
* Intermediate Directory: `./intermediate`
* Target Languages: `ko`, `ja`
* Transcription Model: `gemini-1.5-flash-latest`
* Translation Model: `claude-3-sonnet-20240229`
* Chunk Duration: 1200s, Overlap: 300s, Format: mp3
* Max Concurrent: 5, Retries: 2
* Force Reprocess: false

## Processing Summary

* Total Chunks: 9
* Chunks Completed: 9
* Chunks Failed: 0
* Transcription Issues: 1 (Chunk 5, retried successfully)
* Translation Issues: 0
* Parsing/Validation Warnings: 3
* Final Subtitles Generated: 1850

## Issues Log

**Errors (0):**

* None

**Warnings (3):**

* **Type:** ValidationError
    * **Severity:** warning
    * **Chunk:** 3
    * **Subtitle ID:** 452
    * **Message:** Missing Korean translation in LLM response. Used fallback.
    * **Context:** `<original_number>452</original_number>...<korean_translation></korean_translation>`

* **Type:** ParseError
    * **Severity:** warning
    * **Chunk:** 7
    * **Message:** Malformed closing tag for better_english_translation. Content extracted successfully.
    * **Context:** `<better_english_translation>Text...</better_english_translatio>`

* **Type:** ValidationError
    * **Severity:** warning
    * **Chunk:** 8
    * **Subtitle ID:** 1601
    * **Message:** Missing Japanese translation in LLM response. Used fallback.
    * **Context:** `<original_number>1601</original_number>...<japanese_translation></japanese_translation>`

## Output Files

* Final SRT: `./output/movie.bilingual.ko_ja.srt`
* Report File: `./output/movie.report.md`
```

**7. Migration from Existing Scripts:**

This section maps the functionality of your provided scripts to the proposed modular structure.

- **`split-video.ts`**:
  - **Function:** Splits the input video into audio (MP3) chunks using `ffmpeg`, based on calculated time ranges with overlap. Includes logic for getting video duration via `ffprobe` and handling concurrency.
  - **Target Module:** `src/splitter/video_splitter.ts`
  - **Migration Notes:** Extract the `ffmpeg` and `ffprobe` execution logic. The concurrency handling might be managed by the main orchestrator (`src/main.ts`) calling this module, or kept within the module if it only applies to `ffmpeg` processes. Time formatting utilities go to `src/utils/time_utils.ts`.
- **`split-srt.ts`**:
  - **Function:** Parses an SRT file and splits it into chunks based on time ranges, preserving original numbering.
  - **Target Module:** `src/splitter/srt_splitter.ts`
  - **Migration Notes:** Migrate SRT parsing and time-based filtering logic. Time conversion utilities go to `src/utils/time_utils.ts`.
- **`transcribe-audio.ts`**:
  - **Function:** Uploads audio chunks to Gemini, sends a transcription prompt, streams the response, and saves the transcript. Handles API key and concurrency.
  - **Target Module:** `src/transcriber/gemini_transcriber.ts`
  - **Migration Notes:** The core Gemini API interaction (`upload`, `generateContentStream`) and the specific prompt template belong here. File reading/writing and the overall loop/concurrency control will likely be handled by the orchestrator (`src/main.ts`) calling this module.
- **`adjust-timestamps.ts`**:
  - **Function:** Reads raw transcripts, parses relative `mm:ss - mm:ss` timestamps, adds a part-specific offset (in seconds), and formats them into absolute `hh:mm:ss` timestamps.
  - **Target Module:** `src/timestamp_adjuster/index.ts`
  - **Migration Notes:** This logic fits well into a dedicated module. Time conversion utilities go to `src/utils/time_utils.ts`. The offset calculation will depend on the `ChunkInfo` passed to it.
- **`create-prompts.ts`**:
  - **Function:** Reads adjusted transcripts and corresponding SRT chunks, combines them into a predefined prompt template for the translation LLM.
  - **Target Module:** `src/prompt_generator/index.ts`
  - **Migration Notes:** The core logic of reading inputs and formatting the prompt template belongs here.
- **`process-prompts.ts`**:
  - **Function:** Sends generated prompts to either Gemini or Claude, handles API keys, streams/collects responses, and saves them. Manages concurrency.
  - **Target Modules:**
    - `src/translator/gemini_translator.ts` (for Gemini API call)
    - `src/translator/claude_translator.ts` (for Claude API call)
    - `src/translator/llm_translator.ts` (defines the common interface)
  - **Migration Notes:** The specific API interaction logic for each LLM goes into its respective file. The main loop, concurrency management, and model selection logic will likely reside in the orchestrator (`src/main.ts`) which then calls the appropriate translator module.
- **`subtitle-parser.ts`**:
  - **Function:** A standalone script designed to parse the XML-like LLM response format, handling malformed tags and extracting subtitle data (ID, translations, optional timing). Includes reporting features.
  - **Target Module:** `src/parser/response_parser.ts`
  - **Migration Notes:** This script is already well-suited for a module. Adapt its main function to be callable by the orchestrator, returning `ParsedTranslationEntry[]` and `ProcessingIssue[]`. The reporting features might be integrated into the main `src/reporter.ts`.
- **`check-responses.ts`**:
  - **Function:** Parses response files (potentially from multiple sources like primary/backup), checks for missing subtitle numbers within a part and across parts, and checks for overlaps/gaps between consecutive parts.
  - **Target Module:** `src/validator/response_validator.ts`
  - **Migration Notes:** The core validation logic (missing number checks, sequence checks) fits here. The overlap/gap check between _parts_ is more relevant to the `src/merger/subtitle_merger.ts` logic, which handles combining the chunks. Parsing logic should rely on `src/parser/response_parser.ts`.
- **`generate-subtitles.ts`**:
  - **Function:** The most complex script, responsible for merging primary/backup translations, handling fallbacks, applying colors, fixing timestamp overlaps, renumbering, and generating the final SRT file. Includes validation steps.
  - **Target Modules:** This script's functionality is distributed:
    - Merging logic (handling primary/backup, overlaps between chunks): `src/merger/subtitle_merger.ts`
    - Response parsing: `src/parser/response_parser.ts` (as used by `check-responses.ts`)
    - Validation (overlaps within final list, sequential numbers): `src/validator/response_validator.ts` and potentially within `src/formatter/srt_formatter.ts` for final checks.
    - Final formatting (coloring, renumbering, final overlap fix, timestamp formatting): `src/formatter/srt_formatter.ts`
  - **Migration Notes:** This requires careful refactoring. Break down the steps (parsing, merging/fallback, validation, final formatting) and assign them to the appropriate modules based on the plan. Time utilities go to `src/utils/time_utils.ts`.

This plan provides a solid foundation. The implementation will involve refining the logic within each module, especially error handling, retry strategies, and the merging process, while leveraging the functionality from your existing scripts.
