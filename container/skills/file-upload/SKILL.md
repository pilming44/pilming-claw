---
name: file-upload
description: Send files (screenshots, reports, images, documents) to the user via chat. Uses the send_file MCP tool to upload files through the channel's native file API.
---

# File Upload

Send files from the container to the user's chat channel.

## Usage

Use the `send_file` MCP tool (`mcp__nanoclaw__send_file`):

```
file_path: /workspace/group/screenshots/page.png
filename: screenshot.png        # optional display name
comment: Here's the screenshot   # optional message
```

## Allowed paths

Files must be under one of these directories:

- `/workspace/group/` — the group's persistent storage
- `/workspace/ipc/` — the IPC directory

Other paths are rejected for security.

## Examples

### Screenshot with agent-browser

```bash
agent-browser screenshot --url "https://example.com" --output /workspace/group/screenshots/example.png
```

Then use `send_file`:
```
file_path: /workspace/group/screenshots/example.png
comment: Screenshot of example.com
```

### Generated report

```bash
# Generate a CSV report
echo "name,value" > /workspace/group/report.csv
echo "users,42" >> /workspace/group/report.csv
```

Then send it:
```
file_path: /workspace/group/report.csv
filename: daily-report.csv
comment: Daily metrics report
```

## Limits

- Maximum file size: 50 MB (Slack API limit)
- Channel must support file uploads (Slack does; others may not yet)
- If the channel doesn't support uploads, the file send is silently skipped
