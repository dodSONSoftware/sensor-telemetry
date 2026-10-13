# /git-commit: Analyze and Commit Workflow

Analyze all changes in the repository, update CLAUDE.md, README.md, and CHANGELOG.md to reflect current project state, create a formatted commit message, stage everything, and commit. All commands execute from the project root; all application code and build files live in `code/`.

## Steps

### 0. PRE-FLIGHT CHECKS

Run these before making any changes:
- `git status --porcelain=v1` — record the change set (baseline for step 1; this command's purpose is to commit these changes, so a dirty tree is expected)
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && test -f "$PROJECT_ROOT/code/package.json"` — verify package.json exists at `code/`
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && node -p "try { JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/code/package.json')); true } catch(e) { false }"` — validate package.json syntax
- `test -f code/src/version.ts && grep -E "^export const APP_(VERSION|NAME) = " code/src/version.ts` — get the current app version and release codename for reference. `code/src/version.ts` is the app version's source of truth (reported by `/about`); `code/package.json` must stay in sync with it. If `version.ts` is missing or either constant is missing, abort with a clear error.
- `test -f CHANGELOG.md` — verify the changelog exists. If it is missing, abort with a clear error rather than inventing a format.

If checks fail, abort with clear error message.

### 1. ANALYZE GIT CHANGES

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

### 2. DETERMINE VERSION BUMP AND UPDATE PACKAGE.JSON

Parse recent commits to determine appropriate version bump:

```bash
git log --pretty=format:"%h %s" -10 | grep -E "^(feat|fix)" | head -5
```

Apply semantic versioning rules:
- **major**: `BREAKING CHANGE:` in commit body OR `!` after type/scope (e.g., `feat!:`, `fix(api)!:`)
- **minor**: `feat:` commits (new features)
- **patch**: `fix:` commits (bug fixes), `chore:`, `docs:`, `refactor:`, `test:`, or no conventional commit type

Read current version and compute new version:
```bash
PACKAGE_JSON=$(git rev-parse --show-toplevel)/code/package.json
CURRENT_VERSION=$(node -p "require('$PACKAGE_JSON').version")
# Compute NEW_VERSION based on version bump rules
```

**Update package.json** with the new version:
```bash
node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON')); pkg.version = '$NEW_VERSION'; fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');"
```

Verify the update:
```bash
node -p "require('$PACKAGE_JSON').version"
```

**Update `APP_VERSION` in `code/src/version.ts`:**

`code/src/version.ts` is the app version's source of truth (`code/src/common/global.ts` imports `APP_VERSION` into `serviceMetadata`, which `/about` and the `/endpoints` documentation report), so it must equal the new `code/package.json` version. Apply the same replace-and-verify discipline as the version bump (exactly one assignment):
```js
const fs = require("fs");
const VERSION_TS = "code/src/version.ts";
let content = fs.readFileSync(VERSION_TS, "utf8");

const matches = content.match(/^export const APP_VERSION = "[^"]*"\s*$/gm);
if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one APP_VERSION assignment, found ${matches ? matches.length : 0}`);
}

content = content.replace(
    /^export const APP_VERSION = "[^"]*"\s*$/m,
    `export const APP_VERSION = "${NEW_VERSION}"`
);

if (!content.includes(`export const APP_VERSION = "${NEW_VERSION}"`)) {
    throw new Error("APP_VERSION verification failed");
}

fs.writeFileSync(VERSION_TS, content);
```

**Update `APP_NAME` (the release codename) in `code/src/version.ts`:**

`APP_NAME` is the release codename. It is a deterministic function of the final version (see the RELEASE CODENAME SCHEME at the end of this file): look up `MAJOR` in the Animal table and `MINOR` in the Material table, and name it `<Material> <Animal>`. `PATCH` does not affect the codename — a patch bump on the same major.minor leaves `APP_NAME` unchanged. Unlike a drifted version, which is ambiguous and stops the workflow, the codename can always be recomputed, so an authored version bump whose `APP_NAME` was left stale is corrected here, not reported. If the existing `APP_NAME` already equals the derived name, no edit is needed. Apply the same replace-and-verify discipline:
```js
const fs = require("fs");
const VERSION_TS = "code/src/version.ts";
let content = fs.readFileSync(VERSION_TS, "utf8");

const matches = content.match(/^export const APP_NAME = "[^"]*"\s*$/gm);
if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one APP_NAME assignment, found ${matches ? matches.length : 0}`);
}

content = content.replace(
    /^export const APP_NAME = "[^"]*"\s*$/m,
    `export const APP_NAME = "${codename}"`
);

if (!content.includes(`export const APP_NAME = "${codename}"`)) {
    throw new Error("Codename verification failed");
}

fs.writeFileSync(VERSION_TS, content);
```

### 3. UPDATE README.md, CLAUDE.md, AND CHANGELOG.md

Sync the project documentation to the new state before committing — the version bump from step 2 must be reflected here so the docs never drift from the committed version. These edits are mandatory, not optional.

**CHANGELOG.md — always:**
- Insert a new `## [X.Y.Z] — <Material Animal> (YYYY-MM-DD)` entry immediately after the file's header lines and before the existing top entry (versions are newest first). Use the em dash (`—`) between version and codename.
- The codename is derived from the new version with the release codename scheme at the end of this file — the same name used in the commit subject. A patch bump on the same major.minor gets its own entry; the codename stays unchanged (e.g., `## [1.11.39] — Cobalt Fox (2026-10-11)`).
- The date is the day the commit is made.
- Add one bullet per user-visible change, from the step 1 analysis. Write them feature-oriented (what changed and why it matters, in the style of the existing entries), unlike the step 4 commit body, which lists per-file changes — both are derived from the same analysis and must not contradict each other. The version/codename bump and the package.json/README/CLAUDE/CHANGELOG bookkeeping edits themselves are not user-visible changes and get no bullets.

**README.md — always:**
- **Release line** — update it to the new version and codename: `**Release:** <Material Animal> — firmware <X.Y.Z>.` Derive the codename from the new version using the release codename scheme at the end of this file; the release line is the codename's home in the README. If the README has no release line, add one near the top.

**README.md — when the change is documentation-relevant:**
- **New features** — add feature highlights or usage examples
- **API changes** — update endpoint tables or request/response examples
- **Configuration changes** — update config examples or environment variables
- **Dependency updates** — note major version changes
- **Breaking changes** — add migration notes or deprecation warnings

**CLAUDE.md — always:**
- **Version** — if CLAUDE.md records the project version, update it to the new version.

**CLAUDE.md — when the change is documentation-relevant:**
- **New files/directories** — add entries to directory tree
- **Modified commands/skills** — update references or descriptions
- **Removed files** — remove stale entries
- **Architecture/config changes** — update architecture notes or commands

The documentation edits are part of the commit: list the README/CLAUDE edits in the commit-message bullets (the CHANGELOG.md entry is implicit in the subject's version/codename and needs no bullet of its own) and let `git add .` (step 5) stage them alongside the code changes.

### 4. GENERATE COMMIT MESSAGE

Format the commit message:

```
[X.Y.Z, <Material Animal>] <type>: <overview>

- <change 1>
- <change 2>
```

Rules:
- Version and release codename in square brackets on first line, comma-separated (e.g., `[4.5.0, Brass Falcon]`); derive the codename from the new version using the release codename scheme at the end of this file
- Conventional commit type (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`, `ci:`, `build:`, `style:`)
- Overview is brief summary
- One-line descriptions per file/group of changes
- If breaking change, add `BREAKING CHANGE:` footer with migration notes
- Always add `Authored-By: dodson Software and AI` at the end of the commit message
- Do NOT include a `Co-Authored-By: Claude Code <noreply@anthropic.com>` line (or any other `Co-Authored-By` tagline)

### 5. STAGE ALL CHANGES

```bash
git add .
```

### 6. CREATE COMMIT

```bash
git commit -m "$(cat <<'EOF'
[X.Y.Z, <Material Animal>] <type>: <overview>

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
- `grep -E "^export const APP_(VERSION|NAME) = " code/src/version.ts` — verify `APP_VERSION` equals the committed version and the codename matches the committed version's major.minor

## Error Handling

- **version.ts missing or malformed** (either constant absent, or not exactly one assignment): Show the parse error and exit before making any changes
- **version.ts and package.json disagree on the current version**: Abort with a message showing both values; the drift is ambiguous and must be resolved by hand first
- **Malformed package.json**: Show parsing error and exit
- **Git command failure**: Show error output and exit code
- **Commit failure**: Rollback the version bump and documentation edits (restore original code/package.json, code/src/version.ts, README.md, CLAUDE.md, and CHANGELOG.md)

## Output

After successful commit, return:

1. **Full commit message** used
2. **Files changed** with descriptions:
   ```
   - <file_path>: <description>
   ```
3. **Documentation updates**: what was synced in README.md (release line at minimum), CLAUDE.md, and the CHANGELOG.md entry that was added (version, codename, date)
4. **Version bump**: old → new
5. **Summary** of notable changes

## EXAMPLE OUTPUT

```
[4.5.0, Brass Falcon] feat: add user authentication

- code/src/middleware/auth.ts: implement JWT-based auth middleware
- code/src/controllers/userController.ts: add login/register endpoints
- code/tests/__tests__/auth.test.ts: add auth middleware tests
- code/package.json: bump version 4.4.1 → 4.5.0
- README.md: add authentication section with usage examples

Notable changes: Users can now authenticate via JWT tokens. Breaking: /api/* routes require Authorization header.

Authored-By: dodson Software and AI
```

## RELEASE CODENAME SCHEME

The release codename is derived from the version (`MAJOR.MINOR.PATCH`). It appears in the commit subject (inside the square brackets on the first line) and in the README release line. The mapping is deterministic:

- **MAJOR** selects the **Animal**
- **MINOR** selects the **Material**
- **PATCH** does not affect the codename
- Display the codename as:

```text
<Material> <Animal>
```

### Version Mapping

```text
MAJOR.MINOR.PATCH
  │     │
  │     └── Material
  └──────── Animal
```

Example:

```text
2.3.14
│ │
│ └── 3 → Tin
└──── 2 → Hawk

Tin Hawk
```

### Major Version → Animal

| Major | Animal |
|---:|---|
| `0` | Owl |
| `1` | Fox |
| `2` | Hawk |
| `3` | Badger |
| `4` | Falcon |
| `5` | Wolf |
| `6` | Eagle |
| `7` | Jaguar |
| `8` | Wolverine |
| `9` | Tiger |
| `10` | Grizzly |

The animal identifies the major-version generation and remains unchanged for all minor and patch releases within that generation.

### Minor Version → Material

| Minor | Material |
|---:|---|
| `0` | Iron |
| `1` | Zinc |
| `2` | Aluminum |
| `3` | Tin |
| `4` | Bronze |
| `5` | Brass |
| `6` | Copper |
| `7` | Nickel |
| `8` | Steel |
| `9` | Mercury |
| `10` | Titanium |
| `11` | Cobalt |
| `12` | Carbon |
| `13` | Graphite |
| `14` | Silicon |
| `15` | Ceramic |
| `16` | Quartz |
| `17` | Onyx |
| `18` | Obsidian |
| `19` | Garnet |
| `20` | Amethyst |
| `21` | Topaz |
| `22` | Granite |
| `23` | Opal |
| `24` | Jade |
| `25` | Turquoise |
| `26` | Pearl |
| `27` | Emerald |
| `28` | Sapphire |
| `29` | Ruby |
| `30` | Silver |
| `31` | Gold |
| `32` | Platinum |
| `33` | Amber |
| `34` | Marble |
| `35` | Diamond |

### Rules

1. Parse the version as `MAJOR.MINOR.PATCH`.
2. Look up `MAJOR` in the Animal table.
3. Look up `MINOR` in the Material table.
4. Ignore `PATCH` when generating the codename.
5. Return the name in exactly this order:

   ```text
   Material Animal
   ```

6. Do not invent or substitute names.
7. Do not reorder the words.
8. Do not alter capitalization.
9. If `MAJOR` or `MINOR` is outside the defined tables, do not extrapolate.
10. Use `Unknown` for any out-of-range component.

Examples of out-of-range components:

```text
11.3.0  → Tin Unknown
2.36.0  → Unknown Hawk
11.36.0 → Unknown Unknown
```

### Examples

```text
0.0.0    → Iron Owl
0.10.7   → Titanium Owl
1.6.3    → Copper Fox
2.3.14   → Tin Hawk
3.16.2   → Quartz Badger
4.11.0   → Cobalt Falcon
5.18.9   → Obsidian Wolf
6.28.1   → Sapphire Eagle
7.29.4   → Ruby Jaguar
8.30.0   → Silver Wolverine
9.31.12  → Gold Tiger
10.35.0  → Diamond Grizzly
```

Patch releases retain the same name:

```text
2.3.0  → Tin Hawk
2.3.1  → Tin Hawk
2.3.99 → Tin Hawk
```
