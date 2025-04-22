#!/bin/bash

# Function to display usage
usage() {
  echo "Usage: $0 [options] <video-file>"
  echo ""
  echo "Options:"
  echo "  -o <directory>  Output directory for MP3 chunks (default: 'output')"
  echo "  -c <number>     Number of concurrent ffmpeg processes (default: 1)"
  echo "  -h              Show this help message"
  exit 1
}

# Default values
OUTPUT_DIR="output"
MAX_CONCURRENT=1

# Parse command line options
while getopts "o:c:h" opt; do
  case ${opt} in
    o)
      OUTPUT_DIR=$OPTARG
      ;;
    c)
      MAX_CONCURRENT=$OPTARG
      ;;
    h)
      usage
      ;;
    \?)
      usage
      ;;
  esac
done
shift $((OPTIND -1))

# Check if input file is provided
if [ $# -lt 1 ]; then
  echo "Error: Input file is required"
  usage
fi

INPUT_FILE=$1

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"
echo "Chunks will be saved to: $OUTPUT_DIR"

# Format seconds to HH:MM:SS format
format_time() {
  local total_seconds=$1
  local hours=$((total_seconds / 3600))
  local minutes=$(((total_seconds % 3600) / 60))
  local seconds=$((total_seconds % 60))
  printf "%02d:%02d:%02d" $hours $minutes $seconds
}

# Get video duration using ffprobe
get_duration() {
  local duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE")
  echo ${duration%.*} # Remove decimal part
}

# Generate time ranges
generate_time_ranges() {
  local duration=$1
  local chunk_duration=$((20 * 60)) # 20 minutes in seconds
  local overlap=$((5 * 60)) # 5 minutes in seconds
  local chunk_index=1
  local start=0

  # Get base filename without extension
  local base_name=$(basename "$INPUT_FILE")
  base_name="${base_name%.*}"

  # Create temporary file to store time ranges
  local ranges_file=$(mktemp)

  while [ $start -lt $duration ]; do
    local end=$((start + chunk_duration))
    if [ $end -gt $duration ]; then
      end=$duration
    fi

    local output_file="$OUTPUT_DIR/${base_name}_part${chunk_index}.mp3"
    echo "$start $end $output_file" >> "$ranges_file"

    start=$((end - overlap))
    chunk_index=$((chunk_index + 1))

    # If the next chunk would be completely past the end, break
    if [ $start -ge $duration ]; then
      break
    fi
  done

  echo "$ranges_file"
}

# Extract audio chunk with progress display
extract_audio_chunk() {
  local start_seconds=$1
  local end_seconds=$2
  local output_file=$3
  local total_duration=$((end_seconds - start_seconds))

  local start_time=$(format_time $start_seconds)
  local duration=$(format_time $total_duration)

  echo "Extracting chunk from $start_time for duration $duration to $output_file"

  # Run ffmpeg with progress monitoring
  ffmpeg -i "$INPUT_FILE" -ss "$start_time" -t "$duration" -vn \
    -acodec libmp3lame -q:a 2 -y \
    -progress /dev/stdout "$output_file" 2>&1 | \
  while IFS= read -r line; do
    if [[ $line =~ ^out_time_ms=([0-9]+) ]]; then
      # Convert microseconds to seconds
      current_ms=${BASH_REMATCH[1]}
      current_seconds=$((current_ms / 1000000))
      progress=$((current_seconds * 100 / total_duration))

      # Only update if progress changed significantly
      if (( progress % 5 == 0 )); then
        printf "\r[%s] Progress: %d%%" "$output_file" "$progress"
      fi
    fi
  done

  # Print 100% when done
  printf "\r[%s] Progress: 100%%\n" "$output_file"
  echo "Successfully created $output_file"

  return 0
}

# Process chunks with limited concurrency
process_chunks() {
  local ranges_file=$1
  local total_chunks=$(wc -l < "$ranges_file")
  local completed_chunks=0

  echo "Processing $total_chunks chunks with max $MAX_CONCURRENT concurrent processes"

  # Process chunks in batches
  while IFS= read -r range; do
    # Split the range line into components
    read -r start end output_file <<< "$range"

    # Launch the ffmpeg process in background
    extract_audio_chunk "$start" "$end" "$output_file" &

    # Store the PID
    pids[${#pids[@]}]=$!

    # If we've reached max concurrent processes, wait for one to finish
    if [ ${#pids[@]} -ge $MAX_CONCURRENT ]; then
      wait "${pids[0]}"
      completed_chunks=$((completed_chunks + 1))
      echo "Progress: $completed_chunks/$total_chunks chunks complete"

      # Remove the first PID from the array
      pids=("${pids[@]:1}")

      # Small delay to allow system resources to stabilize
      sleep 1
    fi
  done < "$ranges_file"

  # Wait for remaining processes
  for pid in "${pids[@]}"; do
    wait "$pid"
    completed_chunks=$((completed_chunks + 1))
    echo "Progress: $completed_chunks/$total_chunks chunks complete"
  done

  # Clean up the temporary file
  rm -f "$ranges_file"
}

# Main execution
main() {
  # Get video duration
  duration=$(get_duration)
  echo "Video duration: $(format_time $duration)"

  # Generate time ranges
  ranges_file=$(generate_time_ranges "$duration")
  local total_chunks=$(wc -l < "$ranges_file")
  echo "Generated $total_chunks chunks"

  # Process chunks with concurrency control
  process_chunks "$ranges_file"

  echo "Audio extraction complete! All files saved to: $OUTPUT_DIR"
}

# Run the main function
main