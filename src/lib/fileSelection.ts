export interface FileSelectionResult {
  paths: string[];
  anchor: string | null;
}

export function nextFileSelection(
  allPaths: string[],
  currentPaths: string[],
  entryPath: string,
  anchorPath: string | null,
  modifiers: { additive: boolean; range: boolean },
): FileSelectionResult {
  if (modifiers.range && anchorPath) {
    const anchorIndex = allPaths.indexOf(anchorPath);
    const entryIndex = allPaths.indexOf(entryPath);
    if (anchorIndex >= 0 && entryIndex >= 0) {
      const [start, end] = anchorIndex <= entryIndex ? [anchorIndex, entryIndex] : [entryIndex, anchorIndex];
      const rangePaths = allPaths.slice(start, end + 1);
      return {
        paths: modifiers.additive ? [...new Set([...currentPaths, ...rangePaths])] : rangePaths,
        anchor: anchorPath,
      };
    }
  }
  if (modifiers.additive) {
    return {
      paths: currentPaths.includes(entryPath)
        ? currentPaths.filter((path) => path !== entryPath)
        : [...currentPaths, entryPath],
      anchor: entryPath,
    };
  }
  return { paths: [entryPath], anchor: entryPath };
}
