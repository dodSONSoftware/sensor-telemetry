# /git-commit: Analyze and Commit Workflow

Analyze all changes in the repository, update CLAUDE.md and README.md to reflect current project state, create a formatted commit message, stage everything, and commit. All commands execute from the project root.

## Steps

### 0. PRE-FLIGHT CHECKS

Run these before making any changes:
- `git status --porcelain=v1` — check for uncommitted changes
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && test -f "$PROJECT_ROOT/code/package.json"` — verify package.json exists at expected path
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && node -p "try { JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/code/package.json')); true } catch(e) { false }"` — validate package.json syntax

If checks fail, abort with clear error message.

### 1. UPDATE CLAUDE.md AND README.md IF NEEDED

Check if documentation needs updating based on changes:

**For CLAUDE.md:**
- **New files/directories** — add entries to directory tree
- **Modified commands/skills** — update references or descriptions
- **Removed files** — remove stale entries
- **Architecture/config changes** — update architecture notes or commands

**For README.md:**
- **New features** — add feature highlights or usage examples
- **API changes** — update endpoint tables or request/response examples
- **Configuration changes** — update config examples or environment variables
- **Dependency updates** — note major version changes
- **Breaking changes** — add migration notes or deprecation warnings

Skip if no structural or documentation-relevant changes. Do NOT stage documentation files yet.

### 2. ANALYZE GIT CHANGES

Run these commands to understand what changed:
- `git status --short` — list all modified/added/deleted files
- `git diff --stat HEAD` — show file-level change summary
- `git log --oneline -5` — recent commit history for context
- `git diff --name-status HEAD` — detect renames and deletions

Classify every changed file:
- **Added** (`??` or `A`)
- **Modified** (`M`)
- **Deleted** (`D`)
- **Renamed** (`R`)

### 3. DETERMINE VERSION BUMP FROM CONVENTIONAL COMMITS

Parse recent commits to determine appropriate version bump:

```bash
git log --pretty=format:"%h %s" -10 | grep -E "^(feat|fix)" | head -5
```

Apply semantic versioning rules:
- **major**: `BREAKING CHANGE:` in commit body OR `!` after type/scope (e.g., `feat!:`, `fix(api)!:`)
- **minor**: `feat:` commits (new features)
- **patch**: `fix:` commits (bug fixes), `chore:`, `docs:`, `refactor:`, `test:`, or no conventional commit type

Use `semver` library if available, otherwise manual bump:
- Patch: increment third number, reset lower numbers
- Minor: increment second number, reset third to 0
- Major: increment first number, reset others to 0

Update `package.json` with new version and verify.

### 4. GENERATE COMMIT MESSAGE

Format the commit message:

```
[X.Y.Z] <type>: <overview>

- <change 1>
- <change 2>
```

Rules:
- Version in square brackets on first line (e.g., `[4.5.0]`)
- Conventional commit type (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`, `ci:`, `build:`, `style:`)
- Overview is brief summary
- One-line descriptions per file/group of changes
- If breaking change, add `BREAKING CHANGE:` footer with migration notes

### 5. STAGE ALL CHANGES

```bash
git add .
```

### 6. CREATE COMMIT

```bash
git commit -m "$(cat <<'EOF'
[X.Y.Z] <type>: <overview>

- <change 1>
- <change 2>
EOF
)"
```

### 7. POST-COMMIT VERIFICATION

Run:
- `git status` — confirm working tree is clean
- `git log --oneline -3` — confirm commit landed correctly
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && node -p "require('$PROJECT_ROOT/code/package.json').version"` — verify version in committed commit

## Error Handling

- **Uncommitted changes detected**: Abort with message listing conflicting files
- **Malformed package.json**: Show parsing error and exit
- **Git command failure**: Show error output and exit code
- **Commit failure**: Rollback version bump (restore original package.json)

## Output

After successful commit, return:

1. **Full commit message** used
2. **Files changed** with descriptions:
   ```
   - <file_path>: <description>
   ```
3. **Documentation updates**: CLAUDE.md and/or README.md (if applicable)
4. **Version bump**: old → new
5. **Summary** of notable changes

## EXAMPLE OUTPUT

```
[4.5.0] feat: add user authentication

- src/middleware/auth.ts: implement JWT-based auth middleware
- src/controllers/userController.ts: add login/register endpoints
- tests/__tests__/auth.test.ts: add auth middleware tests
- package.json: bump version 4.4.1 → 4.5.0
- README.md: add authentication section with usage examples

Notable changes: Users can now authenticate via JWT tokens. Breaking: /api/* routes require Authorization header.
```

## IMPROVEMENTS OVER ORIGINAL

| Original Issue | Fix Applied |
|----------------|-------------|
| Version bump ignored `feat:` | Parse conventional commits to determine bump level |
| No prerelease support | Use `semver` library for proper version manipulation |
| No rename detection | Add `--diff-filter=R` handling |
| No error recovery | Try/catch with rollback on failure |
| Monolithic design | Clear phase separation with pre-flight checks |
| No breaking change detection | Detect `!` and `BREAKING CHANGE:` footer |
| Manual version math | Use semver library or validated logic |
