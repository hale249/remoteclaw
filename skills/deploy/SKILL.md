---
name: deploy
description: Build project and expose via tunnel for live preview
trigger: /deploy
skip_commit: true
---

# Deploy

Build the project and start a dev server so the user can preview it via a public URL.

## Steps

1. Run the project's build command (if configured)
2. Start the dev server
3. The system will automatically create a tunnel and return the URL

## Notes

- This skill does NOT modify code — it only builds and runs
- The preview URL will be sent back to the user automatically
- If a preview is already running, it will be restarted
