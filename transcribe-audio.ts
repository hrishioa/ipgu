#!/usr/bin/env bun

import { GoogleGenAI } from "@google/genai";
import { readdir, writeFile } from "fs/promises";
import { join } from "path";

const AUDIO_DIR = "./videos/audio_chunks";
const OUTPUT_DIR = "./videos/transcripts";

async function transcribeAudio(
  audioPath: string,
  apiKey: string
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
  });

  console.log(`Uploading ${audioPath}...`);
  const file = await ai.files.upload({ file: audioPath });

  const config = {
    responseMimeType: "text/plain",
  };

  const model = "gemini-2.5-pro-preview-03-25";
  const contents = [
    {
      role: "user",
      parts: [
        {
          fileData: {
            fileUri: file.uri,
            mimeType: file.mimeType,
          },
        },
        {
          text: `Here's part of a movie I want to subtitle. Can you give me the transcript in malayalam to the best of your ability with timestamps? Don't worry about getting the timestamps correct - but transcribe all that you can. Don't think too much - just start - it's about 20 minutes.

Use this format:
relative (mm:ss - mm:ss) - (line)`,
        },
      ],
    },
  ];

  console.log(`Transcribing ${audioPath}...`);
  let fullTranscript = "";
  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });

  for await (const chunk of response) {
    fullTranscript += chunk.text;
  }

  return fullTranscript;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is not set");
    process.exit(1);
  }

  try {
    // Get all MP3 files from the audio directory
    const files = await readdir(AUDIO_DIR);
    const audioFiles = files.filter((file) => file.endsWith(".mp3"));

    if (audioFiles.length === 0) {
      console.log(`No MP3 files found in ${AUDIO_DIR}`);
      return;
    }

    console.log(`Found ${audioFiles.length} audio files to transcribe`);

    // Process files in parallel
    const tasks = audioFiles.map(async (file) => {
      const audioPath = join(AUDIO_DIR, file);
      const outputFileName = `${file.replace(".mp3", "")}_auto_transcribed.txt`;
      const outputPath = join(OUTPUT_DIR, outputFileName);

      try {
        const transcript = await transcribeAudio(audioPath, apiKey);
        await writeFile(outputPath, transcript);
        console.log(`Successfully transcribed ${file} to ${outputPath}`);
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    });

    await Promise.all(tasks);
    console.log("All transcription tasks completed!");
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
