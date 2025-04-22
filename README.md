<h1 align="center">
  <br>
  <a href="https://github.com/hrishioa/ipgu"><img src="assets/logotransparent.png" alt="Ipgu" width="200"></a>
  <br>
  ipgu - Timestable AI translation Pipeline
  <br>
</h1>

We connect through stories, films, and videos. Media transcends borders, but language often creates barriers. Manually creating high-quality subtitles is a significant hurdle, especially for long videos or when translating between languages with vastly different structures and cultural nuances – capturing humor across honorific systems, for example, is incredibly tough.

LLMs are way to solve this, but there are a lot of problems:

Timing synchronization is fragile, context gets lost, and countless valuable pieces of media remain locked away, inaccessible outside their original language.

## The Entrance: Introducing `ipgu` (입구)

This project, **`ipgu`** (named after the Korean word for "Entrance" - **입구**), aims to build that bridge. It leverages the power of modern Large Language Models (LLMs) to automate the creation of accurate, timed, bilingual subtitles, opening an entrance for content to reach new audiences and fostering deeper cross-cultural understanding.

`ipgu` is an end-to-end command-line tool that takes your video file, intelligently processes it through state-of-the-art AI for transcription and translation, and generates high-quality, bilingual SRT subtitles ready for use.

![ipgu Demo](assets/movieshot.png))

## Why `ipgu`? (Features)

- **Bridging the Gap:** Automatically transcribes audio using the powerful Google **Gemini** API and translates the text into English and your target language using **Gemini** or **Anthropic Claude** models.
- **Taming Timestamps:** Overcomes the significant challenge of maintaining timing stability across long media. It intelligently splits content, handles overlaps meticulously during merging, applies precise adjustments, and gives you the option to use original SRT timings or LLM-generated ones.
- **Wrangling AI:** Built with resilience in mind. Employs robust parsing, validation against configurable rules, and multi-level retry mechanisms (for both API calls and content validation) to handle the complexities and imperfections of LLM outputs gracefully. Includes fallback strategies for failed steps.
- **Nuance through Customization:** Allows using custom prompt templates for the translation step, giving you finer control to guide the AI in capturing specific cultural context, tone, or terminology – crucial for challenging translation pairs.
- **Handles the Heavy Lifting:** Manages all intermediate files (media chunks, transcripts, logs), offers configurable concurrency to maximize throughput, and works with different chunking strategies (MP3/MP4 format, duration, overlap).
- **Cost Transparency:** Provides **estimated** costs _before_ you commit significant resources, breaking down expenses by model (transcription vs. translation) and offering a cost-per-minute calculation for the video.
- **Ease of Use with Presets:** Includes predefined settings combinations (`--preset`) for common scenarios like speed-focused processing or quality-focused translation.
- **Ready-to-Use Output:** Generates clean, formatted, bilingual `.srt` files with optional color coding for different languages and markers for fallback lines.

## Table of Contents

- [The Entrance: Introducing `ipgu` (입구)](#the-entrance-introducing-ipgu-입구)
- [Why `ipgu`? (Features)](#why-ipgu-features)
- [Table of Contents](#table-of-contents)
- [Requirements / Prerequisites](#requirements--prerequisites)
- [Installation](#installation)
- [Presets](#presets)
  - [Available Presets](#available-presets)
  - [Preset Usage](#preset-usage)
- [Quick Start](#quick-start)
- [Usage (Detailed Reference)](#usage-detailed-reference)
  - [Examples](#examples)
- [Configuration Deep Dive](#configuration-deep-dive)
  - [API Keys](#api-keys)
  - [Custom Prompt Template](#custom-prompt-template)
- [How It Works (The Pipeline Stages)](#how-it-works-the-pipeline-stages)
- [Cost Estimation Explained](#cost-estimation-explained)
- [Understanding the Output](#understanding-the-output)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)
- [The Vision: An Open Entrance](#the-vision-an-open-entrance)

## Requirements / Prerequisites

1.  **Bun:** This project uses the [Bun runtime](https://bun.sh/). Please follow their official installation instructions.
2.  **FFmpeg & ffprobe:** Required for video/audio processing (splitting, duration analysis). They must be installed and accessible in your system's PATH.
    - Installation guides: [FFmpeg Official Site](https://ffmpeg.org/download.html) (Check your OS package manager like `apt`, `brew`, `choco` as well).
3.  **API Keys:**
    - **Google Gemini API Key (Required):** Needed for transcription (and potentially translation). Obtain from [Google AI Studio](https://aistudio.google.com/app/apikey).
    - **Anthropic API Key (Optional):** Required _only if_ you plan to use Claude models for translation. Obtain from the [Anthropic Console](https://console.anthropic.com/).

## Installation

1. Clone the repository:

   ```bash
   git clone [https://github.com/your-username/ipgu.git](https://github.com/your-username/ipgu.git) # Replace with your repo URL
   cd ipgu
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Verify installation (optional):

   ```bash
   bun src/main.ts --version
   ```

## Presets

Presets offer convenient starting points by bundling common configurations. You can use a preset and then override specific settings with individual flags if needed.

### Available Presets

| Preset       | Description                                                                                                                                                                                                                                                    | Recommended Use Case                                                         |
| :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| `2.5`        | **Fast, high-throughput** <br>• Gemini 2.5 Pro for both transcription & translation<br>• 12 concurrent jobs<br>• 20-minute chunks with 2-minute overlap<br>• MP3 format<br>• Timing validation disabled<br>• 3 retries for both tasks                          | When speed matters or for processing multiple movies in a batch              |
| `2.5-claude` | **Higher quality translations** <br>• Gemini 2.5 Pro for transcription<br>• Claude 3.7 Sonnet for translation<br>• 3 concurrent jobs<br>• 10-minute chunks with 1-minute overlap<br>• MP3 format<br>• Timing validation disabled<br>• 3 retries for both tasks | When translation quality is critical, especially for complex/nuanced content |

_Note: Model names in presets are examples. Ensure they match available API models._

### Preset Usage

```bash
# Basic usage with 2.5 preset, specifying required inputs/outputs
# Make sure GEMINI_API_KEY is set or use --gemini-api-key
bun src/main.ts --preset 2.5 --video movie.mp4 -l Korean -o ./output

# Using 2.5-claude preset, overriding concurrency
# Make sure GEMINI_API_KEY and ANTHROPIC_API_KEY are set or use flags
bun src/main.ts --preset 2.5-claude --video movie.mp4 -l Japanese --max-concurrent 5
```

## Quick Start

Assuming you have `ffmpeg`/`ffprobe` installed, Bun setup, and your `GEMINI_API_KEY` environment variable set:

Bash

```
# Process a video, translating to Korean, using the default settings (fast Gemini models)
bun src/main.ts -v my_video.mp4 -l Korean -o ./output_subtitles

# If you have an existing English SRT file to use as reference timing:
bun src/main.ts -v my_video.mp4 -s my_video.srt -l Korean -o ./output_subtitles

# Using the higher-quality Claude preset (requires ANTHROPIC_API_KEY too)
bun src/main.ts --preset 2.5-claude -v my_video.mp4 -l Korean -o ./output_subtitles
```

_(Remember to replace `-l Korean` with your desired target language)_

## Usage (Detailed Reference)

The main entry point is `src/main.ts`.

Bash

```
bun src/main.ts [options]
```

**Core Options:**

- `-v, --video <path>`: **(Required)** Path to the input video file.
- `-s, --srt <path>`: Path to an optional reference SRT subtitle file (used for timing and potentially translation reference).
- `-o, --output <dir>`: Directory to save the final bilingual SRT file (Default: `./output`).
- `-i, --intermediate <dir>`: Directory to store intermediate files (chunks, transcripts, logs) (Default: `./intermediate`).
- `-l, --target-language <lang>`: The target language for translation (besides English) (Default: `Korean`).

**Model Selection:**

- `-tm, --transcription-model <model>`: Model for transcription (Default: `gemini-1.5-flash-latest`).
- `-tl, --translation-model <model>`: Model for translation (Default: `claude-3-5-sonnet-20240620`).
- `--translation-prompt-template <path>`: Path to a custom translation prompt template file. Uses built-in default if not set.

**Chunking Control:**

- `-d, --chunk-duration <seconds>`: Target duration for media chunks (Default: `1200` seconds / 20 minutes).
- `--chunk-overlap <seconds>`: Overlap between consecutive chunks (Default: `300` seconds / 5 minutes).
- `-f, --chunk-format <format>`: Format for intermediate media chunks (`mp3` or `mp4`) (Default: `mp3`).

**Performance & Retries:**

- `-c, --max-concurrent <number>`: Maximum number of concurrent processes (splitting, API calls) (Default: `5`).
- `-r, --retries <number>`: Number of retries for _general API calls_ (like translation) and _validation failures_ (Default: `2`).
- `--transcription-retries <number>`: Specific number of retries for _transcription validation_ failure (Default: `1`).

**API Keys:**

- `--gemini-api-key <key>`: Gemini API key. Overrides `GEMINI_API_KEY` environment variable.
- `--anthropic-api-key <key>`: Anthropic API key. Overrides `ANTHROPIC_API_KEY` environment variable.

**Timing & Offset:**

- `--input-offset <seconds>`: Apply a time offset (can be negative) to the input reference SRT timings _before_ processing.
- `--output-offset <seconds>`: Add a time offset (can be negative) to the _final_ generated subtitle timings.
- `--use-response-timings`: Use timings parsed directly from the LLM translation response instead of aligning with the (potentially offset) reference SRT. (Default: `false`).
- `--no-timing-check`: Disable timing validation checks during the translation step (comparing LLM output timings to reference SRT timings). (Default: `false`, meaning checks are enabled).

**Output Formatting:**

- `--colors <eng_hex,tgt_hex>`: Set hex color codes for English and target language subtitles (e.g., `FFFFFF,00FFFF`). Default uses White for English, Pink for Target.
- `--mark-fallbacks`: Add an `[Original]` marker to subtitle lines where the original English text from the reference SRT was used as a fallback (Default: `true`). Set to `false` to disable.

**Workflow Control:**

- `--force`: Force reprocessing of steps even if intermediate files already exist. Useful for retrying failed steps or changing parameters. (Default: `false`).
- `-P, --part <number>`: Process _only_ a specific chunk (part number). Useful for debugging a single section.
- `--log-file <path>`: Path to write detailed logs to a file.
- `--log-level <level>`: Console log level (`debug`, `info`, `warn`, `error`) (Default: `info`). File log level defaults to `debug` if `--log-file` is used.
- `--source-languages <langs>`: Comma-separated hint of source languages in the video (e.g., `ml,ta`) to potentially improve transcription.

### Examples

Bash

```
# Translate a video with reference SRT to Japanese using specific models
bun src/main.ts \
  -v video.mkv \
  -s video.srt \
  -l Japanese \
  --transcription-model gemini-1.5-pro-latest \
  --translation-model claude-3-opus-20240229 \
  -o ./output_jp \
  --gemini-api-key $GEMINI_KEY \
  --anthropic-api-key $ANTHROPIC_KEY

# Rerun only part 5, forcing reprocessing, using LLM timings
bun src/main.ts \
  -v video.mp4 \
  -s video.srt \
  -l Korean \
  -o ./output \
  -P 5 \
  --force \
  --use-response-timings

# Process with shorter chunks, more concurrency, and custom colors
bun src/main.ts \
  -v lecture.mp4 \
  -l Spanish \
  --chunk-duration 600 \
  --chunk-overlap 60 \
  --max-concurrent 10 \
  --colors E0E0E0,FFFF00 \
  -o ./output_es
```

## Configuration Deep Dive

### API Keys

API keys are essential for interacting with the LLM providers. `ipgu` looks for keys in this order:

1. **Command-line argument:** `--gemini-api-key YOUR_KEY` or `--anthropic-api-key YOUR_KEY`
2. **Environment variable:** `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`

You **must** provide a Gemini key. An Anthropic key is only needed if using a Claude model (e.g., `claude-3-5-sonnet-20240620`).

### Custom Prompt Template

You can override the default translation prompt using `--translation-prompt-template <path/to/your/template.txt>`. The template file can use these placeholders:

- `{ADJUSTED_TRANSCRIPT}`: Will be replaced with the timestamp-adjusted transcript content.
- `{REFERENCE_SRT}`: Will be replaced with the content of the reference SRT chunk (or a placeholder if unavailable).
- `{TARGET_LANGUAGE_NAME}`: Replaced with the language specified by `-l` (e.g., "Korean").
- `{TARGET_LANGUAGE_XML_EXAMPLE}`: Replaced with an example XML tag for the target language (e.g., `<korean_translation>...</korean_translation>`).

The default template is located at `src/translator/translation_prompt.template`.

## How It Works (The Pipeline Stages)

`ipgu` processes your media in several stages:

1. **Split (`src/splitter/`):** Calculates time chunks based on duration, overlap, and total video length. Uses `ffmpeg` to extract corresponding media segments (MP3 or MP4) and `ffprobe` to get video duration. If a reference SRT is provided, it's also split into corresponding timed chunks.
2. **Transcribe (`src/transcriber/`):** Each media chunk is uploaded to the Google Gemini API for transcription. The raw transcript (with relative timings) is validated against the chunk duration and optionally the reference SRT span. If validation fails, it retries based on `--transcription-retries`. Successful raw transcripts have their relative timestamps adjusted to absolute video time based on the chunk's start time.
3. **Translate (`src/translator/`):** For each chunk with a valid adjusted transcript, a detailed prompt is generated (using the adjusted transcript, reference SRT chunk, and target language). This prompt is sent to the chosen translation LLM (Gemini or Claude). API calls are retried on failure based on `--retries`.
4. **Parse & Validate (`src/parser/`, `src/validator/`):** The raw text response from the translation LLM is parsed to extract structured subtitle data (ID, timings, English text, target language text). This parsed data is then validated against rules (e.g., checking for missing IDs compared to reference SRT, high parsing error rate, timing consistency if enabled). If validation fails, the **entire translate step** (including the LLM call) may be retried based on `--retries`. Special handling exists for the last chunk on the final validation attempt to try and salvage the best possible output.
5. **Finalize (`src/finalizer/`):** All successfully processed and parsed chunk data is loaded. Overlapping entries between chunks are resolved (usually keeping the entry from the later chunk). Timings are adjusted to fix overlaps between adjacent final subtitles and clamped to reasonable minimum/maximum durations. Offsets (`--output-offset`) are applied. The final bilingual SRT file is formatted (with colors, fallback markers) and saved to the output directory.

## Cost Estimation Explained

`ipgu` provides an _estimated_ cost breakdown in the final summary report.

- **How it works:** It uses token counts (input and output) reported by the APIs (if available for the model used) and multiplies them by known costs per million tokens defined in `src/config/models.ts`.
- **Models:** Costs are currently defined for common Claude and Gemini models (see `src/config/models.ts` for the list). You may need to update this file if using newer or different models.
- **Breakdown:** The report shows total estimated cost, cost for transcription, cost for translation, and cost per minute of the original video.
- **Disclaimer:** **These are estimates.** Actual costs depend on the API provider's billing, potential variations in token counting, and whether token counts are reported accurately by the specific model version used. Cost warnings may appear if token counts couldn't be retrieved for a model.

## Understanding the Output

- **Final Subtitle:** A single `.srt` file named like `your_video_name.bilingual.<target_language>.srt` will be created in the directory specified by `-o` (or `./output`). This file contains bilingual subtitles, typically with English on the top line and the target language on the bottom line, potentially with color formatting.

- Intermediate Files:

  The directory specified by

  ```
  -i
  ```

  (or

  ```
  ./intermediate
  ```

  ) will contain temporary files useful for debugging:

  - `media/`: MP3 or MP4 chunks of the video.
  - `srt/`: SRT chunks corresponding to the media chunks (if reference SRT was provided).
  - `raw_llm_transcripts/`: Raw text output from the Gemini transcription step (including failed attempts if applicable).
  - `transcripts/`: Transcripts with absolute timestamps adjusted from the raw output.
  - `llm_logs/`: JSON logs of requests sent to translation LLMs.
  - `llm_responses/`: Raw text responses received from translation LLMs for each attempt.
  - `parsed_data/`: JSON files containing the structured data extracted from the LLM translation responses after successful validation.

## Troubleshooting

- **`ffmpeg`/`ffprobe` not found:** Ensure FFmpeg and ffprobe are installed correctly and their location is included in your system's PATH environment variable.

- **API Key Errors:** Double-check your API keys (`--gemini-api-key`, `--anthropic-api-key` or environment variables). Ensure the correct key is provided for the selected model (Gemini vs. Claude). Check API provider dashboards for quota issues.

- **Transcription Validation Failed:** The LLM transcript might be too short, have incorrect timing spans, or too few recognizable timestamp lines. Check the logs (`--log-level debug`) and the `intermediate/raw_llm_transcripts/partXX_raw_transcript_FAILED.txt` files. Try adjusting chunk duration/overlap or using a different transcription model.

- Translation Validation Failed:

  The LLM translation response might be malformed, missing too many expected subtitle IDs, or have inconsistent timings (if enabled). Check logs (

  ```
  --log-level debug
  ```

  ), the raw LLM response (

  ```
  intermediate/llm_responses/
  ```

  ), and the parsed data (

  ```
  intermediate/parsed_data/
  ```

  if generated). Consider:

  - Using a different translation model.
  - Customizing the translation prompt (`--translation-prompt-template`).
  - Increasing retries (`-r`).
  - Disabling timing checks (`--no-timing-check`) if timings are less critical or causing persistent issues.

- **High Estimated Cost:** Use cheaper models (like `gemini-1.5-flash-latest`), especially for transcription. Check the cost breakdown in the final report.

- **Cost Warnings:** If token counts aren't available for a model, cost estimation will be inaccurate. Rely on your API provider's dashboard for exact costs.

## Project Structure

```
ipgu/
├── src/
│   ├── main.ts               # Main CLI entry point
│   ├── types.ts              # Core TypeScript interfaces
│   ├── config/
│   │   └── models.ts         # LLM model costs
│   ├── finalizer/
│   │   ├── index.ts          # Merges chunks, formats final SRT
│   │   └── srt_formatter.ts  # Applies colors, formatting
│   ├── parser/
│   │   ├── index.ts          # Orchestrates parsing LLM responses
│   │   └── response_parser.ts# Logic to extract data from LLM text
│   ├── splitter/
│   │   ├── index.ts          # Orchestrates splitting
│   │   ├── video_splitter.ts # Splits video using ffmpeg
│   │   └── srt_splitter.ts   # Splits reference SRT file
│   ├── transcriber/
│   │   ├── index.ts          # Orchestrates transcription
│   │   └── gemini_transcriber.ts # Calls Gemini API for transcription
│   ├── translator/
│   │   ├── index.ts          # Orchestrates translation & validation retries
│   │   ├── prompt_generator.ts # Creates prompts for translation LLM
│   │   ├── claude_translator.ts# Calls Anthropic Claude API
│   │   └── gemini_translator.ts# Calls Google Gemini API
│   ├── validator/
│   │   └── translation_validator.ts # Validates parsed translation data
│   └── utils/
│       ├── file_utils.ts     # Filesystem operations
│       ├── logger.ts         # Logging utilities
│       ├── srt_utils.ts      # SRT parsing helpers
│       ├── time_utils.ts     # Timestamp conversions, chunk calculation
│       └── transcript_utils.ts # Transcript validation & adjustment
├── package.json
├── tsconfig.json
├── bun.lockb
└── README.md
```

## Development

1. **Setup:** Ensure Bun, ffmpeg, and ffprobe are installed. Clone the repo and run `bun install`.
2. **Running:** You can run the main pipeline using `bun src/main.ts [options...]`.
3. **Running Individual Components:** Most modules (`splitter`, `transcriber`, `translator`, `parser`, `finalizer`) can be run standalone for debugging. Check their `--help` flag, e.g., `bun src/splitter/index.ts --help`.
4. **Linting/Formatting:** (Add details if you set up ESLint/Prettier).

`ipgu` strives to lower the barrier for sharing stories across languages. By automating the complex process of subtitle creation, we hope to open countless new entrances for understanding and connection through the media we all love.
