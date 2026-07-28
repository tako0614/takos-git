/** fnmatch-style branch glob: `*` and `?` stay within a path segment; `**` crosses `/`. */
export function matchBranchPattern(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`, "u").test(branch);
  } catch {
    return false;
  }
}
