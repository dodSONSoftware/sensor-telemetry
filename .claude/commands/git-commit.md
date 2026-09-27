# /git-commit: Analyze and Commit Workflow

Analyze all changes in the repository, update CLAUDE.md and README.md to reflect current project state, create a formatted commit message, stage everything, and commit. All commands execute from the project root.

## Steps

### 0. PRE-FLIGHT CHECKS

Run these before making any changes:
- `git status --porcelain=v1` — check for uncommitted changes
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && test -f "$PROJECT_ROOT/package.json"` — verify package.json exists at project root
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && node -p "try { JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/package.json')); true } catch(e) { false }"` — validate package.json syntax

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

### 3. DETERMINE VERSION BUMP AND UPDATE PACKAGE.JSON

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
PACKAGE_JSON=$(git rev-parse --show-toplevel)/package.json
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
- `PROJECT_ROOT=$(git rev-parse --show-toplevel) && node -p "require('$PROJECT_ROOT/package.json').version"` — verify version in committed commit

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

## RELEASE CODENAME SCHEME

The release codename stored in `FIRMWARE_NAME` in `version.py` is derived from `FIRMWARE_VERSION` (`MAJOR.MINOR.PATCH`). The mapping is deterministic:

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
