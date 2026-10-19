// Portable restore names. A backup may come from a system whose file names
// another system cannot hold: "a:b.txt" or "Notes?.md" from macOS/Linux,
// "CON.txt" or "draft." on Windows, two files differing only in case from a
// Linux drive. Chromium's File System Access API rejects such names on every
// platform ("Name is not allowed."), and on case-insensitive volumes (APFS,
// NTFS) a second "README.txt" would silently overwrite "readme.txt".
//
// The engine therefore decides the target names itself before anything is
// written — not the UI — and reports every file it had to rename.

// The rules below mirror what Chromium's File System Access API accepts in a
// real (non-OPFS) folder — measured 2026-10-20 against a local folder handle
// in Chromium (headless shell 1217) — plus Windows' own limits. OPFS accepts
// everything, so only a real folder shows them.

// Never allowed anywhere: Windows' forbidden characters, control (Cc) and
// format (Cf) characters — U+200D in emoji sequences like 👨‍👩‍👧, soft hyphen,
// BOM, bidi marks — and Unicode non-characters. '/' never occurs inside a
// manifest path segment.
const FORBIDDEN = /[<>:"|?*\\\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}]/gu;
// Not allowed as first or last character: any white space (also U+00A0,
// U+3000), '.' and '~'. Windows drops trailing dots and spaces ("draft."
// would become "draft"); a single leading '.' (".git") is fine everywhere.
const BAD_END = /[\p{White_Space}.~]/u;
// Reserved device names, also with any extension ("NUL.txt", "CON.tar.gz") —
// Windows maps them to devices instead of files; Chromium refuses them (and
// desktop.ini / thumbs.db) on every system.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)(\..*)?$/i;
const SHELL_MAGIC = /^(desktop\.ini|thumbs\.db)$/i;
// Extensions Chromium refuses because Windows executes them (shortcuts,
// shell commands, CLSID handlers): ".lnk", ".url", ".scf", ".{…}".
const SHELL_EXT = /\.(lnk|url|scf|\{.*\})$/i;

/** One path segment, rewritten so Windows, macOS and Linux all accept it. */
export function portableSegment(name: string): string {
  const chars = Array.from(name.replace(FORBIDDEN, '_'));
  // a single leading '.' marks a hidden file and stays
  const first = chars[0] === '.' && chars.length > 1 ? 1 : 0;
  for (let i = first; i < chars.length && BAD_END.test(chars[i]); i++) chars[i] = '_';
  for (let i = chars.length - 1; i >= first && BAD_END.test(chars[i]); i--) chars[i] = '_';
  let out = chars.join('');
  if (SHELL_EXT.test(out)) out = `${out}_`;
  if (RESERVED.test(out) || SHELL_MAGIC.test(out)) out = `_${out}`;
  return out || '_';
}

/** Case- and Unicode-normalization-insensitive key (APFS, NTFS). */
const keyOf = (path: string) => path.normalize('NFC').toLowerCase();

function withSuffix(name: string, n: number, isFile: boolean): string {
  const dot = isFile ? name.lastIndexOf('.') : -1;
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export interface PlannedPath {
  /** Target path segments below the restore folder. */
  parts: string[];
  /** True when the target differs from the path stored in the backup. */
  renamed: boolean;
}

/**
 * Map manifest paths (already validated by safeRelativePath) to target paths
 * that are valid on every system and unique even on case-insensitive volumes.
 * Files inside one folder stay together; a name taken by a file and a folder
 * at the same time is numbered ("x (2)").
 */
export function planRestorePaths(paths: string[][]): PlannedPath[] {
  const dirMap = new Map<string, string>(); // original dir key → target dir path
  const usedDirs = new Map<string, string>(); // key of a target dir → its spelling
  const usedFiles = new Set<string>(); // keys of target files
  const taken = (key: string) => usedDirs.has(key) || usedFiles.has(key);

  const targetDir = (segments: string[]): string => {
    let parent = '';
    let original = '';
    for (const segment of segments) {
      original = original ? `${original}/${segment}` : segment;
      const known = dirMap.get(original);
      if (known !== undefined) {
        parent = known;
        continue;
      }
      const base = portableSegment(segment);
      let candidate = parent ? `${parent}/${base}` : base;
      // a folder may merge with an existing folder of the same (folded) name
      // — that is how the target file system would treat it — but never
      // with a file
      for (let n = 2; usedFiles.has(keyOf(candidate)); n++) {
        candidate = parent ? `${parent}/${withSuffix(base, n, false)}` : withSuffix(base, n, false);
      }
      // "docs" next to "Docs" is the same folder there: use one spelling
      candidate = usedDirs.get(keyOf(candidate)) ?? candidate;
      usedDirs.set(keyOf(candidate), candidate);
      dirMap.set(original, candidate);
      parent = candidate;
    }
    return parent;
  };

  return paths.map((parts) => {
    const dir = targetDir(parts.slice(0, -1));
    const base = portableSegment(parts[parts.length - 1]);
    let name = base;
    const full = (n: string) => (dir ? `${dir}/${n}` : n);
    for (let n = 2; taken(keyOf(full(name))); n++) name = withSuffix(base, n, true);
    usedFiles.add(keyOf(full(name)));
    const target = full(name);
    return { parts: target.split('/'), renamed: target !== parts.join('/') };
  });
}
