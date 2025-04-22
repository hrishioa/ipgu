# Subtitle Translation Pipeline

An end-to-end pipeline for generating bilingual subtitles from videos with robust error handling, logging, validation, retries, and configurable options.

## Features

- Split videos/audio into manageable chunks (MP3/MP4) with configurable overlap.
- Process reference subtitle files (SRT) to maintain timing accuracy, applying optional input offset.
- Generate native language transcriptions using Gemini multimodal model, guided by optional source language hints.
- Validate transcriptions based on expected duration and format, with retries.
- Adjust transcription timestamps to be absolute within the video.
- Generate translation prompts using a configurable template, target language, and context from transcripts/SRT.
- Translate subtitles to a target language (plus improved English) using configurable LLMs (Gemini, Claude).
- Handle LLM API errors with retries and exponential backoff.
- Parse LLM translation responses (XML-like format) with robust error handling.
- Validate parsed translations against reference SRT for count, ID coverage, and timing consistency (timing check optional).
- Retry LLM translation step if validation fails (configurable retries).
- Merge results from chunks, handling overlaps.
- Apply duration clamps (min/max length) and fix timestamp overlaps in the final sequence.
- Generate final bilingual SRT file with configurable colors, fallback markers, and optional output offset.
- Detailed logging to console and optional log file.
- Progress bars for long-running steps.
- Modular design: Each major step (split, transcribe, translate, parse, finalize) can be run as a standalone CLI tool.

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.1+ recommended)
- `ffmpeg` and `ffprobe` installed and accessible in your system PATH.
- **API Keys:**
  - Gemini API key (required for transcription, optional for translation). Set via `GEMINI_API_KEY` environment variable or `--gemini-api-key` flag.
  - Anthropic API key (required if using Claude for translation). Set via `ANTHROPIC_API_KEY` environment variable or `--anthropic-api-key` flag.

## Installation

```bash
# Clone the repository (replace with your actual repo URL if applicable)
# git clone https://github.com/yourusername/subtitle-translation-pipeline.git
# cd subtitle-translation-pipeline

# Install dependencies
bun install
```

## Usage

### Full Pipeline (`bun start`)

Runs the entire process from video input to final SRT output.

```bash
bun start \
  --video /path/to/video.mp4 \
  --srt /path/to/reference.srt \
  --intermediate-dir ./intermediate_files \
  --output-dir ./final_output \
  --target-language Korean \
  --transcription-model gemini-2.5-pro-preview-03-25 \
  --translation-model gemini-2.5-pro-preview-03-25 \
  --source-languages malayalam \
  --log-level info \
  --log-file ./final_output/pipeline.log \
  --chunk-duration 1200 \
  --retries 3 \
  --transcription-retries 3 \
  --max-concurrent 4 \
  --chunk-overlap 120
```

### Running Individual Modules Standalone

Each module can be executed independently for testing or partial processing.

**1. Splitter (`bun run splitter`)**

```bash
bun run splitter \
  --video /path/to/video.mp4 \
  --srt /path/to/reference.srt \
  --output ./intermediate_files \
  --duration 600 \
  --overlap 60 \
  --format mp3 \
  --input-offset -0.5 \
  --part 5 # Optional: Process only part 5
```

- Outputs: `media/`, `srt/` subdirectories, and `chunk_info.json` in the specified output directory.

**2. Transcriber (`bun run transcriber`)**

```bash
# Requires chunk_info.json from splitter
bun run transcriber \
  --input ./intermediate_files/chunk_info.json \
  --intermediate-dir ./intermediate_files \
  --model gemini-1.5-pro-latest \
  --retries 2 # Transcription validation retries
```

- Reads `chunk_info.json`.
- Uses `media/` chunks.
- Outputs raw transcripts to `raw_llm_transcripts/`.
- Outputs adjusted transcripts to `transcripts/`.
- Updates `chunk_info.json` with paths and status.

**3. Translator (`bun run translator`)**

```bash
# Requires chunk_info.json updated by transcriber
bun run translator \
  --input ./intermediate_files/chunk_info.json \
  --intermediate-dir ./intermediate_files \
  --model claude-3-opus-20240229 \
  --language Japanese \
  --retries 2 # API error / Validation retries
  --no-timing-check # Optional: Disable timing validation
```

- Reads `chunk_info.json` (using `transcripts/` and potentially `srt/` inputs).
- Outputs raw LLM responses to `llm_responses/`.
- Outputs request/response logs to `llm_logs/`.
- Outputs parsed data to `parsed_data/`.
- Updates `chunk_info.json` with paths and status.

**4. Parser (`bun run parser`)**

_(Note: Parsing is now integrated into the Translator module, but the standalone parser can still be useful for inspecting individual raw response files.)_

```bash
bun run parser \
  --input ./intermediate_files/llm_responses/part01_response_attempt1.txt \
  --languages Korean \
  --output-json ./intermediate_files/parsed_data/part01_manual.json \
  --output-report ./intermediate_files/parsed_data/part01_manual.report.txt
```

**5. Finalizer (`bun run finalizer`)**

```bash
# Requires parsed_data/ from translator and the original full SRT
bun run finalizer \
  --intermediate-dir ./intermediate_files \
  --original-srt /path/to/reference.srt \
  --language Korean \
  --output-dir ./final_output \
  --output-filename final_movie.ko.srt \
  --use-response-timings # Optional: Use LLM timings
  --input-offset -0.5 \
  --output-offset 0.2 \
  --colors FFFFFF,00FFFF
```

- Reads all `_parsed.json` files from `parsed_data/`.
- Reads the original full SRT.
- Outputs the final formatted `.srt` file to the specified output directory.

## Configuration Options (`bun start`)

| Option                                 | Alias | Description                                                                     | Default                         |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------- | ------------------------------- |
| `--video <path>`                       | `-v`  | Path to input video file                                                        | **Required**                    |
| `--srt <path>`                         | `-s`  | Path to reference SRT file                                                      | (Optional)                      |
| `--output <dir>`                       | `-o`  | Output directory for final files (SRT, report)                                  | `./output`                      |
| `--intermediate <dir>`                 | `-i`  | Directory for intermediate files (chunks, logs, etc.)                           | `./intermediate`                |
| `--source-languages <langs>`           |       | Comma-separated source languages in video (e.g., `ml,ta`, hint for transcriber) | (Optional)                      |
| `--target-language <lang>`             | `-l`  | The target language (besides English) for translation                           | `Korean`                        |
| `--transcription-model <name>`         | `-tm` | Gemini model for transcription step                                             | `gemini-1.5-flash-latest`       |
| `--translation-model <name>`           | `-tl` | LLM model for translation step (Gemini or Claude)                               | `claude-3-5-sonnet-20240620`    |
| `--translation-prompt-template <path>` |       | Path to custom translation prompt template file                                 | `./translation_prompt.template` |
| `--chunk-duration <seconds>`           | `-d`  | Chunk duration in seconds                                                       | `1200` (20 min)                 |
| `--chunk-overlap <seconds>`            |       | Overlap duration between chunks in seconds                                      | `300` (5 min)                   |
| `--chunk-format <fmt>`                 |       | Media chunk format (`mp3` or `mp4`)                                             | `mp3`                           |
| `--max-concurrent <num>`               | `-c`  | Max concurrent processes (ffmpeg, API calls)                                    | `5`                             |
| `--retries <num>`                      | `-r`  | Max retries for LLM API errors AND translation validation failures              | `2`                             |
| `--transcription-retries <num>`        |       | Max retries specifically for transcription validation failures                  | `1`                             |
| `--input-offset <seconds>`             |       | Apply offset (seconds, can be negative) to input SRT timings                    | `0`                             |
| `--output-offset <seconds>`            |       | Apply offset (seconds, can be negative) to final output SRT timings             | `0`                             |
| `--force`                              | `-f`  | Force reprocessing steps even if output files exist                             | `false`                         |
| `--no-timing-check`                    |       | Disable subtitle timing validation checks during translation step               | `false`                         |
| `--mark-fallbacks`                     |       | Add `[Original]` marker to subtitles using original text as fallback            | `true`                          |
| `--colors <eng,tgt>`                   |       | Set subtitle hex colors (e.g., `FFFFFF,FFFF00`)                                 | (Defaults: White, Pink)         |
| `--gemini-api-key <key>`               |       | Gemini API key (overrides `GEMINI_API_KEY` env var)                             | (Optional)                      |
| `--anthropic-api-key <key>`            |       | Anthropic API key (overrides `ANTHROPIC_API_KEY` env var)                       | (Optional)                      |
| `--log-file <path>`                    |       | Path to log file                                                                | (Optional)                      |
| `--log-level <level>`                  |       | Log level (`debug`, `info`, `warn`, `error`)                                    | `info`                          |
| `--part <number>`                      | `-P`  | Process only a specific part number through the whole pipeline                  | (Optional)                      |

## Project Structure

```
subtitle-pipeline/
├── src/
│   ├── main.ts                   # Entry point, orchestrator
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── utils/                    # Utility functions
│   │   ├── logger.ts
│   │   ├── time_utils.ts
│   │   ├── file_utils.ts
│   │   ├── srt_utils.ts          # SRT parsing/calculation
│   │   └── transcript_utils.ts   # Transcript timestamp parsing/adjustment
│   ├── splitter/                 # Video/SRT splitting
│   │   ├── index.ts
│   │   ├── video_splitter.ts
│   │   └── srt_splitter.ts
│   ├── transcriber/              # Transcription + Timestamp Adjustment
│   │   ├── index.ts
│   │   └── gemini_transcriber.ts
│   ├── translator/               # Prompt Generation + LLM Call + Basic Parsing
│   │   ├── index.ts
│   │   ├── prompt_generator.ts
│   │   ├── gemini_translator.ts
│   │   └── claude_translator.ts
│   ├── parser/                   # Detailed LLM Response Parsing (XML-like)
│   │   ├── index.ts              # CLI wrapper
│   │   └── response_parser.ts    # Core parsing logic
│   ├── validator/                # Validation of Parsed Data
│   │   ├── index.ts              # CLI wrapper (optional)
│   │   └── translation_validator.ts # Core validation logic
│   └── finalizer/                # Merging, Fixing, Formatting Final SRT
│       ├── index.ts              # CLI wrapper + main logic
│       └── srt_formatter.ts      # Formatting/coloring logic
├── translation_prompt.template # Default prompt template file
├── package.json
├── tsconfig.json
└── README.md
```

## Development

For development with auto-reloading of the main pipeline:

```bash
bun dev
```

## License

MIT
