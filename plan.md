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
7. We want to take as input a video file and a subtitle file, a directory to save intermediates to, a gemini model to use for the audio/video transcription, a model name to use for the final translation, the languages to translate to, and optionally a chunk size. We return a final srt and an intermediate and a report with all the errors or issues.

I've provided all the code that does this successfully - it's missing some features but mostly working. Can we make an outline of how to turn this into a proper system? What are the modules and files, what are the types and interfaces we need, etc?
