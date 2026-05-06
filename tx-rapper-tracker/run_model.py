#!/usr/bin/env python3
# Sends app.html to qwen2.5-coder:1.5b for improvements, saves result, updates Obsidian
import json, urllib.request, os, sys

app_path   = os.path.expanduser('~/clawd/projects/tx-rapper-tracker/app.html')
vault_path = os.path.expanduser('~/Documents/Obsidian Vault/tx-rapper-tracker.md')

with open(app_path) as f:
    current_code = f.read()
original_lines = current_code.count('\n')
print(f"Loaded app.html ({original_lines} lines)")

task_prompt = (
    "You are an expert frontend developer. Improve the following HTML/JS single-page app.\n\n"
    "Make EXACTLY these 4 changes:\n"
    "1. Add a yellow demo-mode banner just inside the .container div when no YouTube API key is saved. "
    "Id the banner 'demoBanner'. Text: 'Demo Mode: Showing sample data. Add a YouTube API key below for live data.' "
    "Show it when localStorage.getItem('ytApiKey') is empty, hide it otherwise.\n"
    "2. Add a 'Regional Interest' section below the chart row with 3 horizontal bar entries: "
    "Americas 78%, Africa & Caribbean 65%, Europe 52%. Use the --accent color for filled bars.\n"
    "3. Add a 'Coming Next' section at the very bottom (before closing .container) with 2 feature cards: "
    "'Phase 2 - Hit Prediction' (lock icon, dim style) and 'Phase 3 - Artist DNA Fingerprint' (lock icon, dim style).\n"
    "4. At the very top of the <script> block insert this exact comment: // (c) 2026 Paul. All rights reserved.\n\n"
    "Return ONLY the complete updated HTML file with all original code preserved. "
    "No explanation text. No markdown fences. Begin with <!DOCTYPE html>.\n\n"
    "CURRENT FILE:\n"
    + current_code
)

payload = json.dumps({
    "model": "qwen2.5-coder:1.5b",
    "prompt": task_prompt,
    "stream": False,
    "options": {"temperature": 0.15, "num_predict": 14000}
}).encode()

print("Sending to qwen2.5-coder:1.5b via Ollama...")
print("(Running on CPU ~15 tok/s — takes 2-4 minutes)")
sys.stdout.flush()

req = urllib.request.Request(
    "http://127.0.0.1:11434/api/generate",
    data=payload,
    headers={"Content-Type": "application/json"}
)

try:
    with urllib.request.urlopen(req, timeout=600) as resp:
        result    = json.loads(resp.read().decode())
        response  = result.get("response", "").strip()
        print(f"Response received: {len(response)} chars")

        # Strip markdown fences if model wrapped output
        if response.startswith("```"):
            response = "\n".join(response.split("\n")[1:])
        if "```" in response:
            response = response.rsplit("```", 1)[0].strip()

        if "<!DOCTYPE" in response or "<html" in response:
            # Back up original before overwriting
            with open(app_path + ".bak", "w") as f:
                f.write(current_code)
            with open(app_path, "w") as f:
                f.write(response)
            new_lines = response.count('\n')
            print(f"SAVED app.html — {new_lines} lines (was {original_lines})")

            # Update Obsidian build log
            from datetime import datetime
            entry = (f"| {datetime.now().strftime('%Y-%m-%d %H:%M')} "
                     f"| qwen2.5-coder:1.5b "
                     f"| Added demo banner, regional bars, coming-soon roadmap "
                     f"| {new_lines} lines | OK |\n")
            try:
                with open(vault_path) as f:
                    obs = f.read()
                if "## Build Log" in obs:
                    obs = obs.replace("## Build Log\n", "## Build Log\n" + entry)
                else:
                    obs += "\n## Build Log\n" + entry
                with open(vault_path, "w") as f:
                    f.write(obs)
                print("Obsidian build log updated")
            except Exception as e:
                print(f"Obsidian update failed: {e}")
        else:
            print("ERROR: No valid HTML in response — original file kept")
            print("Response preview:", response[:300])
            sys.exit(1)

except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)

print("All done.")
