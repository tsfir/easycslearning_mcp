# EasyCS Learning — MCP Server

Gives Claude read access to your EasyCS Learning Firebase data so you can ask questions like:

> *"Get 'Yod 4' class grades in lesson 'Variables' in course 'C# for Beginners' and send a WhatsApp message to all students who failed."*

---

## Available Tools (21 total)

| Group | Tool | What it does |
|-------|------|-------------|
| Discovery | `list_courses` | All active courses |
| Discovery | `list_topics` | Topics in a course |
| Discovery | `list_lessons` | Lessons in a course / topic |
| Discovery | `list_classes` | Classes for a course |
| Roster | `get_class_roster` | Students in a class with streak & points |
| Roster | `get_student_info` | Full profile for one student |
| Grades | `get_lesson_grades` | All grades for a lesson |
| Grades | `get_failing_students` | Students below a score threshold |
| Grades | `get_student_grades` | All lesson grades for one student |
| Grades | `get_grade_matrix` | Full student × lesson grid |
| Progress | `get_course_progress` | Completion % per student |
| Progress | `get_at_risk_students` | Medium / high risk students |
| Progress | `get_student_summary` | Complete snapshot for one student |
| Activity | `get_inactive_students` | Not active in N days |
| Activity | `get_daily_activity` | Daily active students & answers chart |
| Activity | `get_lesson_attendance` | Who submitted vs who didn't |
| Integrity | `get_integrity_flags` | Plagiarism / suspicion flags |
| Content | `create_lesson` | Create a new lesson inside a topic |
| Content | `get_lesson_content` | Read all sections of a lesson in order |
| Content | `add_lesson_section` | Append a new section to an existing lesson |
| Grading | `grade_student_answer` | Grade a transcribed handwritten answer with AI and save to Firestore |

---

## One-Time Setup

### Step 1 — Create an OAuth2 Client ID

1. Go to [Google Cloud Console](https://console.cloud.google.com) → select project **easycslearning-web-app**
2. Navigate to **APIs & Services → Credentials**
3. Click **Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Desktop app**
5. Name: `EasyCS MCP` (or anything)
6. Click **Create** → **Download JSON**
7. Create the directory and save the file:

```
mkdir %USERPROFILE%\.easycs-mcp
```

Save the downloaded JSON as:
```
C:\Users\<your-username>\.easycs-mcp\client_secret.json
```

### Step 2 — Enable the Firestore API (if not already enabled)

Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library) and enable:
- **Cloud Firestore API**

### Step 3 — Build the server

```bash
cd easycslearning_mcp
npm install
npm run build
```

### Step 4 — First login

Run the server once manually to complete the browser login:

```bash
node dist/index.js
```

Your browser will open → sign in with the Google account that owns the Firebase project → the token is saved to `~/.easycs-mcp/credentials.json`.

After this, every subsequent start is silent (no browser needed).

---

### Step 5 — Add your Gemini API key (required for `grade_student_answer`)

The grading tool calls the Gemini API directly from the MCP server. Add your key to the MCP server config under `"env"` (see Claude Desktop / Claude Code configuration sections below).

---

## Claude Desktop Configuration

Add this to your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "easycslearning": {
      "command": "node",
      "args": [
        "C:\\Users\\ronto\\source\\repos\\teaching\\easycslearning_mcp\\dist\\index.js"
      ],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see "easycslearning" in the tools list.

---

## Claude Code Configuration

Add to your `.claude/settings.local.json` (already exists at the repo root):

```json
{
  "mcpServers": {
    "easycslearning": {
      "command": "node",
      "args": [
        "C:\\Users\\ronto\\source\\repos\\teaching\\easycslearning_mcp\\dist\\index.js"
      ],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key-here"
      }
    }
  }
}
```

---

## Example Prompts

```
List all my active courses.

Show me the Yod 4 class roster for "C# for Beginners".

Get grades for lesson "Variables" in "C# for Beginners" for class "Yod 4", then list students who scored below 60%.

Who are the at-risk students in "Python Fundamentals"?

Show me students who haven't been active in the last 10 days in "C# for Beginners".

Get integrity flags with high severity for "C# for Beginners".

Give me a full summary for student "David Cohen" in "C# for Beginners".

Create a new exercise lesson called "Linked Lists Practice" in the "Data Structures" topic of "C# for Beginners", then add a coding section to it.

Show me all sections of lesson "Variables" in "C# for Beginners".

[attach scanned exam image]
This is Ron Cohen's handwritten exam for the "Recursion" section of lesson "Functions" in "C# for Beginners". Transcribe his answer and grade it.
```

### Handwritten exam grading workflow

1. Attach the scanned exam image to the Claude chat
2. Ask Claude to transcribe a specific student's answer
3. Claude calls `grade_student_answer` with the transcribed text
4. The grade and Hebrew feedback are returned immediately
5. The result is saved to Firestore automatically (set `saveGrade: false` to preview first)

---

## Security Notes

- The `client_secret.json` and `credentials.json` files live in `~/.easycs-mcp/` on your local machine only — they are never committed to git.
- The OAuth2 token has **Firestore read/write access**. Read tools are safe by design; write tools (`create_lesson`, `add_lesson_section`) create new documents but never modify or delete existing ones.
- This server is designed for **local use only** (stdio transport). It is not a public HTTP server.
