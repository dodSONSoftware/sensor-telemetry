# /git-commit: Analyze and Commit Workflow

Analyze all changes in the repository, update CLAUDE.md to reflect current project state, create a formatted commit message, stage everything, and commit. All commands execute from the project root.

## Steps

### 0. UPDATE CLAUDE.md FIRST

Before doing anything else, check if `CLAUDE.md` needs updating based on the changes being committed:

- **New files/directories** — add entries to the directory tree in the appropriate section
- **Modified commands/skills** — update any references or descriptions that changed
- **Removed files** — remove stale entries from CLAUDE.md
- **Architecture/config changes** — update architecture notes, common commands, or development notes as needed

If CLAUDE.md is already up to date (no structural changes in this commit), skip this step. Do NOT stage the CLAUDE.md change yet — it will be staged together with everything else at Step 4.

### 1. ANALYZE GIT CHANGES

Run these commands to understand what changed:
- `git status --short` — list all modified/added/deleted files
- `git diff --stat HEAD` — show file-level change summary
- `git log --oneline -5` — recent commit history for context

Classify every changed file into one of these categories:
- **Added** (`??` or `A`)
- **Modified** (`M`)
- **Deleted** (`D`)

### 2. ALWAYS UPDATE PACKAGE.JSON VERSION BEFORE COMMITTING

**REQUIRED STEP:** You MUST update `package.json` with a new version before every commit. Never commit without updating the version.

First, check the current version:
```bash
node -p "require('./package.json').version"
```

Determine the appropriate version bump based on the changes:
- **major** — any breaking change (look for `BREAKING CHANGE` in diffs, or `!` after type/scope like `feat!:`, or API-breaking structural changes)
- **minor** — new features (`feat:`), significant additions (new pages, components, infrastructure)
- **patch** — bug fixes (`fix:`), docs, chores, refactors, test updates

Update `package.json` with the new version:
```bash
node -e "
import { readFileSync, writeFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const parts = pkg.version.split('.').map(Number);
// Determine which part to bump based on commit type
parts[2]++; // Default to patch bump
if (type === 'minor') {
  parts[1]++;
  parts[2] = 0;
} else if (type === 'major') {
  parts[0]++;
  parts[1] = 0;
  parts[2] = 0;
}
pkg.version = parts.join('.');
writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated to', pkg.version);
"
```

Verify the version was updated:
```bash
node -p "require('./package.json').version"
```

### 3. CREATE COMMIT MESSAGE

Format the commit message exactly like this:

```
[X.Y.Z] <conventional_commit_type>: <overview_message>

- <one-line description of change>
- <one-line description of change>
```

Rules:
- **Always include the version in square brackets on the very first line** (e.g., `[0.5.0]`)
- Follow the version with a conventional commit type (`feat:`, `fix:`, `chore:`, `refactor:`, etc.)
- The overview message should be a brief summary (e.g., `remove theme from General tab`)
- One-line descriptions should be concise and specific
- Group related changes under a single bullet when appropriate

### 4. STAGE AND COMMIT

```bash
git add .
git commit -m "<commit_message>"
```

Use the formatted message from Step 3 as the `-m` value (escape newlines or use a heredoc).

### 5. VERIFY

Run:
- `git status` — confirm working tree is clean
- `git log --oneline -3` — confirm commit landed correctly

## Output

1. **The full commit message** that was used
2. **List of all files changed**, with one-sentence descriptions:

```
- <file_path>: <one sentence description>
```

3. **Brief summary** of notable changes (what matters to a reviewer)

## EXAMPLE OUTPUT

[0.5.0] fix: remove theme from General tab

- src/app/services/settings.service.ts: skip theme in getSettingsSections()
- src/app/pages/settings/settings.component.html: remove theme control rendering
- src/app/services/settings.service.spec.ts: update tests to reflect theme exclusion

Notable changes: Theme setting removed from settings page tabs; users must use header toggle for dark/light mode.
